/**
 * Types for the per-frame draw call capture / analysis tool ("built-in RenderDoc").
 */

export type CapturedDrawCall = {
    index: number;
    /** Producer backend (single shared draw-call schema across backends): ddraw | d3d8 | d3d9. */
    backend?: string;
    /** D3D9 programmable draws set this (no FFP render-state arrays available). */
    programmable?: boolean;
    // Geometry
    primitiveType: number;
    primitiveTypeName: string;
    vertexType: number;       // FVF
    vertexCount: number;
    indexCount: number;
    isRHW: boolean;
    // FVF decode (so the dump is self-describing)
    posTypeName?: string;     // "XYZ" | "XYZRHW" | "XYZB1".. — pre-transformed iff XYZRHW
    srcStride?: number;       // bytes per source vertex
    hasNormal?: boolean;
    hasDiffuse?: boolean;
    hasSpecular?: boolean;
    texCount?: number;
    // First vertices read sequentially from the start of the vertex buffer.
    // For INDEXED draws these are buffer[0..3] (often unused/stale) — use
    // indexedVertices below for the vertices the draw actually references.
    firstVertices: Array<{x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number}>;  // max 4
    // First raw index values (indexed draws only); 16-bit WORD indices (D3D7).
    firstIndices?: number[];
    // Vertices the draw ACTUALLY references — dereferenced through the first few
    // distinct indices. This is what reveals whether indexed geometry is in
    // screen space (valid XYZRHW: 0<=z<=1, w>0) or object/view space (the bug).
    indexedVertices?: Array<{idx: number; x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number}>;
    // Render target
    rtSurfacePtr: number;
    rtWidth: number;
    rtHeight: number;
    /** Actual WebGPU format of the attachment this draw renders into. FFP pipelines are
     *  partitioned by it; a draw whose pipeline was built for another format is rejected
     *  and takes the whole command buffer with it, so a capture must show it. */
    rtFormat?: string | null;
    // Texture 0
    tex0: {
        surfacePtr: number;
        width: number;
        height: number;
        pitch: number;
        bpp: number;
        aMask: number;
        rMask: number;
        gpuTextureFormat: string | null;
        srcColorKey: {low: number; high: number} | null;
        hasGpuView: boolean;
        // Surface sync state at capture time (diagnostic)
        surfaceType: string;        // "render_surface" or "bitmap_texture"
        gpuDirty: boolean;          // RenderSurface only: true = GPU has stale data
        rgbaScratchPresent: boolean;
        rgbaScratchVersion: number | undefined;
        surfaceVersion: number | undefined;
    } | null;
    // Texture 1 (abbreviated)
    tex1: {
        surfacePtr: number;
        width: number;
        height: number;
        bpp: number;
        aMask: number;
    } | null;
    // Key render states (raw from game)
    alphaBlendEnabled: number;
    srcBlend: number;
    dstBlend: number;
    alphaTestEnabled: number;
    alphaFunc: number;
    alphaRef: number;
    colorKeyRenderState: number;
    zEnable: number;
    zWrite: number;
    /** The compare, without which zEnable says nothing about what gets rejected. */
    zFunc?: number;
    cullMode: number;
    lightingEnabled: number;
    fogEnabled: number;
    /** Full fog state. A whole scene resolving to one flat colour is the signature of
     *  fogFactor==1 everywhere, so the raw modes AND the float-decoded range must be
     *  visible side by side (the range states are float bits in a DWORD). */
    fog?: {
        enable: number;
        tableMode: number;
        vertexMode: number;
        colorArgb: number;
        start: number;
        end: number;
        density: number;
        specularEnable: number;
    };
    // Texture stage states (stage 0)
    colorOp: number;
    alphaOp: number;
    colorArg1: number;
    colorArg2: number;
    alphaArg1: number;
    alphaArg2: number;
    // Raw legacy Device3 sampler render states
    legacySamplerState: {
        textureAddress: number;
        textureAddressU: number;
        textureAddressV: number;
        textureMag: number;
        textureMin: number;
        anisotropy: number;
    };
    // Raw texture stage 0 sampler state after API state translation
    stage0SamplerState: {
        minFilter: number;
        magFilter: number;
        mipFilter: number;
        addressU: number;
        addressV: number;
        maxAnisotropy: number;
    };
    // Final sampler state used by the executor, including debug and color-key overrides
    effectiveSamplerState: {
        minFilter: number;
        magFilter: number;
        mipFilter: number;
        addressU: number;
        addressV: number;
        maxAnisotropy: number;
    } | null;
    pointUvBiasApplied: boolean | null;
    forcePointFilter: boolean;
    disablePointUvBias: boolean;
    // Derived state (what the executor actually uses)
    derivedColorKeyEnabled: boolean;
    derivedUseTexture: boolean;
    derivedPremultiply: boolean;
    derivedShouldBlend: boolean;
    // Diagnostics
    warnings: string[];
    /** Fields this producer did NOT measure — their values are schema defaults, not readings.
     *  Absent means every field was measured (the DDraw/D3D7/D3D8 FFP path). */
    unmeasured?: string[];
    // Draw-time MVP (16 floats as handed to the executor). Lets a capture diff
    // transforms across draws/frames — e.g. a skinned body part rendered with a
    // stale world matrix has an MVP wildly different from its sibling parts.
    mvp?: number[] | null;
    // Draw-time viewport (as handed to the executor). Distinguishes main-view vs
    // inset-view (HUD) draws and exposes stale/mangled viewports (thin-sliver geometry).
    viewport?: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number } | null;
    // ARGB1555 pixel sampling (first 8 raw pixels from texture guest memory)
    tex0Pixels?: Array<{raw: number; bit15: boolean; r5: number; g5: number; b5: number}>;
};

export type CapturedClear = {
    index: number;            // position in the frame relative to draws (= drawCalls.length when recorded)
    flags: number;            // raw D3DCLEAR_* bitfield the game passed
    clearsTarget: boolean;    // D3DCLEAR_TARGET — colour buffer
    clearsZ: boolean;         // D3DCLEAR_ZBUFFER
    clearsStencil: boolean;   // D3DCLEAR_STENCIL
    color: number;            // ARGB colour the game asked to clear to (the bg colour)
    depth: number;
    stencil: number;
    rtSurfacePtr: number;
    rtWidth: number;
    rtHeight: number;
    rectCount: number;        // 0 = full-RT clear, >0 = partial (scissor) clear
};

export type CapturedFrame = {
    frameId: number;
    timestamp: number;
    /** Producer backend (single shared draw-call schema across backends). DDraw/D3D7/D3D8 today. */
    backend?: string;
    /** Which render path's frame boundary ended the capture. Differs from `backend` when the
     *  frame recorded nothing — that is the tell for "we captured the wrong path's frame". */
    producer?: string;
    /** Empty frame boundaries waited through before this one. >0 means another path is also
     *  presenting; pass a backend to captureFrame to pin the one you mean. */
    skippedEmptyFrameEnds?: number;
    drawCalls: CapturedDrawCall[];
    clears: CapturedClear[];
};
