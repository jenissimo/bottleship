/**
 * The page-side broker must never leave the harness addressing a realm that is gone,
 * and must always be able to address the parent.
 *
 * `SessionWorker` routes every message to `foreground ?? root`. A promoted child owns
 * the foreground; when its guest exits, the parent terminates that worker — but the
 * foreground pointer used to survive it, so every later harness_rpc was posted into a
 * dead port and the caller sat out its timeout. That reads as "the RPC died", which is
 * exactly the moment a post-mortem is wanted; and it is why `childProcesses()` came
 * back empty after a hand-off (the child's own history is empty — the record lives in
 * the parent).
 *
 * Two invariants pinned here: a retired foreground falls back to the root and SAYS SO
 * to anything still in flight, and `target:'root'` reaches the parent even while a
 * child holds the foreground.
 */
import { expect, test } from "bun:test";
import { SessionWorker } from "../../src/app/session-worker";

async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(predicate()).toBe(true);
}

function rig() {
    const rootMessages: any[] = [], childMessages: any[] = [], output: any[] = [];
    const root = {
        onmessage: null as any,
        postMessage(m: any) { rootMessages.push(m); },
        terminate() { },
    } as unknown as Worker;
    const endpoint = new SessionWorker(root);
    endpoint.addEventListener("message", (e) => output.push((e as MessageEvent).data));
    const channel = new MessageChannel();
    channel.port2.onmessage = (e) => childMessages.push(e.data);
    const fromRoot = (data: unknown) =>
        (root as any).onmessage.call(root, new MessageEvent("message", { data }));
    const promote = () => fromRoot({ type: "child_session", port: channel.port1 });
    return { root, rootMessages, childMessages, output, endpoint, channel, fromRoot, promote };
}

test("a promoted child that exits hands the channel back to the root", async () => {
    const r = rig();
    try {
        r.promote();
        r.endpoint.postMessage({ type: "harness_rpc", id: 1, cmd: "state" });
        await until(() => r.childMessages.length === 1);

        // The child's guest exits. Its worker is about to be terminated by the parent.
        r.channel.port2.postMessage({ type: "process_exit", exitCode: 0 });
        await until(() => r.output.some((m) => m.type === "process_exit"));

        const before = r.rootMessages.length;
        r.endpoint.postMessage({ type: "harness_rpc", id: 2, cmd: "report" });
        // It must reach the ROOT, which is still running as the child's VFS broker.
        expect(r.rootMessages.length).toBe(before + 1);
        expect(r.rootMessages.at(-1)).toMatchObject({ id: 2, cmd: "report" });
        expect(r.childMessages.length).toBe(1); // nothing more was posted at the dead port
    } finally { r.endpoint.terminate(); r.channel.port2.close(); }
});

test("a call in flight when the child exits is told, not left to time out", async () => {
    const r = rig();
    try {
        r.promote();
        r.endpoint.postMessage({ type: "harness_rpc", id: 7, cmd: "tickFrames" });
        await until(() => r.childMessages.length === 1);

        r.channel.port2.postMessage({ type: "process_exit", exitCode: 3 });
        await until(() => r.output.some((m) => m.type === "harness_reply" && m.id === 7));

        const reply = r.output.find((m) => m.type === "harness_reply" && m.id === 7);
        expect(reply.ok).toBe(false);
        expect(reply.error.code).toBe("CRASHED");
        expect(reply.error.message).toContain("childProcesses");
        // And the channel is usable again immediately.
        expect(r.output.some((m) => m.type === "child_session_reset")).toBe(true);
    } finally { r.endpoint.terminate(); r.channel.port2.close(); }
});

test("the PARENT's own exit, relayed as broker, does not retire the child", async () => {
    const r = rig();
    try {
        r.promote();
        // `broker:true` is the parent reporting ITS exit through the child's port; the
        // child is still the live realm and must keep the foreground.
        r.channel.port2.postMessage({ type: "process_exit", exitCode: 0, broker: true });
        await until(() => r.output.some((m) => m.type === "process_exit"));

        const before = r.childMessages.length;
        r.endpoint.postMessage({ type: "harness_rpc", id: 9, cmd: "state" });
        await until(() => r.childMessages.length === before + 1);
        expect(r.childMessages.at(-1)).toMatchObject({ id: 9 });
    } finally { r.endpoint.terminate(); r.channel.port2.close(); }
});

test("target:'root' reaches the parent while a child holds the foreground", async () => {
    const r = rig();
    try {
        r.promote();
        r.endpoint.postMessage({ type: "harness_rpc", id: 11, cmd: "state" });
        await until(() => r.childMessages.length === 1);

        const before = r.rootMessages.length;
        r.endpoint.postMessage({
            type: "harness_rpc", id: 12, cmd: "childProcesses", opts: { target: "root" },
        });
        expect(r.rootMessages.length).toBe(before + 1);
        expect(r.rootMessages.at(-1)).toMatchObject({ id: 12, cmd: "childProcesses" });
        expect(r.childMessages.length).toBe(1); // NOT sent to the child as well

        // And the root's reply is delivered — the request was booked against the root.
        r.fromRoot({ type: "harness_reply", id: 12, ok: true, result: { processes: [] } });
        expect(r.output.at(-1)).toMatchObject({ type: "harness_reply", id: 12, ok: true });
    } finally { r.endpoint.terminate(); r.channel.port2.close(); }
});

test("an ordinary call still goes to the child while it holds the foreground", async () => {
    const r = rig();
    try {
        r.promote();
        r.endpoint.postMessage({ type: "harness_rpc", id: 21, cmd: "state" });
        await until(() => r.childMessages.length === 1);
        expect(r.childMessages.at(-1)).toMatchObject({ id: 21 });
        expect(r.rootMessages.some((m) => m?.id === 21)).toBe(false);
    } finally { r.endpoint.terminate(); r.channel.port2.close(); }
});
