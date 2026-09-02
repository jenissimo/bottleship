/**
 * The guest-log CONTENT mirror must be gated on a level that a log STREAM cannot turn on.
 *
 * `Logger.isEnabled(cat, VERBOSE)` answers true whenever a stream callback is attached, and
 * the harness attaches one for the whole session — so gating the 32 KB slice + codepage
 * decode on it left the work running in exactly the windows where the frame tail is measured.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { logGuestWriteContent } from "../../src/worker/modules/kernel32/file-io";
import { Logger, LogCategory, LogLevel } from "../../src/worker/core/logger";

/** Counts the one expensive step the gate exists to avoid. */
class SpyMem extends Uint8Array {
    static slices = 0;
    slice(start?: number, end?: number): Uint8Array {
        SpyMem.slices++;
        return super.slice(start, end);
    }
}

function payload(text: string): SpyMem {
    const mem = new SpyMem(4096);
    mem.set(new TextEncoder().encode(text), 0);
    return mem;
}

afterEach(() => {
    Logger.setStreamCallback(null);
    Logger.resetCategoryLevels();
});

describe("WriteFile log-content decode gate", () => {
    test("a stream at NORMAL does not decode a routine .txt append", () => {
        Logger.setStreamCallback(() => { /* the harness's session-wide stream */ });
        Logger.setCategoryLevel(LogCategory.KERNEL32, LogLevel.NORMAL);
        // Falsifiability control: the OLD gate really would have passed here.
        expect(Logger.isEnabled(LogCategory.KERNEL32, LogLevel.VERBOSE)).toBe(true);

        SpyMem.slices = 0;
        logGuestWriteContent("C:\\game\\Log.txt", payload("frame 1234 ok"), 0, 13);
        expect(SpyMem.slices).toBe(0);
    });

    test("an error file is still decoded at NORMAL", () => {
        Logger.setStreamCallback(() => { /* same session-wide stream */ });
        Logger.setCategoryLevel(LogCategory.KERNEL32, LogLevel.NORMAL);

        SpyMem.slices = 0;
        logGuestWriteContent("C:\\game\\crash.err", payload("access violation"), 0, 16);
        expect(SpyMem.slices).toBe(1);
    });

    test("VERBOSE on the category re-enables the routine mirror", () => {
        Logger.setCategoryLevel(LogCategory.KERNEL32, LogLevel.VERBOSE);
        SpyMem.slices = 0;
        logGuestWriteContent("C:\\game\\Log.txt", payload("hello"), 0, 5);
        expect(SpyMem.slices).toBe(1);
    });

    test("a non-log extension and an oversized write are never decoded", () => {
        Logger.setCategoryLevel(LogCategory.KERNEL32, LogLevel.VERBOSE);
        SpyMem.slices = 0;
        logGuestWriteContent("C:\\game\\save.dat", payload("binary"), 0, 6);
        logGuestWriteContent("C:\\game\\Log.txt", payload("x"), 0, 32768);
        expect(SpyMem.slices).toBe(0);
    });
});
