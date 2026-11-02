import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LanNetwork, type NetTransport } from "../../src/worker/net/lan-network";
import { encodeDatagram, decodeDatagram, PROTO_IPX } from "../../src/worker/net/netplay-wire";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, FD_READ, FD_WRITE, FD_ACCEPT, FD_CONNECT, FD_CLOSE } from "../../src/worker/modules/wsa-network";
import { makeSocketExports, makeSelect, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const tables: WsaSocketTable[] = [];
afterEach(() => { for (const table of tables.splice(0)) table.reset(); });
function table(net = new LanNetwork(new Uint8Array([2, 0, 0, 1, 1, 1]))) {
    const value = new WsaSocketTable(net); tables.push(value); return value;
}
function pair(block?: (source: LanNetwork, frame: Uint8Array) => boolean) {
    const na = new LanNetwork(new Uint8Array([2, 0, 0, 1, 1, 1]));
    const nb = new LanNetwork(new Uint8Array([2, 0, 0, 1, 1, 2]));
    const link = (src: LanNetwork, dst: LanNetwork): NetTransport => ({
        send(frame) { if (block?.(src, frame)) return false; const d = decodeDatagram(frame)!;
            dst.receiveFrame(encodeDatagram(d.proto, src.node, d.dstPort, d.srcPort, d.payload)); return true; },
        close() {},
    });
    na.attach(link(na, nb)); nb.attach(link(nb, na));
    return { a: table(na), b: table(nb), na, nb };
}
function tcp(block?: (source: LanNetwork, frame: Uint8Array) => boolean) {
    const p = pair(block), listener = p.b.socket();
    p.b.bind(listener, ipv4Address(p.nb.ipv4, 1234)); p.b.listen(listener);
    const client = p.a.socket();
    expect(p.a.connect(client, ipv4Address(p.nb.ipv4, 1234))).toBe(0);
    const server = p.b.accept(listener);
    return { ...p, listener, client, server };
}
function error(fn: () => unknown, code: number) {
    try { fn(); throw new Error("expected Winsock failure"); }
    catch (e) { expect(e).toBeInstanceOf(WsaFailure); expect((e as WsaFailure).code).toBe(code); }
}
function abi(t: WsaSocketTable) {
    let memory = new Uint8Array(4096), lastError = 0;
    Mem.bind(() => memory);
    const counter = new WsaStartupCount(); counter.startup();
    const exports = makeSocketExports(t, code => { lastError = code; }, counter);
    const call = (name: string, args: number[]) => exports[name]({} as never, memory, args);
    return { call, exports, lastError: () => lastError, memory: () => memory,
        replace: () => { memory = memory.slice(); }, set: (ptr: number, value: number) => new DataView(memory.buffer).setUint32(ptr, value, true) };
}
function apply(result: any, memory: Uint8Array) {
    for (const w of result.deferredWrites ?? []) {
        const view = new DataView(memory.buffer);
        if (w.size === 4) view.setUint32(w.address, w.value, true);
        else if (w.size === 2) view.setUint16(w.address, w.value, true);
        else view.setUint8(w.address, w.value);
    }
}
describe("Winsock datagrams on the virtual LAN", () => {
    test("UDP preserves message boundaries, source address, empty packets and MSG_PEEK", () => {
        const { a, b, nb } = pair(), sa = a.socket(2), sb = b.socket(2);
        b.bind(sb, ipv4Address(nb.ipv4, 5555));
        expect(a.send(sa, new Uint8Array([1, 2, 3]), ipv4Address(nb.ipv4, 5555))).toBe(3);
        a.send(sa, new Uint8Array(0), ipv4Address(nb.ipv4, 5555));
        expect(b.bytesAvailable(sb)).toBe(3);
        expect([...b.receive(sb, 1, 2).data]).toEqual([1]);
        const received = b.receive(sb, 2);
        expect([...received.data]).toEqual([1, 2]); expect(received.truncated).toBe(true);
        expect(received.from.port).toBe(a.get(sa).local!.port);
        expect(b.readable(sb)).toBe(true);
        expect(b.receive(sb, 20).data.length).toBe(0);
        error(() => b.receive(sb, 10), WSA.EWOULDBLOCK);
    });
    test("broadcast requires SO_BROADCAST; room-local IPX and UDP use separate ports", () => {
        const t = table(), udp = t.socket(2), ipx = t.socket(2, 6, 1000);
        t.bind(udp, ipv4Address(t.network.ipv4, 9999));
        t.bind(ipx, { family: 6, node: t.network.node, port: 9999 });
        const dst = ipv4Address(new Uint8Array([255, 255, 255, 255]), 9999);
        error(() => t.send(udp, new Uint8Array([1]), dst), WSA.EACCES);
        t.get(udp).broadcast = true;
        t.send(udp, new Uint8Array([7]), dst);
        expect([...t.receive(udp, 10).data]).toEqual([7]);
        error(() => t.receive(ipx, 10), WSA.EWOULDBLOCK);
        t.send(ipx, new Uint8Array([8]), { family: 6, node: t.network.node, port: 9999 });
        expect([...t.receive(ipx, 10).data]).toEqual([8]);
    });
    test("bind(any) allocates an address; conflicts, foreign interfaces and unsupported providers fail", () => {
        const t = table(), s = t.socket(2), other = t.socket(2);
        t.bind(s, ipv4Address(new Uint8Array(4), 7777));
        expect(t.get(s).local!.ip).toEqual(new Uint8Array(4));
        error(() => t.bind(other, ipv4Address(new Uint8Array(4), 7777)), WSA.EADDRINUSE);
        error(() => t.bind(other, ipv4Address(new Uint8Array([10, 2, 2, 2]), 8888)), WSA.EADDRNOTAVAIL);
        expect(t.get(t.socket(1, 23)).af).toBe(23);
        expect(t.get(t.socket(3, 2, 1)).type).toBe(3);
        error(() => t.send(s, new Uint8Array([1]), ipv4Address(new Uint8Array([8, 8, 8, 8]), 53)), WSA.ENETDOWN);
    });
    test("IPX keeps 546 guest bytes and transports protocol packet types with receive filters", () => {
        const { a, b, nb } = pair(), sender = a.socket(2, 6, 1034), receiver = b.socket(2, 6, 1000);
        b.bind(receiver, { family: 6, node: nb.node, port: 5000 });
        b.get(receiver).filterPacketType = 33;
        const payload = new Uint8Array(546).fill(8), destination = { family: 6, node: nb.node, port: 5000 };
        expect(a.send(sender, payload, destination)).toBe(546); expect(b.readable(receiver)).toBe(false);
        b.get(receiver).filterPacketType = 34;
        expect(a.send(sender, payload, destination)).toBe(546); expect(b.receive(receiver, 1000).data).toEqual(payload);
        error(() => a.send(sender, new Uint8Array(547), destination), WSA.EMSGSIZE);
    });
    test("connected UDP filters other source endpoints", () => {
        const { a, b, nb, na } = pair(), receiver = b.socket(2), sender = a.socket(2), stranger = a.socket(2);
        a.bind(sender, ipv4Address(na.ipv4, 6000)); b.bind(receiver, ipv4Address(nb.ipv4, 6001));
        b.connect(receiver, ipv4Address(na.ipv4, 6000));
        a.send(stranger, new Uint8Array([1]), ipv4Address(nb.ipv4, 6001));
        expect(b.readable(receiver)).toBe(false);
        a.send(sender, new Uint8Array([2]), ipv4Address(nb.ipv4, 6001));
        expect([...b.receive(receiver, 10).data]).toEqual([2]);
    });
});
describe("Winsock reliable byte streams", () => {
    test("cancelling or closing an in-progress connect removes its remote queued child and ignores stale SYNACKs", () => {
        const {a,b,na,nb}=pair(),held:Uint8Array[]=[];
        nb.attach({send(frame){const p=decodeDatagram(frame)!;
            const rewritten=encodeDatagram(p.proto,nb.node,p.dstPort,p.srcPort,p.payload);
            if(p.proto===2&&new DataView(p.payload.buffer,p.payload.byteOffset,p.payload.byteLength).getUint32(4,true)===2)held.push(rewritten);
            else na.receiveFrame(rewritten);return true;},close(){}});
        const listener=b.socket();b.bind(listener,ipv4Address(nb.ipv4,1234));b.listen(listener);
        const client=a.socket();error(()=>a.connect(client,ipv4Address(nb.ipv4,1234)),WSA.EWOULDBLOCK);
        const previous=a.get(client).wireId;expect(b.get(listener).pending.length).toBe(1);
        a.cancelConnect(client);expect(b.get(listener).pending.length).toBe(0);expect(a.get(client).wireId).not.toBe(previous);
        error(()=>a.connect(client,ipv4Address(nb.ipv4,1234)),WSA.EWOULDBLOCK);
        na.receiveFrame(held.shift()!);expect(a.get(client).state).toBe("connecting");
        na.receiveFrame(held.shift()!);expect(a.isConnected(client)).toBe(true);expect(b.isConnected(b.accept(listener))).toBe(true);
        const other=a.socket();error(()=>a.connect(other,ipv4Address(nb.ipv4,1234)),WSA.EWOULDBLOCK);
        expect(b.get(listener).pending.length).toBe(1);a.closesocket(other);expect(b.get(listener).pending.length).toBe(0);
    });
    test("connect cancellation remains safe when the shared wire identity allocator is exhausted", () => {
        const { a, b, na, nb } = pair(), held: Uint8Array[] = [];
        nb.attach({ send(frame) { const p = decodeDatagram(frame)!; held.push(encodeDatagram(p.proto, nb.node, p.dstPort, p.srcPort, p.payload)); return true; }, close() {} });
        const listener = b.socket(); b.bind(listener, ipv4Address(nb.ipv4, 1234)); b.listen(listener);
        const client = a.socket(); error(() => a.connect(client, ipv4Address(nb.ipv4, 1234)), WSA.EWOULDBLOCK);
        const allocator = spyOn(na, "allocateSocketId").mockImplementation(() => { throw Error("identity exhausted"); });
        try {
            expect(() => a.cancelConnect(client)).not.toThrow(); expect(b.get(listener).pending.length).toBe(0);
            na.receiveFrame(held.shift()!); expect(a.get(client).state).toBe("failed");
            error(() => a.connect(client, ipv4Address(nb.ipv4, 1234)), WSA.ENOBUFS);
        } finally { allocator.mockRestore(); }
        error(() => a.connect(client, ipv4Address(nb.ipv4, 1234)), WSA.EWOULDBLOCK);
        na.receiveFrame(held.shift()!); expect(a.isConnected(client)).toBe(true);
    });
    test("connect/listen/accept support both directions, partial receives and FIN after queued data", () => {
        const { a, b, client, server } = tcp();
        a.send(client, new Uint8Array([1, 2, 3])); a.send(client, new Uint8Array([4, 5]));
        expect([...b.receive(server, 4).data]).toEqual([1, 2, 3, 4]);
        a.shutdown(client, 1);
        expect([...b.receive(server, 4).data]).toEqual([5]);
        expect(b.receive(server, 4).data.length).toBe(0);
        b.send(server, new Uint8Array([9]));
        expect([...a.receive(client, 4).data]).toEqual([9]);
        error(() => a.send(client, new Uint8Array([1])), WSA.ESHUTDOWN);
    });
    test("flow control bounds the receive queue and restores writability after consumption", () => {
        const { a, b, client, server } = tcp(), chunk = new Uint8Array(16384);
        for (let i = 0; i < 16; i++) expect(a.send(client, chunk)).toBe(chunk.length);
        expect(a.writable(client)).toBe(false);
        error(() => a.send(client, chunk), WSA.EWOULDBLOCK);
        expect(b.bytesAvailable(server)).toBe(256 * 1024);
        b.receive(server, 16384);
        expect(a.writable(client)).toBe(true); expect(a.send(client, chunk)).toBe(chunk.length);
    });
    test("close with unread data resets the peer; relay loss wakes connections with an error", () => {
        const p = tcp();
        p.a.send(p.client, new Uint8Array([1])); p.b.closesocket(p.server);
        error(() => p.a.receive(p.client, 10), WSA.ECONNRESET);
        const q = tcp(); q.na.setConnected(false, "test disconnect");
        expect(q.a.exceptional(q.client)).toBe(true);
        error(() => q.a.send(q.client, new Uint8Array([1])), WSA.ENETDOWN);
    });
    test("peer departure fails only its TCP sockets and wakes blocked recv while the relay stays online", async () => {
        const p = tcp(), h = abi(p.a);
        const events: number[] = [];
        p.a.configureEvents(p.client, FD_CLOSE, bit => events.push(bit));
        // Event select makes the socket nonblocking; a blocking wait uses the provider without events.
        p.a.configureEvents(p.client, 0); p.a.setNonBlocking(p.client, false);
        const pending = h.call("recv", [p.client, 128, 16, 0]);
        expect(pending).toBeInstanceOf(Promise);
        p.na.notifyPeerDisconnected(p.nb.node);
        expect(p.na.connected).toBe(true);
        const result: any = await pending;
        expect(result.value).toBe(-1); expect(h.lastError()).toBe(WSA.ECONNRESET);
        const another = tcp();
        another.a.configureEvents(another.client, FD_CLOSE, bit => events.push(bit));
        another.na.notifyPeerDisconnected(new Uint8Array([2, 0, 0, 9, 9, 9]));
        expect(another.a.isConnected(another.client)).toBe(true);
        another.na.notifyPeerDisconnected(another.nb.node);
        expect(events).toEqual([FD_CLOSE]);
    });
    test("a listener retains its port after accepting, and accepted connections survive listener close", () => {
        const { a, b, client, server, listener } = tcp();
        b.closesocket(listener); a.send(client, new Uint8Array([6]));
        expect([...b.receive(server, 3).data]).toEqual([6]);
    });
    test("FD_ACCEPT/CONNECT/READ/WRITE/CLOSE are signalled and reads re-enable notifications", () => {
        const p = pair(), listener = p.b.socket(), client = p.a.socket(), events: number[] = [], connections: number[] = [];
        p.b.bind(listener, ipv4Address(p.nb.ipv4, 1234)); p.b.listen(listener);
        p.b.configureEvents(listener, FD_ACCEPT, bit => events.push(bit));
        p.a.configureEvents(client, FD_CONNECT | FD_WRITE, bit => connections.push(bit));
        p.a.connect(client, ipv4Address(p.nb.ipv4, 1234)); const server = p.b.accept(listener);
        expect(events).toEqual([FD_ACCEPT]); expect(connections).toContain(FD_CONNECT); expect(connections).toContain(FD_WRITE);
        const reads: number[] = [];
        p.b.configureEvents(server, FD_READ | FD_CLOSE, bit => reads.push(bit));
        p.a.send(client, new Uint8Array([1])); p.a.send(client, new Uint8Array([2]));
        expect(reads).toEqual([FD_READ]); p.b.receive(server, 1); expect(reads).toEqual([FD_READ, FD_READ]);
        p.b.receive(server, 5); p.a.shutdown(client, 1); expect(reads.at(-1)).toBe(FD_CLOSE);
    });
});
describe("Winsock ABI blocking and completion safety", () => {
    test("blocking recv parks, returns deferred writes, and survives guest-memory replacement", async () => {
        const p = tcp(), h = abi(p.b);
        const reusableArgs = [p.server, 128, 16, 0];
        const pending = h.call("recv", reusableArgs);
        reusableArgs.fill(0); // Dispatcher overwrites this same array for another thread.
        expect(pending).toBeInstanceOf(Promise);
        h.replace(); p.a.send(p.client, new Uint8Array([5, 6]));
        const result: any = await pending;
        expect(result.value).toBe(2); expect(h.memory()[128]).toBe(0);
        apply(result, h.memory()); expect([...h.memory().slice(128, 130)]).toEqual([5, 6]);
    });
    test("nonblocking recv returns WSAEWOULDBLOCK, while a blocking receive is cancelled on reset", async () => {
        const p = tcp(), h = abi(p.b);
        p.b.setNonBlocking(p.server, true);
        expect(h.call("recv", [p.server, 128, 10, 0])).toBe(-1); expect(h.lastError()).toBe(WSA.EWOULDBLOCK);
        p.b.setNonBlocking(p.server, false); const pending = h.call("recv", [p.server, 128, 10, 0]);
        p.b.reset(); const result: any = await pending; expect(result.value).toBe(-1); expect(h.lastError()).toBe(WSA.EINTR);
    });
    test("select waits for actual data and timeout writes empty fd_sets", async () => {
        const p = tcp(), h = abi(p.b), select = makeSelect(p.b, () => {});
        h.set(32, 1); h.set(36, p.server);
        const result = select({} as never, h.memory(), [0, 32, 0, 0, 0]);
        expect(result).toBeInstanceOf(Promise);
        p.a.send(p.client, new Uint8Array([8]));
        const ready: any = await result; expect(ready.value).toBe(1); apply(ready, h.memory());
        expect(new DataView(h.memory().buffer).getUint32(36, true)).toBe(p.server);
        p.b.receive(p.server, 10); h.set(64, 0); h.set(68, 1000);
        const timeout: any = await select({} as never, h.memory(), [0, 32, 0, 0, 64]);
        expect(timeout.value).toBe(0); apply(timeout, h.memory()); expect(new DataView(h.memory().buffer).getUint32(32, true)).toBe(0);
    });
    test("recvfrom copies truncated prefix and reports WSAEMSGSIZE; bad buffers fail without consuming", () => {
        const t = table(), s = t.socket(2); t.bind(s, ipv4Address(t.network.ipv4, 2345));
        const h = abi(t); t.send(s, new Uint8Array([1, 2, 3]), ipv4Address(t.network.ipv4, 2345));
        expect(h.call("recvfrom", [s, 4090, 100, 0, 0, 0])).toBe(-1); expect(h.lastError()).toBe(WSA.EFAULT);
        expect(h.call("recvfrom", [s, 128, 2, 0, 0, 0])).toBe(-1); expect(h.lastError()).toBe(WSA.EMSGSIZE);
        expect([...h.memory().slice(128, 130)]).toEqual([1, 2]);
    });
    test("WSASend/WSARecv scatter/gather use real payload bytes and validate OVERLAPPED extent", async () => {
        const p = tcp(), h = abi(p.a);
        h.set(32, 2); h.set(36, 100); h.set(40, 3); h.set(44, 110);
        h.memory().set([1, 2], 100); h.memory().set([3, 4, 5], 110);
        expect(h.call("WSASend", [p.client, 32, 2, 64, 0, 0, 0])).toBe(0);
        expect([...p.b.receive(p.server, 10).data]).toEqual([1, 2, 3, 4, 5]);
        expect(h.call("WSASend", [p.client, 32, 2, 64, 0, 4090, 0])).toBe(-1);
        expect(h.lastError()).toBe(WSA.EFAULT);
    });
    test("backpressure drain with a blocked peer recv sends exactly one stream segment under synchronous CREDIT", async () => {
        let blocked = false;
        const p = tcp(src => blocked && src.node[5] === 1);
        const sendingSide = abi(p.a); sendingSide.memory()[128] = 7; blocked = true;
        const sending = sendingSide.call("send", [p.client, 128, 1, 0]);
        expect(sending).toBeInstanceOf(Promise);
        const receivingSide = abi(p.b), receiving = receivingSide.call("recv", [p.server, 128, 10, 0]);
        expect(receiving).toBeInstanceOf(Promise);
        blocked = false; p.na.notifyWritable();
        expect((await sending as any).value).toBe(1);
        const result: any = await receiving; expect(result.value).toBe(1);
        apply(result, receivingSide.memory()); expect(receivingSide.memory()[128]).toBe(7);
        expect(p.b.bytesAvailable(p.server)).toBe(0);
    });
    test("connected foreign UDP receive wakes on relay disconnect and can resume after reconnect", async () => {
        const p = pair(), s = p.a.socket(2), tx = p.b.socket(2); p.a.bind(s, ipv4Address(p.na.ipv4, 1234));
        p.b.bind(tx, ipv4Address(p.nb.ipv4, 6000)); p.a.connect(s, ipv4Address(p.nb.ipv4, 6000));
        const h = abi(p.a), receiving = h.call("recv", [s, 128, 10, 0]);
        p.na.setConnected(false);
        expect((await receiving as any).value).toBe(-1); expect(h.lastError()).toBe(WSA.ENETDOWN);
        p.na.setConnected(true); expect(p.a.get(s).error).toBe(0);
        p.b.send(tx, new Uint8Array([6]), ipv4Address(p.na.ipv4, 1234));
        expect([...p.a.receive(s, 10).data]).toEqual([6]);
    });
    test("UDP is initially writable for async notifications", () => {
        const t = table(), s = t.socket(2), events: number[] = [];
        t.configureEvents(s, FD_WRITE, bit => events.push(bit)); expect(events).toEqual([FD_WRITE]);
    });
});
