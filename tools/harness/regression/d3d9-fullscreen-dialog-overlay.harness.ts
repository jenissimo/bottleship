/**
 * A 3D device in EXCLUSIVE FULLSCREEN owns the display exactly like a DirectDraw flip
 * chain: GDI paints into an off-screen surface and NO window shows over the frame. Rule 1
 * of dialogOverlayComposites used to ask that question of DirectDraw only, so for a pure
 * D3D9 title it was vacuously true and every live dialog composited.
 *
 * Worms World Party Remastered is the clean case: its menu is drawn by D3D9, while the
 * Win32 side is a 640x480 #32770 whose controls the game never fills — so our overlay
 * holds nothing but an empty grey dialog face, and compositing it covered the top-left
 * quadrant of the menu with a grey slab.
 *
 *   WGB=G:/WGB/todo/worms-world-party-remastered.wgb \
 *     bun tools/harness.ts run tools/harness/regression/d3d9-fullscreen-dialog-overlay.harness.ts
 *
 * Asserts the CONTRACT and its inputs, not the one grey rectangle: the presenter reports
 * exclusive fullscreen, rule 1 says GDI output is off screen, the plan composites nothing —
 * and, as the positive control that the run got far enough to mean anything, the overlay
 * plane really does hold pixels (a plan of 'none' over an empty overlay would pass for the
 * wrong reason) and the menu quadrant the slab used to cover is not grey.
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/todo/worms-world-party-remastered.wgb";

const result: any = await harness()
    .openWgb(WGB)
    .watchFrames(true)
    .tickFrames(600, { timeoutMs: 300_000 })
    // Past the splash into the main menu (its tiles are D3D9 art behind Win32 buttons).
    .clickAt(900, 700)
    .tickFrames(180, { timeoutMs: 120_000 })
    .call("overlay", { save: "wwp-overlay-plane" })
    .call("renderSpace")
    .screenPixels({ x: 40, y: 40, w: 240, h: 160, legend: { g: "#c0c0c0" } })
    .shot({ save: "wwp-menu.png" })
    .run();

const overlay = result.named?.overlay;
const renderSpace = result.named?.renderSpace;
const pixels = result.named?.screenPixels;
const failures: string[] = [];

if (renderSpace?.windowed !== false) {
    failures.push(`device is not fullscreen (renderSpace.windowed=${renderSpace?.windowed}) — the case under test never happened`);
}
if (overlay?.presenter?.exclusiveFullscreen !== true) {
    failures.push(`presenter does not report exclusive fullscreen: ${JSON.stringify(overlay?.presenter)}`);
}
if (overlay?.hasContent !== true) {
    failures.push("the GDI overlay plane is empty — 'composites nothing' would pass for the wrong reason");
}
if (overlay?.gdiOutputOnScreen !== false) {
    failures.push("rule 1 says GDI output reaches the display while a fullscreen 3D device owns it");
}
if (overlay?.plan?.mode !== "none") {
    failures.push(`composite plan is ${JSON.stringify(overlay?.plan)}, expected {mode:'none'}`);
}
if (overlay?.liveDialogs?.length) {
    failures.push(`${overlay.liveDialogs.length} dialog(s) still composite: ${JSON.stringify(overlay.liveDialogs)}`);
}
// The dialog face is the classic COLOR_3DFACE grey; the menu art there is sky blue.
const greyCount = (pixels?.rows ?? []).reduce(
    (n: number, row: string) => n + [...row].filter(c => c === "g").length, 0);
if (greyCount > 0) {
    failures.push(`${greyCount} dialog-grey pixel(s) in the menu quadrant the overlay used to cover`);
}

const badSteps = (result.steps ?? []).filter((s: any) => !s.ok);
if (badSteps.length) failures.push(`${badSteps.length} harness step(s) failed`);

if (failures.length) throw new Error(failures.join("\n"));
console.log(`OK — fullscreen d3d9 presenter, overlay plane has content, plan=none, ${greyCount} grey pixels in the menu.`);
