/**
 * cdp-touch.ts — device emulation + synthetic touch for the harness.
 *
 * Touch is a HOST input device (docs/mobile-touch-plan.md): the guest never sees a
 * contact, only the cursor/delta/button the recognizer derives from one. So the
 * regression surface for every touch feature is exactly this — put real
 * `Input.dispatchTouchEvent` contacts on the canvas at GUEST coordinates and assert
 * on what the guest observed. No phone in the loop.
 *
 * All verbs take guest px and convert through cdp-geometry, so a chain reads the
 * same whether the page is emulating a 390-px phone or running at 1400 px desktop.
 * Timed gestures sleep for real: a recognizer distinguishes tap from long press from
 * drag by wall-clock, and a burst of instantly-dispatched events is none of them.
 */

import { pageEval, type CdpSession } from "./cdp-core";
import { readCanvasGeometry, guestToClient } from "./cdp-geometry";

/* ───────────────────────────── device profiles ───────────────────────────── */

export interface DeviceProfile {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
    /** navigator.maxTouchPoints the page should report; 0 disables touch emulation. */
    maxTouchPoints: number;
}

/** Plain data. `desktop` is the null profile: it CLEARS the override. */
export const DEVICE_PROFILES: Record<string, DeviceProfile | null> = {
    desktop: null,
    "phone-landscape": { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, maxTouchPoints: 5 },
    "phone-portrait": { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, maxTouchPoints: 5 },
    "tablet-landscape": { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, maxTouchPoints: 5 },
    "tablet-portrait": { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, maxTouchPoints: 5 },
};

/** Aliases so plan/acceptance chains can name a device instead of a form factor. */
const PROFILE_ALIASES: Record<string, string> = {
    none: "desktop",
    off: "desktop",
    phone: "phone-landscape",
    tablet: "tablet-landscape",
    "iphone-14-landscape": "phone-landscape",
    "ipad-landscape": "tablet-landscape",
};

export function resolveProfileName(name: string): string {
    const key = String(name ?? "").trim().toLowerCase();
    return PROFILE_ALIASES[key] ?? key;
}

export interface DeviceResult {
    profile: string;
    metrics: DeviceProfile | null;
    maxTouchPoints: number;
    innerWidth: number;
    innerHeight: number;
}

/**
 * Apply (or clear, for `desktop`) a device profile. Metrics and touch emulation are
 * one verb because they are one intent — a 390-px viewport that still reports
 * maxTouchPoints 0 exercises neither the mobile CSS nor the touch path.
 */
export async function applyDevice(session: CdpSession, name: string): Promise<DeviceResult> {
    const profile = resolveProfileName(name);
    if (!(profile in DEVICE_PROFILES)) {
        throw new Error(`unknown device profile '${name}' (have: ${Object.keys(DEVICE_PROFILES).join(", ")})`);
    }
    const metrics = DEVICE_PROFILES[profile];
    await focusTarget(session);
    if (!metrics) {
        await session.send("Emulation.clearDeviceMetricsOverride");
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    } else {
        await session.send("Emulation.setDeviceMetricsOverride", {
            width: metrics.width,
            height: metrics.height,
            deviceScaleFactor: metrics.deviceScaleFactor,
            mobile: metrics.mobile,
            screenOrientation: metrics.width >= metrics.height
                ? { type: "landscapePrimary", angle: 90 }
                : { type: "portraitPrimary", angle: 0 },
        });
        await session.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: metrics.maxTouchPoints,
        });
    }
    // The canvas is sized from a resize observer / rAF; let the reflow land before
    // any verb reads the rect, or the first tap aims at the pre-resize layout.
    await Bun.sleep(400);
    const probe = (await pageEval(
        session,
        "({ mtp: navigator.maxTouchPoints, w: window.innerWidth, h: window.innerHeight })",
        { timeoutMs: 10_000 },
    )) as { mtp: number; w: number; h: number };
    return { profile, metrics, maxTouchPoints: probe?.mtp ?? 0, innerWidth: probe?.w ?? 0, innerHeight: probe?.h ?? 0 };
}

/* ─────────────────────────── touch event primitives ─────────────────────────── */

interface Contact {
    id: number;
    /** Viewport CSS px. */
    x: number;
    y: number;
}

/** A fingertip is ~24 CSS px across; force 1 so pressure-aware code sees a press. */
function toTouchPoint(c: Contact): Record<string, number> {
    return { x: Math.round(c.x), y: Math.round(c.y), id: c.id, radiusX: 12, radiusY: 12, force: 1 };
}

/** Input.dispatchTouchEvent resolves only when the RENDERER acks the event, and a
 *  backgrounded tab never does — the call hangs forever with no error. Every gesture
 *  foregrounds its tab first (idempotent, one round-trip). */
async function focusTarget(session: CdpSession): Promise<void> {
    await session.send("Page.bringToFront").catch(() => { /* headless/detached target */ });
}

async function dispatch(session: CdpSession, type: string, contacts: Contact[]): Promise<void> {
    await session.send("Input.dispatchTouchEvent", { type, touchPoints: contacts.map(toTouchPoint) });
}

/** Interpolation steps for a `ms`-long gesture: ~60 Hz, floored so even a fast
 *  flick leaves a motion trail a velocity estimator can use, capped so a long
 *  drag doesn't turn into a thousand round-trips. */
function stepsFor(ms: number): number {
    return Math.max(6, Math.min(60, Math.round(ms / 16)));
}

/** Sleep the remainder of a step's budget (dispatch round-trip already ate some). */
async function paceTo(deadline: number): Promise<void> {
    const left = deadline - Date.now();
    if (left > 0) await Bun.sleep(left);
}

export interface TouchResult {
    guest: { x: number; y: number };
    client: { x: number; y: number };
    ms: number;
    [k: string]: unknown;
}

/** Tap: down, a finger's worth of dwell, up. A zero-length contact is not physically
 *  realizable and invites a debounce to drop it; the dwell stays far below
 *  LONG_PRESS_MS so classification is unambiguous. (The synthesized *mouse* hold a
 *  level-based transport needs — TAP_HOLD_MS — is the recognizer's job, not ours.) */
export async function tap(session: CdpSession, x: number, y: number, dwellMs = 60): Promise<TouchResult> {
    const t0 = Date.now();
    await focusTarget(session);
    const geo = await readCanvasGeometry(session);
    const p = guestToClient(geo, x, y);
    const t1 = Date.now();
    await dispatch(session, "touchStart", [{ id: 1, ...p }]);
    await paceTo(t1 + dwellMs);
    await dispatch(session, "touchEnd", []);
    return { guest: { x, y }, client: p, dwellMs, ms: Date.now() - t0 };
}

/** Press, hold for `ms` of real time, release. */
export async function longPress(session: CdpSession, x: number, y: number, ms = 600): Promise<TouchResult> {
    const t0 = Date.now();
    await focusTarget(session);
    const geo = await readCanvasGeometry(session);
    const p = guestToClient(geo, x, y);
    const t1 = Date.now();
    await dispatch(session, "touchStart", [{ id: 1, ...p }]);
    await paceTo(t1 + ms);
    await dispatch(session, "touchEnd", []);
    return { guest: { x, y }, client: p, holdMs: ms, ms: Date.now() - t0 };
}

/** Drag one contact along a straight line over `ms`, with interpolated moves. */
export async function touchDrag(
    session: CdpSession,
    x0: number, y0: number, x1: number, y1: number,
    ms = 300,
): Promise<TouchResult> {
    const t0 = Date.now();
    await focusTarget(session);
    const geo = await readCanvasGeometry(session);
    const a = guestToClient(geo, x0, y0);
    const b = guestToClient(geo, x1, y1);
    const n = stepsFor(ms);
    const t1 = Date.now();
    await dispatch(session, "touchStart", [{ id: 1, ...a }]);
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        await paceTo(t1 + (ms * i) / n);
        await dispatch(session, "touchMove", [{ id: 1, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }]);
    }
    await dispatch(session, "touchEnd", []);
    return { guest: { x: x1, y: y1 }, client: b, from: { x: x0, y: y0 }, moves: n, ms: Date.now() - t0 };
}

/** Two simultaneous contacts, straddling (x,y) — the plan's RMB gesture. */
export async function twoFingerTap(session: CdpSession, x: number, y: number, spread = 24): Promise<TouchResult> {
    const t0 = Date.now();
    await focusTarget(session);
    const geo = await readCanvasGeometry(session);
    const a = guestToClient(geo, x - spread / 2, y);
    const b = guestToClient(geo, x + spread / 2, y);
    const t1 = Date.now();
    await dispatch(session, "touchStart", [{ id: 1, ...a }, { id: 2, ...b }]);
    // A recognizer that arbitrates a second contact over a window (ARBITRATION_MS)
    // needs the pair to be observably co-present before either lifts.
    await paceTo(t1 + 100);
    await dispatch(session, "touchEnd", []);
    return { guest: { x, y }, client: a, second: b, spread, ms: Date.now() - t0 };
}

/**
 * Pinch: two contacts `span` guest px apart, moving symmetrically to `span * scale`.
 * scale < 1 pinches in, > 1 spreads out.
 */
export async function pinch(
    session: CdpSession,
    x: number, y: number, scale: number,
    opts: { ms?: number; span?: number } = {},
): Promise<TouchResult> {
    const ms = opts.ms ?? 400;
    const span = opts.span ?? 120;
    const t0 = Date.now();
    await focusTarget(session);
    const geo = await readCanvasGeometry(session);
    const n = stepsFor(ms);
    const half = span / 2;
    const at = (h: number) => [guestToClient(geo, x - h, y), guestToClient(geo, x + h, y)] as const;
    const [a0, b0] = at(half);
    const t1 = Date.now();
    await dispatch(session, "touchStart", [{ id: 1, ...a0 }, { id: 2, ...b0 }]);
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        await paceTo(t1 + (ms * i) / n);
        const [a, b] = at(half * (1 + (scale - 1) * t));
        await dispatch(session, "touchMove", [{ id: 1, ...a }, { id: 2, ...b }]);
    }
    await dispatch(session, "touchEnd", []);
    return { guest: { x, y }, client: a0, scale, span, endSpan: span * scale, moves: n, ms: Date.now() - t0 };
}
