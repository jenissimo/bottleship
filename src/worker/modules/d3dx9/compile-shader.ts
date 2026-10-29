/**
 * D3DXCompileShader and the shader-profile queries.
 *
 * d3dx9_42/43 contain no HLSL compiler: they load d3dcompiler_4x.dll — which the DirectX
 * runtime installs into System32, not the game — forward to D3DCompile, and build the
 * constant table from the bytecode it returns. We do the same, with the real compiler
 * running as guest code, so a shader compiled at run time is the bytecode it was on Windows.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { type GuestRoutine, runGuestRoutine } from '../../core/thunking/guest-routine';
import { resolveHleExportAddress } from '../../core/thunking/export-resolver';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { createD3DXTextBuffer } from './buffer';
import { getShaderConstantTable } from './shaders';

const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;

/** The compiler d3dx9_43 binds to (d3dx9_42 used d3dcompiler_42). */
export const D3DX_COMPILER_DLL = 'd3dcompiler_43.dll';

/** Asks d3dx9_43 for the d3dx9_31 compiler, which the DirectX runtime ships separately. The
 *  remaining D3DXSHADER bits are D3DCOMPILE bits of the same value. */
const D3DXSHADER_USE_LEGACY_D3DX9_31_DLL = 1 << 16;

const D3DCAPS9_SIZE = 304;
const CAPS_VERTEX_SHADER_VERSION = 196;
const CAPS_PIXEL_SHADER_VERSION = 204;
const CAPS_VS20_CAPS = 248;      // D3DVSHADERCAPS2_0 { Caps, DynamicFlowControlDepth, NumTemps, StaticFlowControlDepth }
const CAPS_PS20_CAPS = 264;      // D3DPSHADERCAPS2_0 { Caps, DynamicFlowControlDepth, NumTemps, … }
const D3DVS20CAPS_PREDICATION = 1;
const D3DPS20CAPS_ARBITRARYSWIZZLE = 1;
const D3DPS20CAPS_GRADIENTINSTRUCTIONS = 2;
const D3DPS20CAPS_PREDICATION = 4;
const D3DPS20CAPS_NODEPENDENTREADLIMIT = 8;
const D3DPS20CAPS_NOTEXINSTRUCTIONLIMIT = 16;
const PS_2_A_CAPS = D3DPS20CAPS_ARBITRARYSWIZZLE | D3DPS20CAPS_GRADIENTINSTRUCTIONS | D3DPS20CAPS_PREDICATION
    | D3DPS20CAPS_NODEPENDENTREADLIMIT | D3DPS20CAPS_NOTEXINSTRUCTIONLIMIT;

/** IDirect3DDevice9::GetDeviceCaps; ID3DBlob/ID3DXBuffer::Release and ::GetBufferPointer. */
const VTBL_GET_DEVICE_CAPS = 7;
const VTBL_RELEASE = 2;
const VTBL_GET_BUFFER_POINTER = 3;

interface CompilerBinding {
    /** D3DCompile, once resolved; the module stays loaded, as d3dx9 keeps it. */
    d3dCompile: number;
    /** The DLL was looked for and is not there — say so once, not per shader. */
    missing: boolean;
}

const binding: CompilerBinding = { d3dCompile: 0, missing: false };
const profileStrings = new Map<string, number>();
let warnedLegacy = false;

export function resetCompileShaderState(): void {
    binding.d3dCompile = 0;
    binding.missing = false;
    profileStrings.clear();
    warnedLegacy = false;
}

const failed = (hr: number): boolean => (hr & 0x80000000) !== 0;

function vtableSlot(obj: number, slot: number): number {
    const vtbl = Mem.readUint32(obj) ?? 0;
    return vtbl ? (Mem.readUint32(vtbl + slot * 4) ?? 0) : 0;
}

function writeAscii(ptr: number, text: string): void {
    const bytes = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xFF;
    Mem.writeBytes(ptr, bytes);
}

/** shader.c D3DXGetVertexShaderProfile: the profile name is a function of the caps alone. */
export function vertexShaderProfile(caps: DataView): string | null {
    const version = caps.getUint32(CAPS_VERTEX_SHADER_VERSION, true);
    switch (version & 0xffff) {
        case 0x0101: return 'vs_1_1';
        case 0x0200: {
            const flags = caps.getUint32(CAPS_VS20_CAPS, true);
            const dynamicDepth = caps.getInt32(CAPS_VS20_CAPS + 4, true);
            const temps = caps.getInt32(CAPS_VS20_CAPS + 8, true);
            return temps >= 13 && dynamicDepth === 24 && (flags & D3DVS20CAPS_PREDICATION) ? 'vs_2_a' : 'vs_2_0';
        }
        case 0x0300: return 'vs_3_0';
        default: return null;
    }
}

/** shader.c D3DXGetPixelShaderProfile: ps_2_a needs 22 temps and the full 2_a cap set, ps_2_b
 *  32 temps and an unlimited texture-instruction count; the slot count and flow-control depth
 *  are not consulted. */
export function pixelShaderProfile(caps: DataView): string | null {
    const version = caps.getUint32(CAPS_PIXEL_SHADER_VERSION, true) & 0xffff;
    if (version >= 0x0101 && version <= 0x0104) return `ps_1_${version & 0xff}`;
    if (version === 0x0200) {
        const flags = caps.getUint32(CAPS_PS20_CAPS, true);
        const temps = caps.getInt32(CAPS_PS20_CAPS + 8, true);
        if (temps >= 22 && (flags & PS_2_A_CAPS) === PS_2_A_CAPS) return 'ps_2_a';
        if (temps >= 32 && (flags & D3DPS20CAPS_NOTEXINSTRUCTIONLIMIT)) return 'ps_2_b';
        return 'ps_2_0';
    }
    if (version === 0x0300) return 'ps_3_0';
    return null;
}

export function createCompileShaderExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    /** The profile names are static strings inside d3dx9; one guest copy per name. */
    const profileString = (name: string | null): number => {
        if (!name) return 0;
        let ptr = profileStrings.get(name);
        if (ptr === undefined) {
            ptr = process.memory.alloc(name.length + 1, 'HEAP', 'rw') >>> 0;
            if (!ptr) return 0;
            writeAscii(ptr, name);
            profileStrings.set(name, ptr);
        }
        return ptr;
    };

    const profileQuery = (tag: string, pick: (caps: DataView) => string | null): ThunkImplementation =>
        (ctx, mem, args) => {
            const device = args[0] >>> 0;
            if (!device) return 0;
            const caps = process.memory.alloc(D3DCAPS9_SIZE, 'HEAP', 'rw') >>> 0;
            if (!caps) return 0;
            return runGuestRoutine(ctx, mem, (function* (): GuestRoutine {
                try {
                    const hr = yield { fn: vtableSlot(device, VTBL_GET_DEVICE_CAPS), args: [device, caps], tag: `${tag}:GetDeviceCaps` };
                    if (failed(hr)) return 0;
                    const bytes = Mem.readBytes(caps, D3DCAPS9_SIZE);
                    if (!bytes) return 0;
                    return profileString(pick(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
                } finally {
                    process.memory.free(caps);
                }
            })(), 4, tag);
        };

    exports['D3DXGetVertexShaderProfile'] = profileQuery('D3DXGetVertexShaderProfile', vertexShaderProfile);
    exports['D3DXGetPixelShaderProfile'] = profileQuery('D3DXGetPixelShaderProfile', pixelShaderProfile);

    /** LoadLibrary + GetProcAddress, as guest calls, so the loader and search order are Windows'. */
    function* bindCompiler(scratch: number): Generator<{ fn: number; args: number[]; tag: string }, number, number> {
        if (binding.d3dCompile) return binding.d3dCompile;
        if (binding.missing) return 0;
        const dispatcher = process.dispatcher;
        const loadLibrary = resolveHleExportAddress(dispatcher, 'kernel32', 'LoadLibraryA');
        const getProcAddress = resolveHleExportAddress(dispatcher, 'kernel32', 'GetProcAddress');
        const dllName = scratch;
        const procName = scratch + D3DX_COMPILER_DLL.length + 1;
        writeAscii(dllName, D3DX_COMPILER_DLL);
        writeAscii(procName, 'D3DCompile');

        // Both return NULL on failure.
        const module = yield { fn: loadLibrary, args: [dllName], tag: 'LoadLibraryA' };
        const entry = module
            ? yield { fn: getProcAddress, args: [module, procName], tag: 'GetProcAddress' }
            : 0;
        if (!entry) {
            binding.missing = true;
            Logger.error(LogCategory.D3D9,
                `D3DXCompileShader: ${D3DX_COMPILER_DLL} could not be loaded — the DirectX runtime ` +
                `installs it into C:\\Windows\\System32; without it no HLSL compiles`);
            return 0;
        }
        binding.d3dCompile = entry >>> 0;
        return binding.d3dCompile;
    }

    // HRESULT D3DXCompileShader(LPCSTR pSrcData, UINT SrcDataLen, CONST D3DXMACRO *pDefines,
    //     LPD3DXINCLUDE pInclude, LPCSTR pFunctionName, LPCSTR pProfile, DWORD Flags,
    //     LPD3DXBUFFER *ppShader, LPD3DXBUFFER *ppErrorMsgs, LPD3DXCONSTANTTABLE *ppConstantTable)
    //
    // D3DXMACRO/D3D_SHADER_MACRO and ID3DXInclude/ID3DInclude share their layouts, and
    // ID3DBlob is ID3DXBuffer's vtable, so everything passes through unconverted.
    exports['D3DXCompileShader'] = (ctx, mem, args) => {
        const [pSrcData, srcDataLen, pDefines, pInclude, pFunctionName, pProfile, flags,
            ppShader, ppErrorMsgs, ppConstantTable] = args.map((a) => a >>> 0);
        if (ppShader) Mem.writeUint32(ppShader, 0);
        if (ppErrorMsgs) Mem.writeUint32(ppErrorMsgs, 0);
        if (ppConstantTable) Mem.writeUint32(ppConstantTable, 0);
        if (!pSrcData) return D3DERR_INVALIDCALL;

        if ((flags & D3DXSHADER_USE_LEGACY_D3DX9_31_DLL) && !warnedLegacy) {
            warnedLegacy = true;
            Logger.warn(LogCategory.D3D9,
                'D3DXCompileShader: D3DXSHADER_USE_LEGACY_D3DX9_31_DLL requested; compiling with ' +
                `${D3DX_COMPILER_DLL} instead`);
        }

        // codeOut, errorOut, then the two names bindCompiler writes.
        const scratch = process.memory.alloc(8 + 64, 'HEAP', 'rw') >>> 0;
        if (!scratch) return E_FAIL;
        const codeOut = scratch;
        const errorOut = scratch + 4;

        return runGuestRoutine(ctx, mem, (function* (): GuestRoutine {
            try {
                Mem.writeUint32(codeOut, 0);
                Mem.writeUint32(errorOut, 0);
                const d3dCompile = yield* bindCompiler(scratch + 8);
                if (!d3dCompile) {
                    if (ppErrorMsgs) {
                        const msg = createD3DXTextBuffer(process, `${D3DX_COMPILER_DLL} is not installed`);
                        if (msg) Mem.writeUint32(ppErrorMsgs, msg);
                    }
                    return E_FAIL;
                }

                const hr = yield {
                    fn: d3dCompile,
                    args: [pSrcData, srcDataLen, 0, pDefines, pInclude, pFunctionName, pProfile,
                        flags & ~D3DXSHADER_USE_LEGACY_D3DX9_31_DLL, 0, codeOut, errorOut],
                    tag: 'D3DCompile',
                };
                const code = Mem.readUint32(codeOut) ?? 0;
                const errors = Mem.readUint32(errorOut) ?? 0;

                if (errors) {
                    if (ppErrorMsgs) Mem.writeUint32(ppErrorMsgs, errors);
                    else yield { fn: vtableSlot(errors, VTBL_RELEASE), args: [errors], tag: 'ID3DBlob::Release' };
                }
                if (failed(hr)) {
                    if (code) yield { fn: vtableSlot(code, VTBL_RELEASE), args: [code], tag: 'ID3DBlob::Release' };
                    return hr;
                }

                if (code && ppConstantTable) {
                    const bytecode = yield {
                        fn: vtableSlot(code, VTBL_GET_BUFFER_POINTER), args: [code], tag: 'ID3DBlob::GetBufferPointer',
                    };
                    const tableHr = getShaderConstantTable(process, bytecode >>> 0, ppConstantTable);
                    if (failed(tableHr)) {
                        yield { fn: vtableSlot(code, VTBL_RELEASE), args: [code], tag: 'ID3DBlob::Release' };
                        return tableHr;
                    }
                }

                if (ppShader) Mem.writeUint32(ppShader, code);
                else if (code) yield { fn: vtableSlot(code, VTBL_RELEASE), args: [code], tag: 'ID3DBlob::Release' };
                return hr;
            } finally {
                process.memory.free(scratch);
            }
        })(), 40, 'D3DXCompileShader');
    };

    return exports;
}
