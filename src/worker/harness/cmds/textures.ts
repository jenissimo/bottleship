/**
 * Texture / VRAM reading + frame capture.
 *
 * - textures(): a backend-agnostic gallery — DDraw/D3D7/D3D8 surfaces + D3D9
 *   TextureStore slots.
 * - dumpSurface(sel)/dumpTexture(sel): full-RGBA readback -> PNG (logs/debug/),
 *   preferring the authoritative rgbaScratch (zero GPU) for bitmap textures.
 * - expectSurfaceNonBlack(sel): cheap liveness assertion over a subsampled
 *   readback (reuses the existing dbgReadSurfacePixels nonBlackPct).
 * - captureFrame(): the RenderDoc-style per-draw capture. Works for the FFP
 *   backends (DDraw/D3D7, and D3D8 which loads the ddraw module's executor) via
 *   the existing frame-capture. D3D9 per-draw producers remain unimplemented.
 */

import type { HarnessService, HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { getModule, guestMem, serializeSurfaces } from "../serialize";
import { bytesToBase64 } from "./screen";
import { devices as d3d9Devices } from "../../modules/d3d9/shared-state";
import { startCapture as frameCaptureStart } from "../../modules/ddraw/frame-capture";
import { asArrayBufferView } from "../../../dom-buffer";

function ddraw(): any {
    return getModule("ddraw");
}

/** Resolve a surface selector to a pixel pointer (hex/number, or "primary"/"backbuffer").
 *  context.surfaces entries may hold either a pixel ptr or a COM object address —
 *  translate the latter to the object's surfacePtr. */
function resolvePtr(sel: unknown): number {
    const dd = ddraw();
    const fromCtx = (v: unknown): number => {
        const n = ((v as number) ?? 0) >>> 0;
        if (!n) return 0;
        const sp = dd?.context?.resourceProvider?.getComObjectByAddress?.(n)?.getState?.()?.surfacePtr;
        return ((sp ?? n) as number) >>> 0;
    };
    if (sel === "primary") return fromCtx(dd?.context?.surfaces?.primary);
    if (sel === "backbuffer" || sel === "backBuffer") return fromCtx(dd?.context?.surfaces?.backBuffer);
    if (typeof sel === "number") return sel >>> 0;
    if (typeof sel === "string") return (sel.startsWith("0x") ? parseInt(sel.slice(2), 16) : parseInt(sel, 16)) >>> 0;
    throw new HarnessError(`bad surface selector ${JSON.stringify(sel)}`, HarnessErrorCode.BAD_ARGS);
}

export async function encodePngBase64(rgba: Uint8Array, w: number, h: number): Promise<string> {
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d");
    if (!ctx) throw new HarnessError("OffscreenCanvas 2d unavailable", HarnessErrorCode.UNSUPPORTED);
    ctx.putImageData(new ImageData(asArrayBufferView(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4)), w, h), 0, 0);
    const blob = await cv.convertToBlob({ type: "image/png" });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function registerTextureCommands(svc: HarnessService): void {
    /** textures() — gallery across backends. */
    svc.register("textures", () => {
        const ddrawSurfaces = (serializeSurfaces() as any[]).map((s) => ({ ...s, backend: "ddraw" }));
        const d3d9: unknown[] = [];
        for (const [ptr, dev] of d3d9Devices) {
            const info = (dev as any).getTexturesDebugInfo?.() ?? [];
            for (const t of info) d3d9.push({ ...t, backend: "d3d9", device: ptr >>> 0 });
        }
        return { ddraw: ddrawSurfaces, d3d9 };
    });

    /** dumpSurface(sel, {save?}) — DDraw surface -> PNG. */
    const dump = async (args: unknown[]) => {
        const ptr = resolvePtr(args[0]);
        if (!ptr) throw new HarnessError("surface pointer is 0 (no such surface / not initialized)", HarnessErrorCode.NOT_FOUND);
        const dd = ddraw();
        if (!dd?.readSurfaceRGBA) throw new HarnessError("ddraw module not loaded (D3D9-only games not yet supported for surface dump)", HarnessErrorCode.UNSUPPORTED);
        const r = await dd.readSurfaceRGBA(ptr);
        if ("err" in r) throw new HarnessError(`readSurfaceRGBA: ${r.err}`, HarnessErrorCode.INTERNAL);
        const opts = (args[1] ?? {}) as { save?: string };
        const name = (opts.save ?? `surf_${ptr.toString(16)}_${r.w}x${r.h}`).replace(/\.png$/i, "");
        const base64 = await encodePngBase64(r.rgba, r.w, r.h);
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
        return { saved: `logs/debug/${name}.png`, ptr: "0x" + ptr.toString(16), w: r.w, h: r.h, source: r.source };
    };
    svc.register("dumpSurface", dump);
    svc.register("dumpTexture", dump);

    /** expectSurfaceNonBlack(sel?, minPct?) — assertion (throws if black). */
    svc.register("expectSurfaceNonBlack", async (args) => {
        const sel = args[0] ?? "primary";
        const minPct = typeof args[1] === "number" ? (args[1] as number) : 1;
        const ptr = resolvePtr(sel);
        const dd = ddraw();
        if (!dd?.dbgReadSurfacePixels) throw new HarnessError("ddraw module not loaded", HarnessErrorCode.UNSUPPORTED);
        const r = await dd.dbgReadSurfacePixels(ptr);
        if (r?.err) throw new HarnessError(`readback failed: ${r.err}`, HarnessErrorCode.INTERNAL);
        if (!(r.nonBlackPct >= minPct)) {
            throw new HarnessError(`surface ${typeof sel === "string" ? sel : "0x" + ptr.toString(16)} is black: nonBlackPct=${r.nonBlackPct}% < ${minPct}% (avg=${r.avg})`, HarnessErrorCode.NOT_FOUND);
        }
        return { ok: true, ptr: "0x" + ptr.toString(16), nonBlackPct: r.nonBlackPct, avg: r.avg, w: r.w, h: r.h };
    });

    /** surfaceRawHist(sel, {top?}) — histogram of RAW pixel values in guest memory
     *  (u16/u32 by bpp, pitch-aware). Shows what is actually stored, independent of the
     *  surface's DECLARED format — catches format-vs-content mismatches (e.g. an
     *  ARGB4444-patterned atlas sitting in a surface labelled RGB565) that any
     *  RGBA-converted dump hides. */
    svc.register("surfaceRawHist", (args) => {
        const ptr = resolvePtr(args[0]);
        if (!ptr) throw new HarnessError("surface pointer is 0", HarnessErrorCode.NOT_FOUND);
        const opts = (args[1] ?? {}) as { top?: number };
        const surf = (serializeSurfaces() as any[]).find((s) => (s.ptr >>> 0) === ptr);
        if (!surf) throw new HarnessError(`no surface at 0x${ptr.toString(16)}`, HarnessErrorCode.NOT_FOUND);
        const memory = guestMem();
        if (!memory) throw new HarnessError("guest memory unavailable (no process loaded?)", HarnessErrorCode.NO_PROCESS);
        const { width, height, pitch, bpp } = surf;
        const bytesPer = Math.max(1, bpp >> 3);
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const hist = new Map<number, number>();
        for (let y = 0; y < height; y++) {
            let off = ptr + y * pitch;
            if (off < 0 || off + width * bytesPer > memory.length) break;
            for (let x = 0; x < width; x++, off += bytesPer) {
                const v = bytesPer === 4 ? view.getUint32(off, true)
                    : bytesPer === 3 ? (memory[off] | (memory[off + 1] << 8) | (memory[off + 2] << 16))
                    : bytesPer === 2 ? view.getUint16(off, true)
                    : memory[off];
                hist.set(v, (hist.get(v) ?? 0) + 1);
                if (hist.size > 65536) throw new HarnessError("too many distinct values (not a paletted/UI surface?) — use dumpSurface", HarnessErrorCode.UNSUPPORTED);
            }
        }
        const topN = opts.top ?? 16;
        const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, topN)
            .map(([v, n]) => ({ value: "0x" + (v >>> 0).toString(16).padStart(bytesPer * 2, "0"), count: n }));
        return { ptr: "0x" + ptr.toString(16), w: width, h: height, bpp, distinct: hist.size, top };
    });

    /** surfacePixels(sel) — the existing luminance/grid stats (no PNG). */
    svc.register("surfacePixels", async (args) => {
        const ptr = resolvePtr(args[0] ?? "primary");
        const dd = ddraw();
        if (!dd?.dbgReadSurfacePixels) throw new HarnessError("ddraw module not loaded", HarnessErrorCode.UNSUPPORTED);
        return dd.dbgReadSurfacePixels(ptr);
    });

    /** captureFrame(opts) — arm the per-draw CaptureBus for the next frame. Backend-
     *  agnostic now: DDraw/D3D7 (full FFP), D3D8 (full FFP via the shared executor),
     *  D3D9 (backend-tagged minimal draws). Resolves at the next present (onFrameEnd). */
    svc.register("captureFrame", async (args, ctx: HarnessCtx) => {
        const opts = (args[0] ?? {}) as { timeoutMs?: number };
        const timeoutMs = opts.timeoutMs ?? 5000;
        const frame = await Promise.race([
            frameCaptureStart(),
            new Promise((_res, rej) => {
                const t = setTimeout(() => rej(new HarnessError(`no frame presented within ${timeoutMs}ms`, HarnessErrorCode.TIMEOUT)), timeoutMs);
                ctx.signal.addEventListener("abort", () => { clearTimeout(t); rej(ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED)); }, { once: true });
            }),
        ]);
        return frame;
    });
}
