/**
 * Red Faction SETUP — the comctl32 property sheet, end to end.
 *
 * The sheet is an MFC one, which means PSH_MODELESS: `PropertySheet()` must return
 * the frame HWND and let MFC's own modal loop pump it. Everything downstream hangs
 * off that — the pages are child `#32770`s created on demand, MFC attaches its
 * CPropertyPage through the HCBT_CREATEWND we fire for each one (skip it and every
 * control is laid out perfectly and completely empty), and the tab control's chrome
 * must not stamp over the page window that sits inside its own rect.
 *
 * What this asserts, and why each one can actually fail:
 *  1. The frame exists with a SysTabControl32 carrying one tab per page.
 *  2. The active page's pixels are on SCREEN. A blank pane is the exact symptom of
 *     the tab control repainting over the page; `__noSiblingClip` reproduces it.
 *  3. Clicking a tab moves the selection, creates+shows the new page, and changes
 *     the pixels — mouse hit-test, page activation and repaint in one.
 *  4. The PSN_* protocol really ran: the trace names each notification and the
 *     page's verdict, because none of it is visible any other way.
 *  5. Clicking a radio repaints THAT radio pair and nothing else. Win32's BM_SETCHECK
 *     invalidates the buttons whose check state moved; re-stamping the page's other
 *     controls is visible because this page guest-paints its client, so a re-stamp has
 *     no background to erase with and every label lands on its own predecessor.
 *  6. Cancel asks PSN_QUERYCANCEL, resets every CREATED page, and the sheet goes.
 *
 *   WGB=g:/WGB/running/red-faction.wgb bun tools/harness.ts run tools/harness/regression/red-faction-propsheet.harness.ts
 */

import { harness } from "../../harness";

/** Luminance stddev of a screen rect: a laid-out page is textured, an empty pane is flat. */
const rectStdDev = (r: { x: number; y: number; w: number; h: number }) => `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const g = document.createElement('canvas');
    g.width = c.width; g.height = c.height;
    const x = g.getContext('2d'); x.drawImage(c, 0, 0);
    if (${r.x} < 0 || ${r.y} < 0 || ${r.x + r.w} > c.width || ${r.y + r.h} > c.height) return null;
    const d = x.getImageData(${r.x}, ${r.y}, ${r.w}, ${r.h}).data;
    let s = 0, s2 = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
        const l = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        s += l; s2 += l*l;
    }
    return { cw: c.width, mean: +(s/n).toFixed(2), sd: +Math.sqrt(Math.max(0, s2/n - (s/n)**2)).toFixed(2) };
})()`;

/** One POJO describing the live sheet: frame, tab layout, pages, notification trace. */
const SHEET_STATE = `
    const ss = await import('/src/worker/modules/user32/shared-state.ts');
    const tc = await import('/src/worker/modules/user32/tab-control.ts');
    const ps = await import('/src/worker/modules/comctl32-propsheet.ts');
    const tab = [...ss.windows.values()].find(
        w => (w.systemControlClass ?? '').toLowerCase() === 'systabcontrol32');
    const trace = ps.getPropSheetNotifyTrace();
    if (!tab) return { tab: null, trace };
    const st = tc.ensureTabLayout(tab);
    const abs = ss.getAbsoluteWindowPosition(tab);
    const frame = ss.windows.get(tab.parent);
    const pages = frame.children
        .map(h => ss.windows.get(h))
        .filter(w => w && !w.isSystemControl && w.nativeClassName === '#32770')
        .map(w => ({ title: w.title, hwnd: w.handle, visible: w.visible,
                     x: ss.getAbsoluteWindowPosition(w).x, y: ss.getAbsoluteWindowPosition(w).y,
                     w: w.width, h: w.height, kids: w.children.length }));
    const pageRect = (() => {
        const d = tc.adjustTabRect(tab, false, { left: 0, top: 0, right: tab.width, bottom: tab.height });
        return { x: abs.x + d.left, y: abs.y + d.top, w: d.right - d.left, h: d.bottom - d.top };
    })();
    return {
        tab: tab.handle, frame: frame.handle,
        tabs: st.items.map(i => i.text), curSel: st.curSel, rows: st.rowCount,
        rects: st.items.map((_, i) => {
            const r = tc.tabItemRect(tab, i);
            return { x: abs.x + r.left, y: abs.y + r.top, w: r.right - r.left, h: r.bottom - r.top };
        }),
        pageRect, pages, trace,
        diag: ps.formatPropSheetDiagnostic(),
    };
`;

const fail = (msg: string): never => { throw new Error(msg); };

// ---------------------------------------------------------------- open the sheet
const open: any = await harness()
    .onModal(".*", "ok")
    .openWgb(process.env.WGB ?? "/apps/external-wgb/red-faction.wgb")
    .waitForControl("Play", { timeoutMs: 180000 })
    .sleep(6000)
    .click("Setup")
    .sleep(8000)
    .call("evalWorker", [SHEET_STATE])
    .run();

const s0 = open.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
if (!s0?.tab) fail("no SysTabControl32 — the property sheet never came up");
console.log(`sheet: ${s0.diag}`);
console.log(`tabs (${s0.rows} row): ${s0.tabs.join(" | ")}  curSel=${s0.curSel}`);

if (s0.tabs.length < 2) fail(`tab control has ${s0.tabs.length} tab(s); RF's Setup has 6`);
if (s0.curSel !== 0) fail(`initial selection is ${s0.curSel}, expected page 0`);
const shown = s0.pages.filter((p: any) => p.visible);
if (shown.length !== 1) {
    fail(`${shown.length} page(s) visible, expected exactly the active one `
        + `(${s0.pages.map((p: any) => `${p.title}:${p.visible}`).join(",")})`);
}
if (shown[0].kids === 0) fail(`the active page "${shown[0].title}" has no controls`);

// ---- (2) the active page's pixels are on screen ----------------------------------
const probe = { x: s0.pageRect.x + 6, y: s0.pageRect.y + 6, w: s0.pageRect.w - 12, h: s0.pageRect.h - 12 };
const px0: any = (await harness().evalPage(rectStdDev(probe)).run()).steps?.[0]?.result;
if (!px0) fail("could not read the canvas over the page rect");
console.log(`page "${shown[0].title}" pixels: mean=${px0.mean} sd=${px0.sd}`);
// A laid-out page carries labels, edges and edit fields; an empty pane is one flat grey.
// Measured: 37.8 with the page drawn, exactly 0.00 with it erased.
if (px0.sd < 8) {
    fail(`the active page is BLANK (sd=${px0.sd}) — its pixels were painted and then `
        + "overwritten (tab-control chrome stamping over the page window?)");
}

// ---- (3) switch tabs with the mouse ----------------------------------------------
const target = Math.min(3, s0.tabs.length - 1);
const r = s0.rects[target];
const switched: any = await harness()
    .clickAt(Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2))
    .sleep(4000)
    .call("evalWorker", [SHEET_STATE])
    .run();
const s1 = switched.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
if (!s1?.tab) fail("the tab control vanished after a tab click");
console.log(`after clicking "${s0.tabs[target]}": curSel=${s1.curSel} — ${s1.diag}`);
if (s1.curSel !== target) {
    fail(`clicking tab ${target} ("${s0.tabs[target]}") left curSel=${s1.curSel} `
        + "— the hit test or TCN_SELCHANGE did not land");
}
const nowShown = s1.pages.filter((p: any) => p.visible);
if (nowShown.length !== 1 || nowShown[0].title === shown[0].title) {
    fail(`page activation did not follow the tab (visible: `
        + `${s1.pages.map((p: any) => `${p.title}:${p.visible}`).join(",")})`);
}
if (nowShown[0].kids === 0) fail(`the newly activated page "${nowShown[0].title}" has no controls`);

const px1: any = (await harness().evalPage(rectStdDev(probe)).run()).steps?.[0]?.result;
console.log(`page "${nowShown[0].title}" pixels: mean=${px1.mean} sd=${px1.sd}`);
if (px1.sd < 8) fail(`the newly activated page is BLANK (sd=${px1.sd})`);
if (Math.abs(px1.mean - px0.mean) < 0.5 && Math.abs(px1.sd - px0.sd) < 0.5) {
    fail("the pane's pixels are unchanged across the page switch — the old page is "
        + "still on screen even though the sheet says the new one is active");
}

// ---- (4) the PSN_ protocol actually ran ------------------------------------------
const trace: string[] = s1.trace ?? [];
console.log(`notifications (${trace.length}):`);
for (const t of trace) console.log("  " + t);
const has = (code: string) => trace.some((t) => t.includes(code));
if (!has("PSN_SETACTIVE")) fail("no PSN_SETACTIVE was delivered — pages were never activated");
if (!has("PSN_KILLACTIVE")) {
    fail("switching pages delivered no PSN_KILLACTIVE — the page was never given "
        + "its documented chance to refuse");
}
const setActives = trace.filter((t) => t.includes("PSN_SETACTIVE")).length;
if (setActives < 2) fail(`only ${setActives} PSN_SETACTIVE for two activated pages`);

// ---- (5) a radio click repaints the radio pair and NOTHING else -------------------
// Both sides are ours, so this is pixel-exact: mark the screen, click, and every
// changed pixel outside the two buttons is a control we had no business redrawing.
// The per-button counts are the positive control — a run where the click missed
// reports zero everywhere and would otherwise "pass".
const CONTROLS = `
    const ss = await import('/src/worker/modules/user32/shared-state.ts');
    const out = [];
    for (const w of ss.windows.values()) {
        if (!w.isSystemControl || !ss.isEffectivelyVisible(w)) continue;
        const a = ss.getAbsoluteWindowPosition(w);
        const p = ss.windows.get(w.parent);
        out.push({ h: w.handle, t: w.title ?? '', cls: (w.systemControlClass ?? '').toLowerCase(),
                   chk: (ss.buttonCheckStates.get(w.handle) ?? 0) & ~4,
                   pGuest: !!p?.guestCustomPaint, x: a.x, y: a.y, w: w.width, hh: w.height });
    }
    return out;
`;
const back: any = await harness()
    .clickAt(Math.floor(s0.rects[0].x + s0.rects[0].w / 2), Math.floor(s0.rects[0].y + s0.rects[0].h / 2))
    .sleep(4000)
    .call("evalWorker", [CONTROLS])
    .run();
const vBefore: any[] = back.steps.find((s: any) => s.cmd === "evalWorker")?.result ?? [];
const bits = vBefore.filter((c) => c.cls === "button" && /\b(16|32)\s*bit\b/i.test(c.t));
if (bits.length < 2) {
    fail(`the Video page shows ${bits.length} of the "16 Bit"/"32 Bit" radio pair `
        + "— the framebuffer group is not there to click");
}
const radio = bits.find((c) => !c.chk) ?? bits[0];
if (!radio.pGuest) {
    console.log(`  note: the page does not guest-paint its client, so an over-wide repaint `
        + "would be idempotent here and this check is weaker than it looks");
}

const clicked: any = await harness()
    .screenMark()
    .clickAt(radio.x + 8, radio.y + Math.floor(radio.hh / 2))
    .sleep(2000)
    .call("evalWorker", [CONTROLS])
    .run();
const vAfter: any[] = clicked.steps.find((s: any) => s.cmd === "evalWorker")?.result ?? [];
const moved = vAfter.filter((c) => {
    const b = vBefore.find((k: any) => k.h === c.h);
    return b && b.chk !== c.chk;
});
console.log(`clicked "${radio.t}"; check state moved on: ${moved.map((c: any) => `"${c.t}"`).join(", ") || "(none)"}`);
if (!moved.some((c: any) => c.h === radio.h)) {
    fail(`clicking "${radio.t}" did not check it — the click never reached the button, `
        + "so the repaint-scope assertion below would pass on a dead dialog");
}

const allowHandles = new Set<number>([radio.h, ...moved.map((c: any) => c.h)]);
const allow = vAfter.filter((c) => allowHandles.has(c.h))
    .map((c) => ({ name: c.t || `0x${c.h.toString(16)}`, x: c.x - 1, y: c.y - 1, w: c.w + 2, h: c.hh + 2 }));
const scope: any = (await harness().screenChangeSince({ allow }).run()).steps?.[0]?.result;
console.log(`  pixels changed: ${scope.changed} total, `
    + `${scope.allow.map((a: any) => `${a.name}=${a.changed}`).join(" ")}, outside=${scope.outside.changed}`);
if (scope.note) fail(scope.note + " — the click rendered nothing at all");
for (const a of scope.allow) {
    if (a.changed === 0) fail(`"${a.name}" changed its check state but not one pixel of it repainted`);
}
if (scope.outside.changed > 0) {
    fail(`${scope.outside.changed} pixel(s) changed OUTSIDE the ${allow.length} button(s) whose `
        + `state moved, over ${JSON.stringify(scope.outside.bbox)} `
        + `(e.g. ${JSON.stringify(scope.outside.samples[0])}). BM_SETCHECK invalidates those `
        + "buttons only; anything else on this page was re-stamped over pixels it could not erase");
}

// The same click with the pre-fix behaviour armed: it MUST dirty the rest of the page,
// or the zero above is a property of this dialog rather than of the repaint scope.
const other = bits.find((c: any) => c.h !== radio.h)!;
const ab: any = await harness()
    .call("setWorkerFlag", "__noScopedControlRepaint", true)
    .screenMark()
    .clickAt(other.x + 8, other.y + Math.floor(other.hh / 2))
    .sleep(2000)
    .screenChangeSince({ allow })
    // The flag is persisted per session, so clear it in the same chain: leaving it
    // armed would silently change every later run in this tab.
    .call("setWorkerFlag", "__noScopedControlRepaint", null)
    .run();
const abScope = ab.steps.find((s: any) => s.cmd === "screenChangeSince")?.result;
console.log(`  A/B (__noScopedControlRepaint): outside=${abScope?.outside.changed}`);
if (!abScope || abScope.outside.changed === 0) {
    fail("with __noScopedControlRepaint armed the whole-page re-stamp changed nothing outside "
        + "the radios either — this dialog cannot show the defect, so the assertion above is vacuous");
}

// ---- (6) Cancel: PSN_QUERYCANCEL, PSN_RESET to every created page, sheet closes ---
// Re-read the notification trace here: the page switches above added their own, and
// slicing from a stale length would credit them to Cancel.
const preCancel: any = await harness().call("evalWorker", [SHEET_STATE]).run();
const beforeCancel: string[] = preCancel.steps?.[0]?.result?.trace ?? trace;
const cancelled: any = await harness()
    .click("Cancel")
    .sleep(5000)
    .call("evalWorker", [SHEET_STATE])
    .shot({ save: "rf-propsheet-cancelled.png" })
    .run();
const s2 = cancelled.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
const trace2: string[] = s2?.trace ?? [];
const fresh = trace2.slice(beforeCancel.length);
console.log(`cancel notifications (${fresh.length}):`);
for (const t of fresh) console.log("  " + t);
if (!fresh.some((t) => t.includes("PSN_QUERYCANCEL"))) {
    fail("Cancel delivered no PSN_QUERYCANCEL — the page cannot veto the close");
}
const resets = fresh.filter((t) => t.includes("PSN_RESET")).length;
if (resets < 2) {
    fail(`Cancel delivered ${resets} PSN_RESET; both created pages must be told to `
        + "roll back, not just the active one");
}
if (s2?.tab) fail("the sheet is still up after Cancel");
console.log("OK — sheet shown, tabs switchable, PSN_* protocol delivered, Cancel closed it");
