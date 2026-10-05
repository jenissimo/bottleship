/**
 * On-screen control layouts: total validation, anchor resolution, the 48 px
 * finger floor, and the built-in presets.
 *
 * Pure data + geometry — no DOM, no React, no input device.
 */

import { describe, expect, test } from "bun:test";
import {
    MIN_HIT_PX,
    pickRect,
    resolveRects,
    validateLayout,
    type ControlLayout,
} from "../../src/input/controls/types";
import { PRESETS, PRESET_IDS, getPreset } from "../../src/input/controls/presets";

// An 844x390 landscape phone: a 4:3 guest leaves two ~162 px letterbox bars.
const PANEL = { left: 0, top: 0, width: 844, height: 390 };
const UNIT = 390;

const wrap = (widgets: unknown[]): unknown => ({
    id: "t", name: "T", version: 1, widgets,
});

const okLayout = (widgets: unknown[]): ControlLayout => {
    const l = validateLayout(wrap(widgets));
    expect(l).not.toBeNull();
    return l!;
};

describe("validateLayout", () => {
    test("rejects only non-layouts", () => {
        expect(validateLayout(null)).toBeNull();
        expect(validateLayout(42)).toBeNull();
        expect(validateLayout([])).toBeNull();
        expect(validateLayout({ id: "x" })).toBeNull();          // no widgets array
        expect(validateLayout({ widgets: [] })).toBeNull();      // no id
        expect(validateLayout({ id: "x", widgets: [] })).not.toBeNull();
    });

    test("never throws on hostile input", () => {
        const hostile: unknown[] = [
            undefined, "", 0, true, Symbol.iterator, () => 0,
            { id: "x", widgets: [null, 1, "a", [], { kind: 7 }] },
            { id: "x", widgets: [{ kind: "button" }] },
            { id: {}, widgets: [] },
            { id: "x", widgets: {} },
        ];
        for (const x of hostile) expect(() => validateLayout(x)).not.toThrow();
    });

    test("drops junk widgets but keeps the good ones", () => {
        const l = okLayout([
            { kind: "button", id: "a", rect: { anchor: "tl", x: 0, y: 0, w: 0.2, h: 0.2 }, bind: { t: "key", vk: 0x1b } },
            { kind: "button", id: "b", rect: { anchor: "tl", x: 0, y: 0, w: 0.2, h: 0.2 } },          // no bind
            { kind: "button", id: "c", rect: { anchor: "tl", x: 0, y: 0, w: 0.2, h: 0.2 }, bind: { t: "key", vk: 900 } },
            { kind: "dpad", id: "d", rect: { anchor: "bl", x: 0, y: 0, w: 0.4, h: 0.4 }, binds: { up: { t: "key", vk: 1 } } },
            { kind: "stick", id: "e", rect: { anchor: "bl", x: 0, y: 0, w: 0.4, h: 0.4 }, out: "keys" }, // keys w/o binds
            { kind: "touchArea", id: "f", rect: { anchor: "tl", x: 0, y: 0, w: 4, h: 4 } },
        ]);
        expect(l.widgets.map((w) => w.id)).toEqual(["a", "f"]);
    });

    test("drops out-of-range and malformed placements", () => {
        const l = okLayout([
            { kind: "touchArea", id: "ok", rect: { anchor: "c", x: -1, y: 1, w: 0.5, h: 0.5 } },
            { kind: "touchArea", id: "huge", rect: { anchor: "tl", x: 0, y: 0, w: 99, h: 1 } },
            { kind: "touchArea", id: "zero", rect: { anchor: "tl", x: 0, y: 0, w: 0, h: 1 } },
            { kind: "touchArea", id: "nan", rect: { anchor: "tl", x: Number.NaN, y: 0, w: 1, h: 1 } },
            { kind: "touchArea", id: "far", rect: { anchor: "tl", x: 50, y: 0, w: 1, h: 1 } },
            { kind: "touchArea", id: "anchor", rect: { anchor: "middle", x: 0, y: 0, w: 1, h: 1 } },
            { kind: "touchArea", id: "norect" },
        ]);
        expect(l.widgets.map((w) => w.id)).toEqual(["ok"]);
    });

    test("drops duplicate ids, keeping the first", () => {
        const mk = (label: string) => ({
            kind: "button", id: "dup", label,
            rect: { anchor: "tl", x: 0, y: 0, w: 0.2, h: 0.2 },
            bind: { t: "key", vk: 0x41 },
        });
        const l = okLayout([mk("first"), mk("second")]);
        expect(l.widgets).toHaveLength(1);
        expect(l.widgets[0]).toMatchObject({ id: "dup", label: "first" });
    });

    test("survives a layout authored by a NEWER tool", () => {
        // Higher version, unknown widget kinds, unknown widget fields, unknown
        // top-level fields, unknown binding type — none may cost us the layout.
        const l = validateLayout({
            id: "future",
            name: "Future",
            version: 7,
            orientation: "landscape",
            mode: "trackpad",
            theme: "neon",
            widgets: [
                { kind: "gyroTilt", id: "g", rect: { anchor: "tl", x: 0, y: 0, w: 0.3, h: 0.3 }, axis: "pitch" },
                {
                    kind: "button", id: "fire", label: "Fire",
                    rect: { anchor: "br", x: 0.03, y: 0.05, w: 0.26, h: 0.26, radius: 12 },
                    bind: { t: "mouse", button: 0 },
                    haptics: "medium", repeatHz: 8,
                },
                { kind: "button", id: "weird", rect: { anchor: "br", x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, bind: { t: "gyro", axis: 1 } },
            ],
        });
        expect(l).not.toBeNull();
        expect(l!.version).toBe(1);
        expect(l!.orientation).toBe("landscape");
        expect(l!.mode).toBe("trackpad");
        expect(l!.widgets.map((w) => w.id)).toEqual(["fire"]);
    });

    test("bad orientation/mode degrade to unset, not to a dead layout", () => {
        const l = validateLayout({ id: "x", widgets: [], orientation: "sideways", mode: "psychic" });
        expect(l).not.toBeNull();
        expect(l!.orientation).toBeUndefined();
        expect(l!.mode).toBeUndefined();
    });

    test("a revalidated layout is identical (idempotent)", () => {
        for (const preset of PRESETS) {
            expect(validateLayout(JSON.parse(JSON.stringify(preset)))).toEqual(preset);
        }
    });
});

describe("resolveRects anchoring", () => {
    // 0.2 vmin = 78 px, comfortably over the 48 px floor so anchoring is measured
    // without the expansion interfering.
    const at = (anchor: string) => okLayout([
        { kind: "touchArea", id: anchor, rect: { anchor, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    ]);
    const size = 0.2 * UNIT;   // 78
    const inset = 0.1 * UNIT;  // 39

    test("tl", () => {
        const r = resolveRects(at("tl"), PANEL);
        expect(Array.from(r)).toEqual([inset, inset, size, size]);
    });

    test("tr", () => {
        const r = resolveRects(at("tr"), PANEL);
        expect(Array.from(r)).toEqual([PANEL.width - inset - size, inset, size, size]);
    });

    test("bl", () => {
        const r = resolveRects(at("bl"), PANEL);
        expect(Array.from(r)).toEqual([inset, PANEL.height - inset - size, size, size]);
    });

    test("br", () => {
        const r = resolveRects(at("br"), PANEL);
        expect(Array.from(r)).toEqual([
            PANEL.width - inset - size, PANEL.height - inset - size, size, size,
        ]);
    });

    test("c offsets the widget CENTRE from the panel centre", () => {
        const r = resolveRects(at("c"), PANEL);
        expect(Array.from(r)).toEqual([
            PANEL.width / 2 + inset - size / 2,
            PANEL.height / 2 + inset - size / 2,
            size, size,
        ]);
    });

    test("client coordinates carry the panel origin", () => {
        const l = at("tl");
        const r = resolveRects(l, { ...PANEL, left: 100, top: 50 });
        expect(r[0]).toBe(100 + inset);
        expect(r[1]).toBe(50 + inset);
    });

    test("sizes scale with min(panelW, panelH), so one layout fits both devices", () => {
        const l = at("br");
        const phone = resolveRects(l, { left: 0, top: 0, width: 844, height: 390 });
        const tablet = resolveRects(l, { left: 0, top: 0, width: 2732, height: 2048 });
        // Float32Array storage, so compare with a tolerance rather than exactly.
        expect(phone[2]).toBeCloseTo(0.2 * 390, 3);
        expect(tablet[2]).toBeCloseTo(0.2 * 2048, 3);
        // Same fraction of the short edge on both.
        expect(phone[2] / 390).toBeCloseTo(tablet[2] / 2048, 5);
    });

    test("an over-large widget clamps to the panel", () => {
        const l = okLayout([{ kind: "touchArea", id: "full", rect: { anchor: "tl", x: 0, y: 0, w: 4, h: 4 } }]);
        const r = resolveRects(l, PANEL);
        expect(Array.from(r)).toEqual([0, 0, PANEL.width, PANEL.height]);
    });

    test("reuses the caller's array (no per-resize allocation churn)", () => {
        const l = at("tl");
        const buf = new Float32Array(64);
        expect(resolveRects(l, PANEL, MIN_HIT_PX, buf)).toBe(buf);
    });
});

describe("48 px minimum hit target", () => {
    const tiny = okLayout([
        // 0.02 vmin = 7.8 px visually — deliberately far under the floor.
        { kind: "button", id: "tiny", rect: { anchor: "c", x: 0, y: 0, w: 0.02, h: 0.02 }, bind: { t: "key", vk: 0x1b } },
    ]);

    test("hit rects are never smaller than the finger floor", () => {
        const r = resolveRects(tiny, PANEL);
        expect(r[2]).toBe(MIN_HIT_PX);
        expect(r[3]).toBe(MIN_HIT_PX);
    });

    test("expansion is centred on the visual rect", () => {
        const hit = resolveRects(tiny, PANEL);
        const vis = resolveRects(tiny, PANEL, 0);
        expect(hit[0] + hit[2] / 2).toBeCloseTo(vis[0] + vis[2] / 2, 3);
        expect(hit[1] + hit[3] / 2).toBeCloseTo(vis[1] + vis[3] / 2, 3);
    });

    test("minHitPx 0 yields the authored geometry for chrome", () => {
        const vis = resolveRects(tiny, PANEL, 0);
        expect(vis[2]).toBeCloseTo(0.02 * UNIT, 3);
    });

    test("a corner widget keeps its full target instead of losing half off-panel", () => {
        const corner = okLayout([
            { kind: "button", id: "c", rect: { anchor: "tl", x: 0, y: 0, w: 0.02, h: 0.02 }, bind: { t: "key", vk: 0x1b } },
        ]);
        const r = resolveRects(corner, PANEL);
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(0);
        expect(r[2]).toBe(MIN_HIT_PX);
        expect(r[3]).toBe(MIN_HIT_PX);
    });

    test("every preset widget is finger-sized once resolved", () => {
        for (const preset of PRESETS) {
            const panel = preset.orientation === "portrait"
                ? { left: 0, top: 0, width: 390, height: 844 }
                : PANEL;
            const r = resolveRects(preset, panel);
            for (let i = 0; i < preset.widgets.length; i++) {
                const label = `${preset.id}/${preset.orientation}/${preset.widgets[i].id}`;
                expect(`${label}:${r[i * 4 + 2] >= MIN_HIT_PX}`).toBe(`${label}:true`);
                expect(`${label}:${r[i * 4 + 3] >= MIN_HIT_PX}`).toBe(`${label}:true`);
            }
        }
    });
});

describe("pickRect", () => {
    const l = okLayout([
        { kind: "touchArea", id: "area", rect: { anchor: "tl", x: 0, y: 0, w: 4, h: 4 } },
        { kind: "button", id: "esc", rect: { anchor: "tl", x: 0.03, y: 0.03, w: 0.16, h: 0.16 }, bind: { t: "key", vk: 0x1b } },
    ]);
    const rects = resolveRects(l, PANEL);

    test("the topmost (last declared) widget wins an overlap", () => {
        const esc = 1;
        const cx = rects[esc * 4] + rects[esc * 4 + 2] / 2;
        const cy = rects[esc * 4 + 1] + rects[esc * 4 + 3] / 2;
        expect(pickRect(rects, l.widgets.length, cx, cy)).toBe(esc);
    });

    test("a point outside every rect is -1", () => {
        const bare = resolveRects(okLayout([
            { kind: "button", id: "b", rect: { anchor: "tl", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, bind: { t: "key", vk: 0x1b } },
        ]), PANEL);
        expect(pickRect(bare, 1, 800, 380)).toBe(-1);
    });
});

describe("presets", () => {
    test("all validate unchanged", () => {
        for (const preset of PRESETS) {
            const v = validateLayout(preset);
            expect(v).not.toBeNull();
            expect(v!.widgets).toHaveLength(preset.widgets.length);
        }
    });

    test("every id has a landscape and a portrait variant", () => {
        for (const id of PRESET_IDS) {
            expect(getPreset(id, "landscape").orientation).toBe("landscape");
            expect(getPreset(id, "portrait").orientation).toBe("portrait");
            expect(getPreset(id, "landscape").id).toBe(id);
        }
        expect(PRESETS).toHaveLength(PRESET_IDS.length * 2);
    });

    test("an unknown id falls back to pointer", () => {
        expect(getPreset("nope", "landscape").id).toBe("pointer");
    });

    test("wasd-look binds movement keys, a look surface and a sustained-fire button", () => {
        const l = getPreset("wasd-look", "landscape");
        const move = l.widgets.find((w) => w.id === "move");
        expect(move).toMatchObject({ kind: "stick", out: "keys" });
        expect(move!.kind === "stick" && move!.binds?.up).toEqual({ t: "key", vk: 0x57 });
        expect(l.widgets.find((w) => w.id === "look")).toMatchObject({ kind: "trackpad" });
        // Momentary, NOT a toggle: an FPS needs the button held to keep firing.
        const fire = l.widgets.find((w) => w.id === "fire");
        expect(fire).toMatchObject({ kind: "button", bind: { t: "mouse", button: 0 } });
        expect(fire!.kind === "button" && fire!.toggle).toBeUndefined();
    });

    test("pointer-rmb has a sticky RMB and a wheel strip", () => {
        for (const orientation of ["landscape", "portrait"] as const) {
            const l = getPreset("pointer-rmb", orientation);
            expect(l.widgets.find((w) => w.id === "rmb")).toMatchObject({
                kind: "button", bind: { t: "mouse", button: 1 }, toggle: true,
            });
            expect(l.widgets.find((w) => w.id === "wheel")).toMatchObject({ kind: "wheelStrip" });
        }
    });

    test("dpad-buttons binds the arrow keys with diagonals", () => {
        const dpad = getPreset("dpad-buttons", "landscape").widgets.find((w) => w.id === "dpad");
        expect(dpad).toMatchObject({
            kind: "dpad", diagonals: true,
            binds: { up: { t: "key", vk: 0x26 }, left: { t: "key", vk: 0x25 } },
        });
    });

    test("pad emits pad bindings only", () => {
        const l = getPreset("pad", "landscape");
        const buttons = l.widgets.filter((w) => w.kind === "button");
        expect(buttons.length).toBeGreaterThanOrEqual(6);
        for (const b of buttons) expect(b.kind === "button" && b.bind.t).toBe("pad");
        expect(l.widgets.find((w) => w.id === "lstick")).toMatchObject({ kind: "stick", out: "pad", axis: 0 });
    });

    test("landscape thumb clusters stay in the side letterbox bars of a 4:3 guest", () => {
        // 844x390: the guest occupies the middle 520 px, so x < 162 and x >= 682
        // are free. Widgets anchored left/right must not intrude on gameplay.
        const guestLeft = (844 - 390 * 4 / 3) / 2;
        const guestRight = 844 - guestLeft;
        for (const id of PRESET_IDS) {
            const l = getPreset(id, "landscape");
            const r = resolveRects(l, PANEL);
            for (let i = 0; i < l.widgets.length; i++) {
                const w = l.widgets[i];
                // Full-panel surfaces are transparent by design.
                if (w.kind === "touchArea" || w.kind === "trackpad") continue;
                const tag = `${id}/${w.id}`;
                if (w.rect.anchor === "tl" || w.rect.anchor === "bl") {
                    expect(`${tag}:${r[i * 4] + r[i * 4 + 2] <= guestLeft + 1}`).toBe(`${tag}:true`);
                } else if (w.rect.anchor === "tr" || w.rect.anchor === "br") {
                    expect(`${tag}:${r[i * 4] >= guestRight - 1}`).toBe(`${tag}:true`);
                }
            }
        }
    });

    test("portrait thumb clusters stay in the top/bottom letterbox bars", () => {
        // 390x844: a 4:3 guest is 390x292.5, leaving ~276 px above and below.
        const panel = { left: 0, top: 0, width: 390, height: 844 };
        const guestTop = (844 - 390 * 3 / 4) / 2;
        const guestBottom = 844 - guestTop;
        for (const id of PRESET_IDS) {
            const l = getPreset(id, "portrait");
            const r = resolveRects(l, panel);
            for (let i = 0; i < l.widgets.length; i++) {
                const w = l.widgets[i];
                if (w.kind === "touchArea" || w.kind === "trackpad") continue;
                const tag = `${id}/${w.id}`;
                if (w.rect.anchor === "tl" || w.rect.anchor === "tr") {
                    expect(`${tag}:${r[i * 4 + 1] + r[i * 4 + 3] <= guestTop + 1}`).toBe(`${tag}:true`);
                } else if (w.rect.anchor === "bl" || w.rect.anchor === "br") {
                    expect(`${tag}:${r[i * 4 + 1] >= guestBottom - 1}`).toBe(`${tag}:true`);
                }
            }
        }
    });
});

describe("letterbox placement", () => {
    const panel = { left: 0, top: 0, width: 844, height: 390 };
    // A 4:3 guest on a 16:9-ish phone: two ~162 px bars.
    const canvas43 = { left: 162, top: 0, width: 520, height: 390 };
    // A 16:9 guest on the same phone fills it: no bars anywhere.
    const canvas169 = { left: 0, top: 0, width: 844, height: 390 };

    const oneWidget = (region?: "panel" | "letterbox"): ControlLayout => ({
        id: "t", name: "t", version: 1,
        widgets: [{
            kind: "button", id: "b", bind: { t: "key", vk: 0x1b }, label: "Esc",
            rect: { anchor: "bl", x: 0.02, y: 0.05, w: 0.2, h: 0.2, ...(region ? { region } : {}) },
        }],
    });

    test("a letterbox widget lands inside the bar, clear of the picture", () => {
        const over = new Uint8Array(1);
        const r = resolveRects(oneWidget("letterbox"), panel, { canvas: canvas43, overCanvas: over });
        expect(r[0]! + r[2]!).toBeLessThanOrEqual(canvas43.left + 0.5);
        expect(over[0]).toBe(0);
    });

    test("with no bar the widget falls back to the panel and is reported", () => {
        const over = new Uint8Array(1);
        const r = resolveRects(oneWidget("letterbox"), panel, { canvas: canvas169, overCanvas: over });
        expect(over[0]).toBe(1);
        // Still on the panel and still a usable target.
        expect(r[0]!).toBeGreaterThanOrEqual(0);
        expect(r[2]!).toBeGreaterThanOrEqual(MIN_HIT_PX);
    });

    test("a panel-region widget ignores the bars entirely", () => {
        const a = resolveRects(oneWidget(), panel, { canvas: canvas43 });
        const b = resolveRects(oneWidget(), panel, { canvas: canvas169 });
        expect(Array.from(a)).toEqual(Array.from(b));
    });

    test("without a canvas rect the letterbox request is inert, not broken", () => {
        const over = new Uint8Array(1);
        const r = resolveRects(oneWidget("letterbox"), panel, { overCanvas: over });
        expect(over[0]).toBe(0);
        expect(r[2]!).toBeGreaterThanOrEqual(MIN_HIT_PX);
    });
});

describe("reserved regions", () => {
    const panel = { left: 0, top: 0, width: 844, height: 390 };
    const hud = { left: 844 - 52, top: 8, width: 44, height: 44 };

    const corner = (): ControlLayout => ({
        id: "t", name: "t", version: 1,
        widgets: [{
            kind: "button", id: "enter", bind: { t: "key", vk: 0x0d }, label: "Enter",
            rect: { anchor: "tr", x: 0.03, y: 0.03, w: 0.16, h: 0.16 },
        }],
    });

    test("a widget under a shell affordance is slid clear of it", () => {
        const bare = resolveRects(corner(), panel, {});
        const moved = resolveRects(corner(), panel, { reserved: [hud] });
        const overlaps = (r: Float32Array) =>
            !(r[0]! >= hud.left + hud.width || r[0]! + r[2]! <= hud.left
                || r[1]! >= hud.top + hud.height || r[1]! + r[3]! <= hud.top);
        expect(overlaps(bare)).toBe(true);
        expect(overlaps(moved)).toBe(false);
        // Slid, not shrunk: the target keeps its full size.
        expect(moved[2]).toBe(bare[2]);
        expect(moved[3]).toBe(bare[3]);
    });

    test("a widget nowhere near a reserved rect is untouched", () => {
        const far: ControlLayout = {
            id: "t", name: "t", version: 1,
            widgets: [{
                kind: "button", id: "esc", bind: { t: "key", vk: 0x1b }, label: "Esc",
                rect: { anchor: "bl", x: 0.03, y: 0.03, w: 0.16, h: 0.16 },
            }],
        };
        const a = resolveRects(far, panel, {});
        const b = resolveRects(far, panel, { reserved: [hud] });
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

describe("pad preset alignment", () => {
    const panel = { left: 0, top: 0, width: 1386, height: 740 };

    const centreY = (r: Float32Array, i: number): number => r[i * 4 + 1]! + r[i * 4 + 3]! / 2;
    const indexOf = (l: ControlLayout, id: string): number => l.widgets.findIndex((w) => w.id === id);

    test("the face diamond shares the stick's vertical centre", () => {
        const l = getPreset("pad", "landscape");
        const r = resolveRects(l, panel, { minHitPx: 0 });
        const stick = centreY(r, indexOf(l, "lstick"));
        const a = centreY(r, indexOf(l, "pad-a"));
        const y = centreY(r, indexOf(l, "pad-y"));
        // A above, Y below, midpoint on the stick's centre line.
        expect(Math.abs((a + y) / 2 - stick)).toBeLessThan(1);
    });

    test("B and X sit on one row, A and Y on one column", () => {
        const l = getPreset("pad", "landscape");
        const r = resolveRects(l, panel, { minHitPx: 0 });
        const b = indexOf(l, "pad-b");
        const x = indexOf(l, "pad-x");
        expect(Math.abs(centreY(r, b) - centreY(r, x))).toBeLessThan(1);
        const cx = (i: number) => r[i * 4]! + r[i * 4 + 2]! / 2;
        expect(Math.abs(cx(indexOf(l, "pad-a")) - cx(indexOf(l, "pad-y")))).toBeLessThan(1);
    });

    test("a corner affordance never pushes one widget onto its neighbour", () => {
        const hud = { left: panel.width - 52, top: 8, width: 44, height: 44 };
        const l = getPreset("pad", "landscape");
        const r = resolveRects(l, panel, { minHitPx: 0, reserved: [hud] });
        const box = (id: string) => {
            const i = indexOf(l, id);
            return { x: r[i * 4]!, w: r[i * 4 + 2]! };
        };
        const rb = box("pad-rb");
        const start = box("pad-start");
        // Start is authored to the LEFT of RB; the inset must move both, not collide them.
        expect(start.x + start.w).toBeLessThanOrEqual(rb.x + 0.5);
        // And RB must still clear the affordance itself.
        expect(rb.x + box("pad-rb").w).toBeLessThanOrEqual(hud.left + 0.5);
    });

    test("a corner affordance moves the whole row, keeping its spacing", () => {
        const hud = { left: panel.width - 52, top: 8, width: 44, height: 44 };
        const l = getPreset("pad", "landscape");
        const bare = resolveRects(l, panel, { minHitPx: 0 });
        const moved = resolveRects(l, panel, { minHitPx: 0, reserved: [hud] });
        const rb = indexOf(l, "pad-rb");
        const start = indexOf(l, "pad-start");
        // The shoulder moved sideways...
        expect(moved[rb * 4]).not.toBe(bare[rb * 4]);
        // ...and still shares the row with Start.
        expect(Math.abs(centreY(moved, rb) - centreY(moved, start))).toBeLessThan(1);
    });
});
