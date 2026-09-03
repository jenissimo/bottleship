/**
 * D3D9 COM refcount storage: the guest block is authoritative under
 * the default guest storage (opt out with __d3d9MirrorRefcount), and the oracle can FAIL.
 *
 * The second half is the point. An oracle that only ever reports "agree" converts
 * an unchecked invariant into a false assurance, so this pins that a count
 * corrupted behind the accessors' back is REPORTED, not smoothed over.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    D3D9_COM_REFCOUNT_OFFSET,
    addComRef,
    d3d9RefcountStorageStats,
    drainComFinalizers,
    getComRefCount,
    releaseComRef,
    trackComObject,
    unpinGuestRefcountStoreForTests,
} from "../../src/worker/modules/d3d9/com-refs";

const OBJ = 0x2000;
let mem: Uint8Array;

function guestWord(ptr: number): number {
    return new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
        .getUint32(ptr + D3D9_COM_REFCOUNT_OFFSET, true);
}

const flags = globalThis as { __d3d9MirrorRefcount?: boolean; __d3d9RefcountVerify?: boolean };

describe("d3d9 guest-memory COM refcount", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        drainComFinalizers();
        d3d9RefcountStorageStats(true);
        // A live stub in another file PINS the guest store for the process, and a pinned
        // store makes this file's oracle answer "not applicable" instead of running.
        unpinGuestRefcountStoreForTests();
        flags.__d3d9MirrorRefcount = false;
    });

    afterEach(() => {
        flags.__d3d9MirrorRefcount = true;   // opt back into the JS mirror
        flags.__d3d9RefcountVerify = false;
        drainComFinalizers();
    });

    test("opting back into the JS mirror leaves the guest block untouched", () => {
        flags.__d3d9MirrorRefcount = true;
        trackComObject(OBJ);
        addComRef(OBJ);
        expect(getComRefCount(OBJ)).toBe(2);
        expect(guestWord(OBJ)).toBe(0);
        expect(d3d9RefcountStorageStats().verdict).toBe("oracle did not run");
    });

    test("guest block is the count of record when the flag is on", () => {
        flags.__d3d9MirrorRefcount = false;
        trackComObject(OBJ);
        expect(guestWord(OBJ)).toBe(1);
        addComRef(OBJ);
        addComRef(OBJ);
        expect(guestWord(OBJ)).toBe(3);
        expect(getComRefCount(OBJ)).toBe(3);
        releaseComRef(OBJ);
        expect(guestWord(OBJ)).toBe(2);
    });

    test("the last release zeroes the word and runs the finalizer once", () => {
        flags.__d3d9MirrorRefcount = false;
        let disposed = 0;
        trackComObject(OBJ, () => { disposed++; });
        expect(releaseComRef(OBJ)).toBe(0);
        expect(disposed).toBe(1);
        expect(guestWord(OBJ)).toBe(0);
        expect(getComRefCount(OBJ)).toBeUndefined();
    });

    test("a flag flipped mid-run reseeds the guest words from the mirror", () => {
        flags.__d3d9MirrorRefcount = true;
        trackComObject(OBJ);
        addComRef(OBJ);            // count 2, guest word still untouched
        expect(guestWord(OBJ)).toBe(0);
        flags.__d3d9MirrorRefcount = false;
        expect(getComRefCount(OBJ)).toBe(2);
        expect(guestWord(OBJ)).toBe(2);
    });

    test("verify mode agrees when nothing corrupts the word", () => {
        flags.__d3d9RefcountVerify = true;
        trackComObject(OBJ);
        for (let i = 0; i < 50; i++) addComRef(OBJ);
        const s = d3d9RefcountStorageStats();
        expect(s.checked).toBeGreaterThan(0);
        expect(s.mismatch).toBe(0);
        expect(s.verdict).toBe("agree");
    });

    test("verify mode CAN fail: a word corrupted behind the accessors is reported", () => {
        flags.__d3d9RefcountVerify = true;
        trackComObject(OBJ);
        addComRef(OBJ);
        // The bypass the oracle exists to catch: a writer that is not these accessors.
        new DataView(mem.buffer).setUint32(OBJ + D3D9_COM_REFCOUNT_OFFSET, 99, true);
        addComRef(OBJ);
        const s = d3d9RefcountStorageStats();
        expect(s.mismatch).toBeGreaterThan(0);
        expect(s.verdict).toBe("DISAGREE");
        expect(s.firstMismatch).toContain("guest=99");
    });

    test("checked:0 reports 'oracle did not run' rather than passing", () => {
        flags.__d3d9MirrorRefcount = false;  // guest storage on, verify off
        trackComObject(OBJ);
        addComRef(OBJ);
        const s = d3d9RefcountStorageStats();
        expect(s.checked).toBe(0);
        expect(s.verdict).toBe("oracle did not run");
    });
});
