/**
 * Pins the fixes from docs/d3d8-parity/04-vertex-pipeline.md (Findings 1, 2, 5) and
 * 02-samplers.md (F4): programmable-VS topology, D3DCOLOR-vs-UBYTE4 disambiguation,
 * per-element texcoord degrade, D3DVSDE_POSITION2/NORMAL2, and D3DVSD_CONSTMEM parsing.
 */
import { describe, expect, test } from "bun:test";
import {
    resolveD3D8Topology,
    buildFanIndices,
    readGuestIndices,
    interleaveDeclVertices,
    primCountToVertexCount,
} from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { declToSyntheticFvf } from "../../src/worker/backends/webgpu/d3d8/decl-to-ffp";
import { parseVsdDeclaration } from "../../src/worker/backends/webgpu/d3d8/vsd-parser";
import {
    D3DVSD_STREAM,
    D3DVSD_REG,
    D3DVSD_END,
    D3DVSD_MAKETOKENTYPE,
    D3DVSD_TOKEN_CONSTMEM,
    D3DVSD_CONSTCOUNTSHIFT,
    D3DVSDE_POSITION,
    D3DVSDE_TEXCOORD0,
    D3DVSDE_POSITION2,
    D3DVSDE_NORMAL2,
    D3DVSDT_FLOAT2,
    D3DVSDT_FLOAT3,
    D3DVSDT_D3DCOLOR,
    D3DVSDT_UBYTE4,
} from "../../src/worker/backends/webgpu/d3d8/vsd-constants";
import type { RawVertexElement } from "../../src/worker/backends/webgpu/d3d9/shader";

// D3DPRIMITIVETYPE
const D3DPT_POINTLIST = 1;
const D3DPT_LINELIST = 2;
const D3DPT_LINESTRIP = 3;
const D3DPT_TRIANGLELIST = 4;
const D3DPT_TRIANGLESTRIP = 5;
const D3DPT_TRIANGLEFAN = 6;

describe("d3d8 programmable-VS topology (Finding 5)", () => {
    test("every D3DPRIMITIVETYPE maps to a distinct, correct WebGPU topology", () => {
        expect(resolveD3D8Topology(D3DPT_POINTLIST).topology).toBe("point-list");
        expect(resolveD3D8Topology(D3DPT_LINELIST).topology).toBe("line-list");
        expect(resolveD3D8Topology(D3DPT_LINESTRIP).topology).toBe("line-strip");
        expect(resolveD3D8Topology(D3DPT_TRIANGLELIST).topology).toBe("triangle-list");
        expect(resolveD3D8Topology(D3DPT_TRIANGLESTRIP).topology).toBe("triangle-strip");
        // TRIANGLEFAN has no WebGPU topology: resolved as triangle-list + CPU expansion.
        expect(resolveD3D8Topology(D3DPT_TRIANGLEFAN).topology).toBe("triangle-list");
    });

    test("only TRIANGLEFAN needs CPU (index) expansion — strip/point/line are native", () => {
        expect(resolveD3D8Topology(D3DPT_POINTLIST).needsFanExpansion).toBe(false);
        expect(resolveD3D8Topology(D3DPT_LINELIST).needsFanExpansion).toBe(false);
        expect(resolveD3D8Topology(D3DPT_LINESTRIP).needsFanExpansion).toBe(false);
        expect(resolveD3D8Topology(D3DPT_TRIANGLELIST).needsFanExpansion).toBe(false);
        expect(resolveD3D8Topology(D3DPT_TRIANGLESTRIP).needsFanExpansion).toBe(false);
        expect(resolveD3D8Topology(D3DPT_TRIANGLEFAN).needsFanExpansion).toBe(true);
    });

    test("point/line topologies force cull-none; triangle topologies do not", () => {
        expect(resolveD3D8Topology(D3DPT_POINTLIST).isLineOrPoint).toBe(true);
        expect(resolveD3D8Topology(D3DPT_LINELIST).isLineOrPoint).toBe(true);
        expect(resolveD3D8Topology(D3DPT_LINESTRIP).isLineOrPoint).toBe(true);
        expect(resolveD3D8Topology(D3DPT_TRIANGLELIST).isLineOrPoint).toBe(false);
        expect(resolveD3D8Topology(D3DPT_TRIANGLESTRIP).isLineOrPoint).toBe(false);
        expect(resolveD3D8Topology(D3DPT_TRIANGLEFAN).isLineOrPoint).toBe(false);
    });

    test("buildFanIndices: non-indexed fan (0-based) — v0,v[i+1],v[i+2] per triangle", () => {
        // A fan of primCount=3 triangles has 5 vertices (0..4).
        const idx = buildFanIndices(3);
        expect(Array.from(idx)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
        expect(idx).toBeInstanceOf(Uint16Array);
    });

    test("buildFanIndices: indexed fan gathers the REAL original index values, not positions", () => {
        // Original index buffer for a 5-vertex fan, deliberately non-identity to prove we
        // gather values rather than re-emit 0..4.
        const original = new Uint32Array([40, 41, 42, 43, 44]);
        const idx = buildFanIndices(3, original);
        expect(Array.from(idx)).toEqual([40, 41, 42, 40, 42, 43, 40, 43, 44]);
    });

    test("buildFanIndices promotes to Uint32Array only when an index exceeds 65535", () => {
        const small = buildFanIndices(1, new Uint32Array([0, 1, 2]));
        expect(small).toBeInstanceOf(Uint16Array);
        const big = buildFanIndices(1, new Uint32Array([0, 1, 70000]));
        expect(big).toBeInstanceOf(Uint32Array);
    });

    test("readGuestIndices reads 16- and 32-bit guest index buffers without alignment assumptions", () => {
        const mem = new Uint8Array(32);
        const dv = new DataView(mem.buffer);
        // Deliberately unaligned base (ptr=3) — must not throw / misread.
        dv.setUint16(3, 7, true);
        dv.setUint16(5, 8, true);
        dv.setUint16(7, 9, true);
        expect(Array.from(readGuestIndices(mem, 3, 3, false)!)).toEqual([7, 8, 9]);

        dv.setUint32(3, 1000, true);
        dv.setUint32(7, 2000, true);
        expect(Array.from(readGuestIndices(mem, 3, 2, true)!)).toEqual([1000, 2000]);
    });

    test("readGuestIndices refuses an index extent that leaves guest memory", () => {
        // A guest-supplied count that runs off the buffer used to throw a RangeError out of
        // the middle of a draw; the boundary must refuse instead (-> D3DERR_INVALIDCALL).
        const mem = new Uint8Array(32);
        expect(readGuestIndices(mem, 30, 4, false)).toBeNull();   // 8 bytes from offset 30
        expect(readGuestIndices(mem, 24, 4, true)).toBeNull();    // 16 bytes from offset 24
        expect(readGuestIndices(mem, -4, 2, false)).toBeNull();
        // Exactly-fitting extents are still accepted.
        expect(readGuestIndices(mem, 24, 4, false)).not.toBeNull();
    });

    test("readGuestIndices fills a caller-owned scratch instead of allocating per fan draw", () => {
        const mem = new Uint8Array(32);
        new DataView(mem.buffer).setUint16(0, 5, true);
        const scratch = new Uint32Array(64);
        const out = readGuestIndices(mem, 0, 1, false, scratch)!;
        expect(out.buffer).toBe(scratch.buffer);
        expect(out.length).toBe(1);
        expect(out[0]).toBe(5);
    });

    test("primCountToVertexCount agrees with the fan/strip vertex counts used above", () => {
        expect(primCountToVertexCount(D3DPT_TRIANGLEFAN, 3)).toBe(5);
        expect(primCountToVertexCount(D3DPT_TRIANGLESTRIP, 3)).toBe(5);
        expect(primCountToVertexCount(D3DPT_POINTLIST, 7)).toBe(7);
    });
});

function elem(partial: Partial<RawVertexElement> & Pick<RawVertexElement, "usage" | "type" | "offset">): RawVertexElement {
    return { stream: 1, usageIndex: 0, ...partial };
}

describe("decl-to-ffp D3DCOLOR vs UBYTE4 disambiguation (Finding 1)", () => {
    // usage codes local to decl-to-ffp.ts's RawVertexElement convention.
    const D3DDECLUSAGE_POSITION = 0;
    const D3DDECLUSAGE_COLOR = 10;

    test("a D3DCOLOR-typed diffuse register copies straight through (no swizzle)", () => {
        const elements: RawVertexElement[] = [
            elem({ stream: 0, usage: D3DDECLUSAGE_POSITION, type: 2 /* FLOAT3 */, offset: 0 }),
            elem({ stream: 1, usage: D3DDECLUSAGE_COLOR, type: D3DVSDT_D3DCOLOR, offset: 0 }),
        ];
        const mapping = declToSyntheticFvf(elements, 16);
        expect(mapping.interleave).toBeTruthy();
        const colorCopy = mapping.interleave!.find(c => c.stream === 1)!;
        expect(colorCopy.swizzleColorBytes).toBeFalsy();
        expect(colorCopy.size).toBe(4);
    });

    test("a UBYTE4-typed diffuse register is flagged for a byte swizzle (R<->B)", () => {
        const elements: RawVertexElement[] = [
            elem({ stream: 0, usage: D3DDECLUSAGE_POSITION, type: 2 /* FLOAT3 */, offset: 0 }),
            elem({ stream: 1, usage: D3DDECLUSAGE_COLOR, type: D3DVSDT_UBYTE4, offset: 0 }),
        ];
        const mapping = declToSyntheticFvf(elements, 16);
        expect(mapping.interleave).toBeTruthy();
        const colorCopy = mapping.interleave!.find(c => c.stream === 1)!;
        expect(colorCopy.swizzleColorBytes).toBe(true);
        expect(colorCopy.size).toBe(4);
    });

    test("single-stream UBYTE4 color at an already-canonical offset still forces the remap path", () => {
        // POSITION (FLOAT3, 12B) then COLOR (UBYTE4) at offset 12 — offset IS canonical for
        // D3DFVF_DIFFUSE, so the old "no remap needed" fast path would have skipped the byte
        // swizzle entirely and fed the FFP renderer raw R,G,B,A as if it were D3DCOLOR's B,G,R,A.
        const elements: RawVertexElement[] = [
            elem({ stream: 0, usage: D3DDECLUSAGE_POSITION, type: 2 /* FLOAT3 */, offset: 0 }),
            elem({ stream: 0, usage: D3DDECLUSAGE_COLOR, type: D3DVSDT_UBYTE4, offset: 12 }),
        ];
        const mapping = declToSyntheticFvf(elements, 16);
        expect(mapping.interleave).toBeTruthy();
        const colorCopy = mapping.interleave!.find(c => c.dstOffset === 12)!;
        expect(colorCopy.swizzleColorBytes).toBe(true);
    });
});

describe("decl-to-ffp per-element texcoord degrade (Finding 2)", () => {
    const D3DDECLUSAGE_POSITION = 0;
    const D3DDECLUSAGE_TEXCOORD = 5;

    test("a non-FLOAT2 texcoord degrades only itself — position stays faithful and present", () => {
        const elements: RawVertexElement[] = [
            elem({ stream: 0, usage: D3DDECLUSAGE_POSITION, type: 2 /* FLOAT3 */, offset: 0 }),
            elem({ stream: 1, usage: D3DDECLUSAGE_TEXCOORD, type: D3DVSDT_FLOAT3, offset: 0, usageIndex: 0 }),
        ];
        const mapping = declToSyntheticFvf(elements, 20);
        // Old (buggy) behavior discarded the WHOLE plan (interleave undefined, faithful false,
        // stride=declStride) the instant one texcoord didn't fit — position would never be
        // copied at all. The fix must still produce an interleave plan.
        expect(mapping.interleave).toBeTruthy();
        const posCopy = mapping.interleave!.find(c => c.stream === 0)!;
        expect(posCopy).toBeTruthy();
        expect(posCopy.size).toBe(12);
        // The texcoord element is still present, truncated to the canonical FLOAT2 (8B) slot —
        // not dropped outright, and not corrupting neighboring elements.
        const texCopy = mapping.interleave!.find(c => c.stream === 1)!;
        expect(texCopy).toBeTruthy();
        expect(texCopy.size).toBe(8);
        // Overall mapping is honestly reported as not fully faithful.
        expect(mapping.faithful).toBe(false);
    });

    test("an all-FLOAT2-texcoord multi-stream decl stays fully faithful", () => {
        const elements: RawVertexElement[] = [
            elem({ stream: 0, usage: D3DDECLUSAGE_POSITION, type: 2 /* FLOAT3 */, offset: 0 }),
            elem({ stream: 1, usage: D3DDECLUSAGE_TEXCOORD, type: D3DVSDT_FLOAT2, offset: 0, usageIndex: 0 }),
        ];
        const mapping = declToSyntheticFvf(elements, 16);
        expect(mapping.faithful).toBe(true);
    });
});

describe("vsd-constants D3DVSDE_POSITION2 / D3DVSDE_NORMAL2 (Finding 4)", () => {
    test("v15/v16 map to a second POSITION/NORMAL stream, not raw usage=15/16", () => {
        const tokens = new Uint32Array([
            D3DVSD_STREAM(0),
            D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
            D3DVSD_REG(D3DVSDE_POSITION2, D3DVSDT_FLOAT3),
            D3DVSD_REG(D3DVSDE_NORMAL2, D3DVSDT_FLOAT3),
            D3DVSD_END,
        ]);
        const parsed = parseVsdDeclaration(tokens);
        const pos2 = parsed.elements.find(e => e.reg === D3DVSDE_POSITION2)!;
        const norm2 = parsed.elements.find(e => e.reg === D3DVSDE_NORMAL2)!;
        expect(pos2).toBeTruthy();
        expect(pos2.usage).toBe(0); // D3DDECLUSAGE_POSITION
        expect(pos2.usageIndex).toBe(1);
        expect(norm2).toBeTruthy();
        expect(norm2.usage).toBe(3); // D3DDECLUSAGE_NORMAL
        expect(norm2.usageIndex).toBe(1);
    });
});

describe("vsd-parser D3DVSD_CONSTMEM (Finding 3 / MISSING)", () => {
    function constMemToken(address: number, count: number): number {
        return (D3DVSD_MAKETOKENTYPE(D3DVSD_TOKEN_CONSTMEM) | (count << D3DVSD_CONSTCOUNTSHIFT) | address) >>> 0;
    }

    test("CONSTMEM payload DWORDs are consumed, not misparsed as further tokens", () => {
        const values = new Float32Array([1, 2, 3, 4]);
        const payload = new Uint32Array(values.buffer);
        const tokens = new Uint32Array([
            D3DVSD_STREAM(0),
            D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
            constMemToken(5, 1), // 1 constant (4 DWORDs) at c5
            payload[0]!, payload[1]!, payload[2]!, payload[3]!,
            D3DVSD_REG(D3DVSDE_TEXCOORD0, D3DVSDT_FLOAT2),
            D3DVSD_END,
        ]);
        const parsed = parseVsdDeclaration(tokens);
        // The element AFTER the CONSTMEM block must still parse correctly — proof the payload
        // DWORDs were skipped rather than interpreted as (corrupt) declaration tokens.
        const tex = parsed.elements.find(e => e.usage === 5)!;
        expect(tex).toBeTruthy();
        expect(tex.type).toBe(D3DVSDT_FLOAT2);
        expect(parsed.elements.length).toBe(2); // POSITION + TEXCOORD0 only — no phantom elements.

        // The constant data itself is parsed out (even though not yet wired into the shader).
        expect(parsed.constMemDefs.length).toBe(1);
        expect(parsed.constMemDefs[0]!.address).toBe(5);
        expect(Array.from(parsed.constMemDefs[0]!.values)).toEqual([1, 2, 3, 4]);
    });

    test("a decl with no CONSTMEM token reports no constMemDefs", () => {
        const tokens = new Uint32Array([
            D3DVSD_STREAM(0),
            D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
            D3DVSD_END,
        ]);
        const parsed = parseVsdDeclaration(tokens);
        expect(parsed.constMemDefs.length).toBe(0);
    });
});

describe("decl-only interleave zeroes the untouched part of a canonical slot (Finding 3)", () => {
    // A FLOAT1 texcoord fills 4 of the canonical 8-byte UV slot. The interleave scratch is
    // REUSED across draws, so leaving the V half uncopied hands the FFP whatever the previous
    // draw wrote there — D3D reads a missing component as 0.
    test("a degraded FLOAT1 texcoord yields V=0 over a dirty scratch buffer", () => {
        const decl: RawVertexElement[] = [
            { stream: 0, offset: 0, type: D3DVSDT_FLOAT3, usage: 0, usageIndex: 0 },   // POSITION
            { stream: 0, offset: 12, type: 0 /* FLOAT1 */, usage: 5, usageIndex: 0 },  // TEXCOORD0
        ];
        const mapping = declToSyntheticFvf(decl, 16);
        const plan = mapping.interleave!;
        expect(plan).toBeDefined();
        const uv = plan.find((c) => c.dstOffset === 12)!;
        expect(uv.size).toBe(4);
        expect(uv.slotSize).toBe(8);

        const dstStride = mapping.stride;   // XYZ + one FLOAT2 texcoord = 20
        const mem = new Uint8Array(64);
        new DataView(mem.buffer).setFloat32(12, 0.25, true);  // vertex 0's U

        const scratch = new Uint8Array(dstStride * 2).fill(0xab);  // previous draw's leftovers
        expect(interleaveDeclVertices(plan, scratch, dstStride, 0, 1, mem, [0], [16])).toBe(true);

        const out = new DataView(scratch.buffer);
        expect(out.getFloat32(12, true)).toBe(0.25);   // U copied
        expect(out.getFloat32(16, true)).toBe(0);      // V zeroed, not inherited
    });

    test("a full-width element still copies every byte", () => {
        const decl: RawVertexElement[] = [
            { stream: 0, offset: 0, type: D3DVSDT_FLOAT3, usage: 0, usageIndex: 0 },
            { stream: 0, offset: 12, type: D3DVSDT_FLOAT2, usage: 5, usageIndex: 0 },
        ];
        const mapping = declToSyntheticFvf(decl, 20);
        const plan = mapping.interleave ?? [
            { stream: 0, srcOffset: 0, dstOffset: 0, size: 12, slotSize: 12 },
            { stream: 0, srcOffset: 12, dstOffset: 12, size: 8, slotSize: 8 },
        ];
        const mem = new Uint8Array(64);
        const src = new DataView(mem.buffer);
        src.setFloat32(12, 0.5, true);
        src.setFloat32(16, 0.75, true);
        const scratch = new Uint8Array(40).fill(0xab);
        expect(interleaveDeclVertices(plan, scratch, 20, 0, 1, mem, [0], [20])).toBe(true);
        const out = new DataView(scratch.buffer);
        expect(out.getFloat32(12, true)).toBe(0.5);
        expect(out.getFloat32(16, true)).toBe(0.75);
    });

    test("an out-of-bounds stream extent is refused, not partially copied", () => {
        const plan = [{ stream: 0, srcOffset: 0, dstOffset: 0, size: 8, slotSize: 8 }];
        const mem = new Uint8Array(16);
        const scratch = new Uint8Array(64);
        expect(interleaveDeclVertices(plan, scratch, 8, 0, 4, mem, [0], [8])).toBe(false);
    });
});
