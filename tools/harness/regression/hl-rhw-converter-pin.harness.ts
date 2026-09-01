/**
 * A pre-transformed (XYZRHW) draw must always take the SAME vertex converter.
 *
 * Two converters compute the clip-space position of an XYZRHW vertex — a WGSL compute shader
 * and a JS mirror of it — and they cannot agree bit-for-bit however carefully the JS follows
 * the WGSL's operation order: a GPU divide goes through an approximate reciprocal, and the
 * `* 2 - 1` that follows cancels, so one vertex lands tens of ULPs away. The converter is
 * chosen by vertex count (GPU_VERTEX_THRESHOLD), and a triangle fan is CPU-converted whatever
 * its count. Half-Life draws a lightmap/decal pass over the SAME triangles with depth writes
 * off, so a base pass and its overlay landing on opposite sides of that choice disagree on
 * depth: half the pixels fail the test and the surface wears a dither grid that crawls with
 * the camera. Pre-transformed draws are therefore pinned to one converter.
 *
 * This is the check that the pin holds. It is deliberately not a screenshot: the lamps in this
 * level flicker on their own, so single frames compare different phases and read as proof
 * either way. The converter's own counters do not care about phase.
 *
 * A zero is only evidence when the case was reached, so the run also requires `rhwPinnedDraws`
 * — draws the pin diverted that the count WOULD have sent to the GPU — to be non-zero. A spot
 * on the map where every draw is under the threshold reports zero conversions whether the pin
 * works or not, and that run fails as "no coverage" instead of passing quietly.
 *
 * Half-Life is the fixture because its whole world is XYZRHW; any software-transform D3D7
 * title would do.
 *
 * Prereqs: `bun tools/harness.ts up`.
 *   WGB=G:/WGB/running/hl-uplink-skipvideo.wgb bun tools/harness.ts run tools/harness/regression/hl-rhw-converter-pin.harness.ts
 */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/running/hl-uplink-skipvideo.wgb";

const fail = (why: string): never => {
    console.log(`REGRESSION: ${why}`);
    process.exit(1);
};

// Boot to the main menu, start a game, and let the level load. The menu is drawn by the
// engine, so gate on its labels rather than on presents.
const boot: any = await harness()
    .reload()
    .openWgb(WGB, { reload: false })
    .sleep(45_000)
    .waitForControl("New game", { timeoutMs: 60_000 })
    .sleep(1_500)
    .click("New game")
    .waitForControl("Medium", { timeoutMs: 30_000 })
    // The skill menu animates in, and a click landing during that is swallowed — the control
    // is already reported as present. Settle before clicking it.
    .sleep(2_500)
    .click("Medium")
    .sleep(45_000)
    .run();

if (boot.ok === false) fail(`the run never reached the level — ${boot.error?.cmd}: ${boot.error?.message}`);

// A swallowed menu click leaves the game sitting in the front-end, where every counter below
// reads zero for a reason that has nothing to do with the pin. Say so instead.
const stillInMenu: any = await harness().waitForControl("Medium", { timeoutMs: 3_000 }).run();
if (stillInMenu.ok !== false) fail("still in the skill menu after clicking Medium — the level never loaded");

// Walk forward: the spawn corridor can be entirely below the vertex threshold, and a census
// there would have nothing to say. Movement also puts the coplanar overlay passes on screen.
await harness().keyHold("W", 1200).sleep(1500).run();

const r: any = await harness().call("vertexConverterCensus", { windowMs: 4000 }).run();
const c = r.named?.vertexConverterCensus;
if (!c) fail(`the census did not run — ${JSON.stringify(r.error)}`);
if (c.armed === false) fail(String(c.note));

console.log(`census: rhwGpuConversions=${c.rhwGpuConversions} rhwPinnedDraws=${c.rhwPinnedDraws} `
    + `(all-FVF gpuConversions=${c.gpuConversions})`);

if (!(c.rhwPinnedDraws > 0)) {
    fail(`the pin diverted 0 draws in this window, so a zero GPU-conversion count says nothing — `
        + `the scene never produced a pre-transformed draw at or above the threshold`);
}

// The all-FVF `gpuConversions` would also count an ordinary transformed draw, which is no
// defect at all; only a PRE-TRANSFORMED one reaching the GPU converter is.
if (c.rhwGpuConversions !== 0) {
    fail(`${c.rhwGpuConversions} pre-transformed draw(s) took the GPU converter while `
        + `${c.rhwPinnedDraws} were pinned — a coplanar overlay can disagree on depth with its `
        + `base pass again`);
}

console.log(`OK: ${c.rhwPinnedDraws} pre-transformed draw(s) stayed on one converter, `
    + `0 reached the GPU one`);
