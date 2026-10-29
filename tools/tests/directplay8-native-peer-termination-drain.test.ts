import { expect, test } from "bun:test";
import fixture from "./fixtures/directplay8-native-mesh.json";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeDirectPlayHost } from "../../src/worker/modules/dpnet/native-wire/host";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { DN, decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { decodeNativeCoreConnectInfo, encodeNativePlayerConnect } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { decodeNativeCoreOperation, nativeCoreWords } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import { DPN } from "../../src/worker/modules/dpnet/constants";

const reference = decodeNativeCoreConnectInfo(Uint8Array.from(Buffer.from(
    fixture.messages.find(message => message.core === 0xc2 && message.target === 2)!.payload, "hex")))!;
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function until(check: () => boolean, label: string) {
    const end = performance.now() + 1500;
    while (!check()) { if (performance.now() >= end) throw Error("Termination fixture: " + label); await Bun.sleep(1); }
}
interface Peer { role: number; link: NativeReliableLink; core: Uint8Array[]; user: Uint8Array[]; }

// Uses the same real binary Host/link carrier mechanics as
// directplay8-native-host-committed-send.test.ts. Explicit owner.returned() is
// a component callback-return model, not a native CPU or scheduling capture.
test("Peer termination skips a full recipient and Close isolates delayed ACKs from same-port rehost", async () => {
    const nets = [0, 1, 2, 3].map(role => new LanNetwork(Uint8Array.of(2, 0, 0, 33, 0, 60 + role)));
    const host = new NativeDirectPlayHost(nets[0]), peers = new Map<number, Peer>();
    const suppressed = new Set<number>(), held: { role: number; frame: Uint8Array }[] = [];
    const pending: Promise<number>[] = [];
    const port = (role: number) => fixture.ports[0] + role;
    let releases = 0;
    let application = { ...reference.application, maxPlayers: 4 };
    for (const [source, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame);
        if (!d || d.proto !== PROTO_UDP) return false;
        const target = nets.findIndex(other => other.node.every((n, i) => n === d.node[i]));
        if (target < 0 || d.srcPort !== port(source) || d.dstPort !== port(target)) return false;
        if (target === 0 && suppressed.has(source)) {
            if (decodeNativeProtocolFrame(d.payload)?.kind === "ack") held.push({ role: source, frame: frame.slice() });
            return true;
        }
        nets[target].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload));
        return true;
    }, close() {} });
    const start = (instance: string) => {
        application = { ...application, instance };
        return host.start({
            port: port(0), application, player: { name: "host", data: Uint8Array.of(0) },
            url: address => "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0." +
                (address.node[5] - 59) + ";port=" + address.port,
            allowIncoming: address => nets.slice(1).some(net => net.node.every((n, i) => n === address.node[i])),
            timeout: 3000, retryInterval: 25, admit: () => ({ hr: DPN.OK }),
        });
    };
    const packets = (peer: Peer, command: number) => peer.core.filter(bytes => decodeNativeCoreOperation(bytes)?.command === command);
    const snapshot = (peer: Peer) => peer.core.map(decodeNativeCoreConnectInfo).find(value => !!value)!;
    const join = async (role: number) => {
        const peer: Peer = { role, link: undefined!, core: [], user: [] };
        peer.link = new NativeReliableLink({
            timeout: 3000, retryInterval: 25,
            send: bytes => nets[role].send(port(role), nets[0].node, port(0), bytes, PROTO_UDP),
            onMessage: message => {
                if (message.command & DN.USER1) {
                    peer.core.push(message.payload.slice());
                    if (decodeNativeCoreConnectInfo(message.payload)) void peer.link.sendReliable(nativeCoreWords(0xc3));
                } else peer.user.push(message.payload.slice());
            },
        });
        peers.set(role, peer);
        expect(nets[role].bind(port(role), { deliver: datagram => peer.link.receive(datagram.data) }, PROTO_UDP)).toBe(true);
        expect(await peer.link.connect()).toBe(DPN.OK);
        expect(await peer.link.sendReliable(encodeNativePlayerConnect({
            flags: 4, version: 2, instance: application.instance, application: application.application,
            name: "peer" + role, data: Uint8Array.of(role), password: application.password,
            connectData: new Uint8Array(), url: null, alternate: new Uint8Array(),
        }))).toBe(DPN.OK);
        await until(() => packets(peer, 0xc6).length > 0, "peer joined " + role);
        return peer;
    };
    const deliverCaptured = (row: { role: number; frame: Uint8Array }) => {
        const d = decodeDatagram(row.frame)!;
        nets[0].receiveFrame(encodeDatagram(d.proto, nets[row.role].node, d.dstPort, d.srcPort, d.payload));
    };
    try {
        expect(start(reference.application.instance)).toBe(DPN.OK);
        const full = await join(1), slow = await join(2);
        const fullId = snapshot(full).localId;
        suppressed.add(1);
        for (let i = 0; i < 256; i++) pending.push(host.sendDpn(fullId, 8, Uint8Array.of(0x70, i & 255, i >>> 8)));
        await turns();
        expect(held.some(row => row.role === 1)).toBe(true);
        expect(await host.sendDpn(fullId, 8, Uint8Array.of(0x7f))).toBe(DPN.TABLEFULL);
        suppressed.add(2);
        const source = Uint8Array.of(0x74, 0, 0x71);
        const lease = host.beginNativeTermination(source, () => () => { releases++; });
        expect(typeof lease).not.toBe("number");
        if (typeof lease === "number") throw Error("Termination was not admitted");
        source.fill(0xee);
        await until(() => packets(slow, 0xdf).length === 1, "DF delivered to healthy recipient");
        expect(packets(full, 0xdf)).toHaveLength(0);
        expect([...packets(slow, 0xdf)[0]]).toEqual([0xdf, 0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 0x74, 0, 0x71]);
        expect(held.some(row => row.role === 2)).toBe(true);
        expect(lease.returned()).toBe(DPN.OK);
        await turns();
        expect(host.desc).toBeNull();
        expect(nets[0].isBound(port(0), PROTO_UDP)).toBe(true);
        expect(releases).toBe(0); // Accepted DF owns the old port until ACK/drain or Close.

        const staleAcks = held.slice();
        expect(host.close()).toBe(DPN.OK);
        expect(releases).toBe(1);
        expect(nets[0].isBound(port(0), PROTO_UDP)).toBe(false);
        const nextInstance = (reference.application.instance.startsWith("aa") ? "bb" : "aa") +
            reference.application.instance.slice(2);
        expect(start(nextInstance)).toBe(DPN.OK);
        const binding = nets[0].bindingGeneration(port(0), PROTO_UDP);
        for (const ack of staleAcks) deliverCaptured(ack);
        expect((await Promise.all(pending)).every(hr => hr !== DPN.OK)).toBe(true);
        await turns();
        expect(host.desc?.instance).toBe(nextInstance);
        expect(nets[0].bindingGeneration(port(0), PROTO_UDP)).toBe(binding);
        expect(releases).toBe(1);
        const fresh = await join(3), freshId = snapshot(fresh).localId;
        expect(snapshot(fresh).application.instance).toBe(nextInstance);
        expect(await host.sendDpn(freshId, 8, Uint8Array.of(0x46, 0, 0x33))).toBe(DPN.OK);
        expect(fresh.user.some(bytes => [...bytes].join(",") === "70,0,51")).toBe(true);
        for (const ack of staleAcks) deliverCaptured(ack);
        await turns();
        expect(host.desc?.instance).toBe(nextInstance);
        expect(nets[0].bindingGeneration(port(0), PROTO_UDP)).toBe(binding);
        expect(host.entities.has(freshId)).toBe(true);
        expect(releases).toBe(1);
    } finally {
        host.dispose(); for (const peer of peers.values()) peer.link.close(); nets.forEach(net => net.attach(null));
    }
}, 15000);
