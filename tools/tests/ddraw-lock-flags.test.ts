/**
 * DirectDraw Lock flag algebra (wine wined3dmapflags_from_ddrawmapflags).
 * Flag values inlined so this file does not pull ddraw/d3d module init.
 */
import { describe, expect, test } from "bun:test";
import {
    lockImpliesRead,
    lockImpliesWrite,
    lockImpliesReadOrWrite,
    lockNeedsGpuReadback,
} from "../../src/worker/modules/ddraw/lock-flags";

const DDLOCK_WAIT = 0x00000001;
const DDLOCK_READONLY = 0x00000010;
const DDLOCK_WRITEONLY = 0x00000020;
const DDLOCK_NOOVERWRITE = 0x00001000;
const DDLOCK_DISCARDCONTENTS = 0x00002000;

describe("ddraw lock flags (wine algebra)", () => {
    test("READONLY implies read only", () => {
        expect(lockImpliesRead(DDLOCK_READONLY)).toBe(true);
        expect(lockImpliesWrite(DDLOCK_READONLY)).toBe(false);
        expect(lockImpliesReadOrWrite(DDLOCK_READONLY)).toEqual({ read: true, write: false });
    });

    test("WRITEONLY implies write only — no download", () => {
        // BoD HUD: DDLOCK_WAIT | DDLOCK_WRITEONLY = 0x21
        const flags = DDLOCK_WAIT | DDLOCK_WRITEONLY;
        expect(lockImpliesRead(flags)).toBe(false);
        expect(lockImpliesWrite(flags)).toBe(true);
    });

    test("DISCARD / NOOVERWRITE suppress READ", () => {
        expect(lockImpliesRead(DDLOCK_DISCARDCONTENTS)).toBe(false);
        expect(lockImpliesRead(DDLOCK_NOOVERWRITE)).toBe(false);
        expect(lockImpliesWrite(DDLOCK_DISCARDCONTENTS)).toBe(true);
    });

    test("flagless Lock implies read+write", () => {
        expect(lockImpliesRead(0)).toBe(true);
        expect(lockImpliesWrite(0)).toBe(true);
    });

    test("WAIT alone does not suppress READ", () => {
        expect(lockImpliesRead(DDLOCK_WAIT)).toBe(true);
        expect(lockImpliesRead(DDLOCK_WAIT | DDLOCK_READONLY)).toBe(true);
    });

    test("split render storage preserves GPU pixels for WRITEONLY/NOOVERWRITE", () => {
        expect(lockNeedsGpuReadback(DDLOCK_WRITEONLY, true)).toBe(true);
        expect(lockNeedsGpuReadback(DDLOCK_NOOVERWRITE, true)).toBe(true);
        expect(lockNeedsGpuReadback(DDLOCK_WRITEONLY, false)).toBe(false);
    });

    test("DISCARDCONTENTS is the only split-storage write lock that may skip preservation", () => {
        expect(lockNeedsGpuReadback(DDLOCK_DISCARDCONTENTS, true)).toBe(false);
        expect(lockNeedsGpuReadback(DDLOCK_DISCARDCONTENTS | DDLOCK_WRITEONLY, true)).toBe(false);
    });
});
