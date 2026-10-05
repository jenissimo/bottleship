/**
 * A clean ExitProcess must end a live-guest wait, the way a crash already does.
 *
 * A fatal fault emits `fault{fatal:true}`, which latches the service and aborts every
 * wait at once. A clean exit emits nothing: `tickFrames` kept polling a present serial
 * that would never advance and paid out its full multi-minute timeout, and the CLI's
 * tighter transport deadline fired first — so an agent saw a generic timeout,
 * indistinguishable from the RPC channel having died, at exactly the moment a
 * post-mortem was wanted.
 *
 * The post-mortem verbs (report/stubs/state/logs/fs*) must keep answering: the worker
 * is alive, only the guest is gone. That is the half of the contract that makes the
 * fast-fail a diagnostic rather than a second kind of silence.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { HarnessService } from "../../src/worker/harness/service";
import { HARNESS_RPC, HarnessErrorCode, type HarnessReply } from "../../src/worker/harness/rpc";

/** Capture the replies the service posts (it posts via `self.postMessage`). */
function capture(): HarnessReply[] {
    const replies: HarnessReply[] = [];
    (globalThis as any).self = { postMessage: (m: HarnessReply) => { replies.push(m); } };
    return replies;
}

const call = (svc: HarnessService, id: number, cmd: string, opts?: unknown) =>
    svc.dispatch({ type: HARNESS_RPC, id, cmd, args: [], opts } as any);

describe("a clean guest exit fails live-guest verbs fast", () => {
    let svc: HarnessService;
    let replies: HarnessReply[];
    let exited: boolean;

    beforeEach(() => {
        replies = capture();
        exited = false;
        svc = new HarnessService();
        svc.setGuestExitProbe(() => exited);
    });

    test("while the guest runs, a live-guest verb dispatches normally", async () => {
        svc.register("tickFrames", () => ({ frames: 3 }));
        await call(svc, 1, "tickFrames");
        expect(replies.at(-1)).toMatchObject({ id: 1, ok: true, result: { frames: 3 } });
    });

    test("after the exit, a live-guest verb answers EXITED instead of waiting", async () => {
        svc.register("tickFrames", () => new Promise(() => { /* never settles */ }));
        exited = true;
        await call(svc, 2, "tickFrames");
        const r = replies.at(-1)!;
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe(HarnessErrorCode.EXITED);
        expect(r.error?.message).toContain("ExitProcess");
    });

    test("the post-mortem verbs still answer after the exit", async () => {
        svc.register("report", () => ({ eip: 0x401000 }));
        svc.register("stubs", () => ({ stubs: [] }));
        svc.register("fsIoReport", () => ({ reads: 7 }));
        exited = true;
        await call(svc, 3, "report");
        await call(svc, 4, "stubs");
        await call(svc, 5, "fsIoReport");
        expect(replies.map((r) => r.ok)).toEqual([true, true, true]);
        expect(replies[0].result).toMatchObject({ eip: 0x401000 });
        expect(replies[2].result).toMatchObject({ reads: 7 });
    });

    test("a wait already parked when the guest exits is released", async () => {
        svc.register("tickFrames", (_args, ctx) => new Promise((_res, rej) => {
            ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason), { once: true });
        }));
        const inFlight = call(svc, 6, "tickFrames");
        // The guest exits while the verb is parked — nothing emits, so the service polls.
        exited = true;
        await inFlight;
        const r = replies.at(-1)!;
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe(HarnessErrorCode.EXITED);
    }, 5000);

    test("a probe that throws never breaks dispatch", async () => {
        svc.setGuestExitProbe(() => { throw new Error("no system yet"); });
        svc.register("tickFrames", () => ({ frames: 1 }));
        await call(svc, 7, "tickFrames");
        expect(replies.at(-1)).toMatchObject({ id: 7, ok: true });
    });
});
