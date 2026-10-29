/**
 * The fixed-function D3D vertex transform as ONE WGSL function.
 *
 * Multi-pass rendering (a programmable base pass, fixed-function layers blended over it
 * with D3DCMP_LESSEQUAL) depends on every path producing the same depth for the same
 * vertex — GeForce-era hardware ran fixed-function as a vertex program, and engines
 * relied on that. Two mathematically equal spellings (`m * v` vs four dot products) are
 * not bit-equal once a compiler picks its own multiply-add order, and the passes then
 * z-fight. Every path that transforms an untransformed vertex therefore calls this
 * function on the same matrix bits, with the position output marked `@invariant`.
 *
 * `m` is the D3D row-major World×View×Projection uploaded as-is (WGSL reads it column-
 * major, so `m[i]` is D3D row i) with the pixel-centre shift already folded in
 * (pixel-center.ts writeMvpWithPixelCenter). D3DVIEWPORT MinZ/MaxZ is not applied here:
 * it is the pass viewport's depth range, which also covers pre-transformed vertices.
 */
export const D3D_TRANSFORM_POSITION_WGSL = `
fn d3dTransformPosition(m: mat4x4<f32>, p: vec3<f32>) -> vec4<f32> {
    return fma(m[2], vec4<f32>(p.z), fma(m[1], vec4<f32>(p.y), fma(m[0], vec4<f32>(p.x), m[3])));
}`;
