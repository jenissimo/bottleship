/**
 * Red Faction intro regression: the video must assemble, not tile.
 *
 * The guest streams one 640x480 Bink frame through a SINGLE 256x256 scratch texture — copy
 * tile, draw its quad, copy the next tile, draw the next quad, six times per frame. Both the
 * CopyRects and the quads are correct; what breaks is a backend that records the whole frame
 * into one command buffer while every upload runs ahead of it on the queue, so all six quads
 * sample the LAST tile. This asserts the screen against the frame the guest actually decoded,
 * which is the only check that can tell "assembled" from "six stretched copies".
 *
 *   WGB=g:/WGB/todo/red-faction.wgb bun tools/harness.ts run tools/harness/regression/red-faction-video-tiles.harness.ts
 *
 * Requires the launcher's video-card gate to be satisfied first: run
 * tools/harness/regression/red-faction-launcher.harness.ts, pick a card in Setup, then Play.
 */

import { harness } from "../../harness";

const TILES = [
    { sx: 0, sy: 0, w: 256, h: 256 },
    { sx: 256, sy: 0, w: 256, h: 256 },
    { sx: 512, sy: 0, w: 128, h: 256 },
    { sx: 0, sy: 256, w: 256, h: 224 },
    { sx: 256, sy: 256, w: 256, h: 224 },
    { sx: 512, sy: 256, w: 128, h: 224 },
];

/** Mean RGB of a rect of the live canvas, read in the page (no PNG round-trip). */
const canvasMeans = (rects: typeof TILES) => `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const g = document.createElement('canvas');
    g.width = c.width; g.height = c.height;
    g.getContext('2d').drawImage(c, 0, 0);
    const ctx = g.getContext('2d');
    return ${JSON.stringify(rects)}.map(t => {
        const d = ctx.getImageData(t.sx, t.sy, t.w, t.h).data;
        let r = 0, gg = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i+1]; b += d[i+2]; }
        const n = d.length / 4;
        return [r / n, gg / n, b / n];
    });
})()`;

// The Bink destination surface: the 640x480 R5G6B5 image surface the guest decodes into.
// The intro starts a while after the game boots, so wait for that surface to exist rather
// than demanding the caller time the run.
const deadline = Date.now() + Number(process.env.WAIT_MS ?? 180_000);
let src: any;
for (;;) {
    const surfaces: any = await harness().call("textures").run();
    src = (surfaces.steps?.[0]?.result?.d3d8 ?? []).find(
        (s: any) => s.width === 640 && s.height === 480 && s.bpp === 16,
    );
    if (src) break;
    if (Date.now() > deadline) throw new Error("no 640x480 16bpp d3d8 surface — the intro never started");
    await harness().sleep(2000).run();
}
console.log(`bink source ${src.ptrHex} mem=${src.surfacePtr} pitch=${src.pitch}`);

const addr = parseInt(src.surfacePtr, 16);
const chain = harness();
const total = src.pitch * 480;
for (let off = 0; off < total; off += 0x10000) {
    chain.call("readBytes", addr + off, Math.min(0x10000, total - off));
}
const dump: any = await chain.run();
let hex = "";
for (const s of dump.steps ?? []) if (s.cmd === "readBytes" && s.result?.hex) hex += s.result.hex;
const bytes = new Uint8Array(hex.length / 2);
for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

/** Mean RGB of a source tile, decoded from R5G6B5. */
function srcMean(t: typeof TILES[number]): [number, number, number] {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = t.sy; y < t.sy + t.h; y++) {
        for (let x = t.sx; x < t.sx + t.w; x++) {
            const o = y * src.pitch + x * 2;
            const v = bytes[o] | (bytes[o + 1] << 8);
            r += ((v >> 11) & 0x1f) << 3; g += ((v >> 5) & 0x3f) << 2; b += (v & 0x1f) << 3;
            n++;
        }
    }
    return [r / n, g / n, b / n];
}

const shot: any = await harness().evalPage(canvasMeans(TILES)).run();
const screen = shot.steps?.[0]?.result;
if (!Array.isArray(screen)) throw new Error("could not read canvas tile means");

let worst = 0;
for (let i = 0; i < TILES.length; i++) {
    const s = srcMean(TILES[i]);
    const c = screen[i];
    const d = Math.max(Math.abs(s[0] - c[0]), Math.abs(s[1] - c[1]), Math.abs(s[2] - c[2]));
    worst = Math.max(worst, d);
    console.log(`tile ${i} src=[${s.map((v) => v.toFixed(1))}] screen=[${c.map((v: number) => v.toFixed(1))}] Δ=${d.toFixed(1)}`);
}
// A video advances between the two reads, so this is a structural check, not a pixel diff:
// six quads all showing the LAST tile land far outside this, an assembled frame stays inside.
if (worst > 24) throw new Error(`screen tiles do not match the decoded frame (worst Δ=${worst.toFixed(1)}) — the video is not assembling`);
console.log(`OK — all six tiles match the decoded frame (worst Δ=${worst.toFixed(1)})`);
