// Touch HUD — the only always-reachable shell affordance on a keyboard-less device.
// Actions only; the touch MODE lives in Settings > Input. Its pointer handlers stop
// propagation, so the touch driver never sees a HUD tap.
//
// A 44x44 corner handle rather than an edge swipe: an edge swipe collides with the
// Android back gesture and the notification shade, and a page cannot win that.
//
// Every entry is a {t:"host"} binding — the same union a widget uses — so the HUD,
// an on-screen button and a hotkey resolve to one action, handled by the host.

import React, { useCallback, useState } from "react";
import { cx } from "../ui/cx";
import s from "./TouchHud.module.css";
import type { Binding, HostAction } from "../input/bindings";

const ACTION_LABEL: Record<HostAction, string> = {
    pause: "Pause",
    keyboard: "Keyboard",
    fullscreen: "Immersive",
    releaseRelative: "Release mouse",
    toggleControls: "Controls on/off",
    editLayout: "Edit controls",
};

const DEFAULT_ACTIONS: readonly HostAction[] = [
    "pause", "keyboard", "fullscreen", "releaseRelative", "toggleControls",
];

export interface TouchHudProps {
    /** Which entries the shell can actually service. */
    actions?: readonly HostAction[];
    onHostAction: (action: HostAction) => void;
    corner?: "tl" | "tr" | "bl" | "br";
}

export const TouchHud: React.FC<TouchHudProps> = ({
    actions = DEFAULT_ACTIONS,
    onHostAction,
    corner = "tr",
}) => {
    const [open, setOpen] = useState(false);

    const stop = useCallback((e: React.PointerEvent): void => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const fire = useCallback((binding: Binding): void => {
        if (binding.t !== "host") return;
        setOpen(false);
        onHostAction(binding.action);
    }, [onHostAction]);

    return (
        <div
            className={cx(s, "hud", `hud--${corner}`, open && "hud--open")}
            data-touch-reserved=""
            onPointerDown={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                className={s["hud__handle"]}
                aria-expanded={open}
                aria-label="Game menu"
                onPointerDown={(e) => { stop(e); setOpen((v) => !v); }}
            >
                <span className={s["hud__dots"]} aria-hidden />
            </button>

            {open && (
                <div className={s["hud__menu"]} role="menu">
                    {actions.map((action) => (
                        <button
                            key={action}
                            type="button"
                            role="menuitem"
                            className={s["hud__item"]}
                            onPointerDown={(e) => { stop(e); fire({ t: "host", action }); }}
                        >
                            {ACTION_LABEL[action]}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
