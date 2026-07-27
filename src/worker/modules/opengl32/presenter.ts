import { RenderActive } from "../../runtime/runtime-services";
import { OpenGLContext } from "./context";
import { System } from "../../core/system";
import { Logger, LogCategory } from "../../core/logger";
import { frameProfiler } from "../../core/frame-profiler";
import { statsOverlay } from "../../core/stats-overlay";
import { captureGLFrameIfArmed } from "./frame-capture";

export class OpenGLPresenter implements RenderActive {
    readonly suppressGdiOverlay = true;
    private ctx: OpenGLContext;
    private prevPresentTime = 0;

    constructor(ctx: OpenGLContext) {
        this.ctx = ctx;
    }

    present(): void {
        const ctx = this.ctx;
        ctx.frameSnapshot.presents++;
        ctx.frameId++;

        // Claim screen ownership on every present. Fast-path wglMakeCurrent may bypass the
        // JS handler, so present() is the reliable point to mark the GL renderer active.
        System.getInstance().services.render.setActive(this);

        if (!ctx.executor) {
            Logger.warn(LogCategory.SYSTEM,
                `OpenGL present: no executor (frame=${ctx.frameId} backend=${!!ctx.backend})`);
        } else if (ctx.commands.count === 0 && ctx.textures.size === 0) {
            Logger.warn(LogCategory.SYSTEM, `OpenGL present: 0 commands, 0 textures (frame=${ctx.frameId})`);
        } else if (ctx.frameId <= 3) {
            Logger.verbose(LogCategory.SYSTEM,
                `OpenGL present: cmds=${ctx.commands.count} texs=${ctx.textures.size} frame=${ctx.frameId}`);
        }

        if (ctx.executor && (ctx.commands.count > 0 || ctx.textures.size > 0)) {
            const [dw, dh] = ctx.executor.getDrawableSize();
            captureGLFrameIfArmed(ctx, dw, dh);
            ctx.executor.executeFrame({
                commands: ctx.commands,
                vertArena: ctx.vertArena.data,
                textures: ctx.textures,
            });
        }

        // Commands and the vertex arena they point into are frame-scoped: reuse the
        // storage, never hand a command or an arena slice past this point.
        ctx.commands.reset();
        ctx.vertArena.reset();

        // Notify render service
        const system = System.getInstance();
        system.services.render.notifyPresent("opengl");

        // Frame profiler & stats overlay
        frameProfiler.markFrame("opengl");
        const now = performance.now();
        if (this.prevPresentTime > 0) {
            statsOverlay.updateMetrics(now - this.prevPresentTime);
        }
        this.prevPresentTime = now;

        // Reset per-frame counters
        ctx.frameSnapshot.drawCalls = 0;
        ctx.frameSnapshot.clearCalls = 0;
        ctx.frameSnapshot.texUploads = 0;
        ctx.frameSnapshot.vertexCount = 0;
    }

    /** Re-blit the last GL frame to the canvas (see executor.repaintLastFrame). */
    repaintLastFrame(): void {
        this.ctx.executor?.repaintLastFrame();
    }

    /** PNG of the screen (canvas, overlays composited). The GL executor renders straight
     *  into the swap-chain texture, which has no COPY_SRC, so the canvas is the only
     *  readable source; an empty blob means nothing was presented yet, not a black frame. */
    async captureFrame(): Promise<Blob> {
        return (await System.getInstance().services.render.tryCaptureScreen()) ?? new Blob([], { type: "image/png" });
    }

    getCounters(): Record<string, number> {
        return {
            frames: this.ctx.frameId,
            drawCalls: this.ctx.frameSnapshot.drawCalls,
            presents: this.ctx.frameSnapshot.presents,
            textures: this.ctx.textures.size,
        };
    }
}
