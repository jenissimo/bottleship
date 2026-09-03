import { Logger, LogCategory } from "../../core/logger";
import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { GlideBackendExecutor } from "../../backends/webgpu/glide/glide-backend-executor";
import { System } from "../../core/system";
import { framePacer } from "../../core/frame-pacer";
import {
    FXFALSE,
    FXTRUE,
    GLIDE_FBI_REV,
    GLIDE_FBRAM_MB,
    GLIDE_TMU_COUNT,
    GLIDE_TMU_MEMORY_BYTES,
    swizzleGlideColor,
    GLIDE_TMU_REV,
    GLIDE_VERSION_STRING,
    GR_BUFFER_BACKBUFFER,
    GR_BUFFER_FRONTBUFFER,
    GR_ORIGIN_UPPER_LEFT,
} from "./constants";
import { GlideContext, applySstBoardDefaults } from "./context";
import { GlidePresenter } from "./presenter";
import { GrHwConfigurationView } from "./structs";
import { destroyLfbSurfaces, revokeAllLfbLeases, validateAllLfbCanaries } from "./lfb";

function decodeResolution(resolution: number): { width: number; height: number } {
    switch (resolution | 0) {
        case 0: return { width: 320, height: 200 };
        case 1: return { width: 320, height: 240 };
        case 2: return { width: 400, height: 256 };
        case 3: return { width: 512, height: 384 };
        case 4: return { width: 640, height: 200 };
        case 5: return { width: 640, height: 350 };
        case 6: return { width: 640, height: 400 };
        case 7: return { width: 640, height: 480 };
        case 8: return { width: 800, height: 600 };
        case 9: return { width: 960, height: 720 };
        case 10: return { width: 856, height: 480 };
        case 11: return { width: 512, height: 256 };
        case 12: return { width: 1024, height: 768 };
        case 13: return { width: 1280, height: 1024 };
        case 14: return { width: 1600, height: 1200 };
        default: return { width: 640, height: 480 };
    }
}

export function setGlideError(context: GlideContext, code: number, message: string): void {
    context.frameSnapshot.lastError = {
        code: code >>> 0,
        message,
        timestamp: performance.now(),
    };
    context.diagnostics.push("error", `${code >>> 0}: ${message}`);
    Logger.warn(LogCategory.SYSTEM, `[glide2x] ${message} (code=${code >>> 0})`);
}

function ensureExecutor(context: GlideContext): boolean {
    if (!context.backend) {
        setGlideError(context, 0x1001, "WebGPU backend is not assigned for Glide2x");
        return false;
    }
    if (!context.backend.getDevice() || !context.backend.getQueue() || !context.backend.getContext()) {
        setGlideError(context, 0x1002, "WebGPU backend is unavailable");
        return false;
    }

    if (context.executor) {
        return true;
    }

    context.executor = new GlideBackendExecutor(context.backend);
    return true;
}

export function createHardwareExports(context: GlideContext): Record<string, ThunkImplementation> {
    const hwConfigView = new GrHwConfigurationView();

    return {
        "_grGlideInit@0": () => {
            context.initialized = true;
            context.diagnostics.push("init", "grGlideInit");
            return 0;
        },

        "_grGlideShutdown@0": () => {
            revokeAllLfbLeases(context);
            destroyLfbSurfaces(context);
            context.winOpen = false;
            context.initialized = false;
            System.getInstance().services.render.setActive(null);
            context.presenter = null;
            context.executor?.destroy();
            context.executor = null;
            context.stream.reset();
            context.nextTextureHandle = 1;
            for (const tmu of context.tmus) {
                tmu.texturesByAddress.clear();
                tmu.currentAddress = 0;
            }
            context.diagnostics.push("shutdown", "grGlideShutdown");
            return 0;
        },

        "_grGlideGetVersion@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const bytes = new TextEncoder().encode(`${GLIDE_VERSION_STRING}\0`);
            Mem.writeBytes(ptr, bytes);
            return 0;
        },

        "_grGlideGetState@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            Mem.writeBytes(ptr, context.stateBlob);
            return 0;
        },

        "_grGlideSetState@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const src = Mem.readBytes(ptr, context.stateBlob.length);
            if (src) context.stateBlob.set(src);
            return 0;
        },

        "_grSstQueryHardware@4": (_ctx, _mem, args) => {
            const cfgPtr = args[0] >>> 0;
            if (!cfgPtr) return FXFALSE;
            const ok = hwConfigView.setPtr(cfgPtr).writeSingleVoodoo(
                GLIDE_FBRAM_MB, GLIDE_FBI_REV, GLIDE_TMU_COUNT, GLIDE_TMU_MEMORY_BYTES >>> 20, GLIDE_TMU_REV);
            context.diagnostics.push("init",
                `grSstQueryHardware cfg=0x${cfgPtr.toString(16)} ok=${ok ? 1 : 0} ` +
                `fbRam=${GLIDE_FBRAM_MB}MB nTexelfx=${GLIDE_TMU_COUNT} tmuRam=${GLIDE_TMU_MEMORY_BYTES >>> 20}MB`);
            Logger.log(LogCategory.SYSTEM,
                `[Glide] grSstQueryHardware -> 1 board, fbRam=${GLIDE_FBRAM_MB}MB fbiRev=${GLIDE_FBI_REV} ` +
                `nTexelfx=${GLIDE_TMU_COUNT} tmuRev=${GLIDE_TMU_REV} tmuRam=${GLIDE_TMU_MEMORY_BYTES >>> 20}MB ok=${ok ? 1 : 0}`);
            return ok ? FXTRUE : FXFALSE;
        },

        "_grSstQueryBoards@4": (_ctx, _mem, args) => {
            const cfgPtr = args[0] >>> 0;
            if (!cfgPtr) return FXFALSE;
            const ok = hwConfigView.setPtr(cfgPtr).writeSingleVoodoo(
                GLIDE_FBRAM_MB, GLIDE_FBI_REV, GLIDE_TMU_COUNT, GLIDE_TMU_MEMORY_BYTES >>> 20, GLIDE_TMU_REV);
            return ok ? FXTRUE : FXFALSE;
        },

        // The resolution grSstWinOpen actually gave us. Titles read these instead of
        // re-deriving the mode they asked for, and a garbage answer scales the HUD /
        // sizes an LFB copy against the wrong stride.
        "_grSstScreenWidth@0": () => context.width >>> 0,
        "_grSstScreenHeight@0": () => context.height >>> 0,

        // We render each Glide command synchronously, so the FIFO is never backed up;
        // a title polling grSstIsBusy() before touching the LFB must see FXFALSE or it
        // spins forever.
        "_grSstIsBusy@0": () => FXFALSE,

        // No beam: a title gating an LFB write on "are we in retrace" must be able to
        // proceed, so the window is always open. FXFALSE here is the shape that hangs.
        "_grSstVRetraceOn@0": () => FXTRUE,

        "_grSstSelect@4": (_ctx, _mem, args) => {
            context.selectedSst = args[0] | 0;
            return 0;
        },

        "_grSstWinOpen@28": (_ctx, _mem, args) => {
            if (!context.initialized) {
                setGlideError(context, 0x2001, "grSstWinOpen called before grGlideInit");
                return FXFALSE;
            }
            if (!ensureExecutor(context)) {
                return FXFALSE;
            }

            const res = decodeResolution(args[1] | 0);
            context.width = res.width;
            context.height = res.height;
            context.colorFormat = args[3] | 0;
            context.origin = args[4] | 0;
            // Glide initializes logical render buffer to BACK buffer.
            // In original glide2x (cvg gsst.c), renderBuf is set to backBuf after WinOpen.
            context.renderBuffer = GR_BUFFER_BACKBUFFER;
            context.winOpen = true;
            applySstBoardDefaults(context);

            if (!context.presenter) {
                context.presenter = new GlidePresenter(context);
            }

            // Mark Glide as active renderer for capture/stats.
            if (context.presenter) {
                System.getInstance().services.render.setActive(context.presenter);
            }

            context.diagnostics.push("winopen", `${context.width}x${context.height} fmt=${context.colorFormat}`);
            Logger.log(
                LogCategory.SYSTEM,
                `[Glide] grSstWinOpen ${context.width}x${context.height} colorFormat=${context.colorFormat} ` +
                `origin=${context.origin} renderBuffer=${context.renderBuffer}`,
            );
            return FXTRUE;
        },

        "_grSstWinClose@0": () => {
            revokeAllLfbLeases(context);
            destroyLfbSurfaces(context);
            context.winOpen = false;
            System.getInstance().services.render.setActive(null);
            context.stream.reset();
            context.diagnostics.push("winclose", "grSstWinClose");
            return 0;
        },

        "_grSstIdle@0": () => 0,
        "_grSstStatus@0": () => 0,

        // grSstControl(mode): GR_CONTROL_ACTIVATE/DEACTIVATE/RESIZE/MOVE. We own the whole
        // surface and have no real power states, so acknowledge success.
        "_grSstControl@4": () => FXTRUE,

        "_grSstPerformSelfTest@0": () => FXTRUE,

        "_grSstQueryMemory@8": (_ctx, _mem, args) => {
            const fbRamPtr = args[0] >>> 0;
            const texRamPtr = args[1] >>> 0;
            if (fbRamPtr) Mem.writeUint32(fbRamPtr, GLIDE_FBRAM_MB);
            if (texRamPtr) Mem.writeUint32(texRamPtr, GLIDE_TMU_MEMORY_BYTES >>> 20);
            return 0;
        },

        "_grErrorSetCallback@4": (_ctx, _mem, args) => {
            context.errorCallback = args[0] >>> 0;
            return 0;
        },

        "_grBufferSwap@4": (_ctx, _mem, args): number | Promise<number> => {
            if (!context.winOpen || !context.presenter) {
                return FXFALSE;
            }
            if (!validateAllLfbCanaries(context)) {
                return FXFALSE;
            }
            const swapInterval = args[0] | 0;
            const ok = context.presenter.presentFrame(swapInterval);
            context.diagnostics.push("swap", `interval=${swapInterval} ok=${ok ? 1 : 0}`);
            if (!ok) return FXFALSE;
            // Glide: 0 swaps without waiting for a vertical retrace, N>0 waits N retraces.
            // The swap itself runs first so the frame we read is the LFB as the guest left
            // it at the call — the retrace hold must not straddle other threads' execution.
            return framePacer.waitForPresentInterval(Math.max(0, swapInterval)).then(() => FXTRUE);
        },

        "_grBufferClear@12": (_ctx, _mem, args) => {
            const color = swizzleGlideColor(args[0] >>> 0, context.colorFormat);
            const depth = args[2] & 0xffff;
            context.pendingClearColor = color;
            context.pendingClearDepth = depth;
            context.stream.pushClear({
                color,
                depth,
                clearColor: true,
                clearDepth: true,
            });
            context.frameSnapshot.frameCounters.clears++;
            context.diagnostics.push("clear", `color=0x${color.toString(16)} depth=${depth}`);
            return 0;
        },

        "_grBufferNumPending@0": () => 0,

        "_grRenderBuffer@4": (_ctx, _mem, args) => {
            const prev = context.renderBuffer;
            context.renderBuffer = args[0] | 0;
            if (context.frameSnapshot.frameId < 30 || (context.frameSnapshot.frameId & 63) === 0) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grRenderBuffer ${prev} -> ${context.renderBuffer}`,
                );
            }
            return 0;
        },

        "_grSstOrigin@4": (_ctx, _mem, args) => {
            context.origin = args[0] | 0;
            if (context.origin !== 0 && context.origin !== 1) {
                context.origin = GR_ORIGIN_UPPER_LEFT;
            }
            return 0;
        },
    };
}

