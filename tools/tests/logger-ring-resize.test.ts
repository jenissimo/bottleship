/**
 * A resize of the log ring must CARRY the entries it already holds.
 *
 * The host replays a persisted `__logRingSize` into the worker
 * (emulator.worker.ts "set_debug_flag" -> Logger.setBufferSize), and the harness
 * `logRing` verb resizes on demand. When the resize emptied the ring, the exact
 * window the size was raised to capture — module load, import binding, device
 * init — was the window it destroyed, silently and with the verb reporting
 * success. That is the "diagnostic that silently lies" shape: losing evidence is
 * one thing, losing it while claiming to have armed for it is another.
 *
 * `clear()` remains the spelling for "empty the ring".
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Logger, LogCategory } from "../../src/worker/core/logger";

const messages = () => Logger.getRecentEntries().map((e) => e.message);

describe("Logger.setBufferSize carries the ring across a resize", () => {
    beforeEach(() => {
        Logger.resetCategoryLevels();
        Logger.setBufferSize(50);
        Logger.clear();
    });

    test("growing the ring keeps every boot line already in it", () => {
        // The real shape: a handful of boot lines, then the persisted size arrives.
        Logger.log(LogCategory.SYSTEM, "[PE] Processing imports for NATIVE DLL ddraw.dll");
        Logger.log(LogCategory.SYSTEM, "[PE] Processing imports for NATIVE DLL d3d9.dll");

        Logger.setBufferSize(100_000);

        expect(messages()).toEqual([
            "[PE] Processing imports for NATIVE DLL ddraw.dll",
            "[PE] Processing imports for NATIVE DLL d3d9.dll",
        ]);
        expect(Logger.getBufferSize()).toBe(100_000);
    });

    test("a grown ring keeps appending in order after the resize", () => {
        Logger.log(LogCategory.SYSTEM, "before");
        Logger.setBufferSize(200);
        Logger.log(LogCategory.SYSTEM, "after");

        expect(messages()).toEqual(["before", "after"]);
    });

    test("shrinking keeps the NEWEST entries, and only that many", () => {
        for (let i = 0; i < 40; i++) Logger.log(LogCategory.SYSTEM, `line ${i}`);

        Logger.setBufferSize(10);

        const kept = messages();
        expect(kept.length).toBe(10);
        expect(kept[0]).toBe("line 30");
        expect(kept[9]).toBe("line 39");
    });

    test("a ring filled to the new capacity still evicts oldest-first afterwards", () => {
        for (let i = 0; i < 40; i++) Logger.log(LogCategory.SYSTEM, `line ${i}`);
        Logger.setBufferSize(10); // full: writeIndex must land on the oldest slot

        Logger.log(LogCategory.SYSTEM, "fresh");

        const kept = messages();
        expect(kept.length).toBe(10);
        // "line 30" was the oldest and is the one that gave way; order is preserved.
        expect(kept[0]).toBe("line 31");
        expect(kept[9]).toBe("fresh");
    });

    test("a wrapped ring is carried in chronological order", () => {
        // 60 entries into a 50-slot ring: the ring has wrapped, so the carry has to
        // read through writeIndex rather than trust the array's own order.
        for (let i = 0; i < 60; i++) Logger.log(LogCategory.SYSTEM, `line ${i}`);

        Logger.setBufferSize(500);

        const kept = messages();
        expect(kept.length).toBe(50);
        expect(kept[0]).toBe("line 10");
        expect(kept[49]).toBe("line 59");
    });

    test("clear() is still how the ring is emptied", () => {
        Logger.log(LogCategory.SYSTEM, "evidence");
        Logger.clear();
        expect(messages()).toEqual([]);
    });
});
