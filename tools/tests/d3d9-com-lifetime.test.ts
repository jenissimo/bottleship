import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { createFactoryExports } from "../../src/worker/modules/d3d9/factory";
import {
    addComRef,
    createComObject,
    devices,
    getComRefCount,
    registerComFinalizer,
    registerDeviceChildFinalizer,
    releaseComRef,
    resetD3D9SharedState,
} from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";
import {
    IID_IDIRECT3DRESOURCE9,
    IID_IDIRECT3DSURFACE9,
    readD3D9GuidKey,
} from "../../src/worker/modules/d3d9/object-contracts";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const IID = 0x2000;

let originalProcess: unknown;
let mem: Uint8Array;
let nextPtr: number;
let freedBlocks: number[];

beforeEach(() => {
    const system = System.getInstance();
    originalProcess = system.process;
    mem = new Uint8Array(0x40000);
    nextPtr = 0x100;
    freedBlocks = [];
    system.process = {
        memory: {
            alloc(size: number) {
                const ptr = nextPtr;
                nextPtr += Math.max(4, size);
                return ptr;
            },
            allocSystemBlock(size: number) {
                const ptr = nextPtr;
                nextPtr += Math.max(16, size);
                return ptr;
            },
            freeSystemBlock(addr: number) {
                freedBlocks.push(addr);
            },
        },
        getCurrentMemory: () => mem,
    } as any;
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    // IID_IUnknown in the guest's Windows GUID byte order.
    mem.set([0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], IID);
    resetD3D9SharedState();
});

afterEach(() => {
    resetD3D9SharedState();
    System.getInstance().process = originalProcess as any;
});

describe("D3D9 COM parent lifetime", () => {
    test("a child keeps its device alive until the child finalizer completes", () => {
        const devicePtr = createComObject(0x1111);
        const childPtr = createComObject(0x2222);
        const order: string[] = [];
        registerComFinalizer(devicePtr, () => order.push("device"));
        registerDeviceChildFinalizer(childPtr, devicePtr, () => order.push("child"));

        // Drop the application's device reference; the child still owns one.
        expect(releaseComRef(devicePtr)).toBe(1);
        expect(order).toEqual([]);

        expect(releaseComRef(childPtr)).toBe(0);
        expect(order).toEqual(["child", "device"]);
    });

    test("GetStreamSource does not leak its AddRef when a later out write fails", () => {
        const devicePtr = createComObject(0x1111);
        const bufferPtr = createComObject(0x2222);
        devices.set(devicePtr, {
            getStreamBinding: () => ({ ptr: bufferPtr, offset: 16, stride: 32 }),
            resetSubsystemPerf: () => {},
        } as any);
        const state = createStateExports();
        const ppStream = 0x300;
        const invalidOffsetOut = mem.length - 2;

        expect(state.IDirect3DDevice9_GetStreamSource(
            { esp: 0 } as any,
            mem,
            [devicePtr, 0, ppStream, invalidOffsetOut, 0] as any,
        )).toBe(D3DERR_INVALIDCALL);

        // No reference was transferred to the failed caller.
        expect(releaseComRef(bufferPtr)).toBe(0);
    });

    test("the last release returns the object's guest block to the pool", () => {
        const objPtr = createComObject(0x1111);
        expect(freedBlocks).toEqual([]);
        expect(releaseComRef(objPtr)).toBe(0);
        expect(freedBlocks.length).toBe(1);
    });
});

describe("IUnknown::QueryInterface", () => {
    const ppv = 0x3000;

    test("QI hands out a NEW reference, so QI+Release is balanced", () => {
        const state = createStateExports();
        const texturePtr = createComObject(0x2222);

        expect(state.IDirect3DTexture9_QueryInterface({} as any, mem, [texturePtr, IID, ppv] as any)).toBe(D3D_OK);
        expect(Mem.readUint32(ppv)).toBe(texturePtr);
        expect(getComRefCount(texturePtr)).toBe(2);

        // The creator's reference must survive the QI'd pointer being released.
        expect(state.IDirect3DTexture9_Release({} as any, mem, [texturePtr] as any)).toBe(1);
        expect(getComRefCount(texturePtr)).toBe(1);
    });

    test("QI on a texture subresource surface counts on the parent texture", () => {
        const state = createStateExports();
        const texturePtr = createComObject(0x2222);
        const surfacePtr = createComObject(0x3333);
        surfaceMeta.set(surfacePtr, {
            format: 21, type: 1, usage: 0, pool: 0,
            multiSampleType: 0, multiSampleQuality: 0,
            width: 4, height: 4, texturePtr, level: 0,
        });

        expect(state.IDirect3DSurface9_QueryInterface({} as any, mem, [surfacePtr, IID, ppv] as any)).toBe(D3D_OK);
        expect(getComRefCount(texturePtr)).toBe(2);
        expect(state.IDirect3DSurface9_Release({} as any, mem, [surfacePtr] as any)).toBe(1);
        expect(getComRefCount(texturePtr)).toBe(1);
    });

    test("Surface9 QI accepts its own and inherited Resource9 IIDs in guest byte order", () => {
        const state = createStateExports();
        const surfacePtr = createComObject(0x3333);
        const surfaceIid = 0x3080;
        const resourceIid = 0x30a0;
        // REFIID bytes are the in-memory Windows layout: the first three GUID
        // fields are little-endian, while the final eight bytes are unchanged.
        mem.set([0x3a, 0xaf, 0xfb, 0x0c, 0xf6, 0x9f, 0x9a, 0x42,
            0x99, 0xb3, 0xa2, 0x79, 0x6a, 0xf8, 0xb8, 0x9b], surfaceIid);
        mem.set([0x5d, 0xc0, 0xee, 0x05, 0x7d, 0x8f, 0x62, 0x43,
            0xb9, 0x99, 0xd1, 0xba, 0xf3, 0x57, 0xc7, 0x04], resourceIid);
        expect(readD3D9GuidKey(mem, surfaceIid)).toBe(IID_IDIRECT3DSURFACE9);
        expect(readD3D9GuidKey(mem, resourceIid)).toBe(IID_IDIRECT3DRESOURCE9);
        expect(state.IDirect3DSurface9_QueryInterface({} as any, mem, [surfacePtr, surfaceIid, ppv] as any))
            .toBe(D3D_OK);
        expect(Mem.readUint32(ppv)).toBe(surfacePtr);
        expect(state.IDirect3DSurface9_Release({} as any, mem, [surfacePtr] as any)).toBe(1);
        expect(state.IDirect3DSurface9_QueryInterface({} as any, mem, [surfacePtr, resourceIid, ppv] as any))
            .toBe(D3D_OK);
        expect(Mem.readUint32(ppv)).toBe(surfacePtr);
        expect(state.IDirect3DSurface9_Release({} as any, mem, [surfacePtr] as any)).toBe(1);
    });

    test("QI rejects an unrelated IID and clears the out pointer", () => {
        const state = createStateExports();
        const texturePtr = createComObject(0x2222);
        const unrelated = 0x3040;
        mem.fill(0xab, unrelated, unrelated + 16);
        Mem.writeUint32(ppv, 0xdeadbeef);
        expect(state.IDirect3DTexture9_QueryInterface({} as any, mem, [texturePtr, unrelated, ppv] as any))
            .toBe(0x80004002);
        expect(Mem.readUint32(ppv)).toBe(0);
        expect(getComRefCount(texturePtr)).toBe(1);
    });

    test("QI rejects a stale object pointer even for a valid IID", () => {
        const state = createStateExports();
        Mem.writeUint32(ppv, 0xdeadbeef);
        expect(state.IDirect3DTexture9_QueryInterface({} as any, mem, [0xdead, IID, ppv] as any))
            .toBe(0x80004002);
        expect(Mem.readUint32(ppv)).toBe(0);
    });
});

describe("device lifetime under child resources", () => {
    test("a created child outlives the app's device reference", () => {
        const devicePtr = createComObject(0x1111);
        const childPtr = createComObject(0x2222);
        let deviceDestroyed = false;
        registerComFinalizer(devicePtr, () => { deviceDestroyed = true; });
        registerDeviceChildFinalizer(childPtr, devicePtr, () => {});

        expect(getComRefCount(devicePtr)).toBe(2);
        expect(releaseComRef(devicePtr)).toBe(1);
        expect(deviceDestroyed).toBe(false);

        releaseComRef(childPtr);
        expect(deviceDestroyed).toBe(true);
    });

    test("a module reset runs the outstanding finalizers instead of dropping them", () => {
        const devicePtr = createComObject(0x1111);
        const childPtr = createComObject(0x2222);
        const ran: string[] = [];
        registerComFinalizer(devicePtr, () => ran.push("device"));
        registerDeviceChildFinalizer(childPtr, devicePtr, () => ran.push("child"));
        addComRef(childPtr); // an extra guest reference must not strand the GPU resources

        resetD3D9SharedState();
        expect(ran.sort()).toEqual(["child", "device"]);
        expect(getComRefCount(childPtr)).toBeUndefined();
    });
});

describe("D3D9 user clip-plane bounds", () => {
    test("rejects indices outside the six-plane contract", () => {
        const devicePtr = createComObject(0x4444);
        devices.set(devicePtr, {
            setClipPlane: () => D3D_OK,
            getClipPlane: () => new Float32Array([1, 0, 0, 0]),
        } as any);
        const state = createStateExports();
        const plane = 0x3600;
        const out = 0x3700;
        for (let i = 0; i < 4; i++) Mem.writeFloat32(plane + i * 4, i === 0 ? 1 : 0);
        expect(state.IDirect3DDevice9_SetClipPlane({} as any, mem, [devicePtr, 6, plane] as any))
            .toBe(D3DERR_INVALIDCALL);
        expect(state.IDirect3DDevice9_GetClipPlane({} as any, mem, [devicePtr, -1, out] as any))
            .toBe(D3DERR_INVALIDCALL);
        Mem.writeFloat32(plane + 8, Number.NaN);
        expect(state.IDirect3DDevice9_SetClipPlane({} as any, mem, [devicePtr, 0, plane] as any))
            .toBe(D3DERR_INVALIDCALL);
    });
});

describe("IDirect3D9 reference counting", () => {
    test("AddRef on an unknown pointer reports 0 rather than a fabricated reference", () => {
        const factory = createFactoryExports();
        expect(factory.IDirect3D9_AddRef!({} as any, mem, [0xdeadbe] as any)).toBe(0);

        const d3d9Ptr = createComObject(0x5555);
        expect(factory.IDirect3D9_AddRef!({} as any, mem, [d3d9Ptr] as any)).toBe(2);
        expect(factory.IDirect3D9_Release!({} as any, mem, [d3d9Ptr] as any)).toBe(1);
        expect(factory.IDirect3D9_Release!({} as any, mem, [d3d9Ptr] as any)).toBe(0);
        // The released pointer must not resurrect itself as a live object.
        expect(factory.IDirect3D9_AddRef!({} as any, mem, [d3d9Ptr] as any)).toBe(0);
    });
});
