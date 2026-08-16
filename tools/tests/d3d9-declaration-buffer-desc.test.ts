/**
 * D3D9 query-then-fill contracts: the size WE report has to match the bytes WE write.
 *
 * IDirect3DVertexDeclaration9::GetDeclaration is the canonical case. Callers use
 * `GetDeclaration(d, NULL, &n); e = malloc(n * sizeof(D3DVERTEXELEMENT9));
 *  GetDeclaration(d, e, &n);` — so the reported count sizes the caller's buffer.
 * Real D3D9 counts the trailing D3DDECL_END entry (the d3d9 conformance test
 * compares the count against ARRAY_SIZE of a declaration whose last entry IS
 * D3DDECL_END, then memcmp's count*sizeof(element) bytes against the original).
 * Reporting the count without the sentinel while still writing it overflows the
 * caller's allocation by exactly one 8-byte element.
 *
 * The buffer descriptors are pinned alongside because they feed the same idiom and
 * because IDirect3DDevice9::ProcessVertices validates its destination against the
 * very registry they populate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import { vertexDeclComObjects } from "../../src/worker/backends/webgpu/d3d9/d3d9-com-objects";
import { vertexBufferMeta, indexBufferMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { devices } from "../../src/worker/modules/d3d9/shared-state";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const ELEMENT_SIZE = 8;
const POISON = 0xdeadbeef;

const DECL_PTR = 0x1000;
const VB_PTR = 0x1100;
const IB_PTR = 0x1200;
const DEVICE_PTR = 0x1300;
const OUT_BUF = 0x4000;
const OUT_COUNT = 0x5000;

const D3DDECLTYPE_FLOAT3 = 2;
const D3DDECLTYPE_FLOAT2 = 1;
const D3DDECLUSAGE_POSITION = 0;
const D3DDECLUSAGE_TEXCOORD = 5;

/** What CreateVertexDeclaration stores: everything before the 0xFF sentinel. */
const STORED_ELEMENTS = [
    { stream: 0, offset: 0, type: D3DDECLTYPE_FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
    { stream: 0, offset: 12, type: D3DDECLTYPE_FLOAT2, usage: D3DDECLUSAGE_TEXCOORD, usageIndex: 0 },
];

let mem: Uint8Array;
let view: DataView;
let state: Record<string, any>;
let resources: Record<string, any>;

function call(table: Record<string, any>, name: string, ...args: number[]): number {
    return table[name]!({ esp: 0 } as any, mem, args as any) as number;
}

function poison(addr: number, dwords: number): void {
    for (let i = 0; i < dwords; i++) view.setUint32(addr + i * 4, POISON, true);
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    state = createStateExports();
    resources = createResourcesExports();

    vertexDeclComObjects.clear();
    vertexDeclComObjects.set(DECL_PTR, {
        devicePtr: DEVICE_PTR,
        internalHandle: 1,
        elements: STORED_ELEMENTS.map((e) => ({ ...e })),
    });
    vertexBufferMeta.clear();
    indexBufferMeta.clear();
    // `devices` is module-level and shared with every other test file in the run. The stand-in
    // needs whatever resetD3D9SharedState() calls on a registered device, or the NEXT file's
    // reset throws on this one's leftovers.
    devices.clear();
    devices.set(DEVICE_PTR, { resetSubsystemPerf() { /* stand-in device */ } } as any);
});

afterEach(() => {
    devices.clear();
});

describe("IDirect3DVertexDeclaration9::GetDeclaration", () => {
    test("the NULL-buffer query counts D3DDECL_END", () => {
        poison(OUT_COUNT, 1);
        expect(call(state, "IDirect3DVertexDeclaration9_GetDeclaration", DECL_PTR, 0, OUT_COUNT)).toBe(D3D_OK);
        expect(view.getUint32(OUT_COUNT, true)).toBe(STORED_ELEMENTS.length + 1);
    });

    test("the fill writes exactly the number of elements the query promised", () => {
        call(state, "IDirect3DVertexDeclaration9_GetDeclaration", DECL_PTR, 0, OUT_COUNT);
        const promised = view.getUint32(OUT_COUNT, true);

        // Size the buffer from the count the caller was given, then poison one element
        // past it — that guard word is the caller's next allocation.
        const guard = OUT_BUF + promised * ELEMENT_SIZE;
        poison(OUT_BUF, promised * 2);
        poison(guard, 2);

        expect(call(state, "IDirect3DVertexDeclaration9_GetDeclaration", DECL_PTR, OUT_BUF, OUT_COUNT)).toBe(D3D_OK);
        expect(view.getUint32(guard, true)).toBe(POISON);
        expect(view.getUint32(guard + 4, true)).toBe(POISON);
    });

    test("the returned array round-trips the declaration and ends in D3DDECL_END", () => {
        call(state, "IDirect3DVertexDeclaration9_GetDeclaration", DECL_PTR, OUT_BUF, OUT_COUNT);

        STORED_ELEMENTS.forEach((e, i) => {
            const at = OUT_BUF + i * ELEMENT_SIZE;
            expect(view.getUint16(at, true)).toBe(e.stream);
            expect(view.getUint16(at + 2, true)).toBe(e.offset);
            expect(view.getUint8(at + 4)).toBe(e.type);
            expect(view.getUint8(at + 6)).toBe(e.usage);
            expect(view.getUint8(at + 7)).toBe(e.usageIndex);
        });

        // D3DDECL_END is {0xFF, 0, D3DDECLTYPE_UNUSED, 0, 0, 0}; a caller terminating on the
        // documented Type == UNUSED test reads past the array if Type says FLOAT1 (0).
        const end = OUT_BUF + STORED_ELEMENTS.length * ELEMENT_SIZE;
        expect(view.getUint16(end, true)).toBe(0xff);
        expect(view.getUint8(end + 4)).toBe(17);
    });

    test("the count is reported even when a buffer is supplied", () => {
        poison(OUT_COUNT, 1);
        call(state, "IDirect3DVertexDeclaration9_GetDeclaration", DECL_PTR, OUT_BUF, OUT_COUNT);
        expect(view.getUint32(OUT_COUNT, true)).toBe(STORED_ELEMENTS.length + 1);
    });

    test("an unknown declaration pointer is D3DERR_INVALIDCALL", () => {
        expect(call(state, "IDirect3DVertexDeclaration9_GetDeclaration", 0x9999, OUT_BUF, OUT_COUNT))
            .toBe(D3DERR_INVALIDCALL);
    });
});

describe("buffer descriptors and the ProcessVertices destination check", () => {
    test("IDirect3DVertexBuffer9::GetDesc reports what CreateVertexBuffer was given", () => {
        vertexBufferMeta.set(VB_PTR, { size: 4096, usage: 0x200, pool: 1, fvf: 0x112 });
        expect(call(resources, "IDirect3DVertexBuffer9_GetDesc", VB_PTR, OUT_BUF)).toBe(D3D_OK);
        expect(view.getUint32(OUT_BUF + 0, true)).toBe(100); // D3DFMT_VERTEXDATA
        expect(view.getUint32(OUT_BUF + 4, true)).toBe(6);   // D3DRTYPE_VERTEXBUFFER
        expect(view.getUint32(OUT_BUF + 8, true)).toBe(0x200);
        expect(view.getUint32(OUT_BUF + 12, true)).toBe(1);
        expect(view.getUint32(OUT_BUF + 16, true)).toBe(4096);
        expect(view.getUint32(OUT_BUF + 20, true)).toBe(0x112);
    });

    test("IDirect3DIndexBuffer9::GetDesc has no FVF field", () => {
        indexBufferMeta.set(IB_PTR, { size: 512, usage: 0, pool: 0, format: 101 });
        poison(OUT_BUF + 20, 1);
        expect(call(resources, "IDirect3DIndexBuffer9_GetDesc", IB_PTR, OUT_BUF)).toBe(D3D_OK);
        expect(view.getUint32(OUT_BUF + 0, true)).toBe(101); // D3DFMT_INDEX16
        expect(view.getUint32(OUT_BUF + 4, true)).toBe(7);   // D3DRTYPE_INDEXBUFFER
        expect(view.getUint32(OUT_BUF + 16, true)).toBe(512);
        expect(view.getUint32(OUT_BUF + 20, true)).toBe(POISON);
    });

    test("GetDesc on an unregistered buffer fails instead of reporting zeroes", () => {
        expect(call(resources, "IDirect3DVertexBuffer9_GetDesc", 0x9999, OUT_BUF)).toBe(D3DERR_INVALIDCALL);
        expect(call(resources, "IDirect3DIndexBuffer9_GetDesc", 0x9999, OUT_BUF)).toBe(D3DERR_INVALIDCALL);
    });

    test("ProcessVertices accepts a registered destination and rejects an unknown one", () => {
        vertexBufferMeta.set(VB_PTR, { size: 4096, usage: 0, pool: 0, fvf: 0 });
        expect(call(state, "IDirect3DDevice9_ProcessVertices", DEVICE_PTR, 0, 0, 8, VB_PTR, 0, 0)).toBe(D3D_OK);
        expect(call(state, "IDirect3DDevice9_ProcessVertices", DEVICE_PTR, 0, 0, 8, 0x9999, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
    });
});
