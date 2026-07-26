// One-time gesture card, shown the first time the touch UI appears.
//
// The vocabulary is not discoverable: nothing on screen says that a long press is
// a right click, that two fingers scroll, or that the corner handle is the menu.
// Shown once per browser, dismissed by touching it, and never again — a hint that
// keeps coming back is worse than none.

import React, { useEffect, useState } from "react";
import s from "./TouchFirstRunHint.module.css";

const SEEN_KEY = "bottleship_touch_hint_v1";

export interface TouchFirstRunHintProps {
    /** The touch UI is on screen; only then does any of this apply. */
    active: boolean;
    /** Relative mode is live, so the finger drives a trackpad, not the cursor. */
    trackpad: boolean;
}

function alreadySeen(): boolean {
    try {
        return localStorage.getItem(SEEN_KEY) === "1";
    } catch {
        // Private mode / blocked storage: showing it every session beats crashing.
        return false;
    }
}

export const TouchFirstRunHint: React.FC<TouchFirstRunHintProps> = ({ active, trackpad }) => {
    const [dismissed, setDismissed] = useState(alreadySeen);

    useEffect(() => {
        if (!active || dismissed) return;
        // Auto-retire it even if untouched: it has been read or it has not.
        const t = window.setTimeout(() => setDismissed(true), 9000);
        return () => window.clearTimeout(t);
    }, [active, dismissed]);

    if (!active || dismissed) return null;

    const dismiss = (): void => {
        setDismissed(true);
        try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* nothing to persist to */ }
    };

    return (
        <div
            className={s["hint"]}
            role="note"
            onPointerDown={(e) => { e.stopPropagation(); dismiss(); }}
        >
            <ul className={s["hint__list"]}>
                <li>{trackpad ? "Drag anywhere to look around" : "Tap to click where you tap"}</li>
                <li>Hold for a right click</li>
                <li>Two fingers to scroll</li>
                <li>Corner button for pause, keyboard and fullscreen</li>
            </ul>
            <span className={s["hint__dismiss"]}>Tap to dismiss</span>
        </div>
    );
};
