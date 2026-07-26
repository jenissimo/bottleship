/**
 * WM_DEVICECHANGE announcement, end to end from the SAB presence slot:
 * InputManager.poll() edge -> DBT_DEVNODES_CHANGED broadcast to top-level windows
 * (+ the RegisterDeviceNotification registry that gates DBT_DEVICEARRIVAL).
 *
 * Runs against the real System singleton's WindowManager + InputManager — no v86,
 * no DOM. There is no guest process, so the DEV_BROADCAST_DEVICEINTERFACE payload
 * cannot be allocated and the targeted arrival is skipped by design; the registry
 * bookkeeping is asserted directly instead.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { System } from "../../src/worker/core/system";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";
import {
    getDeviceNotifications,
    registerDeviceNotification,
    resetDeviceNotifications,
    unregisterDeviceNotification,
} from "../../src/worker/modules/user32/device-notify";
import {
    DBT_DEVNODES_CHANGED,
    DEVICE_NOTIFY_ALL_INTERFACE_CLASSES,
    WM_DEVICECHANGE,
    encodeDevBroadcastDeviceInterface,
} from "../../src/worker/modules/user32/dev-broadcast";
import {
    resetLosableDevices,
    trackLosableDevice,
} from "../../src/worker/modules/dinput/device-presence";

const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;

const system = () => System.getInstance();

/** Drain the queue and keep only WM_DEVICECHANGE for the given windows. */
function drainDeviceChanges(hwnds: number[]): Array<{ hwnd: number; wParam: number; lParam: number }> {
    const wm = system().windowManager;
    const out: Array<{ hwnd: number; wParam: number; lParam: number }> = [];
    for (let i = 0; i < 500; i++) {
        const msg = wm.getMessage();
        if (!msg) break;
        if (msg.message === WM_DEVICECHANGE && hwnds.includes(msg.hwnd)) {
            out.push({ hwnd: msg.hwnd, wParam: msg.wParam >>> 0, lParam: msg.lParam >>> 0 });
        }
    }
    return out;
}

/** Arm the presence tracker at `connected` without announcing (first observation seeds). */
function seedPad(connected: boolean): void {
    const im = system().inputManager;
    im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    const r = im.injectGamepadPresence(connected);
    expect(r).toMatchObject({ ok: true, announced: false });
}

describe("gamepad hot-plug -> WM_DEVICECHANGE", () => {
    beforeEach(() => {
        resetDeviceNotifications();
        drainDeviceChanges([]); // clear anything a previous test left queued
    });

    test("an arrival broadcasts DBT_DEVNODES_CHANGED with lParam 0 to every top-level window", () => {
        const wm = system().windowManager;
        const a = wm.createWindow("T", "a", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        const b = wm.createWindow("T", "b", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        const child = wm.createWindow("T", "c", WS_CHILD | WS_VISIBLE, 0, 0, 0, 8, 8, a, 0, 0, 0);
        drainDeviceChanges([a, b, child]);

        seedPad(false);
        expect(system().inputManager.injectGamepadPresence(true)).toMatchObject({ announced: true });

        const msgs = drainDeviceChanges([a, b, child]);
        expect(msgs.map((m) => m.hwnd).sort()).toEqual([a, b].sort());
        for (const m of msgs) {
            expect(m.wParam).toBe(DBT_DEVNODES_CHANGED);
            expect(m.lParam).toBe(0); // DBT_DEVNODES_CHANGED carries no payload
        }
        wm.destroyWindow(a);
        wm.destroyWindow(b);
    });

    test("the pad asserted from boot is initial state — no phantom arrival", () => {
        const wm = system().windowManager;
        const a = wm.createWindow("T", "a", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        drainDeviceChanges([a]);

        seedPad(true); // the host asserts the virtual pad before the guest has windows
        expect(drainDeviceChanges([a])).toHaveLength(0);

        // ...and the later unplug IS announced.
        expect(system().inputManager.injectGamepadPresence(false)).toMatchObject({ announced: true });
        expect(drainDeviceChanges([a])).toHaveLength(1);
        wm.destroyWindow(a);
    });

    test("an unchanged level announces nothing", () => {
        const wm = system().windowManager;
        const a = wm.createWindow("T", "a", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        seedPad(false);
        drainDeviceChanges([a]);

        system().inputManager.injectGamepadPresence(true);
        drainDeviceChanges([a]);
        for (let i = 0; i < 3; i++) {
            expect(system().inputManager.injectGamepadPresence(true)).toMatchObject({ announced: false });
        }
        expect(drainDeviceChanges([a])).toHaveLength(0);
        wm.destroyWindow(a);
    });
});

describe("removal marks acquired DirectInput joysticks lost", () => {
    test("poll()'s removal edge sets DIERR_INPUTLOST state; the arrival edge does not clear it", () => {
        resetLosableDevices();
        const device = { acquired: true, inputLost: false };
        trackLosableDevice(device);

        seedPad(true);
        expect(device.inputLost).toBe(false);

        system().inputManager.injectGamepadPresence(false);
        expect(device.inputLost).toBe(true);

        device.inputLost = false; // stand in for the app's re-Acquire
        system().inputManager.injectGamepadPresence(true);
        expect(device.inputLost).toBe(false);
        resetLosableDevices();
    });
});

describe("RegisterDeviceNotification registry", () => {
    beforeEach(() => resetDeviceNotifications());

    /** Guest memory holding a HID DEV_BROADCAST_DEVICEINTERFACE filter at `ptr`. */
    function filterMem(ptr: number): Uint8Array {
        const f = encodeDevBroadcastDeviceInterface("", false);
        const mem = new Uint8Array(ptr + f.length + 16);
        mem.set(f, ptr);
        return mem;
    }

    test("a HID interface filter registers and unregisters exactly once", () => {
        const ptr = 0x200;
        const h = registerDeviceNotification(filterMem(ptr), 0x1234, ptr, 0, false);
        expect(h).toBeGreaterThan(0);
        expect(getDeviceNotifications()).toMatchObject([{ handle: h, hRecipient: 0x1234, unicode: false }]);
        expect(unregisterDeviceNotification(h)).toBe(true);
        expect(unregisterDeviceNotification(h)).toBe(false);
        expect(getDeviceNotifications()).toHaveLength(0);
    });

    test("a NULL recipient or a missing filter is rejected", () => {
        const ptr = 0x200;
        expect(registerDeviceNotification(filterMem(ptr), 0, ptr, 0, false)).toBe(0);
        expect(registerDeviceNotification(new Uint8Array(64), 0x1234, 0, 0, false)).toBe(0);
        expect(getDeviceNotifications()).toHaveLength(0);
    });

    test("DEVICE_NOTIFY_ALL_INTERFACE_CLASSES needs no filter and ignores the class GUID", () => {
        const h = registerDeviceNotification(
            new Uint8Array(64), 0x1234, 0, DEVICE_NOTIFY_ALL_INTERFACE_CLASSES, true);
        expect(h).toBeGreaterThan(0);
        expect(getDeviceNotifications()[0]).toMatchObject({ classGuid: null, unicode: true });
    });

    test("the W entry point records a wide registration", () => {
        const ptr = 0x200;
        const mem = filterMem(ptr);
        registerDeviceNotification(mem, 0x1, ptr, 0, false);
        registerDeviceNotification(mem, 0x2, ptr, 0, true);
        expect(getDeviceNotifications().map((r) => r.unicode)).toEqual([false, true]);
    });
});
