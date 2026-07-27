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
            blob = await active.capturePresentedLayer();
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
            gameOwnsScreen: isGameScreenOwned(),
            screenOwner: {
                coopHwnd: dd?.cooperative?.hwnd ?? 0,
                coopFlags: `0x${((dd?.cooperative?.flags ?? 0) >>> 0).toString(16)}`,
                exclusive: !!dd?.cooperative?.exclusive,
                gdiSurfaceVisible: dd ? dd.gdiSurfaceVisible : null,
                flipScreenOwned: isFlipScreenOwned(),
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

    /** rtDebug() — D3D9 render-target diagnostics: recent SetRenderTarget surface→texture
     *  resolutions + which textures were created with D3DUSAGE_RENDERTARGET. */
    svc.register("rtDebug", () => {
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getRtDebug) throw new HarnessError("active presenter has no rtDebug (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        return active.getRtDebug();
    });
}
