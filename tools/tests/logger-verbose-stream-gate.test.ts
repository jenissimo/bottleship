/**
 * An attached log STREAM used to re-enable every verbose entry, whatever the category
 * level said. That made the one documented way to quiet a firehose — harness
 * `logLevel('D3D9','WARN')` — inert exactly when it was needed: a per-draw-call title
 * kept pushing ~30k entries/s at the stream, the socket answered with CLIENT GAP, and
 * the dropped lines were the evidence the diagnosis wanted.
 *
 * The rule these pin is keepInRing's, extended to the stream: only an EXPLICITLY
 * configured category filters. Nothing configured still means "the stream sees
 * everything", which is what keeps the durable archive complete by default.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Logger, LogCategory, LogLevel } from "../../src/worker/core/logger";

let streamed: string[] = [];

describe("an explicit category level silences verbose for the stream too", () => {
    beforeEach(() => {
        Logger.resetCategoryLevels();
        Logger.setBufferSize(500);
        Logger.clear();
        streamed = [];
        Logger.setStreamCallback((entries: any) => {
            for (const e of Array.isArray(entries) ? entries : [entries]) streamed.push(String(e.message));
        });
    });
    afterEach(() => {
        Logger.setStreamCallback(null);
        Logger.resetCategoryLevels();
    });

    test("with NOTHING configured an attached stream still receives verbose", () => {
        Logger.verbose(LogCategory.D3D9, "draw 1");
        expect(Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)).toBe(true);
    });

    test("WARN on the category stops verbose reaching any sink", () => {
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.WARN);
        expect(Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)).toBe(false);

        const before = streamed.length;
        for (let i = 0; i < 200; i++) Logger.verbose(LogCategory.D3D9, `draw ${i}`);
        expect(streamed.length).toBe(before);
    });

    test("silencing one category leaves the others streaming", () => {
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.WARN);
        Logger.verbose(LogCategory.D3D9, "suppressed");
        Logger.verbose(LogCategory.SYSTEM, "kept");
        expect(streamed.some((m) => m === "suppressed")).toBe(false);
        expect(Logger.isEnabled(LogCategory.SYSTEM, LogLevel.VERBOSE)).toBe(true);
    });

    test("verboseLazy does not even build the message for a silenced category", () => {
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.WARN);
        let built = 0;
        for (let i = 0; i < 100; i++) {
            Logger.verboseLazy(LogCategory.D3D9, () => { built++; return "expensive"; });
        }
        expect(built).toBe(0);
    });

    test("raising the category back to VERBOSE restores streaming", () => {
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.WARN);
        Logger.verbose(LogCategory.D3D9, "dropped");
        Logger.setCategoryLevel(LogCategory.D3D9, LogLevel.VERBOSE);
        expect(Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)).toBe(true);
    });
});
