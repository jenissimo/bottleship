/**
 * D3DX texture loaders and mip filtering.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import {
    createGuestTexture,
    D3D_OK,
    D3DERR_INVALIDCALL,
    D3DFMT_A8R8G8B8,
} from '../d3d9/resource-registry';
import { d3dxFilterTexture, uploadDdsCubeFaces, uploadDdsLevels, uploadRgbaToTexture } from '../d3d9/d3dx-bridge';
import { createGuestVolumeTexture } from '../d3d9/volume';
import { createGuestCubeTexture } from '../d3d9/resources';
import { getVolumeLevel } from '../d3d9/volume-resources';
import { decodeImageBytes, imageFileFormatOf, loadImageFromVfs, readDdsInfo, ImageFileFormat } from './image-decode';
import { isBlockCompressedFormat, isD3DFloatFormat } from '../../backends/webgpu/shared/texture-formats';

const D3DPOOL_MANAGED = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DXIFF_FORCE_DWORD = 0xffffffff;
const D3DX_DEFAULT = 0xffffffff;

type DecodedImage = { width: number; height: number; rgba: Uint8Array; mipLevels: number };

/** Apply the *Ex MipLevels argument: 0 / D3DX_DEFAULT → full chain (decoded default); N → min(N, full). */
function withMipLevels(decoded: DecodedImage, mipLevelsArg: number): DecodedImage {
    if (mipLevelsArg === 0 || mipLevelsArg === D3DX_DEFAULT) return decoded;
    return { ...decoded, mipLevels: Math.max(1, Math.min(mipLevelsArg, decoded.mipLevels)) };
}
/**
 * D3DXIMAGE_INFO, as DWORDs: {Width, Height, Depth, MipLevels, Format, ResourceType,
 * ImageFileFormat}. SEVEN of them, and nothing follows — there is no Pool member.
 *
 * `Format` and `ImageFileFormat` describe the FILE, not the texture we go on to create from
 * it, and an engine switches on both (and on ResourceType, to pick its 2D/volume/cube loader).
 * A placeholder in ImageFileFormat is what makes a title index its loader table with
 * 0xffffffff and call through the garbage it reads there.
 *
 * The LENGTH is load-bearing: callers declare the struct as a local and the compiler packs the
 * next thing right behind it, so an eighth DWORD overwrites a caller local — a saved return
 * address among them.
 */
export function imageInfoWords(
    width: number,
    height: number,
    mipLevels: number,
    format = D3DFMT_A8R8G8B8,
    fileFormat = D3DXIFF_FORCE_DWORD,
    depth = 1,
    resourceType = D3DRTYPE_TEXTURE,
): Uint32Array {
    return Uint32Array.of(width, height, depth, mipLevels, format, resourceType, fileFormat);
}

function writeImageInfo(
    ptr: number,
    width: number,
    height: number,
    mipLevels: number,
    format = D3DFMT_A8R8G8B8,
    fileFormat = D3DXIFF_FORCE_DWORD,
    depth = 1,
    resourceType = D3DRTYPE_TEXTURE,
): boolean {
    if (!ptr) return false;
    const words = imageInfoWords(width, height, mipLevels, format, fileFormat, depth, resourceType);
    for (let i = 0; i < words.length; i++) {
        if (!Mem.writeUint32(ptr + i * 4, words[i]!)) return false;
    }
    return true;
}

type ImageDescription = {
    width: number; height: number; depth: number; mipLevels: number;
    format: number; resourceType: number; fileFormat: number;
};

/**
 * Describe a blob the way d3dx does: from its HEADER. A DDS needs no decode at all, which is
 * what lets the info query answer synchronously — and a synchronous answer is not just faster:
 * an async thunk parks the calling thread and lets every other guest thread run inside what the
 * app wrote as a straight-line call.
 */
function describeImageSync(data: Uint8Array): ImageDescription | null {
    if (imageFileFormatOf(data) !== ImageFileFormat.Dds) return null;
    const dds = readDdsInfo(data);
    if (!dds) return null;
    // Both halves are the file's own: an engine picks its loader from the CONTAINER and then
    // passes `Format` straight back into CreateTextureFromFileInMemoryEx before reading
    // GetLevelDesc to check. Those three have to agree, which is why the loader below keeps a
    // compressed file compressed instead of decoding it to RGBA.
    //
    // MipLevels describes the FILE, so it is the header's count: what the payload happens to
    // carry is the loader's business, and the info query is answered from a header window
    // that does not contain the payload at all.
    return { ...dds, mipLevels: dds.claimedMipLevels, fileFormat: ImageFileFormat.Dds };
}

/** The containers whose dimensions only a decode can answer. */
async function describeImage(data: Uint8Array): Promise<ImageDescription | null> {
    const sync = describeImageSync(data);
    if (sync) return sync;
    const fileFormat = imageFileFormatOf(data);
    const decoded = await decodeImageBytes(data);
    if (!decoded) return null;
    return {
        width: decoded.width,
        height: decoded.height,
        depth: 1,
        mipLevels: decoded.mipLevels,
        format: D3DFMT_A8R8G8B8,
        resourceType: D3DRTYPE_TEXTURE,
        fileFormat: fileFormat ?? D3DXIFF_FORCE_DWORD,
    };
}

/**
 * The *Ex overloads let the caller name a Usage and a Pool, and an engine reads both back off
 * GetLevelDesc to decide how it will use the texture — whether it must be re-created on a lost
 * device, whether it may lock it. Answering MANAGED for a DEFAULT request describes a different
 * object than the one the caller asked for. D3DX_DEFAULT (and 0 for Pool) means MANAGED.
 */
async function createTextureFromDecoded(
    devicePtr: number,
    ppTexture: number,
    decoded: { width: number; height: number; rgba: Uint8Array; mipLevels: number },
    usage = 0,
    pool = D3DPOOL_MANAGED,
): Promise<number> {
    const hr = createGuestTexture(
        devicePtr,
        decoded.width,
        decoded.height,
        decoded.mipLevels,
        usage === D3DX_DEFAULT ? 0 : usage,
        D3DFMT_A8R8G8B8,
        pool === D3DX_DEFAULT ? D3DPOOL_MANAGED : pool,
        ppTexture,
    );
    if (hr !== D3D_OK || !ppTexture) return hr;

    const texPtr = Mem.readUint32(ppTexture) ?? 0;
    if (!texPtr || !uploadRgbaToTexture(texPtr, decoded.width, decoded.height, decoded.rgba)) {
        return D3DERR_INVALIDCALL;
    }

    const filterHr = d3dxFilterTexture(texPtr, 0, 0);
    if (filterHr !== D3D_OK) {
        Logger.warn(LogCategory.D3D9, `d3dx9: mip filter after load returned 0x${filterHr.toString(16)}`);
    }
    return D3D_OK;
}

/** One line per format we were asked for and did not create, however many textures use it. */
const substitutedFormats = new Set<number>();

/**
 * The first few answers to an image-info query, in full. An engine SWITCHES on these — the
 * container picks its loader, the format and dimensions are passed back into the create call —
 * so when a title takes an unexpected path, what we told it is the first thing to read.
 */
let infoAnswersLogged = 0;

function noteImageInfo(info: ImageDescription, source: string): void {
    if (infoAnswersLogged >= 8) return;
    infoAnswersLogged++;
    Logger.log(
        LogCategory.D3D9,
        `d3dx9: ${source} -> ${info.width}x${info.height} mips=${info.mipLevels} ` +
        `format=${info.format} fileFormat=${info.fileFormat}`,
    );
}

/**
 * What each D3DXCreateTexture* call actually produced. An engine's own loader treats a failed
 * create as "asset missing" and substitutes a placeholder, so a refusal here is invisible
 * downstream: no fault, no warning, just a scene textured with the game's own error colour.
 * Reasons are free-form.
 */
const textureCreateOutcomes: Record<string, number> = {};

/** Reasons embed header bytes, so a stream of garbage blobs would coin a key each. */
const MAX_OUTCOME_KEYS = 64;

export function noteTextureCreate(outcome: string): void {
    const key = textureCreateOutcomes[outcome] === undefined
        && Object.keys(textureCreateOutcomes).length >= MAX_OUTCOME_KEYS
        ? "other"
        : outcome;
    textureCreateOutcomes[key] = (textureCreateOutcomes[key] ?? 0) + 1;
}

export function d3dxTextureCreateOutcomes(): Record<string, number> {
    return { ...textureCreateOutcomes };
}

/**
 * Name a blob we refused. For a DDS that means its PIXEL FORMAT — the container is obviously
 * readable, so "unrecognised DDS" on its own sends the reader to the wrong half of the parser.
 */
function magicOf(mem: Uint8Array, ptr: number): string {
    const u32 = (at: number): number =>
        ptr + at + 4 <= mem.length
            ? (mem[ptr + at]! | (mem[ptr + at + 1]! << 8) | (mem[ptr + at + 2]! << 16) | (mem[ptr + at + 3]! << 24)) >>> 0
            : 0;
    if (u32(0) === 0x20534444) {
        const fourCC = u32(84);
        const cc = String.fromCharCode(fourCC & 0xff, (fourCC >>> 8) & 0xff, (fourCC >>> 16) & 0xff, (fourCC >>> 24) & 0xff)
            .replace(/[^ -~]/g, ".");
        return `dds:pfSize=${u32(76)},pfFlags=0x${u32(80).toString(16)},fourCC=0x${fourCC.toString(16)}("${cc}"),`
            + `bpp=${u32(88)},masks=${u32(92).toString(16)}/${u32(96).toString(16)}/${u32(100).toString(16)}/${u32(104).toString(16)},`
            + `caps2=0x${u32(112).toString(16)}`;
    }
    let hex = "", ascii = "";
    for (let i = 0; i < 8 && ptr + i < mem.length; i++) {
        const b = mem[ptr + i]!;
        hex += b.toString(16).padStart(2, "0");
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    return `${hex}(${ascii})`;
}

function noteFormatSubstitution(format: number): void {
    if (substitutedFormats.has(format)) return;
    substitutedFormats.add(format);
    const fourCC = format > 0xffff
        ? ` ("${String.fromCharCode(format & 0xff, (format >>> 8) & 0xff, (format >>> 16) & 0xff, (format >>> 24) & 0xff)}")`
        : "";
    Logger.warn(
        LogCategory.D3D9,
        `d3dx9: texture requested as format ${format}${fourCC}, created as A8R8G8B8`,
    );
}

export function createTextureExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['D3DXFilterTexture'] = (_ctx, _mem, args) => {
        return d3dxFilterTexture(args[0] >>> 0, args[2] >>> 0, args[3] >>> 0);
    };

    /**
     * An engine that keeps its textures inside its own archives asks about a blob, not a path,
     * and only creates the texture if this succeeds — so failing it silently costs every
     * texture in the game rather than one.
     */
    const getImageInfoFromMemory: ThunkImplementation = (_ctx, mem, args) => {
        const pSrc = args[0] >>> 0;
        const srcLen = args[1] >>> 0;
        const pInfo = args[2] >>> 0;
        if (!pSrc || !srcLen || !pInfo) return D3DERR_INVALIDCALL;
        const publish = (info: ImageDescription | null): number => {
            if (!info) {
                // Name the container we could not read. The engine treats a failed info query
                // as "asset missing" and substitutes its own placeholder, so without this the
                // only evidence is a magenta texture with nothing to identify it.
                noteTextureCreate(`imageInfo:unrecognised:${magicOf(mem, pSrc)}`);
                return D3DERR_INVALIDCALL;
            }
            if (!writeImageInfo(pInfo, info.width, info.height, info.mipLevels, info.format,
                info.fileFormat, info.depth, info.resourceType)) {
                noteTextureCreate("imageInfo:writeFailed");
                return D3DERR_INVALIDCALL;
            }
            noteTextureCreate(`imageInfo:ok:type${info.resourceType}`);
            return D3D_OK;
        };
        // A header read needs no await, and answering without one keeps the call the
        // straight-line one the app wrote.
        const header = Mem.readBytes(pSrc, Math.min(srcLen, 256));
        const sync = header ? describeImageSync(header) : null;
        if (sync) {
            noteImageInfo(sync, "GetImageInfoFromFileInMemory");
            return publish(sync);
        }
        return (async (): Promise<number> => publish(await describeImage(mem.subarray(pSrc, pSrc + srcLen))))();
    };

    exports['D3DXGetImageInfoFromFileInMemory'] = getImageInfoFromMemory;

    exports['D3DXGetImageInfoFromFileA'] = async (_ctx, mem, args) => {
        const pathPtr = args[0] >>> 0;
        const pInfo = args[1] >>> 0;
        if (!pathPtr || !pInfo) return D3DERR_INVALIDCALL;
        const path = Marshaler.readString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return writeImageInfo(pInfo, decoded.width, decoded.height, decoded.mipLevels) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXGetImageInfoFromFileW'] = async (_ctx, mem, args) => {
        const pathPtr = args[0] >>> 0;
        const pInfo = args[1] >>> 0;
        if (!pathPtr || !pInfo) return D3DERR_INVALIDCALL;
        const path = Marshaler.readWideString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return writeImageInfo(pInfo, decoded.width, decoded.height, decoded.mipLevels) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXCreateTextureFromFileA'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const ppTexture = args[2] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const path = Marshaler.readString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    exports['D3DXCreateTextureFromFileW'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const ppTexture = args[2] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const path = Marshaler.readWideString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    exports['D3DXCreateTextureFromFileInMemory'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const ppTexture = args[3] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppTexture) return D3DERR_INVALIDCALL;
        const data = mem.subarray(pSrc, pSrc + srcLen);
        const decoded = await decodeImageBytes(data);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    // ---- *Ex variants ----
    // Many games call only the Ex forms; they previously fell through to D3DERR_INVALIDCALL (texture
    // never created → missing textures / load-failure branches). We honor MipLevels and fill pSrcInfo;
    // explicit Width/Height resize and Format/ColorKey override are not yet applied (the source size and
    // RGBA8 are used — sufficient for the common D3DX_DEFAULT call pattern).
    // D3DXCreateTextureFromFileEx(A/W): (Device, SrcFile, W, H, MipLevels, Usage, Format, Pool,
    //   Filter, MipFilter, ColorKey, pSrcInfo, pPalette, ppTexture)
    exports['D3DXCreateTextureFromFileExA'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const mipLevelsArg = args[4] >>> 0;
        const pSrcInfo = args[11] >>> 0;
        const ppTexture = args[13] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const decoded = await loadImageFromVfs(Marshaler.readString(mem, pathPtr));
        if (!decoded) return D3DERR_INVALIDCALL;
        if (pSrcInfo) writeImageInfo(pSrcInfo, decoded.width, decoded.height, decoded.mipLevels);
        return createTextureFromDecoded(devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg));
    };

    exports['D3DXCreateTextureFromFileExW'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const mipLevelsArg = args[4] >>> 0;
        const pSrcInfo = args[11] >>> 0;
        const ppTexture = args[13] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const decoded = await loadImageFromVfs(Marshaler.readWideString(mem, pathPtr));
        if (!decoded) return D3DERR_INVALIDCALL;
        if (pSrcInfo) writeImageInfo(pSrcInfo, decoded.width, decoded.height, decoded.mipLevels);
        return createTextureFromDecoded(devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg));
    };

    // D3DXCreateTextureFromFileInMemoryEx: (Device, SrcData, SrcSize, W, H, MipLevels, Usage, Format,
    //   Pool, Filter, MipFilter, ColorKey, pSrcInfo, pPalette, ppTexture)
    /**
     * Create straight from a DDS, in the file's own format, without decoding. Returns null
     * when nothing was created and the RGBA path should run instead — never once a texture
     * exists, because the fallback creates a second one over the same out-param and the
     * first is then referenced by nothing and released by no one.
     */
    const createFromDdsNative = (
        devicePtr: number,
        ppTexture: number,
        data: Uint8Array,
        mipLevelsArg: number,
        usage: number,
        pool: number,
    ): number | null => {
        const info = readDdsInfo(data);
        if (!info) { noteTextureCreate("ddsNative:notADds"); return null; }
        // Hand over untouched whatever the device can hold in the FILE's own format. That is
        // block-compressed data and the half/float formats — a float DDS routed to the RGBA
        // decoder instead is simply refused there (it cannot do half-float), and the engine
        // then treats a perfectly good HDR map as a missing asset.
        if (!isBlockCompressedFormat(info.format) && !isD3DFloatFormat(info.format)) {
            noteTextureCreate(`ddsNative:uncompressedFormat:${info.format}`);
            return null;
        }
        // What the caller ASKED for vs what the file CLAIMS vs what it CARRIES. d3dx creates
        // the claimed chain and filters the missing levels in; we create only what is present.
        // Census the gap before deciding whether that difference matters to this title.
        noteTextureCreate(info.mipLevels < info.claimedMipLevels
            ? `ddsNative:truncatedChain:arg=${mipLevelsArg === D3DX_DEFAULT ? "default" : mipLevelsArg}`
            : `ddsNative:completeChain:arg=${mipLevelsArg === D3DX_DEFAULT ? "default" : mipLevelsArg}`);
        const levels = mipLevelsArg === 0 || mipLevelsArg === D3DX_DEFAULT
            ? info.mipLevels
            : Math.max(1, Math.min(mipLevelsArg, info.mipLevels));
        const hr = createGuestTexture(
            devicePtr, info.width, info.height, levels,
            usage === D3DX_DEFAULT ? 0 : usage,
            info.format,
            pool === D3DX_DEFAULT || pool === 0 ? D3DPOOL_MANAGED : pool,
            ppTexture,
        );
        if (hr !== D3D_OK) { noteTextureCreate(`ddsNative:createFailed:${hr >>> 0}`); return null; }
        const texPtr = Mem.readUint32(ppTexture) ?? 0;
        if (!texPtr) { noteTextureCreate("ddsNative:noTexturePtr"); return null; }
        // The texture exists from here on: an upload that copied nothing leaves the caller an
        // undefined-content texture, which is what a truncated file gets on Windows too.
        const uploaded = uploadDdsLevels(texPtr, data, info.dataOffset, info.format, info.width, info.height, levels);
        noteTextureCreate(uploaded ? "ddsNative:ok" : "ddsNative:uploadFailed");
        return D3D_OK;
    };

    /**
     * D3DXCreateVolumeTextureFromFileInMemoryEx — a .dds whose caps2 says VOLUME.
     *
     * A failure here is invisible downstream: an engine reads it as "asset missing" and
     * substitutes its own placeholder rather than reporting anything. The levels are copied
     * straight into the volume's per-level buffers in the file's own format — the same
     * no-decode path the 2D loader takes.
     */
    exports['D3DXCreateVolumeTextureFromFileInMemoryEx'] = (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const mipLevelsArg = args[6] >>> 0;
        const usage = args[7] >>> 0;
        const pool = args[9] >>> 0;
        const pSrcInfo = args[13] >>> 0;
        const ppVolumeTexture = args[15] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppVolumeTexture) return D3DERR_INVALIDCALL;

        const data = mem.subarray(pSrc, pSrc + srcLen);
        const info = readDdsInfo(data);
        if (!info) {
            noteTextureCreate(`volume:unrecognised:${magicOf(mem, pSrc)}`);
            return D3DERR_INVALIDCALL;
        }
        // The header's count, not the walked one: readDdsInfo measures a 2D chain, so for a
        // volume it under-counts the bytes per level and over-counts the levels present. The
        // copy below stops when the payload does.
        const fileLevels = info.claimedMipLevels;
        const levels = mipLevelsArg === 0 || mipLevelsArg === D3DX_DEFAULT
            ? fileLevels
            : Math.max(1, Math.min(mipLevelsArg, fileLevels));
        const hr = createGuestVolumeTexture(
            devicePtr, info.width, info.height, info.depth, levels,
            usage === D3DX_DEFAULT ? 0 : usage,
            info.format,
            pool === D3DX_DEFAULT || pool === 0 ? D3DPOOL_MANAGED : pool,
            ppVolumeTexture,
        );
        if (hr !== D3D_OK) {
            noteTextureCreate(`volume:createFailed:${hr >>> 0}`);
            return hr;
        }
        const texPtr = Mem.readUint32(ppVolumeTexture) ?? 0;
        if (!texPtr) {
            noteTextureCreate("volume:noTexturePtr");
            return D3DERR_INVALIDCALL;
        }
        let at = info.dataOffset;
        for (let level = 0; level < levels; level++) {
            const dst = getVolumeLevel(texPtr, level);
            if (!dst) break;
            // A truncated payload is the file's business, not ours: copy what is there and
            // leave the rest of the level as allocated rather than refusing the whole texture.
            const available = Math.max(0, Math.min(dst.bytes, data.length - at));
            if (available > 0) Mem.writeBytes(dst.ptr, data.subarray(at, at + available));
            at += dst.bytes;
        }
        if (pSrcInfo) {
            writeImageInfo(pSrcInfo, info.width, info.height, fileLevels, info.format,
                ImageFileFormat.Dds, info.depth, info.resourceType);
        }
        noteTextureCreate("volume:ok");
        return D3D_OK;
    };

    /**
     * D3DXCreateCubeTextureFromFileInMemoryEx — a .dds whose caps2 says CUBEMAP.
     *
     * Same contract as the volume loader. The file stores the six faces back to back, each
     * with the full mip chain, in the texture's own format — no decode.
     */
    exports['D3DXCreateCubeTextureFromFileInMemoryEx'] = (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const mipLevelsArg = args[4] >>> 0;
        const usage = args[5] >>> 0;
        const pool = args[7] >>> 0;
        const pSrcInfo = args[11] >>> 0;
        const ppCubeTexture = args[13] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppCubeTexture) return D3DERR_INVALIDCALL;

        const data = mem.subarray(pSrc, pSrc + srcLen);
        const info = readDdsInfo(data);
        if (!info) {
            noteTextureCreate(`cube:unrecognised:${magicOf(mem, pSrc)}`);
            return D3DERR_INVALIDCALL;
        }
        // A cube's edge is the face dimension, and the six faces make the payload six times
        // the size readDdsInfo walked for a single chain — so the header's count is what the
        // file carries here, and the uploader stops on its own if the bytes run out.
        const edge = info.width;
        const fileLevels = info.claimedMipLevels;
        const levels = mipLevelsArg === 0 || mipLevelsArg === D3DX_DEFAULT
            ? fileLevels
            : Math.max(1, Math.min(mipLevelsArg, fileLevels));
        const hr = createGuestCubeTexture(
            devicePtr, edge, levels,
            usage === D3DX_DEFAULT ? 0 : usage,
            info.format,
            pool === D3DX_DEFAULT || pool === 0 ? D3DPOOL_MANAGED : pool,
            ppCubeTexture,
        );
        if (hr !== D3D_OK) {
            noteTextureCreate(`cube:createFailed:${hr >>> 0}`);
            return hr;
        }
        const texPtr = Mem.readUint32(ppCubeTexture) ?? 0;
        if (!texPtr) {
            noteTextureCreate("cube:noTexturePtr");
            return D3DERR_INVALIDCALL;
        }
        const uploaded = uploadDdsCubeFaces(texPtr, data, info.dataOffset, info.format, edge, levels, fileLevels);
        if (pSrcInfo) {
            writeImageInfo(pSrcInfo, info.width, info.height, fileLevels, info.format,
                ImageFileFormat.Dds, 1, info.resourceType);
        }
        noteTextureCreate(uploaded ? "cube:ok" : "cube:uploadFailed");
        return D3D_OK;
    };

    const createTextureFromMemoryEx: ThunkImplementation = (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const mipLevelsArg = args[5] >>> 0;
        const pSrcInfo = args[12] >>> 0;
        const ppTexture = args[14] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppTexture) return D3DERR_INVALIDCALL;
        const data = mem.subarray(pSrc, pSrc + srcLen);

        // A DDS needs no decode, so the whole call can answer WITHOUT awaiting. That is not
        // only faster: an async thunk parks the calling thread and lets every other guest
        // thread run inside what the engine wrote as a straight-line call, over the half-built
        // wrapper it is holding. A synchronous loader cannot be interleaved that way.
        const syncInfo = describeImageSync(data);
        if (!syncInfo) noteTextureCreate("notDds:decodePath");
        const nativeHr = syncInfo
            ? createFromDdsNative(devicePtr, ppTexture, data, mipLevelsArg, args[6] >>> 0, args[8] >>> 0)
            : null;
        if (syncInfo && nativeHr !== null) {
            if (pSrcInfo) {
                writeImageInfo(pSrcInfo, syncInfo.width, syncInfo.height, syncInfo.mipLevels,
                    syncInfo.format, syncInfo.fileFormat, syncInfo.depth, syncInfo.resourceType);
            }
            return nativeHr;
        }
        return createTextureFromMemoryAsync(mem, args, syncInfo);
    };

    exports['D3DXCreateTextureFromFileInMemoryEx'] = createTextureFromMemoryEx;

    /** Everything a decode is needed for: PNG/JPG/BMP/TGA, and a DDS we could not hand over. */
    const createTextureFromMemoryAsync = async (
        mem: Uint8Array,
        args: number[],
        syncInfo: ImageDescription | null,
    ): Promise<number> => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const mipLevelsArg = args[5] >>> 0;
        const formatArg = args[7] >>> 0;
        const pSrcInfo = args[12] >>> 0;
        const ppTexture = args[14] >>> 0;
        // Everything read from guest memory is read BEFORE the await: a view carved out of
        // the guest's memory detaches the moment WASM memory grows, and a decode yields.
        const data = mem.subarray(pSrc, pSrc + srcLen);
        const fileFormat = syncInfo?.fileFormat ?? imageFileFormatOf(data) ?? D3DXIFF_FORCE_DWORD;
        const decoded = await decodeImageBytes(data);
        if (!decoded) {
            noteTextureCreate("decode:failed");
            return D3DERR_INVALIDCALL;
        }
        noteTextureCreate("decode:ok");
        // The file's own description when we have it; otherwise what the decode produced.
        const info: ImageDescription = syncInfo ?? {
            width: decoded.width, height: decoded.height, depth: 1, mipLevels: decoded.mipLevels,
            format: D3DFMT_A8R8G8B8, resourceType: D3DRTYPE_TEXTURE, fileFormat,
        };
        if (pSrcInfo) {
            writeImageInfo(pSrcInfo, info.width, info.height, info.mipLevels, info.format,
                info.fileFormat, info.depth, info.resourceType);
        }
        // We always decode to RGBA. Name it when the caller asked for something else — a
        // compressed source kept as A8R8G8B8 is four times the memory and a different answer
        // from GetLevelDesc than the engine's own loader is expecting.
        const wanted = formatArg === D3DX_DEFAULT || formatArg === 0 ? info.format : formatArg;
        if (wanted !== D3DFMT_A8R8G8B8) {
            noteFormatSubstitution(wanted);
        }
        return createTextureFromDecoded(
            devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg), args[6] >>> 0, args[8] >>> 0,
        );
    };

    return exports;
}
