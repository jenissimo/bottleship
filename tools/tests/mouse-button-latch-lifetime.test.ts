/**
 * The mouse-button latch is ONE SAMPLE WIDE.
 *
 * The SAB carries a button LEVEL with no edge queue, so a press the host published
 * and released between two guest samples would be invisible to a level-only API
 * (DirectInput's immediate mouse state). The latch recovers that one sample — and
 * nothing more: an immediate-state read answers with what the device holds NOW, so a
 * latched press that outlives its release is a press handed to whatever happens to be
 * reading later, which from the guest's side is a second click it never made.
 *
 * These tests pin the lifetime, not just the "seen once" part: without the ageing step
 * the latch survives until some reader takes it, however long that is.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";

const LEFT = 1;

function im(): any {
    return System.getInstance().inputManager as any;
}

/** A press and its release with no guest read between them — one JS turn, two polls. */
function subPollPress(): void {
    im().injectButtonAtScreen(10, 10, 0, true);
    im().injectButtonAtScreen(10, 10, 0, false);
}

beforeEach(() => {
    const manager = im();
    manager.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    manager.reset();
});

describe("mouse button latch lifetime", () => {
    test("a sub-poll press is reported exactly once", () => {
        subPollPress();
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(LEFT);
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(0);
    });

    test("it survives the sample that observed the release", () => {
        subPollPress();
        im().poll();
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(LEFT);
    });

    test("it expires once that sample has passed, unread", () => {
        subPollPress();
        im().poll();
        im().poll();
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(0);
    });

    test("a press nobody reads cannot cross an arbitrary stall", () => {
        subPollPress();
        for (let i = 0; i < 50; i++) im().poll();
        expect(im().consumeMouseButtonLatch()).toBe(0);
    });

    test("ageing never touches a button that is still held", () => {
        im().injectButtonAtScreen(10, 10, 0, true);
        for (let i = 0; i < 50; i++) im().poll();
        // The level alone carries a held button; the read must still answer DOWN.
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(LEFT);
        expect(im().getMouseState().buttons & LEFT).toBe(LEFT);
        im().injectButtonAtScreen(10, 10, 0, false);
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(0);
    });

    test("a fresh press after an expired one is still delivered", () => {
        subPollPress();
        for (let i = 0; i < 5; i++) im().poll();
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(0);
        subPollPress();
        expect(im().consumeMouseButtonLatch() & LEFT).toBe(LEFT);
    });
});
