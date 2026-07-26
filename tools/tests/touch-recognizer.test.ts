// The touch gesture recognizer is pure and clock-free by construction, so every
// row of the plan's gesture vocabulary is a timeline literal here: contacts in,
// intents out, `now` injected. No DOM, no browser, no rAF.

import { describe, expect, test } from "bun:test";
import {
    AXIS_LATCH_PX,
    DRAG_COMMIT_MS,
    DRAG_SLOP_PX,
    FINGER_OFFSET_Y_PX,
    LONG_PRESS_MS,
    REFINE_GAIN,
    TAP_HOLD_MS,
    WHEEL_NOTCH_PX,
} from "../../src/input/touch/gestures";
import {
    WHEEL_NOTCH_DELTA_PX,
    createRecognizer,
    step,
    tick,
    type RecognizerConfig,
    type RecognizerState,
    type TouchIntent,
} from "../../src/input/touch/recognizer";

// Offsets and clamping are exercised on their own; everywhere else they would
// only obscure the coordinates under test.
function rec(cfg: RecognizerConfig = {}): RecognizerState {
    return createRecognizer({ cursorAid: false, maxX: 639, maxY: 479, ...cfg });
}

function ev(id: number, phase: "down" | "move" | "up" | "cancel", x: number, y: number) {
    return { id, phase, x, y } as const;
}

const buttons = (out: TouchIntent[]) => out.filter((i) => i.k === "button");
const cursors = (out: TouchIntent[]) => out.filter((i) => i.k === "cursor");
const deltas = (out: TouchIntent[]) => out.filter((i) => i.k === "delta");
const wheels = (out: TouchIntent[]) => out.filter((i) => i.k === "wheel");

describe("single contact — tap", () => {
    test("tap emits cursor, then the down, then the up only after TAP_HOLD_MS", () => {
        const s = rec();
        const t = 1000;
        const a = step(s, ev(1, "down", 320, 240), t);
        expect(a).toEqual([{ k: "cursor", x: 320, y: 240 }]);

        const b = step(s, ev(1, "up", 320, 240), t + 40);
        expect(b).toEqual([
            { k: "cursor", x: 320, y: 240 },
            { k: "button", button: 0, down: true },
        ]);

        // Still held: the level transport needs the button to survive a poll.
        expect(tick(s, t + 40 + TAP_HOLD_MS - 1)).toEqual([]);
        expect(tick(s, t + 40 + TAP_HOLD_MS)).toEqual([
            { k: "button", button: 0, down: false },
        ]);
    });

    test("the fingertip offset moves the published cursor clear of the contact", () => {
        const s = rec({ cursorAid: true });
        const out = step(s, ev(1, "down", 320, 240), 0);
        expect(out).toEqual([{ k: "cursor", x: 320, y: 240 + FINGER_OFFSET_Y_PX }]);
    });

    test("a REFINE slide resolves to a tap at the FINAL (refined) position", () => {
        const s = rec();
        step(s, ev(1, "down", 100, 100), 0);

        // Slop crossed late and slowly: precision aim slide, not a drag.
        const slide1 = step(s, ev(1, "move", 130, 100), 300);
        expect(buttons(slide1).length).toBe(0);
        const x1 = 100 + 30 * REFINE_GAIN;
        expect(slide1).toEqual([{ k: "cursor", x: x1, y: 100 }]);

        const slide2 = step(s, ev(1, "move", 150, 100), 400);
        const x2 = x1 + 20 * REFINE_GAIN;
        expect(slide2).toEqual([{ k: "cursor", x: x2, y: 100 }]);

        const lift = step(s, ev(1, "up", 150, 100), 420);
        expect(lift).toEqual([
            { k: "cursor", x: x2, y: 100 },
            { k: "button", button: 0, down: true },
        ]);
        expect(x2).toBeLessThan(150); // the finger travelled further than the cursor
    });
});

describe("single contact — long press", () => {
    test("a still contact holds no button until LONG_PRESS_MS, then RMB", () => {
        const s = rec({ longPressRight: true });
        step(s, ev(1, "down", 200, 200), 0);
        expect(tick(s, LONG_PRESS_MS - 1)).toEqual([]);

        const fired = tick(s, LONG_PRESS_MS);
        expect(fired).toEqual([{ k: "button", button: 2, down: true }]);

        const lift = step(s, ev(1, "up", 200, 200), LONG_PRESS_MS + 300);
        expect(lift).toEqual([{ k: "button", button: 2, down: false }]);
        // No LMB was ever committed — that is the whole point of deferring.
        expect([...fired, ...lift].some((i) => i.k === "button" && i.button === 0)).toBe(false);
    });

    test("longPressRight=false commits LMB instead", () => {
        const s = rec({ longPressRight: false });
        step(s, ev(1, "down", 200, 200), 0);
        expect(tick(s, LONG_PRESS_MS)).toEqual([{ k: "button", button: 0, down: true }]);
    });
});

describe("single contact — drag classification", () => {
    test("a fast slop crossing commits the drag from the ORIGIN", () => {
        const s = rec();
        step(s, ev(1, "down", 100, 100), 0);

        const commit = step(s, ev(1, "move", 100 + DRAG_SLOP_PX + 4, 100), 50);
        expect(commit).toEqual([
            { k: "cursor", x: 100, y: 100 },              // the down lands where the finger started
            { k: "button", button: 0, down: true },
        ]);

        expect(step(s, ev(1, "move", 160, 100), 70)).toEqual([{ k: "cursor", x: 160, y: 100 }]);

        // Released with the same wall-clock floor a tap gets.
        expect(step(s, ev(1, "up", 160, 100), 90)).toEqual([]);
        expect(tick(s, 50 + TAP_HOLD_MS)).toEqual([{ k: "button", button: 0, down: false }]);
    });

    test("a slow slop crossing after DRAG_COMMIT_MS commits no button", () => {
        const s = rec();
        step(s, ev(1, "down", 100, 100), 0);
        const late = step(s, ev(1, "move", 100 + DRAG_SLOP_PX + 4, 100), DRAG_COMMIT_MS + 60);
        expect(buttons(late).length).toBe(0);
        expect(cursors(late).length).toBe(1);
        // ...and the long press is disarmed, so nothing fires later either.
        expect(tick(s, LONG_PRESS_MS + 100)).toEqual([]);
    });
});

describe("multi contact", () => {
    test("a two-finger tap inside the arbitration window emits RMB", () => {
        const s = rec();
        step(s, ev(1, "down", 300, 200), 0);
        expect(step(s, ev(2, "down", 340, 200), 40)).toEqual([]);
        expect(step(s, ev(1, "up", 300, 200), 100)).toEqual([]);

        const resolved = step(s, ev(2, "up", 340, 200), 110);
        expect(resolved).toEqual([
            { k: "cursor", x: 300, y: 200 },              // at the PRIMARY position
            { k: "button", button: 2, down: true },
        ]);
        expect(tick(s, 110 + TAP_HOLD_MS)).toEqual([{ k: "button", button: 2, down: false }]);
    });

    test("a two-finger vertical drag emits wheel notches on the latched pan axis", () => {
        const s = rec();
        step(s, ev(1, "down", 200, 200), 0);
        step(s, ev(2, "down", 300, 200), 20);

        // Below the latch distance: classification not made yet, nothing emitted.
        const pre = [
            ...step(s, ev(1, "move", 200, 200 + AXIS_LATCH_PX - 6), 40),
            ...step(s, ev(2, "move", 300, 200 + AXIS_LATCH_PX - 6), 40),
        ];
        expect(pre).toEqual([]);

        // Past the latch, then past a notch: fingers moving DOWN scroll up.
        step(s, ev(1, "move", 200, 200 + WHEEL_NOTCH_PX), 60);
        const notch = step(s, ev(2, "move", 300, 200 + WHEEL_NOTCH_PX), 60);
        expect(notch).toEqual([{ k: "wheel", delta: -WHEEL_NOTCH_DELTA_PX }]);

        // Axis latched to pan: pulling the fingers apart is not a pinch any more.
        const spread = [
            ...step(s, ev(1, "move", 100, 200 + WHEEL_NOTCH_PX), 80),
            ...step(s, ev(2, "move", 400, 200 + WHEEL_NOTCH_PX), 80),
        ];
        expect(spread).toEqual([]);

        // Reversing the pan direction flips the sign.
        step(s, ev(1, "move", 100, 200 - WHEEL_NOTCH_PX), 100);
        const back = step(s, ev(2, "move", 400, 200 - WHEEL_NOTCH_PX), 100);
        expect(wheels(back).length).toBeGreaterThan(0);
        expect(wheels(back).every((w) => w.k === "wheel" && w.delta > 0)).toBe(true);
    });

    test("a pinch latched on distance ignores translation for the rest of the gesture", () => {
        const s = rec();
        step(s, ev(1, "down", 200, 300), 0);
        step(s, ev(2, "down", 300, 300), 20);

        // Spread 100 -> 130: past the latch, short of a notch.
        step(s, ev(1, "move", 185, 300), 40);
        const latched = step(s, ev(2, "move", 315, 300), 40);
        expect(wheels(latched).length).toBe(0);

        // Pure translation, one contact per event as the browser delivers it:
        // the distance only flickers, and the latched axis ignores the pan entirely.
        const translated: TouchIntent[] = [];
        for (let y = 330; y <= 390; y += 30) {
            translated.push(...step(s, ev(1, "move", 185, y), 60 + y));
            translated.push(...step(s, ev(2, "move", 315, y), 60 + y));
        }
        expect(translated).toEqual([]);

        // Spreading further still scrolls, on distance.
        const more = [
            ...step(s, ev(1, "move", 165, 390), 200),
            ...step(s, ev(2, "move", 335, 390), 210),
        ];
        expect(more).toEqual([{ k: "wheel", delta: -WHEEL_NOTCH_DELTA_PX }]);
    });
});

describe("cancel", () => {
    test("cancel during an armed long press emits nothing, ever", () => {
        const s = rec();
        step(s, ev(1, "down", 200, 200), 0);
        expect(tick(s, 400)).toEqual([]);
        expect(step(s, ev(1, "cancel", 200, 200), 450)).toEqual([]);
        expect(tick(s, LONG_PRESS_MS + 200)).toEqual([]);
    });

    test("cancel mid-drag releases the committed button", () => {
        const s = rec();
        step(s, ev(1, "down", 100, 100), 0);
        const commit = step(s, ev(1, "move", 140, 100), 50);
        expect(buttons(commit)).toEqual([{ k: "button", button: 0, down: true }]);

        expect(step(s, ev(1, "cancel", 140, 100), 60)).toEqual([
            { k: "button", button: 0, down: false },
        ]);
        expect(tick(s, 1000)).toEqual([]);
    });
});

describe("trackpad mode", () => {
    test("motion emits delta, never cursor, and a tap needs no position", () => {
        const s = rec({ mode: "trackpad" });
        expect(step(s, ev(1, "down", 100, 100), 0)).toEqual([]);

        const moved = step(s, ev(1, "move", 104, 103), 20);
        expect(moved).toEqual([{ k: "delta", dx: 4, dy: 3 }]);
        expect(cursors(moved).length).toBe(0);

        const lift = step(s, ev(1, "up", 104, 103), 40);
        expect(lift).toEqual([{ k: "button", button: 0, down: true }]);
        expect(cursors(lift).length).toBe(0);
        expect(tick(s, 40 + TAP_HOLD_MS)).toEqual([{ k: "button", button: 0, down: false }]);
    });

    test("sensitivity scales the delta", () => {
        const s = rec({ mode: "trackpad", sensitivity: 2 });
        step(s, ev(1, "down", 100, 100), 0);
        expect(deltas(step(s, ev(1, "move", 104, 103), 20))).toEqual([
            { k: "delta", dx: 8, dy: 6 },
        ]);
    });

    test("a look drag commits no button", () => {
        const s = rec({ mode: "trackpad" });
        step(s, ev(1, "down", 100, 100), 0);
        const look = step(s, ev(1, "move", 200, 100), 50);
        expect(buttons(look).length).toBe(0);
        expect(deltas(look)).toEqual([{ k: "delta", dx: 100, dy: 0 }]);
        expect(step(s, ev(1, "up", 200, 100), 80)).toEqual([]);
    });
});
