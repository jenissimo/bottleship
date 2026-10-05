// Built-in control layouts, as plain data.
//
// Placement rule for the whole set: thumb clusters go in the LETTERBOX BARS, so
// every cluster stays within ~0.42 vmin of its anchored edge (the bar a 4:3 guest
// leaves on a typical phone) and occludes no gameplay. Translucent-over-canvas is
// the fallback for guests whose aspect already matches the device.
//
// The top-right corner belongs to the TouchHud handle — a widget anchored there
// sits underneath it and cannot be pressed, so that corner stays empty.

import type { Binding } from "../bindings";
import type { Anchor, ControlLayout, ControlWidget, DirBindings } from "./types";

const VK = {
    enter: 0x0d, esc: 0x1b, space: 0x20,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28,
    a: 0x41, d: 0x44, e: 0x45, s: 0x53, w: 0x57,
    lctrl: 0xa2,
} as const;

const key = (vk: number): Binding => ({ t: "key", vk });
const mouse = (button: 0 | 1 | 2): Binding => ({ t: "mouse", button });
const pad = (button: number): Binding => ({ t: "pad", button });

const ARROWS: DirBindings = {
    up: key(VK.up), down: key(VK.down), left: key(VK.left), right: key(VK.right),
};
const WASD: DirBindings = {
    up: key(VK.w), down: key(VK.s), left: key(VK.a), right: key(VK.d),
};

/** The whole panel. resolveRects clamps to the panel, so an over-large box is exact. */
const full = () => ({ anchor: "tl", x: 0, y: 0, w: 4, h: 4 }) as const;

const area = (id: string): ControlWidget => ({ kind: "touchArea", id, rect: full() });

function btn(
    id: string, bind: Binding, label: string,
    anchor: Anchor, x: number, y: number, size: number, toggle?: boolean,
): ControlWidget {
    const w: ControlWidget = {
        kind: "button", id,
        // Every button asks for the letterbox bar. Where one exists it costs the
        // player no picture; where it does not (a 16:9 guest filling a 16:9 screen)
        // resolveRects falls back to the panel and flags it as overlapping.
        rect: { anchor, x, y, w: size, h: size, region: "letterbox" }, bind, label,
    };
    if (toggle) w.toggle = true;
    return w;
}

function layout(
    id: string, name: string, orientation: "landscape" | "portrait",
    mode: ControlLayout["mode"], widgets: ControlWidget[],
): ControlLayout {
    return { id, name, version: 1, orientation, mode, widgets };
}

// --- pointer -------------------------------------------------------------
// Point-and-click: the finger is the cursor, plus the two keys every adventure
// of the era needs — skip a cutscene, confirm a dialog.

const pointerLandscape = layout("pointer", "Pointer", "landscape", "direct", [
    area("play"),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.16),
    btn("enter", key(VK.enter), "Enter", "tl", 0.03, 0.21, 0.16),
]);

const pointerPortrait = layout("pointer", "Pointer", "portrait", "direct", [
    area("play"),
    btn("esc", key(VK.esc), "Esc", "bl", 0.05, 0.06, 0.2),
    btn("enter", key(VK.enter), "Enter", "br", 0.05, 0.06, 0.2),
]);

// --- pointer-rmb ---------------------------------------------------------
// Adventures and strategy titles needing a deliberate, non-timed right click
// (verb menus, deselect) and a scroll surface for inventories. RMB is a LATCH:
// a toggled button gives the same "hold right while I click" the desktop does.

const pointerRmbLandscape = layout("pointer-rmb", "Pointer + RMB", "landscape", "direct", [
    area("play"),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.16),
    btn("rmb", mouse(1), "RMB", "br", 0.04, 0.06, 0.2, true),
    { kind: "wheelStrip", id: "wheel", rect: { anchor: "br", x: 0.04, y: 0.32, w: 0.2, h: 0.44, region: "letterbox" }, step: 40 },
]);

const pointerRmbPortrait = layout("pointer-rmb", "Pointer + RMB", "portrait", "direct", [
    area("play"),
    btn("esc", key(VK.esc), "Esc", "bl", 0.05, 0.06, 0.2),
    btn("rmb", mouse(1), "RMB", "br", 0.05, 0.06, 0.24, true),
    { kind: "wheelStrip", id: "wheel", rect: { anchor: "br", x: 0.32, y: 0.06, w: 0.16, h: 0.24, region: "letterbox" }, step: 40 },
]);

// --- wasd-look -----------------------------------------------------------
// The FPS / driving scheme. The trackpad is the WHOLE panel so look is available
// wherever the right thumb lands; the thumb widgets are declared after it and
// therefore claim their own rects first. The momentary LMB button is what gives
// sustained fire — a trackpad tap can only ever produce single shots.

const wasdWidgets = (stick: number, fire: number, small: number, gap: number): ControlWidget[] => [
    { kind: "trackpad", id: "look", rect: full(), taps: true },
    {
        kind: "stick", id: "move", out: "keys", binds: WASD,
        rect: { anchor: "bl", x: 0.02, y: 0.05, w: stick, h: stick, region: "letterbox" },
        deadzone: 0.3, recenter: true,
    },
    btn("fire", mouse(0), "Fire", "br", 0.03, 0.05, fire),
    btn("jump", key(VK.space), "Jump", "br", 0.03, 0.05 + fire + gap, small),
    btn("use", key(VK.e), "Use", "br", 0.03 + small + gap, 0.05 + fire + gap, small),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.14),
];

const wasdLookLandscape = layout("wasd-look", "Move + Look", "landscape", "trackpad",
    wasdWidgets(0.38, 0.26, 0.17, 0.02));

const wasdLookPortrait = layout("wasd-look", "Move + Look", "portrait", "trackpad",
    wasdWidgets(0.46, 0.3, 0.2, 0.02));

// --- dpad-buttons --------------------------------------------------------
// Arrow-key 2D titles: platformers, puzzles, menu-driven RPGs.

const dpadWidgets = (dpadSize: number, big: number, small: number): ControlWidget[] => [
    area("play"),
    {
        kind: "dpad", id: "dpad", binds: ARROWS, diagonals: true,
        rect: { anchor: "bl", x: 0.02, y: 0.05, w: dpadSize, h: dpadSize, region: "letterbox" },
    },
    btn("a", key(VK.space), "Space", "br", 0.03, 0.05, big),
    btn("b", key(VK.lctrl), "Ctrl", "br", 0.03, 0.07 + big, small),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.14),
    btn("enter", key(VK.enter), "Enter", "tl", 0.03, 0.19, 0.14),
];

const dpadButtonsLandscape = layout("dpad-buttons", "D-pad + Buttons", "landscape", "direct",
    dpadWidgets(0.38, 0.22, 0.17));

const dpadButtonsPortrait = layout("dpad-buttons", "D-pad + Buttons", "portrait", "direct",
    dpadWidgets(0.48, 0.26, 0.2));

// --- pad -----------------------------------------------------------------
// Titles that poll a joystick (DirectInput / winmm). Indices are XInput order,
// which is what the SAB gamepad button slot carries.

const padWidgets = (stick: number, face: number, shoulder: number, util: number): ControlWidget[] => {
    // The face diamond shares the stick's vertical centre — the two thumbs rest at
    // the same height on a real pad, and any offset reads as a mistake. Derived, so
    // it stays true when the sizes change.
    const cy = 0.05 + stick / 2;
    // One face width between opposite buttons: adjacent, never overlapping (the
    // 48 px hit floor already grows the targets past their chrome).
    const step = face;
    const row = (centre: number): number => centre - face / 2;
    const topY = 0.03;
    const shoulderH = shoulder * 0.7;
    return [
    area("play"),
    {
        kind: "stick", id: "lstick", out: "pad", axis: 0,
        rect: { anchor: "bl", x: 0.02, y: 0.05, w: stick, h: stick, region: "letterbox" },
        deadzone: 0.18, recenter: true,
    },
    btn("pad-a", pad(0), "A", "br", row(0.215), row(cy - step), face),
    btn("pad-b", pad(1), "B", "br", row(0.215 - step), row(cy), face),
    btn("pad-x", pad(2), "X", "br", row(0.215 + step), row(cy), face),
    btn("pad-y", pad(3), "Y", "br", row(0.215), row(cy + step), face),
    {
        kind: "button", id: "pad-lb", bind: pad(4), label: "LB",
        rect: { anchor: "tl", x: 0.02, y: topY, w: shoulder, h: shoulderH, region: "letterbox" },
    },
    {
        kind: "button", id: "pad-rb", bind: pad(5), label: "RB",
        rect: { anchor: "tr", x: 0.02, y: topY, w: shoulder, h: shoulderH, region: "letterbox" },
    },
    // Centred on the shoulder row, not top-aligned with it: the two are different
    // heights, and equal top insets put their centres visibly out of line.
    btn("pad-back", pad(8), "Back", "tl", 0.04 + shoulder, topY + (shoulderH - util) / 2, util),
    btn("pad-start", pad(9), "Start", "tr", 0.04 + shoulder, topY + (shoulderH - util) / 2, util),
    ];
};

const padLandscape = layout("pad", "Gamepad", "landscape", "direct", padWidgets(0.38, 0.13, 0.2, 0.13));
const padPortrait = layout("pad", "Gamepad", "portrait", "direct", padWidgets(0.46, 0.17, 0.24, 0.16));

export const PRESET_IDS = ["pointer", "pointer-rmb", "wasd-look", "dpad-buttons", "pad"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const BY_ID: Record<PresetId, { landscape: ControlLayout; portrait: ControlLayout }> = {
    "pointer": { landscape: pointerLandscape, portrait: pointerPortrait },
    "pointer-rmb": { landscape: pointerRmbLandscape, portrait: pointerRmbPortrait },
    "wasd-look": { landscape: wasdLookLandscape, portrait: wasdLookPortrait },
    "dpad-buttons": { landscape: dpadButtonsLandscape, portrait: dpadButtonsPortrait },
    "pad": { landscape: padLandscape, portrait: padPortrait },
};

/** Every built-in layout, both orientations. */
export const PRESETS: readonly ControlLayout[] = PRESET_IDS.flatMap(
    (id) => [BY_ID[id].landscape, BY_ID[id].portrait],
);

export const isPresetId = (x: unknown): x is PresetId =>
    typeof x === "string" && (PRESET_IDS as readonly string[]).includes(x);

/** Unknown ids fall back to `pointer` — the layout that suits anything. */
export function getPreset(id: string, orientation: "landscape" | "portrait"): ControlLayout {
    const entry = BY_ID[isPresetId(id) ? id : "pointer"];
    return orientation === "portrait" ? entry.portrait : entry.landscape;
}
