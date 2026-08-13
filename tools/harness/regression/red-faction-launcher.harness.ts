/**
 * Red Faction launcher regression: the MFC launcher's art must actually get drawn.
 *
 * The launcher is a `#32770` that MFC subclasses with AfxWndProc; its own OnPaint
 * punts to CWnd::Default(), so every pixel of it — the background StretchBlt in
 * OnEraseBkgnd and the six CBitmapButton tiles — arrives only if that chain lands in
 * DefDlgProc → BeginPaint/EndPaint. Hand a subclasser the app's DlgProc instead of
 * DefDlgProc and the window stays blank grey with no error anywhere.
 *
 *   WGB=g:/WGB/todo/red-faction.wgb bun tools/harness.ts run tools/harness/regression/red-faction-launcher.harness.ts
 */

import { harness } from "../../harness";

const result: any = await harness()
    // First run shows a "you will now be taken to Setup" MessageBoxEx; the guest is
    // parked in it and cannot paint until it is answered.
    .onModal(".*", "ok")
    .openWgb(process.env.WGB ?? "/apps/external-wgb/red-faction.wgb")
    .call("paintTrace", ["start"])
    .waitForControl("Play", { timeoutMs: 120000 })
    .sleep(8000)
    .call("paintTrace", ["read"])
    .state(["windows"])
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
