/**
 * Tiberian Sun is the canonical POSITIVE control for the DDraw/GDI overlay rule: main
 * menu → New Campaign must show the "Select Campaign" `#32770` composited over the
 * DirectDraw screen.
 *
 * What makes it a good control is what makes it fragile. Its DlgProc answers
 * WM_ERASEBKGND with TRUE and draws nothing (the classic no-flicker idiom), so the
 * dialog's own WM_PAINT puts NOTHING on the overlay — every visible pixel of it comes
 * from USER painting the chrome and the seven OS controls. `hasContent:false` with a
 * correct `mode:'rects'` plan is exactly that failure: the plan says composite, and
 * there is nothing to composite.
 *
 * Five COLD attempts, because the guest also has an intermittent SEH-driven self-kill
 * around this click (~2 of 5 before the gdi32 mapping-mode gap was closed).
 *
 *   WGB=g:/WGB/prod-library/tiberian-sun.wgb bun tools/harness.ts run tools/examples/tiberian-sun-dialog.harness.ts
 */

import { harness } from "../harness";

const ATTEMPTS = 5;
const chain = harness().call("logLevel", "DDRAW", "WARN");
for (let i = 1; i <= ATTEMPTS; i++) {
    chain
        .openWgb(process.env.WGB ?? "/apps/external-wgb/tiberian-sun.wgb")
        .sleep(50000)                                        // boot → game-select screen
        .move(240, 300).sleep(400).clickHold(240, 300, 300)  // the Tiberian Sun disc
        .sleep(11000)                                        // → main menu
        .move(400, 259).sleep(400).clickHold(400, 259, 300)  // "New Campaign"
        .sleep(7000)
        .call("overlay", {})
        .state(["windows"])
        .shot({ save: `tiberian-sun-dialog-${i}` });
}

const result: any = await chain.run();
const steps = result.steps ?? [];
const overlays = steps.filter((s: any) => s.cmd === "overlay");
const states = steps.filter((s: any) => s.cmd === "state");

const failures: string[] = [];
for (let i = 0; i < ATTEMPTS; i++) {
    const ov = overlays[i]?.result;
    const wins = states[i]?.result?.windows ?? [];
    const dlg = wins.find((w: any) => w.cls === "#32770");
    const controls = wins.filter((w: any) => w.parent === dlg?.hwnd).length;
    console.log(`attempt ${i + 1}: dialog=${dlg ? "yes" : "NO"} controls=${controls} `
        + `overlayHasContent=${ov?.hasContent} plan=${ov?.plan?.mode}`);
    if (!dlg) failures.push(`attempt ${i + 1}: no #32770 (guest died on the click?)`);
    else if (controls !== 7) failures.push(`attempt ${i + 1}: ${controls} controls, expected 7`);
    else if (!ov?.hasContent) failures.push(`attempt ${i + 1}: overlay EMPTY — the dialog painted nothing`);
    else if (ov?.plan?.mode !== "rects") failures.push(`attempt ${i + 1}: composite plan is '${ov?.plan?.mode}'`);
}

const badSteps = steps.filter((s: any) => !s.ok);
if (badSteps.length) failures.push(`${badSteps.length} harness step(s) failed`);
if (failures.length) throw new Error(failures.join("\n"));
console.log(`OK — Select Campaign composited on ${ATTEMPTS}/${ATTEMPTS} cold attempts`);
