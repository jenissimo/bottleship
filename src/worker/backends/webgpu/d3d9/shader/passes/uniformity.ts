import { Census } from "../census";
import type { Block, Cond } from "../ir";
import { RegType, Op } from "../sm-enums";
import type { SmDest, SmInstruction, SmProgram, SmRegister, SmSource } from "../sm-parser";
import { structureProgram } from "./structure";

/** The sample forms understood by the W2 seam. W9 owns explicit-lod opcodes. */
const IMPLICIT_SAMPLE_OPS = new Set<number>([
    Op.TEX,
    Op.TEXBEM,
    Op.TEXBEML,
    Op.TEXREG2AR,
    Op.TEXREG2GB,
    Op.TEXREG2RGB,
    Op.TEXM3x2TEX,
    Op.TEXM3x3TEX,
    Op.TEXM3x3SPEC,
    Op.TEXM3x3VSPEC,
    Op.TEXDP3TEX,
]);

/** WGSL derivative operations are also forbidden in non-uniform control flow. */
const EXPLICIT_DERIVATIVE_OPS = new Set<number>([Op.DSX, Op.DSY, Op.TEXLDD]);

export type SampleMode = "implicit" | "grad" | "level" | "refuse";
export type CoordinateSafety = "stable" | "branch-local" | "unsafe";
export type SampleCensusStatus = "ok" | "approximated" | "unsupported";

/**
 * A small, WGSL-independent affine value tree used only for derivative
 * reconstruction.  The tree deliberately contains no general ALU: a value is
 * eligible only when every varying term is used linearly and every multiplier
 * of a varying term is uniform.  Keeping this representation in the
 * uniformity pass means the emitter can hoist a mathematically equivalent
 * coordinate expression without reading a branch-local temporary before its
 * assignment.
 */
export type AffineExpr =
    | { readonly kind: "source"; readonly source: SmSource }
    | { readonly kind: "add"; readonly left: AffineExpr; readonly right: AffineExpr }
    | { readonly kind: "sub"; readonly left: AffineExpr; readonly right: AffineExpr }
    | { readonly kind: "mul"; readonly left: AffineExpr; readonly right: AffineExpr }
    | { readonly kind: "mad"; readonly left: AffineExpr; readonly right: AffineExpr; readonly add: AffineExpr }
    | { readonly kind: "lerp"; readonly factor: AffineExpr; readonly left: AffineExpr; readonly right: AffineExpr };

interface AffineValue {
    readonly expr: AffineExpr;
    readonly varying: boolean;
}

export interface DerivativePlan {
    /** Stable identifier for the future emitter's derivative temporaries. */
    readonly id: string;
    /** Sample whose final address expression must be differentiated at the anchor. */
    readonly instruction: SmInstruction;
    /** Block path at which the derivatives must be materialised. */
    readonly anchorPath: readonly number[];
    /** Source operands used by the coordinate expression; no WGSL is produced here. */
    readonly coordinateSources: readonly SmSource[];
    /** Reconstructed expression when the sampled coordinate was written in a divergent block. */
    readonly coordinateExpression?: AffineExpr;
}

export interface SamplePlan {
    readonly instruction: SmInstruction;
    readonly path: readonly number[];
    readonly mode: SampleMode;
    readonly divergent: boolean;
    readonly divergentDepth: number;
    readonly coordinateSafety: CoordinateSafety;
    readonly coordinateSources: readonly SmSource[];
    readonly derivative: DerivativePlan | null;
    readonly censusStatus: SampleCensusStatus;
    readonly reason: "uniform-control" | "stable-coordinate" | "branch-local-coordinate" | "unsafe-coordinate";
}

export interface UniformityPlan {
    readonly samples: readonly SamplePlan[];
    readonly derivatives: readonly DerivativePlan[];
    get(instruction: SmInstruction): SamplePlan | undefined;
    sampleFor(instruction: SmInstruction): SamplePlan | undefined;
    /** True when DSX/DSY/TEXLDD was found below dynamic control flow. */
    isDerivativeRefused(instruction: SmInstruction): boolean;
    derivativesAt(path: readonly number[]): readonly DerivativePlan[];
}

export interface UniformityOptions {
    /** Optional shared census. Non-affine branch-local samples are recorded as unsupported. */
    readonly census?: Census;
}

interface ValueFact {
    stability: "stable" | "unsafe";
    uniformity: "uniform" | "varying" | "unknown";
    branchLocal: boolean;
}

type FactState = Map<string, ValueFact>;
type AffineState = Map<string, AffineValue>;
type BlockPath = readonly number[];

const FULL_SWIZZLE = 0xe4;

function registerKey(reg: SmRegister): string {
    return `${reg.type}:${reg.num}`;
}

function sourceForRegister(reg: SmRegister): SmSource {
    return { reg, swizzle: FULL_SWIZZLE, modifier: 0 };
}

function cloneFacts(facts: FactState): FactState {
    return new Map(facts);
}

function replaceFacts(target: FactState, source: FactState): void {
    target.clear();
    for (const [key, fact] of source) target.set(key, fact);
}

function stableUniformFact(): ValueFact {
    return { stability: "stable", uniformity: "uniform", branchLocal: false };
}

function stableVaryingFact(): ValueFact {
    return { stability: "stable", uniformity: "varying", branchLocal: false };
}

function unknownFact(branchLocal = false): ValueFact {
    return { stability: "unsafe", uniformity: "unknown", branchLocal };
}

function initialFact(source: SmSource): ValueFact {
    if (source.reg.relative || source.relReg !== undefined) return unknownFact();

    switch (source.reg.type) {
        case RegType.CONST:
        case RegType.CONSTBOOL:
        case RegType.CONSTINT:
            return stableUniformFact();
        case RegType.INPUT:
        case RegType.TEXTURE:
        case RegType.MISCTYPE:
            // Interpolants and built-ins vary spatially, but their derivatives are available.
            return stableVaryingFact();
        case RegType.SAMPLER:
            return stableUniformFact();
        default:
            return unknownFact();
    }
}

function sourceFact(source: SmSource, facts: FactState): ValueFact {
    if (source.reg.type === RegType.CONSTBOOL) {
        // b# is a uniform-bank read even when it has not appeared in another instruction.
        return stableUniformFact();
    }
    return facts.get(registerKey(source.reg)) ?? initialFact(source);
}

function affineSourceValue(source: SmSource, affine: AffineState): AffineValue | null {
    // Relative addressing can select a different value per lane/iteration. It
    // is not safe to reconstruct outside the divergent block without a full
    // symbolic register-file model, so leave it to the explicit refusal path.
    if (source.reg.relative || source.relReg !== undefined) return null;

    const key = registerKey(source.reg);
    const current = affine.get(key);
    if (current) {
        // The compact tree stores a value expression, not a mutable register
        // view. Applying a non-identity source swizzle/modifier to that tree
        // without a corresponding symbolic node would silently change the
        // derivative, so conservatively leave such reads to the refusal path.
        if (source.swizzle !== FULL_SWIZZLE || source.modifier !== 0) return null;
        return current;
    }

    switch (source.reg.type) {
        case RegType.CONST:
        case RegType.CONSTBOOL:
        case RegType.CONSTINT:
        case RegType.SAMPLER:
            return { expr: { kind: "source", source }, varying: false };
        case RegType.INPUT:
        case RegType.TEXTURE:
        case RegType.MISCTYPE:
            return { expr: { kind: "source", source }, varying: true };
        default:
            return null;
    }
}

function affineAdd(left: AffineValue | null, right: AffineValue | null, kind: "add" | "sub"): AffineValue | null {
    if (!left || !right) return null;
    return {
        expr: { kind, left: left.expr, right: right.expr },
        varying: left.varying || right.varying,
    };
}

function affineMul(left: AffineValue | null, right: AffineValue | null): AffineValue | null {
    if (!left || !right || (left.varying && right.varying)) return null;
    return {
        expr: { kind: "mul", left: left.expr, right: right.expr },
        varying: left.varying || right.varying,
    };
}

function affineValueForInstruction(instruction: SmInstruction, affine: AffineState): AffineValue | null {
    const dst = instruction.dst;
    if (
        !dst ||
        (dst.reg.type !== RegType.TEMP && dst.reg.type !== RegType.TEXTURE) ||
        dst.reg.relative ||
        dst.relReg !== undefined ||
        dst.writeMask !== 0xF ||
        dst.shift !== 0 ||
        dst.saturate ||
        instruction.predicated
    ) return null;

    const source = (index: number): AffineValue | null =>
        affineSourceValue(instruction.src[index]!, affine);
    switch (instruction.opcode) {
        case Op.MOV:
        case Op.TEXCOORD:
            return instruction.src.length === 1 ? source(0) : null;
        case Op.ADD:
            return instruction.src.length === 2 ? affineAdd(source(0), source(1), "add") : null;
        case Op.SUB:
            return instruction.src.length === 2 ? affineAdd(source(0), source(1), "sub") : null;
        case Op.MUL:
            return instruction.src.length === 2 ? affineMul(source(0), source(1)) : null;
        case Op.MAD: {
            if (instruction.src.length !== 3) return null;
            const left = source(0);
            const right = source(1);
            const add = source(2);
            const product = affineMul(left, right);
            if (!left || !right || !product || !add) return null;
            return {
                expr: { kind: "mad", left: left.expr, right: right.expr, add: add.expr },
                varying: product.varying || add.varying,
            };
        }
        case Op.LRP: {
            if (instruction.src.length !== 3) return null;
            const factor = source(0);
            const left = source(1);
            const right = source(2);
            if (!factor || !left || !right || factor.varying) return null;
            return {
                expr: { kind: "lerp", factor: factor.expr, left: left.expr, right: right.expr },
                varying: left.varying || right.varying,
            };
        }
        default:
            return null;
    }
}

function cloneAffine(affine: AffineState): AffineState {
    return new Map(affine);
}

function affineSignature(value: AffineValue | undefined): string {
    if (!value) return "<none>";
    const visit = (expr: AffineExpr): string => {
        switch (expr.kind) {
            case "source": {
                const s = expr.source;
                return `s:${s.reg.type}:${s.reg.num}:${s.swizzle}:${s.modifier}`;
            }
            case "add":
            case "sub":
            case "mul":
                return `${expr.kind}(${visit(expr.left)},${visit(expr.right)})`;
            case "mad":
                return `mad(${visit(expr.left)},${visit(expr.right)},${visit(expr.add)})`;
            case "lerp":
                return `lerp(${visit(expr.factor)},${visit(expr.left)},${visit(expr.right)})`;
        }
    };
    return `${value.varying ? "v" : "u"}:${visit(value.expr)}`;
}

function mergeAffineStates(base: AffineState, ...states: AffineState[]): AffineState {
    const keys = new Set<string>(base.keys());
    for (const state of states) for (const key of state.keys()) keys.add(key);
    const merged = new Map<string, AffineValue>();
    for (const key of keys) {
        // Every incoming state is a clone of `base`, so an ABSENT key means that
        // path invalidated the value. Falling back to base for it would keep a
        // pre-loop expression alive across a back edge that destroyed it.
        const first = base.get(key);
        if (!first) continue;
        const signature = affineSignature(first);
        if (states.every(state => affineSignature(state.get(key)) === signature)) merged.set(key, first);
    }
    return merged;
}

function combineFacts(sourceFacts: readonly ValueFact[]): ValueFact {
    if (sourceFacts.length === 0) return unknownFact();
    const stability = sourceFacts.every(fact => fact.stability === "stable") ? "stable" : "unsafe";
    const uniformity = sourceFacts.every(fact => fact.uniformity === "uniform")
        ? "uniform"
        : sourceFacts.some(fact => fact.uniformity === "varying")
            ? "varying"
            : "unknown";
    return {
        stability,
        uniformity,
        branchLocal: sourceFacts.some(fact => fact.branchLocal),
    };
}

function mergeFact(a: ValueFact | undefined, b: ValueFact | undefined): ValueFact | undefined {
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    return {
        stability: a.stability === "stable" && b.stability === "stable" ? "stable" : "unsafe",
        uniformity: a.uniformity === "uniform" && b.uniformity === "uniform"
            ? "uniform"
            : a.uniformity === "varying" || b.uniformity === "varying"
                ? "varying"
                : "unknown",
        branchLocal: a.branchLocal || b.branchLocal,
    };
}

function mergeStates(base: FactState, ...states: FactState[]): FactState {
    const keys = new Set<string>(base.keys());
    for (const state of states) for (const key of state.keys()) keys.add(key);

    const merged = new Map<string, ValueFact>();
    for (const key of keys) {
        let fact: ValueFact | undefined = base.get(key);
        for (const state of states) fact = mergeFact(fact, state.get(key) ?? base.get(key));
        if (fact) merged.set(key, fact);
    }
    return merged;
}

function coordinateSources(instruction: SmInstruction): SmSource[] {
    if (instruction.opcode === Op.TEX) {
        if (instruction.src[0]) return [instruction.src[0]];
        // ps_1_1–1_3 TEX uses the destination texture register's interpolant.
        if (instruction.dst?.reg.type === RegType.TEXTURE) return [sourceForRegister(instruction.dst.reg)];
        return [];
    }

    if (!instruction.dst) return [];
    const destination = sourceForRegister(instruction.dst.reg);
    switch (instruction.opcode) {
        case Op.TEXDP3TEX:
        case Op.TEXBEM:
        case Op.TEXBEML:
        case Op.TEXM3x2TEX:
        case Op.TEXM3x3TEX:
        case Op.TEXM3x3SPEC:
        case Op.TEXM3x3VSPEC:
            return instruction.src[0] ? [destination, instruction.src[0]] : [destination];
        default:
            return [];
    }
}

function isUniformCondition(cond: Cond, facts: FactState): boolean {
    if (cond.kind === "bool") {
        // This explicit check is intentional: b# is the D3D uniform bank, not a varying predicate.
        return cond.src.reg.type === RegType.CONSTBOOL || sourceFact(cond.src, facts).uniformity === "uniform";
    }
    if (cond.kind === "pred") {
        return sourceFact(cond.src, facts).uniformity === "uniform";
    }
    return sourceFact(cond.a, facts).uniformity === "uniform"
        && sourceFact(cond.b, facts).uniformity === "uniform";
}

function isWriteDestination(dest: SmDest | null): dest is SmDest {
    return dest !== null;
}

function factAfterInstruction(
    instruction: SmInstruction,
    facts: FactState,
    divergentDepth: number,
): ValueFact {
    const sources = isImplicitSample(instruction)
        ? coordinateSources(instruction)
        : instruction.src;
    let fact = combineFacts(sources.map(source => sourceFact(source, facts)));

    if (isImplicitSample(instruction)) {
        // A texture result is spatially varying even when its coordinate is stable.
        fact = {
            ...fact,
            uniformity: "varying",
        };
    }
    if (divergentDepth > 0) {
        fact = { ...fact, stability: "unsafe", branchLocal: true };
    }
    return fact;
}

function classifySample(
    instruction: SmInstruction,
    facts: FactState,
    affine: AffineState,
    divergentAncestors: readonly BlockPath[],
    path: BlockPath,
    sampleIndex: number,
    census: Census | undefined,
): SamplePlan {
    const sources = coordinateSources(instruction);
    const sourceFacts = sources.map(source => sourceFact(source, facts));
    const coordinate = combineFacts(sourceFacts);
    const divergent = divergentAncestors.length > 0;
    const coordinateSafety: CoordinateSafety = coordinate.stability === "stable"
        ? "stable"
        : coordinate.branchLocal
            ? "branch-local"
            : "unsafe";

    let mode: SampleMode = "implicit";
    let derivative: DerivativePlan | null = null;
    let censusStatus: SampleCensusStatus = "ok";
    let reason: SamplePlan["reason"] = "uniform-control";
    const affineCoordinate = sources.length === 1
        ? affineSourceValue(sources[0]!, affine)
        : null;

    if (divergent && coordinateSafety === "stable") {
        mode = "grad";
        reason = "stable-coordinate";
        derivative = {
            id: `sample${sampleIndex}`,
            instruction,
            anchorPath: [...divergentAncestors[0]],
            coordinateSources: sources,
            coordinateExpression: affineCoordinate?.expr,
        };
    } else if (divergent) {
        reason = coordinateSafety === "branch-local" ? "branch-local-coordinate" : "unsafe-coordinate";
        if (affineCoordinate) {
            // Reconstruct the affine coordinate at the uniform anchor and use
            // explicit gradients. LOD 0 is not equivalent to D3D's implicit
            // derivative selection and must never be used as a fallback.
            mode = "grad";
            derivative = {
                id: `sample${sampleIndex}`,
                instruction,
                anchorPath: [...divergentAncestors[0]],
                coordinateSources: sources,
                coordinateExpression: affineCoordinate.expr,
            };
        } else {
            mode = "refuse";
            censusStatus = "unsupported";
        }
    }

    census?.record(instruction.opcode, censusStatus, "tex");
    return {
        instruction,
        path: [...path],
        mode,
        divergent,
        divergentDepth: divergentAncestors.length,
        coordinateSafety,
        coordinateSources: sources,
        derivative,
        censusStatus,
        reason,
    };
}

/**
 * Divergence has two distinct questions and one answer per question.
 *
 * `divergent` asks whether a value written in this block reaches every lane —
 * a loop body qualifies because a register carries across iterations.
 * `nonUniform` asks whether the WGSL uniformity analysis forbids a derivative
 * here — a `rep`/`loop` whose trip count comes from the integer constant bank
 * is uniform control flow and does not.
 */
interface Ancestry {
    readonly divergent: readonly BlockPath[];
    readonly nonUniform: readonly BlockPath[];
}

function walkInstructions(
    instructions: readonly SmInstruction[],
    facts: FactState,
    affine: AffineState,
    ancestors: Ancestry,
    path: BlockPath,
    samples: SamplePlan[],
    derivatives: DerivativePlan[],
    sampleCounter: { value: number },
    census: Census | undefined,
    refusedDerivatives: Set<SmInstruction>,
): void {
    for (let index = 0; index < instructions.length; index++) {
        const instruction = instructions[index];
        if (EXPLICIT_DERIVATIVE_OPS.has(instruction.opcode) && ancestors.nonUniform.length > 0) {
            // Keep this conservative: hoisting an explicit derivative or a
            // texldd gradient would either read a branch-local register before
            // its defining lane executes or change the D3D instruction's
            // derivative semantics. The emitter turns this marker into a link
            // refusal instead of emitting WGSL that the uniformity validator
            // may reject only after a backend-specific compile.
            refusedDerivatives.add(instruction);
            census?.record(instruction.opcode, "unsupported", "tex");
        }
        if (isImplicitSample(instruction)) {
            const sample = classifySample(
                instruction,
                facts,
                affine,
                ancestors.divergent,
                [...path, index],
                sampleCounter.value++,
                census,
            );
            samples.push(sample);
            if (sample.derivative) derivatives.push(sample.derivative);
        }
        if (isWriteDestination(instruction.dst)) {
            facts.set(
                registerKey(instruction.dst.reg),
                factAfterInstruction(instruction, facts, ancestors.divergent.length),
            );
            if (instruction.dst.reg.type === RegType.TEMP || instruction.dst.reg.type === RegType.TEXTURE) {
                const value = affineValueForInstruction(instruction, affine);
                if (value) affine.set(registerKey(instruction.dst.reg), value);
                else affine.delete(registerKey(instruction.dst.reg));
            }
        }
    }
}

function containsBreak(blocks: readonly Block[]): boolean {
    for (const block of blocks) {
        switch (block.kind) {
            case "break": return true;
            case "if":
                if (containsBreak(block.then) || (block.else_ && containsBreak(block.else_))) return true;
                break;
            case "rep":
            case "loop":
                if (containsBreak(block.body)) return true;
                break;
            default:
                break;
        }
    }
    return false;
}

/**
 * `rep i0` / `loop aL, i0` iterate a count taken from the integer constant
 * bank, so every lane executes the same number of iterations and WGSL accepts
 * a derivative inside the body.  A per-lane `break` anywhere below it destroys
 * that property, so the loop is only uniform when its bound is uniform and no
 * lane can leave early.
 */
function isUniformLoop(block: Block & { kind: "rep" | "loop" }, facts: FactState): boolean {
    const bound = block.kind === "rep" ? block.count : block.counter;
    if (bound.reg.type !== RegType.CONSTINT && sourceFact(bound, facts).uniformity !== "uniform") return false;
    return !containsBreak(block.body);
}

function factsSignature(facts: FactState): string {
    return [...facts.entries()]
        .map(([key, fact]) => `${key}=${fact.stability}/${fact.uniformity}/${fact.branchLocal ? 1 : 0}`)
        .sort()
        .join("|");
}

function affineStateSignature(affine: AffineState): string {
    return [...affine.entries()]
        .map(([key, value]) => `${key}=${affineSignature(value)}`)
        .sort()
        .join("|");
}

function collectWrittenRegisters(blocks: readonly Block[], out: Set<string>): void {
    for (const block of blocks) {
        switch (block.kind) {
            case "instrs":
                for (const instruction of block.instrs) {
                    if (instruction.dst) out.add(registerKey(instruction.dst.reg));
                }
                break;
            case "if":
                collectWrittenRegisters(block.then, out);
                if (block.else_) collectWrittenRegisters(block.else_, out);
                break;
            case "rep":
            case "loop":
                collectWrittenRegisters(block.body, out);
                break;
            default:
                break;
        }
    }
}

/** Bounded descent: a longer chain degrades to the conservative seed instead of looping. */
const LOOP_FIXPOINT_ROUNDS = 4;

/**
 * Facts entering a loop body must hold on EVERY iteration, so a single forward
 * walk (which sees only the pre-loop definitions) is not an answer: it reports
 * a register written in the body as stable and lets a hoisted gradient be built
 * from a value only iteration 1 ever held.  Descend to a fixpoint over the back
 * edge, and if the chain is longer than the round budget, fall back to marking
 * everything the body writes as unsafe.
 */
function loopEntryState(
    block: Block & { kind: "rep" | "loop" },
    before: FactState,
    beforeAffine: AffineState,
    ancestors: Ancestry,
    bodyPath: BlockPath,
): { facts: FactState; affine: AffineState } {
    let entryFacts = cloneFacts(before);
    let entryAffine = cloneAffine(beforeAffine);
    for (let round = 0; round < LOOP_FIXPOINT_ROUNDS; round++) {
        const probeFacts = cloneFacts(entryFacts);
        const probeAffine = cloneAffine(entryAffine);
        walkBlocks(block.body, probeFacts, probeAffine, ancestors, bodyPath, [], [], { value: 0 }, undefined, new Set());
        const nextFacts = mergeStates(entryFacts, probeFacts);
        const nextAffine = mergeAffineStates(entryAffine, probeAffine);
        if (
            factsSignature(nextFacts) === factsSignature(entryFacts) &&
            affineStateSignature(nextAffine) === affineStateSignature(entryAffine)
        ) {
            return { facts: entryFacts, affine: entryAffine };
        }
        entryFacts = nextFacts;
        entryAffine = nextAffine;
    }

    const written = new Set<string>();
    collectWrittenRegisters(block.body, written);
    for (const key of written) {
        entryFacts.set(key, unknownFact(true));
        entryAffine.delete(key);
    }
    return { facts: entryFacts, affine: entryAffine };
}

function walkBlocks(
    blocks: readonly Block[],
    facts: FactState,
    affine: AffineState,
    ancestors: Ancestry,
    path: BlockPath,
    samples: SamplePlan[],
    derivatives: DerivativePlan[],
    sampleCounter: { value: number },
    census: Census | undefined,
    refusedDerivatives: Set<SmInstruction>,
): void {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const blockPath = [...path, index];

        switch (block.kind) {
            case "instrs":
                walkInstructions(block.instrs, facts, affine, ancestors, blockPath, samples, derivatives, sampleCounter, census, refusedDerivatives);
                break;
            case "if": {
                const before = cloneFacts(facts);
                const beforeAffine = cloneAffine(affine);
                const divergent = !isUniformCondition(block.cond, before);
                const branchAncestors: Ancestry = divergent
                    ? {
                        divergent: [...ancestors.divergent, blockPath],
                        nonUniform: [...ancestors.nonUniform, blockPath],
                    }
                    : ancestors;
                const thenFacts = cloneFacts(before);
                const thenAffine = cloneAffine(beforeAffine);
                walkBlocks(block.then, thenFacts, thenAffine, branchAncestors, [...blockPath, 0], samples, derivatives, sampleCounter, census, refusedDerivatives);

                const elseFacts = cloneFacts(before);
                const elseAffine = cloneAffine(beforeAffine);
                if (block.else_) {
                    walkBlocks(block.else_, elseFacts, elseAffine, branchAncestors, [...blockPath, 1], samples, derivatives, sampleCounter, census, refusedDerivatives);
                }
                replaceFacts(facts, mergeStates(before, thenFacts, elseFacts));
                const mergedAffine = mergeAffineStates(beforeAffine, thenAffine, elseAffine);
                affine.clear();
                for (const [key, value] of mergedAffine) affine.set(key, value);
                break;
            }
            case "rep":
            case "loop": {
                const before = cloneFacts(facts);
                const beforeAffine = cloneAffine(affine);
                const bodyPath = [...blockPath, 0];
                const bodyAncestors: Ancestry = {
                    divergent: [...ancestors.divergent, blockPath],
                    nonUniform: isUniformLoop(block, before)
                        ? ancestors.nonUniform
                        : [...ancestors.nonUniform, blockPath],
                };
                const entry = loopEntryState(block, before, beforeAffine, bodyAncestors, bodyPath);
                const bodyFacts = cloneFacts(entry.facts);
                const bodyAffine = cloneAffine(entry.affine);
                walkBlocks(block.body, bodyFacts, bodyAffine, bodyAncestors, bodyPath, samples, derivatives, sampleCounter, census, refusedDerivatives);
                replaceFacts(facts, mergeStates(before, bodyFacts));
                const mergedAffine = mergeAffineStates(beforeAffine, bodyAffine);
                affine.clear();
                for (const [key, value] of mergedAffine) affine.set(key, value);
                break;
            }
            case "break":
                break;
        }
    }
}

/** True for texture operations which currently lower through an implicit sample. */
export function isImplicitSample(instruction: SmInstruction): boolean {
    return IMPLICIT_SAMPLE_OPS.has(instruction.opcode);
}

/** Build a source-order uniformity plan for either a structured tree or a flat program. */
export function planUniformity(
    input: SmProgram | readonly Block[],
    options: UniformityOptions = {},
): UniformityPlan {
    const blocks: readonly Block[] = Array.isArray(input)
        ? input as readonly Block[]
        : structureProgram(input as SmProgram);
    const facts: FactState = new Map();
    const affine: AffineState = new Map();
    const samples: SamplePlan[] = [];
    const derivatives: DerivativePlan[] = [];
    const refusedDerivatives = new Set<SmInstruction>();
    const sampleCounter = { value: 0 };
    walkBlocks(blocks, facts, affine, { divergent: [], nonUniform: [] }, [], samples, derivatives, sampleCounter, options.census, refusedDerivatives);

    const byInstruction = new Map<SmInstruction, SamplePlan>();
    for (const sample of samples) byInstruction.set(sample.instruction, sample);

    return {
        samples,
        derivatives,
        get(instruction: SmInstruction): SamplePlan | undefined {
            return byInstruction.get(instruction);
        },
        sampleFor(instruction: SmInstruction): SamplePlan | undefined {
            return byInstruction.get(instruction);
        },
        isDerivativeRefused(instruction: SmInstruction): boolean {
            return refusedDerivatives.has(instruction);
        },
        derivativesAt(path: readonly number[]): readonly DerivativePlan[] {
            return derivatives.filter(derivative => samePath(derivative.anchorPath, path));
        },
    };
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** Alias used by flow consumers that describe the pass as analysis rather than planning. */
export const analyzeUniformity = planUniformity;
