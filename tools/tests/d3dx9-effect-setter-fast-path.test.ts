import { afterEach, expect, test } from "bun:test";
import { createEffectExports } from "../../src/worker/modules/d3dx9/effects";
import {
    EffectParamClass, EffectParamType, effectParamStamp, handleForParameter, nextEffectStamp,
    registerEffectInstance, resetEffectInstances, type EffectInstance, type EffectParameter,
} from "../../src/worker/modules/d3dx9/effect-state";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import type { FastPathImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const EFFECT = 0x1000, TEXTURE = 0x2000, STACK = 0x3000, DATA = 0x4000;
const memory = new Uint8Array(0x10000);
const view = new DataView(memory.buffer);

afterEach(() => {
    resetEffectInstances();
    memory.fill(0);
});

function fastPaths(): Map<string, { impl: FastPathImplementation; trivial: boolean }> {
    const registered = new Map<string, { impl: FastPathImplementation; trivial: boolean }>();
    const dispatcher = {
        registerFastPath(dll: string, name: string, impl: FastPathImplementation, options?: { trivial?: boolean }) {
            registered.set(`${dll}:${name}`, { impl, trivial: !!options?.trivial });
        },
    };
    createEffectExports({ dispatcher } as any);
    return registered;
}

test("the per-object value setters are registered as trivial fast paths; pass application is not", () => {
    const registered = fastPaths();
    for (const name of ["SetVector", "SetVectorArray", "SetMatrix", "SetMatrixPointerArray", "SetTexture", "SetFloat"]) {
        expect(registered.get(`d3dx9:ID3DXEffect_${name}`)?.trivial).toBe(true);
    }
    for (const name of ["BeginPass", "CommitChanges", "SetValue", "SetTechnique"]) {
        expect(registered.has(`d3dx9:ID3DXEffect_${name}`)).toBe(false);
    }
});

function call(impl: FastPathImplementation, ...args: number[]): number | null | undefined {
    Mem.bind(() => memory);
    view.setUint32(STACK, 0x401000, true);
    args.forEach((value, i) => view.setUint32(STACK + 4 + i * 4, value, true));
    return impl(STACK, view, memory, new Uint32Array(memory.buffer), null);
}

function effectWith(parameter: EffectParameter): void {
    const inst: EffectInstance = {
        model: { creator: "", parameters: [parameter], techniques: [], objects: [] },
        annotations: [], devicePtr: 0, currentTechnique: 0, activePass: -1,
    };
    registerEffectInstance(EFFECT, inst);
}

test("a fast-path setter reads its arguments above the return address and marks the parameter written", () => {
    const tint: EffectParameter = {
        name: "Tint", semantic: "", type: EffectParamType.Float, paramClass: EffectParamClass.Vector,
        rows: 1, columns: 4, elements: 0, annotations: [], members: [], value: new Uint8Array(16), objectPtr: 0, objectIndex: -1,
    };
    effectWith(tint);
    const setVector = fastPaths().get("d3dx9:ID3DXEffect_SetVector")!.impl;
    [0.25, 0.5, 0.75, 1].forEach((v, i) => view.setFloat32(DATA + i * 4, v, true));
    const before = nextEffectStamp();
    expect(call(setVector, EFFECT, handleForParameter(0), DATA)).toBe(0);
    expect(Array.from(new Float32Array(tint.value.buffer))).toEqual([0.25, 0.5, 0.75, 1]);
    expect(effectParamStamp(tint)).toBeGreaterThan(before);
    expect(call(setVector, EFFECT, handleForParameter(5), DATA)).toBe(0x8876086c);
    expect(call(setVector, EFFECT, handleForParameter(0), 0)).toBe(0x8876086c);
});

test("a fast-path SetTexture stores the interface pointer", () => {
    const texture: EffectParameter = {
        name: "DiffuseMap", semantic: "", type: EffectParamType.Texture2D, paramClass: EffectParamClass.Object,
        rows: 1, columns: 1, elements: 0, annotations: [], members: [], value: new Uint8Array(0), objectPtr: 0, objectIndex: -1,
    };
    effectWith(texture);
    const setTexture = fastPaths().get("d3dx9:ID3DXEffect_SetTexture")!.impl;
    const before = nextEffectStamp();
    expect(call(setTexture, EFFECT, handleForParameter(0), TEXTURE)).toBe(0);
    expect(texture.objectPtr).toBe(TEXTURE);
    expect(effectParamStamp(texture)).toBeGreaterThan(before);
    const unchanged = nextEffectStamp();
    expect(call(setTexture, EFFECT, handleForParameter(0), TEXTURE)).toBe(0);
    expect(effectParamStamp(texture)).toBeLessThan(unchanged);
});
