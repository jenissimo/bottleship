// The app-global answer to "what is the player actually holding?".
//
// App-global and persisted because the answer is needed BEFORE a game boots: titles
// of this era enumerate their input devices once at startup, and a latch that only
// listens on the canvas learns the fact one contact too late. The launch tap on the
// library screen is the evidence.
//
// The stored value is the LAST kind, not "has ever been touched" — recency is the
// prior, and the first live event overrides it either way.

export type PointerKind = "mouse" | "touch" | "pen";

const STORAGE_KEY = "bottleship_pointer_kind";

function hydrate(): PointerKind | null {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === "mouse" || v === "touch" || v === "pen" ? v : null;
    } catch {
        return null;
    }
}

let current: PointerKind | null = typeof window === "undefined" ? null : hydrate();
const listeners = new Set<(kind: PointerKind) => void>();

/** Null until anything has been used and nothing was remembered. */
export function getPointerKind(): PointerKind | null {
    return current;
}

/** Listeners fire synchronously, so a handler reading the latch downstream of an
 *  event sees the new value within the same dispatch. */
export function notePointerKind(kind: PointerKind): void {
    if (current === kind) return;
    current = kind;
    try {
        localStorage.setItem(STORAGE_KEY, kind);
    } catch {
        // Private mode / disabled storage: the in-memory latch still works.
    }
    for (const fn of listeners) fn(kind);
}

export function subscribePointerKind(fn: (kind: PointerKind) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** A pointerType we do not recognise is a mouse — that is what the DOM defaults to. */
export function kindOfPointerType(pointerType: string): PointerKind {
    return pointerType === "touch" ? "touch" : pointerType === "pen" ? "pen" : "mouse";
}

/**
 * Feeds the latch from the WHOLE document, so every screen counts — library card,
 * settings drawer, HUD, canvas. Capture phase: a handler that stops propagation
 * (the library's menus do) must not be able to hide the evidence.
 */
export function installPointerKindWatcher(target: EventTarget = document): () => void {
    const onPointer = (event: Event): void => {
        const pe = event as PointerEvent;
        if (typeof pe.pointerType !== "string") return;
        notePointerKind(kindOfPointerType(pe.pointerType));
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    target.addEventListener("pointerdown", onPointer, opts);
    target.addEventListener("pointermove", onPointer, opts);
    return () => {
        target.removeEventListener("pointerdown", onPointer, opts);
        target.removeEventListener("pointermove", onPointer, opts);
    };
}

/** Tests only. */
export function resetPointerKind(): void {
    current = null;
    listeners.clear();
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}
