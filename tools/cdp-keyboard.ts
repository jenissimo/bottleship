/**
 * cdp-keyboard.ts — a key press that travels the BROWSER's own input stack.
 *
 * `key`/`keyHold` write the SAB key bitfield from inside the worker and skip the page:
 * the window keydown listener, the KeyboardEvent → VK translation, the virtual-device
 * composition. The on-screen controls publish through that same composer, so this verb
 * is the physical-keyboard baseline a touch control is compared against: if the guest
 * reacts to `hostKey('ArrowUp')` and not to the on-screen Up, the bug is in front of
 * the composer; if it reacts to neither, it is between the SAB and the guest.
 */

import type { CdpSession } from "./cdp-core";

interface KeyDef { key: string; code: string; keyCode: number; location?: number; text?: string }

/** The keys a control layout can bind, by DOM `code`. `key`/`keyCode` follow a US layout. */
const KEYS: Record<string, KeyDef> = {
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
    ShiftLeft: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
    ControlLeft: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
    AltLeft: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Numpad8: { key: "8", code: "Numpad8", keyCode: 104, location: 3 },
    Numpad2: { key: "2", code: "Numpad2", keyCode: 98, location: 3 },
    Numpad4: { key: "4", code: "Numpad4", keyCode: 100, location: 3 },
    Numpad6: { key: "6", code: "Numpad6", keyCode: 102, location: 3 },
};

function resolveKey(name: string): KeyDef {
    const k = KEYS[name];
    if (k) return k;
    if (/^Key[A-Z]$/.test(name)) {
        const ch = name.slice(3);
        return { key: ch.toLowerCase(), code: name, keyCode: ch.charCodeAt(0), text: ch.toLowerCase() };
    }
    if (/^Digit[0-9]$/.test(name)) {
        const ch = name.slice(5);
        return { key: ch, code: name, keyCode: ch.charCodeAt(0), text: ch };
    }
    throw new Error(`hostKey: unknown key code '${name}' (use DOM codes: ArrowUp, KeyW, Space, ...)`);
}

/** Press `code`, hold it for `holdMs` of real time (with no auto-repeat), release. */
export async function hostKey(session: CdpSession, code: string, holdMs = 300): Promise<{ code: string; keyCode: number; holdMs: number; ms: number }> {
    const k = resolveKey(code);
    const t0 = Date.now();
    await session.send("Page.bringToFront").catch(() => { /* detached */ });
    const base = {
        key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
        location: k.location ?? 0,
    };
    await session.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await Bun.sleep(Math.max(0, holdMs));
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return { code: k.code, keyCode: k.keyCode, holdMs, ms: Date.now() - t0 };
}
