import type { SmInstruction, SmSource } from "./sm-parser";

/** D3D9 comparison suffixes used by ifc_<cmp> and breakc_<cmp>. */
export type CmpOp = "gt" | "eq" | "ge" | "lt" | "ne" | "le";

/** Structured control-flow IR built from the parser's source-order instruction list. */
export type Block =
    | { kind: "instrs"; instrs: SmInstruction[] }
    | { kind: "if"; cond: Cond; then: Block[]; else_: Block[] | null }
    | { kind: "rep"; count: SmSource; body: Block[] }
    | { kind: "loop"; counter: SmSource; body: Block[] }
    | { kind: "break"; cond: Cond | null };

export type Cond =
    | { kind: "bool"; src: SmSource }
    | { kind: "cmp"; op: CmpOp; a: SmSource; b: SmSource }
    | { kind: "pred"; src: SmSource };
