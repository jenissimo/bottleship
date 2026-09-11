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
import { createComObject } from '../d3d9/shared-state';
import { Mem } from '../../core/memory/mem-accessor';
import { D3D_OK } from '../d3d9/resource-registry';

const D3DERR_INVALIDCALL = 0x8876086c;

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

let effectVtable: VTableInfo | null = null;

function ensureEffectVtable(process: Process): number {
    if (!effectVtable) {
        const tables = createVTablesFromDescriptor(process, effectModuleDescriptor);
        effectVtable = tables['ID3DXEffect'] ?? null;
    }
    return effectVtable?.address ?? 0;
}

export function createEffectExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['ID3DXEffect_QueryInterface'] = () => D3D_OK;
    exports['ID3DXEffect_AddRef'] = () => 2;
    exports['ID3DXEffect_Release'] = () => 1;

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

    // BOOL, not HRESULT: a pass-through effect uses every parameter it is given.
    exports['ID3DXEffect_IsParameterUsed'] = () => 1;

    // D3DXEFFECT_DESC { LPCSTR Creator; UINT Parameters; UINT Techniques; UINT Functions; }
    exports['ID3DXEffect_GetDesc'] = (_ctx, _mem, args) => {
        const desc = args[1] >>> 0;
        if (!desc) return D3DERR_INVALIDCALL;
        Mem.writeUint32(desc, 0);          // Creator
        Mem.writeUint32(desc + 4, 0);      // Parameters
        Mem.writeUint32(desc + 8, 1);      // Techniques
        Mem.writeUint32(desc + 12, 0);     // Functions
        return D3D_OK;
    };

    // The app's pass loop is bounded entirely by what this writes.
    exports['ID3DXEffect_Begin'] = (_ctx, _mem, args) => {
        const pPasses = args[1] >>> 0;
        if (pPasses) Mem.writeUint32(pPasses, 1);
        return D3D_OK;
    };

    exports['ID3DXEffect_FindNextValidTechnique'] = (_ctx, _mem, args) => {
        const next = args[2] >>> 0;
        if (next) Mem.writeUint32(next, FAKE_HANDLE);
        return D3D_OK;
    };

    const publishEffect = (ppEffect: number): number => {
        if (!ppEffect) return D3DERR_INVALIDCALL;

        const vtableAddr = ensureEffectVtable(process);
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const effectPtr = createComObject(vtableAddr);
        return Mem.writeUint32(ppEffect, effectPtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // Every D3DXCreateEffect* overload differs only in where ppEffect sits: FromFile*
    // drops SrcDataLen, and the Ex overloads add pSkipConstants after pInclude.
    exports['D3DXCreateEffect'] = (_ctx, _mem, args) => publishEffect(args[7] >>> 0);
    exports['D3DXCreateEffectFromFileA'] = (_ctx, _mem, args) => publishEffect(args[6] >>> 0);
    exports['D3DXCreateEffectFromFileW'] = (_ctx, _mem, args) => publishEffect(args[6] >>> 0);
    exports['D3DXCreateEffectFromFileExA'] = (_ctx, _mem, args) => publishEffect(args[7] >>> 0);
    exports['D3DXCreateEffectFromFileExW'] = (_ctx, _mem, args) => publishEffect(args[7] >>> 0);

    return exports;
}

export function resetEffectState(): void {
    effectVtable = null;
}
