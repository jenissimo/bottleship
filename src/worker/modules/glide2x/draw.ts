import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { GlideContext } from "./context";
import {
    GR_CMP_ALWAYS,
    GR_VERTEX_SIZE,
    GR_STWHINT_W_DIFF_TMU0,
    GR_VERTEX_X_OFFSET,
} from "./constants";
import {
    blendIsOpaque,
    combineReferencesTexture,
    packBlend,
    packCombine,
} from "../../backends/webgpu/glide/glide-combine";


type DecodedVertex = {
    x: number;
    y: number;
    ooz: number;
    oow: number;
    tmu0oow: number;
    r: number;
    g: number;
    b: number;
    a: number;
    sow: number;
    tow: number;
};

const floatBitsBuffer = new ArrayBuffer(4);
const floatBitsView = new DataView(floatBitsBuffer);
// Reinterpret a 32-bit register value as the IEEE-754 float the guest passed.
// Glide passes float args (e.g. grSplash x/y/w/h) by value on the stack; reading
// them as `| 0` integers yields garbage.
function dwordToFloat(value: number): number {
    floatBitsView.setUint32(0, value >>> 0, true);
    return floatBitsView.getFloat32(0, true);
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function normalizeColorComponent(v: number): number {
    if (!Number.isFinite(v)) return 255;
    if (v >= 0 && v <= 1.0) return (v * 255) | 0;
    return Math.max(0, Math.min(255, v | 0));
}

function packRgba(r: number, g: number, b: number, a: number): number {
    const rr = normalizeColorComponent(r);
    const gg = normalizeColorComponent(g);
    const bb = normalizeColorComponent(b);
    const aa = normalizeColorComponent(a);
    return ((aa << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
}

// The combine equation runs in WGSL (glide-shader-generator.ts); here we only
// decide whether a texture must be bound for this draw. If neither the color nor
// alpha combine references the texture, we skip binding it (the shader's texColor
// defaults to white and is ignored by the combine).
function drawUsesTexture(context: GlideContext): boolean {
    return (
        context.ffpState.textureEnabled &&
        combineReferencesTexture(context.runtime.colorCombine, context.runtime.alphaCombine)
    );
}

// One bulk read of x..oow plus tmuvtx[0] — 12 consecutive floats from GR_VERTEX_X_OFFSET,
// i.e. through tmuvtx[0].oow at 0x2c, the last field a draw reads. Reading them field by
// field costs a DataView per field, which at three vertices per triangle is the whole
// per-triangle budget. Do NOT round this up: readFloat32Into validates the WHOLE extent
// and refuses the read if any of it is unmapped, so an over-read turns the last vertex of
// an array that ends at the requirement boundary into a white degenerate triangle.
export const GR_VERTEX_FLOATS = 12;
const vertexFloats = new Float32Array(GR_VERTEX_FLOATS);
const F_X = 0, F_Y = 1, F_Z = 2, F_R = 3, F_G = 4, F_B = 5, F_OOZ = 6, F_A = 7, F_OOW = 8;
const F_SOW = 9, F_TOW = 10, F_TMU0_OOW = 11;

function fillVertexFloats(ptr: number, out: Float32Array): void {
    // glide2x has exactly ONE GrVertex layout (glide.h: the GLIDE3 one is behind
    // #ifdef GLIDE3). Scoring the fields to pick a layout per vertex is not a
    // fallback, it is a coin flip that lands differently inside one frame — the
    // symptom is a handful of triangles a frame with garbage s/t and depth.
    if (!Mem.readFloat32Into(ptr, GR_VERTEX_FLOATS, out)) {
        out.fill(0);
        out[F_OOW] = 1;
        out[F_R] = out[F_G] = out[F_B] = out[F_A] = 255;
    }
}

/**
 * The last N grDrawTriangle vertex POINTERS, for `glideTriPtrs`.
 *
 * A frame capture shows the vertex we PUSHED; it cannot say whether a colour came
 * from the guest or from our decode of it. Re-reading the source struct answers
 * that — and, read a frame later, also says whether the guest rewrites the same
 * scratch vertex between triangles. Off until the flag is set: this runs in the
 * hottest handler in the module (22M calls a session in Carmageddon 2).
 */
const TRI_RING = 256;
const triRing = new Uint32Array(TRI_RING * 3);
let triRingCount = 0;

function recordTriangleSource(a: number, b: number, c: number): void {
    if (!(globalThis as { __glideTriPtrRing?: boolean }).__glideTriPtrRing) return;
    const i = (triRingCount++ % TRI_RING) * 3;
    triRing[i] = a; triRing[i + 1] = b; triRing[i + 2] = c;
}

/** [{k, ptrs:[a,b,c]}] newest last, at most TRI_RING entries. */
export function glideTriangleSourceRing(): Array<{ k: number; ptrs: number[] }> {
    const n = Math.min(triRingCount, TRI_RING);
    const out: Array<{ k: number; ptrs: number[] }> = [];
    for (let j = 0; j < n; j++) {
        const idx = ((triRingCount - n + j) % TRI_RING) * 3;
        out.push({ k: triRingCount - n + j, ptrs: [triRing[idx]!, triRing[idx + 1]!, triRing[idx + 2]!] });
    }
    return out;
}

/**
 * grDrawPolygon/…VertexList take a CONTIGUOUS GrVertex[] (glide.h), never a table
 * of pointers. The only compile-time variable is GLIDE_NUM_TMU, which the SDK
 * defaults to 2 (glidesys.h) — that is the stride, not something to guess per call.
 */
function vertexPtrAt(basePtr: number, index: number): number {
    return (basePtr + index * GR_VERTEX_SIZE) >>> 0;
}

/**
 * The whole of a Glide vertex push, over the 12 floats a draw actually reads. Shared
 * verbatim by the OUT-trap path (which reads them out of guest memory) and the
 * write-buffer path (which reads them out of the ring copy taken at call time) — two
 * copies of this would drift on whichever one someone edited, and only under load.
 */
export function pushVertexFloats(context: GlideContext, f: Float32Array, base: number): number {
    const x = f[base + F_X]!;
    const y = f[base + F_Y]!;
    const z = clamp01(f[base + F_OOZ]! / 65535.0);
    // tmuvtx[0].oow is only supplied when the app said so via
    // grHints(GR_HINT_STWHINT, GR_STWHINT_W_DIFF_TMU0); otherwise the field holds
    // whatever the app's vertex struct was last left with, and the vertex's own
    // oow is the perspective divisor.
    const perTmuW = (context.runtime.stwHint & GR_STWHINT_W_DIFF_TMU0) !== 0;
    const qRaw = perTmuW ? f[base + F_TMU0_OOW]! : f[base + F_OOW]!;
    const q = Number.isFinite(qRaw) && Math.abs(qRaw) > 1e-8 ? qRaw : 1.0;
    const u = f[base + F_SOW]!;
    const vTex = f[base + F_TOW]!;
    // In delta0 mode the RGB iterators carry zero slopes and are pinned to the
    // grConstantColorValue4 colour, so the hardware never reads the vertex r/g/b:
    // paramIndex drops STATE_REQUIRES_IT_DRGB (gglide.c:1999) and the data list then
    // omits the R/G/B offsets (gglide.c:2270). Titles rely on that and leave those
    // fields stale in a reused scratch vertex — Carmageddon 2 reuses ONE GrVertex[3]
    // on the stack — so iterating them paints a garbage gradient with a hard seam
    // along every shared edge. Alpha is untouched by delta0 and still comes from the
    // vertex. Otherwise: raw iterated color, the WGSL combine unit picks the inputs.
    const rt = context.runtime;
    const a = f[base + F_A]!;
    const color = rt.colorCombineDelta0
        ? packRgba((rt.delta0Rgb >>> 16) & 0xff, (rt.delta0Rgb >>> 8) & 0xff, rt.delta0Rgb & 0xff, a)
        : packRgba(f[base + F_R]!, f[base + F_G]!, f[base + F_B]!, a);
    return context.stream.pushVertex(x, y, z, u, vTex, q, color);
}

function pushVertexFromPtr(context: GlideContext, ptr: number): number {
    fillVertexFloats(ptr >>> 0, vertexFloats);
    return pushVertexFloats(context, vertexFloats, 0);
}

function pushDraw(
    context: GlideContext,
    topology: "point-list" | "line-list" | "triangle-list",
    firstVertex: number,
    vertexCount: number,
    forceCullDisable: boolean = false,
): void {
    const rt = context.runtime;
    const tmu0 = context.tmus[0];
    // Glide filter mode: 0 = POINT_SAMPLED, 1 = BILINEAR. Treat BILINEAR as linear.
    // Games that don't call grTexFilterMode get whatever the TMU was last set to
    // (initial state is 0 = POINT, matching vendor gsst.c).
    const filterLinear = ((tmu0?.magFilter | 0) === 1) || ((tmu0?.minFilter | 0) === 1);
    const blend = rt.alphaBlend;
    const blendEnabled = !blendIsOpaque(blend.rgbSf, blend.rgbDf, blend.alphaSf, blend.alphaDf);
    // alphaTestFunction is the GR_CMP_* the game set (default GR_CMP_ALWAYS = no test).
    const alphaTestFunc = rt.alphaTestFunction | 0;
    const draw = {
        firstVertex,
        vertexCount,
        topology,
        textureHandle: context.ffpState.textureHandle,
        useTexture: drawUsesTexture(context),
        blendEnabled,
        depthTestEnabled: context.ffpState.depthTestEnabled,
        depthWriteEnabled: context.ffpState.depthWriteEnabled,
        depthFunction: rt.depthFunction,
        alphaTestEnabled: alphaTestFunc !== GR_CMP_ALWAYS,
        alphaRef: rt.alphaReference,
        cullMode: forceCullDisable ? 0 : rt.cullMode,
        constantColor: rt.constantColorValue >>> 0,
        clampS: (tmu0?.clampS | 0) !== 0,
        clampT: (tmu0?.clampT | 0) !== 0,
        filterLinear: filterLinear,
        // Real combine / blend / fog state for the WGSL pipeline.
        colorCombine: packCombine(rt.colorCombine),
        alphaCombine: packCombine(rt.alphaCombine),
        blend: packBlend(blend.rgbSf, blend.rgbDf, blend.alphaSf, blend.alphaDf),
        colorMaskRgb: rt.colorMask.rgb,
        colorMaskAlpha: rt.colorMask.alpha,
        alphaTestFunc,
        fogMode: rt.fogMode | 0,
        fogColor: rt.fogColor >>> 0,
        // GR_MIPMAP_DISABLE (0) means the TMU samples the largest LOD only.
        mipMapEnabled: ((tmu0?.mipMapMode | 0) !== 0),
        clipX0: rt.clipWindow.minX | 0,
        clipY0: rt.clipWindow.minY | 0,
        clipX1: rt.clipWindow.maxX | 0,
        clipY1: rt.clipWindow.maxY | 0,
    };
    context.stream.pushDraw(draw);
    context.frameSnapshot.drawCalls++;
    context.frameSnapshot.frameCounters.vertexBytes += vertexCount * 28;
    context.frameSnapshot.lastDraw = {
        topology,
        vertexCount,
        textured: draw.useTexture,
        blend: draw.blendEnabled,
        depthTest: draw.depthTestEnabled,
        alphaTest: draw.alphaTestEnabled,
        timestamp: performance.now(),
    };
    context.diagnostics.push("draw", `${topology} vtx=${vertexCount}`);
}

function drawIndexedPolygon(context: GlideContext, nVerts: number, indexListPtr: number, vertexListPtr: number): void {
    if (nVerts < 3 || !vertexListPtr) return;
    const indexList: number[] = [];
    for (let i = 0; i < nVerts; i++) {
        if (indexListPtr) {
            indexList.push(Mem.readInt32(indexListPtr + i * 4) ?? i);
        } else {
            indexList.push(i);
        }
    }

    const first = context.stream.getVertexCount();
    for (let i = 1; i < nVerts - 1; i++) {
        const i0 = indexList[0] ?? 0;
        const i1 = indexList[i] ?? i;
        const i2 = indexList[i + 1] ?? (i + 1);
        pushVertexFromPtr(context, vertexPtrAt(vertexListPtr, i0));
        pushVertexFromPtr(context, vertexPtrAt(vertexListPtr, i1));
        pushVertexFromPtr(context, vertexPtrAt(vertexListPtr, i2));
    }

    const vertexCount = (nVerts - 2) * 3;
    if (vertexCount > 0) {
        pushDraw(context, "triangle-list", first, vertexCount);
    }
}

function drawSimpleRect(context: GlideContext, x: number, y: number, w: number, h: number): void {
    const first = context.stream.getVertexCount();
    // grSplash draws with the constant color as the iterated color.
    const color = context.runtime.constantColorValue >>> 0;
    context.stream.pushVertex(x, y, 0, 0, 0, 1, color);
    context.stream.pushVertex(x + w, y, 0, 255, 0, 1, color);
    context.stream.pushVertex(x + w, y + h, 0, 255, 255, 1, color);
    context.stream.pushVertex(x, y, 0, 0, 0, 1, color);
    context.stream.pushVertex(x + w, y + h, 0, 255, 255, 1, color);
    context.stream.pushVertex(x, y + h, 0, 0, 255, 1, color);
    pushDraw(context, "triangle-list", first, 6);
}

/**
 * The whole of grDrawTriangle, shared by the OUT-trap path and the write-buffer drain.
 *
 * `captured`, when present, is the three vertices the WBUF trampoline copied into the ring
 * at CALL time, laid out as GR_VERTEX_FLOATS floats each — which is the entire reason a
 * call taking guest pointers can be deferred at all. The pointers are still passed so the
 * diagnostic ring records what the guest actually handed us, not where we read it from.
 */
export function applyGrDrawTriangle(
    context: GlideContext,
    a: number,
    b: number,
    c: number,
    captured: Float32Array | null,
): number {
    if (!a || !b || !c) return 0;
    const first = context.stream.getVertexCount();
    if (captured) {
        pushVertexFloats(context, captured, 0);
        pushVertexFloats(context, captured, GR_VERTEX_FLOATS);
        pushVertexFloats(context, captured, GR_VERTEX_FLOATS * 2);
    } else {
        pushVertexFromPtr(context, a);
        pushVertexFromPtr(context, b);
        pushVertexFromPtr(context, c);
    }
    pushDraw(context, "triangle-list", first, 3);
    recordTriangleSource(a, b, c);
    return 0;
}

export function createDrawExports(context: GlideContext): Record<string, ThunkImplementation> {
    return {
        "_grDrawPoint@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, ptr);
            pushDraw(context, "point-list", first, 1);
            return 0;
        },

        "_grDrawLine@8": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            if (!a || !b) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushDraw(context, "line-list", first, 2);
            return 0;
        },

        "_grDrawTriangle@12": (_ctx, _mem, args) =>
            applyGrDrawTriangle(context, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, null),

        "_grDrawPlanarPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grDrawPlanarPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        "_grDrawPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grDrawPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        "_grSplash@20": (_ctx, _mem, args) => {
            // grSplash(float x, float y, float width, float height, FxU32 frameNumber)
            const x = dwordToFloat(args[0] >>> 0);
            const y = dwordToFloat(args[1] >>> 0);
            const w = dwordToFloat(args[2] >>> 0);
            const h = dwordToFloat(args[3] >>> 0);
            drawSimpleRect(context, x, y, w, h);
            return 0;
        },

        "_grAADrawLine@8": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            if (!a || !b) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushDraw(context, "line-list", first, 2, /*forceCullDisable*/ true);
            return 0;
        },

        "_grAADrawPoint@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, ptr);
            pushDraw(context, "point-list", first, 1, /*forceCullDisable*/ true);
            return 0;
        },

        "_grAADrawPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grAADrawPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        // grAADrawTriangle(a, b, c, ab_antialias, bc_antialias, ca_antialias) = @24.
        // We don't emulate edge antialiasing flags (args[3..5]); draw as a normal tri.
        "_grAADrawTriangle@24": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            const c = args[2] >>> 0;
            if (!a || !b || !c) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushVertexFromPtr(context, c);
            pushDraw(context, "triangle-list", first, 3, /*forceCullDisable*/ true);
            return 0;
        },
    };
}

