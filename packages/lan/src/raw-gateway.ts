import type { GatewayRoutes } from "./gateway";
import { GenericRawGateway } from "./raw-generic";
import { RawUdpGateway } from "./raw-udp";
import { NativeRawSocket } from "./native-raw";
import { echoIdentifier, translateEcho, rewriteIpv4Header, setIcmpv6Checksum } from "./icmp-nat";
import { encodeDatagram, nodeKey, nodeToIpv4, PROTO_RAW4, rawHeaderLength, RAW_FLAG_OPTIONS, type DecodedDatagram } from "./protocol";
import { LAN_IPV6_PREFIX, parseIpv6 } from "./ip-address";

interface RawFlow {
    socket: NativeRawSocket; node: Uint8Array; localPort: number; proto: number; family: 4 | 6;
    originalId: number; nativeId: number; headerIncluded: boolean; bindingGeneration?: number; seen: number; closed: boolean; release:()=>void;
}
type SocketError = { node: number[]; localPort: number; remotePort: number; proto: number; code: number; bindingGeneration?: number };
/** Echo NAT is deliberately separate from unfiltered host raw capture. */
export class RawEchoGateway {
    private readonly flows = new Map<string, RawFlow>();
    private readonly generic:GenericRawGateway;
    private readonly udp:RawUdpGateway;
    private sweep: ReturnType<typeof setInterval> | undefined;
    constructor(private readonly routes: GatewayRoutes,
        private readonly emit: (frame: Uint8Array<ArrayBuffer>, reliable: boolean, bindingGeneration?: number) => boolean,
        private readonly report: (error: SocketError) => void, private readonly guestNode: Uint8Array, private readonly nativeOwner:object={}) {
        this.udp=new RawUdpGateway(routes,emit,report,guestNode,nativeOwner,()=>this.flows.size+this.generic.size);
        this.generic=new GenericRawGateway(routes,emit,report,guestNode,nativeOwner,()=>this.flows.size+this.udp.size,(host,packet,family)=>this.udp.ownsPacket(host,packet,family));
    }
    handle(datagram: DecodedDatagram): void {
        const family = datagram.proto === PROTO_RAW4 ? 4 : 6, protocol = datagram.payload[0], included = !!(datagram.payload[1] & 1);
        const socketProtocol = datagram.srcPort - 1, packet = datagram.payload.subarray(rawHeaderLength(datagram.payload));
        const reject = (code: number) => this.report({ node: Array.from(datagram.node), localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto, bindingGeneration: datagram.bindingGeneration, code });
        if (datagram.dstPort !== protocol + 1 || (!included && socketProtocol !== protocol)) { reject(10022); return; }
        // Native RAW6 receive has no next-header metadata. Wildcard or differing
        // socket protocols cannot be classified safely from payload bytes.
        if(family===6&&(socketProtocol===0||socketProtocol===255||socketProtocol!==protocol)){reject(10045);return;}
        const ip = this.routes.addressForNode(datagram.node) ?? "", route = this.routes.findRaw(ip, protocol);
        if (!route) { reject(10013); return; }
        if (!this.routes.options.nativeHelperPath) { reject(10045); return; }
        if(route.rawMode==="exclusive"){this.generic.handle(datagram,route,ip);return;}
        if(protocol===17&&socketProtocol===17){this.udp.handle(datagram,route,ip);return;}
        const echoProtocol = family === 4 ? 1 : 58;
        if (protocol !== echoProtocol) { this.generic.handle(datagram,route,ip); return; }
        const originalId = echoIdentifier(packet, family, included, false);
        if (originalId === null) { this.generic.handle(datagram,route,ip); return; }
        const key = datagram.proto + ":" + datagram.srcPort + ":" + nodeKey(datagram.node) + ":" + originalId + ":" + +included + ":" + (datagram.bindingGeneration ?? "legacy");
        let flow = this.flows.get(key);
        if (!flow) {
            if (this.flows.size + this.generic.size + this.udp.size >= (this.routes.options.maxRawFlows ?? 64)) { reject(10055); return; }
            let lease:{host:string;release:()=>void};
            try {lease=this.routes.acquireNative(route,ip,this.nativeOwner);}
            catch(error){reject((error as {code?:number}).code??10054);return;}
            const nativeId = this.routes.allocateEchoId();
            if (!nativeId) { lease.release(); reject(10055); return; }
            const socket = new NativeRawSocket(this.routes.options.nativeHelperPath);
            flow = { socket, node: datagram.node.slice(), localPort: datagram.srcPort, proto: datagram.proto, family, originalId, nativeId, headerIncluded: included, bindingGeneration: datagram.bindingGeneration, seen: Date.now(), closed: false, release:lease.release };
            const current = flow; this.flows.set(key, flow);
            socket.on("error", (error: Error & { code?: number }) => {
                if (current.closed) return;
                reject(typeof error.code === "number" && error.code >= 10000 ? error.code : 10054); this.closeFlow(key, current);
            });
            socket.on("message", (bytes: Uint8Array) => {
                if (current.closed || echoIdentifier(bytes, current.family, current.family === 4, true) !== current.nativeId) return;
                const reply = translateEcho(bytes, current.family, current.family === 4, current.originalId);
                if (current.family === 4) rewriteIpv4Header(reply, nodeToIpv4(current.node), nodeToIpv4(this.guestNode));
                else {
                    const source = parseIpv6(this.routes.addressForNode(current.node) ?? "");
                    const destination = new Uint8Array(16); destination.set(LAN_IPV6_PREFIX); destination.set(this.guestNode, 10);
                    if (!source) return;
                    setIcmpv6Checksum(reply, source, destination);
                }
                const payload = new Uint8Array(reply.length + 2); payload[0] = echoProtocol; payload[1] = current.family === 4 ? 1 : 0; payload.set(reply, 2);
                current.seen = Date.now();
                this.emit(encodeDatagram(current.proto, current.node, current.localPort, echoProtocol + 1, payload), false, current.bindingGeneration);
            });
            socket.connect(lease.host, family, socketProtocol, included);
            socket.setIpOptions(128,0);this.startSweep();
        }
        flow.seen = Date.now();
        const current = flow;
        if (datagram.payload[1] & RAW_FLAG_OPTIONS) flow.socket.setIpOptions(new DataView(datagram.payload.buffer, datagram.payload.byteOffset).getInt16(2, true), datagram.payload[4]);
        if (!flow.socket.send(translateEcho(packet, family, included, flow.nativeId), error => {
            if (error && !current.closed) { reject((error as { code?: number }).code ?? 10054); this.closeFlow(key, current); }
        })) reject(10055);
    }
    private startSweep(): void {
        if (this.sweep) return;
        this.sweep = setInterval(() => {
            const deadline = Date.now() - (this.routes.options.udpIdleTimeoutMs ?? 60000);
            for (const [key, flow] of this.flows) if (flow.seen < deadline) this.closeFlow(key, flow);
        }, 1000); this.sweep.unref();
    }
    private closeFlow(key: string, flow: RawFlow): void {
        if (flow.closed) return;
        flow.closed = true; flow.release(); this.flows.delete(key); this.routes.releaseEchoId(flow.nativeId); flow.socket.close();
        if (!this.flows.size) { clearInterval(this.sweep); this.sweep = undefined; }
    }
    releasePort(proto: number, port: number, generation: number): void {
        this.udp.releasePort(proto, port, generation); this.generic.releasePort(proto, port, generation);
        for (const [key, flow] of this.flows) if (flow.proto === proto && flow.localPort === port
            && (flow.bindingGeneration === undefined || flow.bindingGeneration <= generation)) this.closeFlow(key, flow);
    }
    close(): void { this.udp.close();this.generic.close(); for (const [key, flow] of this.flows) this.closeFlow(key, flow); }
}
