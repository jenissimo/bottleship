import { expect, test } from "bun:test";
import { RootNetworkNamespace, ChildProcessNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable, ipv4Address } from "../../src/worker/modules/wsa-network";
import { DirectPlay8Session } from "../../src/worker/modules/dpnet/peer";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";
import { createLanServer } from "../../packages/lan/src/server";

async function until(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("LAN delivery deadline");
        await Bun.sleep(5);
    }
}

test("loopback resolves against the current identity without aliasing 10.0.0.1", () => {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 9, 0, 2));
    for (const ip of [[127, 0, 0, 1], [127, 3, 4, 5]]) {
        expect(network.routeIpv4(Uint8Array.from(ip))).toEqual(network.node);
    }
    expect(network.routeIpv4(Uint8Array.of(10, 0, 0, 1))).toEqual(Uint8Array.of(2, 0, 0, 0, 0, 1));
    expect(network.isSelf(network.routeIpv4(Uint8Array.of(10, 0, 0, 1)))).toBe(false);
    expect(() => network.routeIpv4(Uint8Array.of(127))).toThrow(RangeError);
    const route = network.routeIpv4(Uint8Array.of(127, 0, 0, 1));
    route.fill(0);
    expect([...network.ipv4]).toEqual([10, 9, 0, 2]);
    network.adoptIdentity(Uint8Array.of(2, 0, 0, 9, 0, 3));
    expect(network.routeIpv4(Uint8Array.of(127, 0, 0, 1))).toEqual(network.node);
    network.configureGatewayAddresses([[127, 0, 0, 1]]);
    expect(network.routeIpv4(Uint8Array.of(127, 0, 0, 1))).toEqual(Uint8Array.of(2, 1, 127, 0, 0, 1));
    expect(network.routeIpv4(Uint8Array.of(127, 3, 4, 5))).toEqual(network.node);
});

test("UDP to 10.0.0.1 crosses the relay while loopback stays local on the same port", async () => {
    const relay = createLanServer({ port: 0 });
    const port = await relay.listen();
    const local = new LanNetwork(Uint8Array.of(2, 0, 0, 9, 0, 2));
    const remote = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 1));
    const roots = [new RootNetworkNamespace(local, 8), new RootNetworkNamespace(remote, 8)];
    const tables = [new WsaSocketTable(local), new WsaSocketTable(remote)];
    try {
        const config = { serverUrl: "http://127.0.0.1:" + port, room: "loopback-routing" };
        await Promise.all(roots.map(root => root.configure(config)));
        expect([...remote.ipv4]).toEqual([10, 0, 0, 1]);
        const [a, b] = tables.map(table => {
            const socket = table.socket(2);
            table.bind(socket, ipv4Address(new Uint8Array(4), 27910));
            return socket;
        });
        const sender = tables[0].socket(2);
        tables[0].sendto(sender, Uint8Array.of(42), ipv4Address(remote.ipv4, 27910));
        await until(() => tables[1].readable(b));
        expect(tables[0].readable(a)).toBe(false);
        expect(tables[1].receive(b, 8).data).toEqual(Uint8Array.of(42));
        tables[0].sendto(sender, Uint8Array.of(43), ipv4Address(Uint8Array.of(127, 0, 0, 1), 27910));
        await until(() => tables[0].readable(a));
        const packet = tables[0].receive(a, 8);
        expect(packet.data).toEqual(Uint8Array.of(43));
        expect(packet.from.ip).toEqual(Uint8Array.of(127, 0, 0, 1));
        expect(tables[1].readable(b)).toBe(false);
    } finally {
        tables.forEach(table => table.reset());
        await Promise.all(roots.map(root => root.close()));
        await relay.close();
    }
}, 10000);

test("DirectPlay child loopback discovery uses the adopted namespace identity", async () => {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 9, 0, 2));
    const root = new RootNetworkNamespace(network, 8);
    const lease = root.createChild();
    const child = new LanNetwork();
    const namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const host = new DirectPlay8Session(child, "peer"), client = new DirectPlay8Session(child, "peer");
    const desc: SessionDesc = { instance: "0".repeat(32), application: "b".repeat(32), flags: 0,
        maxPlayers: 8, name: "loopback", password: "", user: [0, 0, 0, 0],
        extended: { flags: 0, reserved: [], application: [] } };
    try {
        expect(host.initialize()).toBe(0);
        expect(client.initialize()).toBe(0);
        expect(host.bindPort(23913)).toBe(0);
        expect(host.host(desc)).toBe(0);
        const provider = (client as any).virtualProvider;
        expect(provider.discoverAt(desc.application, { node: [...child.routeIpv4(Uint8Array.of(127, 0, 0, 1))], port: 23913 })).toBe(0);
        await until(() => provider.discovered.size === 1);
        const found = [...provider.discovered.values()][0] as { desc: SessionDesc };
        expect(await client.connect(found.desc)).toBe(0);
        expect(client.localId).toBeGreaterThan(0);
    } finally {
        client.dispose(); host.dispose();
        namespace.close(); lease.close(); await root.close();
    }
}, 10000);
