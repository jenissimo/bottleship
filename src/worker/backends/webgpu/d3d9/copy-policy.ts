import { isBlockCompressedFormat } from "../shared/texture-formats";
import {
    isDxDepthStencilFormat,
    isDxUnsupportedFormat,
} from "../shared/dx-format-support";
import { resolveD3D9StretchRectMsaaPolicy } from "./multisample";
import { isD3D9CpuCopyDestinationFormat } from "./copy-cpu";

const D3DPOOL_DEFAULT = 0;
const D3DUSAGE_RENDERTARGET = 0x00000001;
const D3DUSAGE_DEPTHSTENCIL = 0x00000002;

export interface D3D9CopySurfaceInfo {
    format: number;
    usage: number;
    pool: number;
    width: number;
    height: number;
    multiSampleType: number;
    texturePtr?: number;
    face?: number;
    level?: number;
    /** True only for CreateOffscreenPlainSurface's standalone surface object. */
    offscreenPlain?: boolean;
}

export interface D3D9CopyRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface D3D9StretchRectDecision {
    supported: boolean;
    requiresResolve: boolean;
    cpuPath: boolean;
    stretch: boolean;
    reason: string | null;
}

function reject(reason: string): D3D9StretchRectDecision {
    return { supported: false, requiresResolve: false, cpuPath: false, stretch: false, reason };
}

function fullRect(surface: D3D9CopySurfaceInfo, rect: D3D9CopyRect | null | undefined): D3D9CopyRect {
    return rect ?? { left: 0, top: 0, right: surface.width, bottom: surface.height };
}

function validRect(surface: D3D9CopySurfaceInfo, rect: D3D9CopyRect): boolean {
    return Number.isInteger(rect.left) && Number.isInteger(rect.top) &&
        Number.isInteger(rect.right) && Number.isInteger(rect.bottom) &&
        rect.left >= 0 && rect.top >= 0 && rect.right <= surface.width && rect.bottom <= surface.height &&
        rect.right > rect.left && rect.bottom > rect.top;
}

/**
 * Shared legal-operation gate for IDirect3DDevice9::StretchRect.
 *
 * This mirrors DXVK's important distinction between a DEFAULT render-target
 * blit and a DEFAULT offscreen-plain CPU copy. Offscreen destinations are
 * accepted for either an offscreen source or a single-sample render-target
 * source; the latter is lowered through an explicit GPU readback before the
 * CPU scale/encode path, because ordinary texture views are not render
 * attachments. MSAA/depth/compressed cases remain explicit refusals.
 */
export function resolveD3D9StretchRectPolicy(
    source: D3D9CopySurfaceInfo,
    destination: D3D9CopySurfaceInfo,
    filter: number,
    sourceRect?: D3D9CopyRect | null,
    destinationRect?: D3D9CopyRect | null,
): D3D9StretchRectDecision {
    if (filter !== 0 && filter !== 1 && filter !== 2) return reject("invalid StretchRect filter");
    if (source.texturePtr !== undefined && destination.texturePtr !== undefined &&
        source.texturePtr === destination.texturePtr && (source.face ?? -1) === (destination.face ?? -1) &&
        (source.level ?? 0) === (destination.level ?? 0)) {
        return reject("source and destination are the same subresource");
    }
    if (source.pool !== D3DPOOL_DEFAULT || destination.pool !== D3DPOOL_DEFAULT) {
        return reject("StretchRect requires DEFAULT-pool surfaces");
    }
    if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) {
        return reject("degenerate surface extent");
    }
    const srcRect = fullRect(source, sourceRect);
    const dstRect = fullRect(destination, destinationRect);
    if (!validRect(source, srcRect) || !validRect(destination, dstRect)) return reject("rectangle outside surface");
    const stretch = (srcRect.right - srcRect.left) !== (dstRect.right - dstRect.left) ||
        (srcRect.bottom - srcRect.top) !== (dstRect.bottom - dstRect.top);

    const sourceDepth = (source.usage & D3DUSAGE_DEPTHSTENCIL) !== 0 || isDxDepthStencilFormat(source.format, 9);
    const destinationDepth = (destination.usage & D3DUSAGE_DEPTHSTENCIL) !== 0 || isDxDepthStencilFormat(destination.format, 9);
    if (sourceDepth || destinationDepth) {
        // The current WebGPU blit has no depth/stencil conversion or resolve
        // target. Do not report success for a copy that would lose depth data.
        return reject("depth/stencil StretchRect is not backed by a copy path");
    }
    if (source.format === 0 || destination.format === 0 ||
        isDxUnsupportedFormat(source.format, 9) || isDxUnsupportedFormat(destination.format, 9)) {
        return reject("format has no faithful D3D9 storage path");
    }
    if (isBlockCompressedFormat(destination.format)) {
        return reject("compressed destination cannot be authored by the blit path");
    }

    const destinationIsRenderTarget = (destination.usage & D3DUSAGE_RENDERTARGET) !== 0;
    const sourceIsOffscreen = source.offscreenPlain === true;
    const destinationIsOffscreen = destination.offscreenPlain === true;
    if (destinationIsOffscreen) {
        // DXVK permits a DEFAULT render-target source to be copied into a
        // DEFAULT offscreen-plain surface.  The backend performs this through
        // an explicit GPU readback + CPU encode; ordinary non-RT textures are
        // still not legal StretchRect sources.
        const sourceIsRenderTarget = (source.usage & D3DUSAGE_RENDERTARGET) !== 0;
        if (!sourceIsOffscreen && !sourceIsRenderTarget) {
            return reject("source is neither an offscreen surface nor a render target");
        }
        if (!isD3D9CpuCopyDestinationFormat(destination.format)) {
            return reject("offscreen destination format has no CPU encoder");
        }
    } else if (!destinationIsRenderTarget) {
        return reject("destination is not a render target surface");
    }

    const msaa = resolveD3D9StretchRectMsaaPolicy(source.multiSampleType, destination.multiSampleType);
    if (!msaa.supported) return reject(msaa.reason ?? "unsupported multisample pair");
    if (destinationIsOffscreen && msaa.requiresResolve) {
        return reject("CPU offscreen path cannot consume an MSAA source");
    }

    return {
        supported: true,
        requiresResolve: msaa.requiresResolve,
        cpuPath: destinationIsOffscreen,
        stretch,
        reason: null,
    };
}
