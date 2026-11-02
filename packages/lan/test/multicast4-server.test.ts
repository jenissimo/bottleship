/// <reference types="bun" />
import { expect, test } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { createLanServer } from "../src/server";
import { encodeDatagram, PROTO_UDP, type ClientEvents, type ServerEvents, type LanReady } from "../src/protocol";

type Client = Socket<ServerEvents, ClientEvents>;
const node = (id: number) => Uint8Array.of(2, 0, 0, 1, 0, id);
const G = Uint8Array.of(239, 255, 42, 17), H = Uint8Array.of(239, 255, 42, 18);
/** Independent encoder keeps the expected wire contract separate from the implementation. */
function multicast(group = G, payload = Uint8Array.of(7), iface = 2, ttl = 1): Uint8Array {
    const bytes = new Uint8Array(20 + payload.length), view = new DataView(bytes.buffer);
    bytes.set([3, 1, 2, 3, ...group]); view.setUint16(8, 4000); view.setUint16(10, 5000);
    bytes.set(group, 12); bytes[16] = iface; bytes[17] = ttl; bytes.set(payload, 20);
    return bytes;
}
function client(url: string, id: number, room: string, transport: "websocket" | "polling"): Client {
    return io(url, {autoConnect: false, forceNew: true, reconnection: false, timeout: 2000,
        transports: [transport], auth: {version: 1, room, node: [...node(id)], clientId: "multicast-test-" + id.toString().padStart(8, "0")}});
}
async function ready(socket: Client): Promise<LanReady> {
    const result = new Promise<LanReady>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(Error("readiness timeout")); }, 2500);
        const success = (info: LanReady) => { cleanup(); resolve(info); };
        const failure = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => { clearTimeout(timeout); socket.off("ready", success); socket.off("connect_error", failure); };
        socket.once("ready", success); socket.once("connect_error", failure);
    });
    socket.connect(); return result;
}
function nextFrame(socket: Client, predicate = (_bytes: Uint8Array) => true): Promise<{bytes: Uint8Array; generation?: number}> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("frame", receive); reject(Error("frame timeout")); }, 2500);
        const receive = (input: Uint8Array, generation?: number) => {
            const bytes = new Uint8Array(input);
            if (predicate(bytes)) { clearTimeout(timer); socket.off("frame", receive); resolve({bytes, generation}); }
        };
        socket.on("frame", receive);
    });
}
function disconnected(socket: Client): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("disconnect", done); reject(Error("disconnect timeout")); }, 2500);
        const done = () => { clearTimeout(timer); resolve(); };
        socket.once("disconnect", done);
    });
}
async function barrier(a: Client, b: Client): Promise<void> {
    const done = nextFrame(b, bytes => bytes[0] === 2 && bytes[12] === 222);
    a.emit("frame", encodeDatagram(PROTO_UDP, node(2), 4000, 5000, Uint8Array.of(222)));
    await done;
}
for (const transport of ["websocket", "polling"] as const) {
    test(transport + " multicast retains exact groups/source and isolates room/local-only traffic", async () => {
        const server = createLanServer({port: 0}), url = "http://127.0.0.1:" + await server.listen();
        const a = client(url, 1, "group-room", transport), b = client(url, 2, "group-room", transport),
            c = client(url, 3, "different-room", transport);
        try {
            const infos = await Promise.all([ready(a), ready(b), ready(c)]);
            expect((infos[0] as LanReady & {udpMulticast4V1?: boolean}).udpMulticast4V1).toBe(true);
            const received: {bytes: Uint8Array; generation?: number}[] = [];
            let reflected = 0, leaked = 0;
            b.on("frame", (input, generation) => received.push({bytes: new Uint8Array(input), generation}));
            a.on("frame", () => reflected++); c.on("frame", () => leaked++);
            const maximum = new Uint8Array(65507); maximum[0] = 1; maximum[maximum.length - 1] = 255;
            a.emit("frame", multicast(G, maximum), 37);
            a.emit("frame", multicast(H, Uint8Array.of(9)), 37);
            a.emit("frame", multicast(G, Uint8Array.of(88), 1, 1), 37);
            a.emit("frame", multicast(G, Uint8Array.of(99), 2, 0), 37);
            await barrier(a, b);
            const packets = received.filter(row => row.bytes[0] === 3);
            expect(packets.length).toBe(2);
            expect(packets[0].bytes.subarray(2, 8)).toEqual(node(1));
            expect(packets[0].bytes.subarray(12, 16)).toEqual(G);
            expect(packets[1].bytes.subarray(12, 16)).toEqual(H);
            expect(packets[0].bytes.subarray(20)).toEqual(maximum);
            expect([...packets[0].bytes.subarray(16, 20)]).toEqual([2, 1, 0, 0]);
            expect(packets.every(row => row.generation === undefined)).toBe(true);
            expect(leaked).toBe(0); expect(reflected).toBe(0);
            expect(a.connected && b.connected).toBe(true);
        } finally { a.disconnect(); b.disconnect(); c.disconnect(); await server.close(); }
    }, 12000);

    test(transport + " multicast source generations cannot revive a released/reused port", async () => {
        const server = createLanServer({port: 0}), url = "http://127.0.0.1:" + await server.listen();
        const a = client(url, 1, "epochs", transport), b = client(url, 2, "epochs", transport);
        try {
            await Promise.all([ready(a), ready(b)]);
            const values: number[] = []; b.on("frame", bytes => { if (bytes[0] === 3) values.push(bytes[20]); });
            a.emit("frame", multicast(G, Uint8Array.of(1)), 1);
            a.emit("releasePort", 1, 5000, 1);
            a.emit("frame", multicast(G, Uint8Array.of(90)), 1);
            a.emit("frame", multicast(G, Uint8Array.of(91)));
            a.emit("frame", multicast(G, Uint8Array.of(2)), 2);
            a.emit("releasePort", 1, 5000, 1);
            a.emit("frame", multicast(G, Uint8Array.of(3)), 2);
            a.emit("leaseUdpPeer", 1, {proto: 1, localPort: 5000, bindingGeneration: 3, node: [2, 1, 127, 0, 0, 1], remotePort: 9000});
            a.emit("frame", multicast(G, Uint8Array.of(92)), 2);
            a.emit("frame", multicast(G, Uint8Array.of(4)), 3);
            await barrier(a, b);
            expect(values).toEqual([1, 2, 3, 4]);
            expect(a.connected && b.connected).toBe(true);
        } finally { a.disconnect(); b.disconnect(); await server.close(); }
    }, 12000);

    test(transport + " multicast rejects forged directions and malformed headers", async () => {
        const server = createLanServer({port: 0}), url = "http://127.0.0.1:" + await server.listen();
        const changes: ((bytes: Uint8Array) => Uint8Array)[] = [
            bytes => { bytes.set(node(9), 2); return bytes; },
            bytes => { bytes.fill(255, 2, 8); return bytes; },
            bytes => { bytes[3] = 1; return bytes; },
            bytes => { bytes[7] ^= 1; return bytes; },
            bytes => { bytes[12] = 127; return bytes; },
            bytes => { bytes[16] = 3; return bytes; },
            bytes => { bytes[18] = 1; return bytes; },
            bytes => { bytes[1] = 4; return bytes; },
            bytes => bytes.subarray(0, 19),
            _bytes => multicast(G, new Uint8Array(65508)),
        ];
        try {
            for (let i = 0; i < changes.length; i++) {
                const a = client(url, i + 1, "invalid", transport);
                try { await ready(a); const done = disconnected(a); a.emit("frame", changes[i](multicast())); await done; expect(a.connected).toBe(false); }
                finally { a.disconnect(); }
            }
        } finally { await server.close(); }
    }, 20000);

    test(transport + " multicast egress drop is bounded and rate limits still apply", async () => {
        const server = createLanServer({port: 0, maxBufferedBytes: 64}), url = "http://127.0.0.1:" + await server.listen();
        const a = client(url, 1, "budget", transport), b = client(url, 2, "budget", transport);
        try {
            await Promise.all([ready(a), ready(b)]);
            const values: number[] = []; b.on("frame", bytes => { if (bytes[0] === 3) values.push(bytes[20]); });
            a.emit("frame", multicast(G, new Uint8Array(100)));
            a.emit("frame", multicast(H, Uint8Array.of(9)));
            await barrier(a, b);
            expect(values).toEqual([9]); expect(a.connected && b.connected).toBe(true);
        } finally { a.disconnect(); b.disconnect(); await server.close(); }
        const limited = createLanServer({port: 0, maxFramesPerSecond: 1});
        const sender = client("http://127.0.0.1:" + await limited.listen(), 1, "rate", transport);
        try {
            await ready(sender); const done = disconnected(sender);
            sender.emit("frame", multicast()); sender.emit("frame", multicast());
            await done; expect(sender.connected).toBe(false);
        } finally { sender.disconnect(); await limited.close(); }
    }, 12000);
}
