/**
 * ID3DXConstantTable — the reflection object `D3DXGetShaderConstantTable` returns.
 *
 * A title that compiles its shaders offline still asks D3DX where each uniform LIVES:
 * the CTAB block maps a name to a register, and every `SetMatrix("mWorldViewProj", …)`
 * goes through here on its way to SetVertexShaderConstantF. Answering the query with
 * nothing configures no shader at all, so nothing the game draws is correct.
 *
 * D3DXHANDLE is a pointer to the constant's NAME inside our guest copy of the table —
 * which is what the shipped d3dx9 does, and why a caller may legally pass a bare string
 * literal where a handle is expected. Both spellings resolve through one lookup.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { InterfaceDescriptor, IUnknown, ModuleDescriptor, ParameterDescriptor } from '../../api/types';
import { addComRef, createComObject, devices, forgetComObject, registerComFinalizer, releaseComRef } from '../d3d9/shared-state';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { Logger, LogCategory } from '../../core/logger';
import { normalizeGuid, readGuidFromMem } from '../../core/com/typelib/typelib-types';
import {
    CtabConstant, CtabTable, ParameterClass, RegisterSet,
    isPixelShaderVersion, parseShaderConstantTable, typeBytes,
} from './ctab';

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;
const E_NOINTERFACE = 0x80004002;
const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;
const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';

/** sizeof(D3DXCONSTANTTABLE_DESC) */
const TABLE_DESC_SIZE = 12;

const ID3DXConstantTable: InterfaceDescriptor = {
    name: 'ID3DXConstantTable',
    inherits: 'IUnknown',
    iid: 'AB3C758F-93E1-4356-B762-4DB18F1B3A01',
    methods: [
        ...IUnknown.methods,
        // ID3DXBuffer — ID3DXConstantTable derives from it, so these two come first.
        m('GetBufferPointer', 0),
        m('GetBufferSize', 0),
        m('GetDesc', 1),
        m('GetConstantDesc', 3),
        m('GetSamplerIndex', 1),
        m('GetConstant', 2),
        m('GetConstantByName', 2),
        m('GetConstantElement', 2),
        m('SetDefaults', 1),
        m('SetValue', 4),
        m('SetBool', 3),
        m('SetBoolArray', 4),
        m('SetInt', 3),
        m('SetIntArray', 4),
        m('SetFloat', 3),
        m('SetFloatArray', 4),
        m('SetVector', 3),
        m('SetVectorArray', 4),
        m('SetMatrix', 3),
        m('SetMatrixArray', 4),
        m('SetMatrixPointerArray', 4),
        m('SetMatrixTranspose', 3),
        m('SetMatrixTransposeArray', 4),
        m('SetMatrixTransposePointerArray', 4),
    ],
};

/** One vtable slot: `this` plus `argCount` stdcall arguments. */
function m(name: string, argCount: number) {
    const params: ParameterDescriptor[] = [{ name: 'this', type: 'ptr', direction: 'in' }];
    for (let i = 0; i < argCount; i++) {
        params.push({ name: `arg${i}`, type: 'u32', direction: 'in' });
    }
    return { name, params, returnType: 'u32' as const, callingConvention: 'stdcall' as const };
}

const constantTableModuleDescriptor: ModuleDescriptor = {
    name: 'd3dx9',
    functions: [],
    interfaces: [ID3DXConstantTable],
};

/** A constant, or one element/member of one — everything a D3DXHANDLE can name. */
interface Node {
    constant: CtabConstant;
    /** Name as the guest sees it ("m", "m[2]", "s.field"). */
    name: string;
    /** Guest address of `name` — the handle value itself. */
    namePtr: number;
    /** Register this node starts at (base + element offset). */
    registerIndex: number;
    registerCount: number;
    /** Rows/Columns/Elements as D3DXCONSTANT_DESC reports them for THIS node. */
    rows: number;
    columns: number;
    elements: number;
    bytes: number;
    /** Index within the table's top-level constant list; -1 for a derived node. */
    topLevelIndex: number;
}

interface TableData {
    process: Process;
    table: CtabTable;
    /** Guest copy of the raw CTAB bytes — GetBufferPointer hands this out. */
    rawPtr: number;
    rawSize: number;
    /** Guest block holding every node's name string; handles point into it. */
    namesPtr: number;
    namesSize: number;
    /** Scratch register block for marshalling Set* data to the device, grown on demand. */
    scratchPtr: number;
    scratchSize: number;
    nodes: Map<number, Node>;     // namePtr → node
    byName: Map<string, Node>;    // lowercase name → node
    topLevel: Node[];
    isPixelShader: boolean;
}

const tables: Map<number, TableData> = new Map();
let tableVtable: VTableInfo | null = null;

/**
 * What actually happened on this path, for `report()`.
 *
 * The log archive drops lines under a render firehose, so "the game asked and we found no
 * CTAB" and "the game never asked" read identically there. These counters do not.
 */
const census = {
    /** Tables published (a CTAB was found and parsed). */
    built: 0,
    /** Refused: the bytecode carried no usable constant table. */
    noTable: 0,
    /** Constants across every published table. */
    constants: 0,
    /** Calls that named a handle this table does not know. */
    unresolvedHandles: 0,
    /** Register writes pushed to the device, by shader stage. */
    vertexWrites: 0,
    pixelWrites: 0,
};

export function d3dxConstantTableCensus(): Readonly<typeof census> & { live: number } {
    return { ...census, live: tables.size };
}

/** Counted by the caller that decided the bytecode has no table. */
export function noteConstantTableMissing(): void {
    census.noTable++;
}

function ensureVtable(process: Process): number {
    if (!tableVtable) {
        const vts = createVTablesFromDescriptor(process, constantTableModuleDescriptor);
        tableVtable = vts['ID3DXConstantTable'] ?? null;
    }
    return tableVtable?.address ?? 0;
}

/** Registers one element of this constant occupies. */
function registersPerElement(c: CtabConstant): number {
    const elements = Math.max(1, c.type.elements);
    return Math.max(1, Math.floor(c.registerCount / elements));
}

/**
 * Every handle-addressable node of one constant: the constant itself, plus one node per
 * array element. D3DX exposes struct members too; we publish them for a non-array struct,
 * where the member's register offset is unambiguous.
 */
function buildNodes(c: CtabConstant, topLevelIndex: number, out: Node[]): void {
    const elements = Math.max(1, c.type.elements);
    const perElement = registersPerElement(c);
    const elementBytes = typeBytes(c.type) / elements;

    out.push({
        constant: c, name: c.name, namePtr: 0,
        registerIndex: c.registerIndex, registerCount: c.registerCount,
        rows: c.type.rows, columns: c.type.columns,
        elements: c.type.elements, bytes: typeBytes(c.type),
        topLevelIndex,
    });

    if (c.type.elements > 1) {
        for (let i = 0; i < elements; i++) {
            out.push({
                constant: c, name: `${c.name}[${i}]`, namePtr: 0,
                registerIndex: c.registerIndex + i * perElement,
                registerCount: perElement,
                rows: c.type.rows, columns: c.type.columns,
                elements: 0, bytes: elementBytes,
                topLevelIndex: -1,
            });
        }
    }

    if (c.type.class === ParameterClass.Struct && c.type.elements <= 1) {
        let reg = c.registerIndex;
        for (const member of c.type.members) {
            const mRegs = Math.max(1, member.type.rows * Math.max(1, member.type.elements));
            out.push({
                constant: c, name: `${c.name}.${member.name}`, namePtr: 0,
                registerIndex: reg, registerCount: mRegs,
                rows: member.type.rows, columns: member.type.columns,
                elements: member.type.elements, bytes: typeBytes(member.type),
                topLevelIndex: -1,
            });
            reg += mRegs;
        }
    }
}

/**
 * Publish the table into guest memory: the raw CTAB bytes (GetBufferPointer) and one
 * NUL-terminated name per node (the handles). Returns 0 if the heap cannot serve it.
 */
export function createConstantTable(process: Process, tokens: Uint32Array): number {
    const table = parseShaderConstantTable(tokens);
    if (!table) return 0;
    const vtableAddr = ensureVtable(process);
    if (!vtableAddr) return 0;

    const nodes: Node[] = [];
    table.constants.forEach((c, i) => buildNodes(c, i, nodes));

    const nameBytes: number[] = [];
    const nameOffsets: number[] = [];
    for (const n of nodes) {
        nameOffsets.push(nameBytes.length);
        for (let i = 0; i < n.name.length; i++) nameBytes.push(n.name.charCodeAt(i) & 0xff);
        nameBytes.push(0);
    }
    // A shader with constants but no names would make every handle the same address.
    const namesSize = Math.max(1, nameBytes.length);

    let rawPtr = 0, namesPtr = 0;
    try {
        rawPtr = process.memory.alloc(Math.max(1, table.raw.length), 'HEAP', 'rw');
        namesPtr = process.memory.alloc(namesSize, 'HEAP', 'rw');
    } catch { /* reported below */ }
    if (!rawPtr || !namesPtr) {
        if (rawPtr) { try { process.memory.free(rawPtr); } catch { /* gone */ } }
        if (namesPtr) { try { process.memory.free(namesPtr); } catch { /* gone */ } }
        Logger.warn(LogCategory.D3D9, 'D3DXGetShaderConstantTable: guest heap could not hold the table');
        return 0;
    }
    Mem.writeBytes(rawPtr, table.raw);
    Mem.writeBytes(namesPtr, new Uint8Array(nameBytes.length ? nameBytes : [0]));

    const data: TableData = {
        process, table, rawPtr, rawSize: table.raw.length,
        namesPtr, namesSize,
        scratchPtr: 0, scratchSize: 0,
        nodes: new Map(), byName: new Map(), topLevel: [],
        isPixelShader: isPixelShaderVersion(table.version),
    };
    nodes.forEach((n, i) => {
        n.namePtr = namesPtr + nameOffsets[i]!;
        data.nodes.set(n.namePtr, n);
        // First writer wins: two constants cannot share a name, and a derived node's name
        // is unique by construction.
        if (!data.byName.has(n.name.toLowerCase())) data.byName.set(n.name.toLowerCase(), n);
        if (n.topLevelIndex >= 0) data.topLevel.push(n);
    });

    const objPtr = createComObject(vtableAddr);
    tables.set(objPtr, data);
    registerComFinalizer(objPtr, () => {
        tables.delete(objPtr);
        for (const p of [rawPtr, namesPtr, data.scratchPtr]) {
            if (p) { try { process.memory.free(p); } catch { /* the address space outlives us */ } }
        }
    });
    census.built++;
    census.constants += table.constants.length;
    Logger.log(LogCategory.D3D9,
        `D3DXGetShaderConstantTable: ${table.target || 'shader'} "${table.creator}" — ` +
        `${table.constants.length} constant(s), ${nodes.length} handle(s)`);
    return objPtr;
}

/**
 * Resolve a D3DXHANDLE. A handle we minted is a name pointer; anything else is read as a
 * string, because D3DX lets a caller pass a literal where a handle is expected and a game
 * that does so must not silently address constant 0.
 */
function resolve(data: TableData, handle: number): Node | null {
    if (!handle) return null;
    const direct = data.nodes.get(handle >>> 0);
    if (direct) return direct;
    const text = Marshaler.readString(Mem.getView() ?? new Uint8Array(0), handle >>> 0);
    const node = text ? data.byName.get(text.toLowerCase()) ?? null : null;
    if (!node) census.unresolvedHandles++;
    return node;
}

/** Guest scratch big enough for `bytes`, reused across calls on this table. */
function scratch(data: TableData, bytes: number): number {
    if (data.scratchSize >= bytes) return data.scratchPtr;
    const size = Math.max(bytes, 256);
    let ptr = 0;
    try { ptr = data.process.memory.alloc(size, 'HEAP', 'rw'); } catch { return 0; }
    if (!ptr) return 0;
    if (data.scratchPtr) { try { data.process.memory.free(data.scratchPtr); } catch { /* gone */ } }
    data.scratchPtr = ptr;
    data.scratchSize = size;
    return ptr;
}

/**
 * Push `registers` float4s at `node.registerIndex` to the device.
 *
 * Which setter depends on the REGISTER SET the constant was assigned, not on the data the
 * caller passed: an int constant written with SetFloat still lands in the int file, which
 * is what the shader reads.
 */
function pushRegisters(data: TableData, devicePtr: number, node: Node, regs: Float32Array | Int32Array): number {
    const device = devices.get(devicePtr >>> 0);
    if (!device) return D3DERR_INVALIDCALL;
    // The BOOL file is one DWORD per register; the float and int files are four. The device
    // setters count REGISTERS, so the divisor is the register's own width, not always 4.
    const dwordsPerRegister = scalarRegisterStride(node.constant.registerSet);
    let count = Math.floor(regs.length / dwordsPerRegister);
    // D3DX never writes past the constant's declared extent, so a caller that passes a
    // larger Count cannot clobber whatever the compiler placed in the next register.
    if (node.registerCount > 0) count = Math.min(count, node.registerCount);
    if (count <= 0) return S_OK;

    if (data.isPixelShader) census.pixelWrites++; else census.vertexWrites++;
    const bytes = count * dwordsPerRegister * 4;
    const ptr = scratch(data, bytes);
    if (!ptr) return E_OUTOFMEMORY;
    Mem.writeBytes(ptr, new Uint8Array(regs.buffer, regs.byteOffset, bytes));

    const mem = Mem.getView();
    if (!mem) return E_FAIL;
    switch (node.constant.registerSet) {
        case RegisterSet.Float4:
            return data.isPixelShader
                ? device.setPixelShaderConstantF(node.registerIndex, ptr, count, mem)
                : device.setVertexShaderConstantF(node.registerIndex, ptr, count, mem);
        case RegisterSet.Int4:
            return data.isPixelShader
                ? device.setPixelShaderConstantI(node.registerIndex, ptr, count, mem)
                : device.setVertexShaderConstantI(node.registerIndex, ptr, count, mem);
        case RegisterSet.Bool:
            return data.isPixelShader
                ? device.setPixelShaderConstantB(node.registerIndex, ptr, count, mem)
                : device.setVertexShaderConstantB(node.registerIndex, ptr, count, mem);
        case RegisterSet.Sampler:
            // Samplers have no constant register to write; the binding is the texture
            // stage itself, which the app sets with SetTexture(GetSamplerIndex(h), …).
            return S_OK;
    }
    return S_OK;
}

/**
 * Bool/int register files hold ONE value per register, not four. Packing them like float4
 * would set every fourth shader boolean and leave the rest at their previous value.
 */
function scalarRegisterStride(set: RegisterSet): number {
    return set === RegisterSet.Float4 || set === RegisterSet.Int4 ? 4 : 1;
}

/**
 * Lay a caller's values out the way the register file expects.
 *
 * A float4x4 is four registers of four floats; a float3 is one register with the top
 * component untouched; a bool array is one register per element. Everything Set* does is
 * this layout plus a device call.
 */
function packFloats(node: Node, values: Float32Array, transpose: boolean): Float32Array {
    const set = node.constant.registerSet;
    if (set === RegisterSet.Bool) {
        // The bool file is one BOOL per register, so the block is DENSE — packing it four
        // apart like a float4 would set every fourth shader boolean and leave the rest stale.
        const out = new Int32Array(values.length);
        for (let i = 0; i < values.length; i++) out[i] = values[i] !== 0 ? 1 : 0;
        return new Float32Array(out.buffer);
    }
    const rows = Math.max(1, node.rows);
    const cols = Math.max(1, node.columns);
    const elements = Math.max(1, node.elements);
    const cls = node.constant.type.class;

    // A matrix occupies one register per ROW (D3DXPC_MATRIX_ROWS) or per COLUMN
    // (D3DXPC_MATRIX_COLUMNS — what fxc emits by default for a column_major matrix).
    const columnMajor = cls === ParameterClass.MatrixColumns;
    const regsPerElement = columnMajor ? cols : rows;
    const out = new Float32Array(elements * regsPerElement * 4);

    for (let e = 0; e < elements; e++) {
        const src = e * rows * cols;
        const dst = e * regsPerElement * 4;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                // The caller's data is row-major (D3DXMATRIX is); `transpose` is the
                // SetMatrixTranspose family, which says the caller already flipped it.
                const value = transpose ? values[src + c * rows + r] : values[src + r * cols + c];
                if (value === undefined) continue;
                if (columnMajor) out[dst + c * 4 + r] = value;
                else out[dst + r * 4 + c] = value;
            }
        }
    }
    return out;
}

function readFloats(ptr: number, count: number): Float32Array | null {
    const bytes = Mem.readBytes(ptr >>> 0, count * 4);
    if (!bytes) return null;
    return new Float32Array(bytes.slice().buffer);
}

function readInts(ptr: number, count: number): Int32Array | null {
    const bytes = Mem.readBytes(ptr >>> 0, count * 4);
    if (!bytes) return null;
    return new Int32Array(bytes.slice().buffer);
}

export function createConstantTableExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const P = 'ID3DXConstantTable_';

    /** The (table, node) a Set* call names, or null when either is unusable. */
    const target = (self: number, handle: number): { data: TableData; node: Node } | null => {
        const data = tables.get(self >>> 0);
        if (!data) return null;
        const node = resolve(data, handle);
        return node ? { data, node } : null;
    };

    exports[`${P}QueryInterface`] = (_ctx, mem, args) => {
        const self = args[0] >>> 0, riid = args[1] >>> 0, ppv = args[2] >>> 0;
        if (!ppv) return E_POINTER;
        Mem.writeUint32(ppv, 0);
        if (!tables.has(self)) return E_NOINTERFACE;
        const iid = riid ? normalizeGuid(readGuidFromMem(mem, riid)) : null;
        if (iid !== normalizeGuid(ID3DXConstantTable.iid!) && iid !== IID_IUNKNOWN) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppv, self)) return E_POINTER;
        addComRef(self);
        return S_OK;
    };
    exports[`${P}AddRef`] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 1;
    exports[`${P}Release`] = (_ctx, _mem, args) => releaseComRef(args[0] >>> 0) ?? 0;

    exports[`${P}GetBufferPointer`] = (_ctx, _mem, args) => tables.get(args[0] >>> 0)?.rawPtr ?? 0;
    exports[`${P}GetBufferSize`] = (_ctx, _mem, args) => tables.get(args[0] >>> 0)?.rawSize ?? 0;

    exports[`${P}GetDesc`] = (_ctx, _mem, args) => {
        const data = tables.get(args[0] >>> 0);
        const pDesc = args[1] >>> 0;
        if (!data || !pDesc) return D3DERR_INVALIDCALL;
        const view = Mem.getView();
        if (!view || pDesc + TABLE_DESC_SIZE > view.length) return D3DERR_INVALIDCALL;
        // Creator points into the table blob we published, so it stays valid for the
        // object's life — a caller is allowed to keep it.
        const creatorOff = new DataView(data.table.raw.buffer, data.table.raw.byteOffset).getUint32(4, true);
        Mem.writeUint32(pDesc + 0, creatorOff ? data.rawPtr + creatorOff : 0);
        Mem.writeUint32(pDesc + 4, data.table.version >>> 0);
        Mem.writeUint32(pDesc + 8, data.table.constants.length);
        return S_OK;
    };

    exports[`${P}GetConstantDesc`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[1]);
        const pDesc = args[2] >>> 0;
        const pCount = args[3] >>> 0;
        if (!t) return D3DERR_INVALIDCALL;
        // pCount is in/out: in = how many descs fit, out = how many were written. D3DX
        // writes one per constant, and we expose exactly one desc per handle.
        if (pCount) Mem.writeUint32(pCount, 1);
        if (!pDesc) return S_OK;
        const { data, node } = t;
        const c = node.constant;
        Mem.writeUint32(pDesc + 0, node.namePtr);
        Mem.writeUint32(pDesc + 4, c.registerSet);
        Mem.writeUint32(pDesc + 8, node.registerIndex);
        Mem.writeUint32(pDesc + 12, node.registerCount);
        Mem.writeUint32(pDesc + 16, c.type.class);
        Mem.writeUint32(pDesc + 20, c.type.type);
        Mem.writeUint32(pDesc + 24, node.rows);
        Mem.writeUint32(pDesc + 28, node.columns);
        // D3DX reports a non-array as Elements = 1, while the file stores 0.
        Mem.writeUint32(pDesc + 32, Math.max(1, node.elements));
        Mem.writeUint32(pDesc + 36, c.type.members.length);
        Mem.writeUint32(pDesc + 40, node.bytes);
        // DefaultValue points INTO the published table, so it stays valid for the object's
        // life — which is what lets a caller keep it, as D3DX's own does.
        const defaultOff = node.topLevelIndex >= 0 ? c.defaultValueOffset : 0;
        Mem.writeUint32(pDesc + 44, defaultOff ? data.rawPtr + defaultOff : 0);
        return S_OK;
    };

    exports[`${P}GetSamplerIndex`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[1]);
        // A non-sampler has no sampler index; D3DX answers with the register anyway, and
        // a caller that asked about the wrong constant gets a stage it will not use.
        return t ? t.node.registerIndex : 0;
    };

    exports[`${P}GetConstant`] = (_ctx, _mem, args) => {
        const data = tables.get(args[0] >>> 0);
        const parent = args[1] >>> 0;
        const index = args[2] >>> 0;
        if (!data) return 0;
        // A NULL parent means the table itself — the top-level constant list.
        if (!parent) return data.topLevel[index]?.namePtr ?? 0;
        const node = resolve(data, parent);
        if (!node) return 0;
        const member = node.constant.type.members[index];
        return member ? (data.byName.get(`${node.name}.${member.name}`.toLowerCase())?.namePtr ?? 0) : 0;
    };

    exports[`${P}GetConstantByName`] = (_ctx, mem, args) => {
        const data = tables.get(args[0] >>> 0);
        const parent = args[1] >>> 0;
        const pName = args[2] >>> 0;
        if (!data || !pName) return 0;
        const name = Marshaler.readString(mem, pName);
        if (!name) return 0;
        const prefix = parent ? resolve(data, parent) : null;
        const full = prefix ? `${prefix.name}.${name}` : name;
        return data.byName.get(full.toLowerCase())?.namePtr ?? 0;
    };

    exports[`${P}GetConstantElement`] = (_ctx, _mem, args) => {
        const data = tables.get(args[0] >>> 0);
        if (!data) return 0;
        const node = resolve(data, args[1]);
        if (!node) return 0;
        // Element 0 of a non-array is the constant itself, which is what D3DX returns.
        if (node.elements <= 1) return (args[2] >>> 0) === 0 ? node.namePtr : 0;
        return data.byName.get(`${node.name}[${args[2] >>> 0}]`.toLowerCase())?.namePtr ?? 0;
    };

    exports[`${P}SetDefaults`] = (_ctx, _mem, args) => {
        const data = tables.get(args[0] >>> 0);
        const devicePtr = args[1] >>> 0;
        if (!data) return D3DERR_INVALIDCALL;
        if (!devices.get(devicePtr)) return D3DERR_INVALIDCALL;
        for (const node of data.topLevel) {
            const dv = node.constant.defaultValue;
            if (!dv) continue;
            const floats = new Float32Array(dv.slice().buffer, 0, Math.floor(dv.length / 4));
            const hr = pushRegisters(data, devicePtr, node, packFloats(node, floats, false));
            if (hr !== S_OK) return hr;
        }
        return S_OK;
    };

    /** SetValue takes raw bytes in the constant's own layout. */
    exports[`${P}SetValue`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[2]);
        const devicePtr = args[1] >>> 0;
        const pData = args[3] >>> 0;
        const bytes = args[4] >>> 0;
        if (!t || !pData || !bytes) return D3DERR_INVALIDCALL;
        const floats = readFloats(pData, Math.floor(Math.min(bytes, t.node.bytes) / 4));
        if (!floats) return D3DERR_INVALIDCALL;
        return pushRegisters(t.data, devicePtr, t.node, packFloats(t.node, floats, false));
    };

    const setScalarArray = (args: number[], toFloat: (raw: number) => number, count: number) => {
        const t = target(args[0], args[2]);
        const devicePtr = args[1] >>> 0;
        const pData = args[3] >>> 0;
        if (!t || !pData) return D3DERR_INVALIDCALL;
        const ints = readInts(pData, count);
        if (!ints) return D3DERR_INVALIDCALL;
        const stride = scalarRegisterStride(t.node.constant.registerSet);
        const out = new Float32Array(count * stride);
        const asInt = new Int32Array(out.buffer);
        for (let i = 0; i < count; i++) {
            if (t.node.constant.registerSet === RegisterSet.Float4) out[i * stride] = toFloat(ints[i]!);
            else asInt[i * stride] = toFloat(ints[i]!) | 0;
        }
        return pushRegisters(t.data, devicePtr, t.node, out);
    };

    exports[`${P}SetBool`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[2]);
        if (!t) return D3DERR_INVALIDCALL;
        const on = (args[3] >>> 0) !== 0;
        const stride = scalarRegisterStride(t.node.constant.registerSet);
        const out = new Float32Array(stride);
        if (t.node.constant.registerSet === RegisterSet.Float4) out[0] = on ? 1 : 0;
        else new Int32Array(out.buffer)[0] = on ? 1 : 0;
        return pushRegisters(t.data, args[1] >>> 0, t.node, out);
    };
    exports[`${P}SetBoolArray`] = (_ctx, _mem, args) =>
        setScalarArray(args as unknown as number[], (v) => (v !== 0 ? 1 : 0), args[4] >>> 0);

    exports[`${P}SetInt`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[2]);
        if (!t) return D3DERR_INVALIDCALL;
        const v = args[3] | 0;
        const stride = scalarRegisterStride(t.node.constant.registerSet);
        const out = new Float32Array(stride);
        if (t.node.constant.registerSet === RegisterSet.Float4) out[0] = v;
        else new Int32Array(out.buffer)[0] = v;
        return pushRegisters(t.data, args[1] >>> 0, t.node, out);
    };
    exports[`${P}SetIntArray`] = (_ctx, _mem, args) =>
        setScalarArray(args as unknown as number[], (v) => v | 0, args[4] >>> 0);

    exports[`${P}SetFloat`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[2]);
        if (!t) return D3DERR_INVALIDCALL;
        // The float arrives as its raw bits in a stdcall slot.
        const bits = new Uint32Array(1); bits[0] = args[3] >>> 0;
        const out = new Float32Array(scalarRegisterStride(t.node.constant.registerSet));
        out[0] = new Float32Array(bits.buffer)[0]!;
        return pushRegisters(t.data, args[1] >>> 0, t.node, out);
    };
    exports[`${P}SetFloatArray`] = (_ctx, _mem, args) => {
        const t = target(args[0], args[2]);
        const count = args[4] >>> 0;
        if (!t || !args[3] || !count) return D3DERR_INVALIDCALL;
        const floats = readFloats(args[3] >>> 0, count);
        if (!floats) return D3DERR_INVALIDCALL;
        // A float array occupies one REGISTER per element — the shader indexes c[i], not
        // a packed component — which is what D3DX does and what the compiler assumed.
        const out = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) out[i * 4] = floats[i]!;
        return pushRegisters(t.data, args[1] >>> 0, t.node, out);
    };

    const setVectors = (args: number[], count: number) => {
        const t = target(args[0], args[2]);
        if (!t || !args[3] || count <= 0) return D3DERR_INVALIDCALL;
        const floats = readFloats(args[3] >>> 0, count * 4);
        if (!floats) return D3DERR_INVALIDCALL;
        return pushRegisters(t.data, args[1] >>> 0, t.node, floats);
    };
    exports[`${P}SetVector`] = (_ctx, _mem, args) => setVectors(args as unknown as number[], 1);
    exports[`${P}SetVectorArray`] = (_ctx, _mem, args) => setVectors(args as unknown as number[], args[4] >>> 0);

    const setMatrices = (args: number[], count: number, transpose: boolean, viaPointers: boolean) => {
        const t = target(args[0], args[2]);
        const pData = args[3] >>> 0;
        if (!t || !pData || count <= 0) return D3DERR_INVALIDCALL;
        const rows = Math.max(1, t.node.rows), cols = Math.max(1, t.node.columns);
        const values = new Float32Array(count * rows * cols);
        for (let i = 0; i < count; i++) {
            // D3DXMATRIX is always 4x4 in memory even when the constant is smaller.
            let src = pData + i * 64;
            if (viaPointers) {
                const p = Mem.readUint32(pData + i * 4);
                if (p === null || !p) return D3DERR_INVALIDCALL;
                src = p >>> 0;
            }
            const m = readFloats(src, 16);
            if (!m) return D3DERR_INVALIDCALL;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    values[i * rows * cols + r * cols + c] = transpose ? m[c * 4 + r]! : m[r * 4 + c]!;
                }
            }
        }
        // `transpose` is already undone above, so the packer sees row-major data.
        const node: Node = { ...t.node, elements: count };
        return pushRegisters(t.data, args[1] >>> 0, node, packFloats(node, values, false));
    };
    exports[`${P}SetMatrix`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], 1, false, false);
    exports[`${P}SetMatrixArray`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], args[4] >>> 0, false, false);
    exports[`${P}SetMatrixPointerArray`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], args[4] >>> 0, false, true);
    exports[`${P}SetMatrixTranspose`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], 1, true, false);
    exports[`${P}SetMatrixTransposeArray`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], args[4] >>> 0, true, false);
    exports[`${P}SetMatrixTransposePointerArray`] = (_ctx, _mem, args) => setMatrices(args as unknown as number[], args[4] >>> 0, true, true);

    return exports;
}

export function resetD3DXConstantTables(): void {
    for (const objPtr of tables.keys()) forgetComObject(objPtr);
    tables.clear();
    tableVtable = null;
    for (const k of Object.keys(census) as Array<keyof typeof census>) census[k] = 0;
}
