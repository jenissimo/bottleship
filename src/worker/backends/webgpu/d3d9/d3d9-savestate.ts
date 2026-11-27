import type { FieldPolicy } from "../../../savestate/participant";
import { CaptureRefusal } from "../../../savestate/object-codecs";
import type { D3D9Device } from "./d3d9-device";
import { D3D9StateBlockRecorder, type D3D9StateBlockData, type StateBlockEntry } from "./d3d9-state-block";
import { D3D9StateTracker } from "./d3d9-state-tracker";
import { IndexBufferStore, TextureStore, VertexBufferStore } from "./d3d9-resources";
import { d3d9WasmArena } from "./d3d9-wasm-arena";
import { D3D9PresentationState } from "./presentation";
import { resolvePixelShaderComPtr, resolveVertexDeclComPtr, resolveVertexShaderComPtr } from "./d3d9-com-objects";
import { StreamBindingTable, MAX_VERTEX_STREAMS } from "../shared/vertex-streams";
import { TexturePaletteStore } from "../shared/texture-palette-store";
import { getD3DTextureLayout } from "../shared/texture-formats";
import { isDxDepthStencilFormat } from "../shared/dx-format-support";
import { System } from "../../../core/system";

export type D3D9FieldPolicy = FieldPolicy | "refuse";

export const D3D9_DEVICE_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    isExtended: "save", role: "host", renderTwin: "host", splitFrontResult: "host", splitPresentGate: "host",
    splitFramesRemote: "host", splitFetchTexture: "host", splitReadSavestateBackbuffer: "host", splitQueries: "host", splitLossSource: "host",
    unregisterGpuObserver: "host", splitQueryHost: "host", suppressGdiOverlay: "derive",
    frameCount: "transient", lastOverlayClearFrame: "transient", prevPresentTime: "transient",
    megaBatchCensus: "transient", wbufRunAccepted: "transient", wbufRunTryMs: "transient",
    wbufRunRecordMs: "transient", compactShadowDescriptors: "transient", compactShadowParityFailures: "transient",
    compactAuthoritativeRuns: "transient", compactStorageRuns: "transient", wbufRunPipelineMs: "transient",
    wbufRunResourcesMs: "transient", wbufRunCaptureMs: "transient", wbufRunPublishMs: "transient",
    ordinaryIndexedProfiled: "transient", ordinaryIndexedHostMs: "transient", ordinaryIndexedUploadMs: "transient",
    ordinaryIndexedPipelineMs: "transient", ordinaryIndexedCaptureMs: "transient", ordinaryIndexedRecordMs: "transient",
    compactCaptureReuseHits: "transient", compactCaptureReuseMisses: "transient",
    compactPipelineIdentityHits: "transient", compactPipelineIdentityMisses: "transient",
    backend: "host", d3d9MsaaProbe: "host", d3d9MsaaSampleCount: "save", renderTargetSampleTypes: "save",
    d3d9MsaaCache: "derive", standaloneDepthSurfaces: "derive", activeStandaloneDepthSurface: "save",
    streams: "save", streamPlan: "transient", stateTracker: "save", commandRecorder: "derive",
    backendExecutor: "host", gpuQueryManager: "derive", vertexBuffers: "save", indexBuffers: "save", textures: "save",
    borrowedTextureMemory: "save", volumeByPointer: "save", volumeByIndex: "derive", nextVolumeIndex: "derive",
    texturePalettes: "save", pipelineCache: "derive", pipelineCacheMaxSize: "derive", currentPipelineKey: "derive",
    currentPipelineId: "derive", debugFlags: "transient", clearState: "transient", softwareVertexProcessing: "save",
    npatchMode: "save", dialogBoxMode: "save", drawCount: "transient", lastPresentTime: "transient", fps: "transient",
    indexedArenaSpec: "transient", drawIndexedCmd: "transient", lastDrawSnapshot: "transient", frameSnapshot: "transient",
    frameIdCounter: "transient", frameLogRing: "transient", frameLogSerial: "transient", rtSetsThisFrame: "transient",
    rtNonBackThisFrame: "transient", currentRtIndex: "derive", currentRtFace: "derive", renderTargetIndices: "save",
    renderTargetFaces: "save", depthTextureIndex: "save", renderTargetGpuFormats: "derive", srgbTextureViews: "derive",
    cubeFaceRenderViews: "derive", rtDepthCache: "derive", rtResolveLog: "transient", rtCreateLog: "transient",
    rtResolveLast: "transient", deviceWindowHwnd: "save", deviceIsWindowed: "save", lastDepthClearSpace: "transient",
    depthResizeWarned: "transient", mipLevelLocks: "refuse", mipLevelData: "save", cubeFaceLocks: "refuse",
    cubeFaceData: "save", vertexConversionBuffer: "transient", vertexConversionBufferSize: "transient",
    indexScratch: "transient", dipUpIndexRangeWarned: "transient", vbPool: "transient", textureConversionBuffer: "transient",
    vsShaderRegistry: "derive", vsNextHandle: "derive", activeVertexShader: "derive", vsConstants: "save",
    swvpVsConstants: "save", swvpVsIntegerConstants: "save", swvpVsBooleanConstants: "save", vsConstantBits: "derive",
    swvpVsConstantBits: "derive", vsIntegerConstants: "save", vsIntegerBits: "derive", vsBooleanMask: "save",
    vsBankHash: "derive", psBankHash: "derive", vsIntegerHash: "derive", psIntegerHash: "derive",
    vsConstantsVersion: "derive", psShaderRegistry: "derive", psNextHandle: "derive", activePixelShader: "derive",
    hybridDebugOutput: "transient", shaderOutputOverride: "transient", psConstants: "save", psConstantBits: "derive",
    psIntegerConstants: "save", psIntegerBits: "derive", psBooleanMask: "save", psConstantsVersion: "derive",
    shaderDiagnosticNextPair: "transient", shaderDiagnostics: "transient", vsDiagnosticsByHandle: "transient",
    psDiagnosticsByHandle: "transient", shaderDiagnosticEpoch: "transient", shaderPairDiagnostics: "transient",
    shaderPipelinePairs: "transient", shaderBuildFailures: "transient", gpuPipelineValidationFailures: "transient",
    progPipelineCache: "derive", arenaPipelineCache: "derive", compactPipelineIdentityCache: "derive", _lrValid: "derive",
    stateKeyGeneration: "derive", stateKeyBlend: "derive", stateKeyAlpha: "derive", stateKeyDepth: "derive",
    stateKeyTarget: "derive", stateKeyProjected: "derive", attachmentGeneration: "derive", _pmValid: "derive",
    _pmTopo: "derive", _pmForceCull: "derive", _pmStrideOverride: "derive", _pmSlotMask: "derive", _pmPointExp: "derive",
    _pmVs: "derive", _pmPs: "derive", _pmDecl: "derive", _pmFvf: "derive", _pmStride: "derive", _pmStreamHash: "derive",
    _pmGenPipeline: "derive", _pmGenSampler: "derive", _pmGenBank: "derive", _pmGenAttach: "derive",
    _pmPsNonNull: "derive", lastCaptureIndex: "derive", _lrVs: "derive", _lrPs: "derive", _lrDecl: "derive",
    _lrFvf: "derive", _lrStride: "derive", _lrStateBits: "derive", _lrTopo: "derive", _lrForceCull: "derive",
    _lrBlend: "derive", _lrAlpha: "derive", _lrDepth: "derive", _lrCube: "derive", _lrComparison: "derive",
    _lrComparisonKey: "derive", _lrVolume: "derive", _lrVertexVolume: "derive", _lrProj: "derive",
    _lrHybridStages: "derive", _lrSamplerKey: "derive", _lrPipelineId: "derive", _lrStreamHash: "derive",
    _lrTarget: "derive", _lrArenaIdentity: "derive", _lrArenaIdentityWords: "derive",
    arenaIdentityByPipelineState: "derive", lastResolveIdentityScratch: "derive", pendingArenaRecord: "derive",
    arenaSamplerBankGeneration: "derive", samplerStateGeneration: "derive", samplerSpecCache: "derive",
    samplerSpecCacheGeneration: "derive", pipelineStateGeneration: "derive", arenaBankCheckGeneration: "derive",
    arenaBankCheckVs: "derive", arenaBankCheckPs: "derive", arenaBankCheckResult: "derive", vsDeclRegistry: "derive",
    declDrawCounts: "transient", vsDeclNextHandle: "derive", activeVertexDecl: "derive", activeVertexDeclComPtr: "save",
    activeVertexShaderComPtr: "save", activePixelShaderComPtr: "save", boundIndexPtr: "save",
    textureStageStates: "save", projectedSetCount: "transient", projectedFlagsSeen: "transient", samplerStates: "save",
    samplerCache: "derive", stageSamplers: "derive", stageSamplersValid: "derive", stageSamplerQualityToken: "derive",
    stageSamplerDevice: "derive", materialData: "save", lights: "save", lightEnables: "save", clipPlanes: "save",
    stateBlockRecorder: "save", boundTexturePtrs: "save", suppressStateBlockRecording: "refuse", viewport: "save",
    gpuResourceGeneration: "derive", shadowSyncDispatcher: "derive", progDrawsSeen: "transient",
    progDrawsUnattributed: "transient", bankHashMismatches: "transient", verifyingBankHash: "transient",
    ptMemoDecl: "derive", ptMemoFvf: "derive", ptMemoValue: "derive", discardedVb: "derive", discardedIb: "derive",
    vbVersions: "derive", ibVersions: "derive", vbSlotThisFrame: "derive", ibSlotThisFrame: "derive",
    vbUploadedThisFrame: "derive", ibUploadedThisFrame: "derive", vbUploadCountThisFrame: "derive",
    ibUploadCountThisFrame: "derive", vbLastLockFlags: "derive", ibLastLockFlags: "derive", bufferFrameSerial: "derive",
    presentBoundarySerial: "transient", fetchAuditFramesLeft: "transient", fetchAuditShadow: "transient",
    fetchAuditRecords: "transient", fetchAuditReport: "transient", swvpBankStale: "derive",
    ffpUniformBlock: "transient", ffpClipPlanesScratch: "transient", ffpNormalMatrix: "transient",
    ffpBlendMatrices: "transient", ffpLightPool: "transient", ffpLights: "transient", ffpEnabledIdx: "transient",
    ffpStagePool: "transient", ffpStages: "transient", materialView: "transient", ffpMaterial: "transient",
    ffpGlobalAmbient: "transient", ffpTFactor: "transient", ffpFogColor: "transient", ffpVertexColors: "transient",
    ffpParams: "transient", clearRegionRect: "transient", clearRegionRects: "transient", scaledClearRect: "transient",
    scissorRect: "save", scissorRectSet: "save", scissorDrawRect: "transient", rhwDrawViewport: "transient",
    drawRects: "transient", scrubMin: "transient", scrubMax: "transient", scrubFrameSerial: "transient",
    scrubDrawIndex: "transient", scrubLastFrameDraws: "transient", scrubTarget: "transient", scrubExclude: "transient",
    scrubLastCut: "transient", _rsF32: "transient", _rsU32: "transient", psScratch: "transient",
    targetSizeCache: "transient", rewindOrder: "transient", extraStreamScratch: "transient", indexedDrawFate: "transient",
    indexedDrawThrows: "transient", lastActualPresent: "transient", presentInterval: "save", swapEffect: "save",
    getRS: "derive", declSlotMasks: "derive", strideScratch: "transient", boundBankGeneration: "derive",
    boundBankCubeMask: "derive", boundBankVolumeMask: "derive", boundBankVertexVolumeMask: "derive",
    boundBankComparison: "derive", boundBankComparisonMask: "derive", boundBankComparisonKey: "derive",
    samplerShaderStateMemo: "derive", samplerShaderStateMemoNext: "derive", stageWindowEpoch: "derive",
    stageWindowBankGen: "derive", stageWindowSamplerGen: "derive", stageWindowCube: "derive",
    stageWindowVolume: "derive", stageWindowComparison: "derive", stageWindowVertexVolume: "derive",
    stageWindowHasPs: "derive", stageWindowRtGuard: "derive", stageWindowSampler0: "derive",
    stageWindowTextures: "derive", stageWindowSrcTex: "derive", stageWindowSrcView: "derive",
    stageWindowSamplers: "derive", stageWindowVertexTextures: "derive", stageWindowVertexSamplers: "derive",
    lastCaptureVs: "derive", lastCapturePs: "derive", lastCaptureVsVersion: "derive", lastCapturePsVersion: "derive",
    lastCapturePipelineGen: "derive", lastCaptureBankGen: "derive", lastCaptureSamplerGen: "derive",
    lastCaptureViewportW: "derive", lastCaptureViewportH: "derive", constCaptureFrame: "derive",
    constCaptureAttachment: "derive", constCaptureResources: "derive", constCaptureDecl: "derive",
    constCaptureScale: "derive", compactCaptureCache: "derive",
};

export const D3D9_TRACKER_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    streams: "host", renderStates: "save", worldMatrix: "save", worldMatrices: "save", viewMatrix: "save",
    projMatrix: "save", texMatrices: "save", fvf: "save", indexSource: "derive", stream0View: "host",
    textureStages: "derive", dirtyFlags: "derive", pipelineKey: "derive", pipelineKeyDirty: "derive",
    metrics: "transient",
};

export const D3D9_STREAM_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    ptr: "save", bufferIndex: "derive", offsetBytes: "save", strideBytes: "save", freq: "save",
};

export const D3D9_VERTEX_BUFFER_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    capacity: "derive", count: "derive", freeList: "derive", sizes: "save", fvfs: "save", pools: "save", data: "save",
    gpuBuffers: "derive", lockedPtrs: "refuse", lockedSizes: "refuse", lockedOffsets: "refuse", guestPtrs: "save",
    dirtyFlags: "derive", dirtyStarts: "derive", dirtyEnds: "derive", lockedSinceUpload: "derive",
    generations: "derive", handleToIndex: "derive",
};

export const D3D9_INDEX_BUFFER_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    capacity: "derive", count: "derive", freeList: "derive", sizes: "save", formats: "save", pools: "save", data: "save",
    gpuBuffers: "derive", lockedPtrs: "refuse", lockedSizes: "refuse", lockedOffsets: "refuse", guestPtrs: "save",
    dirtyFlags: "derive", dirtyStarts: "derive", dirtyEnds: "derive", lockedSinceUpload: "derive",
    generations: "derive", handleToIndex: "derive",
};

export const D3D9_TEXTURE_STORE_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    capacity: "derive", count: "derive", freeList: "derive", widths: "save", heights: "save", levels: "save",
    pools: "save", handles: "save", formats: "save", data: "save", gpuTextures: "derive", views: "derive",
    lockedPtrs: "refuse", guestPtrs: "save", pitches: "derive", dirtyFlags: "derive", generations: "derive",
    dataSerials: "save", guestSerials: "save", rtFlags: "save", cubeFlags: "save", handleToIndex: "derive",
};

export const D3D9_PALETTE_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    palettes: "save", currentTexturePalette: "save",
};

export const D3D9_PRESENTATION_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    chains: "save", serial: "save",
};

export const D3D9_RECORDER_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    keyOf: "host", active: "save", entries: "save", keyToIndex: "derive",
};

export const D3D9_STATE_BLOCK_FIELDS: Readonly<Record<string, D3D9FieldPolicy>> = {
    devicePtr: "save", blockType: "save", entries: "save", coverable: "derive", wasmSlot: "derive",
    handleEntries: "derive", retainedRefs: "derive",
};

export type Io = { blob(bytes: Uint8Array): string };
export type BlobSource = (hash: string) => Uint8Array;

type Priv = Record<string, any>;
const priv = (o: unknown): Priv => o as Priv;

const D3DTS_WORLD = 0x100;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;
const D3DTS_TEXTURE0 = 16;
export const TRANSFORM_STATES: readonly number[] = [
    ...Array.from({ length: 8 }, (_u, i) => D3DTS_WORLD + i), D3DTS_VIEW, D3DTS_PROJECTION,
    ...Array.from({ length: 8 }, (_u, i) => D3DTS_TEXTURE0 + i),
];

const TEXTURE_SLOTS = 21;
const PS_FLOAT_COUNT = 224 * 4;
const HW_VS_FLOATS = 256 * 4;
const MAX_RENDER_TARGETS = 4;

export function stageOfTextureSlot(slot: number): number {
    if (slot < 16) return slot;
    if (slot < 20) return 257 + slot - 16;
    return 256;
}

export function describeDevice(devicePtr: number): string {
    return `device 0x${(devicePtr >>> 0).toString(16)}`;
}

export function refuseIfLocked(device: D3D9Device, devicePtr: number): void {
    const d = priv(device);
    const who = describeDevice(devicePtr);
    if (d.mipLevelLocks.size > 0) throw new CaptureRefusal(`d3d9: ${who} has a texture mip level locked`);
    if (d.cubeFaceLocks.size > 0) throw new CaptureRefusal(`d3d9: ${who} has a cube face locked`);
    if (d.suppressStateBlockRecording === true) throw new CaptureRefusal(`d3d9: ${who} is applying a state block`);
    for (const [handle, index] of liveStoreEntries(d.vertexBuffers)) {
        if (d.vertexBuffers.isLocked(index)) throw new CaptureRefusal(`d3d9: vertex buffer 0x${handle.toString(16)} is locked`);
    }
    for (const [handle, index] of liveStoreEntries(d.indexBuffers)) {
        if (d.indexBuffers.lockedRange(index) !== null) throw new CaptureRefusal(`d3d9: index buffer 0x${handle.toString(16)} is locked`);
    }
    for (const [handle, index] of liveStoreEntries(d.textures)) {
        if (d.textures.isLocked(index)) throw new CaptureRefusal(`d3d9: texture 0x${handle.toString(16)} level 0 is locked`);
    }
}

export function liveStoreEntries(store: VertexBufferStore | IndexBufferStore | TextureStore): Array<[number, number]> {
    const s = priv(store);
    const out: Array<[number, number]> = [];
    for (const [handle, packed] of s.handleToIndex as Map<number, number>) {
        const index = packed & 0xffff;
        if (s.generations[index] !== ((packed >> 16) & 0xffff)) continue;
        if (s.data[index] === undefined) continue;
        out.push([handle, index]);
    }
    return out.sort((a, b) => a[0] - b[0]);
}

export interface SavedBuffer {
    size: number;
    pool: number;
    kind: number;
    guestPtr: number;
    data: string | null;
}

/** @transient(the last copy handed to the blob store per buffer array; reused while the bytes are equal, so an unchanged buffer is not hashed again) */
const bufferCopies = new WeakMap<Uint8Array, Uint8Array>();

function stableCopy(data: Uint8Array): Uint8Array {
    const last = bufferCopies.get(data);
    if (last && last.length === data.length && sameBytes(last, data)) return last;
    const copy = data.slice();
    bufferCopies.set(data, copy);
    return copy;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    const words = a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 ? a.length >>> 2 : 0;
    if (words > 0) {
        const wa = new Uint32Array(a.buffer, a.byteOffset, words);
        const wb = new Uint32Array(b.buffer, b.byteOffset, words);
        for (let i = 0; i < words; i++) if (wa[i] !== wb[i]) return false;
    }
    for (let i = words * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function captureVertexBuffer(device: D3D9Device, ptr: number, io: Io): SavedBuffer | null {
    const store = priv(device).vertexBuffers as VertexBufferStore;
    const index = store.getIndex(ptr);
    if (index === null) return null;
    const data = store.getData(index);
    return {
        size: store.getSize(index), pool: store.getPool(index), kind: store.getFvf(index),
        guestPtr: store.getGuestPtr(index), data: data && data.length > 0 ? io.blob(stableCopy(data)) : null,
    };
}

export function captureIndexBuffer(device: D3D9Device, ptr: number, io: Io): SavedBuffer | null {
    const store = priv(device).indexBuffers as IndexBufferStore;
    const index = store.getIndex(ptr);
    if (index === null) return null;
    const data = store.getData(index);
    return {
        size: store.getSize(index), pool: store.getPool(index), kind: store.getFormat(index),
        guestPtr: store.getGuestPtr(index), data: data && data.length > 0 ? io.blob(stableCopy(data)) : null,
    };
}

function savedBytes(hash: string, blob: BlobSource, expected: number, what: string): Uint8Array {
    const bytes = blob(hash);
    if (bytes.byteLength !== expected) throw new Error(`d3d9: saved ${what} holds ${bytes.byteLength} bytes, expected ${expected}`);
    return bytes.slice();
}

export function adoptVertexBuffer(device: D3D9Device, ptr: number, s: SavedBuffer, blob: BlobSource): void {
    const what = `vertex buffer 0x${ptr.toString(16)}`;
    if (device.createVertexBuffer(ptr, s.size, s.kind, s.pool, s.guestPtr) === 0) throw new Error(`d3d9: ${what} could not be recreated`);
    if (s.data !== null && !device.writeVertexBufferContents(ptr, savedBytes(s.data, blob, s.size, what))) {
        throw new Error(`d3d9: the contents of ${what} could not be written back`);
    }
}

export function adoptIndexBuffer(device: D3D9Device, ptr: number, s: SavedBuffer, blob: BlobSource): void {
    const what = `index buffer 0x${ptr.toString(16)}`;
    if (device.createIndexBuffer(ptr, s.size, s.kind, s.pool, s.guestPtr) === 0) throw new Error(`d3d9: ${what} could not be recreated`);
    if (s.data !== null && !device.writeIndexBufferContents(ptr, savedBytes(s.data, blob, s.size, what))) {
        throw new Error(`d3d9: the contents of ${what} could not be written back`);
    }
}

export interface SavedTexture {
    guestPtr: number;
    width: number;
    height: number;
    levels: number;
    format: number;
    pool: number;
    cube: boolean;
    renderTarget: boolean;
    borrowedPtr: number;
    borrowedBytes: number;
    data: string | null;
    guestStale: boolean;
    mips: Array<[number, string]>;
    faces: Array<[string, string]>;
}

/** @transient(copies handed to the blob store; valid for one content serial of the level-0 array they were cut from) */
const textureCopies = new WeakMap<Uint8Array, { serial: number; length: number; bytes: Uint8Array }>();
/** @transient(copies of mip and face arrays, which a write replaces instead of editing, so the array is its own generation) */
const levelCopies = new WeakMap<Uint8Array, Uint8Array>();

const copyOfLevel = (data: Uint8Array): Uint8Array => {
    let copy = levelCopies.get(data);
    if (!copy) levelCopies.set(data, copy = data.slice());
    return copy;
};

export function isReadableRenderTargetFormat(format: number): boolean {
    return format === 21 || format === 22 || format === 23 || format === 24 || format === 25 || format === 26 || format === 30;
}

export function captureTexture(device: D3D9Device, ptr: number, io: Io): SavedTexture | null {
    const d = priv(device);
    const store = d.textures as TextureStore;
    const index = store.getIndex(ptr);
    if (index === null) return null;
    const cube = store.isCubeMap(index);
    const renderTarget = store.isRenderTarget(index);
    const level0 = store.getData(index);
    const borrowed = (d.borrowedTextureMemory as Map<number, { ptr: number; bytes: number }> | undefined)?.get(ptr);
    let data: string | null = null;
    if (level0 && level0.length > 0 && !borrowed && !isDxDepthStencilFormat(store.getFormat(index), 9)) {
        const serial = priv(store).dataSerials[index] as number;
        let copy = textureCopies.get(level0);
        if (!copy || copy.serial !== serial || copy.length !== level0.length) {
            copy = { serial, length: level0.length, bytes: level0.slice() };
            textureCopies.set(level0, copy);
        }
        data = io.blob(copy.bytes);
    }
    const prefix = `${ptr}:`;
    const mips: Array<[number, string]> = [];
    for (const [key, bytes] of d.mipLevelData as Map<string, Uint8Array>) {
        if (key.startsWith(prefix)) mips.push([Number(key.slice(prefix.length)), io.blob(copyOfLevel(bytes))]);
    }
    const faces: Array<[string, string]> = [];
    for (const [key, bytes] of d.cubeFaceData as Map<string, Uint8Array>) {
        if (key.startsWith(prefix)) faces.push([key.slice(prefix.length), io.blob(copyOfLevel(bytes))]);
    }
    return {
        guestPtr: store.getGuestPtr(index),
        width: store.getWidth(index), height: store.getHeight(index), levels: store.getLevels(index),
        format: store.getFormat(index), pool: store.getPool(index), cube, renderTarget,
        borrowedPtr: borrowed?.ptr ?? 0, borrowedBytes: borrowed?.bytes ?? 0,
        data, guestStale: store.guestCopyIsStale(index),
        mips: mips.sort((a, b) => a[0] - b[0]),
        faces: faces.sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
}

export function adoptTexture(device: D3D9Device, ptr: number, usage: number, s: SavedTexture, blob: BlobSource): void {
    const d = priv(device);
    const store = d.textures as TextureStore;
    const who = `texture 0x${ptr.toString(16)}`;
    const made = s.cube
        ? device.createCubeTexture(ptr, s.width, s.levels, s.format, usage, s.pool, s.guestPtr)
        : device.createTexture(ptr, s.width, s.height, s.levels, s.format, usage, s.pool, s.borrowedPtr, s.guestPtr);
    if (made === 0) throw new Error(`d3d9: ${who} could not be recreated`);
    const index = store.getIndex(ptr)!;
    const fail = (what: string): never => { throw new Error(`d3d9: ${what} of ${who} could not be written back`); };
    for (const [level, hash] of s.mips) {
        const layout = getD3DTextureLayout(s.format, Math.max(1, s.width >>> level), Math.max(1, s.height >>> level));
        if (!device.setTextureLevelPixels(ptr, level, savedBytes(hash, blob, layout.bytes, `${who} mip ${level}`), layout.pitch)) fail(`mip ${level}`);
    }
    for (const [key, hash] of s.faces) {
        const [face, level] = key.split(":").map(Number) as [number, number];
        const edge = Math.max(1, s.width >>> level);
        const layout = getD3DTextureLayout(s.format, edge, edge);
        if (!device.setCubeFacePixels(ptr, face, level, savedBytes(hash, blob, layout.bytes, `${who} face ${key}`), layout.pitch)) fail(`face ${key}`);
    }
    if (s.borrowedPtr !== 0) {
        const memory = System.getInstance().process?.getCurrentMemory();
        if (!memory || s.borrowedPtr + s.borrowedBytes > memory.length) fail("the borrowed level 0");
        if (!device.setTextureLevelPixels(ptr, 0, memory!.slice(s.borrowedPtr, s.borrowedPtr + s.borrowedBytes), store.getPitch(index))) fail("the borrowed level 0");
    } else if (s.data !== null) {
        const level0 = savedBytes(s.data, blob, getD3DTextureLayout(s.format, s.width, s.cube ? s.width : s.height).bytes, who);
        if (s.renderTarget) {
            if (!device.seedRenderTargetContents(ptr, level0)) fail("the render target image");
        } else if (!device.setTextureLevelPixels(ptr, 0, level0, store.getPitch(index))) {
            fail("level 0");
        }
    }
    priv(store).dataSerials[index] = s.guestStale ? 1 : 0;
    priv(store).guestSerials[index] = 0;
}

export interface SavedShader {
    bytecode: string;
}

export function savedTokens(bytecode: Uint32Array, io: Io): string {
    return io.blob(new Uint8Array(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength).slice());
}

export function tokensOf(hash: string, blob: BlobSource): Uint32Array {
    const bytes = blob(hash);
    if (bytes.byteLength % 4 !== 0) throw new Error(`d3d9: a saved shader holds ${bytes.byteLength} bytes, not whole tokens`);
    return new Uint32Array(bytes.slice().buffer);
}

export interface SavedMatrixSet {
    states: number[];
    data: Float32Array;
}

export interface SavedDeviceState {
    isExtended: boolean;
    softwareVertexProcessing: boolean;
    npatchMode: number;
    dialogBoxMode: boolean;
    windowHwnd: number;
    windowed: boolean;
    presentInterval: number;
    swapEffect: number;
    msaaSampleCount: number;
    guestBackbuffer: { width: number; height: number } | null;
    viewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number };
    scissor: { left: number; top: number; right: number; bottom: number } | null;
    renderStates: Int32Array;
    textureStageStates: Array<[number, number]>;
    samplerStates: Array<[number, number]>;
    transforms: Float32Array;
    fvf: number;
    vertexShader: number;
    pixelShader: number;
    declaration: number;
    streams: Array<{ ptr: number; offset: number; stride: number; freq: number }>;
    indices: number;
    boundTextures: number[];
    renderTargets: Array<{ ptr: number; face: number; sampleType: number } | null>;
    depthTexture: number;
    standaloneDepth: number;
    vsFloat: Float32Array;
    vsFloatExtended: string | null;
    vsInt: Int32Array;
    vsIntExtended: string | null;
    vsBool: Uint8Array;
    vsBoolMask: number;
    psFloat: Float32Array;
    psInt: Int32Array;
    psBoolMask: number;
    material: Uint8Array;
    lights: Array<[number, Uint8Array]>;
    lightEnables: Array<[number, number]>;
    clipPlanes: Array<[number, Float32Array]>;
    palettes: Array<[number, Uint32Array]>;
    currentPalette: number;
    recording: { entries: StateBlockEntry[] } | null;
    volumes: number[];
}

function allZero(view: ArrayBufferView, from: number): boolean {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = from; i < bytes.length; i++) if (bytes[i] !== 0) return false;
    return true;
}

export function copyEntry(entry: StateBlockEntry): StateBlockEntry {
    const out: Record<string, unknown> = { ...entry };
    for (const [key, value] of Object.entries(out)) if (ArrayBuffer.isView(value)) out[key] = (value as Uint8Array).slice();
    return out as unknown as StateBlockEntry;
}

export function captureDeviceState(device: D3D9Device, io: Io): SavedDeviceState {
    const d = priv(device);
    const tracker = d.stateTracker as D3D9StateTracker;
    const streams = d.streams as StreamBindingTable;

    const renderStates = new Int32Array(256);
    for (let i = 0; i < 256; i++) renderStates[i] = tracker.getRenderState(i);

    const transforms = new Float32Array(TRANSFORM_STATES.length * 16);
    TRANSFORM_STATES.forEach((state, i) => transforms.set(device.getTransform(state)!.subarray(0, 16), i * 16));

    const hwVs = (d.vsConstants as Float32Array).slice();
    const swvpBank = d.swvpVsConstants as Float32Array;
    const swvpExtension = swvpBank.subarray(HW_VS_FLOATS);
    const swvpInts = d.swvpVsIntegerConstants as Int32Array;
    const hwInts = d.vsIntegerConstants as Int32Array;

    const boundTextures = Array.from({ length: TEXTURE_SLOTS }, (_u, slot) => (d.boundTexturePtrs[slot] as number) >>> 0);
    const renderTargets: SavedDeviceState["renderTargets"] = [];
    for (let i = 0; i < MAX_RENDER_TARGETS; i++) {
        const index = d.renderTargetIndices[i] as number | null;
        renderTargets.push(index === null ? null : {
            ptr: (d.textures as TextureStore).getHandle(index), face: d.renderTargetFaces[i] as number,
            sampleType: (d.renderTargetSampleTypes[i] as number) >>> 0,
        });
    }
    const depthIndex = d.depthTextureIndex as number | null;

    return {
        isExtended: device.isExtended,
        softwareVertexProcessing: d.softwareVertexProcessing,
        npatchMode: d.npatchMode,
        dialogBoxMode: d.dialogBoxMode,
        windowHwnd: d.deviceWindowHwnd,
        windowed: d.deviceIsWindowed,
        presentInterval: d.presentInterval,
        swapEffect: d.swapEffect,
        msaaSampleCount: d.d3d9MsaaSampleCount,
        guestBackbuffer: priv(d.backendExecutor).guestBackbufferSize
            ? { ...priv(d.backendExecutor).guestBackbufferSize } : null,
        viewport: { ...d.viewport },
        scissor: d.scissorRectSet ? { ...d.scissorRect } : null,
        renderStates,
        textureStageStates: [...(d.textureStageStates as Map<number, number>)],
        samplerStates: [...(d.samplerStates as Map<number, number>)],
        transforms,
        fvf: tracker.getFVF(),
        vertexShader: d.activeVertexShaderComPtr,
        pixelShader: d.activePixelShaderComPtr,
        declaration: d.activeVertexDeclComPtr,
        streams: Array.from({ length: MAX_VERTEX_STREAMS }, (_u, i) => ({
            ptr: streams.ptr[i]!, offset: streams.offsetBytes[i]!, stride: streams.strideBytes[i]!, freq: streams.freq[i]!,
        })),
        indices: d.boundIndexPtr,
        boundTextures,
        renderTargets,
        depthTexture: depthIndex === null ? 0 : (d.textures as TextureStore).getHandle(depthIndex),
        standaloneDepth: d.activeStandaloneDepthSurface ?? 0,
        vsFloat: hwVs,
        vsFloatExtended: allZero(swvpExtension, 0) ? null : io.blob(new Uint8Array(swvpExtension.slice().buffer)),
        vsInt: hwInts.slice(),
        vsIntExtended: allZero(swvpInts.subarray(hwInts.length), 0) ? null
            : io.blob(new Uint8Array(swvpInts.subarray(hwInts.length).slice().buffer)),
        vsBool: (d.swvpVsBooleanConstants as Uint8Array).slice(),
        vsBoolMask: d.vsBooleanMask,
        psFloat: (d.psConstants as Float32Array).slice(0, PS_FLOAT_COUNT),
        psInt: (d.psIntegerConstants as Int32Array).slice(),
        psBoolMask: d.psBooleanMask,
        material: (d.materialData as Uint8Array).slice(),
        lights: [...(d.lights as Map<number, Uint8Array>)].map(([i, bytes]) => [i, bytes.slice()] as [number, Uint8Array]),
        lightEnables: [...(d.lightEnables as Map<number, number>)],
        clipPlanes: [...(d.clipPlanes as Map<number, Float32Array>)].map(([i, plane]) => [i, plane.slice()] as [number, Float32Array]),
        palettes: [...priv(d.texturePalettes).palettes as Map<number, Uint32Array>].map(([n, p]) => [n, p.slice()] as [number, Uint32Array]),
        currentPalette: (d.texturePalettes as TexturePaletteStore).getCurrentTexturePalette(),
        recording: capturedRecording(d.stateBlockRecorder as D3D9StateBlockRecorder),
        volumes: [...(d.volumeByPointer as Map<number, number>).keys()].sort((a, b) => a - b),
    };
}

function capturedRecording(recorder: D3D9StateBlockRecorder): { entries: StateBlockEntry[] } | null {
    if (!recorder.isRecording()) return null;
    return { entries: (priv(recorder).entries as StateBlockEntry[]).map(copyEntry) };
}

const stageOf = (key: number): number => (key >>> 16) & 0xffff;
const typeOf = (key: number): number => key & 0xffff;

export function restoreDeviceState(device: D3D9Device, s: SavedDeviceState, blob: BlobSource): void {
    const d = priv(device);
    const fail = (what: string, hr: number): never => {
        throw new Error(`d3d9: restoring ${what} failed with 0x${(hr >>> 0).toString(16)}`);
    };
    const check = (what: string, hr: number): void => { if (hr !== 0) fail(what, hr); };
    if (s.guestBackbuffer) device.setBackBufferSize(s.guestBackbuffer.width, s.guestBackbuffer.height, !s.windowed, s.windowHwnd);
    else device.restoreDeviceWindow(s.windowHwnd, s.windowed);
    device.setPresentationInterval(s.presentInterval);
    device.setSwapEffect(s.swapEffect);
    if (s.msaaSampleCount > 1 && !device.configureD3D9MultisampleType(s.msaaSampleCount)) {
        throw new Error(`d3d9: restoring ${s.msaaSampleCount}x multisampling failed; the adapter does not offer it`);
    }

    for (let i = 0; i < 256; i++) check(`render state ${i}`, device.setRenderState(i, s.renderStates[i]! | 0));
    for (const [key, value] of s.textureStageStates) {
        check(`texture stage state ${stageOf(key)}:${typeOf(key)}`, device.setTextureStageState(stageOf(key), typeOf(key), value));
    }
    for (const [key, value] of s.samplerStates) {
        check(`sampler state ${stageOf(key)}:${typeOf(key)}`, device.setSamplerState(stageOf(key), typeOf(key), value));
    }
    TRANSFORM_STATES.forEach((state, i) => {
        if (!device.restoreTransform(state, s.transforms.slice(i * 16, (i + 1) * 16))) fail(`transform ${state}`, 0x8876086c);
    });
    check("the material", device.setMaterial(s.material.slice()));
    for (const [index, bytes] of s.lights) check(`light ${index}`, device.setLight(index, bytes.slice()));
    for (const [index, enable] of s.lightEnables) check(`light enable ${index}`, device.lightEnable(index, enable));
    for (const [index, plane] of s.clipPlanes) check(`clip plane ${index}`, device.setClipPlane(index, plane.slice()));
    for (const [n, entries] of s.palettes) device.setPaletteEntriesFromBytes(n, new Uint8Array(entries.slice().buffer));
    device.setCurrentTexturePalette(s.currentPalette);
    check("the N-patch mode", device.setNPatchMode(s.npatchMode));
    check("the dialog box mode", device.setDialogBoxMode(s.dialogBoxMode));

    check("software vertex processing", device.setSoftwareVertexProcessing(true));
    const swvpFloats = (d.swvpVsConstants as Float32Array).length;
    const vsFloat = new Float32Array(s.vsFloatExtended === null ? HW_VS_FLOATS : swvpFloats);
    vsFloat.set(s.vsFloat);
    if (s.vsFloatExtended !== null) {
        vsFloat.set(new Float32Array(savedBytes(s.vsFloatExtended, blob, (swvpFloats - HW_VS_FLOATS) * 4, "software vertex constants").buffer), HW_VS_FLOATS);
    }
    check("the vertex shader constants", device.setVertexShaderConstantFFromArray(0, vsFloat, null as unknown as Uint8Array));
    const swvpInts = (d.swvpVsIntegerConstants as Int32Array).length;
    const vsInt = new Int32Array(s.vsIntExtended === null ? s.vsInt.length : swvpInts);
    vsInt.set(s.vsInt);
    if (s.vsIntExtended !== null) {
        vsInt.set(new Int32Array(savedBytes(s.vsIntExtended, blob, (swvpInts - s.vsInt.length) * 4, "software vertex integer constants").buffer), s.vsInt.length);
    }
    check("the vertex shader integer constants", device.setVertexShaderConstantIFromArray(0, vsInt));
    check("the vertex shader boolean constants", device.setVertexShaderConstantBFromArray(0, Int32Array.from(s.vsBool)));
    check("the pixel shader constants", device.setPixelShaderConstantFFromArray(0, s.psFloat.slice(), null as unknown as Uint8Array));
    check("the pixel shader integer constants", device.setPixelShaderConstantIFromArray(0, s.psInt.slice()));
    device.restoreShaderBooleanMasks(s.vsBoolMask, s.psBoolMask);
    check("software vertex processing", device.setSoftwareVertexProcessing(s.softwareVertexProcessing));

    if (s.declaration !== 0) {
        const decl = resolveVertexDeclComPtr(s.declaration);
        if (!decl) throw new Error(`d3d9: vertex declaration 0x${s.declaration.toString(16)} is bound but was not saved`);
        device.setVertexDeclaration(decl.internalHandle, s.declaration);
    } else if (s.fvf !== 0) {
        device.setFVF(s.fvf);
    }
    if (s.vertexShader !== 0) {
        const vs = resolveVertexShaderComPtr(s.vertexShader);
        if (!vs) throw new Error(`d3d9: vertex shader 0x${s.vertexShader.toString(16)} is bound but was not saved`);
        device.setVertexShader(vs.internalHandle, s.vertexShader);
    }
    if (s.pixelShader !== 0) {
        const ps = resolvePixelShaderComPtr(s.pixelShader);
        if (!ps) throw new Error(`d3d9: pixel shader 0x${s.pixelShader.toString(16)} is bound but was not saved`);
        device.setPixelShader(ps.internalHandle, s.pixelShader);
    }
    s.streams.forEach((stream, i) => {
        if (stream.ptr !== 0 || stream.offset !== 0 || stream.stride !== 0) check(`stream ${i}`, device.setStreamSource(i, stream.ptr, stream.offset, stream.stride));
        if (stream.freq !== 1) check(`stream ${i} frequency`, device.setStreamSourceFreq(i, stream.freq));
    });
    if (s.indices !== 0) check("the index buffer", device.setIndices(s.indices));
    s.boundTextures.forEach((ptr, slot) => {
        if (ptr !== 0) check(`the texture on stage ${stageOfTextureSlot(slot)}`, device.setTexture(stageOfTextureSlot(slot), ptr));
    });
}

export function restoreTargets(device: D3D9Device, s: SavedDeviceState): void {
    s.renderTargets.forEach((target, i) => {
        if (target === null) return;
        const hr = device.setRenderTarget(i, target.ptr, target.face, target.sampleType);
        if (hr !== 0) throw new Error(`d3d9: restoring render target ${i} failed with 0x${(hr >>> 0).toString(16)}`);
    });
    if (s.depthTexture !== 0) {
        const hr = device.setDepthStencilTexture(s.depthTexture);
        if (hr !== 0) throw new Error(`d3d9: restoring the depth texture failed with 0x${(hr >>> 0).toString(16)}`);
    }
}

export function restoreViewport(device: D3D9Device, s: SavedDeviceState): void {
    device.restoreViewportSnapshot({ ...s.viewport });
    if (s.scissor) device.setScissorRect(s.scissor.left, s.scissor.top, s.scissor.right, s.scissor.bottom);
}

export function restoreRecording(device: D3D9Device, s: SavedDeviceState): void {
    if (s.recording === null) return;
    const hr = device.beginStateBlock();
    if (hr !== 0) throw new Error(`d3d9: reopening the state block recording failed with 0x${(hr >>> 0).toString(16)}`);
    if (!device.restoreRecordingEntries(s.recording.entries.map(copyEntry))) throw new Error("d3d9: the recorded state block entries could not be journaled again");
}

export function captureVolumeRegistrations(device: D3D9Device): number[] {
    return [...(priv(device).volumeByPointer as Map<number, number>).keys()].sort((a, b) => a - b);
}

export function materializedBlockEntries(data: D3D9StateBlockData): StateBlockEntry[] {
    if (data.wasmSlot === undefined) return data.entries.map(copyEntry);
    const views = d3d9WasmArena.blockSlotViews(data.wasmSlot);
    const handleKey = (e: StateBlockEntry): string => `${e.op}:${(e as { stage?: number }).stage ?? ""}`;
    const fresh = new Map((data.handleEntries ?? []).map(e => [handleKey(e), e] as [string, StateBlockEntry]));
    const vsCount = data.entries.filter(e => e.op === "vertexShaderConstantF").length;
    let vsTotal = 0;
    for (let i = 0; i < vsCount; i++) vsTotal += views.vsRanges[i * 2 + 1]!;
    let vsSeen = 0;
    let psSeen = 0;
    let vsPool = 0;
    let psPool = vsTotal;
    const out: StateBlockEntry[] = [];
    for (const entry of data.entries) {
        if (entry.op === "renderState") {
            out.push({ op: "renderState", state: entry.state, value: views.rsValues[entry.state]! | 0 });
        } else if (entry.op === "samplerState") {
            out.push({ op: "samplerState", sampler: entry.sampler, type: entry.type, value: views.sampValues[entry.type]! >>> 0 });
        } else if (entry.op === "vertexShaderConstantF") {
            const start = views.vsRanges[vsSeen * 2]!;
            const count = views.vsRanges[vsSeen * 2 + 1]!;
            out.push({ op: "vertexShaderConstantF", start, data: views.constPool.slice(vsPool, vsPool + count) });
            vsPool += count;
            vsSeen++;
        } else if (entry.op === "pixelShaderConstantF") {
            const start = views.psRanges[psSeen * 2]!;
            const count = views.psRanges[psSeen * 2 + 1]!;
            out.push({ op: "pixelShaderConstantF", start, data: views.constPool.slice(psPool, psPool + count) });
            psPool += count;
            psSeen++;
        } else {
            out.push(copyEntry(fresh.get(handleKey(entry)) ?? entry));
        }
    }
    return out;
}

export function capturePresentation(state: D3D9PresentationState): { serial: number; chains: unknown[] } {
    return { serial: priv(state).serial, chains: state.snapshot() };
}

export function restorePresentation(state: D3D9PresentationState, saved: { serial: number; chains: Array<{ index: number }> }): void {
    const s = priv(state);
    s.chains.clear();
    for (const chain of saved.chains) s.chains.set(chain.index >>> 0, JSON.parse(JSON.stringify(chain)));
    s.serial = saved.serial;
}

export type ReadbackProblem = { what: string; why: string };

export async function readBackDevice(
    device: D3D9Device,
): Promise<{ problems: ReadbackProblem[]; backbuffer: { rgba: Uint8Array; width: number; height: number } | null }> {
    const d = priv(device);
    const problems: ReadbackProblem[] = [];
    const store = d.textures as TextureStore;
    const front = device.role === "front";
    const lost = !front && d.backend.getDevice?.() == null;
    if (!front && device.hasPendingWork()) d.submitFrame(false);
    for (const [handle, index] of liveStoreEntries(store)) {
        if (!store.isRenderTarget(index) || (!front && !store.getGpuTexture(index))) continue;
        const what = `render target texture 0x${handle.toString(16)}`;
        if (lost) {
            problems.push({ what, why: "the GPU device is lost" });
            continue;
        }
        if (store.isCubeMap(index)) {
            problems.push({ what, why: "a cube render target has six faces and no readback path" });
            continue;
        }
        if (!isReadableRenderTargetFormat(store.getFormat(index))) {
            problems.push({ what, why: `format ${store.getFormat(index)} has no readback conversion` });
            continue;
        }
        try {
            const read = front ? device.textureReadbackForLock(handle, 0, false) : d.downloadGpuTextureIntoData(index, index);
            if (!(await read)) problems.push({ what, why: "the readback did not complete" });
        } catch (e) {
            problems.push({ what, why: e instanceof Error ? e.message : String(e) });
        }
    }
    let backbuffer: { rgba: Uint8Array; width: number; height: number } | null = null;
    try {
        backbuffer = await device.readSavestateBackbuffer();
    } catch (e) {
        problems.push({ what: "the back buffer", why: lost ? "the GPU device is lost" : e instanceof Error ? e.message : String(e) });
    }
    return { problems, backbuffer };
}

export function retireDevice(device: D3D9Device): void {
    if (device.renderTwin) retireDevice(device.renderTwin);
    const d = priv(device);
    d.unregisterGpuObserver?.();
    d.unregisterGpuObserver = null;
    for (const store of [d.vertexBuffers, d.indexBuffers] as Array<VertexBufferStore | IndexBufferStore>) {
        for (const buffer of priv(store).gpuBuffers as Array<{ destroy(): void } | null>) buffer?.destroy();
    }
    for (const texture of priv(d.textures).gpuTextures as Array<{ destroy(): void } | null>) texture?.destroy();
    for (const entry of (d.volumeByIndex as Map<number, { texture: { destroy(): void } | null }>).values()) entry.texture?.destroy();
    for (const entry of (d.rtDepthCache as Map<string, { texture: { destroy(): void } }>).values()) entry.texture.destroy();
    for (const binding of (d.standaloneDepthSurfaces as Map<number, { texture: { destroy(): void } | null }>).values()) binding.texture?.destroy();
    d.gpuQueryManager?.destroy();
    d.backendExecutor.destroyOwnedResources();
    const render = System.getInstance().services.render;
    if (render.getActive() === (device as unknown)) render.setActive(null);
}

export function seedBackbuffer(device: D3D9Device, rgba: Uint8Array, width: number, height: number): boolean {
    return device.seedBackbufferImage(rgba, width, height);
}
