import { CaptureRefusal } from "../../../src/worker/savestate/object-codecs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9StateTracker } from "../../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { IndexBufferStore, TextureStore, VertexBufferStore } from "../../../src/worker/backends/webgpu/d3d9/d3d9-resources";
import { D3D9PresentationState } from "../../../src/worker/backends/webgpu/d3d9/presentation";
import { D3D9StateBlockRecorder } from "../../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import { StreamBindingTable } from "../../../src/worker/backends/webgpu/shared/vertex-streams";
import { TexturePaletteStore } from "../../../src/worker/backends/webgpu/shared/texture-palette-store";
import {
    D3D9_DEVICE_FIELDS, D3D9_INDEX_BUFFER_FIELDS, D3D9_PALETTE_FIELDS, D3D9_PRESENTATION_FIELDS, D3D9_RECORDER_FIELDS,
    D3D9_STATE_BLOCK_FIELDS, D3D9_STREAM_FIELDS, D3D9_TEXTURE_STORE_FIELDS, D3D9_TRACKER_FIELDS, D3D9_VERTEX_BUFFER_FIELDS,
} from "../../../src/worker/backends/webgpu/d3d9/d3d9-savestate";
import { D3D9_RECORD_POLICIES } from "../../../src/worker/modules/d3d9/savestate";
import { deviceToD3D9, devices, resetD3D9SharedState, resourceToDevice, stateBlocks } from "../../../src/worker/modules/d3d9/shared-state";
import { comRefTableSizes, d3d9BindingRefStats, getComRefCount, liveComObjects, releaseComRef, unpinGuestRefcountStoreForTests } from "../../../src/worker/modules/d3d9/com-refs";
import { d3d9WasmArena } from "../../../src/worker/backends/webgpu/d3d9/d3d9-wasm-arena";
import { materializedBlockEntries } from "../../../src/worker/backends/webgpu/d3d9/d3d9-savestate";
import { captureDeviceCursors } from "../../../src/worker/core/device-cursor";
import { isD3D9ExDevice } from "../../../src/worker/modules/d3d9/ex";
import { indexBufferMeta, surfaceMeta, textureMeta, vertexBufferMeta } from "../../../src/worker/modules/d3d9/resource-registry";
import { getDeviceSwapChain, resetSwapChainRegistry } from "../../../src/worker/modules/d3d9/swapchain";
import { runRigsSplit, FakeGpu, bytes, capture, freshWorker, makeRig, restoreInto, snapshotRam, writePresentParams, type Rig } from "./d3d9-savestate-rig";
import { buildExtras, buildScene, ok, type Scene } from "./d3d9-savestate-scene";

export function defineD3D9MainSuite(split = false): void {
    beforeAll(() => runRigsSplit(split));
    afterAll(() => runRigsSplit(false));
    const rigs: Rig[] = [];

    afterEach(() => {
        while (rigs.length) rigs.pop()!.off();
        resetD3D9SharedState();
        resetSwapChainRegistry();
        delete (globalThis as { __savestates?: boolean }).__savestates;
    });

    async function rig(opts: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
        const r = await makeRig(opts);
        rigs.push(r);
        return r;
    }

    async function sceneRig(): Promise<{ r: Rig; scene: Scene }> {
        const r = await rig();
        return { r, scene: await buildScene(r) };
    }

    async function viaFreshWorker(r: Rig): Promise<{ first: Awaited<ReturnType<typeof capture>>; second: Awaited<ReturnType<typeof capture>> }> {
        const first = await capture(r);
        const ram = snapshotRam(r);
        freshWorker(r, ram);
        await restoreInto(r, first.saved, first.graph);
        return { first, second: await capture(r) };
    }

    const backend = () => new FakeGpu().backend() as never;

    describe("every instance field of each saved class has a policy", () => {
        const instance = (): Record<string, Record<string, unknown>> => {
            const streams = new StreamBindingTable();
            return {
                device: new D3D9Device(backend(), null) as never,
                tracker: new D3D9StateTracker(streams) as never,
                streams: streams as never,
                vertexBufferStore: new VertexBufferStore() as never,
                indexBufferStore: new IndexBufferStore() as never,
                textureStore: new TextureStore() as never,
                palettes: new TexturePaletteStore() as never,
                presentation: new D3D9PresentationState() as never,
                recorder: new D3D9StateBlockRecorder() as never,
            };
        };
        const tables: Record<string, Readonly<Record<string, string>>> = {
            device: D3D9_DEVICE_FIELDS, tracker: D3D9_TRACKER_FIELDS, streams: D3D9_STREAM_FIELDS,
            vertexBufferStore: D3D9_VERTEX_BUFFER_FIELDS, indexBufferStore: D3D9_INDEX_BUFFER_FIELDS,
            textureStore: D3D9_TEXTURE_STORE_FIELDS, palettes: D3D9_PALETTE_FIELDS, presentation: D3D9_PRESENTATION_FIELDS,
            recorder: D3D9_RECORDER_FIELDS,
        };

        test("a field added to a class fails here until it is classified", () => {
            for (const [name, object] of Object.entries(instance())) {
                const fields = Object.keys(object).sort();
                const classified = Object.keys(tables[name]!).sort();
                expect({ name, unclassified: fields.filter(f => !classified.includes(f)) }).toEqual({ name, unclassified: [] });
                expect({ name, gone: classified.filter(f => !fields.includes(f)) }).toEqual({ name, gone: [] });
            }
        });

        test("the record types are classified at compile time and name only saved fields", () => {
            for (const [name, table] of Object.entries(D3D9_RECORD_POLICIES)) {
                expect({ name, others: Object.values(table).filter(p => p !== "save") }).toEqual({ name, others: [] });
            }
        });
    });

    describe("d3d9 savestate round trip", () => {
        test("capture, restore into a fresh worker and capture again is byte-identical", async () => {
            const { r, scene } = await sceneRig();
            const { first, second } = await viaFreshWorker(r);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
            expect([...second.graph.blobs.keys()].sort()).toEqual([...first.graph.blobs.keys()].sort());
            const saved = first.saved as Record<string, unknown[]>;
            expect(saved.devices!.length).toBe(1);
            expect(saved.textures!.length).toBe(3);
            expect(saved.vertexBuffers!.length).toBe(2);
            expect(saved.indexBuffers!.length).toBe(1);
            expect(saved.volumes!.length).toBe(1);
            expect(saved.vertexShaders!.length).toBe(1);
            expect(saved.pixelShaders!.length).toBe(1);
            expect(saved.declarations!.length).toBe(1);
            expect(saved.stateBlocks!.length).toBe(2);
            expect(saved.queries!.length).toBe(1);
            expect(scene.vb).not.toBe(0);
        });
    });

    const ANS = 0x6000;

    async function answers(r: Rig, scene: Scene): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        const dev = r.devicePtr;
        const read = (n: number): string => Buffer.from(r.mem.slice(ANS, ANS + n)).toString("hex");
        const ask = async (key: string, name: string, size: number, ...args: number[]): Promise<void> => {
            r.mem.fill(0xcd, ANS, ANS + 0x400);
            const hr = await r.call(name, ...args);
            out[key] = `${(hr >>> 0).toString(16)}:${read(size)}`;
        };
        for (const state of [7, 14, 19, 22, 27, 28, 154, 137]) await ask(`rs${state}`, "IDirect3DDevice9_GetRenderState", 4, dev, state, ANS);
        for (const [sampler, type] of [[0, 5], [3, 1], [0, 2]]) await ask(`ss${sampler}:${type}`, "IDirect3DDevice9_GetSamplerState", 4, dev, sampler, type, ANS);
        for (const [stage, type] of [[0, 1], [2, 24], [1, 1]]) await ask(`tss${stage}:${type}`, "IDirect3DDevice9_GetTextureStageState", 4, dev, stage, type, ANS);
        for (const state of [0x100, 16, 2, 3]) await ask(`xf${state}`, "IDirect3DDevice9_GetTransform", 64, dev, state, ANS);
        await ask("material", "IDirect3DDevice9_GetMaterial", 68, dev, ANS);
        await ask("light2", "IDirect3DDevice9_GetLight", 104, dev, 2, ANS);
        await ask("light2on", "IDirect3DDevice9_GetLightEnable", 4, dev, 2, ANS);
        await ask("clip1", "IDirect3DDevice9_GetClipPlane", 16, dev, 1, ANS);
        await ask("viewport", "IDirect3DDevice9_GetViewport", 24, dev, ANS);
        await ask("scissor", "IDirect3DDevice9_GetScissorRect", 16, dev, ANS);
        await ask("fvf", "IDirect3DDevice9_GetFVF", 4, dev, ANS);
        await ask("vsc", "IDirect3DDevice9_GetVertexShaderConstantF", 64, dev, 4, ANS, 4);
        await ask("psc", "IDirect3DDevice9_GetPixelShaderConstantF", 32, dev, 1, ANS, 2);
        await ask("vsi", "IDirect3DDevice9_GetVertexShaderConstantI", 16, dev, 1, ANS, 1);
        await ask("psi", "IDirect3DDevice9_GetPixelShaderConstantI", 16, dev, 2, ANS, 1);
        await ask("vsb", "IDirect3DDevice9_GetVertexShaderConstantB", 12, dev, 2, ANS, 3);
        await ask("psb", "IDirect3DDevice9_GetPixelShaderConstantB", 8, dev, 0, ANS, 2);
        await ask("npatch", "IDirect3DDevice9_GetNPatchMode", 4, dev, ANS);
        await ask("freq2", "IDirect3DDevice9_GetStreamSourceFreq", 4, dev, 2, ANS);
        await ask("stream0", "IDirect3DDevice9_GetStreamSource", 12, dev, 0, ANS, ANS + 4, ANS + 8);
        await ask("stream2", "IDirect3DDevice9_GetStreamSource", 12, dev, 2, ANS, ANS + 4, ANS + 8);
        await ask("indices", "IDirect3DDevice9_GetIndices", 4, dev, ANS);
        for (const stage of [0, 1, 2, 3]) await ask(`tex${stage}`, "IDirect3DDevice9_GetTexture", 4, dev, stage, ANS);
        await ask("vs", "IDirect3DDevice9_GetVertexShader", 4, dev, ANS);
        await ask("ps", "IDirect3DDevice9_GetPixelShader", 4, dev, ANS);
        await ask("decl", "IDirect3DDevice9_GetVertexDeclaration", 4, dev, ANS);
        await ask("rt1", "IDirect3DDevice9_GetRenderTarget", 4, dev, 1, ANS);
        await ask("ds", "IDirect3DDevice9_GetDepthStencilSurface", 4, dev, ANS);
        await ask("rt0", "IDirect3DDevice9_GetRenderTarget", 4, dev, 0, ANS);
        await ask("cp", "IDirect3DDevice9_GetCreationParameters", 16, dev, ANS);
        await ask("texDesc", "IDirect3DTexture9_GetLevelDesc", 32, scene.tex, 1, ANS);
        await ask("rtDesc", "IDirect3DSurface9_GetDesc", 32, scene.rtSurface, ANS);
        await ask("vbDesc", "IDirect3DVertexBuffer9_GetDesc", 24, scene.vb, ANS);
        await ask("ibDesc", "IDirect3DIndexBuffer9_GetDesc", 20, scene.ib, ANS);
        await ask("volDesc", "IDirect3DVolumeTexture9_GetLevelDesc", 28, scene.volume, 0, ANS);
        await ask("vsFn", "IDirect3DVertexShader9_GetFunction", 32, scene.vs, ANS, ANS + 0x100);
        await ask("queryType", "IDirect3DQuery9_GetType", 0, scene.query);
        for (const [key, ptr] of Object.entries({ vb: scene.vb, tex: scene.tex, vs: scene.vs, dev })) {
            out[`refs-${key}`] = String(await r.call(key === "vb" ? "IDirect3DVertexBuffer9_AddRef" : key === "tex" ? "IDirect3DTexture9_AddRef" : key === "vs" ? "IDirect3DVertexShader9_AddRef" : "IDirect3DDevice9_AddRef", ptr));
            await r.call(key === "vb" ? "IDirect3DVertexBuffer9_Release" : key === "tex" ? "IDirect3DTexture9_Release" : key === "vs" ? "IDirect3DVertexShader9_Release" : "IDirect3DDevice9_Release", ptr);
        }
        await ok(r, "IDirect3DVertexBuffer9_Lock", scene.vb, 0, 0, ANS, 0x10);
        out.vbBytes = Buffer.from(r.mem.slice(r.u32(ANS), r.u32(ANS) + 256)).toString("hex");
        await ok(r, "IDirect3DVertexBuffer9_Unlock", scene.vb);
        await ok(r, "IDirect3DTexture9_LockRect", scene.tex, 1, ANS, 0, 0x10);
        out.texBytes = Buffer.from(r.mem.slice(r.u32(ANS + 4), r.u32(ANS + 4) + 16)).toString("hex");
        await ok(r, "IDirect3DTexture9_UnlockRect", scene.tex, 1);
        await ok(r, "IDirect3DCubeTexture9_LockRect", scene.cube, 3, 0, ANS, 0, 0x10);
        out.cubeBytes = Buffer.from(r.mem.slice(r.u32(ANS + 4), r.u32(ANS + 4) + 16)).toString("hex");
        await ok(r, "IDirect3DCubeTexture9_UnlockRect", scene.cube, 3, 0);
        await ok(r, "IDirect3DVolumeTexture9_LockBox", scene.volume, 0, ANS, 0, 0x10);
        out.volBytes = Buffer.from(r.mem.slice(r.u32(ANS + 8), r.u32(ANS + 8) + 32)).toString("hex");
        await ok(r, "IDirect3DVolumeTexture9_UnlockBox", scene.volume, 0);
        return out;
    }

    describe("the restored device answers like the saved one", () => {
        test("every state the guest can read back is the same after a load", async () => {
            const { r, scene } = await sceneRig();
            const first = await capture(r);
            const ram = snapshotRam(r);
            const before = await answers(r, scene);
            expect(Object.keys(before).length).toBeGreaterThan(60);
            expect(before.rs7).toBe("0:00000000");
            expect(before.fvf).toBe("0:00000000");
            freshWorker(r, ram);
            await restoreInto(r, first.saved, first.graph);
            r.device = devices.get(r.devicePtr)!;
            const after = await answers(r, scene);
            expect(after).toEqual(before);
        });
    });

    type Mutation = (r: Rig, scene: Scene) => () => void;
    const priv = (o: unknown): Record<string, any> => o as Record<string, any>;

    const poke = (owner: () => Record<string, any>, key: string, change: (v: any) => any): Mutation => () => {
        const o = owner();
        const old = o[key];
        o[key] = change(old);
        return () => { o[key] = old; };
    };

    const bump = (v: number): number => v + 1;
    const flip = (v: boolean): boolean => !v;

    const copyOf = <T extends ArrayBufferView>(v: T): T => v.slice ? (v as unknown as { slice(): T }).slice() : v;

    const pokeAt = (owner: (r: Rig, s: Scene) => any, index: number, value: number): Mutation => (r, s) => {
        const a = owner(r, s);
        const old = a[index];
        a[index] = value;
        return () => { a[index] = old; };
    };

    const mapPoke = (owner: (r: Rig, s: Scene) => Map<any, any>, key: any, value: () => any): Mutation => (r, s) => {
        const m = owner(r, s);
        const had = m.has(key);
        const old = m.get(key);
        m.set(key, value());
        return () => { if (had) m.set(key, old); else m.delete(key); };
    };

    const DEVICE_MUTATIONS: Record<string, Mutation> = {
        isExtended: (r) => poke(() => r.device, "isExtended", flip)(r, null as never),
        d3d9MsaaSampleCount: (r) => poke(() => priv(r.device), "d3d9MsaaSampleCount", () => 4)(r, null as never),
        renderTargetSampleTypes: pokeAt((r) => priv(r.device).renderTargetSampleTypes, 1, 4),
        activeStandaloneDepthSurface: (r) => poke(() => priv(r.device), "activeStandaloneDepthSurface", () => 0x1234)(r, null as never),
        streams: pokeAt((r) => priv(r.device).streams.offsetBytes, 3, 12),
        stateTracker: pokeAt((r) => priv(r.device).stateTracker.renderStates, 9, 3),
        vertexBuffers: pokeAt((r, s) => priv(r.device).vertexBuffers.getData(priv(r.device).vertexBuffers.getIndex(s.vb)), 5, 0xee),
        indexBuffers: pokeAt((r, s) => priv(r.device).indexBuffers.getData(priv(r.device).indexBuffers.getIndex(s.ib)), 5, 0xee),
        textures: (r, s) => {
            const t = priv(r.device).textures;
            const index = t.getIndex(s.tex);
            const data = t.getData(index) as Uint8Array;
            const old = data[5]!;
            data[5] = 0xee;
            t.noteDataWritten(index);
            return () => { data[5] = old; t.noteDataWritten(index); };
        },
        borrowedTextureMemory: (r, s) => {
            const d = priv(r.device);
            const had = d.borrowedTextureMemory;
            d.borrowedTextureMemory = new Map([[s.tex, { ptr: 0x9000, bytes: 64 }]]);
            return () => { d.borrowedTextureMemory = had; };
        },
        volumeByPointer: mapPoke((r) => priv(r.device).volumeByPointer, 0x999, () => -5),
        texturePalettes: (r) => { const p = priv(r.device).texturePalettes; p.setPalette(3, new Uint32Array(256).fill(7)); return () => { p.palettes.delete(3); }; },
        softwareVertexProcessing: (r) => poke(() => priv(r.device), "softwareVertexProcessing", flip)(r, null as never),
        npatchMode: (r) => poke(() => priv(r.device), "npatchMode", () => 9)(r, null as never),
        dialogBoxMode: (r) => poke(() => priv(r.device), "dialogBoxMode", flip)(r, null as never),
        renderTargetIndices: pokeAt((r) => priv(r.device).renderTargetIndices, 1, null as never),
        renderTargetFaces: pokeAt((r) => priv(r.device).renderTargetFaces, 1, 3),
        depthTextureIndex: (r, s) => poke(() => priv(r.device), "depthTextureIndex", () => priv(r.device).textures.getIndex(s.tex))(r, s),
        deviceWindowHwnd: (r) => poke(() => priv(r.device), "deviceWindowHwnd", bump)(r, null as never),
        deviceIsWindowed: (r) => poke(() => priv(r.device), "deviceIsWindowed", flip)(r, null as never),
        mipLevelData: (r, s) => {
            const m = priv(r.device).mipLevelData as Map<string, Uint8Array>;
            const k = `${s.tex}:1`;
            const old = m.get(k)!;
            const changed = old.slice();
            changed[1] = old[1]! + 1;
            m.set(k, changed);
            return () => { m.set(k, old); };
        },
        cubeFaceData: (r, s) => {
            const m = priv(r.device).cubeFaceData as Map<string, Uint8Array>;
            const k = `${s.cube}:2:0`;
            const old = m.get(k)!;
            const changed = old.slice();
            changed[1] = old[1]! + 1;
            m.set(k, changed);
            return () => { m.set(k, old); };
        },
        activeVertexShaderComPtr: (r) => poke(() => priv(r.device), "activeVertexShaderComPtr", () => 0x1234)(r, null as never),
        activePixelShaderComPtr: (r) => poke(() => priv(r.device), "activePixelShaderComPtr", () => 0x1234)(r, null as never),
        activeVertexDeclComPtr: (r) => poke(() => priv(r.device), "activeVertexDeclComPtr", () => 0x1234)(r, null as never),
        boundIndexPtr: (r) => poke(() => priv(r.device), "boundIndexPtr", () => 0x1234)(r, null as never),
        vsConstants: pokeAt((r) => priv(r.device).vsConstants, 20, 123.5),
        swvpVsConstants: pokeAt((r) => priv(r.device).swvpVsConstants, 9000, 77.25),
        swvpVsIntegerConstants: pokeAt((r) => priv(r.device).swvpVsIntegerConstants, 4000, 5),
        swvpVsBooleanConstants: pokeAt((r) => priv(r.device).swvpVsBooleanConstants, 5, 1),
        vsIntegerConstants: pokeAt((r) => priv(r.device).vsIntegerConstants, 6, 8),
        vsBooleanMask: (r) => poke(() => priv(r.device), "vsBooleanMask", () => 0x1234)(r, null as never),
        psConstants: pokeAt((r) => priv(r.device).psConstants, 30, 9.5),
        psIntegerConstants: pokeAt((r) => priv(r.device).psIntegerConstants, 3, 8),
        psBooleanMask: (r) => poke(() => priv(r.device), "psBooleanMask", () => 0x1234)(r, null as never),
        textureStageStates: mapPoke((r) => priv(r.device).textureStageStates, 0x00050003, () => 9),
        samplerStates: mapPoke((r) => priv(r.device).samplerStates, 0x00010004, () => 9),
        materialData: pokeAt((r) => priv(r.device).materialData, 3, 0x66),
        lights: mapPoke((r) => priv(r.device).lights, 5, () => new Uint8Array(104).fill(2)),
        lightEnables: mapPoke((r) => priv(r.device).lightEnables, 5, () => 1),
        clipPlanes: mapPoke((r) => priv(r.device).clipPlanes, 4, () => new Float32Array([1, 2, 3, 4])),
        stateBlockRecorder: (r) => { const rec = priv(r.device).stateBlockRecorder; rec.begin(); rec.record({ op: "fvf", value: 0x42 }); return () => { rec.end(); }; },
        boundTexturePtrs: pokeAt((r) => priv(r.device).boundTexturePtrs, 5, 0x1234),
        viewport: (r) => poke(() => priv(r.device), "viewport", (v) => ({ ...v, minZ: 0.125 }))(r, null as never),
        scissorRect: (r) => poke(() => priv(r.device), "scissorRect", (v) => ({ ...v, right: v.right + 1 }))(r, null as never),
        scissorRectSet: (r) => poke(() => priv(r.device), "scissorRectSet", flip)(r, null as never),
        presentInterval: (r) => poke(() => priv(r.device), "presentInterval", () => 4)(r, null as never),
        swapEffect: (r) => poke(() => priv(r.device), "swapEffect", () => 3)(r, null as never),
    };

    describe("every saved field reaches the capture", () => {
        test("every field the device table saves has a mutation, and the capture notices it", async () => {
            const { r, scene } = await sceneRig();
            const base = bytes((await capture(r)).saved);
            const saved = Object.entries(D3D9_DEVICE_FIELDS).filter(([, p]) => p === "save").map(([k]) => k);
            expect(saved.filter(k => !DEVICE_MUTATIONS[k])).toEqual([]);
            const unnoticed: string[] = [];
            for (const key of saved) {
                const undo = DEVICE_MUTATIONS[key]!(r, scene);
                const changed = await capture(r).then(c => bytes(c.saved) !== base, (e: unknown) => e instanceof CaptureRefusal);
                undo();
                if (!changed) unnoticed.push(key);
            }
            expect(unnoticed).toEqual([]);
            expect(bytes((await capture(r)).saved)).toBe(base);
        });
    });

    const vbIndex = (r: Rig, s: Scene): number => priv(r.device).vertexBuffers.getIndex(s.vb);
    const ibIndex = (r: Rig, s: Scene): number => priv(r.device).indexBuffers.getIndex(s.ib);
    const texIndex = (r: Rig, s: Scene): number => priv(r.device).textures.getIndex(s.tex);
    const rtIndex = (r: Rig, s: Scene): number => priv(r.device).textures.getIndex(s.rtTex);

    const arrayOf = (pick: (r: Rig, s: Scene) => any, field: string, at: (r: Rig, s: Scene) => number, value: number): Mutation =>
        (r, s) => {
            const a = pick(r, s)[field];
            const i = at(r, s);
            const old = a[i];
            a[i] = value;
            return () => { a[i] = old; };
        };

    const flipStaleness = (r: Rig, s: Scene, field: string, other: string): (() => void) => {
        const t = priv(r.device).textures;
        const i = texIndex(r, s);
        const old = t[field][i];
        const stale = t.guestSerials[i] !== t.dataSerials[i];
        t[field][i] = stale ? t[other][i] : t[other][i] + 1;
        return () => { t[field][i] = old; };
    };

    const SECTION_MUTATIONS: Record<string, Record<string, Mutation>> = {
        tracker: {
            renderStates: arrayOf((r) => priv(r.device).stateTracker, "renderStates", () => 9, 3),
            worldMatrix: arrayOf((r) => priv(r.device).stateTracker, "worldMatrix", () => 0, 7),
            worldMatrices: arrayOf((r) => priv(r.device).stateTracker, "worldMatrices", () => 40, 7),
            viewMatrix: arrayOf((r) => priv(r.device).stateTracker, "viewMatrix", () => 1, 7),
            projMatrix: arrayOf((r) => priv(r.device).stateTracker, "projMatrix", () => 2, 7),
            texMatrices: arrayOf((r) => priv(r.device).stateTracker, "texMatrices", () => 17, 7),
            fvf: (r) => poke(() => priv(r.device).stateTracker, "fvf", () => 0x42)(r, null as never),
        },
        streams: {
            ptr: arrayOf((r) => priv(r.device).streams, "ptr", () => 3, 5),
            offsetBytes: arrayOf((r) => priv(r.device).streams, "offsetBytes", () => 3, 5),
            strideBytes: arrayOf((r) => priv(r.device).streams, "strideBytes", () => 3, 5),
            freq: arrayOf((r) => priv(r.device).streams, "freq", () => 3, 5),
        },
        vertexBufferStore: {
            sizes: arrayOf((r) => priv(r.device).vertexBuffers, "sizes", (r, s) => vbIndex(r, s), 77),
            fvfs: arrayOf((r) => priv(r.device).vertexBuffers, "fvfs", (r, s) => vbIndex(r, s), 77),
            pools: arrayOf((r) => priv(r.device).vertexBuffers, "pools", (r, s) => vbIndex(r, s), 3),
            guestPtrs: arrayOf((r) => priv(r.device).vertexBuffers, "guestPtrs", (r, s) => vbIndex(r, s), 77),
            data: (r, s) => { const d = priv(r.device).vertexBuffers.data[vbIndex(r, s)]; const old = d[3]; d[3] = old ^ 0xff; return () => { d[3] = old; }; },
        },
        indexBufferStore: {
            sizes: arrayOf((r) => priv(r.device).indexBuffers, "sizes", (r, s) => ibIndex(r, s), 77),
            formats: arrayOf((r) => priv(r.device).indexBuffers, "formats", (r, s) => ibIndex(r, s), 102),
            pools: arrayOf((r) => priv(r.device).indexBuffers, "pools", (r, s) => ibIndex(r, s), 3),
            guestPtrs: arrayOf((r) => priv(r.device).indexBuffers, "guestPtrs", (r, s) => ibIndex(r, s), 77),
            data: (r, s) => { const d = priv(r.device).indexBuffers.data[ibIndex(r, s)]; const old = d[3]; d[3] = old ^ 0xff; return () => { d[3] = old; }; },
        },
        textureStore: {
            widths: arrayOf((r) => priv(r.device).textures, "widths", (r, s) => texIndex(r, s), 8),
            heights: arrayOf((r) => priv(r.device).textures, "heights", (r, s) => texIndex(r, s), 8),
            levels: arrayOf((r) => priv(r.device).textures, "levels", (r, s) => texIndex(r, s), 2),
            pools: arrayOf((r) => priv(r.device).textures, "pools", (r, s) => texIndex(r, s), 2),
            formats: arrayOf((r) => priv(r.device).textures, "formats", (r, s) => texIndex(r, s), 22),
            guestPtrs: arrayOf((r) => priv(r.device).textures, "guestPtrs", (r, s) => texIndex(r, s), 77),
            rtFlags: arrayOf((r) => priv(r.device).textures, "rtFlags", (r, s) => texIndex(r, s), 1),
            cubeFlags: arrayOf((r) => priv(r.device).textures, "cubeFlags", (r, s) => texIndex(r, s), 1),
            dataSerials: (r, s) => flipStaleness(r, s, "dataSerials", "guestSerials"),
            guestSerials: (r, s) => flipStaleness(r, s, "guestSerials", "dataSerials"),
            handles: (r, s) => { const h = priv(r.device).textures.handles; const i = rtIndex(r, s); const old = h[i]; h[i] = old + 4; return () => { h[i] = old; }; },
            data: (r, s) => {
                const t = priv(r.device).textures;
                const d = t.getData(texIndex(r, s)) as Uint8Array;
                const old = d[1]!;
                d[1] = old ^ 0xff;
                t.noteDataWritten(texIndex(r, s));
                return () => { d[1] = old; t.noteDataWritten(texIndex(r, s)); };
            },
        },
        palettes: {
            palettes: (r) => { const p = priv(r.device).texturePalettes; p.palettes.set(9, new Uint32Array(256).fill(3)); return () => { p.palettes.delete(9); }; },
            currentTexturePalette: (r) => { const p = priv(r.device).texturePalettes; const old = p.currentTexturePalette; p.currentTexturePalette = 6; return () => { p.currentTexturePalette = old; }; },
        },
        presentation: {
            serial: (r) => { const p = priv(getDeviceSwapChain(r.devicePtr, 0)!.presentation); const old = p.serial; p.serial = old + 5; return () => { p.serial = old; }; },
            chains: (r) => { const c = priv(getDeviceSwapChain(r.devicePtr, 0)!.presentation).chains.get(0); const old = c.presents; c.presents = old + 3; return () => { c.presents = old; }; },
        },
        recorder: {
            active: (r) => { const rec = priv(r.device).stateBlockRecorder; rec.begin(); return () => { rec.end(); }; },
            entries: (r) => { const rec = priv(r.device).stateBlockRecorder; rec.begin(); rec.record({ op: "fvf", value: 3 }); return () => { rec.end(); }; },
        },
        stateBlock: {
            devicePtr: (r, s) => { const b = stateBlocks.get(s.allBlock)!; const old = b.devicePtr; b.devicePtr = old + 4; return () => { b.devicePtr = old; }; },
            blockType: (r, s) => { const b = stateBlocks.get(s.allBlock)!; const old = b.blockType; b.blockType = 2; return () => { b.blockType = old; }; },
            entries: (r, s) => { const b = stateBlocks.get(s.block)!; const e = b.entries[0] as { value: number }; const old = e.value; e.value = old + 1; return () => { e.value = old; }; },
        },
    };

    const SECTION_TABLES: Record<string, Readonly<Record<string, string>>> = {
        tracker: D3D9_TRACKER_FIELDS, streams: D3D9_STREAM_FIELDS, vertexBufferStore: D3D9_VERTEX_BUFFER_FIELDS,
        indexBufferStore: D3D9_INDEX_BUFFER_FIELDS, textureStore: D3D9_TEXTURE_STORE_FIELDS, palettes: D3D9_PALETTE_FIELDS,
        presentation: D3D9_PRESENTATION_FIELDS, recorder: D3D9_RECORDER_FIELDS, stateBlock: D3D9_STATE_BLOCK_FIELDS,
    };

    describe("every saved field of the parts reaches the capture", () => {
        test("each part's saved fields have a mutation, and the capture notices every one", async () => {
            const { r, scene } = await sceneRig();
            const base = bytes((await capture(r)).saved);
            const problems: string[] = [];
            for (const [part, table] of Object.entries(SECTION_TABLES)) {
                for (const [field, policy] of Object.entries(table)) {
                    if (policy !== "save") continue;
                    const mutate = SECTION_MUTATIONS[part]?.[field];
                    if (!mutate) { problems.push(`${part}.${field}: no mutation`); continue; }
                    const undo = mutate(r, scene);
                    const changed = bytes((await capture(r)).saved) !== base;
                    undo();
                    if (!changed) problems.push(`${part}.${field}: not noticed`);
                }
            }
            expect(problems).toEqual([]);
        });
    });

    describe("the rest of the object model", () => {
        test("surfaces, swap chains, private data, gamma, palettes and software vertex constants round trip", async () => {
            const { r, scene } = await sceneRig();
            const extras = await buildExtras(r, scene);
            const { first, second } = await viaFreshWorker(r);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
            const saved = first.saved as any;
            expect(saved.swapChains.chains.length).toBe(2);
            expect(saved.devices[0].state.vsFloatExtended).toMatch(/^[0-9a-f]{64}$/);
            expect(saved.devices[0].state.softwareVertexProcessing).toBe(false);
            expect(saved.gamma).not.toBeNull();
            expect(saved.contract.privateData.length).toBe(1);
            expect(saved.validators.length).toBe(1);
            expect(saved.queries.length).toBe(2);
        });

        test("what the guest reads back about them is unchanged", async () => {
            const { r, scene } = await sceneRig();
            const extras = await buildExtras(r, scene);
            const first = await capture(r);
            const ram = snapshotRam(r);
            const ask = async (): Promise<Record<string, string>> => {
                const out: Record<string, string> = {};
                const put = async (key: string, name: string, size: number, ...args: number[]): Promise<void> => {
                    r.mem.fill(0xcd, ANS, ANS + 0x400);
                    const hr = await r.call(name, ...args);
                    out[key] = `${(hr >>> 0).toString(16)}:${Buffer.from(r.mem.slice(ANS, ANS + size)).toString("hex")}`;
                };
                await put("chains", "IDirect3DDevice9_GetNumberOfSwapChains", 0, r.devicePtr);
                await put("chainParams", "IDirect3DSwapChain9_GetPresentParameters", 56, extras.chain, ANS);
                await put("plainDesc", "IDirect3DSurface9_GetDesc", 32, extras.plain, ANS);
                await put("rtDesc", "IDirect3DSurface9_GetDesc", 32, extras.renderTarget, ANS);
                await put("backDesc", "IDirect3DSurface9_GetDesc", 32, extras.backBuffer, ANS);
                await put("volLevel", "IDirect3DVolume9_GetDesc", 28, extras.volumeLevel, ANS);
                await put("lod", "IDirect3DTexture9_GetLOD", 0, scene.tex);
                await put("priority", "IDirect3DTexture9_GetPriority", 0, scene.tex);
                r.mem.set([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0x5000);
                r.mem.fill(0, ANS + 0x300, ANS + 0x304);
                new DataView(r.mem.buffer).setUint32(ANS + 0x300, 16, true);
                await put("private", "IDirect3DTexture9_GetPrivateData", 4, scene.tex, 0x5000, ANS, ANS + 0x300);
                await put("gamma", "IDirect3DDevice9_GetGammaRamp", 1536, r.devicePtr, 0, ANS);
                await put("clip", "IDirect3DDevice9_GetClipStatus", 8, r.devicePtr, ANS);
                await put("palette", "IDirect3DDevice9_GetPaletteEntries", 1024, r.devicePtr, 3, ANS);
                await put("curPalette", "IDirect3DDevice9_GetCurrentTexturePalette", 4, r.devicePtr, ANS);
                await put("depthBound", "IDirect3DDevice9_GetDepthStencilSurface", 4, r.devicePtr, ANS);
                await put("rt2", "IDirect3DDevice9_GetRenderTarget", 4, r.devicePtr, 2, ANS);
                await put("swvp", "IDirect3DDevice9_GetSoftwareVertexProcessing", 4, r.devicePtr, ANS);
                await put("occType", "IDirect3DQuery9_GetType", 0, extras.occlusion);
                return out;
            };
            const before = await ask();
            expect(before.chains).toBe("2:");
            freshWorker(r, ram);
            await restoreInto(r, first.saved, first.graph);
            expect(await ask()).toEqual(before);
            expect(r.device.getSoftwareVertexProcessing()).toBe(false);
            r.device.setSoftwareVertexProcessing(true);
            const bank = r.device.getSwvpVertexConstants();
            expect(Array.from(bank.f.subarray(300 * 4, 300 * 4 + 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(bank.i[40 * 4]).toBe(7);
            expect(bank.b[100]).toBe(1);
        });
    });

    describe("several devices and an Ex device", () => {
        const makeSecond = async (r: Rig, create: string, parent: number): Promise<number> => {
            writePresentParams(r.mem, 0x4400, 32, 24, false);
            await ok(r, create, parent, 0, 1, 0x5000, 0x40, 0x4400, 0x4500);
            return r.u32(0x4500);
        };

        test("two devices keep their own objects and state", async () => {
            const { r, scene } = await sceneRig();
            const parent = (priv(r.device).stateTracker, deviceToD3D9.get(r.devicePtr)!);
            const second = await makeSecond(r, "IDirect3D9_CreateDevice", parent);
            expect(second).not.toBe(r.devicePtr);
            await ok(r, "IDirect3DDevice9_CreateTexture", second, 4, 4, 1, 0, 21, 1, 0x4600, 0);
            const secondTex = r.u32(0x4600);
            await ok(r, "IDirect3DDevice9_SetTexture", second, 0, secondTex);
            await ok(r, "IDirect3DDevice9_SetRenderState", second, 7, 0);
            await ok(r, "IDirect3DDevice9_SetRenderState", r.devicePtr, 7, 1);
            const { first, second: again } = await viaFreshWorker(r);
            expect(bytes(again.saved)).toBe(bytes(first.saved));
            expect((first.saved as any).devices.length).toBe(2);
            const restored = devices.get(second)!;
            expect(restored).not.toBe(devices.get(r.devicePtr));
            expect(restored.getBoundTexturePtr(0)).toBe(secondTex);
            expect(restored.getRenderState(7)).toBe(0);
            expect(devices.get(r.devicePtr)!.getRenderState(7)).toBe(1);
            expect(devices.get(r.devicePtr)!.getBoundTexturePtr(0)).toBe(scene.tex);
            expect(resourceToDevice.get(secondTex)).toBe(restored);
        });

        test("an Ex device is still Ex and its parent is still the Ex factory", async () => {
            const r = await rig({ device: false });
            await ok(r, "Direct3DCreate9Ex", 32, 0x4700);
            const parent = r.u32(0x4700);
            const exDevice = await makeSecond(r, "IDirect3D9Ex_CreateDevice", parent);
            r.devicePtr = exDevice;
            r.device = devices.get(exDevice)!;
            expect(r.device.isExtended).toBe(true);
            const { first, second } = await viaFreshWorker(r);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
            expect((first.saved as any).ex.devices).toEqual([exDevice]);
            expect((first.saved as any).ex.objects).toEqual([parent]);
            expect(devices.get(exDevice)!.isExtended).toBe(true);
            expect(isD3D9ExDevice(exDevice)).toBe(true);
        });
    });

    describe("a restored session keeps working", () => {
        test("every object can be released to zero and the registries empty out", async () => {
            const { r, scene } = await sceneRig();
            await buildExtras(r, scene);
            const first = await capture(r);
            const ram = snapshotRam(r);
            freshWorker(r, ram);
            await restoreInto(r, first.saved, first.graph);
            const live = liveComObjects();
            expect(live.length).toBeGreaterThan(30);
            for (let round = 0; round < 40 && liveComObjects().length > 0; round++) {
                for (const ptr of liveComObjects()) releaseComRef(ptr);
            }
            expect(liveComObjects()).toEqual([]);
            expect(devices.size).toBe(0);
            expect(textureMeta.size + surfaceMeta.size + vertexBufferMeta.size + indexBufferMeta.size + resourceToDevice.size + stateBlocks.size).toBe(0);
            expect(comRefTableSizes()).toEqual({ counts: 0, finalizers: 0, disposers: 0, bindings: 0, parents: 0 });
        });
    });

    describe("reference counting modes and state blocks in the arena", () => {
        const flags = globalThis as Record<string, unknown>;

        afterEach(() => {
            delete flags.__d3d9InternalBindingRefs;
            delete flags.__d3d9MirrorRefcount;
            unpinGuestRefcountStoreForTests();
        });

        test("bindings held as internal references, one object released to a public zero while bound", async () => {
            flags.__d3d9InternalBindingRefs = true;
            const { r, scene } = await sceneRig();
            await r.call("IDirect3DTexture9_Release", scene.tex);
            await r.call("IDirect3DTexture9_Release", scene.tex);
            expect(getComRefCount(scene.tex)).toBe(0);
            const statsBefore = d3d9BindingRefStats();
            expect(statsBefore.pendingDestruction).toBeGreaterThanOrEqual(1);
            const { first, second } = await viaFreshWorker(r);
            const refs = (first.saved as any).refs;
            expect(refs.bindings.length).toBeGreaterThan(3);
            expect(refs.counts.find((c: number[]) => c[0] === scene.tex)![1]).toBe(0);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
            expect(getComRefCount(scene.tex)).toBe(0);
            expect(d3d9BindingRefStats()).toEqual(statsBefore);
            await r.call("IDirect3DDevice9_SetTexture", r.devicePtr, 0, 0);
            expect(getComRefCount(scene.tex)).toBe(0);
            await r.call("IDirect3DStateBlock9_Release", scene.allBlock);
            expect(getComRefCount(scene.tex)).toBeUndefined();
        });

        test("the JS table as the count of record", async () => {
            flags.__d3d9MirrorRefcount = true;
            const { r } = await sceneRig();
            const { first, second } = await viaFreshWorker(r);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
        });

        test("a block recorded into an arena slot is saved with the values the slot holds now", async () => {
            const { r } = await sceneRig();
            const block = stateBlocks.get((await (async () => { await ok(r, "IDirect3DDevice9_CreateStateBlock", r.devicePtr, 1, 0x6000); return r.u32(0x6000); })()))!;
            block.wasmSlot = 2;
            block.handleEntries = [{ op: "vertexShader", handle: 0x4321 }, { op: "texture", stage: 1, texPtr: 0x8765 }];
            block.entries = [
                { op: "renderState", state: 7, value: 1 },
                { op: "samplerState", sampler: 0, type: 5, value: 1 },
                { op: "vertexShaderConstantF", start: 3, data: new Float32Array([9, 9, 9, 9]) },
                { op: "vertexShaderConstantF", start: 9, data: new Float32Array([8, 8]) },
                { op: "pixelShaderConstantF", start: 1, data: new Float32Array([7, 7, 7, 7]) },
                { op: "vertexShader", handle: 0x1111 },
                { op: "texture", stage: 1, texPtr: 0x2222 },
            ];
            const rs = new Int32Array(256);
            rs[7] = 3;
            const samp = new Int32Array(16);
            samp[5] = 2;
            const pool = new Float32Array(512);
            pool.set([1, 2, 3, 4, 5, 6], 0);
            pool.set([10, 11, 12, 13], 6);
            const vsRanges = new Uint16Array(8);
            vsRanges.set([3, 4, 9, 2]);
            const psRanges = new Uint16Array(8);
            psRanges.set([1, 4]);
            const original = d3d9WasmArena.blockSlotViews;
            d3d9WasmArena.blockSlotViews = (() => ({ maskRs: new Uint32Array(8), maskSamp: new Uint32Array(1), vsRanges, psRanges, rsValues: rs, sampValues: samp, constPool: pool })) as never;
            try {
                const entries = materializedBlockEntries(block);
                expect(entries).toEqual([
                    { op: "renderState", state: 7, value: 3 },
                    { op: "samplerState", sampler: 0, type: 5, value: 2 },
                    { op: "vertexShaderConstantF", start: 3, data: new Float32Array([1, 2, 3, 4]) },
                    { op: "vertexShaderConstantF", start: 9, data: new Float32Array([5, 6]) },
                    { op: "pixelShaderConstantF", start: 1, data: new Float32Array([10, 11, 12, 13]) },
                    { op: "vertexShader", handle: 0x4321 },
                    { op: "texture", stage: 1, texPtr: 0x8765 },
                ]);
            } finally {
                d3d9WasmArena.blockSlotViews = original;
            }
        });
    });

    describe("the device cursor", () => {
        test("shape, visibility and position come back for the device that owns them", async () => {
            const { r } = await sceneRig();
            await ok(r, "IDirect3DDevice9_CreateOffscreenPlainSurface", r.devicePtr, 32, 32, 21, 2, 0x6000, 0);
            const surface = r.u32(0x6000);
            await ok(r, "IDirect3DSurface9_LockRect", surface, 0x6100, 0, 0);
            r.mem.fill(0x33, r.u32(0x6104), r.u32(0x6104) + 32 * 32 * 4);
            await ok(r, "IDirect3DSurface9_UnlockRect", surface);
            await ok(r, "IDirect3DDevice9_SetCursorProperties", r.devicePtr, 3, 4, surface);
            await r.call("IDirect3DDevice9_ShowCursor", r.devicePtr, 1);
            await r.call("IDirect3DDevice9_SetCursorPosition", r.devicePtr, 40, 50, 0);
            const before = captureDeviceCursors();
            expect(before.cursors.length).toBe(1);
            expect(before.cursors[0]).toMatchObject({ visible: true, x: 40, y: 50 });
            const { first, second } = await viaFreshWorker(r);
            expect(bytes(second.saved)).toBe(bytes(first.saved));
            expect((first.saved as any).cursors.cursors[0].devicePtr).toBe(r.devicePtr);
            expect(captureDeviceCursors()).toEqual(before);
        });
    });
}
