import {encodeDirectPlay4RequestPlayerId,decodeDirectPlay4PlayerIdReply} from "./player-id";
import {encodeDirectPlay4PackedPlayer,encodeDirectPlay4TcpIpPlayerData} from "./packed-player";
import {encodeDirectPlay4SystemTcpFrame,type DirectPlay4SystemTcpFrame} from "./tcp-frame";

/** Isolated application-player operation. The owning session must exclusively
 * dispatch its cmd7 replies here and retire itself when onUncertain fires:
 * cmd7 has no operation ID, so a late reply cannot safely be reused. */
export interface DirectPlay4CreatePlayerOwner {
    signal:AbortSignal; current():boolean; send(frame:Uint8Array):Promise<void>;
    onUncertain(error:Error):void;
    version:number; systemPlayerId:number; tcpSockaddr:Uint8Array; udpSockaddr:Uint8Array;
}
export interface DirectPlay4CreatePlayerRequest {
    shortName:string|null; longName:string|null; data:Uint8Array;
}
export interface DirectPlay4CreatePlayerResult {
    playerId:number;
    /** WSA accepted cmd8 bytes; host acceptance and game-visible delivery are not acknowledged. */
    submission:"submitted";
}
const uint=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
/** NT5 sysmess.c:1223-1285, 1358-1365; dpmess.h:221-235.
 * This form is the observed normal version-14 application-player message;
 * trailing six zero bytes reproduce the source allocation and native capture.
 */
export function encodeDirectPlay4CreatePlayer(playerId:number,packed:Uint8Array,version:number,maxBytes:number):Uint8Array {
    if(!uint(playerId)||!playerId||!Number.isInteger(version)||version<0||version>0xffff ||
        !(packed instanceof Uint8Array)||packed.length<48||
        !Number.isInteger(maxBytes)||maxBytes<82||maxBytes>0xfffff)throw new RangeError("invalid create player");
    const p=new DataView(packed.buffer,packed.byteOffset,packed.byteLength);
    if(p.getUint32(0,true)!==packed.length||p.getUint32(8,true)!==playerId||28+packed.length+6>maxBytes)
        throw new RangeError("invalid packed player");
    const b=new Uint8Array(28+packed.length+6),v=new DataView(b.buffer);
    v.setUint32(0,0x79616c70,true);v.setUint16(4,8,true);v.setUint16(6,version,true);
    v.setUint32(12,playerId,true);v.setUint32(20,28,true);b.set(packed,28);return b;
}
export class DirectPlay4CreatePlayer {
    private readonly owner:DirectPlay4CreatePlayerOwner;
    private readonly tcp:Uint8Array; private readonly udp:Uint8Array;
    private pending?:{resolve:(frame:DirectPlay4SystemTcpFrame)=>void;reject:(error:Error)=>void};
    private busy=false; private retired=false; private cancelActive?: (error:Error)=>void;
    constructor(owner:DirectPlay4CreatePlayerOwner,private readonly timeoutMs:number,private readonly maxBytes:number) {
        if(!owner||!owner.signal||typeof owner.current!=="function"||typeof owner.send!=="function"||
            typeof owner.onUncertain!=="function"||!uint(owner.systemPlayerId)||!owner.systemPlayerId||
            !Number.isInteger(owner.version)||owner.version<9||owner.version>0xffff||
            !(owner.tcpSockaddr instanceof Uint8Array)||owner.tcpSockaddr.length!==16||
            !(owner.udpSockaddr instanceof Uint8Array)||owner.udpSockaddr.length!==16||
            !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||
            !Number.isInteger(maxBytes)||maxBytes<134||maxBytes>65536)throw new RangeError("invalid player owner");
        this.owner={...owner};this.tcp=Uint8Array.from(owner.tcpSockaddr);this.udp=Uint8Array.from(owner.udpSockaddr);
    }
    private current():boolean {
        if(this.retired||this.owner.signal.aborted)return false;
        try{return this.owner.current()&&!this.retired&&!this.owner.signal.aborted;}catch{return false;}
    }
    /** Returns false for frames belonging to the owning session's other handlers. */
    receive(frame:DirectPlay4SystemTcpFrame):boolean {
        const pending=this.pending;
        if(frame.command!==7||!pending)return false;
        const current=this.current();
        // current() may synchronously deliver the reply or retire the owner.
        if(this.pending!==pending)return true;
        this.pending=undefined;
        if(!current){pending.reject(new Error("player owner retired"));return true;}
        if(!(frame.message instanceof Uint8Array)||frame.message.length>this.maxBytes||
            !(frame.providerSockaddr instanceof Uint8Array)||frame.providerSockaddr.length!==16){
            pending.reject(new RangeError("invalid player reply"));return true;
        }
        pending.resolve({...frame,message:Uint8Array.from(frame.message),providerSockaddr:Uint8Array.from(frame.providerSockaddr)});return true;
    }
    async create(request:DirectPlay4CreatePlayerRequest):Promise<DirectPlay4CreatePlayerResult> {
        if(this.busy)throw new Error("player operation unavailable");
        this.busy=true; // Reserve before current() or any other caller callback.
        let shortName:string|null,longName:string|null,data:Uint8Array,sp:Uint8Array;
        try {
            if(!this.current())throw new Error("player operation unavailable");
            if(!request||!(request.data instanceof Uint8Array))throw new TypeError("invalid player request");
            if(request.data.length>this.maxBytes)throw new RangeError("player data exceeds budget");
            shortName=request.shortName;longName=request.longName;data=Uint8Array.from(request.data);
            sp=encodeDirectPlay4TcpIpPlayerData(this.tcp,this.udp);
            encodeDirectPlay4PackedPlayer({flags:8,id:1,systemPlayerId:this.owner.systemPlayerId,version:this.owner.version,
                parentId:0,shortName,longName,spData:sp,playerData:data},this.maxBytes-54);
        } catch(error) {this.busy=false;throw error;}
        let timer:ReturnType<typeof setTimeout>|undefined,started=false;
        let rejectWait:((error:Error)=>void)|undefined;
        const aborted=()=>rejectWait?.(new Error("player operation cancelled"));
        this.cancelActive=error=>rejectWait?.(error);
        this.owner.signal.addEventListener("abort",aborted,{once:true});
        try {
            if(!this.current())throw new Error("player owner retired");
            const frame=encodeDirectPlay4SystemTcpFrame(this.tcp,encodeDirectPlay4RequestPlayerId(8,this.owner.version),this.maxBytes);
            const reply=new Promise<DirectPlay4SystemTcpFrame>((resolve,reject)=>{rejectWait=reject;this.pending={resolve,reject};});
            timer=setTimeout(()=>rejectWait?.(new Error("player operation timeout")),this.timeoutMs);
            started=true;
            const [,response]=await Promise.all([Promise.resolve().then(()=>{if(!this.current())throw new Error("player owner retired");return this.owner.send(frame);}),reply]);
            this.pending=undefined;rejectWait=undefined;
            if(!this.current())throw new Error("player owner retired");
            const id=decodeDirectPlay4PlayerIdReply(response.message,this.maxBytes);
            if(id.version!==this.owner.version||id.result!==0||!id.playerId||id.securityDescription.some(x=>x!==0)||
                id.sspiProviderOffset!==0||id.capiProviderOffset!==0||id.trailingBytes.length)
                throw new Error("player ID rejected");
            const packed=encodeDirectPlay4PackedPlayer({flags:8,id:id.playerId,systemPlayerId:this.owner.systemPlayerId,
                version:this.owner.version,parentId:0,shortName,longName,spData:sp,playerData:data},this.maxBytes-54);
            const inner=encodeDirectPlay4CreatePlayer(id.playerId,packed,this.owner.version,this.maxBytes-20);
            if(!this.current())throw new Error("player owner retired");
            const wire=encodeDirectPlay4SystemTcpFrame(this.tcp,inner,this.maxBytes);
            const cancelled=new Promise<never>((_,reject)=>{rejectWait=reject;});
            await Promise.race([Promise.resolve().then(()=>{if(!this.current())throw new Error("player owner retired");return this.owner.send(wire);}),cancelled]);
            rejectWait=undefined;
            if(!this.current())throw new Error("player owner retired");
            return {playerId:id.playerId,submission:"submitted"};
        } catch(error) {
            const failure=error instanceof Error?error:new Error(String(error));
            if(started){this.retired=true;try{this.owner.onUncertain(failure);}catch{}}
            throw failure;
        } finally {
            if(timer)clearTimeout(timer);this.owner.signal.removeEventListener("abort",aborted);
            this.pending=undefined;this.cancelActive=undefined;this.busy=false;
        }
    }
    close():void {
        if(this.retired)return;
        this.retired=true;this.cancelActive?.(new Error("player operation closed"));
    }
}
