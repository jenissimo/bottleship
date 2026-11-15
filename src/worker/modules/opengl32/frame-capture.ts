/**
 * One-shot completed GL frame capture. Optional bounded emission metadata records
 * state before later UI calls change it and normals before fog reuses their slot.
 */
import { type OpenGLContext, CMD_I32, CMD_F32, VERT_FLOATS } from "./context";
import { GL_RENDER, GL_LIGHTING, GL_LIGHT0, GL_COLOR_MATERIAL, GL_NORMALIZE } from "./constants";

export interface GLComponentRange {
    min: Array<number | null>;
    max: Array<number | null>;
    nonFinite: number[];
}
/** Values are raw emitter inputs, before executor clamp; invalid values stay explicit. */
export function summarizeGLComponents(verts: Float32Array, offset: number, count: number, slot: number, components: number): GLComponentRange {
    const min = new Array<number | null>(components).fill(null);
    const max = new Array<number | null>(components).fill(null);
    const nonFinite = new Array<number>(components).fill(0);
    for (let v = 0; v < count; v++) for (let c = 0; c < components; c++) {
        const x = verts[offset + v * VERT_FLOATS + slot + c]!;
        if (!Number.isFinite(x)) { nonFinite[c]++; continue; }
        if (min[c] === null || x < min[c]!) min[c] = x;
        if (max[c] === null || x > max[c]!) max[c] = x;
    }
    return { min, max, nonFinite };
}

export interface GLDrawEmissionCapture {
    commandIndex: number;
    vertexOffset: number;
    vertexCount: number;
    color: GLComponentRange;
    /** Object-space normal, BEFORE transformFlatVerts overwrites nx with fog distance. */
    normal: GLComponentRange;
    state: ReturnType<typeof snapshotDrawState>;
}
function snapshotDrawState(ctx: OpenGLContext) {
    return {
        enables: [...ctx.enableFlags],
        lighting: ctx.enableFlags.has(GL_LIGHTING),
        normalize: ctx.enableFlags.has(GL_NORMALIZE),
        colorMaterial: { enabled: ctx.enableFlags.has(GL_COLOR_MATERIAL), face: ctx.colorMaterialFace, parameter: ctx.colorMaterialParam },
        currentColor: Array.from(ctx.currentColor),
        currentNormal: Array.from(ctx.currentNormal),
        colorArray: { ...ctx.colorArray }, normalArray: { ...ctx.normalArray },
        material: {
            ambient: Array.from(ctx.materialFrontAmbient), diffuse: Array.from(ctx.materialFrontDiffuse),
            specular: Array.from(ctx.materialFrontSpecular), emission: Array.from(ctx.materialFrontEmission),
            shininess: ctx.materialFrontShininess,
        },
        lightModelAmbient: Array.from(ctx.lightModelAmbient),
        lights: ctx.lights.slice(0, 8).map((light, index) => ({
            index, enabled: ctx.enableFlags.has(GL_LIGHT0 + index),
            ambient: Array.from(light.ambient), diffuse: Array.from(light.diffuse),
            specular: Array.from(light.specular), position: Array.from(light.position),
            spotDirection: Array.from(light.spotDirection), spotExponent: light.spotExponent,
            spotCutoff: light.spotCutoff, constantAttenuation: light.constantAttenuation,
            linearAttenuation: light.linearAttenuation, quadraticAttenuation: light.quadraticAttenuation,
        })),
        modelview: Array.from(ctx.modelviewStack.stack[ctx.modelviewStack.top]!),
    };
}

export interface GLFrameCapture {
    frameId: number;
    drawableW: number;
    drawableH: number;
    count: number;
    i32: Int32Array;
    f32: Float32Array;
    verts: Float32Array;
    drawEmissions: GLDrawEmissionCapture[];
    emissionCoverage: { enabled: boolean; limit: number; dropped: number; commandsBeforeArm: number | null };
}

/** @transient(one-shot harness request, not guest state) */
let armed = false;
/** @transient(optional bounded metadata for the armed frame) */
let emissions: GLDrawEmissionCapture[] | null = null;
/** @transient(harness coverage, not guest state) */
let emissionLimit = 0, dropped = 0, commandsBeforeArm: number | null = null;
/** @transient(context selected by the request) */
let armedContext: OpenGLContext | undefined;
/** @transient(harness copy of the last finished frame) */
let last: GLFrameCapture | null = null;

export interface GLFrameCaptureOptions { drawState?: boolean; maxDrawStates?: number; }
/** Arming midway through a frame cannot recover earlier state: coverage says so. */
export function armGLFrameCapture(options: GLFrameCaptureOptions = {}, ctx?: OpenGLContext): void {
    armed = true;
    last = null;
    armedContext = ctx;
    const requested = options.maxDrawStates ?? 512;
    emissionLimit = options.drawState ? Math.max(1, Math.min(4096, Number.isFinite(requested) ? Math.floor(requested) : 512)) : 0;
    emissions = options.drawState ? [] : null;
    dropped = 0;
    commandsBeforeArm = ctx ? ctx.commands.count : null;
}
/** Disarm after a timeout; do not leave a metadata observer active indefinitely. */
export function cancelGLFrameCapture(): void {
    armed = false;
    emissions = null;
    armedContext = undefined;
}
/** Hook BEFORE transformation. With metadata off, returns without reading ctx/allocating. */
export function captureGLDrawEmissionIfArmed(ctx: OpenGLContext, offset: number, count: number): GLDrawEmissionCapture | undefined {
    if (!armed || emissions === null) return;
    if ((armedContext && armedContext !== ctx) || ctx.renderMode !== GL_RENDER) return;
    if (emissions.length >= emissionLimit) { dropped++; return; }
    const capture: GLDrawEmissionCapture = {
        commandIndex: -1, vertexOffset: offset, vertexCount: count,
        color: summarizeGLComponents(ctx.vertArena.data, offset, count, 4, 4),
        normal: summarizeGLComponents(ctx.vertArena.data, offset, count, 8, 3),
        state: snapshotDrawState(ctx),
    };
    emissions.push(capture);
    return capture;
}
/** The most recent captured frame (cleared by the next arm). */
export function takeGLFrameCapture(): GLFrameCapture | null { return last; }
/** Presenter hook: copy the completed stream before it is reset. */
export function captureGLFrameIfArmed(ctx: OpenGLContext, drawableW: number, drawableH: number): void {
    if (!armed || (armedContext && armedContext !== ctx)) return;
    armed = false;
    const n = ctx.commands.count;
    last = {
        frameId: ctx.frameId, drawableW, drawableH, count: n,
        i32: new Int32Array(ctx.commands.i32.subarray(0, n * CMD_I32)),
        f32: new Float32Array(ctx.commands.f32.subarray(0, n * CMD_F32)),
        verts: new Float32Array(ctx.vertArena.data.subarray(0, ctx.vertArena.used)),
        drawEmissions: emissions ?? [],
        emissionCoverage: { enabled: emissions !== null, limit: emissionLimit, dropped, commandsBeforeArm },
    };
    emissions = null;
    armedContext = undefined;
}
