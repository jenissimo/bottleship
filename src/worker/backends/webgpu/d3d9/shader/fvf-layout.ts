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

const D3DFVF_TEXCOUNT_MASK = 0x0f00;
const D3DFVF_TEXCOUNT_SHIFT = 8;

/**
 * Parsed FVF layout in D3D byte order (position, normal, psize, diffuse, specular, texcoord
 * sets), with contiguous shader locations.
 *
 * `stride` is the whole vertex, INCLUDING components we declare no attribute for (blend
 * weights, point size, texcoord sets past the first) — it is the PACKED size the FVF implies,
 * used only where the guest bound no stride of its own.
 */
export interface FvfLayout {
    hasRhw: boolean;
    hasNormal: boolean;
    hasColor: boolean;
    hasSpecular: boolean;
    hasTex: boolean;
    /** Texture coordinate sets present (D3DFVF_TEXCOUNT). Sets 0 and 1 get attributes
     *  (stages 0 and 1); further sets occupy stride only. */
    texCount: number;
    hasTex1: boolean;
    posLoc: number; posOff: number;
    normalLoc: number; normalOff: number;
    colorLoc: number; colorOff: number;
    specularLoc: number; specularOff: number;
    texLoc: number; texOff: number;
    tex1Loc: number; tex1Off: number;
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

export function parseFvf(fvf: number): FvfLayout {
    const hasRhw = (fvf & D3DFVF_XYZRHW) !== 0;
    // RHW (pre-transformed) vertices carry no normal and skip lighting.
    const hasNormal = !hasRhw && (fvf & D3DFVF_NORMAL) !== 0;
    const hasPsize = (fvf & D3DFVF_PSIZE) !== 0;
    const hasColor = (fvf & D3DFVF_DIFFUSE) !== 0;
    const hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
    const texCount = (fvf & D3DFVF_TEXCOUNT_MASK) >>> D3DFVF_TEXCOUNT_SHIFT;
    // Sets 0 and 1 feed texture stages 0 and 1; sets past those still occupy stride and must
    // be stepped over even though nothing samples them.
    const hasTex = texCount > 0 && fvfTexCoordFloats(fvf, 0) >= 2;
    const hasTex1 = texCount > 1 && fvfTexCoordFloats(fvf, 1) >= 2;

    let loc = 0, off = 0;
    const posLoc = loc++; const posOff = off; off += fvfPositionBytes(fvf);
    let normalLoc = -1, normalOff = 0;
    if (hasNormal) { normalLoc = loc++; normalOff = off; off += 12; }
    if (hasPsize) off += 4;
    let colorLoc = -1, colorOff = 0;
    if (hasColor) { colorLoc = loc++; colorOff = off; off += 4; }
    let specularLoc = -1, specularOff = 0;
    if (hasSpecular) { specularLoc = loc++; specularOff = off; off += 4; }
    let texLoc = -1, texOff = 0, tex1Loc = -1, tex1Off = 0;
    for (let i = 0; i < texCount; i++) {
        if (i === 0 && hasTex) { texLoc = loc++; texOff = off; }
        if (i === 1 && hasTex1) { tex1Loc = loc++; tex1Off = off; }
        off += fvfTexCoordFloats(fvf, i) * 4;
    }

    return {
        hasRhw, hasNormal, hasColor, hasSpecular, hasTex, hasTex1, texCount,
        posLoc, posOff, normalLoc, normalOff, colorLoc, colorOff,
        specularLoc, specularOff, texLoc, texOff, tex1Loc, tex1Off, stride: off,
    };
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
    const hasTex = keep(f.hasTex, f.texLoc, f.texOff, "float32x2");
    const hasTex1 = keep(f.hasTex1, f.tex1Loc, f.tex1Off, "float32x2");

    return {
        hasRhw: f.hasRhw, hasNormal, hasColor, hasSpecular, hasTex, hasTex1,
        posLoc: f.posLoc, normalLoc: f.normalLoc, colorLoc: f.colorLoc,
        specularLoc: f.specularLoc, texLoc: f.texLoc, tex1Loc: f.tex1Loc,
        attributes, arrayStride, attrEnd,
    };
}
