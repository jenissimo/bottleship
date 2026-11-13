/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { io, type Socket } from "socket.io-client";
import { createPublicLanServer as createLanServer } from "./public-server";
import { LanStats, StatsToken, LAN_SERVER_VERSION } from "../src/stats";
import { encodeDatagram, PROTOCOL_VERSION, PROTO_UDP, type ClientEvents, type ServerEvents } from "../src/protocol";

type Client = Socket<ServerEvents, ClientEvents>;
const TOKEN = "stats-test-token-0123456789";
const DAY = 86_400_000;
const node = (host: number) => Uint8Array.of(2, 0, 0, 1, 0, host);
const id = (n: number) => "client-" + String(n).padStart(12, "0");
function counting(): () => Uint8Array { let next = 1; return () => new Uint8Array(32).fill(next++); }

describe("stats token", () => {
    test("requires exact bearer and hides its value", () => {
        expect(StatsToken.fromValue(undefined)).toBeUndefined();
        expect(StatsToken.fromValue("")).toBeUndefined();
        expect(() => StatsToken.fromValue("short")).toThrow("16..512");
        expect(() => StatsToken.fromValue("has a space in the token")).toThrow("16..512");
        const token = StatsToken.fromValue("0123456789abcdef-secret")!;
        expect(JSON.stringify(token)).not.toContain("secret");
        expect(token.verify("Bearer 0123456789abcdef-secret")).toBe(true);
        expect(token.verify("bearer 0123456789abcdef-secret")).toBe(true);
        for (const bad of [undefined, "", "Bearer", "Bearer ", "Basic 0123456789abcdef-secret", "Bearer0123456789abcdef-secret",
            "Bearer 0123456789abcdef-secreT", "Bearer 0123456789abcdef-secret-and-more"]) expect(token.verify(bad)).toBe(false);
    });
});

describe("stats counters", () => {
    test("relay totals, overflow and approximate", () => {
        const stats = new LanStats({ now: () => 0, uniqueCapacity: 3, salt: counting() });
        stats.relayed(100); stats.relayed(28);
        for (let n = 0; n < 10; n++) stats.joined(id(n));
        stats.joined(id(0));
        const limits = { maxConnections: 256, maxRooms: 128 };
        const snap = stats.snapshot(limits);
        expect(snap.traffic).toEqual({ framesRelayed: 2, bytesRelayed: 128 });
        expect(snap.joins.total).toBe(11);
        expect(snap.uniqueSessions).toEqual({ today: 3, yesterday: 0, approximate: true });
    });

    test("UTC midnight rotates days with an injected clock", () => {
        const start = 20_000 * DAY + DAY - 10;
        let now = start;
        const stats = new LanStats({ now: () => now, salt: counting() });
        const limits = { maxConnections: 1, maxRooms: 1 };
        stats.joined(id(1)); now++; stats.joined(id(2)); now++; stats.joined(id(1));
        expect(stats.snapshot(limits).uniqueSessions).toEqual({ today: 2, yesterday: 0, approximate: false });
        now = start + 10;
        expect(stats.snapshot(limits).uniqueSessions).toEqual({ today: 0, yesterday: 2, approximate: false });
        now++; stats.joined(id(1));
        expect(stats.snapshot(limits).uniqueSessions.today).toBe(1);
        now = start;
        expect(stats.snapshot(limits).uniqueSessions.today).toBe(1);
        now = start + 10 + 2 * DAY;
        const later = stats.snapshot(limits);
        expect(later.uniqueSessions).toEqual({ today: 0, yesterday: 0, approximate: false });
        expect(later.uptimeSeconds).toBe(Math.floor((10 + 2 * DAY) / 1000));
    });

    test("overflow flag follows the day into yesterday, then clears; salt failure keeps counting", () => {
        let now = 0;
        const stats = new LanStats({ now: () => now, uniqueCapacity: 2, salt: counting() });
        const limits = { maxConnections: 1, maxRooms: 1 };
        for (let n = 0; n < 5; n++) stats.joined(id(n));
        now = DAY;
        expect(stats.snapshot(limits).uniqueSessions).toEqual({ today: 0, yesterday: 2, approximate: true });
        now = 2 * DAY;
        expect(stats.snapshot(limits).uniqueSessions).toEqual({ today: 0, yesterday: 0, approximate: false });

        let first = true;
        const failing = new LanStats({ now: () => now, salt: () => { const salt = first ? new Uint8Array(32).fill(7) : undefined; first = false; return salt; } });
        now = 3 * DAY + 1;
        failing.joined(id(1)); failing.joined(id(1)); failing.joined(id(2));
        expect(failing.snapshot(limits).uniqueSessions.today).toBe(2);
        expect(() => new LanStats({ salt: () => undefined })).toThrow("salt");
        expect(() => new LanStats({ uniqueCapacity: 0 })).toThrow(RangeError);
    });
});

function client(url: string, host: number, room: string, clientId: string): Client {
    return io(url, { autoConnect: false, forceNew: true, reconnection: false, timeout: 2000, transports: ["websocket"],
        auth: { version: PROTOCOL_VERSION, room, node: Array.from(node(host)), clientId } });
}
function ready(socket: Client): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ready timed out")), 3000);
        socket.once("ready", () => { clearTimeout(timer); resolve(); });
        socket.once("connect_error", error => { clearTimeout(timer); reject(error); });
        socket.connect();
    });
}
async function get(url: string, authorization?: string) {
    const response = await fetch(url + "/stats", { headers: authorization === undefined ? {} : { Authorization: authorization } });
    return { status: response.status, headers: response.headers, body: await response.text() };
}
async function statsUntil(url: string, ready: (value: any) => boolean): Promise<any> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const value = JSON.parse((await get(url, "Bearer " + TOKEN)).body);
        if (ready(value)) return value;
        if (Date.now() > deadline) throw new Error("stats did not converge: " + JSON.stringify(value));
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
function raw(port: number, headers: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write("GET /stats HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n" + headers + "\r\n"));
        let data = ""; socket.setEncoding("latin1");
        socket.on("data", chunk => data += chunk); socket.on("end", () => resolve(data)); socket.on("error", reject);
    });
}

describe("GET /stats", () => {
    test("is absent without the environment variable", async () => {
        const server = createLanServer({ port: 0, statsTokenEnv: "BOTTLESHIP_LAN_STATS_TOKEN_UNSET_IN_TS_TESTS" });
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        try {
            expect((await get(url, "Bearer " + TOKEN)).status).toBe(404);
            expect((await fetch(url + "/health")).status).toBe(200);
        } finally { await server.close(); }
    });

    test("requires the bearer token and reports aggregates only", async () => {
        const env = "BOTTLESHIP_LAN_STATS_TOKEN_TS_TEST";
        process.env[env] = TOKEN;
        const server = (() => { try { return createLanServer({ port: 0, statsTokenEnv: env }); } finally { delete process.env[env]; } })();
        const port = await server.listen(), url = "http://127.0.0.1:" + port;
        const a = client(url, 1, "secret-room", "stats-client-aaaaaaaa"), b = client(url, 2, "secret-room", "stats-client-bbbbbbbb");
        try {
            for (const authorization of [undefined, "Bearer wrong-token-0123456789", "Basic c3RhdHM="]) {
                const denied = await get(url, authorization);
                expect(denied.status).toBe(401);
                expect(denied.body).toBe("");
                expect(denied.headers.get("cache-control")).toBe("no-store");
            }
            const duplicate = await raw(port, `Authorization: Bearer wrong\r\nAuthorization: Bearer ${TOKEN}\r\n`);
            expect(duplicate.startsWith("HTTP/1.1 401")).toBe(true);
            const ok = await fetch(url + "/stats", { headers: { Authorization: "Bearer " + TOKEN, Origin: "https://site.example" } });
            expect(ok.status).toBe(200);
            expect(ok.headers.get("cache-control")).toBe("no-store");
            expect([...ok.headers.keys()].some(key => key.startsWith("access-control-"))).toBe(false);
            const initial = await ok.json() as any;
            expect(initial.connections).toEqual({ current: 0, peak: 0 });
            expect(initial.limits).toEqual({ maxConnections: 256, maxRooms: 128 });
            expect(initial.version).toBe(LAN_SERVER_VERSION);

            await Promise.all([ready(a), ready(b)]);
            const joined = await statsUntil(url, v => v.connections.current === 2);
            expect(joined.rooms).toEqual({ active: 1, withTwoOrMore: 1, peakActive: 1 });
            expect(joined.joins).toEqual({ total: 2 });
            expect(joined.uniqueSessions).toEqual({ today: 2, yesterday: 0, approximate: false });

            const frame = encodeDatagram(PROTO_UDP, node(2), 4000, 5000, Uint8Array.of(1, 2, 3, 4, 5));
            const delivered = new Promise(resolve => b.once("frame", resolve));
            a.emit("frame", frame);
            await delivered;
            const relayed = await statsUntil(url, v => v.traffic.framesRelayed === 1);
            expect(relayed.traffic.bytesRelayed).toBe(frame.byteLength);

            a.disconnect();
            const left = await statsUntil(url, v => v.connections.current === 1);
            expect(left.connections.peak).toBe(2);
            expect(left.rooms).toEqual({ active: 1, withTwoOrMore: 0, peakActive: 1 });
            const text = JSON.stringify(left);
            expect(text).not.toContain("secret-room");
            expect(text).not.toContain("stats-client");
            expect(Object.keys(left).sort()).toEqual(["connections", "joins", "limits", "rooms", "traffic", "uniqueSessions", "uptimeSeconds", "version"]);
        } finally { a.disconnect(); b.disconnect(); await server.close(); }
    }, 15_000);
});
