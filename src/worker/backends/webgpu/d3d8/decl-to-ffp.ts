/**
 * Map D3DVSD-derived vertex declarations to synthetic FVF tokens for the FFP path.
 *
 * Decl-only vertex shader handles (CreateVertexShader with pFunction=NULL) keep
 * fixed-function T&L but use a custom vertex layout instead of an FVF token.
 *
 * Multi-stream decl-only shaders (UE2-class engines: geometry in stream 0,
 * lightmap/detail UVs in extra streams) additionally get an interleave plan: the
 * per-stream elements are copied into one canonical FVF-ordered vertex so the
 * single-stream FFP renderer consumes them unchanged.
 */

import type { RawVertexElement } from "../d3d9/shader";
import { declTypeSize } from "./vsd-parser";
import { D3DVSDT_D3DCOLOR, D3DVSDT_UBYTE4 } from "./vsd-constants";
import { Logger, LogCategory } from "../../../core/logger";

// D3DFVF flags (subset used for decl synthesis)
const D3DFVF_XYZ = 0x002;
const D3DFVF_XYZRHW = 0x004;
const D3DFVF_NORMAL = 0x010;
const D3DFVF_DIFFUSE = 0x040;
const D3DFVF_SPECULAR = 0x080;
const D3DFVF_TEX1 = 0x100;
const D3DFVF_TEX2 = 0x200;
const D3DFVF_TEX3 = 0x300;
const D3DFVF_TEX4 = 0x400;
const D3DFVF_TEX5 = 0x500;
const D3DFVF_TEX6 = 0x600;
const D3DFVF_TEX7 = 0x700;
const D3DFVF_TEX8 = 0x800;
const D3DFVF_POSITION_MASK = 0x00e;

const D3DDECLUSAGE_POSITION = 0;
const D3DDECLUSAGE_NORMAL = 3;
const D3DDECLUSAGE_COLOR = 10;
const D3DDECLUSAGE_TEXCOORD = 5;

const D3DDECLTYPE_FLOAT4 = 3;

/** One element's copy into the canonical interleaved vertex. */
export interface DeclStreamCopy {
    stream: number;
    srcOffset: number;
    dstOffset: number;
    size: number;
    /** Bytes the canonical FVF slot occupies. `size` is smaller only for a degraded texcoord
     *  (FLOAT1 into the 8-byte UV slot); the interleaver must ZERO the remainder per vertex —
     *  D3D reads a missing component as 0, and the scratch buffer is reused across draws, so
     *  leaving it uncopied hands the FFP whatever the previous draw wrote there. */
    slotSize: number;
    /** True when the source element is a raw D3DVSDT_UBYTE4-typed COLOR register (component
     *  order R,G,B,A in memory) landing in the canonical D3DCOLOR slot the FFP renderer always
     *  assumes (B,G,R,A in memory) — the copy must swap bytes 0 and 2 (R<->B), or R/B render
     *  swapped on screen with no warning (see Finding 1, docs/d3d8-parity/04-vertex-pipeline.md). */
    swizzleColorBytes?: boolean;
}

/** D3DVSDT_D3DCOLOR and D3DVSDT_UBYTE4 are both 4 bytes but different component order;
 *  `declTypeSize` alone can't tell them apart. Only these two types can ever satisfy a
 *  canonical COLOR slot (both size 4) — this decides whether a byte-swizzle copy is needed. */
function colorElementSwizzle(usage: number, type: number): boolean {
    return usage === D3DDECLUSAGE_COLOR && type === D3DVSDT_UBYTE4;
}

export interface DeclFfpMapping {
    fvf: number;
    stride: number;
    /** false when layout cannot be represented as standard FVF */
    faithful: boolean;
    /** Multi-stream decls only: per-element copy plan into a canonical FVF-ordered
     *  interleaved vertex of `stride` bytes (the FFP renderer consumes one stream). */
    interleave?: DeclStreamCopy[];
}

/** Canonical FVF packing order: POSITION → NORMAL → DIFFUSE → SPECULAR → TEXn. */
function canonicalFvfOffset(fvf: number, usage: number, usageIndex: number): number | null {
    let offset = 0;
    if (usage === D3DDECLUSAGE_POSITION) return 0;

    if (fvf & D3DFVF_XYZRHW) offset += 16;
    else if (fvf & D3DFVF_XYZ) offset += 12;

    if (usage === D3DDECLUSAGE_NORMAL) return offset;
    if (fvf & D3DFVF_NORMAL) offset += 12;

    if (usage === D3DDECLUSAGE_COLOR && usageIndex === 0) return offset;
    if (fvf & D3DFVF_DIFFUSE) offset += 4;

    if (usage === D3DDECLUSAGE_COLOR && usageIndex === 1) return offset;
    if (fvf & D3DFVF_SPECULAR) offset += 4;

    if (usage === D3DDECLUSAGE_TEXCOORD) {
        const texCount = (fvf & 0xf00) >> 8;
        for (let i = 0; i < usageIndex; i++) {
            offset += 8; // canonical FVF texcoords are FLOAT2
        }
        if (usageIndex < texCount) return offset;
    }
    return null;
}

/** Element byte size the canonical FVF slot expects (null → slot absent from fvf). */
function canonicalFvfSlotSize(fvf: number, usage: number, usageIndex: number): number | null {
    if (usage === D3DDECLUSAGE_POSITION) return (fvf & D3DFVF_XYZRHW) ? 16 : 12;
    if (usage === D3DDECLUSAGE_NORMAL) return 12;
    if (usage === D3DDECLUSAGE_COLOR) return 4;
    if (usage === D3DDECLUSAGE_TEXCOORD) return 8;
    return null;
}

/** Total canonical FVF vertex size. */
function canonicalFvfStride(fvf: number): number {
    let stride = 0;
    if (fvf & D3DFVF_XYZRHW) stride += 16;
    else if (fvf & D3DFVF_XYZ) stride += 12;
    if (fvf & D3DFVF_NORMAL) stride += 12;
    if (fvf & D3DFVF_DIFFUSE) stride += 4;
    if (fvf & D3DFVF_SPECULAR) stride += 4;
    stride += ((fvf & 0xf00) >> 8) * 8;
    return stride;
}

export function declToSyntheticFvf(elements: RawVertexElement[], declStride: number): DeclFfpMapping {
    let fvf = 0;
    let texCount = 0;
    let faithful = true;
    let maxStream = 0;

    for (const e of elements) {
        if (e.stream > maxStream) maxStream = e.stream;
        if (e.usage === D3DDECLUSAGE_POSITION) {
            if (e.type === D3DDECLTYPE_FLOAT4) {
                fvf = (fvf & ~D3DFVF_POSITION_MASK) | D3DFVF_XYZRHW;
            } else {
                fvf = (fvf & ~D3DFVF_POSITION_MASK) | D3DFVF_XYZ;
            }
        } else if (e.usage === D3DDECLUSAGE_NORMAL) {
            fvf |= D3DFVF_NORMAL;
        } else if (e.usage === D3DDECLUSAGE_COLOR) {
            if (e.usageIndex === 0) fvf |= D3DFVF_DIFFUSE;
            else if (e.usageIndex === 1) fvf |= D3DFVF_SPECULAR;
            else faithful = false;
        } else if (e.usage === D3DDECLUSAGE_TEXCOORD) {
            texCount = Math.max(texCount, e.usageIndex + 1);
        } else {
            faithful = false;
        }
    }

    const texFlags = [
        0, D3DFVF_TEX1, D3DFVF_TEX2, D3DFVF_TEX3, D3DFVF_TEX4,
        D3DFVF_TEX5, D3DFVF_TEX6, D3DFVF_TEX7, D3DFVF_TEX8,
    ];
    if (texCount > 0 && texCount < texFlags.length) {
        fvf |= texFlags[texCount];
    } else if (texCount >= texFlags.length) {
        faithful = false;
    }

    if (maxStream > 0) {
        // Multi-stream: build a canonical interleave plan. A POSITION/NORMAL/COLOR element
        // that can't fill its canonical slot still bails the WHOLE plan (those corrupt the
        // rest of the vertex if misread); a non-FLOAT2 TEXCOORD degrades PER-ELEMENT instead
        // (Finding 2, docs/d3d8-parity/04-vertex-pipeline.md) — position/normal/color that
        // were perfectly representable must not be thrown away over one texcoord's size.
        const copies: DeclStreamCopy[] = [];
        let mappable = faithful;
        let degraded = false;
        for (const e of elements) {
            const dstOffset = canonicalFvfOffset(fvf, e.usage, e.usageIndex);
            const slotSize = canonicalFvfSlotSize(fvf, e.usage, e.usageIndex);
            const size = declTypeSize(e.type);
            if (dstOffset === null || slotSize === null) {
                mappable = false;
                break;
            }
            if (size !== slotSize) {
                if (e.usage === D3DDECLUSAGE_TEXCOORD) {
                    // FLOAT1/FLOAT3/FLOAT4: components are stored in order, so the leading
                    // min(size, slotSize) bytes are still valid (u[,v]) — copy just those and
                    // drop the rest, rather than discarding this element (or the whole plan).
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `D3D8 decl-only multi-stream: texcoord idx=${e.usageIndex} type=${e.type} ` +
                        `is not FLOAT2 (canonical slot=8B, element=${size}B) — copying leading ${Math.min(size, slotSize)}B only`,
                    );
                    copies.push({ stream: e.stream, srcOffset: e.offset, dstOffset, size: Math.min(size, slotSize), slotSize });
                    degraded = true;
                    continue;
                }
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8 decl-only multi-stream: element usage=${e.usage} idx=${e.usageIndex} type=${e.type} ` +
                    `does not fit canonical FVF slot — interleave disabled`,
                );
                mappable = false;
                break;
            }
            copies.push({
                stream: e.stream, srcOffset: e.offset, dstOffset, size, slotSize,
                swizzleColorBytes: colorElementSwizzle(e.usage, e.type) || undefined,
            });
        }
        if (mappable) {
            return { fvf, stride: canonicalFvfStride(fvf), faithful: !degraded, interleave: copies };
        }
        return { fvf, stride: declStride, faithful: false };
    }

    // Single-stream: if every element already sits at its canonical FVF offset AND needs no
    // byte-level conversion, the guest VB is consumed as-is. Otherwise remap each element into
    // a canonical FVF-ordered vertex (the same interleave mechanism the multi-stream path
    // uses) rather than reading the guest layout at the wrong offsets — a mismatched offset
    // would otherwise feed the FFP renderer garbage (e.g. UVs read as positions). A non-FLOAT2
    // texcoord degrades per-element here too (Finding 2), same as the multi-stream path.
    const copies: DeclStreamCopy[] = [];
    let needsRemap = false;
    let remappable = faithful;
    let degraded = false;
    for (const e of elements) {
        const dstOffset = canonicalFvfOffset(fvf, e.usage, e.usageIndex);
        const slotSize = canonicalFvfSlotSize(fvf, e.usage, e.usageIndex);
        const size = declTypeSize(e.type);
        if (dstOffset === null || slotSize === null) {
            remappable = false;
            break;
        }
        if (size !== slotSize) {
            if (e.usage === D3DDECLUSAGE_TEXCOORD) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8 decl-only single-stream: texcoord idx=${e.usageIndex} type=${e.type} ` +
                    `is not FLOAT2 (canonical slot=8B, element=${size}B) — copying leading ${Math.min(size, slotSize)}B only`,
                );
                copies.push({ stream: e.stream, srcOffset: e.offset, dstOffset, size: Math.min(size, slotSize), slotSize });
                needsRemap = true;
                degraded = true;
                continue;
            }
            // Element can't be represented in a canonical FVF slot — remap can't preserve it.
            remappable = false;
            break;
        }
        const swizzleColorBytes = colorElementSwizzle(e.usage, e.type);
        if (dstOffset !== e.offset || swizzleColorBytes) needsRemap = true;
        copies.push({ stream: e.stream, srcOffset: e.offset, dstOffset, size, slotSize, swizzleColorBytes: swizzleColorBytes || undefined });
    }

    if (!needsRemap) {
        // Offsets already canonical and no byte conversion needed — consume the guest VB as-is.
        return { fvf, stride: declStride, faithful };
    }
    if (remappable) {
        return { fvf, stride: canonicalFvfStride(fvf), faithful: faithful && !degraded, interleave: copies };
    }

    Logger.warn(
        LogCategory.SYSTEM,
        `D3D8 decl-only single-stream: element offsets ≠ canonical FVF and cannot be ` +
        `remapped (non-FVF element type) — layout may not match guest VB`,
    );
    return { fvf, stride: declStride, faithful: false };
}
