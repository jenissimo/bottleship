import { normalizeNetworkConfig, type NetworkConfig } from "../../network-config";
import { LanNetwork, type LanPortRegistry, type NetTransport, type LanState, type LanSocketError, type LanPortDisconnect, type RawDeliveryTarget } from "../net/lan-network";
import { RelayLink } from "../net/relay-link";
import { UdpHostLeaseRpc, type UdpHostLease } from "../net/udp-host-lease-rpc";
import type { UdpBindingRequest } from "../net/udp-binding-lease-rpc";
import { validUdpHostOpenRequest, type UdpHostOpenRequest } from "../net/netplay-wire";
import { UdpPeerLeaseRpc, udpLeaseError } from "../net/udp-peer-lease-rpc";
import { type UdpPeerLeaseRequest, validPort, isExternalIpv4Node, isExternalIpv6Node } from "../net/netplay-wire";
import { decodeDatagram, encodeDatagram, isBroadcastNode, isMulticastIpv4Node, MAX_FRAME_SIZE, NetResolveError,
    type ResolveRequest, type ResolveResult, PROTO_UDP, PROTO_UDP6, PROTO_RAW4, validBindingGeneration, isDatagramProtocol, isTcpProtocol, isRawProtocol, parseIpv6, type GatewayIpv6Address, decodeTcpFrame, encodeTcpFrame, RST, SYN, SYNACK, FIN } from "../net/netplay-wire";

const PORTS = 8 * 65536, WORDS = PORTS / 32, HEADER = 16, META = 8;
const MAX_BYTES = 1024 * 1024, MAX_FRAMES = 256;
// Published by the broker before connected=1; process snapshots are asynchronous.
const MULTICAST4_CAPABILITY = 2, STATE_REVISION = 14, STATE_LENGTH = 15;
// Validated ready metadata fits below 1 MiB: 4096 IPv4 + 4096 IPv6
// addresses, 32 listeners with 32 ACL nodes each, and the small DP8 policy.
// Keep the physical registry offsets unchanged; the bounded snapshot follows it.
const STATE_BYTES = 1024 * 1024;
export interface NetworkNamespaceBoot { shared: SharedArrayBuffer; capacity: number; slot: number; epoch: number; pid: number; port: MessagePort }
export interface NamespaceProcess {pid:number;slot:number;epoch:number}
export interface SocketActorClient extends NamespaceProcess {port:MessagePort}
export interface ChildNetworkNamespace { boot: NetworkNamespaceBoot; close(): void }
export interface ProcessNetworkNamespace {
    readonly network: LanNetwork;
    configure(config: NetworkConfig | null): Promise<void>;
    barrier(): Promise<void>;
    createChild(pid?:number): ChildNetworkNamespace;
    beginProcessLifetime():void;
    finishProcessLifetime():Promise<void>;
    socketActorClient():SocketActorClient;
    dropSocketActorClient():void;
    close(): void | Promise<void>;
}
class AtomicPorts {
    readonly header: Int32Array;
    readonly meta: Int32Array;
    readonly locks: Int32Array;
    readonly modes: Int32Array;
    readonly generations:Int32Array;
    readonly bits: Int32Array;
    private readonly stateBytes: Uint8Array;
    constructor(readonly shared: SharedArrayBuffer, readonly capacity: number) {
        if (!Number.isInteger(capacity) || capacity < 2 || capacity > 1024
            || shared.byteLength !== (HEADER + capacity * META + PORTS * 3 + capacity * WORDS) * 4 + STATE_BYTES) throw new Error("Invalid shared network registry");
        this.header = new Int32Array(shared, 0, HEADER);
        this.meta = new Int32Array(shared, HEADER * 4, capacity * META);
        const offset = HEADER + capacity * META;
        this.locks = new Int32Array(shared, offset * 4, PORTS);
        this.modes = new Int32Array(shared, (offset + PORTS) * 4, PORTS);
        this.generations=new Int32Array(shared,(offset+PORTS*2)*4,PORTS);
        this.bits = new Int32Array(shared, (offset + PORTS * 3) * 4, capacity * WORDS);
        this.stateBytes = new Uint8Array(shared, (HEADER + capacity * META + PORTS * 3 + capacity * WORDS) * 4, STATE_BYTES);
    }
    publishState(state: LanState): boolean {
        const bytes = new TextEncoder().encode(JSON.stringify({...state, node: Array.from(state.node), ipv4: Array.from(state.ipv4)}));
        if (bytes.length > STATE_BYTES) return false;
        // Only the broker writes. Readers never wait for it or observe online
        // with a half-written readiness snapshot.
        Atomics.store(this.header, 1, 0);
        const previous = Atomics.load(this.header, STATE_REVISION) >>> 0;
        const revision = ((previous + 2) >>> 0) || 2;
        Atomics.store(this.header, STATE_REVISION, (revision - 1) | 0);
        this.stateBytes.set(bytes);
        Atomics.store(this.header, STATE_LENGTH, bytes.length);
        Atomics.store(this.header, MULTICAST4_CAPABILITY, state.connected && state.udpMulticast4V1 === true ? 1 : 0);
        Atomics.store(this.header, STATE_REVISION, revision | 0);
        Atomics.store(this.header, 1, state.connected ? 1 : 0);
        return true;
    }
    stateSnapshot(): {revision: number; state: LanState} | undefined {
        // A busy writer makes this operation temporarily unavailable. Bounded
        // retries keep synchronous guest APIs from blocking a worker event loop.
        for (let attempt = 0; attempt < 3; attempt++) {
            const revision = Atomics.load(this.header, STATE_REVISION) >>> 0;
            if (!revision || (revision & 1)) return;
            const length = Atomics.load(this.header, STATE_LENGTH);
            if (length < 1 || length > STATE_BYTES) return;
            const bytes = this.stateBytes.slice(0, length);
            if (revision !== (Atomics.load(this.header, STATE_REVISION) >>> 0)) continue;
            const value = JSON.parse(new TextDecoder().decode(bytes));
            return {revision, state: {...value, node: Uint8Array.from(value.node), ipv4: Uint8Array.from(value.ipv4)}};
        }
    }
    static create(node: Uint8Array, capacity: number, pid:number): AtomicPorts {
        const result = new AtomicPorts(new SharedArrayBuffer((HEADER + capacity * META + PORTS * 3 + capacity * WORDS) * 4 + STATE_BYTES), capacity);
        result.header[0] = 1;result.header[12]=1; result.meta[0] = 1; result.meta[1] = -1; result.meta[6]=pid;result.meta[7]=1;
        for (let i = 0; i < 6; i++) result.header[4 + i] = node[i];
        return result;
    }
    get node(): Uint8Array { return Uint8Array.from(this.header.subarray(4, 10)); }
    alive(slot: number, epoch?: number): boolean {
        const value = Atomics.load(this.meta, slot * META);
        return value > 0 && (epoch === undefined || value === epoch);
    }
    allocate(parent: number,pid?:number,service=false): { slot: number; epoch: number;pid:number } {
        if(pid===undefined){const serial=Atomics.add(this.header,11,1);pid=0x70000000+serial;if(pid>0x7fffffff)throw new Error("Process network PID space exhausted");}
        if(!Number.isInteger(pid)||pid<(service?0:1)||pid>0x7fffffff)throw new Error("Invalid namespace PID");
        for (let slot = 1; slot < this.capacity; slot++) {
            const epoch = Atomics.add(this.header, 0, 1) + 1;
            if (Atomics.compareExchange(this.meta, slot * META, 0, epoch) !== 0) continue;
            Atomics.store(this.meta, slot * META + 1, parent);
            Atomics.store(this.meta,slot*META+7,this.nextProcessEpoch());
            Atomics.store(this.meta,slot*META+6,pid);
            return { slot, epoch,pid };
        }
        throw new Error("Process network namespace is full");
    }
    private nextProcessEpoch():number{
        for(;;){const previous=Atomics.load(this.header,12);if(previous>=0x7fffffff)throw new Error("Process incarnation space exhausted");
            if(Atomics.compareExchange(this.header,12,previous,previous+1)===previous)return previous+1;}
    }
    beginProcess(slot:number,pid:number):number{
        if(!this.alive(slot)||pid<1)throw new Error("Process namespace closed");
        const current=Atomics.load(this.meta,slot*META+6);
        if(current&&current!==pid)throw new Error("Authenticated process PID changed");
        if(!current){Atomics.store(this.meta,slot*META+7,this.nextProcessEpoch());Atomics.store(this.meta,slot*META+6,pid);}
        return Atomics.load(this.meta,slot*META+7);
    }
    processIdentity(slot:number,pid:number):NamespaceProcess{return {slot,pid,epoch:Atomics.load(this.meta,slot*META+7)};}
    private lock(index: number, actor: number): number {
        const token = Atomics.load(this.meta, actor * META);
        if (token <= 0) return 0;
        for (let attempt = 0; attempt < 100; attempt++) {
            const owner = Atomics.compareExchange(this.locks, index, 0, token);
            if (!owner) return token;
            let alive = false;
            for (let slot = 0; slot < this.capacity; slot++) if (Atomics.load(this.meta, slot * META) === owner) { alive = true; break; }
            if (!alive && Atomics.compareExchange(this.locks, index, owner, token) === owner) return token;
            Atomics.wait(this.locks, index, owner, 10);
        }
        return 0;
    }
    private unlock(index: number, token: number): void {
        Atomics.compareExchange(this.locks, index, token, 0); Atomics.notify(this.locks, index);
    }
    private owners(index: number): number[] {
        const owners: number[] = [], mask = 1 << (index & 31), word = index >>> 5;
        for (let slot = 0; slot < this.capacity; slot++) {
            if (!(Atomics.load(this.bits, slot * WORDS + word) & mask)) continue;
            if (this.alive(slot)) owners.push(slot);
            else Atomics.and(this.bits, slot * WORDS + word, ~mask);
        }
        if (!owners.length) Atomics.store(this.modes, index, 0);
        return owners;
    }
    generation(port:number,proto:number):number{return Atomics.load(this.generations,proto*65536+port)>>>0;}
    private nextBindingGeneration():number{
        for(;;){const previous=Atomics.load(this.header,13)>>>0;if(previous===0xffffffff)return 0;
            if(Atomics.compareExchange(this.header,13,previous|0,(previous+1)|0)===(previous|0))return previous+1;}
    }
    registry(slot: number, epoch: number, changed?: (port: number, proto: number, claimed: boolean,generation:number,last:boolean,deliveryGeneration:number) => void): LanPortRegistry {
        const deliveryGenerations = new Map<number, number>();
        let nextDeliveryGeneration = 1;
        return {
            deliveryGeneration: (port, proto) => deliveryGenerations.get(proto * 65536 + port) ?? 0,
            generation:(port,proto)=>this.generation(port,proto),
            allocateSocketId: () => {
                if (!this.alive(slot, epoch)) return 0;
                for (;;) {
                    const previous = Atomics.load(this.header, 10) >>> 0;
                    if (previous === 0xffffffff) return 0;
                    const id = previous + 1;
                    if (Atomics.compareExchange(this.header, 10, previous | 0, id | 0) === (previous | 0)) return id;
                }
            },
            claim: (port, proto, reuse = false) => {
                if (!this.alive(slot, epoch)) return false;
                const index = proto * 65536 + port;
                const token = this.lock(index, slot);
                if (!token) return false;
                let claimed = false,generation=0,deliveryGeneration=0;
                try {
                    if (!this.alive(slot, epoch) || nextDeliveryGeneration > 0xffffffff) return false;
                    const owners = this.owners(index);
                    if (owners.includes(slot) || (owners.length && (!reuse || Atomics.load(this.modes, index) !== 2))) return false;
                    generation=owners.length?this.generation(port,proto):this.nextBindingGeneration();if(!generation)return false;
                    deliveryGeneration = nextDeliveryGeneration++;
                    deliveryGenerations.set(index, deliveryGeneration);
                    Atomics.store(this.generations,index,generation|0);
                    Atomics.store(this.modes, index, reuse ? 2 : 1);
                    Atomics.or(this.bits, slot * WORDS + (index >>> 5), 1 << (index & 31));
                    claimed = true; return true;
                } finally { this.unlock(index, token); if (claimed) changed?.(port, proto, true,generation,false,deliveryGeneration); }
            },
            release: (port, proto) => {
                if (!this.alive(slot, epoch)) return;
                const index = proto * 65536 + port;
                const token = this.lock(index, slot);
                if (!token) throw new Error("Network port registry is busy");
                const generation=this.generation(port,proto),deliveryGeneration=deliveryGenerations.get(index)??0;let last=false;
                try {
                    Atomics.and(this.bits, slot * WORDS + (index >>> 5), ~(1 << (index & 31)));
                    last=this.owners(index).length===0;
                    deliveryGenerations.delete(index);
                } finally { this.unlock(index, token); changed?.(port, proto, false,generation,last,deliveryGeneration); }
            },
        };
    }
    targets(proto: number, port: number): number[] {
        const index = proto * 65536 + port, mask = 1 << (index & 31), word = index >>> 5;
        const result: number[] = [];
        for (let slot = 0; slot < this.capacity; slot++) if (this.alive(slot) && (Atomics.load(this.bits, slot * WORDS + word) & mask)) result.push(slot);
        return result;
    }
    ports(slot: number): { port: number; proto: number }[] {
        const ports: { port: number; proto: number }[] = [];
        for (let word = 0; word < WORDS; word++) {
            let bits = Atomics.load(this.bits, slot * WORDS + word) >>> 0;
            while (bits) {
                const bit = 31 - Math.clz32(bits & -bits), index = word * 32 + bit;
                ports.push({ proto: index >>> 16, port: index & 65535 });
                bits = (bits & (bits - 1)) >>> 0;
            }
        }
        return ports;
    }
    drop(slot: number, epoch: number): { port: number; proto: number;generation:number }[] {
        if (!this.alive(slot, epoch)) return [];
        const ports = this.ports(slot).map(item=>({...item,generation:this.generation(item.port,item.proto)}));
        if (Atomics.compareExchange(this.meta, slot * META, epoch, -epoch) !== epoch) return [];
        for (const { port, proto } of ports) {
            const index = proto * 65536 + port;
            const token = this.lock(index, 0);
            if (!token) throw new Error("Cannot release a process network port");
            try { this.owners(index); } finally { this.unlock(index, token); }
        }
        this.bits.fill(0, slot * WORDS, (slot + 1) * WORDS);
        for (let i = 1; i < META; i++) Atomics.store(this.meta, slot * META + i, 0);
        Atomics.store(this.meta, slot * META, 0);
        return ports;
    }
    reserve(slot: number, epoch: number, bytes: number, inbound: boolean): boolean {
        if (!this.alive(slot, epoch)) return false;
        const index = slot * META + (inbound ? 4 : 2);
        const total = Atomics.add(this.meta, index, bytes) + bytes;
        const frames = Atomics.add(this.meta, index + 1, 1) + 1;
        if (total <= MAX_BYTES && frames <= MAX_FRAMES) return true;
        Atomics.sub(this.meta, index, bytes); Atomics.sub(this.meta, index + 1, 1);
        return false;
    }
    release(slot: number, epoch: number, bytes: number, inbound: boolean): void {
        if (!this.alive(slot, epoch)) return;
        const index = slot * META + (inbound ? 4 : 2);
        Atomics.sub(this.meta, index, bytes); Atomics.sub(this.meta, index + 1, 1);
    }
}
export function readNetworkNamespaceProcesses(shared:SharedArrayBuffer,capacity:number):NamespaceProcess[]{
    const ports=new AtomicPorts(shared,capacity),result:NamespaceProcess[]=[];
    for(let slot=0;slot<capacity;slot++){
        const lease=Atomics.load(ports.meta,slot*META),pid=Atomics.load(ports.meta,slot*META+6),epoch=Atomics.load(ports.meta,slot*META+7);
        if(lease>0&&pid>0&&epoch>0&&Atomics.load(ports.meta,slot*META)===lease)result.push({pid,slot,epoch});
    }
    return result;
}
export function isNetworkNamespaceProcessLive(shared:SharedArrayBuffer,capacity:number,identity:NamespaceProcess):boolean{
    const ports=new AtomicPorts(shared,capacity),{slot,epoch,pid}=identity;
    if(!Number.isInteger(slot)||slot<0||slot>=capacity||epoch<1||pid<1)return false;
    const lease=Atomics.load(ports.meta,slot*META);
    return lease>0&&Atomics.load(ports.meta,slot*META+6)===pid&&Atomics.load(ports.meta,slot*META+7)===epoch&&ports.alive(slot,lease);
}
type PendingOutbound = { kind: "frame"; frame: Uint8Array; generation: number }
    | { kind: "release"; port: number; proto: number; generation: number; last: boolean };
interface UdpForward<R extends UdpBindingRequest = UdpPeerLeaseRequest> { request: R; cancel(): void }
interface Client {
    udpPeers: Map<number, UdpForward>;
    udpHosts: Map<number, UdpForward<UdpHostOpenRequest>>;
    pid:number;processEpoch:number;actorAttached:boolean;
    slot: number; epoch: number; port: MessagePort; parent: number; pending: PendingOutbound[]; flushing: boolean;
    dns: Map<number, AbortController>; knownPorts: Map<string,number>; deliveryGenerations: Map<string, number>;
    barriers: Map<number, ReturnType<typeof setTimeout>>;
}
interface TrackedTcp { slot: number; epoch: number; localPort: number; remotePort: number; proto: number; id: number; peerId: number; node: Uint8Array; fin: boolean; peerFin: boolean;bindingGeneration:number }
class Backplane extends LanNetwork {
    onFrame?: (frame: Uint8Array,generation?:number) => void;
    override receiveFrame(frame: Uint8Array,_allowLoopback=false,generation?:number): void { this.onFrame?.(frame,generation); }
}
export class RootNetworkNamespace implements ProcessNetworkNamespace {
    private readonly ports: AtomicPorts;
    private readonly backplane: Backplane;
    private readonly clients = new Map<number, Client>();
    private readonly tcp = new Map<string, TrackedTcp>();
    private active: { key: string; link: RelayLink } | null = null;
    private readonly rootUdpPeers = new Map<number, UdpForward>();
    private nextUdpPeer = 0;
    private readonly rootUdpHosts = new Map<number, UdpForward<UdpHostOpenRequest>>();
    private nextUdpHost = 0;
    private closed = false;
    private actor: {worker:Worker;control:MessagePort;lease:ChildNetworkNamespace;stopped:Promise<void>;terminated:boolean}|null=null;
    private actorClient:SocketActorClient|null=null;
    private actorFailure:Error|null=null;
    private closing:Promise<void>|null=null;
    private finishing:Promise<void>|null=null;
    private actorRequestId=0;
    private readonly actorRequests=new Map<number,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;reply:string}>();
    constructor(readonly network: LanNetwork, capacity = 256,readonly pid=1234) {
        if(!Number.isInteger(pid)||pid<1||pid>0x7fffffff)throw new Error("Invalid root namespace PID");
        this.ports = AtomicPorts.create(network.node, capacity,pid);
        this.backplane = new Backplane(network.node);
        this.ports.publishState({connected: false, node: network.node, ipv4: network.ipv4, generation: 0});
        this.backplane.onFrame = (frame,generation) => this.deliver(frame,generation);
        network.setPortRegistry(this.ports.registry(0, 1, (port, proto, claimed,generation,last) => { if (!claimed) { this.retireUdpForwards(this.rootUdpPeers, port, proto, generation); this.retireUdpForwards(this.rootUdpHosts, port, proto, generation); this.cancelTcpPort(0, 1, port, proto, generation); this.portLeft(port, proto,generation,last); } }));
        const local: NetTransport = {
            connected: false, routeLocal: true,
            connectionState: () => !this.closed && !!Atomics.load(this.ports.header, 1),
            supportsMulticast4: () => !this.closed && !!Atomics.load(this.ports.header, 1) && Atomics.load(this.ports.header, MULTICAST4_CAPABILITY) === 1,
            send: (frame,generation=0) => { this.trackTcp(0, 1, frame,generation); return this.route(frame,generation,null); },
            resolve: async (request, signal) => {
                const result = await this.backplane.resolve(request.host, request.family, signal);
                this.recordResolved(result); return result;
            },
            leaseUdpPeer: (request, signal) => this.forwardUdpPeer(null, ++this.nextUdpPeer, request, signal),
            openUdpHost: (request, signal) => this.forwardUdpHost(null, ++this.nextUdpHost, request, signal),
            close() {},
        };
        network.attach(local);
        this.backplane.onStateChange(state => {
            if (!state.connected) for (const [key, lease] of this.tcp) if (!this.network.isSelf(lease.node)) this.tcp.delete(key);
            this.state(state);
        });
        this.backplane.onPeerDisconnect(node => {
            for (const [key, lease] of this.tcp) if (lease.node.every((value, index) => value === node[index])) this.tcp.delete(key);
            this.broadcast("peer", node);
        });
        this.backplane.onSocketError(error => this.broadcast("socketError", error));
        this.backplane.onWritable(() => {
            this.flush();
            this.network.notifyWritable();
            for (const client of this.clients.values()) client.port.postMessage({ type: "writable" });
        });
        this.startSocketActor();
    }
    private startSocketActor():void{
        const identity=this.ports.allocate(0,0,true),networkChannel=new MessageChannel(),control=new MessageChannel();
        this.attach(networkChannel.port1,identity.slot,identity.epoch,0,true);
        const lease:ChildNetworkNamespace={boot:{...identity,shared:this.ports.shared,capacity:this.ports.capacity,port:networkChannel.port2},close:()=>this.drop(identity.slot,identity.epoch)};
        const worker=new Worker(new URL("../modules/wsa-actor-worker.ts",import.meta.url).href,{type:"module"});
        (worker as unknown as {unref?:()=>void}).unref?.();
        const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
        this.actor={worker,control:control.port1,lease,stopped,terminated:false};
        control.port1.onmessage=event=>{
            const message=event.data,pending=this.actorRequests.get(message?.id);
            if(!pending||message.type!==pending.reply)return;
            this.actorRequests.delete(message.id);clearTimeout(pending.timer);
            if(message.error)pending.reject(new Error(message.error));else pending.resolve();
        };control.port1.start();
        worker.addEventListener("error",event=>{
            event.preventDefault();this.actorFailure=new Error((event as ErrorEvent).message||"Winsock actor failed");
            this.failActorRequests(this.actorFailure);
            if(!this.closed){lease.close();control.port1.close();if(this.actor&&!this.actor.terminated){this.actor.terminated=true;worker.terminate();}}
        });
        worker.postMessage({type:"boot",network:lease.boot,control:control.port2,processes:readNetworkNamespaceProcesses(this.ports.shared,this.ports.capacity)},[lease.boot.port,control.port2]);
    }
    private failActorRequests(error:Error):void{
        for(const pending of this.actorRequests.values()){clearTimeout(pending.timer);pending.reject(error);}
        this.actorRequests.clear();
    }
    private actorRequest(type:"finish"|"barrier"|"shutdown",identity?:NamespaceProcess):Promise<void>{
        if(this.closed||this.actorFailure||!this.actor)return Promise.reject(this.actorFailure??new Error("Socket actor unavailable"));
        if(this.actorRequests.size>=32)return Promise.reject(new Error("Too many socket actor requests"));
        const id=++this.actorRequestId;
        return new Promise<void>((resolve,reject)=>{
            const timer=setTimeout(()=>{this.actorRequests.delete(id);reject(new Error("Socket actor drain timed out"));},type==="shutdown"?5000:15000);
            this.actorRequests.set(id,{resolve,reject,timer,reply:type==="finish"?"finished":type==="shutdown"?"shutdownDone":"barrierDone"});
            this.actor!.control.postMessage({type,id,...identity});
        });
    }
    beginProcessLifetime():void{
        if(this.finishing)throw new Error("Previous network process is still finishing");
        const epoch=this.ports.beginProcess(0,this.pid);this.actor?.control.postMessage({type:"process",pid:this.pid,slot:0,epoch});
    }
    finishProcessLifetime():Promise<void>{
        if(this.finishing)return this.finishing;
        if(Atomics.load(this.ports.meta,6)!==this.pid)return this.barrier();
        const identity=this.ports.processIdentity(0,this.pid);
        this.retireUdpForwards(this.rootUdpPeers); this.retireUdpForwards(this.rootUdpHosts);
        this.actorClient?.port.close();this.actorClient=null;
        const finish=this.actorRequest("finish",identity).then(()=>{
            if(this.ports.processIdentity(0,this.pid).epoch===identity.epoch)Atomics.compareExchange(this.ports.meta,6,this.pid,0);
            this.flush();
        });
        this.finishing=finish.finally(()=>{this.finishing=null;});return this.finishing;
    }
    socketActorClient():SocketActorClient{
        if(this.finishing||Atomics.load(this.ports.meta,6)!==this.pid)throw new Error("Guest process has exited");
        if(this.closed||this.closing||this.actorFailure||!this.actor)throw this.actorFailure??new Error("Process namespace closed");
        if(!this.actorClient){const channel=new MessageChannel(),identity=this.ports.processIdentity(0,this.pid);this.actorClient={port:channel.port1,...identity};
            this.actor.control.postMessage({type:"client",...identity,port:channel.port2},[channel.port2]);}
        return this.actorClient;
    }
    dropSocketActorClient():void{
        this.retireUdpForwards(this.rootUdpPeers); this.retireUdpForwards(this.rootUdpHosts);
        const identity=this.ports.processIdentity(0,this.pid);Atomics.store(this.ports.meta,6,0);
        this.actor?.control.postMessage({type:"drop",...identity});
        this.actorClient?.port.close();this.actorClient=null;
    }
    async configure(value: NetworkConfig | null): Promise<void> {
        if(this.closed||this.closing)throw new Error("Process namespace closed");
        const config = normalizeNetworkConfig(value);
        const key = config ? JSON.stringify(config) : "";
        if (this.active?.key === key && (this.active.link.connected || this.active.link.connecting)) return this.active.link.ready;
        this.backplane.configureDirectPlay8(config?.directPlay8);
        this.active = null; this.backplane.attach(null);
        if (!config) { this.network.configureDirectPlay8(); return; }
        const link = new RelayLink(config.serverUrl, config.room, this.backplane);
        this.active = { key, link }; this.backplane.attach(link);
        try {
            await link.ready;
            if (this.active?.link === link && this.sharedStateFailure) throw this.sharedStateFailure;
        }
        catch (error) {
            if (this.active?.link === link) { this.active = null; this.backplane.attach(null); }
            throw error;
        }
    }
    createChild(pid?:number): ChildNetworkNamespace {
        if(this.closed||this.closing)throw new Error("Process namespace closed");
        const identity = this.ports.allocate(0,pid);
        const channel = new MessageChannel();
        this.attach(channel.port1, identity.slot, identity.epoch, 0);
        return { boot: { ...identity, shared: this.ports.shared, capacity: this.ports.capacity, port: channel.port2 },
            close: () => this.drop(identity.slot, identity.epoch) };
    }
    private attach(port: MessagePort, slot: number, epoch: number, parent: number,service=false): void {
        const pid=Atomics.load(this.ports.meta,slot*META+6);
        if (!this.ports.alive(slot, epoch) || this.clients.has(slot)||(!service&&pid<1)||pid===this.pid
            ||[...this.clients.values()].some(client=>client.pid===pid)) { port.close();this.ports.drop(slot,epoch);return; }
        const client: Client = { udpPeers: new Map(), udpHosts: new Map(), pid,processEpoch:Atomics.load(this.ports.meta,slot*META+7),actorAttached:false,slot, epoch, parent, port, pending: [], flushing: false, dns: new Map(), knownPorts: new Map(), deliveryGenerations: new Map(), barriers: new Map() };
        this.clients.set(slot, client);
        if(pid>0)this.actor?.control.postMessage({type:"process",...this.ports.processIdentity(slot,pid)});
        port.onmessage = event => this.message(client, event.data);
        port.start();
        port.postMessage({ type: "state", state: this.snapshot() });
    }
    private snapshot(): LanState {
        return { connected: this.backplane.connected, node: this.backplane.node.slice(), ipv4: this.backplane.ipv4, generation: this.stateGeneration,
            gatewayIpv4: this.gatewayAddresses(), gatewayIpv6: this.lastGateways6,
            udpHostListenV1: this.backplane.udpHostListenV1, udpMulticast4V1: this.backplane.udpMulticast4V1, directPlay8: this.backplane.directPlay8 };
    }
    private recordResolved(result: ResolveResult): void {
        const addresses = result.addresses.filter(item => item.family === 4).map(item => item.address.split(".").map(Number));
        this.network.registerGatewayAddresses(addresses);
        const ipv6 = result.addresses.filter(item => item.family === 6 && item.node && parseIpv6(item.address))
            .map(item => ({ address: Array.from(parseIpv6(item.address)!), node: item.node!, ...(item.scopeId ? { scopeId: item.scopeId } : {}) }));
        this.network.registerGatewayIpv6(ipv6);
        this.lastGateways6 = [...new Map([...this.lastGateways6, ...ipv6].map(item => [item.address.join(".") + "%" + (item.scopeId ?? 0), item])).values()];
        this.lastGateways = [...new Map([...this.lastGateways, ...addresses].map(ip => [ip.join("."), ip])).values()];
        // DNS may add a configured route before the requesting child can run
        // another synchronous guest call, including an actor RPC on another port.
        this.state(this.snapshot());
    }
    private gatewayAddresses(): number[][] {
        // The backplane's state snapshot is propagated on every connection readiness transition.
        return this.lastGateways;
    }
    private stateGeneration = 0;
    private sharedStateFailure: Error | null = null;
    private lastGateways: number[][] = [];
    private lastGateways6: GatewayIpv6Address[] = [];
    private state(state: LanState): void {
        this.stateGeneration = state.generation;
        if (!this.ports.publishState(state)) {
            this.sharedStateFailure = new Error("Network readiness metadata exceeds shared snapshot capacity");
            state = {connected: false, node: state.node, ipv4: state.ipv4, generation: state.generation,
                reason: this.sharedStateFailure.message};
            this.ports.publishState(state);
        } else this.sharedStateFailure = null;
        this.network.configureDirectPlay8(state.directPlay8);
        this.network.configureUdpHosts(state.udpHostListenV1);
        this.network.configureMulticast4(state.udpMulticast4V1 === true);
        if (!state.connected) {
            this.retireUdpForwards(this.rootUdpPeers); this.retireUdpForwards(this.rootUdpHosts);
            for (const client of this.clients.values()) { this.retireUdpForwards(client.udpPeers); this.retireUdpForwards(client.udpHosts); }
        }
        this.lastGateways = state.gatewayIpv4 ?? [];
        this.network.configureGatewayAddresses(this.lastGateways);
        this.lastGateways6 = state.gatewayIpv6 ?? [];
        this.network.configureGatewayIpv6(this.lastGateways6);
        this.network.setConnected(state.connected, state.reason, this.sharedStateFailure !== null);
        for (const client of this.clients.values()) {
            if (!state.connected) {
                for (const item of client.pending.splice(0)) {
                    if (item.kind === "frame") this.ports.release(client.slot, client.epoch, item.frame.byteLength, false);
                    else this.releaseClientPort(client, item);
                }
                this.settleBarriers(client, new NetResolveError("NETWORK_DOWN"));
            }
            client.port.postMessage({ type: "state", state });
        }
    }
    private broadcast(type: "peer" | "socketError" | "portLeft", value: Uint8Array | LanSocketError | LanPortDisconnect): void {
        if (type === "peer") this.network.notifyPeerDisconnected(value as Uint8Array);
        else if (type === "socketError") this.network.notifySocketError(value as LanSocketError);
        else this.network.notifyPortDisconnected(value as LanPortDisconnect);
        for (const client of this.clients.values()) client.port.postMessage({ type, value });
    }
    private tcpKey(proto: number, port: number, id: number): string { return proto + ":" + port + ":" + id; }
    private trackTcp(slot: number, epoch: number, frame: Uint8Array,bindingGeneration=0): void {
        const datagram = decodeDatagram(frame);
        if (!datagram || !isTcpProtocol(datagram.proto)) return;
        const packet = decodeTcpFrame(datagram.payload);
        if (!packet?.srcId) return;
        const key = this.tcpKey(datagram.proto, datagram.srcPort, packet.srcId);
        if ((packet.kind === SYN || packet.kind === SYNACK) && !this.tcp.has(key)) this.tcp.set(key, {
            slot, epoch, localPort: datagram.srcPort, remotePort: datagram.dstPort, proto: datagram.proto,
            id: packet.srcId, peerId: packet.dstId, node: datagram.node.slice(), fin: false, peerFin: false,bindingGeneration,
        });
        const lease = this.tcp.get(key);
        if (!lease || lease.slot !== slot || lease.epoch !== epoch) return;
        if (packet.dstId) lease.peerId = packet.dstId;
        if (packet.kind === RST) this.tcp.delete(key);
        else if (packet.kind === FIN) { lease.fin = true; if (lease.peerFin) this.tcp.delete(key); }
    }
    private cancelTcpPort(slot: number, epoch: number, port: number, proto: number, generation?: number): void {
        if (!isTcpProtocol(proto)) return;
        for (const [key, lease] of this.tcp) if (lease.slot === slot && lease.epoch === epoch && lease.localPort === port && lease.proto === proto
            && (generation === undefined || lease.bindingGeneration === generation)) {
            this.tcp.delete(key);
            // An already accepted FIN remains ordered ahead of port-left; preserve EOF.
            if (!lease.fin) this.route(encodeDatagram(proto, lease.node, lease.remotePort, port, encodeTcpFrame(RST, lease.id, lease.peerId, 10054)),lease.bindingGeneration);
        }
    }
    private deliver(frame: Uint8Array,bindingGeneration?:number): void {
        const datagram = decodeDatagram(frame);
        if (!datagram) return;
        const raw4 = datagram.proto === PROTO_RAW4;
        if (bindingGeneration !== undefined) {
            if (!validBindingGeneration(bindingGeneration)
                || bindingGeneration !== this.ports.generation(datagram.dstPort, datagram.proto)) return;
            // The generation cell survives unbind. A capture also needs a live owner.
            if (raw4 && (!this.ports.targets(datagram.proto, datagram.dstPort).length
                || bindingGeneration !== this.ports.generation(datagram.dstPort, datagram.proto))) return;
        }
        const targetPorts = raw4 ? [...new Set([datagram.payload[0] + 1, 1, 256])]
            : isRawProtocol(datagram.proto) ? [datagram.dstPort, 1, 256] : [datagram.dstPort];
        const targets = new Set<number>(), rawTargets = raw4 ? new Map<number, RawDeliveryTarget[]>() : null;
        const multicastTargets = datagram.multicast4 ? new Map<number, {generation: number; client?: Client}>() : null;
        for (const port of targetPorts) {
            for (const slot of this.ports.targets(datagram.proto, port)) {
                if (rawTargets) {
                    const generation = slot === 0 ? this.network.deliveryGeneration(port, datagram.proto)
                        : this.clients.get(slot)?.deliveryGenerations.get(datagram.proto + ":" + port) ?? 0;
                    // Claim admission is FIFO on each process channel. A new
                    // claimant is eligible only after its delivery epoch arrives.
                    if (!generation) continue;
                    const bindings = rawTargets.get(slot) ?? [];
                    bindings.push({ port, generation });
                    rawTargets.set(slot, bindings);
                }
                if (multicastTargets) {
                    const client = slot === 0 ? undefined : this.clients.get(slot);
                    const generation = slot === 0 ? this.network.deliveryGeneration(port, datagram.proto)
                        : client?.deliveryGenerations.get(datagram.proto + ":" + port) ?? 0;
                    if (!generation || (slot !== 0 && !client)) continue;
                    multicastTargets.set(slot, {generation, client});
                }
                targets.add(slot);
            }
        }
        // Binding generations never repeat. Rechecking after collection prevents
        // a concurrent owner replacement from entering this capture's recipients.
        if (raw4 && bindingGeneration !== undefined
            && (bindingGeneration !== this.ports.generation(datagram.dstPort, datagram.proto)
                || !this.ports.targets(datagram.proto, datagram.dstPort).length
                || bindingGeneration !== this.ports.generation(datagram.dstPort, datagram.proto))) return;
        if (isTcpProtocol(datagram.proto)) {
            const packet = decodeTcpFrame(datagram.payload);
            if (packet) {
                const key = this.tcpKey(datagram.proto, datagram.dstPort, packet.dstId), lease = this.tcp.get(key);
                if (lease && lease.remotePort === datagram.srcPort && lease.node.every((n, index) => n === datagram.node[index])) {
                    if (packet.srcId) lease.peerId = packet.srcId;
                    if (packet.kind === RST) this.tcp.delete(key);
                    else if (packet.kind === FIN) { lease.peerFin = true; if (lease.fin) this.tcp.delete(key); }
                }
                if (!targets.size && packet.kind !== RST) this.route(encodeDatagram(datagram.proto, datagram.node, datagram.srcPort, datagram.dstPort,
                    encodeTcpFrame(RST, packet.dstId, packet.srcId, packet.kind === SYN ? 10061 : 10054)));
            }
        }
        for (const slot of targets) {
            if (!slot) {
                if (rawTargets) this.network.receiveRawFrame(frame, rawTargets.get(slot)!);
                else this.network.receiveFrame(frame, true, bindingGeneration, multicastTargets?.get(slot)?.generation);
                continue;
            }
            const client = this.clients.get(slot);
            if (!client || (multicastTargets && multicastTargets.get(slot)?.client !== client)) continue;
            if (!this.ports.reserve(slot, client.epoch, frame.byteLength, true)) {
                if (!isDatagramProtocol(datagram.proto)) {
                    const tcp = isTcpProtocol(datagram.proto) ? decodeTcpFrame(datagram.payload) : null;
                    if (tcp) this.backplane.send(datagram.dstPort, datagram.node, datagram.srcPort,
                        encodeTcpFrame(RST, tcp.dstId, tcp.srcId, 10055), datagram.proto);
                    this.drop(slot, client.epoch, "Process network receive queue exceeded");
                }
                continue;
            }
            const copy = frame.slice();
            client.port.postMessage({ type: "frame", frame: copy,
                ...(rawTargets ? { rawTargets: rawTargets.get(slot)! } : { bindingGeneration }),
                ...(multicastTargets ? {deliveryGeneration: multicastTargets.get(slot)!.generation} : {}) }, [copy.buffer]);
        }
    }
    private queueLocalUdpReset(datagram: NonNullable<ReturnType<typeof decodeDatagram>>, generation: number, client: Client | null): void {
        const {proto, srcPort: localPort, dstPort: remotePort} = datagram;
        const slot = client?.slot ?? 0, epoch = client?.epoch ?? 1, key = proto + ":" + localPort;
        const deliveryGeneration = client ? client.deliveryGenerations.get(key) ?? 0 : this.network.deliveryGeneration(localPort, proto);
        const processEpoch = Atomics.load(this.ports.meta, slot * META + 7);
        if (!validBindingGeneration(generation) || !deliveryGeneration || !this.ports.alive(slot, epoch)
            || this.ports.generation(localPort, proto) !== generation || !this.ports.targets(proto, localPort).includes(slot)) return;
        const node = this.network.node.slice();
        queueMicrotask(() => {
            if (this.closed || !this.ports.alive(slot, epoch) || Atomics.load(this.ports.meta, slot * META + 7) !== processEpoch
                || this.ports.generation(localPort, proto) !== generation || !this.ports.targets(proto, localPort).includes(slot)) return;
            const value: LanSocketError = {node, localPort, remotePort, proto, code: 10054, bindingGeneration: generation};
            if (client) {
                if (this.clients.get(slot) !== client || client.deliveryGenerations.get(key) !== deliveryGeneration) return;
                // The owner's incarnation is checked again after MessagePort delivery.
                client.port.postMessage({type: "socketError", value, deliveryGeneration});
            } else if (this.network.deliveryGeneration(localPort, proto) === deliveryGeneration) this.network.notifySocketError(value);
        });
    }
    private route(frame: Uint8Array,generation=0,source?:Client|null): boolean {
        if (this.closed) return false;
        const datagram = decodeDatagram(frame);
        if (!datagram) return false;
        if (datagram.multicast4) {
            if (!isMulticastIpv4Node(datagram.node)) return false;
            const meta = datagram.multicast4;
            if (meta.interfaceIndex === 2 && meta.ttl > 0 && this.backplane.connected
                && !this.backplane.sendMulticast4(datagram.srcPort, meta.group, datagram.dstPort, datagram.payload, meta.interfaceIndex, meta.ttl, generation)) return false;
            this.deliver(encodeDatagram(datagram.proto, this.network.node, datagram.dstPort, datagram.srcPort, datagram.payload, meta));
            return true;
        }
        const local = this.network.isSelf(datagram.node), broadcast = isBroadcastNode(datagram.node);
        if (!local && this.backplane.connected) {
            if (!this.backplane.send(datagram.srcPort, datagram.node, datagram.dstPort, datagram.payload, datagram.proto,generation)) return false;
        } else if (!local && !broadcast) return false;
        if (local && source !== undefined && (datagram.proto === PROTO_UDP || datagram.proto === PROTO_UDP6)
            && !this.ports.targets(datagram.proto, datagram.dstPort).length) this.queueLocalUdpReset(datagram, generation, source);
        if (local || broadcast) this.deliver(encodeDatagram(datagram.proto, this.network.node, datagram.dstPort, datagram.srcPort, datagram.payload));
        return true;
    }
    private queueClient(client: Client, item: PendingOutbound): boolean {
        client.pending.push(item);
        if (client.pending.length > MAX_FRAMES * 2) {
            this.drop(client.slot, client.epoch, "Process network send queue exceeded");
            return false;
        }
        return true;
    }
    private releaseClientPort(client: Client, item: Extract<PendingOutbound, { kind: "release" }>): void {
        this.retireUdpForwards(client.udpPeers, item.port, item.proto, item.generation); this.retireUdpForwards(client.udpHosts, item.port, item.proto, item.generation);
        this.cancelTcpPort(client.slot, client.epoch, item.port, item.proto, item.generation);
        this.portLeft(item.port, item.proto, item.generation, item.last);
    }
    private flushClient(client: Client): void {
        if (client.flushing) return;
        client.flushing = true;
        try {
            while (client.pending.length) {
                const item = client.pending[0];
                if (item.kind === "release") {
                    client.pending.shift();
                    this.releaseClientPort(client, item);
                    continue;
                }
                if (!this.route(item.frame, item.generation, client)) break;
                // A synchronous disconnect may already have discarded this item.
                if (client.pending[0] !== item) continue;
                client.pending.shift();
                this.ports.release(client.slot, client.epoch, item.frame.byteLength, false);
                client.port.postMessage({ type: "writable" });
            }
            if (!client.pending.length) this.settleBarriers(client);
        } finally { client.flushing = false; }
    }
    private settleBarriers(client: Client, error?: NetResolveError): void {
        for (const [id, timer] of client.barriers) {
            clearTimeout(timer);
            client.port.postMessage({ type: "reply", id, ...(error ? { error: error.message, code: error.code } : {}) });
        }
        client.barriers.clear();
    }
    private flush(): void { for (const client of this.clients.values()) this.flushClient(client); }
    async barrier(): Promise<void> { await this.actorRequest("barrier");this.flush(); }
    private replyWhenDrained(client:Client,id:number):void{
        this.flushClient(client);
        if(!client.pending.length)client.port.postMessage({type:"reply",id});
        else client.barriers.set(id,setTimeout(()=>this.settleBarriers(client,new NetResolveError("TRY_AGAIN","Network exit drain timed out")),10000));
    }
    private message(client: Client, message: any): void {
        if (!this.ports.alive(client.slot, client.epoch) || this.closed) return;
        if (["leaseUdpPeer","cancelUdpPeer","releaseUdpPeer","openUdpHost","cancelUdpHost","releaseUdpHost"].includes(message?.type)) client.port.postMessage({type: "udpPeerControlAck"});
        if(message?.type==="actorAttach"&&message.port instanceof MessagePort){
            if(client.pid<1||Atomics.load(this.ports.meta,client.slot*META+6)!==client.pid||client.actorAttached||this.actorFailure||!this.actor){message.port.close();return;}
            client.actorAttached=true;this.actor.control.postMessage({type:"client",...this.ports.processIdentity(client.slot,client.pid),port:message.port},[message.port]);
        }else if(message?.type==="actorDrop"){
            if(message.processEpoch!==client.processEpoch)return;
            const identity={pid:client.pid,slot:client.slot,epoch:client.processEpoch};
            this.retireUdpForwards(client.udpPeers); this.retireUdpForwards(client.udpHosts);
            if(Atomics.load(this.ports.meta,client.slot*META+7)===identity.epoch)Atomics.compareExchange(this.ports.meta,client.slot*META+6,client.pid,0);
            this.actor?.control.postMessage({type:"drop",...identity});client.actorAttached=false;
        }else if(message?.type==="actorProcessStart"){
            const identity=this.ports.processIdentity(client.slot,client.pid);
            if(Atomics.load(this.ports.meta,client.slot*META+6)===client.pid&&message.processEpoch===identity.epoch){
                client.processEpoch=identity.epoch;this.actor?.control.postMessage({type:"process",...identity});
            }
        }else if(message?.type==="actorFinish"){
            if(client.pid<1||message.processEpoch!==client.processEpoch){
                client.port.postMessage({type:"reply",id:message.id,error:"Process incarnation is no longer live"});return;
            }
            const identity={pid:client.pid,slot:client.slot,epoch:client.processEpoch};
            this.retireUdpForwards(client.udpPeers); this.retireUdpForwards(client.udpHosts);
            void this.actorRequest("finish",identity).then(()=>{
                if(Atomics.load(this.ports.meta,client.slot*META+7)===identity.epoch)Atomics.compareExchange(this.ports.meta,client.slot*META+6,client.pid,0);
                if(client.processEpoch===identity.epoch)client.actorAttached=false;
                this.replyWhenDrained(client,message.id);
            },error=>client.port.postMessage({type:"reply",id:message.id,error:String(error.message??error)}));
        }else if (message?.type === "frame") {
            const frame = message.frame;
            if (!(frame instanceof Uint8Array) || frame.byteLength > MAX_FRAME_SIZE || !decodeDatagram(frame)) return;
            const datagram = decodeDatagram(frame)!;
            const generation=message.bindingGeneration??0;if(generation!==0&&!validBindingGeneration(generation))return;
            client.knownPorts.set(datagram.proto + ":" + datagram.srcPort,generation);
            this.trackTcp(client.slot, client.epoch, frame,generation);
            const reliable = !isDatagramProtocol(datagram.proto);
            if (client.pending.length) {
                if (reliable) { if (!this.queueClient(client, { kind: "frame", frame, generation })) return; }
                else this.ports.release(client.slot, client.epoch, frame.byteLength, false);
            } else if (!this.route(frame,generation,client) && reliable && this.backplane.connected) {
                if (!this.queueClient(client, { kind: "frame", frame, generation })) return;
            } else this.ports.release(client.slot, client.epoch, frame.byteLength, false);
            client.port.postMessage({ type: "writable" });
        } else if (message?.type === "barrier") {
            if(client.pid===0)this.replyWhenDrained(client,message.id);
            else void this.actorRequest("barrier").then(()=>this.replyWhenDrained(client,message.id),
                error=>client.port.postMessage({type:"reply",id:message.id,error:String(error.message??error)}));
        } else if (message?.type === "claim") {
            if (!validBindingGeneration(message.deliveryGeneration)) return;
            const key = message.proto + ":" + message.port;
            client.knownPorts.set(key,message.generation??0);
            client.deliveryGenerations.set(key, message.deliveryGeneration);
        } else if (message?.type === "released") {
            this.retireUdpForwards(client.udpPeers, message.port, message.proto, message.generation); this.retireUdpForwards(client.udpHosts, message.port, message.proto, message.generation);
            const key=message.proto+":"+message.port;
            if (client.deliveryGenerations.get(key) === message.deliveryGeneration) {
                client.deliveryGenerations.delete(key);
                if(client.knownPorts.get(key)===(message.generation??0))client.knownPorts.delete(key);
            }
            if (!this.queueClient(client, { kind: "release", port: message.port, proto: message.proto,
                generation: message.generation ?? 0, last: message.last !== false })) return;
            this.flushClient(client);
        } else if (message?.type === "detach") {
            this.drop(client.slot, client.epoch);
        } else if (message?.type === "attach" && message.port instanceof MessagePort) {
            const slot = message.slot, epoch = message.epoch;
            if (Number.isInteger(slot) && slot > 0 && slot < this.ports.capacity
                && Atomics.load(this.ports.meta, slot * META + 1) === client.slot) this.attach(message.port, slot, epoch, client.slot);
        } else if (message?.type === "drop") {
            if (this.clients.get(message.slot)?.parent === client.slot) this.drop(message.slot, message.epoch);
        } else if (message?.type === "configure") {
            void this.configure(message.config).then(
                () => client.port.postMessage({ type: "reply", id: message.id }),
                error => client.port.postMessage({ type: "reply", id: message.id, error: String(error.message ?? error) }),
            );
        } else if (message?.type === "openUdpHost") {
            const id = message.id;
            void this.forwardUdpHost(client, id, message.request).then(lease => {
                if (!this.ports.alive(client.slot, client.epoch) || !client.udpHosts.has(id)) { lease.release(); return; }
                client.port.postMessage({type: "udpHostOpened", id, reply: {leaseId: id, address: lease.address, allowedNodes: lease.allowedNodes}});
                void lease.closed.then(error => {
                    if (this.ports.alive(client.slot, client.epoch)) client.port.postMessage({type: "udpHostClosed", id, leaseId: id, error});
                });
            }, error => {
                if (this.ports.alive(client.slot, client.epoch)) client.port.postMessage({type: "udpHostOpened", id,
                    reply: {error: {code: typeof error.code === "number" ? error.code : 10050, message: String(error.message ?? error).slice(0,256)}}});
            });
        } else if (message?.type === "cancelUdpHost" || message?.type === "releaseUdpHost") {
            client.udpHosts.get(message.id)?.cancel();
        } else if (message?.type === "leaseUdpPeer") {
            const id = message.id;
            void this.forwardUdpPeer(client, id, message.request).then(
                lease => {
                    if (!this.ports.alive(client.slot, client.epoch) || !client.udpPeers.has(id)) { lease.release(); return; }
                    client.port.postMessage({type: "udpPeerLeased", id, reply: {leaseId: id}});
                },
                error => {
                    if (this.ports.alive(client.slot, client.epoch)) client.port.postMessage({
                        type: "udpPeerLeased", id, reply: {error: {code: typeof error.code === "number" ? error.code : 10050, message: String(error.message ?? error)}},
                    });
                },
            );
        } else if (message?.type === "cancelUdpPeer" || message?.type === "releaseUdpPeer") {
            client.udpPeers.get(message.id)?.cancel();
        } else if (message?.type === "resolve") {
            if (client.dns.size >= 16) { client.port.postMessage({ type: "reply", id: message.id, error: "TRY_AGAIN", code: "TRY_AGAIN" }); return; }
            const controller = new AbortController();
            client.dns.set(message.id, controller);
            const request = message.request as ResolveRequest;
            void this.backplane.resolve(request.host, request.family, controller.signal).then(
                result => {
                    this.recordResolved(result);
                    client.port.postMessage({ type: "reply", id: message.id, result });
                },
                error => client.port.postMessage({ type: "reply", id: message.id, error: String(error.message ?? error), code: error.code ?? "NO_RECOVERY" }),
            ).finally(() => client.dns.delete(message.id));
        } else if (message?.type === "cancel") client.dns.get(message.id)?.abort();
    }
    private retireUdpForwards<R extends UdpBindingRequest>(entries: Map<number, UdpForward<R>>, port?: number, proto?: number, generation?: number): void {
        for (const entry of entries.values()) if ((port === undefined || entry.request.localPort === port) &&
            (proto === undefined || entry.request.proto === proto) &&
            (generation === undefined || entry.request.bindingGeneration === generation)) entry.cancel();
    }
    private async forwardUdpHost(client: Client | null, id: number, request: UdpHostOpenRequest, signal?: AbortSignal): Promise<UdpHostLease> {
        if (!validUdpHostOpenRequest(request)) throw udpLeaseError(10022, "Invalid UDP Host request");
        if (this.ports.targets(request.proto, request.localPort).length !== 1) throw udpLeaseError(10048, "UDP Host binding must have one process owner");
        const lease = await this.forwardUdpBinding(client, id, {...request}, client?.udpHosts ?? this.rootUdpHosts, signal,
            (provider, request, signal) => provider.openUdpHost(request, signal));
        if (!lease.isLive()) { lease.release(); throw udpLeaseError(10054, "UDP Host listener closed before readiness"); }
        const addresses = [lease.address.node.slice(2), ...lease.allowedNodes.map(node => node.slice(2))];
        this.network.registerGatewayAddresses(addresses);
        this.backplane.registerGatewayAddresses(addresses);
        this.lastGateways = [...new Map([...this.lastGateways, ...addresses].map(ip => [ip.join("."), ip])).values()];
        this.state(this.snapshot());
        void lease.closed.then(() => lease.release());
        return lease;
    }
    private async forwardUdpPeer(client: Client | null, id: number, request: UdpPeerLeaseRequest, signal?: AbortSignal): Promise<{release(): void}> {
        if (!request || (request.proto !== 1 && request.proto !== 4) || !validPort(request.localPort) ||
            !validPort(request.remotePort) || !validBindingGeneration(request.bindingGeneration) ||
            !Array.isArray(request.node) || request.node.length !== 6 ||
            !request.node.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ||
            !(isExternalIpv4Node(Uint8Array.from(request.node)) || (request.proto === 4 && isExternalIpv6Node(Uint8Array.from(request.node))))) {
            throw udpLeaseError(10022, "Invalid UDP peer tuple");
        }
        return this.forwardUdpBinding(client, id, {...request,node:[...request.node]}, client?.udpPeers ?? this.rootUdpPeers, signal,
            (provider, request, signal) => provider.leaseUdpPeer(request, signal));
    }
    private async forwardUdpBinding<R extends UdpBindingRequest, M extends {release():void}>(client: Client | null, id: number, request: R,
        entries: Map<number,UdpForward<R>>, signal: AbortSignal | undefined,
        open: (provider: RelayLink, request: R, signal: AbortSignal) => Promise<M>): Promise<M> {
        const slot = client?.slot ?? 0, epoch = client?.epoch ?? 1;
        if (!validBindingGeneration(id) || entries.has(id)) throw udpLeaseError(10022, "Invalid UDP request identity");
        if (signal?.aborted) throw udpLeaseError(995, "UDP binding request cancelled");
        if (this.closed || !this.ports.alive(slot, epoch) || !this.active?.link.connected) throw udpLeaseError(10050);
        if (!this.ports.targets(request.proto, request.localPort).includes(slot) ||
            this.ports.generation(request.localPort, request.proto) !== request.bindingGeneration) throw udpLeaseError(10022, "UDP binding is not owned by this process");
        if (entries.size >= 128) throw udpLeaseError(10055);
        const provider = this.active.link, controller = new AbortController();
        const processEpoch = Atomics.load(this.ports.meta, slot * META + 7);
        let lease: M | undefined;
        const entry: UdpForward<R> = {request, cancel: () => {
            if (entries.get(id) !== entry) return;
            entries.delete(id);signal?.removeEventListener("abort", entry.cancel);controller.abort();lease?.release();
        }};
        entries.set(id, entry);signal?.addEventListener("abort", entry.cancel, {once: true});
        try {
            lease = await open(provider, entry.request, controller.signal);
            if (entries.get(id) !== entry || !this.ports.alive(slot, epoch) ||
                !this.ports.targets(request.proto, request.localPort).includes(slot) ||
                this.ports.generation(request.localPort, request.proto) !== request.bindingGeneration || this.active?.link !== provider ||
                Atomics.load(this.ports.meta, slot * META + 7) !== processEpoch) {
                const stale = lease;lease = undefined;stale.release();entry.cancel();throw udpLeaseError(995, "UDP peer owner changed");
            }
            return Object.assign({}, lease, {release: entry.cancel});
        } catch (error) { entry.cancel();throw error; }
    }
    private portLeft(port: number, proto: number,generation=0,last=true): void {
        if (!last) return;
        if(generation)this.backplane.releaseRemotePort(port,proto,generation);
        // A later incarnation may have claimed the port while release was queued.
        if (this.ports.targets(proto, port).length) return;
        this.broadcast("portLeft", { node: this.network.node.slice(), port, proto });
        if (isTcpProtocol(proto)) for (const [key, lease] of [...this.tcp]) if (lease.proto === proto && lease.remotePort === port && this.network.isSelf(lease.node)) {
            this.tcp.delete(key);
            this.broadcast("socketError", { node: this.network.node.slice(), localPort: lease.localPort, remotePort: port, proto, code: 10054, wireId: lease.id });
        }
    }
    private drop(slot: number, epoch: number, reason = "Process network closed"): void {
        const client = this.clients.get(slot);
        if (client && client.epoch !== epoch) return;
        for (let child = 1; child < this.ports.capacity; child++) if (this.ports.alive(child)
            && Atomics.load(this.ports.meta, child * META + 1) === slot) this.drop(child, Atomics.load(this.ports.meta, child * META), reason);
        for (const lease of [...this.tcp.values()]) if (lease.slot === slot && lease.epoch === epoch) this.cancelTcpPort(slot, epoch, lease.localPort, lease.proto);
        const actorIdentity=client?this.ports.processIdentity(slot,client.pid):null;
        const ports = this.ports.drop(slot, epoch);
        if (client) {
            this.retireUdpForwards(client.udpPeers); this.retireUdpForwards(client.udpHosts);
            if(client.pid>0){
                this.actor?.control.postMessage({type:"drop",...actorIdentity!});
                if(client.processEpoch!==actorIdentity!.epoch)this.actor?.control.postMessage({type:"drop",pid:client.pid,slot,epoch:client.processEpoch});
            }
            client.port.postMessage({ type: "state", state: { ...this.snapshot(), connected: false, reason } });
            for (const controller of client.dns.values()) controller.abort();
            for (const timer of client.barriers.values()) clearTimeout(timer);
            client.barriers.clear();
            client.port.close(); this.clients.delete(slot);
        }
        const known = new Map<string, { port: number; proto: number; generation: number }>();
        for (const [key, generation] of client?.knownPorts ?? []) {
            const [proto, port] = key.split(":").map(Number);
            known.set(key + ":" + generation, { port, proto, generation });
        }
        for (const item of [...ports, ...(client?.pending ?? []).filter(item => item.kind === "release")]) {
            known.set(item.proto + ":" + item.port + ":" + item.generation, item);
        }
        for (const { port, proto, generation } of known.values()) {
            const last=this.ports.targets(proto,port).length===0||this.ports.generation(port,proto)!==generation;
            this.portLeft(port,proto,generation,last);
        }
    }
    close(): Promise<void> {
        if (this.closing) return this.closing;
        const actor=this.actor;
        // Let the worker quiesce its ports and shared-memory RPC before native
        // termination. Its service barrier still needs this broker to be alive.
        const shutdown=actor?this.actorRequest("shutdown"):Promise.resolve();
        this.closing=(async()=>{
            let failure:unknown;
            try{await shutdown;}catch(error){failure=error;}
            this.closed = true;
            this.failActorRequests(new Error("Process namespace closed"));
            this.dropSocketActorClient();
            for (const client of [...this.clients.values()]) this.drop(client.slot, client.epoch);
            this.active=null;this.backplane.attach(null);
            this.network.reset(); this.network.attach(null); this.network.setPortRegistry(null);
            this.tcp.clear();Atomics.store(this.ports.meta,0,0);this.actor=null;
            if(actor){
                actor.control.close();
                const terminate=()=>{if(!actor.terminated){actor.terminated=true;actor.worker.terminate();}};
                terminate();
                if("Bun" in globalThis){
                    await new Promise<void>((resolve,reject)=>{
                        // Cooperative self.close normally emits close. A broken
                        // worker gets a bounded forced-termination fallback.
                        let forced:ReturnType<typeof setTimeout>|undefined;
                        const timer=setTimeout(()=>{terminate();forced=setTimeout(()=>reject(new Error("Winsock actor did not terminate")),5000);},5000);
                        void actor.stopped.then(()=>{clearTimeout(timer);clearTimeout(forced);resolve();});
                    });
                }
            }
            if(failure)throw failure;
        })();
        return this.closing;
    }
}
export class ChildProcessNetworkNamespace implements ProcessNetworkNamespace, NetTransport {
    readonly routeLocal = true;
    private readonly ports: AtomicPorts;
    private readonly pending = new Map<number, { kind: string; resolve: (result: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
    private udpControlsInFlight = 0;
    private readonly udpHosts = new UdpHostLeaseRpc({
        connected: () => !this.closed && this.connected,
        request: (id, request) => {
            if (this.udpControlsInFlight >= 128) return false;
            this.udpControlsInFlight++; this.boot.port.postMessage({type:"openUdpHost",id,request}); return true;
        },
        cancel: id => { this.udpControlsInFlight++; this.boot.port.postMessage({type:"cancelUdpHost",id}); },
        release: id => { this.udpControlsInFlight++; this.boot.port.postMessage({type:"releaseUdpHost",id}); },
    });
    openUdpHost(request: UdpHostOpenRequest, signal?: AbortSignal): Promise<UdpHostLease> { return this.udpHosts.open(request, signal); }
    private readonly udpPeers = new UdpPeerLeaseRpc({
        connected: () => !this.closed && this.connected,
        request: (id, request) => {
            if (this.udpControlsInFlight >= 128) return false;
            this.udpControlsInFlight++;
            this.boot.port.postMessage({type: "leaseUdpPeer", id, request});return true;
        },
        cancel: id => { this.udpControlsInFlight++;this.boot.port.postMessage({type: "cancelUdpPeer", id}); },
        release: id => { this.udpControlsInFlight++;this.boot.port.postMessage({type: "releaseUdpPeer", id}); },
    });
    leaseUdpPeer(request: UdpPeerLeaseRequest, signal?: AbortSignal): Promise<{release(): void}> {
        return this.udpPeers.open(request, signal);
    }
    private nextRequest = 1;
    private closed = false;
    private actorClient:SocketActorClient|null=null;
    private finishing:Promise<void>|null=null;
    private stateRevision = 0;
    private stateGeneration: number | undefined;
    private synchronizing = false;
    synchronizeState(): void {
        if (this.closed || this.synchronizing || !this.ports.alive(this.boot.slot, this.boot.epoch)) return;
        if (this.stateRevision === (Atomics.load(this.ports.header, STATE_REVISION) >>> 0)) return;
        const snapshot = this.ports.stateSnapshot();
        if (!snapshot) return;
        this.synchronizing = true;
        try {
            const state = snapshot.state;
            this.stateRevision = snapshot.revision;
            // A child can miss both offline and online notifications while its
            // guest is running. Retire old leases before applying the new epoch.
            if (this.stateGeneration !== undefined && this.stateGeneration !== state.generation) {
                this.retireState();
                this.network.setConnected(false, state.reason, true);
            }
            this.stateGeneration = state.generation;
            if (!state.connected) this.retireState();
            this.network.configureDirectPlay8(state.directPlay8);
            this.network.configureUdpHosts(state.udpHostListenV1);
            this.network.configureMulticast4(state.udpMulticast4V1 === true);
            this.network.configureGatewayAddresses(state.gatewayIpv4 ?? []);
            this.network.configureGatewayIpv6(state.gatewayIpv6 ?? []);
            this.network.setConnected(state.connected, state.reason);
        } finally { this.synchronizing = false; }
    }
    private retireState(): void {
        this.udpPeers.disconnect(); this.udpHosts.disconnect();
        for (const [id, pending] of this.pending) if (pending.kind === "resolve" || !this.ports.alive(this.boot.slot, this.boot.epoch)) {
            this.pending.delete(id); pending.cleanup(); pending.reject(new NetResolveError("NETWORK_DOWN"));
        }
    }
    get connected(): boolean {
        this.synchronizeState();
        return !this.closed && this.ports.alive(this.boot.slot, this.boot.epoch) && !!Atomics.load(this.ports.header, 1)
            && this.stateRevision !== 0 && this.stateRevision === (Atomics.load(this.ports.header, STATE_REVISION) >>> 0);
    }
    connectionState(): boolean { return this.connected; }
    supportsMulticast4(): boolean { return this.connected && Atomics.load(this.ports.header, MULTICAST4_CAPABILITY) === 1; }
    constructor(readonly network: LanNetwork, private readonly boot: NetworkNamespaceBoot) {
        this.ports = new AtomicPorts(boot.shared, boot.capacity);
        if(!this.ports.alive(boot.slot,boot.epoch)||Atomics.load(this.ports.meta,boot.slot*META+6)!==boot.pid)throw new Error("Invalid authenticated process namespace");
        network.adoptIdentity(this.ports.node);
        network.setPortRegistry(this.ports.registry(boot.slot, boot.epoch, (port, proto, claimed,generation,last,deliveryGeneration) => {
            boot.port.postMessage({ type: claimed ? "claim" : "released", port, proto,generation,last,deliveryGeneration });
        }));
        network.attach(this);
        boot.port.onmessage = event => this.message(event.data);
        boot.port.start();
    }
    private message(message: any): void {
        if (this.closed) return;
        if (message?.type === "frame" && message.frame instanceof Uint8Array) {
            this.ports.release(this.boot.slot, this.boot.epoch, message.frame.byteLength, true);
            if (message.rawTargets !== undefined) this.network.receiveRawFrame(message.frame, message.rawTargets);
            else this.network.receiveFrame(message.frame, true, message.bindingGeneration, message.deliveryGeneration);
        } else if (message?.type === "udpPeerControlAck") {
            this.udpControlsInFlight = Math.max(0, this.udpControlsInFlight - 1);
        } else if (message?.type === "udpHostOpened") {
            this.udpHosts.accept(message.id, message.reply);
        } else if (message?.type === "udpHostClosed") {
            const error = message.error?.code === 995 ? {...message.error,code:10004} : message.error;
            this.udpHosts.acceptClosed(message.id, message.leaseId, error);
        } else if (message?.type === "udpPeerLeased") {
            this.udpPeers.accept(message.id, message.reply);
        } else if (message?.type === "gateways") {
            this.network.registerGatewayAddresses(message.addresses);
            this.network.registerGatewayIpv6(message.ipv6 ?? []);
        } else if (message?.type === "state") {
            // Messages are wakeups; only the latest committed host snapshot is
            // authoritative. Queued old states cannot roll a reconnect backward.
            this.synchronizeState();
        } else if (message?.type === "peer") this.network.notifyPeerDisconnected(message.value);
        else if (message?.type === "portLeft") {
            this.network.notifyPortDisconnected(message.value);
        } else if (message?.type === "socketError") {
            const error = message.value;
            if (message.deliveryGeneration !== undefined && (!validBindingGeneration(message.deliveryGeneration)
                || message.deliveryGeneration !== this.network.deliveryGeneration(error?.localPort, error?.proto))) return;
            this.network.notifySocketError(error);
        }
        else if (message?.type === "writable") this.network.notifyWritable();
        else if (message?.type === "reply") {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id); pending.cleanup();
            if (message.error) pending.reject(message.code ? new NetResolveError(message.code, message.error) : new Error(message.error));
            else {
                if (message.result?.addresses) this.network.registerGatewayAddresses(message.result.addresses.filter((item: any) => item.family === 4).map((item: any) => item.address.split(".").map(Number)));
                pending.resolve(message.result);
            }
        }
    }
    send(frame: Uint8Array<ArrayBuffer>,bindingGeneration=0): boolean {
        if (this.closed || !this.ports.alive(this.boot.slot, this.boot.epoch)) return false;
        const datagram = decodeDatagram(frame);
        if (!datagram) return false;
        if (datagram.multicast4) {
            if (!isMulticastIpv4Node(datagram.node)) return false;
            if (this.connected && datagram.multicast4.interfaceIndex === 2 && datagram.multicast4.ttl > 0 && !this.network.udpMulticast4V1) return false;
        } else if (!this.connected && !this.network.isSelf(datagram.node) && !isBroadcastNode(datagram.node)) return false;
        if (!this.ports.reserve(this.boot.slot, this.boot.epoch, frame.byteLength, false)) return false;
        this.boot.port.postMessage({ type: "frame", frame,bindingGeneration }, [frame.buffer]);
        return true;
    }
    private request(type: string, payload: object, signal?: AbortSignal): Promise<any> {
        if (signal?.aborted) return Promise.reject(new NetResolveError("CANCELLED"));
        if (this.closed || !this.ports.alive(this.boot.slot, this.boot.epoch)) return Promise.reject(new NetResolveError("NETWORK_DOWN"));
        if (this.pending.size >= 32) return Promise.reject(new NetResolveError("TRY_AGAIN"));
        return new Promise((resolve, reject) => {
            const id = this.nextRequest++;
            const abort = () => {
                this.boot.port.postMessage({ type: "cancel", id });
                this.pending.delete(id); cleanup(); reject(new NetResolveError("CANCELLED"));
            };
            const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new NetResolveError("TRY_AGAIN")); }, 15_000);
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
            this.pending.set(id, { kind: type, resolve, reject, cleanup });
            signal?.addEventListener("abort", abort, { once: true });
            this.boot.port.postMessage({ type, id, ...payload });
        });
    }
    configure(config: NetworkConfig | null): Promise<void> { return this.request("configure", { config }); }
    barrier(): Promise<void> { return this.request("barrier", {}); }
    resolve(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult> { return this.request("resolve", { request }, signal); }
    beginProcessLifetime():void{
        if(this.closed||this.finishing)throw new Error("Process namespace closed or finishing");
        const epoch=this.ports.beginProcess(this.boot.slot,this.boot.pid);this.boot.port.postMessage({type:"actorProcessStart",processEpoch:epoch});
    }
    finishProcessLifetime():Promise<void>{
        if(this.finishing)return this.finishing;
        if(Atomics.load(this.ports.meta,this.boot.slot*META+6)!==this.boot.pid)return this.barrier();
        const epoch=this.ports.processIdentity(this.boot.slot,this.boot.pid).epoch;
        this.udpPeers.retire(); this.udpHosts.retire();
        this.actorClient?.port.close();this.actorClient=null;
        const finish=this.request("actorFinish",{processEpoch:epoch});
        this.finishing=finish.finally(()=>{this.finishing=null;});return this.finishing;
    }
    socketActorClient():SocketActorClient{
        if(this.closed||this.finishing||!this.ports.alive(this.boot.slot,this.boot.epoch)||Atomics.load(this.ports.meta,this.boot.slot*META+6)!==this.boot.pid||this.boot.pid<1)throw new Error("Process namespace closed");
        if(!this.actorClient){const channel=new MessageChannel();this.actorClient={...this.ports.processIdentity(this.boot.slot,this.boot.pid),port:channel.port1};
            this.boot.port.postMessage({type:"actorAttach",port:channel.port2},[channel.port2]);}
        return this.actorClient;
    }
    dropSocketActorClient():void{
        this.udpPeers.retire(); this.udpHosts.retire();
        if(!this.closed){const processEpoch=this.ports.processIdentity(this.boot.slot,this.boot.pid).epoch;
            Atomics.store(this.ports.meta,this.boot.slot*META+6,0);this.boot.port.postMessage({type:"actorDrop",processEpoch});}
        this.actorClient?.port.close();this.actorClient=null;
    }
    createChild(pid?:number): ChildNetworkNamespace {
        const identity = this.ports.allocate(this.boot.slot,pid);
        const channel = new MessageChannel();
        this.boot.port.postMessage({ type: "attach", ...identity, port: channel.port1 }, [channel.port1]);
        return { boot: { ...identity, shared: this.boot.shared, capacity: this.boot.capacity, port: channel.port2 },
            close: () => this.boot.port.postMessage({ type: "drop", ...identity }) };
    }
    close(): void {
        if (this.closed) return;
        this.udpPeers.retire(); this.udpHosts.retire();
        this.dropSocketActorClient();
        this.closed = true;
        for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new NetResolveError("NETWORK_DOWN")); }
        this.pending.clear();
        this.boot.port.postMessage({ type: "detach" });
        this.network.reset();
        this.boot.port.close();
        this.network.setPortRegistry(null);
        this.network.setConnected(false, "Process network closed");
    }
}
