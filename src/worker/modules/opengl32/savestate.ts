import type { CaptureContext, FieldPolicy, RestoreContext } from "../../savestate/participant";
import { stateKeys } from "../../savestate/participant";
import { CaptureRefusal } from "../../savestate/object-codecs";
import type { SaveValue } from "../../savestate/value-codec";
import { System } from "../../core/system";
import { OpenGLBackendExecutor } from "../../backends/webgpu/opengl/opengl-backend-executor";
import {
    CMD_F32, CMD_I32, VERT_FLOATS, resetOpenGLContext,
    type GLArrayPointer, type GLDisplayList, type GLLightState, type GLMatrixStack, type GLPrebakedItem,
    type GLTexGenState, type GLTextureObject, type GLTextureUnit, type OpenGLContext,
} from "./context";
import type { GLCvaAttrib, GLCvaState } from "./client-arrays";
import { resetWglState, type WGLContextBinding, type WglContextEntry, type WglState } from "./wgl";
import { captureGluState, restoreGluState, type GluQuadric, type GluState } from "../glu32";

export const OPENGL_CONTEXT_FIELDS = {
    process: "host",
    backend: "host",
    executor: "host",
    presenter: "host",
    drawableDC: "save",
    error: "save",
    matrixMode: "save",
    modelviewStack: "save",
    projectionStack: "save",
    textureStack: "save",
    currentStack: "host",
    currentMatrix: "host",
    enableFlags: "save",
    viewportX: "save",
    viewportY: "save",
    viewportW: "save",
    viewportH: "save",
    viewportFromGuest: "save",
    scissorFromGuest: "save",
    depthRangeNear: "save",
    depthRangeFar: "save",
    clearR: "save",
    clearG: "save",
    clearB: "save",
    clearA: "save",
    clearDepth: "save",
    clearStencil: "save",
    depthFunc: "save",
    depthMask: "save",
    blendSrc: "save",
    blendDst: "save",
    alphaFunc: "save",
    alphaRef: "save",
    cullFace: "save",
    frontFace: "save",
    shadeModel: "save",
    polygonModeFront: "save",
    polygonModeBack: "save",
    fogMode: "save",
    fogDensity: "save",
    fogStart: "save",
    fogEnd: "save",
    fogColor: "save",
    lights: "save",
    materialFrontAmbient: "save",
    materialFrontDiffuse: "save",
    materialFrontSpecular: "save",
    materialFrontEmission: "save",
    materialFrontShininess: "save",
    lightModelAmbient: "save",
    colorMaterialFace: "save",
    colorMaterialParam: "save",
    scissorX: "save",
    scissorY: "save",
    scissorW: "save",
    scissorH: "save",
    unpackAlignment: "save",
    unpackRowLength: "save",
    unpackSkipPixels: "save",
    unpackSkipRows: "save",
    packAlignment: "save",
    packRowLength: "save",
    packSkipPixels: "save",
    packSkipRows: "save",
    colorMaskR: "save",
    colorMaskG: "save",
    colorMaskB: "save",
    colorMaskA: "save",
    activeTextureUnit: "save",
    clientActiveTextureUnit: "save",
    textureUnits: "save",
    textures: "save",
    nextTextureId: "save",
    clipPlanes: "save",
    renderMode: "save",
    nameStack: "save",
    nameStackTop: "save",
    selectBufferPtr: "save",
    selectBufferSize: "save",
    feedbackBufferPtr: "save",
    feedbackBufferSize: "save",
    feedbackBufferType: "save",
    proxyTextureWidth: "save",
    proxyTextureHeight: "save",
    proxyTextureInternalFormat: "save",
    immediateMode: "save",
    immediateFlatBuf: "save",
    immediateFlatCount: "save",
    immediatePrimMode: "save",
    currentColor: "save",
    currentNormal: "save",
    currentTexCoord: "save",
    vertexArray: "save",
    normalArray: "save",
    colorArray: "save",
    texCoordArrays: "save",
    cva: "save",
    displayLists: "save",
    nextListId: "save",
    listBase: "save",
    compilingList: "save",
    compilingListMode: "save",
    compilingCommands: "save",
    replayingList: "save",
    commands: "save",
    vertArena: "save",
    frameSnapshot: "save",
    frameId: "save",
    stringCache: "save",
    hints: "save",
    pointSize: "save",
    lineWidth: "save",
    stencilFunc: "save",
    stencilRef: "save",
    stencilMask: "save",
    stencilFail: "save",
    stencilZFail: "save",
    stencilZPass: "save",
    stencilWriteMask: "save",
    rasterPosX: "save",
    rasterPosY: "save",
    rasterPosZ: "save",
    rasterPosW: "save",
    rasterPosValid: "save",
    pixelZoomX: "save",
    pixelZoomY: "save",
    logicOp: "save",
    lineStippleFactor: "save",
    lineStipplePattern: "save",
    polygonOffsetFactor: "save",
    polygonOffsetUnits: "save",
    texGenS: "save",
    texGenT: "save",
    texGenR: "save",
    texGenQ: "save",
} as const satisfies Record<keyof OpenGLContext, FieldPolicy>;

export const GL_TEXTURE_FIELDS = {
    id: "save",
    width: "save",
    height: "save",
    internalFormat: "save",
    data: "save",
    wrapS: "save",
    wrapT: "save",
    minFilter: "save",
    magFilter: "save",
    dirty: "derive",
    gpuVersion: "save",
} as const satisfies Record<keyof GLTextureObject, FieldPolicy>;

export const GL_TEXTURE_UNIT_FIELDS = {
    enabled2d: "save",
    boundTexture: "save",
    texEnvMode: "save",
    envColor: "save",
    combineRgb: "save",
    combineAlpha: "save",
    srcRgb: "save",
    srcAlpha: "save",
    opRgb: "save",
    opAlpha: "save",
    rgbScale: "save",
    alphaScale: "save",
} as const satisfies Record<keyof GLTextureUnit, FieldPolicy>;

export const GL_DISPLAY_LIST_FIELDS = {
    commands: "save",
    prebaked: "save",
} as const satisfies Record<keyof GLDisplayList, FieldPolicy>;

export const GL_LIGHT_FIELDS = {
    ambient: "save",
    diffuse: "save",
    specular: "save",
    position: "save",
    spotDirection: "save",
    spotExponent: "save",
    spotCutoff: "save",
    constantAttenuation: "save",
    linearAttenuation: "save",
    quadraticAttenuation: "save",
} as const satisfies Record<keyof GLLightState, FieldPolicy>;

export const GL_MATRIX_STACK_FIELDS = {
    stack: "save",
    top: "save",
    maxDepth: "save",
} as const satisfies Record<keyof GLMatrixStack, FieldPolicy>;

export const GL_ARRAY_POINTER_FIELDS = {
    size: "save",
    type: "save",
    stride: "save",
    pointer: "save",
    enabled: "save",
} as const satisfies Record<keyof GLArrayPointer, FieldPolicy>;

export const GL_TEXGEN_FIELDS = {
    mode: "save",
    objectPlane: "save",
    eyePlane: "save",
} as const satisfies Record<keyof GLTexGenState, FieldPolicy>;

export const GL_CVA_FIELDS = {
    active: "save",
    first: "save",
    count: "save",
    attribs: "save",
    mvp: "derive",
    mvpValid: "derive",
} as const satisfies Record<keyof GLCvaState, FieldPolicy>;

export const GL_CVA_ATTRIB_FIELDS = {
    covered: "save",
    size: "save",
    type: "save",
    stride: "save",
    pointer: "save",
    data: "derive",
    first: "derive",
    end: "derive",
} as const satisfies Record<keyof GLCvaAttrib, FieldPolicy>;

export const WGL_STATE_FIELDS = {
    nextHglrc: "save",
    contexts: "save",
    threadBindings: "save",
    currentHglrc: "save",
    currentHdc: "save",
} as const satisfies Record<keyof WglState, FieldPolicy>;

export const WGL_CONTEXT_FIELDS = {
    hdc: "save",
    attached: "save",
} as const satisfies Record<keyof WglContextEntry, FieldPolicy>;

export const WGL_BINDING_FIELDS = {
    hglrc: "save",
    hdc: "save",
} as const satisfies Record<keyof WGLContextBinding, FieldPolicy>;

export interface OpenGLColorTarget {
    width: number;
    height: number;
    pixels: string;
}

export interface OpenGLSavedState {
    context: Record<string, SaveValue>;
    wgl: Record<string, SaveValue>;
    glu: GluState;
    presenterActive: boolean;
    color: OpenGLColorTarget | null;
}

export const OPENGL32_SCHEMA = {
    context: OPENGL_CONTEXT_FIELDS,
    texture: GL_TEXTURE_FIELDS,
    unit: GL_TEXTURE_UNIT_FIELDS,
    displayList: GL_DISPLAY_LIST_FIELDS,
    light: GL_LIGHT_FIELDS,
    matrixStack: GL_MATRIX_STACK_FIELDS,
    arrayPointer: GL_ARRAY_POINTER_FIELDS,
    texGen: GL_TEXGEN_FIELDS,
    cva: GL_CVA_FIELDS,
    cvaAttrib: GL_CVA_ATTRIB_FIELDS,
    wgl: WGL_STATE_FIELDS,
    wglContext: WGL_CONTEXT_FIELDS,
    wglBinding: WGL_BINDING_FIELDS,
    quadric: stateKeys<GluQuadric>({ normals: true, texture: true, orientation: true, drawStyle: true }),
    glu: stateKeys<GluState>({ nextQuadricId: true, quadrics: true }),
    color: stateKeys<OpenGLColorTarget>({ width: true, height: true, pixels: true }),
    state: stateKeys<OpenGLSavedState>({ context: true, wgl: true, glu: true, presenterActive: true, color: true }),
};

export interface OpenGLRestoreDebt {
    executorOwed: boolean;
    colorSeed: { rgba: Uint8Array; width: number; height: number } | null;
}

export function createRestoreDebt(): OpenGLRestoreDebt {
    return { executorOwed: false, colorSeed: null };
}

type Policy = Readonly<Record<string, FieldPolicy>>;
type Io = Pick<CaptureContext, "blob">;
type Encoder = (value: unknown, where: string, io: Io, owner: unknown) => SaveValue;

/** @transient(read back by prepare() and consumed by the capture that follows it; never survives one capture) */
let colorReadbackError: string | null = null;
/** @transient(read back by prepare() and consumed by the capture that follows it; never survives one capture) */
let colorReadback: { width: number; height: number; rgba: Uint8Array } | null = null;

/** @transient(copies handed to the blob store, so later in-place writes by the guest cannot change saved bytes; each copy is valid for one gpuVersion) */
const textureCopies = new WeakMap<GLTextureObject, { version: number; source: Uint8Array; bytes: Uint8Array }>();

/** @transient(copies handed to the blob store for baked list vertices, which are never written after baking) */
const prebakedCopies = new WeakMap<Float32Array, Uint8Array>();

type TypedCtor =
    | Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor
    | Int8ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor
    | Float32ArrayConstructor | Float64ArrayConstructor;

const TYPED_CTORS: readonly TypedCtor[] = [
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
];

function describe(value: unknown): string {
    if (typeof value === "function") return "a function";
    if (value && typeof value === "object") return (value as { constructor?: { name?: string } }).constructor?.name ?? "an object";
    return typeof value;
}

function typedCtorOf(value: object): TypedCtor | null {
    const proto = Object.getPrototypeOf(value);
    return TYPED_CTORS.find(c => c.prototype === proto) ?? null;
}

function encodePlain(value: unknown, where: string): SaveValue {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
    if (typeof value !== "object") throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} has no savestate encoding`);
    if (ArrayBuffer.isView(value)) {
        if (!typedCtorOf(value)) throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} has no savestate encoding`);
        return (value as Uint8Array).slice();
    }
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} has no savestate encoding`);
        return value.map((v, i) => encodePlain(v, `${where}[${i}]`));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} has no savestate encoding`);
    }
    const out: Record<string, SaveValue> = {};
    for (const key of Object.keys(value)) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        out[key] = encodePlain(v, `${where}.${key}`);
    }
    return out;
}

function decodePlain(saved: SaveValue): SaveValue {
    if (saved === null || typeof saved !== "object") return saved;
    if (ArrayBuffer.isView(saved)) return (saved as Uint8Array).slice();
    if (Array.isArray(saved)) return saved.map(decodePlain);
    const out: Record<string, SaveValue> = {};
    for (const key of Object.keys(saved)) out[key] = decodePlain((saved as Record<string, SaveValue>)[key]!);
    return out;
}

function encodeRecord(
    value: unknown, policy: Policy, where: string, io: Io, special: Readonly<Record<string, Encoder>> = {},
): Record<string, SaveValue> {
    if (value === null || typeof value !== "object") throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} is not a record`);
    const out: Record<string, SaveValue> = {};
    for (const key of Object.keys(policy)) {
        if (policy[key] !== "save") continue;
        const v = (value as Record<string, unknown>)[key];
        out[key] = special[key] ? special[key](v, `${where}.${key}`, io, value) : encodePlain(v, `${where}.${key}`);
    }
    return out;
}

const record = (policy: Policy, special?: Readonly<Record<string, Encoder>>): Encoder =>
    (value, where, io) => encodeRecord(value, policy, where, io, special);

const listOf = (inner: Encoder): Encoder => (value, where, io, owner) => {
    if (!Array.isArray(value)) throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} is not a list`);
    return value.map((v, i) => inner(v, `${where}[${i}]`, io, owner));
};

const mapOf = (inner: Encoder): Encoder => (value, where, io, owner) => {
    if (!(value instanceof Map)) throw new CaptureRefusal(`opengl32 ${where}: ${describe(value)} is not a map`);
    return [...value].map(([k, v]) => [encodePlain(k, `${where} key`), inner(v, `${where}[${String(k)}]`, io, owner)]);
};

function bytesOf(view: ArrayBufferView): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function ownedBytes(view: ArrayBufferView): Uint8Array {
    return bytesOf(view).slice();
}

const encodePixels: Encoder = (value, _where, io, owner) => {
    const data = value as Uint8Array | null;
    if (!data || data.length === 0) return null;
    const tex = owner as GLTextureObject;
    let copy = textureCopies.get(tex);
    if (!copy || copy.version !== tex.gpuVersion || copy.source !== data || copy.bytes.length !== data.length) {
        copy = { version: tex.gpuVersion, source: data, bytes: data.slice() };
        textureCopies.set(tex, copy);
    }
    return io.blob(copy.bytes);
};

const encodePrebaked: Encoder = (value, where, io) => {
    if (value === null) return null;
    const items = value as GLPrebakedItem[];
    return items.map((item, i) => {
        if (item.kind === "cmd") return encodePlain({ kind: item.kind, fn: item.fn, args: item.args }, `${where}[${i}]`);
        let copy = prebakedCopies.get(item.flatVerts);
        if (!copy) prebakedCopies.set(item.flatVerts, copy = ownedBytes(item.flatVerts));
        return { kind: item.kind, mode: item.mode, count: item.count, flatVerts: copy.length > 0 ? io.blob(copy) : null };
    });
};

const CONTEXT_ENCODERS: Readonly<Record<string, Encoder>> = {
    modelviewStack: record(GL_MATRIX_STACK_FIELDS),
    projectionStack: record(GL_MATRIX_STACK_FIELDS),
    textureStack: record(GL_MATRIX_STACK_FIELDS),
    lights: listOf(record(GL_LIGHT_FIELDS)),
    textureUnits: listOf(record(GL_TEXTURE_UNIT_FIELDS)),
    vertexArray: record(GL_ARRAY_POINTER_FIELDS),
    normalArray: record(GL_ARRAY_POINTER_FIELDS),
    colorArray: record(GL_ARRAY_POINTER_FIELDS),
    texCoordArrays: listOf(record(GL_ARRAY_POINTER_FIELDS)),
    texGenS: record(GL_TEXGEN_FIELDS),
    texGenT: record(GL_TEXGEN_FIELDS),
    texGenR: record(GL_TEXGEN_FIELDS),
    texGenQ: record(GL_TEXGEN_FIELDS),
    cva: record(GL_CVA_FIELDS, { attribs: listOf(record(GL_CVA_ATTRIB_FIELDS)) }),
    textures: mapOf(record(GL_TEXTURE_FIELDS, { data: encodePixels })),
    displayLists: mapOf(record(GL_DISPLAY_LIST_FIELDS, { prebaked: encodePrebaked })),
};

function encodeTop(value: unknown, where: string): SaveValue {
    if (value instanceof Map) return [...value].map(([k, v]) => [encodePlain(k, `${where} key`), encodePlain(v, `${where}[${String(k)}]`)]);
    if (value instanceof Set) {
        return [...value].map((v, i) => encodePlain(v, `${where}[${i}]`)).sort((a, b) => (a as number) - (b as number));
    }
    return encodePlain(value, where);
}

function encodeStream(ctx: OpenGLContext, io: Io): SaveValue {
    const count = ctx.commands.count;
    return {
        count,
        i32: count > 0 ? io.blob(ownedBytes(ctx.commands.i32.subarray(0, count * CMD_I32))) : null,
        f32: count > 0 ? io.blob(ownedBytes(ctx.commands.f32.subarray(0, count * CMD_F32))) : null,
    };
}

function encodeArena(ctx: OpenGLContext, io: Io): SaveValue {
    const used = ctx.vertArena.used;
    return { used, data: used > 0 ? io.blob(ownedBytes(ctx.vertArena.data.subarray(0, used))) : null };
}

function encodeImmediate(ctx: OpenGLContext, io: Io): SaveValue {
    if (!ctx.immediateMode && ctx.immediateFlatCount === 0) return null;
    const floats = ctx.immediateFlatCount * VERT_FLOATS;
    return floats > 0 ? io.blob(ownedBytes(ctx.immediateFlatBuf.subarray(0, floats))) : null;
}

export function captureOpenGL(ctx: OpenGLContext, wgl: WglState, io: Io): OpenGLSavedState {
    const context: Record<string, SaveValue> = {};
    for (const key of Object.keys(OPENGL_CONTEXT_FIELDS) as (keyof typeof OPENGL_CONTEXT_FIELDS)[]) {
        if (OPENGL_CONTEXT_FIELDS[key] !== "save") continue;
        const value = (ctx as unknown as Record<string, unknown>)[key];
        const where = `context.${key}`;
        if (key === "commands") context[key] = encodeStream(ctx, io);
        else if (key === "vertArena") context[key] = encodeArena(ctx, io);
        else if (key === "immediateFlatBuf") context[key] = encodeImmediate(ctx, io);
        else if (CONTEXT_ENCODERS[key]) context[key] = CONTEXT_ENCODERS[key]!(value, where, io, ctx);
        else context[key] = encodeTop(value, where);
    }

    const wglSaved: Record<string, SaveValue> = {};
    for (const key of Object.keys(WGL_STATE_FIELDS) as (keyof WglState)[]) {
        wglSaved[key] = key === "contexts" || key === "threadBindings"
            ? mapOf(record(key === "contexts" ? WGL_CONTEXT_FIELDS : WGL_BINDING_FIELDS))(wgl[key], `wgl.${key}`, io, wgl)
            : encodePlain(wgl[key], `wgl.${key}`);
    }

    const presenterActive = !!ctx.presenter && System.getInstance().services.render.getActive() === ctx.presenter;
    const failed = colorReadbackError;
    colorReadbackError = null;
    if (failed !== null) {
        colorReadback = null;
        throw new CaptureRefusal(`opengl32: the colour target could not be read back (${failed})`);
    }
    const readback = colorReadback;
    colorReadback = null;
    return {
        context,
        wgl: wglSaved,
        glu: captureGluState(),
        presenterActive,
        color: readback ? { width: readback.width, height: readback.height, pixels: io.blob(readback.rgba) } : null,
    };
}

function copyBytes(blob: RestoreContext["blob"], hash: string, expected: number, what: string): Uint8Array {
    const bytes = blob(hash).slice();
    if (bytes.byteLength !== expected) {
        throw new Error(`opengl32: saved ${what} holds ${bytes.byteLength} bytes, expected ${expected}`);
    }
    return bytes;
}

function decodePixels(saved: SaveValue, blob: RestoreContext["blob"]): Uint8Array | null {
    return typeof saved === "string" ? blob(saved).slice() : null;
}

function restoreMap(saved: SaveValue, value: (v: SaveValue) => unknown): Map<unknown, unknown> {
    const out = new Map<unknown, unknown>();
    for (const pair of saved as SaveValue[][]) out.set(pair[0], value(pair[1]!));
    return out;
}

function restoreTexture(saved: SaveValue, blob: RestoreContext["blob"]): GLTextureObject {
    const s = saved as Record<string, SaveValue>;
    return {
        id: s.id as number,
        width: s.width as number,
        height: s.height as number,
        internalFormat: s.internalFormat as number,
        data: decodePixels(s.data!, blob),
        wrapS: s.wrapS as number,
        wrapT: s.wrapT as number,
        minFilter: s.minFilter as number,
        magFilter: s.magFilter as number,
        dirty: true,
        gpuVersion: s.gpuVersion as number,
    };
}

function restoreDisplayList(saved: SaveValue, blob: RestoreContext["blob"]): GLDisplayList {
    const s = saved as Record<string, SaveValue>;
    const prebaked = s.prebaked === null ? null : (s.prebaked as Array<Record<string, SaveValue>>).map((item): GLPrebakedItem => {
        if (item.kind === "cmd") return { kind: "cmd", fn: item.fn as string, args: [...(item.args as number[])] };
        const count = item.count as number;
        const bytes = typeof item.flatVerts === "string" ? blob(item.flatVerts).slice() : new Uint8Array(0);
        return { kind: "verts", mode: item.mode as number, count, flatVerts: new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2) };
    });
    return { commands: decodePlain(s.commands!) as GLDisplayList["commands"], prebaked };
}

function restoreCva(saved: SaveValue): GLCvaState {
    const s = saved as Record<string, SaveValue>;
    return {
        active: s.active as boolean,
        first: s.first as number,
        count: s.count as number,
        attribs: (s.attribs as Array<Record<string, SaveValue>>).map((a): GLCvaAttrib => ({
            covered: a.covered as boolean,
            size: a.size as number,
            type: a.type as number,
            stride: a.stride as number,
            pointer: a.pointer as number,
            data: new Float32Array(0),
            first: 0,
            end: 0,
        })),
        mvp: new Float32Array(16),
        mvpValid: false,
    };
}

export function restoreOpenGL(
    ctx: OpenGLContext, wgl: WglState, state: OpenGLSavedState, blob: RestoreContext["blob"], debt: OpenGLRestoreDebt,
): void {
    resetOpenGLContext(ctx);
    resetWglState(wgl);
    const target = ctx as unknown as Record<string, unknown>;
    for (const key of Object.keys(OPENGL_CONTEXT_FIELDS) as (keyof typeof OPENGL_CONTEXT_FIELDS)[]) {
        if (OPENGL_CONTEXT_FIELDS[key] !== "save") continue;
        const saved = state.context[key];
        if (saved === undefined) throw new Error(`opengl32: the saved state has no ${key}`);
        switch (key) {
            case "textures": target[key] = restoreMap(saved, v => restoreTexture(v, blob)); break;
            case "displayLists": target[key] = restoreMap(saved, v => restoreDisplayList(v, blob)); break;
            case "cva": ctx.cva = restoreCva(saved); break;
            case "commands": {
                const s = saved as Record<string, SaveValue>;
                const count = s.count as number;
                if (count > 0) {
                    const i32 = copyBytes(blob, s.i32 as string, count * CMD_I32 * 4, "command stream");
                    const f32 = copyBytes(blob, s.f32 as string, count * CMD_F32 * 4, "command stream");
                    ctx.commands.restore(count, new Int32Array(i32.buffer), new Float32Array(f32.buffer));
                }
                break;
            }
            case "vertArena": {
                const s = saved as Record<string, SaveValue>;
                const used = s.used as number;
                if (used > 0) ctx.vertArena.restore(new Float32Array(copyBytes(blob, s.data as string, used * 4, "vertex arena").buffer));
                break;
            }
            case "immediateFlatBuf": {
                if (typeof saved !== "string") break;
                const bytes = blob(saved).slice();
                const floats = new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
                if (floats.length > ctx.immediateFlatBuf.length) ctx.immediateFlatBuf = new Float32Array(floats.length * 2);
                ctx.immediateFlatBuf.set(floats);
                break;
            }
            default: {
                const fresh = target[key];
                if (fresh instanceof Map) target[key] = restoreMap(saved, v => decodePlain(v));
                else if (fresh instanceof Set) target[key] = new Set(decodePlain(saved) as unknown[]);
                else target[key] = decodePlain(saved);
            }
        }
    }

    const w = wgl as unknown as Record<string, unknown>;
    for (const key of Object.keys(WGL_STATE_FIELDS) as (keyof WglState)[]) {
        const saved = state.wgl[key];
        if (saved === undefined) throw new Error(`opengl32: the saved state has no wgl.${key}`);
        w[key] = key === "contexts" || key === "threadBindings" ? restoreMap(saved, v => decodePlain(v)) : decodePlain(saved);
    }
    restoreGluState(state.glu);

    const render = System.getInstance().services.render;
    if (state.presenterActive && ctx.presenter) render.setActive(ctx.presenter);
    else if (ctx.presenter && render.getActive() === ctx.presenter) render.setActive(null);

    if (state.color) {
        const rgba = copyBytes(blob, state.color.pixels, state.color.width * state.color.height * 4, "colour target");
        debt.colorSeed = { rgba, width: state.color.width, height: state.color.height };
    } else {
        debt.colorSeed = null;
    }
    debt.executorOwed = wgl.currentHglrc !== 0 || state.presenterActive || debt.colorSeed !== null;
    settleRestoreDebt(ctx, debt);
}

export function settleRestoreDebt(ctx: OpenGLContext, debt: OpenGLRestoreDebt): void {
    if (debt.executorOwed && ctx.backend) {
        if (!ctx.executor) ctx.executor = new OpenGLBackendExecutor(ctx.backend);
        debt.executorOwed = false;
    }
    if (debt.colorSeed && ctx.executor) {
        ctx.executor.seedColor(debt.colorSeed.rgba, debt.colorSeed.width, debt.colorSeed.height);
        debt.colorSeed = null;
    }
}

export async function prepareOpenGL(ctx: OpenGLContext | null): Promise<void> {
    colorReadback = null;
    colorReadbackError = null;
    const executor = ctx?.executor as OpenGLBackendExecutor | null | undefined;
    if (!executor) return;
    try {
        const [width, height] = executor.getDrawableSize();
        if (width <= 0 || height <= 0) return;
        const rgba = await executor.readPixels(0, 0, width, height);
        if (rgba) colorReadback = { width, height, rgba };
    } catch (e) {
        colorReadbackError = e instanceof Error ? e.message : String(e);
    }
}
