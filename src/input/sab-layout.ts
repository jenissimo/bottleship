// The host↔worker input record: one SharedArrayBuffer written by the main thread
// (and by the worker's own synthetic-input injectors) and polled by InputManager.
// Single definition for both sides — the slot map is load-bearing down to the bit,
// so a second copy that drifts is silent, undebuggable input corruption.
//
// Plain leaf module: no DOM, no worker imports, so it is unit-testable directly.

/** Bytes. 1024 B = 256 Int32 slots; slots 0..34 are defined, the rest are spare. */
export const INPUT_BUFFER_SIZE = 1024;

export const INPUT_INDEX = {
    seq: 0,
    mouseX: 1,
    mouseY: 2,
    buttons: 3,       // BROWSER flags (left=1, right=2, middle=4), not Win32 MK_*
    keyCode: 4,       // deprecated (legacy single-event slot)
    keyState: 5,      // deprecated (legacy single-event slot)
    gamepadConnected: 6,
    gamepadButtons: 7,
    gamepadAxis0: 8,
    gamepadAxis1: 9,
    gamepadAxis2: 10,
    gamepadAxis3: 11,
    mouseWheel: 12,   // browser pixel deltaY, consumed destructively by poll()
    mouseInside: 13,  // 1 = cursor inside canvas, 0 = outside
    dinputDX: 14,     // accumulated DInput RAW movementX delta (Atomics.add / exchange)
    dinputDY: 15,     // accumulated DInput RAW movementY delta
    // 16..23 = the keyboard bitfield (KEY_BITFIELD_BASE)

    // --- worker → host (the reverse direction; host reads, worker writes) ---
    /**
     * Monotonic counter bumped whenever the GUEST reads a joystick/gamepad device
     * (DInput Acquire/GetDeviceState or winmm joyGetPosEx). Distinguishes "a pad is
     * plugged into the browser" from "the game is actually using one" — drives the
     * input-status overlay and the on-screen control auto-select.
     */
    guestGamepadSeq: 24,
    // 25..32 = guestPolledKeys bitfield (GUEST_POLLED_KEYS_BASE)
    /** Bumped on any guest input-API read; lets the host debounce auto-select cheaply. */
    guestInputSeq: 33,
    /** GUEST_INPUT_FLAG_* — reads that carry no single VK to record. */
    guestInputFlags: 34,
} as const;

/** Keyboard bitfield: 256 virtual keys as 8 x Int32 = 256 bits. Host → worker. */
export const KEY_BITFIELD_BASE = 16;
export const KEY_BITFIELD_COUNT = 8;

/**
 * VKs the guest has observed as PRESSED (worker → host), same 8-word bitfield
 * shape. Set-only and monotonic: it answers "which keys does this title actually
 * steer with", which is how a control layout is picked without knowing the game.
 * Only a read that RETURNED pressed sets a bit — a bulk GetAsyncKeyState scan over
 * a wide VK range (common in this era) would otherwise light every bit and make the
 * signal a constant.
 */
export const GUEST_POLLED_KEYS_BASE = 25;
export const GUEST_POLLED_KEYS_COUNT = 8;

/** Guest input reads that identify a device rather than a key. */
export const GUEST_INPUT_FLAG = {
    /** DirectInput keyboard GetDeviceState — the whole 256-byte table at once. */
    dinputKeyboard: 1 << 0,
    /** GetKeyboardState — bulk read, no single VK to attribute. */
    bulkKeyboard: 1 << 1,
    /** The guest consumed a wheel delta (WM_MOUSEWHEEL or DIMOFS_Z). */
    wheel: 1 << 2,
} as const;

// --- SAB input seqlock (writer side) ---------------------------------------
// The record spans many slots but is published through the single `seq` counter.
// Plain payload writes with only a trailing bump let the reader observe a HALF
// updated record. Bracket every payload update: bump seq to ODD (writer in
// progress), write the payload, bump to EVEN (publish). Atomics.add is a
// sequentially-consistent RMW, so it fences the plain stores between the two
// markers; the reader's paired Atomics.load(seq) sees either an odd value (retry)
// or a stable even snapshot. seq stays even between updates and each update is
// +2, so a reader's "changed since lastSeq" gate is unaffected.
//
// A bare single +1 leaves seq odd forever and the reader skips permanently.
export function beginInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1);
}
export function endInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1);
}
