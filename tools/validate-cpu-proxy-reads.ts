#!/usr/bin/env bun
/**
 * Gate step: v86 CPU-state access OWNERSHIP.
 *
 * v86 publishes the CPU state block (`cpu.reg32`, `cpu.instruction_pointer`,
 * `cpu.segment_offsets`, …) as `view()` Proxies so that WASM memory growth stays
 * transparent (vendor/v86/src/lib.js). Every INDEX into one of them is a `get` trap plus a
 * `resolve()` closure call plus a buffer-identity compare — paid per access, on paths that
 * run several times per dispatched WinAPI call and at every context switch, to re-answer a
 * question whose answer changes a handful of times per session.
 *
 * `core/cpu/cpu-views.ts` answers it once: plain typed arrays over the same bytes, rebuilt
 * only when the buffer identity changes. `cpuViews(cpu)` / `readEip` / `readEsp` /
 * `readRetiredInsns` are the sanctioned spellings.
 *
 * THE RULE, the same shape as validate-guest-memory-borrow: this is about OWNERSHIP, not
 * coverage. Deciding whether a given `cpu.reg32[4]` is hot needs a profile; deciding who
 * may index a CPU-state Proxy at all is a grep. The hot owners are listed in OWNERS; every
 * other site that existed when the rule landed is PINNED per file, exactly, so the class
 * can shrink but never grow. A new one fails here.
 *
 * WHAT IT MATCHES, and what that misses: an index whose RECEIVER names a CPU — `cpu.x[…]`,
 * `this.cachedCpu.x[…]`, `emu.cpu.x[…]`, or the bare `c` the harness uses. Assigning the
 * Proxy to a differently-named local first (`const q = cpu.reg32; q[4]`) walks past this,
 * and no grep can close that without dataflow. The pinned counts are what make the erosion
 * visible anyway: the file's number moves.
 *
 * NOT a correctness rule. Indexing the Proxy is always CORRECT — that is precisely why the
 * class regrows silently, and why it needs a gate rather than a comment.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "worker");

/** v86 CPU-state views, from vendor/v86/src/cpu.js (the `view(...)` assignments). */
const FIELDS = [
    "reg32", "instruction_pointer", "instruction_counter", "previous_ip",
    "flags", "flags_changed", "last_op1", "last_op_size", "last_result",
    "segment_offsets", "segment_is_null", "segment_limits", "sreg",
    "cr", "cpl", "in_hlt", "is_32", "protected_mode", "memory_size", "prefixes",
    "fpu_simd_dirty", "fpu_stack_ptr", "fpu_stack_empty",
    "fpu_control_word", "fpu_status_word", "reg_xmm32s", "mxcsr",
    "current_tsc", "last_virt_eip", "eip_phys",
].join("|");

/**
 * A receiver that names a CPU: anything ending in `cpu` (cpu, cachedCpu, theCpu, v86.cpu),
 * or the bare `c` the harness commands use for one. Optional chaining in either position.
 */
const ACCESS = new RegExp(
    // `!` and `?.` between the field and the index are part of the spelling, not of the
    // access: `cpu.segment_offsets![4]` is the same trap. Leaving them out made the gate
    // pass on a deliberately planted site.
    String.raw`(?:^|[^\w.$])(?:[\w$]*\.)?([\w$]*[Cc]pu|c)\s*[!]?\s*(?:\?\.|\.)\s*(${FIELDS})\s*(?:!|\?\.)*\s*\[`,
    "g",
);

/**
 * Files allowed to index a CPU-state Proxy freely, with why.
 *
 * Empty on purpose. `core/cpu/cpu-views.ts` reads `cpu.reg32` to build its fallback views
 * but never INDEXES one, so it needs no exemption — and an exemption nothing uses reads as
 * evidence that the file still pays the trap. The mechanism stays for a future owner that
 * genuinely needs the growth-transparent Proxy; the STALE OWNER check below is what keeps
 * an entry from outliving its reason.
 */
const OWNERS: Record<string, string> = {};

/**
 * Sites that predate the rule, pinned EXACTLY per file. Lowering a number is a reviewable
 * line in a diff; adding a site fails the gate. Not an allowlist — every entry is a file
 * still paying a Proxy trap per CPU-state access.
 *
 * Roughly three groups, and they are not equally worth converting:
 *   - hot: thunk-dispatcher, callback-manager, seh-dispatch, the d3d8/d3d9 fast paths.
 *   - warm: the HLE modules, one or two accesses per call.
 *   - cold by design: harness/* and *forensics* — diagnostics, where matching exactly what
 *     the guest would see matters more than the trap.
 */
const PINNED = new Map<string, number>([
    ["core/com/base-com-object.ts", 3],
    ["core/com/com-ref-trace.ts", 1],
    ["core/com/released-com-trap.ts", 1],
    ["core/cpu/aot-cache.ts", 1],
    ["core/debug/dbg-commands.ts", 3],
    ["core/diagnostics-commands.ts", 1],
    ["core/hle-lib/sync-guest-call.ts", 4],
    ["core/memory/js-write-trap.ts", 2],
    ["core/memory/mem-write-trap.ts", 3],
    ["core/memory/memory-fault.ts", 2],
    ["core/memory/page-table-manager.ts", 3],
    ["core/scheduler/scheduler.ts", 3],
    ["core/seh-dispatch.ts", 11],
    ["core/system.ts", 6],
    ["core/thunking/callback-manager.ts", 19],
    ["core/thunking/dispatcher-forensics.ts", 9],
    ["core/thunking/exception-context-dumper.ts", 2],
    ["core/thunking/thunk-dispatcher.ts", 65],
    ["emulator.worker.ts", 24],
    ["harness/cmds/breakpoints.ts", 4],
    ["harness/cmds/fpu.ts", 3],
    ["harness/cmds/perf.ts", 1],
    ["harness/eip-breaks.ts", 17],
    ["harness/serialize.ts", 22],
    ["modules/bass.ts", 1],
    ["modules/crt-callback-chain.ts", 1],
    ["modules/crt-seh3.ts", 3],
    ["modules/crt-time.ts", 2],
    ["modules/crt-vc9-abi.ts", 3],
    ["modules/crt-vc9-io.ts", 3],
    ["modules/crt-vc9-setjmp.ts", 3],
    ["modules/ffmpeg/avcodec-decode-hle.ts", 1],
    ["modules/kernel32/exception.ts", 1],
    ["modules/kernel32/process/version-verify.ts", 1],
    ["modules/msvcrt.ts", 2],
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/**
 * Blank out comments and string/template literals, preserving line structure.
 *
 * Per-LINE stripping is not enough here: the codebase documents this very rule in JSDoc
 * (`cpu.segment_offsets[4]`, `cpu.fpu_control_word[0]`), and a block comment spans lines,
 * so a line-local strip reports prose as sites. Literals go too — a log format string is
 * not an access either.
 */
function stripNonCode(src: string): string {
    const out = src.split("");
    let i = 0;
    const blank = (from: number, to: number) => {
        for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
    };
    while (i < src.length) {
        const ch = src[i]!, next = src[i + 1];
        if (ch === "/" && next === "/") {
            let j = i; while (j < src.length && src[j] !== "\n") j++;
            blank(i, j); i = j;
        } else if (ch === "/" && next === "*") {
            let j = src.indexOf("*/", i + 2); j = j < 0 ? src.length : j + 2;
            blank(i, j); i = j;
        } else if (ch === '"' || ch === "'" || ch === "`") {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === ch) { j++; break; }
                if (ch !== "`" && src[j] === "\n") break; // unterminated: don't swallow the file
                j++;
            }
            blank(i + 1, j - 1 > i ? j - 1 : i + 1); i = j;
        } else {
            i++;
        }
    }
    return out.join("");
}

const seen = new Map<string, number>();
const sites = new Map<string, { line: number; text: string }[]>();

for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (OWNERS[rel]) continue;
    const raw = readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/);
    stripNonCode(raw).split(/\r?\n/).forEach((c, i) => {
        ACCESS.lastIndex = 0;
        while (ACCESS.exec(c) !== null) {
            seen.set(rel, (seen.get(rel) ?? 0) + 1);
            if (!sites.has(rel)) sites.set(rel, []);
            sites.get(rel)!.push({ line: i + 1, text: (lines[i] ?? "").trim() });
        }
    });
}

// Maintenance affordance: `--print-pins` emits the PINNED map for the tree as it stands.
// Paste it in when a conversion round lowers several files at once — hand-editing a
// 40-entry census is how a pin silently drifts to a number nobody measured.
if (process.argv.includes("--print-pins")) {
    const rows = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
    console.log("const PINNED = new Map<string, number>([");
    for (const [rel, n] of rows) console.log(`    [${JSON.stringify(rel)}, ${n}],`);
    console.log("]);");
    process.exit(0);
}

const problems: string[] = [];

for (const [rel, found] of seen) {
    const pinned = PINNED.get(rel);
    if (pinned === undefined) {
        problems.push(
            `  NEW: ${rel} — ${found} CPU-state Proxy index(es); no pin.\n` +
            (sites.get(rel) ?? []).slice(0, 5).map(s => `        ${rel}:${s.line}  ${s.text}`).join("\n"),
        );
    } else if (found !== pinned) {
        problems.push(`  DRIFT: ${rel} — ${found} site(s), pinned at ${pinned}`);
    }
}

// A pin whose file no longer has any site reads as evidence that the file still pays,
// when it does not.
for (const [rel, pinned] of PINNED) {
    if (!seen.has(rel)) problems.push(`  STALE PIN: ${rel} — pinned at ${pinned}, none found; delete the entry`);
}

const staleOwners = Object.keys(OWNERS).filter(rel => {
    ACCESS.lastIndex = 0;
    return !ACCESS.test(stripNonCode(readFileSync(join(ROOT, rel), "utf8")));
});
for (const rel of staleOwners) problems.push(`  STALE OWNER: ${rel} — no longer indexes a CPU-state Proxy; delete the OWNERS entry`);

if (problems.length > 0) {
    console.error(
        "CPU-state Proxy ownership CHANGED.\n\n" +
        "Each site below indexes one of v86's `view()` Proxies: a get trap + resolve() +\n" +
        "buffer compare, per access. Read it through core/cpu/cpu-views.ts instead\n" +
        "(`cpuViews(cpu).reg32[4]`, or `readEip(cpu)` / `readEsp(cpu)` / `readRetiredInsns(cpu)`).\n" +
        "Converted some? Lower that file's number here. Added one? Don't.\n",
    );
    for (const p of problems) console.error(p);
    process.exit(1);
}

const total = [...seen.values()].reduce((a, b) => a + b, 0);
console.log(
    `CPU-state Proxy ownership OK — ${Object.keys(OWNERS).length} owner(s) plus ` +
    `${total} pinned site(s) in ${seen.size} file(s).`,
);
