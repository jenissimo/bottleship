// Touch HUD — the only always-reachable shell affordance on a keyboard-less device.
// Actions, plus the two choices a player needs mid-game without leaving it: WHICH
// control scheme (pointer / stick+look / d-pad / pad) and which keys the movement
// control presses. The touch MODE itself still lives in Settings > Input. `data-touch-reserved` is what
// keeps a HUD tap out of the guest: the touch driver claims any contact that starts
// under it. A React handler cannot do that — React delegates to the root container, so
// the driver's native listener on the panel has already run by then.
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
import { MOVE_KEYS, MOVE_KEYS_LABEL, type MoveKeys } from "../input/controls/move-keys";

/** The schemes the HUD offers, in the order a player scans them. */
export const HUD_SCHEMES: readonly { id: string; label: string }[] = [
    { id: "pointer", label: "Pointer" },
    { id: "wasd-look", label: "Stick+Look" },
    { id: "dpad-buttons", label: "D-pad" },
    { id: "pad", label: "Gamepad" },
];

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
    /** The live scheme's preset id; "" for an authored layout. Omit to hide the group. */
    scheme?: string;
    onScheme?: (presetId: string) => void;
    /** null when the live layout has no key-driven movement control. */
    moveKeys?: MoveKeys | null;
    onMoveKeys?: (keys: MoveKeys) => void;
    /** The panel covers the whole screen (immersive): keep the safe-area corner. */
    edgeToEdge?: boolean;
}

export const TouchHud: React.FC<TouchHudProps> = ({
    actions = DEFAULT_ACTIONS,
    onHostAction,
    corner = "tr",
    scheme,
    onScheme,
    moveKeys,
    onMoveKeys,
    edgeToEdge = false,
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
            data-edge={edgeToEdge ? "" : undefined}
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
                    {onScheme && scheme !== undefined && (
                        <div className={s["hud__group"]} role="group" aria-label="Controls">
                            <span className={s["hud__group-label"]}>Controls</span>
                            <div className={cx(s, "hud__segments", "hud__segments--wrap")}>
                                {HUD_SCHEMES.map((o) => (
                                    <button
                                        key={o.id}
                                        type="button"
                                        aria-pressed={scheme === o.id}
                                        className={cx(s, "hud__segment", scheme === o.id && "is-on")}
                                        onPointerDown={(e) => { stop(e); setOpen(false); onScheme(o.id); }}
                                    >
                                        {o.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {onMoveKeys && moveKeys !== undefined && moveKeys !== null && (
                        <div className={s["hud__group"]} role="group" aria-label="Movement keys">
                            <span className={s["hud__group-label"]}>Move with</span>
                            <div className={s["hud__segments"]}>
                                {MOVE_KEYS.map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        aria-pressed={moveKeys === k}
                                        className={cx(s, "hud__segment", moveKeys === k && "is-on")}
                                        onPointerDown={(e) => { stop(e); setOpen(false); onMoveKeys(k); }}
                                    >
                                        {MOVE_KEYS_LABEL[k]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
