import { describe, expect, test } from "bun:test";
import { validateWgslSources } from "../validate-wgsl-calls";

const analyze = (source: string, file = "fixture.ts") =>
    validateWgslSources(new Map([[file, source]]));

describe("WGSL helper call source boundaries", () => {
    test("TypeScript methods and their declarations are outside shader text", () => {
        const report = analyze([
            "class Memory {",
            "  private readFloat(address: number, width: 4 | 8): number { return 0; }",
            "  private writeFloat(address: number, value: number, width: 4 | 8): void {}",
            "  run() { this.readFloat(0, 4); this.writeFloat(0, 1, 4); }",
            "}",
            "const shader = `fn readFloat(x: u32) -> f32 { return 0.0; }",
            "fn writeFloat(x: u32, y: f32) {}",
            "fn use() { let value = readFloat(0u); writeFloat(0u, value); }`;",
        ].join("\n"));
        expect(report.mismatches).toEqual([]);
        expect(report.helpers).toBe(3);
        expect(report.checkedCalls).toBe(2);
    });

    test("a same-name TypeScript function cannot hide an invalid WGSL call", () => {
        const report = analyze([
            "function helper(a: number, b: number) { return a + b; }",
            "helper(1, 2);",
            "const shader = `fn helper(x: f32) -> f32 { return x; }",
            "fn use() { let value = helper(1.0, 2.0); }`;",
        ].join("\n"));
        expect(report.checkedCalls).toBe(1);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1, line: 4 }]);
    });

    test("calls in interpolation code are TypeScript; surrounding literal text stays checked", () => {
        const report = analyze(
            "const shader = `fn helper(x: f32) -> f32 { return x; }\nfn use() { let a = helper(1.0); ${memory.helper(0, 4)} let b = helper(1.0, 2.0); }`;");
        expect(report.checkedCalls).toBe(2);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1 }]);
    });

    test("literal shader text nested inside an interpolation is checked", () => {
        const report = analyze(
            "const shader = `fn helper(x: f32) -> f32 { return x; } ${make(`fn use() { let value = helper(1.0, 2.0); }`)}`;");
        expect(report.checkedCalls).toBe(1);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1 }]);
    });

    test("known comma-bearing interpolation branches still reject invalid arity", () => {
        const report = analyze(
            'const shader = `fn helper(x: f32) -> f32 { return x; } fn use() { let value = helper(${choice ? "1.0, 2.0" : "1.0"}); }`;');
        expect(report.expandedCalls).toBe(1);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1 }]);
    });

    test("unresolved interpolations remain explicitly unverified", () => {
        const report = analyze(
            "const shader = `fn helper(x: f32) -> f32 { return x; } fn use() { let value = helper(${args}); }`;");
        expect(report.checkedCalls).toBe(0);
        expect(report.interpolatedCalls).toBe(1);
    });

    test("middle and tail template chunks are both checked", () => {
        const report = analyze(
            "const shader = `fn helper(x: f32) -> f32 { return x; } ${prefix} fn first() { let a = helper(1.0); } ${suffix} fn last() { let b = helper(1.0, 2.0); }`;");
        expect(report.checkedCalls).toBe(2);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1 }]);
    });

    test("ordinary quoted string fragments are checked", () => {
        const report = analyze(
            'const declaration = "fn helper(x: f32) -> f32 { return x; }"; const call = "fn use() { let value = helper(); }";');
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 0, want: 1 }]);
    });

    test("raw WGSL stays fully checked and comments do not add calls", () => {
        const report = analyze(
            "fn helper(x: f32) -> f32 { return x; }\n"
            + "// helper(1.0, 2.0, 3.0);\n"
            + "fn use() { let value = helper(1.0, 2.0); }", "fixture.wgsl");
        expect(report.checkedCalls).toBe(1);
        expect(report.mismatches).toMatchObject([{ name: "helper", got: 2, want: 1, line: 3 }]);
    });

    test("a correct shader with a TypeScript name collision passes", () => {
        const report = analyze(
            "const helper = (a: number, b: number) => a + b; const shader = `fn helper(x: f32) -> f32 { return x; } fn use() { let value = helper(1.0); }`;");
        expect(report.checkedCalls).toBe(1);
        expect(report.mismatches).toEqual([]);
    });
});
