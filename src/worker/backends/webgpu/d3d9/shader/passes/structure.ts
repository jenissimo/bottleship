import { Op, RegType, opName } from "../sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../sm-parser";
import type { Block, CmpOp, Cond } from "../ir";
import { inlineCalls } from "./inline-calls";

export const MAX_DYNAMIC_DEPTH = 24;
export const MAX_LOOP_NESTING = 4;

export type StructureErrorCode =
    | "unbalanced-block"
    | "unclosed-block"
    | "invalid-else"
    | "invalid-break"
    | "unsupported-flow"
    | "invalid-operand"
    | "invalid-comparison"
    | "dynamic-depth-limit"
    | "loop-depth-limit";

export class StructureError extends Error {
    constructor(
        readonly code: StructureErrorCode,
        message: string,
        readonly instructionIndex: number,
        readonly opcode: number,
        readonly blockKind?: Block["kind"],
    ) {
        super(message);
        this.name = "StructureError";
    }
}

interface OpenFrame {
    kind: "if" | "rep" | "loop";
    block: Extract<Block, { kind: "if" | "rep" | "loop" }>;
    parent: Block[];
    instructionIndex: number;
    opcode: number;
    body: Block[];
    inElse: boolean;
}

function fail(
    code: StructureErrorCode,
    message: string,
    instructionIndex: number,
    instruction: SmInstruction,
    blockKind?: Block["kind"],
): never {
    throw new StructureError(code, message, instructionIndex, instruction.opcode, blockKind);
}

function requireSource(
    instruction: SmInstruction,
    index: number,
    instructionIndex: number,
): SmSource {
    const src = instruction.src[index];
    if (src === undefined) {
        fail(
            "invalid-operand",
            `${opName(instruction.opcode)} requires source operand ${index}`,
            instructionIndex,
            instruction,
        );
    }
    return src;
}

function requireArity(
    instruction: SmInstruction,
    arity: number,
    instructionIndex: number,
): void {
    if (instruction.src.length !== arity) {
        fail(
            "invalid-operand",
            `${opName(instruction.opcode)} requires ${arity} source operand(s), got ${instruction.src.length}`,
            instructionIndex,
            instruction,
        );
    }
}

function requireRegister(
    source: SmSource,
    type: RegType,
    instruction: SmInstruction,
    instructionIndex: number,
    role: string,
): SmSource {
    if (source.reg.type !== type) {
        fail(
            "invalid-operand",
            `${opName(instruction.opcode)} ${role} must be ${type === RegType.CONSTINT ? "i#" : "aL"}`,
            instructionIndex,
            instruction,
        );
    }
    return source;
}

function comparison(
    instruction: SmInstruction,
    instructionIndex: number,
): CmpOp {
    // W1 decodes the comparison field once. Do not make the structure pass
    // reinterpret raw specificData: an unknown code must fail at the decode /
    // structure boundary instead of selecting an accidental predicate.
    const op = instruction.comparison;
    if (op === undefined) {
        fail(
            "invalid-comparison",
            `${opName(instruction.opcode)} has invalid comparison code ${instruction.specificData}`,
            instructionIndex,
            instruction,
        );
    }
    return op;
}

function condition(
    instruction: SmInstruction,
    instructionIndex: number,
    comparisonKind: boolean,
): Cond {
    if (!comparisonKind) {
        return { kind: "bool", src: requireSource(instruction, 0, instructionIndex) };
    }
    return {
        kind: "cmp",
        op: comparison(instruction, instructionIndex),
        a: requireSource(instruction, 0, instructionIndex),
        b: requireSource(instruction, 1, instructionIndex),
    };
}

function appendInstruction(body: Block[], instruction: SmInstruction): void {
    const last = body[body.length - 1];
    if (last?.kind === "instrs") {
        last.instrs.push(instruction);
    } else {
        body.push({ kind: "instrs", instrs: [instruction] });
    }
}

function openBlock(
    frame: Omit<OpenFrame, "body" | "inElse">,
    dynamicDepth: number,
    loopDepth: number,
): { frame: OpenFrame; nextBody: Block[] } {
    if (dynamicDepth >= MAX_DYNAMIC_DEPTH) {
        throw new StructureError(
            "dynamic-depth-limit",
            `D3D9 dynamic flow-control depth exceeds ${MAX_DYNAMIC_DEPTH}`,
            frame.instructionIndex,
            frame.opcode,
            frame.block.kind,
        );
    }
    if ((frame.kind === "rep" || frame.kind === "loop") && loopDepth >= MAX_LOOP_NESTING) {
        throw new StructureError(
            "loop-depth-limit",
            `D3D9 static loop nesting exceeds ${MAX_LOOP_NESTING}`,
            frame.instructionIndex,
            frame.opcode,
            frame.block.kind,
        );
    }
    const nextBody = frame.block.kind === "if" ? frame.block.then : frame.block.body;
    return { frame: { ...frame, body: nextBody, inElse: false }, nextBody };
}

function closeBlock(
    stack: OpenFrame[],
    expected: OpenFrame["kind"],
    instruction: SmInstruction,
    instructionIndex: number,
): Block[] {
    const frame = stack[stack.length - 1];
    if (!frame || frame.kind !== expected) {
        fail(
            "unbalanced-block",
            `${opName(instruction.opcode)} does not close the innermost ${frame?.kind ?? "top-level"} block`,
            instructionIndex,
            instruction,
            frame?.block.kind,
        );
    }
    stack.pop();
    return frame.parent;
}

/** Build structured blocks from the parser's flat instruction list. */
export function structureProgram(program: SmProgram): Block[] {
    return structureInstructions(inlineCalls(program).instructions);
}

export function structureInstructions(instructions: SmInstruction[]): Block[] {
    const roots: Block[] = [];
    const stack: OpenFrame[] = [];
    let current = roots;

    for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex++) {
        const instruction = instructions[instructionIndex];
        const loopDepth = stack.reduce((depth, frame) => depth + (frame.kind === "if" ? 0 : 1), 0);

        // aL is a lexical loop local. Both a direct aL operand and the extra
        // relative-addressing token on c[aL+n]/v[aL]/o[aL] must stay inside the
        // loop that owns it; otherwise the emitter's fallback value of zero
        // would turn malformed bytecode into a valid but wrong shader.
        const readsLoopLocal = instruction.src.some(source =>
            source.reg.type === RegType.LOOP || source.relReg?.type === RegType.LOOP,
        ) || instruction.dst?.reg.type === RegType.LOOP || instruction.dst?.relReg?.type === RegType.LOOP;
        if (instruction.opcode !== Op.LOOP && loopDepth === 0 && readsLoopLocal) {
            fail("invalid-operand", "aL is only valid inside a loop", instructionIndex, instruction);
        }

        switch (instruction.opcode) {
            case Op.IF: {
                requireArity(instruction, 1, instructionIndex);
                const block: Block = { kind: "if", cond: condition(instruction, instructionIndex, false), then: [], else_: null };
                const opened = openBlock({
                    kind: "if", block, parent: current, instructionIndex, opcode: instruction.opcode,
                }, stack.length, loopDepth);
                current.push(block);
                stack.push(opened.frame);
                current = opened.nextBody;
                break;
            }
            case Op.IFC: {
                requireArity(instruction, 2, instructionIndex);
                const block: Block = { kind: "if", cond: condition(instruction, instructionIndex, true), then: [], else_: null };
                const opened = openBlock({
                    kind: "if", block, parent: current, instructionIndex, opcode: instruction.opcode,
                }, stack.length, loopDepth);
                current.push(block);
                stack.push(opened.frame);
                current = opened.nextBody;
                break;
            }
            case Op.ELSE: {
                requireArity(instruction, 0, instructionIndex);
                const frame = stack[stack.length - 1];
                if (!frame || frame.kind !== "if" || frame.inElse || frame.block.kind !== "if") {
                    fail("invalid-else", "else must match an if without a previous else", instructionIndex, instruction);
                }
                frame.inElse = true;
                frame.block.else_ = [];
                frame.body = frame.block.else_;
                current = frame.body;
                break;
            }
            case Op.ENDIF:
                requireArity(instruction, 0, instructionIndex);
                current = closeBlock(stack, "if", instruction, instructionIndex);
                break;
            case Op.REP: {
                requireArity(instruction, 1, instructionIndex);
                const count = requireRegister(
                    requireSource(instruction, 0, instructionIndex),
                    RegType.CONSTINT,
                    instruction,
                    instructionIndex,
                    "count",
                );
                const block: Block = {
                    kind: "rep",
                    count,
                    body: [],
                };
                const opened = openBlock({
                    kind: "rep", block, parent: current, instructionIndex, opcode: instruction.opcode,
                }, stack.length, loopDepth);
                current.push(block);
                stack.push(opened.frame);
                current = opened.nextBody;
                break;
            }
            case Op.ENDREP:
                requireArity(instruction, 0, instructionIndex);
                current = closeBlock(stack, "rep", instruction, instructionIndex);
                break;
            case Op.LOOP: {
                requireArity(instruction, 2, instructionIndex);
                requireRegister(
                    requireSource(instruction, 0, instructionIndex),
                    RegType.LOOP,
                    instruction,
                    instructionIndex,
                    "index",
                );
                const counter = requireRegister(
                    requireSource(instruction, 1, instructionIndex),
                    RegType.CONSTINT,
                    instruction,
                    instructionIndex,
                    "counter",
                );
                const block: Block = {
                    kind: "loop",
                    counter,
                    body: [],
                };
                const opened = openBlock({
                    kind: "loop", block, parent: current, instructionIndex, opcode: instruction.opcode,
                }, stack.length, loopDepth);
                current.push(block);
                stack.push(opened.frame);
                current = opened.nextBody;
                break;
            }
            case Op.ENDLOOP:
                requireArity(instruction, 0, instructionIndex);
                current = closeBlock(stack, "loop", instruction, instructionIndex);
                break;
            case Op.BREAK: {
                requireArity(instruction, 0, instructionIndex);
                if (loopDepth === 0) fail("invalid-break", "break must be inside a loop", instructionIndex, instruction);
                current.push({ kind: "break", cond: null });
                break;
            }
            case Op.BREAKC: {
                requireArity(instruction, 2, instructionIndex);
                if (loopDepth === 0) fail("invalid-break", "breakc must be inside a loop", instructionIndex, instruction);
                current.push({ kind: "break", cond: condition(instruction, instructionIndex, true) });
                break;
            }
            case Op.BREAKP: {
                requireArity(instruction, 1, instructionIndex);
                if (loopDepth === 0) fail("invalid-break", "breakp must be inside a loop", instructionIndex, instruction);
                requireRegister(
                    requireSource(instruction, 0, instructionIndex),
                    RegType.PREDICATE,
                    instruction,
                    instructionIndex,
                    "predicate",
                );
                current.push({ kind: "break", cond: { kind: "pred", src: requireSource(instruction, 0, instructionIndex) } });
                break;
            }
            case Op.CALL:
            case Op.CALLNZ:
            case Op.RET:
            case Op.LABEL:
                fail("unsupported-flow", `${opName(instruction.opcode)} is not representable in Block`, instructionIndex, instruction);
                break;
            default:
                appendInstruction(current, instruction);
                break;
        }
    }

    const unclosed = stack[stack.length - 1];
    if (unclosed) {
        throw new StructureError(
            "unclosed-block",
            `Unclosed ${unclosed.kind} block at end of shader`,
            unclosed.instructionIndex,
            unclosed.opcode,
            unclosed.block.kind,
        );
    }
    return roots.length === 0 ? [{ kind: "instrs", instrs: [] }] : roots;
}

export function structure(input: SmProgram | SmInstruction[]): Block[] {
    return Array.isArray(input) ? structureInstructions(input) : structureProgram(input);
}
