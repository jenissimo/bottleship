/**
 * Dialog chrome must never be published ahead of the guest's own paint.
 *
 * USER's default chrome — the COLOR_BTNFACE dialog face and the OS-drawn look of every
 * control — is the ELSE branch of a window's paint cycle: DefDlgProc answers WM_PAINT
 * with BeginPaint/EndPaint and draws it only when the window's own paint reached the
 * overlay with nothing. Anything that stamps it as a PROLOGUE puts grey on screen for
 * however long the guest's WM_PAINT takes to be pumped, and the guest's art then replaces
 * it. The pixels are correct at both ends, so only the ORDER shows the bug.
 *
 * The Half-Life Day One launcher is the fixture because every menu state is its own
 * full-screen `#32770` whose client the guest paints (wall art + owner-draw entries): a
 * new dialog per transition, and nothing but the guest can draw a single pixel of it.
 *
 *   WGB=g:/WGB/running/hl-day-one.wgb bun tools/harness.ts run tools/harness/regression/hl-dayone-menu-chrome.harness.ts
 *
 * Confirmed able to fail: `setWorkerFlag('__noDeferDialogChrome', true)` restores the
 * eager stamp, and this script then reports 9 chrome stamps (a 640x480 dlgface + 8
 * controls) before the guest's first flush.
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/hl-day-one.wgb";
/** The main menu's "Configure Half-Life" entry — guest px, centre of its owner-draw tile. */
const MENU_ENTRY = { x: 120, y: 250 };

/** Visible full-screen dialogs (with their children) + whether one has painted its client. */
const SNAPSHOT = `
  const ss = await import("/src/worker/modules/user32/shared-state.ts");
  const hex = (h) => "0x" + (h >>> 0).toString(16);
  const dialogs = {};
  let ready = false;
  for (const [h, w] of ss.windows) {
    if (!w.visible) continue;
    if (w.nativeClassName === "#32770" && w.width >= 600 && w.height >= 400) {
      dialogs[hex(h)] = (w.children || []).map(hex);
      if (w.guestCustomPaint) ready = true;
    }
  }
  return { dialogs, ready };
`;

interface Snap { dialogs: Record<string, string[]>; ready: boolean }
const snapshot = async (): Promise<Snap> => {
    const r: any = await harness().call("evalWorker", SNAPSHOT).run();
    return r.steps[0].result;
};

// ── boot ────────────────────────────────────────────────────────────────────────────
// The launcher's controls exist from WM_INITDIALOG, minutes before the Sierra splash
// clears — so "the control exists" reports ready while the screen still shows the
// splash, and the click lands on nothing. Gate on the launcher having PAINTED instead.
await harness().openWgb(WGB).sleep(20000).run();
let booted = false;
for (let i = 0; i < 40 && !booted; i++) {
    booted = (await snapshot()).ready;
    if (!booted) await harness().sleep(5000).run();
}
if (!booted) throw new Error("the Half-Life launcher menu never painted — nothing to measure");
await harness().sleep(4000).run();

const before = await snapshot();

// ── the transition ──────────────────────────────────────────────────────────────────
const run: any = await harness()
    .paintTrace("clear").paintTrace("start")
    .move(MENU_ENTRY.x, MENU_ENTRY.y).sleep(400)
    .clickHold(MENU_ENTRY.x, MENU_ENTRY.y, 200)
    .sleep(4000)
    .paintTrace("read")
    .run();

const trace = run.steps.filter((s: any) => s.cmd === "paintTrace")[2]?.result;
const lines: string[] = trace?.lines ?? [];
const events = lines
    .map((l) => /^(\d+) (\w+) hwnd=0x([0-9a-f]+) (.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ t: +m![1], ev: m![2], hwnd: "0x" + m![3], rest: m![4] }));

const after = await snapshot();
const fresh = Object.keys(after.dialogs).filter((h) => !(h in before.dialogs));

// A pass has to mean "chrome never preceded the paint", not "nothing happened". If the
// click opened no new dialog, or that dialog never flushed a paint, the screen is
// whatever it was and the ordering was never exercised — say so instead of passing.
if (fresh.length !== 1) {
    throw new Error(
        `expected exactly one new full-screen dialog after clicking the menu entry, got ${fresh.length}`
        + ` (before=${Object.keys(before.dialogs).join(",")} after=${Object.keys(after.dialogs).join(",")}).`
        + " The click missed, or the launcher is not on its main menu.",
    );
}
const dlg = fresh[0];
// The anchor is where the window's paint cycle STARTS. Chrome drawn from inside that
// cycle is Windows' own order (background, then the OS-owned controls on top of it, all
// under one publish hold); chrome drawn BEFORE it is the prologue that flashes.
const anchor = events.find((e) => e.hwnd === dlg && e.ev === "beginPaint");
const flush = events.find((e) => e.hwnd === dlg && e.ev === "endPaint" && /flush=1/.test(e.rest));
if (!anchor || !flush) {
    throw new Error(
        `the new dialog ${dlg} never ${anchor ? "flushed" : "began"} a paint of its own in`
        + ` ${events.length} traced events — its art never reached the overlay, so this run`
        + " says nothing about paint ORDER.",
    );
}

// A control's default 3-D look is chrome too, and it is recorded against the CHILD's
// hwnd — so the subtree, not just the dialog.
const subtree = new Set<string>([dlg, ...(after.dialogs[dlg] ?? [])]);
const chrome = events.filter((e) => e.ev === "chrome" && subtree.has(e.hwnd));
const early = chrome.filter((e) => e.t < anchor.t);

console.log(`new dialog ${dlg}: paint cycle begins t=${anchor.t}, art flushed t=${flush.t}`);
console.log(`chrome stamps BEFORE the paint cycle: ${early.length}`);
for (const c of early) console.log(`   ${c.t} ${c.hwnd} ${c.rest}`);
console.log(`chrome stamps inside/after it (OS-owned controls over the guest's background — correct): ${chrome.length - early.length}`);

if (early.length) {
    throw new Error(
        `default chrome was published ${anchor.t - early[0].t}ms before the new dialog's paint`
        + ` cycle even began (${early.length} stamps, first: ${early[0].hwnd} ${early[0].rest}).`
        + " That is the grey flash: USER's default paint must be the else-branch of the"
        + " window's paint cycle, not a prologue to it.",
    );
}
console.log("OK — the guest's art was the first thing published for the new menu state");
