/**
 * WM_PAINT / owner-draw delivery trace — the instrument for "this control is
 * invisible" and "this dialog never painted".
 *
 * A blank control is the end of a CHAIN: WM_PAINT has to be posted, survive the
 * pump's filter, reach the right thread, be dispatched to a wndProc, and end in an
 * EndPaint that runs the owner-draw/WM_DRAWITEM chain over the children. Any link
 * can drop it, and the pixels look identical whichever one did — so the trace
 * records each link's DECISION (and, where there is one, its reason), not just the
 * happy path.
 *
 * Armed at runtime through the harness (`paintTrace`), so diagnosing a blank
 * control needs no source edit and no rebuild. While disarmed every call site is a
 * single live-binding boolean test and builds no argument objects — that is why the
 * sites read `if (paintTraceEnabled) log…(…)` rather than passing a thunk.
 */

/** Live binding — importers see arm/disarm without re-importing. */
export let paintTraceEnabled = false;

/** Paint-family messages; anything else is only recorded under an explicit hwnd filter. */
const WM_PAINT = 0x000F;
const WM_ERASEBKGND = 0x0014;
const WM_NCPAINT = 0x0085;
const PAINT_MESSAGES = new Set([WM_PAINT, WM_ERASEBKGND, WM_NCPAINT]);

const MAX_ENTRIES = 2048;

export interface PaintTraceEntry {
    /** ms since page load. */
    t: number;
    /** Link in the chain: 'post' | 'skip' | 'deliver' | 'blocked' | 'dispatch' |
     *  'beginPaint' | 'endPaint' | 'chain' | 'overlay'. */
    ev: string;
    /** 0 when the event is not about one window. */
    hwnd: number;
    detail: string;
}

let ring: PaintTraceEntry[] = [];
let hwndFilter: Set<number> | null = null;
/** Entries dropped by the cap — a truncated ring must say so, not look complete. */
let dropped = 0;

export function armPaintTrace(on: boolean, hwnds?: number[]): void {
    paintTraceEnabled = on;
    hwndFilter = hwnds && hwnds.length ? new Set(hwnds.map((h) => h >>> 0)) : null;
}

export function readPaintTrace(): { active: boolean; dropped: number; entries: PaintTraceEntry[] } {
    return { active: paintTraceEnabled, dropped, entries: ring };
}

export function clearPaintTrace(): void {
    ring = [];
    dropped = 0;
}

/** True when an hwnd filter is armed and this window is in it. */
export function isPaintTraceHwnd(hwnd: number): boolean {
    return hwndFilter !== null && hwndFilter.has(hwnd >>> 0);
}

function push(ev: string, hwnd: number, detail: string): void {
    if (hwndFilter && hwnd !== 0 && !hwndFilter.has(hwnd >>> 0)) return;
    if (ring.length >= MAX_ENTRIES) { ring.shift(); dropped++; }
    ring.push({ t: performance.now() | 0, ev, hwnd: hwnd >>> 0, detail });
}

/** Free-form event (message-pump internals that carry no single hwnd). */
export function logPaintTrace(event: string, detail: string): void {
    push(event, 0, detail);
}

/**
 * A message handed to the guest by GetMessage/PeekMessage. Called for EVERY message,
 * so the paint-family filter lives here: without it the ring is all WM_MOUSEMOVE and
 * the one WM_PAINT you are hunting has already been shifted out.
 */
export function logPaintMsgDelivered(
    api: string,
    hwnd: number,
    message: number,
    extra?: Record<string, string | number | boolean>,
): void {
    if (!PAINT_MESSAGES.has(message) && !isPaintTraceHwnd(hwnd)) return;
    const tail = extra
        ? " " + Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`).join(" ")
        : "";
    push("deliver", hwnd, `${api} msg=0x${message.toString(16)}${tail}`);
}

/** A paint was pending but the pump's filter range could not return it. */
export function logPaintPendingBlocked(
    api: string,
    msgMin: number,
    msgMax: number,
    remove: boolean,
): void {
    push("blocked", 0,
        `${api} filter=0x${msgMin.toString(16)}..0x${msgMax.toString(16)} remove=${remove ? 1 : 0}`);
}

/** A paint was pending for a DIFFERENT thread than the one pumping. */
export function logPaintPendingThreadMismatch(
    api: string,
    msgMin: number,
    msgMax: number,
    remove: boolean,
): void {
    push("threadMismatch", 0,
        `${api} filter=0x${msgMin.toString(16)}..0x${msgMax.toString(16)} remove=${remove ? 1 : 0}`);
}

export function logBeginEndPaint(
    api: 'BeginPaint' | 'EndPaint',
    hWnd: number,
    detail: string,
): void {
    push(api === 'BeginPaint' ? "beginPaint" : "endPaint", hWnd, detail);
}

/**
 * The owner-draw / guest-painted-control chain's decision at a dialog's EndPaint.
 * "0 tasks" and "never reached" are the two ways a control stays blank, and they
 * are indistinguishable in the pixels — so both are recorded, with the counts.
 */
export function logOwnerDrawChain(
    hWnd: number,
    counts: { ctlcolor: number; drawitem: number; paint: number },
    outcome: string,
): void {
    push("chain", hWnd,
        `ctlcolor=${counts.ctlcolor} drawitem=${counts.drawitem} paint=${counts.paint} -> ${outcome}`);
}

/** A WM_PAINT we chose to post — or chose NOT to, with the reason we bailed. */
export function logPaintRequest(hWnd: number, posted: boolean, reason: string): void {
    push(posted ? "post" : "skip", hWnd, reason);
}
