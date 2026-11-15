import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { createOpenGLContext, OpenGLContext, GLFrameSnapshot, resetOpenGLContext } from "./context";
import { OpenGLPresenter } from "./presenter";
import { OpenGLBackendExecutor } from "../../backends/webgpu/opengl/opengl-backend-executor";
import { buildOpenGLDebugInfo, OpenGLDebugInfo } from "./diagnostics";
import { createStateExports } from "./state";
import { createMatrixExports } from "./matrix";
import { createQueryExports } from "./query";
import { createImmediateExports, registerWriteBufferGLFunctions } from "./immediate";
import { createTextureExports } from "./texture";
import { createWglExports, createWglState, resetWglState, type WglState } from "./wgl";
import { createListExports } from "./lists";
import { createArrayExports } from "./arrays";
import { createMultitextureExports } from "./multitexture";
import { registerWriteBufferGLStateFunctions } from "./wbuf-state";
import { GL_COMPILE, GL_TEXTURE0 } from "./constants";
import { resetImmediateMaterials } from "./lighting";
import { savestateParticipants, savestatesEnabled } from "../../savestate/participant";
import type { SaveValue } from "../../savestate/value-codec";
import {
    OPENGL32_SCHEMA, captureOpenGL, createRestoreDebt, prepareOpenGL, restoreOpenGL, settleRestoreDebt,
    type OpenGLSavedState,
} from "./savestate";

/**
 * A display list owns vector attribute values from the compilation call, not
 * the guest address. Canonical scalar commands retain that ownership on raw
 * replay as well as on the prebaked path.
 */
function snapshotAttributeVector(name: string, args: number[], ctx: OpenGLContext): { fn: string; args: number[] } | null {
    const match = /^gl(Vertex|Normal|Color|TexCoord|MultiTexCoord)([1-4])(ub|ui|us|b|s|i|f|d)v(ARB)?$/.exec(name);
    if (!match) return null;
    const family = match[1], count = Number(match[2]), type = match[3];
    const multi = family === "MultiTexCoord";
    // Other MultiTexCoord vector exports are stubs; do not turn them into
    // working scalar calls or read an address the original stub never used.
    if (multi && (type !== "f" || (count !== 2 && count !== 4))) return null;
    const unit = (args[0] >>> 0) - GL_TEXTURE0;
    if (multi && (unit < 0 || unit >= ctx.currentTexCoord.length)) return null;
    const memory = ctx.process.getCurrentMemory();
    const ptr = args[multi ? 1 : 0] >>> 0;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const values: number[] = multi ? [args[0]] : [];
    const size = type === "d" ? 8 : type === "f" || type === "i" || type === "ui" ? 4
        : type === "s" || type === "us" ? 2 : 1;
    for (let i = 0; i < count; i++) {
        const offset = ptr + i * size;
        switch (type) {
            // Scalar float thunks consume IEEE bits; doubles consume JS numbers.
            case "f": values.push(view.getUint32(offset, true)); break;
            case "d": values.push(view.getFloat64(offset, true)); break;
            case "i": values.push(view.getInt32(offset, true)); break;
            case "ui": values.push(view.getUint32(offset, true)); break;
            case "s": values.push(view.getInt16(offset, true)); break;
            case "us": values.push(view.getUint16(offset, true)); break;
            case "b": values.push(view.getInt8(offset)); break;
            case "ub": values.push(view.getUint8(offset)); break;
        }
    }
    return { fn: name.replace(/v(ARB)?$/, "$1"), args: values };
}

export class OpenGL32 implements IModule {
    name = "opengl32";
    exports: Record<string, ThunkImplementation> = {};
    private context: OpenGLContext | null = null;
    private wgl: WglState = createWglState();
    private restoreDebt = createRestoreDebt();

    registerSavestate(): () => void {
        return savestateParticipants.add({
            id: 'opengl32', version: 3, order: 59, covers: ['opengl32', 'glu32'], schema: OPENGL32_SCHEMA as unknown as SaveValue,
            prepare: () => prepareOpenGL(this.context),
            capture: (io) => {
                if (!this.context) throw new Error("opengl32: the module is not initialized");
                return captureOpenGL(this.context, this.wgl, io) as unknown as SaveValue;
            },
            restore: (saved, io) => {
                if (!this.context) throw new Error("opengl32: the module is not initialized");
                restoreOpenGL(this.context, this.wgl, saved as unknown as OpenGLSavedState, io.blob, this.restoreDebt);
                const glu = this.context.process?.getModule?.("glu32") as { dropCachedStrings?: () => void } | undefined;
                glu?.dropCachedStrings?.();
            },
        });
    }

    initialize(process: Process): void {
        if (savestatesEnabled()) this.registerSavestate();
        this.wgl = createWglState();
        this.restoreDebt = createRestoreDebt();
        this.context = createOpenGLContext(process);
        this.context.presenter = new OpenGLPresenter(this.context);

        Object.assign(this.exports, createStateExports(this.context));
        Object.assign(this.exports, createMatrixExports(this.context));
        Object.assign(this.exports, createQueryExports(this.context));
        Object.assign(this.exports, createImmediateExports(this.context));
        Object.assign(this.exports, createTextureExports(this.context));
        Object.assign(this.exports, createWglExports(this.context, undefined, this.wgl));
        Object.assign(this.exports, createListExports(this.context));
        Object.assign(this.exports, createArrayExports(this.context));
        Object.assign(this.exports, createMultitextureExports(this.context));

        // Display-list recording wrapper:
        // when glNewList(.., GL_COMPILE/GL_COMPILE_AND_EXECUTE) is active,
        // capture all non-list-control calls into ctx.compilingCommands.
        const listControl = new Set<string>([
            "glNewList",
            "glEndList",
            "glCallList",
            "glCallLists",
            "glDeleteLists",
            "glGenLists",
            "glListBase",
            "glIsList",
        ]);

        for (const [name, impl] of Object.entries(this.exports)) {
            this.exports[name] = (sysCtx, mem, args) => {
                const ctx = this.context;
                if (!ctx || ctx.replayingList || listControl.has(name)) {
                    return impl(sysCtx, mem, args);
                }

                if (ctx.compilingList !== null) {
                    const snapshot = snapshotAttributeVector(name, args, ctx);
                    ctx.compilingCommands.push(snapshot ?? { fn: name, args: [...args] });

                    // GL_COMPILE: record only, no execution side effects.
                    if (ctx.compilingListMode === GL_COMPILE) {
                        return 0;
                    }
                }

                return impl(sysCtx, mem, args);
            };
        }

        // Register Tier-0 write-buffer stubs for high-frequency immediate-mode functions.
        // Stubs may not exist yet (PE loading is deferred); registerWriteBufferGLFunctions
        // uses the pending-registration mechanism and will be applied at applyPendingRegistrations().
        registerWriteBufferGLFunctions(process.dispatcher, this.context);

        // State / bind / array-pointer entrypoints drain through the table above, so this
        // must run AFTER the display-list wrapper has replaced every entry.
        registerWriteBufferGLStateFunctions(process.dispatcher, this.exports);
    }

    setBackend(backend: WebGPUBackend): void {
        if (!this.context) return;
        this.context.backend = backend;
        this.context.executor?.destroy();
        this.context.executor = null;
        settleRestoreDebt(this.context, this.restoreDebt);
    }

    getFrameSnapshot(): GLFrameSnapshot {
        if (!this.context) {
            return { frameId: 0, drawCalls: 0, presents: 0, texUploads: 0, clearCalls: 0, vertexCount: 0 };
        }
        return { ...this.context.frameSnapshot };
    }

    getDebugResourcesInfo(): OpenGLDebugInfo | null {
        if (!this.context) return null;
        return buildOpenGLDebugInfo(this.context);
    }

    getContext(): OpenGLContext | null {
        return this.context;
    }

    reset(): void {
        if (this.context) {
            resetOpenGLContext(this.context);
            resetImmediateMaterials(this.context);
        }
        // The next game gets fresh WGL state: the cached extensions string lived in the old
        // guest memory, and contexts and swap intervals belonged to the old windows.
        resetWglState(this.wgl);
        this.restoreDebt = createRestoreDebt();
    }
}
