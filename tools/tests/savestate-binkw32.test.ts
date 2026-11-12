import { describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { BinkW32, BINKW32_FIELDS, type BinkW32State } from "../../src/worker/modules/binkw32";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Internals = Record<string, unknown>;

function bink(): BinkW32 & Internals {
    const b = new BinkW32() as BinkW32 & Internals;
    b.lastSurfaceBpp = 2;
    b.ddPrimary = 0x5fb00490;
    b.pendingIoSize = 0x20000;
    return b;
}

describe("binkw32 participant", () => {
    test("with no movie open, the surface type, the primary surface and the IO size survive a restore", () => {
        const first = bink().captureSavestate();
        const fresh = new BinkW32() as BinkW32 & Internals;
        (fresh.sessions as Map<number, unknown>).set(1, {});
        (fresh.apiCallLog as Map<number, number>).set(1, 3);
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect((fresh.sessions as Map<number, unknown>).size).toBe(0);
        expect((fresh.apiCallLog as Map<number, number>).size).toBe(0);
        expect(fresh.buildResolution).toBeNull();
    });

    test("every instance field has a policy; every saved field reaches the capture and survives a restore", () => {
        expect(Object.keys(new BinkW32()).sort()).toEqual(Object.keys(BINKW32_FIELDS).sort());
        const base = bink().captureSavestate();
        const values: BinkW32State = { lastSurfaceBpp: 4, ddPrimary: 0x5fb00500, pendingIoSize: 0x8000 };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof BinkW32State, number]>) {
            expect({ field, same: value === base[field] }).toEqual({ field, same: false });
            const fresh = new BinkW32();
            fresh.restoreSavestate({ ...base, [field]: value });
            expect({ field, value: fresh.captureSavestate()[field] }).toEqual({ field, value });
        }
    });

    test("refuses an open Bink file or BinkBuffer, by count", () => {
        const b = bink();
        (b.sessions as Map<number, unknown>).set(0x7000, {}).set(0x7100, {});
        expect(() => b.captureSavestate()).toThrow("2 open Bink file(s)");
        (b.sessions as Map<number, unknown>).clear();
        (b.binkBuffers as Map<number, unknown>).set(0x7200, {});
        expect(() => b.captureSavestate()).toThrow("1 open BinkBuffer(s)");
        (b.binkBuffers as Map<number, unknown>).clear();
        expect(() => b.captureSavestate()).not.toThrow();
    });

    test("the registered participant covers binkw32, refuses with a CaptureRefusal and has a pinned schema", () => {
        const b = bink();
        const undo = b.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("binkw32")).toBe(true);
            expect(savestateParticipants.schemas().binkw32).toEqual({ version: 1, schemaHash: "c59f0330c1e29a8c" });
            (b.sessions as Map<number, unknown>).set(0x7000, {});
            expect(() => savestateParticipants.all().find(p => p.id === "binkw32")!.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("binkw32")).toBe(false);
    });
});
