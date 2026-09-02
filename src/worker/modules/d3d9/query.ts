/**
 * IDirect3DQuery9 — asynchronous query objects.
 *
 * The API/state machine covers the DXVK-supported query families (EVENT, OCCLUSION,
 * VCACHE and timestamp/frequency/disjoint). VERTEXSTATS is intentionally not advertised,
 * matching DXVK's QuerySupported contract rather than returning a fabricated structure. The current host path stores
 * deterministic CPU completion records when the adapter cannot provide query sets. A live
 * WebGPU device hands OCCLUSION and timestamp records to the query manager and GetData
 * observes its asynchronous resolve/readback result instead.
 *
 * OCCLUSION retains a draw-aware CPU fallback only for adapter-free unit/integration hosts.
 * Once a live device has a query manager but allocation fails, GetData returns an explicit
 * NOTAVAILABLE rather than manufacturing a viewport-sized sample count. The interval
 * bookkeeping still makes nested and multiple adapter-free queries deterministic, while the
 * GPU path records the same boundaries in the active render pass.
 *
 * EVENT completion is deterministic, but GetData still waits for the submission serial
 * carrying its END. Present is an async thunk:
 * the guest thread is parked inside D3D9Device.present(), which awaits an rAF permit
 * from the frame pacer and only then submits the frame. The guest can therefore never
 * be more than the still-recording frame ahead of the GPU — the flip queue an event
 * query exists to drain has depth 1 and is already drained at every point the guest
 * can ask. Wiring GetData to queue.onSubmittedWorkDone() would not measure the GPU:
 * GetData is a SYNCHRONOUS thunk polled in a guest spin loop, so a promise-backed
 * answer could only flip across a worker event-loop turn, and the S_FALSE window
 * would report OUR JS scheduling latency under a GPU-fence label. It would also fence
 * the wrong point — commands batch until Present, so a mid-frame Issue has nothing of
 * its own submitted yet. The serial seam below therefore returns S_FALSE until
 * the presentation boundary submits the batch containing the END marker, without
 * pretending that JS scheduling latency is a GPU fence.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import {
    addComRef,
    createComObject,
    devices,
    getVTables,
    registerDeviceChildFinalizer,
    releaseComRef,
} from './shared-state';
import { initReturnPtr } from '../../backends/webgpu/shared/dx-com-helpers';
import { IID_IUNKNOWN, readD3D9GuidKey } from './object-contracts';
import type { D3D9QueryManager } from './query-manager';
import { deviceCooperativeLevel } from '../../core/gpu/gpu-device-loss-contract';

const D3D_OK = 0;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_DEVICELOST = 0x88760868;
const S_FALSE = 1;

const D3DQUERYTYPE_EVENT = 8;
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DQUERYTYPE_VCACHE = 4;
const D3DQUERYTYPE_TIMESTAMP = 10;
const D3DQUERYTYPE_TIMESTAMPDISJOINT = 11;
const D3DQUERYTYPE_TIMESTAMPFREQ = 12;
/** GetData(dwGetDataFlags): flush the command buffer so the fenced work can retire. */
const D3DGETDATA_FLUSH = 1 << 0;
const D3DISSUE_BEGIN = 1 << 1;

/** IID_IDirect3DQuery9 {D9771460-A695-4F26-BBD3-27B840B541CC} as raw guest bytes. */
const IID_IDIRECT3DQUERY9 = '601477d995a6264fbbd327b840b541cc';

/**
 * GetDataSize per SUPPORTED type — this table IS the support set, so a type absent
 * from it is the one CreateQuery reports as D3DERR_NOTAVAILABLE.
 */
const QUERY_DATA_SIZE: Record<number, number> = {
    [D3DQUERYTYPE_VCACHE]: 16,
    [D3DQUERYTYPE_EVENT]: 4,      // sizeof(BOOL)
    [D3DQUERYTYPE_OCCLUSION]: 4,  // sizeof(DWORD) — visible pixel count
    [D3DQUERYTYPE_TIMESTAMP]: 8,
    // D3DDEVINFO_TIMESTAMPDISJOINT is a BOOL in DXVK/D3D9, not a frequency-plus-padding
    // structure. The timestamp frequency is queried separately with TIMESTAMPFREQ.
    [D3DQUERYTYPE_TIMESTAMPDISJOINT]: 4,
    [D3DQUERYTYPE_TIMESTAMPFREQ]: 8,
};

type QueryRecord = {
    type: number;
    devicePtr: number;
    dataSize: number;
    /** A BEGIN was issued and its matching END has not arrived yet. */
    begun: boolean;
    /** An END has been issued. Drives the DATA GetData writes, never its HRESULT. */
    issued: boolean;
    /** Monotonic host timestamp represented in D3D's 1 GHz tick domain. */
    issueTime: bigint;
    /** Submission serial at which END becomes observable to GetData. */
    issueSerial: number;
    /** OCCLUSION BEGIN/END draw interval. Each query owns its own baseline, so nested
     * queries do not steal or overwrite one another's state. */
    occlusionBeginDraws: number | null;
    occlusionEndDraws: number | null;
    /** Timestamp-disjoint interval bookkeeping. */
    disjointBeginTime: bigint | null;
    disjointEndTime: bigint | null;
    /** An END was issued whose result nobody has observed yet. Drives the `missing`
     *  ledger counter: a query that dies in this state was measured for nothing. */
    awaitingResult: boolean;
    /** Device loss is counted once per query, not once per poll. */
    lostNoted: boolean;
    /** Real WebGPU query-set path when the owning device has a live adapter. */
    gpuManager?: D3D9QueryManager;
    gpuMode: boolean;
};

/**
 * Query lifecycle ledger. A query that stops resolving is otherwise INVISIBLE: GetData
 * keeps answering S_FALSE (or the viewport upper bound) and the app culls against a
 * number that was never measured, with no error, no dropped draw and no log line.
 *
 * `missing` and `error` are what make this able to fail; `measured` vs `synthesized` says
 * which arm produced the counts a checksum was taken over.
 */
export interface D3D9QueryLedger {
    /** CreateQuery handed out a query object. */
    created: number;
    /** Issue(BEGIN) accepted on a beginnable query. */
    begin: number;
    /** An END record was completed (explicit, implicit or via GetData). */
    end: number;
    /** GetData answered with data. */
    ready: number;
    /** GetData answered S_FALSE — the fast path and the thunk count into the same field. */
    pending: number;
    /** GetData/Issue answered D3DERR_NOTAVAILABLE. */
    notAvailable: number;
    /** A re-arm that could not reserve a generation, or a failed data write. */
    error: number;
    /** An issued interval that was released/destroyed/re-armed before it ever resolved. */
    missing: number;
    /** A COM pointer recycled while its previous query record was still live. */
    lostOnRecycle: number;
    /** Queries whose result was abandoned to device loss (counted once each). */
    lostOnDeviceLoss: number;
    /** Occlusion answers passed through from a backend that really counts samples. */
    measured: number;
    /** Occlusion answers synthesized as the viewport-area upper bound (see below). */
    synthesized: number;
}

const ledger: D3D9QueryLedger = {
    created: 0, begin: 0, end: 0, ready: 0, pending: 0, notAvailable: 0,
    error: 0, missing: 0, lostOnRecycle: 0, lostOnDeviceLoss: 0,
    measured: 0, synthesized: 0,
};

export function getD3D9QueryLedger(): D3D9QueryLedger {
    return { ...ledger };
}

export function resetD3D9QueryLedger(): void {
    for (const key in ledger) (ledger as unknown as Record<string, number>)[key] = 0;
}

/** An interval that never resolved is a lost measurement wherever it is retired. */
function noteRetired(query: QueryRecord): void {
    if (query.awaitingResult) {
        query.awaitingResult = false;
        ledger.missing++;
    }
}

const queries: Map<number, QueryRecord> = new Map();
/** Adapter-free fallback serials. A live query manager owns the only submission domain for
 * that device; this map is intentionally never consulted once a manager is attached. */
const deviceSubmissionSerial = new Map<number, number>();

/** Called by the device presentation boundary after its command buffer is submitted. */
export function notifyDeviceSubmission(devicePtr: number): void {
    const key = devicePtr >>> 0;
    // The live executor advances the manager serial for every queue.submit, including helper
    // submits and query-free frames. Present is only a guest API boundary and must not create
    // a second, present-only domain that can satisfy a query early or late.
    let hasQueryForDevice = false;
    let hasManagerlessQuery = false;
    for (const query of queries.values()) {
        if (query.devicePtr !== key) continue;
        hasQueryForDevice = true;
        if (!hasManagerSubmissionDomain(query.gpuManager)) hasManagerlessQuery = true;
    }
    if (!hasManagerlessQuery && hasQueryForDevice) return;
    deviceSubmissionSerial.set(key, (deviceSubmissionSerial.get(key) ?? 0) + 1);
}

/** Reset submission/query state when a D3D9 process is torn down or a device pointer is
 * recycled. Kept in this module so the device lifecycle has one explicit seam to call. */
export function resetQueryState(): void {
    for (const query of queries.values()) noteRetired(query);
    queries.clear();
    deviceSubmissionSerial.clear();
}

function nowD3dTicks(): bigint {
    // performance.now() is monotonic and available in the worker. Rounding before the
    // bigint conversion keeps the advertised frequency (1 GHz) exact without carrying
    // floating-point noise into timestamp ordering.
    return BigInt(Math.max(0, Math.round(performance.now() * 1_000_000)));
}

function deviceDrawCount(devicePtr: number): number {
    const device = devices.get(devicePtr) as unknown as {
        getDrawCount?: () => number;
    } | undefined;
    const count = device?.getDrawCount?.();
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count!)) : 0;
}

type QueryDeviceHooks = {
    getQueryManager?: () => D3D9QueryManager | null;
    recordQueryBegin?: (queryPtr: number) => void;
    recordQueryEnd?: (queryPtr: number) => void;
    recordQueryTimestamp?: (queryPtr: number) => void;
};

function queryDeviceHooks(devicePtr: number): QueryDeviceHooks | undefined {
    return devices.get(devicePtr) as unknown as QueryDeviceHooks | undefined;
}

function hasManagerSubmissionDomain(manager: D3D9QueryManager | undefined): boolean {
    return typeof (manager as unknown as { notifySubmitted?: unknown } | undefined)?.notifySubmitted === 'function';
}

function managerNeedsRebegin(manager: D3D9QueryManager | undefined, id: number): boolean {
    const hook = manager as unknown as { needsRebegin?: (queryId: number) => boolean } | undefined;
    return typeof hook?.needsRebegin === 'function' && hook.needsRebegin(id);
}

/**
 * WebGPU's occlusion result is a PREDICATE; D3D9's is a visible-PIXEL COUNT.
 *
 * `GPUQueryType "occlusion"` only reports whether any fragment sample passed, and Dawn
 * answers 1. D3D9 apps do not read that as a boolean: CryEngine's hardware occlusion culling
 * compares the count against a coverage threshold, so a constant 1 reads as "one pixel of
 * this object is visible" and the object is culled — large distant geometry vanishes.
 *
 * A non-zero predicate is therefore converted to the only count we can stand behind: an
 * UPPER bound, the viewport's pixel area. The two ways to be wrong are not symmetric —
 * over-reporting draws something the app would have culled (a little wasted fill), while
 * under-reporting deletes geometry and warns nobody. A backend that does return a real
 * sample count (> 1) is trusted and passes through untouched.
 */
function occlusionPixelsFromGpu(query: QueryRecord, raw: bigint): number {
    // The ledger distinguishes the two arms because they are indistinguishable downstream:
    // both answer a plausible pixel count and only one of them was measured.
    if (raw <= 0n) { ledger.measured++; return 0; }
    const override = (globalThis as { __occlusionPixels?: unknown }).__occlusionPixels;
    if (typeof override === 'number') { ledger.synthesized++; return override >>> 0; }
    if (raw > 1n) { ledger.measured++; return Number(raw & 0xffff_ffffn) >>> 0; }
    ledger.synthesized++;
    const vp = devices.get(query.devicePtr)?.getViewport?.();
    const pixels = vp ? (vp.width >>> 0) * (vp.height >>> 0) : 0;
    return pixels > 0 ? pixels >>> 0 : 1;
}

/**
 * The DATA a completed query reports. EVENT is a BOOL (see the file header). OCCLUSION's
 * adapter-free test seam retains a conservative answer; live devices never reach this helper
 * when their query manager cannot produce a measured value.
 */
function issuedQueryValue(query: QueryRecord): number {
    if (query.type === D3DQUERYTYPE_EVENT) return 1;
    if (query.type === D3DQUERYTYPE_TIMESTAMP) return Number(query.issueTime & 0xffff_ffffn) >>> 0;
    if (query.type === D3DQUERYTYPE_TIMESTAMPFREQ) return 1_000_000_000;
    if (query.type === D3DQUERYTYPE_TIMESTAMPDISJOINT) {
        const begin = query.disjointBeginTime;
        const end = query.disjointEndTime;
        // A monotonic host clock cannot report a disjoint interval. This is an explicit
        // deterministic fallback; a native timestamp-period/disjoint contract is still
        // required before advertising hardware-frequency parity.
        return begin !== null && end !== null && end < begin ? 1 : 0;
    }
    if (query.type !== D3DQUERYTYPE_OCCLUSION) return 1;
    // Which constant is the SAFE one depends on how the caller uses the count, and the two
    // uses want opposite answers. A zero-draw interval, however, is unambiguously zero and
    // is important for visibility systems that issue a query around an empty batch.
    const begin = query.occlusionBeginDraws;
    const end = query.occlusionEndDraws;
    if (begin !== null && end !== null && end <= begin) return 0;
    // `__occlusionPixels` remains a useful diagnostic override for live A/B runs, but only
    // after the semantically exact zero-draw case above.
    const override = (globalThis as { __occlusionPixels?: unknown }).__occlusionPixels;
    if (typeof override === 'number') return override >>> 0;
    const vp = devices.get(query.devicePtr)?.getViewport?.();
    const pixels = vp ? (vp.width >>> 0) * (vp.height >>> 0) : 0;
    return pixels > 0 ? pixels >>> 0 : 1;
}

/**
 * D3DDEVINFO_VCACHE is a fixed 16-byte payload, not a cache-size DWORD.  DXVK
 * exposes the conventional CACH/1/16/7 values even though no WebGPU query set
 * backs this information query.  Keep the write byte-oriented so short buffers
 * retain the D3D9 prefix-copy behaviour without touching bytes past dwSize.
 */
function writeQueryVCache(pData: number, count: number): boolean {
    if (!isValidAddress(pData, count, 'rw')) return false;
    const bytes = [
        0x43, 0x41, 0x43, 0x48, // MAKEFOURCC('C', 'A', 'C', 'H')
        0x01, 0x00, 0x00, 0x00, // OptMethod
        0x10, 0x00, 0x00, 0x00, // CacheSize
        0x07, 0x00, 0x00, 0x00, // MagicNumber
    ];
    for (let i = 0; i < count; i++) {
        if (!Mem.writeUint8(pData + i, bytes[i]!)) return false;
    }
    return true;
}

/**
 * The one GetData answer that costs nothing: an issued, not-begun query whose END has not
 * reached the observed submission serial yet is S_FALSE with no side effect, which is the
 * turn the guest's poll loop repeats until the presentation boundary submits.
 *
 * Every other shape — implicit END, a FLUSH request, device loss, a GPU-backed poll, or an
 * observable END — returns null so the caller falls back to the full thunk BEFORE anything
 * is touched. The decision lives here because this module owns the query state machine.
 */
export function tryFastGetData(queryPtr: number, pData: number, size: number, flags: number): number | null {
    const query = queries.get(queryPtr >>> 0);
    if (!query) return null;
    if (query.begun || !query.issued) return null;
    if ((flags & D3DGETDATA_FLUSH) !== 0) return null;
    if (!pData && size) return null;
    if (query.gpuManager?.isDeviceLost?.()) return null;
    if (deviceCooperativeLevel(query.devicePtr) !== 'ok') return null;
    const observedSerial = hasManagerSubmissionDomain(query.gpuManager)
        ? query.gpuManager!.getSubmittedSerial()
        : (deviceSubmissionSerial.get(query.devicePtr) ?? 0);
    if (query.issueSerial > observedSerial) {
        // Same counter the thunk's S_FALSE uses: a fast path that skips the ledger makes
        // the poll census disagree with the work it stands for.
        ledger.pending++;
        return S_FALSE;
    }
    return null;
}

function queryCanBegin(type: number): boolean {
    return type === D3DQUERYTYPE_OCCLUSION || type === D3DQUERYTYPE_TIMESTAMPDISJOINT;
}

/** Only query families backed by submitted GPU work have an observable serial fence.
 * DXVK's VCACHE and TIMESTAMPFREQ are static information queries: Issue(END) changes
 * state, but does not enqueue work and GetData may return immediately. */
function queryNeedsSubmission(type: number): boolean {
    return type === D3DQUERYTYPE_EVENT
        || type === D3DQUERYTYPE_OCCLUSION
        || type === D3DQUERYTYPE_TIMESTAMP
        || type === D3DQUERYTYPE_TIMESTAMPDISJOINT;
}

/** Complete the D3D9-side END record. GPU-backed queries use the same serial as the
 * manager; adapter-free records retain the deterministic fallback ordering. */
function completeQueryEnd(query: QueryRecord): void {
    const hadOpenInterval = query.begun;
    query.begun = false;
    query.issued = true;
    ledger.end++;
    query.awaitingResult = true;
    query.lostNoted = false;
    query.issueTime = nowD3dTicks();
    // A live query manager observes every command-buffer submission, including
    // non-present flushes. Use that same domain for the query's fence; mixing it
    // with the present-only counter makes a mid-frame submission satisfy a later
    // query before its END is actually encoded.
    const managerSerial = hasManagerSubmissionDomain(query.gpuManager)
        ? query.gpuManager!.getSubmittedSerial() : undefined;
    const currentSerial = managerSerial ?? (deviceSubmissionSerial.get(query.devicePtr) ?? 0);
    query.issueSerial = queryNeedsSubmission(query.type) ? currentSerial + 1 : currentSerial;
    if (query.type === D3DQUERYTYPE_OCCLUSION) {
        // An END without BEGIN is retained as a zero-width interval rather than
        // falling back to a viewport-sized answer. Reusing a completed query with
        // END starts a fresh implicit interval, matching DXVK's QueryEndable path.
        if (!hadOpenInterval) query.occlusionBeginDraws = deviceDrawCount(query.devicePtr);
        query.occlusionEndDraws = deviceDrawCount(query.devicePtr);
        if (query.occlusionBeginDraws === null) query.occlusionBeginDraws = query.occlusionEndDraws;
    }
    if (query.type === D3DQUERYTYPE_TIMESTAMPDISJOINT) {
        if (!hadOpenInterval) query.disjointBeginTime = query.issueTime;
        query.disjointEndTime = query.issueTime;
        if (query.disjointBeginTime === null) query.disjointBeginTime = query.issueTime;
    }
}

function writeQueryUint64(pData: number, count: number, value: bigint): boolean {
    if (!isValidAddress(pData, count, 'rw')) return false;
    const low = Number(value & 0xffff_ffffn) >>> 0;
    const high = Number((value >> 32n) & 0xffff_ffffn) >>> 0;
    const bytes = [
        low & 0xff, (low >>> 8) & 0xff, (low >>> 16) & 0xff, (low >>> 24) & 0xff,
        high & 0xff, (high >>> 8) & 0xff, (high >>> 16) & 0xff, (high >>> 24) & 0xff,
    ];
    for (let i = 0; i < count; i++) {
        if (!Mem.writeUint8(pData + i, bytes[i]!)) return false;
    }
    return true;
}

/** Writes the low `count` bytes of a DWORD, so a caller's short buffer is not overrun. */
function writeQueryData(pData: number, count: number, value: number): boolean {
    if (!isValidAddress(pData, count, 'rw')) return false;
    for (let i = 0; i < count; i++) {
        if (!Mem.writeUint8(pData + i, (value >>> (i * 8)) & 0xff)) return false;
    }
    return true;
}

/**
 * One place decides what a GetData answer MEANS for the ledger, so the counters cannot
 * drift from the HRESULTs the guest actually saw. DEVICELOST is counted at the loss
 * branch instead — once per abandoned interval rather than once per poll.
 */
function noteGetData(queryPtr: number, hr: number): number {
    const query = queries.get(queryPtr);
    if (hr === S_FALSE) {
        ledger.pending++;
    } else if (hr === D3D_OK) {
        ledger.ready++;
        if (query) query.awaitingResult = false;
    } else if (hr === D3DERR_NOTAVAILABLE) {
        ledger.notAvailable++;
        if (query) query.awaitingResult = false;
    } else if (hr !== D3DERR_DEVICELOST) {
        ledger.error++;
    }
    return hr;
}

export function createQueryExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    /**
     * CreateQuery(Type, ppQuery). A NULL ppQuery is the SUPPORT PROBE — engines ask
     * "do you have this query type?" and expect D3D_OK / D3DERR_NOTAVAILABLE with
     * nothing created.
     */
    exports['IDirect3DDevice9_CreateQuery'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const type = args[1] >>> 0;
        const ppQuery = args[2] >>> 0;

        if (!devices.has(pDevice)) return D3DERR_INVALIDCALL;

        const dataSize = QUERY_DATA_SIZE[type];
        if (dataSize === undefined) {
            // Real D3D9 leaves *ppQuery untouched here. We clear it because our unsupported
            // set is far wider than a real device's, so a caller that never checks the
            // HRESULT (it always succeeded on hardware) meets a NULL, not a stale local.
            if (ppQuery) Mem.writeUint32(ppQuery, 0);
            Logger.log(LogCategory.D3D9, `CreateQuery(Type=${type}): unavailable`);
            return D3DERR_NOTAVAILABLE;
        }
        const manager = queryDeviceHooks(pDevice)?.getQueryManager?.() ?? null;
        if (type === D3DQUERYTYPE_TIMESTAMP && manager
            && !manager.getCapability('timestamp').supported) {
            Logger.log(LogCategory.D3D9, 'CreateQuery(TIMESTAMP): timestamp-query feature unavailable');
            if (ppQuery) initReturnPtr(ppQuery);
            return D3DERR_NOTAVAILABLE;
        }
        if (!ppQuery) return D3D_OK;
        initReturnPtr(ppQuery);

        const vtableAddr = getVTables()['IDirect3DQuery9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DQuery9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const queryPtr = createComObject(vtableAddr);
        const record: QueryRecord = {
            type, devicePtr: pDevice, dataSize, begun: false, issued: false, issueTime: 0n,
            issueSerial: 0,
            occlusionBeginDraws: null,
            occlusionEndDraws: null,
            disjointBeginTime: null,
            disjointEndTime: null,
            awaitingResult: false,
            lostNoted: false,
            gpuMode: false,
        };
        if (manager) {
            const handle = manager.acquire(queryPtr, record);
            record.gpuManager = manager;
            record.gpuMode = handle.mode === 'gpu';
        }
        const stale = queries.get(queryPtr);
        if (stale) {
            // The COM block was recycled under a still-live record: whatever that query
            // measured can never be read, and the manager already refuses to reuse its slot.
            ledger.lostOnRecycle++;
            noteRetired(stale);
        }
        queries.set(queryPtr, record);
        ledger.created++;
        registerDeviceChildFinalizer(queryPtr, pDevice, () => {
            // A recycled COM pointer hands this finalizer the NEXT object's record; passing
            // our own lets the manager's guard — and the identity check — keep to our generation.
            record.gpuManager?.release(queryPtr, record);
            if (queries.get(queryPtr) !== record) return;
            noteRetired(record);
            queries.delete(queryPtr);
        });

        if (!Mem.writeUint32(ppQuery, queryPtr)) {
            releaseComRef(queryPtr);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `CreateQuery(Type=${type}) -> 0x${queryPtr.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DQuery9_QueryInterface'] = (_ctx, mem, args) => {
        const thisPtr = args[0] >>> 0;
        const riid = args[1] >>> 0;
        const ppvObject = args[2] >>> 0;
        if (!ppvObject) return E_POINTER;
        initReturnPtr(ppvObject);

        // QI is a live-object operation.  Do not return a stale query pointer
        // merely because its bytes happen to resemble a supported IID.
        if (!queries.has(thisPtr)) return E_NOINTERFACE;
        if (!riid) return E_POINTER;

        const key = readD3D9GuidKey(mem, riid);
        if (key !== IID_IDIRECT3DQUERY9 && key !== IID_IUNKNOWN) return E_NOINTERFACE;
        if (addComRef(thisPtr) === undefined) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
        return D3D_OK;
    };

    exports['IDirect3DQuery9_AddRef'] = (_ctx, _mem, args) => {
        return addComRef(args[0] >>> 0) ?? 0;
    };

    exports['IDirect3DQuery9_Release'] = (_ctx, _mem, args) => {
        return releaseComRef(args[0] >>> 0) ?? 0;
    };

    exports['IDirect3DQuery9_GetDevice'] = (_ctx, _mem, args) => {
        const ppDevice = args[1] >>> 0;
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const query = queries.get(args[0] >>> 0);
        if (!query || !devices.has(query.devicePtr)) return D3DERR_INVALIDCALL;
        if (!Mem.writeUint32(ppDevice, query.devicePtr)) return D3DERR_INVALIDCALL;
        addComRef(query.devicePtr);
        return D3D_OK;
    };

    // GetType/GetDataSize return a D3DQUERYTYPE / DWORD, not an HRESULT.
    exports['IDirect3DQuery9_GetType'] = (_ctx, _mem, args) => {
        return queries.get(args[0] >>> 0)?.type ?? 0;
    };

    exports['IDirect3DQuery9_GetDataSize'] = (_ctx, _mem, args) => {
        return queries.get(args[0] >>> 0)?.dataSize ?? 0;
    };

    /**
     * Issue(dwIssueFlags). BEGIN/END are tracked per query. In particular, an occlusion
     * query never uses a process-global "active" slot, so nested queries retain their own
     * draw intervals. EVENT and timestamp-style queries only become visible after END and
     * the submission serial carrying that END.
     */
    exports['IDirect3DQuery9_Issue'] = (_ctx, _mem, args) => {
        const query = queries.get(args[0] >>> 0);
        if (!query) return D3DERR_INVALIDCALL;
        const flags = args[1] >>> 0;
        // DXVK's D3D9 query implementation is deliberately permissive: exactly
        // D3DISSUE_BEGIN begins a beginnable query; every other flag value is the
        // END operation. BEGIN on EVENT/timestamp-info queries is a successful
        // no-op, not an INVALIDCALL, and unknown flag bits are treated as END.
        if (flags === D3DISSUE_BEGIN) {
            if (queryCanBegin(query.type)) {
                if (query.gpuManager && query.issued) {
                    const handle = query.gpuManager.rearm(args[0] >>> 0, query);
                    // The old GPU interval may still be encoded/submitted. Do not
                    // mutate this record into a new interval when the manager could
                    // not reserve a generation-safe slot; the caller can keep
                    // polling the old result and retry later.
                    if (!handle) { ledger.error++; return D3DERR_NOTAVAILABLE; }
                    query.gpuMode = handle.mode === 'gpu';
                }
                // BEGIN starts a new interval. Reusing a query without END is legal state
                // replacement in the native runtime; clear the prior completion record.
                ledger.begin++;
                // The interval being replaced never reported a result to anyone.
                noteRetired(query);
                query.lostNoted = false;
                query.begun = true;
                query.issued = false;
                query.issueTime = 0n;
                query.issueSerial = 0;
                query.occlusionBeginDraws = query.type === D3DQUERYTYPE_OCCLUSION
                    ? deviceDrawCount(query.devicePtr) : null;
                query.occlusionEndDraws = null;
                query.disjointBeginTime = query.type === D3DQUERYTYPE_TIMESTAMPDISJOINT
                    ? nowD3dTicks() : null;
                query.disjointEndTime = null;
                if (query.type === D3DQUERYTYPE_OCCLUSION) {
                    queryDeviceHooks(query.devicePtr)?.recordQueryBegin?.(args[0] >>> 0);
                }
            }
        } else {
            if (query.type === D3DQUERYTYPE_OCCLUSION && !query.begun) {
                // END-only is an implicit zero-width interval, but the GPU query API still
                // requires a matching begin/end pair in the active render pass.
                const split = managerNeedsRebegin(query.gpuManager, args[0] >>> 0);
                if (query.gpuManager && (query.issued || split)) {
                    const handle = query.gpuManager.rearm(args[0] >>> 0, query);
                    if (!handle) { ledger.error++; return D3DERR_NOTAVAILABLE; }
                    query.gpuMode = handle.mode === 'gpu';
                }
                queryDeviceHooks(query.devicePtr)?.recordQueryBegin?.(args[0] >>> 0);
            } else if (query.type === D3DQUERYTYPE_OCCLUSION
                && managerNeedsRebegin(query.gpuManager, args[0] >>> 0)) {
                // A prior BEGIN was submitted in another command buffer. Re-arm before
                // recording END so the next pass contains a valid local BEGIN/END pair.
                const handle = query.gpuManager!.rearm(args[0] >>> 0, query);
                if (!handle) { ledger.error++; return D3DERR_NOTAVAILABLE; }
                query.gpuMode = handle.mode === 'gpu';
                query.begun = false;
                queryDeviceHooks(query.devicePtr)?.recordQueryBegin?.(args[0] >>> 0);
            }
            completeQueryEnd(query);
            if (query.type === D3DQUERYTYPE_OCCLUSION) {
                queryDeviceHooks(query.devicePtr)?.recordQueryEnd?.(args[0] >>> 0);
            } else if (query.type === D3DQUERYTYPE_TIMESTAMP && query.gpuMode) {
                queryDeviceHooks(query.devicePtr)?.recordQueryTimestamp?.(args[0] >>> 0);
            }
        }
        return D3D_OK;
    };

    /**
     * GetData(pData, dwSize, dwGetDataFlags). Sizing follows the runtime: dwSize 0 leaves
     * the buffer alone and reports status only, a short dwSize is honored rather than
     * clamped up, and a NULL pData with a non-zero dwSize is rejected (it faults on
     * Windows). D3DGETDATA_FLUSH advances the active submission domain below. A live WebGPU
     * manager still requires its resolve/readback promise; the serial advance only models the
     * command-buffer flush boundary and never fabricates a GPU result.
     *
     * A query that was never issued is implicitly ended on first GetData, matching DXVK's
     * initial-state transition. It still remains S_FALSE until the submission serial for
     * that synthetic END is observed (or an explicit D3DGETDATA_FLUSH advances it).
     */
    const getData = (args: number[]): number => {
        const query = queries.get(args[0] >>> 0);
        if (!query) return D3DERR_INVALIDCALL;
        // A lost device answers DEVICELOST only to a caller that asked for a FLUSH;
        // a plain poll gets "not ready yet", so an alt-tab does not push a title
        // polling an EVENT query into its "query broken" branch. A D3D9Ex device
        // never reports DEVICELOST at all.
        const lost = (query.gpuManager?.isDeviceLost?.() ?? false)
            || deviceCooperativeLevel(query.devicePtr) !== 'ok';
        if (lost) {
            // Once per abandoned interval, not once per poll: the guest spins on GetData.
            if (!query.lostNoted && (query.awaitingResult || query.begun)) {
                query.lostNoted = true;
                ledger.lostOnDeviceLoss++;
            }
            const flush = ((args[3] >>> 0) & D3DGETDATA_FLUSH) !== 0;
            const extended = (devices.get(query.devicePtr >>> 0) as { isExtended?: boolean } | undefined)?.isExtended === true;
            return flush && !extended ? D3DERR_DEVICELOST : S_FALSE;
        }
        const pData = args[1] >>> 0;
        const size = args[2] >>> 0;

        if (!pData && size) return D3DERR_INVALIDCALL;
        const count = pData ? Math.min(size, query.dataSize) : 0;
        if (query.begun) {
            // A failed WebGPU begin is surfaced by the manager as an explicit
            // fallback/error. Do not leave the D3D9 record pending forever merely
            // because the high-level BEGIN state was already committed.
            if (query.gpuMode && query.gpuManager && query.type === D3DQUERYTYPE_OCCLUSION) {
                const gpu = query.gpuManager.poll(args[0] >>> 0);
                if (gpu.state === 'fallback' || gpu.state === 'unavailable') return D3DERR_NOTAVAILABLE;
            }
            return S_FALSE;
        }
        if (!query.issued) {
            if (query.type === D3DQUERYTYPE_OCCLUSION && !query.begun) {
                queryDeviceHooks(query.devicePtr)?.recordQueryBegin?.(args[0] >>> 0);
            }
            completeQueryEnd(query);
            if (query.type === D3DQUERYTYPE_OCCLUSION) {
                queryDeviceHooks(query.devicePtr)?.recordQueryEnd?.(args[0] >>> 0);
            } else if (query.type === D3DQUERYTYPE_TIMESTAMP && query.gpuMode) {
                queryDeviceHooks(query.devicePtr)?.recordQueryTimestamp?.(args[0] >>> 0);
            }
        }
        // D3DGETDATA_FLUSH asks the runtime to flush the command buffer so the work this
        // query fenced can retire. A live GPU manager still reports S_FALSE until its mapped
        // resolve is ready; for CPU-side completion records a flush request advances the local
        // ordering seam so initialization probes do not deadlock before the first Present.
        if (((args[3] >>> 0) & D3DGETDATA_FLUSH) !== 0) {
            const key = query.devicePtr >>> 0;
            if (hasManagerSubmissionDomain(query.gpuManager)) {
                // The manager is the live-device submission domain. notifySubmitted
                // is a seam for a flush; the actual GPU result still has to become
                // ready through poll(), so this cannot fabricate a timestamp.
                query.gpuManager!.notifySubmitted(query.issueSerial);
            } else if (query.issueSerial > (deviceSubmissionSerial.get(key) ?? 0)) {
                deviceSubmissionSerial.set(key, query.issueSerial);
            }
        }
        const observedSerial = hasManagerSubmissionDomain(query.gpuManager)
            ? query.gpuManager!.getSubmittedSerial()
            : (deviceSubmissionSerial.get(query.devicePtr) ?? 0);
        if (query.issueSerial > observedSerial) return S_FALSE;
        if (query.gpuMode && query.gpuManager &&
            (query.type === D3DQUERYTYPE_OCCLUSION || query.type === D3DQUERYTYPE_TIMESTAMP)) {
            const gpu = query.gpuManager.poll(args[0] >>> 0);
            if (gpu.state === 'pending') return S_FALSE;
            if (gpu.state === 'ready') {
                // A zero-sized output is still a readiness probe; do not pass a NULL
                // address into the byte writers once the GPU result is available.
                if (count === 0) return D3D_OK;
                if (query.type === D3DQUERYTYPE_TIMESTAMP) {
                    return writeQueryUint64(pData, Math.min(count, 8), gpu.value)
                        ? D3D_OK : D3DERR_INVALIDCALL;
                }
                return writeQueryData(pData, count, occlusionPixelsFromGpu(query, gpu.value))
                    ? D3D_OK : D3DERR_INVALIDCALL;
            }
            if (gpu.state === 'fallback') {
                // A manager fallback is only data-bearing when its caller supplied an
                // explicit value. Never silently turn a failed GPU measurement into the
                // viewport approximation used by the device-level CPU fallback.
                if (gpu.value === undefined) return D3DERR_NOTAVAILABLE;
                if (count === 0) return D3D_OK;
                if (query.type === D3DQUERYTYPE_TIMESTAMP) {
                    return writeQueryUint64(pData, Math.min(count, 8), gpu.value)
                        ? D3D_OK : D3DERR_INVALIDCALL;
                }
                return writeQueryData(pData, count, occlusionPixelsFromGpu(query, gpu.value))
                    ? D3D_OK : D3DERR_INVALIDCALL;
            }
            // A failed GPU readback is not silently converted into the old viewport-sized
            // answer. Surface the manager's explicit fallback/error state instead.
            if (gpu.state === 'unavailable') return D3DERR_NOTAVAILABLE;
        }
        // A live device that exposed the query-manager seam but could not allocate a query set
        // has no measured sample count/timestamp. Do not fall through to the adapter-free
        // viewport approximation: that would turn an explicit capability failure into a
        // fabricated D3D_OK result.
        if (query.gpuManager && !query.gpuMode &&
            (query.type === D3DQUERYTYPE_OCCLUSION || query.type === D3DQUERYTYPE_TIMESTAMP)) {
            return D3DERR_NOTAVAILABLE;
        }
        if (count === 0) return D3D_OK;
        if (query.type === D3DQUERYTYPE_TIMESTAMPDISJOINT) {
            // DXVK's D3D9 query contract exposes TIMESTAMPDISJOINT as a BOOL. Frequency is
            // returned by the separate TIMESTAMPFREQ query; do not pack a made-up frequency
            // into this payload (the old 16-byte layout was observably incompatible).
            return writeQueryData(pData, count, issuedQueryValue(query))
                ? D3D_OK : D3DERR_INVALIDCALL;
        }
        if (query.type === D3DQUERYTYPE_TIMESTAMP || query.type === D3DQUERYTYPE_TIMESTAMPFREQ) {
            const value = query.type === D3DQUERYTYPE_TIMESTAMP
                ? query.issueTime : 1_000_000_000n;
            if (!writeQueryUint64(pData, Math.min(count, 8), value)) return D3DERR_INVALIDCALL;
            return D3D_OK;
        }
        if (query.type === D3DQUERYTYPE_VCACHE) {
            return writeQueryVCache(pData, count) ? D3D_OK : D3DERR_INVALIDCALL;
        }
        const value = issuedQueryValue(query);
        return writeQueryData(pData, count, value) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DQuery9_GetData'] = (_ctx, _mem, args) =>
        noteGetData(args[0] >>> 0, getData(args));

    return exports;
}
