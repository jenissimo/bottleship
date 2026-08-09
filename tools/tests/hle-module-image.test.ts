/**
 * The byte-level PE contract of an HLE module image.
 *
 * Every assertion here is a dereference some guest actually performs on an HMODULE.
 * The NumberOfSections read is not hypothetical: Gothic's SystemPack (SHW32.DLL
 * +0x312b4) does `movzx eax, word ptr [edi+6]` on whatever `ImageNtHeader` returned,
 * with no NULL check, and that is what a token handle with no image behind it crashed on.
 */

import { describe, expect, test } from "bun:test";
import { buildHleModuleImage, type HleImageExport } from "../../src/worker/core/hle-module-image";
import { HLE_IMAGE_SLOT_SIZE } from "../../src/worker/core/cpu/emulator-config";
import {
    HLE_IMAGE_SLOT, HLE_IMAGE_SLOT_COUNT, HLE_IMAGE_FIRST_FREE_SLOT, hleImageBaseForSlot,
} from "../../src/worker/core/hle-system-catalog";

const BASE = 0x2b000000;

function stub(id: number): Uint8Array {
    const code = new Uint8Array(16).fill(0x90);
    code.set([0xb8, id & 0xff, (id >> 8) & 0xff, 0, 0, 0xba, 0x77, 0xb0, 0x00, 0x00, 0xef, 0xc3], 0);
    return code;
}

function makeExports(names: string[]): HleImageExport[] {
    return names.map((name, i) => ({ name, code: stub(i + 1) }));
}

function u16(b: Uint8Array, at: number): number { return b[at] | (b[at + 1] << 8); }
function u32(b: Uint8Array, at: number): number { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }

describe("HLE module image — PE header walk", () => {
    const image = buildHleModuleImage("binkw32", BASE, HLE_IMAGE_SLOT_SIZE,
        makeExports(["_BinkOpen@8", "_BinkClose@4", "_BinkWait@4"]));

    test("walks MZ -> e_lfanew -> PE\\0\\0 -> NumberOfSections, as SHW32 does", () => {
        const b = image.bytes;
        expect(u16(b, 0)).toBe(0x5a4d);
        const lfanew = u32(b, 0x3c);
        expect(lfanew).toBeGreaterThan(0);
        expect(u32(b, lfanew)).toBe(0x00004550);
        // The exact field the crash read. A zero here would send the walker's section
        // loop straight past the table, which is the failure this image exists to prevent.
        expect(u16(b, lfanew + 4 + 2)).toBe(2);
    });

    test("optional header describes THIS base", () => {
        const b = image.bytes;
        const oh = u32(b, 0x3c) + 4 + 20;
        expect(u16(b, oh)).toBe(0x10b);
        expect(u32(b, oh + 0x1c)).toBe(BASE);
        expect(u32(b, oh + 0x38)).toBeLessThanOrEqual(HLE_IMAGE_SLOT_SIZE);
        expect(u32(b, oh + 0x5c)).toBe(16);
    });

    test("export directory is inside the image and its RVAs are bounded", () => {
        const b = image.bytes;
        const oh = u32(b, 0x3c) + 4 + 20;
        const sizeOfImage = u32(b, oh + 0x38);
        const edata = u32(b, oh + 0x60);
        expect(edata).toBeGreaterThan(0);
        expect(edata + u32(b, oh + 0x64)).toBeLessThanOrEqual(sizeOfImage);

        const count = u32(b, edata + 0x14);
        expect(count).toBe(3);
        const functions = u32(b, edata + 0x1c);
        for (let i = 0; i < count; i++) {
            // A wrapped or out-of-image RVA is the trap the "rely on 32-bit wraparound"
            // shortcut would have shipped: fine for a naive walker, fatal for any that
            // bounds-checks against SizeOfImage.
            expect(u32(b, functions + i * 4)).toBeLessThan(sizeOfImage);
        }
    });

    test("resolving an export by name yields the same address the builder reported", () => {
        const b = image.bytes;
        const oh = u32(b, 0x3c) + 4 + 20;
        const edata = u32(b, oh + 0x60);
        const count = u32(b, edata + 0x14);
        const functions = u32(b, edata + 0x1c);
        const names = u32(b, edata + 0x20);
        const ordinals = u32(b, edata + 0x24);

        const readName = (rva: number): string => {
            let s = "";
            for (let i = rva; b[i] !== 0; i++) s += String.fromCharCode(b[i]);
            return s;
        };
        for (let slot = 0; slot < count; slot++) {
            const name = readName(u32(b, names + slot * 4));
            const ord = u16(b, ordinals + slot * 2);
            expect((BASE + u32(b, functions + ord * 4)) >>> 0).toBe(image.exportAddresses.get(name));
        }
    });

    test("AddressOfNames is lexicographically sorted (loaders binary-search it)", () => {
        const b = image.bytes;
        const oh = u32(b, 0x3c) + 4 + 20;
        const edata = u32(b, oh + 0x60);
        const count = u32(b, edata + 0x14);
        const names = u32(b, edata + 0x20);
        const readName = (rva: number): string => {
            let s = "";
            for (let i = rva; b[i] !== 0; i++) s += String.fromCharCode(b[i]);
            return s;
        };
        const list = Array.from({ length: count }, (_, i) => readName(u32(b, names + i * 4)));
        expect(list).toEqual([...list].sort());
    });

    test("export bodies land at their advertised addresses", () => {
        const b = image.bytes;
        for (const [name, address] of image.exportAddresses) {
            const rva = address - BASE;
            expect(b[rva]).toBe(0xb8);       // MOV EAX, functionId
            expect(b[rva + 5]).toBe(0xba);   // MOV EDX, 0xB077
            expect(b[rva + 10]).toBe(0xef);  // OUT DX, EAX
            expect(name.length).toBeGreaterThan(0);
        }
    });

    test("a module too large for its slot is refused, not silently truncated", () => {
        const many = makeExports(Array.from({ length: 4000 }, (_, i) => `Export${i}WithAFairlyLongName`));
        expect(() => buildHleModuleImage("huge", BASE, 0x10000, many)).toThrow(/arena slot/);
    });

    test("a module with no exports still produces a walkable image", () => {
        const empty = buildHleModuleImage("empty", BASE, HLE_IMAGE_SLOT_SIZE, []);
        const b = empty.bytes;
        expect(u16(b, 0)).toBe(0x5a4d);
        const oh = u32(b, 0x3c) + 4 + 20;
        expect(u32(b, oh + 0x60)).toBe(0);   // no export directory rather than an empty one
        expect(u32(b, oh + 0x1c)).toBe(BASE);
    });
});

describe("HLE image arena layout", () => {
    test("pinned slots are distinct and fit the arena", () => {
        const slots = Object.values(HLE_IMAGE_SLOT);
        expect(new Set(slots).size).toBe(slots.length);
        expect(HLE_IMAGE_FIRST_FREE_SLOT).toBeLessThanOrEqual(HLE_IMAGE_SLOT_COUNT);
    });

    test("every slot base is 64KB-aligned", () => {
        for (const slot of Object.values(HLE_IMAGE_SLOT)) {
            expect(hleImageBaseForSlot(slot) % 0x10000).toBe(0);
        }
    });
});
