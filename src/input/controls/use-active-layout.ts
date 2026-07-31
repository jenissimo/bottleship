// Resolves WHICH on-screen control layout is live, so App.tsx only has to render it.
//
// The layout is chosen from what the program DOES, never from what it is: the guest's
// relative-mouse intent, whether it polls a joystick, and which VKs it has actually
// observed as pressed. All three are properties visible at our own API boundary, so a
// title nobody has ever run gets a sane layout on its first boot.

import { useEffect, useMemo, useRef, useState } from "react";
import {
    GUEST_POLLED_KEYS_BASE,
    GUEST_POLLED_KEYS_COUNT,
    GUEST_INPUT_FLAG,
    INPUT_INDEX,
} from "../sab-layout";
import { relativeIntent } from "../relative-intent";
import {
    newPadPollTracker,
    notePadPoll,
    padIsSteering,
    pickPreset,
    shouldLatchAutoPreset,
    type PadPollTracker,
} from "../auto-select";
import {
    isPinned,
    loadGlobalDefault,
    loadLayout,
    resolveActiveLayout,
    type StoredLayout,
    type TouchModePref,
} from "../layout-store";
import { getPreset } from "./presets";
import { validateLayout, type ControlLayout } from "./types";

/** `emulator.touch` as delivered by bundle_meta. */
export interface ManifestTouch {
    layout?: string | Record<string, unknown>;
    mode?: TouchModePref;
}

export interface ActiveLayout {
    layout: ControlLayout | null;
    mode: TouchModePref;
    /** Which tier decided, for the settings UI and diagnostics. */
    tier: string;
}

/** Signals are cheap to read but pointless to poll faster than a person can notice. */
const DEBOUNCE_MS = 500;

function manifestTier(touch: ManifestTouch | null): StoredLayout<ControlLayout> | null {
    if (!touch) return null;
    const out: StoredLayout<ControlLayout> = {};
    if (typeof touch.layout === "string") out.presetId = touch.layout;
    else if (touch.layout) {
        const parsed = validateLayout(touch.layout);
        if (parsed) out.layout = parsed;
    }
    if (touch.mode) out.mode = touch.mode;
    return out.presetId || out.layout || out.mode ? out : null;
}

export function useActiveLayout(
    gameId: string | null,
    manifestTouch: ManifestTouch | null,
    getInputView: () => Int32Array | null,
    enabled: boolean,
): ActiveLayout {
    // Keyed by the game it was picked for, so a game switch discards it during
    // render instead of through an effect that would publish one stale frame first.
    const [pick, setPick] = useState<{ id: string | null; value: StoredLayout<ControlLayout> | null }>(
        { id: null, value: null },
    );
    const autoPick = pick.id === gameId ? pick.value : null;

    const [orientation, setOrientation] = useState<"landscape" | "portrait">(
        typeof window !== "undefined" && window.innerHeight > window.innerWidth ? "portrait" : "landscape",
    );

    useEffect(() => {
        const onResize = () =>
            setOrientation(window.innerHeight > window.innerWidth ? "portrait" : "landscape");
        window.addEventListener("resize", onResize);
        window.visualViewport?.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            window.visualViewport?.removeEventListener("resize", onResize);
        };
    }, []);

    // Read through a ref, NOT from the deps: callers pass an inline arrow, so a dep would
    // rebuild the interval on every parent re-render and reset `fired`/`padPolls` with it.
    // During boot those re-renders arrive faster than DEBOUNCE_MS, so the pick never fired
    // at all, and readsPad — which needs PAD_POLL_WINDOWS separate observations — could
    // never latch.
    const getInputViewRef = useRef(getInputView);
    useEffect(() => { getInputViewRef.current = getInputView; }, [getInputView]);

    // Orientation is read the same way and for the same reason: a rotation (or any
    // visualViewport resize that flips the aspect) would otherwise rebuild the interval
    // and reset the one-shot latch with it — re-running auto-select mid-session and
    // swapping the whole layout under the player's thumbs.
    const orientationRef = useRef(orientation);
    orientationRef.current = orientation;

    useEffect(() => {
        if (!enabled || isPinned(gameId)) return;
        // Sticky per game: presets are supersets (wasd-look still taps fine in a menu),
        // so one visible transition is the budget — re-picking on every signal change
        // would make the overlay flicker while a title boots. The effect is recreated
        // per gameId, so a local is exactly the right scope for "already fired".
        let fired = false;
        let lastSeq = -1;
        let padPolls: PadPollTracker = newPadPollTracker();
        const timer = window.setInterval(() => {
            const view = getInputViewRef.current();
            if (!view) return;
            const seq = Atomics.load(view, INPUT_INDEX.guestInputSeq);
            const padSeq = Atomics.load(view, INPUT_INDEX.guestGamepadSeq);
            const relative = relativeIntent.get();
            padPolls = notePadPoll(padPolls, padSeq);
            if (seq === lastSeq && padSeq === 0 && !relative) return;
            lastSeq = seq;

            const polled = new Int32Array(GUEST_POLLED_KEYS_COUNT);
            for (let w = 0; w < GUEST_POLLED_KEYS_COUNT; w++) polled[w] = view[GUEST_POLLED_KEYS_BASE + w];
            const flags = view[INPUT_INDEX.guestInputFlags];

            const picked = pickPreset({
                relativeMouse: relative,
                readsPad: padIsSteering(padPolls),
                polledVks: polled,
                bulkKeyboard: (flags & (GUEST_INPUT_FLAG.bulkKeyboard | GUEST_INPUT_FLAG.dinputKeyboard)) !== 0,
                orientation: orientationRef.current,
            });
            if (!shouldLatchAutoPreset(picked)) return;
            if (fired) return;
            fired = true;
            setPick({ id: gameId, value: { presetId: picked.presetId, mode: picked.mode } });
        }, DEBOUNCE_MS);
        return () => window.clearInterval(timer);
    }, [enabled, gameId]);

    return useMemo(() => {
        const resolved = resolveActiveLayout<ControlLayout>({
            userOverride: loadLayout<ControlLayout>(gameId, validateLayout),
            globalDefault: loadGlobalDefault<ControlLayout>(validateLayout),
            manifest: manifestTier(manifestTouch),
            autoPick,
        });
        return {
            layout: resolved.layout ?? getPreset(resolved.presetId, orientation),
            mode: resolved.mode,
            tier: resolved.tier,
        };
    }, [gameId, manifestTouch, autoPick, orientation]);
}
