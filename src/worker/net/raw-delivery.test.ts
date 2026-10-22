import { expect, test } from "bun:test";
import { LanNetwork, type LanDatagram, type LanEndpoint, type RawDeliveryTarget } from "./lan-network";
import { PROTO_RAW4, PROTO_RAW6, PROTO_UDP, encodeDatagram } from "./netplay-wire";
import { WsaSocketTable, ipv4Address } from "../modules/wsa-network";

const peer = Uint8Array.of(2, 1, 203, 0, 113, 7);
function packet(protocol = 1, ownerPort = 256): Uint8Array {
    return encodeDatagram(PROTO_RAW4, peer, ownerPort, protocol + 1, Uint8Array.of(protocol, 0, 11, 22, 33));
}
function receiver() {
    const packets: LanDatagram[] = [];
    return { packets, endpoint: { deliver: (data: LanDatagram) => packets.push(data) } };
}

test("native RAW4 protocol-255 capture reaches actual protocol 1 and both wildcards", () => {
    const network = new LanNetwork(), table = new WsaSocketTable(network);
    const handles = [1, 0, 255, 17].map(protocol => table.socket(3, 2, protocol));
    try {
        for (const handle of handles) table.bind(handle, ipv4Address(network.ipv4, 0));
        const owner = network.bindingGeneration(256, PROTO_RAW4);
        expect(owner).not.toBe(network.bindingGeneration(2, PROTO_RAW4));
        network.receiveFrame(packet(), false, owner);
        for (const handle of handles.slice(0, 3)) {
            expect(table.readable(handle)).toBe(true);
            const data = table.receive(handle, 64).data;
            expect(data[9]).toBe(1);
            expect([...data.subarray(20)]).toEqual([11, 22, 33]);
            expect(table.readable(handle)).toBe(false);
        }
        expect(table.readable(handles[3])).toBe(false);
    } finally { table.reset(); }
});

test("offline RAW4 loopback selects actual protocol instead of the sending socket protocol", () => {
    const network = new LanNetwork(), actual = receiver(), wildcard = receiver(), unrelated = receiver();
    network.bind(2, actual.endpoint, PROTO_RAW4);
    network.bind(256, wildcard.endpoint, PROTO_RAW4);
    network.bind(7, unrelated.endpoint, PROTO_RAW4);
    expect(network.send(256, network.node, 2, Uint8Array.of(1, 0, 55), PROTO_RAW4)).toBe(true);
    expect(actual.packets).toHaveLength(1);
    expect(wildcard.packets).toHaveLength(1);
    expect(unrelated.packets).toHaveLength(0);
});

test("standalone capture owner closure and reincarnation reject old native packets", () => {
    const network = new LanNetwork(), actual = receiver(), owner = receiver(), freshOwner = receiver();
    network.bind(2, actual.endpoint, PROTO_RAW4);
    network.bind(256, owner.endpoint, PROTO_RAW4);
    const old = network.bindingGeneration(256, PROTO_RAW4);
    network.unbind(256, owner.endpoint, PROTO_RAW4);
    network.receiveFrame(packet(), false, old);
    expect(actual.packets).toHaveLength(0);
    network.bind(256, freshOwner.endpoint, PROTO_RAW4);
    const fresh = network.bindingGeneration(256, PROTO_RAW4);
    expect(fresh).not.toBe(old);
    network.receiveFrame(packet(), false, old);
    expect(actual.packets).toHaveLength(0);
    network.receiveFrame(packet(), false, fresh);
    expect(actual.packets).toHaveLength(1);
    expect(freshOwner.packets).toHaveLength(1);
    expect(owner.packets).toHaveLength(0);
});

test("trusted RAW targets fence recipient generations without repeating wildcard fanout", () => {
    const network = new LanNetwork(), oldActual = receiver(), freshActual = receiver(), zero = receiver(), raw = receiver();
    network.bind(2, oldActual.endpoint, PROTO_RAW4);
    network.bind(1, zero.endpoint, PROTO_RAW4);
    network.bind(256, raw.endpoint, PROTO_RAW4);
    const old = network.bindingGeneration(2, PROTO_RAW4), zeroGeneration = network.bindingGeneration(1, PROTO_RAW4);
    network.unbind(2, oldActual.endpoint, PROTO_RAW4);
    network.bind(2, freshActual.endpoint, PROTO_RAW4);
    network.receiveRawFrame(packet(), [{ port: 2, generation: old }, { port: 1, generation: zeroGeneration }]);
    expect(oldActual.packets).toHaveLength(0);
    expect(freshActual.packets).toHaveLength(0);
    expect(zero.packets).toHaveLength(1);
    expect(raw.packets).toHaveLength(0);
    network.receiveRawFrame(packet(), [{ port: 2, generation: network.bindingGeneration(2, PROTO_RAW4) }]);
    expect(freshActual.packets).toHaveLength(1);
    expect(zero.packets).toHaveLength(1);
    expect(raw.packets).toHaveLength(0);
});

test("RAW recipient metadata is bounded and rejected atomically when malformed", () => {
    const network = new LanNetwork(), endpoint = receiver();
    network.bind(1, endpoint.endpoint, PROTO_RAW4);
    const valid = { port: 1, generation: network.bindingGeneration(1, PROTO_RAW4) };
    const malformed: unknown[] = [
        null, {}, [], [null], [valid, valid], [valid, valid, valid, valid],
        [valid, { port: 7, generation: 1 }], [{ port: 0, generation: 1 }], [{ port: 257, generation: 1 }],
        [{ port: 1, generation: 0 }], [{ port: 1, generation: 0x100000000 }],
        [{ port: 1, generation: 1.5 }], [{ port: 1, generation: "1" }],
    ];
    for (const targets of malformed) network.receiveRawFrame(packet(), targets as RawDeliveryTarget[]);
    network.receiveRawFrame(encodeDatagram(PROTO_RAW6, peer, 1, 2, Uint8Array.of(1, 0, 11)), [valid]);
    network.receiveRawFrame(encodeDatagram(PROTO_UDP, peer, 1, 2, Uint8Array.of(11)), [valid]);
    expect(endpoint.packets).toHaveLength(0);
    expect(network.stats.dropped).toBe(malformed.length + 2);
    network.receiveRawFrame(packet(), [valid]);
    expect(endpoint.packets).toHaveLength(1);
});

test("actual and wildcard targets deduplicate endpoints including actual protocol 255", () => {
    const network = new LanNetwork(), endpoint = receiver();
    network.bind(1, endpoint.endpoint, PROTO_RAW4);
    network.bind(256, endpoint.endpoint, PROTO_RAW4);
    network.receiveFrame(packet(255), false, network.bindingGeneration(256, PROTO_RAW4));
    expect(endpoint.packets).toHaveLength(1);
    network.receiveRawFrame(packet(255), [
        { port: 1, generation: network.bindingGeneration(1, PROTO_RAW4) },
        { port: 256, generation: network.bindingGeneration(256, PROTO_RAW4) },
    ]);
    expect(endpoint.packets).toHaveLength(2);
});

test("recipient callbacks cannot redirect a captured RAW packet into a newly bound endpoint", () => {
    const network = new LanNetwork(), old = receiver(), fresh = receiver(), owner = receiver();
    const first: LanEndpoint = { deliver() {
        network.unbind(1, old.endpoint, PROTO_RAW4);
        network.bind(1, fresh.endpoint, PROTO_RAW4);
    } };
    network.bind(2, first, PROTO_RAW4);
    network.bind(1, old.endpoint, PROTO_RAW4);
    network.bind(256, owner.endpoint, PROTO_RAW4);
    network.receiveFrame(packet(), false, network.bindingGeneration(256, PROTO_RAW4));
    expect(old.packets).toHaveLength(0);
    expect(fresh.packets).toHaveLength(0);
    expect(owner.packets).toHaveLength(1);
});

test("deduplicated endpoint remains eligible through another live snapshot alias", () => {
    const network = new LanNetwork(), shared = receiver();
    const first: LanEndpoint = { deliver() { network.unbind(1, shared.endpoint, PROTO_RAW4); } };
    network.bind(2, first, PROTO_RAW4);
    network.bind(1, shared.endpoint, PROTO_RAW4);
    network.bind(256, shared.endpoint, PROTO_RAW4);
    network.receiveFrame(packet(), false, network.bindingGeneration(256, PROTO_RAW4));
    expect(shared.packets).toHaveLength(1);
});
