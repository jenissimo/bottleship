import type {WsaAddress} from "../../wsa-network";
import {DPSP_MSG, DPSP_SIGNATURE} from "./spec";

/**
 * Reply arbitration for a DP4 Join ([MC-DPL4CS] 3.1.4.2, 3.1.5.1, 3.1.5.7, 3.1.5.8).
 * While the join waits for REQUESTPLAYERREPLY or for the name table
 * (SUPERENUMPLAYERSREPLY / ENUMPLAYERSREPLY, or ADDFORWARDREPLY on failure), other
 * messages are held in arrival order. Once the reply is merged into the player list
 * (3.1.5.7) they are replayed; a create message for an ID the merged list already has
 * is skipped, which keeps the merge idempotent. This hold-and-replay design is the
 * engine's own. Packetization and authentication are not parsed here.
 * Queue limits and fail-closed handling are local safety policy.
 */
export type DirectPlay4PendingHeader = Uint8Array | "local" | null;
export interface DirectPlay4PendingMessage { kind:"system"|"player"; bytes:Uint8Array; header:DirectPlay4PendingHeader; sendFlags:number; peer?:WsaAddress; }
export type DirectPlay4PendingResult =
    | {kind:"reply"; message:DirectPlay4PendingMessage; command:number}
    | {kind:"queued"} | {kind:"not-handled"} | {kind:"unsupported"};
type Entry = {message:DirectPlay4PendingMessage; command:number | null; size:number};
type Expected = typeof DPSP_MSG.ENUMPLAYERSREPLY | typeof DPSP_MSG.REQUESTPLAYERREPLY | typeof DPSP_MSG.SUPERENUMPLAYERSREPLY;
// @transient(constant message-id set)
const replies = new Set<number>([DPSP_MSG.ENUMPLAYERSREPLY,DPSP_MSG.REQUESTPLAYERREPLY,DPSP_MSG.ADDFORWARDREPLY,DPSP_MSG.SUPERENUMPLAYERSREPLY]);
// Packetized (2.2.39-2.2.41) and secure-session (2.2.16-2.2.17, 2.2.29-2.2.30
// logon, 2.2.35) messages need reassembly or authentication that this engine
// does not implement; they are reported as unsupported for the caller to reject.
// @transient(constant message-id set)
const unsupported = new Set<number>([DPSP_MSG.PACKET,DPSP_MSG.CHALLENGE,DPSP_MSG.ACCESSGRANTED,DPSP_MSG.LOGONDENIED,
    DPSP_MSG.AUTHERROR,DPSP_MSG.KEYEXCHANGEREPLY,DPSP_MSG.PACKET2_DATA,DPSP_MSG.PACKET2_ACK]);
// @transient(constant message-id set)
const creates = new Set<number>([DPSP_MSG.CREATEPLAYER,DPSP_MSG.CREATEGROUP,DPSP_MSG.CREATEPLAYERVERIFY]);
const uint=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;

export class DirectPlay4JoinPending {
    private readonly queue:Entry[]=[];
    private count=0;
    private used=0;
    private expected?:Expected;
    private draining=false;
    private state:"pending"|"done"|"cancelled"="pending";
    constructor(private readonly maxEntries:number,private readonly maxBytes:number,
        private readonly ownsAttempt:()=>boolean) {
        if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>4096||
            !Number.isInteger(maxBytes)||maxBytes<1||maxBytes>0x1000000)
            throw new RangeError("invalid pending queue limits");
    }
    /** Includes an in-flight replay item until its callback returns. */
    get queuedEntries():number{return this.count;}
    get queuedBytes():number{return this.used;}
    private current():boolean {
        if(this.state!=="pending")return false;
        let owned=false;
        try{owned=this.ownsAttempt();}catch{}
        if(!owned){this.cancel();return false;}
        return this.isPending();
    }
    private isPending():boolean{return this.state==="pending";}
    expectReply(command:Expected):void {
        if(![DPSP_MSG.ENUMPLAYERSREPLY,DPSP_MSG.REQUESTPLAYERREPLY,DPSP_MSG.SUPERENUMPLAYERSREPLY].includes(command)||!this.current()||this.expected!==undefined)
            throw new Error("cannot register expected reply");
        this.expected=command;
    }
    receive(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number,peer?:WsaAddress):DirectPlay4PendingResult {
        return this.receiveTyped(bytes,header,sendFlags,false,peer);
    }
    /** Already-classified player data: an idFrom equal to the 'play' signature must not be
     * reinterpreted as a system command (e.g. a decoded PLAYERWRAPPER). */
    receivePlayer(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number,peer?:WsaAddress):DirectPlay4PendingResult {
        return this.receiveTyped(bytes,header,sendFlags,true,peer);
    }
    private receiveTyped(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number,player:boolean,peer?:WsaAddress):DirectPlay4PendingResult {
        if(!this.current())throw new Error("pending Join owner retired");
        if(!(bytes instanceof Uint8Array)||!(header===null||header==="local"||header instanceof Uint8Array)||!uint(sendFlags))
            throw new TypeError("invalid pending message");
        // The native channel already authorizes the transport peer. Keep its
        // exact IPv4 provenance for deferred authorization during replay.
        if(peer!==undefined && (!peer||peer.family!==2||!Number.isInteger(peer.port)||peer.port<1||peer.port>65535||
            !(peer.node instanceof Uint8Array)||peer.node.length!==6||peer.node[0]!==2||peer.node[1]!==1||
            !(peer.ip instanceof Uint8Array)||peer.ip.length!==4||peer.ip6!==undefined||
            !peer.ip.every((x,i)=>x===peer.node[i+2])))throw new TypeError("invalid pending peer");
        let command:number|null=null;
        if(player && bytes.length<8)throw new RangeError("truncated player message");
        if(!player && bytes.length>=4) {
            const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
            if(view.getUint32(0,true)===DPSP_SIGNATURE) {
                if(bytes.length<8)throw new RangeError("truncated system message");
                command=view.getUint16(4,true);
            }
        }
        if(command!==null && unsupported.has(command))return {kind:"unsupported"};
        const size=bytes.length+(header instanceof Uint8Array?header.length:0)+(peer?peer.node.length+peer.ip!.length:0);
        // Replies are copied too and are restricted by the same single-message budget.
        if(size>this.maxBytes){this.cancel();throw new RangeError("pending message exceeds budget");}
        const message=():DirectPlay4PendingMessage=>({
            kind:command===null?"player":"system",
            bytes:Uint8Array.from(bytes),
            header:header instanceof Uint8Array?Uint8Array.from(header):header,
            sendFlags,
            ...(peer?{peer:{family:peer.family,port:peer.port,node:Uint8Array.from(peer.node),ip:Uint8Array.from(peer.ip!)}}:{}),
        });
        if(command!==null && replies.has(command)) {
            const expected=this.expected;
            // The host picks the name-table form from the CS session flag (notes in 2.2.28 /
            // 2.2.53): a client expecting SUPERENUMPLAYERSREPLY also accepts ENUMPLAYERSREPLY,
            // one that saw CS expects only ENUMPLAYERSREPLY; either may instead get
            // ADDFORWARDREPLY when the join failed (3.1.5.8).
            const matched=command===expected ||
                (expected===DPSP_MSG.SUPERENUMPLAYERSREPLY&&(command===DPSP_MSG.ENUMPLAYERSREPLY||command===DPSP_MSG.ADDFORWARDREPLY)) ||
                (expected===DPSP_MSG.ENUMPLAYERSREPLY&&command===DPSP_MSG.ADDFORWARDREPLY);
            if(!matched)return {kind:"not-handled"};
            this.expected=undefined;
            return {kind:"reply",message:message(),command};
        }
        if(this.count>=this.maxEntries || size>this.maxBytes-this.used) {
            this.cancel();throw new RangeError("pending queue capacity exceeded");
        }
        this.queue.push({message:message(),command,size});this.count++;this.used+=size;
        return {kind:"queued"};
    }
    /**
     * Replay FIFO until empty; reentrant receives join the same replay. Existing
     * CREATEPLAYER/CREATEPLAYERVERIFY/CREATEGROUP IDs are skipped. A callback
     * exception or lost attempt cancels this local transaction.
     * Caller must wait for the expected reply and install the decoded table
     * before invoking drain; this primitive does not enforce that sequencing.
     */
    drain(exists:(kind:"player"|"group",id:number)=>boolean,apply:(message:DirectPlay4PendingMessage)=>void):boolean {
        if(this.draining)return false;
        this.draining=true;
        try {
            if(!this.current())return false;
            while(this.queue.length) {
                if(!this.current())return false;
                const item=this.queue.shift()!;
                try {
                    let duplicate=false;
                    // 2.2.20 / 2.2.21 / 2.2.22: PlayerID is at inner +12; for CREATEGROUP it
                    // is the new group's ID, for the other two a player's.
                    if(item.command!==null&&creates.has(item.command)) {
                        if(item.message.bytes.length<16)throw new RangeError("truncated create message");
                        const b=item.message.bytes;
                        const id=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(12,true);
                        duplicate=exists(item.command===DPSP_MSG.CREATEGROUP?"group":"player",id);
                        if(!this.current())return false;
                    }
                    if(!duplicate)apply(item.message);
                    if(!this.current())return false;
                } finally {this.count--;this.used-=item.size;}
            }
            if(!this.current())return false;
            this.state="done";return true;
        } catch(error) {
            this.cancel();throw error;
        } finally {this.draining=false;}
    }
    cancel():void {
        if(this.state!=="pending")return;
        this.state="cancelled";this.expected=undefined;
        for(const item of this.queue){this.count--;this.used-=item.size;}
        this.queue.length=0;
    }
}
