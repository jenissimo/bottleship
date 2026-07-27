/**
 * shot() — capture the on-screen frame as a PNG. Worker-side wrap of
 * RenderActive.captureFrame() (the active presenter's screenshot), returned as
 * base64 through the RPC contract (POJO-friendly). With opts.save it also routes
 * the PNG to the log server via the existing debug_png_dump channel (logs/debug/).
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { getOverlayCompositePlan, isGameScreenOwned, isFlipScreenOwned, getLiveDialogOverlays } from "../../modules/user32/dialog-overlay";

/** Base64-encode bytes (chunked to avoid String.fromCharCode arg overflow). */
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export function registerScreenCommands(svc: HarnessService): void {
    svc.register("shot", async (args) => {
        const opts = (args[0] ?? {}) as { save?: string };
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.captureFrame) throw new HarnessError("no active presenter (nothing rendered yet)", HarnessErrorCode.UNSUPPORTED);
        const blob: Blob = await active.captureFrame();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const base64 = bytesToBase64(bytes);
        let saved: string | null = null;
        if (opts.save) {
            const name = opts.save.replace(/\.png$/i, "");
            (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
            saved = `logs/debug/${name}.png`;
        }
        return { bytes: bytes.length, base64, saved };
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
        info.saved = `logs/debug/${name}.png`;
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
