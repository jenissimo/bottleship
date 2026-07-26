/**
 * OpenGL 1.3 context state machine.
 * Column-major 4x4 matrices (OpenGL convention). 16-element Float32Array per matrix.
 */

import { Process } from "../../core/process";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { GL_MODELVIEW, GL_LESS, GL_ONE, GL_ZERO, GL_ALWAYS, GL_BACK, GL_CCW, GL_SMOOTH,
         GL_FILL, GL_LINEAR, GL_MODULATE, GL_NEAREST, GL_REPEAT, GL_TEXTURE0,
         GL_EYE_LINEAR } from "./constants";

// ---- Draw command types ----

/** Floats per vertex in the flat buffer: [x,y,z,w, r,g,b,a, nx,ny,nz, s0,t0,s1,t1] */
export const VERT_FLOATS = 15;

export interface GLDrawVertex {
    x: number; y: number; z: number; w: number;
    r: number; g: number; b: number; a: number;
    nx: number; ny: number; nz: number;
    s0: number; t0: number;
    s1: number; t1: number;
}

// ---- Pre-baked display list types ----

export type GLPrebakedItem =
    | { kind: 'cmd'; fn: string; args: number[] }
    | { kind: 'verts'; mode: number; flatVerts: Float32Array; count: number };

export const enum GLDrawCommandType {
    CLEAR = 0,
    DRAW = 1,
    VIEWPORT = 2,
    SCISSOR = 3,
}

// ---- Flat (SoA) command stream ----
//
// A frame's commands are fixed-size records over two parallel typed arrays: one
// Int32Array for enums/handles/bit flags, one Float32Array for the float state.
// Vertices are NOT owned by a command — they live in the per-frame GLVertexArena
// and a DRAW references them as (CI_VERT_OFFSET, CI_VERT_COUNT). Both the stream
// and the arena are reset (not reallocated) at present, so nothing may retain a
// command or an arena slice past executeFrame().

/** Int32 slots per command record. */
export const CMD_I32 = 33;
/** Float32 slots per command record. */
export const CMD_F32 = 10;

export const CI_TYPE = 0;

// DRAW — integer state
export const CI_MODE = 1;
/** Float index of the first vertex inside the frame vertex arena. */
export const CI_VERT_OFFSET = 2;
export const CI_VERT_COUNT = 3;
export const CI_FLAGS = 4;
export const CI_DEPTH_FUNC = 5;
export const CI_BLEND_SRC = 6;
export const CI_BLEND_DST = 7;
export const CI_ALPHA_FUNC = 8;
export const CI_CULL_FACE = 9;
export const CI_FRONT_FACE = 10;
export const CI_TEX_ID0 = 11;
export const CI_TEX_ID1 = 12;
export const CI_TEXENV0 = 13;
export const CI_TEXENV1 = 14;
export const CI_SHADE_MODEL = 15;
export const CI_FOG_MODE = 16;
export const CI_POLYGON_MODE = 17;
export const CI_STENCIL_FUNC = 18;
export const CI_STENCIL_REF = 19;
export const CI_STENCIL_MASK = 20;
export const CI_STENCIL_FAIL = 21;
export const CI_STENCIL_ZFAIL = 22;
export const CI_STENCIL_ZPASS = 23;
export const CI_STENCIL_WRITE_MASK = 24;
export const CI_SCISSOR_X = 25;
export const CI_SCISSOR_Y = 26;
export const CI_SCISSOR_W = 27;
export const CI_SCISSOR_H = 28;
/** Viewport active when the draw was emitted; also the VIEWPORT command payload. */
export const CI_VP_X = 29;
export const CI_VP_Y = 30;
export const CI_VP_W = 31;
export const CI_VP_H = 32;

// CLEAR — aliases over the same slots (a record is only ever one command type)
export const CI_CLEAR_MASK = 1;
export const CI_CLEAR_STENCIL = 2;

// DRAW — float state
export const CF_ALPHA_REF = 0;
export const CF_FOG_R = 1;
export const CF_FOG_G = 2;
export const CF_FOG_B = 3;
export const CF_FOG_A = 4;
export const CF_FOG_DENSITY = 5;
export const CF_FOG_START = 6;
export const CF_FOG_END = 7;
export const CF_DEPTH_RANGE_NEAR = 8;
export const CF_DEPTH_RANGE_FAR = 9;

// CLEAR — float aliases
export const CF_CLEAR_R = 0;
export const CF_CLEAR_G = 1;
export const CF_CLEAR_B = 2;
export const CF_CLEAR_A = 3;
export const CF_CLEAR_DEPTH = 4;

/** DRAW boolean state, packed into CI_FLAGS. */
export const DF_DEPTH_TEST = 1 << 0;
export const DF_DEPTH_MASK = 1 << 1;
export const DF_BLEND = 1 << 2;
export const DF_ALPHA_TEST = 1 << 3;
export const DF_CULL = 1 << 4;
export const DF_FOG = 1 << 5;
export const DF_COLOR_MASK_R = 1 << 6;
export const DF_COLOR_MASK_G = 1 << 7;
export const DF_COLOR_MASK_B = 1 << 8;
export const DF_COLOR_MASK_A = 1 << 9;
export const DF_STENCIL_TEST = 1 << 10;
export const DF_SCISSOR = 1 << 11;

export class GLCommandStream {
    count = 0;
    i32: Int32Array;
    f32: Float32Array;
    private capacity: number;

    constructor(capacity = 2048) {
        this.capacity = capacity;
        this.i32 = new Int32Array(capacity * CMD_I32);
        this.f32 = new Float32Array(capacity * CMD_F32);
    }

    /** Reserve one record and return its index. Slots are NOT cleared — the
     *  emitter writes every slot its command type reads. */
    alloc(type: GLDrawCommandType): number {
        if (this.count === this.capacity) this.grow();
        const idx = this.count++;
        this.i32[idx * CMD_I32 + CI_TYPE] = type;
        return idx;
    }

    /** Drop the most recently allocated record (used when a draw merges backwards). */
    pop(): void {
        if (this.count > 0) this.count--;
    }

    typeAt(idx: number): number {
        return this.i32[idx * CMD_I32 + CI_TYPE];
    }

    reset(): void {
        this.count = 0;
    }

    private grow(): void {
        const capacity = this.capacity * 2;
        const i32 = new Int32Array(capacity * CMD_I32);
        i32.set(this.i32);
        const f32 = new Float32Array(capacity * CMD_F32);
        f32.set(this.f32);
        this.i32 = i32;
        this.f32 = f32;
        this.capacity = capacity;
    }
}

/** Growable per-frame vertex store. Draw commands hold (offset, count) into it. */
export class GLVertexArena {
    data: Float32Array;
    /** Write cursor, in floats. */
    used = 0;

    constructor(vertexCapacity = 65536) {
        this.data = new Float32Array(vertexCapacity * VERT_FLOATS);
    }

    /** Guarantee room for `vertexCount` more vertices at the cursor. Doubles on
     *  overflow and preserves written data — earlier commands hold offsets into it. */
    reserve(vertexCount: number): void {
        const need = this.used + vertexCount * VERT_FLOATS;
        if (need <= this.data.length) return;
        let capacity = this.data.length;
        while (capacity < need) capacity *= 2;
        const next = new Float32Array(capacity);
        next.set(this.data.subarray(0, this.used));
        this.data = next;
    }

    reset(): void {
        this.used = 0;
    }
}

// ---- Texture state ----

export interface GLTextureObject {
    id: number;
    width: number;
    height: number;
    internalFormat: number;
    data: Uint8Array | null; // RGBA8
    wrapS: number;
    wrapT: number;
    minFilter: number;
    magFilter: number;
    dirty: boolean;
    gpuVersion: number;
}

export interface GLTextureUnit {
    enabled2d: boolean;
    boundTexture: number; // texture name (0=none)
    texEnvMode: number;
}

// ---- Matrix stack ----

export interface GLMatrixStack {
    stack: Float32Array[];
    top: number;
    maxDepth: number;
}

// ---- Client array descriptor ----

export interface GLArrayPointer {
    size: number;
    type: number;
    stride: number;
    pointer: number; // guest address
    enabled: boolean;
}

// ---- TexGen state ----

export interface GLTexGenState {
    mode: number;              // GL_OBJECT_LINEAR, GL_EYE_LINEAR, GL_SPHERE_MAP, etc.
    objectPlane: Float32Array; // 4 floats
    eyePlane: Float32Array;    // 4 floats (transformed by modelview inverse at set time)
}

// ---- Display list ----

export interface GLDisplayList {
    commands: Array<{ fn: string; args: number[] }>;
    prebaked: GLPrebakedItem[] | null;
}

// ---- Frame snapshot for debug ----

export interface GLFrameSnapshot {
    frameId: number;
    drawCalls: number;
    presents: number;
    texUploads: number;
    clearCalls: number;
    vertexCount: number;
}

// ---- Main context ----

export interface OpenGLContext {
    process: Process;
    backend: WebGPUBackend | null;
    executor: any | null; // OpenGLBackendExecutor
    presenter: any | null;

    // Error
    error: number; // GL_NO_ERROR = 0

    // Matrix stacks
    matrixMode: number;
    modelviewStack: GLMatrixStack;
    projectionStack: GLMatrixStack;
    textureStack: GLMatrixStack;

    // Current matrix getter
    currentStack(): GLMatrixStack;
    currentMatrix(): Float32Array;

    // Enable flags
    enableFlags: Set<number>;

    // Viewport
    viewportX: number;
    viewportY: number;
    viewportW: number;
    viewportH: number;
    depthRangeNear: number;
    depthRangeFar: number;

    // Clear values
    clearR: number; clearG: number; clearB: number; clearA: number;
    clearDepth: number;
    clearStencil: number;

    // Depth
    depthFunc: number;
    depthMask: boolean;

    // Blend
    blendSrc: number;
    blendDst: number;

    // Alpha test
    alphaFunc: number;
    alphaRef: number;

    // Cull
    cullFace: number;
    frontFace: number;

    // Shade
    shadeModel: number;

    // Polygon
    polygonModeFront: number;
    polygonModeBack: number;

    // Fog
    fogMode: number;
    fogDensity: number;
    fogStart: number;
    fogEnd: number;
    fogColor: Float32Array;

    // Lighting
    lights: GLLightState[];
    materialFrontAmbient: Float32Array;
    materialFrontDiffuse: Float32Array;
    materialFrontSpecular: Float32Array;
    materialFrontEmission: Float32Array;
    materialFrontShininess: number;
    lightModelAmbient: Float32Array;

    // Color material
    colorMaterialFace: number;
    colorMaterialParam: number;

    // Scissor
    scissorX: number; scissorY: number;
    scissorW: number; scissorH: number;

    // Pixel store
    unpackAlignment: number;
    unpackRowLength: number;
    unpackSkipPixels: number;
    unpackSkipRows: number;
    packAlignment: number;

    // Color mask
    colorMaskR: boolean; colorMaskG: boolean; colorMaskB: boolean; colorMaskA: boolean;

    // Texture state
    activeTextureUnit: number;
    clientActiveTextureUnit: number;
    textureUnits: GLTextureUnit[];
    textures: Map<number, GLTextureObject>;
    nextTextureId: number;

    // Immediate mode
    immediateMode: boolean;
    immediateFlatBuf: Float32Array;
    immediateFlatCount: number;
    immediatePrimMode: number;
    currentColor: Float32Array;
    currentNormal: Float32Array;
    currentTexCoord: Float32Array[]; // per texture unit

    // Client arrays
    vertexArray: GLArrayPointer;
    normalArray: GLArrayPointer;
    colorArray: GLArrayPointer;
    texCoordArrays: GLArrayPointer[];

    // Display lists
    displayLists: Map<number, GLDisplayList>;
    nextListId: number;
    listBase: number;
    compilingList: number | null;
    compilingListMode: number;
    compilingCommands: Array<{ fn: string; args: number[] }>;
    replayingList: boolean;

    // Command stream for backend + the vertex arena its DRAW records point into
    commands: GLCommandStream;
    vertArena: GLVertexArena;

    // Frame stats
    frameSnapshot: GLFrameSnapshot;
    frameId: number;

    // glGetString cache
    stringCache: Map<number, number>; // GLenum -> guest ptr

    // Hints
    hints: Map<number, number>;

    // Point/line
    pointSize: number;
    lineWidth: number;

    // Stencil
    stencilFunc: number;
    stencilRef: number;
    stencilMask: number;
    stencilFail: number;
    stencilZFail: number;
    stencilZPass: number;
    stencilWriteMask: number;

    // Raster position (window coordinates after MVP transform)
    rasterPosX: number;
    rasterPosY: number;
    rasterPosZ: number;
    rasterPosW: number;
    rasterPosValid: boolean;

    // Pixel zoom
    pixelZoomX: number;
    pixelZoomY: number;

    // Logic op
    logicOp: number;

    // Line stipple
    lineStippleFactor: number;
    lineStipplePattern: number;

    // Polygon offset
    polygonOffsetFactor: number;
    polygonOffsetUnits: number;

    // TexGen
    texGenS: GLTexGenState;
    texGenT: GLTexGenState;
    texGenR: GLTexGenState;
    texGenQ: GLTexGenState;
}

export interface GLLightState {
    ambient: Float32Array;
    diffuse: Float32Array;
    specular: Float32Array;
    position: Float32Array;
    spotDirection: Float32Array;
    spotExponent: number;
    spotCutoff: number;
    constantAttenuation: number;
    linearAttenuation: number;
    quadraticAttenuation: number;
}

function createMatrixStack(maxDepth: number): GLMatrixStack {
    const initial = new Float32Array(16);
    mat4Identity(initial);
    return { stack: [initial], top: 0, maxDepth };
}

function createLightDefault(index: number): GLLightState {
    return {
        ambient: new Float32Array([0, 0, 0, 1]),
        diffuse: index === 0 ? new Float32Array([1, 1, 1, 1]) : new Float32Array([0, 0, 0, 1]),
        specular: index === 0 ? new Float32Array([1, 1, 1, 1]) : new Float32Array([0, 0, 0, 1]),
        position: new Float32Array([0, 0, 1, 0]),
        spotDirection: new Float32Array([0, 0, -1]),
        spotExponent: 0,
        spotCutoff: 180,
        constantAttenuation: 1,
        linearAttenuation: 0,
        quadraticAttenuation: 0,
    };
}

function defaultArrayPointer(): GLArrayPointer {
    return { size: 4, type: 0x1406/*GL_FLOAT*/, stride: 0, pointer: 0, enabled: false };
}

function createTexGenState(objectPlane: [number, number, number, number]): GLTexGenState {
    return {
        mode: GL_EYE_LINEAR,
        objectPlane: new Float32Array(objectPlane),
        eyePlane: new Float32Array(objectPlane),
    };
}

export function mat4Identity(out: Float32Array): void {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
}

export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    // Column-major: out = a * b
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
}

export function createOpenGLContext(process: Process): OpenGLContext {
    const modelviewStack = createMatrixStack(32);
    const projectionStack = createMatrixStack(32);
    const textureStack = createMatrixStack(32);

    const ctx: OpenGLContext = {
        process,
        backend: null,
        executor: null,
        presenter: null,

        error: 0,

        matrixMode: GL_MODELVIEW,
        modelviewStack,
        projectionStack,
        textureStack,

        currentStack() {
            switch (this.matrixMode) {
                case GL_MODELVIEW: return this.modelviewStack;
                case 0x1701: return this.projectionStack; // GL_PROJECTION
                case 0x1702: return this.textureStack; // GL_TEXTURE
                default: return this.modelviewStack;
            }
        },
        currentMatrix() {
            const s = this.currentStack();
            return s.stack[s.top];
        },

        enableFlags: new Set(),

        viewportX: 0, viewportY: 0, viewportW: 640, viewportH: 480,
        depthRangeNear: 0, depthRangeFar: 1,

        clearR: 0, clearG: 0, clearB: 0, clearA: 0,
        clearDepth: 1,
        clearStencil: 0,

        depthFunc: GL_LESS,
        depthMask: true,

        blendSrc: GL_ONE,
        blendDst: GL_ZERO,

        alphaFunc: GL_ALWAYS,
        alphaRef: 0,

        cullFace: GL_BACK,
        frontFace: GL_CCW,

        shadeModel: GL_SMOOTH,

        polygonModeFront: GL_FILL,
        polygonModeBack: GL_FILL,

        fogMode: GL_LINEAR,
        fogDensity: 1,
        fogStart: 0,
        fogEnd: 1,
        fogColor: new Float32Array([0, 0, 0, 0]),

        lights: Array.from({ length: 8 }, (_, i) => createLightDefault(i)),
        materialFrontAmbient: new Float32Array([0.2, 0.2, 0.2, 1]),
        materialFrontDiffuse: new Float32Array([0.8, 0.8, 0.8, 1]),
        materialFrontSpecular: new Float32Array([0, 0, 0, 1]),
        materialFrontEmission: new Float32Array([0, 0, 0, 1]),
        materialFrontShininess: 0,
        lightModelAmbient: new Float32Array([0.2, 0.2, 0.2, 1]),

        colorMaterialFace: 0x0408, // GL_FRONT_AND_BACK
        colorMaterialParam: 0x1602, // GL_AMBIENT_AND_DIFFUSE

        scissorX: 0, scissorY: 0, scissorW: 640, scissorH: 480,

        unpackAlignment: 4,
        unpackRowLength: 0,
        unpackSkipPixels: 0,
        unpackSkipRows: 0,
        packAlignment: 4,

        colorMaskR: true, colorMaskG: true, colorMaskB: true, colorMaskA: true,

        activeTextureUnit: 0,
        clientActiveTextureUnit: 0,
        textureUnits: [
            { enabled2d: false, boundTexture: 0, texEnvMode: GL_MODULATE },
            { enabled2d: false, boundTexture: 0, texEnvMode: GL_MODULATE },
        ],
        textures: new Map(),
        nextTextureId: 1,

        immediateMode: false,
        immediateFlatBuf: new Float32Array(65536 * 15),
        immediateFlatCount: 0,
        immediatePrimMode: 0,
        currentColor: new Float32Array([1, 1, 1, 1]),
        currentNormal: new Float32Array([0, 0, 1]),
        currentTexCoord: [new Float32Array([0, 0, 0, 1]), new Float32Array([0, 0, 0, 1])],

        vertexArray: defaultArrayPointer(),
        normalArray: defaultArrayPointer(),
        colorArray: defaultArrayPointer(),
        texCoordArrays: [defaultArrayPointer(), defaultArrayPointer()],

        displayLists: new Map(),
        nextListId: 1,
        listBase: 0,
        compilingList: null,
        compilingListMode: 0,
        compilingCommands: [],
        replayingList: false,

        commands: new GLCommandStream(),
        vertArena: new GLVertexArena(),

        frameSnapshot: { frameId: 0, drawCalls: 0, presents: 0, texUploads: 0, clearCalls: 0, vertexCount: 0 },
        frameId: 0,

        stringCache: new Map(),
        hints: new Map(),

        pointSize: 1,
        lineWidth: 1,

        stencilFunc: GL_ALWAYS,
        stencilRef: 0,
        stencilMask: 0xFFFFFFFF,
        stencilFail: 0x1E00, // GL_KEEP
        stencilZFail: 0x1E00,
        stencilZPass: 0x1E00,
        stencilWriteMask: 0xFFFFFFFF,

        rasterPosX: 0,
        rasterPosY: 0,
        rasterPosZ: 0,
        rasterPosW: 1,
        rasterPosValid: true,

        pixelZoomX: 1,
        pixelZoomY: 1,

        logicOp: 0x1503, // GL_COPY

        lineStippleFactor: 1,
        lineStipplePattern: 0xFFFF,

        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,

        texGenS: createTexGenState([1, 0, 0, 0]),
        texGenT: createTexGenState([0, 1, 0, 0]),
        texGenR: createTexGenState([0, 0, 0, 0]),
        texGenQ: createTexGenState([0, 0, 0, 0]),
    };

    return ctx;
}

export function resetOpenGLContext(ctx: OpenGLContext): void {
    ctx.error = 0;
    ctx.commands.reset();
    ctx.vertArena.reset();
    ctx.textures.clear();
    ctx.displayLists.clear();
    ctx.compilingList = null;
    ctx.compilingCommands = [];
    ctx.replayingList = false;
    ctx.nextTextureId = 1;
    ctx.nextListId = 1;
    ctx.frameSnapshot = { frameId: 0, drawCalls: 0, presents: 0, texUploads: 0, clearCalls: 0, vertexCount: 0 };
    ctx.frameId = 0;
    ctx.stringCache.clear();
}
