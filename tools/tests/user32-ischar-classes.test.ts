// IsCharAlpha and its siblings are how era code lower-cases a string by hand:
//   if (IsCharAlpha(c) && !islower(c)) c += 0x20;
// A config parser built on that reads "BIND up MOVEUP" and looks the action up in a
// lower-case table. With IsCharAlphaA answering FALSE nothing is ever lower-cased, no
// key gets bound, and the game runs with a keyboard that does nothing.

import { describe, expect, test } from "bun:test";
import { user32Module } from "../../src/worker/api/user32.api";
import { createSystemExports } from "../../src/worker/modules/user32/system";

const mem = new Uint8Array(16);
const system = createSystemExports();
const call = (name: string, ch: number): number => system[name]!({} as never, mem, [ch]) as number;
const c = (s: string): number => s.charCodeAt(0);

const NAMES = ["IsCharLower", "IsCharUpper", "IsCharAlpha", "IsCharAlphaNumeric"].flatMap((n) => [n + "A", n + "W"]);

test("every entry point is exported with one argument", () => {
    for (const name of NAMES) {
        expect(typeof system[name]).toBe("function");
        expect(user32Module.functions.find((fn) => fn.name === name)?.params.length).toBe(1);
    }
});

test("a hand-rolled lower-casing loop over IsCharAlphaA turns MOVEUP into moveup", () => {
    const lower = [..."MOVEUP_2"].map((ch) => {
        const code = c(ch);
        const isLowerAscii = code >= 0x61 && code <= 0x7a;
        return String.fromCharCode(call("IsCharAlphaA", code) && !isLowerAscii ? code + 0x20 : code);
    }).join("");
    expect(lower).toBe("moveup_2");
});

describe("ANSI classes on the system code page (1252)", () => {
    test("letters, digits and punctuation", () => {
        for (const ch of ["a", "Z", "m"]) expect(call("IsCharAlphaA", c(ch))).toBe(1);
        for (const ch of ["0", " ", "_", "?", "\0"]) expect(call("IsCharAlphaA", c(ch))).toBe(0);
        expect(call("IsCharAlphaNumericA", c("7"))).toBe(1);
        expect(call("IsCharAlphaNumericA", c("q"))).toBe(1);
        expect(call("IsCharAlphaNumericA", c("-"))).toBe(0);
    });

    test("bytes above 0x7f are read on the code page, sign-extended or not", () => {
        expect(call("IsCharAlphaA", 0xe4)).toBe(1);
        expect(call("IsCharAlphaA", 0xffffffe4 | 0)).toBe(1);
        expect(call("IsCharLowerA", 0xe4)).toBe(1);
        expect(call("IsCharUpperA", 0xc4)).toBe(1);
        expect(call("IsCharUpperA", 0xe4)).toBe(0);
        expect(call("IsCharAlphaA", 0xd7)).toBe(0);
        expect(call("IsCharAlphaA", 0xdf)).toBe(1);
        expect(call("IsCharUpperA", 0xdf)).toBe(0);
    });

    test("case", () => {
        expect(call("IsCharUpperA", c("A"))).toBe(1);
        expect(call("IsCharUpperA", c("a"))).toBe(0);
        expect(call("IsCharUpperA", c("5"))).toBe(0);
        expect(call("IsCharLowerA", c("a"))).toBe(1);
        expect(call("IsCharLowerA", c("A"))).toBe(0);
    });
});

describe("wide classes", () => {
    test("classify the UTF-16 unit", () => {
        expect(call("IsCharAlphaW", 0x0416)).toBe(1);
        expect(call("IsCharUpperW", 0x0416)).toBe(1);
        expect(call("IsCharLowerW", 0x0436)).toBe(1);
        expect(call("IsCharLowerW", 0x0416)).toBe(0);
        expect(call("IsCharAlphaW", 0x4e2d)).toBe(1);
        expect(call("IsCharUpperW", 0x4e2d)).toBe(0);
        expect(call("IsCharAlphaNumericW", 0x0663)).toBe(1);
        expect(call("IsCharAlphaW", 0x0663)).toBe(0);
        expect(call("IsCharAlphaW", c("!"))).toBe(0);
    });
});
