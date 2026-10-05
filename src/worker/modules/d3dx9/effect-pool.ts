/**
 * ID3DXEffectPool — the storage a `shared` effect parameter actually lives in.
 *
 * An engine that compiles one effect per material declares its globals —
 * the view-projection matrix, the eye position, the shadow transform — as `shared` and sets
 * them ONCE, through whichever effect it happens to hold. d3dx puts those parameters in the
 * pool, so every effect created against the same pool reads the same storage. Without a pool
 * each effect keeps a private copy, exactly one of them is ever written, and every other
 * effect uploads its zero-initialised default: the draw is issued, the pipeline is valid,
 * nothing is refused, and the geometry collapses because its transform is a zero matrix.
 *
 * Sharing is by ALIASING: `EffectParameter.value` is written in place everywhere (never
 * reassigned), so handing every member the same Uint8Array makes a set through one effect
 * visible to all. An OBJECT parameter has no value block — its texture pointer is a scalar
 * field — so those are grouped instead and propagated when one is set.
 */

import type { Process } from "../../core/process";
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { InterfaceDescriptor, IUnknown, ModuleDescriptor } from "../../api/types";
import { addComRef, createComObject, registerComFinalizer, releaseComRef } from "../d3d9/shared-state";
import { Mem } from "../../core/memory/mem-accessor";
import { normalizeGuid, readGuidFromMem } from "../../core/com/typelib/typelib-types";
import type { EffectModel, EffectParameter } from "./effect-state";

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const D3DERR_INVALIDCALL = 0x8876086c;
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";

/** ID3DXEffectPool adds nothing to IUnknown — it is pure storage the runtime owns. */
const ID3DXEffectPool: InterfaceDescriptor = {
    name: "ID3DXEffectPool",
    inherits: "IUnknown",
    iid: "9537AB04-3250-412e-8213-FCD2F8677933",
    methods: [...IUnknown.methods],
};

const poolModuleDescriptor: ModuleDescriptor = {
    name: "d3dx9",
    functions: [],
    interfaces: [ID3DXEffectPool],
};

let poolVtable: VTableInfo | null = null;

/** D3DX_PARAMETER_SHARED. */
const D3DX_PARAMETER_SHARED = 0x01;

interface PoolStorage {
    /** Shared value blocks, by parameter name. */
    values: Map<string, Uint8Array>;
    /** Every parameter object registered under a name, for object-pointer propagation. */
    groups: Map<string, EffectParameter[]>;
}

const pools = new Map<number, PoolStorage>();
/** Reverse index: a shared parameter → the group it belongs to. */
const groupOf = new WeakMap<EffectParameter, EffectParameter[]>();

export function createEffectPool(poolPtr: number): void {
    const ptr = poolPtr >>> 0;
    if (!ptr || pools.has(ptr)) return;
    pools.set(ptr, { values: new Map(), groups: new Map() });
}

export function destroyEffectPool(poolPtr: number): void {
    pools.delete(poolPtr >>> 0);
}

export function effectPoolCount(): number {
    return pools.size;
}

/**
 * Bind every `shared` parameter of `model` to `poolPtr`'s storage.
 *
 * The FIRST effect to register a name seeds the pool from its own default; later effects
 * adopt what is already there. A name whose block size disagrees keeps its private copy —
 * d3dx refuses the creation outright for a type mismatch, and silently aliasing blocks of
 * different shapes would corrupt both.
 */
export function bindSharedParameters(poolPtr: number, model: EffectModel): number {
    const pool = pools.get(poolPtr >>> 0);
    if (!pool) return 0;
    let bound = 0;
    for (const param of model.parameters) {
        if (((param.flags ?? 0) & D3DX_PARAMETER_SHARED) === 0) continue;
        let group = pool.groups.get(param.name);
        if (!group) {
            group = [];
            pool.groups.set(param.name, group);
        }
        if (param.value.byteLength > 0) {
            const existing = pool.values.get(param.name);
            if (!existing) {
                pool.values.set(param.name, param.value);
            } else if (existing.byteLength === param.value.byteLength) {
                param.value = existing;
            } else {
                continue; // shape disagreement: keep the private block rather than corrupt both
            }
        }
        group.push(param);
        groupOf.set(param, group);
        bound++;
    }
    return bound;
}

/**
 * Drop `model`'s parameters out of the pool's groups when its effect dies.
 *
 * A pool outlives the effects that share through it — one pool for a whole run is the normal
 * shape — so a group that only ever grows pins every retired effect's model and makes
 * propagateSharedObject walk the dead. The pool's VALUE storage stays: it is the shared state
 * the surviving effects still alias.
 */
export function unbindSharedParameters(poolPtr: number, model: EffectModel): void {
    const pool = pools.get(poolPtr >>> 0);
    if (!pool) return;
    for (const param of model.parameters) {
        const group = groupOf.get(param);
        if (!group) continue;
        const at = group.indexOf(param);
        if (at >= 0) group.splice(at, 1);
        groupOf.delete(param);
        if (!group.length) pool.groups.delete(param.name);
    }
}

/**
 * Mirror an OBJECT parameter's newly assigned pointer onto the rest of its shared group.
 * Value parameters need nothing here — they alias one block.
 */
export function propagateSharedObject(param: EffectParameter): void {
    const group = groupOf.get(param);
    if (!group) return;
    for (const other of group) {
        if (other === param) continue;
        other.objectPtr = param.objectPtr;
        other.objectIndex = param.objectIndex;
    }
}

/** Test/reset seam: drop every pool and its storage. */
export function resetEffectPools(): void {
    pools.clear();
}

/** Reset seam for the COM vtable, mirroring resetEffectState(). */
export function resetEffectPoolVtable(): void {
    poolVtable = null;
}

export function createEffectPoolExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const ensureVtable = (): number => {
        if (!poolVtable) {
            poolVtable = createVTablesFromDescriptor(process, poolModuleDescriptor)["ID3DXEffectPool"] ?? null;
        }
        return poolVtable?.address ?? 0;
    };

    exports["D3DXCreateEffectPool"] = (_ctx, _mem, args) => {
        const ppPool = args[0] >>> 0;
        // Refuse before anything is built: a pool published to a pointer we cannot write is a
        // COM object and its storage that nothing will ever Release.
        if (!ppPool || !Mem.writeUint32(ppPool, 0)) return D3DERR_INVALIDCALL;
        const vtableAddr = ensureVtable();
        if (!vtableAddr) return D3DERR_INVALIDCALL;
        const poolPtr = createComObject(vtableAddr);
        createEffectPool(poolPtr);
        registerComFinalizer(poolPtr, () => destroyEffectPool(poolPtr));
        return Mem.writeUint32(ppPool, poolPtr) ? S_OK : E_POINTER;
    };

    exports["ID3DXEffectPool_QueryInterface"] = (_ctx, mem, args) => {
        const self = args[0] >>> 0;
        const riid = args[1] >>> 0;
        const ppv = args[2] >>> 0;
        if (!ppv) return E_POINTER;
        Mem.writeUint32(ppv, 0);
        if (!pools.has(self)) return E_NOINTERFACE;
        const iid = riid ? normalizeGuid(readGuidFromMem(mem, riid)) : null;
        if (iid !== normalizeGuid(ID3DXEffectPool.iid!) && iid !== IID_IUNKNOWN) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppv, self)) return E_POINTER;
        addComRef(self);
        return S_OK;
    };
    exports["ID3DXEffectPool_AddRef"] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 1;
    exports["ID3DXEffectPool_Release"] = (_ctx, _mem, args) => releaseComRef(args[0] >>> 0) ?? 0;

    return exports;
}
