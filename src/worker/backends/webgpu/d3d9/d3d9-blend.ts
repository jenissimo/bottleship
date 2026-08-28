/**
 * Faithful D3D9 alpha-blend render-state → WebGPU GPUColorTargetState.
 *
 * D3D9 fixed-function blending is configured entirely through render states
 * (D3DRS_ALPHABLENDENABLE / SRCBLEND / DESTBLEND / BLENDOP, the separate-alpha
 * variants, and COLORWRITEENABLE). WebGPU bakes the equivalent state into the
 * render pipeline's color-target descriptor, so the blend state is part of the
 * pipeline cache key (see d3d9-device.ts).
 *
 * The D3DBLEND/D3DBLENDOP → WebGPU mapping and the BOTH*SRCALPHA fixup live in
 * shared/d3d-blend-factor.ts — DirectDraw/D3D3-8 FFP (ddraw/pipeline-factory.ts)
 * shares the identical enum values and legacy rule.
 */
import {
    mapBlendFactor, mapBlendOp, fixupBoth, isKnownBlendFactor, isKnownBlendOperation,
    hasDualSourceBlendFactor,
} from "../shared/d3d-blend-factor";

/** Reads a D3D9 render-state value (index → DWORD). */
export type GetRenderState = (state: number) => number;

/**
 * D3DCOLOR (0xAARRGGBB) → GPUColor. Shared by the clear path and the render-pass
 * blend constant (D3DRS_BLENDFACTOR) so the channel order cannot drift between them.
 */
export function d3dColorToGpu(color: number): GPUColor {
    const c = color >>> 0;
    return {
        r: ((c >>> 16) & 0xff) / 255,
        g: ((c >>> 8) & 0xff) / 255,
        b: (c & 0xff) / 255,
        a: ((c >>> 24) & 0xff) / 255,
    };
}

// ── Render-state indices ──────────────────────────────────────────────────
export const D3DRS_SRCBLEND = 19;
export const D3DRS_DESTBLEND = 20;
export const D3DRS_ALPHABLENDENABLE = 27;
export const D3DRS_BLENDOP = 171;
/** D3DBLENDFACTOR render state (DWORD A8R8G8B8). The executor applies it with
 * GPURenderPassEncoder.setBlendConstant before each draw. */
export const D3DRS_BLENDFACTOR = 193;
export const D3DRS_COLORWRITEENABLE = 168;
export const D3DRS_COLORWRITEENABLE1 = 190;
export const D3DRS_COLORWRITEENABLE2 = 191;
export const D3DRS_COLORWRITEENABLE3 = 192;
export const D3DRS_SEPARATEALPHABLENDENABLE = 206;
export const D3DRS_SRCBLENDALPHA = 207;
export const D3DRS_DESTBLENDALPHA = 208;
export const D3DRS_BLENDOPALPHA = 209;

const COLOR_WRITE_STATES = [
    D3DRS_COLORWRITEENABLE,
    D3DRS_COLORWRITEENABLE1,
    D3DRS_COLORWRITEENABLE2,
    D3DRS_COLORWRITEENABLE3,
] as const;

function colorWriteMask(getRS: GetRenderState, targetIndex: number): number {
    const state = COLOR_WRITE_STATES[targetIndex];
    if (state === undefined) {
        throw new RangeError(`D3D9 color-target index ${targetIndex} is outside 0..3`);
    }
    return getRS(state) & 0xf;
}

/**
 * Validate the blend state before it reaches a WebGPU pipeline descriptor.
 * D3D9's BOTH*SRCALPHA values are valid legacy inputs and are normalized by
 * `fixupBoth`; dual-source factors remain an explicit backend refusal.
 * Disabled blending does not consume the factor/op states, matching D3D9.
 */
export function isD3D9BlendStateRepresentable(getRS: GetRenderState): boolean {
    if (getRS(D3DRS_ALPHABLENDENABLE) === 0) return true;

    const [cSrc, cDst] = fixupBoth(getRS(D3DRS_SRCBLEND), getRS(D3DRS_DESTBLEND));
    const cOp = getRS(D3DRS_BLENDOP);
    let aSrc = cSrc, aDst = cDst, aOp = cOp;
    if (getRS(D3DRS_SEPARATEALPHABLENDENABLE) !== 0) {
        [aSrc, aDst] = fixupBoth(getRS(D3DRS_SRCBLENDALPHA), getRS(D3DRS_DESTBLENDALPHA));
        aOp = getRS(D3DRS_BLENDOPALPHA);
    }

    return representableFactor(cSrc) && representableFactor(cDst)
        && representableFactor(aSrc) && representableFactor(aDst)
        && isKnownBlendOperation(cOp) && isKnownBlendOperation(aOp);
}

function representableFactor(factor: number): boolean {
    return isKnownBlendFactor(factor) && !hasDualSourceBlendFactor(factor);
}

/**
 * Build the WebGPU colour-target descriptor (format + write-mask + optional
 * blend) for the current render state. When D3DRS_ALPHABLENDENABLE is FALSE no
 * blend object is attached (fully opaque, the WebGPU default).
 */
export function buildColorTargetState(
    format: GPUTextureFormat,
    getRS: GetRenderState,
    targetIndex: number = 0,
): GPUColorTargetState {
    const writeMask = colorWriteMask(getRS, targetIndex);
    if (getRS(D3DRS_ALPHABLENDENABLE) === 0) {
        return { format, writeMask };
    }

    const [cSrc, cDst] = fixupBoth(getRS(D3DRS_SRCBLEND), getRS(D3DRS_DESTBLEND));
    const cOp = getRS(D3DRS_BLENDOP);

    let aSrc = cSrc, aDst = cDst, aOp = cOp;
    if (getRS(D3DRS_SEPARATEALPHABLENDENABLE) !== 0) {
        [aSrc, aDst] = fixupBoth(getRS(D3DRS_SRCBLENDALPHA), getRS(D3DRS_DESTBLENDALPHA));
        aOp = getRS(D3DRS_BLENDOPALPHA);
    }
    // The factors/ops resolved above are exactly what isD3D9BlendStateRepresentable would
    // re-derive; check them directly rather than walking the render states a second time.
    if (hasUnsupportedBlendFactor(cSrc) || hasUnsupportedBlendFactor(cDst)
        || hasUnsupportedBlendFactor(aSrc) || hasUnsupportedBlendFactor(aDst)) {
        throw new Error("D3D9 dual-source blending is not representable by WebGPU");
    }
    if (!isKnownBlendFactor(cSrc) || !isKnownBlendFactor(cDst)
        || !isKnownBlendFactor(aSrc) || !isKnownBlendFactor(aDst)
        || !isKnownBlendOperation(cOp) || !isKnownBlendOperation(aOp)) {
        throw new Error("D3D9 blend state contains an invalid factor or operation");
    }

    return {
        format,
        writeMask,
        blend: {
            color: { srcFactor: mapBlendFactor(cSrc), dstFactor: mapBlendFactor(cDst), operation: mapBlendOp(cOp) },
            alpha: { srcFactor: mapBlendFactor(aSrc), dstFactor: mapBlendFactor(aDst), operation: mapBlendOp(aOp) },
        },
    };
}

/**
 * Compact, stable cache key for the blend portion of the pipeline state. Folded
 * into the pipeline cache keys so a blend-mode change forces a fresh pipeline.
 */
export function computeBlendKey(getRS: GetRenderState): string {
    // D3D9's blend equation is shared by all render targets, but each target has
    // an independent write mask. Key all four even when only a subset is bound:
    // callers can use this fragment without separately reasoning about MRT state.
    const writeMasks = COLOR_WRITE_STATES.map(state => getRS(state) & 0xf).join(",");
    if (getRS(D3DRS_ALPHABLENDENABLE) === 0) return `n${writeMasks}`;
    const sep = getRS(D3DRS_SEPARATEALPHABLENDENABLE) !== 0 ? 1 : 0;
    // D3DRS_BLENDFACTOR is dynamic render-pass state and is applied with setBlendConstant
    // before each draw; changing it must reuse the same pipeline.
    return `b${getRS(D3DRS_SRCBLEND)},${getRS(D3DRS_DESTBLEND)},${getRS(D3DRS_BLENDOP)},${sep},`
        + `${getRS(D3DRS_SRCBLENDALPHA)},${getRS(D3DRS_DESTBLENDALPHA)},${getRS(D3DRS_BLENDOPALPHA)},`
        + `${writeMasks}`;
}

/** WebGPU has no second-source blend factor. Constant factors are lowered by the
 * render-pass blend-constant command. */
export function hasUnsupportedBlendFactor(factor: number): boolean {
    return hasDualSourceBlendFactor(factor);
}

// ── Depth state ───────────────────────────────────────────────────────────
export const D3DRS_ZENABLE = 7;
export const D3DRS_ZWRITEENABLE = 14;
export const D3DRS_ZFUNC = 23;
export const D3DRS_CULLMODE = 22;
/** D3D9 stencil states.  The executor uses depth24plus-stencil8 for the default and D24S8
 * paths, so the complete single- and two-sided state can be lowered here. */
export const D3DRS_STENCILENABLE = 52;
export const D3DRS_STENCILFAIL = 53;
export const D3DRS_STENCILZFAIL = 54;
export const D3DRS_STENCILPASS = 55;
export const D3DRS_STENCILFUNC = 56;
export const D3DRS_STENCILREF = 57;
export const D3DRS_STENCILMASK = 58;
export const D3DRS_STENCILWRITEMASK = 59;
export const D3DRS_TWOSIDEDSTENCILMODE = 185;
export const D3DRS_CCW_STENCILFAIL = 186;
export const D3DRS_CCW_STENCILZFAIL = 187;
export const D3DRS_CCW_STENCILPASS = 188;
export const D3DRS_CCW_STENCILFUNC = 189;
// Both are FLOATS bit-cast into the render-state DWORD, and both default to 0.0f.
export const D3DRS_SLOPESCALEDEPTHBIAS = 175;
export const D3DRS_DEPTHBIAS = 195;

/**
 * D3DRS_DEPTHBIAS is a bias in NORMALIZED depth ([0,1] of the buffer's range); WebGPU's
 * `depthBias` counts the smallest representable depth increment of the attachment format.
 * For our 24-bit depth attachment that increment is 2^-24, so the conversion is a plain
 * scale — the same one DXVK applies for UNORM depth formats.
 */
const DEPTH_BIAS_UNITS_PER_UNORM24 = 1 << 24;

const _biasBuf = new ArrayBuffer(4);
const _biasView = new DataView(_biasBuf);
function rsAsFloat(raw: number): number {
    _biasView.setUint32(0, raw >>> 0, true);
    const v = _biasView.getFloat32(0, true);
    // A DWORD holding a non-float (a game writing an integer into a float render state, or
    // an uninitialised slot) must not reach createRenderPipeline as NaN/Inf — WebGPU rejects
    // the pipeline and the draw disappears, which is the exact failure this code exists to fix.
    return Number.isFinite(v) ? v : 0;
}

const D3DCMP_TO_GPU: readonly GPUCompareFunction[] = [
    "less-equal", // 0 — not a D3DCMPFUNC; treat as the D3D9 default
    "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always",
];

const D3DSTENCILOP_TO_GPU: readonly GPUStencilOperation[] = [
    "keep", // 0 — invalid in D3D9; retain a safe default
    "keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert",
    "increment-wrap", "decrement-wrap",
];

function stencilOp(raw: number): GPUStencilOperation {
    return D3DSTENCILOP_TO_GPU[raw >>> 0] ?? "keep";
}

function stencilCompare(raw: number): GPUCompareFunction {
    return D3DCMP_TO_GPU[raw >>> 0] ?? "always";
}

function isD3D9CompareFunction(raw: number): boolean {
    const value = raw >>> 0;
    return value >= 1 && value <= 8;
}

function isD3D9StencilOperation(raw: number): boolean {
    const value = raw >>> 0;
    return value >= 1 && value <= 8;
}

/**
 * Validate depth/stencil and cull enums before a pipeline is built.  The descriptor builders
 * retain defensive fallbacks for callers that need a descriptor, but a D3D9 draw must not
 * silently turn an invalid active state into a different comparison or stencil operation.
 * States that D3D9 ignores while their feature is disabled are deliberately not inspected.
 */
export function isD3D9DepthStencilStateRepresentable(getRS: GetRenderState): boolean {
    const cull = getRS(D3DRS_CULLMODE) >>> 0;
    if (cull < 1 || cull > 3) return false; // NONE/CW/CCW

    const zEnable = getRS(D3DRS_ZENABLE) >>> 0;
    if (zEnable > 2) return false; // FALSE/TRUE/USEW (USEW is refused by the device policy)
    if (zEnable !== 0 && !isD3D9CompareFunction(getRS(D3DRS_ZFUNC))) return false;

    if (getRS(D3DRS_STENCILENABLE) === 0) return true;
    if (!isD3D9CompareFunction(getRS(D3DRS_STENCILFUNC))
        || !isD3D9StencilOperation(getRS(D3DRS_STENCILFAIL))
        || !isD3D9StencilOperation(getRS(D3DRS_STENCILZFAIL))
        || !isD3D9StencilOperation(getRS(D3DRS_STENCILPASS))) return false;
    if (getRS(D3DRS_TWOSIDEDSTENCILMODE) !== 0) {
        if (!isD3D9CompareFunction(getRS(D3DRS_CCW_STENCILFUNC))
            || !isD3D9StencilOperation(getRS(D3DRS_CCW_STENCILFAIL))
            || !isD3D9StencilOperation(getRS(D3DRS_CCW_STENCILZFAIL))
            || !isD3D9StencilOperation(getRS(D3DRS_CCW_STENCILPASS))) return false;
    }
    return true;
}

/**
 * Build the WebGPU depth-stencil descriptor for the current render state.
 *
 * D3DRS_ZFUNC is a first-class part of the state: engines that do their own
 * visibility (BSP/portal, painter-ordered passes) render most of the world with
 * D3DCMP_ALWAYS and still write depth for the passes that follow, so pinning the
 * comparison to LESSEQUAL silently rejects surfaces the game meant to overdraw.
 *
 * D3DZB_FALSE turns the z-buffer OFF — no test AND no write, whatever
 * D3DRS_ZWRITEENABLE says. Vulkan gets that for free ("depth writes are always
 * disabled when depthTestEnable is VK_FALSE", which is why DXVK can map the two
 * render states independently); WebGPU does not — depthCompare "always" with
 * depthWriteEnabled still writes — so the AND has to be explicit here.
 */
export function buildDepthStencilState(format: GPUTextureFormat, getRS: GetRenderState): GPUDepthStencilState {
    const zEnable = getRS(D3DRS_ZENABLE) !== 0; // D3DZB_TRUE(1) and D3DZB_USEW(2) both test
    const func = getRS(D3DRS_ZFUNC);
    const stencilEnabled = getRS(D3DRS_STENCILENABLE) !== 0;
    const twoSided = getRS(D3DRS_TWOSIDEDSTENCILMODE) !== 0;
    const front: GPUStencilFaceState = {
        compare: stencilCompare(getRS(D3DRS_STENCILFUNC)),
        failOp: stencilOp(getRS(D3DRS_STENCILFAIL)),
        depthFailOp: stencilOp(getRS(D3DRS_STENCILZFAIL)),
        passOp: stencilOp(getRS(D3DRS_STENCILPASS)),
    };
    const back: GPUStencilFaceState = twoSided ? {
        compare: stencilCompare(getRS(D3DRS_CCW_STENCILFUNC)),
        failOp: stencilOp(getRS(D3DRS_CCW_STENCILFAIL)),
        depthFailOp: stencilOp(getRS(D3DRS_CCW_STENCILZFAIL)),
        passOp: stencilOp(getRS(D3DRS_CCW_STENCILPASS)),
    } : front;
    return {
        format,
        depthWriteEnabled: zEnable && getRS(D3DRS_ZWRITEENABLE) !== 0,
        depthCompare: zEnable ? (D3DCMP_TO_GPU[func] ?? "less-equal") : "always",
        // We advertise D3DPRASTERCAPS_DEPTHBIAS + SLOPESCALEDEPTHBIAS, and a D3D8 title
        // reaching us through a d3d8to9 wrapper arrives here with its D3DRS_ZBIAS already
        // translated into these two — ignoring them puts every decal, shadow and road
        // marking back into a z-fight with the surface it was biased off.
        // Clamped to i32: the bias is a guest-supplied float, and a wild one scaled by 2^24
        // overflows the descriptor field — which fails pipeline creation and deletes the draw.
        depthBias: Math.max(-0x7fffffff, Math.min(0x7fffffff,
            Math.round(rsAsFloat(getRS(D3DRS_DEPTHBIAS)) * DEPTH_BIAS_UNITS_PER_UNORM24))),
        depthBiasSlopeScale: rsAsFloat(getRS(D3DRS_SLOPESCALEDEPTHBIAS)),
        depthBiasClamp: 0,
        stencilFront: stencilEnabled ? front : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
        // D3D9's single-sided stencil state applies to both winding directions.  `back` is
        // already the front state when TWOSIDEDSTENCILMODE is disabled.
        stencilBack: stencilEnabled ? back : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
        stencilReadMask: getRS(D3DRS_STENCILMASK) & 0xff,
        stencilWriteMask: getRS(D3DRS_STENCILWRITEMASK) & 0xff,
    };
}

/** Cache-key fragment for the depth portion — folded into the pipeline cache keys. */
export function computeDepthKey(getRS: GetRenderState): string {
    // The bias states key the cache whether or not the z-buffer is on: they live in the
    // pipeline, so a game that biases with ZENABLE off would otherwise reuse an unbiased one.
    const bias = `${getRS(D3DRS_DEPTHBIAS) >>> 0}.${getRS(D3DRS_SLOPESCALEDEPTHBIAS) >>> 0}`;
    const stencil = `${getRS(D3DRS_STENCILENABLE) !== 0 ? 1 : 0}.${getRS(D3DRS_TWOSIDEDSTENCILMODE) !== 0 ? 1 : 0}` +
        `.${getRS(D3DRS_STENCILFAIL)}.${getRS(D3DRS_STENCILZFAIL)}.${getRS(D3DRS_STENCILPASS)}.${getRS(D3DRS_STENCILFUNC)}` +
        `.${getRS(D3DRS_CCW_STENCILFAIL)}.${getRS(D3DRS_CCW_STENCILZFAIL)}.${getRS(D3DRS_CCW_STENCILPASS)}.${getRS(D3DRS_CCW_STENCILFUNC)}` +
        `.${getRS(D3DRS_STENCILMASK) >>> 0}.${getRS(D3DRS_STENCILWRITEMASK) >>> 0}`;
    if (getRS(D3DRS_ZENABLE) === 0) return `z0!${bias}!s${stencil}`;
    return `z${getRS(D3DRS_ZWRITEENABLE) !== 0 ? 1 : 0}.${getRS(D3DRS_ZFUNC)}!${bias}!s${stencil}`;
}

/** True when the requested raster state needs a stencil attachment we do not own. */
export function hasUnsupportedStencilState(getRS: GetRenderState, format?: GPUTextureFormat): boolean {
    const enabled = getRS(D3DRS_STENCILENABLE) !== 0 || getRS(D3DRS_TWOSIDEDSTENCILMODE) !== 0;
    if (!enabled) return false;
    // Callers without format information retain the historical conservative answer.  Device
    // callers pass the active attachment format and can use D24S8/depth24plus-stencil8.
    return format === undefined ? true : format !== "depth24plus-stencil8";
}
