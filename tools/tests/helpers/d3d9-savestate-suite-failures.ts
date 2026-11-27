import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { devices, resetD3D9SharedState, stateBlocks, resourceToDevice, createComObject } from "../../../src/worker/modules/d3d9/shared-state";
import { getDeviceSwapChain, resetSwapChainRegistry } from "../../../src/worker/modules/d3d9/swapchain";
import { comRefTableSizes, getComRefCount, liveComObjects } from "../../../src/worker/modules/d3d9/com-refs";
import { textureMeta, surfaceMeta, vertexBufferMeta, indexBufferMeta } from "../../../src/worker/modules/d3d9/resource-registry";
import { volumeTextureResources, lockVolumeBox } from "../../../src/worker/modules/d3d9/volume-resources";
import { D3D9 } from "../../../src/worker/modules/d3d9";
import { registerD3D9Participant } from "../../../src/worker/modules/d3d9/savestate";
import { gpuDeviceLifecycle } from "../../../src/worker/core/gpu/gpu-device-lifecycle";
import { registerLossTrackedDevice } from "../../../src/worker/core/gpu/gpu-device-loss-contract";
import { CaptureRefusal } from "../../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../../src/worker/savestate/participant";
import { runRigsSplit, FAKE_VTABLES, bytes, capture, freshWorker, makeRig, restoreInto, snapshotRam, type Rig } from "./d3d9-savestate-rig";
import { PS_TOKENS, VS_TOKENS, buildScene, ok, type Scene } from "./d3d9-savestate-scene";

export function defineD3D9FailureSuite(split = false): void {
    beforeAll(() => runRigsSplit(split));
    afterAll(() => runRigsSplit(false));
    const rigs: Rig[] = [];

    afterEach(() => {
        while (rigs.length) rigs.pop()!.off();
        resetD3D9SharedState();
        resetSwapChainRegistry();
        delete (globalThis as { __savestates?: boolean }).__savestates;
    });

    async function sceneRig(): Promise<{ r: Rig; scene: Scene }> {
        const r = await makeRig();
        rigs.push(r);
        return { r, scene: await buildScene(r) };
    }

    const priv = (o: unknown): Record<string, any> => o as Record<string, any>;
    const refusal = async (r: Rig): Promise<string> => {
        try {
            await capture(r);
        } catch (e) {
            expect(e).toBeInstanceOf(CaptureRefusal);
            return (e as Error).message;
        }
        throw new Error("the capture was not refused");
    };
    const hex = (n: number): string => `0x${n.toString(16)}`;

    describe("a capture that cannot be taken faithfully refuses by name", () => {
        test("locks the guest holds, at the module and at the device", async () => {
            const { r, scene } = await sceneRig();
            await ok(r, "IDirect3DVertexBuffer9_Lock", scene.vb, 0, 0, 0x6000, 0);
            expect(await refusal(r)).toBe("d3d9: a texture or buffer lock is still open");
            await ok(r, "IDirect3DVertexBuffer9_Unlock", scene.vb);

            expect(r.device.lockVertexBuffer(scene.vb, 0, 16)).toBeGreaterThan(0);
            expect(await refusal(r)).toBe(`d3d9: vertex buffer ${hex(scene.vb)} is locked`);
            r.device.unlockVertexBuffer(scene.vb, r.mem);

            expect(r.device.lockIndexBuffer(scene.ib, 0, 16)).toBeGreaterThan(0);
            expect(await refusal(r)).toBe(`d3d9: index buffer ${hex(scene.ib)} is locked`);
            r.device.unlockIndexBuffer(scene.ib, r.mem);

            expect(r.device.lockTexture(scene.tex, 0)).not.toBeNull();
            expect(await refusal(r)).toBe(`d3d9: texture ${hex(scene.tex)} level 0 is locked`);
            r.device.unlockTexture(scene.tex, 0, r.mem);

            expect(r.device.lockTexture(scene.tex, 2)).not.toBeNull();
            expect(await refusal(r)).toBe(`d3d9: device ${hex(r.devicePtr)} has a texture mip level locked`);
            r.device.unlockTexture(scene.tex, 2, r.mem, true);

            expect(r.device.lockCubeFace(scene.cube, 1, 0)).not.toBeNull();
            expect(await refusal(r)).toBe(`d3d9: device ${hex(r.devicePtr)} has a cube face locked`);
            r.device.unlockCubeFace(scene.cube, 1, 0, r.mem);

            await ok(r, "IDirect3DVolumeTexture9_LockBox", scene.volume, 0, 0x6000, 0, 0);
            expect(await refusal(r)).toBe("d3d9: a volume texture lock is still open");
            await ok(r, "IDirect3DVolumeTexture9_UnlockBox", scene.volume, 0);
            expect(lockVolumeBox(scene.volume, 0, null)).not.toBeNull();
            expect(await refusal(r)).toBe(`d3d9: volume texture ${hex(scene.volume)} has a mip level locked`);
            await ok(r, "IDirect3DVolumeTexture9_UnlockBox", scene.volume, 0);
            await capture(r);
        });

        test("a query whose result has not been read", async () => {
            const { r, scene } = await sceneRig();
            await ok(r, "IDirect3DQuery9_Issue", scene.query, 1);
            expect(await refusal(r)).toBe(`d3d9: query ${hex(scene.query)} was issued and its result has not been read`);
            const manager = priv(r.device).getQueryManager();
            manager.notifySubmitted(manager.getSubmittedSerial() + 10);
            const hr = await r.call("IDirect3DQuery9_GetData", scene.query, 0x6000, 4, 1);
            expect(hr).toBe(0);
            const first = await capture(r);
            expect((first.saved as any).queries[0]).toMatchObject({ ptr: scene.query, issued: true });
            freshWorker(r, snapshotRam(r));
            await restoreInto(r, first.saved, first.graph);
            expect(await r.call("IDirect3DQuery9_GetData", scene.query, 0x6000, 4, 1)).toBe(0);
            expect(r.u32(0x6000)).toBe(1);
        });

        test("a device that is lost", async () => {
            const { r } = await sceneRig();
            registerLossTrackedDevice(r.devicePtr, { generation: () => 99, isUsable: () => false });
            expect(await refusal(r)).toBe(`d3d9: device ${hex(r.devicePtr)} is lost or waiting for a Reset`);
        });

        test("a COM object another module owns", async () => {
            const { r } = await sceneRig();
            const stranger = createComObject(0x9990);
            expect(await refusal(r)).toBe(`d3d9: COM object ${hex(stranger)} (a vtable d3d9 did not publish) is not owned by d3d9`);
        });
    });

    describe("a recording that is still open is carried", () => {
        test("EndStateBlock after a load yields the block the guest was recording", async () => {
            const { r, scene } = await sceneRig();
            await ok(r, "IDirect3DDevice9_BeginStateBlock", r.devicePtr);
            await ok(r, "IDirect3DDevice9_SetRenderState", r.devicePtr, 28, 7);
            await ok(r, "IDirect3DDevice9_SetTexture", r.devicePtr, 3, scene.tex);
            const first = await capture(r);
            expect((first.saved as any).devices[0].state.recording.entries.length).toBe(2);
            expect((first.saved as any).recordingDevices).toEqual([r.devicePtr]);
            freshWorker(r, snapshotRam(r));
            await restoreInto(r, first.saved, first.graph);
            expect(r.device.isRecordingStateBlock()).toBe(true);
            expect(await r.call("IDirect3DDevice9_CreateStateBlock", r.devicePtr, 1, 0x6000)).toBe(0x8876086c);
            await ok(r, "IDirect3DDevice9_EndStateBlock", r.devicePtr, 0x6000);
            const block = stateBlocks.get(r.u32(0x6000))!;
            expect(block.entries.map((e) => e.op)).toEqual(["renderState", "texture"]);
            expect(r.device.isRecordingStateBlock()).toBe(false);
        });
    });

    describe("a restore that cannot be done faithfully fails by name", () => {
        test("a blob that is missing", async () => {
            const { r } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const hash = (first.saved as any).vertexBuffers[0].store.data as string;
            first.graph.blobs.delete(hash);
            freshWorker(r, ram);
            await expect(restoreInto(r, first.saved, first.graph)).rejects.toThrow(/^d3d9: the saved buffer 0x[0-9a-f]+ is missing/);
            expect(devices.size).toBe(0);
        });

        test("a blob of the wrong length", async () => {
            const { r, scene } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const hash = (first.saved as any).textures.find((t: any) => t.ptr === scene.tex).store.data as string;
            first.graph.blobs.set(hash, new Uint8Array(10));
            freshWorker(r, ram);
            await expect(restoreInto(r, first.saved, first.graph)).rejects.toThrow(`d3d9: the saved texture ${hex(scene.tex)} holds 10 bytes, expected 64`);
            expect(devices.size).toBe(0);
        });

        test("shader bytecode that does not end where it says", async () => {
            const { r } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const hash = (first.saved as any).pixelShaders[0].bytecode as string;
            first.graph.blobs.set(hash, new Uint8Array(PS_TOKENS.length * 4).fill(1));
            freshWorker(r, ram);
            await expect(restoreInto(r, first.saved, first.graph)).rejects.toThrow(/^d3d9: the saved bytecode of shader 0x[0-9a-f]+ does not end where it says/);
        });

        test("a shader the translator refuses on the second try", async () => {
            const { r, scene } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const hash = (first.saved as any).vertexShaders[0].bytecode as string;
            const broken = new Uint32Array(VS_TOKENS);
            broken[0] = 0xfffe0912;
            first.graph.blobs.set(hash, new Uint8Array(broken.buffer));
            freshWorker(r, ram);
            await expect(restoreInto(r, first.saved, first.graph)).rejects.toThrow(`d3d9: vertex shader ${hex(scene.vs)} could not be translated again`);
        });
    });

    describe("the GPU half of a capture", () => {
        test.skipIf(split)("a readback that fails refuses by name and leaves nothing behind", async () => {
            const { r, scene } = await sceneRig();
            const good = bytes((await capture(r)).saved);
            r.gpu.failMap = true;
            const message = await refusal(r);
            expect(message).toBe(`d3d9: render target texture ${hex(scene.rtTex)} of device ${hex(r.devicePtr)} could not be read back (the GPU device was lost during the readback)`);
            r.gpu.failMap = false;
            expect(bytes((await capture(r)).saved)).toBe(good);
        });

        test.skipIf(split)("a GPU device lost before the readback refuses by name", async () => {
            const { r, scene } = await sceneRig();
            r.gpu.lost = true;
            expect(await refusal(r)).toBe(`d3d9: render target texture ${hex(scene.rtTex)} of device ${hex(r.devicePtr)} could not be read back (the GPU device is lost)`);
            r.gpu.lost = false;
            await capture(r);
        });

        test("a capture taken without a prepare cannot reuse another capture's readback", async () => {
            const { r } = await sceneRig();
            await capture(r);
            const graph = (await capture(r)).graph;
            expect(() => r.participant.capture(graph as never)).not.toThrow();
        });
    });

    function footprint(r: Rig): Record<string, number> {
        return {
            gpuTextures: r.gpu.liveTextures(),
            gpuBuffers: r.gpu.liveBuffers(),
            observers: gpuDeviceLifecycle.report().observers.filter(l => l === "d3d9-device").length,
            devices: devices.size,
            stateBlocks: stateBlocks.size,
            resources: resourceToDevice.size,
            textures: textureMeta.size,
            surfaces: surfaceMeta.size,
            vertexBuffers: vertexBufferMeta.size,
            indexBuffers: indexBufferMeta.size,
            volumes: volumeTextureResources.size,
            participants: savestateParticipants.all().length,
            ...comRefTableSizes(),
        };
    }

    describe("a restore into a session that already has a device", () => {
        test("ends equal to the saved state and leaks nothing", async () => {
            const { r, scene } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);

            r.mem.set(ram);
            await restoreInto(r, first.saved, first.graph);
            const steady = footprint(r);
            expect(bytes((await capture(r)).saved)).toBe(bytes(first.saved));

            const extra: number[] = [];
            for (const [name, args, at] of [
                ["IDirect3DDevice9_CreateTexture", [r.devicePtr, 8, 8, 1, 0, 21, 1, 0x7000, 0], 0x7000],
                ["IDirect3DDevice9_CreateVertexBuffer", [r.devicePtr, 32, 0, 2, 1, 0x7010, 0], 0x7010],
                ["IDirect3DDevice9_CreateTexture", [r.devicePtr, 16, 16, 1, 1, 21, 0, 0x7020, 0], 0x7020],
            ] as Array<[string, number[], number]>) {
                await ok(r, name, ...args);
                extra.push(r.u32(at));
            }
            await ok(r, "IDirect3DDevice9_SetRenderState", r.devicePtr, 7, 1);
            await ok(r, "IDirect3DDevice9_SetTexture", r.devicePtr, 0, extra[0]!);
            await r.call("IDirect3DTexture9_Release", scene.tex);
            expect(footprint(r)).not.toEqual(steady);

            r.mem.set(ram);
            await restoreInto(r, first.saved, first.graph);
            expect(bytes((await capture(r)).saved)).toBe(bytes(first.saved));
            expect(footprint(r)).toEqual(steady);
            for (const ptr of extra) expect(getComRefCount(ptr)).toBeUndefined();
            expect(liveComObjects()).toEqual((first.saved as any).refs.counts.map((c: number[]) => c[0]));
        });
    });

    describe("repeated captures and loads", () => {
        test("fifty rounds with savestates on leave no growth", async () => {
            const { r } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const rounds: Array<Record<string, number>> = [];
            for (let i = 0; i < 50; i++) {
                const taken = await capture(r);
                expect(bytes(taken.saved)).toBe(bytes(first.saved));
                r.mem.set(ram);
                await restoreInto(r, taken.saved, taken.graph);
                if (i === 1 || i === 49) rounds.push(footprint(r));
            }
            expect(rounds[1]).toEqual(rounds[0]!);
            expect(bytes((await capture(r)).saved)).toBe(bytes(first.saved));
        });
    });

    describe("with savestates off", () => {
        const makeModule = (): D3D9 => {
            const dispatcher = new Proxy({}, { get: () => () => undefined });
            const module = new D3D9();
            module.initialize({ dispatcher, memory: {}, getCurrentMemory: () => new Uint8Array(0) } as never);
            return module;
        };

        test("nothing registers and the exports are the ones develop builds", () => {
            const before = savestateParticipants.all().length;
            delete (globalThis as { __savestates?: boolean }).__savestates;
            const off = makeModule();
            expect(savestateParticipants.all().length).toBe(before);
            expect(savestateParticipants.all().some(p => p.id === "d3d9")).toBe(false);

            (globalThis as { __savestates?: boolean }).__savestates = true;
            const on = makeModule();
            expect(savestateParticipants.all().some(p => p.id === "d3d9")).toBe(true);
            expect(Object.keys(on.exports).sort()).toEqual(Object.keys(off.exports).sort());
            expect(Object.keys(off.exports).length).toBeGreaterThan(400);
            for (const name of Object.keys(off.exports)) expect(typeof off.exports[name]).toBe("function");
            registerD3D9Participant()();
            expect(savestateParticipants.all().some(p => p.id === "d3d9")).toBe(false);
        });
    });
}
