/**
 * Which rectangle V of the guest screen the host surface shows: the one selection rule.
 *
 * - V is the client rectangle of the foreground window's root, clipped to the screen. The
 *   root is found through WS_CHILD parents and through the owners of popups, so an owned
 *   dialog keeps its game window framed; a popup root (a launcher dialog, a borderless
 *   window) is not framed.
 * - A root that covers the screen, exclusive DirectDraw (which owns the display), and the
 *   "show the whole desktop" setting give the screen.
 * - A visible top-level window outside V that is not in the root's owner chain (an
 *   ownerless MessageBox, a launcher behind the game) gives the screen rather than
 *   clipping that window away.
 *
 * Nothing here is saved: V follows from the windows and the mode, and a restore republishes
 * it. System publishes only a change, so a title that sizes its window every frame does not
 * republish.
 */

import { System, type HostView } from "../../core/system";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { getVirtualScreenRect, windows, type WindowInfo } from "../../modules/user32/shared-state";
import type { WindowManager } from "./window-manager";

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_MINIMIZE = 0x20000000;
const MAX_CHAIN = 32;

function isTopLevel(win: WindowInfo): boolean {
    return (win.style & WS_CHILD) === 0;
}

/** The foreground window's root: up through WS_CHILD parents, then through popup owners. */
function foregroundRoot(hwnd: number): WindowInfo | undefined {
    let win = hwnd ? windows.get(hwnd >>> 0) : undefined;
    for (let i = 0; win && i < MAX_CHAIN && !isTopLevel(win) && win.parent; i++) win = windows.get(win.parent);
    for (let i = 0; win && i < MAX_CHAIN && (win.style & WS_POPUP) !== 0 && win.parent; i++) {
        const owner = windows.get(win.parent);
        if (!owner || !isTopLevel(owner)) break;
        win = owner;
    }
    return win && isTopLevel(win) ? win : undefined;
}

function inOwnerChain(root: WindowInfo, win: WindowInfo): boolean {
    let cur: WindowInfo | undefined = root;
    for (let i = 0; cur && i < MAX_CHAIN; i++) {
        if (cur === win) return true;
        cur = cur.parent ? windows.get(cur.parent) : undefined;
    }
    return false;
}

/** Fills `out` with V. */
export function selectHostView(out: HostView): void {
    const screen = getVirtualScreenRect();
    out.x = screen.left;
    out.y = screen.top;
    out.width = screen.right - screen.left;
    out.height = screen.bottom - screen.top;

    if (EmulatorConfig.getInstance().showWholeDesktop) return;
    const system = System.getInstance();
    if (system.ddrawContext?.cooperative?.exclusive) return;

    const root = foregroundRoot(system.windowManager?.getForegroundHwnd?.() ?? 0);
    if (!root || !root.visible || (root.style & (WS_POPUP | WS_MINIMIZE)) !== 0) return;

    const x0 = Math.max(screen.left, root.x), y0 = Math.max(screen.top, root.y);
    const x1 = Math.min(screen.right, root.x + root.width), y1 = Math.min(screen.bottom, root.y + root.height);
    if (x1 <= x0 || y1 <= y0) return;
    if (x0 <= screen.left && y0 <= screen.top && x1 >= screen.right && y1 >= screen.bottom) return;

    for (const win of windows.values()) {
        if (!win.visible || !isTopLevel(win) || win.width <= 0 || win.height <= 0) continue;
        if (win.x >= x0 && win.y >= y0 && win.x + win.width <= x1 && win.y + win.height <= y1) continue;
        if (inOwnerChain(root, win)) continue;
        return;
    }

    out.x = x0;
    out.y = y0;
    out.width = x1 - x0;
    out.height = y1 - y0;
}

/** Re-derive V after anything it depends on changed; publishes only a change. */
export function refreshHostView(): void {
    System.getInstance().refreshHostView();
}

/** Installs the rule (user32's window observers do, with the window manager). */
export function installHostViewPolicy(wm: WindowManager): void {
    System.getInstance().setHostViewSelector(selectHostView);
    wm.registerForegroundWindowObserver(refreshHostView);
}
