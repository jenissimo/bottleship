#!/usr/bin/env bun
/**
 * Ground-truth oracle for D3D shader assembly, backed by the REAL d3dx9 on this host.
 *
 * Our HLE `D3DXAssembleShader`/`D3DXDisassembleShader` exist because a d3d8-to-d3d9 wrapper
 * round-trips shader bytecode through them as TEXT. A round-trip test against our own two
 * halves only proves they agree with each other; it cannot catch both being wrong in the
 * same way — and the wrapper edits that text with regexes tuned to Microsoft's exact
 * spelling, so "some valid assembly" is not the contract, "what d3dx9 actually emits" is.
 *
 * This calls the shipped d3dx9_43.dll through bun:ffi and prints its real answer, so test
 * fixtures are recorded from the reference implementation instead of from ourselves. It is a
 * DEV-HOST tool (Windows + the DirectX redist): fixtures it produces are checked in, and the
 * tests that consume them run everywhere.
 *
 * Usage:
 *   bun tools/d3dx-oracle.ts asm <file.asm>          — assemble, print token stream as hex
 *   bun tools/d3dx-oracle.ts disasm <file.bin|hex>   — disassemble, print the text
 *   bun tools/d3dx-oracle.ts roundtrip <file.asm>    — asm then disasm, print both
 *   bun tools/d3dx-oracle.ts ctab <file.hlsl> <profile> [entry]
 *                                                    — compile, then dump what the REAL
 *                                                      ID3DXConstantTable reports, as the
 *                                                      JSON fixture the parser test reads
 */
import { CFunction, dlopen, FFIType, ptr, read, toArrayBuffer } from "bun:ffi";

const DLL = process.env.BS_D3DX9 ?? "C:\\Windows\\System32\\d3dx9_43.dll";

const lib = dlopen(DLL, {
    D3DXAssembleShader: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
    },
    D3DXDisassembleShader: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
    },
    // pSrcData, SrcDataLen, pDefines, pInclude, pFunctionName, pProfile, Flags,
    // ppShader, ppErrorMsgs, ppConstantTable
    D3DXCompileShader: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
               FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
    },
    D3DXGetShaderConstantTable: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
    },
});

/** ID3DXBuffer: QueryInterface/AddRef/Release/GetBufferPointer/GetBufferSize. */
const VT_GET_PTR = 3;
const VT_GET_SIZE = 4;

/** Call a this-call vtable slot. On x64 the interface pointer is simply the first argument. */
function callSlot(iface: bigint, slot: number, ret: "ptr" | "u32"): bigint {
    const vtable = read.ptr(Number(iface), 0);
    const fn = read.ptr(Number(vtable), slot * 8);
    const f = new CFunction({
        ptr: Number(fn),
        args: [FFIType.ptr],
        returns: ret === "ptr" ? FFIType.ptr : FFIType.u32,
    });
    const r = f(Number(iface)) as number | bigint;
    f.close();
    return BigInt(r as number);
}

function bufferBytes(iface: bigint): Uint8Array {
    const p = callSlot(iface, VT_GET_PTR, "ptr");
    const n = Number(callSlot(iface, VT_GET_SIZE, "u32"));
    return new Uint8Array(toArrayBuffer(Number(p), 0, n)).slice();
}

export function assemble(text: string): { hr: number; tokens?: Uint32Array; error?: string } {
    const src = new TextEncoder().encode(text);
    const outShader = new BigUint64Array(1);
    const outErr = new BigUint64Array(1);
    const hr = lib.symbols.D3DXAssembleShader(ptr(src), src.length, null, null, 0, ptr(outShader), ptr(outErr));
    if (outErr[0]) {
        const msg = new TextDecoder().decode(bufferBytes(outErr[0]!)).replace(/\0+$/, "");
        if (hr < 0) return { hr, error: msg };
    }
    if (hr < 0 || !outShader[0]) return { hr, error: `assemble failed hr=0x${(hr >>> 0).toString(16)}` };
    const bytes = bufferBytes(outShader[0]!);
    return { hr, tokens: new Uint32Array(bytes.buffer, 0, bytes.length >> 2) };
}

export function disassemble(tokens: Uint32Array): { hr: number; text?: string } {
    const buf = new Uint8Array(tokens.buffer.slice(0));
    const out = new BigUint64Array(1);
    const hr = lib.symbols.D3DXDisassembleShader(ptr(buf), 0, null, ptr(out));
    if (hr < 0 || !out[0]) return { hr };
    return { hr, text: new TextDecoder().decode(bufferBytes(out[0]!)).replace(/\0+$/, "") };
}

const hex = (t: Uint32Array): string =>
    [...t].map((v) => "0x" + v.toString(16).padStart(8, "0")).join(",");

/** ID3DXConstantTable slots, after IUnknown(3) and ID3DXBuffer(2). GetSamplerIndex sits
 *  between GetConstantDesc and GetConstant — calling 7 as GetConstant segfaults d3dx9. */
const VT_GET_DESC = 5;
const VT_GET_CONSTANT_DESC = 6;
const VT_GET_CONSTANT = 8;

/**
 * Call a vtable slot with arguments.
 *
 * A NULL pointer argument must be spelled `null`, never the number 0 — bun marshals the
 * latter into something d3dx9 dereferences, and the process dies inside the DLL with no
 * JS frame to point at. D3DXHANDLE is a 64-bit pointer here, so handles travel as u64.
 */
function callSlotArgs(
    iface: bigint, slot: number, args: FFIType[], values: (number | bigint | null)[],
    returns: FFIType = FFIType.i32,
): bigint {
    const vtable = read.ptr(Number(iface), 0);
    const fn = read.ptr(Number(vtable), slot * 8);
    const f = new CFunction({ ptr: Number(fn), args: [FFIType.ptr, ...args], returns });
    const r = f(Number(iface), ...(values as never[])) as number | bigint;
    f.close();
    return typeof r === "bigint" ? r : BigInt(r);
}

const cstr = (p: number): string => {
    if (!p) return "";
    let end = p;
    while (read.u8(end, 0) !== 0) end++;
    return new TextDecoder().decode(new Uint8Array(toArrayBuffer(p, 0, end - p)).slice());
};

/**
 * Everything ID3DXConstantTable says about a shader, in the shape the parser test asserts.
 * Recorded from the shipped d3dx9 so the fixture is the reference implementation's answer,
 * not a second reading of our own parser.
 */
export function constantTableOf(tokens: Uint32Array) {
    // The caller may hand us a view INTO a larger file buffer, so copy that view's own extent.
    const buf = new Uint8Array(tokens.buffer.slice(tokens.byteOffset, tokens.byteOffset + tokens.byteLength));
    const out = new BigUint64Array(1);
    const hr = lib.symbols.D3DXGetShaderConstantTable(ptr(buf), ptr(out));
    if (hr < 0 || !out[0]) return { hr, table: null };
    const iface = out[0]!;

    // D3DXCONSTANTTABLE_DESC { LPCSTR Creator; DWORD Version; UINT Constants; }
    const desc = new Uint8Array(24);
    callSlotArgs(iface, VT_GET_DESC, [FFIType.ptr], [ptr(desc)]);
    const dv = new DataView(desc.buffer);
    // x64 pads the pointer to 8 bytes.
    const creator = cstr(Number(new BigUint64Array(desc.buffer, 0, 1)[0]!));
    const version = dv.getUint32(8, true);
    const count = dv.getUint32(12, true);

    const constants = [];
    for (let i = 0; i < count; i++) {
        // D3DXHANDLE is a 64-bit pointer; `null` (not 0) is how a NULL parent is spelled.
        const h = callSlotArgs(iface, VT_GET_CONSTANT, [FFIType.u64, FFIType.u32], [0n, i], FFIType.u64);
        // D3DXCONSTANT_DESC on x64: LPCSTR(8) + 9 DWORDs + pad + LPCVOID(8).
        const cd = new Uint8Array(64);   // x64 D3DXCONSTANT_DESC is 56 bytes
        const n = new Uint32Array(1); n[0] = 1;
        callSlotArgs(iface, VT_GET_CONSTANT_DESC, [FFIType.u64, FFIType.ptr, FFIType.ptr],
            [h, ptr(cd), ptr(n)]);
        const cv = new DataView(cd.buffer);
        constants.push({
            name: cstr(Number(new BigUint64Array(cd.buffer, 0, 1)[0]!)),
            registerSet: cv.getUint32(8, true),
            registerIndex: cv.getUint32(12, true),
            registerCount: cv.getUint32(16, true),
            class: cv.getUint32(20, true),
            type: cv.getUint32(24, true),
            rows: cv.getUint32(28, true),
            columns: cv.getUint32(32, true),
            elements: cv.getUint32(36, true),
            structMembers: cv.getUint32(40, true),
            bytes: cv.getUint32(44, true),
        });
    }
    return { hr, table: { creator, version, constants } };
}

export function compile(text: string, profile: string, entry = "main"):
    { hr: number; tokens?: Uint32Array; error?: string } {
    const src = new TextEncoder().encode(text);
    const prof = new TextEncoder().encode(profile + "\0");
    const ent = new TextEncoder().encode(entry + "\0");
    const outShader = new BigUint64Array(1);
    const outErr = new BigUint64Array(1);
    const outCt = new BigUint64Array(1);
    const hr = lib.symbols.D3DXCompileShader(
        ptr(src), src.length, null, null, ptr(ent), ptr(prof), 0,
        ptr(outShader), ptr(outErr), ptr(outCt));
    if (hr < 0) {
        const msg = outErr[0] ? new TextDecoder().decode(bufferBytes(outErr[0]!)).replace(/\0+$/, "") : "";
        return { hr, error: msg || `compile failed hr=0x${(hr >>> 0).toString(16)}` };
    }
    const bytes = bufferBytes(outShader[0]!);
    return { hr, tokens: new Uint32Array(bytes.buffer, 0, bytes.length >> 2) };
}

if (import.meta.main) {
    const [cmd, file] = process.argv.slice(2);
    if (!cmd || !file) {
        console.error("usage: bun tools/d3dx-oracle.ts <asm|disasm|roundtrip> <file>");
        process.exit(2);
    }
    if (cmd === "asm" || cmd === "roundtrip") {
        const text = await Bun.file(file).text();
        const a = assemble(text);
        if (!a.tokens) { console.error(a.error); process.exit(1); }
        console.log(hex(a.tokens));
        if (cmd === "roundtrip") {
            const d = disassemble(a.tokens);
            console.log("---");
            console.log(d.text ?? `disassemble failed hr=0x${(d.hr >>> 0).toString(16)}`);
        }
    } else if (cmd === "disasm") {
        const raw = file.endsWith(".bin")
            ? new Uint32Array((await Bun.file(file).arrayBuffer()))
            : new Uint32Array((await Bun.file(file).text()).trim().split(/[,\s]+/).map((s) => Number(s) >>> 0));
        const d = disassemble(raw);
        console.log(d.text ?? `disassemble failed hr=0x${(d.hr >>> 0).toString(16)}`);
    } else if (cmd === "ctab-bin") {
        // The constant table of a blob we already have, rather than one we compile. A d3dx
        // PRESHADER (an effect's array-index expression, magic 'FX' 0x46580200) carries a CTAB
        // exactly like a shader does, and its struct members are the layout our evaluator has
        // to reproduce — asking the real ID3DXConstantTable is the only way to know their
        // register indices without inventing them.
        const raw = new Uint8Array(await Bun.file(file).arrayBuffer());
        const tokens = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
        const ct = constantTableOf(tokens);
        if (!ct.table) {
            console.error(`no constant table: hr=0x${(ct.hr >>> 0).toString(16)}`);
            process.exit(1);
        }
        console.log(JSON.stringify(ct.table, null, 2));
    } else if (cmd === "ctab") {
        const [, , profile, entry] = process.argv.slice(2);
        if (!profile) { console.error("usage: ctab <file.hlsl> <profile> [entry]"); process.exit(2); }
        const c = compile(await Bun.file(file).text(), profile, entry ?? "main");
        if (!c.tokens) { console.error(c.error); process.exit(1); }
        const ct = constantTableOf(c.tokens);
        console.log(JSON.stringify({ profile, bytecode: hex(c.tokens), reference: ct.table }, null, 2));
    } else {
        console.error(`unknown command ${cmd}`);
        process.exit(2);
    }
}
