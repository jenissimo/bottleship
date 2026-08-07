/**
 * Faithful D3D9 alpha-blend render-state → WebGPU GPUColorTargetState.
 *
 * D3D9 fixed-function blending is configured entirely through render states
 * (D3DRS_ALPHABLENDENABLE / SRCBLEND / DESTBLEND / BLENDOP, the separate-alpha
 * variants, and COLORWRITEENABLE). WebGPU bakes the equivalent state into the
 * render pipeline's color-target descriptor, so the blend state is part of the
 * pipeline cache key (see d3d9-device.ts).
 *
 * Reference: DXVK src/d3d9/d3d9_util.cpp DecodeBlendFactor / DecodeBlendOp and
 * d3d9_util.h FixupBlendState (the DirectX-6 BOTH*SRCALPHA legacy fixup).
 */

/** Reads a D3D9 render-state value (index → DWORD). */
export type GetRenderState = (state: number) => number;

// ── Render-state indices ──────────────────────────────────────────────────
export const D3DRS_SRCBLEND = 19;
export const D3DRS_DESTBLEND = 20;
export const D3DRS_ALPHABLENDENABLE = 27;
export const D3DRS_BLENDOP = 171;
export const D3DRS_COLORWRITEENABLE = 168;
export const D3DRS_SEPARATEALPHABLENDENABLE = 206;
export const D3DRS_SRCBLENDALPHA = 207;
export const D3DRS_DESTBLENDALPHA = 208;
export const D3DRS_BLENDOPALPHA = 209;

// ── D3DBLEND ──────────────────────────────────────────────────────────────
const D3DBLEND_ZERO = 1;
const D3DBLEND_ONE = 2;
const D3DBLEND_SRCCOLOR = 3;
const D3DBLEND_INVSRCCOLOR = 4;
const D3DBLEND_SRCALPHA = 5;
const D3DBLEND_INVSRCALPHA = 6;
const D3DBLEND_DESTALPHA = 7;
const D3DBLEND_INVDESTALPHA = 8;
const D3DBLEND_DESTCOLOR = 9;
const D3DBLEND_INVDESTCOLOR = 10;
const D3DBLEND_SRCALPHASAT = 11;
const D3DBLEND_BOTHSRCALPHA = 12;
const D3DBLEND_BOTHINVSRCALPHA = 13;
const D3DBLEND_BLENDFACTOR = 14;
const D3DBLEND_INVBLENDFACTOR = 15;
const D3DBLEND_SRCCOLOR2 = 16;
const D3DBLEND_INVSRCCOLOR2 = 17;

// ── D3DBLENDOP ────────────────────────────────────────────────────────────
const D3DBLENDOP_ADD = 1;
const D3DBLENDOP_SUBTRACT = 2;
const D3DBLENDOP_REVSUBTRACT = 3;
const D3DBLENDOP_MIN = 4;
const D3DBLENDOP_MAX = 5;

/**
 * Map a D3DBLEND factor to its WebGPU equivalent. Unlike Vulkan, WebGPU has a
 * single CONSTANT factor (no separate constant-alpha), so the `isAlpha` hint is
 * only used to keep parity with the reference; both collapse to "constant".
 * Dual-source (SRCCOLOR2/INVSRCCOLOR2) needs the dual-source-blending feature we
 * do not enable — fall back to the single-source colour factor.
 */
function mapBlendFactor(factor: number): GPUBlendFactor {
    switch (factor) {
        case D3DBLEND_ZERO: return "zero";
        case D3DBLEND_ONE: return "one";
        case D3DBLEND_SRCCOLOR: return "src";
        case D3DBLEND_INVSRCCOLOR: return "one-minus-src";
        case D3DBLEND_SRCALPHA: return "src-alpha";
        case D3DBLEND_INVSRCALPHA: return "one-minus-src-alpha";
        case D3DBLEND_DESTALPHA: return "dst-alpha";
        case D3DBLEND_INVDESTALPHA: return "one-minus-dst-alpha";
        case D3DBLEND_DESTCOLOR: return "dst";
        case D3DBLEND_INVDESTCOLOR: return "one-minus-dst";
        case D3DBLEND_SRCALPHASAT: return "src-alpha-saturated";
        case D3DBLEND_BLENDFACTOR: return "constant";
        case D3DBLEND_INVBLENDFACTOR: return "one-minus-constant";
        case D3DBLEND_SRCCOLOR2: return "src";            // dual-source unsupported
        case D3DBLEND_INVSRCCOLOR2: return "one-minus-src";
        default: return "one";
    }
}

function mapBlendOp(op: number): GPUBlendOperation {
    switch (op) {
        case D3DBLENDOP_ADD: return "add";
        case D3DBLENDOP_SUBTRACT: return "subtract";
        case D3DBLENDOP_REVSUBTRACT: return "reverse-subtract";
        case D3DBLENDOP_MIN: return "min";
        case D3DBLENDOP_MAX: return "max";
        default: return "add";
    }
}

/**
 * Apply the DirectX-6 legacy fixup: D3DBLEND_BOTH*SRCALPHA as the source factor
 * implicitly forces the destination factor (it predates separate src/dst).
 * Returns the effective [src, dst] pair.
 */
function fixupBoth(src: number, dst: number): [number, number] {
    if (src === D3DBLEND_BOTHSRCALPHA) return [D3DBLEND_SRCALPHA, D3DBLEND_INVSRCALPHA];
    if (src === D3DBLEND_BOTHINVSRCALPHA) return [D3DBLEND_INVSRCALPHA, D3DBLEND_SRCALPHA];
    return [src, dst];
}

/**
 * Build the WebGPU colour-target descriptor (format + write-mask + optional
 * blend) for the current render state. When D3DRS_ALPHABLENDENABLE is FALSE no
 * blend object is attached (fully opaque, the WebGPU default).
 */
export function buildColorTargetState(format: GPUTextureFormat, getRS: GetRenderState): GPUColorTargetState {
    const writeMask = getRS(D3DRS_COLORWRITEENABLE) & 0xf;
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
    const writeMask = getRS(D3DRS_COLORWRITEENABLE) & 0xf;
    if (getRS(D3DRS_ALPHABLENDENABLE) === 0) return `n${writeMask}`;
    const sep = getRS(D3DRS_SEPARATEALPHABLENDENABLE) !== 0 ? 1 : 0;
    return `b${getRS(D3DRS_SRCBLEND)},${getRS(D3DRS_DESTBLEND)},${getRS(D3DRS_BLENDOP)},${sep},`
        + `${getRS(D3DRS_SRCBLENDALPHA)},${getRS(D3DRS_DESTBLENDALPHA)},${getRS(D3DRS_BLENDOPALPHA)},${writeMask}`;
}

// ── Depth state ───────────────────────────────────────────────────────────
export const D3DRS_ZENABLE = 7;
export const D3DRS_ZWRITEENABLE = 14;
export const D3DRS_ZFUNC = 23;

const D3DCMP_TO_GPU: readonly GPUCompareFunction[] = [
    "less-equal", // 0 — not a D3DCMPFUNC; treat as the D3D9 default
    "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always",
];

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
    return {
        format,
        depthWriteEnabled: zEnable && getRS(D3DRS_ZWRITEENABLE) !== 0,
        depthCompare: zEnable ? (D3DCMP_TO_GPU[func] ?? "less-equal") : "always",
    };
}

/** Cache-key fragment for the depth portion — folded into the pipeline cache keys. */
export function computeDepthKey(getRS: GetRenderState): string {
    if (getRS(D3DRS_ZENABLE) === 0) return "z0";
    return `z${getRS(D3DRS_ZWRITEENABLE) !== 0 ? 1 : 0}.${getRS(D3DRS_ZFUNC)}`;
}
