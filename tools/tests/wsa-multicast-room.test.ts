import { expect, test } from "bun:test";
import { createLanServer } from "../../packages/lan/src/server";
import { RootNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { createWsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import { ipv4Address } from "../../src/worker/modules/wsa-network";
import { PROTO_UDP, ipv4ToNode } from "../../src/worker/net/netplay-wire";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error("Multicast room delivery timeout"); await wait(2); } }
const group = Uint8Array.of(239, 255, 43, 39), otherGroup = Uint8Array.of(239, 255, 43, 40), port = 48439;
function participant(id: number) {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 29, 39, id));
    const host = new RootNetworkNamespace(network, 8, 29390 + id);
    return { network, host, table: createWsaActorTable(network, () => host.socketActorClient()) };
}
for (const transport of ["websocket", "polling"] as const) test("Winsock multicast membership and physical LOOP compose through actual room relay over " + transport, async () => {
    const server = createLanServer({ port: 0, transports: [transport] }), url = "http://127.0.0.1:" + await server.listen();
    const a = participant(1), b = participant(2), c = participant(3), all = [a, b, c];
    const cleanup: (() => void)[] = [];
    try {
        await Promise.all(all.map((p, i) => p.host.configure({ serverUrl: url, room: i === 2 ? "separate" : "multicast-wsa-" + transport })));
        await Promise.all(all.map(p => p.host.barrier()));
        const receivers = all.map(p => { const sid = p.table.socket(2); p.table.get(sid).reuse = true; p.table.bind(sid, ipv4Address(new Uint8Array(4), port)); return sid; });
        const [ra, rb, rc] = receivers, sender = a.table.socket(2), fence = b.table.socket(2);
        b.table.bind(fence, ipv4Address(new Uint8Array(4), port + 1));
        const observer = b.table.socket(2); b.table.get(observer).reuse = true;
        b.table.bind(observer, ipv4Address(new Uint8Array(4), port));
        b.table.changeMulticastMembership(observer, group, new Uint8Array(4), true);
        const fenceSource = a.network.bindEphemeral({ deliver() {} }, PROTO_UDP);
        expect(fenceSource).toBeGreaterThan(0);
        let drains = 0; const unsubscribe = a.network.onWritable(() => drains++);
        cleanup.push(unsubscribe);
        a.table.changeMulticastMembership(ra, group, new Uint8Array(4), true);
        b.table.changeMulticastMembership(rb, otherGroup, new Uint8Array(4), true);
        c.table.changeMulticastMembership(rc, group, new Uint8Array(4), true);
        const remoteFence = async () => {
            // Broker admission distinguishes rejected UDP from accepted UDP; engine drain
            // fences the next actor submission without retrying an accepted datagram.
            let admittedAt = -1;
            await until(() => {
                const before = drains;
                if (!a.network.send(fenceSource, ipv4ToNode(b.network.ipv4), port + 1, Uint8Array.of(250), PROTO_UDP)) return false;
                admittedAt = before; return true;
            });
            await until(() => b.table.readable(fence)); expect(b.table.receive(fence, 1).data).toEqual(Uint8Array.of(250));
            await until(() => drains > admittedAt);
        };
        await remoteFence();
        const max = Uint8Array.from({ length: 65507 }, (_, i) => (i * 29) & 255);
        expect(a.table.send(sender, max, ipv4Address(group, port))).toBe(max.length);
        await until(() => a.table.readable(ra)); expect(a.table.receive(ra, 65507).data).toEqual(max);
        await until(() => b.table.readable(observer)); expect(b.table.receive(observer, 65507).data).toEqual(max);
        await remoteFence(); expect(b.table.readable(rb)).toBe(false); expect(c.table.readable(rc)).toBe(false);
        b.table.changeMulticastMembership(rb, group, new Uint8Array(4), true);
        a.table.setMulticastOption(ra, 11, 0); b.table.setMulticastOption(rb, 11, 0);
        expect(a.table.send(sender, new Uint8Array(0), ipv4Address(group, port))).toBe(0);
        await until(() => b.table.readable(rb)); const empty = b.table.receive(rb, 65507);
        expect(empty.data.length).toBe(0); expect(empty.from.ip).toEqual(a.network.ipv4); expect(a.table.readable(ra)).toBe(false);
        a.table.setMulticastOption(ra, 11, 1); a.table.setMulticastOption(sender, 10, 0);
        a.table.send(sender, Uint8Array.of(7), ipv4Address(group, port)); await until(() => a.table.readable(ra)); expect(a.table.receive(ra, 1).data).toEqual(Uint8Array.of(7));
        await remoteFence(); expect(b.table.readable(rb)).toBe(false);
        a.table.setMulticastOption(sender, 10, 1); a.table.setMulticastOption(sender, 9, 0x0100007f);
        a.table.changeMulticastMembership(ra, group, Uint8Array.of(127, 0, 0, 1), true);
        a.table.send(sender, Uint8Array.of(8), ipv4Address(group, port)); await until(() => a.table.readable(ra));
        const local = a.table.receive(ra, 1); expect(local.data).toEqual(Uint8Array.of(8)); expect(local.from.ip).toEqual(Uint8Array.of(127, 0, 0, 1));
        await remoteFence(); expect(b.table.readable(rb)).toBe(false); expect(c.table.readable(rc)).toBe(false);
    } finally { for (const stop of cleanup) stop(); for (const p of all) { p.table.reset(); await p.host.close(); } await server.close(); }
}, 20000);
