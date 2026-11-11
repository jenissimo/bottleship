/**
 * ALC device queries. Engines probe the device before they trust it: Sudden Strike 3 asks
 * ALC_MAJOR/MINOR_VERSION through alcGetIntegerv and drops the whole sound system on
 * anything below 1.1. alcGetIntegerv writes exactly as many values as the enum defines —
 * `size` is the caller's buffer capacity, not a count to fill.
 */

import { test, expect, beforeEach } from "bun:test";
import { OpenAL } from "../../src/worker/modules/openal/openal";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const MEM_BYTES = 1 << 20;
const OUT = 0x1000;
const STR = 0x2000;
let al: OpenAL;
let mem: Uint8Array;
let dv: DataView;

function call(name: string, ...args: number[]): number {
    return (al.exports[name] as any)({}, mem, args) as number;
}

function cstr(ptr: number): string {
    let e = ptr;
    while (mem[e]) e++;
    return new TextDecoder().decode(mem.subarray(ptr, e));
}

function put(s: string): number {
    mem.set(new TextEncoder().encode(s + "\0"), STR);
    return STR;
}

beforeEach(() => {
    (globalThis as any).postMessage = () => { /* sink */ };
    mem = new Uint8Array(MEM_BYTES);
    dv = new DataView(mem.buffer);
    Mem.bind(() => mem, (a, s) => a >= 0 && a + s <= mem.length);
    let next = 0x80000;
    al = new OpenAL();
    al.initialize({ memory: { alloc: (n: number) => { const p = next; next += n + 16; return p; } }, getCurrentMemory: () => mem } as any);
});

test("the device reports ALC 1.1 and writes only one value per scalar query", () => {
    const dev = call("alcOpenDevice", 0);
    for (let i = 0; i < 4; i++) dv.setInt32(OUT + i * 4, 0x5A5A5A5A, true);
    call("alcGetIntegerv", dev, 0x1000, 4, OUT);
    expect(dv.getInt32(OUT, true)).toBe(1);
    expect(dv.getInt32(OUT + 4, true)).toBe(0x5A5A5A5A);
    call("alcGetIntegerv", dev, 0x1001, 4, OUT);
    expect(dv.getInt32(OUT, true)).toBe(1);
    expect(call("alcGetError", dev)).toBe(0);
});

test("ALC_ALL_ATTRIBUTES fits ALC_ATTRIBUTES_SIZE and is zero-terminated", () => {
    const dev = call("alcOpenDevice", 0);
    call("alcGetIntegerv", dev, 0x1002, 1, OUT);
    const n = dv.getInt32(OUT, true);
    call("alcGetIntegerv", dev, 0x1003, n, OUT);
    const attrs: number[] = [];
    for (let i = 0; i < n; i++) attrs.push(dv.getInt32(OUT + i * 4, true));
    expect(attrs.at(-1)).toBe(0);
    const map = new Map<number, number>();
    for (let i = 0; i + 1 < attrs.length; i += 2) map.set(attrs[i], attrs[i + 1]);
    expect(map.get(0x1010)).toBeGreaterThan(0);
    expect(map.get(0x1011)).toBeGreaterThan(0);
    expect(map.get(0x1007)).toBe(44100);
});

test("an unknown enum or a too-small buffer sets the ALC error and writes nothing", () => {
    const dev = call("alcOpenDevice", 0);
    dv.setInt32(OUT, 7, true);
    call("alcGetIntegerv", dev, 0x7777, 4, OUT);
    expect(dv.getInt32(OUT, true)).toBe(7);
    expect(call("alcGetError", dev)).toBe(0xA003);
    expect(call("alcGetError", dev)).toBe(0);
    call("alcGetIntegerv", dev, 0x1003, 2, OUT);
    expect(dv.getInt32(OUT, true)).toBe(7);
    expect(call("alcGetError", dev)).toBe(0xA004);
});

test("enumeration is advertised and the NULL-device specifier is a double-NUL list", () => {
    expect(call("alcIsExtensionPresent", 0, put("ALC_ENUMERATION_EXT"))).toBe(1);
    expect(call("alcIsExtensionPresent", 0, put("ALC_EXT_EFX"))).toBe(0);
    const p = call("alcGetString", 0, 0x1005);
    const name = cstr(p);
    expect(name.length).toBeGreaterThan(0);
    expect(mem[p + name.length + 1]).toBe(0);
    expect(cstr(call("alcGetString", 0, 0x1004))).toBe(name);
    expect(call("alcGetEnumValue", 0, put("ALC_MONO_SOURCES"))).toBe(0x1010);
});

test("ALC_EXTENSIONS is cached per device-ness, in either query order", () => {
    const dev = call("alcOpenDevice", 0);
    expect(cstr(call("alcGetString", 0, 0x1006))).toBe("");
    const withDev = cstr(call("alcGetString", dev, 0x1006));
    expect(withDev).toContain("ALC_ENUMERATION_EXT");
    expect(cstr(call("alcGetString", 0, 0x1006))).toBe("");
    expect(cstr(call("alcGetString", dev, 0x1006))).toBe(withDev);
});

test("ALC_EXTENSIONS: device first, then NULL", () => {
    const dev = call("alcOpenDevice", 0);
    const withDev = cstr(call("alcGetString", dev, 0x1006));
    expect(withDev).toContain("ALC_ENUMERATION_EXT");
    expect(cstr(call("alcGetString", 0, 0x1006))).toBe("");
});

test("alcGetString answers the ALC error enums with their spec strings", () => {
    const expected: Record<number, string> = {
        0: "No Error", 0xA001: "Invalid Device", 0xA002: "Invalid Context",
        0xA003: "Invalid Enum", 0xA004: "Invalid Value", 0xA005: "Out of Memory",
    };
    for (const [code, text] of Object.entries(expected)) {
        expect(cstr(call("alcGetString", 0, Number(code)))).toBe(text);
    }
});

test("alcGetIntegerv with an out-buffer at the end of memory raises INVALID_VALUE instead of throwing", () => {
    const dev = call("alcOpenDevice", 0);
    dv.setInt32(MEM_BYTES - 4, 0x5A5A5A5A, true);
    expect(() => call("alcGetIntegerv", dev, 0x1000, 1, MEM_BYTES - 2)).not.toThrow();
    expect(dv.getInt32(MEM_BYTES - 4, true)).toBe(0x5A5A5A5A);
    expect(call("alcGetError", dev)).toBe(0xA004);
    call("alcGetIntegerv", dev, 0x1000, 1, MEM_BYTES - 4);
    expect(dv.getInt32(MEM_BYTES - 4, true)).toBe(1);
});
