/**
 * control_zoo — two invariants about the pixels a control's own repaint may touch.
 *
 * 1. TAB CLICK SCOPE. comctl32 answers a selection change with TAB_InvalidateTabArea
 *    (Wine comctl32/tab.c:2537): the tab ROWS only, bounded by the display area and,
 *    on a single row, by the last tab. The pane and whatever a sibling drew inside it
 *    are never in the update region, which is why a tab click leaves a property page's
 *    content alone. The zoo puts a BS_GROUPBOX and a check box in the display area
 *    TCM_ADJUSTRECT reports, as SIBLINGS of the tab control, and ignores TCN_SELCHANGE
 *    — so a click must move the tab row and change NOTHING else.
 *
 * 2. GROUP BOX LABEL BAND. GB_Paint (Wine user32/button.c:975) draws the etched frame
 *    across the whole top edge and then takes the label's own band back out of it. The
 *    brush it erases with always exists — a NULL answer sends GB_Paint to the parent's
 *    own DefWindowProc, which returns COLOR_3DFACE — so the gap is not conditional on
 *    anyone handing us one. The zoo's ZooGbPanel is the parent that gives us nothing:
 *    NULL class brush, its own WM_PAINT, and it claims WM_CTLCOLORSTATIC while returning
 *    0. Six captions cover the ways the gap can be misplaced (short / long / wider than
 *    the box / empty / disabled / a different font).
 *
 * Each assertion carries the A/B that reproduces its defect, because a check nobody has
 * seen fail is indistinguishable from one that cannot: __noControlDamageClip restores the
 * whole-window stamp, __noGroupBoxLabelGap leaves the gap to the brush erase alone.
 *
 *   bun tools/harness.ts run tools/harness/regression/control-zoo-chrome-scope.harness.ts
 */

import { harness } from "../../harness";

const fail = (msg: string): never => { throw new Error(msg); };
const last = (r: any, cmd: string) => [...r.steps].reverse().find((s: any) => s.cmd === cmd)?.result;

const SHADOW = "#808080", HILIGHT = "#ffffff", FACE = "#c0c0c0";
const LEGEND = { S: SHADOW, H: HILIGHT, ".": FACE };

const GEOM = `
    const ss = await import('/src/worker/modules/user32/shared-state.ts');
    const tc = await import('/src/worker/modules/user32/tab-control.ts');
    const byTitle = (t) => [...ss.windows.values()].find(w => w.title === t);
    const rect = (w) => { if (!w) return null; const o = ss.getAbsoluteWindowPosition(w);
        return { x: o.x, y: o.y, w: w.width, h: w.height }; };
    const tab = [...ss.windows.values()].find(w =>
        (w.systemControlClass || '').toLowerCase().includes('tab'));
    if (!tab) return { error: 'the zoo has no SysTabControl32' };
    const o = ss.getAbsoluteWindowPosition(tab);
    const st = tc.getTabState(tab.handle);
    const items = st.items.map((_, i) => {
        const r = tc.tabItemRect(tab, i);
        return { x: o.x + r.left, y: o.y + r.top, w: r.right - r.left, h: r.bottom - r.top };
    });
    const boxes = {};
    for (const t of ${JSON.stringify([
        "Options:", "A caption that nearly fills it",
        "A caption far wider than the group box it belongs to", "",
        "Disabled group", "Big font"])}) {
        const w = [...ss.windows.values()].find(x => x.title === t
            && (x.systemControlClass || '').toLowerCase() === 'button'
            && (x.style & 0x0f) === 0x07);
        boxes[t] = rect(w);
        if (w) {
            boxes[t].parent = w.parent;
            boxes[t].parentGuestPaint = !!ss.windows.get(w.parent)?.guestCustomPaint;
        }
    }
    return {
        parent: tab.parent,
        tab: { x: o.x, y: o.y, w: tab.width, h: tab.height },
        rows: tc.tabRowsHeight(tab), curSel: st.curSel, items,
        page: rect(byTitle('Page content')), check: rect(byTitle('A checkbox on the page')),
        boxes,
    };
`;

// Every arm starts from an intact page: a mark taken over an ALREADY damaged screen
// reports "nothing changed" and the scope assertion passes on the very bug it exists
// to catch. Repair always runs with the flags at their defaults.
const REPAIR = (...parents: number[]) => `
    const c = await import('/src/worker/modules/user32/controls.ts');
    for (const p of ${JSON.stringify(parents)}) c.repaintChildControls(p);
    return { repaired: ${JSON.stringify(parents)} };
`;

const flags = async (set: Record<string, boolean | null>): Promise<void> => {
    for (const [k, v] of Object.entries(set)) await harness().call("setWorkerFlag", k, v).run();
};

// ------------------------------------------------------------------------------ open
await harness()
    .openWgb(process.env.WGB ?? "/apps/control_zoo.wgb")
    .waitForControl("A1", { timeoutMs: 180000 })
    .sleep(3000)
    .run();

const geom: any = last(await harness().call("evalWorker", GEOM).run(), "evalWorker");
if (geom?.error) fail(geom.error);
if (!geom.page || !geom.check) {
    fail("the zoo's tab control has no 'Page content' group box / check box sibling — "
        + "rebuild control_zoo (bottleship-demos/control_zoo/build.ps1) and copy dist/*.wgb "
        + "into public/apps/");
}
if (geom.items.length < 2) fail(`the tab control has ${geom.items.length} tab(s); need at least 2`);

// ------------------------------------------------------------ 1. tab click scope
/** One click on the tab AFTER the current one; returns the change outside the tab row. */
const clickNextTab = async (): Promise<{ inBand: number; outside: number; bbox: unknown }> => {
    const g: any = last(await harness().call("evalWorker", GEOM).run(), "evalWorker");
    const t = g.items[(g.curSel + 1) % g.items.length];
    const band = { name: "tabRow", x: g.tab.x, y: g.tab.y, w: g.tab.w, h: g.rows + 4 };
    const c = last(await harness()
        .screenMark()
        .clickAt(t.x + (t.w >> 1), t.y + (t.h >> 1))
        .sleep(400)
        .screenChangeSince({ allow: [band], within: g.tab })
        .run(), "screenChangeSince");
    return { inBand: c.allow[0].changed, outside: c.outside.changed, bbox: c.outside.bbox };
};

await flags({ __noControlDamageClip: null });
await harness().call("evalWorker", REPAIR(geom.parent, geom.boxes['Options:'].parent)).sleep(300).run();
const scoped = await clickNextTab();
if (scoped.inBand === 0) {
    fail("clicking a tab changed nothing in the tab row — the click missed, so the scope "
        + "assertion below would be vacuous");
}
if (scoped.outside !== 0) {
    fail(`a tab click changed ${scoped.outside} pixel(s) OUTSIDE the tab row `
        + `(${JSON.stringify(scoped.bbox)}). TAB_InvalidateTabArea damages the rows only; `
        + "the page content is a sibling's pixels and nothing asks for them back.");
}
console.log(`  ok  tab click: ${scoped.inBand} px in the tab row, 0 outside it`);

// The A/B is the positive control for the check above.
await flags({ __noControlDamageClip: true });
await harness().call("evalWorker", REPAIR(geom.parent, geom.boxes['Options:'].parent)).sleep(300).run();
const unscoped = await clickNextTab();
await flags({ __noControlDamageClip: null });
if (unscoped.outside === 0) {
    fail("__noControlDamageClip restores the whole-window stamp and STILL changed nothing "
        + "outside the tab row — the assertion above cannot fail, so its pass means nothing");
}
console.log(`  ok  A/B: without the update rect the same click damages ${unscoped.outside} px `
    + `outside the row (${JSON.stringify(unscoped.bbox)})`);
await harness().call("evalWorker", REPAIR(geom.parent, geom.boxes['Options:'].parent)).sleep(300).run();

// ------------------------------------------------------- 2. group box label band
/**
 * The frame's top line, read off the screen: the row with the most COLOR_BTNSHADOW
 * pixels is the etched edge, and a column is OPEN when neither it nor the highlight row
 * under it draws there. `capRight` is how far the caption's own glyphs reach, measured
 * from the rows below the frame, so the gap is judged against the caption rather than
 * against a threshold — a struck-through line still shows a pixel or two of open column
 * where a glyph happens to clear both rows, and any fixed minimum would be a guess.
 */
interface TopLine {
    row: number; shadow: number; capRight: number;
    gap: { start: number; len: number } | null;
}

const readTopLine = async (box: { x: number; y: number; w: number; h: number }): Promise<TopLine> => {
    const g = last(await harness()
        .screenPixels({ x: box.x, y: box.y, w: box.w, h: Math.min(24, box.h), legend: LEGEND })
        .run(), "screenPixels");
    const rows: string[] = g.rows;
    let best = -1, bestN = -1;
    rows.forEach((r, i) => {
        const n = (r.match(/S/g) ?? []).length;
        if (n > bestN) { bestN = n; best = i; }
    });
    const line = rows[best] ?? "", under = rows[best + 1] ?? "";
    let start = -1, len = 0, curStart = -1, cur = 0;
    for (let x = 1; x < line.length - 1; x++) {
        const open = line[x] !== "S" && under[x] !== "H";
        if (open) { if (cur === 0) curStart = x; cur++; if (cur > len) { len = cur; start = curStart; } }
        else cur = 0;
    }
    // Inside the frame, below its top edge, the only thing drawn is the caption itself.
    let capRight = -1;
    for (let r = best + 2; r < Math.min(best + 9, rows.length); r++) {
        for (let x = 3; x < rows[r].length - 3; x++) if (rows[r][x] !== "." && x > capRight) capRight = x;
    }
    return { row: box.y + best, shadow: bestN, capRight, gap: len > 0 ? { start, len } : null };
};

const CAPTIONED: [string, string][] = [
    ["Options:", "short"],
    ["A caption that nearly fills it", "long"],
    ["A caption far wider than the group box it belongs to", "wider than the box"],
    ["Disabled group", "disabled"],
    ["Big font", "a different font"],
];

const checkBoxes = async (label: string): Promise<Record<string, TopLine>> => {
    const seen: Record<string, TopLine> = {};
    for (const [title, kind] of CAPTIONED) {
        const box = geom.boxes[title];
        if (!box) fail(`the zoo has no "${title}" group box — rebuild control_zoo`);
        if (!box.parentGuestPaint) {
            fail(`"${title}" sits under a parent that does NOT paint its own client; the `
                + "brushless case is the one this pins and the fixture no longer models it");
        }
        const t = await readTopLine(box);
        seen[title] = t;
        if (label === "expect-gap") {
            if (!t.gap) {
                fail(`"${title}" (${kind}): the etched top line runs unbroken across row `
                    + `${t.row} — GB_Paint takes the caption's band out of it`);
            }
            // GB_Paint's band starts at the client inflated by -7, so the gap opens there.
            if (t.gap.start < 5 || t.gap.start > 9) {
                fail(`"${title}" (${kind}): the gap opens at column ${t.gap.start}, not at the `
                    + "caption's own x+7 — it is sized or placed from something other than the "
                    + "font the label is drawn with");
            }
            if (t.capRight < 0) fail(`"${title}" (${kind}): no caption glyphs found below the frame`);
            if (t.gap.start + t.gap.len < t.capRight) {
                fail(`"${title}" (${kind}): the gap ends at column ${t.gap.start + t.gap.len} but `
                    + `the caption reaches ${t.capRight} — the etched line crosses the glyphs from `
                    + "there on. The band is sized from a different font than the label is drawn "
                    + "with, or it is not being taken out of the frame at all.");
            }
        }
    }
    return seen;
};

const withGap = await checkBoxes("expect-gap");
for (const [title, kind] of CAPTIONED) {
    console.log(`  ok  "${title}" (${kind}): top line broken at +${withGap[title].gap!.start} `
        + `for ${withGap[title].gap!.len}px`);
}

// An EMPTY caption has no band to take out, so the line must be continuous.
const empty = geom.boxes[""];
if (empty) {
    const t = await readTopLine(empty);
    if (t.gap && t.gap.len > 2) {
        fail(`the empty-caption group box has a ${t.gap.len}px break at column ${t.gap.start} `
            + "in its top line — there is no label to make room for");
    }
    console.log("  ok  empty caption: the top line is unbroken");
}

// The A/B: without the frame exclusion, a brushless parent leaves the line drawn through.
await flags({ __noGroupBoxLabelGap: true });
await harness().call("evalWorker", REPAIR(geom.parent, geom.boxes['Options:'].parent)).sleep(400).run();
const struck = await readTopLine(geom.boxes["Options:"]);
await flags({ __noGroupBoxLabelGap: null });
await harness().call("evalWorker", REPAIR(geom.parent, geom.boxes['Options:'].parent)).sleep(400).run();
if (struck.gap && struck.gap.start + struck.gap.len >= struck.capRight) {
    fail("__noGroupBoxLabelGap left the frame out of the caption's band anyway "
        + `(gap ${struck.gap.len}px at ${struck.gap.start}, caption to ${struck.capRight}) — `
        + "the check above cannot fail, so its pass means nothing");
}
console.log("  ok  A/B: without the frame exclusion the same box's top line is unbroken "
    + "(the strike-through), so the checks above can fail");

const after = await readTopLine(geom.boxes["Options:"]);
if (!after.gap || after.gap.start + after.gap.len < after.capRight) {
    fail("the label gap did not come back after the A/B — the run left the zoo dirty");
}

console.log("OK — a tab click damages the tab rows and nothing else, and a group box's "
    + "etched top line breaks for its caption under a parent that supplies no brush");
