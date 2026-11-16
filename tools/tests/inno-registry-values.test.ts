import { describe, expect, test } from "bun:test";
import { synthesizeRegistry } from "../../packages/repack/src/manifest-synth";
import type { InnoParseResult, RegistryEntry } from "@bottleship/formats/inno";
import { RegistryStore } from "../../src/worker/runtime/filesystem/registry";

const text = (s: string, unicode: boolean): Uint8Array => new Uint8Array(Buffer.from(s, unicode ? "utf16le" : "latin1"));
function seed(type: number, value: Uint8Array, unicode = false) {
    const entry: RegistryEntry = { hive: 2, key: "Software\\Fixture", name: "Value", type, value, permission: -1, options: 0 };
    return synthesizeRegistry({ registryEntries: [entry], version: { isUnicode: () => unicode } } as unknown as InnoParseResult);
}
for (const unicode of [false, true]) {
    describe(`Inno registry values (${unicode ? "Unicode" : "ANSI"})`, () => {
        test("ordinal 3 decodes a textual DWORD in decimal or hexadecimal", () => {
            for (const [input, expected] of [["31", 31], ["$1F", 31], ["0", 0], ["4294967295", 4294967295], ["$FFFFFFFF", 4294967295]] as const) {
                expect(seed(3, text(input, unicode), unicode)[0]!.values).toEqual([{ name: "Value", type: "REG_DWORD", data: expected }]);
            }
        });
        test("invalid or out-of-range DWORDs do not become a made-up zero", () => {
            for (const input of ["", "junk", "12tail", "4294967296", "$100000000"]) {
                expect(() => seed(3, text(input, unicode), unicode)).toThrow(/DWORD/);
            }
        });
        test("ordinal 4 preserves binary bytes, including embedded zeroes", () => {
            const raw = unicode ? new Uint8Array([0, 0, 171, 0, 16, 0, 255, 0]) : new Uint8Array([0, 171, 16, 255]);
            expect(seed(4, raw, unicode)[0]!.values).toEqual([{ name: "Value", type: "REG_BINARY", data: "00ab10ff" }]);
            expect(seed(4, new Uint8Array(), unicode)[0]!.values[0]!.data).toBe("");
        });
        test("ordinal 5 expands breaks and encodes terminated UTF-16 multi-strings", () => {
            const result = seed(5, text("one{break}{app}\\two", unicode), unicode);
            const expected = Buffer.from("one\0C:\\two\0\0", "utf16le").toString("hex");
            expect(result[0]!.values).toEqual([{ name: "Value", type: "REG_MULTI_SZ", data: expected }]);
            const registry = new RegistryStore();
            registry.seed(JSON.parse(JSON.stringify(result)));
            expect(registry.getValue(registry.open("HKLM", "Software\\Fixture")!, "Value")?.data).toBe(expected);
        });
        test("a trailing break does not add a third terminator", () => {
            expect(seed(5, text("one{break}", unicode), unicode)[0]!.values[0]!.data).toBe(Buffer.from("one\0\0", "utf16le").toString("hex"));
        });
        test("ordinal 0 creates only the key, regardless of payload or value name", () => {
            expect(seed(0, text("ignored", unicode), unicode)).toEqual([{ root: "HKLM", path: "Software\\Fixture", values: [] }]);
        });
        test("unsupported QWORD and unknown ordinals fail explicitly", () => {
            expect(() => seed(6, text("18446744073709551615", unicode), unicode)).toThrow(/QWORD/);
            expect(() => seed(7, text("anything", unicode), unicode)).toThrow(/registry.*type/i);
        });
        test("string paths still resolve and unresolved installer constants are omitted", () => {
            expect(seed(1, text("{app}\\data", unicode), unicode)[0]!.values[0]!.data).toBe("C:\\data");
            expect(seed(3, text("{code:Number}", unicode), unicode)).toEqual([]);
            expect(seed(5, text("one{break}{unknown}", unicode), unicode)).toEqual([]);
        });
    });
}
test("Unicode multi-string text is not reduced to byte characters", () => {
    expect(seed(5, text("日本{break}é", true), true)[0]!.values[0]!.data).toBe(Buffer.from("日本\0é\0\0", "utf16le").toString("hex"));
});
test("malformed Unicode binary values are rejected", () => {
    expect(() => seed(4, new Uint8Array([1]), true)).toThrow(/binary/i);
    expect(() => seed(4, new Uint8Array([0, 1]), true)).toThrow(/binary/i);
});
