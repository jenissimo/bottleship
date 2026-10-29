import { expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { DirectPlay8Session } from "../../src/worker/modules/dpnet/peer";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { NativeHostBackend } from "../../src/worker/modules/dpnet/native-wire/host-backend";
import type { NativeDirectPlayChannel } from "../../src/worker/modules/dpnet/native-wire/channel";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";
import { DPN } from "../../src/worker/modules/dpnet/constants";

// Binary DNET carriers, with explicit component callback returns. This fixture
// does not execute a guest CPU or establish native Windows callback scheduling.
async function terminationScene() {
    const nets = [101, 102, 103].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 1, n)));
    let suppressOldClientPackets = false, suppressed = 0;
    for (const [source, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!;
        const target = nets.findIndex(other => other.node.every((v, i) => v === d.node[i]));
        if (target < 0 || d.proto !== PROTO_UDP) return false;
        if (source === 1 && target === 0 && suppressOldClientPackets) { suppressed++; return true; }
        nets[target].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload));
        return true;
    }, close() {} });
    const application: SessionDesc = {
        instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "termination owners", password: "", maxPlayers: 2, flags: 0,
        user: [0, 0, 0, 0], extended: { flags: 1, reserved: [], application: [] },
    };
    const hosts = [new DirectPlay8Session(nets[0], "server"), new DirectPlay8Session(nets[2], "server")];
    const messages: { host: number; bytes: number[] }[] = [];
    for (const [i, host] of hosts.entries()) {
        host.onEvent = event => {
            if (event.type === 0x11) messages.push({ host: i, bytes: [...event.data!] });
            event.processed?.();
        };
        host.onNativeIndicate = () => ({ hr: DPN.OK });
        expect(host.initialize()).toBe(DPN.OK);
        expect(await host.hostNative(application, 0, { prepare: async request => ({
            address: request.localAddress, allowIncoming: () => true,
            url: () => "x-directplay:/hostname=127.0.0.1;port=2308", release() {},
        }) }, 2308, [20, 0, 2, 14, 500])).toBe(DPN.OK);
    }
    const client = new NativeDirectPlayCore(nets[1], "client", 500, 2);
    const internals = client as unknown as {
        channel?: NativeDirectPlayChannel;
        terminationDrains: Set<unknown>;
    };
    const join = async (hostIndex: number, port = 0) => {
        const target = hostIndex === 0 ? nets[0] : nets[2];
        expect(await client.connect({ node: [...target.node], port: 2308 }, application,
            { name: { short: "Client", long: "" }, data: [], flags: 0 }, new Uint8Array(), port)).toBe(DPN.OK);
        const lease = client.connectCompletionLease(); expect(lease?.current()).toBe(true);
        lease!.enter(); lease!.complete();
    };
    const channelAtHost = (hostIndex: number) => {
        const host = (hosts[hostIndex].engine as NativeHostBackend).host as unknown as {
            connections: Map<string, { id?: number; channel?: NativeDirectPlayChannel }>;
        };
        const channel = [...host.connections.values()].find(c => c.id === client.localId)?.channel;
        expect(channel).toBeDefined(); return channel!;
    };
    return {
        nets, hosts, client, internals, join, channelAtHost, messages,
        suppress() { suppressOldClientPackets = true; },
        get suppressed() { return suppressed; },
        dispose() { client.dispose(); hosts.forEach(host => host.dispose()); nets.forEach(net => net.attach(null)); },
    };
}
const df = () => Uint8Array.of(0xdf, 0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 0x74, 0, 0x71);

test("loss while DF callback is held survives discard and clears original connection exactly once", async () => {
    const s = await terminationScene();
    try {
        await s.join(0);
        const client = s.client, channel = s.internals.channel!, id = client.localId;
        const loss: { data: number[]; reason?: number }[] = [];
        let returned!: (result?: number) => void, entries = 0;
        client.onTermination = (data, reason) => loss.push({ data: [...data], reason });
        client.onNativeTermination = (data, reason, finish) => {
            entries++; expect([...data]).toEqual([0x74, 0, 0x71]);
            expect(reason).toBe(DPN.HOSTTERMINATEDSESSION); returned = finish;
        };
        expect(await s.channelAtHost(0).link.sendReliable(df())).toBe(DPN.OK);
        expect(entries).toBe(1); expect(client.entities.has(id)).toBe(true);
        channel.close(DPN.CONNECTIONLOST);
        expect(client.desc).not.toBeNull(); expect(client.entities.has(id)).toBe(true);
        expect(loss).toEqual([]);

        returned(DPN.USERCANCEL);
        expect(client.desc).toBeNull(); expect(client.entities.size).toBe(0);
        expect(client.openError).toBe(DPN.CONNECTIONLOST);
        expect(loss).toEqual([{ data: [], reason: DPN.CONNECTIONLOST }]);
        returned(); returned(DPN.USERCANCEL);
        expect(loss).toHaveLength(1); expect(entries).toBe(1);
    } finally { s.dispose(); }
}, 15000);

test("Close cancels a detached DF drain and old completion cannot unbind a reconnected client", async () => {
    const s = await terminationScene();
    try {
        await s.join(0);
        const client = s.client, oldChannel = s.internals.channel!, port = client.localAddress.port;
        const oldBinding = s.nets[1].bindingGeneration(port, PROTO_UDP);
        let returned!: (result?: number) => void, entries = 0;
        client.onNativeTermination = (data, reason, finish) => {
            entries++; expect([...data]).toEqual([0x74, 0, 0x71]);
            expect(reason).toBe(DPN.HOSTTERMINATEDSESSION); returned = finish;
            s.suppress(); // Withhold actual client-to-old-Host ACK and END_STREAM.
        };
        void s.channelAtHost(0).link.sendReliable(df());
        expect(entries).toBe(1); expect(s.suppressed).toBeGreaterThan(0);
        returned();
        expect(client.desc).toBeNull(); expect(s.internals.terminationDrains.size).toBe(1);
        expect(s.nets[1].isBound(port, PROTO_UDP)).toBe(true);

        expect(client.close()).toBe(DPN.OK);
        expect(s.internals.terminationDrains.size).toBe(0);
        expect(s.nets[1].isBound(port, PROTO_UDP)).toBe(false);
        await s.join(1, port);
        const newChannel = s.internals.channel!;
        const newBinding = s.nets[1].bindingGeneration(port, PROTO_UDP);
        expect(newChannel).not.toBe(oldChannel); expect(newBinding).not.toBe(oldBinding);
        await oldChannel.closed;
        for (let i = 0; i < 16; i++) await Promise.resolve();
        returned(); // Old completion cannot act on the replacement.
        expect(s.internals.channel).toBe(newChannel);
        expect(s.nets[1].bindingGeneration(port, PROTO_UDP)).toBe(newBinding);
        expect(client.openError).toBe(DPN.OK);
        expect(await client.sendDpn(0, 8, Uint8Array.of(0x4e, 0, 0x57))).toBe(DPN.OK);
        expect(s.messages).toContainEqual({ host: 1, bytes: [0x4e, 0, 0x57] });
        expect(entries).toBe(1);
    } finally { s.dispose(); }
}, 15000);
