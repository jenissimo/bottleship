import {WSA,WsaFailure,WsaOwnedSocketOutcomeUnknown,WsaSocketTable,type WsaAddress} from "../../wsa-network";
import {decodeDirectPlay4SystemTcpFrame,type DirectPlay4SystemTcpFrame} from "./tcp-frame";
import {DirectPlay4MixedTcpStream} from "./mixed-tcp-stream";
import {decodeDirectPlay4PlayerTcpFrame,type DirectPlay4PlayerTcpFrame} from "./player-tcp";
import type {DirectPlay4JoinListener} from "./join-listener";
import {isExternalIpv4Node} from "../../../net/netplay-wire";

/** Isolated Join transport, not a session or proof of native interoperability. */
export interface DirectPlay4JoinChannelOptions {
    destination:WsaAddress;
    listener:DirectPlay4JoinListener;
    /** Caller must synchronously abort on every attempt or owner invalidation. */
    signal:AbortSignal;
    /** Includes the discovery attempt, process epoch and any other caller-owned state. */
    current():boolean;
    /** Additional local policy; gateway still authorizes the actual outgoing route. */
    authorizeDestination(address:WsaAddress):boolean;
    /** Additional local source policy; gateway listener still enforces its ACL. */
    authorizePeer(address:WsaAddress):boolean;
    onFrame(frame:DirectPlay4SystemTcpFrame,peer:WsaAddress):void;
    onPlayerFrame?(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void;
    onFailure(error:Error):void;
    /** Retire the issuing process/actor before any retry after unknown mutation outcome. */
    onOwnershipUncertain(error:Error):void;
    timeoutMs:number; maxFrameBytes:number; maxChildren:number; maxWriteBytes:number;
}
type SocketRef={id:number;generation:number;object:number};
type Child={ref:SocketRef;reader:DirectPlay4MixedTcpStream;peer?:WsaAddress};
type Write={bytes:Uint8Array;offset:number;resolve:()=>void;reject:(error:Error)=>void};
const blocked=(error:unknown)=>error instanceof WsaFailure && error.code===WSA.EWOULDBLOCK;
const copyAddress=(a:WsaAddress):WsaAddress=>({
    ...a,node:Uint8Array.from(a.node),...(a.ip?{ip:Uint8Array.from(a.ip)}:{}),
    ...(a.ip6?{ip6:Uint8Array.from(a.ip6)}:{}),
});

/**
 * Caller owns the listener. This object owns its outgoing and accepted sockets.
 * close() terminates pending writes and releases only exact owned socket objects.
 */
export class DirectPlay4JoinChannel {
    private readonly destination:WsaAddress;
    private readonly options:DirectPlay4JoinChannelOptions;
    private readonly generation:number;
    private outgoing?:SocketRef;
    private readonly children=new Map<number,Child>();
    private readonly writes:Write[]=[];
    private writeBytes=0;
    private closed=false;
    private scheduled=false;
    private pumping=false;
    private unsubscribe=()=>{};
    private timer?:ReturnType<typeof setTimeout>;
    private deadline:number;
    private readonly abort=()=>this.fail(new Error("Join attempt cancelled"));
    constructor(private readonly table:WsaSocketTable,options:DirectPlay4JoinChannelOptions) {
        const o=options && {...options};
        if(!o||!o.listener||!o.signal||typeof o.signal.addEventListener!=="function"||!Number.isInteger(o.timeoutMs)||o.timeoutMs<1||o.timeoutMs>30000||
            !Number.isInteger(o.maxFrameBytes)||o.maxFrameBytes<28||o.maxFrameBytes>65536||
            !Number.isInteger(o.maxChildren)||o.maxChildren<1||o.maxChildren>32||
            o.maxFrameBytes*o.maxChildren>4*1024*1024||
            !Number.isInteger(o.maxWriteBytes)||o.maxWriteBytes<o.maxFrameBytes||o.maxWriteBytes>4*1024*1024||
            !o.destination||o.destination.family!==2||!(o.destination.node instanceof Uint8Array)||o.destination.node.length!==6||
            !(o.destination.ip instanceof Uint8Array)||o.destination.ip.length!==4||!isExternalIpv4Node(o.destination.node)||
            !o.destination.ip.every((value,index)=>value===o.destination.node[index+2])||
            !Number.isInteger(o.destination.port)||o.destination.port<1||o.destination.port>65535||
            !["current","authorizeDestination","authorizePeer","onFrame","onFailure","onOwnershipUncertain"].every(key=>typeof (o as any)[key]==="function"))
            throw new RangeError("invalid Join channel options");
        this.destination=copyAddress(o.destination);
        this.options={...o,destination:copyAddress(this.destination)};
        this.generation=table.generation;
        this.deadline=Date.now()+o.timeoutMs;
        try {
            o.signal.addEventListener("abort",this.abort,{once:true});
            if(!this.current()||!o.authorizeDestination(copyAddress(this.destination))||!this.current())
                throw new Error("Join destination or owner unavailable");
            const owned=this.owned(()=>table.socketOwned(1,2,6));
            if(!this.current()) {
                this.closeRef(owned);
                throw new Error("Join owner retired during socket creation");
            }
            const id=owned.id;
            this.outgoing=owned;
            this.unsubscribe=table.subscribe(()=>this.wake());
            if(this.closed)throw new Error("Join channel closed");
            this.timer=setTimeout(()=>this.fail(new Error("Join deadline exceeded")),o.timeoutMs);
            try {table.connect(id,copyAddress(this.destination));}
            catch(error){if(!blocked(error))throw error;}
            if(!this.current())throw new Error("Join owner retired during connect");
            this.wake();
        } catch(error) {
            this.close();
            throw error;
        }
    }
    private owned(call:()=>{handle:number;object:number}):SocketRef {
        try {
            const result=call();
            if(this.table.generation!==this.generation)throw new WsaOwnedSocketOutcomeUnknown(WSA.ENETDOWN);
            return {id:result.handle,generation:this.generation,object:result.object};
        } catch(error) {
            if(error instanceof WsaOwnedSocketOutcomeUnknown) {
                try{this.options.onOwnershipUncertain(error);}catch{}
            }
            throw error;
        }
    }
    private exact(ref:SocketRef):boolean {
        try{return this.table.generation===ref.generation && this.table.isValid(ref.id) && this.table.fileObjectId(ref.id)===ref.object;}
        catch{return false;}
    }
    private closeRef(ref?:SocketRef):void {try{if(ref&&this.exact(ref))this.table.closesocket(ref.id);}catch{}}
    private current():boolean {
        if(this.closed || this.options.signal.aborted || Date.now()>=this.deadline)return false;
        try {
            if(this.table.generation!==this.generation || !this.options.current() || !this.options.listener.current())return false;
            return !this.closed && !this.options.signal.aborted && Date.now()<this.deadline && this.table.generation===this.generation;
        }catch{return false;}
    }
    /** Queue one complete owned frame; completion means accepted by WSA, not delivered to peer. */
    send(frame:Uint8Array):Promise<void> {return this.enqueue(frame,false);}
    sendPlayer(frame:Uint8Array):Promise<void> {return this.enqueue(frame,true);}
    private enqueue(frame:Uint8Array,player:boolean):Promise<void> {
        if(!this.current())return Promise.reject(new Error("Join channel unavailable"));
        try {
            const decoded=player?decodeDirectPlay4PlayerTcpFrame(frame,this.options.maxFrameBytes):decodeDirectPlay4SystemTcpFrame(frame,this.options.maxFrameBytes);
            if(!decoded||decoded.consumed!==frame.length)throw new RangeError("expected one complete system frame");
            if(this.writes.length>=128||frame.length>this.options.maxWriteBytes-this.writeBytes)
                throw new RangeError("Join write queue full");
            const bytes=Uint8Array.from(frame);
            return new Promise((resolve,reject)=>{this.writes.push({bytes,offset:0,resolve,reject});this.writeBytes+=bytes.length;this.wake();});
        } catch(error) {return Promise.reject(error);}
    }
    private wake():void {
        if(this.closed||this.scheduled)return;
        this.scheduled=true;setTimeout(()=>{this.scheduled=false;this.pump();},0);
    }
    private pump():void {
        if(this.closed)return;
        if(this.pumping){this.wake();return;}
        this.pumping=true;
        try {
            if(!this.current()||!this.outgoing||!this.exact(this.outgoing))throw new Error("Join channel owner retired");
            const outgoing=this.outgoing;
            if(this.table.isConnected(outgoing.id)) {
                for(let i=0;i<4&&this.writes.length;i++) {
                    if(!this.current()||!this.exact(outgoing))throw new Error("Join outgoing owner retired");
                    const item=this.writes[0];
                    let n:number;
                    try{n=this.table.send(outgoing.id,item.bytes.subarray(item.offset));}
                    catch(error){if(blocked(error))break;throw error;}
                    if(!this.current()||!this.exact(outgoing))throw new Error("Join outgoing owner retired");
                    if(!Number.isInteger(n)||n<=0||n>item.bytes.length-item.offset)throw new Error("invalid Join write count");
                    item.offset+=n;
                    if(item.offset===item.bytes.length){this.writes.shift();this.writeBytes-=item.bytes.length;item.resolve();}
                    if(i===3&&this.writes.length)this.wake();
                }
            } else if(this.table.get(outgoing.id).state==="failed")throw new Error("Join connect failed");
            let accepted=0;
            for(;accepted<8;accepted++) {
                if(!this.current())throw new Error("Join listener retired");
                let ref:SocketRef;
                try{ref=this.owned(()=>this.table.acceptOwned(this.options.listener.socket));}
                catch(error){if(blocked(error))break;throw error;}
                const id=ref.id;
                if(!this.current()||this.children.size>=this.options.maxChildren){this.closeRef(ref);if(!this.current())throw new Error("Join owner retired");continue;}
                this.children.set(id,{ref,reader:new DirectPlay4MixedTcpStream(this.options.maxFrameBytes,32,Math.max(this.options.maxFrameBytes,65536))});
            }
            if(accepted===8)this.wake();
            for(const [id,child] of this.children) {
                for(let reads=0;reads<4;reads++) {
                    if(!this.current()||!this.exact(child.ref))throw new Error("Join child owner retired");
                    let packet:ReturnType<WsaSocketTable["receive"]>;
                    try{packet=this.table.receive(id,Math.min(65536,this.options.maxFrameBytes));}
                    catch(error){if(blocked(error))break;throw error;}
                    if(!this.current()||!this.exact(child.ref))throw new Error("Join child owner retired");
                    if(!packet.data.length){child.reader.finish();this.children.delete(id);this.closeRef(child.ref);break;}
                    const peer=packet.from;
                    if(!peer||peer.family!==2||!(peer.node instanceof Uint8Array)||!(peer.ip instanceof Uint8Array)||
                        peer.node.length!==6||peer.ip.length!==4||!isExternalIpv4Node(peer.node)||!Number.isInteger(peer.port)||peer.port<1||peer.port>65535||
                        !peer.ip.every((value,index)=>value===peer.node[index+2])||
                        (child.peer&&(child.peer.port!==peer.port||!child.peer.node.every((value,index)=>value===peer.node[index]))))
                        throw new Error("invalid Join reply peer");
                    if(!this.options.authorizePeer(copyAddress(peer))||!this.current()||!this.exact(child.ref))
                        throw new Error("Join reply peer unauthorized");
                    child.peer??=copyAddress(peer);
                    const frames=child.reader.push(packet.data);
                    for(const frame of frames) {
                        if(!this.current()||!this.exact(child.ref))throw new Error("Join reply owner retired");
                        if(frame.kind==="system")this.options.onFrame(frame.frame,copyAddress(child.peer));
                        else {
                            if(!this.options.onPlayerFrame)throw new Error("unsupported player frame");
                            this.options.onPlayerFrame(frame.frame,copyAddress(child.peer));
                        }
                        if(!this.current()||!this.exact(child.ref))throw new Error("Join reply owner retired");
                    }
                    if(reads===3)this.wake();
                }
            }
        }catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}
        finally{this.pumping=false;}
    }
    /** Stop the handshake deadline after the owner has accepted the channel. */
    retain():boolean {
        if(this.closed || Date.now()>=this.deadline)return false;
        if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.deadline=Number.POSITIVE_INFINITY;
        return true;
    }
    private fail(error:Error):void {
        if(this.closed)return;
        this.close();
        try{this.options.onFailure(error);}catch{}
    }
    close():void {
        if(this.closed)return;
        this.closed=true;this.options.signal.removeEventListener("abort",this.abort);this.unsubscribe();if(this.timer)clearTimeout(this.timer);
        for(const child of this.children.values())this.closeRef(child.ref);
        this.children.clear();this.closeRef(this.outgoing);this.outgoing=undefined;
        const error=new Error("Join channel closed");
        for(const item of this.writes.splice(0))item.reject(error);
        this.writeBytes=0;
    }
}
