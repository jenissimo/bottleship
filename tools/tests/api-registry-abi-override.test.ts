/**
 * A per-shipped-build ABI override moves argument count and stack cleanup TOGETHER.
 *
 * `cacheFunction` derives both from one number (`dwordSlots = stackBytes >> 2`), so they
 * are one fact in two spellings. An override that writes only the cleanup leaves the
 * registry disagreeing with itself, and the readers that consume the pair suffer for it:
 * `exception-context-dumper` computes `stackCleanupBytes ?? argCount * 4` to decide
 * whether a stub's baked RET N is wrong, so a stale argCount makes it report the
 * CORRECTED stub as the broken one — a diagnostic that accuses the fix.
 *
 * The case this exists for: Bink's `_BinkSetVolume@8` pops 8 up to SDK 1.0 and 12 from
 * 1.5, under the one decorated name, so the shipped DLL decides and the static
 * descriptor cannot.
 */

import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import type { ModuleDescriptor } from "../../src/worker/api/types";

const DLL = "abiovr";
const OVERRIDDEN = "_OverrideMe@8";
const UNTOUCHED = "_LeaveMeAlone@8";

const dwords = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `arg${i}`, type: "u32" as const }));

const descriptor: ModuleDescriptor = {
    name: DLL,
    functions: [OVERRIDDEN, UNTOUCHED].map((name) => ({
        name,
        params: dwords(2),
        returnType: "u32" as const,
        callingConvention: "stdcall" as const,
    })),
};

const registry = APIRegistry.getInstance();
registry.registerModule(descriptor);

test("the descriptor's two facts start out consistent", () => {
    expect(registry.getStackCleanupBytes(DLL, OVERRIDDEN)).toBe(8);
    expect(registry.getArgCount(DLL, OVERRIDDEN)).toBe(2);
});

test("an override moves BOTH — cleanup and argument count stay one fact", () => {
    registry.overrideStackCleanupBytes(DLL, OVERRIDDEN, 12);

    const bytes = registry.getStackCleanupBytes(DLL, OVERRIDDEN);
    const args = registry.getArgCount(DLL, OVERRIDDEN);
    expect(bytes).toBe(12);
    expect(args).toBe(3);
    // The invariant itself, stated the way its readers compute it.
    expect(args! * 4).toBe(bytes!);
});

test("a sibling export in the same module is untouched", () => {
    expect(registry.getStackCleanupBytes(DLL, UNTOUCHED)).toBe(8);
    expect(registry.getArgCount(DLL, UNTOUCHED)).toBe(2);
});

test("the override is case-insensitive and tolerates a .dll suffix, like every other lookup", () => {
    registry.overrideStackCleanupBytes(`${DLL}.dll`, OVERRIDDEN.toUpperCase(), 16);
    expect(registry.getStackCleanupBytes(DLL, OVERRIDDEN)).toBe(16);
    expect(registry.getArgCount(DLL, OVERRIDDEN)).toBe(4);
});
