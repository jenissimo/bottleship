// Which four keys the movement control (d-pad, or a stick with out:"keys") presses.
//
// A title of this era steers with one of three clusters, and which one is a property of
// its own key table, not of anything we can observe at the API boundary: a game that
// takes WM_KEYDOWN through its window procedure reads no key state at all, so the
// GUEST_POLLED_KEYS signal the auto-picker relies on stays empty. Hitman: Codename 47
// is the canonical case — it walks on Numpad 8/2/4/6, the arrows are bound to nothing,
// and a WASD stick is a stick that does nothing. So the cluster is a per-game CHOICE
// (bundle manifest, or the player from the HUD), applied to whatever layout is live.
//
// Pure data; no DOM.

import type { Binding } from "../bindings";
import type { ControlLayout, ControlWidget, DirBindings } from "./types";

export type MoveKeys = "wasd" | "arrows" | "numpad";

export const MOVE_KEYS: readonly MoveKeys[] = ["wasd", "arrows", "numpad"];

export const isMoveKeys = (x: unknown): x is MoveKeys =>
    typeof x === "string" && (MOVE_KEYS as readonly string[]).includes(x);

const key = (vk: number): Binding => ({ t: "key", vk });

/**
 * The VKs themselves. The worker turns each into the scan code and extended flag a
 * real keyboard reports (arrows: E0 48/50/4B/4D, bit 24 set; numpad: bare 48/50/4B/4D
 * with NumLock on), and DirectInput into DIK_UP=0xC8… / DIK_NUMPAD8=0x48…, so the
 * three clusters are three different physical keys to the guest, as they should be.
 */
export const MOVE_KEY_SETS: Readonly<Record<MoveKeys, DirBindings>> = {
    wasd: { up: key(0x57), down: key(0x53), left: key(0x41), right: key(0x44) },
    arrows: { up: key(0x26), down: key(0x28), left: key(0x25), right: key(0x27) },
    numpad: { up: key(0x68), down: key(0x62), left: key(0x64), right: key(0x66) },
};

/** Short label for the HUD. */
export const MOVE_KEYS_LABEL: Readonly<Record<MoveKeys, string>> = {
    wasd: "WASD",
    arrows: "Arrows",
    numpad: "Numpad",
};

const vkOf = (b: Binding): number => (b.t === "key" ? b.vk : -1);

/** Which known cluster a direction set is, or null for a custom one. */
export function moveKeysOf(binds: DirBindings | undefined): MoveKeys | null {
    if (!binds) return null;
    for (const k of MOVE_KEYS) {
        const set = MOVE_KEY_SETS[k];
        if (vkOf(binds.up) === vkOf(set.up) && vkOf(binds.down) === vkOf(set.down)
            && vkOf(binds.left) === vkOf(set.left) && vkOf(binds.right) === vkOf(set.right)) {
            return k;
        }
    }
    return null;
}

function retarget(w: ControlWidget, keys: MoveKeys): ControlWidget {
    if (w.kind === "dpad" || (w.kind === "stick" && w.out === "keys")) {
        // Only a KNOWN cluster is rewritten: an author who bound the d-pad to I/J/K/L
        // meant exactly that, and a global choice must not silently undo it.
        if (moveKeysOf(w.binds) === null || moveKeysOf(w.binds) === keys) return w;
        return { ...w, binds: MOVE_KEY_SETS[keys] };
    }
    return w;
}

/** The layout with every known movement cluster pointed at `keys`. Identity when nothing changes. */
export function withMoveKeys(layout: ControlLayout, keys: MoveKeys | null | undefined): ControlLayout {
    if (!keys) return layout;
    let changed = false;
    const widgets = layout.widgets.map((w) => {
        const next = retarget(w, keys);
        if (next !== w) changed = true;
        return next;
    });
    return changed ? { ...layout, widgets } : layout;
}

/** The cluster a layout steers with — the first movement widget's — or null. */
export function layoutMoveKeys(layout: ControlLayout | null): MoveKeys | null {
    for (const w of layout?.widgets ?? []) {
        if (w.kind === "dpad" || (w.kind === "stick" && w.out === "keys")) return moveKeysOf(w.binds);
    }
    return null;
}
