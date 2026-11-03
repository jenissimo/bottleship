import { describe, expect, test } from "bun:test";
import { parseSdb, SdbError, virtualRegistryRedirects } from "@bottleship/formats/sdb";

// A database laid out the way sdbinst-era tools write one: an index list first, then the
// DATABASE, then the string table every STRINGREF points into.
function buildSdb(exes: Array<{ name: string; shims: Array<{ name: string; cmd?: string }> }>, opts: { inlineNames?: boolean } = {}): Uint8Array {
    const items: number[][] = [];
    const tableOffsets = new Map<string, number>();
    let tableCursor = 6; // past the STRINGTABLE tag + size
    const ref = (s: string): number => {
        let off = tableOffsets.get(s);
        if (off === undefined) {
            off = tableCursor;
            tableOffsets.set(s, off);
            const item = [...word(0x8801), ...dword((s.length + 1) * 2), ...utf16z(s)];
            items.push(item);
            tableCursor += item.length;
        }
        return off;
    };
    const word = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const dword = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    const utf16z = (s: string) => [...s].flatMap((c) => word(c.charCodeAt(0))).concat([0, 0]);
    const list = (tag: number, body: number[]) => [...word(tag), ...dword(body.length), ...body];
    const strField = (tag: number, s: string) => opts.inlineNames
        ? [...word((tag & 0x0fff) | 0x8000), ...dword((s.length + 1) * 2), ...utf16z(s)]
        : [...word(tag), ...dword(ref(s))];

    const exeLists = exes.flatMap((exe) => list(0x7007, [
        ...strField(0x6001, exe.name),
        ...list(0x7008, [...strField(0x6001, "*")]),
        ...exe.shims.flatMap((shim) => list(0x7009, [
            ...strField(0x6001, shim.name),
            ...(shim.cmd !== undefined ? strField(0x6008, shim.cmd) : []),
        ])),
    ]));
    const database = list(0x7001, [...word(0x4023), ...dword(4), ...strField(0x6001, "Test Compatibility Database"), ...exeLists]);
    const indexes = list(0x7802, list(0x7803, [...word(0x3802), ...word(0x7007), ...list(0x9801, [])]));
    const table = list(0x7801, items.flat());
    return new Uint8Array([...dword(2), ...dword(3), ..."sdbf"].map((c) => typeof c === "string" ? c.charCodeAt(0) : c).concat(indexes, database, table));
}

const MAFIA_SHIM = "ADDREDIRECT(HKLM\\SOFTWARE\\Illusion%20Softworks\\Mafia^HKCU\\Software\\Illusion%20Softworks\\Mafia)";

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
});

describe("VirtualRegistry redirects", () => {
    test("one ADDREDIRECT shared by two exes becomes one rule with spaces unescaped", () => {
        const exes = parseSdb(buildSdb([
            { name: "Game.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] },
            { name: "Setup.exe", shims: [{ name: "VirtualRegistry", cmd: MAFIA_SHIM }] },
        ]));
        expect(virtualRegistryRedirects(exes)).toEqual([{
            from: "HKLM\\SOFTWARE\\Illusion Softworks\\Mafia",
            to: "HKCU\\Software\\Illusion Softworks\\Mafia",
        }]);
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
});
