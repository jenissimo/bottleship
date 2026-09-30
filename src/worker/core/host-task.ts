/**
 * Queue a callback as a new host task at normal priority — the "yield to the event loop and
 * come straight back" primitive the v86 tick loop and the scheduler's sub-millisecond yields
 * both need.
 *
 * `scheduler.postTask` is queued inside the renderer's own task scheduler. A MessagePort
 * message, the older way to do this without setTimeout's 4ms floor, is carried over Mojo even
 * between two ports of one thread, and while the GPU client's IPC is busy its delivery slips
 * by 5-17ms — every guest thread stalls with it, and an audio pump that must write a chunk
 * every 5ms falls behind. The MessageChannel remains the fallback where postTask is missing,
 * and under `__noPostTaskYield`.
 */

type TaskScheduler = { postTask(cb: () => void): Promise<unknown> };

const fallbackQueue: Array<() => void> = [];
let fallbackPort: MessagePort | null = null;

function viaMessageChannel(cb: () => void): void {
    if (!fallbackPort) {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { fallbackQueue.shift()?.(); };
        fallbackPort = ch.port2;
    }
    fallbackQueue.push(cb);
    fallbackPort.postMessage(null);
}

export function postHostTask(cb: () => void): void {
    const scheduler = (globalThis as { scheduler?: TaskScheduler }).scheduler;
    if (scheduler?.postTask && !(globalThis as { __noPostTaskYield?: boolean }).__noPostTaskYield) {
        void scheduler.postTask(cb);
        return;
    }
    viaMessageChannel(cb);
}

/**
 * v86's `yield(t, tick)` over host tasks. v86 queues a new tick from run() and from the CPU's
 * wake callback while one may already be queued, and relies on `yield_callback` discarding
 * every tick number but the latest. A queued callback that reads a shared "latest tick" passes
 * that check every time, so each extra queue became a second self-perpetuating tick chain —
 * hundreds piled up in the host queue, starving messages, timers and rAF. So at most one host
 * task is in flight, and it runs whichever tick is latest when it fires; a tick that a later
 * timed yield superseded is still discarded by v86's own check.
 */
export function createTickYield(yieldCallback: (tick: number) => void): (t: number, tick: number) => void {
    let pendingTick = 0;
    let queued = false;
    const runTick = (): void => {
        queued = false;
        yieldCallback(pendingTick);
    };
    return (t: number, tick: number): void => {
        if (t < 1) {
            pendingTick = tick;
            if (!queued) {
                queued = true;
                postHostTask(runTick);
            }
        } else {
            setTimeout(() => yieldCallback(tick), t);
        }
    };
}
