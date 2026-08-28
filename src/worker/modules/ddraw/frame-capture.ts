/**
 * Frame Capture Engine — records per-draw-call state for one frame.
 * Zero overhead when not capturing (single boolean check).
 */

import type { CapturedClear, CapturedDrawCall, CapturedFrame } from "./frame-capture-types";
import { type DirectDrawSurfaceState, isRenderSurface } from "./com-objects";
import type { FFPLightingState } from "./d3d/ffp-lighting";
import {
    D3DCLEAR_TARGET,
    D3DCLEAR_ZBUFFER,
    D3DCLEAR_STENCIL,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_DESTBLEND,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_COLORKEYENABLE,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_ZFUNC,
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_FOGENABLE,
    D3DRENDERSTATE_CLIPPLANEENABLE,
    D3DRENDERSTATE_FOGCOLOR,
    D3DRENDERSTATE_FOGTABLEMODE,
    D3DRENDERSTATE_FOGVERTEXMODE,
    D3DRENDERSTATE_FOGSTART,
    D3DRENDERSTATE_FOGEND,
    D3DRENDERSTATE_FOGDENSITY,
    D3DRENDERSTATE_SPECULARENABLE,
    D3DRENDERSTATE_TEXTUREADDRESS,
    D3DRENDERSTATE_TEXTUREADDRESSU,
    D3DRENDERSTATE_TEXTUREADDRESSV,
    D3DRENDERSTATE_TEXTUREMAG,
    D3DRENDERSTATE_TEXTUREMIN,
    D3DRENDERSTATE_ANISOTROPY,
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_COLORARG0,
    D3DTSS_ALPHAARG0,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MAXANISOTROPY,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_TEXTURETRANSFORMFLAGS,
    D3DFVF_XYZRHW,
} from "./constants";
import { MAX_FFP_STAGES } from "../../backends/webgpu/ddraw/ffp-stages";

/** Fog range render states carry float BITS in the DWORD slot. */
const dwordBitsScratch = new DataView(new ArrayBuffer(4));
function dwordToFloat(d: number): number {
    dwordBitsScratch.setUint32(0, d >>> 0, true);
    return dwordBitsScratch.getFloat32(0, true);
}

const TOPOLOGY_NAMES: Record<number, string> = {
    1: "POINTLIST", 2: "LINELIST", 3: "LINESTRIP",
    4: "TRILIST", 5: "TRISTRIP", 6: "TRIFAN",
};

// FVF component bit values (fixed D3D constants). Position is bits 1-3 (mask 0x00e).
const FVF_POSITION_MASK = 0x00e;
const FVF_POS_NAMES: Record<number, string> = {
    0x002: "XYZ", 0x004: "XYZRHW", 0x006: "XYZB1",
    0x008: "XYZB2", 0x00a: "XYZB3", 0x00c: "XYZB4", 0x00e: "XYZB5",
};
const FVF_POS_BYTES: Record<number, number> = {
    0x002: 12, 0x004: 16, 0x006: 16, 0x008: 20, 0x00a: 24, 0x00c: 28, 0x00e: 32,
};
const FVF_NORMAL = 0x010, FVF_PSIZE = 0x020, FVF_DIFFUSE = 0x040, FVF_SPECULAR = 0x080;

type FvfLayout = {
    posType: number; posTypeName: string; posBytes: number; isRHW: boolean;
    hasNormal: boolean; hasDiffuse: boolean; hasSpecular: boolean; texCount: number;
    diffuseOff: number; specularOff: number; uv0Off: number; uv1Off: number; stride: number;
};

function texDims(fvf: number, stage: number): number {
    const tc = (fvf & 0xf00) >> 8;
    if (stage < 0 || stage >= tc) return 0;
    const sb = (fvf >>> (16 + stage * 2)) & 0x3;
    return sb === 0 ? 2 : sb === 1 ? 3 : sb === 2 ? 4 : 1;
}

/** Compute per-component byte offsets within a source FVF vertex (mirrors computeFvfStride). */
function fvfLayout(fvf: number): FvfLayout {
    const posType = fvf & FVF_POSITION_MASK;
    const posBytes = FVF_POS_BYTES[posType] ?? 16;
    let cur = posBytes;
    const hasNormal = (fvf & FVF_NORMAL) !== 0; if (hasNormal) cur += 12;
    if ((fvf & FVF_PSIZE) !== 0) cur += 4;
    const hasDiffuse = (fvf & FVF_DIFFUSE) !== 0; const diffuseOff = hasDiffuse ? cur : -1; if (hasDiffuse) cur += 4;
    const hasSpecular = (fvf & FVF_SPECULAR) !== 0; const specularOff = hasSpecular ? cur : -1; if (hasSpecular) cur += 4;
    const texCount = (fvf & 0xf00) >> 8;
    let uv0Off = -1, uv1Off = -1;
    for (let s = 0; s < texCount; s++) {
        if (s === 0) uv0Off = cur; else if (s === 1) uv1Off = cur;
        cur += texDims(fvf, s) * 4;
    }
    return {
        posType, posTypeName: FVF_POS_NAMES[posType] ?? `POS?0x${posType.toString(16)}`,
        posBytes, isRHW: posType === 0x004, hasNormal, hasDiffuse, hasSpecular, texCount,
        diffuseOff, specularOff, uv0Off, uv1Off, stride: cur || 32,
    };
}

/** Read one source vertex's pos(+w)+uv0(+diffuse) at byte address `base`. */
function readSrcVertex(view: DataView, memLen: number, base: number, L: FvfLayout):
    { x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number } | null {
    if (base < 0 || base + 12 > memLen) return null;
    const out: { x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number } =
        { x: view.getFloat32(base, true), y: view.getFloat32(base + 4, true), z: view.getFloat32(base + 8, true) };
    if (L.isRHW && base + 16 <= memLen) out.w = view.getFloat32(base + 12, true);
    if (L.uv0Off >= 0 && base + L.uv0Off + 8 <= memLen) {
        out.u = view.getFloat32(base + L.uv0Off, true);
        out.v = view.getFloat32(base + L.uv0Off + 4, true);
    }
    if (L.diffuseOff >= 0 && base + L.diffuseOff + 4 <= memLen) out.diffuse = view.getUint32(base + L.diffuseOff, true) >>> 0;
    return out;
}

// Module-level capture state
let captureActive = false;
let captureBuffer: CapturedDrawCall[] = [];
let clearBuffer: CapturedClear[] = [];
let captureResolve: ((frame: CapturedFrame) => void) | null = null;
let captureReject: ((e: Error) => void) | null = null;
let captureFrameId = 0;
// Backend of the producer recording this frame (set by recordDrawCall/recordRawDraw).
let captureBackend = "ddraw";
/** Only this producer's frame boundary may end the capture (undefined = any). */
let captureWantBackend: string | undefined;
/** A capture armed between draw calls first sees the tail of the frame already in
 * progress. Discard that boundary so the returned capture always starts at a real
 * frame boundary and includes the following frame's Clear/draw sequence. */
let captureNeedsFrameBoundary = false;
/** Frame ends skipped because they carried nothing — reported, never silently dropped. */
let captureSkippedEmpty = 0;
/** How many empty frame ends to wait through before giving up and reporting one. */
const MAX_EMPTY_FRAME_ENDS = 8;
/** The `firstVertices`/`indexedVertices` sample sizes armed for the in-progress capture,
 *  and what to restore the ambient `__captureVertsMax`/`__captureIndexedVertsMax` globals to
 *  when it ends — so a `captureFrame({maxIndexedVerts})` call cannot leak its override into
 *  the next, unrelated capture. */
let captureConfig: { maxVerts: number; maxIndexedVerts: number } | undefined;
let captureConfigRestore: { maxVerts: number | undefined; maxIndexedVerts: number | undefined } | undefined;

export function isCapturing(): boolean {
    return captureActive;
}

/**
 * Arm a one-frame capture. `backend` restricts which producer's frame boundary ends it:
 * with two render paths alive (a d3d9 game whose launcher still Flips a DDraw primary) the
 * first boundary to fire wins, and a frame from the OTHER path resolves with zero draws —
 * indistinguishable from "nothing drew". An unrestricted capture also waits through empty
 * boundaries rather than reporting the first one.
 *
 * `maxVerts`/`maxIndexedVerts` size the per-draw vertex sample (defaults 4 / 6, see
 * `recordDrawCall`) — configurable because a mesh smaller than the default sample makes
 * "sampled N of N" and "the option did nothing" look identical without a knob to check it.
 */
export function startCapture(backend?: string, opts?: { maxVerts?: number; maxIndexedVerts?: number }): Promise<CapturedFrame> {
    // Settle a still-armed prior capture so its caller doesn't hang until its own
    // timeout (two overlapping captureFrame calls, or capture + dbg.frame()).
    if (captureReject) captureReject(new Error("capture superseded by a new startCapture"));
    captureBuffer = [];
    clearBuffer = [];
    captureBackend = "ddraw";
    captureWantBackend = backend;
    captureSkippedEmpty = 0;
    captureNeedsFrameBoundary = true;
    captureActive = true;
    const g = globalThis as unknown as Record<string, unknown>;
    captureConfigRestore = { maxVerts: g.__captureVertsMax as number | undefined, maxIndexedVerts: g.__captureIndexedVertsMax as number | undefined };
    const maxVerts = opts?.maxVerts && opts.maxVerts > 0 ? opts.maxVerts | 0 : 4;
    const maxIndexedVerts = opts?.maxIndexedVerts && opts.maxIndexedVerts > 0 ? opts.maxIndexedVerts | 0 : 6;
    captureConfig = { maxVerts, maxIndexedVerts };
    g.__captureVertsMax = maxVerts;
    g.__captureIndexedVertsMax = maxIndexedVerts;
    return new Promise<CapturedFrame>((resolve, reject) => {
        captureResolve = resolve;
        captureReject = reject;
    });
}

function restoreCaptureConfig(): void {
    if (!captureConfigRestore) return;
    const g = globalThis as unknown as Record<string, unknown>;
    g.__captureVertsMax = captureConfigRestore.maxVerts;
    g.__captureIndexedVertsMax = captureConfigRestore.maxIndexedVerts;
    captureConfigRestore = undefined;
}

/** Disarm a capture whose consumer timed out or was aborted. Without this the hot
 * draw path keeps appending diagnostic objects forever, eventually stalling the
 * renderer that the capture was meant to inspect. */
export function cancelCapture(reason = new Error("capture cancelled")): void {
    if (!captureActive && !captureReject) return;
    captureActive = false;
    captureBuffer = [];
    clearBuffer = [];
    captureBackend = "ddraw";
    captureWantBackend = undefined;
    captureSkippedEmpty = 0;
    captureNeedsFrameBoundary = false;
    restoreCaptureConfig();
    const reject = captureReject;
    captureResolve = null;
    captureReject = null;
    if (reject) reject(reason);
}

/** Schema fields a partial producer leaves at their default. Listed per draw as
 *  `unmeasured` so a zero here can never be read as a measurement — the whole reason
 *  a d3d9 capture once looked like "depth test off on all 108 draws". */
const RAW_DRAW_MEASURABLE = [
    "primitiveType", "vertexType", "vertexCount", "indexCount", "isRHW",
    "rtSurfacePtr", "rtWidth", "rtHeight", "rtFormat", "tex0", "tex1",
    "alphaBlendEnabled", "srcBlend", "dstBlend", "alphaTestEnabled", "alphaFunc", "alphaRef",
    "colorKeyRenderState", "zEnable", "zWrite", "zFunc", "cullMode", "lightingEnabled", "fogEnabled", "fog",
    "clipPlaneEnable", "colorWriteEnable", "stages", "lighting",
    "colorOp", "alphaOp", "colorArg1", "colorArg2", "alphaArg1", "alphaArg2",
    "legacySamplerState", "stage0SamplerState", "effectiveSamplerState",
    "derivedColorKeyEnabled", "derivedUseTexture", "derivedPremultiply", "derivedShouldBlend",
    "firstVertices", "mvp", "viewport",
] as const;

/**
 * Backend-agnostic draw record. The DDraw/D3D7/D3D8 FFP path uses the rich recordDrawCall
 * above; other producers supply what they can measure here and the rest keeps its schema
 * default — which is why every such default is named in `unmeasured`. Adding a field to a
 * producer removes it from that list automatically. ONE CapturedDrawCall schema, tagged by
 * backend.
 */
export function recordRawDraw(partial: Partial<CapturedDrawCall> & { backend: string }): void {
    if (!captureActive) return;
    captureBackend = partial.backend;
    const unmeasured = RAW_DRAW_MEASURABLE.filter((k) => (partial as Record<string, unknown>)[k] === undefined);
    const call: CapturedDrawCall = {
        primitiveType: 0, primitiveTypeName: "", vertexType: 0, vertexCount: 0, indexCount: 0, isRHW: false,
        firstVertices: [], rtSurfacePtr: 0, rtWidth: 0, rtHeight: 0, tex0: null, tex1: null,
        alphaBlendEnabled: 0, srcBlend: 0, dstBlend: 0, alphaTestEnabled: 0, alphaFunc: 0, alphaRef: 0,
        colorKeyRenderState: 0, zEnable: 0, zWrite: 0, cullMode: 0, lightingEnabled: 0, fogEnabled: 0, clipPlaneEnable: 0,
        colorOp: 0, alphaOp: 0, colorArg1: 0, colorArg2: 0, alphaArg1: 0, alphaArg2: 0,
        legacySamplerState: { textureAddress: 0, textureAddressU: 0, textureAddressV: 0, textureMag: 0, textureMin: 0, anisotropy: 0 },
        stage0SamplerState: { minFilter: 0, magFilter: 0, mipFilter: 0, addressU: 0, addressV: 0, maxAnisotropy: 0 },
        effectiveSamplerState: null, forcePointFilter: false,
        derivedColorKeyEnabled: false, derivedUseTexture: false, derivedPremultiply: false, derivedShouldBlend: false,
        warnings: [],
        ...partial,
        index: captureBuffer.length, // authoritative index (after spread, so partial can't override)
        unmeasured: unmeasured.length ? [...unmeasured] : undefined,
    };
    captureBuffer.push(call);
}

/** Monotonic producer frame-boundary counter, advanced on EVERY onFrameEnd whether or
 *  not a capture is armed. The draw-scrub bisect numbers its draws against this, so a
 *  scrub cut and a capture index name the same draw by construction. RenderService's
 *  present serial is NOT this boundary — the GDI presenter advances it too. */
let frameBoundarySerial = 0;

export function getFrameBoundarySerial(): number {
    return frameBoundarySerial;
}

export function onFrameEnd(producer = "ddraw"): void {
    frameBoundarySerial++;
    if (!captureActive) return;
    if (captureWantBackend !== undefined && producer !== captureWantBackend) return;
    if (captureNeedsFrameBoundary) {
        captureBuffer = [];
        clearBuffer = [];
        captureBackend = "ddraw";
        captureNeedsFrameBoundary = false;
        return;
    }
    const empty = captureBuffer.length === 0 && clearBuffer.length === 0;
    if (empty && captureSkippedEmpty < MAX_EMPTY_FRAME_ENDS) {
        captureSkippedEmpty++;
        return;
    }
    captureActive = false;
    const frame: CapturedFrame = {
        frameId: ++captureFrameId,
        timestamp: performance.now(),
        backend: captureBackend, // ddraw | d3d8 | d3d9, set by the producer that recorded
        producer,
        skippedEmptyFrameEnds: captureSkippedEmpty,
        drawCalls: captureBuffer,
        clears: clearBuffer,
        captureConfig,
    };
    captureBuffer = [];
    clearBuffer = [];
    captureBackend = "ddraw";
    captureWantBackend = undefined;
    captureSkippedEmpty = 0;
    captureNeedsFrameBoundary = false;
    restoreCaptureConfig();
    const resolve = captureResolve;
    captureResolve = null;
    captureReject = null;
    if (resolve) resolve(frame);
}

/**
 * Record a Clear() — the colour the render target is wiped to each frame. Called
 * from the single executor.clear() chokepoint that all D3D3/D3D7 viewport/device
 * clear paths funnel through. For a "screen renders black" bug this is the first
 * thing to check: is the RT cleared to opaque black and the draws contribute
 * nothing visible, or is something drawing black over a non-black clear?
 */
export function recordClear(
    target: DirectDrawSurfaceState,
    flags: number,
    color: number,
    depth: number,
    stencil: number,
    rectCount: number
): void {
    if (!captureActive) return;
    clearBuffer.push({
        index: captureBuffer.length,
        flags: flags >>> 0,
        clearsTarget: (flags & D3DCLEAR_TARGET) !== 0,
        clearsZ: (flags & D3DCLEAR_ZBUFFER) !== 0,
        clearsStencil: (flags & D3DCLEAR_STENCIL) !== 0,
        color: color >>> 0,
        depth,
        stencil: stencil >>> 0,
        rtSurfacePtr: target.surfacePtr >>> 0,
        rtWidth: target.width,
        rtHeight: target.height,
        rectCount: rectCount >>> 0,
    });
}

/**
 * Backend-agnostic Clear record for producers with no DirectDrawSurfaceState (D3D9). Same
 * schema; the point is that a capture never reports `clears: []` for a path that does clear.
 */
export function recordClearRaw(
    flags: number,
    color: number,
    depth: number,
    stencil: number,
    rt: { surfacePtr: number; width: number; height: number },
    rectCount = 0
): void {
    if (!captureActive) return;
    clearBuffer.push({
        index: captureBuffer.length,
        flags: flags >>> 0,
        clearsTarget: (flags & D3DCLEAR_TARGET) !== 0,
        clearsZ: (flags & D3DCLEAR_ZBUFFER) !== 0,
        clearsStencil: (flags & D3DCLEAR_STENCIL) !== 0,
        color: color >>> 0,
        depth,
        stencil: stencil >>> 0,
        rtSurfacePtr: rt.surfacePtr >>> 0,
        rtWidth: rt.width,
        rtHeight: rt.height,
        rectCount: rectCount >>> 0,
    });
}

export type RecordDrawCallParams = {
    primitiveType: number;
    vertexType: number;
    lpVertices: number;
    count: number;
    lpIndices: number;
    iCount: number;
    mem: Uint8Array;
    isIndexed: boolean;
    /** Whether `lpVertices`/`mem` actually describe a vertex source. Defaults to
     *  `lpVertices > 0` (a guest pointer never legitimately sits at NULL), but a producer
     *  that hands `mem` a LOCAL scratch buffer (D3D8's decl-interleave path) has vertices
     *  legitimately starting at offset 0 and must say so explicitly, or the capture reads
     *  a real draw as "no vertex buffer bound". */
    vertexSourceValid?: boolean;
    rtState: DirectDrawSurfaceState;
    texStateObj: DirectDrawSurfaceState | null;
    texStateObj1: DirectDrawSurfaceState | null;
    stageTextures?: readonly (DirectDrawSurfaceState | null)[] | null;
    renderStates: Int32Array | Uint32Array | number[];
    texStates: Int32Array | Uint32Array | number[];
    /** Producer backend tag (default "ddraw"; D3D8 passes "d3d8"). */
    backend?: string;
    /** App-supplied vertex stride (VertexStreamZeroStride). When it exceeds the
     *  packed FVF stride (padded layouts), capture must step by this, not L.stride. */
    sourceStride?: number;
    /** Draw-time MVP (16 floats) as handed to the executor; null for RHW draws. */
    mvp?: Float32Array | number[] | null;
    /** Draw-time viewport as handed to the executor. */
    viewport?: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number } | null;
    /** Draw-time FFP lighting state. It is copied into plain data before capture returns. */
    lighting?: FFPLightingState | null;
    executionDiagnostics: {
        useTexture: boolean;
        minFilter: number;
        magFilter: number;
        mipFilter: number;
        addressU: number;
        addressV: number;
        maxAnisotropy: number;
        forcePointFilter: boolean;
    } | null;
};

export function recordDrawCall(p: RecordDrawCallParams): void {
    const rs = p.renderStates;
    const ts = p.texStates;
    const isRHW = (p.vertexType & D3DFVF_XYZRHW) !== 0;
    const lighting = p.lighting ? {
        material: {
            diffuse: { ...p.lighting.material.diffuse },
            ambient: { ...p.lighting.material.ambient },
            specular: { ...p.lighting.material.specular },
            emissive: { ...p.lighting.material.emissive },
            power: p.lighting.material.power,
        },
        ambient: { ...p.lighting.ambientColor },
        lightCount: p.lighting.lights.length,
        sources: {
            diffuse: p.lighting.diffuseSource,
            ambient: p.lighting.ambientSource,
            specular: p.lighting.specularSource,
            emissive: p.lighting.emissiveSource,
        },
    } : undefined;
    const stages: CapturedDrawCall["stages"] = [];
    for (let stage = 0; stage < MAX_FFP_STAGES; stage++) {
        const base = stage * 32;
        const texture = p.stageTextures?.[stage]
            ?? (stage === 0 ? p.texStateObj : stage === 1 ? p.texStateObj1 : null);
        stages.push({
            stage,
            colorOp: ts[base + D3DTSS_COLOROP] ?? 0,
            colorArg1: ts[base + D3DTSS_COLORARG1] ?? 0,
            colorArg2: ts[base + D3DTSS_COLORARG2] ?? 0,
            alphaOp: ts[base + D3DTSS_ALPHAOP] ?? 0,
            alphaArg1: ts[base + D3DTSS_ALPHAARG1] ?? 0,
            alphaArg2: ts[base + D3DTSS_ALPHAARG2] ?? 0,
            colorArg0: ts[base + D3DTSS_COLORARG0] ?? 0,
            alphaArg0: ts[base + D3DTSS_ALPHAARG0] ?? 0,
            texCoordIndex: ts[base + D3DTSS_TEXCOORDINDEX] ?? 0,
            textureTransformFlags: ts[base + D3DTSS_TEXTURETRANSFORMFLAGS] ?? 0,
            textureWidth: texture?.width ?? 0,
            textureHeight: texture?.height ?? 0,
            texturePtr: texture?.surfacePtr ?? 0,
        });
    }

    // Decode FVF layout (component byte offsets) and read vertices with UV/diffuse.
    const L = fvfLayout(p.vertexType);
    // Step by the app-supplied stride when it's larger than the packed FVF stride
    // (padded vertex layouts), so first/indexed vertices read at the right offsets.
    const stride = (p.sourceStride && p.sourceStride > L.stride) ? p.sourceStride : L.stride;
    const memLen = p.mem.length;
    const dv = new DataView(p.mem.buffer, p.mem.byteOffset, p.mem.byteLength);

    // A producer's `mem` is not always guest memory — D3D8's decl-interleave path hands
    // a LOCAL scratch buffer with vertices legitimately starting at offset 0, so "no
    // vertex source" must come from the producer, not from `lpVertices > 0`.
    const vertexSourceValid = p.vertexSourceValid ?? (p.lpVertices > 0);

    // Sequential first vertices from the start of the buffer (buffer[0..3]).
    // __captureVertsMax (setWorkerFlag) widens the sample for full-mesh dumps —
    // e.g. reading a CPU-skinned character VB tail to spot stale/displaced bones.
    const firstVertices: CapturedDrawCall["firstVertices"] = [];
    let firstVerticesUnavailable: string | undefined;
    if (!vertexSourceValid) {
        firstVerticesUnavailable = "no vertex source (lpVertices/mem invalid, or no VB bound)";
    } else if (stride <= 0) {
        firstVerticesUnavailable = `unsupported stride ${stride} for FVF 0x${p.vertexType.toString(16)}`;
    } else {
        const cfgMax = ((globalThis as unknown as Record<string, unknown>).__captureVertsMax as number) >>> 0;
        const maxV = Math.min(p.count, cfgMax > 0 ? cfgMax : 4);
        for (let i = 0; i < maxV; i++) {
            const v = readSrcVertex(dv, memLen, p.lpVertices + i * stride, L);
            if (!v) { firstVerticesUnavailable = `vertex ${i} out of range (base 0x${(p.lpVertices + i * stride).toString(16)} + 12 > mem.length ${memLen})`; break; }
            firstVertices.push(v);
        }
    }

    // For indexed draws, dereference the vertices the draw ACTUALLY references —
    // this, not buffer[0..3], reveals whether the geometry is screen-space (valid
    // XYZRHW) or object/view space. Sampled at evenly-spaced INDEX POSITIONS across
    // the whole draw (not just the first few), because a bad transform on one mesh
    // chunk can leave its early indices looking fine. `indexedVertexSampleN` is the
    // configured N (`captureFrame({maxIndexedVerts})`), reported so a caller can tell
    // "sampled fewer than N" (small mesh) from "the option wasn't honoured".
    let firstIndices: number[] | undefined;
    let indexedVertices: CapturedDrawCall["indexedVertices"];
    let indexedVerticesUnavailable: string | undefined;
    let indexedVertexSampleN: number | undefined;
    if (p.isIndexed) {
        if (!p.lpIndices || p.iCount <= 0) {
            indexedVerticesUnavailable = "no index source (lpIndices=0 or iCount=0)";
        } else if (!vertexSourceValid) {
            indexedVerticesUnavailable = "no vertex source to dereference indices into";
        } else if (stride <= 0) {
            indexedVerticesUnavailable = `unsupported stride ${stride} for FVF 0x${p.vertexType.toString(16)}`;
        } else {
            firstIndices = [];
            const nIdx = Math.min(12, p.iCount);
            for (let i = 0; i < nIdx; i++) {
                const io = p.lpIndices + i * 2;
                if (io + 2 > memLen) break;
                firstIndices.push(dv.getUint16(io, true));
            }
            const cfgIdxMax = ((globalThis as unknown as Record<string, unknown>).__captureIndexedVertsMax as number) >>> 0;
            const maxIdxV = cfgIdxMax > 0 ? cfgIdxMax : 6;
            indexedVertexSampleN = maxIdxV;
            const positions = Math.max(1, Math.min(maxIdxV * 4, p.iCount));
            indexedVertices = [];
            const seen = new Set<number>();
            for (let k = 0; k < positions && indexedVertices.length < maxIdxV; k++) {
                const pos = positions > 1 ? Math.floor(k * (p.iCount - 1) / (positions - 1)) : 0;
                const io = p.lpIndices + pos * 2;
                if (io + 2 > memLen) continue;
                const idx = dv.getUint16(io, true);
                if (seen.has(idx)) continue;
                seen.add(idx);
                const v = readSrcVertex(dv, memLen, p.lpVertices + idx * stride, L);
                if (v) indexedVertices.push({ idx, ...v });
            }
            if (indexedVertices.length === 0) {
                indexedVerticesUnavailable = `sampled ${positions} index position(s) across ${p.iCount} indices, none dereferenced to a readable vertex`;
                indexedVertices = undefined;
            }
        }
    }

    // Build tex0 info
    const tex0 = p.texStateObj ? {
        surfacePtr: p.texStateObj.surfacePtr,
        width: p.texStateObj.width,
        height: p.texStateObj.height,
        pitch: p.texStateObj.pitch,
        bpp: p.texStateObj.format.bpp,
        aMask: p.texStateObj.format.aMask,
        rMask: p.texStateObj.format.rMask,
        gpuTextureFormat: p.texStateObj.gpuTexture
            ? (p.texStateObj.gpuTexture as GPUTexture).format ?? null
            : null,
        srcColorKey: p.texStateObj.srcColorKey
            ? { low: p.texStateObj.srcColorKey.low, high: p.texStateObj.srcColorKey.high }
            : null,
        hasGpuView: !!p.texStateObj.gpuTextureView,
        surfaceType: p.texStateObj.surfaceType,
        gpuDirty: isRenderSurface(p.texStateObj) ? p.texStateObj.gpuDirty : false,
        rgbaScratchPresent: !!p.texStateObj.rgbaScratch,
        rgbaScratchVersion: isRenderSurface(p.texStateObj) ? p.texStateObj.rgbaScratchVersion : undefined,
        surfaceVersion: isRenderSurface(p.texStateObj) ? p.texStateObj.version : undefined,
    } : null;

    // Build tex1 info
    const tex1 = p.texStateObj1 ? {
        surfacePtr: p.texStateObj1.surfacePtr,
        width: p.texStateObj1.width,
        height: p.texStateObj1.height,
        bpp: p.texStateObj1.format.bpp,
        aMask: p.texStateObj1.format.aMask,
    } : null;

    // Raw render states
    const alphaBlendEnabled = (rs[D3DRENDERSTATE_ALPHABLENDENABLE] ?? 0) as number;
    const srcBlend = (rs[D3DRENDERSTATE_SRCBLEND] ?? 0) as number;
    const dstBlend = (rs[D3DRENDERSTATE_DESTBLEND] ?? 0) as number;
    const alphaTestEnabled = (rs[D3DRENDERSTATE_ALPHATESTENABLE] ?? 0) as number;
    const alphaFunc = (rs[D3DRENDERSTATE_ALPHAFUNC] ?? 0) as number;
    const alphaRef = (rs[D3DRENDERSTATE_ALPHAREF] ?? 0) as number;
    const colorKeyRenderState = (rs[D3DRENDERSTATE_COLORKEYENABLE] ?? 0) as number;
    const zEnable = (rs[D3DRENDERSTATE_ZENABLE] ?? 0) as number;
    const zWrite = (rs[D3DRENDERSTATE_ZWRITEENABLE] ?? 0) as number;
    const zFunc = (rs[D3DRENDERSTATE_ZFUNC] ?? 0) as number;
    const cullMode = (rs[D3DRENDERSTATE_CULLMODE] ?? 0) as number;
    const lightingEnabled = (rs[D3DRENDERSTATE_LIGHTING] ?? 0) as number;
    const fogEnabled = (rs[D3DRENDERSTATE_FOGENABLE] ?? 0) as number;
    // FFP user clip planes. A wrongly-applied plane slices geometry along a straight
    // line and looks exactly like missing draws, so the capture has to be able to say
    // whether any plane was even armed for this draw.
    const clipPlaneEnable = (rs[D3DRENDERSTATE_CLIPPLANEENABLE] ?? 0) as number;
    const fog = {
        enable: fogEnabled,
        tableMode: (rs[D3DRENDERSTATE_FOGTABLEMODE] ?? 0) as number,
        vertexMode: (rs[D3DRENDERSTATE_FOGVERTEXMODE] ?? 0) as number,
        colorArgb: ((rs[D3DRENDERSTATE_FOGCOLOR] ?? 0) as number) >>> 0,
        start: dwordToFloat((rs[D3DRENDERSTATE_FOGSTART] ?? 0) as number),
        end: dwordToFloat((rs[D3DRENDERSTATE_FOGEND] ?? 0) as number),
        density: dwordToFloat((rs[D3DRENDERSTATE_FOGDENSITY] ?? 0) as number),
        specularEnable: (rs[D3DRENDERSTATE_SPECULARENABLE] ?? 0) as number,
    };

    // Texture stage states (stage 0)
    const colorOp = (ts[0 * 32 + D3DTSS_COLOROP] ?? 0) as number;
    const alphaOp = (ts[0 * 32 + D3DTSS_ALPHAOP] ?? 0) as number;
    const colorArg1 = (ts[0 * 32 + D3DTSS_COLORARG1] ?? 0) as number;
    const colorArg2 = (ts[0 * 32 + D3DTSS_COLORARG2] ?? 0) as number;
    const alphaArg1 = (ts[0 * 32 + D3DTSS_ALPHAARG1] ?? 0) as number;
    const alphaArg2 = (ts[0 * 32 + D3DTSS_ALPHAARG2] ?? 0) as number;

    const legacySamplerState = {
        textureAddress: (rs[D3DRENDERSTATE_TEXTUREADDRESS] ?? 0) as number,
        textureAddressU: (rs[D3DRENDERSTATE_TEXTUREADDRESSU] ?? 0) as number,
        textureAddressV: (rs[D3DRENDERSTATE_TEXTUREADDRESSV] ?? 0) as number,
        textureMag: (rs[D3DRENDERSTATE_TEXTUREMAG] ?? 0) as number,
        textureMin: (rs[D3DRENDERSTATE_TEXTUREMIN] ?? 0) as number,
        anisotropy: (rs[D3DRENDERSTATE_ANISOTROPY] ?? 0) as number,
    };
    const stage0SamplerState = {
        minFilter: (ts[0 * 32 + D3DTSS_MINFILTER] ?? 0) as number,
        magFilter: (ts[0 * 32 + D3DTSS_MAGFILTER] ?? 0) as number,
        mipFilter: (ts[0 * 32 + D3DTSS_MIPFILTER] ?? 0) as number,
        addressU: (ts[0 * 32 + D3DTSS_ADDRESSU] ?? 0) as number,
        addressV: (ts[0 * 32 + D3DTSS_ADDRESSV] ?? 0) as number,
        maxAnisotropy: (ts[0 * 32 + D3DTSS_MAXANISOTROPY] ?? 0) as number,
    };
    const effectiveSamplerState = p.executionDiagnostics ? {
        minFilter: p.executionDiagnostics.minFilter,
        magFilter: p.executionDiagnostics.magFilter,
        mipFilter: p.executionDiagnostics.mipFilter,
        addressU: p.executionDiagnostics.addressU,
        addressV: p.executionDiagnostics.addressV,
        maxAnisotropy: p.executionDiagnostics.maxAnisotropy,
    } : null;

    // Derived state
    const derivedColorKeyEnabled = !!(tex0?.srcColorKey);
    const derivedUseTexture = p.executionDiagnostics?.useTexture ?? !!p.texStateObj;
    const derivedPremultiply = false; // placeholder — determined deeper in executor
    const derivedShouldBlend = alphaBlendEnabled !== 0;

    // Sample first 8 raw ARGB1555 pixels from texture guest memory (diagnostic for bit15/alpha)
    let tex0Pixels: CapturedDrawCall["tex0Pixels"];
    if (p.texStateObj && p.texStateObj.format.aMask === 0x8000 && p.texStateObj.format.bpp === 16) {
        const texState = p.texStateObj;
        const pixelPtr = texState.surfacePtr;
        if (pixelPtr > 0 && pixelPtr + 16 <= p.mem.length) {
            tex0Pixels = [];
            const dv = new DataView(p.mem.buffer, p.mem.byteOffset, p.mem.byteLength);
            const sampleCount = Math.min(8, Math.floor((texState.width * texState.height)));
            for (let i = 0; i < sampleCount; i++) {
                const row = Math.floor(i / texState.width);
                const col = i % texState.width;
                const off = pixelPtr + row * texState.pitch + col * 2;
                if (off + 2 > p.mem.length) break;
                const raw = dv.getUint16(off, true);
                tex0Pixels.push({
                    raw,
                    bit15: (raw & 0x8000) !== 0,
                    r5: (raw >> 10) & 0x1F,
                    g5: (raw >> 5) & 0x1F,
                    b5: raw & 0x1F,
                });
            }
        }
    }

    // Warning detection
    const warnings: string[] = [];
    if (tex0 && tex0.aMask === 0x8000 && alphaTestEnabled !== 0 && alphaRef < 8) {
        warnings.push(`ARGB1555 tex with alphaTest ON + low ref=${alphaRef}`);
    }
    if (colorKeyRenderState !== 0 && tex0 && !tex0.srcColorKey) {
        warnings.push("colorKey RS=ON but texture has no srcColorKey");
    }
    if (tex0?.srcColorKey) {
        warnings.push(`srcColorKey=0x${tex0.srcColorKey.low.toString(16)}-0x${tex0.srcColorKey.high.toString(16)}`);
    }
    if (!p.texStateObj && colorOp !== 1 /* D3DTOP_DISABLE */) {
        warnings.push(`No texture but colorOp=${colorOp} (not DISABLE)`);
    }
    // Blend ONE/INVSRCALPHA without premultiply
    if (derivedShouldBlend && srcBlend === 2 /* ONE */ && dstBlend === 6 /* INVSRCALPHA */) {
        warnings.push("Blend ONE/INVSRCALPHA — expects premultiplied alpha");
    }

    captureBackend = p.backend ?? "ddraw";
    const call: CapturedDrawCall = {
        index: captureBuffer.length,
        backend: captureBackend,
        primitiveType: p.primitiveType,
        primitiveTypeName: TOPOLOGY_NAMES[p.primitiveType] ?? `UNKNOWN(${p.primitiveType})`,
        vertexType: p.vertexType,
        vertexCount: p.count,
        indexCount: p.isIndexed ? p.iCount : 0,
        isRHW,
        posTypeName: L.posTypeName,
        srcStride: L.stride,
        hasNormal: L.hasNormal,
        hasDiffuse: L.hasDiffuse,
        hasSpecular: L.hasSpecular,
        texCount: L.texCount,
        firstVertices,
        firstVerticesUnavailable,
        firstIndices,
        indexedVertices,
        indexedVerticesUnavailable,
        indexedVertexSampleN,
        rtSurfacePtr: p.rtState.surfacePtr,
        rtWidth: p.rtState.width,
        rtHeight: p.rtState.height,
        rtFormat: p.rtState.gpuTexture ? ((p.rtState.gpuTexture as GPUTexture).format ?? null) : null,
        tex0,
        tex1,
        alphaBlendEnabled,
        srcBlend,
        dstBlend,
        alphaTestEnabled,
        alphaFunc,
        alphaRef,
        colorKeyRenderState,
        zEnable,
        zWrite,
        zFunc,
        cullMode,
        lightingEnabled,
        lighting,
        stages,
        fogEnabled,
        fog,
        clipPlaneEnable,
        colorOp,
        alphaOp,
        colorArg1,
        colorArg2,
        alphaArg1,
        alphaArg2,
        legacySamplerState,
        stage0SamplerState,
        effectiveSamplerState,
        forcePointFilter: p.executionDiagnostics?.forcePointFilter ?? false,
        derivedColorKeyEnabled,
        derivedUseTexture,
        derivedPremultiply,
        derivedShouldBlend,
        warnings,
        mvp: p.mvp ? Array.from(p.mvp) : null,
        viewport: p.viewport ? { ...p.viewport } : null,
        tex0Pixels,
    };

    captureBuffer.push(call);
}
