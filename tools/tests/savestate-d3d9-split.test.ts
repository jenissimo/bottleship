import { afterEach, describe, expect, test } from "bun:test";
import { devices, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";
import { resetSwapChainRegistry } from "../../src/worker/modules/d3d9/swapchain";
import { d3d9SplitAudit, d3d9SplitFlush, d3d9SplitStats } from "../../src/worker/modules/d3d9/split";
import { System } from "../../src/worker/core/system";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { scopeRigToFile, bytes, capture, freshWorker, makeRig, restoreInto, snapshotRam, type FakeTexture, type Rig } from "./helpers/d3d9-savestate-rig";
import { buildScene, ok, type Scene } from "./helpers/d3d9-savestate-scene";

scopeRigToFile();

const rigs: Rig[] = [];

afterEach(() => {
    while (rigs.length) rigs.pop()!.off();
    resetD3D9SharedState();
    resetSwapChainRegistry();
});

async function splitRig(): Promise<{ r: Rig; scene: Scene }> {
    const r = await makeRig({ split: true });
    rigs.push(r);
    return { r, scene: await buildScene(r) };
}

const priv = (o: unknown): Record<string, any> => o as Record<string, any>;
const twinOf = (r: Rig) => priv(devices.get(r.devicePtr)!).renderTwin;
const twinRt = (r: Rig, scene: Scene): FakeTexture => {
    d3d9SplitFlush();
    const store = priv(twinOf(r)).textures;
    return store.getGpuTexture(store.getIndex(scene.rtTex));
};

async function viaFreshWorker(r: Rig) {
    const first = await capture(r);
    const ram = snapshotRam(r);
    freshWorker(r, ram);
    await restoreInto(r, first.saved, first.graph);
    return first;
}

describe("a split device", () => {
    test("is saved from the front and loaded into a new pair whose twin replays the load", async () => {
        const { r } = await splitRig();
        const device = devices.get(r.devicePtr)!;
        expect(device.role).toBe("front");
        expect(device.renderTwin).not.toBeNull();
        expect(d3d9SplitAudit([device]).differences).toEqual([]);
        const first = await viaFreshWorker(r);
        const loaded = devices.get(r.devicePtr)!;
        expect(loaded).not.toBe(device);
        expect(loaded.role).toBe("front");
        expect(loaded.renderTwin).not.toBeNull();
        const audit = d3d9SplitAudit([loaded]);
        expect(audit.checked).toBeGreaterThan(20);
        expect(audit.differences).toEqual([]);
        expect(Object.values(d3d9SplitStats()!.encodeErrors)).toEqual([]);
        expect(bytes((await capture(r)).saved)).toBe(bytes(first.saved));
    });

    test("a render target's pixels are read back from the twin and written into the new twin's GPU image", async () => {
        const { r, scene } = await splitRig();
        const before = twinRt(r, scene).data.slice();
        expect(before.some(b => b !== 0)).toBe(true);
        const front = priv(devices.get(r.devicePtr)!).textures;
        expect(front.getGpuTexture(front.getIndex(scene.rtTex))).toBeNull();
        const old = twinRt(r, scene);
        await viaFreshWorker(r);
        old.data.fill(0);
        const now = twinRt(r, scene);
        expect(now).not.toBe(old);
        expect(now.data).toEqual(before);
    });

    test("the back buffer is taken from the twin's live image and seeded into the new twin's target", async () => {
        const { r } = await splitRig();
        const twin = priv(twinOf(r));
        twin.backendExecutor.ensureBackbufferTarget();
        const target = priv(twin.backendExecutor).offscreenTexture as FakeTexture;
        for (let i = 0; i < target.data.length; i += 4) target.data.set([i & 255, (i >> 2) & 255, 9, 255], i);
        const expected = target.data.slice();
        twin.readPresentedRgba = async () => ({
            rgba: new Uint8Array(expected.length), width: target.width, height: target.height,
        });
        const front = devices.get(r.devicePtr)!;
        let frontSeeds = 0;
        priv(priv(front).backendExecutor).seedBackbuffer = () => { frontSeeds++; return true; };
        const first = await capture(r);
        expect((first.saved as any).devices[0].backbuffer).not.toBeNull();
        const ram = snapshotRam(r);
        freshWorker(r, ram);
        await restoreInto(r, first.saved, first.graph);
        d3d9SplitFlush();
        const seeded = priv(priv(twinOf(r)).backendExecutor).offscreenTexture as FakeTexture;
        expect(seeded).not.toBe(target);
        expect(seeded.data).toEqual(expected);
        expect(frontSeeds).toBe(0);
    });

    test("failure to read a live back buffer refuses capture", async () => {
        const { r } = await splitRig();
        const twin = priv(twinOf(r));
        twin.backendExecutor.ensureBackbufferTarget();
        twin.backendExecutor.readPresentedRgba = async () => { throw new Error("live read failed"); };
        await expect(capture(r)).rejects.toThrow(/back buffer.*live read failed/);
    });

    test("a load whose call cannot be recorded for the twin fails by name instead of leaving the twin behind", async () => {
        const { r } = await splitRig();
        const first = await capture(r);
        const ram = snapshotRam(r);
        freshWorker(r, ram);
        const dispatcher = priv(System.getInstance().process).dispatcher;
        const enqueue = dispatcher.enqueuePayloadById;
        let calls = 0;
        dispatcher.enqueuePayloadById = (...a: unknown[]) => (++calls === 40 ? false : enqueue(...a));
        await expect(restoreInto(r, first.saved, first.graph)).rejects.toThrow(/restore call\(s\) could not be recorded for the split renderer/);
        dispatcher.enqueuePayloadById = enqueue;
    });

    test("a readback the twin cannot answer refuses the save by name", async () => {
        const { r } = await splitRig();
        r.gpu.failMap = true;
        let message = "";
        try { await capture(r); } catch (e) { expect(e).toBeInstanceOf(CaptureRefusal); message = (e as Error).message; }
        expect(message).toMatch(/^d3d9: render target texture 0x[0-9a-f]+ of device 0x[0-9a-f]+ could not be read back/);
        r.gpu.failMap = false;
        await capture(r);
    });

    test("the guest keeps drawing after a load: state set after it reaches the twin", async () => {
        const { r } = await splitRig();
        await viaFreshWorker(r);
        await ok(r, "IDirect3DDevice9_SetRenderState", r.devicePtr, 7, 1);
        await ok(r, "IDirect3DDevice9_SetSamplerState", r.devicePtr, 1, 5, 3);
        const audit = d3d9SplitAudit([devices.get(r.devicePtr)!]);
        expect(audit.differences).toEqual([]);
        expect(priv(twinOf(r)).stateTracker.getRenderState(7)).toBe(1);
    });

    test("fifty save and load rounds keep front and twin equal and leave nothing behind", async () => {
        const { r } = await splitRig();
        const live = (): number => r.gpu.liveTextures();
        await viaFreshWorker(r);
        const textures = live();
        for (let i = 0; i < 50; i++) await viaFreshWorker(r);
        expect(live()).toBe(textures);
        expect(d3d9SplitAudit([devices.get(r.devicePtr)!]).differences).toEqual([]);
    });

    test("depth-stencil contents refuse the capture by name, split and unsplit", async () => {
        for (const split of [true, false]) {
            const r = await makeRig({ split, depth: true });
            rigs.push(r);
            await buildScene(r);
            await expect(capture(r)).rejects.toThrow(/d3d9: the contents of depth-stencil surface\(s\) 0x[0-9a-f]+(, 0x[0-9a-f]+)* cannot be restored/);
            r.off();
            rigs.pop();
            resetD3D9SharedState();
            resetSwapChainRegistry();
        }
    });

    test("a standalone depth-stencil surface and a multisampled render target refuse the capture by name", async () => {
        for (const split of [true, false]) {
            const r = await makeRig({ split });
            rigs.push(r);
            await buildScene(r);
            const out = 0x7f00;
            expect(await r.call("IDirect3DDevice9_CreateDepthStencilSurface", r.devicePtr, 32, 32, 75, 0, 0, 0, out, 0)).toBe(0);
            await expect(capture(r)).rejects.toThrow(/depth-stencil surface\(s\) 0x[0-9a-f]+(, 0x[0-9a-f]+)* cannot be restored/);
            expect(await r.call("IDirect3DSurface9_Release", r.u32(out))).toBe(0);
            expect(await r.call("IDirect3DDevice9_CreateRenderTarget", r.devicePtr, 16, 16, 21, 1, 0, 0, out, 0)).toBe(0);
            await expect(capture(r)).rejects.toThrow(/per-sample contents of multisampled target\(s\) 0x[0-9a-f]+(, 0x[0-9a-f]+)* cannot be restored/);
            expect(await r.call("IDirect3DSurface9_Release", r.u32(out))).toBe(0);
            await capture(r);
            r.off();
            rigs.pop();
            resetD3D9SharedState();
            resetSwapChainRegistry();
        }
    });

    test("every restore-only setter reaches the twin through the wire codec with the bytes the front applied", async () => {
        const { r } = await splitRig();
        const first = await capture(r);
        const ram = snapshotRam(r);
        freshWorker(r, ram);
        const RESTORE_ONLY = ["createVertexShaderFromTokens", "createPixelShaderFromTokens", "setPaletteEntriesFromBytes",
            "writeVertexBufferContents", "writeIndexBufferContents", "seedRenderTargetContents", "seedBackbufferImage",
            "restoreTransform", "restoreDeviceWindow", "restoreRecordingEntries", "restoreShaderBooleanMasks"];
        const seen: Record<string, { front: string[]; twin: string[] }> = {};
        const trim = (a: unknown[]) => { const out = [...a]; while (out.length && out[out.length - 1] === undefined) out.pop(); return out; };
        const canon = (a: unknown[]) => JSON.stringify(trim(a), (_k, x) => ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x);
        const D3D9Device = (await import("../../src/worker/backends/webgpu/d3d9/d3d9-device")).D3D9Device;
        const proto = D3D9Device.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
        const saved: Record<string, (...a: unknown[]) => unknown> = {};
        for (const name of RESTORE_ONLY) {
            const orig = proto[name]!;
            saved[name] = orig;
            proto[name] = function (this: { role?: string }, ...args: unknown[]) {
                const slot = (seen[name] ??= { front: [], twin: [] });
                (this.role === "front" ? slot.front : slot.twin).push(canon(args));
                return orig.apply(this, args);
            };
        }
        try {
            await restoreInto(r, first.saved, first.graph);
            d3d9SplitFlush();
        } finally {
            for (const name of RESTORE_ONLY) proto[name] = saved[name]!;
        }
        const used = Object.keys(seen).sort();
        expect(used.length).toBeGreaterThanOrEqual(4);
        for (const name of used) expect({ name, twin: seen[name]!.twin }).toEqual({ name, twin: seen[name]!.front });
        expect(Object.values(d3d9SplitStats()!.encodeErrors)).toEqual([]);
    });
});
