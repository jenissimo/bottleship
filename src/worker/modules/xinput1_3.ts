/**
 * XINPUT1_3.DLL — the Xbox 360 controller API, over the one emulated pad.
 *
 * The pad is described once, in `dinput/emulated-gamepad.ts`: four axes, sixteen buttons
 * in the browser Gamepad API's STANDARD MAPPING, one hat derived from the d-pad. This
 * module translates that into XInput's own shape rather than answering about the device a
 * second time — DirectInput, winmm's joystick and this must agree about how many buttons
 * exist and which one is pressed, or a control-config screen disagrees with the pad it
 * just read.
 *
 * XInput's shape differs from DirectInput's in ways that are the API, not our choice:
 *   - sThumbLY/sThumbRY are POSITIVE UP; the browser (and DIJOYSTATE) axis is positive
 *     down, so the Y axes are negated here and nowhere else.
 *   - the shoulder TRIGGERS are analog bytes, not buttons. Standard mapping publishes
 *     them as buttons 6/7, so we can honestly report only 0 or 255 — and
 *     XINPUT_CAPABILITIES reports the field as present, which is what it means.
 *   - the guide button is standard-mapping index 16, which the host publisher does not
 *     forward (it publishes 16 buttons, 0..15). XInputGetStateEx therefore never sets
 *     XINPUT_GAMEPAD_GUIDE. Claiming otherwise would be inventing input.
 *
 * With NO pad attached every device call answers ERROR_DEVICE_NOT_CONNECTED, which is what
 * a real Windows without a controller does and what sends a title to its keyboard path.
 * The one thing we must never do is answer ERROR_SUCCESS with a zeroed struct: the app
 * then believes in a controller that never moves and disables the input it does have.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { GAMEPAD_BUTTONS } from "./dinput/emulated-gamepad";

/** Win32 status codes XInput answers with. 0 is SUCCESS — nothing may default to it. */
const ERROR_SUCCESS = 0;
const ERROR_BAD_ARGUMENTS = 160;
const ERROR_DEVICE_NOT_CONNECTED = 1167;
const ERROR_EMPTY = 4306;

/** XUSER_MAX_COUNT. The host input layer models ONE pad, so only index 0 has a device. */
const XUSER_MAX_COUNT = 4;
const XUSER_INDEX_ANY = 0xff;

const XINPUT_FLAG_GAMEPAD = 0x00000001;

const XINPUT_DEVTYPE_GAMEPAD = 0x01;
const XINPUT_DEVSUBTYPE_GAMEPAD = 0x01;

const BATTERY_DEVTYPE_GAMEPAD = 0x00;
const BATTERY_TYPE_WIRED = 0x01;
const BATTERY_LEVEL_FULL = 0x03;

/** XINPUT_GAMEPAD.wButtons bits (xinput.h). */
const XINPUT_GAMEPAD_DPAD_UP = 0x0001;
const XINPUT_GAMEPAD_DPAD_DOWN = 0x0002;
const XINPUT_GAMEPAD_DPAD_LEFT = 0x0004;
const XINPUT_GAMEPAD_DPAD_RIGHT = 0x0008;
const XINPUT_GAMEPAD_START = 0x0010;
const XINPUT_GAMEPAD_BACK = 0x0020;
const XINPUT_GAMEPAD_LEFT_THUMB = 0x0040;
const XINPUT_GAMEPAD_RIGHT_THUMB = 0x0080;
const XINPUT_GAMEPAD_LEFT_SHOULDER = 0x0100;
const XINPUT_GAMEPAD_RIGHT_SHOULDER = 0x0200;
const XINPUT_GAMEPAD_A = 0x1000;
const XINPUT_GAMEPAD_B = 0x2000;
const XINPUT_GAMEPAD_X = 0x4000;
const XINPUT_GAMEPAD_Y = 0x8000;

/** Every bit this module can ever set — what GetCapabilities reports as "present". */
const SUPPORTED_BUTTONS =
    XINPUT_GAMEPAD_DPAD_UP | XINPUT_GAMEPAD_DPAD_DOWN | XINPUT_GAMEPAD_DPAD_LEFT | XINPUT_GAMEPAD_DPAD_RIGHT |
    XINPUT_GAMEPAD_START | XINPUT_GAMEPAD_BACK |
    XINPUT_GAMEPAD_LEFT_THUMB | XINPUT_GAMEPAD_RIGHT_THUMB |
    XINPUT_GAMEPAD_LEFT_SHOULDER | XINPUT_GAMEPAD_RIGHT_SHOULDER |
    XINPUT_GAMEPAD_A | XINPUT_GAMEPAD_B | XINPUT_GAMEPAD_X | XINPUT_GAMEPAD_Y;

/**
 * Standard-mapping button index → XINPUT_GAMEPAD bit. Indices 6 and 7 are the triggers,
 * which XInput reports as analog bytes and not as buttons, so they are absent here.
 */
const STANDARD_TO_XINPUT: ReadonlyArray<number> = [
    XINPUT_GAMEPAD_A,               // 0  bottom face
    XINPUT_GAMEPAD_B,               // 1  right face
    XINPUT_GAMEPAD_X,               // 2  left face
    XINPUT_GAMEPAD_Y,               // 3  top face
    XINPUT_GAMEPAD_LEFT_SHOULDER,   // 4
    XINPUT_GAMEPAD_RIGHT_SHOULDER,  // 5
    0,                              // 6  left trigger  -> bLeftTrigger
    0,                              // 7  right trigger -> bRightTrigger
    XINPUT_GAMEPAD_BACK,            // 8
    XINPUT_GAMEPAD_START,           // 9
    XINPUT_GAMEPAD_LEFT_THUMB,      // 10
    XINPUT_GAMEPAD_RIGHT_THUMB,     // 11
    XINPUT_GAMEPAD_DPAD_UP,         // 12
    XINPUT_GAMEPAD_DPAD_DOWN,       // 13
    XINPUT_GAMEPAD_DPAD_LEFT,       // 14
    XINPUT_GAMEPAD_DPAD_RIGHT,      // 15
];

const STANDARD_LEFT_TRIGGER = 6;
const STANDARD_RIGHT_TRIGGER = 7;

/** XINPUT_KEYSTROKE.Flags. */
const XINPUT_KEYSTROKE_KEYDOWN = 0x0001;
const XINPUT_KEYSTROKE_KEYUP = 0x0002;

/** VK_PAD_* virtual keys, in standard-mapping button order (xinput.h). */
const VK_PAD_FOR_BUTTON: ReadonlyArray<number> = [
    0x5800, // A
    0x5801, // B
    0x5802, // X
    0x5803, // Y
    0x5805, // LSHOULDER
    0x5804, // RSHOULDER
    0x5806, // LTRIGGER
    0x5807, // RTRIGGER
    0x5815, // BACK
    0x5814, // START
    0x5816, // LTHUMB_PRESS
    0x5817, // RTHUMB_PRESS
    0x5810, // DPAD_UP
    0x5811, // DPAD_DOWN
    0x5812, // DPAD_LEFT
    0x5813, // DPAD_RIGHT
];

/** VK_PAD_?THUMB_* for the eight directions, indexed by (vert+1)*3 + (horz+1). */
const VK_PAD_LTHUMB_DIR: ReadonlyArray<number> = [
    0x5827, 0x5821, 0x5826, // down-left, down, down-right
    0x5823, 0,      0x5822, // left, centred, right
    0x5824, 0x5820, 0x5825, // up-left, up, up-right
];
const VK_PAD_RTHUMB_DIR: ReadonlyArray<number> = [
    0x5837, 0x5831, 0x5836,
    0x5833, 0,      0x5832,
    0x5834, 0x5830, 0x5835,
];

/**
 * Struct field offsets, x86, natural alignment. The SDK layouts are pinned by
 * tools/validate-struct-offsets.ts against these tables — the emulator reads and writes
 * exactly these, so the gate checks the shipped numbers rather than a copy.
 */
export const XINPUT_GAMEPAD_OFFSETS = {
    wButtons: 0,
    bLeftTrigger: 2,
    bRightTrigger: 3,
    sThumbLX: 4,
    sThumbLY: 6,
    sThumbRX: 8,
    sThumbRY: 10,
};
export const XINPUT_STATE_OFFSETS = {
    dwPacketNumber: 0,
    Gamepad: 4,
};
export const XINPUT_VIBRATION_OFFSETS = {
    wLeftMotorSpeed: 0,
    wRightMotorSpeed: 2,
};
export const XINPUT_CAPABILITIES_OFFSETS = {
    Type: 0,
    SubType: 1,
    Flags: 2,
    Gamepad: 4,
    Vibration: 16,
};
export const XINPUT_BATTERY_INFORMATION_OFFSETS = {
    BatteryType: 0,
    BatteryLevel: 1,
};
export const XINPUT_KEYSTROKE_OFFSETS = {
    VirtualKey: 0,
    Unicode: 2,
    Flags: 4,
    UserIndex: 6,
    HidCode: 7,
};

const SIZEOF_XINPUT_GAMEPAD = 12;
const SIZEOF_XINPUT_STATE = 16;
const SIZEOF_XINPUT_VIBRATION = 4;
const SIZEOF_XINPUT_CAPABILITIES = 20;
const SIZEOF_XINPUT_BATTERY_INFORMATION = 2;
const SIZEOF_XINPUT_KEYSTROKE = 8;
const SIZEOF_GUID = 16;

/** The pad as XInput sees it. */
interface XInputSnapshot {
    connected: boolean;
    buttons: number;
    leftTrigger: number;
    rightTrigger: number;
    thumbLX: number;
    thumbLY: number;
    thumbRX: number;
    thumbRY: number;
}

const NEUTRAL: XInputSnapshot = {
    connected: false, buttons: 0, leftTrigger: 0, rightTrigger: 0,
    thumbLX: 0, thumbLY: 0, thumbRX: 0, thumbRY: 0,
};

/** SHORT range. The host clamps to ±32767, but a stick value is never trusted unclamped. */
function toThumb(value: number): number {
    const v = value | 0;
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** Deadzone-sized threshold for "the stick counts as pushed" in GetKeystroke. */
const XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE = 7849;
const XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE = 8689;

function thumbDirection(x: number, y: number, deadzone: number): number {
    const horz = x > deadzone ? 1 : x < -deadzone ? -1 : 0;
    const vert = y > deadzone ? 1 : y < -deadzone ? -1 : 0;
    return (vert + 1) * 3 + (horz + 1);
}

/** One keystroke waiting for XInputGetKeystroke. */
interface Keystroke {
    virtualKey: number;
    flags: number;
}

export class XInput1_3 implements IModule {
    name = "xinput1_3";
    exports: Record<string, ThunkImplementation> = {};

    /**
     * XInputEnable(FALSE) — the app is in the background. Windows then reports NEUTRAL
     * state and swallows vibration; it does NOT report the pad as gone, which is the
     * distinction a title uses to keep its "controller connected" UI honest.
     */
    private enabled = true;

    /**
     * dwPacketNumber. Contractually it changes ONLY when the state changed, which is how
     * a polling loop detects input without diffing 12 bytes itself. Bumping it every call
     * would be the fast-path-ledger failure in miniature: a plausible number that means
     * nothing.
     */
    private packetNumber = 0;
    private lastSnapshotKey = "";

    /** Keystroke edges, produced from the same snapshot GetState reports. */
    private keystrokes: Keystroke[] = [];
    private keystrokeButtons = 0;
    private keystrokeLeftDir = 4;
    private keystrokeRightDir = 4;
    private keystrokeSeeded = false;

    /** One line per export, on first use — this API is polled every frame. */
    private announced = new Set<string>();

    /**
     * Every export is spelled out twice — under its name AND under `ord_N` — because an
     * xinput import table carries ordinals, not names, and the two are separate keys in
     * the dispatch table. Written out one literal per line rather than through a helper
     * loop: the repo's coverage scanners read these assignments STATICALLY, and a name
     * assigned from a variable is invisible to them, so a fully working export reads as
     * "declared, no handler" in every census.
     */
    initialize(_process: Process): void {
        const exports = this.exports;

        const getState: ThunkImplementation = (_ctx, mem, args) =>
            this.getState(mem, args[0] >>> 0, args[1] >>> 0, false);
        exports["XInputGetState"] = getState;
        exports["ord_2"] = getState;

        const getStateEx: ThunkImplementation = (_ctx, mem, args) =>
            this.getState(mem, args[0] >>> 0, args[1] >>> 0, true);
        exports["XInputGetStateEx"] = getStateEx;
        exports["ord_100"] = getStateEx;

        const setState: ThunkImplementation = (_ctx, mem, args) =>
            this.setState(mem, args[0] >>> 0, args[1] >>> 0);
        exports["XInputSetState"] = setState;
        exports["ord_3"] = setState;

        const getCapabilities: ThunkImplementation = (_ctx, mem, args) =>
            this.getCapabilities(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0);
        exports["XInputGetCapabilities"] = getCapabilities;
        exports["ord_4"] = getCapabilities;

        const enable: ThunkImplementation = (_ctx, _mem, args) => {
            this.enabled = args[0] !== 0;
            this.announce("XInputEnable", `reporting ${this.enabled ? "enabled" : "disabled"}`);
            return 0; // void
        };
        exports["XInputEnable"] = enable;
        exports["ord_5"] = enable;

        const getDSoundGuids: ThunkImplementation = (_ctx, mem, args) =>
            this.getDSoundAudioDeviceGuids(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0);
        exports["XInputGetDSoundAudioDeviceGuids"] = getDSoundGuids;
        exports["ord_6"] = getDSoundGuids;

        const getBattery: ThunkImplementation = (_ctx, mem, args) =>
            this.getBatteryInformation(mem, args[0] >>> 0, args[1] & 0xff, args[2] >>> 0);
        exports["XInputGetBatteryInformation"] = getBattery;
        exports["ord_7"] = getBattery;

        const getKeystroke: ThunkImplementation = (_ctx, mem, args) =>
            this.getKeystroke(mem, args[0] >>> 0, args[2] >>> 0);
        exports["XInputGetKeystroke"] = getKeystroke;
        exports["ord_8"] = getKeystroke;

        // xinput1_4-only exports, reached through the version alias. XInputGetCapabilitiesEx
        // adds VID/PID to the same caps; XInputGetAudioDeviceIds is the WASAPI-era
        // replacement for the DirectSound GUIDs and has no device behind it here.
        const getCapabilitiesEx: ThunkImplementation = (_ctx, mem, args) =>
            this.getCapabilitiesEx(mem, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0);
        exports["XInputGetCapabilitiesEx"] = getCapabilitiesEx;
        exports["ord_108"] = getCapabilitiesEx;

        const getAudioDeviceIds: ThunkImplementation = (_ctx, _mem, args) =>
            this.getAudioDeviceIds(args[0] >>> 0);
        exports["XInputGetAudioDeviceIds"] = getAudioDeviceIds;
        exports["ord_10"] = getAudioDeviceIds;

        // DllMain: the loader runs our own initialization, so the guest never calls this.
        const dllMain: ThunkImplementation = () => 1;
        exports["DllMain"] = dllMain;
        exports["ord_1"] = dllMain;
    }

    private announce(name: string, detail: string): void {
        if (this.announced.has(name)) return;
        this.announced.add(name);
        Logger.log(LogCategory.SYSTEM, `xinput1_3:${name}: ${detail}`);
    }

    /**
     * The pad, in XInput's units. `guestRead` stamps the usage telemetry the host's
     * control-layout auto-select keys off; only a call the GUEST made may set it.
     */
    private snapshot(userIndex: number, guestRead: boolean): XInputSnapshot {
        // Exactly one device, on port 0 — the same rule winmm's joystick layer applies.
        // Mirroring the pad onto four indices would make an "enumerate all four slots"
        // scan find four players holding one physical stick.
        if (userIndex !== 0) return NEUTRAL;

        const inputManager = System.getInstance().inputManager;
        if (guestRead) inputManager.noteGuestGamepadRead();
        const pad = guestRead
            ? inputManager.getGamepadState()
            : inputManager.peekGamepadStateWithoutUsage();
        if (!pad.connected) return NEUTRAL;
        // Disabled reporting is a neutral CONNECTED pad, not a missing one.
        if (!this.enabled) return { ...NEUTRAL, connected: true };

        const raw = pad.buttons >>> 0;
        let buttons = 0;
        for (let i = 0; i < GAMEPAD_BUTTONS && i < STANDARD_TO_XINPUT.length; i++) {
            if (raw & (1 << i)) buttons |= STANDARD_TO_XINPUT[i]!;
        }
        return {
            connected: true,
            buttons,
            leftTrigger: (raw & (1 << STANDARD_LEFT_TRIGGER)) ? 0xff : 0,
            rightTrigger: (raw & (1 << STANDARD_RIGHT_TRIGGER)) ? 0xff : 0,
            thumbLX: toThumb(pad.axes[0]),
            // Positive is UP in XInput and DOWN in the browser mapping.
            thumbLY: toThumb(-pad.axes[1]),
            thumbRX: toThumb(pad.axes[2]),
            thumbRY: toThumb(-pad.axes[3]),
        };
    }

    /** True when `userIndex` names a slot at all (XUSER_INDEX_ANY is not valid for these). */
    private validIndex(userIndex: number): boolean {
        return userIndex < XUSER_MAX_COUNT && userIndex !== XUSER_INDEX_ANY;
    }

    private writeGamepad(base: number, pad: XInputSnapshot): void {
        const o = XINPUT_GAMEPAD_OFFSETS;
        Mem.writeUint16(base + o.wButtons, pad.buttons);
        Mem.writeUint8(base + o.bLeftTrigger, pad.leftTrigger);
        Mem.writeUint8(base + o.bRightTrigger, pad.rightTrigger);
        Mem.writeUint16(base + o.sThumbLX, pad.thumbLX & 0xffff);
        Mem.writeUint16(base + o.sThumbLY, pad.thumbLY & 0xffff);
        Mem.writeUint16(base + o.sThumbRX, pad.thumbRX & 0xffff);
        Mem.writeUint16(base + o.sThumbRY, pad.thumbRY & 0xffff);
    }

    private getState(mem: Uint8Array, userIndex: number, pState: number, ex: boolean): number {
        if (!this.validIndex(userIndex) || !pState) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pState, SIZEOF_XINPUT_STATE, "rw")) return ERROR_BAD_ARGUMENTS;

        const pad = this.snapshot(userIndex, true);
        if (!pad.connected) {
            this.announce(ex ? "XInputGetStateEx" : "XInputGetState",
                "no gamepad is connected — ERROR_DEVICE_NOT_CONNECTED");
            return ERROR_DEVICE_NOT_CONNECTED;
        }
        this.announce(ex ? "XInputGetStateEx" : "XInputGetState", "reporting the emulated pad");

        // The guide button is standard-mapping index 16, which the host does not publish,
        // so the Ex variant differs only in that it is allowed to carry a bit we never see.
        const key = `${pad.buttons}|${pad.leftTrigger}|${pad.rightTrigger}|`
            + `${pad.thumbLX}|${pad.thumbLY}|${pad.thumbRX}|${pad.thumbRY}`;
        if (key !== this.lastSnapshotKey) {
            this.lastSnapshotKey = key;
            this.packetNumber = (this.packetNumber + 1) >>> 0;
        }

        Mem.writeUint32(pState + XINPUT_STATE_OFFSETS.dwPacketNumber, this.packetNumber);
        this.writeGamepad(pState + XINPUT_STATE_OFFSETS.Gamepad, pad);
        return ERROR_SUCCESS;
    }

    /**
     * Vibration. The pad we model has no motors — XINPUT_CAPABILITIES reports zero speeds
     * for exactly that reason — and a motorless controller still answers ERROR_SUCCESS on
     * real hardware, so the app's rumble path is not a failure path.
     */
    private setState(mem: Uint8Array, userIndex: number, pVibration: number): number {
        if (!this.validIndex(userIndex) || !pVibration) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pVibration, SIZEOF_XINPUT_VIBRATION, "r")) return ERROR_BAD_ARGUMENTS;
        if (!this.snapshot(userIndex, false).connected) return ERROR_DEVICE_NOT_CONNECTED;
        this.announce("XInputSetState", "the emulated pad has no motors — accepted and discarded");
        return ERROR_SUCCESS;
    }

    private writeCapabilities(pCaps: number, pad: XInputSnapshot): void {
        const o = XINPUT_CAPABILITIES_OFFSETS;
        Mem.writeUint8(pCaps + o.Type, XINPUT_DEVTYPE_GAMEPAD);
        Mem.writeUint8(pCaps + o.SubType, XINPUT_DEVSUBTYPE_GAMEPAD);
        // No XINPUT_CAPS_*: no force feedback, not wireless, no voice, navigable.
        Mem.writeUint16(pCaps + o.Flags, 0);
        // The Gamepad member of CAPABILITIES is not a reading — each field carries the
        // MAXIMUM the device can report, i.e. which inputs exist. Triggers are digital
        // here but the byte is real, so 0xFF is the honest maximum.
        this.writeGamepad(pCaps + o.Gamepad, {
            ...pad,
            connected: true,
            buttons: SUPPORTED_BUTTONS,
            leftTrigger: 0xff,
            rightTrigger: 0xff,
            thumbLX: -1, thumbLY: -1, thumbRX: -1, thumbRY: -1,
        });
        // Zero motor speeds = no vibration hardware. Advertising motors we cannot drive is
        // how a title ends up waiting on rumble feedback that never arrives.
        Mem.writeUint16(pCaps + o.Vibration + XINPUT_VIBRATION_OFFSETS.wLeftMotorSpeed, 0);
        Mem.writeUint16(pCaps + o.Vibration + XINPUT_VIBRATION_OFFSETS.wRightMotorSpeed, 0);
    }

    private getCapabilities(mem: Uint8Array, userIndex: number, dwFlags: number, pCaps: number): number {
        if (!this.validIndex(userIndex) || !pCaps) return ERROR_BAD_ARGUMENTS;
        // Only XINPUT_FLAG_GAMEPAD (or 0, "any device") is defined.
        if (dwFlags !== 0 && dwFlags !== XINPUT_FLAG_GAMEPAD) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pCaps, SIZEOF_XINPUT_CAPABILITIES, "rw")) return ERROR_BAD_ARGUMENTS;

        const pad = this.snapshot(userIndex, false);
        if (!pad.connected) return ERROR_DEVICE_NOT_CONNECTED;
        this.announce("XInputGetCapabilities", "gamepad, no vibration motors, digital triggers");
        this.writeCapabilities(pCaps, pad);
        return ERROR_SUCCESS;
    }

    /** XINPUT_CAPABILITIES_EX: the same caps plus USB identity. */
    private getCapabilitiesEx(mem: Uint8Array, userIndex: number, dwFlags: number, pCaps: number): number {
        if (!this.validIndex(userIndex) || !pCaps) return ERROR_BAD_ARGUMENTS;
        if (dwFlags !== 0 && dwFlags !== XINPUT_FLAG_GAMEPAD) return ERROR_BAD_ARGUMENTS;
        // CAPABILITIES + VendorId/ProductId/VersionNumber/unk1 (WORDs) + unk2 (DWORD).
        if (!isValidAddress(mem, pCaps, SIZEOF_XINPUT_CAPABILITIES + 12, "rw")) return ERROR_BAD_ARGUMENTS;

        const pad = this.snapshot(userIndex, false);
        if (!pad.connected) return ERROR_DEVICE_NOT_CONNECTED;
        this.writeCapabilities(pCaps, pad);
        // The browser exposes no VID/PID for a standard-mapping pad, and inventing
        // Microsoft's would send a title down a per-device quirk path. Zero is "unknown".
        for (let off = SIZEOF_XINPUT_CAPABILITIES; off < SIZEOF_XINPUT_CAPABILITIES + 12; off += 4) {
            Mem.writeUint32(pCaps + off, 0);
        }
        return ERROR_SUCCESS;
    }

    /**
     * The headset render/capture endpoints. A pad with no headset attached answers
     * SUCCESS with GUID_NULL on real hardware — an outright failure would be read as
     * "the controller is gone".
     */
    private getDSoundAudioDeviceGuids(mem: Uint8Array, userIndex: number, pRender: number, pCapture: number): number {
        if (!this.validIndex(userIndex) || !pRender || !pCapture) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pRender, SIZEOF_GUID, "rw")) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pCapture, SIZEOF_GUID, "rw")) return ERROR_BAD_ARGUMENTS;
        if (!this.snapshot(userIndex, false).connected) return ERROR_DEVICE_NOT_CONNECTED;
        for (let off = 0; off < SIZEOF_GUID; off += 4) {
            Mem.writeUint32(pRender + off, 0);
            Mem.writeUint32(pCapture + off, 0);
        }
        return ERROR_SUCCESS;
    }

    /** xinput1_4's WASAPI-era replacement: no headset, so there are no endpoint ids. */
    private getAudioDeviceIds(userIndex: number): number {
        if (!this.validIndex(userIndex)) return ERROR_BAD_ARGUMENTS;
        if (!this.snapshot(userIndex, false).connected) return ERROR_DEVICE_NOT_CONNECTED;
        this.announce("XInputGetAudioDeviceIds", "no headset endpoint — ERROR_DEVICE_NOT_CONNECTED");
        // No audio device is attached to the pad; there is no "empty id" encoding, and a
        // caller that gets SUCCESS goes on to open a device by a string we never wrote.
        return ERROR_DEVICE_NOT_CONNECTED;
    }

    private getBatteryInformation(mem: Uint8Array, userIndex: number, devType: number, pInfo: number): number {
        if (!this.validIndex(userIndex) || !pInfo) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pInfo, SIZEOF_XINPUT_BATTERY_INFORMATION, "rw")) return ERROR_BAD_ARGUMENTS;
        if (!this.snapshot(userIndex, false).connected) return ERROR_DEVICE_NOT_CONNECTED;
        // Only the pad itself has power to report; a headset that does not exist has none.
        if (devType !== BATTERY_DEVTYPE_GAMEPAD) return ERROR_DEVICE_NOT_CONNECTED;
        // The Gamepad API exposes no battery. WIRED is the state with nothing to report —
        // ALKALINE/NIMH would invite a low-battery warning we can never clear.
        Mem.writeUint8(pInfo + XINPUT_BATTERY_INFORMATION_OFFSETS.BatteryType, BATTERY_TYPE_WIRED);
        Mem.writeUint8(pInfo + XINPUT_BATTERY_INFORMATION_OFFSETS.BatteryLevel, BATTERY_LEVEL_FULL);
        return ERROR_SUCCESS;
    }

    /**
     * Edge-detected keystrokes, from the same snapshot GetState reports so the two cannot
     * disagree about what is held. First observation SEEDS the state instead of emitting a
     * down for everything already pressed — a stale burst on the first poll is how a menu
     * jumps three rows before the player touches anything.
     */
    private pumpKeystrokes(userIndex: number): void {
        const pad = this.snapshot(userIndex, true);
        const buttonsWithTriggers = pad.buttons
            | (pad.leftTrigger ? 1 << 30 : 0)
            | (pad.rightTrigger ? 1 << 31 : 0);
        const leftDir = thumbDirection(pad.thumbLX, pad.thumbLY, XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE);
        const rightDir = thumbDirection(pad.thumbRX, pad.thumbRY, XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE);

        if (!this.keystrokeSeeded) {
            this.keystrokeSeeded = true;
            this.keystrokeButtons = buttonsWithTriggers;
            this.keystrokeLeftDir = leftDir;
            this.keystrokeRightDir = rightDir;
            return;
        }

        const changed = buttonsWithTriggers ^ this.keystrokeButtons;
        if (changed) {
            for (let i = 0; i < VK_PAD_FOR_BUTTON.length; i++) {
                const bit = i === STANDARD_LEFT_TRIGGER ? 1 << 30
                    : i === STANDARD_RIGHT_TRIGGER ? 1 << 31
                        : STANDARD_TO_XINPUT[i]!;
                if (!bit || !(changed & bit)) continue;
                this.keystrokes.push({
                    virtualKey: VK_PAD_FOR_BUTTON[i]!,
                    flags: (buttonsWithTriggers & bit) ? XINPUT_KEYSTROKE_KEYDOWN : XINPUT_KEYSTROKE_KEYUP,
                });
            }
            this.keystrokeButtons = buttonsWithTriggers;
        }

        const pushDir = (prev: number, next: number, table: ReadonlyArray<number>): void => {
            if (prev === next) return;
            if (table[prev]) this.keystrokes.push({ virtualKey: table[prev]!, flags: XINPUT_KEYSTROKE_KEYUP });
            if (table[next]) this.keystrokes.push({ virtualKey: table[next]!, flags: XINPUT_KEYSTROKE_KEYDOWN });
        };
        pushDir(this.keystrokeLeftDir, leftDir, VK_PAD_LTHUMB_DIR);
        pushDir(this.keystrokeRightDir, rightDir, VK_PAD_RTHUMB_DIR);
        this.keystrokeLeftDir = leftDir;
        this.keystrokeRightDir = rightDir;

        // A guest that stops draining must not grow the queue without bound; the oldest
        // edges are the ones it can no longer act on.
        const MAX_PENDING = 32;
        if (this.keystrokes.length > MAX_PENDING) {
            this.keystrokes.splice(0, this.keystrokes.length - MAX_PENDING);
        }
    }

    private getKeystroke(mem: Uint8Array, userIndex: number, pKeystroke: number): number {
        // XUSER_INDEX_ANY IS legal here — it means "whichever pad has an edge".
        const index = userIndex === XUSER_INDEX_ANY ? 0 : userIndex;
        if (!this.validIndex(index) || !pKeystroke) return ERROR_BAD_ARGUMENTS;
        if (!isValidAddress(mem, pKeystroke, SIZEOF_XINPUT_KEYSTROKE, "rw")) return ERROR_BAD_ARGUMENTS;

        if (!this.snapshot(index, false).connected) {
            this.keystrokes.length = 0;
            this.keystrokeSeeded = false;
            return ERROR_DEVICE_NOT_CONNECTED;
        }
        this.announce("XInputGetKeystroke", "edge-detecting VK_PAD_* from the emulated pad");

        this.pumpKeystrokes(index);
        const stroke = this.keystrokes.shift();
        if (!stroke) return ERROR_EMPTY;

        const o = XINPUT_KEYSTROKE_OFFSETS;
        Mem.writeUint16(pKeystroke + o.VirtualKey, stroke.virtualKey);
        Mem.writeUint16(pKeystroke + o.Unicode, 0);
        Mem.writeUint16(pKeystroke + o.Flags, stroke.flags);
        Mem.writeUint8(pKeystroke + o.UserIndex, index);
        Mem.writeUint8(pKeystroke + o.HidCode, 0);
        return ERROR_SUCCESS;
    }
}
