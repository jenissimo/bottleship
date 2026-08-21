import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { OpenGLContext } from "./context";
import {
    GL_NO_ERROR, GL_VENDOR, GL_RENDERER, GL_VERSION, GL_EXTENSIONS,
    GL_MAX_TEXTURE_SIZE, GL_MAX_TEXTURE_UNITS, GL_MAX_MODELVIEW_STACK_DEPTH,
    GL_MAX_PROJECTION_STACK_DEPTH, GL_MAX_TEXTURE_STACK_DEPTH, GL_MAX_LIGHTS,
    GL_MAX_CLIP_PLANES, GL_MAX_VIEWPORT_DIMS, GL_MAX_ATTRIB_STACK_DEPTH,
    GL_MAX_CLIENT_ATTRIB_STACK_DEPTH, GL_MAX_ELEMENTS_VERTICES, GL_MAX_ELEMENTS_INDICES,
    GL_VIEWPORT, GL_DEPTH_BITS, GL_STENCIL_BITS,
    GL_DEPTH_RANGE, GL_DEPTH_TEST, GL_BLEND, GL_ALPHA_TEST, GL_CULL_FACE,
    GL_DEPTH_FUNC, GL_DEPTH_WRITEMASK, GL_BLEND_SRC, GL_BLEND_DST, GL_ALPHA_TEST_FUNC,
    GL_ALPHA_TEST_REF, GL_CULL_FACE_MODE, GL_FRONT_FACE, GL_SHADE_MODEL,
    GL_MODELVIEW_MATRIX, GL_PROJECTION_MATRIX, GL_TEXTURE_MATRIX,
    GL_MODELVIEW_STACK_DEPTH, GL_PROJECTION_STACK_DEPTH, GL_TEXTURE_STACK_DEPTH,
    GL_MATRIX_MODE, GL_ACTIVE_TEXTURE, GL_CLIENT_ACTIVE_TEXTURE,
    GL_TEXTURE_BINDING_2D, GL_COLOR_CLEAR_VALUE, GL_COLOR_WRITEMASK,
    GL_SCISSOR_BOX, GL_SCISSOR_TEST, GL_RGBA_MODE, GL_DOUBLEBUFFER,
    GL_UNPACK_ALIGNMENT, GL_PACK_ALIGNMENT, GL_FOG, GL_FOG_MODE, GL_FOG_DENSITY,
    GL_FOG_START, GL_FOG_END, GL_FOG_COLOR, GL_LIGHTING,
    GL_POLYGON_MODE, GL_LINE_WIDTH, GL_POINT_SIZE,
    GL_NUM_COMPRESSED_TEXTURE_FORMATS, GL_COMPRESSED_TEXTURE_FORMATS,
    GL_COMPRESSED_RGB_S3TC_DXT1_EXT, GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT3_EXT, GL_COMPRESSED_RGBA_S3TC_DXT5_EXT,
    GL_COMPRESSED_RED_RGTC1, GL_COMPRESSED_SIGNED_RED_RGTC1,
    GL_COMPRESSED_RG_RGTC2, GL_COMPRESSED_SIGNED_RG_RGTC2,
    GL_COMPRESSED_LUMINANCE_LATC1_EXT, GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT, GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT,
    GL_SAMPLE_BUFFERS, GL_SAMPLES,
    GL_TEXTURE0, GL_TRUE, GL_FALSE,
    GL_IMPL_MAX_TEXTURE_SIZE, GL_PROXY_TEXTURE_2D,
    GL_TEXTURE_ENV_MODE, GL_TEXTURE_ENV_COLOR,
    GL_COMBINE_RGB, GL_COMBINE_ALPHA, GL_RGB_SCALE, GL_ALPHA_SCALE,
    GL_SOURCE0_RGB, GL_SOURCE1_RGB, GL_SOURCE2_RGB,
    GL_SOURCE0_ALPHA, GL_SOURCE1_ALPHA, GL_SOURCE2_ALPHA,
    GL_OPERAND0_RGB, GL_OPERAND1_RGB, GL_OPERAND2_RGB,
    GL_OPERAND0_ALPHA, GL_OPERAND1_ALPHA, GL_OPERAND2_ALPHA,
    GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T, GL_TEXTURE_MIN_FILTER, GL_TEXTURE_MAG_FILTER,
    GL_TEXTURE_WIDTH, GL_TEXTURE_HEIGHT, GL_TEXTURE_DEPTH, GL_TEXTURE_INTERNAL_FORMAT,
    GL_TEXTURE_BORDER, GL_TEXTURE_RED_SIZE, GL_TEXTURE_GREEN_SIZE, GL_TEXTURE_BLUE_SIZE,
    GL_TEXTURE_ALPHA_SIZE, GL_TEXTURE_LUMINANCE_SIZE, GL_TEXTURE_INTENSITY_SIZE,
    GL_TEXTURE_COMPRESSED, GL_TEXTURE_COMPRESSED_IMAGE_SIZE,
    NAME_STACK_MAX_DEPTH,
} from "./constants";
import { Logger, LogCategory } from "../../core/logger";

const GL_RED_BITS = 0x0D52;
const GL_GREEN_BITS = 0x0D53;
const GL_BLUE_BITS = 0x0D54;
const GL_ALPHA_BITS = 0x0D55;
const GL_SUBPIXEL_BITS = 0x0D50;
const GL_INDEX_BITS = 0x0D51;
const GL_MAX_NAME_STACK_DEPTH = 0x0D37;
const GL_MAX_LIST_NESTING = 0x0B31;
const GL_AUX_BUFFERS = 0x0C00;
const GL_STEREO = 0x0C33;
const GL_RENDER_MODE = 0x0C40;
const GL_ACCUM_RED_BITS = 0x0D58;
const GL_ACCUM_GREEN_BITS = 0x0D59;
const GL_ACCUM_BLUE_BITS = 0x0D5A;
const GL_ACCUM_ALPHA_BITS = 0x0D5B;

const queryWarned = new Set<string>();
function warnOnceQuery(message: string): void {
    if (queryWarned.has(message)) return;
    queryWarned.add(message);
    Logger.warn(LogCategory.GDI32, `OpenGL query: ${message}`);
}
const COMPRESSED_TEXTURE_FORMATS = [
    GL_COMPRESSED_RGB_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT3_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT5_EXT,
    GL_COMPRESSED_RED_RGTC1,
    GL_COMPRESSED_SIGNED_RED_RGTC1,
    GL_COMPRESSED_RG_RGTC2,
    GL_COMPRESSED_SIGNED_RG_RGTC2,
    GL_COMPRESSED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT,
];

export function createQueryExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    function allocGuestString(str: string): number {
        const bytes = new TextEncoder().encode(str + "\0");
        const addr = ctx.process.memory.alloc(bytes.length);
        if (addr) {
            const mem = ctx.process.getCurrentMemory();
            for (let i = 0; i < bytes.length; i++) {
                mem[addr + i] = bytes[i];
            }
        }
        return addr;
    }

    exports['glGetError'] = (): number => {
        const err = ctx.error;
        ctx.error = GL_NO_ERROR;
        return err;
    };

    exports['glGetString'] = (_ctx, _mem, args): number => {
        const name = args[0] >>> 0;
        const cached = ctx.stringCache.get(name);
        if (cached) return cached;

        let str: string;
        switch (name) {
            case GL_VENDOR: str = "BottleShip"; break;
            case GL_RENDERER: str = "BottleShip WebGPU"; break;
            case GL_VERSION: str = "1.3.0"; break;
            case GL_EXTENSIONS:
                // Every name here must have code behind it — an engine reads this string
                // to CHOOSE A RENDERING PATH, and one it believes in makes it discard the
                // fallback it would otherwise have drawn correctly.
                //
                // combine/dot3 are published in both spellings deliberately: EXT_ and
                // ARB_texture_env_combine share every token value, and Quake3-lineage
                // engines only ever look for the EXT name. env_add is the GL_ADD texture
                // env mode (applyTexEnv), also spelled both ways by different engines.
                str = [
                    "GL_ARB_multitexture",
                    "GL_EXT_compiled_vertex_array",
                    "GL_ARB_texture_env_add",
                    "GL_EXT_texture_env_add",
                    "GL_ARB_texture_env_combine",
                    "GL_EXT_texture_env_combine",
                    "GL_ARB_texture_env_dot3",
                    "GL_EXT_texture_env_dot3",
                    "GL_ARB_texture_compression",
                    "GL_EXT_texture_compression_s3tc",
                    "GL_ARB_texture_compression_rgtc",
                    "GL_EXT_texture_compression_latc",
                ].join(" ");
                break;
            default: return 0;
        }

        const addr = allocGuestString(str);
        ctx.stringCache.set(name, addr);
        return addr;
    };

    exports['glGetIntegerv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const writeInt = (v: number) => Mem.writeUint32(ptr, v);
        const writeInts = (vals: number[]) => { for (let i = 0; i < vals.length; i++) Mem.writeUint32(ptr + i * 4, vals[i]); };

        switch (pname) {
            case GL_MAX_TEXTURE_SIZE: writeInt(GL_IMPL_MAX_TEXTURE_SIZE); break;
            case GL_MAX_TEXTURE_UNITS: writeInt(2); break;
            // GL 1.3 mandates a floor for these; 0 is not a legal answer and an engine
            // that sizes a stack or a rasteriser tolerance from it gets a value no
            // conformant driver could return.
            case GL_SUBPIXEL_BITS: writeInt(4); break;
            case GL_MAX_NAME_STACK_DEPTH: writeInt(NAME_STACK_MAX_DEPTH); break;
            case GL_MAX_LIST_NESTING: writeInt(64); break;
            // Genuinely absent, and 0 is the correct way to say so.
            case GL_AUX_BUFFERS: writeInt(0); break;
            case GL_INDEX_BITS: writeInt(0); break;
            case GL_STEREO: writeInt(0); break;
            case GL_ACCUM_RED_BITS: case GL_ACCUM_GREEN_BITS:
            case GL_ACCUM_BLUE_BITS: case GL_ACCUM_ALPHA_BITS: writeInt(0); break;
            case GL_RENDER_MODE: writeInt(ctx.renderMode); break;
            case GL_MAX_MODELVIEW_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_PROJECTION_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_TEXTURE_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_LIGHTS: writeInt(8); break;
            case GL_MAX_CLIP_PLANES: writeInt(6); break;
            case GL_MAX_VIEWPORT_DIMS: writeInts([4096, 4096]); break;
            case GL_MAX_ATTRIB_STACK_DEPTH: writeInt(16); break;
            case GL_MAX_CLIENT_ATTRIB_STACK_DEPTH: writeInt(16); break;
            case GL_MAX_ELEMENTS_VERTICES: writeInt(65536); break;
            case GL_MAX_ELEMENTS_INDICES: writeInt(65536); break;
            case GL_VIEWPORT: writeInts([ctx.viewportX, ctx.viewportY, ctx.viewportW, ctx.viewportH]); break;
            case GL_SCISSOR_BOX: writeInts([ctx.scissorX, ctx.scissorY, ctx.scissorW, ctx.scissorH]); break;
            case GL_DEPTH_BITS: writeInt(24); break;
            case GL_STENCIL_BITS: writeInt(8); break;
            case GL_RED_BITS: writeInt(8); break;
            case GL_GREEN_BITS: writeInt(8); break;
            case GL_BLUE_BITS: writeInt(8); break;
            case GL_ALPHA_BITS: writeInt(8); break;
            case GL_DEPTH_FUNC: writeInt(ctx.depthFunc); break;
            case GL_DEPTH_WRITEMASK: writeInt(ctx.depthMask ? 1 : 0); break;
            case GL_BLEND_SRC: writeInt(ctx.blendSrc); break;
            case GL_BLEND_DST: writeInt(ctx.blendDst); break;
            case GL_ALPHA_TEST_FUNC: writeInt(ctx.alphaFunc); break;
            case GL_CULL_FACE_MODE: writeInt(ctx.cullFace); break;
            case GL_FRONT_FACE: writeInt(ctx.frontFace); break;
            case GL_SHADE_MODEL: writeInt(ctx.shadeModel); break;
            case GL_MATRIX_MODE: writeInt(ctx.matrixMode); break;
            case GL_ACTIVE_TEXTURE: writeInt(GL_TEXTURE0 + ctx.activeTextureUnit); break;
            case GL_CLIENT_ACTIVE_TEXTURE: writeInt(GL_TEXTURE0 + ctx.clientActiveTextureUnit); break;
            case GL_TEXTURE_BINDING_2D: writeInt(ctx.textureUnits[ctx.activeTextureUnit].boundTexture); break;
            case GL_MODELVIEW_STACK_DEPTH: writeInt(ctx.modelviewStack.top + 1); break;
            case GL_PROJECTION_STACK_DEPTH: writeInt(ctx.projectionStack.top + 1); break;
            case GL_TEXTURE_STACK_DEPTH: writeInt(ctx.textureStack.top + 1); break;
            case GL_COLOR_WRITEMASK: writeInts([ctx.colorMaskR ? 1 : 0, ctx.colorMaskG ? 1 : 0, ctx.colorMaskB ? 1 : 0, ctx.colorMaskA ? 1 : 0]); break;
            case GL_UNPACK_ALIGNMENT: writeInt(ctx.unpackAlignment); break;
            case GL_PACK_ALIGNMENT: writeInt(ctx.packAlignment); break;
            case GL_FOG_MODE: writeInt(ctx.fogMode); break;
            case GL_POLYGON_MODE: writeInts([ctx.polygonModeFront, ctx.polygonModeBack]); break;
            case GL_RGBA_MODE: writeInt(1); break;
            case GL_DOUBLEBUFFER: writeInt(1); break;
            case GL_NUM_COMPRESSED_TEXTURE_FORMATS: writeInt(COMPRESSED_TEXTURE_FORMATS.length); break;
            case GL_COMPRESSED_TEXTURE_FORMATS: writeInts(COMPRESSED_TEXTURE_FORMATS); break;
            case GL_SAMPLE_BUFFERS: writeInt(0); break;
            case GL_SAMPLES: writeInt(0); break;
            default:
                // 0 is a real answer for some pnames and a wrong one for others, and the
                // caller cannot tell which it got. Name the pname so the next one that
                // matters gets a real entry above instead of a silent zero.
                warnOnceQuery(`glGetIntegerv(0x${pname.toString(16)}) unhandled -> 0`);
                writeInt(0);
                break;
        }
        return 0;
    };

    exports['glGetFloatv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const writeF32 = (v: number) => view.setFloat32(ptr, v, true);
        const writeF32s = (vals: ArrayLike<number>) => { for (let i = 0; i < vals.length; i++) view.setFloat32(ptr + i * 4, vals[i], true); };

        switch (pname) {
            case GL_MODELVIEW_MATRIX: writeF32s(ctx.modelviewStack.stack[ctx.modelviewStack.top]); break;
            case GL_PROJECTION_MATRIX: writeF32s(ctx.projectionStack.stack[ctx.projectionStack.top]); break;
            case GL_TEXTURE_MATRIX: writeF32s(ctx.textureStack.stack[ctx.textureStack.top]); break;
            case GL_DEPTH_RANGE: writeF32s([ctx.depthRangeNear, ctx.depthRangeFar]); break;
            case GL_COLOR_CLEAR_VALUE: writeF32s([ctx.clearR, ctx.clearG, ctx.clearB, ctx.clearA]); break;
            case GL_ALPHA_TEST_REF: writeF32(ctx.alphaRef); break;
            case GL_FOG_DENSITY: writeF32(ctx.fogDensity); break;
            case GL_FOG_START: writeF32(ctx.fogStart); break;
            case GL_FOG_END: writeF32(ctx.fogEnd); break;
            case GL_FOG_COLOR: writeF32s(ctx.fogColor); break;
            case GL_LINE_WIDTH: writeF32(ctx.lineWidth); break;
            case GL_POINT_SIZE: writeF32(ctx.pointSize); break;
            default: writeF32(0); break;
        }
        return 0;
    };

    exports['glGetDoublev'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const writeF64 = (v: number) => view.setFloat64(ptr, v, true);

        switch (pname) {
            case GL_MODELVIEW_MATRIX: {
                const m = ctx.modelviewStack.stack[ctx.modelviewStack.top];
                for (let j = 0; j < 16; j++) view.setFloat64(ptr + j * 8, m[j], true);
                break;
            }
            case GL_PROJECTION_MATRIX: {
                const m = ctx.projectionStack.stack[ctx.projectionStack.top];
                for (let j = 0; j < 16; j++) view.setFloat64(ptr + j * 8, m[j], true);
                break;
            }
            case GL_DEPTH_RANGE:
                view.setFloat64(ptr, ctx.depthRangeNear, true);
                view.setFloat64(ptr + 8, ctx.depthRangeFar, true);
                break;
            default: writeF64(0); break;
        }
        return 0;
    };

    exports['glGetBooleanv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        let val = 0;
        switch (pname) {
            case GL_DEPTH_TEST: val = ctx.enableFlags.has(GL_DEPTH_TEST) ? 1 : 0; break;
            case GL_BLEND: val = ctx.enableFlags.has(GL_BLEND) ? 1 : 0; break;
            case GL_ALPHA_TEST: val = ctx.enableFlags.has(GL_ALPHA_TEST) ? 1 : 0; break;
            case GL_CULL_FACE: val = ctx.enableFlags.has(GL_CULL_FACE) ? 1 : 0; break;
            case GL_SCISSOR_TEST: val = ctx.enableFlags.has(GL_SCISSOR_TEST) ? 1 : 0; break;
            case GL_FOG: val = ctx.enableFlags.has(GL_FOG) ? 1 : 0; break;
            case GL_LIGHTING: val = ctx.enableFlags.has(GL_LIGHTING) ? 1 : 0; break;
            case GL_DEPTH_WRITEMASK: val = ctx.depthMask ? 1 : 0; break;
            case GL_DOUBLEBUFFER: val = 1; break;
            case GL_RGBA_MODE: val = 1; break;
        }
        const mem = ctx.process.getCurrentMemory();
        mem[ptr] = val;
        return 0;
    };

    exports['glFinish'] = (): number => 0;
    exports['glFlush'] = (): number => 0;

    exports['glIsTexture'] = (_ctx, _mem, args): number => {
        return ctx.textures.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    exports['glIsList'] = (_ctx, _mem, args): number => {
        return ctx.displayLists.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    exports['glIsEnabled'] = (_ctx, _mem, args): number => {
        return ctx.enableFlags.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    // ---- Getters ----
    //
    // A getter that returns without writing *ppfd leaves the caller reading its own
    // uninitialized stack slot, so the same query answers differently run to run. Any
    // getter still stubbed below writes nothing on purpose ONLY where no caller has been
    // observed; the ones an engine uses to decide something are implemented.

    /** GL_TEXTURE_ENV state of the active unit (both spellings share the enums). */
    function texEnvValue(pname: number): number | number[] | null {
        const unit = ctx.textureUnits[ctx.activeTextureUnit];
        switch (pname) {
            case GL_TEXTURE_ENV_MODE: return unit.texEnvMode;
            case GL_TEXTURE_ENV_COLOR: return [unit.envColor[0], unit.envColor[1], unit.envColor[2], unit.envColor[3]];
            case GL_COMBINE_RGB: return unit.combineRgb;
            case GL_COMBINE_ALPHA: return unit.combineAlpha;
            case GL_SOURCE0_RGB: return unit.srcRgb[0];
            case GL_SOURCE1_RGB: return unit.srcRgb[1];
            case GL_SOURCE2_RGB: return unit.srcRgb[2];
            case GL_SOURCE0_ALPHA: return unit.srcAlpha[0];
            case GL_SOURCE1_ALPHA: return unit.srcAlpha[1];
            case GL_SOURCE2_ALPHA: return unit.srcAlpha[2];
            case GL_OPERAND0_RGB: return unit.opRgb[0];
            case GL_OPERAND1_RGB: return unit.opRgb[1];
            case GL_OPERAND2_RGB: return unit.opRgb[2];
            case GL_OPERAND0_ALPHA: return unit.opAlpha[0];
            case GL_OPERAND1_ALPHA: return unit.opAlpha[1];
            case GL_OPERAND2_ALPHA: return unit.opAlpha[2];
            case GL_RGB_SCALE: return unit.rgbScale;
            case GL_ALPHA_SCALE: return unit.alphaScale;
            default: return null;
        }
    }

    exports['glGetTexEnvfv'] = (_ctx, _mem, args): number => {
        const ptr = args[2] >>> 0;
        if (!ptr) return 0;
        const v = texEnvValue(args[1] >>> 0);
        if (v === null) { warnOnceQuery(`glGetTexEnvfv(0x${(args[1] >>> 0).toString(16)}) unhandled`); return 0; }
        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) view.setFloat32(ptr + i * 4, v[i], true); }
        else view.setFloat32(ptr, v, true);
        return 0;
    };

    exports['glGetTexEnviv'] = (_ctx, _mem, args): number => {
        const ptr = args[2] >>> 0;
        if (!ptr) return 0;
        const v = texEnvValue(args[1] >>> 0);
        if (v === null) { warnOnceQuery(`glGetTexEnviv(0x${(args[1] >>> 0).toString(16)}) unhandled`); return 0; }
        if (Array.isArray(v)) {
            // Colour components come back scaled to the full int range (GL 1.3 §6.1.2).
            for (let i = 0; i < v.length; i++) Mem.writeUint32(ptr + i * 4, Math.round(v[i] * 2147483647) | 0);
        } else Mem.writeUint32(ptr, v | 0);
        return 0;
    };

    exports['glGetLightfv'] = (): number => 0;
    exports['glGetLightiv'] = (): number => 0;
    exports['glGetMaterialfv'] = (): number => 0;
    exports['glGetMaterialiv'] = (): number => 0;

    function texParameterValue(pname: number): number | null {
        const tex = ctx.textures.get(ctx.textureUnits[ctx.activeTextureUnit].boundTexture);
        if (!tex) return null;
        switch (pname) {
            case GL_TEXTURE_WRAP_S: return tex.wrapS;
            case GL_TEXTURE_WRAP_T: return tex.wrapT;
            case GL_TEXTURE_MIN_FILTER: return tex.minFilter;
            case GL_TEXTURE_MAG_FILTER: return tex.magFilter;
            default: return null;
        }
    }

    exports['glGetTexParameterfv'] = (_ctx, _mem, args): number => {
        const ptr = args[2] >>> 0;
        const v = texParameterValue(args[1] >>> 0);
        if (!ptr || v === null) return 0;
        const mem = ctx.process.getCurrentMemory();
        new DataView(mem.buffer, mem.byteOffset).setFloat32(ptr, v, true);
        return 0;
    };

    exports['glGetTexParameteriv'] = (_ctx, _mem, args): number => {
        const ptr = args[2] >>> 0;
        const v = texParameterValue(args[1] >>> 0);
        if (!ptr || v === null) return 0;
        Mem.writeUint32(ptr, v | 0);
        return 0;
    };

    /**
     * glGetTexLevelParameter — for GL_PROXY_TEXTURE_2D this is the OTHER half of the
     * "will this texture fit?" probe: the proxy glTexImage2D records the verdict and
     * this reads it back. Answering 0 without writing left the verdict as whatever was
     * on the caller's stack, so a format probe was nondeterministic.
     */
    function texLevelValue(target: number, level: number, pname: number): number | null {
        let width: number, height: number, internalFormat: number;
        if (target === GL_PROXY_TEXTURE_2D) {
            width = ctx.proxyTextureWidth;
            height = ctx.proxyTextureHeight;
            internalFormat = ctx.proxyTextureInternalFormat;
        } else {
            const tex = ctx.textures.get(ctx.textureUnits[ctx.activeTextureUnit].boundTexture);
            if (!tex || level !== 0) return 0;
            width = tex.width; height = tex.height; internalFormat = tex.internalFormat;
        }
        const present = width > 0 && height > 0;
        switch (pname) {
            case GL_TEXTURE_WIDTH: return width;
            case GL_TEXTURE_HEIGHT: return height;
            case GL_TEXTURE_DEPTH: return present ? 1 : 0;
            case GL_TEXTURE_INTERNAL_FORMAT: return internalFormat;
            case GL_TEXTURE_BORDER: return 0;
            // We decompress on upload and store RGBA8, so the component sizes a caller
            // sees are the ones it will actually sample.
            case GL_TEXTURE_RED_SIZE: case GL_TEXTURE_GREEN_SIZE:
            case GL_TEXTURE_BLUE_SIZE: case GL_TEXTURE_ALPHA_SIZE: return present ? 8 : 0;
            case GL_TEXTURE_LUMINANCE_SIZE: case GL_TEXTURE_INTENSITY_SIZE: return 0;
            case GL_TEXTURE_COMPRESSED: return GL_FALSE;
            case GL_TEXTURE_COMPRESSED_IMAGE_SIZE: return width * height * 4;
            default: return null;
        }
    }

    exports['glGetTexLevelParameterfv'] = (_ctx, _mem, args): number => {
        const ptr = args[3] >>> 0;
        const v = texLevelValue(args[0] >>> 0, args[1] | 0, args[2] >>> 0);
        if (!ptr || v === null) return 0;
        const mem = ctx.process.getCurrentMemory();
        new DataView(mem.buffer, mem.byteOffset).setFloat32(ptr, v, true);
        return 0;
    };

    exports['glGetTexLevelParameteriv'] = (_ctx, _mem, args): number => {
        const ptr = args[3] >>> 0;
        const v = texLevelValue(args[0] >>> 0, args[1] | 0, args[2] >>> 0);
        if (!ptr || v === null) return 0;
        Mem.writeUint32(ptr, v | 0);
        return 0;
    };

    exports['glGetTexImage'] = (): number => 0;
    exports['glGetPointerv'] = (): number => 0;
    exports['glAreTexturesResident'] = (): number => GL_TRUE;

    return exports;
}
