/**
 * The frame pacer must never outlive the display it paces to.
 *
 * A permit comes from requestAnimationFrame, and rAF delivery is conditional on the page
 * actually being rendered: a hidden tab, a window Chrome considers occluded, a compositor
 * that stops for any other reason — callbacks simply stop, with `document.visibilityState`
 * still "visible". Because a Blt/Flip to the primary is an ASYNC THUNK, a permit that never
 * arrives parks the GUEST THREAD that issued it, and the emulator does not slow down — it
 * stops, until someone looks at the tab again. Measured on Discworld Noir in a hidden tab:
 * 0 presents in 30 s before this, ~22/s after.
 *
 * Two properties, both of which held only accidentally before:
 *   - a wait releases even when no frame ever arrives (this file's rAF never fires);
 *   - a second waiter does not strand the first — the slot holds ONE resolver, and
 *     overwriting it used to drop whoever was already parked.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";

/** rAF that never fires: the whole point is a pacer with no frames to pace to. */
const originalRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
    rafCallbacks = [];
    (globalThis as Record<string, unknown>).requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
});

afterEach(() => {
    (globalThis as Record<string, unknown>).requestAnimationFrame = originalRaf;
});

/** Fresh module instance per test — the pacer is a singleton with wait state. */
async function freshPacer() {
    const mod = await import(`../../src/worker/core/frame-pacer?stall=${Math.random()}`);
    const pacer = mod.framePacer as {
        start(): void;
        stop(): void;
        waitForFrameSlot(o?: { nonBlocking?: boolean }): Promise<void>;
        getStats(): { stalledReleases: number };
    };
    pacer.start();
    return pacer;
}

describe("FramePacer without frames", () => {
    test("a frame-slot wait releases even when rAF never fires", async () => {
        const pacer = await freshPacer();
        const t0 = performance.now();
        // No rAF callback is ever invoked here — this is the hidden-tab / occluded-window case.
        await pacer.waitForFrameSlot();
        const elapsed = performance.now() - t0;

        expect(elapsed).toBeGreaterThan(100);   // it really did wait for a frame first
        expect(elapsed).toBeLessThan(2000);     // and gave up rather than parking forever
        expect(pacer.getStats().stalledReleases).toBe(1);
        pacer.stop();
    });

    test("a second waiter neither strands nor releases the first — the FRAME does", async () => {
        const pacer = await freshPacer();
        const done = [false, false];
        const first = pacer.waitForFrameSlot().then(() => { done[0] = true; });
        const second = pacer.waitForFrameSlot().then(() => { done[1] = true; });

        // Arriving second must not hand the first one its permit: releasing on overlap is
        // pacing silently switched off, which reads as a huge FPS number with visible spikes.
        await new Promise((r) => setTimeout(r, 60));
        expect(done).toEqual([false, false]);

        // One frame releases everyone parked on it — they were all waiting for this frame.
        for (const cb of rafCallbacks.splice(0)) cb(performance.now());
        await Promise.all([first, second]);
        expect(done).toEqual([true, true]);
        expect(pacer.getStats().stalledReleases).toBe(0);
        pacer.stop();
    });
});
