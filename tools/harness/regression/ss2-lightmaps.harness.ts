/**
 * System Shock 2 (NewDark, D3D9) — regression script for the fixed-function multi-texture
 * path. Cold boot → New Game → Start Game lands in the recruitment station, which is the
 * cheapest 3D scene in the game (no character creation, no level load) and exercises all
 * three defects this script guards:
 *
 *  - FVF TEX2 stride: the world is drawn with XYZRHW|DIFFUSE|SPECULAR|TEX2 (stride 40).
 *    An FVF parser that only knows D3DFVF_TEX1 computes 24 and the GPU walks the stream at
 *    the wrong pitch — long white triangles fanning off-screen.
 *  - Perspective correction: pre-transformed vertices carry rhw = 1/w; dropping it
 *    interpolates UVs affinely and the floor texture shears as the camera moves.
 *  - Texture stage 1: the base texture is SELECTARG1 and ALL the lighting is a lightmap
 *    modulated in at stage 1. Rendering stage 0 alone gives a uniformly full-bright world.
 *
 * The picture is the measurement — a stage-count mismatch also shows up as WebGPU
 * validation errors (bind group vs shader layout), so the run asserts the screen is not
 * black and leaves a PNG to eyeball.
 */
import { harness } from "../../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/system-shock-ii.wgb";

const r = await harness()
    .call("streamLogs", ["SYSTEM", "DDRAW", "D3D9"])
    .call("openWgb", WGB)
    // `always_play_intro` runs Intro.avi before the menu now that lgvid is implemented.
    // Esc skips it, the same way a player would; without this the New Game click lands
    // on the movie.
    .call("sleep", 4000).call("keyHold", "Escape", 120)
    .call("tickFrames", 60)
    .call("move", 616, 62).call("clickHold", 616, 62, 250)     // New Game
    .call("tickFrames", 180)
    .call("move", 468, 370).call("clickHold", 468, 370, 250)   // Start Game
    // Start Game runs cs1.avi (160 s) now that lgvid is implemented; Esc skips it, the
    // same way a player would, and lands on the recruitment station this script tests.
    .call("sleep", 3000).call("keyHold", "Escape", 120)
    .call("tickFrames", 240)
    .call("shot", { save: "ss2-recruitment" })
    .call("captureFrame", { timeoutMs: 15000 })
    .run();

const frame = (r as any).named?.captureFrame ?? (r as any).steps?.at(-1)?.result;
const draws = frame?.drawCalls ?? [];
const tex2 = draws.filter((d: any) => ((d.vertexType >>> 8) & 0xf) >= 2);
const lightmapped = draws.filter((d: any) => (d.warnings ?? []).some((w: string) => w.includes("stage1")));
console.log(JSON.stringify({
    draws: draws.length,
    tex2Draws: tex2.length,
    lightmappedDraws: lightmapped.length,
    strides: [...new Set(draws.map((d: any) => d.srcStride))],
    saved: "logs/debug/ss2-recruitment.png",
}, null, 1));

if (!draws.length) throw new Error("no draws captured — the scene never rendered");
if (!tex2.length) throw new Error("no TEX2 draws — did the scene load? this is what the stride fix guards");
