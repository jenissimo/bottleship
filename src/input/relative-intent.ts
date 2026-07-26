// "The guest wants a relative mouse" — the faithful signal, kept separate from how
// the host delivers it.
//
// Four guest behaviours mean the same thing on real Windows: the cursor is hidden
// (ShowCursor), confined (ClipCursor), owned by an exclusive-mode DirectInput mouse,
// or being re-centred every frame with SetCursorPos. Any of them means the title
// steers by motion rather than position.
//
// The transport is a separate decision: Pointer Lock for a real mouse, finger deltas
// for a touch screen — which has no Pointer Lock at all.

export type RelativeSignal = "cursorHidden" | "clipped" | "captured" | "warping";

type Listener = (active: boolean) => void;

class RelativeIntent {
    private readonly signals: Record<RelativeSignal, boolean> = {
        cursorHidden: false,
        clipped: false,
        captured: false,
        warping: false,
    };
    private active = false;
    private readonly listeners = new Set<Listener>();

    set(signal: RelativeSignal, value: boolean): void {
        if (this.signals[signal] === value) return;
        this.signals[signal] = value;
        const next = this.signals.cursorHidden || this.signals.clipped
            || this.signals.captured || this.signals.warping;
        if (next === this.active) return;
        this.active = next;
        for (const fn of this.listeners) fn(next);
    }

    get(): boolean {
        return this.active;
    }

    /** Which signals are asserting, for diagnostics. */
    reasons(): RelativeSignal[] {
        return (Object.keys(this.signals) as RelativeSignal[]).filter((k) => this.signals[k]);
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    /** Game switch: the next title starts with no relative-mouse claim. */
    reset(): void {
        for (const k of Object.keys(this.signals) as RelativeSignal[]) this.signals[k] = false;
        if (!this.active) return;
        this.active = false;
        for (const fn of this.listeners) fn(false);
    }
}

export const relativeIntent = new RelativeIntent();
