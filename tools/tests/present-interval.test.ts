/**
 * Presentation swap-interval contract.
 *
 * Every legacy presentation API lets the app choose how long a present is held:
 * D3DPRESENT_INTERVAL_* (d3d8/d3d9), DDFLIP_NOVSYNC / DDFLIP_INTERVALn (DirectDraw),
 * grBufferSwap's argument (Glide). They all reduce to one number — refreshes to hold —
 * which is what FramePacer.waitForPresentInterval consumes.
 *
 * Two properties this file exists to pin:
 *  - ONE/DEFAULT must be exactly one refresh, because that is the overwhelmingly common
 *    request and every title on the old fixed policy was already getting it.
 *  - IMMEDIATE must NOT block on a refresh, but must still bound invisible work — a
 *    present loop that never yields would otherwise starve the thread the guest runs on.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
    framePacer,
    decodeD3DPresentInterval,
    PRESENT_INTERVAL_IMMEDIATE,
    PRESENT_INTERVAL_ONE,
} from "../../src/worker/core/frame-pacer";

type RafCallback = (t: number) => void;

let pendingRaf: RafCallback[] = [];

/** Fire every rAF callback queued so far — one simulated display refresh. */
function refresh(): void {
    const due = pendingRaf;
    pendingRaf = [];
    for (const cb of due) cb(performance.now());
}

/** Let queued microtasks (and the promise continuations they schedule) run. */
function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function track(p: Promise<void>): { done: boolean } {
    const state = { done: false };
    void p.then(() => { state.done = true; });
    return state;
}

/** Leave the pacer with no queued permit, so a following wait provably blocks. */
async function drainPermit(): Promise<void> {
    refresh();                                       // rAF fires with no waiter -> permit queued
    await framePacer.waitForPresentInterval(PRESENT_INTERVAL_ONE); // consumes it, returns at once
    await settle();
}

beforeAll(() => {
    (globalThis as Record<string, unknown>).requestAnimationFrame =
        (cb: RafCallback) => { pendingRaf.push(cb); return pendingRaf.length; };
    framePacer.start();
});

afterAll(() => {
    framePacer.stop();
    delete (globalThis as Record<string, unknown>).__forcePresentInterval;
    delete (globalThis as Record<string, unknown>).__noPresentBackstop;
});

describe("D3DPRESENT_INTERVAL decoding", () => {
    test("DEFAULT and ONE both mean one refresh", () => {
        expect(decodeD3DPresentInterval(0x00000000)).toBe(PRESENT_INTERVAL_ONE);
        expect(decodeD3DPresentInterval(0x00000001)).toBe(PRESENT_INTERVAL_ONE);
    });

    test("TWO/THREE/FOUR are the bit values, not the counts", () => {
        expect(decodeD3DPresentInterval(0x00000002)).toBe(2);
        expect(decodeD3DPresentInterval(0x00000004)).toBe(3);
        expect(decodeD3DPresentInterval(0x00000008)).toBe(4);
    });

    test("IMMEDIATE means no retrace wait", () => {
        expect(decodeD3DPresentInterval(0x80000000)).toBe(PRESENT_INTERVAL_IMMEDIATE);
    });

    test("a value we never advertise falls back to ONE, not to a made-up cadence", () => {
        expect(decodeD3DPresentInterval(0x00000003)).toBe(PRESENT_INTERVAL_ONE);
        expect(decodeD3DPresentInterval(0x0000abcd)).toBe(PRESENT_INTERVAL_ONE);
    });
});

describe("FramePacer.waitForPresentInterval", () => {
    test("ONE blocks for exactly one refresh", async () => {
        await drainPermit();

        const wait = track(framePacer.waitForPresentInterval(PRESENT_INTERVAL_ONE));
        await settle();
        expect(wait.done).toBe(false);

        refresh();
        await settle();
        expect(wait.done).toBe(true);
    });

    test("THREE blocks for exactly three refreshes", async () => {
        await drainPermit();

        const wait = track(framePacer.waitForPresentInterval(3));
        for (let held = 1; held < 3; held++) {
            await settle();
            expect(wait.done).toBe(false);
            refresh();
        }
        await settle();
        expect(wait.done).toBe(false);
        refresh();
        await settle();
        expect(wait.done).toBe(true);
    });

    test("IMMEDIATE releases without any refresh, then backstops a runaway loop", async () => {
        await drainPermit();

        // The bound is per refresh, so a burst inside one refresh passes straight through...
        for (let i = 0; i < 8; i++) {
            const pass = track(framePacer.waitForPresentInterval(PRESENT_INTERVAL_IMMEDIATE));
            await settle();
            expect(pass.done).toBe(true);
        }

        // ...and only a present past the bound degrades to a single-refresh wait.
        const backstopped = track(framePacer.waitForPresentInterval(PRESENT_INTERVAL_IMMEDIATE));
        await settle();
        expect(backstopped.done).toBe(false);
        refresh();
        await settle();
        expect(backstopped.done).toBe(true);
    });

    test("__noPresentBackstop lifts the bound entirely", async () => {
        await drainPermit();
        (globalThis as Record<string, unknown>).__noPresentBackstop = true;
        try {
            for (let i = 0; i < 32; i++) {
                const pass = track(framePacer.waitForPresentInterval(PRESENT_INTERVAL_IMMEDIATE));
                await settle();
                expect(pass.done).toBe(true);
            }
        } finally {
            delete (globalThis as Record<string, unknown>).__noPresentBackstop;
        }
    });

    test("__forcePresentInterval overrides what the app asked for", async () => {
        await drainPermit();
        (globalThis as Record<string, unknown>).__forcePresentInterval = PRESENT_INTERVAL_IMMEDIATE;
        try {
            const forced = track(framePacer.waitForPresentInterval(PRESENT_INTERVAL_ONE));
            await settle();
            expect(forced.done).toBe(true);
        } finally {
            delete (globalThis as Record<string, unknown>).__forcePresentInterval;
        }
    });

    test("stats separate immediate presents from held refreshes", async () => {
        await drainPermit();
        framePacer.resetStats();

        await framePacer.waitForPresentInterval(PRESENT_INTERVAL_IMMEDIATE);
        const held = track(framePacer.waitForPresentInterval(2));
        await settle();
        refresh();
        await settle();
        refresh();
        await settle();
        expect(held.done).toBe(true);

        const stats = framePacer.getStats();
        expect(stats.immediatePresents).toBe(1);
        expect(stats.heldRefreshes).toBe(1); // interval 2 == one refresh beyond the first
    });
});
