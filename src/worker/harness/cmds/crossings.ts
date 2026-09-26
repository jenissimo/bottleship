/**
 * crossingCensus / crossingCost — the guest→host boundary, counted and priced
 * (plan/v86-perf/PLAN.md H and R0: "crossings per frame by class, cost by slope").
 *
 * crossingCensus({phase:'arm'}) → drive → crossingCensus({phase:'read', top?}) reports, per
 * presented frame, every tier a guest call can take out of compiled code:
 *   - `hypercall`   OUT served inside WASM (per handler id, from the hypercall page);
 *   - `jsFast`      OUT dispatched to a JS fast-path handler (sync, no ThunkContext);
 *   - `jsSync`      OUT dispatched to the JS slow path, answered synchronously;
 *   - `jsAsync`     OUT dispatched to the JS slow path, thread parked on a Promise;
 *   - `callbackReturns` guest callbacks (WndProc, timer, enum procs) returning through the stub;
 *   - `wbuf`        Tier-0 ring ENTRIES (no crossing of their own; drained at the next OUT).
 * Hypercall `fellBack` calls reappear in the JS tiers, and a fast-path handler that declines
 * is counted as `fastFallthrough` and again in the slow tier — both are reported so no call
 * is silently counted twice. The ledger is exact (no sampling) and costs one array increment
 * per JS dispatch while armed; `armed:false` in a read means nothing was counted, not zero.
 *
 * crossingCost({calls:[{name:'kernel32:GetTickCount', args?:[..], cdecl?:bool}], n?, reps?, cold?})
 * prices each call from COMPILED guest code: a loop on its own heap page calls the stub N and
 * 2N times (callGuestFunctionSync, current thread, pinned) and ns/call is the SLOPE, so the
 * loop's fixed cost cancels. JIT modules are published asynchronously, so a loop written and
 * timed in one harness turn only ever runs interpreted; like transitionCost, the verb is
 * therefore stateful — each call warms the rows whose loop page is not yet in DISPATCH_META and
 * answers `state:'warming'` until every row can be measured compiled. The cycle limit is held
 * open for the runs: a harness turn follows a slice that spent its budget, and every chain
 * would otherwise bail to the dispatcher. Each row names its `loopTier` (compiled + module, or
 * interpreted) and which crossing tier the calls took (counter deltas), so a stub rewritten
 * into a guest-side answer cannot be reported as a crossing. `cold:true` is the old single-turn
 * measurement, labelled interpreted. `__guestRet` is a plain guest RET — the floor a crossing
 * is compared against. N keeps a run near 1 ms: a pin defers a switch for 8 ms at most, and a
 * switch inside the loop is reported as an error rather than priced. Refused while paused: a
 * trap taken under pause ends the slice.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, proc, cpu as liveCpu, guestMem } from "../serialize";
import { hypercallDataManager } from "../../core/cpu/hypercall-data";
import { preemptionManager } from "../../core/cpu/preemption-manager";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { writeGuestCode } from "../../core/memory/guest-code";
import { ThreadState } from "../../core/scheduler/types";
import { callGuestFunctionSync, writeSentinelBytes, type SyncCallEnv } from "../../core/hle-lib/sync-guest-call";
import { registerTransitionCommands, metaOf, type Exports } from "./transitions";

type Ledger = {
    slow: Uint32Array; async: Uint32Array; fastFallthrough: Uint32Array;
    callbackReturns: number; sehResults: number;
};

type Snapshot = {
    t: number; serial: number; fast: Uint32Array;
    slow: Uint32Array; async: Uint32Array; fastFallthrough: Uint32Array;
    callbackReturns: number; sehResults: number;
    hc: Map<number, { names: string[]; served: number; fellBack: number }>;
    realSwitch: number; ticks: number;
};

function dispatcher(): any {
    const d = proc()?.dispatcher;
    if (!d?.setCrossingLedgerEnabled) throw new HarnessError("no process / dispatcher lacks the crossing ledger", HarnessErrorCode.NO_PROCESS);
    return d;
}

function snapshot(d: any): Snapshot {
    const l = d.getCrossingLedger() as Ledger | null;
    if (!l) throw new HarnessError("crossing ledger is not armed — crossingCensus({phase:'arm'}) first", HarnessErrorCode.BAD_ARGS);
    const sched = sys().scheduler as unknown as { roundTripStats?: { realSwitch: number; ticks: number } };
    const hc = new Map<number, { names: string[]; served: number; fellBack: number }>();
    for (const h of hypercallDataManager.getHandlerReport()) hc.set(h.handlerId, { names: h.names, served: h.served, fellBack: h.fellBack });
    return {
        t: performance.now(),
        serial: (sys().services?.render as { getPresentSerial?: () => number } | undefined)?.getPresentSerial?.() ?? 0,
        fast: (d.fastPathCounts as Uint32Array).slice(),
        slow: l.slow.slice(), async: l.async.slice(), fastFallthrough: l.fastFallthrough.slice(),
        callbackReturns: l.callbackReturns, sehResults: l.sehResults,
        hc, realSwitch: sched.roundTripStats?.realSwitch ?? 0, ticks: sched.roundTripStats?.ticks ?? 0,
    };
}

let armed: Snapshot | null = null;

function read(d: any, top: number) {
    if (!armed) throw new HarnessError("no armed window — crossingCensus({phase:'arm'}) first", HarnessErrorCode.BAD_ARGS);
    const a = armed, b = snapshot(d);
    const frames = b.serial - a.serial;
    const per = (x: number) => frames > 0 ? +(x / frames).toFixed(2) : null;
    const names: string[] = d.namesTable;
    const rows: Array<{ name: string; fast: number; sync: number; async: number; fastFallthrough: number; total: number }> = [];
    let fastT = 0, syncT = 0, asyncT = 0, ftT = 0;
    for (let id = 0; id < b.fast.length; id++) {
        const fast = (b.fast[id]! - a.fast[id]!) >>> 0;
        const slow = (b.slow[id]! - a.slow[id]!) >>> 0;
        const asy = (b.async[id]! - a.async[id]!) >>> 0;
        const ft = (b.fastFallthrough[id]! - a.fastFallthrough[id]!) >>> 0;
        if (!fast && !slow) continue;
        // A declined fast path is one OUT, counted by both tiers: keep it in the slow tier only.
        const row = { name: names[id] || `thunk#${id}`, fast: fast - ft, sync: slow - asy, async: asy, fastFallthrough: ft, total: fast - ft + slow };
        rows.push(row);
        fastT += row.fast; syncT += row.sync; asyncT += row.async; ftT += ft;
    }
    rows.sort((x, y) => y.total - x.total);
    const hcRows = [...b.hc].map(([id, h]) => {
        const p = a.hc.get(id);
        return { handlerId: id, names: h.names.slice(0, 4), served: h.served - (p?.served ?? 0), fellBack: h.fellBack - (p?.fellBack ?? 0) };
    }).filter((h) => h.served || h.fellBack).sort((x, y) => y.served - x.served);
    const hcServed = hcRows.reduce((s, h) => s + h.served, 0);
    const wbuf = d.isWriteBufCensusEnabled() ? (d.getWriteBufCensus() as Array<{ name: string; count: number }>) : null;
    const wbufTotal = wbuf ? wbuf.reduce((s, r) => s + r.count, 0) : null;
    const callbackReturns = b.callbackReturns - a.callbackReturns;
    return {
        armed: true, windowMs: +(b.t - a.t).toFixed(1), frames,
        perFrame: {
            hypercallServed: per(hcServed), jsFast: per(fastT), jsSync: per(syncT), jsAsync: per(asyncT),
            fastFallthrough: per(ftT), callbackReturns: per(callbackReturns), sehResults: per(b.sehResults - a.sehResults),
            contextSwitches: per(b.realSwitch - a.realSwitch), wbufEntries: wbufTotal === null ? null : per(wbufTotal),
            outCrossings: per(hcServed + fastT + syncT + asyncT + callbackReturns + (b.sehResults - a.sehResults)),
        },
        thunks: rows.slice(0, top).map((r) => ({ ...r, perFrame: per(r.total) })),
        hypercalls: hcRows.slice(0, top).map((h) => ({ ...h, servedPerFrame: per(h.served) })),
        wbuf: wbuf ? wbuf.slice(0, top).map((r) => ({ ...r, perFrame: per(r.count) })) : { armed: false },
        note: frames > 0 ? undefined : "no presents in the window — per-frame figures are unavailable, not zero",
    };
}

type CostCall = { name: string; args?: number[]; cdecl?: boolean };

/** push esi; mov esi,[esp+8] (N, the loop's own cdecl arg); L: push args; call target; [add esp];
 *  dec esi; jnz L; pop esi; ret. N is an argument so the code is written once per target and the
 *  compiled block survives across both volumes. */
function emitLoop(at: number, target: number, args: number[], cdecl: boolean): Uint8Array {
    const b: number[] = [0x56, 0x8B, 0x74, 0x24, 0x08];
    const loop = b.length;
    for (let i = args.length - 1; i >= 0; i--) { const v = args[i]! >>> 0; b.push(0x68, v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, v >>> 24); }
    const rel = (target - (at + b.length + 5)) | 0;
    b.push(0xE8, rel & 0xFF, (rel >>> 8) & 0xFF, (rel >>> 16) & 0xFF, (rel >>> 24) & 0xFF);
    if (cdecl && args.length) b.push(0x83, 0xC4, args.length * 4);
    b.push(0x4E);
    const back = (loop - (b.length + 6)) | 0;
    b.push(0x0F, 0x85, back & 0xFF, (back >>> 8) & 0xFF, (back >>> 16) & 0xFF, (back >>> 24) & 0xFF);
    b.push(0x5E, 0xC3);
    return new Uint8Array(b);
}

let costArea = 0;
/** One heap page per call row: the thunk region is excluded from the JIT, and rewriting a
 *  shared page would discard the module the previous row just warmed. */
const loopPages = new Map<string, { page: number; written: boolean; turns: number }>();

function crossingCost(opts: { calls: CostCall[]; n?: number; reps?: number; cold?: boolean }) {
    if (sys().isPaused) throw new HarnessError("crossingCost: resume first — a trap taken under pause ends the slice", HarnessErrorCode.BAD_ARGS);
    const d = dispatcher();
    const c = liveCpu();
    const mem = toPlainGuestMemory(guestMem());
    const ex = preemptionManager.getWasmExports?.() as Exports | null;
    if (!c || !mem || !ex?.run_guest_until) throw new HarnessError("crossingCost: no cpu / memory / run_guest_until", HarnessErrorCode.NO_PROCESS);
    const gen = d.thunkGenerator;
    if (!costArea) {
        costArea = gen.allocateRawCodeArea(512);
        writeSentinelBytes(mem, costArea);
    }
    const scheduler = sys().scheduler as unknown as {
        pinCurrentThread(): void; unpinCurrentThread(): void; getCurrentThread(): { id: number; state: number } | null;
    };
    const current = scheduler.getCurrentThread();
    // Between slices the register file may belong to a thread that just parked; its pin does
    // not defer a switch, and a switch inside the loop runs another thread's code to a spin.
    if (!current || current.state !== ThreadState.RUNNING) {
        throw new HarnessError("crossingCost: the current guest thread is not RUNNING (parked between slices) — retry", HarnessErrorCode.BAD_ARGS);
    }
    const spin = d.spinLoopAddress as number;
    const env: SyncCallEnv = {
        cpu: c, mem, runGuestUntil: ex.run_guest_until as unknown as SyncCallEnv["runGuestUntil"], sentinelAddress: costArea,
        // The only stubs the loop may enter are the target's; landing on the park address means
        // the scheduler switched away inside the loop, which must be an error, not a spin.
        abortLo: spin, abortHi: spin + 1,
        pin: () => scheduler.pinCurrentThread(), unpin: () => scheduler.unpinCurrentThread(),
    };
    const nCap = Math.max(500, opts.n ?? 20000), reps = Math.max(2, opts.reps ?? 5);
    const hcTotal = () => hypercallDataManager.getHandlerReport().reduce((s, h) => s + h.served, 0);
    const had = !!d.getCrossingLedger();
    if (!had) d.setCrossingLedgerEnabled(true);
    const pm = preemptionManager as unknown as { setCycleLimit(v: number): void };
    const limitBefore = preemptionManager.getCycleLimit();
    pm.setCycleLimit(0xFFFFFFFF);
    const out: unknown[] = [];
    let warming = 0;
    try {
        for (const call of opts.calls) {
            const args = call.args ?? [];
            const key = `${call.name}/${args.join(",")}/${call.cdecl ? "c" : "s"}`;
            let lp = loopPages.get(key);
            if (!lp) { lp = { page: proc().memory.alloc(4096, "HEAP", "rwx", 4096), written: false, turns: 0 }; loopPages.set(key, lp); }
            const loopAt = lp.page, retStub = lp.page + 0x800;
            let target: number;
            let functionId = -1;
            if (call.name === "__guestRet") {
                target = retStub;
            } else {
                const [dll, fn] = call.name.split(":");
                const info = d.getThunkStubInfo(dll, fn);
                if (!info) { out.push({ name: call.name, error: "no stub" }); continue; }
                target = info.address; functionId = info.functionId;
            }
            if (!lp.written || opts.cold) {
                if (call.name === "__guestRet") {
                    const pop = call.cdecl ? 0 : args.length * 4;
                    writeGuestCode(mem, pop ? new Uint8Array([0xC2, pop & 0xFF, pop >>> 8]) : new Uint8Array([0xC3]), retStub);
                }
                const written = writeGuestCode(mem, emitLoop(loopAt, target, args, !!call.cdecl), loopAt);
                if (!written) throw new HarnessError("crossingCost: loop write refused", HarnessErrorCode.BAD_ARGS);
                lp.written = true; lp.turns = 0;
            }
            const run = (count: number) => {
                const t0 = performance.now();
                const r = callGuestFunctionSync(env, loopAt, [count], "cdecl", count * 256 + 100000);
                const ms = performance.now() - t0;
                if (scheduler.getCurrentThread()?.id !== current.id) {
                    throw new HarnessError(`crossingCost ${call.name}: the scheduler switched threads inside the loop — guest state is suspect, reload`, HarnessErrorCode.BAD_ARGS);
                }
                if (!r.ok) throw new HarnessError(`crossingCost ${call.name}: guest loop failed (${r.reason})`, HarnessErrorCode.BAD_ARGS);
                return ms;
            };
            const loopMeta = () => metaOf(ex, loopAt >>> 12);
            if (!opts.cold && !loopMeta()) {
                // Hot enough to compile; the module is instantiated after this turn returns.
                for (let i = 0; i < 4; i++) run(20000);
                if (++lp.turns >= 60) throw new HarnessError(`crossingCost ${call.name}: loop page never compiled after ${lp.turns} turns`, HarnessErrorCode.INTERNAL);
                out.push({ name: call.name, state: "warming", turns: lp.turns });
                warming++;
                continue;
            }
            // A pinned thread keeps the CPU for PIN_STARVATION_MAX_MS (8 ms) at most, so size the
            // volumes to keep the 2N run near 2 ms.
            const probe = run(500);
            const n = Math.max(200, Math.min(nCap, Math.floor(1.0 / Math.max(probe / 500, 1e-5))));
            run(n);
            const l = d.getCrossingLedger() as Ledger;
            const before = { fast: functionId >= 0 ? d.fastPathCounts[functionId] : 0, slow: functionId >= 0 ? l.slow[functionId]! : 0, hc: hcTotal() };
            const lo: number[] = [], hi: number[] = [];
            for (let i = 0; i < reps; i++) {
                if (i & 1) { hi.push(run(2 * n)); lo.push(run(n)); } else { lo.push(run(n)); hi.push(run(2 * n)); }
            }
            const calls = reps * 3 * n;
            const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1]!;
            const slopes = lo.map((x, i) => (hi[i]! - x) * 1e6 / n);
            // Read after the runs: a page evicted mid-row must not be reported as compiled.
            const meta = loopMeta();
            out.push({
                name: call.name, state: "measured", functionId, n, reps,
                loopTier: meta ? { tier: "compiled", module: meta.table } : { tier: "interpreted" },
                nsPerCall: +((med(hi) - med(lo)) * 1e6 / n).toFixed(1),
                nsPerCallPairs: slopes.map((s) => +s.toFixed(1)),
                msLo: lo.map((x) => +x.toFixed(2)), msHi: hi.map((x) => +x.toFixed(2)),
                // Which tier the loop's calls actually took, per call; 1.0 in exactly one column.
                tier: {
                    hypercall: +((hcTotal() - before.hc) / calls).toFixed(3),
                    jsFast: functionId >= 0 ? +((d.fastPathCounts[functionId] - before.fast) / calls).toFixed(3) : 0,
                    jsSlow: functionId >= 0 ? +((l.slow[functionId]! - before.slow) / calls).toFixed(3) : 0,
                },
            });
        }
    } finally {
        if (limitBefore >= 0) pm.setCycleLimit(limitBefore);
        if (!had) d.setCrossingLedgerEnabled(false);
    }
    return {
        state: warming ? "warming" : "measured", rows: out,
        note: "ns/call is (median t(2N) - median t(N)) / N in the loop tier each row names; `tier` fractions "
            + "near 0 in every column mean the call never left the guest. Call again while state is 'warming'.",
    };
}

export function registerCrossingCommands(svc: HarnessService): void {
    svc.register("crossingCensus", (args) => {
        const opts = (args[0] ?? {}) as { phase?: "arm" | "read" | "off"; top?: number; wbuf?: boolean };
        const d = dispatcher();
        if (opts.phase === "off") { d.setCrossingLedgerEnabled(false); armed = null; return { armed: false }; }
        if (opts.phase === "arm") {
            d.setCrossingLedgerEnabled(true);
            if (opts.wbuf !== false) { d.setWriteBufCensusEnabled(true); d.resetWriteBufCensus(); }
            armed = snapshot(d);
            return { armed: true, serial: armed.serial, wbuf: d.isWriteBufCensusEnabled() };
        }
        return read(d, opts.top ?? 30);
    });
    svc.register("crossingCost", (args) => crossingCost((args[0] ?? { calls: [] }) as { calls: CostCall[]; n?: number; reps?: number; cold?: boolean }));
    registerTransitionCommands(svc);
}
