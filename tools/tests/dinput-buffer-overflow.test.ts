/**
 * DI_BUFFEROVERFLOW is a LOSS report, not a backlog report.
 *
 * Engines answer it by flushing their own input table (Painkiller's DIInputSystem calls
 * Reset(), which clears the held-key mask). So returning it merely because more events are
 * queued than the caller's array holds — the normal shape of a one-event-per-call drain —
 * makes a held key die on any frame where something else is also producing events.
 */
import { describe, expect, test } from "bun:test";
import { DInput } from "../../src/worker/modules/dinput/dinput";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import type { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { INPUT_BUFFER_SIZE, KEY_BITFIELD_BASE } from "../../src/input/sab-layout";

/** Keyboard target resolution is what poll() does AFTER buffering, so a null one is enough. */
const stubWindowManager = () => ({ getKeyboardTargetWindow: () => undefined }) as unknown as WindowManager;

function manager(bufferSize: number) {
    const im = new InputManager(stubWindowManager());
    im.setInputBuffer(new Int32Array(new ArrayBuffer(INPUT_BUFFER_SIZE)));
    im.setDInputKeyboardBufferSize(bufferSize);
    return im;
}

/** One down/up pair per call, on distinct VKs, so each poll produces exactly one event. */
function pressDistinctKeys(im: InputManager, count: number, firstVk = 0x41) {
    for (let i = 0; i < count; i++) im.injectKey(firstVk + i, true);
}

describe("buffered DirectInput overflow", () => {
    test("a backlog deeper than the caller's array is not an overflow", () => {
        const im = manager(512);
        pressDistinctKeys(im, 20);
        expect(im.getDInputKeyboardEventCount()).toBe(20);
        // The shape Painkiller's MouseTick uses: drain one at a time until the queue empties.
        for (let i = 0; i < 20; i++) {
            expect(im.drainDInputKeyboardEvents(1).length).toBe(1);
            expect(im.takeDInputKeyboardOverflow()).toBe(false);
        }
        expect(im.getDInputKeyboardEventCount()).toBe(0);
    });

    test("a full buffer refuses NEW data and latches the loss", () => {
        const im = manager(4);
        pressDistinctKeys(im, 6);
        expect(im.getDInputKeyboardEventCount()).toBe(4);
        // Oldest four survive: dropping the head would retire a DOWN whose UP is still queued.
        const drained = im.drainDInputKeyboardEvents(4);
        expect(drained.map(e => e.dwSequence)).toEqual([1, 2, 3, 4]);
        expect(im.takeDInputKeyboardOverflow()).toBe(true);
    });

    test("the loss is reported once", () => {
        const im = manager(2);
        pressDistinctKeys(im, 5);
        expect(im.takeDInputKeyboardOverflow()).toBe(true);
        expect(im.takeDInputKeyboardOverflow()).toBe(false);
    });

    test("resizing the buffer clears a pending loss report", () => {
        const im = manager(2);
        pressDistinctKeys(im, 5);
        im.setDInputKeyboardBufferSize(64);
        expect(im.takeDInputKeyboardOverflow()).toBe(false);
    });
});

describe("acquisition flushes the queue", () => {
    test("a fresh Acquire starts on an empty buffer with no pending loss report", () => {
        const im = manager(4);
        pressDistinctKeys(im, 6);                 // fills it and latches the overflow
        expect(im.getDInputKeyboardEventCount()).toBe(4);

        // What IDirectInputDevice::Acquire does for this device kind. DirectInput records
        // only while acquired, so edges produced across an Unacquire must not survive it.
        const dinput = new DInput();
        (dinput as unknown as { process: unknown }).process = { getCurrentMemory: () => new Uint8Array(16) };
        (dinput as unknown as { flushBufferedQueue: (im: unknown, kind: string) => void })
            .flushBufferedQueue(im, "keyboard");

        expect(im.getDInputKeyboardEventCount()).toBe(0);
        expect(im.takeDInputKeyboardOverflow()).toBe(false);
    });
});
