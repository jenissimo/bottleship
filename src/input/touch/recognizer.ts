/**
 * Touch gesture recognizer — pure, DOM-free, clock-free.
 *
 * Contacts in, pointer intents out. Time is INJECTED (`now` on every `step`
 * and `tick`) and every time-based transition fires from `tick()`, which the
 * driver drives from rAF. That is what makes the whole gesture vocabulary a
 * unit test instead of a browser session.
 *
 * Classification is DEFERRED: no button is ever committed on touchdown. A still
 * contact holds nothing until LONG_PRESS_MS and then goes straight to RMB, so a
 * right-click never costs half a second of "walk to that point" first. Button
 * edges are emitted from ONE place (`syncButton`), which recomputes the desired
 * button from the live phase — a cancelled contact therefore releases whatever
 * it held without anyone having to remember to.
 */

import {
    ARBITRATION_MS,
    AXIS_LATCH_PX,
    DRAG_COMMIT_MS,
    DRAG_SLOP_PX,
    FINGER_OFFSET_Y_PX,
    FLICK_SPEED_PX_MS,
    LONG_PRESS_MS,
    REFINE_GAIN,
    TAP_HOLD_MS,
    WHEEL_NOTCH_PX,
} from "./gestures";

export type TouchIntent =
    | { k: "cursor"; x: number; y: number }     // absolute position in guest px
    | { k: "delta"; dx: number; dy: number }    // relative motion, raw
    | { k: "button"; button: 0 | 1 | 2; down: boolean }   // DOM numbering: 0 left, 1 middle, 2 right
    | { k: "wheel"; delta: number };            // browser-pixel-equivalent delta

export type TouchEvent2 = { id: number; phase: "down" | "move" | "up" | "cancel"; x: number; y: number };

export type TouchMode = "direct" | "trackpad";

export interface RecognizerConfig {
    /** "direct" = the finger IS the cursor; "trackpad" = relative look/aim. Default "direct". */
    mode?: TouchMode;
    /** Multiplier on relative motion in trackpad mode. Default 1. */
    sensitivity?: number;
    /** Long press commits RMB (true) or LMB (false). Default true. */
    longPressRight?: boolean;
    /** Apply the fingertip offset so the cursor is not under the finger. Default true. */
    cursorAid?: boolean;
    /** Guest-space clamp for published cursor positions. Defaults: 0..MAX_SAFE_INTEGER. */
    minX?: number;
    minY?: number;
    maxX?: number;
    maxY?: number;
    /** Fingertip offset in the recognizer's own units; the driver scales the CSS-px
     *  FINGER_OFFSET_Y_PX into guest px. Default FINGER_OFFSET_Y_PX. */
    offsetY?: number;
}

/**
 * Browser deltaY published per emitted notch. InputManager converts the SAB's
 * pixel deltaY at 1.2 (poll(): `-mouseWheel * 1.2`), so 100 px is exactly one
 * WHEEL_DELTA (120) — one finger notch must be one guest notch, not a fraction
 * of one, or a weapon-cycle needs three swipes.
 */
export const WHEEL_NOTCH_DELTA_PX = 100;

/** Concurrent contacts tracked. Past this a contact is ignored outright. */
const MAX_CONTACTS = 10;
/** A contact untouched this long has lost its lift; well past any real hold. */
const STALE_CONTACT_MS = 30_000;
/**
 * The same, while a button is published down. Tighter because the cost is not a
 * consumed slot but a button the guest sees held: a lost lift mid-drag latches LMB
 * for as long as we believe the finger is there. The floor is what a motionless
 * hold can legitimately last — a still contact emits no events, so its age is all
 * we have to judge by.
 */
const STALE_HELD_CONTACT_MS = 10_000;

export const Phase = {
    /** No contacts, nothing owed. */
    idle: 0,
    /** One contact down, unclassified: could still become tap / drag / refine / long press. */
    pending: 1,
    /** Committed drag (LMB in direct mode; pure look in trackpad). */
    drag: 2,
    /** Precision aim slide: cursor follows at REFINE_GAIN, no button, still resolves to a tap. */
    refine: 3,
    /** Long press fired; the button is held until lift. */
    longPress: 4,
    /** Two or more contacts: button selector and/or wheel. */
    multi: 5,
    /** A button is down and its release is owed at `releaseAt`. */
    tapHold: 6,
    /** Gesture over but contacts remain; nothing new starts until all lift. */
    drain: 7,
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

const AXIS_NONE = 0;
const AXIS_PAN = 1;
const AXIS_PINCH = 2;

const NO_BUTTON = -1;

export interface RecognizerState {
    cfg: Required<RecognizerConfig>;
    phase: Phase;

    // Contact slots: parallel arrays reused for the life of the recognizer, so a
    // 120 Hz multitouch stream allocates nothing per contact. id === -1 is free.
    id: Int32Array;
    sx: Float64Array;
    sy: Float64Array;
    cx: Float64Array;
    cy: Float64Array;
    /** Live slot indices in arrival order; order[0] is the primary. */
    order: Int32Array;
    count: number;
    /** Last time each slot was seen, so a contact whose lift never arrived can be reaped. */
    seenT: Float64Array;

    /** Primary touchdown time, and its previous sample time (for instantaneous speed). */
    startT: number;
    lastT: number;
    /** Wall clock at which an armed long press fires; Infinity = disarmed. */
    longPressAt: number;

    /** Last published cursor position — the anchor every tap resolves at. */
    curX: number;
    curY: number;

    /** Button currently published as down, or NO_BUTTON. */
    heldButton: number;
    /** Button owed by the pending tap in `tapHold`. */
    tapButton: number;
    buttonDownAt: number;
    releaseAt: number;
    /** Button armed by multi-contact arbitration, or NO_BUTTON. */
    tapCandidate: number;

    // Two-finger wheel tracking.
    axis: number;
    pairA: number;
    pairB: number;
    baseCy: number;
    baseDist: number;
    /** Latched-axis value the next notch is measured from. */
    ref: number;
}

export function createRecognizer(cfg: RecognizerConfig): RecognizerState {
    const id = new Int32Array(MAX_CONTACTS);
    id.fill(-1);
    return {
        cfg: {
            mode: cfg.mode ?? "direct",
            sensitivity: cfg.sensitivity ?? 1,
            longPressRight: cfg.longPressRight ?? true,
            cursorAid: cfg.cursorAid ?? true,
            minX: cfg.minX ?? 0,
            minY: cfg.minY ?? 0,
            maxX: cfg.maxX ?? Number.MAX_SAFE_INTEGER,
            maxY: cfg.maxY ?? Number.MAX_SAFE_INTEGER,
            offsetY: cfg.offsetY ?? FINGER_OFFSET_Y_PX,
        },
        phase: Phase.idle,
        id,
        sx: new Float64Array(MAX_CONTACTS),
        sy: new Float64Array(MAX_CONTACTS),
        cx: new Float64Array(MAX_CONTACTS),
        cy: new Float64Array(MAX_CONTACTS),
        order: new Int32Array(MAX_CONTACTS),
        seenT: new Float64Array(MAX_CONTACTS),
        count: 0,
        startT: 0,
        lastT: 0,
        longPressAt: Infinity,
        curX: 0,
        curY: 0,
        heldButton: NO_BUTTON,
        tapButton: NO_BUTTON,
        buttonDownAt: 0,
        releaseAt: Infinity,
        tapCandidate: NO_BUTTON,
        axis: AXIS_NONE,
        pairA: -1,
        pairB: -1,
        baseCy: 0,
        baseDist: 0,
        ref: 0,
    };
}

/** True while no gesture is in flight — the driver's safe point to swap `cfg`. */
export function isIdle(s: RecognizerState): boolean {
    return s.phase === Phase.idle && s.count === 0;
}

export function step(s: RecognizerState, ev: TouchEvent2, now: number): TouchIntent[] {
    const out: TouchIntent[] = [];
    switch (ev.phase) {
        case "down": onDown(s, ev, now, out); break;
        case "move": onMove(s, ev, now, out); break;
        case "up": onUp(s, ev, now, out); break;
        case "cancel": onCancel(s, ev, now, out); break;
    }
    return out;
}

/** Fires the time-based transitions: long press, the owed tap release, and the
 *  reaping of contacts whose lift never arrived. */
export function tick(s: RecognizerState, now: number): TouchIntent[] {
    const out: TouchIntent[] = [];
    reapStaleContacts(s, now, out);
    if (s.phase === Phase.pending && now >= s.longPressAt) {
        s.longPressAt = Infinity;
        s.phase = Phase.longPress;
        syncButton(s, now, out);
    }
    if (s.phase === Phase.tapHold && now >= s.releaseAt) {
        s.phase = s.count > 0 ? Phase.drain : Phase.idle;
        s.tapButton = NO_BUTTON;
        s.releaseAt = Infinity;
        syncButton(s, now, out);
    }
    return out;
}

// ─── Contact slots ──────────────────────────────────────────────────────────

function findSlot(s: RecognizerState, id: number): number {
    for (let i = 0; i < s.count; i++) {
        const slot = s.order[i]!;
        if (s.id[slot] === id) return slot;
    }
    return -1;
}

function addContact(s: RecognizerState, id: number, x: number, y: number): number {
    if (s.count >= MAX_CONTACTS) return -1;
    let slot = -1;
    for (let i = 0; i < MAX_CONTACTS; i++) {
        if (s.id[i] === -1) { slot = i; break; }
    }
    if (slot < 0) return -1;
    s.id[slot] = id;
    s.sx[slot] = x; s.sy[slot] = y;
    s.cx[slot] = x; s.cy[slot] = y;
    s.order[s.count++] = slot;
    return slot;
}

function removeContact(s: RecognizerState, slot: number): void {
    s.id[slot] = -1;
    let w = 0;
    for (let i = 0; i < s.count; i++) {
        const v = s.order[i]!;
        if (v !== slot) s.order[w++] = v;
    }
    s.count = w;
}

// ─── Intent emission ────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function publishCursor(s: RecognizerState, x: number, y: number, out: TouchIntent[]): void {
    s.curX = clamp(x, s.cfg.minX, s.cfg.maxX);
    s.curY = clamp(y, s.cfg.minY, s.cfg.maxY);
    out.push({ k: "cursor", x: s.curX, y: s.curY });
}

/** Cursor position for a contact at (x,y): the fingertip offset moves it clear of the finger. */
function aimY(s: RecognizerState, y: number): number {
    return s.cfg.cursorAid ? y + s.cfg.offsetY : y;
}

function publishDelta(s: RecognizerState, dx: number, dy: number, gain: number, out: TouchIntent[]): void {
    const g = gain * s.cfg.sensitivity;
    if (dx === 0 && dy === 0) return;
    out.push({ k: "delta", dx: dx * g, dy: dy * g });
}

/** Motion for the phases that just follow the contact, in whichever mode is active. */
function followContact(s: RecognizerState, x: number, y: number, dx: number, dy: number, gain: number, out: TouchIntent[]): void {
    if (s.cfg.mode === "direct") {
        if (gain === 1) publishCursor(s, x, aimY(s, y), out);
        else publishCursor(s, s.curX + dx * gain, s.curY + dy * gain, out);
    } else {
        publishDelta(s, dx, dy, gain, out);
    }
}

/** The button the CURRENT phase implies. Everything else is derived from this. */
function desiredButton(s: RecognizerState): number {
    switch (s.phase) {
        case Phase.drag:
            // Trackpad drag is look/aim, not a drag: no button, ever.
            return s.cfg.mode === "direct" ? 0 : NO_BUTTON;
        case Phase.longPress:
            return s.cfg.longPressRight ? 2 : 0;
        case Phase.tapHold:
            return s.tapButton;
        default:
            return NO_BUTTON;
    }
}

/** The single emitter of button edges: reconcile what is published with what the phase wants. */
function syncButton(s: RecognizerState, now: number, out: TouchIntent[]): void {
    const want = desiredButton(s);
    if (want === s.heldButton) return;
    if (s.heldButton !== NO_BUTTON) {
        out.push({ k: "button", button: s.heldButton as 0 | 1 | 2, down: false });
        s.heldButton = NO_BUTTON;
    }
    if (want !== NO_BUTTON) {
        out.push({ k: "button", button: want as 0 | 1 | 2, down: true });
        s.heldButton = want;
        s.buttonDownAt = now;
    }
}

/** Lift resolves to a tap: cursor at the FINAL position, button down, release owed to tick(). */
function resolveTap(s: RecognizerState, button: number, now: number, out: TouchIntent[]): void {
    // Trackpad taps land wherever the virtual cursor already is — the driver owns it.
    if (s.cfg.mode === "direct") out.push({ k: "cursor", x: s.curX, y: s.curY });
    s.tapButton = button;
    s.phase = Phase.tapHold;
    s.releaseAt = now + TAP_HOLD_MS;
    syncButton(s, now, out);
}

/**
 * End a committed hold. The release is deferred to TAP_HOLD_MS after the down
 * for the same reason a tap holds: a flick-drag whose whole life is 20 ms would
 * otherwise never be observed by a level-polling guest.
 */
function endHold(s: RecognizerState, now: number, out: TouchIntent[]): void {
    const due = s.buttonDownAt + TAP_HOLD_MS;
    if (s.heldButton !== NO_BUTTON && now < due) {
        s.tapButton = s.heldButton;
        s.phase = Phase.tapHold;
        s.releaseAt = due;
        return;
    }
    s.phase = s.count > 0 ? Phase.drain : Phase.idle;
    syncButton(s, now, out);
}

/** A new contact ends any owed release early — back-to-back taps closer than
 *  TAP_HOLD_MS merge their edges, which is the transport's floor anyway. */
function flushOwedRelease(s: RecognizerState, now: number, out: TouchIntent[]): void {
    if (s.phase !== Phase.tapHold) return;
    s.phase = s.count > 0 ? Phase.drain : Phase.idle;
    s.tapButton = NO_BUTTON;
    s.releaseAt = Infinity;
    syncButton(s, now, out);
}

// ─── Two-finger wheel ───────────────────────────────────────────────────────

function pairDistance(s: RecognizerState, a: number, b: number): number {
    const dx = s.cx[a]! - s.cx[b]!;
    const dy = s.cy[a]! - s.cy[b]!;
    return Math.sqrt(dx * dx + dy * dy);
}

/** (Re)seed the tracked pair. `keepAxis` survives a third finger landing or one
 *  of the pair lifting — the axis is latched for the life of the gesture. */
function seedPair(s: RecognizerState, keepAxis: boolean): void {
    const a = s.order[0]!;
    const b = s.order[1]!;
    s.pairA = a;
    s.pairB = b;
    s.baseCy = (s.cy[a]! + s.cy[b]!) / 2;
    s.baseDist = pairDistance(s, a, b);
    if (!keepAxis) s.axis = AXIS_NONE;
    s.ref = s.axis === AXIS_PINCH ? s.baseDist : s.baseCy;
}

function updateWheel(s: RecognizerState, out: TouchIntent[]): void {
    if (s.count < 2) return;
    const a = s.order[0]!;
    const b = s.order[1]!;
    if (a !== s.pairA || b !== s.pairB) seedPair(s, true);

    const mid = (s.cy[a]! + s.cy[b]!) / 2;
    const dist = pairDistance(s, a, b);

    if (s.axis === AXIS_NONE) {
        const pan = Math.abs(mid - s.baseCy);
        const pinch = Math.abs(dist - s.baseDist);
        if (pan < AXIS_LATCH_PX && pinch < AXIS_LATCH_PX) return;
        s.axis = pinch > pan ? AXIS_PINCH : AXIS_PAN;
        // Notches count from the gesture's origin, so the latch classifies without
        // swallowing the travel that paid for it.
        s.ref = s.axis === AXIS_PINCH ? s.baseDist : s.baseCy;
        s.tapCandidate = NO_BUTTON; // a scroll, not a two-finger tap
    }

    const v = s.axis === AXIS_PINCH ? dist : mid;
    // Fingers down / spreading apart are direct manipulation: content follows the
    // fingers, which is a NEGATIVE browser deltaY (scroll up / zoom in).
    while (v - s.ref >= WHEEL_NOTCH_PX) {
        s.ref += WHEEL_NOTCH_PX;
        out.push({ k: "wheel", delta: -WHEEL_NOTCH_DELTA_PX });
    }
    while (v - s.ref <= -WHEEL_NOTCH_PX) {
        s.ref -= WHEEL_NOTCH_PX;
        out.push({ k: "wheel", delta: WHEEL_NOTCH_DELTA_PX });
    }
}

/**
 * Drop contacts whose lift never arrived. A pointerup/pointercancel CAN be lost (the
 * element goes away mid-gesture, the browser drops capture), and the slot table is
 * fixed-size: without this, MAX_CONTACTS lost lifts leave touch permanently dead with no
 * way back — and a lost lift under a held button latches that button forever. Driven from
 * tick() as well as touchdown, so recovery does not depend on the player touching again.
 * Reaped through the cancel path so nothing is resolved as a tap.
 */
function reapStaleContacts(s: RecognizerState, now: number, out: TouchIntent[]): void {
    const limit = s.heldButton === NO_BUTTON ? STALE_CONTACT_MS : STALE_HELD_CONTACT_MS;
    for (let i = s.count - 1; i >= 0; i--) {
        const slot = s.order[i]!;
        if (now - s.seenT[slot]! < limit) continue;
        onCancel(s, { id: s.id[slot]!, phase: "cancel", x: s.cx[slot]!, y: s.cy[slot]! }, now, out);
    }
}

// ─── Event handlers ─────────────────────────────────────────────────────────

function onDown(s: RecognizerState, ev: TouchEvent2, now: number, out: TouchIntent[]): void {
    flushOwedRelease(s, now, out);
    reapStaleContacts(s, now, out);
    const slot = addContact(s, ev.id, ev.x, ev.y);
    if (slot < 0) return;
    s.seenT[slot] = now;

    if (s.phase === Phase.drain) return; // waiting for the previous gesture's fingers to clear

    if (s.count === 1) {
        s.phase = Phase.pending;
        s.startT = now;
        s.lastT = now;
        s.longPressAt = now + LONG_PRESS_MS;
        s.tapCandidate = NO_BUTTON;
        if (s.cfg.mode === "direct") publishCursor(s, ev.x, aimY(s, ev.y), out);
        return;
    }

    // A further contact inside the arbitration window selects a button; the
    // primary's own classification is abandoned (and any button it committed
    // released) because this is one multi-finger gesture, not two.
    const arbitrating = now - s.startT <= ARBITRATION_MS;
    if (s.count === 2) {
        s.tapCandidate = arbitrating ? 2 : NO_BUTTON;
    } else if (s.count === 3 && arbitrating && s.tapCandidate === 2) {
        s.tapCandidate = 1;
    }
    s.longPressAt = Infinity;
    s.phase = Phase.multi;
    syncButton(s, now, out);
    if (s.count === 2) seedPair(s, false);
}

function onMove(s: RecognizerState, ev: TouchEvent2, now: number, out: TouchIntent[]): void {
    const slot = findSlot(s, ev.id);
    if (slot < 0) return;
    const dx = ev.x - s.cx[slot]!;
    const dy = ev.y - s.cy[slot]!;
    s.cx[slot] = ev.x;
    s.cy[slot] = ev.y;
    s.seenT[slot] = now;

    if (s.phase === Phase.multi) {
        updateWheel(s, out);
        return;
    }
    if (slot !== s.order[0]) return; // only the primary steers a single-contact gesture

    switch (s.phase) {
        case Phase.pending: {
            const ox = ev.x - s.sx[slot]!;
            const oy = ev.y - s.sy[slot]!;
            const dist = Math.sqrt(ox * ox + oy * oy);
            if (dist < DRAG_SLOP_PX) {
                followContact(s, ev.x, ev.y, dx, dy, 1, out);
                break;
            }
            const dt = now - s.lastT;
            const speed = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
            s.longPressAt = Infinity; // moved: no longer a still contact
            if (now - s.startT <= DRAG_COMMIT_MS || speed >= FLICK_SPEED_PX_MS) {
                s.phase = Phase.drag;
                // The button edge must be observed AT THE ORIGIN — publish it there and
                // let the next move carry the cursor to the finger, so the down cannot
                // be coalesced into one snapshot with the moved-to position.
                if (s.cfg.mode === "direct") publishCursor(s, s.sx[slot]!, aimY(s, s.sy[slot]!), out);
                syncButton(s, now, out);
                if (s.cfg.mode === "trackpad") publishDelta(s, dx, dy, 1, out);
            } else {
                s.phase = Phase.refine;
                followContact(s, ev.x, ev.y, dx, dy, REFINE_GAIN, out);
            }
            break;
        }
        case Phase.drag:
        case Phase.longPress:
            followContact(s, ev.x, ev.y, dx, dy, 1, out);
            break;
        case Phase.refine:
            followContact(s, ev.x, ev.y, dx, dy, REFINE_GAIN, out);
            break;
        default:
            break;
    }
    s.lastT = now;
}

function onUp(s: RecognizerState, ev: TouchEvent2, now: number, out: TouchIntent[]): void {
    const slot = findSlot(s, ev.id);
    if (slot < 0) return;
    const wasPrimary = slot === s.order[0];
    removeContact(s, slot);

    switch (s.phase) {
        case Phase.pending:
        case Phase.refine:
            // Lift within slop before the long press, or after a precision slide:
            // a tap, resolved at the cursor's final position. A trackpad slide is
            // look/aim, so only an unclassified contact taps there.
            if (!wasPrimary) break;
            if (s.cfg.mode === "trackpad" && s.phase === Phase.refine) {
                s.phase = s.count > 0 ? Phase.drain : Phase.idle;
                s.longPressAt = Infinity;
                syncButton(s, now, out);
                break;
            }
            s.longPressAt = Infinity;
            resolveTap(s, 0, now, out);
            break;

        case Phase.drag:
        case Phase.longPress:
            if (!wasPrimary) break;
            s.longPressAt = Infinity;
            endHold(s, now, out);
            break;

        case Phase.multi:
            if (s.count > 0) break; // the gesture resolves on the lift of ALL contacts
            if (s.tapCandidate !== NO_BUTTON) resolveTap(s, s.tapCandidate, now, out);
            else {
                s.phase = Phase.idle;
                syncButton(s, now, out);
            }
            s.tapCandidate = NO_BUTTON;
            break;

        default:
            if (s.count === 0 && s.phase === Phase.drain) s.phase = Phase.idle;
            break;
    }
}

function onCancel(s: RecognizerState, ev: TouchEvent2, now: number, out: TouchIntent[]): void {
    const slot = findSlot(s, ev.id);
    if (slot < 0) return;
    removeContact(s, slot);

    // An armed long press dies with its contact and emits nothing — it never
    // committed a button. Whatever IS committed is released by syncButton
    // recomputing from the phase the surviving contacts leave us in.
    s.longPressAt = Infinity;
    s.tapCandidate = NO_BUTTON;
    if (s.count === 0) s.phase = Phase.idle;
    else if (s.phase !== Phase.multi) s.phase = Phase.drain;
    syncButton(s, now, out);
}
