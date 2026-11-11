import { describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { DIK_TO_VK, vkToDik } from "../../src/worker/modules/dinput/dinput-vk-dik";
import { hardwareKeyVk } from "../../src/app/hardware-key-vk";
import { INPUT_BUFFER_SIZE, KEY_BITFIELD_BASE, beginInputWrite, endInputWrite } from "../../src/input/sab-layout";

const VK_CONTROL = 0x11, VK_RCONTROL = 0xa3, VK_RMENU = 0xa5, VK_RSHIFT = 0xa1;
const DIK_LCONTROL = 0x1d, DIK_RCONTROL = 0x9d, DIK_RMENU = 0xb8, DIK_RSHIFT = 0x36;

const noWindows = { getKeyboardTargetWindow: () => undefined } as never;

function rig() {
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const view = new Int32Array(sab);
    const im = new InputManager(noWindows);
    im.setInputBuffer(sab);
    im.setDInputKeyboardBufferSize(32);
    return { im, view };
}

function publishKeys(view: Int32Array, vks: readonly number[]): void {
    beginInputWrite(view);
    for (let w = 0; w < 8; w++) view[KEY_BITFIELD_BASE + w] = 0;
    for (const vk of vks) view[KEY_BITFIELD_BASE + (vk >> 5)] |= 1 << (vk & 31);
    endInputWrite(view);
}

function polledDiks(im: InputManager): number[] {
    const states = im.getKeyboardStateVk();
    const diks: number[] = [];
    for (let vk = 0; vk < states.length; vk++) {
        if (!states[vk]) continue;
        const dik = vkToDik(vk);
        if (dik !== null) diks.push(dik);
    }
    return diks.sort((a, b) => a - b);
}

describe("right-hand modifiers keep their own DirectInput scan code", () => {
    test("the browser's right Ctrl, Alt and Shift publish their side VK", () => {
        expect(hardwareKeyVk("ControlRight", 17)).toBe(VK_RCONTROL);
        expect(hardwareKeyVk("AltRight", 18)).toBe(VK_RMENU);
        expect(hardwareKeyVk("ShiftRight", 16)).toBe(VK_RSHIFT);
        expect(hardwareKeyVk("KeyA", 65)).toBe(65);
    });

    test("right Ctrl reads as DIK_RCONTROL, polled and buffered", () => {
        const r = rig();
        publishKeys(r.view, [hardwareKeyVk("ControlRight", 17)]);
        r.im.poll();
        expect(polledDiks(r.im)).toEqual([DIK_RCONTROL]);
        expect(r.im.drainDInputKeyboardEvents(16).map((e) => [e.dwOfs, e.dwData])).toEqual([[DIK_RCONTROL, 0x80]]);
        expect(DIK_TO_VK[DIK_RCONTROL]).toBe(VK_RCONTROL);
        expect(DIK_TO_VK[DIK_RMENU]).toBe(VK_RMENU);
        expect(DIK_TO_VK[DIK_RSHIFT]).toBe(VK_RSHIFT);
    });

    test("negative control: a sideless Ctrl still reads as the left key only", () => {
        const r = rig();
        publishKeys(r.view, [VK_CONTROL]);
        r.im.poll();
        expect(polledDiks(r.im)).toEqual([DIK_LCONTROL]);
        expect(r.im.drainDInputKeyboardEvents(16).map((e) => [e.dwOfs, e.dwData])).toEqual([[DIK_LCONTROL, 0x80]]);
    });
});
