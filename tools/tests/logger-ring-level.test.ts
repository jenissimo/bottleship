/**
 * The harness `logLevel` verb exists to keep a per-frame firehose from overwriting the
 * log ring before anyone reads it. That only works if the CATEGORY LEVEL gates ring
 * insertion — gating console output alone leaves the ring churning at the same rate
 * while the verb reports success, which is the failure mode this file pins.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Logger, LogCategory, LogLevel } from "../../src/worker/core/logger";

const ring = () => Logger.getRecentEntries();

describe("category level gates the log ring", () => {
    beforeEach(() => {
        Logger.resetCategoryLevels();
        Logger.setBufferSize(200); // also clears the ring
    });

    test("an unconfigured category still fills the ring", () => {
        for (let i = 0; i < 50; i++) Logger.log(LogCategory.DDRAW, `frame ${i}`);
        expect(ring().length).toBe(50);
    });

    test("SILENT keeps the firehose out of the ring entirely", () => {
        Logger.log(LogCategory.SYSTEM, "init evidence");
        Logger.setCategoryLevel(LogCategory.DDRAW, LogLevel.SILENT);

        const before = ring().length;
        for (let i = 0; i < 500; i++) Logger.log(LogCategory.DDRAW, `frame ${i}`);
        for (let i = 0; i < 500; i++) Logger.warn(LogCategory.DDRAW, `frame ${i}`);

        expect(ring().length).toBe(before);
        // The whole point: the evidence logged BEFORE the spam survived it.
        expect(ring().some((e) => e.message === "init evidence")).toBe(true);
    });

    test("an ERROR is never dropped, however quiet the category", () => {
        Logger.setCategoryLevel(LogCategory.DDRAW, LogLevel.SILENT);
        Logger.error(LogCategory.DDRAW, "device lost");
        expect(ring().some((e) => e.message === "device lost")).toBe(true);
    });

    test("WARN keeps warnings and drops the NORMAL chatter under it", () => {
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.WARN);
        for (let i = 0; i < 10; i++) Logger.log(LogCategory.D3D9, `draw ${i}`);
        Logger.warn(LogCategory.D3D9, "pipeline miss");

        const messages = ring().map((e) => e.message);
        expect(messages).toContain("pipeline miss");
        expect(messages.some((m) => m.startsWith("draw "))).toBe(false);
    });

    test("resetCategoryLevels restores an unfiltered ring", () => {
        Logger.setCategoryLevel(LogCategory.DDRAW, LogLevel.SILENT);
        Logger.log(LogCategory.DDRAW, "dropped");
        Logger.resetCategoryLevels();
        Logger.log(LogCategory.DDRAW, "kept");

        const messages = ring().map((e) => e.message);
        expect(messages).toContain("kept");
        expect(messages).not.toContain("dropped");
    });
});
