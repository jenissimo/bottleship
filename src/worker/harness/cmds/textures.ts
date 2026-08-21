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
import { getModule, guestMem, serializeSurfaces, sys } from "../serialize";
import { bytesToBase64, debugDumpPath } from "./screen";
import { devices as d3d9Devices } from "../../modules/d3d9/shared-state";
import { surfaceInfo as d3d8SurfaceInfo } from "../../modules/d3d8/shared-state";
import { cancelCapture as frameCaptureCancel, startCapture as frameCaptureStart } from "../../modules/ddraw/frame-capture";
import { armSurfaceOps, takeSurfaceOps } from "../../modules/ddraw/surface-op-log";
import { asArrayBufferView } from "../../../dom-buffer";
import { getSurfaceFormatLayout, getD3DTextureLayout, decodeD3DTextureToRgba8 } from "../../backends/webgpu/shared/texture-formats";

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
    /** hybridDebugOutput(mode): 0 normal, 1 texture0, 2 VS colour (magenta when absent), 3 white. */
    svc.register("hybridDebugOutput", (args) => {
        const mode = Number(args[0] ?? 0);
        const out: number[] = [];
        for (const dev of d3d9Devices.values()) out.push((dev as any).setHybridDebugOutput?.(mode) ?? -1);
        return out;
    });
    /** textures() — gallery across backends. */
    svc.register("textures", () => {
        const ddrawSurfaces = (serializeSurfaces() as any[]).map((s) => ({ ...s, backend: "ddraw" }));
        const d3d9: unknown[] = [];
        for (const [ptr, dev] of d3d9Devices) {
            const info = (dev as any).getTexturesDebugInfo?.() ?? [];
            for (const t of info) d3d9.push({ ...t, backend: "d3d9", device: ptr >>> 0 });
        }
        // D3D8 surfaces are the ones a CopyRects/Bink question is asked about, and they
        // were invisible here — a d3d8 title's gallery came back empty, which reads as
        // "no textures" rather than "this backend is not listed".
        const d3d8: unknown[] = [];
        for (const [ptr, info] of d3d8SurfaceInfo) {
            const s = info.surface;
            if (!s) continue;
            d3d8.push({
                backend: "d3d8",
                ptr: ptr >>> 0,
                ptrHex: "0x" + (ptr >>> 0).toString(16),
                width: s.width, height: s.height,
                pitch: s.pitch,
                bpp: s.format?.bpp,
                d3dFormat: info.d3dFormat,
                role: info.role ?? null,
                surfacePtr: "0x" + ((s.surfacePtr ?? 0) >>> 0).toString(16),
            });
        }
        return { ddraw: ddrawSurfaces, d3d9, d3d8 };
    });

    /** surfaceOps({arm}) — arm the DDraw composition-op ring for the next `arm` ops;
     *  call again with no argument to take what was recorded.
     *
     *  Each row is one Blt/BltFast/Flip/ColorFill: the rectangle, the source, the PATH
     *  it actually took (`gpu*` / `cpu*` / `skip:lease`) and the destination's authority
     *  afterwards. That is the only view that answers "the art is positioned correctly
     *  but half of it is black" — the missing rects are the ones whose op never ran, or
     *  ran into the representation the next Flip did not read. */
    svc.register("surfaceOps", (args) => {
        const opts = (args[0] ?? {}) as { arm?: number };
        if (typeof opts.arm === "number") return armSurfaceOps(opts.arm);
        const ops = takeSurfaceOps();
        const byPath: Record<string, number> = {};
        for (const o of ops) byPath[`${o.op}:${o.path}`] = (byPath[`${o.op}:${o.path}`] ?? 0) + 1;
        return { count: ops.length, byPath, ops };
    });

    /** dumpSurface(sel, {save?, from?}) — DDraw surface -> PNG.
     *  `from` picks the representation: "scratch" (guest CPU pixels), "gpu" (the texture
     *  the blit/present paths actually sample), or "auto" (scratch when present). Dumping
     *  both is how you tell "the guest never filled this" from "the guest filled it but we
     *  sample a blank texture" — the second blits a black rectangle at the right place. */
    /** A D3D9 TextureStore handle, decoded to RGBA — the store DDraw's readSurfaceRGBA
     *  cannot see. Tried whenever the selector is not a DDraw surface, so one verb serves
     *  both backends and a d3d9-only title is no longer a dead end. */
    const dumpD3d9 = async (
        ptr: number,
        from?: "auto" | "gpu" | "scratch",
    ): Promise<{ rgba: Uint8Array; w: number; h: number; format: number } | { err: string } | null> => {
        let reason: { err: string } | null = null;
        for (const dev of d3d9Devices.values()) {
            // "the store has the pixels, does the GPU copy?" is the whole question when a draw
            // with correct geometry and a populated texture renders nothing — a missed upload
            // is invisible from the store side, which is the side every other verb reads.
            if (from === "gpu") {
                const g = await (dev as any).readRenderTargetRgba?.(ptr);
                if (g && !("err" in g)) return g;
                reason = g ?? reason;
                continue;
            }
            const r = (dev as any).readTextureRgba?.(ptr);
            if (!r) continue;
            if (!("err" in r)) return r;
            // A render target has no guest copy by construction — go to the GPU for it rather
            // than reporting the absence of something that is right there.
            const rt = await (dev as any).readRenderTargetRgba?.(ptr);
            if (rt && !("err" in rt)) return rt;
            // Keep WHY it refused. Collapsing the reason into null made every such texture
            // report "no d3d9 texture with that handle" — a diagnostic that sends the reader
            // looking for a resource the gallery is already listing.
            reason = rt ?? r;
        }
        return reason;
    };

    /** A D3D8 texture, by either the COM ptr the gallery lists or its pixel surfacePtr.
     *  Decoded FROM GUEST MEMORY with the surface's palette — the same call the upload
     *  path makes — NOT from rgbaScratch: that buffer is a cache the palette-bake step
     *  fills lazily, so a texture the screen clearly shows can read back as flat black.
     *  Without this a d3d8-only title could see its textures listed but never dump one. */
    const dumpD3d8 = (ptr: number): { rgba: Uint8Array; w: number; h: number; d3dFormat: number } | null => {
        for (const [comPtr, info] of d3d8SurfaceInfo) {
            const s = info.surface as any;
            if (!s) continue;
            if ((comPtr >>> 0) !== ptr && ((s.surfacePtr ?? 0) >>> 0) !== ptr) continue;
            const w = s.width | 0, h = s.height | 0;
            const src = s.surfacePtr >>> 0;
            if (!src || w <= 0 || h <= 0) return null;
            const mem = guestMem();
            if (!mem) return null;
            const layout = getD3DTextureLayout(info.d3dFormat, w, h);
            const pitch = s.pitch || layout.pitch;
            if (src + pitch * h > mem.length) return null;
            const rgba = decodeD3DTextureToRgba8(mem, src, w, h, info.d3dFormat, {
                pitch,
                surfaceFormat: s.format,
                palette: s.palette,
            });
            return { rgba, w, h, d3dFormat: info.d3dFormat };
        }
        return null;
    };

    const dump = async (args: unknown[]) => {
        const ptr = resolvePtr(args[0]);
        if (!ptr) throw new HarnessError("surface pointer is 0 (no such surface / not initialized)", HarnessErrorCode.NOT_FOUND);
        const opts = (args[1] ?? {}) as { save?: string; from?: "auto" | "gpu" | "scratch" };
        const emit = async (rgba: Uint8Array, w: number, h: number, source: string) => {
            const name = (opts.save ?? `surf_${ptr.toString(16)}_${w}x${h}`).replace(/\.png$/i, "");
            const base64 = await encodePngBase64(rgba, w, h);
            (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
            return { saved: debugDumpPath(name), ptr: "0x" + ptr.toString(16), w, h, source };
        };

        const d9Source = opts.from === "gpu" ? "d3d9-gpu" : "d3d9-store";
        const d8 = dumpD3d8(ptr);
        if (d8) return emit(d8.rgba, d8.w, d8.h, `d3d8-texture(fmt ${d8.d3dFormat})`);

        const dd = ddraw();
        // readSurfaceRGBA takes "gpu" itself and is the only route to a DDraw surface's GPU
        // copy — excluding it here fell through to the d3d9 path and reported "not found"
        // for the exact store-vs-GPU question this option exists to answer.
        if (dd?.readSurfaceRGBA) {
            const r = await dd.readSurfaceRGBA(ptr, opts.from ?? "auto");
            if (!("err" in r)) return emit(r.rgba, r.w, r.h, r.source);
            const d9 = await dumpD3d9(ptr, opts.from);
            if (!d9) throw new HarnessError(`readSurfaceRGBA: ${r.err} (and no d3d9 texture with that handle)`, HarnessErrorCode.INTERNAL);
            if ("err" in d9) throw new HarnessError(`d3d9 texture 0x${ptr.toString(16)}: ${d9.err}`, HarnessErrorCode.UNSUPPORTED);
            return emit(d9.rgba, d9.w, d9.h, `${d9Source}(fmt ${d9.format})`);
        }
        const d9 = await dumpD3d9(ptr, opts.from);
        if (!d9) throw new HarnessError("no DDraw surface and no D3D9 texture with that handle", HarnessErrorCode.NOT_FOUND);
        if ("err" in d9) throw new HarnessError(`d3d9 texture 0x${ptr.toString(16)}: ${d9.err}`, HarnessErrorCode.UNSUPPORTED);
        return emit(d9.rgba, d9.w, d9.h, `${d9Source}(fmt ${d9.format})`);
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

    /** surfaceRows(sel) — per-row mean luminance of a surface's GUEST pixels, plus the
     *  even-vs-odd row split.
     *
     *  "Every other scanline is darker" is the one artefact class a screenshot cannot
     *  settle: at any zoom it is indistinguishable from a dithered gradient, a video
     *  field order, or the viewer's own scaling. This measures it. `combRatio` near 1
     *  means the rows agree; a real comb sits far from 1 and `combRuns` confirms the
     *  alternation is strict rather than a few dark bands. `pitchPixelsExact` is checked
     *  alongside because an odd byte pitch byte-shifts every other row on its own, which
     *  produces a comb with no bug anywhere in the blitter. */
    svc.register("surfaceRows", (args) => {
        const ptr = resolvePtr(args[0] ?? "primary");
        if (!ptr) throw new HarnessError("surface pointer is 0", HarnessErrorCode.NOT_FOUND);
        const surf = (serializeSurfaces() as any[]).find((s) => (s.ptr >>> 0) === ptr);
        if (!surf) throw new HarnessError(`no surface at 0x${ptr.toString(16)}`, HarnessErrorCode.NOT_FOUND);
        const memory = guestMem();
        if (!memory) throw new HarnessError("guest memory unavailable (no process loaded?)", HarnessErrorCode.NO_PROCESS);
        const { width, height, pitch, bpp } = surf;
        const bytesPer = Math.max(1, bpp >> 3);
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        // Channel split by bpp; 8bpp is paletted, so the raw index is the only honest number.
        const lum = (v: number): number => {
            if (bytesPer === 4) return (((v >>> 16) & 0xFF) * 299 + ((v >>> 8) & 0xFF) * 587 + (v & 0xFF) * 114) / 1000;
            if (bytesPer === 2) {
                const r = ((v >>> 11) & 0x1F) * 255 / 31, g = ((v >>> 5) & 0x3F) * 255 / 63, b = (v & 0x1F) * 255 / 31;
                return (r * 299 + g * 587 + b * 114) / 1000;
            }
            return v & 0xFF;
        };
        const rows: number[] = [];
        for (let y = 0; y < height; y++) {
            let off = ptr + y * pitch;
            if (off < 0 || off + width * bytesPer > memory.length) break;
            let sum = 0;
            for (let x = 0; x < width; x++, off += bytesPer) {
                sum += lum(bytesPer === 4 ? view.getUint32(off, true)
                    : bytesPer === 3 ? (memory[off] | (memory[off + 1] << 8) | (memory[off + 2] << 16))
                    : bytesPer === 2 ? view.getUint16(off, true)
                    : memory[off]);
            }
            rows.push(sum / width);
        }
        const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
        const even = mean(rows.filter((_, i) => i % 2 === 0));
        const odd = mean(rows.filter((_, i) => i % 2 === 1));
        // How much of the surface actually alternates, so a few dark bands cannot pass as a comb.
        let combRuns = 0;
        for (let i = 2; i < rows.length; i++) {
            const a = rows[i - 2]! - rows[i - 1]!, b = rows[i - 1]! - rows[i]!;
            if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) combRuns++;
        }
        // A field that is ENTIRELY zero is the strongest possible comb, and it is exactly
        // the case a plain even/odd ratio cannot express — report it as its own verdict
        // rather than letting a division by zero read as "no comb".
        const zeroRows = (parity: number) =>
            rows.filter((r, i) => i % 2 === parity && r === 0).length;
        const evenCount = Math.ceil(rows.length / 2), oddCount = Math.floor(rows.length / 2);
        const oddAllZero = oddCount > 0 && zeroRows(1) === oddCount && even > 0;
        const evenAllZero = evenCount > 0 && zeroRows(0) === evenCount && odd > 0;
        return {
            ptr: "0x" + ptr.toString(16), w: width, h: height, bpp, pitch,
            pitchPixelsExact: pitch % bytesPer === 0,
            evenMean: +even.toFixed(2), oddMean: +odd.toFixed(2),
            combRatio: odd === 0 ? null : +(even / odd).toFixed(4),
            /** One whole field is blank — half the picture was never written at all. */
            fieldBlank: oddAllZero ? "odd" : evenAllZero ? "even" : null,
            evenZeroRows: zeroRows(0), oddZeroRows: zeroRows(1), evenRows: evenCount, oddRows: oddCount,
            combRuns, alternatingPct: rows.length > 2 ? +((combRuns / (rows.length - 2)) * 100).toFixed(1) : 0,
            rows: rows.map((r) => +r.toFixed(1)),
        };
    });

    /** surfaceScan({caps?, onlyEmpty?}) — one line per DDraw surface saying whether its
     *  GUEST PIXEL MEMORY holds anything, next to the state that should reflect it
     *  (version / gpuDirty / everLocked). Answers "the game created and bound N textures
     *  — which of them ever received CPU-side pixels?" in one call instead of N
     *  dumpSurface round trips.
     *
     *  `empty` is about the CPU copy ONLY. A GPU-authored surface (a render target, or
     *  one the guest painted through GetDC/StretchDIBits) legitimately reads empty while
     *  showing a full picture — cross-check those with dumpSurface, which reads the GPU
     *  texture. The pair is the useful signal: empty on both = never filled; empty here
     *  but not on the GPU = GPU-authored; filled here with gpuDirty = filled but not yet
     *  uploaded. */
    svc.register("surfaceScan", (args) => {
        const opts = (args[0] ?? {}) as { caps?: number; onlyEmpty?: boolean };
        const memory = guestMem();
        if (!memory) throw new HarnessError("guest memory unavailable (no process loaded?)", HarnessErrorCode.NO_PROCESS);
        const rows: unknown[] = [];
        let empty = 0;
        for (const s of serializeSurfaces() as any[]) {
            if (opts.caps !== undefined && (s.caps & opts.caps) !== opts.caps) continue;
            const ptr = s.ptr >>> 0;
            const bytesPer = Math.max(1, s.bpp >> 3);
            // Sample every 4th row; a texture the guest filled is non-zero long before the end.
            let nonZero = 0;
            let sampled = 0;
            for (let y = 0; y < s.height && nonZero === 0; y += 4) {
                let off = ptr + y * s.pitch;
                if (off < 0 || off + s.width * bytesPer > memory.length) break;
                for (let x = 0; x < s.width; x++, off += bytesPer) {
                    sampled++;
                    for (let b = 0; b < bytesPer; b++) if (memory[off + b] !== 0) { nonZero++; break; }
                    if (nonZero) break;
                }
            }
            const isEmpty = sampled > 0 && nonZero === 0;
            if (isEmpty) empty++;
            if (opts.onlyEmpty && !isEmpty) continue;
            rows.push({
                ptr: "0x" + ptr.toString(16), size: `${s.width}x${s.height}`, bpp: s.bpp,
                caps: "0x" + (s.caps >>> 0).toString(16), mode: s.mode,
                empty: isEmpty, version: s.version, uploaded: s.lastUploadVersion,
                gpuDirty: s.gpuDirty, everLocked: s.everLocked, srcColorKey: s.srcColorKey,
            });
        }
        return { total: rows.length, empty, surfaces: rows };
    });

    /** surfaceFormats({caps?}) — the DDPIXELFORMAT every surface hands back through
     *  Lock/GetSurfaceDesc/GetPixelFormat, as the 8 raw little-endian DWORDs the guest
     *  memcmps. Era D3D wrappers classify a surface by an EXACT 32-byte compare against
     *  their own format table, so one fabricated field (an invented RGB mask on a
     *  paletted format, a stale dwFlags, a non-zero dwFourCC) silently demotes the
     *  surface to "unsupported" and the game skips the texel upload — a bug that looks
     *  like "textures bind but stay black". Compare `bytes` against the game's table. */
    svc.register("surfaceFormats", (args) => {
        const opts = (args[0] ?? {}) as { caps?: number };
        const provider: any = sys().resourceProvider as any;
        const objs: any[] = provider?.getAllComObjects?.() ?? [];
        const rows: unknown[] = [];
        for (const o of objs) {
            const st = o?.getState?.();
            if (!st?.format || typeof st.surfacePtr !== "number") continue;
            if (opts.caps !== undefined && ((st.caps >>> 0) & opts.caps) !== opts.caps) continue;
            const f = st.format;
            const dw = [32, f.flags >>> 0, (f.fourCC ?? 0) >>> 0, f.bpp >>> 0,
                        f.rMask >>> 0, f.gMask >>> 0, f.bMask >>> 0, f.aMask >>> 0];
            // fourCC as its tag, and the pitch the layout REQUIRES beside the one the
            // surface reports. A DDPF_FOURCC surface carries no masks, so readPixelFormat
            // fills in the RGB565 defaults and a compressed surface reads as an ordinary
            // 16-bit one in every other view — this row is where that is visible.
            const cc = (f.fourCC ?? 0) >>> 0;
            const layout = getSurfaceFormatLayout(f, st.width, st.height);
            rows.push({
                ptr: "0x" + (st.surfacePtr >>> 0).toString(16),
                size: `${st.width}x${st.height}`,
                caps: "0x" + ((st.caps >>> 0)).toString(16),
                fourCC: cc
                    ? String.fromCharCode(cc & 255, (cc >> 8) & 255, (cc >> 16) & 255, (cc >>> 24) & 255)
                    : null,
                compressed: layout.compressed,
                pitch: st.pitch,
                layoutPitch: layout.pitch,
                dwords: dw.map((v) => "0x" + v.toString(16)),
                bytes: dw.map((v) => v.toString(16).padStart(8, "0")
                    .match(/../g)!.reverse().join("")).join(""),
            });
        }
        return { total: rows.length, surfaces: rows };
    });

    /** surfacePixels(sel) — the existing luminance/grid stats (no PNG). */
    svc.register("surfacePixels", async (args) => {
        const ptr = resolvePtr(args[0] ?? "primary");
        const dd = ddraw();
        if (!dd?.dbgReadSurfacePixels) throw new HarnessError("ddraw module not loaded", HarnessErrorCode.UNSUPPORTED);
        return dd.dbgReadSurfacePixels(ptr);
    });

    /** captureFrame(opts) — arm the per-draw CaptureBus for the next complete frame. Backend-
     *  agnostic now: DDraw/D3D7 (full FFP), D3D8 (full FFP via the shared executor),
     *  D3D9 (backend-tagged minimal draws). The in-progress frame is discarded at its
     *  present boundary, then the following frame is recorded through onFrameEnd(). */
    svc.register("captureFrame", async (args, ctx: HarnessCtx) => {
        const opts = (args[0] ?? {}) as { timeoutMs?: number; backend?: string; dumpTargets?: boolean };
        const timeoutMs = opts.timeoutMs ?? 5000;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let abortReason: Error | undefined;
        const aborted = new Promise<never>((_res, reject) => {
            timeout = setTimeout(() => reject(new HarnessError(`no frame presented within ${timeoutMs}ms`, HarnessErrorCode.TIMEOUT)), timeoutMs);
            ctx.signal.addEventListener("abort", () => {
                if (timeout) clearTimeout(timeout);
                abortReason = ctx.signal.reason instanceof Error
                    ? ctx.signal.reason
                    : new HarnessError("aborted", HarnessErrorCode.CANCELLED);
                reject(abortReason);
            }, { once: true });
        });
        let frame: { drawCalls: Array<{ rtSurfacePtr: number; rtWidth: number; rtHeight: number; rtFormat?: string | null }> };
        try {
            frame = await Promise.race([frameCaptureStart(opts.backend), aborted]);
        } catch (e) {
            frameCaptureCancel(e instanceof Error ? e : abortReason ?? new Error(String(e)));
            throw e;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
        if (!opts.dumpTargets) return frame;
        // The distinct attachments the frame drew into, in first-use order. A frame split
        // across render targets (render-to-texture, an inset view) is otherwise only visible
        // by diffing rtSurfacePtr across every draw by hand.
        const targets = new Map<number, { rtSurfacePtr: string; width: number; height: number; format: string | null; draws: number }>();
        for (const d of frame.drawCalls) {
            const key = d.rtSurfacePtr >>> 0;
            const row = targets.get(key);
            if (row) { row.draws++; continue; }
            targets.set(key, {
                rtSurfacePtr: "0x" + key.toString(16),
                width: d.rtWidth, height: d.rtHeight,
                format: d.rtFormat ?? null, draws: 1,
            });
        }
        return { ...frame, targets: [...targets.values()] };
    });

    /** gpuToggle(name, enabled, value?) — flip one of the render backends' DebugFlags.
     *
     *  These are the A/B knobs for "the draws are issued but nothing is visible": each
     *  one removes exactly one stage from the pipeline, so the first toggle that makes
     *  the image appear NAMES the stage. `forceDisableAlphaTest` / `forceDisableAlphaBlend`
     *  (is the texel being discarded?), `forceDisableZTest` (depth?), `forceTextureResync`
     *  (is the GPU copy of the texture stale?), `forceMissingTextureMagenta` (is a texture
     *  bound at all?), `textureConverterDebugMode` (1 = paint every converted texture a
     *  flat colour by source bit-depth, so a black texture becomes visibly green/blue).
     *  Reading the same answer out of the log firehose is not possible — the flags change
     *  the picture, and the picture is the measurement.
     *
     *  The D3D9 backend carries the four stage-removal levers (`forceCullNone`,
     *  `forceDisableZTest`, `forceDisableAlphaTest`, `forceDisableAlphaBlend`); DDraw/D3D7/D3D8
     *  carry the fuller set above. A name no live backend owns is an ERROR, never a no-op.
     *
     *  Call with no name to read the current flags, keyed by backend. Toggles are sticky;
     *  clear them when done or every later observation inherits them. */
    svc.register("gpuToggle", (args) => {
        const name = args[0] as string | undefined;
        // Every live render backend, not just DDraw: a D3D9-only title used to get UNSUPPORTED
        // here and the A/B had to be done with live patches through evalWorker.
        const targets: Array<{ backend: string; obj: any }> = [];
        const ddrawExec = ddraw()?.context?.executor;
        if (ddrawExec) targets.push({ backend: "ddraw", obj: ddrawExec });
        for (const [ptr, dev] of d3d9Devices) {
            if ((dev as any).setDebugToggle) targets.push({ backend: `d3d9:0x${(ptr >>> 0).toString(16)}`, obj: dev });
        }
        if (!targets.length) {
            throw new HarnessError("no render backend with debug toggles (no DDraw/D3D7 executor, no D3D9 device)", HarnessErrorCode.UNSUPPORTED);
        }

        const flagsOf = (t: { backend: string; obj: any }) => t.obj.getDebugFlags?.() ?? null;
        if (name === undefined) {
            return Object.fromEntries(targets.map((t) => [t.backend, flagsOf(t)]));
        }

        const enabled = args[1] === undefined ? true : !!args[1];
        const value = args[2] as number | undefined;
        // A toggle nobody owns must be an ERROR: a silently ignored name is an A/B that
        // measures nothing while reading as "this stage is not the cause".
        const applied: string[] = [];
        for (const t of targets) {
            const flags = flagsOf(t);
            if (!flags || !(name in flags)) continue;
            t.obj.setDebugToggle(name, enabled, value);
            applied.push(t.backend);
        }
        if (!applied.length) {
            const known = [...new Set(targets.flatMap((t) => Object.keys(flagsOf(t) ?? {})))].sort();
            throw new HarnessError(
                `no live backend has a debug toggle named '${name}'. Available: ${known.join(", ")}`,
                HarnessErrorCode.BAD_ARGS,
            );
        }
        return {
            toggle: name, enabled, value: value ?? null, applied,
            flags: Object.fromEntries(targets.map((t) => [t.backend, flagsOf(t)])),
        };
    });

    /** drawScrub(min?, max?) — RenderDoc-style bisect for the D3D9 backend: render only
     *  draws [min, max] of every frame, numbered exactly as `captureFrame`'s `index`.
     *
     *  A capture says what was SUBMITTED; it cannot say what each draw did to the target.
     *  Cutting the frame at a draw and looking at the screen is what separates "this
     *  geometry never rasterized" from "a later draw painted over it" — the two produce
     *  the identical black patch. Call with no argument to read the current cut plus
     *  `lastFrameDraws`, so a scrub that is silently doing nothing is visible as such.
     *  drawScrub(0, -1) (or no-arg after setting) leaves it inert; drawScrub(N, N) shows
     *  ONE draw's contribution over whatever the previous frame left behind. */
    svc.register("drawScrub", (args) => {
        const dev: any = sys().services?.render?.getActive?.();
        if (!dev?.setDrawScrub) throw new HarnessError("active presenter has no draw scrub (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        if (args.length > 0) {
            const min = Number(args[0] ?? 0) | 0;
            const max = args[1] === undefined ? -1 : Number(args[1]) | 0;
            dev.setDrawScrub(min, max);
        }
        return dev.getDrawScrub();
    });

    /** ffpShader({wgsl?}) — the fixed-function WGSL the CURRENT D3D9 state generates, plus
     *  which layout owner won (`path`: "declaration" or "fvf") and the components it kept.
     *
     *  `captureFrame` reports the states a draw asked for; this reports what the shader built
     *  from them actually reads. A vertex component the layout dropped — a declaration with no
     *  COLOR, an FVF component past the bound stride — renders identically to a correct
     *  white-diffuse draw, so nothing short of the emitted source distinguishes them. Pair it
     *  with `drawScrub(N, N)`: cut to the draw, then read the shader that drew it.
     *  The WGSL is large; omit `wgsl:true` for just the layout decision. */
    svc.register("ffpShader", (args) => {
        const opts = (args[0] ?? {}) as { wgsl?: boolean };
        const dev: any = sys().services?.render?.getActive?.();
        if (!dev?.describeFfpShader) {
            throw new HarnessError("active presenter has no FFP shader dump (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        }
        const out = dev.describeFfpShader() as Record<string, unknown>;
        if (opts.wgsl === false || opts.wgsl === undefined) {
            const { wgsl, ...rest } = out;
            return { ...rest, wgslBytes: typeof wgsl === "string" ? wgsl.length : 0 };
        }
        return out;
    });
}
