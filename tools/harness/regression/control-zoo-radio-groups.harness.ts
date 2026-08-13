/**
 * control_zoo — WS_GROUP scoping over CreateWindowEx-made controls.
 *
 * The zoo builds two radio sets with plain CreateWindowEx calls, A1 A2 A3 then B1 B2,
 * each set opened by a WS_GROUP button (bottleship-demos/control_zoo/src/main.c). That
 * is the path a dialog TEMPLATE never takes, and the two must agree: in Win32 the
 * sibling list IS the Z-order, a new child is linked at the BOTTOM of it (NT
 * createw.c; Wine user32/tests/win.c test_children_zorder), so children come out in
 * creation order and GetNextDlgGroupItem's GW_HWNDNEXT walk yields the author's order
 * whether the controls came from a template or from CreateWindowEx.
 *
 * What this pins, in the order it would break:
 *   1. the parent's children[] really is in creation order (the invariant both walks
 *      read; when it inverts, everything below still "works", just backwards),
 *   2. BS_AUTORADIOBUTTON exclusion stays inside the clicked button's group,
 *   3. arrow-key navigation (IsDialogMessage -> GetNextDlgGroupItem) walks and WRAPS
 *      inside the same group — it shares the walk, so it fails the same way,
 *   4. GetNextDlgGroupItem itself, called as the guest would call it.
 *
 * With the list reversed, clicking A3 leaves A1 checked and clears B1 — a button in
 * the other group — which is what this caught.
 *
 *   bun tools/harness.ts run tools/harness/regression/control-zoo-radio-groups.harness.ts
 */

import { harness } from "../../harness";

const fail = (msg: string): never => { throw new Error(msg); };
const RADIOS = ["A1", "A2", "A3", "B1", "B2"];

/** BST_UNCHECKED for a button that has never been through BM_SETCHECK. */
const checks = async (): Promise<Record<string, number>> => {
    let chain = harness();
    for (const n of RADIOS) chain = chain.call("controlState", n);
    const r: any = await chain.run();
    const states = r.steps.filter((s: any) => s.cmd === "controlState");
    return Object.fromEntries(RADIOS.map((n, i) => [n, (states[i].result.check ?? 0) & 3]));
};

const focused = async (): Promise<string> => {
    let chain = harness();
    for (const n of RADIOS) chain = chain.call("controlState", n);
    const r: any = await chain.run();
    const states = r.steps.filter((s: any) => s.cmd === "controlState");
    return RADIOS[states.findIndex((s: any) => s.result.focused)] ?? "(none)";
};

const show = (c: Record<string, number>) => RADIOS.map((n) => `${n}=${c[n]}`).join(" ");

const expectChecks = (got: Record<string, number>, want: Record<string, number>, what: string) => {
    for (const n of RADIOS) {
        if (got[n] !== want[n]) {
            fail(`${what}: ${show(got)} — expected ${show(want as Record<string, number>)}. `
                + `(An untouched zoo reads A1=1 A2=0 A3=0 B1=1 B2=0, so "nothing happened" `
                + `fails here too.)`);
        }
    }
    console.log(`  ok  ${what}: ${show(got)}`);
};

// GetNextDlgGroupItem itself, over the live window tree: the zoo never imports it (a
// thunk is only registered for an import the guest has), so the export is taken from
// the module's own table rather than from the dispatcher.
const GROUP_WALK = `
    const ss = await import('/src/worker/modules/user32/shared-state.ts');
    const dlg = await import('/src/worker/modules/user32/dialog.ts');
    const sys = (await import('/src/worker/core/system.ts')).System.getInstance();
    const call = dlg.createDialogExports()['GetNextDlgGroupItem'];
    if (!call) return { error: 'user32 exports no GetNextDlgGroupItem' };
    const mem = sys.process.getCurrentMemory();
    const byTitle = (t) => [...ss.windows.values()].find(w => w.title === t);
    const a1 = byTitle('A1');
    const parent = ss.windows.get(a1.parent);
    const name = (h) => { const w = ss.windows.get(h); return w ? (w.title || '(untitled)') : '0'; };
    const step = (from, prev) => name(call({ esp: 0 }, mem, [parent.handle, byTitle(from).handle, prev ? 1 : 0]));
    return {
        children: parent.children.map(name),
        next: Object.fromEntries(['A1','A2','A3','B1','B2'].map(n => [n, step(n, false)])),
        prev: Object.fromEntries(['A1','A2','A3','B1','B2'].map(n => [n, step(n, true)])),
    };
`;

// ------------------------------------------------------------------ open + invariant
const open: any = await harness()
    .openWgb(process.env.WGB ?? "/apps/control_zoo.wgb")
    .waitForControl("A1", { timeoutMs: 180000 })
    .sleep(3000)
    .call("evalWorker", [GROUP_WALK])
    .run();

const walk = open.steps.find((s: any) => s.cmd === "evalWorker")?.result;
if (!walk || walk.error) fail(`could not reach the group walk: ${walk?.error ?? "no result"}`);

// (1) children[] in creation order. main.c creates the first label before every other
// control and the radios in the order A1 A2 A3 B1 B2.
const order = (t: string) => walk.children.indexOf(t);
if (walk.children[0] !== "BUTTON: push / default / disabled") {
    fail(`children[0] is "${walk.children[0]}", but main.c creates the "BUTTON: push / `
        + `default / disabled" label first. children[] must be the Z-order sibling list with `
        + `a new child appended, or every walk below reads the controls backwards.`);
}
for (let i = 1; i < RADIOS.length; i++) {
    if (order(RADIOS[i]!) < order(RADIOS[i - 1]!)) {
        fail(`children[] has ${RADIOS[i]} before ${RADIOS[i - 1]} (${walk.children.join(" ")}) `
            + "— the sibling list is not in creation order");
    }
}
console.log(`  ok  children[] in creation order (A1..B2 at ${RADIOS.map(order).join(",")})`);

// (4) GetNextDlgGroupItem: A's range is exactly A1..A3 — WS_GROUP on A1 opens it and
// WS_GROUP on B1 closes it — so it must ring. B's range is open-ended (nothing after B2
// carries WS_GROUP, and Win32 puts every such control in B's group, statics included),
// so only its first step is pinned; what matters is that neither range reaches the other.
const wantNext: Record<string, string> = { A1: "A2", A2: "A3", A3: "A1", B1: "B2" };
const wantPrev: Record<string, string> = { A1: "A3", A2: "A1", A3: "A2", B2: "B1" };
for (const [from, want] of Object.entries(wantNext)) {
    if (walk.next[from] !== want) {
        fail(`GetNextDlgGroupItem(${from}, next) = ${walk.next[from]}, expected ${want} `
            + `(full walk: ${JSON.stringify(walk.next)})`);
    }
}
for (const [from, want] of Object.entries(wantPrev)) {
    if (walk.prev[from] !== want) {
        fail(`GetNextDlgGroupItem(${from}, previous) = ${walk.prev[from]}, expected ${want} `
            + `(full walk: ${JSON.stringify(walk.prev)})`);
    }
}
const groupA = ["A1", "A2", "A3"], groupB = ["B1", "B2"];
for (const dir of ["next", "prev"] as const) {
    for (const from of groupA) {
        if (groupB.includes(walk[dir][from])) {
            fail(`GetNextDlgGroupItem(${from}, ${dir}) = ${walk[dir][from]} — group A's walk `
                + "reached group B");
        }
    }
    for (const from of groupB) {
        if (groupA.includes(walk[dir][from])) {
            fail(`GetNextDlgGroupItem(${from}, ${dir}) = ${walk[dir][from]} — group B's walk `
                + "reached group A");
        }
    }
}
console.log(`  ok  GetNextDlgGroupItem next=${JSON.stringify(walk.next)}`);
console.log(`  ok  GetNextDlgGroupItem prev=${JSON.stringify(walk.prev)}`);

// -------------------------------------------------------------- (2) the click itself
expectChecks(await checks(), { A1: 1, A2: 0, A3: 0, B1: 1, B2: 0 }, "as built");

await harness().click("A3").sleep(800).run();
expectChecks(await checks(), { A1: 0, A2: 0, A3: 1, B1: 1, B2: 0 },
    "after clicking A3 (A1 must clear, B1 must NOT)");

await harness().click("B2").sleep(800).run();
expectChecks(await checks(), { A1: 0, A2: 0, A3: 1, B1: 0, B2: 1 },
    "after clicking B2 (B1 must clear, A3 must NOT)");

// --------------------------------------------------- (3) arrow keys share that walk
// IsDialogMessage gives the zoo's plain window the dialog manager's navigation; a
// right/down arrow moves focus to the next item IN THE GROUP and, Wine DEFDLG_Proc,
// BM_CLICKs it when it is an unchecked autoradio.
await harness().click("A1").sleep(800).run();
expectChecks(await checks(), { A1: 1, A2: 0, A3: 0, B1: 0, B2: 1 }, "click A1 to place focus");
if (await focused() !== "A1") fail(`clicking A1 did not focus it (focus is ${await focused()})`);

await harness().key("right").sleep(800).run();
if (await focused() !== "A2") {
    fail(`Right from A1 focused ${await focused()}, expected A2 — the arrow never reached the `
        + "dialog manager, or the group walk stepped elsewhere");
}
expectChecks(await checks(), { A1: 0, A2: 1, A3: 0, B1: 0, B2: 1 }, "Right: A1 -> A2");

await harness().key("down").sleep(800).run();
expectChecks(await checks(), { A1: 0, A2: 0, A3: 1, B1: 0, B2: 1 }, "Down: A2 -> A3");

// The wrap is the assertion that matters: from the LAST item of group A, forward must
// come back to A1 and must not walk into B.
await harness().key("right").sleep(800).run();
if (await focused() !== "A1") fail(`Right from A3 focused ${await focused()}, expected A1 (the group wraps)`);
expectChecks(await checks(), { A1: 1, A2: 0, A3: 0, B1: 0, B2: 1 }, "Right: A3 wraps to A1, B untouched");

await harness().key("left").sleep(800).run();
if (await focused() !== "A3") fail(`Left from A1 focused ${await focused()}, expected A3`);
expectChecks(await checks(), { A1: 0, A2: 0, A3: 1, B1: 0, B2: 1 }, "Left: A1 wraps back to A3");

console.log("OK — WS_GROUP ranges hold for CreateWindowEx controls: click, arrow keys and "
    + "GetNextDlgGroupItem all stay inside the group");
