import { createServer, type Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { GatewayRoutes, NativeGateway, type GatewayOptions } from "./gateway";
import { NetResolveError } from "./resolve";
import { RoomAccess, type RoomAccessConfig, type Admission } from "./access";
import {TcpHostOwner} from "./tcp-host-owner";
import {TcpAcceptHostOwner} from "./tcp-accept-host-owner";
import {
    asBytes, decodeDatagram, isDatagramProtocol, isBroadcastNode, isLanNode, nodeKey, nodeToIpv4,
    PROTOCOL_VERSION, MAX_FRAME_SIZE, SOCKET_PATH, validBindingGeneration, validPort, isProtocol,
    PROTO_UDP, PROTO_TCP, isExternalNode, isMulticastIpv4Node, validTcpHostOpenRequest,
    type ClientEvents, type ServerEvents, type UdpPeerLeaseRequest,type UdpPeerLeaseReply,validUdpPeerLeaseRequest,
} from "./protocol";

export interface LanServerOptions {
    host?: string;
    port?: number;
    allowedOrigins?: string[] | "*";
    transports?: ("polling" | "websocket")[];
    maxRooms?: number;
    maxPeersPerRoom?: number;
    maxBufferedFrames?: number;
    maxBufferedBytes?: number;
    maxFramesPerSecond?: number;
    maxBytesPerSecond?: number;
    reconnectGraceMs?: number;
    maxOfflineRooms?: number;
    maxOfflinePeersPerRoom?: number;
    maxBindingsPerPeer?: number;
    maxBindingEntries?: number;
    gateway?: GatewayOptions;
    roomAccess?: RoomAccessConfig;
}
type PeerSocket = Socket<ClientEvents, ServerEvents>;
interface Lease { clientId: string; node: Uint8Array; socket: PeerSocket | null; expiresAt: number }
interface Room { peers: Map<string, Lease> }
export interface LanServer {
    io: Server<ClientEvents, ServerEvents>;
    http: HttpServer;
    listen(): Promise<number>;
    close(): Promise<void>;
}
export function createLanServer(options: LanServerOptions = {}): LanServer {
    const limits = {
        maxRooms: 128, maxPeersPerRoom: 64, maxBufferedFrames: 64, maxBufferedBytes: 1024 * 1024,
        maxFramesPerSecond: 2000, maxBytesPerSecond: 4 * 1024 * 1024, reconnectGraceMs: 60_000,
        maxOfflineRooms:32, maxOfflinePeersPerRoom:16, maxBindingsPerPeer:1024, maxBindingEntries:16384, ...options,
    };
    for (const [key,min,max] of [
        ["maxRooms",1,65536],["maxPeersPerRoom",1,4096],["maxBufferedFrames",1,65536],["maxBufferedBytes",1,1073741824],
        ["maxFramesPerSecond",1,0xffffffff],["maxBytesPerSecond",1,Number.MAX_SAFE_INTEGER],["reconnectGraceMs",0,86400000],
        ["maxOfflineRooms",0,65536],["maxOfflinePeersPerRoom",0,4096],["maxBindingsPerPeer",1,65536],["maxBindingEntries",1,1048576],
    ] as const) {
        const value=limits[key];if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError("Invalid LAN limit: "+key);
    }
    let bindingEntries=0;
    const access = new RoomAccess(options.roomAccess);
    const rooms = new Map<string, Room>();
    const gatewayRoutes = new GatewayRoutes(options.gateway);
    const http = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/health") {
            response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ service: "bottleship-lan", version: PROTOCOL_VERSION }));
        } else { response.writeHead(404); response.end(); }
    });
    const allowedOrigins = options.allowedOrigins ?? "*";
    const originAllowed = (origin: string | undefined): boolean =>
        !origin || allowedOrigins === "*" || allowedOrigins.includes(origin);
    const io = new Server<ClientEvents, ServerEvents>(http, {
        path: SOCKET_PATH,
        transports: options.transports ?? ["polling", "websocket"],
        cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), credentials: false },
        allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin)),
        maxHttpBufferSize: Math.ceil(MAX_FRAME_SIZE * 4 / 3) + 2048,
        perMessageDeflate: false,
        httpCompression: false,
        connectionStateRecovery: undefined,
    });
    function evictOfflinePeer(room:Room):boolean {
        const offline=[...room.peers.entries()].filter(([,p])=>!p.socket);
        offline.sort(([a,x],[b,y])=>x.expiresAt-y.expiresAt || (a<b?-1:a>b?1:0));
        return offline.length>0 && room.peers.delete(offline[0][0]);
    }
    function evictOfflineRoom():boolean {
        const offline=[...rooms.entries()].filter(([,r])=>[...r.peers.values()].every(p=>!p.socket));
        const latest=(r:Room)=>Math.max(0,...[...r.peers.values()].map(p=>p.expiresAt));
        offline.sort(([a,x],[b,y])=>latest(x)-latest(y) || (a<b?-1:a>b?1:0));
        return offline.length>0 && rooms.delete(offline[0][0]);
    }
    function prune(): void {
        const now = Date.now();
        for (const [name, room] of rooms) {
            for (const [key, lease] of room.peers) if (!lease.socket && lease.expiresAt <= now) room.peers.delete(key);
            while([...room.peers.values()].filter(p=>!p.socket).length>Math.min(limits.maxOfflinePeersPerRoom,limits.maxPeersPerRoom))evictOfflinePeer(room);
            if (room.peers.size === 0) rooms.delete(name);
        }
        while([...rooms.values()].filter(r=>[...r.peers.values()].every(p=>!p.socket)).length>limits.maxOfflineRooms)evictOfflineRoom();
    }
    const pending = new WeakMap<PeerSocket, { frames: number; bytes: number }>();
    function congested(socket: PeerSocket, frameSize: number): boolean {
        const queue = pending.get(socket);
        return !!queue && (queue.frames >= limits.maxBufferedFrames || queue.bytes + frameSize > limits.maxBufferedBytes);
    }
    function notifyPeerLeft(socket: PeerSocket, node: Uint8Array): void {
        if (!socket.connected) return;
        if (congested(socket, 64)) { socket.disconnect(true); return; }
        const queue = pending.get(socket);
        if (queue) { queue.frames++; queue.bytes += 64; }
        socket.emit("peerLeft", { node: Array.from(node) });
    }
    io.use((socket, next) => {
        prune();
        const auth: unknown = socket.handshake.auth;
        if (!auth || typeof auth !== "object") { next(new Error("Invalid LAN handshake")); return; }
        const request = auth as Record<string, unknown>;
        const validNode = Array.isArray(request.node) && request.node.length === 6
            && request.node.every(value => Number.isInteger(value) && value >= 0 && value <= 255);
        if (request.version !== PROTOCOL_VERSION || typeof request.room !== "string"
            || !/^[A-Za-z0-9_-]{1,64}$/.test(request.room)
            || typeof request.clientId !== "string" || !/^[A-Za-z0-9-]{16,128}$/.test(request.clientId)
            || !validNode) { next(new Error("Invalid LAN handshake")); return; }
        const node = Uint8Array.from(request.node as number[]);
        if (!isLanNode(node)) { next(new Error("Invalid LAN address")); return; }
        let admission: Admission;
        try { admission = access.authorize(request.room, request.invite); }
        catch { next(new Error("LAN access denied")); return; }
        let room = rooms.get(request.room);
        if (!room) {
            while (rooms.size >= limits.maxRooms) { if(!evictOfflineRoom()){next(new Error("LAN room limit reached"));return;} }
            room = { peers: new Map() };
            rooms.set(request.room, room);
        }
        const key = nodeKey(node);
        const existing = room.peers.get(key);
        if (existing && existing.clientId !== request.clientId) {
            next(new Error("LAN address already in use")); return;
        }
        if (!existing) while(room.peers.size >= limits.maxPeersPerRoom) { if(!evictOfflinePeer(room)){next(new Error("LAN room is full"));return;} }
        const lease: Lease = existing ?? { clientId: request.clientId, node, socket: null, expiresAt: Infinity };
        lease.socket?.disconnect(true);
        lease.socket = socket;
        lease.expiresAt = Infinity;
        room.peers.set(key, lease);
        rooms.set(request.room,room);
        socket.data = { room, lease, admission };
        next();
    });
    io.on("connection", socket => {
        const { room, lease, admission } = socket.data as { room: Room; lease: Lease; admission: Admission };
        const allowedRoutes = new Set(admission.gateway.routes);
        const portSlots=new Set<number>();
        const reservePort=(proto:number,port:number):boolean=>{
            if(!isProtocol(proto)||!validPort(port))return true;
            const key=proto*65536+port;if(portSlots.has(key))return true;
            if(portSlots.size>=limits.maxBindingsPerPeer||bindingEntries>=limits.maxBindingEntries){socket.disconnect(true);return false;}
            portSlots.add(key);bindingEntries++;return true;
        };
        const expiration = Number.isFinite(admission.expiresAt) ? setTimeout(() => socket.disconnect(true), Math.max(0, admission.expiresAt * 1000 - Date.now())) : undefined;
        socket.use((packet, next) => {
            if (admission.expiresAt <= Math.floor(Date.now() / 1000)) { socket.disconnect(true); return; }
            const [event,...args]=packet;
            if(event==="releasePort" && !reservePort(args[0],args[1]))return;
            if(["leaseUdpPeer","openUdpHost","openTcpHost"].includes(event) && args[1] && typeof args[1]==="object" &&
                !reservePort(args[1].proto,args[1].localPort))return;
            if(event==="frame" && validBindingGeneration(args[1])){
                const frame=asBytes(args[0]),d=frame && decodeDatagram(frame);
                if(d && (d.proto===PROTO_UDP || isExternalNode(d.node)) && !reservePort(d.proto,d.srcPort))return;
            }
            next();
        });
        socket.emit("ready", { version: PROTOCOL_VERSION, node: Array.from(lease.node), ipv4: Array.from(nodeToIpv4(lease.node)), gatewayIpv4: gatewayRoutes.advertisedIpv4For(allowedRoutes), gatewayIpv6: gatewayRoutes.advertisedIpv6For(allowedRoutes), udpMulticast4V1: true });
        const queue = { frames: 0, bytes: 0 };
        pending.set(socket, queue);
        socket.conn.on("drain", () => { queue.frames = 0; queue.bytes = 0; });
        const emitGateway = (frame: Uint8Array<ArrayBuffer>, reliable: boolean, bindingGeneration?: number): boolean => {
            if (!socket.connected) return false;
            if (congested(socket, frame.byteLength)) {
                if (reliable) socket.disconnect(true);
                return false;
            }
            queue.frames++; queue.bytes += frame.byteLength;
            if (bindingGeneration === undefined) socket.emit("frame", frame);
            else socket.emit("frame", frame, bindingGeneration);
            return true;
        };
        const gateway = new NativeGateway(gatewayRoutes, emitGateway, error => {
            if (!socket.connected) return;
            if (congested(socket, 64)) { socket.disconnect(true); return; }
            queue.frames++; queue.bytes += 64;
            socket.emit("socketError", error);
        }, lease.node, allowedRoutes);
        // TCP Host remains opt-in and unadvertised until end-to-end parity.
        type TcpOwner=TcpHostOwner|TcpAcceptHostOwner;
        type TcpPending={request:import("./protocol").TcpHostOpenRequest;controller:AbortController;owner:TcpOwner};
        type TcpActive={requestId:number;request:import("./protocol").TcpHostOpenRequest;owner:TcpOwner};
        const tcpPending=new Map<number,TcpPending>(),tcpActive=new Map<number,TcpActive>();
        const tcpOwners=new Set<TcpOwner>();
        const tcpBindings=new Map<number,{generation:number;released:boolean}>();
        let lastTcpHostRequest=0;
        const tcpReply=(id:number,reply:import("./protocol").TcpHostOpenReply):boolean=>{
            if(!socket.connected)return false;
            if(congested(socket,256)){socket.disconnect(true);return false;}
            queue.frames++;queue.bytes+=256;socket.emit("tcpHostOpened",id,reply);return true;
        };
        const closeTcpOwner=(owner:TcpOwner,all:boolean):void=>{
            if(all)owner.close();
            void owner.closeListener().then(()=>tcpOwners.delete(owner));
        };
        const retireTcp=(port:number,generation:number,inclusive:boolean):void=>{
            const match=(r:import("./protocol").TcpHostOpenRequest)=>r.localPort===port &&
                (inclusive?r.bindingGeneration<=generation:r.bindingGeneration<generation);
            for(const [id,p] of tcpPending)if(match(p.request)){
                tcpPending.delete(id);p.controller.abort();closeTcpOwner(p.owner,true);
            }
            for(const [id,a] of tcpActive)if(match(a.request)){
                tcpActive.delete(id);closeTcpOwner(a.owner,true);
            }
            for(const owner of tcpOwners)if(owner.bindingRetiredBy(port,generation,inclusive))closeTcpOwner(owner,true);
        };
        socket.on("openTcpHost",(id,request)=>{
            if(!withinLimits(128))return;
            if(!Number.isInteger(id)||id<1||id>0xffffffff||id<=lastTcpHostRequest){socket.disconnect(true);return;}
            lastTcpHostRequest=id;
            if(!validTcpHostOpenRequest(request)){tcpReply(id,{error:{code:10022,message:"Invalid TCP Host request"}});return;}
            const config=gatewayRoutes.tcpListeners.find(item=>item.id===request.listenerId);
            if(!config || !admission.gateway.tcpListeners.includes(config.id)){tcpReply(id,{error:{code:10013,message:"TCP listener is not configured"}});return;}
            if(tcpPending.size>=16||tcpOwners.size>=32){tcpReply(id,{error:{code:10055,message:"TCP listener capacity"}});return;}
            const previous=tcpBindings.get(request.localPort);
            if(previous&&(request.bindingGeneration<previous.generation||
                request.bindingGeneration===previous.generation&&previous.released)){
                tcpReply(id,{error:{code:10057,message:"TCP binding retired"}});return;
            }
            if([...tcpPending.values(),...tcpActive.values()].some(v=>v.request.localPort===request.localPort&&v.request.bindingGeneration===request.bindingGeneration)){
                tcpReply(id,{error:{code:10048,message:"TCP listener binding in use"}});return;
            }
            if(!previous||request.bindingGeneration>previous.generation){
                retireTcp(request.localPort,request.bindingGeneration,false);
                if(request.bindingGeneration>1)gateway.releasePort(PROTO_TCP,request.localPort,request.bindingGeneration-1);
                tcpBindings.set(request.localPort,{generation:request.bindingGeneration,released:false});
            }
            const controller=new AbortController();
            const copy={...request};
            let entry:TcpPending;
            let owner:TcpOwner;
            const onFailure=(code:number)=>{
                for(const [leaseId,active] of tcpActive)if(active.owner===owner){
                    tcpActive.delete(leaseId);
                    if(socket.connected){
                        if(congested(socket,128)){socket.disconnect(true);return;}
                        queue.frames++;queue.bytes+=128;
                        socket.emit("tcpHostClosed",active.requestId,leaseId,{code,message:"TCP listener closed"});
                    }
                    closeTcpOwner(owner,false);
                }
            };
            try {
                const helper=gatewayRoutes.options.nativeTcpAcceptHelperPath;
                owner=helper?new TcpAcceptHostOwner(gatewayRoutes.tcpHostRegistry,gatewayRoutes.tcpAcceptQuota,helper,
                    gatewayRoutes.tcpHostRegistry.nextId(),(frame,generation)=>emitGateway(frame,true,generation),onFailure):
                    new TcpHostOwner(gatewayRoutes.tcpHostRegistry,(frame,generation)=>emitGateway(frame,true,generation),onFailure,true);
            } catch {
                tcpReply(id,{error:{code:10055,message:"TCP listener identity exhausted"}});return;
            }
            entry={request:copy,controller,owner};
            tcpPending.set(id,entry);tcpOwners.add(owner);
            void owner.open(config,{localPort:copy.localPort,generation:copy.bindingGeneration},controller.signal).then(opened=>{
                if(controller.signal.aborted||!socket.connected||tcpPending.get(id)!==entry){closeTcpOwner(owner,true);return;}
                tcpPending.delete(id);
                const current=tcpBindings.get(copy.localPort);
                if(!current||current.released||current.generation!==copy.bindingGeneration){closeTcpOwner(owner,true);return;}
                tcpActive.set(opened.leaseId,{requestId:id,request:copy,owner});
                if(tcpReply(id,opened)) {
                    try{owner.activate();}catch{tcpActive.delete(opened.leaseId);closeTcpOwner(owner,true);socket.disconnect(true);}
                } else {tcpActive.delete(opened.leaseId);closeTcpOwner(owner,true);}
            },error=>{
                if(tcpPending.get(id)===entry)tcpPending.delete(id);
                closeTcpOwner(owner,true);
                if(!controller.signal.aborted)tcpReply(id,{error:{code:typeof error?.code==="number"?error.code:10050,message:"TCP Host listener refused"}});
            });
        });
        socket.on("cancelTcpHost",id=>{
            if(!withinLimits(16))return;
            const p=tcpPending.get(id);
            if(p){tcpPending.delete(id);p.controller.abort();closeTcpOwner(p.owner,true);}
            for(const [leaseId,a] of tcpActive)if(a.requestId===id){tcpActive.delete(leaseId);closeTcpOwner(a.owner,false);}
        });
        socket.on("releaseTcpHost",leaseId=>{
            if(!withinLimits(16))return;
            const a=tcpActive.get(leaseId);if(!a)return;
            tcpActive.delete(leaseId);closeTcpOwner(a.owner,false);
        });
        const udpPending=new Map<number,{request:UdpPeerLeaseRequest;controller:AbortController}>();
        const udpLeases=new Map<number,{requestId:number;request:UdpPeerLeaseRequest;release:()=>void}>();
        let nextUdpLease=1,lastUdpRequest=0;
        const udpReply=(id:number,reply:UdpPeerLeaseReply):void=>{
            if(!socket.connected)return;
            if(congested(socket,128)){socket.disconnect(true);return;}
            queue.frames++;queue.bytes+=128;socket.emit("udpPeerLeased",id,reply);
        };
        const retireUdpLeases=(proto:number,port:number,generation:number,inclusive:boolean):void=>{
            const matches=(r:UdpPeerLeaseRequest)=>r.proto===proto&&r.localPort===port&&
                (inclusive?r.bindingGeneration<=generation:r.bindingGeneration<generation);
            for(const pending of udpPending.values())if(matches(pending.request))pending.controller.abort();
            for(const [id,lease]of udpLeases)if(matches(lease.request)){udpLeases.delete(id);lease.release();}
        };
        socket.on("leaseUdpPeer",(id,request)=>{
            if(!withinLimits(64))return;
            if(!Number.isInteger(id)||id<1||id>0xffffffff||id<=lastUdpRequest){socket.disconnect(true);return;}
            lastUdpRequest=id;
            if(!validUdpPeerLeaseRequest(request)){udpReply(id,{error:{code:10022,message:"Invalid UDP peer request"}});return;}
            if(udpPending.size>=16||udpLeases.size+udpPending.size>=Math.min(128,options.gateway?.maxUdpFlows??128)){
                udpReply(id,{error:{code:10055,message:"UDP peer lease limit reached"}});return;
            }
            if (request.proto === PROTO_UDP) admitUdp(request.localPort, request.bindingGeneration);
            const controller=new AbortController(),entry={request:{proto:request.proto,localPort:request.localPort,bindingGeneration:request.bindingGeneration,node:request.node.slice(),remotePort:request.remotePort},controller};
            udpPending.set(id,entry);
            if(isProtocol(request.proto)&&validPort(request.localPort)&&validBindingGeneration(request.bindingGeneration))
                retireUdpLeases(request.proto,request.localPort,request.bindingGeneration,false);
            void gateway.leaseUdpPeer(entry.request,controller.signal).then(release=>{
                if(controller.signal.aborted||!socket.connected){release();return;}
                if(nextUdpLease>0xffffffff){release();udpReply(id,{error:{code:10055,message:"UDP lease identity exhausted"}});return;}
                const leaseId=nextUdpLease++;udpLeases.set(leaseId,{requestId:id,request:entry.request,release});udpReply(id,{leaseId});
            },error=>{
                if(!controller.signal.aborted)udpReply(id,{error:{code:typeof error?.code==="number"?error.code:10050,message:"UDP peer lease refused"}});
            }).finally(()=>udpPending.delete(id));
        });
        socket.on("cancelUdpPeer",id=>{
            if(!withinLimits(16))return;
            udpPending.get(id)?.controller.abort();
            // An ACK may already be queued when cancellation arrives.
            for(const [leaseId,lease]of udpLeases)if(lease.requestId===id){udpLeases.delete(leaseId);lease.release();}
        });
        socket.on("releaseUdpPeer",id=>{
            if(!withinLimits(16))return;
            const lease=udpLeases.get(id);if(!lease)return;udpLeases.delete(id);lease.release();
        });
        const resolving = new Map<number, { cancelled: boolean }>();
        const resolveReply = (id: number, reply: import("./resolve").ResolveReply): void => {
            if (!socket.connected) return;
            const bytes = JSON.stringify(reply).length * 2 + 32;
            if (congested(socket, bytes)) { socket.disconnect(true); return; }
            queue.frames++; queue.bytes += bytes;
            socket.emit("resolved", id, reply);
        };
        socket.on("resolve", (id, request) => {
            if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || resolving.has(id)) return;
            if (resolving.size >= 16) { resolveReply(id, { error: { code: "TRY_AGAIN", message: "Too many DNS requests" } }); return; }
            const entry = { cancelled: false };
            resolving.set(id, entry);
            void gatewayRoutes.resolve(request, allowedRoutes).then(
                result => { if (!entry.cancelled) resolveReply(id, { result }); },
                error => { if (!entry.cancelled) {
                    const failure = error instanceof NetResolveError ? error : new NetResolveError("NO_RECOVERY");
                    resolveReply(id, { error: { code: failure.code, message: failure.message } });
                } },
            ).finally(() => resolving.delete(id));
        });
        socket.on("cancelResolve", id => { const entry = resolving.get(id); if (entry) entry.cancelled = true; });
        // At most one entry per UDP port. Tombstones stay until this connection
        // retires; evicting them would let delayed multicast revive a closed bind.
        const udpBindings = new Map<number, {generation: number; released: boolean}>();
        const admitUdp = (port: number, generation: number | undefined): boolean => {
            const previous = udpBindings.get(port);
            if (generation === undefined) return previous === undefined;
            if (previous && (generation < previous.generation || generation === previous.generation && previous.released)) return false;
            if (!previous || generation > previous.generation) udpBindings.set(port, {generation, released: false});
            return true;
        };
        let windowStart = Date.now(), frames = 0, bytes = 0;
        const withinLimits = (size: number): boolean => {
            const now = Date.now();
            if (now - windowStart >= 1000) { windowStart = now; frames = 0; bytes = 0; }
            if (++frames > limits.maxFramesPerSecond || (bytes += size) > limits.maxBytesPerSecond) {
                socket.disconnect(true); return false;
            }
            return true;
        };
        socket.on("releasePort", (proto, port, generation) => {
            if (!isProtocol(proto) || !validPort(port) || !validBindingGeneration(generation)) { socket.disconnect(true); return; }
            if (withinLimits(16)) {
                if (proto === PROTO_UDP && generation >= (udpBindings.get(port)?.generation ?? 0)) udpBindings.set(port, {generation, released: true});
                if(proto===PROTO_TCP && generation >= (tcpBindings.get(port)?.generation ?? 0)) {
                    tcpBindings.set(port,{generation,released:true});retireTcp(port,generation,true);
                }
                retireUdpLeases(proto,port,generation,true);gateway.releasePort(proto, port, generation);
            }
        });
        socket.on("frame", (input, generation) => {
            const frame = asBytes(input);
            const datagram = frame && decodeDatagram(frame);
            if (!frame || !datagram || (generation !== undefined && !validBindingGeneration(generation))) { socket.disconnect(true); return; }
            if (!withinLimits(frame.byteLength)) return;
            datagram.bindingGeneration = generation;
            if(generation!==undefined)retireUdpLeases(datagram.proto,datagram.srcPort,generation,false);
            const multicast = datagram.multicast4;
            if (multicast) {
                // The shared decoder accepts the reverse, server-to-client form
                // too. Only an exact group destination is legal in this direction.
                if (!isMulticastIpv4Node(datagram.node)) { socket.disconnect(true); return; }
                if (!admitUdp(datagram.srcPort, generation)) return;
                if (multicast.interfaceIndex === 1 || multicast.ttl === 0) return;
            } else {
                // Observe tagged ordinary UDP without changing its established
                // routing; a later multicast cannot regress this binding epoch.
                if (datagram.proto === PROTO_UDP) admitUdp(datagram.srcPort, generation);
                if(datagram.proto===PROTO_TCP && isExternalNode(datagram.node)){
                    const binding=tcpBindings.get(datagram.srcPort);
                    if(binding&&(generation===undefined||generation<binding.generation||
                        generation===binding.generation&&binding.released))return;
                    if(generation!==undefined && binding && generation>binding.generation){
                        retireTcp(datagram.srcPort,generation,false);
                        tcpBindings.set(datagram.srcPort,{generation,released:false});
                    }
                    let owned=false;
                    for(const owner of tcpOwners) {
                        if(owner.ownsBinding(datagram.srcPort,generation))owned=true;
                        if(owner.handle(datagram))return;
                    }
                    if(owned)return;
                }
                if (gateway.handle(datagram)) return;
            }
            const broadcast = !multicast && isBroadcastNode(datagram.node);
            const destination = broadcast || multicast ? null : room.peers.get(nodeKey(datagram.node));
            const forwarded = frame.slice();
            forwarded.set(lease.node, 2);
            if (multicast) forwarded[16] = 2; // Trusted virtual LAN ingress.
            const unreliable = isDatagramProtocol(datagram.proto);
            if (!unreliable && destination && !destination.socket) notifyPeerLeft(socket, destination.node);
            const deliver = (peer: Lease): void => {
                const recipient = peer.socket;
                if (!recipient || recipient === socket) return;
                if (congested(recipient, forwarded.byteLength)) {
                    // Reliable streams must fail visibly instead of silently losing a frame.
                    if (!unreliable) { recipient.disconnect(true); socket.disconnect(true); }
                    return;
                }
                const queued = pending.get(recipient)!;
                queued.frames++;
                queued.bytes += forwarded.byteLength;
                recipient.emit("frame", forwarded);
            };
            if (broadcast || multicast) { for (const peer of room.peers.values()) deliver(peer); }
            else if (destination) deliver(destination);
        });
        socket.on("disconnect", () => {
            if (expiration !== undefined) clearTimeout(expiration);
            bindingEntries-=portSlots.size;portSlots.clear();
            for(const pending of tcpPending.values())pending.controller.abort();
            tcpPending.clear();tcpActive.clear();
            for(const owner of tcpOwners)closeTcpOwner(owner,true);
            for(const pending of udpPending.values())pending.controller.abort();
            for(const lease of udpLeases.values())lease.release();udpLeases.clear();
            gateway.close();
            for (const entry of resolving.values()) entry.cancelled = true;
            if (lease.socket === socket) {
                lease.socket = null;
                lease.expiresAt = Date.now() + limits.reconnectGraceMs;
                for (const peer of room.peers.values()) if (peer.socket) notifyPeerLeft(peer.socket, lease.node);
                prune();
            }
        });
    });
    const cleanup = setInterval(prune, Math.max(1000, Math.min(30_000, limits.reconnectGraceMs)));
    cleanup.unref();
    return {
        io, http,
        listen: async () => {
            await gatewayRoutes.initialize();
            return new Promise<number>((resolve, reject) => {
            const fail = (error: Error) => { http.off("listening", ready); reject(error); };
            const ready = () => {
                http.off("error", fail);
                const address = http.address();
                if (!address || typeof address === "string") reject(new Error("LAN server has no TCP address"));
                else resolve(address.port);
            };
            http.once("error", fail);
            http.once("listening", ready);
            http.listen(options.port ?? 9001, options.host ?? "127.0.0.1");
            });
        },
        close: () => new Promise<void>(resolve => {
            clearInterval(cleanup);
            io.close(() => { rooms.clear(); resolve(); });
            http.closeAllConnections();
        }),
    };
}
