/**
 * winmm joystick across a hot-plug. The MM driver is level-based: it always
 * reports the two standard analog ports, and the position calls answer whether a
 * stick is actually there. A pad that arrives mid-session must therefore start
 * working with no re-initialisation of any kind.
 *
 * Real System singleton + InputManager, no v86/DOM (see device-notify.test.ts).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { System } from "../../src/worker/core/system";
import { INPUT_BUFFER_SIZE, INPUT_INDEX, beginInputWrite, endInputWrite } from "../../src/input/sab-layout";
import { registerWinmmJoystickExports, resetWinmmJoystick } from "../../src/worker/modules/winmm-joystick";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const JOYERR_NOERROR = 0;
const JOYERR_UNPLUGGED = 167;
const JOYINFOEX_SIZE = 52;
const JOYCAPS_SIZE = 404;
const JOYCAPSW_SIZE = 728;

const joy: Record<string, ThunkImplementation> = {};
registerWinmmJoystickExports(joy);

const mem = new Uint8Array(0x10000);
const view = new DataView(mem.buffer);
const PJI = 0x1000;

function call(name: string, ...args: number[]): number {
    return joy[name]!({} as never, mem, args) as number;
}

/** joyGetPosEx wants dwSize prefilled by the caller. */
function posEx(port = 0): number {
    mem.fill(0, PJI, PJI + JOYINFOEX_SIZE);
    view.setUint32(PJI, JOYINFOEX_SIZE, true);
    return call("joyGetPosEx", port, PJI);
}

function setPad(connected: boolean, buttons = 0): void {
    const im = System.getInstance().inputManager;
    im.injectGamepadPresence(connected);
    if (!connected) return;
    const v = (im as unknown as { inputView: Int32Array }).inputView;
    beginInputWrite(v);
    v[INPUT_INDEX.gamepadButtons] = buttons;
    endInputWrite(v);
    im.poll(true);
}

describe("winmm joystick hot-plug", () => {
    beforeEach(() => {
        resetWinmmJoystick();
        const im = System.getInstance().inputManager;
        im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
        setPad(false); // seeds the presence tracker as "absent"
    });

    test("joyGetPosEx flips UNPLUGGED -> NOERROR on arrival with no re-init", () => {
        expect(posEx()).toBe(JOYERR_UNPLUGGED);
        setPad(true, 0b0101);
        expect(posEx()).toBe(JOYERR_NOERROR);
        expect(view.getUint32(PJI + 32, true)).toBe(0b0101); // dwButtons
        expect(view.getUint32(PJI + 36, true)).toBe(2);      // dwButtonNumber
    });

    test("removal puts joyGetPos/joyGetPosEx back to UNPLUGGED", () => {
        setPad(true);
        expect(posEx()).toBe(JOYERR_NOERROR);
        expect(call("joyGetPos", 0, PJI)).toBe(JOYERR_NOERROR);
        setPad(false);
        expect(posEx()).toBe(JOYERR_UNPLUGGED);
        expect(call("joyGetPos", 0, PJI)).toBe(JOYERR_UNPLUGGED);
    });

    test("joyGetNumDevs and joyGetDevCaps stay constant across the transition", () => {
        const caps = () => {
            mem.fill(0, PJI, PJI + JOYCAPS_SIZE);
            const rc = call("joyGetDevCapsA", 0, PJI, JOYCAPS_SIZE);
            return [rc, view.getUint32(PJI + 60, true), view.getUint32(PJI + 104, true)]; // wNumButtons, wNumAxes
        };
        const before = [call("joyGetNumDevs"), ...caps()];
        setPad(true);
        expect([call("joyGetNumDevs"), ...caps()]).toEqual(before);
        setPad(false);
        expect([call("joyGetNumDevs"), ...caps()]).toEqual(before);
    });

    // JOYCAPSW is not JOYCAPSA with a wide name: szPname/szRegKey/szOEMVxD all double,
    // so every UINT after szPname sits 32 bytes further along and sizeof is 728, not 404.
    // Serving both from one ANSI-layout writer hands a W caller a garbled name and garbage
    // ranges — silently, because nothing returns an error.
    test("joyGetDevCapsW uses the WIDE JOYCAPS layout, not the ANSI one", () => {
        setPad(true);

        mem.fill(0, PJI, PJI + JOYCAPSW_SIZE);
        expect(call("joyGetDevCapsW", 0, PJI, JOYCAPSW_SIZE)).toBe(JOYERR_NOERROR);

        // szPname is UTF-16: 'E' then a zero high byte, where ANSI would put 'm'.
        expect(mem[PJI + 4]).toBe("E".charCodeAt(0));
        expect(mem[PJI + 5]).toBe(0);
        expect(mem[PJI + 6]).toBe("m".charCodeAt(0));

        // Fixed fields live at 4 + 32*2 = 68, i.e. 32 bytes past their ANSI offsets.
        expect(view.getUint32(PJI + 68 + 4, true)).toBe(0xFFFF); // wXmax
        expect(view.getUint32(PJI + 68 + 24, true)).toBe(8);     // wNumButtons
        expect(view.getUint32(PJI + 68 + 68, true)).toBe(4);     // wNumAxes

        // ...and the ANSI slots they would have occupied stay zero.
        expect(view.getUint32(PJI + 60, true)).toBe(0);
        expect(view.getUint32(PJI + 104, true)).toBe(0);

        // A W caller must not have anything written past sizeof(JOYCAPSW).
        expect(mem[PJI + JOYCAPSW_SIZE]).toBe(0);
    });

    test("joySetCapture needs a present stick, and the capture survives an unplug", () => {
        const wm = System.getInstance().windowManager;
        const hwnd = wm.createWindow("T", "joy", 0x90000000, 0, 0, 0, 32, 32, 0, 0, 0, 0);

        expect(call("joySetCapture", hwnd, 0, 50, 0)).toBe(JOYERR_UNPLUGGED);
        setPad(true);
        expect(call("joySetCapture", hwnd, 0, 50, 0)).toBe(JOYERR_NOERROR);

        // Unplugging silences the poll but does NOT drop the capture — the port is
        // still captured, so joyReleaseCapture must still succeed afterwards.
        setPad(false);
        expect(call("joyReleaseCapture", 0)).toBe(JOYERR_NOERROR);
        wm.destroyWindow(hwnd);
    });
});
