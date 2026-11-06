import { describe, expect, test } from "bun:test";
import { trapsUnknownImport } from "../../src/worker/core/pe-import-binding";

describe("imports the HLE module has no arity for", () => {
    test("an ordinal-only import gets a trap stub instead of failing the load", () => {
        expect(trapsUnknownImport({ ordinal: 1 }, false)).toBe(true);
    });

    test("a named import still fails the load, because its stack cleanup is unknown", () => {
        expect(trapsUnknownImport({ name: "puts" }, false)).toBe(false);
        expect(trapsUnknownImport({ name: "puts", ordinal: 1 }, false)).toBe(false);
    });

    test("an import through an alias gets a trap stub, as before", () => {
        expect(trapsUnknownImport({ name: "?foo@@YAXXZ" }, true)).toBe(true);
    });
});
