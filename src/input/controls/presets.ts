// Built-in control layouts, as plain data.
//
// Placement rule for the whole set: thumb clusters go in the LETTERBOX BARS, so
// every cluster stays within ~0.42 vmin of its anchored edge (the bar a 4:3 guest
// leaves on a typical phone) and occludes no gameplay. Translucent-over-canvas is
// the fallback for guests whose aspect already matches the device.
//
// The top-right corner belongs to the TouchHud handle — a widget anchored there
// sits underneath it and cannot be pressed, so that corner stays empty.
//
// The two orientations are DIFFERENT layouts, not one stretched:
//   landscape — the picture fills the height; thumb clusters sit in the side bars,
//               movement on the left, actions on the right, utility keys at the top.
//   portrait  — the picture is pinned to the top and the whole bottom bar below it is
//               the control deck, so every widget is BOTTOM-anchored (there is no top
//               bar to anchor to) and sized up: the deck is roomier than a side bar.
//
// Movement clusters are authored as WASD (sticks) or arrows (d-pads) and retargeted at
// runtime by move-keys.ts to whatever the game or the player chose.

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
    btn("esc", key(VK.esc), "Esc", "bl", 0.06, 0.08, 0.2),
    btn("enter", key(VK.enter), "Enter", "br", 0.06, 0.08, 0.2),
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
    btn("esc", key(VK.esc), "Esc", "bl", 0.06, 0.08, 0.2),
    btn("rmb", mouse(1), "RMB", "br", 0.06, 0.08, 0.24, true),
    { kind: "wheelStrip", id: "wheel", rect: { anchor: "br", x: 0.36, y: 0.08, w: 0.16, h: 0.3, region: "letterbox" }, step: 40 },
]);

// --- wasd-look -----------------------------------------------------------
// The FPS / driving scheme. The trackpad is the WHOLE panel so look is available
// wherever the right thumb lands; the thumb widgets are declared after it and
// therefore claim their own rects first. The momentary LMB button is what gives
// sustained fire — a trackpad tap can only ever produce single shots.

/**
 * The movement stick FLOATS: its hit zone is the whole bar on its side (half the deck in
 * portrait), and the base re-centres under the thumb wherever it lands. A fixed stick
 * punishes a thumb that lands 1 cm off — that contact either misses or starts at full
 * deflection — and a phone gives no tactile edge to find the centre by.
 */
const moveStick = (anchor: Anchor, x: number, y: number, size: number): ControlWidget => ({
    kind: "stick", id: "move", out: "keys", binds: WASD,
    rect: { anchor, x, y, w: size, h: size, region: "letterbox" },
    deadzone: 0.25, recenter: true, float: true,
});

/** Fire is the primary action, so it is the biggest target and sits where the right
 *  thumb rests; the secondary pair sits in one row above it, the cluster no wider than
 *  that row — it has to fit a landscape side bar and the right half of the portrait deck. */
const actionCluster = (x: number, y: number, fire: number, small: number, gap: number): ControlWidget[] => [
    btn("fire", mouse(0), "Fire", "br", x + (2 * small + gap - fire) / 2, y, fire),
    btn("jump", key(VK.space), "Jump", "br", x, y + fire + gap, small),
    btn("use", key(VK.e), "Use", "br", x + small + gap, y + fire + gap, small),
];

const wasdLookLandscape = layout("wasd-look", "Move + Look", "landscape", "trackpad", [
    { kind: "trackpad", id: "look", rect: full(), taps: true },
    moveStick("bl", 0.03, 0.06, 0.36),
    ...actionCluster(0.03, 0.06, 0.25, 0.15, 0.03),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.15),
]);

const wasdLookPortrait = layout("wasd-look", "Move + Look", "portrait", "trackpad", [
    { kind: "trackpad", id: "look", rect: full(), taps: true },
    moveStick("bl", 0.05, 0.1, 0.42),
    // Stacked, not side by side: a Use button beside Fire lands in the gap the stick's
    // thumb sweeps through, and the right half of the deck is the right thumb's.
    ...actionCluster(0.05, 0.1, 0.27, 0.19, 0.03),
    btn("esc", key(VK.esc), "Esc", "bl", 0.05, 0.62, 0.15),
]);

// --- dpad-buttons --------------------------------------------------------
// Arrow-key 2D titles: platformers, puzzles, menu-driven RPGs.

const dpad = (anchor: Anchor, x: number, y: number, size: number): ControlWidget => ({
    kind: "dpad", id: "dpad", binds: ARROWS, diagonals: true,
    rect: { anchor, x, y, w: size, h: size, region: "letterbox" },
});

const dpadButtonsLandscape = layout("dpad-buttons", "D-pad + Buttons", "landscape", "direct", [
    area("play"),
    dpad("bl", 0.03, 0.06, 0.38),
    btn("a", key(VK.space), "Space", "br", 0.03, 0.06, 0.22),
    btn("b", key(VK.lctrl), "Ctrl", "br", 0.03, 0.31, 0.17),
    btn("esc", key(VK.esc), "Esc", "tl", 0.03, 0.03, 0.15),
    btn("enter", key(VK.enter), "Enter", "tl", 0.03, 0.21, 0.15),
]);

const dpadButtonsPortrait = layout("dpad-buttons", "D-pad + Buttons", "portrait", "direct", [
    area("play"),
    dpad("bl", 0.05, 0.1, 0.44),
    btn("a", key(VK.space), "Space", "br", 0.05, 0.1, 0.26),
    btn("b", key(VK.lctrl), "Ctrl", "br", 0.05 + (0.26 - 0.19) / 2, 0.1 + 0.26 + 0.03, 0.19),
    btn("esc", key(VK.esc), "Esc", "bl", 0.05, 0.62, 0.15),
    btn("enter", key(VK.enter), "Enter", "bl", 0.23, 0.62, 0.15),
]);

// --- pad -----------------------------------------------------------------
// Titles that poll a joystick (DirectInput / winmm). Indices are XInput order,
// which is what the SAB gamepad button slot carries.

const padWidgets = (
    stick: number, face: number, shoulder: number, util: number, portrait = false,
): ControlWidget[] => {
    const baseY = portrait ? 0.1 : 0.05;
    // The face diamond shares the stick's vertical centre — the two thumbs rest at
    // the same height on a real pad, and any offset reads as a mistake. Derived, so
    // it stays true when the sizes change.
    const cy = baseY + stick / 2;
    // One face width between opposite buttons: adjacent, never overlapping (the
    // 48 px hit floor already grows the targets past their chrome).
    const step = face;
    const row = (centre: number): number => centre - face / 2;
    // Landscape: shoulders along the top of the side bars. Portrait has no top bar, so
    // they ride the top edge of the deck instead (bottom-anchored, above the clusters).
    const topY = portrait ? baseY + stick + 0.06 : 0.03;
    const topL: Anchor = portrait ? "bl" : "tl";
    const topR: Anchor = portrait ? "br" : "tr";
    const shoulderH = shoulder * 0.7;
    return [
    area("play"),
    {
        kind: "stick", id: "lstick", out: "pad", axis: 0,
        rect: { anchor: "bl", x: 0.03, y: baseY, w: stick, h: stick, region: "letterbox" },
        deadzone: 0.18, recenter: true, float: true,
    },
    btn("pad-a", pad(0), "A", "br", row(0.215), row(cy - step), face),
    btn("pad-b", pad(1), "B", "br", row(0.215 - step), row(cy), face),
    btn("pad-x", pad(2), "X", "br", row(0.215 + step), row(cy), face),
    btn("pad-y", pad(3), "Y", "br", row(0.215), row(cy + step), face),
    {
        kind: "button", id: "pad-lb", bind: pad(4), label: "LB",
        rect: { anchor: topL, x: 0.03, y: topY, w: shoulder, h: shoulderH, region: "letterbox" },
    },
    {
        kind: "button", id: "pad-rb", bind: pad(5), label: "RB",
        rect: { anchor: topR, x: 0.03, y: topY, w: shoulder, h: shoulderH, region: "letterbox" },
    },
    // Centred on the shoulder row, not top-aligned with it: the two are different
    // heights, and equal top insets put their centres visibly out of line.
    btn("pad-back", pad(8), "Back", topL, 0.05 + shoulder, topY + (shoulderH - util) / 2, util),
    btn("pad-start", pad(9), "Start", topR, 0.05 + shoulder, topY + (shoulderH - util) / 2, util),
    ];
};

const padLandscape = layout("pad", "Gamepad", "landscape", "direct", padWidgets(0.36, 0.13, 0.2, 0.13));
const padPortrait = layout("pad", "Gamepad", "portrait", "direct", padWidgets(0.42, 0.16, 0.24, 0.15, true));

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
