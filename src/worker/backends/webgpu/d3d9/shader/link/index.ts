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

import { parseShader, SmProgram } from "../sm-parser";
import { analyzeVs, emitVsMain, VsAnalysis } from "../emit/vs";
import { analyzePs, emitPsMain, PsAnalysis, type PsInputBinding } from "../emit/ps";
import { colField, texField, AlphaTest, alphaTestSnippet } from "../emit/expr";
import { RegType, TexType, Usage } from "../sm-enums";
import { emitFfpCombinerWgsl } from "../../ffp-combiner";
import { Emitter } from "../emitter";
import { emitInterpStruct, clipPlaneLocations, interpLocationLayout } from "./interp";
import {
    emitUniformDeclarations,
    type VsConstantMode,
} from "./uniforms";
import { emitBindLayout } from "./bind-layout";
import { Logger, LogCategory } from "../../../../../core/logger";
import { mapPsInputSemantic } from "../emit/ps";
import { inlineCalls } from "../passes/inline-calls";
import { Census, type CensusSummary } from "../census";
import { emitTextureSample, type ComparisonSamplerSet } from "../emit/tex";
import type { SamplerSpec } from "../../../shared/dx-sampler";

export { parseShader, ShaderParseError } from "../sm-parser";

/** Fixed bind-group binding indices for the programmable path. */
export const PROG_BIND = {
    VS_UNIFORM: 0,
    PS_UNIFORM: 1,
    SAMPLER: 2,
    TEX_BASE: 3,
    MAX_TEX: 16,
    /** Extra per-stage samplers used by the VS + fixed-function pixel hybrid path.
     *  Kept after the texture window so existing programmable shader bindings stay stable. */
    /** Stage-1..15 fragment sampler window follows the eight texture bindings. */
    HYBRID_SAMPLER_BASE: 19,
    /** Stable name used by the shared executor for the same sampler window. */
    FRAGMENT_SAMPLER_BASE: 19,
} as const;

const FFP_MAX_STAGES = 8;
const LEGACY_PSIZE_INPUT_REGISTER = 4; // D3DVSDE_PSIZE / v4

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
    const prog = inlineCalls(parseShader(tokens));
    if (prog.isPixelShader) throw new Error("Expected a vertex shader");
    if (!prog.terminated) throw new Error("Unterminated vertex shader bytecode");
    return { prog, analysis: analyzeVs(prog) };
}

export function compilePixelShader(tokens: Uint32Array): CompiledPs {
    const prog = inlineCalls(parseShader(tokens));
    if (!prog.isPixelShader) throw new Error("Expected a pixel shader");
    if (!prog.terminated) throw new Error("Unterminated pixel shader bytecode");
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
    for (const [stage, t] of ps.analysis.samplerTexType ?? []) {
        if (stage < PROG_BIND.MAX_TEX && t === TexType.CUBE) mask |= (1 << stage);
    }
    return mask;
}

/** Bitmask of fragment sampler stages declared as D3D volume (3-D) textures. */
export function computeVolumeMask(ps: CompiledPs | null): number {
    if (!ps) return 0;
    let mask = 0;
    for (const [stage, t] of ps.analysis.samplerTexType ?? []) {
        if (stage < PROG_BIND.MAX_TEX && t === TexType.VOLUME) mask |= (1 << stage);
    }
    return mask;
}

/** Bitmask of VS vertex-texture stages declared as D3D volume textures. */
export function computeVertexVolumeMask(vs: CompiledVs | null): number {
    if (!vs) return 0;
    let mask = 0;
    for (const [stage, t] of vs.analysis.samplerTexType ?? []) {
        if (stage < 4 && t === TexType.VOLUME) mask |= (1 << stage);
    }
    return mask;
}

/** Why a requested link variant could not be generated. */
export interface LinkRefusal {
    reason: "vs-integer-boolean-in-instance-storage";
    detail: string;
}

/** A refused link carries no usable module: `wgsl` is a comment and every size is zero. */
export function isLinkRefused(link: LinkResult): boolean {
    return link.refused !== null;
}

export interface LinkResult {
    /** Non-null when the requested variant was refused; nothing else in the result is usable. */
    refused: LinkRefusal | null;
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
    /** Bitmask of 3-D volume sampler stages — keys texture_3d bind declarations. */
    volumeMask: number;
    /** Bitmask of 3-D VS vertex-texture stages — keys vertex texture declarations. */
    vertexVolumeMask: number;
    /** Actual emitter dispositions, split by shader stage. */
    census: { vs: CensusSummary; ps: CensusSummary | null };
    /** Bitmask of stages whose programmable sampler is a depth comparison sampler. */
    comparisonMask: number;
    /** True when the generated interface exceeds WebGPU's portable inter-stage budget. */
    interpolantBudgetExceeded: boolean;
    /** Exact byte stride of one VsUniforms storage element; zero on the uniform path. */
    vsStorageSlotBytes: number;
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
    /** Effective 3-D volume-sampler mask override (shader dcl_volume ∪ bound volume). */
    volumeMask?: number;
    /** Effective VS vertex-volume mask override. */
    vertexVolumeMask?: number;
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
    preTransformed?: { viewportWidth: number; viewportHeight: number; pixelCenterOffset?: number } | null;
    /** Programmable PS stages that use comparison sampling (D3D sampler state + depth resource). */
    comparisonSamplers?: ComparisonSamplerSet;
    /** Per-stage sampler state baked into shader-side address/LOD emulation. */
    samplerStates?: ReadonlyMap<number, SamplerSpec>;
    /** Lower a point-list draw whose source vertices were duplicated six-per-point on the CPU. */
    pointExpansion?: boolean;
    /** D3DRS_POINTSPRITEENABLE for the CPU-lowered programmable point-list path. */
    pointSpriteEnable?: boolean;
    /** Lower enabled D3D9 user clip planes from hidden VS constants to fragment discard. */
    clipPlanes?: boolean;
    /** Instance-indexed VS constant transport used by the exact MegaBatch variant. */
    vsConstantMode?: VsConstantMode;
}

/** WGSL locations for the pre-transformed passthrough vertex stage. Fixed, because there is
 *  no shader whose input dcls could assign them. */
const PT_LOC_POSITION = 0;
const PT_LOC_COLOR = 1;          // + usageIndex (0,1)
const PT_LOC_TEXCOORD = 3;       // + usageIndex

/**
 * The W0 emitter already knows how to write POSITION/COLOR/TEXCOORD/FOG outputs,
 * but SM3 also permits the other declaration semantics. When a PS consumes one of
 * those semantics, give the matching VS output the same generic interpolant slot.
 * This keeps the semantic repair local to linking and leaves emit/vs.ts unchanged.
 */
function compactPsSemanticBindings(ps: CompiledPs): {
    analysis: PsAnalysis;
    bySemantic: Map<string, PsInputBinding>;
} {
    if (ps.prog.major < 3) return { analysis: ps.analysis, bySemantic: new Map() };
    const bySemantic = new Map<string, PsInputBinding>();
    const byRegister = new Map<number, PsInputBinding>();
    let nextGeneric = 0;
    for (const dcl of ps.prog.declarations) {
        if (dcl.reg.type !== 1 /* INPUT */) continue;
        const key = `${dcl.usage}:${dcl.usageIndex}`;
        let binding = bySemantic.get(key);
        if (!binding) {
            binding = mapPsInputSemantic(dcl.usage, dcl.usageIndex);
            // Generic interpolants share one compact namespace in this backend. The D3D
            // semantic is the identity; its hardware register number is not a WGSL location.
            if (binding.kind === "texcoord" && dcl.usage !== 5 /* TEXCOORD */ ||
                (binding.kind === "texcoord" && dcl.usage === 5 /* TEXCOORD */ && dcl.usageIndex !== nextGeneric)) {
                binding = { ...binding, index: nextGeneric++ };
            } else if (binding.kind === "texcoord") {
                nextGeneric = Math.max(nextGeneric, binding.index + 1);
                binding = { ...binding, index: nextGeneric - 1 };
            }
            bySemantic.set(key, binding);
        }
        byRegister.set(dcl.reg.num, binding);
    }
    const readsColor: [boolean, boolean] = [false, false];
    const readsTexcoord = new Set<number>();
    const note = (reg: { type: number; num: number }): void => {
        if (reg.type === 3 /* TEXTURE */) readsTexcoord.add(reg.num);
        if (reg.type !== 1 /* INPUT */) return;
        const b = byRegister.get(reg.num) ?? mapPsInputSemantic(5 /* TEXCOORD */, reg.num);
        if (b.kind === "color" && b.index <= 1) readsColor[b.index] = true;
        else if (b.kind === "texcoord") readsTexcoord.add(b.index);
    };
    for (const ins of ps.prog.instructions) {
        for (const source of ins.src) note(source.reg);
    }
    const centroidInputs = new Set<number>();
    for (const dcl of ps.prog.declarations) {
        if (!dcl.centroid || dcl.reg.type !== 1 /* INPUT */) continue;
        const b = byRegister.get(dcl.reg.num);
        if (b && b.kind !== "position") centroidInputs.add(b.kind === "color" ? b.index : 2 + b.index);
    }
    return {
        analysis: {
            ...ps.analysis,
            readsColor,
            readsTexcoord,
            inputBindings: byRegister,
            centroidInputs,
        },
        bySemantic,
    };
}

function patchVsSemanticOutputs(
    vs: CompiledVs,
    ps: CompiledPs | null,
    bySemantic: Map<string, PsInputBinding> = new Map(),
): VsAnalysis {
    if (!ps || ps.prog.major < 3) return vs.analysis;

    const psSemanticKeys = new Set(
        ps.prog.declarations
            .filter(d => d.reg.type === 1 /* INPUT */)
            .map(d => `${d.usage}:${d.usageIndex}`),
    );
    if (psSemanticKeys.size === 0) return vs.analysis;

    const outputBindings = new Map(vs.analysis.outputBindings);
    const writesTexcoord = new Set(vs.analysis.writesTexcoord);
    let changed = false;
    for (const dcl of vs.prog.declarations) {
        if (dcl.reg.type !== 6 /* OUTPUT */) continue;
        if (!psSemanticKeys.has(`${dcl.usage}:${dcl.usageIndex}`)) continue;

        const binding = bySemantic.get(`${dcl.usage}:${dcl.usageIndex}`)
            ?? mapPsInputSemantic(dcl.usage, dcl.usageIndex);
        if (binding.kind !== "texcoord") continue;
        const previous = outputBindings.get(dcl.reg.num);
        if (previous?.kind === "texcoord" && previous.index === binding.index) continue;
        outputBindings.set(dcl.reg.num, { kind: "texcoord", index: binding.index });
        writesTexcoord.add(binding.index);
        changed = true;
    }
    if (!changed) return vs.analysis;
    return { ...vs.analysis, outputBindings, writesTexcoord };
}

/** WebGPU's default maxInterStageShaderComponents is 60 (15 vec4 locations). */
function reportInterpolantBudget(
    interpColors: [boolean, boolean],
    interpTexcoords: readonly number[],
    needsFrontFacing: boolean,
    needsClipPlanes = false,
    needsFog = false,
): boolean {
    const locationLayout = interpLocationLayout(interpColors, interpTexcoords, needsFog);
    const vec4Fields = Number(interpColors[0]) + Number(interpColors[1]) + interpTexcoords.length;
    const userFields = vec4Fields + Number(needsFog) + (needsClipPlanes ? 6 : 0);
    // clipA carries four scalar distances and clipB carries the remaining two;
    // count their actual six components rather than treating all six as vec4s.
    const components = vec4Fields * 4 + Number(needsFog) + (needsClipPlanes ? 6 : 0);
    const maxLocation = Math.max(-1, ...locationLayout.used);
    const clipLocations = needsClipPlanes
        ? clipPlaneLocations(interpColors, interpTexcoords, needsFog)
        : null;
    const maxLocationWithClips = clipLocations
        ? Math.max(maxLocation, clipLocations.a, clipLocations.b)
        : maxLocation;
    const overComponents = components > 60;
    const overLocations = maxLocationWithClips >= 16;
    const duplicateLocations = locationLayout.collisions.size > 0;
    if (overComponents || overLocations || duplicateLocations) {
        Logger.warn(
            LogCategory.D3D9,
            `[D3D9] PS3 interpolant budget exceeded: ${userFields} vec4 fields / ` +
            `${components} components, max @location(${maxLocationWithClips}), ` +
            `duplicate locations=${[...locationLayout.collisions].join(",") || "none"}, ` +
            `front_facing=${needsFrontFacing}; the link is refused by its caller`,
        );
    }
    return overComponents || overLocations || duplicateLocations;
}

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
    pixelCenterOffset = 0.5,
    needsFog = false,
): string {
    const pos = inputExprs.get(PT_LOC_POSITION) ?? "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
    const vw = Math.max(1, viewportWidth), vh = Math.max(1, viewportHeight);
    const emitter = new Emitter();
    emitter.line(`@vertex`);
    emitter.line(`fn vs_main(in: VsInput) -> Interp {`);
    emitter.line(`    var out: Interp;`);
    emitter.line(`    let _p = ${pos};`);
    emitter.line(`    let _rhw = _p.w;`);
    emitter.line(`    let _clipW = select(1.0, 1.0 / _rhw, _rhw != 0.0);`);
    emitter.line(`    let _clipX = (((_p.x + ${pixelCenterOffset.toFixed(1)}) / ${vw.toFixed(1)}) * 2.0 - 1.0) * _clipW;`);
    emitter.line(`    let _clipY = (1.0 - ((_p.y + ${pixelCenterOffset.toFixed(1)}) / ${vh.toFixed(1)}) * 2.0) * _clipW;`);
    emitter.line(`    out.pos = vec4<f32>(_clipX, _clipY, clamp(_p.z, 0.0, 1.0) * _clipW, _clipW);`);
    for (const i of [0, 1] as const) {
        if (!interpColors[i]) continue;
        const e = inputExprs.get(PT_LOC_COLOR + i);
        emitter.line(`    out.${colField(i)} = ${e ?? (i === 0 ? "vec4<f32>(1.0)" : "vec4<f32>(0.0, 0.0, 0.0, 1.0)")};`);
    }
    for (const n of interpTexcoords) {
        const e = inputExprs.get(PT_LOC_TEXCOORD + n);
        emitter.line(`    out.${texField(n)} = ${e ?? "vec4<f32>(0.0, 0.0, 0.0, 1.0)"};`);
    }
    if (needsFog) {
        const spec = inputExprs.get(PT_LOC_COLOR + 1) ?? "vec4<f32>(1.0)";
        emitter.line(`    out.fog = clamp((${spec}).a, 0.0, 1.0);`);
    }
    emitter.line(`    return out;`);
    emitter.line(`}`);
    return emitter.toString();
}

/** A program's own use of the D3D9 integer (i#) and boolean (b#) constant files. */
function usesIntegerOrBooleanConstants(prog: SmProgram): boolean {
    const isIntBool = (type: number): boolean =>
        type === RegType.CONSTINT || type === RegType.CONSTBOOL;
    for (const def of prog.definitions) if (isIntBool(def.reg.type)) return true;
    for (const ins of prog.instructions) {
        if (ins.dst && isIntBool(ins.dst.reg.type)) return true;
        for (const source of ins.src) if (isIntBool(source.reg.type)) return true;
    }
    return false;
}

/** The result shape for a variant that cannot be generated: inert, and loud if built anyway. */
function refuseLink(refused: LinkRefusal): LinkResult {
    return {
        refused,
        wgsl: `// link refused: ${refused.reason} — ${refused.detail}`,
        vertexAttributes: [],
        arrayStride: 0,
        vertexBuffers: [],
        vsConstantCount: 0,
        psConstantCount: 0,
        hasTexture: false,
        cubeMask: 0,
        volumeMask: 0,
        vertexVolumeMask: 0,
        census: { vs: new Census().summary(), ps: null },
        comparisonMask: 0,
        interpolantBudgetExceeded: false,
        vsStorageSlotBytes: 0,
    };
}

export function linkProgram(opts: LinkOptions): LinkResult {
    const { vs, ps, declElements, streamStride, alphaTest = null } = opts;
    // The instance-storage VsUniforms carries the float bank only — the integer and boolean
    // banks would multiply every instance slot by ~4x for values the eligible programs never
    // read. Refuse such a program HERE, so the emitter can never reference a bank the linker
    // did not declare; the device's own MegaBatch eligibility test is then a second line
    // rather than the only one. `vsStorageSlotBytes: 0` also declines the variant for a
    // caller that only reads that field.
    if (opts.vsConstantMode === "instance-storage" && usesIntegerOrBooleanConstants(vs.prog)) {
        return refuseLink({
            reason: "vs-integer-boolean-in-instance-storage",
            detail: "the vertex shader reads i#/b# constants, which the instance-storage bank omits",
        });
    }
    const cubeMaskOverride = opts.cubeMask;
    const projectedStages = opts.projectedStages ?? 0;
    const comparisonSamplers = opts.comparisonSamplers;
    const compactPs = ps ? compactPsSemanticBindings(ps) : null;
    const vsA = patchVsSemanticOutputs(vs, ps, compactPs?.bySemantic);
    const psA = compactPs?.analysis ?? null;

    // A POSITIONT declaration owns the vertex stage, so clip planes are not
    // programmable in this link (fixed-function pre-transformed path has no
    // clip-plane lowering here).
    const preTransformed = (opts.preTransformed && declElements && declElements.length > 0)
        ? opts.preTransformed : null;
    const clipPlanes = opts.clipPlanes === true && preTransformed === null;
    const needsProgrammableFog = ps !== null && ps.prog.major < 3;

    // ── Interpolant set (union of VS-written and PS-read) ──────────────────
    const interpColors: [boolean, boolean] = [
        vsA.writesColor[0] || (psA?.readsColor[0] ?? false),
        vsA.writesColor[1] || (psA?.readsColor[1] ?? false),
    ];
    const texcoordSet = new Set<number>(vsA.writesTexcoord);
    if (psA) for (const n of psA.readsTexcoord) texcoordSet.add(n);
    const interpTexcoords = [...texcoordSet].sort((a, b) => a - b);
    const interpolantBudgetExceeded = reportInterpolantBudget(
        interpColors,
        interpTexcoords,
        psA?.readsVFace ?? false,
        clipPlanes,
        needsProgrammableFog,
    );

    // ── Vertex input reconciliation against the active declaration ─────────
    // A pre-transformed declaration takes the vertex stage away from the shader, so the inputs
    // come from the declaration itself; everything downstream is unchanged.
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
    let comparisonMask = 0;
    if (ps && comparisonSamplers) {
        for (const stage of comparisonSamplers instanceof Map || comparisonSamplers instanceof Set
            ? comparisonSamplers.keys()
            : []) {
            if (stage >= 0 && stage < PROG_BIND.MAX_TEX) comparisonMask |= 1 << stage;
        }
    }

    const vsConstantCount = vsA.constantCount;
    const psConstantCount = psA?.constantCount ?? 0;

    // ── Assemble module ────────────────────────────────────────────────────
    const emitter = new Emitter();
    const vsCensus = new Census();
    const psCensus = ps ? new Census() : null;
    emitUniformDeclarations(emitter, {
        vsBinding: PROG_BIND.VS_UNIFORM,
        psBinding: PROG_BIND.PS_UNIFORM,
        // Reserve the hidden pixel-centre vec4, the point-size sidecar vec4, and when
        // requested six clip-plane vec4 equations after the guest c# bank. The guest bank
        // itself is unchanged.
        vsConstantCount: vsConstantCount + 2 + (clipPlanes ? 6 : 0),
        psConstantCount,
        hasPixelShader: ps !== null,
        usesLegacyBumpEnv: psA?.usesLegacyBumpEnv ?? false,
        ffpStages: FFP_MAX_STAGES,
        vsConstantMode: opts.vsConstantMode,
    });
    // Per-stage cube-sampler mask: a cube sampler declares texture_cube<f32> + samples with a
    // 3-component direction (ps-codegen). The bind-group layout's viewDimension must match. The
    // override (dcl_cube ∪ bound-cube at draw time) lets ps_1_x/no-dcl shaders sample a bound cube.
    const cubeMask = cubeMaskOverride ?? computeCubeMask(ps);
    const volumeMask = opts.volumeMask ?? computeVolumeMask(ps);
    const vertexVolumeMask = opts.vertexVolumeMask ?? computeVertexVolumeMask(vs);
    emitBindLayout(emitter, {
        hasTexture,
        fragSamplers,
        cubeMask,
        volumeMask,
        vertexVolumeMask,
        programmablePixel: ps !== null,
        samplerBinding: PROG_BIND.SAMPLER,
        textureBase: PROG_BIND.TEX_BASE,
        hybridSamplerBase: PROG_BIND.HYBRID_SAMPLER_BASE,
        comparisonMask,
    });
    emitter.line("");

    emitter.line(`struct VsInput {`);
    for (const f of fields) emitter.line(`    ${f},`);
    emitter.line(`}`);
    emitter.line("");

    emitInterpStruct(
        emitter,
        interpColors,
        interpTexcoords,
        psA?.readsVFace ?? false,
        psA?.writesDepth ?? false,
        psA?.centroidInputs,
        needsProgrammableFog,
        clipPlanes,
    );
    emitter.line("");

    emitter.line(preTransformed
        ? emitPreTransformedVsMain(interpColors, interpTexcoords, inputExprs,
            preTransformed.viewportWidth, preTransformed.viewportHeight,
            preTransformed.pixelCenterOffset ?? 0.5, needsProgrammableFog)
        : emitVsMain(vs.prog, vsA, {
            interpColors,
            interpTexcoords,
            interpFog: needsProgrammableFog,
            inputExprs,
            constantCount: vsConstantCount,
            pixelCentreSlot: vsConstantCount,
            pointSizeSlot: vsConstantCount + 1,
            volumeMask: vertexVolumeMask,
            samplerStates: opts.samplerStates,
            census: vsCensus,
            pointExpansion: opts.pointExpansion === true,
            pointSpriteEnable: opts.pointSpriteEnable === true,
            clipPlanes,
            clipPlaneSlot: vsConstantCount + 2,
            instanceStorage: opts.vsConstantMode === "instance-storage",
        }));
    emitter.line("");

    if (ps) {
        emitter.line(emitPsMain(ps.prog, psA!, alphaTest, cubeMask, projectedStages,
            needsProgrammableFog ? {
                enabled: "psc.fogParams.w > 0.0",
                mode: "psc.fogParams.w",
                start: "psc.fogParams.x",
                end: "psc.fogParams.y",
                density: "psc.fogParams.z",
                color: "psc.fogColor",
                clipZ: "((in.pos).z / max((in.pos).w, 1e-8))",
                clipW: "(in.pos).w",
                specularAlpha: "in.fog",
            } : null,
            psCensus, comparisonSamplers, volumeMask, opts.samplerStates, clipPlanes));
    } else {
        emitter.line(emitHybridFixedFunctionFragment(
            interpColors[0], interpColors[1], interpTexcoords, hybridStageCount, alphaTest,
            cubeMask, projectedStages, volumeMask, opts.samplerStates, clipPlanes,
        ));
    }

    return {
        refused: null,
        wgsl: emitter.toString(),
        vertexAttributes: attributes,
        arrayStride: stride,
        vertexBuffers,
        // The hidden c[] vec4 for runtime pixel-centre dx/dy is not part of the
        // guest-visible LinkResult count; it is part of the WGSL struct and per-draw snapshot.
        vsConstantCount,
        psConstantCount,
        hasTexture,
        cubeMask,
        volumeMask,
        vertexVolumeMask,
        census: { vs: vsCensus.summary(), ps: psCensus?.summary() ?? null },
        comparisonMask,
        interpolantBudgetExceeded,
        vsStorageSlotBytes: opts.vsConstantMode === "instance-storage"
            ? (vsConstantCount + 2 + (clipPlanes ? 6 : 0)) * 16
            : 0,
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
        return `@fragment\nfn fs_main(in: PsInput) -> @location(0) vec4<f32> {\n    return ${ret};\n}`;
    }
    return `@fragment\nfn fs_main(in: PsInput) -> @location(0) vec4<f32> {\n    let _c = ${ret};\n    ${atest}\n    return _c;\n}`;
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
    volumeMask: number, samplerStates?: ReadonlyMap<number, SamplerSpec>, clipPlanes = false,
): string {
    const color = hasColor ? `in.${colField(0)}` : "vec4<f32>(1.0)";
    const specular = hasSpecular ? `in.${colField(1)}` : "vec4<f32>(0.0)";
    const arg = (sel: string, stage: number): string =>
        `ffpStageArg(${sel}, _t, _cur, _diff, _spec, _tmp, psc.tfactor, psc.stageConstants[${stage}])`;
    const stage = (s: number): string => {
        // D3DTSS_TEXCOORDINDEX configures the fixed-function VERTEX pipeline. It does not
        // remap a programmable VS's oT# outputs: fixed-function pixel stage N consumes oTN.
        const coordSet = hybridTexcoordSetForStage(s, texcoords);
        const raw = coordSet === null
            ? "vec4<f32>(0.0, 0.0, 0.0, 1.0)"
            : `in.${texField(coordSet)}`;
        const cube = ((cubeMask >> s) & 1) !== 0;
        const volume = ((volumeMask >> s) & 1) !== 0;
        const projected = ((projectedStages >> s) & 1) !== 0;
        const coord = cube
            ? `${raw}.xyz`
            : volume
                ? `${raw}.xyz`
            : projected
                ? `(${raw}.xy / max(abs(${raw}.w), 1e-8))`
                : `${raw}.xy`;
        const sample = emitTextureSample({
            stage: s,
            coordinate: coord,
            dimensions: cube || volume ? 3 : 2,
            cube,
            samplerSpec: samplerStates?.get(s),
        });
        return `
    if (u32(psc.stages[${s}].a.x) != 1u) {
        var _t = ${sample};
        // Alpha-less D3D formats read alpha as 1.0 on real hardware; our GPU copies carry a
        // live alpha channel that must be masked.
        if (psc.stages[${s}].b.z > 0.5) { _t = vec4<f32>(_t[0], _t[1], _t[2], 1.0); }
        let _cur = _c;
        // COLORARG0 | ALPHAARG0<<8 | resultIsTemp<<16 (see FfpStage in ffp-lighting.ts).
        let _x = u32(psc.stages[${s}].b.w);
        let _toTemp = (_x >> 16u) != 0u;
        // D3DTSS_RESULTARG: the stage reads CURRENT/TEMP as arguments either way, but writes
        // only the selected register — and an unwritten channel keeps ITS old value.
        let _dst = select(_c, _tmp, _toTemp);
        let _a0 = ${arg("_x & 0xffu", s)};
        let _a1 = ${arg(`u32(psc.stages[${s}].a.y)`, s)};
        let _a2 = ${arg(`u32(psc.stages[${s}].a.z)`, s)};
        let _rgb = ffpStageOp(u32(psc.stages[${s}].a.x), _a0, _a1, _a2, _t, _cur, _diff, psc.tfactor, _dst);
        var _al = _dst.a;
        if (u32(psc.stages[${s}].a.w) != 1u) {
            let _b0 = ${arg("(_x >> 8u) & 0xffu", s)};
            let _b1 = ${arg(`u32(psc.stages[${s}].b.x)`, s)};
            let _b2 = ${arg(`u32(psc.stages[${s}].b.y)`, s)};
            _al = ffpStageOp(u32(psc.stages[${s}].a.w), _b0, _b1, _b2, _t, _cur, _diff, psc.tfactor, _dst).a;
        }
        let _out = vec4<f32>(clamp(_rgb.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(_al, 0.0, 1.0));
        if (_toTemp) { _tmp = _out; } else { _c = _out; }
    }`;
    };
    return `
${emitFfpCombinerWgsl("dst")}
@fragment
fn fs_main(in: PsInput) -> @location(0) vec4<f32> {
    ${clipPlanes ? "if (in.clipA.x < 0.0 || in.clipA.y < 0.0 || in.clipA.z < 0.0 || in.clipA.w < 0.0 || in.clipB.x < 0.0 || in.clipB.y < 0.0) { discard; }" : ""}
    let _diff = ${color};
    let _spec = ${specular};
    // c0.x is a harness-only diagnostic selector: 1=texture0, 2=vertex colour, 3=white.
    // It is dynamic uniform state, so it deliberately does not affect pipeline caching.
    if (psc.c[0].x > 0.5) {
        if (psc.c[0].x > 2.5) { return vec4<f32>(1.0); }
        if (psc.c[0].x > 1.5) { return ${hasColor ? "_diff" : "vec4<f32>(1.0, 0.0, 1.0, 1.0)"}; }
        return textureSample(tex0, samp, ${texcoords.includes(0) ? `in.${texField(0)}.xy` : "vec2<f32>(0.0)"});
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
        default: throw new Error(`unsupported D3DDECLTYPE ${type}`);
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
    } else if (declElements) {
        // D3D8/FVF declarations normally carry the legacy v# explicitly.  The FVF
        // conversion intentionally leaves PSIZE's `reg` absent because it is not a
        // generic D3D9 input location, but the D3D8 compatibility register is fixed:
        // D3DDECLUSAGE_PSIZE is D3DVSDE_PSIZE, i.e. v4.  Without this recovery a
        // vs_1_1 that reads v4 emits an `in.v4` accessor without declaring that field;
        // naga rejects the whole module and the point-size output is effectively lost.
        const legacyReg = (element: RawVertexElement): number | undefined =>
            element.reg ?? (element.usage === Usage.PSIZE && element.usageIndex === 0
                ? LEGACY_PSIZE_INPUT_REGISTER : undefined);
        specs = declElements
            .map(e => ({ reg: legacyReg(e), elem: e }))
            .filter((spec): spec is { reg: number; elem: RawVertexElement } => spec.reg !== undefined);
    } else {
        specs = [];
    }

    for (const spec of specs) {
        const field = `in.v${spec.reg}`;
        let info: DeclTypeInfo;
        let offset: number;
        let stream: number;

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
            // A declared shader input without a matching vertex declaration has
            // no legal attribute offset.  Supplying zero keeps the pipeline
            // layout valid and matches D3D's default for an unbound element.
            inputExprs.set(spec.reg, "vec4<f32>(0.0)");
            continue;
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
