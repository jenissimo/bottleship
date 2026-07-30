/**
 * Harness-local dialog helpers. Self-contained equivalents of the
 * dbg-commands dlg helpers, depending only on the exported user32 `windows` map +
 * getAbsoluteWindowPosition — so the harness owns its dialog resolution and does
 * not reach into the debug console module. GLOBAL/screen coords throughout.
 */

import { windows, getAbsoluteWindowPosition, type WindowInfo } from "../modules/user32/shared-state";
import { HarnessError, HarnessErrorCode } from "./rpc";

/** One described control/window with GLOBAL rect + click center. */
export interface DlgControlInfo {
    hwnd: number;
    id: number | null;
    title: string;
    cls: string;
    x: number; y: number; w: number; h: number;
    cx: number; cy: number;
    visible: boolean;
    customPaint: boolean;
}

export function describeDlgControl(hwnd: number, w: WindowInfo): DlgControlInfo {
    const abs = getAbsoluteWindowPosition(w);
    const width = w.width ?? 0, height = w.height ?? 0;
    return {
        hwnd,
        id: w.controlId ?? null,
        title: w.title ?? "",
        cls: w.systemControlClass || w.nativeClassName || (w.children?.length ? "window" : ""),
        x: abs.x, y: abs.y, w: width, h: height,
        cx: abs.x + (width >> 1), cy: abs.y + (height >> 1),
        visible: !!w.visible,
        customPaint: !!w.guestCustomPaint,
    };
}

/** Classes a click can actually do something with. A Static whose text merely
 *  MENTIONS a button ("To Play … click on New Game") is not the button. */
const CLICKABLE_CLASSES = new Set(["button", "combobox", "listbox", "edit",
    "msctls_trackbar32", "scrollbar"]);

function isClickable(w: WindowInfo): boolean {
    return CLICKABLE_CLASSES.has((w.systemControlClass ?? "").trim().toLowerCase());
}

/** Title as a user reads it off the screen: mnemonic '&' collapsed, trimmed. */
function labelOf(w: WindowInfo): string {
    return (w.title ?? "").replace(/&(.)/g, "$1").trim().toLowerCase();
}

/** An ambiguous label is a bug in the script, not something to resolve by taking
 *  whichever candidate the window map happens to yield first. */
function ambiguous(needle: string, hits: Array<{ hwnd: number; win: WindowInfo }>): HarnessError {
    return new HarnessError(
        `ambiguous control label ${JSON.stringify(needle)} — ${hits.length} matches: ` +
        hits.map(({ hwnd, win }) =>
            `0x${hwnd.toString(16)} ${win.systemControlClass || win.nativeClassName || "window"} ` +
            `"${win.title ?? ""}"${win.visible ? "" : " (hidden)"}`).join("; ") +
        ". Pass an hwnd or control id instead.",
        HarnessErrorCode.BAD_ARGS,
    );
}

/**
 * Resolve a target: HWND or control id (number), or a title (string).
 *
 * Title matching is RANKED, not first-hit: a clickable class beats a Static, an
 * exact label beats a substring, visible beats hidden. Within the winning tier more
 * than one candidate is an error — silently taking the first one is how
 * `.click("New Game")` ended up on the Static that says "…click on New Game…".
 */
export function findDlgControl(target: string | number): { hwnd: number; win: WindowInfo } | undefined {
    if (typeof target === "number") {
        const t = target >>> 0;
        const byHwnd = windows.get(t);
        if (byHwnd) return { hwnd: t, win: byHwnd };
        for (const [hwnd, w] of windows) if ((w.controlId ?? -1) === target) return { hwnd, win: w };
        return undefined;
    }
    const needle = String(target).replace(/&(.)/g, "$1").trim().toLowerCase();
    if (!needle) return undefined; // "" matches every window; refuse rather than guess
    const tiers: Array<Array<{ hwnd: number; win: WindowInfo }>> = [[], [], [], [], [], [], [], []];
    for (const [hwnd, w] of windows) {
        const label = labelOf(w);
        const exact = label === needle;
        if (!exact && !label.includes(needle)) continue;
        // 0..7: clickable/not x exact/substring x visible/hidden, best first.
        const tier = (isClickable(w) ? 0 : 4) + (exact ? 0 : 2) + (w.visible ? 0 : 1);
        tiers[tier].push({ hwnd, win: w });
    }
    for (const tier of tiers) {
        if (tier.length === 1) return tier[0];
        if (tier.length > 1) throw ambiguous(needle, tier);
    }
    return undefined;
}
