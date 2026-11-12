import { expect, test } from "bun:test";
import { EFFECT_METHODS, FAST_SETTERS } from "../../src/worker/modules/d3dx9/effects";
import { selectEffectTechnique } from "../../src/worker/modules/d3dx9/effect-lifetime";
import {
    EffectParamClass, EffectParamType, effectParamStamp, markEffectParamWritten,
    type EffectInstance, type EffectParameter,
} from "../../src/worker/modules/d3dx9/effect-state";

function param(name: string, over: Partial<EffectParameter>): EffectParameter {
    return {
        name, semantic: "", type: EffectParamType.Float, paramClass: EffectParamClass.Scalar, rows: 1, columns: 1,
        elements: 0, annotations: [], members: [], value: new Uint8Array(0), objectPtr: 0, objectIndex: -1, ...over,
    };
}

test("a struct with a value block reports a write to an object-typed member", () => {
    const block = new Uint8Array(16);
    const scalar = param("Gain", { value: block.subarray(0, 4) });
    const texture = param("Map", { type: EffectParamType.Texture, paramClass: EffectParamClass.Object, rows: 0, columns: 0 });
    const struct = param("Material", { paramClass: EffectParamClass.Struct, value: block, members: [scalar, texture] });

    markEffectParamWritten(scalar);
    const afterNumeric = effectParamStamp(struct);
    expect(afterNumeric).toBeGreaterThan(0);

    markEffectParamWritten(texture);
    expect(effectParamStamp(struct)).toBeGreaterThan(afterNumeric);
    expect(effectParamStamp(scalar)).toBe(afterNumeric);
});

test("selecting another technique ends the active pass; reselecting the current one keeps it", () => {
    const inst = { currentTechnique: 0, activePass: 2 } as EffectInstance;
    selectEffectTechnique(inst, 0);
    expect(inst.activePass).toBe(2);
    selectEffectTechnique(inst, 1);
    expect(inst.currentTechnique).toBe(1);
    expect(inst.activePass).toBe(-1);
});

test("every fast-path setter carries the argument count of its effect method", () => {
    const methods = new Map(EFFECT_METHODS);
    expect(FAST_SETTERS.length).toBeGreaterThan(10);
    for (const [name, argCount] of FAST_SETTERS) {
        expect(methods.has(name)).toBe(true);
        expect([name, argCount]).toEqual([name, methods.get(name)!]);
    }
});
