/**
 * compareReference() — our screen against a NATIVE Windows capture, per pixel,
 * over named regions.
 *
 * The demos in `bottleship-demos` build without an application manifest, so
 * Windows draws them with comctl32 v5's non-visual-styles code: the bevel
 * STRUCTURE in a native capture is the classic one we recreate. What differs is
 * the palette — Win11 ships a lighter system-colour scheme than the Win98 one
 * the emulator targets — so the reference is remapped colour-by-colour before
 * the compare, and a reference pixel outside that map is UNMAPPED: excluded from
 * the diff but counted and reported, because a region that "passes" by being
 * entirely unmapped is a test that cannot fail. Antialiased text is the bulk of
 * the unmapped pixels, which is why text regions are excluded by name.
 *
 * Reports WHERE, not just whether: per region a diff count, the fraction, and
 * the bounding box of the differing pixels, plus a few sampled colour pairs.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { bytesToBase64, debugDumpPath } from "./screen";

interface Region { name: string; x: number; y: number; w: number; h: number }

interface CompareArgs {
    /** Reference PNG, same-origin URL (e.g. "/reference/propsheet_zoo-native.png"). */
    url: string;
    /** Screen coordinates the reference's (0,0) maps to. */
    at: { x: number; y: number };
    /** [referenceHex, ourHex] pairs, "#RRGGBB" or "RRGGBB". */
    palette: [string, string][];
    /** Rects in REFERENCE coordinates. Omit to compare the whole image as one. */
    regions?: Region[];
    /** Rects in REFERENCE coordinates excluded from every region (text, icons). */
    ignore?: { x: number; y: number; w: number; h: number }[];
    /** Save a diff PNG (ours, differing pixels reddened) to logs/debug/. */
    save?: string;
}

const parseHex = (s: string): number => {
    const h = s.replace(/^#/, "");
    return ((parseInt(h.slice(0, 2), 16) << 16) | (parseInt(h.slice(2, 4), 16) << 8)
        | parseInt(h.slice(4, 6), 16)) >>> 0;
};

const toHex = (v: number): string => "#" + v.toString(16).padStart(6, "0");

async function bitmapPixels(bmp: ImageBitmap): Promise<ImageData> {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height);
}

export function registerReferenceCommands(svc: HarnessService): void {
    svc.register("compareReference", async (args) => {
        const a = (args[0] ?? {}) as CompareArgs;
        if (!a.url) throw new HarnessError("compareReference needs a reference url", HarnessErrorCode.BAD_ARGS);
        if (!a.palette?.length) {
            throw new HarnessError(
                "compareReference needs a palette: the native capture is the classic code path but NOT the "
                + "classic colour scheme, so an unremapped compare differs everywhere and proves nothing.",
                HarnessErrorCode.BAD_ARGS,
            );
        }

        const res = await fetch(a.url);
        if (!res.ok) {
            throw new HarnessError(
                `reference ${a.url} -> HTTP ${res.status}. Copy the demo's shots/*.png into public/ so the dev`
                + " server can serve it.", HarnessErrorCode.UNSUPPORTED);
        }
        const refPixels = await bitmapPixels(await createImageBitmap(await res.blob()));

        const render: any = sys().services?.render;
        const blob: Blob | null = await render?.captureScreen?.();
        if (!blob) {
            throw new HarnessError("cannot see the screen — nothing presented yet", HarnessErrorCode.UNSUPPORTED);
        }
        const ours = await bitmapPixels(await createImageBitmap(blob));

        const map = new Map<number, number>();
        for (const [from, to] of a.palette) map.set(parseHex(from), parseHex(to));

        const regions: Region[] = a.regions?.length
            ? a.regions
            : [{ name: "all", x: 0, y: 0, w: refPixels.width, h: refPixels.height }];
        const ignore = a.ignore ?? [];
        const ignored = (rx: number, ry: number): boolean =>
            ignore.some((i) => rx >= i.x && rx < i.x + i.w && ry >= i.y && ry < i.y + i.h);

        const diffMask = a.save ? new Uint8Array(ours.width * ours.height) : null;
        const out = regions.map((r) => {
            let compared = 0, diff = 0, unmapped = 0, outside = 0;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            const samples: { x: number; y: number; ours: string; want: string }[] = [];
            for (let j = 0; j < r.h; j++) {
                for (let i = 0; i < r.w; i++) {
                    const rx = r.x + i, ry = r.y + j;
                    if (ignored(rx, ry)) continue;
                    if (rx < 0 || ry < 0 || rx >= refPixels.width || ry >= refPixels.height) continue;
                    const sx = a.at.x + rx, sy = a.at.y + ry;
                    if (sx < 0 || sy < 0 || sx >= ours.width || sy >= ours.height) { outside++; continue; }
                    const ri = (ry * refPixels.width + rx) * 4;
                    const refRgb = (refPixels.data[ri] << 16 | refPixels.data[ri + 1] << 8
                        | refPixels.data[ri + 2]) >>> 0;
                    const want = map.get(refRgb);
                    if (want === undefined) { unmapped++; continue; }
                    const oi = (sy * ours.width + sx) * 4;
                    const got = (ours.data[oi] << 16 | ours.data[oi + 1] << 8 | ours.data[oi + 2]) >>> 0;
                    compared++;
                    if (got === want) continue;
                    diff++;
                    if (diffMask) diffMask[sy * ours.width + sx] = 1;
                    if (rx < x0) x0 = rx;
                    if (ry < y0) y0 = ry;
                    if (rx > x1) x1 = rx;
                    if (ry > y1) y1 = ry;
                    if (samples.length < 6) {
                        samples.push({ x: rx, y: ry, ours: toHex(got), want: toHex(want) });
                    }
                }
            }
            return {
                name: r.name, rect: { x: r.x, y: r.y, w: r.w, h: r.h },
                compared, diff, unmapped, outside,
                pct: compared ? +(100 * diff / compared).toFixed(2) : null,
                bbox: diff ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
                samples,
            };
        });

        let saved: string | null = null;
        if (a.save && diffMask) {
            const c = new OffscreenCanvas(ours.width, ours.height);
            const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
            const img = new ImageData(new Uint8ClampedArray(ours.data), ours.width, ours.height);
            for (let p = 0; p < diffMask.length; p++) {
                if (!diffMask[p]) continue;
                img.data[p * 4] = 255; img.data[p * 4 + 1] = 0; img.data[p * 4 + 2] = 255;
            }
            g.putImageData(img, 0, 0);
            const png = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
            const name = a.save.replace(/\.png$/i, "");
            (self as unknown as Worker).postMessage({
                type: "debug_png_dump", name, base64: bytesToBase64(png),
            });
            saved = debugDumpPath(name);
        }

        return {
            url: a.url, at: a.at, screen: { w: ours.width, h: ours.height },
            reference: { w: refPixels.width, h: refPixels.height },
            regions: out, saved,
        };
    });

    /**
     * screenMark() / screenChangeSince() — WHICH pixels a transition touched.
     *
     * A hash answers "did this rect change"; the question a repaint-scope bug asks is
     * "what changed that had no business changing", and that needs the two frames
     * compared per pixel with the expected rects named. `allow` is the region the
     * caller asked to be repainted; every changed pixel outside it is the finding, and
     * the count INSIDE it is the positive control — without it, a run where nothing
     * rendered at all reports a perfect zero and passes.
     */
    let mark: ImageData | null = null;

    svc.register("screenMark", async () => {
        const render: any = sys().services?.render;
        const blob: Blob | null = await render?.captureScreen?.();
        if (!blob) throw new HarnessError("cannot see the screen", HarnessErrorCode.UNSUPPORTED);
        const px = await bitmapPixels(await createImageBitmap(blob));
        mark = px;
        return { marked: true, screen: { w: px.width, h: px.height } };
    });

    svc.register("screenChangeSince", async (args) => {
        const a = (args[0] ?? {}) as {
            allow?: { name?: string; x: number; y: number; w: number; h: number }[];
            within?: { x: number; y: number; w: number; h: number };
        };
        if (!mark) {
            throw new HarnessError("screenChangeSince needs a screenMark() first",
                HarnessErrorCode.BAD_ARGS);
        }
        const render: any = sys().services?.render;
        const blob: Blob | null = await render?.captureScreen?.();
        if (!blob) throw new HarnessError("cannot see the screen", HarnessErrorCode.UNSUPPORTED);
        const now = await bitmapPixels(await createImageBitmap(blob));
        const was = mark;
        if (now.width !== was.width || now.height !== was.height) {
            throw new HarnessError(
                `screen resized between mark and compare (${was.width}x${was.height} -> `
                + `${now.width}x${now.height}) — nothing can be compared`, HarnessErrorCode.UNSUPPORTED);
        }

        const allow = (a.allow ?? []).map((r, i) => ({ name: r.name ?? `allow${i}`, ...r, changed: 0 }));
        const scan = a.within ?? { x: 0, y: 0, w: now.width, h: now.height };
        const x0 = Math.max(0, scan.x | 0), y0 = Math.max(0, scan.y | 0);
        const x1 = Math.min(now.width, x0 + (scan.w | 0)), y1 = Math.min(now.height, y0 + (scan.h | 0));

        let changed = 0, outside = 0, compared = 0;
        let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
        const samples: { x: number; y: number; before: string; after: string }[] = [];
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                compared++;
                const i = (y * now.width + x) * 4;
                if (now.data[i] === was.data[i] && now.data[i + 1] === was.data[i + 1]
                    && now.data[i + 2] === was.data[i + 2]) continue;
                changed++;
                let inAllow = false;
                for (const r of allow) {
                    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { r.changed++; inAllow = true; }
                }
                if (inAllow) continue;
                outside++;
                if (x < ox0) ox0 = x;
                if (y < oy0) oy0 = y;
                if (x > ox1) ox1 = x;
                if (y > oy1) oy1 = y;
                if (samples.length < 8) {
                    samples.push({
                        x, y,
                        before: toHex((was.data[i] << 16 | was.data[i + 1] << 8 | was.data[i + 2]) >>> 0),
                        after: toHex((now.data[i] << 16 | now.data[i + 1] << 8 | now.data[i + 2]) >>> 0),
                    });
                }
            }
        }
        return {
            screen: { w: now.width, h: now.height }, scanned: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
            compared, changed,
            allow: allow.map((r) => ({ name: r.name, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, changed: r.changed })),
            outside: {
                changed: outside,
                bbox: outside ? { x: ox0, y: oy0, w: ox1 - ox0 + 1, h: oy1 - oy0 + 1 } : null,
                samples,
            },
            note: changed === 0
                ? "NOTHING on the screen changed — a scope assertion over this is vacuous"
                : null,
        };
    });

    /**
     * screenRegionHash() — a stable digest of a screen rect, for A -> B -> A
     * identity checks that need no reference image at all: capture, drive a
     * transition, capture again, and an unequal hash means we stamped or erased
     * something the guest owns.
     */
    svc.register("screenRegionHash", async (args) => {
        const r = (args[0] ?? {}) as { x: number; y: number; w: number; h: number };
        const render: any = sys().services?.render;
        const blob: Blob | null = await render?.captureScreen?.();
        if (!blob) throw new HarnessError("cannot see the screen", HarnessErrorCode.UNSUPPORTED);
        const px = await bitmapPixels(await createImageBitmap(blob));
        const x0 = Math.max(0, r.x | 0), y0 = Math.max(0, r.y | 0);
        const x1 = Math.min(px.width, x0 + (r.w | 0)), y1 = Math.min(px.height, y0 + (r.h | 0));
        if (x1 <= x0 || y1 <= y0) {
            throw new HarnessError(`region ${JSON.stringify(r)} is outside the ${px.width}x${px.height} screen`,
                HarnessErrorCode.BAD_ARGS);
        }
        // FNV-1a over RGB, plus a mean so an all-black readback is recognisable
        // as such rather than just "a different hash".
        let hash = 0x811c9dc5, sum = 0, n = 0;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * px.width + x) * 4;
                for (let k = 0; k < 3; k++) {
                    hash = Math.imul(hash ^ px.data[i + k], 0x01000193) >>> 0;
                    sum += px.data[i + k];
                    n++;
                }
            }
        }
        return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, hash, mean: +(sum / n).toFixed(2) };
    });
}
