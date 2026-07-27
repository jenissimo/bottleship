// Regression pins for four mobile-touch defects that were all silent — the feature looked
// finished and three of these made a capability simply not exist. Each test states the
// user-visible failure it prevents, because none of them announce themselves at runtime.

import { describe, expect, test } from "bun:test";
import { createRecognizer, step, type RecognizerState, type TouchIntent } from "../../src/input/touch/recognizer";
import { BindingPresser } from "../../src/input/controls/press";
import { inputDevice } from "../../src/input/virtual-device";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";

const rec = (): RecognizerState => createRecognizer({ cursorAid: false, maxX: 639, maxY: 479 });
const ev = (id: number, phase: "down" | "move" | "up" | "cancel", x: number, y: number) =>
    ({ id, phase, x, y } as const);

describe("recognizer reaps contacts whose lift never arrived", () => {
    // A pointerup/pointercancel CAN be lost — the element goes away mid-gesture, the browser
    // drops capture. The slot table is fixed-size, so without ageing, MAX_CONTACTS lost lifts
    // leave touch permanently dead with no way back for the rest of the session.
    test("10 lost lifts do not brick the recognizer", () => {
        const s = rec();
        let now = 1000;
        for (let i = 0; i < 10; i++) {
            step(s, ev(i, "down", 100 + i, 100), now);
            now += 10;               // no "up" ever arrives for any of them
        }
        expect(s.count).toBe(10);    // table full

        // Well past the stale window: the next touchdown must be accepted.
        now += 60_000;
        const out: TouchIntent[] = step(s, ev(99, "down", 200, 200), now);
        expect(s.count).toBe(1);
        expect(out.some((i) => i.k === "button" && i.down)).toBe(false); // reaped, not tapped
    });

    test("a live contact is not reaped while it is still moving", () => {
        const s = rec();
        let now = 1000;
        step(s, ev(1, "down", 100, 100), now);
        // Move it every 10 s for a minute — far longer than the stale window, but never idle.
        for (let i = 0; i < 6; i++) {
            now += 10_000;
            step(s, ev(1, "move", 100 + i, 100), now);
        }
        now += 10_000;
        step(s, ev(2, "down", 300, 300), now);
        expect(s.count).toBe(2);
    });
});

describe("BindingPresser.releaseAll defers its publish when asked", () => {
    // The failure this pins: releaseAll's own immediate commit shipped the frame where the
    // pad was released but not yet re-asserted, which reads to the guest as a controller
    // unplug — DIERR_INPUTLOST on every acquired DirectInput joystick, on every tab hide.
    // Asserted against the REAL presser and the real device: a hand-rolled stand-in would
    // pass whatever the production path did.
    function rig() {
        const view = new Int32Array(INPUT_BUFFER_SIZE / 4);
        let publishes = 0;
        inputDevice.attach(view, () => { publishes++; });
        const presser = new BindingPresser("touch");
        presser.set("k", { t: "key", vk: 0x41 }, true);
        inputDevice.commit({ immediate: true });
        const before = publishes;
        return { presser, publishes: () => publishes - before };
    }

    test("flush:false leaves publishing to the caller", () => {
        const r = rig();
        r.presser.releaseAll(false);
        expect(r.publishes()).toBe(0);
    });

    test("flush defaults to true, so every other caller is unaffected", () => {
        const r = rig();
        r.presser.releaseAll();
        expect(r.publishes()).toBe(1);
    });
});
