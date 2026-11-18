import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { createPublicLanServer } from "./public-server";
import type { ClientEvents, LanReady, ServerEvents } from "../src/protocol";
import { RoomAccess } from "../src/access";
import { RoomTurnConfig } from "../src/room-comms-server";
import { readRoomCommsEvent, type RoomCommsEvent, type RoomIceCredentials } from "../src/room-comms";

type Client = Socket<ServerEvents, ClientEvents>;
type Relay = { url: string; close(): Promise<void> };

type TurnMode = "off" | "invites" | "public";
const inviteKey = Buffer.alloc(32, 0x4b);
const testInviteEnv = "BS_ROOM_COMMS_FIXTURE_INVITE_KEY";
const testTurnSecret = "fixture-turn-secret-only-for-local-tests";
const turnUrls = ["turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"];
const turnEnv = {
    BS_LAN_TURN_URLS: turnUrls.join(", "),
    BS_LAN_TURN_SECRET: testTurnSecret,
    BS_LAN_TURN_TTL_SECONDS: "60",
};

async function startReference(mode: TurnMode = "off"): Promise<Relay> {
    const turn = RoomTurnConfig.fromEnvironment(mode === "off" ? {} : {
        ...turnEnv, BS_LAN_TURN_ALLOW_PUBLIC: String(mode === "public"),
    });
    process.env[testInviteEnv] = inviteKey.toString("base64");
    const server = (() => {
        try {
            return createPublicLanServer({ port: 0, roomTurn: turn ?? false,
                roomAccess: { defaultVisibility: "public", inviteKeyEnv: testInviteEnv } });
        } finally {
            delete process.env[testInviteEnv];
        }
    })();
    return { url: `http://127.0.0.1:${await server.listen()}`, close: () => server.close() };
}

async function startRust(binary: string, mode: TurnMode = "off"): Promise<Relay> {
    const child = Bun.spawn([binary, "--host", "127.0.0.1", "--port", "0", "--public-rooms"],
        { stdout: "pipe", stderr: "inherit", env: {
            SystemRoot: process.env.SystemRoot,
            BOTTLESHIP_LAN_INVITE_KEY: inviteKey.toString("base64"),
            ...(mode === "off" ? {} : { ...turnEnv, BS_LAN_TURN_ALLOW_PUBLIC: String(mode === "public") }),
        } });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timer = setTimeout(() => child.kill(), 5000);
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) throw new Error("Rust relay exited before readiness");
            buffer += decoder.decode(value, { stream: true });
            const line = buffer.split("\n").find(row => row.startsWith("{") && row.includes('"port"'));
            if (!line) continue;
            const { port } = JSON.parse(line) as { port: number };
            return { url: `http://127.0.0.1:${port}`, close: async () => { child.kill(); await child.exited; } };
        }
    } catch (error) {
        child.kill();
        await child.exited;
        throw error;
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

function open(url: string, room: string, index: number, polling: boolean, comms = true, invite?: string) {
    const socket: Client = io(url, {
        autoConnect: false, forceNew: true, reconnection: false,
        transports: polling ? ["polling"] : ["websocket"],
        auth: { version: 1, room, clientId: crypto.randomUUID(), node: [2, 0, 0, 1, 0, index], roomCommsV1: comms, invite },
    });
    const inbox: RoomCommsEvent[] = [];
    socket.on("roomComms", event => inbox.push(event));
    const ready = new Promise<LanReady>((resolve, reject) => {
        socket.once("ready", resolve);
        socket.once("connect_error", reject);
    });
    socket.connect();
    return { socket, inbox, ready };
}

async function waitEvent<T extends RoomCommsEvent["kind"]>(
    inbox: RoomCommsEvent[], kind: T, match: (event: Extract<RoomCommsEvent, { kind: T }>) => boolean = () => true,
): Promise<Extract<RoomCommsEvent, { kind: T }>> {
    const end = Date.now() + 3500;
    do {
        const index = inbox.findIndex(event => event.kind === kind && match(event as Extract<RoomCommsEvent, { kind: T }>));
        if (index !== -1) return inbox.splice(index, 1)[0] as Extract<RoomCommsEvent, { kind: T }>;
        await Bun.sleep(10);
    } while (Date.now() < end);
    throw new Error(`Timed out waiting for ${kind}`);
}

const variants: [string, (mode?: TurnMode) => Promise<Relay>][] = [["TypeScript", startReference]];
if (process.env.BS_TEST_RUST_ROOM_RELAY) {
    const binary = process.env.BS_TEST_RUST_ROOM_RELAY;
    variants.push(["Rust", mode => startRust(binary, mode)]);
}

for (const [name, start] of variants) {
    for (const polling of [false, true]) test(`${name} room chat and voice on ${polling ? "polling" : "WebSocket"}`, async () => {
        const relay = await start();
        const a = open(relay.url, "friends", 1, polling);
        const b = open(relay.url, "friends", 2, polling);
        const other = open(relay.url, "other", 3, polling);
        const old = open(relay.url, "friends", 4, polling, false);
        try {
            for (const ready of await Promise.all([a.ready, b.ready, other.ready, old.ready]))
                expect(ready.roomCommsV1).toBe(true);
            // A client-supplied sender cannot override the admitted LAN identity.
            a.socket.emit("roomComms", { kind: "chat", text: "Hello ✓", sender: "10.1.0.2" } as any);
            expect(await waitEvent(a.inbox, "chat")).toEqual({ kind: "chat", sender: "10.1.0.1", text: "Hello ✓" });
            expect(await waitEvent(b.inbox, "chat")).toEqual({ kind: "chat", sender: "10.1.0.1", text: "Hello ✓" });
            old.socket.emit("roomComms", { kind: "chat", text: "opted out" });
            other.socket.emit("roomComms", { kind: "voiceJoin" });
            const foreign = (await waitEvent(other.inbox, "voice")).self!;
            a.socket.emit("roomComms", { kind: "voiceJoin" });
            const first = await waitEvent(a.inbox, "voice");
            expect(first.peers).toEqual([]);
            expect(first.ice).toBeUndefined();
            b.socket.emit("roomComms", { kind: "voiceJoin" });
            const joined = await waitEvent(b.inbox, "voice");
            expect(joined.peers).toEqual([first.self!]);
            expect((await waitEvent(a.inbox, "voice")).peers).toEqual([joined.self!]);
            a.socket.emit("roomComms", { kind: "signal", to: foreign, payload: "foreign" });
            a.socket.emit("roomComms", { kind: "signal", to: joined.self!, payload: "offer" });
            expect(await waitEvent(b.inbox, "signal")).toEqual({ kind: "signal", to: joined.self!, from: first.self!, payload: "offer" });
            b.socket.emit("roomComms", { kind: "voiceLeave" });
            expect((await waitEvent(a.inbox, "voice")).peers).toEqual([]);
            b.socket.emit("roomComms", { kind: "voiceJoin" });
            const rejoined = await waitEvent(b.inbox, "voice");
            expect(rejoined.self).not.toBe(joined.self);
            a.socket.emit("roomComms", { kind: "signal", to: joined.self!, payload: "stale" });
            a.socket.emit("roomComms", { kind: "signal", to: rejoined.self!, payload: "current" });
            expect((await waitEvent(b.inbox, "signal")).payload).toBe("current");
            b.socket.disconnect();
            expect((await waitEvent(a.inbox, "voice", event => event.peers.length === 0)).peers).toEqual([]);
            expect(other.inbox).toEqual([]);
            expect(old.inbox).toEqual([]);
            expect(a.inbox.some(event => event.kind === "chat")).toBe(false);
        } finally {
            for (const peer of [a, b, other, old]) peer.socket.disconnect();
            await relay.close();
        }
    }, 15_000);

    test(`${name} scopes TURN credentials to each admitted voice member and invitation expiry`, async () => {
        const relay = await start("invites");
        const now = Math.floor(Date.now() / 1000);
        const inviteExpiry = now + 45;
        const access = new RoomAccess({ defaultVisibility: "public" }, inviteKey);
        const invite = access.sign("friends", inviteExpiry);
        const a = open(relay.url, "friends", 1, false, true, invite);
        const b = open(relay.url, "friends", 2, false, true, invite);
        const anonymous = open(relay.url, "friends", 3, false);
        const other = open(relay.url, "other", 1, false, true, access.sign("other", now + 180));
        try {
            await Promise.all([a.ready, b.ready, anonymous.ready, other.ready]);
            a.socket.emit("roomComms", { kind: "voiceJoin" });
            const first = await waitEvent(a.inbox, "voice");
            expect(first.ice?.expiresAt).toBe(inviteExpiry * 1000);
            verifyTicket(first.ice!, first.self!);
            expect(b.inbox).toEqual([]);
            expect(other.inbox).toEqual([]);

            b.socket.emit("roomComms", { kind: "voiceJoin" });
            const second = await waitEvent(b.inbox, "voice");
            verifyTicket(second.ice!, second.self!);
            expect(second.ice?.username).not.toBe(first.ice?.username);
            expect(second.ice?.credential).not.toBe(first.ice?.credential);
            expect((await waitEvent(a.inbox, "voice")).ice).toEqual(first.ice);

            anonymous.socket.emit("roomComms", { kind: "voiceJoin" });
            expect((await waitEvent(anonymous.inbox, "voice")).ice).toBeUndefined();
            expect((await waitEvent(b.inbox, "voice")).ice).toEqual(second.ice);
            await waitEvent(a.inbox, "voice");

            a.socket.emit("roomComms", { kind: "voiceJoin" });
            expect((await waitEvent(a.inbox, "voice")).ice).toEqual(first.ice);
            other.socket.emit("roomComms", { kind: "voiceJoin" });
            const foreign = await waitEvent(other.inbox, "voice");
            expect(foreign.peers).toEqual([]);
            verifyTicket(foreign.ice!, foreign.self!);
            expect(foreign.ice?.credential).not.toBe(first.ice?.credential);

            a.socket.emit("roomComms", { kind: "voiceLeave" });
            a.socket.emit("roomComms", { kind: "voiceJoin" });
            const rejoined = await waitEvent(a.inbox, "voice");
            expect(rejoined.self).not.toBe(first.self);
            verifyTicket(rejoined.ice!, rejoined.self!);
            expect(rejoined.ice?.credential).not.toBe(first.ice?.credential);
            expect(other.inbox).toEqual([]);
        } finally {
            for (const peer of [a, b, anonymous, other]) peer.socket.disconnect();
            await relay.close();
        }
    }, 15_000);

    test(`${name} explicitly opted-in name-only room gets TURN over polling`, async () => {
        const relay = await start("public");
        const peer = open(relay.url, "public", 1, true);
        try {
            await peer.ready;
            peer.socket.emit("roomComms", { kind: "voiceJoin" });
            const event = await waitEvent(peer.inbox, "voice");
            verifyTicket(event.ice!, event.self!);
            expect(event.ice!.expiresAt - Date.now()).toBeGreaterThan(50_000);
            expect(event.ice!.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
        } finally {
            peer.socket.disconnect();
            await relay.close();
        }
    }, 15_000);
}

function verifyTicket(ice: RoomIceCredentials, self: string): void {
    expect(ice.urls).toEqual(turnUrls);
    expect(ice.username).toStartWith(String(ice.expiresAt / 1000) + ":");
    expect(ice.username.endsWith(self)).toBe(true);
    expect(ice.credential).toBe(createHmac("sha1", testTurnSecret).update(ice.username).digest("base64"));
    expect(readRoomCommsEvent({ kind: "voice", self, peers: [], ice })).toEqual({ kind: "voice", self, peers: [], ice });
}

test("TURN startup validates operator input and redacts bad values", () => {
    expect(RoomTurnConfig.fromEnvironment({})).toBeUndefined();
    for (const [key, value] of [
        ["BS_LAN_TURN_URLS", "turn:fixture-url-user:fixture-url-password@example.test"],
        ["BS_LAN_TURN_URLS", "turn:example.test:0"],
        ["BS_LAN_TURN_URLS", "turns:example.test?transport=udp"],
        ["BS_LAN_TURN_SECRET", "bad-fixture-secret"],
        ["BS_LAN_TURN_TTL_SECONDS", "59"],
        ["BS_LAN_TURN_TTL_SECONDS", "0x3c"],
        ["BS_LAN_TURN_ALLOW_PUBLIC", "yes"],
    ]) {
        let message = "";
        try { RoomTurnConfig.fromEnvironment({ ...turnEnv, [key]: value }); }
        catch (error) { message = String(error); }
        expect(message).toContain(key);
        expect(message).not.toContain(value);
    }
    const signed = RoomTurnConfig.fromEnvironment({ ...turnEnv, BS_LAN_TURN_URLS: "turn:[::1]:3478?transport=udp" });
    expect(signed).toBeDefined();
});

test("TURN credentials rotate before expiry and respect signed invite expiry", () => {
    const turn = RoomTurnConfig.fromEnvironment(turnEnv)!;
    const now = 2_000_000_000_500;
    expect(turn.refresh(now, Infinity, "voice-id")).toBeUndefined();
    const capped = turn.refresh(now, 2_000_000_045, "voice-id")!;
    expect(capped.expiresAt).toBe(2_000_000_045_000);
    expect(turn.refresh(capped.expiresAt - 1, 2_000_000_045, "voice-id", capped)).toBe(capped);
    expect(turn.refresh(capped.expiresAt, 2_000_000_045, "voice-id", capped)).toBeUndefined();
    const first = turn.refresh(now, 2_000_000_180, "voice-id")!;
    expect(turn.refresh(now + 40_000, 2_000_000_180, "voice-id", first)).toBe(first);
    const refreshed = turn.refresh(now + 45_000, 2_000_000_180, "voice-id", first)!;
    expect(refreshed.expiresAt).toBe(first.expiresAt + 45_000);
    expect(refreshed.credential).not.toBe(first.credential);
});

test("room wire reader keeps the roster and drops malformed TURN data", () => {
    const turn = RoomTurnConfig.fromEnvironment(turnEnv)!;
    const roster = { kind: "voice", self: "voice-id", peers: ["friend"] };
    const ice = turn.refresh(2_000_000_000_000, 2_000_000_180, roster.self)!;
    expect(readRoomCommsEvent({ ...roster, ice })).toEqual({ ...roster, ice });
    expect(readRoomCommsEvent({ ...roster, ice: { ...ice, urls: ["turn:guest@turn.example.test"] } })).toEqual(roster);
    expect(readRoomCommsEvent({ ...roster, ice: { ...ice, expiresAt: ice.expiresAt + 1000 } })).toEqual(roster);
    expect(readRoomCommsEvent({ ...roster, self: null, ice })).toEqual({ ...roster, self: null });
});
