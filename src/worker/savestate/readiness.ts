/**
 * Savestate readiness (issue #66, stage 3): whether the session is at a point where a
 * snapshot could be taken, and if not, every reason why. Read-only; nothing is changed.
 *
 * A thread parked on a restartable async thunk (GetMessage) is not a blocker: it is
 * captured rewound to the call. Every other host-side piece of work must drain first.
 */

export type ReadinessBlockerKind =
    | 'async-park' | 'async-restore' | 'callback' | 'suspended-frame' | 'modal-pump' | 'modal'
    | 'write-buffer' | 'seh-dispatch'
    | 'lock-lease' | 'overlay-flush' | 'child-process' | 'video';

export interface ReadinessBlocker { kind: ReadinessBlockerKind; detail: string }

export interface ReadinessProbe {
    asyncParks(): Array<{ name: string; threadId: number | null; restartable: boolean }>;
    pendingAsyncRestores(): number;
    pendingCallbacks(): number;
    suspendedFrames(): Array<{ threadId: number; source: string }>;
    modalPumpArmed(): boolean;
    pendingModals(): number;
    writeBufferPendingBytes(): number;
    sehDispatchInFlight(): number;
    activeLeases(): number;
    pendingOverlayWrites(): number;
    liveChildProcesses(): number;
    videoSessions(): number;
}

export interface Readiness { ready: boolean; blockers: ReadinessBlocker[]; restartableParks: number }

export function assessReadiness(p: ReadinessProbe): Readiness {
    const blockers: ReadinessBlocker[] = [];
    let restartableParks = 0;
    for (const park of p.asyncParks()) {
        if (park.restartable) { restartableParks++; continue; }
        blockers.push({ kind: 'async-park', detail: `thread ${park.threadId ?? '?'} in ${park.name}` });
    }
    const count = (kind: ReadinessBlockerKind, n: number, what: string) => {
        if (n > 0) blockers.push({ kind, detail: `${n} ${what}` });
    };
    count('async-restore', p.pendingAsyncRestores(), 'completed async thunk(s) not yet resumed');
    count('callback', p.pendingCallbacks(), 'guest callback(s) in flight');
    for (const frame of p.suspendedFrames()) {
        blockers.push({ kind: 'suspended-frame', detail: `thread ${frame.threadId} in ${frame.source}` });
    }
    if (p.modalPumpArmed()) blockers.push({ kind: 'modal-pump', detail: 'a host-driven modal pump has its next step armed' });
    count('modal', p.pendingModals(), 'modal dialog(s) pumped by the host');
    count('write-buffer', p.writeBufferPendingBytes(), 'byte(s) of unflushed write-buffer entries');
    count('seh-dispatch', p.sehDispatchInFlight(), 'exception(s) being dispatched');
    count('lock-lease', p.activeLeases(), 'surface lock lease(s)');
    count('overlay-flush', p.pendingOverlayWrites(), 'overlay write(s) not yet in OPFS');
    count('child-process', p.liveChildProcesses(), 'child process(es)');
    count('video', p.videoSessions(), 'video decoder session(s)');
    return { ready: blockers.length === 0, blockers, restartableParks };
}
