/**
 * D3DXCreateEffectEx's pSkipConstants, pinned.
 *
 * A skipped constant is register-bound but owned by the APP: it uploads the value itself with
 * a raw SetVertexShaderConstantF, and d3dx builds no constant set for it (Wine's
 * d3dx_create_param_eval drops it while walking the constant table). Applying ours anyway
 * replaces a live per-frame transform with the effect's authored default — which is how
 * Red Alert 3's world collapsed to a zero ViewProjection.
 */
import { describe, expect, test } from "bun:test";
import { parseSkipConstantsList } from "../../src/worker/modules/d3dx9/effect-state";
import { bindConstants } from "../../src/worker/modules/d3dx9/effect-constants";
import { EffectParamClass, EffectParamType, type EffectParameter } from "../../src/worker/modules/d3dx9/effect-state";
import { ParameterClass, ParameterType, RegisterSet, type CtabConstant, type CtabTable } from "../../src/worker/modules/d3dx9/ctab";

function param(name: string): EffectParameter {
    return {
        name,
        semantic: "",
        type: EffectParamType.Float,
        paramClass: EffectParamClass.MatrixRows,
        rows: 4,
        columns: 4,
        elements: 0,
        annotations: [],
        members: [],
        value: new Uint8Array(64),
        objectPtr: 0,
        objectIndex: -1,
    };
}

function constant(name: string, registerIndex: number): CtabConstant {
    return {
        name,
        registerSet: RegisterSet.Float4,
        registerIndex,
        registerCount: 4,
        type: {
            class: ParameterClass.MatrixColumns,
            type: ParameterType.Float,
            rows: 4,
            columns: 4,
            elements: 0,
            members: [],
        },
        defaultValue: null,
        defaultValueOffset: 0,
    };
}

const table: CtabTable = {
    creator: "test",
    version: 0xfffe0300,
    target: "vs_3_0",
    constants: [constant("ViewProjection", 119), constant("World", 0)],
    raw: new Uint8Array(0),
};

describe("pSkipConstants tokenizing", () => {
    test("splits on anything that is not an identifier character", () => {
        // Red Alert 3's own list, verbatim from the guest.
        const set = parseSkipConstantsList("WorldBones;ViewProjection;EyePosition;");
        expect([...set!].sort()).toEqual(["EyePosition", "ViewProjection", "WorldBones"]);
    });

    test("separators other than ';' work the same way", () => {
        expect([...parseSkipConstantsList("A B,C")!]).toEqual(["A", "B", "C"]);
    });

    test("a name may not start with a digit", () => {
        expect([...parseSkipConstantsList("1abc;_d2")!]).toEqual(["abc", "_d2"]);
    });

    test("an empty or separator-only list names nothing", () => {
        expect(parseSkipConstantsList("")).toBeUndefined();
        expect(parseSkipConstantsList(";;;")).toBeUndefined();
    });
});

describe("bindConstants honours the skip list", () => {
    const params = [param("ViewProjection"), param("World")];

    test("without a skip list every register-bound constant binds", () => {
        expect(bindConstants(params, table).map((p) => p.constant.name)).toEqual(["ViewProjection", "World"]);
    });

    test("a skipped constant produces no binding, so nothing uploads its register", () => {
        const bound = bindConstants(params, table, parseSkipConstantsList("ViewProjection;")!);
        expect(bound.map((p) => p.constant.name)).toEqual(["World"]);
    });

    test("a skip name the shader does not use changes nothing", () => {
        const bound = bindConstants(params, table, parseSkipConstantsList("NotHere;")!);
        expect(bound.map((p) => p.constant.name)).toEqual(["ViewProjection", "World"]);
    });
});
