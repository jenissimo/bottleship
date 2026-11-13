import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Aggregate operator counters for GET /stats; parity with lan-rust core/src/stats.rs.
 *
 * Only totals leave this module: no room names, client identities, addresses or
 * hashes. Daily uniqueness keeps truncated HMACs of handshake client IDs under a
 * random in-memory salt replaced at each UTC midnight; neither the salt nor the
 * hashes are persisted, logged or rendered. Relay paths pay one increment. */
export const DEFAULT_UNIQUE_CAPACITY = 100_000;
export const DEFAULT_STATS_TOKEN_ENV = "BOTTLESHIP_LAN_STATS_TOKEN";
/** Package version reported by /stats (packages/lan/package.json). */
export const LAN_SERVER_VERSION = "0.1.0";
const DAY_MS = 86_400_000;
const TOKEN_ERROR = "Stats token must contain 16..512 visible ASCII characters";

/** Bearer token for GET /stats. Only its SHA-256 digest is retained. */
export class StatsToken {
    private constructor(private readonly digest: Buffer) {}
    /** Unset or empty disables the endpoint. The error never contains the value. */
    static fromValue(value: string | undefined): StatsToken | undefined {
        if (value === undefined || value === "") return undefined;
        if (!/^[\x21-\x7e]{16,512}$/.test(value)) throw new Error(TOKEN_ERROR);
        return new StatsToken(createHash("sha256").update(value, "latin1").digest());
    }
    /** Checks a raw Authorization header (`Bearer <token>`). Both sides are hashed
     * first, so the comparison is fixed-length, constant-time and length-blind. */
    verify(header: string | undefined): boolean {
        if (typeof header !== "string" || header.length < 7 || !/^bearer$/i.test(header.slice(0, 6)) || header[6] !== " ") return false;
        const presented = header.slice(7).replace(/^[ \t]+|[ \t\r\n]+$/g, "");
        return timingSafeEqual(createHash("sha256").update(presented, "latin1").digest(), this.digest);
    }
    toJSON(): string { return "StatsToken(..)"; }
}

export interface LanStatsOptions {
    /** Unix milliseconds; injectable for tests. */
    now?: () => number;
    uniqueCapacity?: number;
    /** 32-byte daily salt source; undefined means the source failed. */
    salt?: () => Uint8Array | undefined;
}
const osSalt = (): Uint8Array | undefined => { try { return randomBytes(32); } catch { return undefined; } };

export class LanStats {
    private readonly now: () => number;
    private readonly capacity: number;
    private readonly saltSource: () => Uint8Array | undefined;
    private readonly startedAt: number;
    private connections = 0; private peakConnections = 0;
    private activeRooms = 0; private roomsWithTwoOrMore = 0; private peakActiveRooms = 0;
    private joins = 0; private framesRelayed = 0; private bytesRelayed = 0;
    private day: number; private salt: Buffer;
    private today = new Set<string>(); private todayApproximate = false;
    private yesterday = 0; private yesterdayApproximate = false;
    constructor(options: LanStatsOptions = {}) {
        this.now = options.now ?? Date.now;
        this.capacity = options.uniqueCapacity ?? DEFAULT_UNIQUE_CAPACITY;
        if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new RangeError("Stats uniqueness capacity must be positive");
        this.saltSource = options.salt ?? osSalt;
        const salt = this.saltSource();
        if (!salt) throw new Error("Stats salt source is unavailable");
        this.salt = Buffer.from(salt);
        this.startedAt = this.now();
        this.day = Math.floor(this.startedAt / DAY_MS);
    }
    private roll(now: number): void {
        const day = Math.floor(now / DAY_MS);
        // A clock that steps backwards keeps the current day rather than reopening one.
        if (!(day > this.day)) return;
        if (day === this.day + 1) { this.yesterday = this.today.size; this.yesterdayApproximate = this.todayApproximate; }
        else { this.yesterday = 0; this.yesterdayApproximate = false; }
        this.today = new Set(); this.todayApproximate = false;
        const fresh = this.saltSource();
        // The previous salt never left memory; chaining keeps uniqueness keyed by an
        // unknown secret even when the OS source fails at midnight.
        this.salt = fresh ? Buffer.from(fresh) : createHmac("sha256", this.salt)
            .update("BottleShip LAN stats salt rotation.").update(dayBytes(day)).digest();
        this.day = day;
    }
    /** Publishes the participant count; the peak never decreases. */
    setConnections(current: number): void {
        this.connections = current; this.peakConnections = Math.max(this.peakConnections, current);
    }
    /** Liveness change of one room from `before` to `after` live participants. */
    roomLiveness(before: number, after: number): void {
        if (before < 1 && after >= 1) this.activeRooms++; else if (before >= 1 && after < 1) this.activeRooms = Math.max(0, this.activeRooms - 1);
        if (before < 2 && after >= 2) this.roomsWithTwoOrMore++; else if (before >= 2 && after < 2) this.roomsWithTwoOrMore = Math.max(0, this.roomsWithTwoOrMore - 1);
        this.peakActiveRooms = Math.max(this.peakActiveRooms, this.activeRooms);
    }
    /** One accepted room join. The client ID is reduced to a salted digest at once. */
    joined(clientId: string): void {
        this.joins++;
        this.roll(this.now());
        const key = createHmac("sha256", this.salt).update("BottleShip LAN stats session v1.").update(clientId, "utf8")
            .digest().subarray(0, 16).toString("base64");
        if (this.today.has(key)) return;
        // Budget before insertion: a full set stops growing and reports a lower bound.
        if (this.today.size >= this.capacity) { this.todayApproximate = true; return; }
        this.today.add(key);
    }
    /** One room frame accepted for delivery to one recipient. */
    relayed(bytes: number): void { this.framesRelayed++; this.bytesRelayed += bytes; }
    snapshot(limits: {maxConnections: number; maxRooms: number}) {
        const now = this.now();
        this.roll(now);
        return {
            uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
            connections: {current: this.connections, peak: this.peakConnections},
            rooms: {active: this.activeRooms, withTwoOrMore: this.roomsWithTwoOrMore, peakActive: this.peakActiveRooms},
            joins: {total: this.joins},
            uniqueSessions: {today: this.today.size, yesterday: this.yesterday, approximate: this.todayApproximate || this.yesterdayApproximate},
            traffic: {framesRelayed: this.framesRelayed, bytesRelayed: this.bytesRelayed},
            limits: {maxConnections: limits.maxConnections, maxRooms: limits.maxRooms},
            version: LAN_SERVER_VERSION,
        };
    }
}
function dayBytes(day: number): Buffer {
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(day)); return bytes;
}
