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
import { createWglExports } from "./wgl";
import { createListExports } from "./lists";
import { createArrayExports } from "./arrays";
import { createMultitextureExports } from "./multitexture";
import { registerWriteBufferGLStateFunctions } from "./wbuf-state";
import { GL_COMPILE } from "./constants";

export class OpenGL32 implements IModule {
    name = "opengl32";
    exports: Record<string, ThunkImplementation> = {};
    private context: OpenGLContext | null = null;

    initialize(process: Process): void {
        this.context = createOpenGLContext(process);
        this.context.presenter = new OpenGLPresenter(this.context);

        Object.assign(this.exports, createStateExports(this.context));
        Object.assign(this.exports, createMatrixExports(this.context));
        Object.assign(this.exports, createQueryExports(this.context));
        Object.assign(this.exports, createImmediateExports(this.context));
        Object.assign(this.exports, createTextureExports(this.context));
        Object.assign(this.exports, createWglExports(this.context));
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
                    const recordedArgs = Array.isArray(args) ? [...args] : [];
                    ctx.compilingCommands.push({ fn: name, args: recordedArgs });

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
        // Executor re-created lazily on wglMakeCurrent or first frame
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
        if (this.context) resetOpenGLContext(this.context);
    }
}
