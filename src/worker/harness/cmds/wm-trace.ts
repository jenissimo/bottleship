/**
 * wmTrace — record the WM_* the input layer actually posts, so message ORDER and
 * lParam encoding become assertable instead of inferred. Wraps
 * WindowManager.postMessage on demand (zero cost when off) and keeps a capped ring
 * filtered to the pointer/keyboard family; expectMessages (cmds/assert.ts) matches
 * an ordered subsequence over it.
 *
 * Actions: "start" | "stop" | "read" (returns + keeps) | "clear".
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { setControlNotifyObserver } from "../../modules/user32/control-interaction";

const MAX_ENTRIES = 512;

/** Traced message ids → name. Anything not listed here is not recorded.
 *  The control NOTIFICATIONS belong here as much as the raw input does: "the button
 *  got a clean DOWN/UP and nothing happened" is only half an observation until you
 *  can see whether the class proc turned it into WM_COMMAND(BN_CLICKED) — and for
 *  whom. */
const TRACED_MSG: Record<number, string> = {
    0x0020: "WM_SETCURSOR",
    0x004E: "WM_NOTIFY",
    0x0111: "WM_COMMAND",
    0x0112: "WM_SYSCOMMAND",
    0x0114: "WM_HSCROLL",
    0x0115: "WM_VSCROLL",
    0x0100: "WM_KEYDOWN",
    0x0101: "WM_KEYUP",
    0x0102: "WM_CHAR",
    0x0103: "WM_DEADCHAR",
    0x0104: "WM_SYSKEYDOWN",
    0x0105: "WM_SYSKEYUP",
    0x0106: "WM_SYSCHAR",
    0x0107: "WM_SYSDEADCHAR",
    0x0200: "WM_MOUSEMOVE",
    0x0201: "WM_LBUTTONDOWN",
    0x0202: "WM_LBUTTONUP",
    0x0203: "WM_LBUTTONDBLCLK",
    0x0204: "WM_RBUTTONDOWN",
    0x0205: "WM_RBUTTONUP",
    0x0206: "WM_RBUTTONDBLCLK",
    0x0207: "WM_MBUTTONDOWN",
    0x0208: "WM_MBUTTONUP",
    0x0209: "WM_MBUTTONDBLCLK",
    0x020A: "WM_MOUSEWHEEL",
    0x020E: "WM_MOUSEHWHEEL",
    0x02A1: "WM_MOUSEHOVER",
    0x02A3: "WM_MOUSELEAVE",
};

export interface WmTraceEntry {
    /** ms since page load, for eyeballing repeat cadence. */
    t: number;
    hwnd: number;
    msg: number;
    name: string;
    wParam: number;
    lParam: number;
    /** Screen coords carried in MSG.pt (0 for keyboard messages). */
    x: number;
    y: number;
    /** InputManager poll seq that produced this message (-1 if not from a poll). */
    seq: number;
}

interface WmTraceProbe {
    entries: WmTraceEntry[];
    original: WindowManagerPostMessage;
}

type WindowManagerPostMessage = (
    hwnd: number, msg: number, wParam: number, lParam: number,
    ptX?: number, ptY?: number, targetThreadId?: number, keyStatePacked?: Uint8Array,
) => void;

function wm(): any {
    const w = sys().windowManager;
    if (!w) throw new HarnessError("no window manager", HarnessErrorCode.NO_PROCESS);
    return w as any;
}

function probe(): WmTraceProbe | undefined {
    return (sys().windowManager as any)?.__wmTraceProbe;
}

/** The ring, live or the last stopped one (empty if never started). Read by expectMessages. */
export function wmTraceEntries(): WmTraceEntry[] {
    return probe()?.entries ?? (sys().windowManager as any)?.__wmTraceEntries ?? [];
}

/** One-line rendering used by both read() and the expectMessages failure text. */
export function formatWmTraceEntry(e: WmTraceEntry): string {
    const at = e.x || e.y ? `@${e.x},${e.y}` : "";
    return `${e.name}${at} w=0x${(e.wParam >>> 0).toString(16)} l=0x${(e.lParam >>> 0).toString(16)}` +
        ` hwnd=0x${(e.hwnd >>> 0).toString(16)} seq=${e.seq}`;
}

export function registerWmTraceCommands(svc: HarnessService): void {
    svc.register("wmTrace", (args) => {
        const action = String(args[0] ?? "read");
        const w = wm();
        const p: WmTraceProbe | undefined = w.__wmTraceProbe;

        if (action === "start") {
            if (p) return { ok: true, already: true, entries: p.entries.length };
            const original: WindowManagerPostMessage = w.postMessage.bind(w);
            const created: WmTraceProbe = { entries: [], original };
            w.__wmTraceProbe = created;
            w.postMessage = (
                hwnd: number, msg: number, wParam: number, lParam: number,
                ptX = 0, ptY = 0, targetThreadId = 0, keyStatePacked?: Uint8Array,
            ): void => {
                const name = TRACED_MSG[msg];
                if (name) {
                    if (created.entries.length >= MAX_ENTRIES) created.entries.shift();
                    created.entries.push({
                        t: performance.now() | 0,
                        hwnd: hwnd >>> 0, msg, name,
                        wParam: wParam | 0, lParam: lParam | 0,
                        x: ptX | 0, y: ptY | 0,
                        seq: (sys().inputManager as any)?.lastSeq ?? -1,
                    });
                }
                original(hwnd, msg, wParam, lParam, ptX, ptY, targetThreadId, keyStatePacked);
            };
            // Control notifications are delivered synchronously, not posted — tap them
            // at the source or the ring shows the input and never the outcome.
            setControlNotifyObserver((n) => {
                const name = TRACED_MSG[n.msg];
                if (!name) return;
                if (created.entries.length >= MAX_ENTRIES) created.entries.shift();
                created.entries.push({
                    t: performance.now() | 0,
                    hwnd: n.hwnd >>> 0, msg: n.msg, name,
                    wParam: n.wParam | 0, lParam: n.lParam | 0,
                    x: 0, y: 0,
                    seq: (sys().inputManager as any)?.lastSeq ?? -1,
                });
            });
            return { ok: true, started: true };
        }
        if (action === "stop") {
            if (!p) return { ok: true, already: true, entries: [] };
            w.postMessage = p.original;
            setControlNotifyObserver(null);
            delete w.__wmTraceProbe;
            // The ring survives the unwrap so a .wmTrace('stop').expectMessages([..])
            // chain still has something to assert against.
            w.__wmTraceEntries = p.entries;
            return { ok: true, stopped: true, entries: p.entries };
        }
        if (action === "clear") {
            if (p) p.entries.length = 0;
            w.__wmTraceEntries = undefined;
            return { ok: true };
        }
        return { ok: true, active: !!p, entries: wmTraceEntries() };
    });
}
