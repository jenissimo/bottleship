import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { registerVc9AbiExports, type Vc9CrtHost } from "../../src/worker/modules/crt-vc9-abi";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const DEST = 0x1000, SRC = 0x2000;
let mem: Uint8Array, errno: number, copy: ThunkImplementation;
function put(ptr: number, value: string) {
    mem.set(new TextEncoder().encode(value + "\0"), ptr);
}
function read(ptr: number) {
    const end = mem.indexOf(0, ptr);
    return new TextDecoder().decode(mem.subarray(ptr, end));
}
function call(size: number, count: number, src = SRC, dest = DEST) {
    return copy(null as any, mem, [dest, size, src, count]);
}
beforeEach(() => {
    mem = new Uint8Array(0x3000).fill(0x55);
    Mem.bind(() => mem);
    errno = 123;
    const exports: Record<string, ThunkImplementation> = {};
    registerVc9AbiExports(exports, {
        setErrno: (code: number) => { errno = code; return true; },
        strncpy: () => { throw new Error("the non-secure contract must not be reused"); },
    } as unknown as Vc9CrtHost);
    copy = exports.strncpy_s!;
});

describe("strncpy_s Windows CRT contract", () => {
    test("replacing a longer string with an exact-length prefix ends at count", () => {
        put(DEST, "S01_Global_Briefing"); put(SRC, "SFS01");
        expect(call(1024, 5)).toBe(0);
        expect(read(DEST)).toBe("SFS01");
        expect(mem[DEST + 6]).toBe("o".charCodeAt(0));
        expect(errno).toBe(123);
    });
    test("count may exceed the destination when the whole source fits; no padding", () => {
        put(SRC, "xy");
        expect(call(4, 100)).toBe(0);
        expect(Array.from(mem.subarray(DEST, DEST + 5))).toEqual([120,121,0,0x55,0x55]);
    });
    test("count truncates a longer source while preserving room for the terminator", () => {
        put(SRC, "ABCDEF");
        expect(call(4, 3)).toBe(0);
        expect(read(DEST)).toBe("ABC");
        expect(mem[DEST + 4]).toBe(0x55);
    });
    test("overflow empties the destination, returns ERANGE and sets errno", () => {
        put(SRC, "abcd");
        expect(call(4, 4)).toBe(34);
        expect(mem[DEST]).toBe(0);
        expect(mem[DEST + 4]).toBe(0x55);
        expect(errno).toBe(34);
    });
    test("_TRUNCATE accepts signed and unsigned x86 spellings and leaves errno unchanged", () => {
        put(SRC, "abcdef");
        for (const count of [-1, 0xffffffff]) {
            expect(call(4, count)).toBe(80);
            expect(read(DEST)).toBe("abc");
            expect(errno).toBe(123);
        }
        expect(call(1, -1)).toBe(80);
        expect(read(DEST)).toBe("");
    });
    test("_TRUNCATE distinguishes exact fit and empty input from truncation", () => {
        put(SRC, "abc");
        expect(call(4, -1)).toBe(0);
        put(SRC, "");
        expect(call(1, -1)).toBe(0);
    });
    test("zero count permits a null source and clears only the first byte", () => {
        expect(call(4, 0, 0)).toBe(0);
        expect(mem[DEST]).toBe(0);
        expect(mem[DEST + 1]).toBe(0x55);
        expect(call(0, 0, 0, 0)).toBe(0);
    });
    test("invalid parameters set EINVAL and clear only a valid destination", () => {
        expect(call(4, 1, 0)).toBe(22);
        expect(mem[DEST]).toBe(0);
        expect(errno).toBe(22);
        mem[DEST] = 0x55;
        expect(call(0, 1)).toBe(22);
        expect(mem[DEST]).toBe(0x55);
        expect(call(4, 1, SRC, 0)).toBe(22);
        expect(mem[0]).toBe(0x55);
    });
    test("count and capacity measure bytes, including bytes outside ASCII", () => {
        mem.set([0x81,0x40,0xff,0], SRC);
        expect(call(4, 3)).toBe(0);
        expect(Array.from(mem.subarray(DEST, DEST + 4))).toEqual([0x81,0x40,0xff,0]);
    });
});
