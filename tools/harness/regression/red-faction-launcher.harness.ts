/**
 * Red Faction launcher regression: the MFC launcher's art must actually get drawn —
 * and must SURVIVE a click.
 *
 * The launcher is a `#32770` that MFC subclasses with AfxWndProc; its own OnPaint
 * punts to CWnd::Default(), so every pixel of it — the background StretchBlt in
 * OnEraseBkgnd and the six CBitmapButton tiles — arrives only if that chain lands in
 * DefDlgProc → BeginPaint/EndPaint. Hand a subclasser the app's DlgProc instead of
 * DefDlgProc and the window stays blank grey with no error anywhere.
 *
 * Second half: a CBitmapButton answers a click with `Invalidate()`. Only the GUEST can
 * redraw an owner-draw tile (WM_DRAWITEM), so a JS repaint that puts the parent's whole
 * retained client back — the guest's WM_PAINT output, tiles NOT included — deletes all
 * eight tiles and nothing can ask for them again. That reads as a launcher whose art
 * survives and whose labels vanish, and no log line says so; only the pixels do.
 *
 * The same click's OTHER half: leaving the tile alone is not enough — the invalidate has
 * to reach the guest as WM_DRAWITEM, or the tile is frozen at the last full paint. The
 * pixels cannot tell "unchanged" from "stale", so that link is asserted on the trace.
 * Confirm it can fail with `setWorkerFlag('__noOwnerDrawPaintRequest', true)`.
 *
 *   WGB=g:/WGB/running/red-faction.wgb bun tools/harness.ts run tools/harness/regression/red-faction-launcher.harness.ts
 */

import { harness } from "../../harness";

/**
 * Per-rect luminance stddev of the live canvas. A drawn tile carries glyphs/logo
 * (high contrast); the bare background under it is near-flat, so a wiped tile shows
 * up as a COLLAPSED stddev even when the mean barely moves (grey text on grey stone).
 */
const rectStdDev = (rects: Array<{ x: number; y: number; w: number; h: number }>) => `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const g = document.createElement('canvas');
    g.width = c.width; g.height = c.height;
    const ctx = g.getContext('2d');
    ctx.drawImage(c, 0, 0);
    return { cw: c.width, ch: c.height, sd: ${JSON.stringify(rects)}.map(t => {
        const d = ctx.getImageData(t.x, t.y, t.w, t.h).data;
        let s = 0, s2 = 0; const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
            const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
            s += l; s2 += l * l;
        }
        return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    }) };
})()`;

const result: any = await harness()
    // First run shows a "you will now be taken to Setup" MessageBoxEx; the guest is
    // parked in it and cannot paint until it is answered.
    .onModal(".*", "ok")
    .openWgb(process.env.WGB ?? "/apps/external-wgb/red-faction.wgb")
    .call("paintTrace", ["start"])
    .waitForControl("Play", { timeoutMs: 120000 })
    .sleep(8000)
    .call("paintTrace", ["read"])
    .state(["windows", "screen"])
    .run();

const trace = result.steps?.find((s: any) => s.cmd === "paintTrace" && s.result?.lines)?.result;
const lines: string[] = trace?.lines ?? [];
console.log(`paintTrace: ${lines.length} entries`);
for (const l of lines) console.log("  " + l);

const erased = lines.some((l) => l.includes("beginPaint") && l.includes("fErase=1"));
const flushed = lines.some((l) => l.includes("endPaint") && l.includes("flush=1"));
const tiles = lines.some((l) => /chain .*drawitem=[1-9]/.test(l) && l.includes("dispatched"));

if (!erased || !flushed || !tiles) {
    throw new Error(
        "launcher's WM_PAINT died before the default paint chain "
        + `(erase=${erased} flush=${flushed} drawitem=${tiles})`,
    );
}
console.log("OK — background erased, painted client flushed, button tiles drawn");

// ---- the tiles must survive a click ------------------------------------------------
const state = result.steps?.find((s: any) => s.cmd === "state")?.result;
const wins: any[] = state?.windows ?? [];
const dlg = wins.find((w) => w.cls === "#32770");
const buttons = wins.filter((w) => w.parent === dlg?.hwnd && w.cls === "Button" && w.visible);
if (buttons.length < 6) throw new Error(`launcher has ${buttons.length} buttons, expected >= 6`);

const screen = state?.screen;
const rects = buttons.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
const before: any = await harness().evalPage(rectStdDev(rects)).run();
const b0 = before.steps?.[0]?.result;
if (!b0?.sd) throw new Error("could not read the canvas");
// Canvas backing store is the guest screen, so window coords index it 1:1. If that ever
// stops holding, every rect below is sampling the wrong pixels — say so, do not "pass".
if (screen?.canvasWidth && b0.cw !== screen.canvasWidth) {
    throw new Error(`page canvas ${b0.cw}x${b0.ch} != worker canvas ${screen.canvasWidth}x${screen.canvasHeight} — rects would not line up`);
}

// Click Setup: our PropertySheetA is a no-op sheet, so the launcher is on screen again
// within a second and nothing else has changed — anything the tiles lost is ours.
const clickRun: any = await harness()
    .call("paintTrace", ["start"])
    .click("Setup")
    .sleep(4000)
    .call("paintTrace", ["read"])
    .state(["windows"])
    .run();

// ---- the invalidate must ASK for the tile back -------------------------------------
// The CBitmapButton answers the click with Invalidate(). On Windows that ends in the
// BUTTON proc's WM_PAINT → WM_DRAWITEM to the parent (Wine dlls/user32/button.c
// OB_Paint) — the only thing that can produce an owner-draw tile's pixels. Leaving the
// tile ALONE is only half of it; a repaint nobody runs is a tile frozen at whatever the
// last full paint drew (no pressed, hover or disabled state ever lands), and the pixel
// check below cannot tell an unchanged tile from a stale one.
const clickTrace: string[] =
    clickRun.steps?.filter((s: any) => s.cmd === "paintTrace").pop()?.result?.lines ?? [];
const btnHwnds = new Set(buttons.map((b) => `0x${(b.hwnd >>> 0).toString(16)}`));
const hwndOf = (l: string) => l.match(/hwnd=(0x[0-9a-f]+)/)?.[1] ?? "";
const asked = clickTrace.filter((l) => / (post|skip) .*owner-draw button/.test(l));
const drawn = clickTrace.filter((l) => /chain .*drawitem=1 .*-> \S+ dispatched/.test(l));
const drawnButtons = new Set(drawn.map(hwndOf).filter((h) => btnHwnds.has(h)));
console.log(`  invalidate→paint: ${asked.length} request(s), ${drawnButtons.size} tile(s) redrawn`);
for (const l of [...asked, ...drawn]) console.log("    " + l);
if (drawnButtons.size === 0) {
    throw new Error("the click never reached the guest as WM_DRAWITEM for any launcher button "
        + `(${asked.length} paint request(s) on an owner-draw button, `
        + `${drawn.length} chain(s) in total) — either InvalidateRect no longer asks for the `
        + "tile back, or the launcher stopped invalidating and this check is watching nothing");
}
console.log("OK — the invalidate reached the guest as WM_DRAWITEM");

// ---- and the tiles must still be there ---------------------------------------------
// Setup opens a property sheet ON TOP of the launcher. Sampling the tiles under it reads
// the sheet, not the launcher — so close it first, and say which it was if it will not go
// rather than reporting its grey as a wiped tile.
// A dialog, not a control: it has children of its own and is owned by the launcher (or
// by nothing) — a page inside the sheet goes away with it.
const covers = (w: any) => w.visible && w.hwnd !== dlg?.hwnd && w.childCount > 0
    && (w.parent == null || w.parent === dlg?.hwnd)
    && rects.some((r) => w.x < r.x + r.w && w.x + w.w > r.x && w.y < r.y + r.h && w.y + w.h > r.y);
const sheet = (clickRun.steps?.filter((s: any) => s.cmd === "state").pop()?.result?.windows ?? [])
    .find(covers);
if (sheet) {
    console.log(`  a ${sheet.cls} "${sheet.title}" covers the tiles — closing it`);
    const closed: any = await harness().key("Escape").sleep(2500).state(["windows"]).run();
    const still = (closed.steps?.filter((s: any) => s.cmd === "state").pop()?.result?.windows ?? [])
        .find((w: any) => w.hwnd === sheet.hwnd && w.visible);
    if (still) {
        throw new Error(`"${sheet.title}" (${sheet.cls}) still covers the launcher after Escape — `
            + "the tiles under it cannot be sampled");
    }
}

const after: any = await harness().evalPage(rectStdDev(rects)).run();
const a0 = after.steps?.[0]?.result;
if (!a0?.sd) throw new Error("could not read the canvas after the click");

const lost: string[] = [];
for (let i = 0; i < buttons.length; i++) {
    const bs = b0.sd[i], as = a0.sd[i];
    console.log(`  ${buttons[i].title.padEnd(10)} stddev ${bs.toFixed(1)} -> ${as.toFixed(1)}`);
    // A drawn tile is textured; a wiped one drops to the flat stone under it. 60% is far
    // below any legitimate redraw (pressed/normal states differ by a few percent) and far
    // above the collapse a wipe produces (measured: 40+ -> under 10).
    if (bs > 8 && as < bs * 0.6) lost.push(`${buttons[i].title} ${bs.toFixed(1)}->${as.toFixed(1)}`);
}
if (lost.length) {
    throw new Error(`owner-draw tiles wiped by the click (only the guest can redraw them): ${lost.join(", ")}`);
}
console.log("OK — every owner-draw tile survived the Setup click");
