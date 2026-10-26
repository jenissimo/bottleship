/**
 * Winsock socket state over the BottleShip virtual LAN.
 * ABI semantics follow Winsock 1.1/2; TCP here is a private reliable LAN protocol,
 * not an IP/TCP wire implementation. No guest memory is retained by this layer.
 */
import { lanNetwork, type LanNetwork, type LanEndpoint, type LanDatagram, ipv4ToNode, nodeToIpv4,
    IPX_NETNUM, IPX_MAX_PAYLOAD, UDP_MAX_PAYLOAD, UDP6_MAX_PAYLOAD } from "../net/lan-network";
import { copyLocalUdpContext, type LocalUdpContext, type LocalUdpEndpoint } from "../net/local-udp-context";
import { ipChecksum, ipv4RawPacket, parseRawIp } from "./wsa-raw";
import { PROTO_RAW4, PROTO_RAW6, RAW_MAX_PACKET, PROTO_IPX, PROTO_UDP, PROTO_TCP, PROTO_UDP6, PROTO_TCP6, TCP_OPTION, TCP_OPTION_KEEPALIVE, TCP_OPTION_NODELAY, SYN_INLINE_FLAG, SYN_KEEPALIVE_FLAG, SYN_NODELAY_FLAG, SYN_WINDOW_MASK, TCP_MAGIC, TCP_HEADER, TCP_SEGMENT, SYN, SYNACK, DATA, FIN, RST, CREDIT, OOB, encodeTcpFrame } from "../net/netplay-wire";

export const WSA = {
    EINTR: 10004, EACCES: 10013, EFAULT: 10014, EINVAL: 10022,
    EWOULDBLOCK: 10035, EINPROGRESS: 10036, EALREADY: 10037, ENOTSOCK: 10038,
    EDESTADDRREQ: 10039, EMSGSIZE: 10040, ENOPROTOOPT: 10042, EPROTONOSUPPORT: 10043,
    ESOCKTNOSUPPORT: 10044, EOPNOTSUPP: 10045, EAFNOSUPPORT: 10047,
    EADDRINUSE: 10048, EADDRNOTAVAIL: 10049, ENETDOWN: 10050,
    ECONNRESET: 10054, ENOBUFS: 10055, EISCONN: 10056, ENOTCONN: 10057,
    ESHUTDOWN: 10058, ETIMEDOUT: 10060, ECONNREFUSED: 10061, NOTINITIALISED: 10093,
} as const;
export class WsaFailure extends Error {
    constructor(readonly code: number) { super(`Winsock error ${code}`); }
}
function fail(code: number): never { throw new WsaFailure(code); }
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const zeros = (a: Uint8Array) => a.every(v => v === 0);
const broadcast = (a: Uint8Array) => a.every(v => v === 255);
const multicast4 = (a?: Uint8Array) => !!a && a[0] >= 224 && a[0] <= 239;
const mappedIpv4 = (ip?: Uint8Array): Uint8Array | undefined =>
    ip?.length === 16 && ip.subarray(0, 10).every(v => v === 0) && ip[10] === 255 && ip[11] === 255 ? ip.slice(12) : undefined;
function mappedIpv6(ip: Uint8Array): Uint8Array {
    const address = new Uint8Array(16); address[10] = address[11] = 255; address.set(ip, 12); return address;
}
const BUFFER_LIMIT = 256 * 1024;
const PACKET_LIMIT = 1024;
// Local engine safety bound for queued UDP errors; not a Windows provider capacity.
const UDP_ERROR_RECORD_LIMIT = 1024;
// Buffered UDP admission models NT5 x86 free: AFD_BUFFER_TAG is 48 bytes
// under the default MSVC /Zp8 ABI (DBG=0). This is a source-build model,
// not a measured quota or allocation cost for modern Windows providers.
const NT5_X86_UDP_RECEIVE_TAG_BYTES = 48;

export interface WsaAddress {
    family: number;
    port: number;
    node: Uint8Array;
    /** Original IPv4 bytes; absent for IPX. */
    ip?: Uint8Array;
    ip6?: Uint8Array;
    scopeId?: number;
    flowInfo?: number;
    packetType?: number;
    flags?: number;
}
function copyAddress(address: WsaAddress): WsaAddress {
    return { ...address, node: Uint8Array.from(address.node),
        ...(address.ip ? { ip: Uint8Array.from(address.ip) } : {}),
        ...(address.ip6 ? { ip6: Uint8Array.from(address.ip6) } : {}) };
}
function localUdpAddress(endpoint: LocalUdpEndpoint, node: Uint8Array): WsaAddress {
    return { family: endpoint.family, port: endpoint.port, node: Uint8Array.from(node),
        ...(endpoint.family === 2 ? { ip: Uint8Array.from(endpoint.address) } :
            { ip6: Uint8Array.from(endpoint.address), scopeId: endpoint.scopeId ?? 0, flowInfo: endpoint.flowInfo ?? 0 }) };
}
/** A receive-only UDP reset may carry the exact destination of its failed datagram. */
export class WsaUdpReceiveFailure extends WsaFailure {
    readonly from: WsaAddress;
    constructor(from: WsaAddress) { super(WSA.ECONNRESET); this.from = copyAddress(from); }
}
type UdpReceiveRecord = WsaPacket | { kind: "error"; from?: WsaAddress };
interface UdpReceiveQueue { records: UdpReceiveRecord[]; dataCount: number; errorCount: number; }
export interface WsaPacket { data: Uint8Array; from: WsaAddress; truncated?: boolean; ipxHeader?: Uint8Array; }
interface SocketState {
    id: number; wireId: number; af: number; type: number; protocol: number;
    acceptListener?: number; acceptListenerObjectId?: number; originalLocal?: WsaAddress | null; connectContextPending: boolean; connectExCompleted?: boolean; disconnected: boolean; connectedAt: number;
    nonBlocking: boolean; overlapped: boolean; handleFlags: number; local: WsaAddress | null; peer: WsaAddress | null;
    state: "new" | "connecting" | "connected" | "listening" | "failed";
    backlog: number; pending: number[];
    packets: WsaPacket[]; chunks: Uint8Array[]; offset: number; available: number;
    readShutdown: boolean; writeShutdown: boolean; eof: boolean; error: number; pendingError: number;
    oob: number | null; oobPending: Array<{ value: number; mark: number }>; oobInline: boolean; readPosition: number; urgentMark: number | null;
    extendedAddress: boolean; receiveHeader: boolean;
    headerInclude: boolean; ipTtl: number; ipTos: number; ipOptionsChanged: boolean;
    keepAlive: boolean; noDelay: boolean; udpConnReset: boolean; v6Only: boolean;
    multicastInterface: number; multicastTtl: number; multicastLoop: boolean;
    peerId: number; credit: number; writeBlocked: boolean; connectTimer?: ReturnType<typeof setTimeout>;
    broadcast: boolean; reuse: boolean; packetType: number; filterPacketType: number | null; receiveBroadcast: boolean; receiveLimit: number; sendLimit: number;
    receiveTimeout: number; sendTimeout: number; lingerEnabled: boolean; lingerSeconds: number;
    eventMask: number; eventPending: number; eventErrors: number[];
    eventDisabled: number; notify?: (bit: number, error: number) => void;
}
interface Binding { port: number; proto: number; endpoint: LanEndpoint; sockets: Set<number>; }
export const FD_READ = 1, FD_WRITE = 2, FD_OOB = 4, FD_ACCEPT = 8, FD_CONNECT = 16, FD_CLOSE = 32;

/** An issued operation may outlive its numeric handle; this lease never adds an OS handle reference. */
export interface WsaNativeIoLease { readonly table: WsaSocketTable; release(): void; }
export type WsaIoPurpose = "data" | "connect" | "accept" | "acceptTarget" | "disconnect" | "transmit";
export class WsaSocketTable {
    private nextId = 0x10000000; // Opaque socket range, separate from std/file/kernel/COM handles.
    private sockets = new Map<number, SocketState>();
    // Private physical FIFO, shared by all aliases. Never serialized in a SocketState snapshot.
    // SO_ERROR and a successful send do not consume receive-only error records.
    private readonly udpReceiveQueues = new Map<number, UdpReceiveQueue>();
    private wireSockets = new Map<number, SocketState>();
    private readonly connectOrigins = new WeakMap<SocketState, WsaAddress>();
    private bindings = new Map<string, Binding>();
    // Logical family ownership and canonical wire coverage are distinct. One endpoint
    // can cover an AF4 owner and an AF23 dual owner; only the last ref unbinds it.
    private readonly bindingRefs = new WeakMap<SocketState, Set<Binding>>();
    private readonly connectionWire = new WeakMap<SocketState, number>();
    private listeners = new Set<() => void>();
    private epoch = 0;
    private ipIdentification = 0;
    private readonly multicastMemberships = new Map<number, Map<string, { group: Uint8Array; interfaceIndex: 1 | 2 }>>();
    private multicastMembershipCount = 0;
    private networkGeneration: number | undefined;
    private stateUnsubscribe: (() => void) | undefined;
    private writableUnsubscribe: (() => void) | undefined;
    private peerUnsubscribe: (() => void) | undefined;
    private socketErrorUnsubscribe: (() => void) | undefined;

    private callAbortSignal?: AbortSignal;
    private callErrorSink?: (code: number) => void;
    constructor(readonly network: LanNetwork = lanNetwork) {}
    /** Synchronous issue scope only; pending operations capture the signal before this returns. */
    withBlockingSignal<T>(signal: AbortSignal, issue: () => T, errorSink?: (code: number) => void): T {
        const old = this.callAbortSignal, oldSink = this.callErrorSink; this.callAbortSignal = signal; this.callErrorSink = errorSink;
        try { return issue(); } finally { this.callAbortSignal = old; this.callErrorSink = oldSink; }
    }
    get blockingSignal(): AbortSignal | undefined { return this.callAbortSignal; }
    get blockingErrorSink(): ((code: number) => void) | undefined { return this.callErrorSink; }

    private watchNetwork(): void {
        if (this.stateUnsubscribe) return;
        this.socketErrorUnsubscribe = this.network.onSocketError(error => {
            if (error.bindingGeneration !== undefined && error.bindingGeneration !== this.network.bindingGeneration(error.localPort, error.proto)) return;
            if (error.proto !== PROTO_UDP && error.proto !== PROTO_TCP && error.proto !== PROTO_UDP6 && error.proto !== PROTO_TCP6 && error.proto !== PROTO_RAW4 && error.proto !== PROTO_RAW6) return;
            const binding = this.bindings.get(error.proto + ":" + error.localPort);
            if (!binding) return;
            for (const id of binding.sockets) {
                const s = this.get(id);
                // SIO_UDP_CONNRESET suppresses future ICMP notifications, never an already queued error.
                if ((error.proto === PROTO_UDP || error.proto === PROTO_UDP6) && error.code === WSA.ECONNRESET && !s.udpConnReset) continue;
                if (s.peer && ((s.type !== 3 && s.peer.port !== error.remotePort) || !same(s.peer.node, error.node))) continue;
                if ((error.proto === PROTO_UDP || error.proto === PROTO_UDP6) && s.peer &&
                    this.wireAddress(s, s.peer).family !== (error.proto === PROTO_UDP ? 2 : 23)) continue;
                if (error.proto === PROTO_TCP || error.proto === PROTO_TCP6) {
                    if (this.proto(s) !== error.proto) continue;
                    if (error.wireId !== undefined && s.wireId !== error.wireId) continue;
                    if (!s.peer || s.eof || (s.state !== "connected" && s.state !== "connecting")) continue;
                    const connecting = s.state === "connecting";
                    if (connecting) this.restoreConnectAddress(s);
                    s.error = connecting && error.code === WSA.ECONNRESET ? WSA.ECONNREFUSED : error.code;
                    s.state = "failed"; if (s.connectTimer) clearTimeout(s.connectTimer);
                    this.event(s, connecting ? FD_CONNECT : FD_CLOSE, s.error);
                } else if ((error.proto === PROTO_UDP || error.proto === PROTO_UDP6) && error.code === WSA.ECONNRESET) {
                    const context = error.localUdp === undefined ? undefined : copyLocalUdpContext(error.localUdp);
                    if (error.localUdp !== undefined && (!context || context.source.family !== (error.proto === PROTO_UDP ? 2 : 23) ||
                        context.source.port !== error.localPort || context.destination.port !== error.remotePort ||
                        !(error.node instanceof Uint8Array) || error.node.length !== 6)) continue;
                    const from = context ? this.presentAddress(s, localUdpAddress(context.destination, error.node)) : undefined;
                    if (context && (!from || (s.peer &&
                        ((s.peer.ip && from.ip && !same(s.peer.ip, from.ip)) ||
                         (s.peer.ip6 && from.ip6 && !same(s.peer.ip6, from.ip6)))))) continue;
                    if (this.enqueueUdp(s, { kind: "error", ...(from ? { from } : {}) }))
                        this.event(s, FD_READ, 0, false);
                } else { s.error = error.code; this.event(s, FD_READ, error.code); }
            }
            this.changed();
        });
        this.peerUnsubscribe = this.network.onPeerDisconnect(node => {
            for (const s of this.sockets.values()) {
                if (s.type !== 1 || s.eof || !s.peer || !same(s.peer.node, node) ||
                    (s.state !== "connected" && s.state !== "connecting")) continue;
                const connecting = s.state === "connecting";
                if (connecting) this.restoreConnectAddress(s);
                s.error = connecting ? WSA.ECONNREFUSED : WSA.ECONNRESET; s.state = "failed";
                if (s.connectTimer) clearTimeout(s.connectTimer);
                this.event(s, connecting ? FD_CONNECT : FD_CLOSE, s.error);
            }
            this.changed();
        });
        this.writableUnsubscribe = this.network.onWritable(() => {
            for (const s of this.sockets.values()) if (s.writeBlocked) {
                s.writeBlocked = false; this.rearm(s, FD_WRITE); this.refreshEvents(s);
            }
            this.changed();
        });
        this.stateUnsubscribe = this.network.onStateChange(state => {
            const changed = this.networkGeneration !== undefined && this.networkGeneration !== state.generation;
            this.networkGeneration = state.generation;
            if (!state.connected || changed) {
                for (const s of this.sockets.values()) {
                    if (s.type !== 1 && s.peer && !same(s.peer.node, this.network.node) && !(s.af === 2 && s.type === 2 && multicast4(s.peer.ip))) {
                        s.error = state.connected ? 0 : WSA.ENETDOWN;
                        if (s.error) this.event(s, FD_READ, s.error);
                    }
                    if (s.type !== 1 && s.writeBlocked) {
                        s.writeBlocked = false; this.rearm(s, FD_WRITE); this.refreshEvents(s);
                    }
                    if (s.type === 1 && !s.eof && s.peer && !same(s.peer.node, this.network.node) && (s.state === "connecting" || s.state === "connected")) {
                        if (s.state === "connecting") this.restoreConnectAddress(s);
                        s.state = "failed";
                        s.error = WSA.ENETDOWN;
                        if (s.connectTimer) clearTimeout(s.connectTimer);
                        this.event(s, s.peerId ? FD_CLOSE : FD_CONNECT, s.error);
                    }
                }
            }
            if (state.connected) for (const s of this.sockets.values()) if (s.type !== 1 && s.error === WSA.ENETDOWN) s.error = 0;
            this.changed();
        });
    }

    reset(): void {
        for (const s of this.sockets.values()) if (s.connectTimer) clearTimeout(s.connectTimer);
        for (const b of this.bindings.values()) this.network.unbind(b.port, b.endpoint, b.proto);
        this.bindings.clear();
        this.sockets.clear(); this.wireSockets.clear(); this.udpReceiveQueues.clear();
        this.multicastMemberships.clear(); this.multicastMembershipCount = 0;
        // Do not recycle IDs: an old async completion must never target a new socket.
        this.epoch++;
        this.stateUnsubscribe?.();
        this.writableUnsubscribe?.();
        this.peerUnsubscribe?.();
        this.socketErrorUnsubscribe?.();
        this.socketErrorUnsubscribe = undefined;
        this.peerUnsubscribe = undefined;
        this.stateUnsubscribe = undefined;
        this.writableUnsubscribe = undefined;
        this.networkGeneration = undefined;
        this.changed();
    }
    get generation(): number { return this.epoch; }
    /** Kernel handle I/O bypasses Winsock context attachment; direct tables already own their handles. */
    get nativeHandleView(): WsaSocketTable { return this; }
    /** Stable file-object identity for alias-scoped kernel cancellation; no handle is imported. */
    fileObjectId(socket: number): number { return this.nativeHandleView.get(socket).id; }
    hasFileObject(objectId: number): boolean { return this.sockets.has(objectId); }
    get nativeIoGeneration(): number { return 0; }
    acquireNativeIo(socket: number, _purpose: WsaIoPurpose = "data"): WsaNativeIoLease {
        this.nativeHandleView.get(socket);
        return { table: this.nativeHandleView, release() {} };
    }
    subscribe(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }
    private changed(): void { for (const callback of [...this.listeners]) callback(); }
    get(s: number): SocketState {
        return this.sockets.get(s >>> 0) ?? fail(WSA.ENOTSOCK);
    }
    isValid(s: number): boolean { return this.sockets.has(s >>> 0); }
    isConnected(s: number): boolean { return this.sockets.get(s >>> 0)?.state === "connected"; }
    setHandleFlags(socket: number, mask: number, flags: number): number {
        const state = this.get(socket);
        state.handleFlags = (state.handleFlags & ~(mask & 3)) | (flags & mask & 3);
        return 0;
    }
    private multicastSocket(sid: number): SocketState {
        const socket = this.get(sid);
        if (socket.af !== 2 || socket.type !== 2) fail(WSA.EINVAL);
        return socket;
    }
    private multicastInterfaceIndex(ip: Uint8Array): 1 | 2 {
        if (!(ip instanceof Uint8Array) || ip.length !== 4) fail(WSA.EINVAL);
        if (ip[0] === 127) return 1;
        if (zeros(ip) || same(ip, this.network.ipv4)) return 2;
        fail(WSA.EADDRNOTAVAIL);
    }
    getMulticastOption(sid: number, option: number): number {
        const socket = this.multicastSocket(sid);
        if (option === 9) return socket.multicastInterface;
        if (option === 10) return socket.multicastTtl;
        if (option === 11) return +socket.multicastLoop;
        fail(WSA.ENOPROTOOPT);
    }
    setMulticastOption(sid: number, option: number, value: number): number {
        const socket = this.multicastSocket(sid);
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) fail(WSA.EINVAL);
        if (option === 9) {
            const ip = Uint8Array.of(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
            this.multicastInterfaceIndex(ip); socket.multicastInterface = value >>> 0;
        } else if (option === 10) {
            if (value === -1 || value === 0xffffffff) socket.multicastTtl = 255;
            else { if (value < 0 || value > 255) fail(WSA.EINVAL); socket.multicastTtl = value; }
        } else if (option === 11) socket.multicastLoop = value !== 0;
        else fail(WSA.ENOPROTOOPT);
        this.changed(); return 0;
    }
    changeMulticastMembership(sid: number, group: Uint8Array, rawInterface: Uint8Array, join: boolean): number {
        this.multicastSocket(sid);
        if (!(group instanceof Uint8Array) || group.length !== 4 || group[0] < 224 || group[0] > 239) fail(WSA.EADDRNOTAVAIL);
        const interfaceIndex = this.multicastInterfaceIndex(rawInterface), key = interfaceIndex + ":" + [...group].join(".");
        const memberships = this.multicastMemberships.get(sid);
        if (join) {
            if (memberships?.has(key)) fail(WSA.EINVAL);
            // Safety bounds, not a claim about the native provider's maximum.
            if ((memberships?.size ?? 0) >= 256 || this.multicastMembershipCount >= 4096) fail(WSA.ENOBUFS);
            const current = memberships ?? new Map<string, { group: Uint8Array; interfaceIndex: 1 | 2 }>();
            current.set(key, { group: group.slice(), interfaceIndex });
            this.multicastMemberships.set(sid, current); this.multicastMembershipCount++;
        } else {
            if (!memberships?.delete(key)) fail(WSA.EADDRNOTAVAIL);
            this.multicastMembershipCount--;
            if (!memberships.size) this.multicastMemberships.delete(sid);
        }
        this.changed(); return 0;
    }
    socket(type = 1, af = 2, protocol = 0): number {
        if (af !== 2 && af !== 6 && af !== 23) fail(WSA.EAFNOSUPPORT);
        if (type !== 1 && type !== 2 && type !== 3) fail(WSA.ESOCKTNOSUPPORT);
        if (af === 6 && type !== 2) fail(WSA.EPROTONOSUPPORT);
        const selectedProtocol = type === 3 ? protocol : protocol || (af === 6 ? 1000 : type === 1 ? 6 : 17);
        if (((af === 2 || af === 23) && (type === 3 ? selectedProtocol < 0 || selectedProtocol > 255 : selectedProtocol !== (type === 1 ? 6 : 17))) ||
            (af === 6 && (selectedProtocol < 1000 || selectedProtocol > 1255))) fail(WSA.EPROTONOSUPPORT);
        if (this.sockets.size >= 4096) fail(WSA.ENOBUFS);
        this.watchNetwork();
        const id = this.nextId++;
        let wireId: number;
        try { wireId = this.network.allocateSocketId(); } catch { fail(WSA.ENOBUFS); }
        this.sockets.set(id, {
            id, wireId, af, type, protocol: selectedProtocol, connectContextPending: false, disconnected: false, connectedAt: 0, nonBlocking: false, overlapped: true, handleFlags: 1, local: null, peer: null,
            state: "new", backlog: 1, pending: [], packets: [], chunks: [], offset: 0, available: 0,
            readShutdown: false, writeShutdown: false, eof: false, error: 0, pendingError: 0,
            oob: null, oobPending: [], oobInline: false, readPosition: 0, urgentMark: null, extendedAddress: false, receiveHeader: false, headerInclude: false, ipTtl: 128, ipTos: 0, ipOptionsChanged: false, keepAlive: false, noDelay: false, udpConnReset: true, v6Only: type !== 3, peerId: 0, credit: 0, writeBlocked: false,
            multicastInterface: 0, multicastTtl: 1, multicastLoop: true,
            broadcast: false, reuse: false, packetType: af === 6 ? selectedProtocol - 1000 : 0,
            filterPacketType: null, receiveBroadcast: true, receiveLimit: type === 2 && (af === 2 || af === 23) ? 65536 : BUFFER_LIMIT, sendLimit: BUFFER_LIMIT,
            receiveTimeout: 0, sendTimeout: 0, lingerEnabled: false, lingerSeconds: 0,
            eventMask: 0, eventPending: 0, eventErrors: new Array(10).fill(0), eventDisabled: 0,
        });
        this.wireSockets.set(wireId, this.get(id));
        return id;
    }
    private baseProto(s: SocketState): number { return s.type === 3 ? (s.af === 23 ? PROTO_RAW6 : PROTO_RAW4) : s.af === 6 ? PROTO_IPX : s.af === 23 ? (s.type === 1 ? PROTO_TCP6 : PROTO_UDP6) : s.type === 1 ? PROTO_TCP : PROTO_UDP; }
    private proto(s: SocketState): number { return this.connectionWire.get(s) ?? this.baseProto(s); }
    private wireAddress(s: SocketState, address: WsaAddress): WsaAddress {
        if (address.family !== s.af) fail(s.af === 23 && address.family === 2 ? WSA.EFAULT : WSA.EAFNOSUPPORT);
        const ip = s.type !== 3 && s.af === 23 ? mappedIpv4(address.ip6) : undefined;
        if (!ip) return copyAddress(address);
        if (s.v6Only) fail(WSA.EADDRNOTAVAIL);
        return { family: 2, port: address.port, node: address.node.slice(), ip };
    }
    private presentAddress(s: SocketState, address: WsaAddress): WsaAddress | undefined {
        if (s.af === address.family) return copyAddress(address);
        if (s.af !== 23 || s.v6Only || address.family !== 2 || !address.ip) return;
        return { family: 23, port: address.port, node: address.node.slice(),
            ip6: mappedIpv6(address.ip), scopeId: 0, flowInfo: 0 };
    }
    private acceptsDestination(s: SocketState, destination?: WsaAddress): boolean {
        if (!destination) return true;
        const bound = destination.family === 2 ? (s.af === 23 ? mappedIpv4(s.local?.ip6) : s.local?.ip) : s.local?.ip6;
        const address = destination.family === 2 ? destination.ip : destination.ip6;
        return !bound || zeros(bound) || !address || same(bound, address);
    }
    private selectConnectLocal(s: SocketState, peer: WsaAddress): void {
        const wire = this.wireAddress(s, peer), local = s.local!;
        if (wire.family === 2) {
            const loopback = wire.ip?.[0] === 127, ip = loopback ? Uint8Array.of(127, 0, 0, 1) : this.network.ipv4;
            if (local.ip && zeros(local.ip)) local.ip = ip.slice();
            if (local.ip6 && zeros(local.ip6)) local.ip6 = mappedIpv6(ip);
        } else if (local.ip6 && zeros(local.ip6)) {
            const loopback = wire.ip6?.slice(0, 15).every(v => v === 0) && wire.ip6[15] === 1;
            local.ip6 = (loopback ? wire.ip6! : this.network.ipv6).slice();
        }
    }
    private retainCoverage(s: SocketState, port: number, protocols: number[], initial?: Binding): boolean {
        const created: Binding[] = initial ? [initial] : [], refs = new Set<Binding>();
        let committed = false;
        try {
            for (const proto of protocols) {
                const key = proto + ":" + port;
                let binding = this.bindings.get(key);
                if (!binding) {
                    const endpoint: LanEndpoint = { deliver: packet => this.deliver(port, proto, packet) };
                    if (!this.network.bind(port, endpoint, proto, s.reuse || s.type === 3)) return false;
                    binding = { port, proto, endpoint, sockets: new Set() };
                    this.bindings.set(key, binding); created.push(binding);
                }
                refs.add(binding);
            }
            for (const binding of refs) binding.sockets.add(s.id);
            this.bindingRefs.set(s, refs); committed = true; return true;
        } finally {
            if (!committed) for (const binding of created) {
                this.network.unbind(binding.port, binding.endpoint, binding.proto);
                this.bindings.delete(binding.proto + ":" + binding.port);
            }
        }
    }
    private boundPort(s: SocketState): number { return s.type === 3 ? s.protocol + 1 : s.local!.port; }
    maxMessageSize(sid: number): number { const s = this.get(sid); return s.type === 1 ? 0 : s.type === 3 ? RAW_MAX_PACKET - (s.af === 2 && !s.headerInclude ? 20 : 0) : s.af === 6 ? IPX_MAX_PAYLOAD : s.af === 23 ? UDP6_MAX_PAYLOAD : UDP_MAX_PAYLOAD; }
    private localAddress(s: SocketState, port: number): WsaAddress {
        return { family: s.af, port, node: this.network.node.slice(),
            ...(s.af === 2 ? { ip: this.network.ipv4.slice() } : s.af === 23 ? { ip6: this.network.ipv6.slice(), scopeId: 0, flowInfo: 0 } : {}) };
    }
    bind(sid: number, address?: WsaAddress): number {
        const s = this.get(sid);
        if (s.local) fail(WSA.EINVAL);
        if (address && address.family !== s.af) fail(WSA.EAFNOSUPPORT);
        const mapped = s.type !== 3 && s.af === 23 ? mappedIpv4(address?.ip6) : undefined;
        if (mapped) {
            if (s.v6Only || (!zeros(mapped) && !same(mapped, this.network.ipv4) && mapped[0] !== 127)) fail(WSA.EADDRNOTAVAIL);
        } else if (address?.ip6 && !zeros(address.ip6) && !same(address.ip6, this.network.ipv6) &&
            !(address.ip6.slice(0, 15).every(v => !v) && address.ip6[15] === 1)) fail(WSA.EADDRNOTAVAIL);
        if (address && !address.ip6 && !zeros(address.node) && !(address.ip && zeros(address.ip)) && !same(address.node, this.network.node) &&
            !(address.ip?.[0] === 127)) fail(WSA.EADDRNOTAVAIL);
        const primary = mapped ? (s.type === 1 ? PROTO_TCP : PROTO_UDP) : this.baseProto(s);
        const protocols = s.af === 23 && s.type !== 3 && !s.v6Only && !mapped && (!address?.ip6 || zeros(address.ip6))
            ? [primary, s.type === 1 ? PROTO_TCP : PROTO_UDP] : [primary];
        let port = s.type === 3 ? s.protocol + 1 : address?.port ?? 0;
        if (port) {
            // Cross-family wire coverage is not an exclusive logical bind claim.
            const owners = [...this.sockets.values()].filter(other => other !== s && other.local &&
                other.af === s.af && other.type === s.type && this.boundPort(other) === port &&
                (s.type !== 3 || other.protocol === s.protocol));
            if (s.type !== 3 && owners.some(other => s.type === 1 || !s.reuse || !other.reuse)) fail(WSA.EADDRINUSE);
            if (!this.retainCoverage(s, port, protocols)) fail(WSA.EADDRINUSE);
        } else {
            // One public port, all lanes established before local state is published.
            let retained = false;
            for (let attempt = 0; attempt < 16384; attempt++) {
                const endpoint: LanEndpoint = { deliver: packet => this.deliver(port, primary, packet) };
                port = this.network.bindEphemeral(endpoint, primary);
                if (!port) break;
                // Ephemeral choice can avoid an occupied secondary lane even though
                // an explicit cross-family same-port bind remains permitted.
                if (protocols.some(proto => proto !== primary && this.bindings.has(proto + ":" + port))) {
                    this.network.unbind(port, endpoint, primary); continue;
                }
                const binding: Binding = { port, proto: primary, endpoint, sockets: new Set() };
                this.bindings.set(primary + ":" + port, binding);
                if (this.retainCoverage(s, port, protocols, binding)) { retained = true; break; }
            }
            if (!retained) fail(WSA.ENOBUFS);
        }
        s.local = this.localAddress(s, s.type === 3 ? 0 : port);
        if (s.af === 2) s.local.ip = address?.ip?.slice() ?? new Uint8Array(4);
        if (s.af === 23) s.local.ip6 = address?.ip6?.slice() ?? new Uint8Array(16);
        return 0;
    }
    private autoBind(s: SocketState): void { if (!s.local) this.bind(s.id); }
    private restoreConnectAddress(s: SocketState): void {
        const original = this.connectOrigins.get(s);
        if (original && s.local) { s.local.ip = original.ip?.slice(); s.local.ip6 = original.ip6?.slice(); }
        this.connectOrigins.delete(s);
    }
    private detach(s: SocketState): void {
        const refs = this.bindingRefs.get(s);
        if (!refs) return;
        this.bindingRefs.delete(s);
        for (const binding of refs) {
            binding.sockets.delete(s.id);
            if (!binding.sockets.size) {
                this.network.unbind(binding.port, binding.endpoint, binding.proto);
                this.bindings.delete(binding.proto + ":" + binding.port);
            }
        }
    }
    closesocket(sid: number): number {
        const s = this.get(sid);
        if (s.handleFlags & 2) return 0; // Windows reports success while the protected OS descriptor stays open.
        if (s.connectTimer) clearTimeout(s.connectTimer);
        if (s.type === 1 && s.peer && (s.state === "connected" || s.state === "connecting")) {
            this.frame(s, (s.lingerEnabled && !s.lingerSeconds) || s.available || s.state === "connecting" ? RST : FIN);
        }
        for (const child of [...s.pending]) if (this.isValid(child)) this.closesocket(child);
        this.detach(s);
        this.multicastMembershipCount -= this.multicastMemberships.get(sid)?.size ?? 0;
        this.multicastMemberships.delete(sid);
        this.sockets.delete(sid >>> 0); this.wireSockets.delete(s.wireId); this.udpReceiveQueues.delete(s.id);
        this.changed();
        return 0;
    }
    listen(sid: number, backlog = 5): number {
        const s = this.get(sid);
        if (s.type !== 1) fail(WSA.EOPNOTSUPP);
        if (s.state === "connected" || s.state === "connecting") fail(WSA.EISCONN);
        this.autoBind(s);
        s.state = "listening";
        s.backlog = Math.min(128, Math.max(1, backlog | 0));
        return 0;
    }
    acceptError(sid: number): number {
        if (!this.isValid(sid)) return WSA.ENOTSOCK;
        const s = this.get(sid);
        if (s.type !== 1) return WSA.EOPNOTSUPP;
        if (s.state !== "listening") return WSA.EINVAL;
        return s.pending.length ? 0 : s.nonBlocking ? WSA.EWOULDBLOCK : 0;
    }
    accept(sid: number): number {
        const s = this.get(sid);
        if (s.type !== 1) fail(WSA.EOPNOTSUPP);
        if (s.state !== "listening") fail(WSA.EINVAL);
        this.rearm(s, FD_ACCEPT);
        const id = s.pending.shift();
        if (id === undefined) fail(WSA.EWOULDBLOCK);
        const child = this.get(id);
        child.nonBlocking = s.nonBlocking;
        child.eventMask = s.eventMask;
        child.notify = s.notify;
        this.refreshEvents(s);
        return id;
    }
    /** AcceptEx fills the caller's socket handle while preserving its established wire identity. */
    acceptInto(listener: number, targetTable: WsaSocketTable, target: number): void {
        const accepted = this.accept(listener);
        try { this.adoptAccepted(targetTable.fileObjectId(target), accepted); }
        catch (error) { this.deferAccepted(listener, accepted); throw error; }
        const state = targetTable.get(target); state.acceptListener = listener; state.acceptListenerObjectId = this.fileObjectId(listener);
    }
    adoptAccepted(target: number, accepted: number): void {
        const old = this.get(target), socket = this.get(accepted);
        if (old.type !== 1 || old.af !== socket.af || old.local || old.state !== "new") fail(WSA.EINVAL);
        for (const binding of this.bindingRefs.get(socket) ?? []) {
            binding.sockets.delete(accepted); binding.sockets.add(target);
        }
        this.sockets.delete(accepted); this.wireSockets.delete(old.wireId);
        socket.id = target; socket.originalLocal = old.local; socket.nonBlocking = old.nonBlocking; socket.overlapped = old.overlapped;
        socket.eventMask = old.eventMask; socket.notify = old.notify;
        socket.eventPending = 0; socket.eventDisabled = 0; socket.eventErrors.fill(0);
        this.sockets.set(target, socket); this.changed();
    }
    disconnect(sid: number, reuse: boolean): void {
        const socket = this.get(sid);
        if (socket.type !== 1 || socket.state !== "connected") fail(WSA.ENOTCONN);
        if (!socket.writeShutdown) { if (!this.frame(socket, FIN)) fail(WSA.ENETDOWN); socket.writeShutdown = true; }
        if (!socket.eof) fail(WSA.EWOULDBLOCK);
        if (!reuse) {
            socket.readShutdown = socket.writeShutdown = true; socket.disconnected = true;
            socket.chunks = []; socket.available = 0; this.changed(); return;
        }
        const retainLocal = socket.originalLocal === null ? null : socket.local;
        if (!retainLocal) this.detach(socket);
        this.wireSockets.delete(socket.wireId);
        const temporary = this.socket(socket.type, socket.af, socket.protocol), replacement = this.get(temporary);
        this.sockets.delete(temporary); replacement.id = sid; replacement.local = retainLocal;
        replacement.nonBlocking = socket.nonBlocking; replacement.overlapped = socket.overlapped; replacement.broadcast = socket.broadcast; replacement.reuse = socket.reuse;
        replacement.receiveLimit = socket.receiveLimit; replacement.sendLimit = socket.sendLimit;
        replacement.receiveTimeout = socket.receiveTimeout; replacement.sendTimeout = socket.sendTimeout; replacement.oobInline = socket.oobInline;
        replacement.lingerEnabled = socket.lingerEnabled; replacement.lingerSeconds = socket.lingerSeconds;
        replacement.keepAlive = socket.keepAlive; replacement.noDelay = socket.noDelay; replacement.v6Only = socket.v6Only;
        if (retainLocal) {
            const refs = this.bindingRefs.get(socket);
            if (refs) { this.bindingRefs.set(replacement, refs); this.bindingRefs.delete(socket); }
        }
        replacement.eventMask = socket.eventMask; replacement.notify = socket.notify;
        this.sockets.set(sid, replacement); this.changed();
    }
    deferAccepted(listener: number, child: number): void {
        const socket = this.get(listener); this.get(child);
        if (socket.state !== "listening") fail(WSA.EINVAL);
        socket.pending.unshift(child); this.rearm(socket, FD_ACCEPT); this.refreshEvents(socket); this.changed();
    }
    rejectAccepted(child: number): void {
        const socket = this.get(child);
        this.frame(socket, RST, WSA.ECONNREFUSED); socket.state = "failed";
        this.closesocket(child);
    }
    connect(sid: number, peer?: WsaAddress): number {
        const s = this.get(sid);
        if (s.disconnected) fail(WSA.EINVAL);
        if (!peer) fail(WSA.EFAULT);
        if (s.type !== 1 && (!peer.family || (zeros(peer.node) && (!peer.ip6 || zeros(peer.ip6))))) {
            s.peer = null;
            s.state = "new";
            return 0;
        }
        const strictMapped = s.type === 1 && s.af === 23 && s.v6Only && !!mappedIpv4(peer.ip6);
        const wirePeer = strictMapped ? copyAddress(peer) : this.wireAddress(s, peer);
        if (s.type !== 3 && !peer.port) fail(WSA.EADDRNOTAVAIL);
        if (s.type !== 1) {
            this.autoBind(s);
            s.peer = s.type === 2 && s.af === 2 && peer.ip && peer.ip[0] >= 224 && peer.ip[0] <= 239
                ? { ...peer, ip: peer.ip.slice(), node: Uint8Array.of(2, 3, ...peer.ip) }
                : this.routeAddress({ ...peer, port: s.type === 3 ? 0 : peer.port });
            s.error = 0;
            this.selectConnectLocal(s, s.peer);
            s.state = "connected";
            return 0;
        }
        if (s.state === "connected") fail(WSA.EISCONN);
        if (s.state === "connecting") fail(WSA.EALREADY);
        if (s.state === "listening") fail(WSA.EINVAL);
        if (!s.wireId) {
            try { s.wireId = this.network.allocateSocketId(); } catch { fail(WSA.ENOBUFS); }
            this.wireSockets.set(s.wireId, s);
        }
        if (broadcast(peer.node)) fail(WSA.EADDRNOTAVAIL);
        this.autoBind(s);
        s.peer = this.routeAddress(peer);
        this.connectOrigins.set(s, { ...s.local!, ip: s.local!.ip?.slice(), ip6: s.local!.ip6?.slice() });
        if (strictMapped) {
            // Modern TCP reports a pending connect, then the address failure through
            // completion/SO_ERROR. No IPv4 SYN may escape an IPv6-only socket.
            s.state = "connecting"; s.error = 0;
            const attemptedPeer = s.peer;
            queueMicrotask(() => {
                if (this.sockets.get(s.id) !== s || s.state !== "connecting" || s.peer !== attemptedPeer) return;
                this.restoreConnectAddress(s); s.state = "failed"; s.error = WSA.EADDRNOTAVAIL;
                this.event(s, FD_CONNECT, s.error); this.changed();
            });
            fail(WSA.EWOULDBLOCK);
        }
        this.selectConnectLocal(s, s.peer);
        this.connectionWire.set(s, wirePeer.family === 2 ? PROTO_TCP : PROTO_TCP6);
        s.state = "connecting";
        s.error = 0;
        if (s.af === 2 && multicast4(peer.ip)) {
            this.restoreConnectAddress(s);
            const attemptedPeer = s.peer;
            queueMicrotask(() => {
                if (this.sockets.get(s.id) !== s || s.state !== "connecting" || s.peer !== attemptedPeer) return;
                s.state = "failed"; s.error = WSA.EADDRNOTAVAIL;
                this.event(s, FD_CONNECT, s.error); this.changed();
            });
            fail(WSA.EWOULDBLOCK);
        }
        if (!this.frame(s, SYN, this.synValue(s))) {
            this.restoreConnectAddress(s);
            s.state = "new";
            fail(WSA.ENETDOWN);
        }
        if (this.isConnected(sid)) return 0; // Synchronous local handshake.
        if (s.error) fail(s.error);
        s.connectTimer = setTimeout(() => {
            if (s.state !== "connecting") return;
            this.restoreConnectAddress(s);
            s.state = "failed"; s.error = WSA.ETIMEDOUT;
            this.event(s, FD_CONNECT, s.error); this.changed();
        }, 10000);
        fail(WSA.EWOULDBLOCK);
    }
    cancelConnect(sid: number): void {
        if (!this.isValid(sid)) return;
        const socket = this.get(sid);
        if (socket.type !== 1 || socket.state !== "connecting") return;
        this.frame(socket, RST, WSA.ECONNRESET);
        this.restoreConnectAddress(socket);
        if (socket.connectTimer) clearTimeout(socket.connectTimer);
        this.wireSockets.delete(socket.wireId);
        // A cancelled identity must never receive a late SYNACK, even if identity allocation is exhausted.
        try { socket.wireId = this.network.allocateSocketId(); } catch { socket.wireId = 0; }
        if (socket.wireId) this.wireSockets.set(socket.wireId, socket);
        socket.peerId = 0; socket.state = "failed"; socket.error = WSA.EINTR;
        this.event(socket, FD_CONNECT, socket.error); this.changed();
    }
    private routeAddress(peer: WsaAddress): WsaAddress {
        try {
            const mapped = mappedIpv4(peer.ip6);
            const node = mapped ? this.routeAddress(ipv4Address(mapped, peer.port)).node :
                peer.ip6 ? this.network.routeIpv6(peer.ip6, peer.scopeId ?? 0) : peer.ip?.[0] === 127 ? this.network.node.slice() :
                peer.ip ? this.network.routeIpv4(peer.ip) : peer.node.slice();
            if (peer.ip6 && peer.scopeId && node[0] === 2 && node[1] === 0) fail(WSA.EADDRNOTAVAIL);
            return { ...peer, node, ip: peer.ip?.slice(), ip6: peer.ip6?.slice() };
        } catch (error) { if (error instanceof WsaFailure) throw error; fail((error as { code?: string })?.code === "ACCESS_DENIED" ? WSA.EACCES : WSA.EADDRNOTAVAIL); }
    }
    private localUdpContext(s: SocketState, destination: WsaAddress): LocalUdpContext | undefined {
        if (s.type !== 2 || (s.af !== 2 && s.af !== 23) || !s.local ||
            !this.network.isSelf(destination.node) || broadcast(destination.node) || multicast4(destination.ip) ||
            destination.ip6?.[0] === 255) return;
        const family = destination.family;
        const address = family === 2 ? destination.ip : destination.ip6;
        if (!address) return; // Legacy node-only callers have no original IP endpoint to preserve.
        const bound = family === 2 ? s.local.ip ?? mappedIpv4(s.local.ip6) : s.local.ip6;
        const loopback = family === 2 ? address[0] === 127 : address.slice(0, 15).every(v => v === 0) && address[15] === 1;
        const source = bound && !zeros(bound) ? bound : loopback ?
            (family === 2 ? Uint8Array.of(127, 0, 0, 1) : Uint8Array.from([...new Array<number>(15).fill(0), 1])) :
            (family === 2 ? this.network.ipv4 : this.network.ipv6);
        return copyLocalUdpContext({
            source: { family, address: source, port: this.boundPort(s),
                ...(family === 23 ? { scopeId: s.local.scopeId ?? 0, flowInfo: s.local.flowInfo ?? 0 } : {}) },
            destination: { family, address, port: destination.port,
                ...(family === 23 ? { scopeId: destination.scopeId ?? 0, flowInfo: destination.flowInfo ?? 0 } : {}) },
        });
    }
    send(sid: number, bytes: Uint8Array | number, to?: WsaAddress, flags = 0): number {
        const s = this.get(sid);
        if (typeof bytes === "number") fail(WSA.EFAULT);
        if (flags & ~5) fail(WSA.EOPNOTSUPP);
        if (s.writeShutdown) fail(WSA.ESHUTDOWN);
        if (s.error) {
            const error = s.error;
            if (s.type !== 1 && error !== WSA.ENETDOWN) { s.error = 0; s.pendingError = 0; }
            fail(error);
        }
        if (s.type !== 1) {
            if (flags & 1) fail(WSA.EOPNOTSUPP);
            const dst = to ?? s.peer;
            if (!dst) fail(WSA.EDESTADDRREQ);
            const canonical = this.wireAddress(s, dst);
            const maximum = s.type === 2 && canonical.family === 2 ? UDP_MAX_PAYLOAD : this.maxMessageSize(sid);
            if (bytes.length > maximum) fail(WSA.EMSGSIZE);
            if (broadcast(dst.node) && !s.broadcast) fail(WSA.EACCES);
            if (s.type !== 3 && !dst.port) fail(WSA.EADDRNOTAVAIL);
            if (s.type === 3 && s.af === 2 && multicast4(dst.ip)) fail(WSA.EOPNOTSUPP);
            this.autoBind(s);
            if (s.type === 2 && s.af === 2 && dst.ip && dst.ip[0] >= 224 && dst.ip[0] <= 239) {
                const value = s.multicastInterface, ip = Uint8Array.of(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
                const interfaceIndex = this.multicastInterfaceIndex(ip);
                if (interfaceIndex === 2 && s.multicastTtl > 0 && this.network.connected && !this.network.udpMulticast4V1) fail(WSA.EOPNOTSUPP);
                if (!this.network.sendMulticast4(this.boundPort(s), dst.ip, dst.port, bytes, interfaceIndex, s.multicastTtl)) {
                    if (!this.network.connected && interfaceIndex === 2 && s.multicastTtl > 0) fail(WSA.ENETDOWN);
                    s.writeBlocked = true; this.rearm(s, FD_WRITE); fail(WSA.EWOULDBLOCK);
                }
                return bytes.length;
            }
            let payload: Uint8Array = bytes, destination = this.routeAddress(canonical), destinationPort = dst.port;
            if (s.type === 3) {
                let protocol = s.protocol;
                if (s.headerInclude) {
                    const header = parseRawIp(bytes, s.af);
                    if (!header) fail(WSA.EINVAL);
                    protocol = header.protocol; payload = header.packet;
                    if (s.af === 2) {
                        if (zeros(header.source)) payload.set(this.network.ipv4, 12);
                        if (zeros(header.destination)) payload.set(dst.ip ?? this.network.ipv4, 16);
                        const view = new DataView(payload.buffer); view.setUint16(2, payload.length);
                        if (!view.getUint16(4)) view.setUint16(4, ++this.ipIdentification & 0xffff);
                        view.setUint16(10, 0); view.setUint16(10, ipChecksum(payload.subarray(0, header.headerLength)));
                    }
                    destination = this.routeAddress(s.af === 2 ? ipv4Address(payload.slice(16, 20), 0) : ipv6Address(payload.slice(24, 40), 0));
                } else if (s.af === 23 && s.protocol === 58) {
                    const offset = 2;
                    if (offset + 2 > payload.length) fail(WSA.EINVAL);
                    payload = payload.slice(); payload[offset] = payload[offset + 1] = 0;
                    const pseudo = new Uint8Array(40 + payload.length); pseudo.set(this.network.ipv6);
                    pseudo.set(destination.ip6!, 16); const view = new DataView(pseudo.buffer);
                    view.setUint32(32, payload.length); pseudo[39] = protocol; pseudo.set(payload, 40);
                    new DataView(payload.buffer).setUint16(offset, ipChecksum(pseudo));
                }
                if (s.af === 2 && multicast4(destination.ip)) fail(WSA.EOPNOTSUPP);
                const prefix = s.ipOptionsChanged ? 5 : 2, framed = new Uint8Array(payload.length + prefix);
                framed[0] = protocol; framed[1] = +s.headerInclude | (s.ipOptionsChanged ? 2 : 0);
                if (s.ipOptionsChanged) { new DataView(framed.buffer).setInt16(2, s.ipTtl, true); framed[4] = s.ipTos; }
                framed.set(payload, prefix); payload = framed; destinationPort = protocol + 1;
            }
            if (s.af === 6) {
                payload = new Uint8Array(bytes.length + 2);
                payload[0] = s.extendedAddress && dst.packetType !== undefined ? dst.packetType : s.packetType;
                payload[1] = broadcast(dst.node) ? 1 : 0; payload.set(bytes, 2);
            }
            const localUdp = this.localUdpContext(s, destination);
            const wireProto = s.type === 2 && destination.family === 2 && s.af === 23 ? PROTO_UDP : this.proto(s);
            const sent = localUdp ?
                this.network.send(this.boundPort(s), destination.node, destinationPort, payload, wireProto, undefined, localUdp) :
                this.network.send(this.boundPort(s), destination.node, destinationPort, payload, wireProto);
            if (!sent) {
                if (!this.network.connected) fail(WSA.ENETDOWN);
                s.writeBlocked = true; this.rearm(s, FD_WRITE); fail(WSA.EWOULDBLOCK);
            }
            return bytes.length;
        }
        if (s.state !== "connected") fail(WSA.ENOTCONN);
        if (!bytes.length) return 0;
        if (flags & 1) {
            if (bytes.length > 1) {
                const sent = this.send(sid, bytes.subarray(0, bytes.length - 1));
                if (sent !== bytes.length - 1) return sent;
            }
            if (!s.credit) {
                this.rearm(s, FD_WRITE);
                if (bytes.length > 1) return bytes.length - 1;
                fail(WSA.EWOULDBLOCK);
            }
            s.credit--;
            if (!this.frame(s, OOB, 0, bytes.subarray(bytes.length - 1))) {
                s.credit++; s.writeBlocked = true; this.rearm(s, FD_WRITE);
                if (bytes.length > 1) return bytes.length - 1;
                fail(WSA.EWOULDBLOCK);
            }
            return bytes.length;
        }
        const n = Math.min(bytes.length, s.credit, TCP_SEGMENT, s.sendLimit);
        if (!n) { this.rearm(s, FD_WRITE); fail(WSA.EWOULDBLOCK); }
        // Decrement before synchronous loopback can send CREDIT back.
        s.credit -= n;
        if (!this.frame(s, DATA, 0, bytes.subarray(0, n))) {
            s.credit += n; s.writeBlocked = true; this.rearm(s, FD_WRITE); fail(WSA.EWOULDBLOCK);
        }
        return n;
    }
    sendto(sid: number, bytes: Uint8Array | number, to?: WsaAddress): number { return this.send(sid, bytes, to); }
    /** Admission updates the complete physical record and counters before publishing readiness. */
    private enqueueUdp(s: SocketState, record: UdpReceiveRecord): boolean {
        const current = this.udpReceiveQueues.get(s.id);
        const window = Math.max(1, s.receiveLimit);
        // NT5 recvdg.c and misc.c test CURRENT physical occupancy, including
        // zero-byte datagrams and receive-only status records. The first whole
        // record may cross the window; PEEK retains its charge until consumption.
        if (s.available >= window || (s.available === 0 &&
            (current?.records.length ?? 0) * NT5_X86_UDP_RECEIVE_TAG_BYTES >= window)) return false;
        if ("data" in record) {
            // Object caps remain local resource bounds, separate from the source quota.
            if ((current?.dataCount ?? 0) >= PACKET_LIMIT) return false;
        } else if ((current?.errorCount ?? 0) >= UDP_ERROR_RECORD_LIMIT) return false;
        const queue: UdpReceiveQueue = current ?? { records: [], dataCount: 0, errorCount: 0 };
        queue.records.push(record);
        if ("data" in record) { queue.dataCount++; s.available += record.data.length; }
        else queue.errorCount++;
        if (!current) this.udpReceiveQueues.set(s.id, queue);
        return true;
    }
    private receiveUdp(s: SocketState, length: number, flags: number): WsaPacket {
        const queue = this.udpReceiveQueues.get(s.id), head = queue?.records[0];
        // Generic socket errors retain their previous priority when no data is queued.
        // They are separate from receive-only UDP errors and the SO_ERROR latch.
        if (!queue?.dataCount && s.error) {
            const error = s.error;
            if (error !== WSA.ENETDOWN) { s.error = 0; s.pendingError = 0; }
            fail(error);
        }
        if (!queue || !head) fail(WSA.EWOULDBLOCK);
        if (!(flags & 2)) {
            queue.records.shift();
            if ("data" in head) { queue.dataCount--; s.available -= head.data.length; }
            else queue.errorCount--;
            if (!queue.records.length) this.udpReceiveQueues.delete(s.id);
        }
        this.refreshEvents(s);
        if (!("data" in head)) {
            // Every PEEK owns a fresh address copy; caller mutation cannot affect the retained head.
            if (head.from) throw new WsaUdpReceiveFailure(head.from);
            fail(WSA.ECONNRESET);
        }
        return { from: head.from, data: head.data.slice(0, length), truncated: head.data.length > length };
    }
    receive(sid: number, length: number, flags = 0): WsaPacket {
        const s = this.get(sid);
        this.rearm(s, FD_READ);
        if (flags & ~11) fail(WSA.EOPNOTSUPP);
        if ((flags & 9) === 9) fail(WSA.EINVAL);
        if (s.type === 2 && (s.af === 2 || s.af === 23) && !s.local) fail(WSA.EINVAL);
        if (s.readShutdown) fail(WSA.ESHUTDOWN);
        if (s.type !== 1) {
            if (flags & 9) fail(WSA.EOPNOTSUPP);
            if (!s.local) { if (s.type === 3) this.autoBind(s); else fail(WSA.EINVAL); }
            if (s.type === 2 && (s.af === 2 || s.af === 23)) return this.receiveUdp(s, length, flags);
            const packet = s.packets[0];
            if (!packet) {
                if (s.error) { const error = s.error; if (error !== WSA.ENETDOWN) { s.error = 0; s.pendingError = 0; } fail(error); }
                fail(WSA.EWOULDBLOCK);
            }
            if (!(flags & 2)) { s.packets.shift(); s.available -= packet.data.length; }
            this.refreshEvents(s);
            let data = packet.data;
            if (s.receiveHeader && packet.ipxHeader) {
                data = new Uint8Array(packet.ipxHeader.length + packet.data.length);
                data.set(packet.ipxHeader); data.set(packet.data, packet.ipxHeader.length);
            }
            return { from: packet.from, data: data.slice(0, length), truncated: data.length > length };
        }
        if (!s.peer || (s.state !== "connected" && s.state !== "failed")) fail(WSA.ENOTCONN);
        if (!length) return { data: new Uint8Array(0), from: s.peer };
        if (flags & 1) {
            this.rearm(s, FD_OOB);
            if (s.oobInline || s.oob === null) fail(WSA.EINVAL);
            const data = new Uint8Array([s.oob]);
            if (!(flags & 2)) {
                const next = s.oobPending.shift(); s.oob = next?.value ?? null; s.urgentMark = next?.mark ?? null;
                if (!s.eof && !this.frame(s, CREDIT, 1)) { s.error = WSA.ENETDOWN; s.state = "failed"; this.event(s, FD_CLOSE, s.error); }
            }
            this.refreshEvents(s);
            return { data, from: s.peer };
        }
        if ((flags & 8) && s.available < length && !s.eof && !s.error) fail(WSA.EWOULDBLOCK);
        if (!s.available) {
            if (s.error) fail(s.error);
            if (s.eof) return { data: new Uint8Array(0), from: s.peer };
            fail(WSA.EWOULDBLOCK);
        }
        let n = Math.min(length, s.available);
        if ((flags & 2) && !s.oobInline) {
            const mark = [s.urgentMark, ...s.oobPending.map(record => record.mark)].find(mark => mark !== null && mark > s.readPosition);
            if (mark !== undefined && mark !== null) n = Math.min(n, mark - s.readPosition);
        }
        const data = new Uint8Array(n);
        let copied = 0, index = 0, offset = s.offset;
        while (copied < n) {
            const chunk = s.chunks[index];
            const take = Math.min(n - copied, chunk.length - offset);
            data.set(chunk.subarray(offset, offset + take), copied);
            copied += take; offset += take;
            if (offset === chunk.length) { index++; offset = 0; }
        }
        if (!(flags & 2)) {
            s.chunks.splice(0, index); s.offset = offset; s.available -= n; s.readPosition += n;
            while (s.oobInline && s.urgentMark !== null && s.readPosition > s.urgentMark) {
                const next = s.oobPending.shift(); s.oob = next?.value ?? null; s.urgentMark = next?.mark ?? null;
            }
            // FIN forbids further bytes in this direction, so returning receive credit is unnecessary.
            // A fully closed remote descriptor may already have released its wire port.
            if (!s.eof && !this.frame(s, CREDIT, n)) {
                s.error = WSA.ENETDOWN; s.state = "failed"; this.event(s, FD_CLOSE, s.error); this.changed();
            }
        }
        this.refreshEvents(s);
        return { data, from: s.peer };
    }
    recv(sid: number): number { return this.receive(sid, 1).data.length; }
    recvfrom(sid: number): number { return this.recv(sid); }
    shutdown(sid: number, how = 2): number {
        const s = this.get(sid);
        if (how < 0 || how > 2) fail(WSA.EINVAL);
        if (s.state !== "connected" && !(s.type === 2 && (s.af === 2 || s.af === 23))) fail(WSA.ENOTCONN);
        if (how !== 1) {
            s.readShutdown = true;
            // NT5 datagram shutdown records the mode without purging the physical receive queue.
            if (!(s.type === 2 && (s.af === 2 || s.af === 23))) { s.packets = []; s.chunks = []; s.available = 0; }
        }
        if (how !== 0 && !s.writeShutdown) {
            if (s.type === 1 && !this.frame(s, FIN)) fail(WSA.ENETDOWN);
            s.writeShutdown = true;
        }
        this.changed();
        return 0;
    }
    private synValue(socket: SocketState): number {
        return (socket.receiveLimit | (socket.oobInline ? SYN_INLINE_FLAG : 0) |
            (socket.keepAlive ? SYN_KEEPALIVE_FLAG : 0) | (socket.noDelay ? SYN_NODELAY_FLAG : 0)) >>> 0;
    }
    private setNativeTcpOption(sid: number, key: "keepAlive" | "noDelay", on: boolean, option: number): void {
        const socket = this.get(sid);
        if ((socket.af !== 2 && socket.af !== 23) || socket.type !== 1) fail(key === "noDelay" ? WSA.EINVAL : WSA.ENOPROTOOPT);
        if (socket[key] === on) return;
        if ((socket.state === "connected" || socket.state === "connecting") && !this.frame(socket, TCP_OPTION, option | +on)) fail(WSA.ENETDOWN);
        socket[key] = on;
    }
    setKeepAlive(sid: number, on: boolean): void { this.setNativeTcpOption(sid, "keepAlive", on, TCP_OPTION_KEEPALIVE); }
    setNoDelay(sid: number, on: boolean): void { this.setNativeTcpOption(sid, "noDelay", on, TCP_OPTION_NODELAY); }
    setOobInline(sid: number, on: boolean): void {
        const socket = this.get(sid);
        if (socket.oobInline === on) return;
        if ((socket.state === "connected" || socket.state === "connecting") && !this.frame(socket, TCP_OPTION, +on)) fail(WSA.ENETDOWN);
        const records = socket.oob === null ? [] : [{ value: socket.oob, mark: socket.urgentMark ?? socket.readPosition }, ...socket.oobPending];
        if (records.length) {
            const data = new Uint8Array(socket.available); let count = 0;
            socket.chunks.forEach((chunk, i) => { const part = chunk.subarray(i ? 0 : socket.offset); data.set(part, count); count += part.length; });
            const output: number[] = [], updated: Array<{ value: number; mark: number }> = [];
            if (on) {
                let position = 0;
                for (const record of records) {
                    const until = Math.max(position, Math.min(data.length, record.mark - socket.readPosition));
                    while (position < until) output.push(data[position++]);
                    updated.push({ value: record.value, mark: socket.readPosition + output.length }); output.push(record.value);
                }
                while (position < data.length) output.push(data[position++]);
            } else {
                const excluded = new Map(records.map(record => [Math.max(0, record.mark - socket.readPosition), record]));
                for (let i = 0; i < data.length; i++) {
                    const record = excluded.get(i);
                    if (record) updated.push({ value: record.value, mark: socket.readPosition + output.length }); else output.push(data[i]);
                }
            }
            socket.chunks = output.length ? [Uint8Array.from(output)] : []; socket.offset = 0; socket.available = output.length;
            socket.oob = updated[0]?.value ?? null; socket.urgentMark = updated[0]?.mark ?? null; socket.oobPending = updated.slice(1);
        }
        socket.oobInline = on; this.refreshEvents(socket); this.changed();
    }
    /** This provider option belongs to the physical UDP socket, including reserved aliases. */
    setUdpConnReset(sid: number, on: boolean): void {
        const s = this.get(sid);
        if (typeof on !== "boolean" || s.type !== 2 || (s.af !== 2 && s.af !== 23)) fail(WSA.EINVAL);
        s.udpConnReset = on;
    }
    setV6Only(sid: number, on: boolean): void {
        const s = this.get(sid);
        if (typeof on !== "boolean" || (s.af !== 2 && s.af !== 23)) fail(WSA.EINVAL);
        if (s.local) fail(WSA.EINVAL);
        s.v6Only = on;
        this.changed();
    }
    setNonBlocking(sid: number, on: boolean): void {
        const s = this.get(sid);
        if (!on && s.eventMask) fail(WSA.EINVAL);
        s.nonBlocking = on;
    }
    readable(sid: number): boolean {
        const s = this.get(sid);
        const datagram = s.type === 2 && (s.af === 2 || s.af === 23);
        // UDP shutdown does not create a receive record; retained zero-byte records still count.
        return !!(s.pending.length || s.packets.length || s.available || s.eof || s.error ||
            this.udpReceiveQueues.get(s.id)?.records.length || (!datagram && s.readShutdown));
    }
    writable(sid: number): boolean {
        const s = this.get(sid);
        return !s.writeShutdown && !s.error && !s.writeBlocked && (s.type !== 1 || (s.state === "connected" && s.credit > 0));
    }
    exceptional(sid: number): boolean { const s = this.get(sid); return (s.state === "failed" && !!s.error) || (!s.oobInline && s.oob !== null); }
    /** Windows SIOCATMARK reports TRUE when no urgent data remains (unlike BSD sockatmark). */
    atMark(sid: number): boolean { return this.get(sid).oob === null; }
    bytesAvailable(sid: number): number {
        const s = this.get(sid);
        // IP UDP FIONREAD snapshots all queued payload bytes, without consuming a datagram.
        if (s.type === 2 && (s.af === 2 || s.af === 23))
            return s.available || (this.udpReceiveQueues.get(s.id)?.records.length ? 1 : 0);
        return s.type !== 1 ? (s.packets[0]?.data.length ?? 0) + (s.receiveHeader && s.packets[0]?.ipxHeader ? 30 : 0) : s.available;
    }
    configureEvents(sid: number, mask: number, notify?: (bit: number, error: number) => void): void {
        const s = this.get(sid);
        s.eventMask = mask; s.eventPending = 0; s.eventDisabled = 0; s.eventErrors.fill(0); s.notify = notify;
        if (mask) s.nonBlocking = true;
        this.refreshEvents(s);
    }
    enumEvents(sid: number): { mask: number; errors: number[] } {
        const s = this.get(sid);
        const result = { mask: s.eventPending, errors: s.eventErrors.slice() };
        s.eventPending = 0; s.eventErrors.fill(0);
        return result;
    }
    private event(s: SocketState, bit: number, error = 0, latchError = true): void {
        if (error && latchError) s.pendingError = error;
        if (!(s.eventMask & bit) || (s.eventDisabled & bit)) return;
        s.eventPending |= bit; s.eventDisabled |= bit;
        s.eventErrors[Math.log2(bit)] = error;
        s.notify?.(bit, error);
    }
    private rearm(s: SocketState, bit: number): void { s.eventDisabled &= ~bit; }
    private refreshEvents(s: SocketState): void {
        if (s.pending.length) this.event(s, FD_ACCEPT);
        if (!s.oobInline && s.oob !== null) this.event(s, FD_OOB);
        if (s.packets.length || s.available) this.event(s, FD_READ);
        else if (this.udpReceiveQueues.get(s.id)?.records.length) this.event(s, FD_READ, 0, false);
        if (this.writable(s.id)) this.event(s, FD_WRITE);
        if (s.eof && !s.available) this.event(s, FD_CLOSE);
    }
    private frame(s: SocketState, kind: number, value = 0, data?: Uint8Array): boolean {
        if (!s.local || !s.peer) return false;
        return this.sendFrame(s.local.port, s.peer.node, s.peer.port, kind, s.wireId, s.peerId, value, data, this.proto(s));
    }
    private sendFrame(srcPort: number, node: Uint8Array, dstPort: number, kind: number,
        srcId: number, dstId: number, value = 0, data?: Uint8Array, proto = PROTO_TCP): boolean {
        const packet = encodeTcpFrame(kind, srcId, dstId, value, data);
        return this.network.send(srcPort, node, dstPort, packet, proto);
    }
    private deliver(port: number, proto: number, packet: LanDatagram): void {
        const binding = this.bindings.get(`${proto}:${port}`);
        if (!binding) return;
        const raw = proto === PROTO_RAW4 || proto === PROTO_RAW6;
        const v6 = proto === PROTO_TCP6 || proto === PROTO_UDP6 || proto === PROTO_RAW6;
        const multicast = proto === PROTO_UDP ? packet.multicast4 : undefined;
        let from: WsaAddress = { family: proto === PROTO_IPX ? 6 : v6 ? 23 : 2, node: packet.srcNode.slice(), port: raw ? 0 : packet.srcPort,
            ...(proto === PROTO_IPX ? {} : v6 ? { ip6: this.network.nodeToIpv6(packet.srcNode), scopeId: this.network.nodeToIpv6Scope(packet.srcNode), flowInfo: 0 } : { ip: multicast?.interfaceIndex === 1 ? Uint8Array.of(127, 0, 0, 1) : nodeToIpv4(packet.srcNode) }) };
        let localUdp: LocalUdpContext | undefined;
        if (packet.localUdp !== undefined) {
            const context = copyLocalUdpContext(packet.localUdp);
            if ((proto !== PROTO_UDP && proto !== PROTO_UDP6) || multicast || !context ||
                context.source.family !== from.family || context.source.port !== packet.srcPort ||
                context.destination.port !== port || !(packet.srcNode instanceof Uint8Array) || packet.srcNode.length !== 6) return;
            localUdp = context; from = localUdpAddress(context.source, packet.srcNode);
        }
        if (proto !== PROTO_TCP && proto !== PROTO_TCP6) {
            if (proto === PROTO_IPX && packet.data.length < 2) return;
            let data = proto === PROTO_IPX ? packet.data.subarray(2) : packet.data;
            if (raw) {
                if (data.length < 2 || (data[1] & ~3)) return;
                const protocol = data[0], included = !!(data[1] & 1), prefix = data[1] & 2 ? 5 : 2;
                if (data.length < prefix) return;
                const ttl = prefix === 5 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(2, true) : 128;
                if (ttl < -1 || ttl > 255) return;
                const tos = prefix === 5 ? data[4] : 0; data = data.subarray(prefix);
                if (included) {
                    const parsed = parseRawIp(data, from.family);
                    if (!parsed || parsed.protocol !== protocol) return;
                    if (v6) data = data.subarray(parsed.headerLength);
                } else if (!v6) data = ipv4RawPacket(data, protocol, from.ip!, this.network.ipv4, ++this.ipIdentification & 0xffff, ttl < 0 ? 128 : ttl, tos);
            }
            const packetType = proto === PROTO_IPX ? packet.data[0] : 0;
            const ipxFlags = proto === PROTO_IPX ? (packet.data[1] & 1) | (same(from.node, this.network.node) ? 2 : 0) : 0;
            if (proto === PROTO_IPX) { from.packetType = packetType; from.flags = ipxFlags; }
            const destination = localUdp ? localUdpAddress(localUdp.destination, this.network.node) : undefined;
            // Measured native-family preference is independent of bind order.
            // Queue fullness or a connected-peer filter cannot reroute the packet
            // into a shadow dual owner after the native endpoint selected it.
            const native4 = proto === PROTO_UDP && !multicast && [...binding.sockets].some(id => {
                const owner = this.get(id); return owner.af === 2 && this.acceptsDestination(owner, destination);
            });
            for (const id of binding.sockets) {
                const s = this.get(id);
                if (native4 && s.af !== 2) continue;
                if (multicast) {
                    if (s.af !== 2 || s.type !== 2 || !this.multicastMemberships.get(id)?.has(multicast.interfaceIndex + ":" + [...multicast.group].join(".")) ||
                        (multicast.localOrigin && !s.multicastLoop)) continue;
                }
                if (s.af === 6 && ((!s.receiveBroadcast && (ipxFlags & 1)) || (s.filterPacketType !== null && s.filterPacketType !== packetType))) continue;
                const presented = this.presentAddress(s, from);
                if (!presented || s.readShutdown) continue;
                if (!this.acceptsDestination(s, destination)) continue;
                if (s.peer && (!same(s.peer.node, presented.node) || s.peer.port !== presented.port ||
                    (s.peer.ip && presented.ip && !same(s.peer.ip, presented.ip)) ||
                    (s.peer.ip6 && presented.ip6 && !same(s.peer.ip6, presented.ip6)))) continue;
                const ipUdp = s.type === 2 && (s.af === 2 || s.af === 23);
                const dataCount = ipUdp ? this.udpReceiveQueues.get(s.id)?.dataCount ?? 0 : s.packets.length;
                if (dataCount >= PACKET_LIMIT || (!ipUdp && s.available + data.length > s.receiveLimit)) continue;
                let ipxHeader: Uint8Array | undefined;
                if (proto === PROTO_IPX) {
                    ipxHeader = new Uint8Array(30); const header = new DataView(ipxHeader.buffer);
                    header.setUint16(0, 0xffff); header.setUint16(2, data.length + 30); ipxHeader[5] = packetType;
                    ipxHeader.set(IPX_NETNUM, 6); ipxHeader.set(ipxFlags & 1 ? new Uint8Array(6).fill(255) : this.network.node, 10);
                    header.setUint16(16, port); ipxHeader.set(IPX_NETNUM, 18); ipxHeader.set(from.node, 22); header.setUint16(28, from.port);
                }
                const received = { from: presented, data: data.slice(), ipxHeader };
                if (ipUdp) { if (!this.enqueueUdp(s, received)) continue; }
                else { s.packets.push(received); s.available += data.length; }
                this.event(s, FD_READ);
            }
            this.changed(); return;
        }
        if (packet.data.length < TCP_HEADER) return;
        const v = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
        if (v.getUint32(0, true) !== TCP_MAGIC) return;
        const kind = v.getUint32(4, true), srcId = v.getUint32(8, true), dstId = v.getUint32(12, true), value = v.getUint32(16, true);
        if (!srcId && kind !== RST) return;
        // The wire carries node/port identities. Recover exact loopback IPs only
        // from a live same-root physical sender with this verified wire tuple.
        const origin = this.network.isSelf(packet.srcNode) ? this.wireSockets.get(srcId) : undefined;
        const localOrigin = origin?.local && origin.peer && this.proto(origin) === proto &&
            origin.local.port === packet.srcPort && origin.peer.port === port && this.network.isSelf(origin.peer.node) ? origin : undefined;
        if (localOrigin?.local) from = this.wireAddress(localOrigin, localOrigin.local);
        if (kind === RST && !dstId && srcId) {
            // A connecting sender has not received our child wire ID yet.
            const child = [...binding.sockets].map(id => this.get(id)).find(s =>
                this.proto(s) === proto && s.peerId === srcId && s.peer?.port === from.port && same(s.peer.node, from.node));
            if (!child) return;
            child.error = value || WSA.ECONNRESET; child.state = "failed"; this.event(child, FD_CLOSE, child.error);
            for (const id of binding.sockets) {
                const listener = this.get(id), index = listener.pending.indexOf(child.id);
                if (index >= 0) { listener.pending.splice(index, 1); this.closesocket(child.id); break; }
            }
            this.changed(); return;
        }
        if (kind === SYN && !dstId) {
            const destination = localOrigin?.peer ? this.wireAddress(localOrigin, localOrigin.peer) : undefined;
            const listeners = [...binding.sockets].map(id => this.get(id)).filter(s =>
                s.state === "listening" && !!this.presentAddress(s, from) && this.acceptsDestination(s, destination));
            const listener = (proto === PROTO_TCP ? listeners.find(s => s.af === 2) : undefined) ?? listeners[0];
            if (!listener || listener.pending.length >= listener.backlog) {
                this.sendFrame(port, from.node, from.port, RST, 0, srcId, WSA.ECONNREFUSED, undefined, proto);
                return;
            }
            const existing = [...binding.sockets].map(id => this.get(id)).find(s =>
                this.proto(s) === proto && s.peerId === srcId && s.peer?.port === from.port && same(s.peer.node, from.node));
            if (existing) { this.frame(existing, SYNACK, this.synValue(existing)); return; }
            const id = this.socket(1, listener.af, 6), child = this.get(id);
            child.v6Only = listener.v6Only;
            this.connectionWire.set(child, proto);
            const acceptedLocal = destination ??
                { family: from.family, port, node: this.network.node.slice(),
                    ...(from.family === 2 ? { ip: this.network.ipv4.slice() } : { ip6: this.network.ipv6.slice(), scopeId: 0, flowInfo: 0 }) };
            child.local = this.presentAddress(child, acceptedLocal)!; child.peer = this.presentAddress(child, from)!; child.peerId = srcId;
            child.state = "connected"; child.connectedAt = Date.now(); child.credit = Math.min(value & SYN_WINDOW_MASK, BUFFER_LIMIT); child.nonBlocking = listener.nonBlocking; child.overlapped = listener.overlapped;
            child.receiveLimit = listener.receiveLimit; child.sendLimit = listener.sendLimit;
            child.receiveTimeout = listener.receiveTimeout; child.sendTimeout = listener.sendTimeout; child.oobInline = listener.oobInline;
            child.lingerEnabled = listener.lingerEnabled; child.lingerSeconds = listener.lingerSeconds;
            child.keepAlive = listener.keepAlive; child.noDelay = listener.noDelay;
            binding.sockets.add(id); this.bindingRefs.set(child, new Set([binding])); listener.pending.push(id);
            if (!this.frame(child, SYNACK, this.synValue(child))) {
                listener.pending.pop(); this.detach(child); this.sockets.delete(id); this.wireSockets.delete(child.wireId); return;
            }
            this.event(listener, FD_ACCEPT); this.changed(); return;
        }
        const s = this.wireSockets.get(dstId);
        if (!s || this.proto(s) !== proto || !binding.sockets.has(s.id) || !s.peer || s.peer.port !== from.port || !same(s.peer.node, from.node)) return;
        if (kind === RST) {
            if (s.state === "connecting") this.restoreConnectAddress(s);
            s.error = value || WSA.ECONNRESET; s.state = "failed";
            if (s.connectTimer) clearTimeout(s.connectTimer);
            this.event(s, s.peerId ? FD_CLOSE : FD_CONNECT, s.error);
        } else if (kind === SYNACK && s.state === "connecting" && srcId) {
            this.connectOrigins.delete(s);
            s.peerId = srcId; s.credit = Math.min(value & SYN_WINDOW_MASK, BUFFER_LIMIT); s.state = "connected"; s.connectedAt = Date.now();
            if (s.connectTimer) clearTimeout(s.connectTimer);
            this.event(s, FD_CONNECT); this.event(s, FD_WRITE);
        } else if (srcId !== s.peerId || s.state !== "connected") return;
        else if (kind === TCP_OPTION) { if (![0, 1, TCP_OPTION_KEEPALIVE, TCP_OPTION_KEEPALIVE | 1, TCP_OPTION_NODELAY, TCP_OPTION_NODELAY | 1].includes(value) || packet.data.length !== TCP_HEADER) return; /* A virtual peer retains its own application options. */ }
        else if (kind === OOB) {
            if (packet.data.length !== TCP_HEADER + 1) return;
            if (s.readShutdown) { this.frame(s, CREDIT, 1); this.changed(); return; }
            const count = s.available + (s.oobInline || s.oob === null ? 0 : s.oobPending.length + 1);
            if (s.eof || count >= s.receiveLimit) {
                this.frame(s, RST, WSA.ECONNRESET); s.error = WSA.ECONNRESET; s.state = "failed";
                this.event(s, FD_CLOSE, s.error); this.changed(); return;
            }
            if (s.oobInline) { s.chunks.push(Uint8Array.of(packet.data[TCP_HEADER])); s.available++; this.event(s, FD_READ); this.changed(); return; }
            const urgent = { value: packet.data[TCP_HEADER], mark: s.readPosition + s.available };
            if (s.oob !== null) s.oobPending.push(urgent); else { s.oob = urgent.value; s.urgentMark = urgent.mark; }
            this.rearm(s, FD_OOB); this.event(s, FD_OOB);
        } else if (kind === DATA) {
            const data = packet.data.slice(TCP_HEADER);
            if (!data.length) return;
            if (s.eof || s.available + data.length > s.receiveLimit) {
                this.frame(s, RST, WSA.ECONNRESET); s.error = WSA.ECONNRESET; s.state = "failed";
                this.event(s, FD_CLOSE, s.error);
            } else if (s.readShutdown) {
                if (!this.frame(s, CREDIT, data.length)) {
                    s.error = WSA.ENETDOWN; s.state = "failed"; this.event(s, FD_CLOSE, s.error);
                }
            }
            else { s.chunks.push(data); s.available += data.length; this.event(s, FD_READ); }
        } else if (kind === FIN) {
            s.eof = true;
            if (!s.available) this.event(s, FD_CLOSE);
        } else if (kind === CREDIT) {
            const old = s.credit; s.credit = Math.min(BUFFER_LIMIT, s.credit + value);
            if (!old && s.credit) { this.rearm(s, FD_WRITE); this.event(s, FD_WRITE); }
        } else return;
        this.changed();
    }
}

export function ipv4Address(ip: Uint8Array, port: number): WsaAddress {
    return { family: 2, ip: ip.slice(), node: ipv4ToNode(ip), port };
}

export function ipv6Address(ip6: Uint8Array, port: number, scopeId = 0, flowInfo = 0): WsaAddress {
    return { family: 23, ip6: ip6.slice(), node: new Uint8Array(6), port, scopeId, flowInfo };
}
