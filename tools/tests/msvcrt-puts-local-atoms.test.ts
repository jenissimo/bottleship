import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Msvcrt } from "../../src/worker/modules/msvcrt";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { captureAtoms, exports as atoms, resetAtomTable, restoreAtoms } from "../../src/worker/modules/kernel32/atom";

const arity = (module: { functions: Array<{ name: string; params?: unknown[] }> }, name: string) =>
    module.functions.find(f => f.name === name)?.params?.length;

let mem: Uint8Array;
const call = (name: string, args: number[]) => atoms[name]!({} as never, mem, args) as number;
const ansi = (at: number, text: string) => { mem.set(new TextEncoder().encode(text + "\0"), at); return at; };
const wide = (at: number, text: string) => {
    for (let i = 0; i <= text.length; i++) new DataView(mem.buffer).setUint16(at + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
    return at;
};
const readAnsi = (at: number) => new TextDecoder().decode(mem.subarray(at, mem.indexOf(0, at)));

beforeEach(() => {
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    resetAtomTable();
});

describe("msvcrt puts", () => {
    test("is declared with one argument, so an import of it binds", () => {
        expect(arity(msvcrtModule as never, "puts")).toBe(1);
    });

    test("returns a non-negative count for a string and EOF for NULL", () => {
        const crt = new Msvcrt() as unknown as { exports: Record<string, (c: unknown, m: Uint8Array, a: number[]) => number>; initialize?: unknown };
        const impl = (crt as unknown as { puts: (p: number) => number }).puts.bind(crt);
        expect(impl(ansi(0x11000, "hello"))).toBe(6);
        expect(impl(0)).toBe(-1);
    });
});

describe("kernel32 local atoms", () => {
    test("are declared, so imports of them bind", () => {
        for (const [name, count] of [["AddAtomA", 1], ["AddAtomW", 1], ["GetAtomNameA", 3], ["GetAtomNameW", 3], ["DeleteAtom", 1], ["FindAtomA", 1]] as const) {
            expect({ name, count: arity(kernel32Module as never, name) }).toEqual({ name, count });
        }
    });

    test("AddAtom, FindAtom, GetAtomName and DeleteAtom work case-insensitively on their own table", () => {
        const a = call("AddAtomA", [ansi(0x11000, "Tiberium")]);
        expect(a).toBeGreaterThanOrEqual(0xc000);
        expect(call("AddAtomA", [ansi(0x12000, "TIBERIUM")])).toBe(a);
        expect(call("FindAtomW", [wide(0x13000, "tiberium")])).toBe(a);
        expect(call("GetAtomNameA", [a, 0x14000, 64])).toBe(8);
        expect(readAnsi(0x14000)).toBe("Tiberium");
        expect(call("GetAtomNameA", [a, 0x15000, 4])).toBe(3);
        expect(readAnsi(0x15000)).toBe("Tib");
        expect(call("GlobalFindAtomA", [ansi(0x16000, "Tiberium")])).toBe(0);
        // Added twice, so it takes two deletes.
        expect(call("DeleteAtom", [a])).toBe(0);
        expect(call("FindAtomA", [ansi(0x11000, "Tiberium")])).toBe(a);
        expect(call("DeleteAtom", [a])).toBe(0);
        expect(call("FindAtomA", [ansi(0x11000, "Tiberium")])).toBe(0);
        expect(call("DeleteAtom", [a])).toBe(a);
    });

    test("integer atoms come back as #n without entering the table", () => {
        expect(call("AddAtomA", [ansi(0x11000, "#123")])).toBe(123);
        expect(call("AddAtomA", [0x45])).toBe(0x45);
        expect(call("GetAtomNameA", [123, 0x14000, 16])).toBe(4);
        expect(readAnsi(0x14000)).toBe("#123");
        expect(call("DeleteAtom", [123])).toBe(0);
        expect(captureAtoms().local.entries).toEqual([]);
    });

    test("\"#n\" outside 1..0xBFFF is not an integer atom and fails", () => {
        expect(call("AddAtomA", [ansi(0x11000, "#0")])).toBe(0);
        expect(call("AddAtomA", [ansi(0x11000, "#49152")])).toBe(0);
        expect(call("AddAtomA", [ansi(0x11000, "#70000")])).toBe(0);
        expect(captureAtoms().local.entries).toEqual([]);
    });

    test("local atoms survive a savestate round trip, and a reset forgets them", () => {
        const a = call("AddAtomA", [ansi(0x11000, "IPX")]);
        const saved = structuredClone(captureAtoms());
        resetAtomTable();
        expect(call("FindAtomA", [ansi(0x11000, "IPX")])).toBe(0);
        restoreAtoms(saved);
        expect(call("FindAtomA", [ansi(0x11000, "IPX")])).toBe(a);
        expect(call("AddAtomA", [ansi(0x12000, "NEXT")])).toBe(a + 1);
    });

    test("reference counts survive a savestate round trip", () => {
        const a = call("AddAtomA", [ansi(0x11000, "IPX")]);
        call("AddAtomA", [ansi(0x11000, "IPX")]);
        const saved = structuredClone(captureAtoms());
        resetAtomTable();
        restoreAtoms(saved);
        expect(call("DeleteAtom", [a])).toBe(0);
        expect(call("FindAtomA", [ansi(0x11000, "IPX")])).toBe(a);
        expect(call("DeleteAtom", [a])).toBe(0);
        expect(call("FindAtomA", [ansi(0x11000, "IPX")])).toBe(0);
    });

    test("after the last atom the table reuses freed atoms, and fails when full", () => {
        const first = call("AddAtomA", [ansi(0x11000, "a0")]);
        for (let i = 1; i <= 0xffff - 0xc000; i++) expect(call("AddAtomA", [ansi(0x11000, `a${i}`)])).toBe(first + i);
        expect(call("AddAtomA", [ansi(0x11000, "full")])).toBe(0);
        expect(call("DeleteAtom", [first + 5])).toBe(0);
        expect(call("AddAtomA", [ansi(0x11000, "reused")])).toBe(first + 5);
    });
});

describe("kernel32 global atoms", () => {
    test("names compare case-insensitively and each add takes one delete", () => {
        const a = call("GlobalAddAtomA", [ansi(0x11000, "BottleShip")]);
        expect(a).toBeGreaterThanOrEqual(0xc000);
        expect(call("GlobalAddAtomW", [wide(0x12000, "BOTTLESHIP")])).toBe(a);
        expect(call("GlobalFindAtomA", [ansi(0x13000, "bottleship")])).toBe(a);
        expect(call("FindAtomA", [ansi(0x13000, "bottleship")])).toBe(0);
        expect(call("GlobalDeleteAtom", [a])).toBe(0);
        expect(call("GlobalFindAtomW", [wide(0x13000, "BottleShip")])).toBe(a);
        expect(call("GlobalDeleteAtom", [a])).toBe(0);
        expect(call("GlobalFindAtomA", [ansi(0x13000, "BottleShip")])).toBe(0);
        expect(call("GlobalDeleteAtom", [a])).toBe(a);
    });

    test("integer atoms and GlobalGetAtomName in both character sets", () => {
        expect(call("GlobalAddAtomA", [0x45])).toBe(0x45);
        expect(call("GlobalAddAtomW", [wide(0x11000, "#7")])).toBe(7);
        expect(call("GlobalFindAtomA", [0x45])).toBe(0x45);
        expect(call("GlobalDeleteAtom", [0x45])).toBe(0);
        expect(arity(kernel32Module as never, "GlobalGetAtomNameW")).toBe(3);
        const a = call("GlobalAddAtomA", [ansi(0x11000, "Name")]);
        expect(call("GlobalGetAtomNameW", [a, 0x14000, 16])).toBe(4);
        expect(String.fromCharCode(...new Uint16Array(mem.buffer, 0x14000, 4))).toBe("Name");
        expect(call("GlobalGetAtomNameA", [0x45, 0x15000, 16])).toBe(3);
        expect(readAnsi(0x15000)).toBe("#69");
        expect(captureAtoms().global.entries).toEqual([[a, "Name", 1]]);
    });
});
