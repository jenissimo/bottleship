#!/usr/bin/env bun
/**
 * S_time — the share of guest execution TIME that an AOT unit could cover.
 *
 * WHY THIS TOOL EXISTS
 * The AOT track's whole go/no-go is one number, and the number we have is the wrong one.
 * `plan/aot-compiler-handoff.md:44` reports S = 0.389, measured as a share of RETIRED
 * INSTRUCTIONS, on a PAUSED scene. End-to-end projections then substituted it as a share of
 * frame TIME. Those are different quantities: instructions differ in cost by an order of
 * magnitude, and the expensive ones (memory operands, indirect jumps, x87) are not
 * distributed evenly across pages.
 *
 * The embedded EIP sampler cannot answer it either. It fires at worker yield points, so it
 * ranks WHERE THE GUEST PARKS, not where it spends time (CLAUDE.md, and the winmm callback
 * entry sitting at #1 with 14.8% is the proof). Chrome's CPU sampler fires on a timer, so
 * its wasm samples ARE time-proportional — and the `bottleship.hotblocks` mark carries the
 * `wasm-function[N] -> guest address` map needed to attribute them to guest pages.
 *
 * HOW ATTRIBUTION WORKS NOW
 * There is no join any more. The JIT emits a wasm `name` custom section naming its function
 * `g<entry addr, 8 hex>@t<table index>` (jit config idx 28, default on), so Chrome's own frame
 * carries the guest address and the sample resolves by PARSING, not by correlating. The
 * previous route — matching Chrome's `wasm-function[N]` against v86's table slot — is dead and
 * was never viable: they are different namespaces, the join resolved 0 of 6660 samples, and 28
 * slots were observed under more than one code offset because the JIT recycles them.
 *
 * GRANULARITY IS THE MODULE, NOT THE PAGE. A JIT module holds exactly one function body (a
 * br_table over its blocks) spanning up to MAX_PAGES guest pages, so a sample resolves to the
 * module's ENTRY address. That is the right unit here — an AOT unit is a module — but it means
 * "pages" below are module entry points, and a module covering several pages is counted once.
 *
 * WHAT IT REFUSES TO DO
 * It reports how many wasm samples carried a parseable name before reporting anything else,
 * and REFUSES to print an S_time when too few did. A coverage number produced from a 30%
 * resolution would be exactly the kind of plausible-but-mislabelled figure this whole
 * investigation keeps finding.
 *
 * STABILITY (--compare) answers the question S_time on its own cannot: is the hot set the same
 * set next time? A coverage figure from one capture says nothing about a persistent AOT cache
 * if the modules drift between scenes. Pass two or more traces to get the overlap of their
 * top-K sets AND the weight that common set carries in EACH of them — a set that overlaps but
 * carries its weight in only one capture is not a stable set.
 *
 * Usage:
 *   bun tools/s-time.ts <trace.json.gz> [--top 16] [--json]
 *   bun tools/s-time.ts --compare <a.json.gz> <b.json.gz> [<c.json.gz> ...]
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const PAGE = 0x1000;

/** Below this share of wasm samples resolved, no S_time is printed. */
const MIN_JOIN = 0.6;

interface Sample { name: string; url: string; }

function loadTrace(path: string): any[] {
    const raw = readFileSync(path);
    const buf = path.endsWith(".gz") ? gunzipSync(raw) : raw;
    const parsed = JSON.parse(buf.toString("utf8"));
    return parsed.traceEvents ?? parsed;
}

/** wasm_fn_idx -> guest address, from the bottleship.hotblocks mark. */
function buildBlockMap(events: any[]): { map: Map<number, number>; rows: number } {
    const map = new Map<number, number>();
    let rows = 0;
    for (const ev of events) {
        if (ev?.name !== "bottleship.hotblocks") continue;
        // Same unwrapping as analyze-trace: the mark carries its payload under
        // args.data.detail / args.data / args.detail, and it may be JSON-encoded twice.
        const args = ev.args ?? {};
        let parsed: any = args?.data?.detail ?? args?.data ?? args?.detail;
        for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
            try { parsed = JSON.parse(parsed); } catch { break; }
        }
        const list: any[] = Array.isArray(parsed?.rows) ? parsed.rows : [];
        for (const row of list) {
            let idx: number | null = null;
            if (typeof row.wasm_fn === "string") {
                const m = row.wasm_fn.match(/^wasm-function\[(\d+)\]$/);
                if (m) idx = Number(m[1]);
            }
            if (idx === null) {
                const raw = row.wasm_fn_idx ?? row.idx;
                if (typeof raw === "number") idx = raw;
            }
            const addrRaw = row.phys_addr ?? row.addr ?? row.guest_addr;
            const addr = typeof addrRaw === "string" ? Number.parseInt(addrRaw, 16) : addrRaw;
            if (idx === null || typeof addr !== "number" || !Number.isFinite(addr)) continue;
            map.set(idx, addr >>> 0);
            rows++;
        }
    }
    return { map, rows };
}

/** Self-time sample counts per callFrame, for the busiest worker thread. */
function collectSamples(events: any[]): { samples: Map<string, { s: Sample; n: number }>; total: number } {
    const byThread = new Map<string, { nodes: Map<number, Sample>; counts: Map<number, number>; total: number }>();
    for (const ev of events) {
        const profile = ev?.args?.data?.cpuProfile;
        if (!profile) continue;
        const key = `${ev.pid}/${ev.tid}`;
        let t = byThread.get(key);
        if (!t) { t = { nodes: new Map(), counts: new Map(), total: 0 }; byThread.set(key, t); }
        for (const node of profile.nodes ?? []) {
            t.nodes.set(node.id, {
                name: node.callFrame?.functionName ?? "?",
                url: node.callFrame?.url ?? "",
            });
        }
        for (const id of profile.samples ?? []) {
            t.counts.set(id, (t.counts.get(id) ?? 0) + 1);
            t.total++;
        }
    }
    let best: { nodes: Map<number, Sample>; counts: Map<number, number>; total: number } | null = null;
    for (const t of byThread.values()) if (!best || t.total > best.total) best = t;
    const out = new Map<string, { s: Sample; n: number }>();
    if (!best) return { samples: out, total: 0 };
    for (const [id, n] of best.counts) {
        const s = best.nodes.get(id);
        if (!s) continue;
        const key = `${s.name}|${s.url}`;
        const prev = out.get(key);
        if (prev) prev.n += n; else out.set(key, { s, n });
    }
    return { samples: out, total: best.total };
}

/** The engine bucket is NOT one thing, and its composition IS the absorption ratio.
 *  Collapsing it into a single regex forces the caller to assume it is either wholly
 *  uncoverable (conservative) or wholly proportional (optimistic) — two guesses where a
 *  measurement was available. Each class below is named by what an AOT unit can actually do
 *  with it, so the third column is measured rather than assumed. */
const CORE_CLASSES: Array<[string, RegExp, "never" | "dispatch" | "banked" | "totality"]> = [
    // Our HLE boundary and the tick loop. An AOT unit cannot remove either.
    ["main_loop / hypercall", /main_loop|hypercall/, "never"],
    // Block dispatch and the indirect-jump cache: absorbed by compiling MORE of the guest
    // into one unit (raising N), because intra-unit control flow stops going through them.
    ["dispatch (cycle_internal, jit cache)", /cycle_internal|jit_find_cache/, "dispatch"],
    // Guest memory access. Production already runs fastmem reads, so this is a lever to
    // RE-EARN inside a unit, not headroom; stores keep their guard by decision (SMC/CoW).
    ["memory access (safe_*, translate, read*)", /safe_read|safe_write|translate_address|^read(32s|16|8)$|6memory8read/, "banked"],
    // Anything still interpreted is absorbed by the unit existing at all.
    ["interpreter", /interpreter/, "totality"],
];

const WASM_FN = /^wasm-function\[(\d+)\]$/;
/** The JIT's name-section format: guest entry address + the table slot it was published in. */
const JIT_NAME = /^g([0-9a-f]{8})@t(\d+)$/;
/** v86 machinery that an AOT unit does NOT replace outright but whose cost it can absorb. */
const CORE = /cycle_internal|safe_read|safe_write|6memory|translate_address|jit_find_cache|interpreter|main_loop|hypercall/;

/** Per-unit sample counts for one trace, THUNK_CODE already excluded. */
function unitsOf(file: string): { rows: Array<[number, number]>; total: number } {
    const events = loadTrace(file);
    const { samples } = collectSamples(events);
    const per = new Map<number, number>();
    let total = 0;
    for (const { s, n } of samples.values()) {
        const named = s.name.match(JIT_NAME);
        if (!named) continue;
        const addr = Number.parseInt(named[1], 16) >>> 0;
        if (addr >= 0x2100_0000 && addr < 0x2200_0000) continue;
        const page = addr & ~(PAGE - 1);
        per.set(page, (per.get(page) ?? 0) + n);
        total += n;
    }
    return { rows: [...per].sort((a, b) => b[1] - a[1]), total };
}

function compare(files: string[]): void {
    const traces = files.map((f) => ({ file: f, ...unitsOf(f) }));
    console.log(`STABILITY of the hot module set across ${files.length} captures
`);
    for (const t of traces) {
        console.log(`  ${t.file.split(/[\/]/).pop()}  units ${t.rows.length}  samples ${t.total}`);
        if (t.total === 0) console.log(`     ^ no named JIT frames — this capture cannot participate`);
    }
    if (traces.some((t) => t.total === 0)) { console.log(`
Refusing to compare: a capture with no named frames contributes nothing.`); process.exitCode = 1; return; }
    console.log(`
  topK   common   weight of the common set in each capture`);
    for (const k of [8, 16, 32, 57]) {
        if (traces.some((t) => t.rows.length < k)) continue;
        const sets = traces.map((t) => new Set(t.rows.slice(0, k).map((r) => r[0])));
        const common = [...sets[0]].filter((p) => sets.every((s2) => s2.has(p)));
        const weights = traces.map((t) => {
            const m = new Map(t.rows);
            const w = common.reduce((a, p) => a + (m.get(p) ?? 0), 0);
            return (100 * w / t.total).toFixed(1) + "%";
        });
        console.log(`  ${String(k).padStart(4)}   ${String(common.length).padStart(3)}/${k}    ${weights.join("  ")}`);
    }
    console.log(`
A set that overlaps AND carries the same weight everywhere is what a persistent`);
    console.log(`AOT cache needs. Overlap alone is not enough — a common unit that is hot in one`);
    console.log(`capture and cold in another still leaves the cache missing where it matters.`);
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.includes("--compare")) {
        const files = args.filter((a) => !a.startsWith("--"));
        if (files.length < 2) { console.error("--compare needs at least two traces"); process.exit(2); }
        compare(files);
        return;
    }
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) { console.error("usage: bun tools/s-time.ts <trace.json.gz> [--top N] [--json]"); process.exit(2); }
    const topN = Number(args[args.indexOf("--top") + 1]) || 16;
    const asJson = args.includes("--json");

    const events = loadTrace(file);
    const { map, rows } = buildBlockMap(events);
    const { samples, total } = collectSamples(events);

    // Split the profile into the three populations the question needs.
    let wasmFnSamples = 0, resolved = 0, coreSamples = 0;
    const perPage = new Map<number, number>();
    const idxUrls = new Map<number, Set<string>>();
    let unnamed = 0;
    const coreByClass = new Map<string, number>();
    for (const { s, n } of samples.values()) {
        const named = s.name.match(JIT_NAME);
        if (named) {
            wasmFnSamples += n;
            resolved += n;
            const addr = Number.parseInt(named[1], 16) >>> 0;
            const page = addr & ~(PAGE - 1);
            perPage.set(page, (perPage.get(page) ?? 0) + n);
            continue;
        }
        const m = s.name.match(WASM_FN);
        if (m) {
            // An unnamed JIT frame: compiled before the knob, or served from an AOT cache
            // built with names off. Counted in the denominator so it cannot inflate coverage.
            wasmFnSamples += n;
            unnamed += n;
            const idx = Number(m[1]);
            let urls = idxUrls.get(idx);
            if (!urls) { urls = new Set(); idxUrls.set(idx, urls); }
            urls.add(s.url);
            continue;
        }
        if (CORE.test(s.name)) {
            coreSamples += n;
            for (const [label, re] of CORE_CLASSES) if (re.test(s.name)) { coreByClass.set(label, (coreByClass.get(label) ?? 0) + n); break; }
        }
    }

    const ambiguous = [...idxUrls.values()].filter((u) => u.size > 1).length;
    const joinQuality = wasmFnSamples > 0 ? resolved / wasmFnSamples : 0;

    // THUNK_CODE is not AOT-able: those bytes are generated by ThunkGenerator and rewritten in
    // place for the life of the process (CLAUDE.md 3.1), so a static unit cannot stand in for
    // them. They ARE guest execution, so they stay in the denominator and leave the numerator.
    const THUNK_LO = 0x2100_0000, THUNK_HI = 0x2200_0000;
    const isThunk = (page: number) => page >= THUNK_LO && page < THUNK_HI;
    let thunkSamples = 0;
    for (const [page, n] of perPage) if (isThunk(page)) thunkSamples += n;
    const pages = [...perPage].filter(([page]) => !isThunk(page)).sort((a, b) => b[1] - a[1]);
    const guestTotal = wasmFnSamples + coreSamples;

    const report = {
        file,
        traceSamples: total,
        mapRows: rows,
        mapIndices: map.size,
        wasmFnSamples,
        resolvedSamples: resolved,
        joinQuality: +joinQuality.toFixed(3),
        ambiguousIndices: ambiguous,
        distinctPages: pages.length,
        coreSamples,
        guestExecutionSamples: guestTotal,
        curve: [] as Array<{ pages: number; sTimeConservative: number; sTimeOptimistic: number }>,
    };

    for (const k of [8, 16, 32, 57, pages.length]) {
        if (k <= 0 || k > pages.length) continue;
        const inTop = pages.slice(0, k).reduce((a, [, n]) => a + n, 0);
        // Conservative: every v86-core sample is uncoverable, so it sits in the denominator.
        // Optimistic: core cost is caused proportionally by the code that runs, so the covered
        // share of JIT-block time carries the same share of core time with it.
        report.curve.push({
            pages: k,
            sTimeConservative: guestTotal > 0 ? +(inTop / guestTotal).toFixed(3) : 0,
            sTimeOptimistic: wasmFnSamples > 0 ? +(inTop / wasmFnSamples).toFixed(3) : 0,
        });
    }

    if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

    console.log(`S_time — share of guest execution TIME reachable by an AOT unit`);
    console.log(`file: ${file}\n`);
    console.log(`ATTRIBUTION QUALITY (read this before any number below)`);
    console.log(`  wasm frames sampled           ${wasmFnSamples}`);
    console.log(`  ...carrying a JIT name        ${resolved}  (${(joinQuality * 100).toFixed(1)}%)`);
    console.log(`  ...still bare wasm-function[] ${unnamed}` +
        (unnamed > 0 ? "  <-- compiled before the knob, or an AOT cache built names-off" : ""));
    if (rows > 0) console.log(`  (hotblocks map present: ${rows} rows — no longer used for attribution)`);

    if (joinQuality < MIN_JOIN) {
        console.log(`\nREFUSING to report S_time: only ${(joinQuality * 100).toFixed(1)}% of wasm samples`);
        console.log(`resolved to a guest page (threshold ${MIN_JOIN * 100}%). A coverage figure from`);
        console.log(`this join would be a plausible number measuring something other than its label.`);
        console.log(`Capture the trace with a fresh 'bottleship.hotblocks' mark inside the recording`);
        console.log(`window (bun tools/harness.ts trace <sec> emits one) and re-run.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nPOPULATIONS`);
    console.log(`  JIT-block time (guest code)   ${wasmFnSamples} samples`);
    console.log(`  v86 core/helpers              ${coreSamples} samples`);
    console.log(`  guest execution total         ${guestTotal} samples`);
    console.log(`  distinct AOT-able units       ${pages.length}`);
    console.log(`  THUNK_CODE (our trampolines)  ${thunkSamples} samples (${(100 * thunkSamples / guestTotal).toFixed(2)}% of guest execution)`);
    console.log(`     — guest execution, but generated and rewritten in place, so not AOT-able:`);
    console.log(`       counted in the denominator, excluded from every numerator below.`);

    console.log(`
ENGINE BUCKET, BY WHAT AN AOT UNIT CAN DO WITH IT`);
    console.log(`  (its composition IS the absorption ratio — this replaces the two guesses below)`);
    let absorbable = 0;
    for (const [label, , kind] of CORE_CLASSES) {
        const cnt = coreByClass.get(label) ?? 0;
        if (!cnt) continue;
        if (kind === "dispatch" || kind === "totality") absorbable += cnt;
        const note = kind === "never" ? "NOT absorbable"
            : kind === "dispatch" ? "absorbable by raising N (intra-unit control flow)"
            : kind === "banked" ? "already banked in production (fastmem reads); stores keep their guard"
            : "absorbable by the unit existing";
        console.log(`  ${label.padEnd(38)} ${String(cnt).padStart(6)}  ${(100 * cnt / guestTotal).toFixed(2).padStart(6)}%  ${note}`);
    }
    const classified = [...coreByClass.values()].reduce((a, b) => a + b, 0);
    if (coreSamples > classified) {
        console.log(`  ${"UNCLASSIFIED".padEnd(38)} ${String(coreSamples - classified).padStart(6)}  ${(100 * (coreSamples - classified) / guestTotal).toFixed(2).padStart(6)}%  <-- widen CORE_CLASSES before trusting the ratio`);
    }
    console.log(`  ABSORBABLE SHARE OF THE ENGINE BUCKET: ${coreSamples ? (100 * absorbable / coreSamples).toFixed(1) : "n/a"}% ` +
        `(${(100 * absorbable / guestTotal).toFixed(2)}% of guest execution)`);

    console.log(`\nCOVERAGE CURVE (compare against the retired-instruction curve in`);
    console.log(`plan/aot-compiler-handoff.md:44 — 8 pages 0.283 / 16 0.356 / 32 0.385 / 57 0.389)`);
    console.log(`  units   S_time conservative   S_time optimistic`);
    for (const row of report.curve)
        console.log(`  ${String(row.pages).padStart(5)}   ${row.sTimeConservative.toFixed(3).padStart(17)}   ${row.sTimeOptimistic.toFixed(3).padStart(17)}`);
    console.log(`\n  conservative = every v86-core sample counted as uncoverable`);
    console.log(`  optimistic   = core cost attributed proportionally to the covered code`);
    console.log(`  The truth is between them; report BOTH, never one.`);

    console.log(`\nTOP ${topN} GUEST PAGES BY TIME`);
    for (const [page, n] of pages.slice(0, topN))
        console.log(`  0x${page.toString(16).padStart(8, "0")}  ${String(n).padStart(6)} samples  ${(100 * n / guestTotal).toFixed(2)}% of guest execution`);
}

main();
