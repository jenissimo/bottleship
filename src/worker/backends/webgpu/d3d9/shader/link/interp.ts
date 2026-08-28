import { Emitter } from "../emitter";
import { colField, texField } from "../emit/expr";

export interface InterpLocationLayout {
    readonly fog: number | null;
    readonly used: ReadonlySet<number>;
    readonly collisions: ReadonlySet<number>;
}

/** Allocate the legacy fog varying after the same location set as TEXCOORDs. */
export function interpLocationLayout(
    interpColors: [boolean, boolean],
    interpTexcoords: readonly number[],
    needsFog: boolean,
): InterpLocationLayout {
    const used = new Set<number>();
    const collisions = new Set<number>();
    const add = (location: number): void => {
        if (used.has(location)) collisions.add(location);
        used.add(location);
    };

    if (interpColors[0]) add(0);
    if (interpColors[1]) add(1);
    for (const n of interpTexcoords) add(2 + n);

    let fog: number | null = null;
    if (needsFog) {
        fog = 10;
        while (used.has(fog)) fog++;
        add(fog);
    }
    return { fog, used, collisions };
}

/** Choose locations after every varying emitted by this linker.  Clip planes are
 * represented as six scalar distances split into vec4 + vec2, and must never
 * alias the legacy fog location or a high-numbered TEXCOORD. */
export function clipPlaneLocations(
    interpColors: [boolean, boolean],
    interpTexcoords: readonly number[],
    needsFog: boolean,
): { a: number; b: number } {
    const layout = interpLocationLayout(interpColors, interpTexcoords, needsFog);
    const max = Math.max(-1, ...layout.used);
    return { a: max + 1, b: max + 2 };
}

export function emitInterpStruct(
    emitter: Emitter,
    interpColors: [boolean, boolean],
    interpTexcoords: number[],
    needsFrontFacing = false,
    _needsDepthOutput = false,
    centroidLocations: ReadonlySet<number> = new Set(),
    needsFog = false,
    needsClipPlanes = false,
): void {
    const locations = interpLocationLayout(interpColors, interpTexcoords, needsFog);
    const centroid = (location: number): string =>
        locations.used.has(location) && centroidLocations.has(location)
            ? " @interpolate(perspective, centroid)"
            : "";

    // Keep the vertex output and fragment input as distinct structs.  WGSL does not
    // permit @builtin(front_facing) on a vertex output, while D3D9 exposes vFace as a
    // pixel-stage input.  The user locations deliberately remain byte-for-byte paired.
    emitter.line("struct Interp {");
    emitter.line("    @builtin(position) @invariant pos: vec4<f32>,");
    if (interpColors[0]) emitter.line(`    @location(0)${centroid(0)} ${colField(0)}: vec4<f32>,`);
    if (interpColors[1]) emitter.line(`    @location(1)${centroid(1)} ${colField(1)}: vec4<f32>,`);
    for (const n of interpTexcoords) {
        const location = 2 + n;
        emitter.line(`    @location(${location})${centroid(location)} ${texField(n)}: vec4<f32>,`);
    }
    if (locations.fog !== null) emitter.line(`    @location(${locations.fog}) fog: f32,`);
    if (needsClipPlanes) {
        const locations = clipPlaneLocations(interpColors, interpTexcoords, needsFog);
        emitter.line(`    @location(${locations.a}) clipA: vec4<f32>,`);
        emitter.line(`    @location(${locations.b}) clipB: vec2<f32>,`);
    }
    emitter.line("}");

    emitter.line("struct PsInput {");
    emitter.line("    @builtin(position) pos: vec4<f32>,");
    if (needsFrontFacing) emitter.line("    @builtin(front_facing) frontFacing: bool,");
    if (interpColors[0]) emitter.line(`    @location(0)${centroid(0)} ${colField(0)}: vec4<f32>,`);
    if (interpColors[1]) emitter.line(`    @location(1)${centroid(1)} ${colField(1)}: vec4<f32>,`);
    for (const n of interpTexcoords) {
        const location = 2 + n;
        emitter.line(`    @location(${location})${centroid(location)} ${texField(n)}: vec4<f32>,`);
    }
    if (locations.fog !== null) emitter.line(`    @location(${locations.fog}) fog: f32,`);
    if (needsClipPlanes) {
        const locations = clipPlaneLocations(interpColors, interpTexcoords, needsFog);
        emitter.line(`    @location(${locations.a}) clipA: vec4<f32>,`);
        emitter.line(`    @location(${locations.b}) clipB: vec2<f32>,`);
    }
    emitter.line("}");

    // Fragment output structs belong to emit/ps.ts: their fields are driven by the
    // shader's declared oC0..oC3 writes, not only by whether oDepth is present.
}
