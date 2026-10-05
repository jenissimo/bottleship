/** Structured D3D9 flow lowering shared by the vertex and pixel emitters. */

import type { Census } from "../census";
import type { DerivativePlan, UniformityPlan } from "../passes/uniformity";
import type { Block, CmpOp, Cond } from "../ir";
import type { SmInstruction, SmSource } from "../sm-parser";
import type { Emitter } from "../emitter";

export interface FlowLexicalState {
    /** The WGSL name for the innermost loop's aL local, if any. */
    readonly loopLocal: string | null;
}

export interface FlowDerivatives {
    readonly ddx: string;
    readonly ddy: string;
}

export interface FlowInstructionContext {
    readonly lexical: FlowLexicalState;
    readonly path: readonly number[];
    readonly derivatives: ReadonlyMap<SmInstruction, FlowDerivatives>;
}

export interface FlowEmitContext {
    readonly emitter: Emitter;
    readonly census: Census;
    readonly uniformity?: UniformityPlan;

    /** Build a vec4<f32> source expression in the current lexical scope. */
    readonly sourceExpr: (source: SmSource, lexical: FlowLexicalState) => string;
    /** Build a scalar boolean condition for an if/breakp source. */
    readonly booleanExpr: (source: SmSource, lexical: FlowLexicalState) => string;
    /** Build an i32 component from an i# source. */
    readonly integerComponent: (source: SmSource, component: "x" | "y" | "z", lexical: FlowLexicalState) => string;
    /** Emit one ordinary instruction. Flow opcodes never reach this callback. */
    readonly instruction: (instruction: SmInstruction, context: FlowInstructionContext) => void;
    /** Hoist a derivative expression immediately before its dynamic block. */
    readonly derivative?: (plan: DerivativePlan, lexical: FlowLexicalState) => FlowDerivatives;
}

const CMP_OPERATOR: Record<CmpOp, string> = {
    gt: ">",
    eq: "==",
    ge: ">=",
    lt: "<",
    ne: "!=",
    le: "<=",
};

function conditionExpr(condition: Cond, context: FlowEmitContext, lexical: FlowLexicalState): string {
    switch (condition.kind) {
        case "bool":
            return context.booleanExpr(condition.src, lexical);
        case "pred":
            return context.booleanExpr(condition.src, lexical);
        case "cmp": {
            const a = context.sourceExpr(condition.a, lexical);
            const b = context.sourceExpr(condition.b, lexical);
            return `((${a}).x ${CMP_OPERATOR[condition.op]} (${b}).x)`;
        }
    }
}

function derivativePlansAt(
    uniformity: UniformityPlan | undefined,
    path: readonly number[],
): readonly DerivativePlan[] {
    return uniformity?.derivativesAt(path) ?? [];
}

function derivativeInstruction(
    uniformity: UniformityPlan | undefined,
    derivative: DerivativePlan,
): SmInstruction | undefined {
    return uniformity?.samples.find(sample => sample.derivative === derivative)?.instruction;
}

function hoistDerivatives(
    context: FlowEmitContext,
    path: readonly number[],
    lexical: FlowLexicalState,
    derivatives: ReadonlyMap<SmInstruction, FlowDerivatives>,
): ReadonlyMap<SmInstruction, FlowDerivatives> {
    const plans = derivativePlansAt(context.uniformity, path);
    if (plans.length === 0 || context.derivative === undefined) return derivatives;

    const next = new Map(derivatives);
    for (const plan of plans) {
        const instruction = derivativeInstruction(context.uniformity, plan);
        if (!instruction) continue;
        next.set(instruction, context.derivative(plan, lexical));
    }
    return next;
}

function emitBlocks(
    blocks: readonly Block[],
    context: FlowEmitContext,
    lexical: FlowLexicalState,
    path: readonly number[],
    derivatives: ReadonlyMap<SmInstruction, FlowDerivatives>,
): void {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const blockPath = [...path, index];

        switch (block.kind) {
            case "instrs":
                for (let instructionIndex = 0; instructionIndex < block.instrs.length; instructionIndex++) {
                    const instruction = block.instrs[instructionIndex];
                    context.instruction(instruction, {
                        lexical,
                        path: [...blockPath, instructionIndex],
                        derivatives,
                    });
                }
                break;

            case "if": {
                context.census.record(block.cond.kind === "cmp" ? "ifc" : "if", "ok", "flow");
                const blockDerivatives = hoistDerivatives(context, blockPath, lexical, derivatives);
                context.emitter.open(`if (${conditionExpr(block.cond, context, lexical)})`);
                emitBlocks(block.then, context, lexical, [...blockPath, 0], blockDerivatives);
                if (block.else_ !== null) {
                    context.census.record("else", "ok", "flow");
                    context.emitter.close("else");
                    emitBlocks(block.else_, context, lexical, [...blockPath, 1], blockDerivatives);
                }
                context.emitter.close();
                break;
            }

            case "rep": {
                context.census.record("rep", "ok", "flow");
                const blockDerivatives = hoistDerivatives(context, blockPath, lexical, derivatives);
                const count = context.emitter.tmp("repCount");
                const iteration = context.emitter.tmp("repI");
                context.emitter.line(`let ${count} = clamp(${context.integerComponent(block.count, "x", lexical)}, 0, 255);`);
                context.emitter.open(`for (var ${iteration}: i32 = 0; ${iteration} < ${count}; ${iteration} = ${iteration} + 1)`);
                emitBlocks(block.body, context, lexical, [...blockPath, 0], blockDerivatives);
                context.emitter.close();
                break;
            }

            case "loop": {
                context.census.record("loop", "ok", "flow");
                const blockDerivatives = hoistDerivatives(context, blockPath, lexical, derivatives);
                const count = context.emitter.tmp("loopCount");
                const initial = context.emitter.tmp("loopInitial");
                const stride = context.emitter.tmp("loopStride");
                const iteration = context.emitter.tmp("loopI");
                context.emitter.line(`let ${count} = clamp(${context.integerComponent(block.counter, "x", lexical)}, 0, 255);`);
                context.emitter.line(`let ${initial} = ${context.integerComponent(block.counter, "y", lexical)};`);
                context.emitter.line(`let ${stride} = ${context.integerComponent(block.counter, "z", lexical)};`);
                context.emitter.open(`for (var ${iteration}: i32 = 0; ${iteration} < ${count}; ${iteration} = ${iteration} + 1)`);
                // aL is scoped to this loop body. Computing it from the iteration
                // index is equivalent to the SM3 post-body stride update and also
                // keeps nested loops from sharing mutable state.
                context.emitter.line(`var aL: i32 = ${initial} + ${iteration} * ${stride};`);
                emitBlocks(block.body, context, { loopLocal: "aL" }, [...blockPath, 0], blockDerivatives);
                context.emitter.close();
                break;
            }

            case "break":
                context.census.record(
                    block.cond?.kind === "cmp" ? "breakc" : block.cond?.kind === "pred" ? "breakp" : "break",
                    "ok",
                    "flow",
                );
                if (block.cond === null) {
                    context.emitter.line("break;");
                } else {
                    context.emitter.open(`if (${conditionExpr(block.cond, context, lexical)})`);
                    context.emitter.line("break;");
                    context.emitter.close();
                }
                break;
        }
    }
}

/** Lower a validated Block[] tree. The stage callbacks own only stage-specific expressions. */
export function emitFlow(blocks: readonly Block[], context: FlowEmitContext): void {
    emitBlocks(blocks, context, { loopLocal: null }, [], new Map());
}

export const emitBlocksFlow = emitFlow;
