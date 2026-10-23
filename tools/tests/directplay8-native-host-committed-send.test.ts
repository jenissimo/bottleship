import { afterEach, expect, test } from "bun:test";
import fixture from "./fixtures/directplay8-native-mesh.json";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeDirectPlayHost } from "../../src/worker/modules/dpnet/native-wire/host";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { DN, decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { decodeNativeCoreConnectInfo, encodeNativePlayerConnect } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { decodeNativeCoreOperation, nativeCoreWords } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import { DPN } from "../../src/worker/modules/dpnet/constants";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const reference = decodeNativeCoreConnectInfo(Uint8Array.from(Buffer.from(fixture.messages.find(m => m.core === 0xc2 && m.target === 2)!.payload, "hex")))!;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function until(check: () => boolean, label: string) {
    const deadline = performance.now() + 1500;
    while (!check()) {
        if (performance.now() >= deadline) throw Error("Committed D1 progress deadline: " + label);
        await Bun.sleep(1);
    }
}
interface Peer { role: number; link: NativeReliableLink; core: Uint8Array[]; user: Uint8Array[]; }
function scene(options: { returned?: (role: number) => void | Promise<void>; onChange?: () => void; onAbort?: (role: number) => void; onWire?: (source: number, target: number, data: Uint8Array) => void } = {}) {
    const networks = [0, 1, 2, 3, 4].map(role => new LanNetwork(Uint8Array.of(2, 0, 0, 33, 0, 60 + role)));
    const peers = new Map<number, Peer>(), suppressed = new Set<number>();
    const heldAcknowledgements: Uint8Array[] = [], promises: Promise<number>[] = [];
    const host = new NativeDirectPlayHost(networks[0]);
    const releaseCounts = [0, 0, 0, 0, 0], returnCounts = [0, 0, 0, 0, 0], created: number[] = [];
    host.onChange = () => options.onChange?.();
    const port = (role: number) => fixture.ports[0] + role;
    let application = { ...reference.application, maxPlayers: 4 };
    for (const [source, network] of networks.entries()) network.attach({
        send(frame) {
            const packet = decodeDatagram(frame);
            if (!packet || packet.proto !== PROTO_UDP) return false;
            const target = networks.findIndex(n => n.node.every((value, i) => value === packet.node[i]));
            if (target < 0 || packet.srcPort !== port(source) || packet.dstPort !== port(target)) return false;
            if (target === 0 && suppressed.has(source)) {
                // A bounded lossy carrier withholds real peer ACKs, not the Host reservation API.
                if (decodeNativeProtocolFrame(packet.payload)?.kind === "ack") heldAcknowledgements.push(frame.slice());
                return true;
            }
            networks[target].receiveFrame(encodeDatagram(packet.proto, network.node, packet.dstPort, packet.srcPort, packet.payload));
            options.onWire?.(source, target, packet.payload);
            return true;
        },
        close() {},
    });
    const start = (instance = reference.application.instance) => {
        application = { ...application, instance };
        return host.start({
            port: port(0), application, player: { name: "host", data: Uint8Array.of(0) },
            url: a => "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0." + (a.node[5] - 59) + ";port=" + a.port,
            allowIncoming: a => networks.slice(1).some(n => n.node.every((value, i) => value === a.node[i])),
            timeout: 3000, retryInterval: 25,
            admit: request => { const role = request.address.node[5] - 60;
                request.signal.addEventListener("abort", () => options.onAbort?.(role), { once: true });
                return { hr: DPN.OK, context: role,
                    data: options.returned ? Uint8Array.of(role) : new Uint8Array(), release: () => { releaseCounts[role]++; } }; },
            replyReleased: decision => { const role = Number(decision.context); returnCounts[role]++; return options.returned?.(role); },
            accepted: (_id, context) => { created.push(Number(context)); },
        });
    };
    const packets = (peer: Peer, command: number) => peer.core.filter(data => decodeNativeCoreOperation(data)?.command === command);
    const snapshot = (peer: Peer) => peer.core.map(decodeNativeCoreConnectInfo).find(value => !!value)!;
    const join = async (role: number, awaitC6 = true) => {
        const peer: Peer = { role, link: undefined!, core: [], user: [] };
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
        expect(networks[role].bind(port(role), { deliver: datagram => peer.link.receive(datagram.data) }, PROTO_UDP)).toBe(true);
        expect(await peer.link.connect()).toBe(DPN.OK);
        expect(await peer.link.sendReliable(encodeNativePlayerConnect({
            flags: 4, version: 2, instance: application.instance, application: application.application, name: "peer" + role,
            data: Uint8Array.of(role), password: application.password, connectData: new Uint8Array(), url: null, alternate: new Uint8Array(),
        }))).toBe(DPN.OK);
        if (awaitC6) await until(() => packets(peer, 0xc6).length > 0, "actual C2/C3/C6 peer" + role);
        else await turns();
        return peer;
    };
    const traffic = async (peer: Peer, id: number, nonce: number) => {
        const down = Uint8Array.of(0x90, nonce, 0xa5, 0x17), up = Uint8Array.of(0x91, nonce, 0x5a, 0x18);
        expect(await host.sendDpn(id, 8, down)).toBe(DPN.OK);
        await until(() => peer.user.some(bytes => same(bytes, down)), "actual Host-to-peer nonce");
        expect(await peer.link.sendReliable(up, 0)).toBe(DPN.OK);
        await until(() => host.queue.some(message => message.from === id && same(message.data, up)), "actual peer-to-Host nonce");
        host.removeMessage(host.queue.findIndex(message => message.from === id && same(message.data, up)));
    };
    const fill = async (peer: Peer, count: number) => {
        suppressed.add(peer.role);
        const id = snapshot(peer).localId;
        for (let i = 0; i < count; i++) promises.push(host.sendDpn(id, 8, Uint8Array.of(0x70, peer.role, i & 255, i >>> 8)));
        await turns();
        return id;
    };
    const resume = async () => {
        suppressed.clear();
        // Re-deliver only actual observed ACK datagrams. This makes progress without an arbitrary retry sleep.
        for (const frame of heldAcknowledgements.splice(0)) {
            const packet = decodeDatagram(frame)!;
            // Datagram node is the destination on send, so the source role is encoded in its bound source port.
            const role = packet.srcPort - port(0);
            expect(peers.has(role)).toBe(true);
            networks[0].receiveFrame(encodeDatagram(packet.proto, networks[role].node, packet.dstPort, packet.srcPort, packet.payload));
        }
        return Promise.all(promises);
    };
    cleanup.push(() => {
        host.dispose();
        for (const peer of peers.values()) peer.link.close();
        for (const network of networks) network.attach(null);
    });
    return { host, networks, peers, promises, heldAcknowledgements, releaseCounts, returnCounts, created, start, join, fill, resume, packets, snapshot, traffic, port };
}

test("a full first survivor child does not roll back committed D1 or prevent delivery and traffic to another survivor", async () => {
    const s = scene(); expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2), departing = await s.join(3);
    const firstId = s.snapshot(p1).localId, secondId = s.snapshot(p2).localId, departingId = s.snapshot(departing).localId, hostId = s.host.localId;
    const version = decodeNativeCoreOperation(s.packets(p2, 0xc6).at(-1)!)!.version;
    await s.traffic(p1, firstId, 1); await s.traffic(p2, secondId, 2);
    expect(await s.fill(p1, 256)).toBe(firstId);
    expect(s.heldAcknowledgements.length).toBeGreaterThan(0);
    expect(await s.host.sendDpn(firstId, 8, Uint8Array.of(0x7f))).toBe(DPN.TABLEFULL);
    expect(p1.link.state).toBe("connected");
    // The shared port limit remains320, not a reduced fixture quota; a different real link can still submit.
    await s.traffic(p2, secondId, 3);
    expect(await departing.link.shutdown()).toBe(DPN.OK);
    await turns();
    expect(s.host.isHost).toBe(true);
    expect(s.host.localId).toBe(hostId);
    expect(s.host.currentPlayers).toBe(3);
    expect([...s.host.entities.keys()].sort()).toEqual([hostId, firstId, secondId].sort());
    expect(s.networks[0].isBound(s.port(0), PROTO_UDP)).toBe(true);
    await until(() => s.packets(p2, 0xd1).length === 1, "actual committed D1 to healthy second survivor");
    expect(decodeNativeCoreOperation(s.packets(p2, 0xd1)[0])).toMatchObject({ id: departingId, version: version + 1, reason: 1 });
    expect(s.packets(p1, 0xd1)).toHaveLength(0);
    expect(await s.host.sendDpn(firstId, 8, Uint8Array.of(0x7e))).toBe(DPN.TABLEFULL);
    await s.traffic(p2, secondId, 4);
    expect(await s.resume()).toEqual(Array(256).fill(DPN.OK));
    await s.traffic(p1, firstId, 5);
    expect(s.packets(p1, 0xd1)).toHaveLength(0); // No invented retry/history convergence.
    const newcomer = await s.join(4), next = s.snapshot(newcomer);
    expect(next.version).toBe(version + 2);
    expect(next.entries.map(entry => entry.name)).toEqual(["host", "peer1", "peer2", "peer4"]);
    expect(next.entries.some(entry => entry.id === departingId)).toBe(false);
    expect(decodeNativeCoreOperation(s.packets(p2, 0xc6).at(-1)!)!.version).toBe(version + 3);
    s.host.close(); await turns();
    expect(s.host.pendingBytes).toBe(0);
    expect(s.host.currentPlayers).toBe(0);
    expect(s.networks[0].isBound(s.port(0), PROTO_UDP)).toBe(false);
}, 10000);

test("a later full survivor cannot cancel an earlier accepted D1 FIFO child", async () => {
    const s = scene(); expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2), departing = await s.join(3);
    const firstId = s.snapshot(p1).localId, secondId = s.snapshot(p2).localId, departingId = s.snapshot(departing).localId;
    const version = decodeNativeCoreOperation(s.packets(p1, 0xc6).at(-1)!)!.version;
    await s.fill(p2, 256);
    expect(await s.host.sendDpn(secondId, 8, Uint8Array.of(0x7f))).toBe(DPN.TABLEFULL);
    expect(await departing.link.shutdown()).toBe(DPN.OK);
    await until(() => s.packets(p1, 0xd1).length === 1, "accepted first survivor D1");
    expect(s.host.isHost).toBe(true); expect(s.host.currentPlayers).toBe(3);
    expect(decodeNativeCoreOperation(s.packets(p1, 0xd1)[0])).toMatchObject({ id: departingId, version: version + 1, reason: 1 });
    expect(s.packets(p2, 0xd1)).toHaveLength(0);
    await s.traffic(p1, firstId, 7);
    expect(await s.resume()).toEqual(Array(256).fill(DPN.OK));
    await s.traffic(p2, secondId, 8);
    expect(s.releaseCounts[3]).toBe(1); expect(s.returnCounts[3]).toBe(1);
}, 10000);

test("committed D1 retains its accepted FIFO positions across reentrant INFO before observer return", async () => {
    let armed = false, infoResult = -1;
    let s!: ReturnType<typeof scene>;
    s = scene({ onChange: () => {
        if (armed && s.host.currentPlayers === 3) {
            armed = false;
            infoResult = s.host.setInfo(s.host.localId, 1, "after-departure", new Uint8Array());
        }
    } });
    expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2), departing = await s.join(3);
    const version = decodeNativeCoreOperation(s.packets(p1, 0xc6).at(-1)!)!.version;
    const before = [p1.core.length, p2.core.length];
    armed = true;
    expect(await departing.link.shutdown()).toBe(DPN.OK);
    await until(() => s.packets(p2, 0xdb).length === 1, "reentrant accepted INFO after D1");
    expect(infoResult).toBe(DPN.OK);
    for (const [index, peer] of [p1, p2].entries()) {
        expect(peer.core.slice(before[index]).map(data => {
            const operation = decodeNativeCoreOperation(data)!; return [operation.command, operation.version];
        })).toEqual([[0xd1, version + 1], [0xdb, version + 2]]);
    }
    expect(s.host.isHost).toBe(true); expect(s.host.pendingBytes).toBe(0);
}, 10000);

test("reentrant Close/restart during the first D1 wire start cancels the remaining old children once", async () => {
    let armed = false, restarted = -1;
    let s!: ReturnType<typeof scene>;
    const instance = (reference.application.instance.startsWith("ff") ? "ee" : "ff") + reference.application.instance.slice(2);
    s = scene({ onWire: (source, target, bytes) => {
        const frame = decodeNativeProtocolFrame(bytes);
        if (armed && source === 0 && target === 1 && frame?.kind === "data" && (frame.command & DN.USER1) &&
            decodeNativeCoreOperation(frame.payload)?.command === 0xd1) {
            armed = false;
            s.host.close(); restarted = s.start(instance);
        }
    } });
    expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2), departing = await s.join(3);
    const oldSecond = p2.core.length;
    armed = true; expect(await departing.link.shutdown()).toBe(DPN.OK);
    await turns();
    expect(restarted).toBe(DPN.OK); expect(s.host.isHost).toBe(true);
    expect(s.packets(p1, 0xd1)).toHaveLength(1); expect(p2.core).toHaveLength(oldSecond);
    expect(s.host.currentPlayers).toBe(1); expect(s.host.pendingBytes).toBe(0);
    const fresh = await s.join(4), table = s.snapshot(fresh);
    expect(table.application.instance).toBe(instance);
    expect(table.entries.map(entry => entry.name)).toEqual(["host", "peer4"]);
    expect(table.version).toBe(3); expect(s.packets(fresh, 0xd1)).toHaveLength(0);
    await s.traffic(fresh, table.localId, 9);
    expect(s.releaseCounts[3]).toBe(1); expect(s.returnCounts[3]).toBe(1);
}, 10000);

test("a departure waiting for RETURN_BUFFER retains its old gate before per-child D1 refusal", async () => {
    let returned!: () => void;
    const gate = new Promise<void>(resolve => { returned = resolve; });
    const s = scene({ returned: role => role === 3 ? gate : undefined });
    expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2);
    const version = decodeNativeCoreOperation(s.packets(p2, 0xc6).at(-1)!)!.version;
    const departing = await s.join(3, false), departingId = s.snapshot(departing).localId;
    expect(s.returnCounts[3]).toBe(1); expect(s.releaseCounts[3]).toBe(0);
    // One existing held D0 plus255 real user jobs fill the unchanged256-slot link.
    await s.fill(p1, 255);
    expect(await s.host.sendDpn(s.snapshot(p1).localId, 8, Uint8Array.of(0x7f))).toBe(DPN.TABLEFULL);
    expect(await departing.link.shutdown()).toBe(DPN.OK); await turns();
    expect(s.host.currentPlayers).toBe(4);
    expect(s.packets(p2, 0xd0)).toHaveLength(0); expect(s.packets(p2, 0xd1)).toHaveLength(0);
    returned();
    await until(() => s.packets(p2, 0xd1).length === 1, "D0 then committed D1 after owned return");
    expect(s.packets(p2, 0xd0).map(data => decodeNativeCoreOperation(data)!.version)).toEqual([version + 1]);
    expect(decodeNativeCoreOperation(s.packets(p2, 0xd1)[0])).toMatchObject({ id: departingId, version: version + 2, reason: 1 });
    expect(s.packets(p1, 0xd1)).toHaveLength(0);
    expect(s.created.includes(3)).toBe(false);
    expect(s.returnCounts[3]).toBe(1); expect(s.releaseCounts[3]).toBe(1);
    expect(s.host.isHost).toBe(true); expect(s.host.currentPlayers).toBe(3);
    expect(await s.resume()).toEqual(Array(255).fill(DPN.OK));
    await s.traffic(p2, s.snapshot(p2).localId, 10);
}, 10000);

test("a public admission-signal abort listener can replace Host without moving the old channel into its lifetime", async () => {
    let armed = false, restarted = -1, departingAborts = 0;
    let s!: ReturnType<typeof scene>;
    const instance = (reference.application.instance.startsWith("aa") ? "bb" : "aa") + reference.application.instance.slice(2);
    s = scene({ onAbort: role => {
        if (role === 3) departingAborts++;
        if (armed && role === 3) {
            armed = false;
            s.host.close(); restarted = s.start(instance);
        }
    } });
    expect(s.start()).toBe(DPN.OK);
    const p1 = await s.join(1), p2 = await s.join(2), departing = await s.join(3);
    const oldCounts = [p1.core.length, p2.core.length];
    armed = true; expect(await departing.link.shutdown()).toBe(DPN.OK);
    await turns();
    expect(restarted).toBe(DPN.OK); expect(departingAborts).toBe(1);
    expect(s.host.isHost).toBe(true); expect(s.host.currentPlayers).toBe(1);
    expect(p1.core).toHaveLength(oldCounts[0]); expect(p2.core).toHaveLength(oldCounts[1]);
    expect(s.host.pendingBytes).toBe(0);
    const fresh = await s.join(4), table = s.snapshot(fresh);
    expect(table.application.instance).toBe(instance);
    expect(table.version).toBe(3); expect(table.entries.map(entry => entry.name)).toEqual(["host", "peer4"]);
    expect(s.packets(fresh, 0xd1)).toHaveLength(0);
    await s.traffic(fresh, table.localId, 11);
    expect(await s.host.shutdown()).toBe(DPN.OK);
    expect(s.host.desc).toBeNull(); expect(s.host.pendingBytes).toBe(0);
    expect(s.networks[0].isBound(s.port(0), PROTO_UDP)).toBe(false);
    expect(s.releaseCounts[3]).toBe(1); expect(s.returnCounts[3]).toBe(1);
}, 10000);
