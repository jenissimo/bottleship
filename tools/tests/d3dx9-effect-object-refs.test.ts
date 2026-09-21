/**
 * An effect's object parameter holds a COUNTED reference — pinned.
 *
 * D3DX AddRefs what SetTexture/SetValue take, Releases what they displace, and hands every Get*
 * a counted copy (Wine d3dx9_36/effect.c:3610, :928, :3637, :2506). An app that follows COM
 * Releases its own handle as soon as the effect has taken one, so storing the bare pointer is an
 * over-release: the texture dies while the effect still names it and the next dispatch through
 * the recycled block runs whatever moved in.
 *
 * The counts are asserted through the real registry rather than a stand-in, because the bug this
 * pins is precisely that the registry was never told. `__d3d9MirrorRefcount` keeps the count in
 * the JS map so the assertions need no guest memory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setObjectParam, retainReturnedObject } from "../../src/worker/modules/d3dx9/effect-values";
import { EffectParamClass, EffectParamType, type EffectParameter } from "../../src/worker/modules/d3dx9/effect-state";
import {
    addComRef, getComRefCount, releaseComRef, trackComObject,
} from "../../src/worker/modules/d3d9/com-refs";

const A = 0x0aaa0000;
const B = 0x0bbb0000;

function textureParam(): EffectParameter {
    return {
        name: "tex", semantic: "", type: EffectParamType.Texture2D, paramClass: EffectParamClass.Object,
        rows: 1, columns: 1, elements: 0, annotations: [], members: [],
        value: new Uint8Array(0), objectPtr: 0, objectIndex: -1,
    };
}

let prevFlag: unknown;
beforeAll(() => {
    prevFlag = (globalThis as Record<string, unknown>).__d3d9MirrorRefcount;
    (globalThis as Record<string, unknown>).__d3d9MirrorRefcount = true;
});
afterAll(() => { (globalThis as Record<string, unknown>).__d3d9MirrorRefcount = prevFlag; });

describe("effect object parameters are reference-counted", () => {
    test("Set takes a reference, and displacing one gives it back", () => {
        trackComObject(A);
        trackComObject(B);
        expect(getComRefCount(A)).toBe(1);

        const param = textureParam();
        setObjectParam(param, A);
        expect(param.objectPtr).toBe(A);
        expect(getComRefCount(A)).toBe(2);

        // Setting the SAME pointer must not churn the count: D3DX compares first.
        setObjectParam(param, A);
        expect(getComRefCount(A)).toBe(2);

        setObjectParam(param, B);
        expect(getComRefCount(B)).toBe(2);
        expect(getComRefCount(A)).toBe(1);

        // Clearing the parameter releases the one it held.
        setObjectParam(param, 0);
        expect(getComRefCount(B)).toBe(1);

        releaseComRef(A);
        releaseComRef(B);
    });

    test("a Get hands the caller its own reference", () => {
        trackComObject(A);
        const param = textureParam();
        setObjectParam(param, A);
        expect(getComRefCount(A)).toBe(2);

        // What the app Releases after reading it back.
        expect(retainReturnedObject(param.objectPtr)).toBe(A);
        expect(getComRefCount(A)).toBe(3);
        releaseComRef(A);
        expect(getComRefCount(A)).toBe(2);

        setObjectParam(param, 0);
        releaseComRef(A);
    });

    test("an untracked pointer is stored, and counts nothing", () => {
        const param = textureParam();
        setObjectParam(param, 0x1234000);
        expect(param.objectPtr).toBe(0x1234000);
        expect(getComRefCount(0x1234000)).toBeUndefined();
        expect(addComRef(0x1234000)).toBeUndefined();
    });
});
