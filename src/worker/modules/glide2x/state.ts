import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { GlideContext } from "./context";
import { GR_CMP_ALWAYS, GR_DEPTHBUFFER_DISABLE, GR_HINT_STWHINT } from "./constants";

function shouldLogStateEntry(context: GlideContext): boolean {
    const fid = context.frameSnapshot.frameId;
    return fid < 10 || (fid & 127) === 0;
}

const floatReinterpretBuffer = new ArrayBuffer(4);
const floatReinterpretView = new DataView(floatReinterpretBuffer);

function dwordToFloat(value: number): number {
    floatReinterpretView.setUint32(0, value >>> 0, true);
    return floatReinterpretView.getFloat32(0, true);
}

function clampToByte(value: number): number {
    return Math.max(0, Math.min(255, value | 0));
}

function normalizeFloatColorComponent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value >= 0 && value <= 1.0) {
        return clampToByte(Math.round(value * 255));
    }
    return clampToByte(Math.round(value));
}

const GR_COMBINE_FUNCTION_ZERO = 0x0;
const GR_COMBINE_FUNCTION_LOCAL = 0x1;
const GR_COMBINE_FUNCTION_SCALE_OTHER = 0x3;
const GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL = 0x4;
const GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA = 0x5;
const GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL = 0x6;
const GR_COMBINE_FUNCTION_BLEND = 0x7;

const GR_COMBINE_FACTOR_NONE = 0x0;
const GR_COMBINE_FACTOR_LOCAL = 0x1;
const GR_COMBINE_FACTOR_LOCAL_ALPHA = 0x3;
const GR_COMBINE_FACTOR_TEXTURE_ALPHA = 0x4;
const GR_COMBINE_FACTOR_ONE = 0x8;

const GR_COMBINE_LOCAL_ITERATED = 0x0;
const GR_COMBINE_LOCAL_CONSTANT = 0x1;

const GR_COMBINE_OTHER_ITERATED = 0x0;
const GR_COMBINE_OTHER_TEXTURE = 0x1;
const GR_COMBINE_OTHER_NONE = 0x2;

const GR_COLORCOMBINE_ZERO = 0x0;
const GR_COLORCOMBINE_CCRGB = 0x1;
const GR_COLORCOMBINE_ITRGB = 0x2;
const GR_COLORCOMBINE_ITRGB_DELTA0 = 0x3;
const GR_COLORCOMBINE_DECAL_TEXTURE = 0x4;
const GR_COLORCOMBINE_TEXTURE_TIMES_CCRGB = 0x5;
const GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB = 0x6;
const GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB_DELTA0 = 0x7;
const GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB_ADD_ALPHA = 0x8;
const GR_COLORCOMBINE_TEXTURE_TIMES_ALPHA = 0x9;
const GR_COLORCOMBINE_TEXTURE_TIMES_ALPHA_ADD_ITRGB = 0x0a;
const GR_COLORCOMBINE_TEXTURE_ADD_ITRGB = 0x0b;
const GR_COLORCOMBINE_TEXTURE_SUB_ITRGB = 0x0c;
const GR_COLORCOMBINE_CCRGB_BLEND_ITRGB_ON_TEXALPHA = 0x0d;
const GR_COLORCOMBINE_DIFF_SPEC_A = 0x0e;
const GR_COLORCOMBINE_DIFF_SPEC_B = 0x0f;
const GR_COLORCOMBINE_ONE = 0x10;

function applyGuColorCombineFunction(context: GlideContext, fn: number): void {
    // gu.c — EVERY guColorCombineFunction clears delta0 first; only the two DELTA0
    // entries re-arm it. A direct grColorCombine does not touch the mode, so it is
    // cleared here and nowhere else.
    context.runtime.colorCombineDelta0 = false;
    switch (fn | 0) {
        case GR_COLORCOMBINE_ZERO:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_ZERO,
                factor: GR_COMBINE_FACTOR_NONE,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_NONE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_CCRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_LOCAL,
                factor: GR_COMBINE_FACTOR_NONE,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_NONE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_ITRGB_DELTA0:
            context.runtime.colorCombineDelta0 = true;
        // falls through — gu.c sets the same combine as ITRGB
        case GR_COLORCOMBINE_ITRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_LOCAL,
                factor: GR_COMBINE_FACTOR_NONE,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_NONE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_DECAL_TEXTURE:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER,
                factor: GR_COMBINE_FACTOR_ONE,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_TIMES_CCRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER,
                factor: GR_COMBINE_FACTOR_LOCAL,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB_DELTA0:
            context.runtime.colorCombineDelta0 = true;
        // falls through — gu.c sets the same combine as TEXTURE_TIMES_ITRGB
        case GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER,
                factor: GR_COMBINE_FACTOR_LOCAL,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_TIMES_ITRGB_ADD_ALPHA:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA,
                factor: GR_COMBINE_FACTOR_LOCAL,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_TIMES_ALPHA:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER,
                factor: GR_COMBINE_FACTOR_LOCAL_ALPHA,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_TIMES_ALPHA_ADD_ITRGB:
        case GR_COLORCOMBINE_DIFF_SPEC_A:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL,
                factor: GR_COMBINE_FACTOR_LOCAL_ALPHA,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_ADD_ITRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL,
                factor: GR_COMBINE_FACTOR_ONE,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_TEXTURE_SUB_ITRGB:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL,
                factor: GR_COMBINE_FACTOR_ONE,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_CCRGB_BLEND_ITRGB_ON_TEXALPHA:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_BLEND,
                factor: GR_COMBINE_FACTOR_TEXTURE_ALPHA,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_ITERATED,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_DIFF_SPEC_B:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA,
                factor: GR_COMBINE_FACTOR_LOCAL,
                local: GR_COMBINE_LOCAL_ITERATED,
                other: GR_COMBINE_OTHER_TEXTURE,
                invert: 0,
            };
            return;
        case GR_COLORCOMBINE_ONE:
            context.runtime.colorCombine = {
                function: GR_COMBINE_FUNCTION_ZERO,
                factor: GR_COMBINE_FACTOR_NONE,
                local: GR_COMBINE_LOCAL_CONSTANT,
                other: GR_COMBINE_OTHER_NONE,
                invert: 1,
            };
            return;
        default:
            return;
    }
}

// guFogTableIndexToW: the eye-space W that fog-table entry i corresponds to.
// idxToW(i) = 2^(3 + i/4) / (8 - i%4). The shader's fogIndexFromW is its exact
// inverse, so generating the table against these W values keeps both consistent.
function fogTableIndexToW(i: number): number {
    return Math.pow(2, 3 + (i >> 2)) / (8 - (i & 3));
}

function generateFogTableExp(density: number): Uint8Array {
    const out = new Uint8Array(64);
    for (let i = 0; i < out.length; i++) {
        const w = fogTableIndexToW(i);
        out[i] = clampToByte(Math.round((1.0 - Math.exp(-density * w)) * 255));
    }
    return out;
}

function generateFogTableExp2(density: number): Uint8Array {
    const out = new Uint8Array(64);
    for (let i = 0; i < out.length; i++) {
        const w = fogTableIndexToW(i);
        const dw = density * w;
        out[i] = clampToByte(Math.round((1.0 - Math.exp(-(dw * dw))) * 255));
    }
    return out;
}

function generateFogTableLinear(nearW: number, farW: number): Uint8Array {
    const out = new Uint8Array(64);
    const denom = Math.max(1e-6, farW - nearW);
    for (let i = 0; i < out.length; i++) {
        const w = fogTableIndexToW(i);
        const v = (w - nearW) / denom;
        out[i] = clampToByte(Math.round(Math.max(0, Math.min(1, v)) * 255));
    }
    return out;
}

function applyFogTable(context: GlideContext, table: Uint8Array, dstPtr: number): void {
    context.runtime.fogTable.set(table.subarray(0, context.runtime.fogTable.length));
    if (dstPtr) {
        Mem.writeBytes(dstPtr, table);
    }
}

export function createStateExports(context: GlideContext): Record<string, ThunkImplementation> {
    return {
        "_grColorCombine@20": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grColorCombine fn=${args[0] | 0} factor=${args[1] | 0} ` +
                    `local=${args[2] | 0} other=${args[3] | 0} invert=${args[4] | 0}`,
                );
            }
            context.runtime.colorCombine = {
                function: args[0] | 0,
                factor: args[1] | 0,
                local: args[2] | 0,
                other: args[3] | 0,
                invert: args[4] | 0,
            };
            return 0;
        },

        "_guColorCombineFunction@4": (_ctx, _mem, args) => {
            const fn = args[0] | 0;
            if (shouldLogStateEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] guColorCombineFunction fn=${fn}`);
            }
            applyGuColorCombineFunction(context, fn);
            context.apiState.lastGuColorCombineFunction = fn;
            context.apiState.glideStateVersion = (context.apiState.glideStateVersion + 1) >>> 0;
            return 0;
        },

        "_grAlphaCombine@20": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grAlphaCombine fn=${args[0] | 0} factor=${args[1] | 0} ` +
                    `local=${args[2] | 0} other=${args[3] | 0} invert=${args[4] | 0}`,
                );
            }
            context.runtime.alphaCombine = {
                function: args[0] | 0,
                factor: args[1] | 0,
                local: args[2] | 0,
                other: args[3] | 0,
                invert: args[4] | 0,
            };
            return 0;
        },

        "_grAlphaBlendFunction@16": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grAlphaBlendFunction rgbSf=${args[0] | 0} rgbDf=${args[1] | 0} ` +
                    `alphaSf=${args[2] | 0} alphaDf=${args[3] | 0}`,
                );
            }
            context.runtime.alphaBlend = {
                rgbSf: args[0] | 0,
                rgbDf: args[1] | 0,
                alphaSf: args[2] | 0,
                alphaDf: args[3] | 0,
            };
            // Opaque default is GR_BLEND_ONE (4) src / GR_BLEND_ZERO (0) dst. The actual
            // factor->GPUBlendFactor mapping happens in glide-pipeline-factory.ts; here we
            // only track whether a blend state is needed at all.
            const b = context.runtime.alphaBlend;
            const blendEnabled = !(b.rgbSf === 4 && b.rgbDf === 0 && b.alphaSf === 4 && b.alphaDf === 0);
            context.ffpState.setBlend(blendEnabled);
            return 0;
        },

        "_grAlphaTestFunction@4": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grAlphaTestFunction fn=${args[0] | 0}`);
            }
            context.runtime.alphaTestFunction = args[0] | 0;
            context.ffpState.setAlphaTest((context.runtime.alphaTestFunction | 0) !== GR_CMP_ALWAYS, context.runtime.alphaReference);
            return 0;
        },

        "_grAlphaTestReferenceValue@4": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grAlphaTestReferenceValue ref=${args[0] | 0}`);
            }
            context.runtime.alphaReference = args[0] & 0xff;
            context.ffpState.setAlphaTest((context.runtime.alphaTestFunction | 0) !== GR_CMP_ALWAYS, context.runtime.alphaReference);
            return 0;
        },

        "_grFogMode@4": (_ctx, _mem, args) => {
            context.runtime.fogMode = args[0] | 0;
            context.ffpState.setFog((context.runtime.fogMode | 0) !== 0);
            return 0;
        },

        "_grFogColorValue@4": (_ctx, _mem, args) => {
            context.runtime.fogColor = args[0] >>> 0;
            return 0;
        },

        "_grFogTable@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const src = Mem.readBytes(ptr, context.runtime.fogTable.length);
            if (src) {
                context.runtime.fogTable.set(src);
            }
            return 0;
        },

        "_grFogGenerateExp@8": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            const density = dwordToFloat(args[1] >>> 0);
            const table = generateFogTableExp(density);
            applyFogTable(context, table, ptr);
            return 0;
        },

        "_grFogGenerateExp2@8": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            const density = dwordToFloat(args[1] >>> 0);
            const table = generateFogTableExp2(density);
            applyFogTable(context, table, ptr);
            return 0;
        },

        "_grFogGenerateLinear@12": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            const nearZ = dwordToFloat(args[1] >>> 0);
            const farZ = dwordToFloat(args[2] >>> 0);
            context.runtime.fogStart = nearZ;
            context.runtime.fogEnd = farZ;
            const table = generateFogTableLinear(nearZ, farZ);
            applyFogTable(context, table, ptr);
            return 0;
        },

        // gu* are the canonical names games actually import (glideutl.h); the gr*
        // forms above are kept as harmless aliases.
        "_guFogGenerateExp@8": (_ctx, _mem, args) => {
            applyFogTable(context, generateFogTableExp(dwordToFloat(args[1] >>> 0)), args[0] >>> 0);
            return 0;
        },

        "_guFogGenerateExp2@8": (_ctx, _mem, args) => {
            applyFogTable(context, generateFogTableExp2(dwordToFloat(args[1] >>> 0)), args[0] >>> 0);
            return 0;
        },

        "_guFogGenerateLinear@12": (_ctx, _mem, args) => {
            const nearZ = dwordToFloat(args[1] >>> 0);
            const farZ = dwordToFloat(args[2] >>> 0);
            context.runtime.fogStart = nearZ;
            context.runtime.fogEnd = farZ;
            applyFogTable(context, generateFogTableLinear(nearZ, farZ), args[0] >>> 0);
            return 0;
        },

        // guAlphaSource maps a GrAlphaSource_t preset onto the alpha combine unit.
        "_guAlphaSource@4": (_ctx, _mem, args) => {
            const mode = args[0] | 0;
            // GR_ALPHASOURCE_*: 0=CC_ALPHA, 1=ITERATED_ALPHA, 2=TEXTURE_ALPHA,
            // 3=TEXTURE_ALPHA_TIMES_ITERATED_ALPHA. Combine consts: FUNCTION_LOCAL=1,
            // SCALE_OTHER=3; FACTOR_ONE=8, FACTOR_LOCAL=1; LOCAL_ITERATED=0/CONSTANT=1;
            // OTHER_TEXTURE=1.
            switch (mode) {
                case 1: // ITERATED_ALPHA
                    context.runtime.alphaCombine = { function: 1, factor: 0, local: 0, other: 0, invert: 0 };
                    break;
                case 2: // TEXTURE_ALPHA
                    context.runtime.alphaCombine = { function: 3, factor: 8, local: 1, other: 1, invert: 0 };
                    break;
                case 3: // TEXTURE_ALPHA * ITERATED_ALPHA
                    context.runtime.alphaCombine = { function: 3, factor: 1, local: 0, other: 1, invert: 0 };
                    break;
                case 0: // CC_ALPHA (constant color alpha)
                default:
                    context.runtime.alphaCombine = { function: 1, factor: 0, local: 1, other: 0, invert: 0 };
                    break;
            }
            return 0;
        },

        // Selects whether iterated RGB participates in lighting; we always honor the
        // combine unit's iterated input, so this is a no-op acknowledgement.
        "_grAlphaControlsITRGBLighting@4": () => 0,

        // grDisableAllEffects: turn off fog, chroma-key, blend, alpha test, and depth so
        // subsequent draws are plain. Mirrors the reference convenience entry point.
        "_grDisableAllEffects@0": () => {
            context.runtime.fogMode = 0;
            context.ffpState.setFog(false);
            context.runtime.chromaKeyMode = 0;
            context.ffpState.setChromaKey(false, context.runtime.chromaKeyValue);
            context.runtime.alphaBlend = { rgbSf: 4, rgbDf: 0, alphaSf: 4, alphaDf: 0 };
            context.ffpState.setBlend(false);
            context.runtime.alphaTestFunction = GR_CMP_ALWAYS;
            context.ffpState.setAlphaTest(false, context.runtime.alphaReference);
            context.runtime.depthMode = GR_DEPTHBUFFER_DISABLE;
            context.ffpState.setDepth(false, context.runtime.depthMask);
            return 0;
        },

        "_grDepthBiasLevel@4": (_ctx, _mem, args) => {
            context.runtime.depthBias = args[0] | 0;
            return 0;
        },

        "_grDepthBufferFunction@4": (_ctx, _mem, args) => {
            context.runtime.depthFunction = args[0] | 0;
            context.ffpState.setDepth(context.runtime.depthMode !== GR_DEPTHBUFFER_DISABLE, context.runtime.depthMask);
            return 0;
        },

        "_grDepthBufferMode@4": (_ctx, _mem, args) => {
            context.runtime.depthMode = args[0] | 0;
            context.ffpState.setDepth(context.runtime.depthMode !== GR_DEPTHBUFFER_DISABLE, context.runtime.depthMask);
            return 0;
        },

        "_grDepthMask@4": (_ctx, _mem, args) => {
            context.runtime.depthMask = (args[0] | 0) !== 0;
            context.ffpState.setDepth(context.runtime.depthMode !== GR_DEPTHBUFFER_DISABLE, context.runtime.depthMask);
            return 0;
        },

        "_grClipWindow@16": (_ctx, _mem, args) => {
            context.runtime.clipWindow = {
                minX: args[0] | 0,
                minY: args[1] | 0,
                maxX: args[2] | 0,
                maxY: args[3] | 0,
            };
            return 0;
        },

        "_grViewport@16": (_ctx, _mem, args) => {
            context.runtime.viewport = {
                x: args[0] | 0,
                y: args[1] | 0,
                width: args[2] | 0,
                height: args[3] | 0,
            };
            return 0;
        },

        "_grColorMask@8": (_ctx, _mem, args) => {
            context.runtime.colorMask = {
                rgb: (args[0] | 0) !== 0,
                alpha: (args[1] | 0) !== 0,
            };
            return 0;
        },

        "_grCullMode@4": (_ctx, _mem, args) => {
            context.runtime.cullMode = args[0] | 0;
            context.ffpState.setCullMode(context.runtime.cullMode);
            return 0;
        },

        "_grDitherMode@4": (_ctx, _mem, args) => {
            context.runtime.ditherMode = args[0] | 0;
            return 0;
        },

        "_grChromakeyMode@4": (_ctx, _mem, args) => {
            if (shouldLogStateEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grChromakeyMode mode=${args[0] | 0}`);
            }
            context.runtime.chromaKeyMode = args[0] | 0;
            context.ffpState.setChromaKey(context.runtime.chromaKeyMode !== 0, context.runtime.chromaKeyValue);
            return 0;
        },

        "_grChromakeyValue@4": (_ctx, _mem, args) => {
            const newVal = args[0] >>> 0;
            if (newVal !== context.runtime.chromaKeyValue || shouldLogStateEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grChromakeyValue value=0x${newVal.toString(16)}`);
            }
            context.runtime.chromaKeyValue = newVal;
            context.ffpState.setChromaKey(context.runtime.chromaKeyMode !== 0, context.runtime.chromaKeyValue);
            return 0;
        },

        "_grConstantColorValue@4": (_ctx, _mem, args) => {
            context.runtime.constantColorValue = args[0] >>> 0;
            context.ffpState.setConstantColor(context.runtime.constantColorValue);
            return 0;
        },

        "_grConstantColorValue4@16": (_ctx, _mem, args) => {
            const a = normalizeFloatColorComponent(dwordToFloat(args[0] >>> 0));
            const r = normalizeFloatColorComponent(dwordToFloat(args[1] >>> 0));
            const g = normalizeFloatColorComponent(dwordToFloat(args[2] >>> 0));
            const b = normalizeFloatColorComponent(dwordToFloat(args[3] >>> 0));
            context.runtime.constantColorValue = (
                ((a & 0xff) << 24) |
                ((r & 0xff) << 16) |
                ((g & 0xff) << 8) |
                (b & 0xff)
            ) >>> 0;
            context.ffpState.setConstantColor(context.runtime.constantColorValue);
            // gglide.c:1299 — this call is the ONLY writer of gc->state.r/g/b, which is
            // what delta0 mode loads into the RGB iterators (gdraw.c).
            context.runtime.delta0Rgb = (((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
            return 0;
        },

        "_grGammaCorrectionValue@4": (_ctx, _mem, args) => {
            context.runtime.gammaValue = dwordToFloat(args[0] >>> 0);
            return 0;
        },

        "_grHints@8": (_ctx, _mem, args) => {
            context.apiState.lastHintType = args[0] | 0;
            context.apiState.lastHintMask = args[1] >>> 0;
            if ((args[0] | 0) === GR_HINT_STWHINT) {
                context.runtime.stwHint = args[1] >>> 0;
            }
            context.apiState.glideStateVersion = (context.apiState.glideStateVersion + 1) >>> 0;
            return 0;
        },
    };
}

