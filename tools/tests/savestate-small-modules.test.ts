import { describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Version, VERSION_FIELDS, type VersionState } from "../../src/worker/modules/version";
import { Comdlg32, COMDLG32_FIELDS } from "../../src/worker/modules/comdlg32";
import { SmackW32, SMACKW32_FIELDS, type SmackW32State } from "../../src/worker/modules/smackw32";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Internals = Record<string, unknown>;

describe("version participant", () => {
    function version(): Version & Internals {
        const v = new Version() as Version & Internals;
        (v.ansiQueryBuffers as Map<string, unknown>).set("4198400:64", { ptr: 0x5000, size: 12 }).set("4198400:128", { ptr: 0x5010, size: 40 });
        (v.blockCache as Map<string, unknown>).set("game.exe", null);
        return v;
    }

    test("capture → restore → capture is byte-identical; the block cache is rebuilt, not saved", () => {
        const first = version().captureSavestate();
        const fresh = new Version() as Version & Internals;
        (fresh.blockCache as Map<string, unknown>).set("stale.dll", null);
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect((fresh.blockCache as Map<string, unknown>).size).toBe(0);
        expect((fresh.ansiQueryBuffers as Map<string, { ptr: number; size: number }>).get("4198400:128")).toEqual({ ptr: 0x5010, size: 40 });
    });

    test("every instance field has a policy; each part of a buffer row reaches the capture", () => {
        expect(Object.keys(new Version()).sort()).toEqual(Object.keys(VERSION_FIELDS).sort());
        const v = version();
        const before = bytes(v.captureSavestate());
        const row = (v.ansiQueryBuffers as Map<string, { ptr: number; size: number }>).get("4198400:64")!;
        row.ptr += 4;
        expect(bytes(v.captureSavestate())).not.toBe(before);
        row.ptr -= 4;
        row.size += 1;
        expect(bytes(v.captureSavestate())).not.toBe(before);
        row.size -= 1;
        expect(bytes(v.captureSavestate())).toBe(before);
        const saved: VersionState = { ansiQueryBuffers: [["1:2", 3, 4]] };
        const fresh = new Version();
        fresh.restoreSavestate(saved);
        expect(fresh.captureSavestate()).toEqual(saved);
    });

    test("the registered participant covers version with a pinned schema", () => {
        const undo = new Version().registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("version")).toBe(true);
            expect(savestateParticipants.schemas().version).toEqual({ version: 1, schemaHash: "4269409b6d7962ad" });
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("version")).toBe(false);
    });
});

describe("comdlg32 participant", () => {
    test("the extended error survives a restore; every instance field has a policy", () => {
        expect(Object.keys(new Comdlg32()).sort()).toEqual(Object.keys(COMDLG32_FIELDS).sort());
        const c = new Comdlg32() as Comdlg32 & Internals;
        c.lastError = 0x3003;
        const saved = c.captureSavestate();
        expect(saved).toEqual({ lastError: 0x3003 });
        const fresh = new Comdlg32() as Comdlg32 & Internals;
        fresh.restoreSavestate(structuredClone(saved));
        expect(fresh.lastError).toBe(0x3003);
        expect(bytes(fresh.captureSavestate())).toBe(bytes(saved));
    });

    test("the registered participant covers comdlg32 with a pinned schema", () => {
        const undo = new Comdlg32().registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("comdlg32")).toBe(true);
            expect(savestateParticipants.schemas().comdlg32).toEqual({ version: 1, schemaHash: "fb6a8d1bc1bdad6f" });
        } finally {
            undo();
        }
    });
});

describe("smackw32 participant", () => {
    function smack(): SmackW32 & Internals {
        const s = new SmackW32() as SmackW32 & Internals;
        s.fakeHandle = 0x6000;
        s.soundDriverSet = true;
        return s;
    }

    test("with no movie open, the sound driver flag survives a restore", () => {
        const first = smack().captureSavestate();
        expect(first).toEqual({ soundDriverSet: true, fakeHandle: 0x6000 });
        const fresh = new SmackW32() as SmackW32 & Internals;
        fresh.fakeHandle = 0x6000;
        (fresh.sessions as Map<number, unknown>).set(1, {});
        fresh.restoreSavestate(structuredClone(first));
        expect(fresh.soundDriverSet).toBe(true);
        expect((fresh.sessions as Map<number, unknown>).size).toBe(0);
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new SmackW32()).sort()).toEqual(Object.keys(SMACKW32_FIELDS).sort());
    });

    test("refuses an open Smacker file or SmackBuffer, by count", () => {
        const s = smack();
        (s.sessions as Map<number, unknown>).set(0x7000, {});
        expect(() => s.captureSavestate()).toThrow("1 open Smacker file(s)");
        (s.sessions as Map<number, unknown>).clear();
        (s.smackBuffers as Map<number, unknown>).set(0x7100, {});
        expect(() => s.captureSavestate()).toThrow("1 open SmackBuffer(s)");
        (s.smackBuffers as Map<number, unknown>).clear();
        expect(() => s.captureSavestate()).not.toThrow();
    });

    test("a snapshot whose fallback handle sits elsewhere is not restored", () => {
        const saved: SmackW32State = { soundDriverSet: true, fakeHandle: 0x6004 };
        const fresh = new SmackW32() as SmackW32 & Internals;
        fresh.fakeHandle = 0x6000;
        expect(() => fresh.restoreSavestate(saved)).toThrow("fallback handle booted at 0x6000");
        expect(fresh.soundDriverSet).toBe(false);
    });

    test("the registered participant refuses with a CaptureRefusal and has a pinned schema", () => {
        const s = smack();
        const undo = s.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("smackw32")).toBe(true);
            expect(savestateParticipants.schemas().smackw32).toEqual({ version: 1, schemaHash: "abdcf8d2f09257b2" });
            (s.sessions as Map<number, unknown>).set(0x7000, {});
            expect(() => savestateParticipants.all().find(p => p.id === "smackw32")!.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
    });
});
