import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { OpenGLContext } from "./context";
import { Logger, LogCategory } from "../../core/logger";
import { OpenGLBackendExecutor } from "../../backends/webgpu/opengl/opengl-backend-executor";
import { System } from "../../core/system";
import { gammaService } from "../../core/gamma-service";
import { resolveHleExportAddress } from "../../core/thunking/export-resolver";
import { guestDrawableSize } from "./drawable";
import { adoptDrawableExtent } from "./state";
import {
    chooseWglPixelFormat,
    describeWglPixelFormat,
    getWglPixelFormat,
    setWglPixelFormat,
} from "../gdi32/painting";

export interface WGLContextBinding {
    hglrc: number;
    hdc: number;
}

export interface WglContextEntry {
    hdc: number;
    attached: boolean;
}

export interface WglState {
    nextHglrc: number;
    contexts: Map<number, WglContextEntry>;
    threadBindings: Map<number, WGLContextBinding>;
    currentHglrc: number;
    currentHdc: number;
    /** Guest copy of the WGL extensions string, allocated on first query (0 = none yet). */
    extensionsString: number;
    /** wglSwapIntervalEXT's last accepted interval (1 = the driver default, vsync on). */
    swapInterval: number;
}

export function createWglState(): WglState {
    return {
        nextHglrc: 1,
        contexts: new Map(),
        threadBindings: new Map(),
        currentHglrc: 0,
        currentHdc: 0,
        extensionsString: 0,
        swapInterval: 1,
    };
}

export function resetWglState(state: WglState): void {
    state.nextHglrc = 1;
    state.contexts = new Map();
    state.threadBindings = new Map();
    state.currentHglrc = 0;
    state.currentHdc = 0;
    state.extensionsString = 0;
    state.swapInterval = 1;
}

/**
 * A GL entry point address, but only when a JS handler is actually registered behind it.
 *
 * GetProcAddress may legitimately hand back a stub for a declared-but-unimplemented
 * export; for wglGetProcAddress NULL is the DOCUMENTED "this extension is absent"
 * answer, and an engine that gets a pointer concludes the extension is present, calls
 * it, and takes the garbage return as truth. So the two agree on the registry they
 * consult, and disagree — deliberately — on what an unimplemented name resolves to.
 */
function resolveImplementedEntryPoint(dispatcher: any, name: string): number {
    const addr = resolveHleExportAddress(dispatcher, "opengl32", name) >>> 0;
    if (!addr) return 0;
    const stub = dispatcher?.thunkGenerator?.getStubByAddress?.(addr);
    if (!stub || !dispatcher?.getImplementationInfo?.(stub.functionId)) {
        Logger.verbose(LogCategory.GDI32, `wglGetProcAddress("${name}") -> 0 (declared, not implemented)`);
        return 0;
    }
    return addr;
}

export function createWglExports(
    ctx: OpenGLContext,
    drawableSize: (hdc: number) => { width: number; height: number } = guestDrawableSize,
    state: WglState = createWglState(),
): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['wglCreateContext'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        const hglrc = state.nextHglrc++;
        state.contexts.set(hglrc, { hdc, attached: false });
        if (!ctx.drawableDC) ctx.drawableDC = hdc;
        Logger.log(LogCategory.GDI32, `wglCreateContext(hdc=0x${hdc.toString(16)}) -> 0x${hglrc.toString(16)}`);
        return hglrc;
    };

    exports['wglDeleteContext'] = (_c, _m, args): number => {
        const hglrc = args[0] >>> 0;
        if (state.currentHglrc === hglrc) {
            state.currentHglrc = 0;
            state.currentHdc = 0;
            const system = System.getInstance();
            if (system.services.render.getActive() === ctx.presenter) {
                system.services.render.setActive(null);
            }
        }
        state.contexts.delete(hglrc);
        if (state.contexts.size === 0) {
            // The next context is a new GL state as far as its default rectangles go.
            ctx.viewportFromGuest = false;
            ctx.scissorFromGuest = false;
        }
        Logger.log(LogCategory.GDI32, `wglDeleteContext(0x${hglrc.toString(16)}) -> TRUE`);
        return 1;
    };

    exports['wglMakeCurrent'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        const hglrc = args[1] >>> 0;
        if (hglrc === 0) {
            state.currentHglrc = 0;
            state.currentHdc = 0;
            // wglMakeCurrent(NULL, NULL) unbinds but does not change what is on screen.
            // Keep the active presenter until wglDeleteContext — otherwise the GDI loop
            // would composite over the last GL frame between transient unbind/rebind pairs.
            Logger.verbose(LogCategory.GDI32, `wglMakeCurrent(0, 0) -> TRUE (unbind, keep active)`);
            return 1;
        }
        const binding = state.contexts.get(hglrc);
        if (!binding) {
            Logger.warn(LogCategory.GDI32, `wglMakeCurrent: invalid hglrc 0x${hglrc.toString(16)}`);
            return 0;
        }
        state.currentHglrc = hglrc;
        state.currentHdc = hdc;
        if (hdc) ctx.drawableDC = hdc;
        if (hdc && !binding.attached) {
            binding.attached = true;
            const size = drawableSize(hdc);
            adoptDrawableExtent(ctx, size.width, size.height);
        }

        // Lazily initialize OpenGL executor once WebGPU backend is available.
        if (!ctx.executor && ctx.backend) {
            ctx.executor = new OpenGLBackendExecutor(ctx.backend);
        }

        // Mark OpenGL presenter as active so generic GDI compositor does not
        // overwrite the frame while GL is presenting.
        if (ctx.presenter) {
            System.getInstance().services.render.setActive(ctx.presenter);
        }

        Logger.log(LogCategory.GDI32, `wglMakeCurrent(hdc=0x${hdc.toString(16)}, hglrc=0x${hglrc.toString(16)}) -> TRUE`);
        return 1;
    };

    exports['wglGetCurrentContext'] = (): number => state.currentHglrc;
    exports['wglGetCurrentDC'] = (): number => state.currentHdc;

    exports['wglShareLists'] = (_c, _m, args): number => {
        Logger.verbose(LogCategory.GDI32, `wglShareLists(0x${(args[0] >>> 0).toString(16)}, 0x${(args[1] >>> 0).toString(16)}) -> TRUE (stub)`);
        return 1;
    };

    exports['wglGetProcAddress'] = (_c, _m, args): number => {
        const namePtr = args[0] >>> 0;
        const mem = ctx.process.getCurrentMemory();
        let end = namePtr;
        while (mem[end]) end++;
        const name = new TextDecoder().decode(mem.subarray(namePtr, end));
        if (!name) return 0;

        // No current context => NULL, per the WGL contract (an entry point is only
        // meaningful for the pixel format/context it was queried against).
        if (!state.currentHglrc) {
            Logger.verbose(LogCategory.GDI32, `wglGetProcAddress("${name}") -> 0 (no current context)`);
            return 0;
        }

        // Our GL entry points are thunk stubs, not PE exports — resolve through the
        // same registry GetProcAddress uses so the two can never disagree. Extension
        // entry points are absent from the boot-time stub set, so this is also what
        // creates them on demand.
        const dispatcher = (ctx.process as any)?.dispatcher;
        const addr = resolveImplementedEntryPoint(dispatcher, name);
        if (addr) {
            Logger.verbose(LogCategory.GDI32, `wglGetProcAddress("${name}") -> 0x${addr.toString(16)}`);
            return addr;
        }

        // Map ARB extensions to core GL 1.3 functions
        const aliasMap: Record<string, string> = {
            'glActiveTextureARB': 'glActiveTexture',
            'glClientActiveTextureARB': 'glClientActiveTexture',
            'glMultiTexCoord1fARB': 'glMultiTexCoord1f',
            'glMultiTexCoord2fARB': 'glMultiTexCoord2f',
            'glMultiTexCoord3fARB': 'glMultiTexCoord3f',
            'glMultiTexCoord4fARB': 'glMultiTexCoord4f',
            'glMultiTexCoord2fvARB': 'glMultiTexCoord2fv',
            'glMultiTexCoord4fvARB': 'glMultiTexCoord4fv',
            'glCompressedTexImage1DARB': 'glCompressedTexImage1D',
            'glCompressedTexImage2DARB': 'glCompressedTexImage2D',
            'glCompressedTexImage3DARB': 'glCompressedTexImage3D',
            'glCompressedTexSubImage1DARB': 'glCompressedTexSubImage1D',
            'glCompressedTexSubImage2DARB': 'glCompressedTexSubImage2D',
            'glCompressedTexSubImage3DARB': 'glCompressedTexSubImage3D',
            'glGetCompressedTexImageARB': 'glGetCompressedTexImage',
        };

        const mapped = aliasMap[name];
        if (mapped && mapped !== name) {
            const mappedAddr = resolveImplementedEntryPoint(dispatcher, mapped);
            if (mappedAddr) {
                Logger.verbose(LogCategory.GDI32, `wglGetProcAddress("${name}") -> 0x${mappedAddr.toString(16)} (alias: ${mapped})`);
                return mappedAddr;
            }
        }

        Logger.verbose(LogCategory.GDI32, `wglGetProcAddress("${name}") -> 0 (not found)`);
        return 0;
    };

    exports['wglSwapBuffers'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        Logger.verbose(LogCategory.GDI32, `wglSwapBuffers(hdc=0x${hdc.toString(16)}) cmds=${ctx.commands.count} texs=${ctx.textures.size}`);
        // Present the frame
        if (ctx.presenter && typeof ctx.presenter.present === 'function') {
            ctx.presenter.present();
        }
        return 1;
    };

    exports['wglSwapLayerBuffers'] = (_c, _m, args): number => {
        // Same as SwapBuffers for our purposes
        if (ctx.presenter && typeof ctx.presenter.present === 'function') {
            ctx.presenter.present();
        }
        return 1;
    };

    // The wgl* pixel-format entry points are the SAME driver-side query gdi32's
    // Choose/Describe/Set/GetPixelFormat forward to on real Windows, so they share the
    // one implementation. Two copies of the PIXELFORMATDESCRIPTOR layout is exactly how
    // this one rotted: the gdi32 twin wrote green/blue/alpha at their real offsets while
    // this one dropped them into cAlphaShift/cAccumBits, publishing a 32-bit format with
    // zero green and blue for any engine that scored the table.
    exports['wglChoosePixelFormat'] = (_c, mem, args): number => {
        return chooseWglPixelFormat(mem, args[1] >>> 0);
    };

    exports['wglDescribePixelFormat'] = (_c, mem, args): number => {
        return describeWglPixelFormat(mem, args[1] | 0, args[2] >>> 0, args[3] >>> 0);
    };

    exports['wglSetPixelFormat'] = (_c, _m, args): number => {
        return setWglPixelFormat(args[0] >>> 0, args[1] | 0) ? 1 : 0;
    };

    exports['wglGetPixelFormat'] = (_c, _m, args): number => getWglPixelFormat(args[0] >>> 0);

    exports['wglCopyContext'] = (): number => 0;
    exports['wglCreateLayerContext'] = (_c, _m, args): number => {
        // Treat as regular context creation
        return exports['wglCreateContext']!(_c, _m, args) as number;
    };
    exports['wglDescribeLayerPlane'] = (): number => 0;
    exports['wglGetLayerPaletteEntries'] = (): number => 0;
    exports['wglRealizeLayerPalette'] = (): number => 0;
    exports['wglSetLayerPaletteEntries'] = (): number => 0;
    exports['wglUseFontBitmapsA'] = (): number => 1;
    exports['wglUseFontBitmapsW'] = (): number => 1;
    exports['wglUseFontOutlinesA'] = (): number => 1;
    exports['wglUseFontOutlinesW'] = (): number => 1;
    exports['wglSetDeviceGammaRamp'] = (_c, mem, args): number => {
        return gammaService.applyFromGuest(mem, args[1]) ? 1 : 0;
    };
    exports['wglGetDeviceGammaRamp'] = (_c, mem, args): number => {
        return gammaService.writeToGuest(mem, args[1]) ? 1 : 0;
    };

    // Only what has an entry point behind it. WGL_ARB_multisample was listed here
    // with no wglChoosePixelFormatARB/wglGetPixelFormatAttribivARB to query it and
    // no multisampled pixel format to find — a lenient caller resolves NULL and
    // calls address 0, a careful one enables an AA path we never render.
    // Both query functions exist, so both extensions are named. The string is written
    // once per process; callers query it every frame in some engines.
    const extensionsString = (): number => {
        if (state.extensionsString) return state.extensionsString;
        const bytes = new TextEncoder().encode("WGL_ARB_extensions_string WGL_EXT_extensions_string WGL_EXT_swap_control\0");
        const addr = ctx.process.memory.alloc(bytes.length) >>> 0;
        if (!addr) return 0;
        ctx.process.getCurrentMemory().set(bytes, addr);
        state.extensionsString = addr;
        return addr;
    };
    exports['wglGetExtensionsStringARB'] = (): number => extensionsString();
    // WGL_EXT_extensions_string: the same string, no HDC. Engines (Unity's GL renderer)
    // resolve it through wglGetProcAddress and call it without checking for NULL.
    exports['wglGetExtensionsStringEXT'] = (): number => extensionsString();
    // WGL_EXT_swap_control. Presentation follows the host's frame cadence whatever the
    // interval, so the value is only remembered and reported back; a negative interval
    // (adaptive vsync) needs WGL_EXT_swap_control_tear, which we do not advertise.
    exports['wglSwapIntervalEXT'] = (_c, _m, args): number => {
        const interval = args[0] | 0;
        if (interval < 0) {
            System.getInstance().scheduler.setLastError(13); // ERROR_INVALID_DATA, as the extension specifies
            return 0;
        }
        state.swapInterval = interval;
        return 1;
    };
    exports['wglGetSwapIntervalEXT'] = (): number => state.swapInterval >>> 0;

    return exports;
}
