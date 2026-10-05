/**
 * The D3D9 fixed-function texture-stage combiner: the WGSL that evaluates one D3DTEXTUREOP
 * over its D3DTA_* arguments, plus the set of ops it implements.
 *
 * Both live here, in one file, because they are one contract with two readers: the shader
 * decides what a pixel becomes, and `FFP_IMPLEMENTED_OPS` decides what the gap census reports.
 * When they drift, the census stops being evidence — it reports "nothing missing" for an op the
 * shader silently drops.
 */

/**
 * D3DTEXTUREOP values `ffpStageOp` evaluates; everything else takes the unhandled fallback.
 * The whole enum bar 17 (PREMODULATE) and 22/23 (BUMPENVMAP[LUMINANCE]): those three consume
 * the NEXT stage's texture, which a stage-local combiner cannot reach. 1 is DISABLE, which the
 * cascade handles before it gets here.
 */
export const FFP_IMPLEMENTED_OPS: ReadonlySet<number> = new Set([
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 24, 25, 26,
]);

/**
 * `FFP_IMPLEMENTED_OPS` lists the operations that have a real `ffpStageOp` branch. DISABLE is
 * handled by the stage cascade before this function, so it is intentionally not advertised.
 * `unhandledExpr` is what an op outside FFP_IMPLEMENTED_OPS evaluates to. The caller passes
 * either `dst` (leave the destination register alone — the only answer that cannot invent
 * pixels) or a loud colour when the operator wants to SEE which pixels depend on the gap.
 */
export function emitFfpCombinerWgsl(unhandledExpr: string): string {
    return `
fn ffpStageArg(sel: u32, texC: vec4<f32>, cur: vec4<f32>, diff: vec4<f32>,
               spec: vec4<f32>, tmp: vec4<f32>, tf: vec4<f32>, stageConstant: vec4<f32>) -> vec4<f32> {
    // D3DTA base selector (modifier bits D3DTA_COMPLEMENT/ALPHAREPLICATE handled below).
    // Base 6 is the per-stage D3DTSS_CONSTANT colour. The uniform carries one value for every
    // stage, including the D3D default (0,0,0,0).
    let base = sel & 0xfu;
    var c = vec4<f32>(1.0);
    if (base == 0u) { c = diff; }          // 0 = DIFFUSE
    if (base == 1u) { c = cur; }           // 1 = CURRENT (stage 0: current == diffuse)
    if (base == 2u) { c = texC; }          // 2 = TEXTURE
    if (base == 3u) { c = tf; }            // 3 = TFACTOR
    if (base == 4u) { c = spec; }          // 4 = SPECULAR (vertex colour 1)
    if (base == 5u) { c = tmp; }           // 5 = TEMP (the D3DTSS_RESULTARG scratch register)
    if (base == 6u) { c = stageConstant; } // 6 = CONSTANT (D3DTSS_CONSTANT)
    if ((sel & 0x10u) != 0u) { c = vec4<f32>(1.0) - c; }         // D3DTA_COMPLEMENT
    if ((sel & 0x20u) != 0u) { c = vec4<f32>(c.a, c.a, c.a, c.a); } // D3DTA_ALPHAREPLICATE
    return c;
}

/**
 * One D3DTEXTUREOP evaluation. Both channels go through it — the colour path keeps .rgb and the
 * alpha path keeps .a — because D3D defines every op over all four components and the channels
 * differ only in which arguments they were handed.
 *
 * The scale variants and composite ops clamp their own result. Plain MODULATE is deliberately
 * left unclamped: DXVK's FFP lowering preserves the product here, while the stage's destination
 * write applies the fixed-function channel clamp.
 */
fn ffpStageOp(op: u32, a0: vec4<f32>, a1: vec4<f32>, a2: vec4<f32>,
              texC: vec4<f32>, cur: vec4<f32>, diff: vec4<f32>, tf: vec4<f32>,
              dst: vec4<f32>) -> vec4<f32> {
    let one = vec4<f32>(1.0);
    let zero = vec4<f32>(0.0);
    if (op == 2u) { return a1; }                                        // SELECTARG1
    if (op == 3u) { return a2; }                                        // SELECTARG2
    if (op == 4u) { return a1 * a2; }                                   // MODULATE
    if (op == 5u) { return clamp(a1 * a2 * 2.0, zero, one); }           // MODULATE2X
    if (op == 6u) { return clamp(a1 * a2 * 4.0, zero, one); }           // MODULATE4X
    if (op == 7u) { return clamp(a1 + a2, zero, one); }                 // ADD
    if (op == 8u) { return clamp(a1 + a2 - vec4<f32>(0.5), zero, one); } // ADDSIGNED
    if (op == 9u) { return clamp((a1 + a2 - vec4<f32>(0.5)) * 2.0, zero, one); } // ADDSIGNED2X
    if (op == 10u) { return clamp(a1 - a2, zero, one); }                // SUBTRACT
    if (op == 11u) { return clamp(a1 + a2 * (one - a1), zero, one); }   // ADDSMOOTH
    if (op == 12u) { return mix(a2, a1, vec4<f32>(diff.a)); }           // BLENDDIFFUSEALPHA
    // BLENDTEXTUREALPHA weighs by the STAGE'S TEXEL alpha, not by an argument's.
    if (op == 13u) { return mix(a2, a1, vec4<f32>(texC.a)); }
    if (op == 14u) { return mix(a2, a1, vec4<f32>(tf.a)); }             // BLENDFACTORALPHA
    // BLENDTEXTUREALPHAPM — arg1 is already premultiplied by the texel alpha.
    if (op == 15u) { return clamp(a1 + a2 * (one - vec4<f32>(texC.a)), zero, one); }
    if (op == 16u) { return mix(a2, a1, vec4<f32>(cur.a)); }            // BLENDCURRENTALPHA
    if (op == 18u) { return clamp(a1 + vec4<f32>(a1.a) * a2, zero, one); }       // MODULATEALPHA_ADDCOLOR
    if (op == 19u) { return clamp(a1 * a2 + vec4<f32>(a1.a), zero, one); }       // MODULATECOLOR_ADDALPHA
    if (op == 20u) { return clamp(a1 + (one - vec4<f32>(a1.a)) * a2, zero, one); } // MODULATEINVALPHA_ADDCOLOR
    if (op == 21u) { return clamp((one - a1) * a2 + vec4<f32>(a1.a), zero, one); } // MODULATEINVCOLOR_ADDALPHA
    // DOTPRODUCT3 — signed-expand both RGBs, dot, scale by 4, replicate to all four channels.
    if (op == 24u) { return clamp(vec4<f32>(dot(a1.rgb - vec3<f32>(0.5), a2.rgb - vec3<f32>(0.5)) * 4.0), zero, one); }
    if (op == 25u) { return clamp(a0 + a1 * a2, zero, one); }           // MULTIPLYADD
    if (op == 26u) { return mix(a2, a1, a0); }                          // LERP
    return ${unhandledExpr};
}
`;
}
