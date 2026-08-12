/**
 * ID3DXBuffer — the blob D3DX hands back from D3DXAssembleShader /
 * D3DXDisassembleShader / D3DXCreateBuffer.
 *
 * The payload lives in its own guest allocation, not inside the COM object:
 * callers keep the GetBufferPointer() result across other D3DX calls, and a
 * disassembly easily outgrows a COM block.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { InterfaceDescriptor, IUnknown, ModuleDescriptor } from '../../api/types';
import { addComRef, createComObject, forgetComObject, registerComFinalizer, releaseComRef } from '../d3d9/shared-state';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { normalizeGuid, readGuidFromMem } from '../../core/com/typelib/typelib-types';

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;
const E_NOINTERFACE = 0x80004002;
const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';

const ID3DXBuffer: InterfaceDescriptor = {
    name: 'ID3DXBuffer',
    inherits: 'IUnknown',
    iid: '8BA5FB08-5195-40E2-AC58-0D989C3A0102',
    methods: [
        ...IUnknown.methods,
        {
            name: 'GetBufferPointer',
            params: [{ name: 'this', type: 'ptr', direction: 'in' }],
            returnType: 'u32',
            callingConvention: 'stdcall',
        },
        {
            name: 'GetBufferSize',
            params: [{ name: 'this', type: 'ptr', direction: 'in' }],
            returnType: 'u32',
            callingConvention: 'stdcall',
        },
    ],
};

const bufferModuleDescriptor: ModuleDescriptor = {
    name: 'd3dx9',
    functions: [],
    interfaces: [ID3DXBuffer],
};

interface BufferData { dataPtr: number; size: number }

const buffers: Map<number, BufferData> = new Map();
let bufferVtable: VTableInfo | null = null;

function ensureVtable(process: Process): number {
    if (!bufferVtable) {
        const tables = createVTablesFromDescriptor(process, bufferModuleDescriptor);
        bufferVtable = tables['ID3DXBuffer'] ?? null;
    }
    return bufferVtable?.address ?? 0;
}

/**
 * Allocate an ID3DXBuffer of `size` bytes (zero-filled), returning its guest
 * `this` pointer, or 0 if the guest heap could not serve it.
 */
export function createD3DXBuffer(process: Process, size: number): number {
    const vtableAddr = ensureVtable(process);
    if (!vtableAddr) return 0;

    // D3DXCreateBuffer(0) is legal and yields a buffer with a valid pointer.
    const allocSize = Math.max(1, size);
    let dataPtr = 0;
    try {
        dataPtr = process.memory.alloc(allocSize, 'HEAP', 'rw');
    } catch {
        return 0;
    }
    if (!dataPtr) return 0;

    const view = Mem.getView();
    if (view) view.fill(0, dataPtr, dataPtr + allocSize);

    const objPtr = createComObject(vtableAddr);
    buffers.set(objPtr, { dataPtr, size });
    registerComFinalizer(objPtr, () => {
        buffers.delete(objPtr);
        try { process.memory.free(dataPtr); } catch { /* the address space outlives us anyway */ }
    });
    return objPtr;
}

/** Allocate a buffer already filled with `bytes`. */
export function createD3DXBufferFrom(process: Process, bytes: Uint8Array): number {
    const objPtr = createD3DXBuffer(process, bytes.length);
    if (!objPtr) return 0;
    const data = buffers.get(objPtr)!;
    Mem.writeBytes(data.dataPtr, bytes);
    return objPtr;
}

/** Allocate a buffer holding `text` plus its NUL — D3DX counts the terminator in the size. */
export function createD3DXTextBuffer(process: Process, text: string): number {
    const bytes = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xFF;
    return createD3DXBufferFrom(process, bytes);
}

export function createBufferExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['ID3DXBuffer_QueryInterface'] = (_ctx, mem, args) => {
        const self = args[0] >>> 0;
        const riid = args[1] >>> 0;
        const ppv = args[2] >>> 0;
        if (!ppv) return E_POINTER;
        // A refused QI must leave *ppv NULL and take no reference — a caller that
        // probes for an interface it may not get reads the out-param either way.
        Mem.writeUint32(ppv, 0);
        // E_POINTER is reserved for a NULL argument (ppv, checked above). A `this` we no
        // longer know is a released blob, and "cannot supply that interface" is the only
        // thing the object can honestly say about it.
        if (!buffers.has(self)) return E_NOINTERFACE;
        // ID3DXBuffer adds nothing to IUnknown, so those two are the whole set.
        const iid = riid ? normalizeGuid(readGuidFromMem(mem, riid)) : null;
        if (iid !== normalizeGuid(ID3DXBuffer.iid!) && iid !== IID_IUNKNOWN) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppv, self)) return E_POINTER;
        addComRef(self);
        return S_OK;
    };

    exports['ID3DXBuffer_AddRef'] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 1;
    exports['ID3DXBuffer_Release'] = (_ctx, _mem, args) => releaseComRef(args[0] >>> 0) ?? 0;

    exports['ID3DXBuffer_GetBufferPointer'] = (_ctx, _mem, args) => {
        return buffers.get(args[0] >>> 0)?.dataPtr ?? 0;
    };
    exports['ID3DXBuffer_GetBufferSize'] = (_ctx, _mem, args) => {
        return buffers.get(args[0] >>> 0)?.size ?? 0;
    };

    exports['D3DXCreateBuffer'] = (_ctx, _mem, args) => {
        const size = args[0] >>> 0;
        const ppBuffer = args[1] >>> 0;
        if (!ppBuffer) return E_POINTER;
        const objPtr = createD3DXBuffer(process, size);
        if (!objPtr) {
            Logger.warn(LogCategory.D3D9, `D3DXCreateBuffer(${size}) could not allocate`);
            return E_OUTOFMEMORY;
        }
        return Mem.writeUint32(ppBuffer, objPtr) ? S_OK : E_POINTER;
    };

    return exports;
}

export function resetD3DXBuffers(): void {
    // Drop our finalizer registrations instead of leaving them for whoever drains next.
    // They live in the shared d3d9 registry, which is only drained if the d3d9 MODULE also
    // resets; one that outlived this process would later free() an address belonging to the
    // next one.
    for (const objPtr of buffers.keys()) forgetComObject(objPtr);
    buffers.clear();
    bufferVtable = null;
}
