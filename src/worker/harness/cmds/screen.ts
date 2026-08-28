/**
 * shot() — capture the SCREEN as a PNG, returned as base64 through the RPC contract
 * (POJO-friendly). With opts.save it also routes the PNG to the log server via the
 * existing debug_png_dump channel (logs/debug/).
 *
 * The capture reads the canvas itself (RenderService.captureScreen), NOT the active
 * presenter's source texture: the video plane, GDI dialog rects and the stats overlay
 * are composited onto the canvas after the presenter records what it drew from, so a
 * presenter capture shows the game WITHOUT the overlay — blind to precisely the
 * compositing bugs a screenshot is asked to settle. Every result is labelled with the
 * source it came from, and a capture that cannot see the composite says so instead of
 * returning a plausible wrong PNG.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { sessionLogPath } from "../../../harness/session";
import { getOverlayCompositePlan, isGameScreenOwned, isFlipScreenOwned, getLiveDialogOverlays } from "../../modules/user32/dialog-overlay";
import { ddrawShowsContent } from "../../modules/ddraw/gdi-visibility";

/** Where a `debug_png_dump` we post actually lands: the host writes it under its own
 *  session directory, so a `saved` path that ignored the session would point an agent
 *  at another tab's file. `__bsSession` is seeded by the host at worker init. */
export function debugDumpPath(name: string): string {
    return sessionLogPath(`debug/${name}.png`, ((globalThis as any).__bsSession as string) ?? "");
}

/** Base64-encode bytes (chunked to avoid String.fromCharCode arg overflow). */
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** PNG dimensions straight out of the IHDR — so a capture always states the size it
 *  actually has (guest surface vs. canvas is the tell that a wrong source was used). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** What a `layer` capture is blind to — it is NOT the screen. */
const LAYER_BLIND_SPOT =
    "presenter layer: the frame source BEFORE the video plane / live GDI dialog rects / stats overlay " +
    "are composited onto the canvas — it cannot show a compositing bug. The screen is source:'screen'.";

export function registerScreenCommands(svc: HarnessService): void {
    /**
     * shot({ save?, source? }) — PNG of the screen.
     *  - "screen" (default): the canvas, every overlay composited — what the user sees.
     *  - "layer": the active presenter's own frame source (pre-composite game layer),
     *    for splitting "which layer holds the pixels" from "does the composite show it".
     *    Always labelled `composited:false`; never a substitute for the screen.
     * Result carries `source`/`composited`/`width`/`height` (+ `warning` whenever the
     * image is not the composite), so a caller cannot mistake one for the other.
     */
    svc.register("shot", async (args) => {
        const opts = (args[0] ?? {}) as { save?: string; source?: "screen" | "layer" };
        const want = opts.source ?? "screen";
        const render: any = sys().services?.render;
        const active: any = render?.getActive?.();

        let blob: Blob | null = null;
        let source: "screen" | "layer" = "screen";
        let warning: string | null = null;

        if (want === "layer") {
            if (!active?.capturePresentedLayer) {
                throw new HarnessError(
                    `active presenter (${active?.constructor?.name ?? "none"}) has no separate frame source to capture` +
                    " — it renders straight to the canvas. Use the default source:'screen'.",
                    HarnessErrorCode.UNSUPPORTED,
                );
            }
            // A presenter that refuses is saying "I have no layer to show you". Report that
            // reason — the alternative every layer capture used to take was a black PNG.
            try {
                blob = await active.capturePresentedLayer();
            } catch (err) {
                throw new HarnessError(
                    `presenter layer capture refused: ${(err as Error).message}.`
                    + " Use the default source:'screen'.",
                    HarnessErrorCode.UNSUPPORTED,
                );
            }
            source = "layer";
            warning = LAYER_BLIND_SPOT;
        } else {
            // Say WHICH way it failed — "no canvas at all" and "nothing mirrored yet" are
            // different diagnoses, and neither may be answered with a different image.
            try {
                blob = await render?.captureScreen?.();
            } catch (err) {
                // First capture on a screen that is not repainting: the mirror (armed by
                // that very call) is still empty. Nudge one repaint — a dirty GDI overlay
                // or a presenter re-present — and retry, rather than reporting a screen we
                // simply never asked the compositor for.
                sys().gdiContext?.setOverlayDirty?.(true);
                active?.repaintLastFrame?.();
                for (let i = 0; i < 4 && !blob; i++) {
                    await new Promise<void>((r) => requestAnimationFrame(() => r()));
                    blob = await render?.captureScreen?.().catch(() => null);
                }
                if (!blob) {
                    throw new HarnessError(
                        `screen capture failed: ${(err as Error).message}. Nudging a repaint did not produce a frame` +
                        " either — `bun tools/harness.ts shot` (CDP page capture) is the independent route to the same" +
                        " pixels; overlay()/dumpSurface('primary') see the guest layers.",
                        HarnessErrorCode.UNSUPPORTED,
                    );
                }
            }
            if (!blob) {
                throw new HarnessError(
                    "cannot see the screen: no render backend/canvas yet (nothing presented?)." +
                    " `bun tools/harness.ts shot` (CDP page capture) sees the page regardless;" +
                    " dumpSurface('primary') / overlay() see the guest layers.",
                    HarnessErrorCode.UNSUPPORTED,
                );
            }
        }

        const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
        const size = pngSize(bytes);
        // An empty/undecodable blob is a capture that FAILED. Handing it back as a PNG is
        // the lie — an agent reads "0 bytes" as a black screen and chases a rendering bug.
        if (!bytes.length || !size) {
            throw new HarnessError(
                `${source} capture produced no image (${bytes.length} bytes)` +
                ` — presenter ${active?.constructor?.name ?? "unknown"} has nothing to read back.` +
                " Use `bun tools/harness.ts shot` (CDP page capture) or dumpSurface('primary').",
                HarnessErrorCode.UNSUPPORTED,
            );
        }
        const base64 = bytesToBase64(bytes);
        let saved: string | null = null;
        if (opts.save) {
            const name = opts.save.replace(/\.png$/i, "");
            (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
            saved = debugDumpPath(name);
        }
        // presentsSinceCapture: 0 = the mirrored frame IS the current screen, N = the
        // screen moved on N presents while we read it back, -1 = read off the canvas.
        return {
            bytes: bytes.length, base64, saved, source,
            composited: source === "screen",
            width: size.width, height: size.height,
            ...(source === "screen" ? { presentsSinceCapture: render?.screenMirrorAge?.() ?? -1 } : {}),
            ...(warning ? { warning } : {}),
        };
    });

    /**
     * frameLog(n?) — last `n` per-present summaries from the active presenter
     * (D3D9). Each entry: { p, hasClear, flags, cmds, draws, color }. Lets an
     * agent correlate visible black frames with clear-only presents (hasClear &&
     * draws===0) vs content presents — the decisive datum for swap/flicker bugs.
     */
    svc.register("frameLog", (args) => {
        const n = typeof args[0] === "number" ? (args[0] as number) : 60;
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getFrameLog) throw new HarnessError("active presenter has no frameLog (not D3D9, or nothing rendered yet)", HarnessErrorCode.UNSUPPORTED);
        return active.getFrameLog(n);
    });

    /**
     * overlay() — the GDI overlay plane as a PNG (logs/debug/) plus the compositing
     * DECISION that the presenter applies to it (getOverlayCompositePlan). The canvas
     * is the sum of the DDraw/3D frame AND this plane, so "the game renders but the
     * screen is wrong" always splits into: which layer holds the pixels, and does the
     * plan composite it. Alpha is preserved — transparent reads as a=0, not white.
     *
     * `screenOwner` reports the DirectDraw ownership state the decision is derived from
     * (cooperative level, which window owns the screen, and whether the flip chain or the
     * GDI surface is currently on screen) — the inputs, next to the verdict.
     */
    svc.register("overlay", async (args) => {
        const opts = (args[0] ?? {}) as { save?: string };
        const gdi: any = sys().gdiContext;
        const canvas: OffscreenCanvas | null = gdi?.getOverlayCanvas?.() ?? null;
        const plan = getOverlayCompositePlan();
        const dd: any = (sys().process?.getModule("ddraw") as any)?.context;
        const info = {
            plan,
            hasContent: !!gdi?.hasOverlayContent?.(),
            dirty: !!gdi?.isOverlayDirty?.(),
            // True while a guest paint sequence is being withheld from compositors
            // (GDIContext.beginOverlayPublish) — the plane has half-painted pixels.
            publishHeld: !!gdi?.isOverlayPublishHeld?.(),
            // The bracket's own books: nesting depth, time left on the fail-open
            // deadline (negative = overdue), and lifetime begins/ends/expiries. A held
            // bracket is only a bug once `begins - ends` stops coming back to zero, and
            // `expiries` is the proof the deadline is alive rather than merely written.
            publish: gdi?.overlayPublishStats?.() ?? null,
            gameOwnsScreen: isGameScreenOwned(),
            screenOwner: {
                coopHwnd: dd?.cooperative?.hwnd ?? 0,
                coopFlags: `0x${((dd?.cooperative?.flags ?? 0) >>> 0).toString(16)}`,
                exclusive: !!dd?.cooperative?.exclusive,
                gdiSurfaceVisible: dd ? dd.gdiSurfaceVisible : null,
                flipScreenOwned: isFlipScreenOwned(),
                // Exclusive rights + a primary are not content: an app that took exclusive
                // mode for the display mode and paints with GDI never presents, and its UI
                // lives entirely in the overlay.
                ddrawShowsContent: ddrawShowsContent(dd),
                ddrawFramesPresented: (dd?.presenter as { getCounters?(): Record<string, number> } | undefined)?.getCounters?.().frames ?? null,
                primary: `0x${((dd?.surfaces?.primary ?? 0) >>> 0).toString(16)}`,
                backBuffer: `0x${((dd?.surfaces?.backBuffer ?? 0) >>> 0).toString(16)}`,
            },
            liveDialogs: getLiveDialogOverlays(),
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
            saved: null as string | null,
        };
        if (!canvas) return info;
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const name = (opts.save ?? "gdi_overlay").replace(/\.png$/i, "");
        (self as unknown as Worker).postMessage({
            type: "debug_png_dump", name, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        });
        info.saved = debugDumpPath(name);
        return info;
    });

    /**
     * wedgeOverlayPublish() — open a GDI publish bracket and deliberately never close
     * it, i.e. inject the exact failure the fail-open deadline exists for.
     *
     * A deadline nothing has been seen to trip is not a deadline. This makes it
     * testable: wedge, then watch `overlay().publish.expiries` tick and the screen come
     * back on its own. Diagnostic only — no guest state is touched.
     */
    svc.register("wedgeOverlayPublish", () => {
        const gdi: any = sys().gdiContext;
        if (!gdi?.beginOverlayPublish) {
            throw new HarnessError("no GDI context", HarnessErrorCode.UNSUPPORTED);
        }
        gdi.beginOverlayPublish();
        return { wedged: true, publish: gdi.overlayPublishStats?.() ?? null };
    });

    /**
     * flicker(n?, { save?, source? }) — turn "the screen flickers" into a number.
     *
     * Samples the display over `n` frames and reports, per sample, how much it changed
     * against the previous one AND the compositing state that produced it (plan mode,
     * overlay dirty/content, DDraw presents, present serial). A flicker is a high-diff
     * oscillation with a period of a frame or two; the sample that is 90% different and
     * 3% bright is the erase frame, and the row next to it names what the compositor
     * decided at that moment. Reasoning about DC topology cannot see this; two
     * consecutive captures can.
     *
     * source:
     *  - "overlay" (default): the GDI plane, read straight off its 2D canvas. Synchronous,
     *    so it really does sample CONSECUTIVE display frames, and it reports `holePct` —
     *    fully transparent pixels, i.e. an erase that has not been repainted yet. This is
     *    the route that can see a one-frame flash.
     *  - "screen": the composited canvas via the present mirror. Authoritative about what
     *    the user sees, but a PNG encode + decode per sample costs ~3 display frames, so it
     *    ALIASES anything shorter than that. Use it to confirm, not to hunt.
     */
    svc.register("flicker", async (args) => {
        const n = Math.max(2, Math.min(240, typeof args[0] === "number" ? (args[0] as number) : 30));
        const opts = (args[1] ?? {}) as { save?: string; source?: "screen" | "overlay" };
        const source = opts.source ?? "overlay";
        const render: any = sys().services?.render;
        const gdi: any = sys().gdiContext;
        const dd: any = (sys().process?.getModule("ddraw") as any)?.context;
        const overlayCanvas: OffscreenCanvas | null = gdi?.getOverlayCanvas?.() ?? null;
        if (source === "overlay" && !overlayCanvas) {
            throw new HarnessError(
                "no GDI overlay canvas — nothing has used a window DC yet. Use source:'screen'.",
                HarnessErrorCode.UNSUPPORTED,
            );
        }

        // 64x48 is enough to catch a full-screen erase or a control-sized flash while
        // keeping a sample well inside one display frame.
        const SW = 64, SH = 48;
        const scratch = new OffscreenCanvas(SW, SH);
        const sctx = scratch.getContext("2d", { willReadFrequently: true });
        if (!sctx) throw new HarnessError("no 2d context for the sampler", HarnessErrorCode.UNSUPPORTED);

        interface Sample {
            i: number; plan: string; overlayDirty: boolean; overlayContent: boolean;
            publishHeld: boolean;
            ddrawFrames: number | null; presentSerial: number;
            luma: number; holePct: number; diffPct: number | null; blank: boolean;
            /** [x,y,w,h] of what changed since the previous sample, in screen pixels. */
            bbox?: [number, number, number, number];
        }
        const samples: Sample[] = [];
        const sigs: Uint8ClampedArray[] = [];
        let prev: Uint8ClampedArray | null = null;
        let firstBlob: Blob | null = null;
        let flashBlob: Blob | null = null;
        let flashIndex = -1;
        let maxDiff = 0;

        for (let i = 0; i < n; i++) {
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            // Read the compositing state BEFORE the capture: a screen capture awaits, and
            // the flags it reports must belong to the frame the pixels came from.
            const plan = getOverlayCompositePlan();
            const row: Sample = {
                i,
                plan: plan.mode,
                overlayDirty: !!gdi?.isOverlayDirty?.(),
                overlayContent: !!gdi?.hasOverlayContent?.(),
                publishHeld: !!gdi?.isOverlayPublishHeld?.(),
                ddrawFrames: (dd?.presenter as { getCounters?(): Record<string, number> } | undefined)?.getCounters?.().frames ?? null,
                presentSerial: (render?.["presentSerial"] as number) ?? -1,
                luma: 0, holePct: 0, diffPct: null, blank: false,
            };

            let px: Uint8ClampedArray;
            if (source === "overlay") {
                sctx.clearRect(0, 0, SW, SH);
                sctx.drawImage(overlayCanvas!, 0, 0, SW, SH);
                px = sctx.getImageData(0, 0, SW, SH).data;
            } else {
                const blob: Blob | null = await render?.tryCaptureScreen?.();
                if (!blob) { samples.push(row); continue; }
                if (!firstBlob) firstBlob = blob;
                const bmp = await createImageBitmap(blob);
                sctx.clearRect(0, 0, SW, SH);
                sctx.drawImage(bmp, 0, 0, SW, SH);
                bmp.close();
                px = sctx.getImageData(0, 0, SW, SH).data;
                if (flashIndex === i - 1 || flashIndex < 0) flashBlob = blob;
            }

            let sum = 0;
            let holes = 0;
            for (let p = 0; p < px.length; p += 4) {
                sum += (px[p] + px[p + 1] + px[p + 2]) / 3;
                if (px[p + 3] < 8) holes++;
            }
            row.luma = Math.round((sum / (SW * SH)) * 10) / 10;
            row.holePct = Math.round((holes / (SW * SH)) * 1000) / 10;
            row.blank = row.luma < 4;

            if (prev) {
                let changed = 0;
                let x0 = SW, y0 = SH, x1 = -1, y1 = -1;
                for (let p = 0; p < px.length; p += 4) {
                    if (Math.abs(px[p] - prev[p]) + Math.abs(px[p + 1] - prev[p + 1]) + Math.abs(px[p + 2] - prev[p + 2]) <= 24) continue;
                    changed++;
                    const c = (p >> 2) % SW, r = (p >> 2) / SW | 0;
                    if (c < x0) x0 = c; if (c > x1) x1 = c;
                    if (r < y0) y0 = r; if (r > y1) y1 = r;
                }
                row.diffPct = Math.round((changed / (SW * SH)) * 1000) / 10;
                // Where it changed, in screen pixels — that is what names the control.
                if (x1 >= 0) {
                    const sx = (overlayCanvas?.width ?? SW) / SW, sy = (overlayCanvas?.height ?? SH) / SH;
                    row.bbox = [Math.round(x0 * sx), Math.round(y0 * sy), Math.round((x1 - x0 + 1) * sx), Math.round((y1 - y0 + 1) * sy)];
                }
                if (row.diffPct > maxDiff) { maxDiff = row.diffPct; flashIndex = i; }
            }
            prev = new Uint8ClampedArray(px);
            sigs.push(prev);
            samples.push(row);
        }

        // Oscillation: a sample that differs a lot from its neighbour but matches the one
        // before it is a two-state flip, not a transition to a new screen.
        const diffOf = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
            let changed = 0;
            for (let p = 0; p < a.length; p += 4) {
                if (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]) > 24) changed++;
            }
            return (changed / (SW * SH)) * 100;
        };
        let oscillating = 0;
        for (let i = 2; i < sigs.length; i++) {
            if (diffOf(sigs[i], sigs[i - 1]) > 10 && diffOf(sigs[i], sigs[i - 2]) < 2) oscillating++;
        }

        const changedSamples = samples.filter((s) => (s.diffPct ?? 0) > 2).length;
        const saved: Record<string, string> = {};
        const dump = async (blob: Blob | null, name: string): Promise<void> => {
            if (!blob) return;
            (self as unknown as Worker).postMessage({
                type: "debug_png_dump", name,
                base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
            });
            saved[name] = debugDumpPath(name);
        };
        if (opts.save) {
            const stem = opts.save.replace(/\.png$/i, "");
            if (source === "screen") {
                await dump(firstBlob, `${stem}-first`);
                await dump(flashBlob, `${stem}-flash`);
            } else {
                // The sweep kept only the 64x48 signatures (full-res blobs would have cost
                // the frame-accuracy this route exists for). They are thumbnails, but they
                // show WHERE the flash was, which is the question.
                const emit = async (sig: Uint8ClampedArray | undefined, name: string): Promise<void> => {
                    if (!sig) return;
                    const img = sctx.createImageData(SW, SH);
                    img.data.set(sig);
                    sctx.putImageData(img, 0, 0);
                    await dump(await scratch.convertToBlob({ type: "image/png" }), name);
                };
                await emit(sigs[0], `${stem}-first`);
                if (flashIndex >= 0) await emit(sigs[flashIndex], `${stem}-flash`);
            }
        }

        return {
            samples,
            summary: {
                frames: samples.length,
                changedSamples,
                oscillating,
                blankSamples: samples.filter((s) => s.blank).length,
                maxDiffPct: samples.reduce((m, s) => Math.max(m, s.diffPct ?? 0), 0),
                maxHolePct: samples.reduce((m, s) => Math.max(m, s.holePct), 0),
                planModes: [...new Set(samples.map((s) => s.plan))],
                firstFlashSample: flashIndex,
                source,
            },
            saved,
        };
    });

    /** rtDebug() — D3D9 render-target diagnostics: recent SetRenderTarget surface→texture
     *  resolutions + which textures were created with D3DUSAGE_RENDERTARGET. */
    svc.register("rtDebug", () => {
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getRtDebug) throw new HarnessError("active presenter has no rtDebug (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        return active.getRtDebug();
    });

    /** passCensus() — what each recently submitted D3D9 render pass was OPENED with:
     *  command/draw counts, the attachment kind, and the viewport applied to the whole pass.
     *
     *  `captureFrame` reports the viewport each DRAW asked for; a pass carries one opening
     *  viewport for all of them. When those disagree the frame renders into a rectangle no
     *  single draw ever requested — which is invisible to every per-draw instrument. */
    svc.register("passCensus", () => {
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getPassDebug) throw new HarnessError("active presenter has no pass census (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        return active.getPassDebug();
    });

    /** declCensus({reset?}) — D3D9 vertex declarations the game draws with, the streams each
     *  spans, and per declaration the FFP semantics we DROP because the fixed-function
     *  shader/layout is built from stream 0 only. `drawsDropping` vs `drawsTotal` prices it:
     *  a dropped TEXCOORD/COLOR rasterizes as flat white with no error raised anywhere, so a
     *  screenshot cannot distinguish it from a game that means to draw white. Rate per frame:
     *  declCensus({reset:true}) -> tickFrames(N) -> declCensus(). */
    svc.register("declCensus", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.declCensus) throw new HarnessError("active presenter has no declCensus (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        const snapshot = active.declCensus();
        if (opts.reset) active.resetDeclCensus();
        return snapshot;
    });

    /** shaderCensus() — the compiled D3D9 vertex/pixel shaders: version, the constant-array
     *  bound the generated WGSL was given, the highest STATICALLY referenced register, and
     *  whether the program reads constants relatively (c[a0+n]).
     *
     *  `relative:true` with `constants` below `registerFile` is a silent wrong answer waiting
     *  to happen: an out-of-range relative read is clamped, never faulted, so a matrix-palette
     *  index past the array resolves to one fixed matrix and those vertices erupt out of the
     *  mesh. The picture reads as a skinning/declaration bug and nothing else names the cause. */
    svc.register("shaderCensus", () => {
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.shaderCensus) throw new HarnessError("active presenter has no shaderCensus (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        return active.shaderCensus();
    });
}
