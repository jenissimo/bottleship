/**
 * Isolated pending/reply arbitration slice for future DP4 Join.
 * NT5 dplay/api.c:958-1073, handler.c:3876-3904,4193-4218,
 * pending.c:40-107,128-195,201-295 and iplay.c:5378-5399.
 * This does not parse packetization, authentication or apply player changes.
 * Queue limits and fail-closed handling are local safety policy.
 */
export type DirectPlay4PendingHeader = Uint8Array | "local" | null;
export interface DirectPlay4PendingMessage { kind:"system"|"player"; bytes:Uint8Array; header:DirectPlay4PendingHeader; sendFlags:number; }
export type DirectPlay4PendingResult =
    | {kind:"reply"; message:DirectPlay4PendingMessage; command:number}
    | {kind:"queued"} | {kind:"not-handled"} | {kind:"unsupported"};
type Entry = {message:DirectPlay4PendingMessage; command:number | null; size:number};
type Expected = 3 | 7 | 41;
const replies = new Set([3,7,36,41]);
// These bypass NT5 pending, but require packet reassembly/auth handling not
// provided by this isolated slice. The caller must reject or handle them.
const unsupported = new Set([21,28,29,30,31,44,48,49]);
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
        if(![3,7,41].includes(command)||!this.current()||this.expected!==undefined)
            throw new Error("cannot register expected reply");
        this.expected=command;
    }
    receive(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number):DirectPlay4PendingResult {
        return this.receiveTyped(bytes,header,sendFlags,false);
    }
    /** Already-classified player data: an ID equal to MSG_HDR must not be
     * reinterpreted as a system command (e.g. a decoded PLAYERWRAPPER). */
    receivePlayer(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number):DirectPlay4PendingResult {
        return this.receiveTyped(bytes,header,sendFlags,true);
    }
    private receiveTyped(bytes:Uint8Array,header:DirectPlay4PendingHeader,sendFlags:number,player:boolean):DirectPlay4PendingResult {
        if(!this.current())throw new Error("pending Join owner retired");
        if(!(bytes instanceof Uint8Array)||!(header===null||header==="local"||header instanceof Uint8Array)||!uint(sendFlags))
            throw new TypeError("invalid pending message");
        let command:number|null=null;
        if(player && bytes.length<8)throw new RangeError("truncated player message");
        if(!player && bytes.length>=4) {
            const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
            if(view.getUint32(0,true)===0x79616c70) {
                if(bytes.length<8)throw new RangeError("truncated system message");
                command=view.getUint16(4,true);
            }
        }
        if(command!==null && unsupported.has(command))return {kind:"unsupported"};
        const size=bytes.length+(header instanceof Uint8Array?header.length:0);
        // Replies are copied too and are restricted by the same single-message budget.
        if(size>this.maxBytes){this.cancel();throw new RangeError("pending message exceeds budget");}
        const message=():DirectPlay4PendingMessage=>({
            kind:command===null?"player":"system",
            bytes:Uint8Array.from(bytes),
            header:header instanceof Uint8Array?Uint8Array.from(header):header,
            sendFlags,
        });
        if(command!==null && replies.has(command)) {
            const expected=this.expected;
            const matched=command===expected || (expected===41&&(command===3||command===36)) || (expected===3&&command===36);
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
                    // dpmess.h:221-235: MSG_PLAYERMGMTMESSAGE.dwPlayerID is
                    // inner +12; pending.c:145-180 selects player vs group.
                    if(item.command===8||item.command===9||item.command===56) {
                        if(item.message.bytes.length<16)throw new RangeError("truncated create message");
                        const b=item.message.bytes;
                        const id=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(12,true);
                        duplicate=exists(item.command===9?"group":"player",id);
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
