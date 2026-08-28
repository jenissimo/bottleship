import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createExExports } from "../../src/worker/modules/d3d9/ex";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta, textureMeta, vertexBufferMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { createSwapChainExports } from "../../src/worker/modules/d3d9/swapchain";
import {
    validateAdditionalSwapChainParameters,
    validatePresentExFlags,
} from "../../src/worker/modules/d3d9/swapchain";
import { defaultPresentationParameters9 } from "../../src/worker/backends/webgpu/d3d9/presentation";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const DEVICE = 0x100;
const LATENCY = 0x80;

let memory: Uint8Array;
let view: DataView;

beforeEach(() => {
    memory = new Uint8Array(0x400);
    view = new DataView(memory.buffer);
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    devices.clear();
});

afterEach(() => {
    devices.clear();
    resourceToDevice.clear();
    surfaceMeta.clear();
    textureMeta.clear();
    vertexBufferMeta.clear();
});

describe("D3D9Ex lifecycle contracts", () => {
    test("rejects an unsupported Direct3DCreate9Ex SDK version", () => {
        const ex = createExExports();
        view.setUint32(LATENCY, 0xffffffff, true);
        expect(ex["Direct3DCreate9Ex"]!({} as never, memory, [31, LATENCY]))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(view.getUint32(LATENCY, true)).toBe(0);
    });

    test("uses INVALIDCALL for the unsupported convolution kernel and leaves no out state", () => {
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_SetConvolutionMonoKernel"]!({} as never, memory, [DEVICE, 3, 3, 0x100, 0x120]))
            .toBe(D3DERR_INVALIDCALL);
        // DXVK keeps ComposeRects as a compatibility stub, but returns D3D_OK.
        expect(ex["IDirect3DDevice9Ex_ComposeRects"]!({} as never, memory, [DEVICE, 0x100, 0x120, 0x140, 1, 0x160, 0, 0, 0]))
            .toBe(D3D_OK);
    });

    test("normalizes and bounds Ex frame latency like DXVK", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_SetMaximumFrameLatency"]!({} as never, memory, [DEVICE, 0])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_GetMaximumFrameLatency"]!({} as never, memory, [DEVICE, LATENCY])).toBe(D3D_OK);
        expect(view.getUint32(LATENCY, true)).toBe(3);
        expect(ex["IDirect3DDevice9Ex_SetMaximumFrameLatency"]!({} as never, memory, [DEVICE, 20])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_GetMaximumFrameLatency"]!({} as never, memory, [DEVICE, LATENCY])).toBe(D3D_OK);
        expect(view.getUint32(LATENCY, true)).toBe(20);
        expect(ex["IDirect3DDevice9Ex_SetMaximumFrameLatency"]!({} as never, memory, [DEVICE, 21])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_GetMaximumFrameLatency"]!({} as never, memory, [DEVICE, LATENCY])).toBe(D3D_OK);
        expect(view.getUint32(LATENCY, true)).toBe(20);
        expect(ex["IDirect3DDevice9Ex_SetMaximumFrameLatency"]!({} as never, memory, [DEVICE, 31]))
            .toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(LATENCY, true)).toBe(20);
    });

    test("keeps GPU thread priority as DXVK's zero-valued compatibility stub", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_SetGPUThreadPriority"]!({} as never, memory, [DEVICE, 17]))
            .toBe(D3D_OK);
        view.setUint32(LATENCY, 0xdeadbeef, true);
        expect(ex["IDirect3DDevice9Ex_GetGPUThreadPriority"]!({} as never, memory, [DEVICE, LATENCY]))
            .toBe(D3D_OK);
        expect(view.getUint32(LATENCY, true)).toBe(0);
    });

    test("rejects unsupported PresentEx flags before presentation state can be recorded", () => {
        expect(validatePresentExFlags(0x1f)).toBe(D3D_OK);
        expect(validatePresentExFlags(0x20)).toBe(D3DERR_INVALIDCALL);
    });

    test("keeps additional swap chains windowed and sample-count honest", () => {
        const params = defaultPresentationParameters9();
        expect(validateAdditionalSwapChainParameters(params)).toBe(D3D_OK);
        expect(validateAdditionalSwapChainParameters({ ...params, windowed: false })).toBe(D3DERR_INVALIDCALL);
        expect(validateAdditionalSwapChainParameters({ ...params, multiSampleType: 2 })).toBe(D3DERR_NOTAVAILABLE);
    });

    test("clears an additional-chain out pointer before rejecting a missing parameter block", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        view.setUint32(LATENCY, 0xdeadbeef, true);
        const exports = createSwapChainExports();
        expect(exports["IDirect3DDevice9_CreateAdditionalSwapChain"]!({} as never, memory, [DEVICE, 0, LATENCY]))
            .toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(LATENCY, true)).toBe(0);
    });

    test("keeps CheckResourceResidency as DXVK's compatibility stub", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        view.setUint32(0x100, 0xdeadbeef, true);
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_CheckResourceResidency"]!({} as never, memory,
            [DEVICE, 0x100, 1])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_CheckResourceResidency"]!({} as never, memory,
            [DEVICE, 0, 0])).toBe(D3D_OK);
        // DXVK's implementation is a non-dereferencing compatibility stub,
        // so a null array is still accepted for a nonzero count.
        expect(ex["IDirect3DDevice9Ex_CheckResourceResidency"]!({} as never, memory,
            [DEVICE, 0, 1])).toBe(D3D_OK);
    });

    test("keeps CheckDeviceState as DXVK's compatibility stub", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_CheckDeviceState"]!({} as never, memory,
            [DEVICE])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_CheckDeviceState"]!({} as never, memory,
            [0])).toBe(D3DERR_INVALIDCALL);
    });

    test("Ex TestCooperativeLevel stays OK while a reset is pending", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_TestCooperativeLevel"]!({} as never, memory,
            [DEVICE])).toBe(D3D_OK);
    });

    test("base Reset refuses a live application DEFAULT resource", () => {
        // Order is part of the contract: real D3D9 drops the references the DEVICE holds
        // (bound textures, streams, indices) BEFORE deciding whether an APP-owned DEFAULT
        // resource is still alive — counting first fails every app that resets with its own
        // dynamic buffer still bound. The refusal must survive that teardown, not precede it.
        let bindingsReleased = 0;
        const state = {
            isExtended: false,
            resetSubsystemPerf() {},
            releaseComBindings() { bindingsReleased++; },
        } as any;
        devices.set(DEVICE, state);
        textureMeta.set(0x180, { width: 1, height: 1, levels: 1, usage: 0, pool: 0, format: 21 });
        resourceToDevice.set(0x180, state);

        const d3d9 = createDeviceExports();
        expect(d3d9["IDirect3DDevice9_Reset"]!({} as never, memory,
            [DEVICE, 0])).toBe(D3DERR_INVALIDCALL);
        expect(bindingsReleased).toBe(1);
    });

    test("base Reset does not charge the app for a resource it only left BOUND", () => {
        // The regression this exists for: the device's own reference on the bound stream
        // source kept one D3DPOOL_DEFAULT vertex buffer alive past the app's Release, the
        // precondition counted it, and the refused Reset latched "device lost" forever.
        const state = {
            isExtended: false,
            resetSubsystemPerf() {},
            reset: () => D3D_OK,
            getViewport: () => ({ x: 0, y: 0, width: 1, height: 1, minZ: 0, maxZ: 1 }),
            configureD3D9MultisampleType: () => true,
            supportsD3D9MultisampleType: () => true,
            releaseComBindings() {
                // What the real device does: drop the ref, which drops the last reference and
                // takes the buffer's metadata with it.
                vertexBufferMeta.delete(0x190);
                resourceToDevice.delete(0x190);
            },
        } as any;
        devices.set(DEVICE, state);
        vertexBufferMeta.set(0x190, { size: 64, usage: 0x208, pool: 0, fvf: 0x142 });
        resourceToDevice.set(0x190, state);

        const d3d9 = createDeviceExports();
        expect(d3d9["IDirect3DDevice9_Reset"]!({} as never, memory,
            [DEVICE, 0])).toBe(D3D_OK);
    });

    test("Ex Reset lifts the DEFAULT-resource precondition in its own scope", () => {
        let resetCalls = 0;
        const state = {
            isExtended: true,
            getViewport: () => ({ x: 0, y: 0, width: 1, height: 1, minZ: 0, maxZ: 1 }),
            setRenderTarget: () => D3D_OK,
            setDepthStencilTexture: () => D3D_OK,
            reset: () => { resetCalls++; return D3D_OK; },
            resetSubsystemPerf() {},
        } as any;
        devices.set(DEVICE, state);
        textureMeta.set(0x180, { width: 1, height: 1, levels: 1, usage: 0, pool: 0, format: 21 });
        resourceToDevice.set(0x180, state);
        const pp = 0x200;
        view.setUint32(pp + 0, 1, true);
        view.setUint32(pp + 4, 1, true);
        view.setUint32(pp + 8, 22, true);
        view.setUint32(pp + 24, 1, true);
        view.setUint32(pp + 32, 1, true);

        const ex = createExExports();
        expect(ex["IDirect3DDevice9Ex_Reset"]!({} as never, memory,
            [DEVICE, pp])).toBe(D3D_OK);
        expect(resetCalls).toBe(1);
    });

    test("Ex resource creation rejects the managed pool before forwarding", () => {
        const calls: string[] = [];
        const ex = createExExports({
            IDirect3DDevice9_CreateTexture: () => { calls.push("texture"); return D3D_OK; },
            IDirect3DDevice9_CreateOffscreenPlainSurface: () => { calls.push("surface"); return D3D_OK; },
        });
        expect(ex["IDirect3DDevice9Ex_CreateTexture"]!({} as never, memory,
            [DEVICE, 64, 64, 1, 0, 22, 1, 0x100, 0])).toBe(D3DERR_INVALIDCALL);
        expect(ex["IDirect3DDevice9Ex_CreateTexture"]!({} as never, memory,
            [DEVICE, 64, 64, 1, 0, 22, 0, 0x100, 0])).toBe(D3D_OK);
        expect(ex["IDirect3DDevice9Ex_CreateOffscreenPlainSurfaceEx"]!({} as never, memory,
            [DEVICE, 64, 64, 22, 1, 0x100, 0, 0])).toBe(D3DERR_INVALIDCALL);
        expect(ex["IDirect3DDevice9Ex_CreateOffscreenPlainSurfaceEx"]!({} as never, memory,
            [DEVICE, 64, 64, 22, 0, 0x100, 0, 0])).toBe(D3D_OK);
        expect(calls).toEqual(["texture", "surface"]);
    });

    test("Ex surface creators do not silently discard Usage", () => {
        const calls: string[] = [];
        const ex = createExExports({
            IDirect3DDevice9_CreateRenderTarget: (_ctx, _mem, args) => {
                calls.push(`rt:${args.length}`);
                return D3D_OK;
            },
            IDirect3DDevice9_CreateOffscreenPlainSurface: (_ctx, _mem, args) => {
                calls.push(`offscreen:${args.length}`);
                return D3D_OK;
            },
            IDirect3DDevice9_CreateDepthStencilSurface: (_ctx, _mem, args) => {
                calls.push(`depth:${args.length}`);
                return D3D_OK;
            },
        });
        expect(ex["IDirect3DDevice9Ex_CreateRenderTargetEx"]!({} as never, memory,
            [DEVICE, 64, 64, 21, 0, 0, 0, 0x100, 0, 0x800])).toBe(D3DERR_NOTAVAILABLE);
        expect(ex["IDirect3DDevice9Ex_CreateOffscreenPlainSurfaceEx"]!({} as never, memory,
            [DEVICE, 64, 64, 21, 0, 0x100, 0, 0x800])).toBe(D3DERR_NOTAVAILABLE);
        expect(ex["IDirect3DDevice9Ex_CreateDepthStencilSurfaceEx"]!({} as never, memory,
            [DEVICE, 64, 64, 75, 0, 0, 0, 0x100, 0, 0x800])).toBe(D3DERR_NOTAVAILABLE);
        expect(ex["IDirect3DDevice9Ex_CreateRenderTargetEx"]!({} as never, memory,
            [DEVICE, 64, 64, 21, 0, 0, 0, 0x100, 0, 0])).toBe(D3D_OK);
        expect(calls).toEqual(["rt:9"]);
    });

    test("ResetEx unbinds attachments and preserves the viewport snapshot", () => {
        const state = {
            viewport: { x: 3, y: 4, width: 80, height: 60, minZ: 0.25, maxZ: 0.75 },
            targets: [] as number[],
            depthCleared: false,
            resetCalls: 0,
            getViewport() { return this.viewport; },
            setRenderTarget(index: number) { this.targets.push(index); return D3D_OK; },
            setDepthStencilTexture() { this.depthCleared = true; return D3D_OK; },
            reset() {
                this.resetCalls++;
                this.viewport = { x: 0, y: 0, width: 800, height: 600, minZ: 0, maxZ: 1 };
                return D3D_OK;
            },
            resetSubsystemPerf() {},
        };
        devices.set(DEVICE, state as any);
        const pp = 0x180;
        view.setUint32(pp + 0, 800, true);
        view.setUint32(pp + 4, 600, true);
        view.setUint32(pp + 8, 22, true);
        view.setUint32(pp + 24, 1, true); // D3DSWAPEFFECT_DISCARD
        view.setUint32(pp + 32, 1, true); // windowed: ResetEx mode must be NULL
        const ex = createExExports();

        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory,
            [DEVICE, pp, 0])).toBe(D3D_OK);
        expect(state.targets).toEqual([0, 1, 2, 3]);
        expect(state.depthCleared).toBe(true);
        expect(state.resetCalls).toBe(1);
        expect(state.viewport).toEqual({ x: 3, y: 4, width: 80, height: 60, minZ: 0.25, maxZ: 0.75 });
    });

    test("does not fabricate AddRef for stale Ex pointers", () => {
        const ex = createExExports();
        expect(ex["IDirect3D9Ex_AddRef"]!({} as never, memory, [0xdeadbeef])).toBe(0);
        expect(ex["IDirect3DDevice9Ex_AddRef"]!({} as never, memory, [0xdeadbeef])).toBe(0);
    });

    test("rejects QueryInterface on stale Ex pointers even for a recognized IID", () => {
        const ex = createExExports();
        // IID_IUNKNOWN in the guest's raw byte order.
        memory[0x100 + 15] = 0x46;
        view.setUint32(0x80, 0xdeadbeef, true);
        expect(ex["IDirect3D9Ex_QueryInterface"]!({} as never, memory,
            [0xdeadbeef, 0x100, 0x80])).toBe(0x80004002);
        expect(view.getUint32(0x80, true)).toBe(0);
    });

    test("QueryInterface rejects a NULL IID with E_POINTER and clears the out pointer", () => {
        const ex = createExExports();
        view.setUint32(0x80, 0xdeadbeef, true);
        expect(ex["IDirect3D9Ex_QueryInterface"]!({} as never, memory,
            [0xdeadbeef, 0, 0x80])).toBe(0x80004003);
        expect(view.getUint32(0x80, true)).toBe(0);
    });

    test("rejects gamma calls for an invalid device/chain instead of claiming success", () => {
        const d3d9 = createDeviceExports();
        expect(d3d9["IDirect3DDevice9_SetGammaRamp"]!({} as never, memory,
            [0, 0, 0, 0x40])).toBe(D3DERR_INVALIDCALL);
        expect(d3d9["IDirect3DDevice9_GetGammaRamp"]!({} as never, memory,
            [0, 0, 0x40])).toBe(D3DERR_INVALIDCALL);
    });

    test("rejects additional-chain device queries and clears backbuffer out pointers", () => {
        devices.set(DEVICE, { resetSubsystemPerf() {} } as any);
        const d3d9 = createDeviceExports();
        const swap = createSwapChainExports();
        view.setUint32(LATENCY, 0xdeadbeef, true);

        // DXVK's device-level queries expose the implicit chain only.
        expect(d3d9["IDirect3DDevice9_GetRasterStatus"]!({} as never, memory,
            [DEVICE, 1, LATENCY])).toBe(D3DERR_INVALIDCALL);
        expect(d3d9["IDirect3DDevice9_GetDisplayMode"]!({} as never, memory,
            [DEVICE, 1, LATENCY])).toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(LATENCY, true)).toBe(0xdeadbeef);

        // GetBackBuffer initializes *ppBackBuffer before rejecting a nonzero
        // chain or an out-of-range buffer; it must never fabricate a surface.
        view.setUint32(LATENCY, 0xdeadbeef, true);
        expect(d3d9["IDirect3DDevice9_GetBackBuffer"]!({} as never, memory,
            [DEVICE, 1, 0, 0, LATENCY])).toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(LATENCY, true)).toBe(0);

        view.setUint32(LATENCY, 0xdeadbeef, true);
        expect(swap["IDirect3DDevice9_GetSwapChain"]!({} as never, memory,
            [DEVICE, 1, LATENCY])).toBe(D3DERR_INVALIDCALL);
        expect(view.getUint32(LATENCY, true)).toBe(0);
    });

    test("SetCursorProperties refuses foreign or unreadable bitmap surfaces", () => {
        const d3d9 = createDeviceExports();
        const cursor = 0x180;
        const owner = { getTextureLevelPixels: () => null } as any;
        const foreign = {} as any;
        devices.set(DEVICE, owner);
        surfaceMeta.set(cursor, {
            format: 21, type: 1, usage: 0, pool: 0,
            multiSampleType: 0, multiSampleQuality: 0,
            width: 2, height: 2, texturePtr: 0x190, level: 0,
        });

        resourceToDevice.set(cursor, foreign);
        expect(d3d9["IDirect3DDevice9_SetCursorProperties"]!({} as never, memory,
            [DEVICE, 0, 0, cursor])).toBe(D3DERR_INVALIDCALL);

        resourceToDevice.set(cursor, owner);
        expect(d3d9["IDirect3DDevice9_SetCursorProperties"]!({} as never, memory,
            [DEVICE, 0, 0, cursor])).toBe(D3DERR_NOTAVAILABLE);
    });
});
