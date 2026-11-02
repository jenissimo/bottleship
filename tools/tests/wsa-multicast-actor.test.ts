import { expect, test } from "bun:test";
import { RootNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { createWsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import { ipv4Address, WSA } from "../../src/worker/modules/wsa-network";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!await check()) { if (Date.now() > deadline) throw Error("Multicast actor delivery timeout"); await pause(2); }
}
function child(host: RootNetworkNamespace, pid: number) {
    const lease = host.createChild(pid);
    const worker = new Worker(new URL("./fixtures/wsa-multicast-process-worker.ts", import.meta.url).href, { type: "module" });
    let sequence = 0, closed = false;
    const pending = new Map<number, { resolve(value: any): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> }>();
    const stopped = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
    worker.onmessage = ({ data }) => { const task = pending.get(data.id); if (!task) return; pending.delete(data.id); clearTimeout(task.timer); if (data.error !== undefined) task.reject(data.error); else task.resolve(data.result); };
    const request = (body: object, ports: MessagePort[] = []) => new Promise<any>((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error("Multicast worker request timeout")); }, 7000);
        pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, ...body }, ports);
    });
    const ready = request({ boot: lease.boot }, [lease.boot.port]);
    return { ready, call: (command: string, args: object = {}) => request({ command, args }),
        async close() { if (!closed) { closed = true; worker.terminate(); lease.close(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Closed")); } pending.clear(); } await stopped; } };
}
test("actual process workers share physical multicast through WSADuplicateSocket and provider restart", async () => {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 29, 4, 1)), namespace = new RootNetworkNamespace(network, 16, 29001);
    const root = createWsaActorTable(network, () => namespace.socketActorClient());
    const a = child(namespace, 29002), b = child(namespace, 29003);
    const group = [239, 255, 43, 37], destination = ipv4Address(Uint8Array.from(group), 48429);
    let sender: number;
    try {
        await Promise.all([a.ready, b.ready]);
        sender = root.socket(2, 2, 17); root.setMulticastOption(sender, 9, 0x0100007f); root.setMulticastOption(sender, 10, 0);
        const source = await a.call("create", { port: 48429 });
        await a.call("member", { socket: source, group, join: true });
        const duplicate = await a.call("duplicate", { socket: source, pid: 29003 });
        const alias = await b.call("import", { descriptor: duplicate.descriptor });
        expect(alias).toBe(duplicate.handle);
        await b.call("set", { socket: alias, option: 10, value: 19 });
        expect(await a.call("get", { socket: source, option: 10 })).toBe(19);
        await b.call("set", { socket: alias, option: 11, value: 0 });
        expect(await a.call("get", { socket: source, option: 11 })).toBe(0);
        root.send(sender, Uint8Array.of(65), destination); await namespace.barrier(); await pause(15);
        expect(await a.call("readable", { socket: source })).toBe(false);
        expect(await b.call("readable", { socket: alias })).toBe(false);
        await b.call("set", { socket: alias, option: 11, value: 1 });
        root.send(sender, Uint8Array.of(66), destination); await until(() => b.call("readable", { socket: alias }));
        await b.call("member", { socket: alias, group, join: false });
        const queued = await a.call("receive", { socket: source });
        expect([...queued.data]).toEqual([66]); expect([...queued.ip]).toEqual([127, 0, 0, 1]);
        root.send(sender, Uint8Array.of(67), destination); await namespace.barrier(); await pause(15);
        expect(await b.call("readable", { socket: alias })).toBe(false);
        await b.call("member", { socket: alias, group, join: true });
        await a.call("close", { socket: source });
        root.send(sender, Uint8Array.of(68), destination); await until(() => b.call("readable", { socket: alias }));
        expect([...(await b.call("receive", { socket: alias })).data]).toEqual([68]);
        await b.call("close", { socket: alias });
        const fresh = root.socket(2, 2, 17); root.bind(fresh, ipv4Address(new Uint8Array(4), 48429));
        root.send(sender, Uint8Array.of(69), destination); await namespace.barrier(); await pause(15);
        expect(root.readable(fresh)).toBe(false); root.closesocket(fresh);
        const original = await a.call("create", { port: 48430 });
        await a.call("set", { socket: original, option: 10, value: 27 });
        await a.call("member", { socket: original, group, join: true });
        const reserved = await a.call("duplicate", { socket: original, pid: 29002 });
        expect(await a.call("cleanup")).toBe(0); await a.call("startup");
        const imported = await a.call("import", { descriptor: reserved.descriptor });
        expect(imported).toBe(reserved.handle);
        expect(await a.call("get", { socket: imported, option: 10 })).toBe(27);
        await a.call("member", { socket: imported, group, join: false }); await a.call("close", { socket: imported });
    } finally { root.reset(); await a.close(); await b.close(); await namespace.close(); }
}, 20000);
