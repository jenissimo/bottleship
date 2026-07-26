/**
 * HarnessService — the worker-side command dispatcher (the REAL harness logic
 * location). The page facade and CLI are dumb transports; all authority
 * lives here next to the state it reads (memory, scheduler, VFS, registry, render).
 *
 * Contract: a `harness_rpc {id,cmd,args,opts}` is dispatched to a registered
 * handler; the handler's return value (a POJO) is posted back as
 * `harness_reply {id,ok,result}`; a thrown value becomes `{id,ok,error}` with a
 * stable code. Per-call timeout + cancel are enforced here, not in handlers.
 *
 * Handlers are registered by the cmds/* modules via commands.ts (no import-time
 * cycles: cmd modules only depend on the HarnessService *type*; the singleton +
 * registration wiring lives in commands.ts).
 */

import {
    HARNESS_REPLY,
    HarnessError,
    HarnessErrorCode,
    toErrorPayload,
    type HarnessRequest,
    type HarnessCallOpts,
    type HarnessReply,
} from "./rpc";
import { harnessBus } from "./event-bus";

/** Context handed to every command handler. */
export interface HarnessCtx {
    /** The request id of the call — also the ambient event runId during dispatch. */
    readonly runId: number;
    /** Aborts when the call times out or is cancelled; handlers may honor it. */
    readonly signal: AbortSignal;
    /** Per-call options as sent by the caller. */
    readonly opts: HarnessCallOpts;
    /** Convenience: emit a harness event correlated to this call. */
    emit(event: string, data: unknown): void;
}

export type HarnessHandler = (args: unknown[], ctx: HarnessCtx) => unknown | Promise<unknown>;

interface InFlight {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
}

export class HarnessService {
    private handlers = new Map<string, HarnessHandler>();
    private inFlight = new Map<number, InFlight>();

    constructor() {
        // A fatal guest crash ends every wait NOW. Without this a script that was
        // parked in tickFrames/waitForEvent sits out its full timeout after the
        // process is already dead, and reports a TIMEOUT instead of the crash.
        harnessBus.onLocal("fault", (data) => {
            const fault = data as { fatal?: boolean; reason?: string } | null;
            if (!fault?.fatal) return; // per-thread faults leave the process running
            this.abortAll(new HarnessError(
                `guest crashed: ${fault.reason ?? "unknown"} — see report()`,
                HarnessErrorCode.CRASHED,
            ));
        });
    }

    /** Abort every in-flight call (crash teardown). */
    private abortAll(err: HarnessError): void {
        for (const f of this.inFlight.values()) f.controller.abort(err);
    }

    /** Register a command handler. Re-registration overwrites (last wins). */
    register(name: string, handler: HarnessHandler): void {
        this.handlers.set(name, handler);
    }

    /** Names of all registered commands (for discovery / `help`). */
    list(): string[] {
        return [...this.handlers.keys()].sort();
    }

    has(name: string): boolean {
        return this.handlers.has(name);
    }

    /** Cancel an in-flight call (page sent harness_cancel). */
    cancel(id: number): void {
        const f = this.inFlight.get(id);
        if (f) f.controller.abort(new HarnessError("cancelled", HarnessErrorCode.CANCELLED));
    }

    /** Dispatch a harness_rpc message, posting the correlated reply. */
    async dispatch(msg: HarnessRequest): Promise<void> {
        const { id, cmd, args, opts } = msg;
        const handler = this.handlers.get(cmd);
        if (!handler) {
            this.reply({ type: HARNESS_REPLY, id, ok: false, error: toErrorPayload(new HarnessError(`unknown command: ${cmd}`, HarnessErrorCode.UNKNOWN_CMD)) });
            return;
        }

        const controller = new AbortController();
        const timeoutMs = opts?.timeoutMs ?? undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (timeoutMs === undefined || timeoutMs > 0) {
            const ms = timeoutMs ?? 60_000;
            timer = setTimeout(() => {
                controller.abort(new HarnessError(`timeout after ${ms}ms`, HarnessErrorCode.TIMEOUT));
            }, ms);
        }
        this.inFlight.set(id, { controller, timer });

        const ctx: HarnessCtx = {
            runId: id,
            signal: controller.signal,
            opts: opts ?? {},
            emit: (event, data) => harnessBus.emit(event, data, id),
        };

        // Ambient runId so synchronous events during the handler correlate.
        const prevRunId = harnessBus.getRunId();
        harnessBus.setRunId(id);
        try {
            const result = await Promise.race([
                Promise.resolve(handler(Array.isArray(args) ? args : [], ctx)),
                this.abortPromise(controller.signal),
            ]);
            this.reply({ type: HARNESS_REPLY, id, ok: true, result });
        } catch (err) {
            this.reply({ type: HARNESS_REPLY, id, ok: false, error: toErrorPayload(err) });
        } finally {
            harnessBus.setRunId(prevRunId);
            const f = this.inFlight.get(id);
            if (f?.timer) clearTimeout(f.timer);
            this.inFlight.delete(id);
        }
    }

    private abortPromise(signal: AbortSignal): Promise<never> {
        return new Promise((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED));
                return;
            }
            signal.addEventListener("abort", () => reject(signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED)), { once: true });
        });
    }

    private reply(msg: HarnessReply): void {
        try {
            (self as unknown as Worker).postMessage(msg);
        } catch (e) {
            // Result wasn't structured-cloneable — replace with an error so the
            // caller's promise still settles instead of hanging forever.
            (self as unknown as Worker).postMessage({
                type: HARNESS_REPLY,
                id: msg.id,
                ok: false,
                error: toErrorPayload(new HarnessError(`result not serializable: ${(e as Error).message}`, HarnessErrorCode.INTERNAL)),
            } satisfies HarnessReply);
        }
    }
}

/** Worker-wide singleton. */
export const harnessService = new HarnessService();
