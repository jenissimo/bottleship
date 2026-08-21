import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { dinputModule } from "../../api/dinput.api";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { readGuidFromMem } from "../../core/com/typelib/typelib-types";
import { BaseComObject, ComObjectFactory } from "../../core/com/base-com-object";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { Mem } from "../../core/memory/mem-accessor";
import { Marshaler } from "../../core/memory/marshaler";

import { allocateComObject } from "../../core/com/com-memory";
import { encodeAnsi } from "../codepage-utils";
import {
    ActionMapEntry,
    DIAF_OFS_GUID,
    buildObjIdForDevice,
    makeActionMapEntry,
    pollActionMapEntries,
} from "./dinput-action-helpers";
import { DIK_TO_VK, vkToDik } from "./dinput-vk-dik";
import { resetLosableDevices, trackLosableDevice, untrackLosableDevice } from "./device-presence";
import { clearExclusiveMouseOwners, setExclusiveMouseOwner } from "../../core/pointer-policy";
import { GUEST_INPUT_FLAG } from "../../../input/sab-layout";
import { DInputNotifyRegistry, DI_OK, DIERR_INVALIDPARAM } from "./dinput-notify";
import { GAMEPAD_BUTTONS, POV_CENTERED, gamepadPovAngle } from "./emulated-gamepad";

// DirectInput error codes (HRESULT = MAKE_HRESULT(ERROR, FACILITY_WIN32, win32err))
const DIERR_OUTOFMEMORY = 0x8007000E;
const DIERR_NOTACQUIRED = 0x8007000C; // ERROR_INVALID_ACCESS (0x0C)
const DIERR_INPUTLOST = 0x8007001E;   // ERROR_READ_FAULT (0x1E)
const DIERR_DEVICENOTREG = 0x80040154; // REGDB_E_CLASSNOTREG
const DI_NOTATTACHED = 0x00000001;     // S_FALSE — "the device is known but not attached"

// DI8 action-mapping constants (dinput.h) — keyboard semantics / defaults live in dinput-action-maps.ts
const DIDFT_BUTTON = 0x0000000c;
const DIACTION_OFS_FLAGS = 8;
const DIAH_DEFAULT = 0x00000020;
const DIA_APPMAPPED = 0x00000001;
const DIA_APPNOMAP = 0x00000002;
const DIDBAM_PRESERVE = 0x00000001;
const DIDBAM_HWDEFAULTS = 0x00000004;
const DIDSAM_NOUSER = 0x00000001;
const DIDSAM_FORCESAVE = 0x00000002;
// DIDFT_MAKEINSTANCE(n) = (WORD)n << 8 ; DIDFT_GETINSTANCE(n) = LOWORD(n >> 8)

// DI8 DIDEVICEOBJECTDATA is 20 bytes: dwOfs+dwData+dwTimeStamp+dwSequence+uAppData(UINT_PTR=4)
const DIDEVICEOBJECTDATA8_SIZE = 20;
// DIACTION field offsets: uAppData@0, dwSemantic@4, dwFlags@8, name@12, guidInstance@16(16),
// dwObjID@32, dwHow@36 (sizeof DIACTIONA = 40; sizeof DIACTIONFORMATA = 0x148, the RE'd stride)
const DIACTION_SIZE_DEFAULT = 40;
const DIACTION_OFS_UAPPDATA = 0;
const DIACTION_OFS_SEMANTIC = 4;
const DIACTION_OFS_OBJID = 32;
const DIACTION_OFS_HOW = 36;
// DIACTIONFORMAT field offsets: dwSize@0, dwActionSize@4, dwDataSize@8, dwNumActions@12, rgoAction@16
const DIAF_OFS_ACTIONSIZE = 4;
const DIAF_OFS_NUMACTIONS = 12;
const DIAF_OFS_RGOACTION = 16;

// DirectInput device types
// For DI8: DI8DEVTYPE_* (0x11-0x15)
// For DI5: DIDEVTYPE_* (1-4) - Re-Volt uses DI5 (version 0x500)
const DIDEVTYPE_DEVICE = 1;
const DIDEVTYPE_MOUSE = 2;
const DIDEVTYPE_KEYBOARD = 3;
const DIDEVTYPE_JOYSTICK = 4;
const DIDEVTYPE_GAMEPAD = 5;  // DI5 doesn't have gamepad, but define for safety

// DI8 device types (for future games)
const DI8DEVTYPE_DEVICE = 0x11;
const DI8DEVTYPE_MOUSE = 0x12;
const DI8DEVTYPE_KEYBOARD = 0x13;
const DI8DEVTYPE_JOYSTICK = 0x14;
const DI8DEVTYPE_GAMEPAD = 0x15;

// DIEDFL_* flags (EnumDevices filter flags)
const DIEDFL_ALLDEVICES = 0x00000000;
const DIEDFL_ATTACHEDONLY = 0x00000001;

// DIDEVICEINSTANCEA size for DirectInput 5 (version 0x500)
// Structure: dwSize(4) + guidInstance(16) + guidProduct(16) + dwDevType(4) +
//            tszInstanceName(260) + tszProductName(260) + guidFFDriver(16) = 576 bytes
const DIDEVICEINSTANCEA_SIZE = 580;
const DIMOUSESTATE_SIZE = 16;
const DIMOUSESTATE2_SIZE = 20;
const DIKEYBOARDSTATE_SIZE = 256;
const DIJOYSTATE_SIZE = 80;
const DIDEVICEOBJECTDATA_SIZE = 16; // DI5/7: dwOfs + dwData + dwTimeStamp + dwSequence

// DIMOFS_* offsets within DIMOUSESTATE
const DIMOFS_X = 0;
const DIMOFS_Y = 4;
const DIMOFS_Z = 8;
const DIMOFS_BUTTON0 = 12;
const DIMOFS_BUTTON1 = 13;
const DIMOFS_BUTTON2 = 14;
const DIMOFS_BUTTON3 = 15;
const DIMOFS_BUTTON4 = 16; // DIMOUSESTATE2 only
const DIMOFS_BUTTON5 = 17;
const DIMOFS_BUTTON6 = 18;
const DIMOFS_BUTTON7 = 19;

// DIPROP constants (MAKEDIPROP(n) — the "GUID" argument is just the integer)
const DIPROP_BUFFERSIZE = 1;
const DIPROP_AXISMODE = 2;
const DIPROP_GRANULARITY = 3;
const DIPROP_RANGE = 4;
const DIPROP_KEYNAME = 20;
/** sizeof(DIPROPSTRING) — DIPROPHEADER(16) + WCHAR wsz[MAX_PATH]. Always WIDE, even
 *  through the ANSI interface; DirectInput rejects any other dwSize. */
const DIPROPSTRING_SIZE = 16 + 260 * 2;
const DIPROPSTRING_MAX_CHARS = 260;
const DIPROPRANGE_NOMIN = 0x80000000;
const DIPROPRANGE_NOMAX = 0x7FFFFFFF;
const DIERR_UNSUPPORTED = 0x80004001; // E_NOTIMPL
const DIERR_OBJECTNOTFOUND = 0x80070002; // ERROR_FILE_NOT_FOUND as HRESULT

// DIDFT_* object-type bits (dinput.h) + DIPH_* addressing modes
const DIDFT_RELAXIS = 0x00000001;
const DIDFT_ABSAXIS = 0x00000002;
const DIDFT_PSHBUTTON = 0x00000004;
const DIDFT_POV = 0x00000010;
const DIPH_DEVICE = 0;
const DIPH_BYOFFSET = 1;
const DIPH_BYID = 2;
const DIDEVICEOBJECTINSTANCEA_SIZE = 316; // DX5+ A variant; DX3 subset is the first 288 bytes

// Object-type GUIDs (dinput.h), little-endian byte order
const GUID_XAXIS  = [0xE0, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_YAXIS  = [0xE1, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_ZAXIS  = [0xE2, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_RXAXIS = [0xF4, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_RYAXIS = [0xF5, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_BUTTON = [0xF0, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_POVOBJ = [0xF2, 0x02, 0x6D, 0xA3, 0xF3, 0xC9, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_KEY    = [0x20, 0x82, 0x72, 0x55, 0x3C, 0xD3, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];

interface DeviceObjectSpec {
    name: string;
    dwOfs: number;
    dwType: number; // DIDFT type bits | (instance << 8)
    guid: number[];
}

const DIK_SPECIAL_NAMES: Record<number, string> = {
    0x01: "Esc", 0x0E: "Backspace", 0x0F: "Tab", 0x1C: "Enter", 0x1D: "Left Ctrl",
    0x2A: "Left Shift", 0x38: "Left Alt", 0x39: "Space", 0x3A: "Caps Lock",
    0xC7: "Home", 0xC8: "Up", 0xC9: "PgUp", 0xCB: "Left", 0xCD: "Right",
    0xCF: "End", 0xD0: "Down", 0xD1: "PgDn", 0xD2: "Insert", 0xD3: "Delete",
};

function dikObjectName(dik: number): string {
    const special = DIK_SPECIAL_NAMES[dik];
    if (special) return special;
    const vk = DIK_TO_VK[dik];
    if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);          // digits
    if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);          // letters
    if (vk >= 0x70 && vk <= 0x7B) return "F" + (vk - 0x6F);                // F1..F12
    if (vk >= 0x60 && vk <= 0x69) return "Num " + (vk - 0x60);             // numpad
    return "Key 0x" + dik.toString(16).toUpperCase().padStart(2, "0");
}

/** Device object tables for EnumObjects/GetObjectInfo. dwOfs values MUST match the
 *  layouts GetDeviceState writes (DIMOUSESTATE2 / 256-byte keyboard / DIJOYSTATE). */
function getDeviceObjectSpecs(deviceType: string): DeviceObjectSpec[] {
    if (deviceType === "mouse") {
        const objs: DeviceObjectSpec[] = [
            { name: "X-axis", dwOfs: DIMOFS_X, dwType: DIDFT_RELAXIS | (0 << 8), guid: GUID_XAXIS },
            { name: "Y-axis", dwOfs: DIMOFS_Y, dwType: DIDFT_RELAXIS | (1 << 8), guid: GUID_YAXIS },
            { name: "Wheel",  dwOfs: DIMOFS_Z, dwType: DIDFT_RELAXIS | (2 << 8), guid: GUID_ZAXIS },
        ];
        for (let i = 0; i < 8; i++) {
            objs.push({ name: `Button ${i}`, dwOfs: DIMOFS_BUTTON0 + i, dwType: DIDFT_PSHBUTTON | ((3 + i) << 8), guid: GUID_BUTTON });
        }
        return objs;
    }
    if (deviceType === "keyboard") {
        const diks = Object.keys(DIK_TO_VK).map(Number).sort((a, b) => a - b);
        return diks.map(dik => ({
            name: dikObjectName(dik), dwOfs: dik, dwType: DIDFT_PSHBUTTON | (dik << 8), guid: GUID_KEY,
        }));
    }
    if (deviceType === "joystick" || deviceType === "gamepad") {
        const objs: DeviceObjectSpec[] = [
            { name: "X-axis",  dwOfs: 0,  dwType: DIDFT_ABSAXIS | (0 << 8), guid: GUID_XAXIS },
            { name: "Y-axis",  dwOfs: 4,  dwType: DIDFT_ABSAXIS | (1 << 8), guid: GUID_YAXIS },
            { name: "Rx-axis", dwOfs: 12, dwType: DIDFT_ABSAXIS | (2 << 8), guid: GUID_RXAXIS },
            { name: "Ry-axis", dwOfs: 16, dwType: DIDFT_ABSAXIS | (3 << 8), guid: GUID_RYAXIS },
            { name: "POV",     dwOfs: 32, dwType: DIDFT_POV     | (4 << 8), guid: GUID_POVOBJ },
        ];
        for (let i = 0; i < GAMEPAD_BUTTONS; i++) {
            objs.push({ name: `Button ${i}`, dwOfs: 48 + i, dwType: DIDFT_PSHBUTTON | ((5 + i) << 8), guid: GUID_BUTTON });
        }
        return objs;
    }
    return [];
}

/**
 * DIDEVCAPS dwAxes/dwButtons/dwPOVs, counted off the very table EnumObjects walks.
 * A device that enumerates objects it says it does not have (or the reverse) sends a
 * key-binding screen blank and makes an engine testing `dwAxes >= 2` reject the stick
 * and fall back to the keyboard — with no error for anyone to see.
 */
function countDeviceObjects(deviceType: string): { axes: number; buttons: number; povs: number } {
    let axes = 0, buttons = 0, povs = 0;
    for (const o of getDeviceObjectSpecs(deviceType)) {
        if (o.dwType & (DIDFT_ABSAXIS | DIDFT_RELAXIS)) axes++;
        else if (o.dwType & DIDFT_PSHBUTTON) buttons++;
        else if (o.dwType & DIDFT_POV) povs++;
    }
    return { axes, buttons, povs };
}

/** DIPROPHEADER dwObj/dwHow addressing, shared by GetObjectInfo and the per-object
 *  properties. DIPH_BYID compares the instance number and the type bits the caller asked
 *  for; DIPH_DEVICE addresses the device itself and names no object. */
function findDeviceObject(
    objects: DeviceObjectSpec[], dwObj: number, dwHow: number,
): DeviceObjectSpec | undefined {
    if (dwHow === DIPH_BYOFFSET) return objects.find(o => o.dwOfs === dwObj);
    if (dwHow === DIPH_BYID) {
        return objects.find(o =>
            (o.dwType & 0xFF00) === (dwObj & 0xFF00) &&
            ((dwObj & 0xFF & o.dwType) !== 0 || (dwObj & 0xFF) === 0));
    }
    return undefined;
}

// DIDEVCAPS.dwFlags bits (dinput.h). Games gate device presence on DIDC_ATTACHED —
// a mouse/keyboard reported without it reads as "not attached" and engines abort init.
const DIDC_ATTACHED = 0x00000001;

// SetCooperativeLevel flags (dinput.h). Exclusive-mode mouse acquisition implicitly
// captures the cursor on real Windows — we mirror it into host pointer-lock.
const DISCL_EXCLUSIVE = 0x00000001;

// GetDeviceData flags
const DIGDD_PEEK = 0x00000001;

const DI_BUFFEROVERFLOW = 0x00000001;

const GUID_SYS_KEYBOARD = [0x61, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_SYS_MOUSE = [0x60, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
const GUID_SYS_GAMEPAD = [0x70, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];

// IID for IDirectInputDevice8A (returned by IDirectInput8::CreateDevice / EnumDevicesBySemantics)
const IID_IDIRECTINPUTDEVICE8A = "54d41080-dc15-4833-a41b-748f73a38179";
const IID_IDIRECTINPUTDEVICE8W = "54d41081-dc15-4833-a41b-748f73a38179";
const IID_IDIRECTINPUT8A = "bf798030-483a-4da2-aa99-5d64ed369700";
const IID_IDIRECTINPUT8W = "bf798031-483a-4da2-aa99-5d64ed369700";

// Every IID a real dinput device object answers to: the whole ANSI chain, the whole UNICODE
// chain, and IUnknown. Both families are served by one object here because the two vtable
// layouts are identical — only the string flavour of the info/enum methods differs.
const DEVICE_QI_IIDS = new Set([
    "00000000-0000-0000-c000-000000000046", // IUnknown
    "5944e680-c92e-11cf-bfc7-444553540000", // IDirectInputDeviceA
    "5944e682-c92e-11cf-bfc7-444553540000", // IDirectInputDevice2A
    "57d7c6bc-2356-11d3-8e9d-00c04f6844ae", // IDirectInputDevice7A
    IID_IDIRECTINPUTDEVICE8A,
    "5944e681-c92e-11cf-bfc7-444553540000", // IDirectInputDeviceW
    "5944e683-c92e-11cf-bfc7-444553540000", // IDirectInputDevice2W
    "57d7c6bd-2356-11d3-8e9d-00c04f6844ae", // IDirectInputDevice7W
    IID_IDIRECTINPUTDEVICE8W,
]);

// One mapped action recorded from SetActionMap (see dinput-action-helpers.ts ActionMapEntry).

interface SavedActionBinding {
    uAppData: number;
    semantic: number;
    objId: number;
    how: number;
}

// Stub methods for IDirectInputA (methods that just return DI_OK).
// GetDeviceStatus is NOT here: DI_OK means "that device is attached right now", and
// answering it for a pad nobody plugged in makes a game take the joystick path and read
// a permanently neutral stick instead of falling back to the keyboard.
const IDirectInputA_StubMethods = ["RunControlPanel", "Initialize"];

/** Every IID an IDirectInput object answers to. The DX3/5/7 A and W chains share one
 *  vtable shape here; the DX8 interfaces are separate objects with their own tables and
 *  are deliberately NOT reachable through this QueryInterface. */
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";
const IID_IDIRECTINPUTA = "89521360-aa8a-11cf-bfc7-444553540000";
const IID_IDIRECTINPUTW = "89521361-aa8a-11cf-bfc7-444553540000";
/** The only pre-DI8 IID with a registered factory; its vtable is a superset of 2A/7W. */
const IID_IDIRECTINPUT7A = "9a4cb684-236d-11d3-8e9d-00c04f6844ae";
const DIRECTINPUT_QI_IIDS = new Set([
    IID_IUNKNOWN,
    IID_IDIRECTINPUTA,
    IID_IDIRECTINPUTW,
    "5944e662-aa8a-11cf-bfc7-444553540000", // IDirectInput2A
    "5944e663-aa8a-11cf-bfc7-444553540000", // IDirectInput2W
    IID_IDIRECTINPUT7A,
    "9a4cb685-236d-11d3-8e9d-00c04f6844ae", // IDirectInput7W
]);

// Stub methods for IDirectInputDeviceA (methods that just return DI_OK).
// EnumObjects/GetObjectInfo are NOT here — they have real implementations below;
// a DI_OK stub that leaves the caller's out-struct untouched is the bug class that
// broke Max Payne (GetProperty granularity → 0 divisor → NaN wheel tracker).
const IDirectInputDeviceA_StubMethods = ["RunControlPanel", "Initialize"];

// Stub methods for IDirectInputDevice2A (methods that just return DI_OK). Only the two
// enumerations are here, and only because an enumeration over an empty set IS a success
// that calls back zero times. Everything else in the force-feedback group answers
// DIERR_UNSUPPORTED below — GetCaps never reports DIDC_FORCEFEEDBACK, so a DI_OK that
// leaves an effect pointer or a state DWORD untouched contradicts our own capabilities
// and hands the caller its own stack to dispatch through.
const IDirectInputDevice2A_StubMethods = ["EnumEffects", "EnumCreatedEffectObjects"];

/** Devices with an armed SetEventNotification handle. */
const notifyRegistry = new DInputNotifyRegistry({
    setEvent: (handle) => System.getInstance().scheduler.setEvent(handle),
});

/** Every live device object, for the harness `dinputState` readout. */
const liveDInputDevices = new Set<DirectInputDeviceObject>();

/**
 * What DirectInput currently believes about each device. Cooperative level and acquisition
 * are what decide whether the host grabs the pointer at all, and neither is visible in a
 * screenshot: a game reading a NONEXCLUSIVE mouse looks exactly like one whose capture
 * broke. The log line that carries it scrolls out of the ring within seconds of boot.
 */
export function describeDInputDevices(): Array<Record<string, unknown>> {
    return [...liveDInputDevices].map(d => ({
        deviceType: d.deviceType,
        dataFormat: d.dataFormat,
        acquired: d.acquired,
        exclusive: d.exclusive,
        inputLost: d.inputLost,
        notifyEvent: d.notifyEvent ? `0x${d.notifyEvent.toString(16)}` : 0,
        isActionMapped: d.isActionMapped,
    }));
}

/**
 * DirectInput COM object implementation
 */
class DirectInputObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super("89521360-AA8A-11CF-BFC7-444553540000", vtableAddress); // IDirectInputA IID
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectInputObject destroyed");
    }
}

/**
 * DirectInputDevice COM object implementation
 */
type DeviceKind = "keyboard" | "mouse" | "joystick" | "gamepad" | "unknown";

class DirectInputDeviceObject extends BaseComObject {
    private _deviceType: DeviceKind = "unknown";
    /** Assignment keeps the hot-plug tracker in sync: only a joystick/gamepad has
     *  backing hardware that can vanish mid-session. */
    get deviceType(): DeviceKind { return this._deviceType; }
    set deviceType(kind: DeviceKind) {
        this._deviceType = kind;
        if (kind === "joystick" || kind === "gamepad") trackLosableDevice(this);
        else untrackLosableDevice(this);
    }
    public dataFormat: DeviceKind = "unknown";
    public dataSize = 0;
    public acquired = false;
    /** Set when the pad was unplugged while acquired; cleared by Acquire. */
    public inputLost = false;
    public exclusive = false;  // DISCL_EXCLUSIVE requested via SetCooperativeLevel
    public lastMouseX = 0;
    public lastMouseY = 0;
    public lastDInputAccumX = 0;  // last-seen value of the SAB running accumulator
    public lastDInputAccumY = 0;
    public mouseInitialized = false;
    /** Event handle SetEventNotification armed, or 0. Signalled whenever this device's
     *  buffer gains data — the app's input thread waits on it instead of polling. */
    public notifyEvent = 0;

    // DI8 action-mapping state (set by SetActionMap, consumed by the buffered GetDeviceData path).
    public isActionMapped = false;
    public actionMap: ActionMapEntry[] = [];
    public actionMapGuid = "";           // guidActionMap string for registry round-trip
    public seq = 0;                      // DIDEVICEOBJECTDATA dwSequence counter
    public mousePollPrevButtons = 0;     // for action-mapped mouse button edges
    /** Latch epoch this device has already observed — see DInput.readMouseButtons. */
    public mouseLatchEpoch = -1;

    constructor(vtableAddress: number, iid: string = "5944e680-c92e-11cf-bfc7-444553540000") {
        super(iid, vtableAddress); // default: IDirectInputDeviceA IID
        liveDInputDevices.add(this);
    }

    protected destroy(): void {
        untrackLosableDevice(this);
        // A device released while still acquired ends its acquisition; without this the
        // pointer stays suppressed for the rest of the run.
        setExclusiveMouseOwner(this, false);
        liveDInputDevices.delete(this);
        notifyRegistry.forget(this);
        Logger.verbose(LogCategory.COM, "DirectInputDeviceObject destroyed");
    }
}

export class DInput implements IModule {
    name = "dinput";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    vtables: Record<string, VTableInfo> = {};
    /** Per-user/device/action-map GUID saved bindings (SetActionMap round-trip). */
    private savedActionMaps = new Map<string, SavedActionBinding[]>();
    /** Drained-but-undelivered mouse button edge, and the epoch identifying it. */
    private latchedMouseEdges = 0;
    private mouseLatchEpoch = 0;

    initialize(process: Process): void {
        this.process = process;
        const resourceProvider = SystemResourceProvider.getInstance();

        // Register interfaces in InterfaceRegistry
        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(dinputModule);

        // Create VTables for COM interfaces
        this.vtables = createVTablesFromDescriptor(this.process, dinputModule);

        // Log vtable addresses for debugging
        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.SYSTEM, `DirectInput: Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        // Register COM object factories
        ComObjectFactory.register("89521360-AA8A-11CF-BFC7-444553540000", DirectInputObject); // IDirectInputA
        ComObjectFactory.register(IID_IDIRECTINPUT7A, DirectInputObject);
        ComObjectFactory.register(IID_IDIRECTINPUT8A, DirectInputObject); // IDirectInput8A
        ComObjectFactory.register(IID_IDIRECTINPUT8W, DirectInputObject); // IDirectInput8W
        ComObjectFactory.register("5944e680-c92e-11cf-bfc7-444553540000", DirectInputDeviceObject); // IDirectInputDeviceA
        ComObjectFactory.register("5944e682-c92e-11cf-bfc7-444553540000", DirectInputDeviceObject); // IDirectInputDevice2A
        ComObjectFactory.register(IID_IDIRECTINPUTDEVICE8A, DirectInputDeviceObject); // IDirectInputDevice8A
        ComObjectFactory.register(IID_IDIRECTINPUTDEVICE8W, DirectInputDeviceObject); // IDirectInputDevice8W

        // DirectInputCreateA - create DirectInput object
        this.exports["DirectInputCreateA"] = (ctx, mem, args) => {
            const hinst = args[0];
            const dwVersion = args[1];
            const ppDI = args[2];

            Logger.log(LogCategory.SYSTEM, `DirectInputCreateA called: hinst=0x${hinst.toString(16)}, dwVersion=${dwVersion}, ppDI=0x${ppDI.toString(16)}`);

            if (!ppDI) return DIERR_INVALIDPARAM;

            // DirectInputCreateA names no IID — it is defined to return IDirectInputA.
            const vtableAddr = this.vtables.IDirectInputA.address;
            const obj = ComObjectFactory.create("89521360-AA8A-11CF-BFC7-444553540000", vtableAddr);
            if (!obj) return DIERR_OUTOFMEMORY;

            const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            view.setUint32(ppDI, objAddr, true);

            resourceProvider.mapAddressToHandle(objAddr, obj.handle);

            Logger.log(LogCategory.SYSTEM, `DirectInputCreateA -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
            return DI_OK;
        };

        // DirectInputCreateEx - create DirectInput object with specific IID
        this.exports["DirectInputCreateEx"] = (ctx, mem, args) => {
            const hinst = args[0];
            const dwVersion = args[1];
            const ppvOut = args[3];

            const riidBytes = args[2] ? this.readGuidBytes(mem, args[2]) : null;
            const riidStr = riidBytes
                ? Array.from(riidBytes).map(b => b.toString(16).padStart(2, "0")).join("")
                : "(null)";
            Logger.log(LogCategory.SYSTEM, `DirectInputCreateEx called: hinst=0x${hinst.toString(16)}, dwVersion=0x${dwVersion.toString(16)}, riid=${riidStr}, ppvOut=0x${ppvOut.toString(16)}`);

            if (!ppvOut) return DIERR_INVALIDPARAM;

            // Honour the requested interface. IID_IDirectInput2A/7A carry FindDevice and
            // CreateDeviceEx past the end of the IDirectInputA vtable, and a guest that
            // calls one on the short vtable reads adjacent stub bytes as a function
            // pointer (EIP=0xb077ba00) — the same defect the IDirectInput8A note below
            // describes, one interface generation earlier. Gothic asks for
            // IID_IDirectInput7A and calls CreateDeviceEx at index 9 immediately.
            const { iid, vtableName } = this.resolveDirectInputCreateExInterface(mem, args[2]);
            const vtableAddr = this.vtables[vtableName]?.address;
            if (!vtableAddr) return DIERR_OUTOFMEMORY;
            const obj = ComObjectFactory.create(iid, vtableAddr);
            if (!obj) return DIERR_OUTOFMEMORY;

            const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            view.setUint32(ppvOut, objAddr, true);

            resourceProvider.mapAddressToHandle(objAddr, obj.handle);

            Logger.log(LogCategory.SYSTEM,
                `DirectInputCreateEx -> 0x${objAddr.toString(16)} (${vtableName}, handle=0x${obj.handle.toString(16)})`);
            return DI_OK;
        };

        // DirectInput8Create (dinput8.dll entry point) — MUST return an IDirectInput8A
        // object, whose vtable includes the DX8-only methods FindDevice(8),
        // EnumDevicesBySemantics(9) and ConfigureDevices(10). Returning the shorter DX7
        // IDirectInputA vtable here caused NFSU to call vtable[9] (EnumDevicesBySemantics,
        // offset 0x24) past the vtable end → wild indirect call (freeze / WASM OOB).
        this.exports["DirectInput8Create"] = (ctx, mem, args) => {
            const riidPtr = args[2];
            const ppvOut = args[3];
            Logger.log(LogCategory.SYSTEM, `DirectInput8Create called: riid=0x${(riidPtr ?? 0).toString(16)} ppvOut=0x${(ppvOut ?? 0).toString(16)}`);
            if (!ppvOut) return DIERR_INVALIDPARAM;

            const { iid, vtableName } = this.resolveDirectInput8Interface(mem, riidPtr);
            const vtableAddr = this.vtables[vtableName]?.address;
            if (!vtableAddr) return DIERR_OUTOFMEMORY;

            const obj = ComObjectFactory.create(iid, vtableAddr);
            if (!obj) return DIERR_OUTOFMEMORY;

            const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            view.setUint32(ppvOut, objAddr, true);
            resourceProvider.mapAddressToHandle(objAddr, obj.handle);

            Logger.log(LogCategory.SYSTEM, `DirectInput8Create -> 0x${objAddr.toString(16)} (${vtableName}, handle=0x${obj.handle.toString(16)})`);
            return DI_OK;
        };

        // IDirectInputA IUnknown methods.
        // The IID is checked for real: accepting any IID and handing back `this` gives a
        // caller that asked for IDirectInput7A the SHORT DX3 vtable, and its first call to
        // FindDevice/CreateDeviceEx reads past the table's end into whatever follows. That
        // is the defect DirectInputCreateEx was fixed for; QI is the other way in.
        this.exports["IDirectInputA_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const fail = (): number => {
                // A failed QI must NULL the out-pointer: the caller is entitled to test it
                // instead of the HRESULT, and stale stack there becomes a wild vtable.
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                return 0x80004002; // E_NOINTERFACE
            };
            const obj = resourceProvider.getComObjectByAddress(thisPtr);
            if (!obj) return fail();

            const iid = readGuidFromMem(freshMem, riidPtr).toLowerCase();
            const vtableOf = (name: string): number => this.vtables[name]?.address ?? 0;
            const currentVtable = view.getUint32(thisPtr, true);
            const isDi8 = currentVtable === vtableOf("IDirectInput8A")
                || currentVtable === vtableOf("IDirectInput8W");

            const succeed = (addr: number, o: { addRef(): number }): number => {
                if (ppvObject) view.setUint32(ppvObject, addr, true);
                o.addRef();
                return DI_OK;
            };
            if (iid === IID_IUNKNOWN) return succeed(thisPtr, obj);
            if (isDi8) {
                // dinput8's object does not implement the DX3-7 interfaces, and neither
                // does ours — the DX7 vtable it would need is a different table.
                if (iid === IID_IDIRECTINPUT8A || iid === IID_IDIRECTINPUT8W) {
                    return succeed(thisPtr, obj);
                }
                Logger.log(LogCategory.SYSTEM, `IDirectInput8_QueryInterface: unsupported iid=${iid}`);
                return fail();
            }
            if (!DIRECTINPUT_QI_IIDS.has(iid)) {
                Logger.log(LogCategory.SYSTEM, `IDirectInputA_QueryInterface: unsupported iid=${iid}`);
                return fail();
            }
            // IDirectInput2/7 add FindDevice and CreateDeviceEx past the DX3 vtable, so
            // they can only be served by the longer table. A DX3 request is satisfied by
            // either, since the long table is a strict superset.
            const needsLongVtable = iid !== IID_IDIRECTINPUTA && iid !== IID_IDIRECTINPUTW;
            if (!needsLongVtable || currentVtable === vtableOf("IDirectInput7A")) {
                return succeed(thisPtr, obj);
            }
            const longVtable = vtableOf("IDirectInput7A");
            if (!longVtable) return fail();
            // The factory registry is keyed by the interfaces we implement, not by every IID a
            // client may ask for: IDirectInput2A/2W/7W have no factory of their own and are
            // served by the 7A object, whose vtable is a strict superset.
            const promoted = ComObjectFactory.create(IID_IDIRECTINPUT7A, longVtable);
            if (!promoted) return fail();
            const addr = allocateComObject(this.process.memory, this.getMemory(), longVtable);
            resourceProvider.mapAddressToHandle(addr, promoted.handle);
            const wv = this.freshView();
            if (ppvObject) wv.setUint32(ppvObject, addr, true);
            Logger.log(LogCategory.SYSTEM,
                `IDirectInputA_QueryInterface: ${iid} -> new IDirectInput7A object 0x${addr.toString(16)}`);
            return DI_OK;
        };
        this.exports["IDirectInputA_AddRef"] = (ctx, mem, args) => {
            const obj = resourceProvider.getComObjectByAddress(args[0]);
            return obj ? obj.addRef() : 0;
        };
        this.exports["IDirectInputA_Release"] = (ctx, mem, args) => {
            const obj = resourceProvider.getComObjectByAddress(args[0]);
            return obj ? obj.release() : 0;
        };

        // IDirectInputA stub methods
        for (const method of IDirectInputA_StubMethods) {
            this.exports[`IDirectInputA_${method}`] = () => DI_OK;
        }

        // HRESULT GetDeviceStatus(REFGUID rguidInstance) — DI_OK means "attached and
        // usable right now", DI_NOTATTACHED means the instance is known but absent. The
        // same presence test EnumDevices and GetCapabilities use answers it, so the three
        // cannot disagree about one device.
        this.exports["IDirectInputA_GetDeviceStatus"] = (ctx, mem, args) => {
            const rguid = args[1] >>> 0;
            const deviceType = this.resolveDeviceType(this.getMemory(), rguid);
            let attached: boolean;
            switch (deviceType) {
                case "keyboard":
                case "mouse":
                    attached = true;
                    break;
                case "joystick":
                case "gamepad":
                    attached = System.getInstance().inputManager.getGamepadState().connected;
                    break;
                default:
                    // Not one of the system devices we present at all.
                    return DIERR_DEVICENOTREG;
            }
            Logger.verbose(LogCategory.SYSTEM,
                `IDirectInputA_GetDeviceStatus(${deviceType}) -> ${attached ? "DI_OK" : "DI_NOTATTACHED"}`);
            return attached ? DI_OK : DI_NOTATTACHED;
        };

        // Custom implementation for IDirectInputA_EnumDevices with proper callback invocation
        this.exports["IDirectInputA_EnumDevices"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const dwDevType = args[1];  // Device type filter (0 = all)
            const lpCallback = args[2]; // LPDIENUMDEVICESCALLBACKA
            const pvRef = args[3];      // User context
            const dwFlags = args[4];    // DIEDFL_* flags

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const retAddr = view.getUint32(ctx.esp, true);
            Logger.log(LogCategory.SYSTEM, `IDirectInputA_EnumDevices called: this=0x${thisPtr.toString(16)}, dwDevType=0x${dwDevType.toString(16)}, lpCallback=0x${lpCallback.toString(16)}, pvRef=0x${pvRef.toString(16)}, dwFlags=0x${dwFlags.toString(16)}, ret=0x${retAddr.toString(16)}`);

            if (!lpCallback) {
                Logger.warn(LogCategory.SYSTEM, 'IDirectInputA_EnumDevices: NULL callback');
                return DI_OK; // Still success, just no enumeration
            }

            // Build list of devices to enumerate based on filter
            // dwDevType can be:
            //   0 = enumerate all devices
            //   DI5: DIDEVTYPE_KEYBOARD (3), DIDEVTYPE_MOUSE (2), DIDEVTYPE_JOYSTICK (4)
            //   DI8: DI8DEVTYPE_KEYBOARD (0x13), DI8DEVTYPE_MOUSE (0x12), etc.
            const devices: Array<{
                devType: number;
                instanceName: string;
                productName: string;
                guidInstance: number[];  // 16 bytes
                guidProduct: number[];   // 16 bytes
            }> = [];

            // Helper to check if a device type matches the filter
            // Handles both DI5 and DI8 device type values
            const matchesFilter = (di5Type: number, di8Type: number): boolean => {
                if (dwDevType === 0) return true; // All devices
                return dwDevType === di5Type || dwDevType === di8Type;
            };

            // Add keyboard if requested
            if (matchesFilter(DIDEVTYPE_KEYBOARD, DI8DEVTYPE_KEYBOARD)) {
                devices.push({
                    devType: DIDEVTYPE_KEYBOARD, // Use DI5 type for Re-Volt
                    instanceName: "Keyboard",
                    productName: "Standard 101/102-Key or Microsoft Natural PS/2 Keyboard",
                    // GUID_SysKeyboard: 6F1D2B61-D5A0-11CF-BFC7-444553540000
                    guidInstance: [0x61, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
                    guidProduct: [0x61, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00]
                });
            }

            // Add mouse if requested
            if (matchesFilter(DIDEVTYPE_MOUSE, DI8DEVTYPE_MOUSE)) {
                devices.push({
                    devType: DIDEVTYPE_MOUSE, // Use DI5 type for Re-Volt
                    instanceName: "Mouse",
                    productName: "Microsoft PS/2 Mouse",
                    // GUID_SysMouse: 6F1D2B60-D5A0-11CF-BFC7-444553540000
                    guidInstance: [0x60, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
                    guidProduct: [0x60, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11, 0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00]
                });
            }

            // Add joystick if requested (even though we don't have a real one)
            if (matchesFilter(DIDEVTYPE_JOYSTICK, DI8DEVTYPE_JOYSTICK)) {
                const gamepadState = System.getInstance().inputManager.getGamepadState();
                if (gamepadState.connected) {
                    devices.push({
                        devType: DIDEVTYPE_JOYSTICK,
                        instanceName: "Gamepad",
                        productName: "Browser Gamepad",
                        guidInstance: GUID_SYS_GAMEPAD,
                        guidProduct: GUID_SYS_GAMEPAD
                    });
                } else {
                    Logger.verbose(LogCategory.SYSTEM, `IDirectInputA_EnumDevices: Joystick requested but no gamepad connected`);
                }
            }

            // If no devices match filter, return success immediately
            if (devices.length === 0) {
                Logger.log(LogCategory.SYSTEM, `IDirectInputA_EnumDevices: No devices match filter 0x${dwDevType.toString(16)}`);
                return DI_OK;
            }

            let currentIdx = 0;
            const allocatedMemory: number[] = [];

            // Save thunk context BEFORE starting enumeration
            const callbackManager = this.process.dispatcher.callbackManager;
            if (!callbackManager) {
                Logger.warn(LogCategory.SYSTEM, 'IDirectInputA_EnumDevices: CallbackManager not available');
                return DI_OK;
            }
            // EnumDevices is stdcall with 5 parameters including `this`.
            // The suspended frame must match the thunk's final RET 20,
            // otherwise callback completion restores ESP to the wrong address.
            const frameId = callbackManager.saveSuspendedThunkContext(ctx, 20, "IDirectInputA_EnumDevices");
            if (frameId === 0) {
                // The frame could not be saved (bad ESP / return address). Claiming
                // suspension now would bind the chain to whatever OUTER frame happens to
                // be on top of the stack; enumerate nothing instead.
                Logger.warn(LogCategory.SYSTEM, 'IDirectInputA_EnumDevices: could not save suspended frame');
                return DI_OK;
            }

            let firstCallbackId: number | null = null;

            const processNextDevice = (): void => {
                if (currentIdx >= devices.length) {
                    Logger.warn(LogCategory.SYSTEM, 'IDirectInputA_EnumDevices: processNextDevice called after all devices enumerated');
                    return;
                }

                const device = devices[currentIdx++];

                // Allocate DIDEVICEINSTANCEA structure
                const diAddr = this.process.memory.alloc(DIDEVICEINSTANCEA_SIZE);
                allocatedMemory.push(diAddr);

                // Refetch guest memory after alloc. AddressSpace allocations can force
                // buffer refreshes, and stale views here will corrupt callback payloads.
                const curMem = this.getMemory();
                const curView = new DataView(curMem.buffer, curMem.byteOffset, curMem.byteLength);

                // Zero out the structure first
                for (let i = 0; i < DIDEVICEINSTANCEA_SIZE; i++) {
                    curMem[diAddr + i] = 0;
                }

                let offset = 0;

                // dwSize (DWORD)
                curView.setUint32(diAddr + offset, DIDEVICEINSTANCEA_SIZE, true);
                offset += 4;

                // guidInstance (GUID - 16 bytes)
                for (let i = 0; i < 16; i++) {
                    curMem[diAddr + offset + i] = device.guidInstance[i];
                }
                offset += 16;

                // guidProduct (GUID - 16 bytes)
                for (let i = 0; i < 16; i++) {
                    curMem[diAddr + offset + i] = device.guidProduct[i];
                }
                offset += 16;

                // dwDevType (DWORD)
                curView.setUint32(diAddr + offset, device.devType, true);
                offset += 4;

                // tszInstanceName (CHAR[260] = MAX_PATH)
                const instanceNameBytes = encodeAnsi(device.instanceName);
                for (let i = 0; i < Math.min(instanceNameBytes.length, 259); i++) {
                    curMem[diAddr + offset + i] = instanceNameBytes[i];
                }
                offset += 260;

                // tszProductName (CHAR[260] = MAX_PATH)
                const productNameBytes = encodeAnsi(device.productName);
                for (let i = 0; i < Math.min(productNameBytes.length, 259); i++) {
                    curMem[diAddr + offset + i] = productNameBytes[i];
                }
                offset += 260;

                // guidFFDriver (GUID - 16 bytes) - leave as zeros
                offset += 16;

                // wUsagePage, wUsage (WORD, WORD)
                // Leave as zeros

                // Invoke callback: BOOL CALLBACK EnumDevicesCallback(LPCDIDEVICEINSTANCEA lpddi, LPVOID pvRef)
                const callbackMgr = callbackManager;

                const { callbackId } = callbackMgr.invokeCallback(
                    lpCallback,
                    [diAddr, pvRef],
                    0, // CALLBACK is stdcall; callee cleans its own args
                    (callbackReturnValue) => {
                        // Cleanup memory for this device
                        this.process.memory.free(diAddr);
                        const idx = allocatedMemory.indexOf(diAddr);
                        if (idx >= 0) allocatedMemory.splice(idx, 1);

                        // FALSE (0) = stop enumeration, TRUE (non-zero) = continue
                        if (callbackReturnValue === 0) {
                            // Stop enumeration
                            for (const addr of allocatedMemory) {
                                this.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                            return DI_OK;
                        }

                        // Check if more devices
                        if (currentIdx >= devices.length) {
                            // All done
                            for (const addr of allocatedMemory) {
                                this.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                            return DI_OK;
                        }

                        // Continue enumeration
                        return null;
                    },
                    false,
                    "IDirectInputA_EnumDevices",
                    frameId,
                );

                if (firstCallbackId === null) {
                    firstCallbackId = callbackId;
                }

                // Store enumeration state
                const invocation = callbackMgr.getPendingCallback(callbackId);
                if (invocation) {
                    invocation.enumerationState = {
                        continueEnumeration: processNextDevice,
                        finishEnumeration: (finalValue: number) => {
                            for (const addr of allocatedMemory) {
                                this.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                        }
                    };

                    // Link thunkContext from first callback
                    if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                        const firstInvocation = callbackMgr.getPendingCallback(firstCallbackId);
                        if (firstInvocation?.thunkContext) {
                            invocation.thunkContext = firstInvocation.thunkContext;
                        }
                    }
                }
            };

            // Start enumeration. If it dispatches nothing — invokeCallback refused or threw —
            // the saved frame has PINNED this thread and no callback will ever return to
            // release it, so claiming suspension here freezes the guest silently. Give the
            // frame back and answer synchronously instead.
            try {
                processNextDevice();
            } catch (e) {
                Logger.error(LogCategory.SYSTEM,
                    `IDirectInputA_EnumDevices: callback dispatch failed: ${(e as Error)?.message ?? e}`);
            }
            if (!firstCallbackId) {
                callbackManager.abandonSuspendedFrame(frameId);
                for (const addr of allocatedMemory) this.process.memory.free(addr);
                allocatedMemory.length = 0;
                return DI_OK;
            }

            // Return suspended - thunk completes when enumeration finishes
            // EnumDevices has 5 params (this, dwDevType, lpCallback, pvRef, dwFlags) = 20 bytes
            return {
                value: 0,
                suspendedForCallback: true,
                callbackId: firstCallbackId,
                stackCleanup: 20
            };
        };

        // Custom implementation for IDirectInputA_CreateDevice
        this.exports["IDirectInputA_CreateDevice"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const rguid = args[1];
            const lplpDirectInputDevice = args[2];

            const entryMem = this.getMemory();
            const entryView = new DataView(entryMem.buffer, entryMem.byteOffset, entryMem.byteLength);
            const retAddr = entryView.getUint32(ctx.esp, true);
            Logger.log(LogCategory.SYSTEM, `IDirectInputA_CreateDevice called: rguid=0x${rguid.toString(16)}, ppv=0x${lplpDirectInputDevice.toString(16)}, ret=0x${retAddr.toString(16)}`);

            if (!lplpDirectInputDevice) return DIERR_INVALIDPARAM;

            const vtableAddr = this.vtables.IDirectInputDevice2A.address;
            const obj = ComObjectFactory.create<DirectInputDeviceObject>("5944e680-c92e-11cf-bfc7-444553540000", vtableAddr);
            if (!obj) return DIERR_OUTOFMEMORY;
            obj.deviceType = this.resolveDeviceType(entryMem, rguid);

            const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            view.setUint32(lplpDirectInputDevice, objAddr, true);

            resourceProvider.mapAddressToHandle(objAddr, obj.handle);

            Logger.log(LogCategory.SYSTEM, `IDirectInputA_CreateDevice -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_Acquire"] = (ctx, mem, args) => {
            const device = this.getDevice(args[0]);
            if (device) {
                device.acquired = true;
                device.inputLost = false; // re-Acquire is how an app clears DIERR_INPUTLOST
            }
            // An acquired exclusive-mode mouse owns the pointer until something ends the
            // acquisition; a NONEXCLUSIVE acquire must clear any claim this device still holds.
            if (device && device.deviceType === "mouse") {
                setExclusiveMouseOwner(device, device.exclusive);
            }
            if (device && (device.deviceType === "joystick" || device.deviceType === "gamepad")) {
                System.getInstance().inputManager.noteGuestGamepadRead();
            }
            const im = System.getInstance().inputManager;
            if (device && device.deviceType === "keyboard" && im.getDInputKeyboardBufferSize() > 0) {
                im.baselineDInputKeyboard();
            }
            if (device && (device.deviceType === "gamepad" || device.deviceType === "joystick")
                && im.getDInputGamepadBufferSize() > 0) {
                im.baselineDInputGamepad();
            }
            // Same for the mouse: without a baseline the first buffered read after an
            // Acquire that followed SetProperty(DIPROP_BUFFERSIZE) reports the absolute
            // position as a delta.
            if (device && device.deviceType === "mouse" && im.getDInputMouseBufferSize() > 0) {
                im.baselineDInputMouse();
            }
            // Action-mapped device: baseline the buffered edge detector at acquire time so the first
            // GetDeviceData reports only transitions that happen after acquisition (DI semantics).
            if (device && device.isActionMapped) {
                for (const e of device.actionMap) {
                    if (e.kind === "button" && e.dik !== undefined) {
                        e.lastValue = this.dikPressed(System.getInstance().inputManager.getKeyboardStateVk(), e.dik);
                    } else if (e.kind === "axis" && e.dikNeg !== undefined && e.dikPos !== undefined) {
                        const ks = System.getInstance().inputManager.getKeyboardStateVk();
                        const neg = this.dikPressed(ks, e.dikNeg) !== 0;
                        const pos = this.dikPressed(ks, e.dikPos) !== 0;
                        e.lastValue = (neg && pos) ? 0 : neg ? -32768 : pos ? 32767 : 0;
                    } else if (e.kind === "hat") {
                        e.lastValue = 0xffffffff;
                    } else {
                        e.lastValue = 0;
                    }
                }
                if (device.deviceType === "mouse") {
                    device.mousePollPrevButtons = System.getInstance().inputManager.getMouseState().buttons;
                }
            }
            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_Acquire: this=0x${args[0].toString(16)} type=${device?.deviceType ?? "null"} format=${device?.dataFormat ?? "null"} found=${device !== null}`);
            return DI_OK;
        };

        // HRESULT SetEventNotification(HANDLE hEvent) — see dinput-notify.ts for the contract.
        this.exports["IDirectInputDeviceA_SetEventNotification"] = (ctx, mem, args) => {
            const device = this.getDevice(args[0]);
            const hEvent = args[1] >>> 0;
            const hr = notifyRegistry.setEventNotification(device, hEvent);
            if (hr === DI_OK && hEvent) this.armDInputNotifier();
            Logger.verbose(LogCategory.SYSTEM,
                `SetEventNotification: this=0x${args[0].toString(16)} hEvent=0x${hEvent.toString(16)} hr=0x${hr.toString(16)}`);
            return hr;
        };

        this.exports["IDirectInputDeviceA_Unacquire"] = (ctx, mem, args) => {
            const device = this.getDevice(args[0]);
            if (device) device.acquired = false;
            // Released regardless of the current cooperative level: a SetCooperativeLevel
            // between Acquire and Unacquire must not be able to strand the claim.
            if (device && device.deviceType === "mouse") setExclusiveMouseOwner(device, false);
            Logger.verbose(LogCategory.SYSTEM, `IDirectInputDeviceA_Unacquire: this=0x${args[0].toString(16)}`);
            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_SetDataFormat"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpdf = args[1];
            if (!lpdf) return DIERR_INVALIDPARAM;

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const dwSize = view.getUint32(lpdf, true);
            const dwObjSize = view.getUint32(lpdf + 4, true);
            const dwFlags = view.getUint32(lpdf + 8, true);
            const dwDataSize = view.getUint32(lpdf + 12, true);
            const dwNumObjs = view.getUint32(lpdf + 16, true);

            const device = this.getDevice(thisPtr);
            if (device) {
                device.dataSize = dwDataSize;
                device.dataFormat = this.resolveDataFormat(device.deviceType, dwDataSize);
            }

            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_SetDataFormat: this=0x${thisPtr.toString(16)}, size=${dwSize}, objSize=${dwObjSize}, flags=0x${dwFlags.toString(16)}, dataSize=${dwDataSize}, objs=${dwNumObjs}`);
            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_SetCooperativeLevel"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const hwnd = args[1];
            const dwFlags = args[2];
            const device = this.getDevice(thisPtr);
            if (device) {
                device.exclusive = (dwFlags & DISCL_EXCLUSIVE) !== 0;
                // If the app changes cooperative level while already acquired, keep host
                // capture in sync with the new exclusivity.
                if (device.deviceType === "mouse") {
                    setExclusiveMouseOwner(device, device.acquired && device.exclusive);
                }
            }
            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_SetCooperativeLevel: this=0x${thisPtr.toString(16)} hwnd=0x${hwnd.toString(16)} flags=0x${dwFlags.toString(16)} type=${device?.deviceType ?? "null"} exclusive=${device?.exclusive ?? false}`);
            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_GetCapabilities"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpDIDevCaps = args[1];
            if (!lpDIDevCaps) return DIERR_INVALIDPARAM;

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const size = view.getUint32(lpDIDevCaps, true);
            if (size < 12) return DIERR_INVALIDPARAM;

            const device = this.getDevice(thisPtr);
            const devType = this.getDeviceTypeValue(device?.deviceType ?? "unknown");

            // dwFlags: report DIDC_ATTACHED for devices we actually present. Keyboard and
            // mouse are always attached; joystick only when a browser gamepad is connected
            // (mirrors EnumDevices). Without this an engine's post-SetCooperativeLevel
            // attachment check reads the device as absent and aborts input init.
            let dwFlags = 0;
            switch (device?.deviceType) {
                case "keyboard":
                case "mouse":
                    dwFlags = DIDC_ATTACHED;
                    break;
                case "joystick":
                case "gamepad":
                    if (System.getInstance().inputManager.getGamepadState().connected) {
                        dwFlags = DIDC_ATTACHED;
                    }
                    break;
            }

            for (let i = 4; i < size; i++) mem[lpDIDevCaps + i] = 0;
            view.setUint32(lpDIDevCaps, size, true);
            view.setUint32(lpDIDevCaps + 4, dwFlags, true);
            view.setUint32(lpDIDevCaps + 8, devType, true);

            // dwAxes/dwButtons/dwPOVs come from the same object table EnumObjects and
            // GetObjectInfo answer from, so the count and the enumeration cannot drift.
            if (size >= 20) {
                const counts = countDeviceObjects(device?.deviceType ?? "unknown");
                view.setUint32(lpDIDevCaps + 12, counts.axes, true);
                view.setUint32(lpDIDevCaps + 16, counts.buttons, true);
                if (size >= 24) view.setUint32(lpDIDevCaps + 20, counts.povs, true);
            }

            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_GetDeviceInfo"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpddi = args[1];
            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_GetDeviceInfo: this=0x${thisPtr.toString(16)} lpddi=0x${lpddi.toString(16)}`);
            if (!lpddi) return DIERR_INVALIDPARAM;

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const size = view.getUint32(lpddi, true);
            if (size < 4) return DIERR_INVALIDPARAM;

            const device = this.getDevice(thisPtr);
            this.writeDeviceInstance(mem, lpddi, size, device?.deviceType ?? "unknown");
            return DI_OK;
        };

        this.exports["IDirectInputDeviceA_GetDeviceState"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const cbData = args[1];
            const lpvData = args[2];
            if (!lpvData || cbData === 0) return DIERR_INVALIDPARAM;

            const device = this.getDevice(thisPtr);
            if (device && !device.acquired) {
                Logger.warn(LogCategory.SYSTEM, `IDirectInputDeviceA_GetDeviceState: not acquired this=0x${thisPtr.toString(16)}`);
                return DIERR_NOTACQUIRED;
            }
            if (device?.inputLost) return DIERR_INPUTLOST;

            const inputManager = System.getInstance().inputManager;
            const format = device?.dataFormat ?? device?.deviceType ?? "unknown";
            Logger.verbose(LogCategory.SYSTEM, `IDirectInputDeviceA_GetDeviceState: this=0x${thisPtr.toString(16)} cbData=${cbData} format=${format}`);

            if (format === "keyboard" || cbData === DIKEYBOARDSTATE_SIZE) {
                inputManager.noteGuestInputFlag(GUEST_INPUT_FLAG.dinputKeyboard);
                const keyStates = inputManager.getKeyboardStateVk();
                mem.fill(0, lpvData, lpvData + Math.min(cbData, DIKEYBOARDSTATE_SIZE));
                for (let vk = 0; vk < keyStates.length; vk++) {
                    if (!keyStates[vk]) continue;
                    const dik = vkToDik(vk);
                    if (dik !== null && dik < cbData) {
                        mem[lpvData + dik] = keyStates[vk];
                    }
                }
                return DI_OK;
            }

            if (format === "mouse" || cbData === DIMOUSESTATE_SIZE || cbData === DIMOUSESTATE2_SIZE) {
                if (cbData < DIMOUSESTATE_SIZE) return DIERR_INVALIDPARAM;

                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                const mouse = inputManager.getMouseState();
                let dx = 0;
                let dy = 0;

                if (device) {
                    // Use a running signed accumulator (SAB slots 14/15) populated by
                    // App.tsx on every pointermove event (both pointer-lock and absolute).
                    // Delta = (currentAccum - lastSeenAccum) | 0  handles Int32 wrap.
                    // This avoids the edge-clamping bug of (mouse.x - lastMouseX) where
                    // mouse.x saturates at [0, width-1] in pointer-lock mode.
                    const accum = inputManager.getDInputAccum();
                    inputManager.noteGuestRelativeMouseRead();
                    if (device.mouseInitialized) {
                        dx = (accum.x - device.lastDInputAccumX) | 0;
                        dy = (accum.y - device.lastDInputAccumY) | 0;
                    }
                    device.lastDInputAccumX = accum.x;
                    device.lastDInputAccumY = accum.y;
                    device.lastMouseX = mouse.x;
                    device.lastMouseY = mouse.y;
                    device.mouseInitialized = true;
                }

                // Write DIMOUSESTATE into guest memory (use fresh mem — v86 may reallocate)
                const curMem = this.getMemory();
                const curView = new DataView(curMem.buffer, curMem.byteOffset, curMem.byteLength);
                curView.setInt32(lpvData, dx, true);      // lX
                curView.setInt32(lpvData + 4, dy, true);   // lY
                curView.setInt32(lpvData + 8, inputManager.consumeDInputWheel(), true); // lZ

                // Browser buttons bitmask: 1=L, 2=R, 4=M, 8=X1(back), 16=X2(forward).
                // Immediate mode reports the LEVEL — but a press the host published and
                // released between two of these calls never had a level for us to report,
                // so the latch carries that edge in for exactly one read PER DEVICE
                // (readMouseButtons). A press held across calls is unaffected.
                const buttons = this.readMouseButtons(device);
                curMem[lpvData + 12] = (buttons & 1) ? 0x80 : 0x00;  // Left
                curMem[lpvData + 13] = (buttons & 2) ? 0x80 : 0x00;  // Right
                curMem[lpvData + 14] = (buttons & 4) ? 0x80 : 0x00;  // Middle
                curMem[lpvData + 15] = (buttons & 8) ? 0x80 : 0x00;  // X1

                // DIMOUSESTATE2 — 4 extra buttons
                if (cbData >= DIMOUSESTATE2_SIZE) {
                    curMem[lpvData + 16] = (buttons & 16) ? 0x80 : 0x00; // X2
                    curMem[lpvData + 17] = 0x00;
                    curMem[lpvData + 18] = 0x00;
                    curMem[lpvData + 19] = 0x00;
                }

                return DI_OK;
            }

            if (format === "gamepad" || format === "joystick" || cbData >= DIJOYSTATE_SIZE) {
                if (cbData < DIJOYSTATE_SIZE) return DIERR_INVALIDPARAM;
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                mem.fill(0, lpvData, lpvData + DIJOYSTATE_SIZE);
                inputManager.noteGuestGamepadRead();
                const gamepad = inputManager.getGamepadState();
                const axes = gamepad.axes;
                view.setInt32(lpvData, axes[0], true);
                view.setInt32(lpvData + 4, axes[1], true);
                view.setInt32(lpvData + 8, 0, true);
                view.setInt32(lpvData + 12, axes[2], true);
                view.setInt32(lpvData + 16, axes[3], true);
                view.setInt32(lpvData + 20, 0, true);
                view.setUint32(lpvData + 24, 0, true);
                view.setUint32(lpvData + 28, 0, true);
                const buttonsMask = gamepad.connected ? gamepad.buttons : 0;
                // rgdwPOV[0] is the d-pad; the pad has one hat, so the other three stay
                // centred (DIDEVCAPS.dwPOVs says one, and the two must agree).
                view.setUint32(lpvData + 32, gamepadPovAngle(buttonsMask), true);
                view.setUint32(lpvData + 36, POV_CENTERED, true);
                view.setUint32(lpvData + 40, POV_CENTERED, true);
                view.setUint32(lpvData + 44, POV_CENTERED, true);

                for (let i = 0; i < GAMEPAD_BUTTONS; i++) {
                    mem[lpvData + 48 + i] = (buttonsMask & (1 << i)) ? 0x80 : 0x00;
                }
                return DI_OK;
            }

            mem.fill(0, lpvData, lpvData + cbData);
            return DI_OK;
        };

        // IDirectInputDeviceA IUnknown methods
        this.exports["IDirectInputDeviceA_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const obj = resourceProvider.getComObjectByAddress(thisPtr);
            if (!obj) return 0x80004002; // E_NOINTERFACE

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);

            const iidStr = readGuidFromMem(freshMem, riidPtr);
            Logger.verbose(LogCategory.COM, `IDirectInputDeviceA_QueryInterface: iid=${iidStr}`);

            if (DEVICE_QI_IIDS.has(iidStr)) {
                if (ppvObject) view.setUint32(ppvObject, thisPtr, true);
                obj.addRef();
                return DI_OK;
            }

            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_QueryInterface: unsupported iid=${iidStr}`);
            return 0x80004002; // E_NOINTERFACE
        };

        this.exports["IDirectInputDeviceA_AddRef"] = (ctx, mem, args) => {
            const obj = resourceProvider.getComObjectByAddress(args[0]);
            return obj ? obj.addRef() : 0;
        };
        this.exports["IDirectInputDeviceA_Release"] = (ctx, mem, args) => {
            const obj = resourceProvider.getComObjectByAddress(args[0]);
            // Release only drops the notification when the refcount actually reaches zero;
            // destroy() does that. A non-final release (a QueryInterface'd Device2/Device8
            // reference going away) must leave the armed handle intact.
            return obj ? obj.release() : 0;
        };

        // IDirectInputDeviceA stub methods
        for (const method of IDirectInputDeviceA_StubMethods) {
            this.exports[`IDirectInputDeviceA_${method}`] = () => DI_OK;
        }

        // SetProperty — handle DIPROP_BUFFERSIZE for buffered GetDeviceData
        this.exports["IDirectInputDeviceA_SetProperty"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const rguidProp = args[1];
            const pdiph = args[2];

            // DIPROP_BUFFERSIZE is passed as ordinal (low word of rguidProp pointer)
            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_BUFFERSIZE) {
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                // DIPROPDWORD: DIPROPHEADER (16 bytes) + dwData (4 bytes)
                const bufferSize = view.getUint32(pdiph + 16, true);
                const device = this.getDevice(thisPtr);
                const im = System.getInstance().inputManager;
                if (device) {
                    switch (device.deviceType) {
                        case "mouse":
                            im.setDInputMouseBufferSize(bufferSize);
                            break;
                        case "keyboard":
                            im.setDInputKeyboardBufferSize(bufferSize);
                            break;
                        case "gamepad":
                        case "joystick":
                            im.setDInputGamepadBufferSize(bufferSize);
                            break;
                    }
                    Logger.log(LogCategory.SYSTEM,
                        `IDirectInputDeviceA_SetProperty: BUFFERSIZE=${bufferSize} type=${device.deviceType}`);
                }
                return DI_OK;
            }

            Logger.verbose(LogCategory.SYSTEM, `IDirectInputDeviceA_SetProperty: prop=0x${rguidProp.toString(16)} (stub)`);
            return DI_OK;
        };

        // GetProperty — handle DIPROP_BUFFERSIZE
        this.exports["IDirectInputDeviceA_GetProperty"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const rguidProp = args[1];
            const pdiph = args[2];

            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_BUFFERSIZE) {
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                const device = this.getDevice(thisPtr);
                const im = System.getInstance().inputManager;
                let bufSize = 0;
                if (device) {
                    switch (device.deviceType) {
                        case "mouse":
                            bufSize = im.getDInputMouseBufferSize();
                            break;
                        case "keyboard":
                            bufSize = im.getDInputKeyboardBufferSize();
                            break;
                        case "gamepad":
                        case "joystick":
                            bufSize = im.getDInputGamepadBufferSize();
                            break;
                    }
                }
                view.setUint32(pdiph + 16, bufSize, true);
                return DI_OK;
            }

            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_GRANULARITY) {
                // Per-object DIPROPDWORD. Real drivers report WHEEL_DELTA (120) for the mouse
                // Z axis and 1 for everything else. Returning DI_OK WITHOUT writing dwData left
                // the app's divisor at 0 — Max Payne computes wheelPos = lZ/granularity, and
                // 0/0 = NaN → x87 ROUND → 0x80000000 → its wheel tracker chases -2^31 one notch
                // per frame = infinite weapon cycling with fire/menu suppressed.
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                const device = this.getDevice(thisPtr);
                const dwObj = view.getUint32(pdiph + 8, true);
                const isWheel = device?.deviceType === "mouse" && dwObj === DIMOFS_Z;
                view.setUint32(pdiph + 16, isWheel ? 120 : 1, true);
                return DI_OK;
            }

            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_RANGE) {
                // DIPROPRANGE { header(16), lMin(+16), lMax(+20) }. Mouse/keyboard axes are
                // relative → no defined range; absolute joystick axes report 0..65535.
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                const device = this.getDevice(thisPtr);
                const absolute = device?.deviceType === "joystick" || device?.deviceType === "gamepad";
                view.setUint32(pdiph + 16, absolute ? 0 : DIPROPRANGE_NOMIN, true);
                view.setUint32(pdiph + 20, absolute ? 65535 : DIPROPRANGE_NOMAX, true);
                return DI_OK;
            }

            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_AXISMODE) {
                // DIPROPAXISMODE_REL=0 (mouse default), _ABS=1 (joystick default).
                const freshMem = this.getMemory();
                const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
                const device = this.getDevice(thisPtr);
                const abs = device?.deviceType === "joystick" || device?.deviceType === "gamepad";
                view.setUint32(pdiph + 16, abs ? 1 : 0, true);
                return DI_OK;
            }

            if ((rguidProp & 0xFFFF0000) === 0 && rguidProp === DIPROP_KEYNAME) {
                // DIPROPSTRING out-param carrying the object's own tszName — the same table
                // GetObjectInfo answers from (Wine keyboard_get_property). A game that renders
                // "press [W]" reads its binding names through this and NOTHING else, so failing
                // it leaves the caller's fixed-size name buffer at whatever it was pre-filled
                // with. Keys only: a device with axes and no key objects has no key names.
                const view = this.freshView();
                const device = this.getDevice(thisPtr);
                if (device?.deviceType !== "keyboard") return DIERR_UNSUPPORTED;
                if (view.getUint32(pdiph, true) !== DIPROPSTRING_SIZE) return DIERR_INVALIDPARAM;
                const dwObj = view.getUint32(pdiph + 8, true);
                const dwHow = view.getUint32(pdiph + 12, true);
                if (dwHow === DIPH_DEVICE) return DIERR_INVALIDPARAM;
                const match = findDeviceObject(getDeviceObjectSpecs("keyboard"), dwObj, dwHow);
                if (!match) {
                    Logger.log(LogCategory.SYSTEM,
                        `IDirectInputDeviceA_GetProperty: KEYNAME dwObj=0x${dwObj.toString(16)} how=${dwHow} -> NOT FOUND`);
                    return DIERR_OBJECTNOTFOUND;
                }
                Marshaler.writeWideString(this.getMemory(), pdiph + 16, match.name, DIPROPSTRING_MAX_CHARS);
                return DI_OK;
            }

            // Unknown property: real DirectInput fails (DIERR_UNSUPPORTED) rather than
            // succeeding with an untouched output struct — a fake DI_OK here is exactly
            // how the granularity bug stayed invisible. NORMAL-level log so any game
            // hitting a new property is diagnosable from the log tail.
            Logger.log(LogCategory.SYSTEM, `IDirectInputDeviceA_GetProperty: prop=0x${rguidProp.toString(16)} UNSUPPORTED`);
            return DIERR_UNSUPPORTED;
        };

        // Write a DIDEVICEOBJECTINSTANCEA into guest memory (cap bytes = caller's dwSize
        // for GetObjectInfo, full 316 for EnumObjects). Layout: dwSize, guidType(16),
        // dwOfs, dwType, dwFlags, tszName[260], then DX5 FF/HID fields (zeroed).
        const writeObjectInstance = (addr: number, obj: DeviceObjectSpec, cap: number): void => {
            const m = this.getMemory();
            const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
            m.fill(0, addr, addr + cap);
            view.setUint32(addr, cap, true);
            for (let i = 0; i < 16 && 4 + i < cap; i++) m[addr + 4 + i] = obj.guid[i];
            if (cap >= 24) view.setUint32(addr + 20, obj.dwOfs, true);
            if (cap >= 28) view.setUint32(addr + 24, obj.dwType, true);
            if (cap >= 32) view.setUint32(addr + 28, 0, true); // dwFlags
            const nameBytes = encodeAnsi(obj.name);
            for (let i = 0; i < Math.min(nameBytes.length, 259) && 32 + i < cap; i++) {
                m[addr + 32 + i] = nameBytes[i];
            }
        };

        // EnumObjects(this, lpCallback, pvRef, dwFlags) — invoke the app callback once per
        // device object (axes/buttons/keys), async via CallbackManager like EnumDevices.
        this.exports["IDirectInputDeviceA_EnumObjects"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpCallback = args[1];
            const pvRef = args[2];
            const dwFlags = args[3];
            if (!lpCallback) return DIERR_INVALIDPARAM;

            const device = this.getDevice(thisPtr);
            const typeFilter = dwFlags & 0xFF | (dwFlags & DIDFT_POV);
            const objects = getDeviceObjectSpecs(device?.deviceType ?? "unknown").filter(o =>
                dwFlags === 0 || (o.dwType & typeFilter) !== 0
            );
            Logger.log(LogCategory.SYSTEM,
                `IDirectInputDeviceA_EnumObjects: type=${device?.deviceType} flags=0x${dwFlags.toString(16)} -> ${objects.length} objects`);
            if (objects.length === 0) return DI_OK;

            const callbackMgr = this.process.dispatcher.callbackManager;
            if (!callbackMgr) return DI_OK;
            // 4 stdcall args (this, cb, pvRef, flags) = RET 16
            const frameId = callbackMgr.saveSuspendedThunkContext(ctx, 16, "IDirectInputDeviceA_EnumObjects");
            if (frameId === 0) {
                Logger.warn(LogCategory.SYSTEM, 'IDirectInputDeviceA_EnumObjects: could not save suspended frame');
                return DI_OK;
            }

            let currentIdx = 0;
            let firstCallbackId: number | null = null;
            const allocated: number[] = [];
            const freeAll = (): void => {
                for (const a of allocated) this.process.memory.free(a);
                allocated.length = 0;
            };

            const processNext = (): void => {
                if (currentIdx >= objects.length) return;
                const obj = objects[currentIdx++];
                const addr = this.process.memory.alloc(DIDEVICEOBJECTINSTANCEA_SIZE);
                allocated.push(addr);
                writeObjectInstance(addr, obj, DIDEVICEOBJECTINSTANCEA_SIZE);

                const { callbackId } = callbackMgr.invokeCallback(
                    lpCallback,
                    [addr, pvRef],
                    0,
                    (ret) => {
                        this.process.memory.free(addr);
                        const idx = allocated.indexOf(addr);
                        if (idx >= 0) allocated.splice(idx, 1);
                        if (ret === 0 || currentIdx >= objects.length) { freeAll(); return DI_OK; }
                        return null; // continue enumeration
                    },
                    false,
                    "IDirectInputDeviceA_EnumObjects",
                    frameId,
                );
                if (firstCallbackId === null) firstCallbackId = callbackId;
                const invocation = callbackMgr.getPendingCallback(callbackId);
                if (invocation) {
                    invocation.enumerationState = {
                        continueEnumeration: processNext,
                        finishEnumeration: () => freeAll(),
                    };
                    if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                        const first = callbackMgr.getPendingCallback(firstCallbackId);
                        if (first?.thunkContext) invocation.thunkContext = first.thunkContext;
                    }
                }
            };

            // A saved frame pins this thread; if nothing was dispatched, give it back and
            // answer synchronously rather than wait forever on a callback that never ran.
            try {
                processNext();
            } catch (e) {
                Logger.error(LogCategory.SYSTEM,
                    `IDirectInputDeviceA_EnumObjects: callback dispatch failed: ${(e as Error)?.message ?? e}`);
            }
            if (!firstCallbackId) {
                callbackMgr.abandonSuspendedFrame(frameId);
                freeAll();
                return DI_OK;
            }
            return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId, stackCleanup: 16 };
        };

        // GetObjectInfo(this, pdidoi, dwObj, dwHow) — fill the object descriptor for one
        // control, addressed by state offset (BYOFFSET) or by DIDFT id (BYID).
        this.exports["IDirectInputDeviceA_GetObjectInfo"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const pdidoi = args[1];
            const dwObj = args[2];
            const dwHow = args[3];
            if (!pdidoi) return DIERR_INVALIDPARAM;

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
            const cbSize = view.getUint32(pdidoi, true);
            if (cbSize < 24) return DIERR_INVALIDPARAM; // must hold at least the DX3 head

            const device = this.getDevice(thisPtr);
            const objects = getDeviceObjectSpecs(device?.deviceType ?? "unknown");
            if (dwHow !== DIPH_BYOFFSET && dwHow !== DIPH_BYID) {
                return DIERR_INVALIDPARAM; // DIPH_DEVICE is not valid for GetObjectInfo
            }
            const match = findDeviceObject(objects, dwObj, dwHow);
            if (!match) {
                Logger.log(LogCategory.SYSTEM,
                    `IDirectInputDeviceA_GetObjectInfo: type=${device?.deviceType} dwObj=0x${dwObj.toString(16)} how=${dwHow} -> NOT FOUND`);
                return DIERR_OBJECTNOTFOUND;
            }
            writeObjectInstance(pdidoi, match, Math.min(cbSize, DIDEVICEOBJECTINSTANCEA_SIZE));
            return DI_OK;
        };

        // GetDeviceData — buffered input (keyboard, mouse, gamepad/joystick)
        this.exports["IDirectInputDeviceA_GetDeviceData"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const cbObjectData = args[1]; // size of each DIDEVICEOBJECTDATA
            const rgdod = args[2];        // output array pointer (can be NULL to query count)
            const pdwInOut = args[3];      // in: max items, out: items returned
            const dwFlags = args[4];

            const freshMem = this.getMemory();
            const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);

            const device = this.getDevice(thisPtr);
            const im = System.getInstance().inputManager;
            if (device?.inputLost) return DIERR_INPUTLOST;
            // An unacquired device yields DIERR_NOTACQUIRED, exactly as GetDeviceState does.
            // Engines poll the buffered queue and treat that error as "(re)acquire now" —
            // handing them events instead leaves the device unacquired forever, and any
            // input the engine gates on its own acquired flag is then silently dropped.
            if (device && !device.acquired) return DIERR_NOTACQUIRED;

            // DI8 action-mapped device (keyboard): replay key-state edges as buffered
            // DIDEVICEOBJECTDATA events carrying the app's uAppData. This is the path NFSU's
            // per-frame poll (Poll + GetDeviceData(20,...)) consumes.
            if (device && device.isActionMapped) {
                return this.getActionMappedDeviceData(device, cbObjectData, rgdod, pdwInOut, dwFlags, view);
            }

            if (!device) {
                if (pdwInOut) view.setUint32(pdwInOut, 0, true);
                return DI_OK;
            }

            let pending = 0;
            let drainFn: (maxItems: number) => ReturnType<typeof im.drainDInputMouseEvents>;
            switch (device.deviceType) {
                case "mouse":
                    pending = im.getDInputMouseEventCount();
                    drainFn = (n) => im.drainDInputMouseEvents(n);
                    break;
                case "keyboard":
                    pending = im.getDInputKeyboardEventCount();
                    drainFn = (n) => im.drainDInputKeyboardEvents(n);
                    break;
                case "gamepad":
                case "joystick":
                    pending = im.getDInputGamepadEventCount();
                    drainFn = (n) => im.drainDInputGamepadEvents(n);
                    break;
                default:
                    if (pdwInOut) view.setUint32(pdwInOut, 0, true);
                    return DI_OK;
            }

            // NULL rgdod = query how many events are pending
            if (!rgdod) {
                if (pdwInOut) view.setUint32(pdwInOut, pending, true);
                return DI_OK;
            }

            const maxItems = pdwInOut ? view.getUint32(pdwInOut, true) : 0;
            if (maxItems === 0) {
                if (pdwInOut) view.setUint32(pdwInOut, 0, true);
                return DI_OK;
            }

            const peek = (dwFlags & DIGDD_PEEK) !== 0;
            const stride = Math.max(cbObjectData, DIDEVICEOBJECTDATA_SIZE);

            if (peek) {
                // Peek mode: report count without consuming
                if (pdwInOut) view.setUint32(pdwInOut, Math.min(maxItems, pending), true);
                return DI_OK;
            }

            const events = drainFn(maxItems);
            const overflow = pending > maxItems;

            // Write DIDEVICEOBJECTDATA entries
            for (let i = 0; i < events.length; i++) {
                const e = events[i];
                const addr = rgdod + i * stride;
                view.setUint32(addr, e.dwOfs, true);
                view.setUint32(addr + 4, e.dwData, true);
                view.setUint32(addr + 8, e.dwTimeStamp, true);
                view.setUint32(addr + 12, e.dwSequence, true);
            }

            if (pdwInOut) view.setUint32(pdwInOut, events.length, true);
            return overflow ? DI_BUFFEROVERFLOW : DI_OK;
        };

        // Map IDirectInputDevice2A methods to the same implementations as IDirectInputDeviceA
        // This MUST be done after all IDirectInputDeviceA methods are defined
        this.exports["IDirectInputDevice2A_QueryInterface"] = this.exports["IDirectInputDeviceA_QueryInterface"];
        this.exports["IDirectInputDevice2A_AddRef"] = this.exports["IDirectInputDeviceA_AddRef"];
        this.exports["IDirectInputDevice2A_Release"] = this.exports["IDirectInputDeviceA_Release"];

        const commonMethods = [
            "GetCapabilities", "EnumObjects", "GetProperty", "SetProperty", "Acquire", "Unacquire",
            "GetDeviceState", "GetDeviceData", "SetDataFormat", "SetEventNotification", "SetCooperativeLevel",
            "GetObjectInfo", "GetDeviceInfo", "RunControlPanel", "Initialize"
        ];
        for (const method of commonMethods) {
            this.exports[`IDirectInputDevice2A_${method}`] = this.exports[`IDirectInputDeviceA_${method}`];
        }

        // IDirectInputDevice2A stub methods
        for (const method of IDirectInputDevice2A_StubMethods) {
            this.exports[`IDirectInputDevice2A_${method}`] = () => DI_OK;
        }

        // CreateEffect(rguid, lpeff, ppdeff, punkOuter) — no device here reports
        // DIDC_FORCEFEEDBACK, so there is no effect to create. NULL the out pointer: the
        // caller stores it and later calls Start/Unload through it.
        this.exports["IDirectInputDevice2A_CreateEffect"] = (ctx, mem, args) => {
            const ppdeff = args[3] >>> 0;
            if (ppdeff) Mem.writeUint32(ppdeff, 0);
            Logger.log(LogCategory.SYSTEM, "IDirectInputDevice2A_CreateEffect -> DIERR_UNSUPPORTED (no force feedback)");
            return DIERR_UNSUPPORTED;
        };
        // GetForceFeedbackState(pdwOut) — the state DWORD is the whole answer; leaving it
        // untouched is the one failure the caller cannot see.
        this.exports["IDirectInputDevice2A_GetForceFeedbackState"] = (ctx, mem, args) => {
            const pdwOut = args[1] >>> 0;
            if (pdwOut) Mem.writeUint32(pdwOut, 0);
            return DIERR_UNSUPPORTED;
        };
        this.exports["IDirectInputDevice2A_GetEffectInfo"] = () => DIERR_UNSUPPORTED;
        this.exports["IDirectInputDevice2A_SendForceFeedbackCommand"] = () => DIERR_UNSUPPORTED;
        // Escape is a driver-specific passthrough and SendDeviceData writes to output
        // objects; we have neither, and DI_OK would claim the command was carried out.
        this.exports["IDirectInputDevice2A_Escape"] = () => DIERR_UNSUPPORTED;
        this.exports["IDirectInputDevice2A_SendDeviceData"] = () => DIERR_UNSUPPORTED;

        // IDirectInputDevice2A_Poll - specifically log this as it's a hot path
        this.exports["IDirectInputDevice2A_Poll"] = (ctx, mem, args) => {
            const device = this.getDevice(args[0]);
            if (device?.inputLost) return DIERR_INPUTLOST;
            return DI_OK;
        };

        // IDirectInput8A (returned by DirectInput8Create). Its first 8 vtable slots are
        // identical to IDirectInputA — reuse those handlers — then add the three DX8-only
        // methods so the vtable has the correct length. Calling EnumDevicesBySemantics
        // (index 9 / offset 0x24) on the shorter DX7 vtable read past its end → wild
        // indirect call to 0xb077ba00 (adjacent callback stub bytes) → NFSU freeze/OOB.
        // IDirectInput7A: the DX7 interface DirectInputCreateEx is asked for. Same five
        // DX7 methods, plus the two the shorter IDirectInputA vtable lacks.
        this.exports["IDirectInput7A_QueryInterface"] = this.exports["IDirectInputA_QueryInterface"];
        this.exports["IDirectInput7A_AddRef"] = this.exports["IDirectInputA_AddRef"];
        this.exports["IDirectInput7A_Release"] = this.exports["IDirectInputA_Release"];
        this.exports["IDirectInput7A_CreateDevice"] = this.exports["IDirectInputA_CreateDevice"];
        this.exports["IDirectInput7A_EnumDevices"] = this.exports["IDirectInputA_EnumDevices"];
        this.exports["IDirectInput7A_GetDeviceStatus"] = this.exports["IDirectInputA_GetDeviceStatus"];
        this.exports["IDirectInput7A_RunControlPanel"] = this.exports["IDirectInputA_RunControlPanel"];
        this.exports["IDirectInput7A_Initialize"] = this.exports["IDirectInputA_Initialize"];
        // FindDevice(rguidClass, ptszName, pguidInstance) — we keep no name->instance
        // registry, and DI_OK leaves the caller handing its uninitialised stack GUID to
        // CreateDevice. Report the device as unregistered and NULL the out-GUID.
        this.exports["IDirectInput7A_FindDevice"] = (_ctx, _mem, args) => {
            if (args[3]) Mem.writeBytes(args[3] >>> 0, new Uint8Array(16));
            return DIERR_DEVICENOTREG;
        };
        // CreateDeviceEx(rguid, riid, ppvObj, punkOuter) differs from CreateDevice only by
        // the extra IID; every device interface we hand out is the same object, so the call
        // forwards with the out-pointer moved into CreateDevice's slot.
        this.exports["IDirectInput7A_CreateDeviceEx"] = (ctx, mem, args) =>
            this.exports["IDirectInputA_CreateDevice"]!(ctx, mem, [args[0], args[1], args[3], args[4]]);

        this.exports["IDirectInput8A_QueryInterface"] = this.exports["IDirectInputA_QueryInterface"];
        this.exports["IDirectInput8A_AddRef"] = this.exports["IDirectInputA_AddRef"];
        this.exports["IDirectInput8A_Release"] = this.exports["IDirectInputA_Release"];
        // The five DX7-compatible methods reuse the IDirectInputA handlers verbatim. Registered
        // as explicit literal aliases (not a loop over computed keys) so the signature validator
        // can statically see the IDirectInput8A vtable is complete (loop/template-literal keys
        // are invisible to its static scan → false "VTable incomplete" otherwise).
        this.exports["IDirectInput8A_EnumDevices"] = this.exports["IDirectInputA_EnumDevices"];
        this.exports["IDirectInput8A_GetDeviceStatus"] = this.exports["IDirectInputA_GetDeviceStatus"];
        this.exports["IDirectInput8A_RunControlPanel"] = this.exports["IDirectInputA_RunControlPanel"];
        this.exports["IDirectInput8A_Initialize"] = this.exports["IDirectInputA_Initialize"];
        this.exports["IDirectInput8A_FindDevice"] = this.exports["IDirectInput7A_FindDevice"];
        // CreateDevice on IDirectInput8 must hand back an IDirectInputDevice8A (the full vtable
        // with Build/SetActionMap), not the DX7 Device2A — a DI8 game may action-map a device it
        // created directly. The DX7 IDirectInputA_CreateDevice path keeps returning Device2A.
        this.exports["IDirectInput8A_CreateDevice"] = (ctx, mem, args) => {
            const rguid = args[1];
            const lplpDevice = args[2];
            if (!lplpDevice) return DIERR_INVALIDPARAM;
            const entryMem = this.getMemory();
            const deviceType = this.resolveDeviceType(entryMem, rguid);
            const objAddr = this.createDevice8Object(mem, deviceType);
            if (objAddr === 0) return DIERR_OUTOFMEMORY;
            const freshMem = this.getMemory();
            new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength).setUint32(lplpDevice, objAddr, true);
            Logger.log(LogCategory.SYSTEM, `IDirectInput8A_CreateDevice -> 0x${objAddr.toString(16)} type=${deviceType}`);
            return DI_OK;
        };
        this.exports["IDirectInput8A_EnumDevicesBySemantics"] = (ctx, mem, args) => this.enumDevicesBySemantics(ctx, mem, args, resourceProvider, false);
        this.exports["IDirectInput8A_ConfigureDevices"] = () => DI_OK;

        // IDirectInput8W — same vtable layout as IDirectInput8A; W methods alias A handlers.
        this.exports["IDirectInput8W_QueryInterface"] = this.exports["IDirectInputA_QueryInterface"];
        this.exports["IDirectInput8W_AddRef"] = this.exports["IDirectInputA_AddRef"];
        this.exports["IDirectInput8W_Release"] = this.exports["IDirectInputA_Release"];
        this.exports["IDirectInput8W_EnumDevices"] = this.exports["IDirectInputA_EnumDevices"];
        this.exports["IDirectInput8W_GetDeviceStatus"] = this.exports["IDirectInputA_GetDeviceStatus"];
        this.exports["IDirectInput8W_RunControlPanel"] = this.exports["IDirectInputA_RunControlPanel"];
        this.exports["IDirectInput8W_Initialize"] = this.exports["IDirectInputA_Initialize"];
        this.exports["IDirectInput8W_FindDevice"] = this.exports["IDirectInput7A_FindDevice"];
        this.exports["IDirectInput8W_CreateDevice"] = (ctx, mem, args) => {
            const rguid = args[1];
            const lplpDevice = args[2];
            if (!lplpDevice) return DIERR_INVALIDPARAM;
            const entryMem = this.getMemory();
            const deviceType = this.resolveDeviceType(entryMem, rguid);
            const objAddr = this.createDevice8Object(mem, deviceType, true);
            if (objAddr === 0) return DIERR_OUTOFMEMORY;
            const freshMem = this.getMemory();
            new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength).setUint32(lplpDevice, objAddr, true);
            Logger.log(LogCategory.SYSTEM, `IDirectInput8W_CreateDevice -> 0x${objAddr.toString(16)} type=${deviceType}`);
            return DI_OK;
        };
        this.exports["IDirectInput8W_EnumDevicesBySemantics"] = (ctx, mem, args) => this.enumDevicesBySemantics(ctx, mem, args, resourceProvider, true);
        this.exports["IDirectInput8W_ConfigureDevices"] = () => DI_OK;

        // IDirectInputDevice8A vtable. Slots 0..26 (IUnknown..SendDeviceData) are identical to
        // IDirectInputDevice2A and reuse those handlers verbatim. The five DI7/DI8 tail methods
        // are registered as explicit literal aliases so the signature validator's static scan sees
        // the vtable as complete (loop/template-literal keys are invisible to it).
        this.exports["IDirectInputDevice8A_QueryInterface"] = this.exports["IDirectInputDeviceA_QueryInterface"];
        this.exports["IDirectInputDevice8A_AddRef"] = this.exports["IDirectInputDeviceA_AddRef"];
        this.exports["IDirectInputDevice8A_Release"] = this.exports["IDirectInputDeviceA_Release"];
        this.exports["IDirectInputDevice8A_GetCapabilities"] = this.exports["IDirectInputDeviceA_GetCapabilities"];
        this.exports["IDirectInputDevice8A_EnumObjects"] = this.exports["IDirectInputDeviceA_EnumObjects"];
        this.exports["IDirectInputDevice8A_GetProperty"] = this.exports["IDirectInputDeviceA_GetProperty"];
        this.exports["IDirectInputDevice8A_SetProperty"] = this.exports["IDirectInputDeviceA_SetProperty"];
        this.exports["IDirectInputDevice8A_Acquire"] = this.exports["IDirectInputDeviceA_Acquire"];
        this.exports["IDirectInputDevice8A_Unacquire"] = this.exports["IDirectInputDeviceA_Unacquire"];
        this.exports["IDirectInputDevice8A_GetDeviceState"] = this.exports["IDirectInputDeviceA_GetDeviceState"];
        this.exports["IDirectInputDevice8A_GetDeviceData"] = this.exports["IDirectInputDeviceA_GetDeviceData"];
        this.exports["IDirectInputDevice8A_SetDataFormat"] = this.exports["IDirectInputDeviceA_SetDataFormat"];
        this.exports["IDirectInputDevice8A_SetEventNotification"] = this.exports["IDirectInputDeviceA_SetEventNotification"];
        this.exports["IDirectInputDevice8A_SetCooperativeLevel"] = this.exports["IDirectInputDeviceA_SetCooperativeLevel"];
        this.exports["IDirectInputDevice8A_GetObjectInfo"] = this.exports["IDirectInputDeviceA_GetObjectInfo"];
        this.exports["IDirectInputDevice8A_GetDeviceInfo"] = this.exports["IDirectInputDeviceA_GetDeviceInfo"];
        this.exports["IDirectInputDevice8A_RunControlPanel"] = this.exports["IDirectInputDeviceA_RunControlPanel"];
        this.exports["IDirectInputDevice8A_Initialize"] = this.exports["IDirectInputDeviceA_Initialize"];
        this.exports["IDirectInputDevice8A_CreateEffect"] = this.exports["IDirectInputDevice2A_CreateEffect"];
        this.exports["IDirectInputDevice8A_EnumEffects"] = this.exports["IDirectInputDevice2A_EnumEffects"];
        this.exports["IDirectInputDevice8A_GetEffectInfo"] = this.exports["IDirectInputDevice2A_GetEffectInfo"];
        this.exports["IDirectInputDevice8A_GetForceFeedbackState"] = this.exports["IDirectInputDevice2A_GetForceFeedbackState"];
        this.exports["IDirectInputDevice8A_SendForceFeedbackCommand"] = this.exports["IDirectInputDevice2A_SendForceFeedbackCommand"];
        this.exports["IDirectInputDevice8A_EnumCreatedEffectObjects"] = this.exports["IDirectInputDevice2A_EnumCreatedEffectObjects"];
        this.exports["IDirectInputDevice8A_Escape"] = this.exports["IDirectInputDevice2A_Escape"];
        this.exports["IDirectInputDevice8A_Poll"] = this.exports["IDirectInputDevice2A_Poll"];
        this.exports["IDirectInputDevice8A_SendDeviceData"] = this.exports["IDirectInputDevice2A_SendDeviceData"];
        this.exports["IDirectInputDevice8A_EnumEffectsInFile"] = () => DI_OK;
        this.exports["IDirectInputDevice8A_WriteEffectToFile"] = () => DI_OK;
        this.exports["IDirectInputDevice8A_BuildActionMap"] = (ctx, mem, args) => this.buildActionMap(ctx, mem, args);
        this.exports["IDirectInputDevice8A_SetActionMap"] = (ctx, mem, args) => this.setActionMap(ctx, mem, args);
        this.exports["IDirectInputDevice8A_GetImageInfo"] = (ctx, mem, args) => {
            const lpdiDevImageInfoHeader = args[1];
            if (!lpdiDevImageInfoHeader) return DIERR_INVALIDPARAM;
            const view = this.freshView();
            const size = view.getUint32(lpdiDevImageInfoHeader, true);
            if (size < 4) return DIERR_INVALIDPARAM;
            const cap = Math.min(size, 32);
            const m = this.getMemory();
            for (let i = 4; i < cap; i++) m[lpdiDevImageInfoHeader + i] = 0;
            view.setUint32(lpdiDevImageInfoHeader, cap, true);
            if (cap >= 8) view.setUint32(lpdiDevImageInfoHeader + 4, 0, true); // dwValid
            return DI_OK;
        };

        // IDirectInputDevice8W — identical vtable to IDirectInputDevice8A.
        this.exports["IDirectInputDevice8W_QueryInterface"] = this.exports["IDirectInputDeviceA_QueryInterface"];
        this.exports["IDirectInputDevice8W_AddRef"] = this.exports["IDirectInputDeviceA_AddRef"];
        this.exports["IDirectInputDevice8W_Release"] = this.exports["IDirectInputDeviceA_Release"];
        this.exports["IDirectInputDevice8W_GetCapabilities"] = this.exports["IDirectInputDeviceA_GetCapabilities"];
        this.exports["IDirectInputDevice8W_EnumObjects"] = this.exports["IDirectInputDeviceA_EnumObjects"];
        this.exports["IDirectInputDevice8W_GetProperty"] = this.exports["IDirectInputDeviceA_GetProperty"];
        this.exports["IDirectInputDevice8W_SetProperty"] = this.exports["IDirectInputDeviceA_SetProperty"];
        this.exports["IDirectInputDevice8W_Acquire"] = this.exports["IDirectInputDeviceA_Acquire"];
        this.exports["IDirectInputDevice8W_Unacquire"] = this.exports["IDirectInputDeviceA_Unacquire"];
        this.exports["IDirectInputDevice8W_GetDeviceState"] = this.exports["IDirectInputDeviceA_GetDeviceState"];
        this.exports["IDirectInputDevice8W_GetDeviceData"] = this.exports["IDirectInputDeviceA_GetDeviceData"];
        this.exports["IDirectInputDevice8W_SetDataFormat"] = this.exports["IDirectInputDeviceA_SetDataFormat"];
        this.exports["IDirectInputDevice8W_SetEventNotification"] = this.exports["IDirectInputDeviceA_SetEventNotification"];
        this.exports["IDirectInputDevice8W_SetCooperativeLevel"] = this.exports["IDirectInputDeviceA_SetCooperativeLevel"];
        this.exports["IDirectInputDevice8W_GetObjectInfo"] = this.exports["IDirectInputDeviceA_GetObjectInfo"];
        this.exports["IDirectInputDevice8W_GetDeviceInfo"] = this.exports["IDirectInputDeviceA_GetDeviceInfo"];
        this.exports["IDirectInputDevice8W_RunControlPanel"] = this.exports["IDirectInputDeviceA_RunControlPanel"];
        this.exports["IDirectInputDevice8W_Initialize"] = this.exports["IDirectInputDeviceA_Initialize"];
        this.exports["IDirectInputDevice8W_CreateEffect"] = this.exports["IDirectInputDevice2A_CreateEffect"];
        this.exports["IDirectInputDevice8W_EnumEffects"] = this.exports["IDirectInputDevice2A_EnumEffects"];
        this.exports["IDirectInputDevice8W_GetEffectInfo"] = this.exports["IDirectInputDevice2A_GetEffectInfo"];
        this.exports["IDirectInputDevice8W_GetForceFeedbackState"] = this.exports["IDirectInputDevice2A_GetForceFeedbackState"];
        this.exports["IDirectInputDevice8W_SendForceFeedbackCommand"] = this.exports["IDirectInputDevice2A_SendForceFeedbackCommand"];
        this.exports["IDirectInputDevice8W_EnumCreatedEffectObjects"] = this.exports["IDirectInputDevice2A_EnumCreatedEffectObjects"];
        this.exports["IDirectInputDevice8W_Escape"] = this.exports["IDirectInputDevice2A_Escape"];
        this.exports["IDirectInputDevice8W_Poll"] = this.exports["IDirectInputDevice2A_Poll"];
        this.exports["IDirectInputDevice8W_SendDeviceData"] = this.exports["IDirectInputDevice2A_SendDeviceData"];
        this.exports["IDirectInputDevice8W_EnumEffectsInFile"] = () => DI_OK;
        this.exports["IDirectInputDevice8W_WriteEffectToFile"] = () => DI_OK;
        this.exports["IDirectInputDevice8W_BuildActionMap"] = this.exports["IDirectInputDevice8A_BuildActionMap"];
        this.exports["IDirectInputDevice8W_SetActionMap"] = this.exports["IDirectInputDevice8A_SetActionMap"];
        this.exports["IDirectInputDevice8W_GetImageInfo"] = this.exports["IDirectInputDevice8A_GetImageInfo"];
    }

    // Create an IDirectInputDevice8A/W COM object of the given type, mapped into guest memory.
    // Returns the guest address, or 0 on failure.
    private createDevice8Object(
        mem: Uint8Array,
        deviceType: "keyboard" | "mouse" | "joystick" | "gamepad" | "unknown",
        wide = false,
    ): number {
        const vtableName = wide ? "IDirectInputDevice8W" : "IDirectInputDevice8A";
        const iid = wide ? IID_IDIRECTINPUTDEVICE8W : IID_IDIRECTINPUTDEVICE8A;
        const vtableAddr = this.vtables[vtableName]?.address;
        if (!vtableAddr) return 0;
        const obj = ComObjectFactory.create<DirectInputDeviceObject>(iid, vtableAddr, iid);
        if (!obj) return 0;
        obj.deviceType = deviceType;
        const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
        SystemResourceProvider.getInstance().mapAddressToHandle(objAddr, obj.handle);
        return objAddr;
    }

    /** DirectInputCreateEx riid -> the vtable that actually has the methods it will call. */
    private resolveDirectInputCreateExInterface(
        mem: Uint8Array,
        riidPtr: number,
    ): { iid: string; vtableName: "IDirectInputA" | "IDirectInput7A" } {
        const DI7A = { iid: IID_IDIRECTINPUT7A, vtableName: "IDirectInput7A" as const };
        if (!riidPtr) return DI7A;
        const b = this.readGuidBytes(mem, riidPtr);
        // Data1 little-endian: IID_IDirectInputA = 0x89521360, IID_IDirectInput2A = 0x5944e662.
        const data1 = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        if (data1 === 0x89521360) {
            return { iid: "89521360-AA8A-11CF-BFC7-444553540000", vtableName: "IDirectInputA" };
        }
        // IDirectInput2A is a strict prefix of IDirectInput7A, so the longer vtable serves both.
        return DI7A;
    }

    private resolveDirectInput8Interface(
        mem: Uint8Array,
        riidPtr: number,
    ): { iid: string; vtableName: "IDirectInput8A" | "IDirectInput8W" } {
        if (!riidPtr) {
            return { iid: IID_IDIRECTINPUT8A, vtableName: "IDirectInput8A" };
        }
        const bytes = this.readGuidBytes(mem, riidPtr);
        // IID_IDirectInput8W: bf798031-483a-4da2-aa99-5d64ed369700. Data1 (0xbf798031)
        // is stored little-endian, so the first four raw bytes are 31 80 79 bf.
        if (bytes[0] === 0x31 && bytes[1] === 0x80 && bytes[2] === 0x79 && bytes[3] === 0xbf) {
            return { iid: IID_IDIRECTINPUT8W, vtableName: "IDirectInput8W" };
        }
        return { iid: IID_IDIRECTINPUT8A, vtableName: "IDirectInput8A" };
    }

    // IDirectInput8::EnumDevicesBySemantics — the DI8 action-mapping entry point.
    // Signature: (this, ptszUserName, lpdiActionFormat, lpCallback, pvRef, dwFlags).
    // For each applicable device we synthesize a DIDEVICEINSTANCE *and* a live
    // IDirectInputDevice8A object, then invoke the callback
    //   BOOL cb(LPCDIDEVICEINSTANCE pddi, LPDIRECTINPUTDEVICE8 lpdid, DWORD dwFlags,
    //           DWORD dwRemaining, LPVOID pvRef)
    // passing the created device as arg2 (this is what distinguishes it from EnumDevices —
    // the app receives a ready device, then calls BuildActionMap/SetActionMap on it).
    // The async enumeration plumbing mirrors IDirectInputA_EnumDevices.
    private enumDevicesBySemantics(ctx: any, mem: Uint8Array, args: number[], resourceProvider: SystemResourceProvider, wide = false): any {
        {
            const lpCallback = args[3];
            const pvRef = args[4];
            const dwFlags = args[5];
            Logger.log(LogCategory.SYSTEM, `IDirectInput8A_EnumDevicesBySemantics: cb=0x${(lpCallback ?? 0).toString(16)} pvRef=0x${(pvRef ?? 0).toString(16)} flags=0x${(dwFlags ?? 0).toString(16)}`);

            if (!lpCallback) return DI_OK;

            // Devices applicable to a semantic action map: keyboard + mouse are always present;
            // a gamepad/wheel joins when the browser reports one connected. DI8 device types
            // (low byte read by the game's callback at DIDEVICEINSTANCE+0x24).
            const devices: Array<{ devType: number; type: "keyboard" | "mouse" | "joystick"; instanceName: string; productName: string; guid: number[] }> = [
                { devType: DI8DEVTYPE_KEYBOARD, type: "keyboard", instanceName: "Keyboard", productName: "Standard 101/102-Key or Microsoft Natural PS/2 Keyboard", guid: GUID_SYS_KEYBOARD },
                { devType: DI8DEVTYPE_MOUSE, type: "mouse", instanceName: "Mouse", productName: "Microsoft PS/2 Mouse", guid: GUID_SYS_MOUSE },
            ];
            if (System.getInstance().inputManager.getGamepadState().connected) {
                devices.push({ devType: DI8DEVTYPE_JOYSTICK, type: "joystick", instanceName: "Gamepad", productName: "Browser Gamepad", guid: GUID_SYS_GAMEPAD });
            }

            let currentIdx = 0;
            const allocatedMemory: number[] = [];
            const callbackMgr = this.process.dispatcher.callbackManager;
            if (!callbackMgr) return DI_OK;
            // EnumDevicesBySemantics is stdcall with 6 params → RET 24.
            const frameId = callbackMgr.saveSuspendedThunkContext(ctx, 0x18, "IDirectInput8A_EnumDevicesBySemantics");
            if (frameId === 0) {
                Logger.warn(LogCategory.SYSTEM, 'IDirectInput8A_EnumDevicesBySemantics: could not save suspended frame');
                return DI_OK;
            }

            let firstCallbackId: number | null = null;

            const freeAll = (): void => {
                for (const addr of allocatedMemory) this.process.memory.free(addr);
                allocatedMemory.length = 0;
            };

            const processNextDevice = (): void => {
                if (currentIdx >= devices.length) return;
                const device = devices[currentIdx++];

                // Synthesize the DIDEVICEINSTANCE for this device.
                const diAddr = this.process.memory.alloc(DIDEVICEINSTANCEA_SIZE);
                allocatedMemory.push(diAddr);
                const curMem = this.getMemory();
                const curView = new DataView(curMem.buffer, curMem.byteOffset, curMem.byteLength);
                for (let i = 0; i < DIDEVICEINSTANCEA_SIZE; i++) curMem[diAddr + i] = 0;
                curView.setUint32(diAddr, DIDEVICEINSTANCEA_SIZE, true);
                for (let i = 0; i < 16; i++) curMem[diAddr + 4 + i] = device.guid[i];       // guidInstance
                for (let i = 0; i < 16; i++) curMem[diAddr + 20 + i] = device.guid[i];      // guidProduct
                curView.setUint32(diAddr + 36, device.devType, true);                       // dwDevType (low byte @ +0x24)
                const inName = encodeAnsi(device.instanceName);
                for (let i = 0; i < Math.min(inName.length, 259); i++) curMem[diAddr + 40 + i] = inName[i];
                const prName = encodeAnsi(device.productName);
                for (let i = 0; i < Math.min(prName.length, 259); i++) curMem[diAddr + 300 + i] = prName[i];

                // Create the live device object the callback will receive + use.
                const deviceAddr = this.createDevice8Object(curMem, device.type, wide);
                if (deviceAddr === 0) { freeAll(); return; }

                const dwRemaining = devices.length - currentIdx; // unmapped semantic actions left
                const { callbackId } = callbackMgr.invokeCallback(
                    lpCallback,
                    [diAddr, deviceAddr, 0, dwRemaining, pvRef],
                    0, // callback is stdcall (RET 20) — callee cleans its own args
                    (cbRet) => {
                        this.process.memory.free(diAddr);
                        const idx = allocatedMemory.indexOf(diAddr);
                        if (idx >= 0) allocatedMemory.splice(idx, 1);
                        // FALSE stops enumeration; otherwise continue until devices exhausted.
                        if (cbRet === 0 || currentIdx >= devices.length) { freeAll(); return DI_OK; }
                        return null;
                    },
                    false,
                    "IDirectInput8A_EnumDevicesBySemantics",
                    frameId,
                );

                if (firstCallbackId === null) firstCallbackId = callbackId;
                const invocation = callbackMgr.getPendingCallback(callbackId);
                if (invocation) {
                    invocation.enumerationState = { continueEnumeration: processNextDevice, finishEnumeration: () => freeAll() };
                    if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                        const firstInv = callbackMgr.getPendingCallback(firstCallbackId);
                        if (firstInv?.thunkContext) invocation.thunkContext = firstInv.thunkContext;
                    }
                }
            };

            // createDevice8Object can fail before the first invoke, and invokeCallback can
            // refuse or throw. Either way the saved frame has pinned this thread, so hand it
            // back and complete synchronously instead of announcing a suspension nobody ends.
            try {
                processNextDevice();
            } catch (e) {
                Logger.error(LogCategory.SYSTEM,
                    `IDirectInput8A_EnumDevicesBySemantics: callback dispatch failed: ${(e as Error)?.message ?? e}`);
            }
            if (!firstCallbackId) {
                callbackMgr.abandonSuspendedFrame(frameId);
                freeAll();
                return DI_OK;
            }
            return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId, stackCleanup: 0x18 };
        };
    }

    private readGuestAnsiString(ptr: number, maxLen = 260): string {
        if (!ptr) return "";
        const m = this.getMemory();
        let end = ptr;
        const limit = Math.min(ptr + maxLen, m.length);
        while (end < limit && m[end] !== 0) end++;
        return new TextDecoder().decode(m.subarray(ptr, end));
    }

    private actionMapGuidString(lpdiaf: number, view: DataView): string {
        const bytes: number[] = [];
        for (let i = 0; i < 16; i++) bytes.push(view.getUint8(lpdiaf + DIAF_OFS_GUID + i));
        return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    private actionMapRegistryKey(user: string, deviceType: string, actionMapGuid: string): string {
        return `${user}|${deviceType}|${actionMapGuid}`;
    }

    private buildActionMap(ctx: any, mem: Uint8Array, args: number[]): number {
        const lpdiaf = args[1];
        const lpszUserName = args[2];
        const dwFlags = args[3] ?? 0;
        if (!lpdiaf) return DIERR_INVALIDPARAM;
        const view = this.freshView();
        const numActions = view.getUint32(lpdiaf + DIAF_OFS_NUMACTIONS, true);
        const actionSize = view.getUint32(lpdiaf + DIAF_OFS_ACTIONSIZE, true) || DIACTION_SIZE_DEFAULT;
        const rgoAction = view.getUint32(lpdiaf + DIAF_OFS_RGOACTION, true);
        if (!rgoAction || numActions > 4096) return DIERR_INVALIDPARAM;

        const device = this.getDevice(args[0]);
        const devType = device?.deviceType ?? "keyboard";
        const preserve = (dwFlags & DIDBAM_PRESERVE) !== 0;
        const hwDefaults = (dwFlags & DIDBAM_HWDEFAULTS) !== 0 || !preserve;
        const user = this.readGuestAnsiString(lpszUserName);
        const mapGuid = this.actionMapGuidString(lpdiaf, view);
        const saved = user ? this.savedActionMaps.get(this.actionMapRegistryKey(user, devType, mapGuid)) : undefined;

        let mapped = 0;
        for (let i = 0; i < numActions; i++) {
            const base = rgoAction + i * actionSize;
            const flags = Mem.readUint32(base + DIACTION_OFS_FLAGS) ?? 0;
            if (flags & DIA_APPNOMAP) continue;
            const sem = Mem.readUint32(base + DIACTION_OFS_SEMANTIC) ?? 0;
            let objId = Mem.readUint32(base + DIACTION_OFS_OBJID) ?? 0;

            if (saved) {
                const binding = saved.find((b) => b.semantic === sem);
                if (binding) {
                    Mem.writeUint32(base + DIACTION_OFS_OBJID, binding.objId >>> 0);
                    Mem.writeUint32(base + DIACTION_OFS_HOW, binding.how >>> 0);
                    objId = binding.objId;
                }
            }

            if (preserve && objId !== 0) {
                mapped++;
                continue;
            }
            if ((flags & DIA_APPMAPPED) && objId !== 0) {
                mapped++;
                continue;
            }

            if (hwDefaults) {
                const built = buildObjIdForDevice(sem, devType);
                if (built !== null) {
                    Mem.writeUint32(base + DIACTION_OFS_OBJID, built >>> 0);
                    Mem.writeUint32(base + DIACTION_OFS_HOW, DIAH_DEFAULT);
                    Mem.writeUint32(base + DIACTION_OFS_FLAGS, (flags | DIA_APPMAPPED) >>> 0);
                    mapped++;
                }
            }
        }
        Logger.log(LogCategory.SYSTEM, `IDirectInputDevice8A_BuildActionMap: type=${devType} actions=${numActions} mapped=${mapped}`);
        return DI_OK;
    }

    // IDirectInputDevice8::SetActionMap — record bindings for buffered GetDeviceData (axes, hats, mouse, gamepad).
    private setActionMap(ctx: any, mem: Uint8Array, args: number[]): number {
        const lpdiaf = args[1];
        const lpszUserName = args[2];
        const dwFlags = args[3] ?? 0;
        const device = this.getDevice(args[0]);
        if (!lpdiaf || !device) return DIERR_INVALIDPARAM;
        const view = this.freshView();
        const numActions = view.getUint32(lpdiaf + DIAF_OFS_NUMACTIONS, true);
        const actionSize = view.getUint32(lpdiaf + DIAF_OFS_ACTIONSIZE, true) || DIACTION_SIZE_DEFAULT;
        const rgoAction = view.getUint32(lpdiaf + DIAF_OFS_RGOACTION, true);
        if (!rgoAction || numActions > 4096) return DIERR_INVALIDPARAM;

        const devType = device.deviceType === "unknown" ? "keyboard" : device.deviceType;
        device.deviceType = devType;
        const user = (dwFlags & DIDSAM_NOUSER) ? "" : this.readGuestAnsiString(lpszUserName);
        const mapGuid = this.actionMapGuidString(lpdiaf, view);
        device.actionMapGuid = mapGuid;

        const map: ActionMapEntry[] = [];
        const toSave: SavedActionBinding[] = [];
        for (let i = 0; i < numActions; i++) {
            const base = rgoAction + i * actionSize;
            const uAppData = Mem.readUint32(base + DIACTION_OFS_UAPPDATA) ?? 0;
            const sem = Mem.readUint32(base + DIACTION_OFS_SEMANTIC) ?? 0;
            const flags = Mem.readUint32(base + DIACTION_OFS_FLAGS) ?? 0;
            if (flags & DIA_APPNOMAP) continue;
            let objId = Mem.readUint32(base + DIACTION_OFS_OBJID) ?? 0;
            const how = Mem.readUint32(base + DIACTION_OFS_HOW) ?? DIAH_DEFAULT;
            if (!objId) {
                const built = buildObjIdForDevice(sem, devType);
                if (built !== null) objId = built;
            }
            if (!objId) continue;
            const entry = makeActionMapEntry(uAppData, sem, objId, devType);
            if (!entry) continue;
            map.push(entry);
            toSave.push({ uAppData, semantic: sem, objId: objId >>> 0, how: how >>> 0 });
        }
        device.actionMap = map;
        device.isActionMapped = true;
        device.seq = 0;
        this.noteActionMapKeys(map);

        const save = (user.length > 0 || (dwFlags & DIDSAM_FORCESAVE) !== 0) && toSave.length > 0;
        if (save) {
            this.savedActionMaps.set(this.actionMapRegistryKey(user, devType, mapGuid), toSave);
        }

        Logger.log(LogCategory.SYSTEM, `IDirectInputDevice8A_SetActionMap: this=0x${args[0].toString(16)} type=${devType} boundActions=${map.length}/${numActions}`);
        return DI_OK;
    }

    /**
     * Publish the keys an action map binds (DIK → VK) as observed-pressed telemetry.
     * A DirectInput-only title never calls GetAsyncKeyState, so its action map is the
     * only statement it makes about which keys it steers with.
     */
    private noteActionMapKeys(map: ActionMapEntry[]): void {
        const inputManager = System.getInstance().inputManager;
        for (const e of map) {
            for (const dik of [e.dik, e.dikNeg, e.dikPos]) {
                if (dik === undefined) continue;
                const vk = DIK_TO_VK[dik];
                if (vk !== undefined) inputManager.noteGuestKeyRead(vk, true);
            }
        }
    }

    private freshView(): DataView {
        const m = this.getMemory();
        return new DataView(m.buffer, m.byteOffset, m.byteLength);
    }

    // Current pressed state (0x80/0x00) of a mapped DIK, read from the VK-indexed keyboard state.
    private dikPressed(keyStatesVk: Uint8Array, dik: number): number {
        const vk = DIK_TO_VK[dik];
        if (vk === undefined) return 0;
        return keyStatesVk[vk] ? 0x80 : 0x00;
    }

    // Buffered read for an action-mapped device (keyboard axes/hats, mouse, gamepad).
    private getActionMappedDeviceData(
        device: DirectInputDeviceObject, cbObjectData: number, rgdod: number,
        pdwInOut: number, dwFlags: number, view: DataView
    ): number {
        if (!device.acquired) {
            return DIERR_NOTACQUIRED;
        }

        const inputManager = System.getInstance().inputManager;
        const ks = inputManager.getKeyboardStateVk();
        const dikPressed = (dik: number) => this.dikPressed(ks, dik);
        const arrowKeys = {
            up: !!ks[0x26],
            down: !!ks[0x28],
            left: !!ks[0x25],
            right: !!ks[0x27],
        };

        let mouseDx = 0;
        let mouseDy = 0;
        let mouseDz = 0;
        const mouseState = inputManager.getMouseState();
        // Action-map data is edge-derived from the level, so it loses a press the same way
        // immediate mode does. Same latch, same per-device one-read consumption.
        const mouseButtons = device.deviceType === "mouse"
            ? this.readMouseButtons(device)
            : mouseState.buttons;
        let prevButtons = device.mousePollPrevButtons;
        if (device.deviceType === "mouse") {
            const accum = inputManager.getDInputAccum();
            inputManager.noteGuestRelativeMouseRead();
            if (device.mouseInitialized) {
                mouseDx = (accum.x - device.lastDInputAccumX) | 0;
                mouseDy = (accum.y - device.lastDInputAccumY) | 0;
            }
            device.lastDInputAccumX = accum.x;
            device.lastDInputAccumY = accum.y;
            device.mouseInitialized = true;
            mouseDz = inputManager.consumeDInputWheel();
        }

        const gamepad = inputManager.getGamepadState();
        const changed = pollActionMapEntries(
            device.actionMap,
            dikPressed,
            arrowKeys,
            { dx: mouseDx, dy: mouseDy, dz: mouseDz, buttons: mouseButtons, prevButtons },
            gamepad,
        );
        if (device.deviceType === "mouse") {
            device.mousePollPrevButtons = mouseButtons;
        }

        const pending = changed.length;
        const peek = (dwFlags & DIGDD_PEEK) !== 0;
        const maxItems = pdwInOut ? view.getUint32(pdwInOut, true) : 0;
        if (!rgdod || peek) {
            const reportable = !rgdod ? pending : Math.min(maxItems, pending);
            if (pdwInOut) view.setUint32(pdwInOut, reportable, true);
            return pending > maxItems && rgdod ? DI_BUFFEROVERFLOW : DI_OK;
        }
        if (maxItems === 0) { if (pdwInOut) view.setUint32(pdwInOut, 0, true); return DI_OK; }

        const stride = Math.max(cbObjectData, DIDEVICEOBJECTDATA8_SIZE);
        const tick = (System.getInstance().services.time.nowMs() | 0) >>> 0;
        const n = Math.min(changed.length, maxItems);
        const wv = this.freshView();
        for (let i = 0; i < n; i++) {
            const { entry: e, dwData } = changed[i];
            const addr = rgdod + i * stride;
            wv.setUint32(addr, e.dwOfs >>> 0, true);
            wv.setUint32(addr + 4, dwData >>> 0, true);
            wv.setUint32(addr + 8, tick, true);
            wv.setUint32(addr + 12, (++device.seq) >>> 0, true);
            wv.setUint32(addr + 16, e.uAppData >>> 0, true);
        }
        if (pdwInOut) view.setUint32(pdwInOut, n, true);
        return changed.length > maxItems ? DI_BUFFEROVERFLOW : DI_OK;
    }

    private getMemory(): Uint8Array {
        return this.process.getCurrentMemory();
    }


    /** Registered on the first armed handle: the input manager fires this whenever a poll
     *  produced buffered device data, and every armed device gets its event signalled.
     *  Waiters are edge-triggered, so signalling an event no one waits on is harmless —
     *  the app resets it itself. */
    private dinputDataListener: (() => void) | null = null;

    private armDInputNotifier(): void {
        if (this.dinputDataListener) return;
        this.dinputDataListener = () => notifyRegistry.signal();
        System.getInstance().inputManager.addDInputDataListener(this.dinputDataListener);
    }

    private getDevice(thisPtr: number): DirectInputDeviceObject | null {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr);
        return obj instanceof DirectInputDeviceObject ? obj : null;
    }

    /**
     * Mouse button LEVEL for one device, carrying a sub-frame press the host published
     * and released between two guest reads. The latch behind it is per input-manager,
     * but "seen exactly once" is a per-DEVICE contract: a title reading the mouse in a
     * UI pass and a camera pass, or running immediate-mode GetDeviceState alongside an
     * action map, must see the click in each. So the drained edge is held for an epoch
     * and handed to every device once; the first device to come back for a second read
     * retires it.
     */
    private readMouseButtons(device: DirectInputDeviceObject | null): number {
        const inputManager = System.getInstance().inputManager;
        const level = inputManager.getMouseState().buttons >>> 0;
        const edges = (inputManager.consumeMouseButtonLatch() >>> 0) & ~level;
        if (edges) {
            this.latchedMouseEdges = edges;
            this.mouseLatchEpoch++;
        }
        if (!device) return level | edges;
        if (!this.latchedMouseEdges) return level;
        if (device.mouseLatchEpoch === this.mouseLatchEpoch) {
            this.latchedMouseEdges = 0;
            return level;
        }
        device.mouseLatchEpoch = this.mouseLatchEpoch;
        return level | this.latchedMouseEdges;
    }

    private resolveDeviceType(mem: Uint8Array, guidPtr: number): "keyboard" | "mouse" | "joystick" | "gamepad" | "unknown" {
        if (!guidPtr) return "unknown";
        const guidBytes = this.readGuidBytes(mem, guidPtr);
        if (this.guidEquals(guidBytes, GUID_SYS_KEYBOARD)) return "keyboard";
        if (this.guidEquals(guidBytes, GUID_SYS_MOUSE)) return "mouse";
        if (this.guidEquals(guidBytes, GUID_SYS_GAMEPAD)) return "gamepad";
        return "unknown";
    }

    private resolveDataFormat(deviceType: string, dataSize: number): "keyboard" | "mouse" | "joystick" | "gamepad" | "unknown" {
        if (dataSize === DIKEYBOARDSTATE_SIZE) return "keyboard";
        if (dataSize === DIMOUSESTATE_SIZE || dataSize === DIMOUSESTATE2_SIZE) return "mouse";
        if (dataSize >= DIJOYSTATE_SIZE) return "gamepad";
        if (deviceType === "keyboard" || deviceType === "mouse") return deviceType as any;
        if (deviceType === "gamepad" || deviceType === "joystick") return "gamepad";
        return "unknown";
    }

    private getDeviceTypeValue(deviceType: string): number {
        switch (deviceType) {
            case "keyboard":
                return DIDEVTYPE_KEYBOARD;
            case "mouse":
                return DIDEVTYPE_MOUSE;
            case "joystick":
                return DIDEVTYPE_JOYSTICK;
            case "gamepad":
                return DIDEVTYPE_GAMEPAD;
            default:
                return DIDEVTYPE_DEVICE;
        }
    }

    private readGuidBytes(mem: Uint8Array, address: number): Uint8Array {
        const bytes = new Uint8Array(16);
        if (address <= 0 || address + 16 > mem.length) {
            return bytes;
        }
        for (let i = 0; i < 16; i++) {
            bytes[i] = mem[address + i] ?? 0;
        }
        return bytes;
    }

    private guidEquals(a: Uint8Array, b: number[]): boolean {
        if (a.length < 16 || b.length < 16) return false;
        for (let i = 0; i < 16; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    private writeDeviceInstance(mem: Uint8Array, address: number, size: number, deviceType: string): void {
        const freshMem = this.getMemory();
        const view = new DataView(freshMem.buffer, freshMem.byteOffset, freshMem.byteLength);
        const cappedSize = Math.min(size, DIDEVICEINSTANCEA_SIZE);
        for (let i = 0; i < cappedSize; i++) mem[address + i] = 0;
        view.setUint32(address, cappedSize, true);

        const isKeyboard = deviceType === "keyboard";
        const isMouse = deviceType === "mouse";
        const isGamepad = deviceType === "gamepad" || deviceType === "joystick";
        const guidInstance = isKeyboard ? GUID_SYS_KEYBOARD : (isMouse ? GUID_SYS_MOUSE : (isGamepad ? GUID_SYS_GAMEPAD : GUID_SYS_KEYBOARD));
        const guidProduct = guidInstance;
        const devType = isKeyboard ? DIDEVTYPE_KEYBOARD : (isMouse ? DIDEVTYPE_MOUSE : (isGamepad ? DIDEVTYPE_JOYSTICK : DIDEVTYPE_DEVICE));
        const instanceName = isKeyboard ? "Keyboard" : (isMouse ? "Mouse" : (isGamepad ? "Gamepad" : "Input Device"));
        const productName = isKeyboard ? "Standard Keyboard" : (isMouse ? "Standard Mouse" : (isGamepad ? "Browser Gamepad" : "Input Device"));

        let offset = 4;
        if (offset + 16 <= cappedSize) {
            for (let i = 0; i < 16; i++) mem[address + offset + i] = guidInstance[i];
        }
        offset += 16;
        if (offset + 16 <= cappedSize) {
            for (let i = 0; i < 16; i++) mem[address + offset + i] = guidProduct[i];
        }
        offset += 16;
        if (offset + 4 <= cappedSize) view.setUint32(address + offset, devType, true);
        offset += 4;
        if (offset + 260 <= cappedSize) {
            const bytes = encodeAnsi(instanceName);
            for (let i = 0; i < Math.min(bytes.length, 259); i++) mem[address + offset + i] = bytes[i];
        }
        offset += 260;
        if (offset + 260 <= cappedSize) {
            const bytes = encodeAnsi(productName);
            for (let i = 0; i < Math.min(bytes.length, 259); i++) mem[address + offset + i] = bytes[i];
        }
    }

    reset(): void {
        resetLosableDevices();
        // The device objects of the old process are gone and their event handles will be
        // recycled, so anything still tracked would signal an unrelated object / be
        // reported by the harness readout as a live device of the new process.
        notifyRegistry.reset();
        clearExclusiveMouseOwners();
        liveDInputDevices.clear();
        if (this.dinputDataListener) {
            System.getInstance().inputManager.removeDInputDataListener(this.dinputDataListener);
            this.dinputDataListener = null;
        }
        this.savedActionMaps.clear();
        this.latchedMouseEdges = 0;
        this.mouseLatchEpoch = 0;
    }

    recreateVTables(): void {
        // Recreate vtables after memory reset
        if (this.process) {
            this.vtables = createVTablesFromDescriptor(this.process, dinputModule);
            Logger.verbose(LogCategory.SYSTEM, `DirectInput: Recreated vtables after reset`);

            // Log vtable addresses for debugging
            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.SYSTEM, `DirectInput: Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }
}
