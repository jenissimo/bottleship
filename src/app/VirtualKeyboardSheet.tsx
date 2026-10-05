// On-screen keyboard. Position-fixed, and marked `data-touch-reserved`, so it can be
// mounted anywhere — including inside `.app__panel` — without leaking a contact into
// the guest: the touch driver claims contacts that start under that attribute. Its own
// pointer handlers run too late to route anything (React delegates to the root
// container, the driver listens natively on a descendant).
//
// It synthesizes VK NUMBERS straight through the input device. It is never the
// OS soft keyboard and never a synthetic DOM KeyboardEvent, because App.tsx
// derives its VK as `event.keyCode & 0xff` and Android/iOS IMEs report keyCode
// 229 for nearly every key while frequently omitting keyup — which would jam VK
// 0xE5 down until the next blur.

import React, { useCallback, useEffect, useState } from "react";
import { cx } from "../ui/cx";
import s from "./VirtualKeyboardSheet.module.css";
import { BindingPresser } from "../input/controls/press";

const VK_LSHIFT = 0xa0;
const VK_LCTRL = 0xa2;
const VK_LALT = 0xa4;

/**
 * Modifiers send the L-variants. A guest that consumes lParam scan codes (Unreal's
 * WinDrv, most DirectInput-era engines) gets a real left-hand scan code from
 * these; the side-agnostic 0x10/0x11/0x12 have none.
 */
const MODIFIERS: readonly { vk: number; label: string }[] = [
    { vk: VK_LSHIFT, label: "Shift" },
    { vk: VK_LCTRL, label: "Ctrl" },
    { vk: VK_LALT, label: "Alt" },
];

interface Key {
    vk: number;
    label: string;
    /** Relative width in key units. */
    span?: number;
}

const k = (vk: number, label: string, span?: number): Key => (span ? { vk, label, span } : { vk, label });

const letters = (word: string): Key[] =>
    word.split("").map((ch) => k(ch.charCodeAt(0), ch));

const ESSENTIALS: Key[] = [
    k(0x1b, "Esc"), k(0x09, "Tab"), k(0x0d, "Enter", 1.6), k(0x20, "Space", 2.6),
    k(0x25, "←"), k(0x26, "↑"), k(0x28, "↓"), k(0x27, "→"),
];

const FUNCTION_ROW: Key[] = Array.from({ length: 12 }, (_, i) => k(0x70 + i, `F${i + 1}`));

const QWERTY_ROWS: Key[][] = [
    [
        k(0xc0, "`"), ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => k(d.charCodeAt(0), d)),
        k(0xbd, "-"), k(0xbb, "="), k(0x08, "Bksp", 1.8),
    ],
    [k(0x09, "Tab", 1.4), ...letters("QWERTYUIOP"), k(0xdb, "["), k(0xdd, "]"), k(0xdc, "\\")],
    [k(0x14, "Caps", 1.7), ...letters("ASDFGHJKL"), k(0xba, ";"), k(0xde, "'"), k(0x0d, "Enter", 1.9)],
    [...letters("ZXCVBNM"), k(0xbc, ","), k(0xbe, "."), k(0xbf, "/"), k(0x2e, "Del")],
    [k(0x20, "Space", 6), k(0x25, "←"), k(0x26, "↑"), k(0x28, "↓"), k(0x27, "→")],
];

export interface VirtualKeyboardSheetProps {
    open: boolean;
    onClose: () => void;
}

/** Closing is an UNMOUNT, so no key and no latch can outlive the sheet. */
export const VirtualKeyboardSheet: React.FC<VirtualKeyboardSheetProps> = ({ open, onClose }) =>
    open ? <Sheet onClose={onClose} /> : null;

const Sheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    // Lazy state initializer, not a ref: the presser owns pending release timers
    // and must survive every re-render as the same instance.
    const [presser] = useState(() => new BindingPresser("osk"));

    const [full, setFull] = useState(false);
    const [latched, setLatched] = useState<readonly number[]>([]);

    useEffect(() => () => presser.releaseAll(), [presser]);

    const press = useCallback((vk: number, down: boolean) => {
        presser.set(`k${vk}`, { t: "key", vk }, down);
        presser.commit();
    }, [presser]);

    // Deliberately not a setState updater: the level change is a side effect and a
    // double-invoked updater would flip the latch twice.
    const toggleLatch = useCallback((vk: number) => {
        const on = !latched.includes(vk);
        presser.set(`k${vk}`, { t: "key", vk }, on);
        presser.commit();
        setLatched(on ? [...latched, vk] : latched.filter((v) => v !== vk));
    }, [latched, presser]);

    const stop = (e: React.PointerEvent): void => {
        e.preventDefault();
        e.stopPropagation();
    };

    // Pressed feedback is classList, not state: a keystroke must not re-render the
    // whole sheet while the frame loop is running.
    const lift = (e: React.PointerEvent<HTMLButtonElement>, vk: number): void => {
        stop(e);
        e.currentTarget.classList.remove(s["key--down"]);
        press(vk, false);
    };

    const keyProps = (vk: number) => ({
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
            stop(e);
            e.currentTarget.setPointerCapture?.(e.pointerId);
            e.currentTarget.classList.add(s["key--down"]);
            press(vk, true);
        },
        onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => lift(e, vk),
        onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => lift(e, vk),
        onLostPointerCapture: (e: React.PointerEvent<HTMLButtonElement>) => lift(e, vk),
    });

    const renderKey = (key: Key, i: number): React.ReactElement => (
        <button
            key={`${key.vk}-${i}`}
            type="button"
            className={s["key"]}
            style={key.span ? { flexGrow: key.span, flexBasis: `${key.span * 8}%` } : undefined}
            data-vk={key.vk}
            {...keyProps(key.vk)}
        >
            {key.label}
        </button>
    );

    return (
        <div
            className={s["osk"]}
            data-touch-reserved=""
            onPointerDown={(e) => e.stopPropagation()}
            role="group"
            aria-label="On-screen keyboard"
        >
            <div className={s["osk__bar"]}>
                {ESSENTIALS.map(renderKey)}
                {MODIFIERS.map((m) => (
                    <button
                        key={m.vk}
                        type="button"
                        // Sticky LATCH, not a hold: one thumb cannot chord, and a latch
                        // doubles as "hold Shift to run" — which auto-clearing after one
                        // key would break.
                        className={cx(s, "key", "key--mod", latched.includes(m.vk) && "key--latched")}
                        aria-pressed={latched.includes(m.vk)}
                        onPointerDown={(e) => { stop(e); toggleLatch(m.vk); }}
                    >
                        {m.label}
                    </button>
                ))}
                <button
                    type="button"
                    className={cx(s, "key", "key--util", full && "key--latched")}
                    onPointerDown={(e) => { stop(e); setFull((v) => !v); }}
                >
                    {full ? "Less" : "More"}
                </button>
                <button
                    type="button"
                    className={cx(s, "key", "key--util")}
                    onPointerDown={(e) => { stop(e); onClose(); }}
                    aria-label="Close keyboard"
                >
                    ✕
                </button>
            </div>

            {full && (
                <div className={s["osk__sheet"]}>
                    <div className={s["osk__row"]}>{FUNCTION_ROW.map(renderKey)}</div>
                    {QWERTY_ROWS.map((row, i) => (
                        <div key={i} className={s["osk__row"]}>{row.map(renderKey)}</div>
                    ))}
                </div>
            )}
        </div>
    );
};
