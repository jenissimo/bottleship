/**
 * A managed assembly loaded with LoadLibrary enters the stubbed mscoree!_CorDllMain as its
 * DllMain, now also once per thread start and exit. Without an arity the stub returned
 * without popping (hinstDLL, fdwReason, lpvReserved), and the return chain that delivers
 * the notifications continued 12 bytes off.
 */
import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";

test("mscoree!_CorDllMain is a three-argument stdcall entry point", () => {
    const registry = APIRegistry.getInstance();
    expect(registry.getArgCount("mscoree", "_CorDllMain")).toBe(3);
    expect(registry.getStackCleanupBytes("mscoree", "_CorDllMain")).toBe(12);
});
