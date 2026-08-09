/**
 * Faithful D3D fixed-function fog — the fog twin of ffp-lighting.ts.
 *
 * Owns BOTH halves of the contract so the backends cannot drift:
 *   - `resolveFfpFogMode`, the CPU-side D3DRS_FOGTABLEMODE / D3DRS_FOGVERTEXMODE
 *     resolution, encoded into the single float the shader switches on, and
 *   - `FFP_FOG_WGSL`, the shader function that turns that encoding + the depth of
 *     the vertex into a fog factor.
 *
 * Mode encoding (one float, so a pipeline never has to be rebuilt when fog changes):
 *   0     = no fog
 *   0.5   = the app supplies the factor in specular alpha (pre-transformed vertices, or
 *           both fog modes NONE — DXVK d3d9_fixed_function_vert.vert calculateFog)
 *   1..3  = table (pixel) fog EXP / EXP2 / LINEAR over CLIP Z
 *   5..7  = T&L vertex fog EXP / EXP2 / LINEAR over view-space depth (clip W)
 *
 * Table fog is W-fog (D3DPRASTERCAPS_WFOG is advertised), so its depth is CLIP Z —
 * device_z × clip_w, linear in eye depth. That is exactly DXVK's fragment-shader
 * FragCoord.z / FragCoord.w, which in a vertex shader IS the clip position's z; an RHW
 * draw's conversion puts 1/rhw in clip w, so both vertex kinds come out in the same eye
 * units. The [0,1] DEVICE z would instead be compared against FOGSTART/FOGEND expressed
 * in eye units, saturating the ratio to a constant over the primitive.
 *
 * NOT implemented: D3DRS_RANGEFOGENABLE (vertex fog over length(viewPos) rather than
 * depth) — see DXVK's rangeFog() branch.
 */

export const D3DFOG_NONE = 0;

/**
 * Resolve D3DRS_FOGTABLEMODE / D3DRS_FOGVERTEXMODE into the shader's mode encoding.
 *
 * Table (pixel) fog wins when set. Otherwise vertex fog applies, and there the VERTEX KIND
 * matters: a pre-transformed (RHW) vertex ran no T&L, so the app supplies the fog factor in
 * specular alpha; an untransformed one gets the FOGVERTEXMODE formula over view-space depth.
 * Reading specular alpha on the untransformed path picks up an alpha the app never wrote
 * (usually 0) and drowns the whole scene in fog colour.
 *
 * FOGVERTEXMODE == NONE with fog enabled is NOT "no fog": D3D then takes the factor from
 * specular alpha as well (DXVK's `case D3DFOG_NONE: fogFactor = hasSpecular ? specular.w
 * : 1.0`), which is how the whole "write fog into the specular alpha yourself" idiom works.
 * With no specular in the vertex there is nothing to read, and D3D leaves the pixel
 * UNFOGGED — the shader's 0-alpha default would otherwise mean full fog colour.
 */
export function resolveFfpFogMode(
    fogEnable: number,
    fogTableMode: number,
    fogVertexMode: number,
    isRHW: boolean,
    hasSpecular: boolean,
): number {
    if (!fogEnable) return D3DFOG_NONE;
    if (fogTableMode !== D3DFOG_NONE) return fogTableMode;
    if (isRHW || fogVertexMode === D3DFOG_NONE) return hasSpecular ? 0.5 : D3DFOG_NONE;
    return fogVertexMode + 4;
}

/**
 * `ffpFogFactor(mode, start, end, density, clipZ, clipW, specularAlpha) -> f32`
 *
 * 0 = fully unfogged, 1 = fully fog colour. The caller applies it as
 * `mix(color.rgb, fogColor.rgb, factor)` — fog never touches alpha.
 */
export const FFP_FOG_WGSL = `
fn ffpFogFactor(modeIn: f32, start: f32, end: f32, density: f32, clipZ: f32, clipW: f32, specularAlpha: f32) -> f32 {
    if (modeIn > 0.25 && modeIn < 0.75) { return clamp(1.0 - specularAlpha, 0.0, 1.0); }
    if (modeIn < 1.0) { return 0.0; }
    var mode = modeIn;
    var depth = clipZ;
    if (mode >= 4.5) { mode = mode - 4.0; depth = clipW; }
    var factor: f32;
    if (mode <= 1.5) {
        factor = 1.0 - exp(-density * depth);
    } else if (mode <= 2.5) {
        let d = density * depth;
        factor = 1.0 - exp(-d * d);
    } else {
        factor = 1.0 - clamp((end - depth) / max(end - start, 0.0001), 0.0, 1.0);
    }
    return clamp(factor, 0.0, 1.0);
}`;
