import { createServer, type Socket as NativeSocket } from "node:net";
import { decodeDatagram, decodeTcpFrame, SYN, RST } from "../../src/worker/net/netplay-wire";
import { expect, test } from "bun:test";
import { RootNetworkNamespace, ChildProcessNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address } from "../../src/worker/modules/wsa-network";
import { DirectPlaySession, DP, type SessionDesc } from "../../src/worker/modules/dplayx/session";
import { createLanServer } from "../../packages/lan/src/server";
import { parseIpv6 } from "../../packages/lan/src/ip-address";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!(await check())) { if (Date.now() > deadline) throw new Error("Timed out: " + description); await sleep(5); }
}
function child(host: RootNetworkNamespace, config: any = null) {
    const lease = host.createChild();
    const worker = new Worker(new URL("./fixtures/network-namespace-worker.ts", import.meta.url).href, { type: "module" });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void; timer: ReturnType<typeof setTimeout> }>();
    let id = 0, closed = false;
    const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Namespace worker did not close")), 10000);
        worker.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    worker.onmessage = event => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id); clearTimeout(entry.timer);
        if (event.data.error) entry.reject(event.data); else entry.resolve(event.data.result);
    };
    function request(message: object): Promise<any> {
        if (closed) return Promise.reject(new Error("Worker is closed"));
        const current = ++id;
        const result = new Promise((resolve, reject) => pending.set(current, { resolve, reject,
            timer: setTimeout(() => { pending.delete(current); reject(new Error("Namespace worker request timed out")); }, 10000) }));
        worker.postMessage({ id: current, ...message });
        return result;
    }
    const current = ++id;
    const ready = new Promise<any>((resolve, reject) => pending.set(current, { resolve, reject,
        timer: setTimeout(() => reject(new Error("Namespace worker boot timed out")), 10000) }));
    worker.postMessage({ id: current, boot: lease.boot, config }, [lease.boot.port]);
    return { ready, call: (command: string, args: object = {}) => request({ command, args }), close: () => {
        if (closed) return stopped;
        closed = true; worker.terminate(); lease.close();
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Worker terminated")); }
        pending.clear();
        return stopped;
    } };
}
const desc: SessionDesc = { instance: "0".repeat(32), application: "b".repeat(32), flags: 0, maxPlayers: 8, name: "Same machine", password: "", user: [0,0,0,0] };

test("separate workers share an offline identity, atomic ports, local UDP/TCP/DirectPlay and process cleanup", async () => {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 9, 0, 1));
    const host = new RootNetworkNamespace(network, 64), table = new WsaSocketTable(network);
    const first = child(host), second = child(host);
    const rootDp = new DirectPlaySession(network, 3000);
    try {
        const [a, b] = await Promise.all([first.ready, second.ready]);
        expect(a.node).toEqual([...network.node]); expect(b.node).toEqual(a.node);
        expect(a.connected).toBe(false);
        const rootUdp = table.socket(2); table.get(rootUdp).broadcast = true;
        table.bind(rootUdp, ipv4Address(network.ipv4, 6000));
        const childUdp = await first.call("bind", { port: 6001 });
        table.send(rootUdp, Uint8Array.of(1, 2), ipv4Address(network.ipv4, 6001));
        let packet: any;
        await until(async () => { try { packet = await first.call("receive", { socket: childUdp }); return true; } catch (error: any) { if (error.code === WSA.EWOULDBLOCK) return false; throw error; } }, "child UDP");
        expect(packet.data).toEqual([1, 2]); expect(packet.ip).toEqual([...network.ipv4]);
        await first.call("send", { socket: childUdp, port: 6000, data: [3] });
        await until(() => table.readable(rootUdp), "root UDP");
        expect([...table.receive(rootUdp, 10).data]).toEqual([3]);

        const rootUdp6 = table.socket(2, 23);
        table.bind(rootUdp6, ipv6Address(network.ipv6, 6000));
        const childUdp6 = await first.call("bind", { port: 6001, family: 6 });
        table.send(rootUdp6, Uint8Array.of(6, 23), ipv6Address(network.ipv6, 6001));
        await until(async () => { try { packet = await first.call("receive", { socket: childUdp6 }); return true; } catch (error: any) { if (error.code === WSA.EWOULDBLOCK) return false; throw error; } }, "cross-worker IPv6 UDP with same IPv4 port");
        expect(packet.data).toEqual([6, 23]);
        let emptyError: any;
        try { await first.call("receive", { socket: childUdp }); } catch (error) { emptyError = error; }
        expect(emptyError?.code).toBe(WSA.EWOULDBLOCK);

        const shared = table.socket(2); table.get(shared).reuse = true;
        table.bind(shared, ipv4Address(network.ipv4, 6010));
        const childShared = await first.call("bind", { port: 6010, reuse: true });
        table.send(rootUdp, Uint8Array.of(7), ipv4Address(new Uint8Array(4).fill(255), 6010));
        expect([...table.receive(shared, 10).data]).toEqual([7]);
        await until(async () => { try { packet = await first.call("receive", { socket: childShared }); return true; } catch (error: any) { if (error.code === WSA.EWOULDBLOCK) return false; throw error; } }, "reuse broadcast");
        expect(packet.data).toEqual([7]);
        const race = await Promise.allSettled([first.call("bind", { port: 6020 }), second.call("bind", { port: 6020 })]);
        expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(race.filter(result => result.status === "rejected")).toHaveLength(1);

        const listener = table.socket(); table.bind(listener, ipv4Address(network.ipv4, 6100)); table.listen(listener);
        const tcpClient = await first.call("connect", { port: 6100 });
        await until(async () => await first.call("connected", { socket: tcpClient }), "cross-worker TCP connected");
        await until(() => table.readable(listener), "cross-worker TCP accept");
        const tcpServer = table.accept(listener);
        await first.call("send", { socket: tcpClient, data: [10, 11, 12] });
        await until(() => table.bytesAvailable(tcpServer) === 3, "cross-worker TCP data");
        expect([...table.receive(tcpServer, 2).data]).toEqual([10, 11]);
        expect([...table.receive(tcpServer, 10).data]).toEqual([12]);

        expect(rootDp.initialize()).toBe(DP.OK);
        expect(await second.call("dpInit")).toBe(DP.OK);
        const created = await second.call("dpCreate", { desc });
        expect(created.hr).toBe(DP.OK);
        rootDp.discover(desc.application);
        await until(() => rootDp.discovered.has(created.desc.instance), "same-address DirectPlay discovery");
        expect(await rootDp.join(created.desc)).toBe(DP.OK);
        const rootPlayer = await rootDp.mutate({ op: "mutate", action: "create", group: false, parent: 0, flags: 0, name: { short: "root", long: "" }, data: [] });
        const childPlayer = await second.call("dpPlayer", { name: "child" });
        await until(() => rootDp.entities.has(childPlayer.id), "same-address DirectPlay players");
        expect(await second.call("dpSend", { from: childPlayer.id, to: rootPlayer.id, data: [42] })).toBe(DP.OK);
        await until(() => rootDp.queue.some(item => !item.system && item.data[0] === 42), "same-address DirectPlay message");

        const nested = await second.call("spawnNested");
        expect(nested.node).toEqual([...network.node]);
        const nestedUdp = await second.call("nested", { command: "bind", args: { port: 6200 } });
        table.send(rootUdp, Uint8Array.of(55), ipv4Address(network.ipv4, 6200));
        await until(async () => { try { packet = await second.call("nested", { command: "receive", args: { socket: nestedUdp } }); return true; } catch { return false; } }, "nested worker UDP");
        expect(packet.data).toEqual([55]);
        await second.call("stopNested");
        await until(() => { const socket = table.socket(2); try { table.bind(socket, ipv4Address(network.ipv4, 6200)); table.closesocket(socket); return true; } catch { table.closesocket(socket); return false; } }, "nested process port cleanup");

        const orderly = await first.call("connect", { port: 6100 });
        await until(async () => await first.call("connected", { socket: orderly }), "orderly cross-worker TCP connected");
        await until(() => table.readable(listener), "orderly cross-worker TCP accept");
        const orderlyPeer = table.accept(listener);
        await first.call("closeSocket", { socket: orderly }); // Includes the namespace barrier before the exit channel.
        await first.close();
        await until(() => table.get(orderlyPeer).eof, "orderly FIN survives worker teardown");
        expect(table.receive(orderlyPeer, 1).data.length).toBe(0);
        expect(table.get(orderlyPeer).error).toBe(0);
        await until(() => table.exceptional(tcpServer), "dead child resets same-address TCP");
        expect(() => table.receive(tcpServer, 1)).toThrow(WsaFailure);
        expect(table.get(tcpServer).error).toBe(WSA.ECONNRESET);
        await second.close();
        await until(() => rootDp.lost, "dead same-address DirectPlay host");
        expect(rootDp.readyError).toBe(DP.SESSIONLOST);
    } finally {
        try { await second.call("stopNested"); } catch {}
        await Promise.all([first.close(), second.close()]); rootDp.dispose(); table.reset(); await host.close();
    }
}, 30_000);

test("a process family uses one relay connection and delegates DNS/config/reconnect", async () => {
    const server = createLanServer({ port: 0, gateway: { routes: [
        { host: "127.0.0.1", address: "203.0.113.20", names: ["family.game.test"], ports: [7777], protocols: ["udp"] },
        { host: "::1", address: "2001:db8::50", names: ["family6.game.test"], ports: [7777], protocols: ["udp"] },
    ] } });
    const port = await server.listen(), config = { serverUrl: "http://127.0.0.1:" + port, room: "family" };
    let joins = 0; server.io.on("connection", () => joins++);
    const network = new LanNetwork(Uint8Array.of(2,0,0,9,0,2)), host = new RootNetworkNamespace(network, 64);
    await host.configure(config);
    const a = child(host, config), b = child(host, config), local = new WsaSocketTable(network);
    try {
        await Promise.all([a.ready, b.ready]);
        expect(joins).toBe(1);
        const v6 = parseIpv6("2001:db8::50")!;
        const token = [...network.routeIpv6(v6)];
        expect(await a.call("route6", { address: [...v6] })).toEqual(token);
        expect((await b.call("resolve", { host: "family6.game.test", family: 6 })).addresses).toEqual([{ address: "2001:db8::50", family: 6, node: token }]);
        expect((await a.call("resolve", { host: "family.game.test" })).addresses).toEqual([{ address: "203.0.113.20", family: 4 }]);
        expect((await b.call("identity")).node).toEqual([...network.node]);
        const listener = local.socket(); local.bind(listener, ipv4Address(network.ipv4, 6800)); local.listen(listener);
        const childTcp = await a.call("connect", { port: 6800 });
        await until(async () => await a.call("connected", { socket: childTcp }), "local stream online");
        await until(() => local.readable(listener), "local stream accept");
        const accepted = local.accept(listener), udp = local.socket(2), childUdp = await a.call("bind", { port: 6801 });
        server.io.disconnectSockets(true);
        await until(() => !network.connected, "namespace disconnect");
        await until(async () => !(await a.call("identity")).connected, "child observes relay loss");
        expect(await a.call("connected", { socket: childTcp })).toBe(true);
        await a.call("send", { socket: childTcp, data: [9] });
        await until(() => local.bytesAvailable(accepted) === 1, "local TCP after relay loss");
        expect([...local.receive(accepted,1).data]).toEqual([9]);
        local.send(udp,Uint8Array.of(8),ipv4Address(network.ipv4,6801));
        let offlineDatagram: any;
        await until(async () => { try { offlineDatagram=await a.call("receive",{socket:childUdp});return true; } catch(error: any) { if(error.code===WSA.EWOULDBLOCK)return false;throw error; } }, "local UDP after relay loss");
        expect(offlineDatagram.data).toEqual([8]);
        await host.configure(config);
        await until(async () => (await a.call("identity")).connected && (await b.call("identity")).connected, "namespace reconnect forwarded");
        expect(joins).toBe(2);
        expect(local.isConnected(accepted)).toBe(true);
        expect(await a.call("connected", { socket: childTcp })).toBe(true);
    } finally { await Promise.all([a.close(), b.close()]); local.reset(); await host.close(); await server.close(); }
}, 20_000);

test("shared port reservations support more than 31 process slots", async () => {
    const network = new LanNetwork(Uint8Array.of(2,0,0,9,0,3)), host = new RootNetworkNamespace(network, 64);
    const leases: ReturnType<typeof host.createChild>[] = [], adapters: LanNetwork[] = [], clients: ChildProcessNetworkNamespace[] = [];
    try {
        for (let i = 0; i < 40; i++) {
            const lease = host.createChild(), adapter = new LanNetwork(), client = new ChildProcessNetworkNamespace(adapter, lease.boot);
            leases.push(lease); adapters.push(adapter); clients.push(client);
        }
        expect(adapters[39].node).toEqual(network.node);
        const endpoint = { deliver() {} };
        expect(adapters[39].bind(6500, endpoint, 1)).toBe(true);
        expect(network.bind(6500, endpoint, 1)).toBe(false);
        clients[39].close(); leases[39].close();
        expect(network.bind(6500, endpoint, 1)).toBe(true);
        network.unbind(6500, endpoint, 1);
    } finally { clients.forEach(client => client.close()); leases.forEach(lease => lease.close()); await host.close(); }
});

test("child death cancels native TCP flows and a reused port cannot inherit an old stream", async () => {
    const sockets=new Set<NativeSocket>();let serial=0;
    const native=createServer(socket=>{
        const current=++serial;sockets.add(socket);
        socket.on("data",bytes=>socket.write(Uint8Array.of(current,...bytes)));
        socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));
    });
    await new Promise<void>(resolve=>native.listen(0,"127.0.0.1",resolve));
    const nativePort=(native.address() as {port:number}).port;
    const server=createLanServer({port:0,transports:["polling"],gateway:{routes:[
        {host:"127.0.0.1",address:"203.0.113.30",ports:[nativePort],protocols:["tcp"]},
    ]}});
    let cancels=0;
    server.io.on("connection",socket=>socket.on("frame",frame=>{
        const datagram=decodeDatagram(frame),packet=datagram?decodeTcpFrame(datagram.payload):null;
        if(packet?.kind===RST)cancels++;
    }));
    const port=await server.listen(),config={serverUrl:"http://127.0.0.1:"+port,room:"process-native"};
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,64);
    await host.configure(config);
    const first=child(host,config);let second:ReturnType<typeof child>|null=null;
    try{
        await first.ready;
        const initial=await first.call("connect",{ip:[203,0,113,30],port:nativePort,localPort:6400});
        await until(async()=>await first.call("connected",{socket:initial}),"first native child stream");
        const firstId=(await first.call("socketState",{socket:initial})).wireId;
        await first.call("send",{socket:initial,data:[70]});let received:any;
        await until(async()=>{try{received=await first.call("receive",{socket:initial});return true;}catch(error:any){if(error.code===WSA.EWOULDBLOCK)return false;throw error;}},"first native echo");
        expect(received.data).toEqual([1,70]);
        await first.close();
        await until(()=>cancels>=1&&sockets.size===0,"dead child sends native RST and releases native socket");
        second=child(host,config);await second.ready;
        const replacement=await second.call("connect",{ip:[203,0,113,30],port:nativePort,localPort:6400});
        await until(async()=>await second!.call("connected",{socket:replacement}),"replacement native child stream");
        const secondId=(await second.call("socketState",{socket:replacement})).wireId;
        expect(secondId).not.toBe(firstId);
        await second.call("send",{socket:replacement,data:[71]});
        await until(async()=>{try{received=await second!.call("receive",{socket:replacement});return true;}catch(error:any){if(error.code===WSA.EWOULDBLOCK)return false;throw error;}},"replacement native echo");
        expect(received.data).toEqual([2,71]);
        await second.close();
        await until(()=>sockets.size===0,"replacement child native socket cleanup");
        const cancelling=child(host,config);
        try{
            await cancelling.ready;const previous=cancels;
            await cancelling.call("connectThenClose",{ip:[203,0,113,30],port:nativePort,localPort:6400});
            await until(()=>cancels>previous,"cancel-before-SYNACK reaches gateway");
            await until(()=>sockets.size===0,"cancel-before-SYNACK releases native socket");
        }finally{await cancelling.close();}
    }finally{
        await first.close();if(second)await second.close();await host.close();await server.close();
        for(const socket of sockets)socket.destroy();
        await new Promise<void>(resolve=>native.close(()=>resolve()));
    }
},30000);

test("RAW actual and wildcard protocols fan out across process workers without duplicate delivery",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,16),table=new WsaSocketTable(network);
    const a=child(host),b=child(host);
    try {
        await Promise.all([a.ready,b.ready]);
        const actual=table.socket(3,2,17),wild=table.socket(3,2,255),other=table.socket(3,2,6);
        table.bind(actual,ipv4Address(network.ipv4,0));table.bind(wild,ipv4Address(network.ipv4,0));table.bind(other,ipv4Address(network.ipv4,0));
        const zero=await a.call("bind",{type:3,protocol:0,port:0});
        const exact=await b.call("bind",{type:3,protocol:17,port:0});
        const body=Uint8Array.of(91,92,93);
        table.send(actual,body,ipv4Address(network.ipv4,0));
        let first:any,second:any;
        await until(async()=>{
            try {first??=await a.call("receive",{socket:zero});second??=await b.call("receive",{socket:exact});return true;}
            catch(error:any){if(error.code===WSA.EWOULDBLOCK)return false;throw error;}
        },"raw wildcard workers");
        expect(first.data.slice(20)).toEqual([...body]);expect(second.data.slice(20)).toEqual([...body]);
        expect(first.data[9]).toBe(17);expect(second.data[9]).toBe(17);
        expect(table.receive(actual,100).data.subarray(20)).toEqual(body);
        expect(table.receive(wild,100).data.subarray(20)).toEqual(body);
        expect(table.readable(other)).toBe(false);
        let duplicate:any;try {await a.call("receive",{socket:zero});}catch(error){duplicate=error;}
        expect(duplicate?.code).toBe(WSA.EWOULDBLOCK);
        expect(table.readable(actual)).toBe(false);expect(table.readable(wild)).toBe(false);
    } finally {await Promise.all([a.close(),b.close()]);table.reset();await host.close();}
},20000);
