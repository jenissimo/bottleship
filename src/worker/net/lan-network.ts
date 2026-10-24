// Adapted from cszackrison/bottleship, Apache-2.0; see packages/lan/NOTICE.
import {
    BROADCAST_NODE, PROTO_IPX, PROTO_UDP, PROTO_UDP6, PROTO_RAW4, isMulticastIpv4Node, multicast4Node, validMulticast4Header, type UdpMulticast4Header, validBindingGeneration, decodeDatagram, encodeDatagram, isBroadcastNode, isLanNode,
    isProtocol, isRawProtocol, validRawPayload, maxPayload, nodeToIpv4, validPort, isAddressNode, ipv4ToNode, isExternalIpv4Node, isExternalIpv6Node, LAN_IPV6_PREFIX, type GatewayIpv6Address,
} from "./netplay-wire";
export {
    IPX_MAX_PAYLOAD, UDP_MAX_PAYLOAD, UDP6_MAX_PAYLOAD, DIRECTPLAY_MAX_PAYLOAD, ipv4ToNode, nodeToIpv4,
} from "./netplay-wire";
import { copyUdpHostCapability, copyUdpHostReady, type UdpHostListenCapability, type UdpHostOpenRequest, type UdpHostReady } from "./netplay-wire";
import type { UdpHostLease } from "./udp-host-lease-rpc";
import type { DirectPlay8NetworkPolicy } from "../../network-config";
import { copyLocalUdpContext, type LocalUdpContext } from "./local-udp-context";
export type { LocalUdpContext, LocalUdpEndpoint } from "./local-udp-context";
import { NetResolveError, type ResolveRequest, type ResolveResult } from "./netplay-wire";
export { NetResolveError, type ResolveRequest, type ResolveResult } from "./netplay-wire";
export const IPX_NETNUM = new Uint8Array([0, 0, 0, 1]);
export const LAN_NET_OCTET = 10;
export interface LanDatagram { srcNode: Uint8Array; srcPort: number; data: Uint8Array; multicast4?: UdpMulticast4Header & {localOrigin: boolean}; localUdp?: LocalUdpContext }
export interface LanEndpoint { deliver(dg: LanDatagram): void }
export interface RawDeliveryTarget { port: number; generation: number }
export interface LanPortDisconnect { node: Uint8Array; port: number; proto: number }
export interface LanSocketError { node: Uint8Array; localPort: number; remotePort: number; proto: number; code: number; wireId?: number;bindingGeneration?:number; localUdp?: LocalUdpContext }
export interface NetTransport {
    readonly connected?: boolean;
    /** Host-owned state may be newer than queued process MessagePort snapshots. */
    connectionState?(): boolean;
    /** Apply a coherent host readiness snapshot before synchronous guest APIs. */
    synchronizeState?(): void;
    supportsMulticast4?(): boolean;
    readonly routeLocal?: boolean;
    send(frame: Uint8Array<ArrayBuffer>,bindingGeneration?:number,localUdp?:LocalUdpContext): boolean;
    releasePort?(port:number,proto:number,bindingGeneration:number):void;
    resolve?(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult>;
    leaseUdpPeer?(request: import("./netplay-wire").UdpPeerLeaseRequest, signal?: AbortSignal): Promise<{ release(): void }>;
    openUdpHost?(request: UdpHostOpenRequest, signal?: AbortSignal): Promise<UdpHostLease>;
    close(): void;
}
export interface LanPortRegistry {
    allocateSocketId?(): number;
    generation?(port:number,proto:number):number;
    deliveryGeneration?(port: number, proto: number): number;
    claim(port: number, proto: number, reuse?: boolean): boolean;
    release(port: number, proto: number): void;
}
export interface LanState {
    connected: boolean;
    node: Uint8Array;
    ipv4: Uint8Array;
    generation: number;
    reason?: string;
    gatewayIpv4?: number[][];
    gatewayIpv6?: GatewayIpv6Address[];
    udpHostListenV1?: UdpHostListenCapability;
    udpMulticast4V1?: true;
    directPlay8?: DirectPlay8NetworkPolicy;
}
const EPHEMERAL = [[0x4000, 0x7fff], [49152, 65535], [49152, 65535], [49152, 65535], [49152, 65535], [49152, 65535], [1, 256], [1, 256]];
function randomNode(): Uint8Array {
    const node = new Uint8Array([2, 0, 0, 0, 0, 0]);
    do { crypto.getRandomValues(node.subarray(3)); } while (!isLanNode(node));
    return node;
}
export class LanNetwork {
    readonly node: Uint8Array;
    readonly stats = { sent: 0, received: 0, dropped: 0 };
    private readonly ports = Array.from({ length: 8 }, () => new Map<number, LanEndpoint>());
    private nextEphemeral = EPHEMERAL.map(([low]) => low);
    private readonly listeners = new Set<(state: LanState) => void>();
    private readonly writableListeners = new Set<() => void>();
    private readonly peerListeners = new Set<(node: Uint8Array) => void>();
    private readonly socketErrorListeners = new Set<(error: LanSocketError) => void>();
    private readonly portListeners = new Set<(port: LanPortDisconnect) => void>();
    private transport: NetTransport | null = null;
    private readonly gatewayAddresses = new Set<string>();
    private readonly gatewayIpv6 = new Map<string, GatewayIpv6Address>();
    private portRegistry: LanPortRegistry | null = null;
    private online = false;
    private generation = 0;
    private nextSocketId = 1;
    private hostCapability?: UdpHostListenCapability;
    private multicast4Capability = false;
    configureMulticast4(supported = false): void { this.multicast4Capability = supported; }
    get udpMulticast4V1(): true | undefined { this.synchronizeState(); return (this.transport?.supportsMulticast4?.() ?? this.multicast4Capability) ? true : undefined; }
    private dp8Policy?: DirectPlay8NetworkPolicy;
    get directPlay8(): DirectPlay8NetworkPolicy | undefined { this.synchronizeState(); return this.dp8Policy && {...this.dp8Policy}; }
    configureDirectPlay8(policy?: DirectPlay8NetworkPolicy): void { this.dp8Policy = policy && {...policy}; }
    configureUdpHosts(capability?: UdpHostListenCapability): void { this.hostCapability = capability && copyUdpHostCapability(capability); }
    get udpHostListenV1(): UdpHostListenCapability | undefined { this.synchronizeState(); return this.hostCapability && copyUdpHostCapability(this.hostCapability); }
    private readonly pendingUdpLeases = new Set<{ localPort: number; proto: number; abort(): void }>();
    private readonly activeUdpLeases = new Set<{ localPort: number; proto: number; release(): void }>();
    private nextBindingGeneration=1;
    private nextDeliveryGeneration = 1;
    private readonly deliveryBindings = Array.from({ length: 8 }, () => new Map<number, number>());
    private readonly bindings=Array.from({length:8},()=>new Map<number,number>());
    bindingGeneration(port:number,proto:number):number{return this.bindings[proto]?.get(port)??0;}
    deliveryGeneration(port: number, proto: number): number { return this.deliveryBindings[proto]?.get(port) ?? 0; }
    releaseRemotePort(port:number,proto:number,generation:number):void{this.transport?.releasePort?.(port,proto,generation);}
    /** Wire identities outlive guest handles and are shared across process adapters. */
    allocateSocketId(): number {
        const id = this.portRegistry?.allocateSocketId?.() ?? (this.nextSocketId <= 0xffffffff ? this.nextSocketId++ : 0);
        if (!id) throw new Error("Network socket identity space exhausted");
        return id >>> 0;
    }

    constructor(node = randomNode()) {
        if (!isLanNode(node)) throw new RangeError("Invalid virtual LAN node");
        this.node = node.slice();
    }
    get ipv4(): Uint8Array { return nodeToIpv4(this.node); }
    private synchronizeState(): void { this.transport?.synchronizeState?.(); }
    get connected(): boolean { this.synchronizeState(); return this.transport?.connectionState?.() ?? this.online; }
    get ipv6(): Uint8Array {
        const address = new Uint8Array(16); address.set(LAN_IPV6_PREFIX); address.set(this.node, 10); return address;
    }
    configureGatewayIpv6(addresses: GatewayIpv6Address[]): void { this.gatewayIpv6.clear(); this.registerGatewayIpv6(addresses); }
    registerGatewayIpv6(addresses: GatewayIpv6Address[]): void {
        if (!Array.isArray(addresses)) return;
        for (const item of addresses.slice(0, 4096)) if (item && this.gatewayIpv6.size < 4096 && Array.isArray(item.address) && item.address.length === 16
            && item.address.every(n => Number.isInteger(n) && n >= 0 && n < 256) && Array.isArray(item.node) && item.node.length === 6
            && item.node.every(n => Number.isInteger(n) && n >= 0 && n < 256) && isExternalIpv6Node(Uint8Array.from(item.node))
            && (item.scopeId === undefined || (Number.isInteger(item.scopeId) && item.scopeId >= 0 && item.scopeId <= 0xffffffff))) {
            const scopeId = item.scopeId ?? 0;
            this.gatewayIpv6.set(item.address.join(".") + "%" + scopeId,
                { address: item.address.slice(), node: item.node.slice(), ...(scopeId ? { scopeId } : {}) });
        }
    }
    routeIpv6(address: Uint8Array, scopeId = 0): Uint8Array {
        this.synchronizeState();
        if (address.length !== 16 || !Number.isInteger(scopeId) || scopeId < 0 || scopeId > 0xffffffff) throw new NetResolveError("NO_DATA");
        if (address.subarray(0, 15).every(n => n === 0) && address[15] === 1) return this.node.slice();
        if (address.subarray(0, 10).every(n => n === 0) && address[10] === 255 && address[11] === 255) return this.routeIpv4(address.subarray(12));
        if (LAN_IPV6_PREFIX.every((n, i) => n === address[i]) && isLanNode(address.subarray(10))) return address.slice(10);
        const gateway = this.gatewayIpv6.get(address.join(".") + "%" + scopeId);
        if (!gateway) throw new NetResolveError("ACCESS_DENIED", "IPv6 destination is not configured");
        return Uint8Array.from(gateway.node);
    }
    nodeToIpv6(node: Uint8Array): Uint8Array {
        this.synchronizeState();
        if (isLanNode(node)) { const address = new Uint8Array(16); address.set(LAN_IPV6_PREFIX); address.set(node, 10); return address; }
        if (isExternalIpv4Node(node)) { const address = new Uint8Array(16); address[10] = address[11] = 255; address.set(nodeToIpv4(node), 12); return address; }
        for (const item of this.gatewayIpv6.values()) if (item.node.every((n, i) => n === node[i])) return Uint8Array.from(item.address);
        throw new NetResolveError("NO_DATA", "Unknown IPv6 relay address");
    }
    nodeToIpv6Scope(node: Uint8Array): number {
        this.synchronizeState();
        for (const item of this.gatewayIpv6.values()) if (item.node.every((n, i) => n === node[i])) return item.scopeId ?? 0;
        return 0;
    }
    configureGatewayAddresses(addresses: number[][]): void {
        this.gatewayAddresses.clear();
        this.registerGatewayAddresses(addresses);
    }
    registerGatewayAddresses(addresses: number[][]): void {
        if (!Array.isArray(addresses)) return;
        for (const ip of addresses.slice(0, 4096)) if (Array.isArray(ip) && this.gatewayAddresses.size < 4096 && ip.length === 4
            && ip.every(n => Number.isInteger(n) && n >= 0 && n < 256)) this.gatewayAddresses.add(ip.join("."));
    }
    setPortRegistry(registry: LanPortRegistry | null): void {
        if (this.ports.some(ports => ports.size)) throw new Error("Port registry must be installed before binding");
        this.portRegistry = registry;
    }
    adoptIdentity(node: Uint8Array): void {
        if (!isLanNode(node) || this.ports.some(ports => ports.size)) throw new Error("Identity must be adopted before binding");
        this.node.set(node);
    }
    routeIpv4(ip: Uint8Array): Uint8Array { this.synchronizeState(); return ipv4ToNode(ip, this.gatewayAddresses.has(ip.join("."))); }
    async resolve(host: string, family: 0 | 4 | 6 = 0, signal?: AbortSignal): Promise<ResolveResult> {
        if (signal?.aborted) throw new NetResolveError("CANCELLED");
        if (!this.connected || !this.transport?.resolve) throw new NetResolveError("NETWORK_DOWN");
        return this.transport.resolve({ host, family }, signal);
    }

    /** Register an exact incoming native UDP tuple without emitting a datagram. */
    async leaseUdpPeer(localPort: number, node: Uint8Array, remotePort: number, signal?: AbortSignal): Promise<{ release(): void }> {
        const proto = isExternalIpv6Node(node) ? 4 : 1, binding = this.bindingGeneration(localPort, proto);
        if (!validPort(localPort) || !validPort(remotePort) || !isAddressNode(node) || !binding) throw new NetResolveError("NO_DATA");
        if (!this.connected || !this.transport) throw new NetResolveError("NETWORK_DOWN");
        if (signal?.aborted) throw new NetResolveError("CANCELLED");
        if (this.pendingUdpLeases.size >= 16 || this.activeUdpLeases.size + this.pendingUdpLeases.size >= 128) throw new NetResolveError("ACCESS_DENIED", "UDP peer lease capacity");
        return this.withUdpBinding(localPort, proto, signal, (transport, binding, signal) =>
            isLanNode(node) ? Promise.resolve({release() {}}) :
                transport.leaseUdpPeer?.({proto, localPort, bindingGeneration: binding, node: Array.from(node), remotePort}, signal) ??
                    Promise.reject(new NetResolveError("ACCESS_DENIED", "Native UDP peer leases unavailable")));
    }
    /** Acquire an acknowledged physical listener for this exact UDP binding. */
    async openUdpHost(localPort: number, listenerId: string, signal?: AbortSignal): Promise<UdpHostLease> {
        this.synchronizeState();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(listenerId) || !validPort(localPort) || !this.bindingGeneration(localPort, 1))
            throw new NetResolveError("NO_DATA");
        if (!this.hostCapability?.listeners.some(listener => listener.id === listenerId))
            throw new NetResolveError("ACCESS_DENIED", "Native UDP Host listener unavailable");
        const epoch = this.generation, originalBinding = this.bindingGeneration(localPort, 1);
        const lease = await this.withUdpBinding(localPort, 1, signal, async (transport, binding, signal) => {
            if (!transport.openUdpHost) throw new NetResolveError("ACCESS_DENIED", "Native UDP Host listeners unavailable");
            const lease = await transport.openUdpHost({proto: 1, localPort, bindingGeneration: binding, listenerId}, signal);
            try {
                if (!lease.isLive()) throw new NetResolveError("CANCELLED");
                const ready = copyUdpHostReady(lease);
                this.synchronizeState();
                const advertised = this.hostCapability?.listeners.find(listener => listener.id === listenerId);
                if (!advertised || advertised.allowedNodes.length !== ready.allowedNodes.length ||
                    !ready.allowedNodes.every(node => advertised.allowedNodes.some(other => other.every((v, i) => v === node[i]))))
                    throw new NetResolveError("NO_RECOVERY", "UDP Host ingress ACL changed");
                return {...ready, closed: lease.closed, isLive: () => lease.isLive(), release: () => lease.release()};
            } catch (error) { lease.release(); throw error; }
        });
        this.registerGatewayAddresses([lease.address.node.slice(2), ...lease.allowedNodes.map(node => node.slice(2))]);
        let ended = false;
        void lease.closed.then(() => { ended = true; lease.release(); });
        return {...lease,
            isLive: () => this.connected && !ended && this.generation === epoch && this.bindingGeneration(localPort, 1) === originalBinding && lease.isLive(),
            release: () => { ended = true; lease.release(); }};
    }
    private async withUdpBinding<M extends {release(): void}>(localPort: number, proto: number, signal: AbortSignal | undefined,
        open: (transport: NetTransport, binding: number, signal: AbortSignal) => Promise<M>): Promise<M> {
        const binding = this.bindingGeneration(localPort, proto);
        if (!this.connected || !this.transport) throw new NetResolveError("NETWORK_DOWN");
        if (signal?.aborted) throw new NetResolveError("CANCELLED");
        if (!binding) throw new NetResolveError("NO_DATA");
        if (this.pendingUdpLeases.size >= 16 || this.activeUdpLeases.size + this.pendingUdpLeases.size >= 128)
            throw new NetResolveError("ACCESS_DENIED", "UDP binding lease capacity");
        const transport = this.transport, epoch = this.generation, controller = new AbortController();
        let adopted = false;
        const live = () => this.connected && !controller.signal.aborted && this.transport === transport && this.generation === epoch && this.bindingGeneration(localPort, proto) === binding;
        const pending = { localPort, proto, abort: () => controller.abort() };
        this.pendingUdpLeases.add(pending);
        const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
        let rejectAbort!: (error: NetResolveError) => void;
        const aborted = new Promise<never>((_ok, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(new NetResolveError("CANCELLED"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        try {
            const ready = open(transport, binding, controller.signal).then(underlying => {
                if (!live()) { underlying.release(); throw new NetResolveError("CANCELLED"); }
                let released = false;
                const lease = Object.assign({}, underlying, { localPort, proto, release: () => {
                    if (released) return; released = true; this.activeUdpLeases.delete(lease);
                    signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", lease.release);
                    try { underlying.release(); } catch { /* Cleanup remains idempotent after transport loss. */ }
                } });
                this.activeUdpLeases.add(lease); adopted = true;
                controller.signal.addEventListener("abort", lease.release, {once: true});
                return lease;
            });
            return await Promise.race([ready, aborted]);
        } finally {
            this.pendingUdpLeases.delete(pending); if (!adopted) signal?.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", onAbort);
        }
    }
    private retireUdpLeases(port?: number, proto?: number): void {
        for (const pending of [...this.pendingUdpLeases]) if (port === undefined || (pending.localPort === port && pending.proto === proto)) pending.abort();
        for (const lease of [...this.activeUdpLeases]) if (port === undefined || (lease.localPort === port && lease.proto === proto)) lease.release();
    }

    attach(transport: NetTransport | null): void {
        if (this.transport === transport) return;
        const previous = this.transport;
        this.transport = null;
        this.setConnected(false, "transport changed", true);
        previous?.close();
        this.transport = transport;
        if (transport && transport.connected !== false) this.setConnected(true);
    }
    setConnected(connected: boolean, reason?: string, force = false): void {
        if (!force && this.online === connected) return;
        this.online = connected;
        if (!connected || force) { this.retireUdpLeases(); if (!connected) { this.hostCapability = undefined; this.multicast4Capability = false; } }
        const state: LanState = { connected, node: this.node.slice(), ipv4: this.ipv4, generation: ++this.generation, reason,
            gatewayIpv4: [...this.gatewayAddresses].map(ip => ip.split(".").map(Number)), gatewayIpv6: [...this.gatewayIpv6.values()],
            udpHostListenV1: this.udpHostListenV1, udpMulticast4V1: this.udpMulticast4V1, directPlay8: this.directPlay8 };
        for (const listener of this.listeners) listener(state);
    }
    onStateChange(listener: (state: LanState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onPortDisconnect(listener: (port: LanPortDisconnect) => void): () => void {
        this.portListeners.add(listener);
        return () => this.portListeners.delete(listener);
    }
    notifyPortDisconnected(port: LanPortDisconnect): void {
        if (!isAddressNode(port.node) || !validPort(port.port) || !isProtocol(port.proto)) return;
        for (const listener of this.portListeners) listener({ ...port, node: port.node.slice() });
    }
    onSocketError(listener: (error: LanSocketError) => void): () => void {
        this.socketErrorListeners.add(listener);
        return () => this.socketErrorListeners.delete(listener);
    }
    notifySocketError(error: LanSocketError): void {
        // Relay errors may contain unknown properties. They cannot grant local provenance.
        if (!error || error.localUdp !== undefined) return;
        this.publishSocketError(error);
    }
    /** Only trusted local admission/namespace delivery may publish an address-bearing reset. */
    notifyLocalUdpError(error: LanSocketError & {localUdp: LocalUdpContext}): void {
        if (!error || error.code !== 10054 || !(error.node instanceof Uint8Array) || !this.isSelf(error.node)) return;
        const localUdp = this.validateLocalUdpContext(error.localUdp, error.proto, error.localPort, error.remotePort);
        if (!localUdp) return;
        this.publishSocketError({...error, localUdp});
    }
    private publishSocketError(error: LanSocketError): void {
        if (!isAddressNode(error.node) || !validPort(error.localPort) || !validPort(error.remotePort)
            || !isProtocol(error.proto) || !Number.isInteger(error.code) || error.code < 10000 || error.code > 12000
            || (error.bindingGeneration!==undefined&&(!Number.isInteger(error.bindingGeneration)||error.bindingGeneration<1||error.bindingGeneration>0xffffffff))
            || (error.wireId !== undefined && (!Number.isInteger(error.wireId) || error.wireId < 1 || error.wireId > 0xffffffff))) return;
        for (const listener of this.socketErrorListeners) listener({ ...error, node: error.node.slice(),
            ...(error.localUdp ? {localUdp: copyLocalUdpContext(error.localUdp)!} : {}) });
    }
    private localUdpAddress(address: Uint8Array): boolean {
        if (address.length === 4) { const own = this.ipv4; return address[0] === 127 || address.every((n, i) => n === own[i]); }
        if (address.length !== 16) return false;
        if (address.subarray(0, 15).every(n => n === 0) && address[15] === 1) return true;
        if (address.subarray(0, 10).every(n => n === 0) && address[10] === 255 && address[11] === 255)
            return this.localUdpAddress(address.subarray(12));
        const own = this.ipv6;
        return address.every((n, i) => n === own[i]);
    }
    /** Validate host-only endpoint provenance against this local interface identity. */
    validateLocalUdpContext(value: unknown, proto: number, srcPort: number, dstPort: number): LocalUdpContext | undefined {
        const context = copyLocalUdpContext(value);
        if (!context || (proto !== PROTO_UDP && proto !== PROTO_UDP6)
            || context.source.family !== (proto === PROTO_UDP ? 2 : 23)
            || context.source.port !== srcPort || context.destination.port !== dstPort
            || !this.localUdpAddress(context.source.address) || !this.localUdpAddress(context.destination.address)) return;
        return context;
    }
    onPeerDisconnect(listener: (node: Uint8Array) => void): () => void {
        this.peerListeners.add(listener);
        return () => this.peerListeners.delete(listener);
    }
    notifyPeerDisconnected(node: Uint8Array): void {
        if (!isLanNode(node) || this.isSelf(node)) return;
        for (const listener of this.peerListeners) listener(node.slice());
    }
    onWritable(listener: () => void): () => void {
        this.writableListeners.add(listener);
        return () => this.writableListeners.delete(listener);
    }
    notifyWritable(): void {
        for (const listener of this.writableListeners) listener();
    }
    isBound(port: number, proto = PROTO_IPX): boolean {
        return isProtocol(proto) && this.ports[proto].has(port);
    }
    bind(port: number, endpoint: LanEndpoint, proto = PROTO_IPX, reuse = false): boolean {
        if (!isProtocol(proto) || !validPort(port) || this.ports[proto].has(port)) return false;
        if (this.portRegistry && !this.portRegistry.claim(port, proto, reuse)) return false;
        const generation=this.portRegistry?.generation?.(port,proto)??this.nextBindingGeneration++;
        const deliveryGeneration = this.portRegistry?.deliveryGeneration?.(port, proto) ?? this.nextDeliveryGeneration++;
        if (!validBindingGeneration(generation) || !validBindingGeneration(deliveryGeneration)) { this.portRegistry?.release(port, proto); return false; }
        this.bindings[proto].set(port,generation);
        this.deliveryBindings[proto].set(port, deliveryGeneration);
        this.ports[proto].set(port, endpoint);
        return true;
    }
    bindEphemeral(endpoint: LanEndpoint, proto = PROTO_IPX): number {
        if (!isProtocol(proto)) return 0;
        const [low, high] = EPHEMERAL[proto];
        for (let count = low; count <= high; count++) {
            const port = this.nextEphemeral[proto];
            this.nextEphemeral[proto] = port === high ? low : port + 1;
            if (this.bind(port, endpoint, proto)) return port;
        }
        return 0;
    }
    unbind(port: number, endpoint: LanEndpoint, proto = PROTO_IPX): void {
        if (isProtocol(proto) && this.ports[proto].get(port) === endpoint) {
            const generation=this.bindingGeneration(port,proto);
            this.retireUdpLeases(port, proto);
            this.ports[proto].delete(port);this.bindings[proto].delete(port);this.deliveryBindings[proto].delete(port);
            this.portRegistry?.release(port, proto);
            if(!this.portRegistry)this.releaseRemotePort(port,proto,generation);
        }
    }
    /** Multicast stays a destination-aware packet through the local broker and relay. */
    sendMulticast4(srcPort: number, group: Uint8Array, dstPort: number, data: Uint8Array, interfaceIndex: 1 | 2, ttl: number,
        bindingGeneration = this.bindingGeneration(srcPort, PROTO_UDP)): boolean {
        const multicast4 = {group, interfaceIndex, ttl};
        if (!validPort(srcPort) || !validPort(dstPort) || data.length > maxPayload(PROTO_UDP) || !validMulticast4Header(multicast4)) return false;
        const frame = encodeDatagram(PROTO_UDP, multicast4Node(group), dstPort, srcPort, data, multicast4);
        if (this.transport?.routeLocal) {
            const accepted = this.transport.send(frame, bindingGeneration);
            if (accepted) this.stats.sent++; else this.stats.dropped++;
            return accepted;
        }
        if (interfaceIndex === 2 && ttl > 0 && this.connected && this.transport
            && (!this.udpMulticast4V1 || !this.transport.send(frame, bindingGeneration))) {
            this.stats.dropped++;
            return false;
        }
        this.deliverLocal(PROTO_UDP, this.node, srcPort, dstPort, data, multicast4);
        this.stats.sent++;
        return true;
    }
    send(srcPort: number, dstNode: Uint8Array, dstPort: number, data: Uint8Array, proto = PROTO_IPX, bindingGeneration=this.bindingGeneration(srcPort,proto), localUdp?: LocalUdpContext): boolean {
        this.synchronizeState();
        if (!isProtocol(proto) || !validPort(srcPort) || !validPort(dstPort) || dstNode.length !== 6
            || data.length > maxPayload(proto) || (proto === PROTO_IPX && data.length < 2)
            || (isRawProtocol(proto) && (!validRawPayload(data) || dstPort > 256 || srcPort > 256))) return false;
        const context = localUdp === undefined ? undefined : this.validateLocalUdpContext(localUdp, proto, srcPort, dstPort);
        if (localUdp !== undefined && (!context || !this.isSelf(dstNode)
            || !validBindingGeneration(bindingGeneration) || bindingGeneration !== this.bindingGeneration(srcPort, proto))) return false;
        if (isMulticastIpv4Node(dstNode)) return proto === PROTO_UDP
            && this.sendMulticast4(srcPort, dstNode.subarray(2), dstPort, data, 2, 1, bindingGeneration);
        if (this.transport?.routeLocal) {
            const accepted = this.transport.send(encodeDatagram(proto, dstNode, dstPort, srcPort, data),bindingGeneration,context);
            if (accepted) this.stats.sent++; else this.stats.dropped++;
            return accepted;
        }
        const broadcast = isBroadcastNode(dstNode);
        const local = this.isSelf(dstNode);
        if (!local && this.online && this.transport) {
            if (!this.transport.send(encodeDatagram(proto, broadcast ? BROADCAST_NODE : dstNode, dstPort, srcPort, data),bindingGeneration)) {
                this.stats.dropped++;
                return false;
            }
        } else if (!local && !broadcast) {
            this.stats.dropped++;
            return false;
        }
        if (local && (proto === PROTO_UDP || proto === PROTO_UDP6) && !this.isBound(dstPort, proto))
            this.queueLocalUdpReset(srcPort, dstPort, proto, bindingGeneration, context);
        if (local || broadcast) this.deliverLocal(proto, this.node, srcPort, dstPort, data, undefined, context);
        this.stats.sent++;
        return true;
    }
    /** Only trusted local send admission may report a missing UDP address object.
     * Received frames, rejected sends and receiver-side queue drops cannot do so. */
    private queueLocalUdpReset(localPort: number, remotePort: number, proto: number, bindingGeneration: number, localUdp?: LocalUdpContext): void {
        const deliveryGeneration = this.deliveryGeneration(localPort, proto);
        if (!validBindingGeneration(bindingGeneration) || !deliveryGeneration
            || bindingGeneration !== this.bindingGeneration(localPort, proto)) return;
        const node = this.node.slice();
        queueMicrotask(() => {
            if (deliveryGeneration !== this.deliveryGeneration(localPort, proto)
                || bindingGeneration !== this.bindingGeneration(localPort, proto)) return;
            const error = {node, localPort, remotePort, proto, code: 10054, bindingGeneration};
            if (localUdp) this.notifyLocalUdpError({...error, localUdp});
            else this.notifySocketError(error);
        });
    }
    receiveFrame(frame: Uint8Array, allowLoopback = false,bindingGeneration?:number, deliveryGeneration?:number, localUdp?: LocalUdpContext): void {
        const datagram = decodeDatagram(frame);
        const context = datagram && localUdp !== undefined ? this.validateLocalUdpContext(localUdp, datagram.proto, datagram.srcPort, datagram.dstPort) : undefined;
        if (!datagram || (localUdp !== undefined && (!context || !allowLoopback || !this.isSelf(datagram.node) || !!datagram.multicast4))
            || (bindingGeneration !== undefined && (!validBindingGeneration(bindingGeneration)
            || bindingGeneration !== this.bindingGeneration(datagram.dstPort, datagram.proto)))
            || (deliveryGeneration !== undefined && (!validBindingGeneration(deliveryGeneration)
                || deliveryGeneration !== this.deliveryGeneration(datagram.dstPort, datagram.proto)))
            || (datagram.multicast4 && !allowLoopback && (datagram.multicast4.interfaceIndex !== 2 || datagram.multicast4.ttl === 0))
            || !isAddressNode(datagram.node) || (!allowLoopback && this.isSelf(datagram.node))) {
            this.stats.dropped++;
            return;
        }
        this.deliverLocal(datagram.proto, datagram.node, datagram.srcPort, datagram.dstPort, datagram.payload, datagram.multicast4, context);
    }
    /** Trusted broker delivery: the capture owner was checked before fanout. */
    receiveRawFrame(frame: Uint8Array, targets: readonly RawDeliveryTarget[]): void {
        const datagram = decodeDatagram(frame);
        if (!datagram || datagram.proto !== PROTO_RAW4 || !isAddressNode(datagram.node)) {
            this.stats.dropped++;
            return;
        }
        this.deliverRawBindings(datagram.node, datagram.srcPort, datagram.payload, targets);
    }
    private rawTargets(protocol: number): RawDeliveryTarget[] {
        const targets: RawDeliveryTarget[] = [];
        for (const port of new Set([protocol + 1, 1, 256])) {
            const generation = this.deliveryGeneration(port, PROTO_RAW4);
            if (generation) targets.push({ port, generation });
        }
        return targets;
    }
    private deliverRawBindings(srcNode: Uint8Array, srcPort: number, data: Uint8Array, targets: readonly RawDeliveryTarget[]): void {
        if (!Array.isArray(targets) || !targets.length || targets.length > 3) { this.stats.dropped++; return; }
        const candidates = new Set([data[0] + 1, 1, 256]), seen = new Set<number>();
        const deliveries = new Map<LanEndpoint, RawDeliveryTarget[]>();
        for (const target of targets) {
            if (!target || !candidates.has(target.port) || seen.has(target.port) || !validBindingGeneration(target.generation)) {
                this.stats.dropped++;
                return;
            }
            seen.add(target.port);
            const endpoint = this.ports[PROTO_RAW4].get(target.port);
            if (!endpoint || this.deliveryGeneration(target.port, PROTO_RAW4) !== target.generation) continue;
            const bindings = deliveries.get(endpoint) ?? [];
            bindings.push({ port: target.port, generation: target.generation });
            deliveries.set(endpoint, bindings);
        }
        let delivered = false;
        for (const [endpoint, bindings] of deliveries) {
            // A preceding callback may close or replace another recipient.
            if (!bindings.some(target => this.deliveryGeneration(target.port, PROTO_RAW4) === target.generation
                && this.ports[PROTO_RAW4].get(target.port) === endpoint)) continue;
            if (!delivered) { delivered = true; this.stats.received++; }
            endpoint.deliver({ srcNode: srcNode.slice(), srcPort, data: data.slice() });
        }
        if (!delivered) this.stats.dropped++;
    }
    reset(): void {
        for (let proto = 0; proto < this.ports.length; proto++) {
            for (const [port,endpoint] of [...this.ports[proto]]) this.unbind(port,endpoint,proto);
        }
        this.nextEphemeral = EPHEMERAL.map(([low]) => low);
    }
    isSelf(node: Uint8Array): boolean {
        return node.length === 6 && this.node.every((value, index) => value === node[index]);
    }
    private deliverLocal(proto: number, srcNode: Uint8Array, srcPort: number, dstPort: number, data: Uint8Array, multicast4?: UdpMulticast4Header, localUdp?: LocalUdpContext): void {
        if (proto === PROTO_RAW4) {
            this.deliverRawBindings(srcNode, srcPort, data, this.rawTargets(data[0]));
            return;
        }
        // NT's raw provider fans an IP packet out to its actual protocol plus
        // wildcard address objects (protocol zero and IPPROTO_RAW). One endpoint
        // may own several bindings; it must see the packet only once.
        const ports = isRawProtocol(proto) ? [dstPort, 1, 256] : [dstPort];
        const endpoints = new Set(ports.map(port => this.ports[proto].get(port)));
        endpoints.delete(undefined);
        if (!endpoints.size) { this.stats.dropped++; return; }
        this.stats.received++;
        for (const endpoint of endpoints) endpoint!.deliver({ srcNode: srcNode.slice(), srcPort, data: data.slice(),
            ...(multicast4 ? {multicast4: {...multicast4, group: multicast4.group.slice(), localOrigin: this.isSelf(srcNode)}} : {}),
            ...(localUdp ? {localUdp: copyLocalUdpContext(localUdp)!} : {}) });
    }
}
export const lanNetwork = new LanNetwork();
