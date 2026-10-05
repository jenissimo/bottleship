import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { System } from "../../src/worker/core/system";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

// The point of the negative control is that handing out and recycling a file handle
// is pure bookkeeping and must never reach for the live System. It is installed on
// the real class and taken back off again rather than through `mock.module`, which is
// process-global in bun: it stays installed for every file that runs after this one,
// and made 110 unrelated tests fail the moment the suite ran as a batch.
const realGetInstance = System.getInstance;
const forbidSystem = () => {
    throw new Error("the file-handle allocator must not need System.getInstance()");
};

describe("SystemResourceProvider file handles", () => {
    const provider = new SystemResourceProvider();

    beforeAll(() => { (System as unknown as { getInstance: unknown }).getInstance = forbidSystem; });
    afterAll(() => { (System as unknown as { getInstance: unknown }).getInstance = realGetInstance; });
    afterEach(() => provider.cleanup());

    // Without this the negative control is unfalsifiable: if the guard ever stopped
    // being installed, every test below would still pass and prove nothing.
    test("the System guard is armed", () => {
        expect(() => System.getInstance()).toThrow(/must not need System/);
    });

    test("reuses a slot after CloseHandle", () => {
        const first = provider.registerFileHandle({ name: "first" });
        expect(provider.unregisterFileHandle(first)).toEqual({ name: "first" });

        const second = provider.registerFileHandle({ name: "second" });
        expect(second).toBe(first);
        expect(provider.getFileHandle(second)).toEqual({ name: "second" });
    });

    test("does not enqueue a slot twice for a stale close", () => {
        const first = provider.registerFileHandle({ name: "first" });
        expect(provider.unregisterFileHandle(first)).not.toBeNull();
        expect(provider.unregisterFileHandle(first)).toBeNull();

        const second = provider.registerFileHandle({ name: "second" });
        const third = provider.registerFileHandle({ name: "third" });
        expect(second).toBe(first);
        expect(third).not.toBe(first);
    });

    test("supports more open-close cycles than the typed range contains", () => {
        for (let i = 0; i < 20_000; i++) {
            const handle = provider.registerFileHandle({ i });
            expect(handle).toBeGreaterThanOrEqual(0x50000);
            expect(handle).toBeLessThan(0x60000);
            expect(provider.unregisterFileHandle(handle)).toEqual({ i });
        }
    });
});
