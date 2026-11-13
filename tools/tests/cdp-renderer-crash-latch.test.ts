import { expect, test } from "bun:test";
import { CdpSession, RENDERER_CRASH_HINT } from "../cdp-core";

/** A stand-in CDP endpoint: answers only what a test asks it to, and can fire
 *  Inspector.targetCrashed on demand — the one event a dead renderer still sends. */
function fakeCdp(opts: { answer?: (method: string) => unknown | undefined } = {}) {
    let socket: any = null;
    const server = Bun.serve({
        port: 0,
        fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
        websocket: {
            open(ws) { socket = ws; },
            message(ws, raw) {
                const m = JSON.parse(String(raw));
                // Inspector.enable must always succeed or CdpSession.connect would hang.
                if (m.method === "Inspector.enable") return ws.send(JSON.stringify({ id: m.id, result: {} }));
                const r = opts.answer?.(m.method);
                if (r !== undefined) ws.send(JSON.stringify({ id: m.id, result: r }));
            },
        },
    });
    return {
        url: `ws://localhost:${server.port}`,
        crash: () => socket?.send(JSON.stringify({ method: "Inspector.targetCrashed", params: {} })),
        stop: () => server.stop(true),
    };
}

test("a renderer crash fails the in-flight command instead of spending its deadline", async () => {
    const cdp = fakeCdp();
    const session = await CdpSession.connect(cdp.url);
    try {
        // No answer will ever come; without the latch this waits out the full 10 minutes.
        const inflight = session.send("Runtime.evaluate", { expression: "1" }, undefined, { timeoutMs: 600_000 });
        const t0 = Date.now();
        cdp.crash();
        await expect(inflight).rejects.toThrow(/RENDERER PROCESS died/);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(session.crashReason()).toBe(RENDERER_CRASH_HINT);
        await expect(session.send("Runtime.evaluate", {})).rejects.toThrow(/RENDERER PROCESS died/);
    } finally {
        session.close();
        cdp.stop();
    }
});

test("Page.reload still reaches the browser after a crash, and lifts the latch", async () => {
    const cdp = fakeCdp({ answer: (method) => (method === "Page.reload" ? {} : undefined) });
    const session = await CdpSession.connect(cdp.url);
    try {
        cdp.crash();
        await Bun.sleep(50);
        expect(session.crashReason()).toBe(RENDERER_CRASH_HINT);
        await session.send("Page.reload", { ignoreCache: true }, undefined, { timeoutMs: 10_000 });
        expect(session.crashReason()).toBeNull();
    } finally {
        session.close();
        cdp.stop();
    }
});

test("successful evaluations leave no crash waiters or pending commands", async () => {
    const cdp = fakeCdp({ answer: () => ({ result: { value: 1 } }) });
    const session = await CdpSession.connect(cdp.url);
    try {
        for (let i = 0; i < 100; i++) await session.send("Runtime.evaluate", { expression: "1" });
        expect((session as any).pending.size).toBe(0);
        expect((session as any).recoveryIds.size).toBe(0);
        expect((session as any).crashWaiters).toBeUndefined();
    } finally { session.close(); cdp.stop(); }
});

test("closing a session rejects outstanding commands and retires their timers", async () => {
    const cdp = fakeCdp();
    const session = await CdpSession.connect(cdp.url);
    const pending = session.send("Runtime.evaluate", {}, undefined, { timeoutMs: 600_000 });
    session.close();
    await expect(pending).rejects.toThrow("CDP session closed");
    expect((session as any).pending.size).toBe(0);
    cdp.stop();
});
