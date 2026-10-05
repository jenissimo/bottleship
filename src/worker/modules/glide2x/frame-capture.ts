/**
 * One-shot Glide frame capture — the Glide twin of opengl32/frame-capture.ts.
 *
 * The command stream is reset the instant a present finishes, so "what did the
 * guest actually draw" is unanswerable after the fact. Arming a capture copies
 * the COMPLETED stream (plus the frame-wide state the executor was handed) at
 * the one moment both exist, which is what separates "the quad is wrong" from
 * "its texture is wrong" from "the combine is wrong" without guessing.
 */

import { Legacy3DCommandStream } from "../../backends/webgpu/legacy3d/command-stream";
import type { GlideFrameInput } from "../../backends/webgpu/glide/glide-types";
import { Legacy3DCommandType } from "../../backends/webgpu/legacy3d/types";

export interface GlideCapturedDraw {
    k: number;
    cmd: "DRAW" | "CLEAR";
    /** CLEAR */
    clearColor?: number;
    clearDepth?: number;
    clearsColor?: boolean;
    clearsDepth?: boolean;
    /** DRAW */
    topology?: string;
    firstVertex?: number;
    vertexCount?: number;
    textureHandle?: number;
    useTexture?: boolean;
    blendEnabled?: boolean;
    blend?: number;
    depthTestEnabled?: boolean;
    depthWriteEnabled?: boolean;
    depthFunction?: number;
    alphaTestEnabled?: boolean;
    alphaTestFunc?: number;
    alphaRef?: number;
    cullMode?: number;
    constantColor?: number;
    colorCombine?: number;
    alphaCombine?: number;
    fogMode?: number;
    fogColor?: number;
    clampS?: boolean;
    clampT?: boolean;
    filterLinear?: boolean;
    colorMaskRgb?: boolean;
    colorMaskAlpha?: boolean;
    /** Screen-space bbox the vertices cover, and the raw s/t and 1/w ranges. */
    xy?: [number, number, number, number];
    z?: [number, number];
    st?: [number, number, number, number];
    q?: [number, number];
    colors?: number[];
    /** Raw vertices, opt-in: FLAT [x, y, z, s, t, q, color] per vertex (7 numbers each).
     *  Flat, not nested, because the RPC serializer collapses an array of arrays to its
     *  length — a nested shape comes back as a number and reads like "no vertices".
     *  A bbox says WHERE a triangle is; only the vertices say what SHAPE it is. */
    verts?: number[];
}

export interface GlideFrameCapture {
    frameId: number;
    width: number;
    height: number;
    clearColor: number;
    clearDepth: number;
    constantColor: number;
    alphaRef: number;
    chromaKeyEnabled: boolean;
    chromaKey: number;
    gammaCorrection: number;
    hasLfbPixels: boolean;
    vertexCount: number;
    count: number;
    commands: GlideCapturedDraw[];
}

let armed = false;
let withVertices = false;
let pending: GlideFrameCapture | null = null;

export function armGlideFrameCapture(opts?: { vertices?: boolean }): void {
    armed = true;
    withVertices = !!opts?.vertices;
    pending = null;
}

export function takeGlideFrameCapture(): GlideFrameCapture | null {
    const out = pending;
    pending = null;
    return out;
}

export function isGlideFrameCaptureArmed(): boolean {
    return armed;
}

/** Called from the presenter with the stream it is about to execute. */
export function captureGlideFrame(frameId: number, input: GlideFrameInput): void {
    if (!armed) return;
    armed = false;

    const stream: Legacy3DCommandStream = input.stream;
    const commands: GlideCapturedDraw[] = [];
    const round = (v: number): number => Math.round(v * 1000) / 1000;

    const vtx = { x: 0, y: 0, z: 0, u: 0, v: 0, q: 0, color: 0 };
    for (let k = 0; k < stream.commandCount; k++) {
        if (stream.commandTypeAt(k) === Legacy3DCommandType.Clear) {
            const c = stream.getClearCommand(k)!;
            commands.push({
                k, cmd: "CLEAR",
                clearColor: c.color, clearDepth: c.depth,
                clearsColor: c.clearColor, clearsDepth: c.clearDepth,
            });
            continue;
        }
        const d = stream.getDrawCommand(k);
        if (!d) continue;

        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        let z0 = Infinity, z1 = -Infinity, q0 = Infinity, q1 = -Infinity;
        let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
        const colors: number[] = [];
        const verts: number[] | undefined = withVertices ? [] : undefined;
        for (let v = 0; v < d.vertexCount; v++) {
            stream.readVertex(d.firstVertex + v, vtx);
            const x = vtx.x, y = vtx.y, z = vtx.z;
            const s = vtx.u, t = vtx.v, q = vtx.q;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
            if (q < q0) q0 = q; if (q > q1) q1 = q;
            if (s < s0) s0 = s; if (s > s1) s1 = s;
            if (t < t0) t0 = t; if (t > t1) t1 = t;
            if (colors.length < 4) colors.push(vtx.color >>> 0);
            if (verts) verts.push(round(x), round(y), round(z), round(s), round(t), round(q), vtx.color >>> 0);
        }
        const finite = d.vertexCount > 0;
        commands.push({
            k, cmd: "DRAW",
            topology: d.topology,
            firstVertex: d.firstVertex,
            vertexCount: d.vertexCount,
            textureHandle: d.textureHandle,
            useTexture: d.useTexture,
            blendEnabled: d.blendEnabled,
            blend: d.blend,
            depthTestEnabled: d.depthTestEnabled,
            depthWriteEnabled: d.depthWriteEnabled,
            depthFunction: d.depthFunction,
            alphaTestEnabled: d.alphaTestEnabled,
            alphaTestFunc: d.alphaTestFunc,
            alphaRef: d.alphaRef,
            cullMode: d.cullMode,
            constantColor: d.constantColor,
            colorCombine: d.colorCombine,
            alphaCombine: d.alphaCombine,
            fogMode: d.fogMode,
            fogColor: d.fogColor,
            clampS: d.clampS,
            clampT: d.clampT,
            filterLinear: d.filterLinear,
            colorMaskRgb: d.colorMaskRgb,
            colorMaskAlpha: d.colorMaskAlpha,
            xy: finite ? [round(x0), round(x1), round(y0), round(y1)] : undefined,
            z: finite ? [round(z0), round(z1)] : undefined,
            st: finite ? [round(s0), round(s1), round(t0), round(t1)] : undefined,
            q: finite ? [round(q0), round(q1)] : undefined,
            colors,
            verts,
        });
    }

    pending = {
        frameId,
        width: input.width,
        height: input.height,
        clearColor: input.clearColor >>> 0,
        clearDepth: input.clearDepth >>> 0,
        constantColor: input.constantColor >>> 0,
        alphaRef: input.alphaRef,
        chromaKeyEnabled: input.chromaKeyEnabled,
        chromaKey: input.chromaKey >>> 0,
        gammaCorrection: input.gammaCorrection,
        hasLfbPixels: !!input.lfbPixels,
        vertexCount: stream.getVertexCount(),
        count: commands.length,
        commands,
    };
}
