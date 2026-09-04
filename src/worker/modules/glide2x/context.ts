import { Process } from "../../core/process";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import type { DecodedNccTable } from "../../backends/webgpu/glide/glide-texture-decoder";
import { Legacy3DCommandStream } from "../../backends/webgpu/legacy3d/command-stream";
import { Legacy3DFFPState } from "../../backends/webgpu/legacy3d/ffp-state";
import type { GlideBackendExecutor } from "../../backends/webgpu/glide/glide-backend-executor";
import type { GlidePresenter } from "./presenter";
import {
    GLIDE_DEFAULT_HEIGHT,
    GLIDE_DEFAULT_WIDTH,
    GLIDE_EVENT_RING_CAPACITY,
    GLIDE_TMU_COUNT,
    GR_CMP_LESS,
    GR_STATE_SIZE,
} from "./constants";
import { GlideDiagnostics } from "./diagnostics";

export type GlideTextureRecord = {
    handle: number;
    tmu: number;
    startAddress: number;
    dataPtr: number;
    width: number;
    height: number;
    format: number;
    bytes: number;
    /** GrTexInfo as the guest declared it — the only record of what we were TOLD the
     *  texture is, as opposed to what we decided its dimensions are. */
    smallLod: number;
    largeLod: number;
    aspectRatio: number;
    /** grTexDownloadMipMap's GR_MIPMAPLEVELMASK_* (which LODs the download carries). */
    evenOdd: number;
    uploadedAt: number;
    lastUsedFrame: number;
    /**
     * Copy of the guest bytes this texture was decoded FROM, kept for diagnostics.
     * `dataPtr` is a guest scratch buffer the title reuses, so re-reading it later
     * decodes SOME OTHER texture and the dump lies without saying so. Bounded by
     * the TMU memory these records mirror.
     */
    sourceBytes: Uint8Array | null;
};

export type GlideTMUState = {
    minAddress: number;
    maxAddress: number;
    currentAddress: number;
    clampS: number;
    clampT: number;
    minFilter: number;
    magFilter: number;
    mipMapMode: number;
    lodBias: number;
    combineFunction: number;
    // NCC/YIQ decompression tables (GR_TEXTABLE_NCC0/NCC1) and the active selector.
    nccTables: [DecodedNccTable | null, DecodedNccTable | null];
    activeNcc: number;
    multibaseEnabled: boolean;
    baseAddress: number;
    detailScale: number;
    detailMax: number;
    detailBias: number;
    texturesByAddress: Map<number, GlideTextureRecord>;
    palette: Uint32Array | null;
};

export type GlideLfbSurfaceState = {
    buffer: number;
    allocationBase: number;
    dataPtr: number;
    byteSize: number;
    pitch: number;
    width: number;
    height: number;
    bytesPerPixel: number;
    writeMode: number;
    dirty: boolean;
    activeLeaseId: number;
};

export type GlideLfbLockState = {
    type: number;
    buffer: number;
    leaseId: number;
    infoPtr: number;
    writeMode: number;
    origin: number;
    dataPtr: number;
    byteSize: number;
    pitch: number;
    writeAccess: boolean;
};

export type GlideFrameSnapshot = {
    frameId: number;
    drawCalls: number;
    presents: number;
    lfbLocks: number;
    /** Locks that asked to READ the buffer (GR_LFB_READ_ONLY) — a post-process reading
     *  back the rendered scene, which a write-only LFB mirror cannot answer. */
    lfbReadLocks: number;
    lfbUnlocks: number;
    lfbReads: number;
    lfbWrites: number;
    texDownloads: number;
    frameCounters: {
        textureBinds: number;
        uploads: number;
        clears: number;
        cacheHits: number;
        cacheMisses: number;
        waitTimeMs: number;
        vertexBytes: number;
        textureBytes: number;
    };
    lastDraw?: {
        topology: string;
        vertexCount: number;
        textured: boolean;
        blend: boolean;
        depthTest: boolean;
        alphaTest: boolean;
        timestamp: number;
    };
    lastSwap?: {
        swapInterval: number;
        timestamp: number;
    };
    lastError?: {
        code: number;
        message: string;
        timestamp: number;
    };
};

export type GlideDebugInfo = {
    state: {
        initialized: boolean;
        winOpen: boolean;
        width: number;
        height: number;
        renderBuffer: number;
        selectedSst: number;
        colorFormat: number;
        origin: number;
    };
    textures: Array<Omit<GlideTextureRecord, "sourceBytes"> & { sourceBytes: number }>;
    lfbSurfaces: Array<{
        buffer: number;
        address: number;
        width: number;
        height: number;
        pitch: number;
        bytesPerPixel: number;
        writeMode: number;
        dirty: boolean;
        activeLeaseId: number;
    }>;
    /** The live render state a screenshot cannot show: clip window, viewport, cull,
     *  fog and the TMU filter/mip modes. */
    runtime: {
        clipWindow: { minX: number; minY: number; maxX: number; maxY: number };
        viewport: { x: number; y: number; width: number; height: number };
        cullMode: number;
        fogMode: number;
        stwHint: number;
        colorCombineDelta0: boolean;
        lastGuColorCombineFunction: number;
        tmu0: { minFilter: number; magFilter: number; mipMapMode: number; lodBias: number; clampS: number; clampT: number };
    };
    ringEvents: Array<{ id: number; type: string; timestamp: number; detail?: string }>;
    frameSnapshot: GlideFrameSnapshot;
    pipelineCache?: { hits: number; misses: number; size: number };
    executorMetrics?: Record<string, number>;
};

export type GlideRuntimeState = {
    colorCombine: { function: number; factor: number; local: number; other: number; invert: number };
    alphaCombine: { function: number; factor: number; local: number; other: number; invert: number };
    alphaBlend: { rgbSf: number; rgbDf: number; alphaSf: number; alphaDf: number };
    alphaTestFunction: number;
    alphaReference: number;
    fogMode: number;
    fogColor: number;
    fogDensity: number;
    fogStart: number;
    fogEnd: number;
    fogTable: Uint8Array;
    depthBias: number;
    depthFunction: number;
    depthMode: number;
    depthMask: boolean;
    clipWindow: { minX: number; minY: number; maxX: number; maxY: number };
    viewport: { x: number; y: number; width: number; height: number };
    colorMask: { rgb: boolean; alpha: boolean };
    cullMode: number;
    ditherMode: number;
    chromaKeyMode: number;
    chromaKeyValue: number;
    constantColorValue: number;
    gammaValue: number;
    /** grHints(GR_HINT_STWHINT) mask — decides whether tmuvtx[].oow is even valid. */
    stwHint: number;
    /** _grColorCombineDelta0Mode (gdraw.c): the RGB iterator slopes are pinned to 0 and
     *  Fr/Fg/Fb to gc->state.r/g/b, so the iterated colour is FLAT and paramIndex drops
     *  STATE_REQUIRES_IT_DRGB — the vertex r/g/b are then never read (gglide.c:1999, 2270).
     *  Titles rely on that and leave those fields stale, so iterating them paints garbage. */
    colorCombineDelta0: boolean;
    /** gc->state.r/g/b as 0x00RRGGBB — the flat colour delta0 loads. Written ONLY by
     *  grConstantColorValue4 (gglide.c:1299); the packed grConstantColorValue does not
     *  touch it, so an unset value is the hardware default (black), not "unknown". */
    delta0Rgb: number;
};

export type GlideContext = {
    process: Process;
    backend: WebGPUBackend | null;
    executor: GlideBackendExecutor | null;
    presenter: GlidePresenter | null;
    diagnostics: GlideDiagnostics;
    errorCallback: number;
    initialized: boolean;
    winOpen: boolean;
    /** Display mode in force before a fullscreen grSstWinOpen took the screen; grSstWinClose
     *  puts it back, exactly as a real board hands the desktop mode back on shutdown. */
    modeBeforeWinOpen: { width: number; height: number; bpp: number; refreshRate: number } | null;
    selectedSst: number;
    width: number;
    height: number;
    colorFormat: number;
    origin: number;
    renderBuffer: number;
    pendingClearColor: number;
    pendingClearDepth: number;
    pendingSwapInterval: number;
    /** grLfbWriteColorFormat / grLfbWriteColorSwizzle state (glide.h GrColorFormat_t). */
    lfbWriteColorFormat: number;
    lfbWriteColorSwizzleBytes: boolean;
    lfbWriteColorSwizzleWords: boolean;
    stream: Legacy3DCommandStream;
    /**
     * Command-stream length at the last guest LFB write. A write recorded after every
     * draw of the frame composites over the finished picture; one recorded before them
     * is a background. The two composite in opposite orders, and only the stream
     * position tells them apart.
     */
    lfbWriteMark: number;
    /**
     * The guest READ the frame buffer during this frame. Only then is a later LFB write
     * a post-process: its content is derived from the frame, so the pixels it did not
     * change already equal the frame. A write with no read before it is a background —
     * and a late write with no read (a cursor, an overlay) must stay a background, or
     * it buries everything drawn before it.
     */
    lfbReadThisFrame: boolean;
    /** frameId at which the LFB surface was last refreshed from the rendered frame. */
    lfbSyncedFrame: number;
    /** Reused RGBA staging for the per-present LFB conversion (see presenter.ts). */
    lfbRgbaScratch: Uint8Array | null;
    /** Which surface + dataPtr lfbRgbaScratch currently holds, so an unchanged
     *  frame can reuse it instead of re-running 307k pixel conversions. */
    lfbRgbaSource: number;
    /** Bumped whenever the LFB surface's pixels change, so the presenter's upload
     *  can skip re-converting an image the GPU already holds. */
    lfbContentVersion: number;
    ffpState: Legacy3DFFPState;
    runtime: GlideRuntimeState;
    tmus: GlideTMUState[];
    nextTextureHandle: number;
    lfbSurfaces: Map<number, GlideLfbSurfaceState>;
    activeLfbLock: GlideLfbLockState | null;
    frameSnapshot: GlideFrameSnapshot;
    stateBlob: Uint8Array;
    apiState: {
        glideStateVersion: number;
        lastHintType: number;
        lastHintMask: number;
        lastGuColorCombineFunction: number;
    };
};

/** Exported so a test can build a context over the REAL default render state;
 *  a hand-rolled stand-in drifts from it silently. */
export function createDefaultRuntimeState(): GlideRuntimeState {
    return {
        // Default to iterated-color passthrough (FUNCTION_LOCAL, LOCAL_ITERATED) so a
        // draw before the game sets a combine renders vertex color, not black.
        colorCombine: { function: 1 /*LOCAL*/, factor: 0, local: 0 /*ITERATED*/, other: 0, invert: 0 },
        alphaCombine: { function: 1 /*LOCAL*/, factor: 0, local: 0 /*ITERATED*/, other: 0, invert: 0 },
        // Glide default blend is opaque: GR_BLEND_ONE (4) / GR_BLEND_ZERO (0).
        alphaBlend: { rgbSf: 4, rgbDf: 0, alphaSf: 4, alphaDf: 0 },
        // Default alpha test is GR_CMP_ALWAYS (no test); GR_CMP_NEVER would discard all.
        alphaTestFunction: 7 /*GR_CMP_ALWAYS*/,
        alphaReference: 0,
        fogMode: 0,
        fogColor: 0,
        fogDensity: 1,
        fogStart: 0,
        fogEnd: 1,
        fogTable: new Uint8Array(64),
        depthBias: 0,
        depthFunction: GR_CMP_LESS,
        depthMode: 0,
        depthMask: true,
        clipWindow: { minX: 0, minY: 0, maxX: GLIDE_DEFAULT_WIDTH, maxY: GLIDE_DEFAULT_HEIGHT },
        viewport: { x: 0, y: 0, width: GLIDE_DEFAULT_WIDTH, height: GLIDE_DEFAULT_HEIGHT },
        colorMask: { rgb: true, alpha: true },
        cullMode: 0,
        ditherMode: 0,
        chromaKeyMode: 0,
        chromaKeyValue: 0,
        constantColorValue: 0xffffffff,
        // CVG GLIDE_DEFAULT_GAMMA; real drivers call grGammaCorrectionValue on init.
        gammaValue: 1.3,
        stwHint: 0,
        colorCombineDelta0: false,
        delta0Rgb: 0,
    };
}

function createDefaultTMUState(): GlideTMUState {
    return {
        minAddress: 0,
        maxAddress: 0,
        currentAddress: 0,
        clampS: 0,
        clampT: 0,
        minFilter: 0,
        magFilter: 0,
        mipMapMode: 0,
        lodBias: 0,
        combineFunction: 0,
        nccTables: [null, null],
        activeNcc: 0,
        multibaseEnabled: false,
        baseAddress: 0,
        detailScale: 0,
        detailMax: 0,
        detailBias: 0,
        texturesByAddress: new Map(),
        palette: null,
    };
}

export function createGlideContext(process: Process): GlideContext {
    const tmus: GlideTMUState[] = [];
    for (let i = 0; i < GLIDE_TMU_COUNT; i++) {
        tmus.push(createDefaultTMUState());
    }

    return {
        process,
        backend: null,
        executor: null,
        presenter: null,
        diagnostics: new GlideDiagnostics(GLIDE_EVENT_RING_CAPACITY),
        errorCallback: 0,
        initialized: false,
        winOpen: false,
        modeBeforeWinOpen: null,
        selectedSst: 0,
        width: GLIDE_DEFAULT_WIDTH,
        height: GLIDE_DEFAULT_HEIGHT,
        colorFormat: 0,
        origin: 0,
        renderBuffer: 1,
        pendingClearColor: 0,
        pendingClearDepth: 0xffff,
        pendingSwapInterval: 0,
        lfbWriteColorFormat: 0, // GR_COLORFORMAT_ARGB
        lfbWriteColorSwizzleBytes: false,
        lfbWriteColorSwizzleWords: false,
        stream: new Legacy3DCommandStream(),
        lfbWriteMark: -1,
        lfbReadThisFrame: false,
        lfbSyncedFrame: -1,
        lfbRgbaScratch: null,
        lfbRgbaSource: 0,
        lfbContentVersion: 1,
        ffpState: new Legacy3DFFPState(),
        runtime: createDefaultRuntimeState(),
        tmus,
        nextTextureHandle: 1,
        lfbSurfaces: new Map(),
        activeLfbLock: null,
        frameSnapshot: {
            frameId: 0,
            drawCalls: 0,
            presents: 0,
            lfbLocks: 0,
            lfbReadLocks: 0,
            lfbUnlocks: 0,
            lfbReads: 0,
            lfbWrites: 0,
            texDownloads: 0,
            frameCounters: {
                textureBinds: 0,
                uploads: 0,
                clears: 0,
                cacheHits: 0,
                cacheMisses: 0,
                waitTimeMs: 0,
                vertexBytes: 0,
                textureBytes: 0,
            },
        },
        stateBlob: new Uint8Array(GR_STATE_SIZE),
        apiState: {
            glideStateVersion: 1,
            lastHintType: 0,
            lastHintMask: 0,
            lastGuColorCombineFunction: 0,
        },
    };
}

/** gsst.c board defaults after grSstWinOpen (gamma, combine, color mask, dither). */
export function applySstBoardDefaults(context: GlideContext): void {
    // GR_COMBINE_FUNCTION_SCALE_OTHER=3, GR_COMBINE_FACTOR_ONE=8,
    // GR_COMBINE_LOCAL_ITERATED=0, GR_COMBINE_OTHER_ITERATED=0
    context.runtime.colorCombine = { function: 3, factor: 8, local: 0, other: 0, invert: 0 };
    // SCALE_OTHER, ONE, LOCAL_CONSTANT/NONE=1, OTHER_CONSTANT=2
    context.runtime.alphaCombine = { function: 3, factor: 8, local: 1, other: 2, invert: 0 };
    context.runtime.alphaBlend = { rgbSf: 4, rgbDf: 0, alphaSf: 4, alphaDf: 0 };
    context.runtime.colorMask = { rgb: true, alpha: false };
    context.runtime.ditherMode = 1; // GR_DITHER_4x4
    context.runtime.fogMode = 0;
    context.runtime.constantColorValue = 0xffffffff;
    context.runtime.gammaValue = 1.3;
    context.runtime.stwHint = 0;
    // gsst.c — grSstWinOpen leaves delta0 mode off.
    context.runtime.colorCombineDelta0 = false;
    context.ffpState.setBlend(false);
    context.ffpState.setFog(false);
}

export function resetGlideContextRuntime(context: GlideContext): void {
    context.stream.reset();
    context.ffpState.reset();
    context.runtime = createDefaultRuntimeState();
    context.lfbSurfaces.clear();
    context.activeLfbLock = null;
    context.pendingClearColor = 0;
    context.pendingClearDepth = 0xffff;
    context.lfbWriteColorFormat = 0;
    context.lfbWriteColorSwizzleBytes = false;
    context.lfbWriteColorSwizzleWords = false;
    context.renderBuffer = 1;
    context.winOpen = false;
    context.frameSnapshot.frameId = 0;
    context.frameSnapshot.drawCalls = 0;
    context.frameSnapshot.presents = 0;
    context.frameSnapshot.lfbLocks = 0;
    context.frameSnapshot.lfbUnlocks = 0;
    context.frameSnapshot.lfbReads = 0;
    context.frameSnapshot.lfbWrites = 0;
    context.frameSnapshot.texDownloads = 0;
    context.frameSnapshot.lastDraw = undefined;
    context.frameSnapshot.lastSwap = undefined;
    context.frameSnapshot.lastError = undefined;
    context.frameSnapshot.frameCounters.textureBinds = 0;
    context.frameSnapshot.frameCounters.uploads = 0;
    context.frameSnapshot.frameCounters.clears = 0;
    context.frameSnapshot.frameCounters.cacheHits = 0;
    context.frameSnapshot.frameCounters.cacheMisses = 0;
    context.frameSnapshot.frameCounters.waitTimeMs = 0;
    context.frameSnapshot.frameCounters.vertexBytes = 0;
    context.frameSnapshot.frameCounters.textureBytes = 0;
    context.apiState.glideStateVersion = 1;
    context.apiState.lastHintType = 0;
    context.apiState.lastHintMask = 0;
    context.apiState.lastGuColorCombineFunction = 0;

    for (const tmu of context.tmus) {
        tmu.currentAddress = 0;
        tmu.clampS = 0;
        tmu.clampT = 0;
        tmu.minFilter = 0;
        tmu.magFilter = 0;
        tmu.mipMapMode = 0;
        tmu.lodBias = 0;
        tmu.combineFunction = 0;
        tmu.nccTables[0] = null;
        tmu.nccTables[1] = null;
        tmu.activeNcc = 0;
        tmu.multibaseEnabled = false;
        tmu.baseAddress = 0;
        tmu.detailScale = 0;
        tmu.detailMax = 0;
        tmu.detailBias = 0;
        tmu.texturesByAddress.clear();
    }
}
