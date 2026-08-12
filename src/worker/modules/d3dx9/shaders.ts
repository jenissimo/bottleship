/**
 * D3DXAssembleShader / D3DXDisassembleShader.
 *
 * D3D8→D3D9 wrappers use the pair as a text-rewriting pipeline: disassemble the
 * app's D3D8 bytecode, patch the assembly (version header, inserted `dcl_*`,
 * ps_1_x → ps_1_4), assemble it back and hand the tokens to CreateVertexShader.
 * The translation itself lives in shader-asm.ts; this file is the guest ABI.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { Logger, LogCategory } from '../../core/logger';
import { parseShader } from '../../backends/webgpu/d3d9/shader/sm-parser';
import { assembleShader, disassembleShader } from './shader-asm';
import { createD3DXBufferFrom, createD3DXTextBuffer } from './buffer';

const S_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
/** MAKE_D3DHRESULT(2905) — what D3DX returns for source it cannot assemble. 2900 is
 *  D3DXERR_CANNOTMODIFYINDEXBUFFER; the shipped d3dx9_43 answers 0x88760b59 here. */
const D3DXERR_INVALIDDATA = 0x88760b59;
const E_OUTOFMEMORY = 0x8007000e;

/** vs_3_0's ceiling is 32768 instruction slots; anything past this is not a shader. */
const MAX_SHADER_DWORDS = 1 << 17;

let warnedColorCode = false;

/**
 * Snapshot a guest shader from an unbounded pointer. Bytecode carries no length
 * prefix, so the window grows until the parser reports it saw the END token.
 *
 * Mem.readBytes validates the WHOLE window against the region map, so a window
 * that overruns the end of the shader's region fails outright even though every
 * byte of the shader is readable. An unreadable window is therefore narrowed to
 * the readable extent rather than abandoned — a shader near a region boundary is
 * the normal case, not a malformed pointer.
 */
function readShaderTokens(ptr: number): Uint32Array {
    let widest: Uint32Array | null = null;
    let count = 64;
    while (count <= MAX_SHADER_DWORDS) {
        let bytes = Mem.readBytes(ptr, count * 4);
        let atRegionEdge = false;
        if (!bytes) {
            // Largest readable window below `count`, to DWORD granularity.
            let lo = widest?.length ?? 0;
            let hi = count;
            while (hi - lo > 1) {
                const mid = (lo + hi) >>> 1;
                if (Mem.readBytes(ptr, mid * 4)) lo = mid; else hi = mid;
            }
            if (lo <= (widest?.length ?? 0)) break;   // nothing further is readable
            count = lo;
            atRegionEdge = true;
            bytes = Mem.readBytes(ptr, count * 4);
            if (!bytes) break;
        }
        const tokens = new Uint32Array(bytes.slice().buffer);
        widest = tokens;
        try {
            const program = parseShader(tokens);
            if (program.terminated) return tokens.slice(0, program.tokenCount);
        } catch {
            // Truncated window — a wider one may still parse.
        }
        if (atRegionEdge) break;                      // no wider window exists
        count *= 4;
    }
    if (!widest) throw new Error(`shader bytecode at 0x${ptr.toString(16)} is not readable`);
    throw new Error(`shader bytecode at 0x${ptr.toString(16)} has no END token`);
}

function readSource(mem: Uint8Array, ptr: number, length: number): string {
    if (length === 0) return Marshaler.readString(mem, ptr);
    const bytes = Mem.readBytes(ptr, length);
    if (!bytes) throw new Error(`shader source at 0x${ptr.toString(16)} is not readable`);
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    // A caller that passes sizeof(buffer) includes the terminator (and D3DX stops there).
    const nul = text.indexOf('\0');
    return nul >= 0 ? text.slice(0, nul) : text;
}

export function createShaderExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    /** Publish an error blob and the matching HRESULT — never S_OK with nothing in it. */
    const fail = (ppErrorMsgs: number, message: string): number => {
        Logger.warn(LogCategory.D3D9, `D3DXAssembleShader failed: ${message}`);
        if (ppErrorMsgs) {
            const errPtr = createD3DXTextBuffer(process, message);
            if (errPtr) Mem.writeUint32(ppErrorMsgs, errPtr);
        }
        return D3DXERR_INVALIDDATA;
    };

    exports['D3DXAssembleShader'] = (_ctx, mem, args) => {
        const pSrcData = args[0] >>> 0;
        const srcDataLen = args[1] >>> 0;
        const pDefines = args[2] >>> 0;
        const ppShader = args[5] >>> 0;
        const ppErrorMsgs = args[6] >>> 0;

        if (ppShader) Mem.writeUint32(ppShader, 0);
        if (ppErrorMsgs) Mem.writeUint32(ppErrorMsgs, 0);
        if (!pSrcData || !ppShader) return D3DERR_INVALIDCALL;

        // pInclude only matters once a #include appears, which the assembler
        // rejects on its own; a non-empty macro list, though, means the source
        // needs an expansion pass we do not have.
        if (pDefines && (Mem.readUint32(pDefines) ?? 0) !== 0) {
            return fail(ppErrorMsgs, 'D3DXMACRO defines are not supported by the D3DX HLE assembler');
        }

        let tokens: Uint32Array;
        try {
            tokens = assembleShader(readSource(mem, pSrcData, srcDataLen));
        } catch (error) {
            return fail(ppErrorMsgs, error instanceof Error ? error.message : String(error));
        }

        const bufPtr = createD3DXBufferFrom(process, new Uint8Array(tokens.buffer));
        if (!bufPtr) return E_OUTOFMEMORY;
        return Mem.writeUint32(ppShader, bufPtr) ? S_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXDisassembleShader'] = (_ctx, _mem, args) => {
        const pShader = args[0] >>> 0;
        const enableColorCode = args[1] >>> 0;
        const pComments = args[2] >>> 0;
        const ppDisassembly = args[3] >>> 0;

        if (ppDisassembly) Mem.writeUint32(ppDisassembly, 0);
        if (!pShader || !ppDisassembly) return D3DERR_INVALIDCALL;

        if (enableColorCode && !warnedColorCode) {
            warnedColorCode = true;
            Logger.warn(LogCategory.D3D9, 'D3DXDisassembleShader: colour-coded HTML output is not produced; emitting plain assembly');
        }

        // pComments is accepted and discarded — the shipped d3dx9_43 does the
        // same (its output is byte-identical with and without the string).
        void pComments;

        let text: string;
        try {
            text = disassembleShader(readShaderTokens(pShader));
        } catch (error) {
            Logger.warn(LogCategory.D3D9,
                `D3DXDisassembleShader failed: ${error instanceof Error ? error.message : String(error)}`);
            return D3DXERR_INVALIDDATA;
        }

        const bufPtr = createD3DXTextBuffer(process, text);
        if (!bufPtr) return E_OUTOFMEMORY;
        return Mem.writeUint32(ppDisassembly, bufPtr) ? S_OK : D3DERR_INVALIDCALL;
    };

    return exports;
}

export function resetShaderAsmState(): void {
    warnedColorCode = false;
}
