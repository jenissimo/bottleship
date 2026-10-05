import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { devices } from "../../src/worker/modules/d3d9/shared-state";
import { deviceBoundDepthStencil } from "../../src/worker/modules/d3d9/resource-registry";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE = 0x120;
const DEPTH_SURFACE = 0x130;
const RECTS = 0x400;
const LIGHT = 0x600;
const OUT = 0x700;
const PROTECTED = 0x800;

const D3DCLEAR_TARGET = 1;
const D3DCLEAR_ZBUFFER = 2;
const D3DCLEAR_STENCIL = 4;

type ClearRect = { left: number; top: number; right: number; bottom: number };

let memory: Uint8Array;
let device: Record<string, any>;
let state: Record<string, any>;
let fullClears: number;
let rectClears: ClearRect[][];
let lights: Map<number, Uint8Array>;
let lightEnables: Map<number, number>;
let originalProcess: unknown;

const fakeDevice = {
    clear: () => { fullClears++; },
    clearTargetRects: (rects: ClearRect[]) => { rectClears.push(rects); return true; },
    setLight: (index: number, data: Uint8Array) => { lights.set(index, data); return D3D_OK; },
    getLight: (index: number) => lights.get(index) ?? null,
    lightEnable: (index: number, enable: number) => { lightEnables.set(index, enable ? 1 : 0); return D3D_OK; },
    getLightEnable: (index: number) => lightEnables.get(index) ?? 0,
    resetSubsystemPerf: () => undefined,
} as any;

function callDevice(name: string, ...args: number[]): number {
    return device[name]!({ esp: 0 }, memory, args) as number;
}

function writeRect(index: number, rect: ClearRect): void {
    const view = new DataView(memory.buffer);
    const ptr = RECTS + index * 16;
    view.setInt32(ptr + 0, rect.left, true);
    view.setInt32(ptr + 4, rect.top, true);
    view.setInt32(ptr + 8, rect.right, true);
    view.setInt32(ptr + 12, rect.bottom, true);
}

beforeEach(() => {
    const system = System.getInstance() as any;
    originalProcess = system.process;
    memory = new Uint8Array(0x10000);
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    // Stands in for the region map: [PROTECTED, +0x100) is not readable guest memory.
    system.process = {
        addressSpace: {
            validateRange: (address: number, size: number) =>
                address >= 0 && address + size <= memory.length
                && !(address < PROTECTED + 0x100 && address + size > PROTECTED),
        },
        getCurrentMemory: () => memory,
    };
    fullClears = 0;
    rectClears = [];
    lights = new Map();
    lightEnables = new Map();
    devices.clear();
    devices.set(DEVICE, fakeDevice);
    deviceBoundDepthStencil.set(DEVICE, DEPTH_SURFACE);
    device = createDeviceExports();
    state = createStateExports();
});

afterEach(() => {
    devices.clear();
    deviceBoundDepthStencil.clear();
    System.getInstance().process = originalProcess as any;
});

describe("IDirect3DDevice9::Clear", () => {
    test("Count 0 with a non-NULL rect array clears nothing", () => {
        writeRect(0, { left: 0, top: 0, right: 8, bottom: 8 });
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, RECTS, D3DCLEAR_TARGET, 0xff00ff00, 0, 0))
            .toBe(D3D_OK);
        expect(fullClears).toBe(0);
        expect(rectClears).toEqual([]);

        // A NULL rect array is still the whole-target clear.
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, 0, D3DCLEAR_TARGET, 0xff00ff00, 0, 0))
            .toBe(D3D_OK);
        expect(fullClears).toBe(1);
    });

    test("an empty rect is skipped and the rest of the list still clears", () => {
        writeRect(0, { left: 10, top: 10, right: 10, bottom: 20 }); // collapsed panel
        writeRect(1, { left: 0, top: 0, right: 16, bottom: 16 });
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 2, RECTS, D3DCLEAR_TARGET, 0, 0, 0))
            .toBe(D3D_OK);
        expect(rectClears).toEqual([[{ left: 0, top: 0, right: 16, bottom: 16 }]]);

        // A list of nothing but empty rects clears nothing and still succeeds.
        writeRect(1, { left: 4, top: 9, right: 4, bottom: 9 });
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 2, RECTS, D3DCLEAR_TARGET, 0, 0, 0))
            .toBe(D3D_OK);
        expect(rectClears.length).toBe(1);
    });

    test("Z/stencil flags require a bound depth-stencil", () => {
        deviceBoundDepthStencil.delete(DEVICE);
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, 0, D3DCLEAR_ZBUFFER, 0, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, 0, D3DCLEAR_TARGET | D3DCLEAR_STENCIL, 0, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(fullClears).toBe(0);

        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, 0, D3DCLEAR_TARGET, 0, 0, 0)).toBe(D3D_OK);
        expect(fullClears).toBe(1);

        deviceBoundDepthStencil.set(DEVICE, DEPTH_SURFACE);
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0, 0, D3DCLEAR_ZBUFFER, 0, 0, 0)).toBe(D3D_OK);
        expect(fullClears).toBe(2);
    });

    test("the rect array is validated against the region map, not just bounds", () => {
        const view = new DataView(memory.buffer);
        view.setInt32(PROTECTED + 0, 0, true);
        view.setInt32(PROTECTED + 4, 0, true);
        view.setInt32(PROTECTED + 8, 8, true);
        view.setInt32(PROTECTED + 12, 8, true);
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 1, PROTECTED, D3DCLEAR_TARGET, 0, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(rectClears).toEqual([]);
    });

    test("a garbage rect count is rejected instead of iterated", () => {
        writeRect(0, { left: 0, top: 0, right: 4, bottom: 4 });
        expect(callDevice("IDirect3DDevice9_Clear", DEVICE, 0xffffffff, RECTS, D3DCLEAR_TARGET, 0, 0, 0))
            .toBe(D3DERR_INVALIDCALL);
        expect(rectClears).toEqual([]);
        expect(fullClears).toBe(0);
    });
});

describe("D3D9 light index space", () => {
    test("SetLight/LightEnable accept a sparse index above MaxActiveLights", () => {
        memory.fill(0x11, LIGHT, LIGHT + 0x68);
        expect(state.IDirect3DDevice9_SetLight!({ esp: 0 }, memory, [DEVICE, 64, LIGHT])).toBe(D3D_OK);
        expect(lights.has(64)).toBe(true);
        expect(state.IDirect3DDevice9_GetLight!({ esp: 0 }, memory, [DEVICE, 64, OUT])).toBe(D3D_OK);
        expect(state.IDirect3DDevice9_LightEnable!({ esp: 0 }, memory, [DEVICE, 64, 1])).toBe(D3D_OK);
        expect(lightEnables.get(64)).toBe(1);
        expect(state.IDirect3DDevice9_GetLightEnable!({ esp: 0 }, memory, [DEVICE, 64, OUT])).toBe(D3D_OK);
        expect(Mem.readUint32(OUT)).toBe(1);
    });

    test("an unset high index still reports 'not a light' rather than a bad call", () => {
        expect(state.IDirect3DDevice9_GetLight!({ esp: 0 }, memory, [DEVICE, 100, OUT])).toBe(D3DERR_INVALIDCALL);
        expect(state.IDirect3DDevice9_GetLightEnable!({ esp: 0 }, memory, [DEVICE, 100, OUT])).toBe(D3D_OK);
        expect(Mem.readUint32(OUT)).toBe(0);
    });
});

describe("SetRenderState out-of-range selectors", () => {
    test("report success without storing, exactly as the fast path does", () => {
        let applied = 0;
        devices.set(DEVICE, { ...fakeDevice, setRenderState: () => { applied++; return D3D_OK; } } as any);
        const table = createStateExports();
        expect(table.IDirect3DDevice9_SetRenderState!({ esp: 0 }, memory, [DEVICE, 300, 1])).toBe(D3D_OK);
        expect(applied).toBe(0);
        expect(table.IDirect3DDevice9_SetRenderState!({ esp: 0 }, memory, [DEVICE, 7, 1])).toBe(D3D_OK);
        expect(applied).toBe(1);
    });
});
