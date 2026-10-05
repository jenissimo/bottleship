/**
 * cdp-mouse.ts — a click that travels the BROWSER's own input stack.
 *
 * The worker-side injectors (`clickAt`/`clickHere`) write the SAB from inside the
 * worker and skip everything in front of it: the canvas PointerEvent listeners, the
 * pointer-capture bookkeeping, the virtual-device level composer, and — the part that
 * only a real gesture can reach — Pointer Lock, which App.tsx requests on the first
 * canvas press when the guest wants relative mouse. That layer is the only place a
 * single physical click can turn into two SAB level edges, so it needs a verb of its
 * own rather than an argument to the existing ones.
 *
 * `Input.dispatchMouseEvent` (not a synthetic PointerEvent in the page): it is the only
 * route that carries USER ACTIVATION, and without activation `requestPointerLock()` is
 * refused — i.e. a page-dispatched event exercises the listener but never the lock
 * engagement this verb exists to test. It is also the only one the renderer treats as
 * trusted for pointer capture.
 */

import { type CdpSession, pageEval } from "./cdp-core";
import { readCanvasGeometry, guestToClient } from "./cdp-geometry";

export type MouseButton = "left" | "right" | "middle";

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/** Input.dispatchMouseEvent resolves only when the RENDERER acks it, and a backgrounded
 *  tab never does. Foreground first (idempotent), and bound every dispatch. */
const DISPATCH_TIMEOUT_MS = 15_000;

/** Where the last dispatched move left the host pointer, in viewport CSS px. A
 *  dispatched event carries no movement field: the renderer derives movementX/Y — what
 *  App.tsx reads under Pointer Lock — from the step between consecutive positions, so
 *  relative motion has to be expressed as one. */
let lastClient: { x: number; y: number } | null = null;


async function dispatch(session: CdpSession, params: Record<string, unknown>): Promise<void> {
    await session.send("Input.dispatchMouseEvent", params, undefined, { timeoutMs: DISPATCH_TIMEOUT_MS });
}

/** Whether the canvas currently holds Pointer Lock — the fact that splits "the click that
 *  engages the lock" from "a click while it is already held". */
export async function pointerLockHeld(session: CdpSession): Promise<boolean> {
    return Boolean(await pageEval(session, "!!document.pointerLockElement", { timeoutMs: 10_000 }).catch(() => false));
}

export interface HostClickResult {
    guest: { x: number; y: number };
    client: { x: number; y: number };
    holdMs: number;
    button: MouseButton;
    /** Pointer Lock before and after — a first click typically engages it. */
    lock: { before: boolean; after: boolean };
    ms: number;
    [k: string]: unknown;
}

/**
 * Press and release on the canvas through the browser's input stack.
 *
 * Coordinates are GUEST px (canvas centre when omitted). A guest steering by motion
 * owns its own cursor, so the position only decides which ELEMENT gets the event;
 * aim such a cursor with `moveRelative` first, exactly as with `clickHere`.
 */
export async function hostClick(
    session: CdpSession,
    opts: { x?: number; y?: number; holdMs?: number; button?: MouseButton; move?: boolean } = {},
): Promise<HostClickResult> {
    const t0 = Date.now();
    const button = opts.button ?? "left";
    const holdMs = Math.max(1, opts.holdMs ?? 80);
    await session.send("Page.bringToFront", {}, undefined, { timeoutMs: DISPATCH_TIMEOUT_MS }).catch(() => { });
    const geo = await readCanvasGeometry(session);
    const gx = opts.x ?? geo.guest.w / 2;
    const gy = opts.y ?? geo.guest.h / 2;
    const p = guestToClient(geo, gx, gy);
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    lastClient = { x: at.x, y: at.y };
    const before = await pointerLockHeld(session);

    // A move first, so the press lands on an element the page has already seen the
    // pointer over — a press with no prior move is not a gesture a hand can make, and
    // the hover state the guest hit-tests against would be a frame behind.
    if (opts.move !== false) {
        await dispatch(session, { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0, clickCount: 0 });
    }
    await dispatch(session, {
        type: "mousePressed", x: at.x, y: at.y, button, buttons: BUTTON_MASK[button], clickCount: 1,
    });
    await Bun.sleep(holdMs);
    await dispatch(session, {
        type: "mouseReleased", x: at.x, y: at.y, button, buttons: 0, clickCount: 1,
    });

    return {
        guest: { x: gx, y: gy },
        client: at,
        holdMs,
        button,
        lock: { before, after: await pointerLockHeld(session) },
        ms: Date.now() - t0,
    };
}

/** Relative motion through the browser stack: App.tsx's own pointermove handler, and
 *  under Pointer Lock its movementX/Y branch. The SAB injectors write the delta slots
 *  directly and never touch it. `dx`/`dy` are guest px. */
export async function hostMove(
    session: CdpSession,
    dx: number,
    dy: number,
    steps = 1,
): Promise<{ dx: number; dy: number; steps: number; from: { x: number; y: number }; to: { x: number; y: number }; locked: boolean }> {
    await session.send("Page.bringToFront", {}, undefined, { timeoutMs: DISPATCH_TIMEOUT_MS }).catch(() => { });
    const geo = await readCanvasGeometry(session);
    const from = lastClient ?? guestToClient(geo, geo.guest.w / 2, geo.guest.h / 2);
    const to = { x: from.x + dx * geo.scale.x, y: from.y + dy * geo.scale.y };
    const n = Math.max(1, steps | 0);
    for (let i = 1; i <= n; i++) {
        const at = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
        await dispatch(session, {
            type: "mouseMoved", x: Math.round(at.x), y: Math.round(at.y),
            button: "none", buttons: 0, clickCount: 0,
        });
    }
    lastClient = to;
    return { dx, dy, steps: n, from, to, locked: await pointerLockHeld(session) };
}
