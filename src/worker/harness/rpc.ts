/**
 * Harness RPC contract — the typed message envelope shared by the worker-side
 * HarnessService, the page-side facade (src/harness/facade.ts), and the CLI
 * transport (tools/cdp-core.ts).
 *
 * This is the keystone the rest of the harness stands on — contract before
 * sugar. Unlike the legacy `{type:'dbg',cmd,args}` channel — which is
 * fire-and-forget, returns void, and swallows errors into console.warn
 * (dbg-commands.ts handleDbgCommand) — every harness_rpc call carries a request
 * `id`, gets a correlated `{id,ok,result|error}` reply, supports a per-call
 * timeout + cancel, and surfaces typed errors. A result-bearing DSL with
 * chain-aborting assertions cannot sit on the old channel; it sits on this.
 *
 * One message type in, one out, plus one normalized event channel — superseding
 * the ad-hoc per-feature message types (peek_mem, dbg_snapshot, ...). The event
 * envelope carries {event,runId,serial,ts,data} so an event can be
 * correlated back to the RPC that armed it.
 */

/** Page -> worker: invoke a harness command. */
export const HARNESS_RPC = "harness_rpc";
/** Worker -> page: the correlated reply to a harness_rpc. */
export const HARNESS_REPLY = "harness_reply";
/** Page -> worker: cancel an in-flight harness_rpc by id. */
export const HARNESS_CANCEL = "harness_cancel";
/** Worker -> page: a normalized harness event (folds dbg_event + wasm_trap). */
export const HARNESS_EVENT = "harness_event";

/** Default per-call timeout (ms). Long because bring-up waits can be slow; the
 *  caller can override with opts.timeoutMs (0/negative = no timeout). */
export const HARNESS_DEFAULT_TIMEOUT_MS = 60_000;

/** A single command invocation. */
export interface HarnessRequest {
    type: typeof HARNESS_RPC;
    /** Monotonic per-page request id used to correlate the reply + arm events. */
    id: number;
    cmd: string;
    args: unknown[];
    /** Per-call options (timeout/cancel hints). */
    opts?: HarnessCallOpts;
}

export interface HarnessCallOpts {
    /** Override the default timeout. 0 or negative disables the timeout. */
    timeoutMs?: number;
}

export interface HarnessCancel {
    type: typeof HARNESS_CANCEL;
    id: number;
}

/** Typed error payload — POJO so it survives CDP returnByValue / postMessage. */
export interface HarnessErrorPayload {
    message: string;
    /** Stable machine code (e.g. UNKNOWN_CMD, TIMEOUT, CANCELLED, NO_PROCESS). */
    code: string;
    stack?: string;
}

export interface HarnessReply {
    type: typeof HARNESS_REPLY;
    id: number;
    ok: boolean;
    result?: unknown;
    error?: HarnessErrorPayload;
}

/** Normalized event envelope. `runId` ties the event to the arming
 *  call's request id when one applies (e.g. the breakOn that produced breakHit). */
export interface HarnessEventMsg {
    type: typeof HARNESS_EVENT;
    event: string;
    runId: number | null;
    serial: number;
    ts: number;
    data: unknown;
}

/** Stable error codes used across the harness. */
export const HarnessErrorCode = {
    UNKNOWN_CMD: "UNKNOWN_CMD",
    BAD_ARGS: "BAD_ARGS",
    TIMEOUT: "TIMEOUT",
    CANCELLED: "CANCELLED",
    NO_PROCESS: "NO_PROCESS",
    NO_MODULE: "NO_MODULE",
    NOT_FOUND: "NOT_FOUND",
    UNSUPPORTED: "UNSUPPORTED",
    /** The guest process died while the command was waiting — no point waiting out the timeout. */
    CRASHED: "CRASHED",
    /** An expect* verb looked, and what it found violated the invariant it asserts. */
    ASSERT_FAILED: "ASSERT_FAILED",
    INTERNAL: "INTERNAL",
} as const;
export type HarnessErrorCodeName = (typeof HarnessErrorCode)[keyof typeof HarnessErrorCode];

/** Thrown by command handlers to carry a stable code into the reply envelope. */
export class HarnessError extends Error {
    code: string;
    constructor(message: string, code: string = HarnessErrorCode.INTERNAL) {
        super(message);
        this.name = "HarnessError";
        this.code = code;
    }
}

/** Serialize any thrown value into a POJO error payload. */
export function toErrorPayload(err: unknown): HarnessErrorPayload {
    if (err instanceof HarnessError) {
        return { message: err.message, code: err.code, stack: err.stack };
    }
    if (err instanceof Error) {
        return { message: err.message, code: HarnessErrorCode.INTERNAL, stack: err.stack };
    }
    return { message: String(err), code: HarnessErrorCode.INTERNAL };
}
