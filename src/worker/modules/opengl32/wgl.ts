import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { OpenGLContext } from "./context";
import { Logger, LogCategory } from "../../core/logger";
import { OpenGLBackendExecutor } from "../../backends/webgpu/opengl/opengl-backend-executor";
import { System } from "../../core/system";
import { gammaService } from "../../core/gamma-service";

interface WGLContextBinding {
    hglrc: number;
    hdc: number;
}

export function createWglExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    let nextHglrc = 1;
    const contexts = new Map<number, { hdc: number }>();
    const threadBindings = new Map<number, WGLContextBinding>(); // threadId -> binding
    let currentHglrc = 0;
    let currentHdc = 0;

    exports['wglCreateContext'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        const hglrc = nextHglrc++;
        contexts.set(hglrc, { hdc });
        Logger.log(LogCategory.GDI32, `wglCreateContext(hdc=0x${hdc.toString(16)}) -> 0x${hglrc.toString(16)}`);
        return hglrc;
    };

    exports['wglDeleteContext'] = (_c, _m, args): number => {
        const hglrc = args[0] >>> 0;
        if (currentHglrc === hglrc) {
            currentHglrc = 0;
            currentHdc = 0;
            const system = System.getInstance();
            if (system.services.render.getActive() === ctx.presenter) {
                system.services.render.setActive(null);
            }
        }
        contexts.delete(hglrc);
        Logger.log(LogCategory.GDI32, `wglDeleteContext(0x${hglrc.toString(16)}) -> TRUE`);
        return 1;
    };

    exports['wglMakeCurrent'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        const hglrc = args[1] >>> 0;
        if (hglrc === 0) {
            currentHglrc = 0;
            currentHdc = 0;
            // wglMakeCurrent(NULL, NULL) unbinds but does not change what is on screen.
            // Keep the active presenter until wglDeleteContext — otherwise the GDI loop
            // would composite over the last GL frame between transient unbind/rebind pairs.
            Logger.verbose(LogCategory.GDI32, `wglMakeCurrent(0, 0) -> TRUE (unbind, keep active)`);
            return 1;
        }
        if (!contexts.has(hglrc)) {
            Logger.warn(LogCategory.GDI32, `wglMakeCurrent: invalid hglrc 0x${hglrc.toString(16)}`);
            return 0;
        }
        currentHglrc = hglrc;
        currentHdc = hdc;

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

    exports['wglGetCurrentContext'] = (): number => currentHglrc;
    exports['wglGetCurrentDC'] = (): number => currentHdc;

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

        // Try to find in module registry
        const addr = ctx.process.moduleRegistry?.getExportAddress("opengl32", name) ?? 0;
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
            'glLockArraysEXT': 'glLockArraysEXT',
            'glUnlockArraysEXT': 'glUnlockArraysEXT',
            'wglGetExtensionsStringARB': 'wglGetExtensionsStringARB',
        };

        const mapped = aliasMap[name];
        if (mapped) {
            const mappedAddr = ctx.process.moduleRegistry?.getExportAddress("opengl32", mapped) ?? 0;
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

    exports['wglChoosePixelFormat'] = (_c, _m, args): number => {
        return 1; // Return format index 1
    };

    exports['wglDescribePixelFormat'] = (_c, _m, args): number => {
        const hdc = args[0] >>> 0;
        const pixelFormat = args[1] | 0;
        const nBytes = args[2] >>> 0;
        const ppfd = args[3] >>> 0;

        if (ppfd && nBytes >= 40) {
            // PIXELFORMATDESCRIPTOR is 40 bytes
            const mem = ctx.process.getCurrentMemory();
            const view = new DataView(mem.buffer, mem.byteOffset);
            view.setUint16(ppfd + 0, 40, true);      // nSize
            view.setUint16(ppfd + 2, 1, true);        // nVersion
            view.setUint32(ppfd + 4, 0x25, true);     // dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER
            view.setUint8(ppfd + 8, 0);               // iPixelType: PFD_TYPE_RGBA
            view.setUint8(ppfd + 9, 32);              // cColorBits
            view.setUint8(ppfd + 10, 8);              // cRedBits
            view.setUint8(ppfd + 17, 8);              // cGreenBits
            view.setUint8(ppfd + 18, 8);              // cBlueBits
            view.setUint8(ppfd + 19, 8);              // cAlphaBits
            view.setUint8(ppfd + 23, 24);             // cDepthBits
            view.setUint8(ppfd + 24, 8);              // cStencilBits
        }
        return 1; // Number of pixel formats
    };

    exports['wglSetPixelFormat'] = (_c, _m, args): number => {
        return 1; // TRUE
    };

    exports['wglGetPixelFormat'] = (): number => 1;

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

    exports['wglGetExtensionsStringARB'] = (_c, _m, args): number => {
        const str = "WGL_ARB_extensions_string WGL_ARB_multisample";
        const addr = ctx.process.memory.alloc(str.length + 1);
        if (addr) {
            const bytes = new TextEncoder().encode(str + "\0");
            const mem = ctx.process.getCurrentMemory();
            for (let i = 0; i < bytes.length; i++) mem[addr + i] = bytes[i];
        }
        return addr;
    };

    return exports;
}
