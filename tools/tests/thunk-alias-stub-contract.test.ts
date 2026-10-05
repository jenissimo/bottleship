/**
 * An alias stub is a SECOND ENTRY POINT to one function, never a bridge between two.
 *
 * `findStubsByName` deliberately lets an undecorated spelling reach a decorated stub —
 * a module exporting "AIL_pause_stream" names the function the guest imported as
 * `_AIL_pause_stream@8`. But a module can declare several decorations of one base name
 * that are genuinely DIFFERENT functions (`_AIL_file_read@8` takes 2 arguments, `@12`
 * takes 3), and then the undecorated name matches all of them. Aliasing across that gap
 * publishes a body that pops one contract's bytes under the other's name and dispatches
 * on the other's functionId: the guest pushes 3 arguments, a 2-argument handler reads
 * them, and 4 bytes of ESP drift show up as a crash nowhere near this export.
 *
 * So an alias must agree with its target on the stack contract, and must record the name
 * it was actually published under.
 */

import { describe, it, expect } from "bun:test";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";

const IMAGE_BASE = 0x2a400000;

/** RET N baked into a 16-byte stub: `C2 NN NN` at byte 11, or 0 for a bare `C3`. */
function bakedPop(code: Uint8Array): number {
    if (code[11] === 0xc3) return 0;
    if (code[11] === 0xc2) return code[12] | (code[13] << 8);
    throw new Error(`byte 11 is 0x${code[11].toString(16)}, not a RET`);
}

describe("alias stubs keep one export's contract", () => {
    it("refuses to alias an undecorated export onto a decoration with a different arity", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21041000);
        gen.generateStubDll("mss32", [{ name: "_AIL_file_read@8", argCount: 2 }]);

        // What hle-module-images does for the undecorated `AIL_file_read` (3 args).
        const target = gen.findStubsByName("mss32", "AIL_file_read")[0];
        expect(target?.functionName).toBe("_AIL_file_read@8"); // the bridge itself is intended

        const alias = gen.allocateAliasStubAt(IMAGE_BASE, target!, "AIL_file_read", 3, "stdcall", 12);
        expect(alias).toBeNull();
    });

    it("aliases the same function under another spelling, and records THAT spelling", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21041000);
        gen.generateStubDll("mss32", [{ name: "_AIL_pause_stream@8", argCount: 2 }]);

        const target = gen.findStubsByName("mss32", "AIL_pause_stream")[0]!;
        const alias = gen.allocateAliasStubAt(IMAGE_BASE, target, "AIL_pause_stream", 2, "stdcall", 8);
        expect(alias).not.toBeNull();
        expect(bakedPop(alias!.code)).toBe(8);

        const recorded = gen.getStubByAddress(IMAGE_BASE);
        expect(recorded?.functionName).toBe("AIL_pause_stream");
        // Same function, so dispatch identity is shared — that is the point of an alias.
        expect(recorded?.functionId).toBe(target.functionId);
    });

    it("keeps a deliberate stackCleanupBytes override: the alias matches it, not the decoration", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21041000);
        // The documented case where a real DLL's decoration LIES: the name says @8,
        // the function pops 12.
        gen.generateStubDll("mss32", [
            { name: "_AIL_file_read@8", argCount: 2, stackCleanupBytes: 12 },
        ]);
        const target = gen.findStubsByName("mss32", "_AIL_file_read@8")[0]!;
        expect(target.stackCleanupBytes).toBe(12);

        // Aliasing it under the same override succeeds and keeps popping 12.
        const ok = gen.allocateAliasStubAt(IMAGE_BASE, target, "_AIL_file_read@8", 2, "stdcall", 12);
        expect(ok).not.toBeNull();
        expect(bakedPop(ok!.code)).toBe(12);

        // Asking for the decoration's nominal 8 instead is the contradiction, and is refused.
        expect(gen.allocateAliasStubAt(IMAGE_BASE + 0x10, target, "_AIL_file_read@8", 2, "stdcall", 8))
            .toBeNull();
    });

    it("two decorations of one base name each keep their own cleanup", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21041000);
        gen.generateStubDll("mss32", [
            { name: "_AIL_pause_stream@4", argCount: 1 },
            { name: "_AIL_pause_stream@8", argCount: 2 },
        ]);
        const four = gen.findStubsByName("mss32", "_AIL_pause_stream@4")[0]!;
        const eight = gen.findStubsByName("mss32", "_AIL_pause_stream@8")[0]!;
        expect(four.stackCleanupBytes).toBe(4);
        expect(eight.stackCleanupBytes).toBe(8);
        expect(four.functionId).not.toBe(eight.functionId);
    });
});
