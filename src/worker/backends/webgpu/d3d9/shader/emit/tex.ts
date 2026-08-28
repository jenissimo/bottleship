/** Pixel texture-op emission, kept separate from the shared ALU table. */

import { SmProgram, SmRegister } from "../sm-parser";
import { RegType, Op, opName } from "../sm-enums";
import { ShaderCtx, srcExpr, texField } from "./expr";
import { emitStore } from "./store";
import { Emitter } from "../emitter";
import type { PsAnalysis } from "./ps";
import type { UniformityPlan, SamplePlan } from "../passes/uniformity";
import type { SamplerSpec } from "../../../shared/dx-sampler";

export interface TextureSampleDerivatives {
    readonly ddx: string;
    readonly ddy: string;
}

export interface TextureSampleRequest {
    readonly stage: number;
    readonly coordinate: string;
    /** Full source coordinate used to obtain Dref before the texture coordinate is sliced. */
    readonly depthCoordinate?: string;
    readonly plan?: SamplePlan;
    /** Explicit opcode lowering; implicit samples continue to use UniformityPlan. */
    readonly mode?: "grad" | "level";
    /** LOD for an explicit textureSampleLevel operation (texldl uses coord.w). */
    readonly level?: string;
    readonly bias?: string;
    /** Emit a depth comparison sample instead of a colour sample. */
    readonly comparison?: boolean;
    /** True for a cube direction. Three-dimensional non-cube coordinates use volume addressing. */
    readonly cube?: boolean;
    /** Number of address dimensions; Dref is read from coord[dimensions]. */
    readonly dimensions?: 2 | 3;
    /** Dref scaling used by D3D8/D3D9 depth formats (0 means no scaling). */
    readonly drefScaleShift?: number;
    /** D32F-on-UNORM compatibility clamp from DXVK's depth path. */
    readonly clampDref?: boolean;
    /** Override only when a future binding layout deliberately changes the default names. */
    readonly texture?: string;
    readonly sampler?: string;
    /** D3D sampler semantics baked into this linked shader variant. */
    readonly samplerSpec?: SamplerSpec;
}

export interface DepthComparisonOptions {
    /** 16 for D16, 24 for D24S8; zero leaves a normalized Dref unchanged. */
    readonly drefScaleShift?: number;
    /** Clamp the reference after scaling, as required by D32F depth emulation. */
    readonly clampDref?: boolean;
}

/**
 * The map form carries the format-specific Dref policy. A set is accepted for callers whose
 * depth resource is already normalized; it keeps the sample seam small for focused emit tests.
 */
export type ComparisonSamplerSet =
    | ReadonlyMap<number, DepthComparisonOptions>
    | ReadonlySet<number>;

export interface TexEmissionOptions {
    /** W3 supplies the plan while walking structured flow; legacy callers remain unchanged. */
    readonly uniformity?: UniformityPlan;
    /** Derivatives emitted by the flow walker at the plan's anchor block. */
    readonly derivatives?: ReadonlyMap<SmProgram["instructions"][number], TextureSampleDerivatives>;
    /** Stages whose bound resource is a depth texture sampled through a comparison sampler. */
    readonly comparisonSamplers?: ComparisonSamplerSet;
    /** Effective 3-D volume sampler stages (shader declaration ∪ bound resource). */
    readonly volumeMask?: number;
    /** Sampler state used to bake D3D address/LOD semantics into this shader variant. */
    readonly samplerStates?: ReadonlyMap<number, SamplerSpec>;
}

/** Emit derivative temporaries at the anchor selected by the uniformity pass. */
export function emitSampleDerivatives(
    body: Emitter,
    coordinate: string,
): TextureSampleDerivatives {
    const ddx = body.tmp("ddx");
    const ddy = body.tmp("ddy");
    body.line(`let ${ddx} = dpdx(${coordinate});`);
    body.line(`let ${ddy} = dpdy(${coordinate});`);
    return { ddx, ddy };
}

/**
 * Single sample-emission seam. Uniformity planning chooses the operation; this function owns
 * the WGSL spelling and keeps the programmable binding contract at texN + stage sampler.
 */
export function emitTextureSample(
    request: TextureSampleRequest,
    derivatives?: TextureSampleDerivatives,
): string {
    const texture = request.texture ?? `tex${request.stage}`;
    // Binding 2 remains the stage-0 programmable sampler for W0.2 compatibility. The
    // additional stage samplers occupy the existing hybrid-sampler window.
    const sampler = request.sampler ?? (request.stage === 0 ? "samp" : `samp${request.stage}`);
    const addressed = addressCoordinate(
        request.coordinate, request.samplerSpec, request.dimensions ?? 2, request.cube === true,
    );
    const coordinate = addressed.coordinate;
    const plan = request.plan;
    const mode = request.mode ?? plan?.mode;

    if (mode === "refuse") {
        throw new Error(
            `D3D9 implicit texture sample ${request.stage} has a divergent non-affine coordinate; ` +
            "refusing link instead of substituting LOD 0",
        );
    }

    if (request.comparison) {
        const dref = formatDref(
            request.depthCoordinate ?? request.coordinate,
            request.dimensions ?? 2,
            request.drefScaleShift ?? 0,
            request.clampDref === true,
        );
        // WGSL has no textureSampleCompareGrad or arbitrary-LOD compare overload. Ordinary
        // texld can use the native implicit compare, but texldb/texldd and a sampler LOD bias
        // need the same implicit-derivative LOD selected explicitly before comparison.  This
        // keeps comparison samplers valid while preserving the D3D9 bias/gradient semantics.
        const explicitBias = addLodBias(request.bias, request.samplerSpec?.mipLodBias);
        const compareLevel = mode === "level"
            ? addLodBias(request.level ?? "0.0", request.samplerSpec?.mipLodBias) ?? "0.0"
            : (mode === "grad" || explicitBias !== undefined)
                ? implicitCompareLod(texture, coordinate, explicitBias, derivatives)
                : null;
        const sample = compareLevel !== null
            ? `textureSampleCompareLevel(${texture}, ${sampler}, ${coordinate}, ${dref}, ${compareLevel})`
            : `textureSampleCompare(${texture}, ${sampler}, ${coordinate}, ${dref})`;
        // D3D texture destinations are vec4 registers even though a depth compare produces one
        // scalar. Splating here keeps the existing store/swizzle seam unchanged.
        const border = borderCompare(request.samplerSpec, dref);
        return addressed.outside
            ? `select(vec4<f32>(${sample}), ${border}, ${addressed.outside})`
            : `vec4<f32>(${sample})`;
    }

    if (mode === "level") {
        const level = addLodBias(request.level ?? "0.0", request.samplerSpec?.mipLodBias);
        return withBorder(
            `textureSampleLevel(${texture}, ${sampler}, ${coordinate}, ${level})`,
            addressed.outside, request.samplerSpec,
        );
    }
    if (mode === "grad") {
        const explicit = derivatives ?? {
            ddx: `dpdx(${coordinate})`,
            ddy: `dpdy(${coordinate})`,
        };
        // texldb carries a per-fragment bias in coord.w.  WGSL has no bias
        // overload for explicit gradients, so fold both the instruction bias
        // and the sampler-state bias into the footprint before sampling.
        const scale = lodBiasGradientScale(
            addLodBias(request.bias, request.samplerSpec?.mipLodBias),
        );
        const ddx = scale === null ? explicit.ddx : `(${explicit.ddx}) * ${scale}`;
        const ddy = scale === null ? explicit.ddy : `(${explicit.ddy}) * ${scale}`;
        return withBorder(
            `textureSampleGrad(${texture}, ${sampler}, ${coordinate}, ${ddx}, ${ddy})`,
            addressed.outside, request.samplerSpec,
        );
    }
    const bias = addLodBias(request.bias, request.samplerSpec?.mipLodBias);
    if (bias !== undefined) {
        return withBorder(
            `textureSampleBias(${texture}, ${sampler}, ${coordinate}, ${bias})`,
            addressed.outside, request.samplerSpec,
        );
    }
    return withBorder(
        `textureSample(${texture}, ${sampler}, ${coordinate})`,
        addressed.outside, request.samplerSpec,
    );
}

/**
 * Reconstruct the implicit texture LOD for comparison sampling. WebGPU exposes no
 * textureSampleCompareGrad/textureSampleCompareBias, so comparison paths with an
 * explicit D3D bias or gradient use the standard 2-D footprint estimate and the
 * only arbitrary-LOD comparison primitive, textureSampleCompareLevel.
 *
 * Depth comparison resources in the D3D9 backend are 2-D views. Keep this helper
 * deliberately restricted to that contract; callers for cube/volume depth views
 * continue to use the native implicit comparison path rather than inventing a
 * different dimensionality rule.
 */
function implicitCompareLod(
    texture: string,
    coordinate: string,
    bias: string | undefined,
    derivatives?: TextureSampleDerivatives,
): string {
    const ddx = derivatives?.ddx ?? `dpdx(${coordinate})`;
    const ddy = derivatives?.ddy ?? `dpdy(${coordinate})`;
    const size = `vec2<f32>(textureDimensions(${texture}))`;
    const rho = `max(length((${ddx}) * ${size}), length((${ddy}) * ${size}))`;
    const base = `log2(max(${rho}, 1.0e-8))`;
    const biased = bias === undefined ? base : `((${base}) + ${bias})`;
    return `min(max(${biased}, 0.0), max(f32(textureNumLevels(${texture})) - 1.0, 0.0))`;
}

interface AddressedCoordinate {
    coordinate: string;
    outside: string | null;
}

/** Lower D3D's two non-native address modes around a normal WebGPU sampler. The sampler
 * descriptor is clamped on these axes (see DxSamplerCache), so clamped coordinates are also
 * safe for implicit derivatives. Cube directions intentionally bypass this transform: cube
 * sampling selects a face from a direction vector and D3D's address modes do not wrap faces. */
function addressCoordinate(
    coordinate: string,
    spec: SamplerSpec | undefined,
    dimensions: 2 | 3,
    cube: boolean,
): AddressedCoordinate {
    if (!spec || cube) return { coordinate, outside: null };
    const modes = [spec.addressU, spec.addressV, spec.addressW];
    const components = ["x", "y", "z"];
    const out: string[] = [];
    const outside: string[] = [];
    let changed = false;
    for (let i = 0; i < dimensions; i++) {
        const component = `(${coordinate}).${components[i]}`;
        const mode = modes[i];
        if (mode === "d3d9-mirror-once") {
            out.push(`clamp(abs(${component}), 0.0, 1.0)`);
            changed = true;
        } else if (mode === "d3d9-border") {
            out.push(`clamp(${component}, 0.0, 1.0)`);
            outside.push(`(${component} < 0.0 || ${component} > 1.0)`);
            changed = true;
        } else {
            out.push(component);
        }
    }
    return {
        coordinate: changed ? `vec${dimensions}<f32>(${out.join(", ")})` : coordinate,
        outside: outside.length > 0 ? outside.join(" || ") : null,
    };
}

function addLodBias(base: string | undefined, bias: number | undefined): string | undefined {
    if (base === undefined && (bias === undefined || bias === 0)) return undefined;
    if (base === undefined) return formatFloat(bias ?? 0);
    if (bias === undefined || bias === 0) return base;
    return `((${base}) + ${formatFloat(bias)})`;
}

/** Explicit gradients have no WGSL bias overload. Scaling them by 2^bias is equivalent to
 * adding the bias to the selected mip level. */
function lodBiasGradientScale(bias: string | undefined): string | null {
    if (bias === undefined) return null;
    return `exp2(${bias})`;
}

function borderColor(spec: SamplerSpec | undefined): string {
    const raw = spec?.borderColor ?? 0;
    const r = ((raw >>> 16) & 0xff) / 255;
    const g = ((raw >>> 8) & 0xff) / 255;
    const b = (raw & 0xff) / 255;
    const a = ((raw >>> 24) & 0xff) / 255;
    return `vec4<f32>(${formatFloat(r)}, ${formatFloat(g)}, ${formatFloat(b)}, ${formatFloat(a)})`;
}

function borderCompare(spec: SamplerSpec | undefined, dref: string): string {
    return `vec4<f32>(select(0.0, 1.0, (${dref}) <= ${borderColor(spec)}.x))`;
}

function withBorder(sample: string, outside: string | null, spec: SamplerSpec | undefined): string {
    return outside ? `select(${sample}, ${borderColor(spec)}, ${outside})` : sample;
}

function formatDref(coordinate: string, dimensions: 2 | 3, scaleShift: number, clampDref: boolean): string {
    const component = dimensions === 3 ? "w" : "z";
    let dref = `((${coordinate}).${component})`;
    const shift = Math.trunc(scaleShift);
    if (shift > 0) {
        const denominator = Math.pow(2, shift) - 1;
        dref = `(${dref} * (1.0 / ${formatFloat(denominator)}))`;
    }
    return clampDref ? `clamp(${dref}, 0.0, 1.0)` : dref;
}

function formatFloat(value: number): string {
    if (!Number.isFinite(value)) return "0.0";
    if (Number.isInteger(value)) return `${value}.0`;
    return `${value}`;
}

function comparisonOptions(
    samplers: ComparisonSamplerSet | undefined,
    stage: number,
): DepthComparisonOptions | undefined {
    if (!samplers) return undefined;
    if ("get" in samplers) return samplers.get(stage);
    return samplers.has(stage) ? {} : undefined;
}

function samplePlan(
    instruction: SmProgram["instructions"][number],
    options: TexEmissionOptions,
): { plan: SamplePlan | undefined; derivatives: TextureSampleDerivatives | undefined } {
    return {
        plan: options.uniformity?.sampleFor(instruction),
        derivatives: options.derivatives?.get(instruction),
    };
}

/** Handle texture-addressing opcodes; returns true if consumed. */
export function emitTexOp(
    ins: SmProgram["instructions"][number],
    prog: SmProgram,
    a: PsAnalysis,
    ctx: ShaderCtx,
    body: Emitter,
    uid: number,
    cubeMask: number,
    projectedStages: number,
    m3PadCount: Map<number, number>,
    options: TexEmissionOptions = {},
): boolean {
    const ps1x13 = prog.major === 1 && !a.isPs14;
    const d = ins.dst;

    switch (ins.opcode) {
        case Op.TEX: {
            if (!d) return true;
            let stage: number;
            let coordExpr: string;
            if (ps1x13) {
                stage = d.reg.num;
                coordExpr = `in.${texField(stage)}`;
            } else if (a.isPs14) {
                stage = d.reg.num;
                coordExpr = srcExpr(ins.src[0], ctx);
            } else {
                stage = ins.src.length >= 2 ? ins.src[1].reg.num : d.reg.num;
                coordExpr = srcExpr(ins.src[0], ctx);
            }
            // A cube sampler takes a 3-component direction; 2D takes uv.xy. Cube-ness is the
            // effective mask (shader dcl_cube ∪ a cube texture bound on this stage at draw time) —
            // ps_1_x has no sampler dcls, so a cube reflection there is detected via the binding.
            const isCube = ((cubeMask >> stage) & 1) !== 0;
            const isVolume = ((options.volumeMask ?? 0) >> stage) & 1;
            // Projective divide (by .w) — without it a projected spotlight/reflection collapses to a
            // flat square. Two disjoint sources: SM2+ carries texldp/texldb in the opcode-specific
            // control field (ins.specificData; texldp == HLSL tex2Dproj, texldb biases the mip LOD);
            // ps_1_1-1_3 has no in-shader projection and is driven by the stage's D3DTTFF_PROJECTED
            // flag (projectedStages bitmask). ps_1_4 projects via the _dw modifier (srcExpr) instead.
            const projSm2 = prog.major >= 2 && (ins.specificData & 1) !== 0;
            const biased = prog.major >= 2 && (ins.specificData & 2) !== 0;
            const projPs1x = ps1x13 && ((projectedStages >> stage) & 1) !== 0;
            const projected = projSm2 || projPs1x;
            const tc = `_tc${uid}`;
            body.line(`// tex (stage ${stage}${isCube ? ", cube" : ""}${projected ? ", proj.w" : ""}${biased ? ", bias" : ""})`);
            body.line(`let ${tc} = ${coordExpr};`);
            const projd = projected ? `((${tc}) / (${tc}).w)` : `(${tc})`;
            const coord = isCube || isVolume ? `${projd}.xyz` : `${projd}.xy`;
            const depth = comparisonOptions(options.comparisonSamplers, stage);
            const samplerSpec = options.samplerStates?.get(stage);
            const planned = samplePlan(ins, options);
            const sampleExpr = applySampleResultSwizzle(emitTextureSample({
                stage,
                coordinate: coord,
                depthCoordinate: projd,
                dimensions: isCube || isVolume ? 3 : 2,
                cube: isCube,
                plan: planned.plan,
                bias: biased ? `(${tc}).w` : undefined,
                comparison: depth !== undefined,
                samplerSpec,
                drefScaleShift: depth?.drefScaleShift,
                clampDref: depth?.clampDref,
            }, planned.derivatives), ins.src[1]?.swizzle);
            return emitStore(d, sampleExpr, ctx, body, uid);
        }
        case Op.TEXLDD: {
            if (!d) return true;
            if (options.uniformity?.isDerivativeRefused(ins)) {
                throw new Error(
                    `D3D9 ${opName(ins.opcode)} in dynamic control flow cannot be lowered to WGSL; refusing link`,
                );
            }
            const coordinateSource = ins.src[0] ?? defaultSrc(d.reg);
            const samplerSource = ins.src[1];
            const stage = samplerSource?.reg.num ?? d.reg.num;
            const isCube = ((cubeMask >> stage) & 1) !== 0;
            const isVolume = ((options.volumeMask ?? 0) >> stage) & 1;
            const coordinateValue = srcExpr(coordinateSource, ctx);
            const coordinate = sampleCoordinate(coordinateValue, isCube, !!isVolume);
            const ddx = sampleCoordinate(srcExpr(ins.src[2] ?? coordinateSource, ctx), isCube, !!isVolume);
            const ddy = sampleCoordinate(srcExpr(ins.src[3] ?? coordinateSource, ctx), isCube, !!isVolume);
            const depth = comparisonOptions(options.comparisonSamplers, stage);
            const samplerSpec = options.samplerStates?.get(stage);
            body.line(`// texldd (stage ${stage}${isCube ? ", cube" : ""})`);
            const sample = emitTextureSample({
                stage,
                coordinate,
                depthCoordinate: coordinateValue,
                dimensions: isCube || isVolume ? 3 : 2,
                cube: isCube,
                mode: "grad",
                comparison: depth !== undefined,
                samplerSpec,
                drefScaleShift: depth?.drefScaleShift,
                clampDref: depth?.clampDref,
            }, { ddx, ddy });
            return emitStore(d, applySampleResultSwizzle(sample, samplerSource?.swizzle), ctx, body, uid);
        }
        case Op.TEXLDL: {
            if (!d) return true;
            const coordinateSource = ins.src[0] ?? defaultSrc(d.reg);
            const samplerSource = ins.src[1];
            const stage = samplerSource?.reg.num ?? d.reg.num;
            const isCube = ((cubeMask >> stage) & 1) !== 0;
            const isVolume = ((options.volumeMask ?? 0) >> stage) & 1;
            const coordinateValue = srcExpr(coordinateSource, ctx);
            const depth = comparisonOptions(options.comparisonSamplers, stage);
            const samplerSpec = options.samplerStates?.get(stage);
            body.line(`// texldl (stage ${stage}${isCube ? ", cube" : ""})`);
            const sample = emitTextureSample({
                stage,
                coordinate: sampleCoordinate(coordinateValue, isCube, !!isVolume),
                depthCoordinate: coordinateValue,
                dimensions: isCube || isVolume ? 3 : 2,
                cube: isCube,
                mode: "level",
                level: `(${coordinateValue}).w`,
                comparison: depth !== undefined,
                samplerSpec,
                drefScaleShift: depth?.drefScaleShift,
                clampDref: depth?.clampDref,
            });
            return emitStore(d, applySampleResultSwizzle(sample, samplerSource?.swizzle), ctx, body, uid);
        }
        case Op.DSX:
        case Op.DSY: {
            if (!d) return true;
            if (options.uniformity?.isDerivativeRefused(ins)) {
                throw new Error(
                    `D3D9 ${opName(ins.opcode)} in dynamic control flow cannot be lowered to WGSL; refusing link`,
                );
            }
            const source = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            const planned = options.derivatives?.get(ins);
            const derivative = planned
                ? ins.opcode === Op.DSX ? planned.ddx : planned.ddy
                : ins.opcode === Op.DSX ? `dpdx(${source})` : `dpdy(${source})`;
            body.line(`// ${opName(ins.opcode)}`);
            return emitStore(d, derivative, ctx, body, uid);
        }
        case Op.TEXCOORD: {
            if (!d) return true;
            if (ps1x13) {
                const n = d.reg.num;
                body.line(`// texcoord`);
                return emitStore(d, `vec4<f32>(clamp((in.${texField(n)}).xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0)`, ctx, body, uid);
            } else {
                body.line(`// texcrd`);
                return emitStore(d, srcExpr(ins.src[0], ctx), ctx, body, uid);
            }
        }
        case Op.TEXDP3: {
            if (!d) return true;
            const coord = ps1x13 ? `in.${texField(d.reg.num)}` : ctx.readReg(d.reg);
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            return emitStore(d, `vec4<f32>(dot((${coord}).xyz, (${src}).xyz))`, ctx, body, uid);
        }
        case Op.TEXDP3TEX: {
            if (!d) return true;
            const stage = d.reg.num;
            const coord = ps1x13 ? `in.${texField(stage)}` : ctx.readReg(d.reg);
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            body.line(`// texdp3tex`);
            const planned = samplePlan(ins, options);
            return emitStore(d, emitTextureSample({
                stage,
                coordinate: `vec2<f32>(dot((${coord}).xyz, (${src}).xyz), 0.0)`,
                plan: planned.plan,
                samplerSpec: options.samplerStates?.get(stage),
            }, planned.derivatives), ctx, body, uid);
        }
        case Op.TEXBEM:
        case Op.TEXBEML: {
            if (!d || !ps1x13 || d.reg.type !== RegType.TEXTURE || ins.src.length < 1) return false;
            const stage = d.reg.num;
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            // D3D9 TEXBEM matrix placement is row-major by coordinate: u +=
            // MAT00*du + MAT10*dv, v += MAT01*du + MAT11*dv. D3D's V/U bump
            // formats are signed; our upload normalizes them to UNORM RGBA, so
            // recover the signed values here. This is texture-format decoding,
            // not the forbidden ps_1_1 source _bx2 modifier.
            const tc = `_bemTc${uid}`;
            const bump = `psc.bump[${stage}]`;
            body.line(`// ${opName(ins.opcode)} (D3DTSS_BUMPENV* on destination stage ${stage})`);
            body.line(`let _bemDuDv${uid} = (${src}).xy * 2.0 - vec2<f32>(1.0);`);
            const base = `_bemBase${uid}`;
            const raw = `(in.${texField(stage)})`;
            const projected = ((projectedStages >> stage) & 1) !== 0;
            body.line(`let ${base} = ${projected ? `(${raw} / (${raw}).w)` : raw};`);
            body.line(`let ${tc} = vec2<f32>(${base}.x + ${bump}.mat.x * _bemDuDv${uid}.x + ${bump}.mat.z * _bemDuDv${uid}.y, ${base}.y + ${bump}.mat.y * _bemDuDv${uid}.x + ${bump}.mat.w * _bemDuDv${uid}.y);`);
            const planned = samplePlan(ins, options);
            let sample = emitTextureSample({
                stage, coordinate: tc, plan: planned.plan, samplerSpec: options.samplerStates?.get(stage),
            }, planned.derivatives);
            if (ins.opcode === Op.TEXBEML) {
                sample = `(${sample} * ((${src}).z * ${bump}.lum.x + ${bump}.lum.y))`;
            }
            return emitStore(d, sample, ctx, body, uid);
        }
        case Op.TEXM3x3PAD: {
            // DXVK deliberately emits no code for PAD. The following TEXM3x* op
            // re-reads the matrix rows from the destination texture stages.
            body.line(`// texm3x3pad (no-op)`);
            return true;
        }
        case Op.TEXM3x2PAD: {
            // Like TEXM3x3PAD, this is an instruction-stream marker only.
            body.line(`// texm3x2pad (no-op)`);
            return true;
        }
        case Op.TEXM3x2TEX:
        case Op.TEXM3x3TEX:
        case Op.TEXM3x3SPEC:
        case Op.TEXM3x3VSPEC:
        case Op.TEXM3x3: {
            if (!d || !ps1x13 || d.reg.type !== RegType.TEXTURE || ins.src.length < 1) return false;
            const stage = d.reg.num;
            const count = ins.opcode === Op.TEXM3x2TEX ? 2 : 3;
            const firstStage = stage - count + 1;
            if (firstStage < 0) return false;
            if (ins.opcode === Op.TEXM3x3SPEC && ins.src.length < 2) return false;

            const source = `(${srcExpr(ins.src[0], ctx)}).xyz`;
            const rows = Array.from({ length: count }, (_, i) =>
                `dot((in.${texField(firstStage + i)}).xyz, ${source})`);
            const coordinate = `_m3Tc${uid}`;
            body.line(`// ${opName(ins.opcode)} (matrix rows ${firstStage}..${stage})`);
            body.line(`let ${coordinate} = vec4<f32>(${rows.join(", ")}, ${count === 2 ? "0.0, 0.0" : "0.0"});`);

            let sampleCoordinateValue = coordinate;
            if (ins.opcode === Op.TEXM3x3SPEC || ins.opcode === Op.TEXM3x3VSPEC) {
                const eye = ins.opcode === Op.TEXM3x3SPEC
                    ? `(${srcExpr(ins.src[1], ctx)}).xyz`
                    : `vec3<f32>((in.${texField(stage - 2)}).w, (in.${texField(stage - 1)}).w, (in.${texField(stage)}).w)`;
                const normal = `_m3Normal${uid}`;
                const eyeRay = `_m3Eye${uid}`;
                const reflection = `_m3Reflect${uid}`;
                body.line(`let ${normal} = normalize((${coordinate}).xyz);`);
                body.line(`let ${eyeRay} = normalize(${eye});`);
                body.line(`let ${reflection} = -reflect(${eyeRay}, ${normal});`);
                sampleCoordinateValue = `vec4<f32>(${reflection}, 0.0)`;
            }

            // TEXM3x3 is the matrix operation without the final lookup. Its
            // destination remains an ordinary texture register and receives
            // (u, v, w, 1), including the usual destination modifiers.
            if (ins.opcode === Op.TEXM3x3) {
                return emitStore(d, coordinate, ctx, body, uid);
            }

            const isCube = ((cubeMask >> stage) & 1) !== 0;
            const isVolume = ((options.volumeMask ?? 0) >> stage) & 1;
            const projected = legacyProjection(sampleCoordinateValue, stage, isCube, projectedStages);
            const planned = samplePlan(ins, options);
            return emitStore(d, emitTextureSample({
                stage,
                coordinate: isCube || isVolume ? `${projected}.xyz` : `${projected}.xy`,
                dimensions: isCube || isVolume ? 3 : 2,
                cube: isCube,
                plan: planned.plan,
                samplerSpec: options.samplerStates?.get(stage),
            }, planned.derivatives), ctx, body, uid);
        }
        case Op.TEXREG2AR:
        case Op.TEXREG2GB:
        case Op.TEXREG2RGB: {
            if (!d || !ps1x13 || d.reg.type !== RegType.TEXTURE || ins.src.length < 1) return false;
            const source = srcExpr(ins.src[0], ctx);
            const swizzle = ins.opcode === Op.TEXREG2AR ? "wxxx"
                : ins.opcode === Op.TEXREG2GB ? "yzzz" : "xyzz";
            const coordinate = `_texreg2${uid}`;
            const stage = d.reg.num;
            body.line(`// ${opName(ins.opcode)} (${swizzle})`);
            body.line(`let ${coordinate} = (${source}).${swizzle};`);
            const isCube = ((cubeMask >> stage) & 1) !== 0;
            const isVolume = ((options.volumeMask ?? 0) >> stage) & 1;
            const planned = samplePlan(ins, options);
            const projected = legacyProjection(coordinate, stage, isCube, projectedStages);
            return emitStore(d, emitTextureSample({
                stage,
                coordinate: isCube || isVolume ? `${projected}.xyz` : `${projected}.xy`,
                dimensions: isCube || isVolume ? 3 : 2,
                cube: isCube,
                plan: planned.plan,
                samplerSpec: options.samplerStates?.get(stage),
            }, planned.derivatives), ctx, body, uid);
        }
        case Op.TEXDEPTH: {
            if (!d || !a.isPs14 || d.reg.type !== RegType.TEMP || d.reg.num !== 5) return false;
            emitLegacyDepth(body, `(r5).x`, `(r5).y`, uid);
            return true;
        }
        case Op.TEXM3x2DEPTH: {
            if (!d || !ps1x13 || d.reg.type !== RegType.TEXTURE || ins.src.length < 1) return false;
            const stage = d.reg.num;
            if (stage < 1) return false;
            const source = `(${srcExpr(ins.src[0], ctx)}).xyz`;
            const z = `dot((in.${texField(stage - 1)}).xyz, ${source})`;
            const w = `dot((in.${texField(stage)}).xyz, ${source})`;
            body.line(`// texm3x2depth (matrix rows ${stage - 1}..${stage})`);
            emitLegacyDepth(body, z, w, uid);
            return true;
        }
        case Op.BEM: {
            if (!d || !a.isPs14 || ins.src.length < 2) return false;
            const src0 = srcExpr(ins.src[0], ctx);
            const src1 = srcExpr(ins.src[1], ctx);
            const bump = `psc.bump[${d.reg.num}]`;
            const result = `_bemResult${uid}`;
            body.line(`// bem (D3DTSS_BUMPENVMAT* on destination stage ${d.reg.num})`);
            body.line(`let ${result} = vec4<f32>((${src0}).x + ${bump}.mat.x * (${src1}).x + ${bump}.mat.z * (${src1}).y, (${src0}).y + ${bump}.mat.y * (${src1}).x + ${bump}.mat.w * (${src1}).y, 0.0, 0.0);`);
            return emitStore(d, result, ctx, body, uid);
        }
        default:
            return false;
    }
}

/** Legacy depth instructions define division by zero as the far plane. */
function emitLegacyDepth(body: Emitter, numerator: string, denominator: string, uid: number): void {
    const z = `_legacyDepthZ${uid}`;
    const w = `_legacyDepthW${uid}`;
    body.line(`let ${z} = ${numerator};`);
    body.line(`let ${w} = ${denominator};`);
    body.line(`oDepth = select(${z} / ${w}, 1.0, ${w} == 0.0);`);
}

function defaultSrc(reg: SmRegister) {
    return { reg, swizzle: 0xE4, modifier: 0 };
}

const SAMPLE_COMPONENTS = ["x", "y", "z", "w"] as const;

function sampleCoordinate(value: string, isCube: boolean, isVolume = false): string {
    return isCube || isVolume ? `(${value}).xyz` : `(${value}).xy`;
}

/** Apply the ps_1_x projected-stage divide after deriving a legacy coordinate. */
function legacyProjection(value: string, stage: number, isCube: boolean, projectedStages: number): string {
    if (isCube || ((projectedStages >> stage) & 1) === 0) return `(${value})`;
    return `((${value}) / (${value}).w)`;
}

/** SM3 puts the result swizzle on the sampler operand, not on the destination. */
function applySampleResultSwizzle(sample: string, swizzle: number | undefined): string {
    const sw = swizzle ?? 0xE4;
    const c0 = SAMPLE_COMPONENTS[sw & 3];
    const c1 = SAMPLE_COMPONENTS[(sw >>> 2) & 3];
    const c2 = SAMPLE_COMPONENTS[(sw >>> 4) & 3];
    const c3 = SAMPLE_COMPONENTS[(sw >>> 6) & 3];
    if (c0 === "x" && c1 === "y" && c2 === "z" && c3 === "w") return sample;
    return `(${sample}).${c0}${c1}${c2}${c3}`;
}
