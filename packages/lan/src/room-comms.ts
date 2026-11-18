export const ROOM_CHAT_BYTES = 512;
export const ROOM_SIGNAL_BYTES = 8192;
export const ROOM_VOICE_LIMIT = 6;
export const ROOM_VOICE_LEASE_MS = 20_000;

export type RoomCommsRequest =
    | { kind: "chat"; text: string }
    | { kind: "voiceJoin" | "voiceLeave" }
    | { kind: "signal"; to: string; payload: string };

export interface RoomIceCredentials {
    urls: string[];
    username: string;
    credential: string;
    expiresAt: number;
}

export type RoomCommsEvent =
    | { kind: "chat"; sender: string; text: string }
    | { kind: "voice"; self: string | null; peers: string[]; ice?: RoomIceCredentials }
    | { kind: "signal"; to: string; from: string; payload: string }
    | { kind: "error"; code: "voiceFull" | "chatRate" | "busy" };

export type RoomCommsUpdate = RoomCommsEvent | { kind: "available"; enabled: boolean; recovering?: boolean };

export const ROOM_TURN_URL_LIMIT = 4;
const encoder = new TextEncoder();

export function validRoomTurnUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 320) return false;
    const match = /^(turns?):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
    if (!match || match[0] !== value || (match[1] === "turns" && match[4] === "udp")) return false;
    if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return false;
    const host = match[2];
    if (host.startsWith("[")) {
        try { return new URL("http://" + host).hostname.length > 0; } catch { return false; }
    }
    return host.length <= 253 && host.replace(/\.$/, "").split(".").every(
        label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function readRoomIceCredentials(value: unknown): RoomIceCredentials | undefined {
    if (!value || typeof value !== "object") return;
    const ice = value as Record<string, unknown>;
    if (!Array.isArray(ice.urls) || ice.urls.length < 1 || ice.urls.length > ROOM_TURN_URL_LIMIT ||
        !ice.urls.every(validRoomTurnUrl) || new Set(ice.urls).size !== ice.urls.length ||
        typeof ice.username !== "string" || /^[0-9]{1,13}:[A-Za-z0-9_-]{1,64}$/.exec(ice.username)?.[0] !== ice.username ||
        typeof ice.credential !== "string" || ice.credential.length !== 28 || !/^[A-Za-z0-9+/]{27}=$/.test(ice.credential) ||
        typeof ice.expiresAt !== "number" || !Number.isSafeInteger(ice.expiresAt) || ice.expiresAt <= 0 ||
        Number(ice.username.split(":")[0]) * 1000 !== ice.expiresAt) return;
    return { urls: ice.urls, username: ice.username, credential: ice.credential, expiresAt: ice.expiresAt };
}
const validId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const bounded = (value: unknown, bytes: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= bytes && encoder.encode(value).length <= bytes;

function chatText(value: unknown): string | undefined {
    if (!bounded(value, ROOM_CHAT_BYTES) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return;
    return value.trim() || undefined;
}

export function readRoomCommsRequest(value: unknown): RoomCommsRequest | undefined {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (v.kind === "chat") {
        const text = chatText(v.text);
        if (text) return { kind: "chat", text };
    }
    if (v.kind === "voiceJoin" || v.kind === "voiceLeave") return { kind: v.kind };
    if (v.kind === "signal" && validId(v.to) && bounded(v.payload, ROOM_SIGNAL_BYTES))
        return { kind: "signal", to: v.to, payload: v.payload };
}

export function readRoomCommsEvent(value: unknown): RoomCommsEvent | undefined {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (v.kind === "chat" && typeof v.sender === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v.sender)) {
        const text = chatText(v.text);
        if (text) return { kind: "chat", sender: v.sender, text };
    }
    if (v.kind === "voice" && (validId(v.self) || v.self === null) && Array.isArray(v.peers)
        && v.peers.length < ROOM_VOICE_LIMIT && v.peers.every(validId)) {
        const ice = v.self === null ? undefined : readRoomIceCredentials(v.ice);
        return { kind: "voice", self: v.self, peers: v.peers, ...(ice && { ice }) };
    }
    if (v.kind === "signal" && validId(v.to) && validId(v.from) && bounded(v.payload, ROOM_SIGNAL_BYTES))
        return { kind: "signal", to: v.to, from: v.from, payload: v.payload };
    if (v.kind === "error" && (v.code === "busy" || v.code === "voiceFull" || v.code === "chatRate"))
        return { kind: "error", code: v.code };
}
