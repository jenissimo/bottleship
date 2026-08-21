/**
 * shader/index.ts — public API for the SM1.x → WGSL recompiler.
 *
 * Parses D3D9 vertex/pixel shader bytecode (CreateVertexShader /
 * CreatePixelShader) and links a VS + PS (+ active vertex declaration) into a
 * single WGSL module with a fixed, explicit bind-group layout:
 *
 *   @group(0) @binding(0)  var<uniform> vsc : VsUniforms   (VERTEX)
 *   @group(0) @binding(1)  var<uniform> psc : PsUniforms   (FRAGMENT)
 *   @group(0) @binding(2)  var samp : sampler              (FRAGMENT)
 *   @group(0) @binding(3+n) var texN : texture_2d<f32>     (FRAGMENT)
 */

import { parseShader, SmProgram } from "./sm-parser";
import { analyzeVs, emitVsMain, VsAnalysis } from "./vs-codegen";
import { analyzePs, emitPsMain, PsAnalysis } from "./ps-codegen";
import { colField, texField, AlphaTest, alphaTestSnippet } from "./sm-wgsl";
import { TexType } from "./sm-enums";
import { emitFfpCombinerWgsl } from "../ffp-combiner";

export { parseShader } from "./sm-parser";

/** Fixed bind-group binding indices for the programmable path. */
export const PROG_BIND = {
    VS_UNIFORM: 0,
    PS_UNIFORM: 1,
    SAMPLER: 2,
    TEX_BASE: 3,
    MAX_TEX: 8,
    /** Extra per-stage samplers used by the VS + fixed-function pixel hybrid path.
     *  Kept after the texture window so existing programmable shader bindings stay stable. */
    HYBRID_SAMPLER_BASE: 11,
} as const;

const FFP_MAX_STAGES = 8;

/**
 * Raw D3DVERTEXELEMENT9 data as read from guest memory (shared with the
 * device + state modules).
 */
export interface RawVertexElement {
    stream: number;
    offset: number;
    type: number;       // D3DDECLTYPE
    usage: number;      // D3DDECLUSAGE
    usageIndex: number;
    /** D3D8 D3DVSD input register (v#) this element loads — set by the VSD parser only.
     *  D3D8 vs_1_1 bytecode carries no dcl instructions, so input locations come from here. */
    reg?: number;
}

export interface CompiledVs {
    prog: SmProgram;
    analysis: VsAnalysis;
}

export interface CompiledPs {
    prog: SmProgram;
    analysis: PsAnalysis;
}

export function compileVertexShader(tokens: Uint32Array): CompiledVs {
    const prog = parseShader(tokens);
    if (prog.isPixelShader) throw new Error("Expected a vertex shader");
    return { prog, analysis: analyzeVs(prog) };
}

export function compilePixelShader(tokens: Uint32Array): CompiledPs {
    const prog = parseShader(tokens);
    if (!prog.isPixelShader) throw new Error("Expected a pixel shader");
    return { prog, analysis: analyzePs(prog) };
}

/**
 * Bitmask (over PROG_BIND.MAX_TEX stages) of which fragment-sampler stages declare a CUBE
 * sampler. Drives the texture_cube<f32> WGSL declaration, the cube bind-group layout
 * (viewDimension:"cube"), and the per-draw cube view selection — all three must agree or
 * WebGPU rejects the pipeline/bind-group. Computed identically here and at draw time so the
 * pipeline layout and the bound group never drift.
 */
export function computeCubeMask(ps: CompiledPs | null): number {
    if (!ps) return 0;
    let mask = 0;
    for (const [stage, t] of ps.analysis.samplerTexType) {
        if (stage < PROG_BIND.MAX_TEX && t === TexType.CUBE) mask |= (1 << stage);
    }
    return mask;
}

export interface LinkResult {
    wgsl: string;
    vertexAttributes: GPUVertexAttribute[];
    arrayStride: number;          // fallback when SetStreamSource stride is 0
    /** One vertex-buffer layout per used stream, at index = stream slot (null holes).
     *  Single-stream links produce [{arrayStride, attributes}] identical to the two
     *  legacy fields above. Bind each stream with setVertexBuffer(streamIndex, …). */
    vertexBuffers: (GPUVertexBufferLayout | null)[];
    vsConstantCount: number;
    psConstantCount: number;
    hasTexture: boolean;
    /** Bitmask of cube-sampler stages (see computeCubeMask) — keys the bind-group layout. */
    cubeMask: number;
}

export interface LinkOptions {
    vs: CompiledVs;
    ps: CompiledPs | null;
    declElements: RawVertexElement[] | null;
    streamStride: number | null;
    /** Per-stream SetStreamSource strides (index = stream number; null/0 → fall back to the
     *  declaration's computed stride for that stream). Presence enables the multi-stream
     *  vertex-input path (D3D8 D3DVSD declarations); omit for the legacy single-stream
     *  (stream-0 only) layout the D3D9 device consumes. */
    streamStrides?: (number | null)[] | null;
    /** D3D9 fixed-function alpha test (emitted as a fragment discard), or null. */
    alphaTest?: AlphaTest | null;
    /** Effective cube-sampler mask override (shader dcl_cube ∪ cube textures bound at draw time).
     *  Lets ps_1_x / no-dcl shaders sample a bound cube map (NFSU reflections). Falls back to the
     *  PS's declared dcl_cube mask when omitted. */
    cubeMask?: number;
    /** Per-stage D3DTTFF_PROJECTED coordinate-count key (3 bits/stage, 0 = not projected). Drives
     *  the ps_1_1-1_3 / fixed-function projective texture divide (projected spotlights, planar
     *  reflections). SM2+ shaders project in-shader (texldp) and ignore this. */
    projectedStages?: number;
    /** With a programmable VS but no PS, D3D still runs the fixed-function texture-stage
     *  cascade. This is the number of enabled stages, baked into the generated fragment entry. */
    ffpStageCount?: number;
    /** The MIRROR case: the declaration is pre-transformed (POSITIONT), so the fixed function
     *  owns the VERTEX stage while a bound pixel shader keeps running — Wine's use_vs/use_ps
     *  pair. `vs` is ignored for codegen; the vertex stage is generated from the declaration
     *  and the viewport it maps against (baked in, so the pipeline key must carry the size). */
    preTransformed?: { viewportWidth: number; viewportHeight: number } | null;
}

/** WGSL locations for the pre-transformed passthrough vertex stage. Fixed, because there is
 *  no shader whose input dcls could assign them. */
const PT_LOC_POSITION = 0;
const PT_LOC_COLOR = 1;          // + usageIndex (0,1)
const PT_LOC_TEXCOORD = 3;       // + usageIndex

/**
 * Vertex inputs for the pre-transformed stage, taken from the DECLARATION rather than from a
 * shader's input dcls (there is no shader here). Mirrors buildVertexInputs' contract: one
 * layout per stream slot, plus a per-location WGSL expression that expands to vec4<f32>.
 */
function buildPreTransformedInputs(
    declElements: RawVertexElement[],
    streamStride: number | null,
    streamStrides: (number | null)[] | null,
): {
    fields: string[];
    attributes: GPUVertexAttribute[];
    inputExprs: Map<number, string>;
    stride: number;
    vertexBuffers: (GPUVertexBufferLayout | null)[];
} {
    const multiStream = streamStrides !== null;
    const fields: string[] = [];
    const inputExprs = new Map<number, string>();
    const perStreamAttrs = new Map<number, GPUVertexAttribute[]>();
    const perStreamMaxEnd = new Map<number, number>();

    const locationOf = (e: RawVertexElement): number | null => {
        if (e.usage === 9 /* POSITIONT */ || e.usage === 0 /* POSITION */) return PT_LOC_POSITION;
        if (e.usage === 10 /* COLOR */ && e.usageIndex <= 1) return PT_LOC_COLOR + e.usageIndex;
        if (e.usage === 5 /* TEXCOORD */ && e.usageIndex < 8) return PT_LOC_TEXCOORD + e.usageIndex;
        return null;
    };

    const taken = new Set<number>();
    for (const e of declElements) {
        const loc = locationOf(e);
        if (loc === null || taken.has(loc)) continue;
        const stream = multiStream ? e.stream : 0;
        if (!multiStream && e.stream !== 0) continue;
        const info = declTypeInfo(e.type);
        // An element outside the BOUND stride has no attribute to read — same rule as the
        // shader path: a WGSL @location the vertex state cannot supply invalidates the
        // pipeline, and that costs the whole frame rather than this draw.
        const bound = (multiStream ? streamStrides![stream] : streamStride) ?? 0;
        if (bound > 0 && e.offset + info.size > bound) continue;
        taken.add(loc);
        fields.push(`@location(${loc}) v${loc}: ${info.wgslType}`);
        let attrs = perStreamAttrs.get(stream);
        if (!attrs) { attrs = []; perStreamAttrs.set(stream, attrs); }
        attrs.push({ shaderLocation: loc, offset: e.offset, format: info.format });
        inputExprs.set(loc, info.expand(`in.v${loc}`));
        perStreamMaxEnd.set(stream, Math.max(perStreamMaxEnd.get(stream) ?? 0, e.offset + info.size));
    }

    const attributes = perStreamAttrs.get(0) ?? [];
    const stride0Source = multiStream ? (streamStrides![0] ?? null) : streamStride;
    const stride = stride0Source && stride0Source > 0 ? stride0Source : (perStreamMaxEnd.get(0) ?? 0);
    const vertexBuffers: (GPUVertexBufferLayout | null)[] = [];
    if (multiStream) {
        let maxStream = 0;
        for (const st of perStreamAttrs.keys()) maxStream = Math.max(maxStream, st);
        for (let st = 0; st <= maxStream; st++) {
            const attrs = perStreamAttrs.get(st);
            if (!attrs || attrs.length === 0) { vertexBuffers.push(null); continue; }
            const bound = streamStrides![st] ?? 0;
            vertexBuffers.push({
                arrayStride: bound > 0 ? bound : (perStreamMaxEnd.get(st) ?? 0),
                attributes: attrs,
            });
        }
    } else if (attributes.length > 0) {
        vertexBuffers.push({ arrayStride: stride, attributes });
    }
    return { fields, attributes, inputExprs, stride, vertexBuffers };
}

/**
 * The fixed-function vertex stage for pre-transformed vertices: map screen pixels to clip
 * space and hand the colours/coordinates straight to the interpolants.
 *
 * D3D9 pre-transformed vertices carry x,y in PIXELS, z already in [0,1], and RHW = 1/w. The
 * rasterizer divides by w, so emitting w = 1 with x,y already mapped reproduces it; RHW only
 * matters for perspective-correct interpolation, which screen-space UI does not use.
 */
function emitPreTransformedVsMain(
    interpColors: [boolean, boolean],
    interpTexcoords: number[],
    inputExprs: Map<number, string>,
    viewportWidth: number,
    viewportHeight: number,
): string {
    const pos = inputExprs.get(PT_LOC_POSITION) ?? "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
    const vw = Math.max(1, viewportWidth), vh = Math.max(1, viewportHeight);
    const lines: string[] = [];
    lines.push(`@vertex`);
    lines.push(`fn vs_main(in: VsInput) -> Interp {`);
    lines.push(`    var out: Interp;`);
    lines.push(`    let _p = ${pos};`);
    lines.push(`    out.pos = vec4<f32>(_p.x / ${vw.toFixed(1)} * 2.0 - 1.0, 1.0 - _p.y / ${vh.toFixed(1)} * 2.0, _p.z, 1.0);`);
    for (const i of [0, 1] as const) {
        if (!interpColors[i]) continue;
        const e = inputExprs.get(PT_LOC_COLOR + i);
        lines.push(`    out.${colField(i)} = ${e ?? (i === 0 ? "vec4<f32>(1.0)" : "vec4<f32>(0.0)")};`);
    }
    for (const n of interpTexcoords) {
        const e = inputExprs.get(PT_LOC_TEXCOORD + n);
        lines.push(`    out.${texField(n)} = ${e ?? "vec4<f32>(0.0, 0.0, 0.0, 1.0)"};`);
    }
    lines.push(`    return out;`);
    lines.push(`}`);
    return lines.join("\n");
}

export function linkProgram(opts: LinkOptions): LinkResult {
    const { vs, ps, declElements, streamStride, alphaTest = null } = opts;
    const cubeMaskOverride = opts.cubeMask;
    const projectedStages = opts.projectedStages ?? 0;
    const vsA = vs.analysis;
    const psA = ps?.analysis ?? null;

    // ── Interpolant set (union of VS-written and PS-read) ──────────────────
    const interpColors: [boolean, boolean] = [
        vsA.writesColor[0] || (psA?.readsColor[0] ?? false),
        vsA.writesColor[1] || (psA?.readsColor[1] ?? false),
    ];
    const texcoordSet = new Set<number>(vsA.writesTexcoord);
    if (psA) for (const n of psA.readsTexcoord) texcoordSet.add(n);
    const interpTexcoords = [...texcoordSet].sort((a, b) => a - b);

    // ── Vertex input reconciliation against the active declaration ─────────
    // A pre-transformed declaration takes the vertex stage away from the shader, so the inputs
    // come from the declaration itself; everything downstream is unchanged.
    const preTransformed = (opts.preTransformed && declElements && declElements.length > 0)
        ? opts.preTransformed : null;
    const vin = preTransformed
        ? buildPreTransformedInputs(declElements!, streamStride, opts.streamStrides ?? null)
        : buildVertexInputs(vsA, declElements, streamStride, opts.streamStrides ?? null);
    let { fields, attributes, vertexBuffers } = vin;
    const inputExprs = vin.inputExprs;
    let stride = vin.stride;
    if (fields.length === 0) {
        // Degenerate VS with no input registers — keep shader/layout consistent.
        fields = ["@location(0) _unused: vec4<f32>"];
        attributes = [{ shaderLocation: 0, offset: 0, format: "float32x4" }];
        if (stride <= 0) stride = 16;
        vertexBuffers = [{ arrayStride: stride, attributes }];
    }

    // ── Fragment sampler set ───────────────────────────────────────────────
    let fragSamplers: number[];
    const hybridStageCount = ps ? 0 : Math.max(1, Math.min(opts.ffpStageCount ?? 1, FFP_MAX_STAGES));
    if (ps) {
        fragSamplers = [...psA!.samplers].filter(n => n < PROG_BIND.MAX_TEX).sort((a, b) => a - b);
    } else {
        // Hybrid pixel processing samples each active fixed-function stage, irrespective of
        // which coordinates the VS happened to write. Missing coordinates are handled by the
        // fragment generator's t0 fallback, just as the declaration/FVF FFP path does.
        fragSamplers = Array.from({ length: hybridStageCount }, (_unused, stage) => stage);
    }
    const hasTexture = fragSamplers.length > 0;

    const vsConstantCount = vsA.constantCount;
    const psConstantCount = psA?.constantCount ?? 0;

    // ── Assemble module ────────────────────────────────────────────────────
    const lines: string[] = [];

    lines.push(`struct VsUniforms { c: array<vec4<f32>, ${Math.max(1, vsConstantCount)}>, }`);
    lines.push(`@group(0) @binding(${PROG_BIND.VS_UNIFORM}) var<uniform> vsc: VsUniforms;`);
    if (ps) {
        if (psA!.usesLegacyBumpEnv) {
            // TEXBEM/TEXBEML source their matrix/luminance from D3DTSS state,
            // separate from c#. Two vec4 values per stage keep the WGSL layout
            // naturally 16-byte aligned and fit after the largest PS constant bank.
            lines.push(`struct LegacyBumpStage { mat: vec4<f32>, lum: vec4<f32>, }`);
            lines.push(`struct PsUniforms { c: array<vec4<f32>, ${Math.max(1, psConstantCount)}>, bump: array<LegacyBumpStage, ${FFP_MAX_STAGES}>, }`);
        } else {
            lines.push(`struct PsUniforms { c: array<vec4<f32>, ${Math.max(1, psConstantCount)}>, }`);
        }
    } else {
        // `c` deliberately remains a vec4 so the hybrid layout keeps the regular PS uniform
        // binding shape. The device packs tfactor + eight FfpStage records immediately after it.
        lines.push(`struct FfpStage { a: vec4<f32>, b: vec4<f32>, }`);
        lines.push(`struct PsUniforms { c: array<vec4<f32>, 1>, tfactor: vec4<f32>, stages: array<FfpStage, ${FFP_MAX_STAGES}>, }`);
    }
    lines.push(`@group(0) @binding(${PROG_BIND.PS_UNIFORM}) var<uniform> psc: PsUniforms;`);
    // Per-stage cube-sampler mask: a cube sampler declares texture_cube<f32> + samples with a
    // 3-component direction (ps-codegen). The bind-group layout's viewDimension must match. The
    // override (dcl_cube ∪ bound-cube at draw time) lets ps_1_x/no-dcl shaders sample a bound cube.
    const cubeMask = cubeMaskOverride ?? computeCubeMask(ps);
    if (hasTexture) {
        lines.push(`@group(0) @binding(${PROG_BIND.SAMPLER}) var samp: sampler;`);
        for (const n of fragSamplers) {
            const kind = (cubeMask >> n) & 1 ? "texture_cube<f32>" : "texture_2d<f32>";
            lines.push(`@group(0) @binding(${PROG_BIND.TEX_BASE + n}) var tex${n}: ${kind};`);
        }
        if (!ps) {
            for (const n of fragSamplers) {
                lines.push(`@group(0) @binding(${PROG_BIND.HYBRID_SAMPLER_BASE + n}) var ffpSamp${n}: sampler;`);
            }
        }
    }
    lines.push("");

    lines.push(`struct VsInput {`);
    for (const f of fields) lines.push(`    ${f},`);
    lines.push(`}`);
    lines.push("");

    lines.push(`struct Interp {`);
    lines.push(`    @builtin(position) pos: vec4<f32>,`);
    if (interpColors[0]) lines.push(`    @location(0) ${colField(0)}: vec4<f32>,`);
    if (interpColors[1]) lines.push(`    @location(1) ${colField(1)}: vec4<f32>,`);
    for (const n of interpTexcoords) lines.push(`    @location(${2 + n}) ${texField(n)}: vec4<f32>,`);
    lines.push(`}`);
    lines.push("");

    lines.push(preTransformed
        ? emitPreTransformedVsMain(interpColors, interpTexcoords, inputExprs,
            preTransformed.viewportWidth, preTransformed.viewportHeight)
        : emitVsMain(vs.prog, vsA, {
            interpColors,
            interpTexcoords,
            inputExprs,
            constantCount: vsConstantCount,
        }));
    lines.push("");

    if (ps) {
        lines.push(emitPsMain(ps.prog, psA!, alphaTest, cubeMask, projectedStages));
    } else {
        lines.push(emitHybridFixedFunctionFragment(
            interpColors[0], interpColors[1], interpTexcoords, hybridStageCount, alphaTest,
            cubeMask, projectedStages,
        ));
    }

    return {
        wgsl: lines.join("\n"),
        vertexAttributes: attributes,
        arrayStride: stride,
        vertexBuffers,
        vsConstantCount,
        psConstantCount,
        hasTexture,
        cubeMask,
    };
}

function emitDefaultFragment(hasColor: boolean, sampleStage: number | null, alphaTest: AlphaTest | null = null, sampleCube = false, projected = false): string {
    const col = hasColor ? `in.${colField(0)}` : `vec4<f32>(1.0)`;
    // D3DTTFF_PROJECTED on the sampled stage divides the coordinate by its .w component before
    // the fetch (the vertex shader places the projective q there) — see projectedStageKey.
    const tcRaw = sampleStage !== null ? `in.${texField(sampleStage)}` : "";
    const tc = sampleStage !== null && projected
        ? `((${tcRaw}) / (${tcRaw}).w)`
        : `(${tcRaw})`;
    const coord = sampleStage !== null
        ? (sampleCube ? `${tc}.xyz` : `${tc}.xy`)
        : "";
    const ret = sampleStage !== null
        ? `textureSample(tex${sampleStage}, samp, ${coord}) * ${col}`
        : col;
    const atest = alphaTestSnippet(alphaTest, "_c.a");
    if (!atest) {
        return `@fragment\nfn fs_main(in: Interp) -> @location(0) vec4<f32> {\n    return ${ret};\n}`;
    }
    return `@fragment\nfn fs_main(in: Interp) -> @location(0) vec4<f32> {\n    let _c = ${ret};\n    ${atest}\n    return _c;\n}`;
}

/**
 * A NULL pixel shader leaves texture combiners fixed-function, but a bound
 * vertex shader remains programmable: stage N samples the VS's oTN directly.
 * D3DTSS_TEXCOORDINDEX is a fixed-function *vertex* state and is ignored here.
 */
export function hybridTexcoordSetForStage(stage: number, writtenTexcoords: readonly number[]): number | null {
    return writtenTexcoords.includes(stage) ? stage : null;
}

/** D3D9 hybrid path: programmable vertex shader + NULL pixel shader. The pixel side is not a
 * white/default sample; it is the normal fixed-function texture-stage cascade — the very same
 * combiner the FFP shader emits (ffp-combiner.ts), over stage records the device packs into the
 * otherwise-unused PS uniform binding in `packFfpUniforms`' layout. */
function emitHybridFixedFunctionFragment(
    hasColor: boolean, hasSpecular: boolean, texcoords: number[], stageCount: number,
    alphaTest: AlphaTest | null, cubeMask: number, projectedStages: number,
): string {
    const color = hasColor ? `in.${colField(0)}` : "vec4<f32>(1.0)";
    const specular = hasSpecular ? `in.${colField(1)}` : "vec4<f32>(0.0)";
    const arg = (sel: string): string => `ffpStageArg(${sel}, _t, _cur, _diff, _spec, _tmp, psc.tfactor)`;
    const stage = (s: number): string => {
        // D3DTSS_TEXCOORDINDEX configures the fixed-function VERTEX pipeline. It does not
        // remap a programmable VS's oT# outputs: fixed-function pixel stage N consumes oTN.
        const coordSet = hybridTexcoordSetForStage(s, texcoords);
        const raw = coordSet === null
            ? "vec4<f32>(0.0, 0.0, 0.0, 1.0)"
            : `in.${texField(coordSet)}`;
        const cube = ((cubeMask >> s) & 1) !== 0;
        const projected = ((projectedStages >> s) & 1) !== 0;
        const coord = cube
            ? `${raw}.xyz`
            : projected
                ? `(${raw}.xy / max(abs(${raw}.w), 1e-8))`
                : `${raw}.xy`;
        return `
    if (u32(psc.stages[${s}].a.x) != 1u) {
        var _t = textureSample(tex${s}, ffpSamp${s}, ${coord});
        // Alpha-less D3D formats read alpha as 1.0 on real hardware; our GPU copies carry a
        // live alpha channel that must be masked.
        if (psc.stages[${s}].b.z > 0.5) { _t = vec4<f32>(_t.rgb, 1.0); }
        let _cur = _c;
        // COLORARG0 | ALPHAARG0<<8 | resultIsTemp<<16 (see FfpStage in ffp-lighting.ts).
        let _x = u32(psc.stages[${s}].b.w);
        let _toTemp = (_x >> 16u) != 0u;
        // D3DTSS_RESULTARG: the stage reads CURRENT/TEMP as arguments either way, but writes
        // only the selected register — and an unwritten channel keeps ITS old value.
        let _dst = select(_c, _tmp, _toTemp);
        let _a0 = ${arg("_x & 0xffu")};
        let _a1 = ${arg(`u32(psc.stages[${s}].a.y)`)};
        let _a2 = ${arg(`u32(psc.stages[${s}].a.z)`)};
        let _rgb = ffpStageOp(u32(psc.stages[${s}].a.x), _a0, _a1, _a2, _t, _cur, _diff, psc.tfactor, _dst);
        var _al = _dst.a;
        if (u32(psc.stages[${s}].a.w) != 1u) {
            let _b0 = ${arg("(_x >> 8u) & 0xffu")};
            let _b1 = ${arg(`u32(psc.stages[${s}].b.x)`)};
            let _b2 = ${arg(`u32(psc.stages[${s}].b.y)`)};
            _al = ffpStageOp(u32(psc.stages[${s}].a.w), _b0, _b1, _b2, _t, _cur, _diff, psc.tfactor, _dst).a;
        }
        let _out = vec4<f32>(clamp(_rgb.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(_al, 0.0, 1.0));
        if (_toTemp) { _tmp = _out; } else { _c = _out; }
    }`;
    };
    return `
${emitFfpCombinerWgsl("dst")}
@fragment
fn fs_main(in: Interp) -> @location(0) vec4<f32> {
    let _diff = ${color};
    let _spec = ${specular};
    // c0.x is a harness-only diagnostic selector: 1=texture0, 2=vertex colour, 3=white.
    // It is dynamic uniform state, so it deliberately does not affect pipeline caching.
    if (psc.c[0].x > 0.5) {
        if (psc.c[0].x > 2.5) { return vec4<f32>(1.0); }
        if (psc.c[0].x > 1.5) { return ${hasColor ? "_diff" : "vec4<f32>(1.0, 0.0, 1.0, 1.0)"}; }
        return textureSample(tex0, ffpSamp0, ${texcoords.includes(0) ? `in.${texField(0)}.xy` : "vec2<f32>(0.0)"});
    }
    // TEMP starts at (0,0,0,0) — it is a D3DTA register the whole cascade shares, not per stage.
    var _tmp: vec4<f32> = vec4<f32>(0.0);
    var _c: vec4<f32> = _diff;${Array.from({ length: stageCount }, (_unused, s) => stage(s)).join("")}
    ${alphaTestSnippet(alphaTest, "_c.a")}
    return _c;
}`;
}

// ── Vertex declaration → WGSL input + attributes ──────────────────────────────

interface DeclTypeInfo {
    format: GPUVertexFormat;
    wgslType: string;
    size: number;
    /** expand(field) → a vec4<f32> WGSL expression. */
    expand(field: string): string;
}

function declTypeInfo(type: number): DeclTypeInfo {
    switch (type) {
        case 0:  return { format: "float32",   wgslType: "f32",        size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 0.0, 1.0)` }; // FLOAT1
        case 1:  return { format: "float32x2", wgslType: "vec2<f32>",  size: 8,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };       // FLOAT2
        case 2:  return { format: "float32x3", wgslType: "vec3<f32>",  size: 12, expand: f => `vec4<f32>(${f}, 1.0)` };            // FLOAT3
        case 3:  return { format: "float32x4", wgslType: "vec4<f32>",  size: 16, expand: f => f };                                  // FLOAT4
        case 4:  return { format: "unorm8x4",  wgslType: "vec4<f32>",  size: 4,  expand: f => `(${f}).zyxw` };                      // D3DCOLOR (BGRA→RGBA)
        case 5:  return { format: "uint8x4",   wgslType: "vec4<u32>",  size: 4,  expand: f => `vec4<f32>(${f})` };                  // UBYTE4
        case 6:  return { format: "sint16x2",  wgslType: "vec2<i32>",  size: 4,  expand: f => `vec4<f32>(vec2<f32>(${f}), 0.0, 1.0)` }; // SHORT2
        case 7:  return { format: "sint16x4",  wgslType: "vec4<i32>",  size: 8,  expand: f => `vec4<f32>(${f})` };                  // SHORT4
        case 8:  return { format: "unorm8x4",  wgslType: "vec4<f32>",  size: 4,  expand: f => f };                                  // UBYTE4N
        case 9:  return { format: "snorm16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // SHORT2N
        case 10: return { format: "snorm16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // SHORT4N
        case 11: return { format: "unorm16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // USHORT2N
        case 12: return { format: "unorm16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // USHORT4N
        case 15: return { format: "float16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // FLOAT16_2
        case 16: return { format: "float16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // FLOAT16_4
        default: return { format: "float32x4", wgslType: "vec4<f32>",  size: 16, expand: f => f };                                  // fallback
    }
}

function buildVertexInputs(
    vsA: VsAnalysis,
    declElements: RawVertexElement[] | null,
    streamStride: number | null,
    streamStrides: (number | null)[] | null,
): {
    fields: string[];
    attributes: GPUVertexAttribute[];
    inputExprs: Map<number, string>;
    stride: number;
    vertexBuffers: (GPUVertexBufferLayout | null)[];
} {
    const multiStream = streamStrides !== null;
    const fields: string[] = [];
    const inputExprs = new Map<number, string>();
    const perStreamAttrs = new Map<number, GPUVertexAttribute[]>();
    const perStreamMaxEnd = new Map<number, number>();
    let tightOffset = 0;

    // D3D8 vs_1_1 bytecode has no dcl instructions: the D3DVSD declaration itself maps
    // each element to its input register (D3DVSD_REG). When the shader analysis found no
    // input dcls but the declaration carries register numbers, synthesize the input list
    // from the declaration (locations = v# register numbers).
    type InputSpec = { reg: number; elem: RawVertexElement | null };
    let specs: InputSpec[];
    if (vsA.inputDcls.length > 0) {
        specs = vsA.inputDcls.map(dcl => ({
            reg: dcl.reg,
            elem: declElements?.find(
                e => (multiStream || e.stream === 0) && e.usage === dcl.usage && e.usageIndex === dcl.usageIndex,
            ) ?? null,
        }));
    } else if (multiStream && declElements) {
        specs = declElements.filter(e => e.reg !== undefined).map(e => ({ reg: e.reg!, elem: e }));
    } else {
        specs = [];
    }

    for (const spec of specs) {
        const field = `in.v${spec.reg}`;
        let info: DeclTypeInfo;
        let offset: number;
        let stream = 0;

        if (spec.elem) {
            info = declTypeInfo(spec.elem.type);
            offset = spec.elem.offset;
            stream = multiStream ? spec.elem.stream : 0;
            // An element that does not fit the BOUND vertex has no attribute to read from:
            // the stride is what SetStreamSource said, and raising it to fit would step every
            // vertex past its successor. Reading zeros is what the hardware does there, and it
            // has to be decided HERE — a WGSL @location the vertex state cannot supply makes
            // the pipeline invalid, which costs the whole frame's command buffer, not one draw.
            const bound = (multiStream ? streamStrides![stream] : streamStride) ?? 0;
            if (bound > 0 && offset + info.size > bound) {
                inputExprs.set(spec.reg, info.expand(`${info.wgslType}()`));
                continue;
            }
        } else {
            // No matching declaration element — tight-pack as float4.
            info = declTypeInfo(3);
            offset = tightOffset;
            tightOffset += info.size;
        }

        fields.push(`@location(${spec.reg}) v${spec.reg}: ${info.wgslType}`);
        let attrs = perStreamAttrs.get(stream);
        if (!attrs) {
            attrs = [];
            perStreamAttrs.set(stream, attrs);
        }
        attrs.push({ shaderLocation: spec.reg, offset, format: info.format });
        inputExprs.set(spec.reg, info.expand(field));
        perStreamMaxEnd.set(stream, Math.max(perStreamMaxEnd.get(stream) ?? 0, offset + info.size));
    }

    // Legacy single-buffer view = stream 0 (identical to the pre-multi-stream layout).
    const attributes = perStreamAttrs.get(0) ?? [];
    const maxEnd0 = perStreamMaxEnd.get(0) ?? 0;
    const stride0Source = multiStream ? (streamStrides![0] ?? null) : streamStride;
    let stride = stride0Source && stride0Source > 0 ? stride0Source : maxEnd0;
    if (stride <= 0) stride = 16;

    // Per-stream buffer layouts at slot = stream number (null holes for unused slots).
    let maxStream = 0;
    for (const s of perStreamAttrs.keys()) maxStream = Math.max(maxStream, s);
    const vertexBuffers: (GPUVertexBufferLayout | null)[] = [];
    for (let s = 0; s <= maxStream; s++) {
        const attrs = perStreamAttrs.get(s);
        if (!attrs || attrs.length === 0) {
            vertexBuffers.push(null);
            continue;
        }
        if (s === 0) {
            vertexBuffers.push({ arrayStride: stride, attributes: attrs });
            continue;
        }
        const provided = streamStrides?.[s] ?? null;
        let sStride = provided && provided > 0 ? provided : (perStreamMaxEnd.get(s) ?? 0);
        if (sStride <= 0) sStride = 16;
        vertexBuffers.push({ arrayStride: sStride, attributes: attrs });
    }

    return { fields, attributes, inputExprs, stride, vertexBuffers };
}
