import {expect, test} from "bun:test";
import {LanNetwork, type LanDatagram, type LanSocketError} from "../../src/worker/net/lan-network";
import {copyLocalUdpContext, type LocalUdpContext} from "../../src/worker/net/local-udp-context";
import {PROTO_UDP, PROTO_UDP6, PROTO_TCP, PROTO_RAW4, BROADCAST_NODE, encodeDatagram} from "../../src/worker/net/netplay-wire";

const source = 62140, target = 62141;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function context(family: 2 | 23, destinationPort = target): LocalUdpContext {
    const address = family === 2 ? Uint8Array.of(127, 0, 0, 1) : Uint8Array.from({length: 16}, (_, i) => i === 15 ? 1 : 0);
    return {source: {family, address, port: source}, destination: {family, address: Uint8Array.from(address), port: destinationPort}};
}

test("local UDP context validates fixed fields and owns Buffer/subarray input", () => {
    const backing = Buffer.from([9, 127, 0, 0, 1, 9]), input = context(2);
    input.source.address = backing.subarray(1, 5);
    const copy = copyLocalUdpContext(input)!;
    expect(copy).toEqual(input);
    backing[1] = 10; input.destination.address[0] = 10;
    expect(copy.source.address).toEqual(Uint8Array.of(127, 0, 0, 1));
    expect(copy.destination.address).toEqual(Uint8Array.of(127, 0, 0, 1));
    copy.source.address[0] = 11;
    expect(copy.destination.address[0]).toBe(127);
    for (const invalid of [
        null, {}, {source: input.source}, {...context(2), source: {...context(2).source, family: 23}},
        {...context(2), source: {...context(2).source, address: [127, 0, 0, 1]}},
        ...[0, -1, 65536, 1.5, NaN].map(port => ({...context(2), source: {...context(2).source, port}})),
        ...[-1, 0x100000000, 0.5, NaN].flatMap(value => [
            {...context(23), source: {...context(23).source, scopeId: value}},
            {...context(23), destination: {...context(23).destination, flowInfo: value}},
        ]),
    ]) expect(copyLocalUdpContext(invalid)).toBeUndefined();
    const scoped = context(23); scoped.destination.scopeId = 0xffffffff; scoped.destination.flowInfo = 0xffffffff;
    expect(copyLocalUdpContext(scoped)).toEqual(scoped);
});

for (const [family, proto] of [[2, PROTO_UDP], [23, PROTO_UDP6]] as const) {
    test(`local UDP ${family}: concrete loopback and own-LAN contexts stay distinct at one receiver`, () => {
        const network = new LanNetwork(), packets: LanDatagram[] = [];
        network.bind(source, {deliver() {}}, proto);
        network.bind(target, {deliver: packet => packets.push(packet)}, proto);
        const loop = context(family), own = context(family);
        own.source.address = family === 2 ? network.ipv4 : network.ipv6;
        expect(network.send(source, network.node, target, Uint8Array.of(1), proto, undefined, loop)).toBe(true);
        expect(network.send(source, network.node, target, Uint8Array.of(2), proto, undefined, own)).toBe(true);
        expect(packets.map(packet => packet.localUdp?.source.address)).toEqual([loop.source.address, own.source.address]);
        expect(packets.every(packet => packet.srcNode.every((n, i) => n === network.node[i]))).toBe(true);
        loop.source.address.fill(9);
        expect(packets[0].localUdp?.source.address).not.toEqual(loop.source.address);
        network.reset();
    });

    test(`local UDP ${family}: error retains admitted A across sendB and unrelated relay replacement`, async () => {
        const network = new LanNetwork(), errors: LanSocketError[] = [];
        network.bind(source, {deliver() {}}, proto);
        network.bind(target + 1, {deliver() {}}, proto);
        network.onSocketError(error => errors.push(error));
        const a = context(family), b = context(family, target + 1);
        expect(network.send(source, network.node, target, Uint8Array.of(1), proto, undefined, a)).toBe(true);
        a.destination.address.fill(9);
        expect(network.send(source, network.node, target + 1, Uint8Array.of(2), proto, undefined, b)).toBe(true);
        network.attach({connected: true, send() { throw Error("Local data must not use remote transport"); }, close() {}});
        await tick();
        expect(errors).toHaveLength(1);
        expect(errors[0].localUdp?.destination).toEqual(context(family).destination);
        network.reset(); network.attach(null);
    });
}

test("local UDP metadata cannot promote remote errors or remote/other-protocol frames", () => {
    const network = new LanNetwork(), packets: LanDatagram[] = [], errors: LanSocketError[] = [];
    network.bind(source, {deliver() {}}, PROTO_UDP);
    network.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP);
    network.onSocketError(error => errors.push(error));
    const localUdp = context(2);
    const error = {node: network.node, localPort: source, remotePort: target, proto: PROTO_UDP, code: 10054, localUdp};
    network.notifySocketError(error);
    expect(errors).toHaveLength(0);
    let remoteCalls = 0;
    network.attach({connected: true, send() { remoteCalls++; return true; }, close() {}});
    const remote = Uint8Array.of(2, 0, 0, 0, 9, 2);
    expect(network.send(source, remote, target, Uint8Array.of(1), PROTO_UDP, undefined, localUdp)).toBe(false);
    expect(network.send(source, BROADCAST_NODE, target, Uint8Array.of(1), PROTO_UDP, undefined, localUdp)).toBe(false);
    for (const proto of [PROTO_TCP, PROTO_RAW4])
        expect(network.send(source, network.node, target, Uint8Array.of(1), proto, undefined, localUdp)).toBe(false);
    const invalid = {...localUdp, destination: {...localUdp.destination, port: target + 1}};
    expect(network.send(source, network.node, target, Uint8Array.of(1), PROTO_UDP, undefined, invalid)).toBe(false);
    network.receiveFrame(encodeDatagram(PROTO_UDP, remote, target, source, Uint8Array.of(1)), false, undefined, undefined, localUdp);
    expect(packets).toHaveLength(0); expect(remoteCalls).toBe(0);
    network.notifyLocalUdpError(error);
    expect(errors).toHaveLength(1);
    network.reset(); network.attach(null);
});

test("trusted local errors copy the context independently for listeners", () => {
    const network = new LanNetwork(), received: LanSocketError[] = [];
    network.onSocketError(error => { error.localUdp!.destination.address.fill(9); });
    network.onSocketError(error => received.push(error));
    const localUdp = context(2);
    network.notifyLocalUdpError({node: network.node, localPort: source, remotePort: target, proto: PROTO_UDP, code: 10054, localUdp});
    expect(localUdp.destination.address).toEqual(Uint8Array.of(127, 0, 0, 1));
    expect(received[0].localUdp?.destination).toEqual(context(2).destination);
});
