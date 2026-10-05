/**
 * Applying one pass of a compiled effect to the device.
 *
 * The assignments are walked IN STORED ORDER — d3dx does no sorting, and a pass that lists
 * `PixelShader` before `ZEnable` means exactly that. Two things depend on the order within one
 * assignment instead: a shader's constants are uploaded only after the shader itself is bound,
 * and lights/material are accumulated into a shadow record that is flushed once at the end of
 * the pass, because an fx sets them one field at a time and each SetLight replaces the whole
 * D3DLIGHT9.
 *
 * An assignment whose right-hand side is COMPUTED — an expression, or the index that selects a
 * shader out of an array — is evaluated through the preshader interpreter. A blob that will not
 * parse leaves its state alone and says so once, rather than binding element 0 and rendering a
 * plausible wrong picture.
 */

import type { D3D9Device } from "../../backends/webgpu/d3d9/d3d9-device";
import { Logger, LogCategory } from "../../core/logger";
import { parseShaderConstantTable, RegisterSet, type CtabTable } from "./ctab";
import { bindConstants, packParameter } from "./effect-constants";
import { effectParamWasWritten } from "./effect-values";
import {
    EffectStateClass,
    EffectShaderConstType,
    effectStateInfo,
    type EffectStateInfo,
} from "./effect-state-table";
import { evaluateIndex, evaluatePreshader, lastPreshaderError, parsePreshader, type Preshader } from "./effect-preshader";
import {
    EffectAssignmentKind,
    EffectParamClass,
    EffectParamType,
    findParameterIndex,
    type EffectInstance,
    type EffectPass,
    type EffectParameter,
    type EffectStateAssignment,
} from "./effect-state";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

/** D3DLIGHT9 / D3DMATERIAL9, the sizes the device's setLight/setMaterial expect. */
const D3DLIGHT9_SIZE = 104;
const D3DMATERIAL9_SIZE = 68;
const MAX_LIGHTS = 8;
/** Vertex-texture sampler units start here, above the 16 pixel ones and D3DDMAPSAMPLER. */
const D3DVERTEXTEXTURESAMPLER0 = 257;

/** Byte offset of each LT_* field inside D3DLIGHT9. */
const LIGHT_FIELD_OFFSET = [0, 4, 20, 36, 52, 64, 76, 80, 84, 88, 92, 96, 100];
/** Bytes each LT_* field spans: colours 16, vectors 12, everything else a dword. */
const LIGHT_FIELD_SIZE = [4, 16, 16, 16, 12, 12, 4, 4, 4, 4, 4, 4, 4];
/** Byte offset of each MT_* field inside D3DMATERIAL9. */
const MATERIAL_FIELD_OFFSET = [0, 16, 32, 48, 64];
const MATERIAL_FIELD_SIZE = [16, 16, 16, 16, 4];

/** A pass's shader object, created once and reused for the life of the effect. */
interface ShaderBinding {
    handle: number;
    table: CtabTable | null;
    /** d3dx does not fail the effect when a shader will not create; it binds NULL. */
    failed: boolean;
    /** The constant→parameter join, resolved once. Both sides are fixed for the life of the
     *  effect, so re-deriving it per draw would be a name search and two arrays per pass. */
    pairs?: ReturnType<typeof bindConstants>;
    /** Constants that COULD have been bound, for the shortfall warning. */
    bindable?: number;
}

export interface EffectApplyDeps {
    device: D3D9Device;
    /**
     * The THUNK's guest view — v86's growth-transparent Proxy, which is why it may be held for
     * the turn. A plain `getCurrentMemory()` view must not be used here: publishing a shader's
     * bytes ALLOCATES, an allocation can grow WASM memory, and the plain view the device is
     * handed afterwards would be the detached one.
     */
    mem: Uint8Array;
    /** Guest-visible copy of object `index`'s bytes, so the device can read the bytecode. */
    publishObject(index: number): number;
}

const shaderCaches = new WeakMap<EffectInstance, Map<number, ShaderBinding>>();

/** Lights and material accumulate across a pass and are flushed once; see the file header. */
interface DeferredState {
    lights: Uint8Array;
    lightsTouched: number;
    material: Uint8Array;
    materialTouched: boolean;
}

const deferredByInstance = new WeakMap<EffectInstance, DeferredState>();

function deferredFor(inst: EffectInstance): DeferredState {
    let state = deferredByInstance.get(inst);
    if (!state) {
        state = {
            lights: new Uint8Array(D3DLIGHT9_SIZE * MAX_LIGHTS),
            lightsTouched: 0,
            material: new Uint8Array(D3DMATERIAL9_SIZE),
            materialTouched: false,
        };
        deferredByInstance.set(inst, state);
    }
    return state;
}

/** BeginPass starts from an all-zero light and material; CommitChanges does not. */
export function resetDeferredState(inst: EffectInstance): void {
    const state = deferredFor(inst);
    state.lights.fill(0);
    state.lightsTouched = 0;
    state.material.fill(0);
    state.materialTouched = false;
}

let warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    Logger.warn(LogCategory.D3D9, `d3dx9 effect: ${message}`);
}

export function resetEffectApplyWarnings(): void {
    warnedOnce = new Set<string>();
}

/** The warnings the apply path has raised, for the harness — they go to a log category that a
 *  bring-up run usually has turned down, and each one names a pass that binds nothing. */
export function effectApplyWarnings(): string[] {
    return [...warnedOnce];
}

function parameterOf(inst: EffectInstance, name: string): EffectParameter | null {
    const index = findParameterIndex(inst.model, name);
    return index >= 0 ? inst.model.parameters[index]! : null;
}

/** An object parameter's "value" is the interface pointer the app set, not a number block. */
const pointerScratch = new Uint8Array(4);
/** One evaluated expression's result, reused: it is consumed before the next assignment. */
const expressionResult = new Float32Array(4);
const expressionScratch = new Uint8Array(16);

/** Parsed once per assignment — a preshader owns its register files, so it is not shareable. */
const preshaders = new WeakMap<EffectStateAssignment, Preshader | null>();

function preshaderFor(a: EffectStateAssignment, bytes: Uint8Array): Preshader | null {
    const cached = preshaders.get(a);
    if (cached !== undefined) return cached;
    const parsed = parsePreshader(bytes);
    preshaders.set(a, parsed);
    return parsed;
}

/**
 * The bytes a parameter currently holds. An OBJECT parameter (texture, shader, string) has no
 * value block — the compiled effect stores an object INDEX there and d3dx resolves it to the
 * live interface, which for a texture arrives through SetTexture — so it answers with the
 * pointer it is currently bound to.
 */
function parameterBytes(param: EffectParameter): Uint8Array | null {
    if (param.value.length) return param.value;
    if (param.paramClass !== EffectParamClass.Object) return null;
    new DataView(pointerScratch.buffer).setUint32(0, param.objectPtr >>> 0, true);
    return pointerScratch;
}

/**
 * The bytes an assignment supplies. A literal carries its own; a parameter reference reads
 * whatever the app has set since. Null means we cannot answer honestly — the state is then
 * left alone rather than given a zero, because a zeroed render state is a silent wrong
 * picture while an unchanged one is merely the previous frame's.
 */
function valueBytes(inst: EffectInstance, a: EffectStateAssignment): Uint8Array | null {
    switch (a.kind) {
        case EffectAssignmentKind.Constant:
            return a.data ?? null;
        case EffectAssignmentKind.ParameterRef: {
            const param = a.parameterName ? parameterOf(inst, a.parameterName) : null;
            if (!param) {
                warnOnce(`param:${a.parameterName}`, `state ${a.state} references unknown parameter "${a.parameterName}"`);
                return null;
            }
            return parameterBytes(param);
        }
        case EffectAssignmentKind.Expression:
            return expressionBytes(inst, a);
        default:
            return null;
    }
}

/**
 * Every object index a shader assignment can resolve to — the one it will pick, plus, for a
 * shader ARRAY, all the permutations it may pick later. Diagnostic-only: `shaderObjectIndex`
 * decides what a draw binds, this says what the effect could bind at all.
 */
export function shaderObjectIndicesOf(inst: EffectInstance, a: EffectStateAssignment): number[] {
    if (a.kind === EffectAssignmentKind.ArraySelector) {
        const param = a.parameterName ? parameterOf(inst, a.parameterName) : null;
        return param?.members.map((m) => m.objectIndex) ?? [];
    }
    const one = shaderObjectIndex(inst, a);
    return one >= 0 ? [one] : [];
}

/**
 * The object a shader assignment binds. A pass may name one directly, or select an element of
 * a shader array by a computed index — which is how a title with shader permutations spells
 * EVERY pass, so a selector we cannot evaluate is a pass that binds nothing.
 */
function shaderObjectIndex(inst: EffectInstance, a: EffectStateAssignment): number {
    // `VertexShader = <SomeShaderParam>;` — the assignment's OWN object holds the referenced
    // parameter's NAME, not bytecode; the bytecode lives in that parameter's object. Wine
    // makes the same hop (effect.c, d3dx_parse_resource `case 1:` → ST_PARAMETER →
    // `refobj = &effect->objects[refpar->object_id]`). Miss it and the pass binds no shader,
    // the draw falls back to the fixed function with an identity transform, and nothing fails.
    if (a.kind === EffectAssignmentKind.ParameterRef) {
        const param = a.parameterName ? parameterOf(inst, a.parameterName) : null;
        if (!param) {
            warnOnce(`shaderRef:${a.parameterName}`, `shader parameter "${a.parameterName}" is not in this effect`);
            return -1;
        }
        if (param.objectIndex < 0) {
            warnOnce(`shaderRefObj:${a.parameterName}`, `shader parameter "${a.parameterName}" carries no object`);
            return -1;
        }
        return param.objectIndex;
    }
    if (a.kind !== EffectAssignmentKind.ArraySelector) return a.objectIndex;
    const param = a.parameterName ? parameterOf(inst, a.parameterName) : null;
    if (!param || !param.members.length) {
        warnOnce(`selector:${a.parameterName}`, `shader array "${a.parameterName}" has no elements`);
        return -1;
    }
    const pres = a.selector ? preshaderFor(a, a.selector) : null;
    if (!pres) {
        warnOnce(`selector:${a.parameterName}`, `index expression for "${a.parameterName}" will not parse`);
        return -1;
    }
    const index = evaluateIndex(pres, inst.model.parameters);
    if (index === null) {
        // "did not compute" and "computed something out of range" are different bugs: the
        // first is ours (an opcode or an input the evaluator does not implement), the second
        // is the effect selecting a permutation it never built. Naming the reason is what
        // keeps them apart.
        warnOnce(
            `selectorEval:${a.parameterName}`,
            `index expression for "${a.parameterName}" did not evaluate (${lastPreshaderError() ?? "no reason"})`,
        );
        return -1;
    }
    if (index >= param.members.length) {
        // d3dx fails the pass rather than substituting an element; a shader from the wrong
        // permutation draws something plausible and wrong, which is harder to notice.
        warnOnce(
            `selectorRange:${a.parameterName}`,
            `index ${index} is outside "${a.parameterName}" (${param.members.length} element(s))`,
        );
        return -1;
    }
    return param.members[index]!.objectIndex;
}

/**
 * An expression assignment: run its preshader and convert the result to the state's declared
 * type. The same number is a DWORD for a render state and a float for NPatchMode.
 */
function expressionBytes(inst: EffectInstance, a: EffectStateAssignment): Uint8Array | null {
    const data = a.objectIndex >= 0 ? inst.model.objects[a.objectIndex]?.data : undefined;
    const pres = data ? preshaderFor(a, data) : null;
    if (!pres) {
        warnOnce(`fxlc:${a.state}`, `expression for state ${a.state} will not parse (${lastPreshaderError() ?? "no reason"})`);
        return null;
    }
    if (!evaluatePreshader(pres, inst.model.parameters, expressionResult)) {
        warnOnce(`fxlcRun:${a.state}`, `expression for state ${a.state} will not run (${lastPreshaderError() ?? "no reason"})`);
        return null;
    }
    const dv = new DataView(expressionScratch.buffer);
    for (let i = 0; i < 4; i++) {
        const v = expressionResult[i]!;
        switch (a.valueType) {
            case EffectParamType.Float: dv.setFloat32(i * 4, v, true); break;
            case EffectParamType.Bool: dv.setInt32(i * 4, v !== 0 ? 1 : 0, true); break;
            default: dv.setInt32(i * 4, Math.trunc(v) | 0, true); break;
        }
    }
    return expressionScratch;
}

/**
 * A sampler parameter carries its own state block, and the unit it applies to comes from the
 * SHADER's CTAB, not from anything the block says. That indirection is how `Texture = <tex>`
 * inside a sampler_state reaches the right stage.
 */
function applySamplerBlock(deps: EffectApplyDeps, inst: EffectInstance, param: EffectParameter, unit: number): void {
    for (const st of param.samplerStates ?? []) {
        const info = effectStateInfo(st.state);
        if (!info) continue;
        const bytes = valueBytes(inst, st);
        if (!bytes) continue;
        if (info.cls === EffectStateClass.Texture) deps.device.setTexture(unit, u32(bytes));
        else if (info.cls === EffectStateClass.SamplerState) deps.device.setSamplerState(unit, info.op, u32(bytes));
    }
}

function u32(bytes: Uint8Array): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) >>> 0;
}

function f32(bytes: Uint8Array): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

function floats(bytes: Uint8Array, count: number): Float32Array | null {
    if (bytes.byteLength < count * 4) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
}

function shaderFor(
    deps: EffectApplyDeps,
    inst: EffectInstance,
    objectIndex: number,
    vertex: boolean,
): ShaderBinding | null {
    let cache = shaderCaches.get(inst);
    if (!cache) {
        cache = new Map();
        shaderCaches.set(inst, cache);
    }
    const cached = cache.get(objectIndex);
    if (cached) return cached;

    const data = inst.model.objects[objectIndex]?.data;
    if (!data || data.length < 8) return null;

    const ptr = deps.publishObject(objectIndex);
    const binding: ShaderBinding = { handle: 0, table: null, failed: true };
    if (ptr) {
        const mem = deps.mem;
        const created = vertex
            ? deps.device.createVertexShader(ptr, mem)
            : deps.device.createPixelShader(ptr, mem);
        if (created.hr === D3D_OK && created.handle) {
            binding.handle = created.handle;
            binding.failed = false;
            binding.table = parseShaderConstantTable(created.bytecode);
        }
    }
    if (binding.failed) {
        // NAME what we handed over, not just that it was refused: the version token plus the
        // leading bytes say which object it actually is (a name string, the other stage's
        // shader, a truncated blob), which is the whole diagnosis.
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const version = dv.getUint32(0, true) >>> 0;
        const head = Array.from(data.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ");
        warnOnce(
            `shader:${objectIndex}`,
            `object ${objectIndex} would not create as a ${vertex ? "vertex" : "pixel"} shader: ` +
            `${data.length} bytes, version 0x${version.toString(16)}, head [${head}], ` +
            `text ${JSON.stringify((inst.model.objects[objectIndex]?.text ?? "").slice(0, 40))}`,
        );
    }
    cache.set(objectIndex, binding);
    return binding;
}

/**
 * Per (stage, constant, register): how often the value we uploaded was ENTIRELY ZERO, and
 * whether the source parameter was zero too.
 *
 * A shader constant fed zeros is the quietest failure an effect engine has: the draw is
 * issued, the pipeline is valid, nothing is refused, and the geometry collapses because its
 * transform is a zero matrix. Splitting "the app never gave us a value" (paramZero) from "we
 * packed one to zero" (uploaded zero from a non-zero parameter) is the whole diagnosis —
 * the first is the app's own state, the second is our bug.
 */
const zeroUploadCensus = new Map<string, { name: string; stage: string; register: number; zero: number; nonZero: number; paramZero: number; paramFlags: number; sameObjectWritten: number }>();

export function effectZeroConstantCensus(): Array<{ name: string; stage: string; register: number; zero: number; nonZero: number; paramZero: number; paramFlags: number; sameObjectWritten: number }> {
    return [...zeroUploadCensus.values()].sort((a, b) => b.zero - a.zero);
}

export function resetEffectZeroConstantCensus(): void {
    zeroUploadCensus.clear();
}

function noteConstantUpload(
    stage: string,
    name: string,
    register: number,
    values: ArrayLike<number>,
    param: EffectParameter,
): void {
    if (zeroUploadCensus.size >= 512) return;
    const key = `${stage}:${name}:${register}`;
    let row = zeroUploadCensus.get(key);
    if (!row) {
        // paramFlags carries D3DX_PARAMETER_SHARED: a shared parameter that reads zero is
        // the effect-pool question, a private one is the app's own state.
        row = { name, stage, register, zero: 0, nonZero: 0, paramZero: 0, paramFlags: param.flags ?? 0, sameObjectWritten: 0 };
        zeroUploadCensus.set(key, row);
    }
    let allZero = true;
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== 0) { allZero = false; break; }
    }
    if (!allZero) { row.nonZero++; return; }
    row.zero++;
    let paramAllZero = true;
    for (let i = 0; i < param.value.byteLength; i++) {
        if (param.value[i] !== 0) { paramAllZero = false; break; }
    }
    if (paramAllZero) row.paramZero++;
    // The decisive split: this exact parameter OBJECT was written and still reads zero
    // (our packing lost it), versus a same-named object elsewhere took the write.
    if (effectParamWasWritten(param)) row.sameObjectWritten++;
}

/**
 * Upload every CTAB constant the shader declares from the parameter of the same name. A
 * constant with no matching parameter is skipped — that is d3dx's own behaviour, and the
 * shortfall is what the census counts.
 */
function uploadShaderConstants(deps: EffectApplyDeps, inst: EffectInstance, binding: ShaderBinding, vertex: boolean): void {
    const table = binding.table;
    if (!table) return;
    const skip = inst.skipConstants;
    if (!binding.pairs) {
        binding.pairs = bindConstants(inst.model.parameters, table, skip);
        binding.bindable = table.constants.filter(
            (c) => c.registerSet !== RegisterSet.Sampler && !skip?.has(c.name),
        ).length;
    }
    const pairs = binding.pairs;
    const bindable = binding.bindable!;
    if (pairs.length < bindable) {
        warnOnce(
            `ctab:${table.creator}:${table.target}`,
            `${bindable - pairs.length} of ${bindable} shader constant(s) have no effect parameter`,
        );
    }
    const device = deps.device;
    for (const { constant, param } of pairs) {
        const upload = packParameter(param, constant);
        if (!upload) {
            warnOnce(`pack:${constant.name}`, `cannot pack parameter "${param.name}" for constant "${constant.name}"`);
            continue;
        }
        if (upload.floats) {
            noteConstantUpload(vertex ? "vs" : "ps", constant.name, upload.registerIndex, upload.floats, param);
            if (vertex) device.setVertexShaderConstantFFromArray(upload.registerIndex, upload.floats, deps.mem);
            else device.setPixelShaderConstantFFromArray(upload.registerIndex, upload.floats, deps.mem);
        } else if (upload.ints) {
            if (vertex) device.setVertexShaderConstantIFromArray(upload.registerIndex, upload.ints);
            else device.setPixelShaderConstantIFromArray(upload.registerIndex, upload.ints);
        } else if (upload.bools) {
            if (vertex) device.setVertexShaderConstantBFromArray(upload.registerIndex, upload.bools);
            else device.setPixelShaderConstantBFromArray(upload.registerIndex, upload.bools);
        }
    }

    // A sampler constant names the unit the shader reads; the texture and filter states for it
    // live in the sampler parameter's own block. A vertex-texture sampler sits above
    // D3DVERTEXTEXTURESAMPLER0.
    for (const constant of table.constants) {
        if (constant.registerSet !== RegisterSet.Sampler) continue;
        const param = parameterOf(inst, constant.name);
        if (!param || !param.samplerStates) {
            warnOnce(`sampler:${constant.name}`, `sampler "${constant.name}" has no state block`);
            continue;
        }
        const base = constant.registerIndex + (vertex ? D3DVERTEXTEXTURESAMPLER0 : 0);
        const count = Math.max(1, Math.min(Math.max(1, constant.type.elements), constant.registerCount || 1));
        for (let i = 0; i < count; i++) {
            const element = param.members[i] ?? param;
            applySamplerBlock(deps, inst, element, base + i);
        }
    }
}

/** The explicit `VertexShaderConstantF[n] = param;` form; see the 148..163 block of the table. */
function applyShaderConst(
    deps: EffectApplyDeps,
    info: EffectStateInfo,
    register: number,
    bytes: Uint8Array,
): void {
    const device = deps.device;
    switch (info.op as EffectShaderConstType) {
        case EffectShaderConstType.VSFloat:
        case EffectShaderConstType.PSFloat: {
            // ceil() to a whole register: a float3 is one register with a zeroed .w, which is
            // what the padded buffer gives us.
            const registers = Math.ceil(bytes.byteLength / 16);
            const data = new Float32Array(registers * 4);
            const source = floats(bytes, Math.min(bytes.byteLength >>> 2, registers * 4));
            if (source) data.set(source);
            if (info.op === EffectShaderConstType.VSFloat) {
                device.setVertexShaderConstantFFromArray(register, data, deps.mem);
            } else {
                device.setPixelShaderConstantFFromArray(register, data, deps.mem);
            }
            break;
        }
        case EffectShaderConstType.VSInt:
        case EffectShaderConstType.PSInt: {
            const registers = Math.ceil(bytes.byteLength / 16);
            const data = new Int32Array(registers * 4);
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < Math.min(bytes.byteLength >>> 2, data.length); i++) {
                data[i] = dv.getInt32(i * 4, true);
            }
            if (info.op === EffectShaderConstType.VSInt) device.setVertexShaderConstantIFromArray(register, data);
            else device.setPixelShaderConstantIFromArray(register, data);
            break;
        }
        case EffectShaderConstType.VSBool:
        case EffectShaderConstType.PSBool: {
            const count = Math.max(1, bytes.byteLength >>> 2);
            const data = new Int32Array(count);
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < count && (i + 1) * 4 <= bytes.byteLength; i++) {
                data[i] = dv.getInt32(i * 4, true) !== 0 ? 1 : 0;
            }
            if (info.op === EffectShaderConstType.VSBool) device.setVertexShaderConstantBFromArray(register, data);
            else device.setPixelShaderConstantBFromArray(register, data);
            break;
        }
    }
}

function applyLight(state: DeferredState, op: number, index: number, bytes: Uint8Array): void {
    if (index >= MAX_LIGHTS) {
        // Wine indexes an 8-element array with no check; an fx with a ninth light would walk
        // off the end of the shadow record.
        warnOnce(`light:${index}`, `light index ${index} is past the 8 the device has`);
        return;
    }
    const offset = LIGHT_FIELD_OFFSET[op];
    const size = LIGHT_FIELD_SIZE[op];
    if (offset === undefined || size === undefined || bytes.byteLength < size) return;
    state.lights.set(bytes.subarray(0, size), index * D3DLIGHT9_SIZE + offset);
    state.lightsTouched |= 1 << index;
}

function applyMaterial(state: DeferredState, op: number, bytes: Uint8Array): void {
    const offset = MATERIAL_FIELD_OFFSET[op];
    const size = MATERIAL_FIELD_SIZE[op];
    if (offset === undefined || size === undefined || bytes.byteLength < size) return;
    state.material.set(bytes.subarray(0, size), offset);
    state.materialTouched = true;
}

/**
 * Apply every assignment of one pass, then flush the deferred light/material record.
 * The loop never aborts early: d3dx records the last failure and keeps going, so one
 * unresolvable state does not cost the pass every state after it.
 */
export function applyPassStates(deps: EffectApplyDeps, inst: EffectInstance, pass: EffectPass): number {
    const device = deps.device;
    const deferred = deferredFor(inst);
    let result = D3D_OK;

    for (const a of pass.assignments) {
        const info = effectStateInfo(a.state);
        if (!info) {
            warnOnce(`state:${a.state}`, `state id ${a.state} is outside the d3dx state table`);
            result = D3DERR_INVALIDCALL;
            continue;
        }

        if (info.cls === EffectStateClass.VertexShader || info.cls === EffectStateClass.PixelShader) {
            const vertex = info.cls === EffectStateClass.VertexShader;
            const objectIndex = shaderObjectIndex(inst, a);
            const binding = objectIndex >= 0 ? shaderFor(deps, inst, objectIndex, vertex) : null;
            const handle = binding && !binding.failed ? binding.handle : 0;
            if (vertex) device.setVertexShader(handle);
            else device.setPixelShader(handle);
            if (binding && !binding.failed) uploadShaderConstants(deps, inst, binding, vertex);
            continue;
        }

        if (info.cls === EffectStateClass.SetSampler) {
            warnOnce("setsampler", "a pass assigns a sampler state block, which the parser does not model");
            continue;
        }

        const bytes = valueBytes(inst, a);
        if (!bytes) {
            result = D3DERR_INVALIDCALL;
            continue;
        }

        switch (info.cls) {
            case EffectStateClass.RenderState:
                device.setRenderState(info.op, u32(bytes));
                break;
            case EffectStateClass.TextureStage:
                device.setTextureStageState(a.index, info.op, u32(bytes));
                break;
            case EffectStateClass.SamplerState:
                device.setSamplerState(a.index, info.op, u32(bytes));
                break;
            case EffectStateClass.Texture:
                device.setTexture(a.index, u32(bytes));
                break;
            case EffectStateClass.Transform: {
                const matrix = floats(bytes, 16);
                if (matrix) device.setTransform(info.op + a.index, matrix);
                break;
            }
            case EffectStateClass.Fvf:
                device.setFVF(u32(bytes));
                break;
            case EffectStateClass.NPatchMode:
                device.setNPatchMode(f32(bytes));
                break;
            case EffectStateClass.LightEnable:
                device.lightEnable(a.index, u32(bytes));
                break;
            case EffectStateClass.Light:
                applyLight(deferred, info.op, a.index, bytes);
                break;
            case EffectStateClass.Material:
                applyMaterial(deferred, info.op, bytes);
                break;
            case EffectStateClass.ShaderConst:
                applyShaderConst(deps, info, a.index, bytes);
                break;
            default:
                warnOnce(`class:${info.cls}`, `state class ${info.cls} (${info.name}) is not applied`);
                break;
        }
    }

    if (deferred.lightsTouched) {
        for (let i = 0; i < MAX_LIGHTS; i++) {
            if (!(deferred.lightsTouched & (1 << i))) continue;
            device.setLight(i, deferred.lights.subarray(i * D3DLIGHT9_SIZE, (i + 1) * D3DLIGHT9_SIZE));
        }
        deferred.lightsTouched = 0;
    }
    if (deferred.materialTouched) {
        device.setMaterial(deferred.material);
        deferred.materialTouched = false;
    }
    return result;
}
