/**
 * FVF → vertex layout, the half of the fixed-function vertex path that is pure data.
 *
 * An FVF says WHERE each component sits inside a vertex; SetStreamSource /
 * VertexStreamZeroStride says how far apart vertices are. planFvf() is the single place the
 * two are reconciled, so the GPU attribute list (buildVertexLayout) and the WGSL input struct
 * (buildShader) cannot disagree about which components exist — a pipeline whose shader
 * declares a @location its vertex state does not supply is rejected outright, taking the
 * whole frame's command buffer with it.
 */

import { vertexFormatSize } from "../../shared/vertex-streams";

export const D3DFVF_XYZ = 0x0002;
export const D3DFVF_XYZRHW = 0x0004;
export const D3DFVF_POSITION_MASK = 0x000e;
export const D3DFVF_NORMAL = 0x0010;
export const D3DFVF_PSIZE = 0x0020;
export const D3DFVF_DIFFUSE = 0x0040;
export const D3DFVF_SPECULAR = 0x0080;
export const D3DFVF_TEX1 = 0x0100;
/** D3DFVF_LASTBETA_* mark the last XYZBn beta as matrix indices, not a float weight. */
export const D3DFVF_LASTBETA_UBYTE4 = 0x1000;
export const D3DFVF_LASTBETA_D3DCOLOR = 0x8000;

const D3DFVF_TEXCOUNT_MASK = 0x0f00;
const D3DFVF_TEXCOUNT_SHIFT = 8;

/**
 * Parsed FVF layout in D3D byte order (position, normal, psize, diffuse, specular, texcoord
 * sets), with contiguous shader locations.
 *
 * `stride` is the whole vertex, INCLUDING components we declare no attribute for (blend
 * weights and point size) — it is the PACKED size the FVF implies, used only where the guest
 * bound no stride of its own.
 */
export interface FvfLayout {
    hasRhw: boolean;
    hasNormal: boolean;
    hasColor: boolean;
    hasSpecular: boolean;
    hasTex: boolean;
    /** Texture coordinate sets present (D3DFVF_TEXCOUNT), including FLOAT1/3/4 sets. */
    texCount: number;
    hasTex1: boolean;
    posLoc: number; posOff: number;
    normalLoc: number; normalOff: number;
    /** PSIZE is physically present but has no legacy FVF shader location. */
    psizeLoc: number; psizeOff: number;
    colorLoc: number; colorOff: number;
    specularLoc: number; specularOff: number;
    texLoc: number; texOff: number;
    tex1Loc: number; tex1Off: number;
    /** Per-set locations/byte offsets/dimensions for TEXCOORD0..7. */
    texLocs: number[]; texOffs: number[]; texDims: number[];
    /** XYZBn beta data, appended after texcoords to preserve legacy locations. */
    blendWeightCount: number;
    blendWeightLoc: number;
    blendWeightOff: number;
    blendWeightDims: number;
    blendIndexLoc: number;
    blendIndexOff: number;
    blendIndexFormat: "uint8x4" | "unorm8x4" | null;
    stride: number;
}

/** Bytes the FVF position component occupies (d3d9types.h D3DFVF_POSITION_MASK values).
 *  XYZBn carries n blend weights after the xyz triple; the last one may be packed as
 *  UBYTE4/D3DCOLOR instead of a float (D3DFVF_LASTBETA_*), which costs the same 4 bytes. */
function fvfPositionBytes(fvf: number): number {
    switch (fvf & 0x000e) {
        case 0x0002: return (fvf & 0x4000) ? 16 : 12; // XYZ / XYZW
        case 0x0004: return 16;                        // XYZRHW
        case 0x0006: return 16;                        // XYZB1
        case 0x0008: return 20;                        // XYZB2
        case 0x000a: return 24;                        // XYZB3
        case 0x000c: return 28;                        // XYZB4
        case 0x000e: return 32;                        // XYZB5
        default: return 12;
    }
}

/** Floats in texture coordinate set `i` — 2 unless D3DFVF_TEXCOORDSIZE{1,3,4} says otherwise
 *  (2 bits per set from bit 16; 0=float2, 1=float3, 2=float4, 3=float1). */
function fvfTexCoordFloats(fvf: number, set: number): number {
    switch ((fvf >>> (16 + set * 2)) & 3) {
        case 1: return 3;
        case 2: return 4;
        case 3: return 1;
        default: return 2;
    }
}

function fvfBetaCount(fvf: number): number {
    switch (fvf & D3DFVF_POSITION_MASK) {
        case 0x0006: return 1;
        case 0x0008: return 2;
        case 0x000a: return 3;
        case 0x000c: return 4;
        case 0x000e: return 5;
        default: return 0;
    }
}

export function parseFvf(fvf: number): FvfLayout {
    // XYZB1..XYZB5 share the XYZRHW bit numerically (0x0006, 0x0008, ...), so a
    // bit-test misclassifies every weighted FVF as pre-transformed. Compare the position
    // field exactly; weighted forms remain object-space even though their low bits include 4.
    const hasRhw = (fvf & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
    // RHW (pre-transformed) vertices carry no normal and skip lighting.
    const hasNormal = !hasRhw && (fvf & D3DFVF_NORMAL) !== 0;
    const hasPsize = (fvf & D3DFVF_PSIZE) !== 0;
    const hasColor = (fvf & D3DFVF_DIFFUSE) !== 0;
    const hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
    const texCount = (fvf & D3DFVF_TEXCOUNT_MASK) >>> D3DFVF_TEXCOUNT_SHIFT;
    const texDims = Array.from({ length: 8 }, (_u, i) => i < texCount ? fvfTexCoordFloats(fvf, i) : 0);
    const texLocs = new Array<number>(8).fill(-1);
    const texOffs = new Array<number>(8).fill(0);

    let loc = 0, off = 0;
    const posLoc = loc++; const posOff = off; off += fvfPositionBytes(fvf);
    let normalLoc = -1, normalOff = 0;
    if (hasNormal) { normalLoc = loc++; normalOff = off; off += 12; }
    let psizeLoc = -1, psizeOff = 0;
    if (hasPsize) { psizeOff = off; off += 4; }
    let colorLoc = -1, colorOff = 0;
    if (hasColor) { colorLoc = loc++; colorOff = off; off += 4; }
    let specularLoc = -1, specularOff = 0;
    if (hasSpecular) { specularLoc = loc++; specularOff = off; off += 4; }
    let texLoc = -1, texOff = 0, tex1Loc = -1, tex1Off = 0;
    for (let i = 0; i < texCount; i++) {
        const dims = texDims[i] ?? 0;
        texOffs[i] = off;
        if (i < 8 && dims > 0) texLocs[i] = loc++;
        if (i === 0) { texLoc = texLocs[i]!; texOff = off; }
        if (i === 1) { tex1Loc = texLocs[i]!; tex1Off = off; }
        off += dims * 4;
    }

    const hasTex = texLocs.some(loc => loc >= 0);
    const hasTex1 = texLocs[1] >= 0;

    // LASTBETA applies to the final beta only. The preceding betas remain ordinary float
    // weights. Keep these attributes after all texture sets so existing FVF shader locations
    // remain stable for applications that do not use geometry blending.
    const betaCount = fvfBetaCount(fvf);
    const lastBetaFormat = (fvf & D3DFVF_LASTBETA_UBYTE4) !== 0
        ? "uint8x4" as const
        : (fvf & D3DFVF_LASTBETA_D3DCOLOR) !== 0 ? "unorm8x4" as const : null;
    const blendWeightCount = lastBetaFormat ? Math.max(0, betaCount - 1) : betaCount;
    const blendWeightLoc = blendWeightCount > 0 ? loc++ : -1;
    // XYZBn starts with xyz at byte 0; beta data is already included in
    // fvfPositionBytes(), so these are offsets inside the position component,
    // not an extra tail appended after TEXCOORDs.
    const blendWeightOff = blendWeightCount > 0 ? 12 : 0;
    const blendIndexLoc = lastBetaFormat ? loc++ : -1;
    const blendIndexOff = lastBetaFormat ? 12 + blendWeightCount * 4 : 0;

    return {
        hasRhw, hasNormal, hasColor, hasSpecular, hasTex, hasTex1, texCount,
        posLoc, posOff, normalLoc, normalOff, psizeLoc, psizeOff, colorLoc, colorOff,
        specularLoc, specularOff, texLoc, texOff, tex1Loc, tex1Off, texLocs, texOffs, texDims,
        blendWeightCount, blendWeightLoc, blendWeightOff, blendWeightDims: blendWeightCount,
        blendIndexLoc, blendIndexOff, blendIndexFormat: lastBetaFormat, stride: off,
    };
}

/**
 * Synthesize the declaration view of an FVF for the programmable linker.
 *
 * SetFVF and SetVertexShader are legal together in D3D9: the FVF remains the active
 * vertex declaration while the programmable VS supplies the semantics.  The legacy FFP
 * builder already consumes parseFvf(), but passing null to the programmable linker makes it
 * tight-pack every input as FLOAT4 and silently misreads FLOAT1/2/3, colors, and XYZBn.
 * Keep this conversion next to parseFvf so byte offsets and the FVF stride cannot drift.
 * Returns null for XYZB5 without a packed last beta: that format has five independent beta
 * values and cannot be represented by one D3DDECLTYPE element without inventing a second
 * BLENDWEIGHT semantic.
 */
export interface FvfDeclarationElement {
    stream: number;
    offset: number;
    type: number;
    usage: number;
    usageIndex: number;
    /** Register mapping for shader models without dcl instructions. */
    reg?: number;
}

export function makeFvfDeclaration(fvf: number): FvfDeclarationElement[] | null {
    const f = parseFvf(fvf >>> 0);
    if (f.blendWeightCount > 4) return null;
    const elements: FvfDeclarationElement[] = [];
    const add = (offset: number, type: number, usage: number, usageIndex: number, reg?: number): void => {
        elements.push({ stream: 0, offset, type, usage, usageIndex, ...(reg === undefined ? {} : { reg }) });
    };
    add(f.posOff, f.hasRhw ? 3 : 2, f.hasRhw ? 9 : 0, 0, f.posLoc);
    if (f.hasNormal) add(f.normalOff, 2, 3, 0, f.normalLoc);
    if (f.psizeOff !== 0 || (fvf & D3DFVF_PSIZE) !== 0) add(f.psizeOff, 0, 4, 0);
    if (f.hasColor) add(f.colorOff, 4, 10, 0, f.colorLoc);
    if (f.hasSpecular) add(f.specularOff, 4, 10, 1, f.specularLoc);
    for (let i = 0; i < f.texCount && i < 8; i++) {
        const dims = f.texDims[i] ?? 0;
        if (dims <= 0) continue;
        const type = dims === 1 ? 0 : dims === 2 ? 1 : dims === 3 ? 2 : 3;
        add(f.texOffs[i] ?? 0, type, 5, i, f.texLocs[i]);
    }
    if (f.blendWeightCount > 0) {
        const type = f.blendWeightCount === 1 ? 0 : f.blendWeightCount === 2 ? 1
            : f.blendWeightCount === 3 ? 2 : 3;
        add(f.blendWeightOff, type, 1, 0, f.blendWeightLoc);
    }
    if (f.blendIndexFormat) add(f.blendIndexOff, f.blendIndexFormat === "uint8x4" ? 5 : 4, 2, 0, f.blendIndexLoc);
    return elements;
}

/** One FVF vertex as the GPU will see it: which components survive the bound stride, where
 *  they sit, and the two numbers the draw is sized by. */
export interface FvfVertexPlan {
    hasRhw: boolean;
    hasNormal: boolean;
    hasColor: boolean;
    hasSpecular: boolean;
    hasTex: boolean;
    hasTex1: boolean;
    hasTexSets: boolean[];
    texLocs: number[]; texOffsets: number[]; texDims: number[];
    blendWeightCount: number;
    blendWeightLoc: number; blendWeightOffset: number; blendWeightDims: number;
    blendIndexLoc: number; blendIndexOffset: number;
    blendIndexFormat: "uint8x4" | "unorm8x4" | null;
    posLoc: number; normalLoc: number; colorLoc: number;
    specularLoc: number; texLoc: number; tex1Loc: number;
    attributes: GPUVertexAttribute[];
    /** How far apart vertices are — the bound stride wherever there is one. */
    arrayStride: number;
    /** End offset of the furthest kept attribute (WebGPU's last-vertex rule). */
    attrEnd: number;
}

/**
 * Reconcile an FVF against the stride the guest actually bound.
 *
 * The BOUND stride wins: D3D9 steps a stream by SetStreamSource's Stride and reads components
 * at the FVF's offsets inside that vertex. Raising the stride to the FVF's packed size reads
 * every vertex after the first out of its successor and sizes the draw past the buffer's end.
 * Components that no longer fit are dropped here, before either half is emitted — the shader
 * then reads its usual absent-component default. Position is exempt: without it there is no
 * draw to salvage, so a stride too small to hold it is raised to the packed size instead.
 */
export function planFvf(fvf: number, boundStride = 0): FvfVertexPlan {
    const f = parseFvf(fvf);
    const posFormat: GPUVertexFormat = f.hasRhw ? "float32x4" : "float32x3";
    const posEnd = f.posOff + vertexFormatSize(posFormat);
    const wanted = boundStride > 0 ? boundStride : f.stride;
    const arrayStride = posEnd <= wanted ? wanted : Math.max(wanted, f.stride);

    const attributes: GPUVertexAttribute[] = [];
    let attrEnd = 0;
    const keep = (present: boolean, loc: number, offset: number, format: GPUVertexFormat): boolean => {
        if (!present || loc < 0) return false;
        const end = offset + vertexFormatSize(format);
        if (end > arrayStride) return false;
        attributes.push({ shaderLocation: loc, offset, format });
        attrEnd = Math.max(attrEnd, end);
        return true;
    };

    keep(true, f.posLoc, f.posOff, posFormat);
    const hasNormal = keep(f.hasNormal, f.normalLoc, f.normalOff, "float32x3");
    const hasColor = keep(f.hasColor, f.colorLoc, f.colorOff, "uint32");
    const hasSpecular = keep(f.hasSpecular, f.specularLoc, f.specularOff, "uint32");
    const formatForDims = (dims: number): GPUVertexFormat => {
        switch (dims) {
            case 1: return "float32";
            case 3: return "float32x3";
            case 4: return "float32x4";
            default: return "float32x2";
        }
    };
    const hasTexSets = f.texLocs.map((loc, i) =>
        keep(loc >= 0, loc, f.texOffs[i] ?? 0, formatForDims(f.texDims[i] ?? 0)));
    const hasTex = hasTexSets.some(Boolean);
    const hasTex1 = hasTexSets[1] ?? false;

    const weightFormat = (dims: number): GPUVertexFormat => {
        switch (dims) {
            case 1: return "float32";
            case 2: return "float32x2";
            case 3: return "float32x3";
            default: return "float32x4";
        }
    };
    const hasBlendWeights = keep(f.blendWeightLoc >= 0, f.blendWeightLoc, f.blendWeightOff,
        weightFormat(f.blendWeightDims));
    const blendIndexFormat = f.blendIndexFormat;
    const hasBlendIndices = keep(!!blendIndexFormat, f.blendIndexLoc, f.blendIndexOff,
        blendIndexFormat ?? "uint8x4");

    return {
        hasRhw: f.hasRhw, hasNormal, hasColor, hasSpecular, hasTex, hasTex1, hasTexSets,
        posLoc: f.posLoc, normalLoc: f.normalLoc, colorLoc: f.colorLoc,
        specularLoc: f.specularLoc, texLoc: f.texLoc, tex1Loc: f.tex1Loc,
        texLocs: f.texLocs, texOffsets: f.texOffs, texDims: f.texDims,
        blendWeightCount: hasBlendWeights ? f.blendWeightCount : 0,
        blendWeightLoc: hasBlendWeights ? f.blendWeightLoc : -1,
        blendWeightOffset: f.blendWeightOff, blendWeightDims: f.blendWeightDims,
        blendIndexLoc: hasBlendIndices ? f.blendIndexLoc : -1,
        blendIndexOffset: f.blendIndexOff, blendIndexFormat,
        attributes, arrayStride, attrEnd,
    };
}
