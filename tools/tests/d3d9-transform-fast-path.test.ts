import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { registerFastPathD3D9Functions } from "../../src/worker/modules/d3d9/fast-path";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { devices } from "../../src/worker/modules/d3d9/shared-state";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE_PTR = 0x2a;
const D3DTS_WORLD = 256;
const ESP = 0x40;

type FastPath = (esp: number, view: DataView, mem: Uint8Array) => number | null;

let mem: Uint8Array;
let view: DataView;
let world: Float32Array;
let multiplied: Array<[number, number[]]>;
const fast = new Map<string, FastPath>();

function call(name: string, ...args: number[]): number | null {
    view.setUint32(ESP, 0, true);
    args.forEach((a, i) => view.setUint32(ESP + 4 + 4 * i, a, true));
    return fast.get(name)!(ESP, view, mem);
}

beforeEach(() => {
    mem = new Uint8Array(0x1000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    world = Float32Array.from({ length: 16 }, (_, i) => i * 1.5 - 3);
    multiplied = [];
    devices.set(DEVICE_PTR, {
        getTransform(state: number) { return state === D3DTS_WORLD ? world : null; },
        multiplyTransform(state: number, m: Float32Array) {
            multiplied.push([state, Array.from(m)]);
            return state === D3DTS_WORLD ? D3D_OK : D3DERR_INVALIDCALL;
        },
    } as never);
    const dispatcher = new Proxy({}, {
        get: (_t, key) => key === "registerFastPath"
            ? (_dll: string, fn: string, impl: FastPath) => { fast.set(fn, impl); }
            : () => undefined,
    });
    registerFastPathD3D9Functions(dispatcher as never);
});

afterEach(() => {
    devices.delete(DEVICE_PTR);
});

describe("D3D9 transform fast paths", () => {
    test("GetTransform writes the same bytes as the full thunk", () => {
        const slow = createStateExports().IDirect3DDevice9_GetTransform!;
        expect(call("IDirect3DDevice9_GetTransform", DEVICE_PTR, D3DTS_WORLD, 0x100)).toBe(D3D_OK);
        expect(slow(null, mem, [DEVICE_PTR, D3DTS_WORLD, 0x200])).toBe(D3D_OK);
        expect(Array.from(mem.subarray(0x100, 0x140))).toEqual(Array.from(mem.subarray(0x200, 0x240)));
        expect(view.getFloat32(0x100 + 4 * 5, true)).toBe(4.5);
    });

    test("GetTransform leaves anything unusual to the full thunk", () => {
        expect(call("IDirect3DDevice9_GetTransform", 0xdead, D3DTS_WORLD, 0x100)).toBeNull();
        expect(call("IDirect3DDevice9_GetTransform", DEVICE_PTR, D3DTS_WORLD, 0)).toBeNull();
        expect(call("IDirect3DDevice9_GetTransform", DEVICE_PTR, D3DTS_WORLD, mem.length - 8)).toBeNull();
        expect(call("IDirect3DDevice9_GetTransform", DEVICE_PTR, 7, 0x100)).toBeNull();
        expect(mem.subarray(0x100, 0x140).every((b) => b === 0)).toBe(true);
    });

    test("MultiplyTransform hands the device the operand the full thunk hands it", () => {
        const slow = createStateExports().IDirect3DDevice9_MultiplyTransform!;
        for (let i = 0; i < 16; i++) view.setFloat32(0x300 + 4 * i, i / 3, true);
        expect(call("IDirect3DDevice9_MultiplyTransform", DEVICE_PTR, D3DTS_WORLD, 0x300)).toBe(D3D_OK);
        expect(slow(null, mem, [DEVICE_PTR, D3DTS_WORLD, 0x300])).toBe(D3D_OK);
        expect(multiplied.length).toBe(2);
        expect(multiplied[0]).toEqual(multiplied[1]);
        expect(call("IDirect3DDevice9_MultiplyTransform", DEVICE_PTR, 7, 0x300)).toBe(D3DERR_INVALIDCALL);
    });

    test("MultiplyTransform rejects what the full thunk rejects", () => {
        expect(call("IDirect3DDevice9_MultiplyTransform", 0xdead, D3DTS_WORLD, 0x300)).toBe(D3DERR_INVALIDCALL);
        expect(call("IDirect3DDevice9_MultiplyTransform", DEVICE_PTR, D3DTS_WORLD, 0)).toBe(D3DERR_INVALIDCALL);
        expect(call("IDirect3DDevice9_MultiplyTransform", DEVICE_PTR, D3DTS_WORLD, mem.length - 8)).toBe(D3DERR_INVALIDCALL);
        expect(multiplied.length).toBe(0);
    });
});
