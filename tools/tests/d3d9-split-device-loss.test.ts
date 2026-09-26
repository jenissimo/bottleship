/**
 * Split D3D9, render-worker arm: the worker's GPUDevice is lost independently of this worker's.
 *
 * A split front's resources live on the render worker's device, so its loss contract
 * (TestCooperativeLevel / Reset / Present / ValidateDevice) must follow THAT device — mirrored
 * here by RemoteGpuLifecycle — and not this worker's gpuDeviceLifecycle, which GDI and DirectDraw
 * share and which only composites the front's frames.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RemoteGpuLifecycle } from "../../src/worker/render/d3d9-remote-state";
import {
    acknowledgeDeviceReset, deviceCooperativeLevel, forgetLossTrackedDevice, registerLossTrackedDevice,
} from "../../src/worker/core/gpu/gpu-device-loss-contract";
import { gpuDeviceLifecycle } from "../../src/worker/core/gpu/gpu-device-lifecycle";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

const FRONT = 0x5000;
const LOCAL = 0x6000;
const D3DERR_DEVICELOST = 0x88760868;

afterEach(() => {
    forgetLossTrackedDevice(FRONT);
    forgetLossTrackedDevice(LOCAL);
    if (!gpuDeviceLifecycle.isUsable()) gpuDeviceLifecycle.notifyRecreated({} as GPUDevice);
});

describe("split D3D9 device loss follows the render worker's device", () => {
    test("lost -> notreset -> Reset -> ok, driven only by the worker's lifecycle", () => {
        const remote = new RemoteGpuLifecycle();
        registerLossTrackedDevice(FRONT, remote);
        registerLossTrackedDevice(LOCAL);
        expect(deviceCooperativeLevel(FRONT)).toBe("ok");

        remote.apply("lost", 0);
        expect(deviceCooperativeLevel(FRONT)).toBe("lost");
        expect(deviceCooperativeLevel(LOCAL)).toBe("ok");
        expect(acknowledgeDeviceReset(FRONT)).toBe(false);

        remote.apply("ok", 1);
        expect(deviceCooperativeLevel(FRONT)).toBe("notreset");
        expect(acknowledgeDeviceReset(FRONT)).toBe(true);
        expect(deviceCooperativeLevel(FRONT)).toBe("ok");
        expect(remote.losses).toBe(1);
        expect(remote.recreations).toBe(1);
    });

    test("this worker's own device loss is not the split front's", () => {
        const remote = new RemoteGpuLifecycle();
        registerLossTrackedDevice(FRONT, remote);
        registerLossTrackedDevice(LOCAL);
        gpuDeviceLifecycle.notifyLost("test", "emulator-worker device lost");
        expect(deviceCooperativeLevel(LOCAL)).toBe("lost");
        expect(deviceCooperativeLevel(FRONT)).toBe("ok");
    });

    test("a generation that moved between two usable snapshots is a loss and a recreation", () => {
        const remote = new RemoteGpuLifecycle();
        const phases: string[] = [];
        remote.subscribe({ onDeviceLost: () => phases.push("lost"), onDeviceRecreated: () => phases.push("recreated") });
        registerLossTrackedDevice(FRONT, remote);
        remote.apply("ok", 3);
        expect(phases).toEqual(["lost", "recreated"]);
        expect(deviceCooperativeLevel(FRONT)).toBe("notreset");
        remote.apply("unavailable", 3);
        expect(phases).toEqual(["lost", "recreated", "lost"]);
        expect(deviceCooperativeLevel(FRONT)).toBe("lost");
    });

    test("the front's Present / ValidateDevice answer DEVICELOST from the worker's device, and it drops its resources", async () => {
        const remote = new RemoteGpuLifecycle();
        const front: any = Object.create(D3D9Device.prototype);
        front.backend = { getDevice: () => ({}) }; // this worker's device stays alive throughout
        front.unregisterGpuObserver = null;
        let dropped = 0;
        front.onDeviceLost = () => { dropped++; };
        front.adoptSplitLossSource(remote);
        expect(front.getSplitLossSource()).toBe(remote);
        expect(front.validateDevice().hr).toBe(0);

        remote.apply("lost", 0);
        expect(dropped).toBe(1);
        expect(front.validateDevice().hr).toBe(D3DERR_DEVICELOST);
        expect(await front.present()).toBe(D3DERR_DEVICELOST);

        remote.apply("ok", 1);
        expect(front.validateDevice().hr).toBe(0);
    });
});
