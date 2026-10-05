/**
 * The compiled D3DX9 effect container ("fx_2_0" — tag 0xfeff0901), reduced to the model in
 * effect-state.ts.
 *
 * Shape of the file, and the two things that are easy to get wrong:
 *
 *   dword tag          0xfeff0901
 *   dword offset       where the RECORDS begin, counted from the byte after this field
 *   …                  the DATA area: every `*_offset` below indexes into it, also from that
 *                      same byte — not from the start of the file
 *   at data+offset:    dword params_count, technique_count, shader_count, object_count
 *                      then params_count parameter records, then technique_count techniques
 *
 * So the counts do NOT sit at the front: the front is the data area, and a parser that reads
 * the first dwords as counts gets a plausible-looking 0/4/4/28 and then walks nonsense. The
 * second easy mistake is the name blob — `{ dword size; size bytes }` where size INCLUDES the
 * terminator, so the text is size-1 bytes.
 *
 * Parsing is pure (a byte array in, a model out) so it can be checked against a real title's
 * effect offline, away from the emulator.
 */

import {
    EffectAssignmentKind,
    EffectParamClass,
    EffectParamType,
    type EffectAnnotation,
    type EffectModel,
    type EffectObject,
    type EffectParameter,
    type EffectPass,
    type EffectStateAssignment,
    type EffectTechnique,
} from "./effect-state";

export const EFFECT_TAG = 0xfeff0901;

/** Positions in d3dx's state table; the two a pass binds a shader through. */
export const STATE_VERTEX_SHADER = 146;
export const STATE_PIXEL_SHADER = 147;

/** The tag alone: an app may hand us HLSL source, which we cannot compile. */
export function isCompiledEffect(bytes: Uint8Array): boolean {
    if (bytes.length < 8) return false;
    const tag = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
    return tag === EFFECT_TAG;
}

export class EffectParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EffectParseError";
    }
}

class Reader {
    /** Offset of the byte every stored offset is relative to. */
    readonly base: number;
    private at: number;

    constructor(private readonly view: DataView, base: number, start: number) {
        this.base = base;
        this.at = start;
    }

    get position(): number {
        return this.at;
    }

    u32(): number {
        if (this.at + 4 > this.view.byteLength) throw new EffectParseError(`read past end at ${this.at}`);
        const v = this.view.getUint32(this.at, true);
        this.at += 4;
        return v >>> 0;
    }

    skip(bytes: number): void {
        this.at += bytes;
    }

    /** A reader positioned at `base + offset`, for the indirect records. */
    at_(offset: number): Reader {
        return new Reader(this.view, this.base, this.base + offset);
    }
}

function readName(view: DataView, base: number, offset: number): string {
    if (!offset) return "";
    const at = base + offset;
    if (at + 4 > view.byteLength) return "";
    const size = view.getUint32(at, true) >>> 0;
    if (!size || at + 4 + size > view.byteLength) return "";
    let out = "";
    // size counts the NUL the compiler wrote; the text is everything before it.
    for (let i = 0; i < size - 1; i++) out += String.fromCharCode(view.getUint8(at + 4 + i));
    return out;
}

interface Typedef {
    type: EffectParamType;
    paramClass: EffectParamClass;
    name: string;
    semantic: string;
    elements: number;
    rows: number;
    columns: number;
    memberCount: number;
    members: Typedef[];
}

function readTypedef(view: DataView, base: number, offset: number): Typedef {
    const r = new Reader(view, base, base + offset);
    return readTypedefAt(view, base, r, offset);
}

function readTypedefAt(view: DataView, base: number, r: Reader, offset: number): Typedef {
    const type = r.u32() as EffectParamType;
    const paramClass = r.u32() as EffectParamClass;
    const name = readName(view, base, r.u32());
    const semantic = readName(view, base, r.u32());
    const elements = r.u32();

    let rows = 0;
    let columns = 0;
    let memberCount = 0;
    switch (paramClass) {
        case EffectParamClass.Vector:
            // Vector stores columns FIRST; every other numeric class stores rows first.
            columns = r.u32();
            rows = r.u32();
            break;
        case EffectParamClass.Scalar:
        case EffectParamClass.MatrixRows:
        case EffectParamClass.MatrixColumns:
            rows = r.u32();
            columns = r.u32();
            break;
        case EffectParamClass.Struct:
            memberCount = r.u32();
            break;
        case EffectParamClass.Object:
            break;
        default:
            throw new EffectParseError(`unknown parameter class ${paramClass} at offset ${offset}`);
    }
    // A struct's member typedefs follow the head INLINE, so they are read from the same
    // cursor rather than from an offset of their own.
    const members: Typedef[] = [];
    for (let i = 0; i < memberCount; i++) members.push(readTypedefAt(view, base, r, offset));

    return { type, paramClass, name, semantic, elements, rows, columns, memberCount, members };
}

/**
 * An object-typed parameter's value is an INDEX into the object table, not the data itself;
 * a numeric one stores its bytes inline. Both live at `valueOffset`.
 */
function isSamplerType(type: EffectParamType): boolean {
    return type >= EffectParamType.Sampler && type <= EffectParamType.SamplerCube;
}

/**
 * A parameter owns ONE block covering its whole tree — array elements after one another,
 * struct members in declaration order — which is why a struct's size is the sum of its
 * members' and not zero. An object slot holds a 4-byte id inside that block; a sampler holds
 * an inline state block the value area does not carry, hence 0.
 */
function typedefBytes(def: Typedef): number {
    const elements = Math.max(1, def.elements);
    if (def.paramClass === EffectParamClass.Object) {
        return isSamplerType(def.type) ? 0 : 4 * elements;
    }
    if (def.paramClass === EffectParamClass.Struct) {
        let perElement = 0;
        for (const m of def.members) perElement += typedefBytes(m);
        return perElement * elements;
    }
    return elements * Math.max(1, def.rows) * Math.max(1, def.columns) * 4;
}

function readValue(view: DataView, base: number, valueOffset: number, def: Typedef): {
    value: Uint8Array;
    objectIndex: number;
    objectIndices: number[];
    samplerStates?: EffectStateAssignment[];
} {
    if (def.paramClass === EffectParamClass.Object) {
        // A SAMPLER's value is an inline state block, not an object id — reading its first
        // dword as one would point at an unrelated object and bind a stranger's bytecode.
        if (isSamplerType(def.type)) {
            return {
                value: new Uint8Array(0),
                objectIndex: -1,
                objectIndices: [],
                samplerStates: readSamplerStates(view, base, valueOffset),
            };
        }
        const at = base + valueOffset;
        // An ARRAY of objects stores one id per element. Reading only the first is what makes
        // a shader array look like a single shader, and every permutation past the first
        // unreachable.
        // The element count comes straight out of the file, so it is bounded by the ids that
        // can actually fit — an implausible one must not turn into a four-billion-slot array.
        const room = Math.max(0, Math.floor((view.byteLength - at) / 4));
        const count = Math.min(Math.max(1, def.elements), Math.max(1, room));
        const objectIndices: number[] = [];
        for (let i = 0; i < count; i++) {
            const slot = at + i * 4;
            objectIndices.push(slot + 4 <= view.byteLength ? view.getUint32(slot, true) >>> 0 : 0);
        }
        return { value: new Uint8Array(0), objectIndex: objectIndices[0] ?? 0, objectIndices };
    }
    const bytes = typedefBytes(def);
    const at = base + valueOffset;
    if (!bytes || at + bytes > view.byteLength) {
        return { value: new Uint8Array(0), objectIndex: -1, objectIndices: [] };
    }
    return {
        value: new Uint8Array(view.buffer, view.byteOffset + at, bytes).slice(),
        objectIndex: -1,
        objectIndices: [],
    };
}

/**
 * One state record: `{operation, index, typedefOffset, valueOffset}`. A pass and a sampler
 * block spell a state identically; only the cursor they are read from differs.
 */
function readStateAssignment(view: DataView, base: number, r: Reader): EffectStateAssignment {
    const state = r.u32();
    const index = r.u32();
    const def = readTypedef(view, base, r.u32());
    const { value, objectIndex } = readValue(view, base, r.u32(), def);
    const assignment: EffectStateAssignment = {
        state,
        index,
        kind: EffectAssignmentKind.Constant,
        objectIndex,
        valueType: def.type,
    };
    if (objectIndex < 0 && value.length >= 4) {
        assignment.data = value;
        assignment.constant = new DataView(value.buffer, value.byteOffset).getUint32(0, true);
    }
    return assignment;
}

/** A sampler's value area is `{u32 stateCount; state records}`. */
function readSamplerStates(view: DataView, base: number, valueOffset: number): EffectStateAssignment[] {
    const at = base + valueOffset;
    if (at + 4 > view.byteLength) return [];
    const r = new Reader(view, base, at);
    const count = r.u32();
    if (count > 0x1000) return [];
    const states: EffectStateAssignment[] = [];
    for (let i = 0; i < count; i++) states.push(readStateAssignment(view, base, r));
    return states;
}

function makeParameter(
    def: Typedef,
    value: Uint8Array,
    objectIndex: number,
    objectIndices: number[] = [],
    samplerStates?: EffectStateAssignment[],
): EffectParameter {
    // Members address SLICES of the parent's block, not copies: an app sets `Light.Position`
    // and the pass binds `Light`, so the write has to be visible through the parent.
    const members: EffectParameter[] = [];
    let offset = 0;
    for (const m of def.members) {
        const size = typedefBytes(m);
        const slice = size && offset + size <= value.length
            ? value.subarray(offset, offset + size)
            : new Uint8Array(0);
        const isObject = m.paramClass === EffectParamClass.Object && !isSamplerType(m.type);
        const memberObject = isObject && slice.length >= 4
            ? new DataView(slice.buffer, slice.byteOffset, 4).getUint32(0, true) >>> 0
            : -1;
        members.push(makeParameter(m, isObject ? new Uint8Array(0) : slice, memberObject));
        offset += size;
    }
    // An object array's members ARE its elements — the only place each element's own object id
    // can live, and what an array selector indexes into.
    if (!members.length && objectIndices.length > 1) {
        for (const id of objectIndices) {
            members.push(makeParameter({ ...def, elements: 0, members: [] }, new Uint8Array(0), id));
        }
    }
    // ELEMENTS of an array are addressable in their own right: D3DX answers
    // GetParameter/GetParameterElement on an array with the element, not with a field of the
    // first one. Each element SLICES the parent's block (like a member does), so a write
    // through the element is visible when the pass binds the whole array.
    let elementsList: EffectParameter[] | undefined;
    const elementBytes = def.elements > 0 ? Math.floor(typedefBytes(def) / def.elements) : 0;
    if (def.elements > 0 && elementBytes > 0 && value.length >= def.elements * elementBytes
        && def.paramClass !== EffectParamClass.Object) {
        const elementDef: Typedef = { ...def, elements: 0 };
        elementsList = [];
        for (let e = 0; e < def.elements; e++) {
            const start = e * elementBytes;
            elementsList.push(makeParameter(elementDef, value.subarray(start, start + elementBytes), -1));
        }
    }
    return {
        name: def.name,
        semantic: def.semantic,
        type: def.type,
        paramClass: def.paramClass,
        rows: def.rows,
        columns: def.columns,
        elements: def.elements,
        annotations: [],
        members,
        ...(elementsList ? { elementsList } : {}),
        value,
        objectPtr: 0,
        objectIndex,
        samplerStates,
    };
}

function readAnnotation(view: DataView, base: number, r: Reader, objects: EffectObject[]): EffectAnnotation {
    const def = readTypedef(view, base, r.u32());
    const { value, objectIndex } = readValue(view, base, r.u32(), def);
    const annotation: EffectAnnotation = {
        name: def.name,
        type: def.type,
        paramClass: def.paramClass,
        rows: def.rows,
        columns: def.columns,
        elements: def.elements,
        value,
    };
    if (def.type === EffectParamType.String && objectIndex >= 0) {
        // The object table is read after this, so the text is usually not there yet. Keep the
        // SLOT and resolve on the second pass; taking "" here and discarding it loses the
        // value permanently.
        annotation.objectIndex = objectIndex;
        annotation.stringValue = objects[objectIndex]?.text;
    }
    return annotation;
}

export function parseCompiledEffect(bytes: Uint8Array): EffectModel {
    if (!isCompiledEffect(bytes)) throw new EffectParseError("not a compiled effect (tag mismatch)");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Everything is relative to the byte after the tag and the offset field.
    const base = 8;
    const recordOffset = view.getUint32(4, true) >>> 0;

    const head = new Reader(view, base, base + recordOffset);
    const paramCount = head.u32();
    const techniqueCount = head.u32();
    head.u32(); // shader count — a hint, not a table we need
    const objectCount = head.u32();

    if (paramCount > 0x10000 || techniqueCount > 0x10000 || objectCount > 0x10000) {
        throw new EffectParseError(
            `implausible counts (params=${paramCount} techniques=${techniqueCount} objects=${objectCount})`,
        );
    }

    // Objects are filled in by the second pass over the record stream; reserve them now so a
    // string annotation parsed before its object is seen still resolves.
    const objects: EffectObject[] = Array.from({ length: objectCount }, () => ({ data: new Uint8Array(0) }));

    const parameters: EffectParameter[] = [];
    for (let i = 0; i < paramCount; i++) {
        const typedefOffset = head.u32();
        const valueOffset = head.u32();
        // D3DX_PARAMETER_SHARED/_LITERAL — the app reads these back through
        // D3DXPARAMETER_DESC.Flags; discarding them reported every parameter as non-shared.
        const paramFlags = head.u32();
        const annotationCount = head.u32();

        const def = readTypedef(view, base, typedefOffset);
        const { value, objectIndex, objectIndices, samplerStates } = readValue(view, base, valueOffset, def);
        const param = makeParameter(def, value, objectIndex, objectIndices, samplerStates);
        param.flags = paramFlags;
        for (let a = 0; a < annotationCount; a++) param.annotations.push(readAnnotation(view, base, head, objects));
        parameters.push(param);
    }

    const techniques: EffectTechnique[] = [];
    for (let t = 0; t < techniqueCount; t++) {
        const name = readName(view, base, head.u32());
        const annotationCount = head.u32();
        const passCount = head.u32();

        const technique: EffectTechnique = { name, annotations: [], passes: [] };
        for (let a = 0; a < annotationCount; a++) {
            technique.annotations.push(readAnnotation(view, base, head, objects));
        }

        for (let p = 0; p < passCount; p++) {
            const passName = readName(view, base, head.u32());
            const passAnnotationCount = head.u32();
            const stateCount = head.u32();

            const pass: EffectPass = { name: passName, annotations: [], assignments: [] };
            for (let a = 0; a < passAnnotationCount; a++) {
                pass.annotations.push(readAnnotation(view, base, head, objects));
            }
            for (let s = 0; s < stateCount; s++) {
                pass.assignments.push(readStateAssignment(view, base, head));
            }
            technique.passes.push(pass);
        }
        techniques.push(technique);
    }

    // ── the object payloads ───────────────────────────────────────────────────
    // Two tables follow the techniques: strings (an id plus their bytes) and resources,
    // each of which names the state it belongs to and then carries that state's bytes.
    const copyInto = (slot: number): Uint8Array => {
        const size = head.u32();
        if (!size) return new Uint8Array(0);
        const at = head.position;
        if (at + size > view.byteLength) throw new EffectParseError(`object ${slot} runs past the blob`);
        const data = new Uint8Array(view.buffer, view.byteOffset + at, size).slice();
        head.skip((size + 3) & ~3);
        return data;
    };
    const asText = (data: Uint8Array): string => {
        let out = "";
        for (let i = 0; i < data.length && data[i] !== 0; i++) out += String.fromCharCode(data[i]!);
        return out;
    };

    const stringCount = head.u32();
    const resourceCount = head.u32();

    for (let i = 0; i < stringCount; i++) {
        const id = head.u32();
        const data = copyInto(id);
        if (id < objects.length) objects[id] = { data, text: asText(data) };
    }

    for (let i = 0; i < resourceCount; i++) {
        const techniqueIndex = head.u32();
        const passIndex = head.u32();
        const elementIndex = head.u32(); // only meaningful for a sampler's own state block
        const stateIndex = head.u32();
        const usage = head.u32();

        // technique 0xffffffff addresses a SAMPLER's state block: `index` is the parameter and
        // `element` the array element, not a technique and a pass.
        const samplerOwner = techniqueIndex === 0xffffffff
            ? (elementIndex !== 0xffffffff && parameters[passIndex]?.elements
                ? parameters[passIndex]?.members[elementIndex]
                : parameters[passIndex])
            : undefined;
        const assignment = techniqueIndex === 0xffffffff
            ? samplerOwner?.samplerStates?.[stateIndex] ?? null
            : techniques[techniqueIndex]?.passes[passIndex]?.assignments[stateIndex] ?? null;
        const slot = assignment?.objectIndex ?? -1;
        const data = copyInto(slot);
        if (!assignment || slot < 0 || slot >= objects.length) continue;

        objects[slot] = { data, text: usage === 1 ? asText(data) : undefined };
        if (usage === 1) {
            assignment.kind = EffectAssignmentKind.ParameterRef;
            assignment.parameterName = objects[slot]!.text;
        } else if (usage === 2) {
            // `{u32 nameSize; name; preshader}`: the name is the array parameter, the rest
            // computes the element index.
            const nameSize = data.length >= 4
                ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) >>> 0
                : 0;
            assignment.kind = EffectAssignmentKind.ArraySelector;
            assignment.parameterName = asText(data.subarray(4, 4 + nameSize));
            assignment.selector = data.subarray(4 + nameSize);
        } else if (assignment.state === STATE_VERTEX_SHADER || assignment.state === STATE_PIXEL_SHADER) {
            assignment.kind = EffectAssignmentKind.Shader;
        } else {
            assignment.kind = EffectAssignmentKind.Expression;
        }
    }

    // Annotations that name a string object could not resolve before the table was read.
    const resolveStrings = (annotations: EffectAnnotation[]): void => {
        for (const a of annotations) {
            if (a.type !== EffectParamType.String) continue;
            if (a.stringValue === undefined && a.objectIndex !== undefined) {
                a.stringValue = objects[a.objectIndex]?.text;
            }
            // An empty annotation is a value the app can legitimately read; only an
            // UNRESOLVABLE one is absent.
            if (a.stringValue === undefined && a.objectIndex === undefined) a.stringValue = undefined;
        }
    };
    for (const p of parameters) resolveStrings(p.annotations);
    for (const t of techniques) {
        resolveStrings(t.annotations);
        for (const pass of t.passes) resolveStrings(pass.annotations);
    }

    return { creator: "", parameters, techniques, objects };
}
