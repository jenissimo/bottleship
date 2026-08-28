import { Op, RegType, opName } from "../sm-enums";
import type {
    SmInstruction,
    SmProgram,
    SmSource,
    SmStreamItem,
} from "../sm-parser";

/** D3D9 SM3's maximum dynamic subroutine call depth. */
export const MAX_INLINE_DEPTH = 4;

export type InlineCallErrorCode =
    | "invalid-operand"
    | "duplicate-label"
    | "missing-label"
    | "missing-ret"
    | "invalid-label-boundary"
    | "recursive-call"
    | "call-depth-limit"
    | "unexpected-ret";

/** A malformed subroutine stream is a link failure, never an emitter fallback. */
export class InlineCallError extends Error {
    constructor(
        readonly code: InlineCallErrorCode,
        message: string,
        readonly instructionIndex: number,
        readonly opcode: number,
        readonly label?: number,
        readonly callStack: readonly number[] = [],
    ) {
        super(message);
        this.name = "InlineCallError";
    }
}

interface LabelRange {
    readonly label: number;
    readonly labelIndex: number;
    /** First instruction after label. */
    readonly start: number;
    /** The terminal ret is excluded from the body. */
    readonly end: number;
    readonly retIndex: number;
}

interface CallSite {
    readonly instruction: SmInstruction;
    readonly instructionIndex: number;
    readonly target: number;
}

interface InlineContext {
    readonly callDepth: number;
    readonly stack: readonly number[];
    readonly maxDepth: number;
}

function sourceLabel(
    instruction: SmInstruction,
    instructionIndex: number,
    sourceIndex: number,
): number {
    const source = instruction.src[sourceIndex];
    if (
        source === undefined ||
        source.reg.type !== RegType.LABEL ||
        source.reg.relative ||
        !Number.isInteger(source.reg.num) ||
        source.reg.num < 0
    ) {
        throw new InlineCallError(
            "invalid-operand",
            `${opName(instruction.opcode)} source ${sourceIndex} must be an absolute label register`,
            instructionIndex,
            instruction.opcode,
        );
    }
    return source.reg.num;
}

function requireArity(
    instruction: SmInstruction,
    instructionIndex: number,
    arity: number,
): void {
    if (instruction.src.length !== arity) {
        throw new InlineCallError(
            "invalid-operand",
            `${opName(instruction.opcode)} requires ${arity} source operand(s), got ${instruction.src.length}`,
            instructionIndex,
            instruction.opcode,
        );
    }
}

function syntheticFlow(opcode: Op, src: SmSource[] = []): SmInstruction {
    return {
        opcode,
        coissue: false,
        predicated: false,
        specificData: 0,
        dst: null,
        src,
    };
}

function callSite(
    instruction: SmInstruction,
    instructionIndex: number,
): CallSite | null {
    if (instruction.opcode !== Op.CALL && instruction.opcode !== Op.CALLNZ) return null;
    requireArity(instruction, instructionIndex, instruction.opcode === Op.CALL ? 1 : 2);
    return {
        instruction,
        instructionIndex,
        target: sourceLabel(instruction, instructionIndex, 0),
    };
}

function validateCallSites(
    instructions: readonly SmInstruction[],
    start: number,
    end: number,
): CallSite[] {
    const sites: CallSite[] = [];
    for (let index = start; index < end; index++) {
        const site = callSite(instructions[index]!, index);
        if (site) sites.push(site);
    }
    return sites;
}

function validateSimpleArity(instructions: readonly SmInstruction[]): void {
    for (let index = 0; index < instructions.length; index++) {
        const instruction = instructions[index]!;
        if (instruction.opcode === Op.LABEL) {
            requireArity(instruction, index, 1);
            sourceLabel(instruction, index, 0);
        } else if (instruction.opcode === Op.RET) {
            requireArity(instruction, index, 0);
        } else {
            callSite(instruction, index);
        }
    }
}

function collectLabelRanges(instructions: readonly SmInstruction[]): {
    labels: Map<number, LabelRange>;
    entryEnd: number;
    hasSubroutines: boolean;
} {
    const labels = new Map<number, LabelRange>();
    const firstLabel = instructions.findIndex(instruction => instruction.opcode === Op.LABEL);

    if (firstLabel < 0) {
        const firstRet = instructions.findIndex(instruction => instruction.opcode === Op.RET);
        if (firstRet >= 0 && firstRet + 1 < instructions.length) {
            throw new InlineCallError(
                "invalid-label-boundary",
                "instructions after the entry ret are not reachable shader code",
                firstRet + 1,
                instructions[firstRet + 1]!.opcode,
            );
        }
        return { labels, entryEnd: firstRet < 0 ? instructions.length : firstRet, hasSubroutines: false };
    }

    // The assembler places the first label immediately after the entry ret. This
    // also prevents ordinary post-entry instructions from being mistaken for a
    // subroutine body when a label is malformed.
    if (firstLabel === 0 || instructions[firstLabel - 1]?.opcode !== Op.RET) {
        throw new InlineCallError(
            "invalid-label-boundary",
            "label must be immediately preceded by the entry ret",
            firstLabel,
            Op.LABEL,
        );
    }
    const entryRet = firstLabel - 1;
    for (let index = 0; index < entryRet; index++) {
        if (instructions[index]!.opcode === Op.RET) {
            throw new InlineCallError(
                "unexpected-ret",
                "entry ret must be the instruction immediately before the first label",
                index,
                Op.RET,
            );
        }
    }

    let index = firstLabel;
    while (index < instructions.length) {
        const labelInstruction = instructions[index]!;
        if (labelInstruction.opcode !== Op.LABEL) {
            throw new InlineCallError(
                "invalid-label-boundary",
                "instructions after a subroutine ret must start with the next label",
                index,
                labelInstruction.opcode,
            );
        }
        const label = sourceLabel(labelInstruction, index, 0);
        if (labels.has(label)) {
            throw new InlineCallError(
                "duplicate-label",
                `label l${label} is defined more than once`,
                index,
                Op.LABEL,
                label,
            );
        }

        const start = index + 1;
        let retIndex = -1;
        for (let bodyIndex = start; bodyIndex < instructions.length; bodyIndex++) {
            const bodyInstruction = instructions[bodyIndex]!;
            if (bodyInstruction.opcode === Op.LABEL) {
                throw new InlineCallError(
                    "missing-ret",
                    `label l${label} has no ret before the next label`,
                    index,
                    Op.LABEL,
                    label,
                );
            }
            if (bodyInstruction.opcode === Op.RET) {
                retIndex = bodyIndex;
                break;
            }
        }
        if (retIndex < 0) {
            throw new InlineCallError(
                "missing-ret",
                `label l${label} has no terminating ret`,
                index,
                Op.LABEL,
                label,
            );
        }

        labels.set(label, { label, labelIndex: index, start, end: retIndex, retIndex });
        index = retIndex + 1;
        if (index < instructions.length && instructions[index]!.opcode !== Op.LABEL) {
            throw new InlineCallError(
                "invalid-label-boundary",
                "instructions after a subroutine ret must start with the next label",
                index,
                instructions[index]!.opcode,
            );
        }
    }
    return { labels, entryEnd: entryRet, hasSubroutines: true };
}

function validateTargets(
    instructions: readonly SmInstruction[],
    labels: ReadonlyMap<number, LabelRange>,
    entryEnd: number,
): Map<number, CallSite[]> {
    const calls = new Map<number, CallSite[]>();
    const entrySites = validateCallSites(instructions, 0, entryEnd);
    calls.set(-1, entrySites);

    for (const range of labels.values()) {
        const sites = validateCallSites(instructions, range.start, range.end);
        calls.set(range.label, sites);
    }

    for (const sites of calls.values()) {
        for (const site of sites) {
            if (!labels.has(site.target)) {
                throw new InlineCallError(
                    "missing-label",
                    `call target l${site.target} is missing; call is not representable without a valid label`,
                    site.instructionIndex,
                    site.instruction.opcode,
                    site.target,
                );
            }
        }
    }
    return calls;
}

function validateCallGraph(
    labels: ReadonlyMap<number, LabelRange>,
    calls: ReadonlyMap<number, readonly CallSite[]>,
    maxDepth: number,
): void {
    const active = new Set<number>();

    const visit = (label: number, depth: number, stack: readonly number[]): void => {
        if (active.has(label)) {
            throw new InlineCallError(
                "recursive-call",
                `recursive shader subroutine call involving l${label}`,
                labels.get(label)?.labelIndex ?? 0,
                Op.CALL,
                label,
                [...stack, label],
            );
        }
        active.add(label);
        for (const site of calls.get(label) ?? []) {
            const nextDepth = depth + 1;
            if (nextDepth > maxDepth) {
                throw new InlineCallError(
                    "call-depth-limit",
                    `shader subroutine call depth exceeds ${maxDepth}`,
                    site.instructionIndex,
                    site.instruction.opcode,
                    site.target,
                    [...stack, site.target],
                );
            }
            visit(site.target, nextDepth, [...stack, site.target]);
        }
        active.delete(label);
    };

    // Validate the entry-reachable graph with the real call depth, then inspect
    // any otherwise unreachable labels for malformed cycles/deep call chains too.
    visit(-1, 0, []);
    for (const label of labels.keys()) {
        if (!active.has(label)) visit(label, 0, []);
    }
}

function inlineEntry(
    instructions: readonly SmInstruction[],
    labels: ReadonlyMap<number, LabelRange>,
    start: number,
    end: number,
    context: InlineContext,
): SmInstruction[] {
    const result: SmInstruction[] = [];
    for (let index = start; index < end; index++) {
        const instruction = instructions[index]!;
        if (instruction.opcode === Op.CALL || instruction.opcode === Op.CALLNZ) {
            const target = sourceLabel(instruction, index, 0);
            const range = labels.get(target);
            if (!range) {
                // Target validation runs before expansion; retain this guard so
                // callers cannot obtain a silent partial expansion if the pass is
                // changed later.
                throw new InlineCallError(
                    "missing-label",
                    `call target l${target} is missing; call is not representable without a valid label`,
                    index,
                    instruction.opcode,
                    target,
                );
            }
            const nextContext: InlineContext = {
                callDepth: context.callDepth + 1,
                stack: [...context.stack, target],
                maxDepth: context.maxDepth,
            };
            if (nextContext.callDepth > context.maxDepth) {
                throw new InlineCallError(
                    "call-depth-limit",
                    `shader subroutine call depth exceeds ${context.maxDepth}`,
                    index,
                    instruction.opcode,
                    target,
                    nextContext.stack,
                );
            }
            const body = inlineEntry(instructions, labels, range.start, range.end, nextContext);
            if (instruction.opcode === Op.CALLNZ) {
                result.push(syntheticFlow(Op.IF, [instruction.src[1]!]));
                result.push(...body);
                result.push(syntheticFlow(Op.ENDIF));
            } else {
                result.push(...body);
            }
        } else if (instruction.opcode === Op.RET) {
            // A ret is the splice boundary for both the entry stream and a
            // subroutine range. It is never handed to the structured pass.
            break;
        } else if (instruction.opcode !== Op.LABEL) {
            result.push(instruction);
        }
    }
    return result;
}

function rewriteStream(
    original: readonly SmStreamItem[],
    instructions: readonly SmInstruction[],
): SmStreamItem[] {
    const rewritten: SmStreamItem[] = [];
    let inserted = false;
    for (const item of original) {
        if (item.kind === "instruction") {
            if (!inserted) {
                rewritten.push(...instructions.map(instruction => ({ kind: "instruction" as const, instruction })));
                inserted = true;
            }
        } else {
            rewritten.push(item);
        }
    }
    if (!inserted) {
        rewritten.push(...instructions.map(instruction => ({ kind: "instruction" as const, instruction })));
    }
    return rewritten;
}

/**
 * Inline SM3 subroutines before structure/emission.
 *
 * Labels are assembler-time regions: the entry stream ends at its ret, each
 * label body ends at its own ret, and calls splice that body into the caller.
 * `callnz` is represented as an ordinary synthetic if so the existing W3
 * structurer remains the only owner of the Block tree.
 */
export function inlineCalls(
    program: SmProgram,
    options: { maxDepth?: number } = {},
): SmProgram {
    const maxDepth = options.maxDepth ?? MAX_INLINE_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
        throw new RangeError(`inline call depth must be a positive integer, got ${maxDepth}`);
    }

    const instructions = program.instructions;
    validateSimpleArity(instructions);
    const { labels, entryEnd, hasSubroutines } = collectLabelRanges(instructions);
    const calls = validateTargets(instructions, labels, entryEnd);
    validateCallGraph(labels, calls, maxDepth);

    const hasCalls = instructions.some(instruction =>
        instruction.opcode === Op.CALL || instruction.opcode === Op.CALLNZ);
    const hasRet = instructions.some(instruction => instruction.opcode === Op.RET);
    if (!hasSubroutines && !hasCalls && !hasRet) return program;

    const inlined = inlineEntry(instructions, labels, 0, entryEnd, {
        callDepth: 0,
        stack: [],
        maxDepth,
    });
    return {
        ...program,
        instructions: inlined,
        stream: rewriteStream(program.stream, inlined),
    };
}
