import { describe, expect, test } from "bun:test";
import { applyBaseRelocations } from "../../src/worker/core/pe-relocations";

const BASE = 0x1000;
const RELOC_RVA = 0x800;

function image(blocks: Array<{ page: number; entries: number[] }>): { mem: Uint8Array; size: number } {
    const mem = new Uint8Array(0x4000);
    const v = new DataView(mem.buffer);
    let at = BASE + RELOC_RVA;
    for (const { page, entries } of blocks) {
        const size = 8 + 2 * entries.length;
        v.setUint32(at, page, true);
        v.setUint32(at + 4, size, true);
        entries.forEach((e, i) => v.setUint16(at + 8 + 2 * i, e, true));
        at += size;
    }
    return { mem, size: at - (BASE + RELOC_RVA) };
}

const read = (mem: Uint8Array, rva: number) => new DataView(mem.buffer).getUint32(BASE + rva, true);
const write = (mem: Uint8Array, rva: number, value: number) => new DataView(mem.buffer).setUint32(BASE + rva, value, true);

describe("base relocations", () => {
    test("each HIGHLOW location gets the delta", () => {
        const { mem, size } = image([{ page: 0x0, entries: [0x3010, 0x3020, 0x0000] }]);
        write(mem, 0x10, 0x65888000);
        write(mem, 0x20, 0x65881234);
        const r = applyBaseRelocations(mem, BASE, RELOC_RVA, size, (0x24020000 - 0x65880000) | 0);
        expect(r).toEqual({ applied: 2, duplicates: 0 });
        expect(read(mem, 0x10)).toBe(0x24028000);
        expect(read(mem, 0x20)).toBe(0x24021234);
    });

    test("a table that lists its blocks twice fixes each location once", () => {
        const block = { page: 0x0, entries: [0x3010, 0x3020] };
        const { mem, size } = image([block, { page: 0x100, entries: [0x3004] }, block, { page: 0x100, entries: [0x3004] }]);
        write(mem, 0x10, 0x65888000);
        write(mem, 0x20, 0x6588c010);
        write(mem, 0x104, 0x65881000);
        const r = applyBaseRelocations(mem, BASE, RELOC_RVA, size, (0x24020000 - 0x65880000) | 0);
        expect(r).toEqual({ applied: 3, duplicates: 3 });
        expect(read(mem, 0x10)).toBe(0x24028000);
        expect(read(mem, 0x20)).toBe(0x2402c010);
        expect(read(mem, 0x104)).toBe(0x24021000);
    });

    test("the same location named twice inside one block is fixed once", () => {
        const { mem, size } = image([{ page: 0x0, entries: [0x3010, 0x3010] }]);
        write(mem, 0x10, 0x10001000);
        const r = applyBaseRelocations(mem, BASE, RELOC_RVA, size, 0x1000);
        expect(r).toEqual({ applied: 1, duplicates: 1 });
        expect(read(mem, 0x10)).toBe(0x10002000);
    });
});
