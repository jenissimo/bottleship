import { expect, test } from "bun:test";
import { packParameter } from "../../src/worker/modules/d3dx9/effect-constants";
import { ParameterClass, ParameterType, RegisterSet, type CtabConstant } from "../../src/worker/modules/d3dx9/ctab";
import { EffectParamClass, EffectParamType, type EffectParameter } from "../../src/worker/modules/d3dx9/effect-state";

function parameter(paramClass: EffectParamClass, rows: number, columns: number, elements: number, unaligned: boolean): EffectParameter {
    const count = rows * columns * Math.max(1, elements);
    const floats = new Float32Array(count);
    for (let i = 0; i < count; i++) floats[i] = i + 1.5;
    const backing = new Uint8Array(count * 4 + 4);
    const offset = unaligned ? 1 : 0;
    backing.set(new Uint8Array(floats.buffer), offset);
    return {
        name: "p", semantic: "", type: EffectParamType.Float, paramClass, rows, columns, elements,
        annotations: [], members: [], value: backing.subarray(offset, offset + count * 4), objectPtr: 0, objectIndex: -1,
    };
}

function constant(cls: ParameterClass, rows: number, columns: number, elements: number, registerCount: number): CtabConstant {
    return {
        name: "p", registerSet: RegisterSet.Float4, registerIndex: 3, registerCount,
        type: { class: cls, type: ParameterType.Float, rows, columns, elements, members: [] },
    } as unknown as CtabConstant;
}

test("the float packer agrees with the general packer for every scalar, vector and matrix shape", () => {
    const paramClasses = [EffectParamClass.Scalar, EffectParamClass.Vector, EffectParamClass.MatrixRows, EffectParamClass.MatrixColumns];
    const constClasses = [ParameterClass.Scalar, ParameterClass.Vector, ParameterClass.MatrixRows, ParameterClass.MatrixColumns];
    let compared = 0;
    for (const pc of paramClasses) for (const cc of constClasses) {
        for (let rows = 1; rows <= 4; rows++) for (let columns = 1; columns <= 4; columns++) {
            for (let crows = 1; crows <= 4; crows++) for (let ccolumns = 1; ccolumns <= 4; ccolumns++) {
                for (const elements of [0, 1, 3]) for (const celements of [0, 3]) for (const registerCount of [1, 2, 4, 12]) {
                    const ct = constant(cc, crows, ccolumns, celements, registerCount);
                    const fast = packParameter(parameter(pc, rows, columns, elements, false), ct);
                    const general = packParameter(parameter(pc, rows, columns, elements, true), ct);
                    if (general === null) {
                        expect(fast).toBeNull();
                        continue;
                    }
                    expect(fast).not.toBeNull();
                    expect(fast!.registerIndex).toBe(general.registerIndex);
                    expect(Array.from(fast!.floats!)).toEqual(Array.from(general.floats!));
                    compared++;
                }
            }
        }
    }
    expect(compared).toBeGreaterThan(1000);
});
