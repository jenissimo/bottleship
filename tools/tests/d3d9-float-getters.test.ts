import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { devices } from "../../src/worker/modules/d3d9/shared-state";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE_PTR = 0x2a;

let mem: Uint8Array;
let vsCalls: Array<[number, number]>;
let psCalls: Array<[number, number]>;

beforeEach(() => {
    mem = new Uint8Array(0x1000);
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    vsCalls = [];
    psCalls = [];
    devices.set(DEVICE_PTR, {
        getVertexShaderConstants(start: number, count: number) {
            vsCalls.push([start, count]);
            return Float32Array.from({ length: count * 4 }, (_, i) => start * 10 + i + 0.25);
        },
        getPixelShaderConstants(start: number, count: number) {
            psCalls.push([start, count]);
            return Float32Array.from({ length: count * 4 }, (_, i) => -(start * 10 + i + 0.5));
        },
    } as never);
});

afterEach(() => {
    devices.delete(DEVICE_PTR);
});

describe("D3D9 floating-point shader constant getter ABI", () => {
    test("writes every VS and PS float lane to guest output memory", () => {
        const state = createStateExports();
        const vsOut = 0x100;
        const psOut = 0x200;

        expect(state.IDirect3DDevice9_GetVertexShaderConstantF!(null, mem, [DEVICE_PTR, 2, vsOut, 2])).toBe(D3D_OK);
        expect(state.IDirect3DDevice9_GetPixelShaderConstantF!(null, mem, [DEVICE_PTR, 3, psOut, 1])).toBe(D3D_OK);

        const view = new DataView(mem.buffer);
        expect(Array.from({ length: 8 }, (_, i) => view.getFloat32(vsOut + i * 4, true))).toEqual([
            20.25, 21.25, 22.25, 23.25, 24.25, 25.25, 26.25, 27.25,
        ]);
        expect(Array.from({ length: 4 }, (_, i) => view.getFloat32(psOut + i * 4, true))).toEqual([
            -30.5, -31.5, -32.5, -33.5,
        ]);
        expect(vsCalls).toEqual([[2, 2]]);
        expect(psCalls).toEqual([[3, 1]]);
    });

    test("accepts the final register and zero vectors at the end of each bank", () => {
        const state = createStateExports();

        expect(state.IDirect3DDevice9_GetVertexShaderConstantF!(null, mem, [DEVICE_PTR, 255, 0x100, 1])).toBe(D3D_OK);
        expect(state.IDirect3DDevice9_GetPixelShaderConstantF!(null, mem, [DEVICE_PTR, 223, 0x200, 1])).toBe(D3D_OK);
        expect(state.IDirect3DDevice9_GetVertexShaderConstantF!(null, mem, [DEVICE_PTR, 256, 0, 0])).toBe(D3D_OK);
        expect(state.IDirect3DDevice9_GetPixelShaderConstantF!(null, mem, [DEVICE_PTR, 224, 0, 0])).toBe(D3D_OK);

        expect(vsCalls).toEqual([[255, 1], [256, 0]]);
        expect(psCalls).toEqual([[223, 1], [224, 0]]);
    });

    test("rejects invalid devices, pointers, unsigned ranges, and overflowing output memory", () => {
        const state = createStateExports();
        const getVS = state.IDirect3DDevice9_GetVertexShaderConstantF!;
        const getPS = state.IDirect3DDevice9_GetPixelShaderConstantF!;

        expect(getVS(null, mem, [0xdead, 0, 0x100, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [0xdead, 0, 0x100, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getVS(null, mem, [DEVICE_PTR, 0, 0, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [DEVICE_PTR, 0, 0, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getVS(null, mem, [DEVICE_PTR, 256, 0x100, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [DEVICE_PTR, 224, 0x100, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getVS(null, mem, [DEVICE_PTR, 257, 0, 0])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [DEVICE_PTR, 225, 0, 0])).toBe(D3DERR_INVALIDCALL);
        expect(getVS(null, mem, [DEVICE_PTR, -1, 0, 0])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [DEVICE_PTR, 0, 0x100, -1])).toBe(D3DERR_INVALIDCALL);
        expect(getVS(null, mem, [DEVICE_PTR, 0, mem.length - 8, 1])).toBe(D3DERR_INVALIDCALL);
        expect(getPS(null, mem, [DEVICE_PTR, 0, mem.length - 8, 1])).toBe(D3DERR_INVALIDCALL);

        expect(vsCalls).toEqual([[0, 1]]);
        expect(psCalls).toEqual([[0, 1]]);
    });
});
