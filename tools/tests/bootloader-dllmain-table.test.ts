/**
 * The boot sector's code has to end before the boot signature and the GDT at offset 512.
 * DllMain calls for implicitly loaded DLLs therefore walk a table instead of being unrolled:
 * unrolled, a title linking two dozen DLLs wrote its code over the GDT and the first
 * segment load after entering protected mode faulted.
 */
import { describe, expect, test } from "bun:test";
import { createBootloader, createGDT } from "../../src/worker/core/bootloader";

const LOAD = 0x7c00;

function dlls(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        name: `d${i}.dll`, baseAddress: 0x10000000 + i * 0x100000, entryPoint: 0x10001000 + i * 0x100000,
    })) as any[];
}

describe("bootloader DllMain table", () => {
    for (const n of [0, 1, 22, 60]) {
        test(`${n} DLLs keep the GDT and boot signature intact`, () => {
            const { code } = createBootloader(0x401000, 0x4108cc8, dlls(n));
            expect(code[510]).toBe(0x55);
            expect(code[511]).toBe(0xaa);
            expect([...code.subarray(512, 544)]).toEqual([...createGDT().gdt]);
        });
    }

    test("MOV ESI points at the table, which lists every DLL and ends in a zero entry", () => {
        const list = dlls(22);
        const { code } = createBootloader(0x401000, 0x4108cc8, list);
        const view = new DataView(code.buffer);
        const mov = code.indexOf(0xbe, 0x20);
        const table = view.getUint32(mov + 1, true) - LOAD;
        expect(table).toBeGreaterThan(512);
        list.forEach((d, i) => {
            expect(view.getUint32(table + i * 8, true)).toBe(d.baseAddress);
            expect(view.getUint32(table + i * 8 + 4, true)).toBe(d.entryPoint);
        });
        expect(view.getUint32(table + list.length * 8 + 4, true)).toBe(0);

        // The loop: JZ leaves it for the jump to the EXE entry; JMP returns to the load.
        const loop = mov + 5;
        expect([...code.subarray(loop, loop + 5)]).toEqual([0x8b, 0x46, 0x04, 0x85, 0xc0]);
        const jz = loop + 5;
        expect(code[jz]).toBe(0x74);
        // ESI, the cursor, is saved around the DllMain call.
        expect([...code.subarray(jz + 2, jz + 12)]).toEqual([0x56, 0x6a, 0x01, 0x6a, 0x01, 0xff, 0x36, 0xff, 0xd0, 0x5e]);
        const done = jz + 2 + code[jz + 1]!;
        expect(code[done]).toBe(0xb8);                       // MOV EAX, peEntry
        expect(view.getUint32(done + 1, true)).toBe(0x401000);
        expect(code[done - 2]).toBe(0xeb);
        expect(done + ((code[done - 1]! << 24) >> 24)).toBe(loop);
    });

    test("more DLLs than the image can list is an error, not a corrupt boot", () => {
        expect(() => createBootloader(0x401000, 0x4108cc8, dlls(200))).toThrow();
    });
});
