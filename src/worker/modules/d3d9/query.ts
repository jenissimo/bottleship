/**
 * IDirect3DQuery9 — asynchronous query objects.
 *
 * Only D3DQUERYTYPE_EVENT is backed by a real object; every other type answers
 * D3DERR_NOTAVAILABLE at CreateQuery, which is the faithful "this device does not
 * support that query" (a caller MUST handle it — real drivers differ in coverage).
 *
 * EVENT queries are always signaled by the time the guest can observe them, and this
 * is a statement about our runtime rather than a shortcut. Present is an async thunk:
 * the guest thread is parked inside D3D9Device.present(), which awaits an rAF permit
 * from the frame pacer and only then submits the frame. The guest can therefore never
 * be more than the still-recording frame ahead of the GPU — the flip queue an event
 * query exists to drain has depth 1 and is already drained at every point the guest
 * can ask. Wiring GetData to queue.onSubmittedWorkDone() would not measure the GPU:
 * GetData is a SYNCHRONOUS thunk polled in a guest spin loop, so a promise-backed
 * answer could only flip across a worker event-loop turn, and the S_FALSE window
 * would report OUR JS scheduling latency under a GPU-fence label. It would also fence
 * the wrong point — commands batch until Present, so a mid-frame Issue has nothing of
 * its own submitted yet. Consequence: GetData never returns S_FALSE, so a caller
 * spinning on it cannot fail to make progress.
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
import { readGuidKey } from './resources';

const D3D_OK = 0;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DERR_INVALIDCALL = 0x8876086c;

const D3DQUERYTYPE_EVENT = 8;
const D3DISSUE_END = 1 << 0;

/** IID_IDirect3DQuery9 {D9771460-A695-4F26-BBD3-27B840B541CC} as raw guest bytes. */
const IID_IDIRECT3DQUERY9 = '601477d995a6264fbbd327b840b541cc';
/** IID_IUnknown {00000000-0000-0000-C000-000000000046} as raw guest bytes. */
const IID_IUNKNOWN = '0000000000000000c000000000000046';

/**
 * GetDataSize per SUPPORTED type — this table IS the support set, so a type absent
 * from it is the one CreateQuery reports as D3DERR_NOTAVAILABLE.
 */
const QUERY_DATA_SIZE: Record<number, number> = {
    [D3DQUERYTYPE_EVENT]: 4, // sizeof(BOOL)
};

type QueryRecord = {
    type: number;
    devicePtr: number;
    dataSize: number;
    /** An END has been issued. Drives the DATA GetData writes, never its HRESULT. */
    issued: boolean;
};

const queries: Map<number, QueryRecord> = new Map();

/** Writes the low `count` bytes of a DWORD, so a caller's short buffer is not overrun. */
function writeQueryData(pData: number, count: number, value: number): boolean {
    if (!isValidAddress(pData, count, 'rw')) return false;
    for (let i = 0; i < count; i++) {
        if (!Mem.writeUint8(pData + i, (value >>> (i * 8)) & 0xff)) return false;
    }
    return true;
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
        if (!ppQuery) return D3D_OK;
        initReturnPtr(ppQuery);

        const vtableAddr = getVTables()['IDirect3DQuery9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DQuery9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const queryPtr = createComObject(vtableAddr);
        queries.set(queryPtr, { type, devicePtr: pDevice, dataSize, issued: false });
        registerDeviceChildFinalizer(queryPtr, pDevice, () => { queries.delete(queryPtr); });

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

        const key = readGuidKey(mem, riid);
        if (key !== IID_IDIRECT3DQUERY9 && key !== IID_IUNKNOWN) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
        addComRef(thisPtr);
        return D3D_OK;
    };

    exports['IDirect3DQuery9_AddRef'] = (_ctx, _mem, args) => {
        return addComRef(args[0] >>> 0) ?? 1;
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
     * Issue(dwIssueFlags). D3DISSUE_BEGIN is meaningless for an EVENT query — it is not
     * beginnable — and the runtime accepts it silently; only END marks the point to signal.
     */
    exports['IDirect3DQuery9_Issue'] = (_ctx, _mem, args) => {
        const query = queries.get(args[0] >>> 0);
        if (!query) return D3DERR_INVALIDCALL;
        if (args[1] & D3DISSUE_END) query.issued = true;
        return D3D_OK;
    };

    /**
     * GetData(pData, dwSize, dwGetDataFlags). Sizing follows the runtime: dwSize 0 leaves
     * the buffer alone and reports status only, a short dwSize is honored rather than
     * clamped up, and a NULL pData with a non-zero dwSize is rejected (it faults on
     * Windows). D3DGETDATA_FLUSH has nothing to shorten — see the file header — and
     * forcing a submit here would break command batching for no observable gain.
     *
     * A query that was never issued still succeeds, with UNDEFINED contents (the runtime
     * writes 0xdd filler); returning D3DERR_INVALIDCALL there is a wined3d-internal code
     * that the d3d9 layer converts before the app sees it.
     */
    exports['IDirect3DQuery9_GetData'] = (_ctx, _mem, args) => {
        const query = queries.get(args[0] >>> 0);
        if (!query) return D3DERR_INVALIDCALL;
        const pData = args[1] >>> 0;
        const size = args[2] >>> 0;

        if (!pData) return size ? D3DERR_INVALIDCALL : D3D_OK;
        const count = Math.min(size, query.dataSize);
        if (count === 0) return D3D_OK;

        const value = query.issued ? 1 : 0xdddddddd;
        return writeQueryData(pData, count, value) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    return exports;
}
