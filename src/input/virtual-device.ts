// The single writer of the host→worker input record.
//
// Every producer — hardware mouse, hardware keyboard, hardware gamepad, touch
// gestures, on-screen widgets, replay — is a tagged SOURCE, and the published
// state is the composition of all of them. That is the whole point: the SAB slots
// are LEVELS, so any producer that writes a slot wholesale erases what another one
// was holding. A virtual key would die on the next physical keystroke, a virtual
// stick on the next gamepad poll, a contact-derived button mask on the next
// PointerEvent (whose `buttons` is always 1 for touch).
//
// Composition also makes release structural: releaseSource() recomputes the world
// without that producer, so a cancelled touch or a lost focus cannot leave a key
// or a button latched down.

import {
    INPUT_INDEX,
    KEY_BITFIELD_BASE,
    KEY_BITFIELD_COUNT,
    beginInputWrite,
    endInputWrite,
} from "./sab-layout";
import type { Binding } from "./bindings";

export type SourceId =
    | "hw-mouse"
    | "hw-key"
    | "hw-pad"
    | "touch"
    | "widget"
    | "osk"
    | "replay";

const SOURCE_IDS: readonly SourceId[] = [
    "hw-mouse", "hw-key", "hw-pad", "touch", "widget", "osk", "replay",
];

export interface PadState {
    connected: boolean;
    buttons: number;
    axes: readonly [number, number, number, number];
}

interface SourceSlot {
    keys: Int32Array;
    /** Browser button flags: left=1, right=2, middle=4. */
    buttons: number;
    mouseInside: boolean;
    /** False until the source publishes pad state, so it contributes nothing. */
    padActive: boolean;
    pad: PadState;
}

function createSlot(): SourceSlot {
    return {
        keys: new Int32Array(KEY_BITFIELD_COUNT),
        buttons: 0,
        mouseInside: false,
        padActive: false,
        pad: { connected: false, buttons: 0, axes: [0, 0, 0, 0] },
    };
}

export interface CommitOptions {
    /** Publish synchronously instead of coalescing into the next frame. */
    immediate?: boolean;
}

export class VirtualInputDevice {
    private view: Int32Array | null = null;
    private notify: (() => void) | null = null;

    private readonly sources = new Map<SourceId, SourceSlot>();
    private readonly composedKeys = new Int32Array(KEY_BITFIELD_COUNT);

    /** Virtual cursor in guest space; the single owner of the published position. */
    private cursorX = 0;
    private cursorY = 0;
    private boundsW = 1;
    private boundsH = 1;

    private pendingFlush = 0;
    private dirty = false;
    /** A level (key/button/pad) changed — see commit(). */
    private dirtyEdge = false;

    constructor() {
        for (const id of SOURCE_IDS) this.sources.set(id, createSlot());
    }

    /** Bind to the SAB. `notify` pokes the worker that a new record is published. */
    attach(view: Int32Array, notify: () => void): void {
        this.view = view;
        this.notify = notify;
    }

    /** Clamp box for relative motion, in the same space the cursor is published in. */
    setPointerBounds(width: number, height: number): void {
        this.boundsW = Math.max(1, width);
        this.boundsH = Math.max(1, height);
    }

    getCursor(): { x: number; y: number } {
        return { x: this.cursorX, y: this.cursorY };
    }

    private slot(source: SourceId): SourceSlot {
        let s = this.sources.get(source);
        if (!s) {
            s = createSlot();
            this.sources.set(source, s);
        }
        return s;
    }

    // --- producers ---------------------------------------------------------

    /**
     * Apply a binding as a LEVEL for `source`. Returns false for host actions,
     * which the shell handles instead of the guest.
     */
    applyBinding(binding: Binding, active: boolean, source: SourceId): boolean {
        switch (binding.t) {
            case "key":
                this.setKey(binding.vk, active, source);
                return true;
            case "mouse":
                this.setButton(binding.button, active, source);
                return true;
            case "wheel":
                // Edge, not a level: a wheel notch has no "held" state.
                if (active) this.addWheel(binding.delta);
                return true;
            case "pad": {
                const s = this.slot(source);
                const mask = 1 << binding.button;
                const next = active ? (s.pad.buttons | mask) : (s.pad.buttons & ~mask);
                this.publishPad({ connected: true, buttons: next, axes: s.pad.axes }, source);
                return true;
            }
            case "axis": {
                const s = this.slot(source);
                const axes: [number, number, number, number] = [...s.pad.axes];
                axes[binding.axis] = active ? Math.round(binding.value * 32767) : 0;
                this.publishPad({ connected: true, buttons: s.pad.buttons, axes }, source);
                return true;
            }
            case "host":
                return false;
        }
    }

    setKey(vk: number, down: boolean, source: SourceId): void {
        if (vk < 0 || vk > 0xff) return;
        const s = this.slot(source);
        const word = vk >> 5;
        const bit = 1 << (vk & 31);
        const next = down ? (s.keys[word] | bit) : (s.keys[word] & ~bit);
        if (next === s.keys[word]) return;
        s.keys[word] = next;
        this.dirty = true;
        this.dirtyEdge = true;
    }

    /** button: 0=left, 1=right, 2=middle. */
    setButton(button: 0 | 1 | 2, down: boolean, source: SourceId): void {
        const mask = button === 1 ? 2 : button === 2 ? 4 : 1;
        const s = this.slot(source);
        const next = down ? (s.buttons | mask) : (s.buttons & ~mask);
        if (next === s.buttons) return;
        s.buttons = next;
        this.dirty = true;
        this.dirtyEdge = true;
    }

    /** Whole browser-flag mask at once (a real PointerEvent reports it wholesale). */
    setButtonsMask(mask: number, source: SourceId): void {
        const s = this.slot(source);
        const next = mask & 7;
        if (next === s.buttons) return;
        s.buttons = next;
        this.dirty = true;
        this.dirtyEdge = true;
    }

    setMouseInside(inside: boolean, source: SourceId): void {
        const s = this.slot(source);
        if (s.mouseInside === inside) return;
        s.mouseInside = inside;
        this.dirty = true;
        this.dirtyEdge = true;
    }

    publishPad(state: PadState, source: SourceId): void {
        const s = this.slot(source);
        s.padActive = true;
        s.pad = { connected: state.connected, buttons: state.buttons, axes: [...state.axes] };
        this.dirty = true;
        this.dirtyEdge = true;
    }

    setPointerAbsolute(x: number, y: number): void {
        const nx = Math.max(0, Math.min(this.boundsW, x));
        const ny = Math.max(0, Math.min(this.boundsH, y));
        if (nx === this.cursorX && ny === this.cursorY) return;
        this.cursorX = nx;
        this.cursorY = ny;
        this.dirty = true;
    }

    /**
     * Relative motion. Advances the clamped virtual cursor AND feeds the DirectInput
     * accumulators with the RAW delta — DInput reports device deltas, not screen
     * ones, so these two must not share a scale factor. The accumulators are
     * independent atomic counters (the worker drains them with Atomics.exchange),
     * so they are added at once rather than on flush: a coalesced or dropped frame
     * must never swallow motion the guest has not read yet.
     */
    addPointerRelative(dx: number, dy: number, rawDx = dx, rawDy = dy): void {
        this.cursorX = Math.max(0, Math.min(this.boundsW - 1, this.cursorX + dx));
        this.cursorY = Math.max(0, Math.min(this.boundsH - 1, this.cursorY + dy));
        const view = this.view;
        if (view) {
            Atomics.add(view, INPUT_INDEX.dinputDX, Math.round(rawDx));
            Atomics.add(view, INPUT_INDEX.dinputDY, Math.round(rawDy));
        }
        this.dirty = true;
    }

    /**
     * Wheel delta in browser pixels. Accumulated, never assigned: the worker
     * consumes this slot destructively, so an overwrite drops every notch but the
     * last one that happened between two polls.
     */
    addWheel(delta: number): void {
        const view = this.view;
        if (!view) return;
        Atomics.add(view, INPUT_INDEX.mouseWheel, Math.round(delta));
        this.dirty = true;
    }

    // --- release -----------------------------------------------------------

    /** Drop everything `source` holds. Its levels stop contributing to the mix. */
    releaseSource(source: SourceId): void {
        const s = this.sources.get(source);
        if (!s) return;
        s.keys.fill(0);
        s.buttons = 0;
        s.mouseInside = false;
        s.padActive = false;
        s.pad = { connected: false, buttons: 0, axes: [0, 0, 0, 0] };
        this.dirty = true;
        this.dirtyEdge = true;
    }

    /** Focus loss, tab hide, game switch: nothing may survive into the next context. */
    releaseAllSources(): void {
        for (const id of this.sources.keys()) this.releaseSource(id);
    }

    // --- publication -------------------------------------------------------

    /**
     * Publish if anything changed. Key and button EDGES flush synchronously — a
     * level transport has no queue, so an edge that is coalesced away with its
     * inverse is an input the guest never sees. Pure motion coalesces into the next
     * frame: on a 120 Hz screen with several contacts that removes most of the
     * postMessage traffic aimed at a worker sitting inside multi-ms JIT blocks.
     */
    commit(opts?: CommitOptions): void {
        if (!this.dirty) return;
        if (opts?.immediate || this.dirtyEdge || typeof requestAnimationFrame !== "function") {
            this.flush();
            return;
        }
        if (this.pendingFlush) return;
        this.pendingFlush = requestAnimationFrame(() => {
            this.pendingFlush = 0;
            this.flush();
        });
    }

    /** Publish now, edge or not. */
    commitNow(): void {
        this.commit({ immediate: true });
    }

    private flush(): void {
        const view = this.view;
        if (!view) {
            this.dirty = false;
            this.dirtyEdge = false;
            return;
        }
        if (this.pendingFlush) {
            cancelAnimationFrame(this.pendingFlush);
            this.pendingFlush = 0;
        }

        // Compose from scratch every time: 7 sources x 8 words is nothing, and it
        // makes incremental-bookkeeping drift impossible by construction.
        this.composedKeys.fill(0);
        let buttons = 0;
        let inside = false;
        let padConnected = false;
        let padButtons = 0;
        const axes: [number, number, number, number] = [0, 0, 0, 0];

        for (const s of this.sources.values()) {
            for (let w = 0; w < KEY_BITFIELD_COUNT; w++) this.composedKeys[w] |= s.keys[w];
            buttons |= s.buttons;
            inside = inside || s.mouseInside;
            if (!s.padActive) continue;
            padConnected = padConnected || s.pad.connected;
            padButtons |= s.pad.buttons;
            for (let a = 0; a < 4; a++) {
                // Larger deflection wins, so a physical stick at rest cannot cancel a
                // virtual one (and vice versa) while both are publishing.
                if (Math.abs(s.pad.axes[a]) > Math.abs(axes[a])) axes[a] = s.pad.axes[a];
            }
        }

        beginInputWrite(view);
        view[INPUT_INDEX.mouseX] = Math.round(this.cursorX);
        view[INPUT_INDEX.mouseY] = Math.round(this.cursorY);
        view[INPUT_INDEX.buttons] = buttons;
        view[INPUT_INDEX.mouseInside] = inside ? 1 : 0;
        view[INPUT_INDEX.gamepadConnected] = padConnected ? 1 : 0;
        view[INPUT_INDEX.gamepadButtons] = padButtons;
        view[INPUT_INDEX.gamepadAxis0] = axes[0];
        view[INPUT_INDEX.gamepadAxis1] = axes[1];
        view[INPUT_INDEX.gamepadAxis2] = axes[2];
        view[INPUT_INDEX.gamepadAxis3] = axes[3];
        for (let w = 0; w < KEY_BITFIELD_COUNT; w++) {
            view[KEY_BITFIELD_BASE + w] = this.composedKeys[w];
        }
        endInputWrite(view);

        this.dirty = false;
        this.dirtyEdge = false;
        this.notify?.();
    }

    /** Test/diagnostic view of what the last flush published. */
    snapshot(): {
        keys: Int32Array; buttons: number; inside: boolean;
        padConnected: boolean; padButtons: number; axes: [number, number, number, number];
        cursor: { x: number; y: number };
    } {
        this.flush();
        const view = this.view;
        const keys = new Int32Array(KEY_BITFIELD_COUNT);
        if (view) for (let w = 0; w < KEY_BITFIELD_COUNT; w++) keys[w] = view[KEY_BITFIELD_BASE + w];
        return {
            keys,
            buttons: view ? view[INPUT_INDEX.buttons] : 0,
            inside: view ? view[INPUT_INDEX.mouseInside] !== 0 : false,
            padConnected: view ? view[INPUT_INDEX.gamepadConnected] === 1 : false,
            padButtons: view ? view[INPUT_INDEX.gamepadButtons] : 0,
            axes: view
                ? [
                    view[INPUT_INDEX.gamepadAxis0], view[INPUT_INDEX.gamepadAxis1],
                    view[INPUT_INDEX.gamepadAxis2], view[INPUT_INDEX.gamepadAxis3],
                ]
                : [0, 0, 0, 0],
            cursor: { x: this.cursorX, y: this.cursorY },
        };
    }
}

/** The host has exactly one input record, so exactly one device writes it. */
export const inputDevice = new VirtualInputDevice();
