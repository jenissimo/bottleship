import { LanNetwork } from "../../../src/worker/net/lan-network";
import { ChildProcessNetworkNamespace } from "../../../src/worker/core/network-namespace";
import { WsaSocketTable, WsaFailure, ipv4Address, ipv6Address } from "../../../src/worker/modules/wsa-network";
import { DirectPlaySession } from "../../../src/worker/modules/dplayx/session";

let network: LanNetwork, namespace: ChildProcessNetworkNamespace, table: WsaSocketTable;
let dp: DirectPlaySession | null = null;
let nested: { worker: Worker; close: () => void } | null = null;
const nestedPending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nestedId = 0;
const errorValue = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error), code: error instanceof WsaFailure ? error.code : undefined });
async function run(command: string, args: any): Promise<any> {
    if (command === "identity") return { node: [...network.node], connected: network.connected };
    if (command === "bind") {
        const socket = table.socket(args.type ?? 2, args.family === 6 ? 23 : 2, args.protocol ?? 0);
        table.get(socket).reuse = !!args.reuse;
        table.get(socket).broadcast = true;
        table.bind(socket, args.family === 6 ? ipv6Address(network.ipv6, args.port) : ipv4Address(network.ipv4, args.port));
        if (args.listen) table.listen(socket);
        return socket;
    }
    if (command === "connect") {
        const socket = table.socket();
        if (args.localPort) table.bind(socket, ipv4Address(network.ipv4, args.localPort));
        try { table.connect(socket, ipv4Address(args.ip ? Uint8Array.from(args.ip) : network.ipv4, args.port)); }
        catch (error) { if (!(error instanceof WsaFailure) || error.code !== 10035) throw error; }
        return socket;
    }
    if (command === "socketState") { const socket = table.get(args.socket); return { wireId: socket.wireId, port: socket.local?.port, error: socket.error, eof: socket.eof }; }
    if (command === "connectThenClose") {
        const socket = await run("connect", args); const wireId = table.get(socket).wireId;
        table.closesocket(socket); await namespace.barrier(); return wireId;
    }
    if (command === "closeSocket") { table.closesocket(args.socket); await namespace.barrier(); return true; }
    if (command === "connected") return table.isConnected(args.socket);
    if (command === "send") return table.send(args.socket, Uint8Array.from(args.data),
        args.port ? ipv4Address(args.broadcast ? new Uint8Array(4).fill(255) : network.ipv4, args.port) : undefined);
    if (command === "receive") { const packet = table.receive(args.socket, args.length ?? 65535); return { data: [...packet.data], port: packet.from.port, ip: packet.from.ip ? [...packet.from.ip] : null }; }
    if (command === "resolve") return network.resolve(args.host, args.family ?? 4);
    if (command === "route6") return [...network.routeIpv6(Uint8Array.from(args.address), args.scopeId ?? 0)];
    if (command === "dpInit") { dp = new DirectPlaySession(network, 3000); return dp.initialize(); }
    if (command === "dpCreate") { const hr = dp!.create(args.desc); return { hr, desc: dp!.desc }; }
    if (command === "dpDiscover") return dp!.discover(args.application);
    if (command === "dpFound") return [...dp!.discovered.values()];
    if (command === "dpJoin") return dp!.join(args.desc);
    if (command === "dpPlayer") return dp!.mutate({ op: "mutate", action: "create", group: false, parent: 0, flags: 0, name: { short: args.name, long: "" }, data: [] });
    if (command === "dpSend") return dp!.send(args.from, args.to, 1, Uint8Array.from(args.data));
    if (command === "dpState") return { entities: [...dp!.entities.keys()], lost: dp!.lost, messages: dp!.queue.filter(item => !item.system).map(item => ({ from: item.from, to: item.to, data: [...item.data] })) };
    if (command === "spawnNested") {
        const child = namespace.createChild();
        const worker = new Worker(new URL("./network-namespace-worker.ts", import.meta.url).href, { type: "module" });
        nested = { worker, close: child.close };
        worker.onmessage = event => {
            const pending = nestedPending.get(event.data.id);
            if (!pending) return;
            nestedPending.delete(event.data.id);
            if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
        };
        const id = ++nestedId;
        const ready = new Promise((resolve, reject) => nestedPending.set(id, { resolve, reject }));
        worker.postMessage({ id, boot: child.boot, config: args.config ?? null }, [child.boot.port]);
        return ready;
    }
    if (command === "nested") {
        const id = ++nestedId;
        const result = new Promise((resolve, reject) => nestedPending.set(id, { resolve, reject }));
        nested!.worker.postMessage({ id, command: args.command, args: args.args });
        return result;
    }
    if (command === "stopNested") {
        if (nested) {
            const current = nested;
            const stopped = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Nested worker did not close")), 5000);
                current.worker.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            current.worker.terminate(); current.close(); nested = null; await stopped;
        }
        return true;
    }
    throw new Error("Unknown fixture operation");
}
self.onmessage = async event => {
    const message = event.data;
    try {
        if (message.boot) {
            network = new LanNetwork(); namespace = new ChildProcessNetworkNamespace(network, message.boot);
            table = new WsaSocketTable(network);
            await namespace.configure(message.config ?? null);
            self.postMessage({ id: message.id, result: { node: [...network.node], connected: network.connected } });
        } else self.postMessage({ id: message.id, result: await run(message.command, message.args ?? {}) });
    } catch (error) { self.postMessage({ id: message.id, ...errorValue(error) }); }
};
