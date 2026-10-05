// Minimal repro of the Dawn/Tint failure "swizzle view instruction still has usages after
// lowering": a masked write through a component l-value on a mutable vec4 var, the shape the
// D3D9 emitter produced for `mov r0.x, c0` / `mova a0.x, r0.x`. Chromium version unrecorded.
// naga accepts this module; the D3D9 emitter rebuilds the whole vector instead (shader/emit/store.ts).

struct Uniforms {
    c: array<vec4<f32>, 4>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(@location(0) position: vec4<f32>) -> @builtin(position) vec4<f32> {
    var r0: vec4<f32> = vec4<f32>(0.0);
    var a0: vec4<i32> = vec4<i32>(0);

    r0.x = uniforms.c[0].x;
    r0.y = uniforms.c[1].y;
    r0.z = uniforms.c[1].z;
    a0.x = i32(r0.x);
    r0.w = uniforms.c[a0.x].w;

    return position * r0;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
