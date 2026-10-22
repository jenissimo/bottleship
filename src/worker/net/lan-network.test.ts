/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { LanNetwork, type LanDatagram } from "./lan-network";
import { BROADCAST_NODE, PROTO_UDP, PROTO_IPX, PROTO_TCP, encodeDatagram } from "./netplay-wire";

describe("virtual LAN adapter", () => {
    test("local loopback and broadcast work offline with protocol isolation and copied payloads", () => {
        const net = new LanNetwork(Uint8Array.of(2, 0, 0, 1, 2, 3));
        const udp: LanDatagram[] = [], ipx: LanDatagram[] = [];
        const endpoint = { deliver: (data: LanDatagram) => udp.push(data) };
        expect(net.bind(4000, endpoint, PROTO_UDP)).toBe(true);
        expect(net.bind(4000, { deliver: data => ipx.push(data) }, PROTO_IPX)).toBe(true);
        expect(net.bind(4000, endpoint, PROTO_UDP)).toBe(false);
        expect(net.send(4000, net.node, 4000, new Uint8Array(), PROTO_IPX)).toBe(false);
        const payload = Uint8Array.of(9);
        expect(net.send(4000, net.node, 4000, payload, PROTO_UDP)).toBe(true);
        expect(net.send(4000, BROADCAST_NODE, 4000, payload, PROTO_UDP)).toBe(true);
        payload[0] = 0;
        expect(udp.map(data => data.data[0])).toEqual([9, 9]);
        expect(ipx).toHaveLength(0);
        expect(net.send(4000, Uint8Array.of(2, 0, 0, 9, 9, 9), 4000, payload, PROTO_UDP)).toBe(false);
        net.unbind(4000, { deliver() {} }, PROTO_UDP);
        expect(net.isBound(4000, PROTO_UDP)).toBe(true);
        net.unbind(4000, endpoint, PROTO_UDP);
        expect(net.isBound(4000, PROTO_UDP)).toBe(false);
    });
    test("propagates transport backpressure and lifecycle while preserving identity and binds", () => {
        const net = new LanNetwork(Uint8Array.of(2, 0, 0, 4, 5, 6));
        const received: LanDatagram[] = [], states: boolean[] = [];
        net.bind(4000, { deliver: data => received.push(data) }, PROTO_TCP);
        let writable = false, closed = false, drained = 0;
        const stop = net.onStateChange(state => states.push(state.connected));
        net.onWritable(() => drained++);
        net.attach({ send: () => writable, close: () => { closed = true; } });
        const peer = Uint8Array.of(2, 0, 0, 1, 2, 3);
        expect(net.send(4000, peer, 4000, Uint8Array.of(1), PROTO_TCP)).toBe(false);
        writable = true;
        net.notifyWritable();
        expect(drained).toBe(1);
        expect(net.send(4000, peer, 4000, Uint8Array.of(1), PROTO_TCP)).toBe(true);
        net.receiveFrame(encodeDatagram(PROTO_TCP, peer, 4000, 5000, Uint8Array.of(2)));
        expect(received[0].srcPort).toBe(5000);
        net.attach(null);
        expect(closed).toBe(true);
        expect(states).toEqual([false, true, false]);
        expect(net.isBound(4000, PROTO_TCP)).toBe(true);
        net.reset();
        expect(net.isBound(4000, PROTO_TCP)).toBe(false);
        stop();
    });
});

test("raw actual protocol and wildcard bindings fan out once per endpoint", () => {
    const net = new LanNetwork(Uint8Array.of(2,0,0,3,4,5)), peer = Uint8Array.of(2,0,0,3,4,6);
    const actual: LanDatagram[] = [], wildcard: LanDatagram[] = [], ipv6: LanDatagram[] = [];
    const shared = { deliver: (packet: LanDatagram) => wildcard.push(packet) };
    net.bind(18, { deliver: packet => actual.push(packet) }, 6);
    net.bind(1, shared, 6); net.bind(256, shared, 6);
    net.bind(1, { deliver: packet => ipv6.push(packet) }, 7);
    const bytes = Uint8Array.of(17,0,9,10);
    net.receiveFrame(encodeDatagram(6, peer, 18, 18, bytes));
    expect(actual).toHaveLength(1); expect(wildcard).toHaveLength(1); expect(ipv6).toHaveLength(0);
    actual[0].data[2] = 99;
    expect(wildcard[0].data).toEqual(bytes);
    expect(net.send(18, net.node, 18, bytes, 6)).toBe(true);
    expect(actual).toHaveLength(2); expect(wildcard).toHaveLength(2);
    net.receiveFrame(encodeDatagram(7, peer, 18, 18, bytes));
    expect(ipv6).toHaveLength(1); expect(actual).toHaveLength(2);
});

test("IPv6 route tokens distinguish scopes and reject malformed scope metadata", () => {
    const net = new LanNetwork();
    const address = new Uint8Array(16); address[0]=0xfe; address[1]=0x80; address[15]=7;
    const one=[2,2,0,0,0,1], two=[2,2,0,0,0,2];
    net.configureGatewayIpv6([
        { address: [...address], node: one, scopeId: 7 },
        { address: [...address], node: two, scopeId: 8 },
        { address: [...address], node: two, scopeId: -1 },
    ]);
    expect([...net.routeIpv6(address,7)]).toEqual(one);
    expect([...net.routeIpv6(address,8)]).toEqual(two);
    expect(net.nodeToIpv6Scope(Uint8Array.from(one))).toBe(7);
    expect(net.nodeToIpv6Scope(Uint8Array.from(two))).toBe(8);
    expect(net.nodeToIpv6(Uint8Array.from(two))).toEqual(address);
    expect(() => net.routeIpv6(address)).toThrow();
    expect(() => net.routeIpv6(address,-1)).toThrow();
});
