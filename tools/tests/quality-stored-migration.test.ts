import { describe, expect, test } from "bun:test";
import {
    DEFAULT_QUALITY,
    parseStoredQuality,
    serializeStoredQuality,
    QUALITY_SCHEMA,
} from "../../src/worker/core/quality-config";

describe("parseStoredQuality", () => {
    test("a blob with no marker loses a stored internalScale of 1", () => {
        // The pre-schema 1 was the inert default, not a choice — keeping it would leave
        // every existing user opted OUT of internal scaling.
        const stored = JSON.stringify({ ...DEFAULT_QUALITY, internalScale: 1 });
        expect(parseStoredQuality(stored).internalScale).toBe(DEFAULT_QUALITY.internalScale);
        expect(DEFAULT_QUALITY.internalScale).toBe(0); // 0 === "Auto"; the migration is pointless otherwise
    });

    test("a marked blob keeps a deliberate Native", () => {
        const stored = JSON.stringify({ ...DEFAULT_QUALITY, internalScale: 1, schema: QUALITY_SCHEMA });
        expect(parseStoredQuality(stored).internalScale).toBe(1);
    });

    test("the migration touches ONLY the value it is about", () => {
        for (const scale of [0, 2, 4]) {
            const stored = JSON.stringify({ ...DEFAULT_QUALITY, internalScale: scale });
            expect(parseStoredQuality(stored).internalScale).toBe(scale);
        }
    });

    test("it does not disturb the other fields of an unmarked blob", () => {
        const stored = JSON.stringify({ internalScale: 1, msaa: 4, brightness: 1.5, crt: true });
        const out = parseStoredQuality(stored);
        expect(out.msaa).toBe(4);
        expect(out.brightness).toBe(1.5);
        expect(out.crt).toBe(true);
    });

    test("what we write is read back unchanged — including a Native choice", () => {
        for (const internalScale of [0, 1, 2, 4]) {
            const q = { ...DEFAULT_QUALITY, internalScale };
            expect(parseStoredQuality(serializeStoredQuality(q))).toEqual(q);
        }
    });

    test("the marker never reaches the config handed to the worker", () => {
        const out = parseStoredQuality(serializeStoredQuality(DEFAULT_QUALITY)) as Record<string, unknown>;
        expect("schema" in out).toBe(false);
    });

    test("junk, empty and absent storage all fall back to the defaults", () => {
        for (const raw of [null, undefined, "", "not json", "[]", '"a string"', "null", "7"]) {
            expect(parseStoredQuality(raw)).toEqual(DEFAULT_QUALITY);
        }
    });
});
