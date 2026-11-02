import type {WsaSocketTable,WsaAddress} from "../../wsa-network";
import {acquireDirectPlay4JoinListener,type DirectPlay4JoinListener} from "./join-listener";
import {acquireDirectPlay4JoinUdpListener,type DirectPlay4JoinUdpListener} from "./join-udp-listener";
import {runDirectPlay4JoinHandshake,type DirectPlay4JoinHandshakeOptions,type DirectPlay4JoinHandshakeResult,
    type DirectPlay4JoinSessionLease} from "./join-handshake";
import {DirectPlay4JoinNameTableOwner,type DirectPlay4OwnedNameTable} from "./join-name-table-owner";
import type {DirectPlay4SystemTcpFrame} from "./tcp-frame";
import {encodeDirectPlay4PlayerTcpFrame,type DirectPlay4PlayerTcpFrame} from "./player-tcp";
import {DirectPlay4CreatePlayer,type DirectPlay4CreatePlayerRequest,type DirectPlay4CreatePlayerResult} from "./create-player";
import {encodeDirectPlay4DestroyPlayer} from "./destroy-player";
import {decodeDirectPlay4CreatePlayer} from "./create-message";
import {applyDirectPlay4RemotePlayerMutation} from "./remote-player-mutation";
import {encodeDirectPlay4SystemTcpFrame} from "./tcp-frame";

/** Lifecycle scaffold only. It does not publish a COM Open or implement the
 * session data plane; unhandled pending messages fail closed. */
export interface DirectPlay4NativeSessionDriver {
    acquireTcp(signal:AbortSignal):Promise<DirectPlay4JoinListener>;
    acquireUdp(signal:AbortSignal):Promise<DirectPlay4JoinUdpListener>;
    handshake(tcp:DirectPlay4JoinListener,udp:DirectPlay4JoinUdpListener,signal:AbortSignal,current:()=>boolean):Promise<DirectPlay4JoinHandshakeResult>;
}
export interface DirectPlay4NativeSessionEvents {
    onSystem(frame:DirectPlay4SystemTcpFrame,peer:WsaAddress):void;
    /** Callback mode transfers accepted player frames instead of retaining a second queue copy. */
    playerDelivery?:"queue"|"callback";
    /** Ordered, immutable roster transition, delivered before onSystem. */
    onRosterChange?(change:DirectPlay4NativeRosterChange):void;
    /** Must bind claimed sender ID to the actual authorized peer/session. */
    authorizePlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress,table:DirectPlay4OwnedNameTable):boolean;
    /** True only for the host application player served by this exact channel. */
    authorizeHost?(playerId:number):boolean;
    /** Binds a remote player management request to its transport owner. */
    authorizeSystem?(playerId:number,peer:WsaAddress,systemPlayerId:number,table:DirectPlay4OwnedNameTable):boolean;
    onPlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void;
    onFailure(error:Error):void;
}
export interface DirectPlay4NativeRosterChange {
    readonly kind:"create"|"delete";
    readonly playerId:number;
    readonly before:DirectPlay4OwnedNameTable;
    readonly after:DirectPlay4OwnedNameTable;
}
/** Builds the real actor-backed driver. Caller must supply coherent discovery,
 * process epoch, destination and gateway policy callbacks to the handshake. */
export function nativeSessionDriver(table:WsaSocketTable,udpListener:string,options:Omit<DirectPlay4JoinHandshakeOptions,"table"|"tcp"|"udp"|"signal"|"current">):DirectPlay4NativeSessionDriver {
    const destination={...options.destination,node:Uint8Array.from(options.destination.node),
        ...(options.destination.ip?{ip:Uint8Array.from(options.destination.ip)}:{}),
        ...(options.destination.ip6?{ip6:Uint8Array.from(options.destination.ip6)}:{})};
    options={...options,destination,discovery:{...options.discovery,
        instanceGuid:Uint8Array.from(options.discovery.instanceGuid),applicationGuid:Uint8Array.from(options.discovery.applicationGuid)}};
    return {
        acquireTcp:signal=>acquireDirectPlay4JoinListener(table,options.timeoutMs,signal),
        acquireUdp:signal=>acquireDirectPlay4JoinUdpListener(table,udpListener,options.timeoutMs,signal),
        handshake:(tcp,udp,signal,current)=>runDirectPlay4JoinHandshake({...options,table,tcp,udp,signal,current}),
    };
}
export class DirectPlay4NativeSession {
    private state:"new"|"opening"|"active"|"closed"="new";
    private readonly aborter=new AbortController();
    private tcp?:DirectPlay4JoinListener; private udp?:DirectPlay4JoinUdpListener;
    private lease?:DirectPlay4JoinSessionLease; private pending?:DirectPlay4JoinHandshakeResult;
    private snapshot?:DirectPlay4OwnedNameTable;
    private creator?:DirectPlay4CreatePlayer;private creating=false;private destroying=false;private sending=false;private closing=false;
    private knownPlayers=new Set<number>();private localPlayers=new Set<number>();
    private queue:Array<{from:number;to:number;data:Uint8Array}>=[];
    private held:Array<{frame:DirectPlay4PlayerTcpFrame;peer:WsaAddress}>=[];
    private queuedBytes=0;
    private ingress:Array<{frame:DirectPlay4PlayerTcpFrame;peer:WsaAddress;roster?:DirectPlay4OwnedNameTable}>=[];
    private processingIngress=false;private mutatingRemote=false;
    private readonly playerDelivery:"queue"|"callback";
    private readonly onOwnerAbort=()=>this.close();
    constructor(private readonly driver:DirectPlay4NativeSessionDriver,
        private readonly owns:()=>boolean,private readonly events:DirectPlay4NativeSessionEvents,
        private readonly ownerSignal?:AbortSignal,private readonly onRetire?:()=>void){
        if(events.playerDelivery!==undefined&&events.playerDelivery!=="queue"&&events.playerDelivery!=="callback")throw new TypeError("invalid native player delivery mode");
        this.playerDelivery=events.playerDelivery??"queue";
        ownerSignal?.addEventListener("abort",this.onOwnerAbort,{once:true});
        if(ownerSignal?.aborted)this.close();
    }
    private isClosed():boolean{return this.state==="closed";}
    private current():boolean {
        if(this.isClosed()||this.aborter.signal.aborted)return false;
        let live=false;try{live=this.owns();}catch{}
        return live && !this.isClosed()&&!this.aborter.signal.aborted;
    }
    /** Returns staged owned data; this is not guest-visible Open success. */
    async open():Promise<DirectPlay4OwnedNameTable> {
        if(this.state!=="new")throw new Error("native session already used");
        this.state="opening";
        try{
            if(!this.current())throw new Error("native session owner retired");
            const tcp=await this.driver.acquireTcp(this.aborter.signal);
            if(!this.current()){tcp.release();throw new Error("native session owner retired");}
            this.tcp=tcp;
            const udp=await this.driver.acquireUdp(this.aborter.signal);
            if(!this.current()){udp.release();throw new Error("native session owner retired");}
            this.udp=udp;
            const result=await this.driver.handshake(tcp,udp,this.aborter.signal,()=>this.current());
            if(!this.current()){result.cancel();throw new Error("native session owner retired");}
            this.pending=result;
            const staged=new DirectPlay4JoinNameTableOwner(result.table,[result.playerId],4096,0x100000,()=>this.current());
            let snapshot=staged.commit();
            if(!snapshot||!this.current())throw new Error("native name table retired");
            const ids=new Set([...snapshot.players.map(p=>p.id),result.playerId]);
            const groups=new Set(snapshot.groups.map(g=>g.id));
            const active=()=>this.current()&&this.state==="active";
            // The handshake may synchronously drain frames into its new owner
            // before transfer() returns. Keep them in arrival order until the
            // lease, name table and creator are installed; reentrant arrivals
            // during the drain must stay behind the reserved frame.
            type Transition = {kind:"system";frame:DirectPlay4SystemTcpFrame;peer:WsaAddress;size:number;applied:boolean;change?:DirectPlay4NativeRosterChange}
                | {kind:"player";frame:DirectPlay4PlayerTcpFrame;peer:WsaAddress;size:number;roster?:DirectPlay4OwnedNameTable};
            const transition:Transition[]=[];let transitionBytes=0,draining=false;
            let drain!:()=>void;
            const receive=(kind:"system"|"player",frame:DirectPlay4SystemTcpFrame|DirectPlay4PlayerTcpFrame,peer:WsaAddress,applied=false,change?:DirectPlay4NativeRosterChange,roster?:DirectPlay4OwnedNameTable):void=>{
                if(this.isClosed()||this.aborter.signal.aborted)throw new Error("native session retired");
                {
                    const body=kind==="system"?(frame as DirectPlay4SystemTcpFrame).message:(frame as DirectPlay4PlayerTcpFrame).data;
                    if(!(body instanceof Uint8Array)||!(frame.providerSockaddr instanceof Uint8Array)||
                        !(peer.node instanceof Uint8Array))throw new TypeError("invalid native transition frame");
                    // Each historical pending state owns a new player-reference
                    // array and description. Charge these retained snapshots as
                    // well as the wire frame against the transition budget.
                    const historical=change?.after??roster;
                    const history=historical?(historical.players.length+historical.sessionDescription.length)*8:0;
                    const size=body.length+frame.providerSockaddr.length+peer.node.length+(peer.ip?.length??0)+(peer.ip6?.length??0)+history;
                    if(transition.length>=256||size>0x100000-transitionBytes)throw new RangeError("native transition queue full");
                    const source={...peer,node:Uint8Array.from(peer.node),...(peer.ip?{ip:Uint8Array.from(peer.ip)}:{}),
                        ...(peer.ip6?{ip6:Uint8Array.from(peer.ip6)}:{})};
                    if(kind==="system"){
                        const f=frame as DirectPlay4SystemTcpFrame;
                        transition.push({kind,frame:{...f,message:Uint8Array.from(body),providerSockaddr:Uint8Array.from(f.providerSockaddr)},peer:source,size,applied,change});
                    }else{
                        const f=frame as DirectPlay4PlayerTcpFrame;
                        transition.push({kind,frame:{...f,data:Uint8Array.from(body),providerSockaddr:Uint8Array.from(f.providerSockaddr)},peer:source,size,roster});
                    }
                    transitionBytes+=size;
                    // Reserve before the owner callback: it may reenter ingress.
                    if(!this.current())throw new Error("native session retired");
                    if(this.state==="active"&&!draining)drain();
                }
            };
            drain=():void=>{
                draining=true;
                try{
                    while(transition.length){
                        if(!active())throw new Error("native session retired");
                        const item=transition[0];
                        if(item.kind==="system"){
                            if(!this.creator?.receive(item.frame))this.remoteSystem(item.frame,item.peer,item.applied,item.change);
                        }else this.incomingPlayer(item.frame,item.peer,item.roster);
                        if(!active())throw new Error("native session retired");
                        transition.shift();transitionBytes-=item.size;
                    }
                }finally{draining=false;transition.length=0;transitionBytes=0;}
            };
            const lease=result.transfer({signal:this.aborter.signal,current:()=>this.current(),
                exists:(kind,id)=>kind==="player"?ids.has(id):groups.has(id),
                // Replay into the still-private name table before publishing it.
                // Unsupported mutations continue to fail closed.
                applyPending:message=>{
                    const b=message.bytes,p=message.peer,h=message.header;
                    if(!(b instanceof Uint8Array)||b.length<8||b.length>60008||message.sendFlags!==0||
                        !(h instanceof Uint8Array)||h.length!==16||!p||p.family!==2||
                        !Number.isInteger(p.port)||p.port<1||p.port>65535||
                        !(p.node instanceof Uint8Array)||p.node.length!==6||p.node[0]!==2||p.node[1]!==1||
                        !(p.ip instanceof Uint8Array)||p.ip.length!==4||!p.ip.every((x,i)=>x===p.node[i+2]))
                        throw new Error("invalid native pending provenance");
                    const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
                    if(message.kind==="player"){
                        receive("player",{consumed:20+b.length,providerSockaddr:h,from:view.getUint32(0,true),to:view.getUint32(4,true),data:b.subarray(8)},p,false,undefined,snapshot!);
                        return;
                    }
                    if(message.kind!=="system"||view.getUint32(0,true)!==0x79616c70||
                        view.getUint16(6,true)!==snapshot!.version)
                        throw new Error("native pending replay unsupported");
                    const command=view.getUint16(4,true);
                    if(command===8){
                        const parsed=decodeDirectPlay4CreatePlayer(b,65536),entry=parsed.player,id=parsed.playerId;
                        const system=snapshot!.players.find(x=>x.id===entry.versionOrSystemId);
                        if(ids.has(id)||groups.has(id)||snapshot!.players.length+snapshot!.groups.length+snapshot!.shortcuts.length>=4096||
                            entry.flags!==8||entry.version!==snapshot!.version||entry.parentId!==0||entry.spData.length!==32||
                            !system||!(system.flags&1)||system.preexisting||typeof this.events.authorizeSystem!=="function")
                            throw new Error("native pending create unavailable");
                        const source={family:p.family,port:p.port,node:Uint8Array.from(p.node),ip:Uint8Array.from(p.ip)},before=snapshot!;
                        if(!this.events.authorizeSystem(id,source,entry.versionOrSystemId,before)||!this.current()||this.state!=="opening"||snapshot!==before)
                            throw new Error("native pending create unauthorized");
                        const freeze=(data:Uint8Array|null)=>data===null?null:Object.freeze([...data]);
                        const player=Object.freeze({id,flags:entry.flags,fixedSize:entry.fixedSize,preexisting:false,
                            versionOrSystemId:entry.versionOrSystemId,version:entry.version,parentId:entry.parentId,
                            shortName:freeze(entry.shortName),longName:freeze(entry.longName),
                            spData:freeze(entry.spData)!,playerData:freeze(entry.playerData)!,memberIds:Object.freeze([] as number[]),
                            ...(entry.ordinaryBytes?{ordinaryBytes:freeze(entry.ordinaryBytes)!}:{})});
                        const players=Object.freeze([...before.players,player]);
                        const description=Uint8Array.from(snapshot!.sessionDescription);
                        new DataView(description.buffer).setUint32(44,players.filter(x=>!(x.flags&1)).length,true);
                        snapshot=Object.freeze({...snapshot!,players,sessionDescription:Object.freeze([...description])});
                        ids.add(id);
                        receive("system",{consumed:20+b.length,providerSockaddr:h,message:b,command,version:parsed.version},p,true,
                            Object.freeze({kind:"create",playerId:id,before,after:snapshot}));
                        return;
                    }
                    if(command!==11||b.length!==28)throw new Error("native pending replay unsupported");
                    const id=view.getUint32(12,true),target=snapshot!.players.find(x=>x.id===id);
                    // System-player teardown and group membership need their
                    // own ordered notifications and are not replayed here.
                    if(!target||target.preexisting||(target.flags&1)||snapshot!.groups.some(g=>g.memberIds.includes(id))||
                        typeof this.events.authorizeSystem!=="function")
                        throw new Error("native pending delete unavailable");
                    const source={family:p.family,port:p.port,node:Uint8Array.from(p.node),ip:Uint8Array.from(p.ip)},before=snapshot!;
                    if(!this.events.authorizeSystem(id,source,target.versionOrSystemId,before)||!this.current()||this.state!=="opening"||snapshot!==before)
                        throw new Error("native pending delete unauthorized");
                    const players=Object.freeze(before.players.filter(x=>x.id!==id));
                    // NT5 rebuilds the application-player count while unpacking,
                    // then decrements it when a non-system player is removed.
                    const description=Uint8Array.from(snapshot!.sessionDescription);
                    new DataView(description.buffer).setUint32(44,players.filter(x=>!(x.flags&1)).length,true);
                    snapshot=Object.freeze({...snapshot!,players,sessionDescription:Object.freeze([...description])});
                    ids.delete(id);
                    receive("system",{consumed:20+b.length,providerSockaddr:h,message:b,command:11,version:view.getUint16(6,true)},p,true,
                        Object.freeze({kind:"delete",playerId:id,before,after:snapshot}));
                },
                onFrame:(frame,peer)=>receive("system",frame,peer),
                onPlayerFrame:(frame,peer)=>receive("player",frame,peer),
                onFailure:error=>{if(this.state!=="closed"){this.close();this.events.onFailure(error);}},
            });
            if(!this.current()){lease.release();throw new Error("native session owner retired");}
            this.pending=undefined;this.lease=lease;
            this.tcp=undefined;this.udp=undefined;this.snapshot=snapshot;
            this.knownPlayers=new Set(ids);
            this.creator=new DirectPlay4CreatePlayer({signal:lease.signal,current:lease.current,send:lease.send,
                version:lease.version,systemPlayerId:lease.systemPlayerId,tcpSockaddr:lease.tcpSockaddr,udpSockaddr:lease.udpSockaddr,
                onUncertain:()=>this.close()},30000,65536);
            this.state="active";
            if(!active())throw new Error("native session owner retired");
            drain();
            if(!active()||!this.snapshot)throw new Error("native session retired");
            // A live mutation can arrive during transfer and be drained above.
            return this.snapshot;
        }catch(error){this.close();throw error;}
    }
    private active():boolean{return this.state==="active"&&this.current()&&this.state==="active";}
    /** Frozen remote roster and session description for the current owner.
     * Locally created application players are tracked separately. */
    nameTable():DirectPlay4OwnedNameTable {
        if(!this.active()||!this.snapshot)throw new Error("native session unavailable");
        const snapshot=this.snapshot;
        if(!this.active()||this.snapshot!==snapshot)throw new Error("native session retired");
        return snapshot;
    }
    private withLocalPlayerCount(table:DirectPlay4OwnedNameTable):DirectPlay4OwnedNameTable {
        const description=Uint8Array.from(table.sessionDescription);
        if(description.length!==80)throw new Error("invalid native session description");
        const remote=table.players.filter(p=>!(p.flags&1)).length;
        new DataView(description.buffer).setUint32(44,remote+this.localPlayers.size,true);
        return Object.freeze({...table,sessionDescription:Object.freeze([...description])});
    }
    private remoteSystem(frame:DirectPlay4SystemTcpFrame,peer:WsaAddress,applied:boolean,change?:DirectPlay4NativeRosterChange):void {
        if(!applied&&(frame.command===8||frame.command===11)){
            if(this.mutatingRemote||!this.snapshot||!this.events.authorizeSystem)throw new Error("remote player owner unavailable");
            if(!(frame.message instanceof Uint8Array)||frame.message.length<8||frame.message.length>60008)
                throw new Error("remote player command mismatch");
            const bytes=Uint8Array.from(frame.message);
            if(new DataView(bytes.buffer).getUint16(4,true)!==frame.command)throw new Error("remote player command mismatch");
            this.mutatingRemote=true;
            try {
                const before=this.snapshot;
                const next=applyDirectPlay4RemotePlayerMutation(before,bytes,peer,this.events.authorizeSystem,
                    ()=>this.active()&&this.snapshot===before);
                if(!this.active()||this.snapshot!==before)throw new Error("remote player owner retired");
                const id=new DataView(bytes.buffer).getUint32(12,true);
                if(this.localPlayers.has(id))throw new Error("remote player identity is local");
                const known=new Set(this.knownPlayers);
                if(frame.command===8)known.add(id);else known.delete(id);
                this.snapshot=this.withLocalPlayerCount(next);this.knownPlayers=known;
                change=Object.freeze({kind:frame.command===8?"create":"delete",playerId:id,before,after:this.snapshot});
            } finally {this.mutatingRemote=false;}
        }
        if(!this.active())throw new Error("native session retired");
        if(change)this.events.onRosterChange?.(change);
        if(!this.active())throw new Error("native session retired");
        this.events.onSystem(frame,peer);
    }
    private incomingPlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress,roster?:DirectPlay4OwnedNameTable):void {
        // Reserve before any external liveness or authorization callback; a
        // reentrant ingress is appended behind the currently reserved item.
        if(this.state!=="active"||this.aborter.signal.aborted||!(frame.data instanceof Uint8Array)||frame.data.length>60000||
            !(frame.providerSockaddr instanceof Uint8Array)||frame.providerSockaddr.length!==16)
            throw new Error("native player frame unavailable");
        if(this.queue.length+this.held.length+this.ingress.length>=256||frame.data.length>0x100000-this.queuedBytes)
            throw new RangeError("native receive queue full");
        frame={...frame,data:Uint8Array.from(frame.data),providerSockaddr:Uint8Array.from(frame.providerSockaddr)};
        peer={...peer,node:Uint8Array.from(peer.node),...(peer.ip?{ip:Uint8Array.from(peer.ip)}:{}),...(peer.ip6?{ip6:Uint8Array.from(peer.ip6)}:{})};
        this.ingress.push({frame,peer,roster});this.queuedBytes+=frame.data.length;
        if(this.processingIngress)return;
        this.processingIngress=true;
        try {
            while(this.ingress.length){
                const item=this.ingress[0],f=item.frame,p=item.peer;
                const candidate={...f,data:Uint8Array.from(f.data),providerSockaddr:Uint8Array.from(f.providerSockaddr)};
                const candidatePeer={...p,node:Uint8Array.from(p.node),...(p.ip?{ip:Uint8Array.from(p.ip)}:{}),...(p.ip6?{ip6:Uint8Array.from(p.ip6)}:{})};
                const currentRoster=this.snapshot,authorizationRoster=item.roster??currentRoster;
                if(!currentRoster||!authorizationRoster||!this.active()||!this.events.authorizePlayer(candidate,candidatePeer,authorizationRoster)||!this.active()||this.snapshot!==currentRoster)
                    throw new Error("native player identity unauthorized");
                // NT5 handler.c:4401-4473 drops unknown source/target and system target.
                const accept=this.knownPlayers.has(f.from)&&f.from!==f.to&&(this.creating||this.localPlayers.has(f.to));
                if(accept){if(this.creating)this.held.push(item);else this.deliverPlayer(f,p);}
                else this.queuedBytes-=f.data.length;
                this.ingress.shift();
            }
        }catch(error){this.close();throw error;}finally{this.processingIngress=false;}
    }
    private deliverPlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void {
        if(!this.active())throw new Error("native session unavailable");
        if(!this.localPlayers.has(frame.to)){this.queuedBytes-=frame.data.length;return;}
        if(this.playerDelivery==="queue")this.queue.push({from:frame.from,to:frame.to,data:frame.data});
        else this.queuedBytes-=frame.data.length;
        this.events.onPlayer({...frame,data:Uint8Array.from(frame.data)},peer);
        if(!this.active())throw new Error("native session retired");
    }
    /** Submitted does not mean that the host acknowledged the player. */
    async createPlayer(request:DirectPlay4CreatePlayerRequest, publish?:(result:DirectPlay4CreatePlayerResult)=>void):Promise<DirectPlay4CreatePlayerResult> {
        if(this.creating||this.destroying||this.sending||this.closing)throw new Error("native session unavailable");
        this.creating=true;let submitted=false;
        try{
            if(!this.active()||!this.creator)throw new Error("native session unavailable");
            const creator=this.creator;
            const result=await creator.create(request);submitted=true;
            if(!this.active()||this.creator!==creator||this.knownPlayers.has(result.playerId))throw new Error("native player identity unavailable");
            this.knownPlayers.add(result.playerId);this.localPlayers.add(result.playerId);
            if(this.snapshot)this.snapshot=this.withLocalPlayerCount(this.snapshot);
            // Guest ownership must be installed before held player data is released.
            if(publish){publish({...result});if(!this.active()||this.creator!==creator)throw new Error("native session retired");}
            while(this.held.length){const item=this.held.shift()!;this.deliverPlayer(item.frame,item.peer);}
            if(!this.active()||this.creator!==creator)throw new Error("native session retired");
            return result;
        }catch(error){
            if(submitted)this.close();
            else if(this.state==="active"){
                try{while(this.held.length){const item=this.held.shift()!;this.deliverPlayer(item.frame,item.peer);}}
                catch{this.close();}
            }
            throw error;
        }finally{this.creating=false;}
    }
    /** Submit a normal guaranteed player frame on the channel to the explicitly
     * authorized host. This is WSA submission, not a host acknowledgement. */
    async sendToHost(from:number,to:number,data:Uint8Array):Promise<{submission:"submitted"}> {
        if(this.creating||this.destroying||this.sending||this.closing)throw new Error("native session unavailable");
        this.sending=true;
        let attempted=false,timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
        const lease=this.lease;
        try{
            if(!(data instanceof Uint8Array)||data.length>60000)throw new RangeError("invalid native player payload");
            // Snapshot before any owner or authorization callback can reenter.
            const payload=Uint8Array.from(data);
            const eligible=()=>{
                if(!this.active()||!lease||this.lease!==lease||lease.signal.aborted||
                    !this.localPlayers.has(from)||this.localPlayers.has(to)||
                    !this.snapshot?.players.some(p=>p.id===to&&!(p.flags&1))||
                    typeof this.events.authorizeHost!=="function")return false;
                const authorized=this.events.authorizeHost(to);
                return !!authorized&&this.active()&&this.lease===lease&&!lease.signal.aborted&&
                    this.localPlayers.has(from)&&!this.localPlayers.has(to);
            };
            if(!eligible()||!lease)throw new Error("native host player unavailable");
            const wire=encodeDirectPlay4PlayerTcpFrame(lease.tcpSockaddr,from,to,payload,65536);
            const cancelled=new Promise<never>((_,reject)=>{
                abort=()=>reject(new Error("native send cancelled"));
                this.aborter.signal.addEventListener("abort",abort,{once:true});
                lease.signal.addEventListener("abort",abort,{once:true});
                timer=setTimeout(()=>reject(new Error("native send timeout")),30000);
            });
            void cancelled.catch(()=>{});
            if(!eligible())throw new Error("native host player unavailable");
            attempted=true;
            await Promise.race([Promise.resolve().then(()=>{
                if(!eligible())throw new Error("native host player unavailable");
                return lease.sendPlayer(wire);
            }),cancelled]);
            if(!eligible())throw new Error("native session retired");
            return {submission:"submitted"};
        }catch(error){if(attempted)this.close();throw error;}
        finally{
            if(timer)clearTimeout(timer);
            this.aborter.signal.removeEventListener("abort",abort);
            lease?.signal.removeEventListener("abort",abort);
            this.sending=false;
        }
    }
    /** WSA accepted cmd11; the native host does not acknowledge this operation. */
    async destroyPlayer(playerId:number):Promise<{submission:"submitted"}> {
        // Reserve before current() or other reentrant owner callbacks.
        if(this.creating||this.destroying||this.sending||this.closing)throw new Error("native session unavailable");
        this.destroying=true;
        let attempted=false,timer:ReturnType<typeof setTimeout>|undefined;
        let abort:()=>void=()=>{};
        const lease=this.lease;
        try{
            if(!this.active()||!lease||this.lease!==lease||!this.localPlayers.has(playerId))
                throw new Error("native local player unavailable");
            const inner=encodeDirectPlay4DestroyPlayer(playerId,lease.version);
            const wire=encodeDirectPlay4SystemTcpFrame(lease.tcpSockaddr,inner,65536);
            const cancelled=new Promise<never>((_,reject)=>{
                abort=()=>reject(new Error("native destroy cancelled"));
                this.aborter.signal.addEventListener("abort",abort,{once:true});
                lease.signal.addEventListener("abort",abort,{once:true});
                timer=setTimeout(()=>reject(new Error("native destroy timeout")),30000);
            });
            // Owner checks may synchronously retire the session before the race is installed.
            void cancelled.catch(()=>{});
            if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
            attempted=true;
            await Promise.race([Promise.resolve().then(()=>{
                if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
                return lease.send(wire);
            }),cancelled]);
            if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
            this.localPlayers.delete(playerId);this.knownPlayers.delete(playerId);
            if(this.snapshot)this.snapshot=this.withLocalPlayerCount(this.snapshot);
            this.queue=this.queue.filter(item=>{if(item.to!==playerId)return true;this.queuedBytes-=item.data.length;return false;});
            return {submission:"submitted"};
        }catch(error){if(attempted)this.close();throw error;}
        finally{
            if(timer)clearTimeout(timer);
            this.aborter.signal.removeEventListener("abort",abort);
            lease?.signal.removeEventListener("abort",abort);
            this.destroying=false;
        }
    }
    /** Submit cmd11 for local application players, then the system player.
     * Completion means WSA accepted the frames and the owned channel was
     * retired; DP4 does not provide a host acknowledgement for these frames. */
    async gracefulClose():Promise<{submission:"submitted"}> {
        if(this.creating||this.destroying||this.sending||this.closing)throw new Error("native session unavailable");
        this.closing=true;
        let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
        const lease=this.lease;
        try{
            if(!this.active()||!lease||this.lease!==lease||lease.signal.aborted)
                throw new Error("native session unavailable");
            const ids=[...this.localPlayers,lease.systemPlayerId];
            const cancelled=new Promise<never>((_,reject)=>{
                abort=()=>reject(new Error("native close cancelled"));
                this.aborter.signal.addEventListener("abort",abort,{once:true});
                lease.signal.addEventListener("abort",abort,{once:true});
                timer=setTimeout(()=>reject(new Error("native close timeout")),30000);
            });
            void cancelled.catch(()=>{});
            for(const id of ids){
                if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
                const wire=encodeDirectPlay4SystemTcpFrame(lease.tcpSockaddr,encodeDirectPlay4DestroyPlayer(id,lease.version),65536);
                await Promise.race([Promise.resolve().then(()=>{
                    if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
                    return lease.send(wire);
                }),cancelled]);
                if(!this.active()||this.lease!==lease||lease.signal.aborted)throw new Error("native session retired");
            }
            return {submission:"submitted"};
        }finally{
            if(timer)clearTimeout(timer);
            this.aborter.signal.removeEventListener("abort",abort);
            lease?.signal.removeEventListener("abort",abort);
            this.close();
            this.closing=false;
        }
    }
    /** Returns an owned message matching optional filters; peek leaves it queued. */
    receive(from?:number,to?:number,peek=false):{from:number;to:number;data:Uint8Array}|undefined {
        if(!this.active())throw new Error("native session unavailable");
        const index=this.queue.findIndex(m=>(from===undefined||m.from===from)&&(to===undefined||m.to===to));
        if(index<0)return;
        const item=this.queue[index],result={from:item.from,to:item.to,data:Uint8Array.from(item.data)};
        if(!peek){this.queue.splice(index,1);this.queuedBytes-=item.data.length;}return result;
    }
    close():void {
        if(this.state==="closed")return;
        this.state="closed";this.ownerSignal?.removeEventListener("abort",this.onOwnerAbort);this.aborter.abort();
        const pending=this.pending,lease=this.lease,tcp=this.tcp,udp=this.udp;
        this.pending=undefined;this.lease=undefined;this.tcp=undefined;this.udp=undefined;this.snapshot=undefined;
        this.creator?.close();this.creator=undefined;this.knownPlayers.clear();this.localPlayers.clear();
        this.queue.length=0;this.held.length=0;this.ingress.length=0;this.queuedBytes=0;
        try{pending?.cancel();}catch{}
        try{lease?.release();}catch{}
        try{tcp?.release();}catch{}
        try{udp?.release();}catch{}
        try{this.onRetire?.();}catch{}
    }
}
