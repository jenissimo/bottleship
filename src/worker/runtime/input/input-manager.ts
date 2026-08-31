/**
 * InputManager - reads browser input from SharedArrayBuffer
 * and injects Windows messages into the message queue.
 */

import { WindowManager } from '../windowing/window-manager';
import type { WindowObject } from '../windowing/window-manager';
import { Logger, LogCategory } from '../../core/logger';
import { getAbsoluteWindowPosition, clampToCursorClip, getWindowByHandle } from '../../modules/user32/shared-state';
import { vkToDik } from '../../modules/dinput/dinput-vk-dik';
import { TimeService } from '../time';
import { markJoystickInputLost } from '../../modules/dinput/device-presence';
import { broadcastGamepadDeviceChange } from '../../modules/user32/device-notify';
import { GamepadPresenceTracker } from './gamepad-presence';
import { isExclusiveMouseAcquired } from '../../core/pointer-policy';
import {
    GUEST_POLLED_KEYS_BASE,
    GUEST_POLLED_KEYS_COUNT,
    INPUT_INDEX,
    KEY_BITFIELD_BASE,
    KEY_BITFIELD_COUNT,
    beginInputWrite,
    endInputWrite,
} from '../../../input/sab-layout';

// Windows message constants
const WM_SETCURSOR     = 0x0020;
const HTCLIENT         = 1;
const WM_MOUSEMOVE     = 0x0200;
const WM_LBUTTONDOWN   = 0x0201;
const WM_LBUTTONUP     = 0x0202;
/** WNDCLASS.style bit that opts a class into WM_*BUTTONDBLCLK. */
const CS_DBLCLKS = 0x0008;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_RBUTTONDOWN   = 0x0204;
const WM_RBUTTONUP     = 0x0205;
const WM_RBUTTONDBLCLK = 0x0206;
const WM_MBUTTONDOWN   = 0x0207;
const WM_MBUTTONUP     = 0x0208;
const WM_MBUTTONDBLCLK = 0x0209;
const WM_MOUSEWHEEL    = 0x020A;
const WM_MOUSEHOVER    = 0x02A1;
const WM_MOUSELEAVE    = 0x02A3;
const WM_KEYDOWN       = 0x0100;
const WM_KEYUP         = 0x0101;

// TrackMouseEvent flags
const TME_HOVER  = 0x00000001;
const TME_LEAVE  = 0x00000002;
const TME_CANCEL = 0x80000000;

// DirectInput buffered event (GetDeviceData for keyboard, mouse, gamepad)
export interface DInputBufferedEvent {
    dwOfs: number;       // DIK offset, DIMOFS_*, or DIJOFS_*
    dwData: number;      // value (0x80/0x00 for keys/buttons, axis delta/value for axes)
    dwTimeStamp: number; // ms timestamp
    dwSequence: number;  // sequence number
}

/** @deprecated use DInputBufferedEvent */
export type DInputMouseEvent = DInputBufferedEvent;

/** One entry of the DI production trail the harness `dinput` state section reads. */
export interface DInputTrailEntry {
    dev: "mouse" | "keyboard" | "gamepad";
    ofs: number;
    data: number;
    seq: number;
}

const DINPUT_TRAIL_MAX = 64;

// DIJOFS_* within DIJOYSTATE (matches dinput.h / our GetDeviceState layout)
const DIJOFS_X = 0;
const DIJOFS_Y = 4;
const DIJOFS_RX = 12;
const DIJOFS_RY = 16;
const DIJOFS_BUTTON0 = 48;

const KEY_STATE_BYTES = 256;

// Mouse button flags
const MK_LBUTTON = 0x0001;
const MK_RBUTTON = 0x0002;
const MK_MBUTTON = 0x0010;

const VK_CAPITAL = 0x14;
const VK_NUMLOCK = 0x90;
const VK_SCROLL  = 0x91;

// VK → OEM hardware scan code mapping (Set 1 / AT keyboard)
const VK_TO_SCAN: Record<number, number> = {
    // Letters A-Z (0x41-0x5A) → 0x1E-0x32 handled inline
    // Digits 0-9 (0x30-0x39) → 0x0B,0x02-0x0A handled inline
    0x08: 0x0E, // VK_BACK
    0x09: 0x0F, // VK_TAB
    0x0D: 0x1C, // VK_RETURN
    0x10: 0x2A, // VK_SHIFT (left)
    0x11: 0x1D, // VK_CONTROL (left)
    0x12: 0x38, // VK_MENU (left alt)
    0x13: 0x45, // VK_PAUSE
    0x14: 0x3A, // VK_CAPITAL
    0x1B: 0x01, // VK_ESCAPE
    0x20: 0x39, // VK_SPACE
    0x21: 0x49, // VK_PRIOR (Page Up)
    0x22: 0x51, // VK_NEXT  (Page Down)
    0x23: 0x4F, // VK_END
    0x24: 0x47, // VK_HOME
    0x25: 0x4B, // VK_LEFT
    0x26: 0x48, // VK_UP
    0x27: 0x4D, // VK_RIGHT
    0x28: 0x50, // VK_DOWN
    0x2C: 0x37, // VK_SNAPSHOT (PrintScreen)
    0x2D: 0x52, // VK_INSERT
    0x2E: 0x53, // VK_DELETE
    // Numpad
    0x60: 0x52, // VK_NUMPAD0
    0x61: 0x4F, // VK_NUMPAD1
    0x62: 0x50, // VK_NUMPAD2
    0x63: 0x51, // VK_NUMPAD3
    0x64: 0x4B, // VK_NUMPAD4
    0x65: 0x4C, // VK_NUMPAD5
    0x66: 0x4D, // VK_NUMPAD6
    0x67: 0x47, // VK_NUMPAD7 (same physical key as Home)
    0x68: 0x48, // VK_NUMPAD8 (same physical key as Up)
    0x69: 0x49, // VK_NUMPAD9 (same physical key as PgUp; numpad distinguished by NO extended bit)
    0x6A: 0x37, // VK_MULTIPLY
    0x6B: 0x4E, // VK_ADD
    0x6D: 0x4A, // VK_SUBTRACT
    0x6E: 0x53, // VK_DECIMAL
    0x6F: 0x35, // VK_DIVIDE
    // F-keys
    0x70: 0x3B, // F1
    0x71: 0x3C, // F2
    0x72: 0x3D, // F3
    0x73: 0x3E, // F4
    0x74: 0x3F, // F5
    0x75: 0x40, // F6
    0x76: 0x41, // F7
    0x77: 0x42, // F8
    0x78: 0x43, // F9
    0x79: 0x44, // F10
    0x7A: 0x57, // F11
    0x7B: 0x58, // F12
    0x90: 0x45, // VK_NUMLOCK
    0x91: 0x46, // VK_SCROLL
    // Side-distinguished modifiers. Same make code as the physical key; the RIGHT
    // variants differ only by the extended bit (see EXTENDED_VK), exactly as
    // DIK_RCONTROL/DIK_RMENU are DIK_LCONTROL/DIK_LMENU + 0xE0.
    0xA0: 0x2A, // VK_LSHIFT
    0xA1: 0x36, // VK_RSHIFT (own make code, NOT extended)
    0xA2: 0x1D, // VK_LCONTROL
    0xA3: 0x1D, // VK_RCONTROL (extended)
    0xA4: 0x38, // VK_LMENU
    0xA5: 0x38, // VK_RMENU (extended)
    // OEM keys (US layout)
    0xBA: 0x27, // OEM_1 (;:)
    0xBB: 0x0D, // OEM_PLUS (=+)
    0xBC: 0x33, // OEM_COMMA
    0xBD: 0x0C, // OEM_MINUS
    0xBE: 0x34, // OEM_PERIOD
    0xBF: 0x35, // OEM_2 (/?)
    0xC0: 0x29, // OEM_3 (`~)
    0xDB: 0x1A, // OEM_4 ([{)
    0xDC: 0x2B, // OEM_5 (\|)
    0xDD: 0x1B, // OEM_6 (]})
    0xDE: 0x28, // OEM_7 ('")
};

// Extended keys (bit 24 set in lParam) — navigation cluster + right-hand modifiers
const EXTENDED_VK = new Set([
    0x21, 0x22, 0x23, 0x24, // PageUp, PageDown, End, Home
    0x25, 0x26, 0x27, 0x28, // Left, Up, Right, Down
    0x2D, 0x2E,             // Insert, Delete
    0x5B, 0x5C,             // LWin, RWin
    0x6F,                   // Numpad Divide (only numpad key that's extended)
    0x90,                   // NumLock
    0x2C,                   // PrintScreen
    0xA3, 0xA5,             // RControl, RMenu (right modifiers are E0-prefixed)
]);

// Letter scan codes (VK 0x41='A' .. 0x5A='Z'), set-1 make codes in PHYSICAL QWERTY
// order — NOT alphabetical. These are identical to the DIK_* codes used by the
// DirectInput path (VK_TO_DIK_ALPHANUM in dinput-vk-dik.ts); a Win32 OEM scan code
// and a DirectInput scan code are the same value. Games that identify a key by the
// lParam scan code (bits 16-23) — e.g. Unreal-engine WinDrv — get the wrong key for
// every letter except 'A' if this is computed by the naive `vk-0x41+0x1E` formula.
const LETTER_SCAN: readonly number[] = [
    0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, // A-M
    0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C, // N-Z
];

/** Map VK code to OEM hardware scan code */
export function vkToScanCode(vk: number): number {
    // Letters A-Z (physical layout, not alphabetical)
    if (vk >= 0x41 && vk <= 0x5A) return LETTER_SCAN[vk - 0x41];
    // Digits 0-9: '1'→0x02 .. '9'→0x0A, '0'→0x0B
    if (vk >= 0x31 && vk <= 0x39) return vk - 0x30 + 1; // '1'=0x02
    if (vk === 0x30) return 0x0B; // '0'
    return VK_TO_SCAN[vk] ?? vk;
}

/** Check if VK code is an extended key (bit 24 in lParam) */
export function isExtendedKey(vk: number): boolean {
    return EXTENDED_VK.has(vk);
}

function isToggleKey(vk: number): boolean {
    return vk === VK_CAPITAL || vk === VK_NUMLOCK || vk === VK_SCROLL;
}

/** [side-agnostic, left, right] for each modifier Windows keeps coherent. */
const MODIFIER_SIDES: readonly (readonly [number, number, number])[] = [
    [0x10, 0xA0, 0xA1], // VK_SHIFT / VK_LSHIFT / VK_RSHIFT
    [0x11, 0xA2, 0xA3], // VK_CONTROL / VK_LCONTROL / VK_RCONTROL
    [0x12, 0xA4, 0xA5], // VK_MENU / VK_LMENU / VK_RMENU
];

/** The side VKs, which never carry a window message of their own (see below). */
const SIDE_MODIFIER_VK = new Set([0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]);

/**
 * Make a modifier's side-agnostic VK and its two side VKs agree, the way the Windows
 * keyboard driver does: it sets both halves, so GetKeyState(VK_SHIFT) answers for
 * either side and GetKeyState(VK_LSHIFT) answers for a left-hand press. Our producers
 * each publish only one half — a browser KeyboardEvent carries the agnostic VK
 * (keyCode 16/17/18), the on-screen keyboard a side one — so the record is reconciled
 * before anything diffs it. Without this a latched on-screen Shift is invisible to
 * GetKeyState(VK_SHIFT), which is what shift-tab and shift-select are written against.
 */
function isVkSet(bits: Int32Array, vk: number): boolean {
    return (bits[vk >> 5] & (1 << (vk & 31))) !== 0;
}

function setVk(bits: Int32Array, vk: number): void {
    bits[vk >> 5] |= 1 << (vk & 31);
}

function reconcileModifierSides(bits: Int32Array): void {
    for (const [both, left, right] of MODIFIER_SIDES) {
        if (isVkSet(bits, left) || isVkSet(bits, right)) setVk(bits, both);
        // Agnostic-only: the event carried no side, and the scan code Windows would
        // have reported for it is the left one.
        else if (isVkSet(bits, both)) setVk(bits, left);
    }
}

// Modifiers never own the typematic schedule (Windows does not auto-repeat them),
// but holding one must not cancel the repeat of the letter it modifies.
const MODIFIER_VK = new Set([
    0x10, 0x11, 0x12,       // Shift, Control, Menu (side-agnostic)
    0x5B, 0x5C,             // LWin, RWin
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, // L/R Shift, Control, Menu
]);

// Typematic defaults: SPI_GETKEYBOARDDELAY 1 (500ms) then SPI_GETKEYBOARDSPEED ~31/s.
const TYPEMATIC_DELAY_MS  = 500;
const TYPEMATIC_PERIOD_MS = 33;

/**
 * Typematic runs on the GUEST clock, not wall clock. A game measures its own repeat
 * interval with GetTickCount/timeGetTime, and virtual time is what those return: on the
 * host clock a worker stall (long GPU op, a thunk crediting virtual time) makes the
 * repeats it then sees arrive at an interval it never asked for. Manual/deterministic
 * time mode gets reproducible repeats for free.
 */
function typematicNowMs(): number {
    return TimeService.getInstance().nowMs();
}

// Double-click detection thresholds
const DBLCLK_TIME_MS = 500;
const DBLCLK_DIST_PX = 4;

// Default WM_MOUSEHOVER delay (matches Windows default HOVER_DEFAULT)
const HOVER_DEFAULT_MS = 400;

/** Mouse-message coordinates are packed into a signed 16-bit lParam field. */
function clampScreenCoord(v: number): number {
    return Math.max(0, Math.min(32767, v));
}

interface TmeHoverEntry {
    fireAt: number;
    delayMs: number;
    x: number;
    y: number;
}

export class InputManager {
    private inputView: Int32Array | null = null;
    private windowManager: WindowManager;
    public readonly keyStates = new Uint8Array(256);
    private readonly toggleStates = new Uint8Array(KEY_STATE_BYTES);
    private readonly queuedKeyState = new Uint8Array(KEY_STATE_BYTES);
    private readonly packedKeyStateScratch = new Uint8Array(KEY_STATE_BYTES);
    private hasQueuedKeyState = false;
    /** Tracks keys that transitioned 0→pressed since last GetAsyncKeyState query (bit 0). */
    private keyPressedSinceLastQuery = new Uint8Array(256);
    private currentMouseX = 0;
    private currentMouseY = 0;
    private currentButtons = 0;
    /** Last position the host PUBLISHED. The cursor position is a shared cell — the
     *  host writes real motion, the guest writes SetCursorPos — and the SAB record
     *  republishes the position slot on any commit, so only a CHANGED publication
     *  (real motion) takes the position back from the guest. */
    private lastSabMouseX = 0;
    private lastSabMouseY = 0;
    /** Browser-flag mask of buttons whose 0→1 edge poll() has seen but no guest read has.
     *  The SAB record is a LEVEL with no edge queue, and the host can publish a press and
     *  its release inside one guest quantum (the harness injectors do it in a single JS
     *  turn) — so no guest sample ever falls between them and the press is lost, while a
     *  physical press always spans many device samples. This carries the edge to the first
     *  guest read; consumeMouseButtonLatch() drains it, one sample wide, so a level-only
     *  API like DirectInput's immediate mouse state still sees the press exactly once. */
    private mouseButtonLatch = 0;
    private gamepadConnected = false;
    private gamepadButtons = 0;
    private gamepadAxes: [number, number, number, number] = [0, 0, 0, 0];
    private readonly gamepadPresence = new GamepadPresenceTracker();

    // Previous state for change detection
    private lastSeq = 0;
    private lastMouseX = 0;
    private lastMouseY = 0;
    private lastButtons = 0;
    private lastMouseWheel = 0;

    // DirectInput buffered event ring buffers (keyboard, mouse, gamepad)
    private dinputWheelAccum = 0;
    private dinputMouseEvents: DInputBufferedEvent[] = [];
    private dinputMouseBufferSize = 0; // 0 = buffered mode disabled
    private dinputMouseSeq = 0;
    /** Last SAB dinputDX/DY seen when buffering — same accum GetDeviceState uses.
     *  Position-derived Δ dies at canvas edges / under ClipCursor; raw accum does not. */
    private dinputPrevAccumX = 0;
    private dinputPrevAccumY = 0;
    private dinputPrevButtons = 0;
    /** Guest reads of the DirectInput RELATIVE mouse axes (immediate + action-map).
     *  Buffered mode is covered by dinputMouseBufferSize; see relativeMousePosture(). */
    private guestRelativeMouseReads = 0;

    private dinputKeyboardEvents: DInputBufferedEvent[] = [];
    private dinputKeyboardBufferSize = 0;
    private dinputKeyboardSeq = 0;
    private dinputKeyboardPrevVk = new Uint8Array(256);

    private dinputGamepadEvents: DInputBufferedEvent[] = [];
    private dinputGamepadBufferSize = 0;
    private dinputGamepadSeq = 0;
    private dinputGamepadPrevButtons = 0;
    private dinputGamepadPrevAxes: [number, number, number, number] = [0, 0, 0, 0];

    /** Newest-last trail of buffered DI events actually produced. The guest drains the
     *  queues faster than a snapshot can read them, so pending counts alone cannot tell
     *  "we never generated it" from "the guest already took it" — this can. */
    private dinputTrail: DInputTrailEntry[] = [];

    private prevKeyBitfield = new Int32Array(KEY_BITFIELD_COUNT);
    /** Key bitfield copied inside the seqlock-validated region (see poll()). */
    private keyBitfieldSnapshot = new Int32Array(KEY_BITFIELD_COUNT);

    // Typematic auto-repeat schedule (Windows generates repeat in the input stack,
    // not in the device). -1 = idle; only ONE key repeats at a time — the latest press.
    private repeatVk = -1;
    private repeatNextAt = 0;

    // Double-click tracking per button [left, right, middle]
    private lastDownTime = [0, 0, 0];
    private lastDownX    = [0, 0, 0];
    private lastDownY    = [0, 0, 0];

    // TrackMouseEvent state
    private tmeLeaveHwnds = new Set<number>();
    private tmeHoverMap   = new Map<number, TmeHoverEntry>();
    private lastMouseInside = true;

    // Keyboard events buffered while enqueue=false
    private pendingKeyEvents: Array<{ vk: number; pressed: boolean; lParam: number; keyStatePacked: Uint8Array }> = [];

    private pollInterval: number | null = null;
    private pollIntervalMs = 16;
    private pollingEnabled = false;
    private deterministicMode = false;
    /** When set, WM_* are only enqueued when this returns true (e.g. guest is in GetMessage). State (keyStates, mouse) is always updated. */
    private shouldEnqueueMessages: (() => boolean) | null = null;
    private hostInputReset: (() => void) | null = null;

    constructor(windowManager: WindowManager) {
        this.windowManager = windowManager;
    }

    setShouldEnqueueMessagesGetter(getter: () => boolean): void {
        this.shouldEnqueueMessages = getter;
    }

    /** Notifies the host that it must drop everything its producers are holding. */
    setHostInputResetCallback(callback: () => void): void {
        this.hostInputReset = callback;
    }

    /**
     * Set the input buffer from SharedArrayBuffer
     */
    setInputBuffer(buffer: SharedArrayBuffer | null): void {
        this.inputView = buffer ? new Int32Array(buffer) : null;
        // A new buffer carries an unknown initial pad level — seed, never announce.
        this.gamepadPresence.reset();
        if (this.inputView) {
            Logger.log(LogCategory.SYSTEM, 'InputManager: buffer connected');
        }
    }

    /**
     * Start polling for input changes
     */
    startPolling(intervalMs: number = 16): void {
        this.pollIntervalMs = intervalMs;
        this.pollingEnabled = true;
        if (this.pollInterval === null && !this.deterministicMode) {
            this.pollInterval = setInterval(() => this.poll(), intervalMs) as unknown as number;
            Logger.log(LogCategory.SYSTEM, `InputManager: polling started (${intervalMs}ms)`);
        }
    }

    /**
     * Stop polling
     */
    stopPolling(): void {
        this.pollingEnabled = false;
        if (this.pollInterval !== null) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Toggle deterministic driver mode that prohibits timer polling
     */
    setDeterministicMode(enabled: boolean): void {
        this.deterministicMode = enabled;
        if (enabled) {
            if (this.pollInterval !== null) {
                clearInterval(this.pollInterval);
                this.pollInterval = null;
            }
            return;
        }
        if (this.pollingEnabled && this.pollInterval === null) {
            this.pollInterval = setInterval(() => this.poll(), this.pollIntervalMs) as unknown as number;
            Logger.log(LogCategory.SYSTEM, `InputManager: polling resumed (${this.pollIntervalMs}ms)`);
        }
    }

    /**
     * Register TrackMouseEvent tracking for a window.
     * Called by the user32 TrackMouseEvent() HLE implementation.
     */
    trackMouseEvent(hwnd: number, flags: number, hoverTimeMs: number): void {
        if (flags & TME_CANCEL) {
            if (flags & TME_LEAVE) this.tmeLeaveHwnds.delete(hwnd);
            if (flags & TME_HOVER) this.tmeHoverMap.delete(hwnd);
            return;
        }
        if (flags & TME_LEAVE) {
            this.tmeLeaveHwnds.add(hwnd);
        }
        if (flags & TME_HOVER) {
            const delayMs = (hoverTimeMs === 0xFFFFFFFF || hoverTimeMs === 0)
                ? HOVER_DEFAULT_MS
                : hoverTimeMs;
            this.tmeHoverMap.set(hwnd, {
                fireAt: Date.now() + delayMs,
                delayMs,
                x: this.currentMouseX,
                y: this.currentMouseY,
            });
        }
        Logger.verbose(LogCategory.SYSTEM,
            `TrackMouseEvent hwnd=0x${hwnd.toString(16)} flags=0x${flags.toString(16)} hoverMs=${hoverTimeMs}`);
    }

    /**
     * Poll input buffer and generate messages.
     * @param forceEnqueue - when true (e.g. from waitForMessage), enqueue WM_* even if no waiter yet, so pending input is not lost
     */
    poll(forceEnqueue = false): void {
        if (!this.inputView) return;

        // Typematic is time-driven, not seq-driven: a held key produces no new SAB
        // record, so it must run BEFORE the seq gate below (which returns early on
        // every quiet poll).
        this.pumpTypematic(forceEnqueue);

        // SAB input seqlock (reader/acquire side; writers = host App.tsx +
        // the worker injectors below, both bracket payload with begin/end so
        // seq goes even→odd→even per update). An ODD seq means a writer is
        // mid-update: skip and catch it on the next poll (state is level-based,
        // polled frequently — no spin needed). Even+unchanged means nothing new.
        const seq = Atomics.load(this.inputView, INPUT_INDEX.seq);
        if (seq & 1) return;
        if (seq === this.lastSeq) return;

        // Read the whole payload into locals with plain reads, then re-check seq:
        // if it moved, the snapshot was torn/superseded — bail WITHOUT advancing
        // lastSeq (the newer record is picked up next poll) and WITHOUT consuming
        // the destructive wheel delta.
        const mouseX           = this.inputView[INPUT_INDEX.mouseX];
        const mouseY           = this.inputView[INPUT_INDEX.mouseY];
        const buttons          = this.inputView[INPUT_INDEX.buttons];
        const mouseInside      = this.inputView[INPUT_INDEX.mouseInside] !== 0;
        const gamepadConnected = this.inputView[INPUT_INDEX.gamepadConnected] === 1;
        const gamepadButtons   = this.inputView[INPUT_INDEX.gamepadButtons];
        const gamepadAxis0     = this.inputView[INPUT_INDEX.gamepadAxis0];
        const gamepadAxis1     = this.inputView[INPUT_INDEX.gamepadAxis1];
        const gamepadAxis2     = this.inputView[INPUT_INDEX.gamepadAxis2];
        const gamepadAxis3     = this.inputView[INPUT_INDEX.gamepadAxis3];
        // The key bitfield is part of the record and must be copied INSIDE the
        // validated region like every other slot: read after the re-check below and
        // a bracket that sets a modifier (word 0) and a letter (word 2) is observable
        // half-applied, so a chord arrives as two unrelated keystrokes.
        for (let word = 0; word < KEY_BITFIELD_COUNT; word++) {
            this.keyBitfieldSnapshot[word] = this.inputView[KEY_BITFIELD_BASE + word];
        }
        // Whichever half of a modifier the producer knew about, both are down here.
        reconcileModifierSides(this.keyBitfieldSnapshot);

        if (Atomics.load(this.inputView, INPUT_INDEX.seq) !== seq) return;
        this.lastSeq = seq;

        // Commit path only (snapshot validated): consume the wheel DELTA slot
        // destructively now, so a skipped/torn poll never swallows a notch.
        // Resetting it in the WM_MOUSEWHEEL branch below is too late — that code
        // is skipped when there is no keyboard-target window (early return below),
        // and a stale delta would then be re-fed into the DInput accumulator on
        // EVERY seq bump (each mouse move) → endless weapon cycling in DInput games.
        const mouseWheel       = Atomics.exchange(this.inputView, INPUT_INDEX.mouseWheel, 0);

        // Only real motion reclaims the position from a guest SetCursorPos — the record
        // republishes this slot on every commit (see lastSabMouseX).
        if (mouseX !== this.lastSabMouseX || mouseY !== this.lastSabMouseY) {
            this.lastSabMouseX = mouseX;
            this.lastSabMouseY = mouseY;
            const confined = clampToCursorClip(mouseX, mouseY);
            this.currentMouseX = confined.x;
            this.currentMouseY = confined.y;
        }
        this.currentButtons   = buttons;

        // Win32 messages carry the SYSTEM cursor position — confined, and reflecting a
        // guest SetCursorPos — not the raw publication (queue_hardware_message overwrites
        // msg->x/y with the desktop cursor for exactly this reason). DirectInput's
        // relative axes stay on the raw slots: a guest warp must not produce a delta.
        const cursorX = this.currentMouseX;
        const cursorY = this.currentMouseY;

        // DirectInput mouse: accumulate wheel + buffer events.
        // The SAB slot carries browser PIXEL deltaY (~100px per notch, + = scroll down).
        // DIMOFS_Z / lZ are WHEEL_DELTA units (±120 per notch, + = scroll UP) — same
        // conversion as the WM_MOUSEWHEEL branch below. Multiplying by 120 here would
        // hand games 100 notches per physical notch (Max Payne queued 100 weapon switches).
        if (mouseWheel !== 0) {
            this.dinputWheelAccum += Math.round(-mouseWheel * 1.2);
        }
        if (this.dinputMouseBufferSize > 0) {
            this._bufferDInputMouseEvents(buttons, mouseWheel);
        }

        this.gamepadConnected = gamepadConnected;
        this.gamepadButtons   = gamepadButtons;
        this.gamepadAxes      = [gamepadAxis0, gamepadAxis1, gamepadAxis2, gamepadAxis3];
        this.announceGamepadPresence(gamepadConnected);
        if (this.dinputGamepadBufferSize > 0) {
            this._bufferDInputGamepadEvents(gamepadButtons, this.gamepadAxes, gamepadConnected);
        }

        // Update VK_LBUTTON/VK_RBUTTON/VK_MBUTTON in keyStates for GetAsyncKeyState/GetKeyState
        // Many games (HoMM3, etc.) poll mouse button state via these APIs instead of WM messages
        const prevLButton = this.keyStates[0x01];
        const prevRButton = this.keyStates[0x02];
        const prevMButton = this.keyStates[0x04];
        this.keyStates[0x01] = (buttons & 1) ? 0x80 : 0x00; // VK_LBUTTON
        this.keyStates[0x02] = (buttons & 2) ? 0x80 : 0x00; // VK_RBUTTON
        this.keyStates[0x04] = (buttons & 4) ? 0x80 : 0x00; // VK_MBUTTON
        // Track 0→pressed transitions for GetAsyncKeyState bit 0
        if (!prevLButton && this.keyStates[0x01]) this.keyPressedSinceLastQuery[0x01] = 1;
        if (!prevRButton && this.keyStates[0x02]) this.keyPressedSinceLastQuery[0x02] = 1;
        if (!prevMButton && this.keyStates[0x04]) this.keyPressedSinceLastQuery[0x04] = 1;
        // Same edges, browser-flag mask, for readers of the raw button state (DirectInput).
        if (!prevLButton && this.keyStates[0x01]) this.mouseButtonLatch |= 1;
        if (!prevRButton && this.keyStates[0x02]) this.mouseButtonLatch |= 2;
        if (!prevMButton && this.keyStates[0x04]) this.mouseButtonLatch |= 4;

        // Pass 1: Update keyStates[] from bitfield diff (for DInput/GetAsyncKeyState)
        // This runs BEFORE targetWin check so keyStates are always current
        let keyboardChanged = false;
        for (let word = 0; word < KEY_BITFIELD_COUNT; word++) {
            const curr = this.keyBitfieldSnapshot[word];
            const prev = this.prevKeyBitfield[word];
            if (curr !== prev) {
                keyboardChanged = true;
                const changed = curr ^ prev;
                for (let bit = 0; bit < 32; bit++) {
                    if (changed & (1 << bit)) {
                        const vk = word * 32 + bit;
                        const nowPressed = (curr & (1 << bit)) !== 0;
                        // Track 0→pressed for GetAsyncKeyState bit 0
                        if (nowPressed && !this.keyStates[vk]) {
                            this.keyPressedSinceLastQuery[vk] = 1;
                            if (isToggleKey(vk)) {
                                this.toggleStates[vk] ^= 0x01;
                            }
                        }
                        this.keyStates[vk] = nowPressed ? 0x80 : 0x00;
                        // A live hardware transition supersedes any stale SetKeyboardState
                        // snapshot for THIS key. Win32 GetKeyState reflects the most recent
                        // input per key, not a table a game pushed once. Without this, a single
                        // SetKeyboardState() (games often zero the table at init) freezes every
                        // later GetKeyState()/GetKeyboardState() read forever — e.g. XIII (UE2)
                        // polls GetKeyState per frame for WASD movement and stays stuck at
                        // "not pressed", while jump (WM_KEYDOWN edge) still works.
                        if (this.hasQueuedKeyState) {
                            this.queuedKeyState[vk] = (nowPressed ? 0x80 : 0x00) | (this.toggleStates[vk] & 0x01);
                        }
                        // Typematic arms here (before the no-target-window early return)
                        // so a key held from before the window existed still repeats.
                        if (nowPressed) {
                            if (!MODIFIER_VK.has(vk) && !isToggleKey(vk)) {
                                this.repeatVk = vk;
                                this.repeatNextAt = typematicNowMs() + TYPEMATIC_DELAY_MS;
                            }
                        } else if (vk === this.repeatVk) {
                            this.repeatVk = -1;
                        }
                    }
                }
            }
        }

        if (this.dinputKeyboardBufferSize > 0 && keyboardChanged) {
            this._bufferDInputKeyboardEvents();
        }

        const keyStateSnapshot = this.buildPackedKeyState(this.packedKeyStateScratch);

        // Keyboard target = the FOCUS window (Win32 routes keystrokes to GetFocus(),
        // which may be a child), falling back to active. Mouse routing is resolved
        // separately below (capture → WindowFromPoint).
        const targetWin = this.windowManager.getKeyboardTargetWindow();
        if (!targetWin) {
            // Save bitfield state even when no window
            this.prevKeyBitfield.set(this.keyBitfieldSnapshot);
            return;
        }

        const targetHwnd = targetWin.hwnd;

        const mouseTargetWin = this.resolveMouseTarget(cursorX, cursorY) ?? targetWin;
        const mouseTargetHwnd = mouseTargetWin.hwnd;

        // Only enqueue WM_* when someone is waiting (e.g. GetMessage), or when forceEnqueue (e.g. about to wait)
        const enqueue = forceEnqueue || (this.shouldEnqueueMessages?.() ?? true);

        // An exclusive-mode DirectInput acquisition takes the mouse away from the window:
        // the device answers GetDeviceState/GetDeviceData and the window gets no
        // device-derived WM_MOUSE* for the duration. Delivering both hands the guest every
        // click TWICE, and the copy its menu did not consume is read by whatever runs next
        // — in a Q3-lineage title that is the cinematic, which any key event skips.
        // A guest SetCursorPos warp is not device input and still posts its own move.
        const deviceMouseMessages = !isExclusiveMouseAcquired();

        // Flush buffered keyboard events now that we can enqueue
        if (enqueue && this.pendingKeyEvents.length > 0) {
            for (const evt of this.pendingKeyEvents) {
                this.windowManager.postMessage(
                    targetHwnd,
                    evt.pressed ? WM_KEYDOWN : WM_KEYUP,
                    evt.vk,
                    evt.lParam,
                    0,
                    0,
                    0,
                    evt.keyStatePacked
                );
                Logger.verbose(LogCategory.SYSTEM, `Input: [flushed] ${evt.pressed ? 'KeyDown' : 'KeyUp'} vk=${evt.vk}`);
            }
            this.pendingKeyEvents = [];
        }

        // Screen coordinates (for MSG.pt)
        const screenX = cursorX;
        const screenY = cursorY;

        const client = this.clientPointFor(mouseTargetWin, screenX, screenY);
        const clientX = client.x;
        const clientY = client.y;

        // LPARAM for mouse button/move messages (client coords)
        const mouseLParam = ((clientY & 0xFFFF) << 16) | (clientX & 0xFFFF);

        // --- Mouse leave / enter detection ---
        if (mouseInside !== this.lastMouseInside) {
            this.lastMouseInside = mouseInside;
            // The TrackMouseEvent registration is one-shot per DELIVERED leave: a leave the
            // guest never saw must not consume it, or nothing fires after the acquisition ends.
            if (!mouseInside && deviceMouseMessages) {
                // Mouse left canvas — fire WM_MOUSELEAVE for all tracked windows (one-shot)
                for (const hwnd of this.tmeLeaveHwnds) {
                    this.windowManager.postMessage(hwnd, WM_MOUSELEAVE, 0, 0, screenX, screenY, 0, keyStateSnapshot);
                    Logger.verbose(LogCategory.SYSTEM, `Input: WM_MOUSELEAVE hwnd=0x${hwnd.toString(16)}`);
                }
                this.tmeLeaveHwnds.clear();
                this.tmeHoverMap.clear();
            }
        }

        // Mouse buttons (browser uses: 1=left, 2=right, 4=middle)
        const leftDown   = (buttons & 1) !== 0;
        const rightDown  = (buttons & 2) !== 0;
        const middleDown = (buttons & 4) !== 0;

        const wasLeftDown   = (this.lastButtons & 1) !== 0;
        const wasRightDown  = (this.lastButtons & 2) !== 0;
        const wasMiddleDown = (this.lastButtons & 4) !== 0;

        const wParamButtons = this.buttonsToWParam(buttons);

        // Mouse movement - can be coalesced/skipped when busy. Emitted BEFORE the
        // button edges below because Windows always delivers move-then-down: dropping
        // the move when a snapshot carries both loses the position permanently
        // (lastMouseX/Y advance regardless), so a guest that hover-tests from the last
        // move acts on the previously hovered item.
        if (cursorX !== this.lastMouseX || cursorY !== this.lastMouseY) {
            if (enqueue && deviceMouseMessages) {
                this.postCursorMove(mouseTargetWin, screenX, screenY, buttons, keyStateSnapshot);
                Logger.verbose(LogCategory.SYSTEM, `Input: MouseMove (${clientX}, ${clientY})`);
            }
            // Any movement resets the hover timer for all tracked windows
            for (const entry of this.tmeHoverMap.values()) {
                entry.fireAt = Date.now() + entry.delayMs;
                entry.x = cursorX;
                entry.y = cursorY;
            }
            this.lastMouseX = cursorX;
            this.lastMouseY = cursorY;
        }

        // --- WM_MOUSEHOVER timer check (one-shot per TrackMouseEvent call) ---
        if (this.tmeHoverMap.size > 0 && deviceMouseMessages) {
            const now = Date.now();
            for (const [hwnd, entry] of this.tmeHoverMap) {
                if (now >= entry.fireAt && cursorX === entry.x && cursorY === entry.y) {
                    const hoverWParam = this.buttonsToWParam(buttons);
                    this.windowManager.postMessage(hwnd, WM_MOUSEHOVER, hoverWParam, mouseLParam, screenX, screenY, 0, keyStateSnapshot);
                    Logger.verbose(LogCategory.SYSTEM, `Input: WM_MOUSEHOVER hwnd=0x${hwnd.toString(16)}`);
                    this.tmeHoverMap.delete(hwnd); // hover is one-shot; app must re-register
                }
            }
        }

        // Click-activate: pressing a button over a non-active window (live dialog
        // routing) silently makes it active so keyboard follows the click. No
        // WM_ACTIVATE synthesis here — dialog activation messages are delivered by
        // user32 (activation-messages.ts) when the dialog is created/shown.
        const anyButtonWentDown = (leftDown && !wasLeftDown) || (rightDown && !wasRightDown) || (middleDown && !wasMiddleDown);
        if (anyButtonWentDown && deviceMouseMessages) {
            // Activate the target's top-level ancestor rather than attempting
            // SetActiveWindow on a WS_CHILD button (a no-op on Win32).
            const targetTopLevel = this.windowManager.getTopLevelAncestor(mouseTargetHwnd);
            if (targetTopLevel && targetTopLevel !== this.windowManager.getActiveHwnd()) {
                this.windowManager.setActiveWindow(targetTopLevel);
            }
        }

        // Button events are ALWAYS enqueued - they must not be lost!
        // Mouse moves can be skipped/coalesced, but clicks are discrete events.
        if (leftDown !== wasLeftDown && deviceMouseMessages) {
            let msg = leftDown ? WM_LBUTTONDOWN : WM_LBUTTONUP;
            if (leftDown) msg = this.checkDblClick(0, mouseTargetHwnd, clientX, clientY, WM_LBUTTONDOWN, WM_LBUTTONDBLCLK);
            this.windowManager.postMessage(mouseTargetHwnd, msg, wParamButtons, mouseLParam, screenX, screenY, 0, keyStateSnapshot);
        }

        if (rightDown !== wasRightDown && deviceMouseMessages) {
            let msg = rightDown ? WM_RBUTTONDOWN : WM_RBUTTONUP;
            if (rightDown) msg = this.checkDblClick(1, mouseTargetHwnd, clientX, clientY, WM_RBUTTONDOWN, WM_RBUTTONDBLCLK);
            this.windowManager.postMessage(mouseTargetHwnd, msg, wParamButtons, mouseLParam, screenX, screenY, 0, keyStateSnapshot);

            Logger.verbose(LogCategory.SYSTEM, `Input: ${
                rightDown
                    ? (msg === WM_RBUTTONDBLCLK ? 'RButtonDblClk' : 'RButtonDown')
                    : 'RButtonUp'
            } at (${clientX},${clientY})`);
        }

        if (middleDown !== wasMiddleDown && deviceMouseMessages) {
            let msg = middleDown ? WM_MBUTTONDOWN : WM_MBUTTONUP;
            if (middleDown) msg = this.checkDblClick(2, mouseTargetHwnd, clientX, clientY, WM_MBUTTONDOWN, WM_MBUTTONDBLCLK);
            this.windowManager.postMessage(mouseTargetHwnd, msg, wParamButtons, mouseLParam, screenX, screenY, 0, keyStateSnapshot);
            Logger.verbose(LogCategory.SYSTEM, `Input: ${
                middleDown
                    ? (msg === WM_MBUTTONDBLCLK ? 'MButtonDblClk' : 'MButtonDown')
                    : 'MButtonUp'
            } at (${clientX},${clientY})`);
        }

        this.lastButtons = buttons;

        // Mouse wheel - also always enqueued (discrete event)
        // NOTE: WM_MOUSEWHEEL lParam uses SCREEN coordinates, not client coords
        if (mouseWheel !== 0) {
            const lParamWheel = ((clampScreenCoord(screenY) & 0xFFFF) << 16) | (clampScreenCoord(screenX) & 0xFFFF);
            const wheelDelta = Math.round(-mouseWheel * 1.2);
            const wParam = (this.buttonsToWParam(buttons) & 0xFFFF) | ((wheelDelta & 0xFFFF) << 16);
            if (deviceMouseMessages) this.windowManager.postMessage(mouseTargetHwnd, WM_MOUSEWHEEL, wParam, lParamWheel, screenX, screenY, 0, keyStateSnapshot);
            Logger.verbose(LogCategory.SYSTEM, `Input: MouseWheel delta=${wheelDelta} at (${clientX},${clientY})`);
            // Slot already consumed atomically at the top of poll(); a store(0) here
            // would race a scroll that arrived in between and drop it.
            this.lastMouseWheel = 0;
        }

        // Pass 2: Generate WM_KEYDOWN/WM_KEYUP from bitfield diff
        if (keyboardChanged) {
            const newKeyEvents: Array<{ vk: number; pressed: boolean; lParam: number }> = [];
            for (let word = 0; word < KEY_BITFIELD_COUNT; word++) {
                const curr = this.keyBitfieldSnapshot[word];
                const prev = this.prevKeyBitfield[word];
                if (curr === prev) continue;
                const changed = curr ^ prev;
                for (let bit = 0; bit < 32; bit++) {
                    if (!(changed & (1 << bit))) continue;
                    const vk = word * 32 + bit;
                    // Win32 posts VK_SHIFT/CONTROL/MENU in wParam and distinguishes the
                    // side in lParam; the side VK never carries a message of its own, and
                    // reconcileModifierSides guarantees its partner changed with it.
                    if (SIDE_MODIFIER_VK.has(vk)) continue;
                    const pressed = (curr & (1 << bit)) !== 0;
                    const scanVk = this.modifierSideVk(vk, pressed);
                    const scan = vkToScanCode(scanVk);
                    const ext = isExtendedKey(scanVk) ? 0x01000000 : 0;
                    const keyLParam = pressed
                        ? (1 | (scan << 16) | ext)                           // WM_KEYDOWN: bit30=0 (was up), bit31=0 (pressed)
                        : ((1 | (scan << 16) | ext | 0xC0000000) >>> 0);    // WM_KEYUP:   bit30=1 (was down), bit31=1 (released)
                    newKeyEvents.push({ vk, pressed, lParam: keyLParam });
                }
            }
            if (newKeyEvents.length > 0) {
                if (enqueue) {
                    for (const evt of newKeyEvents) {
                        this.windowManager.postMessage(
                            targetHwnd,
                            evt.pressed ? WM_KEYDOWN : WM_KEYUP,
                            evt.vk,
                            evt.lParam,
                            0,
                            0,
                            0,
                            keyStateSnapshot
                        );
                        Logger.verbose(LogCategory.SYSTEM, `Input: ${evt.pressed ? 'KeyDown' : 'KeyUp'} vk=${evt.vk}`);
                    }
                } else {
                    // Buffer for later delivery when game enters GetMessage / enqueue gate opens
                    const snapshotCopy = keyStateSnapshot.slice();
                    for (const evt of newKeyEvents) {
                        this.pendingKeyEvents.push({ ...evt, keyStatePacked: snapshotCopy });
                    }
                }
            }
        }

        // Update prevKeyBitfield
        this.prevKeyBitfield.set(this.keyBitfieldSnapshot);

    }

    /** The VK whose scan code a modifier message reports: whichever side is down in the
     *  record the edge came from — the previous one, for a release. */
    private modifierSideVk(vk: number, pressed: boolean): number {
        for (const [both, left, right] of MODIFIER_SIDES) {
            if (vk !== both) continue;
            const bits = pressed ? this.keyBitfieldSnapshot : this.prevKeyBitfield;
            return isVkSet(bits, right) && !isVkSet(bits, left) ? right : left;
        }
        return vk;
    }

    /**
     * Faithful Win32 mouse routing for a screen point:
     * 1. A window with mouse capture receives every mouse message regardless of the
     *    cursor position (UE1/UT menus SetCapture during drag).
     * 2. Otherwise the window under the cursor (Z-order WindowFromPoint, with the
     *    dialog-overlay router as a fallback, inside getMouseTargetWindow).
     * 3. Last resort: the keyboard/active target (e.g. before any window is shown).
     */
    private resolveMouseTarget(screenX: number, screenY: number): WindowObject | undefined {
        const captureHwnd = this.windowManager.getCaptureHwnd();
        if (captureHwnd) {
            const capWin = this.windowManager.getWindow(captureHwnd);
            if (capWin?.visible) return capWin;
        }
        return this.windowManager.getMouseTargetWindow(screenX, screenY)
            ?? this.windowManager.getKeyboardTargetWindow();
    }

    /**
     * Win32: mouse message lParam uses client coords relative to the target hwnd.
     * HLE coordinate model: client origin == window rect origin. We never render
     * window decorations (no caption/border pixels exist on the canvas), and
     * ScreenToClient/ClientToScreen/GetCursorPos all treat client==rect too.
     * Subtracting clientOffset here put lParam in a DIFFERENT coordinate system
     * than GetCursorPos — UE1 (HP) reads both and oscillates (mouse tug-of-war,
     * cursor ~27px off → menu hover/clicks dead). clientOffset stays valid for
     * SIZE math only (GetClientRect/AdjustWindowRect).
     * Prefer user32 absolute position (parent chain) over WindowManager.rect so
     * child dialogs and MoveWindow'd launchers match ScreenToClient/GetCursorPos.
     */
    private clientPointFor(win: WindowObject, screenX: number, screenY: number): { x: number; y: number } {
        const info = getWindowByHandle(win.hwnd);
        const abs = info ? getAbsoluteWindowPosition(info) : { x: win.rect.x, y: win.rect.y };
        return { x: clampScreenCoord(screenX - abs.x), y: clampScreenCoord(screenY - abs.y) };
    }

    /**
     * Windows sends WM_SETCURSOR (hit-test HTCLIENT, trigger message in the high word)
     * ahead of client-area mouse messages — apps re-assert their cursor there (SDL2
     * applies SDL_ShowCursor state ONLY in this handler, so without it a hidden/blank
     * cursor request is never observed).
     */
    private postCursorMove(
        target: WindowObject, screenX: number, screenY: number, buttons: number, keyState: Uint8Array,
        withSetCursor = true,
    ): void {
        const client = this.clientPointFor(target, screenX, screenY);
        const lParam = ((client.y & 0xFFFF) << 16) | (client.x & 0xFFFF);
        if (withSetCursor) {
            this.windowManager.postMessage(target.hwnd, WM_SETCURSOR, target.hwnd,
                (HTCLIENT | (WM_MOUSEMOVE << 16)) >>> 0, screenX, screenY, 0, keyState);
        }
        this.windowManager.postMessage(target.hwnd, WM_MOUSEMOVE, this.buttonsToWParam(buttons),
            lParam, screenX, screenY, 0, keyState);
    }

    /**
     * SetCursorPos semantics: confine the target to the clip rect, take the position
     * away from the host publication, and generate the mouse event the SYSTEM generates.
     *
     * The move is UNCONDITIONAL — NT5 zzzInternalSetCursorPos is BoundCursor +
     * GreMovePointer + zzzSetFMouseMoved with no comparison against the old position,
     * and the queue read path (xxxGetNextSysMsg → PostMove) then posts a real
     * WM_MOUSEMOVE at the current cursor, so a same-position warp still produces one.
     * Whether the pointer MOVED is a different question, and that is what the return
     * value answers: false = displaced nothing (the caller must not re-publish the
     * position to the host, nor read it as evidence of anything).
     *
     * It carries NO WM_SETCURSOR: SetCursorPos only raises the moved flag, and the
     * system derives WM_SETCURSOR later when a mouse message is dispatched. Posting one
     * here feeds any app that warps from its own WM_SETCURSOR handler — every warp would
     * queue the discrete message that provokes the next one, and the pump never drains
     * (WM_MOUSEMOVE coalesces per window, WM_SETCURSOR does not).
     */
    moveCursorTo(x: number, y: number): boolean {
        const confined = clampToCursorClip(x | 0, y | 0);
        const displaced = confined.x !== this.currentMouseX || confined.y !== this.currentMouseY;
        this.currentMouseX = confined.x;
        this.currentMouseY = confined.y;
        this.lastMouseX = confined.x;
        this.lastMouseY = confined.y;
        if (this.shouldEnqueueMessages?.() ?? true) {
            const target = this.resolveMouseTarget(confined.x, confined.y);
            if (target) {
                this.postCursorMove(target, confined.x, confined.y, this.currentButtons,
                    this.buildPackedKeyState(this.packedKeyStateScratch), false);
            }
        }
        return displaced;
    }

    /**
     * Typematic auto-repeat: re-post WM_KEYDOWN for the held key with lParam bit 30
     * (previous key state = down) and NO intervening WM_KEYUP, which is how Win32
     * name-entry / list UIs see a held key.
     *
     * The SAB level bit is deliberately never touched: GetAsyncKeyState/GetKeyState
     * read it straight out of the bitfield (readKeyLevelFromSab), so a host-side
     * bit toggle would be observable to the guest as "not pressed".
     */
    private pumpTypematic(forceEnqueue: boolean): void {
        if (this.repeatVk < 0) return;
        // The level is the authority: a release the diff hasn't reached yet still
        // stops the repeat this instant.
        if (!this.readKeyLevelFromSab(this.repeatVk)) {
            this.repeatVk = -1;
            return;
        }
        const now = typematicNowMs();
        // Virtual time can step backwards (manual/deterministic mode), which would strand
        // the schedule in the future for as long as the key stays down. Re-arm instead.
        if (this.repeatNextAt - now > TYPEMATIC_DELAY_MS) this.repeatNextAt = now + TYPEMATIC_DELAY_MS;
        if (now < this.repeatNextAt) return;
        const targetWin = this.windowManager.getKeyboardTargetWindow();
        if (!targetWin) return;
        if (!(forceEnqueue || (this.shouldEnqueueMessages?.() ?? true))) return;

        // Repeats that could not be delivered on time coalesce into the repeat count,
        // matching how Windows folds a backed-up queue into one WM_KEYDOWN.
        const repeatCount = Math.min(1 + Math.floor((now - this.repeatNextAt) / TYPEMATIC_PERIOD_MS), 0xFFFF);
        this.repeatNextAt = now + TYPEMATIC_PERIOD_MS;

        const vk = this.repeatVk;
        const scan = vkToScanCode(vk);
        const ext = isExtendedKey(vk) ? 0x01000000 : 0;
        const lParam = ((repeatCount & 0xFFFF) | (scan << 16) | ext | 0x40000000) >>> 0;
        this.windowManager.postMessage(
            targetWin.hwnd, WM_KEYDOWN, vk, lParam, 0, 0, 0,
            this.buildPackedKeyState(this.packedKeyStateScratch),
        );
        Logger.verbose(LogCategory.SYSTEM, `Input: KeyDown vk=${vk} (repeat x${repeatCount})`);
    }

    /**
     * Check if a button press qualifies as a double-click.
     * Returns dblClkMsg if within time/distance threshold; otherwise downMsg (and records timestamp).
     */
    private checkDblClick(
        btn: 0 | 1 | 2,
        hwnd: number,
        x: number,
        y: number,
        downMsg: number,
        dblClkMsg: number,
    ): number {
        // USER only ever synthesises a double-click for a window whose CLASS asked for
        // it: without CS_DBLCLKS the second press is another plain WM_*BUTTONDOWN. A
        // class that skips SetCapture on DBLCLK is therefore telling us it never
        // registered for the message in the first place.
        const wndClass = this.windowManager.getWindow(hwnd)?.wndClass;
        if (!wndClass || (wndClass.style & CS_DBLCLKS) === 0) {
            this.lastDownTime[btn] = 0;
            return downMsg;
        }

        const now = performance.now();
        const withinTime = this.lastDownTime[btn] !== 0
            && now - this.lastDownTime[btn] <= DBLCLK_TIME_MS;
        const withinRect = Math.abs(x - this.lastDownX[btn]) <= DBLCLK_DIST_PX
            && Math.abs(y - this.lastDownY[btn]) <= DBLCLK_DIST_PX;

        this.lastDownX[btn] = x;
        this.lastDownY[btn] = y;
        if (withinTime && withinRect) {
            // The pair is consumed: a third press starts a new one rather than
            // producing a second DBLCLK.
            this.lastDownTime[btn] = 0;
            return dblClkMsg;
        }
        this.lastDownTime[btn] = now;
        return downMsg;
    }

    /**
     * Convert browser button flags to Windows MK_* flags
     */
    private buttonsToWParam(buttons: number): number {
        let wParam = 0;
        if (buttons & 1) wParam |= MK_LBUTTON;  // Left
        if (buttons & 2) wParam |= MK_RBUTTON;  // Right
        if (buttons & 4) wParam |= MK_MBUTTON;  // Middle
        return wParam;
    }

    private buildPackedKeyState(target: Uint8Array): Uint8Array {
        for (let i = 0; i < KEY_STATE_BYTES; i++) {
            target[i] = (this.keyStates[i] & 0x80) | (this.toggleStates[i] & 0x01);
        }
        return target;
    }

    applyQueuedKeyState(packedKeyState?: Uint8Array): void {
        if (!packedKeyState || packedKeyState.length < KEY_STATE_BYTES) {
            return;
        }
        this.queuedKeyState.set(packedKeyState.subarray(0, KEY_STATE_BYTES));
        this.hasQueuedKeyState = true;
    }

    getKeyState(vk: number): number {
        const index = vk & 0xFF;
        if (this.hasQueuedKeyState) {
            const packed = this.queuedKeyState[index];
            return ((packed & 0x80) ? 0x8000 : 0) | (packed & 0x01);
        }
        const asyncPressed = this.readKeyLevelFromSab(index);
        return (asyncPressed ? 0x8000 : 0) | (this.toggleStates[index] & 0x01);
    }

    /**
     * Read a key's CURRENT pressed level straight from the SAB bitfield, with NO
     * state mutation. Lets the polled-state readers (GetAsyncKeyState/GetKeyState)
     * return a fresh-at-call level even if poll() hasn't run since the last DOM
     * event — removing up to one poll interval (~8ms) of staleness, and staying
     * fresh even when a busy worker delays the input_tick nudge. Mouse buttons come
     * from the buttons slot (matching poll()'s VK_LBUTTON/RBUTTON/MBUTTON mapping).
     * Edge bits (pressed-since, toggle) stay poll()-owned — do NOT touch them here,
     * or poll()'s diff bookkeeping breaks.
     */
    readKeyLevelFromSab(vk: number): boolean {
        const v = this.inputView;
        const k = vk & 0xFF;
        if (!v) return (this.keyStates[k] & 0x80) !== 0;
        if (k === 0x01) return (v[INPUT_INDEX.buttons] & 1) !== 0; // VK_LBUTTON
        if (k === 0x02) return (v[INPUT_INDEX.buttons] & 2) !== 0; // VK_RBUTTON
        if (k === 0x04) return (v[INPUT_INDEX.buttons] & 4) !== 0; // VK_MBUTTON
        const word = k >> 5;
        if (word >= KEY_BITFIELD_COUNT) return false;
        // This reads the raw record, so it owes the same modifier coherence poll()
        // applies to its snapshot (see reconcileModifierSides).
        if ((k >= 0x10 && k <= 0x12) || (k >= 0xA0 && k <= 0xA5)) {
            const agnostic = v[KEY_BITFIELD_BASE];     // VK 0x00-0x1F
            const sides    = v[KEY_BITFIELD_BASE + 5]; // VK 0xA0-0xBF
            for (const [both, left, right] of MODIFIER_SIDES) {
                const b = (agnostic & (1 << both)) !== 0;
                const l = (sides & (1 << (left & 31))) !== 0;
                const r = (sides & (1 << (right & 31))) !== 0;
                if (k === both) return b || l || r;
                if (k === left) return l || (b && !r);
                if (k === right) return r;
            }
        }
        return (v[KEY_BITFIELD_BASE + word] & (1 << (k & 31))) !== 0;
    }

    /**
     * Reset input manager state - clear all last state values
     */
    reset(): void {
        this.lastSeq = 0;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.lastButtons = 0;
        this.lastMouseWheel = 0;
        this.currentMouseX = 0;
        this.currentMouseY = 0;
        this.lastSabMouseX = 0;
        this.lastSabMouseY = 0;
        this.currentButtons = 0;
        this.dinputWheelAccum = 0;
        this.dinputMouseEvents.length = 0;
        this.dinputMouseSeq = 0;
        this.dinputPrevAccumX = 0;
        this.dinputPrevAccumY = 0;
        this.dinputPrevButtons = 0;
        this.dinputKeyboardEvents.length = 0;
        this.dinputKeyboardBufferSize = 0;
        this.dinputKeyboardSeq = 0;
        this.dinputKeyboardPrevVk.fill(0);
        this.dinputGamepadEvents.length = 0;
        this.dinputGamepadBufferSize = 0;
        this.dinputGamepadSeq = 0;
        this.dinputGamepadPrevButtons = 0;
        this.dinputGamepadPrevAxes = [0, 0, 0, 0];
        this.gamepadConnected = false;
        this.gamepadButtons = 0;
        this.gamepadAxes = [0, 0, 0, 0];
        this.gamepadPresence.reset();
        this.keyStates.fill(0);
        this.toggleStates.fill(0);
        this.queuedKeyState.fill(0);
        this.packedKeyStateScratch.fill(0);
        this.hasQueuedKeyState = false;
        this.keyPressedSinceLastQuery.fill(0);
        this.mouseButtonLatch = 0;
        this.prevKeyBitfield.fill(0);
        this.repeatVk = -1;
        this.repeatNextAt = 0;
        this.lastDownTime = [0, 0, 0];
        this.lastDownX    = [0, 0, 0];
        this.lastDownY    = [0, 0, 0];
        this.tmeLeaveHwnds.clear();
        this.tmeHoverMap.clear();
        this.pendingKeyEvents = [];
        this.lastMouseInside = true;
        // Zero only the slots this side owns. The host-owned payload must be cleared
        // by the host: it holds the seqlock, and prevKeyBitfield is now all zeros, so
        // any key still down in the SAB would be re-diffed as a fresh WM_KEYDOWN in
        // the next game.
        if (this.inputView) {
            Atomics.store(this.inputView, INPUT_INDEX.guestGamepadSeq, 0);
            Atomics.store(this.inputView, INPUT_INDEX.guestInputSeq, 0);
            Atomics.store(this.inputView, INPUT_INDEX.guestInputFlags, 0);
            for (let w = 0; w < GUEST_POLLED_KEYS_COUNT; w++) {
                Atomics.store(this.inputView, GUEST_POLLED_KEYS_BASE + w, 0);
            }
        }
        this.hostInputReset?.();
        // Note: Don't stop polling here, it should continue running
        Logger.log(LogCategory.SYSTEM, 'InputManager reset');
    }

    /**
     * Returns and clears the "pressed since last query" flag for a virtual key.
     * Used by GetAsyncKeyState to return bit 0.
     */
    consumeKeyPressedSince(vk: number): boolean {
        const was = this.keyPressedSinceLastQuery[vk];
        this.keyPressedSinceLastQuery[vk] = 0;
        return was !== 0;
    }

    /**
     * Drain the pressed-since-last-guest-read button mask (browser flags) and return the
     * button level the guest must observe: the live level OR the latched edges. Callers are
     * the guest-facing button readers; each call consumes the latch, so a press the host
     * published and released between two guest reads shows up as down exactly once — the
     * narrowest press a level API can express, and what a real one-sample press looks like.
     */
    consumeMouseButtonLatch(): number {
        const latched = this.mouseButtonLatch;
        this.mouseButtonLatch = 0;
        return this.currentButtons | latched;
    }

    private _noteDInputTrail(dev: DInputTrailEntry["dev"], ofs: number, data: number, seq: number): void {
        if (this.dinputTrail.length >= DINPUT_TRAIL_MAX) this.dinputTrail.shift();
        this.dinputTrail.push({ dev, ofs, data, seq });
    }

    /**
     * Buffered-DirectInput diagnostics: what each device's queue is configured for,
     * what is still pending, and the trail of events we actually produced. Read-only.
     */
    getDInputDiagnostics(): unknown {
        return {
            mouse: {
                bufferSize: this.dinputMouseBufferSize,
                pending: this.dinputMouseEvents.length,
                produced: this.dinputMouseSeq,
                prevAccumX: this.dinputPrevAccumX,
                prevAccumY: this.dinputPrevAccumY,
                prevButtons: this.dinputPrevButtons,
                wheelAccum: this.dinputWheelAccum,
            },
            keyboard: {
                bufferSize: this.dinputKeyboardBufferSize,
                pending: this.dinputKeyboardEvents.length,
                produced: this.dinputKeyboardSeq,
            },
            gamepad: {
                bufferSize: this.dinputGamepadBufferSize,
                pending: this.dinputGamepadEvents.length,
                produced: this.dinputGamepadSeq,
            },
            cursor: { x: this.currentMouseX, y: this.currentMouseY, buttons: this.currentButtons },
            relativeMouse: this.relativeMousePosture(),
            immediateMouse: {
                reads: this.guestRelativeMouseReads,
                deltaDelivered: this.guestRelativeMouseDelta,
                lastDelta: { ...this.guestRelativeMouseLast },
            },
            trail: this.dinputTrail.slice(),
        };
    }

    /**
     * Listeners fired once per poll that produced buffered device data (mouse, keyboard
     * or gamepad). DirectInput's SetEventNotification promises the app an event it can
     * WAIT on — an app whose input thread blocks until it is signalled never polls, so
     * nothing else can drive it. The listener is not told WHICH device kind produced the
     * data: the event is edge-triggered and the waiter re-reads its own buffer, so waking
     * on another device's data costs one spurious pass, never a missed wakeup.
     */
    private dinputDataListeners = new Set<() => void>();

    addDInputDataListener(listener: () => void): void { this.dinputDataListeners.add(listener); }
    removeDInputDataListener(listener: () => void): void { this.dinputDataListeners.delete(listener); }

    /** Buffer mouse events for DirectInput GetDeviceData. Called from poll(). */
    private _bufferDInputMouseEvents(buttons: number, mouseWheel: number): void {
        const ts = performance.now() | 0;
        const maxBuf = this.dinputMouseBufferSize;
        const events = this.dinputMouseEvents;
        let produced = false;

        const pushEvent = (dwOfs: number, dwData: number): void => {
            if (events.length >= maxBuf) events.shift(); // overflow: drop oldest
            const seq = ++this.dinputMouseSeq;
            events.push({ dwOfs, dwData, dwTimeStamp: ts, dwSequence: seq });
            this._noteDInputTrail("mouse", dwOfs, dwData, seq);
            produced = true;
        };

        // Same SAB accum as GetDeviceState — not clamped canvas position. Absolute
        // mouseX-prev saturates at the edge and kills mouse-look under relative intent
        // before Pointer Lock engages (and still wrong for buffered exclusive DI).
        const accum = this.getDInputAccum();
        const dx = (accum.x - this.dinputPrevAccumX) | 0;
        const dy = (accum.y - this.dinputPrevAccumY) | 0;
        if (dx !== 0) pushEvent(0, dx);  // DIMOFS_X
        if (dy !== 0) pushEvent(4, dy);  // DIMOFS_Y
        this.dinputPrevAccumX = accum.x;
        this.dinputPrevAccumY = accum.y;

        // Wheel — WHEEL_DELTA units, sign flipped (browser + = down, DirectInput + = up);
        // must stay in lockstep with the poll() accumulator and WM_MOUSEWHEEL conversions.
        if (mouseWheel !== 0) {
            pushEvent(8, Math.round(-mouseWheel * 1.2)); // DIMOFS_Z
        }

        // Button changes (browser bitmask: 1=L, 2=R, 4=M, 8=X1, 16=X2)
        const changed = buttons ^ this.dinputPrevButtons;
        // Map browser button bits to DIMOFS_BUTTON offsets
        // bit0(L)→12, bit1(R)→13, bit2(M)→14, bit3(X1)→15, bit4(X2)→16
        const buttonMap = [
            [1, 12], [2, 13], [4, 14], [8, 15], [16, 16]
        ] as const;
        for (const [mask, ofs] of buttonMap) {
            if (changed & mask) {
                pushEvent(ofs, (buttons & mask) ? 0x80 : 0x00);
            }
        }

        this.dinputPrevButtons = buttons;
        if (produced) this._notifyDInputData();
    }

    private _notifyDInputData(): void {
        for (const listener of this.dinputDataListeners) listener();
    }

    /** Buffer keyboard DIK press/release edges for DirectInput GetDeviceData. */
    private _bufferDInputKeyboardEvents(): void {
        const ts = performance.now() | 0;
        const maxBuf = this.dinputKeyboardBufferSize;
        const events = this.dinputKeyboardEvents;
        let produced = false;

        const pushEvent = (dwOfs: number, dwData: number): void => {
            if (events.length >= maxBuf) events.shift();
            const seq = ++this.dinputKeyboardSeq;
            events.push({ dwOfs, dwData, dwTimeStamp: ts, dwSequence: seq });
            this._noteDInputTrail("keyboard", dwOfs, dwData, seq);
            produced = true;
        };

        for (let vk = 0; vk < 256; vk++) {
            const now = this.keyStates[vk];
            const prev = this.dinputKeyboardPrevVk[vk];
            if (now === prev) continue;
            this.dinputKeyboardPrevVk[vk] = now;
            const dik = vkToDik(vk);
            if (dik === null) continue;
            pushEvent(dik, now);
        }
        if (produced) this._notifyDInputData();
    }

    /** Buffer gamepad axis/button changes for DirectInput GetDeviceData. */
    private _bufferDInputGamepadEvents(
        buttons: number, axes: [number, number, number, number], connected: boolean
    ): void {
        const ts = performance.now() | 0;
        const maxBuf = this.dinputGamepadBufferSize;
        const events = this.dinputGamepadEvents;
        const buttonsMask = connected ? buttons : 0;
        let produced = false;

        const pushEvent = (dwOfs: number, dwData: number): void => {
            if (events.length >= maxBuf) events.shift();
            const seq = ++this.dinputGamepadSeq;
            events.push({ dwOfs, dwData, dwTimeStamp: ts, dwSequence: seq });
            this._noteDInputTrail("gamepad", dwOfs, dwData, seq);
            produced = true;
        };

        const axisOfs = [DIJOFS_X, DIJOFS_Y, DIJOFS_RX, DIJOFS_RY] as const;
        for (let i = 0; i < 4; i++) {
            const val = axes[i];
            if (val !== this.dinputGamepadPrevAxes[i]) {
                pushEvent(axisOfs[i], val | 0);
            }
        }

        const changed = buttonsMask ^ this.dinputGamepadPrevButtons;
        for (let i = 0; i < 32; i++) {
            const mask = 1 << i;
            if (changed & mask) {
                pushEvent(DIJOFS_BUTTON0 + i, (buttonsMask & mask) ? 0x80 : 0x00);
            }
        }

        this.dinputGamepadPrevButtons = buttonsMask;
        this.dinputGamepadPrevAxes = [axes[0], axes[1], axes[2], axes[3]];
        if (produced) this._notifyDInputData();
    }

    getKeyboardStateVk(target?: Uint8Array): Uint8Array {
        if (target && target.length >= this.keyStates.length) {
            target.set(this.keyStates);
            return target;
        }
        return this.keyStates.slice();
    }

    getMouseState(): { x: number; y: number; buttons: number } {
        return {
            x: this.currentMouseX,
            y: this.currentMouseY,
            buttons: this.currentButtons
        };
    }

    /** Consume accumulated wheel delta for DirectInput GetDeviceState. Resets accumulator. */
    consumeDInputWheel(): number {
        const val = this.dinputWheelAccum;
        this.dinputWheelAccum = 0;
        return val;
    }

    /** Read the running signed accumulator for DInput relative movement.
     *  App.tsx adds movementX/Y * scale to slots 14/15 on every pointer event
     *  (both pointer-lock and absolute modes).  The worker reads these directly —
     *  no drain, so no race with poll().  GetDeviceState computes delta as
     *  (current - lastSeen) | 0, which handles Int32 wrap-around correctly. */
    getDInputAccum(): { x: number; y: number } {
        if (!this.inputView) return { x: 0, y: 0 };
        return {
            x: this.inputView[INPUT_INDEX.dinputDX],
            y: this.inputView[INPUT_INDEX.dinputDY],
        };
    }

    /** A guest read of the relative axes (dinput GetDeviceState / action-map poll).
     *  Stamped by the GUEST paths only — our own buffering calls getDInputAccum too. */
    /** Total |dx|+|dy| actually HANDED to the guest through the immediate DI mouse state,
     *  and the last non-zero pair. A snapshot of the guest's own DIMOUSESTATE cannot answer
     *  "did the delta arrive": the guest polls at frame rate and takes the motion on the
     *  first read, so every later look sees the zeros that follow. This counts the handoff
     *  itself, which is not a race. */
    private guestRelativeMouseDelta = 0;
    private guestRelativeMouseLast: { dx: number; dy: number } = { dx: 0, dy: 0 };

    noteGuestRelativeMouseRead(dx = 0, dy = 0): void {
        this.guestRelativeMouseReads++;
        const moved = Math.abs(dx) + Math.abs(dy);
        if (moved > 0) {
            this.guestRelativeMouseDelta += moved;
            this.guestRelativeMouseLast = { dx, dy };
        }
    }

    /**
     * Is this title steering by MOTION rather than position? Observed, not declared:
     * a buffered DI mouse queue, or guest reads of the relative axes. Such a guest
     * hit-tests against a cursor IT owns, whose position no absolute screen coordinate
     * we publish can describe — so an absolute click aims at nothing in particular.
     * The harness pointer verbs report this so that failure mode cannot pass silently.
     */
    relativeMousePosture(): { relative: boolean; bufferSize: number; produced: number; stateReads: number } {
        return {
            relative: this.dinputMouseBufferSize > 0 || this.guestRelativeMouseReads > 0,
            bufferSize: this.dinputMouseBufferSize,
            produced: this.dinputMouseSeq,
            stateReads: this.guestRelativeMouseReads,
        };
    }

    /** Set DirectInput mouse buffer size (DIPROP_BUFFERSIZE). 0 = unbuffered. */
    setDInputMouseBufferSize(size: number): void {
        this.dinputMouseBufferSize = size;
        this.dinputMouseEvents.length = 0;
        this.baselineDInputMouse();
    }

    /** Snapshot the current accum so Acquire/SetProperty does not replay motion
     *  that happened before the buffer was armed as the first DIMOFS_X/Y delta. */
    baselineDInputMouse(): void {
        const accum = this.getDInputAccum();
        this.dinputPrevAccumX = accum.x;
        this.dinputPrevAccumY = accum.y;
        this.dinputPrevButtons = this.currentButtons;
    }

    /** Get DirectInput mouse buffer size. */
    getDInputMouseBufferSize(): number {
        return this.dinputMouseBufferSize;
    }

    /** Drain up to maxItems buffered mouse events for GetDeviceData. Returns consumed events. */
    drainDInputMouseEvents(maxItems: number): DInputBufferedEvent[] {
        if (maxItems <= 0 || this.dinputMouseEvents.length === 0) return [];
        const count = Math.min(maxItems, this.dinputMouseEvents.length);
        return this.dinputMouseEvents.splice(0, count);
    }

    /** Number of pending buffered mouse events. */
    getDInputMouseEventCount(): number {
        return this.dinputMouseEvents.length;
    }

    /** Set DirectInput keyboard buffer size (DIPROP_BUFFERSIZE). 0 = unbuffered. */
    setDInputKeyboardBufferSize(size: number): void {
        this.dinputKeyboardBufferSize = size;
        this.dinputKeyboardEvents.length = 0;
        this.baselineDInputKeyboard();
    }

    getDInputKeyboardBufferSize(): number {
        return this.dinputKeyboardBufferSize;
    }

    /** Snapshot current key state so Acquire/SetProperty does not replay held keys. */
    baselineDInputKeyboard(): void {
        this.dinputKeyboardPrevVk.set(this.keyStates);
    }

    drainDInputKeyboardEvents(maxItems: number): DInputBufferedEvent[] {
        if (maxItems <= 0 || this.dinputKeyboardEvents.length === 0) return [];
        const count = Math.min(maxItems, this.dinputKeyboardEvents.length);
        return this.dinputKeyboardEvents.splice(0, count);
    }

    getDInputKeyboardEventCount(): number {
        return this.dinputKeyboardEvents.length;
    }

    /** Set DirectInput gamepad/joystick buffer size (DIPROP_BUFFERSIZE). 0 = unbuffered. */
    setDInputGamepadBufferSize(size: number): void {
        this.dinputGamepadBufferSize = size;
        this.dinputGamepadEvents.length = 0;
        this.baselineDInputGamepad();
    }

    getDInputGamepadBufferSize(): number {
        return this.dinputGamepadBufferSize;
    }

    /** Snapshot current gamepad state so Acquire/SetProperty does not replay held inputs. */
    baselineDInputGamepad(): void {
        this.dinputGamepadPrevButtons = this.gamepadConnected ? this.gamepadButtons : 0;
        this.dinputGamepadPrevAxes = [this.gamepadAxes[0], this.gamepadAxes[1], this.gamepadAxes[2], this.gamepadAxes[3]];
    }

    drainDInputGamepadEvents(maxItems: number): DInputBufferedEvent[] {
        if (maxItems <= 0 || this.dinputGamepadEvents.length === 0) return [];
        const count = Math.min(maxItems, this.dinputGamepadEvents.length);
        return this.dinputGamepadEvents.splice(0, count);
    }

    getDInputGamepadEventCount(): number {
        return this.dinputGamepadEvents.length;
    }

    /** Place the pointer without generating a move — for synthetic-input paths that
     *  post their own messages (mouse_event). Confinement applies wherever the
     *  pointer is placed, so the clip rect still binds. */
    setMousePosition(x: number, y: number): void {
        const confined = clampToCursorClip(x | 0, y | 0);
        this.currentMouseX = confined.x;
        this.currentMouseY = confined.y;
    }

    /**
     * Instrumentation: synthesize a left-click at screen (canvas) coordinates by writing the
     * shared input buffer and running the normal poll() routing — byte-for-byte the same path
     * a real mouse click takes (capture → WindowFromPoint → WM_MOUSEMOVE/LBUTTONDOWN/LBUTTONUP).
     * Works for JS system controls AND guest-painted launcher hit-zones delivered to the guest
     * wndProc. Used by dbg.dlgClick() to drive dialogs directly instead of guessing canvas
     * pixels. Returns false if no input buffer is connected. Clobbers the live cursor position.
     */
    injectClickAtScreen(screenX: number, screenY: number): boolean {
        const view = this.inputView;
        if (!view) return false;
        const x = screenX | 0;
        const y = screenY | 0;
        const step = (buttons: number): void => {
            this.accumulateInjectedPointerDelta(view, x, y);
            beginInputWrite(view);
            view[INPUT_INDEX.mouseX] = x;
            view[INPUT_INDEX.mouseY] = y;
            view[INPUT_INDEX.mouseInside] = 1;
            view[INPUT_INDEX.buttons] = buttons;
            endInputWrite(view);
            this.poll(true);
        };
        step(0); // move onto the control
        step(1); // left button down
        step(0); // left button up → WM_LBUTTONUP → WM_COMMAND(BN_CLICKED)
        return true;
    }

    /**
     * Harness input injection. Each helper follows the SAME faithful
     * path as injectClickAtScreen: write the SAB slots, bump seq atomically, then
     * poll(true) so routing goes capture→WindowFromPoint→WM_* exactly like a real
     * event. poll() is seq-gated, so every injected event MUST bump seq.
     */
    /**
     * Feed the DirectInput raw-delta accumulators for an injected pointer position.
     * A real pointermove carries movementX/Y and App.tsx adds it here; an injected
     * one only knows where it landed, so the delta is measured against the position
     * the SAB still holds — call BEFORE overwriting mouseX/mouseY. Without this a
     * relative-mode DirectInput guest (GetDeviceState lX/lY) never sees the motion,
     * even though the absolute slots and every WM_MOUSEMOVE look perfect.
     */
    private accumulateInjectedPointerDelta(view: Int32Array, x: number, y: number): void {
        const dx = x - view[INPUT_INDEX.mouseX];
        const dy = y - view[INPUT_INDEX.mouseY];
        if (dx) Atomics.add(view, INPUT_INDEX.dinputDX, dx);
        if (dy) Atomics.add(view, INPUT_INDEX.dinputDY, dy);
    }

    private mouseMaskFor(button: number): number {
        // poll() decodes the `buttons` SAB slot as BROWSER flags (left=1, right=2,
        // middle=4) — NOT Win32 MK_* masks (MK_MBUTTON=0x10 would set bit4, which
        // poll's `buttons & 4` test never sees → dead middle button). Match poll().
        return button === 1 ? 2 : button === 2 ? 4 : 1;
    }

    /** Move the cursor to (screenX,screenY) keeping the current button state. */
    injectMoveAtScreen(screenX: number, screenY: number): boolean {
        const view = this.inputView;
        if (!view) return false;
        this.accumulateInjectedPointerDelta(view, screenX | 0, screenY | 0);
        beginInputWrite(view);
        view[INPUT_INDEX.mouseX] = screenX | 0;
        view[INPUT_INDEX.mouseY] = screenY | 0;
        view[INPUT_INDEX.mouseInside] = 1;
        endInputWrite(view);
        this.poll(true);
        return true;
    }

    /**
     * Feed RELATIVE pointer motion, leaving the absolute pointer where it is — the
     * worker-side twin of the host's Pointer Lock branch (App.tsx addPointerRelative),
     * which likewise publishes movement with no position. A guest steering by motion
     * (DirectInput axes) sees this; one reading position does not. That split is the
     * whole point: an absolute injector cannot express a delta larger than the screen,
     * and a guest whose own cursor is already at the edge needs exactly that.
     */
    injectPointerDelta(dx: number, dy: number): boolean {
        const view = this.inputView;
        if (!view) return false;
        beginInputWrite(view);
        if (dx) Atomics.add(view, INPUT_INDEX.dinputDX, dx | 0);
        if (dy) Atomics.add(view, INPUT_INDEX.dinputDY, dy | 0);
        endInputWrite(view);
        this.poll(true);
        return true;
    }

    /** The pointer slots as the SAB holds them — the frame injected deltas are measured
     *  against. getMouseState() reports the CLAMPED cursor, which is a different fact. */
    getPublishedPointer(): { x: number; y: number } {
        const view = this.inputView;
        if (!view) return { x: this.currentMouseX, y: this.currentMouseY };
        return { x: view[INPUT_INDEX.mouseX], y: view[INPUT_INDEX.mouseY] };
    }

    /** Press/release a mouse button (0=left,1=right,2=middle) at a screen point. */
    injectButtonAtScreen(screenX: number, screenY: number, button: number, down: boolean): boolean {
        const view = this.inputView;
        if (!view) return false;
        const mask = this.mouseMaskFor(button);
        this.accumulateInjectedPointerDelta(view, screenX | 0, screenY | 0);
        beginInputWrite(view);
        view[INPUT_INDEX.mouseX] = screenX | 0;
        view[INPUT_INDEX.mouseY] = screenY | 0;
        view[INPUT_INDEX.mouseInside] = 1;
        view[INPUT_INDEX.buttons] = down ? (view[INPUT_INDEX.buttons] | mask) : (view[INPUT_INDEX.buttons] & ~mask);
        endInputWrite(view);
        this.poll(true);
        return true;
    }

    /** Press at (x0,y0), drag to (x1,y1) with the button held, release. */
    injectDragAtScreen(x0: number, y0: number, x1: number, y1: number, button = 0): boolean {
        if (!this.inputView) return false;
        this.injectMoveAtScreen(x0, y0);
        this.injectButtonAtScreen(x0, y0, button, true);
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
            const x = Math.round(x0 + ((x1 - x0) * i) / steps);
            const y = Math.round(y0 + ((y1 - y0) * i) / steps);
            this.injectMoveAtScreen(x, y);
        }
        this.injectButtonAtScreen(x1, y1, button, false);
        return true;
    }

    /** Inject a mouse-wheel notch at a screen point (browser pixel delta). */
    injectWheelAtScreen(screenX: number, screenY: number, delta: number): boolean {
        const view = this.inputView;
        if (!view) return false;
        this.accumulateInjectedPointerDelta(view, screenX | 0, screenY | 0);
        beginInputWrite(view);
        view[INPUT_INDEX.mouseX] = screenX | 0;
        view[INPUT_INDEX.mouseY] = screenY | 0;
        view[INPUT_INDEX.mouseInside] = 1;
        Atomics.store(view, INPUT_INDEX.mouseWheel, delta | 0); // poll() consumes + resets it
        endInputWrite(view);
        this.poll(true);
        return true;
    }

    /** Set/clear a key in the 256-bit keyboard bitfield; poll() emits WM_KEYDOWN/UP
     *  (with correct scan codes via vkToScanCode). */
    injectKey(vk: number, down: boolean): boolean {
        const view = this.inputView;
        if (!view) return false;
        const v = vk & 0xff;
        const word = v >> 5;
        const bit = v & 31;
        const idx = KEY_BITFIELD_BASE + word;
        beginInputWrite(view);
        view[idx] = down ? (view[idx] | (1 << bit)) : (view[idx] & ~(1 << bit));
        endInputWrite(view);
        this.poll(true);
        return true;
    }

    /** Tap a key (down then up). */
    injectKeyTap(vk: number): boolean {
        if (!this.injectKey(vk, true)) return false;
        return this.injectKey(vk, false);
    }

    getGamepadState(): { connected: boolean; buttons: number; axes: [number, number, number, number] } {
        return {
            connected: this.gamepadConnected,
            buttons: this.gamepadButtons,
            axes: this.gamepadAxes
        };
    }

    /**
     * Same level, for a read the GUEST did not ask for: joySetCapture's own poll timer,
     * diagnostics, the harness. Callers on this path must NOT stamp
     * noteGuestGamepadRead() — the control-layout auto-select reads that counter as "the
     * game is steering with a pad", and a host-side timer would hold it on for a title
     * that only ever registered a capture window.
     */
    peekGamepadStateWithoutUsage(): { connected: boolean; buttons: number; axes: [number, number, number, number] } {
        return this.getGamepadState();
    }

    /**
     * Announce a pad hot-plug the way Windows does: WM_DEVICECHANGE to the guest,
     * plus DirectInput's DIERR_INPUTLOST on every acquired joystick when the pad
     * leaves. The first observation after setInputBuffer/reset only seeds the
     * tracker (see GamepadPresenceTracker).
     */
    private announceGamepadPresence(connected: boolean): void {
        const event = this.gamepadPresence.observe(connected);
        if (!event) return;
        if (event === 'removal') markJoystickInputLost();
        broadcastGamepadDeviceChange(event === 'arrival');
    }

    /** Announced pad arrivals + removals so far (harness/diagnostics). */
    getGamepadPresenceTransitions(): number {
        return this.gamepadPresence.transitionCount;
    }

    /**
     * Instrumentation: simulate plugging/unplugging the pad by driving the SAB slot
     * through the normal seqlock + poll() path, so the edge detector, the
     * WM_DEVICECHANGE senders and the DirectInput lost-state all run exactly as they
     * do for a real host gamepad event. `announced` is false when this was the first
     * observation of the slot (seeded, not an edge).
     */
    injectGamepadPresence(connected: boolean): { ok: boolean; connected: boolean; announced: boolean } {
        const view = this.inputView;
        if (!view) return { ok: false, connected, announced: false };
        const before = this.gamepadPresence.transitionCount;
        beginInputWrite(view);
        view[INPUT_INDEX.gamepadConnected] = connected ? 1 : 0;
        if (!connected) {
            view[INPUT_INDEX.gamepadButtons] = 0;
            view[INPUT_INDEX.gamepadAxis0] = 0;
            view[INPUT_INDEX.gamepadAxis1] = 0;
            view[INPUT_INDEX.gamepadAxis2] = 0;
            view[INPUT_INDEX.gamepadAxis3] = 0;
        }
        endInputWrite(view);
        this.poll(true);
        return { ok: true, connected, announced: this.gamepadPresence.transitionCount !== before };
    }

    /**
     * Signal to the host that guest code just touched the joystick/gamepad API
     * (DInput Acquire/GetDeviceState on a joystick, or winmm joyGetPosEx). The host
     * polls this counter to tell "pad plugged in" apart from "game is reading it"
     * and lights the input-status overlay accordingly. Cheap monotonic bump; a stuck
     * value naturally decays to "idle" on the host side after a short window.
     */
    noteGuestGamepadRead(): void {
        if (this.inputView) {
            Atomics.add(this.inputView, INPUT_INDEX.guestGamepadSeq, 1);
        }
    }

    /**
     * Record that the guest observed a key as PRESSED (GetAsyncKeyState/GetKeyState
     * returning down, or a DI action map binding it). Answers "which keys does this
     * title steer with" for the host's control-layout auto-select, without knowing
     * the game.
     *
     * Only a read that RETURNED pressed sets a bit: bulk GetAsyncKeyState scans over
     * a wide VK range are routine in this era and would otherwise light every bit and
     * make the signal a constant.
     *
     * Plain non-atomic OR/increment on purpose — this rides the two hottest polled
     * thunks, and the bitmap is monotonic set-only, so a lost OR delays detection by
     * one poll and nothing more.
     */
    noteGuestKeyRead(vk: number, wasPressed: boolean): void {
        if (!wasPressed) return;
        const v = this.inputView;
        if (!v) return;
        const k = vk & 0xFF;
        v[GUEST_POLLED_KEYS_BASE + (k >> 5)] |= 1 << (k & 31);
        v[INPUT_INDEX.guestInputSeq]++;
    }

    /** GUEST_INPUT_FLAG_* — a guest input read that carries no single VK to attribute. */
    noteGuestInputFlag(flag: number): void {
        const v = this.inputView;
        if (!v) return;
        v[INPUT_INDEX.guestInputFlags] |= flag;
        v[INPUT_INDEX.guestInputSeq]++;
    }
}
