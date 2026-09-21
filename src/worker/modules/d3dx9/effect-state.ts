/**
 * The model an ID3DXEffect answers from, and the handle space the guest addresses it by.
 *
 * D3DXHANDLE is opaque: real d3dx9 hands back pointers into its own structures, and an app
 * only ever passes them back. So a handle here is an ENCODED INDEX — kind in the high bits,
 * index in the low — which makes every handle self-describing and impossible to confuse with
 * another effect's. It must never be 0: `GetParameterByName` returning 0 means "no such
 * parameter", and an app that gets 0 for a parameter it knows exists takes its failure path.
 *
 * A parameter's VALUE lives here rather than in guest memory: the app sets it through
 * SetValue/SetMatrix/SetTexture and the pass application reads it back when it binds shader
 * constants, so the effect is the owner between those two moments.
 */

/** D3DXPARAMETER_CLASS. */
export const enum EffectParamClass {
    Scalar = 0, Vector = 1, MatrixRows = 2, MatrixColumns = 3, Object = 4, Struct = 5,
}

/** D3DXPARAMETER_TYPE — the members a compiled effect can carry. */
export const enum EffectParamType {
    Void = 0, Bool = 1, Int = 2, Float = 3, String = 4,
    Texture = 5, Texture1D = 6, Texture2D = 7, Texture3D = 8, TextureCube = 9,
    Sampler = 10, Sampler1D = 11, Sampler2D = 12, Sampler3D = 13, SamplerCube = 14,
    PixelShader = 15, VertexShader = 16, PixelFragment = 17, VertexFragment = 18,
    Unsupported = 19,
}

export interface EffectAnnotation {
    name: string;
    type: EffectParamType;
    /** Annotations are compile-time constants; a string one is what an app reads by name. */
    stringValue?: string;
    /** The object-table slot a STRING annotation names. The table is read AFTER the
     *  annotations, so the text is only available on a second pass — keep the slot. */
    objectIndex?: number;
    /** An annotation IS a parameter as far as D3DXPARAMETER_DESC is concerned, and an app
     *  reads its NAME back through GetParameterDesc — that is how a SAS engine finds
     *  "SasBindAddress". So the typedef's shape has to survive the parse, not just the value. */
    paramClass?: EffectParamClass;
    rows?: number;
    columns?: number;
    elements?: number;
    value?: Uint8Array;
}

export interface EffectParameter {
    name: string;
    semantic: string;
    /** D3DX_PARAMETER_SHARED / _LITERAL / _ANNOTATION, as the compiled effect recorded them.
     *  An app reads these from D3DXPARAMETER_DESC.Flags to decide WHERE a parameter's storage
     *  lives (a shared one belongs to the effect pool, not the effect), so reporting 0 for a
     *  shared parameter sends it to the wrong store. */
    flags?: number;
    type: EffectParamType;
    paramClass: EffectParamClass;
    rows: number;
    columns: number;
    /** 0 for a non-array parameter, matching D3DXPARAMETER_DESC.Elements. */
    elements: number;
    annotations: EffectAnnotation[];
    /** STRUCT FIELDS, in declaration order — what D3DXPARAMETER_DESC.StructMembers counts
     *  and what the constant packer walks per element. */
    members: EffectParameter[];
    /**
     * ARRAY ELEMENTS, when this parameter is an array with a shape worth addressing.
     *
     * D3DX gives an array of structs BOTH: `StructMembers` fields and `Elements` elements,
     * and GetParameter/GetParameterElement on the array answer with the ELEMENT. Flattening
     * the two (members-as-fields only) leaves `Light[1]` and `Light[2]` unreachable: an
     * engine that enumerates its light array writes all three into element 0's fields and
     * the rest of the block never receives anything.
     */
    elementsList?: EffectParameter[];
    /** Current value bytes (defaults from the blob, then whatever the app sets). */
    value: Uint8Array;
    /** For an object parameter: the guest pointer the app assigned (texture, shader). */
    objectPtr: number;
    /** Index into the effect's object table for an object parameter, else -1. */
    objectIndex: number;
    /**
     * A SAMPLER parameter's inline state block. `sampler2D s = sampler_state { Texture = <t>;
     * MinFilter = LINEAR; }` puts the texture binding HERE, not in the pass — so without it a
     * shader that samples by name gets no texture at all.
     */
    samplerStates?: EffectStateAssignment[];
}

/**
 * How a pass gets the value for one state. The compiler emits three shapes and they are not
 * interchangeable: a literal, a shader whose bytecode sits in the object table, and an
 * expression/parameter reference that is only known once the app has set its parameters.
 */
export const enum EffectAssignmentKind {
    Constant = 0,
    /** The object holds shader bytecode to create and bind. */
    Shader = 1,
    /** The object holds the NAME of a parameter the state reads. */
    ParameterRef = 2,
    /** The object holds an FXLC expression we do not evaluate. */
    Expression = 3,
    /**
     * The object picks one element of a shader ARRAY: a name, then a preshader that computes
     * the index. A pass written `VertexShader = compile vs_2_0 VS_Array[expr];` binds nothing
     * at all unless this is resolved, so it is not an exotic case — it is how a title with
     * shader permutations spells every pass.
     */
    ArraySelector = 4,
}

/** One assignment inside a pass: which state, and the value to give it. */
export interface EffectStateAssignment {
    /** The d3dx state id, as the compiled effect spells it. */
    state: number;
    /** The stage/sampler index the state applies to. */
    index: number;
    kind: EffectAssignmentKind;
    /** Resolved constant, when the assignment is a literal. */
    constant?: number;
    /** The literal's whole value block — a transform assignment needs all 16 floats. */
    data?: Uint8Array;
    /** Object table slot this assignment's value came from. */
    objectIndex: number;
    /** Parameter name, for a ParameterRef or ArraySelector assignment. */
    parameterName?: string;
    /** An ArraySelector's index preshader, the bytes after its name header. */
    selector?: Uint8Array;
    /**
     * The type the state's own inline parameter declares. It is what an evaluated expression
     * has to be converted to: the same computed number is a DWORD for a render state and a
     * float for NPatchMode, and only the typedef says which.
     */
    valueType?: EffectParamType;
}

export interface EffectPass {
    name: string;
    annotations: EffectAnnotation[];
    assignments: EffectStateAssignment[];
}

export interface EffectTechnique {
    name: string;
    annotations: EffectAnnotation[];
    passes: EffectPass[];
}

/** A blob object: shader bytecode, a string, or a parameter name. */
export interface EffectObject {
    /** The payload bytes, copied out of the blob. */
    data: Uint8Array;
    /** Decoded text, when the object is a string or a parameter name. */
    text?: string;
}

export interface EffectModel {
    creator: string;
    parameters: EffectParameter[];
    techniques: EffectTechnique[];
    objects: EffectObject[];
}

// ── handles ──────────────────────────────────────────────────────────────────
// 0 is reserved for "not found", so every kind starts its index at 1.

/**
 * bits 31..24 tag, 23..20 kind, 19..12 the owning technique (for a pass), 11..0 the index.
 * Every stored index is +1 so a handle can never be 0.
 */
const HANDLE_TAG = 0x5d;
const enum HandleKind { Parameter = 1, Technique = 2, Pass = 3, Annotation = 4 }

function encode(kind: HandleKind, index: number, sub = 0): number {
    return (((HANDLE_TAG << 24) | (kind << 20) | ((sub & 0xff) << 12) | ((index + 1) & 0xfff)) >>> 0);
}

export const handleForParameter = (index: number): number => encode(HandleKind.Parameter, index);
export const handleForTechnique = (index: number): number => encode(HandleKind.Technique, index);
export const handleForPass = (technique: number, pass: number): number =>
    encode(HandleKind.Pass, pass, technique + 1);
export const handleForAnnotation = (index: number): number => encode(HandleKind.Annotation, index);
/**
 * A parameter that is a MEMBER (or array element) of a top-level one. GetParameter/
 * GetParameterElement/GetParameterByName all take an hParent, and answering them with a
 * TOP-LEVEL parameter — which is what ignoring hParent does — hands the app a handle whose
 * name, type and value belong to something else entirely. An engine that enumerates a struct
 * of material parameters then binds its data to the wrong identities.
 *
 * `sub` is 8 bits, so a parent index past 254 cannot be addressed; such a member is refused
 * rather than silently aliased onto another parameter.
 */
export const handleForMember = (parent: number, index: number): number =>
    parent > 254 ? 0 : encode(HandleKind.Parameter, index, parent + 1);

export interface DecodedHandle {
    kind: HandleKind;
    index: number;
    /** Owning technique for a pass handle, else -1. */
    sub: number;
}

/** null when the value is not one of ours — an app may pass a stale or foreign handle. */
export function decodeHandle(handle: number): DecodedHandle | null {
    const h = handle >>> 0;
    if ((h >>> 24) !== HANDLE_TAG) return null;
    const index = (h & 0xfff) - 1;
    if (index < 0) return null;
    return { kind: ((h >>> 20) & 0xf) as HandleKind, index, sub: ((h >>> 12) & 0xff) - 1 };
}

export const isParameterHandle = (h: DecodedHandle): boolean => h.kind === HandleKind.Parameter;
export const isTechniqueHandle = (h: DecodedHandle): boolean => h.kind === HandleKind.Technique;
export const isPassHandle = (h: DecodedHandle): boolean => h.kind === HandleKind.Pass;
export const isAnnotationHandle = (h: DecodedHandle): boolean => h.kind === HandleKind.Annotation;

/** Register an annotation so it has a handle, reusing one already handed out. */
export function annotationHandle(inst: EffectInstance, annotation: EffectAnnotation): number {
    const existing = inst.annotations.indexOf(annotation);
    if (existing >= 0) return handleForAnnotation(existing);
    inst.annotations.push(annotation);
    return handleForAnnotation(inst.annotations.length - 1);
}

// ── instances ────────────────────────────────────────────────────────────────

export interface EffectInstance {
    model: EffectModel;
    /**
     * Annotations the app has asked for, in the order it asked. A D3DXHANDLE has to survive
     * the call that produced it, and an annotation lives inside whichever parameter,
     * technique or pass owns it — so handing out an index into this list is what makes one
     * addressable at all.
     */
    annotations: EffectAnnotation[];
    /** The device the effect was created against; passes are applied to it. */
    devicePtr: number;
    /** Index into model.techniques, or -1 before the app picks one. */
    currentTechnique: number;
    /** Set between Begin and End; -1 outside a pass. */
    activePass: number;
    /** The ID3DXEffectPool this effect was created against, or 0 for none. */
    poolPtr?: number;
    /**
     * D3DXCreateEffectEx's pSkipConstants: parameters the app uploads itself with raw
     * SetVertexShaderConstantF, so the effect must never write their registers. Applying
     * ours over the app's own upload replaces a live value with the authored default.
     */
    skipConstants?: ReadonlySet<string>;
}

/**
 * D3DX takes every run of identifier characters in pSkipConstants and treats anything else as
 * a separator (`next_valid_constant_name`), so "A;B;" and "A B" name the same two constants.
 */
export function parseSkipConstantsList(text: string): ReadonlySet<string> | undefined {
    const names = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    return names && names.length ? new Set(names) : undefined;
}

const instances = new Map<number, EffectInstance>();

export function registerEffectInstance(effectPtr: number, instance: EffectInstance): void {
    instances.set(effectPtr >>> 0, instance);
}

/**
 * Why a texture never reached a parameter. Every refusal here is a sampler that will resolve to
 * NULL, and nothing downstream reports one: the draw records, the device binds the fallback
 * texture, and the frame is merely wrong. Reason strings are free-form.
 */
const setTextureOutcomes: Record<string, number> = {};

export function noteSetTextureOutcome(reason: string): void {
    setTextureOutcomes[reason] = (setTextureOutcomes[reason] ?? 0) + 1;
}

export function effectSetTextureOutcomes(): Record<string, number> {
    return { ...setTextureOutcomes };
}

/**
 * Every NAME an app asked an effect to resolve, and whether we had it.
 *
 * An engine binds its material data to shader parameters BY NAME; a lookup we refuse means the
 * app silently never assigns that parameter (a set-texture path that returns failure stores
 * nothing). The refusal is logged, but a log line at WARN in a bring-up run is invisible, and
 * nothing counts them — so a systematic naming mismatch looks exactly like "the engine chose
 * not to set anything".
 */
const nameLookups: Record<string, { found: number; missed: number; missedNames: string[]; missContexts: Record<string, number> }> = {};

export function noteNameLookup(method: string, name: string, found: boolean, context?: string): void {
    const e = nameLookups[method] ?? (nameLookups[method] = { found: 0, missed: 0, missedNames: [], missContexts: {} });
    if (found) e.found++;
    else {
        e.missed++;
        if (e.missedNames.length < 24 && !e.missedNames.includes(name)) e.missedNames.push(name);
        // WHAT was asked matters as much as what was not found: "a pass that really has no
        // such annotation" and "a pass we resolved to nothing" are the same miss otherwise.
        if (context) e.missContexts[context] = (e.missContexts[context] ?? 0) + 1;
    }
}

export function effectNameLookups(): Record<string, { found: number; missed: number; missedNames: string[]; missContexts: Record<string, number> }> {
    return JSON.parse(JSON.stringify(nameLookups));
}

/** Every live effect, for diagnostics. Insertion-ordered, same keys as getEffectInstance. */
export function allEffectInstances(): Array<[number, EffectInstance]> {
    return [...instances.entries()];
}

export function getEffectInstance(effectPtr: number): EffectInstance | undefined {
    return instances.get(effectPtr >>> 0);
}

export function releaseEffectInstance(effectPtr: number): void {
    instances.delete(effectPtr >>> 0);
}

export function resetEffectInstances(): void {
    instances.clear();
}

/**
 * Resolve the name an app passes to GetParameterByName. It is not always a top-level name:
 * d3dx accepts `Struct.Member` and `Array[3]`, and answering 0 for one of those hands the
 * caller a NULL it will call a method on. A member resolves to the top-level parameter that
 * owns it — good enough for lookup, since our value model is per top-level parameter.
 */
export function findParameterIndex(model: EffectModel, name: string): number {
    const wanted = name.toLowerCase();
    for (let i = 0; i < model.parameters.length; i++) {
        if (model.parameters[i]!.name.toLowerCase() === wanted) return i;
    }

    // `A[2].b` → the head is what identifies the owning parameter.
    const head = wanted.split(/[.[]/, 1)[0] ?? "";
    if (head && head !== wanted) {
        for (let i = 0; i < model.parameters.length; i++) {
            if (model.parameters[i]!.name.toLowerCase() === head) return i;
        }
    }

    // A bare member name, with no owner spelled out.
    for (let i = 0; i < model.parameters.length; i++) {
        for (const m of model.parameters[i]!.members) {
            if (m.name.toLowerCase() === wanted) return i;
        }
    }
    return -1;
}

export function findTechniqueIndex(model: EffectModel, name: string): number {
    const wanted = name.toLowerCase();
    for (let i = 0; i < model.techniques.length; i++) {
        if (model.techniques[i]!.name.toLowerCase() === wanted) return i;
    }
    return -1;
}
