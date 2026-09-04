/**
 * The video plane must never cover a UI the game draws itself.
 *
 * Far Cry loops a Bink clip as its main-menu backdrop: it copies each frame into a private
 * buffer, uploads that into its OWN D3D9 texture, and draws the menu on top. Our video
 * overlay plane is a COMPENSATION layer for the opposite shape — an app whose upload path
 * loses the pixels — so compositing it here paints the movie over the menu. That is the
 * class under test, not this title: any game that plays a movie into its own frame is one
 * routing miss away from the same screen.
 *
 * Both halves are asserted, because the naive repair passes half of it:
 *  - the intro DOES reach the screen through the plane (`overlay.composites` rises), so a
 *    fix that simply switches the plane off fails here rather than looking green;
 *  - at the menu the plane is off, with a NAMED reason from the single policy
 *    (video/video-plane-policy.ts).
 *
 * Both numbers come from the plane's own census rather than from the picture: a screenshot
 * of a menu and a screenshot of a menu with a movie over it are told apart by a human, and
 * `composites` frozen while `submits` keeps rising is the same fact as a number.
 */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/todo/far-cry.wgb";

const r: any = await harness()
    .reload()
    .openWgb(WGB, { reload: false })
    // Long enough for the intro to play through and the menu to come up. Wall-clock, not
    // frames: during a movie the present cadence is the movie's, not the game's. Split
    // because one RPC may not outlast the harness call deadline.
    .call("sleep", 45000)
    .call("sleep", 45000)
    .call("sleep", 45000)
    .call("state", ["video"])
    .call("shot", { save: "video-plane-over-menu" })
    .run();

if (!r.ok) throw new Error(`run failed: ${r.error?.message ?? "unknown"}`);

const plane = r.named?.state?.video?.plane;
if (!plane) throw new Error("state(['video']).plane is missing — the policy's verdict is not reported");

console.log(JSON.stringify(plane, null, 1));

// The plane's own census carries the first half: `composites` is what a present path actually
// put on screen, so a fix that simply switches the plane off leaves it at zero and fails here
// instead of looking green.
if ((plane.overlay?.composites ?? 0) <= 0) {
    throw new Error("the video plane never reached the screen in this run — the intro is not "
        + "playing, so the run cannot tell a working policy from a disabled plane");
}
if (plane.onScreen) {
    throw new Error(`the video plane is still on screen at the menu (reason=${plane.reason}, `
        + `covered ${plane.coveredGuestPresents} guest presents) — it is covering the game's UI`);
}
console.log(`OK — intro composited ${plane.overlay.composites} frame(s); `
    + `at the menu the plane is off (reason=${plane.reason}).`);
