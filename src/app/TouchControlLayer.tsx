// On-screen control overlay. Must be mounted inside the panel the touch driver is
// attached to, and its `hitTest` wired into TouchDriverOptions.hitTest.
//
// PRESENTATION only: it never binds pointer listeners. The driver owns the listener
// set on the panel (a pointer-events:none layer root is not a hit-test target and
// would never see a contact that starts on bare canvas) and routes contacts here
// through `hitTest`; a `true` return claims that contact for its whole lifetime.
//
// The active layout is the `layout` PROP — null hides the layer and releases
// everything it holds. Pressed state is `classList.toggle` and transform writes,
// never setState: a per-contact React re-render competes with the frame loop for
// the main thread the presenter runs on.

import React, {
    forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect,
    useMemo, useRef, useState,
} from "react";
import { cx } from "../ui/cx";
import s from "./TouchControlLayer.module.css";
import { describeBinding, type HostAction } from "../input/bindings";
import {
    pickRect, resolveRects, type ControlLayout, type ControlWidget,
} from "../input/controls/types";
import { BindingPresser } from "../input/controls/press";
import { inputDevice } from "../input/virtual-device";

export type ContactPhase = "down" | "move" | "up" | "cancel";

export interface TouchControlsHandle {
    /** Claim (or decline) a contact. Wired straight into TouchDriverOptions.hitTest. */
    hitTest(clientX: number, clientY: number, pointerId: number, phase: ContactPhase): boolean;
    /** Re-measure the panel; the ResizeObserver covers the ordinary cases. */
    refresh(): void;
    /** Drop every level this layer holds (blur, game switch, layout edit). */
    /** `flush: false` lets the caller publish once after restoring the rest of the world. */
    releaseAll(flush?: boolean): void;
}

export interface TouchControlLayerProps {
    layout: ControlLayout | null;
    /** Guest pixels per CSS pixel — trackpad and mouse-stick motion scale by it. */
    getPointerScale?: () => { x: number; y: number };
    /** Multiplier on relative motion, from uiSettings.touchSensitivity. */
    sensitivity?: number;
    /** Chrome opacity; the hit rects are unaffected. */
    opacity?: number;
    /** Dim the chrome while nothing is being touched. */
    idleFade?: boolean;
    onHostAction?: (action: HostAction) => void;
}

/** One browser wheel notch in the units App/the recognizer publish (deltaY-like). */
const WHEEL_NOTCH = 100;
/** Cursor travel per frame at full mouse-stick deflection, in CSS px. */
const STICK_MOUSE_PX = 12;
const DEFAULT_DEADZONE = 0.22;
/** Travel before a trackpad or wheel contact stops being a candidate tap. */
const TAP_SLOP_PX = 10;
/** Quiet time before the chrome dims. Long enough not to flicker between taps. */
const IDLE_MS = 2500;

interface Contact {
    widget: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    /** Stick centre for `recenter`, in client px. */
    originX: number;
    originY: number;
    moved: boolean;
    /** Travel banked toward the next wheel notch. */
    accum: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const TouchControlLayer = forwardRef<TouchControlsHandle, TouchControlLayerProps>(
    function TouchControlLayer(props, ref) {
        const {
            layout, getPointerScale, sensitivity = 1, opacity = 0.8,
            idleFade = true, onHostAction,
        } = props;

        const rootRef = useRef<HTMLDivElement | null>(null);
        const elsRef = useRef<(HTMLDivElement | null)[]>([]);
        const knobsRef = useRef<(HTMLElement | null)[]>([]);
        const hitRef = useRef<Float32Array>(new Float32Array(0));
        const visualRef = useRef<Float32Array>(new Float32Array(0));
        /** 1 where a widget had to sit over the picture — no bar was wide enough. */
        const overRef = useRef<Uint8Array>(new Uint8Array(0));
        const fadeRef = useRef(idleFade);
        const contactsRef = useRef(new Map<number, Contact>());
        const layoutRef = useRef<ControlLayout | null>(null);
        const rafRef = useRef(0);
        const propsRef = useRef({ getPointerScale, sensitivity, onHostAction });

        // Lazy state initializer, not a ref: the presser owns pending release
        // timers and must be identical for the life of the component.
        const [presser] = useState(() => new BindingPresser("widget"));

        const widgets = useMemo(() => layout?.widgets ?? [], [layout]);

        useEffect(() => {
            propsRef.current = { getPointerScale, sensitivity, onHostAction };
        }, [getPointerScale, sensitivity, onHostAction]);

        // --- idle fade -----------------------------------------------------
        // A static overlay at full strength is visually loud over a 640x480 picture,
        // and most of a session is spent not touching the controls at all. Class +
        // timer, never state: this fires on the contact path.

        const idleRef = useRef(0);
        const wake = useCallback(() => {
            const root = rootRef.current;
            if (!root) return;
            if (idleRef.current) clearTimeout(idleRef.current);
            root.classList.remove(s["layer--idle"]!);
            if (!fadeRef.current) return;
            idleRef.current = window.setTimeout(() => {
                idleRef.current = 0;
                rootRef.current?.classList.add(s["layer--idle"]!);
            }, IDLE_MS);
        }, []);

        useEffect(() => {
            fadeRef.current = idleFade;
            wake();
            return () => { if (idleRef.current) clearTimeout(idleRef.current); };
        }, [idleFade, wake]);

        // --- geometry ------------------------------------------------------

        const measure = useCallback(() => {
            const root = rootRef.current;
            const l = layoutRef.current;
            if (!root || !l || l.widgets.length === 0) return;
            const panel = root.getBoundingClientRect();
            if (panel.width <= 0 || panel.height <= 0) return;
            const list = l.widgets;

            // Where the picture actually is decides where the letterbox bars are, and
            // the shell's own overlays declare themselves rather than being hardcoded
            // here — any future corner affordance just carries the attribute.
            const canvasEl = root.parentElement?.querySelector("canvas");
            const canvas = canvasEl ? canvasEl.getBoundingClientRect() : null;
            const reserved: DOMRect[] = [];
            for (const el of root.parentElement?.querySelectorAll("[data-touch-reserved]") ?? []) {
                reserved.push(el.getBoundingClientRect());
            }

            if (overRef.current.length < list.length) overRef.current = new Uint8Array(list.length);
            const opts = { canvas, reserved, overCanvas: overRef.current };
            hitRef.current = resolveRects(l, panel, opts, hitRef.current);
            const vis = resolveRects(l, panel, { ...opts, minHitPx: 0 }, visualRef.current);
            visualRef.current = vis;
            for (let i = 0; i < list.length; i++) {
                const el = elsRef.current[i];
                if (!el) continue;
                const o = i * 4;
                // Position relative to the layer root, which is the panel's safe area.
                el.style.transform = `translate3d(${vis[o] - panel.left}px, ${vis[o + 1] - panel.top}px, 0)`;
                el.style.width = `${vis[o + 2]}px`;
                el.style.height = `${vis[o + 3]}px`;
                // Over the picture: the chrome dims so it costs the player less.
                el.classList.toggle(s["widget--over"]!, overRef.current[i] === 1);
            }
        }, []);

        // Layout effect, not render: the hit rects must describe the DOM that was
        // just committed before any pointer event can be dispatched against it.
        useLayoutEffect(() => {
            layoutRef.current = layout;
            measure();
        }, [layout, measure]);

        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            const ro = new ResizeObserver(measure);
            ro.observe(root);
            window.addEventListener("resize", measure);
            // A pinch-pan moves the visual viewport without resizing anything, and
            // every hit rect is stored in client coordinates.
            window.visualViewport?.addEventListener("resize", measure);
            window.visualViewport?.addEventListener("scroll", measure);
            return () => {
                ro.disconnect();
                window.removeEventListener("resize", measure);
                window.visualViewport?.removeEventListener("resize", measure);
                window.visualViewport?.removeEventListener("scroll", measure);
            };
        }, [measure, widgets]);

        // A layout swap must not leave the previous scheme's keys held.
        useEffect(() => {
            contactsRef.current.clear();
            presser.releaseAll();
        }, [presser, widgets]);

        useEffect(() => () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            contactsRef.current.clear();
            presser.releaseAll();
        }, [presser]);

        // --- widget behaviour ----------------------------------------------

        const setClass = (index: number, name: string, on: boolean): void => {
            elsRef.current[index]?.classList.toggle(s[name] ?? name, on);
        };

        const setKnob = (index: number, dx: number, dy: number): void => {
            const knob = knobsRef.current[index];
            if (knob) knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        };

        /** 4- or 8-way directional levels shared by dpad and stick(out:"keys"). */
        const applyDirections = useCallback((
            w: Extract<ControlWidget, { kind: "dpad" | "stick" }>,
            index: number, nx: number, ny: number, deadzone: number, diagonals: boolean,
        ): void => {
            const binds = w.binds;
            if (!binds) return;
            const mag = Math.hypot(nx, ny);
            let up = false, down = false, left = false, right = false;
            if (mag >= deadzone) {
                const ax = Math.abs(nx);
                const ay = Math.abs(ny);
                if (diagonals) {
                    // Eight equal 45-degree sectors: an axis contributes once its
                    // share of the vector passes cos(67.5deg).
                    if (ax > mag * 0.383) { if (nx < 0) left = true; else right = true; }
                    if (ay > mag * 0.383) { if (ny < 0) up = true; else down = true; }
                } else if (ax >= ay) {
                    if (nx < 0) left = true; else right = true;
                } else {
                    if (ny < 0) up = true; else down = true;
                }
            }
            presser.set(`${w.id}:u`, binds.up, up);
            presser.set(`${w.id}:d`, binds.down, down);
            presser.set(`${w.id}:l`, binds.left, left);
            presser.set(`${w.id}:r`, binds.right, right);
            setClass(index, "is-up", up);
            setClass(index, "is-down", down);
            setClass(index, "is-left", left);
            setClass(index, "is-right", right);
        }, [presser]);

        /** Deflection of a contact inside a widget, normalized to [-1, 1] per axis. */
        const deflection = (index: number, c: Contact, recenter: boolean): { nx: number; ny: number } => {
            const o = index * 4;
            const r = hitRef.current;
            const halfW = Math.max(1, r[o + 2] / 2);
            const halfH = Math.max(1, r[o + 3] / 2);
            const cx = recenter ? c.originX : r[o] + halfW;
            const cy = recenter ? c.originY : r[o + 1] + halfH;
            return {
                nx: clamp((c.lastX - cx) / halfW, -1, 1),
                ny: clamp((c.lastY - cy) / halfH, -1, 1),
            };
        };

        const scale = (): { x: number; y: number } => propsRef.current.getPointerScale?.() ?? { x: 1, y: 1 };

        /** One frame of mouse-stick motion. Returns whether the pump should keep running. */
        const pumpStep = useCallback((): boolean => {
            const list = layoutRef.current?.widgets;
            if (!list) return false;
            let live = false;
            for (const [, c] of contactsRef.current) {
                const w = list[c.widget];
                if (!w || w.kind !== "stick" || w.out !== "mouse") continue;
                live = true;
                const { nx, ny } = deflection(c.widget, c, w.recenter === true);
                const dz = w.deadzone ?? DEFAULT_DEADZONE;
                const mag = Math.hypot(nx, ny);
                if (mag < dz) continue;
                // Re-map past the deadzone so the first pixel of travel is not a jump.
                const gain = ((mag - dz) / (1 - dz)) / mag
                    * STICK_MOUSE_PX * (w.sensitivity ?? 1) * propsRef.current.sensitivity;
                const sc = scale();
                inputDevice.addPointerRelative(nx * gain * sc.x, ny * gain * sc.y, nx * gain, ny * gain);
            }
            if (live) inputDevice.commit();
            return live;
        }, []);

        const startPump = useCallback(() => {
            if (rafRef.current) return;
            function loop(): void {
                rafRef.current = pumpStep() ? requestAnimationFrame(loop) : 0;
            }
            rafRef.current = requestAnimationFrame(loop);
        }, [pumpStep]);

        const release = useCallback((index: number, w: ControlWidget): void => {
            switch (w.kind) {
                case "button":
                    if (!w.toggle) {
                        presser.set(w.id, w.bind, false);
                        setClass(index, "is-pressed", false);
                    }
                    break;
                case "dpad":
                    applyDirections(w, index, 0, 0, 1, false);
                    break;
                case "stick":
                    if (w.out === "keys") applyDirections(w, index, 0, 0, 1, false);
                    else if (w.out === "pad") {
                        const a = w.axis ?? 0;
                        inputDevice.applyBinding({ t: "axis", axis: a as 0 | 2, value: 0 }, false, "widget");
                        inputDevice.applyBinding({ t: "axis", axis: (a + 1) as 1 | 3, value: 0 }, false, "widget");
                    }
                    setKnob(index, 0, 0);
                    setClass(index, "is-active", false);
                    break;
                case "trackpad":
                case "wheelStrip":
                case "touchArea":
                    break;
            }
        }, [applyDirections, presser]);

        const onDown = useCallback((index: number, w: ControlWidget, c: Contact): void => {
            switch (w.kind) {
                case "button": {
                    if (w.bind.t === "host") {
                        setClass(index, "is-pressed", true);
                        propsRef.current.onHostAction?.(w.bind.action);
                        return;
                    }
                    if (w.toggle) {
                        const next = !presser.isDown(w.id);
                        presser.set(w.id, w.bind, next);
                        setClass(index, "is-on", next);
                    } else {
                        presser.set(w.id, w.bind, true);
                        setClass(index, "is-pressed", true);
                    }
                    break;
                }
                case "dpad": {
                    const { nx, ny } = deflection(index, c, false);
                    applyDirections(w, index, nx, ny, DEFAULT_DEADZONE, w.diagonals !== false);
                    break;
                }
                case "stick": {
                    setClass(index, "is-active", true);
                    if (w.out === "mouse") startPump();
                    break;
                }
                case "trackpad":
                case "wheelStrip":
                case "touchArea":
                    break;
            }
        }, [applyDirections, presser, startPump]);

        const onMove = useCallback((index: number, w: ControlWidget, c: Contact, dx: number, dy: number): void => {
            switch (w.kind) {
                case "button": {
                    if (!w.slide || w.toggle || w.bind.t === "host") return;
                    const o = index * 4;
                    const r = hitRef.current;
                    const inside = c.lastX >= r[o] && c.lastX < r[o] + r[o + 2]
                        && c.lastY >= r[o + 1] && c.lastY < r[o + 1] + r[o + 3];
                    presser.set(w.id, w.bind, inside);
                    setClass(index, "is-pressed", inside);
                    break;
                }
                case "dpad": {
                    const { nx, ny } = deflection(index, c, false);
                    applyDirections(w, index, nx, ny, DEFAULT_DEADZONE, w.diagonals !== false);
                    break;
                }
                case "stick": {
                    const { nx, ny } = deflection(index, c, w.recenter === true);
                    const o = index * 4;
                    setKnob(index, nx * hitRef.current[o + 2] * 0.3, ny * hitRef.current[o + 3] * 0.3);
                    if (w.out === "keys") {
                        applyDirections(w, index, nx, ny, w.deadzone ?? DEFAULT_DEADZONE, true);
                    } else if (w.out === "pad") {
                        const dz = w.deadzone ?? DEFAULT_DEADZONE;
                        const a = w.axis ?? 0;
                        const shape = (v: number): number => (Math.abs(v) < dz ? 0 : v);
                        inputDevice.applyBinding({ t: "axis", axis: a as 0 | 2, value: shape(nx) }, true, "widget");
                        inputDevice.applyBinding({ t: "axis", axis: (a + 1) as 1 | 3, value: shape(ny) }, true, "widget");
                    }
                    break;
                }
                case "trackpad": {
                    const sc = scale();
                    const g = propsRef.current.sensitivity;
                    inputDevice.addPointerRelative(dx * g * sc.x, dy * g * sc.y, dx * g, dy * g);
                    break;
                }
                case "wheelStrip": {
                    const step = w.step ?? 40;
                    c.accum += dy;
                    while (Math.abs(c.accum) >= step) {
                        const dir = c.accum > 0 ? 1 : -1;
                        c.accum -= dir * step;
                        inputDevice.addWheel(dir * WHEEL_NOTCH);
                    }
                    break;
                }
                case "touchArea":
                    break;
            }
        }, [applyDirections, presser]);

        // --- the driver seam -----------------------------------------------

        const hitTest = useCallback((
            clientX: number, clientY: number, pointerId: number, phase: ContactPhase,
        ): boolean => {
            // Every contact reaches here, including the ones the layer declines, so
            // this is the one place that knows the player is still touching anything.
            wake();
            const list = layoutRef.current?.widgets;
            if (!list || list.length === 0) return false;
            const contacts = contactsRef.current;

            if (phase === "down") {
                const i = pickRect(hitRef.current, list.length, clientX, clientY);
                if (i < 0) return false;
                const w = list[i];
                // A touchArea is a declared hole: the translator keeps the contact.
                if (w.kind === "touchArea") return false;
                const c: Contact = {
                    widget: i,
                    startX: clientX, startY: clientY,
                    lastX: clientX, lastY: clientY,
                    originX: clientX, originY: clientY,
                    moved: false, accum: 0,
                };
                contacts.set(pointerId, c);
                onDown(i, w, c);
                presser.commit();
                return true;
            }

            const c = contacts.get(pointerId);
            if (!c) return false;
            const w = list[c.widget];
            if (!w) { contacts.delete(pointerId); return true; }

            if (phase === "move") {
                const dx = clientX - c.lastX;
                const dy = clientY - c.lastY;
                c.lastX = clientX;
                c.lastY = clientY;
                if (!c.moved && Math.hypot(clientX - c.startX, clientY - c.startY) > TAP_SLOP_PX) {
                    c.moved = true;
                }
                onMove(c.widget, w, c, dx, dy);
                presser.commit();
                return true;
            }

            contacts.delete(pointerId);
            // A trackpad tap is the only way to click without a dedicated button, so
            // it must produce a real down/up — the presser's hold floor makes the up
            // late enough for a slow guest poller to observe the press.
            if (phase === "up" && w.kind === "trackpad" && w.taps !== false && !c.moved) {
                presser.set(`${w.id}:tap`, { t: "mouse", button: 0 }, true);
                presser.commit();
                presser.set(`${w.id}:tap`, { t: "mouse", button: 0 }, false);
            }
            release(c.widget, w);
            presser.commit();
            return true;
        }, [onDown, onMove, presser, release, wake]);

        useImperativeHandle(ref, (): TouchControlsHandle => ({
            hitTest,
            refresh: measure,
            releaseAll: (flush = true) => {
                contactsRef.current.clear();
                presser.releaseAll(flush);
            },
        }), [hitTest, measure, presser]);

        if (!layout || widgets.length === 0) return null;

        return (
            <div
                ref={rootRef}
                className={s["touch-controls"]}
                style={{ ["--tc-opacity" as string]: String(clamp(opacity, 0.1, 1)) }}
                aria-hidden
            >
                {widgets.map((w, i) => (
                    <div
                        key={w.id}
                        data-widget-id={w.id}
                        ref={(el) => {
                            elsRef.current[i] = el;
                            knobsRef.current[i] = el?.querySelector<HTMLElement>("[data-knob]") ?? null;
                        }}
                        className={cx(s, "widget", `widget--${w.kind}`)}
                    >
                        <WidgetChrome widget={w} />
                    </div>
                ))}
            </div>
        );
    },
);

const WidgetChrome: React.FC<{ widget: ControlWidget }> = ({ widget }) => {
    switch (widget.kind) {
        case "button":
            return <span className={s["widget__label"]}>{widget.label ?? describeBinding(widget.bind)}</span>;
        case "dpad":
            return (
                <>
                    <span className={cx(s, "dpad__arm", "dpad__arm--v")} />
                    <span className={cx(s, "dpad__arm", "dpad__arm--h")} />
                    <span className={s["dpad__hub"]} />
                </>
            );
        case "stick":
            return <span className={s["stick__knob"]} data-knob />;
        case "wheelStrip":
            return <span className={s["wheel__ridges"]} />;
        case "trackpad":
        case "touchArea":
            return null;
    }
};
