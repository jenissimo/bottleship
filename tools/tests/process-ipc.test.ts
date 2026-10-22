import { afterEach, test, expect } from "bun:test";
import { ProcessIpc, ProcessIpcError } from "../../src/worker/core/process-ipc";
import { SharedProcessIds } from "../../src/worker/core/process-identity";
const nodes: ProcessIpc[] = [];
afterEach(() => { for (const node of nodes) node.close(); nodes.length = 0; });
const wait = () => new Promise(resolve => setTimeout(resolve, 4));
function node(pid: number, root = 1234): ProcessIpc { const ipc = new ProcessIpc(pid, root); nodes.push(ipc); return ipc; }
function child(parent: ProcessIpc, pid: number) {
    const ipc = node(pid), channel = new MessageChannel(), close = parent.connectChild(pid, channel.port1);
    ipc.adoptParent(channel.port2); return { ipc, close };
}
test("shared process IDs allocate one monotonically unique identity across descendants", () => {
    const root = new SharedProcessIds(), a = new SharedProcessIds(root.buffer), b = new SharedProcessIds(root.buffer);
    const allocated = [root.allocate(), a.allocate(), b.allocate(), a.allocate(), root.allocate()];
    expect(allocated).toEqual([5000, 5001, 5002, 5003, 5004]); expect(new Set(allocated).size).toBe(5);
});
test("process IPC routes child/root, sibling and descendant requests with one source identity", async () => {
    const root = node(1234), a = child(root, 5000), b = child(root, 5001), c = child(a.ipc, 5002);
    root.register("root", (data, pid) => ({ data, source: pid }));
    b.ipc.register("echo", (data, pid) => ({ data, source: pid, owner: b.ipc.pid }));
    c.ipc.register("deep", (data, pid) => ({ data, source: pid }));
    await wait();
    expect(await c.ipc.request(1234, "root", { n: 1 })).toEqual({ data: { n: 1 }, source: 5002 });
    expect(await a.ipc.request(5001, "echo", "sibling")).toEqual({ data: "sibling", source: 5000, owner: 5001 });
    expect(await root.request(5002, "deep", [1, 2])).toEqual({ data: [1, 2], source: 1234 });
    let count = 0; b.ipc.register("post", (data, pid) => { count += Number(data) + pid; });
    expect(c.ipc.post(5001, "post", 2)).toBe(true); await wait(); expect(count).toBe(5004);
});
test("root services use PID zero and survive a root guest process exit", async () => {
    const root = node(1234), a = child(root, 5000);
    root.registerSystem("configuration", (data, pid) => ({ pid, data }));
    root.markProcessExited(1234);
    expect(await a.ipc.request(0, "configuration", "settings")).toEqual({ pid: 5000, data: "settings" });
    const route = (a.ipc as any).route; let routed = 0;
    (a.ipc as any).route = function (...args: unknown[]) { routed++; return route.apply(this, args); };
    await expect(a.ipc.request(1234, "configuration", null)).rejects.toMatchObject({ code: "NO_PROCESS" });
    expect(routed).toBe(0); expect((a.ipc as any).pending.size).toBe(0);
    expect(a.ipc.post(1234, "configuration", null)).toBe(false);
    expect(await a.ipc.request(0, "configuration", "still-live")).toEqual({ pid: 5000, data: "still-live" });
    const unknown = await a.ipc.request(60000, "configuration", null).catch(error => error);
    expect(unknown).toMatchObject({ code: "NO_PROCESS" });
    expect((a.ipc as any).pending.size).toBe(0);
});
test("process death rejects existing peer requests, removes descendants, and emits one lifecycle event", async () => {
    const root = node(1234), a = child(root, 5000), b = child(root, 5001), c = child(a.ipc, 5002);
    c.ipc.register("stall", () => new Promise(() => {}));
    await wait();
    const pending = b.ipc.request(5002, "stall", null, 1000); const rejection = pending.catch(error => error as ProcessIpcError);
    await wait();
    const exited: number[] = []; b.ipc.onProcessExit(pid => exited.push(pid)); a.close();
    const error = await rejection; expect(error).toMatchObject({ code: "NO_PROCESS" });
    expect(exited.sort()).toEqual([5000, 5002]);
    await expect(root.request(5002, "stall", null)).rejects.toMatchObject({ code: "NO_PROCESS" });
});
test("IPC refuses missing topics, bounds wait time and returns owned copies on local dispatch", async () => {
    const root = node(1234);
    await expect(root.request(1234, "missing", null)).rejects.toMatchObject({ code: "NO_HANDLER" });
    root.register("stall", () => new Promise(() => {}));
    await expect(root.request(1234, "stall", null, 5)).rejects.toMatchObject({ code: "TIMEOUT" });
    root.register("copy", data => { (data as { n: number }).n = 42; return data; });
    const source = { n: 1 }; expect(await root.request(1234, "copy", source)).toEqual({ n: 42 }); expect(source.n).toBe(1);
    const pending = root.request(1234, "stall", null); const rejected = pending.catch(error => error); root.close();
    expect(await rejected).toMatchObject({ code: "CLOSED" });
});

test("indefinite IPC requests remain bounded and peer death cancels them without a timeout", async () => {
    const root = node(1234), a = child(root, 5000);
    a.ipc.register("stall", () => new Promise(() => {}));
    let settled = false;
    const pending = root.request(5000, "stall", null, null).catch(error => { settled = true; return error; });
    await wait(); expect(settled).toBe(false);
    expect((root as any).pending.size).toBe(1);
    a.close(); expect(await pending).toMatchObject({ code: "NO_PROCESS" }); expect((root as any).pending.size).toBe(0);
});
test("closing an IPC endpoint notifies its peer and self exit cancels outstanding requests immediately", async () => {
    const root = node(1234), a = child(root, 5000);
    root.register("stall", () => new Promise(() => {}));
    const pending = a.ipc.request(1234, "stall", null, 1000).catch(error => error);
    await wait(); root.close();
    expect(await pending).toMatchObject({ code: "CLOSED" });
    const b = node(6000, 6000); b.register("stall", () => new Promise(() => {}));
    const own = b.request(6000, "stall", null, 1000).catch(error => error);
    b.markProcessExited(6000); expect(await own).toMatchObject({ code: "CLOSED" });
});
