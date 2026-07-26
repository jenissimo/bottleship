// Level bookkeeping for on-screen controls.
//
// Two things every widget and every on-screen key needs, and neither belongs in
// the DOM layer: keyed levels (one entry per widget direction, so a d-pad can
// swap direction without a release/press race) and the minimum-hold floor.
//
// The floor exists because the SAB input record is LEVEL-based with no edge
// queue: a down and an up published inside one guest poll interval cancel out
// and the press is never observed. Same reason the recognizer synthesizes taps
// with TAP_HOLD_MS, and the same reason the harness has `clickHold`.

import type { Binding } from "../bindings";
import { inputDevice, type SourceId } from "../virtual-device";
import { TAP_HOLD_MS } from "../touch/gestures";
import { haptic } from "../haptics";

interface Entry {
    binding: Binding;
    /** Level the caller last asked for; the published level may lag behind it. */
    want: boolean;
    down: boolean;
    at: number;
    timer: ReturnType<typeof setTimeout> | 0;
}

export class BindingPresser {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly source: SourceId) { }

    /**
     * Drive one keyed level. Returns false when the binding is a host action —
     * those never reach the guest and the caller dispatches them itself.
     */
    set(slot: string, binding: Binding, active: boolean): boolean {
        if (binding.t === "host") return false;
        let e = this.entries.get(slot);
        if (!e) {
            if (!active) return true;
            e = { binding, want: false, down: false, at: 0, timer: 0 };
            this.entries.set(slot, e);
        }
        // A direction change is a release of the old level and a press of the new.
        if (e.down && !sameBinding(e.binding, binding)) {
            inputDevice.applyBinding(e.binding, false, this.source);
            e.down = false;
        }
        e.binding = binding;
        e.want = active;

        if (active) {
            if (e.timer) { clearTimeout(e.timer); e.timer = 0; }
            if (!e.down) {
                e.down = true;
                e.at = performance.now();
                inputDevice.applyBinding(binding, true, this.source);
                haptic("press");
            }
            return true;
        }
        if (!e.down || e.timer) return true;
        const remaining = TAP_HOLD_MS - (performance.now() - e.at);
        if (remaining <= 0) {
            e.down = false;
            inputDevice.applyBinding(binding, false, this.source);
            return true;
        }
        e.timer = setTimeout(() => {
            e.timer = 0;
            if (e.want || !e.down) return;
            e.down = false;
            inputDevice.applyBinding(e.binding, false, this.source);
            inputDevice.commit({ immediate: true });
        }, remaining);
        return true;
    }

    isDown(slot: string): boolean {
        return this.entries.get(slot)?.want === true;
    }

    /** Publish everything applied since the last call. */
    commit(): void {
        inputDevice.commit();
    }

    /** Nothing this presser holds may survive a detach, a cancel or a layout swap. */
    releaseAll(): void {
        for (const e of this.entries.values()) {
            if (e.timer) clearTimeout(e.timer);
        }
        this.entries.clear();
        inputDevice.releaseSource(this.source);
        inputDevice.commit({ immediate: true });
    }
}

function sameBinding(a: Binding, b: Binding): boolean {
    if (a.t !== b.t) return false;
    switch (a.t) {
        case "key": return a.vk === (b as { vk: number }).vk;
        case "mouse": return a.button === (b as { button: number }).button;
        case "wheel": return a.delta === (b as { delta: number }).delta;
        case "pad": return a.button === (b as { button: number }).button;
        case "axis": return a.axis === (b as { axis: number }).axis;
        case "host": return a.action === (b as { action: string }).action;
    }
}
