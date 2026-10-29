/**
 * A declaration-only D3D8 vertex shader paired with a pixel shader runs fixed-function
 * vertex processing into the programmable pixel stage (Unreal Engine 2's terrain:
 * camera-space texgen + texture matrices feeding a ps_1_1 layer blend). The synthesized
 * vs_1_1 must reproduce that processing; it is executed here by a small reference
 * interpreter and compared against the fixed-function math directly.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultMaterial } from "../../src/worker/modules/ddraw/d3d/types";
import type { WebGPUBackend } from "../../src/worker/backends/webgpu/webgpu-backend";
import type { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import type { RawVertexElement } from "../../src/worker/backends/webgpu/d3d9/shader";
import {
    describeDeclInputs,
    ffpProjectedMask,
    ffpVertexFogOutput,
    FFP_FOG_OUT_NONE,
    FFP_FOG_OUT_SPECULAR,
    FFP_SYNTH_CONSTANT_COUNT,
    FFP_SYNTH_POSITION,
    FFP_SYNTH_LIGHTING,
    synthesizeFfpVertexShader,
    writeFfpVertexConstants,
    type FfpVertexSpec,
} from "../../src/worker/backends/webgpu/d3d8/ffp-vertex-synth";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";
import { generateMegaBatchShaderCode, generateShaderCode } from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { DEFAULT_DEBUG_FLAGS } from "../../src/worker/backends/webgpu/ddraw/types";
import { D3D_TRANSFORM_POSITION_WGSL } from "../../src/worker/backends/webgpu/shared/d3d-position";
import { writeMvpWithPixelCenter } from "../../src/worker/backends/webgpu/pixel-center";
import { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { D3D8ProgrammableRenderer } from "../../src/worker/backends/webgpu/d3d8/d3d8-programmable-draw";
import { D3D8ShaderRegistry } from "../../src/worker/backends/webgpu/d3d8/d3d8-shader-registry";

type Vec4 = [number, number, number, number];

/** Executes the instruction subset the synthesizer emits (vs_1_1 MOV/ADD/MUL/MAD/MAX/RSQ/RCP/EXP/DP3/DP4). */
function runVs(tokens: Uint32Array, inputs: Map<number, Vec4>, constants: Float32Array) {
    const temps = new Map<number, Vec4>();
    const outputs = new Map<string, Vec4>();
    const regType = (t: number) => ((t >>> 28) & 0x7) | (((t >>> 11) & 0x3) << 3);
    const read = (t: number): Vec4 => {
        const type = regType(t), num = t & 0x7ff;
        const v: Vec4 = type === RegType.INPUT ? (inputs.get(num) ?? [0, 0, 0, 1])
            : type === RegType.CONST ? [0, 1, 2, 3].map(i => constants[num * 4 + i]!) as Vec4
            : (temps.get(num) ?? [0, 0, 0, 0]);
        const swz = (t >>> 16) & 0xff;
        const negate = ((t >>> 24) & 0xf) === 1;
        return [0, 1, 2, 3].map(i => (negate ? -1 : 1) * v[(swz >>> (i * 2)) & 3]!) as Vec4;
    };
    const write = (t: number, value: Vec4): void => {
        const type = regType(t), num = t & 0x7ff, mask = (t >>> 16) & 0xf;
        const key = `${type}:${num}`;
        const prev = type === RegType.TEMP ? (temps.get(num) ?? [0, 0, 0, 0]) : (outputs.get(key) ?? [0, 0, 0, 0]);
        const next = prev.map((p, i) => (mask >> i) & 1 ? value[i]! : p) as Vec4;
        if (type === RegType.TEMP) temps.set(num, next); else outputs.set(key, next);
    };
    const dot = (a: Vec4, b: Vec4, n: number) => a.slice(0, n).reduce((s, x, i) => s + x * b[i]!, 0);
    const splat = (r: number): Vec4 => [r, r, r, r];
    let i = 1;
    while (i < tokens.length) {
        const op = tokens[i++]! & 0xffff;
        if (op === Op.END) break;
        const d = tokens[i++]!;
        const a = read(tokens[i++]!);
        if (op === Op.MOV) { write(d, a); continue; }
        if (op === Op.RSQ) { write(d, splat(1 / Math.sqrt(Math.abs(a[0])))); continue; }
        if (op === Op.RCP) { write(d, splat(1 / a[0])); continue; }
        if (op === Op.EXP) { write(d, splat(2 ** a[0])); continue; }
        const b = read(tokens[i++]!);
        if (op === Op.MAD) { const c = read(tokens[i++]!); write(d, a.map((x, k) => x * b[k]! + c[k]!) as Vec4); continue; }
        if (op === Op.MUL) write(d, a.map((x, k) => x * b[k]!) as Vec4);
        else if (op === Op.ADD) write(d, a.map((x, k) => x + b[k]!) as Vec4);
        else if (op === Op.MAX) write(d, a.map((x, k) => Math.max(x, b[k]!)) as Vec4);
        else if (op === Op.DP3) write(d, splat(dot(a, b, 3)));
        else if (op === Op.DP4) write(d, splat(dot(a, b, 4)));
        else throw new Error(`unexpected opcode ${op}`);
    }
    return {
        pos: outputs.get(`${RegType.RASTOUT}:0`),
        fog: outputs.get(`${RegType.RASTOUT}:1`),
        d0: outputs.get(`${RegType.ATTROUT}:0`),
        d1: outputs.get(`${RegType.ATTROUT}:1`),
        t: (n: number) => outputs.get(`${RegType.TEXCRDOUT}:${n}`),
    };
}

/** Row-vector product v × M against a row-major D3D matrix. */
function mulRow(v: Vec4, m: number[]): Vec4 {
    return [0, 1, 2, 3].map(c => v[0] * m[c]! + v[1] * m[4 + c]! + v[2] * m[8 + c]! + v[3] * m[12 + c]!) as Vec4;
}

const WORLD_VIEW = [
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    10, -20, 300, 1,
];
const MVP = [
    0.5, 0, 0, 0,
    0, 0.75, 0, 0,
    0, 0, 1.001, 1,
    3, 4, -1, 0,
];
const LAYER_MATRIX = [
    1 / 256, 0, 0, 0,
    0, 1 / 512, 0, 0,
    0.25, 0, 0, 0,
    0.125, 0.5, 0, 1,
];

function closeTo(actual: Vec4 | undefined, expected: Vec4): void {
    expect(actual).toBeDefined();
    for (let i = 0; i < 4; i++) expect(actual![i]!).toBeCloseTo(expected[i]!, 4);
}

const fbits = (x: number) => new Int32Array(new Float32Array([x]).buffer)[0]!;

// Unreal Engine 2 D3DDrv's terrain blend (its source ships as text inside D3DDrv.dll).
function terrainPs11(): Uint32Array {
    const reg = (type: number, num: number) => (0x80000000 | ((type & 7) << 28) | (((type >> 3) & 3) << 11) | num) >>> 0;
    const dst = (type: number, num: number, shift = 0) => (reg(type, num) | (0xf << 16) | (shift << 24)) >>> 0;
    const src = (type: number, num: number) => (reg(type, num) | (0xe4 << 16)) >>> 0;
    const T = RegType.TEXTURE, R = RegType.TEMP, C = RegType.CONST, V = RegType.INPUT;
    return new Uint32Array([
        0xffff0101,
        Op.DEF, dst(C, 0), fbits(1), fbits(0), fbits(0), fbits(0),
        Op.DEF, dst(C, 1), fbits(0), fbits(1), fbits(0), fbits(0),
        Op.DEF, dst(C, 2), fbits(0), fbits(0), fbits(1), fbits(0),
        Op.TEX, dst(T, 0), Op.TEX, dst(T, 1), Op.TEX, dst(T, 2), Op.TEX, dst(T, 3),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 0),
        Op.MUL, dst(R, 0), src(T, 1), src(R, 1),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 1),
        Op.MAD, dst(R, 0), src(T, 2), src(R, 1), src(R, 0),
        Op.DP3, dst(R, 1), src(T, 0), src(C, 2),
        Op.MAD, dst(R, 0), src(T, 3), src(R, 1), src(R, 0),
        Op.MUL, dst(R, 0, 1), src(R, 0), src(V, 0),
        Op.END,
    ].map(v => v >>> 0));
}

// The terrain declaration UE2 creates: position+normal, diffuse and UV on three streams.
const TERRAIN_DECL: RawVertexElement[] = [
    { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0, reg: 0 },
    { stream: 0, offset: 12, type: 2, usage: 3, usageIndex: 0, reg: 3 },
    { stream: 1, offset: 0, type: 4, usage: 10, usageIndex: 0, reg: 5 },
    { stream: 2, offset: 0, type: 1, usage: 5, usageIndex: 0, reg: 7 },
];

function terrainSpec(): FfpVertexSpec {
    const inputs = describeDeclInputs(TERRAIN_DECL);
    return {
        hasDiffuse: inputs.hasDiffuse,
        hasSpecular: inputs.hasSpecular,
        hasNormal: inputs.hasNormal,
        normalizeNormals: false,
        texcoordComponents: inputs.texcoordComponents,
        texcoords: [
            { output: 0, mode: 0, set: 0, transformFlags: 0 },
            { output: 1, mode: 2, set: 0, transformFlags: 2 },
            { output: 2, mode: 2, set: 0, transformFlags: 2 },
            { output: 3, mode: 2, set: 0, transformFlags: 2 },
        ],
        fog: FFP_FOG_OUT_NONE,
        rangeFog: false,
    };
}

const D3DTS_WORLD = 256;
const D3DTS_TEXTURE0 = 16;

/** The adapter state writeFfpVertexConstants reads: WORLD_VIEW as the world matrix. */
function stateFor(
    texMatrix: (stage: number) => number[] | null,
    world: number[] = WORLD_VIEW,
    renderStates = new Int32Array(256),
) {
    return {
        renderStates,
        getMVP: () => new Float32Array(MVP),
        getTransform: (type: number) => {
            if (type === D3DTS_WORLD) return new Float32Array(world);
            const stage = type - D3DTS_TEXTURE0;
            const m = stage >= 0 && stage < 8 ? texMatrix(stage) : null;
            return m ? new Float32Array(m) : null;
        },
    };
}

// A zero-size viewport folds no pixel centre, so c0-c3 hold the MVP rows unchanged.
function constantsFor(
    texMatrix: (stage: number) => number[] | null,
    viewport = { width: 0, height: 0 },
    world: number[] = WORLD_VIEW,
    renderStates?: Int32Array,
): Float32Array {
    const bank = new Float32Array(FFP_SYNTH_CONSTANT_COUNT * 4);
    writeFfpVertexConstants(bank, stateFor(texMatrix, world, renderStates), viewport.width, viewport.height);
    return bank;
}

describe("D3D8 fixed-function vertex stage synthesis", () => {
    test("transforms position, passes colours and generates camera-space texcoords", () => {
        const tokens = synthesizeFfpVertexShader(terrainSpec());
        const pos: Vec4 = [100, 200, -50, 1];
        const diffuse: Vec4 = [0.2, 0.4, 0.6, 1];
        const uv: Vec4 = [0.25, 0.75, 0, 1];
        const out = runVs(tokens, new Map([[0, pos], [5, diffuse], [7, uv]]),
            constantsFor(stage => (stage >= 1 && stage <= 3 ? LAYER_MATRIX : null)));

        closeTo(out.pos, mulRow(pos, MVP));
        closeTo(out.d0, diffuse);
        closeTo(out.d1, [0, 0, 0, 0]);
        closeTo(out.t(0), uv);
        expect(out.fog).toBeUndefined();
        const camera = mulRow(pos, WORLD_VIEW);
        const expected = mulRow([camera[0], camera[1], camera[2], 1], LAYER_MATRIX);
        for (const stage of [1, 2, 3]) closeTo(out.t(stage), expected);
    });

    test("a missing vertex colour is opaque white, as fixed-function supplies it", () => {
        const spec = terrainSpec();
        spec.hasDiffuse = false;
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [0, 0, 0, 1] as Vec4]]), constantsFor(() => null));
        closeTo(out.d0, [1, 1, 1, 1]);
    });

    test("a transformed 2D coordinate is padded so the third matrix row translates it", () => {
        const spec = terrainSpec();
        spec.texcoords = [{ output: 0, mode: 0, set: 0, transformFlags: 2 }];
        const uv: Vec4 = [0.5, 0.25, 0, 1];
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [0, 0, 0, 1] as Vec4], [7, uv]]),
            constantsFor(stage => (stage === 0 ? LAYER_MATRIX : null)));
        closeTo(out.t(0), mulRow([0.5, 0.25, 1, 0], LAYER_MATRIX));
    });

    test("camera-space normals use the inverse-transpose of world×view", () => {
        // Non-uniform scale: world×view itself would tilt the normal of a sheared surface.
        const world = [
            2, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 0.5, 0,
            5, 6, 7, 1,
        ];
        const spec = terrainSpec();
        spec.texcoords = [{ output: 0, mode: 1, set: 0, transformFlags: 0 }];
        const normal: Vec4 = [1, 1, 1, 0];
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [0, 0, 0, 1] as Vec4], [3, normal]]),
            constantsFor(() => null, undefined, world));
        // (A⁻¹)ᵀ of diag(2, 1, 0.5) is diag(0.5, 1, 2).
        closeTo(out.t(0), [0.5, 1, 2, 1]);
    });

    test("vertex fog writes the D3D visibility factor to oFog", () => {
        const rs = new Int32Array(256);
        rs[36] = fbits(100);   // FOGSTART
        rs[37] = fbits(500);   // FOGEND
        rs[38] = fbits(0.004); // FOGDENSITY
        const bank = constantsFor(() => null, undefined, WORLD_VIEW, rs);
        const pos: Vec4 = [1, 2, 3, 1];
        const camera = mulRow(pos, WORLD_VIEW);
        const depth = Math.abs(camera[2]);
        const distance = Math.hypot(camera[0], camera[1], camera[2]);
        const fogFor = (fog: number, rangeFog = false, hasSpecular = false, specular: Vec4 = [0, 0, 0, 0.25]) => {
            const spec = { ...terrainSpec(), fog, rangeFog, hasSpecular };
            return runVs(synthesizeFfpVertexShader(spec), new Map([[0, pos], [6, specular]]), bank).fog![0];
        };
        expect(fogFor(3)).toBeCloseTo((500 - depth) / 400, 5);
        expect(fogFor(3, true)).toBeCloseTo((500 - distance) / 400, 5);
        expect(fogFor(1)).toBeCloseTo(Math.exp(-0.004 * depth), 5);
        expect(fogFor(2)).toBeCloseTo(Math.exp(-((0.004 * depth) ** 2)), 5);
        expect(fogFor(FFP_FOG_OUT_SPECULAR, false, true)).toBeCloseTo(0.25, 6);
        expect(fogFor(FFP_FOG_OUT_SPECULAR, false, false)).toBe(1);
    });

    test("fog output follows FOGENABLE / FOGTABLEMODE / FOGVERTEXMODE", () => {
        expect(ffpVertexFogOutput(0, 0, 3)).toBe(FFP_FOG_OUT_NONE);
        expect(ffpVertexFogOutput(1, 3, 3)).toBe(FFP_FOG_OUT_NONE); // table fog is per pixel
        expect(ffpVertexFogOutput(1, 0, 0)).toBe(FFP_FOG_OUT_SPECULAR);
        expect(ffpVertexFogOutput(1, 0, 2)).toBe(2);
    });

    test("a projected stage divides by its last counted component", () => {
        const spec = terrainSpec();
        spec.texcoords = [{ output: 1, mode: 2, set: 0, transformFlags: 0x100 | 3 }];
        expect(ffpProjectedMask(spec)).toBe(1 << 1);
        const projective = [
            1, 0, 0.5, 0,
            0, 1, 0.25, 0,
            0, 0, 1, 0,
            0, 0, 2, 1,
        ];
        const out = runVs(synthesizeFfpVertexShader(spec), new Map([[0, [1, 2, 3, 1] as Vec4]]),
            constantsFor(stage => (stage === 1 ? projective : null)));
        const camera = mulRow([1, 2, 3, 1], WORLD_VIEW);
        const t = mulRow([camera[0], camera[1], camera[2], 1], projective);
        closeTo(out.t(1), [t[0], t[1], t[2], t[2]]);
        spec.texcoords[0]!.transformFlags = 3;
        expect(ffpProjectedMask(spec)).toBe(0);
    });

    test("links against UE2's terrain ps_1_1 into a module with both stages", () => {
        const vs = compileVertexShader(synthesizeFfpVertexShader(terrainSpec()));
        const ps = compilePixelShader(terrainPs11());
        const link = linkProgram({
            vs, ps, declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
            fixedFunctionPosition: FFP_SYNTH_POSITION,
        });
        expect(link.refused).toBeNull();
        expect(link.interpolantBudgetExceeded).toBe(false);
        expect(link.wgsl).toContain("fn vs_main");
        expect(link.wgsl).toContain("fn fs_main");
        expect(link.vertexBuffers.filter(Boolean).length).toBe(3);
        expect(link.wgsl).toContain("@builtin(position) @invariant");
        const validator = probeOfflineWgslValidator();
        if (validator.available) {
            const result = validateWgslOffline(link.wgsl, validator);
            expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
        }
    });

    test("a fogged stage links with its oFog interpolant", () => {
        const spec = { ...terrainSpec(), fog: 1, rangeFog: true };
        const link = linkProgram({
            vs: compileVertexShader(synthesizeFfpVertexShader(spec)),
            ps: compilePixelShader(terrainPs11()),
            declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
            fixedFunctionPosition: FFP_SYNTH_POSITION,
        });
        expect(link.refused).toBeNull();
        expect(link.wgsl).toMatch(/out\.fog = clamp\(/);
        const validator = probeOfflineWgslValidator();
        if (validator.available) {
            const result = validateWgslOffline(link.wgsl, validator);
            expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
        }
    });

    test("the position bank holds the bits the fixed-function uniform carries", () => {
        const viewport = { width: 800, height: 600 };
        const bank = constantsFor(() => null, viewport);
        const ffpUniform = new Float32Array(16);
        writeMvpWithPixelCenter(ffpUniform, 0, new Float32Array(MVP), viewport.width, viewport.height);
        const rows = bank.subarray(FFP_SYNTH_POSITION.matrixSlot * 4, FFP_SYNTH_POSITION.matrixSlot * 4 + 16);
        expect(Array.from(rows)).toEqual(Array.from(ffpUniform));
    });

    test("fixed-function and synthesized passes share one invariant transform", () => {
        const config = {
            sampledMask: 1, stageCount: 1, flatShading: false, alphaTestEnabled: false,
            alphaFunc: 8, shouldEnableBlending: false, missingTexture: false,
            colorKeyEnabled: false, colorKey: null, debugFlags: DEFAULT_DEBUG_FLAGS, needsUVFlip: false,
        };
        const ffp = [generateShaderCode(config), generateMegaBatchShaderCode(config)];
        const link = linkProgram({
            vs: compileVertexShader(synthesizeFfpVertexShader(terrainSpec())),
            ps: compilePixelShader(terrainPs11()),
            declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
            fixedFunctionPosition: FFP_SYNTH_POSITION,
        });
        for (const wgsl of [...ffp, link.wgsl]) {
            expect(wgsl).toContain(D3D_TRANSFORM_POSITION_WGSL.trim());
            expect(wgsl).toMatch(/@builtin\(position\) @invariant/);
            expect(wgsl).toMatch(/= d3dTransformPosition\(/);
            const validator = probeOfflineWgslValidator();
            if (validator.available) {
                const result = validateWgslOffline(wgsl, validator);
                expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
            }
        }
    });
});

// ── Adapter routing ────────────────────────────────────────────────────────────

/** The terrain declaration as D3DVSD tokens, and its ps_1_1, registered as guest shaders. */
function registerTerrainShaders(): D3D8ShaderRegistry {
    const shaders = new D3D8ShaderRegistry();
    const decl = [
        0x20000000, 0x40000000 | (2 << 16) | 0, 0x40000000 | (2 << 16) | 3,
        0x20000001, 0x40000000 | (4 << 16) | 5,
        0x20000002, 0x40000000 | (1 << 16) | 7,
        0xffffffff,
    ];
    const ps = terrainPs11();
    const mem = new Uint8Array(4096);
    const view = new DataView(mem.buffer);
    decl.forEach((t, i) => view.setUint32(0x100 + i * 4, t >>> 0, true));
    ps.forEach((t, i) => view.setUint32(0x400 + i * 4, t, true));
    shaders.activeVsHandle = shaders.createVertexShader(0x100, 0, mem).handle;
    shaders.activePsHandle = shaders.createPixelShader(0x400, mem).handle;
    return shaders;
}

/** A D3D8DeviceAdapter over the terrain state with the GPU edges stubbed, recording which
 *  path each draw took. */
function terrainAdapter(lighting: number) {
    const calls: string[] = [];
    const shaders = registerTerrainShaders();
    const programmable = Object.assign(Object.create(D3D8ProgrammableRenderer.prototype), {
        ffpMemoState: new Int32Array(64),
        ffpMemoVs: -1,
        ffpMemoPs: -1,
        ffpMemoResult: null,
        ffpVertexStages: new Map(),
        ffpVertexRefusals: new Set(),
        resolveProgrammablePipeline: () => { calls.push("pipeline"); return 1; },
        captureDrawState: () => 0,
        drawViewport: () => ({ x: 0, y: 0, width: 640, height: 480, minZ: 0, maxZ: 1 }),
        getCommandRecorder: () => ({
            recordDraw: () => calls.push("programmable"),
            recordDrawIndexed: () => calls.push("programmable"),
            registerPooledBuffer: () => {},
        }),
    });
    const renderStates = new Int32Array(256);
    renderStates[137] = lighting; // D3DRS_LIGHTING
    const textureStates = new Int32Array(256);
    for (const stage of [1, 2, 3]) {
        textureStates[stage * 32 + 11] = 0x20000; // TCI_CAMERASPACEPOSITION
        textureStates[stage * 32 + 24] = 2;       // D3DTTFF_COUNT2
    }
    const adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        shaders,
        programmable,
        renderStates,
        textureStates,
        streamSources: [{ vb: 1, stride: 24 }, { vb: 2, stride: 4 }, { vb: 3, stride: 8 }],
        vbData: new Map([[1, { guestPtr: 0, size: 24 * 64, fvf: 0 }]]),
        frameSnapshot: { drawCalls: 0 },
        frameIdCounter: 0,
        drawDiagMaxPerFrame: 0,
        renderer: { scrubDraw: () => false },
        bakeTexturePalettes: () => {},
        getMemoryView: () => new Uint8Array(4096),
        uploadVb: () => ({}),
        collectExtraStreamBindings: () => [],
        drawDeclInterleavedFFP: () => { calls.push("ffp-interleave"); return 0; },
    }) as D3D8DeviceAdapter & { updateDeclOnlyMapping(): void; declInterleave: unknown };
    adapter.updateDeclOnlyMapping();
    return { adapter, calls };
}

describe("D3D8 pixel-shader uniform block", () => {
    test("the fog tail lands where PsUniforms declares it", () => {
        const shaders = registerTerrainShaders();
        const ps = shaders.getActivePs()!.compiled;
        const renderStates = new Int32Array(256);
        renderStates[28] = 1;              // FOGENABLE
        renderStates[34] = 0x00336699;     // FOGCOLOR
        renderStates[35] = 0;              // FOGTABLEMODE NONE: vertex fog
        renderStates[36] = fbits(10);
        renderStates[37] = fbits(90);
        const renderer = Object.create(D3D8ProgrammableRenderer.prototype);
        const cVecs = Math.max(1, ps.analysis.constantCount);
        const bankLen = cVecs * 4 + 16 * 4 + 4;
        const len = bankLen + 8;
        const out = new Float32Array(len).fill(NaN);
        renderer.packPixelShaderBlock({ renderStates, textureStates: new Int32Array(256) }, shaders, ps, out, cVecs, bankLen, len);
        expect(Array.from(out.subarray(len - 8))).toEqual([
            Math.fround(0x33 / 255), Math.fround(0x66 / 255), Math.fround(0x99 / 255), 1, 10, 90, 0, 0.5,
        ]);
        expect(out.subarray(cVecs * 4, bankLen).every(v => v === 0)).toBe(true);
    });
});

describe("D3D8 decl-only draws with a pixel shader bound", () => {
    test("a multi-stream declaration goes through the programmable link", () => {
        const { adapter, calls } = terrainAdapter(0);
        expect(adapter.declInterleave).not.toBeNull();
        expect(adapter.drawPrimitive(4 /* TRIANGLELIST */, 0, 2)).toBe(0);
        expect(calls).toEqual(["pipeline", "programmable"]);
    });

    test("a lit draw preserves its programmable pixel shader instead of falling back", () => {
        const { adapter, calls } = terrainAdapter(1);
        expect(adapter.drawPrimitive(4, 0, 2)).toBe(0);
        expect(calls).toEqual(["pipeline", "programmable"]);
    });

    test("lighting toggles invalidate the memo and produce distinct vertex-stage variants", () => {
        const { adapter } = terrainAdapter(0);
        const p = (adapter as any).programmable;
        const a = p.resolveFfpVertexStage(adapter, (adapter as any).shaders);
        adapter.renderStates[137] = 1;
        const b = p.resolveFfpVertexStage(adapter, (adapter as any).shaders);
        expect(a.variantKey).not.toBe(b.variantKey);
        expect(a.lighting).toBeNull();
        expect(b.lighting).toEqual(FFP_SYNTH_LIGHTING);
    });

    test("unsupported vertex blending is reported instead of silently losing the pixel shader", () => {
        const { adapter } = terrainAdapter(1);
        adapter.renderStates[151] = 1;
        const p = (adapter as any).programmable;
        expect(p.resolveFfpVertexStage(adapter, (adapter as any).shaders)).toBeNull();
        expect([...p.ffpVertexRefusals]).toEqual(["vertex blending with a programmable pixel shader"]);
    });
});

test("lit terrain link reserves its lighting bank and uses the shared lighting equation", () => {
    const vs = compileVertexShader(synthesizeFfpVertexShader(terrainSpec()));
    const link = linkProgram({ vs, ps: compilePixelShader(terrainPs11()),
        declElements: TERRAIN_DECL, streamStride: 24, streamStrides: [24, 4, 8],
        fixedFunctionPosition: FFP_SYNTH_POSITION, fixedFunctionLighting: FFP_SYNTH_LIGHTING });
    expect(link.vsConstantCount).toBe(108);
    expect(link.wgsl).toContain("ffpComputeLighting(");
    expect(link.wgsl).toContain("oD0 = _ffpLit[0]");
    expect(link.wgsl).toContain("(*lights)[i]");
    expect(link.wgsl).toContain("vsc.c[107]");
    const validator = probeOfflineWgslValidator();
    if (validator.available) {
        const result = validateWgslOffline(link.wgsl, validator);
        expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
    }
});


test("lit draw snapshots track material and light changes without SetVertexShaderConstant", () => {
    const { adapter } = terrainAdapter(1);
    const material = createDefaultMaterial();
    Object.assign(adapter, {
        material, lights: new Map(), lightsEnabled: new Set(), transforms: new Map(),
        viewport: { x: 0, y: 0, width: 640, height: 480, minZ: 0, maxZ: 1 },
        renderTarget: { width: 640, height: 480 },
        stageTexForDraw: () => null,
    });
    const backend = { getDevice: () => undefined } as unknown as WebGPUBackend;
    const renderer = new D3D8ProgrammableRenderer(backend);
    const executor = { syncSurfaceFromMemory: () => {} } as unknown as DDrawWebGPUExecutor;
    const shaders = (adapter as any).shaders as D3D8ShaderRegistry;
    const capture = () => {
        const index = renderer.captureDrawState(adapter, shaders, executor);
        return renderer.getCommandRecorder().getCurrentFrame().drawStates[index]!;
    };
    const first = capture();
    const initialVersion = first.vsVersion;
    const initialEmissive = first.vsConst[47 * 4];
    expect(first.vsLen).toBe(108 * 4 + 4);
    expect(Array.from(first.vsConst.subarray(108 * 4, 108 * 4 + 4)))
        .toEqual([Math.fround(1 / 640), Math.fround(-1 / 480), 0, 0]);
    material.emissive.r = 0.5;
    const second = capture();
    expect(second.vsConst[47 * 4]).toBe(0.5);
    expect(second.vsVersion).not.toBe(initialVersion);
    expect(first.vsConst[47 * 4]).toBe(initialEmissive);
    // Device-global lights also live in the snapshot, not a shared mutable sidecar.
    const light = {
        type: 3, diffuse: { r: 1, g: 0, b: 0, a: 1 },
        ambient: { r: 0, g: 0, b: 0, a: 1 }, specular: { r: 0, g: 0, b: 0, a: 1 },
        position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 },
        range: 1, falloff: 1, attenuation0: 1, attenuation1: 0, attenuation2: 0, theta: 0, phi: 0,
    };
    (adapter as any).lights.set(3, light);
    (adapter as any).lightsEnabled.add(3);
    const third = capture();
    expect(third.vsConst[51 * 4]).toBe(1);
    expect(third.vsVersion).not.toBe(second.vsVersion);
    expect(second.vsConst[51 * 4]).toBe(0);
    expect(capture().vsVersion).toBe(third.vsVersion);
});
