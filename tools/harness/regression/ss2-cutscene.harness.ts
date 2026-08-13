/**
 * System Shock 2 (NewDark) — cutscene regression for the HLE lgvid module.
 *
 * The shipped lgvid.dll front-ends a bundled ffmpeg.dll; we answer its two exports with
 * the native VideoEngine (src/worker/modules/lgvid.ts). This script guards the whole
 * seam, cold:
 *
 *  - `always_play_intro` fires Intro.avi before the menu, and New Game -> Start Game
 *    plays cs1.avi. Both drive the guest-callback chain (BeginFrame -> LockFrameBuffer,
 *    EndFrame -> ShowFrame -> EndFrame): the engine owns the frame buffers, so a broken
 *    chain shows up as a frozen or absent picture rather than an error.
 *  - The assertion is the module's own teardown line, which reports how many frames it
 *    actually handed to the engine. That is the quantity under test; a screen-brightness
 *    proxy would pass on a movie that never advanced past frame 0. (`expectSurfaceNonBlack`
 *    is a ddraw-path verb and cannot see this title's d3d9 output at all.)
 *  - It also carries the per-call decode/scale cost. The scaler stands in for the real
 *    DLL's sws_scale and runs on the worker that feeds the audio ring: a regression there
 *    is heard as choppy audio long before it is seen, so the numbers are printed.
 *
 * The PNGs are for eyeballing colour and geometry — the two bugs bring-up actually hit.
 */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/system-shock-ii.wgb";

const r: any = await harness()
    .reload()
    .call("streamLogs", ["SYSTEM"])
    .call("watchLog", "lgvid: (opened|destroyed)")
    .openWgb(WGB, { reload: false })
    // Wall-clock, not frames: during a cutscene the present cadence is the movie's.
    .call("sleep", 24000)
    .call("shot", { save: "ss2-cutscene-intro" })
    .tickFrames(60)
    .call("move", 616, 62).call("clickHold", 616, 62, 250)     // New Game
    .tickFrames(180)
    .call("move", 468, 370).call("clickHold", 468, 370, 250)   // Start Game
    .call("sleep", 20000)
    .call("shot", { save: "ss2-cutscene-cs1" })
    .call("events", 40, "logMatch")
    .call("faults")
    .run();

if (!r.ok) throw new Error(`cutscene run failed: ${r.error?.message ?? "unknown"}`);

const lines = ((r.named?.events ?? []) as any[])
    .map((e) => String(e?.data?.message ?? e?.data?.line ?? ""))
    .filter((l) => l.includes("lgvid: "));
for (const l of lines) console.log(" ", l);

const opened = lines.filter((l) => l.includes("lgvid: opened"));
// cs1.avi runs well past this script's window, so completion is asserted on the intro;
// cs1 is asserted to have STARTED, which is what the New Game path actually adds.
const shown = lines
    .filter((l) => l.includes("lgvid: destroyed"))
    .map((l) => Number(/\((\d+) frames shown\)/.exec(l)?.[1] ?? 0));
const faults = (r.named?.faults ?? []) as unknown[];
console.log(JSON.stringify({
    moviesOpened: opened.length, moviesFinished: shown.length, framesShown: shown, faults: faults.length,
    saved: ["logs/**/debug/ss2-cutscene-intro.png", "logs/**/debug/ss2-cutscene-cs1.png"],
}, null, 1));

if (opened.length < 2) throw new Error(`expected Intro.avi and cs1.avi to open, saw ${opened.length}`);
if (!shown.length) throw new Error("no movie finished — lgvid created a player but nothing played through");
for (const n of shown) if (n < 30) throw new Error(`a movie delivered only ${n} frames — playback stalled`);
if (faults.length) throw new Error(`${faults.length} unhandled fault(s) during cutscene playback`);
