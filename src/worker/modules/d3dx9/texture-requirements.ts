/**
 * D3DXCheckTextureRequirements / D3DXCheckCubeTextureRequirements /
 * D3DXCheckVolumeTextureRequirements.
 *
 * "Given what I want, what will the device actually give me?" — the call a title makes
 * BEFORE CreateTexture, then passes the adjusted values straight through. Refusing it
 * leaves the caller with whatever it had on the stack: D3DX_DEFAULT as a width, an
 * UNKNOWN format, and a CreateTexture that fails for reasons the caller cannot see.
 *
 * Every value is in/out: we clamp to the device's limits, resolve the defaults, and
 * substitute a supported format for one the device refuses — which is exactly what the
 * shipped d3dx9 does, and why the caller never checks the numbers afterwards.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { devices } from '../d3d9/shared-state';
import { checkDxDeviceFormat } from '../../backends/webgpu/shared/dx-format-support';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DX_DEFAULT = 0xffffffff;

const D3DFMT_UNKNOWN = 0;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;

const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DDEVTYPE_HAL = 1;

/** D3DX's own default when the caller asks for one and gives nothing to derive it from. */
const DEFAULT_EXTENT = 256;
/** What our device advertises; the caps blob is the authority, this is the fallback. */
const MAX_EXTENT = 8192;
const MAX_VOLUME_EXTENT = 2048;

/** Full mip chain length for an extent — ceil(log2(max)) + 1. */
function fullMipLevels(...extents: number[]): number {
    let levels = 1;
    let n = Math.max(1, ...extents);
    while (n > 1) { n >>= 1; levels++; }
    return levels;
}

/** Read an in/out UINT, treating a NULL pointer as "caller does not care". */
function readOpt(ptr: number): number | null {
    if (!ptr) return null;
    const v = Mem.readUint32(ptr >>> 0);
    return v === null ? null : v >>> 0;
}

/**
 * A format the device can actually hold a texture in.
 *
 * D3DFMT_UNKNOWN means "pick for me"; a format the device refuses is replaced rather
 * than reported, because the caller passes the result straight to CreateTexture and a
 * refusal it never reads becomes a texture it never gets.
 */
function resolveFormat(requested: number, usage: number, rType: number): number {
    if (requested === D3DFMT_UNKNOWN || requested === D3DX_DEFAULT) return D3DFMT_A8R8G8B8;
    const ok = checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, requested);
    return ok === D3D_OK ? requested : D3DFMT_A8R8G8B8;
}

/** Largest extent this device will hold, from its own caps when it has published them. */
function maxExtent(devicePtr: number, volume: boolean): number {
    const device = devices.get(devicePtr >>> 0) as unknown as {
        getCaps?: () => { MaxTextureWidth?: number; MaxVolumeExtent?: number } | null;
    } | undefined;
    const caps = device?.getCaps?.() ?? null;
    if (volume) return caps?.MaxVolumeExtent || MAX_VOLUME_EXTENT;
    return caps?.MaxTextureWidth || MAX_EXTENT;
}

interface Requirements {
    /** Guest pointers, in the argument order of the call being served. */
    pWidth: number;
    pHeight: number;
    pDepth: number;
    pMipLevels: number;
    pFormat: number;
    usage: number;
    rType: number;
    devicePtr: number;
    /** Cube textures are square by definition — height follows width. */
    square: boolean;
}

function adjust(r: Requirements): number {
    if (!devices.get(r.devicePtr >>> 0)) return D3DERR_INVALIDCALL;
    const limit = maxExtent(r.devicePtr, r.rType === D3DRTYPE_VOLUMETEXTURE);

    const clamp = (v: number | null): number | null => {
        if (v === null) return null;
        if (v === 0 || v === D3DX_DEFAULT) return null;   // "you decide" — resolved below
        return Math.max(1, Math.min(v, limit));
    };

    let width = clamp(readOpt(r.pWidth));
    let height = clamp(readOpt(r.pHeight));
    let depth = clamp(readOpt(r.pDepth));

    // D3DX derives an unspecified dimension from the one that WAS given, and falls back to
    // 256 only when neither was.
    if (width === null && height === null) { width = DEFAULT_EXTENT; height = DEFAULT_EXTENT; }
    else if (width === null) width = height;
    else if (height === null) height = width;
    if (r.square) height = width;
    if (r.pDepth && depth === null) depth = 1;

    const format = resolveFormat(readOpt(r.pFormat) ?? D3DFMT_UNKNOWN, r.usage, r.rType);

    const maxLevels = fullMipLevels(width!, height!, depth ?? 1);
    const requestedLevels = readOpt(r.pMipLevels);
    // 0 and D3DX_DEFAULT both mean "the whole chain"; anything else is clamped to what
    // the size can actually carry.
    const mipLevels = requestedLevels === null || requestedLevels === 0 || requestedLevels === D3DX_DEFAULT
        ? maxLevels
        : Math.max(1, Math.min(requestedLevels, maxLevels));

    if (r.pWidth && !Mem.writeUint32(r.pWidth, width!)) return D3DERR_INVALIDCALL;
    if (r.pHeight && !Mem.writeUint32(r.pHeight, height!)) return D3DERR_INVALIDCALL;
    if (r.pDepth && !Mem.writeUint32(r.pDepth, depth!)) return D3DERR_INVALIDCALL;
    if (r.pMipLevels && !Mem.writeUint32(r.pMipLevels, mipLevels)) return D3DERR_INVALIDCALL;
    if (r.pFormat && !Mem.writeUint32(r.pFormat, format)) return D3DERR_INVALIDCALL;
    return D3D_OK;
}

export function createTextureRequirementExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // (pDevice, pWidth, pHeight, pMipLevels, Usage, pFormat, Pool)
    exports['D3DXCheckTextureRequirements'] = (_ctx, _mem, args) => {
        const hr = adjust({
            devicePtr: args[0] >>> 0,
            pWidth: args[1] >>> 0, pHeight: args[2] >>> 0, pDepth: 0,
            pMipLevels: args[3] >>> 0, usage: args[4] >>> 0, pFormat: args[5] >>> 0,
            rType: D3DRTYPE_TEXTURE, square: false,
        });
        Logger.verbose(LogCategory.D3D9, `D3DXCheckTextureRequirements -> 0x${(hr >>> 0).toString(16)}`);
        return hr;
    };

    // (pDevice, pSize, pMipLevels, Usage, pFormat, Pool) — one extent, six faces.
    exports['D3DXCheckCubeTextureRequirements'] = (_ctx, _mem, args) => adjust({
        devicePtr: args[0] >>> 0,
        pWidth: args[1] >>> 0, pHeight: 0, pDepth: 0,
        pMipLevels: args[2] >>> 0, usage: args[3] >>> 0, pFormat: args[4] >>> 0,
        rType: D3DRTYPE_CUBETEXTURE, square: true,
    });

    // (pDevice, pWidth, pHeight, pDepth, pMipLevels, Usage, pFormat, Pool)
    exports['D3DXCheckVolumeTextureRequirements'] = (_ctx, _mem, args) => adjust({
        devicePtr: args[0] >>> 0,
        pWidth: args[1] >>> 0, pHeight: args[2] >>> 0, pDepth: args[3] >>> 0,
        pMipLevels: args[4] >>> 0, usage: args[5] >>> 0, pFormat: args[6] >>> 0,
        rType: D3DRTYPE_VOLUMETEXTURE, square: false,
    });

    return exports;
}
