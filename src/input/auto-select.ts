// Picks an on-screen control preset from what the GUEST PROGRAM DOES — relative-mouse
// intent, joystick polls, and the VKs it observed as pressed (GUEST_POLLED_KEYS, worker
// side). No game identity is involved anywhere: the signals are properties of the API
// traffic, so a title we have never seen gets a sane layout on its first boot.
//
// Pure and total: no DOM, no storage, no clock. One rule per line, first match wins.

import { GUEST_POLLED_KEYS_COUNT } from "./sab-layout";

export type TouchMode = "direct" | "trackpad";

export interface AutoSelectSignals {
    /** The guest wants a relative mouse (cursor hidden / clipped / DI exclusive / warping). */
    relativeMouse: boolean;
    /** The guest polled a joystick device (guestGamepadSeq advanced). */
    readsPad: boolean;
    /**
     * The GUEST_POLLED_KEYS bitfield: 8 Int32 words, bit (vk & 31) of word (vk >> 5).
     * Copied straight out of the SAB — pass the same 8 words, not a list of VKs
     * (use `vkBitfield()` to build one from VK numbers).
     */
    polledVks: Int32Array | number[];
    /** GetKeyboardState / DI keyboard GetDeviceState seen — a keyboard read with no VK to attribute. */
    bulkKeyboard: boolean;
    /** Panel orientation. Preset IDs are orientation-independent; presets.ts picks the variant. */
    orientation: "landscape" | "portrait";
}

export interface AutoSelectResult {
    /** A preset id from src/input/controls/presets.ts. */
    presetId: string;
    mode: TouchMode;
    /** Offer the on-screen keyboard once: the title reads keys we could not attribute to a VK. */
    hintKeyboard?: boolean;
}

/** Preset ids (must match presets.ts). */
export const PRESET_POINTER = "pointer";
export const PRESET_POINTER_RMB = "pointer-rmb";
export const PRESET_WASD_LOOK = "wasd-look";
export const PRESET_DPAD_BUTTONS = "dpad-buttons";
export const PRESET_PAD = "pad";

const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const VK_W = 0x57, VK_A = 0x41, VK_S = 0x53, VK_D = 0x44;

const ARROW_VKS = [VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN];
const WASD_VKS = [VK_W, VK_A, VK_S, VK_D];

/** Test/caller helper: pack VK numbers into the GUEST_POLLED_KEYS word layout. */
export function vkBitfield(vks: number[]): Int32Array {
    const words = new Int32Array(GUEST_POLLED_KEYS_COUNT);
    for (const vk of vks) {
        const k = vk & 0xff;
        words[k >> 5] |= 1 << (k & 31);
    }
    return words;
}

export function isVkPolled(polledVks: Int32Array | number[], vk: number): boolean {
    const k = vk & 0xff;
    const word = polledVks[k >> 5] ?? 0;
    return (word & (1 << (k & 31))) !== 0;
}

function anyPolled(polledVks: Int32Array | number[], vks: number[]): boolean {
    for (const vk of vks) if (isVkPolled(polledVks, vk)) return true;
    return false;
}

/**
 * Rule table, highest-confidence first. Presets are supersets — every one of them still
 * taps — so an early match is safe even if a later signal would also have fired.
 */
export function pickPreset(signals: AutoSelectSignals): AutoSelectResult {
    const { relativeMouse, readsPad, polledVks, bulkKeyboard } = signals;

    // A pad-polling title steers with a stick; direct taps still reach its menus.
    if (readsPad) return { presetId: PRESET_PAD, mode: "direct" };
    // Relative-mouse intent means mouse-look: a finger must send deltas, not positions.
    if (relativeMouse) return { presetId: PRESET_WASD_LOOK, mode: "trackpad" };
    // Keyboard steering without relative mouse: WASD implies a look pad next to it,
    // arrows alone are a d-pad title (isometric / 2D action).
    if (anyPolled(polledVks, WASD_VKS)) return { presetId: PRESET_WASD_LOOK, mode: "direct" };
    if (anyPolled(polledVks, ARROW_VKS)) return { presetId: PRESET_DPAD_BUTTONS, mode: "direct" };
    // Reads the keyboard in bulk but never showed us a pressed VK — we cannot guess the
    // bindings, so keep the cursor and offer the keyboard sheet.
    if (bulkKeyboard) return { presetId: PRESET_POINTER, mode: "direct", hintKeyboard: true };
    return { presetId: PRESET_POINTER, mode: "direct" };
}

/**
 * The pointer layout is already the resolver's fallback, so an empty boot-time
 * snapshot must not make the one-shot auto picker sticky. A keyboard hint is a
 * real observed signal even though it deliberately keeps the pointer preset.
 */
export function shouldLatchAutoPreset(result: AutoSelectResult): boolean {
    return result.presetId !== PRESET_POINTER || result.hintKeyboard === true;
}

/**
 * A title that merely ENUMERATES a joystick at startup is not a title that steers
 * with one — and with a virtual pad always advertised on a touch device, that
 * boot-time check is something nearly every game does. So "reads a pad" means the
 * poll counter advanced in several separate observation windows, not once.
 */
export interface PadPollTracker {
    last: number;
    windows: number;
}

export const PAD_POLL_WINDOWS = 2;

export function newPadPollTracker(): PadPollTracker {
    return { last: 0, windows: 0 };
}

/** Fold one observation of `guestGamepadSeq` into the tracker. */
export function notePadPoll(t: PadPollTracker, seq: number): PadPollTracker {
    if (seq <= t.last) return t;
    return { last: seq, windows: t.windows + 1 };
}

export function padIsSteering(t: PadPollTracker): boolean {
    return t.windows >= PAD_POLL_WINDOWS;
}
