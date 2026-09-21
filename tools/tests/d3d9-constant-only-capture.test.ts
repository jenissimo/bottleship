import { afterEach, describe, expect, test } from 'bun:test';
import { D3D9Device, programmableSnapshotsEqual } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
import { RenderFrame, RenderFramePool, RenderCommandType } from '../../src/worker/backends/webgpu/render-frame';
import { D3D9CommandRecorder } from '../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder';
import { getD3D9PerfSnapshot, resetD3D9Perf } from '../../src/worker/modules/d3d9/d3d9-perf';

const flags = globalThis as typeof globalThis & {
    __d3d9ConstOnlyCapture?: boolean;
    __d3d9VerifyConstOnlyCapture?: boolean;
};
afterEach(() => { delete flags.__d3d9ConstOnlyCapture; delete flags.__d3d9VerifyConstOnlyCapture; });

// Exercise the real full gather and candidate on CPU-side GPU-object identities.
// Only the external resource resolver and backing device are replaced; bank packing,
// snapshots, hashes, elision, frame pool and candidate guards are production code.
function fixture(bump = false, relative = false) {
    const frame = new RenderFrame();
    const vs = { analysis: { constantCount: relative ? 256 : 4 }, prog: { usesRelativeConst: relative } };
    const ps = { analysis: { constantCount: 4, usesLegacyBumpEnv: bump }, prog: { major: 2 } };
    const views = [{}, {}], samplers = Array.from({ length: 20 }, () => ({}));
    const rs = new Map<number, number>([[34, 0xff123456], [36, 0x3f800000], [37, 0x41200000], [38, 0x3f000000]]);
    const stages = new Map<number, number>();
    const d: any = Object.create(D3D9Device.prototype);
    Object.assign(d, {
        lastCaptureIndex: -1, stageWindowEpoch: 0, stageWindowBankGen: -1,
        pipelineStateGeneration: 1, samplerStateGeneration: 1, arenaSamplerBankGeneration: 1,
        attachmentGeneration: 1, gpuResourceGeneration: 1, activeVertexDecl: 1,
        vsConstantsVersion: 1, psConstantsVersion: 1,
        viewport: { width: 640, height: 480 }, scale: 1,
        vsConstants: new Float32Array(1024), psConstants: new Float32Array(896),
        vsIntegerBits: new Uint32Array(64), psIntegerBits: new Uint32Array(64),
        vsBooleanMask: 0, psBooleanMask: 0, ffpFogColor: { r: 0, g: 0, b: 0, a: 0 },
        clipPlanes: new Map([[0, new Float32Array([1, 2, 3, 4])]]),
        stageWindowTextures: Array(16).fill(null), stageWindowSamplers: Array(16).fill(null),
        stageWindowVertexTextures: Array(4).fill(null), stageWindowVertexSamplers: Array(4).fill(null),
        stageWindowSrcTex: new Int32Array(16), stageWindowSrcView: Array(16).fill(null),
        commandRecorder: { getCurrentFrame: () => frame },
        getActiveVsShader: () => vs, getActivePsShader: () => ps,
        activeRenderScale: () => d.scale, activeDeclIsPreTransformed: () => false,
        getCurrentTargetSize: () => ({ w: 640, h: 480 }),
        getRS: (k: number) => rs.get(k) ?? 0,
        stateTracker: { getRenderState: (k: number) => rs.get(k) ?? 0, getTexture: (i: number) => i < 2 ? i : null },
        getTextureStageState: (s: number, k: number) => stages.get(s * 256 + k) ?? 0,
        boundComparisonSamplers: () => new Map(), boundCubeMask: () => 0,
        boundVolumeMask: () => 0, boundVertexVolumeMask: () => 0,
        resolveFragmentStageView: (s: number) => views[s] ?? null,
        resolveStageSampler: (s: number) => samplers[s < 16 ? s : s - 241],
        textures: { getView: (i: number) => views[i] }, isVolumeIndex: () => false,
        fragmentStageInputsUnchanged: () => false,
        bankHashCacheFor: () => null, integerHashCacheFor: () => null,
    });
    d.vsConstantBits = new Uint32Array(d.vsConstants.buffer);
    d.psConstantBits = new Uint32Array(d.psConstants.buffer);
    d._rsF32 = new Float32Array(1); d._rsU32 = new Uint32Array(d._rsF32.buffer);
    return { d, frame, rs, stages, views, vs, ps };
}

describe('constant-only snapshot', () => {
    test('matches the full path for float/int/bool updates, fog, bump and clip tails; preserves previous draws', () => {
        for (const bump of [false, true]) for (const relative of [false, true]) {
            resetD3D9Perf(); flags.__d3d9ConstOnlyCapture = true; flags.__d3d9VerifyConstOnlyCapture = true;
            const { d, frame, rs, stages } = fixture(bump, relative);
            rs.set(152, 1); stages.set(7, 0x3f400000);
            const first = d.captureDrawState();
            const initialVs = frame.drawStates[first]!.vsBits.slice();
            const initialPs = frame.drawStates[first]!.psBits.slice();
            for (let i = 0; i < 12; i++) {
                // Preserve raw NaN payloads and signed zero; numeric equality cannot check this.
                const bits = [0x7fc01234, 0x80000000, 0x3f800000, 0xff800000][i % 4]!;
                if (i % 3 !== 1) {
                    d.vsConstantBits[relative ? 900 : 0] = bits;
                    d.vsIntegerBits[3] = i * 17; d.vsBooleanMask = 1 << i; d.vsConstantsVersion++;
                }
                if (i % 3 !== 0) {
                    d.psConstantBits[0] = bits;
                    d.psIntegerBits[1] = i * 19; d.psBooleanMask = 1 << i; d.psConstantsVersion++;
                }
                d.captureDrawState();
                expect(frame.drawStates[first]!.vsBits).toEqual(initialVs);
                expect(frame.drawStates[first]!.psBits).toEqual(initialPs);
            }
            expect(getD3D9PerfSnapshot().backend.captureConstOnlyChecked).toBe(12);
            expect(getD3D9PerfSnapshot().backend.captureConstOnlyMismatch).toBe(0);
            expect(frame.drawStateCount).toBe(13); // oracle scratch never becomes a draw slot
        }
    });

    test('material, resource, target, declaration, scale and frame changes decline reuse', () => {
        for (const key of ['pipelineStateGeneration', 'samplerStateGeneration', 'arenaSamplerBankGeneration',
            'attachmentGeneration', 'gpuResourceGeneration', 'activeVertexDecl', 'scale', 'frame', 'viewport']) {
            resetD3D9Perf(); flags.__d3d9ConstOnlyCapture = true;
            const { d, frame } = fixture(); d.captureDrawState();
            d.vsConstantBits[0] = 0x3f800000; d.vsConstantsVersion++;
            if (key === 'frame') { frame.reset(); d.lastCaptureIndex = -1; }
            else if (key === 'viewport') d.viewport.width++;
            else d[key]++;
            d.captureDrawState();
            expect({ key, hits: getD3D9PerfSnapshot().backend.captureConstOnlyHits }).toEqual({ key, hits: 0 });
        }
    });

    test('disabled arm stays on full capture and preserves snapshot equality and slot counts', () => {
        resetD3D9Perf();
        const { d, frame } = fixture(true);
        d.captureDrawState(); d.vsConstantsVersion++; d.vsConstantBits[0] = 17;
        const normal = d.captureDrawState();
        const reference = d.captureDrawState(true);
        expect(reference).toBe(normal);
        expect(programmableSnapshotsEqual(frame.drawStates[normal]!, frame.drawStates[reference]!)).toBe(true);
        expect(frame.drawStateCount).toBe(2);
        expect(getD3D9PerfSnapshot().backend.captureConstOnlyHits).toBe(0);
    });

    test('shader rebinding, enabling after a full capture, and zero-size viewport use the full path', () => {
        for (const kind of ['vs', 'ps', 'enable', 'zero-viewport']) {
            resetD3D9Perf(); flags.__d3d9ConstOnlyCapture = kind !== 'enable';
            const { d, vs, ps } = fixture();
            if (kind === 'zero-viewport') d.viewport.width = 0;
            d.captureDrawState();
            if (kind === 'vs') { const other = { ...vs }; d.getActiveVsShader = () => other; }
            if (kind === 'ps') { const other = { ...ps }; d.getActivePsShader = () => other; }
            flags.__d3d9ConstOnlyCapture = true;
            d.vsConstantBits[0] = 9; d.vsConstantsVersion++;
            d.captureDrawState();
            expect({ kind, hits: getD3D9PerfSnapshot().backend.captureConstOnlyHits }).toEqual({ kind, hits: 0 });
        }
    });

    test('the oracle rejects bad bits even with an unchanged hash, and different resource identities', () => {
        const { d, frame } = fixture(); const index = d.captureDrawState();
        const a = frame.drawStates[index]!;
        const b = { ...a, vsBits: a.vsBits.slice(), textures: [...a.textures] };
        b.vsBits[0] ^= 1; expect(programmableSnapshotsEqual(a, b)).toBe(false);
        b.vsBits[0] ^= 1; b.textures[0] = {} as GPUTextureView;
        expect(programmableSnapshotsEqual(a, b)).toBe(false);
    });

    test('both arms record the same twelve indexed draws, arguments and query boundaries', () => {
        function transcript(enabled: boolean) {
            flags.__d3d9ConstOnlyCapture = enabled;
            const { d } = fixture();
            const recorder = new D3D9CommandRecorder(new RenderFramePool());
            d.commandRecorder = recorder;
            const vb = {} as GPUBuffer, ib = {} as GPUBuffer;
            recorder.recordBeginOcclusionQuery(123);
            for (let i = 0; i < 12; i++) {
                d.vsConstantBits[0] = i; d.vsConstantsVersion++;
                recorder.recordDrawIndexed({
                    pipelineId: 7, vbGpuBuffer: vb, vbOffset: 0, vbSize: 1024,
                    ibGpuBuffer: ib, ibFormat: 'uint16', indexCount: 3, startIndex: i * 3,
                    baseVertex: 0, bindStateIndex: d.captureDrawState(),
                });
            }
            recorder.recordEndOcclusionQuery(123);
            const frame = recorder.getCurrentFrame();
            expect(frame.commandTypes.filter(x => x === RenderCommandType.DrawIndexed)).toHaveLength(12);
            expect(recorder.getIndexedDrawsRecorded()).toBe(12);
            expect(frame.drawStateCount).toBe(12);
            return { types: frame.commandTypes, a: frame.commandA, b: frame.commandB,
                c: frame.commandC, d: frame.commandD,
                vs: frame.drawStates.map(s => Array.from(s.vsBits.subarray(0, s.vsLen))),
                ps: frame.drawStates.map(s => Array.from(s.psBits.subarray(0, s.psLen))) };
        }
        expect(transcript(true)).toEqual(transcript(false));
    });

    test('live verification fails loudly on a deliberately stale material reference', () => {
        flags.__d3d9ConstOnlyCapture = true; flags.__d3d9VerifyConstOnlyCapture = true;
        const { d, frame } = fixture(); const i = d.captureDrawState();
        frame.drawStates[i]!.textures[0] = {} as GPUTextureView; // stale cached answer injected
        d.vsConstantBits[0] = 7; d.vsConstantsVersion++;
        expect(() => d.captureDrawState()).toThrow('differs from full snapshot');
    });
});
