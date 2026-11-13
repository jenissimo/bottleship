// Executed Wasm-op density per guest instruction: static ops of each JIT block, weighted by how
// often the block actually ran.
//
//   density = sum(exec_b * ops_b) / sum(exec_b * instructions_b)
//
// Inputs
//   publications  `jitPublications export` of a capture armed with {blockMap:true}: module
//                 bytes plus, per module, each block's physical address, instruction count and
//                 body byte range (v86 jit_block_map.rs).
//   counted       `guestBlocks(...)` output (its `counted.rows`, so ask for every row:
//                 {top:100000}) or a bare [{addr, exec, ins, module?}] array. trace2 keys a block
//                 by the same physical start address the map records.
//
// What `ops_b` is: every Wasm instruction in the block's byte range — its body and its
// terminator (branch, chain or exit code), slow arms included, structural ops (block/end/br)
// included. Code outside every block (the dispatcher, loop heads, the module epilogue) is
// executed per module entry or loop iteration, not per block; it is reported per module as
// `unattributedOps` and left out of the density.
//
// Choosing a block's ops when it was compiled more than once (recompiles, other module
// shapes): only copies whose instruction count equals the counted block's qualify (a
// different count is a different block that merely starts at the same address); copies
// compiled while trace2 watched the page carry the exec counter, so untraced copies win;
// among those the latest publication wins. `opsRange` reports the spread over the qualifying
// copies, so a recompile that changed the code is visible rather than averaged away.
//
// Usage: bun tools/bench-v86/jit-exec-density.mjs <publications.json> <guestBlocks.json>
//          [--ranges ranges.json] [--top N] [--json]
//   ranges.json: [{name, from, to}] with numeric or 0x-hex physical addresses (first match wins).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseModule, walkBody } from '../aot/lib/wdis.mjs';

const num = v => typeof v === 'string' ? Number.parseInt(v, v.startsWith('0x') ? 16 : 10) >>> 0 : v >>> 0;
const hex = v => '0x' + (v >>> 0).toString(16);
const round = (v, d = 3) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;

function decode(base64) {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/**
 * Static ops per mapped block of one module. Throws when the map does not describe the bytes
 * (body length) or a range boundary falls inside an instruction — both mean the ranges are
 * not offsets into this code, and any count from them would be fiction.
 */
export function blockOps(bytes, map) {
    const m = parseModule(bytes);
    if (m.code?.count !== 1) throw new Error('expected a single-function JIT module');
    const { instrStart, instrEnd } = m.code;
    if (instrEnd - instrStart - 1 !== map.bodyLength) {
        throw new Error(`map body length ${map.bodyLength} != module body ${instrEnd - instrStart - 1}`);
    }
    const starts = new Set();
    const order = map.blocks.map((b, i) => i).sort((a, b) => map.blocks[a].bodyStart - map.blocks[b].bodyStart);
    const ops = new Array(map.blocks.length).fill(0);
    let total = 0, k = 0;
    for (const ins of walkBody(bytes, instrStart, instrEnd)) {
        const off = ins.offset - instrStart;
        starts.add(off);
        total++;
        while (k < order.length && map.blocks[order[k]].bodyEnd <= off) k++;
        if (k < order.length && map.blocks[order[k]].bodyStart <= off) ops[order[k]]++;
    }
    starts.add(instrEnd - instrStart);
    for (const b of map.blocks) {
        if (!starts.has(b.bodyStart) || !starts.has(b.bodyEnd) || b.bodyEnd < b.bodyStart) {
            throw new Error(`block ${hex(b.addr)} range [${b.bodyStart},${b.bodyEnd}) is not on instruction boundaries`);
        }
    }
    const attributed = ops.reduce((s, v) => s + v, 0);
    return { ops, totalOps: total, unattributedOps: total - attributed };
}

/** Every mapped copy of every block in the capture, keyed by physical block address. */
export function blockVariants(publications) {
    const bytesBySha = new Map((publications.modules ?? []).map(m => [m.sha256, m.base64]));
    const cache = new Map();
    const variants = new Map();
    const modules = [];
    const skipped = { notPublished: 0, noMap: 0, invalid: [] };
    for (const ev of publications.events ?? []) {
        if (ev.status !== 'published') { skipped.notPublished++; continue; }
        if (ev.blockMap?.status !== 'ok') { skipped.noMap++; continue; }
        const key = `${ev.sha256}:${ev.generation}`;
        const cacheKey = ev.sha256 + JSON.stringify(ev.blockMap.blocks.map(b => [b.bodyStart, b.bodyEnd]));
        let stats = cache.get(cacheKey);
        if (!stats) {
            const b64 = bytesBySha.get(ev.sha256);
            if (!b64) { skipped.invalid.push({ generation: ev.generation, reason: 'module bytes missing' }); continue; }
            try { stats = blockOps(decode(b64), ev.blockMap); }
            catch (e) { skipped.invalid.push({ generation: ev.generation, reason: String(e.message ?? e) }); continue; }
            cache.set(cacheKey, stats);
        }
        const mod = { key, entry: hex(ev.start), tableIndex: ev.tableIndex, generation: ev.generation,
            publicationOrder: ev.publicationOrder, blocks: ev.blockMap.blocks.length,
            totalOps: stats.totalOps, unattributedOps: stats.unattributedOps,
            traced: ev.blockMap.blocks.some(b => b.traced) };
        modules.push(mod);
        ev.blockMap.blocks.forEach((b, i) => {
            const list = variants.get(b.addr >>> 0) ?? [];
            list.push({ addr: b.addr >>> 0, instructions: b.instructions, ops: stats.ops[i], traced: !!b.traced,
                bytes: b.bodyEnd - b.bodyStart, publicationOrder: ev.publicationOrder ?? 0, module: mod });
            variants.set(b.addr >>> 0, list);
        });
    }
    return { variants, modules, skipped };
}

function countedRows(counted) {
    const rows = Array.isArray(counted) ? counted : (counted?.counted?.rows ?? counted?.rows);
    if (!Array.isArray(rows)) throw new Error('counted input has no rows (pass guestBlocks output or an array)');
    if (counted?.counted && counted.counted.available === false) throw new Error(`guestBlocks census unavailable: ${counted.counted.note}`);
    return rows.map(r => ({ addr: num(r.addr), exec: Number(r.exec), ins: Number(r.ins), module: r.module ?? null }));
}

function acc() { return { blocks: 0, execIns: 0, execOps: 0, execOpsMin: 0, execOpsMax: 0, staticIns: 0, staticOps: 0 }; }
function add(a, exec, ins, ops, lo, hi) {
    a.blocks++; a.execIns += exec * ins; a.execOps += exec * ops;
    a.execOpsMin += exec * lo; a.execOpsMax += exec * hi;
    a.staticIns += ins; a.staticOps += ops;
}
function out(a, extra = {}) {
    return { ...extra, blocks: a.blocks, executedIns: a.execIns, executedOps: a.execOps,
        executedDensity: round(a.execOps / a.execIns),
        executedDensityRange: [round(a.execOpsMin / a.execIns), round(a.execOpsMax / a.execIns)],
        staticDensity: round(a.staticOps / a.staticIns) };
}

/**
 * Join the block map with the counted census.
 * `ranges`: optional [{name, from, to}] physical address spans (functions), first match wins.
 */
export function execDensity(publications, counted, { ranges = [], top = 20 } = {}) {
    const { variants, modules, skipped } = blockVariants(publications);
    const rows = countedRows(counted);
    const spans = ranges.map(r => ({ name: r.name, from: num(r.from), to: num(r.to) }));
    const total = acc(), byGuest = new Map(), byJit = new Map(), byRange = new Map();
    const missing = { unmapped: { blocks: 0, execIns: 0 }, shapeMismatch: { blocks: 0, execIns: 0 } };
    let countedIns = 0, tracedOnlyIns = 0;
    const blocks = [];
    for (const r of rows) {
        const w = r.exec * r.ins;
        countedIns += w;
        if (!r.exec) continue;
        const all = variants.get(r.addr);
        if (!all) { missing.unmapped.blocks++; missing.unmapped.execIns += w; continue; }
        const same = all.filter(v => v.instructions === r.ins);
        if (!same.length) { missing.shapeMismatch.blocks++; missing.shapeMismatch.execIns += w; continue; }
        const clean = same.filter(v => !v.traced);
        const pool = clean.length ? clean : same;
        if (!clean.length) tracedOnlyIns += w;
        const pick = pool.reduce((a, b) => (b.publicationOrder > a.publicationOrder ? b : a));
        const lo = Math.min(...pool.map(v => v.ops)), hi = Math.max(...pool.map(v => v.ops));
        add(total, r.exec, r.ins, pick.ops, lo, hi);
        const g = r.module ? r.module.split('+')[0] : '(unresolved)';
        const jk = `${pick.module.entry}@g${pick.module.generation}`;
        for (const [map, k] of [[byGuest, g], [byJit, jk]]) {
            if (!map.has(k)) map.set(k, acc());
            add(map.get(k), r.exec, r.ins, pick.ops, lo, hi);
        }
        const span = spans.find(s => r.addr >= s.from && r.addr < s.to);
        if (span) {
            if (!byRange.has(span.name)) byRange.set(span.name, acc());
            add(byRange.get(span.name), r.exec, r.ins, pick.ops, lo, hi);
        }
        blocks.push({ addr: hex(r.addr), module: r.module, exec: r.exec, ins: r.ins, ops: pick.ops,
            opsPerIns: round(pick.ops / r.ins), executedOps: r.exec * pick.ops, executedIns: w,
            copies: same.length, opsRange: [lo, hi], traced: pick.traced, jitModule: jk });
    }
    const sortGroups = m => [...m].map(([k, a]) => out(a, { name: k })).sort((x, y) => y.executedIns - x.executedIns);
    blocks.sort((a, b) => b.executedOps - a.executedOps);
    return {
        total: out(total),
        coverage: {
            countedIns, matchedIns: total.execIns,
            matchedPct: countedIns ? round(100 * total.execIns / countedIns, 1) : null,
            unmapped: missing.unmapped, shapeMismatch: missing.shapeMismatch,
            tracedOnlyIns,
            note: 'unmapped = counted blocks no captured module mapped (compiled before the capture was armed, or dropped by its limits); '
                + 'shapeMismatch = mapped only with a different instruction count; tracedOnlyIns = matched only to copies carrying the trace2 counter (ops inflated by the instrument).',
        },
        byGuestModule: sortGroups(byGuest),
        byJitModule: sortGroups(byJit).map(g => ({ ...g, ...(() => {
            const m = modules.find(x => `${x.entry}@g${x.generation}` === g.name);
            return m ? { totalOps: m.totalOps, unattributedOps: m.unattributedOps, traced: m.traced } : {};
        })() })),
        ...(spans.length ? { byRange: sortGroups(byRange) } : {}),
        topBlocks: blocks.slice(0, top),
        modules: { mapped: modules.length, skipped },
        definition: 'executedDensity = sum(exec*ops)/sum(exec*ins) over matched blocks; executedDensityRange uses the min/max ops over '
            + 'qualifying copies; staticDensity = sum(ops)/sum(ins) over the same blocks, unweighted. Dispatcher/epilogue ops are excluded (unattributedOps per module).',
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    const pos = args.filter((a, i) => !a.startsWith('--') && !['--ranges', '--top'].includes(args[i - 1]));
    if (pos.length < 2) {
        console.error('Usage: bun tools/bench-v86/jit-exec-density.mjs <publications.json> <guestBlocks.json> [--ranges ranges.json] [--top N] [--json]');
        process.exit(2);
    }
    const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = execDensity(read(pos[0]), read(pos[1]), {
        ranges: opt('--ranges') ? read(opt('--ranges')) : [], top: Number(opt('--top') ?? 20) });
    if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
    const t = res.total, c = res.coverage;
    console.log(`executed density ${t.executedDensity} ops/ins (copies ${t.executedDensityRange.join('..')}), static over the same blocks ${t.staticDensity}`);
    console.log(`coverage ${c.matchedPct}% of counted instructions (${c.matchedIns}/${c.countedIns}); unmapped ${c.unmapped.execIns}, shape mismatch ${c.shapeMismatch.execIns}, traced-only ${c.tracedOnlyIns}`);
    const table = (title, list) => {
        console.log(`\n${title}`);
        for (const g of list) console.log(`  ${String(g.name).padEnd(28)} exec-ins ${String(g.executedIns).padStart(14)}  density ${String(g.executedDensity).padStart(8)}  static ${g.staticDensity}`);
    };
    table('by guest module', res.byGuestModule);
    table('by JIT module (entry@generation)', res.byJitModule.slice(0, 15));
    if (res.byRange) table('by range', res.byRange);
    console.log('\ntop blocks by executed ops');
    for (const b of res.topBlocks) console.log(`  ${b.addr.padEnd(11)} ${String(b.module ?? '').padEnd(26)} exec ${String(b.exec).padStart(10)}  ins ${String(b.ins).padStart(4)}  ops ${String(b.ops).padStart(5)}  ops/ins ${b.opsPerIns}`);
}
