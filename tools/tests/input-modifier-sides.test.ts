// The keyboard record carries only the half of a modifier its producer knows about:
// a browser KeyboardEvent reports the SIDE-AGNOSTIC VK (keyCode 16/17/18), the
// on-screen keyboard the SIDE one (it needs a real left-hand scan code). Windows sets
// both, and every era game asks for one or the other — GetKeyState(VK_SHIFT) for
// shift-tab and shift-select, VK_LSHIFT/DIK_LSHIFT for engines that read scan codes.
// Also pins the DirectInput mouse baseline, whose absence made the first buffered read
// after SetProperty(DIPROP_BUFFERSIZE) report the whole cursor position as one delta.

import { describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import {
    INPUT_BUFFER_SIZE,
    INPUT_INDEX,
    KEY_BITFIELD_BASE,
    beginInputWrite,
    endInputWrite,
} from "../../src/input/sab-layout";

const VK_SHIFT = 0x10, VK_CONTROL = 0x11;
const VK_LSHIFT = 0xa0, VK_RSHIFT = 0xa1, VK_LCONTROL = 0xa2;
const DIK_LSHIFT = 0x2a;

/** No window is focused, so poll() stops after the state pass — which is the part
 *  every polled reader (GetKeyState / DirectInput) is served from. */
const noWindows = { getKeyboardTargetWindow: () => undefined } as never;

function rig() {
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const view = new Int32Array(sab);
    const im = new InputManager(noWindows);
    im.setInputBuffer(sab);
    return { im, view };
}

function publishKeys(view: Int32Array, vks: readonly number[]): void {
    beginInputWrite(view);
    for (let w = 0; w < 8; w++) view[KEY_BITFIELD_BASE + w] = 0;
    for (const vk of vks) view[KEY_BITFIELD_BASE + (vk >> 5)] |= 1 << (vk & 31);
    endInputWrite(view);
}

function publishCursor(view: Int32Array, x: number, y: number): void {
    beginInputWrite(view);
    view[INPUT_INDEX.mouseX] = x;
    view[INPUT_INDEX.mouseY] = y;
    endInputWrite(view);
}

const isDown = (im: InputManager, vk: number): boolean => (im.getKeyState(vk) & 0x8000) !== 0;

describe("a modifier is down under both its names", () => {
    test("an on-screen VK_LSHIFT answers GetKeyState(VK_SHIFT)", () => {
        const r = rig();
        publishKeys(r.view, [VK_LSHIFT]);
        r.im.poll();
        expect(isDown(r.im, VK_SHIFT)).toBe(true);
        expect(isDown(r.im, VK_LSHIFT)).toBe(true);
        // GetKeyboardState is served from the polled table, not the record.
        expect(r.im.getKeyboardStateVk()[VK_SHIFT]).toBe(0x80);
    });

    test("a hardware VK_CONTROL answers GetKeyState(VK_LCONTROL)", () => {
        const r = rig();
        publishKeys(r.view, [VK_CONTROL]);
        r.im.poll();
        expect(isDown(r.im, VK_LCONTROL)).toBe(true);
        expect(r.im.getKeyboardStateVk()[VK_LCONTROL]).toBe(0x80);
    });

    test("the right side never implies the left", () => {
        const r = rig();
        publishKeys(r.view, [VK_RSHIFT]);
        r.im.poll();
        expect(isDown(r.im, VK_SHIFT)).toBe(true);
        expect(isDown(r.im, VK_RSHIFT)).toBe(true);
        expect(isDown(r.im, VK_LSHIFT)).toBe(false);
        expect(r.im.getKeyboardStateVk()[VK_LSHIFT]).toBe(0);
    });

    test("release clears both halves", () => {
        const r = rig();
        publishKeys(r.view, [VK_LSHIFT]);
        r.im.poll();
        publishKeys(r.view, []);
        r.im.poll();
        expect(isDown(r.im, VK_SHIFT)).toBe(false);
        expect(isDown(r.im, VK_LSHIFT)).toBe(false);
    });

    test("an on-screen Shift produces the DirectInput scan code too", () => {
        const r = rig();
        r.im.setDInputKeyboardBufferSize(32);
        publishKeys(r.view, [VK_LSHIFT]);
        r.im.poll();
        const events = r.im.drainDInputKeyboardEvents(16);
        expect(events.map((e) => [e.dwOfs, e.dwData])).toEqual([[DIK_LSHIFT, 0x80]]);
    });
});

describe("DirectInput mouse buffering starts from where the cursor already is", () => {
    test("SetProperty(DIPROP_BUFFERSIZE) does not replay the standing position", () => {
        const r = rig();
        publishCursor(r.view, 400, 300);
        r.im.poll();

        r.im.setDInputMouseBufferSize(16);
        publishCursor(r.view, 402, 300);
        r.im.poll();

        const events = r.im.drainDInputMouseEvents(16);
        expect(events.map((e) => [e.dwOfs, e.dwData])).toEqual([[0, 2]]); // DIMOFS_X += 2
    });
});
