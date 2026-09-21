/**
 * ID3DXEffect for titles that load a .fx at runtime.
 *
 * The effect is a PASS-THROUGH: we do not compile HLSL, so the technique reports one
 * pass and the state-setting calls are accepted and dropped — the app's own geometry
 * still reaches the device through Begin/BeginPass/EndPass/End, it just renders with
 * the fixed-function/shader state the app set itself.
 *
 * THE VTABLE LAYOUT IS THE CONTRACT. A guest calls slot N with the arity the real
 * interface declares; an invented order answers slot N with a method of a different
 * arg count, and the RET N mismatch walks the caller's ESP off its own frame — the
 * fault then lands in code with no connection to D3DX. So the order and the arg counts
 * below are transcribed from the ID3DXEffect declaration itself (d3dx9effect.h):
 * IUnknown, then EVERY ID3DXBaseEffect method, then the ID3DXEffect methods. An
 * addition has to keep that position, not append.
 *
 * OUT-PARAMETERS ARE PART OF THE ABI TOO: returning D3D_OK without writing one leaves
 * the caller reading its own uninitialised stack. `Begin` publishing the pass count is
 * what bounds the app's pass loop.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { IUnknown } from '../../api/types';
import { InterfaceDescriptor, ModuleDescriptor } from '../../api/types';
import { createComObject, devices } from '../d3d9/shared-state';
import { bindSharedParameters, unbindSharedParameters } from './effect-pool';
import { addComRef, registerComFinalizer, releaseComRef } from '../d3d9/com-refs';
import { normalizeGuid, readGuidFromMem } from '../../core/com/typelib/typelib-types';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { D3D_OK } from '../d3d9/resource-registry';
import { isCompiledEffect, parseCompiledEffect, STATE_PIXEL_SHADER, STATE_VERTEX_SHADER } from './effect-parser';
import {
    annotationHandle,
    decodeHandle,
    isAnnotationHandle,
    isParameterHandle,
    isPassHandle,
    isTechniqueHandle,
    findParameterIndex,
    findTechniqueIndex,
    getEffectInstance,
    noteSetTextureOutcome,
    noteNameLookup,
    handleForParameter,
    handleForMember,
    handleForPass,
    handleForTechnique,
    registerEffectInstance,
    releaseEffectInstance,
    parseSkipConstantsList,
    EffectParamClass,
    EffectParamType,
    type EffectAnnotation,
    type EffectInstance,
    type EffectModel,
    type EffectParameter,
    type EffectPass,
} from './effect-state';
import { Logger, LogCategory } from '../../core/logger';
import {
    getMatrix,
    getNumberArray,
    getVector,
    getVectorArray,
    isTextureParameter,
    readNumber,
    setMatrix,
    setMatrixArray,
    setNumberArray,
    setObjectParam,
    setRawValue,
    setScalarBool,
    setScalarFloat,
    setScalarInt,
    setVector,
    setVectorArray,
    noteSourcePointer,
    retainReturnedObject,
} from './effect-values';
import { applyPassStates, resetDeferredState, type EffectApplyDeps } from './effect-apply';

const D3DERR_INVALIDCALL = 0x8876086c;

/** Filled by createEffectExports; read by the harness `effectConstants` verb. */
export let effectAnnotationReadCensus: () => Array<{ name: string; reads: number }> = () => [];
/** No further technique — what d3dx returns once the walk runs out. */
const E_FAIL = 0x80004005;

/** Non-zero so a `handle != NULL` check reads as "found"; never dereferenced by us. */
const FAKE_HANDLE = 1;

/** [name, argCount] in vtable order; argCount INCLUDES the pushed `this` (COM stdcall). */
const EFFECT_METHODS: ReadonlyArray<readonly [string, number]> = [
    // --- ID3DXBaseEffect ---
    ['GetDesc', 2],
    ['GetParameterDesc', 3],
    ['GetTechniqueDesc', 3],
    ['GetPassDesc', 3],
    ['GetFunctionDesc', 3],
    ['GetParameter', 3],
    ['GetParameterByName', 3],
    ['GetParameterBySemantic', 3],
    ['GetParameterElement', 3],
    ['GetTechnique', 2],
    ['GetTechniqueByName', 2],
    ['GetPass', 3],
    ['GetPassByName', 3],
    ['GetFunction', 2],
    ['GetFunctionByName', 2],
    ['GetAnnotation', 3],
    ['GetAnnotationByName', 3],
    ['SetValue', 4],
    ['GetValue', 4],
    ['SetBool', 3],
    ['GetBool', 3],
    ['SetBoolArray', 4],
    ['GetBoolArray', 4],
    ['SetInt', 3],
    ['GetInt', 3],
    ['SetIntArray', 4],
    ['GetIntArray', 4],
    ['SetFloat', 3],
    ['GetFloat', 3],
    ['SetFloatArray', 4],
    ['GetFloatArray', 4],
    ['SetVector', 3],
    ['GetVector', 3],
    ['SetVectorArray', 4],
    ['GetVectorArray', 4],
    ['SetMatrix', 3],
    ['GetMatrix', 3],
    ['SetMatrixArray', 4],
    ['GetMatrixArray', 4],
    ['SetMatrixPointerArray', 4],
    ['GetMatrixPointerArray', 4],
    ['SetMatrixTranspose', 3],
    ['GetMatrixTranspose', 3],
    ['SetMatrixTransposeArray', 4],
    ['GetMatrixTransposeArray', 4],
    ['SetMatrixTransposePointerArray', 4],
    ['GetMatrixTransposePointerArray', 4],
    ['SetString', 3],
    ['GetString', 3],
    ['SetTexture', 3],
    ['GetTexture', 3],
    ['GetPixelShader', 3],
    ['GetVertexShader', 3],
    ['SetArrayRange', 4],
    // --- ID3DXEffect ---
    ['GetPool', 2],
    ['SetTechnique', 2],
    ['GetCurrentTechnique', 1],
    ['ValidateTechnique', 2],
    ['FindNextValidTechnique', 3],
    ['IsParameterUsed', 3],
    ['Begin', 3],
    ['BeginPass', 2],
    ['CommitChanges', 1],
    ['EndPass', 1],
    ['End', 1],
    ['GetDevice', 2],
    ['OnLostDevice', 1],
    ['OnResetDevice', 1],
    ['SetStateManager', 2],
    ['GetStateManager', 2],
    ['BeginParameterBlock', 1],
    ['EndParameterBlock', 1],
    ['ApplyParameterBlock', 2],
    ['DeleteParameterBlock', 2],
    ['CloneEffect', 3],
    ['SetRawValue', 5],
];

/** Methods whose RETURN VALUE is a D3DXHANDLE, not an HRESULT — 0 there means "absent". */
const HANDLE_RETURNING = new Set([
    'GetParameter', 'GetParameterByName', 'GetParameterBySemantic', 'GetParameterElement',
    'GetTechnique', 'GetTechniqueByName', 'GetPass', 'GetPassByName',
    'GetFunction', 'GetFunctionByName', 'GetAnnotation', 'GetAnnotationByName',
    'GetCurrentTechnique', 'EndParameterBlock',
]);

/** Argument index of the single out-pointer that must not be left uninitialised. */
const OUT_POINTER_ARG: Record<string, number> = {
    GetPool: 1, GetDevice: 1, GetStateManager: 1,
    GetTexture: 2, GetPixelShader: 2, GetVertexShader: 2, GetString: 2,
};

function makeMethod(name: string, argCount: number) {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: 'u32' as const })),
        returnType: 'u32' as const,
        callingConvention: 'stdcall' as const,
    };
}

const ID3DXEffect: InterfaceDescriptor = {
    name: 'ID3DXEffect',
    inherits: 'IUnknown',
    iid: 'F6CEB4B3-4E4C-40DD-B883-8D8DE5EA0CD5',
    methods: [
        ...IUnknown.methods,
        ...EFFECT_METHODS.map(([name, argCount]) => makeMethod(name, argCount)),
    ],
};

const effectModuleDescriptor: ModuleDescriptor = {
    name: 'd3dx9',
    functions: [],
    interfaces: [ID3DXEffect],
};

const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';
/** ID3DXEffect derives from ID3DXBaseEffect, so a QI for the base must succeed too. */
const IID_ID3DXBASEEFFECT = '017c18ac-103f-4417-8c51-6bf6ef1e56be';

let effectVtable: VTableInfo | null = null;
let dumpSeq = 0;
let warnedNoSaveState = false;

function ensureEffectVtable(process: Process): number {
    if (!effectVtable) {
        const tables = createVTablesFromDescriptor(process, effectModuleDescriptor);
        effectVtable = tables['ID3DXEffect'] ?? null;
    }
    return effectVtable?.address ?? 0;
}

export function createEffectExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // COM, not a placeholder: an effect is refcounted like every other object we publish, and
    // QueryInterface must PUBLISH the pointer it says it found. Answering S_OK and leaving
    // *ppvObj alone hands the caller whatever its stack held, which it then calls through.
    exports['ID3DXEffect_QueryInterface'] = (_ctx, mem, args) => {
        const self = args[0] >>> 0, riid = args[1] >>> 0, ppv = args[2] >>> 0;
        if (!ppv) return E_POINTER;
        Mem.writeUint32(ppv, 0);
        const iid = riid ? normalizeGuid(readGuidFromMem(mem, riid)) : null;
        if (iid !== normalizeGuid(ID3DXEffect.iid!) && iid !== IID_ID3DXBASEEFFECT && iid !== IID_IUNKNOWN) {
            return E_NOINTERFACE;
        }
        if (!Mem.writeUint32(ppv, self)) return E_POINTER;
        addComRef(self);
        return D3D_OK;
    };
    exports['ID3DXEffect_AddRef'] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 2;
    exports['ID3DXEffect_Release'] = (_ctx, _mem, args) => releaseComRef(args[0] >>> 0) ?? 0;

    for (const [name] of EFFECT_METHODS) {
        const outArg = OUT_POINTER_ARG[name];
        if (HANDLE_RETURNING.has(name)) {
            exports[`ID3DXEffect_${name}`] = () => FAKE_HANDLE;
        } else if (outArg !== undefined) {
            exports[`ID3DXEffect_${name}`] = (_ctx, _mem, args) => {
                const p = args[outArg] >>> 0;
                if (p) Mem.writeUint32(p, 0);
                return D3D_OK;
            };
        } else {
            exports[`ID3DXEffect_${name}`] = () => D3D_OK;
        }
    }

    // -- methods backed by the parsed model --------------------------------
    // Each falls back to the pass-through answer when the effect could not be parsed, so a
    // title whose effect we failed to read behaves exactly as it did before.

    /** A guest-visible copy of a model string; D3DX hands out pointers the app keeps. */
    const guestStrings = new Map<string, number>();
    const guestString = (text: string): number => {
        const cached = guestStrings.get(text);
        if (cached !== undefined) return cached;
        const addr = process.memory.alloc(text.length + 1, 'THUNK_DATA', 'rw') >>> 0;
        if (!addr) return 0;
        const bytes = new Uint8Array(text.length + 1);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        Mem.writeBytes(addr, bytes);
        guestStrings.set(text, addr);
        return addr;
    };

    const instanceOf = (effectPtr: number) => getEffectInstance(effectPtr >>> 0);

    /**
     * Every 0 we hand back is an answer the app acts on — it is how d3dx says "no such
     * thing". When a title then calls a method on what it got, the crash lands far from
     * here, so name the refusal at the moment it happens. Refusals are rare by nature; a
     * flood of them is itself the finding.
     */
    const refuse = (method: string, what: string, inst?: { model: EffectModel }): 0 => {
        Logger.warn(
            LogCategory.D3D9,
            `d3dx9: ${method} found no ${what}` +
            (inst
                ? ` (${inst.model.parameters.length} parameter(s), ${inst.model.techniques.length} technique(s))`
                : ''),
        );
        return 0;
    };

    /**
     * Guest-visible copy of one pass's shader bytecode, allocated once per object slot.
     * The effect blob itself was a transient buffer the caller has already freed, so the
     * bytes have to live somewhere we own for as long as the app may look at them.
     */
    /**
     * Guest-memory copies of an effect's object payloads, PER EFFECT.
     *
     * An object index is an index into ONE effect's object table, so it only identifies a blob
     * together with the effect that owns it. Keyed by device instead, every .fx an engine
     * loads shares one namespace: the first effect to publish its object 16 wins, and every
     * later effect asking for its own object 16 is handed those bytes. The shader still
     * parses — it is a real shader, just the wrong one — so the failure surfaces as "expected
     * a pixel shader" or "unterminated bytecode" on a blob whose own header is perfectly
     * valid, and the pass silently binds shader 0.
     */
    const shaderBytes = new WeakMap<EffectInstance, Map<number, number>>();
    const objectBytesPtr = (inst: EffectInstance, objectIndex: number): number => {
        if (objectIndex < 0) return 0;
        const data = inst.model.objects[objectIndex]?.data;
        if (!data || !data.length) return 0;
        let perEffect = shaderBytes.get(inst);
        if (!perEffect) {
            perEffect = new Map<number, number>();
            shaderBytes.set(inst, perEffect);
        }
        const cached = perEffect.get(objectIndex);
        if (cached !== undefined) return cached;
        const addr = process.memory.alloc(data.length, 'THUNK_DATA', 'rw') >>> 0;
        if (!addr) return 0;
        Mem.writeBytes(addr, data);
        perEffect.set(objectIndex, addr);
        return addr;
    };
    const shaderBytesPtr = (inst: EffectInstance, pass: EffectPass, state: number): number => {
        const assignment = pass.assignments.find((a) => a.state === state);
        return assignment ? objectBytesPtr(inst, assignment.objectIndex) : 0;
    };

    /**
     * The device an effect applies to, plus the per-turn guest view the shader-creation path
     * reads bytecode through. The view is re-derived on every call: a stored one detaches the
     * moment WASM memory grows.
     */
    const applyDepsFor = (inst: EffectInstance, mem: Uint8Array): EffectApplyDeps | null => {
        const device = devices.get(inst.devicePtr >>> 0);
        if (!device) return null;
        return {
            device,
            mem,
            publishObject: (index: number) => objectBytesPtr(inst, index),
        };
    };

    exports['ID3DXEffect_GetDesc'] = (_ctx, _mem, args) => {
        const desc = args[1] >>> 0;
        if (!desc) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        Mem.writeUint32(desc, guestString(inst?.model.creator || 'BottleShip'));
        Mem.writeUint32(desc + 4, inst ? inst.model.parameters.length : 0);
        Mem.writeUint32(desc + 8, inst ? inst.model.techniques.length : 1);
        Mem.writeUint32(desc + 12, 0);
        return D3D_OK;
    };

    exports['ID3DXEffect_GetTechnique'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        const index = args[1] >>> 0;
        if (!inst) return FAKE_HANDLE;
        return index < inst.model.techniques.length ? handleForTechnique(index) : 0;
    };

    exports['ID3DXEffect_GetTechniqueByName'] = (_ctx, mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const name = args[1] ? Marshaler.readString(mem, args[1] >>> 0) : '';
        const index = findTechniqueIndex(inst.model, name);
        return index >= 0 ? handleForTechnique(index) : refuse('GetTechniqueByName', `technique "${name}"`, inst);
    };

    /** D3DXTECHNIQUE_DESC { LPCSTR Name; UINT Passes; UINT Annotations; } */
    exports['ID3DXEffect_GetTechniqueDesc'] = (_ctx, _mem, args) => {
        const desc = args[2] >>> 0;
        if (!desc) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        if (!inst) {
            Mem.writeUint32(desc, 0);
            Mem.writeUint32(desc + 4, 1);
            Mem.writeUint32(desc + 8, 0);
            return D3D_OK;
        }
        // A handle we do not recognise is NOT "the current technique": substituting one
        // hands the caller a different technique's name under the name it asked about, and
        // its own registry then misses every later lookup. Fail instead.
        const handle = decodeHandle(args[1] >>> 0);
        const index = handle
            ? (isTechniqueHandle(handle) ? handle.index : -1)
            : inst.currentTechnique;
        const technique = index >= 0 ? inst.model.techniques[index] : undefined;
        if (!technique) {
            // The caller acts on this answer, so a refusal it did not expect is worth a line:
            // it means we handed out a handle earlier that we cannot now resolve.
            Logger.warn(
                LogCategory.D3D9,
                `d3dx9: GetTechniqueDesc refused handle 0x${(args[1] >>> 0).toString(16)} ` +
                `(${inst.model.techniques.length} technique(s), current=${inst.currentTechnique})`,
            );
            return D3DERR_INVALIDCALL;
        }
        Mem.writeUint32(desc, guestString(technique.name));
        Mem.writeUint32(desc + 4, technique.passes.length);
        Mem.writeUint32(desc + 8, technique.annotations.length);
        return D3D_OK;
    };

    exports['ID3DXEffect_SetTechnique'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return D3D_OK;
        const handle = decodeHandle(args[1] >>> 0);
        if (!handle || !isTechniqueHandle(handle) || handle.index >= inst.model.techniques.length) {
            return D3DERR_INVALIDCALL;
        }
        inst.currentTechnique = handle.index;
        return D3D_OK;
    };

    exports['ID3DXEffect_GetCurrentTechnique'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        return handleForTechnique(inst.currentTechnique >= 0 ? inst.currentTechnique : 0);
    };

    exports['ID3DXEffect_GetParameterByName'] = (_ctx, mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const name = args[2] ? Marshaler.readString(mem, args[2] >>> 0) : '';
        const parentHandle = args[1] >>> 0;
        if (parentHandle) {
            // Scoped to a struct: its members are named without the parent prefix.
            const kids = childrenOf(args[0], parentHandle);
            const at = kids ? kids.members.findIndex((m) => m.name === name) : -1;
            noteNameLookup('GetParameterByName(scoped)', name, at >= 0);
            return at >= 0
                ? handleForMember(kids!.parentIndex, at)
                : refuse('GetParameterByName', `member "${name}"`, inst);
        }
        const index = findParameterIndex(inst.model, name);
        noteNameLookup('GetParameterByName', name, index >= 0);
        return index >= 0 ? handleForParameter(index) : refuse('GetParameterByName', `parameter "${name}"`, inst);
    };

    /**
     * GetParameter(hParent, Index). A NULL parent walks the TOP-LEVEL parameters; a non-NULL
     * one walks that parameter's MEMBERS. Ignoring the parent answered a struct-member query
     * with an unrelated top-level parameter, so an engine enumerating a block of material
     * parameters bound its data to the wrong identities.
     */
    exports['ID3DXEffect_GetParameter'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const index = args[2] >>> 0;
        const parentHandle = args[1] >>> 0;
        if (!parentHandle) {
            return index < inst.model.parameters.length ? handleForParameter(index) : 0;
        }
        const kids = childrenOf(args[0], parentHandle);
        if (!kids || index >= kids.members.length) return 0;
        return handleForMember(kids.parentIndex, index);
    };

    /** GetParameterElement(hParent, Index) — the Index'th ELEMENT of an array parameter. */
    exports['ID3DXEffect_GetParameterElement'] = (_ctx, _mem, args) => {
        const index = args[2] >>> 0;
        const kids = childrenOf(args[0], args[1] >>> 0);
        if (!kids || index >= kids.members.length) return 0;
        return handleForMember(kids.parentIndex, index);
    };

    /**
     * The children a handle can address under one parent. An ARRAY answers with its ELEMENTS
     * (that is what D3DX's GetParameter/GetParameterElement return for one), a struct with its
     * fields. One accessor, because the handle that hands an index out and the resolver that
     * reads it back must index the SAME list or every child resolves to a stranger.
     */
    const childListOf = (param: EffectParameter): EffectParameter[] =>
        param.elementsList ?? param.members;

    const parameterFor = (effectPtr: number, handleValue: number) => {
        const inst = instanceOf(effectPtr);
        if (!inst) return null;
        const handle = decodeHandle(handleValue >>> 0);
        if (!handle || !isParameterHandle(handle)) return null;
        // `sub` names the OWNING top-level parameter: the handle addresses one of its children
        // (a struct field, or an array element). Resolving it to parameters[index] instead —
        // which is what ignoring the parent did — returns a different parameter entirely.
        const parent = handle.sub >= 0 ? inst.model.parameters[handle.sub] : null;
        const param = parent ? childListOf(parent)[handle.index] : inst.model.parameters[handle.index];
        return param ? { inst, param } : null;
    };

    /** The children an hParent exposes: struct members, or the elements of an array. */
    const childrenOf = (effectPtr: number, parentHandle: number): {
        parentIndex: number; members: EffectParameter[];
    } | null => {
        const inst = instanceOf(effectPtr);
        if (!inst) return null;
        const handle = decodeHandle(parentHandle >>> 0);
        // Only a TOP-LEVEL parent can be addressed: `sub` is the single parent slot, so a
        // member-of-a-member has nowhere to record its own parent. Refuse rather than alias.
        if (!handle || !isParameterHandle(handle) || handle.sub >= 0) return null;
        const parent = inst.model.parameters[handle.index];
        return parent ? { parentIndex: handle.index, members: childListOf(parent) } : null;
    };

    /**
     * D3DXPARAMETER_DESC: Name, Semantic, Class, Type, Rows, Columns, Elements,
     * Annotations, StructMembers, Bytes.
     */
    /** D3DXPARAMETER_DESC.Bytes, per Wine's d3dx9: see the note in GetParameterDesc. */
    const parameterBytes = (param: EffectParameter): number => {
        if (param.paramClass !== EffectParamClass.Object) return param.value.length;
        const isSampler = param.type >= EffectParamType.Sampler && param.type <= EffectParamType.SamplerCube;
        return isSampler ? 0 : 4 * Math.max(1, param.elements);
    };

    /**
     * GetParameterDesc also answers for an ANNOTATION handle — an annotation IS a parameter in
     * D3DX's model, and reading its NAME back is how an app identifies one: a SAS engine walks
     * GetAnnotation and asks each result for its desc to find "SasBindAddress". Refusing the
     * handle would leave it able to read an annotation's value but never its name.
     */
    const annotationForHandle = (effectPtr: number, handleValue: number) => {
        const inst = instanceOf(effectPtr);
        if (!inst) return null;
        const handle = decodeHandle(handleValue >>> 0);
        if (!handle || !isAnnotationHandle(handle)) return null;
        return inst.annotations[handle.index] ?? null;
    };

    exports['ID3DXEffect_GetParameterDesc'] = (_ctx, _mem, args) => {
        const desc = args[2] >>> 0;
        if (!desc) return D3DERR_INVALIDCALL;
        const ann = annotationForHandle(args[0], args[1]);
        if (ann) {
            const elements = ann.elements ?? 0;
            const rows = ann.rows ?? 1;
            const columns = ann.columns ?? 1;
            const isString = ann.type === EffectParamType.String;
            Mem.writeUint32(desc + 0, guestString(ann.name));
            Mem.writeUint32(desc + 4, 0);                       // annotations carry no semantic
            Mem.writeUint32(desc + 8, ann.paramClass ?? (isString ? EffectParamClass.Object : EffectParamClass.Scalar));
            Mem.writeUint32(desc + 12, ann.type);
            Mem.writeUint32(desc + 16, rows);
            Mem.writeUint32(desc + 20, columns);
            Mem.writeUint32(desc + 24, elements);
            Mem.writeUint32(desc + 28, 0);                      // an annotation has none of its own
            Mem.writeUint32(desc + 32, 0);
            Mem.writeUint32(desc + 36, 2);                      // D3DX_PARAMETER_ANNOTATION
            Mem.writeUint32(desc + 40, isString ? 4 : (ann.value?.length ?? 0));
            return D3D_OK;
        }
        const found = parameterFor(args[0], args[1]);
        if (!found) return D3DERR_INVALIDCALL;
        const { param } = found;
        Mem.writeUint32(desc, guestString(param.name));
        Mem.writeUint32(desc + 4, param.semantic ? guestString(param.semantic) : 0);
        Mem.writeUint32(desc + 8, param.paramClass);
        Mem.writeUint32(desc + 12, param.type);
        Mem.writeUint32(desc + 16, param.rows);
        Mem.writeUint32(desc + 20, param.columns);
        Mem.writeUint32(desc + 24, param.elements);
        Mem.writeUint32(desc + 28, param.annotations.length);
        Mem.writeUint32(desc + 32, param.members.length);
        // D3DXPARAMETER_DESC ends { ... StructMembers, DWORD Flags, UINT Bytes } — ELEVEN
        // fields, 44 bytes; an engine lays out its own per-material storage from Bytes, so
        // both tail fields have to be written. Per Wine's d3dx9 (effect.c): numerics are
        // 4*rows*columns (per element), an object parameter is one interface POINTER, and a
        // SAMPLER is zero — a sampler's value lives in its state block, not in a value slot.
        Mem.writeUint32(desc + 36, param.flags ?? 0);
        Mem.writeUint32(desc + 40, parameterBytes(param));
        return D3D_OK;
    };

    // -- parameter values --------------------------------------------------
    // The effect OWNS a parameter's value between the app's Set and the pass application
    // that binds it to a shader constant, so a setter that returns D3D_OK without storing
    // anything renders the whole effect from its compile-time defaults.

    const scratch = new DataView(new ArrayBuffer(8));
    /** A float argument arrives as its raw bits in a stdcall dword. */
    const asFloat = (bits: number): number => {
        scratch.setUint32(0, bits >>> 0, true);
        return scratch.getFloat32(0, true);
    };

    const readFloats = (ptr: number, count: number): Float32Array | null => {
        if (!ptr || count <= 0) return null;
        const bytes = Mem.readBytes(ptr, count * 4);
        return bytes ? new Float32Array(bytes.slice().buffer) : null;
    };

    const readInts = (ptr: number, count: number): Int32Array | null => {
        if (!ptr || count <= 0) return null;
        const bytes = Mem.readBytes(ptr, count * 4);
        return bytes ? new Int32Array(bytes.slice().buffer) : null;
    };

    /** D3DXMATRIX is 16 floats; an array of them is contiguous. */
    const readMatrices = (ptr: number, count: number): Float32Array | null => readFloats(ptr, count * 16);

    /** SetMatrixPointerArray hands us an array of POINTERS, each to one matrix. */
    const readMatrixPointers = (ptr: number, count: number): Float32Array | null => {
        const pointers = readInts(ptr, count);
        if (!pointers) return null;
        const out = new Float32Array(count * 16);
        for (let i = 0; i < count; i++) {
            const one = readFloats(pointers[i]! >>> 0, 16);
            if (one) out.set(one, i * 16);
        }
        return out;
    };

    /**
     * An annotation, viewed as the read-only parameter D3DX treats it as.
     *
     * In D3DX's model an annotation IS a parameter: the same handle space, the same
     * GetInt/GetBool/GetFloat/GetValue getters, so every value getter has to accept one — an
     * `int MaxLocalLights = 3;` annotation is how a SAS effect declares a capability, and a
     * refusal leaves the caller reading whatever its out-param already held. Cached per
     * annotation: these are read every frame.
     */
    const annotationViews = new WeakMap<EffectAnnotation, EffectParameter>();
    const annotationAsParameter = (inst: EffectInstance, annotation: EffectAnnotation): EffectParameter => {
        let view = annotationViews.get(annotation);
        if (!view) {
            view = {
                name: annotation.name,
                semantic: "",
                type: annotation.type,
                paramClass: annotation.paramClass ?? EffectParamClass.Scalar,
                rows: annotation.rows ?? 1,
                columns: annotation.columns ?? 1,
                elements: annotation.elements ?? 0,
                annotations: [],
                members: [],
                value: annotation.value ?? new Uint8Array(0),
                objectPtr: 0,
                objectIndex: annotation.objectIndex ?? -1,
            };
            annotationViews.set(annotation, view);
        }
        return view;
    };

    /**
     * Which ANNOTATIONS the app reads the value of, by name.
     *
     * An annotation is how a SAS/SAGE effect tells the engine what to do with a parameter
     * ("unmanaged", "SasBindAddress", "MaxLocalLights"), so "did the app ever read this one,
     * and did we answer" is the difference between the engine classifying a parameter and
     * falling back to its authored default. Nothing else in a frame shows that decision.
     */
    const annotationReads = new Map<string, number>();
    const noteAnnotationRead = (name: string): void => {
        if (annotationReads.size < 256 || annotationReads.has(name)) {
            annotationReads.set(name, (annotationReads.get(name) ?? 0) + 1);
        }
    };
    effectAnnotationReadCensus = () => [...annotationReads.entries()]
        .map(([name, reads]) => ({ name, reads }))
        .sort((a, b) => b.reads - a.reads);

    /** parameterFor, widened to the annotation handles the READ path must also answer. */
    const readableFor = (effectPtr: number, handleValue: number) => {
        const direct = parameterFor(effectPtr, handleValue);
        if (direct) return direct;
        const inst = instanceOf(effectPtr);
        if (!inst) return null;
        const handle = decodeHandle(handleValue >>> 0);
        if (!handle || !isAnnotationHandle(handle)) return null;
        const annotation = inst.annotations[handle.index];
        if (annotation) noteAnnotationRead(annotation.name);
        return annotation ? { inst, param: annotationAsParameter(inst, annotation) } : null;
    };

    const withParam = (
        effectPtr: number,
        handleValue: number,
        apply: (param: EffectParameter) => boolean,
    ): number => {
        const found = parameterFor(effectPtr, handleValue);
        if (!found) return D3DERR_INVALIDCALL;
        return apply(found.param) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    /**
     * SetRawValue(hParameter, pData, ByteOffset, Bytes) — the bulk setter an engine uses to
     * push a whole constant block in one call, bypassing the typed setters entirely.
     *
     * `Bytes` is clamped to what the parameter actually owns rather than trusted — d3dx writes
     * into the parameter's own block, not past it.
     */
    exports['ID3DXEffect_SetRawValue'] = (_ctx, _mem, args) => {
        const found = parameterFor(args[0], args[1]);
        if (!found) return D3DERR_INVALIDCALL;
        const offset = args[3] >>> 0;
        const bytes = Mem.readBytes(args[2] >>> 0, args[4] >>> 0);
        if (!bytes) return D3DERR_INVALIDCALL;
        // An object parameter has no value block: its four bytes ARE the interface pointer.
        if (isTextureParameter(found.param)) {
            if (offset !== 0 || bytes.length < 4) return D3DERR_INVALIDCALL;
            setObjectParam(found.param, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                .getUint32(0, true));
            noteSetTextureOutcome(found.param.objectPtr ? "setRaw" : "setRawNull");
            return D3D_OK;
        }
        const block = found.param.value;
        if (!block.length || offset >= block.length) return D3DERR_INVALIDCALL;
        block.set(bytes.subarray(0, Math.min(bytes.length, block.length - offset)), offset);
        return D3D_OK;
    };

    exports['ID3DXEffect_SetValue'] = (_ctx, _mem, args) => {
        const bytes = Mem.readBytes(args[2] >>> 0, args[3] >>> 0);
        if (!bytes) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setRawValue(param, bytes));
    };

    exports['ID3DXEffect_GetValue'] = (_ctx, _mem, args) => {
        const found = readableFor(args[0], args[1]);
        const out = args[2] >>> 0;
        if (!found || !out) return D3DERR_INVALIDCALL;
        // The mirror of SetValue's texture case: an object parameter's value IS its pointer.
        if (isTextureParameter(found.param)) {
            if ((args[3] >>> 0) < 4) return D3DERR_INVALIDCALL;
            return Mem.writeUint32(out, retainReturnedObject(found.param.objectPtr)) ? D3D_OK : D3DERR_INVALIDCALL;
        }
        if ((args[3] >>> 0) < found.param.value.length) return D3DERR_INVALIDCALL;
        return Mem.writeBytes(out, found.param.value) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['ID3DXEffect_SetBool'] = (_ctx, _mem, args) =>
        withParam(args[0], args[1], (param) => setScalarBool(param, args[2] >>> 0));

    exports['ID3DXEffect_SetInt'] = (_ctx, _mem, args) =>
        withParam(args[0], args[1], (param) => setScalarInt(param, args[2] | 0));

    exports['ID3DXEffect_SetFloat'] = (_ctx, _mem, args) =>
        withParam(args[0], args[1], (param) => setScalarFloat(param, asFloat(args[2])));

    exports['ID3DXEffect_SetBoolArray'] = (_ctx, _mem, args) => {
        const values = readInts(args[2] >>> 0, args[3] >>> 0);
        if (!values) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setNumberArray(param, values, false));
    };

    exports['ID3DXEffect_SetIntArray'] = (_ctx, _mem, args) => {
        const values = readInts(args[2] >>> 0, args[3] >>> 0);
        if (!values) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setNumberArray(param, values, false));
    };

    exports['ID3DXEffect_SetFloatArray'] = (_ctx, _mem, args) => {
        const values = readFloats(args[2] >>> 0, args[3] >>> 0);
        if (!values) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setNumberArray(param, values, true));
    };

    exports['ID3DXEffect_SetVector'] = (_ctx, _mem, args) => {
        const v = readFloats(args[2] >>> 0, 4);
        if (!v) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setVector(param, v));
    };

    exports['ID3DXEffect_SetVectorArray'] = (_ctx, _mem, args) => {
        const count = args[3] >>> 0;
        const v = readFloats(args[2] >>> 0, count * 4);
        if (!v) return D3DERR_INVALIDCALL;
        return withParam(args[0], args[1], (param) => setVectorArray(param, v, count));
    };

    exports['ID3DXEffect_GetVectorArray'] = (_ctx, _mem, args) => {
        const found = readableFor(args[0], args[1]);
        const out = args[2] >>> 0;
        const count = args[3] >>> 0;
        if (!found || !out || !count) return D3DERR_INVALIDCALL;
        const v = new Float32Array(count * 4);
        getVectorArray(found.param, v, count);
        for (let i = 0; i < v.length; i++) {
            if (!Mem.writeFloat32(out + i * 4, v[i]!)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['ID3DXEffect_GetVector'] = (_ctx, _mem, args) => {
        const found = readableFor(args[0], args[1]);
        const out = args[2] >>> 0;
        if (!found || !out) return D3DERR_INVALIDCALL;
        const v = new Float32Array(4);
        getVector(found.param, v);
        for (let i = 0; i < 4; i++) Mem.writeFloat32(out + i * 4, v[i]!);
        return D3D_OK;
    };

    const setMatrixMethod = (transpose: boolean): ThunkImplementation => (ctx, _mem, args) => {
        const m = readMatrices(args[2] >>> 0, 1);
        if (!m) return D3DERR_INVALIDCALL;
        // Arguments start at esp+4, so [esp] is the guest return address: the ONLY thing that
        // names which engine routine pushed this value.
        noteSourcePointer(args[2] >>> 0, Mem.readUint32(ctx.esp >>> 0) ?? 0);
        return withParam(args[0], args[1], (param) => setMatrix(param, m, transpose));
    };

    const setMatrixArrayMethod = (transpose: boolean, pointers: boolean): ThunkImplementation =>
        (_ctx, _mem, args) => {
            const count = args[3] >>> 0;
            const m = pointers ? readMatrixPointers(args[2] >>> 0, count) : readMatrices(args[2] >>> 0, count);
            if (!m) return D3DERR_INVALIDCALL;
            return withParam(args[0], args[1], (param) => setMatrixArray(param, m, count, transpose));
        };

    exports['ID3DXEffect_SetMatrix'] = setMatrixMethod(false);
    exports['ID3DXEffect_SetMatrixTranspose'] = setMatrixMethod(true);
    exports['ID3DXEffect_SetMatrixArray'] = setMatrixArrayMethod(false, false);
    exports['ID3DXEffect_SetMatrixTransposeArray'] = setMatrixArrayMethod(true, false);
    exports['ID3DXEffect_SetMatrixPointerArray'] = setMatrixArrayMethod(false, true);
    exports['ID3DXEffect_SetMatrixTransposePointerArray'] = setMatrixArrayMethod(true, true);

    const getMatrixMethod = (transpose: boolean): ThunkImplementation => (_ctx, _mem, args) => {
        const found = readableFor(args[0], args[1]);
        const out = args[2] >>> 0;
        if (!found || !out) return D3DERR_INVALIDCALL;
        const m = new Float32Array(16);
        getMatrix(found.param, m, transpose);
        for (let i = 0; i < 16; i++) Mem.writeFloat32(out + i * 4, m[i]!);
        return D3D_OK;
    };

    exports['ID3DXEffect_GetMatrix'] = getMatrixMethod(false);
    exports['ID3DXEffect_GetMatrixTranspose'] = getMatrixMethod(true);

    /**
     * A texture parameter's value IS the interface pointer, and the pass binds it to whatever
     * sampler unit the shader declared for that name.
     */
    exports['ID3DXEffect_SetTexture'] = (_ctx, _mem, args) => {
        const found = parameterFor(args[0], args[1]);
        if (!found) {
            noteSetTextureOutcome("noSuchParameter");
            return D3DERR_INVALIDCALL;
        }
        if (!isTextureParameter(found.param)) {
            noteSetTextureOutcome(`notATexture:class${found.param.paramClass}/type${found.param.type}`);
            return D3DERR_INVALIDCALL;
        }
        setObjectParam(found.param, args[2]);
        noteSetTextureOutcome(args[2] ? "set" : "setNull");
        return D3D_OK;
    };

    exports['ID3DXEffect_GetTexture'] = (_ctx, _mem, args) => {
        const out = args[2] >>> 0;
        if (!out) return D3DERR_INVALIDCALL;
        const found = parameterFor(args[0], args[1]);
        Mem.writeUint32(out, found ? retainReturnedObject(found.param.objectPtr) : 0);
        return found ? D3D_OK : D3DERR_INVALIDCALL;
    };

    const getScalarMethod = (read: (param: EffectParameter) => number, float: boolean): ThunkImplementation =>
        (_ctx, _mem, args) => {
            const found = readableFor(args[0], args[1]);
            const out = args[2] >>> 0;
            if (!found || !out) return D3DERR_INVALIDCALL;
            const value = read(found.param);
            const ok = float ? Mem.writeFloat32(out, value) : Mem.writeUint32(out, value >>> 0);
            return ok ? D3D_OK : D3DERR_INVALIDCALL;
        };

    exports['ID3DXEffect_GetFloat'] = getScalarMethod((param) => readNumber(param, 0), true);
    exports['ID3DXEffect_GetInt'] = getScalarMethod((param) => readNumber(param, 0) | 0, false);
    exports['ID3DXEffect_GetBool'] = getScalarMethod((param) => (readNumber(param, 0) ? 1 : 0), false);

    const getArrayMethod = (float: boolean): ThunkImplementation => (_ctx, _mem, args) => {
        const found = readableFor(args[0], args[1]);
        const out = args[2] >>> 0;
        const count = args[3] >>> 0;
        if (!found || !out || !count) return D3DERR_INVALIDCALL;
        const values = float ? new Float32Array(count) : new Int32Array(count);
        getNumberArray(found.param, values);
        for (let i = 0; i < count; i++) {
            const ok = float ? Mem.writeFloat32(out + i * 4, values[i]!) : Mem.writeUint32(out + i * 4, values[i]! >>> 0);
            if (!ok) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['ID3DXEffect_GetFloatArray'] = getArrayMethod(true);
    exports['ID3DXEffect_GetIntArray'] = getArrayMethod(false);
    exports['ID3DXEffect_GetBoolArray'] = getArrayMethod(false);

    /**
     * A string parameter's value is a pointer the caller dereferences immediately, so a 0
     * here is a NULL string handed straight to the app's own strcmp.
     */
    exports['ID3DXEffect_GetString'] = (_ctx, _mem, args) => {
        const out = args[2] >>> 0;
        if (!out) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        const handle = inst ? decodeHandle(args[1] >>> 0) : null;
        if (inst && handle && isAnnotationHandle(handle)) {
            const annotation = inst.annotations[handle.index];
            Mem.writeUint32(out, guestString(annotation?.stringValue ?? ''));
            return D3D_OK;
        }
        const found = parameterFor(args[0], args[1]);
        const text = found && found.param.type === EffectParamType.String && found.param.objectIndex >= 0
            ? found.inst.model.objects[found.param.objectIndex]?.text
            : undefined;
        Mem.writeUint32(out, guestString(text ?? ''));
        return D3D_OK;
    };

    /** The annotations of whatever object the handle names — effect-level when it is NULL. */
    const annotationsOf = (inst: EffectInstance, handleValue: number) => {
        const handle = decodeHandle(handleValue >>> 0);
        if (!handle) return [];
        if (isParameterHandle(handle)) return inst.model.parameters[handle.index]?.annotations ?? [];
        if (isTechniqueHandle(handle)) return inst.model.techniques[handle.index]?.annotations ?? [];
        if (isPassHandle(handle)) {
            return inst.model.techniques[handle.sub]?.passes[handle.index]?.annotations ?? [];
        }
        return [];
    };

    exports['ID3DXEffect_GetAnnotation'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const list = annotationsOf(inst, args[1]);
        const index = args[2] >>> 0;
        return index < list.length ? annotationHandle(inst, list[index]!) : 0;
    };

    /**
     * 0 means "no such annotation", and that is an answer an app acts on — handing back a
     * handle for one that does not exist makes it read a value that was never written.
     */
    exports['ID3DXEffect_GetAnnotationByName'] = (_ctx, mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const name = args[2] ? Marshaler.readString(mem, args[2] >>> 0) : '';
        const wanted = name.toLowerCase();
        const list = annotationsOf(inst, args[1]);
        const found = list.find((a) => a.name.toLowerCase() === wanted);
        const handle = decodeHandle(args[1] >>> 0);
        let kind: string;
        if (!handle) kind = "badHandle";
        else if (isPassHandle(handle)) {
            // "no such pass" and "a pass with no annotations" are the same empty list, and
            // they need opposite fixes — say which one this was.
            const technique = inst.model.techniques[handle.sub];
            const pass = technique?.passes[handle.index];
            kind = !technique ? `noTechnique(t${handle.sub}/${inst.model.techniques.length})`
                : !pass ? `noPass(t${handle.sub},p${handle.index}/${technique.passes.length})`
                : "pass";
        } else if (isTechniqueHandle(handle)) kind = "technique";
        else if (isParameterHandle(handle)) kind = "parameter";
        else kind = `kind${handle.kind}`;
        noteNameLookup('GetAnnotationByName', name, !!found, `${kind}:has${list.length}`);
        return found ? annotationHandle(inst, found) : refuse('GetAnnotationByName', `annotation "${name}"`, inst);
    };

    /**
     * GetDevice hands back the device the effect was created against, with a reference the
     * caller owns. Writing 0 and returning D3D_OK — which the generic out-pointer default
     * did — gives the app a NULL it immediately calls a method on, and the fault then lands
     * in the app's own code with nothing pointing back here.
     */
    exports['ID3DXEffect_GetDevice'] = (_ctx, _mem, args) => {
        const out = args[1] >>> 0;
        if (!out) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        const devicePtr = inst?.devicePtr ?? 0;
        if (!devicePtr) {
            Mem.writeUint32(out, 0);
            return D3DERR_INVALIDCALL;
        }
        addComRef(devicePtr);
        Mem.writeUint32(out, devicePtr);
        return D3D_OK;
    };

    exports['ID3DXEffect_GetPass'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return FAKE_HANDLE;
        const handle = decodeHandle(args[1] >>> 0);
        const technique = handle && isTechniqueHandle(handle) ? handle.index : inst.currentTechnique;
        const passIndex = args[2] >>> 0;
        const t = inst.model.techniques[technique];
        return t && passIndex < t.passes.length
            ? handleForPass(technique, passIndex)
            : refuse('GetPass', `pass ${passIndex} of technique ${technique}`, inst);
    };

    /**
     * D3DXPASS_DESC { LPCSTR Name; UINT Annotations; const DWORD *pVertexShaderFunction;
     *                 const DWORD *pPixelShaderFunction; }
     */
    exports['ID3DXEffect_GetPassDesc'] = (_ctx, _mem, args) => {
        const desc = args[2] >>> 0;
        if (!desc) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        const handle = inst ? decodeHandle(args[1] >>> 0) : null;
        const pass = handle && isPassHandle(handle)
            ? inst!.model.techniques[handle.sub]?.passes[handle.index]
            : undefined;
        Mem.writeUint32(desc, pass ? guestString(pass.name) : 0);
        Mem.writeUint32(desc + 4, pass ? pass.annotations.length : 0);
        // The two shader-function pointers are not decoration: a caller reads the bytecode
        // through them to build its own constant bindings, so handing back 0 is a NULL it
        // dereferences. Publish the blob's bytes into guest memory once and point at them.
        Mem.writeUint32(desc + 8, pass && inst ? shaderBytesPtr(inst, pass, STATE_VERTEX_SHADER) : 0);
        Mem.writeUint32(desc + 12, pass && inst ? shaderBytesPtr(inst, pass, STATE_PIXEL_SHADER) : 0);
        return D3D_OK;
    };

    // BOOL, not HRESULT: a pass-through effect uses every parameter it is given.
    exports['ID3DXEffect_IsParameterUsed'] = () => 1;

    // -- applying a pass ---------------------------------------------------

    /**
     * The app's pass loop is bounded entirely by what this writes. Without a parsed model we
     * still claim one pass: the app's own geometry reaches the device between BeginPass and
     * EndPass either way, it just renders with whatever state the app set itself.
     */
    exports['ID3DXEffect_Begin'] = (_ctx, _mem, args) => {
        const pPasses = args[1] >>> 0;
        const flags = args[2] >>> 0;
        const inst = instanceOf(args[0]);
        if (!inst) {
            if (pPasses) Mem.writeUint32(pPasses, 1);
            return D3D_OK;
        }
        const technique = inst.model.techniques[inst.currentTechnique];
        if (!technique) return D3DERR_INVALIDCALL;
        // D3DXFX_DONOTSAVESTATE. We save nothing either way yet, so an app that expects its
        // own device state back after End gets the last pass's instead. ONCE: Begin runs every
        // frame, and the symptom (a later draw with a stale shader bound) lands far from here.
        if (!(flags & 1) && !warnedNoSaveState) {
            warnedNoSaveState = true;
            Logger.warn(LogCategory.D3D9, 'd3dx9: Begin without DONOTSAVESTATE — device state is not saved or restored');
        }
        inst.activePass = -1;
        if (pPasses) Mem.writeUint32(pPasses, technique.passes.length);
        return D3D_OK;
    };

    exports['ID3DXEffect_BeginPass'] = (_ctx, mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return D3D_OK;
        const technique = inst.model.techniques[inst.currentTechnique];
        const index = args[1] >>> 0;
        const pass = technique?.passes[index];
        if (!pass) return D3DERR_INVALIDCALL;
        const deps = applyDepsFor(inst, mem);
        if (!deps) {
            refuse('BeginPass', 'device to apply the pass to', inst);
            return D3DERR_INVALIDCALL;
        }
        resetDeferredState(inst);
        const hr = applyPassStates(deps, inst, pass);
        if (hr === D3D_OK) inst.activePass = index;
        return hr;
    };

    /** Re-applies the active pass so parameter writes since BeginPass reach the device. */
    exports['ID3DXEffect_CommitChanges'] = (_ctx, mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst || inst.activePass < 0) return D3D_OK;
        const pass = inst.model.techniques[inst.currentTechnique]?.passes[inst.activePass];
        const deps = pass ? applyDepsFor(inst, mem) : null;
        if (!pass || !deps) return D3D_OK;
        return applyPassStates(deps, inst, pass);
    };

    // EndPass restores nothing: a multi-pass technique relies on pass N+1 overwriting only
    // what it mentions.
    exports['ID3DXEffect_EndPass'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (!inst) return D3D_OK;
        if (inst.activePass < 0) return D3DERR_INVALIDCALL;
        inst.activePass = -1;
        return D3D_OK;
    };

    exports['ID3DXEffect_End'] = (_ctx, _mem, args) => {
        const inst = instanceOf(args[0]);
        if (inst) inst.activePass = -1;
        return D3D_OK;
    };

    /**
     * Walk to the next technique after the one given (NULL = start at the first). An app
     * enumerates with this instead of GetTechnique when it wants only techniques the device
     * can actually run, so handing back the same placeholder every time makes it key its
     * whole shader registry on one name and then miss every later lookup.
     */
    exports['ID3DXEffect_FindNextValidTechnique'] = (_ctx, _mem, args) => {
        const next = args[2] >>> 0;
        if (!next) return D3DERR_INVALIDCALL;
        const inst = instanceOf(args[0]);
        if (!inst) {
            Mem.writeUint32(next, FAKE_HANDLE);
            return D3D_OK;
        }
        const from = decodeHandle(args[1] >>> 0);
        const start = from && isTechniqueHandle(from) ? from.index + 1 : 0;
        if (start >= inst.model.techniques.length) {
            Mem.writeUint32(next, 0);
            return E_FAIL;
        }
        Mem.writeUint32(next, handleForTechnique(start));
        return D3D_OK;
    };

    /**
     * Name the effect data the title actually loads, and — under
     * `setWorkerFlag('__dumpEffects', true)` — hand the bytes to the host so a parser can be
     * written and checked against them. The blob is a TRANSIENT buffer: the caller frees it
     * as soon as the create call returns, so a breakpoint that reads it afterwards gets
     * whatever reused that memory. Capturing here is the only honest moment.
     */
    const noteSource = (pSrcData: number, srcLen: number): void => {
        if (!pSrcData || !srcLen) return;
        const head = Mem.readBytes(pSrcData, Math.min(16, srcLen));
        const magic = head && head.length >= 4
            ? ((head[0]! | (head[1]! << 8) | (head[2]! << 16) | (head[3]! << 24)) >>> 0).toString(16)
            : "?";
        Logger.log(LogCategory.D3D9, `d3dx9: effect source ${srcLen} byte(s), first dword 0x${magic}`);
        if (!(globalThis as { __dumpEffects?: boolean }).__dumpEffects) return;

        const bytes = Mem.readBytes(pSrcData, srcLen);
        if (!bytes || bytes.length !== srcLen) {
            Logger.warn(LogCategory.D3D9, `d3dx9: effect source unreadable (${bytes?.length ?? 0}/${srcLen})`);
            return;
        }
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
        (self as unknown as Worker).postMessage({
            type: "debug_png_dump",
            name: `effect-${dumpSeq++}-${srcLen}`,
            base64: btoa(bin),
        });
    };

    /**
     * Parse the compiled effect if we were given one. A failure is NOT fatal: the effect
     * still exists and behaves as the old pass-through did, because a title that cannot
     * create its effect at all takes a much worse path than one whose effect renders
     * nothing. The reason is logged so the gap is visible rather than silent.
     */
    const parseSource = (pSrcData: number, srcLen: number): EffectModel | null => {
        if (!pSrcData || !srcLen) return null;
        const bytes = Mem.readBytes(pSrcData, srcLen);
        if (!bytes || bytes.length !== srcLen) return null;
        if (!isCompiledEffect(bytes)) {
            Logger.warn(LogCategory.D3D9, 'd3dx9: effect source is not compiled (HLSL text) — not supported');
            return null;
        }
        try {
            const model = parseCompiledEffect(bytes);
            Logger.log(
                LogCategory.D3D9,
                `d3dx9: effect parsed — ${model.parameters.length} parameter(s), ` +
                `${model.techniques.length} technique(s), ${model.objects.length} object(s)`,
            );
            return model;
        } catch (e) {
            Logger.warn(LogCategory.D3D9, `d3dx9: effect parse failed: ${e}`);
            return null;
        }
    };

    const parseSkipConstants = (ptr: number): ReadonlySet<string> | undefined => {
        if (!ptr) return undefined;
        const mem = Mem.getView();
        const skip = mem ? parseSkipConstantsList(Marshaler.readString(mem, ptr >>> 0)) : undefined;
        // Every effect in a title tends to carry the same list; report each distinct one once.
        const key = skip ? [...skip].join(',') : '';
        if (skip && !loggedSkipLists.has(key)) {
            loggedSkipLists.add(key);
            Logger.log(LogCategory.D3D9, `d3dx9: effects skip ${skip.size} app-owned constant(s): ${key}`);
        }
        return skip;
    };

    const publishEffect = (
        ppEffect: number,
        model: EffectModel | null,
        devicePtr: number,
        poolPtr = 0,
        skipConstants?: ReadonlySet<string>,
    ): number => {
        if (!ppEffect) return D3DERR_INVALIDCALL;

        const vtableAddr = ensureEffectVtable(process);
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const effectPtr = createComObject(vtableAddr);
        if (model) {
            // Shared parameters must be bound to the pool BEFORE the instance is published:
            // an apply that runs against a private copy uploads its zero default, and the
            // draw that follows collapses on a zero transform without failing anything.
            if (poolPtr) bindSharedParameters(poolPtr, model);
            registerEffectInstance(effectPtr, {
                model, annotations: [], devicePtr, currentTechnique: 0, activePass: -1, poolPtr: poolPtr >>> 0,
                skipConstants,
            });
            // The instance outlives nothing: it dies with the COM object the app released,
            // and its shared parameters leave the pool's groups with it.
            const boundModel = model;
            const boundPool = poolPtr >>> 0;
            registerComFinalizer(effectPtr, () => {
                if (boundPool) unbindSharedParameters(boundPool, boundModel);
                releaseEffectInstance(effectPtr);
            });
        }
        return Mem.writeUint32(ppEffect, effectPtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // Every D3DXCreateEffect* overload differs only in where ppEffect sits: FromFile*
    // drops SrcDataLen, and the Ex overloads add pSkipConstants after pInclude.
    exports['D3DXCreateEffect'] = (_ctx, _mem, args) => {
        noteSource(args[1] >>> 0, args[2] >>> 0);
        // D3DXCreateEffect(pDevice, pSrcData, len, pDefines, pInclude, Flags, pPool, ppEffect)
        return publishEffect(args[7] >>> 0, parseSource(args[1] >>> 0, args[2] >>> 0), args[0] >>> 0, args[6] >>> 0);
    };
    // ...Ex adds pSkipConstants between pInclude and Flags, so ppEffect moves to index 8.
    exports['D3DXCreateEffectEx'] = (_ctx, _mem, args) => {
        noteSource(args[1] >>> 0, args[2] >>> 0);
        // ...Ex: pPool moves to index 7 with ppEffect at 8.
        return publishEffect(
            args[8] >>> 0, parseSource(args[1] >>> 0, args[2] >>> 0), args[0] >>> 0, args[7] >>> 0,
            parseSkipConstants(args[5] >>> 0),
        );
    };
    // The FromFile* forms would have to read the file themselves; nothing we host reaches
    // them, so they keep the pass-through behaviour rather than pretend to parse.
    exports['D3DXCreateEffectFromFileA'] = (_ctx, _mem, args) => publishEffect(args[6] >>> 0, null, args[0] >>> 0, args[5] >>> 0);
    exports['D3DXCreateEffectFromFileW'] = (_ctx, _mem, args) => publishEffect(args[6] >>> 0, null, args[0] >>> 0, args[5] >>> 0);
    exports['D3DXCreateEffectFromFileExA'] = (_ctx, _mem, args) =>
        publishEffect(args[7] >>> 0, null, args[0] >>> 0, args[6] >>> 0, parseSkipConstants(args[4] >>> 0));
    exports['D3DXCreateEffectFromFileExW'] = (_ctx, _mem, args) =>
        publishEffect(args[7] >>> 0, null, args[0] >>> 0, args[6] >>> 0, parseSkipConstants(args[4] >>> 0));

    return exports;
}

/** Distinct pSkipConstants lists already reported, so a per-effect list is not a firehose. */
const loggedSkipLists = new Set<string>();

export function resetEffectState(): void {
    effectVtable = null;
    warnedNoSaveState = false;
    loggedSkipLists.clear();
}
