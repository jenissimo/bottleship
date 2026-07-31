// One test per rule of the control-preset table, plus the saturation case that made
// "only record reads that RETURNED pressed" load-bearing in the first place.

import { describe, expect, test } from "bun:test";
import {
    isVkPolled,
    newPadPollTracker,
    notePadPoll,
    padIsSteering,
    pickPreset,
    shouldLatchAutoPreset,
    vkBitfield,
    type AutoSelectSignals,
} from "../../src/input/auto-select";
import { GUEST_POLLED_KEYS_COUNT } from "../../src/input/sab-layout";

const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const VK_W = 0x57, VK_A = 0x41, VK_S = 0x53, VK_D = 0x44;
const VK_ESCAPE = 0x1b, VK_RETURN = 0x0d;

const NO_KEYS = new Int32Array(GUEST_POLLED_KEYS_COUNT);

function signals(over: Partial<AutoSelectSignals> = {}): AutoSelectSignals {
    return {
        relativeMouse: false,
        readsPad: false,
        polledVks: NO_KEYS,
        bulkKeyboard: false,
        orientation: "landscape",
        ...over,
    };
}

describe("pickPreset", () => {
    test("a pad-polling title gets the pad preset in direct mode", () => {
        expect(pickPreset(signals({ readsPad: true }))).toEqual({ presetId: "pad", mode: "direct" });
    });

    test("pad wins over every keyboard/mouse signal", () => {
        const r = pickPreset(signals({
            readsPad: true,
            relativeMouse: true,
            bulkKeyboard: true,
            polledVks: vkBitfield([VK_W, VK_LEFT]),
        }));
        expect(r.presetId).toBe("pad");
    });

    test("relative-mouse intent means look controls on a trackpad", () => {
        expect(pickPreset(signals({ relativeMouse: true }))).toEqual({ presetId: "wasd-look", mode: "trackpad" });
    });

    test("WASD observed pressed picks wasd-look in direct mode", () => {
        expect(pickPreset(signals({ polledVks: vkBitfield([VK_W, VK_A, VK_S, VK_D]) })))
            .toEqual({ presetId: "wasd-look", mode: "direct" });
    });

    test("arrows alone pick the d-pad preset", () => {
        expect(pickPreset(signals({ polledVks: vkBitfield([VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN]) })))
            .toEqual({ presetId: "dpad-buttons", mode: "direct" });
    });

    test("WASD outranks arrows when both are observed", () => {
        expect(pickPreset(signals({ polledVks: vkBitfield([VK_W, VK_LEFT]) })).presetId).toBe("wasd-look");
    });

    test("bulk keyboard reads with no steering key hint the keyboard sheet", () => {
        expect(pickPreset(signals({ bulkKeyboard: true })))
            .toEqual({ presetId: "pointer", mode: "direct", hintKeyboard: true });
    });

    test("no signal at all falls back to pointer", () => {
        expect(pickPreset(signals())).toEqual({ presetId: "pointer", mode: "direct" });
    });

    test("menu keys are not steering keys", () => {
        expect(pickPreset(signals({ polledVks: vkBitfield([VK_ESCAPE, VK_RETURN]) })).presetId).toBe("pointer");
    });

    test("a bulk GetAsyncKeyState scan does not degenerate the result", () => {
        // The saturation case: a title scanning VK 0..255 every frame records NOTHING
        // (no read returned pressed), so the table still reaches the pointer fallback.
        const scannedButNonePressed = new Int32Array(GUEST_POLLED_KEYS_COUNT);
        expect(pickPreset(signals({ polledVks: scannedButNonePressed })).presetId).toBe("pointer");

        // Whereas a saturated bitmap (what recording every READ would produce) would
        // have made the signal a constant — assert we can still tell the two apart.
        const everyVk = vkBitfield(Array.from({ length: 256 }, (_, i) => i));
        expect(pickPreset(signals({ polledVks: everyVk })).presetId).toBe("wasd-look");
    });

    test("the pick is stable per rule regardless of orientation", () => {
        for (const orientation of ["landscape", "portrait"] as const) {
            expect(pickPreset(signals({ orientation, polledVks: vkBitfield([VK_W]) })).presetId).toBe("wasd-look");
        }
    });
});

describe("auto-pick latching", () => {
    test("an empty boot snapshot keeps the pointer fallback provisional", () => {
        expect(shouldLatchAutoPreset(pickPreset(signals()))).toBe(false);
    });

    test("later steering and bulk-keyboard signals become sticky", () => {
        expect(shouldLatchAutoPreset(pickPreset(signals({ polledVks: vkBitfield([VK_W]) })))).toBe(true);
        expect(shouldLatchAutoPreset(pickPreset(signals({ bulkKeyboard: true })))).toBe(true);
        expect(shouldLatchAutoPreset(pickPreset(signals({ readsPad: true })))).toBe(true);
        expect(shouldLatchAutoPreset(pickPreset(signals({ relativeMouse: true })))).toBe(true);
    });
});

describe("vkBitfield", () => {
    test("round-trips through the SAB word layout", () => {
        const words = vkBitfield([VK_W, VK_LEFT, 0xff, 0x00]);
        expect(words.length).toBe(GUEST_POLLED_KEYS_COUNT);
        for (const vk of [VK_W, VK_LEFT, 0xff, 0x00]) expect(isVkPolled(words, vk)).toBe(true);
        expect(isVkPolled(words, VK_S)).toBe(false);
    });

    test("plain number[] words read the same as an Int32Array", () => {
        const words = Array.from(vkBitfield([VK_D]));
        expect(isVkPolled(words, VK_D)).toBe(true);
    });
});

describe("pad polling is sustained, not incidental", () => {
    test("a single boot-time enumeration does not count as steering", () => {
        let t = newPadPollTracker();
        t = notePadPoll(t, 1);
        expect(padIsSteering(t)).toBe(false);
    });

    test("polling across several windows does", () => {
        let t = newPadPollTracker();
        t = notePadPoll(t, 3);
        t = notePadPoll(t, 9);
        expect(padIsSteering(t)).toBe(true);
    });

    test("a quiet window advances nothing", () => {
        let t = newPadPollTracker();
        t = notePadPoll(t, 4);
        t = notePadPoll(t, 4);
        t = notePadPoll(t, 4);
        expect(padIsSteering(t)).toBe(false);
    });

    test("a title that never touches the pad stays at zero", () => {
        let t = newPadPollTracker();
        for (let i = 0; i < 10; i++) t = notePadPoll(t, 0);
        expect(t.windows).toBe(0);
        expect(padIsSteering(t)).toBe(false);
    });
});
