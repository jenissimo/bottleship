/**
 * Unit tests for msvc-mangling.ts — deriving RET-N stack cleanup from MSVC
 * C++-mangled export names, plus the ThunkGenerator wiring (a mangled stdcall
 * export without argCount must no longer throw when the parser understands it).
 *
 * Real-world fixtures are the full Galaxy.dll (GOG Galaxy SDK) export table
 * from the blackwell-legacy bundle.
 */
import { describe, expect, test } from "bun:test";
import { deriveStackCleanupFromMangledName } from "../../src/worker/core/thunking/msvc-mangling";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";

describe("deriveStackCleanupFromMangledName — Galaxy.dll export table", () => {
    // public static __cdecl → 0 regardless of params
    test.each([
        "?CreateInstance@GalaxyFactory@api@galaxy@@SAPAVIGalaxy@23@XZ",
        "?GetErrorManager@GalaxyFactory@api@galaxy@@SAPAVIErrorManager@23@XZ",
        "?GetInstance@GalaxyFactory@api@galaxy@@SAPAVIGalaxy@23@XZ",
        "?ResetInstance@GalaxyFactory@api@galaxy@@SAXXZ",
    ])("static cdecl factory → 0: %s", (name) => {
        expect(deriveStackCleanupFromMangledName(name)).toBe(0);
    });

    test("copy ctor: thiscall, one const-ref param → 4", () => {
        expect(deriveStackCleanupFromMangledName("??0IGalaxy@api@galaxy@@QAE@ABV012@@Z")).toBe(4);
    });

    test("default ctor: thiscall, no params → 0", () => {
        expect(deriveStackCleanupFromMangledName("??0IGalaxy@api@galaxy@@QAE@XZ")).toBe(0);
    });

    test("virtual dtor: thiscall, no params → 0", () => {
        expect(deriveStackCleanupFromMangledName("??1IGalaxy@api@galaxy@@UAE@XZ")).toBe(0);
    });

    test.each([
        "??4GalaxyFactory@api@galaxy@@QAEAAV012@ABV012@@Z",
        "??4IGalaxy@api@galaxy@@QAEAAV012@ABV012@@Z",
    ])("operator=: thiscall, ref return + one const-ref param → 4: %s", (name) => {
        expect(deriveStackCleanupFromMangledName(name)).toBe(4);
    });

    test.each([
        "??_7IGalaxy@api@galaxy@@6B@", // vftable
        "?errorManager@GalaxyFactory@api@galaxy@@0PAVIErrorManager@23@A", // static data member
        "?instance@GalaxyFactory@api@galaxy@@0PAVIGalaxy@23@A",
    ])("data exports bail → undefined: %s", (name) => {
        expect(deriveStackCleanupFromMangledName(name)).toBeUndefined();
    });
});

describe("deriveStackCleanupFromMangledName — hand-built coverage", () => {
    test("free __cdecl → 0", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YAXH@Z")).toBe(0);
    });

    test("free __cdecl variadic → 0 (caller cleans anyway)", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YAXHZZ")).toBe(0);
    });

    test("free __stdcall int(int,int) → 8", () => {
        expect(deriveStackCleanupFromMangledName("?Add@@YGHHH@Z")).toBe(8);
    });

    test("free __stdcall void(double,int) → 12", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXNH@Z")).toBe(12);
    });

    test("free __stdcall void(__int64) → 8", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGX_J@Z")).toBe(8);
    });

    test("free __stdcall void(unsigned __int64, bool) → 12", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGX_K_N@Z")).toBe(12);
    });

    test("free __stdcall void(float, char*, const int&) → 12", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXMPADABH@Z")).toBe(12);
    });

    test("free __stdcall void(void*) → 4", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXPAX@Z")).toBe(4);
    });

    test("free __stdcall with enum param → 4", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXW4E@@@Z")).toBe(4);
    });

    test("thiscall ctor taking double → 8", () => {
        expect(deriveStackCleanupFromMangledName("??0C@@QAE@N@Z")).toBe(8);
    });

    test("member __stdcall void(int) → 4", () => {
        expect(deriveStackCleanupFromMangledName("?M@C@@QAGXH@Z")).toBe(4);
    });

    test("resolvable back-reference: void(Foo*, Foo*) __stdcall → 8", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXPAUFoo@@0@Z")).toBe(8);
    });

    test("function-pointer param: void(void(__cdecl*)(int)) __stdcall → 4", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXP6AXH@Z@Z")).toBe(4);
    });

    test("pointer to pointer → 4", () => {
        expect(deriveStackCleanupFromMangledName("?F@@YGXPAPAH@Z")).toBe(4);
    });
});

describe("deriveStackCleanupFromMangledName — correct-or-nothing bail-outs", () => {
    test.each([
        ["not mangled", "CreateFileA"],
        ["stdcall-decorated C name", "_AIL_startup@0"],
        ["__fastcall", "?F@@YIXH@Z"],
        ["stdcall variadic", "?F@@YGXHZZ"],
        ["class by value param", "?F@@YGXVFoo@@@Z"],
        ["struct by value param", "?F@@YGXUFoo@@@Z"],
        ["array param", "?F@@YGXY01H@Z"],
        ["by-value struct return (hidden sret)", "?F@@YG?AUFoo@@XZ"],
        ["template in qualified name", "?F@?$C@H@@QAEXXZ"],
        ["template function", "??$F@H@@YGXH@Z"],
        ["unresolvable back-reference", "?F@@YGX0@Z"],
        ["unknown extended primitive", "?F@@YGX_LH@Z"],
        ["truncated", "?F@@YGXH"],
        ["trailing garbage", "?F@@YGXH@Zxx"],
        ["global data", "?x@@3HA"],
    ])("bails: %s", (_label, name) => {
        expect(deriveStackCleanupFromMangledName(name)).toBeUndefined();
    });
});

describe("ThunkGenerator wiring", () => {
    function makeGen(): ThunkGenerator {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x02000000);
        return gen;
    }

    test("mangled cdecl export without argCount no longer throws; emits plain RET", () => {
        const gen = makeGen();
        const { stubCode, exportTable } = gen.generateStubDll("galaxy", [
            { name: "?ResetInstance@GalaxyFactory@api@galaxy@@SAXXZ" },
        ]);
        const addr = exportTable.get("?resetinstance@galaxyfactory@api@galaxy@@saxxz")!;
        const stub = gen.getStubByAddress(addr)!;
        expect(stub.stackCleanupBytes).toBe(0);
        expect(stubCode[11]).toBe(0xc3); // RET after MOV EAX,id / MOV EDX / OUT
    });

    test("mangled thiscall export derives RET N from parameter list", () => {
        const gen = makeGen();
        const { stubCode, exportTable } = gen.generateStubDll("galaxy", [
            { name: "??0IGalaxy@api@galaxy@@QAE@ABV012@@Z" },
        ]);
        const addr = exportTable.get("??0igalaxy@api@galaxy@@qae@abv012@@z")!;
        expect(gen.getStubByAddress(addr)!.stackCleanupBytes).toBe(4);
        expect(stubCode[11]).toBe(0xc2); // RET imm16
        expect(stubCode[12]).toBe(4);
        expect(stubCode[13]).toBe(0);
    });

    test("unparseable mangled export still throws (fallback preserved)", () => {
        const gen = makeGen();
        expect(() =>
            gen.generateStubDll("galaxy", [{ name: "?F@@YGXVFoo@@@Z" }])
        ).toThrow(/argCount or stackCleanupBytes/);
    });

    test("allocateOneStub derives cleanup for mangled names", () => {
        const gen = makeGen();
        const { code } = gen.allocateOneStub("galaxy", "?Add@@YGHHH@Z");
        expect(code[11]).toBe(0xc2);
        expect(code[12]).toBe(8);
        expect(() => gen.allocateOneStub("galaxy", "?F@@YGXVFoo@@@Z")).toThrow(
            /argCount or stackCleanupBytes/
        );
    });
});
