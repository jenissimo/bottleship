/**
 * OpenGL 1.3 state management functions.
 * Each function follows (ctx, mem, args) => number pattern (ThunkImplementation).
 */

import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import {
    OpenGLContext, GLDrawCommandType, GLTexGenState, mat4Multiply, VERT_FLOATS,
    CMD_I32, CMD_F32,
    CI_MODE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, CI_DEPTH_FUNC, CI_BLEND_SRC, CI_BLEND_DST,
    CI_ALPHA_FUNC, CI_CULL_FACE, CI_FRONT_FACE, CI_TEX_ID0, CI_TEX_ID1, CI_TEXENV0, CI_TEXENV1,
    CI_SHADE_MODEL, CI_FOG_MODE, CI_POLYGON_MODE, CI_STENCIL_FUNC, CI_STENCIL_REF, CI_STENCIL_MASK,
    CI_STENCIL_FAIL, CI_STENCIL_ZFAIL, CI_STENCIL_ZPASS, CI_STENCIL_WRITE_MASK,
    CI_SCISSOR_X, CI_SCISSOR_Y, CI_SCISSOR_W, CI_SCISSOR_H, CI_VP_X, CI_VP_Y, CI_VP_W, CI_VP_H,
    CI_CLEAR_MASK, CI_CLEAR_STENCIL,
    CF_ALPHA_REF, CF_FOG_R, CF_FOG_G, CF_FOG_B, CF_FOG_A, CF_FOG_DENSITY, CF_FOG_START, CF_FOG_END,
    CF_DEPTH_RANGE_NEAR, CF_DEPTH_RANGE_FAR,
    CI_COMBINE0_RGB, CI_COMBINE0_ALPHA, CI_COMBINE1_RGB, CI_COMBINE1_ALPHA,
    CF_ENV_COLOR0, CF_ENV_COLOR1, COMBINER_WORD_DEFAULT,
    CF_CLEAR_R, CF_CLEAR_G, CF_CLEAR_B, CF_CLEAR_A, CF_CLEAR_DEPTH,
    DF_BLEND, DF_COLOR_MASK_R, DF_COLOR_MASK_G, DF_COLOR_MASK_B, DF_COLOR_MASK_A, DF_SCISSOR,
} from "./context";
import {
    GL_RGBA, GL_RGB, GL_BGR, GL_BGRA, GL_UNSIGNED_BYTE, GL_QUADS, GL_COLOR_BUFFER_BIT, GL_TRIANGLES,
    GL_NO_ERROR, GL_INVALID_ENUM, GL_INVALID_VALUE,
    GL_DEPTH_TEST, GL_BLEND, GL_ALPHA_TEST, GL_CULL_FACE, GL_TEXTURE_2D,
    GL_FOG, GL_SCISSOR_TEST, GL_LIGHTING, GL_LIGHT0,
    GL_NORMALIZE, GL_COLOR_MATERIAL, GL_LINE_SMOOTH, GL_POINT_SMOOTH,
    GL_POLYGON_SMOOTH, GL_POLYGON_OFFSET_FILL, GL_POLYGON_OFFSET_LINE,
    GL_POLYGON_OFFSET_POINT, GL_STENCIL_TEST, GL_DITHER, GL_MULTISAMPLE,
    GL_TEXTURE0,
    GL_FOG_MODE, GL_FOG_DENSITY, GL_FOG_START, GL_FOG_END, GL_FOG_COLOR,
    GL_LIGHT_MODEL_AMBIENT, GL_LIGHT_MODEL_TWO_SIDE,
    GL_LIGHT_MODEL_LOCAL_VIEWER, GL_LIGHT_MODEL_COLOR_CONTROL,
    GL_AMBIENT, GL_DIFFUSE, GL_SPECULAR, GL_POSITION,
    GL_SPOT_DIRECTION, GL_SPOT_EXPONENT, GL_SPOT_CUTOFF,
    GL_CONSTANT_ATTENUATION, GL_LINEAR_ATTENUATION, GL_QUADRATIC_ATTENUATION,
    GL_SHININESS, GL_EMISSION, GL_AMBIENT_AND_DIFFUSE,
    GL_FRONT, GL_BACK, GL_FRONT_AND_BACK,
    GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_TEXTURE_ENV_COLOR,
    GL_COMBINE_RGB, GL_COMBINE_ALPHA, GL_RGB_SCALE, GL_ALPHA_SCALE,
    GL_SOURCE0_RGB, GL_SOURCE1_RGB, GL_SOURCE2_RGB,
    GL_SOURCE0_ALPHA, GL_SOURCE1_ALPHA, GL_SOURCE2_ALPHA,
    GL_OPERAND0_RGB, GL_OPERAND1_RGB, GL_OPERAND2_RGB,
    GL_OPERAND0_ALPHA, GL_OPERAND1_ALPHA, GL_OPERAND2_ALPHA,
    GL_COLOR_LOGIC_OP, GL_LINE_STIPPLE, GL_RESCALE_NORMAL,
    GL_TEXTURE_GEN_S, GL_TEXTURE_GEN_T, GL_TEXTURE_GEN_R, GL_TEXTURE_GEN_Q,
    GL_SAMPLE_ALPHA_TO_COVERAGE, GL_SAMPLE_COVERAGE,
    GL_RENDER, GL_SELECT, GL_FEEDBACK, GL_INVALID_OPERATION,
    GL_STACK_OVERFLOW, GL_STACK_UNDERFLOW, NAME_STACK_MAX_DEPTH,
    GL_CLIP_PLANE0, GL_CLIP_PLANE5,
    GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_PIXELS,
    GL_UNPACK_SKIP_ROWS, GL_PACK_ALIGNMENT,
    GL_S, GL_T, GL_R, GL_Q,
    GL_TEXTURE_GEN_MODE, GL_OBJECT_PLANE, GL_EYE_PLANE,
    GL_OBJECT_LINEAR, GL_EYE_LINEAR, GL_SPHERE_MAP,
    GL_NORMAL_MAP, GL_REFLECTION_MAP,
} from "./constants";
import { Logger, LogCategory } from "../../core/logger";
import { Mem } from "../../core/memory/mem-accessor";
import { isValidAddress } from "../../core/memory/address-guard";
import { convertPixelsToRGBA8 } from "./texture";
import { arenaReserve } from "./immediate";

// ---- Helpers ----

const _f32ab = new ArrayBuffer(4);
const _f32dv = new DataView(_f32ab);

function bitsToF32(bits: number): number {
    _f32dv.setUint32(0, bits >>> 0, true);
    return _f32dv.getFloat32(0, true);
}

const _f64ab = new ArrayBuffer(8);
const _f64dv = new DataView(_f64ab);

function bitsToF64(lo: number, hi: number): number {
    _f64dv.setUint32(0, lo >>> 0, true);
    _f64dv.setUint32(4, hi >>> 0, true);
    return _f64dv.getFloat64(0, true);
}

const warned = new Set<string>();
function stubWarn(name: string): number {
    if (!warned.has(name)) {
        warned.add(name);
        Logger.warn(LogCategory.GDI32, `OpenGL stub: ${name}`);
    }
    return 0;
}

/**
 * One scalar glTexEnv{i,f} parameter. The float and integer entry points differ only
 * in how the guest spelled the value, so both land here: an enum is the truncated
 * value, a scale is the value itself.
 */
function setTexEnvParam(ctx: OpenGLContext, target: number, pname: number, value: number): void {
    if (target !== GL_TEXTURE_ENV) return;
    const unit = ctx.textureUnits[ctx.activeTextureUnit];
    const e = value | 0;
    switch (pname) {
        case GL_TEXTURE_ENV_MODE: unit.texEnvMode = e; break;
        case GL_COMBINE_RGB: unit.combineRgb = e; break;
        case GL_COMBINE_ALPHA: unit.combineAlpha = e; break;
        case GL_SOURCE0_RGB: unit.srcRgb[0] = e; break;
        case GL_SOURCE1_RGB: unit.srcRgb[1] = e; break;
        case GL_SOURCE2_RGB: unit.srcRgb[2] = e; break;
        case GL_SOURCE0_ALPHA: unit.srcAlpha[0] = e; break;
        case GL_SOURCE1_ALPHA: unit.srcAlpha[1] = e; break;
        case GL_SOURCE2_ALPHA: unit.srcAlpha[2] = e; break;
        case GL_OPERAND0_RGB: unit.opRgb[0] = e; break;
        case GL_OPERAND1_RGB: unit.opRgb[1] = e; break;
        case GL_OPERAND2_RGB: unit.opRgb[2] = e; break;
        case GL_OPERAND0_ALPHA: unit.opAlpha[0] = e; break;
        case GL_OPERAND1_ALPHA: unit.opAlpha[1] = e; break;
        case GL_OPERAND2_ALPHA: unit.opAlpha[2] = e; break;
        case GL_RGB_SCALE: unit.rgbScale = value; break;
        case GL_ALPHA_SCALE: unit.alphaScale = value; break;
        default: break;
    }
}

function readF32(mem: Uint8Array, ptr: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset);
    return view.getFloat32(ptr, true);
}

function readU32(mem: Uint8Array, ptr: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset);
    return view.getUint32(ptr, true);
}

function readF32x4(mem: Uint8Array, ptr: number, out: Float32Array): void {
    const view = new DataView(mem.buffer, mem.byteOffset);
    out[0] = view.getFloat32(ptr, true);
    out[1] = view.getFloat32(ptr + 4, true);
    out[2] = view.getFloat32(ptr + 8, true);
    out[3] = view.getFloat32(ptr + 12, true);
}

function readF32x3(mem: Uint8Array, ptr: number, out: Float32Array): void {
    const view = new DataView(mem.buffer, mem.byteOffset);
    out[0] = view.getFloat32(ptr, true);
    out[1] = view.getFloat32(ptr + 4, true);
    out[2] = view.getFloat32(ptr + 8, true);
}

function getTexGenState(ctx: OpenGLContext, coord: number): GLTexGenState | null {
    switch (coord) {
        case GL_S: return ctx.texGenS;
        case GL_T: return ctx.texGenT;
        case GL_R: return ctx.texGenR;
        case GL_Q: return ctx.texGenQ;
        default: return null;
    }
}

// ---- Known enable caps ----

const KNOWN_CAPS = new Set<number>([
    GL_DEPTH_TEST, GL_BLEND, GL_ALPHA_TEST, GL_CULL_FACE, GL_TEXTURE_2D,
    GL_FOG, GL_SCISSOR_TEST, GL_LIGHTING, GL_NORMALIZE, GL_COLOR_MATERIAL,
    GL_LINE_SMOOTH, GL_POINT_SMOOTH, GL_POLYGON_SMOOTH,
    GL_POLYGON_OFFSET_FILL, GL_POLYGON_OFFSET_LINE, GL_POLYGON_OFFSET_POINT,
    GL_STENCIL_TEST, GL_DITHER, GL_MULTISAMPLE, GL_COLOR_LOGIC_OP,
    GL_LINE_STIPPLE, GL_RESCALE_NORMAL,
    GL_TEXTURE_GEN_S, GL_TEXTURE_GEN_T, GL_TEXTURE_GEN_R, GL_TEXTURE_GEN_Q,
    GL_SAMPLE_ALPHA_TO_COVERAGE, GL_SAMPLE_COVERAGE,
]);

// GL_LIGHT0..GL_LIGHT7
for (let i = 0; i < 8; i++) KNOWN_CAPS.add(GL_LIGHT0 + i);

// ---- Export factory ----

/**
 * A scissored glClear(GL_COLOR_BUFFER_BIT) as a solid quad over the scissor rect.
 * WebGPU can only clear a whole attachment via loadOp, so the region has to be drawn.
 * The quad carries the CLEAR's semantics, not the app's current draw state: no blending,
 * no depth test or write, no alpha test, no cull, no texture — only the colour mask,
 * which glClear does honour. Viewport = the scissor rect, so clip-space -1..1 covers
 * exactly the region GL would have cleared.
 */
function emitScissorColorClear(ctx: OpenGLContext): void {
    const base = arenaReserve(ctx, 6);
    const arena = ctx.vertArena;
    const d = arena.data;
    const r = ctx.clearR, g = ctx.clearG, b = ctx.clearB, a = ctx.clearA;
    const xy = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
    for (let v = 0; v < 6; v++) {
        const o = base + v * VERT_FLOATS;
        d[o] = xy[v * 2]; d[o + 1] = xy[v * 2 + 1]; d[o + 2] = 0; d[o + 3] = 1;
        d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
        d[o + 8] = 0; d[o + 9] = 0; d[o + 10] = 1;
        d[o + 11] = 0; d[o + 12] = 0; d[o + 13] = 0; d[o + 14] = 0;
    }
    arena.used = base + 6 * VERT_FLOATS;

    let flags = DF_SCISSOR;
    if (ctx.colorMaskR) flags |= DF_COLOR_MASK_R;
    if (ctx.colorMaskG) flags |= DF_COLOR_MASK_G;
    if (ctx.colorMaskB) flags |= DF_COLOR_MASK_B;
    if (ctx.colorMaskA) flags |= DF_COLOR_MASK_A;

    const stream = ctx.commands;
    const idx = stream.alloc(GLDrawCommandType.DRAW);
    const I = stream.i32;
    const i = idx * CMD_I32;
    I[i + CI_MODE] = GL_TRIANGLES;
    I[i + CI_VERT_OFFSET] = base;
    I[i + CI_VERT_COUNT] = 6;
    I[i + CI_FLAGS] = flags;
    I[i + CI_SCISSOR_X] = ctx.scissorX;
    I[i + CI_SCISSOR_Y] = ctx.scissorY;
    I[i + CI_SCISSOR_W] = ctx.scissorW;
    I[i + CI_SCISSOR_H] = ctx.scissorH;
    I[i + CI_VP_X] = ctx.scissorX;
    I[i + CI_VP_Y] = ctx.scissorY;
    I[i + CI_VP_W] = ctx.scissorW;
    I[i + CI_VP_H] = ctx.scissorH;
    ctx.frameSnapshot.drawCalls++;
    ctx.frameSnapshot.vertexCount += 6;
}

export function createStateExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const getMem = () => ctx.process.getCurrentMemory();

    return {
        glEnable: (_c, _m, args) => {
            const cap = args[0] >>> 0;
            ctx.enableFlags.add(cap);
            if (cap === GL_TEXTURE_2D) {
                ctx.textureUnits[ctx.activeTextureUnit].enabled2d = true;
            }
            // We publish GL_MAX_CLIP_PLANES = 6 because GL 1.3 forbids anything less,
            // but nothing clips. The error is toward drawing MORE (a mirror/water pass
            // shows geometry it should have cut), which is visible but not corrupting —
            // still, say so the first time one is actually turned on rather than let the
            // gap stay silent.
            if (cap >= GL_CLIP_PLANE0 && cap <= GL_CLIP_PLANE5) {
                stubWarn(`glEnable(GL_CLIP_PLANE${cap - GL_CLIP_PLANE0}): user clip planes are not applied`);
            }
            return 0;
        },

        glDisable: (_c, _m, args) => {
            const cap = args[0] >>> 0;
            ctx.enableFlags.delete(cap);
            if (cap === GL_TEXTURE_2D) {
                ctx.textureUnits[ctx.activeTextureUnit].enabled2d = false;
            }
            return 0;
        },

        glIsEnabled: (_c, _m, args) => {
            return ctx.enableFlags.has(args[0] >>> 0) ? 1 : 0;
        },

        // Depth
        glDepthFunc: (_c, _m, args) => { ctx.depthFunc = args[0] >>> 0; return 0; },
        glDepthMask: (_c, _m, args) => { ctx.depthMask = args[0] !== 0; return 0; },
        glDepthRange: (_c, _m, args) => {
            ctx.depthRangeNear = bitsToF64(args[0], args[1]);
            ctx.depthRangeFar = bitsToF64(args[2], args[3]);
            return 0;
        },

        // Blend
        glBlendFunc: (_c, _m, args) => {
            ctx.blendSrc = args[0] >>> 0;
            ctx.blendDst = args[1] >>> 0;
            return 0;
        },

        // Cull / FrontFace
        glCullFace: (_c, _m, args) => { ctx.cullFace = args[0] >>> 0; return 0; },
        glFrontFace: (_c, _m, args) => { ctx.frontFace = args[0] >>> 0; return 0; },

        // Shade model
        glShadeModel: (_c, _m, args) => { ctx.shadeModel = args[0] >>> 0; return 0; },

        // Alpha test
        glAlphaFunc: (_c, _m, args) => {
            ctx.alphaFunc = args[0] >>> 0;
            ctx.alphaRef = bitsToF32(args[1]);
            return 0;
        },

        // Scissor
        glScissor: (_c, _m, args) => {
            ctx.scissorX = args[0] | 0;
            ctx.scissorY = args[1] | 0;
            ctx.scissorW = args[2] | 0;
            ctx.scissorH = args[3] | 0;
            return 0;
        },

        // Viewport
        glViewport: (_c, _m, args) => {
            ctx.viewportX = args[0] | 0;
            ctx.viewportY = args[1] | 0;
            ctx.viewportW = args[2] | 0;
            ctx.viewportH = args[3] | 0;
            {
                const stream = ctx.commands;
                const i = stream.alloc(GLDrawCommandType.VIEWPORT) * CMD_I32;
                stream.i32[i + CI_VP_X] = ctx.viewportX;
                stream.i32[i + CI_VP_Y] = ctx.viewportY;
                stream.i32[i + CI_VP_W] = ctx.viewportW;
                stream.i32[i + CI_VP_H] = ctx.viewportH;
            }
            return 0;
        },

        // Clear
        glClear: (_c, _m, args) => {
            // GL clears only the SCISSOR BOX when GL_SCISSOR_TEST is on; WebGPU's loadOp
            // clears the whole attachment. A mid-frame panel clear then wipes everything
            // drawn before it — Serious Sam's NETRICSA briefing came out as one flat green
            // screen because its LAST panel clear erased the whole frame. Emit the colour
            // part as a solid quad over the scissor rect instead; depth/stencil bits (if
            // any) still go through the plain clear below.
            const clearMask = args[0] | 0;
            if ((clearMask & GL_COLOR_BUFFER_BIT) !== 0 && ctx.enableFlags.has(GL_SCISSOR_TEST)
                && ctx.scissorW > 0 && ctx.scissorH > 0) {
                emitScissorColorClear(ctx);
                const rest = clearMask & ~GL_COLOR_BUFFER_BIT;
                if (rest === 0) return 0;
                args = [rest, ...args.slice(1)];
            }
            const stream = ctx.commands;
            const idx = stream.alloc(GLDrawCommandType.CLEAR);
            const i = idx * CMD_I32;
            const f = idx * CMD_F32;
            stream.i32[i + CI_CLEAR_MASK] = args[0] | 0;
            stream.i32[i + CI_CLEAR_STENCIL] = ctx.clearStencil | 0;
            stream.f32[f + CF_CLEAR_R] = ctx.clearR;
            stream.f32[f + CF_CLEAR_G] = ctx.clearG;
            stream.f32[f + CF_CLEAR_B] = ctx.clearB;
            stream.f32[f + CF_CLEAR_A] = ctx.clearA;
            stream.f32[f + CF_CLEAR_DEPTH] = ctx.clearDepth;
            ctx.frameSnapshot.clearCalls++;
            return 0;
        },

        glClearColor: (_c, _m, args) => {
            ctx.clearR = bitsToF32(args[0]);
            ctx.clearG = bitsToF32(args[1]);
            ctx.clearB = bitsToF32(args[2]);
            ctx.clearA = bitsToF32(args[3]);
            return 0;
        },

        glClearDepth: (_c, _m, args) => {
            ctx.clearDepth = bitsToF64(args[0], args[1]);
            return 0;
        },

        glClearStencil: (_c, _m, args) => { ctx.clearStencil = args[0] | 0; return 0; },

        // Color mask
        glColorMask: (_c, _m, args) => {
            ctx.colorMaskR = args[0] !== 0;
            ctx.colorMaskG = args[1] !== 0;
            ctx.colorMaskB = args[2] !== 0;
            ctx.colorMaskA = args[3] !== 0;
            return 0;
        },

        // Hints
        glHint: (_c, _m, args) => { ctx.hints.set(args[0] >>> 0, args[1] >>> 0); return 0; },

        // Polygon mode / offset
        glPolygonMode: (_c, _m, args) => {
            const face = args[0] >>> 0;
            const mode = args[1] >>> 0;
            if (face === GL_FRONT || face === GL_FRONT_AND_BACK) ctx.polygonModeFront = mode;
            if (face === GL_BACK || face === GL_FRONT_AND_BACK) ctx.polygonModeBack = mode;
            return 0;
        },

        glPolygonOffset: (_c, _m, args) => {
            ctx.polygonOffsetFactor = bitsToF32(args[0]);
            ctx.polygonOffsetUnits = bitsToF32(args[1]);
            return 0;
        },

        // Line width / Point size
        glLineWidth: (_c, _m, args) => { ctx.lineWidth = bitsToF32(args[0]); return 0; },
        glPointSize: (_c, _m, args) => { ctx.pointSize = bitsToF32(args[0]); return 0; },

        // Fog
        glFogf: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = bitsToF32(args[1]);
            switch (pname) {
                case GL_FOG_MODE: ctx.fogMode = param | 0; break;
                case GL_FOG_DENSITY: ctx.fogDensity = param; break;
                case GL_FOG_START: ctx.fogStart = param; break;
                case GL_FOG_END: ctx.fogEnd = param; break;
            }
            return 0;
        },

        glFogi: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = args[1] | 0;
            switch (pname) {
                case GL_FOG_MODE: ctx.fogMode = param; break;
                case GL_FOG_DENSITY: ctx.fogDensity = param; break;
                case GL_FOG_START: ctx.fogStart = param; break;
                case GL_FOG_END: ctx.fogEnd = param; break;
            }
            return 0;
        },

        glFogfv: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const ptr = args[1] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_FOG_MODE: ctx.fogMode = readU32(mem, ptr) | 0; break;
                case GL_FOG_DENSITY: ctx.fogDensity = readF32(mem, ptr); break;
                case GL_FOG_START: ctx.fogStart = readF32(mem, ptr); break;
                case GL_FOG_END: ctx.fogEnd = readF32(mem, ptr); break;
                case GL_FOG_COLOR: readF32x4(mem, ptr, ctx.fogColor); break;
            }
            return 0;
        },

        glFogiv: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const ptr = args[1] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_FOG_MODE: ctx.fogMode = readU32(mem, ptr) | 0; break;
                case GL_FOG_DENSITY: ctx.fogDensity = readU32(mem, ptr) | 0; break;
                case GL_FOG_START: ctx.fogStart = readU32(mem, ptr) | 0; break;
                case GL_FOG_END: ctx.fogEnd = readU32(mem, ptr) | 0; break;
                case GL_FOG_COLOR: {
                    for (let i = 0; i < 4; i++) {
                        ctx.fogColor[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                    }
                    break;
                }
            }
            return 0;
        },

        // Lighting
        glLightf: (_c, _m, args) => {
            const lightIdx = (args[0] >>> 0) - GL_LIGHT0;
            if (lightIdx < 0 || lightIdx >= 8) return 0;
            const light = ctx.lights[lightIdx];
            const pname = args[1] >>> 0;
            const param = bitsToF32(args[2]);
            switch (pname) {
                case GL_SPOT_EXPONENT: light.spotExponent = param; break;
                case GL_SPOT_CUTOFF: light.spotCutoff = param; break;
                case GL_CONSTANT_ATTENUATION: light.constantAttenuation = param; break;
                case GL_LINEAR_ATTENUATION: light.linearAttenuation = param; break;
                case GL_QUADRATIC_ATTENUATION: light.quadraticAttenuation = param; break;
            }
            return 0;
        },

        glLightfv: (_c, _m, args) => {
            const lightIdx = (args[0] >>> 0) - GL_LIGHT0;
            if (lightIdx < 0 || lightIdx >= 8) return 0;
            const light = ctx.lights[lightIdx];
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_AMBIENT: readF32x4(mem, ptr, light.ambient); break;
                case GL_DIFFUSE: readF32x4(mem, ptr, light.diffuse); break;
                case GL_SPECULAR: readF32x4(mem, ptr, light.specular); break;
                case GL_POSITION: readF32x4(mem, ptr, light.position); break;
                case GL_SPOT_DIRECTION: readF32x3(mem, ptr, light.spotDirection); break;
                case GL_SPOT_EXPONENT: light.spotExponent = readF32(mem, ptr); break;
                case GL_SPOT_CUTOFF: light.spotCutoff = readF32(mem, ptr); break;
                case GL_CONSTANT_ATTENUATION: light.constantAttenuation = readF32(mem, ptr); break;
                case GL_LINEAR_ATTENUATION: light.linearAttenuation = readF32(mem, ptr); break;
                case GL_QUADRATIC_ATTENUATION: light.quadraticAttenuation = readF32(mem, ptr); break;
            }
            return 0;
        },

        glLighti: (_c, _m, args) => {
            const lightIdx = (args[0] >>> 0) - GL_LIGHT0;
            if (lightIdx < 0 || lightIdx >= 8) return 0;
            const light = ctx.lights[lightIdx];
            const pname = args[1] >>> 0;
            const param = args[2] | 0;
            switch (pname) {
                case GL_SPOT_EXPONENT: light.spotExponent = param; break;
                case GL_SPOT_CUTOFF: light.spotCutoff = param; break;
                case GL_CONSTANT_ATTENUATION: light.constantAttenuation = param; break;
                case GL_LINEAR_ATTENUATION: light.linearAttenuation = param; break;
                case GL_QUADRATIC_ATTENUATION: light.quadraticAttenuation = param; break;
            }
            return 0;
        },

        glLightiv: (_c, _m, args) => {
            const lightIdx = (args[0] >>> 0) - GL_LIGHT0;
            if (lightIdx < 0 || lightIdx >= 8) return 0;
            const light = ctx.lights[lightIdx];
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_AMBIENT:
                case GL_DIFFUSE:
                case GL_SPECULAR:
                case GL_POSITION: {
                    const target = pname === GL_AMBIENT ? light.ambient
                        : pname === GL_DIFFUSE ? light.diffuse
                        : pname === GL_SPECULAR ? light.specular
                        : light.position;
                    for (let i = 0; i < 4; i++) {
                        target[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                    }
                    break;
                }
                case GL_SPOT_DIRECTION: {
                    for (let i = 0; i < 3; i++) {
                        light.spotDirection[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                    }
                    break;
                }
                case GL_SPOT_EXPONENT: light.spotExponent = readU32(mem, ptr) | 0; break;
                case GL_SPOT_CUTOFF: light.spotCutoff = readU32(mem, ptr) | 0; break;
                case GL_CONSTANT_ATTENUATION: light.constantAttenuation = readU32(mem, ptr) | 0; break;
                case GL_LINEAR_ATTENUATION: light.linearAttenuation = readU32(mem, ptr) | 0; break;
                case GL_QUADRATIC_ATTENUATION: light.quadraticAttenuation = readU32(mem, ptr) | 0; break;
            }
            return 0;
        },

        // Light model
        glLightModelf: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = bitsToF32(args[1]);
            if (pname === GL_LIGHT_MODEL_TWO_SIDE || pname === GL_LIGHT_MODEL_LOCAL_VIEWER || pname === GL_LIGHT_MODEL_COLOR_CONTROL) {
                ctx.hints.set(pname, param | 0);
            }
            return 0;
        },

        glLightModelfv: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const ptr = args[1] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_LIGHT_MODEL_AMBIENT: readF32x4(mem, ptr, ctx.lightModelAmbient); break;
                case GL_LIGHT_MODEL_TWO_SIDE:
                case GL_LIGHT_MODEL_LOCAL_VIEWER:
                case GL_LIGHT_MODEL_COLOR_CONTROL:
                    ctx.hints.set(pname, readF32(mem, ptr) | 0);
                    break;
            }
            return 0;
        },

        glLightModeli: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = args[1] | 0;
            if (pname === GL_LIGHT_MODEL_TWO_SIDE || pname === GL_LIGHT_MODEL_LOCAL_VIEWER || pname === GL_LIGHT_MODEL_COLOR_CONTROL) {
                ctx.hints.set(pname, param);
            }
            return 0;
        },

        glLightModeliv: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const ptr = args[1] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_LIGHT_MODEL_AMBIENT: {
                    for (let i = 0; i < 4; i++) {
                        ctx.lightModelAmbient[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                    }
                    break;
                }
                case GL_LIGHT_MODEL_TWO_SIDE:
                case GL_LIGHT_MODEL_LOCAL_VIEWER:
                case GL_LIGHT_MODEL_COLOR_CONTROL:
                    ctx.hints.set(pname, readU32(mem, ptr) | 0);
                    break;
            }
            return 0;
        },

        // Material
        glMaterialf: (_c, _m, args) => {
            const pname = args[1] >>> 0;
            if (pname === GL_SHININESS) ctx.materialFrontShininess = bitsToF32(args[2]);
            return 0;
        },

        glMaterialfv: (_c, _m, args) => {
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_AMBIENT: readF32x4(mem, ptr, ctx.materialFrontAmbient); break;
                case GL_DIFFUSE: readF32x4(mem, ptr, ctx.materialFrontDiffuse); break;
                case GL_SPECULAR: readF32x4(mem, ptr, ctx.materialFrontSpecular); break;
                case GL_EMISSION: readF32x4(mem, ptr, ctx.materialFrontEmission); break;
                case GL_SHININESS: ctx.materialFrontShininess = readF32(mem, ptr); break;
                case GL_AMBIENT_AND_DIFFUSE:
                    readF32x4(mem, ptr, ctx.materialFrontAmbient);
                    ctx.materialFrontDiffuse.set(ctx.materialFrontAmbient);
                    break;
            }
            return 0;
        },

        glMateriali: (_c, _m, args) => {
            const pname = args[1] >>> 0;
            if (pname === GL_SHININESS) ctx.materialFrontShininess = args[2] | 0;
            return 0;
        },

        glMaterialiv: (_c, _m, args) => {
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            switch (pname) {
                case GL_AMBIENT:
                case GL_DIFFUSE:
                case GL_SPECULAR:
                case GL_EMISSION: {
                    const target = pname === GL_AMBIENT ? ctx.materialFrontAmbient
                        : pname === GL_DIFFUSE ? ctx.materialFrontDiffuse
                        : pname === GL_SPECULAR ? ctx.materialFrontSpecular
                        : ctx.materialFrontEmission;
                    for (let i = 0; i < 4; i++) {
                        target[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                    }
                    break;
                }
                case GL_SHININESS:
                    ctx.materialFrontShininess = readU32(mem, ptr) | 0;
                    break;
                case GL_AMBIENT_AND_DIFFUSE: {
                    for (let i = 0; i < 4; i++) {
                        const v = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                        ctx.materialFrontAmbient[i] = v;
                        ctx.materialFrontDiffuse[i] = v;
                    }
                    break;
                }
            }
            return 0;
        },

        // Color material
        glColorMaterial: (_c, _m, args) => {
            ctx.colorMaterialFace = args[0] >>> 0;
            ctx.colorMaterialParam = args[1] >>> 0;
            return 0;
        },

        // Texture environment.
        //
        // Every pname of ARB/EXT_texture_env_combine lands here. A combiner parameter
        // that is silently dropped is worse than an unsupported extension: the engine
        // already COLLAPSED its multi-pass lightmap path into the one pass it thinks we
        // are about to combine for it, and that pass then renders as plain MODULATE.
        glTexEnvf: (_c, _m, args) => {
            setTexEnvParam(ctx, args[0] >>> 0, args[1] >>> 0, bitsToF32(args[2]));
            return 0;
        },

        glTexEnvi: (_c, _m, args) => {
            setTexEnvParam(ctx, args[0] >>> 0, args[1] >>> 0, args[2] | 0);
            return 0;
        },

        glTexEnvfv: (_c, _m, args) => {
            const target = args[0] >>> 0;
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            if (target === GL_TEXTURE_ENV && pname === GL_TEXTURE_ENV_COLOR) {
                const mem = getMem();
                const env = ctx.textureUnits[ctx.activeTextureUnit].envColor;
                for (let i = 0; i < 4; i++) env[i] = readF32(mem, ptr + i * 4);
                return 0;
            }
            setTexEnvParam(ctx, target, pname, readF32(getMem(), ptr));
            return 0;
        },

        glTexEnviv: (_c, _m, args) => {
            const target = args[0] >>> 0;
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            if (target === GL_TEXTURE_ENV && pname === GL_TEXTURE_ENV_COLOR) {
                const mem = getMem();
                const env = ctx.textureUnits[ctx.activeTextureUnit].envColor;
                // Integer colour components are scaled from the full int range (GL 1.3 §2.13).
                for (let i = 0; i < 4; i++) env[i] = (readU32(mem, ptr + i * 4) | 0) / 2147483647;
                return 0;
            }
            setTexEnvParam(ctx, target, pname, readU32(getMem(), ptr) | 0);
            return 0;
        },

        // Stencil
        glStencilFunc: (_c, _m, args) => {
            ctx.stencilFunc = args[0] >>> 0;
            ctx.stencilRef = args[1] | 0;
            ctx.stencilMask = args[2] >>> 0;
            return 0;
        },

        glStencilMask: (_c, _m, args) => { ctx.stencilWriteMask = args[0] >>> 0; return 0; },

        glStencilOp: (_c, _m, args) => {
            ctx.stencilFail = args[0] >>> 0;
            ctx.stencilZFail = args[1] >>> 0;
            ctx.stencilZPass = args[2] >>> 0;
            return 0;
        },

        // Logic op
        glLogicOp: (_c, _m, args) => { ctx.logicOp = args[0] >>> 0; return 0; },

        // Line stipple
        glLineStipple: (_c, _m, args) => {
            ctx.lineStippleFactor = args[0] | 0;
            ctx.lineStipplePattern = args[1] & 0xFFFF;
            return 0;
        },

        // Draw / Read buffer (stubs)
        glDrawBuffer: () => stubWarn("glDrawBuffer"),
        glReadBuffer: () => stubWarn("glReadBuffer"),

        // Pixel store
        glPixelStorei: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = args[1] | 0;
            switch (pname) {
                case GL_UNPACK_ALIGNMENT: ctx.unpackAlignment = param; break;
                case GL_UNPACK_ROW_LENGTH: ctx.unpackRowLength = param; break;
                case GL_UNPACK_SKIP_PIXELS: ctx.unpackSkipPixels = param; break;
                case GL_UNPACK_SKIP_ROWS: ctx.unpackSkipRows = param; break;
                case GL_PACK_ALIGNMENT: ctx.packAlignment = param; break;
            }
            return 0;
        },

        glPixelStoref: (_c, _m, args) => {
            const pname = args[0] >>> 0;
            const param = bitsToF32(args[1]) | 0;
            switch (pname) {
                case GL_UNPACK_ALIGNMENT: ctx.unpackAlignment = param; break;
                case GL_UNPACK_ROW_LENGTH: ctx.unpackRowLength = param; break;
                case GL_UNPACK_SKIP_PIXELS: ctx.unpackSkipPixels = param; break;
                case GL_UNPACK_SKIP_ROWS: ctx.unpackSkipRows = param; break;
                case GL_PACK_ALIGNMENT: ctx.packAlignment = param; break;
            }
            return 0;
        },

        // Pixel transfer / zoom (stubs)
        glPixelTransferf: () => stubWarn("glPixelTransferf"),
        glPixelTransferi: () => stubWarn("glPixelTransferi"),
        glPixelZoom: (_c: any, _m: any, args: number[]) => {
            ctx.pixelZoomX = bitsToF32(args[0]);
            ctx.pixelZoomY = bitsToF32(args[1]);
            return 0;
        },

        // Edge flag (stubs)
        glEdgeFlag: () => 0,
        glEdgeFlagv: () => 0,

        // Pass through (stub)
        glPassThrough: () => 0,

        // Sample coverage (stub)
        glSampleCoverage: () => stubWarn("glSampleCoverage"),

        // Accumulation buffer (stubs)
        glAccum: () => stubWarn("glAccum"),
        glClearAccum: () => stubWarn("glClearAccum"),

        // ---- Render mode / selection ----
        //
        // The return value is the number of records the mode being LEFT produced, and a
        // picking caller walks exactly that many records out of its own buffer. Answering
        // with the GL_RENDER enum (7680) told every caller "7680 hits" over a buffer
        // nothing had written — it then parses uninitialized memory as hit records and
        // either picks a wrong object or walks off the end of its array.
        //
        // We record no hits, so selection fails CLOSED (0 hits = nothing under the
        // cursor) instead of failing wild.
        glRenderMode: (_c, _m, args) => {
            const mode = args[0] >>> 0;
            const previous = ctx.renderMode;
            if (mode !== GL_RENDER && mode !== GL_SELECT && mode !== GL_FEEDBACK) {
                ctx.error = GL_INVALID_ENUM;
                return 0;
            }
            ctx.renderMode = mode;
            if (previous === GL_SELECT) {
                stubWarn("glRenderMode: leaving GL_SELECT with 0 hits (selection not implemented)");
                return 0;
            }
            if (previous === GL_FEEDBACK) {
                stubWarn("glRenderMode: leaving GL_FEEDBACK with 0 values (feedback not implemented)");
                return 0;
            }
            return 0;
        },

        // Remembered so the buffers can be filled if selection is ever implemented, and
        // so nothing else pretends they were consumed.
        glSelectBuffer: (_c, _m, args) => {
            ctx.selectBufferSize = args[0] | 0;
            ctx.selectBufferPtr = args[1] >>> 0;
            return 0;
        },
        glFeedbackBuffer: (_c, _m, args) => {
            ctx.feedbackBufferSize = args[0] | 0;
            ctx.feedbackBufferType = args[1] >>> 0;
            ctx.feedbackBufferPtr = args[2] >>> 0;
            return 0;
        },

        // The name stack is real state independent of whether hits are recorded, and
        // GL_MAX_NAME_STACK_DEPTH is published from the same constant.
        glInitNames: () => { ctx.nameStackTop = -1; return 0; },
        glPushName: (_c, _m, args) => {
            if (ctx.nameStackTop + 1 >= NAME_STACK_MAX_DEPTH) { ctx.error = GL_STACK_OVERFLOW; return 0; }
            ctx.nameStack[++ctx.nameStackTop] = args[0] | 0;
            return 0;
        },
        glPopName: () => {
            if (ctx.nameStackTop < 0) { ctx.error = GL_STACK_UNDERFLOW; return 0; }
            ctx.nameStackTop--;
            return 0;
        },
        glLoadName: (_c, _m, args) => {
            if (ctx.nameStackTop < 0) { ctx.error = GL_INVALID_OPERATION; return 0; }
            ctx.nameStack[ctx.nameStackTop] = args[0] | 0;
            return 0;
        },

        // Attrib stack (stubs)
        glPushAttrib: () => stubWarn("glPushAttrib"),
        glPopAttrib: () => stubWarn("glPopAttrib"),
        glPushClientAttrib: () => stubWarn("glPushClientAttrib"),
        glPopClientAttrib: () => stubWarn("glPopClientAttrib"),

        // Clip planes: the plane equations are real state even though nothing clips yet,
        // so a caller that reads one back gets what it set instead of its own stack.
        glClipPlane: (_c, _m, args) => {
            const index = (args[0] >>> 0) - GL_CLIP_PLANE0;
            const ptr = args[1] >>> 0;
            if (index < 0 || index >= 6) { ctx.error = GL_INVALID_ENUM; return 0; }
            if (!ptr) return 0;
            const view = new DataView(getMem().buffer, getMem().byteOffset);
            for (let i = 0; i < 4; i++) ctx.clipPlanes[index * 4 + i] = view.getFloat64(ptr + i * 8, true);
            return 0;
        },
        glGetClipPlane: (_c, _m, args) => {
            const index = (args[0] >>> 0) - GL_CLIP_PLANE0;
            const ptr = args[1] >>> 0;
            if (index < 0 || index >= 6) { ctx.error = GL_INVALID_ENUM; return 0; }
            if (!ptr) return 0;
            const view = new DataView(getMem().buffer, getMem().byteOffset);
            for (let i = 0; i < 4; i++) view.setFloat64(ptr + i * 8, ctx.clipPlanes[index * 4 + i], true);
            return 0;
        },

        // Pixel copy / draw / read / bitmap
        glCopyPixels: () => stubWarn("glCopyPixels"),

        glDrawPixels: (_c: any, _m: any, args: number[]) => {
            const width = args[0] | 0;
            const height = args[1] | 0;
            const format = args[2] >>> 0;
            const type = args[3] >>> 0;
            const pixels = args[4] >>> 0;

            if (width <= 0 || height <= 0 || pixels === 0) return 0;

            const mem = ctx.process.getCurrentMemory();
            const rgba = convertPixelsToRGBA8(
                mem, pixels, width, height, format, type,
                ctx.unpackAlignment, ctx.unpackRowLength, ctx.unpackSkipPixels, ctx.unpackSkipRows
            );

            // Use a reserved internal texture ID for glDrawPixels
            const DRAWPIXELS_TEX_ID = 0x7FFFFF00;
            let tex = ctx.textures.get(DRAWPIXELS_TEX_ID);
            if (!tex) {
                tex = {
                    id: DRAWPIXELS_TEX_ID, width: 0, height: 0, internalFormat: GL_RGBA,
                    data: null, wrapS: 0x812F, wrapT: 0x812F, // GL_CLAMP_TO_EDGE
                    minFilter: 0x2601, magFilter: 0x2601, // GL_LINEAR
                    dirty: false, gpuVersion: 0,
                };
                ctx.textures.set(DRAWPIXELS_TEX_ID, tex);
            }
            tex.width = width;
            tex.height = height;
            tex.data = rgba;
            tex.dirty = true;
            tex.gpuVersion++;

            // Build a screen-space quad at raster position.
            // glDrawPixels renders from raster pos rightward and upward.
            // Vertices are already in window coordinates (post-transform).
            const rX = ctx.rasterPosX;
            const rY = ctx.rasterPosY;
            const zoomX = ctx.pixelZoomX;
            const zoomY = ctx.pixelZoomY;
            const w = width * Math.abs(zoomX);
            const h = height * Math.abs(zoomY);

            // Texture coords: row 0 in rgba = bottom row of image (OpenGL convention).
            // Since convertPixelsToRGBA8 stores row 0 = first row from memory = bottom,
            // and GPU texture row 0 = top, we flip v: bottom-left=(0,1), top-left=(0,0).
            const u0 = zoomX >= 0 ? 0 : 1;
            const u1 = zoomX >= 0 ? 1 : 0;
            const v0 = zoomY >= 0 ? 1 : 0; // bottom of quad = bottom of image
            const v1 = zoomY >= 0 ? 0 : 1; // top of quad = top of image

            // Two triangles forming a quad — convert window-space to clip-space
            // since the shader now expects clip-space and GPU does viewport transform.
            const VF = VERT_FLOATS;
            const arena = ctx.vertArena;
            arena.reserve(6);
            const vertBase = arena.used;
            const vertData = arena.data;
            arena.used = vertBase + 6 * VF;
            const zv = ctx.rasterPosZ;
            const vpX = ctx.viewportX, vpY = ctx.viewportY;
            const vpW = ctx.viewportW, vpH = ctx.viewportH;
            const drNear = ctx.depthRangeNear, drFar = ctx.depthRangeFar;
            // Window → OpenGL NDC (w=1, so clip = NDC)
            const toClipX = (wx: number) => (wx - vpX) / vpW * 2 - 1;
            const toClipY = (wy: number) => (wy - vpY) / vpH * 2 - 1;
            const drRange = drFar - drNear;
            const clipZ = drRange > 1e-8 ? (zv - drNear) / drRange * 2 - 1 : 0;
            // vertex layout helper: x,y,s0,t0
            const quadverts: [number, number, number, number][] = [
                [rX,       rY,       u0, v0],
                [rX + w,   rY,       u1, v0],
                [rX + w,   rY + h,   u1, v1],
                [rX,       rY,       u0, v0],
                [rX + w,   rY + h,   u1, v1],
                [rX,       rY + h,   u0, v1],
            ];
            for (let vi = 0; vi < 6; vi++) {
                const b = vertBase + vi * VF;
                const qv = quadverts[vi];
                vertData[b]    = toClipX(qv[0]); vertData[b+1] = toClipY(qv[1]); vertData[b+2] = clipZ; vertData[b+3] = 1;
                vertData[b+4]  = 1;     vertData[b+5]  = 1;     vertData[b+6]  = 1;  vertData[b+7]  = 1;
                vertData[b+8]  = 0;     vertData[b+9]  = 0;     vertData[b+10] = 1;
                vertData[b+11] = qv[2]; vertData[b+12] = qv[3]; vertData[b+13] = 0;  vertData[b+14] = 0;
            }

            // Depth/alpha/stencil test and culling stay OFF for the raster quad, so
            // only the flags glDrawPixels actually honours are set.
            let flags = 0;
            if (ctx.enableFlags.has(0x0BE2)) flags |= DF_BLEND;       // GL_BLEND
            if (ctx.enableFlags.has(0x0C11)) flags |= DF_SCISSOR;     // GL_SCISSOR_TEST
            if (ctx.colorMaskR) flags |= DF_COLOR_MASK_R;
            if (ctx.colorMaskG) flags |= DF_COLOR_MASK_G;
            if (ctx.colorMaskB) flags |= DF_COLOR_MASK_B;
            if (ctx.colorMaskA) flags |= DF_COLOR_MASK_A;

            const stream = ctx.commands;
            const cmdIdx = stream.alloc(GLDrawCommandType.DRAW);
            const ci = cmdIdx * CMD_I32;
            const cf = cmdIdx * CMD_F32;
            const I = stream.i32, F = stream.f32;
            I[ci + CI_MODE] = GL_QUADS;
            I[ci + CI_VERT_OFFSET] = vertBase;
            I[ci + CI_VERT_COUNT] = 6;
            I[ci + CI_FLAGS] = flags;
            I[ci + CI_DEPTH_FUNC] = ctx.depthFunc;
            I[ci + CI_BLEND_SRC] = ctx.blendSrc;
            I[ci + CI_BLEND_DST] = ctx.blendDst;
            I[ci + CI_ALPHA_FUNC] = ctx.alphaFunc;
            I[ci + CI_CULL_FACE] = ctx.cullFace;
            I[ci + CI_FRONT_FACE] = ctx.frontFace;
            I[ci + CI_TEX_ID0] = DRAWPIXELS_TEX_ID;
            I[ci + CI_TEX_ID1] = 0;
            I[ci + CI_TEXENV0] = 0x1E01; // GL_REPLACE
            I[ci + CI_TEXENV1] = 0;
            // The raster quad never combines, but alloc() does not clear slots — leaving
            // these would inherit the previous record's combiner.
            I[ci + CI_COMBINE0_RGB] = COMBINER_WORD_DEFAULT;
            I[ci + CI_COMBINE0_ALPHA] = COMBINER_WORD_DEFAULT;
            I[ci + CI_COMBINE1_RGB] = COMBINER_WORD_DEFAULT;
            I[ci + CI_COMBINE1_ALPHA] = COMBINER_WORD_DEFAULT;
            for (let k = 0; k < 4; k++) { F[cf + CF_ENV_COLOR0 + k] = 0; F[cf + CF_ENV_COLOR1 + k] = 0; }
            I[ci + CI_SHADE_MODEL] = ctx.shadeModel;
            I[ci + CI_FOG_MODE] = ctx.fogMode;
            I[ci + CI_POLYGON_MODE] = 0x1B02; // GL_FILL
            I[ci + CI_STENCIL_FUNC] = ctx.stencilFunc;
            I[ci + CI_STENCIL_REF] = ctx.stencilRef;
            I[ci + CI_STENCIL_MASK] = ctx.stencilMask;
            I[ci + CI_STENCIL_FAIL] = ctx.stencilFail;
            I[ci + CI_STENCIL_ZFAIL] = ctx.stencilZFail;
            I[ci + CI_STENCIL_ZPASS] = ctx.stencilZPass;
            I[ci + CI_STENCIL_WRITE_MASK] = ctx.stencilWriteMask;
            I[ci + CI_SCISSOR_X] = ctx.scissorX;
            I[ci + CI_SCISSOR_Y] = ctx.scissorY;
            I[ci + CI_SCISSOR_W] = ctx.scissorW;
            I[ci + CI_SCISSOR_H] = ctx.scissorH;
            I[ci + CI_VP_X] = ctx.viewportX;
            I[ci + CI_VP_Y] = ctx.viewportY;
            I[ci + CI_VP_W] = ctx.viewportW;
            I[ci + CI_VP_H] = ctx.viewportH;
            F[cf + CF_ALPHA_REF] = ctx.alphaRef;
            F[cf + CF_FOG_R] = ctx.fogColor[0];
            F[cf + CF_FOG_G] = ctx.fogColor[1];
            F[cf + CF_FOG_B] = ctx.fogColor[2];
            F[cf + CF_FOG_A] = ctx.fogColor[3];
            F[cf + CF_FOG_DENSITY] = ctx.fogDensity;
            F[cf + CF_FOG_START] = ctx.fogStart;
            F[cf + CF_FOG_END] = ctx.fogEnd;
            F[cf + CF_DEPTH_RANGE_NEAR] = ctx.depthRangeNear;
            F[cf + CF_DEPTH_RANGE_FAR] = ctx.depthRangeFar;

            ctx.frameSnapshot.drawCalls++;
            ctx.frameSnapshot.vertexCount += 6;
            ctx.frameSnapshot.texUploads++;

            Logger.log(LogCategory.SYSTEM,
                `glDrawPixels ${width}x${height} fmt=0x${format.toString(16)} type=0x${type.toString(16)} ` +
                `rasterPos=(${rX.toFixed(1)},${rY.toFixed(1)}) zoom=(${zoomX},${zoomY}) → cmd queued`);

            return 0;
        },

        /**
         * glReadPixels — a real readback of the colour buffer.
         *
         * A stub here is not a lost feature: the caller allocated a buffer, we returned
         * without writing a byte of it, and the in-game screenshot / render-to-texture
         * effect then encodes whatever the guest heap happened to hold. When we cannot
         * serve the read we zero the destination instead, so the answer is at least
         * defined and visibly wrong rather than random.
         */
        glReadPixels: (_c, _m, args): number | Promise<number> => {
            const x = args[0] | 0, y = args[1] | 0;
            const width = args[2] | 0, height = args[3] | 0;
            const format = args[4] >>> 0, type = args[5] >>> 0;
            const dst = args[6] >>> 0;
            if (!dst || width <= 0 || height <= 0) return 0;

            const components = format === GL_RGB || format === GL_BGR ? 3
                : format === GL_RGBA || format === GL_BGRA ? 4 : 0;
            const alignment = ctx.packAlignment > 0 ? ctx.packAlignment : 1;
            const rowBytes = width * components;
            const stride = components > 0 ? (rowBytes + alignment - 1) & ~(alignment - 1) : 0;

            if (components === 0 || type !== GL_UNSIGNED_BYTE) {
                stubWarn(`glReadPixels format=0x${format.toString(16)} type=0x${type.toString(16)} unsupported`);
                return 0;
            }
            // Validate the WHOLE extent once, at the boundary, before any write.
            if (!isValidAddress(ctx.process.getCurrentMemory(), dst, stride * height, "rw")) {
                ctx.error = GL_INVALID_OPERATION;
                return 0;
            }

            const executor = ctx.executor;
            const zeroFill = (): number => {
                Mem.writeBytes(dst, new Uint8Array(stride * height));
                return 0;
            };
            if (!executor) { stubWarn("glReadPixels with no GL executor"); return zeroFill(); }

            return executor.readPixels(x, y, width, height).then((rgba: Uint8Array | null) => {
                if (!rgba) { stubWarn("glReadPixels: nothing rendered yet"); return zeroFill(); }
                const swapRb = format === GL_BGR || format === GL_BGRA;
                const out = new Uint8Array(stride * height);
                for (let row = 0; row < height; row++) {
                    const src = row * width * 4;
                    const d = row * stride;
                    for (let px = 0; px < width; px++) {
                        const s = src + px * 4, o = d + px * components;
                        out[o] = rgba[s + (swapRb ? 2 : 0)];
                        out[o + 1] = rgba[s + 1];
                        out[o + 2] = rgba[s + (swapRb ? 0 : 2)];
                        if (components === 4) out[o + 3] = rgba[s + 3];
                    }
                }
                Mem.writeBytes(dst, out);
                return 0;
            });
        },
        glBitmap: () => stubWarn("glBitmap"),

        // Pixel map (stubs)
        glPixelMapfv: () => stubWarn("glPixelMapfv"),
        glPixelMapuiv: () => stubWarn("glPixelMapuiv"),
        glPixelMapusv: () => stubWarn("glPixelMapusv"),
        glGetPixelMapfv: () => stubWarn("glGetPixelMapfv"),
        glGetPixelMapuiv: () => stubWarn("glGetPixelMapuiv"),
        glGetPixelMapusv: () => stubWarn("glGetPixelMapusv"),

        // Polygon stipple (stubs)
        glPolygonStipple: () => stubWarn("glPolygonStipple"),
        glGetPolygonStipple: () => stubWarn("glGetPolygonStipple"),

        // Evaluators (stubs)
        glMap1d: () => stubWarn("glMap1d"),
        glMap1f: () => stubWarn("glMap1f"),
        glMap2d: () => stubWarn("glMap2d"),
        glMap2f: () => stubWarn("glMap2f"),
        glMapGrid1d: () => stubWarn("glMapGrid1d"),
        glMapGrid1f: () => stubWarn("glMapGrid1f"),
        glMapGrid2d: () => stubWarn("glMapGrid2d"),
        glMapGrid2f: () => stubWarn("glMapGrid2f"),

        glEvalCoord1d: () => 0, glEvalCoord1dv: () => 0,
        glEvalCoord1f: () => 0, glEvalCoord1fv: () => 0,
        glEvalCoord2d: () => 0, glEvalCoord2dv: () => 0,
        glEvalCoord2f: () => 0, glEvalCoord2fv: () => 0,

        glEvalMesh1: () => 0, glEvalMesh2: () => 0,
        glEvalPoint1: () => 0, glEvalPoint2: () => 0,

        // Get map (stubs)
        glGetMapdv: () => stubWarn("glGetMapdv"),
        glGetMapfv: () => stubWarn("glGetMapfv"),
        glGetMapiv: () => stubWarn("glGetMapiv"),

        // Index (stubs)
        glIndexMask: () => 0,
        glIndexd: () => 0, glIndexdv: () => 0,
        glIndexf: () => 0, glIndexfv: () => 0,
        glIndexi: () => 0, glIndexiv: () => 0,
        glIndexs: () => 0, glIndexsv: () => 0,
        glIndexub: () => 0, glIndexubv: () => 0,

        // Raster pos — transform object coords through MVP to window coords
        ...(() => {
            function setRasterPos(x: number, y: number, z: number, w: number): void {
                const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
                const proj = ctx.projectionStack.stack[ctx.projectionStack.top];
                const mvp = new Float32Array(16);
                mat4Multiply(mvp, proj, mv);

                const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12] * w;
                const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13] * w;
                const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14] * w;
                const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] * w;

                if (cw === 0) { ctx.rasterPosValid = false; return; }
                const invW = 1 / cw;
                const ndcX = cx * invW;
                const ndcY = cy * invW;
                const ndcZ = cz * invW;

                // Clip test
                if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) {
                    ctx.rasterPosValid = false;
                    return;
                }

                ctx.rasterPosX = ctx.viewportX + (ndcX + 1) * 0.5 * ctx.viewportW;
                ctx.rasterPosY = ctx.viewportY + (ndcY + 1) * 0.5 * ctx.viewportH;
                ctx.rasterPosZ = ctx.depthRangeNear + (ndcZ + 1) * 0.5 * (ctx.depthRangeFar - ctx.depthRangeNear);
                ctx.rasterPosW = cw;
                ctx.rasterPosValid = true;
            }

            const readF32 = (ptr: number, n: number): number[] => {
                const mem = ctx.process.getCurrentMemory();
                const view = new DataView(mem.buffer, mem.byteOffset);
                const out: number[] = [];
                for (let i = 0; i < n; i++) out.push(view.getFloat32(ptr + i * 4, true));
                return out;
            };
            const readF64 = (ptr: number, n: number): number[] => {
                const mem = ctx.process.getCurrentMemory();
                const view = new DataView(mem.buffer, mem.byteOffset);
                const out: number[] = [];
                for (let i = 0; i < n; i++) out.push(view.getFloat64(ptr + i * 8, true));
                return out;
            };
            const readI32 = (ptr: number, n: number): number[] => {
                const mem = ctx.process.getCurrentMemory();
                const view = new DataView(mem.buffer, mem.byteOffset);
                const out: number[] = [];
                for (let i = 0; i < n; i++) out.push(view.getInt32(ptr + i * 4, true));
                return out;
            };
            const readI16 = (ptr: number, n: number): number[] => {
                const mem = ctx.process.getCurrentMemory();
                const view = new DataView(mem.buffer, mem.byteOffset);
                const out: number[] = [];
                for (let i = 0; i < n; i++) out.push(view.getInt16(ptr + i * 2, true));
                return out;
            };

            return {
                glRasterPos2d: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] as number, a[1] as number, 0, 1); return 0; },
                glRasterPos2f: (_c: any, _m: any, a: number[]) => { setRasterPos(bitsToF32(a[0]), bitsToF32(a[1]), 0, 1); return 0; },
                glRasterPos2i: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] | 0, a[1] | 0, 0, 1); return 0; },
                glRasterPos2s: (_c: any, _m: any, a: number[]) => { setRasterPos((a[0] << 16) >> 16, (a[1] << 16) >> 16, 0, 1); return 0; },
                glRasterPos3d: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] as number, a[1] as number, a[2] as number, 1); return 0; },
                glRasterPos3f: (_c: any, _m: any, a: number[]) => { setRasterPos(bitsToF32(a[0]), bitsToF32(a[1]), bitsToF32(a[2]), 1); return 0; },
                glRasterPos3i: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] | 0, a[1] | 0, a[2] | 0, 1); return 0; },
                glRasterPos3s: (_c: any, _m: any, a: number[]) => { setRasterPos((a[0] << 16) >> 16, (a[1] << 16) >> 16, (a[2] << 16) >> 16, 1); return 0; },
                glRasterPos4d: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] as number, a[1] as number, a[2] as number, a[3] as number); return 0; },
                glRasterPos4f: (_c: any, _m: any, a: number[]) => { setRasterPos(bitsToF32(a[0]), bitsToF32(a[1]), bitsToF32(a[2]), bitsToF32(a[3])); return 0; },
                glRasterPos4i: (_c: any, _m: any, a: number[]) => { setRasterPos(a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0); return 0; },
                glRasterPos4s: (_c: any, _m: any, a: number[]) => { setRasterPos((a[0] << 16) >> 16, (a[1] << 16) >> 16, (a[2] << 16) >> 16, (a[3] << 16) >> 16); return 0; },

                glRasterPos2dv: (_c: any, _m: any, a: number[]) => { const v = readF64(a[0] >>> 0, 2); setRasterPos(v[0], v[1], 0, 1); return 0; },
                glRasterPos2fv: (_c: any, _m: any, a: number[]) => { const v = readF32(a[0] >>> 0, 2); setRasterPos(v[0], v[1], 0, 1); return 0; },
                glRasterPos2iv: (_c: any, _m: any, a: number[]) => { const v = readI32(a[0] >>> 0, 2); setRasterPos(v[0], v[1], 0, 1); return 0; },
                glRasterPos2sv: (_c: any, _m: any, a: number[]) => { const v = readI16(a[0] >>> 0, 2); setRasterPos(v[0], v[1], 0, 1); return 0; },
                glRasterPos3dv: (_c: any, _m: any, a: number[]) => { const v = readF64(a[0] >>> 0, 3); setRasterPos(v[0], v[1], v[2], 1); return 0; },
                glRasterPos3fv: (_c: any, _m: any, a: number[]) => { const v = readF32(a[0] >>> 0, 3); setRasterPos(v[0], v[1], v[2], 1); return 0; },
                glRasterPos3iv: (_c: any, _m: any, a: number[]) => { const v = readI32(a[0] >>> 0, 3); setRasterPos(v[0], v[1], v[2], 1); return 0; },
                glRasterPos3sv: (_c: any, _m: any, a: number[]) => { const v = readI16(a[0] >>> 0, 3); setRasterPos(v[0], v[1], v[2], 1); return 0; },
                glRasterPos4dv: (_c: any, _m: any, a: number[]) => { const v = readF64(a[0] >>> 0, 4); setRasterPos(v[0], v[1], v[2], v[3]); return 0; },
                glRasterPos4fv: (_c: any, _m: any, a: number[]) => { const v = readF32(a[0] >>> 0, 4); setRasterPos(v[0], v[1], v[2], v[3]); return 0; },
                glRasterPos4iv: (_c: any, _m: any, a: number[]) => { const v = readI32(a[0] >>> 0, 4); setRasterPos(v[0], v[1], v[2], v[3]); return 0; },
                glRasterPos4sv: (_c: any, _m: any, a: number[]) => { const v = readI16(a[0] >>> 0, 4); setRasterPos(v[0], v[1], v[2], v[3]); return 0; },
            };
        })(),

        // Rect (stubs)
        glRectd: () => stubWarn("glRectd"), glRectdv: () => stubWarn("glRectdv"),
        glRectf: () => stubWarn("glRectf"), glRectfv: () => stubWarn("glRectfv"),
        glRecti: () => stubWarn("glRecti"), glRectiv: () => stubWarn("glRectiv"),
        glRects: () => stubWarn("glRects"), glRectsv: () => stubWarn("glRectsv"),

        // TexGen
        glTexGeni: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            if (pname === GL_TEXTURE_GEN_MODE) {
                const mode = args[2] >>> 0;
                if (mode !== GL_OBJECT_LINEAR && mode !== GL_EYE_LINEAR && mode !== GL_SPHERE_MAP &&
                    mode !== GL_NORMAL_MAP && mode !== GL_REFLECTION_MAP) {
                    ctx.error = GL_INVALID_ENUM; return 0;
                }
                tg.mode = mode;
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glTexGenf: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            if ((args[1] >>> 0) === GL_TEXTURE_GEN_MODE) {
                tg.mode = args[2] >>> 0;
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glTexGend: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            if ((args[1] >>> 0) === GL_TEXTURE_GEN_MODE) {
                tg.mode = args[2] >>> 0;
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glTexGenfv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            if (pname === GL_TEXTURE_GEN_MODE) {
                tg.mode = readU32(mem, ptr);
            } else if (pname === GL_OBJECT_PLANE) {
                readF32x4(mem, ptr, tg.objectPlane);
            } else if (pname === GL_EYE_PLANE) {
                readF32x4(mem, ptr, tg.eyePlane);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glTexGeniv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            const view = new DataView(mem.buffer, mem.byteOffset);
            if (pname === GL_TEXTURE_GEN_MODE) {
                tg.mode = view.getInt32(ptr, true);
            } else if (pname === GL_OBJECT_PLANE) {
                for (let i = 0; i < 4; i++) tg.objectPlane[i] = view.getInt32(ptr + i * 4, true);
            } else if (pname === GL_EYE_PLANE) {
                for (let i = 0; i < 4; i++) tg.eyePlane[i] = view.getInt32(ptr + i * 4, true);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glTexGendv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            const view = new DataView(mem.buffer, mem.byteOffset);
            if (pname === GL_TEXTURE_GEN_MODE) {
                tg.mode = view.getFloat64(ptr, true) | 0;
            } else if (pname === GL_OBJECT_PLANE) {
                for (let i = 0; i < 4; i++) tg.objectPlane[i] = view.getFloat64(ptr + i * 8, true);
            } else if (pname === GL_EYE_PLANE) {
                for (let i = 0; i < 4; i++) tg.eyePlane[i] = view.getFloat64(ptr + i * 8, true);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glGetTexGenfv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            const view = new DataView(mem.buffer, mem.byteOffset);
            if (pname === GL_TEXTURE_GEN_MODE) {
                view.setFloat32(ptr, tg.mode, true);
            } else if (pname === GL_OBJECT_PLANE) {
                for (let i = 0; i < 4; i++) view.setFloat32(ptr + i * 4, tg.objectPlane[i], true);
            } else if (pname === GL_EYE_PLANE) {
                for (let i = 0; i < 4; i++) view.setFloat32(ptr + i * 4, tg.eyePlane[i], true);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glGetTexGeniv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            const view = new DataView(mem.buffer, mem.byteOffset);
            if (pname === GL_TEXTURE_GEN_MODE) {
                view.setInt32(ptr, tg.mode, true);
            } else if (pname === GL_OBJECT_PLANE) {
                for (let i = 0; i < 4; i++) view.setInt32(ptr + i * 4, tg.objectPlane[i], true);
            } else if (pname === GL_EYE_PLANE) {
                for (let i = 0; i < 4; i++) view.setInt32(ptr + i * 4, tg.eyePlane[i], true);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
        glGetTexGendv: (_c, _m, args) => {
            const tg = getTexGenState(ctx, args[0] >>> 0);
            if (!tg) { ctx.error = GL_INVALID_ENUM; return 0; }
            const pname = args[1] >>> 0;
            const ptr = args[2] >>> 0;
            const mem = getMem();
            const view = new DataView(mem.buffer, mem.byteOffset);
            if (pname === GL_TEXTURE_GEN_MODE) {
                view.setFloat64(ptr, tg.mode, true);
            } else if (pname === GL_OBJECT_PLANE) {
                for (let i = 0; i < 4; i++) view.setFloat64(ptr + i * 8, tg.objectPlane[i], true);
            } else if (pname === GL_EYE_PLANE) {
                for (let i = 0; i < 4; i++) view.setFloat64(ptr + i * 8, tg.eyePlane[i], true);
            } else { ctx.error = GL_INVALID_ENUM; }
            return 0;
        },
    };
}
