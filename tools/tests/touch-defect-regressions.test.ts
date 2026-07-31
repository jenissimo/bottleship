// Regression pins for four mobile-touch defects that were all silent — the feature looked
// finished and three of these made a capability simply not exist. Each test states the
// user-visible failure it prevents, because none of them announce themselves at runtime.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRecognizer, step, tick, type RecognizerState, type TouchIntent } from "../../src/input/touch/recognizer";
import { BindingPresser } from "../../src/input/controls/press";
import { TouchDriver } from "../../src/input/touch/driver";
import { inputDevice } from "../../src/input/virtual-device";
import { INPUT_BUFFER_SIZE, INPUT_INDEX } from "../../src/input/sab-layout";

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

    // The costly variant: nothing publishes while a contact just sits, so a lost lift
    // mid-drag leaves LMB down and the rAF pump spinning — and reaping only from
    // touchdown made recovery depend on the player putting a SECOND finger down.
    test("a lost lift under a held button releases it without a second contact", () => {
        const s = rec();
        const pressed = step(s, ev(1, "down", 100, 100), 1000).concat(step(s, ev(1, "move", 180, 100), 1040));
        expect(pressed.some((i) => i.k === "button" && i.down)).toBe(true);

        // Still a plausible hold at 9 s…
        expect(tick(s, 10_040).some((i) => i.k === "button")).toBe(false);
        expect(s.count).toBe(1);
        // …but not at 10.
        const released = tick(s, 11_041);
        expect(released.some((i) => i.k === "button" && !i.down)).toBe(true);
        expect(s.count).toBe(0);
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

describe("the driver decides what belongs to the guest", () => {
    // Routing CANNOT live in a React handler: React delegates to the root container, so
    // the driver's native listener on the panel has already fed the contact by the time
    // an overlay calls stopPropagation(). Every HUD tap, on-screen key and hint tap was
    // therefore also a click in the guest.
    type Listener = (e: unknown) => void;

    class FakePanel {
        readonly on = new Map<string, Listener>();
        addEventListener(type: string, fn: Listener): void { this.on.set(type, fn); }
        removeEventListener(type: string): void { this.on.delete(type); }
        fire(type: string, event: unknown): void { this.on.get(type)?.(event); }
    }

    // A 640x480 picture with the panel's letterbox around it; scale is 1 guest px per CSS px.
    const RECT = { left: 100, top: 50, right: 740, bottom: 530, width: 640, height: 480 };
    const RESERVED = { closest: (sel: string) => (sel === "[data-touch-reserved]" ? {} : null) };
    const PLAIN = { closest: () => null };

    const pev = (id: number, x: number, y: number, target: unknown = PLAIN, t = 1) =>
        ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y, target, timeStamp: t });

    let raf: unknown;
    let cancel: unknown;
    beforeAll(() => {
        raf = (globalThis as any).requestAnimationFrame;
        cancel = (globalThis as any).cancelAnimationFrame;
        // The pump is not what these assert; snapshot() publishes synchronously.
        (globalThis as any).requestAnimationFrame = () => 1;
        (globalThis as any).cancelAnimationFrame = () => { /* nothing queued */ };
    });
    afterAll(() => {
        (globalThis as any).requestAnimationFrame = raf;
        (globalThis as any).cancelAnimationFrame = cancel;
    });

    function rig() {
        const view = new Int32Array(INPUT_BUFFER_SIZE / 4);
        inputDevice.attach(view, () => { /* the worker poke is not what this asserts */ });
        inputDevice.releaseAllSources();
        inputDevice.setPointerBounds(640, 480);
        inputDevice.setPointerAbsolute(7, 9);
        inputDevice.commit({ immediate: true });

        const panel = new FakePanel();
        const driver = new TouchDriver();
        const claims: string[] = [];
        driver.attach(panel as unknown as HTMLElement, {
            getCanvasRect: () => RECT as DOMRect,
            getPointerSpace: () => ({ width: 640, height: 480 }),
            getSettings: () => ({
                touchMode: "direct", touchSensitivity: 1,
                touchLongPressRight: true, touchCursorAid: false,
            }),
            hitTest: (_x, _y, id, phase) => { claims.push(`${phase}:${id}`); return false; },
        });
        return { panel, driver, claims, snap: () => inputDevice.snapshot() };
    }

    test("a tap on the picture is a click at that point", () => {
        const r = rig();
        r.panel.fire("pointerdown", pev(1, 420, 290));
        r.panel.fire("pointerup", pev(1, 420, 290, PLAIN, 30));
        const s = r.snap();
        expect(s.cursor).toEqual({ x: 320, y: 240 });
        expect(s.buttons).toBe(1);
    });

    test("a tap on a data-touch-reserved overlay reaches neither the guest nor the widgets", () => {
        const r = rig();
        r.panel.fire("pointerdown", pev(1, 420, 290, RESERVED));
        r.panel.fire("pointerup", pev(1, 420, 290, RESERVED, 30));
        const s = r.snap();
        expect(s.buttons).toBe(0);
        expect(s.cursor).toEqual({ x: 7, y: 9 });
        expect(r.claims).toEqual([]);
    });

    test("a contact that starts on the letterbox is not a click on the guest's edge", () => {
        const r = rig();
        r.panel.fire("pointerdown", pev(1, 420, 20));   // above the picture
        r.panel.fire("pointermove", pev(1, 420, 30, PLAIN, 20));
        r.panel.fire("pointerup", pev(1, 420, 30, PLAIN, 30));
        const s = r.snap();
        expect(s.buttons).toBe(0);
        expect(s.cursor).toEqual({ x: 7, y: 9 });
    });

    test("lostpointercapture after a normal lift ends nothing twice", () => {
        const r = rig();
        r.panel.fire("pointerdown", pev(1, 420, 290));
        r.panel.fire("pointerup", pev(1, 420, 290, PLAIN, 30));
        // Touch pointers get implicit capture, so this arrives after EVERY lift.
        r.panel.fire("lostpointercapture", pev(1, 420, 290, PLAIN, 31));
        // The tap's owed release is still owed — the spurious cancel must not have
        // walked the gesture into another phase behind it.
        expect(r.snap().buttons).toBe(1);
    });

    test("reset() lets the next gesture press again", () => {
        const r = rig();
        r.panel.fire("pointerdown", pev(1, 420, 290));
        r.panel.fire("pointermove", pev(1, 500, 290, PLAIN, 40));
        expect(r.snap().buttons).toBe(1);

        // What handleBlur does: drop every producer's levels, then the gesture state.
        inputDevice.releaseAllSources();
        inputDevice.commit({ immediate: true });
        r.driver.reset();
        expect(r.snap().buttons).toBe(0);

        r.panel.fire("pointerdown", pev(2, 300, 200, PLAIN, 100));
        r.panel.fire("pointermove", pev(2, 380, 200, PLAIN, 140));
        expect(r.snap().buttons).toBe(1);
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
