/**
 * Shared harness types used by the page facade (facade.ts), the fluent DSL
 * (dsl.ts), and the CLI transport (tools/harness.ts + tools/cdp-core.ts).
 *
 * These describe the serialized step list a fluent chain compiles to and the
 * accumulated POJO result a run produces — the "clean POJO, survives CDP
 * returnByValue / MCP evaluate_script" contract.
 */

/** One recorded step in a fluent chain. `args` is JSON-serializable; predicate
 *  functions are pre-stringified into a {__fn:string} marker by the builder. */
export interface HarnessStep {
    cmd: string;
    args: unknown[];
    /** Optional human label for the journal/log. */
    label?: string;
    /** Per-step RPC options (e.g. a longer/unbounded timeout for long waits).
     *  timeoutMs<=0 disables the RPC envelope (the verb's own deadline governs).
     *  `target:'root'` addresses the parent worker instead of a promoted child. */
    opts?: { timeoutMs?: number; target?: "auto" | "root" };
}

/** Marker for a serialized predicate/function argument (e.g. waitUntil). */
export interface SerializedFn {
    __fn: string;
}

export function isSerializedFn(x: unknown): x is SerializedFn {
    return !!x && typeof x === "object" && typeof (x as SerializedFn).__fn === "string";
}

export interface HarnessStepResult {
    cmd: string;
    label?: string;
    ok: boolean;
    result?: unknown;
    error?: { message: string; code?: string };
    /** Wall-clock ms the step took (page-side measure). */
    ms: number;
}

/** The accumulated result of a `.run()` — one POJO regardless of transport. */
export interface HarnessRunResult {
    ok: boolean;
    /** Per-step results in execution order. */
    steps: HarnessStepResult[];
    /** Named accumulator: the last result of each distinct cmd, for quick access
     *  (e.g. result.state, result.textures). */
    named: Record<string, unknown>;
    /** Set when a step threw (e.g. an assertion) — the run aborted here. */
    error?: { message: string; code?: string; atStep: number; cmd: string };
    /** Auto-captured fault-grade snapshot when a step aborted the run. */
    faultSnapshot?: unknown;
}
