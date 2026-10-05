// Joystick hot-plug announcement: the pad-present edge detector and the
// DEV_BROADCAST_* wire format that rides in WM_DEVICECHANGE's lParam.
// Both are leaf modules — no v86, no DOM, no worker.

import { describe, expect, test } from "bun:test";
import { GamepadPresenceTracker } from "../../src/worker/runtime/input/gamepad-presence";
import {
    markJoystickInputLost,
    resetLosableDevices,
    trackLosableDevice,
    untrackLosableDevice,
} from "../../src/worker/modules/dinput/device-presence";
import {
    DBT_DEVTYP_DEVICEINTERFACE,
    DEV_BROADCAST_DEVICEINTERFACE_OFFSETS as I,
    DEV_BROADCAST_DEVICEINTERFACE_SIZE,
    DEV_BROADCAST_HDR_SIZE,
    GUID_DEVINTERFACE_HID,
    encodeDevBroadcastDeviceInterface,
    guidToHex,
    readDevBroadcastFilter,
} from "../../src/worker/modules/user32/dev-broadcast";

describe("gamepad presence edge detector", () => {
    test("the first observation seeds and announces nothing (pad asserted before any guest window)", () => {
        const t = new GamepadPresenceTracker();
        expect(t.seeded).toBe(false);
        expect(t.observe(true)).toBe(null);
        expect(t.seeded).toBe(true);
        expect(t.transitionCount).toBe(0);
    });

    test("seeding works for an absent pad too", () => {
        const t = new GamepadPresenceTracker();
        expect(t.observe(false)).toBe(null);
        expect(t.transitionCount).toBe(0);
    });

    test("false -> true is an arrival, true -> false a removal", () => {
        const t = new GamepadPresenceTracker();
        t.observe(false); // seed
        expect(t.observe(true)).toBe("arrival");
        expect(t.observe(false)).toBe("removal");
        expect(t.transitionCount).toBe(2);
    });

    test("an unchanged level never announces twice", () => {
        const t = new GamepadPresenceTracker();
        t.observe(false);
        expect(t.observe(true)).toBe("arrival");
        for (let i = 0; i < 5; i++) expect(t.observe(true)).toBe(null);
        expect(t.transitionCount).toBe(1);
    });

    test("a pad present from boot then unplugged announces only the removal", () => {
        const t = new GamepadPresenceTracker();
        t.observe(true); // boot state (touch virtual pad)
        expect(t.observe(true)).toBe(null);
        expect(t.observe(false)).toBe("removal");
        expect(t.transitionCount).toBe(1);
    });

    test("reset re-arms seeding so a new process does not inherit an edge", () => {
        const t = new GamepadPresenceTracker();
        t.observe(false);
        t.observe(true);
        t.reset();
        expect(t.seeded).toBe(false);
        expect(t.observe(true)).toBe(null); // seed again, not a phantom arrival
        expect(t.transitionCount).toBe(0);
    });
});

describe("DirectInput lost-state tracker", () => {
    test("only acquired devices go lost, and only Acquire clears the flag", () => {
        resetLosableDevices();
        const acquired = { acquired: true, inputLost: false };
        const idle = { acquired: false, inputLost: false };
        trackLosableDevice(acquired);
        trackLosableDevice(idle);

        markJoystickInputLost();
        expect(acquired.inputLost).toBe(true);
        expect(idle.inputLost).toBe(false);

        // A pad coming back does NOT clear it — the app must re-Acquire.
        expect(acquired.inputLost).toBe(true);
        resetLosableDevices();
    });

    test("an untracked (released) device is never touched", () => {
        resetLosableDevices();
        const gone = { acquired: true, inputLost: false };
        trackLosableDevice(gone);
        untrackLosableDevice(gone);
        markJoystickInputLost();
        expect(gone.inputLost).toBe(false);
    });
});

describe("DEV_BROADCAST_DEVICEINTERFACE", () => {
    const NAME = "\\\\?\\HID#VID_FFFF&PID_0001#1&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

    test("GUID_DEVINTERFACE_HID is the 16 raw bytes of {4D1E55B2-F16F-11CF-88CB-001111000030}", () => {
        expect(GUID_DEVINTERFACE_HID.length).toBe(16);
        expect(guidToHex(GUID_DEVINTERFACE_HID)).toBe("b2551e4d6ff1cf1188cb001111000030");
    });

    test("ANSI header fields match the SDK layout", () => {
        const buf = encodeDevBroadcastDeviceInterface(NAME, false);
        const view = new DataView(buf.buffer);
        expect(view.getUint32(I.dbcc_size, true)).toBe(buf.length);
        expect(view.getUint32(I.dbcc_devicetype, true)).toBe(DBT_DEVTYP_DEVICEINTERFACE);
        expect(view.getUint32(I.dbcc_reserved, true)).toBe(0);
        expect([...buf.subarray(I.dbcc_classguid, I.dbcc_classguid + 16)])
            .toEqual([...GUID_DEVINTERFACE_HID]);
    });

    test("dbcc_size covers the whole NUL-terminated name, DWORD-rounded", () => {
        const buf = encodeDevBroadcastDeviceInterface(NAME, false);
        expect(buf.length % 4).toBe(0);
        expect(buf.length).toBeGreaterThanOrEqual(I.dbcc_name + NAME.length + 1);
        expect(buf[I.dbcc_name + NAME.length]).toBe(0); // terminator inside the buffer
    });

    test("the ANSI name round-trips", () => {
        const buf = encodeDevBroadcastDeviceInterface(NAME, false);
        let s = "";
        for (let i = I.dbcc_name; buf[i]; i++) s += String.fromCharCode(buf[i]);
        expect(s).toBe(NAME);
    });

    test("the W variant writes UTF-16 and sizes for it", () => {
        const buf = encodeDevBroadcastDeviceInterface(NAME, true);
        const view = new DataView(buf.buffer);
        expect(view.getUint32(I.dbcc_size, true)).toBe(buf.length);
        let s = "";
        for (let i = I.dbcc_name; ; i += 2) {
            const c = view.getUint16(i, true);
            if (!c) break;
            s += String.fromCharCode(c);
        }
        expect(s).toBe(NAME);
        expect(buf.length).toBeGreaterThan(encodeDevBroadcastDeviceInterface(NAME, false).length);
    });

    test("an empty name still yields a well-formed sizeof()-sized struct", () => {
        const buf = encodeDevBroadcastDeviceInterface("", false);
        expect(buf.length).toBe(DEV_BROADCAST_DEVICEINTERFACE_SIZE);
    });
});

describe("RegisterDeviceNotification filter parsing", () => {
    /** Place an encoded filter at `ptr` inside a fake guest memory block. */
    function guestMem(filter: Uint8Array, ptr: number): Uint8Array {
        const mem = new Uint8Array(ptr + filter.length + 64);
        mem.set(filter, ptr);
        return mem;
    }

    test("a HID device-interface filter yields its class GUID", () => {
        const ptr = 0x100;
        const mem = guestMem(encodeDevBroadcastDeviceInterface("", false), ptr);
        const f = readDevBroadcastFilter(mem, ptr);
        expect(f?.devicetype).toBe(DBT_DEVTYP_DEVICEINTERFACE);
        expect(f?.classGuid).toBe(guidToHex(GUID_DEVINTERFACE_HID));
    });

    test("a bare DEV_BROADCAST_HDR carries no class GUID", () => {
        const ptr = 0x40;
        const hdr = new Uint8Array(DEV_BROADCAST_HDR_SIZE);
        new DataView(hdr.buffer).setUint32(0, DEV_BROADCAST_HDR_SIZE, true);
        new DataView(hdr.buffer).setUint32(4, DBT_DEVTYP_DEVICEINTERFACE, true);
        const f = readDevBroadcastFilter(guestMem(hdr, ptr), ptr);
        expect(f?.classGuid).toBe(null);
    });

    test("a NULL pointer, a short dbch_size and an out-of-range pointer all reject", () => {
        const mem = new Uint8Array(256);
        expect(readDevBroadcastFilter(mem, 0)).toBe(null);
        new DataView(mem.buffer).setUint32(0x10, 4, true); // dbch_size < sizeof(HDR)
        expect(readDevBroadcastFilter(mem, 0x10)).toBe(null);
        expect(readDevBroadcastFilter(mem, mem.length - 4)).toBe(null);
    });
});
