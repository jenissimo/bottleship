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
    } else {
        console.error(`unknown command ${cmd}`);
        process.exit(2);
    }
}
