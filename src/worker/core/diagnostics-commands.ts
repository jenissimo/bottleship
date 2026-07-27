/**
 * Diagnostics Commands - Console API for frame variance diagnostics
 *
 * Expose frame variance diagnostics controls to browser console for interactive debugging.
 *
 * Usage:
 *   frameDiagnostics.start()  - Enable diagnostics
 *   frameDiagnostics.stop()   - Disable diagnostics
 *   frameDiagnostics.summary() - Log summary to console
 *   frameDiagnostics.data()   - Get snapshot data
 *   frameDiagnostics.reset()  - Reset all captured data
 */

import { frameVarianceDiagnostics } from './frame-variance-diagnostics';
import { invalidateGuestCode, writeGuestCode } from './memory/guest-code';
import { framePacer } from './frame-pacer';
import { frameProfiler } from './frame-profiler';
import { drawCostProfiler } from '../backends/webgpu/ddraw/draw-cost-profiler';
import { Logger, LogCategory } from './logger';
import { System } from './system';
import { debugSession, watchThunk } from './debug/debug-session';
import type { DebugSessionConfig } from './debug/debug-session';
import { getMemory } from './thunking/thunk-utils';

const THREAD_STATE_LABEL: Record<number, string> = {
    0: 'CREATED',
    1: 'READY',
    2: 'RUNNING',
    3: 'WAITING',
    4: 'SUSPENDED',
    5: 'TERMINATED',
};

const WAIT_REASON_LABEL: Record<number, string> = {
    0: 'NONE',
    1: 'SLEEP',
    2: 'SINGLE_OBJECT',
    3: 'MULTIPLE_OBJECTS',
    4: 'MESSAGE',
    5: 'CRITICAL_SECTION',
    6: 'ASYNC_THUNK',
};

function describeKernelHandle(handle: number, threads?: Map<number, any>): string {
    const resourceProvider = System.getInstance().resourceProvider as any;
    const obj = resourceProvider?.getKernelObject?.(handle);
    if (!obj) return 'invalid';

    switch (obj.kind) {
        case 'event':
            return `event(sig=${obj.signaled ? 1 : 0},manual=${obj.manualReset ? 1 : 0})`;
        case 'mutex':
            return `mutex(owner=${obj.ownerThreadId ?? 0},rec=${obj.recursion ?? 0})`;
        case 'semaphore':
            return `semaphore(count=${obj.count ?? 0},max=${obj.max ?? 0})`;
        case 'thread': {
            const tid = obj.threadId ?? 0;
            const t = threads?.get(tid);
            const stateName = t ? THREAD_STATE_LABEL[t.state] ?? `UNKNOWN(${t.state})` : 'MISSING';
            return `thread(T${tid},${stateName})`;
        }
        default:
            return String(obj.kind ?? 'unknown');
    }
}

export const frameDiagnostics = {
    /**
     * Enable frame variance diagnostics.
     * This will start capturing frame time distribution, idle breakdowns, and event correlations.
     */
    start(): void {
        if (frameVarianceDiagnostics.isEnabled()) {
            console.log('[FrameVariance] Diagnostics already enabled');
            return;
        }
        frameVarianceDiagnostics.setEnabled(true);
        console.log('[FrameVariance] Diagnostics ENABLED - capturing frame data...');
        console.log('Run frameDiagnostics.summary() to see results');
    },

    /**
     * Disable frame variance diagnostics.
     */
    stop(): void {
        if (!frameVarianceDiagnostics.isEnabled()) {
            console.log('[FrameVariance] Diagnostics already disabled');
            return;
        }
        frameVarianceDiagnostics.setEnabled(false);
        console.log('[FrameVariance] Diagnostics DISABLED');
    },

    /**
     * Log comprehensive summary to console.
     */
    summary(): void {
        if (!frameVarianceDiagnostics.isEnabled()) {
            console.warn('[FrameVariance] Diagnostics not enabled. Run frameDiagnostics.start() first.');
            return;
        }
        frameVarianceDiagnostics.logSummary();
    },

    /**
     * Get snapshot data (programmatic access).
     */
    data() {
        return frameVarianceDiagnostics.getSnapshot();
    },

    /**
     * Reset all captured data (keeps diagnostics enabled).
     */
    reset(): void {
        frameVarianceDiagnostics.reset();
        console.log('[FrameVariance] Data reset');
    },

    /**
     * Quick workflow: enable, wait for captures, show summary.
     */
    async capture(durationMs: number = 10000): Promise<void> {
        console.log(`[FrameVariance] Capturing for ${(durationMs / 1000).toFixed(1)}s...`);
        this.reset();
        this.start();

        return new Promise((resolve) => {
            setTimeout(() => {
                this.summary();
                this.stop();
                console.log('[FrameVariance] Capture complete');
                resolve();
            }, durationMs);
        });
    },
};

/**
 * Dump all thread states — shows EIP, ESP, wait reason, handles, and timeout info.
 * Usage: dumpThreads() in browser DevTools console (worker context).
 */
function dumpThreads(): void {
    const system = System.getInstance();
    const sched = system.scheduler;
    if (!sched) { console.warn('No scheduler'); return; }
    const snapshot = (sched as any).getThreadStoreSnapshot?.();
    if (snapshot && Array.isArray(snapshot.entries) && snapshot.entries.length > 0) {
        const rows = snapshot.entries.map((t: any) => ({
            id: t.threadId,
            current: snapshot.currentThreadId === t.threadId ? 1 : 0,
            state: `${t.state}(${THREAD_STATE_LABEL[t.state] ?? `UNKNOWN(${t.state})`})`,
            priority: t.priority,
            suspendCount: t.suspendCount,
            pinCount: t.pinCount,
            waitReason: `${t.waitReason}(${WAIT_REASON_LABEL[t.waitReason] ?? `UNKNOWN(${t.waitReason})`})`,
            timeoutAt: t.waitTimeoutAt || null,
            teb: `0x${(t.tebAddress >>> 0).toString(16)}`,
            lastError: `0x${(t.lastError >>> 0).toString(16)}`,
            stackBase: `0x${(t.stackBase >>> 0).toString(16)}`,
            stackTop: `0x${(t.stackTop >>> 0).toString(16)}`,
            entry: `0x${(t.startAddress >>> 0).toString(16)}`,
            param: `0x${(t.parameter >>> 0).toString(16)}`,
        }));
        console.log('[dumpThreads][JSON] ' + JSON.stringify(rows));
        console.table(rows);
        return;
    }
    const threads = (sched as any).threads as Map<number, any>;
    if (!threads || threads.size === 0) {
        console.warn('[dumpThreads] No threads found (game not running?)');
        return;
    }
    const cpu = system.process?.v86?.cpu || system.process?.v86?.v86?.cpu;
    const currentThreadId = ((sched as any).currentThreadId ?? null) as number | null;
    const rows = [];
    for (const [id, t] of threads) {
        const waitMs = t.waitInfo?.timeoutAt != null
            ? Math.round(t.waitInfo.timeoutAt - (sched as any).timeService.nowMs())
            : null;
        const waitReason = t.waitInfo?.reason;
        const waitHandles = (t.waitInfo?.handles ?? []) as number[];
        const stateName = THREAD_STATE_LABEL[t.state] ?? `UNKNOWN(${t.state})`;
        const waitReasonName = waitReason != null
            ? WAIT_REASON_LABEL[waitReason] ?? `UNKNOWN(${waitReason})`
            : '-';
        const isCpuOwner = currentThreadId === id && !!cpu;
        const eip = isCpuOwner
            ? `0x${(cpu.instruction_pointer?.[0] >>> 0).toString(16)}`
            : (t.context?.eip != null ? '0x' + t.context.eip.toString(16) : '(running)');
        const esp = isCpuOwner
            ? `0x${(cpu.reg32?.[4] >>> 0).toString(16)}`
            : (t.context?.esp != null ? '0x' + t.context.esp.toString(16) : '(running)');
        rows.push({
            id,
            handle: t.handle != null ? '0x' + (t.handle >>> 0).toString(16) : '-',
            current: currentThreadId === id ? 1 : 0,
            state: `${t.state}(${stateName})`,
            eip,
            esp,
            waitReason: waitReason != null ? `${waitReason}(${waitReasonName})` : '-',
            handles: waitHandles.map((h: number) => '0x' + h.toString(16)).join(',') ?? '-',
            waitObjects: waitHandles.length > 0
                ? waitHandles.map((h: number) => `0x${h.toString(16)}:${describeKernelHandle(h, threads)}`).join(' | ')
                : '-',
            timeoutRemainingMs: waitMs,
            quantumMs: Math.round(performance.now() - (t.lastSwitchTime ?? 0)),
        });
    }
    console.log('[dumpThreads][JSON] ' + JSON.stringify(rows));
    console.table(rows);
}

/**
 * Dump one kernel handle with decoded type and state.
 * Usage: dumpHandle(0x30470)
 */
function dumpHandle(handleInput: number | string): void {
    let handle: number;
    if (typeof handleInput === 'string') {
        const parsed = Number(handleInput);
        if (!Number.isFinite(parsed)) {
            console.warn(`[dumpHandle] Invalid handle: ${handleInput}`);
            return;
        }
        handle = parsed >>> 0;
    } else {
        handle = handleInput >>> 0;
    }

    const system = System.getInstance();
    const resourceProvider = system.resourceProvider as any;
    const sched = system.scheduler as any;
    const threads = sched?.threads as Map<number, any> | undefined;
    const obj = resourceProvider?.getKernelObject?.(handle);

    if (!obj) {
        console.warn(`[dumpHandle] 0x${handle.toString(16)} not found`);
        return;
    }

    console.log(`[dumpHandle] 0x${handle.toString(16)} => ${describeKernelHandle(handle, threads)}`);
    console.log(obj);

    if (obj.kind === 'thread' && threads) {
        const tid = obj.threadId;
        const t = threads.get(tid);
        if (t) {
            const waitReason = t.waitInfo?.reason;
            console.table([{
                threadId: tid,
                handle: '0x' + handle.toString(16),
                state: `${t.state}(${THREAD_STATE_LABEL[t.state] ?? `UNKNOWN(${t.state})`})`,
                eip: t.context?.eip != null ? '0x' + t.context.eip.toString(16) : '(running)',
                esp: t.context?.esp != null ? '0x' + t.context.esp.toString(16) : '(running)',
                waitReason: waitReason != null
                    ? `${waitReason}(${WAIT_REASON_LABEL[waitReason] ?? `UNKNOWN(${waitReason})`})`
                    : '-',
                waitsOn: (t.waitInfo?.handles ?? []).map((h: number) => '0x' + h.toString(16)).join(',') || '-',
            }]);
        }
    }
}

/**
 * Force-signal an event handle for triage.
 * Usage: signalEvent(0x30470)
 */
function signalEvent(handleInput: number | string): void {
    let handle: number;
    if (typeof handleInput === 'string') {
        const parsed = Number(handleInput);
        if (!Number.isFinite(parsed)) {
            console.warn(`[signalEvent] Invalid handle: ${handleInput}`);
            return;
        }
        handle = parsed >>> 0;
    } else {
        handle = handleInput >>> 0;
    }

    const sched = System.getInstance().scheduler as any;
    if (!sched?.setEvent) {
        console.warn('[signalEvent] No scheduler/setEvent');
        return;
    }
    const ok = !!sched.setEvent(handle);
    console.log(`[signalEvent] handle=0x${handle.toString(16)} => ${ok ? 'signaled' : 'failed'}`);
}

/**
 * Force-reset an event handle for triage.
 * Usage: resetEventDiag(0x30470)
 */
function resetEventDiag(handleInput: number | string): void {
    let handle: number;
    if (typeof handleInput === 'string') {
        const parsed = Number(handleInput);
        if (!Number.isFinite(parsed)) {
            console.warn(`[resetEventDiag] Invalid handle: ${handleInput}`);
            return;
        }
        handle = parsed >>> 0;
    } else {
        handle = handleInput >>> 0;
    }

    const sched = System.getInstance().scheduler as any;
    if (!sched?.resetEvent) {
        console.warn('[resetEventDiag] No scheduler/resetEvent');
        return;
    }
    const ok = !!sched.resetEvent(handle);
    console.log(`[resetEventDiag] handle=0x${handle.toString(16)} => ${ok ? 'reset' : 'failed'}`);
}

/**
 * Dump critical section state — shows all CS addresses, their waiters, and who owns them.
 * Usage: dumpCSState() in browser DevTools console (worker context).
 */
function dumpCSState(): void {
    const sched = System.getInstance().scheduler;
    if (!sched) { console.warn('No scheduler'); return; }
    const waitEngine = (sched as any).waitEngine;
    const addressWaiters = (waitEngine?.addressWaiters ?? (sched as any).addressWaiters) as Map<number, number[]> | undefined;
    const threads = (sched as any).threads as Map<number, any>;
    const process = System.getInstance().process;
    const mem: Uint8Array | null = process?.getCurrentMemory?.() ?? null;

    if (!addressWaiters || addressWaiters.size === 0) {
        // Also check threads directly for CS wait info
        let csWaiters = 0;
        if (threads) {
            for (const [id, t] of threads) {
                if (t.waitInfo?.reason === 4 /* CRITICAL_SECTION */ && t.waitInfo?.csAddress) {
                    const addr = t.waitInfo.csAddress;
                    let ownerStr = '?';
                    if (mem && addr + 16 <= mem.length) {
                        const ownerId = (mem[addr + 12] | (mem[addr + 13] << 8) | (mem[addr + 14] << 16) | (mem[addr + 15] << 24)) >>> 0;
                        const ownerThread = threads.get(ownerId);
                        ownerStr = ownerThread
                            ? `T${ownerId}(${THREAD_STATE_LABEL[ownerThread.state] ?? ownerThread.state})`
                            : `T${ownerId}(NOT_FOUND)`;
                    }
                    console.log(`[dumpCSState] T${id} waiting on CS@0x${addr.toString(16)}, owner=${ownerStr}`);
                    csWaiters++;
                }
            }
        }
        if (csWaiters === 0) {
            console.log('[dumpCSState] No critical section waiters (no contention)');
        }
        return;
    }

    const rows = [];
    for (const [addr, waiters] of addressWaiters) {
        let lockCount = '?', recursionCount = '?', ownerId: number | string = '?', ownerState = '?';
        if (mem && addr + 16 <= mem.length) {
            lockCount = String(mem[addr + 4] | (mem[addr + 5] << 8) | (mem[addr + 6] << 16) | (mem[addr + 7] << 24));
            recursionCount = String(mem[addr + 8] | (mem[addr + 9] << 8) | (mem[addr + 10] << 16) | (mem[addr + 11] << 24));
            ownerId = (mem[addr + 12] | (mem[addr + 13] << 8) | (mem[addr + 14] << 16) | (mem[addr + 15] << 24)) >>> 0;
            const ownerThread = threads?.get(ownerId);
            ownerState = ownerThread ? `${ownerThread.state}(${ownerThread.waitInfo?.reason ?? '-'})` : `T${ownerId} NOT FOUND`;
        }
        rows.push({
            csAddr: '0x' + addr.toString(16),
            lockCount,
            recursionCount,
            ownerId: typeof ownerId === 'number' ? `T${ownerId}` : ownerId,
            ownerState,
            waiters: waiters.map(id => `T${id}`).join(','),
        });
    }
    console.table(rows);
}

/**
 * Slow-path thunk report — returns top functions that miss the fast-path table.
 * Usage: slowPathReport() in browser DevTools console (worker context).
 * Requires slowPathProfile(true) to be called first — collection is off by default
 * to avoid per-call Map.set overhead on hot slow-path thunks.
 */
function slowPathReport(): void {
    const dispatcher = System.getInstance().process?.dispatcher;
    if (!dispatcher) {
        console.warn('[SlowPath] No dispatcher available (game not running?)');
        return;
    }
    const report = (dispatcher as any).getSlowPathReport?.() as Array<{ name: string; hits: number }> | undefined;
    if (!report || report.length === 0) {
        console.log('[SlowPath] No hits recorded. Call slowPathProfile(true), run the game, then slowPathReport() again.');
        return;
    }
    console.table(report.slice(0, 20));
}

/**
 * Async-park telemetry — ranks which async thunk drives the worker idle, with a
 * park-duration histogram and per-thread split. Headline idle-classification tool.
 * Usage: asyncParkReport() — call asyncParkReset() first to scope a clean window.
 */
function asyncParkReport(): void {
    const dispatcher = System.getInstance().process?.dispatcher as any;
    if (!dispatcher?.getAsyncParkReport) {
        console.warn('[AsyncPark] No dispatcher available (game not running?)');
        return;
    }
    const rep = dispatcher.getAsyncParkReport() as {
        windowMs: number;
        rows: Array<{ name: string; count: number; totalMs: number; avgMs: number; maxMs: number;
            pctOfWindow: string; buckets: any; byTid: Array<{ tid: number; count: number; totalMs: number }> }>;
    };
    if (!rep.rows.length) {
        console.log('[AsyncPark] No async parks recorded yet. Run the game, then asyncParkReport().');
        return;
    }
    console.log(`[AsyncPark] window=${rep.windowMs}ms — total parked wall-clock per async thunk:`);
    console.log('[AsyncPark][JSON] ' + JSON.stringify(rep));
    console.table(rep.rows.map(r => ({
        thunk: r.name, parks: r.count, totalMs: r.totalMs, pctWall: r.pctOfWindow,
        avgMs: r.avgMs, maxMs: r.maxMs,
        hist: `≤1:${r.buckets.le1} ≤5:${r.buckets.le5} ≤16:${r.buckets.le16} ≤50:${r.buckets.le50} >50:${r.buckets.gt50}`,
        byTid: r.byTid.map(t => `T${t.tid}:${t.totalMs}ms/${t.count}`).join(' '),
    })));
}

/** Reset async-park telemetry window. */
function asyncParkReset(): void {
    const dispatcher = System.getInstance().process?.dispatcher as any;
    if (!dispatcher?.resetAsyncParkStats) { console.warn('[AsyncPark] No dispatcher'); return; }
    dispatcher.resetAsyncParkStats();
    console.log('[AsyncPark] window reset');
}

/**
 * Message-queue wake-reason report — for GetMessage/WaitMessage parks, classifies
 * each wake as a real message (by type), a coalesced/paint flushed on timeout, or
 * the bare 4ms WM_NULL idle poll. WM_NULL-dominated → game is inherently idle
 * (waiting for work that isn't coming); a real driver (e.g. WM_TIMER) → frame pacing.
 * Usage: msgWakeReport() — call msgWakeReset() first to scope a clean window.
 */
function msgWakeReport(): void {
    const mq = (System.getInstance().windowManager as any)?.messageQueue;
    if (!mq?.getWakeStats) { console.warn('[MsgWake] No messageQueue (game not running?)'); return; }
    const s = mq.getWakeStats();
    const realWakes = s.deliverByMsg.reduce((n: number, r: any) => n + r.count, 0);
    const pendWakes = s.timeoutPendingByMsg.reduce((n: number, r: any) => n + r.count, 0);
    const nullPct = s.parkCount > 0 ? (s.timeoutNull / s.parkCount * 100).toFixed(1) : '0.0';
    console.log(`[MsgWake] window=${s.windowMs}ms parks=${s.parkCount} avgLat=${s.avgLatencyMs}ms maxLat=${s.maxLatencyMs}ms`);
    console.log(`[MsgWake] WM_NULL idle-polls=${s.timeoutNull} (${nullPct}%) | real-msg wakes=${realWakes} | timeout-pending=${pendWakes}`);
    console.log('[MsgWake][JSON] ' + JSON.stringify(s));
    if (s.deliverByMsg.length) { console.log('[MsgWake] real messages by type:'); console.table(s.deliverByMsg); }
    if (s.timeoutPendingByMsg.length) { console.log('[MsgWake] timeout-flushed (coalesced/paint) by type:'); console.table(s.timeoutPendingByMsg); }
}

/** Reset message-queue wake-reason telemetry window. */
function msgWakeReset(): void {
    const mq = (System.getInstance().windowManager as any)?.messageQueue;
    if (!mq?.resetWakeStats) { console.warn('[MsgWake] No messageQueue'); return; }
    mq.resetWakeStats();
    console.log('[MsgWake] window reset');
}

/**
 * Idle-attribution report — the worker idle IS yieldToHost time; this groups it by
 * source (sleep0 = guest Sleep(0); allBlocked = all threads parked; waitObj/enterCS;
 * spinLoop* = async-park safety net; dispatcher). Answers what actually drives idle.
 * Usage: yieldReport() — call yieldReset() first to scope a clean window.
 */
function yieldReport(): void {
    const sched = System.getInstance().scheduler as any;
    if (!sched?.getYieldReport) { console.warn('[Yield] No scheduler'); return; }
    const r = sched.getYieldReport();
    console.log(`[Yield] window=${r.windowMs}ms totalYield=${r.totalYieldMs}ms (${r.pctOfWindow} of wall-clock) — by source:`);
    console.log('[Yield][JSON] ' + JSON.stringify(r));
    console.table(r.rows);
}

/** Reset idle-attribution (yield) telemetry window. */
function yieldReset(): void {
    const sched = System.getInstance().scheduler as any;
    if (!sched?.resetYieldStats) { console.warn('[Yield] No scheduler'); return; }
    sched.resetYieldStats();
    console.log('[Yield] window reset');
}

/**
 * Toggle slow-path hit counting.
 * Usage: slowPathProfile(true) to start, slowPathProfile(false) to stop.
 */
function slowPathProfile(enabled: boolean): void {
    const dispatcher = System.getInstance().process?.dispatcher as any;
    if (!dispatcher) {
        console.warn('[SlowPath] No dispatcher available (game not running?)');
        return;
    }
    if (enabled) {
        dispatcher.enableSlowPathProfile?.();
        console.log('[SlowPath] Profiling ENABLED. Run the game, then call slowPathReport().');
    } else {
        dispatcher.disableSlowPathProfile?.();
        console.log('[SlowPath] Profiling DISABLED. Existing counts still available via slowPathReport().');
    }
}

/**
 * Tier-0 write-buffer telemetry. Distinguishes bulk-drain trampoline success
 * vs OUT-trap fallback for WBUF-registered thunks (SetRenderState et al.).
 * Usage: wbufStats() in browser DevTools console.
 */
function wbufStats(): void {
    const dispatcher = System.getInstance().process?.dispatcher as any;
    if (!dispatcher) {
        console.warn('[WBUF] No dispatcher available (game not running?)');
        return;
    }
    const stats = dispatcher.getWbufStats?.() as { hits: number; outTrapHits: number; registered: number } | undefined;
    if (!stats) {
        console.warn('[WBUF] getWbufStats() not available on dispatcher');
        return;
    }
    const total = stats.hits + stats.outTrapHits;
    const hitPct = total > 0 ? (stats.hits / total * 100).toFixed(1) : 'n/a';
    console.log(
        `[WBUF] registered=${stats.registered} ` +
        `hits=${stats.hits.toLocaleString()} (${hitPct}% trampoline) ` +
        `outTrapHits=${stats.outTrapHits.toLocaleString()}`
    );
    if (stats.outTrapHits > 0 && stats.hits === 0) {
        console.warn('[WBUF] All calls hit OUT trap — stub patching likely failed. Check [WBUF] Registered logs for freshMem=STALE or readback=FAIL.');
    } else if (stats.outTrapHits > stats.hits) {
        console.warn('[WBUF] More OUT-trap hits than ring drains — likely deferred JIT invalidation race.');
    } else if (stats.hits === 0 && stats.outTrapHits === 0) {
        console.log('[WBUF] No activity recorded yet. Run the game first.');
    }
}

// Expose to global scope for console access
if (typeof globalThis !== 'undefined') {
    (globalThis as any).frameDiagnostics = frameDiagnostics;
    // Flip-cadence instrument — inter-present interval distribution + vsync-count histogram.
    // Diagnoses frame variance independent of the frameProfiler/markFrame path (which the
    // ddraw Flip's frameAlreadyMarked flag can skip). flipCadenceReset() to scope a window.
    (globalThis as any).flipCadence = (refreshMs = 16.67) => {
        const r = System.getInstance().services.render.getFlipCadence(refreshMs);
        console.log('[flipCadence][JSON] ' + JSON.stringify(r));
        const vh = (r as any).vsyncHistogram;
        if (vh) console.table(Object.entries(vh).map(([k, v]) => ({ vsyncsHeld: Number(k), frames: v })).sort((a, b) => a.vsyncsHeld - b.vsyncsHeld));
        return r;
    };
    (globalThis as any).flipCadenceReset = () => {
        System.getInstance().services.render.resetFlipCadence();
        console.log('[flipCadence] window reset — present a few seconds, then flipCadence()');
    };
    // Present-mode selector (the 4 display policies for a sub-refresh guest on a 60 Hz screen):
    //   'off'    — present ASAP, lowest latency, most 2↔3 pulldown jitter (default).
    //   'vsync'  — (A, faithful) pin every present to a fresh vsync edge → clean 3:2 at native rate.
    //   'smooth' — (B) hold each present a steady integer #vsyncs → flat cadence, caps at a divisor rate.
    //   'blend'  — (C) phase-blend the two newest frames at full refresh → judder dissolves into a
    //              smooth crossfade (~1 frame latency, slight softening); ddraw presenter only.
    // Resets the flip-cadence window so flipCadence() a few seconds later shows the new shape.
    (globalThis as any).setPresentMode = (mode: 'off' | 'vsync' | 'smooth' | 'blend' = 'off') => {
        const sys = System.getInstance();
        const presenter = (sys.process?.getModule('ddraw') as any)?.context?.presenter;
        if (mode === 'blend') {
            if (!presenter?.setBlendEnabled) {
                console.warn('[PresentMode] blend requires the ddraw presenter (not active) — mode unchanged');
                return;
            }
            framePacer.setPacingMode('off');   // don't cap the guest; it feeds history at its own rate
            presenter.setBlendEnabled(true);
        } else {
            presenter?.setBlendEnabled?.(false);
            framePacer.setPacingMode(mode);
        }
        sys.services.render.resetFlipCadence();
        const blend = !!presenter?.isBlendEnabled?.();
        console.log(`[PresentMode] mode=${mode} pacer=${framePacer.getPacingMode()} blend=${blend} — flip cadence window reset; run flipCadence() in ~5s to compare`);
    };
    // Back-compat alias: the original 'off'/'smooth' A/B toggle now delegates to setPresentMode.
    (globalThis as any).setFramePacing = (mode: 'off' | 'smooth' = 'smooth') => {
        (globalThis as any).setPresentMode(mode === 'smooth' ? 'smooth' : 'off');
    };
    // Stall collector — every slow frame classified (magnitude × cause) and accumulated.
    // stallReset() to scope a window, play through scenes/transitions, then stallReport().
    (globalThis as any).stallReport = () => {
        const r = frameProfiler.getStallReport();
        console.log('[stallReport][JSON] ' + JSON.stringify(r));
        console.table(r.classes);
        return r;
    };
    (globalThis as any).stallReset = () => {
        frameProfiler.resetStallStats();
        console.log('[stallReport] window reset — play through scenes/transitions, then stallReport()');
    };
    // Per-draw cost profiler — breaks the ~0.6ms/DrawPrimitiveVB into
    // resolve/prepare/vconvert/ringup/submit/tail so we know WHERE to optimize before
    // designing the batch. drawCostEnable() → play a draw-heavy window → drawCostReport().
    // Off by default (adds ~12 perf.now()/draw); always drawCostDisable() after measuring.
    (globalThis as any).drawCostEnable = () => {
        drawCostProfiler.enable();
        console.log('[drawCost] enabled — play a draw-heavy scene, then drawCostReport()');
    };
    (globalThis as any).drawCostDisable = () => {
        drawCostProfiler.disable();
        console.log('[drawCost] disabled');
    };
    (globalThis as any).drawCostReset = () => {
        drawCostProfiler.reset();
        console.log('[drawCost] window reset');
    };
    (globalThis as any).drawCostReport = () => {
        const r = drawCostProfiler.report();
        console.log('[drawCost][JSON] ' + JSON.stringify(r));
        console.table(r.phases);
        return r;
    };
    (globalThis as any).slowPathReport = slowPathReport;
    (globalThis as any).slowPathProfile = slowPathProfile;
    (globalThis as any).asyncParkReport = asyncParkReport;
    (globalThis as any).asyncParkReset = asyncParkReset;
    (globalThis as any).msgWakeReport = msgWakeReport;
    (globalThis as any).msgWakeReset = msgWakeReset;
    (globalThis as any).yieldReport = yieldReport;
    (globalThis as any).yieldReset = yieldReset;
    (globalThis as any).wbufStats = wbufStats;
    (globalThis as any).dumpThreads = dumpThreads;
    (globalThis as any).dumpHandle = dumpHandle;
    (globalThis as any).signalEvent = signalEvent;
    (globalThis as any).resetEventDiag = resetEventDiag;
    (globalThis as any).dumpCSState = dumpCSState;

    // Debug session API — ensure memory getter is wired for all console-initiated sessions
    const getV86 = () => System.getInstance().process?.v86 as any;
    const ensureMemGetter = () => {
        const v86 = getV86();
        if (v86) {
            debugSession.setMemoryGetter(() => getMemory(v86));
        }
    };
    (globalThis as any).debugStart = (cfg: DebugSessionConfig) => { ensureMemGetter(); debugSession.start(cfg); };
    (globalThis as any).debugStop = () => debugSession.stop();
    (globalThis as any).debugDump = () => debugSession.dump();
    (globalThis as any).debugExport = () => debugSession.export();
    (globalThis as any).debugReset = () => debugSession.reset();
    (globalThis as any).watchThunk = (pattern: string, opts?: { captureArgs?: boolean; maxEvents?: number }) =>
        watchThunk(pattern, opts);
    // watchMem: convenience for memWatch polling
    (globalThis as any).watchMem = (addr: number | string, size: 1 | 2 | 4 = 4, label = "mem") => {
        const a = typeof addr === "string" ? parseInt(addr, 16) : addr;
        ensureMemGetter();
        debugSession.start({ enabled: true, watches: [], memWatches: [{ addr: a, size, mode: "poll", label }] });
    };
    // narrDiag: one-call HoMM3 narration diagnostics
    (globalThis as any).narrDiag = () => {
        ensureMemGetter();
        debugSession.start({ enabled: true, preset: "narr-diag" });
        console.log("[NarrDiag] Narration diagnostics active. Play campaign, then call debugExport()");
    };
    // narrGuards: read FUN_00557af0 guard conditions + narration queue state during gameplay
    (globalThis as any).narrGuards = () => {
        const mem = getMemory(getV86());
        if (!mem) { console.log("[NarrGuards] No memory access"); return; }
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Narration queue struct at DAT_0069d7b0
        const nqBase = 0x0069d7b0;
        const nq_base = dv.getUint32(nqBase + 0, true);      // [0] ring buffer base
        const nq_head = dv.getUint32(nqBase + 4, true);       // [1] head index
        const nq_count = dv.getUint32(nqBase + 8, true);      // [2] count
        const nq_hasNew = mem[nqBase + 0x14];                  // [5] hasNew byte
        const nq_cap = dv.getUint32(nqBase + 0x1c, true);     // [7] capacity
        const nq_playHandle = dv.getUint32(nqBase + 0x28, true); // [10] play handle
        const nq_skipFlag = dv.getUint32(nqBase + 0x2c, true);  // [0xb] skip flag
        const nq_playData = dv.getUint32(nqBase + 0x30, true);  // [0xc] play data

        // FUN_00557af0 is called with param_1 = pointer to narration timer struct
        // The tick function FUN_004ed490 calls it with a struct offset from the scenario object
        // The struct pointer comes from the game tick — we need to find it
        // DAT_0069ccb0 = guard flag
        const g_69ccb0 = dv.getUint32(0x0069ccb0, true);
        // DAT_0069774c = speed mode flag
        const g_69774c = dv.getUint32(0x0069774c, true);

        // Campaign object at DAT_0069fbe8
        const campObj = dv.getUint32(0x0069fbe8, true);

        // sess_connected and CNetManager
        const sessConn = dv.getUint32(0x0069954c, true);
        const netMgr = dv.getUint32(0x0069d808, true);

        // DAT_0069d80c = dplay init result
        const dplayInit = mem[0x0069d80c];

        // FUN_00553960 gate globals
        const g_69d638 = dv.getUint32(0x0069d638, true);
        const g_69d634 = dv.getUint32(0x0069d634, true);
        const g_69d640 = dv.getUint32(0x0069d640, true);

        // DAT_00699268 = game state ptr (used in FUN_00553960 gate)
        const g_699268 = dv.getUint32(0x00699268, true);
        let gameState34 = "N/A";
        if (g_699268 !== 0) {
            try { gameState34 = "0x" + dv.getUint32(g_699268 + 0x34, true).toString(16); } catch {}
        }

        // Sound system checks
        const g_699290 = dv.getUint32(0x00699290, true); // no-sound flag
        const smBase = dv.getUint32(0x006993c4, true);   // sound manager
        let sm_3c = 0, sm_84 = 0;
        if (smBase) {
            try {
                sm_3c = dv.getUint32(smBase + 0x3c, true);
                sm_84 = dv.getUint32(smBase + 0x84, true);
            } catch {}
        }

        // Try to find narration timer struct
        // FUN_004ed490 calls FUN_00557af0 with offset from scenario obj
        // The scenario obj is at *(DAT_00699280 + 0x40), narration timer is nearby
        const g_699280 = dv.getUint32(0x00699280, true);
        let timerInfo = "scenario_obj=NULL";
        if (g_699280) {
            try {
                const scnObj = dv.getUint32(g_699280 + 0x40, true);
                timerInfo = `scenario_obj=0x${scnObj.toString(16)}`;
            } catch {}
        }

        console.log(`[NarrGuards] === Narration State (gameplay) ===`);
        console.log(`  DPlay: init=${dplayInit} sess=${sessConn} netMgr=0x${netMgr.toString(16)}`);
        console.log(`  Campaign: obj=0x${campObj.toString(16)} ${timerInfo}`);
        console.log(`  NarrQueue: base=0x${nq_base.toString(16)} head=${nq_head} cnt=${nq_count} cap=${nq_cap}`);
        console.log(`    playHandle=0x${nq_playHandle.toString(16)} skip=${nq_skipFlag} playData=0x${nq_playData.toString(16)} hasNew=${nq_hasNew}`);
        console.log(`  Guards: g_69ccb0=${g_69ccb0} g_69774c=${g_69774c}(speedMode)`);
        console.log(`  Enqueue gate: g_69d638=0x${g_69d638.toString(16)} g_69d634=0x${g_69d634.toString(16)} g_69d640=0x${g_69d640.toString(16)}`);
        console.log(`  Game state: g_699268=0x${g_699268.toString(16)} [+0x34]=${gameState34}`);
        console.log(`  Sound: noSound=${g_699290} sm+3c=${sm_3c} sm+84=${sm_84}`);
    };
    // narrTrace: trace narration-related guest function calls via memory watches
    (globalThis as any).narrTrace = () => {
        ensureMemGetter();
        const mem = getMemory(getV86());
        if (!mem) { console.log("[NarrTrace] No memory access"); return; }
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Start narr-diag preset for memory polling
        debugSession.start({ enabled: true, preset: "narr-diag" });

        // Also set up a polling interval to trace key function entry points
        // by reading the first byte at each address (to see if they're mapped/valid)
        const TRACE_ADDRS: Array<[number, string]> = [
            [0x005547c0, "FUN_005547c0 (narration_trigger_direct)"],
            [0x00553840, "FUN_00553840 (narration_enqueue_text)"],
            [0x00553aa0, "FUN_00553aa0 (narration_enqueue+audio)"],
            [0x0059a210, "FUN_0059a210 (AIL_sample_play)"],
            [0x005545f0, "FUN_005545f0 (sess_connected_gate)"],
            [0x004f3690, "FUN_004f3690 (game_exit)"],
            [0x00555920, "FUN_00555920 (dplay_lobby_check)"],
            [0x00555ef0, "FUN_00555ef0 (lobby_connect_path)"],
        ];

        // Verify these addresses are mapped
        for (const [addr, label] of TRACE_ADDRS) {
            try {
                const byte0 = mem[addr];
                console.log(`  [NarrTrace] 0x${addr.toString(16)}: byte0=0x${byte0.toString(16).padStart(2, '0')} — ${label}`);
            } catch {
                console.log(`  [NarrTrace] 0x${addr.toString(16)}: UNMAPPED — ${label}`);
            }
        }

        // Read current state
        const sessConn = dv.getUint32(0x0069954c, true);
        const netMgr = dv.getUint32(0x0069d808, true);
        const dplayInit = mem[0x0069d80c];
        const nqCount = dv.getUint32(0x0069d7b8, true);
        const campObj = dv.getUint32(0x0069fbe8, true);

        console.log(`[NarrTrace] Active. Current state:`);
        console.log(`  sess_connected=${sessConn}, CNetManager=0x${netMgr.toString(16)}, dplayInit=${dplayInit}`);
        console.log(`  narrQueue.count=${nqCount}, campaign=0x${campObj.toString(16)}`);
        console.log(`[NarrTrace] Memory watches active via debugSession. Use debugExport() for full trace.`);
        console.log(`[NarrTrace] Use narrGuards() for detailed guard condition check.`);
    };

    // narrWatch: periodic narration state monitor — logs on change
    let narrWatchInterval: ReturnType<typeof setInterval> | null = null;
    let narrWatchLast = "";
    (globalThis as any).narrWatch = (intervalMs = 100) => {
        if (narrWatchInterval) {
            clearInterval(narrWatchInterval);
            narrWatchInterval = null;
            console.log("[NarrWatch] Stopped.");
            return;
        }
        console.log(`[NarrWatch] Started (poll every ${intervalMs}ms). Call narrWatch() again to stop.`);
        narrWatchInterval = setInterval(() => {
            const mem = getMemory(getV86());
            if (!mem) return;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Narration queue
            const nqBase = 0x0069d7b0;
            const nq_count = dv.getUint32(nqBase + 8, true);
            const nq_playHandle = dv.getUint32(nqBase + 0x28, true);
            const nq_playData = dv.getUint32(nqBase + 0x30, true);
            const nq_hasNew = mem[nqBase + 0x14];

            // Guards for FUN_00557af0
            const g_69ccb0 = dv.getUint32(0x0069ccb0, true); // hero selected flag
            const g_69774c = dv.getUint32(0x0069774c, true); // speed mode
            const campObj = dv.getUint32(0x0069fbe8, true);   // campaign object

            // Scenario/tick struct pointer chain: DAT_006989ac + 0x3c → narration timer
            const g_6989ac = dv.getUint32(0x006989ac, true);
            let timerPtr = 0, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0;
            if (g_6989ac) {
                timerPtr = g_6989ac + 0x3c; // FUN_004ed490 passes this offset
                try {
                    // param_1[0..4] from FUN_00557af0
                    t0 = dv.getUint32(timerPtr + 0, true);  // startTime
                    t1 = dv.getUint32(timerPtr + 4, true);  // endTime
                    t2 = dv.getUint32(timerPtr + 8, true);  // totalDuration
                    t3 = dv.getUint32(timerPtr + 12, true); // nextInterval
                    t4 = dv.getUint32(timerPtr + 16, true); // isPlaying
                } catch {}
            }

            // FUN_00553960 enqueue gate
            const g_69d638 = dv.getUint32(0x0069d638, true);
            const g_69d634 = dv.getUint32(0x0069d634, true);

            // Sound state
            const g_699290 = dv.getUint32(0x00699290, true);
            const smBase = dv.getUint32(0x006993c4, true);
            let sm_84 = 0;
            if (smBase) try { sm_84 = dv.getUint32(smBase + 0x84, true); } catch {}

            // Compact key for change detection
            const key = `cnt=${nq_count},hnd=${nq_playHandle},camp=0x${campObj.toString(16)},` +
                `hero=${g_69ccb0},speed=${g_69774c},` +
                `timer=[${t0},${t1},${t2},${t3},${t4}],` +
                `enq=[0x${g_69d638.toString(16)},0x${g_69d634.toString(16)}],` +
                `sm84=${sm_84},noSnd=${g_699290}`;

            if (key !== narrWatchLast) {
                narrWatchLast = key;
                console.log(`[NarrWatch] CHANGED: ${key} timerBase=0x${(g_6989ac || 0).toString(16)} timerPtr=0x${timerPtr.toString(16)}`);
            }
        }, intervalMs);
    };

    // campWatch: high-frequency monitor of DAT_0069fbe8 (campaign obj) + narration queue count
    let campWatchInterval: ReturnType<typeof setInterval> | null = null;
    let campWatchLastVal = -1;
    let campWatchLastCnt = -1;
    (globalThis as any).campWatch = (intervalMs = 20) => {
        if (campWatchInterval) {
            clearInterval(campWatchInterval);
            campWatchInterval = null;
            console.log("[CampWatch] Stopped.");
            return;
        }
        console.log(`[CampWatch] Started (poll every ${intervalMs}ms on DAT_0069fbe8 + nq.count). Call campWatch() again to stop.`);
        campWatchInterval = setInterval(() => {
            const mem = getMemory(getV86());
            if (!mem) return;
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            const campObj = dv.getUint32(0x0069fbe8, true);
            const nqCount = dv.getUint32(0x0069d7b8, true); // nq.count at nqBase+8
            const nqPlayHandle = dv.getUint32(0x0069d7d8, true); // nq.playHandle at nqBase+0x28

            if (campObj !== campWatchLastVal || nqCount !== campWatchLastCnt) {
                const now = performance.now().toFixed(1);
                // Also read who might be the game manager: FUN_00579960 caller chain
                const dplayInit = mem[0x0069d80c];
                const sessConn = dv.getUint32(0x0069954c, true);
                console.log(
                    `[CampWatch] @${now}ms camp=0x${campObj.toString(16)} cnt=${nqCount} ` +
                    `playH=0x${nqPlayHandle.toString(16)} dplayInit=${dplayInit} sess=${sessConn}` +
                    (campObj !== 0 ? ` *** CAMP NON-NULL! ***` : '')
                );
                campWatchLastVal = campObj;
                campWatchLastCnt = nqCount;
            }
        }, intervalMs);
    };

    // narrHook: patch guest function prologues with canary writes to detect vtable calls.
    // Writes MOV DWORD [canary], id at each function entry. Polls canary for changes.
    // Each function gets a unique id (1, 2, 3...). When canary changes → function was called.
    let narrHookActive = false;
    let narrHookInterval: ReturnType<typeof setInterval> | null = null;
    const narrHookSaved: Array<{ addr: number; bytes: Uint8Array; label: string }> = [];
    (globalThis as any).narrHook = () => {
        ensureMemGetter();
        const v86 = getV86();
        const mem = getMemory(v86);
        if (!mem) { console.log("[NarrHook] No memory access"); return; }
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        if (narrHookActive) {
            // Unhook: restore original bytes
            for (const entry of narrHookSaved) {
                writeGuestCode(mem, entry.bytes, entry.addr);
                console.log(`[NarrHook] Restored ${entry.label} at 0x${entry.addr.toString(16)}`);
            }
            narrHookSaved.length = 0;
            if (narrHookInterval) { clearInterval(narrHookInterval); narrHookInterval = null; }
            narrHookActive = false;
            console.log("[NarrHook] All hooks removed.");
            return;
        }

        // Canary address: use a spot in .data section we know is unused (after DAT_0069fbe8)
        // DAT_0069fc00 should be safe — it's in .data and not referenced by narration code
        const CANARY = 0x0069fc00;

        // Functions to hook — the entire call chain from vtable down to enqueue
        const HOOKS: Array<[number, string]> = [
            [0x004022e0, "FUN_004022e0 (sp_narr_caller)"],
            [0x004726b0, "FUN_004726b0 (campaign_narr_caller)"],
            [0x005ae370, "FUN_005ae370 (tutorial_narr_caller)"],
            [0x005547c0, "FUN_005547c0 (narration_trigger)"],
            [0x00553840, "FUN_00553840 (narr_enqueue_text)"],
            [0x00553aa0, "FUN_00553aa0 (narr_enqueue+audio)"],
            [0x005545f0, "FUN_005545f0 (sess_connected_gate)"],
            [0x00557af0, "FUN_00557af0 (timer_display_tick)"],
        ];

        // Clear canary
        dv.setUint32(CANARY, 0, true);

        for (let i = 0; i < HOOKS.length; i++) {
            const [addr, label] = HOOKS[i];
            const funcId = i + 1;

            // Save original prologue bytes (10 bytes for MOV DWORD PTR [imm32], imm32)
            const saved = new Uint8Array(10);
            saved.set(mem.slice(addr, addr + 10));
            narrHookSaved.push({ addr, bytes: saved, label });

            // Patch: C7 05 [canary_addr_LE] [funcId_LE]  = MOV DWORD PTR [CANARY], funcId
            // This is exactly 10 bytes
            mem[addr + 0] = 0xC7; // MOV DWORD PTR [disp32], imm32
            mem[addr + 1] = 0x05;
            mem[addr + 2] = CANARY & 0xFF;
            mem[addr + 3] = (CANARY >> 8) & 0xFF;
            mem[addr + 4] = (CANARY >> 16) & 0xFF;
            mem[addr + 5] = (CANARY >> 24) & 0xFF;
            mem[addr + 6] = funcId & 0xFF;
            mem[addr + 7] = (funcId >> 8) & 0xFF;
            mem[addr + 8] = (funcId >> 16) & 0xFF;
            mem[addr + 9] = (funcId >> 24) & 0xFF;
            invalidateGuestCode(addr, 10);

            console.log(`[NarrHook] Patched ${label} @ 0x${addr.toString(16)} → canary write id=${funcId}`);
        }

        // Poll canary every 50ms
        let lastCanary = 0;
        const hookStart = performance.now();
        narrHookInterval = setInterval(() => {
            const val = dv.getUint32(CANARY, true);
            if (val !== lastCanary) {
                const elapsed = ((performance.now() - hookStart) / 1000).toFixed(1);
                const matchedHook = HOOKS[val - 1];
                const label = matchedHook ? matchedHook[1] : `unknown(${val})`;
                console.log(`[NarrHook] *** CANARY CHANGED *** id=${val} → ${label} at +${elapsed}s`);
                // Also log EIP for context
                const cpu = v86?.v86?.cpu || v86?.cpu;
                if (cpu) {
                    const eip = cpu.instruction_pointer?.[0] ?? cpu.instruction_pointer ?? 0;
                    console.log(`[NarrHook]   EIP=0x${(eip >>> 0).toString(16)}`);
                }
                lastCanary = val;
            }
        }, 50);

        narrHookActive = true;
        console.log(`[NarrHook] ${HOOKS.length} hooks active. Canary at 0x${CANARY.toString(16)}. Polling every 50ms.`);
        console.log(`[NarrHook] Play a campaign scenario and watch for CANARY CHANGED messages.`);
        console.log(`[NarrHook] Call narrHook() again to unhook and restore original code.`);
    };

    // debugDownload: send JSONL to main thread for file download
    (globalThis as any).debugDownload = () => {
        const content = debugSession.export();
        const filename = `debug-session-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jsonl`;
        self.postMessage({ type: "debug_download", content, filename });
        console.log(`[DebugSession] Sent ${filename} to main thread for download`);
    };

    // eipSampler: lightweight EIP histogram. Call eipSample(durationMs) from console
    // during a stall; reports top exact EIPs and top 4KB pages. Used to feed hot
    // addresses into Ghidra scripts (see tools/ghidra/NbTexLoadLoop.java).
    //
    // IMPORTANT: v86 stores EIP in WASM memory. When v86 is stopped (intentional
    // yield, async park, etc.), the register keeps the LAST-executed address. If
    // the thread was parked at spinLoopAddress, every tick of the sampler reads
    // that stale value. We detect "v86 stopped" via System.getInstance().scheduler.intentionalYield
    // and v86.running, and report stopped samples separately so they are not
    // mistaken for actual CPU burn.
    (globalThis as any).eipSample = (durationMs = 3000, intervalMs = 5) => {
        const v86 = getV86();
        const cpu = v86?.cpu || v86?.v86?.cpu;
        if (!cpu) { console.warn("[eipSample] v86 CPU not available"); return; }
        const ipView = cpu.instruction_pointer;
        if (!ipView) { console.warn("[eipSample] cpu.instruction_pointer unavailable"); return; }
        const scheduler: any = System.getInstance().scheduler;

        const exactRunning = new Map<number, number>();
        const pagesRunning = new Map<number, number>();
        const exactStopped = new Map<number, number>();
        let runningSamples = 0;
        let stoppedSamples = 0;
        const start = performance.now();
        console.log(`[eipSample] sampling ${durationMs}ms @ ${intervalMs}ms interval ...`);

        const id = setInterval(() => {
            // "Stopped" means v86.stop() has been called and we're waiting on a macro/microtask
            // to resume (async thunk park, yieldToHost, etc). Chrome still runs this setInterval
            // so we can detect that state and not count the stale EIP as CPU burn.
            const stopped = !!(scheduler?.intentionalYield) || v86?.running === false;
            const eip = ipView[0] >>> 0;
            if (stopped) {
                stoppedSamples++;
                exactStopped.set(eip, (exactStopped.get(eip) ?? 0) + 1);
                return;
            }
            runningSamples++;
            exactRunning.set(eip, (exactRunning.get(eip) ?? 0) + 1);
            const page = eip & ~0xFFF;
            pagesRunning.set(page, (pagesRunning.get(page) ?? 0) + 1);
        }, intervalMs) as unknown as number;

        setTimeout(() => {
            clearInterval(id);
            const elapsed = performance.now() - start;
            const totalSamples = runningSamples + stoppedSamples;
            const stoppedPct = totalSamples > 0 ? (stoppedSamples / totalSamples * 100).toFixed(1) : "0.0";

            const topRunning = Array.from(exactRunning.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([eip, n]) => ({
                    eip: "0x" + eip.toString(16).padStart(8, "0"),
                    count: n,
                    pct: runningSamples > 0 ? ((n / runningSamples) * 100).toFixed(1) + "%" : "0.0%",
                }));
            const topPages = Array.from(pagesRunning.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([page, n]) => ({
                    page: "0x" + page.toString(16).padStart(8, "0"),
                    count: n,
                    pct: runningSamples > 0 ? ((n / runningSamples) * 100).toFixed(1) + "%" : "0.0%",
                }));
            const topStopped = Array.from(exactStopped.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([eip, n]) => ({
                    eip: "0x" + eip.toString(16).padStart(8, "0"),
                    count: n,
                    pct: stoppedSamples > 0 ? ((n / stoppedSamples) * 100).toFixed(1) + "%" : "0.0%",
                }));

            console.log(`[eipSample] ${totalSamples} samples in ${elapsed.toFixed(0)}ms — ${runningSamples} running + ${stoppedSamples} stopped (v86 correctly idle: ${stoppedPct}%)`);
            console.log(`[eipSample] ${exactRunning.size} unique running EIPs, ${pagesRunning.size} unique 4KB pages`);
            console.log('[eipSample][JSON] ' + JSON.stringify({ totalSamples, runningSamples, stoppedSamples, stoppedPct, uniqueRunning: exactRunning.size, uniquePages: pagesRunning.size, topRunning, topPages, topStopped }));
            console.log("Top RUNNING EIPs (actual CPU burn — feed these to Ghidra):");
            console.table(topRunning);
            console.log("Top RUNNING 4KB pages:");
            console.table(topPages);
            if (stoppedSamples > 0) {
                console.log(`Top STOPPED-state EIPs (v86 was halted here — no CPU burn, just stale register value):`);
                console.table(topStopped);
            }
        }, durationMs);
    };

    // dumpHotJitBlocks: correlates v86's JIT cache (4KB-page → wasm_table_index)
    // with a live EIP histogram to answer "which guest x86 address does the hot
    // wasm-function[N] in a chrome profiler trace actually emulate?". This is
    // the missing link in analyze-trace.ts — without it the top JIT blocks are
    // just opaque function indices.
    //
    // Requires the jit_snapshot_* exports from vendor/v86/src/rust/jit.rs.
    // If those are missing, the function bails with a warning (v86 needs a
    // rebuild first: bun vendor/v86/build-wasm.sh).
    (globalThis as any).dumpHotJitBlocks = async (durationMs = 2000, intervalMs = 5, top = 20) => {
        const v86 = getV86();
        const cpu = v86?.cpu || v86?.v86?.cpu;
        if (!cpu) { console.warn("[dumpHotJitBlocks] v86 CPU not available"); return; }
        const ipView = cpu.instruction_pointer;
        if (!ipView) { console.warn("[dumpHotJitBlocks] cpu.instruction_pointer unavailable"); return; }
        const snapshotFn = cpu["jit_snapshot_cache"];
        const getIdx = cpu["jit_snapshot_get_wasm_idx"];
        const getAddr = cpu["jit_snapshot_get_phys_addr"];
        const getCnt = cpu["jit_snapshot_get_entry_count"];
        if (!snapshotFn || !getIdx || !getAddr || !getCnt) {
            console.warn("[dumpHotJitBlocks] v86 JIT snapshot exports missing — rebuild v86 (bash vendor/v86/build-wasm.sh)");
            return;
        }
        const scheduler: any = System.getInstance().scheduler;
        const pagesRunning = new Map<number, number>();
        // Exact-EIP histogram (alongside the page histogram): v86 compiles one JIT
        // block per 4KB page, so page granularity packs many guest functions into one
        // "wasm-function[N]". The exact EIP pins the hot instruction → exact function.
        const eipRunning = new Map<number, number>();
        let runningSamples = 0;
        const start = performance.now();
        console.log(`[dumpHotJitBlocks] sampling ${durationMs}ms @ ${intervalMs}ms interval ...`);

        await new Promise<void>(resolve => {
            const id = setInterval(() => {
                const stopped = !!(scheduler?.intentionalYield) || v86?.running === false;
                if (stopped) return;
                runningSamples++;
                const eip = ipView[0] >>> 0;
                eipRunning.set(eip, (eipRunning.get(eip) ?? 0) + 1);
                const page = eip & ~0xFFF;
                pagesRunning.set(page, (pagesRunning.get(page) ?? 0) + 1);
            }, intervalMs) as unknown as number;
            setTimeout(() => { clearInterval(id); resolve(); }, durationMs);
        });
        const elapsed = performance.now() - start;

        // Snapshot the JIT cache AFTER sampling so we see exactly what the hot EIP
        // pages were compiled as. Pages compiled during sampling may still appear
        // depending on timing; we don't try to align perfectly — this is diagnostic.
        const count = snapshotFn();
        const process = System.getInstance().process;
        const mreg = process?.moduleRegistry;

        const rows: Array<{
            wasm_fn: string;
            phys_addr: string;
            entries: number;
            samples: number;
            pct: string;
            module: string;
        }> = [];
        for (let i = 0; i < count; i++) {
            const idx = getIdx(i) >>> 0;
            const addr = getAddr(i) >>> 0;
            const entries = getCnt(i) >>> 0;
            const samples = pagesRunning.get(addr) ?? 0;
            let modInfo = "";
            if (mreg) {
                try {
                    const mod = mreg.getModuleContainingAddress(addr);
                    if (mod) {
                        const rva = addr - mod.baseAddress;
                        modInfo = `${mod.name}+0x${rva.toString(16)}`;
                    }
                } catch { /* ignore */ }
            }
            rows.push({
                wasm_fn: `wasm-function[${idx}]`,
                phys_addr: "0x" + addr.toString(16).padStart(8, "0"),
                entries,
                samples,
                pct: runningSamples > 0 ? ((samples / runningSamples) * 100).toFixed(1) + "%" : "0.0%",
                module: modInfo,
            });
        }
        // Sort by samples desc (hot pages first), then by address for stable tie-break.
        rows.sort((a, b) => b.samples - a.samples || a.phys_addr.localeCompare(b.phys_addr));

        // Exact-EIP ranking → precise instruction-level attribution (the page rows above
        // are JIT-block granular). Attached to the returned array; captureHotBlocksMark
        // and analyze-trace surface it so Ghidra can resolve the exact hot function.
        const topEips = Array.from(eipRunning.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([eip, samples]) => {
                let modInfo = "";
                if (mreg) {
                    try {
                        const mod = mreg.getModuleContainingAddress(eip);
                        if (mod) modInfo = `${mod.name}+0x${(eip - mod.baseAddress).toString(16)}`;
                    } catch { /* ignore */ }
                }
                return {
                    eip: "0x" + eip.toString(16).padStart(8, "0"),
                    samples,
                    pct: runningSamples > 0 ? ((samples / runningSamples) * 100).toFixed(1) + "%" : "0.0%",
                    module: modInfo,
                };
            });
        (rows as any).topEips = topEips;

        console.log(`[dumpHotJitBlocks] ${count} JIT blocks, ${runningSamples} EIP samples in ${elapsed.toFixed(0)}ms, ${pagesRunning.size} unique hot pages, ${eipRunning.size} unique EIPs`);
        console.log(`Top ${Math.min(top, rows.length)} JIT blocks (by EIP samples):`);
        console.log('[dumpHotJitBlocks][JSON] ' + JSON.stringify({ count, runningSamples, hotPages: pagesRunning.size, rows: rows.slice(0, top) }));
        console.table(rows.slice(0, top));
        // Return the full table so callers can post-process or save it.
        return rows;
    };
}

Logger.log(LogCategory.SYSTEM, '[FrameVariance] Console API available: frameDiagnostics.start/stop/summary/data/capture | slowPathReport() | dumpThreads() | dumpHandle(handle) | signalEvent(handle) | resetEventDiag(handle) | dumpCSState()');
Logger.log(LogCategory.SYSTEM, '[DebugSession] Console API: debugStart(cfg) | debugStop() | debugDump() | debugExport() | debugReset() | watchThunk(pattern) | watchMem(addr, size, label) | debugDownload()');
Logger.log(LogCategory.SYSTEM, '[eipSample] Console API: eipSample(durationMs=3000, intervalMs=5) — EIP histogram for hot-block identification');
// saveHotJitBlocks: convenience wrapper — runs dumpHotJitBlocks, triggers a
// file download of the full row array (not just top-N) so it can be fed to
// analyze-trace.ts --map without copy-paste gymnastics.
(globalThis as any).saveHotJitBlocks = async (durationMs = 3000, intervalMs = 5) => {
    const rows = await (globalThis as any).dumpHotJitBlocks?.(durationMs, intervalMs, 9999);
    if (!rows || !Array.isArray(rows)) {
        console.warn('[saveHotJitBlocks] dumpHotJitBlocks returned no rows (JIT cache empty or exports missing)');
        return;
    }
    const content = JSON.stringify(rows, null, 2);
    const filename = `hot-blocks-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    self.postMessage({ type: 'diag_download', content, filename });
    console.log(`[saveHotJitBlocks] Sent ${rows.length} rows → ${filename} (check Downloads)`);
    return filename;
};

(globalThis as any).captureHotBlocksMark = async (durationMs = 3000, intervalMs = 5) => {
    const rows = await (globalThis as any).dumpHotJitBlocks?.(durationMs, intervalMs, 99999);
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        console.warn('[captureHotBlocksMark] no rows (JIT cache empty or snapshot exports missing)');
        return 0;
    }

    const compact = rows
        .map((row: any) => ({
            idx: parseInt(String(row.wasm_fn).replace(/^wasm-function\[(\d+)\]$/, '$1'), 10),
            addr: row.phys_addr,
            module: row.module || undefined,
            // EIP-sample hotness — this, not the idx↔wasm-function[N] join, is the
            // reliable guest attribution (v86 table indices don't match Chrome's
            // wasm-function[N] numbering). Keep it so analyze-trace can rank pages.
            samples: typeof row.samples === 'number' ? row.samples : undefined,
            pct: row.pct || undefined,
        }))
        .filter((row: any) => Number.isFinite(row.idx));

    if (compact.length === 0) {
        console.warn('[captureHotBlocksMark] no parsable wasm-function indices in hot-block rows');
        return 0;
    }

    const topEips = Array.isArray((rows as any).topEips) ? (rows as any).topEips : undefined;
    const payload = { v: 1, source: 'bottleship', kind: 'hot-blocks', rows: compact, topEips };
    performance.mark('bottleship.hotblocks', { detail: JSON.stringify(payload) });
    console.log(`[captureHotBlocksMark] emitted performance.mark with ${compact.length} blocks${topEips ? `, ${topEips.length} exact EIPs` : ''} (must be inside an active trace recording)`);
    return compact.length;
};

Logger.log(LogCategory.SYSTEM, '[dumpHotJitBlocks] Console API: dumpHotJitBlocks(durationMs=2000, intervalMs=5, top=20) — correlate wasm-function[N] → guest addr + module:rva');
Logger.log(LogCategory.SYSTEM, '[saveHotJitBlocks] Console API: saveHotJitBlocks(durationMs=3000, intervalMs=5) — same as dumpHotJitBlocks but downloads full rows as JSON file');
Logger.log(LogCategory.SYSTEM, '[captureHotBlocksMark] Console API: captureHotBlocksMark(durationMs=3000, intervalMs=5) — sample + embed hot-blocks as a performance.mark so analyze-trace reads them straight from the .json.gz (no --map needed). Call WHILE a trace is recording.');

// Static-library HLE console helpers. Usage from DevTools console (worker scope):
//   hleEnable()        — detect + log, no patching (safe dry-run).
//   hleEnable(false)   — detect + patch. Use only after logOnly looks sane.
//   hleDisable()       — turn off.
//   hleStatus()        — current config + registered descriptors.
//   hleReport()        — what was detected and how many times each hook fired.
import { libHleManager } from './hle-lib/lib-hle-manager';
import { libRegistry } from './hle-lib/lib-registry';
import { EmulatorConfig as _EmulatorConfig } from './emulator-config-manager';
if (typeof globalThis !== 'undefined') {
    // Expose the config singleton for users who want direct access.
    (globalThis as any).EmulatorConfig = _EmulatorConfig;

    (globalThis as any).hleEnable = (logOnly = true) => {
        const cfg = _EmulatorConfig.getInstance().hleLibs;
        cfg.enable = true;
        cfg.logOnly = logOnly;
        console.log(`[HLE-lib] enabled (logOnly=${logOnly}). Reload the game (or loadApp) for detection to run on PE load.`);
        console.log(`[HLE-lib] Registered descriptors: ${libRegistry.getAll().map(d => d.id).join(', ') || '(none)'}`);
        return cfg;
    };
    (globalThis as any).hleDisable = () => {
        const cfg = _EmulatorConfig.getInstance().hleLibs;
        cfg.enable = false;
        cfg.logOnly = false;
        console.log(`[HLE-lib] disabled. Existing patches remain active until next loadApp.`);
        return cfg;
    };
    (globalThis as any).hleStatus = () => {
        const cfg = _EmulatorConfig.getInstance().hleLibs;
        console.log(`[HLE-lib] enable=${cfg.enable} logOnly=${cfg.logOnly}`);
        console.log(`[HLE-lib] manager initialized=${libHleManager.isInitialized()}`);
        console.log(`[HLE-lib] descriptors: ${libRegistry.getAll().map(d => d.id).join(', ') || '(none)'}`);
        for (const s of libHleManager.getShadowStatuses()) {
            console.log(`[HLE-lib] shadow ${s.libId}:${s.functionName} state=${s.state} clean=${s.cleanCalls}/${s.targetCalls}`);
        }
        return cfg;
    };

    (globalThis as any).hleReport = () => {
        const rows = libHleManager.getReport();
        if (rows.length === 0) {
            console.log('[HLE-lib] No library matches recorded. Check EmulatorConfig.hleLibs.enable.');
            return rows;
        }
        for (const r of rows) {
            console.log(`[${r.lib}] @ ${r.module} — confidence=${r.confidence}` +
                (r.missing.length > 0 ? ` missing=${r.missing.join(',')}` : ''));
            if (r.patches.length > 0) console.table(r.patches);
        }
        return rows;
    };
}
Logger.log(LogCategory.SYSTEM, '[HLE-lib] Console API: hleEnable(logOnly?) | hleDisable() | hleStatus() | hleReport() | EmulatorConfig.getInstance().hleLibs');
