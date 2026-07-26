// Binds touch contacts to the gesture recognizer and forwards its intents to the
// input device. The DOM half of touch input; the recognizer stays pure.
//
// Listeners live on the PANEL, not the canvas: the panel is the common ancestor of
// the canvas and every overlay, so a contact that starts on a control widget and one
// that starts on bare canvas both arrive here and are routed by a hit test. A layer
// root with pointer-events:none is not a hit-test target and would never see the
// second kind at all.

import { inputDevice } from "../virtual-device";
import { relativeIntent } from "../relative-intent";
import { FINGER_OFFSET_Y_PX } from "./gestures";
import {
    createRecognizer,
    isIdle,
    step,
    tick,
    type RecognizerState,
    type TouchEvent2,
    type TouchIntent,
    type TouchMode as RecognizerMode,
} from "./recognizer";
import type { TouchMode } from "../../ui-settings";

export interface TouchSettings {
    touchMode: TouchMode;
    touchSensitivity: number;
    touchLongPressRight: boolean;
    touchCursorAid: boolean;
}

export interface TouchDriverOptions {
    /** Live canvas rect in client coordinates (the letterboxed video area). */
    getCanvasRect: () => DOMRect | null;
    /** Guest-space size the cursor is published in. */
    getPointerSpace: () => { width: number; height: number };
    getSettings: () => TouchSettings;
    /**
     * On-screen controls claim a contact before the translator sees it. Returns true
     * when the widget layer consumed it.
     */
    hitTest?: (clientX: number, clientY: number, pointerId: number, phase: TouchEvent2["phase"]) => boolean;
}

const isTouchLike = (type: string): boolean => type === "touch" || type === "pen";

export class TouchDriver {
    private panel: HTMLElement | null = null;
    private opts: TouchDriverOptions | null = null;
    private recognizer: RecognizerState = createRecognizer({});
    private raf = 0;
    /** Contacts the widget layer owns; the translator must ignore their whole life. */
    private readonly claimed = new Set<number>();
    private active = 0;

    attach(panel: HTMLElement, opts: TouchDriverOptions): () => void {
        this.detach();
        this.panel = panel;
        this.opts = opts;
        panel.addEventListener("pointerdown", this.onDown);
        panel.addEventListener("pointermove", this.onMove);
        panel.addEventListener("pointerup", this.onUp);
        panel.addEventListener("pointercancel", this.onCancel);
        panel.addEventListener("lostpointercapture", this.onCancel);
        return () => this.detach();
    }

    detach(): void {
        const panel = this.panel;
        if (!panel) return;
        panel.removeEventListener("pointerdown", this.onDown);
        panel.removeEventListener("pointermove", this.onMove);
        panel.removeEventListener("pointerup", this.onUp);
        panel.removeEventListener("pointercancel", this.onCancel);
        panel.removeEventListener("lostpointercapture", this.onCancel);
        this.panel = null;
        this.opts = null;
        this.stopPump();
        this.claimed.clear();
        this.active = 0;
        inputDevice.releaseSource("touch");
        inputDevice.commit({ immediate: true });
    }

    /** Effective mode for the next gesture. */
    private modeFor(settings: TouchSettings): RecognizerMode | null {
        switch (settings.touchMode) {
            case "off": return null;
            case "direct": return "direct";
            case "trackpad": return "trackpad";
            case "auto": return relativeIntent.get() ? "trackpad" : "direct";
        }
    }

    private onDown = (event: PointerEvent): void => {
        if (!isTouchLike(event.pointerType)) return;
        const opts = this.opts;
        if (!opts) return;
        if (opts.hitTest?.(event.clientX, event.clientY, event.pointerId, "down")) {
            this.claimed.add(event.pointerId);
            return;
        }
        const settings = opts.getSettings();
        if (this.modeFor(settings) === null) return;
        // Config is latched between gestures: a mid-drag ShowCursor(FALSE) must not
        // change what the finger already on the glass means.
        if (isIdle(this.recognizer)) this.reconfigure(settings);
        this.active++;
        inputDevice.setMouseInside(true, "touch");
        this.feed(event, "down");
        this.startPump();
    };

    private onMove = (event: PointerEvent): void => {
        if (!isTouchLike(event.pointerType)) return;
        if (this.claimed.has(event.pointerId)) {
            this.opts?.hitTest?.(event.clientX, event.clientY, event.pointerId, "move");
            return;
        }
        this.feed(event, "move");
    };

    private onUp = (event: PointerEvent): void => {
        if (!isTouchLike(event.pointerType)) return;
        if (this.claimed.delete(event.pointerId)) {
            this.opts?.hitTest?.(event.clientX, event.clientY, event.pointerId, "up");
            return;
        }
        this.active = Math.max(0, this.active - 1);
        this.feed(event, "up");
    };

    private onCancel = (event: PointerEvent): void => {
        if (!isTouchLike(event.pointerType)) return;
        if (this.claimed.delete(event.pointerId)) {
            this.opts?.hitTest?.(event.clientX, event.clientY, event.pointerId, "cancel");
            return;
        }
        this.active = Math.max(0, this.active - 1);
        this.feed(event, "cancel");
    };

    private reconfigure(settings: TouchSettings): void {
        const mode = this.modeFor(settings);
        if (!mode) return;
        const cfg = this.recognizer.cfg;
        cfg.mode = mode;
        cfg.sensitivity = settings.touchSensitivity;
        cfg.longPressRight = settings.touchLongPressRight;
        cfg.cursorAid = settings.touchCursorAid;
        const space = this.opts?.getPointerSpace() ?? { width: 1, height: 1 };
        cfg.minX = 0;
        cfg.minY = 0;
        cfg.maxX = Math.max(1, space.width) - 1;
        cfg.maxY = Math.max(1, space.height) - 1;
        // The device clamps relative motion against its own bounds, and the mouse path
        // is the only other writer — with no mouse event yet they are still 1x1, which
        // pins a finger-driven cursor at the origin.
        inputDevice.setPointerBounds(space.width, space.height);
        cfg.offsetY = settings.touchCursorAid ? FINGER_OFFSET_Y_PX * this.guestPerCss().y : 0;
    }

    /** Guest pixels per CSS pixel, per axis. */
    private guestPerCss(): { x: number; y: number } {
        const rect = this.opts?.getCanvasRect();
        const space = this.opts?.getPointerSpace();
        if (!rect || !space || rect.width <= 0 || rect.height <= 0) return { x: 1, y: 1 };
        return { x: space.width / rect.width, y: space.height / rect.height };
    }

    private feed(event: PointerEvent, phase: TouchEvent2["phase"]): void {
        const opts = this.opts;
        if (!opts) return;
        const rect = opts.getCanvasRect();
        if (!rect) return;
        const scale = this.guestPerCss();
        const ev: TouchEvent2 = {
            id: event.pointerId,
            phase,
            x: (event.clientX - rect.left) * scale.x,
            y: (event.clientY - rect.top) * scale.y,
        };
        this.emit(step(this.recognizer, ev, event.timeStamp || performance.now()), scale);
    }

    private emit(intents: TouchIntent[], scale: { x: number; y: number }): void {
        if (intents.length === 0) return;
        for (const intent of intents) {
            switch (intent.k) {
                case "cursor":
                    inputDevice.setPointerAbsolute(intent.x, intent.y);
                    break;
                case "delta":
                    // DirectInput wants device deltas, so convert the guest-space motion
                    // back to CSS pixels — otherwise touch and mouse would differ by the
                    // canvas scale factor in the same game.
                    inputDevice.addPointerRelative(
                        intent.dx, intent.dy,
                        intent.dx / (scale.x || 1), intent.dy / (scale.y || 1),
                    );
                    break;
                case "button":
                    // The recognizer speaks DOM button numbering (0 L, 1 M, 2 R); the
                    // device takes 0 L, 1 R, 2 M.
                    inputDevice.setButton(
                        intent.button === 1 ? 2 : intent.button === 2 ? 1 : 0,
                        intent.down, "touch",
                    );
                    break;
                case "wheel":
                    inputDevice.addWheel(intent.delta);
                    break;
            }
        }
        inputDevice.commit();
    }

    // The recognizer has no clock: long presses and the tap-release floor only fire
    // when tick() is driven. Runs while a gesture is live, stops when it drains.
    private startPump(): void {
        if (this.raf) return;
        const pump = (now: number): void => {
            this.raf = 0;
            const scale = this.guestPerCss();
            this.emit(tick(this.recognizer, now), scale);
            if (!isIdle(this.recognizer) || this.active > 0) {
                this.raf = requestAnimationFrame(pump);
            } else {
                inputDevice.setMouseInside(false, "touch");
                inputDevice.commit();
            }
        };
        this.raf = requestAnimationFrame(pump);
    }

    private stopPump(): void {
        if (!this.raf) return;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
    }
}

export const touchDriver = new TouchDriver();
