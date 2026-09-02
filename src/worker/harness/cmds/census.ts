/**
 * opcodeCensusArm / opcodeCensusMark / opcodeCensus — the retired-instruction class table
 * for the game actually being measured (docs/performance/sota-roadmap/10).
 *
 * Roadmap items 02, 03 and 05 pick their target by the share of an instruction class, so the
 * share must come from the live title rather than a proxy demo — and, the harder half, the
 * verb must be unable to answer plausibly when it cannot answer at all:
 *
 *   - the census is a RUNTIME switch in a shipping build, not a separate profiler
 *     artifact whose stub returns zeros (that stub is what made the last table unfalsifiable);
 *   - `opcodeCensusArm()` clears the JIT cache, so a report over an unwarmed window is
 *     refused rather than reported as a small census;
 *   - a zero census with a non-zero retired counter is an ERROR, never "no x87";
 *   - COVERAGE is reported against `cpu.instruction_counter`: the census only sees
 *     compiled code, and a table covering 30% of retired instructions is labelled as such.
 *
 * Every judgement about what an opcode MEANS lives in core/debug/guest-opcode-classes.ts
 * with its own test; this file only sums buckets.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { retiredDelta } from "./perf";
import { cpu } from "../serialize";
import { dbg } from "../../core/debug/dbg-commands";
import {
    classifyOpcode, classGroup, classifyAddrKey, simdFamily,
    type InstrClass, type AddrForm, type SimdFamily,
} from "../../core/debug/guest-opcode-classes";

const OPCODE_KEYS = 0x2000;
const ADDR_KEYS = 256;
const SIMD_KEYS = 1024;

/** The prefix bytes v86 counts at index `prefix<<4`, which would otherwise be
 *  double-counted as opcodes 0x26/0x2E/…/0xF3 with fixed_g 0. */
const PREFIX_BYTES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]);

type Exports = Record<string, ((...a: number[]) => number) | undefined>;

const exportsOf = (): Exports | null =>
    ((globalThis as { preemption?: { getWasmExports?: () => Exports | null } }).preemption?.getWasmExports?.() ?? null);

export interface CensusSnapshot {
    atMs: number;
    opcode: Float64Array;
    addr: Float64Array;
    simd: Float64Array;
    retiredCounter: number;
    enabled: number;
    armEpoch: number;
}

let armEpoch = 0;
let armedAtMs = -1;
let mark: CensusSnapshot | null = null;

export function readCensusSnapshot(): CensusSnapshot {
    const w = exportsOf();
    const getOp = w?.["get_opstats_buffer"];
    const getAddr = w?.["get_opstats_addr"];
    const getSimd = w?.["get_opstats_simd"];
    const getEnabled = w?.["get_opstats"];
    if (typeof getOp !== "function" || typeof getAddr !== "function"
        || typeof getSimd !== "function" || typeof getEnabled !== "function") {
        throw new HarnessError(
            "the loaded v86 has no runtime opcode census (get_opstats/get_opstats_addr/get_opstats_simd) — "
            + "rebuild vendor/v86 (build-wasm.sh)", HarnessErrorCode.INTERNAL);
    }
    const opcode = new Float64Array(OPCODE_KEYS);
    for (let op = 0; op < 0x100; op++) {
        for (let is0f = 0; is0f < 2; is0f++) {
            for (let isMem = 0; isMem < 2; isMem++) {
                for (let g = 0; g < 8; g++) {
                    const idx = (is0f << 12) | (op << 4) | (isMem << 3) | g;
                    opcode[idx] = Number(getOp(0, 0, 0, 0, op, is0f, isMem, g));
                }
            }
        }
    }
    const addr = new Float64Array(ADDR_KEYS);
    for (let i = 0; i < ADDR_KEYS; i++) addr[i] = Number(getAddr(i));
    const simd = new Float64Array(SIMD_KEYS);
    for (let i = 0; i < SIMD_KEYS; i++) simd[i] = Number(getSimd(i));
    const ic = (cpu() as { instruction_counter?: Int32Array } | null)?.instruction_counter;
    return {
        atMs: performance.now(), opcode, addr, simd,
        retiredCounter: ic ? ic[0]! >>> 0 : 0,
        enabled: getEnabled() >>> 0,
        armEpoch,
    };
}

export type CensusResult =
    | { ok: false; refuse: string; code: string }
    | { ok: true; report: Record<string, unknown> };

const round = (v: number, d = 2): number => +v.toFixed(d);
const share = (n: number, d: number): number | null => (d > 0 ? round((n / d) * 100, 2) : null);

/** Sorted descending by count, with tiny rows folded away. */
function table<K extends string>(counts: Map<K, number>, total: number): Array<{ name: K; n: number; pct: number | null }> {
    return [...counts.entries()]
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => ({ name, n, pct: share(n, total) }));
}

/**
 * The whole readout as a pure function of two snapshots. Kept free of globals so every
 * refusal — the point of the file — has a test.
 */
export function summarizeCensus(before: CensusSnapshot, after: CensusSnapshot): CensusResult {
    const windowMs = after.atMs - before.atMs;
    if (windowMs <= 0) {
        return { ok: false, code: HarnessErrorCode.BAD_ARGS, refuse: "census window is empty — mark and report in different turns" };
    }
    if (after.armEpoch !== before.armEpoch) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "opcodeCensusArm() ran inside the window: the buffers were zeroed mid-flight, so every count "
                + "below would be a fragment. Re-mark after arming.",
        };
    }
    if (after.enabled === 0 || before.enabled === 0) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "the census switch is off, so nothing was counting. A zero table here would read as "
                + "'this workload runs no x87 and no SSE'. Call opcodeCensusArm() BEFORE the workload — it clears "
                + "the JIT cache so hot code recompiles with the counters — then let the scene warm up.",
        };
    }

    const retired = retiredDelta(before.retiredCounter, after.retiredCounter);

    const byClass = new Map<InstrClass, number>();
    const byGroup = new Map<string, number>();
    let counted = 0, memoryOps = 0;
    for (let op = 0; op < 0x100; op++) {
        for (let is0f = 0; is0f < 2; is0f++) {
            // A prefix byte is recorded at prefix<<4 (= opcode<<4 with is_mem 0, g 0) on
            // the one-byte map; counting it as an opcode would double every prefixed
            // instruction. is0f rows are real opcodes and never collide with that.
            if (!is0f && PREFIX_BYTES.has(op)) continue;
            for (let isMem = 0; isMem < 2; isMem++) {
                for (let g = 0; g < 8; g++) {
                    const idx = (is0f << 12) | (op << 4) | (isMem << 3) | g;
                    const n = after.opcode[idx]! - before.opcode[idx]!;
                    if (n <= 0) continue;
                    counted += n;
                    if (isMem) memoryOps += n;
                    const c = classifyOpcode({ opcode: op, is0f: !!is0f, isMem: !!isMem, fixedG: g });
                    byClass.set(c, (byClass.get(c) ?? 0) + n);
                    const grp = classGroup(c);
                    byGroup.set(grp, (byGroup.get(grp) ?? 0) + n);
                }
            }
        }
    }

    if (counted === 0) {
        return {
            ok: false, code: HarnessErrorCode.INTERNAL,
            refuse: `the census counted 0 instructions while the guest retired ${retired}. The code that ran was `
                + "compiled before the arm cleared the cache, so it carries no counters. Arm, warm up, THEN mark.",
        };
    }

    const byAddr = new Map<AddrForm, number>();
    let addrTotal = 0;
    for (let k = 0; k < ADDR_KEYS; k++) {
        const n = after.addr[k]! - before.addr[k]!;
        if (n <= 0) continue;
        addrTotal += n;
        const f = classifyAddrKey(k);
        byAddr.set(f, (byAddr.get(f) ?? 0) + n);
    }

    const bySimd = new Map<SimdFamily, number>();
    let simdTotal = 0;
    for (let k = 0; k < SIMD_KEYS; k++) {
        const n = after.simd[k]! - before.simd[k]!;
        if (n <= 0) continue;
        const f = simdFamily(k);
        if (f === "other") continue;      // jcc/setcc/cpuid on the 0F map are not SIMD
        simdTotal += n;
        bySimd.set(f, (bySimd.get(f) ?? 0) + n);
    }

    // Two independently produced numbers that must agree: the opcode census counts every
    // instruction whose ModRM named a memory operand, and the addressing census counts
    // every such instruction's encoding. A mismatch means one of the two feeds is wrong,
    // and every share below it is unusable — so it is reported, not reconciled.
    const addrCrossCheckOk = addrTotal === memoryOps;

    return {
        ok: true,
        report: {
            armed: true,
            windowMs: round(windowMs),
            retired,
            counted,
            // The census only sees COMPILED code: interpreted instructions, and anything on
            // a page that had not been compiled when the arm cleared the cache, are absent.
            // A share below is a share of `counted`, never of all guest work.
            coveragePct: share(counted, retired),
            coverage: "shares are of the COUNTED total. The census instruments compiled blocks only, so "
                + "interpreted execution is absent, not zero; compare coveragePct against 100 before "
                + "treating a share as a share of all guest work.",
            // The denominator is not an exact instruction count. The JIT credits
            // `block.number_of_instructions` per block EXECUTION, and on the guestbench
            // fixtures that runs exactly one ahead per iteration on every single-block loop
            // (a five-instruction loop is credited six). So coveragePct reads a few percent
            // LOW on tight-loop workloads, and it is a floor rather than a measurement.
            coverageDenominator: "cpu.instruction_counter credits a block's instruction count per block "
                + "execution and measurably runs ~1 instruction per iteration ahead of a tight loop's real "
                + "length, so coveragePct is a floor, not an exact share.",

            groups: table(byGroup as Map<string, number>, counted),
            classes: table(byClass, counted),

            memory: {
                ops: memoryOps,
                pctOfCounted: share(memoryOps, counted),
                // Roadmap 02's ceiling: base ESP/EBP, constant displacement, no index.
                forms: table(byAddr, addrTotal),
                stackConstPctOfMemory: share(byAddr.get("stackConst") ?? 0, addrTotal),
                crossCheck: {
                    ok: addrCrossCheckOk,
                    addressingCensusTotal: addrTotal,
                    opcodeCensusMemoryOps: memoryOps,
                    note: addrCrossCheckOk
                        ? "the addressing census and the opcode census agree on how many memory operands ran"
                        : "MISMATCH: the two feeds disagree, so no share in this section is usable",
                },
            },

            simd: {
                total: simdTotal,
                pctOfCounted: share(simdTotal, counted),
                // MMX aliases the x87 stack; SSE does not. Rolling them together would
                // answer "how much SSE2" with a number containing MMX.
                families: table(bySimd, simdTotal),
            },

            x87: {
                total: byGroup.get("x87") ?? 0,
                pctOfCounted: share(byGroup.get("x87") ?? 0, counted),
                breakdown: table(
                    new Map([...byClass].filter(([c]) => c.startsWith("x87.")) as Array<[InstrClass, number]>),
                    byGroup.get("x87") ?? 0),
            },
        },
    };
}

export function registerCensusCommands(svc: HarnessService): void {
    /**
     * opcodeCensusArm() — switch census emission on, zero the buffers and clear the JIT
     * cache so hot code recompiles with the counters. Destructive to what follows it: the
     * scene must warm up again before opcodeCensusMark(). Census emission costs an
     * increment per retired instruction, so this measures SHARES, never the FPS of the
     * same window.
     */
    svc.register("opcodeCensusArm", (args) => {
        const on = (args[0] as { on?: boolean } | undefined)?.on ?? true;
        if (typeof exportsOf()?.["set_opstats"] !== "function") {
            throw new HarnessError("set_opstats missing — rebuild vendor/v86 (build-wasm.sh)", HarnessErrorCode.INTERNAL);
        }
        // Through dbg, not directly: the JIT cache clear has one owner (guest-code.ts's
        // ownership rule, with dbg-commands as the sanctioned debug knob), and this verb is
        // the windowing layer on top of it rather than a second copy of the switch.
        dbg.opStatsEnable(on);
        armEpoch++;
        armedAtMs = performance.now();
        return {
            armed: on, armEpoch,
            warning: "the JIT cache was cleared and the counters zeroed. Warm the scene up before "
                + "opcodeCensusMark(), or the report will refuse. The census slows the guest — read shares "
                + "from it, never FPS.",
        };
    });

    /** opcodeCensusMark() — window baseline. */
    svc.register("opcodeCensusMark", () => {
        mark = readCensusSnapshot();
        return {
            marked: true, atMs: round(mark.atMs), armEpoch: mark.armEpoch, enabled: mark.enabled,
            sinceArmMs: armedAtMs < 0 ? null : round(mark.atMs - armedAtMs),
        };
    });

    /** opcodeCensus() — the class table over the window since opcodeCensusMark(). */
    svc.register("opcodeCensus", () => {
        if (!mark) throw new HarnessError("opcodeCensus with no opcodeCensusMark", HarnessErrorCode.BAD_ARGS);
        const out = summarizeCensus(mark, readCensusSnapshot());
        if (!out.ok) throw new HarnessError(out.refuse, out.code);
        return out.report;
    });
}
