/**
 * IDirectDrawSurface4/7 Set/Get/FreePrivateData — the GUID-keyed per-surface
 * application data store.
 *
 * It is opaque to the driver but load-bearing for the app: era D3D7 wrappers hang
 * their own bookkeeping off the surface (source image extent, mip level, wrapper
 * object) and read it back on the upload path. A stub that returns DD_OK without
 * filling the caller's buffer hands the app whatever was on its stack — typically
 * zeroes — so it uploads a 0x0 image and every texture stays blank.
 *
 * Error contract follows the documented (and Windows-observed) behaviour:
 *   Set:  NULL data → DDERR_INVALIDPARAMS; DDSPD_IUNKNOWNPOINTER requires
 *         cbSize == sizeof(IUnknown*) and takes a reference on the object.
 *   Get:  absent tag → DDERR_NOTFOUND (nothing written); *pcbSize too small →
 *         *pcbSize = required, DDERR_MOREDATA; NULL pcbSize / NULL buffer with a
 *         large enough size → DDERR_INVALIDPARAMS. IUnknown getters AddRef.
 *   Free: absent tag → DDERR_NOTFOUND; releases an IUnknown entry's reference.
 * Surface teardown frees every entry (and its references).
 */

import { Logger, LogCategory } from "../../core/logger";
import { isValidAddress } from "../../core/memory/address-guard";
import { DD_OK } from "./constants";
import type { DirectDrawSurfaceObject, PrivateDataEntry } from "./com-objects";
import type { DDrawContext } from "./context";
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";

const DDERR_INVALIDPARAMS = 0x80070057; // ddraw.h aliases this onto E_INVALIDARG
const DDERR_INVALIDOBJECT = 0x88760082;
const DDERR_NOTFOUND = 0x887600ff;
const DDERR_MOREDATA = 0x887602b2;

const DDSPD_IUNKNOWNPOINTER = 0x00000001;
/** sizeof(IUnknown *) in the 32-bit guest ABI. */
const IUNKNOWN_SIZE = 4;

/** Canonical key for a REFGUID argument (16 raw bytes → hex). */
function readGuidKey(mem: Uint8Array, addr: number): string | null {
    if (!addr || !isValidAddress(mem, addr, 16)) return null;
    let key = "";
    for (let i = 0; i < 16; i++) key += mem[addr + i].toString(16).padStart(2, "0");
    return key;
}

function releaseEntry(context: DDrawContext, entry: PrivateDataEntry): void {
    if (!entry.unknownPtr) return;
    context.resourceProvider.getComObjectByAddress(entry.unknownPtr)?.release();
}

export function createSurfacePrivateDataExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const surfaceOf = (thisPtr: number): DirectDrawSurfaceObject | null =>
        context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;

    exports["IDirectDrawSurface7_SetPrivateData"] = (_ctx, mem, args) => {
        const obj = surfaceOf(args[0]);
        if (!obj) return DDERR_INVALIDOBJECT;
        const key = readGuidKey(mem, args[1]);
        if (!key) return DDERR_INVALIDPARAMS;

        const lpData = args[2] >>> 0;
        const cbSize = args[3] >>> 0;
        const dwFlags = args[4] >>> 0;
        if (!lpData) return DDERR_INVALIDPARAMS;

        let entry: PrivateDataEntry;
        if ((dwFlags & DDSPD_IUNKNOWNPOINTER) !== 0) {
            // lpData IS the interface pointer here, not a pointer to it.
            if (cbSize !== IUNKNOWN_SIZE) return DDERR_INVALIDPARAMS;
            context.resourceProvider.getComObjectByAddress(lpData)?.addRef();
            entry = { size: IUNKNOWN_SIZE, unknownPtr: lpData };
        } else {
            if (!cbSize || !isValidAddress(mem, lpData, cbSize)) return DDERR_INVALIDPARAMS;
            entry = { size: cbSize, bytes: mem.slice(lpData, lpData + cbSize) };
        }

        const state = obj.getState();
        const store = state.privateData ?? (state.privateData = new Map());
        const previous = store.get(key);
        if (previous) releaseEntry(context, previous);
        store.set(key, entry);
        Logger.verbose(LogCategory.DDRAW,
            `IDirectDrawSurface7_SetPrivateData: surface=0x${args[0].toString(16)} tag=${key} size=${entry.size} flags=0x${dwFlags.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetPrivateData"] = (_ctx, mem, args) => {
        const obj = surfaceOf(args[0]);
        if (!obj) return DDERR_INVALIDOBJECT;
        const key = readGuidKey(mem, args[1]);
        if (!key) return DDERR_INVALIDPARAMS;

        const entry = obj.getState().privateData?.get(key);
        // A missing tag is reported before any argument validation, and leaves both
        // the buffer and the size out parameter untouched.
        if (!entry) return DDERR_NOTFOUND;

        const lpBuffer = args[2] >>> 0;
        const lpcbSize = args[3] >>> 0;
        if (!lpcbSize || !isValidAddress(mem, lpcbSize, 4)) return DDERR_INVALIDPARAMS;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const available = view.getUint32(lpcbSize, true);
        if (available < entry.size) {
            view.setUint32(lpcbSize, entry.size, true);
            return DDERR_MOREDATA;
        }
        if (!lpBuffer || !isValidAddress(mem, lpBuffer, entry.size)) return DDERR_INVALIDPARAMS;

        if (entry.bytes) {
            mem.set(entry.bytes, lpBuffer);
        } else {
            // A successful DDSPD_IUNKNOWNPOINTER GetPrivateData hands the caller
            // an independently owned interface reference.
            view.setUint32(lpBuffer, entry.unknownPtr ?? 0, true);
        }
        view.setUint32(lpcbSize, entry.size, true);
        if (!entry.bytes && entry.unknownPtr) {
            context.resourceProvider.getComObjectByAddress(entry.unknownPtr)?.addRef();
        }
        return DD_OK;
    };

    exports["IDirectDrawSurface7_FreePrivateData"] = (_ctx, mem, args) => {
        const obj = surfaceOf(args[0]);
        if (!obj) return DDERR_INVALIDOBJECT;
        const key = readGuidKey(mem, args[1]);
        if (!key) return DDERR_INVALIDPARAMS;

        const state = obj.getState();
        const entry = state.privateData?.get(key);
        if (!entry) return DDERR_NOTFOUND;
        releaseEntry(context, entry);
        state.privateData!.delete(key);
        return DD_OK;
    };

    return exports;
}
