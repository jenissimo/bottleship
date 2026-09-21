/**
 * gdiDcs / gdiDump — answer "which DC holds what" from the pixels, not from reasoning
 * about DC topology. A GDI composite runs over several surfaces at once (the window DC,
 * the memory DC its bitmap is selected into, the retained client image, the flat overlay),
 * and the whole class of "the artwork is somewhere but not on screen" bugs is settled by
 * asking each of them what it actually contains.
 *
 * gdiDcs() lists every live DC and every retained window-client image with a coverage
 * summary (opaque / non-black fraction, mean luma) — a surface that is entirely black is
 * then a fact, not an inference. gdiDump(sel) writes one of them out as a PNG.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { bytesToBase64, debugDumpPath } from "./screen";

interface Coverage {
    /** Fraction of pixels with alpha > 0. */
    opaque: number;
    /** Fraction of pixels that are neither transparent nor pure black. */
    nonBlack: number;
    /** Mean luma over the OPAQUE pixels, 0-255 (null when nothing is opaque). */
    luma: number | null;
}

/** Coverage of a canvas, sampled on a grid so a 4k surface costs the same as a button. */
function coverage(canvas: OffscreenCanvas): Coverage | null {
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) return null;
    let data: Uint8ClampedArray;
    try {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch {
        return null;
    }
    const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 65536)));
    let n = 0, opaque = 0, nonBlack = 0, luma = 0;
    for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
            const i = (y * canvas.width + x) * 4;
            n++;
            if (data[i + 3] === 0) continue;
            opaque++;
            const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            luma += l;
            if (data[i] || data[i + 1] || data[i + 2]) nonBlack++;
        }
    }
    if (n === 0) return null;
    return {
        opaque: +(opaque / n).toFixed(4),
        nonBlack: +(nonBlack / n).toFixed(4),
        luma: opaque ? +(luma / opaque).toFixed(1) : null,
    };
}

function hex(v: number | undefined): string | null {
    return v === undefined ? null : `0x${(v >>> 0).toString(16)}`;
}

export function registerGdiCommands(svc: HarnessService): void {
    /**
     * gdiDcs({ pixels? }) — every live DC and every retained window-client image.
     * `pixels:false` skips the coverage read (a getImageData per surface) when only the
     * topology is wanted.
     */
    svc.register("gdiDcs", (args) => {
        const opts = (args[0] ?? {}) as { pixels?: boolean };
        const wantPixels = opts.pixels !== false;
        const gdi = sys().gdiContext as unknown as {
            contexts: Map<number, OffscreenCanvasRenderingContext2D>;
            hdcStates: Map<number, Record<string, unknown>>;
            getOverlayCanvas(): OffscreenCanvas | null;
            listWindowClientBackings(): { hwnd: number; x: number; y: number; w: number; h: number }[];
            getWindowClientBackingCanvas(hwnd: number): OffscreenCanvas | null;
        };

        const dcs = [...gdi.hdcStates].map(([hdc, st]) => {
            const ctx = gdi.contexts.get(hdc);
            const canvas = ctx?.canvas;
            const blit = st["windowBlit"] as { absX: number; absY: number; width: number; height: number } | undefined;
            return {
                hdc: hex(hdc),
                hwnd: hex(st["hwnd"] as number | undefined),
                hBitmap: hex(st["hBitmap"] as number | undefined),
                width: canvas?.width ?? 0,
                height: canvas?.height ?? 0,
                windowBlit: blit ? { x: blit.absX, y: blit.absY, w: blit.width, h: blit.height } : null,
                paintDc: !!st["paintDc"],
                pristine: !!st["pristine"],
                dirty: !!st["dirty"],
                skipOverlayFlush: !!st["skipOverlayFlush"],
                linkedBitmapCanvas: !!(canvas as { __bitmapCanvas?: unknown } | undefined)?.__bitmapCanvas,
                coverage: wantPixels && canvas ? coverage(canvas) : null,
            };
        });

        const clientBackings = gdi.listWindowClientBackings().map((b) => {
            const canvas = gdi.getWindowClientBackingCanvas(b.hwnd);
            return {
                hwnd: hex(b.hwnd), x: b.x, y: b.y, w: b.w, h: b.h,
                coverage: wantPixels && canvas ? coverage(canvas) : null,
            };
        });

        // Every HBITMAP the guest has selected somewhere, with the pixels it resolved to.
        // "The art loaded but never reached the window" and "the art never loaded" are
        // different bugs and this is the line between them.
        const gdiObjects = (sys().gdiContext as unknown as { objects: Map<number, { type: string; data: unknown }> }).objects;
        const bitmaps = [...gdiObjects]
            .filter(([, o]) => o.type === "BITMAP")
            .map(([h, o]) => {
                const d = (o.data ?? {}) as { width?: number; height?: number; pixels?: unknown; bitsPtr?: number; loading?: boolean };
                const dcHandle = (gdi as unknown as { createBitmapDC(h: number): number | null }).createBitmapDC(h);
                const canvas = dcHandle !== null ? gdi.contexts.get(dcHandle)?.canvas : undefined;
                return {
                    hbitmap: hex(h), width: d.width ?? 0, height: d.height ?? 0,
                    hasPixels: !!d.pixels, bitsPtr: hex(d.bitsPtr), loading: !!d.loading,
                    coverage: wantPixels && canvas ? coverage(canvas) : null,
                };
            });

        const overlay = gdi.getOverlayCanvas();
        return {
            dcs, clientBackings, bitmaps,
            overlay: overlay
                ? { width: overlay.width, height: overlay.height, coverage: wantPixels ? coverage(overlay) : null }
                : null,
        };
    });

    /**
     * gdiDump(sel, save?) — one GDI surface as a PNG under logs/debug/.
     * sel: "dc:<hdc>" | "client:<hwnd>" | "bitmap:<hbitmap>" | "overlay".
     */
    svc.register("gdiDump", async (args) => {
        const sel = String(args[0] ?? "overlay");
        const gdi = sys().gdiContext as unknown as {
            contexts: Map<number, OffscreenCanvasRenderingContext2D>;
            getOverlayCanvas(): OffscreenCanvas | null;
            getWindowClientBackingCanvas(hwnd: number): OffscreenCanvas | null;
        };

        const [kind, idText] = sel.includes(":") ? sel.split(":", 2) : [sel, ""];
        const id = idText ? Number(idText.startsWith("0x") ? idText : Number(idText)) >>> 0 : 0;

        let canvas: OffscreenCanvas | null = null;
        if (kind === "dc") canvas = gdi.contexts.get(id)?.canvas ?? null;
        else if (kind === "client") canvas = gdi.getWindowClientBackingCanvas(id);
        else if (kind === "overlay") canvas = gdi.getOverlayCanvas();
        else if (kind === "bitmap") {
            const dcHandle = (gdi as unknown as { createBitmapDC(h: number): number | null }).createBitmapDC(id);
            canvas = dcHandle !== null ? gdi.contexts.get(dcHandle)?.canvas ?? null : null;
        } else throw new HarnessError(`gdiDump: unknown selector '${sel}' (dc:|client:|bitmap:|overlay)`, HarnessErrorCode.BAD_ARGS);

        if (!canvas) {
            throw new HarnessError(`gdiDump: no surface for '${sel}' — gdiDcs() lists what exists`, HarnessErrorCode.NOT_FOUND);
        }
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const name = String(args[1] ?? `gdi-${kind}${idText ? "-" + idText : ""}`).replace(/\.png$/i, "");
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64: bytesToBase64(bytes) });
        return {
            sel, width: canvas.width, height: canvas.height,
            bytes: bytes.length, saved: debugDumpPath(name), coverage: coverage(canvas),
        };
    });
}
