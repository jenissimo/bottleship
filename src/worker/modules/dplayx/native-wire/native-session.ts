import type {WsaSocketTable,WsaAddress} from "../../wsa-network";
import {acquireDirectPlay4JoinListener,type DirectPlay4JoinListener} from "./join-listener";
import {acquireDirectPlay4JoinUdpListener,type DirectPlay4JoinUdpListener} from "./join-udp-listener";
import {runDirectPlay4JoinHandshake,type DirectPlay4JoinHandshakeOptions,type DirectPlay4JoinHandshakeResult,
    type DirectPlay4JoinSessionLease} from "./join-handshake";
import {DirectPlay4JoinNameTableOwner,type DirectPlay4OwnedNameTable} from "./join-name-table-owner";
import type {DirectPlay4SystemTcpFrame} from "./tcp-frame";
import type {DirectPlay4PlayerTcpFrame} from "./player-tcp";
import {DirectPlay4CreatePlayer,type DirectPlay4CreatePlayerRequest,type DirectPlay4CreatePlayerResult} from "./create-player";

/** Lifecycle scaffold only. It does not publish a COM Open or implement the
 * session data plane; unhandled pending messages fail closed. */
export interface DirectPlay4NativeSessionDriver {
    acquireTcp(signal:AbortSignal):Promise<DirectPlay4JoinListener>;
    acquireUdp(signal:AbortSignal):Promise<DirectPlay4JoinUdpListener>;
    handshake(tcp:DirectPlay4JoinListener,udp:DirectPlay4JoinUdpListener,signal:AbortSignal,current:()=>boolean):Promise<DirectPlay4JoinHandshakeResult>;
}
export interface DirectPlay4NativeSessionEvents {
    onSystem(frame:DirectPlay4SystemTcpFrame,peer:WsaAddress):void;
    /** Must bind claimed sender ID to the actual authorized peer/session. */
    authorizePlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):boolean;
    onPlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void;
    onFailure(error:Error):void;
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
    private creator?:DirectPlay4CreatePlayer;private creating=false;
    private knownPlayers=new Set<number>();private localPlayers=new Set<number>();
    private queue:Array<{from:number;to:number;data:Uint8Array}>=[];
    private held:Array<{frame:DirectPlay4PlayerTcpFrame;peer:WsaAddress}>=[];
    private queuedBytes=0;
    private ingress:Array<{frame:DirectPlay4PlayerTcpFrame;peer:WsaAddress}>=[];
    private processingIngress=false;
    constructor(private readonly driver:DirectPlay4NativeSessionDriver,
        private readonly owns:()=>boolean,private readonly events:DirectPlay4NativeSessionEvents){}
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
            const snapshot=staged.commit();
            if(!snapshot||!this.current())throw new Error("native name table retired");
            const ids=new Set([...snapshot.players.map(p=>p.id),result.playerId]);
            const groups=new Set(snapshot.groups.map(g=>g.id));
            const active=()=>this.current()&&this.state==="active";
            const lease=result.transfer({signal:this.aborter.signal,current:()=>this.current(),
                exists:(kind,id)=>kind==="player"?ids.has(id):groups.has(id),
                // State mutation/replay is a separate implementation slice.
                applyPending:()=>{throw new Error("native pending replay unsupported");},
                onFrame:(frame,peer)=>{if(!active())throw new Error("native session not active");if(!this.creator?.receive(frame))this.events.onSystem(frame,peer);},
                onPlayerFrame:(frame,peer)=>{this.incomingPlayer(frame,peer);},
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
            return snapshot;
        }catch(error){this.close();throw error;}
    }
    private active():boolean{return this.state==="active"&&this.current()&&this.state==="active";}
    private incomingPlayer(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void {
        // Reserve before any external liveness or authorization callback; a
        // reentrant ingress is appended behind the currently reserved item.
        if(this.state!=="active"||this.aborter.signal.aborted||!(frame.data instanceof Uint8Array)||frame.data.length>60000||
            !(frame.providerSockaddr instanceof Uint8Array)||frame.providerSockaddr.length!==16)
            throw new Error("native player frame unavailable");
        if(this.queue.length+this.held.length+this.ingress.length>=256||frame.data.length>0x100000-this.queuedBytes)
            throw new RangeError("native receive queue full");
        frame={...frame,data:Uint8Array.from(frame.data),providerSockaddr:Uint8Array.from(frame.providerSockaddr)};
        peer={...peer,node:Uint8Array.from(peer.node),...(peer.ip?{ip:Uint8Array.from(peer.ip)}:{}),...(peer.ip6?{ip6:Uint8Array.from(peer.ip6)}:{})};
        this.ingress.push({frame,peer});this.queuedBytes+=frame.data.length;
        if(this.processingIngress)return;
        this.processingIngress=true;
        try {
            while(this.ingress.length){
                const item=this.ingress[0],f=item.frame,p=item.peer;
                const candidate={...f,data:Uint8Array.from(f.data),providerSockaddr:Uint8Array.from(f.providerSockaddr)};
                const candidatePeer={...p,node:Uint8Array.from(p.node),...(p.ip?{ip:Uint8Array.from(p.ip)}:{}),...(p.ip6?{ip6:Uint8Array.from(p.ip6)}:{})};
                if(!this.active()||!this.events.authorizePlayer(candidate,candidatePeer)||!this.active())throw new Error("native player identity unauthorized");
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
        this.queue.push({from:frame.from,to:frame.to,data:frame.data});
        this.events.onPlayer({...frame,data:Uint8Array.from(frame.data)},peer);
        if(!this.active())throw new Error("native session retired");
    }
    /** Submitted does not mean that the host acknowledged the player. */
    async createPlayer(request:DirectPlay4CreatePlayerRequest):Promise<DirectPlay4CreatePlayerResult> {
        if(this.creating)throw new Error("native session unavailable");
        this.creating=true;let submitted=false;
        try{
            if(!this.active()||!this.creator)throw new Error("native session unavailable");
            const creator=this.creator;
            const result=await creator.create(request);submitted=true;
            if(!this.active()||this.creator!==creator||this.knownPlayers.has(result.playerId))throw new Error("native player identity unavailable");
            this.knownPlayers.add(result.playerId);this.localPlayers.add(result.playerId);
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
        this.state="closed";this.aborter.abort();
        const pending=this.pending,lease=this.lease,tcp=this.tcp,udp=this.udp;
        this.pending=undefined;this.lease=undefined;this.tcp=undefined;this.udp=undefined;this.snapshot=undefined;
        this.creator?.close();this.creator=undefined;this.knownPlayers.clear();this.localPlayers.clear();
        this.queue.length=0;this.held.length=0;this.ingress.length=0;this.queuedBytes=0;
        try{pending?.cancel();}catch{}
        try{lease?.release();}catch{}
        try{tcp?.release();}catch{}
        try{udp?.release();}catch{}
    }
}
