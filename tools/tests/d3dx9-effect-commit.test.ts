import { expect, test } from "bun:test";
import { applyPassStates } from "../../src/worker/modules/d3dx9/effect-apply";
import { EFFECT_STATE_TABLE, EffectStateClass } from "../../src/worker/modules/d3dx9/effect-state-table";
import { setMatrix, setObjectParam, setRawBytesAt, setRawValue, setVector } from "../../src/worker/modules/d3dx9/effect-values";
import {
    EffectAssignmentKind, EffectParamClass, EffectParamType, markEffectParamWritten,
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

function numeric(name: string, paramClass: EffectParamClass, rows: number, columns: number): EffectParameter {
    return {
        name, semantic: "", type: EffectParamType.Float, paramClass, rows, columns, elements: 0,
        annotations: [], members: [], value: new Uint8Array(rows * columns * 4), objectPtr: 0, objectIndex: -1,
    };
}

function scene() {
    const tint = numeric("Tint", EffectParamClass.Vector, 1, 4);
    const world = numeric("World", EffectParamClass.MatrixRows, 4, 4);
    const texture: EffectParameter = {
        name: "DiffuseMap", semantic: "", type: EffectParamType.Texture, paramClass: EffectParamClass.Object,
        rows: 0, columns: 0, elements: 0, annotations: [], members: [], value: new Uint8Array(0),
        objectPtr: 0, objectIndex: -1,
    };
    const sampler: EffectParameter = {
        name: "Diffuse", semantic: "", type: EffectParamType.Sampler2D, paramClass: EffectParamClass.Object,
        rows: 0, columns: 0, elements: 0, annotations: [], members: [], value: new Uint8Array(0),
        objectPtr: 0, objectIndex: -1,
        samplerStates: [
            { state: stateId(EffectStateClass.Texture), index: 0, kind: EffectAssignmentKind.ParameterRef, objectIndex: -1, parameterName: "DiffuseMap" },
            { state: stateId(EffectStateClass.SamplerState), index: 0, kind: EffectAssignmentKind.Constant, objectIndex: -1, data: new Uint8Array([2, 0, 0, 0]) },
        ],
    };
    const pass: EffectPass = {
        name: "p0", annotations: [], assignments: [
            { state: stateId(EffectStateClass.RenderState), index: 0, kind: EffectAssignmentKind.Constant, objectIndex: -1, data: new Uint8Array([1, 0, 0, 0]) },
            { state: stateId(EffectStateClass.VertexShader), index: 0, kind: EffectAssignmentKind.Shader, objectIndex: 0 },
        ],
    };
    const data = shaderBytes();
    const instance: EffectInstance = {
        model: { creator: "test", parameters: [tint, world, texture, sampler], techniques: [], objects: [{ data, text: "" }] },
        annotations: [], devicePtr: 1, currentTechnique: 0, activePass: 0,
    };
    const calls: string[] = [];
    const device = {
        createVertexShader: () => ({ hr: 0, handle: 7, bytecode: new Uint32Array(data.buffer) }),
        setVertexShader: (h: number) => { calls.push(`vs ${h}`); },
        setVertexShaderConstantFFromArray: (start: number, values: Float32Array) => { calls.push(`c${start}x${values.length / 4} ${values[0]}`); },
        setRenderState: (op: number, value: number) => { calls.push(`rs ${value}`); },
        setSamplerState: (unit: number, _op: number, value: number) => { calls.push(`ss ${unit} ${value}`); },
        setTexture: (unit: number, ptr: number) => { calls.push(`tex ${unit} ${ptr}`); },
    };
    const deps = { device, mem: new Uint8Array(0), publishObject: () => 1 } as any;
    const take = (): string[] => calls.splice(0);
    return { tint, world, texture, pass, instance, deps, take };
}

const D3DVERTEXTEXTURESAMPLER0 = 257;

test("BeginPass applies every state, constant and sampler of the pass", () => {
    const s = scene();
    setVector(s.tint, [0.25, 0, 0, 1]);
    expect(applyPassStates(s.deps, s.instance, s.pass)).toBe(0);
    expect(s.take()).toEqual([
        "rs 1", "vs 7", "c5x1 0.25", "c8x4 0",
        `tex ${D3DVERTEXTEXTURESAMPLER0} 0`, `ss ${D3DVERTEXTEXTURESAMPLER0} 2`,
    ]);
});

test("CommitChanges with nothing written sends nothing", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();
    expect(applyPassStates(s.deps, s.instance, s.pass, true)).toBe(0);
    expect(s.take()).toEqual([]);
});

test("CommitChanges sends only the parameters written since the pass was applied", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();
    setVector(s.tint, [0.5, 0, 0, 1]);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c5x1 0.5"]);

    const m = new Float32Array(16);
    m[0] = 3;
    setMatrix(s.world, m, false);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c8x4 3"]);

    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual([]);
});

test("CommitChanges sends a numeric parameter written through SetRawValue or SetValue", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();

    // SetRawValue: bytes at an offset inside the block (here the whole vector, then one float).
    expect(setRawBytesAt(s.tint, new Uint8Array(new Float32Array([0.75, 0, 0, 1]).buffer), 0)).toBe(true);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c5x1 0.75"]);
    expect(setRawBytesAt(s.tint, new Uint8Array(new Float32Array([0.125]).buffer), 0)).toBe(true);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c5x1 0.125"]);
    // Past the block: refused, nothing written, nothing sent.
    expect(setRawBytesAt(s.tint, new Uint8Array(4), 16)).toBe(false);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual([]);

    // SetValue: the whole block.
    expect(setRawValue(s.tint, new Uint8Array(new Float32Array([0.5, 0, 0, 1]).buffer))).toBe(true);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c5x1 0.5"]);
});

test("CommitChanges rebinds a sampler's texture when the texture parameter changes", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();
    setObjectParam(s.texture, 0);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual([]);
    s.texture.objectPtr = 0x1234;
    markEffectParamWritten(s.texture);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual([`tex ${D3DVERTEXTEXTURESAMPLER0} ${0x1234}`]);
});

test("a write that repeats the old value is still sent, and a later full apply sends everything again", () => {
    const s = scene();
    setVector(s.tint, [0.5, 0, 0, 1]);
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();
    setVector(s.tint, [0.5, 0, 0, 1]);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c5x1 0.5"]);
    applyPassStates(s.deps, s.instance, s.pass);
    expect(s.take().length).toBe(6);
});

test("a commit on a pass that was never applied applies it in full", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take().length).toBe(6);
});

test("a write through a view of the same value block marks the owning parameter", () => {
    const s = scene();
    applyPassStates(s.deps, s.instance, s.pass);
    s.take();
    const row: EffectParameter = { ...s.world, name: "World[0]", paramClass: EffectParamClass.Vector, rows: 1, columns: 4, value: s.world.value.subarray(0, 16) };
    setVector(row, [9, 0, 0, 0]);
    applyPassStates(s.deps, s.instance, s.pass, true);
    expect(s.take()).toEqual(["c8x4 9"]);
});
