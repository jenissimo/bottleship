// On-screen control layouts: pure data + total validation + geometry resolution.
// No DOM, no React, no input device — importable from `bun test`.
//
// Geometry is normalized to the PANEL, and a widget may additionally ask to live
// in the LETTERBOX bar on its side (`rect.region`). Where the bars are — and
// whether they exist at all — is measured at resolve time from the panel and the
// picture, never assumed: a 4:3 guest on a wide phone leaves bars that hold a thumb
// cluster for free, a 16:9 guest on a 16:9 screen leaves none and the same layout
// has to sit over the picture instead.
//
// Sizes and offsets are in `min(panelW, panelH)` units, so one authored layout is
// correct on a 390x844 phone and on a 2732x2048 tablet.

import { parseBinding, type Binding } from "../bindings";

export type Anchor = "tl" | "tr" | "bl" | "br" | "c";

/**
 * Placement relative to one panel corner (or the centre), in vmin units.
 * `x`/`y` are insets from the anchored edges — from the panel centre to the
 * widget centre for "c" — and `w`/`h` are the visual size.
 */
export interface Anchored {
    anchor: Anchor;
    x: number;
    y: number;
    w: number;
    h: number;
    /**
     * Which box the anchor measures from.
     *   panel     — the whole panel (default).
     *   letterbox — the bar between the panel edge and the picture on the anchored
     *               side, so a thumb cluster occludes no gameplay. Whether a bar
     *               EXISTS is a runtime fact, not a property of the layout: a 16:9
     *               guest on a 16:9 screen has none, and the widget then falls back
     *               to the panel and is reported as sitting over the picture.
     */
    region?: "panel" | "letterbox";
}

export interface DirBindings {
    up: Binding;
    down: Binding;
    left: Binding;
    right: Binding;
}

export type StickOut = "keys" | "pad" | "mouse";
export type LayoutMode = "auto" | "direct" | "trackpad";
export type LayoutOrientation = "any" | "landscape" | "portrait";

export type ControlWidget =
    /** Declares gameplay area: the hit test deliberately does NOT claim it, so the
     *  touch translator keeps the contact. This is how a layout punches holes. */
    | { kind: "touchArea"; id: string; rect: Anchored }
    | {
        kind: "button"; id: string; rect: Anchored; bind: Binding;
        label?: string; icon?: string;
        /** Latches on tap instead of following the contact. */
        toggle?: boolean;
        /** Activates while a contact that started elsewhere slides over it. */
        slide?: boolean;
    }
    | { kind: "dpad"; id: string; rect: Anchored; binds: DirBindings; diagonals?: boolean }
    | {
        kind: "stick"; id: string; rect: Anchored; out: StickOut;
        binds?: DirBindings;
        /** First pad axis of the pair, for out:"pad". */
        axis?: 0 | 2;
        deadzone?: number;
        sensitivity?: number;
        /** Re-centre on the touchdown point rather than the widget centre. */
        recenter?: boolean;
    }
    | { kind: "trackpad"; id: string; rect: Anchored; taps?: boolean }
    | { kind: "wheelStrip"; id: string; rect: Anchored; step?: number };

export type ControlWidgetKind = ControlWidget["kind"];

export interface ControlLayout {
    id: string;
    name: string;
    version: 1;
    orientation?: LayoutOrientation;
    mode?: LayoutMode;
    /** Paint and hit-test order: later widgets sit on top of earlier ones. */
    widgets: ControlWidget[];
}

/**
 * A finger is ~9 mm across; anything smaller than this is a miss generator no
 * matter how small the chrome is drawn. Applied to the HIT rect only, so the
 * visual size an author chose is preserved.
 */
export const MIN_HIT_PX = 48;

/**
 * Placement bound in vmin units. Generous rather than tight: a full-panel widget
 * on a 21:9 phone is ~2.4 units wide, so the limit only rejects nonsense.
 */
const MAX_UNITS = 4;

const ANCHORS: readonly Anchor[] = ["tl", "tr", "bl", "br", "c"];
const STICK_OUTS: readonly StickOut[] = ["keys", "pad", "mouse"];
const MODES: readonly LayoutMode[] = ["auto", "direct", "trackpad"];
const ORIENTATIONS: readonly LayoutOrientation[] = ["any", "landscape", "portrait"];

const rec = (x: unknown): Record<string, unknown> | null =>
    x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null;

function parseAnchored(x: unknown): Anchored | null {
    const r = rec(x);
    if (!r) return null;
    const anchor = r["anchor"];
    if (!ANCHORS.includes(anchor as Anchor)) return null;
    const px = num(r["x"], -MAX_UNITS, MAX_UNITS);
    const py = num(r["y"], -MAX_UNITS, MAX_UNITS);
    const w = num(r["w"], Number.MIN_VALUE, MAX_UNITS);
    const h = num(r["h"], Number.MIN_VALUE, MAX_UNITS);
    if (px === null || py === null || w === null || h === null) return null;
    const out: Anchored = { anchor: anchor as Anchor, x: px, y: py, w, h };
    if (r["region"] === "letterbox" || r["region"] === "panel") out.region = r["region"];
    return out;
}

function parseDirBindings(x: unknown): DirBindings | null {
    const r = rec(x);
    if (!r) return null;
    const up = parseBinding(r["up"]);
    const down = parseBinding(r["down"]);
    const left = parseBinding(r["left"]);
    const right = parseBinding(r["right"]);
    if (!up || !down || !left || !right) return null;
    return { up, down, left, right };
}

function parseWidget(x: unknown): ControlWidget | null {
    const r = rec(x);
    if (!r) return null;
    const id = str(r["id"]);
    const rect = parseAnchored(r["rect"]);
    if (!id || !rect) return null;

    switch (r["kind"]) {
        case "touchArea":
            return { kind: "touchArea", id, rect };
        case "button": {
            const bind = parseBinding(r["bind"]);
            if (!bind) return null;
            const w: ControlWidget = { kind: "button", id, rect, bind };
            const label = str(r["label"]);
            if (label) w.label = label;
            const icon = str(r["icon"]);
            if (icon) w.icon = icon;
            if (r["toggle"] === true) w.toggle = true;
            if (r["slide"] === true) w.slide = true;
            return w;
        }
        case "dpad": {
            const binds = parseDirBindings(r["binds"]);
            if (!binds) return null;
            return { kind: "dpad", id, rect, binds, diagonals: r["diagonals"] !== false };
        }
        case "stick": {
            const out = r["out"];
            if (!STICK_OUTS.includes(out as StickOut)) return null;
            const w: ControlWidget = { kind: "stick", id, rect, out: out as StickOut };
            const binds = parseDirBindings(r["binds"]);
            if (binds) w.binds = binds;
            // out:"keys" without directions would be a widget that does nothing.
            if (w.out === "keys" && !binds) return null;
            if (r["axis"] === 0 || r["axis"] === 2) w.axis = r["axis"];
            const deadzone = num(r["deadzone"], 0, 0.9);
            if (deadzone !== null) w.deadzone = deadzone;
            const sensitivity = num(r["sensitivity"], 0.05, 20);
            if (sensitivity !== null) w.sensitivity = sensitivity;
            if (r["recenter"] === true) w.recenter = true;
            return w;
        }
        case "trackpad":
            return { kind: "trackpad", id, rect, taps: r["taps"] !== false };
        case "wheelStrip": {
            const step = num(r["step"], 4, 400);
            return { kind: "wheelStrip", id, rect, step: step ?? 40 };
        }
        default:
            return null;
    }
}

/**
 * Total: returns null only when there is no layout at all. Individual widgets
 * that fail — unknown kind, junk binding, out-of-range placement, duplicate id —
 * are DROPPED, because bundles and localStorage entries are authored by both
 * older and newer builds than the one reading them, and losing one widget beats
 * losing every control on screen.
 *
 * A `version` above 1 is accepted for the same reason: every widget is validated
 * independently, so a future revision can only contribute shapes we drop here.
 */
export function validateLayout(x: unknown): ControlLayout | null {
    const r = rec(x);
    if (!r) return null;
    const id = str(r["id"]);
    if (!id) return null;
    if (!Array.isArray(r["widgets"])) return null;
    if (r["version"] !== undefined && num(r["version"], 1, 1e6) === null) return null;

    const widgets: ControlWidget[] = [];
    const seen = new Set<string>();
    for (const raw of r["widgets"]) {
        const w = parseWidget(raw);
        if (!w || seen.has(w.id)) continue;
        seen.add(w.id);
        widgets.push(w);
    }

    const layout: ControlLayout = {
        id,
        name: str(r["name"]) ?? id,
        version: 1,
        widgets,
    };
    if (ORIENTATIONS.includes(r["orientation"] as LayoutOrientation)) {
        layout.orientation = r["orientation"] as LayoutOrientation;
    }
    if (MODES.includes(r["mode"] as LayoutMode)) layout.mode = r["mode"] as LayoutMode;
    return layout;
}

export interface PanelRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ResolveOptions {
    /** Finger floor for hit rects; pass 0 for the authored geometry when drawing. */
    minHitPx?: number;
    /** The picture inside the panel. Without it `region: "letterbox"` is inert. */
    canvas?: PanelRect | null;
    /**
     * Areas the shell owns (the HUD handle, the status chip). An overlapping widget
     * is SLID out: an unreachable control is worse than a moved one, and a placement
     * rule that lives only in a comment is a rule that gets broken.
     */
    reserved?: readonly PanelRect[];
    /** Filled with 1 where a widget sits over the picture rather than in a bar. */
    overCanvas?: Uint8Array;
}

/** A bar narrower than a fingertip is not a place to put controls. */
const MIN_BAR_PX = MIN_HIT_PX;

/**
 * Flat [x, y, w, h] per widget in CLIENT coordinates — the array the driver's hit
 * test reads. Flat and reusable on purpose: this is recomputed on layout change
 * and on resize, never per contact, and a contact must not allocate to be routed.
 */
export function resolveRects(
    layout: ControlLayout,
    panel: PanelRect,
    opts: ResolveOptions | number = {},
    out?: Float32Array,
): Float32Array {
    const cfg = typeof opts === "number" ? { minHitPx: opts } : opts;
    const minHitPx = cfg.minHitPx ?? MIN_HIT_PX;
    const n = layout.widgets.length;
    const rects = out && out.length >= n * 4 ? out : new Float32Array(n * 4);
    const W = Math.max(0, panel.width);
    const H = Math.max(0, panel.height);
    const unit = Math.min(W, H);

    // Bars between the panel edge and the picture, in panel coordinates. All zero
    // when the guest's aspect already matches the screen — a 16:9 title on a 16:9
    // phone has nowhere free, and letterbox widgets then fall back to the panel.
    const cv = cfg.canvas;
    const barL = cv ? Math.max(0, cv.left - panel.left) : 0;
    const barR = cv ? Math.max(0, panel.left + W - (cv.left + cv.width)) : 0;
    const barT = cv ? Math.max(0, cv.top - panel.top) : 0;
    const barB = cv ? Math.max(0, panel.top + H - (cv.top + cv.height)) : 0;

    for (let i = 0; i < n; i++) {
        const r = layout.widgets[i].rect;
        const vw = r.w * unit;
        const vh = r.h * unit;

        // The box the anchor measures from: the panel, or the bar on a side this
        // corner touches (the roomier one, when both qualify).
        let bx = 0, by = 0, bw = W, bh = H;
        let inBar = false;
        if (r.region === "letterbox" && r.anchor !== "c") {
            const left = r.anchor[1] === "l";
            const top = r.anchor[0] === "t";
            const horiz = left ? barL : barR;
            const vert = top ? barT : barB;
            const horizFits = horiz >= Math.max(MIN_BAR_PX, vw);
            const vertFits = vert >= Math.max(MIN_BAR_PX, vh);
            if (horizFits && (!vertFits || horiz >= vert)) {
                bx = left ? 0 : W - horiz;
                bw = horiz;
                inBar = true;
            } else if (vertFits) {
                by = top ? 0 : H - vert;
                bh = vert;
                inBar = true;
            }
        }
        if (cfg.overCanvas && i < cfg.overCanvas.length) cfg.overCanvas[i] = inBar || !cv ? 0 : 1;

        // Vertical placement first: it never depends on the horizontal inset, and
        // knowing the widget's band is what decides whether a reserved rect is even
        // in its way.
        let hh = Math.min(Math.max(vh, minHitPx), H);
        let y: number;
        switch (r.anchor) {
            case "tl": case "tr": y = by + r.y * unit; break;
            case "bl": case "br": y = by + bh - r.y * unit - vh; break;
            case "c": y = by + bh / 2 + r.y * unit - vh / 2; break;
        }
        y -= (hh - vh) / 2;
        y = Math.max(0, Math.min(H - hh, y));

        // A reserved rect INSETS THE ANCHOR EDGE rather than displacing the widget.
        // Displacing one widget clears the affordance and drops it straight onto its
        // neighbour; moving the edge moves the whole row together, so the spacing the
        // author chose survives. Only widgets sharing the corner and overlapping the
        // rect's band are affected.
        if (r.anchor !== "c") {
            const right = r.anchor[1] === "r";
            for (const res of cfg.reserved ?? []) {
                const rx = res.left - panel.left;
                const ry = res.top - panel.top;
                if (y >= ry + res.height || y + hh <= ry) continue;
                if (rx >= bx + bw || rx + res.width <= bx) continue;
                if (right) {
                    // Only the space LEFT of the affordance is addressable from the
                    // right edge — including the sliver beyond it, which is too narrow
                    // to hold anything anyway.
                    bw = Math.max(0, Math.min(bw, rx - bx));
                } else {
                    const edge = Math.max(bx, rx + res.width);
                    bw = Math.max(0, bw - (edge - bx));
                    bx = edge;
                }
            }
        }

        let x: number;
        switch (r.anchor) {
            case "tl": case "bl": x = bx + r.x * unit; break;
            case "tr": case "br": x = bx + bw - r.x * unit - vw; break;
            case "c": x = bx + bw / 2 + r.x * unit - vw / 2; break;
        }
        // Grow around the visual centre, then slide (not shrink) back inside the
        // panel: a corner widget must keep its full target, not lose the half that
        // grew past the edge.
        let hw = Math.min(Math.max(vw, minHitPx), W);
        x -= (hw - vw) / 2;
        x = Math.max(0, Math.min(W - hw, x));
        if (!Number.isFinite(x)) x = 0;
        if (!Number.isFinite(y)) y = 0;
        if (!Number.isFinite(hw)) hw = 0;
        if (!Number.isFinite(hh)) hh = 0;

        const o = i * 4;
        rects[o] = panel.left + x;
        rects[o + 1] = panel.top + y;
        rects[o + 2] = hw;
        rects[o + 3] = hh;
    }
    return rects;
}

/** Topmost widget index under a client point, or -1. Later widgets win. */
export function pickRect(rects: Float32Array, count: number, clientX: number, clientY: number): number {
    for (let i = count - 1; i >= 0; i--) {
        const o = i * 4;
        const x = rects[o];
        const y = rects[o + 1];
        if (clientX >= x && clientX < x + rects[o + 2] && clientY >= y && clientY < y + rects[o + 3]) {
            return i;
        }
    }
    return -1;
}
