import { afterEach, expect, test } from "bun:test";
import { applyPassStates } from "../../src/worker/modules/d3dx9/effect-apply";
import { bindSharedParameters, createEffectPool, resetEffectPools } from "../../src/worker/modules/d3dx9/effect-pool";
import { EFFECT_STATE_TABLE, EffectStateClass } from "../../src/worker/modules/d3dx9/effect-state-table";
import { setVector } from "../../src/worker/modules/d3dx9/effect-values";
import {
    EffectAssignmentKind, EffectParamClass, EffectParamType, effectParamStamp,
    type EffectInstance, type EffectParameter, type EffectPass,
} from "../../src/worker/modules/d3dx9/effect-state";

const stateId = (cls: EffectStateClass): number => EFFECT_STATE_TABLE.findIndex((s) => s.cls === cls);

function constantTable(constants: Array<{ name: string; set: number; register: number; count: number; cls: number; type: number; rows: number; columns: number }>): number[] {
    const infoAt = 28;
    const typesAt = infoAt + constants.length * 20;
    const namesAt = typesAt + constants.length * 16;
    const names = constants.map((c) => new TextEncoder().encode(c.name + "\0"));
    const total = namesAt + names.reduce((n, b) => n + b.length, 0);
    const raw = new Uint8Array(Math.ceil(total / 4) * 4);
    const v = new DataView(raw.buffer);
    v.setUint32(0, 28, true);
    v.setUint32(12, constants.length, true);
    v.setUint32(16, infoAt, true);
    let nameAt = namesAt;
    constants.forEach((c, i) => {
        const info = infoAt + i * 20;
        const type = typesAt + i * 16;
        v.setUint32(info, nameAt, true);
        v.setUint16(info + 4, c.set, true);
        v.setUint16(info + 6, c.register, true);
        v.setUint16(info + 8, c.count, true);
        v.setUint32(info + 12, type, true);
        v.setUint16(type, c.cls, true);
        v.setUint16(type + 2, c.type, true);
        v.setUint16(type + 4, c.rows, true);
        v.setUint16(type + 6, c.columns, true);
        raw.set(names[i]!, nameAt);
        nameAt += names[i]!.length;
    });
    return [...new Uint32Array(raw.buffer)];
}

function shaderBytes(): Uint8Array {
    const ctab = constantTable([
        { name: "Tint", set: 2, register: 5, count: 1, cls: 1, type: 3, rows: 1, columns: 4 },
        { name: "World", set: 2, register: 8, count: 4, cls: 3, type: 3, rows: 4, columns: 4 },
        { name: "Diffuse", set: 3, register: 0, count: 1, cls: 4, type: 12, rows: 1, columns: 1 },
    ]);
    return new Uint8Array(new Uint32Array([0xfffe0200, ((ctab.length + 1) << 16) | 0xfffe, 0x42415443, ...ctab, 0xffff]).buffer);
}

const SHARED = 1;
const POOL = 0x700;

function vector(name: string, value: Uint8Array, flags = 0): EffectParameter {
    return {
        name, semantic: "", type: EffectParamType.Float, paramClass: EffectParamClass.Vector, rows: 1, columns: 4, elements: 0,
        annotations: [], members: [], value, objectPtr: 0, objectIndex: -1, flags,
    };
}

function lightStruct(): EffectParameter {
    const value = new Uint8Array(32);
    return {
        name: "Light", semantic: "", type: EffectParamType.Float, paramClass: EffectParamClass.Struct, rows: 0, columns: 0, elements: 0,
        annotations: [], members: [vector("Position", value.subarray(0, 16)), vector("Colour", value.subarray(16, 32))],
        value, objectPtr: 0, objectIndex: -1, flags: SHARED,
    };
}

function rowArray(): EffectParameter {
    const value = new Uint8Array(32);
    return {
        name: "Rows", semantic: "", type: EffectParamType.Float, paramClass: EffectParamClass.Vector, rows: 1, columns: 4, elements: 2,
        annotations: [], members: [], elementsList: [vector("Rows", value.subarray(0, 16)), vector("Rows", value.subarray(16, 32))],
        value, objectPtr: 0, objectIndex: -1, flags: SHARED,
    };
}

function effect() {
    const tint = vector("Tint", new Uint8Array(16), SHARED);
    const light = lightStruct();
    const rows = rowArray();
    const pass: EffectPass = {
        name: "p0", annotations: [], assignments: [
            { state: stateId(EffectStateClass.VertexShader), index: 0, kind: EffectAssignmentKind.Shader, objectIndex: 0 },
        ],
    };
    const data = shaderBytes();
    const instance: EffectInstance = {
        model: { creator: "test", parameters: [tint, light, rows], techniques: [], objects: [{ data, text: "" }] },
        annotations: [], devicePtr: 1, currentTechnique: 0, activePass: 0, poolPtr: POOL,
    };
    const calls: string[] = [];
    const device = {
        createVertexShader: () => ({ hr: 0, handle: 7, bytecode: new Uint32Array(data.buffer) }),
        setVertexShader: (h: number) => { calls.push(`vs ${h}`); },
        setVertexShaderConstantFFromArray: (start: number, values: Float32Array) => { calls.push(`c${start}x${values.length / 4} ${values[0]}`); },
    };
    const deps = { device, mem: new Uint8Array(0), publishObject: () => 1 } as any;
    bindSharedParameters(POOL, instance.model);
    return { tint, light, rows, pass, instance, deps, take: (): string[] => calls.splice(0) };
}

const floats = (block: Uint8Array): number[] => [...new Float32Array(block.buffer, block.byteOffset, block.byteLength / 4)];

afterEach(() => { resetEffectPools(); });

test("a shared parameter written through one effect is committed by another", () => {
    createEffectPool(POOL);
    const a = effect(), b = effect();
    applyPassStates(b.deps, b.instance, b.pass);
    b.take();
    applyPassStates(b.deps, b.instance, b.pass, true);
    expect(b.take()).toEqual([]);
    setVector(a.tint, [0.5, 0, 0, 1]);
    applyPassStates(b.deps, b.instance, b.pass, true);
    expect(b.take()).toEqual(["c5x1 0.5"]);
});

test("a member of a shared struct in a later effect writes the pool's block", () => {
    createEffectPool(POOL);
    const a = effect(), b = effect();
    expect(b.light.value).toBe(a.light.value);
    const before = effectParamStamp(a.light);
    setVector(b.light.members[1]!, [3, 4, 5, 6]);
    expect(floats(a.light.value).slice(4)).toEqual([3, 4, 5, 6]);
    expect(floats(a.light.members[1]!.value)).toEqual([3, 4, 5, 6]);
    expect(effectParamStamp(a.light)).toBeGreaterThan(before);
    setVector(a.light.members[0]!, [7, 0, 0, 0]);
    expect(floats(b.light.members[0]!.value)).toEqual([7, 0, 0, 0]);
});

test("an element of a shared array in a later effect writes the pool's block", () => {
    createEffectPool(POOL);
    const a = effect(), b = effect();
    setVector(b.rows.elementsList![1]!, [9, 8, 7, 6]);
    expect(floats(a.rows.value).slice(4)).toEqual([9, 8, 7, 6]);
    expect(floats(a.rows.elementsList![1]!.value)).toEqual([9, 8, 7, 6]);
});

test("a shared parameter whose block size disagrees keeps its private members", () => {
    createEffectPool(POOL);
    const a = effect();
    const odd = lightStruct();
    const value = new Uint8Array(48);
    odd.value = value;
    odd.members = [vector("Position", value.subarray(0, 16)), vector("Colour", value.subarray(16, 32))];
    bindSharedParameters(POOL, { creator: "test", parameters: [odd], techniques: [], objects: [] });
    setVector(odd.members[1]!, [1, 1, 1, 1]);
    expect(floats(a.light.value)).toEqual(new Array(8).fill(0));
    expect(floats(odd.value).slice(4, 8)).toEqual([1, 1, 1, 1]);
});
