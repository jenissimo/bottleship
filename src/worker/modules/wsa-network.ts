/**
 * Winsock socket state over the BottleShip virtual LAN.
 * ABI semantics follow Winsock 1.1/2; TCP here is a private reliable LAN protocol,
 * not an IP/TCP wire implementation. No guest memory is retained by this layer.
 */
import { lanNetwork, type LanNetwork, type LanEndpoint, ipv4ToNode, nodeToIpv4,
    IPX_NETNUM, IPX_MAX_PAYLOAD, UDP_MAX_PAYLOAD, UDP6_MAX_PAYLOAD } from "../net/lan-network";
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
const BUFFER_LIMIT = 256 * 1024;
const PACKET_LIMIT = 1024;

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
export interface WsaPacket { data: Uint8Array; from: WsaAddress; truncated?: boolean; ipxHeader?: Uint8Array; }
interface SocketState {
    id: number; wireId: number; af: number; type: number; protocol: number;
    acceptListener?: number; acceptListenerObjectId?: number; originalLocal?: WsaAddress | null; connectContextPending: boolean; connectExCompleted?: boolean; disconnected: boolean; connectedAt: number;
    nonBlocking: boolean; overlapped: boolean; local: WsaAddress | null; peer: WsaAddress | null;
    state: "new" | "connecting" | "connected" | "listening" | "failed";
    backlog: number; pending: number[];
    packets: WsaPacket[]; chunks: Uint8Array[]; offset: number; available: number;
    readShutdown: boolean; writeShutdown: boolean; eof: boolean; error: number; pendingError: number;
    oob: number | null; oobPending: Array<{ value: number; mark: number }>; oobInline: boolean; readPosition: number; urgentMark: number | null;
    extendedAddress: boolean; receiveHeader: boolean;
    headerInclude: boolean; ipTtl: number; ipTos: number; ipOptionsChanged: boolean;
    keepAlive: boolean; noDelay: boolean;
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
    private wireSockets = new Map<number, SocketState>();
    private bindings = new Map<string, Binding>();
    private listeners = new Set<() => void>();
    private epoch = 0;
    private ipIdentification = 0;
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
                if (s.peer && ((s.type !== 3 && s.peer.port !== error.remotePort) || !same(s.peer.node, error.node))) continue;
                if (error.proto === PROTO_TCP || error.proto === PROTO_TCP6) {
                    if (error.wireId !== undefined && s.wireId !== error.wireId) continue;
                    if (!s.peer || s.eof || (s.state !== "connected" && s.state !== "connecting")) continue;
                    const connecting = s.state === "connecting";
                    s.error = connecting && error.code === WSA.ECONNRESET ? WSA.ECONNREFUSED : error.code;
                    s.state = "failed"; if (s.connectTimer) clearTimeout(s.connectTimer);
                    this.event(s, connecting ? FD_CONNECT : FD_CLOSE, s.error);
                } else { s.error = error.code; this.event(s, FD_READ, error.code); }
            }
            this.changed();
        });
        this.peerUnsubscribe = this.network.onPeerDisconnect(node => {
            for (const s of this.sockets.values()) {
                if (s.type !== 1 || s.eof || !s.peer || !same(s.peer.node, node) ||
                    (s.state !== "connected" && s.state !== "connecting")) continue;
                const connecting = s.state === "connecting";
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
                    if (s.type !== 1 && s.peer && !same(s.peer.node, this.network.node)) {
                        s.error = state.connected ? 0 : WSA.ENETDOWN;
                        if (s.error) this.event(s, FD_READ, s.error);
                    }
                    if (s.type === 1 && !s.eof && s.peer && !same(s.peer.node, this.network.node) && (s.state === "connecting" || s.state === "connected")) {
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
        this.sockets.clear(); this.wireSockets.clear();
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
            id, wireId, af, type, protocol: selectedProtocol, connectContextPending: false, disconnected: false, connectedAt: 0, nonBlocking: false, overlapped: true, local: null, peer: null,
            state: "new", backlog: 1, pending: [], packets: [], chunks: [], offset: 0, available: 0,
            readShutdown: false, writeShutdown: false, eof: false, error: 0, pendingError: 0,
            oob: null, oobPending: [], oobInline: false, readPosition: 0, urgentMark: null, extendedAddress: false, receiveHeader: false, headerInclude: false, ipTtl: 128, ipTos: 0, ipOptionsChanged: false, keepAlive: false, noDelay: false, peerId: 0, credit: 0, writeBlocked: false,
            broadcast: false, reuse: false, packetType: af === 6 ? selectedProtocol - 1000 : 0,
            filterPacketType: null, receiveBroadcast: true, receiveLimit: BUFFER_LIMIT, sendLimit: BUFFER_LIMIT,
            receiveTimeout: 0, sendTimeout: 0, lingerEnabled: false, lingerSeconds: 0,
            eventMask: 0, eventPending: 0, eventErrors: new Array(10).fill(0), eventDisabled: 0,
        });
        this.wireSockets.set(wireId, this.get(id));
        return id;
    }
    private proto(s: SocketState): number { return s.type === 3 ? (s.af === 23 ? PROTO_RAW6 : PROTO_RAW4) : s.af === 6 ? PROTO_IPX : s.af === 23 ? (s.type === 1 ? PROTO_TCP6 : PROTO_UDP6) : s.type === 1 ? PROTO_TCP : PROTO_UDP; }
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
        if (address?.ip6 && !zeros(address.ip6) && !same(address.ip6, this.network.ipv6) &&
            !(address.ip6.slice(0, 15).every(v => !v) && address.ip6[15] === 1)) fail(WSA.EADDRNOTAVAIL);
        if (address && !address.ip6 && !zeros(address.node) && !(address.ip && zeros(address.ip)) && !same(address.node, this.network.node) &&
            !(address.ip?.[0] === 127)) fail(WSA.EADDRNOTAVAIL);
        const proto = this.proto(s);
        let port = s.type === 3 ? s.protocol + 1 : address?.port ?? 0;
        if (port) {
            const old = this.bindings.get(`${proto}:${port}`);
            if (old) {
                if (s.type !== 3 && (s.type === 1 || !s.reuse || [...old.sockets].some(id => !this.get(id).reuse))) fail(WSA.EADDRINUSE);
                old.sockets.add(sid);
            } else {
                const endpoint: LanEndpoint = { deliver: packet => this.deliver(port, proto, packet) };
                if (!this.network.bind(port, endpoint, proto, s.reuse || s.type === 3)) fail(WSA.EADDRINUSE);
                this.bindings.set(`${proto}:${port}`, { port, proto, endpoint, sockets: new Set([sid]) });
            }
        } else {
            const endpoint: LanEndpoint = { deliver: packet => this.deliver(port, proto, packet) };
            port = this.network.bindEphemeral(endpoint, proto);
            if (!port) fail(WSA.ENOBUFS);
            this.bindings.set(`${proto}:${port}`, { port, proto, endpoint, sockets: new Set([sid]) });
        }
        s.local = this.localAddress(s, s.type === 3 ? 0 : port);
        if (s.af === 2) s.local.ip = address?.ip?.slice() ?? new Uint8Array(4);
        if (s.af === 23) s.local.ip6 = address?.ip6?.slice() ?? new Uint8Array(16);
        return 0;
    }
    private autoBind(s: SocketState): void { if (!s.local) this.bind(s.id); }
    private detach(s: SocketState): void {
        if (!s.local) return;
        const key = `${this.proto(s)}:${this.boundPort(s)}`;
        const b = this.bindings.get(key);
        b?.sockets.delete(s.id);
        if (b && !b.sockets.size) {
            this.network.unbind(b.port, b.endpoint, b.proto);
            this.bindings.delete(key);
        }
    }
    closesocket(sid: number): number {
        const s = this.get(sid);
        if (s.connectTimer) clearTimeout(s.connectTimer);
        if (s.type === 1 && s.peer && (s.state === "connected" || s.state === "connecting")) {
            this.frame(s, (s.lingerEnabled && !s.lingerSeconds) || s.available || s.state === "connecting" ? RST : FIN);
        }
        for (const child of [...s.pending]) if (this.isValid(child)) this.closesocket(child);
        this.detach(s);
        this.sockets.delete(sid >>> 0); this.wireSockets.delete(s.wireId);
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
        const binding = this.bindings.get(this.proto(socket) + ":" + socket.local!.port)!;
        binding.sockets.delete(accepted); binding.sockets.add(target);
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
        replacement.keepAlive = socket.keepAlive; replacement.noDelay = socket.noDelay;
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
        if (peer.family !== s.af) fail(WSA.EAFNOSUPPORT);
        if (s.type !== 3 && !peer.port) fail(WSA.EADDRNOTAVAIL);
        if (s.type !== 1) {
            this.autoBind(s);
            s.peer = this.routeAddress({ ...peer, port: s.type === 3 ? 0 : peer.port });
            s.error = 0;
            if (s.local!.ip && zeros(s.local!.ip)) s.local!.ip = this.network.ipv4;
            if (s.local!.ip6 && zeros(s.local!.ip6)) s.local!.ip6 = this.network.ipv6;
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
        if (s.local!.ip && zeros(s.local!.ip)) s.local!.ip = this.network.ipv4;
            if (s.local!.ip6 && zeros(s.local!.ip6)) s.local!.ip6 = this.network.ipv6;
        s.state = "connecting";
        s.error = 0;
        if (!this.frame(s, SYN, this.synValue(s))) {
            s.state = "new";
            fail(WSA.ENETDOWN);
        }
        if (this.isConnected(sid)) return 0; // Synchronous local handshake.
        if (s.error) fail(s.error);
        s.connectTimer = setTimeout(() => {
            if (s.state !== "connecting") return;
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
            const node = peer.ip6 ? this.network.routeIpv6(peer.ip6, peer.scopeId ?? 0) : peer.ip?.[0] === 127 ? this.network.node.slice() :
                peer.ip ? this.network.routeIpv4(peer.ip) : peer.node.slice();
            if (peer.ip6 && peer.scopeId && node[0] === 2 && node[1] === 0) fail(WSA.EADDRNOTAVAIL);
            return { ...peer, node, ip: peer.ip?.slice(), ip6: peer.ip6?.slice() };
        } catch (error) { if (error instanceof WsaFailure) throw error; fail((error as { code?: string })?.code === "ACCESS_DENIED" ? WSA.EACCES : WSA.EADDRNOTAVAIL); }
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
            if (dst.family !== s.af) fail(WSA.EAFNOSUPPORT);
            if (bytes.length > this.maxMessageSize(sid)) fail(WSA.EMSGSIZE);
            if (broadcast(dst.node) && !s.broadcast) fail(WSA.EACCES);
            if (s.type !== 3 && !dst.port) fail(WSA.EADDRNOTAVAIL);
            this.autoBind(s);
            let payload: Uint8Array = bytes, destination = this.routeAddress(dst), destinationPort = dst.port;
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
            if (!this.network.send(this.boundPort(s), destination.node, destinationPort, payload, this.proto(s))) {
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
    receive(sid: number, length: number, flags = 0): WsaPacket {
        const s = this.get(sid);
        this.rearm(s, FD_READ);
        if (flags & ~11) fail(WSA.EOPNOTSUPP);
        if ((flags & 9) === 9) fail(WSA.EINVAL);
        if (s.readShutdown) fail(WSA.ESHUTDOWN);
        if (s.type !== 1) {
            if (flags & 9) fail(WSA.EOPNOTSUPP);
            if (!s.local) { if (s.type === 3) this.autoBind(s); else fail(WSA.EINVAL); }
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
        if (s.state !== "connected") fail(WSA.ENOTCONN);
        if (how !== 1) { s.readShutdown = true; s.packets = []; s.chunks = []; s.available = 0; }
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
    setNonBlocking(sid: number, on: boolean): void {
        const s = this.get(sid);
        if (!on && s.eventMask) fail(WSA.EINVAL);
        s.nonBlocking = on;
    }
    readable(sid: number): boolean {
        const s = this.get(sid);
        return !!(s.pending.length || s.packets.length || s.available || s.eof || s.error || s.readShutdown);
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
    private event(s: SocketState, bit: number, error = 0): void {
        if (error) s.pendingError = error;
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
    private deliver(port: number, proto: number, packet: { srcNode: Uint8Array; srcPort: number; data: Uint8Array }): void {
        const binding = this.bindings.get(`${proto}:${port}`);
        if (!binding) return;
        const raw = proto === PROTO_RAW4 || proto === PROTO_RAW6;
        const v6 = proto === PROTO_TCP6 || proto === PROTO_UDP6 || proto === PROTO_RAW6;
        const from: WsaAddress = { family: proto === PROTO_IPX ? 6 : v6 ? 23 : 2, node: packet.srcNode.slice(), port: raw ? 0 : packet.srcPort,
            ...(proto === PROTO_IPX ? {} : v6 ? { ip6: this.network.nodeToIpv6(packet.srcNode), scopeId: this.network.nodeToIpv6Scope(packet.srcNode), flowInfo: 0 } : { ip: nodeToIpv4(packet.srcNode) }) };
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
            for (const id of binding.sockets) {
                const s = this.get(id);
                if (s.af === 6 && ((!s.receiveBroadcast && (ipxFlags & 1)) || (s.filterPacketType !== null && s.filterPacketType !== packetType))) continue;
                if (s.readShutdown || (s.peer && (!same(s.peer.node, from.node) || s.peer.port !== from.port))) continue;
                if (s.packets.length >= PACKET_LIMIT || s.available + data.length > s.receiveLimit) continue;
                let ipxHeader: Uint8Array | undefined;
                if (proto === PROTO_IPX) {
                    ipxHeader = new Uint8Array(30); const header = new DataView(ipxHeader.buffer);
                    header.setUint16(0, 0xffff); header.setUint16(2, data.length + 30); ipxHeader[5] = packetType;
                    ipxHeader.set(IPX_NETNUM, 6); ipxHeader.set(ipxFlags & 1 ? new Uint8Array(6).fill(255) : this.network.node, 10);
                    header.setUint16(16, port); ipxHeader.set(IPX_NETNUM, 18); ipxHeader.set(from.node, 22); header.setUint16(28, from.port);
                }
                s.packets.push({ from, data: data.slice(), ipxHeader }); s.available += data.length;
                this.event(s, FD_READ);
            }
            this.changed(); return;
        }
        if (packet.data.length < TCP_HEADER) return;
        const v = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
        if (v.getUint32(0, true) !== TCP_MAGIC) return;
        const kind = v.getUint32(4, true), srcId = v.getUint32(8, true), dstId = v.getUint32(12, true), value = v.getUint32(16, true);
        if (!srcId && kind !== RST) return;
        if (kind === RST && !dstId && srcId) {
            // A connecting sender has not received our child wire ID yet.
            const child = [...binding.sockets].map(id => this.get(id)).find(s =>
                s.peerId === srcId && s.peer?.port === from.port && same(s.peer.node, from.node));
            if (!child) return;
            child.error = value || WSA.ECONNRESET; child.state = "failed"; this.event(child, FD_CLOSE, child.error);
            for (const id of binding.sockets) {
                const listener = this.get(id), index = listener.pending.indexOf(child.id);
                if (index >= 0) { listener.pending.splice(index, 1); this.closesocket(child.id); break; }
            }
            this.changed(); return;
        }
        if (kind === SYN && !dstId) {
            const listener = [...binding.sockets].map(id => this.get(id)).find(s => s.state === "listening");
            if (!listener || listener.pending.length >= listener.backlog) {
                this.sendFrame(port, from.node, from.port, RST, 0, srcId, WSA.ECONNREFUSED, undefined, proto);
                return;
            }
            const existing = [...binding.sockets].map(id => this.get(id)).find(s =>
                s.peerId === srcId && s.peer?.port === from.port && same(s.peer.node, from.node));
            if (existing) { this.frame(existing, SYNACK, this.synValue(existing)); return; }
            const id = this.socket(1, listener.af, 6), child = this.get(id);
            child.local = this.localAddress(child, port); child.peer = from; child.peerId = srcId;
            child.state = "connected"; child.connectedAt = Date.now(); child.credit = Math.min(value & SYN_WINDOW_MASK, BUFFER_LIMIT); child.nonBlocking = listener.nonBlocking; child.overlapped = listener.overlapped;
            child.receiveLimit = listener.receiveLimit; child.sendLimit = listener.sendLimit;
            child.receiveTimeout = listener.receiveTimeout; child.sendTimeout = listener.sendTimeout; child.oobInline = listener.oobInline;
            child.lingerEnabled = listener.lingerEnabled; child.lingerSeconds = listener.lingerSeconds;
            child.keepAlive = listener.keepAlive; child.noDelay = listener.noDelay;
            binding.sockets.add(id); listener.pending.push(id);
            if (!this.frame(child, SYNACK, this.synValue(child))) {
                listener.pending.pop(); this.detach(child); this.sockets.delete(id); this.wireSockets.delete(child.wireId); return;
            }
            this.event(listener, FD_ACCEPT); this.changed(); return;
        }
        const s = this.wireSockets.get(dstId);
        if (!s || !binding.sockets.has(s.id) || !s.peer || s.peer.port !== from.port || !same(s.peer.node, from.node)) return;
        if (kind === RST) {
            s.error = value || WSA.ECONNRESET; s.state = "failed";
            if (s.connectTimer) clearTimeout(s.connectTimer);
            this.event(s, s.peerId ? FD_CLOSE : FD_CONNECT, s.error);
        } else if (kind === SYNACK && s.state === "connecting" && srcId) {
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
