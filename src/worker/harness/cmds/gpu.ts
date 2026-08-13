/**
 * Device-loss driving and observation.
 *
 * A recovery path nobody can trigger is a recovery path nobody has tested, so the loss is
 * available on demand: `gpuLoseDevice()` destroys the live GPUDevice, which resolves
 * `device.lost` through exactly the same handler a real loss takes.
 *
 * `gpuDeviceState()` is the readable half — status, generation, which caches are registered to
 * be invalidated, and the guest-visible verdicts (`testCooperativeLevel`, `ddrawLostSurfaces`)
 * beside them, so "the backend recovered" and "the guest was told it recovered" cannot be
 * confused for one another.
 *
 * The `during` snapshot exists because the honesty question is only answerable for one instant:
 * once recovery finishes, D3D_OK is the correct answer again and a build that reported nothing
 * at all looks identical from the outside.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { gpuDeviceLifecycle } from "../../core/gpu/gpu-device-lifecycle";
import { deviceCooperativeLevel, lostSurfaceCount } from "../../core/gpu/gpu-device-loss-contract";
import { lastSurfaceLossTally } from "../../modules/ddraw/surface-device-loss";
import { devices as d3d9Devices } from "../../modules/d3d9/shared-state";
import { devices as d3d8Devices } from "../../modules/d3d8/shared-state";
import type { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";

function backend(): WebGPUBackend {
    const b = sys().services.render.getBackend() as WebGPUBackend | null;
    if (!b || b.kind !== "webgpu") {
        throw new HarnessError("no WebGPU backend (no render device created yet)", HarnessErrorCode.UNSUPPORTED);
    }
    return b;
}

const HRESULT_NAMES: Record<number, string> = {
    0x00000000: "D3D_OK",
    0x88760868: "D3DERR_DEVICELOST",
    0x88760869: "D3DERR_DEVICENOTRESET",
    0x8876086c: "D3DERR_INVALIDCALL",
};

/**
 * Call the REGISTERED THUNK for TestCooperativeLevel and report the HRESULT the guest would
 * receive. Reading `deviceCooperativeLevel()` here instead would test the contract module and
 * not the answer — a handler hard-wired back to D3D_OK would look identical, which is exactly
 * the class of instrument that reports a plausible number for something other than its label.
 * Both handlers read only `args[0]`, so a synthetic ctx is faithful for this one call.
 */
function askTestCooperativeLevel(api: string, devicePtr: number): { hr: string; contract: string } {
    const contract = deviceCooperativeLevel(devicePtr);
    const process = sys().process;
    const dispatcher = process?.dispatcher as unknown as {
        namesTable?: Record<number, string>;
        dispatchTable?: Array<((ctx: unknown, mem: Uint8Array, args: number[]) => unknown) | null>;
    } | undefined;
    const names = dispatcher?.namesTable;
    const table = dispatcher?.dispatchTable;
    if (!names || !table) return { hr: "unavailable (no dispatch table)", contract };
    for (const key of Object.keys(names)) {
        if (names[key as unknown as number] !== api) continue;
        const impl = table[Number(key)];
        if (!impl) break;
        const hr = impl({ esp: 0 }, process!.getCurrentMemory(), [devicePtr >>> 0]);
        const n = (hr as number) >>> 0;
        return { hr: HRESULT_NAMES[n] ?? "0x" + n.toString(16), contract };
    }
    return { hr: "unavailable (thunk not registered)", contract };
}

function snapshot(): Record<string, unknown> {
    const report = gpuDeviceLifecycle.report();
    // Both APIs, one map: a d3d8 title that reported nothing would otherwise read as "no
    // device to ask", which is exactly the clean negative this verb exists to prevent.
    const coop: Record<string, { hr: string; contract: string }> = {};
    for (const ptr of d3d9Devices.keys()) {
        coop["d3d9:0x" + (ptr >>> 0).toString(16)] =
            askTestCooperativeLevel("d3d9:IDirect3DDevice9_TestCooperativeLevel", ptr);
    }
    for (const ptr of d3d8Devices.keys()) {
        coop["d3d8:0x" + (ptr >>> 0).toString(16)] =
            askTestCooperativeLevel("d3d8:IDirect3DDevice8_TestCooperativeLevel", ptr);
    }
    return {
        ...report,
        /** The HRESULT the guest would get from TestCooperativeLevel right now, per device,
         *  beside the internal verdict it is supposed to be derived from. */
        testCooperativeLevel: coop,
        /** DirectDraw surfaces still reporting DDERR_SURFACELOST. */
        ddrawLostSurfaces: lostSurfaceCount(),
        /** What the last loss did to the ddraw surface set (null before the first loss). */
        lastSurfaceLoss: lastSurfaceLossTally(),
    };
}

export function registerGpuCommands(svc: HarnessService): void {
    /** gpuDeviceState() — status/generation + the answers the guest would get. */
    svc.register("gpuDeviceState", () => snapshot());

    /**
     * gpuLoseDevice() — destroy the live device on purpose and wait for recovery.
     *
     * Returns three snapshots, because the interesting assertions live in different instants:
     * `before` (rendering), `during` (taken from inside the invalidation fan-out, i.e. the one
     * moment TestCooperativeLevel must answer D3DERR_DEVICELOST and IsLost must answer
     * DDERR_SURFACELOST), and `after` (recovered, generation moved). A verb that only reported
     * the ends would pass on a recovery that never actually reported a loss to the guest.
     */
    svc.register("gpuLoseDevice", async () => {
        const b = backend();
        const before = snapshot();
        let during: Record<string, unknown> | null = null;
        const unregister = gpuDeviceLifecycle.register("harness-loss-probe", {
            onDeviceLost: () => { during = snapshot(); },
        });
        try {
            const recovered = await b.forceDeviceLoss();
            return { forced: true, recovered, before, during, after: snapshot() };
        } finally {
            unregister();
        }
    });
}
