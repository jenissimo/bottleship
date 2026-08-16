/**
 * ps-codegen.ts — pixel-shader IR → WGSL fragment function.
 *
 * Implements the ps_1_1-1_4 register-combiner model (r0 = color output, t#
 * texture/coord registers seeded from the iterated texcoords, [-1,1] constant
 * clamping) plus the ps_2_0 arithmetic subset. Texture sampling targets a
 * shared sampler `samp` and per-stage textures `texN`, declared by the linker.
 */

import { SmProgram, SmRegister } from "./sm-parser";
import { RegType, Op, opName, TexType, Usage } from "./sm-enums";
import { ShaderCtx, srcExpr, emitAlu, emitStore, colField, texField, AlphaTest, alphaTestSnippet } from "./sm-wgsl";

export interface PsAnalysis {
    constantCount: number;
    readsColor: [boolean, boolean];
    /** texcoord/texture-register indices the PS consumes (interp inputs). */
    readsTexcoord: Set<number>;
    /** texture stages sampled (binding allocation). */
    samplers: Set<number>;
    /** Per-stage declared sampler texture type (dcl_2d / dcl_cube / dcl_volume).
     *  Drives texture_cube<f32> codegen + the cube bind-group layout. */
    samplerTexType: Map<number, TexType>;
    defConsts: Map<number, Float32Array>;
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
    inputBindings: Map<number, { kind: "color" | "texcoord" | "unsupported"; index: number }>;
}

/** Boolean registers are packed after the 224 D3D9 pixel-float registers in the
 * same uniform block. They remain a distinct guest-visible register file. */
export const PS_BOOL_UNIFORM_BASE = 224;

export function analyzePs(prog: SmProgram): PsAnalysis {
    const readsColor: [boolean, boolean] = [false, false];
    const readsTexcoord = new Set<number>();
    const isPs14 = prog.major === 1 && prog.minor === 4;

    const inputBindings = new Map<number, { kind: "color" | "texcoord" | "unsupported"; index: number }>();
    if (prog.major >= 3) {
        for (const dcl of prog.declarations) {
            if (dcl.reg.type !== RegType.INPUT) continue;
            const kind = dcl.usage === Usage.COLOR ? "color"
                : dcl.usage === Usage.TEXCOORD ? "texcoord"
                : "unsupported";
            inputBindings.set(dcl.reg.num, { kind, index: dcl.usageIndex });
        }
    }

    const noteTexReg = (reg: SmRegister) => {
        if (reg.type === RegType.TEXTURE) readsTexcoord.add(reg.num);
        if (reg.type === RegType.INPUT) {
            if (prog.major >= 3) {
                const binding = inputBindings.get(reg.num);
                if (binding?.kind === "color" && binding.index <= 1) readsColor[binding.index] = true;
                else if (binding?.kind === "texcoord") readsTexcoord.add(binding.index);
            } else if (reg.num <= 1) {
                readsColor[reg.num] = true;
            }
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
        if (ins.opcode === Op.TEXBEM || ins.opcode === Op.TEXBEML) usesLegacyBumpEnv = true;
        for (const s of ins.src) noteTexReg(s.reg);
        // ps_1_1-1_3: tex/texcoord dst is a texcoord register (iterated input).
        if (ins.dst && !isPs14 && prog.major === 1 &&
            (ins.opcode === Op.TEX || ins.opcode === Op.TEXCOORD ||
             ins.opcode === Op.TEXKILL || ins.opcode === Op.TEXDP3) &&
            ins.dst.reg.type === RegType.TEXTURE) {
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
        if (ins.dst && prog.major === 1 && ins.dst.reg.type === RegType.TEXTURE &&
            (ins.opcode === Op.TEXBEM || ins.opcode === Op.TEXBEML ||
             ins.opcode === Op.TEXM3x3PAD || ins.opcode === Op.TEXM3x3VSPEC)) {
            readsTexcoord.add(ins.dst.reg.num);
            if (ins.opcode === Op.TEXM3x3VSPEC) {
                if (ins.dst.reg.num >= 1) readsTexcoord.add(ins.dst.reg.num - 1);
                if (ins.dst.reg.num >= 2) readsTexcoord.add(ins.dst.reg.num - 2);
            }
        }
    }

    const defConsts = new Map<number, Float32Array>();
    const defBools = new Map<number, boolean>();
    for (const def of prog.definitions) {
        if (def.reg.type === RegType.CONST && def.kind === "f") defConsts.set(def.reg.num, def.values);
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
        constantCount: Math.max(prog.maxConst + 1,
            prog.maxBool >= 0 ? PS_BOOL_UNIFORM_BASE + prog.maxBool + 1 : 0),
        readsColor,
        readsTexcoord,
        samplers,
        samplerTexType,
        defConsts,
        defBools,
        maxTemp: prog.maxTemp,
        isPs14,
        samplesTexture: samplers.size > 0,
        usesLegacyBumpEnv,
        inputBindings,
    };
}

export function emitPsMain(prog: SmProgram, a: PsAnalysis, alphaTest: AlphaTest | null = null, cubeMask: number = 0, projectedStages: number = 0): string {
    const ps1x = prog.major === 1;
    const maxConstIdx = Math.max(0, a.constantCount - 1);

    const constExpr = (num: number): string => {
        const base = a.defConsts.has(num) ? `dc${num}` : `psc.c[${num}]`;
        return ps1x ? `clamp(${base}, vec4<f32>(-1.0), vec4<f32>(1.0))` : base;
    };

    const ctx: ShaderCtx = {
        isPs: true,
        major: prog.major,
        minor: prog.minor,
        readReg(reg: SmRegister): string {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.INPUT: {
                    if (prog.major < 3) return `in.${colField(reg.num)}`;
                    const binding = a.inputBindings.get(reg.num);
                    if (binding?.kind === "color") return `in.${colField(binding.index)}`;
                    if (binding?.kind === "texcoord") return `in.${texField(binding.index)}`;
                    return `vec4<f32>(0.0)`;
                }
                case RegType.TEXTURE: return `t${reg.num}`;
                case RegType.CONST:
                    if (reg.relative) return `psc.c[clamp(${reg.num}, 0, ${maxConstIdx})]`;
                    return constExpr(reg.num);
                case RegType.CONSTBOOL:
                    if (a.defBools.has(reg.num)) {
                        return a.defBools.get(reg.num) ? `vec4<f32>(1.0)` : `vec4<f32>(0.0)`;
                    }
                    return `psc.c[${PS_BOOL_UNIFORM_BASE + reg.num}]`;
                case RegType.COLOROUT: return `oC${reg.num}`;
                default: return `vec4<f32>(0.0)`;
            }
        },
        writeRegName(reg: SmRegister): string | null {
            switch (reg.type) {
                case RegType.TEMP: return `r${reg.num}`;
                case RegType.TEXTURE: return `t${reg.num}`;
                case RegType.COLOROUT: return `oC${reg.num}`;
                default: return null;
            }
        },
    };

    const body: string[] = [];

    // Register declarations.
    const maxTemp = Math.max(0, a.maxTemp); // ps_1_x output is r0 — always present
    for (let r = 0; r <= maxTemp; r++) body.push(`var r${r}: vec4<f32> = vec4<f32>(0.0);`);
    for (const n of [...a.readsTexcoord].sort((x, y) => x - y)) {
        body.push(`var t${n}: vec4<f32> = in.${texField(n)};`);
    }
    if (!ps1x) body.push(`var oC0: vec4<f32> = vec4<f32>(0.0);`);
    for (const [num, vals] of a.defConsts) {
        body.push(`let dc${num} = vec4<f32>(${fmt(vals[0])}, ${fmt(vals[1])}, ${fmt(vals[2])}, ${fmt(vals[3])});`);
    }
    body.push("");

    // TEXM3x3PAD communicates the first two rows to a later TEXM3x3* instruction;
    // it does not sample or write its destination texture register. Keep one pair
    // of temporary rows per source register so independent chains do not alias.
    const m3PadSources = new Set<number>();
    for (const ins of prog.instructions) {
        if (ins.opcode === Op.TEXM3x3PAD && ins.src[0]?.reg.type === RegType.TEXTURE) {
            m3PadSources.add(ins.src[0].reg.num);
        }
    }
    for (const n of [...m3PadSources].sort((x, y) => x - y)) {
        body.push(`var _m3x3r0_t${n}: f32 = 0.0;`);
        body.push(`var _m3x3r1_t${n}: f32 = 0.0;`);
    }

    let uid = 0;
    const m3PadCount = new Map<number, number>();
    for (const ins of prog.instructions) {
        if (ins.opcode === Op.IF && ins.src[0]) {
            body.push(`if ((${srcExpr(ins.src[0], ctx)}).x != 0.0) {`);
            continue;
        }
        if (ins.opcode === Op.ELSE) { body.push(`} else {`); continue; }
        if (ins.opcode === Op.ENDIF) { body.push(`}`); continue; }
        if (emitTexOp(ins, prog, a, ctx, body, uid, cubeMask, projectedStages, m3PadCount)) { uid++; continue; }
        if (!emitAlu(ins, ctx, body, uid++)) {
            body.push(`// unsupported PS opcode ${opName(ins.opcode)}`);
        }
    }

    body.push("");
    const outVar = ps1x ? "r0" : "oC0";
    const atest = alphaTestSnippet(alphaTest, `${outVar}.a`);
    if (atest) body.push(atest);
    body.push(`return ${outVar};`);

    return `@fragment\nfn fs_main(in: Interp) -> @location(0) vec4<f32> {\n    ${body.join("\n    ")}\n}`;
}

/** Handle texture-addressing opcodes; returns true if consumed. */
function emitTexOp(
    ins: SmProgram["instructions"][number],
    prog: SmProgram,
    a: PsAnalysis,
    ctx: ShaderCtx,
    body: string[],
    uid: number,
    cubeMask: number,
    projectedStages: number,
    m3PadCount: Map<number, number>,
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
            body.push(`// tex (stage ${stage}${isCube ? ", cube" : ""}${projected ? ", proj.w" : ""}${biased ? ", bias" : ""})`);
            body.push(`let ${tc} = ${coordExpr};`);
            const projd = projected ? `((${tc}) / (${tc}).w)` : `(${tc})`;
            const coord = isCube ? `${projd}.xyz` : `${projd}.xy`;
            const sampleExpr = biased
                ? `textureSampleBias(tex${stage}, samp, ${coord}, (${tc}).w)`
                : `textureSample(tex${stage}, samp, ${coord})`;
            emitStore(d, sampleExpr, ctx, body, uid);
            return true;
        }
        case Op.TEXCOORD: {
            if (!d) return true;
            if (ps1x13) {
                const n = d.reg.num;
                body.push(`// texcoord`);
                emitStore(d, `vec4<f32>(clamp((in.${texField(n)}).xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0)`, ctx, body, uid);
            } else {
                body.push(`// texcrd`);
                emitStore(d, srcExpr(ins.src[0], ctx), ctx, body, uid);
            }
            return true;
        }
        case Op.TEXKILL: {
            if (!d) return true;
            const coord = ps1x13 ? `in.${texField(d.reg.num)}` : ctx.readReg(d.reg);
            body.push(`if (any((${coord}).xyz < vec3<f32>(0.0))) { discard; }`);
            return true;
        }
        case Op.TEXDP3: {
            if (!d) return true;
            const coord = ps1x13 ? `in.${texField(d.reg.num)}` : ctx.readReg(d.reg);
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            emitStore(d, `vec4<f32>(dot((${coord}).xyz, (${src}).xyz))`, ctx, body, uid);
            return true;
        }
        case Op.TEXDP3TEX: {
            if (!d) return true;
            const stage = d.reg.num;
            const coord = ps1x13 ? `in.${texField(stage)}` : ctx.readReg(d.reg);
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            body.push(`// texdp3tex (approx)`);
            emitStore(d, `textureSample(tex${stage}, samp, vec2<f32>(dot((${coord}).xyz, (${src}).xyz), 0.0))`, ctx, body, uid);
            return true;
        }
        case Op.TEXBEM:
        case Op.TEXBEML: {
            if (!d) return true;
            const stage = d.reg.num;
            const src = srcExpr(ins.src[0] ?? defaultSrc(d.reg), ctx);
            // D3D9 TEXBEM matrix placement is row-major by coordinate: u +=
            // MAT00*du + MAT10*dv, v += MAT01*du + MAT11*dv. D3D's V/U bump
            // formats are signed; our upload normalizes them to UNORM RGBA, so
            // recover the signed values here. This is texture-format decoding,
            // not the forbidden ps_1_1 source _bx2 modifier.
            const tc = `_bemTc${uid}`;
            const bump = `psc.bump[${stage}]`;
            body.push(`// ${opName(ins.opcode)} (D3DTSS_BUMPENV* on destination stage ${stage})`);
            body.push(`let _bemDuDv${uid} = (${src}).xy * 2.0 - vec2<f32>(1.0);`);
            body.push(`let ${tc} = vec2<f32>((in.${texField(stage)}).x + ${bump}.mat.x * _bemDuDv${uid}.x + ${bump}.mat.z * _bemDuDv${uid}.y, (in.${texField(stage)}).y + ${bump}.mat.y * _bemDuDv${uid}.x + ${bump}.mat.w * _bemDuDv${uid}.y);`);
            let sample = `textureSample(tex${stage}, samp, ${tc})`;
            if (ins.opcode === Op.TEXBEML) {
                sample = `(${sample} * ((${src}).z * ${bump}.lum.x + ${bump}.lum.y))`;
            }
            emitStore(d, sample, ctx, body, uid);
            return true;
        }
        case Op.TEXM3x3PAD: {
            if (!d) return true;
            const source = ins.src[0]?.reg;
            if (!source || source.type !== RegType.TEXTURE) {
                body.push(`// texm3x3pad requires a texture-register source`);
                return true;
            }
            const count = m3PadCount.get(source.num) ?? 0;
            const row = count === 0 ? 0 : 1;
            m3PadCount.set(source.num, Math.min(count + 1, 2));
            const src = srcExpr(ins.src[0], ctx);
            // The row vectors are the texture coordinates of the PAD destination
            // stages, not samples from those stages (MSDN TEXM3x3PAD sequence).
            body.push(`// texm3x3pad row ${row + 1}`);
            body.push(`_m3x3r${row}_t${source.num} = dot((in.${texField(d.reg.num)}).xyz, ((${src}).xyz * 2.0 - vec3<f32>(1.0)));`);
            return true;
        }
        case Op.TEXM3x3VSPEC: {
            if (!d) return true;
            const source = ins.src[0]?.reg;
            if (!source || source.type !== RegType.TEXTURE) {
                body.push(`// texm3x3vspec requires a texture-register source`);
                return true;
            }
            const src = srcExpr(ins.src[0], ctx);
            const stage = d.reg.num;
            const n = `_m3N${uid}`;
            const e = `_m3E${uid}`;
            const r = `_m3R${uid}`;
            const isCube = ((cubeMask >> stage) & 1) !== 0;
            body.push(`// texm3x3vspec: PAD rows + final row, then reflect the interpolated eye ray`);
            body.push(`let ${n} = vec3<f32>(_m3x3r0_t${source.num}, _m3x3r1_t${source.num}, dot((in.${texField(stage)}).xyz, ((${src}).xyz * 2.0 - vec3<f32>(1.0))));`);
            body.push(`let ${e} = vec3<f32>((in.${texField(Math.max(0, stage - 2))}).w, (in.${texField(Math.max(0, stage - 1))}).w, (in.${texField(stage)}).w);`);
            body.push(`let ${r} = 2.0 * (dot(${n}, ${e}) / max(dot(${n}, ${n}), 1e-8)) * ${n} - ${e};`);
            emitStore(d, `textureSample(tex${stage}, samp, ${isCube ? r : `${r}.xy`})`, ctx, body, uid);
            m3PadCount.delete(source.num);
            return true;
        }
        case Op.TEXREG2AR:
        case Op.TEXREG2GB:
        case Op.TEXREG2RGB:
        case Op.TEXM3x2TEX:
        case Op.TEXM3x2PAD:
        case Op.TEXM3x2DEPTH:
        case Op.TEXM3x3:
        case Op.TEXM3x3TEX:
        case Op.TEXM3x3SPEC:
        case Op.TEXDEPTH:
        case Op.BEM: {
            // Exotic bump/matrix texture ops — approximate with a plain sample of
            // the stage's iterated coordinate so the pass still produces output.
            if (!d) return true;
            const stage = d.reg.num;
            body.push(`// ${opName(ins.opcode)} (approximated as plain sample)`);
            emitStore(d, `textureSample(tex${stage}, samp, (in.${texField(stage)}).xy)`, ctx, body, uid);
            return true;
        }
        default:
            return false;
    }
}

function defaultSrc(reg: SmRegister) {
    return { reg, swizzle: 0xE4, modifier: 0 };
}

function fmt(v: number): string {
    if (!isFinite(v)) return v > 0 ? "3.4e38" : (v < 0 ? "-3.4e38" : "0.0");
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
