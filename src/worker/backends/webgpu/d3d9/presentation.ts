/**
 * D3D9 presentation state shared by the HLE swap-chain surface and the WebGPU
 * device presenter.
 *
 * This module deliberately contains no guest-memory or COM code.  It is the
 * small, deterministic state machine behind an implicit or additional swap
 * chain: presentation parameters, present rectangles/dirty regions, raster
 * status and device-loss/reset transitions.  Keeping this state out of the
 * device hot path makes it possible to exercise the lifecycle without a real
 * WebGPU adapter.
 */

export type D3D9Rect = { left: number; top: number; right: number; bottom: number };

export type PresentationParameters9 = {
    backBufferWidth: number;
    backBufferHeight: number;
    backBufferFormat: number;
    backBufferCount: number;
    multiSampleType: number;
    multiSampleQuality: number;
    swapEffect: number;
    deviceWindow: number;
    windowed: boolean;
    enableAutoDepthStencil: boolean;
    autoDepthStencilFormat: number;
    flags: number;
    fullScreenRefreshRate: number;
    presentationInterval: number;
};

export type PresentRequest9 = {
    sourceRect: D3D9Rect | null;
    destRect: D3D9Rect | null;
    destWindow: number;
    dirtyRegion: number;
    flags: number;
    /** Decoded RGNDATA rectangles.  The raw guest pointer remains in `dirtyRegion`
     * for diagnostics/ABI tracing; this list is what a presenter can safely consume
     * after the guest memory has moved on. */
    dirtyRects?: D3D9Rect[] | null;
};

export type PresentRecord9 = PresentRequest9 & {
    serial: number;
    timestampMs: number;
    /** A null summary means the Present had no dirty-region pointer (full frame).
     *  `empty` is represented separately so a zero-rectangle RGNDATA block does
     *  not get confused with the D3D9 null-pointer/full-frame convention. */
    dirtySummary: DirtyRegionSummary9;
};

export type RasterStatus9 = { inVBlank: boolean; scanLine: number };

export const D3D9_PRESENT_PARAMETERS_SIZE = 56;
export const D3DSWAPEFFECT_DISCARD = 1;
export const D3DSWAPEFFECT_FLIP = 2;
export const D3DSWAPEFFECT_COPY = 3;
export const D3DPRESENT_INTERVAL_DEFAULT = 0;
export const D3DPRESENT_INTERVAL_ONE = 1;
export const D3DPRESENT_INTERVAL_TWO = 2;
// D3DPRESENT_INTERVAL_* is a bitmask in the native ABI (not a refresh count).
export const D3DPRESENT_INTERVAL_THREE = 0x4;
export const D3DPRESENT_INTERVAL_FOUR = 0x8;
export const D3DPRESENT_INTERVAL_IMMEDIATE = 0x80000000;
export const D3D_OK = 0;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_NOTAVAILABLE = 0x8876086a;
export const D3DERR_DEVICELOST = 0x88760868;
export const D3DERR_DEVICENOTRESET = 0x88760869;

/** D3DSWAPEFFECT_FLIPEX is available only through IDirect3D9Ex. */
export const D3DSWAPEFFECT_FLIPEX = 5;

/**
 * Validate the fields whose relationship is defined by D3D9 itself, before a
 * caller normalizes zero defaults or allocates backbuffers.  The result is an
 * HRESULT so every CreateDevice/Reset/swap-chain entry point can return the
 * same failure without duplicating the matrix.
 */
export function validatePresentationParameters9(
    params: PresentationParameters9,
    isExtended = false,
): number {
    const swapEffect = params.swapEffect >>> 0;
    const backBufferCount = params.backBufferCount >>> 0;
    const interval = params.presentationInterval >>> 0;
    const maxSwapEffect = isExtended ? D3DSWAPEFFECT_FLIPEX : D3DSWAPEFFECT_COPY;
    const maxBackBuffers = isExtended ? 30 : 3;

    if (swapEffect < D3DSWAPEFFECT_DISCARD || swapEffect > maxSwapEffect) {
        return D3DERR_INVALIDCALL;
    }
    if (!isExtended && swapEffect === D3DSWAPEFFECT_FLIPEX) {
        return D3DERR_INVALIDCALL;
    }
    if (backBufferCount > maxBackBuffers ||
        (swapEffect === D3DSWAPEFFECT_COPY && backBufferCount > 1)) {
        return D3DERR_INVALIDCALL;
    }
    // Multisampled back buffers have no defined content after Present, so D3D9
    // only allows them on a DISCARD chain; FLIP/COPY promise a readable buffer
    // this backend could not honour. FLIPEX carries its own D3D9Ex semantics.
    if ((params.multiSampleType >>> 0) !== 0 &&
        swapEffect !== D3DSWAPEFFECT_DISCARD && swapEffect !== D3DSWAPEFFECT_FLIPEX) {
        return D3DERR_INVALIDCALL;
    }
    if (!isValidPresentationInterval9(interval)) return D3DERR_INVALIDCALL;
    // Windowed presentation cannot request a refresh-count interval or a
    // fullscreen mode switch. DEFAULT, ONE, and IMMEDIATE are the only legal
    // windowed values in the D3D9 runtime.
    if (params.windowed && interval !== D3DPRESENT_INTERVAL_DEFAULT &&
        interval !== D3DPRESENT_INTERVAL_ONE && interval !== D3DPRESENT_INTERVAL_IMMEDIATE) {
        return D3DERR_INVALIDCALL;
    }
    if (!params.windowed &&
        (params.backBufferWidth === 0 || params.backBufferHeight === 0)) {
        return D3DERR_INVALIDCALL;
    }
    if (params.windowed && params.fullScreenRefreshRate !== 0) {
        return D3DERR_INVALIDCALL;
    }
    // This backend exposes one quality level per accepted sample type.
    if ((params.multiSampleQuality >>> 0) !== 0) return D3DERR_NOTAVAILABLE;
    return D3D_OK;
}

/**
 * The encoded D3DPRESENT_INTERVAL value and the number of refreshes that the
 * presenter must hold are deliberately separate.  Keeping this conversion in
 * the presentation model avoids the old `THREE === 3`/`FOUR === 4` bug and
 * makes DEFAULT's native ONE semantics explicit to callers that do not own a
 * frame pacer.
 */
export function decodePresentationInterval9(raw: number): number | null {
    switch (raw >>> 0) {
        case D3DPRESENT_INTERVAL_DEFAULT:
        case D3DPRESENT_INTERVAL_ONE:
            return 1;
        case D3DPRESENT_INTERVAL_TWO:
            return 2;
        case D3DPRESENT_INTERVAL_THREE:
            return 3;
        case D3DPRESENT_INTERVAL_FOUR:
            return 4;
        case D3DPRESENT_INTERVAL_IMMEDIATE:
            return 0;
        default:
            return null;
    }
}

/** Return whether a raw interval is one of the values D3D9 documents. */
export function isValidPresentationInterval9(raw: number): boolean {
    return decodePresentationInterval9(raw) !== null;
}

function clampU32(value: number): number {
    return (value >>> 0);
}

function readU32(view: DataView, offset: number): number {
    return view.getUint32(offset, true) >>> 0;
}

function writeU32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, clampU32(value), true);
}

function validRect(rect: D3D9Rect): boolean {
    return Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
        Number.isFinite(rect.right) && Number.isFinite(rect.bottom) &&
        rect.right > rect.left && rect.bottom > rect.top;
}

export type DirtyRegionSummary9 =
    | { kind: "full"; bounds: null; rectCount: 0 }
    | { kind: "empty"; bounds: null; rectCount: 0 }
    | { kind: "rects"; bounds: D3D9Rect; rectCount: number };

/**
 * Summarise an already-decoded Present RGNDATA block without losing the
 * distinction between a null pointer (the complete source) and a valid empty
 * region.  The bounds are useful to a future partial-present compositor, while
 * retaining the original rectangles keeps the ABI/debug record lossless.
 */
export function summarizeDirtyRegion9(rects: D3D9Rect[] | null): DirtyRegionSummary9 {
    if (rects === null) return { kind: "full", bounds: null, rectCount: 0 };
    if (rects.length === 0) return { kind: "empty", bounds: null, rectCount: 0 };
    let left = rects[0]!.left;
    let top = rects[0]!.top;
    let right = rects[0]!.right;
    let bottom = rects[0]!.bottom;
    for (const rect of rects) {
        if (!validRect(rect)) {
            // The parser rejects malformed data before this helper is called;
            // this guard keeps direct callers deterministic rather than
            // producing NaN bounds from an untrusted helper input.
            return { kind: "empty", bounds: null, rectCount: 0 };
        }
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
    }
    return { kind: "rects", bounds: { left, top, right, bottom }, rectCount: rects.length };
}

function cloneDirtyRegionSummary9(summary: DirtyRegionSummary9): DirtyRegionSummary9 {
    if (summary.kind === "rects") {
        return { kind: "rects", rectCount: summary.rectCount, bounds: { ...summary.bounds } };
    }
    return summary.kind === "full"
        ? { kind: "full", bounds: null, rectCount: 0 }
        : { kind: "empty", bounds: null, rectCount: 0 };
}

/** Windows GAMMARAMP payload: 256 WORDs for each of red, green and blue. */
export const D3D9_GAMMA_RAMP_BYTES = 256 * 2 * 3;
export type GammaRamp9 = {
    red: Uint16Array;
    green: Uint16Array;
    blue: Uint16Array;
};

/** Decode a GAMMARAMP with exact WORD preservation for Get/Set round-trips. */
export function parseGammaRamp9(memory: Uint8Array, ptr: number): GammaRamp9 | null {
    const address = ptr >>> 0;
    if (!address || address + D3D9_GAMMA_RAMP_BYTES > memory.byteLength) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const red = new Uint16Array(256);
    const green = new Uint16Array(256);
    const blue = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        red[i] = view.getUint16(address + i * 2, true);
        green[i] = view.getUint16(address + 512 + i * 2, true);
        blue[i] = view.getUint16(address + 1024 + i * 2, true);
    }
    return { red, green, blue };
}

/** Write a GAMMARAMP and reject malformed channel lengths atomically. */
export function writeGammaRamp9(memory: Uint8Array, ptr: number, ramp: GammaRamp9): boolean {
    const address = ptr >>> 0;
    if (!address || address + D3D9_GAMMA_RAMP_BYTES > memory.byteLength ||
        ramp.red.length !== 256 || ramp.green.length !== 256 || ramp.blue.length !== 256) {
        return false;
    }
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    for (let i = 0; i < 256; i++) {
        view.setUint16(address + i * 2, ramp.red[i]!, true);
        view.setUint16(address + 512 + i * 2, ramp.green[i]!, true);
        view.setUint16(address + 1024 + i * 2, ramp.blue[i]!, true);
    }
    return true;
}

export function isIdentityGammaRamp9(ramp: GammaRamp9): boolean {
    if (ramp.red.length !== 256 || ramp.green.length !== 256 || ramp.blue.length !== 256) return false;
    for (let i = 0; i < 256; i++) {
        const identity = i * 257;
        if (ramp.red[i] !== identity || ramp.green[i] !== identity || ramp.blue[i] !== identity) {
            return false;
        }
    }
    return true;
}

export function parsePresentationParameters9(memory: Uint8Array, ptr: number): PresentationParameters9 | null {
    const address = ptr >>> 0;
    if (!address || address + D3D9_PRESENT_PARAMETERS_SIZE > memory.byteLength) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    return {
        backBufferWidth: readU32(view, address + 0),
        backBufferHeight: readU32(view, address + 4),
        backBufferFormat: readU32(view, address + 8),
        backBufferCount: readU32(view, address + 12),
        multiSampleType: readU32(view, address + 16),
        multiSampleQuality: readU32(view, address + 20),
        swapEffect: readU32(view, address + 24),
        deviceWindow: readU32(view, address + 28),
        windowed: readU32(view, address + 32) !== 0,
        enableAutoDepthStencil: readU32(view, address + 36) !== 0,
        autoDepthStencilFormat: readU32(view, address + 40),
        flags: readU32(view, address + 44),
        fullScreenRefreshRate: readU32(view, address + 48),
        presentationInterval: readU32(view, address + 52),
    };
}

export function writePresentationParameters9(
    memory: Uint8Array,
    ptr: number,
    params: PresentationParameters9,
): boolean {
    const address = ptr >>> 0;
    if (!address || address + D3D9_PRESENT_PARAMETERS_SIZE > memory.byteLength) return false;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    writeU32(view, address + 0, params.backBufferWidth);
    writeU32(view, address + 4, params.backBufferHeight);
    writeU32(view, address + 8, params.backBufferFormat);
    writeU32(view, address + 12, params.backBufferCount);
    writeU32(view, address + 16, params.multiSampleType);
    writeU32(view, address + 20, params.multiSampleQuality);
    writeU32(view, address + 24, params.swapEffect);
    writeU32(view, address + 28, params.deviceWindow);
    writeU32(view, address + 32, params.windowed ? 1 : 0);
    writeU32(view, address + 36, params.enableAutoDepthStencil ? 1 : 0);
    writeU32(view, address + 40, params.autoDepthStencilFormat);
    writeU32(view, address + 44, params.flags);
    writeU32(view, address + 48, params.fullScreenRefreshRate);
    writeU32(view, address + 52, params.presentationInterval);
    return true;
}

export function parseRect9(memory: Uint8Array, ptr: number): D3D9Rect | null {
    const address = ptr >>> 0;
    if (!address || address + 16 > memory.byteLength) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const rect = {
        left: view.getInt32(address + 0, true),
        top: view.getInt32(address + 4, true),
        right: view.getInt32(address + 8, true),
        bottom: view.getInt32(address + 12, true),
    };
    return validRect(rect) ? rect : null;
}

/**
 * Decode the RECT list carried by the `RGNDATA` dirty-region argument to Present.
 *
 * D3D9 passes a pointer to `RGNDATA`, not a pointer to one RECT.  A null pointer
 * means "the whole source" and is therefore represented by `null`; a non-null but
 * malformed block returns `undefined` so callers can report D3DERR_INVALIDCALL
 * instead of silently presenting stale pixels.  The parser is deliberately bounded
 * by the guest allocation and by a sane rectangle count to keep an untrusted guest
 * pointer from causing an unbounded loop.
 */
export function parseDirtyRegion9(memory: Uint8Array, ptr: number): D3D9Rect[] | null | undefined {
    const address = ptr >>> 0;
    if (!address) return null;
    if (address + 32 > memory.byteLength) return undefined;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const headerSize = view.getUint32(address + 0, true) >>> 0;
    const type = view.getUint32(address + 4, true) >>> 0;
    const count = view.getUint32(address + 8, true) >>> 0;
    const regionBytes = view.getUint32(address + 12, true) >>> 0;
    // RDH_RECTANGLES is the only region encoding D3D9 documents for Present.
    if (headerSize < 32 || type !== 1 || count > 1_000_000 || regionBytes < count * 16) {
        return undefined;
    }
    const bytes = count * 16;
    // RGNDATA permits an extended header. RECT data starts after cbHeader, not
    // necessarily after the canonical 32-byte RGNDATAHEADER.
    if (address + headerSize > memory.byteLength || address + headerSize + bytes > memory.byteLength) {
        return undefined;
    }
    const rects: D3D9Rect[] = [];
    for (let i = 0; i < count; i++) {
        const base = address + headerSize + i * 16;
        const rect = {
            left: view.getInt32(base + 0, true),
            top: view.getInt32(base + 4, true),
            right: view.getInt32(base + 8, true),
            bottom: view.getInt32(base + 12, true),
        };
        if (!validRect(rect)) return undefined;
        rects.push(rect);
    }
    return rects;
}

export function normalizePresentationParameters9(params: PresentationParameters9): PresentationParameters9 {
    return {
        ...params,
        backBufferWidth: Math.max(1, params.backBufferWidth >>> 0),
        backBufferHeight: Math.max(1, params.backBufferHeight >>> 0),
        backBufferCount: Math.max(1, params.backBufferCount >>> 0),
        swapEffect: params.swapEffect >>> 0,
        presentationInterval: params.presentationInterval >>> 0,
    };
}

export function defaultPresentationParameters9(): PresentationParameters9 {
    return {
        backBufferWidth: 800,
        backBufferHeight: 600,
        backBufferFormat: 22, // D3DFMT_X8R8G8B8
        backBufferCount: 1,
        multiSampleType: 0,
        multiSampleQuality: 0,
        swapEffect: D3DSWAPEFFECT_DISCARD,
        deviceWindow: 0,
        windowed: true,
        enableAutoDepthStencil: false,
        autoDepthStencilFormat: 0,
        flags: 0,
        fullScreenRefreshRate: 0,
        presentationInterval: D3DPRESENT_INTERVAL_DEFAULT,
    };
}

export type PresentationChainState = {
    index: number;
    params: PresentationParameters9;
    lost: boolean;
    generation: number;
    presents: number;
    /** Native interval decoded to refreshes; DEFAULT is one, IMMEDIATE is zero. */
    intervalRefreshes: number;
    /** The scan-out/front-buffer image exists only after a successful Present. */
    frontBufferValid: boolean;
    frontBufferSerial: number;
    lastPresent: PresentRecord9 | null;
};

/** Pure presentation/lifecycle state for one D3D9 device. */
export class D3D9PresentationState {
    private readonly chains = new Map<number, PresentationChainState>();
    private serial = 0;

    createChain(index: number, params: PresentationParameters9): PresentationChainState {
        const state: PresentationChainState = {
            index: index >>> 0,
            params: normalizePresentationParameters9(params),
            lost: false,
            generation: 1,
            presents: 0,
            intervalRefreshes: decodePresentationInterval9(params.presentationInterval) ?? 1,
            frontBufferValid: false,
            frontBufferSerial: 0,
            lastPresent: null,
        };
        this.chains.set(state.index, state);
        return state;
    }

    getChain(index: number): PresentationChainState | null {
        return this.chains.get(index >>> 0) ?? null;
    }

    getChainCount(): number {
        return this.chains.size;
    }

    destroyChain(index: number): boolean {
        return this.chains.delete(index >>> 0);
    }

    markLost(): void {
        for (const chain of this.chains.values()) {
            chain.lost = true;
            chain.frontBufferValid = false;
        }
    }

    markDeviceReady(): void {
        for (const chain of this.chains.values()) chain.lost = false;
    }

    testCooperativeLevel(): number {
        for (const chain of this.chains.values()) if (chain.lost) return D3DERR_DEVICELOST;
        return 0;
    }

    /**
     * Reset one chain without touching additional chains.  IDirect3DDevice9::Reset
     * redeclares the implicit chain; additional chains have their own presentation
     * parameters and are expected to be released by the caller before Reset.  Keep
     * this narrow primitive separate from reset(), whose all-chain behavior remains
     * useful for the standalone state-machine contract.
     */
    resetChain(index: number, params: PresentationParameters9): number {
        const chain = this.getChain(index);
        if (!chain) return D3DERR_INVALIDCALL;
        chain.params = normalizePresentationParameters9(params);
        chain.lost = false;
        chain.generation = (chain.generation + 1) >>> 0;
        chain.intervalRefreshes = decodePresentationInterval9(chain.params.presentationInterval) ?? 1;
        chain.frontBufferValid = false;
        // Keep the serial monotonic across Reset; generation/frontBufferValid
        // already distinguish the invalidated image from a newly presented one.
        chain.lastPresent = null;
        return 0;
    }

    reset(params: PresentationParameters9): number {
        for (const chain of this.chains.values()) this.resetChain(chain.index, params);
        return 0;
    }

    /**
     * Validate a Present request without changing presentation history.  The
     * module-level swap-chain thunk uses this before awaiting the asynchronous
     * WebGPU submission so a device-lost result cannot leave a phantom
     * front-buffer serial/present count behind.
     */
    validatePresent(index: number, request: PresentRequest9): number {
        const chain = this.getChain(index);
        if (!chain) return D3DERR_INVALIDCALL;
        if (chain.lost) return D3DERR_DEVICELOST;
        if (request.sourceRect && !validRect(request.sourceRect)) return D3DERR_INVALIDCALL;
        if (request.destRect && !validRect(request.destRect)) return D3DERR_INVALIDCALL;
        // Present source/destination rectangles are defined only for a COPY chain;
        // every other swap effect presents the whole back buffer, so honouring a
        // rectangle there would invent a scaling contract the chain never had.
        if ((request.sourceRect || request.destRect) &&
            (chain.params.swapEffect >>> 0) !== D3DSWAPEFFECT_COPY) return D3DERR_INVALIDCALL;
        if (request.dirtyRects?.some((rect) => !validRect(rect))) return D3DERR_INVALIDCALL;
        return D3D_OK;
    }

    present(index: number, request: PresentRequest9, nowMs = performance.now()): number {
        const chain = this.getChain(index);
        const validation = this.validatePresent(index, request);
        if (validation !== D3D_OK || !chain) return validation;
        const dirtySummary = summarizeDirtyRegion9(request.dirtyRects ?? null);
        chain.presents++;
        chain.frontBufferValid = true;
        chain.frontBufferSerial = this.serial + 1;
        chain.lastPresent = {
            ...request,
            dirtyRects: request.dirtyRects ? request.dirtyRects.map((rect) => ({ ...rect })) : request.dirtyRects,
            serial: ++this.serial,
            timestampMs: nowMs,
            dirtySummary,
        };
        return 0;
    }

    /** Whether GetFrontBufferData has a valid scan-out image to capture. */
    canCaptureFrontBuffer(index: number): boolean {
        const chain = this.getChain(index);
        return !!chain && !chain.lost && chain.frontBufferValid;
    }

    /** Monotonic front-buffer serial for a capture/cache key. */
    getFrontBufferSerial(index: number): number {
        return this.getChain(index)?.frontBufferSerial ?? 0;
    }

    getRasterStatus(index: number, nowMs = performance.now()): RasterStatus9 | null {
        const chain = this.getChain(index);
        if (!chain) return null;
        const height = Math.max(1, chain.params.backBufferHeight);
        const refresh = Math.max(1, chain.params.fullScreenRefreshRate || 60);
        const period = 1000 / refresh;
        const phase = ((nowMs % period) + period) % period / period;
        const visibleLines = height;
        const totalLines = visibleLines + 45;
        const line = Math.min(totalLines - 1, Math.floor(phase * totalLines));
        return { inVBlank: line >= visibleLines, scanLine: line >= visibleLines ? 0 : line };
    }

    snapshot(): PresentationChainState[] {
        return [...this.chains.values()].map((chain) => ({
            ...chain,
            params: { ...chain.params },
            lastPresent: chain.lastPresent ? {
                ...chain.lastPresent,
                dirtySummary: cloneDirtyRegionSummary9(chain.lastPresent.dirtySummary),
                dirtyRects: chain.lastPresent.dirtyRects
                    ? chain.lastPresent.dirtyRects.map((rect) => ({ ...rect }))
                    : chain.lastPresent.dirtyRects,
            } : null,
        }));
    }
}
