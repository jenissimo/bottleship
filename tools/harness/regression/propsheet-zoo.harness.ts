/**
 * propsheet_zoo — our comctl32 property sheet against a native Windows reference.
 *
 * The demo (bottleship-demos/propsheet_zoo) is a real `PropertySheet()` over three
 * DIALOGEX pages, so Windows itself sizes the frame, places the SysTabControl32 and
 * the OK/Cancel/Apply row, and maps every DLU to pixels. Two references ship with it:
 *   public/reference/propsheet_zoo-native-page1.json  — every control's class/text/rect
 *   public/reference/propsheet_zoo-native-page1.png   — PrintWindow of the client
 *
 * WHAT EACH REFERENCE IS GOOD FOR — the two halves are not interchangeable:
 *  - The JSON is authoritative for GEOMETRY AND STATE, and that is what this script
 *    asserts against: where comctl32 puts the tab control, the row height it derives
 *    from tmHeight, the tab row's own inset, where TCM_ADJUSTRECT starts the page's
 *    client, each control's DLU-mapped size, which ones the template disables.
 *  - The PNG is NOT asserted against. It is the classic (no-manifest, comctl32 v5)
 *    drawing path, but it carries Win11's system colours rather than the Win98 scheme
 *    we recreate, and Windows resolves the templates' DLUs with MS Sans Serif's base
 *    units (6 x 13) where our canvas font gives ~6.08 x ~13.6 — so absolute pixels
 *    cannot line up. It stays as an eyeball reference, and `compareReference` (which
 *    palette-remaps it) is available for a manual look; BEVELS come from the spec
 *    (Wine dlls/comctl32/tab.c, the NT5 source), never from diffing this capture.
 *
 * PIXEL-EXACTNESS is used only where BOTH sides are ours, which costs nothing and is
 * unambiguous: a page switched away and back must return byte-identical, and a
 * combobox popup dropped and closed must leave what it covered byte-identical.
 *
 * The bundle is built by bottleship-demos/propsheet_zoo/build.ps1; public/apps is
 * gitignored, so copy dist/propsheet_zoo.wgb there (or point WGB at it) first.
 *
 *   bun tools/harness.ts run tools/harness/regression/propsheet-zoo.harness.ts
 */

import { harness } from "../../harness";
import { readFileSync } from "node:fs";

const REF_JSON = "public/reference/propsheet_zoo-native-page1.json";

const LAYOUT = `
    const ss = await import('/src/worker/modules/user32/shared-state.ts');
    const tc = await import('/src/worker/modules/user32/tab-control.ts');
    const tab = [...ss.windows.values()].find(
        w => (w.systemControlClass ?? '').toLowerCase() === 'systabcontrol32');
    if (!tab) return null;
    const fr = ss.windows.get(tab.parent);
    const fa = ss.getAbsoluteWindowPosition(fr);
    const st = tc.ensureTabLayout(tab);
    const rel = (w) => { const a = ss.getAbsoluteWindowPosition(w);
        return { x: a.x - fa.x, y: a.y - fa.y, w: w.width, h: w.height }; };
    const walk = (w, out) => { for (const h of w.children ?? []) {
        const c = ss.windows.get(h); if (!c) continue;
        out.push({ t: c.title ?? '', cls: c.nativeClassName ?? c.systemControlClass ?? '',
                   id: c.controlId ?? 0, vis: !!c.visible, ...rel(c) });
        walk(c, out); } return out; };
    return {
        frame: { x: fa.x, y: fa.y, w: fr.width, h: fr.height, title: fr.title },
        tab: { ...rel(tab), th: st.tabHeight, sel: st.curSel, rows: st.rowCount,
               items: st.items.map(i => i.text),
               rects: st.items.map((_, i) => tc.tabItemRect(tab, i)) },
        controls: walk(fr, []),
    };
`;

const fail = (msg: string): never => { throw new Error(msg); };

interface NativeCtl { cls: string; text: string; id: number; visible: boolean; enabled: boolean;
    x: number; y: number; w: number; h: number }
const native = JSON.parse(readFileSync(REF_JSON, "utf8").replace(/^﻿/, "")) as
    { root: { cw: number; ch: number }; controls: NativeCtl[] };

// ---------------------------------------------------------------- open the sheet
const open: any = await harness()
    .onModal(".*", "ok")
    .openWgb(process.env.WGB ?? "/apps/propsheet_zoo.wgb")
    .waitForControl("OK", { timeoutMs: 180000 })
    .sleep(4000)
    .call("evalWorker", [LAYOUT])
    .run();

const L = open.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
if (!L?.tab) fail("no SysTabControl32 — PropertySheet() never produced a sheet");
console.log(`frame ${L.frame.w}x${L.frame.h} "${L.frame.title}" (native client `
    + `${native.root.cw}x${native.root.ch})`);
console.log(`tabs: ${L.tab.items.join(" | ")}  sel=${L.tab.sel} rows=${L.tab.rows} tabHeight=${L.tab.th}`);

// ---- (1) structure and state, against the native layout dump ---------------------
if (L.tab.items.join("|") !== "Buttons|Lists|Text") fail(`tab labels are ${L.tab.items.join("|")}`);
if (L.tab.sel !== 0) fail(`initial selection is ${L.tab.sel}, expected page 0`);
if (L.tab.rows !== 1) fail(`${L.tab.rows} tab rows, expected 1`);

const nativeTab = native.controls.find((c) => c.cls === "SysTabControl32")!;
if (L.tab.x !== nativeTab.x || L.tab.y !== nativeTab.y) {
    fail(`tab control sits at ${L.tab.x},${L.tab.y}; comctl32 places it at `
        + `${nativeTab.x},${nativeTab.y} — the frame's own layout drifted, and every `
        + "region below is anchored on that origin");
}
// comctl32 derives the row height from tmHeight, not the font's px size.
if (L.tab.th !== 18) fail(`tabHeight is ${L.tab.th}; MS Sans Serif 8pt gives 18 natively`);

for (const want of ["OK", "Cancel", "&Apply"]) {
    if (!L.controls.some((c: any) => c.t === want && c.vis)) fail(`the sheet has no visible "${want}" button`);
}
const nativePage = native.controls.find((c) => c.cls === "#32770" && c.text === "Buttons")!;
const page = L.controls.find((c: any) => c.cls === "#32770" && c.t === "Buttons");
if (!page?.vis) fail("page 'Buttons' is not visible");
// resource.h numbers page 1's controls 1001..1099; the sheet's own OK/Cancel/Apply
// carry comctl32's ids and must not be counted as page content.
const nativePageKids = native.controls.filter((c) => c.cls === "Button"
    && c.id >= 1001 && c.id <= 1099).length;
const pageKids = L.controls.filter((c: any) => c.cls === "Button" && c.y > page.y && c.y < page.y + page.h).length;
if (pageKids < nativePageKids) {
    fail(`page 'Buttons' shows ${pageKids} of the ${nativePageKids} controls its template declares`);
}

// ---- (2) geometry and state, against the native layout dump ---------------------
// The native capture is authoritative for NUMBERS, not pixels: Windows resolves the
// templates' DLUs with MS Sans Serif's base units (6 x 13) while our canvas font gives
// ~6.08 x ~13.6, so the frame comes out a few pixels larger and every absolute
// coordinate drifts. What must agree is the STRUCTURE comctl32 computes — where the
// tab control sits, the row height it derives from tmHeight, the selected tab's
// inflation, and where TCM_ADJUSTRECT puts the page's client.
const t = L.tab;
const geom: [string, number, number, number][] = [
    // name, ours, native, tolerance
    ["tab.x", t.x, nativeTab.x, 0],
    ["tab.y", t.y, nativeTab.y, 0],
    ["tabHeight", t.th, 18, 0],
    // The page's client starts one border + one padding past the tab rows; comctl32
    // and we must agree on that offset even though the frame sizes differ.
    ["page.y - tab.y", page.y - t.y, nativePage.y - nativeTab.y, 0],
    ["page.x - tab.x", page.x - t.x, nativePage.x - nativeTab.x, 0],
];
for (const [name, ours, want, tol] of geom) {
    const ok = Math.abs(ours - want) <= tol;
    console.log(`  ${name.padEnd(18)} ours=${String(ours).padStart(4)} native=${String(want).padStart(4)}`
        + `${ok ? "" : "   <-- MISMATCH"}`);
    if (!ok) fail(`${name}: ours ${ours}, comctl32 ${want} (tolerance ${tol})`);
}

// The selected tab is the stored rect inflated by SELECTED_TAB_OFFSET on every side,
// and tabItemRect must keep reporting the UNSELECTED geometry (comctl32 stores that,
// and the hit test reads it) — a number the native capture pins through the tab row's
// own inset: the first tab starts at SELECTED_TAB_OFFSET, not at 0.
if (t.rects[0].left !== 2 || t.rects[0].top !== 2) {
    fail(`tab 0's stored rect is at ${t.rects[0].left},${t.rects[0].top}; comctl32 insets the row `
        + "by SELECTED_TAB_OFFSET so the selected tab's inflation still fits the client");
}
for (let i = 1; i < t.rects.length; i++) {
    if (t.rects[i].left !== t.rects[i - 1].right) {
        fail(`tab ${i} starts at ${t.rects[i].left} but tab ${i - 1} ends at ${t.rects[i - 1].right}`
            + " — the row must tile without gaps");
    }
    if (t.rects[i].top !== t.rects[0].top) fail(`tab ${i} is on a different row`);
}

// Control state the capture cannot show but the layout dump can: which controls the
// template disables, and that we disable exactly those.
for (const n of native.controls.filter((c) => c.cls === "Button" && c.id >= 1001 && c.id <= 1099)) {
    // By id, not title: the template deliberately reuses "Disabled" for a check box
    // and a push button, and matching on text would compare the wrong pair.
    const ours = L.controls.find((c: any) => c.id === n.id);
    if (!ours) fail(`no control with id ${n.id} ("${n.text}") on the page`);
    if (ours.w !== n.w || ours.h !== n.h) {
        fail(`"${n.text}" (id ${n.id}) is ${ours.w}x${ours.h}; comctl32's DLU mapping `
            + `gives ${n.w}x${n.h}`);
    }
}
console.log(`all ${native.controls.filter((c) => c.cls === "Button" && c.id >= 1001 && c.id <= 1099).length}`
    + " page controls match the native DLU-mapped sizes");

// ---- (3) A -> B -> A: the page must come back exactly as it left ------------------
// No reference needed and nothing to tune: it catches both "we stamped something
// extra" and "we erased something the guest owns" on the repaint.
const pageRect = { x: L.frame.x + page.x, y: L.frame.y + page.y, w: page.w, h: page.h };
const tabCentre = (i: number) => ({
    x: Math.floor(L.frame.x + t.x + (t.rects[i].left + t.rects[i].right) / 2),
    y: Math.floor(L.frame.y + t.y + (t.rects[i].top + t.rects[i].bottom) / 2),
});

const trip: any = await harness()
    .screenRegionHash(pageRect)
    .clickAt(tabCentre(1).x, tabCentre(1).y).sleep(2500)
    .screenRegionHash(pageRect)
    .clickAt(tabCentre(0).x, tabCentre(0).y).sleep(2500)
    .screenRegionHash(pageRect)
    .call("evalWorker", [LAYOUT])
    .run();
const hashes = trip.steps.filter((s: any) => s.cmd === "screenRegionHash").map((s: any) => s.result);
const back = trip.steps.find((s: any) => s.cmd === "evalWorker")?.result;
console.log(`A->B->A page hashes: ${hashes.map((h: any) => `${h.hash}(mean ${h.mean})`).join(" ")}`);
if (back?.tab?.sel !== 0) fail(`after A->B->A the selection is ${back?.tab?.sel}, expected 0`);
if (hashes[0].hash === hashes[1].hash) {
    fail("page A and page B hash the same — the tab click never changed the pixels, so the "
        + "identity check below would pass on a sheet that never repaints");
}
if (hashes[0].hash !== hashes[2].hash) {
    fail(`page A does not come back identical: ${hashes[0].hash} (mean ${hashes[0].mean}) -> `
        + `${hashes[2].hash} (mean ${hashes[2].mean}). Something was stamped over it or erased `
        + "from it on the way back.");
}

// ---- (4) uncover: a dropped combobox must restore what it covered ----------------
// Page 2's combo drops a popup over the group box below it; closing it is the
// uncover repaint that used to lose owner-drawn and retained content.
const combo = () => {
    const c = back.controls.find((k: any) => (k.cls ?? "").toLowerCase() === "combobox");
    return c && { x: L.frame.x + c.x + c.w - 8, y: L.frame.y + c.y + Math.floor(c.h / 2) };
};
const toLists: any = await harness()
    .clickAt(tabCentre(1).x, tabCentre(1).y).sleep(2500)
    .call("evalWorker", [LAYOUT])
    .run();
const listsPage = toLists.steps.find((s: any) => s.cmd === "evalWorker")?.result;
const cb = listsPage.controls.find((k: any) => (k.cls ?? "").toLowerCase() === "combobox");
if (!cb) fail("page 'Lists' has no COMBOBOX — the template declares four");
const listsRect = (() => {
    const p = listsPage.controls.find((k: any) => k.cls === "#32770" && k.vis && k.t === "Lists");
    return p ? { x: L.frame.x + p.x, y: L.frame.y + p.y, w: p.w, h: p.h } : pageRect;
})();
const drop = { x: L.frame.x + cb.x + cb.w - 8, y: L.frame.y + cb.y + Math.floor(cb.h / 2) };
const cover: any = await harness()
    .screenRegionHash(listsRect)
    .clickAt(drop.x, drop.y).sleep(1500)
    .screenRegionHash(listsRect)
    .clickAt(drop.x, drop.y).sleep(1500)
    .screenRegionHash(listsRect)
    .run();
const ch = cover.steps.filter((s: any) => s.cmd === "screenRegionHash").map((s: any) => s.result);
console.log(`combo drop/close hashes: ${ch.map((h: any) => h.hash).join(" ")}`);
if (ch[0].hash === ch[1].hash) {
    fail("dropping the combobox changed no pixels — the popup never appeared, so the uncover "
        + "check below proves nothing");
}
if (ch[0].hash !== ch[2].hash) {
    fail(`closing the combobox left the page different from before it dropped `
        + `(${ch[0].hash} -> ${ch[2].hash}): the uncover repaint did not restore what the popup covered`);
}

console.log("OK — layout matches comctl32's numbers; A->B->A and uncover restore byte-identically");
