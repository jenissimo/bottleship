import { afterEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Comctl32, COMCTL32_FIELDS, type Comctl32State } from "../../src/worker/modules/comctl32";
import { resetFlatSbState } from "../../src/worker/modules/comctl32-flatsb";
import { getSheetByFrame, openPropSheetCount, resetPropSheetState } from "../../src/worker/modules/comctl32-propsheet";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Handler = (c: unknown, m: Uint8Array, a: number[]) => unknown;
type Internals = Record<string, unknown> & { exports: Record<string, Handler> };

function used(): Comctl32 & Internals {
    const c = new Comctl32() as Comctl32 & Internals;
    c.initialize({} as never);
    c.nextImageListHandle = 5;
    c.nextIconHandle = 0x2003;
    c.nextPropPageHandle = 0x8002;
    (c.propPageHandles as Map<number, number>).set(0x8000, 0x500000).set(0x8001, 0x500100);
    c.exports["InitializeFlatSB"]!({}, new Uint8Array(0), [0x10001]);
    return c;
}

afterEach(() => {
    resetFlatSbState();
    resetPropSheetState();
});

describe("comctl32 participant", () => {
    test("capture → restore → capture is byte-identical in a fresh module", () => {
        const first = used().captureSavestate();
        expect(first.flatSb.windows).toEqual([0x10001]);
        resetFlatSbState();
        const fresh = new Comctl32() as Comctl32 & Internals;
        (fresh.imageLists as Map<number, unknown>).set(9, {});
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect((fresh.imageLists as Map<number, unknown>).size).toBe(0);
    });

    test("every instance field has a policy; every saved field reaches the capture and survives a restore", () => {
        expect(Object.keys(new Comctl32()).sort()).toEqual(Object.keys(COMCTL32_FIELDS).sort());
        const base = used().captureSavestate();
        const values: Comctl32State = {
            nextImageListHandle: 7, nextIconHandle: 0x2010, nextPropPageHandle: 0x8010, propPageHandles: [[0x8005, 0x600000]],
            nextSheetId: 4, flatSb: { windows: [0x10002, 0x10003], props: [[0x10002, [[1, 2], [3, 4]]]] },
        };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof Comctl32State, unknown]>) {
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            const fresh = new Comctl32();
            fresh.restoreSavestate(structuredClone({ ...base, [field]: value }) as Comctl32State);
            expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("refuses image lists by count and handle", () => {
        const c = used();
        (c.imageLists as Map<number, unknown>).set(1, {}).set(2, {});
        expect(() => c.captureSavestate()).toThrow("comctl32: 2 image list(s) are not part of a v1 savestate (0x1, 0x2)");
        (c.imageLists as Map<number, unknown>).clear();
        expect(() => c.captureSavestate()).not.toThrow();
    });

    test("refuses an open property sheet by count", () => {
        const c = used();
        expect(() => c.captureSavestate(1)).toThrow("comctl32: 1 open property sheet(s) are not part of a v1 savestate");
        expect(() => c.captureSavestate(0)).not.toThrow();
    });

    test("a restore leaves no property sheet behind", () => {
        const c = used();
        const saved = c.captureSavestate();
        c.restoreSavestate(saved);
        expect(openPropSheetCount()).toBe(0);
        expect(getSheetByFrame(0x10001)).toBeUndefined();
    });

    test("the registered participant covers comctl32, refuses with a CaptureRefusal and has a pinned schema", () => {
        const c = used();
        const undo = c.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("comctl32")).toBe(true);
            expect(savestateParticipants.schemas().comctl32).toEqual({ version: 1, schemaHash: "32eba138abc2f340" });
            (c.imageLists as Map<number, unknown>).set(1, {});
            expect(() => savestateParticipants.all().find(p => p.id === "comctl32")!.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("comctl32")).toBe(false);
    });
});
