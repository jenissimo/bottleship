/**
 * transitionCost — what one control transfer costs inside COMPILED guest code, by slope
 * (plan/v86-perf/PLAN.md §2e R2b).
 *
 * JIT modules are instantiated asynchronously (cpu.js codegen_finalize →
 * WebAssembly.instantiate), so a loop written and timed in the same harness turn never runs
 * compiled: its "floor" prices the interpreter plus a
 * cycle_internal per basic block. This verb is stateful instead: each call advances a shape
 * through write → warm (across turns, until every page it expects is published in
 * DISPATCH_META) → measure, and every row says which module each page landed in, so a
 * "cross-module" shape that the region former swallowed cannot be reported as one.
 *
 *   transitionCost({shape, stats?, n?, reps?, budget?}) → {state:'warming'|'measured', ...}
 *
 * `stats:true` compiles the shape with the DISPATCH_STATS increments and reports counter
 * deltas PER ITERATION (the label: how many module re-entries, AbsoluteEip dispatches, RET
 * chain hits one iteration performs). Timing rows use `stats:false` — the increments are code.
 * `budget:'open'` (default) lifts the hypercall cycle limit for the run: a harness turn sits
 * after a slice that already spent its budget, and every chain attempt would otherwise bail
 * to the dispatcher (RET_CHAIN_BUDGET), which is not the steady state inside a slice.
 * `cold:true` writes and times in one turn, nothing compiled (the interpreter floor).
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, proc, cpu as liveCpu, guestMem } from "../serialize";
import { preemptionManager } from "../../core/cpu/preemption-manager";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { writeGuestCode } from "../../core/memory/guest-code";
import { ThreadState } from "../../core/scheduler/types";
import { callGuestFunctionSync, writeSentinelBytes, type SyncCallEnv } from "../../core/hle-lib/sync-guest-call";
import { DISPATCH_STAT_NAMES } from "./dispatch";

type Seg = { at: number; bytes: number[] };
type ShapeCode = {
    entry: number;
    segs: Seg[];
    /** Pages that must be published before the shape counts as compiled. */
    pages: number[];
    /** Optional function that must be compiled FIRST, as its own module (a far callee). */
    prewarm?: { entry: number; page: number };
    /** Events per iteration (the divisor after the floor is subtracted). */
    k: number;
    data?: Array<{ at: number; u32: number }>;
    what: string;
};

const u32le = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/** Tiny assembler: absolute-address labels across several segments. */
class Asm {
    segs: Seg[] = [];
    cur!: Seg;
    labels = new Map<string, number>();
    fix: Array<{ seg: Seg; off: number; label: string; kind: "rel32" | "abs32" | "rel8" }> = [];
    org(at: number) { this.cur = { at, bytes: [] }; this.segs.push(this.cur); return this; }
    get pc() { return this.cur.at + this.cur.bytes.length; }
    l(name: string) { this.labels.set(name, this.pc); return this; }
    b(...xs: number[]) { this.cur.bytes.push(...xs); return this; }
    rel32(op: number[], label: string) { this.b(...op); this.fix.push({ seg: this.cur, off: this.cur.bytes.length, label, kind: "rel32" }); return this.b(0, 0, 0, 0); }
    rel8(op: number, label: string) { this.b(op); this.fix.push({ seg: this.cur, off: this.cur.bytes.length, label, kind: "rel8" }); return this.b(0); }
    abs32(op: number[], label: string) { this.b(...op); this.fix.push({ seg: this.cur, off: this.cur.bytes.length, label, kind: "abs32" }); return this.b(0, 0, 0, 0); }
    call(label: string) { return this.rel32([0xE8], label); }
    jmp(label: string) { return this.rel32([0xE9], label); }
    link(): Seg[] {
        for (const f of this.fix) {
            const t = this.labels.get(f.label);
            if (t === undefined) throw new Error(`label ${f.label}`);
            const end = f.seg.at + f.off + (f.kind === "rel8" ? 1 : 4);
            if (f.kind === "rel8") {
                const d = t - end;
                if (d < -128 || d > 127) throw new Error(`rel8 ${f.label} out of range`);
                f.seg.bytes[f.off] = d & 0xFF;
            } else {
                const v = f.kind === "abs32" ? t >>> 0 : (t - end) | 0;
                const bs = u32le(v);
                for (let i = 0; i < 4; i++) f.seg.bytes[f.off + i] = bs[i]!;
            }
        }
        return this.segs;
    }
}

/** push esi; push ebx; mov esi,[esp+12]; L: body; dec esi; jnz L; pop ebx; pop esi; ret */
function loop(a: Asm, body: (a: Asm) => void): void {
    a.l("entry").b(0x56, 0x53, 0x8B, 0x74, 0x24, 0x0C).l("L");
    body(a);
    a.b(0x4E).rel32([0x0F, 0x85], "L").b(0x5B, 0x5E, 0xC3);
}

const SHAPES = [
    "floor", "alu4", "jmpAdj4", "jmpZig3", "callSame4", "callSame8", "callPage4", "callFar4",
    "icallReg4", "icallMem4", "icallFar4", "ijmpTbl4", "pageCross", "jmpFar2", "stub4",
] as const;
type Shape = (typeof SHAPES)[number];

/** Each shape owns a 4-page group: P0 loop, P1 adjacent page, P3 far callee (own module). */
function buildShape(shape: Shape, g: number, dataPage: number, stubAddr = 0): ShapeCode {
    const P0 = g, P1 = g + 0x1000, P3 = g + 0x3000;
    const a = new Asm();
    let k = 1, what = "";
    const pages = [P0 >>> 12];
    let prewarm: ShapeCode["prewarm"];
    const data: Array<{ at: number; u32: number }> = [];
    /** A far callee `F` on P3 plus a driver `W` on the SAME page that calls it, so P3 gets
     *  hot and compiles as its own module before the main loop is ever run. */
    const far = () => {
        a.org(P3).l("F").b(0xC3).l("W").b(0x56, 0x8B, 0x74, 0x24, 0x08).l("WL").call("F").b(0x4E).rel32([0x0F, 0x85], "WL").b(0x5E, 0xC3);
        pages.push(P3 >>> 12);
        prewarm = { entry: 0, page: P3 >>> 12 };
    };
    switch (shape) {
        case "floor": what = "empty loop: dec esi; jnz"; a.org(P0); loop(a, () => {}); break;
        case "alu4": k = 4; what = "4x add eax,1 (per-instruction reference)"; a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.b(0x83, 0xC0, 0x01); }); break;
        case "jmpAdj4": k = 4; what = "4x jmp to the next instruction (same page)"; a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.b(0xEB, 0x00); }); break;
        case "jmpZig3": k = 3; what = "3 direct jmps zig-zagging (same page)";
            a.org(P0); loop(a, (x) => { x.rel8(0xEB, "A").l("B").rel8(0xEB, "C").l("A").rel8(0xEB, "B").l("C"); }); break;
        case "callSame4": k = 4; what = "4x call F; F: ret (same page, <=4 call sites: RET speculation)";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.call("F"); }); a.l("F").b(0xC3); break;
        case "callSame8": k = 8; what = "8x call F; F: ret (same page, 8 call sites > spec candidates)";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 8; i++) x.call("F"); }); a.l("F").b(0xC3); break;
        case "callPage4": k = 4; what = "4x call F; F: ret on the ADJACENT page";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.call("F"); }); a.org(P1 + 0x100).l("F").b(0xC3); pages.push(P1 >>> 12); break;
        case "callFar4": k = 4; what = "4x call F; F: ret in a separately compiled module";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.call("F"); }); far(); break;
        case "icallReg4": k = 4; what = "4x mov ebx,F; call ebx (same page)";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.abs32([0xBB], "F").b(0xFF, 0xD3); }); a.l("F").b(0xC3); break;
        case "icallMem4": k = 4; what = "4x call [vtbl] (same-page target, table on a data page)";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.b(0xFF, 0x15, ...u32le(dataPage + 0x10 * SHAPES.indexOf(shape))); }); a.l("F").b(0xC3); break;
        case "icallFar4": k = 4; what = "4x mov ebx,F; call ebx, F in a separately compiled module";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.abs32([0xBB], "F").b(0xFF, 0xD3); }); far(); break;
        case "ijmpTbl4": k = 1; what = "mov eax,esi; and eax,3; jmp [tbl+eax*4] -> 4 targets -> jmp join (same page)";
            a.org(P0); loop(a, (x) => {
                x.b(0x8B, 0xC6, 0x83, 0xE0, 0x03, 0xFF, 0x24, 0x85, ...u32le(dataPage + 0x10 * SHAPES.indexOf(shape)));
                for (let i = 0; i < 4; i++) x.l("T" + i).b(0x83, 0xC0, 0x01).jmp("J");
                x.l("J");
            }); break;
        case "stub4": k = 4; what = "4x call <WinAPI thunk stub> (OUT crossing from compiled code)";
            a.org(P0); loop(a, (x) => { for (let i = 0; i < 4; i++) x.call("S"); }); a.labels.set("S", stubAddr); break;
        case "jmpFar2": k = 2; what = "jmp X (separately compiled module); X: jmp back — two direct cross-module jumps";
            a.org(P0); loop(a, (x) => { x.jmp("X").l("B"); }); far(); a.l("X").jmp("B"); break;
        case "pageCross": what = "loop body straddles a page boundary (fallthrough into the next page)";
            // The loop head must sit outside the last 15 bytes of its page: an address there
            // is never registered as an entry point (is_near_end_of_page), so it never compiles.
            a.org(P1 - 0x40); loop(a, (x) => { for (let i = 0; i < 24; i++) x.b(0x83, 0xC0, 0x01); });
            pages[0] = (P1 - 0x40) >>> 12; pages.push(P1 >>> 12); break;
    }
    const segs = a.link();
    if (prewarm) prewarm.entry = a.labels.get("W")!;
    if (shape === "icallMem4") data.push({ at: dataPage + 0x10 * SHAPES.indexOf(shape), u32: a.labels.get("F")! });
    if (shape === "ijmpTbl4") for (let i = 0; i < 4; i++) data.push({ at: dataPage + 0x10 * SHAPES.indexOf(shape) + 4 * i, u32: a.labels.get("T" + i)! });
    return { entry: a.labels.get("entry")!, segs, pages, prewarm, k, data, what };
}

export type Exports = Record<string, (...a: number[]) => number>;
type State = { shape: Shape; stats: boolean; code: ShapeCode; stage: "far" | "main" | "ready"; turns: number; written: number };

let region = 0;
let sentinel = 0;
const states = new Map<string, State>();

function env(): { env: SyncCallEnv; ex: Exports; current: { id: number }; scheduler: any } {
    const d = proc()?.dispatcher;
    const c = liveCpu();
    const mem = toPlainGuestMemory(guestMem());
    const ex = preemptionManager.getWasmExports?.() as Exports | null;
    if (!d || !c || !mem || !ex?.run_guest_until) throw new HarnessError("transitionCost: no process / cpu / run_guest_until", HarnessErrorCode.NO_PROCESS);
    const scheduler = sys().scheduler as any;
    const current = scheduler.getCurrentThread();
    if (!current || current.state !== ThreadState.RUNNING) {
        throw new HarnessError("transitionCost: the current guest thread is not RUNNING (parked between slices) — retry", HarnessErrorCode.BAD_ARGS);
    }
    if (!sentinel) { sentinel = d.thunkGenerator.allocateRawCodeArea(64); writeSentinelBytes(mem, sentinel); }
    if (!region) region = proc().memory.alloc(SHAPES.length * 0x4000 + 0x1000, "HEAP", "rwx", 0x4000);
    const spin = d.spinLoopAddress as number;
    return {
        ex, current, scheduler,
        env: {
            cpu: c, mem, runGuestUntil: ex.run_guest_until as any, sentinelAddress: sentinel,
            abortLo: spin, abortHi: spin + 1,
            pin: () => scheduler.pinCurrentThread(), unpin: () => scheduler.unpinCurrentThread(),
        },
    };
}

/** DISPATCH_STAT_NAMES plus the probe-build census (indices 25..42; a shipping engine answers 0). */
export const R2_STAT_NAMES = [
    ...DISPATCH_STAT_NAMES, "permMapReadHit", "permMapReadMiss",
    "ciEntry", "ciCompiled", "ciInterp", "ciInterpInsns", "ciInterpNoMeta", "ciInterpNoEntry", "ciInterpNearEnd",
    "ciInterpState", "ciInterpTier2", "ciInterpAfterWalk", "exitNormal", "exitFault", "exitLoopSafety", "exitStale",
    "slices", "compiledInsns", "budgetLimit0", "budgetElapsed", "budgetHlt", "sliceEmpty", "rguCycles",
] as const;
const readCounters = (ex: Exports) => R2_STAT_NAMES.map((_, i) => Number(ex.profiler_dispatch_stat_get!(i)));
/** DISPATCH_META of a virtual page: null until a compiled module for it is published. */
export const metaOf = (ex: Exports, vpage: number) => {
    const lo = ex.jit_debug_meta_lo!(vpage) >>> 0;
    return lo === 0 && (ex.jit_debug_meta_hi!(vpage) >>> 0) === 0 ? null : { table: (lo >>> 16) & 0xFFFF, lo };
};

function transitionCost(opts: { shape: Shape; stub?: string; stats?: boolean; n?: number; reps?: number; budget?: "open" | "asIs"; cold?: boolean; reset?: boolean; targetMs?: number; holdMs?: number }) {
    if (sys().isPaused) throw new HarnessError("transitionCost: resume first", HarnessErrorCode.BAD_ARGS);
    if (!SHAPES.includes(opts.shape)) throw new HarnessError(`transitionCost: shape one of ${SHAPES.join(",")}`, HarnessErrorCode.BAD_ARGS);
    const { env: e, ex, current, scheduler } = env();
    const stats = !!opts.stats;
    const key = opts.shape === "stub4" ? `stub4:${opts.stub}` : opts.shape;
    let st = states.get(key);
    const wantStats = stats ? 1 : 0;
    const prevStats = ex.get_dispatch_stats!() >>> 0;
    if (!st || st.stats !== stats || opts.reset || opts.cold) {
        const g = region + SHAPES.indexOf(opts.shape) * 0x4000;
        const dataPage = region + SHAPES.length * 0x4000;
        let stubAddr = 0;
        if (opts.shape === "stub4") {
            const [dll, fn] = String(opts.stub ?? "kernel32:GetCurrentThreadId").split(":");
            const info = proc().dispatcher.getThunkStubInfo(dll, fn);
            if (!info) throw new HarnessError(`transitionCost: no stub ${opts.stub}`, HarnessErrorCode.BAD_ARGS);
            stubAddr = info.address;
        }
        const code = buildShape(opts.shape, g, dataPage, stubAddr);
        // DISPATCH_STATS is read at COMPILE time; set it before the pages can compile.
        ex.set_dispatch_stats!(wantStats);
        // Clear the whole 4-page group first so no stale entry points from another mode survive.
        writeGuestCode(e.mem, new Uint8Array(0x4000).fill(0xCC), g);
        for (const s of code.segs) writeGuestCode(e.mem, new Uint8Array(s.bytes), s.at);
        const view = new DataView(e.mem.buffer, e.mem.byteOffset, e.mem.byteLength);
        for (const d of code.data ?? []) view.setUint32(d.at, d.u32 >>> 0, true);
        st = { shape: opts.shape, stats, code, stage: code.prewarm ? "far" : "main", turns: 0, written: performance.now() };
        states.set(key, st);
    }
    const code = st.code;
    const limitBefore = preemptionManager.getCycleLimit();
    const open = (opts.budget ?? "open") === "open";
    const run = (entry: number, count: number) => {
        const t0 = performance.now();
        const r = callGuestFunctionSync(e, entry, [count], "cdecl", count * 64 + 100000);
        const ms = performance.now() - t0;
        if (scheduler.getCurrentThread()?.id !== current.id) throw new HarnessError("transitionCost: thread switched inside the loop", HarnessErrorCode.BAD_ARGS);
        if (!r.ok) throw new HarnessError(`transitionCost ${key}: guest loop failed (${r.reason})`, HarnessErrorCode.BAD_ARGS);
        return ms;
    };
    try {
        ex.set_dispatch_stats!(wantStats);
        if (open) (preemptionManager as any).setCycleLimit(0xFFFFFFFF);
        const pageMeta = () => code.pages.map((p) => ({ page: "0x" + (p << 12).toString(16), meta: metaOf(ex, p) }));
        if (!opts.cold) {
            st.turns++;
            if (st.stage === "far") {
                for (let i = 0; i < 4; i++) run(code.prewarm!.entry, 60000);
                if (metaOf(ex, code.prewarm!.page)) st.stage = "main";
                return { state: "warming", stage: st.stage, turns: st.turns, pages: pageMeta() };
            }
            if (st.stage === "main") {
                for (let i = 0; i < 4; i++) run(code.entry, 60000);
                if (code.pages.every((p) => metaOf(ex, p))) st.stage = "ready";
                if (st.stage !== "ready" && st.turns < 60) return { state: "warming", stage: st.stage, turns: st.turns, pages: pageMeta() };
                if (st.stage !== "ready") throw new HarnessError(`transitionCost ${key}: pages never compiled after ${st.turns} turns: ${JSON.stringify(pageMeta())}`, HarnessErrorCode.INTERNAL);
            }
        }
        if (opts.holdMs) {
            // Keep the worker inside this one compiled loop for holdMs, for a Chrome trace to
            // attribute: the only code on the thread for that window is the shape.
            const n = opts.n ?? 200000;
            const t0 = performance.now();
            let runs = 0;
            while (performance.now() - t0 < opts.holdMs) { run(code.entry, n); runs++; }
            const ms = performance.now() - t0;
            return { state: "measured", shape: key, hold: true, runs, n, ms, nsPerIter: (ms * 1e6) / (runs * n), pages: pageMeta() };
        }
        // Size N so t(2N) ≈ targetMs.
        const probe = run(code.entry, 2000);
        const target = opts.targetMs ?? 3;
        const n = opts.n ?? Math.max(2000, Math.min(2_000_000, Math.floor(2000 * (target / 2) / Math.max(probe, 0.01))));
        run(code.entry, n);
        const reps = Math.max(3, opts.reps ?? 9);
        const lo: number[] = [], hi: number[] = [];
        const c0 = readCounters(ex);
        const r0 = (liveCpu() as any).instruction_counter[0] >>> 0;
        let iters = 0;
        for (let i = 0; i < reps; i++) {
            if (i & 1) { hi.push(run(code.entry, 2 * n)); lo.push(run(code.entry, n)); }
            else { lo.push(run(code.entry, n)); hi.push(run(code.entry, 2 * n)); }
            iters += 3 * n;
        }
        const c1 = readCounters(ex);
        const r1 = (liveCpu() as any).instruction_counter[0] >>> 0;
        const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1]!;
        const pairs = lo.map((x, i) => +(((hi[i]! - x) * 1e6) / n).toFixed(2));
        const perIter: Record<string, number> = {};
        R2_STAT_NAMES.forEach((name, i) => {
            const d = c1[i]! - c0[i]!;
            if (d) perIter[name] = +(d / iters).toFixed(3);
        });
        return {
            state: "measured", shape: key, what: code.what, k: code.k, stats, cold: !!opts.cold, budget: open ? "open" : "asIs",
            n, reps, turns: st.turns,
            nsPerIter: +(((med(hi) - med(lo)) * 1e6) / n).toFixed(2),
            nsPerIterPairs: pairs,
            msLo: lo.map((x) => +x.toFixed(3)), msHi: hi.map((x) => +x.toFixed(3)),
            creditedInsnPerIter: +(((r1 - r0) >>> 0) / iters).toFixed(3),
            dispatchPerIter: stats ? perIter : undefined,
            pages: pageMeta(),
        };
    } finally {
        if (open && limitBefore >= 0) (preemptionManager as any).setCycleLimit(limitBefore);
        ex.set_dispatch_stats!(prevStats);
    }
}

export function registerTransitionCommands(svc: HarnessService): void {
    svc.register("transitionCost", (args) => transitionCost((args[0] ?? {}) as any));
    /** Raw read of every dispatch/census counter (probe builds carry indices 25..42). */
    svc.register("r2Counters", () => {
        const ex = preemptionManager.getWasmExports?.() as Exports | null;
        if (!ex?.profiler_dispatch_stat_get) throw new HarnessError("no profiler_dispatch_stat_get", HarnessErrorCode.NO_PROCESS);
        const o: Record<string, number> = {};
        R2_STAT_NAMES.forEach((n, i) => { o[n] = Number(ex.profiler_dispatch_stat_get!(i)); });
        return { counters: o, statsEnabled: ex.get_dispatch_stats!() >>> 0, atMs: performance.now(),
            serial: (sys().services?.render as { getPresentSerial?: () => number } | undefined)?.getPresentSerial?.() ?? 0 };
    });
}
