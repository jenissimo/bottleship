import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIP, Socket as NativeSocket } from "node:net";
import { encodeDatagram, isExternalNode, isExternalIpv4Node, nodeKey, nodeToIpv4, PROTO_UDP, PROTO_UDP6, isTcpProtocol, isRawProtocol, maxPayload, validBindingGeneration, isProtocol, validPort, type DecodedDatagram } from "./protocol";
import { CREDIT, DATA, FIN, OOB, RST, SYN, SYNACK, TCP_SEGMENT, TCP_WINDOW, TCP_OPTION, SYN_INLINE_FLAG, SYN_KEEPALIVE_FLAG, SYN_NODELAY_FLAG, SYN_WINDOW_MASK, TCP_OPTION_KEEPALIVE, TCP_OPTION_NODELAY, decodeTcpFrame, encodeTcpFrame, type TcpFrame } from "./tcp-protocol";
import { parseIpv6, formatIpv6 } from "./ip-address";
import { NetResolveError, type ResolveRequest, type ResolveResult } from "./resolve";
import { NativeHelperSocket } from "./native-helper";
import { NativeDestinationPolicy } from "./native-policy";
import { NativeUdpSocket } from "./native-udp";
import { RawEchoGateway } from "./raw-gateway";

export interface GatewayRoute {
    host: string;
    address?: string;
    /** Guest-visible IPv6 interface scope, independent of the native host's zone. */
    scopeId?: number;
    names?: string[];
    ports?: number[];
    protocols: ("udp" | "tcp" | "raw")[];
    ipProtocols?: number[];
    /** Force native RAW capture with an exclusive destination lease, including ICMP echo. */
    rawMode?: "exclusive";
}
export interface GatewayOptions {
    routes: GatewayRoute[];
    maxTcpConnections?: number;
    maxUdpFlows?: number;
    maxRawFlows?: number;
    connectTimeoutMs?: number;
    udpIdleTimeoutMs?: number;
    /** Explicit path to the optional native TCP helper, enabling MSG_OOB. */
    nativeHelperPath?: string;
}
interface ResolvedRoute { config: GatewayRoute; addresses: string[]; nativeAddresses: string[] }
const normalizeHost = (host: string) => host.toLowerCase().replace(/\.$/, "");
function validateRoute(route: GatewayRoute): void {
    if (!route || typeof route.host !== "string" || !route.host || route.host.length > 253
        || (route.address !== undefined && (!isIP(route.address)
            || (route.address.includes("%") && (!/^\d+$/.test(route.address.split("%")[1]) || Number(route.address.split("%")[1]) > 0xffffffff))))
        || (route.rawMode !== undefined && route.rawMode !== "exclusive")
        || (route.scopeId !== undefined && (!Number.isInteger(route.scopeId) || route.scopeId < 0 || route.scopeId > 0xffffffff))
        || !Array.isArray(route.protocols) || !route.protocols.length || !route.protocols.every(proto => proto === "udp" || proto === "tcp" || proto === "raw")
        || ((route.protocols.includes("udp") || route.protocols.includes("tcp")) && (!Array.isArray(route.ports) || !route.ports.length))
        || (route.ports !== undefined && (!Array.isArray(route.ports) || route.ports.length > 256 || !route.ports.every(port => Number.isInteger(port) && port > 0 && port < 65536)))
        || (route.protocols.includes("raw") && (!Array.isArray(route.ipProtocols) || !route.ipProtocols.length))
        || (route.ipProtocols !== undefined && (!Array.isArray(route.ipProtocols) || route.ipProtocols.length > 256 || !route.ipProtocols.every(proto => Number.isInteger(proto) && proto >= 0 && proto <= 255)))
        || (route.names !== undefined && (!Array.isArray(route.names) || route.names.length > 32
            || !route.names.every(name => typeof name === "string" && name.length > 0 && name.length <= 253)))) {
        throw new TypeError("Invalid native game-server gateway route");
    }
}
function resolveFailure(error: unknown): NetResolveError {
    if (error instanceof NetResolveError) return error;
    const code = (error as { code?: string })?.code;
    return new NetResolveError(code === "ENOTFOUND" ? "HOST_NOT_FOUND" : code === "EAI_AGAIN" ? "TRY_AGAIN"
        : code === "ENODATA" ? "NO_DATA" : "NO_RECOVERY", "Native DNS lookup failed: " + (code ?? "unknown"));
}
function socketError(error: unknown): number {
    const code = (error as { code?: string | number })?.code;
    if (typeof code === "number" && code >= 10000 && code <= 12000) return code;
    return code === "ECONNREFUSED" ? 10061 : code === "ETIMEDOUT" ? 10060 : code === "EHOSTUNREACH" ? 10065
        : code === "ENETUNREACH" ? 10051 : code === "EMSGSIZE" ? 10040 : code === "EADDRNOTAVAIL" ? 10049
        : code === "ENOBUFS" || code === "ENOMEM" ? 10055 : code === "EACCES" || code === "EPERM" ? 10013 : 10054;
}
export class GatewayRoutes {
    private readonly routes: ResolvedRoute[];
    private readonly ipv6Nodes = new Map<string, Uint8Array>();
    private readonly ipv6Addresses = new Map<string, string>();
    private nextIpv6 = 1;
    private nextEcho = 1;
    private readonly echoIds = new Set<number>();
    private readonly nativePolicy=new NativeDestinationPolicy();
    acquireNative(route:GatewayRoute,ip:string,owner:object,exclusive=false):{host:string;release:()=>void} {
        const record=this.routes.find(item=>item.config===route);
        const family=isIP(ip),addresses=record?.nativeAddresses??[];
        const host=!route.address&&!route.host.includes("%")?ip:(addresses.find(address=>isIP(address)===family)??addresses[0]);
        if(!host)throw Object.assign(new Error("Native destination has no resolved address"),{code:11001});
        let canonical=host;
        if(isIP(host)===6){
            const bytes=parseIpv6(host)!;
            if(bytes.subarray(0,10).every(n=>n===0)&&bytes[10]===255&&bytes[11]===255)canonical=bytes.subarray(12).join(".");
            else{
                const zone=host.split("%")[1];
                const scope=zone?(/^\d+$/.test(zone)?Number(zone):networkInterfaces()[zone]?.find(item=>item.family==="IPv6"&&item.scopeid)?.scopeid):0;
                if(zone&&scope===undefined)throw Object.assign(new Error("Unknown native IPv6 interface"),{code:10049});
                canonical=formatIpv6(bytes)+(scope?"%"+scope:"");
            }
        }
        const release=this.nativePolicy.acquire(canonical,owner,exclusive);
        if(!release)throw Object.assign(new Error("Native destination has an exclusive RAW lease"),{code:10048});
        return {host,release};
    }
    allocateEchoId(): number {
        for (let index = 0; index < 65535; index++) {
            const id = this.nextEcho; this.nextEcho = id === 65535 ? 1 : id + 1;
            if (!this.echoIds.has(id)) { this.echoIds.add(id); return id; }
        }
        return 0;
    }
    releaseEchoId(id: number): void { this.echoIds.delete(id); }
    ownsEchoId(id:number):boolean{return this.echoIds.has(id);}
    constructor(readonly options: GatewayOptions = { routes: [] }) {
        if (!Array.isArray(options.routes) || options.routes.length > 128) throw new TypeError("Gateway routes must be an array of at most 128 entries");
        for (const [name, maximum] of [["maxTcpConnections", 4096], ["maxUdpFlows", 4096], ["maxRawFlows", 4096], ["connectTimeoutMs", 120_000], ["udpIdleTimeoutMs", 3_600_000]] as const) {
            const value = options[name];
            if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) throw new RangeError("Invalid gateway limit: " + name);
        }
        if (options.nativeHelperPath !== undefined && (typeof options.nativeHelperPath !== "string" || !options.nativeHelperPath || options.nativeHelperPath.length > 4096)) throw new TypeError("Invalid native helper path");
        for (const route of options.routes) validateRoute(route);
        this.routes = options.routes.map(config => ({ config: structuredClone(config), addresses: [], nativeAddresses: [] }));
    }
    async initialize(): Promise<void> {
        await Promise.all(this.routes.map(async route => { try { await this.resolveRoute(route); } catch { /* A failed configured name is reported by DNS requests. */ } }));
    }
    get advertisedIpv4(): number[][] { return [...new Set(this.routes.flatMap(route => route.addresses))].filter(ip => isIP(ip) === 4).map(ip => ip.split(".").map(Number)); }
    get advertisedIpv6(): { address: number[]; node: number[]; scopeId?: number }[] {
        return [...new Set(this.routes.flatMap(route => route.addresses))].filter(ip => isIP(ip) === 6)
            .map(ip => ({ address: Array.from(parseIpv6(ip)!), node: Array.from(this.ipv6Nodes.get(ip)!), ...this.scope(ip) }));
    }
    private scope(address: string): { scopeId?: number } {
        const zone = address.split("%")[1], scopeId = zone && /^\d+$/.test(zone) ? Number(zone) : 0;
        return scopeId ? { scopeId } : {};
    }
    private normalize(address: string, scopeId?: number): string {
        if (isIP(address) !== 6) return address;
        const scope = scopeId ?? this.scope(address).scopeId ?? 0;
        return formatIpv6(parseIpv6(address)!) + (scope ? "%" + scope : "");
    }
    private registerIpv6(address: string): void {
        if (isIP(address) !== 6 || this.ipv6Nodes.has(address)) return;
        if (this.ipv6Nodes.size >= 4096) throw new NetResolveError("TRY_AGAIN", "Gateway IPv6 registry is full");
        const id = this.nextIpv6++;
        const node = Uint8Array.of(2, 2, id >>> 24, id >>> 16, id >>> 8, id);
        this.ipv6Nodes.set(address, node); this.ipv6Addresses.set(nodeKey(node), address);
    }
    addressForNode(node: Uint8Array): string | undefined {
        return isExternalIpv4Node(node) ? nodeToIpv4(node).join(".") : this.ipv6Addresses.get(nodeKey(node));
    }
    private async resolveRoute(route: ResolvedRoute): Promise<void> {
        route.nativeAddresses=isIP(route.config.host)?[route.config.host]:
            [...new Set((await lookup(route.config.host,{all:true})).map(item=>item.address))].slice(0,32);
        if (route.config.address) route.addresses = [this.normalize(route.config.address, route.config.scopeId)];
        else if (isIP(route.config.host)) route.addresses = [this.normalize(route.config.host, route.config.scopeId)];
        else {
            route.addresses = [...new Set(route.nativeAddresses.map(address => this.normalize(address, route.config.scopeId)))];
        }
        if (!route.addresses.length) throw new NetResolveError("NO_DATA");
        route.addresses.forEach(address => this.registerIpv6(address));
    }
    find(ip: string, port: number, protocol: "udp" | "tcp"): GatewayRoute | undefined {
        return this.routes.find(route => route.addresses.includes(ip) && route.config.ports?.includes(port) && route.config.protocols.includes(protocol))?.config;
    }
    findRaw(ip: string, protocol: number): GatewayRoute | undefined {
        return this.routes.find(route => route.addresses.includes(ip) && route.config.protocols.includes("raw") && route.config.ipProtocols?.includes(protocol))?.config;
    }
    async resolve(request: ResolveRequest): Promise<ResolveResult> {
        if (!request || typeof request.host !== "string" || !request.host || request.host.length > 253
            || ![0, 4, 6].includes(request.family)) throw new NetResolveError("NO_RECOVERY", "Invalid DNS request");
        const host = isIP(request.host) ? this.normalize(request.host) : normalizeHost(request.host);
        const selected = this.routes.filter(route => normalizeHost(route.config.host) === host
            || route.config.names?.some(name => normalizeHost(name) === host) || route.addresses.includes(host));
        if (!selected.length) throw new NetResolveError("ACCESS_DENIED", "Name is not a configured gateway destination");
        try { await Promise.all(selected.map(route => this.resolveRoute(route))); } catch (error) { throw resolveFailure(error); }
        const addresses = [...new Set(selected.flatMap(route => route.addresses))].filter(address => !request.family || isIP(address) === request.family);
        if (!addresses.length) throw new NetResolveError("NO_DATA", "Configured gateway has no address in this family");
        return { canonicalName: selected[0].config.names?.[0] ?? selected[0].config.host,
            addresses: addresses.map(address => isIP(address) === 6
                ? { address: formatIpv6(parseIpv6(address)!), family: 6 as const, node: Array.from(this.ipv6Nodes.get(address)!), ...this.scope(address) }
                : { address, family: 4 as const }) };
    }
}

interface GatewayUdpSocket {
    on(event: "error", listener: (error: Error) => void): unknown;
    on(event: "message", listener: (bytes: Uint8Array) => void): unknown;
    connect(port: number, host: string, callback: (error?: Error) => void): void;
    send(bytes: Uint8Array, callback: (error?: Error | null) => void): unknown;
    close(): void;
}
interface UdpFlow {
    socket: GatewayUdpSocket; connected: boolean; pending: Uint8Array[]; bytes: number; packets: number; seen: number;
    node: Uint8Array; localPort: number; remotePort: number; proto: number; bindingGeneration?: number; closed: boolean; release:()=>void;
}
interface NativeTcpSocket {
    readonly readableLength: number;
    on(event: "connect" | "readable" | "end" | "close", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    setNoDelay(enabled: boolean): unknown;
    setKeepAlive(enabled: boolean): unknown;
    connect(port: number, host: string): void;
    read(length: number): Buffer | null;
    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean;
    end(callback?: () => void): unknown;
    destroy(): unknown;
}
interface TcpFlow {
    socket: NativeTcpSocket; node: Uint8Array; localPort: number; remotePort: number; proto: number;
    clientId: number; serverId: number; remoteCredit: number; writeCredit: number;
    connected: boolean; sentFin: boolean; receivedFin: boolean; closed: boolean;
    bindingGeneration?: number; released: boolean; writeFinished: boolean;
    timer: ReturnType<typeof setTimeout>; release:()=>void;
}
export class NativeGateway {
    private readonly udp = new Map<string, UdpFlow>();
    private readonly tcp = new Map<string, TcpFlow>();
    private readonly raw: RawEchoGateway;
    // One bounded port/protocol address space per authenticated participant. A
    // released generation is a tombstone until disconnect, so late frames cannot
    // recreate its native resource after the guest has reused the port.
    private readonly bindings = new Map<number, { generation: number; released: boolean }>();
    private nextId = 1;
    private readonly nativeOwner={};
    private closed = false;
    private sweep: ReturnType<typeof setInterval> | undefined;
    constructor(private readonly routes: GatewayRoutes, private readonly emit: (frame: Uint8Array<ArrayBuffer>, reliable: boolean, bindingGeneration?: number) => boolean,
        private readonly reportError: (error: { node: number[]; localPort: number; remotePort: number; proto: number; code: number; bindingGeneration?: number }) => void = () => {},
        guestNode: Uint8Array = Uint8Array.of(2, 0, 0, 0, 0, 1)) { this.raw = new RawEchoGateway(routes, emit, reportError, guestNode, this.nativeOwner); }
    private startSweep(): void {
        if (this.sweep) return;
        this.sweep = setInterval(() => {
            const deadline = Date.now() - (this.routes.options.udpIdleTimeoutMs ?? 60_000);
            for (const [key, flow] of this.udp) if (flow.seen < deadline) this.closeUdp(key, flow);
        }, 1000);
        this.sweep.unref();
    }
    handle(datagram: DecodedDatagram): boolean {
        if (!isExternalNode(datagram.node)) return false;
        if (this.closed || !this.acceptBinding(datagram)) return true;
        if (datagram.proto === PROTO_UDP || datagram.proto === PROTO_UDP6) this.sendUdp(datagram);
        else if (isTcpProtocol(datagram.proto)) this.sendTcp(datagram);
        else if (isRawProtocol(datagram.proto)) this.raw.handle(datagram);
        return true;
    }
    private acceptBinding(datagram: DecodedDatagram): boolean {
        const generation = datagram.bindingGeneration, key = datagram.proto * 65536 + datagram.srcPort;
        const previous = this.bindings.get(key);
        // Untagged clients retain legacy behavior until this binding first opts
        // into generation tracking. They cannot revive a tracked tombstone.
        if (generation === undefined) return !previous;
        if (!validBindingGeneration(generation)) return false;
        if (previous && (generation < previous.generation || (generation === previous.generation && previous.released))) return false;
        if (!previous || generation > previous.generation) {
            this.retirePort(datagram.proto, datagram.srcPort, generation);
            this.bindings.set(key, { generation, released: false });
        }
        return true;
    }
    releasePort(proto: number, port: number, generation: number): void {
        if (this.closed || !isProtocol(proto) || !validPort(port) || !validBindingGeneration(generation)) return;
        const key = proto * 65536 + port, previous = this.bindings.get(key);
        if (previous && generation < previous.generation) return;
        this.bindings.set(key, { generation, released: true });
        this.retirePort(proto, port, generation);
    }
    private retirePort(proto: number, port: number, generation: number): void {
        for (const [key, flow] of this.udp) if (flow.proto === proto && flow.localPort === port
            && (flow.bindingGeneration === undefined || flow.bindingGeneration <= generation)) this.closeUdp(key, flow);
        for (const [key, flow] of this.tcp) if (flow.proto === proto && flow.localPort === port
            && (flow.bindingGeneration === undefined || flow.bindingGeneration <= generation)) {
            if (!flow.receivedFin) { this.closeTcp(key, flow); continue; }
            if (flow.released) continue;
            flow.released = true;
            clearTimeout(flow.timer);
            if (flow.writeFinished) this.closeTcp(key, flow);
            else {
                // DATA callbacks and end's completion establish that the native
                // send queue accepted the complete prefix and FIN before close.
                flow.timer = setTimeout(() => this.closeTcp(key, flow), this.routes.options.connectTimeoutMs ?? 10000);
                flow.timer.unref();
            }
        }
        this.raw.releasePort(proto, port, generation);
    }
    close(): void {
        if (this.closed) return;
        this.closed = true; clearInterval(this.sweep); this.raw.close(); this.bindings.clear();
        for (const [key, flow] of this.udp) this.closeUdp(key, flow);
        for (const [key, flow] of this.tcp) this.closeTcp(key, flow);
    }
    private closeUdp(key: string, flow: UdpFlow): void {
        if (flow.closed) return;
        flow.closed = true; flow.release(); flow.pending.length = 0; flow.bytes = 0; this.udp.delete(key);
        if (!this.udp.size) { clearInterval(this.sweep); this.sweep = undefined; }
        try { flow.socket.close(); } catch (error) {
            if ((error as { code?: string }).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
        }
    }
    private sendUdp(datagram: DecodedDatagram): void {
        const ip = this.routes.addressForNode(datagram.node) ?? "";
        const route = this.routes.find(ip, datagram.dstPort, "udp");
        if (!route) {
            this.reportError({ node: Array.from(datagram.node), localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto, bindingGeneration: datagram.bindingGeneration, code: 10013 });
            return;
        }
        const key = datagram.proto + ":" + datagram.srcPort + ":" + nodeKey(datagram.node) + ":" + datagram.dstPort + ":" + (datagram.bindingGeneration ?? "legacy");
        let flow = this.udp.get(key);
        if (!flow) {
            if (this.udp.size >= (this.routes.options.maxUdpFlows ?? 128)) return;
            let lease:{host:string;release:()=>void};
            try {lease=this.routes.acquireNative(route,ip,this.nativeOwner);}
            catch(error){this.reportError({node:[...datagram.node],localPort:datagram.srcPort,remotePort:datagram.dstPort,proto:datagram.proto,bindingGeneration:datagram.bindingGeneration,code:socketError(error)});return;}
            const nativeHost=lease.host;
            const family = isIP(nativeHost) === 6 || (!isIP(nativeHost) && isIP(ip) === 6) ? 6 : 4;
            if (nativeHost.includes("%") && !this.routes.options.nativeHelperPath) {
                lease.release();
                this.reportError({ node: Array.from(datagram.node), localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto, bindingGeneration: datagram.bindingGeneration, code: 10045 });
                return;
            }
            const socket: GatewayUdpSocket = nativeHost.includes("%")
                ? new NativeUdpSocket(this.routes.options.nativeHelperPath!, family) : createSocket(family === 6 ? "udp6" : "udp4");
            flow = { socket, connected: false, pending: [], bytes: 0, packets: 0, seen: Date.now(),
                node: datagram.node.slice(), localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto, bindingGeneration: datagram.bindingGeneration, closed: false, release:lease.release };
            const current = flow;
            this.udp.set(key, flow); this.startSweep();
            socket.on("error", error => {
                if (current.closed) return;
                this.reportError({ node: Array.from(current.node), localPort: current.localPort, remotePort: current.remotePort,
                    proto: current.proto, bindingGeneration: current.bindingGeneration, code: socketError(error) === 10061 ? 10054 : socketError(error) });
                this.closeUdp(key, current);
            });
            socket.on("message", bytes => {
                if (!current.closed && bytes.length <= maxPayload(current.proto)) {
                    current.seen = Date.now();
                    this.emit(encodeDatagram(current.proto, current.node, current.localPort, current.remotePort, bytes), false, current.bindingGeneration);
                }
            });
            socket.connect(datagram.dstPort, nativeHost, error => {
                if (current.closed) return;
                if (error) {
                    this.reportError({ node: Array.from(current.node), localPort: current.localPort, remotePort: current.remotePort, proto: current.proto, bindingGeneration: current.bindingGeneration, code: socketError(error) });
                    this.closeUdp(key, current); return;
                }
                current.connected = true;
                for (const payload of current.pending.splice(0)) this.writeUdp(key, current, payload);
            });
        }
        if (flow.bytes + datagram.payload.length > TCP_WINDOW || flow.packets >= 128) return;
        flow.seen = Date.now(); flow.bytes += datagram.payload.length; flow.packets++;
        if (flow.connected) this.writeUdp(key, flow, datagram.payload.slice());
        else flow.pending.push(datagram.payload.slice());
    }
    private writeUdp(key: string, flow: UdpFlow, payload: Uint8Array): void {
        if (flow.closed) return;
        const complete = (error?: Error | null) => {
            if (flow.closed) return;
            flow.bytes -= payload.length; flow.packets--;
            if (error) {
                this.reportError({ node: Array.from(flow.node), localPort: flow.localPort, remotePort: flow.remotePort, proto: flow.proto, bindingGeneration: flow.bindingGeneration, code: socketError(error) === 10061 ? 10054 : socketError(error) });
                this.closeUdp(key, flow);
            }
        };
        try { flow.socket.send(payload, complete); } catch (error) { complete(error as Error); }
    }
    private tcpKey(datagram: DecodedDatagram, clientId: number): string {
        return datagram.proto + ":" + datagram.srcPort + ":" + nodeKey(datagram.node) + ":" + datagram.dstPort + ":" + clientId + ":" + (datagram.bindingGeneration ?? "legacy");
    }
    private sendTcp(datagram: DecodedDatagram): void {
        const packet = decodeTcpFrame(datagram.payload);
        if (!packet || !packet.srcId) return;
        const key = this.tcpKey(datagram, packet.srcId);
        let flow = this.tcp.get(key);
        if (packet.kind === SYN && !packet.dstId) {
            if (flow) {
                if (flow.connected) this.reply(flow, SYNACK, TCP_WINDOW);
                return;
            }
            const ip = this.routes.addressForNode(datagram.node) ?? "";
            const route = this.routes.find(ip, datagram.dstPort, "tcp");
            const requiresHelper = !!(packet.value & SYN_INLINE_FLAG);
            if (!route || (requiresHelper && !this.routes.options.nativeHelperPath) || this.tcp.size >= (this.routes.options.maxTcpConnections ?? 128)) {
                this.emit(encodeDatagram(datagram.proto, datagram.node, datagram.srcPort, datagram.dstPort,
                    encodeTcpFrame(RST, 0, packet.srcId, !route ? 10013 : requiresHelper && !this.routes.options.nativeHelperPath ? 10045 : 10055)), true, datagram.bindingGeneration);
                return;
            }
            let lease:{host:string;release:()=>void};
            try {lease=this.routes.acquireNative(route,ip,this.nativeOwner);}
            catch(error){this.emit(encodeDatagram(datagram.proto,datagram.node,datagram.srcPort,datagram.dstPort,encodeTcpFrame(RST,0,packet.srcId,socketError(error))),true,datagram.bindingGeneration);return;}
            const socket: NativeTcpSocket = this.routes.options.nativeHelperPath ? new NativeHelperSocket(this.routes.options.nativeHelperPath, requiresHelper) : new NativeSocket({ allowHalfOpen: true });
            socket.setNoDelay(!!(packet.value & SYN_NODELAY_FLAG));
            socket.setKeepAlive(!!(packet.value & SYN_KEEPALIVE_FLAG));
            flow = { socket, node: datagram.node.slice(), localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto,
                clientId: packet.srcId, serverId: this.nextId++, remoteCredit: Math.min(TCP_WINDOW, packet.value & SYN_WINDOW_MASK), writeCredit: TCP_WINDOW,
                connected: false, sentFin: false, receivedFin: false, closed: false, release:lease.release,
                bindingGeneration: datagram.bindingGeneration, released: false, writeFinished: false,
                timer: setTimeout(() => { if (flow) this.abortTcp(key, flow, 10060); }, this.routes.options.connectTimeoutMs ?? 10_000) };
            const current = flow;
            this.tcp.set(key, flow);
            socket.on("connect", () => {
                if (current.closed) return;
                current.connected = true; clearTimeout(current.timer);
                if (!this.reply(current, SYNACK, TCP_WINDOW)) this.closeTcp(key, current);
                this.pumpTcp(key, current);
            });
            socket.on("readable", () => this.pumpTcp(key, current));
            socket.on("end", () => {
                if (!current.closed) { current.sentFin = true; this.reply(current, FIN); }
            });
            socket.on("error", error => this.abortTcp(key, current, socketError(error)));
            socket.on("close", () => {
                if (!current.closed && !(current.sentFin && current.receivedFin)) this.reply(current, RST, 10054);
                this.closeTcp(key, current);
            });
            socket.connect(datagram.dstPort, lease.host);
            return;
        }
        if (!flow || flow.closed) return;
        // Cancellation before SYNACK has no peer id yet. The verified participant,
        // local port and monotonically unique client id already identify its flow.
        if (packet.kind === RST && (!packet.dstId || packet.dstId === flow.serverId)) { this.closeTcp(key, flow); return; }
        // A local option may change while connect is pending, before the guest
        // knows our server id. The verified binding and monotonic client id still
        // identify this flow; DATA and credit retain their established-id check.
        if (packet.kind === TCP_OPTION && (!packet.dstId || packet.dstId === flow.serverId)) { this.applyTcp(key, flow, packet); return; }
        if (packet.dstId !== flow.serverId) return;
        if (!flow.connected) return;
        this.applyTcp(key, flow, packet);
    }
    private applyTcp(key: string, flow: TcpFlow, packet: TcpFrame): void {
        if (packet.kind === TCP_OPTION) {
            if (packet.data.length || ![0, 1, TCP_OPTION_KEEPALIVE, TCP_OPTION_KEEPALIVE | 1, TCP_OPTION_NODELAY, TCP_OPTION_NODELAY | 1].includes(packet.value)) {
                this.abortTcp(key, flow, 10022); return;
            }
            const option = packet.value & ~1, enabled = !!(packet.value & 1);
            if (option === TCP_OPTION_KEEPALIVE) flow.socket.setKeepAlive(enabled);
            else if (option === TCP_OPTION_NODELAY) flow.socket.setNoDelay(enabled);
            else {
                if (!(flow.socket instanceof NativeHelperSocket)) { this.abortTcp(key, flow, 10045); return; }
                flow.socket.setOobInline(enabled);
            }
        } else if (packet.kind === CREDIT) {
            if (packet.value > TCP_WINDOW - flow.remoteCredit) { this.abortTcp(key, flow, 10054); return; }
            flow.remoteCredit += packet.value; this.pumpTcp(key, flow);
        } else if (packet.kind === DATA) {
            if (flow.receivedFin || !packet.data.length || packet.data.length > flow.writeCredit) { this.abortTcp(key, flow, 10054); return; }
            flow.writeCredit -= packet.data.length;
            flow.socket.write(packet.data, error => {
                if (flow.closed) return;
                if (error) { this.abortTcp(key, flow, socketError(error)); return; }
                flow.writeCredit += packet.data.length;
                if (!this.reply(flow, CREDIT, packet.data.length)) this.closeTcp(key, flow);
            });
        } else if (packet.kind === FIN) {
            if (!flow.receivedFin) {
                flow.receivedFin = true;
                flow.socket.end(() => { flow.writeFinished = true; if (flow.released) this.closeTcp(key, flow); });
            }
        } else if (packet.kind === OOB) {
            if (!(flow.socket instanceof NativeHelperSocket)) { this.abortTcp(key, flow, 10045); return; }
            if (flow.receivedFin || packet.data.length !== 1 || !flow.writeCredit) { this.abortTcp(key, flow, 10054); return; }
            flow.writeCredit--;
            flow.socket.sendUrgent(packet.data[0], error => {
                if (flow.closed) return;
                if (error) { this.abortTcp(key, flow, socketError(error)); return; }
                flow.writeCredit++;
                if (!this.reply(flow, CREDIT, 1)) this.closeTcp(key, flow);
            });
        }
    }
    private pumpTcp(key: string, flow: TcpFlow): void {
        if (!flow.connected || flow.closed || flow.released || !flow.remoteCredit) return;
        while (flow.remoteCredit && (flow.socket.readableLength || (flow.socket instanceof NativeHelperSocket && flow.socket.urgentReady))) {
            if (flow.socket instanceof NativeHelperSocket) {
                const byte = flow.socket.takeUrgent();
                if (byte !== null) {
                    flow.remoteCredit--;
                    if (!this.reply(flow, OOB, 0, Uint8Array.of(byte))) { this.closeTcp(key, flow); return; }
                    continue;
                }
            }
            const beforeUrgent = flow.socket instanceof NativeHelperSocket ? flow.socket.bytesBeforeUrgent() : TCP_SEGMENT;
            const bytes: Buffer | null = flow.socket.read(Math.min(TCP_SEGMENT, flow.remoteCredit, flow.socket.readableLength, beforeUrgent));
            if (!bytes) break;
            flow.remoteCredit -= bytes.length;
            if (!this.reply(flow, DATA, 0, bytes)) { this.closeTcp(key, flow); return; }
        }
        flow.socket.read(0);
    }
    private reply(flow: TcpFlow, kind: number, value = 0, data?: Uint8Array): boolean {
        if (flow.released) return true;
        return this.emit(encodeDatagram(flow.proto, flow.node, flow.localPort, flow.remotePort,
            encodeTcpFrame(kind, flow.serverId, flow.clientId, value, data)), true, flow.bindingGeneration);
    }
    private abortTcp(key: string, flow: TcpFlow, code: number): void {
        if (flow.closed) return;
        this.reply(flow, RST, code); this.closeTcp(key, flow);
    }
    private closeTcp(key: string, flow: TcpFlow): void {
        if (flow.closed) return;
        flow.closed = true; flow.release(); clearTimeout(flow.timer); this.tcp.delete(key); flow.socket.destroy();
    }
}
