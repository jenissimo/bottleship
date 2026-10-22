import { afterEach, expect, test } from "bun:test";
import { NativeDirectPlayDiscovery } from "../../src/worker/modules/dpnet/native-wire/discovery";
import { decodeNativeEnumQuery, encodeNativeEnumResponse, type NativeEnumQuery, type NativeEnumResponse } from "../../src/worker/modules/dpnet/native-wire/discovery-codec";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import { LanNetwork, type LanDatagram } from "../../src/worker/net/lan-network";
import { PROTO_UDP, BROADCAST_NODE, decodeDatagram, encodeDatagram, isBroadcastNode } from "../../src/worker/net/netplay-wire";
const live: NativeDirectPlayDiscovery[] = [], networks: LanNetwork[] = [];
afterEach(() => { for (const p of live.splice(0)) p.close(); for (const n of networks.splice(0)) n.attach(null); });
const application = "1234567890abcdef1234567890abcdef";
function pair() {
    const nets = [1, 2].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, n))); networks.push(...nets);
    for (const net of nets) net.attach({ send(frame) {
        const p = decodeDatagram(frame)!;
        for (const other of nets) if (other !== net && (other.isSelf(p.node) || isBroadcastNode(p.node)))
            other.receiveFrame(encodeDatagram(p.proto, net.node, p.dstPort, p.srcPort, p.payload));
        return true;
    }, close() {} });
    const provider = new NativeDirectPlayDiscovery(nets[0], 7); live.push(provider);
    return { client: nets[0], host: nets[1], provider };
}
function response(query: NativeEnumQuery, patch: Partial<NativeEnumResponse> = {}): Uint8Array {
    return encodeNativeEnumResponse({ token: query.token, application, instance: "a".repeat(32), flags: 1, maxPlayers: 7, players: 2,
        name: "Нативная", password: null, reserved: new Uint8Array(), applicationData: Uint8Array.of(3, 5, 7), data: Uint8Array.of(0, 9), ...patch });
}
test("two LAN nodes exchange only binary native discovery, preserve query bytes and response endpoint", async () => {
    const { client, host, provider } = pair(); let responses = 0;
    host.bind(2308, { deliver(dg) {
        const query = decodeNativeEnumQuery(dg.data)!; expect([...query.data]).toEqual([8, 0, 7]); expect(query.application).toBe(application);
        expect(host.send(2308, dg.srcNode, dg.srcPort, response(query), PROTO_UDP)).toBe(true);
    } }, PROTO_UDP);
    const input = Uint8Array.of(8, 0, 7), target = host.node.slice();
    const operation = provider.discover({ node: target, port: 2308, application, data: input, count: 2, interval: 1, timeout: 1,
        onResponse(packet, from, latency) { responses++; expect(packet.name).toBe("Нативная"); expect([...packet.data]).toEqual([0, 9]); expect(from.node).toEqual(host.node); expect(from.port).toBe(2308); expect(latency).toBeGreaterThanOrEqual(0); } });
    input.fill(0); target.fill(0);
    expect(await operation.done).toBe(DPN.OK); expect(responses).toBe(2); expect(provider.pending).toBe(0); expect(client.stats.sent).toBe(2);
});
test("unknown tokens, other applications, wrong source and malformed responses never enter a query", async () => {
    const { host, provider } = pair(); let received: LanDatagram | undefined, seen = 0;
    host.bind(2308, { deliver(dg) { received = dg; } }, PROTO_UDP);
    const op = provider.discover({ node: host.node, port: 2308, application, count: 1, timeout: 10, onResponse() { seen++; } });
    const query = decodeNativeEnumQuery(received!.data)!;
    const deliver = (data: Uint8Array, srcNode = host.node, srcPort = 2308) => provider.deliver({ data, srcNode, srcPort });
    deliver(response(query, { token: query.token ^ 1 })); deliver(response(query, { application: "f".repeat(32) }));
    deliver(response(query), Uint8Array.of(2, 0, 0, 0, 0, 3)); deliver(response(query), host.node, 2309);
    deliver(response(query).subarray(0, 48)); deliver(response(query), host.node, NaN);
    expect(seen).toBe(0); deliver(response(query)); expect(seen).toBe(1);
    expect(await op.done).toBe(DPN.OK); deliver(response(query)); expect(seen).toBe(1);
});
test("wildcard broadcast accepts multiple source ports; DPNSVR replies may use a host socket", async () => {
    const { host, provider } = pair(); const ports: number[] = [];
    host.bind(6073, { deliver(dg) { const query = decodeNativeEnumQuery(dg.data)!; expect(query.application).toBeNull();
        for (const port of [2302, 2303]) host.send(port, dg.srcNode, dg.srcPort, response(query), PROTO_UDP);
    } }, PROTO_UDP);
    const wildcard = provider.discover({ node: BROADCAST_NODE, port: 6073, application: null, count: 1, timeout: 1, onResponse(_p, from) { ports.push(from.port); } });
    expect(await wildcard.done).toBe(0); expect(ports).toEqual([2302, 2303]); ports.length = 0;
    const directed = provider.discover({ node: host.node, port: 6073, application: null, count: 1, timeout: 1, onResponse(_p, from) { ports.push(from.port); } });
    expect(await directed.done).toBe(0); expect(ports).toEqual([2302, 2303]);
});
test("synchronous response cancellation, explicit cancel and transport failure settle once and retain no timers", async () => {
    const { client, host, provider } = pair();
    let op = provider.discover({ node: host.node, port: 2308, application, count: 1, timeout: 0xffffffff, onResponse() {} });
    op.cancel(); op.cancel(); expect(await op.done).toBe(DPN.USERCANCEL); expect(provider.pending).toBe(0);
    op = provider.discover({ node: host.node, port: 2308, application, timeout: 0xffffffff, onResponse() {} });
    client.setConnected(false); expect(await op.done).toBe(DPN.NOCONNECTION);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() {} }).done).toBe(DPN.NOCONNECTION);
    client.setConnected(true);
    host.bind(2308, { deliver(dg) { host.send(2308, dg.srcNode, dg.srcPort, response(decodeNativeEnumQuery(dg.data)!), PROTO_UDP); } }, PROTO_UDP);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() { provider.close(); } }).done).toBe(DPN.USERCANCEL);
    expect(provider.pending).toBe(0); expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() {} }).done).toBe(DPN.UNINITIALIZED);
});
test("bounded query admission, callback pressure and thrown callback report errors without dropping active state", async () => {
    const { host, provider } = pair();
    const ops = Array.from({ length: 64 }, () => provider.discover({ node: host.node, port: 2308, application, count: 1, timeout: 0xffffffff, onResponse() {} }));
    expect(provider.pending).toBe(64);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() {} }).done).toBe(DPN.TABLEFULL);
    for (const op of ops) op.cancel(); expect(await Promise.all(ops.map(o => o.done))).toEqual(Array(64).fill(DPN.USERCANCEL));
    host.bind(2308, { deliver(dg) { host.send(2308, dg.srcNode, dg.srcPort, response(decodeNativeEnumQuery(dg.data)!), PROTO_UDP); } }, PROTO_UDP);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse: () => false }).done).toBe(DPN.TABLEFULL);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() { throw Error("guest callback refused"); } }).done).toBe(DPN.GENERIC);
    expect(provider.pending).toBe(0);
});
test("discovery socket ports are exclusive, bounded and reusable after close", () => {
    const { client, provider } = pair(); expect(provider.port).toBe(2302);
    for (let i = 2303; i <= 2400; i++) { const p = new NativeDirectPlayDiscovery(client); live.push(p); expect(p.port).toBe(i); }
    expect(() => new NativeDirectPlayDiscovery(client)).toThrow("No DirectPlay");
    provider.close(); const replacement = new NativeDirectPlayDiscovery(client); live.push(replacement); expect(replacement.port).toBe(2302);
});

test("a busy UDP carrier is retried as packet loss, while a replaced binding fails the old provider", async () => {
    const { client, host, provider } = pair(); let attempts = 0, seen = 0;
    client.attach({ send(frame) { if (++attempts === 1) return false; const p = decodeDatagram(frame)!; host.receiveFrame(encodeDatagram(p.proto, client.node, p.dstPort, p.srcPort, p.payload)); return true; }, close() {} });
    host.bind(2308, { deliver(dg) { host.send(2308, dg.srcNode, dg.srcPort, response(decodeNativeEnumQuery(dg.data)!), PROTO_UDP); } }, PROTO_UDP);
    const op = provider.discover({ node: host.node, port: 2308, application, count: 2, interval: 1, timeout: 1, onResponse() { seen++; } });
    expect(await op.done).toBe(DPN.OK); expect(attempts).toBe(2); expect(seen).toBe(1);
    client.reset(); expect(client.bind(provider.port, { deliver() {} }, PROTO_UDP)).toBe(true);
    expect(await provider.discover({ node: host.node, port: 2308, application, onResponse() {} }).done).toBe(DPN.NOCONNECTION);
});
