/**
 * FindResource → LoadResource → LockResource must hand back the RESOURCE BYTES.
 *
 * Win32 kept the 16-bit signature but not its meaning: the resource is already mapped, so
 * LoadResource returns the ADDRESS of the data and LockResource is a documented no-op that
 * returns its argument. Apps take that literally and skip LockResource — Worms Armageddon's
 * built-in scheme loader reads the version at `[LoadResource(...) + 4]` and copies the body
 * out of `+5`. Returning an opaque HRSRC cookie from LoadResource makes that copy read
 * whatever lives at the cookie address, and the failure is silent: the game ran every match
 * on an all-0xFF rule block (255 rounds, nonsense turn timers, no weapons, terrain no
 * explosion could crater) with no error anywhere.
 */

import { describe, expect, test } from "bun:test";
// System first: the resource lookup reaches through System.getInstance() for the module
// registry, and that module graph only resolves when core/system is evaluated first.
import "../../src/worker/core/system";
import { exports as resourceExports } from "../../src/worker/modules/kernel32/resource";

const MODULE_BASE = 0x1000;
const RESOURCE_DIR_RVA = 0x200;
const DATA_RVA = 0x300;
const RT_RCDATA = 10;
const RESOURCE_ID = 1;
/** "SCHM" + version 2 + body — the shape WA reads at +4 and +5. */
const RESOURCE_BYTES = [0x53, 0x43, 0x48, 0x4d, 0x02, 0xaa, 0xbb, 0xcc];

/** A module image with one RCDATA resource, laid out the way a PE really is. */
function buildModuleImage(): Uint8Array {
    const mem = new Uint8Array(0x4000);
    const view = new DataView(mem.buffer);

    view.setUint16(MODULE_BASE, 0x5a4d, true);            // 'MZ'
    view.setUint32(MODULE_BASE + 0x3c, 0x80, true);       // e_lfanew
    const pe = MODULE_BASE + 0x80;
    view.setUint32(pe, 0x00004550, true);                 // 'PE\0\0'
    const opt = pe + 24;
    view.setUint16(opt, 0x10b, true);                     // PE32
    view.setUint32(opt + 112, RESOURCE_DIR_RVA, true);    // DataDirectory[2].VirtualAddress
    view.setUint32(opt + 116, 0x100, true);               // DataDirectory[2].Size

    // Three directory levels (type → id → language), each one header + one ID entry.
    const dirBase = MODULE_BASE + RESOURCE_DIR_RVA;
    const level = (at: number, id: number, offset: number, isDir: boolean): void => {
        view.setUint16(at + 12, 0, true);                 // NumberOfNamedEntries
        view.setUint16(at + 14, 1, true);                 // NumberOfIdEntries
        view.setUint32(at + 16, id, true);
        view.setUint32(at + 20, isDir ? (0x80000000 | offset) >>> 0 : offset, true);
    };
    level(dirBase + 0x00, RT_RCDATA, 0x20, true);
    level(dirBase + 0x20, RESOURCE_ID, 0x40, true);
    level(dirBase + 0x40, 0x409, 0x60, false);

    const dataEntry = dirBase + 0x60;                     // IMAGE_RESOURCE_DATA_ENTRY
    view.setUint32(dataEntry, DATA_RVA, true);            // OffsetToData (an RVA)
    view.setUint32(dataEntry + 4, RESOURCE_BYTES.length, true);

    mem.set(RESOURCE_BYTES, MODULE_BASE + DATA_RVA);
    return mem;
}

const call = (name: string, mem: Uint8Array, args: number[]): number =>
    resourceExports[name]({ esp: 0 } as never, mem, args as never) as number;

describe("PE resource ABI", () => {
    test("LoadResource returns the data pointer, and LockResource is the identity on it", () => {
        const mem = buildModuleImage();

        const hrsrc = call("FindResourceA", mem, [MODULE_BASE, RESOURCE_ID, RT_RCDATA]);
        expect(hrsrc).not.toBe(0);

        const hglobal = call("LoadResource", mem, [MODULE_BASE, hrsrc]);
        expect(hglobal).toBe(MODULE_BASE + DATA_RVA);

        // What the app actually does with it — no LockResource in sight.
        expect([...mem.subarray(hglobal, hglobal + RESOURCE_BYTES.length)]).toEqual(RESOURCE_BYTES);
        expect(mem[hglobal + 4]).toBe(0x02);

        // LockResource does not lock: it answers with the pointer it was given.
        expect(call("LockResource", mem, [hglobal])).toBe(hglobal);
        // …and still resolves a raw HRSRC, which asks the same question.
        expect(call("LockResource", mem, [hrsrc])).toBe(hglobal);

        // SizeofResource stays keyed by the HRSRC, as Win32 declares it.
        expect(call("SizeofResource", mem, [MODULE_BASE, hrsrc])).toBe(RESOURCE_BYTES.length);
    });

    test("a missing resource yields NULL rather than a pointer into nothing", () => {
        const mem = buildModuleImage();
        expect(call("FindResourceA", mem, [MODULE_BASE, 0x1234, RT_RCDATA])).toBe(0);
        expect(call("LoadResource", mem, [MODULE_BASE, 0])).toBe(0);
        expect(call("LockResource", mem, [0])).toBe(0);
    });
});
