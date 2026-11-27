import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { devices, resetD3D9SharedState } from "../../../src/worker/modules/d3d9/shared-state";
import { resetSwapChainRegistry } from "../../../src/worker/modules/d3d9/swapchain";
import { CaptureRefusal } from "../../../src/worker/savestate/object-codecs";
import { runRigsSplit, FakeGpu, bytes, capture, freshWorker, makeRig, restoreInto, snapshotRam, type FakeTexture, type Rig } from "./d3d9-savestate-rig";
import { buildScene, ok, type Scene } from "./d3d9-savestate-scene";

export function defineD3D9PixelSuite(split = false): void {
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

    const rtTexture = (r: Rig, scene: Scene): FakeTexture => {
        const store = priv(r.device).textures;
        return store.getGpuTexture(store.getIndex(scene.rtTex));
    };

    const backbuffer = (r: Rig): FakeTexture => {
        priv(r.device).backendExecutor.ensureBackbufferTarget();
        return priv(priv(r.device).backendExecutor).offscreenTexture;
    };

    describe("pixel resources", () => {
        test.skipIf(split)("a render target texture's pixels are read back, saved, and written into the new GPU image", async () => {
            const { r, scene } = await sceneRig();
            const before = rtTexture(r, scene).data.slice();
            expect(before.some(b => b !== 0)).toBe(true);
            const first = await capture(r);
            const ram = snapshotRam(r);
            const old = rtTexture(r, scene);
            freshWorker(r, ram);
            old.data.fill(0);
            await restoreInto(r, first.saved, first.graph);
            const now = rtTexture(r, scene);
            expect(now).not.toBe(old);
            expect(now.data).toEqual(before);
            expect(devices.get(r.devicePtr)).toBeDefined();
            expect(bytes((await capture(r)).saved)).toBe(bytes(first.saved));
        });

        test.skipIf(split)("the back buffer is read through the presented-image path and seeded into the new offscreen target", async () => {
            const { r } = await sceneRig();
            const target = backbuffer(r);
            expect(target.width).toBe(64);
            expect(target.height).toBe(48);
            for (let i = 0; i < target.data.length; i += 4) target.data.set([i & 255, (i >> 2) & 255, 9, 255], i);
            const before = target.data.slice();
            const first = await capture(r);
            const ram = snapshotRam(r);
            freshWorker(r, ram);
            await restoreInto(r, first.saved, first.graph);
            const seeded = priv(priv(devices.get(r.devicePtr)).backendExecutor).offscreenTexture as FakeTexture;
            expect(seeded).not.toBe(target);
            expect(seeded.data).toEqual(before);
        });

        test("a texture that is not a render target is carried as bytes, not read back", async () => {
            const { r, scene } = await sceneRig();
            const buffersBefore = r.gpu.buffers.length;
            const first = await capture(r);
            expect(r.gpu.buffers.length - buffersBefore).toBeLessThanOrEqual(2);
            const saved = (first.saved as any).textures.find((t: any) => t.ptr === scene.tex);
            expect(saved.store.renderTarget).toBe(false);
            expect(saved.store.data).toMatch(/^[0-9a-f]{64}$/);
            expect(saved.store.mips.length).toBe(1);
        });

        test("an unchanged texture is neither copied nor hashed again on the next capture", async () => {
            const { r, scene } = await sceneRig();
            const store = priv(r.device).textures;
            const data = store.getData(store.getIndex(scene.tex)) as Uint8Array;
            let slices = 0;
            const slice = data.slice.bind(data);
            data.slice = ((...a: number[]) => { slices++; return slice(...a); }) as never;
            await capture(r);
            const after = slices;
            expect(after).toBe(1);
            await capture(r);
            expect(slices).toBe(after);
            store.noteDataWritten(store.getIndex(scene.tex));
            await capture(r);
            expect(slices).toBe(after + 1);
        });

        test("a render target of a format with no readback conversion refuses by name", async () => {
            const { r } = await sceneRig();
            const hr = await r.call("IDirect3DDevice9_CreateTexture", r.devicePtr, 8, 8, 1, 1, 32, 0, 0x300, 0);
            expect(hr).toBe(0);
            const ptr = r.u32(0x300);
            const first = capture(r);
            await expect(first).rejects.toThrow(CaptureRefusal);
            await expect(capture(r)).rejects.toThrow(`render target texture 0x${ptr.toString(16)}`);
            await expect(capture(r)).rejects.toThrow("format 32 has no readback conversion");
        });
    });

    describe("buffer contents", () => {
        test("an unchanged buffer hands the same copy to the next capture, a changed one a new copy", async () => {
            const { r, scene } = await sceneRig();
            const first = await capture(r);
            const second = await capture(r);
            const vbHash = (c: typeof first) => (c.saved as any).vertexBuffers.find((b: any) => b.ptr === scene.vb).store.data;
            expect(vbHash(second)).toBe(vbHash(first));
            expect(second.graph.blobs.get(vbHash(first))).toBe(first.graph.blobs.get(vbHash(first)));
            await ok(r, "IDirect3DVertexBuffer9_Lock", scene.vb, 0, 0, 0x6000, 0);
            r.mem[r.u32(0x6000) + 5] ^= 0xff;
            await ok(r, "IDirect3DVertexBuffer9_Unlock", scene.vb);
            const third = await capture(r);
            expect(vbHash(third)).not.toBe(vbHash(first));
        });
    });
}
