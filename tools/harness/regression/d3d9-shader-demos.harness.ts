/**
 * D3D9 end-to-end guard: programmable shaders, occlusion queries, off-screen depth.
 *
 * The gate had no test that RENDERS anything: every check was static or unit-level, which is
 * why a shifted IDirect3DSurface9 vtable and a depth attachment that did not match the render
 * area both reached a real game before anything complained. These demos close that hole
 * from the other end — they draw with vs_1_1/ps_1_1 through vs_2_0/ps_2_0, count visible pixels
 * with an occlusion query, render into a texture under a larger depth-stencil, read their own
 * pixels back, and compare against CLOSED-FORM expectations (never a recorded baseline, so a
 * bug cannot be adopted as the reference). Each writes `RESULT: PASS` or a `RESULT: FAIL`
 * line naming the pixel, and exits 0/1 to match.
 *
 * Sources live in C:\Projects\bottleship-demos\<name>\; bundles are STORE-only .wgb.
 * Prereqs: `bun tools/harness.ts up`, and the bundles present under DEMOS_DIR.
 */
import { harness } from "../../harness";

const DEMOS_DIR = process.env.DEMOS_DIR ?? "g:/WGB/demos";
const DEMOS = [
    { name: "demo_sm1_tri", what: "vs_1_1 + ps_1_1, interpolated colour" },
    { name: "demo_sm1_tex", what: "ps_1_1 tex t0 + mul, procedural checker" },
    { name: "demo_sm1_bump", what: "tangent-space DOT3 bump, two light directions" },
    { name: "demo_sm2_flow", what: "vs_2_0 if b0 / rep i0, app-set b/i constants" },
    { name: "demo_occlusion_query", what: "D3DQUERYTYPE_OCCLUSION pixel counts, incl. before the first Present" },
    { name: "demo_rt_depth", what: "small render target under an oversized depth-stencil" },
];

/** Seconds to let a demo run before reading its verdict. They judge at frame ~30 and exit. */
const RUN_SECONDS = Number(process.env.DEMO_SECS ?? 30);

const failures: string[] = [];

for (const demo of DEMOS) {
    await harness().openWgb(`${DEMOS_DIR}/${demo.name}.wgb`).sleep(RUN_SECONDS * 1000).run();

    // The demo's own log, not our screenshot: it judged its pixels against the maths, and a
    // missing log is a FAILURE rather than a skip — "it never ran" must not read as "it passed".
    const r: any = await harness().call("fsRead", `c:\\${demo.name}.log`).run();
    const content = r.steps?.[0]?.result?.content;
    if (!content) {
        failures.push(`${demo.name}: no verdict log — the demo did not run to its check frame`);
        console.log(`${demo.name}: NO LOG`);
        continue;
    }

    const text = Buffer.from(content, "base64").toString("latin1");
    const verdicts = text.split(/\r?\n/).filter((l) => l.startsWith("RESULT:"));
    const passed = verdicts.length > 0 && verdicts.every((l) => l.startsWith("RESULT: PASS"));
    console.log(`${demo.name} (${demo.what}): ${passed ? "PASS" : "FAIL"}`);
    if (!passed) {
        for (const line of verdicts.filter((l) => !l.startsWith("RESULT: PASS")).slice(0, 6)) {
            console.log(`    ${line}`);
        }
        failures.push(`${demo.name}: ${verdicts.find((l) => !l.startsWith("RESULT: PASS")) ?? "no RESULT line"}`);
    }
}

if (failures.length) {
    console.log(`REGRESSION: ${failures.length}/${DEMOS.length} shader demo(s) failed`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
}
