import {createServer, isIP, type Server, type Socket} from "node:net";
import {NativeDestinationPolicy} from "./native-policy";
import {encodeDatagram, type DecodedDatagram} from "./protocol";
import {validHostIpv4Node} from "./udp-host-protocol";
import {CREDIT,DATA,FIN,OOB,RST,SYN,SYNACK,TCP_OPTION,TCP_OPTION_KEEPALIVE,TCP_OPTION_NODELAY,
    TCP_SEGMENT,TCP_WINDOW,SYN_INLINE_FLAG,SYN_KEEPALIVE_FLAG,SYN_NODELAY_FLAG,SYN_WINDOW_MASK,
    decodeTcpFrame,encodeTcpFrame} from "./tcp-protocol";

export interface TcpHostConfig {
    id:string; bindHost:string; advertisedHost:string; port:number; allowedHosts:string[];
    maxOwners?:number; maxPending?:number; startupTimeoutMs?:number;
}
export interface TcpHostBinding {localPort:number; generation:number}
type CheckedConfig = Required<TcpHostConfig>;
type Output = (frame:Uint8Array<ArrayBuffer>, generation:number)=>boolean;
const fail=(code:number,message:string)=>Object.assign(new Error(message),{code});
const uint=(n:unknown,min:number,max:number):n is number=>Number.isInteger(n)&&Number(n)>=min&&Number(n)<=max;
function ipv4(value:unknown, allowAny=false):string {
    if(typeof value!=="string" || isIP(value)!==4) throw fail(10022,"Numeric IPv4 required");
    const a=value.split(".").map(Number);
    if (!(allowAny && value==="0.0.0.0") && !validHostIpv4Node([2,1,...a])) throw fail(10022,"Unicast IPv4 required");
    return value;
}
export function validateTcpHostConfig(value:TcpHostConfig):CheckedConfig {
    if(!value || typeof value.id!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) ||
        !uint(value.port,0,65535) || !Array.isArray(value.allowedHosts) || !value.allowedHosts.length || value.allowedHosts.length>32)
        throw fail(10022,"Invalid TCP listener policy");
    const allowedHosts=value.allowedHosts.map(v=>ipv4(v));
    if(new Set(allowedHosts).size!==allowedHosts.length) throw fail(10022,"Duplicate TCP ACL");
    const maxOwners=value.maxOwners??1,maxPending=value.maxPending??64,startupTimeoutMs=value.startupTimeoutMs??10000;
    if(!uint(maxOwners,1,64)||!uint(maxPending,1,128)||!uint(startupTimeoutMs,1,120000))
        throw fail(10022,"Invalid TCP listener limits");
    return {id:value.id,bindHost:ipv4(value.bindHost,true),advertisedHost:ipv4(value.advertisedHost),
        port:value.port,allowedHosts,maxOwners,maxPending,startupTimeoutMs};
}
/** Must be the same object used for outbound native connections at integration. */
export class TcpHostCapacity {
    private used=0;
    private readonly releaseListeners=new Set<()=>void>();
    constructor(readonly max:number) {if(!uint(max,1,4096))throw fail(10022,"Invalid TCP capacity");}
    acquire(): (()=>void)|null {
        if(this.used>=this.max)return null;
        this.used++;let released=false;
        return ()=>{if(!released){released=true;this.used--;for(const listener of this.releaseListeners){try{listener();}catch{}}}};
    }
    onRelease(listener:()=>void):()=>void {
        this.releaseListeners.add(listener);return ()=>this.releaseListeners.delete(listener);
    }
    get active():number{return this.used;}
}
/** Shared across participants; owns global listener IDs, source policy and quota. */
export class TcpHostRegistry {
    private readonly counts=new Map<string,number>();
    private serial=0;
    constructor(readonly policy:NativeDestinationPolicy,readonly capacity:TcpHostCapacity){}
    nextId():number {if(this.serial>=0xffffffff)throw fail(10055,"TCP identity exhausted");return ++this.serial;}
    reserve(config:CheckedConfig,owner:object):()=>void {
        if((this.counts.get(config.id)??0)>=config.maxOwners)throw fail(10048,"TCP listener owner limit");
        const policyReleases:Array<()=>void>=[];
        try {
            for(const ip of config.allowedHosts) {
                const release=this.policy.acquire(ip,owner,false);
                if(!release)throw fail(10048,"TCP source policy conflict");
                policyReleases.push(release);
            }
        } catch(error) {for(const release of policyReleases)release();throw error;}
        this.counts.set(config.id,(this.counts.get(config.id)??0)+1);
        let done=false;
        return ()=>{
            if(done)return;done=true;for(const release of policyReleases)release();
            const n=(this.counts.get(config.id)??1)-1;
            if(n)this.counts.set(config.id,n);else this.counts.delete(config.id);
        };
    }
}
interface Flow {
    socket:Socket; id:number; guestId:number; node:Uint8Array; port:number; generation:number; localPort:number;
    state:"offer"|"child"|"closed"; release:()=>void; timer:ReturnType<typeof setTimeout>|undefined;
    credit:number; writeCredit:number; sentFin:boolean; receivedFin:boolean;
}
export interface TcpHostOpened {leaseId:number;address:{node:number[];port:number};allowedNodes:number[][]}
export class TcpHostOwner {
    private readonly owner={};
    private server:Server|undefined;
    private config:CheckedConfig|undefined;
    private binding:TcpHostBinding|undefined;
    private lease=0;
    private releasePolicy:(()=>void)|undefined;
    private readonly flows=new Map<number,Flow>();
    private closing=false;
    private disposed=false;
    private listenFailed=false;
    private ready=false;
    private active=false;
    constructor(private readonly registry:TcpHostRegistry,private readonly output:Output,
        private readonly onFailure:(code:number)=>void=()=>{},private readonly requireActivation=false){}
    activate():void { if(this.ready && !this.closing && !this.disposed)this.active=true; }
    async open(configValue:TcpHostConfig,binding:TcpHostBinding,signal?:AbortSignal):Promise<TcpHostOpened> {
        if(this.disposed||this.server||signal?.aborted)throw fail(10004,"TCP listener cancelled");
        const config=validateTcpHostConfig(configValue);
        if(!uint(binding.localPort,1,65535)||!uint(binding.generation,1,0xffffffff)||
            config.maxPending>this.registry.capacity.max)throw fail(10022,"Invalid TCP listener binding");
        const lease=this.registry.nextId();
        const release=this.registry.reserve(config,this.owner);
        this.config=config;this.binding={...binding};this.releasePolicy=release;this.closing=false;this.listenFailed=false;this.ready=false;
        const server=createServer({allowHalfOpen:true,pauseOnConnect:true},socket=>this.accept(socket));
        this.server=server;this.lease=lease;
        server.on("error",()=>{this.listenFailed=true;if(!this.closing){if(this.ready)this.onFailure(10054);void this.closeListener();}});
        try {
            await new Promise<void>((resolve,reject)=>{
                let settled=false;
                const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);server.off("listening",onReady);server.off("error",onError);};
                const finish=(error?:Error)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve();};
                const abort=()=>finish(fail(10004,"TCP listener cancelled"));
                const onReady=()=>finish();
                const onError=(error:Error)=>finish(error);
                const timer=setTimeout(()=>finish(fail(10060,"TCP listener startup timeout")),config.startupTimeoutMs);
                signal?.addEventListener("abort",abort,{once:true});
                server.once("listening",onReady);server.once("error",onError);
                try {server.listen({host:config.bindHost,port:config.port,exclusive:true});}
                catch(error){this.listenFailed=true;finish(error instanceof Error?error:fail(10050,"TCP listen failed"));}
                if(signal?.aborted)abort();
            });
            if(this.disposed||this.closing||signal?.aborted)throw fail(10004,"TCP listener cancelled");
            const address=server.address();
            if(!address||typeof address==="string"||!uint(address.port,1,65535))throw fail(10050,"Invalid listener endpoint");
            this.ready=true;
            if(!this.requireActivation)this.active=true;
            return {leaseId:this.lease,address:{node:[2,1,...config.advertisedHost.split(".").map(Number)],port:address.port},
                allowedNodes:config.allowedHosts.map(ip=>[2,1,...ip.split(".").map(Number)])};
        } catch(error) {
            await this.closeListener();
            throw error;
        }
    }
    private emit(flow:Flow,kind:number,value=0,data?:Uint8Array,dst=flow.guestId):boolean {
        if(flow.state==="closed")return false;
        const frame=encodeDatagram(2,flow.node,flow.localPort,flow.port,encodeTcpFrame(kind,flow.id,dst,value,data));
        try {if(this.output(frame,flow.generation))return true;}
        catch { /* A reliable delivery failure retires the whole owner. */ }
        this.close();return false;
    }
    private accept(socket:Socket):void {
        const c=this.config,b=this.binding;
        if(this.closing||this.disposed||!this.active||!c||!b){socket.destroy();return;}
        const address=socket.remoteAddress,port=socket.remotePort;
        if(!address||isIP(address)!==4||!c.allowedHosts.includes(address)||!uint(port,1,65535)) {socket.destroy();return;}
        if([...this.flows.values()].filter(f=>f.state==="offer").length>=c.maxPending){socket.destroy();return;}
        const release=this.registry.capacity.acquire();
        if(!release){socket.destroy();return;}
        let id:number;
        try{id=this.registry.nextId();}catch{release();socket.destroy();return;}
        const flow:Flow={socket,id,guestId:0,node:Uint8Array.of(2,1,...address.split(".").map(Number)),port,
            generation:b.generation,localPort:b.localPort,state:"offer",release,timer:undefined,
            credit:0,writeCredit:TCP_WINDOW,sentFin:false,receivedFin:false};
        this.flows.set(id,flow);
        socket.on("error",()=>{if(flow.state!=="closed")this.failFlow(flow,10054);});
        socket.once("close",()=>{
            if(flow.state!=="closed") {
                if(flow.state==="offer" || !(flow.sentFin && flow.receivedFin))this.emit(flow,RST,10054);
                flow.state="closed";
            }
            clearTimeout(flow.timer);this.flows.delete(flow.id);flow.release();
        });
        flow.timer=setTimeout(()=>this.failFlow(flow,10060),c.startupTimeoutMs);
        if(!this.emit(flow,SYN,TCP_WINDOW,undefined,0))this.retire(flow);
    }
    ownsBinding(localPort:number,generation:number|undefined):boolean {
        return this.binding?.localPort===localPort && this.binding.generation===generation;
    }
    bindingRetiredBy(localPort:number,generation:number,inclusive:boolean):boolean {
        return !!this.binding && this.binding.localPort===localPort &&
            (inclusive ? this.binding.generation<=generation : this.binding.generation<generation);
    }
    handle(d:DecodedDatagram):boolean {
        const b=this.binding;
        if(d.proto!==2||!b||d.srcPort!==b.localPort||d.bindingGeneration!==b.generation)return false;
        const frame=decodeTcpFrame(d.payload);
        if(!frame)return true;
        const flow=this.flows.get(frame.dstId);
        if(!flow||flow.state==="closed"||flow.localPort!==d.srcPort||flow.generation!==d.bindingGeneration||
            flow.port!==d.dstPort||!flow.node.every((v,i)=>v===d.node[i]))return false;
        if(flow.state==="offer") {
            if(frame.kind===RST && !frame.data.length) {this.retire(flow);return true;}
            if(frame.kind!==SYNACK||!frame.srcId||frame.data.length||this.closing)return true;
            if(frame.value&SYN_INLINE_FLAG){this.failFlow(flow,10045,frame.srcId);return true;}
            clearTimeout(flow.timer);flow.timer=undefined;flow.guestId=frame.srcId;flow.state="child";
            flow.credit=Math.min(TCP_WINDOW,frame.value&SYN_WINDOW_MASK);
            flow.socket.setKeepAlive(!!(frame.value&SYN_KEEPALIVE_FLAG));
            flow.socket.setNoDelay(!!(frame.value&SYN_NODELAY_FLAG));
            flow.socket.on("readable",()=>this.pump(flow));
            flow.socket.on("end",()=>{if(flow.state==="child"&&!flow.sentFin){flow.sentFin=true;this.emit(flow,FIN);}});
            this.pump(flow);return true;
        }
        if(frame.srcId!==flow.guestId||frame.dstId!==flow.id)return true;
        if(frame.kind===RST){this.retire(flow);return true;}
        if(frame.kind===DATA){
            if(flow.receivedFin||!frame.data.length||frame.data.length>flow.writeCredit){this.failFlow(flow,10054);return true;}
            flow.writeCredit-=frame.data.length;
            flow.socket.write(frame.data,error=>{
                if(flow.state!=="child")return;
                if(error){this.failFlow(flow,10054);return;}
                flow.writeCredit+=frame.data.length;this.emit(flow,CREDIT,frame.data.length);
            });
        } else if(frame.kind===CREDIT){
            if(frame.value>TCP_WINDOW-flow.credit){this.failFlow(flow,10054);return true;}
            flow.credit+=frame.value;this.pump(flow);
        } else if(frame.kind===FIN){
            if(!flow.receivedFin){flow.receivedFin=true;flow.socket.end();}
        } else if(frame.kind===OOB) this.failFlow(flow,10045);
        else if(frame.kind===TCP_OPTION){
            if(frame.data.length||![0,1,TCP_OPTION_KEEPALIVE,TCP_OPTION_KEEPALIVE|1,TCP_OPTION_NODELAY,TCP_OPTION_NODELAY|1].includes(frame.value)){this.failFlow(flow,10022);return true;}
            const opt=frame.value&~1, enabled=!!(frame.value&1);
            if(opt===TCP_OPTION_KEEPALIVE)flow.socket.setKeepAlive(enabled);
            else if(opt===TCP_OPTION_NODELAY)flow.socket.setNoDelay(enabled);
            else this.failFlow(flow,10045);
        }
        return true;
    }
    private pump(flow:Flow):void {
        while(flow.state==="child"&&flow.credit>0&&flow.socket.readableLength>0){
            const data:Buffer|null=flow.socket.read(Math.min(TCP_SEGMENT,flow.credit,flow.socket.readableLength));
            if(!data)break;flow.credit-=data.length;if(!this.emit(flow,DATA,0,data))return;
        }
        if(flow.state==="child")flow.socket.read(0);
    }
    private failFlow(flow:Flow,code:number,dst=flow.guestId):void {
        if(flow.state==="closed")return;
        this.emit(flow,RST,code,undefined,dst);this.retire(flow);
    }
    private retire(flow:Flow):void {
        if(flow.state==="closed")return;
        flow.state="closed";clearTimeout(flow.timer);
        flow.socket.destroy();
    }
    /** Stops accepting and closes pending offers; established children remain live. */
    closeListener():Promise<void> {
        if(this.closing)return this.closedListener;
        this.closing=true;this.active=false;
        const owned=[...this.flows.values()];
        const offers=owned.filter(flow=>flow.state==="offer");
        // Server.close and accepted socket close notifications may be ordered
        // independently. Keep the lease until every owned socket actually closes.
        const socketsClosed=owned.map(flow=>new Promise<void>(resolve=>flow.socket.once("close",resolve)));
        for(const flow of offers)this.failFlow(flow,10054);
        const server=this.server;
        if(!server){this.closedListener=Promise.all(socketsClosed).then(()=>{});return this.closedListener;}
        const serverClosed=new Promise<void>(resolve=>{
            let finished=false;
            const done=()=>{
                if(finished)return;finished=true;
                server.off("listening",closeStarted);server.off("error",onFailed);
                if(this.server===server)this.server=undefined;
                resolve();
            };
            const closeStarted=()=>{try{server.close(done);}catch{done();}};
            const onFailed=()=>done();
            // If cancellation races asynchronous listen, retain ownership until
            // the pending operation either becomes listening and closes, or fails.
            if(server.listening)closeStarted();
            else if(this.listenFailed)done();
            else {server.once("listening",closeStarted);server.once("error",onFailed);}
        });
        this.closedListener=Promise.all([serverClosed,...socketsClosed]).then(()=>{
            this.releasePolicy?.();this.releasePolicy=undefined;
        });
        return this.closedListener;
    }
    private closedListener:Promise<void>=Promise.resolve();
    close():void {
        if(this.disposed)return;this.disposed=true;
        void this.closeListener();
        for(const flow of [...this.flows.values()])this.retire(flow);
    }
}
