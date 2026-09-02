import { describe, expect, test } from "bun:test";
import {
    arenaPipelineCacheBucket,
    ArenaPipelineIdentityBuilder,
    buildArenaPipelineIdentity,
    hashArenaPipelineIdentity,
    D3D9_ARENA_PIPELINE_IDENTITY_WORDS,
} from "../../src/worker/backends/webgpu/d3d9/arena-pipeline-identity";
import { D3D9CommandRecorder } from "../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder";
import { RenderCommandType, RenderFramePool } from "../../src/worker/backends/webgpu/render-frame";
import { StreamBindingPlan } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import {
    arenaSupportsFragmentSamplerBank,
    arenaSupportsVertexSamplerBank,
    D3D9_ARENA_COMPACT_RUN_HEADER_WORDS,
    D3D9_ARENA_DRAW_STATE_HEADER_BYTES,
    D3D9_ARENA_PS_CONST_FLOATS,
    D3D9_ARENA_SHADER_HANDLE_SLOTS,
    D3D9_ARENA_VS_CONST_FLOATS,
    d3d9WasmArena,
    isValidArenaTruncateTarget,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-wasm-arena";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("D3D9 WASM arena pipeline identity", () => {
    test("publishes the non-layout descriptor ABI as named constants", () => {
        expect(D3D9_ARENA_SHADER_HANDLE_SLOTS).toBe(1024);
        expect(D3D9_ARENA_VS_CONST_FLOATS).toBe(256 * 4);
        expect(D3D9_ARENA_PS_CONST_FLOATS).toBe(224 * 4);
        expect(D3D9_ARENA_DRAW_STATE_HEADER_BYTES).toBe(128);
        expect(D3D9_ARENA_COMPACT_RUN_HEADER_WORDS).toBe(10);
        expect(D3D9_ARENA_DRAW_STATE_HEADER_BYTES % 4).toBe(0);
    });

    test("is fixed width and changes when any canonical cache field changes", () => {
        const fields = {
            shader: "vs7:ps11:decl3",
            fvf: ":fvf0",
            state: ":full1:bits2:toptriangle-list:fc0",
            point: ":pe0:psp0:cp0",
            blend: ":blb:atat:depdepth24",
            masks: ":cm0:dm0:dc:vm0:vvm0",
            projection: ":pj0:hs0",
            sampler: ":samstage0",
            target: ":rtRGBA8",
            streams: ":smask1:sh32:slot0=32",
        };
        const base = buildArenaPipelineIdentity(fields);
        expect(base.words.length).toBe(D3D9_ARENA_PIPELINE_IDENTITY_WORDS);
        for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
            const changed = buildArenaPipelineIdentity({ ...fields, [field]: `${fields[field]}:changed` });
            expect(Array.from(changed.words)).not.toEqual(Array.from(base.words));
        }
    });

    test("publishes the identity verbatim: textures are not pipeline identity", () => {
        // Rust hashes EVERY identity word into derive_pipeline_key. Folding the bind-group
        // key into a lane spread one GPURenderPipeline across a cache bucket per texture set,
        // while Rust's draw-state memo already compares LAST_DRAW_STATE_BIND_GROUP_KEY itself.
        // Run the method against a stand-in receiver: the real arena needs a live wasm module.
        const setPipelineIdentity = (Object.getPrototypeOf(d3d9WasmArena) as {
            setPipelineIdentity(this: unknown, words: ArrayLike<number>): void;
        }).setPipelineIdentity;
        const receiver = {
            ensureFresh(): void { /* views are supplied below */ },
            pipelineIdentity: new Uint32Array(D3D9_ARENA_PIPELINE_IDENTITY_WORDS),
            samplerStage0: new Int32Array(16),
            textureBoundIds: new Uint32Array(8),
            textureCubeFlags: new Uint8Array(4096),
        };
        receiver.textureBoundIds[0] = 7; // a bound texture must not perturb the identity
        const words = hashArenaPipelineIdentity("same-pipeline");
        const before = Array.from(words);

        setPipelineIdentity.call(receiver, words);

        expect(Array.from(receiver.pipelineIdentity)).toEqual(before);
        // And it must not write back through the caller's array — the device retains that
        // Uint32Array and rebuilds an identity around it for every draw of the state run.
        expect(Array.from(words)).toEqual(before);
    });

    test("finish() hands out a copy, not the builder's live lanes", () => {
        const builder = new ArenaPipelineIdentityBuilder().append("a");
        const first = builder.finish();
        const snapshot = Array.from(first.words);
        builder.append("b");
        expect(Array.from(first.words)).toEqual(snapshot);
    });

    test("rejects truncate targets that would grow either arena cursor", () => {
        expect(isValidArenaTruncateTarget(10, 100, 9, 96, 16, 128)).toBe(true);
        expect(isValidArenaTruncateTarget(10, 100, 11, 96, 16, 128)).toBe(false);
        expect(isValidArenaTruncateTarget(10, 100, 9, 101, 16, 128)).toBe(false);
        expect(isValidArenaTruncateTarget(10, 100, 17, 96, 16, 128)).toBe(false);
    });

    test("cache bucket retains compact hash and full identity", () => {
        const words = hashArenaPipelineIdentity("same");
        const fingerprint = Array.from(words, word => word.toString(16).padStart(8, "0")).join("");
        expect(arenaPipelineCacheBucket(0x12345678, fingerprint)).toBe(`305419896:${fingerprint}`);
        expect(arenaPipelineCacheBucket(0x12345678, "0".repeat(16))).not.toBe(
            arenaPipelineCacheBucket(0x12345678, fingerprint),
        );
    });

    test("keeps unsupported sampler banks on the safe fallback path", () => {
        expect(arenaSupportsFragmentSamplerBank([0, 7], () => false)).toBe(true);
        expect(arenaSupportsFragmentSamplerBank([8], () => false)).toBe(false);
        expect(arenaSupportsVertexSamplerBank([])).toBe(true);
        expect(arenaSupportsVertexSamplerBank([0])).toBe(false);
    });

    test("links an arena row to the exact frame draw and clears it with frame reuse", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool(2));
        const streams = new StreamBindingPlan();
        streams.add(0, {} as GPUBuffer, 0, 64);
        recorder.recordDraw({
            pipelineId: 7,
            streams,
            vertexCount: 3,
            startVertex: 0,
            bindStateIndex: 2,
        });
        recorder.recordArenaBinding({
            arenaDrawCommand: 4,
            arenaPipelineKey: 0xdeadbeef,
            pipelineId: 7,
            bindStateIndex: 2,
            arenaCommandType: 3,
        });
        const frame = recorder.finalize();
        expect(frame.commandTypes.at(-1)).toBe(RenderCommandType.Draw);
        expect(frame.arenaDrawBindings).toEqual([{
            frameDrawCommand: frame.commandTypes.length - 1,
            arenaDrawCommand: 4,
            arenaPipelineKey: 0xdeadbeef,
            pipelineId: 7,
            bindStateIndex: 2,
            arenaCommandType: 3,
        }]);
        frame.reset();
        expect(frame.arenaDrawBindings).toHaveLength(0);
    });

    test("forces a normal programmable rebind after an opaque arena run", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool(2));
        const streams = new StreamBindingPlan();
        const buffer = {} as GPUBuffer;
        streams.add(0, buffer, 0, 64);
        recorder.recordDrawIndexedArenaRun({
            pipelineId: 7,
            streams,
            ibGpuBuffer: buffer,
            ibFormat: "uint16",
            bindStateIndex: 2,
            arenaCommandStart: 0,
            arenaCommandEnd: 4,
            pairCount: 2,
        });
        recorder.recordDrawIndexed({
            pipelineId: 7,
            streams,
            ibGpuBuffer: buffer,
            ibFormat: "uint16",
            bindStateIndex: 2,
            indexCount: 3,
            startIndex: 0,
            baseVertex: 0,
        });

        const frame = recorder.finalize();
        const runAt = frame.commandTypes.indexOf(RenderCommandType.DrawIndexedArenaRun);
        expect(runAt).toBeGreaterThanOrEqual(0);
        expect(frame.commandTypes.slice(runAt + 1)).toContain(RenderCommandType.BindProgrammable);
    });

    test("clears cube metadata when a TextureStore slot is destroyed and recycled", () => {
        const calls: Array<[number, boolean]> = [];
        const original = d3d9WasmArena.markTextureCube;
        d3d9WasmArena.markTextureCube = (textureId: number, isCube: boolean): void => {
            calls.push([textureId, isCube]);
        };
        try {
            const store = new TextureStore(1);
            const first = store.create(101, 1, 1, 1, 21, 0x1000);
            expect(store.release(101)).not.toBeNull();
            const second = store.create(102, 1, 1, 1, 21, 0x2000);
            expect(second).toBe(first);
            expect(calls).toEqual([[1, false], [1, false], [1, false]]);
        } finally {
            d3d9WasmArena.markTextureCube = original;
        }
    });
});

describe("arena recording on the last-resolve fast path", () => {
    test("is not gated on the sampler-bank generation", () => {
        // arenaSamplerBankGeneration bumps on EVERY SetTexture, while the last-resolve memo's
        // copy was refreshed only on the slow path — so the canonical "one state, a different
        // texture per object" run recorded draw 1 and nothing after it. The identity carries no
        // texture state (see above), so there is nothing for such a gate to protect.
        const device = readFileSync(join(import.meta.dir, "..", "..", "src", "worker",
            "backends", "webgpu", "d3d9", "d3d9-device.ts"), "utf8");
        expect(device.includes("_lrArenaSamplerGeneration")).toBe(false);
    });
});
