import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import {
    computeTextureDimensions,
    glideIncludesMipLevel,
    glideMipLevelPlan,
    GR_MIPMAPLEVELMASK_BOTH,
    GR_MIPMAPLEVELMASK_EVEN,
    GR_MIPMAPLEVELMASK_ODD,
    parseNccTable,
    GLIDE_TEXFMT_P_8,
    GLIDE_TEXFMT_YIQ_422,
    GLIDE_TEXFMT_AYIQ_8422,
} from "../../backends/webgpu/glide/glide-texture-decoder";
import {
    decodeGlideTextureToRgba8 as decodeGlideTexture,
    estimateGlideTextureSizeBytes as estimateTextureSizeBytes,
} from "../../backends/webgpu/shared/texture-formats";
import { FXFALSE, FXTRUE, GLIDE_TMU_MEMORY_BYTES } from "./constants";
import { GlideContext, GlideTextureRecord, GlideTMUState } from "./context";
import { setGlideError } from "./hardware";
import { GrTexInfoView, ParsedGrTexInfo } from "./structs";

function shouldLogTexEntry(context: GlideContext): boolean {
    const fid = context.frameSnapshot.frameId;
    return fid < 30 || (fid & 63) === 0;
}

const texInfoView = new GrTexInfoView();

const texFloatBitsBuffer = new ArrayBuffer(4);
const texFloatBitsView = new DataView(texFloatBitsBuffer);
// grTexLodBiasValue/grTexDetailControl receive float args by value; read the bits.
function dwordToFloat(value: number): number {
    texFloatBitsView.setUint32(0, value >>> 0, true);
    return texFloatBitsView.getFloat32(0, true);
}

// glide.h: `#define GR_NULL_MIPMAP_HANDLE ((GrMipMapId_t) -1)`. GrMipMapId_t is an
// INDEX into gc->mm_table.data, so 0 is a perfectly valid mipmap — the sentinel has
// to live outside the table, and it does.
const GR_NULL_MIPMAP_HANDLE = 0xffffffff;

// GrTexTable_t (grTexDownloadTable / grTexNCCTable)
const GR_TEXTABLE_NCC0 = 0x0;
const GR_TEXTABLE_NCC1 = 0x1;
const GR_TEXTABLE_PALETTE = 0x2;
const GU_NCC_TABLE_BYTES = 112; // sizeof(GuNccTable)

function getTmu(context: GlideContext, chip: number): GlideTMUState | null {
    const idx = chip | 0;
    if (idx < 0 || idx >= context.tmus.length) {
        setGlideError(context, 0x3001, `Invalid TMU index ${idx}`);
        return null;
    }
    return context.tmus[idx];
}

function estimateTextureMemRequiredBytes(context: GlideContext, evenOdd: number, info: ParsedGrTexInfo): number {
    // Glide 2.x: largeLod (e.g. 8=256x256) > smallLod (e.g. 0=1x1) numerically
    const minLod = Math.min(info.smallLod | 0, info.largeLod | 0);
    const maxLod = Math.max(info.smallLod | 0, info.largeLod | 0);
    if (evenOdd !== GR_MIPMAPLEVELMASK_EVEN &&
        evenOdd !== GR_MIPMAPLEVELMASK_ODD &&
        evenOdd !== GR_MIPMAPLEVELMASK_BOTH) {
        setGlideError(context, 0x3007, `grTexTextureMemRequired: invalid evenOdd mask (${evenOdd})`);
        return 0;
    }

    let total = 0;
    for (let lod = maxLod; lod >= minLod; lod--) {
        if (glideIncludesMipLevel(evenOdd, lod)) {
            const dims = computeTextureDimensions(lod, info.aspectRatio);
            total += estimateTextureSizeBytes(dims.width, dims.height, info.format);
        }
    }
    // Glide aligns texture memory requirements to 8-byte boundaries.
    total = (total + 7) & ~7;
    return total >>> 0;
}

function uploadTexture(
    context: GlideContext,
    tmuIndex: number,
    startAddress: number,
    width: number,
    height: number,
    format: number,
    dataPtr: number,
    declared?: { smallLod: number; largeLod: number; aspectRatio: number; evenOdd: number },
): GlideTextureRecord | null {
    const tmu = getTmu(context, tmuIndex);
    if (!tmu) return null;
    const existing = tmu.texturesByAddress.get(startAddress);

    const palette = format === GLIDE_TEXFMT_P_8 ? tmu.palette : null;
    const isYiq = format === GLIDE_TEXFMT_YIQ_422 || format === GLIDE_TEXFMT_AYIQ_8422;
    const ncc = isYiq ? (tmu.nccTables[tmu.activeNcc & 1] ?? null) : null;
    // grTexDownloadMipMap hands us the WHOLE chain the guest selected, largest LOD
    // first. Decoding only level 0 leaves every minified surface sampling the full-res
    // texture — the aliasing mipmaps exist to remove.
    const plan = glideMipLevelPlan(
        declared?.largeLod ?? -1,
        declared?.smallLod ?? -1,
        declared?.evenOdd ?? GR_MIPMAPLEVELMASK_BOTH,
        declared?.aspectRatio ?? 3,
        (w, h) => estimateTextureSizeBytes(w, h, format),
    );
    const levelPlan = plan.length > 0
        ? plan
        : [{ lod: 0, width, height, byteOffset: 0, byteSize: estimateTextureSizeBytes(width, height, format) }];

    // With an ODD level mask the download STARTS at a smaller LOD than largeLod names,
    // so the resident texture is the plan's first level, not the caller's guess.
    const baseLevel = levelPlan[0]!;
    const baseWidth = baseLevel.width;
    const baseHeight = baseLevel.height;

    const levels: Uint8Array[] = [];
    let baseBytes: Uint8Array | null = null;
    for (const level of levelPlan) {
        const bytes = Mem.readBytes(dataPtr + level.byteOffset, level.byteSize);
        if (!bytes) break;
        baseBytes ??= bytes;
        levels.push(decodeGlideTexture(bytes, 0, level.width, level.height, format, palette, ncc));
    }
    if (levels.length === 0 || !baseBytes) {
        setGlideError(context, 0x3004, `Texture upload failed: invalid data pointer 0x${dataPtr.toString(16)}`);
        return null;
    }

    // Retaining the undecoded source doubles a texture's resident cost and is only ever
    // read by glideDumpTexture, so it is opt-in rather than paid by every title.
    let sourceBytes = existing?.sourceBytes ?? null;
    if ((globalThis as { __glideKeepTexSource?: boolean }).__glideKeepTexSource) {
        if (!sourceBytes || sourceBytes.length !== baseBytes.length) {
            sourceBytes = new Uint8Array(baseBytes.length);
        }
        sourceBytes.set(baseBytes);
    }

    const handle = existing?.handle ?? context.nextTextureHandle++;
    if (context.executor) {
        context.executor.uploadTexture(handle, baseWidth, baseHeight, format, levels);
    }

    // The resident footprint is the WHOLE chain: the overlap walk below compares
    // extents, and a base-level-only size cannot see a download landing in an
    // earlier texture's mip tail.
    const bytes = levelPlan.reduce((n, l) => n + l.byteSize, 0);
    const record: GlideTextureRecord = {
        handle,
        tmu: tmuIndex,
        startAddress: startAddress >>> 0,
        dataPtr: dataPtr >>> 0,
        width: baseWidth,
        height: baseHeight,
        format: format | 0,
        smallLod: declared?.smallLod ?? existing?.smallLod ?? -1,
        largeLod: declared?.largeLod ?? existing?.largeLod ?? -1,
        aspectRatio: declared?.aspectRatio ?? existing?.aspectRatio ?? -1,
        evenOdd: declared?.evenOdd ?? existing?.evenOdd ?? -1,
        bytes,
        uploadedAt: context.executor ? performance.now() : 0,
        lastUsedFrame: context.frameSnapshot.frameId,
        sourceBytes,
    };

    // TMU memory is one linear arena the guest allocates by hand. A download that
    // lands across an EARLIER texture's extent overwrote those bytes on the hardware,
    // so that texture no longer exists; keeping its record alive means a later
    // grTexSource at its address serves content the TMU has not held since.
    const newStart = startAddress >>> 0;
    const newEnd = newStart + bytes;
    for (const [addr, other] of tmu.texturesByAddress) {
        if (addr === newStart) continue;
        if (addr < newEnd && addr + other.bytes > newStart) {
            tmu.texturesByAddress.delete(addr);
            context.executor?.deleteTexture(other.handle);
            context.diagnostics.push(
                "texevict",
                `tmu=${tmuIndex} addr=0x${addr.toString(16)} overwritten by 0x${newStart.toString(16)}`,
            );
        }
    }

    tmu.texturesByAddress.set(newStart, record);
    context.frameSnapshot.texDownloads++;
    context.frameSnapshot.frameCounters.uploads++;
    context.frameSnapshot.frameCounters.textureBytes += bytes;
    context.diagnostics.push("texdownload", `tmu=${tmuIndex} addr=0x${startAddress.toString(16)} ${baseWidth}x${baseHeight} fmt=${format}`);
    return record;
}

/**
 * `capturedInfo` is the GrTexInfo the WBUF trampoline copied into the ring at CALL time;
 * `infoPtr` is the guest pointer, read only when there is no capture. Real grTexSource
 * (gtex.c) reads nothing but smallLod/largeLod/aspectRatio/format out of the struct — it
 * never touches `info->data`, because the texels reached the TMU at grTexDownloadMipMap
 * time. Our upload-on-miss is emulation slack for a title that sources an address it never
 * downloaded to, which on real hardware samples whatever the TMU happened to hold.
 */
function ensureTextureForSource(
    context: GlideContext,
    tmuIndex: number,
    startAddress: number,
    evenOdd: number,
    infoPtr: number,
    capturedInfo: ParsedGrTexInfo | null,
): GlideTextureRecord | null {
    const tmu = getTmu(context, tmuIndex);
    if (!tmu) return null;
    const cached = tmu.texturesByAddress.get(startAddress >>> 0);
    if (cached) {
        if (context.executor && cached.uploadedAt === 0) {
            return uploadTexture(
                context,
                tmuIndex,
                cached.startAddress,
                cached.width,
                cached.height,
                cached.format,
                cached.dataPtr,
                {
                    smallLod: cached.smallLod,
                    largeLod: cached.largeLod,
                    aspectRatio: cached.aspectRatio,
                    evenOdd: cached.evenOdd,
                },
            );
        }
        return cached;
    }
    if (!capturedInfo && !infoPtr) return null;

    const info = capturedInfo ?? texInfoView.setPtr(infoPtr >>> 0).read();
    if (!info) {
        setGlideError(context, 0x3002, "grTexSource: invalid GrTexInfo pointer");
        return null;
    }

    const dims = computeTextureDimensions(info.largeLod, info.aspectRatio);
    return uploadTexture(
        context,
        tmuIndex,
        startAddress,
        dims.width,
        dims.height,
        info.format,
        info.data,
        { smallLod: info.smallLod, largeLod: info.largeLod, aspectRatio: info.aspectRatio, evenOdd },
    );
}

/** Reused across calls — guTexSource is a per-draw call and the result is read and
 *  dropped by the caller. Returning a fresh object per call is what put ~120 short-lived
 *  objects on the hot path for every one of them. */
const guMmidResult: { tmuIndex: number; texture: GlideTextureRecord | null } = { tmuIndex: 0, texture: null };

/**
 * How guTexSource's mmid actually resolved. The keyed lookup is the whole point of this
 * function's shape, and nothing outside could tell whether it HITS — a fallback walk on
 * every call would look identical from the caller and cost O(textures) plus a sort.
 * Surfaced by the `glideState` harness verb (FAST-PATH LEDGER RULE).
 */
export const guMmidResolveStats = { nullHandle: 0, keyed: 0, ordinalFallback: 0, recentFallback: 0, miss: 0 };

function resolveTextureByGuMmid(
    context: GlideContext,
    mmid: number,
): { tmuIndex: number; texture: GlideTextureRecord } | null {
    // A guTex* mmid is normally the TMU address the texture was downloaded to, and
    // texturesByAddress is keyed by exactly that — so the common case is a Map hit per
    // TMU, not a walk. It used to materialise every resident texture into two arrays and
    // sort them on EVERY call (~120 allocations plus a sort, thousands of objects a
    // frame): O(textures) work and garbage for what the key already answers in O(TMUs).
    const key = mmid >>> 0;
    let bestTmu = -1;
    let best: GlideTextureRecord | null = null;
    for (let tmuIndex = 0; tmuIndex < context.tmus.length; tmuIndex++) {
        const hit = context.tmus[tmuIndex]?.texturesByAddress.get(key);
        // One record per address per TMU, so at most one candidate each: the tie between
        // TMUs still goes to the most recently uploaded, as before.
        if (hit && (!best || hit.uploadedAt > best.uploadedAt)) {
            best = hit;
            bestTmu = tmuIndex;
        }
    }
    if (best) {
        guMmidResolveStats.keyed++;
        guMmidResult.tmuIndex = bestTmu;
        guMmidResult.texture = best;
        return guMmidResult as { tmuIndex: number; texture: GlideTextureRecord };
    }

    // Fallbacks only — a title whose mmid is NOT a TMU address. Counting and picking the
    // newest is one allocation-free pass; only the ordinal branch actually needs the
    // textures materialised in order, and it is the rarer of the two.
    let count = 0;
    let newest: GlideTextureRecord | null = null;
    let newestTmu = -1;
    for (let tmuIndex = 0; tmuIndex < context.tmus.length; tmuIndex++) {
        const tmu = context.tmus[tmuIndex];
        if (!tmu) continue;
        for (const texture of tmu.texturesByAddress.values()) {
            count++;
            if (!newest || texture.uploadedAt > newest.uploadedAt) {
                newest = texture;
                newestTmu = tmuIndex;
            }
        }
    }
    if (!newest) {
        guMmidResolveStats.miss++;
        return null;
    }

    // Pragmatic fallback: legacy guTex* code often uses small sequential handles.
    // If mmid looks like a small positive handle, map it by allocation-like order.
    if (mmid > 0 && mmid <= count) {
        guMmidResolveStats.ordinalFallback++;
        const allTextures: Array<{ tmuIndex: number; texture: GlideTextureRecord }> = [];
        for (let tmuIndex = 0; tmuIndex < context.tmus.length; tmuIndex++) {
            const tmu = context.tmus[tmuIndex];
            if (!tmu) continue;
            for (const texture of tmu.texturesByAddress.values()) allTextures.push({ tmuIndex, texture });
        }
        allTextures.sort((a, b) => {
            if (a.tmuIndex !== b.tmuIndex) return a.tmuIndex - b.tmuIndex;
            return (a.texture.startAddress >>> 0) - (b.texture.startAddress >>> 0);
        });
        return allTextures[mmid - 1] ?? null;
    }

    // Last resort: keep rendering with the most recently uploaded texture.
    guMmidResolveStats.recentFallback++;
    guMmidResult.tmuIndex = newestTmu;
    guMmidResult.texture = newest;
    return guMmidResult as { tmuIndex: number; texture: GlideTextureRecord };
}

/**
 * The WHOLE of grTexSource, shared verbatim by the OUT-trap handler and the WBUF drain
 * handler. Two copies of this would drift silently — the ring path only runs under load,
 * on whichever half someone edited once — and it is also what makes the two paths update
 * the same ledgers (frameCounters.textureBinds, the diagnostics ring, lastUsedFrame) by
 * construction rather than by a comparison somebody has to remember to run.
 */
export function applyGrTexSource(
    context: GlideContext,
    tmuIndex: number,
    startAddress: number,
    evenOdd: number,
    infoPtr: number,
    capturedInfo: ParsedGrTexInfo | null,
): number {
    if (shouldLogTexEntry(context)) {
        Logger.log(
            LogCategory.SYSTEM,
            `[Glide] grTexSource tmu=${tmuIndex} addr=0x${startAddress.toString(16)} ` +
            `evenOdd=${evenOdd} infoPtr=0x${infoPtr.toString(16)}`,
        );
    }
    const tmu = getTmu(context, tmuIndex);
    if (!tmu) return 0;

    tmu.currentAddress = startAddress >>> 0;
    const tex = ensureTextureForSource(context, tmuIndex, startAddress, evenOdd, infoPtr, capturedInfo);
    context.ffpState.setTexture(!!tex, tex?.handle ?? 0);
    if (tex) {
        tex.lastUsedFrame = context.frameSnapshot.frameId;
        context.frameSnapshot.frameCounters.textureBinds++;
    }
    context.diagnostics.push("texsource", `tmu=${tmuIndex} addr=0x${startAddress.toString(16)} handle=${tex?.handle ?? 0}`);
    return 0;
}

export function createTextureExports(context: GlideContext): Record<string, ThunkImplementation> {
    return {
        "_grTexMinAddress@4": (_ctx, _mem, args) => {
            const tmuIndex = args[0] | 0;
            const tmu = getTmu(context, tmuIndex);
            const result = tmu ? tmu.minAddress >>> 0 : 0;
            if (shouldLogTexEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grTexMinAddress tmu=${tmuIndex} -> 0x${result.toString(16)}`);
            }
            return result;
        },

        "_grTexMaxAddress@4": (_ctx, _mem, args) => {
            const tmuIndex = args[0] | 0;
            const tmu = getTmu(context, tmuIndex);
            if (!tmu) return 0;
            tmu.maxAddress = GLIDE_TMU_MEMORY_BYTES - 8;
            if (shouldLogTexEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] grTexMaxAddress tmu=${tmuIndex} -> 0x${tmu.maxAddress.toString(16)}`);
            }
            return tmu.maxAddress >>> 0;
        },

        "_grTexTextureMemRequired@8": (_ctx, _mem, args) => {
            const evenOdd = args[0] | 0;
            const infoPtr = args[1] >>> 0;
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexTextureMemRequired evenOdd=${evenOdd} infoPtr=0x${infoPtr.toString(16)}`,
                );
            }
            if (!infoPtr) return 0;
            const info = texInfoView.setPtr(infoPtr).read();
            if (!info) {
                setGlideError(context, 0x3005, "grTexTextureMemRequired: invalid GrTexInfo");
                return 0;
            }
            return estimateTextureMemRequiredBytes(context, evenOdd, info);
        },

        "_grTexSource@16": (_ctx, _mem, args) =>
            applyGrTexSource(context, args[0] | 0, args[1] >>> 0, args[2] | 0, args[3] >>> 0, null),

        "_guTexSource@4": (_ctx, _mem, args) => {
            const mmid = args[0] >>> 0;
            // gutex.c guTexSource: `if (mmid == GR_NULL_MIPMAP_HANDLE) return;` — a plain
            // no-op that leaves the previously sourced mipmap bound. Neither a bind nor a
            // texture-disable, and cheap: Carmageddon 2 issues nothing else through this
            // entry point, so every one of these used to fall through to the resolver's
            // fallback and re-bind whichever texture was uploaded last.
            if (mmid === GR_NULL_MIPMAP_HANDLE) {
                guMmidResolveStats.nullHandle++;
                return 0;
            }
            if (shouldLogTexEntry(context)) {
                Logger.log(LogCategory.SYSTEM, `[Glide] guTexSource mmid=${mmid}`);
            }

            const resolved = resolveTextureByGuMmid(context, mmid);
            if (!resolved) {
                setGlideError(context, 0x3008, `guTexSource: unknown mmid ${mmid}`);
                return 0;
            }

            const tmu = getTmu(context, resolved.tmuIndex);
            if (!tmu) return 0;

            tmu.currentAddress = resolved.texture.startAddress >>> 0;
            resolved.texture.lastUsedFrame = context.frameSnapshot.frameId;
            context.ffpState.setTexture(true, resolved.texture.handle);
            context.frameSnapshot.frameCounters.textureBinds++;
            context.diagnostics.push(
                "texsource",
                `guTexSource(mmid=${mmid}) -> tmu=${resolved.tmuIndex} addr=0x${resolved.texture.startAddress.toString(16)} handle=${resolved.texture.handle}`,
            );
            return 0;
        },

        "_grTexDownloadMipMap@16": (_ctx, _mem, args) => {
            const tmuIndex = args[0] | 0;
            const startAddress = args[1] >>> 0;
            const infoPtr = args[3] >>> 0;
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexDownloadMipMap tmu=${tmuIndex} addr=0x${startAddress.toString(16)} ` +
                    `evenOdd=${args[2] | 0} infoPtr=0x${infoPtr.toString(16)}`,
                );
            }
            const info = texInfoView.setPtr(infoPtr).read();
            if (!info) {
                setGlideError(context, 0x3003, "grTexDownloadMipMap: invalid GrTexInfo");
                if (shouldLogTexEntry(context)) {
                    Logger.warn(LogCategory.SYSTEM, `[Glide] grTexDownloadMipMap: invalid GrTexInfo ptr=0x${infoPtr.toString(16)}`);
                }
                return FXFALSE;
            }
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexDownloadMipMap info: smallLod=${info.smallLod} largeLod=${info.largeLod} ` +
                    `aspect=${info.aspectRatio} format=${info.format} dataPtr=0x${info.data.toString(16)}`,
                );
            }
            const dims = computeTextureDimensions(info.largeLod, info.aspectRatio);
            const record = uploadTexture(
                context,
                tmuIndex,
                startAddress,
                dims.width,
                dims.height,
                info.format,
                info.data,
                {
                    smallLod: info.smallLod,
                    largeLod: info.largeLod,
                    aspectRatio: info.aspectRatio,
                    evenOdd: args[2] | 0,
                },
            );
            return record ? FXTRUE : FXFALSE;
        },

        "_grTexDownloadTable@12": (_ctx, _mem, args) => {
            const tmuIndex = args[0] | 0;
            const tableType = args[1] | 0;
            const dataPtr = args[2] >>> 0;
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexDownloadTable tmu=${tmuIndex} type=${tableType} dataPtr=0x${dataPtr.toString(16)}`,
                );
            }
            const tmu = getTmu(context, tmuIndex);
            if (!tmu) return 0;

            // NCC table downloads (GR_TEXTABLE_NCC0/NCC1) are NOT palettes — parse the
            // 112-byte GuNccTable so YIQ_422 / AYIQ_8422 textures decode correctly.
            if (dataPtr && (tableType === GR_TEXTABLE_NCC0 || tableType === GR_TEXTABLE_NCC1)) {
                const raw = Mem.readBytes(dataPtr, GU_NCC_TABLE_BYTES);
                if (raw) {
                    tmu.nccTables[tableType === GR_TEXTABLE_NCC1 ? 1 : 0] = parseNccTable(raw);
                }
                return 0;
            }

            // Palette table (GR_TEXTABLE_PALETTE) for P_8 textures.
            if (dataPtr && tableType === GR_TEXTABLE_PALETTE) {
                const raw = Mem.readBytes(dataPtr, 256 * 4);
                if (raw) {
                    const palette = new Uint32Array(256);
                    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
                    // Glide palette convention: plain 0x00RRGGBB entries (GR_TEXTABLE_PALETTE).
                    // Alpha byte is undefined / zero, so force alpha to opaque (0xFF) for each
                    // entry — otherwise P_8 textures decode with alpha=0 and SRC_ALPHA blend kills them.
                    for (let i = 0; i < palette.length; i++) {
                        const entry = dv.getUint32(i * 4, true);
                        palette[i] = (entry | 0xff000000) >>> 0;
                    }
                    tmu.palette = palette;
                    if (shouldLogTexEntry(context)) {
                        // Dump 16 entries so we can eyeball the actual color layout
                        // (Glide ARGB vs DIB-style BGRA palette byte order).
                        const samples: string[] = [];
                        for (let i = 0; i < 16; i++) {
                            const p = palette[i] ?? 0;
                            samples.push(`[${i}]=0x${p.toString(16).padStart(8, "0")}`);
                        }
                        Logger.log(LogCategory.SYSTEM, `[Glide] palette 0..15: ${samples.join(" ")}`);
                        const samples2: string[] = [];
                        for (const i of [64, 128, 192, 200, 220, 240, 250, 255]) {
                            const p = palette[i] ?? 0;
                            samples2.push(`[${i}]=0x${p.toString(16).padStart(8, "0")}`);
                        }
                        Logger.log(LogCategory.SYSTEM, `[Glide] palette spread: ${samples2.join(" ")}`);
                    }
                }
            }
            return 0;
        },

        "_grTexClampMode@12": (_ctx, _mem, args) => {
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexClampMode tmu=${args[0] | 0} clampS=${args[1] | 0} clampT=${args[2] | 0}`,
                );
            }
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.clampS = args[1] | 0;
            tmu.clampT = args[2] | 0;
            return 0;
        },

        "_grTexFilterMode@12": (_ctx, _mem, args) => {
            if (shouldLogTexEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grTexFilterMode tmu=${args[0] | 0} minFilter=${args[1] | 0} magFilter=${args[2] | 0}`,
                );
            }
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.minFilter = args[1] | 0;
            tmu.magFilter = args[2] | 0;
            return 0;
        },

        "_grTexMipMapMode@12": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.mipMapMode = args[1] | 0;
            // lodBlend ignored for now, but captured in API state blob.
            context.apiState.glideStateVersion = (context.apiState.glideStateVersion + (args[2] | 0)) >>> 0;
            return 0;
        },

        "_grTexLodBiasValue@8": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            // bias is a float (e.g. GR_LODBIAS_BILINEAR = 0.5), not an integer.
            tmu.lodBias = dwordToFloat(args[1] >>> 0);
            return 0;
        },

        "_grTexNCCTable@8": (_ctx, _mem, args) => {
            // grTexNCCTable(tmu, GrNCCTable_t table) selects NCC0/NCC1 for YIQ sampling.
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.activeNcc = (args[1] | 0) === GR_TEXTABLE_NCC1 ? 1 : 0;
            return 0;
        },

        "_grTexMultibase@8": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.multibaseEnabled = (args[1] | 0) !== 0;
            return 0;
        },

        "_grTexBaseAddress@8": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.baseAddress = args[1] >>> 0;
            return 0;
        },

        "_grTexCombineFunction@8": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.combineFunction = args[1] | 0;
            return 0;
        },

        // gu* convenience alias for the simple per-TMU combine function.
        "_guTexCombineFunction@8": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.combineFunction = args[1] | 0;
            return 0;
        },

        // grTexCombine: full multi-TMU combine (rgb/alpha function+factor+invert).
        // Multi-TMU compositing is not yet applied (single texture sampled), so we
        // record the rgb function as the active TMU combine; the rest is stored for
        // when dual-TMU support lands. Exported so multitexture games still bind.
        "_grTexCombine@28": (_ctx, _mem, args) => {
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.combineFunction = args[1] | 0; // rgb_function
            return 0;
        },

        "_grTexDetailControl@16": (_ctx, _mem, args) => {
            // grTexDetailControl(tmu, int lod_bias, FxU8 detail_scale, float detail_max)
            const tmu = getTmu(context, args[0] | 0);
            if (!tmu) return 0;
            tmu.detailBias = args[1] | 0;
            tmu.detailScale = args[2] & 0xff;
            tmu.detailMax = dwordToFloat(args[3] >>> 0);
            return 0;
        },
    };
}


/**
 * Decode one texture record straight from the guest bytes it was uploaded from,
 * through the same decoder the upload path uses. Diagnostic only (glideDumpTexture).
 */
export function decodeTextureRecordToRgba(
    context: GlideContext,
    record: GlideTextureRecord,
): Uint8Array | null {
    const tmu = getTmu(context, record.tmu);
    if (!tmu) return null;
    const palette = record.format === GLIDE_TEXFMT_P_8 ? tmu.palette : null;
    const isYiq = record.format === GLIDE_TEXFMT_YIQ_422 || record.format === GLIDE_TEXFMT_AYIQ_8422;
    const ncc = isYiq ? (tmu.nccTables[tmu.activeNcc & 1] ?? null) : null;
    const bytes = record.sourceBytes;
    if (!bytes) return null;
    return decodeGlideTexture(bytes, 0, record.width, record.height, record.format, palette, ncc);
}
