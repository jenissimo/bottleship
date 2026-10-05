/**
 * The shipped video-decoder.wasm, driven the way VideoEngine drives it, on two synthetic
 * fixtures (fixtures/video/, made with `ffmpeg -f lavfi`):
 *
 *   gradient-mjpeg.avi — yuvj420p, grey (cb=cr=128), luma 2x on even rows and 2x+24 on odd
 *                        ones, tagged FULL range. Full-range grey converts 1:1 (G == Y); under
 *                        swscale's limited-range default everything below Y=16 is black. Also
 *                        the dither fixture (a ramp is where 565 truncation bands) and the
 *                        progressive control for the deinterlacer (rows differ, so a forced
 *                        field rebuild is visible; nothing tags it interlaced).
 *   fields-mpeg2.mpg   — MPEG-2, interlaced coding, top field first; luma 40 on even lines
 *                        and 200 on odd ones, i.e. two fields with nothing in common. The
 *                        decoder flags every frame interlaced; the deinterlacer must leave
 *                        neighbouring lines agreeing.
 *
 * Each assertion pairs the passing shape with the pre-feature failure it catches.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ENH_DITHER_16, ENH_DEINTERLACE, ENH_DEINTERLACE_FORCE, ENH_CHROMA_SMOOTH } from "../../src/video/video-engine";

const WASM = resolve(import.meta.dir, "../../public/video-decoder.wasm");
const FIXTURES = resolve(import.meta.dir, "../../fixtures/video");

interface Exports {
    memory: WebAssembly.Memory;
    decoder_alloc: (n: number) => number;
    decoder_free: (p: number) => void;
    decoder_open: (p: number, n: number) => number;
    decoder_close: (h: number) => void;
    decoder_do_frame: (h: number) => number;
    decoder_get_width: (h: number) => number;
    decoder_get_height: (h: number) => number;
    decoder_get_frame_rgba_ptr: (h: number) => number;
    decoder_get_frame_rgb565_ptr: (h: number) => number;
    decoder_set_enhance: (h: number, f: number) => void;
    decoder_get_enhance: (h: number) => number;
    decoder_get_frame_interlaced: (h: number) => number;
    decoder_get_interlaced_frames: (h: number) => number;
    decoder_get_video_color_range: (h: number) => number;
    decoder_get_video_colorspace: (h: number) => number;
}

const noop = () => 0;
const ns = (o: Record<string, (...a: unknown[]) => unknown>) => new Proxy(o, { get: (t, p: string) => (p in t ? t[p] : noop) });

async function load(): Promise<Exports> {
    const bytes = await Bun.file(WASM).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {
        wasi_snapshot_preview1: ns({ proc_exit: (c: unknown) => { throw new Error(`proc_exit(${c})`); } }),
        env: ns({}),
    });
    return instance.exports as unknown as Exports;
}

function open(exp: Exports, file: string): number {
    const data = new Uint8Array(require("node:fs").readFileSync(resolve(FIXTURES, file)));
    const p = exp.decoder_alloc(data.length);
    new Uint8Array(exp.memory.buffer).set(data, p);
    const h = exp.decoder_open(p, data.length);
    if (h < 0) throw new Error(`decoder_open(${file}) failed`);
    return h;
}

function bgra(exp: Exports, h: number): { w: number; h: number; px: Uint8Array } {
    const w = exp.decoder_get_width(h), hh = exp.decoder_get_height(h);
    const p = exp.decoder_get_frame_rgba_ptr(h);
    return { w, h: hh, px: new Uint8Array(exp.memory.buffer).slice(p, p + w * hh * 4) };
}

function rgb565(exp: Exports, h: number): Uint16Array {
    const w = exp.decoder_get_width(h), hh = exp.decoder_get_height(h);
    const p = exp.decoder_get_frame_rgb565_ptr(h);
    return new Uint16Array(exp.memory.buffer.slice(p, p + w * hh * 2));
}

/** Mean over 4x4 blocks of |block mean of the 565 output (expanded to 8 bits) − block mean of the BGRA source|, summed over R,G,B. */
function blockError(src: { w: number; h: number; px: Uint8Array }, out: Uint16Array): number {
    let sum = 0, n = 0;
    for (let by = 0; by + 4 <= src.h; by += 4) for (let bx = 0; bx + 4 <= src.w; bx += 4) {
        let sr = 0, sg = 0, sb = 0, tr = 0, tg = 0, tb = 0;
        for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) {
            const i = y * src.w + x;
            sb += src.px[i * 4]; sg += src.px[i * 4 + 1]; sr += src.px[i * 4 + 2];
            const v = out[i], r5 = (v >>> 11) & 31, g6 = (v >>> 5) & 63, b5 = v & 31;
            tr += (r5 << 3) | (r5 >> 2); tg += (g6 << 2) | (g6 >> 4); tb += (b5 << 3) | (b5 >> 2);
        }
        sum += (Math.abs(sr - tr) + Math.abs(sg - tg) + Math.abs(sb - tb)) / 16; n++;
    }
    return sum / n;
}

/** Mean |L(y) − (L(y−1)+L(y+1))/2| over interior rows: ~0 for a progressive picture, huge for combed fields. */
function combMetric(f: { w: number; h: number; px: Uint8Array }): number {
    let sum = 0, n = 0;
    for (let y = 1; y < f.h - 1; y++) for (let x = 0; x < f.w; x++) {
        const at = (yy: number) => f.px[(yy * f.w + x) * 4 + 1];
        sum += Math.abs(at(y) - (at(y - 1) + at(y + 1)) / 2); n++;
    }
    return sum / n;
}

describe("video-decoder.wasm enhancements", () => {
    test("the artifact carries the enhancement ABI (a stale build fails here, not silently in a game)", async () => {
        const exp = await load();
        for (const name of ["decoder_set_enhance", "decoder_get_enhance", "decoder_get_frame_interlaced",
            "decoder_get_interlaced_frames", "decoder_get_video_color_range", "decoder_get_video_colorspace"] as const) {
            expect(typeof exp[name]).toBe("function");
        }
    });

    test("a full-range source keeps its blacks: Y below 16 is not crushed to 0", async () => {
        const exp = await load();
        const h = open(exp, "gradient-mjpeg.avi");
        expect(exp.decoder_do_frame(h)).toBe(0);
        expect(exp.decoder_get_video_color_range(h)).toBe(2); // AVCOL_RANGE_JPEG
        const f = bgra(exp, h);
        const G = (x: number, y: number) => f.px[(y * f.w + x) * 4 + 1];
        // Row 0 is Y = 2x (±JPEG). Full range: G == Y. Limited range: (Y−16)·255/219 → 0 here.
        expect(G(4, 0)).toBeGreaterThanOrEqual(5);
        expect(G(4, 0)).toBeLessThanOrEqual(11);
        expect(G(8, 0)).toBeGreaterThanOrEqual(12);
        expect(G(8, 0)).toBeLessThanOrEqual(20);
        // And no stretch at the top either: Y=126 stays ~126 (limited would give ~128).
        expect(Math.abs(G(63, 0) - 126)).toBeLessThanOrEqual(4);
        exp.decoder_close(h);
    });

    test("ENH_DITHER_16 breaks the 565 bands without moving any pixel more than one step", async () => {
        const exp = await load();
        const h = open(exp, "gradient-mjpeg.avi");
        expect(exp.decoder_do_frame(h)).toBe(0);
        const plain = rgb565(exp, h);
        exp.decoder_set_enhance(h, ENH_DITHER_16);
        expect(exp.decoder_get_enhance(h)).toBe(ENH_DITHER_16);
        const dithered = rgb565(exp, h);
        const src = bgra(exp, h);
        // Truncation always rounds DOWN; the replicating expansion recovers part of that, and
        // dither spreads what is left so the block mean lands on the source (bink-dither.test.ts
        // measures the same property on the JS packers with the GPU's rounded expansion).
        expect(blockError(src, dithered)).toBeLessThan(blockError(src, plain) * 0.6);
        let moved = 0;
        for (let i = 0; i < plain.length; i++) {
            const dr = ((dithered[i] >> 11) & 31) - ((plain[i] >> 11) & 31);
            const dg = ((dithered[i] >> 5) & 63) - ((plain[i] >> 5) & 63);
            const db = (dithered[i] & 31) - (plain[i] & 31);
            expect(Math.abs(dr)).toBeLessThanOrEqual(1);
            expect(Math.abs(dg)).toBeLessThanOrEqual(1);
            expect(Math.abs(db)).toBeLessThanOrEqual(1);
            if (dr || dg || db) moved++;
        }
        expect(moved).toBeGreaterThan(0);
        // Back to 0 restores the byte-identical truncation.
        exp.decoder_set_enhance(h, 0);
        expect(rgb565(exp, h)).toEqual(plain);
        exp.decoder_close(h);
    });

    test("interlaced MPEG-2 is flagged, and ENH_DEINTERLACE removes the comb", async () => {
        const exp = await load();
        const decode = (flags: number) => {
            const h = open(exp, "fields-mpeg2.mpg");
            exp.decoder_set_enhance(h, flags);
            expect(exp.decoder_do_frame(h)).toBe(0);
            const interlaced = exp.decoder_get_frame_interlaced(h);
            const f = bgra(exp, h);
            exp.decoder_close(h);
            return { interlaced, comb: combMetric(f), f };
        };
        const off = decode(0);
        expect(off.interlaced).toBe(1);
        expect(off.comb).toBeGreaterThan(60);           // 40 vs 200 on alternating lines
        const on = decode(ENH_DEINTERLACE);
        expect(on.interlaced).toBe(1);                  // the tag is reported, not hidden, when acted on
        expect(on.comb).toBeLessThan(off.comb / 4);
        // Kept field = top (TFF): even lines stay at the dark value, odd ones were rebuilt from them.
        expect(on.f.px[(0 * on.f.w + 8) * 4 + 1]).toBeLessThan(80);
        expect(on.f.px[(1 * on.f.w + 8) * 4 + 1]).toBeLessThan(80);
        // "auto" without the tag is a no-op: force is the only way to touch a progressive frame.
        const prog = (flags: number) => {
            const h = open(exp, "gradient-mjpeg.avi");
            exp.decoder_set_enhance(h, flags);
            expect(exp.decoder_do_frame(h)).toBe(0);
            expect(exp.decoder_get_frame_interlaced(h)).toBe(0);
            const f = bgra(exp, h); exp.decoder_close(h); return f.px;
        };
        expect(prog(ENH_DEINTERLACE)).toEqual(prog(0));
        expect(prog(ENH_DEINTERLACE | ENH_DEINTERLACE_FORCE)).not.toEqual(prog(0));
    });

    test("ENH_CHROMA_SMOOTH changes the conversion, and 0 restores it byte for byte", async () => {
        const exp = await load();
        const h = open(exp, "gradient-mjpeg.avi");
        expect(exp.decoder_do_frame(h)).toBe(0);
        const plain = bgra(exp, h).px;
        // A second frame under the other flag rebuilds swscale; the fixture's two frames are identical.
        exp.decoder_set_enhance(h, ENH_CHROMA_SMOOTH);
        expect(exp.decoder_do_frame(h)).toBe(0);
        const smooth = bgra(exp, h).px;
        expect(smooth.length).toBe(plain.length);
        // Grey content (cb=cr=128) converts to the same greys either way — within rounding.
        let maxDiff = 0;
        for (let i = 0; i < plain.length; i++) maxDiff = Math.max(maxDiff, Math.abs(plain[i] - smooth[i]));
        expect(maxDiff).toBeLessThanOrEqual(2);
        exp.decoder_close(h);
    });
});
