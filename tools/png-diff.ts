/**
 * Minimal PNG reader + region differ for bring-up evidence.
 *
 * The harness can write a PNG per draw-scrub cut, but "did THIS draw put pixels on the
 * screen, and where" is a question about two images, and eyeballing two dark night frames
 * answers it wrong. `shot --verify` already diffs images, but only inside the browser and
 * only whole-frame; this is the offline twin, and it reports a BOUNDING BOX so a scrub
 * bisect says which draw painted which part of the screen instead of only whether the
 * frame changed.
 *
 * Handles what the harness actually emits: 8-bit RGB/RGBA/grey, non-interlaced.
 */
import { inflateSync } from "node:zlib";

export interface Png {
    width: number;
    height: number;
    /** RGBA8, width*height*4. */
    data: Uint8Array;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(bytes: Uint8Array): Png {
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== PNG_SIG[i]) throw new Error("not a PNG");
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
    const idat: Uint8Array[] = [];
    let palette: Uint8Array | null = null;

    while (off + 8 <= bytes.length) {
        const len = dv.getUint32(off);
        const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        const body = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = dv.getUint32(off + 8);
            height = dv.getUint32(off + 12);
            depth = bytes[off + 16]!;
            colorType = bytes[off + 17]!;
            interlace = bytes[off + 20]!;
        } else if (type === "PLTE") {
            palette = body.slice();
        } else if (type === "IDAT") {
            idat.push(body.slice());
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
    if (interlace !== 0) throw new Error("interlaced PNG unsupported");

    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : -1;
    if (channels < 0) throw new Error(`unsupported color type ${colorType}`);

    if (colorType === 3 && !palette) throw new Error("palette PNG with no PLTE chunk");
    if (idat.length === 0) throw new Error("PNG has no IDAT data");

    const merged = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
    let m = 0;
    for (const c of idat) { merged.set(c, m); m += c.length; }
    const raw = new Uint8Array(inflateSync(merged));

    const stride = width * channels;
    // A short IDAT would otherwise read `undefined`, and `NaN & 0xff` is 0 — a truncated
    // file would decode to black rows and the differ would report a confident wrong box.
    const expected = height * (stride + 1);
    if (raw.length < expected) {
        throw new Error(`truncated PNG: ${raw.length} bytes of pixel data, expected ${expected}`);
    }
    const px = new Uint8Array(height * stride);
    let rp = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[rp++]!;
        const row = px.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const rawv = raw[rp++]!;
            const a = x >= channels ? row[x - channels]! : 0;
            const b = prev ? prev[x]! : 0;
            const c = prev && x >= channels ? prev[x - channels]! : 0;
            let v: number;
            switch (filter) {
                case 0: v = rawv; break;
                case 1: v = rawv + a; break;
                case 2: v = rawv + b; break;
                case 3: v = rawv + ((a + b) >> 1); break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                    break;
                }
                default: throw new Error(`bad filter ${filter}`);
            }
            row[x] = v & 0xff;
        }
    }

    const data = new Uint8Array(width * height * 4);
    const plte = palette ?? new Uint8Array(0);
    for (let i = 0; i < width * height; i++) {
        if (colorType === 3) {
            const p = px[i]! * 3;
            data[i * 4] = plte[p] ?? 0; data[i * 4 + 1] = plte[p + 1] ?? 0;
            data[i * 4 + 2] = plte[p + 2] ?? 0; data[i * 4 + 3] = 255;
        } else if (channels === 1) {
            const g = px[i]!;
            data[i * 4] = g; data[i * 4 + 1] = g; data[i * 4 + 2] = g; data[i * 4 + 3] = 255;
        } else {
            data[i * 4] = px[i * channels]!;
            data[i * 4 + 1] = px[i * channels + 1]!;
            data[i * 4 + 2] = px[i * channels + 2]!;
            data[i * 4 + 3] = channels === 4 ? px[i * channels + 3]! : 255;
        }
    }
    return { width, height, data };
}

export interface DiffResult {
    /** Pixels whose max RGB channel delta exceeds `threshold` (alpha is not compared). */
    changed: number;
    total: number;
    meanAbs: number;
    maxAbs: number;
    /** null when nothing changed. */
    box: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function diffPng(a: Png, b: Png, threshold = 8): DiffResult {
    if (a.width !== b.width || a.height !== b.height) {
        throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    }
    let changed = 0, sum = 0, max = 0;
    let x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4;
            const d = Math.max(
                Math.abs(a.data[i]! - b.data[i]!),
                Math.abs(a.data[i + 1]! - b.data[i + 1]!),
                Math.abs(a.data[i + 2]! - b.data[i + 2]!),
            );
            sum += d;
            if (d > max) max = d;
            if (d > threshold) {
                changed++;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    const total = a.width * a.height;
    return { changed, total, meanAbs: sum / total, maxAbs: max, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
}

if (import.meta.main) {
    const [pa, pb, thr] = process.argv.slice(2);
    if (!pa || !pb) {
        console.error("usage: bun tools/png-diff.ts <a.png> <b.png> [threshold]");
        process.exit(2);
    }
    const A = decodePng(new Uint8Array(await Bun.file(pa).arrayBuffer()));
    const B = decodePng(new Uint8Array(await Bun.file(pb).arrayBuffer()));
    console.log(JSON.stringify(diffPng(A, B, thr ? Number(thr) : 8)));
}
