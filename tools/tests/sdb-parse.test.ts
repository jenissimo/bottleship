import { describe, expect, test } from "bun:test";
import { parseSdb, redirectsForImage, SdbError, validateRedirects, virtualRegistryRedirects } from "@bottleship/formats/sdb";
import { buildSdb } from "./fixtures/sdb-builder";

const MAFIA_SHIM = "ADDREDIRECT(HKLM\\SOFTWARE\\Illusion%20Softworks\\Mafia^HKCU\\Software\\Illusion%20Softworks\\Mafia)";
const MAFIA = { from: "HKLM\\SOFTWARE\\Illusion Softworks\\Mafia", to: "HKCU\\Software\\Illusion Softworks\\Mafia" };

describe("sdb parser", () => {
    test("reads exe entries and their shim references through the string table", () => {
        const exes = parseSdb(buildSdb([
            { name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] },
            { name: "Setup.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] },
        ]));
        expect(exes.map((e) => e.name)).toEqual(["Game.exe", "Setup.exe"]);
        expect(exes[0]!.shims).toEqual([{ name: "VirtualRegistry", commandLine: MAFIA_SHIM }]);
    });

    test("inline strings read the same as string references", () => {
        const exes = parseSdb(buildSdb([{ name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] }], { inlineNames: true }));
        expect(exes[0]!.shims[0]!.commandLine).toBe(MAFIA_SHIM);
    });

    test("rejects a file without the sdbf magic", () => {
        expect(() => parseSdb(new Uint8Array(32))).toThrow(SdbError);
    });

    test("rejects a list whose size overruns the file", () => {
        const bytes = buildSdb([{ name: "Game.exe", shims: [] }]);
        expect(() => parseSdb(bytes.subarray(0, bytes.length - 8))).toThrow(SdbError);
    });

    test("a STRINGREF that lands on a tag other than STRINGTABLE_ITEM is a parse error", () => {
        const bytes = buildSdb([{ name: "Game.exe", shims: [] }], { strayRefFor: "Game.exe" });
        expect(() => parseSdb(bytes)).toThrow(SdbError);
        expect(() => parseSdb(bytes)).toThrow(/STRINGTABLE_ITEM/);
    });
});

describe("VirtualRegistry redirects", () => {
    test("each exe keeps its own rule, with spaces unescaped", () => {
        const exes = parseSdb(buildSdb([
            { name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] },
            { name: "Setup.exe", shims: [{ name: "VirtualRegistry", cmd: `${MAFIA_SHIM} ${MAFIA_SHIM}` }] },
        ]));
        expect(virtualRegistryRedirects(exes)).toEqual([
            { exe: "Game.exe", ...MAFIA },
            { exe: "Setup.exe", ...MAFIA },
        ]);
    });

    test("other shims and other VirtualRegistry commands are reported, not applied", () => {
        const skipped: string[] = [];
        const exes = parseSdb(buildSdb([{
            name: "Game.exe",
            shims: [
                { name: "ForceDisplayMode" },
                { name: "VirtualRegistry", cmd: `${MAFIA_SHIM} ADDKEYS(HKLM\\Software\\X)` },
            ],
        }]));
        const rules = virtualRegistryRedirects(exes, (r) => skipped.push(r));
        expect(rules).toHaveLength(1);
        expect(skipped).toEqual([
            "Game.exe: shim ForceDisplayMode is not supported",
            "Game.exe: VirtualRegistry command ADDKEYS(HKLM\\Software\\X) is not supported",
        ]);
    });

    test("an entry only MATCHING_FILE could identify (NAME \"*\") is skipped and reported", () => {
        const skipped: string[] = [];
        const exes = parseSdb(buildSdb([{ name: "*", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] }]));
        expect(virtualRegistryRedirects(exes, (r) => skipped.push(r))).toEqual([]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toContain("MATCHING_FILE");
    });

    test("parentheses inside a key are part of the key", () => {
        const cmd = "ADDREDIRECT(HKLM\\Software\\Vendor%20(x86)\\Game^HKCU\\Software\\Vendor%20(x86)\\Game%20(Steam))";
        const exes = parseSdb(buildSdb([{ name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd }] }]));
        expect(virtualRegistryRedirects(exes)).toEqual([{
            exe: "Game.exe",
            from: "HKLM\\Software\\Vendor (x86)\\Game",
            to: "HKCU\\Software\\Vendor (x86)\\Game (Steam)",
        }]);
    });

    test("an ADDREDIRECT without exactly one ^ is reported, not guessed at", () => {
        const skipped: string[] = [];
        const exes = parseSdb(buildSdb([{ name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: "ADDREDIRECT(HKLM\\A^HKCU\\B^HKCU\\C) ADDREDIRECT(HKLM\\A)" }] }]));
        expect(virtualRegistryRedirects(exes, (r) => skipped.push(r))).toEqual([]);
        expect(skipped).toHaveLength(2);
    });

    test("a process gets only the rules of the entry naming its image", () => {
        const rules = [{ exe: "Game.exe", ...MAFIA }, { exe: "Other.exe", from: "HKLM\\Software\\O", to: "HKCU\\Software\\O" }];
        expect(redirectsForImage(rules, "C:\\Mafia\\GAME.EXE")).toEqual([MAFIA]);
        expect(redirectsForImage(rules, "C:\\Mafia\\Setup.exe")).toEqual([]);
    });
});

describe("redirect validation", () => {
    test("a plain rule is accepted in stored-key form", () => {
        const { accepted, rejected } = validateRedirects([MAFIA]);
        expect(rejected).toEqual([]);
        expect(accepted.map(({ from, to }) => ({ from, to }))).toEqual([{
            from: "hklm\\software\\illusion softworks\\mafia", to: "hkcu\\software\\illusion softworks\\mafia",
        }]);
    });

    test("whole root keys, unknown roots and empty keys are rejected", () => {
        const { accepted, rejected } = validateRedirects([
            { from: "HKLM", to: "HKCU\\Software\\X" },
            { from: "HKLM\\Software\\X", to: "HKCU" },
            { from: "HKLM\\Software\\X", to: "HKCU\\" },
            { from: "MACHINE\\Software\\X", to: "HKCU\\Software\\X" },
            { from: "", to: "HKCU\\Software\\X" },
            { from: "HKLM\\Software\\\\X", to: "HKCU\\Software\\X" },
        ]);
        expect(accepted).toEqual([]);
        expect(rejected).toHaveLength(6);
    });

    test("a target inside its own source is rejected", () => {
        const { accepted, rejected } = validateRedirects([{ from: "HKLM\\Software\\X", to: "HKLM\\Software\\X\\Y" }]);
        expect(accepted).toEqual([]);
        expect(rejected).toHaveLength(1);
    });

    test("A->B with B->A is a cycle: both are rejected", () => {
        const { accepted, rejected } = validateRedirects([
            { from: "HKLM\\Software\\A", to: "HKCU\\Software\\B" },
            { from: "HKCU\\Software\\B", to: "HKLM\\Software\\A" },
        ]);
        expect(accepted).toEqual([]);
        expect(rejected.map((r) => r.reason).every((r) => r.includes("cycle"))).toBe(true);
    });

    test("a chain A->B, B\\C->D is rejected", () => {
        expect(validateRedirects([
            { from: "HKLM\\Software\\A", to: "HKCU\\Software\\B" },
            { from: "HKCU\\Software\\B\\C", to: "HKCU\\Software\\D" },
        ]).accepted).toEqual([]);
    });

    test("one source with two targets is rejected; exact duplicates fold", () => {
        expect(validateRedirects([MAFIA, MAFIA]).accepted).toHaveLength(1);
        expect(validateRedirects([MAFIA, { from: MAFIA.from, to: "HKCU\\Software\\Elsewhere" }]).accepted).toEqual([]);
    });
});
