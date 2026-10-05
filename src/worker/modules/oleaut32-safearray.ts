import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";

const S_OK = 0x00000000;
const E_INVALIDARG = 0x80070057;
const DISP_E_BADINDEX = 0x8002000b;
const DISP_E_ARRAYISLOCKED = 0x80020009;

const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_CY = 6;
const VT_DATE = 7;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_ERROR = 10;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_UI1 = 17;
const VT_UI2 = 18;
const VT_UI4 = 19;
const VT_INT = 22;
const VT_UINT = 23;

type OwnedSafeArray = {
    descPtr: number;
    dataPtr: number;
};

function elementSize(vt: number): number {
    switch (vt) {
        case VT_I2:
        case VT_UI2:
        case VT_BOOL:
            return 2;
        case VT_I4:
        case VT_UI4:
        case VT_R4:
        case VT_INT:
        case VT_UINT:
        case VT_ERROR:
        case VT_BSTR:
        case VT_DISPATCH:
        case VT_UNKNOWN:
            return 4;
        case VT_R8:
        case VT_CY:
        case VT_DATE:
            return 8;
        case VT_UI1:
            return 1;
        case VT_VARIANT:
            return 16;
        default:
            return 0;
    }
}

function readBound(mem: Uint8Array, psa: number, dim1Based: number): { cElements: number; lLbound: number } | null {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cDims = view.getUint16(psa, true);
    if (dim1Based < 1 || dim1Based > cDims) return null;
    const off = psa + 16 + (dim1Based - 1) * 8;
    if (off + 8 > mem.length) return null;
    return {
        cElements: view.getUint32(off, true),
        lLbound: view.getInt32(off + 4, true),
    };
}

function ptrOfIndex(mem: Uint8Array, psa: number, rgIndices: number, ppvData: number): number {
    if (!psa || !rgIndices || !ppvData) return E_INVALIDARG;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (psa + 16 > mem.length) return E_INVALIDARG;

    const cDims = view.getUint16(psa, true);
    const cbElements = view.getUint32(psa + 4, true);
    const pvData = view.getUint32(psa + 12, true);
    if (!cDims || !cbElements || !pvData) return E_INVALIDARG;

    let boundDim = cDims - 1;
    const c1 = view.getInt32(rgIndices, true);
    const rightBoundOff = psa + 16 + boundDim * 8;
    const rightCElements = view.getUint32(rightBoundOff, true);
    const rightLLbound = view.getInt32(rightBoundOff + 4, true);
    if (c1 < rightLLbound || c1 >= rightLLbound + rightCElements) {
        return DISP_E_BADINDEX;
    }

    let cell = 0;
    let dimensionSize = 1;
    let psabOff = rightBoundOff;
    let rgIdx = 4;

    for (let dim = 1; dim < cDims; dim++) {
        dimensionSize *= view.getUint32(psabOff, true);
        boundDim--;
        psabOff = psa + 16 + boundDim * 8;
        const cElements = view.getUint32(psabOff, true);
        const lLbound = view.getInt32(psabOff + 4, true);
        const index = view.getInt32(rgIndices + rgIdx, true);
        rgIdx += 4;
        if (!cElements || index < lLbound || index >= lLbound + cElements) {
            return DISP_E_BADINDEX;
        }
        cell += (index - lLbound) * dimensionSize;
    }

    cell += c1 - rightLLbound;
    const elemPtr = pvData + cell * cbElements;
    if (elemPtr + cbElements > mem.length) return DISP_E_BADINDEX;
    Mem.writeUint32(ppvData, elemPtr);
    return S_OK;
}

export function createSafeArrayExports(): {
    exports: Record<string, ThunkImplementation>;
    reset: () => void;
} {
    const owned = new Map<number, OwnedSafeArray>();

    const alloc = (size: number) => System.getInstance().process?.memory?.alloc(size) ?? 0;
    const free = (ptr: number) => {
        if (ptr) System.getInstance().process?.memory?.free(ptr);
    };

    const exports: Record<string, ThunkImplementation> = {};

    exports["SafeArrayCreate"] = (_ctx, mem, args) => {
        const vt = args[0] & 0xffff;
        const cDims = args[1] >>> 0;
        const rgsabound = args[2] >>> 0;
        const cbElements = elementSize(vt);
        if (!cbElements || cDims < 1 || cDims > 60 || !rgsabound) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let totalElements = 1;
        const bounds: Array<{ cElements: number; lLbound: number }> = [];
        for (let i = 0; i < cDims; i++) {
            const off = rgsabound + i * 8;
            if (off + 8 > mem.length) return 0;
            const cElements = view.getUint32(off, true);
            const lLbound = view.getInt32(off + 4, true);
            if (!cElements) return 0;
            bounds.push({ cElements, lLbound });
            totalElements *= cElements;
        }

        const descSize = 16 + cDims * 8;
        const dataSize = totalElements * cbElements;
        const descPtr = alloc(descSize);
        const dataPtr = alloc(dataSize);
        if (!descPtr || !dataPtr) {
            if (descPtr) free(descPtr);
            if (dataPtr) free(dataPtr);
            return 0;
        }

        mem.fill(0, dataPtr, dataPtr + dataSize);
        view.setUint16(descPtr, cDims, true);
        view.setUint16(descPtr + 2, 0, true);
        view.setUint32(descPtr + 4, cbElements, true);
        view.setUint32(descPtr + 8, 0, true);
        view.setUint32(descPtr + 12, dataPtr, true);
        for (let i = 0; i < cDims; i++) {
            const boundOff = descPtr + 16 + i * 8;
            view.setUint32(boundOff, bounds[i].cElements, true);
            view.setInt32(boundOff + 4, bounds[i].lLbound, true);
        }

        owned.set(descPtr, { descPtr, dataPtr });
        return descPtr;
    };

    exports["SafeArrayDestroy"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa) return S_OK;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const locks = view.getUint32(psa + 8, true);
        if (locks) return DISP_E_ARRAYISLOCKED;

        const entry = owned.get(psa);
        if (entry) {
            free(entry.dataPtr);
            free(entry.descPtr);
            owned.delete(psa);
        }
        return S_OK;
    };

    exports["SafeArrayGetDim"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa || psa + 2 > mem.length) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return view.getUint16(psa, true);
    };

    exports["SafeArrayGetLBound"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        const nDim = args[1] >>> 0;
        const plLbound = args[2] >>> 0;
        if (!psa || !plLbound) return E_INVALIDARG;
        const bound = readBound(mem, psa, nDim);
        if (!bound) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(plLbound, bound.lLbound, true);
        return S_OK;
    };

    exports["SafeArrayGetUBound"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        const nDim = args[1] >>> 0;
        const plUbound = args[2] >>> 0;
        if (!psa || !plUbound) return E_INVALIDARG;
        const bound = readBound(mem, psa, nDim);
        if (!bound) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(plUbound, bound.lLbound + bound.cElements - 1, true);
        return S_OK;
    };

    exports["SafeArrayAccessData"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        const ppvData = args[1] >>> 0;
        if (!psa || !ppvData) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const pvData = view.getUint32(psa + 12, true);
        if (!pvData) return E_INVALIDARG;
        const locks = view.getUint32(psa + 8, true);
        view.setUint32(psa + 8, locks + 1, true);
        Mem.writeUint32(ppvData, pvData);
        return S_OK;
    };

    exports["SafeArrayUnaccessData"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const locks = view.getUint32(psa + 8, true);
        if (!locks) return 0x8000ffff; // E_UNEXPECTED
        view.setUint32(psa + 8, locks - 1, true);
        return S_OK;
    };

    // UINT SafeArrayGetElemsize(SAFEARRAY*) — cbElements, the field every element walk needs.
    exports["SafeArrayGetElemsize"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa || psa + 16 > mem.length) return 0;
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(psa + 4, true);
    };

    // HRESULT SafeArrayLock/Unlock — the same cLocks counter Access/UnaccessData maintains,
    // without handing back the data pointer.
    exports["SafeArrayLock"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa || psa + 16 > mem.length) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(psa + 8, view.getUint32(psa + 8, true) + 1, true);
        return S_OK;
    };
    exports["SafeArrayUnlock"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        if (!psa || psa + 16 > mem.length) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const locks = view.getUint32(psa + 8, true);
        if (!locks) return 0x8000ffff; // E_UNEXPECTED
        view.setUint32(psa + 8, locks - 1, true);
        return S_OK;
    };

    const ptrOfIndexThunk: ThunkImplementation = (_ctx, mem, args) => {
        return ptrOfIndex(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0);
    };
    exports["SafeArrayPtrOfIndex"] = ptrOfIndexThunk;
    exports["ord_148"] = ptrOfIndexThunk;

    exports["SafeArrayGetElement"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        const rgIndices = args[1] >>> 0;
        const pv = args[2] >>> 0;
        if (!psa || !rgIndices || !pv) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbElements = view.getUint32(psa + 4, true);
        if (!cbElements) return E_INVALIDARG;

        const elemPtrSlot = alloc(4);
        if (!elemPtrSlot) return E_INVALIDARG;
        const hr = ptrOfIndex(mem, psa, rgIndices, elemPtrSlot);
        if (hr !== S_OK) {
            free(elemPtrSlot);
            return hr;
        }
        const elemPtr = view.getUint32(elemPtrSlot, true);
        free(elemPtrSlot);
        if (elemPtr + cbElements > mem.length || pv + cbElements > mem.length) return E_INVALIDARG;
        mem.set(mem.subarray(elemPtr, elemPtr + cbElements), pv);
        return S_OK;
    };

    exports["SafeArrayPutElement"] = (_ctx, mem, args) => {
        const psa = args[0] >>> 0;
        const rgIndices = args[1] >>> 0;
        const pv = args[2] >>> 0;
        if (!psa || !rgIndices || !pv) return E_INVALIDARG;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbElements = view.getUint32(psa + 4, true);
        if (!cbElements) return E_INVALIDARG;

        const elemPtrSlot = alloc(4);
        if (!elemPtrSlot) return E_INVALIDARG;
        const hr = ptrOfIndex(mem, psa, rgIndices, elemPtrSlot);
        if (hr !== S_OK) {
            free(elemPtrSlot);
            return hr;
        }
        const elemPtr = view.getUint32(elemPtrSlot, true);
        free(elemPtrSlot);
        if (elemPtr + cbElements > mem.length || pv + cbElements > mem.length) return E_INVALIDARG;
        mem.set(mem.subarray(pv, pv + cbElements), elemPtr);
        return S_OK;
    };

    // Ordinal aliases — most callers import SafeArray* by ordinal, and a name-only
    // table binds none of them. Numbers are the oleaut32 export table's, not derived.
    const ORDINALS: Record<number, string> = {
        15: "SafeArrayCreate",
        16: "SafeArrayDestroy",
        17: "SafeArrayGetDim",
        18: "SafeArrayGetElemsize",
        19: "SafeArrayGetUBound",
        20: "SafeArrayGetLBound",
        21: "SafeArrayLock",
        22: "SafeArrayUnlock",
        23: "SafeArrayAccessData",
        24: "SafeArrayUnaccessData",
        25: "SafeArrayGetElement",
        26: "SafeArrayPutElement",
    };
    for (const [ordinal, name] of Object.entries(ORDINALS)) {
        if (exports[name]) exports[`ord_${ordinal}`] = exports[name];
    }

    return {
        exports,
        reset: () => owned.clear(),
    };
}
