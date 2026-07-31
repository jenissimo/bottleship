/**
 * winmm joystick handlers (joyGetNumDevs / joyGetDevCaps / joyGetPos / joyGetPosEx /
 * joyGetThreshold / joySetThreshold / joySetCapture / joyReleaseCapture).
 *
 * The driver always reports the two standard analog ports (like the Win9x/NT
 * joystick driver does with nothing attached); whether a stick is actually there
 * is answered by the position calls — JOYERR_UNPLUGGED until the host gamepad
 * appears, and always for port 1, which has no device behind it. Axes are reported
 * over the full 0..65535 range declared in JOYCAPS.
 *
 * joySetCapture is a real capture: a timer-wheel poll posts MM_JOY*MOVE /
 * MM_JOY*BUTTONDOWN / MM_JOY*BUTTONUP to the captured window, which is the only
 * way message-driven (non-polling) games see the stick at all.
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { System } from '../core/system';
import { TimerKind } from '../core/scheduler/types';
import { TimeService } from '../runtime/time';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALPARAM = 11;
const JOYERR_NOERROR = 0;
const JOYERR_PARMS = 165;
const JOYERR_UNPLUGGED = 167;

const MM_JOY1MOVE = 0x3A0;
const MM_JOY1ZMOVE = 0x3A2;
const MM_JOY1BUTTONDOWN = 0x3B5;
const MM_JOY1BUTTONUP = 0x3B7;
/** MM_JOY2* sit one slot above their MM_JOY1* counterpart. */
const MM_JOY2_OFFSET = 1;

/** Ports the driver exposes; only these two have MM_JOY* messages. */
const JOY_PORTS = 2;
const AXIS_MIN = 0;
const AXIS_MAX = 0xFFFF;
/** Windows' default movement threshold for a fresh port. */
const DEFAULT_THRESHOLD = (AXIS_MAX - AXIS_MIN) >> 7;
const PERIOD_MIN = 10;
const PERIOD_MAX = 1000;
/** MAXPNAMELEN — szPname and szRegKey are both this many characters. */
const JOYCAPS_NAME_CHARS = 32;
// sizeof(JOYCAPSA) / sizeof(JOYCAPSW). The three string members (szPname, szRegKey,
// szOEMVxD = 32 + 32 + 260 chars) double in the wide struct, which also shifts every
// UINT field after szPname by 32 bytes — the two layouts share nothing but the leading
// wMid/wPid, so one writer must never serve both.
const JOYCAPSA_SIZE = 404;
const JOYCAPSW_SIZE = 728;
/** Below wMid+wPid there is nothing a caller could even receive. */
const JOYCAPS_MIN_SIZE = 4;
const JOYINFO_SIZE = 16;
const JOYINFOEX_SIZE = 52;

/** wParam button bits carried by MM_JOY* messages (JOY_BUTTON1..4 + their CHG flags).
 *  JOYINFO.wButtons is the same four bits; JOYINFOEX.dwButtons is the wider set. */
const JOY_BUTTON_MASK = 0x0F;
const JOY_BUTTON1CHG = 0x0100;
/** JOYCAPS.wNumButtons — nothing above it may appear in dwButtons/dwButtonNumber. */
const JOY_NUM_BUTTONS = 8;
const JOY_BUTTON_MASK_EX = (1 << JOY_NUM_BUTTONS) - 1;

interface JoyCapture {
    hwnd: number;
    /** Only post a message when the axis moved past the threshold. */
    changedOnly: boolean;
    timerId: number;
    x: number;
    y: number;
    z: number;
    buttons: number;
    /** Nothing has been posted yet — the first poll always reports. */
    primed: boolean;
}

const thresholds: number[] = new Array(JOY_PORTS).fill(DEFAULT_THRESHOLD);
const captures: Array<JoyCapture | null> = new Array(JOY_PORTS).fill(null);

/** Signed host axis (-32768..32767) → the 0..65535 range JOYCAPS declares. */
function toAxis(v: number): number {
    return Math.max(AXIS_MIN, Math.min(AXIS_MAX, (v | 0) + 0x8000));
}

function popcount(v: number): number {
    let n = 0;
    for (let b = v >>> 0; b; b >>>= 1) n += b & 1;
    return n;
}

interface JoyPos {
    connected: boolean;
    x: number; y: number; z: number; r: number;
    buttons: number;
}

const DISCONNECTED: JoyPos = { connected: false, x: 0, y: 0, z: 0, r: 0, buttons: 0 };

/**
 * Read a PORT. The host input layer models exactly one pad, so only port 0 has a
 * device behind it; port 1 must answer JOYERR_UNPLUGGED rather than mirror port 0 —
 * two identical CONNECTED sticks make a two-player title bind both players to the one
 * pad and a "highest connected port" scan pick the phantom.
 *
 * `guestRead` stamps the usage telemetry the host's control-layout auto-select keys off
 * ("this title steers with a pad"). Only a call the GUEST made may set it; the
 * joySetCapture pump is ours and takes the peek path.
 */
function readJoystick(joyId: number, guestRead: boolean): JoyPos {
    if (joyId !== 0) return DISCONNECTED;
    const inputManager = System.getInstance().inputManager;
    if (guestRead) inputManager.noteGuestGamepadRead();
    const input = guestRead
        ? inputManager.getGamepadState()
        : inputManager.peekGamepadStateWithoutUsage();
    const [ax0, ax1, ax2, ax3] = input.axes;
    return {
        connected: input.connected,
        x: toAxis(ax0), y: toAxis(ax1), z: toAxis(ax2), r: toAxis(ax3),
        buttons: (input.buttons >>> 0) & JOY_BUTTON_MASK_EX,
    };
}

function makeLParam(lo: number, hi: number): number {
    return (((hi & 0xFFFF) << 16) | (lo & 0xFFFF)) >>> 0;
}

/** MM_JOY2* for port 1, MM_JOY1* for port 0. */
function joyMsg(base: number, joyId: number): number {
    return base + (joyId === 1 ? MM_JOY2_OFFSET : 0);
}

function stopCapture(joyId: number): void {
    const cap = captures[joyId];
    if (!cap) return;
    if (cap.timerId !== 0) {
        System.getInstance().scheduler?.timerWheel.cancel(cap.timerId);
    }
    captures[joyId] = null;
}

/**
 * Capture poll: diff the stick against the last posted sample and emit the
 * MM_JOY* messages Windows would. Axis moves collapse into one MM_JOY*MOVE;
 * each button edge gets its own DOWN/UP with the JOY_BUTTONnCHG bit set.
 */
function pollCapture(joyId: number): void {
    const cap = captures[joyId];
    if (!cap) return;

    const pos = readJoystick(joyId, false);
    if (!pos.connected) return; // unplugged → the driver goes quiet

    const buttons = pos.buttons & JOY_BUTTON_MASK;
    const moved = !cap.changedOnly
        || Math.abs(pos.x - cap.x) > thresholds[joyId]!
        || Math.abs(pos.y - cap.y) > thresholds[joyId]!;
    const zMoved = !cap.changedOnly || Math.abs(pos.z - cap.z) > thresholds[joyId]!;
    const changedButtons = buttons ^ (cap.buttons & JOY_BUTTON_MASK);

    const wm = System.getInstance().windowManager;
    const xy = makeLParam(pos.x, pos.y);

    if (cap.primed || moved) {
        wm.postMessage(cap.hwnd, joyMsg(MM_JOY1MOVE, joyId), buttons, xy);
        cap.x = pos.x;
        cap.y = pos.y;
    }
    if (cap.primed || zMoved) {
        wm.postMessage(cap.hwnd, joyMsg(MM_JOY1ZMOVE, joyId), buttons, makeLParam(pos.z, 0));
        cap.z = pos.z;
    }
    for (let bit = 0; bit < 4; bit++) {
        const mask = 1 << bit;
        if (!(changedButtons & mask)) continue;
        const down = (buttons & mask) !== 0;
        wm.postMessage(
            cap.hwnd,
            joyMsg(down ? MM_JOY1BUTTONDOWN : MM_JOY1BUTTONUP, joyId),
            buttons | (JOY_BUTTON1CHG << bit),
            xy,
        );
    }
    cap.buttons = buttons;
    cap.primed = false;
}

export function registerWinmmJoystickExports(exports: Record<string, ThunkImplementation>): void {
        exports["joyGetNumDevs"] = () => {
            return JOY_PORTS;
        };

        const makeGetDevCaps = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const uJoyID = args[0];
            const pjc = args[1];
            const cbjc = args[2];
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (!pjc || cbjc < JOYCAPS_MIN_SIZE || pjc + cbjc > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // Callers pass sizeof(JOYCAPS) for their SDK version; never write past it.
            const fill = Math.min(cbjc, wide ? JOYCAPSW_SIZE : JOYCAPSA_SIZE);
            for (let i = 0; i < fill; i++) mem[pjc + i] = 0;
            const put = (off: number, v: number) => { if (off + 4 <= fill) view.setUint32(pjc + off, v, true); };

            view.setUint16(pjc + 0, 0xFFFF, true); // wMid
            view.setUint16(pjc + 2, 0x0001, true); // wPid
            const charSize = wide ? 2 : 1;
            const name = "Emulated Gamepad";
            for (let i = 0; i < name.length; i++) {
                const off = 4 + i * charSize;
                if (off + charSize > fill) break;
                if (wide) view.setUint16(pjc + off, name.charCodeAt(i), true);
                else mem[pjc + off] = name.charCodeAt(i);
            }
            // Everything past szPname sits `JOYCAPS_NAME_CHARS * charSize` from the top.
            const b = 4 + JOYCAPS_NAME_CHARS * charSize;
            put(b + 0,  AXIS_MIN);   // wXmin
            put(b + 4,  AXIS_MAX);   // wXmax
            put(b + 8,  AXIS_MIN);   // wYmin
            put(b + 12, AXIS_MAX);   // wYmax
            put(b + 16, AXIS_MIN);   // wZmin
            put(b + 20, AXIS_MAX);   // wZmax
            put(b + 24, JOY_NUM_BUTTONS); // wNumButtons
            put(b + 28, PERIOD_MIN); // wPeriodMin
            put(b + 32, PERIOD_MAX); // wPeriodMax
            put(b + 36, AXIS_MIN);   // wRmin
            put(b + 40, AXIS_MAX);   // wRmax
            put(b + 44, AXIS_MIN);   // wUmin
            put(b + 48, AXIS_MAX);   // wUmax
            put(b + 52, AXIS_MIN);   // wVmin
            put(b + 56, AXIS_MAX);   // wVmax
            put(b + 60, 0);          // wCaps — no POV/rudder reported
            put(b + 64, 4);          // wMaxAxes
            put(b + 68, 4);          // wNumAxes
            put(b + 72, JOY_NUM_BUTTONS); // wMaxButtons
            return MMSYSERR_NOERROR;
        };
        exports["joyGetDevCapsA"] = makeGetDevCaps(false);
        exports["joyGetDevCapsW"] = makeGetDevCaps(true);

        exports["joyGetPos"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const pji = args[1];
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (!pji || pji + JOYINFO_SIZE > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const pos = readJoystick(uJoyID, true);
            if (!pos.connected) return JOYERR_UNPLUGGED;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pji + 0, pos.x, true);       // wXpos
            view.setUint32(pji + 4, pos.y, true);       // wYpos
            view.setUint32(pji + 8, pos.z, true);       // wZpos
            view.setUint32(pji + 12, pos.buttons & JOY_BUTTON_MASK, true); // wButtons
            return JOYERR_NOERROR;
        };

        exports["joyGetPosEx"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const pji = args[1];
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (!pji || pji + JOYINFOEX_SIZE > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const size = view.getUint32(pji, true);
            if (size < JOYINFOEX_SIZE) {
                return MMSYSERR_INVALPARAM;
            }

            const pos = readJoystick(uJoyID, true);
            if (!pos.connected) {
                return JOYERR_UNPLUGGED;
            }

            view.setUint32(pji + 8, pos.x, true);  // dwXpos
            view.setUint32(pji + 12, pos.y, true); // dwYpos
            view.setUint32(pji + 16, pos.z, true); // dwZpos
            view.setUint32(pji + 20, pos.r, true); // dwRpos
            view.setUint32(pji + 24, 0, true); // dwUpos
            view.setUint32(pji + 28, 0, true); // dwVpos
            view.setUint32(pji + 32, pos.buttons, true); // dwButtons
            view.setUint32(pji + 36, popcount(pos.buttons), true); // dwButtonNumber
            view.setUint32(pji + 40, 0xFFFF, true); // dwPOV (centered)
            view.setUint32(pji + 44, 0, true); // dwReserved1
            view.setUint32(pji + 48, 0, true); // dwReserved2

            return JOYERR_NOERROR;
        };

        exports["joyGetThreshold"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const puThreshold = args[1];
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (!puThreshold || puThreshold + 4 > mem.length) return MMSYSERR_INVALPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(puThreshold, thresholds[uJoyID]!, true);
            return JOYERR_NOERROR;
        };

        exports["joySetThreshold"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            const uThreshold = args[1] >>> 0;
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (uThreshold > AXIS_MAX) return MMSYSERR_INVALPARAM;
            thresholds[uJoyID] = uThreshold;
            return JOYERR_NOERROR;
        };

        exports["joySetCapture"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            const uJoyID = args[1];
            const uPeriod = args[2] >>> 0;
            const fChanged = args[3] !== 0;
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;

            const system = System.getInstance();
            if (!hwnd || !system.windowManager.getWindow(hwnd)) return MMSYSERR_INVALPARAM;
            if (uPeriod < PERIOD_MIN || uPeriod > PERIOD_MAX) return MMSYSERR_INVALPARAM;
            if (!readJoystick(uJoyID, false).connected) return JOYERR_UNPLUGGED;

            const scheduler = system.scheduler;
            if (!scheduler) return JOYERR_PARMS;

            stopCapture(uJoyID); // re-capturing the same port replaces the old capture
            const cap: JoyCapture = {
                hwnd, changedOnly: fChanged, timerId: 0,
                x: 0, y: 0, z: 0, buttons: 0, primed: true,
            };
            captures[uJoyID] = cap;
            cap.timerId = scheduler.timerWheel.add(
                uPeriod, true, TimerKind.WINMM_TIMER,
                () => pollCapture(uJoyID),
                TimeService.getInstance().nowMs(),
            );
            return JOYERR_NOERROR;
        };

        exports["joyReleaseCapture"] = (ctx, mem, args) => {
            const uJoyID = args[0];
            if (uJoyID >= JOY_PORTS) return MMSYSERR_INVALPARAM;
            if (!captures[uJoyID]) return JOYERR_PARMS;
            stopCapture(uJoyID);
            return JOYERR_NOERROR;
        };
}

/** Drop captures so a fresh game doesn't inherit the previous process's timers. */
export function resetWinmmJoystick(): void {
    for (let i = 0; i < JOY_PORTS; i++) {
        stopCapture(i);
        thresholds[i] = DEFAULT_THRESHOLD;
    }
}
