/**
 * D3DBLEND / D3DBLENDOP → WebGPU mapping, shared by every fixed-function blend path
 * (D3D9, and DirectDraw/D3D3-8 FFP via ddraw/pipeline-factory.ts). The enum values and
 * the DirectX-6 BOTH*SRCALPHA legacy fixup are identical across D3D3 through D3D9 —
 * one definition, multiple callers, per CLAUDE.md's unification direction.
 *
 * Reference: DXVK src/d3d9/d3d9_util.cpp DecodeBlendFactor / DecodeBlendOp and
 * d3d9_util.h FixupBlendState (the DirectX-6 BOTH*SRCALPHA legacy fixup); confirmed
 * against G:/sources/dxvk/src/d3d8/d3d8_device.cpp FixupBlendState for the D3D8 port.
 */

// ── D3DBLEND ──────────────────────────────────────────────────────────────
export const D3DBLEND_ZERO = 1;
export const D3DBLEND_ONE = 2;
export const D3DBLEND_SRCCOLOR = 3;
export const D3DBLEND_INVSRCCOLOR = 4;
export const D3DBLEND_SRCALPHA = 5;
export const D3DBLEND_INVSRCALPHA = 6;
export const D3DBLEND_DESTALPHA = 7;
export const D3DBLEND_INVDESTALPHA = 8;
export const D3DBLEND_DESTCOLOR = 9;
export const D3DBLEND_INVDESTCOLOR = 10;
export const D3DBLEND_SRCALPHASAT = 11;
export const D3DBLEND_BOTHSRCALPHA = 12;
export const D3DBLEND_BOTHINVSRCALPHA = 13;
export const D3DBLEND_BLENDFACTOR = 14;
export const D3DBLEND_INVBLENDFACTOR = 15;
export const D3DBLEND_SRCCOLOR2 = 16;
export const D3DBLEND_INVSRCCOLOR2 = 17;

// ── D3DBLENDOP ────────────────────────────────────────────────────────────
export const D3DBLENDOP_ADD = 1;
export const D3DBLENDOP_SUBTRACT = 2;
export const D3DBLENDOP_REVSUBTRACT = 3;
export const D3DBLENDOP_MIN = 4;
export const D3DBLENDOP_MAX = 5;

/**
 * Map a D3DBLEND factor to its WebGPU equivalent. Unlike Vulkan, WebGPU has a
 * single CONSTANT factor (no separate constant-alpha), so the `isAlpha` hint some
 * callers reason about collapses to "constant" either way.
 * Dual-source (SRCCOLOR2/INVSRCCOLOR2) needs a feature this backend does not enable;
 * callers must reject it (see `hasDualSourceBlendFactor`) before a pipeline is built.
 * `factor` MUST already be a known value (see `isKnownBlendFactor`) — callers own
 * refusing an out-of-range enum instead of letting it fall through to a default.
 */
export function mapBlendFactor(factor: number): GPUBlendFactor {
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
        // BOTH*SRCALPHA is only legal as a SOURCE factor, where fixupBoth has already
        // rewritten it. A guest that names one as DESTBLEND is out of contract, and D3D9
        // drivers decode it rather than fail the draw — mapping it the way DXVK does keeps
        // a bad state word from throwing out of pipeline creation and taking the frame.
        case D3DBLEND_BOTHSRCALPHA: return "src-alpha";
        case D3DBLEND_BOTHINVSRCALPHA: return "one-minus-src-alpha";
        case D3DBLEND_BLENDFACTOR: return "constant";
        case D3DBLEND_INVBLENDFACTOR: return "one-minus-constant";
        case D3DBLEND_SRCCOLOR2: return "src";            // dual-source unsupported
        case D3DBLEND_INVSRCCOLOR2: return "one-minus-src";
        default:
            throw new RangeError(`Unknown D3DBLEND factor ${factor}`);
    }
}

/** `op` MUST already be a known value (see `isKnownBlendOperation`). */
export function mapBlendOp(op: number): GPUBlendOperation {
    switch (op) {
        case D3DBLENDOP_ADD: return "add";
        case D3DBLENDOP_SUBTRACT: return "subtract";
        case D3DBLENDOP_REVSUBTRACT: return "reverse-subtract";
        case D3DBLENDOP_MIN: return "min";
        case D3DBLENDOP_MAX: return "max";
        default:
            throw new RangeError(`Unknown D3DBLENDOP ${op}`);
    }
}

/**
 * Apply the DirectX-6 legacy fixup: D3DBLEND_BOTH*SRCALPHA as the source factor
 * implicitly forces the destination factor (it predates separate src/dst) — the
 * DESTBLEND render state is ignored outright when SRCBLEND names one of these.
 * Returns the effective [src, dst] pair.
 */
export function fixupBoth(src: number, dst: number): [number, number] {
    if (src === D3DBLEND_BOTHSRCALPHA) return [D3DBLEND_SRCALPHA, D3DBLEND_INVSRCALPHA];
    if (src === D3DBLEND_BOTHINVSRCALPHA) return [D3DBLEND_INVSRCALPHA, D3DBLEND_SRCALPHA];
    return [src, dst];
}

export function isKnownBlendFactor(factor: number): boolean {
    const normalized = factor >>> 0;
    return normalized >= D3DBLEND_ZERO && normalized <= D3DBLEND_INVSRCCOLOR2;
}

export function isKnownBlendOperation(op: number): boolean {
    const normalized = op >>> 0;
    return normalized >= D3DBLENDOP_ADD && normalized <= D3DBLENDOP_MAX;
}

export function hasDualSourceBlendFactor(factor: number): boolean {
    return factor === D3DBLEND_SRCCOLOR2 || factor === D3DBLEND_INVSRCCOLOR2;
}
