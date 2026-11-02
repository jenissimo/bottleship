import {encodeDatagram, type DecodedDatagram} from "./protocol";
import {TcpHostRegistry,validateTcpHostConfig,type TcpHostBinding,type TcpHostConfig} from "./tcp-host-owner";
import {TcpAcceptQuota} from "./tcp-accept-quota";
import {TcpAcceptBridge,type AcceptChild} from "./tcp-accept-bridge";
import {CREDIT,DATA,FIN,OOB,RST,SYN,SYNACK,TCP_OPTION,TCP_OPTION_KEEPALIVE,TCP_OPTION_NODELAY,
    TCP_SEGMENT,TCP_WINDOW,SYN_INLINE_FLAG,SYN_KEEPALIVE_FLAG,SYN_NODELAY_FLAG,SYN_WINDOW_MASK,
    decodeTcpFrame,encodeTcpFrame,type TcpFrame} from "./tcp-protocol";

type Flow={
    child:AcceptChild; id:number; guest:number; node:Uint8Array; port:number;
    phase:"offer"|"starting"|"live"|"closing"; timer?:ReturnType<typeof setTimeout>;
    credit:number; writeCredit:number; receivedFin:boolean; sentFin:boolean; writeFinished:boolean;
    early:TcpFrame[]; earlyBytes:number;
};
const fail=(code:number,message:string)=>Object.assign(new Error(message),{code});

/** Experimental helper-backed owner. Not connected to the server or capability. */
export class TcpAcceptHostOwner {
    private readonly policyOwner={};
    private bridge?:TcpAcceptBridge;
    private config?:ReturnType<typeof validateTcpHostConfig>;
    private binding?:TcpHostBinding;
    private releasePolicy?:()=>void;
    private lease=0;
    private readonly flows=new Map<number,Flow>();
    private readonly children=new Map<bigint,Flow>();
    private readonly dismissed=new Map<bigint,bigint>();
    private ready=false;private active=false;private stopping=false;private disposed=false;
    private failed=false;private stopPromise?:Promise<void>;private completion?:Promise<void>;
    constructor(private readonly registry:TcpHostRegistry,private readonly quota:TcpAcceptQuota,
        private readonly executable:string,private readonly epoch:number,
        private readonly output:(frame:Uint8Array<ArrayBuffer>,generation:number)=>boolean,
        private readonly onFailure:(code:number)=>void=()=>{}) {}

    async open(value:TcpHostConfig,binding:TcpHostBinding,signal?:AbortSignal):Promise<{leaseId:number;address:{node:number[];port:number};allowedNodes:number[][]}> {
        if(this.bridge||this.disposed||signal?.aborted)throw fail(10004,"TCP listener cancelled");
        const config=validateTcpHostConfig(value);
        const max=process.platform==="win32"?60:128;
        if(!Number.isInteger(binding.localPort)||binding.localPort<1||binding.localPort>65535||
           !Number.isInteger(binding.generation)||binding.generation<1||binding.generation>0xffffffff||
           config.maxPending>this.registry.capacity.max)
            throw fail(10022,"Invalid helper listener binding or capacity");
        this.lease=this.registry.nextId();
        this.releasePolicy=this.registry.reserve(config,this.policyOwner);
        this.config=config;this.binding={...binding};
        let bridge:TcpAcceptBridge;
        try {
            bridge=new TcpAcceptBridge({executable:this.executable,bindHost:config.bindHost,port:config.port,
                allowedHosts:config.allowedHosts,limit:Math.min(this.registry.capacity.max,max),epoch:this.epoch},this.quota,{
                offer:child=>this.offer(child),data:(child,data)=>this.data(child,data),
                eof:child=>this.eof(child),closed:(child,error)=>this.childClosed(child,error),
                failed:()=>this.processFailed(),
            });
            this.bridge=bridge;
        } catch(error){this.releasePolicy?.();this.releasePolicy=undefined;throw error;}
        void bridge.whenPhysicalClosed().then(()=>{this.releasePolicy?.();this.releasePolicy=undefined;});
        let timer:ReturnType<typeof setTimeout>|undefined;
        let abort:()=>void=()=>{};
        try {
            const cancelled=new Promise<never>((_,reject)=>{
                abort=()=>reject(fail(10004,"TCP listener cancelled"));
                signal?.addEventListener("abort",abort,{once:true});
                timer=setTimeout(()=>reject(fail(10060,"TCP listener startup timeout")),config.startupTimeoutMs);
                if(signal?.aborted)abort();
            });
            const port=await Promise.race([bridge.ready,cancelled]);
            if(this.disposed||this.stopping||signal?.aborted)throw fail(10004,"TCP listener cancelled");
            this.ready=true;
            return {leaseId:this.lease,address:{node:[2,1,...config.advertisedHost.split(".").map(Number)],port},
                allowedNodes:config.allowedHosts.map(ip=>[2,1,...ip.split(".").map(Number)])};
        } catch(error){bridge.abort(error);await bridge.whenPhysicalClosed();throw error;}
        finally {if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    }
    activate():void {
        if(!this.ready||this.stopping||this.disposed||!this.bridge)throw fail(10057,"TCP listener unavailable");
        if(this.active)return;
        this.active=true;
        try{this.bridge.activate();}catch(e){this.active=false;this.bridge.abort(e);throw e;}
    }
    ownsBinding(localPort:number,generation:number|undefined):boolean {
        return this.binding?.localPort===localPort&&this.binding.generation===generation;
    }
    bindingRetiredBy(localPort:number,generation:number,inclusive:boolean):boolean {
        return !!this.binding&&this.binding.localPort===localPort&&
            (inclusive?this.binding.generation<=generation:this.binding.generation<generation);
    }
    private emit(f:Flow,kind:number,value=0,data?:Uint8Array,dst=f.guest):boolean {
        const b=this.binding;if(!b||f.phase==="closing")return false;
        try {
            const frame=encodeDatagram(2,f.node,b.localPort,f.port,encodeTcpFrame(kind,f.id,dst,value,data));
            if(this.output(frame,b.generation))return true;
        } catch {}
        this.close();return false;
    }
    private offer(child:AcceptChild):void {
        const bridge=this.bridge,c=this.config;
        if(!bridge||!c)throw Error("Offer before helper ownership");
        if(this.stopping||this.disposed||!this.active||
            [...this.flows.values()].filter(f=>f.phase==="offer").length>=c.maxPending) {
            this.dismissed.set(child.child,child.permit);
            void bridge.closeChild(child).then(()=>{this.dismissed.delete(child.child);this.maybeFinish();},e=>bridge.abort(e));return;
        }
        const id=this.registry.nextId();
        const f:Flow={child,id,guest:0,node:Uint8Array.of(2,1,...child.peerHost.split(".").map(Number)),
            port:child.peerPort,phase:"offer",credit:0,writeCredit:TCP_WINDOW,receivedFin:false,sentFin:false,writeFinished:false,early:[],earlyBytes:0};
        this.flows.set(id,f);this.children.set(child.child,f);
        f.timer=setTimeout(()=>this.failFlow(f,10060),c.startupTimeoutMs);
        if(!this.emit(f,SYN,TCP_WINDOW,undefined,0))this.retire(f);
    }
    handle(d:DecodedDatagram):boolean {
        const b=this.binding;if(d.proto!==2||!b||d.srcPort!==b.localPort||d.bindingGeneration!==b.generation)return false;
        const frame=decodeTcpFrame(d.payload);if(!frame)return true;
        const f=this.flows.get(frame.dstId);
        if(!f||f.phase==="closing"||f.port!==d.dstPort||!f.node.every((v,i)=>v===d.node[i]))return false;
        if(f.phase==="offer") {
            if(frame.kind===RST&&!frame.data.length){this.retire(f);return true;}
            if(frame.kind!==SYNACK||!frame.srcId||frame.data.length||this.stopping)return true;
            if(frame.value&SYN_INLINE_FLAG){this.failFlow(f,10045,frame.srcId);return true;}
            clearTimeout(f.timer);f.timer=undefined;f.guest=frame.srcId;f.phase="starting";
            f.credit=Math.min(TCP_WINDOW,frame.value&SYN_WINDOW_MASK);
            void this.startFlow(f,frame.value);return true;
        }
        if(frame.srcId!==f.guest||frame.dstId!==f.id)return true;
        if(f.phase==="starting") {
            if(f.early.length>=256||frame.data.length>TCP_WINDOW-f.earlyBytes){this.failFlow(f,10055);return true;}
            f.early.push({...frame,data:Uint8Array.from(frame.data)});f.earlyBytes+=frame.data.length;return true;
        }
        this.onFrame(f,frame);return true;
    }
    private async startFlow(f:Flow,flags:number):Promise<void> {
        try {
            const b=this.bridge!;
            for(const [option,enabled] of [[1,!!(flags&SYN_KEEPALIVE_FLAG)],[2,!!(flags&SYN_NODELAY_FLAG)]] as const) {
                if(await b.option(f.child,option,enabled))throw Error("Native socket option failed");
                if(f.phase!=="starting")return;
            }
            f.phase="live";
            if(f.credit)b.credit(f.child,f.credit);
            const early=f.early.splice(0);f.earlyBytes=0;
            for(const frame of early){if(f.phase!=="live")break;this.onFrame(f,frame);}
        } catch {if(f.phase!=="closing")this.failFlow(f,10054);}
    }
    private onFrame(f:Flow,frame:TcpFrame):void {
        const b=this.bridge!;
        if(frame.kind===RST){this.retire(f);return;}
        if(frame.kind===DATA){
            if(f.receivedFin||!frame.data.length||frame.data.length>TCP_SEGMENT||frame.data.length>f.writeCredit){this.failFlow(f,10054);return;}
            f.writeCredit-=frame.data.length;
            void b.write(f.child,frame.data).then(()=>{
                if(f.phase!=="live")return;f.writeCredit+=frame.data.length;this.emit(f,CREDIT,frame.data.length);
            },()=>{if(f.phase!=="closing")this.failFlow(f,10054);});
        } else if(frame.kind===CREDIT){
            if(!frame.value||frame.value>TCP_WINDOW-f.credit){this.failFlow(f,10054);return;}
            try{b.credit(f.child,frame.value);f.credit+=frame.value;}catch{this.failFlow(f,10055);}
        } else if(frame.kind===FIN){
            if(!f.receivedFin){f.receivedFin=true;void b.finishWrite(f.child).then(()=>{
                f.writeFinished=true;if(f.phase==="live"&&f.sentFin)this.retire(f);
            },()=>{if(f.phase!=="closing")this.failFlow(f,10054);});}
        } else if(frame.kind===OOB){this.failFlow(f,10045);}
        else if(frame.kind===TCP_OPTION){
            if(frame.data.length||![0,1,TCP_OPTION_KEEPALIVE,TCP_OPTION_KEEPALIVE|1,TCP_OPTION_NODELAY,TCP_OPTION_NODELAY|1].includes(frame.value)){this.failFlow(f,10022);return;}
            const opt=frame.value&~1;
            if(!opt){this.failFlow(f,10045);return;}
            void b.option(f.child,opt===TCP_OPTION_KEEPALIVE?1:2,!!(frame.value&1)).then(code=>{if(code&&f.phase!=="closing")this.failFlow(f,10054);},
                ()=>{if(f.phase!=="closing")this.failFlow(f,10054);});
        }
    }
    private data(child:AcceptChild,data:Uint8Array):boolean {
        const f=this.children.get(child.child);
        if(!f||f.child.permit!==child.permit)return false;
        if(f.phase==="closing")return true;
        if(f.phase!=="live"||data.length>f.credit)return false;
        f.credit-=data.length;return this.emit(f,DATA,0,data);
    }
    private eof(child:AcceptChild):void {
        const f=this.children.get(child.child);
        if(!f||f.child.permit!==child.permit)throw Error("Invalid child EOF");
        if(f.phase==="closing")return;
        if(f.phase!=="live"||f.sentFin)throw Error("Invalid child EOF");
        f.sentFin=true;this.emit(f,FIN);if(f.writeFinished&&f.phase==="live")this.retire(f);
    }
    private childClosed(child:AcceptChild,error?:number):void {
        const f=this.children.get(child.child);
        if(!f){if(this.dismissed.get(child.child)===child.permit)return;throw Error("Unknown child close");}
        if(f.child.permit!==child.permit)throw Error("Unknown child close");
        if(f.phase!=="closing") {if(error!==undefined)this.emit(f,RST,10054);f.phase="closing";}
        clearTimeout(f.timer);
        void this.bridge!.closeChild(child).then(()=>this.forget(f),()=>this.bridge?.abort(Error("Child close failed")));
    }
    private failFlow(f:Flow,code:number,dst=f.guest):void {if(f.phase!=="closing"){this.emit(f,RST,code,undefined,dst);this.retire(f);}}
    private retire(f:Flow):void {
        if(f.phase==="closing")return;f.phase="closing";clearTimeout(f.timer);
        void this.bridge!.closeChild(f.child).then(()=>this.forget(f),()=>this.bridge?.abort(Error("Child close failed")));
    }
    private forget(f:Flow):void {
        if(this.flows.get(f.id)!==f)return;
        this.flows.delete(f.id);this.children.delete(f.child.child);
        this.maybeFinish();
    }
    private processFailed():void {
        if(this.failed)return;this.failed=true;this.active=false;
        for(const f of this.flows.values()){
            clearTimeout(f.timer);
            if(f.phase!=="closing")this.emit(f,RST,10054);
            f.phase="closing";
        }
        this.flows.clear();this.children.clear();this.dismissed.clear();
        if(this.ready)try{this.onFailure(10054);}catch{}
    }
    private maybeFinish():void {
        if(!this.stopping||this.flows.size||this.dismissed.size||this.completion||!this.bridge)return;
        const b=this.bridge;
        this.completion=(async()=>{try{await b.shutdown();}catch(e){b.abort(e);await b.whenPhysicalClosed();}})();
    }
    closeListener():Promise<void> {
        if(this.stopPromise)return this.stopPromise;
        this.stopping=true;this.active=false;
        for(const f of this.flows.values())if(f.phase==="offer")this.failFlow(f,10054);
        const b=this.bridge;if(!b)return Promise.resolve();
        this.stopPromise=(async()=>{
            try{await b.stop();}catch(e){b.abort(e);await b.whenPhysicalClosed();return;}
            this.maybeFinish();
            await b.whenPhysicalClosed();
        })();
        return this.stopPromise;
    }
    close():void {
        if(this.disposed)return;this.disposed=true;
        void this.closeListener();
        for(const f of this.flows.values())this.retire(f);
    }
}
