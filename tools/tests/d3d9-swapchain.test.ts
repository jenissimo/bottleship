import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    createComObject,
    devices,
    releaseComRef,
    resetD3D9SharedState,
} from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { generateModuleVTables } from "../../src/worker/api/codegen";
import {
    d3d9Module,
    IDirect3DSwapChain9,
} from "../../src/worker/api/d3d9.api";
import {
    D3D9PresentationState,
    D3DERR_DEVICELOST,
    D3DERR_INVALIDCALL,
    D3DSWAPEFFECT_FLIP,
    defaultPresentationParameters9,
    normalizePresentationParameters9,
    parseDirtyRegion9,
    parsePresentationParameters9,
    writePresentationParameters9,
} from "../../src/worker/backends/webgpu/d3d9/presentation";
import {
    createSwapChainExports,
    getDeviceSwapChain,
    getSwapChainRecord,
    registerImplicitSwapChain,
    resetSwapChainRegistry,
    validateAdditionalSwapChainParameters,
} from "../../src/worker/modules/d3d9/swapchain";

const D3DERR_NOTAVAILABLE = 0x8876086a;
const E_NOINTERFACE = 0x80004002;

describe("D3D9 swap-chain surface", () => {
    test("descriptor follows the SDK vtable order and arities", () => {
        expect(IDirect3DSwapChain9.methods.map((method) => method.name)).toEqual([
            "QueryInterface", "AddRef", "Release", "Present", "GetFrontBufferData",
            "GetBackBuffer", "GetRasterStatus", "GetDisplayMode", "GetDevice",
            "GetPresentParameters",
        ]);
        expect(IDirect3DSwapChain9.methods.map((method) => method.params.length)).toEqual([
            3, 1, 1, 6, 2, 4, 2, 2, 2, 2,
        ]);
        const table = generateModuleVTables(d3d9Module).find((item) => item.name === "IDirect3DSwapChain9");
        expect(table?.methods.length).toBe(10);
        expect(table?.methods[3]?.argCount).toBe(6);
    });

    test("presentation parameters round-trip the 56-byte ABI", () => {
        const memory = new Uint8Array(256);
        const source = normalizePresentationParameters9({
            ...defaultPresentationParameters9(),
            backBufferWidth: 1280,
            backBufferHeight: 720,
            backBufferCount: 0,
            swapEffect: D3DSWAPEFFECT_FLIP,
            windowed: false,
            presentationInterval: 2,
        });
        expect(writePresentationParameters9(memory, 32, source)).toBe(true);
        expect(parsePresentationParameters9(memory, 32)).toEqual(source);
        expect(source.backBufferCount).toBe(1);
        expect(source.windowed).toBe(false);
    });

    test("present records rectangles and rejects malformed rectangles", () => {
        const state = new D3D9PresentationState();
        // Present rectangles are defined only for a COPY chain (see presentation.ts).
        state.createChain(0, { ...defaultPresentationParameters9(), swapEffect: 3 });
        expect(state.present(0, {
            sourceRect: { left: 0, top: 0, right: 320, bottom: 200 },
            destRect: { left: 5, top: 6, right: 325, bottom: 206 },
            destWindow: 0x1234,
            dirtyRegion: 0x5678,
            flags: 0,
        }, 1000)).toBe(0);
        expect(state.getChain(0)?.presents).toBe(1);
        expect(state.getChain(0)?.lastPresent?.sourceRect?.right).toBe(320);
        expect(state.present(0, {
            sourceRect: { left: 5, top: 5, right: 5, bottom: 6 },
            destRect: null,
            destWindow: 0,
            dirtyRegion: 0,
            flags: 0,
        })).toBe(D3DERR_INVALIDCALL);
    });

    test("decodes RGNDATA dirty rectangles and rejects malformed blocks", () => {
        const memory = new Uint8Array(256);
        const view = new DataView(memory.buffer);
        const ptr = 32;
        view.setUint32(ptr + 0, 32, true); // cb
        view.setUint32(ptr + 4, 1, true); // RDH_RECTANGLES
        view.setUint32(ptr + 8, 2, true); // nCount
        view.setUint32(ptr + 12, 32, true); // nRgnSize
        view.setInt32(ptr + 16, 0, true);
        view.setInt32(ptr + 20, 0, true);
        view.setInt32(ptr + 24, 80, true);
        view.setInt32(ptr + 28, 60, true);
        view.setInt32(ptr + 32, 4, true);
        view.setInt32(ptr + 36, 5, true);
        view.setInt32(ptr + 40, 20, true);
        view.setInt32(ptr + 44, 25, true);
        view.setInt32(ptr + 48, 30, true);
        view.setInt32(ptr + 52, 10, true);
        view.setInt32(ptr + 56, 70, true);
        view.setInt32(ptr + 60, 50, true);
        expect(parseDirtyRegion9(memory, ptr)).toEqual([
            { left: 4, top: 5, right: 20, bottom: 25 },
            { left: 30, top: 10, right: 70, bottom: 50 },
        ]);
        view.setUint32(ptr + 4, 0, true);
        expect(parseDirtyRegion9(memory, ptr)).toBeUndefined();
        expect(parseDirtyRegion9(memory, 240)).toBeUndefined();
    });

    test("honours an extended RGNDATA header before the RECT payload", () => {
        const memory = new Uint8Array(256);
        const view = new DataView(memory.buffer);
        const ptr = 16;
        view.setUint32(ptr + 0, 48, true); // cbHeader
        view.setUint32(ptr + 4, 1, true); // RDH_RECTANGLES
        view.setUint32(ptr + 8, 1, true);
        view.setUint32(ptr + 12, 16, true);
        view.setInt32(ptr + 48, 7, true);
        view.setInt32(ptr + 52, 8, true);
        view.setInt32(ptr + 56, 17, true);
        view.setInt32(ptr + 60, 18, true);
        expect(parseDirtyRegion9(memory, ptr)).toEqual([
            { left: 7, top: 8, right: 17, bottom: 18 },
        ]);
    });

    test("loss and reset transition are observable and reset generation", () => {
        const state = new D3D9PresentationState();
        state.createChain(0, defaultPresentationParameters9());
        state.createChain(1, defaultPresentationParameters9());
        state.markLost();
        expect(state.testCooperativeLevel()).toBe(D3DERR_DEVICELOST);
        expect(state.present(1, {
            sourceRect: null, destRect: null, destWindow: 0, dirtyRegion: 0, flags: 0,
        })).toBe(D3DERR_DEVICELOST);
        expect(state.reset({ ...defaultPresentationParameters9(), backBufferWidth: 1024 })).toBe(0);
        expect(state.testCooperativeLevel()).toBe(0);
        expect(state.getChain(1)?.params.backBufferWidth).toBe(1024);
        expect(state.getChain(1)?.generation).toBe(2);
    });

    test("resetChain changes only the redeclared chain", () => {
        const state = new D3D9PresentationState();
        state.createChain(0, defaultPresentationParameters9());
        state.createChain(1, { ...defaultPresentationParameters9(), backBufferWidth: 320 });
        state.markLost();
        expect(state.resetChain(0, { ...defaultPresentationParameters9(), backBufferWidth: 1280 })).toBe(0);
        expect(state.getChain(0)?.params.backBufferWidth).toBe(1280);
        expect(state.getChain(0)?.lost).toBe(false);
        expect(state.getChain(1)?.params.backBufferWidth).toBe(320);
        expect(state.getChain(1)?.lost).toBe(true);
    });

    test("additional swap chains reject unsupported multisample quality indices", () => {
        expect(validateAdditionalSwapChainParameters({
            ...defaultPresentationParameters9(),
            windowed: true,
            multiSampleQuality: 1,
        })).toBe(D3DERR_NOTAVAILABLE);
    });
});

describe("D3D9 swap-chain COM handlers", () => {
    const DEVICE_PARAMS = 0x800;
    const OUT = 0x900;
    let mem: Uint8Array;
    let originalProcess: unknown;
    let exports: Record<string, any>;
    let devicePtr: number;
    /** Guest addresses the region map refuses to hand out for writing. */
    let readOnlyBase: number;

    const fakeDevice = {
        isExtended: false,
        supportsD3D9MultisampleType: (type: number) => type === 0,
        resetSubsystemPerf: () => {},
    } as any;

    beforeEach(() => {
        const system = System.getInstance() as any;
        originalProcess = system.process;
        mem = new Uint8Array(0x200000);
        readOnlyBase = 0xa00;
        let next = 0x1f0000;
        const thunkGenerator = new ThunkGenerator();
        thunkGenerator.setBaseAddress(0x10000);
        system.process = {
            memory: {
                alloc: (size: number) => { const ptr = next; next += Math.max(4, size); return ptr; },
                allocAt: () => undefined,
                allocSystemBlock: (size: number) => { const ptr = next; next += Math.max(16, size); return ptr; },
                free: () => undefined,
                freeSystemBlock: () => {},
            },
            dispatcher: {
                registerModule: () => undefined,
                applyPendingRegistrations: () => undefined,
            },
            thunkGenerator,
            // A bounds test is not validation: this stands in for the region map that
            // knows [readOnlyBase, +0x100) is code / read-only.
            addressSpace: {
                validateRange: (address: number, size: number, perms: string) => {
                    if (address < 0 || address + size > mem.length) return false;
                    if (perms.includes("w") && address >= readOnlyBase && address < readOnlyBase + 0x100) return false;
                    return true;
                },
            },
            getCurrentMemory: () => mem,
        };
        Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
        resetD3D9SharedState();
        resetSwapChainRegistry();
        exports = createSwapChainExports();
        devicePtr = createComObject(0x1111);
        devices.set(devicePtr, fakeDevice);
        writePresentationParameters9(mem, DEVICE_PARAMS, normalizePresentationParameters9({
            ...defaultPresentationParameters9(),
            windowed: true,
        }));
    });

    afterEach(() => {
        resetSwapChainRegistry();
        resetD3D9SharedState();
        System.getInstance().process = originalProcess as any;
    });

    test("GetBackBuffer refuses an out pointer the region map will not let it write", () => {
        const chainPtr = registerImplicitSwapChain(devicePtr, mem, DEVICE_PARAMS);
        expect(chainPtr).not.toBe(0);

        expect(exports.IDirect3DSwapChain9_GetBackBuffer({}, mem, [chainPtr, 0, 0, readOnlyBase]))
            .toBe(D3DERR_INVALIDCALL);
        expect(new DataView(mem.buffer).getUint32(readOnlyBase, true)).toBe(0);

        expect(exports.IDirect3DSwapChain9_GetBackBuffer({}, mem, [chainPtr, 0, 0, OUT])).toBe(0);
        expect(new DataView(mem.buffer).getUint32(OUT, true)).not.toBe(0);
    });

    test("GetRasterStatus and GetDisplayMode validate their whole out struct", () => {
        const chainPtr = registerImplicitSwapChain(devicePtr, mem, DEVICE_PARAMS);
        expect(exports.IDirect3DSwapChain9_GetRasterStatus({}, mem, [chainPtr, readOnlyBase]))
            .toBe(D3DERR_INVALIDCALL);
        expect(exports.IDirect3DSwapChain9_GetDisplayMode({}, mem, [chainPtr, readOnlyBase]))
            .toBe(D3DERR_INVALIDCALL);
        expect(new DataView(mem.buffer).getUint32(readOnlyBase, true)).toBe(0);
        expect(exports.IDirect3DSwapChain9_GetDisplayMode({}, mem, [chainPtr, OUT])).toBe(0);
        expect(new DataView(mem.buffer).getUint32(OUT, true)).toBeGreaterThan(0);
    });

    test("QueryInterface NULLs the out pointer and refuses a released chain", () => {
        const chainPtr = registerImplicitSwapChain(devicePtr, mem, DEVICE_PARAMS);
        const iid = 0xb00;
        // IID_IUnknown in guest GUID byte order.
        mem.set([0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], iid);
        const view = new DataView(mem.buffer);

        expect(exports.IDirect3DSwapChain9_QueryInterface({}, mem, [chainPtr, iid, OUT])).toBe(0);
        expect(view.getUint32(OUT, true)).toBe(chainPtr);
        expect(releaseComRef(chainPtr)).toBe(1);

        // An unsupported IID must not leave the previous pointer in the out slot.
        const bogusIid = 0xb40;
        mem.set(new Uint8Array(16).fill(0x5a), bogusIid);
        expect(exports.IDirect3DSwapChain9_QueryInterface({}, mem, [chainPtr, bogusIid, OUT]))
            .toBe(E_NOINTERFACE);
        expect(view.getUint32(OUT, true)).toBe(0);

        // A released chain is not an object: E_NOINTERFACE, never E_POINTER.
        view.setUint32(OUT, 0xdeadbeef, true);
        const stale = chainPtr;
        resetD3D9SharedState();
        resetSwapChainRegistry();
        expect(exports.IDirect3DSwapChain9_QueryInterface({}, mem, [stale, iid, OUT])).toBe(E_NOINTERFACE);
        expect(view.getUint32(OUT, true)).toBe(0);
    });

    test("AddRef on an unknown pointer reports 0 instead of fabricating a reference", () => {
        expect(exports.IDirect3DSwapChain9_AddRef({}, mem, [0x123456])).toBe(0);
    });

    test("an additional swap chain never claims the implicit index 0", () => {
        // The device has no implicit chain registered yet — the additional chain must
        // still start at index 1 so its back buffers stay app-owned.
        expect(exports.IDirect3DDevice9_CreateAdditionalSwapChain({}, mem, [devicePtr, DEVICE_PARAMS, OUT]))
            .toBe(0);
        const additional = new DataView(mem.buffer).getUint32(OUT, true);
        expect(additional).not.toBe(0);
        expect(getSwapChainRecord(additional)?.index).toBe(1);
        expect(getDeviceSwapChain(devicePtr, 0)).toBe(null);

        const backBuffer = getSwapChainRecord(additional)!.backBuffers[0]!;
        expect(surfaceMeta.get(backBuffer)?.implicitBackBuffer).toBeFalsy();

        // The implicit chain still gets index 0 when the device declares it.
        const implicit = registerImplicitSwapChain(devicePtr, mem, DEVICE_PARAMS);
        expect(implicit).not.toBe(additional);
        expect(getDeviceSwapChain(devicePtr, 0)?.ptr).toBe(implicit);
    });
});
