/**
 * The storage rules an effect parameter's value block obeys, pinned.
 *
 * These are the three that are invisible until the art is wrong: a MATRIX_COLUMNS parameter is
 * stored column-major (Wine's get_const_upload_info reads it as `data[column * rows + row]`),
 * only the top-left rows x columns corner of a D3DXMATRIX survives, and SetInt on a float
 * vector is the D3DCOLOR path rather than a refusal.
 */
import { describe, expect, test } from "bun:test";
import {
    getMatrix,
    readNumber,
    setMatrix,
    setScalarInt,
    setVector,
    setVectorArray,
    setRawValue,
    getVectorArray,
} from "../../src/worker/modules/d3dx9/effect-values";
import { EffectParamClass, EffectParamType, type EffectParameter } from "../../src/worker/modules/d3dx9/effect-state";

function makeParam(
    paramClass: EffectParamClass,
    type: EffectParamType,
    rows: number,
    columns: number,
    elements = 0,
): EffectParameter {
    const count = Math.max(1, elements) * rows * columns;
    return {
        name: "p",
        semantic: "",
        type,
        paramClass,
        rows,
        columns,
        elements,
        annotations: [],
        members: [],
        value: new Uint8Array(count * 4),
        objectPtr: 0,
        objectIndex: -1,
    };
}

/** A 4x4 whose element (r,c) reads as r*10+c, so a transpose is unmistakable. */
const IDENTIFIABLE = new Float32Array(16);
for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) IDENTIFIABLE[r * 4 + c] = r * 10 + c;

function slots(param: EffectParameter): number[] {
    const out: number[] = [];
    for (let i = 0; i < param.value.length / 4; i++) out.push(readNumber(param, i));
    return out;
}

describe("effect parameter storage", () => {
    test("MATRIX_ROWS stores row-major", () => {
        const param = makeParam(EffectParamClass.MatrixRows, EffectParamType.Float, 4, 4);
        expect(setMatrix(param, IDENTIFIABLE, false)).toBe(true);
        expect(slots(param).slice(0, 8)).toEqual([0, 1, 2, 3, 10, 11, 12, 13]);
    });

    test("MATRIX_COLUMNS stores column-major", () => {
        const param = makeParam(EffectParamClass.MatrixColumns, EffectParamType.Float, 4, 4);
        expect(setMatrix(param, IDENTIFIABLE, false)).toBe(true);
        expect(slots(param).slice(0, 8)).toEqual([0, 10, 20, 30, 1, 11, 21, 31]);
    });

    test("a 4x3 keeps only the top-left corner, and reads back widened", () => {
        const param = makeParam(EffectParamClass.MatrixRows, EffectParamType.Float, 4, 3);
        expect(setMatrix(param, IDENTIFIABLE, false)).toBe(true);
        expect(slots(param).slice(0, 6)).toEqual([0, 1, 2, 10, 11, 12]);

        const out = new Float32Array(16);
        getMatrix(param, out, false);
        expect(Array.from(out.slice(0, 4))).toEqual([0, 1, 2, 0]);
        expect(Array.from(out.slice(12, 16))).toEqual([30, 31, 32, 0]);
    });

    test("SetMatrixTranspose transposes on the way in", () => {
        const param = makeParam(EffectParamClass.MatrixRows, EffectParamType.Float, 4, 4);
        expect(setMatrix(param, IDENTIFIABLE, true)).toBe(true);
        expect(slots(param).slice(0, 4)).toEqual([0, 10, 20, 30]);
    });

    test("a float3 vector keeps three components, not four", () => {
        const param = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 3);
        expect(setVector(param, [1, 2, 3, 4])).toBe(true);
        expect(slots(param)).toEqual([1, 2, 3]);
    });

    test("a float3 array packs tightly in the value block", () => {
        const param = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 3, 2);
        expect(setVectorArray(param, [1, 2, 3, 9, 4, 5, 6, 9], 2)).toBe(true);
        expect(slots(param)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("SetInt on a float3 is the D3DCOLOR path", () => {
        const param = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 3);
        expect(setScalarInt(param, 0x00ff8000)).toBe(true);
        const v = slots(param);
        expect(v[0]).toBeCloseTo(1, 5);
        expect(v[1]).toBeCloseTo(128 / 255, 5);
        expect(v[2]).toBeCloseTo(0, 5);
    });

    test("a shape the real d3dx refuses is refused, not approximated", () => {
        const matrix = makeParam(EffectParamClass.MatrixRows, EffectParamType.Float, 4, 4);
        expect(setVector(matrix, [1, 2, 3, 4])).toBe(false);
        const array = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 4, 2);
        expect(setVector(array, [1, 2, 3, 4])).toBe(false);
    });
});

/**
 * SetValue is the generic setter and an engine may bind its textures through it rather than
 * SetTexture. A texture parameter has no value BLOCK — the compiled effect keeps an object
 * index there — so a block-copy implementation refuses the call, and the effect then resolves
 * every sampler to NULL with nothing reporting a failure.
 */
describe("SetValue on an object parameter", () => {
    function textureParam(): EffectParameter {
        const p = makeParam(EffectParamClass.Object, EffectParamType.Texture2D, 1, 1);
        p.value = new Uint8Array(0);       // object parameters carry no value block
        return p;
    }

    test("carries the interface pointer into objectPtr", () => {
        const p = textureParam();
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, 0x5fb0a690, true);
        expect(setRawValue(p, bytes)).toBe(true);
        expect(p.objectPtr >>> 0).toBe(0x5fb0a690);
    });

    test("a short buffer is refused rather than read past", () => {
        expect(setRawValue(textureParam(), new Uint8Array(2))).toBe(false);
    });

    test("a numeric parameter still takes the block copy", () => {
        const p = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 4);
        const bytes = new Uint8Array(16);
        new DataView(bytes.buffer).setFloat32(0, 0.5, true);
        expect(setRawValue(p, bytes)).toBe(true);
        expect(readNumber(p, 0)).toBeCloseTo(0.5, 5);
        expect(p.objectPtr).toBe(0);
    });
});

/**
 * GetVectorArray was declared in the vtable and never implemented, so it answered S_OK and
 * wrote NOTHING — the caller then read its own uninitialised buffer as vector data. The zero
 * fill past the parameter's own elements is part of the contract for that reason.
 */
describe("getVectorArray", () => {
    test("round-trips what setVectorArray wrote", () => {
        const p = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 3, 2);
        setVectorArray(p, [1, 2, 3, 0, 4, 5, 6, 0], 2);
        const out = new Float32Array(8).fill(-1);
        getVectorArray(p, out, 2);
        expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 3]);
        expect(out[3]).toBe(0);                       // 4th component of a float3 is zero
        expect(Array.from(out.subarray(4, 7))).toEqual([4, 5, 6]);
    });

    test("elements past the parameter are zeroed, not left as the caller's garbage", () => {
        const p = makeParam(EffectParamClass.Vector, EffectParamType.Float, 1, 4, 1);
        setVectorArray(p, [9, 9, 9, 9], 1);
        const out = new Float32Array(12).fill(-1);
        getVectorArray(p, out, 3);
        expect(Array.from(out.subarray(0, 4))).toEqual([9, 9, 9, 9]);
        expect(Array.from(out.subarray(4, 12))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
});
