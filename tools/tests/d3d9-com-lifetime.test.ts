import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
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

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

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
    const ppv = 0x300;

    test("QI hands out a NEW reference, so QI+Release is balanced", () => {
        const state = createStateExports();
        const texturePtr = createComObject(0x2222);

        expect(state.IDirect3DTexture9_QueryInterface({} as any, mem, [texturePtr, 0, ppv] as any)).toBe(D3D_OK);
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

        expect(state.IDirect3DSurface9_QueryInterface({} as any, mem, [surfacePtr, 0, ppv] as any)).toBe(D3D_OK);
        expect(getComRefCount(texturePtr)).toBe(2);
        expect(state.IDirect3DSurface9_Release({} as any, mem, [surfacePtr] as any)).toBe(1);
        expect(getComRefCount(texturePtr)).toBe(1);
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
