/**
 * vs-codegen.ts — vertex-shader IR → WGSL.
 *
 * Emits the `vs_main` function body. The vertex input struct, its @location
 * attributes and the per-register expansion expressions are reconciled against
 * the active D3D9 vertex declaration by the linker (index.ts) and passed in,
 * because the same compiled VS can be paired with different declarations.
 */

import { SmProgram, SmRegister } from "./sm-parser";
import { RegType, RASTOUT_POS, RASTOUT_FOG, Usage, opName } from "./sm-enums";
import {
    ShaderCtx, srcExpr, emitAlu, emitStore, colField, texField,
} from "./sm-wgsl";

/** Float constant registers a vs_3_0 device exposes (c0-c255) — the file
 *  SetVertexShaderConstantF writes into and the bound a relative read must span. */
export const VS_FLOAT_REGISTER_COUNT = 256;

export interface VsAnalysis {
    /** dcl_usage v# input declarations. */
    inputDcls: { usage: number; usageIndex: number; reg: number }[];
    constantCount: number;
    writesColor: [boolean, boolean];
    writesTexcoord: Set<number>;
    writesFog: boolean;
    needsA0: boolean;
    maxTemp: number;
    /** def c# values keyed by register number. */
    defConsts: Map<number, Float32Array>;
    /** VS3 generic o# register → declared output semantic. */
    outputBindings: Map<number, { kind: "position" | "color" | "texcoord" | "fog" | "drop"; index: number }>;
}

export function analyzeVs(prog: SmProgram): VsAnalysis {
    const writesColor: [boolean, boolean] = [false, false];
    const writesTexcoord = new Set<number>();
    let writesFog = false;
    let needsA0 = prog.usesRelativeConst;

    const outputBindings = new Map<number, { kind: "position" | "color" | "texcoord" | "fog" | "drop"; index: number }>();
    if (prog.major >= 3) {
        for (const dcl of prog.declarations) {
            if (dcl.reg.type !== RegType.OUTPUT) continue;
            let kind: "position" | "color" | "texcoord" | "fog" | "drop" = "drop";
            if (dcl.usage === Usage.POSITION || dcl.usage === Usage.POSITIONT) kind = "position";
            else if (dcl.usage === Usage.COLOR) kind = "color";
            else if (dcl.usage === Usage.TEXCOORD) kind = "texcoord";
            else if (dcl.usage === Usage.FOG) kind = "fog";
            outputBindings.set(dcl.reg.num, { kind, index: dcl.usageIndex });
        }
    }

    for (const ins of prog.instructions) {
        const d = ins.dst;
        if (!d) continue;
        if (d.reg.type === RegType.ADDR) needsA0 = true;
        if (prog.major >= 3 && d.reg.type === RegType.OUTPUT) {
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

    const inputDcls = prog.declarations
        .filter(d => d.reg.type === RegType.INPUT)
        .map(d => ({ usage: d.usage, usageIndex: d.usageIndex, reg: d.reg.num }));

    const defConsts = new Map<number, Float32Array>();
    for (const def of prog.definitions) {
        if (def.reg.type === RegType.CONST && def.kind === "f") defConsts.set(def.reg.num, def.values);
    }

    // Relative addressing (c[a0+n]) can index anywhere in the register file, so the static
    // maxConst is no bound at all — size to the WHOLE file we advertise (vs_3_0 / 256 float
    // registers, the same file SetVertexShaderConstantF writes into). A smaller array does not
    // fail: the read is clamped to the last element, so a matrix-palette index past the array
    // silently resolves to one fixed bone and those vertices erupt from the mesh.
    let constantCount = prog.maxConst + 1;
    if (prog.usesRelativeConst) constantCount = VS_FLOAT_REGISTER_COUNT;

    return {
        inputDcls,
        constantCount,
        writesColor,
        writesTexcoord,
        writesFog,
        needsA0,
        maxTemp: prog.maxTemp,
        defConsts,
        outputBindings,
    };
}

export interface VsEmitOptions {
    interpColors: [boolean, boolean];
    interpTexcoords: number[];      // sorted
    /** vec4<f32> read expression per input register (referencing `in.vN`). */
    inputExprs: Map<number, string>;
    constantCount: number;
}

export function emitVsMain(prog: SmProgram, a: VsAnalysis, opts: VsEmitOptions): string {
    const maxConstIdx = Math.max(0, opts.constantCount - 1);

    const ctx: ShaderCtx = {
        isPs: false,
        major: prog.major,
        minor: prog.minor,
        readReg(reg: SmRegister): string {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.INPUT:
                    return opts.inputExprs.get(reg.num) ?? `vec4<f32>(in.v${reg.num})`;
                case RegType.CONST:
                    if (reg.relative) return `vsc.c[clamp(a0 + ${reg.num}, 0, ${maxConstIdx})]`;
                    if (a.defConsts.has(reg.num)) return `dc${reg.num}`;
                    return `vsc.c[${reg.num}]`;
                case RegType.ADDR: return `vec4<f32>(f32(a0))`;
                default: return `vec4<f32>(0.0)`;
            }
        },
        writeRegName(reg: SmRegister): string | null {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.RASTOUT:
                    if (reg.num === RASTOUT_POS) return "oPos";
                    if (reg.num === RASTOUT_FOG) return "oFog";
                    return null; // oPts — dropped
                case RegType.ATTROUT: return reg.num === 1 ? "oD1" : "oD0";
                case RegType.TEXCRDOUT: {
                    if (prog.major < 3) return `oT${reg.num}`;
                    const binding = a.outputBindings.get(reg.num);
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

    const body: string[] = [];

    // Local register/output declarations.
    for (let r = 0; r <= a.maxTemp; r++) body.push(`var r${r}: vec4<f32> = vec4<f32>(0.0);`);
    if (a.needsA0) body.push(`var a0: i32 = 0;`);
    body.push(`var oPos: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);`);
    if (a.writesColor[0]) body.push(`var oD0: vec4<f32> = vec4<f32>(1.0);`);
    if (a.writesColor[1]) body.push(`var oD1: vec4<f32> = vec4<f32>(0.0);`);
    for (const n of a.writesTexcoord) body.push(`var oT${n}: vec4<f32> = vec4<f32>(0.0);`);
    if (a.writesFog) body.push(`var oFog: vec4<f32> = vec4<f32>(0.0);`);
    for (const [num, vals] of a.defConsts) {
        body.push(`let dc${num} = vec4<f32>(${fmt(vals[0])}, ${fmt(vals[1])}, ${fmt(vals[2])}, ${fmt(vals[3])});`);
    }
    body.push("");

    // Instructions.
    let uid = 0;
    for (const ins of prog.instructions) {
        const d = ins.dst;
        if (d && d.reg.type === RegType.ADDR) {
            // vs_1_1 floors when loading a0; vs_2_0+ (mova) rounds.
            const rnd = (prog.major >= 2 || prog.minor >= 2) ? "round" : "floor";
            body.push(`a0 = i32(${rnd}((${srcExpr(ins.src[0], ctx)}).x));`);
            continue;
        }
        const forceSat = d?.reg.type === RegType.RASTOUT && d.reg.num === RASTOUT_FOG;
        if (forceSat && d) {
            // oFog is always saturated.
            emitStore(d, srcExpr(ins.src[0], ctx), ctx, body, uid++, true);
            continue;
        }
        if (!emitAlu(ins, ctx, body, uid++)) {
            body.push(`// unsupported VS opcode ${opName(ins.opcode)}`);
        }
    }

    body.push("");
    body.push("out.pos = oPos;");
    if (opts.interpColors[0]) body.push(`out.${colField(0)} = ${a.writesColor[0] ? "oD0" : "vec4<f32>(1.0)"};`);
    if (opts.interpColors[1]) body.push(`out.${colField(1)} = ${a.writesColor[1] ? "oD1" : "vec4<f32>(0.0)"};`);
    for (const n of opts.interpTexcoords) {
        body.push(`out.${texField(n)} = ${a.writesTexcoord.has(n) ? `oT${n}` : "vec4<f32>(0.0)"};`);
    }
    body.push("return out;");

    return `@vertex\nfn vs_main(in: VsInput) -> Interp {\n    var out: Interp;\n    ${body.join("\n    ")}\n}`;
}

function fmt(v: number): string {
    if (!isFinite(v)) return v > 0 ? "3.4e38" : (v < 0 ? "-3.4e38" : "0.0");
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
