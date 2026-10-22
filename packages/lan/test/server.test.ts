/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { createLanServer } from "../src/server";
import {
    BROADCAST_NODE, decodeDatagram, encodeDatagram, PROTOCOL_VERSION, PROTO_UDP, PROTO_TCP,
    type ClientEvents, type ServerEvents, type LanReady,
} from "../src/protocol";

type Client = Socket<ServerEvents, ClientEvents>;
const node = (host: number) => Uint8Array.of(2, 0, 0, 1, 0, host);
function client(url: string, host: number, room: string, transports: ("websocket" | "polling")[] = ["websocket"], clientId = crypto.randomUUID()): Client {
    return io(url, { autoConnect: false, forceNew: true, reconnection: false, timeout: 2000,
        transports, tryAllTransports: true,
        auth: { version: PROTOCOL_VERSION, room, node: Array.from(node(host)), clientId } });
}
function ready(socket: Client): Promise<LanReady> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ready timed out")), 3000);
        socket.once("ready", info => { clearTimeout(timer); resolve(info); });
        socket.once("connect_error", error => { clearTimeout(timer); reject(error); });
        socket.connect();
    });
}
function frame(socket: Client): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timed out")), 3000);
        socket.once("frame", data => { clearTimeout(timer); resolve(new Uint8Array(data)); });
    });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("standalone LAN relay", () => {
    for (const transport of ["websocket", "polling"] as const) test(transport + " routes unicast and broadcast with source rewriting and room isolation", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen();
        const url = "http://127.0.0.1:" + port;
        const a = client(url, 1, "friends", [transport]);
        const b = client(url, 2, "friends", [transport]);
        const outsider = client(url, 3, "elsewhere", [transport]);
        try {
            const infos = await Promise.all([ready(a), ready(b), ready(outsider)]);
            expect(infos[0].ipv4).toEqual([10, 1, 0, 1]);
            expect(a.io.engine.transport.name).toBe(transport);
            let leaked = 0, reflected = 0;
            outsider.on("frame", () => leaked++);
            a.on("frame", () => reflected++);
            const delivered = frame(b);
            a.emit("frame", encodeDatagram(PROTO_UDP, node(2), 4000, 5000, Uint8Array.of(0, 255, 7)));
            const datagram = decodeDatagram(await delivered)!;
            expect(datagram.node).toEqual(node(1));
            expect(datagram.srcPort).toBe(5000);
            expect(datagram.dstPort).toBe(4000);
            expect(Array.from(datagram.payload)).toEqual([0, 255, 7]);
            await pause(20);
            const broadcast = frame(b);
            a.emit("frame", encodeDatagram(PROTO_UDP, BROADCAST_NODE, 4000, 5000, Uint8Array.of(8)));
            expect(decodeDatagram(await broadcast)!.payload[0]).toBe(8);
            await pause(50);
            expect(leaked).toBe(0);
            expect(reflected).toBe(0);
        } finally { a.disconnect(); b.disconnect(); outsider.disconnect(); await server.close(); }
    }, 10_000);

    test("keeps HTTP long-polling when a WebSocket upgrade is unavailable", async () => {
        const server = createLanServer({ port: 0, transports: ["polling"] });
        const port = await server.listen();
        const socket = client("http://127.0.0.1:" + port, 1, "fallback", ["polling", "websocket"]);
        try { await ready(socket); expect(socket.io.engine.transport.name).toBe("polling"); }
        finally { socket.disconnect(); await server.close(); }
    }, 10_000);

    test("preserves an address for the same participant and rejects another participant's claim", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const clientId = crypto.randomUUID();
        const first = client(url, 1, "friends", ["websocket"], clientId);
        const intruder = client(url, 1, "friends");
        const resumed = client(url, 1, "friends", ["websocket"], clientId);
        try {
            const original = await ready(first);
            await expect(ready(intruder)).rejects.toThrow("address already in use");
            first.disconnect();
            const next = await ready(resumed);
            expect(next.node).toEqual(original.node);
        } finally { first.disconnect(); intruder.disconnect(); resumed.disconnect(); await server.close(); }
    });

    test("rejects a foreign browser origin and disconnects malformed frames", async () => {
        const server = createLanServer({ port: 0, allowedOrigins: ["https://allowed.example"] });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const foreign = client(url, 1, "friends");
        foreign.io.opts.extraHeaders = { Origin: "https://foreign.example" };
        const valid = client(url, 2, "friends");
        try {
            await expect(ready(foreign)).rejects.toThrow();
            await ready(valid);
            const disconnected = new Promise<void>(resolve => valid.once("disconnect", () => resolve()));
            valid.emit("frame", Uint8Array.of(255));
            await disconnected;
        } finally { foreign.disconnect(); valid.disconnect(); await server.close(); }
    });

    test("room capacity and per-participant rate limits reject excess work", async () => {
        const server = createLanServer({ port: 0, maxRooms: 1, maxPeersPerRoom: 1, maxFramesPerSecond: 1 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = client(url, 1, "limited"), extraPeer = client(url, 2, "limited"), extraRoom = client(url, 3, "overflow");
        try {
            await ready(a);
            await expect(ready(extraPeer)).rejects.toThrow("room is full");
            await expect(ready(extraRoom)).rejects.toThrow("room limit reached");
            const disconnected = new Promise<void>(resolve => a.once("disconnect", () => resolve()));
            a.emit("frame", encodeDatagram(PROTO_UDP, BROADCAST_NODE, 4000, 5000, Uint8Array.of(1)));
            a.emit("frame", encodeDatagram(PROTO_UDP, BROADCAST_NODE, 4000, 5000, Uint8Array.of(2)));
            await disconnected;
            expect(a.connected).toBe(false);
        } finally { a.disconnect(); extraPeer.disconnect(); extraRoom.disconnect(); await server.close(); }
    });

    test("reliable channels preserve several consecutive frame boundaries", async () => {
        const server = createLanServer({ port: 0 });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = client(url, 1, "tcp"), b = client(url, 2, "tcp");
        try {
            await Promise.all([ready(a), ready(b)]);
            const received: number[] = [];
            const complete = new Promise<void>(resolve => b.on("frame", input => {
                received.push(decodeDatagram(new Uint8Array(input))!.payload[0]);
                if (received.length === 20) resolve();
            }));
            for (let value = 0; value < 20; value++) a.emit("frame", encodeDatagram(PROTO_TCP, node(2), 4000, 5000, Uint8Array.of(value)));
            await complete;
            expect(received).toEqual(Array.from({ length: 20 }, (_, value) => value));
        } finally { a.disconnect(); b.disconnect(); await server.close(); }
    });
});
