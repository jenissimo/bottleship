import { Emitter } from "../emitter";

/** D3D9's fixed-size integer and boolean constant files. */
export const SHADER_INTEGER_REGISTER_COUNT = 16;
export const SHADER_BOOLEAN_REGISTER_COUNT = 16;

/** Bytes occupied by the non-float banks in one programmable stage block. */
export const SHADER_INTEGER_BANK_BYTES = SHADER_INTEGER_REGISTER_COUNT * 16;
export const SHADER_BOOLEAN_BANK_BYTES = 16; // vec4<u32>, with bits 0..15 in .x

/** Hidden VS vec4s appended after the guest c# bank: pixel-centre correction, the
 * point-size/default/min/max sidecar, and six D3D9 programmable clip-plane equations. */
export const VS_HIDDEN_VEC4_COUNT = 8;

/** The largest programmable uniform binding windows. Keep these in lockstep with the
 * executor's explicit bind-group ranges; VS c0-c255 is intentionally larger than 4096. */
export const VS_PROGRAMMABLE_BIND_BYTES = 256 * 16 + SHADER_INTEGER_BANK_BYTES + SHADER_BOOLEAN_BANK_BYTES;
export const PS_PROGRAMMABLE_BIND_BYTES = 224 * 16 + SHADER_INTEGER_BANK_BYTES + SHADER_BOOLEAN_BANK_BYTES + 8 * 2 * 16 + 2 * 16;

export interface UniformEmitOptions {
    vsBinding: number;
    psBinding: number;
    vsConstantCount: number;
    psConstantCount: number;
    hasPixelShader: boolean;
    usesLegacyBumpEnv: boolean;
    ffpStages: number;
}

function emitConstantBanks(stage: "vs" | "ps", constantCount: number, tail = ""): string {
    const prefix = stage === "vs" ? "Vs" : "Ps";
    const boolFn = stage === "vs" ? "vsBool" : "psBool";
    const uniform = stage === "vs" ? "vsc" : "psc";
    return [
        `struct ${prefix}Uniforms { c: array<vec4<f32>, ${Math.max(1, constantCount)}>, i: array<vec4<i32>, ${SHADER_INTEGER_REGISTER_COUNT}>, b: vec4<u32>,${tail} }`,
        `fn ${boolFn}(n: u32) -> bool { return (${uniform}.b.x & (1u << n)) != 0u; }`,
    ].join("\n");
}

export function emitUniformDeclarations(emitter: Emitter, opts: UniformEmitOptions): void {
    emitter.line(emitConstantBanks("vs", opts.vsConstantCount));
    emitter.line(`@group(0) @binding(${opts.vsBinding}) var<uniform> vsc: VsUniforms;`);
    if (opts.hasPixelShader) {
        if (opts.usesLegacyBumpEnv) {
            emitter.line("struct LegacyBumpStage { mat: vec4<f32>, lum: vec4<f32>, }");
            emitter.line(`struct PsUniforms { c: array<vec4<f32>, ${Math.max(1, opts.psConstantCount)}>, i: array<vec4<i32>, ${SHADER_INTEGER_REGISTER_COUNT}>, b: vec4<u32>, bump: array<LegacyBumpStage, ${opts.ffpStages}>, fogColor: vec4<f32>, fogParams: vec4<f32>, }`);
            emitter.line("fn psBool(n: u32) -> bool { return (psc.b.x & (1u << n)) != 0u; }");
        } else {
            emitter.line(emitConstantBanks("ps", opts.psConstantCount,
                " fogColor: vec4<f32>, fogParams: vec4<f32>,"));
        }
    } else {
        emitter.line("struct FfpStage { a: vec4<f32>, b: vec4<f32>, }");
        emitter.line(`struct PsUniforms { c: array<vec4<f32>, 1>, tfactor: vec4<f32>, stages: array<FfpStage, ${opts.ffpStages}>, stageConstants: array<vec4<f32>, ${opts.ffpStages}>, }`);
    }
    emitter.line(`@group(0) @binding(${opts.psBinding}) var<uniform> psc: PsUniforms;`);
}
