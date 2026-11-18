import { createHmac } from "node:crypto";
import type { Socket } from "socket.io";
import type { ClientEvents, ServerEvents } from "./protocol";
import {
    readRoomCommsRequest, ROOM_TURN_URL_LIMIT, ROOM_VOICE_LEASE_MS, ROOM_VOICE_LIMIT, validRoomTurnUrl,
    type RoomCommsEvent, type RoomIceCredentials,
} from "./room-comms";

type Peer = Socket<ClientEvents, ServerEvents>;
export interface RoomVoiceMember { id: string; expires: number; ice?: RoomIceCredentials }

export class RoomTurnConfig {
    readonly #secret: string;
    readonly #urls: string[];
    readonly #ttl: number;
    readonly #allowPublic: boolean;

    private constructor(secret: string, urls: string[], ttl: number, allowPublic: boolean) {
        this.#secret = secret;
        this.#urls = urls;
        this.#ttl = ttl;
        this.#allowPublic = allowPublic;
    }

    static fromEnvironment(env: Record<string, string | undefined> = process.env): RoomTurnConfig | undefined {
        const { BS_LAN_TURN_URLS, BS_LAN_TURN_SECRET, BS_LAN_TURN_TTL_SECONDS, BS_LAN_TURN_ALLOW_PUBLIC } = env;
        if (BS_LAN_TURN_URLS === undefined && BS_LAN_TURN_SECRET === undefined &&
            BS_LAN_TURN_TTL_SECONDS === undefined && BS_LAN_TURN_ALLOW_PUBLIC === undefined) return;
        const urls = BS_LAN_TURN_URLS?.split(",").map(url => url.replace(/^[ \t]+|[ \t]+$/g, ""));
        if (!urls || urls.length > ROOM_TURN_URL_LIMIT || !urls.every(validRoomTurnUrl) || new Set(urls).size !== urls.length)
            throw new Error("BS_LAN_TURN_URLS must contain 1–4 distinct TURN URLs");
        if (!BS_LAN_TURN_SECRET || BS_LAN_TURN_SECRET.length < 32 || BS_LAN_TURN_SECRET.length > 512 ||
            /[^!-~]/.test(BS_LAN_TURN_SECRET))
            throw new Error("BS_LAN_TURN_SECRET must contain 32–512 visible ASCII characters");
        const ttl = BS_LAN_TURN_TTL_SECONDS === undefined ? 3600 : Number(BS_LAN_TURN_TTL_SECONDS);
        if (BS_LAN_TURN_TTL_SECONDS !== undefined &&
            (/[^0-9]/.test(BS_LAN_TURN_TTL_SECONDS) || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400))
            throw new Error("BS_LAN_TURN_TTL_SECONDS must be an integer from 60 through 86400");
        if (BS_LAN_TURN_ALLOW_PUBLIC !== undefined && BS_LAN_TURN_ALLOW_PUBLIC !== "false" && BS_LAN_TURN_ALLOW_PUBLIC !== "true")
            throw new Error("BS_LAN_TURN_ALLOW_PUBLIC must be true or false");
        return new RoomTurnConfig(BS_LAN_TURN_SECRET, urls, ttl, BS_LAN_TURN_ALLOW_PUBLIC === "true");
    }

    refresh(now: number, inviteExpirySeconds: number, subject: string, previous?: RoomIceCredentials): RoomIceCredentials | undefined {
        if (inviteExpirySeconds === Infinity && !this.#allowPublic) return;
        const expires = Math.min(Math.floor(now / 1000) + this.#ttl, inviteExpirySeconds);
        if (expires * 1000 <= now) return;
        const refreshLead = Math.min(60_000, this.#ttl * 250);
        if (previous && (previous.expiresAt - now > refreshLead || expires * 1000 <= previous.expiresAt)) return previous;
        const username = `${expires}:${subject}`;
        const credential = createHmac("sha1", this.#secret).update(username).digest("base64");
        return { urls: [...this.#urls], username, credential, expiresAt: expires * 1000 };
    }
}

export function attachRoomComms(
    socket: Peer, voice: Map<Peer, RoomVoiceMember>, roomPeers: () => Peer[],
    sender: string, send: (to: Peer, event: RoomCommsEvent) => void,
    inviteExpirySeconds: number, turn: RoomTurnConfig | undefined,
): void {
    let windowStart = 0;
    let chats = 0, joins = 0, signals = 0;
    const members = (now: number) => {
        for (const [peer, member] of voice) if (member.expires <= now || !peer.connected) voice.delete(peer);
        return [...voice];
    };
    const roster = (now: number, only?: Peer) => {
        const current = members(now);
        for (const [peer, member] of current) {
            if (only && only !== peer) continue;
            const ice = member.ice && member.ice.expiresAt > now ? member.ice : undefined;
            send(peer, { kind: "voice", self: member.id,
                peers: current.filter(([other]) => other !== peer).map(([, other]) => other.id),
                ...(ice && { ice }) });
        }
    };
    socket.on("roomComms", (...args) => {
        const request = args.length === 1 ? readRoomCommsRequest(args[0]) : undefined;
        if (!request) return;
        const now = Date.now();
        if (now - windowStart >= 1000) {
            windowStart = now;
            chats = joins = signals = 0;
        }
        switch (request.kind) {
            case "chat":
                if (chats >= 4) {
                    if (chats === 4) { chats++; send(socket, { kind: "error", code: "chatRate" }); }
                    return;
                }
                chats++;
                for (const peer of roomPeers()) send(peer, { kind: "chat", sender, text: request.text });
                return;
            case "voiceJoin": {
                if (joins >= 4) return;
                joins++;
                const current = members(now);
                const existing = voice.get(socket);
                if (!existing && current.length >= ROOM_VOICE_LIMIT) {
                    send(socket, { kind: "error", code: "voiceFull" });
                    return;
                }
                const member: RoomVoiceMember = existing ?? { id: crypto.randomUUID(), expires: 0 };
                member.expires = now + ROOM_VOICE_LEASE_MS;
                member.ice = turn?.refresh(now, inviteExpirySeconds, member.id, member.ice);
                voice.set(socket, member);
                roster(now, existing ? socket : undefined);
                return;
            }
            case "voiceLeave":
                if (voice.delete(socket)) roster(now);
                return;
            case "signal": {
                if (signals >= 64) return;
                signals++;
                const current = members(now);
                const self = voice.get(socket);
                const target = current.find(([peer, member]) => peer !== socket && member.id === request.to);
                if (self && target) send(target[0], { kind: "signal", to: request.to, from: self.id, payload: request.payload });
            }
        }
    });
    socket.once("disconnect", () => { if (voice.delete(socket)) roster(Date.now()); });
}
