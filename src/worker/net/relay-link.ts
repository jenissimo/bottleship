import { io, type Socket } from "socket.io-client";
import type { ClientEvents, ServerEvents, LanReady } from "./netplay-wire";
import { PROTOCOL_VERSION, WIRE_DGRAM_MULTICAST4, PROTO_DIRECTPLAY, isTcpProtocol, asBytes, decodeDatagram, isLanNode, nodeToIpv4 } from "./netplay-wire";
import { LanNetwork, type NetTransport } from "./lan-network";
import { UdpHostLeaseRpc, type UdpHostLease } from "./udp-host-lease-rpc";
import { TcpHostLeaseRpc, type TcpHostLease } from "./tcp-host-lease-rpc";
import { copyTcpHostCapability, validTcpHostOpenRequest, type TcpHostOpenRequest } from "./netplay-wire";
import { copyUdpHostCapability, validUdpHostOpenRequest, type UdpHostOpenRequest } from "./netplay-wire";
import { UdpPeerLeaseRpc } from "./udp-peer-lease-rpc";
import type { UdpPeerLeaseRequest } from "./netplay-wire";
import { NetResolveError, type ResolveRequest, type ResolveResult, type ResolveReply, parseIpv6, parseIpv4, isExternalIpv6Node, validBindingGeneration } from "./netplay-wire";

export interface RelayLinkOptions {
    transports?: ("websocket" | "polling")[];
    timeoutMs?: number;
}
const clientIds = new WeakMap<LanNetwork, string>();
export class RelayLink implements NetTransport {
    readonly ready: Promise<void>;
    readonly socket: Socket<ServerEvents, ClientEvents>;
    private online = false;
    private closed = false;
    private settled = false;
    private readonly reliableQueue:({kind:"frame";frame:Uint8Array<ArrayBuffer>;generation?:number}|{kind:"release";port:number;proto:number;generation:number}|{kind:"leaseRequest";id:number;request:UdpPeerLeaseRequest}|{kind:"leaseCancel";id:number}|{kind:"leaseRelease";id:number}|{kind:"hostRequest";id:number;request:UdpHostOpenRequest}|{kind:"hostCancel";id:number}|{kind:"hostRelease";id:number}|{kind:"tcpHostRequest";id:number;request:TcpHostOpenRequest}|{kind:"tcpHostCancel";id:number}|{kind:"tcpHostRelease";id:number})[] = [];
    private queuedBytes = 0;
    private flushing = false;
    private readonly udpPeers = new UdpPeerLeaseRpc({
        connected: () => this.online && !this.closed && this.socket.connected,
        request: (id, request) => this.reliableQueue.length < 128 && this.enqueue({kind:"leaseRequest",id,request},128),
        cancel: id => { this.enqueue({kind:"leaseCancel",id},16); },
        release: id => { this.enqueue({kind:"leaseRelease",id},16); },
    });
    private readonly udpHosts = new UdpHostLeaseRpc({
        connected: () => this.online && !this.closed && this.socket.connected,
        request: (id, request) => this.reliableQueue.length < 128 && this.enqueue({kind:"hostRequest",id,request},128),
        cancel: id => { this.enqueue({kind:"hostCancel",id},16); },
        release: id => { this.enqueue({kind:"hostRelease",id},16); },
    });
    // Capability is published only by a server that explicitly enables this path.
    private readonly tcpHosts = new TcpHostLeaseRpc({
        connected: () => this.online && !this.closed && this.socket.connected,
        request: (id, request) => this.reliableQueue.length < 128 && this.enqueue({kind:"tcpHostRequest",id,request},128),
        cancel: id => { this.enqueue({kind:"tcpHostCancel",id},16); },
        release: id => { this.enqueue({kind:"tcpHostRelease",id},16); },
    });
    openUdpHost(request: UdpHostOpenRequest, signal?: AbortSignal): Promise<UdpHostLease> {
        if (!validUdpHostOpenRequest(request) || !this.net.udpHostListenV1?.listeners.some(info => info.id === request.listenerId))
            return Promise.reject(Object.assign(new Error("UDP Host listener unavailable"), {code:10045}));
        return this.udpHosts.open(request, signal);
    }
    openTcpHost(request: TcpHostOpenRequest, signal?: AbortSignal): Promise<TcpHostLease> {
        if (!validTcpHostOpenRequest(request) || !this.net.tcpHostListenV1?.listeners.some(info => info.id === request.listenerId))
            return Promise.reject(Object.assign(new Error("TCP Host listener unavailable"), {code:10045}));
        return this.tcpHosts.open(request, signal);
    }
    leaseUdpPeer(request: UdpPeerLeaseRequest, signal?: AbortSignal): Promise<{release(): void}> {
        return this.udpPeers.open(request, signal);
    }
    private nextResolve = 1;
    private readonly pendingResolves = new Map<number, { fail: (error: NetResolveError) => void; accept: (reply: ResolveReply) => void }>();
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    private readonly deadline: ReturnType<typeof setTimeout>;
    get connected(): boolean { return this.online; }
    get connecting(): boolean { return !this.settled && !this.closed; }

    constructor(url: string, room: string, private readonly net: LanNetwork, options: RelayLinkOptions = {}) {
        this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        const timeout = options.timeoutMs ?? 10_000;
        const clientId = clientIds.get(net) ?? crypto.randomUUID();
        clientIds.set(net, clientId);
        this.socket = io(url, {
            autoConnect: false,
            forceNew: true,
            transports: options.transports ?? ["polling", "websocket"],
            tryAllTransports: true,
            upgrade: true,
            timeout,
            reconnection: true,
            reconnectionDelay: 500,
            reconnectionDelayMax: 10_000,
            auth: { version: PROTOCOL_VERSION, room, clientId, node: Array.from(net.node) },
        });
        this.deadline = setTimeout(() => this.failInitial(new Error("LAN server readiness timed out")), timeout);
        this.socket.on("connect", () => {
            this.socket.io.engine.on("drain", () => {
                this.flush();
                if (this.online && !this.closed) this.net.notifyWritable();
            });
        });
        this.socket.on("ready", info => this.acceptReady(info));
        this.socket.on("resolved", (id, reply) => this.pendingResolves.get(id)?.accept(reply));
        this.socket.on("udpPeerLeased", (id, reply) => { if (this.online && !this.closed) this.udpPeers.accept(id, reply); });
        this.socket.on("udpHostOpened", (id, reply) => { if (this.online && !this.closed) this.udpHosts.accept(id, reply); });
        this.socket.on("udpHostClosed", (id, lease, error) => { if (this.online && !this.closed) this.udpHosts.acceptClosed(id, lease, error); });
        this.socket.on("tcpHostOpened", (id, reply) => { if (this.online && !this.closed) this.tcpHosts.accept(id, reply); });
        this.socket.on("tcpHostClosed", (id, lease, error) => { if (this.online && !this.closed) this.tcpHosts.acceptClosed(id, lease, error); });
        this.socket.on("frame", (input,generation) => {
            if (!this.online || this.closed) return;
            const bytes = asBytes(input);
            if (!bytes || (generation !== undefined && !validBindingGeneration(generation))) return;
            if (bytes[0] === WIRE_DGRAM_MULTICAST4) {
                const datagram = decodeDatagram(bytes);
                // Backplane overrides receiveFrame to enter the trusted local
                // broker. Validate remote multicast before that trust boundary.
                if (!this.net.udpMulticast4V1 || !datagram?.multicast4 || !isLanNode(datagram.node)
                    || this.net.isSelf(datagram.node) || datagram.multicast4.interfaceIndex !== 2 || datagram.multicast4.ttl === 0) return;
            }
            this.net.receiveFrame(bytes, false, generation);
        });
        this.socket.on("peerLeft", peer => {
            if (!this.online || this.closed || !peer || !Array.isArray(peer.node)
                || peer.node.length !== 6 || !peer.node.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return;
            const node = Uint8Array.from(peer.node);
            if (isLanNode(node)) this.net.notifyPeerDisconnected(node);
        });
        this.socket.on("socketError", error => {
            if (!this.online || this.closed || !error || !Array.isArray(error.node)
                || error.node.length !== 6 || !error.node.every(value => Number.isInteger(value) && value >= 0 && value < 256)) return;
            this.net.notifySocketError({ ...error, node: Uint8Array.from(error.node) });
        });
        this.socket.on("disconnect", reason => {
            if (this.closed) return;
            this.online = false;
            this.clearQueue();
            this.cancelResolves();
            this.udpPeers.disconnect(); this.udpHosts.disconnect(); this.tcpHosts.disconnect();
            this.socket.sendBuffer.length = 0;
            this.net.setConnected(false, reason);

        });
        this.socket.on("connect_error", error => {
            if (this.closed) return;
            this.net.setConnected(false, error.message);
            if (!this.settled) this.failInitial(error);
        });
        this.socket.connect();
    }
    private abortTransport():void {
        const engine=this.socket.io.engine;
        // Fatal queue admission cannot wait for an undrained namespace packet.
        try { this.socket.disconnect(); } finally { engine?.transport?.close(); }
    }
    private enqueue(item:(typeof this.reliableQueue)[number],bytes:number):boolean{
        const cleanup = item.kind === "leaseCancel" || item.kind === "leaseRelease" || item.kind === "hostCancel" || item.kind === "hostRelease" || item.kind === "tcpHostCancel" || item.kind === "tcpHostRelease";
        // Every admitted permission retains room for its cancellation/release,
        // including when TCP traffic shares this connection's ordered queue.
        const reserved = cleanup ? 0 : this.udpPeers.controlReservations + this.udpHosts.controlReservations + this.tcpHosts.controlReservations;
        if(this.reliableQueue.length>=256||this.queuedBytes+bytes>1024*1024){this.abortTransport();return false;}
        if(this.reliableQueue.length+1+reserved>256||this.queuedBytes+bytes+reserved*16>1024*1024)return false;
        this.reliableQueue.push(item);this.queuedBytes+=bytes;this.flush();return true;
    }
    releasePort(port:number,proto:number,generation:number):void{
        this.udpPeers.retire(port, proto, generation); this.udpHosts.retire(port, proto, generation); this.tcpHosts.retire(port, proto, generation);
        if(this.closed||!this.online||!this.socket.connected||!generation)return;
        if (!this.enqueue({kind:"release",port,proto,generation},16)) this.abortTransport();
    }
    send(frame: Uint8Array<ArrayBuffer>,generation=0): boolean {
        const engine = this.socket.io.engine;
        const datagram = decodeDatagram(frame);
        if (!datagram || this.closed || !this.online || !this.socket.connected || !engine || (datagram.multicast4 && !this.net.udpMulticast4V1)) return false;
        const reliable = isTcpProtocol(datagram.proto) || datagram.proto === PROTO_DIRECTPLAY;
        if (reliable) {
            return this.enqueue({kind:"frame",frame:frame.slice(),generation:generation||undefined},frame.byteLength);
        }
        if (!engine.transport.writable || engine.writeBuffer.length || this.reliableQueue.length) return false;
        // Offline datagrams never enter Socket.IO's reconnect sendBuffer.
        if (generation) this.socket.volatile.emit("frame", frame, generation);
        else this.socket.volatile.emit("frame", frame);
        return true;
    }
    resolve(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult> {
        if (signal?.aborted) return Promise.reject(new NetResolveError("CANCELLED"));
        if (!this.online || this.closed) return Promise.reject(new NetResolveError("NETWORK_DOWN"));
        if (this.pendingResolves.size >= 16) return Promise.reject(new NetResolveError("TRY_AGAIN"));
        return new Promise((resolve, reject) => {
            const id = this.nextResolve++;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                this.pendingResolves.delete(id);
            };
            const fail = (error: NetResolveError) => { cleanup(); reject(error); };
            const cancel = (error: NetResolveError) => {
                if (this.online) this.socket.emit("cancelResolve", id);
                fail(error);
            };
            const abort = () => cancel(new NetResolveError("CANCELLED"));
            const timer = setTimeout(() => cancel(new NetResolveError(this.online ? "TRY_AGAIN" : "NETWORK_DOWN")), 5000);
            this.pendingResolves.set(id, { fail, accept: reply => {
                cleanup();
                if (reply?.error) { reject(new NetResolveError(reply.error.code, reply.error.message)); return; }
                const result = reply?.result;
                if (!result || typeof result.canonicalName !== "string" || result.canonicalName.length > 253
                    || !Array.isArray(result.addresses) || !result.addresses.length || result.addresses.length > 32
                    || !result.addresses.every(item => item && typeof item.address === "string"
                        && (item.family === 4 ? !!parseIpv4(item.address) : item.family === 6 && !!parseIpv6(item.address)
                            && Array.isArray(item.node) && item.node.length === 6 && item.node.every(n => Number.isInteger(n) && n >= 0 && n < 256)
                            && isExternalIpv6Node(Uint8Array.from(item.node))
                            && (item.scopeId === undefined || (Number.isInteger(item.scopeId) && item.scopeId >= 0 && item.scopeId <= 0xffffffff))))) {
                    reject(new NetResolveError("NO_RECOVERY")); return;
                }
                this.net.registerGatewayAddresses(result.addresses.filter(item => item.family === 4).map(item => item.address.split(".").map(Number)));
                this.net.registerGatewayIpv6(result.addresses.filter(item => item.family === 6 && item.node && parseIpv6(item.address))
                    .map(item => ({ address: Array.from(parseIpv6(item.address)!), node: item.node!, ...(item.scopeId ? { scopeId: item.scopeId } : {}) })));
                resolve(result);
            } });
            signal?.addEventListener("abort", abort, { once: true });
            this.socket.emit("resolve", id, request);
        });
    }
    private cancelResolves(): void {
        for (const entry of this.pendingResolves.values()) entry.fail(new NetResolveError("NETWORK_DOWN"));
        this.pendingResolves.clear();
    }
    private flush(): void {
        if (this.flushing || this.closed || !this.online || !this.socket.connected) return;
        this.flushing = true;
        try {
            const engine = this.socket.io.engine;
            while (this.reliableQueue.length && engine.transport.writable && !engine.writeBuffer.length) {
                const item=this.reliableQueue.shift()!;
                if(item.kind==="frame"){
                    this.queuedBytes-=item.frame.byteLength;
                    if(item.generation===undefined)this.socket.emit("frame",item.frame);
                    else this.socket.emit("frame",item.frame,item.generation);
                }
                else if(item.kind==="release"){this.queuedBytes-=16;this.socket.emit("releasePort",item.proto,item.port,item.generation);}
                else if(item.kind==="leaseRequest"){this.queuedBytes-=128;this.socket.emit("leaseUdpPeer",item.id,item.request);}
                else if(item.kind==="leaseCancel"){this.queuedBytes-=16;this.socket.emit("cancelUdpPeer",item.id);}
                else if(item.kind==="leaseRelease"){this.queuedBytes-=16;this.socket.emit("releaseUdpPeer",item.id);}
                else if(item.kind==="hostRequest"){this.queuedBytes-=128;this.socket.emit("openUdpHost",item.id,item.request);}
                else if(item.kind==="hostCancel"){this.queuedBytes-=16;this.socket.emit("cancelUdpHost",item.id);}
                else if(item.kind==="hostRelease"){this.queuedBytes-=16;this.socket.emit("releaseUdpHost",item.id);}
                else if(item.kind==="tcpHostRequest"){this.queuedBytes-=128;this.socket.emit("openTcpHost",item.id,item.request);}
                else if(item.kind==="tcpHostCancel"){this.queuedBytes-=16;this.socket.emit("cancelTcpHost",item.id);}
                else{this.queuedBytes-=16;this.socket.emit("releaseTcpHost",item.id);}
            }
        } finally { this.flushing = false; }
    }
    private clearQueue(): void {
        this.reliableQueue.length = 0;
        this.queuedBytes = 0;
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.online = false;
        this.clearQueue();
        this.cancelResolves();
        this.udpPeers.disconnect(); this.udpHosts.disconnect(); this.tcpHosts.disconnect();
        clearTimeout(this.deadline);
        this.socket.removeAllListeners();
        this.socket.sendBuffer.length = 0;
        this.socket.disconnect();
        this.net.setConnected(false, "closed");
        if (!this.settled) {
            this.settled = true;
            this.rejectReady(new Error("LAN connection closed"));
        }
    }
    private failInitial(error: Error): void {
        if (this.settled || this.closed) return;
        this.settled = true;
        this.rejectReady(error);
        this.close();
    }
    private acceptReady(info: LanReady): void {
        if (this.closed) return;
        const expectedIp = nodeToIpv4(this.net.node);
        if (!info || typeof info !== "object" || info.version !== PROTOCOL_VERSION || !Array.isArray(info.node) || info.node.length !== 6
            || !info.node.every((value, index) => value === this.net.node[index])
            || !Array.isArray(info.ipv4) || info.ipv4.length !== 4
            || !info.ipv4.every((value, index) => value === expectedIp[index])
            || (info.udpMulticast4V1 !== undefined && info.udpMulticast4V1 !== true)) {
            if (!this.settled) this.failInitial(new Error("Invalid LAN server identity"));
            else this.close();
            return;
        }
        try { this.net.configureTcpHosts(info.tcpHostListenV1 === undefined ? undefined : copyTcpHostCapability(info.tcpHostListenV1)); }
        catch { if (!this.settled) this.failInitial(new Error("Invalid TCP Host capability")); else this.close(); return; }
        try { this.net.configureUdpHosts(info.udpHostListenV1 === undefined ? undefined : copyUdpHostCapability(info.udpHostListenV1)); }
        catch { if (!this.settled) this.failInitial(new Error("Invalid UDP Host capability")); else this.close(); return; }
        this.net.configureMulticast4(info.udpMulticast4V1 === true);
        this.net.configureGatewayAddresses(info.gatewayIpv4 ?? []);
        this.net.configureGatewayIpv6(info.gatewayIpv6 ?? []);
        this.online = true;
        clearTimeout(this.deadline);
        this.net.setConnected(true);
        this.flush();
        if (!this.settled) { this.settled = true; this.resolveReady(); }
    }
}
