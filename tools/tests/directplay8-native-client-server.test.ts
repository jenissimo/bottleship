// Source-derived native Client/Server primary, promoted after peer-history gate7003.
// This uses the real binary carrier and public Session backend seam, not a native
// Windows capture or an executed COM-ABI proof. The first measured failure is
// recorded separately; completing this test alone cannot establish full parity.
//
// Current evidence: plan/D2-native-client-server-scope-note-cop.md
// SHA256 prefix57ad75bfb56e4486. peer.ts8350bcaad714588d:204-208 rejects
// role server before provider preparation. This must be the first primary RED;
// it must not be converted into a connect timeout or a synthetic C2 success.
//
// Public target: Server-role Session Host(CLIENT_SERVER) accepts a native provider;
// a separately constructed real NativeCore client then connects over the binary
// channel. The continuation does not prescribe C2/CF shape, mesh behavior,
// player callback presentation/order, migration, or a peer history protocol.
// Those wire/callback contracts require the pending Client/Server source oracle.
// This Session role is the public backend seam, not an executed COM-ABI proof.

import { expect, test } from "bun:test";
import { LanNetwork, nodeToIpv4 } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { DirectPlay8Session } from "../../src/worker/modules/dpnet/peer";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";

test("a public native Server hosts CLIENT_SERVER before a real binary Client connects", async () => {
    const nets = [71, 72].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, n)));
    const frames: { from: number; data: Uint8Array }[] = [], protocols: number[] = [];
    for (const [from, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!;
        const to = nets.findIndex(other => other.node.every((n, i) => n === d.node[i]));
        if (to < 0) return false;
        protocols.push(d.proto);
        if (decodeNativeProtocolFrame(d.payload)) frames.push({ from, data: d.payload.slice() });
        nets[to].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload));
        return true;
    }, close() {} });
    const server = new DirectPlay8Session(nets[0], "server");
    const client = new NativeDirectPlayCore(nets[1], "client", 500, 2);
    const application: SessionDesc = {
        instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "Native Client Server", password: "", maxPlayers: 2, flags: 0,
        user: [0, 0, 0, 0], extended: { flags: 1, reserved: [], application: [] },
    };
    let preparations = 0;
    server.onEvent = event => event.processed?.();
    server.onNativeIndicate = () => ({ hr: DPN.OK });
    try {
        expect(server.initialize()).toBe(DPN.OK);
        expect(await server.setInfo(0, { name: "Server", data: [0x53], flags: 0 }, 3)).toBe(DPN.OK);
        const hosted = await server.hostNative(application, 0xc101, { prepare: async request => {
            preparations++;
            return {
                address: request.localAddress,
                allowIncoming: address => address.node.every((n, i) => n === nets[1].node[i]),
                url: address => "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=" +
                    [...nodeToIpv4(Uint8Array.from(address.node))].join(".") + ";port=" + address.port,
                release() {},
            };
        } }, 2308, [20, 0, 2, 14, 500]);

        // FIRST decisive contract: current role guard returns UNSUPPORTED here.
        // No Client connect, fabricated packet, private role flip or timeout
        // precedes this assertion. Native provider preparation is also still0.
        expect(hosted).toBe(DPN.OK);

        // Prospective public continuation, not an independently certified wire
        // transcript. Root must finish the Client/Server oracle before a fix.
        expect(preparations).toBe(1);
        expect(server.role).toBe("server");
        expect(server.engine.kind).toBe("native");
        expect(server.virtualProvider.desc).toBeNull();
        expect(client.role).toBe("client");
        expect(await client.connect({ node: [...nets[0].node], port: 2308 }, application,
            { name: { short: "Client", long: "" }, data: [0x43], flags: 0 },
            Uint8Array.of(0x43, 0, 0x53))).toBe(DPN.OK);
        expect(client.openError).toBe(DPN.OK);
        expect(frames.some(frame => frame.from === 0)).toBe(true);
        expect(frames.some(frame => frame.from === 1)).toBe(true);
        expect(protocols.length).toBeGreaterThan(0);
        expect(protocols.every(proto => proto === PROTO_UDP)).toBe(true);
    } finally {
        client.dispose();
        server.dispose();
        nets.forEach(net => net.attach(null));
    }
});

// NT5 source profile controls: real Server authority and two independent native
// Client carriers. These are HLE component proofs, not native COM observations.
// callback-return fences are explicit; connect() alone must not release Client
// user receives. Full DestroyClient/Terminate and held general player destruction
// remain separate contracts.
import { DN } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { decodeNativeCoreConnectInfo, decodeNativePlayerConnect } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { NativeHostBackend } from "../../src/worker/modules/dpnet/native-wire/host-backend";
import type { DirectPlay8Event } from "../../src/worker/modules/dpnet/peer";

const serverTurns = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setTimeout(resolve, 0)); };
type ServerWire = { from: number; to: number; command: number; data: Uint8Array; };
const coreCommand = (row: ServerWire): number => row.command & DN.USER1 && row.data.length >= 4 ?
    new DataView(row.data.buffer, row.data.byteOffset, row.data.length).getUint32(0, true) : -1;
function clientServerScene(maxPlayers = 3) {
    const nets = [81, 82, 83].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, n)));
    const wire: ServerWire[] = [], protocols: number[] = [];
    for (const [from, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!;
        const to = nets.findIndex(other => other.node.every((n, i) => n === d.node[i]));
        if (to < 0) return false;
        protocols.push(d.proto);
        const decoded = decodeNativeProtocolFrame(d.payload);
        if (decoded?.kind === "data") wire.push({ from, to, command: decoded.command, data: decoded.payload.slice() });
        nets[to].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload));
        return true;
    }, close() {} });
    const server = new DirectPlay8Session(nets[0], "server");
    const clients = [new NativeDirectPlayCore(nets[1], "client", 500, 2), new NativeDirectPlayCore(nets[2], "client", 500, 2)];
    const events: DirectPlay8Event[] = [], replies: Uint8Array[] = [], admissions: number[] = [];
    let sink: (event: DirectPlay8Event) => void = event => { event.processed?.(); };
    let preparations = 0, releases = 0, urlCalls = 0, decisionReleases = 0;
    let lost!: (reason: { code: number; message: string }) => void;
    const closed = new Promise<{ code: number; message: string }>(resolve => { lost = resolve; });
    const application: SessionDesc = {
        instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "Two real Clients", password: "", maxPlayers, flags: 0, user: [0, 0, 0, 0],
        extended: { flags: 1, reserved: [0x91, 0x92], application: [0xa1, 0xa2] },
    };
    server.onEvent = event => { events.push(event); sink(event); };
    server.onNativeIndicate = request => {
        const node = request.address.node[5]; admissions.push(node);
        const reply = Uint8Array.of(0xc2, node, request.info.connectData[0]); replies.push(reply);
        return { hr: DPN.OK, context: 0xd000 + node, data: reply, release() { decisionReleases++; } };
    };
    const provider = { prepare: async (request: import("../../src/worker/modules/dpnet/backend").DirectPlay8HostRequest) => {
        preparations++;
        return {
            address: request.localAddress, closed,
            allowIncoming: (address: import("../../src/worker/modules/dplayx/session").Address) =>
                nets.slice(1).some(net => address.node.every((n, i) => n === net.node[i])),
            url() { urlCalls++; throw Error("Client/Server snapshot must not ask for peer URLs"); },
            release() { releases++; },
        };
    } };
    return {
        nets, server, clients, wire, protocols, events, replies, admissions, application, provider,
        get preparations() { return preparations; }, get releases() { return releases; },
        get decisionReleases() { return decisionReleases; }, get urlCalls() { return urlCalls; },
        setSink(next: typeof sink) { sink = next; },
        loseProvider() { lost({ code: 73, message: "owned test provider lost" }); },
        async host() {
            expect(server.initialize()).toBe(DPN.OK);
            expect(server.setInfo(0, { name: "Authority", data: [0x53, 0x30], flags: 0 }, 3)).toBe(DPN.OK);
            expect(await server.hostNative(application, 0xc101, provider, 2308, [20, 0, 2, 14, 500])).toBe(DPN.OK);
        },
        async join(index: number, release = true) {
            const client = clients[index];
            const result = await client.connect({ node: [...nets[0].node], port: 2308 }, application,
                { name: { short: index ? "Client B" : "Client A", long: "" }, data: [0x40 + index], flags: 0 },
                Uint8Array.of(0x70 + index));
            expect(result).toBe(DPN.OK);
            const lease = client.connectCompletionLease();
            expect(lease?.current()).toBe(true);
            // Enter the modeled notification before allowing its eventual return.
            lease!.enter();
            // This call models the public notification's actual return. The
            // connect Promise itself is deliberately insufficient.
            if (release) lease!.complete();
            await serverTurns();
            return lease!;
        },
        version() { return (server.engine as NativeHostBackend).host as unknown as { version: number }; },
        dispose() {
            clients.forEach(client => client.dispose());
            server.dispose(); nets.forEach(net => net.attach(null));
        },
    };
}

test("native Server C2 names only Server and target, while its authoritative count includes both Clients", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients;
        const c1 = s.wire.filter(row => row.from !== 0 && coreCommand(row) === 0xc1).map(row => decodeNativePlayerConnect(row.data)!);
        const c2 = s.wire.filter(row => row.from === 0 && coreCommand(row) === 0xc2).map(row => ({ to: row.to, info: decodeNativeCoreConnectInfo(row.data)! }));
        expect(c1.map(info => info.flags)).toEqual([2, 2]);
        expect(c1.map(info => [...info.connectData])).toEqual([[0x70], [0x71]]);
        expect(c2.map(row => row.to)).toEqual([1, 2]);
        expect(c2.map(row => row.info.entries.map(entry => entry.flags))).toEqual([[0x402, 0x200], [0x402, 0x200]]);
        expect(c2.map(row => row.info.entries.map(entry => entry.id))).toEqual([[s.server.localId, a.localId], [s.server.localId, b.localId]]);
        expect(c2.map(row => row.info.entries.map(entry => entry.url))).toEqual([[null, null], [null, null]]);
        expect(c2.map(row => row.info.members)).toEqual([[], []]);
        expect(c2.map(row => row.info.application.flags)).toEqual([1, 1]);
        expect(c2.map(row => row.info.application.players)).toEqual([2, 3]);
        expect(c2.map(row => [...row.info.reply])).toEqual([[0xc2, 82, 0x70], [0xc2, 83, 0x71]]);
        s.replies.forEach(reply => reply.fill(0xee));
        expect([...a.joinReply!.data!]).toEqual([0xc2, 82, 0x70]);
        expect([...b.joinReply!.data!]).toEqual([0xc2, 83, 0x71]);
        expect([...a.entities.keys()].sort((x, y) => x - y)).toEqual([s.server.localId, a.localId].sort((x, y) => x - y));
        expect([...b.entities.keys()].sort((x, y) => x - y)).toEqual([s.server.localId, b.localId].sort((x, y) => x - y));
        expect(a.hostId).toBe(s.server.localId); expect(b.hostId).toBe(s.server.localId);
        expect(s.server.engine.currentPlayers).toBe(3);
        expect(s.server.engine.desc!.extended!.flags).toBe(1);
        expect(s.events.filter(event => event.type === 7).map(event => [event.id, event.context])).toEqual([
            [s.server.localId, 0xc101], [a.localId, 0xd052], [b.localId, 0xd053],
        ]);
        expect(s.wire.filter(row => [0xd0, 0xc6, 0xc9, 0xca].includes(coreCommand(row)))).toEqual([]);
        expect(s.wire.some(row => row.from !== 0 && row.to !== 0)).toBe(false);
        expect(s.urlCalls).toBe(0); expect(s.decisionReleases).toBe(2);
        expect(s.protocols.every(proto => proto === PROTO_UDP)).toBe(true);
    } finally { s.dispose(); }
}, 15000);

test("two native Clients exchange exact tagged payloads only with Server, without sibling delivery", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients; s.events.length = 0; s.wire.length = 0;
        const aToHost = Uint8Array.of(0xa0, 0, 0xa1), bToHost = Uint8Array.of(0xb0, 0, 0xb1);
        expect(await a.sendDpn(0, 8, aToHost)).toBe(DPN.OK);
        expect(await b.sendDpn(0, 8, bToHost)).toBe(DPN.OK);
        aToHost.fill(0xee); bToHost.fill(0xee);
        expect(s.events.filter(event => event.type === 0x11).map(event => [event.id, event.context, [...event.data!], event.flags])).toEqual([
            [a.localId, 0xd052, [0xa0, 0, 0xa1], 1], [b.localId, 0xd053, [0xb0, 0, 0xb1], 1],
        ]);
        expect(a.queue).toEqual([]); expect(b.queue).toEqual([]);
        const hostToA = Uint8Array.of(0x53, 0x41), hostToB = Uint8Array.of(0x53, 0x42);
        expect(await s.server.send(a.localId, 8, hostToA)).toBe(DPN.OK);
        expect(await s.server.send(b.localId, 8, hostToB)).toBe(DPN.OK);
        hostToA.fill(0xee); hostToB.fill(0xee);
        expect(a.queue.map(message => [message.from, message.to, [...message.data]])).toEqual([[0, a.localId, [0x53, 0x41]]]);
        expect(b.queue.map(message => [message.from, message.to, [...message.data]])).toEqual([[0, b.localId, [0x53, 0x42]]]);
        expect(s.wire.some(row => row.from !== 0 && row.to !== 0)).toBe(false);
        expect(s.server.engine.currentPlayers).toBe(3);
    } finally { s.dispose(); }
}, 15000);

test("Server CREATE actual return gates that Client's RECEIVE and COMPLETEONPROCESS", async () => {
    const s = clientServerScene();
    let create: DirectPlay8Event | undefined;
    try {
        await s.host();
        s.setSink(event => {
            if (event.type === 7 && event.context === 0xd052) { create = event; return; }
            event.processed?.();
        });
        await s.join(0); await s.join(1);
        const [a, b] = s.clients, completions: number[] = [];
        expect(await b.sendDpn(0, 8, Uint8Array.of(0x42, 0x30))).toBe(DPN.OK);
        expect(create?.id).toBe(a.localId);
        expect(create?.isCurrent?.()).toBe(true);
        const completion = a.sendDpn(0, 0xc, Uint8Array.of(0xe0, 0x41)).then(hr => { completions.push(hr); return hr; });
        await serverTurns();
        expect(s.events.filter(event => event.type === 0x11).map(event => [event.id, [...event.data!]])).toEqual([[b.localId, [0x42, 0x30]]]);
        expect(completions).toEqual([]);
        expect(s.wire.filter(row => row.from === 0 && coreCommand(row) === 0xe1)).toEqual([]);
        s.server.contexts.set(a.localId, 0xface);
        create!.processed!();
        expect(s.events.filter(event => event.type === 0x11).map(event => [event.id, event.context, [...event.data!]])).toEqual([
            [b.localId, 0xd053, [0x42, 0x30]], [a.localId, 0xface, [0xe0, 0x41]],
        ]);
        expect(await completion).toBe(DPN.OK);
        create!.processed!();
        expect(completions).toEqual([DPN.OK]);
        expect(s.events.filter(event => event.type === 7 && event.id === a.localId)).toHaveLength(1);
        expect(s.events.filter(event => event.type === 0x11 && event.id === a.localId)).toHaveLength(1);
    } finally { s.dispose(); }
}, 15000);

test("Client original completion lease gates raw and E0 receives until explicit notification return", async () => {
    const s = clientServerScene();
    try {
        await s.host();
        const lease = await s.join(0, false), a = s.clients[0], completions: number[] = [];
        expect(a.connectCompletionLease()).toBe(lease);
        expect(await s.server.send(a.localId, 8, Uint8Array.of(0x41, 0x31))).toBe(DPN.OK);
        const completion = Promise.resolve(s.server.send(a.localId, 0xc, Uint8Array.of(0x41, 0x32))).then(hr => { completions.push(hr); return hr; });
        await serverTurns();
        expect(a.queue).toEqual([]); expect(completions).toEqual([]);
        lease.complete();
        expect(a.queue.map(message => [message.from, message.to, [...message.data]])).toEqual([
            [0, a.localId, [0x41, 0x31]], [0, a.localId, [0x41, 0x32]],
        ]);
        expect(completions).toEqual([]);
        const processed = a.queue[1].processed!; a.removeMessage(1); a.removeMessage(0); processed();
        expect(await completion).toBe(DPN.OK);
        lease.complete(); processed(); await serverTurns();
        expect(a.queue).toEqual([]); expect(completions).toEqual([DPN.OK]); expect(lease.current()).toBe(false);
    } finally { s.dispose(); }
}, 15000);

test("Client metadata ACK targets only its requester; Server SetInfo is locally silent and reaches both Clients", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, aInfo: number[] = [], bInfo: number[] = [];
        a.onInfo = (id, returned) => { aInfo.push(id); returned(); };
        b.onInfo = (id, returned) => { bInfo.push(id); returned(); };
        s.events.length = 0; s.wire.length = 0;
        const done: number[] = [];
        const result = await a.mutate({ op: "mutate", action: "info", id: a.localId,
            name: { short: "A changed" }, data: [0x41, 0x32], completed: (reply: { hr: number }) => done.push(reply.hr) });
        expect(result.hr).toBe(DPN.OK); expect(done).toEqual([DPN.OK]);
        expect(s.server.engine.entities.get(a.localId)!.name.short).toBe("A changed");
        expect(s.server.engine.entities.get(a.localId)!.data).toEqual([0x41, 0x32]);
        expect(s.events.filter(event => event.type === 4).map(event => [event.id, event.context])).toEqual([[a.localId, 0xd052]]);
        expect(s.wire.filter(row => coreCommand(row) === 0xdb).map(row => [row.from, row.to])).toEqual([[0, 1]]);
        // Connected Client SetInfo requests authority; neither preapply nor ACK
        // reapply is a public local getter contract, and ACK emits no own info.
        expect(aInfo).toEqual([]); expect(bInfo).toEqual([]);
        s.events.length = 0; s.wire.length = 0;
        expect(await s.server.setInfo(s.server.localId, { name: "Authority changed", data: [0x53, 0x32], flags: 0 }, 3)).toBe(DPN.OK);
        await serverTurns();
        expect(s.events.filter(event => [4, 0x10, 0x15].includes(event.type))).toEqual([]);
        expect(s.wire.filter(row => coreCommand(row) === 0xdb).map(row => [row.from, row.to])).toEqual([[0, 1], [0, 2]]);
        expect(a.entities.get(s.server.localId)!.name.short).toBe("Authority changed");
        expect(b.entities.get(s.server.localId)!.data).toEqual([0x53, 0x32]);
        expect(aInfo).toEqual([s.server.localId]); expect(bInfo).toEqual([s.server.localId]);
        expect(s.wire.filter(row => [0xc9, 0xca].includes(coreCommand(row)))).toEqual([]);
    } finally { s.dispose(); }
}, 15000);

test("Server normal Client retirement leaves sibling carrier usable, sends no D1, and versions after notification", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, aId = a.localId, before = s.version().version, during: number[] = [], nested: number[] = [];
        s.events.length = 0; s.wire.length = 0;
        s.setSink(event => {
            if (event.type === 9 && event.id === aId) {
                during.push(s.version().version);
                nested.push(Number(s.server.setInfo(s.server.localId, { name: "Still Server", data: [0x53], flags: 0 }, 3)));
                during.push(s.version().version);
            }
            event.processed?.();
        });
        expect(await a.shutdown()).toBe(DPN.OK); await serverTurns();
        expect(s.events.filter(event => event.type === 9).map(event => [event.id, event.context, event.reason])).toEqual([[aId, 0xd052, 1]]);
        expect(nested).toEqual([DPN.OK]); expect(during).toEqual([before, before + 1]);
        expect(s.version().version).toBe(before + 2);
        expect(s.server.engine.currentPlayers).toBe(2);
        expect(s.server.engine.entities.has(aId)).toBe(false);
        expect(s.wire.filter(row => coreCommand(row) === 0xd1)).toEqual([]);
        expect(b.openError).toBe(DPN.OK);
        expect(await b.sendDpn(0, 8, Uint8Array.of(0x42, 0x53))).toBe(DPN.OK);
        expect(s.events.filter(event => event.type === 0x11).map(event => [event.id, [...event.data!]])).toEqual([[b.localId, [0x42, 0x53]]]);
        // General held DESTROY_PLAYER/query/refcount semantics are not asserted here.
    } finally { s.dispose(); }
}, 15000);

test("provider loss retires original processing ownership once and late Client processing cannot revive it", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const a = s.clients[0], results: number[] = [];
        const completion = Promise.resolve(s.server.send(a.localId, 0xc, Uint8Array.of(0x50, 0x31))).then(hr => { results.push(hr); return hr; });
        await serverTurns();
        expect(a.queue.map(message => [...message.data])).toEqual([[0x50, 0x31]]);
        expect(results).toEqual([]);
        const processed = a.queue[0].processed!;
        s.loseProvider(); await serverTurns();
        expect(await completion).toBe(DPN.CONNECTIONLOST);
        expect(s.server.engine.openError).toBe(DPN.CONNECTIONLOST); expect(s.server.engine.desc).toBeNull();
        expect(s.releases).toBe(1);
        processed(); processed(); await serverTurns();
        expect(results).toEqual([DPN.CONNECTIONLOST]);
        s.server.close(); expect(s.releases).toBe(1);
    } finally { s.dispose(); }
}, 15000);

test("Server Close cancels held CREATE queue and stale callback return cannot publish the old owner", async () => {
    const s = clientServerScene();
    let create: DirectPlay8Event | undefined;
    try {
        await s.host();
        s.setSink(event => {
            if (event.type === 7 && event.id !== s.server.localId) { create = event; return; }
            event.processed?.();
        });
        await s.join(0);
        expect(await s.clients[0].sendDpn(0, 8, Uint8Array.of(0x48, 0x31))).toBe(DPN.OK);
        expect(s.events.filter(event => event.type === 0x11)).toEqual([]);
        expect(create?.isCurrent?.()).toBe(true);
        expect(s.server.close()).toBe(DPN.OK);
        create!.processed!(); create!.processed!(); await serverTurns();
        expect(create!.isCurrent!()).toBe(false);
        expect(s.events.filter(event => event.type === 0x11)).toEqual([]);
        expect(s.server.engine.desc).toBeNull(); expect(s.server.engine.queue).toEqual([]);
        expect(s.releases).toBe(1);
    } finally { s.dispose(); }
}, 15000);

test("Server rejects peer role before admission and enforces shared player count before application callback", async () => {
    const s = clientServerScene(2);
    const peer = new NativeDirectPlayCore(s.nets[2], "peer", 500, 2);
    try {
        await s.host();
        expect(await peer.connect({ node: [...s.nets[0].node], port: 2308 }, s.application,
            { name: { short: "Wrong peer", long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.INVALIDINTERFACE);
        expect(s.admissions).toEqual([]); peer.dispose();
        await s.join(0);
        const b = s.clients[1];
        expect(await b.connect({ node: [...s.nets[0].node], port: 2308 }, s.application,
            { name: { short: "Full Client", long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.SESSIONFULL);
        expect(s.admissions).toEqual([82]);
        expect(s.server.engine.currentPlayers).toBe(2);
        expect(s.events.filter(event => event.type === 7)).toHaveLength(2);
        expect(s.urlCalls).toBe(0);
    } finally { peer.dispose(); s.dispose(); }
}, 15000);

test("Server held CREATE FIFO keeps reentrant same-Client receive behind the original queued tail", async () => {
    const s = clientServerScene();
    let create: DirectPlay8Event | undefined;
    const nested: Promise<number>[] = [], nestedWireDuring: number[] = [];
    try {
        await s.host();
        s.setSink(event => {
            if (event.type === 7 && event.context === 0xd052) { create = event; return; }
            event.processed?.();
        });
        await s.join(0);
        const a = s.clients[0];
        expect(await a.sendDpn(0, 8, Uint8Array.of(0x31))).toBe(DPN.OK);
        expect(await a.sendDpn(0, 8, Uint8Array.of(0x32))).toBe(DPN.OK);
        expect(s.events.filter(event => event.type === 0x11)).toEqual([]);
        s.setSink(event => {
            if (event.type === 0x11 && event.data![0] === 0x31) {
                // A real send during first RECEIVE reenters the same authenticated
                // carrier. It must join behind the already-held second message.
                nested.push(a.sendDpn(0, 8, Uint8Array.of(0x33)));
                nestedWireDuring.push(s.wire.filter(row => row.from === 1 && !(row.command & DN.USER1) &&
                    row.data.length === 1 && row.data[0] === 0x33).length);
            }
            event.processed?.();
        });
        create!.processed!();
        const actual = s.events.filter(event => event.type === 0x11).map(event => [event.id, [...event.data!]]);
        expect(nestedWireDuring).toEqual([1]);
        expect(actual).toEqual([[a.localId, [0x31]], [a.localId, [0x32]], [a.localId, [0x33]]]);
        expect(nested).toHaveLength(1); expect(await nested[0]).toBe(DPN.OK);
        create!.processed!();
        expect(s.events.filter(event => event.type === 0x11)).toHaveLength(3);
    } finally { s.dispose(); }
}, 15000);

test("held Server CLIENT_INFO retains its original version tail after requester normal close", async () => {
    const s = clientServerScene();
    let info: DirectPlay8Event | undefined;
    const originalResults: number[] = [];
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, aId = a.localId;
        const lastC2 = s.wire.filter(row => row.from === 0 && row.to === 2 && coreCommand(row) === 0xc2).at(-1)!;
        const before = decodeNativeCoreConnectInfo(lastC2.data)!.version;
        s.events.length = 0; s.wire.length = 0;
        s.setSink(event => {
            if (event.type === 4 && event.id === aId) { info = event; return; }
            event.processed?.();
        });
        const original = Promise.resolve(a.mutate({ op: "mutate", action: "info", id: aId,
            name: { short: "A held info" }, data: [0x41, 0x48] })).then(reply => { originalResults.push(reply.hr); return reply; });
        await serverTurns();
        expect(info?.id).toBe(aId);
        expect(s.server.engine.entities.get(aId)!.name.short).toBe("A held info");
        expect(s.wire.filter(row => coreCommand(row) === 0xdb)).toEqual([]);
        expect(originalResults).toEqual([]);
        expect(await a.shutdown()).toBe(DPN.OK);
        expect((await original).hr).not.toBe(DPN.OK);
        expect(s.server.engine.entities.has(aId)).toBe(false);
        // An independent request is not globally frozen by A's held callback.
        expect((await b.mutate({ op: "mutate", action: "info", id: b.localId, data: [0x42, 0x31] })).hr).toBe(DPN.OK);
        const beforeReturn = s.wire.filter(row => coreCommand(row) === 0xdb);
        expect(beforeReturn.map(row => [row.to, new DataView(row.data.buffer, row.data.byteOffset).getUint32(8, true)])).toEqual([[2, before + 2]]);
        info!.processed!();
        // No packet is redirected to a sibling on behalf of the retired requester.
        expect(s.wire.filter(row => coreCommand(row) === 0xdb)).toHaveLength(1);
        expect((await b.mutate({ op: "mutate", action: "info", id: b.localId, data: [0x42, 0x32] })).hr).toBe(DPN.OK);
        const actual = s.wire.filter(row => coreCommand(row) === 0xdb);
        expect(actual.map(row => [row.to, new DataView(row.data.buffer, row.data.byteOffset).getUint32(8, true)])).toEqual([[2, before + 2], [2, before + 4]]);
        info!.processed!();
        expect(s.events.filter(event => event.type === 4 && event.id === aId)).toHaveLength(1);
        expect(originalResults).toHaveLength(1);
        expect(s.server.engine.currentPlayers).toBe(2);
    } finally { s.dispose(); }
}, 15000);

test("native Server creates a local group without publishing peer D7 to either Client", async () => {
    const s = clientServerScene();
    const localCreates: { id: number | undefined; owner: number | undefined; context: number | undefined; }[] = [];
    const actualReturns: number[] = [];
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, beforePlayers = s.server.engine.currentPlayers;
        s.events.length = 0; s.wire.length = 0;
        s.setSink(event => {
            if (event.type === 6) {
                localCreates.push({ id: event.id, owner: event.owner, context: event.context });
                event.processed?.();
                actualReturns.push(event.id!);
            } else event.processed?.();
        });
        const created = await s.server.createGroup({ name: "Local Server group",
            data: [0x67, 0, 0x31], flags: 0 }, 0xc601);
        const group = created.id ?? 0;
        // Real ordered user data follows creation on each original reliable
        // Host->Client channel. Observe both Client queues as well as ACK results;
        // no sleep or private history/table mutation substitutes for delivery.
        const barrierResults = await Promise.all([
            Promise.resolve(s.server.send(a.localId, 8, Uint8Array.of(0x53, 0x47, 0x41))),
            Promise.resolve(s.server.send(b.localId, 8, Uint8Array.of(0x53, 0x47, 0x42))),
        ]);
        const actual = {
            hr: created.hr, group, localCreates: [...localCreates], actualReturns: [...actualReturns],
            barrierResults,
            a: a.queue.map(message => [message.from, message.to, [...message.data]]),
            b: b.queue.map(message => [message.from, message.to, [...message.data]]),
            d7: s.wire.filter(row => row.from === 0 && (row.to === 1 || row.to === 2) && coreCommand(row) === 0xd7)
                .map(row => ({ to: row.to, command: coreCommand(row), bytes: [...row.data] })),
            aHasGroup: a.entities.has(group), bHasGroup: b.entities.has(group),
        };

        // Prerequisites distinguish a real completed local create and both live
        // recipient channels from an empty capture caused by failed acquisition.
        expect(actual.hr).toBe(DPN.OK); expect(actual.group).not.toBe(0);
        expect(actual.localCreates).toEqual([{ id: group, owner: 0, context: 0xc601 }]);
        expect(actual.actualReturns).toEqual([group]);
        expect(actual.barrierResults).toEqual([DPN.OK, DPN.OK]);
        expect(actual.a).toEqual([[0, a.localId, [0x53, 0x47, 0x41]]]);
        expect(actual.b).toEqual([[0, b.localId, [0x53, 0x47, 0x42]]]);

        // FIRST DECISIVE SOURCE CONTRACT: source Server has no Peer D7 branch.
        expect(actual.d7).toEqual([]);
        expect(actual.aHasGroup).toBe(false); expect(actual.bHasGroup).toBe(false);
        expect(s.server.groupEntity(group)?.group).toBe(true);
        expect(s.server.groupContexts.get(group)).toBe(0xc601);
        expect(s.server.engine.currentPlayers).toBe(beforePlayers);
    } finally { s.dispose(); }
}, 15000);


test("Server local group membership and destruction retain callbacks, versions and real member delivery without Peer publications", async () => {
    const s = clientServerScene();
    let group = 0, phase = "";
    let heldAdd: DirectPlay8Event | undefined, heldRemove: DirectPlay8Event | undefined;
    let implicitRemove: DirectPlay8Event | undefined, heldDestroy: DirectPlay8Event | undefined;
    const members: { type: number; player: number | undefined; groupContext: number | undefined; playerContext: number | undefined; members: number[]; version: number; }[] = [];
    const destroyed: { context: number | undefined; reason: number | undefined; name: string | undefined; data: number[] | undefined; version: number; }[] = [];
    const completed: [string, number][] = [];
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, players = s.server.engine.currentPlayers;
        const created = await s.server.createGroup({ name: "Server members", data: [0x67, 0x32], flags: 0 }, 0xc602);
        expect(created.hr).toBe(DPN.OK); group = created.id!;
        const creationVersion = s.version().version;
        s.server.groupContexts.set(group, 0xc6aa);
        s.server.contexts.set(a.localId, 0xda01); s.server.contexts.set(b.localId, 0xdb01);
        s.events.length = 0;
        s.setSink(event => {
            if ((event.type === 1 || event.type === 0x12) && event.id === group) {
                members.push({ type: event.type, player: event.player, groupContext: event.groupContext,
                    playerContext: event.playerContext, members: [...s.server.groupEntity(group)!.members].sort((x, y) => x - y),
                    version: s.version().version });
                if (phase === "add") { heldAdd = event; return; }
                if (phase === "remove") { heldRemove = event; return; }
                if (phase === "destroy") { implicitRemove = event; return; }
            }
            if (event.type === 8 && event.id === group) {
                const retained = s.server.groupEntity(group);
                destroyed.push({ context: event.context, reason: event.reason, name: retained?.name.short,
                    data: retained?.data.slice(), version: s.version().version });
                heldDestroy = event; return;
            }
            event.processed?.();
        });

        phase = "add";
        const adding = s.server.beginMember(group, a.localId, true, reply => completed.push(["add", reply.hr]));
        expect(members).toEqual([{ type: 1, player: a.localId, groupContext: 0xc6aa, playerContext: 0xda01,
            members: [a.localId], version: creationVersion + 1 }]);
        expect(completed).toEqual([]);
        heldAdd!.processed!();
        expect(completed).toEqual([["add", DPN.OK]]);
        expect((await adding).hr).toBe(DPN.OK);
        phase = "";
        expect(await s.server.member(group, b.localId, true)).toBe(DPN.OK);
        expect(members[1]).toEqual({ type: 1, player: b.localId, groupContext: 0xc6aa, playerContext: 0xdb01,
            members: [a.localId, b.localId].sort((x, y) => x - y), version: creationVersion + 2 });
        expect(await s.server.send(group, 8, Uint8Array.of(0x67, 0x41, 0x42))).toBe(DPN.OK);
        expect(a.queue.map(message => [message.from, [...message.data]])).toEqual([[0, [0x67, 0x41, 0x42]]]);
        expect(b.queue.map(message => [message.from, [...message.data]])).toEqual([[0, [0x67, 0x41, 0x42]]]);
        a.removeMessage(0); b.removeMessage(0);

        phase = "remove";
        const removing = s.server.beginMember(group, a.localId, false, reply => completed.push(["remove", reply.hr]));
        expect(members[2]).toEqual({ type: 0x12, player: a.localId, groupContext: 0xc6aa, playerContext: 0xda01,
            members: [b.localId], version: creationVersion + 3 });
        expect(completed).toEqual([["add", DPN.OK]]);
        heldRemove!.processed!();
        expect((await removing).hr).toBe(DPN.OK);
        expect(completed).toEqual([["add", DPN.OK], ["remove", DPN.OK]]);
        expect(await s.server.send(group, 8, Uint8Array.of(0x67, 0x42))).toBe(DPN.OK);
        expect(a.queue).toEqual([]);
        expect(b.queue.map(message => [message.from, [...message.data]])).toEqual([[0, [0x67, 0x42]]]);
        b.removeMessage(0);

        phase = "destroy";
        s.server.groupContexts.set(group, 0xc6ee); s.server.contexts.set(b.localId, 0xdb02);
        const deleting = s.server.beginDestroyGroup(group, reply => completed.push(["destroy", reply.hr]));
        expect(members[3]).toEqual({ type: 0x12, player: b.localId, groupContext: 0xc6ee, playerContext: 0xdb02,
            members: [], version: creationVersion + 3 });
        expect(destroyed).toEqual([]);
        expect(completed).toEqual([["add", DPN.OK], ["remove", DPN.OK]]);
        implicitRemove!.processed!();
        expect(destroyed).toEqual([{ context: 0xc6ee, reason: 1, name: "Server members", data: [0x67, 0x32], version: creationVersion + 3 }]);
        expect(s.server.groupEntity(group)?.name.short).toBe("Server members");
        expect(completed).toEqual([["add", DPN.OK], ["remove", DPN.OK]]);
        heldDestroy!.processed!();
        expect((await deleting).hr).toBe(DPN.OK);
        expect(completed).toEqual([["add", DPN.OK], ["remove", DPN.OK], ["destroy", DPN.OK]]);
        expect(s.version().version).toBe(creationVersion + 4);
        expect(s.server.groupEntity(group)).toBeUndefined();
        expect(s.server.groupContexts.has(group)).toBe(false);
        heldAdd!.processed!(); heldRemove!.processed!(); implicitRemove!.processed!(); heldDestroy!.processed!();
        expect(members).toHaveLength(4); expect(destroyed).toHaveLength(1); expect(completed).toHaveLength(3);

        // Live delivery to both original recipients orders any already-published
        // reliable group operation before these independently observed payloads.
        expect(await s.server.send(a.localId, 8, Uint8Array.of(0x53, 0x47, 0x31))).toBe(DPN.OK);
        expect(await s.server.send(b.localId, 8, Uint8Array.of(0x53, 0x47, 0x32))).toBe(DPN.OK);
        expect(a.queue.map(message => [...message.data])).toEqual([[0x53, 0x47, 0x31]]);
        expect(b.queue.map(message => [...message.data])).toEqual([[0x53, 0x47, 0x32]]);
        expect(s.wire.filter(row => row.from === 0 && [0xd7, 0xd8, 0xd9, 0xda].includes(coreCommand(row)))).toEqual([]);
        expect(a.entities.has(group)).toBe(false); expect(b.entities.has(group)).toBe(false);
        expect(s.server.engine.currentPlayers).toBe(players);
    } finally { s.dispose(); }
}, 15000);

test("later native Client C2 omits existing Server groups and memberships while group data still targets real members", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0);
        const [a, b] = s.clients;
        const created = await s.server.createGroup({ name: "Before second Client", data: [0x67, 0x33], flags: 0 }, 0xc603);
        expect(created.hr).toBe(DPN.OK);
        const group = created.id!;
        expect(await s.server.member(group, a.localId, true)).toBe(DPN.OK);
        expect(s.server.engine.currentPlayers).toBe(2);
        await s.join(1);
        const c2 = s.wire.filter(row => row.from === 0 && row.to === 2 && coreCommand(row) === 0xc2);
        expect(c2).toHaveLength(1);
        const actual = decodeNativeCoreConnectInfo(c2[0].data)!;
        expect(actual.entries.map(entry => [entry.id, entry.flags, entry.url])).toEqual([
            [s.server.localId, 0x402, null], [b.localId, 0x200, null],
        ]);
        expect(actual.members).toEqual([]);
        expect(actual.application.players).toBe(3); expect(actual.application.flags).toBe(1);
        expect(b.entities.has(group)).toBe(false);
        expect([...s.server.groupEntity(group)!.members]).toEqual([a.localId]);
        expect(await s.server.send(group, 8, Uint8Array.of(0x67, 0x41))).toBe(DPN.OK);
        expect(a.queue.map(message => [...message.data])).toEqual([[0x67, 0x41]]);
        expect(b.queue).toEqual([]);
        a.removeMessage(0);
        expect(await s.server.member(group, b.localId, true)).toBe(DPN.OK);
        expect(await s.server.send(group, 8, Uint8Array.of(0x67, 0x41, 0x42))).toBe(DPN.OK);
        expect(a.queue.map(message => [...message.data])).toEqual([[0x67, 0x41, 0x42]]);
        expect(b.queue.map(message => [...message.data])).toEqual([[0x67, 0x41, 0x42]]);
        expect(s.wire.filter(row => row.from === 0 && [0xd7, 0xd8, 0xd9, 0xda].includes(coreCommand(row)))).toEqual([]);
        expect(a.entities.has(group)).toBe(false); expect(b.entities.has(group)).toBe(false);
        expect(s.server.groupEntity(group)?.group).toBe(true);
        expect(s.server.engine.currentPlayers).toBe(3);
    } finally { s.dispose(); }
}, 15000);


test("Server group SetInfo publishes exact DB to both Clients without acquiring unknown group metadata or version", async () => {
    const s = clientServerScene(), infoCalls: [number, number][] = [], groupCalls: [number, number][] = [], changeCalls: number[] = [];
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients;
        const c2 = s.wire.filter(row => row.from === 0 && coreCommand(row) === 0xc2)
            .map(row => ({ to: row.to, info: decodeNativeCoreConnectInfo(row.data)! }));
        const clientVersions = [c2.find(row => row.to === 1)!.info.version, c2.find(row => row.to === 2)!.info.version];
        const before = c2.find(row => row.to === 2)!.info.version;
        const created = await s.server.createGroup({ name: "Before DB", data: [0x67], flags: 0 }, 0xc604);
        expect(created.hr).toBe(DPN.OK);
        const group = created.id!;
        expect([s.server.localId, a.localId, b.localId]).not.toContain(group);
        expect(a.entities.has(group)).toBe(false); expect(b.entities.has(group)).toBe(false);
        for (const [index, client] of s.clients.entries()) {
            client.onInfo = (id, returned) => { infoCalls.push([index, id]); returned(); };
            client.onGroupCreated = (id, returned) => { groupCalls.push([index, id]); returned(); };
            client.onChange = () => { changeCalls.push(index); };
        }
        s.events.length = 0; s.wire.length = 0;
        const data = [0x6b, 0, 0x6c];
        const result = await s.server.setInfo(group, { name: "SG", data, flags: 0 }, 3);
        data.fill(0xee);
        const barriers = await Promise.all([
            Promise.resolve(s.server.send(a.localId, 8, Uint8Array.of(0x44, 0x42, 0x41))),
            Promise.resolve(s.server.send(b.localId, 8, Uint8Array.of(0x44, 0x42, 0x42))),
        ]);
        const db = s.wire.filter(row => row.from === 0 && coreCommand(row) === 0xdb);
        const versions = s.clients.map(client => (client as unknown as { version: number }).version);

        // Independent literal vector: message.h198-209 is ten DWORDs, followed
        // by CPackedBuffer name-then-data tail packing (request2838-2877).
        // Offsets exclude the command DWORD: data40/3, UTF16 name43/6.
        const expected = new Uint8Array(53), view = new DataView(expected.buffer);
        [0xdb, group, before + 2, 0, 3, 43, 6, 40, 3, s.server.localId, 0]
            .forEach((word, index) => view.setUint32(index * 4, word, true));
        expected.set([0x6b, 0, 0x6c], 44); expected.set([0x53, 0, 0x47, 0, 0, 0], 47);

        expect(result).toBe(DPN.OK);
        expect(barriers).toEqual([DPN.OK, DPN.OK]);
        expect(a.queue.map(message => [message.from, message.to, [...message.data]])).toEqual([[0, a.localId, [0x44, 0x42, 0x41]]]);
        expect(b.queue.map(message => [message.from, message.to, [...message.data]])).toEqual([[0, b.localId, [0x44, 0x42, 0x42]]]);
        expect(db.map(row => [row.to, [...row.data]])).toEqual([[1, [...expected]], [2, [...expected]]]);
        expect(infoCalls).toEqual([]); expect(groupCalls).toEqual([]); expect(changeCalls).toEqual([]);
        expect(a.entities.has(group)).toBe(false); expect(b.entities.has(group)).toBe(false);
        expect([...a.entities.keys()].sort((x, y) => x - y)).toEqual([s.server.localId, a.localId].sort((x, y) => x - y));
        expect([...b.entities.keys()].sort((x, y) => x - y)).toEqual([s.server.localId, b.localId].sort((x, y) => x - y));
        // DNProcessUpdateInfo3853-3858 rejects the unknown group before3892:
        // independently observed original C2 versions must remain unchanged.
        expect(versions).toEqual(clientVersions);
        expect(s.events.filter(event => event.type === 0xc)).toEqual([]);
        expect(s.server.groupEntity(group)!.name.short).toBe("SG");
        expect(s.server.groupEntity(group)!.data).toEqual([0x6b, 0, 0x6c]);
        expect(s.server.groupContexts.get(group)).toBe(0xc604);
        expect(s.server.engine.currentPlayers).toBe(3);
        expect(s.wire.filter(row => [0xd7, 0xd8, 0xd9, 0xda, 0xc9, 0xca].includes(coreCommand(row)))).toEqual([]);
    } finally { s.dispose(); }
}, 15000);

test("native Server DestroyClient delivers exact reliable DF only to target and preserves sibling", async () => {
    const s = clientServerScene();
    try {
        await s.host(); await s.join(0); await s.join(1);
        const [a, b] = s.clients, aId = a.localId, bId = b.localId;
        const termA: { data: number[]; reason: number | undefined }[] = [];
        const termB: { data: number[]; reason: number | undefined }[] = [];
        a.onTermination = (data, reason) => termA.push({ data: [...data], reason });
        b.onTermination = (data, reason) => termB.push({ data: [...data], reason });
        s.events.length = 0; s.wire.length = 0;
        const input = Uint8Array.of(0x41, 0, 0x7f);

        // First decisive assertion: native HostBackend currently returns UNSUPPORTED.
        expect(s.server.engine.kick(aId, input)).toBe(DPN.OK);
        input.fill(0xee);
        await serverTurns();

        const packets = s.wire.filter(row => row.from === 0 && coreCommand(row) === 0xdf);
        expect(packets.length).toBeGreaterThan(0);
        expect(packets.every(row => row.to === 1 && !!(row.command & DN.RELIABLE))).toBe(true);
        for (const packet of packets) expect([...packet.data]).toEqual([
            0xdf, 0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 0x41, 0, 0x7f,
        ]);
        expect(termA).toEqual([{ data: [0x41, 0, 0x7f], reason: DPN.HOSTTERMINATEDSESSION }]);
        expect(termB).toEqual([]);
        expect(s.events.filter(event => event.type === 9).map(event => [event.id, event.context, event.reason]))
            .toEqual([[aId, 0xd052, 4]]);
        expect(s.server.engine.entities.has(aId)).toBe(false);
        expect(s.server.engine.entities.has(bId)).toBe(true);
        expect(s.server.engine.currentPlayers).toBe(2);
        expect(s.wire.filter(row => coreCommand(row) === 0xd1)).toEqual([]);

        // An ACK and actual payload together prove B survived targeted retirement.
        expect(await b.sendDpn(0, 8, Uint8Array.of(0x42, 0x53))).toBe(DPN.OK);
        expect(s.events.filter(event => event.type === 0x11).map(event => [event.id, [...event.data!]]))
            .toEqual([[bId, [0x42, 0x53]]]);
        expect(await s.server.send(bId, 8, Uint8Array.of(0x53, 0x42))).toBe(DPN.OK);
        expect(b.queue.map(message => [message.from, [...message.data]])).toEqual([[0, [0x53, 0x42]]]);
        expect(termB).toEqual([]);
    } finally { s.dispose(); }
}, 15000);
