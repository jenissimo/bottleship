// The recognizer and the device are each covered on their own; this is the seam
// between them — the one the driver walks on every contact. It is where a gesture
// stops being geometry and becomes something the guest can actually observe, and
// both known classes of bug live here: an edge that cancels itself out on a level
// transport, and a level nobody releases.

import { describe, expect, test } from "bun:test";
import { INPUT_BUFFER_SIZE, INPUT_INDEX } from "../../src/input/sab-layout";
import { VirtualInputDevice } from "../../src/input/virtual-device";
import {
    createRecognizer, step, tick,
    type RecognizerState, type TouchIntent,
} from "../../src/input/touch/recognizer";
import { LONG_PRESS_MS, TAP_HOLD_MS } from "../../src/input/touch/gestures";

const GUEST_W = 640;
const GUEST_H = 480;

function rig(mode: "direct" | "trackpad" = "direct") {
    const view = new Int32Array(INPUT_BUFFER_SIZE / 4);
    const device = new VirtualInputDevice();
    device.attach(view, () => { /* the worker poke is not what this asserts */ });
    device.setPointerBounds(GUEST_W, GUEST_H);
    const rec = createRecognizer({
        mode, maxX: GUEST_W - 1, maxY: GUEST_H - 1, cursorAid: false,
    });
    return { view, device, rec };
}

// The driver's own emit(), reduced to what it does with the device.
function drain(device: VirtualInputDevice, intents: TouchIntent[]): void {
    for (const it of intents) {
        switch (it.k) {
            case "cursor": device.setPointerAbsolute(it.x, it.y); break;
            case "delta": device.addPointerRelative(it.dx, it.dy); break;
            case "button":
                device.setButton(it.button === 1 ? 2 : it.button === 2 ? 1 : 0, it.down, "touch");
                break;
            case "wheel": device.addWheel(it.delta); break;
        }
    }
    device.commit({ immediate: true });
}

const down = (id: number, x: number, y: number) => ({ id, phase: "down" as const, x, y });
const move = (id: number, x: number, y: number) => ({ id, phase: "move" as const, x, y });
const up = (id: number, x: number, y: number) => ({ id, phase: "up" as const, x, y });
const cancel = (id: number, x: number, y: number) => ({ id, phase: "cancel" as const, x, y });

function feed(rig: { device: VirtualInputDevice; rec: RecognizerState },
    ev: ReturnType<typeof down>, now: number): void {
    drain(rig.device, step(rig.rec, ev, now));
}
function advance(rig: { device: VirtualInputDevice; rec: RecognizerState }, now: number): void {
    drain(rig.device, tick(rig.rec, now));
}

describe("tap reaches the guest as an observable edge", () => {
    test("the button is HELD across a poll interval, not a zero-width blip", () => {
        const r = rig();
        feed(r, down(1, 320, 240), 0);
        feed(r, up(1, 320, 240), 30);
        // The press must be visible…
        expect(r.view[INPUT_INDEX.buttons]).toBe(1);
        expect(r.view[INPUT_INDEX.mouseX]).toBe(320);
        // …for at least the hold floor, then released.
        advance(r, 30 + TAP_HOLD_MS - 1);
        expect(r.view[INPUT_INDEX.buttons]).toBe(1);
        advance(r, 30 + TAP_HOLD_MS + 1);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });

    test("the cursor is at the tap point BEFORE the button goes down", () => {
        const r = rig();
        feed(r, down(1, 100, 150), 0);
        // Position published on touchdown; no button yet — the guest gets a move first.
        expect(r.view[INPUT_INDEX.mouseX]).toBe(100);
        expect(r.view[INPUT_INDEX.mouseY]).toBe(150);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });
});

describe("nothing is left latched", () => {
    test("a cancelled long press never presses anything", () => {
        const r = rig();
        feed(r, down(1, 200, 200), 0);
        advance(r, LONG_PRESS_MS - 10);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
        feed(r, cancel(1, 200, 200), LONG_PRESS_MS - 5);
        advance(r, LONG_PRESS_MS + 100);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });

    test("a cancel mid-drag releases the held button", () => {
        const r = rig();
        feed(r, down(1, 100, 100), 0);
        feed(r, move(1, 160, 100), 40);
        expect(r.view[INPUT_INDEX.buttons]).toBe(1);
        feed(r, cancel(1, 160, 100), 60);
        advance(r, 60 + TAP_HOLD_MS + 1);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });

    test("a long press releases on lift and leaves no level behind", () => {
        const r = rig();
        feed(r, down(1, 300, 300), 0);
        advance(r, LONG_PRESS_MS + 1);
        expect(r.view[INPUT_INDEX.buttons]).toBe(2); // right button
        feed(r, up(1, 300, 300), LONG_PRESS_MS + 50);
        advance(r, LONG_PRESS_MS + 50 + TAP_HOLD_MS + 1);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });

    test("releasing the touch source clears whatever a gesture was holding", () => {
        const r = rig();
        feed(r, down(1, 100, 100), 0);
        feed(r, move(1, 200, 100), 40);
        expect(r.view[INPUT_INDEX.buttons]).toBe(1);
        // What handleBlur / input_reset do.
        r.device.releaseAllSources();
        r.device.commit({ immediate: true });
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });
});

describe("trackpad mode drives the guest relatively", () => {
    test("a drag moves the cursor by the finger delta and feeds DInput", () => {
        const r = rig("trackpad");
        r.device.setPointerAbsolute(100, 100);
        r.device.commit({ immediate: true });
        feed(r, down(1, 300, 300), 0);
        feed(r, move(1, 360, 340), 40);
        expect(r.view[INPUT_INDEX.mouseX]).toBe(160);
        expect(r.view[INPUT_INDEX.mouseY]).toBe(140);
        expect(r.view[INPUT_INDEX.dinputDX]).toBe(60);
        expect(r.view[INPUT_INDEX.dinputDY]).toBe(40);
    });

    test("a look drag presses nothing", () => {
        const r = rig("trackpad");
        feed(r, down(1, 300, 300), 0);
        feed(r, move(1, 400, 300), 40);
        expect(r.view[INPUT_INDEX.buttons]).toBe(0);
    });
});

describe("the cursor stays inside the guest", () => {
    test("relative motion cannot walk off the picture", () => {
        const r = rig("trackpad");
        feed(r, down(1, 10, 10), 0);
        for (let i = 1; i <= 20; i++) feed(r, move(1, 10 + i * 100, 10 + i * 100), i * 20);
        expect(r.view[INPUT_INDEX.mouseX]).toBeLessThanOrEqual(GUEST_W - 1);
        expect(r.view[INPUT_INDEX.mouseY]).toBeLessThanOrEqual(GUEST_H - 1);
        expect(r.view[INPUT_INDEX.mouseX]).toBeGreaterThanOrEqual(0);
    });
});
