/**
 * vs-codegen.ts — vertex-shader IR → WGSL.
 *
 * Emits the `vs_main` function body. The vertex input struct, its @location
 * attributes and the per-register expansion expressions are reconciled against
 * the active D3D9 vertex declaration by the linker (index.ts) and passed in,
 * because the same compiled VS can be paired with different declarations.
 */

import { SmProgram, SmRegister, SmSource } from "../sm-parser";
import { RegType, RASTOUT_POS, RASTOUT_FOG, RASTOUT_PTS, Usage, Op, TexType } from "../sm-enums";
import {
    COMPONENTS, ShaderCtx, srcExpr, predicateLaneExpr, scalarPredicateExpr, colField, texField,
    relativeIndexExpr, maskVec4, roundD3dExpr,
} from "./expr";
import { emitAlu } from "./alu";
import { emitPredicateStore, emitStore } from "./store";
import { genericInterpolantSlot } from "./semantics";
import { Emitter } from "../emitter";
import { analyzeRegisterUsage } from "../passes/analyze";
import { structureProgram } from "../passes/structure";
import { planUniformity } from "../passes/uniformity";
import { Census } from "../census";
import { emitFlow, type FlowInstructionContext } from "./flow";
import { emitTextureSample } from "./tex";
import type { SamplerSpec } from "../../../shared/dx-sampler";

/** Float constant registers a vs_3_0 device exposes (c0-c255) — the file
 *  SetVertexShaderConstantF writes into and the bound a relative read must span. */
export const VS_FLOAT_REGISTER_COUNT = 256;
const VS_INPUT_REGISTER_COUNT = 16;
const VS_OUTPUT_REGISTER_COUNT = 16;

/** D3D9 exposes four vertex-texture samplers at API stages 257..260. The
 * shader bytecode names the same slots s0..s3; the API-stage offset is kept
 * here so the mapping cannot accidentally drift into the pixel sampler set. */
const D3D_VERTEX_TEXTURE_SAMPLER_BASE = 257;
const VERTEX_TEXTURE_SAMPLER_COUNT = 4;

export interface VsOutputBinding {
    kind: "position" | "color" | "texcoord" | "fog" | "pointsize" | "drop";
    index: number;
}

export interface VsAnalysis {
    /** dcl_usage v# input declarations. */
    inputDcls: { usage: number; usageIndex: number; reg: number }[];
    /** dcl write masks keyed by the declared input register. */
    inputMasks?: ReadonlyMap<number, number>;
    constantCount: number;
    writesColor: [boolean, boolean];
    writesTexcoord: Set<number>;
    writesFog: boolean;
    /** A relative o# destination can reach any declared VS3 output register. */
    usesRelativeOutput: boolean;
    needsA0: boolean;
    maxTemp: number;
    /** def c# values keyed by register number. */
    defConsts: Map<number, Float32Array>;
    /** def i# values keyed by register number; definitions are inlined. */
    defInts: Map<number, Int32Array>;
    /** def b# values keyed by register number; definitions are inlined. */
    defBools: Map<number, boolean>;
    /** VS3 generic o# register → declared output semantic. */
    outputBindings: Map<number, VsOutputBinding>;
    /** dcl write masks keyed by the declared output register. */
    outputMasks?: ReadonlyMap<number, number>;
    /** VS vertex-sampler texture type declarations (dcl_2d / dcl_volume). */
    samplerTexType: Map<number, TexType>;
}

/**
 * Mirror of mapPsInputSemantic for a vs_3_0 `dcl_*` output. The pixel stage
 * places every declaration usage it does not recognise on a generic
 * interpolant; the vertex stage must place it identically, or a legal pair
 * links from one side only. "drop" is left for an output with no declaration
 * at all, which is malformed bytecode rather than an unplaceable semantic.
 */
export function mapVsOutputSemantic(usage: number, usageIndex: number): VsOutputBinding {
    if (usage === Usage.POSITION || usage === Usage.POSITIONT) return { kind: "position", index: usageIndex };
    if (usage === Usage.COLOR && usageIndex <= 1) return { kind: "color", index: usageIndex };
    if (usage === Usage.TEXCOORD) return { kind: "texcoord", index: usageIndex };
    if (usage === Usage.FOG) return { kind: "fog", index: usageIndex };
    if (usage === Usage.PSIZE) return { kind: "pointsize", index: usageIndex };
    return { kind: "texcoord", index: genericInterpolantSlot(usage, usageIndex) };
}

export function analyzeVs(prog: SmProgram): VsAnalysis {
    const writesColor: [boolean, boolean] = [false, false];
    const writesTexcoord = new Set<number>();
    let writesFog = false;
    let usesRelativeOutput = false;
    const usage = analyzeRegisterUsage(prog);
    let needsA0 = usage.usesRelativeConst;

    const inputMasks = new Map<number, number>();
    const outputMasks = new Map<number, number>();
    for (const dcl of prog.declarations) {
        if (dcl.reg.type === RegType.INPUT) inputMasks.set(dcl.reg.num, dcl.writeMask);
        if (dcl.reg.type === RegType.OUTPUT) outputMasks.set(dcl.reg.num, dcl.writeMask);
    }

    const outputBindings = new Map<number, VsOutputBinding>();
    if (prog.major >= 3) {
        for (const dcl of prog.declarations) {
            if (dcl.reg.type !== RegType.OUTPUT) continue;
            outputBindings.set(dcl.reg.num, mapVsOutputSemantic(dcl.usage, dcl.usageIndex));
        }
    }

    for (const ins of prog.instructions) {
        for (const source of ins.src) {
            if (source.relReg?.type === RegType.ADDR) needsA0 = true;
        }
        const d = ins.dst;
        if (!d) continue;
        if (d.reg.type === RegType.ADDR) needsA0 = true;
        if (d.relReg?.type === RegType.ADDR) needsA0 = true;
        if (prog.major >= 3 && d.reg.type === RegType.OUTPUT) {
            if (d.reg.relative) usesRelativeOutput = true;
            const binding = outputBindings.get(d.reg.num);
            if (binding?.kind === "color" && binding.index <= 1) writesColor[binding.index] = true;
            else if (binding?.kind === "texcoord") writesTexcoord.add(binding.index);
            else if (binding?.kind === "fog") writesFog = true;
            continue;
        }
        if (d.reg.type === RegType.ATTROUT) writesColor[d.reg.num === 1 ? 1 : 0] = true;
        if (d.reg.type === RegType.TEXCRDOUT) writesTexcoord.add(d.reg.num);
        if (d.reg.type === RegType.RASTOUT && d.reg.num === RASTOUT_FOG) writesFog = true;
    }

    if (usesRelativeOutput) {
        for (const binding of outputBindings.values()) {
            if (binding.kind === "color" && binding.index <= 1) writesColor[binding.index] = true;
            else if (binding.kind === "texcoord") writesTexcoord.add(binding.index);
            else if (binding.kind === "fog") writesFog = true;
        }
    }

    const inputDcls = prog.declarations
        .filter(d => d.reg.type === RegType.INPUT)
        .map(d => ({ usage: d.usage, usageIndex: d.usageIndex, reg: d.reg.num }));

    const defConsts = new Map<number, Float32Array>();
    const defInts = new Map<number, Int32Array>();
    const defBools = new Map<number, boolean>();
    for (const def of prog.definitions) {
        if (def.reg.type === RegType.CONST && def.kind === "f") defConsts.set(def.reg.num, def.values);
        if (def.reg.type === RegType.CONSTINT && def.kind === "i") defInts.set(def.reg.num, def.rawInt);
        if (def.reg.type === RegType.CONSTBOOL && def.kind === "b") defBools.set(def.reg.num, def.rawInt[0] !== 0);
    }

    const samplerTexType = new Map<number, TexType>();
    for (const dcl of prog.declarations) {
        if (dcl.reg.type === RegType.SAMPLER) {
            samplerTexType.set(dcl.reg.num, (dcl.textureType as TexType) || TexType.D2);
        }
    }

    // Relative addressing (c[a0+n]) can index anywhere in the register file, so the static
    // maxConst is no bound at all — size to the WHOLE file we advertise (vs_3_0 / 256 float
    // registers, the same file SetVertexShaderConstantF writes into). A smaller array does not
    // fail: the read is clamped to the last element, so a matrix-palette index past the array
    // silently resolves to one fixed bone and those vertices erupt from the mesh.
    let constantCount = Math.min(VS_FLOAT_REGISTER_COUNT, Math.max(0, prog.maxConst + 1));
    if (prog.usesRelativeConst) constantCount = VS_FLOAT_REGISTER_COUNT;

    return {
        inputDcls,
        inputMasks,
        constantCount,
        writesColor,
        writesTexcoord,
        writesFog,
        usesRelativeOutput,
        needsA0,
        maxTemp: usage.maxTemp,
        defConsts,
        defInts,
        defBools,
        outputBindings,
        outputMasks,
        samplerTexType,
    };
}

export interface VsEmitOptions {
    interpColors: [boolean, boolean];
    interpTexcoords: number[];      // sorted
    /** Carry the scalar fixed-function fog factor for a linked ps_1_x/ps_2_x. */
    interpFog?: boolean;
    /** vec4<f32> read expression per input register (referencing `in.vN`). */
    inputExprs: Map<number, string>;
    constantCount: number;
    /** Hidden c[] slot carrying runtime pixel-centre dx/dy. */
    pixelCentreSlot?: number;
    /** Hidden c[] slot carrying D3DRS_POINTSIZE, POINTSIZE_MIN and POINTSIZE_MAX. */
    pointSizeSlot?: number;
    /** Census to record this emit's opcode dispositions into. Passing one is how a caller
     *  reads what was actually emitted instead of inferring it from the generated text. */
    census?: Census;
    /** Effective 3-D VS vertex-texture stages (shader declaration ∪ bound volume). */
    volumeMask?: number;
    /** Sampler state used to bake D3D address/LOD semantics into this shader variant. */
    samplerStates?: ReadonlyMap<number, SamplerSpec>;
    /** Lower a D3DPT_POINTLIST draw to six duplicated vertices per point. WebGPU has no
     * programmable point-size output, so the vertex index selects one corner of the CPU
     * expansion and oPts is applied in clip space here. Non-point links record oPts as an
     * explicit approximation because D3D9 ignores point size for those primitives. */
    pointExpansion?: boolean;
    /** D3DRS_POINTSPRITEENABLE: replace point-list texture coordinates with corner UVs. */
    pointSpriteEnable?: boolean;
    /** Emit six D3D9 programmable user clip-plane signed distances. */
    clipPlanes?: boolean;
    /** First hidden c[] slot containing clip plane 0 (after pixel-centre c[]). */
    clipPlaneSlot?: number;
}

export function emitVsMain(prog: SmProgram, a: VsAnalysis, opts: VsEmitOptions): string {
    const maxConstIdx = Math.max(0, opts.constantCount - 1);
    const blocks = structureProgram(prog);
    const census = opts.census ?? new Census();
    const uniformity = planUniformity(blocks, { census });
    let activeLoopLocal: string | null = null;
    const inputRegs = [...new Set([
        ...a.inputDcls.map(d => d.reg),
        ...opts.inputExprs.keys(),
    ])].sort((x, y) => x - y);

    const inputExpr = (regNum: number): string =>
        maskVec4(opts.inputExprs.get(regNum) ?? `vec4<f32>(in.v${regNum})`, a.inputMasks?.get(regNum) ?? 0xF);

    const defLiteral = (values: Float32Array): string =>
        `vec4<f32>(${fmt(values[0])}, ${fmt(values[1])}, ${fmt(values[2])}, ${fmt(values[3])})`;
    const relativeConstExpr = (index: string): string => {
        const bounded = `clamp(${index}, 0, ${maxConstIdx})`;
        let result = `vsc.c[${bounded}]`;
        // Relative reads must see shader-local def c# values even though their
        // index is dynamic.  Keep the runtime uniform bank as the fallback.
        for (const [num, values] of [...a.defConsts].reverse()) {
            result = `select(${result}, ${defLiteral(values)}, (${bounded}) == ${num})`;
        }
        return result;
    };

    /** Relative v[aL] is a select over the declared VS input register file. */
    const relativeInputExpr = (index: string): string => {
        const bounded = `clamp(${index}, 0, ${VS_INPUT_REGISTER_COUNT - 1})`;
        let result = "vec4<f32>(0.0)";
        for (const regNum of [...inputRegs].reverse()) {
            result = `select(${result}, ${inputExpr(regNum)}, (${bounded}) == ${regNum})`;
        }
        return result;
    };

    const ctx: ShaderCtx = {
        isPs: false,
        major: prog.major,
        minor: prog.minor,
        readReg(reg: SmRegister, relativeSource?: SmSource): string {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.INPUT:
                    if (relativeSource) {
                        const index = relativeIndexExpr(
                            relativeSource.relReg,
                            relativeSource.relSwizzle,
                            ctx,
                        );
                        return relativeInputExpr(`${index} + ${reg.num}`);
                    }
                    return inputExpr(reg.num);
                case RegType.CONST:
                    if (relativeSource) {
                        const index = relativeIndexExpr(
                            relativeSource.relReg,
                            relativeSource.relSwizzle,
                            ctx,
                        );
                        return relativeConstExpr(`${index} + ${reg.num}`);
                    }
                    if (!prog.usesRelativeConst && a.defConsts.has(reg.num)) return `dc${reg.num}`;
                    if (prog.usesRelativeConst) return relativeConstExpr(`${reg.num}`);
                    return `vsc.c[${Math.min(Math.max(0, reg.num), maxConstIdx)}]`;
                case RegType.CONSTINT: {
                    const def = a.defInts.get(reg.num);
                    if (def) return `vec4<f32>(${def[0]}, ${def[1]}, ${def[2]}, ${def[3]})`;
                    return `vec4<f32>(vsc.i[${reg.num}])`;
                }
                case RegType.CONSTBOOL:
                    if (a.defBools.has(reg.num)) return a.defBools.get(reg.num) ? `vec4<f32>(1.0)` : `vec4<f32>(0.0)`;
                    return `select(vec4<f32>(0.0), vec4<f32>(1.0), vsBool(${reg.num}u))`;
                case RegType.ADDR: return `vec4<f32>(f32(a0.x), f32(a0.y), f32(a0.z), f32(a0.w))`;
                case RegType.LOOP: return `vec4<f32>(f32(${activeLoopLocal ?? "0"}))`;
                case RegType.PREDICATE: return `select(vec4<f32>(0.0), vec4<f32>(1.0), p${reg.num})`;
                default: return `vec4<f32>(0.0)`;
            }
        },
        writeRegName(reg: SmRegister, destination): string | null {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.RASTOUT:
                    if (reg.num === RASTOUT_POS) return "oPos";
                    if (reg.num === RASTOUT_FOG) return "oFog";
                    return opts.pointExpansion && reg.num === RASTOUT_PTS ? "oPts" : null;
                case RegType.ATTROUT: return reg.num === 1 ? "oD1" : "oD0";
                case RegType.TEXCRDOUT: {
                    if (prog.major < 3) return `oT${reg.num}`;
                    const binding = a.outputBindings.get(reg.num);
                    if (binding?.kind === "pointsize") return opts.pointExpansion ? "oPts" : null;
                    if (a.usesRelativeOutput) {
                        if (destination?.reg.relative) {
                            const index = relativeIndexExpr(
                                destination.relReg,
                                destination.relSwizzle,
                                ctx,
                                false,
                            );
                            return `oReg[clamp(${index} + ${reg.num}, 0, ${VS_OUTPUT_REGISTER_COUNT - 1})]`;
                        }
                        return `oReg[${Math.min(Math.max(0, reg.num), VS_OUTPUT_REGISTER_COUNT - 1)}]`;
                    }
                    if (!binding) return null;
                    if (binding.kind === "position") return "oPos";
                    if (binding.kind === "color") return binding.index === 1 ? "oD1" : "oD0";
                    if (binding.kind === "texcoord") return `oT${binding.index}`;
                    if (binding.kind === "fog") return "oFog";
                    return null;
                }
                default: return null;
            }
        },
    };

    const body = new Emitter();
    const pixelCentreSlot = opts.pixelCentreSlot ?? opts.constantCount;
    const pointSizeSlot = opts.pointSizeSlot ?? pixelCentreSlot + 1;

    // Local register/output declarations.
    for (let r = 0; r <= a.maxTemp; r++) body.line(`var r${r}: vec4<f32> = vec4<f32>(0.0);`);
    if (a.needsA0) body.line(`var a0: vec4<i32> = vec4<i32>(0);`);
    const predicateRegisters = collectPredicateRegisters(blocks);
    for (const predicate of predicateRegisters) body.line(`var p${predicate}: vec4<bool> = vec4<bool>(false);`);
    body.line(`var oPos: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);`);
    if (opts.pointExpansion) body.line(`var oPts: vec4<f32> = vec4<f32>(vsc.c[${pointSizeSlot}].x, 0.0, 0.0, 0.0);`);
    if (a.writesColor[0]) body.line(`var oD0: vec4<f32> = vec4<f32>(1.0);`);
    if (a.writesColor[1]) body.line(`var oD1: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);`);
    for (const n of a.writesTexcoord) body.line(`var oT${n}: vec4<f32> = vec4<f32>(0.0);`);
    if (a.writesFog) body.line(`var oFog: vec4<f32> = vec4<f32>(1.0);`);
    if (a.usesRelativeOutput) {
        body.line(`var oReg: array<vec4<f32>, ${VS_OUTPUT_REGISTER_COUNT}>;`);
        for (const [reg, binding] of a.outputBindings) {
            if (binding.kind === "position") body.line(`oReg[${reg}] = vec4<f32>(0.0, 0.0, 0.0, 1.0);`);
            if (binding.kind === "color") {
                body.line(`oReg[${reg}] = ${binding.index === 1
                    ? "vec4<f32>(0.0, 0.0, 0.0, 1.0)"
                    : "vec4<f32>(1.0)"};`);
            }
            if (binding.kind === "texcoord") body.line(`oReg[${reg}] = vec4<f32>(0.0);`);
            if (binding.kind === "fog") body.line(`oReg[${reg}] = vec4<f32>(1.0);`);
        }
    }
    if (!prog.usesRelativeConst) {
        for (const [num, vals] of a.defConsts) {
            body.line(`let dc${num} = ${defLiteral(vals)};`);
        }
    }
    body.line("");

    // Instructions are walked through the shared structured flow lowerer. This
    // is deliberately the only stage-specific dispatch point: flow braces and
    // loop locals cannot drift between VS and PS.
    let uid = 0;
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
                return `vsBool(${source.reg.num}u)`;
            }
            if (source.reg.type === RegType.PREDICATE) {
                return scalarPredicateExpr(source, ctx);
            }
            return `((${srcExpr(source, ctx)}).x != 0.0)`;
        },
        integerComponent(source, component, lexical) {
            activeLoopLocal = lexical.loopLocal;
            return `i32(${roundD3dExpr(`(${srcExpr(source, ctx)}).${component}`)})`;
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
            const d = ins.dst;
            // WebGPU has no fixed-function point-size output in the ordinary path. D3D9
            // ignores oPts for non-point primitives, so preserve linkability while making
            // that deliberate downgrade visible to the census.
            if (d?.reg.type === RegType.RASTOUT && d.reg.num === RASTOUT_PTS) {
                if (!opts.pointExpansion) {
                    census.record("oPts", "approximated", "flow");
                    return;
                }
            }
            if (prog.major >= 3 && d?.reg.type === RegType.OUTPUT) {
                const binding = a.outputBindings.get(d.reg.num);
                if (!binding || binding.kind === "drop") {
                    census.record("output", "unsupported", "flow");
                    return;
                }
                if (binding.kind === "pointsize" && !opts.pointExpansion) {
                    census.record("oPts", "approximated", "flow");
                    return;
                }
            }
            if (d && d.reg.type === RegType.ADDR) {
                // vs_1_1 floors when loading a0; vs_2_0+ (mova) rounds.
                const rnd = (prog.major >= 2 || prog.minor >= 2) ? "d3dRound" : "floor";
                const value = srcExpr(ins.src[0]!, ctx);
                if (ins.predicated && ins.predicate) {
                    for (const [bit, component] of COMPONENTS.entries()) {
                        if ((d.writeMask & (1 << bit)) === 0) continue;
                        const converted = rnd === "d3dRound"
                            ? `i32(${roundD3dExpr(`(${value}).${component}`)})`
                            : `i32(floor((${value}).${component}))`;
                        const predicate = predicateLaneExpr(ins.predicate, bit, ctx);
                        body.line(`a0.${component} = select(a0.${component}, ${converted}, ${predicate});`);
                    }
                } else if (ins.predicated) {
                    census.record(ins.opcode, "unsupported");
                    return;
                } else {
                    for (const [bit, component] of COMPONENTS.entries()) {
                        if ((d.writeMask & (1 << bit)) === 0) continue;
                        body.line(rnd === "d3dRound"
                            ? `a0.${component} = i32(${roundD3dExpr(`(${value}).${component}`)});`
                            : `a0.${component} = i32(floor((${value}).${component}));`);
                    }
                }
                census.record(ins.opcode, "ok");
                return;
            }
            if (ins.opcode === Op.TEXLDL) {
                if (emitVertexTexldl(ins, ctx, body, uid++, opts.volumeMask ?? 0, opts.samplerStates)) {
                    census.record(ins.opcode, "ok", "tex");
                } else {
                    census.record(ins.opcode, "unsupported", "tex");
                }
                return;
            }
            const forceSat = d?.reg.type === RegType.RASTOUT && d.reg.num === RASTOUT_FOG;
            const outputMask = prog.major >= 3 && d?.reg.type === RegType.OUTPUT
                ? a.outputMasks?.get(d.reg.num)
                : undefined;
            const needsOutputMask = outputMask !== undefined && outputMask !== 0xF;
            // oFog is always saturated, but only after evaluating the instruction's real
            // ALU expression (ADD/MAD/etc.), exactly like a destination _sat modifier.
            const aluInstruction = d && (needsOutputMask || (forceSat && !d.saturate))
                ? {
                    ...ins,
                    dst: {
                        ...d,
                        ...(needsOutputMask ? { writeMask: d.writeMask & outputMask! } : {}),
                        ...(forceSat && !d.saturate ? { saturate: true } : {}),
                    },
                }
                : ins;
            if (emitAlu(aluInstruction, ctx, body, uid++)) {
                census.record(ins.opcode, "ok");
            } else {
                census.record(ins.opcode, "unsupported");
            }
        },
    });
    census.assertLinkable();

    body.line("");
    // D3D9 names integer pixel centres; WebGPU rasterizes half-integer centres.
    // dx/dy live in a hidden c[] tail so viewport size and the kill-switch remain
    // per-draw state instead of becoming pipeline-key inputs.
    const semanticOutput = (
        kind: "position" | "color" | "texcoord" | "fog",
        index: number,
        fallback: string,
    ): string => {
        if (!a.usesRelativeOutput) return fallback;
        for (const [reg, binding] of a.outputBindings) {
            if (binding.kind === kind && binding.index === index) return `oReg[${reg}]`;
        }
        return fallback;
    };
    const position = semanticOutput("position", 0, "oPos");
    body.line(a.usesRelativeOutput
        ? `out.pos = vec4<f32>((${position}).x + (${position}).w * vsc.c[${pixelCentreSlot}].x, (${position}).y + (${position}).w * vsc.c[${pixelCentreSlot}].y, (${position}).z, (${position}).w);`
        : `out.pos = vec4<f32>(oPos.x + oPos.w * vsc.c[${pixelCentreSlot}].x, oPos.y + oPos.w * vsc.c[${pixelCentreSlot}].y, oPos.z, oPos.w);`);
    if (opts.clipPlanes) body.line(`let _clipBasePos = out.pos;`);
    if (opts.pointExpansion) {
        // The CPU expansion duplicates each source point six times in triangle-list order
        // [0,1,2,2,1,3].  Keep the original position/outputs intact and offset only the
        // position in clip space.  The hidden c[] tail carries the active viewport dimensions
        // in z/w; x/y continue to carry the normal D3D↔WebGPU pixel-centre correction.
        const basePosition = a.usesRelativeOutput
            ? `vec4<f32>((${position}).x + (${position}).w * vsc.c[${pixelCentreSlot}].x, (${position}).y + (${position}).w * vsc.c[${pixelCentreSlot}].y, (${position}).z, (${position}).w)`
            : `vec4<f32>(oPos.x + oPos.w * vsc.c[${pixelCentreSlot}].x, oPos.y + oPos.w * vsc.c[${pixelCentreSlot}].y, oPos.z, oPos.w)`;
        body.line(`let _pointBasePos = ${basePosition};`);
        // recordConvertedDraw always starts the expanded triangle list at vertex 0; retaining
        // that invariant makes the six-corner lookup independent of the guest firstVertex.
        body.line(`let _pointCorner = vertexIndex % 6u;`);
        // Dynamic indexing a WGSL array value is not portable: the indexable
        // expression must be a reference. Keep the table in local vars so
        // point-list expansion remains valid on validators/drivers that reject
        // indexing a temporary array value.
        body.line(`var _pointCornerXTable = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);`);
        body.line(`var _pointCornerYTable = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);`);
        body.line(`let _pointCornerX = _pointCornerXTable[_pointCorner];`);
        body.line(`let _pointCornerY = _pointCornerYTable[_pointCorner];`);
        body.line(`let _pointSize = clamp(oPts.x, vsc.c[${pointSizeSlot}].y, vsc.c[${pointSizeSlot}].z);`);
        body.line(`let _pointHalfSize = max(_pointSize, 0.0) * 0.5;`);
        body.line(`let _pointViewportW = max(vsc.c[${pixelCentreSlot}].z, 1.0);`);
        body.line(`let _pointViewportH = max(vsc.c[${pixelCentreSlot}].w, 1.0);`);
        body.line(`out.pos = vec4<f32>(_pointBasePos.x + _pointBasePos.w * _pointCornerX * _pointHalfSize * 2.0 / _pointViewportW, _pointBasePos.y - _pointBasePos.w * _pointCornerY * _pointHalfSize * 2.0 / _pointViewportH, _pointBasePos.z, _pointBasePos.w);`);
    }
    if (opts.clipPlanes) {
        // D3D9 programmable SetClipPlane equations are evaluated against the raw
        // post-transform clip position. The backend's pixel-centre correction is
        // a rasterization shim, not part of that equation, so remove it first.
        // Disabled planes are represented by zero vectors in the hidden uniform tail
        // and therefore never kill pixels.
        const clipSlot = opts.clipPlaneSlot ?? pointSizeSlot + 1;
        body.line(`let _clipPlanePos = vec4<f32>(_clipBasePos.x - _clipBasePos.w * vsc.c[${pixelCentreSlot}].x, _clipBasePos.y - _clipBasePos.w * vsc.c[${pixelCentreSlot}].y, _clipBasePos.z, _clipBasePos.w);`);
        body.line(`out.clipA = vec4<f32>(dot(_clipPlanePos, vsc.c[${clipSlot}]), dot(_clipPlanePos, vsc.c[${clipSlot + 1}]), dot(_clipPlanePos, vsc.c[${clipSlot + 2}]), dot(_clipPlanePos, vsc.c[${clipSlot + 3}]));`);
        body.line(`out.clipB = vec2<f32>(dot(_clipPlanePos, vsc.c[${clipSlot + 4}]), dot(_clipPlanePos, vsc.c[${clipSlot + 5}]));`);
    }
    const colorOutput = (name: string): string => prog.major < 3
        ? `min(max(${name}, vec4<f32>(0.0)), vec4<f32>(1.0))`
        : name;
    if (opts.interpColors[0]) body.line(`out.${colField(0)} = ${a.writesColor[0] ? colorOutput(semanticOutput("color", 0, "oD0")) : "vec4<f32>(1.0)"};`);
    if (opts.interpColors[1]) body.line(`out.${colField(1)} = ${a.writesColor[1] ? colorOutput(semanticOutput("color", 1, "oD1")) : "vec4<f32>(0.0, 0.0, 0.0, 1.0)"};`);
    for (const n of opts.interpTexcoords) {
        const texcoord = a.writesTexcoord.has(n) ? semanticOutput("texcoord", n, `oT${n}`) : "vec4<f32>(0.0)";
        // D3D9 point sprites synthesize [0,1]² coordinates for every active texture set
        // when POINTSPRITEENABLE is set.  The CPU lowering supplies six copies of each source
        // point; use the same corner index as the position expansion so perspective
        // interpolation preserves the sprite orientation.  Preserve z/w from the shader's
        // varying for shaders that use 3-D/projective coordinates while replacing x/y.
        body.line(opts.pointExpansion && opts.pointSpriteEnable
            ? `out.${texField(n)} = vec4<f32>(select(1.0, 0.0, ((_pointCorner == 0u) || (_pointCorner == 2u) || (_pointCorner == 3u))), select(1.0, 0.0, ((_pointCorner == 0u) || (_pointCorner == 1u) || (_pointCorner == 4u))), (${texcoord}).z, (${texcoord}).w);`
            : `out.${texField(n)} = ${texcoord};`);
    }
    if (opts.interpFog) {
        body.line(`out.fog = ${a.writesFog ? `clamp((${semanticOutput("fog", 0, "oFog")}).x, 0.0, 1.0)` : "1.0"};`);
    }
    body.line("return out;");

    return `@vertex\nfn vs_main(in: VsInput${opts.pointExpansion ? ", @builtin(vertex_index) vertexIndex: u32" : ""}) -> Interp {\n    var out: Interp;\n    ${body.toString().replace(/\n/g, "\n    ")}\n}`;
}

/**
 * VS3's texldl is the one texture instruction handled by this stage. D3D9
 * uses the sampler register's .w coordinate as an explicit LOD and the
 * vertex-texture API stage is sN + 257 (D3DVERTEXTEXTURESAMPLERN). Keep this
 * lowering local to the VS so the PS texture emitter remains independent.
 */
function emitVertexTexldl(
    ins: import("../sm-parser").SmInstruction,
    ctx: ShaderCtx,
    body: Emitter,
    uid: number,
    volumeMask: number,
    samplerStates: ReadonlyMap<number, SamplerSpec> | undefined,
): boolean {
    const dst = ins.dst;
    const coordinateSource = ins.src[0];
    const samplerSource = ins.src[1];
    if (!dst || !coordinateSource || !samplerSource || samplerSource.reg.type !== RegType.SAMPLER) return false;

    const samplerStage = samplerSource.reg.num >= D3D_VERTEX_TEXTURE_SAMPLER_BASE
        ? samplerSource.reg.num - D3D_VERTEX_TEXTURE_SAMPLER_BASE
        : samplerSource.reg.num;
    if (samplerStage < 0 || samplerStage >= VERTEX_TEXTURE_SAMPLER_COUNT) return false;

    const coordinate = srcExpr(coordinateSource, ctx);
    const isVolume = ((volumeMask >> samplerStage) & 1) !== 0;
    const sample = emitTextureSample({
        stage: samplerStage,
        texture: `vtex${samplerStage}`,
        sampler: `vsamp${samplerStage}`,
        coordinate: `(${coordinate}).${isVolume ? "xyz" : "xy"}`,
        dimensions: isVolume ? 3 : 2,
        mode: "level",
        level: `(${coordinate}).w`,
        samplerSpec: samplerStates?.get(D3D_VERTEX_TEXTURE_SAMPLER_BASE + samplerStage),
    });
    body.line(`// texldl (D3DVERTEXTEXTURESAMPLER${samplerStage}, stage ${D3D_VERTEX_TEXTURE_SAMPLER_BASE + samplerStage})`);
    return emitStore(dst, applyVertexSampleResultSwizzle(sample, samplerSource.swizzle), ctx, body, uid);
}

const SAMPLE_COMPONENTS = ["x", "y", "z", "w"] as const;

/** SM3 carries the sampled-result swizzle on the sampler source operand. */
function applyVertexSampleResultSwizzle(sample: string, swizzle: number): string {
    const c0 = SAMPLE_COMPONENTS[swizzle & 3];
    const c1 = SAMPLE_COMPONENTS[(swizzle >>> 2) & 3];
    const c2 = SAMPLE_COMPONENTS[(swizzle >>> 4) & 3];
    const c3 = SAMPLE_COMPONENTS[(swizzle >>> 6) & 3];
    if (c0 === "x" && c1 === "y" && c2 === "z" && c3 === "w") return sample;
    return `(${sample}).${c0}${c1}${c2}${c3}`;
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
                    visitSource(instruction.dst?.relReg ? {
                        reg: instruction.dst.relReg,
                        swizzle: instruction.dst.relSwizzle ?? 0xe4,
                        modifier: 0,
                    } : undefined);
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

function fmt(v: number): string {
    if (!isFinite(v)) return v > 0 ? "3.4e38" : (v < 0 ? "-3.4e38" : "0.0");
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
