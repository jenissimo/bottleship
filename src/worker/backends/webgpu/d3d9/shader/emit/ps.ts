/**
 * ps-codegen.ts — pixel-shader IR → WGSL fragment function.
 *
 * Implements the ps_1_1-1_4 register-combiner model (r0 = color output, t#
 * texture/coord registers seeded from the iterated texcoords, [-1,1] constant
 * clamping) plus the ps_2_0 arithmetic subset. Texture sampling targets a
 * shared sampler `samp` and per-stage textures `texN`, declared by the linker.
 */

import { SmProgram, SmRegister, SmSource } from "../sm-parser";
import { RegType, Op, TexType, Usage } from "../sm-enums";
import {
    COMPONENTS, ShaderCtx, srcExpr, predicateLaneExpr, scalarPredicateExpr, colField, texField,
    relativeIndexExpr, maskVec4, AlphaTest, alphaTestSnippet,
} from "./expr";
import { emitAlu, emitAluExpression, safeMul } from "./alu";
import { emitTexOp, emitSampleDerivatives, type ComparisonSamplerSet } from "./tex";
import { emitPredicateStore } from "./store";
import { genericInterpolantSlot } from "./semantics";
import { Emitter } from "../emitter";
import { analyzeRegisterUsage } from "../passes/analyze";
import { structureProgram } from "../passes/structure";
import { planUniformity, type AffineExpr } from "../passes/uniformity";
import { Census } from "../census";
import { emitFlow, type FlowInstructionContext } from "./flow";
import { FFP_FOG_WGSL } from "../../ffp-fog";
import type { SamplerSpec } from "../../../shared/dx-sampler";

export interface PsAnalysis {
    constantCount: number;
    readsColor: [boolean, boolean];
    /** Pixel outputs written by the shader. oC0 is always declared for the PS ABI; the
     * remaining slots are declared only when the bytecode writes them. Optional keeps the
     * direct emitter test seam source-compatible with hand-built analyses. */
    writesColor?: [boolean, boolean, boolean, boolean];
    /** texcoord/texture-register indices the PS consumes (interp inputs). */
    readsTexcoord: Set<number>;
    /** texture stages sampled (binding allocation). */
    samplers: Set<number>;
    /** Per-stage declared sampler texture type (dcl_2d / dcl_cube / dcl_volume).
     *  Drives texture_cube<f32> codegen + the cube bind-group layout. */
    samplerTexType: Map<number, TexType>;
    defConsts: Map<number, Float32Array>;
    defInts: Map<number, Int32Array>;
    defBools: Map<number, boolean>;
    maxTemp: number;
    isPs14: boolean;
    /** True if the fragment samples a texture (needs the shared sampler). */
    samplesTexture: boolean;
    /** ps_1_x TEXBEM/TEXBEML read the per-destination-stage bump-environment
     * matrix (and, for TEXBEML, luminance scale/offset) from texture-stage
     * state. The linker appends that state after the c# register file. */
    usesLegacyBumpEnv: boolean;
    /** PS3 generic v# register → declared interpolator semantic. */
    inputBindings: Map<number, PsInputBinding>;
    /** WGSL @location values that require centroid interpolation. */
    centroidInputs?: Set<number>;
    /** dcl write masks keyed by the declared input register. */
    inputMasks?: ReadonlyMap<number, number>;
    /** SM3 miscellaneous inputs used by the program. */
    readsVPos: boolean;
    readsVFace: boolean;
    /** The shader writes the scalar oDepth register. */
    writesDepth: boolean;
}

/** ps_3_0 exposes c0-c223 to the pixel stage; ps_2_0 exposes only c0-c31. The
 *  larger file is allocated for every model on purpose: one constant-buffer
 *  layout keeps SetPixelShaderConstantF from depending on the bound shader. */
export const PS_FLOAT_REGISTER_COUNT = 224;

export type PsInputBinding =
    | { kind: "color"; index: number; usage: number; centroid?: boolean }
    | { kind: "texcoord"; index: number; usage: number; centroid?: boolean }
    | { kind: "position"; index: number; usage: number; centroid?: boolean };

/**
 * Expressions for the fixed-function fog state consumed by a programmable PS epilogue.
 *
 * The linker/device seam intentionally owns the source of these expressions. Keeping the
 * emitter independent of the render-state uniform layout lets the PS codegen reuse the same
 * `ffpFogFactor` shape as the FFP path without moving any uniform or device-state ownership
 * into the shader emitter.
 */
export interface PsPixelFogExpressions {
    enabled: string;
    mode: string;
    start: string;
    end: string;
    density: string;
    color: string;
    clipZ?: string;
    clipW?: string;
    specularAlpha?: string;
    /** Optional eye-space distance for range fog; programmable PS currently leaves it absent. */
    eyeDistance?: string;
}

/**
 * Map a SM3 dcl semantic to the small interpolant ABI used by this backend.
 * COLOR/TEXCOORD keep their historical slots.  The remaining linkable semantics
 * get stable generic slots instead of silently becoming vec4(0).  POSITION is the
 * rasterizer position builtin and therefore does not consume an interpolant.
 *
 * The generic slots intentionally remain explicit: if a shader asks for more
 * inter-stage data than WebGPU can expose, linkProgram reports that at the seam
 * rather than hiding the failure in a zero expression.
 */
export function mapPsInputSemantic(usage: number, usageIndex: number): PsInputBinding {
    if (usage === Usage.COLOR && usageIndex <= 1) {
        return { kind: "color", index: usageIndex, usage };
    }
    if (usage === Usage.TEXCOORD) {
        return { kind: "texcoord", index: usageIndex, usage };
    }
    if (usage === Usage.POSITION || usage === Usage.POSITIONT || usage === Usage.DEPTH) {
        return { kind: "position", index: usageIndex, usage };
    }

    // Keep the common SM3 generic declarations in deterministic, non-overlapping
    // slots. FOG/DEPTH are conventionally single-index inputs; DEPTH is handled
    // above as the rasterizer position. Extra indices advance from the base.
    return { kind: "texcoord", index: genericInterpolantSlot(usage, usageIndex), usage };
}

export function analyzePs(prog: SmProgram): PsAnalysis {
    const usage = analyzeRegisterUsage(prog);
    const readsColor: [boolean, boolean] = [false, false];
    const writesColor: [boolean, boolean, boolean, boolean] = [false, false, false, false];
    const readsTexcoord = new Set<number>();
    const isPs14 = prog.major === 1 && prog.minor === 4;

    const inputBindings = new Map<number, PsInputBinding>();
    const centroidInputs = new Set<number>();
    const inputMasks = new Map<number, number>();
    if (prog.major >= 3) {
        for (const dcl of prog.declarations) {
            if (dcl.reg.type !== RegType.INPUT) continue;
            const binding = mapPsInputSemantic(dcl.usage, dcl.usageIndex);
            inputBindings.set(dcl.reg.num, binding);
            inputMasks.set(dcl.reg.num, dcl.writeMask);
            if (dcl.centroid && binding.kind !== "position") {
                centroidInputs.add(binding.kind === "color" ? binding.index : 2 + binding.index);
            }
        }
    }

    let readsVPos = false;
    let readsVFace = false;
    let writesDepth = false;

    const implicitInputBinding = (regNum: number): PsInputBinding =>
        inputBindings.get(regNum) ?? mapPsInputSemantic(Usage.TEXCOORD, regNum);

    const noteTexReg = (reg: SmRegister) => {
        if (reg.type === RegType.TEXTURE) readsTexcoord.add(reg.num);
        if (reg.type === RegType.INPUT) {
            if (prog.major >= 3) {
                const binding = implicitInputBinding(reg.num);
                if (binding?.kind === "color" && binding.index <= 1) readsColor[binding.index] = true;
                else if (binding?.kind === "texcoord") readsTexcoord.add(binding.index);
            } else if (reg.num <= 1) {
                readsColor[reg.num] = true;
            }
        }
        if (reg.type === RegType.MISCTYPE) {
            if (reg.num === 0) readsVPos = true;
            if (reg.num === 1) readsVFace = true;
        }
    };

    // Texture-addressing ops that actually sample a texture (so a texN binding
    // must be declared for the dst register's stage in ps_1_x).
    const SAMPLING_OPS = new Set<number>([
        Op.TEX, Op.TEXBEM, Op.TEXBEML, Op.TEXREG2AR, Op.TEXREG2GB, Op.TEXREG2RGB,
        Op.TEXM3x2TEX, Op.TEXM3x3TEX, Op.TEXM3x3SPEC, Op.TEXM3x3VSPEC,
        Op.TEXDP3TEX,
    ]);
    const samplers = new Set<number>(prog.samplersUsed);
    let usesLegacyBumpEnv = false;

    for (const ins of prog.instructions) {
        if (ins.dst?.reg.type === RegType.DEPTHOUT ||
            ins.opcode === Op.TEXDEPTH || ins.opcode === Op.TEXM3x2DEPTH) writesDepth = true;
        if (ins.dst?.reg.type === RegType.COLOROUT && ins.dst.reg.num < writesColor.length) {
            writesColor[ins.dst.reg.num] = true;
        }
        if (ins.opcode === Op.TEXBEM || ins.opcode === Op.TEXBEML || ins.opcode === Op.BEM) {
            usesLegacyBumpEnv = true;
        }
        for (const s of ins.src) {
            noteTexReg(s.reg);
            // A relative v[aL+N] read can select any declared v# at runtime.
            // Keep every semantic family alive in the linker-facing analysis;
            // otherwise a statically unused interpolant may be omitted even
            // though the dynamic read can reach it.
            if (prog.major >= 3 && s.reg.type === RegType.INPUT && s.reg.relative) {
                for (const binding of inputBindings.values()) {
                    if (binding.kind === "color" && binding.index <= 1) readsColor[binding.index] = true;
                    else if (binding.kind === "texcoord") readsTexcoord.add(binding.index);
                }
            }
        }
        // ps_1_1-1_3: tex/texcoord dst is a texcoord register (iterated input).
        if (ins.dst && !isPs14 && prog.major === 1 &&
            (ins.opcode === Op.TEX || ins.opcode === Op.TEXCOORD ||
             ins.opcode === Op.TEXKILL || ins.opcode === Op.TEXDP3) &&
            ins.dst.reg.type === RegType.TEXTURE) {
            readsTexcoord.add(ins.dst.reg.num);
        }
        // Every ps_1_x t# is an iterated coordinate register before the shader
        // writes it, and writeRegName spells a texture destination `t{n}`
        // unconditionally. Declaring only the READ stages leaves an instruction
        // whose destination is never read afterwards (texreg2*, texdepth)
        // assigning to a variable that was never declared.
        if (ins.dst && prog.major === 1 && ins.dst.reg.type === RegType.TEXTURE) {
            readsTexcoord.add(ins.dst.reg.num);
        }
        // ps_1_x sampling ops use the dst register number as the sampler stage.
        if (ins.dst && prog.major === 1 && SAMPLING_OPS.has(ins.opcode) &&
            ins.dst.reg.type === RegType.TEXTURE) {
            samplers.add(ins.dst.reg.num);
        }
        // Legacy texture instructions take their base/matrix-row coordinates
        // from the destination stage's interpolated coordinate set. TEXM3x3*
        // also consumes the two preceding row stages (their .w values form the
        // non-constant eye ray for VSPEC). Include them explicitly so linker
        // declarations match the WGSL references even when the VS did not write
        // every coordinate (then its normal zero fallback is used).
        if (ins.dst && prog.major === 1 && ins.dst.reg.type === RegType.TEXTURE) {
            const stage = ins.dst.reg.num;
            if (ins.opcode === Op.TEXBEM || ins.opcode === Op.TEXBEML ||
                ins.opcode === Op.TEXM3x2PAD || ins.opcode === Op.TEXM3x3PAD) {
                readsTexcoord.add(stage);
            }
            if (ins.opcode === Op.TEXM3x2TEX || ins.opcode === Op.TEXM3x2DEPTH) {
                readsTexcoord.add(stage);
                if (stage >= 1) readsTexcoord.add(stage - 1);
            }
            if (ins.opcode === Op.TEXM3x3TEX || ins.opcode === Op.TEXM3x3SPEC ||
                ins.opcode === Op.TEXM3x3VSPEC || ins.opcode === Op.TEXM3x3) {
                readsTexcoord.add(stage);
                if (stage >= 1) readsTexcoord.add(stage - 1);
                if (stage >= 2) readsTexcoord.add(stage - 2);
            }
        }
    }

    const defConsts = new Map<number, Float32Array>();
    const defInts = new Map<number, Int32Array>();
    const defBools = new Map<number, boolean>();
    for (const def of prog.definitions) {
        if (def.reg.type === RegType.CONST && def.kind === "f") defConsts.set(def.reg.num, def.values);
        if (def.reg.type === RegType.CONSTINT && def.kind === "i") defInts.set(def.reg.num, def.rawInt);
        if (def.reg.type === RegType.CONSTBOOL && def.kind === "b") defBools.set(def.reg.num, def.rawInt[0] !== 0);
    }

    // Sampler texture-type from dcl_<type> sN declarations (SM2+). ps_1_x has no sampler
    // dcls — those stages default to 2D (cube reflections are an SM2+/SM3 feature).
    const samplerTexType = new Map<number, TexType>();
    for (const dcl of prog.declarations) {
        if (dcl.reg.type === RegType.SAMPLER) {
            samplerTexType.set(dcl.reg.num, (dcl.textureType as TexType) || TexType.D2);
        }
    }

    return {
        // i# and b# live in their own fixed banks; they do not extend the c# array.
        // Relative c[] reads can select any pixel constant, so size the WGSL
        // array to the complete API register file. Static reads are bounded to
        // the same file below; no out-of-range access can become a silent zero.
        constantCount: prog.usesRelativeConst
            ? PS_FLOAT_REGISTER_COUNT
            : Math.min(PS_FLOAT_REGISTER_COUNT, Math.max(0, usage.maxConst + 1)),
        readsColor,
        writesColor,
        readsTexcoord,
        samplers,
        samplerTexType,
        defConsts,
        defInts,
        defBools,
        maxTemp: usage.maxTemp,
        isPs14,
        samplesTexture: samplers.size > 0,
        usesLegacyBumpEnv,
        inputBindings,
        centroidInputs,
        inputMasks,
        readsVPos,
        readsVFace,
        writesDepth,
    };
}

export function emitPsMain(
    prog: SmProgram,
    a: PsAnalysis,
    alphaTest: AlphaTest | null = null,
    cubeMask: number = 0,
    projectedStages: number = 0,
    pixelFog: PsPixelFogExpressions | null = null,
    /** Census to record this emit's opcode dispositions into — see VsEmitOptions.census. */
    censusIn: Census | null = null,
    comparisonSamplers?: ComparisonSamplerSet,
    /** Effective 3-D volume sampler stages (shader declaration ∪ bound resource). */
    volumeMask: number = 0,
    /** Sampler state used to bake D3D address/LOD semantics into this shader variant. */
    samplerStates?: ReadonlyMap<number, SamplerSpec>,
    /** Emit programmable D3D9 user clip-plane tests at fragment invocation. */
    clipPlanes = false,
): string {
    const ps1x = prog.major === 1;
    const writesColor: [boolean, boolean, boolean, boolean] = [
        true,
        a.writesColor?.[1] ?? false,
        a.writesColor?.[2] ?? false,
        a.writesColor?.[3] ?? false,
    ];
    const extraColorOutputs = writesColor.slice(1).some(Boolean);
    const needsOutputStruct = a.writesDepth || (!ps1x && extraColorOutputs);
    const maxConstIdx = Math.max(0, a.constantCount - 1);
    const blocks = structureProgram(prog);
    const census = censusIn ?? new Census();
    const uniformity = planUniformity(blocks, { census });
    let activeLoopLocal: string | null = null;

    const defLiteral = (values: Float32Array): string =>
        `vec4<f32>(${fmt(values[0])}, ${fmt(values[1])}, ${fmt(values[2])}, ${fmt(values[3])})`;
    const relativeConstExpr = (index: string): string => {
        const bounded = `clamp(${index}, 0, ${maxConstIdx})`;
        let result = `psc.c[${bounded}]`;
        // A dynamic c[aL+N] read must observe shader-local def c# values as
        // well as the runtime constant bank.
        for (const [num, values] of [...a.defConsts].reverse()) {
            result = `select(${result}, ${defLiteral(values)}, (${bounded}) == ${num})`;
        }
        return result;
    };

    const constExpr = (num: number): string => {
        const bounded = Math.min(Math.max(0, num), Math.max(0, maxConstIdx));
        const base = prog.usesRelativeConst
            ? relativeConstExpr(`${num}`)
            : (a.defConsts.has(num) ? `dc${num}` : `psc.c[${bounded}]`);
        return ps1x ? `clamp(${base}, vec4<f32>(-1.0), vec4<f32>(1.0))` : base;
    };

    const inputExpr = (regNum: number): string => {
        const binding = a.inputBindings.get(regNum)
            ?? mapPsInputSemantic(Usage.TEXCOORD, regNum);
        let value: string;
        if (binding.kind === "color") value = `in.${colField(binding.index)}`;
        else if (binding.kind === "texcoord") value = `in.${texField(binding.index)}`;
        else value = `in.pos`;
        return maskVec4(value, a.inputMasks?.get(regNum) ?? 0xF);
    };
    const inputRegs = [...a.inputBindings.keys()].sort((x, y) => x - y);
    const relativeInputExpr = (index: string): string => {
        const bounded = `clamp(${index}, 0, 15)`;
        let result = "vec4<f32>(0.0)";
        for (const regNum of [...inputRegs].reverse()) {
            result = `select(${result}, ${inputExpr(regNum)}, (${bounded}) == ${regNum})`;
        }
        return result;
    };

    const ctx: ShaderCtx = {
        isPs: true,
        major: prog.major,
        minor: prog.minor,
        readReg(reg: SmRegister, relativeSource?: SmSource): string {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.INPUT: {
                    if (prog.major < 3) return `in.${colField(reg.num)}`;
                    if (relativeSource) {
                        const index = relativeIndexExpr(
                            relativeSource.relReg,
                            relativeSource.relSwizzle,
                            ctx,
                        );
                        return relativeInputExpr(`${index} + ${reg.num}`);
                    }
                    return inputExpr(reg.num);
                }
                case RegType.MISCTYPE:
                    if (reg.num === 0) {
                        return `vec4<f32>((in.pos).xy - vec2<f32>(0.5), (in.pos).zw)`;
                    }
                    if (reg.num === 1) {
                        return `select(vec4<f32>(-1.0), vec4<f32>(1.0), in.frontFacing)`;
                    }
                    return `vec4<f32>(0.0)`;
                case RegType.TEXTURE: return `t${reg.num}`;
                case RegType.CONST:
                    if (relativeSource) {
                        const index = relativeIndexExpr(
                            relativeSource.relReg,
                            relativeSource.relSwizzle,
                            ctx,
                        );
                        const relative = relativeConstExpr(`${index} + ${reg.num}`);
                        return ps1x
                            ? `clamp(${relative}, vec4<f32>(-1.0), vec4<f32>(1.0))`
                            : relative;
                    }
                    return constExpr(reg.num);
                case RegType.CONSTINT:
                    if (a.defInts.has(reg.num)) {
                        const def = a.defInts.get(reg.num)!;
                        return `vec4<f32>(${def[0]}, ${def[1]}, ${def[2]}, ${def[3]})`;
                    }
                    return `vec4<f32>(psc.i[${reg.num}])`;
                case RegType.CONSTBOOL:
                    if (a.defBools.has(reg.num)) {
                        return a.defBools.get(reg.num) ? `vec4<f32>(1.0)` : `vec4<f32>(0.0)`;
                    }
                    return `select(vec4<f32>(0.0), vec4<f32>(1.0), psBool(${reg.num}u))`;
                case RegType.LOOP: return `vec4<f32>(f32(${activeLoopLocal ?? "0"}))`;
                case RegType.PREDICATE: return `select(vec4<f32>(0.0), vec4<f32>(1.0), p${reg.num})`;
                case RegType.COLOROUT:
                    return !ps1x && reg.num >= 0 && reg.num < writesColor.length && writesColor[reg.num]
                        ? `oC${reg.num}` : `vec4<f32>(0.0)`;
                default: return `vec4<f32>(0.0)`;
            }
        },
        writeRegName(reg: SmRegister): string | null {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.TEXTURE: return `t${reg.num}`;
                case RegType.COLOROUT:
                    return !ps1x && reg.num >= 0 && reg.num < writesColor.length && writesColor[reg.num]
                        ? `oC${reg.num}` : null;
                case RegType.DEPTHOUT: return null;
                default: return null;
            }
        },
    };

    const body = new Emitter();

    // Register declarations.
    const maxTemp = Math.max(0, a.maxTemp); // ps_1_x output is r0 — always present
    for (let r = 0; r <= maxTemp; r++) body.line(`var r${r}: vec4<f32> = vec4<f32>(0.0);`);
    const predicateRegisters = collectPredicateRegisters(blocks);
    for (const predicate of predicateRegisters) body.line(`var p${predicate}: vec4<bool> = vec4<bool>(false);`);
    for (const n of [...a.readsTexcoord].sort((x, y) => x - y)) {
        body.line(`var t${n}: vec4<f32> = in.${texField(n)};`);
    }
    if (!ps1x) {
        for (let i = 0; i < writesColor.length; i++) {
            if (writesColor[i]) body.line(`var oC${i}: vec4<f32> = vec4<f32>(0.0);`);
        }
    }
    if (a.writesDepth) body.line(`var oDepth: f32 = 0.0;`);
    if (!prog.usesRelativeConst) {
        for (const [num, vals] of a.defConsts) {
            body.line(`let dc${num} = ${defLiteral(vals)};`);
        }
    }
    body.line("");
    if (clipPlanes) {
        body.line("if (in.clipA.x < 0.0 || in.clipA.y < 0.0 || in.clipA.z < 0.0 || in.clipA.w < 0.0 || in.clipB.x < 0.0 || in.clipB.y < 0.0) { discard; }");
    }

    let uid = 0;
    const m3PadCount = new Map<number, number>();
    emitFlow(blocks, {
        emitter: body,
        census,
        uniformity,
        sourceExpr(source, lexical) {
            activeLoopLocal = lexical.loopLocal;
            return srcExpr(source, ctx);
        },
        booleanExpr(source, lexical) {
            activeLoopLocal = lexical.loopLocal;
            if (source.reg.type === RegType.CONSTBOOL) {
                if (a.defBools.has(source.reg.num)) return a.defBools.get(source.reg.num) ? "true" : "false";
                return `psBool(${source.reg.num}u)`;
            }
            if (source.reg.type === RegType.PREDICATE) {
                return scalarPredicateExpr(source, ctx);
            }
            return `((${srcExpr(source, ctx)}).x != 0.0)`;
        },
        integerComponent(source, component, lexical) {
            activeLoopLocal = lexical.loopLocal;
            return `i32(round((${srcExpr(source, ctx)}).${component}))`;
        },
        derivative(plan, lexical) {
            activeLoopLocal = lexical.loopLocal;
            const source = plan.coordinateSources[0];
            const affine = plan.coordinateExpression
                ? affineExprWgsl(plan.coordinateExpression, ctx)
                : null;
            const coordinate = source
                ? implicitSampleCoordinate(
                    plan.instruction,
                    prog,
                    a,
                    affine ?? srcExpr(source, ctx),
                    cubeMask,
                    volumeMask,
                    projectedStages,
                )
                : "vec2<f32>(0.0)";
            return emitSampleDerivatives(body, coordinate);
        },
        instruction(ins, info: FlowInstructionContext) {
            activeLoopLocal = info.lexical.loopLocal;
            ctx.activePredicate = ins.predicate;
            if (ins.opcode === Op.SETP) {
                if (emitPredicateStore(ins, ctx, body)) census.record(ins.opcode, "ok");
                else {
                    census.record(ins.opcode, "unsupported");
                }
                return;
            }
            if (ins.dst?.reg.type === RegType.DEPTHOUT) {
                emitDepthStore(ins, ctx, body);
                census.record(ins.opcode, "ok");
                return;
            }
            if (ins.opcode === Op.TEXKILL) {
                emitTexKill(ins, prog, a, ctx, body);
                census.record(ins.opcode, "ok");
                return;
            }
            if (emitTexOp(ins, prog, a, ctx, body, uid, cubeMask, projectedStages, m3PadCount, {
                uniformity,
                derivatives: info.derivatives,
                comparisonSamplers,
                volumeMask,
                samplerStates,
            })) {
                if (!uniformity.sampleFor(ins)) census.record(ins.opcode, "ok");
                uid++;
                return;
            }
            if (emitAlu(ins, ctx, body, uid++)) {
                census.record(ins.opcode, "ok");
            } else {
                census.record(ins.opcode, "unsupported");
            }
        },
    });
    census.assertLinkable();

    body.line("");
    const outVar = ps1x ? "r0" : "oC0";
    // outVar is a mutable var; `oC0.a` is a swizzle view, `oC0[3]` is a plain lane load.
    const atest = alphaTestSnippet(alphaTest, `${outVar}[3]`);
    if (atest) body.line(atest);
    const fog = emitPsPixelFog(prog.major, outVar, pixelFog);
    if (fog) body.line(fog);
    if (needsOutputStruct) {
        body.line("var out: PsOutput;");
        body.line(`out.color = ${outVar};`);
        for (let i = 1; i < writesColor.length; i++) {
            if (writesColor[i]) body.line(`out.color${i} = oC${i};`);
        }
        if (a.writesDepth) body.line("out.depth = oDepth;");
        body.line("return out;");
    } else {
        body.line(`return ${outVar};`);
    }

    const outputType = needsOutputStruct ? "PsOutput" : "@location(0) vec4<f32>";
    const fogPrelude = fog ? `${FFP_FOG_WGSL}\n\n` : "";
    const outputStruct = needsOutputStruct ? [
        "struct PsOutput {",
        "    @location(0) color: vec4<f32>,",
        ...writesColor.slice(1).flatMap((written, i) => written
            ? [`    @location(${i + 1}) color${i + 1}: vec4<f32>,`] : []),
        ...(a.writesDepth ? ["    @builtin(frag_depth) depth: f32,"] : []),
        "}",
        "",
    ].join("\n") : "";
    return `${fogPrelude}${outputStruct}@fragment\nfn fs_main(in: PsInput) -> ${outputType} {\n    ${body.toString().replace(/\n/g, "\n    ")}\n}`;
}

/** Rebuild the address consumed by an implicit TEX sample at its uniform derivative anchor. */
function implicitSampleCoordinate(
    instruction: SmProgram["instructions"][number],
    prog: SmProgram,
    analysis: PsAnalysis,
    source: string,
    cubeMask: number,
    volumeMask: number,
    projectedStages: number,
): string {
    const destinationStage = instruction.dst?.reg.num ?? 0;
    const stage = instruction.opcode === Op.TEX && prog.major >= 2 && !analysis.isPs14
        ? (instruction.src[1]?.reg.num ?? destinationStage)
        : destinationStage;
    const isCube = ((cubeMask >> stage) & 1) !== 0;
    const isVolume = ((volumeMask >> stage) & 1) !== 0;
    const ps1x13 = prog.major === 1 && !analysis.isPs14;
    const projected = instruction.opcode === Op.TEX && (
        (prog.major >= 2 && (instruction.specificData & 1) !== 0)
        || (ps1x13 && ((projectedStages >> stage) & 1) !== 0)
    );
    const address = projected ? `((${source}) / (${source}).w)` : `(${source})`;
    return `${address}.${isCube || isVolume ? "xyz" : "xy"}`;
}

/** Emit the uniform-anchor expression reconstructed by the affine pass. */
function affineExprWgsl(expr: AffineExpr, ctx: ShaderCtx): string {
    switch (expr.kind) {
        case "source":
            return srcExpr(expr.source, ctx);
        case "add":
            return `(${affineExprWgsl(expr.left, ctx)} + ${affineExprWgsl(expr.right, ctx)})`;
        case "sub":
            return `(${affineExprWgsl(expr.left, ctx)} - ${affineExprWgsl(expr.right, ctx)})`;
        case "mul":
            return safeMul(affineExprWgsl(expr.left, ctx), affineExprWgsl(expr.right, ctx));
        case "mad":
            return `(${safeMul(affineExprWgsl(expr.left, ctx), affineExprWgsl(expr.right, ctx))} + ${affineExprWgsl(expr.add, ctx)})`;
        case "lerp":
            return `mix(${affineExprWgsl(expr.right, ctx)}, ${affineExprWgsl(expr.left, ctx)}, ${affineExprWgsl(expr.factor, ctx)})`;
    }
}

/**
 * Emit D3D9's post-PS fixed-function fog operation.
 *
 * Alpha testing deliberately remains before this block and the assignment preserves the
 * shader-produced alpha. SM3 pixel shaders do not receive this fixed-function operation.
 */
export function emitPsPixelFog(
    major: number,
    colorVar: string,
    fog: PsPixelFogExpressions | null,
): string | null {
    if (major >= 3 || fog === null) return null;

    const clipZ = fog.clipZ ?? "(in.pos).z";
    const clipW = fog.clipW ?? "(in.pos).w";
    const specularAlpha = fog.specularAlpha ?? "1.0";
    const eyeDistance = fog.eyeDistance ?? "0.0";
    return [
        `if (${fog.enabled}) {`,
        `    let _psFogFactor = ffpFogFactor(${fog.mode}, ${fog.start}, ${fog.end}, ${fog.density}, ${clipZ}, ${clipW}, ${specularAlpha}, ${eyeDistance});`,
        `    ${colorVar} = vec4<f32>(mix(vec3<f32>(${colorVar}[0], ${colorVar}[1], ${colorVar}[2]), (${fog.color}).rgb, _psFogFactor), ${colorVar}[3]);`,
        `}`,
    ].join("\n");
}

function collectPredicateRegisters(blocks: readonly import("../ir").Block[]): number[] {
    const result = new Set<number>();
    const visitSource = (source: SmSource | undefined) => {
        if (source?.reg.type === RegType.PREDICATE) result.add(source.reg.num);
    };
    const visit = (items: readonly import("../ir").Block[]) => {
        for (const block of items) {
            if (block.kind === "instrs") {
                for (const instruction of block.instrs) {
                    if (instruction.dst?.reg.type === RegType.PREDICATE) result.add(instruction.dst.reg.num);
                    for (const source of instruction.src) visitSource(source);
                    visitSource(instruction.predicate);
                }
            } else if (block.kind === "if") {
                visitSource(block.cond.kind === "cmp" ? block.cond.a : block.cond.src);
                if (block.cond.kind === "cmp") visitSource(block.cond.b);
                visit(block.then);
                if (block.else_) visit(block.else_);
            } else if (block.kind === "rep") {
                visitSource(block.count);
                visit(block.body);
            } else if (block.kind === "loop") {
                visitSource(block.counter);
                visit(block.body);
            } else if (block.cond) {
                visitSource(block.cond.kind === "cmp" ? block.cond.a : block.cond.src);
                if (block.cond.kind === "cmp") visitSource(block.cond.b);
            }
        }
    };
    visit(blocks);
    return [...result].sort((a, b) => a - b);
}

/** oDepth is a scalar D3D output and is always clamped to the depth range. */
function emitDepthStore(
    ins: SmProgram["instructions"][number],
    ctx: ShaderCtx,
    body: Emitter,
): void {
    const dst = ins.dst;
    if (!dst || (dst.writeMask & 1) === 0 || ins.src.length === 0) return;
    // oDepth is a destination, not an implicit MOV. Evaluate the complete
    // instruction first so mad/rcp/dp/etc. retain their real result before the
    // scalar depth write masks it down to x.
    const result = emitAluExpression(ins, { ...ctx, instruction: ins });
    let value = result !== null
        ? `(${result}).x`
        : `(${srcExpr(ins.src[0]!, ctx)}).x`;
    if (dst.shift !== 0) {
        const multiplier = dst.shift > 0
            ? (1 << dst.shift).toFixed(1)
            : (1 / (1 << -dst.shift)).toString();
        value = `((${value}) * ${multiplier})`;
    }
    if (dst.saturate) {
        // Bind before the select, which names the value three times.
        const raw = body.tmp("sat");
        body.line(`let ${raw} = ${value};`);
        value = `select(0.0, min(max(${raw}, 0.0), 1.0), (${raw}) == (${raw}))`;
    }
    const predicate = ctx.activePredicate ? scalarPredicateExpr(ctx.activePredicate, ctx) : null;
    const next = `min(max(${value}, 0.0), 1.0)`;
    body.line(`oDepth = ${predicate ? `select(oDepth, ${next}, ${predicate})` : next};`);
}

/**
 * ps_1_1-1_3 historically tests texkill.xyz.  SM2+ applies the destination
 * write mask to the kill source, so a scalar `.x` kill does not accidentally
 * discard on unrelated y/z components.
 */
function emitTexKill(
    ins: SmProgram["instructions"][number],
    prog: SmProgram,
    a: PsAnalysis,
    ctx: ShaderCtx,
    body: Emitter,
): void {
    const dst = ins.dst;
    if (!dst) return;
    const ps1x13 = prog.major === 1 && !a.isPs14;
    const coord = ps1x13 ? `in.${texField(dst.reg.num)}` : ctx.readReg(dst.reg);
    const mask = ps1x13 ? 0x7 : dst.writeMask & 0xF;
    const terms = COMPONENTS
        .map((_component, lane) => lane)
        .filter(lane => (mask & (1 << lane)) !== 0)
        .map(lane => {
            // `coord` is r# or a t#-style interpolant register: index the lane instead of
            // swizzling a mutable var (Tint SwizzleView).
            const kill = `(${coord})[${lane}] < 0.0`;
            return ctx.activePredicate
                ? `${predicateLaneExpr(ctx.activePredicate, lane, ctx)} && (${kill})`
                : kill;
        });
    if (terms.length > 0) {
        const kill = terms.join(" || ");
        body.line(`if (${kill}) { discard; }`);
    }
}

function fmt(v: number): string {
    if (!isFinite(v)) return v > 0 ? "3.4e38" : (v < 0 ? "-3.4e38" : "0.0");
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
