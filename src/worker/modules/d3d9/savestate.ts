import { CaptureRefusal } from "../../savestate/object-codecs";
import type { FieldPolicy } from "../../savestate/participant";
import { savestateParticipants, stateKeys } from "../../savestate/participant";
import type { SaveValue } from "../../savestate/value-codec";
import { System } from "../../core/system";
import { Mem } from "../../core/memory/mem-accessor";
import { gammaService } from "../../core/gamma-service";
import { captureDeviceCursors, restoreDeviceCursors, type DeviceCursorState } from "../../core/device-cursor";
import { deviceCooperativeLevel } from "../../core/gpu/gpu-device-loss-contract";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { D3D9Device } from "../../backends/webgpu/d3d9/d3d9-device";
import { pixelShaderComObjects, vertexDeclComObjects, vertexShaderComObjects } from "../../backends/webgpu/d3d9/d3d9-com-objects";
import type { RawVertexElement } from "../../backends/webgpu/d3d9/shader";
import type { PresentationParameters9 } from "../../backends/webgpu/d3d9/presentation";
import type { D3D9StateBlockData, StateBlockEntry } from "../../backends/webgpu/d3d9/d3d9-state-block";
import {
    D3D9_DEVICE_FIELDS, D3D9_INDEX_BUFFER_FIELDS, D3D9_PALETTE_FIELDS, D3D9_PRESENTATION_FIELDS, D3D9_RECORDER_FIELDS,
    D3D9_STATE_BLOCK_FIELDS, D3D9_STREAM_FIELDS, D3D9_TEXTURE_STORE_FIELDS, D3D9_TRACKER_FIELDS, D3D9_VERTEX_BUFFER_FIELDS,
    adoptIndexBuffer, adoptTexture, adoptVertexBuffer, captureDeviceState, captureIndexBuffer, capturePresentation,
    captureTexture, captureVertexBuffer, describeDevice, isReadableRenderTargetFormat, materializedBlockEntries,
    readBackDevice, refuseIfLocked, restoreDeviceState, restorePresentation, restoreRecording,
    restoreTargets, restoreViewport, retireDevice, savedTokens, seedBackbuffer, tokensOf,
    type BlobSource, type Io, type SavedBuffer, type SavedDeviceState, type SavedTexture,
} from "../../backends/webgpu/d3d9/d3d9-savestate";
import { getD3DTextureLayout } from "../../backends/webgpu/shared/texture-formats";
import { isDxDepthStencilFormat } from "../../backends/webgpu/shared/dx-format-support";
import { Logger, LogCategory } from "../../core/logger";
import { d3dShaderTokenCount } from "../../backends/webgpu/d3d9/shader/bytecode-extent";
import {
    adoptComObject, captureVTables, deviceBackBufferInfo, deviceClipStatus, deviceCreationParams, deviceToD3D9, devices,
    dropD3D9RegistriesForRestore, resourceToDevice, restoreVTables, stateBlocks,
} from "./shared-state";
import { captureComRefs, liveComObjects, restoreComRefs, type ComRefsState } from "./com-refs";
import {
    captureDeviceBackBufferSurfaces, captureDeviceSlotRefs, cubeFaceSurfaces, deviceBoundDepthStencil, deviceBoundRenderTarget,
    indexBufferMeta, setDeviceBackBufferSurface, setDeviceRenderTarget, setDeviceSlotRef, surfaceMeta, textureLevelSurfaces,
    textureMeta, vertexBufferMeta, releaseSurfaceMetadata, dropDeviceBackBufferSurface,
    type BufferMeta, type SurfaceMeta, type TextureMeta,
} from "./resource-registry";
import { registerComFinalizer } from "./com-refs";
import {
    captureBaseTextureState, openResourceLocks, registerBufferFinalizer, registerStandaloneSurfaceFinalizer,
    registerTextureFinalizer, restoreBaseTextureState, clearResourceLockPromises,
} from "./resources";
import {
    captureVolumeBaseState, registerVolumeLevelFinalizer, registerVolumeTextureFinalizer, restoreVolumeBaseState, volumeLocksOpen,
} from "./volume";
import {
    volumeLevelObjects, volumeLevelParents, volumeTextureResources, type VolumeTextureResource,
} from "./volume-resources";
import {
    captureRecordingDevices, registerPixelShaderObject, registerStateBlockObject, registerVertexDeclObject,
    registerVertexShaderObject, restoreRecordingDevices,
} from "./state";
import { captureQueries, restoreQuery, type SavedQuery } from "./query";
import { captureSwapChains, restoreSwapChains, type SavedSwapChains } from "./swapchain";
import { captureExState, restoreExState, type SavedExState } from "./ex";
import { captureResourceContract, restoreResourceContract, type SavedContract } from "./resource-contract";
import { captureShaderValidators, restoreShaderValidators } from "./shader-validator";
import { captureOpenWindows, restoreOpenWindows } from "./state-block-shadow-window";
import { bindD3D9DevicePointer, forgetRtFastPaths, newD3D9Device, registerDeviceFinalizer, resetSetterShadows } from "./device";
import { d3d9SplitAudit, d3d9SplitFlush, d3d9SplitStats } from "./split";
import { resetSwapChainRegistry } from "./swapchain";

export interface SavedSurface {
    ptr: number;
    devicePtr: number;
    kind: "sub" | "depth" | "implicit";
    meta: SurfaceMeta;
}

export interface SavedTextureObject {
    ptr: number;
    devicePtr: number;
    meta: TextureMeta;
    store: SavedTexture;
    levelSurfaces: Array<[number, number]>;
    faceSurfaces: Array<[string, number]>;
}

export interface SavedBufferObject {
    ptr: number;
    devicePtr: number;
    meta: BufferMeta;
    store: SavedBuffer;
}

export interface SavedVolumeLevel {
    width: number;
    height: number;
    depth: number;
    pitch: number;
    slicePitch: number;
    bytes: number;
    ptr: number;
}

export interface SavedVolume {
    ptr: number;
    devicePtr: number;
    width: number;
    height: number;
    depth: number;
    levels: number;
    usage: number;
    pool: number;
    format: number;
    levelData: SavedVolumeLevel[];
    levelObjects: Array<[number, number]>;
}

export interface SavedShaderObject {
    ptr: number;
    devicePtr: number;
    bytecode: string;
}

export interface SavedDeclaration {
    ptr: number;
    devicePtr: number;
    elements: RawVertexElement[];
}

export interface SavedStateBlock {
    ptr: number;
    devicePtr: number;
    blockType: number;
    entries: StateBlockEntry[];
}

export interface SavedDevice {
    ptr: number;
    d3d9Ptr: number;
    creation: { adapter: number; deviceType: number; hFocusWindow: number; behaviorFlags: number } | null;
    backBufferInfo: { width: number; height: number; format: number; windowed: boolean } | null;
    clipStatus: { clipUnion: number; clipIntersection: number } | null;
    boundDepthStencil: number;
    boundRenderTargets: Array<[number, number]>;
    slotRefs: Array<[string, number]>;
    backBufferSurfaces: Array<[string, number]>;
    standaloneDepth: { ptr: number; width: number; height: number; format: number; multiSampleType: number } | null;
    state: SavedDeviceState;
    backbuffer: { width: number; height: number; pixels: string } | null;
}

export interface D3D9SavedState {
    vtables: Array<[string, number, number]> | null;
    refs: ComRefsState;
    factories: number[];
    devices: SavedDevice[];
    swapChains: SavedSwapChains;
    surfaces: SavedSurface[];
    textures: SavedTextureObject[];
    volumes: SavedVolume[];
    vertexBuffers: SavedBufferObject[];
    indexBuffers: SavedBufferObject[];
    vertexShaders: SavedShaderObject[];
    pixelShaders: SavedShaderObject[];
    declarations: SavedDeclaration[];
    stateBlocks: SavedStateBlock[];
    queries: SavedQuery[];
    contract: SavedContract;
    textureBase: Array<[number, number, number]>;
    volumeBase: Array<[number, number, number]>;
    recordingDevices: number[];
    openWindows: Array<[number, Record<string, number>]>;
    validators: Array<[number, number]>;
    ex: SavedExState;
    gamma: { red: Float32Array; green: Float32Array; blue: Float32Array; isIdentity: boolean } | null;
    cursors: { cursors: DeviceCursorState[]; activeDevice: number } | null;
    renderActive: number;
}

export interface DroppedGpuContent {
    ptr: number;
    devicePtr: number;
    kind: "depth-stencil" | "multisample";
}

const TEXTURE_META_FIELDS = {
    width: "save", height: "save", levels: "save", usage: "save", pool: "save", format: "save", isCube: "save",
} as const satisfies Record<keyof TextureMeta, FieldPolicy>;

const BUFFER_META_FIELDS = {
    size: "save", usage: "save", pool: "save", fvf: "save", format: "save", createdBy: "save", seq: "save",
} as const satisfies Record<keyof BufferMeta, FieldPolicy>;

const SURFACE_META_FIELDS = {
    format: "save", type: "save", usage: "save", pool: "save", multiSampleType: "save", multiSampleQuality: "save",
    width: "save", height: "save", texturePtr: "save", level: "save", face: "save", offscreenPlain: "save",
    implicitBackBuffer: "save", standalone: "save", lockable: "save",
} as const satisfies Record<keyof SurfaceMeta, FieldPolicy>;

const PRESENTATION_PARAMETER_FIELDS = {
    backBufferWidth: "save", backBufferHeight: "save", backBufferFormat: "save", backBufferCount: "save",
    multiSampleType: "save", multiSampleQuality: "save", swapEffect: "save", deviceWindow: "save", windowed: "save",
    enableAutoDepthStencil: "save", autoDepthStencilFormat: "save", flags: "save", fullScreenRefreshRate: "save",
    presentationInterval: "save",
} as const satisfies Record<keyof PresentationParameters9, FieldPolicy>;

export const D3D9_RECORD_POLICIES = {
    textureMeta: TEXTURE_META_FIELDS,
    bufferMeta: BUFFER_META_FIELDS,
    surfaceMeta: SURFACE_META_FIELDS,
    presentationParameters: PRESENTATION_PARAMETER_FIELDS,
};

export const D3D9_SCHEMA = {
    device: D3D9_DEVICE_FIELDS,
    tracker: D3D9_TRACKER_FIELDS,
    streams: D3D9_STREAM_FIELDS,
    vertexBufferStore: D3D9_VERTEX_BUFFER_FIELDS,
    indexBufferStore: D3D9_INDEX_BUFFER_FIELDS,
    textureStore: D3D9_TEXTURE_STORE_FIELDS,
    palettes: D3D9_PALETTE_FIELDS,
    presentation: D3D9_PRESENTATION_FIELDS,
    recorder: D3D9_RECORDER_FIELDS,
    stateBlock: D3D9_STATE_BLOCK_FIELDS,
    textureMeta: TEXTURE_META_FIELDS,
    bufferMeta: BUFFER_META_FIELDS,
    surfaceMeta: SURFACE_META_FIELDS,
    presentationParameters: PRESENTATION_PARAMETER_FIELDS,
    state: stateKeys<D3D9SavedState>({
        vtables: true, refs: true, factories: true, devices: true, swapChains: true, surfaces: true, textures: true,
        volumes: true, vertexBuffers: true, indexBuffers: true, vertexShaders: true, pixelShaders: true,
        declarations: true, stateBlocks: true, queries: true, contract: true, textureBase: true, volumeBase: true,
        recordingDevices: true, openWindows: true, validators: true, ex: true, gamma: true, cursors: true,
        renderActive: true,
    }),
    saved: {
        device: stateKeys<SavedDevice>({
            ptr: true, d3d9Ptr: true, creation: true, backBufferInfo: true, clipStatus: true, boundDepthStencil: true,
            boundRenderTargets: true, slotRefs: true, backBufferSurfaces: true, standaloneDepth: true, state: true,
            backbuffer: true,
        }),
        deviceState: stateKeys<SavedDeviceState>({
            isExtended: true, softwareVertexProcessing: true, npatchMode: true, dialogBoxMode: true, windowHwnd: true,
            windowed: true, presentInterval: true, swapEffect: true, msaaSampleCount: true, guestBackbuffer: true,
            viewport: true, scissor: true, renderStates: true, textureStageStates: true, samplerStates: true,
            transforms: true, fvf: true, vertexShader: true, pixelShader: true, declaration: true, streams: true,
            indices: true, boundTextures: true, renderTargets: true, depthTexture: true, standaloneDepth: true,
            vsFloat: true, vsFloatExtended: true, vsInt: true, vsIntExtended: true, vsBool: true, vsBoolMask: true,
            psFloat: true, psInt: true, psBoolMask: true, material: true, lights: true, lightEnables: true,
            clipPlanes: true, palettes: true, currentPalette: true, recording: true, volumes: true,
        }),
        surface: stateKeys<SavedSurface>({ ptr: true, devicePtr: true, kind: true, meta: true }),
        texture: stateKeys<SavedTextureObject>({
            ptr: true, devicePtr: true, meta: true, store: true, levelSurfaces: true, faceSurfaces: true,
        }),
        textureStore: stateKeys<SavedTexture>({
            guestPtr: true, width: true, height: true, levels: true, format: true, pool: true, cube: true,
            renderTarget: true, borrowedPtr: true, borrowedBytes: true, data: true, guestStale: true, mips: true,
            faces: true,
        }),
        buffer: stateKeys<SavedBufferObject>({ ptr: true, devicePtr: true, meta: true, store: true }),
        bufferStore: stateKeys<SavedBuffer>({ size: true, pool: true, kind: true, guestPtr: true, data: true }),
        volume: stateKeys<SavedVolume>({
            ptr: true, devicePtr: true, width: true, height: true, depth: true, levels: true, usage: true, pool: true,
            format: true, levelData: true, levelObjects: true,
        }),
        volumeLevel: stateKeys<SavedVolumeLevel>({
            width: true, height: true, depth: true, pitch: true, slicePitch: true, bytes: true, ptr: true,
        }),
        shader: stateKeys<SavedShaderObject>({ ptr: true, devicePtr: true, bytecode: true }),
        declaration: stateKeys<SavedDeclaration>({ ptr: true, devicePtr: true, elements: true }),
        stateBlock: stateKeys<SavedStateBlock>({ ptr: true, devicePtr: true, blockType: true, entries: true }),
        query: stateKeys<SavedQuery>({
            ptr: true, devicePtr: true, type: true, issued: true, occlusionBeginDraws: true, occlusionEndDraws: true,
            disjointBeginTime: true, disjointEndTime: true,
        }),
        swapChains: stateKeys<SavedSwapChains>({ chains: true, presentation: true }),
        ex: stateKeys<SavedExState>({ maxFrameLatencies: true, objects: true, devices: true }),
        contract: stateKeys<SavedContract>({ privateData: true, priorities: true, opaqueUnknownRefs: true }),
        refs: stateKeys<ComRefsState>({ counts: true, bindings: true, parents: true, detached: true }),
    },
};

/** @transient(read back by prepare() and consumed by the capture that follows it; never survives one capture) */
let readbackResult: {
    problems: Array<{ devicePtr: number; what: string; why: string }>;
    backbuffers: Map<number, { rgba: Uint8Array; width: number; height: number }>;
} | null = null;

const deviceEntries = (): Array<[number, D3D9Device]> =>
    [...devices.entries()].sort((a, b) => a[0] - b[0]);

function vtableNames(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [name, address] of captureVTables() ?? []) out.set(address >>> 0, name);
    return out;
}

function name32(ptr: number): string {
    return `0x${(ptr >>> 0).toString(16)}`;
}

export async function prepareD3D9(): Promise<void> {
    readbackResult = null;
    d3d9SplitFlush();
    const result = { problems: [] as Array<{ devicePtr: number; what: string; why: string }>, backbuffers: new Map<number, { rgba: Uint8Array; width: number; height: number }>() };
    for (const [devicePtr, device] of deviceEntries()) {
        try {
            const read = await readBackDevice(device);
            for (const p of read.problems) result.problems.push({ devicePtr, ...p });
            if (read.backbuffer) result.backbuffers.set(devicePtr, read.backbuffer);
        } catch (e) {
            result.problems.push({ devicePtr, what: "the GPU contents", why: e instanceof Error ? e.message : String(e) });
        }
    }
    readbackResult = result;
}

export function captureD3D9(io: Io): D3D9SavedState {
    const read = readbackResult;
    readbackResult = null;
    if (read && read.problems.length > 0) {
        const p = read.problems[0]!;
        throw new CaptureRefusal(`d3d9: ${p.what} of ${describeDevice(p.devicePtr)} could not be read back (${p.why})`);
    }

    const deviceOf = new Map<D3D9Device, number>();
    for (const [ptr, device] of devices.entries()) deviceOf.set(device, ptr);
    const claimed = new Set<number>();
    const claim = (ptr: number): number => {
        claimed.add(ptr >>> 0);
        return ptr >>> 0;
    };
    const ownerOf = (ptr: number, what: string): number => {
        const device = resourceToDevice.get(ptr);
        const owner = device ? deviceOf.get(device) : undefined;
        if (owner === undefined) throw new CaptureRefusal(`d3d9: ${what} ${name32(ptr)} belongs to a device that is not registered`);
        return owner;
    };

    if (openResourceLocks() > 0) throw new CaptureRefusal("d3d9: a texture or buffer lock is still open");
    if (volumeLocksOpen() > 0) throw new CaptureRefusal("d3d9: a volume texture lock is still open");

    const savedDevices: SavedDevice[] = [];
    const swapChains = captureSwapChains(capturePresentation);
    const chainSurfaces = new Set<number>();
    for (const chain of swapChains.chains) {
        claim(chain.ptr);
        for (const back of chain.backBuffers) chainSurfaces.add(claim(back.ptr));
    }

    for (const [devicePtr, device] of deviceEntries()) {
        if (deviceCooperativeLevel(devicePtr) !== "ok") {
            throw new CaptureRefusal(`d3d9: ${describeDevice(devicePtr)} is lost or waiting for a Reset`);
        }
        refuseIfLocked(device, devicePtr);
        claim(devicePtr);
        const state = captureDeviceState(device, io);
        const depth = state.standaloneDepth !== 0 ? surfaceMeta.get(state.standaloneDepth) : undefined;
        const back = read?.backbuffers.get(devicePtr) ?? null;
        const parent = deviceToD3D9.get(devicePtr) ?? 0;
        savedDevices.push({
            ptr: devicePtr,
            d3d9Ptr: parent,
            creation: deviceCreationParams.get(devicePtr) ? { ...deviceCreationParams.get(devicePtr)! } : null,
            backBufferInfo: deviceBackBufferInfo.get(devicePtr) ? { ...deviceBackBufferInfo.get(devicePtr)! } : null,
            clipStatus: deviceClipStatus.get(devicePtr) ? { ...deviceClipStatus.get(devicePtr)! } : null,
            boundDepthStencil: deviceBoundDepthStencil.get(devicePtr) ?? 0,
            boundRenderTargets: [...(deviceBoundRenderTarget.get(devicePtr) ?? [])].sort((a, b) => a[0] - b[0]),
            slotRefs: captureDeviceSlotRefs(devicePtr),
            backBufferSurfaces: captureDeviceBackBufferSurfaces(devicePtr),
            standaloneDepth: depth
                ? { ptr: state.standaloneDepth, width: depth.width, height: depth.height, format: depth.format, multiSampleType: depth.multiSampleType }
                : null,
            state,
            backbuffer: back ? { width: back.width, height: back.height, pixels: io.blob(back.rgba.slice()) } : null,
        });
    }

    const factories = new Set<number>();
    for (const device of savedDevices) if (device.d3d9Ptr !== 0) factories.add(device.d3d9Ptr);
    const names = vtableNames();
    for (const ptr of liveComObjects()) {
        const vtable = names.get((Mem.readUint32(ptr) ?? 0) >>> 0);
        if (vtable === "IDirect3D9" || vtable === "IDirect3D9Ex") factories.add(ptr);
    }
    for (const ptr of factories) claim(ptr);

    const surfaces: SavedSurface[] = [];
    for (const [ptr, meta] of [...surfaceMeta].sort((a, b) => a[0] - b[0])) {
        if (chainSurfaces.has(ptr)) continue;
        let kind: SavedSurface["kind"];
        if (meta.texturePtr !== undefined) kind = "sub";
        else if (meta.standalone === true && (meta.usage & 0x2) !== 0) kind = "depth";
        else if (meta.implicitBackBuffer === true) kind = "implicit";
        else throw new CaptureRefusal(`d3d9: surface ${name32(ptr)} has no owner a restore could rebuild it from`);
        surfaces.push({ ptr: claim(ptr), devicePtr: ownerOf(ptr, "surface"), kind, meta: { ...meta } });
    }

    const textures: SavedTextureObject[] = [];
    for (const [ptr, meta] of [...textureMeta].sort((a, b) => a[0] - b[0])) {
        const devicePtr = ownerOf(ptr, "texture");
        const device = devices.get(devicePtr)!;
        const store = captureTexture(device, ptr, io);
        if (!store) throw new CaptureRefusal(`d3d9: texture ${name32(ptr)} has no device storage`);
        if (store.renderTarget && !store.cube && !isReadableRenderTargetFormat(store.format)) {
            throw new CaptureRefusal(`d3d9: render target texture ${name32(ptr)} has format ${store.format}, which has no readback conversion`);
        }
        if (store.renderTarget && store.cube) {
            throw new CaptureRefusal(`d3d9: render target cube texture ${name32(ptr)} has six faces and no readback path`);
        }
        textures.push({
            ptr: claim(ptr), devicePtr, meta: { ...meta }, store,
            levelSurfaces: [...(textureLevelSurfaces.get(ptr) ?? [])].sort((a, b) => a[0] - b[0]),
            faceSurfaces: [...(cubeFaceSurfaces.get(ptr) ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        });
    }

    const bufferObjects = (
        metas: Map<number, BufferMeta>, what: string,
        capture: (device: D3D9Device, ptr: number, io: Io) => SavedBuffer | null,
    ): SavedBufferObject[] => [...metas].sort((a, b) => a[0] - b[0]).map(([ptr, meta]) => {
        const devicePtr = ownerOf(ptr, what);
        const store = capture(devices.get(devicePtr)!, ptr, io);
        if (!store) throw new CaptureRefusal(`d3d9: ${what} ${name32(ptr)} has no device storage`);
        return { ptr: claim(ptr), devicePtr, meta: { ...meta }, store };
    });
    const vertexBuffers = bufferObjects(vertexBufferMeta, "vertex buffer", captureVertexBuffer);
    const indexBuffers = bufferObjects(indexBufferMeta, "index buffer", captureIndexBuffer);

    const volumes: SavedVolume[] = [];
    for (const [ptr, resource] of [...volumeTextureResources].sort((a, b) => a[0] - b[0])) {
        for (const level of resource.levelData) {
            if (level.locked !== null) throw new CaptureRefusal(`d3d9: volume texture ${name32(ptr)} has a mip level locked`);
        }
        volumes.push({
            ptr: claim(ptr), devicePtr: ownerOf(ptr, "volume texture"),
            width: resource.width, height: resource.height, depth: resource.depth, levels: resource.levels,
            usage: resource.usage, pool: resource.pool, format: resource.format,
            levelData: resource.levelData.map(l => ({
                width: l.width, height: l.height, depth: l.depth, pitch: l.pitch, slicePitch: l.slicePitch, bytes: l.bytes, ptr: l.ptr,
            })),
            levelObjects: [...(volumeLevelObjects.get(ptr) ?? [])].sort((a, b) => a[0] - b[0]),
        });
        for (const child of volumeLevelObjects.get(ptr)?.values() ?? []) claim(child);
    }
    for (const ptr of volumeLevelParents.keys()) {
        if (!claimed.has(ptr)) throw new CaptureRefusal(`d3d9: volume level object ${name32(ptr)} has no texture`);
    }

    const shaderObjects = (map: Map<number, { devicePtr: number; internalHandle: number; bytecode: Uint32Array }>): SavedShaderObject[] =>
        [...map].sort((a, b) => a[1].internalHandle - b[1].internalHandle).map(([ptr, m]) => ({
            ptr: claim(ptr), devicePtr: m.devicePtr, bytecode: savedTokens(m.bytecode, io),
        }));
    const vertexShaders = shaderObjects(vertexShaderComObjects);
    const pixelShaders = shaderObjects(pixelShaderComObjects);
    const declarations = [...vertexDeclComObjects].sort((a, b) => a[1].internalHandle - b[1].internalHandle).map(([ptr, m]): SavedDeclaration => ({
        ptr: claim(ptr), devicePtr: m.devicePtr, elements: m.elements.map(e => ({ ...e })),
    }));

    const savedBlocks = [...stateBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([ptr, data]): SavedStateBlock => ({
        ptr: claim(ptr), devicePtr: data.devicePtr, blockType: data.blockType, entries: materializedBlockEntries(data),
    }));

    const queries = captureQueries();
    for (const q of queries) claim(q.ptr);
    const validators = captureShaderValidators();
    for (const [ptr] of validators) claim(ptr);

    const refs = captureComRefs();
    for (const [ptr] of refs.counts) {
        if (!claimed.has(ptr)) {
            const vtable = names.get((Mem.readUint32(ptr) ?? 0) >>> 0);
            throw new CaptureRefusal(`d3d9: COM object ${name32(ptr)} (${vtable ?? "a vtable d3d9 did not publish"}) is not owned by d3d9`);
        }
    }

    const active = System.getInstance().services.render.getActive();
    let renderActive = 0;
    for (const [ptr, device] of devices.entries()) if ((device as unknown) === active) renderActive = ptr;
    const unrestorable = droppedContents(savedDevices, surfaces, textures, swapChains);
    if (unrestorable.length > 0) throw new CaptureRefusal(`d3d9: ${describeUnrestorable(unrestorable)}`);
    const hasDevices = savedDevices.length > 0;
    const cursors = hasDevices ? captureDeviceCursors() : null;
    if (cursors) cursors.cursors = cursors.cursors.filter(c => devices.has(c.devicePtr));

    return {
        vtables: captureVTables(),
        refs,
        factories: [...factories].sort((a, b) => a - b),
        devices: savedDevices,
        swapChains,
        surfaces,
        textures,
        volumes,
        vertexBuffers,
        indexBuffers,
        vertexShaders,
        pixelShaders,
        declarations,
        stateBlocks: savedBlocks,
        queries,
        contract: captureResourceContract(),
        textureBase: captureBaseTextureState().sort((a, b) => a[0] - b[0]),
        volumeBase: captureVolumeBaseState().sort((a, b) => a[0] - b[0]),
        recordingDevices: captureRecordingDevices(),
        openWindows: captureOpenWindows(),
        validators,
        ex: captureExState(),
        gamma: hasDevices ? gammaService.captureRamp() : null,
        cursors,
        renderActive,
    };
}

const MULTISAMPLE_NONE = 0;

function droppedContents(
    savedDevices: SavedDevice[], surfaces: SavedSurface[], textures: SavedTextureObject[], swapChains: SavedSwapChains,
): DroppedGpuContent[] {
    const out: DroppedGpuContent[] = [];
    for (const chain of swapChains.chains) {
        if (chain.params.enableAutoDepthStencil) out.push({ ptr: chain.ptr, devicePtr: chain.devicePtr, kind: "depth-stencil" });
        if ((chain.params.multiSampleType >>> 0) !== MULTISAMPLE_NONE) out.push({ ptr: chain.ptr, devicePtr: chain.devicePtr, kind: "multisample" });
    }
    for (const s of surfaces) {
        if (s.kind === "depth") out.push({ ptr: s.ptr, devicePtr: s.devicePtr, kind: "depth-stencil" });
        else if ((s.meta.multiSampleType >>> 0) !== MULTISAMPLE_NONE) out.push({ ptr: s.ptr, devicePtr: s.devicePtr, kind: "multisample" });
    }
    for (const t of textures) {
        if (isDxDepthStencilFormat(t.store.format, 9)) out.push({ ptr: t.ptr, devicePtr: t.devicePtr, kind: "depth-stencil" });
    }
    for (const d of savedDevices) {
        d.state.renderTargets.forEach(rt => {
            if (rt && (rt.sampleType >>> 0) !== MULTISAMPLE_NONE && !out.some(o => o.ptr === rt.ptr && o.kind === "multisample")) {
                out.push({ ptr: rt.ptr, devicePtr: d.ptr, kind: "multisample" });
            }
        });
    }
    out.sort((a, b) => a.devicePtr - b.devicePtr || a.ptr - b.ptr || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out;
}

export function describeUnrestorable(list: DroppedGpuContent[]): string {
    const depth = list.filter(d => d.kind === "depth-stencil").map(d => name32(d.ptr));
    const msaa = list.filter(d => d.kind === "multisample").map(d => name32(d.ptr));
    const parts: string[] = [];
    if (depth.length > 0) parts.push(`the contents of depth-stencil surface(s) ${depth.join(", ")} cannot be restored`);
    if (msaa.length > 0) parts.push(`the per-sample contents of multisampled target(s) ${msaa.join(", ")} cannot be restored`);
    return parts.join("; ");
}

export function eachSavedBlob(state: D3D9SavedState, visit: (hash: string, bytes: number | null, what: string) => void): void {
    const hex = (n: number) => name32(n);
    for (const t of state.textures) {
        const who = `texture ${hex(t.ptr)}`;
        const s = t.store;
        if (s.data !== null) visit(s.data, getD3DTextureLayout(s.format, s.width, s.cube ? s.width : s.height).bytes, who);
        for (const [level, hash] of s.mips) {
            const w = Math.max(1, s.width >>> level);
            const h = Math.max(1, s.height >>> level);
            visit(hash, getD3DTextureLayout(s.format, w, h).bytes, `${who} mip ${level}`);
        }
        for (const [key, hash] of s.faces) {
            const level = Number(key.split(":")[1]);
            const edge = Math.max(1, s.width >>> level);
            visit(hash, getD3DTextureLayout(s.format, edge, edge).bytes, `${who} face ${key}`);
        }
    }
    for (const b of [...state.vertexBuffers, ...state.indexBuffers]) {
        if (b.store.data !== null) visit(b.store.data, b.store.size, `buffer ${hex(b.ptr)}`);
    }
    for (const s of [...state.vertexShaders, ...state.pixelShaders]) visit(s.bytecode, null, `shader ${hex(s.ptr)}`);
    for (const d of state.devices) {
        if (d.state.vsFloatExtended !== null) visit(d.state.vsFloatExtended, null, `${describeDevice(d.ptr)} software vertex constants`);
        if (d.state.vsIntExtended !== null) visit(d.state.vsIntExtended, null, `${describeDevice(d.ptr)} software vertex integer constants`);
        if (d.backbuffer) visit(d.backbuffer.pixels, d.backbuffer.width * d.backbuffer.height * 4, `${describeDevice(d.ptr)} back buffer`);
    }
}

export function verifyD3D9(state: D3D9SavedState, blob: BlobSource): void {
    eachSavedBlob(state, (hash, bytes, what) => {
        let data: Uint8Array;
        try {
            data = blob(hash);
        } catch (e) {
            throw new Error(`d3d9: the saved ${what} is missing (${e instanceof Error ? e.message : String(e)})`, { cause: e });
        }
        if (bytes !== null && data.byteLength !== bytes) {
            throw new Error(`d3d9: the saved ${what} holds ${data.byteLength} bytes, expected ${bytes}`);
        }
    });
    for (const sh of [...state.vertexShaders, ...state.pixelShaders]) {
        const tokens = tokensOf(sh.bytecode, blob);
        if (d3dShaderTokenCount((i) => tokens[i]!, tokens.length) !== tokens.length) {
            throw new Error(`d3d9: the saved bytecode of shader ${name32(sh.ptr)} does not end where it says`);
        }
    }
    const known = new Set<number>(state.refs.counts.map(([ptr]) => ptr));
    for (const t of state.textures) if (!known.has(t.ptr)) throw new Error(`d3d9: texture ${name32(t.ptr)} has no saved reference count`);
    for (const d of state.devices) if (!known.has(d.ptr)) throw new Error(`d3d9: device ${name32(d.ptr)} has no saved reference count`);
}

async function backendForRestore(): Promise<WebGPUBackend> {
    const system = System.getInstance();
    const render = system.services.render;
    let backend = render.getBackend() as WebGPUBackend | null;
    if (!backend || backend.kind !== "webgpu") {
        const process = system.process;
        if (!process || !process.canvas) throw new Error("d3d9: restoring a device needs a canvas to create the GPU backend on");
        backend = new WebGPUBackend();
        await backend.initialize(process.canvas);
        render.setBackend(backend);
    }
    return backend;
}

function deviceFor(ptr: number, what: string): D3D9Device {
    const device = devices.get(ptr);
    if (!device) throw new Error(`d3d9: ${what} names device ${name32(ptr)}, which was not restored`);
    return device;
}

function volumeResourceOf(saved: SavedVolume): VolumeTextureResource {
    const process = System.getInstance().process;
    if (!process) throw new Error("d3d9: restoring a volume texture needs the process");
    return {
        width: saved.width, height: saved.height, depth: saved.depth, levels: saved.levels, usage: saved.usage,
        pool: saved.pool, format: saved.format,
        levelData: saved.levelData.map(l => ({ ...l, locked: null })),
        allocator: {
            alloc: (size: number): number => process.memory.alloc(size, "HEAP"),
            free: (ptr: number): void => process.memory.free(ptr),
        },
    };
}

export async function restoreD3D9(state: D3D9SavedState, blob: BlobSource): Promise<void> {
    verifyD3D9(state, blob);

    d3d9SplitFlush();
    for (const old of dropD3D9RegistriesForRestore()) retireDevice(old);
    resetSwapChainRegistry();
    forgetRtFastPaths();
    clearResourceLockPromises();
    restoreRecordingDevices([]);
    restoreBaseTextureState([]);
    restoreVolumeBaseState([]);
    restoreOpenWindows([]);
    restoreExState({ maxFrameLatencies: [], objects: [], devices: [] });
    restoreVTables(state.vtables);

    const backend = state.devices.length > 0 ? await backendForRestore() : null;
    const system = System.getInstance();
    const render = system.services.render;
    const splitBefore = splitEncodeErrors();

    for (const d of state.devices) {
        const device = await newD3D9Device(backend!, d.state.isExtended, system.process?.dispatcher);
        adoptComObject(d.ptr);
        devices.set(d.ptr, device);
        bindD3D9DevicePointer(device, d.ptr);
        if (d.d3d9Ptr !== 0) deviceToD3D9.set(d.ptr, d.d3d9Ptr);
        if (d.creation) deviceCreationParams.set(d.ptr, { ...d.creation });
        if (d.backBufferInfo) deviceBackBufferInfo.set(d.ptr, { ...d.backBufferInfo });
        if (d.clipStatus) deviceClipStatus.set(d.ptr, { ...d.clipStatus });
    }
    for (const ptr of state.factories) adoptComObject(ptr);
    for (const d of state.devices) {
        const implicit = state.swapChains.chains.find(c => c.devicePtr === d.ptr && c.index === 0)?.ptr ?? 0;
        registerDeviceFinalizer(d.ptr, devices.get(d.ptr)!, d.d3d9Ptr, implicit);
    }
    restoreSwapChains(state.swapChains, restorePresentation);

    for (const s of state.surfaces) {
        const device = deviceFor(s.devicePtr, `surface ${name32(s.ptr)}`);
        adoptComObject(s.ptr);
        resourceToDevice.set(s.ptr, device);
        surfaceMeta.set(s.ptr, { ...s.meta });
        if (s.kind === "depth") registerStandaloneSurfaceFinalizer(s.ptr, s.devicePtr);
        else if (s.kind === "implicit") {
            registerComFinalizer(s.ptr, () => {
                dropDeviceBackBufferSurface(s.devicePtr, s.ptr);
                releaseSurfaceMetadata(s.ptr);
            });
        }
    }

    for (const s of state.vertexShaders) {
        const device = deviceFor(s.devicePtr, `vertex shader ${name32(s.ptr)}`);
        const made = device.createVertexShaderFromTokens(tokensOf(s.bytecode, blob));
        if (made.hr !== 0) {
            throw new Error(`d3d9: vertex shader ${name32(s.ptr)} could not be translated again (0x${(made.hr >>> 0).toString(16)})`);
        }
        adoptComObject(s.ptr);
        registerVertexShaderObject(s.ptr, s.devicePtr, device, made.handle, made.bytecode);
    }
    for (const s of state.pixelShaders) {
        const device = deviceFor(s.devicePtr, `pixel shader ${name32(s.ptr)}`);
        const made = device.createPixelShaderFromTokens(tokensOf(s.bytecode, blob));
        if (made.hr !== 0) {
            throw new Error(`d3d9: pixel shader ${name32(s.ptr)} could not be translated again (0x${(made.hr >>> 0).toString(16)})`);
        }
        adoptComObject(s.ptr);
        registerPixelShaderObject(s.ptr, s.devicePtr, device, made.handle, made.bytecode);
    }
    for (const decl of state.declarations) {
        const device = deviceFor(decl.devicePtr, `vertex declaration ${name32(decl.ptr)}`);
        const made = device.createVertexDeclaration(decl.elements.map(e => ({ ...e })));
        if (made.hr !== 0) {
            throw new Error(`d3d9: vertex declaration ${name32(decl.ptr)} could not be recreated (0x${(made.hr >>> 0).toString(16)})`);
        }
        adoptComObject(decl.ptr);
        registerVertexDeclObject(decl.ptr, decl.devicePtr, device, made.handle, decl.elements.map(e => ({ ...e })));
    }

    for (const b of state.vertexBuffers) {
        const device = deviceFor(b.devicePtr, `vertex buffer ${name32(b.ptr)}`);
        adoptComObject(b.ptr);
        adoptVertexBuffer(device, b.ptr, b.store, blob);
        resourceToDevice.set(b.ptr, device);
        vertexBufferMeta.set(b.ptr, { ...b.meta });
        registerBufferFinalizer(b.ptr, b.devicePtr, "vertex");
    }
    for (const b of state.indexBuffers) {
        const device = deviceFor(b.devicePtr, `index buffer ${name32(b.ptr)}`);
        adoptComObject(b.ptr);
        adoptIndexBuffer(device, b.ptr, b.store, blob);
        resourceToDevice.set(b.ptr, device);
        indexBufferMeta.set(b.ptr, { ...b.meta });
        registerBufferFinalizer(b.ptr, b.devicePtr, "index");
    }
    for (const t of state.textures) {
        const device = deviceFor(t.devicePtr, `texture ${name32(t.ptr)}`);
        adoptComObject(t.ptr);
        adoptTexture(device, t.ptr, t.meta.usage, t.store, blob);
        resourceToDevice.set(t.ptr, device);
        textureMeta.set(t.ptr, { ...t.meta });
        registerTextureFinalizer(t.ptr, t.devicePtr);
        if (t.levelSurfaces.length > 0) textureLevelSurfaces.set(t.ptr, new Map(t.levelSurfaces));
        if (t.faceSurfaces.length > 0) cubeFaceSurfaces.set(t.ptr, new Map(t.faceSurfaces));
    }
    for (const v of state.volumes) {
        const device = deviceFor(v.devicePtr, `volume texture ${name32(v.ptr)}`);
        adoptComObject(v.ptr);
        volumeTextureResources.set(v.ptr, volumeResourceOf(v));
        resourceToDevice.set(v.ptr, device);
        device.registerVolumeTexture(v.ptr);
        registerVolumeTextureFinalizer(v.ptr, v.devicePtr, device);
        if (v.levelObjects.length > 0) volumeLevelObjects.set(v.ptr, new Map(v.levelObjects));
        for (const [level, child] of v.levelObjects) {
            adoptComObject(child);
            volumeLevelParents.set(child, { texturePtr: v.ptr, level });
            resourceToDevice.set(child, device);
            registerVolumeLevelFinalizer(child, v.devicePtr, v.ptr, level);
        }
    }

    for (const d of state.devices) {
        const device = devices.get(d.ptr)!;
        restoreDeviceState(device, d.state, blob);
        for (const [key, ptr] of d.backBufferSurfaces) setDeviceBackBufferSurface(d.ptr, key, ptr);
        if (d.standaloneDepth) {
            const s = d.standaloneDepth;
            const hr = device.setDepthStencilSurface(s.ptr, s.width, s.height, s.format, s.multiSampleType);
            if (hr !== 0) throw new Error(`d3d9: restoring depth surface ${name32(s.ptr)} failed with 0x${(hr >>> 0).toString(16)}`);
        }
        restoreTargets(device, d.state);
        for (const [index, ptr] of d.boundRenderTargets) setDeviceRenderTarget(d.ptr, index, ptr);
        if (d.boundDepthStencil !== 0) deviceBoundDepthStencil.set(d.ptr, d.boundDepthStencil);
        for (const [slot, ptr] of d.slotRefs) setDeviceSlotRef(d.ptr, slot, ptr);
        restoreViewport(device, d.state);
        if (d.backbuffer && !seedBackbuffer(device, blob(d.backbuffer.pixels).slice(), d.backbuffer.width, d.backbuffer.height)) {
            throw new Error(`d3d9: the back buffer image of ${describeDevice(d.ptr)} could not be written back`);
        }
    }

    for (const sb of state.stateBlocks) {
        adoptComObject(sb.ptr);
        const data: D3D9StateBlockData = { devicePtr: sb.devicePtr, blockType: sb.blockType, entries: sb.entries.map(e => ({ ...e })) };
        registerStateBlockObject(sb.ptr, sb.devicePtr, data);
    }
    for (const d of state.devices) restoreRecording(devices.get(d.ptr)!, d.state);

    for (const q of state.queries) restoreQuery(q);
    restoreShaderValidators(state.validators);
    for (const [ptr] of state.validators) adoptComObject(ptr);
    restoreResourceContract(state.contract);
    restoreBaseTextureState(state.textureBase);
    restoreVolumeBaseState(state.volumeBase);
    restoreRecordingDevices(state.recordingDevices);
    restoreOpenWindows(state.openWindows);
    restoreExState(state.ex);

    const tracked = new Set(liveComObjects());
    for (const [ptr] of state.refs.counts) {
        if (!tracked.has(ptr)) throw new Error(`d3d9: the saved reference table names ${name32(ptr)}, which no restored object accounts for`);
    }
    for (const ptr of tracked) {
        if (!state.refs.counts.some(([saved]) => saved === ptr)) {
            throw new Error(`d3d9: restored object ${name32(ptr)} has no saved reference count`);
        }
    }
    restoreComRefs(state.refs);

    if (state.gamma) gammaService.restoreRamp(state.gamma);
    if (state.cursors) restoreDeviceCursors(state.cursors);
    if (state.renderActive !== 0) {
        const active = devices.get(state.renderActive);
        if (active) render.setActive(active as never);
    } else if (state.devices.length > 0) {
        render.setActive(null);
    }
    if (state.devices.length > 0) resetSetterShadows();

    d3d9SplitFlush();
    const lost = splitEncodeErrors() - splitBefore;
    if (lost !== 0) throw new Error(`d3d9: ${lost} restore call(s) could not be recorded for the split renderer`);
    const audit = d3d9SplitAudit(devices.values());
    if (audit.differences.length > 0) {
        throw new Error(`d3d9: after the load the split twin differs from the front: ${audit.differences.slice(0, 3).join("; ")}`);
    }
}

function splitEncodeErrors(): number {
    const stats = d3d9SplitStats();
    if (!stats) return 0;
    let n = 0;
    for (const count of Object.values(stats.encodeErrors)) n += count;
    return n;
}

export function registerD3D9Participant(): () => void {
    return savestateParticipants.add({
        id: 'd3d9', version: 1, order: 58, covers: ['d3d9'], schema: D3D9_SCHEMA as unknown as SaveValue,
        prepare: () => prepareD3D9(),
        verify: (saved, blob) => verifyD3D9(saved as unknown as D3D9SavedState, blob),
        capture: (io) => captureD3D9(io) as unknown as SaveValue,
        restore: (saved, io) => restoreD3D9(saved as unknown as D3D9SavedState, (hash) => io.blob(hash)),
    });
}
