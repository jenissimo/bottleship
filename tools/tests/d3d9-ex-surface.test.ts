import { describe, expect, test } from "bun:test";
import { generateModuleVTables } from "../../src/worker/api/codegen";
import {
    d3d9Module,
    IDirect3D9,
    IDirect3D9Ex,
    IDirect3DDevice9,
    IDirect3DDevice9Ex,
    IDirect3DSurface9,
    IDirect3DVolume9,
} from "../../src/worker/api/d3d9.api";
import { createExExports } from "../../src/worker/modules/d3d9/ex";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

describe("D3D9Ex ABI surface", () => {
    // Volume9 derives from IUnknown DIRECTLY; Surface9 derives from IDirect3DResource9 and
    // therefore carries SetPriority/GetPriority/PreLoad/GetType before GetContainer (d3d9.h).
    // The asymmetry is real D3D9, and getting it wrong shifts every later slot silently.
    test("Surface9 and Volume9 keep their SDK vtable order", () => {
        expect(IDirect3DSurface9.methods.map((m) => m.name)).toEqual([
            "QueryInterface", "AddRef", "Release", "GetDevice",
            "SetPrivateData", "GetPrivateData", "FreePrivateData",
            "SetPriority", "GetPriority", "PreLoad", "GetType",
            "GetContainer", "GetDesc", "LockRect", "UnlockRect", "GetDC", "ReleaseDC",
        ]);
        expect(IDirect3DVolume9.methods.map((m) => m.name)).toEqual([
            "QueryInterface", "AddRef", "Release", "GetDevice",
            "SetPrivateData", "GetPrivateData", "FreePrivateData", "GetContainer",
            "GetDesc", "LockBox", "UnlockBox",
        ]);
    });

    test("exports Direct3DCreate9Ex with the two-argument stdcall ABI", () => {
        const create = d3d9Module.functions.find((f) => f.name === "Direct3DCreate9Ex");
        expect(create?.callingConvention).toBe("stdcall");
        expect(create?.params.map((p) => p.type)).toEqual(["u32", "ptr"]);
        expect(create?.params[1]?.direction).toBe("out");
    });

    test("IDirect3D9Ex appends exactly the SDK's five methods", () => {
        expect(IDirect3D9Ex.methods.slice(0, IDirect3D9.methods.length).map((m) => m.name))
            .toEqual(IDirect3D9.methods.map((m) => m.name));
        expect(IDirect3D9Ex.methods.slice(IDirect3D9.methods.length).map((m) => m.name))
            .toEqual([
                "GetAdapterModeCountEx",
                "EnumAdapterModesEx",
                "GetAdapterDisplayModeEx",
                "CreateDeviceEx",
                "GetAdapterLUID",
            ]);
        expect(IDirect3D9Ex.methods.map((m) => m.params.length)).toEqual(
            [...IDirect3D9.methods, ...IDirect3D9Ex.methods.slice(IDirect3D9.methods.length)]
                .map((m) => m.params.length),
        );
    });

    test("IDirect3DDevice9Ex preserves the full base vtable prefix", () => {
        expect(IDirect3DDevice9Ex.methods.slice(0, IDirect3DDevice9.methods.length).map((m) => m.name))
            .toEqual(IDirect3DDevice9.methods.map((m) => m.name));
        expect(IDirect3DDevice9Ex.methods.slice(IDirect3DDevice9.methods.length).map((m) => m.name))
            .toEqual([
                "SetConvolutionMonoKernel",
                "ComposeRects",
                "PresentEx",
                "GetGPUThreadPriority",
                "SetGPUThreadPriority",
                "WaitForVBlank",
                "CheckResourceResidency",
                "SetMaximumFrameLatency",
                "GetMaximumFrameLatency",
                "CheckDeviceState",
                "CreateRenderTargetEx",
                "CreateOffscreenPlainSurfaceEx",
                "CreateDepthStencilSurfaceEx",
                "ResetEx",
                "GetDisplayModeEx",
            ]);
        const tables = generateModuleVTables(d3d9Module);
        const d3d9Ex = tables.find((t) => t.name === "IDirect3D9Ex");
        const deviceEx = tables.find((t) => t.name === "IDirect3DDevice9Ex");
        expect(d3d9Ex?.methods.length).toBe(IDirect3D9Ex.methods.length);
        expect(deviceEx?.methods.length).toBe(IDirect3DDevice9Ex.methods.length);
        expect(deviceEx?.methods.at(-1)?.argCount).toBe(4);
    });

    test("Ex forwarding handlers bind to the assembled base export table", () => {
        const calls: number[][] = [];
        const ex = createExExports({
            IDirect3DDevice9_Present: (_ctx, _mem, args) => {
                calls.push(args);
                return 0x1234;
            },
        });
        const result = ex["IDirect3DDevice9Ex_PresentEx"](
            {} as never,
            new Uint8Array(),
            [1, 2, 3, 4, 5, 6],
        );
        expect(result).toBe(0x1234);
        expect(calls).toEqual([[1, 2, 3, 4, 5]]);
    });

    test("Ex mode enumeration rejects missing/invalid filters instead of defaulting the format", () => {
        const memory = new Uint8Array(0x200);
        const view = new DataView(memory.buffer);
        Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
        const filter = 0x80;
        view.setUint32(filter + 0, 12, true);
        view.setUint32(filter + 4, 22, true);
        view.setUint32(filter + 8, 1, true); // progressive
        expect(Mem.readUint32(filter + 4)).toBe(22);
        let countCalls = 0;
        let enumCalls = 0;
        const ex = createExExports({
            IDirect3D9_GetAdapterModeCount: (_ctx, _mem, args) => {
                countCalls++;
                expect(args).toEqual([1, 0, 22]);
                return 7;
            },
            IDirect3D9_EnumAdapterModes: (_ctx, _mem, args) => {
                enumCalls++;
                expect(args).toEqual([1, 0, 22, 3, 0x140]);
                return 0;
            },
        });

        expect(ex["IDirect3D9Ex_GetAdapterModeCountEx"]!({} as never, memory, [1, 0, 0])).toBe(0);
        expect(countCalls).toBe(0);
        expect(ex["IDirect3D9Ex_GetAdapterModeCountEx"]!({} as never, memory, [1, 0, 0x1fc])).toBe(0);
        expect(countCalls).toBe(0);
        expect(ex["IDirect3D9Ex_GetAdapterModeCountEx"]!({} as never, memory, [1, 0, filter])).toBe(7);
        expect(countCalls).toBe(1);

        expect(ex["IDirect3D9Ex_EnumAdapterModesEx"]!({} as never, memory, [1, 0, 0, 3, 0x140])).toBe(0x8876086c);
        expect(ex["IDirect3D9Ex_EnumAdapterModesEx"]!({} as never, memory, [1, 0, filter, 3, 0])).toBe(0x8876086c);
        expect(enumCalls).toBe(0);
        expect(ex["IDirect3D9Ex_EnumAdapterModesEx"]!({} as never, memory, [1, 0, filter, 3, 0x140])).toBe(0);
        expect(enumCalls).toBe(1);

        view.setUint32(filter + 8, 2, true); // interlaced: empty/invalid, no base call
        expect(ex["IDirect3D9Ex_GetAdapterModeCountEx"]!({} as never, memory, [1, 0, filter])).toBe(0);
        expect(ex["IDirect3D9Ex_EnumAdapterModesEx"]!({} as never, memory, [1, 0, filter, 3, 0x140])).toBe(0x8876086c);
        expect(countCalls).toBe(1);
        expect(enumCalls).toBe(1);
    });

    test("ResetEx validates the optional fullscreen mode before forwarding", () => {
        const memory = new Uint8Array(0x400);
        const view = new DataView(memory.buffer);
        Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
        const pp = 0x80;
        const mode = 0x180;
        view.setUint32(mode + 0, 24, true); // sizeof(D3DDISPLAYMODEEX)
        view.setUint32(mode + 4, 800, true);
        view.setUint32(mode + 8, 600, true);
        view.setUint32(mode + 16, 22, true); // D3DFMT_X8R8G8B8
        view.setUint32(mode + 20, 1, true); // progressive

        const calls: number[][] = [];
        const ex = createExExports({
            IDirect3DDevice9_Reset: (_ctx, _mem, args) => {
                calls.push(args);
                return 0;
            },
        });
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, mode])).toBe(0);
        expect(calls).toEqual([[7, pp]]);

        view.setUint32(mode + 0, 0, true); // malformed descriptor must not reach Reset
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, mode])).toBe(0x8876086c);
        expect(calls).toEqual([[7, pp]]);
    });

    test("ResetEx enforces windowed/fullscreen mode pointer and dimensions", () => {
        const memory = new Uint8Array(0x600);
        const view = new DataView(memory.buffer);
        Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
        const pp = 0x80;
        const mode = 0x180;
        view.setUint32(pp + 0, 800, true);
        view.setUint32(pp + 4, 600, true);
        view.setUint32(pp + 8, 22, true);
        view.setUint32(pp + 32, 0, true); // fullscreen
        view.setUint32(mode + 0, 24, true);
        view.setUint32(mode + 4, 800, true);
        view.setUint32(mode + 8, 600, true);
        view.setUint32(mode + 16, 22, true);
        view.setUint32(mode + 20, 1, true);

        let calls = 0;
        const ex = createExExports({
            IDirect3DDevice9_Reset: () => { calls++; return 0; },
        });
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, mode])).toBe(0);
        expect(calls).toBe(1);

        view.setUint32(pp + 32, 1, true); // windowed requires NULL mode
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, mode])).toBe(0x8876086c);
        expect(calls).toBe(1);
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, 0])).toBe(0);
        expect(calls).toBe(2);

        view.setUint32(pp + 32, 0, true);
        view.setUint32(mode + 4, 1024, true); // mode does not match PP
        expect(ex["IDirect3DDevice9Ex_ResetEx"]!({} as never, memory, [7, pp, mode])).toBe(0x8876086c);
        expect(calls).toBe(2);
    });

    test("Get*DisplayModeEx requires the caller-provided D3DDISPLAYMODEEX size", () => {
        const memory = new Uint8Array(0x300);
        const view = new DataView(memory.buffer);
        Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
        const mode = 0x100;
        let adapterCalls = 0;
        let deviceCalls = 0;
        const ex = createExExports({
            IDirect3D9_GetAdapterDisplayMode: (_ctx, mem, args) => {
                adapterCalls++;
                expect(args[2]).toBe(mode);
                expect(Mem.writeUint32(mode + 0, 800)).toBe(true);
                expect(Mem.writeUint32(mode + 4, 600)).toBe(true);
                expect(Mem.writeUint32(mode + 8, 60)).toBe(true);
                expect(Mem.writeUint32(mode + 12, 22)).toBe(true);
                return 0;
            },
            IDirect3DDevice9_GetDisplayMode: (_ctx, mem, args) => {
                deviceCalls++;
                expect(args[2]).toBe(mode);
                expect(Mem.writeUint32(mode + 0, 1024)).toBe(true);
                expect(Mem.writeUint32(mode + 4, 768)).toBe(true);
                expect(Mem.writeUint32(mode + 8, 75)).toBe(true);
                expect(Mem.writeUint32(mode + 12, 22)).toBe(true);
                return 0;
            },
        });

        // A legacy-sized/zero-initialized buffer must not reach the base call.
        view.setUint32(mode, 0, true);
        expect(ex["IDirect3D9Ex_GetAdapterDisplayModeEx"]!({} as never, memory,
            [1, 0, mode, 0])).toBe(0x8876086c);
        expect(adapterCalls).toBe(0);
        expect(ex["IDirect3DDevice9Ex_GetDisplayModeEx"]!({} as never, memory,
            [1, 0, mode, 0])).toBe(0x8876086c);
        expect(deviceCalls).toBe(0);

        // A correctly sized in/out structure is forwarded and converted in place.
        view.setUint32(mode, 24, true);
        expect(ex["IDirect3D9Ex_GetAdapterDisplayModeEx"]!({} as never, memory,
            [1, 0, mode, 0])).toBe(0);
        expect(view.getUint32(mode + 0, true)).toBe(24);
        expect(view.getUint32(mode + 4, true)).toBe(800);
        expect(adapterCalls).toBe(1);
        expect(ex["IDirect3DDevice9Ex_GetDisplayModeEx"]!({} as never, memory,
            [1, 0, mode, 0])).toBe(0);
        expect(view.getUint32(mode + 0, true)).toBe(24);
        expect(view.getUint32(mode + 4, true)).toBe(1024);
        expect(deviceCalls).toBe(1);
    });
});
