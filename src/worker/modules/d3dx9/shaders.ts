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
import { createConstantTable, noteConstantTableMissing } from './constant-table';

const S_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
/** MAKE_D3DHRESULT(2905) — what D3DX returns for source it cannot assemble. 2900 is
 *  D3DXERR_CANNOTMODIFYINDEXBUFFER; the shipped d3dx9_43 answers 0x88760b59 here. */
const D3DXERR_INVALIDDATA = 0x88760b59;
const E_OUTOFMEMORY = 0x8007000e;

/** vs_3_0's ceiling is 32768 instruction slots; anything past this is not a shader. */
const MAX_SHADER_DWORDS = 1 << 17;

let warnedColorCode = false;
let warnedNoCtab = false;

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

/** D3DSIO_COMMENT, and the FourCC the constant table announces itself with. */
const OP_COMMENT = 0xfffe;
const OP_END = 0xffff;
const FOURCC_CTAB = 0x42415443;

/**
 * Read just enough of a shader to cover its constant table.
 *
 * `readShaderTokens` grows a window and RE-PARSES the whole program at each step to find the
 * END token — O(size) parses of an O(size) shader. The CTAB comment is self-delimiting (its
 * DWORD count is in the comment token) and fxc puts it in the header, so the end of the shader
 * is not needed at all: read a header window, walk the comment chain, then read exactly the
 * table's extent.
 *
 * Returns null when the header carries no CTAB — the caller reports that as D3DX does.
 */
function readConstantTableTokens(ptr: number): Uint32Array | null {
    const readTokens = (count: number): Uint32Array | null => {
        const bytes = Mem.readBytes(ptr, count * 4);
        return bytes ? new Uint32Array(bytes.slice().buffer) : null;
    };
    // A region edge can cut the window short; fall back to the widest readable one.
    let head = readTokens(64);
    if (!head) {
        let lo = 0, hi = 64;
        while (hi - lo > 1) {
            const mid = (lo + hi) >>> 1;
            if (Mem.readBytes(ptr, mid * 4)) lo = mid; else hi = mid;
        }
        if (lo < 2) return null;
        head = readTokens(lo);
        if (!head) return null;
    }

    for (let i = 1; i < head.length;) {
        const tok = head[i]! >>> 0;
        const op = tok & 0xffff;
        if (op === OP_END) return null;
        if (op !== OP_COMMENT) return null;   // past the header block fxc writes CTAB into
        const dwords = (tok >>> 16) & 0x7fff;
        if (dwords === 0) return null;
        if (i + 1 >= head.length) return null;  // the FourCC itself is past the window
        if ((head[i + 1]! >>> 0) === FOURCC_CTAB) {
            const need = i + 1 + dwords;
            const full = need <= head.length ? head : readTokens(need);
            return full ? full.subarray(0, Math.min(need, full.length)) : null;
        }
        i += 1 + dwords;
    }
    return null;
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

    // ── D3DXGetShaderConstantTable(Ex) ──────────────────────────────────────
    // Reflection over the CTAB block fxc embedded in the bytecode. A title that ships
    // compiled shaders still asks where each uniform lives, so this is on the path of
    // every SetMatrix/SetVector it makes — not a diagnostic nicety.
    const getConstantTable = (pFunction: number, ppConstantTable: number): number => {
        if (ppConstantTable) Mem.writeUint32(ppConstantTable, 0);
        if (!pFunction || !ppConstantTable) return D3DERR_INVALIDCALL;

        // A shader compiled without reflection carries no CTAB at all. That is not our
        // failure and not an empty table: D3DX answers D3DXERR_INVALIDDATA and a caller that
        // checks takes its no-reflection path. Say so once — "the game asked and we found
        // nothing" and "the game never asked" look identical from the outside.
        const refuse = (why: string): number => {
            noteConstantTableMissing();
            if (!warnedNoCtab) {
                warnedNoCtab = true;
                Logger.warn(LogCategory.D3D9, `D3DXGetShaderConstantTable: ${why}`);
            }
            return D3DXERR_INVALIDDATA;
        };

        const tokens = readConstantTableTokens(pFunction);
        if (!tokens) return refuse(`no CTAB comment in the shader at 0x${pFunction.toString(16)}`);

        const objPtr = createConstantTable(process, tokens);
        if (!objPtr) return refuse(`unreadable CTAB in a ${tokens.length}-token shader ` +
            `(version 0x${(tokens[0] ?? 0).toString(16)})`);
        return Mem.writeUint32(ppConstantTable, objPtr) ? S_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXGetShaderConstantTable'] = (_ctx, _mem, args) =>
        getConstantTable(args[0] >>> 0, args[1] >>> 0);
    // The Ex form adds a flags word between the two; D3DXCONSTTABLE_LARGEADDRESSAWARE is
    // the only one defined and changes nothing about what we publish.
    exports['D3DXGetShaderConstantTableEx'] = (_ctx, _mem, args) =>
        getConstantTable(args[0] >>> 0, args[2] >>> 0);

    return exports;
}

export function resetShaderAsmState(): void {
    warnedColorCode = false;
    warnedNoCtab = false;
}
