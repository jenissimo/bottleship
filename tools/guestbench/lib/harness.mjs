/**
 * The guestbench runner: build a fixture into a multiboot image, run it under v86, and
 * report ms, retired instructions, a checksum, and whichever counters were asked for.
 *
 * Every fixture runs TWO passes over the SAME emitted loop, with the host notified at the
 * boundary. That is not a nicety: v86 promotes a page only after JIT_THRESHOLD retired
 * instructions, so a single-pass measurement is a blend of interpreted and compiled
 * execution whose ratio depends on the fixture's size. The measured window is pass two —
 * fully compiled, counters armed, clock started at the boundary — and the warm-up is
 * reported separately rather than averaged in. `warmupSharePct` near zero in the measured
 * window is what makes a comparison between two arms about the code and not about how long
 * each took to get hot.
 *
 * The CHECKSUM is the correctness oracle the roadmap requires of every perf fixture: two
 * arms that disagree on it did different work, and no timing comparison between them means
 * anything. It is read out of guest memory after the halt.
 *
 * Harness overhead inside the loop is fixed and declared: `dec edi` (one register ALU op)
 * and the back-edge `jnz` (one conditional direct branch) per iteration. EDI belongs to the
 * harness; fixtures own EAX/ECX/EDX/EBX/ESI, the EBP frame and the stack. The harness's own
 * memory slots (CHECKSUM, PASS_COUNTER) sit a page away from DATA so nothing a fixture
 * writes through EBP can reach them.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Asm, mem, abs, reg, EAX, EBP, EDI, ESP } from "./asm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
export const LIBV86 = resolve(REPO, "vendor/v86/build/libv86.mjs");

export const BASE = 0x100000;
export const ENTRY_OFF = 0x40;
export const IMG_SIZE = 0x40000;          // 256 KiB of image: code, then the data arena
export const DATA = BASE + 0x8000;        // EBP points here
export const ARENA = BASE + 0x10000;      // a fixture's own working set
export const ARENA_BYTES = IMG_SIZE - 0x10000;
export const CHECKSUM = BASE + 0x7000;
// The harness's own slots live next to the checksum, away from the frame the fixtures
// address through EBP, so a fixture's own stores cannot land on the pass counter.
export const PASS_COUNTER = BASE + 0x7010;
export const STACK_TOP = 0x200000;
export const MARK_PORT = 0x8888;

/** Everything a fixture is handed. */
function makeContext(params) {
    return {
        params,
        DATA, ARENA, ARENA_BYTES, CHECKSUM, BASE,
        /** `[CHECKSUM]` as an operand: the fixture stores its accumulator here in finish(). */
        checksum: abs(CHECKSUM),
        /** Absolute operand helper for addresses inside the image. */
        at: (addr) => abs(addr),
    };
}

/**
 * Build the image for one fixture.
 *
 * @param fixture { name, setup?, body, finish?, data?, perIteration? }
 * @param opts { iterations, params }
 */
export function buildFixtureImage(fixture, { iterations, params = {} }) {
    const buf = new Uint8Array(IMG_SIZE);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    const ctx = makeContext(params);
    if (fixture.data) fixture.data(dv, ctx);

    const a = new Asm(BASE + ENTRY_OFF);
    a.movImm(ESP, STACK_TOP);
    a.movImm(EBP, DATA);
    a.enableFpuAndSse();
    if (fixture.setup) fixture.setup(a, ctx);

    // Pass counter lives in memory: it is touched twice in the whole run, so it cannot
    // distort a census, and keeping it out of a register leaves EDI free for the hot loop.
    a.movMemImm(abs(PASS_COUNTER), 2);

    a.label("outer");
    a.movImm(EDI, iterations);
    a.label("inner");
    const innerAddr = a.addr;
    fixture.body(a, ctx);
    a.dec(reg(EDI));                       // harness overhead: 1 reg.alu
    // The back edge: rel8 when it reaches, rel32 otherwise. `branchy` deliberately emits a
    // multi-kilobyte body, and a fixed short branch would simply refuse to assemble it.
    if (a.addr + 2 - innerAddr <= 127) a.jccShort("nz", "inner");
    else a.jcc("nz", "inner");             // harness overhead: 1 branch.condDirect
    if (fixture.finish) fixture.finish(a, ctx);
    a.movImm(EAX, MARK_PORT);
    a.db(0x8b, 0xd0);                      // mov edx, eax
    a.outDxAl();                           // the warm-up boundary
    a.dec(abs(PASS_COUNTER));
    a.jcc("nz", "outer");
    a.hlt();
    a.label("hang");
    a.jmpShort("hang");

    // Callee stubs and other out-of-line code: emitted past the halt, reachable only
    // through a call the body makes.
    if (fixture.tail) fixture.tail(a, ctx);

    const code = a.link();
    if (ENTRY_OFF + code.length > DATA - BASE) {
        throw new Error(`fixture ${fixture.name} emitted ${code.length} bytes, past the data area`);
    }
    buf.set(code, ENTRY_OFF);
    // Data that has to name a code address (a vtable, a jump table) can only be written
    // once the labels are resolved.
    if (fixture.postLink) fixture.postLink(dv, ctx, a.labels);
    return buf;
}

const PREFIX_BYTES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]);

function readCensus(w) {
    const opcode = new Float64Array(0x2000);
    for (let op = 0; op < 0x100; op++) {
        for (let is0f = 0; is0f < 2; is0f++) {
            for (let isMem = 0; isMem < 2; isMem++) {
                for (let g = 0; g < 8; g++) {
                    opcode[(is0f << 12) | (op << 4) | (isMem << 3) | g] =
                        w.get_opstats_buffer(0, 0, 0, 0, op, is0f, isMem, g);
                }
            }
        }
    }
    const addr = new Float64Array(256);
    for (let i = 0; i < 256; i++) addr[i] = w.get_opstats_addr(i);
    const simd = new Float64Array(1024);
    for (let i = 0; i < 1024; i++) simd[i] = w.get_opstats_simd(i);
    return { opcode, addr, simd, prefixBytes: PREFIX_BYTES };
}

const DISPATCH_NAMES = [
    "blockExecution", "moduleReentry", "moduleExitChainable", "moduleExitDynamic",
    "moduleExitIndirect", "moduleChainedEdge", "moduleChainBudgetExit", "moduleChainMiss",
    "deadFlagCandidate", "deadFlagElided",
    "abseipDispatch", "retChainHit", "retChainMiss",
    "x87CacheHit", "x87CacheFill", "x87CacheInvalidate", "pushRunHit", "pushRunFill",
    "retMemoHit", "retMemoAlias", "retMemoCold", "retMetaHit", "retChainBudget",
    "readTlbCacheHit", "readTlbCacheFill",
];

function readDispatch(w) {
    const out = {};
    for (let i = 0; i < DISPATCH_NAMES.length; i++) out[DISPATCH_NAMES[i]] = Number(w.profiler_dispatch_stat_get(i));
    return out;
}

/** Where the dispatcher re-entered the guest (roadmap 07). Cumulative, never differenced:
 *  a direct-mapped table cannot be subtracted without losing which slot held what. */
function readEntryEip(w) {
    if (typeof w.entry_eip_census_slots !== "function") return null;
    const n = w.entry_eip_census_slots() >>> 0;
    const rows = [];
    for (let i = 0; i < n; i++) {
        const hits = Number(w.entry_eip_census_hits(i));
        if (hits > 0) rows.push({ eip: w.entry_eip_census_addr(i) >>> 0, hits });
    }
    rows.sort((a, b) => b.hits - a.hits);
    const samples = Number(w.entry_eip_census_samples());
    const evictions = Number(w.entry_eip_census_evictions());
    return { samples, evictions, evictionPct: samples ? +((evictions / samples) * 100).toFixed(2) : null, top: rows.slice(0, 12) };
}

const sub = (a, b) => {
    const o = {};
    for (const k of Object.keys(a)) o[k] = a[k] - b[k];
    return o;
};

/**
 * Run one fixture. Returns the MEASURED (second) pass: its wall time, retired count,
 * checksum, and any counters requested — plus the warm-up pass's numbers, so a reader can
 * see how much of the run was cold rather than having to assume.
 */
export async function runFixture(fixture, { iterations, params = {}, census = false, dispatch = false, timeoutMs = 300_000, jit = true, stackRaw = 0, permMap = false } = {}) {
    if (!existsSync(LIBV86)) throw new Error(`vendor/v86/build/libv86.mjs absent — run vendor/v86/build-wasm.sh`);
    const { V86 } = await import(LIBV86);
    const img = buildFixtureImage(fixture, { iterations, params });

    return await new Promise((res, rej) => {
        const emulator = new V86({
            autostart: false, memory_size: 32 * 1024 * 1024, log_level: 0,
            disable_jit: jit ? 0 : 1,
        });
        let timer, cpu, w;
        let markAt = null, markRetired = 0, markDispatch = null;
        const t0 = { ms: 0 };

        const finish = (status) => {
            clearTimeout(timer);
            const tEnd = performance.now();
            const retiredEnd = cpu.instruction_counter[0] >>> 0;
            const checksumBytes = emulator.read_memory(CHECKSUM, 4);
            const checksum = (checksumBytes[0] | (checksumBytes[1] << 8)
                | (checksumBytes[2] << 16) | (checksumBytes[3] << 24)) >>> 0;
            const out = {
                status,
                fixture: fixture.name,
                iterations, params,
                checksum,
                warmup: { ms: +(markAt - t0.ms).toFixed(3), retired: markRetired >>> 0 },
                measured: {
                    ms: +(tEnd - markAt).toFixed(3),
                    retired: ((retiredEnd - markRetired) >>> 0),
                },
                jit,
                stackRaw,
                permMap,
            };
            out.measured.nsPerInstruction = out.measured.retired > 0
                ? +((out.measured.ms * 1e6) / out.measured.retired).toFixed(3) : null;
            out.measured.nsPerIteration = +((out.measured.ms * 1e6) / iterations).toFixed(3);
            if (census) out.census = readCensus(w);
            if (dispatch) {
                out.dispatch = markDispatch ? sub(readDispatch(w), markDispatch) : readDispatch(w);
                out.entryEip = readEntryEip(w);
            }
            try { emulator.stop(); } catch { /* the run is over either way */ }
            res(out);
        };

        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu;
            w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            cpu.load_multiboot(img.buffer);
            if (census) { w.opstats_reset(); w.set_opstats(1); } else if (w.set_opstats) w.set_opstats(0);
            // The roadmap-02 ceiling experiment: ESP/EBP-relative 32-bit READS compiled with
            // no permission check at all. Unsound on purpose (see codegen.rs) and only ever
            // armed for a synthetic fixture — never for a game.
            // A requested mode the engine cannot set, or does not read back, would be
            // reported as ON while measuring the baseline.
            if (stackRaw && !w.set_stack_raw_unsafe) throw new Error("--stack-raw: this engine exports no set_stack_raw_unsafe");
            if (permMap && !w.set_perm_map_reads) throw new Error("--perm-map: this engine exports no set_perm_map_reads");
            if (w.set_stack_raw_unsafe) w.set_stack_raw_unsafe(stackRaw | 0);
            if (w.set_perm_map_reads) w.set_perm_map_reads(permMap ? 1 : 0);
            if (w.get_stack_raw_unsafe && (w.get_stack_raw_unsafe() >>> 0) !== ((stackRaw | 0) >>> 0)) {
                throw new Error(`--stack-raw ${stackRaw}: engine read back ${w.get_stack_raw_unsafe()}`);
            }
            if (w.get_perm_map_reads && (w.get_perm_map_reads() >>> 0) !== (permMap ? 1 : 0)) {
                throw new Error(`--perm-map: engine read back ${w.get_perm_map_reads()}`);
            }
            if (dispatch) {
                w.set_dispatch_stats(1);
                w.profiler_init();
                if (w.entry_eip_census_reset) w.entry_eip_census_reset();
            }
            cpu.io.register_write(MARK_PORT, cpu, () => {
                if (markAt !== null) return;         // only the first boundary
                markAt = performance.now();
                markRetired = cpu.instruction_counter[0] >>> 0;
                if (census) w.opstats_reset();
                if (dispatch) markDispatch = readDispatch(w);
            });
            timer = setTimeout(() => { markAt ??= performance.now(); finish("HANG"); }, timeoutMs);
            t0.ms = performance.now();
            try { emulator.run(); } catch (e) { clearTimeout(timer); rej(e); }
        });
    });
}

/** Roll a census snapshot up into class/addressing/simd tables using the TS classifier. */
export async function rollupCensus(census) {
    const { classifyOpcode, classGroup, classifyAddrKey, simdFamily } =
        await import(resolve(REPO, "src/worker/core/debug/guest-opcode-classes.ts"));
    const byClass = new Map(), byGroup = new Map(), byAddr = new Map(), bySimd = new Map();
    let counted = 0, memoryOps = 0, addrTotal = 0;
    for (let op = 0; op < 0x100; op++) {
        for (let is0f = 0; is0f < 2; is0f++) {
            if (!is0f && PREFIX_BYTES.has(op)) continue;
            for (let isMem = 0; isMem < 2; isMem++) {
                for (let g = 0; g < 8; g++) {
                    const n = census.opcode[(is0f << 12) | (op << 4) | (isMem << 3) | g];
                    if (!n) continue;
                    counted += n;
                    if (isMem) memoryOps += n;
                    const c = classifyOpcode({ opcode: op, is0f: !!is0f, isMem: !!isMem, fixedG: g });
                    byClass.set(c, (byClass.get(c) ?? 0) + n);
                    byGroup.set(classGroup(c), (byGroup.get(classGroup(c)) ?? 0) + n);
                }
            }
        }
    }
    for (let k = 0; k < 256; k++) {
        const n = census.addr[k];
        if (!n) continue;
        addrTotal += n;
        const f = classifyAddrKey(k);
        byAddr.set(f, (byAddr.get(f) ?? 0) + n);
    }
    for (let k = 0; k < 1024; k++) {
        const n = census.simd[k];
        if (!n) continue;
        const f = simdFamily(k);
        if (f === "other") continue;
        bySimd.set(f, (bySimd.get(f) ?? 0) + n);
    }
    return { counted, memoryOps, addrTotal, byClass, byGroup, byAddr, bySimd };
}

export { Asm, mem, abs, reg };
