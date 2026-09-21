/**
 * `sscanf_s` consumes a buffer SIZE after every %s/%c/%[ — the one difference from sscanf
 * that cannot be skipped. Skip it and every later argument is read one slot early, so the
 * caller's integers land in whatever the size happened to be: a silent, plausible-looking
 * corruption rather than a failure. These tests pin both halves: the shift and the bound.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { scanfCore } from "../../src/worker/modules/crt-scanf";

const mem = new Uint8Array(0x10000);
const BUF = 0x1000;
const OUT = 0x2000;

function put(ptr: number, text: string): number {
    for (let i = 0; i < text.length; i++) mem[ptr + i] = text.charCodeAt(i) & 0xff;
    mem[ptr + text.length] = 0;
    return ptr;
}

function readC(ptr: number): string {
    let out = "";
    for (let i = 0; mem[ptr + i] !== 0; i++) out += String.fromCharCode(mem[ptr + i]!);
    return out;
}

function u32(ptr: number): number {
    return (mem[ptr]! | (mem[ptr + 1]! << 8) | (mem[ptr + 2]! << 16) | (mem[ptr + 3]! << 24)) >>> 0;
}

describe("scanfCore secure mode", () => {
    test("consumes the size argument, so later arguments stay aligned", () => {
        mem.fill(0, BUF, BUF + 0x2000);
        Mem.bind(() => mem);
        // "RA3 112" with the _s argument shape: [buf, size, intPtr]
        const res = scanfCore("RA3 112", "%s %d", [0, 0, BUF, 32, OUT], 2, true);
        expect(res.assigned).toBe(2);
        expect(readC(BUF)).toBe("RA3");
        expect(u32(OUT)).toBe(112);
    });

    test("the same call parsed WITHOUT the secure shape puts the size where the int goes", () => {
        mem.fill(0, BUF, BUF + 0x2000);
        Mem.bind(() => mem);
        // The non-secure reader takes the size (32) as the %d destination pointer — the
        // failure this flag exists to prevent, pinned so the two shapes cannot converge.
        const res = scanfCore("RA3 112", "%s %d", [0, 0, BUF, 32, OUT], 2, false);
        expect(res.assigned).toBe(2);
        expect(u32(OUT)).toBe(0); // the int never reached OUT
    });

    test("a field that does not fit empties the buffer instead of overflowing it", () => {
        mem.fill(0, BUF, BUF + 0x2000);
        put(BUF, "xxxxxxxx");
        Mem.bind(() => mem);
        const res = scanfCore("ABCDEFGH", "%s", [0, 0, BUF, 4], 2, true);
        expect(res.assigned).toBe(0);
        expect(readC(BUF)).toBe("");
    });

    test("%c honours the element count", () => {
        mem.fill(0, BUF, BUF + 0x2000);
        Mem.bind(() => mem);
        expect(scanfCore("AB", "%2c", [0, 0, BUF, 2], 2, true).assigned).toBe(1);
        expect(String.fromCharCode(mem[BUF]!, mem[BUF + 1]!)).toBe("AB");

        mem.fill(0, BUF, BUF + 8);
        expect(scanfCore("AB", "%2c", [0, 0, BUF, 1], 2, true).assigned).toBe(0);
        expect(mem[BUF]).toBe(0);
    });

    test("a suppressed conversion takes no pointer and no size", () => {
        mem.fill(0, BUF, BUF + 0x2000);
        Mem.bind(() => mem);
        const res = scanfCore("skip 7", "%*s %d", [0, 0, OUT], 2, true);
        expect(res.assigned).toBe(1);
        expect(u32(OUT)).toBe(7);
    });
});
