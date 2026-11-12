import { describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { INPUT_BUFFER_SIZE, KEY_BITFIELD_BASE, beginInputWrite, endInputWrite } from "../../src/input/sab-layout";

const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101;
const VK_UP = 0x26, VK_A = 0x41;

function rig() {
    const posted: Array<{ msg: number; wParam: number }> = [];
    const win = { hwnd: 0x10001, rect: { x: 0, y: 0, width: 640, height: 480 }, visible: true };
    const wm = {
        getKeyboardTargetWindow: () => win,
        getMouseTargetWindow: () => win,
        getCaptureHwnd: () => 0,
        getWindow: () => win,
        getTopLevelAncestor: () => win.hwnd,
        getActiveHwnd: () => win.hwnd,
        setActiveWindow: () => { },
        postInputMessage: (_h: number, msg: number, wParam: number) => { posted.push({ msg, wParam }); },
    };
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const view = new Int32Array(sab);
    const im = new InputManager(wm as never);
    im.setInputBuffer(sab);
    const keys = () => posted.filter(p => p.msg === WM_KEYDOWN || p.msg === WM_KEYUP);
    return { im, view, keys };
}

function publishKeys(view: Int32Array, vks: readonly number[]): void {
    beginInputWrite(view);
    for (let w = 0; w < 8; w++) view[KEY_BITFIELD_BASE + w] = 0;
    for (const vk of vks) view[KEY_BITFIELD_BASE + (vk >> 5)]! |= 1 << (vk & 31);
    endInputWrite(view);
}

describe("keys held at capture", () => {
    test("are captured from what the host last reported", () => {
        const a = rig();
        expect(a.im.captureHeldKeys()).toEqual([]);
        publishKeys(a.view, [VK_UP, VK_A]);
        a.im.poll();
        expect(a.im.captureHeldKeys()).toEqual([VK_UP, VK_A]);
        publishKeys(a.view, [VK_A]);
        a.im.poll();
        expect(a.im.captureHeldKeys()).toEqual([VK_A]);
    });

    test("get their key-up from the first poll of a host that does not hold them", () => {
        const b = rig();
        b.im.restoreHeldKeys([VK_UP, VK_A]);
        expect(b.im.captureHeldKeys()).toEqual([VK_UP, VK_A]);
        expect(b.keys()).toEqual([]);
        b.im.poll();
        expect(b.keys()).toEqual([{ msg: WM_KEYUP, wParam: VK_UP }, { msg: WM_KEYUP, wParam: VK_A }]);
        expect(b.im.captureHeldKeys()).toEqual([]);
        b.im.poll();
        expect(b.keys().length).toBe(2);
    });

    test("stay down without a second key-down when the host still holds them", () => {
        const b = rig();
        publishKeys(b.view, [VK_UP]);
        b.im.restoreHeldKeys([VK_UP, VK_A]);
        b.im.poll();
        expect(b.keys()).toEqual([{ msg: WM_KEYUP, wParam: VK_A }]);
        expect(b.im.captureHeldKeys()).toEqual([VK_UP]);
    });

    test("buffered DirectInput gets the release too, baselined after the keys are back", () => {
        const b = rig();
        const lane = { size: 0, seq: 0, events: [], overflowed: false };
        b.im.restoreHeldKeys([VK_A]);
        b.im.restoreDInputBuffers({ mouse: lane, keyboard: { ...lane, size: 16 }, gamepad: lane });
        b.im.poll();
        expect(b.im.drainDInputKeyboardEvents(16).map(e => [e.dwOfs, e.dwData])).toEqual([[0x1e, 0]]);
    });

    test("a restore without held keys clears what the fresh session had seen", () => {
        const b = rig();
        publishKeys(b.view, [VK_A]);
        b.im.poll();
        b.im.restoreHeldKeys([]);
        expect(b.im.captureHeldKeys()).toEqual([]);
    });
});
