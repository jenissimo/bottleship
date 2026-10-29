/**
 * Harness contract characterization — pins the
 * HarnessService dispatch contract: id-correlated {ok,result|error} replies,
 * typed error codes, per-call timeout + cancel, and event-bus runId correlation.
 *
 * Runs against the real HarnessService + HarnessEventBus with a mocked
 * postMessage — no v86, no DOM, no worker. (Deliberately does NOT import the
 * cmds/* modules, which pull in the whole worker; this isolates the contract.)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

// Own the worker transport for each test; other fixtures may replace self.
const posted: any[] = [];
let previousSelf: PropertyDescriptor | undefined;
let previousPostMessage: PropertyDescriptor | undefined;

import { HarnessService } from "../../src/worker/harness/service";
import { harnessBus } from "../../src/worker/harness/event-bus";
import { HARNESS_RPC, HARNESS_REPLY, HARNESS_EVENT, HarnessError, HarnessErrorCode } from "../../src/worker/harness/rpc";

function makeReq(id: number, cmd: string, args: unknown[] = [], opts?: any) {
    return { type: HARNESS_RPC, id, cmd, args, opts } as any;
}
const replies = () => posted.filter((m) => m.type === HARNESS_REPLY);
const events = () => posted.filter((m) => m.type === HARNESS_EVENT);

describe("HarnessService contract", () => {
    beforeEach(() => {
        posted.length = 0;
        previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
        previousPostMessage = Object.getOwnPropertyDescriptor(globalThis, 'postMessage');
        Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: globalThis });
        Object.defineProperty(globalThis, 'postMessage', { configurable: true, writable: true,
            value: (m: any) => { posted.push(m); } });
    });
    afterEach(() => {
        for (const [name, descriptor] of [['self', previousSelf], ['postMessage', previousPostMessage]] as const) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    test("ok result is id-correlated", async () => {
        const svc = new HarnessService();
        svc.register("echo", (args) => ({ got: args[0] }));
        await svc.dispatch(makeReq(7, "echo", ["hi"]));
        const r = replies();
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ id: 7, ok: true, result: { got: "hi" } });
    });

    test("unknown command -> UNKNOWN_CMD error", async () => {
        const svc = new HarnessService();
        await svc.dispatch(makeReq(1, "nope"));
        expect(replies()[0]).toMatchObject({ id: 1, ok: false });
        expect(replies()[0].error.code).toBe(HarnessErrorCode.UNKNOWN_CMD);
    });

    test("thrown HarnessError propagates its code", async () => {
        const svc = new HarnessService();
        svc.register("boom", () => { throw new HarnessError("no game", HarnessErrorCode.NO_PROCESS); });
        await svc.dispatch(makeReq(2, "boom"));
        expect(replies()[0]).toMatchObject({ id: 2, ok: false });
        expect(replies()[0].error.code).toBe(HarnessErrorCode.NO_PROCESS);
        expect(replies()[0].error.message).toBe("no game");
    });

    test("plain Error becomes INTERNAL", async () => {
        const svc = new HarnessService();
        svc.register("oops", () => { throw new Error("kaboom"); });
        await svc.dispatch(makeReq(3, "oops"));
        expect(replies()[0].error.code).toBe(HarnessErrorCode.INTERNAL);
    });

    test("timeout aborts a hung handler", async () => {
        const svc = new HarnessService();
        svc.register("hang", () => new Promise(() => {}));
        await svc.dispatch(makeReq(4, "hang", [], { timeoutMs: 20 }));
        expect(replies()[0]).toMatchObject({ id: 4, ok: false });
        expect(replies()[0].error.code).toBe(HarnessErrorCode.TIMEOUT);
    });

    test("cancel aborts an in-flight handler", async () => {
        const svc = new HarnessService();
        svc.register("hang", () => new Promise(() => {}));
        const p = svc.dispatch(makeReq(5, "hang", [], { timeoutMs: 5000 }));
        svc.cancel(5);
        await p;
        expect(replies()[0]).toMatchObject({ id: 5, ok: false });
        expect(replies()[0].error.code).toBe(HarnessErrorCode.CANCELLED);
    });

    test("ctx.emit produces a runId-correlated event", async () => {
        const svc = new HarnessService();
        svc.register("arm", (_args, ctx) => { ctx.emit("breakHit", { eip: 0x401000 }); return { armed: true }; });
        await svc.dispatch(makeReq(42, "arm"));
        const e = events();
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ type: HARNESS_EVENT, event: "breakHit", runId: 42 });
        expect((e[0].data as any).eip).toBe(0x401000);
        expect(typeof e[0].serial).toBe("number");
        expect(typeof e[0].ts).toBe("number");
    });

    test("non-serializable result settles as INTERNAL error (no hang)", async () => {
        const svc = new HarnessService();
        // A cyclic object is not structured-cloneable; the real postMessage would
        // throw. Simulate by making postMessage throw once for the result.
        let throwOnce = true;
        const original = (globalThis as any).postMessage;
        (globalThis as any).postMessage = (m: any) => {
            if (throwOnce && m.ok === true) { throwOnce = false; throw new Error("cyclic"); }
            original(m);
        };
        svc.register("cyclic", () => ({ self: {} }));
        await svc.dispatch(makeReq(9, "cyclic"));
        (globalThis as any).postMessage = original;
        const r = replies();
        expect(r[0]).toMatchObject({ id: 9, ok: false });
        expect(r[0].error.code).toBe(HarnessErrorCode.INTERNAL);
    });

    test("event bus recent ring records emissions", () => {
        posted.length = 0;
        harnessBus.emit("frameRendered", { serial: 1 }, 0);
        const recent = harnessBus.recent(8, "frameRendered");
        expect(recent.length).toBeGreaterThan(0);
        expect(recent[recent.length - 1].event).toBe("frameRendered");
    });
});
