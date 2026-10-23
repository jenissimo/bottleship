import { afterEach, expect, test } from "bun:test";
import fixture from "./fixtures/directplay8-native-mesh.json";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeDirectPlayHost, type NativeHostDecision } from "../../src/worker/modules/dpnet/native-wire/host";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { DN, decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { decodeNativeCoreConnectInfo, encodeNativeCoreConnectInfo, encodeNativePlayerConnect, NativeCoreSnapshotCapacityError } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { decodeNativeCoreOperation, nativeCoreWords } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import { DPN } from "../../src/worker/modules/dpnet/constants";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const raw = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const baseline = decodeNativeCoreConnectInfo(raw(fixture.messages.find(m => m.core === 0xc2 && m.target === 2)!.payload))!;
const PEER1_BYTES = 600 * 1024, PEER2_BYTES = 500 * 1024, CORE_BOUND = 1024 * 1024;
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}
async function turns() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function until(check: () => boolean, label: string) {
    const deadline = performance.now() + 2500;
    while (!check()) {
        if (performance.now() >= deadline) throw Error("Capacity scenario progress deadline: " + label);
        await Bun.sleep(1);
    }
}
function same(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, i) => value === b[i]); }
interface Peer {
    role: number;
    link: NativeReliableLink;
    core: Uint8Array[];
    user: Uint8Array[];
    c1Bytes: number;
}
function scene(options: { heldReturn?: ReturnType<typeof gate>; returnFailure?: Error; url?: (role: number) => string } = {}) {
    const networks = [0, 1, 2, 3].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 32, 0, 40 + n)));
    const peers = new Map<number, Peer>(), events: string[] = [];
    const releaseCounts = [0, 0, 0, 0], returnCounts = [0, 0, 0, 0], fragments = [0, 0, 0, 0];
    const host = new NativeDirectPlayHost(networks[0]);
    let application = { ...baseline.application, maxPlayers: 4, reserved: new Uint8Array(), applicationData: new Uint8Array() };
    const port = (role: number) => fixture.ports[0] + role;
    for (const [source, network] of networks.entries()) {
        network.attach({
            send(frame) {
                const packet = decodeDatagram(frame);
                if (!packet || packet.proto !== PROTO_UDP) return false;
                const target = networks.findIndex(n => n.node.every((v, i) => v === packet.node[i]));
                if (target < 0 || packet.srcPort !== port(source) || packet.dstPort !== port(target)) return false;
                if (source && decodeNativeProtocolFrame(packet.payload)?.kind === "data") fragments[source]++;
                networks[target].receiveFrame(encodeDatagram(packet.proto, network.node, packet.dstPort, packet.srcPort, packet.payload));
                return true;
            },
            close() {},
        });
    }
    const start = (instance = baseline.application.instance) => {
        application = { ...application, instance };
        return host.start({
            port: port(0), application, player: { name: "host", data: Uint8Array.of(0) },
            url: address => {
                const role = address.node[5] - 40;
                return options.url?.(role) ?? "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0." + (role + 1) + ";port=" + address.port;
            },
            allowIncoming: address => networks.slice(1).some(n => n.node.every((v, i) => v === address.node[i])),
            timeout: 3000, retryInterval: 25,
            admit: request => {
                const role = request.address.node[5] - 40;
                events.push("admit" + role);
                return {
                    hr: DPN.OK, data: Uint8Array.of(role, 0x5a), context: role,
                    release() { releaseCounts[role]++; events.push("release" + role); },
                };
            },
            replyReleased: (decision: NativeHostDecision) => {
                const role = Number(decision.context);
                returnCounts[role]++; events.push("return-begin" + role);
                if (role === 2 && options.returnFailure) return Promise.reject(options.returnFailure);
                if (role === 2 && options.heldReturn) return options.heldReturn.promise.then(() => { events.push("return-end" + role); });
                events.push("return-end" + role);
            },
        });
    };
    const connect = async (role: number, bytes: number) => {
        const peer: Peer = { role, link: undefined!, core: [], user: [], c1Bytes: 0 };
        peer.link = new NativeReliableLink({
            timeout: 3000, retryInterval: 25,
            send: data => networks[role].send(port(role), networks[0].node, port(0), data, PROTO_UDP),
            onMessage: message => {
                if (message.command & DN.USER1) {
                    peer.core.push(message.payload.slice());
                    if (decodeNativeCoreConnectInfo(message.payload)) void peer.link.sendReliable(nativeCoreWords(0xc3));
                } else peer.user.push(message.payload.slice());
            },
        });
        peers.set(role, peer);
        expect(networks[role].bind(port(role), { deliver: packet => peer.link.receive(packet.data) }, PROTO_UDP)).toBe(true);
        expect(await peer.link.connect()).toBe(DPN.OK);
        const data = new Uint8Array(bytes); data.fill(0x40 + role);
        const c1 = encodeNativePlayerConnect({
            flags: 4, version: 2, instance: application.instance, application: application.application,
            name: "peer" + role, data, password: application.password, connectData: new Uint8Array(), url: null, alternate: new Uint8Array(),
        });
        peer.c1Bytes = c1.length;
        expect(c1.length).toBeLessThanOrEqual(CORE_BOUND);
        expect(await peer.link.sendReliable(c1)).toBe(DPN.OK);
        await turns();
        return peer;
    };
    const packets = (peer: Peer, command: number) => peer.core.filter(bytes => decodeNativeCoreOperation(bytes)?.command === command);
    const snapshot = (peer: Peer) => peer.core.map(decodeNativeCoreConnectInfo).find(value => !!value)!;
    const connected = async (peer: Peer) => {
        await until(() => packets(peer, 0xc6).length > 0, "actual C2/C3/C6 peer" + peer.role);
        const table = snapshot(peer);
        expect(table).toBeDefined();
        expect(table.entries.find(e => e.id === table.localId)?.data.length).toBe(peer.role === 1 ? PEER1_BYTES : 16);
        return table;
    };
    const traffic = async (peer: Peer, peerId: number, nonce: number) => {
        const down = Uint8Array.of(0x90, nonce, 0x22, 0x17), up = Uint8Array.of(0x91, nonce, 0x33, 0x18);
        expect(await host.sendDpn(peerId, 8, down)).toBe(DPN.OK);
        await until(() => peer.user.some(data => same(data, down)), "Host-to-peer actual payload");
        expect(await peer.link.sendReliable(up, 0)).toBe(DPN.OK);
        await until(() => host.queue.some(message => message.from === peerId && same(message.data, up)), "peer-to-Host actual payload");
        host.removeMessage(host.queue.findIndex(message => message.from === peerId && same(message.data, up)));
    };
    closes.push(() => {
        host.dispose();
        for (const peer of peers.values()) peer.link.close();
        for (const network of networks) network.attach(null);
        options.heldReturn?.release();
    });
    return { host, networks, peers, events, releaseCounts, returnCounts, fragments, start, connect, connected, packets, snapshot, traffic, port };
}

test("precommit C2 capacity refusal preserves established authority, real survivor traffic, and the next wire version", async () => {
    const s = scene(); expect(s.start()).toBe(DPN.OK);
    const first = await s.connect(1, PEER1_BYTES), firstTable = await s.connected(first);
    expect(first.core.find(bytes => decodeNativeCoreConnectInfo(bytes))!.length).toBeLessThanOrEqual(CORE_BOUND);
    const firstId = firstTable.localId, hostId = s.host.localId;
    const version = decodeNativeCoreOperation(s.packets(first, 0xc6)[0])!.version;
    await s.traffic(first, firstId, 1);
    const refused = await s.connect(2, PEER2_BYTES);
    expect(PEER1_BYTES + PEER2_BYTES).toBeGreaterThan(CORE_BOUND);
    expect(s.fragments[1]).toBeGreaterThan(400);
    expect(s.fragments[2]).toBeGreaterThan(400);
    // These are external authority/transport predicates, not private allocation or helper assertions.
    expect(s.host.isHost).toBe(true);
    expect(s.host.localId).toBe(hostId);
    expect(s.host.currentPlayers).toBe(2);
    expect([...s.host.entities.keys()].sort()).toEqual([hostId, firstId].sort());
    expect(s.networks[0].isBound(s.port(0), PROTO_UDP)).toBe(true);
    await until(() => s.packets(refused, 0xc5).length === 1, "one bounded C5 resource refusal");
    expect(refused.core.some(bytes => !!decodeNativeCoreConnectInfo(bytes))).toBe(false);
    expect(s.packets(refused, 0xc6)).toHaveLength(0);
    expect([...new Uint32Array(s.packets(refused, 0xc5)[0].slice().buffer)]).toEqual([0xc5, DPN.DATATOOLARGE, 0, 0]);
    expect(s.packets(first, 0xd0)).toHaveLength(0);
    expect(s.packets(first, 0xd1)).toHaveLength(0);
    expect(s.returnCounts[2]).toBe(1); expect(s.releaseCounts[2]).toBe(1);
    await s.traffic(first, firstId, 2);
    const next = await s.connect(3, 16), nextTable = await s.connected(next);
    expect(nextTable.version).toBe(version + 1);
    expect(nextTable.entries.map(entry => entry.name)).toEqual(["host", "peer1", "peer3"]);
    expect(nextTable.entries.find(entry => entry.id === firstId)?.data.length).toBe(PEER1_BYTES);
    expect(decodeNativeCoreOperation(s.packets(first, 0xd0)[0])).toMatchObject({ id: nextTable.localId, version: version + 1 });
    expect(decodeNativeCoreOperation(s.packets(first, 0xc6).at(-1)!)).toMatchObject({ id: nextTable.localId, version: version + 2 });
    await s.traffic(first, firstId, 3);
    s.host.close();
    expect(s.host.pendingAdmissions).toBe(0); expect(s.host.retainedAdmissionBytes).toBe(0);
    expect(s.host.pendingBytes).toBe(0); expect(s.networks[0].isBound(s.port(0), PROTO_UDP)).toBe(false);
}, 10000);

test("capacity C5 waits for actual owned RETURN_BUFFER while the old peer continues exchanging payloads", async () => {
    const heldReturn = gate(), s = scene({ heldReturn }); expect(s.start()).toBe(DPN.OK);
    const first = await s.connect(1, PEER1_BYTES), firstTable = await s.connected(first);
    const refused = await s.connect(2, PEER2_BYTES);
    expect(s.host.isHost).toBe(true);
    expect(s.returnCounts[2]).toBe(1); expect(s.releaseCounts[2]).toBe(0);
    expect(s.packets(refused, 0xc5)).toHaveLength(0);
    expect(refused.core.some(bytes => !!decodeNativeCoreConnectInfo(bytes))).toBe(false);
    await s.traffic(first, firstTable.localId, 4);
    heldReturn.release();
    await until(() => s.packets(refused, 0xc5).length === 1 && s.releaseCounts[2] === 1, "RETURN_BUFFER release then C5");
    expect(s.events.filter(event => event === "return-begin2")).toHaveLength(1);
    expect(s.events.filter(event => event === "return-end2")).toHaveLength(1);
    expect(s.returnCounts[2]).toBe(1); expect(s.releaseCounts[2]).toBe(1);
    expect(s.packets(refused, 0xc5)[0].length).toBe(16);
    await turns(); expect(s.packets(refused, 0xc5)).toHaveLength(1);
    await s.traffic(first, firstTable.localId, 5);
}, 10000);

test("Close/restart during held capacity cleanup cannot publish an old-epoch C5 or resurrect old membership", async () => {
    const heldReturn = gate(), s = scene({ heldReturn }); expect(s.start()).toBe(DPN.OK);
    const first = await s.connect(1, PEER1_BYTES); await s.connected(first);
    const refused = await s.connect(2, PEER2_BYTES);
    expect(s.host.isHost).toBe(true); expect(s.returnCounts[2]).toBe(1);
    expect(s.packets(refused, 0xc5)).toHaveLength(0);
    s.host.close();
    const nextInstance = (baseline.application.instance.startsWith("ff") ? "ee" : "ff") + baseline.application.instance.slice(2);
    expect(s.start(nextInstance)).toBe(DPN.OK);
    const fresh = await s.connect(3, 16), table = await s.connected(fresh);
    expect(table.application.instance).toBe(nextInstance);
    expect(table.version).toBe(3);
    heldReturn.release(); await turns();
    expect(s.returnCounts[2]).toBe(1); expect(s.releaseCounts[2]).toBe(1);
    expect(s.packets(refused, 0xc5)).toHaveLength(0);
    expect(fresh.core.map(bytes => decodeNativeCoreOperation(bytes)?.command ?? 0xc2)).toEqual([0xc2, 0xc6]);
    expect(table.entries.map(entry => entry.name)).toEqual(["host", "peer3"]);
    expect(s.host.currentPlayers).toBe(2);
    expect(s.host.pendingAdmissions).toBe(0); expect(s.host.retainedAdmissionBytes).toBe(0);
    await s.traffic(fresh, table.localId, 6);
}, 10000);

test("a C2 capacity result does not mask invalid snapshot fields or a different C1 envelope error", () => {
    const oversizedEntries = baseline.entries.map((entry, i) => ({ ...entry, data: i === 0 ? new Uint8Array(CORE_BOUND) : entry.data }));
    let overflow: unknown;
    try { encodeNativeCoreConnectInfo({ ...baseline, entries: oversizedEntries }); } catch (error) { overflow = error; }
    expect(overflow).toBeInstanceOf(NativeCoreSnapshotCapacityError);
    expect((overflow as NativeCoreSnapshotCapacityError).size).toBeGreaterThan(CORE_BOUND);
    let invalidField: unknown;
    try { encodeNativeCoreConnectInfo({ ...baseline, localId: Number.NaN, entries: oversizedEntries }); } catch (error) { invalidField = error; }
    expect(invalidField).toBeInstanceOf(RangeError);
    expect(invalidField).not.toBeInstanceOf(NativeCoreSnapshotCapacityError);
    let differentEnvelope: unknown;
    try {
        encodeNativePlayerConnect({ flags: 4, version: 2, application: baseline.application.application, instance: baseline.application.instance,
            name: null, password: null, url: null, data: new Uint8Array(CORE_BOUND), connectData: new Uint8Array(), alternate: new Uint8Array() });
    } catch (error) { differentEnvelope = error; }
    expect(differentEnvelope).toBeInstanceOf(RangeError);
    expect(differentEnvelope).not.toBeInstanceOf(NativeCoreSnapshotCapacityError);
});

test("an unrelated provider RangeError is not converted into a C5 local output-quota refusal", async () => {
    const s = scene({ url: role => {
        if (role === 2) throw new RangeError("provider callback failed independently of snapshot size");
        return "x-directplay:/hostname=127.0.0.1;port=" + (fixture.ports[0] + role);
    } });
    expect(s.start()).toBe(DPN.OK);
    const first = await s.connect(1, PEER1_BYTES); await s.connected(first);
    const refused = await s.connect(2, PEER2_BYTES);
    await turns();
    expect(s.releaseCounts[2]).toBe(1);
    expect(s.packets(refused, 0xc5)).toHaveLength(0);
    expect(s.host.pendingAdmissions).toBe(0);
    expect(s.host.retainedAdmissionBytes).toBe(0);
    // No assertion claims the current infrastructure exception policy is native behavior.
}, 10000);

test("RETURN_BUFFER owner Promise rejection is distinct from a completed callback and from the C2 quota result", async () => {
    const s = scene({ returnFailure: Error("owner callback task discarded") }); expect(s.start()).toBe(DPN.OK);
    const first = await s.connect(1, PEER1_BYTES); await s.connected(first);
    const refused = await s.connect(2, PEER2_BYTES);
    await turns();
    expect(s.returnCounts[2]).toBe(1);
    expect(s.releaseCounts[2]).toBe(1);
    expect(s.packets(refused, 0xc5)).toHaveLength(0);
    expect(s.host.pendingAdmissions).toBe(0);
    expect(s.host.retainedAdmissionBytes).toBe(0);
    // This is infrastructure failure, not the numeric HRESULT returned by a native guest handler.
}, 10000);
