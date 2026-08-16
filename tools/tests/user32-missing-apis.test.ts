/** Unit coverage for small USER32 API contracts: arity, keyboard translation, menus. */
import { describe, expect, test } from "bun:test";
import { user32Module } from "../../src/worker/api/user32.api";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createMenuExports, resetMenuState } from "../../src/worker/modules/user32/menu";
import { createSystemExports } from "../../src/worker/modules/user32/system";

const mem = new Uint8Array(0x10000);
const system = createSystemExports();
const menu = createMenuExports();
const callSystem = (name: string, args: number[]): number => {
    Mem.bind(() => mem);
    return system[name]!({} as any, mem, args) as number;
};
const callMenu = (name: string, args: number[]): number => {
    Mem.bind(() => mem);
    return menu[name]!({} as any, mem, args) as number;
};

describe("USER32 API descriptors", () => {
    test("publish the native argument counts", () => {
        const arity = (name: string) => user32Module.functions.find(fn => fn.name === name)?.params.length;
        expect(arity("ToAsciiEx")).toBe(6);
        expect(arity("IsCharLowerA")).toBe(1);
        expect(arity("IsMenu")).toBe(1);
    });
});

describe("ToAsciiEx", () => {
    test("translates through the current keyboard layout and preserves the WORD result", () => {
        const result = 0x1000;
        const state = 0x2000;
        mem.fill(0, state, state + 256);

        expect(callSystem("ToAsciiEx", [0x41, 0x1e, state, result, 0, 0])).toBe(1);
        expect(mem[result]).toBe("a".charCodeAt(0));
        expect(mem[result + 1]).toBe(0);

        mem[state + 0x10] = 0x80; // VK_SHIFT down
        expect(callSystem("ToAsciiEx", [0x41, 0x1e, state, result, 1, 0])).toBe(1);
        expect(mem[result]).toBe("A".charCodeAt(0));
        expect(callSystem("ToAsciiEx", [0x70, 0x3b, state, result, 0, 0])).toBe(0);
    });
});

describe("IsCharLowerA", () => {
    test("recognizes lower-case ANSI characters only", () => {
        expect(callSystem("IsCharLowerA", ["a".charCodeAt(0)])).toBe(1);
        expect(callSystem("IsCharLowerA", ["A".charCodeAt(0)])).toBe(0);
        expect(callSystem("IsCharLowerA", ["7".charCodeAt(0)])).toBe(0);
        expect(callSystem("IsCharLowerA", ["?".charCodeAt(0)])).toBe(0);
    });
});

describe("IsMenu", () => {
    test("only recognizes live USER32 menu handles", () => {
        resetMenuState();
        const hMenu = callMenu("CreateMenu", []);
        const hPopup = callMenu("CreatePopupMenu", []);
        expect(callMenu("IsMenu", [hMenu])).toBe(1);
        expect(callMenu("IsMenu", [hPopup])).toBe(1);
        expect(callMenu("IsMenu", [0])).toBe(0);
        expect(callMenu("IsMenu", [0xdecafbad])).toBe(0);

        expect(callMenu("DestroyMenu", [hMenu])).toBe(1);
        expect(callMenu("IsMenu", [hMenu])).toBe(0);
    });
});
