/**
 * IDirect3DSwapChain9 and additional-swap-chain handlers.
 *
 * Device creation/reset remains in device.ts.  This module owns the child COM
 * objects and the per-device chain registry so the integration layer only has
 * to register these exports and call registerImplicitSwapChain at CreateDevice.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import {
    D3D9PresentationState,
    D3D9Rect,
    PresentationParameters9,
    PresentRequest9,
    defaultPresentationParameters9,
    parsePresentationParameters9,
    parseRect9,
    parseDirtyRegion9,
    normalizePresentationParameters9,
    validatePresentationParameters9,
    writePresentationParameters9,
    D3DERR_DEVICELOST,
    D3DERR_INVALIDCALL,
} from '../../backends/webgpu/d3d9/presentation';
import {
    addComRef,
    createComObject,
    devices,
    getComRefCount,
    getVTables,
    registerDeviceChildFinalizer,
    releaseComRef,
    resourceToDevice,
} from './shared-state';
import {
    D3DFMT_X8R8G8B8,
    D3DUSAGE_RENDERTARGET,
    D3DPOOL_DEFAULT,
    D3DRTYPE_SURFACE,
} from './swapchain-constants';
import { releaseSurfaceMetadata, surfaceMeta } from './resource-registry';
import { readD3D9GuidKey } from './object-contracts';
import { notifyDeviceSubmission } from './query';

const D3D_OK = 0;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const D3DBACKBUFFER_TYPE_MONO = 0;
const D3DMULTISAMPLE_NONE = 0;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DPRESENTEX_KNOWN_FLAGS = 0x1f;
const MAX_BACK_BUFFER_COUNT = 30;
const IID_IUNKNOWN = '0000000000000000c000000000000046';
const IID_IDIRECT3DSWAPCHAIN9 = 'f2504979fcad8a45905e10a10b0b503b';

/** The fields which identify a swap-chain backbuffer to surface users. */
export type SwapChainRecord = {
    ptr: number;
    devicePtr: number;
    device: D3D9Device;
    index: number;
    params: PresentationParameters9;
    backBuffers: number[];
    presentation: D3D9PresentationState;
};

/** D3D9Ex PresentEx flags understood by the backend's control-plane seam. */
export function validatePresentExFlags(flags: number): number {
    return ((flags >>> 0) & ~D3DPRESENTEX_KNOWN_FLAGS) === 0 ? D3D_OK : D3DERR_INVALIDCALL;
}

/**
 * Additional swap chains are windowed in D3D9Ex.  Fullscreen mode switching
 * belongs to the implicit chain's ResetEx path; accepting it here would create
 * a child that cannot be presented faithfully by the single-output backend.
 */
export function validateAdditionalSwapChainParameters(params: PresentationParameters9, device?: D3D9Device): number {
    const structural = validatePresentationParameters9(params, device?.isExtended === true);
    if (structural !== D3D_OK) return structural;
    if (!params.windowed) return D3DERR_INVALIDCALL;
    // The capability path exposes one quality level (index 0) for every
    // supported sample count.  Do not retain an unrepresentable quality index
    // in an additional chain's surface metadata.
    if ((params.multiSampleQuality >>> 0) !== 0) return D3DERR_NOTAVAILABLE;
    return device?.supportsD3D9MultisampleType(params.multiSampleType) === true || params.multiSampleType === D3DMULTISAMPLE_NONE
        ? D3D_OK
        : D3DERR_NOTAVAILABLE;
}

const records = new Map<number, SwapChainRecord>();
const deviceChains = new Map<number, Map<number, SwapChainRecord>>();
const surfaceChains = new Map<number, number>();
const devicePresentation = new Map<number, D3D9PresentationState>();

function stateForDevice(devicePtr: number): D3D9PresentationState {
    const key = devicePtr >>> 0;
    let state = devicePresentation.get(key);
    if (!state) {
        state = new D3D9PresentationState();
        devicePresentation.set(key, state);
    }
    return state;
}

function addDeviceChain(record: SwapChainRecord): void {
    let chains = deviceChains.get(record.devicePtr);
    if (!chains) {
        chains = new Map();
        deviceChains.set(record.devicePtr, chains);
    }
    chains.set(record.index, record);
    records.set(record.ptr, record);
}

function removeDeviceChain(record: SwapChainRecord): void {
    records.delete(record.ptr);
    const chains = deviceChains.get(record.devicePtr);
    chains?.delete(record.index);
    if (chains && chains.size === 0) deviceChains.delete(record.devicePtr);
    if (chains?.size === 0) devicePresentation.delete(record.devicePtr);
    record.presentation.destroyChain(record.index);
}

/**
 * Every out-parameter in this module is a guest pointer. A bounds test is not
 * validation: only the region map knows the target is not code, a red zone or
 * read-only, and a COM pointer written into a PE image faults nowhere.
 */
function writePtr(memory: Uint8Array, ptr: number, value: number): boolean {
    const address = ptr >>> 0;
    if (!address || address + 4 > memory.byteLength) return false;
    if (!isValidAddress(memory, address, 4, 'rw')) return false;
    return Mem.writeUint32(address, value >>> 0);
}

function getRecord(ptr: number): SwapChainRecord | null {
    return records.get(ptr >>> 0) ?? null;
}

function rectOrNull(memory: Uint8Array, ptr: number): D3D9Rect | null | undefined {
    if (!ptr) return null;
    const rect = parseRect9(memory, ptr);
    return rect ?? undefined;
}

function createBackBuffer(record: SwapChainRecord): number {
    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) return 0;
    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, record.device);
    surfaceMeta.set(surfacePtr, {
        format: record.params.backBufferFormat || D3DFMT_X8R8G8B8,
        type: D3DRTYPE_SURFACE,
        usage: D3DUSAGE_RENDERTARGET,
        pool: D3DPOOL_DEFAULT,
        multiSampleType: record.params.multiSampleType || D3DMULTISAMPLE_NONE,
        multiSampleQuality: record.params.multiSampleQuality,
        width: record.params.backBufferWidth,
        height: record.params.backBufferHeight,
        // Chain 0 is the IMPLICIT swap chain: Reset redeclares its back buffers, so they are
        // device-owned and can never be the DEFAULT-pool resource that blocks it. An
        // ADDITIONAL chain (index > 0) is the app's to release, and keeps counting.
        implicitBackBuffer: (record.index >>> 0) === 0,
    });
    surfaceChains.set(surfacePtr, record.ptr);
    registerDeviceChildFinalizer(surfacePtr, record.devicePtr, () => {
        surfaceChains.delete(surfacePtr);
        releaseSurfaceMetadata(surfacePtr);
    });
    return surfacePtr;
}

function createSwapChain(
    devicePtr: number,
    params: PresentationParameters9,
    index: number,
): SwapChainRecord | null {
    const device = devices.get(devicePtr >>> 0);
    if (!device) return null;
    const vtableAddr = getVTables()['IDirect3DSwapChain9']?.address;
    if (!vtableAddr) return null;
    const presentation = stateForDevice(devicePtr);
    const structural = validatePresentationParameters9(params, device.isExtended);
    if (structural !== D3D_OK) return null;
    const normalized = normalizePresentationParameters9({
        ...params,
        backBufferFormat: params.backBufferFormat || D3DFMT_X8R8G8B8,
    });
    if (normalized.backBufferCount > MAX_BACK_BUFFER_COUNT) return null;
    if (!device.supportsD3D9MultisampleType(normalized.multiSampleType)) return null;
    const ptr = createComObject(vtableAddr);
    const record: SwapChainRecord = {
        ptr,
        devicePtr: devicePtr >>> 0,
        device,
        index: index >>> 0,
        params: normalized,
        backBuffers: [],
        presentation,
    };
    addDeviceChain(record);
    presentation.createChain(record.index, normalized);
    const count = Math.max(1, normalized.backBufferCount >>> 0);
    for (let i = 0; i < count; i++) {
        const surfacePtr = createBackBuffer(record);
        if (!surfacePtr) {
            for (const old of record.backBuffers) releaseComRef(old);
            removeDeviceChain(record);
            releaseComRef(ptr);
            return null;
        }
        record.backBuffers.push(surfacePtr);
    }
    registerDeviceChildFinalizer(ptr, record.devicePtr, () => {
        for (const surfacePtr of record.backBuffers) releaseComRef(surfacePtr);
        removeDeviceChain(record);
    });
    return record;
}

/** Register the implicit swap chain (index 0) during CreateDevice. */
export function registerImplicitSwapChain(
    devicePtr: number,
    memory: Uint8Array,
    pPresentationParameters: number,
    isExtended = false,
): number {
    const key = devicePtr >>> 0;
    if (deviceChains.get(key)?.get(0)) return deviceChains.get(key)!.get(0)!.ptr;
    const parsed = pPresentationParameters
        ? parsePresentationParameters9(memory, pPresentationParameters)
        : null;
    const requested = parsed ?? defaultPresentationParameters9();
    const device = devices.get(key);
    if (!device || validatePresentationParameters9(requested, isExtended || device.isExtended) !== D3D_OK) return 0;
    const record = createSwapChain(key, requested, 0);
    return record?.ptr ?? 0;
}

export function getSwapChainRecord(ptr: number): SwapChainRecord | null {
    return getRecord(ptr);
}

export function getDeviceSwapChain(devicePtr: number, index: number): SwapChainRecord | null {
    return deviceChains.get(devicePtr >>> 0)?.get(index >>> 0) ?? null;
}

export function getDeviceSwapChainCount(devicePtr: number): number {
    return deviceChains.get(devicePtr >>> 0)?.size ?? 0;
}

export function getSwapChainForSurface(surfacePtr: number): SwapChainRecord | null {
    const chainPtr = surfaceChains.get(surfacePtr >>> 0);
    return chainPtr ? getRecord(chainPtr) : null;
}

/** Reset/loss integration hook used by device.ts without knowing COM details. */
export function invalidateDeviceSwapChains(devicePtr: number): void {
    devicePresentation.get(devicePtr >>> 0)?.markLost();
}

export function resetDeviceSwapChains(devicePtr: number, params: PresentationParameters9): number {
    const key = devicePtr >>> 0;
    const state = devicePresentation.get(key);
    const implicit = deviceChains.get(key)?.get(0);
    if (!state || !implicit) return D3D_OK;

    // Reset only redeclares the implicit swap chain.  Additional chains have their
    // own D3DPRESENT_PARAMETERS and are expected to be released before Reset; in
    // particular, never silently resize their backbuffers to the primary mode.
    // D3DDevice::Reset treats zero width/height as the default focus-window mode,
    // matching createSwapChain's 800x600 fallback rather than normalize()'s 1x1
    // clamp for an already-parsed struct.
    const structural = validatePresentationParameters9(params, implicit.device.isExtended);
    if (structural !== D3D_OK) return structural;
    const next = normalizePresentationParameters9({
        ...params,
        backBufferWidth: params.backBufferWidth || 800,
        backBufferHeight: params.backBufferHeight || 600,
        backBufferFormat: params.backBufferFormat || D3DFMT_X8R8G8B8,
    });
    if (next.backBufferCount > MAX_BACK_BUFFER_COUNT) return D3DERR_INVALIDCALL;
    const count = Math.max(1, next.backBufferCount >>> 0);
    const oldBuffers = implicit.backBuffers.slice();
    const stagedBuffers: number[] = [];
    if (count > oldBuffers.length) {
        // Allocate growth against a temporary record.  createBackBuffer uses
        // only the record's identity/params and registers no chain map entry,
        // so a failed allocation can be discarded without mutating the live
        // chain or its presentation state.
        const stagedRecord: SwapChainRecord = { ...implicit, params: next, backBuffers: [] };
        while (oldBuffers.length + stagedBuffers.length < count) {
            const surfacePtr = createBackBuffer(stagedRecord);
            if (!surfacePtr) {
                for (const staged of stagedBuffers) {
                    surfaceChains.delete(staged);
                    releaseComRef(staged);
                }
                return D3DERR_INVALIDCALL;
            }
            stagedBuffers.push(surfacePtr);
        }
    }
    const stateHr = state.resetChain(implicit.index, next);
    if (stateHr !== D3D_OK) {
        for (const staged of stagedBuffers) {
            surfaceChains.delete(staged);
            releaseComRef(staged);
        }
        return stateHr;
    }

    // Commit only after all potentially-failing work above succeeded.  Drop
    // chain-owned references for excess buffers (an application's extra AddRef
    // keeps the old COM object alive, but it is no longer returned by this chain).
    const nextBuffers = oldBuffers.slice(0, Math.min(count, oldBuffers.length));
    for (const old of oldBuffers.slice(nextBuffers.length)) {
        surfaceChains.delete(old);
        releaseComRef(old);
    }
    nextBuffers.push(...stagedBuffers);
    implicit.params = next;
    implicit.backBuffers = nextBuffers;
    for (const surfacePtr of nextBuffers) {
        const meta = surfaceMeta.get(surfacePtr);
        if (meta) {
            meta.width = next.backBufferWidth;
            meta.height = next.backBufferHeight;
            meta.format = next.backBufferFormat || D3DFMT_X8R8G8B8;
            meta.multiSampleType = next.multiSampleType || D3DMULTISAMPLE_NONE;
            meta.multiSampleQuality = next.multiSampleQuality;
        }
    }
    return D3D_OK;
}

export function resetSwapChainRegistry(): void {
    records.clear();
    deviceChains.clear();
    surfaceChains.clear();
    devicePresentation.clear();
}

function swapChainQueryInterface(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const thisPtr = args[0] >>> 0;
    const riid = args[1] >>> 0;
    const ppv = args[2] >>> 0;
    if (!ppv) return E_POINTER;
    // Every failure leaves *ppvObject NULL: a caller that checks the pointer instead
    // of the HRESULT must not dispatch through whatever was there before.
    writePtr(memory, ppv, 0);
    const record = getRecord(thisPtr);
    // QI is a live-object operation — a released chain is E_NOINTERFACE, not a pointer.
    if (!record || !getComRefCount(thisPtr)) return E_NOINTERFACE;
    const key = readD3D9GuidKey(memory, riid);
    if (key !== IID_IUNKNOWN && key !== IID_IDIRECT3DSWAPCHAIN9) return E_NOINTERFACE;
    if (!writePtr(memory, ppv, record.ptr)) return E_POINTER;
    addComRef(record.ptr);
    return D3D_OK;
}

function swapChainPresent(_ctx: unknown, memory: Uint8Array, args: number[]): number | Promise<number> {
    const record = getRecord(args[0]);
    if (!record) return D3DERR_INVALIDCALL;
    const source = rectOrNull(memory, args[1]);
    const dest = rectOrNull(memory, args[2]);
    if (source === undefined || dest === undefined) return D3DERR_INVALIDCALL;
    const dirtyRects = parseDirtyRegion9(memory, args[4] >>> 0);
    if (dirtyRects === undefined) return D3DERR_INVALIDCALL;
    const request: PresentRequest9 = {
        sourceRect: source,
        destRect: dest,
        destWindow: args[3] >>> 0,
        dirtyRegion: args[4] >>> 0,
        flags: args[5] >>> 0,
        dirtyRects,
    };
    // Validate before entering the asynchronous presenter, but defer the
    // state mutation (present count/front-buffer serial) until the WebGPU
    // submission succeeds.  This mirrors device-level Present and prevents a
    // DEVICELOST result from leaving phantom presentation history behind.
    const hr = record.presentation.validatePresent(record.index, request);
    if (hr !== D3D_OK) return hr;
    return record.device.present().then((result) => {
        if (result !== D3D_OK) return result;
        const recorded = record.presentation.present(record.index, request);
        if (recorded === D3D_OK) notifyDeviceSubmission(record.devicePtr);
        return recorded;
    });
}

/** Record the device-level Present/PresentEx request against the implicit chain.
 *
 * The backend presenter owns the actual WebGPU submission, but the COM-visible
 * swap-chain state must still retain the rectangles, dirty-region pointer and
 * Ex flags.  Keeping this validation in one helper prevents base Present and
 * PresentEx from silently accepting malformed RECT pointers or diverging in
 * query-submission ordering.
 */
export function recordDevicePresent(
    devicePtr: number,
    memory: Uint8Array,
    sourcePtr: number,
    destPtr: number,
    destWindow: number,
    dirtyRegion: number,
    flags: number,
): number {
    const prepared = prepareDevicePresent(
        devicePtr, memory, sourcePtr, destPtr, destWindow, dirtyRegion, flags,
    );
    if (!prepared) return D3DERR_INVALIDCALL;
    return prepared.record.presentation.present(0, prepared.request);
}

/** Validate a device-level Present/PresentEx without mutating presentation state. */
export function validateDevicePresent(
    devicePtr: number,
    memory: Uint8Array,
    sourcePtr: number,
    destPtr: number,
    destWindow: number,
    dirtyRegion: number,
    flags: number,
): number {
    return prepareDevicePresent(
        devicePtr, memory, sourcePtr, destPtr, destWindow, dirtyRegion, flags,
    ) ? D3D_OK : D3DERR_INVALIDCALL;
}

function prepareDevicePresent(
    devicePtr: number,
    memory: Uint8Array,
    sourcePtr: number,
    destPtr: number,
    destWindow: number,
    dirtyRegion: number,
    flags: number,
): { record: SwapChainRecord; request: PresentRequest9 } | null {
    const record = getDeviceSwapChain(devicePtr >>> 0, 0);
    if (!record) return null;
    const source = rectOrNull(memory, sourcePtr >>> 0);
    const dest = rectOrNull(memory, destPtr >>> 0);
    if (source === undefined || dest === undefined) return null;
    const dirtyRects = parseDirtyRegion9(memory, dirtyRegion >>> 0);
    if (dirtyRects === undefined) return null;
    return {
        record,
        request: {
            sourceRect: source,
            destRect: dest,
            destWindow: destWindow >>> 0,
            dirtyRegion: dirtyRegion >>> 0,
            flags: flags >>> 0,
            dirtyRects,
        },
    };
}

function swapChainGetBackBuffer(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const record = getRecord(args[0]);
    const index = args[1] >>> 0;
    const type = args[2] >>> 0;
    const ppSurface = args[3] >>> 0;
    if (ppSurface && !writePtr(memory, ppSurface, 0)) return D3DERR_INVALIDCALL;
    if (!record || !ppSurface || type !== D3DBACKBUFFER_TYPE_MONO || index >= record.backBuffers.length) {
        return D3DERR_INVALIDCALL;
    }
    const surfacePtr = record.backBuffers[index]!;
    addComRef(surfacePtr);
    if (!writePtr(memory, ppSurface, surfacePtr)) {
        releaseComRef(surfacePtr);
        return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

function swapChainGetRasterStatus(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const record = getRecord(args[0]);
    const pStatus = args[1] >>> 0;
    if (!record || !pStatus) return D3DERR_INVALIDCALL;
    const status = record.presentation.getRasterStatus(record.index);
    if (!status || pStatus + 8 > memory.byteLength) return D3DERR_INVALIDCALL;
    if (!isValidAddress(memory, pStatus, 8, 'rw')) return D3DERR_INVALIDCALL;
    Mem.writeUint32(pStatus + 0, status.inVBlank ? 1 : 0);
    Mem.writeUint32(pStatus + 4, status.scanLine >>> 0);
    return D3D_OK;
}

function swapChainGetDisplayMode(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const record = getRecord(args[0]);
    const pMode = args[1] >>> 0;
    if (!record || !pMode || pMode + 16 > memory.byteLength) return D3DERR_INVALIDCALL;
    if (!isValidAddress(memory, pMode, 16, 'rw')) return D3DERR_INVALIDCALL;
    Mem.writeUint32(pMode + 0, record.params.backBufferWidth >>> 0);
    Mem.writeUint32(pMode + 4, record.params.backBufferHeight >>> 0);
    Mem.writeUint32(pMode + 8, (record.params.fullScreenRefreshRate || 60) >>> 0);
    Mem.writeUint32(pMode + 12, (record.params.backBufferFormat || D3DFMT_X8R8G8B8) >>> 0);
    return D3D_OK;
}

function swapChainGetDevice(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const record = getRecord(args[0]);
    const ppDevice = args[1] >>> 0;
    if (!record || !ppDevice) return D3DERR_INVALIDCALL;
    addComRef(record.devicePtr);
    if (!writePtr(memory, ppDevice, record.devicePtr)) {
        releaseComRef(record.devicePtr);
        return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

function swapChainGetPresentParameters(_ctx: unknown, memory: Uint8Array, args: number[]): number {
    const record = getRecord(args[0]);
    const ppParams = args[1] >>> 0;
    if (!record || !ppParams) return D3DERR_INVALIDCALL;
    return writePresentationParameters9(memory, ppParams, record.params) ? D3D_OK : D3DERR_INVALIDCALL;
}

async function copyFrontBufferToSurface(record: SwapChainRecord, destination: number): Promise<number> {
    const meta = surfaceMeta.get(destination);
    const texturePtr = meta?.texturePtr ?? 0;
    const level = meta?.level ?? 0;
    if (!meta || !texturePtr || (meta.format !== 21 && meta.format !== 22)) return D3DERR_NOTAVAILABLE;
    if (meta.width !== record.params.backBufferWidth || meta.height !== record.params.backBufferHeight) {
        return D3DERR_INVALIDCALL;
    }
    const writeRgba = (rgba: ArrayLike<number>, width: number, height: number): number => {
        if (width !== meta.width || height !== meta.height || rgba.length < width * height * 4) {
            return D3DERR_NOTAVAILABLE;
        }
        const bgra = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height * 4; i += 4) {
            bgra[i] = rgba[i + 2]!;
            bgra[i + 1] = rgba[i + 1]!;
            bgra[i + 2] = rgba[i]!;
            bgra[i + 3] = meta.format === 22 ? 0xff : rgba[i + 3]!;
        }
        return record.device.setTextureLevelPixels(texturePtr, level, bgra, width * 4)
            ? D3D_OK : D3DERR_NOTAVAILABLE;
    };
    try {
        if (typeof createImageBitmap !== 'function') {
            const raw = await record.device.readPresentedRgba();
            return raw ? writeRgba(raw.rgba, raw.width, raw.height) : D3DERR_NOTAVAILABLE;
        }
        const blob = await record.device.captureFrame();
        if (!blob || blob.size === 0) {
            const raw = await record.device.readPresentedRgba();
            return raw ? writeRgba(raw.rgba, raw.width, raw.height) : D3DERR_NOTAVAILABLE;
        }
        const bitmap = await createImageBitmap(blob);
        try {
            const canvas = new OffscreenCanvas(meta.width, meta.height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return D3DERR_NOTAVAILABLE;
            context.clearRect(0, 0, meta.width, meta.height);
            context.drawImage(bitmap, 0, 0, meta.width, meta.height);
            const rgba = context.getImageData(0, 0, meta.width, meta.height).data;
            return writeRgba(rgba, meta.width, meta.height);
        } finally {
            bitmap.close();
        }
    } catch (error) {
        Logger.warn(LogCategory.D3D9, `SwapChain::GetFrontBufferData capture failed: ${error}`);
        try {
            const raw = await record.device.readPresentedRgba();
            return raw ? writeRgba(raw.rgba, raw.width, raw.height) : D3DERR_NOTAVAILABLE;
        } catch {
            return D3DERR_NOTAVAILABLE;
        }
    }
}

/** Device-level GetFrontBufferData delegates to the implicit chain. */
export function getSwapChainFrontBufferData(devicePtr: number, destination: number): Promise<number> | number {
    const record = getDeviceSwapChain(devicePtr, 0);
    if (!record || !destination || resourceToDevice.get(destination) !== record.device) return D3DERR_INVALIDCALL;
    return copyFrontBufferToSurface(record, destination);
}

function swapChainGetFrontBufferData(_ctx: unknown, _memory: Uint8Array, args: number[]): Promise<number> | number {
    const record = getRecord(args[0]);
    const destination = args[1] >>> 0;
    if (!record || !destination || resourceToDevice.get(destination) !== record.device) return D3DERR_INVALIDCALL;
    return copyFrontBufferToSurface(record, destination);
}

export function createSwapChainExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['IDirect3DDevice9_CreateAdditionalSwapChain'] = (_ctx, memory, args) => {
        const devicePtr = args[0] >>> 0;
        const ppParams = args[1] >>> 0;
        const ppSwapChain = args[2] >>> 0;
        if (!ppSwapChain || !devices.has(devicePtr)) return D3DERR_INVALIDCALL;
        if (!writePtr(memory, ppSwapChain, 0)) return D3DERR_INVALIDCALL;
        if (!ppParams) return D3DERR_INVALIDCALL;
        const params = parsePresentationParameters9(memory, ppParams);
        if (!params) return D3DERR_INVALIDCALL;
        const validation = validateAdditionalSwapChainParameters(params, devices.get(devicePtr >>> 0));
        if (validation !== D3D_OK) return validation;
        // Index 0 is the device's IMPLICIT chain. An additional chain must never claim
        // it — its back buffers would be marked device-owned and Reset would then skip
        // app-owned surfaces in the DEFAULT-pool census.
        const chains = deviceChains.get(devicePtr);
        let index = 1;
        while (chains?.has(index)) index++;
        const record = createSwapChain(devicePtr, params, index);
        if (!record) return D3DERR_INVALIDCALL;
        if (!writePtr(memory, ppSwapChain, record.ptr)) {
            // createSwapChain owns the initial COM reference.  If the caller's
            // out pointer is invalid, roll the child back instead of leaking a
            // chain that can never be returned to the guest.
            releaseComRef(record.ptr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetSwapChain'] = (_ctx, memory, args) => {
        const devicePtr = args[0] >>> 0;
        const index = args[1] >>> 0;
        const ppSwapChain = args[2] >>> 0;
        // Initialize the out pointer before validating the index.  Additional
        // chains are first-class D3D9 children and are returned by index too.
        if (ppSwapChain) writePtr(memory, ppSwapChain, 0);
        const record = getDeviceSwapChain(devicePtr, index);
        if (!record || !ppSwapChain) return D3DERR_INVALIDCALL;
        addComRef(record.ptr);
        if (!writePtr(memory, ppSwapChain, record.ptr)) {
            releaseComRef(record.ptr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetNumberOfSwapChains'] = (_ctx, _memory, args) =>
        devices.has(args[0] >>> 0) ? getDeviceSwapChainCount(args[0] >>> 0) : 0;

    exports['IDirect3DSwapChain9_QueryInterface'] = swapChainQueryInterface;
    exports['IDirect3DSwapChain9_AddRef'] = (_ctx, _memory, args) => addComRef(args[0] >>> 0) ?? 0;
    exports['IDirect3DSwapChain9_Release'] = (_ctx, _memory, args) => releaseComRef(args[0] >>> 0) ?? 0;
    exports['IDirect3DSwapChain9_Present'] = swapChainPresent;
    exports['IDirect3DSwapChain9_GetFrontBufferData'] = swapChainGetFrontBufferData;
    exports['IDirect3DSwapChain9_GetBackBuffer'] = swapChainGetBackBuffer;
    exports['IDirect3DSwapChain9_GetRasterStatus'] = swapChainGetRasterStatus;
    exports['IDirect3DSwapChain9_GetDisplayMode'] = swapChainGetDisplayMode;
    exports['IDirect3DSwapChain9_GetDevice'] = swapChainGetDevice;
    exports['IDirect3DSwapChain9_GetPresentParameters'] = swapChainGetPresentParameters;

    return exports;
}
