import { describe, expect, test } from "bun:test";
import { parseRegFile, RegError } from "@bottleship/formats/reg";

const enc = (s: string) => new TextEncoder().encode(s);

const EXPORTED = [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Electronic Arts\\Red Alert 3]",
    '"Install Dir"="C:\\\\game\\\\RA3"',
    '"Language"="english"',
    '"Ver"=dword:0000000c',
    "",
].join("\r\n");

// Wine writes the prefix's hives, not an export: no root on the key, separators doubled, a
// modification timestamp after the bracket, and typed strings.
const WINE_SYSTEM = [
    "WINE REGISTRY Version 2",
    ";; All keys relative to REGISTRY\\\\Machine",
    "",
    "#arch=win64",
    "",
    "[Software\\\\Wow6432Node\\\\Electronic Arts\\\\Red Alert 3] 1700000000",
    "#time=1db0000deadbeef",
    '"Install Dir"="C:\\\\game\\\\RA3"',
    '"DisplayName"="Red Alert\\x2122 3"',
    '"Language"=str(2):"english"',
    '"Ver"=dword:0000000c',
    '"Langs"=str(7):"english\\0german\\0"',
    "",
].join("\n");

// The older, un-prefixed spelling of the same header line.
const WINE_USER = [
    "WINE REGISTRY Version 2",
    ";; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000",
    "",
    "[Software\\\\Electronic Arts\\\\Red Alert 3] 1700000001",
    '"Profile"="Player"',
    "",
].join("\n");

describe("reg parser", () => {
    test("exported .reg keeps working, WOW6432Node folded out", () => {
        const seeds = parseRegFile(enc(EXPORTED), { foldWow6432Node: true });
        expect(seeds).toHaveLength(1);
        expect(seeds[0]!.root).toBe("HKLM");
        expect(seeds[0]!.path).toBe("SOFTWARE\\Electronic Arts\\Red Alert 3");
        expect(seeds[0]!.values).toEqual([
            { name: "Install Dir", type: "REG_SZ", data: "C:\\game\\RA3" },
            { name: "Language", type: "REG_SZ", data: "english" },
            { name: "Ver", type: "REG_DWORD", data: 12 },
        ]);
    });

    test("a Wine system hive reads as HKLM, with the same values", () => {
        const skipped: string[] = [];
        const seeds = parseRegFile(enc(WINE_SYSTEM), { foldWow6432Node: true, onSkip: (r) => skipped.push(r) });
        expect(skipped).toEqual([]);
        expect(seeds).toHaveLength(1);
        expect(seeds[0]!.root).toBe("HKLM");
        expect(seeds[0]!.path).toBe("Software\\Electronic Arts\\Red Alert 3");
        const byName = (n: string) => seeds[0]!.values.find((v) => v.name === n);
        expect(byName("Install Dir")).toEqual({ name: "Install Dir", type: "REG_SZ", data: "C:\\game\\RA3" });
        expect(byName("Language")).toEqual({ name: "Language", type: "REG_SZ", data: "english" });
        expect(byName("Ver")).toEqual({ name: "Ver", type: "REG_DWORD", data: 12 });
    });

    test("a Wine \\xNNNN escape decodes to the character, not to the letters", () => {
        const seeds = parseRegFile(enc(WINE_SYSTEM), {});
        const display = seeds[0]!.values.find((v) => v.name === "DisplayName")!;
        expect(display.data).toBe("Red Alert™ 3");
    });

    test("str(7) keeps its NUL separators instead of splicing the members", () => {
        const seeds = parseRegFile(enc(WINE_SYSTEM), {});
        const langs = seeds[0]!.values.find((v) => v.name === "Langs")!;
        expect(langs.type).toBe("REG_MULTI_SZ");
        // "english\0german\0\0" — the separators are what a caller enumerates on.
        expect(langs.data).toBe("656e676c697368006765726d616e0000");
    });

    test("a Wine user hive reads as HKCU", () => {
        const seeds = parseRegFile(enc(WINE_USER), {});
        expect(seeds[0]!.root).toBe("HKCU");
        expect(seeds[0]!.path).toBe("Software\\Electronic Arts\\Red Alert 3");
    });

    test("a hive with no root line is refused rather than guessed at", () => {
        const headless = WINE_SYSTEM.split("\n").filter((l) => !l.startsWith(";;")).join("\n");
        expect(() => parseRegFile(enc(headless), {})).toThrow(RegError);
    });

    test("a file that is neither dialect is refused", () => {
        expect(() => parseRegFile(enc("[Software\\Foo]\n\"a\"=\"b\"\n"), {})).toThrow(RegError);
    });

    // make-wgb filters the skip stream by key (`--reg-import-under`), so a key that is not
    // `ROOT\path` silences every warning for a whole-machine hive instead of narrowing them.
    test("onSkip names the key the skip happened under", () => {
        const src = [
            "Windows Registry Editor Version 5.00",
            "",
            "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor\\Game]",
            '"Bad"=hex(9):00',
            "",
        ].join("\r\n");
        const seen: Array<string | undefined> = [];
        parseRegFile(enc(src), { onSkip: (_r, key) => seen.push(key) });
        expect(seen).toEqual(["HKLM\\SOFTWARE\\Vendor\\Game"]);
    });
});
