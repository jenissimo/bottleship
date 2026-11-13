import { createHmac, timingSafeEqual } from "node:crypto";

export interface GatewayPermissions { routes: string[]; udpListeners: string[]; tcpListeners: string[] }
export interface RoomPolicy { visibility?: "public" | "private"; gateway?: Partial<GatewayPermissions> }
export interface RoomAccessConfig {
    defaultVisibility?: "public" | "private";
    defaultGateway?: Partial<GatewayPermissions>;
    rooms?: Record<string, RoomPolicy>;
    inviteKeyEnv?: string;
    audience?: string;
    maxInviteTtlSeconds?: number;
}
export interface InviteClaims {
    version: 1; audience: string; room: string; expiresAt: number; gateway: GatewayPermissions;
}
export interface Admission { gateway: GatewayPermissions; expiresAt: number }
const name = /^[A-Za-z0-9_-]{1,64}$/;
const encoded = /^[A-Za-z0-9_-]+$/;
const fail = (): never => { throw new Error("LAN access denied"); };
const empty = (): GatewayPermissions => ({ routes: [], udpListeners: [], tcpListeners: [] });
function permissions(value: unknown, partial = false): GatewayPermissions {
    if (value === undefined && partial) return empty();
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !["routes", "udpListeners", "tcpListeners"].includes(k))) return fail();
    const list = (key: string, max: number): string[] => {
        const a = v[key] ?? (partial ? [] : undefined);
        if (!Array.isArray(a) || a.length > max || a.some(s => typeof s !== "string" || !name.test(s)) || new Set(a).size !== a.length) return fail();
        return [...a] as string[];
    };
    return { routes: list("routes", 128), udpListeners: list("udpListeners", 32), tcpListeners: list("tcpListeners", 32) };
}
function decode(s: string): Buffer {
    if (!encoded.test(s)) return fail();
    const b = Buffer.from(s, "base64url");
    if (b.toString("base64url") !== s) return fail();
    return b;
}
function merge(a: GatewayPermissions, b: GatewayPermissions): GatewayPermissions {
    return { routes: [...new Set([...a.routes, ...b.routes])], udpListeners: [...new Set([...a.udpListeners, ...b.udpListeners])], tcpListeners: [...new Set([...a.tcpListeners, ...b.tcpListeners])] };
}
export class RoomAccess {
    private readonly key?: Buffer;
    readonly audience: string;
    readonly maxInviteTtlSeconds: number;
    private readonly visibility: "public" | "private";
    private readonly gateway: GatewayPermissions;
    private readonly rooms: Map<string, {visibility: "public" | "private"; gateway: GatewayPermissions}>;
    constructor(config: RoomAccessConfig = {}, key?: Uint8Array) {
        if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(k=>!["defaultVisibility","defaultGateway","rooms","inviteKeyEnv","audience","maxInviteTtlSeconds"].includes(k))) throw new Error("Invalid room access configuration");
        this.visibility = config.defaultVisibility ?? "private";
        this.audience = config.audience ?? "bottleship-lan";
        this.maxInviteTtlSeconds = config.maxInviteTtlSeconds ?? 86400;
        if (!["public", "private"].includes(this.visibility) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(this.audience) ||
            !Number.isSafeInteger(this.maxInviteTtlSeconds) || this.maxInviteTtlSeconds < 1 || this.maxInviteTtlSeconds > 604800 ||
            config.inviteKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(config.inviteKeyEnv)) throw new Error("Invalid room access configuration");
        this.gateway = permissions(config.defaultGateway, true);
        if (config.rooms !== undefined && (!config.rooms || typeof config.rooms !== "object" || Array.isArray(config.rooms) || Object.keys(config.rooms).length > 1024)) throw new Error("Invalid room policies");
        this.rooms = new Map(Object.entries(config.rooms ?? {}).map(([room, policy]) => {
            if (!name.test(room) || !policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(k=>!["visibility","gateway"].includes(k)) ||
                policy.visibility !== undefined && !["public", "private"].includes(policy.visibility)) throw new Error("Invalid room policy");
            return [room, {visibility: policy.visibility ?? this.visibility, gateway: permissions(policy.gateway, true)}];
        }));
        if (key !== undefined) this.key = Buffer.from(key);
        else {
            const value = process.env[config.inviteKeyEnv ?? "BOTTLESHIP_LAN_INVITE_KEY"];
            if (value !== undefined) {
                if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invite key must be canonical base64");
                this.key = Buffer.from(value, "base64");
                if (this.key.toString("base64") !== value) throw new Error("Invite key must be canonical base64");
            }
        }
        if (this.key && (this.key.length < 32 || this.key.length > 64)) throw new Error("Invite key must contain 32..64 random bytes");
        if ((this.visibility === "private" || [...this.rooms.values()].some(p => p.visibility === "private")) && !this.key)
            throw new Error("Private rooms require a base64 invite key in inviteKeyEnv (default BOTTLESHIP_LAN_INVITE_KEY); pass --public-rooms or set roomAccess.defaultVisibility to \"public\" for name-only rooms");
    }
    sign(room: string, expiresAt: number, gateway: Partial<GatewayPermissions> = {}, now = Math.floor(Date.now() / 1000)): string {
        if (!this.key) throw new Error("Signing an invitation requires the invite key");
        if (!name.test(room)) throw new Error("Invitation room must use 1-64 letters, digits, '_' or '-'");
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > this.maxInviteTtlSeconds)
            throw new Error(`Invitation TTL must be 1..${this.maxInviteTtlSeconds} seconds (maxInviteTtlSeconds)`);
        const claims: InviteClaims = { version: 1, audience: this.audience, room, expiresAt, gateway: permissions(gateway, true) };
        const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
        if (body.length > 3500) return fail();
        const signature = createHmac("sha256", this.key).update("BottleShip LAN invite v1." + body).digest("base64url");
        return "bs1." + body + "." + signature;
    }
    authorize(room: string, invite: unknown, now = Math.floor(Date.now() / 1000)): Admission {
        const policy = this.rooms.get(room) ?? {visibility: this.visibility, gateway: this.gateway};
        if (invite === undefined && policy.visibility === "public") return {gateway: structuredClone(policy.gateway), expiresAt: Infinity};
        if (typeof invite !== "string" || invite.length > 4096 || !this.key) return fail();
        const parts = invite.split(".");
        if (parts.length !== 3 || parts[0] !== "bs1") return fail();
        const [body, signature] = [parts[1], decode(parts[2])];
        if (body.length > 3500 || signature.length !== 32) return fail();
        const expected = createHmac("sha256", this.key).update("BottleShip LAN invite v1." + body).digest();
        if (!timingSafeEqual(signature, expected)) return fail();
        let value: unknown;
        try { value = JSON.parse(decode(body).toString("utf8")); } catch { return fail(); }
        if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
        const v = value as InviteClaims;
        const claims: InviteClaims = {version: 1, audience: v.audience, room: v.room, expiresAt: v.expiresAt, gateway: permissions(v.gateway)};
        if (v.version !== 1 || v.audience !== this.audience || v.room !== room || !Number.isSafeInteger(v.expiresAt) ||
            v.expiresAt <= now || v.expiresAt - now > this.maxInviteTtlSeconds ||
            Buffer.from(JSON.stringify(claims)).toString("base64url") !== body) return fail();
        return {gateway: merge(policy.gateway, claims.gateway), expiresAt: claims.expiresAt};
    }
}
