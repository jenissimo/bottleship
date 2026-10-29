import {WsaSocketTable,type WsaAddress} from "../../wsa-network";
import {DirectPlay4JoinChannel,type DirectPlay4JoinChannelOptions} from "./join-channel";
import type {DirectPlay4JoinListener} from "./join-listener";
import type {DirectPlay4JoinUdpListener} from "./join-udp-listener";
import {DirectPlay4JoinTransaction,type DirectPlay4JoinLease} from "./join-transaction";
import {DirectPlay4JoinPending,type DirectPlay4PendingResult,type DirectPlay4PendingMessage} from "./join-pending";
import type {DirectPlay4SystemTcpFrame} from "./tcp-frame";
import type {DirectPlay4PlayerTcpFrame} from "./player-tcp";
import type {DirectPlay4MixedTcpFrame} from "./mixed-tcp-stream";
import {encodeDirectPlay4RequestPlayerId,decodeDirectPlay4PlayerIdReply} from "./player-id";
import {encodeDirectPlay4PackedPlayer,encodeDirectPlay4TcpIpPlayerData} from "./packed-player";
import {encodeDirectPlay4AddForward,decodeDirectPlay4NameTable,type DirectPlay4NameTable} from "./name-table";
import {encodeDirectPlay4SystemTcpFrame} from "./tcp-frame";

/** Experimental isolated handshake; caller must abort synchronously on owner invalidation.
 * It never publishes a session or implements pending-message replay. */
export interface DirectPlay4JoinHandshakeOptions {
    table:WsaSocketTable; tcp:DirectPlay4JoinListener; udp:DirectPlay4JoinUdpListener;
    destination:WsaAddress; signal:AbortSignal; current():boolean;
    authorizeDestination(address:WsaAddress):boolean; authorizePeer(address:WsaAddress):boolean;
    onOwnershipUncertain(error:Error):void;
    timeoutMs:number; maxFrameBytes:number; maxEntries:number; maxPendingBytes:number;
    /** Exact discovery snapshot; unsupported secure/private/password modes fail closed. */
    discovery:{version:number;flags:number;instanceGuid:Uint8Array;applicationGuid:Uint8Array;reserved1:number};
}
export interface DirectPlay4JoinHandshakeResult {
    playerId:number; table:DirectPlay4NameTable;
    /** Atomically replay and transfer only after the table has been installed. */
    transfer(owner:DirectPlay4JoinSessionOwner):DirectPlay4JoinSessionLease;
    cancel():void;
}
export interface DirectPlay4JoinSessionLease extends DirectPlay4JoinLease {
    readonly signal:AbortSignal;
    readonly version:number; readonly systemPlayerId:number;
    readonly tcpSockaddr:Uint8Array; readonly udpSockaddr:Uint8Array;
    current():boolean; send(frame:Uint8Array):Promise<void>; sendPlayer(frame:Uint8Array):Promise<void>;
}
export interface DirectPlay4JoinSessionOwner {
    signal:AbortSignal; current():boolean;
    exists(kind:"player"|"group",id:number):boolean;
    applyPending(message:DirectPlay4PendingMessage):void;
    onFrame(frame:DirectPlay4SystemTcpFrame,peer:WsaAddress):void;
    onPlayerFrame?(frame:DirectPlay4PlayerTcpFrame,peer:WsaAddress):void;
    onFailure(error:Error):void;
}
function sockaddr(address:{readonly node:readonly number[];readonly port:number}):Uint8Array {
    const node=address.node, port=address.port;
    if(node.length!==6 || node[0]!==2 || node[1]!==1 ||
        !node.every(x=>Number.isInteger(x)&&x>=0&&x<=255) ||
        !Number.isInteger(port)||port<1||port>65535)throw new RangeError("invalid advertised address");
    const b=new Uint8Array(16);b[0]=2;b[2]=port>>>8;b[3]=port&255;b.set(node.slice(2),4);return b;
}

/** Takes ownership of the exact passed listeners even on failure. */
export async function runDirectPlay4JoinHandshake(o:DirectPlay4JoinHandshakeOptions):Promise<DirectPlay4JoinHandshakeResult> {
    try {
        o={...o,discovery:{...o.discovery,instanceGuid:Uint8Array.from(o.discovery.instanceGuid),applicationGuid:Uint8Array.from(o.discovery.applicationGuid)}};
    } catch(error) {
        try{o?.tcp?.release();}finally{o?.udp?.release();}throw error;
    }
    // PRIVATE is a local unsupported policy, not a claim about native Join.
    const d=o.discovery;
    if(d.instanceGuid.length!==16||d.applicationGuid.length!==16||!Number.isInteger(d.version)||d.version<9||d.version>0xffff||
        !Number.isInteger(d.flags)||d.flags<0||d.flags>0xffffffff||(d.flags&0x700)!==0||
        !Number.isInteger(d.reserved1)||d.reserved1<0||d.reserved1>0xffffffff) {
        try{o.tcp.release();}finally{o.udp.release();}throw new Error("unsupported discovery snapshot");
    }
    let channel:DirectPlay4JoinChannel|undefined, released=false;
    const leaseController=new AbortController();
    let phase:"pending"|"transfer"|"live"="pending", session:DirectPlay4JoinSessionOwner|undefined;
    let transferred=false, transitionBytes=0;
    let removeSessionAbort=()=>{};
    const transition:Array<{value:DirectPlay4MixedTcpFrame;peer:WsaAddress;size:number}>=[];
    const sessionCurrent=()=>{
        if(!session || session.signal.aborted || o.signal.aborted || released)return false;
        try{return session.current() && o.current() && o.tcp.current() && o.udp.current() && !session.signal.aborted && !o.signal.aborted && !released;}
        catch{return false;}
    };
    const channelCurrent=()=>transferred?sessionCurrent():transaction.current();
    const transaction=new DirectPlay4JoinTransaction(()=>!o.signal.aborted && o.current() && o.tcp.current() && o.udp.current());
    const resource:DirectPlay4JoinLease={release(){
        if(released)return;released=true;leaseController.abort();removeSessionAbort();o.signal.removeEventListener("abort",abort);
        channel?.close();try{o.tcp.release();}finally{o.udp.release();}
    }};
    const abort=()=>{if(transferred)resource.release();else transaction.cancel();};
    let rejectReply:((e:Error)=>void)|undefined;
    const cancelReply=()=>rejectReply?.(new Error("Join cancelled"));
    transaction.signal.addEventListener("abort",cancelReply);
    o.signal.addEventListener("abort",abort,{once:true});
    try {
        if(o.signal.aborted){resource.release();throw new Error("Join owner unavailable");}
        if(!transaction.adopt(resource))throw new Error("Join owner unavailable");
        const tcpAddress=sockaddr(o.tcp.address), udpAddress=sockaddr(o.udp.address);
        if(!transaction.current())throw new Error("Join owner retired");
        const pending=new DirectPlay4JoinPending(o.maxEntries,o.maxPendingBytes,()=>transaction.current());
        let resolveReply:((value:Extract<DirectPlay4PendingResult,{kind:"reply"}>)=>void)|undefined;
        const incoming=(value:DirectPlay4MixedTcpFrame,peer:WsaAddress)=>{
            const header=Uint8Array.from(value.frame.providerSockaddr);
            if(header.length!==16||header[0]!==2||header[1]!==0||!peer.ip||peer.ip.length!==4)throw new Error("invalid reply address");
            if(header.subarray(4,8).every(x=>x===0))header.set(peer.ip,4);
            const ip=Uint8Array.from(header.subarray(4,8)),port=(header[2]<<8)|header[3];
            const address:WsaAddress={family:2,node:Uint8Array.of(2,1,...ip),ip,port};
            if(!port||!o.authorizeDestination(address)||!channelCurrent())throw new Error("reply address unauthorized");
            value=value.kind==="system"?{kind:"system",frame:{...value.frame,providerSockaddr:header}}:{kind:"player",frame:{...value.frame,providerSockaddr:header}};
            if(phase==="live"){
                if(value.kind==="system")session!.onFrame(value.frame,peer);
                else {if(!session!.onPlayerFrame)throw new Error("player frame handler unavailable");session!.onPlayerFrame(value.frame,peer);}
                return;
            }
            const size=(value.kind==="system"?value.frame.message.length:8+value.frame.data.length)+header.length;
            if(phase==="transfer"){
                if(transition.length+pending.queuedEntries>=o.maxEntries || size>o.maxPendingBytes-transitionBytes-pending.queuedBytes)throw new RangeError("Join transfer queue full");
                transition.push({value,peer:{...peer,node:Uint8Array.from(peer.node),...(peer.ip?{ip:Uint8Array.from(peer.ip)}:{}),...(peer.ip6?{ip6:Uint8Array.from(peer.ip6)}:{})},size});transitionBytes+=size;return;
            }
            let message:Uint8Array;
            if(value.kind==="system")message=value.frame.message;
            else {message=new Uint8Array(8+value.frame.data.length);const view=new DataView(message.buffer);view.setUint32(0,value.frame.from,true);view.setUint32(4,value.frame.to,true);message.set(value.frame.data,8);}
            const result=value.kind==="player"?pending.receivePlayer(message,header,0):pending.receive(message,header,0);
            if(result.kind==="unsupported")throw new Error("unsupported Join message");
            if(result.kind==="reply") {const resolve=resolveReply;resolveReply=undefined;rejectReply=undefined;if(!resolve)throw new Error("unexpected Join reply");resolve(result);}
        };
        const opts:DirectPlay4JoinChannelOptions={
            destination:o.destination,listener:o.tcp,signal:transaction.signal,current:channelCurrent,
            authorizeDestination:o.authorizeDestination,authorizePeer:o.authorizePeer,
            onOwnershipUncertain:o.onOwnershipUncertain,
            onFailure:error=>{rejectReply?.(error);if(transferred){resource.release();try{session?.onFailure(error);}catch{}}else transaction.cancel();},
            onFrame:(frame,peer)=>incoming({kind:"system",frame},peer),
            onPlayerFrame:(frame,peer)=>incoming({kind:"player",frame},peer),
            timeoutMs:o.timeoutMs,maxFrameBytes:o.maxFrameBytes,maxChildren:8,maxWriteBytes:o.maxFrameBytes*2,
        };
        channel=new DirectPlay4JoinChannel(o.table,opts);
        if(!transaction.current())throw new Error("Join owner retired");
        const request=async(command:7|41,inner:Uint8Array)=>{
            if(!transaction.current())throw new Error("Join owner retired");
            const wire=encodeDirectPlay4SystemTcpFrame(tcpAddress,inner,o.maxFrameBytes);
            pending.expectReply(command);
            const reply=new Promise<Extract<DirectPlay4PendingResult,{kind:"reply"}>>((resolve,reject)=>{resolveReply=resolve;rejectReply=reject;});
            // Both send and reply must settle: send failure or cancellation never
            // leaves an unobserved pending reply promise.
            const sent=channel!.send(wire);
            const [,answer]=await Promise.all([sent,reply]);
            if(!transaction.current())throw new Error("Join owner retired");
            return answer;
        };
        const idReply=await request(7,encodeDirectPlay4RequestPlayerId(9,d.version));
        const id=decodeDirectPlay4PlayerIdReply(idReply.message.bytes,o.maxFrameBytes);
        if(id.version!==d.version || id.result!==0 || !id.playerId || id.securityDescription.some(x=>x!==0) || id.sspiProviderOffset!==0 || id.capiProviderOffset!==0 || id.trailingBytes.length!==0)throw new Error("Join player ID rejected");
        if(!transaction.playerIdReceived())throw new Error("Join owner retired");
        const sp=encodeDirectPlay4TcpIpPlayerData(tcpAddress,udpAddress);
        const packed=encodeDirectPlay4PackedPlayer({flags:9,id:id.playerId,systemPlayerId:id.playerId,
            version:d.version,parentId:0,shortName:null,longName:null,spData:sp,playerData:new Uint8Array()},o.maxFrameBytes);
        const answer=await request(41,encodeDirectPlay4AddForward(id.playerId,packed,"",d.reserved1,o.maxFrameBytes,d.version));
        if(answer.command===36)throw new Error("Join name table rejected");
        const table=decodeDirectPlay4NameTable(answer.message.bytes,o.maxFrameBytes,o.maxEntries);
        const desc=table.sessionDescription, dv=new DataView(desc.buffer,desc.byteOffset,desc.byteLength);
        if(table.version!==d.version || (dv.getUint32(4,true)&0x700)!==0 ||
            !d.instanceGuid.every((b,i)=>b===desc[8+i]) || !d.applicationGuid.every((b,i)=>b===desc[24+i]))
            throw new Error("Join session identity mismatch or unsupported session");
        if(!transaction.nameTableReceived() || !transaction.current())throw new Error("Join owner retired");
        const transfer=(owner:DirectPlay4JoinSessionOwner):DirectPlay4JoinSessionLease=>{
            if(phase!=="pending"||!owner||!owner.signal||owner.signal.aborted ||
                !["current","exists","applyPending","onFrame","onFailure"].every(k=>typeof (owner as any)[k]==="function"))throw new Error("invalid Join session owner");
            session={...owner};phase="transfer";
            const sessionAbort=()=>{if(transferred)resource.release();else transaction.cancel();};
            session.signal.addEventListener("abort",sessionAbort,{once:true});
            removeSessionAbort=()=>session!.signal.removeEventListener("abort",sessionAbort);
            try {
                if(!sessionCurrent() || !pending.drain(session.exists,session.applyPending) || !sessionCurrent())throw new Error("Join replay failed");
                const lease=transaction.commit();
                if(!lease)throw new Error("Join transfer failed");
                transferred=true;
                if(!sessionCurrent()||!channel!.retain())throw new Error("Join session owner retired");
                while(transition.length){
                    if(!sessionCurrent())throw new Error("Join session owner retired");
                    const item=transition[0];
                    try{
                        if(item.value.kind==="system")session.onFrame(item.value.frame,item.peer);
                        else {if(!session.onPlayerFrame)throw new Error("player frame handler unavailable");session.onPlayerFrame(item.value.frame,item.peer);}
                    } finally{transition.shift();transitionBytes-=item.size;}
                }
                if(!sessionCurrent())throw new Error("Join session owner retired");
                phase="live";return {
                    signal:leaseController.signal,version:d.version,systemPlayerId:id.playerId,
                    get tcpSockaddr(){return Uint8Array.from(tcpAddress);},
                    get udpSockaddr(){return Uint8Array.from(udpAddress);},
                    current:sessionCurrent,
                    send(frame:Uint8Array){return sessionCurrent()?channel!.send(frame):Promise.reject(new Error("Join session owner retired"));},
                    sendPlayer(frame:Uint8Array){return sessionCurrent()?channel!.sendPlayer(frame):Promise.reject(new Error("Join session owner retired"));},
                    release(){session!.signal.removeEventListener("abort",sessionAbort);lease.release();},
                };
            } catch(error) {
                session.signal.removeEventListener("abort",sessionAbort);
                if(transferred)resource.release();else transaction.cancel();
                throw error;
            }
        };
        return {playerId:id.playerId,table,transfer,cancel:()=>transaction.cancel()};
    } catch(error) {
        transaction.cancel();throw error;
    } finally {
        // Ownership of a successful transaction remains tied to external abort.
        if(transaction.stage==="cancelled")o.signal.removeEventListener("abort",abort);
    }
}
