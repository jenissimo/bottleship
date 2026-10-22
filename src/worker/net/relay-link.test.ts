/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createLanServer } from "../../../packages/lan/src/server";
import { LanNetwork, type LanDatagram } from "./lan-network";
import { RelayLink, type RelayLinkOptions } from "./relay-link";
import { PROTO_UDP, PROTO_TCP, UDP_MAX_PAYLOAD } from "./netplay-wire";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Timed out: " + description);
        await pause(5);
    }
}
function machine(host: number): LanNetwork { return new LanNetwork(Uint8Array.of(2, 0, 0, 2, 0, host)); }
function link(url: string, room: string, net: LanNetwork, options: RelayLinkOptions): RelayLink {
    const transport = new RelayLink(url, room, net, options);
    net.attach(transport);
    return transport;
}
describe("worker LAN transport", () => {
    for (const transport of ["websocket", "polling"] as const) test(transport + " carries maximum UDP datagrams and ordered reliable bursts", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = machine(1), b = machine(2);
        const fromA = link(url, "stream", a, { transports: [transport] });
        const fromB = link(url, "stream", b, { transports: [transport] });
        try {
            await Promise.all([fromA.ready, fromB.ready]);
            const datagrams: LanDatagram[] = [], stream: LanDatagram[] = [];
            b.bind(4000, { deliver: data => datagrams.push(data) }, PROTO_UDP);
            b.bind(4000, { deliver: data => stream.push(data) }, PROTO_TCP);
            const maxPayload = new Uint8Array(UDP_MAX_PAYLOAD);
            maxPayload[0] = 42; maxPayload[maxPayload.length - 1] = 99;
            await until(() => a.send(5000, b.node, 4000, maxPayload, PROTO_UDP), "UDP send writable");
            await until(() => datagrams.length === 1, "maximum datagram received");
            expect(datagrams[0].data.length).toBe(UDP_MAX_PAYLOAD);
            expect(datagrams[0].data[0]).toBe(42);
            expect(datagrams[0].data[UDP_MAX_PAYLOAD - 1]).toBe(99);
            expect(a.connected).toBe(true);
            for (let sequence = 0; sequence < 32; sequence++) {
                const payload = new Uint8Array(8192);
                payload.fill(sequence);
                expect(a.send(5000, b.node, 4000, payload, PROTO_TCP)).toBe(true);
            }
            await until(() => stream.length === 32, "reliable burst received");
            expect(stream.map(data => data.data[0])).toEqual(Array.from({ length: 32 }, (_, value) => value));
            expect(stream.every(data => data.data.length === 8192 && data.data[8191] === data.data[0])).toBe(true);
        } finally { a.attach(null); b.attach(null); await server.close(); }
    }, 15_000);

    test("keeps the polling fallback when WebSocket is unavailable", async () => {
        const server = createLanServer({ port: 0, transports: ["polling"] });
        const port = await server.listen(), net = machine(1);
        const transport = link("http://127.0.0.1:" + port, "fallback", net, { timeoutMs: 3000 });
        try {
            await transport.ready;
            expect(transport.socket.io.engine.transport.name).toBe("polling");
            expect(net.connected).toBe(true);
        } finally { net.attach(null); await server.close(); }
    }, 10_000);

    test("default HTTP connection upgrades to WebSocket when available", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), net = machine(1);
        const transport = link("http://127.0.0.1:" + port, "upgrade", net, {});
        try {
            await transport.ready;
            await until(() => transport.socket.io.engine.transport.name === "websocket", "WebSocket upgrade");
            expect(net.connected).toBe(true);
        } finally { net.attach(null); await server.close(); }
    }, 10_000);

    test("reliable output has a finite queue and fails the connection visibly on overflow", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), net = machine(1);
        const transport = link("http://127.0.0.1:" + port, "bounded", net, { transports: ["polling"] });
        try {
            await transport.ready;
            let accepted = 0;
            while (net.send(5000, Uint8Array.of(2, 0, 0, 2, 0, 2), 4000, new Uint8Array(8192), PROTO_TCP)) {
                if (++accepted > 256) throw new Error("Reliable queue did not enforce its bound");
            }
            expect(accepted).toBeGreaterThan(0);
            expect(net.connected).toBe(false);
            expect(transport.socket.active).toBe(false);
        } finally { net.attach(null); await server.close(); }
    }, 10_000);

    test("reconnect preserves identity and never replays offline UDP", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = machine(1), b = machine(2), received: LanDatagram[] = [], states: boolean[] = [];
        const fromA = link(url, "reconnect", a, { transports: ["websocket"] });
        const fromB = link(url, "reconnect", b, { transports: ["websocket"] });
        a.onStateChange(state => states.push(state.connected));
        b.bind(4000, { deliver: data => received.push(data) }, PROTO_UDP);
        try {
            await Promise.all([fromA.ready, fromB.ready]);
            const identity = a.node.slice();
            fromA.socket.io.engine.close();
            await until(() => !a.connected, "disconnect notification");
            expect(a.send(5000, b.node, 4000, Uint8Array.of(1), PROTO_UDP)).toBe(false);
            await until(() => a.connected, "reconnected");
            expect(a.node).toEqual(identity);
            await until(() => a.send(5000, b.node, 4000, Uint8Array.of(2), PROTO_UDP), "fresh datagram accepted");
            await until(() => received.length === 1, "fresh datagram received");
            await pause(50);
            expect(received.map(data => data.data[0])).toEqual([2]);
            expect(states).toEqual([true, false, true]);
        } finally { a.attach(null); b.attach(null); await server.close(); }
    }, 15_000);

    test("peer disconnect reaches only its room and reliable sends to an offline lease report failure", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = machine(1), b = machine(2), outsider = machine(2);
        const fromA = link(url, "peers", a, { transports: ["websocket"] });
        const fromB = link(url, "peers", b, { transports: ["websocket"] });
        const fromOutsider = link(url, "elsewhere", outsider, { transports: ["websocket"] });
        const departed: Uint8Array[] = [];
        const unsubscribe = a.onPeerDisconnect(node => departed.push(node));
        try {
            await Promise.all([fromA.ready, fromB.ready, fromOutsider.ready]);
            outsider.attach(null);
            await pause(50);
            expect(departed).toHaveLength(0);
            b.attach(null);
            await until(() => departed.length === 1, "room peer disconnect");
            expect(departed[0]).toEqual(b.node);
            expect(a.connected).toBe(true);
            expect(a.send(5000, b.node, 4000, Uint8Array.of(1), PROTO_TCP)).toBe(true);
            await until(() => departed.length === 2, "offline reliable destination notification");
            expect(departed[1]).toEqual(b.node);
            unsubscribe();
            a.notifyPeerDisconnected(b.node);
            expect(departed).toHaveLength(2);
        } finally { unsubscribe(); a.attach(null); b.attach(null); outsider.attach(null); await server.close(); }
    }, 10_000);

    test("a deliberate server rejection stops automatic reconnect", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), net = machine(1);
        const transport = link("http://127.0.0.1:" + port, "invalid", net, {});
        try {
            await transport.ready;
            transport.socket.emit("frame", Uint8Array.of(255));
            await until(() => !net.connected, "server disconnected malformed client");
            await pause(800);
            expect(transport.socket.active).toBe(false);
            expect(net.connected).toBe(false);
        } finally { net.attach(null); await server.close(); }
    }, 10_000);
});

test("malformed resolver metadata fails explicitly and invalid readiness cannot crash the worker", async () => {
    const server = createLanServer({ port: 0 });
    server.io.on("connection", socket => {
        socket.removeAllListeners("resolve");
        socket.on("resolve", id => socket.emit("resolved", id, { result: { canonicalName: "broken.test", addresses: [null] } } as never));
    });
    const port = await server.listen(), net = machine(12);
    const transport = link("http://127.0.0.1:" + port, "metadata", net, { transports: ["websocket"] });
    try {
        await transport.ready;
        let failure: unknown;
        try { await net.resolve("broken.test", 4); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: "NO_RECOVERY" });
        server.io.emit("ready", { version: 1, node: [...net.node], ipv4: [...net.ipv4], gatewayIpv4: [null], gatewayIpv6: [null] } as never);
        await pause(30);
        expect(net.connected).toBe(true);
        server.io.emit("ready", null as never);
        await until(() => !net.connected, "malformed readiness closes the link");
        expect(transport.socket.active).toBe(false);
    } finally { net.attach(null); await server.close(); }
}, 10_000);
