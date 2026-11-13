/** An empty FindFirstFile spec names nothing to search: INVALID_HANDLE_VALUE + ERROR_PATH_NOT_FOUND. */
import { afterAll, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const memState = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(
    key => [key, Object.getOwnPropertyDescriptor(Mem, key)] as const,
);
afterAll(() => { for (const [key, descriptor] of memState) if (descriptor) Object.defineProperty(Mem, key, descriptor); });

const ERROR_PATH_NOT_FOUND = 3;

describe("FindFirstFile with an empty pattern", () => {
    test.each(["FindFirstFileA", "FindFirstFileW"])("%s", (name) => {
        const mem = new Uint8Array(0x1000);
        Mem.bind(() => mem);
        const sys = System.getInstance() as any;
        let lastError = 0;
        const prev = sys.scheduler.setLastError;
        sys.scheduler.setLastError = (e: number) => { lastError = e; };
        try {
            expect(fileIo[name]!(null as any, mem, [0x100, 0x400])).toBe(-1);
            expect(lastError).toBe(ERROR_PATH_NOT_FOUND);
        } finally {
            sys.scheduler.setLastError = prev;
        }
    });
});
