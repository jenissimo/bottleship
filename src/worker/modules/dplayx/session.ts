import { LanNetwork, type LanDatagram, type LanEndpoint } from "../../net/lan-network";
import { PROTO_DIRECTPLAY } from "../../net/netplay-wire";

export const DP = {
    OK: 0, INVALIDPARAMS: 0x80070057, OUTOFMEMORY: 0x8007000e, UNSUPPORTED: 0x80004001,
    ALREADYINITIALIZED: 0x88770005, ACCESSDENIED: 0x8877000a, ACTIVEPLAYERS: 0x88770014,
    BUFFERTOOSMALL: 0x8877001e, CANTCREATEGROUP: 0x88770032, CANTCREATEPLAYER: 0x8877003c,
    INVALIDFLAGS: 0x88770078, INVALIDPLAYER: 0x88770096, INVALIDGROUP: 0x8877009b,
    NOMESSAGES: 0x887700be, NOSESSIONS: 0x887700dc, TIMEOUT: 0x887700f0,
    UNAVAILABLE: 0x887700fa, SESSIONLOST: 0x88770136, UNINITIALIZED: 0x88770140,
    CONNECTING: 0x8877015e, CONNECTIONLOST: 0x88770168, PENDING: 0x8000000a,
    UNKNOWNMESSAGE: 0x88770172, CANCELFAILED: 0x8877017c, INVALIDPRIORITY: 0x88770186,
    CANCELLED: 0x8877019a, INVALIDPASSWORD: 0x88770154,
} as const;
export const DPLAY_MAX_MESSAGE = 60000;
const DISCOVERY_PORT = 47624;
const MAX_STATE = 1024 * 1024;
const CHUNK = 60000;
const MAGIC = 0x314c5044;
const BROADCAST = new Uint8Array(6).fill(255);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const EMPTY: Uint8Array = new Uint8Array();

export interface SessionDesc {
    instance: string;
    application: string;
    flags: number;
    maxPlayers: number;
    name: string;
    password: string;
    nameNull?: boolean; passwordNull?: boolean;
    user: number[];
    reserved?: [number, number];
    extended?: { flags: number; reserved: number[]; application: number[] };
}
export interface PlayerName { short: string; long: string; shortNull?: boolean; longNull?: boolean; }
export interface Entity {
    id: number; group: boolean; owner: string; flags: number; name: PlayerName;
    data: number[]; members: number[]; parent: number; groupOwner: number;
}
export interface Address { node: number[]; port: number; }
export interface JoinPlayer { name: PlayerName; data: number[]; flags: number; }
export interface JoinDecision { hr: number; data?: Uint8Array; context?: number; }
export interface JoinRequest { address: Address; data: Uint8Array; player: JoinPlayer; }
interface SessionState { desc: SessionDesc; entities: Entity[]; peers: Address[]; }
export interface Discovery {
    desc: SessionDesc; currentPlayers: number; address: Address; seen: number; data?: Uint8Array; native?: true;
    nativeProvider?: {sockaddr: Uint8Array; version: number; peer: {family: number; node: Uint8Array; ip?: Uint8Array; port: number}};
    nativeEpoch?: object;
}
export interface SystemMessage { completion?: import("./send-queue").SendCompletion; chat?: { from: number; to: number; group: number; flags: number; text: string }; type: number; entity?: Entity; group?: number; player?: number; oldOwner?: number; currentPlayers?: number; desc?: SessionDesc; }
export interface Message { from: number; to: number; data: Uint8Array; flags?: number; system?: SystemMessage; }
export interface Reply { hr: number; id?: number; data?: Uint8Array; }
type Packet = Record<string, unknown> & { op: string; session?: string; request?: number };
interface Pending { resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout>; }
interface PartialPacket { pieces: Map<number, Uint8Array>; count: number; size: number; since: number; }
interface Peer { address: Address; seen: number; player?: number; }
const keyOf = (a: Address): string => a.node.join(".") + ":" + a.port;
const addressOf = (d: LanDatagram): Address => ({ node: Array.from(d.srcNode), port: d.srcPort });
const uint = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const guid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const nameValid = (n: unknown): n is PlayerName => !!n && typeof n === "object"
    && typeof (n as PlayerName).short === "string" && (n as PlayerName).short.length <= 1024
    && typeof (n as PlayerName).long === "string" && (n as PlayerName).long.length <= 1024;
const bytesValid = (a: unknown): a is number[] => Array.isArray(a) && a.length <= DPLAY_MAX_MESSAGE
    && a.every(n => uint(n) && n < 256);
function descValid(d: unknown): d is SessionDesc {
    if (!d || typeof d !== "object") return false;
    const s = d as SessionDesc;
    return guid(s.instance) && guid(s.application) && uint(s.flags) && uint(s.maxPlayers)
        && s.maxPlayers <= (s.extended ? 65535 : 64) && typeof s.name === "string" && s.name.length <= 1024
        && typeof s.password === "string" && s.password.length <= 1024
        && Array.isArray(s.user) && s.user.length === 4 && s.user.every(uint)
        && (s.extended === undefined || (uint(s.extended.flags) && bytesValid(s.extended.reserved) && s.extended.reserved.length <= 64 && bytesValid(s.extended.application)));
}
function entityValid(e: unknown): e is Entity {
    if (!e || typeof e !== "object") return false;
    const v = e as Entity;
    return uint(v.id) && v.id > 0 && v.id < 0xfffffff0 && typeof v.group === "boolean"
        && typeof v.owner === "string" && v.owner.length <= 64 && uint(v.flags)
        && nameValid(v.name) && bytesValid(v.data) && Array.isArray(v.members)
        && v.members.length <= 128 && v.members.every(uint) && uint(v.parent) && uint(v.groupOwner);
}
function stateValid(s: unknown): s is SessionState {
    if (!s || typeof s !== "object") return false;
    const v = s as SessionState;
    return descValid(v.desc) && Array.isArray(v.peers) && v.peers.length <= (v.desc?.extended ? 4097 : 129)
        && v.peers.every(a => a && Array.isArray(a.node) && a.node.length === 6 && a.node.every(n => uint(n) && n < 256)
            && uint(a.port) && a.port > 0 && a.port < 65536) && Array.isArray(v.entities) && v.entities.length <= (v.desc?.extended ? 4096 : 128)
        && v.entities.every(entityValid) && new Set(v.entities.map(e => e.id)).size === v.entities.length;
}
function newGuid(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One discovery listener per virtual adapter; COM objects keep independent session endpoints. */
class DiscoveryHub implements LanEndpoint {
    readonly sessions = new Set<DirectPlaySession>();
    constructor(readonly network: LanNetwork) {}
    private bound = false;
    bind(): boolean {
        if (this.bound && this.network.isBound(DISCOVERY_PORT, PROTO_DIRECTPLAY)) return true;
        this.bound = this.network.bind(DISCOVERY_PORT, this, PROTO_DIRECTPLAY, true);
        return this.bound;
    }
    deliver(dg: LanDatagram): void {
        for (const session of this.sessions) session.discoveryPacket(dg);
    }
}
const hubs = new WeakMap<LanNetwork, DiscoveryHub>();

/** Owned initialization bytes; interpretation belongs to the selected provider. */
export interface DirectPlayConnectionAddress { provider: string; bytes: Uint8Array; }
export class DirectPlaySession implements LanEndpoint {
    initialized = false;
    lost = false;
    desc: SessionDesc | null = null;
    readonly entities = new Map<number, Entity>();
    readonly queue: Message[] = [];
    readonly discovered = new Map<string, Discovery>();
    onMessage?: (id: number) => void;
    onChange?: () => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    onJoinRequest?: (request: JoinRequest) => JoinDecision | Promise<JoinDecision>;
    onJoinAccepted?: (id: number, context: number) => void;
    onDiscovery?: (discovery: Discovery) => void;
    onEnumQuery?: (request: { address: Address; data: Uint8Array }) => JoinDecision | Promise<JoinDecision>;
    joinReply: Reply | null = null;
    private pendingJoins = new Map<string, number>();
    private hub: DiscoveryHub;
    private port = 0;
    private host: Address | null = null;
    private hostMode = false;
    private peers = new Map<string, Peer>();
    private nextId = 1;
    private nextRequest = 1;
    private wireId = 1;
    private pending = new Map<number, Pending>();
    private partials = new Map<string, PartialPacket>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private discoveryTimer?: ReturnType<typeof setInterval>;
    private nativeDiscovery?: AbortController;
    private nativeCacheEpoch: object = {};
    private lastHostSeen = 0;
    private stopState: () => void;
    private stopPeer: () => void;
    private stopPort: () => void;
    private disposed = false;
    private connectionAddress?: DirectPlayConnectionAddress;
    private losing = false;
    private lifecycle = 0;
    private queuedBytes = 0;

    constructor(readonly network: LanNetwork, readonly timeout = 10000, readonly version = 4) {
        this.hub = hubs.get(network) ?? new DiscoveryHub(network);
        hubs.set(network, this.hub);
        this.hub.sessions.add(this);
        this.stopPeer = network.onPeerDisconnect(node => {
            if (!this.desc) return;
            if (this.hostMode) {
                for (const [key, peer] of this.peers) {
                    if (peer.address.node.every((n, i) => n === node[i])) this.removePeer(key);
                }
            } else if (this.host?.node.every((n, i) => n === node[i])) this.departHost(true);
        });
        this.stopPort = network.onPortDisconnect(endpoint => {
            if (!this.desc || endpoint.proto !== PROTO_DIRECTPLAY) return;
            const key = keyOf({ node: Array.from(endpoint.node), port: endpoint.port });
            if (this.hostMode) { if (this.peers.has(key)) this.removePeer(key); }
            else if (this.host && keyOf(this.host) === key) this.departHost();
        });
        this.stopState = network.onStateChange(state => {
            if (!state.connected && this.desc) this.lose();
            if (!state.connected) { this.stopDiscovery(); this.invalidateNativeDiscovery(); this.discovered.clear(); }
        });
    }
    get isHost(): boolean { return this.hostMode; }
    get localAddress(): Address { return { node: Array.from(this.network.node), port: this.port }; }
    get hostAddress(): Address | null { return this.host ? clone(this.host) : null; }
    playerAddress(id: number): Address | null {
        const owner = this.entities.get(id)?.owner;
        if (owner === this.ownKey) return this.localAddress;
        return owner && this.peers.get(owner) ? clone(this.peers.get(owner)!.address) : null;
    }
    get ownKey(): string { return keyOf({ node: Array.from(this.network.node), port: this.port }); }
    get currentPlayers(): number { return [...this.entities.values()].filter(e => !e.group).length; }
    get readyError(): number { return this.lost ? DP.SESSIONLOST : this.initialized ? DP.OK : DP.UNINITIALIZED; }
    get openError(): number { return this.readyError || (this.desc ? DP.OK : DP.NOSESSIONS); }
    getConnectionAddress(): DirectPlayConnectionAddress | undefined {
        const value = this.connectionAddress;
        return value && {provider: value.provider, bytes: value.bytes.slice()};
    }
    initialize(address?: DirectPlayConnectionAddress): number {
        if (this.initialized) return DP.ALREADYINITIALIZED;
        if (this.disposed) return DP.UNAVAILABLE;
        if (!this.hub.bind()) return DP.UNAVAILABLE;
        this.port = this.network.bindEphemeral(this, PROTO_DIRECTPLAY);
        if (!this.port) return DP.UNAVAILABLE;
        this.connectionAddress = address && {provider: address.provider, bytes: address.bytes.slice()};
        this.initialized = true;
        this.lost = false;
        return DP.OK;
    }
    bindPort(port: number): number {
        if (!this.initialized) return DP.UNINITIALIZED;
        if (this.desc) return DP.ACTIVEPLAYERS;
        if (!port || port === this.port) return DP.OK;
        if (!uint(port) || port > 65535 || port === DISCOVERY_PORT) return DP.INVALIDPARAMS;
        if (!this.network.bind(port, this, PROTO_DIRECTPLAY)) return DP.UNAVAILABLE;
        this.network.unbind(this.port, this, PROTO_DIRECTPLAY); this.port = port; return DP.OK;
    }
    discoverAt(application: string, address: Address, data: Uint8Array = EMPTY): number {
        return this.readyError || (this.transmit({ op: "discover", application }, data, address) ? DP.OK : DP.UNAVAILABLE);
    }
    discover(application: string, data: Uint8Array = EMPTY): number {
        if (this.readyError) return this.readyError;
        for (const [id, item] of this.discovered) if (Date.now() - item.seen > 30000) this.discovered.delete(id);
        return this.transmit({ op: "discover", application }, data, { node: Array.from(BROADCAST), port: DISCOVERY_PORT })
            ? DP.OK : DP.UNAVAILABLE;
    }
    startDiscovery(application: string, interval: number): void {
        this.stopDiscovery();
        this.discoveryTimer = setInterval(() => this.discover(application), interval);
        (this.discoveryTimer as unknown as { unref?: () => void }).unref?.();
    }
    // Cache invalidation is a local safety policy for future native Join.
    private invalidateNativeDiscovery(): void {
        this.nativeCacheEpoch = {};
        for (const [id, item] of this.discovered) if (item.native) this.discovered.delete(id);
    }
    /** A finished discovery retains its cache epoch; replacement and close invalidate it. */
    isCurrentNativeDiscovery(item: Discovery): boolean {
        return !this.disposed && item.native === true && item.nativeEpoch === this.nativeCacheEpoch
            && this.discovered.get(item.desc.instance) === item;
    }
    /** One native operation per session; replacement invalidates the old owner. */
    beginNativeDiscovery(): {signal: AbortSignal; epoch: object; current(): boolean; finish(): void} {
        this.stopDiscovery();
        this.invalidateNativeDiscovery();
        const controller = new AbortController(), epoch = this.nativeCacheEpoch;
        this.nativeDiscovery = controller;
        return {signal: controller.signal, epoch,
            current: () => !this.disposed && this.nativeCacheEpoch === epoch
                && this.nativeDiscovery === controller && !controller.signal.aborted,
            finish: () => { if (this.nativeDiscovery === controller) this.nativeDiscovery = undefined; }};
    }
    stopDiscovery(): void {
        const native = this.nativeDiscovery; this.nativeDiscovery = undefined; native?.abort();
        if (this.discoveryTimer) clearInterval(this.discoveryTimer);
        this.discoveryTimer = undefined;
    }
    discoveryPacket(dg: LanDatagram): void {
        const decoded = this.decode(dg);
        if (!decoded) return;
        const { packet } = decoded;
        if (packet.op !== "discover" || !guid(packet.application) || !this.hostMode || !this.desc) return;
        if (packet.application !== "0".repeat(32) && packet.application !== this.desc.application) return;
        if (this.desc.flags & 0x220) return;
        const desc = { ...this.desc, password: "" }, address = addressOf(dg);
        if (this.onEnumQuery) {
            const lifecycle = this.lifecycle;
            void Promise.resolve(this.onEnumQuery({ address, data: decoded.data.slice() })).then(result => {
                if (!result.hr && lifecycle === this.lifecycle && this.hostMode && this.desc?.instance === desc.instance) {
                    this.transmit({ op: "advertise", desc, currentPlayers: this.currentPlayers }, result.data ?? EMPTY, address);
                }
            }).catch(() => {});
        } else this.transmit({ op: "advertise", desc, currentPlayers: this.currentPlayers }, EMPTY, address);
    }
    create(desc: SessionDesc): number {
        if (this.readyError) return this.readyError;
        if (this.desc) return DP.ACTIVEPLAYERS;
        if (!descValid(desc)) return DP.INVALIDPARAMS;
        // Migration and security need protocols beyond the host-authoritative provider.
        if (desc.flags & 0x100) return DP.UNSUPPORTED;
        if ((desc.flags & 4) && (desc.flags & 0x1800)) return DP.INVALIDFLAGS;
        ++this.lifecycle;
        this.desc = clone({ ...desc, instance: newGuid() });
        this.hostMode = true;
        this.host = { node: Array.from(this.network.node), port: this.port };
        this.lost = false;
        this.startHeartbeat();
        return DP.OK;
    }
    async join(desc: SessionDesc, player?: JoinPlayer, connectData: Uint8Array = EMPTY): Promise<number> {
        if (this.disposed) return DP.UNAVAILABLE;
        if (this.readyError) return this.readyError;
        if (this.desc) return DP.ACTIVEPLAYERS;
        if (!descValid(desc)) return DP.INVALIDPARAMS;
        const lifecycle = ++this.lifecycle;
        const current = (): boolean => !this.disposed && this.lifecycle === lifecycle;
        let found = this.discovered.get(desc.instance);
        if (found?.native) return DP.UNAVAILABLE;
        if (!found) {
            this.discover(desc.application);
            await new Promise(resolve => setTimeout(resolve, Math.min(300, this.timeout)));
            if (!current()) return DP.SESSIONLOST;
            found = this.discovered.get(desc.instance);
        }
        if (found?.native) return DP.UNAVAILABLE;
        if (!found) return DP.NOSESSIONS;
        this.host = found.address;
        this.desc = clone(desc);
        const reply = await this.request({ op: "join", password: desc.password, application: desc.application, ...(player ? { player } : {}) }, connectData);
        if (!current()) return DP.SESSIONLOST;
        this.joinReply = reply;
        if (reply.hr) { this.desc = null; this.host = null; return reply.hr; }
        this.lastHostSeen = Date.now();
        this.startHeartbeat();
        return DP.OK;
    }
    close(): number {
        this.stopDiscovery();
        this.invalidateNativeDiscovery();
        const previous = this.desc;
        if (previous && this.hostMode) this.broadcast({ op: previous.flags & 4 ? "migrate" : "lost" });
        else if (previous && this.host) this.transmit({ op: "leave", session: previous.instance }, EMPTY, this.host);
        this.clearSession();
        this.queue.length = 0; this.queuedBytes = 0; this.lost = false;
        return this.initialized ? DP.OK : DP.UNINITIALIZED;
    }
    dispose(): void {
        this.close();
        this.disposed = true;
        this.connectionAddress = undefined;
        this.discovered.clear();
        this.stopState();
        this.stopPeer();
        this.stopPort();
        if (this.port) this.network.unbind(this.port, this, PROTO_DIRECTPLAY);
        this.hub.sessions.delete(this);
        if (!this.hub.sessions.size) this.network.unbind(DISCOVERY_PORT, this.hub, PROTO_DIRECTPLAY);
        this.port = 0;
    }
    private clearSession(): void {
        ++this.lifecycle;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ hr: DP.SESSIONLOST }); }
        this.pending.clear(); this.pendingJoins.clear(); this.partials.clear(); this.peers.clear(); this.entities.clear();
        this.joinReply = null;
        this.desc = null; this.host = null; this.hostMode = false; this.nextId = 1;
    }
    private lose(): void {
        if (!this.desc || this.losing) return;
        this.losing = true;
        try {
            this.stopDiscovery();
            if (this.hostMode) this.broadcast({ op: "lost" });
            this.notify({ type: 0x31 });
            this.clearSession();
            this.lost = true;
            this.onChange?.();
        } finally { this.losing = false; }
    }
    private departHost(nodeWide = false): void {
        if (!this.desc || !this.host || this.hostMode) return;
        if (!(this.desc.flags & 4)) { this.lose(); return; }
        const departed = this.host, previous = this.state();
        const onDepartedNode = (owner: string): boolean => {
            const address = this.peers.get(owner)?.address ?? (owner === keyOf(departed) ? departed : null);
            return !!address && (nodeWide ? address.node.every((value, i) => value === departed.node[i]) : keyOf(address) === keyOf(departed));
        };
        for (const [id, e] of this.entities) if (onDepartedNode(e.owner) && (this.version !== 8 || !e.group || (e.flags & 1))) this.entities.delete(id);
        for (const [key, peer] of this.peers) if (nodeWide ? peer.address.node.every((value, i) => value === departed.node[i]) : key === keyOf(departed)) this.peers.delete(key);
        for (const e of this.entities.values()) e.members = e.members.filter(id => this.entities.has(id));
        const candidate = [...this.entities.values()].filter(e => !e.group && (e.owner === this.ownKey || this.peers.has(e.owner))).sort((a, b) => a.id - b.id)[0];
        if (!candidate) { this.lose(); return; }
        this.host = candidate.owner === this.ownKey ? { node: Array.from(this.network.node), port: this.port } : this.peers.get(candidate.owner)!.address;
        this.hostMode = candidate.owner === this.ownKey;
        this.nextId = Math.max(0, ...this.entities.keys()) + 1;
        this.lastHostSeen = Date.now();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ hr: DP.CONNECTIONLOST }); }
        this.pending.clear();
        this.applyChanges(previous.entities, [...this.entities.values()], previous.desc, this.desc);
        if (this.hostMode) {
            this.notify({ type: 0x101 });
            if (!this.broadcast({ op: "state", state: this.state() })) { this.lose(); return; }
        }
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.startHeartbeat();
        this.onChange?.();
    }
    private startHeartbeat(): void {
        this.heartbeat = setInterval(() => {
            if (!this.desc) return;
            const now = Date.now();
            for (const [key, part] of this.partials) if (now - part.since > this.timeout) this.partials.delete(key);
            if (this.hostMode) {
                for (const [key, peer] of this.peers) if (now - peer.seen > this.timeout * 3) this.removePeer(key);
            } else if (this.host) {
                if (now - this.lastHostSeen > this.timeout * 3) this.departHost();
                else this.transmit({ op: "ping", session: this.desc.instance }, EMPTY, this.host);
            }
        }, Math.min(1000, this.timeout));
        (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    }
    private transmit(packet: Packet, data: Uint8Array, target: Address): boolean {
        packet = { ...packet, api: this.version };
        const json = encoder.encode(JSON.stringify(packet));
        if (json.length + data.length + 4 > MAX_STATE) return false;
        const body = new Uint8Array(4 + json.length + data.length);
        new DataView(body.buffer).setUint32(0, json.length, true);
        body.set(json, 4); body.set(data, 4 + json.length);
        const count = Math.ceil(body.length / CHUNK);
        const id = this.wireId++ >>> 0;
        for (let index = 0; index < count; index++) {
            const slice = body.subarray(index * CHUNK, (index + 1) * CHUNK);
            const frame = new Uint8Array(16 + slice.length);
            const v = new DataView(frame.buffer);
            v.setUint32(0, MAGIC, true); v.setUint32(4, id, true);
            v.setUint32(8, index, true); v.setUint32(12, count, true); frame.set(slice, 16);
            if (!this.network.send(this.port, new Uint8Array(target.node), target.port, frame, PROTO_DIRECTPLAY)) return false;
        }
        return true;
    }
    private decode(dg: LanDatagram): { packet: Packet; data: Uint8Array } | null {
        const frame = dg.data;
        if (frame.length < 16 || frame.length > CHUNK + 16) return null;
        const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        if (v.getUint32(0, true) !== MAGIC) return null;
        const index = v.getUint32(8, true), count = v.getUint32(12, true);
        if (!count || count > Math.ceil(MAX_STATE / CHUNK) || index >= count) return null;
        let body: Uint8Array;
        if (count === 1) body = frame.subarray(16);
        else {
            const key = keyOf(addressOf(dg)) + ":" + v.getUint32(4, true);
            let part = this.partials.get(key);
            if (!part) {
                if (this.partials.size >= 16) return null;
                part = { pieces: new Map(), count, size: 0, since: Date.now() };
                this.partials.set(key, part);
            }
            if (part.count !== count || part.pieces.has(index)) return null;
            const bytes = frame.slice(16); part.size += bytes.length;
            if (part.size > MAX_STATE) { this.partials.delete(key); return null; }
            part.pieces.set(index, bytes);
            if (part.pieces.size !== count) return null;
            body = new Uint8Array(part.size);
            let offset = 0;
            for (let i = 0; i < count; i++) { const p = part.pieces.get(i)!; body.set(p, offset); offset += p.length; }
            this.partials.delete(key);
        }
        if (body.length < 4) return null;
        const size = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
        if (size > body.length - 4) return null;
        try {
            const p: unknown = JSON.parse(decoder.decode(body.subarray(4, size + 4)));
            if (!p || typeof p !== "object" || typeof (p as Packet).op !== "string" || (p as Packet).api !== this.version) return null;
            return { packet: p as Packet, data: body.subarray(size + 4) };
        } catch { return null; }
    }
    deliver(dg: LanDatagram): void {
        const decoded = this.decode(dg);
        if (!decoded) return;
        const { packet: p, data } = decoded;
        const source = addressOf(dg), sourceKey = keyOf(source);
        if (p.op === "discover") { this.discoveryPacket(dg); return; }
        if (p.op === "advertise") {
            if (!descValid(p.desc) || !uint(p.currentPlayers) || p.currentPlayers > (this.version === 8 ? 65535 : 64)) return;
            if (this.discovered.size >= 256 && !this.discovered.has(p.desc.instance)) return;
            const item: Discovery = { desc: p.desc, currentPlayers: p.currentPlayers, address: source, seen: Date.now(), data: data.slice() };
            this.discovered.set(p.desc.instance, item); this.onDiscovery?.(item);
            return;
        }
        if (!this.desc || p.session !== this.desc.instance) return;
        if (this.hostMode) {
            if (p.op === "join") {
                if (!uint(p.request) || p.application !== this.desc.application) return;
                void this.acceptJoin(p, data, source); return;
            }
            if (p.op === "leave") this.pendingJoins.delete(sourceKey);
            const peer = this.peers.get(sourceKey);
            if (!peer) return;
            peer.seen = Date.now();
            if (p.op === "ping") { this.transmit({ op: "pong", session: this.desc.instance }, EMPTY, source); return; }
            if (p.op === "leave") { this.removePeer(sourceKey); return; }
            if (p.op === "send" || p.op === "chat") {
                const chat = p.op === "chat" && typeof p.text === "string" && p.text.length <= 1024
                    && uint(p.from) && uint(p.to) && uint(p.flags) && !(p.flags & ~1)
                    ? { type: 0x109, chat: { from: p.from, to: this.entities.get(p.to)?.group ? 0 : p.to, group: this.entities.get(p.to)?.group ? p.to : 0, flags: p.flags, text: p.text } } : undefined;
                const hr = p.op === "chat" && !chat ? DP.INVALIDPARAMS : this.route(p.from, p.to, p.flags, data, sourceKey, chat);
                if (uint(p.request)) this.transmit({ op: "reply", session: p.session, request: p.request, hr }, EMPTY, source);
                return;
            }
            if (p.op === "mutate" && uint(p.request)) {
                const result = this.execute(p, sourceKey);
                this.transmit({ op: "reply", session: p.session, request: p.request, ...result }, EMPTY, source);
            }
            return;
        }
        if (!this.host || sourceKey !== keyOf(this.host)) return;
        this.lastHostSeen = Date.now();
        if (p.op === "lost") { this.onTermination?.(data.slice(), uint(p.reason) ? p.reason : undefined); this.lose(); return; }
        if (p.op === "migrate") { this.departHost(); return; }
        if (p.op === "reply" && uint(p.request) && uint(p.hr)) {
            const pending = this.pending.get(p.request);
            if (!pending) return;
            if (p.state !== undefined) {
                if (!stateValid(p.state) || p.state.desc.instance !== this.desc.instance) return;
                this.apply(p.state);
            }
            clearTimeout(pending.timer); this.pending.delete(p.request);
            pending.resolve({ hr: p.hr, data: data.slice(), ...(uint(p.id) ? { id: p.id } : {}) });
        } else if (p.op === "state" && stateValid(p.state) && p.state.desc.instance === this.desc.instance) {
            this.apply(p.state);
        } else if (p.op === "delivery" && uint(p.from) && uint(p.to) && data.length <= DPLAY_MAX_MESSAGE) {
            const sender = this.entities.get(p.from), target = this.entities.get(p.to);
            if (sender && !sender.group && target && !target.group && target.owner === this.ownKey && (p.from !== p.to || this.version === 8)) {
                const system = p.chat && typeof p.chat === "object" ? p.chat as SystemMessage["chat"] : undefined;
                if (system && (!uint(system.from) || system.from !== p.from || typeof system.text !== "string" || system.text.length > 1024
                    || !uint(system.to) || !uint(system.group) || !uint(system.flags))) return;
                this.enqueue(system ? { from: 0, to: p.to, data: EMPTY, system: { type: 0x109, chat: system } } : { from: p.from, to: p.to, data: data.slice(), flags: uint(p.flags) ? p.flags : 0 });
            }
        }
    }
    private async acceptJoin(p: Packet, data: Uint8Array, source: Address): Promise<void> {
        if (!this.desc || !this.hostMode || !uint(p.request)) return;
        const instance = this.desc.instance, lifecycle = this.lifecycle, key = keyOf(source), request = p.request;
        let hr: number = this.desc.flags & 0x20 ? DP.UNAVAILABLE : p.password !== this.desc.password ? DP.INVALIDPASSWORD : DP.OK;
        let decision: JoinDecision = { hr };
        const player = p.player as JoinPlayer | undefined;
        if (player && (!nameValid(player.name) || !bytesValid(player.data) || !uint(player.flags) || data.length > DPLAY_MAX_MESSAGE)) hr = DP.INVALIDPARAMS;
        const previousPlayer = this.peers.get(key)?.player;
        if (previousPlayer && this.entities.has(previousPlayer)) {
            this.transmit({ op: "reply", session: instance, request, hr: DP.OK, id: previousPlayer, state: this.state() }, EMPTY, source); return;
        }
        if (!hr && player && this.onJoinRequest) {
            this.pendingJoins.set(key, request);
            try { decision = await this.onJoinRequest({ address: source, data: data.slice(), player: clone(player) }); }
            catch { decision = { hr: DP.UNAVAILABLE }; }
            if (lifecycle !== this.lifecycle || this.pendingJoins.get(key) !== request || !this.hostMode || this.desc?.instance !== instance) return;
            this.pendingJoins.delete(key); hr = decision.hr;
        }
        if (lifecycle !== this.lifecycle || !this.hostMode || this.desc?.instance !== instance) return;
        let id: number | undefined;
        if (!hr) {
            this.peers.set(key, { address: source, seen: Date.now() });
            if (player) {
                const result = this.execute({ op: "mutate", action: "create", group: false, name: player.name, data: player.data, flags: player.flags, parent: 0 },
                    key, playerId => this.onJoinAccepted?.(playerId, decision.context ?? 0));
                hr = result.hr; id = result.id;
                if (hr) this.peers.delete(key); else this.peers.get(key)!.player = id;
            }
        }
        if (this.desc?.instance !== instance) return;
        this.transmit({ op: "reply", session: instance, request, hr, ...(id ? { id } : {}), ...(hr ? {} : { state: this.state() }) }, decision.data ?? EMPTY, source);
    }
    private request(packet: Packet, data = EMPTY): Promise<Reply> {
        if (!this.host || !this.desc) return Promise.resolve({ hr: DP.NOSESSIONS });
        const request = this.nextRequest++ >>> 0;
        return new Promise(resolve => {
            const timer = setTimeout(() => { this.pending.delete(request); resolve({ hr: DP.TIMEOUT }); }, this.timeout);
            this.pending.set(request, { resolve, timer });
            if (!this.transmit({ ...packet, request, session: this.desc!.instance }, data, this.host!)) {
                clearTimeout(timer); this.pending.delete(request); resolve({ hr: DP.CONNECTIONLOST });
            }
        });
    }
    private state(): SessionState {
        const addresses = [{ node: Array.from(this.network.node), port: this.port }, ...[...this.peers.values()].map(p => p.address)];
        return { desc: clone(this.desc!), entities: clone([...this.entities.values()]),
            peers: [...new Map(addresses.map(a => [keyOf(a), clone(a)])).values()] };
    }
    private broadcast(packet: Packet, data = EMPTY): boolean {
        const session = this.desc?.instance;
        if (!session) return false;
        for (const peer of [...this.peers.values()]) {
            if (!this.transmit({ ...packet, session }, data, peer.address) || this.desc?.instance !== session) return false;
        }
        return true;
    }
    private publish(previous: SessionState): number {
        if (!this.desc) return DP.SESSIONLOST;
        const next = this.state();
        this.applyChanges(previous.entities, next.entities, previous.desc, next.desc);
        if (!this.broadcast({ op: "state", state: next })) {
            this.lose();
            return DP.CONNECTIONLOST;
        }
        this.onChange?.();
        return DP.OK;
    }
    private apply(next: SessionState): void {
        const previous = [...this.entities.values()];
        const oldDesc = this.desc!;
        this.entities.clear();
        for (const entity of next.entities) this.entities.set(entity.id, entity);
        this.desc = next.desc;
        if (!this.hostMode) {
            this.peers.clear();
            for (const address of next.peers) if (keyOf(address) !== this.ownKey) this.peers.set(keyOf(address), { address, seen: Date.now() });
        }
        this.applyChanges(previous, next.entities, oldDesc, next.desc);
        this.onChange?.();
    }
    private applyChanges(old: Entity[], next: Entity[], oldDesc: SessionDesc, desc: SessionDesc): void {
        const before = new Map(old.map(e => [e.id, e]));
        for (const e of next) {
            const previous = before.get(e.id);
            if (!previous) this.notify({ type: 3, entity: clone(e) }, e.id);
            else {
                if (!(desc.flags & 0x80) && JSON.stringify(previous.data) !== JSON.stringify(e.data)) this.notify({ type: 0x102, entity: clone(e) });
                if (!(desc.flags & 0x80) && JSON.stringify(previous.name) !== JSON.stringify(e.name)) this.notify({ type: 0x103, entity: clone(e) });
                if (e.groupOwner !== previous.groupOwner) this.notify({ type: 0x10a, group: e.id, player: e.groupOwner, oldOwner: previous.groupOwner });
                for (const id of e.members) if (!previous.members.includes(id)) this.notify({ type: this.entities.get(id)?.group ? 0x105 : 7, group: e.id, player: id });
                for (const id of previous.members) if (!e.members.includes(id)) this.notify({ type: before.get(id)?.group ? 0x106 : 0x21, group: e.id, player: id });
            }
        }
        for (const e of old) if (!this.entities.has(e.id)) {
            this.notify({ type: 5, entity: clone(e) }, e.id);
            for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].to === e.id) this.removeMessage(i);
        }
        if (JSON.stringify(oldDesc) !== JSON.stringify(desc)) this.notify({ type: 0x104, desc: clone(desc) });
    }
    private notify(system: SystemMessage, exclude = 0): void {
        system = { ...system, currentPlayers: this.currentPlayers,
            ...(system.entity ? { entity: { ...system.entity, flags: system.entity.flags | (system.entity.owner === this.ownKey ? 8 : 0) } } : {}) };
        for (const entity of this.entities.values()) if (!entity.group && entity.owner === this.ownKey && entity.id !== exclude) {
            this.enqueue({ from: 0, to: entity.id, data: EMPTY, system });
        }
    }
    private enqueue(message: Message): void {
        const bytes = message.data.length + (message.system ? 256 : 0);
        if (this.queue.length >= 4096 || this.queuedBytes + bytes > 4 * 1024 * 1024) {
            this.queue.length = 0; this.queuedBytes = 0; this.lose(); return;
        }
        this.queue.push(message); this.queuedBytes += bytes; this.onMessage?.(message.to);
    }
    enqueueSystem(player: number, system: SystemMessage): boolean {
        const target = this.entities.get(player);
        if (!target || target.group || target.owner !== this.ownKey) return true;
        if (this.queue.length >= 4096 || this.queuedBytes + 256 > 4 * 1024 * 1024) return false;
        this.enqueue({ from: 0, to: player, data: EMPTY, system }); return true;
    }
    removeMessage(index: number): void {
        const [m] = this.queue.splice(index, 1);
        if (m) this.queuedBytes -= m.data.length + (m.system ? 256 : 0);
    }
    private removePeer(key: string): void {
        const previous = this.state();
        this.peers.delete(key);
        for (const [id, e] of this.entities) if (e.owner === key && (this.version !== 8 || !e.group || (e.flags & 1))) this.entities.delete(id);
        for (const e of this.entities.values()) e.members = e.members.filter(id => this.entities.has(id));
        this.publish(previous);
    }
    terminate(data: Uint8Array, reason?: number): number {
        if (this.openError) return this.openError;
        if (!this.hostMode) return DP.ACCESSDENIED;
        if (!this.broadcast({ op: "lost", ...(reason === undefined ? {} : { reason }) }, data)) { this.lose(); return DP.CONNECTIONLOST; }
        this.clearSession(); this.onChange?.(); return DP.OK;
    }
    kick(id: number, data: Uint8Array): number {
        if (this.openError) return this.openError;
        if (!this.hostMode) return DP.ACCESSDENIED;
        const entity = this.entities.get(id);
        if (!entity || entity.group || entity.owner === this.ownKey) return DP.INVALIDPLAYER;
        const peer = this.peers.get(entity.owner); if (!peer) return DP.INVALIDPLAYER;
        if (!this.transmit({ op: "lost", session: this.desc!.instance }, data, peer.address)) return DP.CONNECTIONLOST;
        this.removePeer(entity.owner); return this.openError || DP.OK;
    }
    mutate(change: Packet): Promise<Reply> | Reply {
        if (this.openError) return { hr: this.openError };
        if (this.hostMode) return this.execute({ ...change, op: "mutate" }, this.ownKey);
        return this.request({ ...change, op: "mutate" });
    }
    private execute(p: Packet, owner: string, beforePublish?: (id: number) => void): Reply {
        if (!this.desc) return { hr: DP.NOSESSIONS };
        const previous = this.state();
        let result: Reply = { hr: DP.OK };
        const entity = uint(p.id) ? this.entities.get(p.id) : undefined;
        switch (p.action) {
            case "create": {
                if (typeof p.group !== "boolean" || !nameValid(p.name) || !bytesValid(p.data) || !uint(p.flags) || !uint(p.parent)) return { hr: DP.INVALIDPARAMS };
                if (!p.group && ((this.desc.flags & 1) || (this.desc.maxPlayers && this.currentPlayers >= this.desc.maxPlayers))) return { hr: DP.CANTCREATEPLAYER };
                if (this.entities.size >= (this.version === 8 ? 4096 : 128)) return { hr: p.group ? DP.CANTCREATEGROUP : DP.CANTCREATEPLAYER };
                if (p.parent && (!this.entities.get(p.parent)?.group || !p.group)) return { hr: DP.INVALIDGROUP };
                if ([...this.entities.values()].reduce((sum, e) => sum + e.data.length, 0) + p.data.length > DPLAY_MAX_MESSAGE) return { hr: DP.UNAVAILABLE };
                const id = this.nextId++;
                this.entities.set(id, { id, group: p.group, owner, flags: p.flags & ~8, name: clone(p.name),
                    data: p.data.slice(), members: [], parent: p.parent, groupOwner: this.version === 8 && p.group ? [...this.entities.values()].find(e => !e.group && e.owner === owner)?.id ?? 0 : 0 });
                if (p.parent) this.entities.get(p.parent)!.members.push(id);
                result = { hr: DP.OK, id };
                break;
            }
            case "destroy":
                if (!entity) return { hr: p.group ? DP.INVALIDGROUP : DP.INVALIDPLAYER };
                if (entity.owner !== owner && !(this.version === 8 && entity.group)) return { hr: DP.ACCESSDENIED };
                this.entities.delete(entity.id);
                for (const e of this.entities.values()) e.members = e.members.filter(id => id !== entity.id);
                break;
            case "info": {
                if (!entity) return { hr: p.group ? DP.INVALIDGROUP : DP.INVALIDPLAYER };
                if (entity.owner !== owner && !(this.version === 8 && entity.group)) return { hr: DP.ACCESSDENIED };
                if (p.name !== undefined) { if (!nameValid(p.name)) return { hr: DP.INVALIDPARAMS }; }
                if (p.data !== undefined) { if (!bytesValid(p.data)) return { hr: DP.INVALIDPARAMS }; }
                if (p.name !== undefined) entity.name = clone(p.name as PlayerName);
                if (p.data !== undefined) entity.data = (p.data as number[]).slice();
                break;
            }
            case "name": case "data":
                if (!entity) return { hr: p.group ? DP.INVALIDGROUP : DP.INVALIDPLAYER };
                if (entity.owner !== owner && !(this.version === 8 && entity.group)) return { hr: DP.ACCESSDENIED };
                if (p.action === "name") {
                    if (!nameValid(p.name)) return { hr: DP.INVALIDPARAMS };
                    entity.name = clone(p.name);
                } else {
                    if (!bytesValid(p.data)) return { hr: DP.INVALIDPARAMS };
                    if ([...this.entities.values()].reduce((sum, e) => sum + (e.id === entity.id ? 0 : e.data.length), 0) + p.data.length > DPLAY_MAX_MESSAGE) return { hr: DP.UNAVAILABLE };
                    entity.data = p.data.slice();
                }
                break;
            case "member": {
                if (!entity?.group || !uint(p.member) || !this.entities.has(p.member) || typeof p.add !== "boolean") return { hr: DP.INVALIDGROUP };
                const child = this.entities.get(p.member)!;
                if (child.id === entity.id || (child.group && this.contains(child.id, entity.id))) return { hr: DP.INVALIDGROUP };
                entity.members = entity.members.filter(id => id !== p.member);
                if (p.add) entity.members.push(p.member);
                break;
            }
            case "owner":
                if (!entity?.group || !uint(p.player) || this.entities.get(p.player)?.group !== false) return { hr: DP.INVALIDGROUP };
                if (entity.owner !== owner && !(this.version === 8 && entity.group)) return { hr: DP.ACCESSDENIED };
                entity.groupOwner = p.player;
                break;
            case "session":
                if (owner !== this.ownKey) return { hr: DP.ACCESSDENIED };
                if (!descValid(p.desc) || p.desc.instance !== this.desc.instance || p.desc.application !== this.desc.application) return { hr: DP.INVALIDPARAMS };
                if (p.desc.flags & 0x100) return { hr: DP.UNSUPPORTED };
                if ((p.desc.flags & 4) && (p.desc.flags & 0x1800)) return { hr: DP.INVALIDFLAGS };
                this.desc = clone(p.desc);
                break;
            default: return { hr: DP.UNSUPPORTED };
        }
        if (result.id) beforePublish?.(result.id);
        const error = this.publish(previous);
        return error ? { hr: error } : result;
    }
    private contains(group: number, target: number, seen = new Set<number>()): boolean {
        if (seen.has(group)) return false;
        seen.add(group);
        const e = this.entities.get(group);
        return !!e?.group && (e.members.includes(target) || e.members.some(id => this.entities.get(id)?.group && this.contains(id, target, seen)));
    }
    send(from: number, to: number, flags: number, data: Uint8Array): Promise<number> | number {
        if (this.openError) return this.openError;
        const source = this.entities.get(from);
        if (!source || source.group || source.owner !== this.ownKey) return DP.INVALIDPLAYER;
        if (flags & ~(this.version === 8 ? 0x1001f : 0x1f)) return DP.INVALIDFLAGS;
        if (data.length > DPLAY_MAX_MESSAGE) return DP.INVALIDPARAMS;
        if (to && !this.entities.has(to)) return DP.INVALIDPARAMS;
        if (this.hostMode) return this.route(from, to, flags, data, this.ownKey);
        if (flags & 1) return this.request({ op: "send", from, to, flags }, data).then(reply => reply.hr);
        return this.transmit({ op: "send", session: this.desc!.instance, from, to, flags }, data, this.host!) ? DP.OK : DP.CONNECTIONLOST;
    }
    sendChat(from: number, to: number, flags: number, text: string): number | Promise<number> {
        if (this.openError) return this.openError;
        const source = this.entities.get(from);
        if (!source || source.group) return DP.INVALIDPLAYER;
        if (source.owner !== this.ownKey) return DP.ACCESSDENIED;
        if (flags & ~1) return DP.INVALIDFLAGS;
        if (to && !this.entities.has(to)) return DP.INVALIDPARAMS;
        const system: SystemMessage = { type: 0x109, chat: { from, to: this.entities.get(to)?.group ? 0 : to, group: this.entities.get(to)?.group ? to : 0, flags, text } };
        if (this.hostMode) return this.route(from, to, flags, EMPTY, this.ownKey, system);
        return this.request({ op: "chat", from, to, flags, text }).then(reply => reply.hr);
    }
    private route(from: unknown, to: unknown, flags: unknown, data: Uint8Array, owner: string, system?: SystemMessage): number {
        if (!uint(from) || !uint(to) || !uint(flags) || (flags & ~(this.version === 8 ? 0x1001f : 0x1f)) || data.length > DPLAY_MAX_MESSAGE) return DP.INVALIDPARAMS;
        const source = this.entities.get(from);
        if (!source || source.group || source.owner !== owner) return DP.INVALIDPLAYER;
        if (to && !this.entities.has(to)) return DP.INVALIDPARAMS;
        const session = this.desc?.instance;
        if (!session) return DP.SESSIONLOST;
        for (const target of [...this.entities.values()]) {
            if (target.group || (target.id === from && !(flags & 0x10000))) continue;
            if (to && target.id !== to && !this.contains(to, target.id)) continue;
            if (target.owner === this.ownKey) this.enqueue(system ? { from: 0, to: target.id, data: EMPTY, system } : { from, to: target.id, data: data.slice(), flags });
            else {
                const peer = this.peers.get(target.owner);
                if (!peer || !this.transmit({ op: "delivery", session, from, to: target.id, flags, ...(system?.chat ? { chat: system.chat } : {}) }, data, peer.address)) {
                    this.lose(); return DP.CONNECTIONLOST;
                }
            }
            if (this.desc?.instance !== session) return DP.SESSIONLOST;
        }
        return DP.OK;
    }
}
