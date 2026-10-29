import {spawn, type ChildProcess} from "node:child_process";
import {isIPv4} from "node:net";
import type {Writable} from "node:stream";
import {TcpAcceptQuota} from "./tcp-accept-quota";

/** Experimental process bridge. Not wired to LAN capability or server. */
export interface AcceptBridgeConfig {
    executable:string; bindHost:string; port:number; allowedHosts:readonly string[]; limit:number; epoch:number;
}
export interface AcceptChild {
    readonly child:bigint; readonly permit:bigint; readonly peerHost:string; readonly peerPort:number;
}
export interface AcceptBridgeSink {
    offer(child:AcceptChild):void;
    data(child:AcceptChild,data:Uint8Array):boolean;
    eof(child:AcceptChild):void;
    closed(child:AcceptChild,error?:number):void;
    failed(error:Error):void;
}
type Pending = {kind:string; child?:bigint; resolve:(value:number)=>void; reject:(e:Error)=>void};
type Flow = {
    info:AcceptChild; phase:"live"|"closing"|"retired"; credit:number;
    writes:Map<number,{size:number;resolve:()=>void;reject:(e:Error)=>void}>;
    writeBytes:number; writeEnded:boolean; eofSeen:boolean; closeId?:number; optionIds:Map<number,number>; fenceId?:number; barrierId?:number;
    done:Promise<void>; finish:()=>void; fail:(e:Error)=>void;
};
const CMD={GRANT:1,WRITE:2,URGENT:3,FIN:4,CREDIT:5,CLOSE:6,STOP:7,BARRIER:8,OPTION:9,FENCE:10,QUIESCE:11,EXIT:12} as const;
const EV={READY:101,NEED:102,GRANT:103,ACK:104,FINISHED:105,CLOSED:106,STOPPED:107,
    BARRIER:108,DATA:109,EOF:110,ERROR:111,OOB:112,OPTION:113,RETIRED:114,FENCE:115,QUIESCED:116,EXITING:117} as const;
const SEGMENT=16384, WINDOW=262144, INPUT_MAX=WINDOW+8192, CONTROL_MAX=8192;
const OUTPUT_MAX=2*(SEGMENT+32)*64, OP_MAX=256;
const err=(s:string)=>new Error(s);
function uint(n:number,min:number,max:number):boolean {return Number.isInteger(n)&&n>=min&&n<=max;}
function frame(op:number,id:number,epoch:number,body:Buffer=Buffer.alloc(0)):Buffer {
    const b=Buffer.alloc(16+body.length);b.writeUInt32LE(b.length);b[4]=1;b[5]=op;
    b.writeUInt32LE(id,8);b.writeUInt32LE(epoch,12);body.copy(b,16);return b;
}
function pair(child:bigint,permit:bigint):Buffer {
    const b=Buffer.alloc(16);b.writeBigUInt64LE(child);b.writeBigUInt64LE(permit,8);return b;
}
function exact(x:Buffer,len:number):void {if(x.length!==len)throw err("Invalid helper event length");}

/** Owns one helper and its exact quota reservations until physical closure. */
export class TcpAcceptBridge {
    private readonly owner={};
    private readonly child:ChildProcess;
    private readonly dataPipe:Writable;
    private readonly controlPipe:Writable;
    private readonly flows=new Map<bigint,Flow>();
    private readonly grants=new Map<number,bigint>();
    private readonly grantWaiters:Array<{resolve:()=>void;reject:(e:Error)=>void}>=[];
    private readonly pending=new Map<number,Pending>();
    private buffer=Buffer.alloc(0);
    private dataQueued=0; private controlQueued=0; private next=0;
    private started=false; private stopping=false; private stoppingPromise?:Promise<void>;
    private failed=false; private processClosed=false; private exitedEvent=false;
    private needCancel?:()=>void; private needQueued=false; private needWaiting=false; private activated=false; private shutting=false;
    private readonly closedPromise:Promise<void>;
    private closedResolve!:()=>void;
    private readyResolve!:(port:number)=>void; private readyReject!:(e:Error)=>void;
    readonly ready:Promise<number>;
    constructor(private readonly config:AcceptBridgeConfig,private readonly quota:TcpAcceptQuota,private readonly sink:AcceptBridgeSink) {
        const max=process.platform==="win32"?60:128;
        if(!config.executable||!isIPv4(config.bindHost)||!Array.isArray(config.allowedHosts)||
           !config.allowedHosts.length||config.allowedHosts.length>32||
           config.allowedHosts.some(host=>!isIPv4(host)||Number(host.split(".")[0])===0||Number(host.split(".")[0])>=224)||
           new Set(config.allowedHosts).size!==config.allowedHosts.length||
           !uint(config.port,0,65535)||!uint(config.limit,1,max)||!uint(config.epoch,1,0xffffffff))
            throw err("Invalid native accept configuration");
        this.config={...config,allowedHosts:[...config.allowedHosts]};
        this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
        void this.ready.catch(()=>{});
        this.closedPromise=new Promise(resolve=>{this.closedResolve=resolve;});
        const controlArg=process.platform==="win32"?"fd:3":"3";
        this.child=spawn(config.executable,[config.bindHost,String(config.port),config.allowedHosts.join(","),
            String(config.limit),String(config.epoch),controlArg],
            {stdio:["pipe","pipe","pipe","pipe"],windowsHide:true});
        const d=this.child.stdin,c=this.child.stdio[3];
        if(!d||!c||!("write" in c))throw err("Native helper pipes unavailable");
        this.dataPipe=d;this.controlPipe=c as Writable;
        this.child.stderr?.resume();
        this.child.stdout?.on("data",(bytes:Buffer)=>this.receive(bytes));
        this.child.stdout?.on("error",e=>this.abort(e));
        this.dataPipe.on("error",e=>this.abort(e));this.controlPipe.on("error",e=>this.abort(e));
        this.child.on("error",e=>this.abort(e));
        this.child.on("close",(code,signal)=>{
            this.processClosed=true;
            this.quota.processClosed(this.owner,this.config.epoch);
            if(!this.failed&&(!this.exitedEvent||code!==0||signal||this.buffer.length))
                this.abort(err("Native helper exited unexpectedly"));
            this.closedResolve();
        });
    }
    private id():number {
        if(this.next===0xffffffff)throw err("Native request identity exhausted");
        return ++this.next;
    }
    /** false means no bytes admitted; exceptions have an uncertain outcome. */
    private send(control:boolean,op:number,id:number,body?:Buffer):boolean {
        if(this.failed||this.processClosed)return false;
        const b=frame(op,id,this.config.epoch,body),queued=control?this.controlQueued:this.dataQueued;
        if(b.length>(control?CONTROL_MAX:INPUT_MAX)-queued)return false;
        if(control)this.controlQueued+=b.length;else this.dataQueued+=b.length;
        const pipe=control?this.controlPipe:this.dataPipe;
        try {
            pipe.write(b,e=>{
                if(control)this.controlQueued-=b.length;else this.dataQueued-=b.length;
                if(e)this.abort(e);
            });
        } catch(e) {this.abort(e);throw e;}
        return true;
    }
    private beginRequest(control:boolean,op:number,kind:string,body?:Buffer,child?:bigint):{id:number;promise:Promise<number>} {
        if(this.failed||this.processClosed)throw err("Native helper unavailable");
        if(this.pending.size>=OP_MAX)throw err("Native operation capacity exceeded");
        const id=this.id();
        const promise=new Promise<number>((resolve,reject)=>{
            this.pending.set(id,{kind,child,resolve,reject});
            try {if(!this.send(control,op,id,body)){this.pending.delete(id);reject(err("Native IPC capacity exceeded"));}}
            catch(e){this.pending.delete(id);reject(e instanceof Error?e:err(String(e)));}
        });
        return {id,promise};
    }
    private async request(control:boolean,op:number,kind:string,body?:Buffer,child?:bigint):Promise<number> {
        return this.beginRequest(control,op,kind,body,child).promise;
    }
    private waitForGrants():Promise<void> {
        if(this.failed)return Promise.reject(err("Native helper unavailable"));
        if(!this.grants.size)return Promise.resolve();
        return new Promise((resolve,reject)=>this.grantWaiters.push({resolve,reject}));
    }
    private grantsSettled():void {
        if(!this.grants.size)for(const waiter of this.grantWaiters.splice(0))waiter.resolve();
    }
    private done(id:number,kind:string,child?:bigint,value=0):void {
        const p=this.pending.get(id);
        if(!p||p.kind!==kind||p.child!==child)throw err("Unexpected helper response");
        this.pending.delete(id);p.resolve(value);
    }
    private receive(bytes:Buffer):void {
        if(this.failed)return;
        try {
            if(this.buffer.length+bytes.length>OUTPUT_MAX)throw err("Native output capacity exceeded");
            this.buffer=this.buffer.length?Buffer.concat([this.buffer,bytes]):Buffer.from(bytes);
            while(this.buffer.length>=16) {
                const size=this.buffer.readUInt32LE(0);
                if(size<16||size>SEGMENT+32)throw err("Invalid native frame size");
                if(this.buffer.length<size)break;
                const b=this.buffer.subarray(0,size);this.buffer=this.buffer.subarray(size);
                if(b[4]!==1||b[6]||b[7]||b.readUInt32LE(12)!==this.config.epoch)throw err("Invalid native frame header");
                this.event(b[5],b.readUInt32LE(8),b.subarray(16));
                if(this.failed){this.buffer=Buffer.alloc(0);return;}
            }
        } catch(e){this.abort(e);}
    }
    private event(op:number,id:number,b:Buffer):void {
        if(op===EV.READY) {
            exact(b,4);const port=b.readUInt32LE();
            if(id||this.started||!uint(port,1,65535))throw err("Invalid READY");
            this.started=true;this.readyResolve(port);return;
        }
        if(!this.started)throw err("Event before READY");
        if(op===EV.NEED) {
            exact(b,0);if(id||this.needQueued||this.needWaiting||this.grants.size)throw err("Invalid NEED");
            if(this.stopping)return;
            if(!this.activated){this.needWaiting=true;return;}
            this.demandGrant();return;
        }
        if(op===EV.GRANT) {

            exact(b,28);const permit=b.readBigUInt64LE(4),child=b.readBigUInt64LE(12),status=b.readUInt32LE();
            if(this.grants.get(id)!==permit)throw err("Unknown grant result");
            this.grants.delete(id);
            this.grantsSettled();
            if(status===0||status===2) {
                if(child!==0n&&status===0)throw err("Invalid unused grant");
                if(!this.quota.complete(this.owner,this.config.epoch,permit))throw err("Unknown permit");
            } else if(status===1) {
                const port=b.readUInt32LE(24),host=[...b.subarray(20,24)].join(".");
                if(!child||!uint(port,1,65535)||!this.config.allowedHosts.includes(host)||this.flows.has(child)||this.flows.size>=this.config.limit)throw err("Invalid child");
                let finish!:()=>void,fail!:(e:Error)=>void;
                const done=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
                // Attach immediately; callers may observe completion later.
                void done.catch(()=>{});
                const info={child,permit,peerHost:host,peerPort:port};
                this.flows.set(child,{info,phase:"live",credit:0,writes:new Map(),writeBytes:0,writeEnded:false,eofSeen:false,optionIds:new Map(),done,finish,fail});
                this.sink.offer(info);
            } else throw err("Unsupported grant result");
            return;
        }
        if(op===EV.STOPPED){exact(b,0);this.done(id,"stop");return;}
        if(op===EV.QUIESCED){exact(b,0);this.done(id,"quiesce");return;}
        if(op===EV.EXITING){exact(b,0);this.done(id,"exit");this.exitedEvent=true;return;}
        if(b.length<16)throw err("Missing child identity");
        const child=b.readBigUInt64LE(),permit=b.readBigUInt64LE(8),flow=this.flows.get(child);
        if(!flow||flow.info.permit!==permit)throw err("Stale child event");
        if(op===EV.DATA||op===EV.OOB) {
            if(id||flow.phase==="retired"||flow.eofSeen||b.length<=16||b.length>SEGMENT+16||
               (op===EV.OOB&&b.length!==17)||b.length-16>flow.credit)throw err("Invalid native data");
            flow.credit-=b.length-16;
            if(!this.sink.data(flow.info,Uint8Array.from(b.subarray(16))))throw err("Native data rejected");
        } else if(op===EV.EOF) {
            exact(b,16);if(id||flow.phase==="retired"||flow.eofSeen)throw err("Invalid native EOF");flow.eofSeen=true;this.sink.eof(flow.info);
        } else if(op===EV.ACK||op===EV.FINISHED) {
            exact(b,20);const write=b.readUInt32LE(16),p=flow.writes.get(write);
            if(id||!p||(op===EV.FINISHED)!==(write===0))throw err("Unknown native write");
            flow.writes.delete(write);flow.writeBytes-=p.size;p.resolve();
        } else if(op===EV.OPTION) {
            exact(b,28);const option=flow.optionIds.get(id);
            if(option===undefined||b.readUInt32LE(16)!==option||b.readUInt32LE(20)>1)throw err("Unknown option response");
            flow.optionIds.delete(id);this.done(id,"option",child,b.readUInt32LE(24));this.maybeFence(flow);
        } else if(op===EV.CLOSED||op===EV.ERROR) {
            exact(b,op===EV.ERROR?20:16);
            if(flow.phase==="retired"||(!id&&op===EV.CLOSED))throw err("Duplicate close");
            if(op===EV.CLOSED) {
                if(flow.closeId!==id)throw err("Unexpected close");flow.closeId=undefined;
                this.done(id,"close",child);
            } else if(id)throw err("Invalid child error");
            flow.phase="retired";
            if(!this.quota.complete(this.owner,this.config.epoch,permit))throw err("Unknown closed permit");
            for(const p of flow.writes.values())p.reject(err("Native child closed"));
            flow.writes.clear();flow.writeBytes=0;
            this.sink.closed(flow.info,op===EV.ERROR?b.readUInt32LE(16):undefined);
            this.maybeFence(flow);
        } else if(op===EV.RETIRED) {
            exact(b,16);if(flow.phase!=="retired"||flow.closeId!==id)throw err("Unexpected retired close");
            flow.closeId=undefined;this.done(id,"close",child);this.maybeFence(flow);
        } else if(op===EV.FENCE) {
            exact(b,16);if(flow.fenceId!==id||flow.phase!=="retired")throw err("Unexpected fence");
            flow.fenceId=undefined;this.done(id,"fence",child);
            const request=this.beginRequest(false,CMD.BARRIER,"barrier",pair(child,permit),child);
            flow.barrierId=request.id;void request.promise.catch(e=>this.abort(e));
        } else if(op===EV.BARRIER) {
            exact(b,16);if(flow.barrierId!==id||flow.phase!=="retired")throw err("Unexpected barrier");
            flow.barrierId=undefined;this.done(id,"barrier",child);
            this.flows.delete(child);flow.finish();
        } else throw err("Unknown native event");
    }
    /** Permit admission is enabled only after the owner has published Opened. */
    activate():void {
        if(this.failed||this.processClosed||this.stopping||!this.started)throw err("Native helper cannot activate");
        if(this.activated)return;
        this.activated=true;
        if(this.needWaiting){
            this.needWaiting=false;
            try{this.demandGrant();}catch(e){this.abort(e);throw e;}
        }
    }
    private demandGrant():void {
        this.needQueued=true;
        const cancel=this.quota.demand({owner:this.owner,epoch:this.config.epoch,
            grant:permit=>{
                this.needQueued=false;this.needCancel=undefined;
                if(this.failed||this.stopping)return false;
                const req=this.id();this.grants.set(req,permit);
                try {if(!this.send(false,CMD.GRANT,req,(()=>{const x=Buffer.alloc(8);x.writeBigUInt64LE(permit);return x;})())) {
                    this.grants.delete(req);this.abort(err("Native grant IPC capacity exceeded"));return false;
                }} catch(e){this.abort(e);throw e;}
                return true;
            },fatal:e=>this.abort(e)});
        if(cancel===null){this.needQueued=false;throw err("Native demand capacity exceeded");}
        if(this.needQueued)this.needCancel=cancel;
    }
    private maybeFence(flow:Flow):void {
        if(flow.phase!=="retired"||flow.closeId||flow.optionIds.size||flow.fenceId||flow.barrierId||this.failed)return;
        try {
            const request=this.beginRequest(true,CMD.FENCE,"fence",pair(flow.info.child,flow.info.permit),flow.info.child);
            flow.fenceId=request.id;void request.promise.catch(e=>this.abort(e));
        } catch(e){this.abort(e);}
    }
    private flow(info:AcceptChild):Flow {
        const f=this.flows.get(info.child);
        if(!f||f.info.permit!==info.permit||f.phase!=="live"||this.shutting)throw err("Native child unavailable");
        return f;
    }
    credit(info:AcceptChild,amount:number):void {
        const f=this.flow(info);
        if(!uint(amount,1,WINDOW-f.credit))throw err("Invalid native credit");
        const b=Buffer.alloc(20);pair(info.child,info.permit).copy(b);b.writeUInt32LE(amount,16);
        if(!this.send(false,CMD.CREDIT,this.id(),b))throw err("Native IPC capacity exceeded");
        f.credit+=amount;
    }
    write(info:AcceptChild,data:Uint8Array,urgent=false):Promise<void> {
        const f=this.flow(info);
        if(f.writeEnded||!data.length||data.length>SEGMENT||(urgent&&data.length!==1)||f.writes.size>=256||data.length>WINDOW-f.writeBytes)
            return Promise.reject(err("Native write capacity exceeded"));
        const id=this.id(),body=Buffer.alloc(20+data.length);pair(info.child,info.permit).copy(body);
        body.writeUInt32LE(id,16);body.set(data,20);
        return new Promise((resolve,reject)=>{
            f.writes.set(id,{size:data.length,resolve,reject});f.writeBytes+=data.length;
            try {if(!this.send(false,urgent?CMD.URGENT:CMD.WRITE,this.id(),body)){
                f.writes.delete(id);f.writeBytes-=data.length;reject(err("Native IPC capacity exceeded"));
            }} catch(e){f.writes.delete(id);f.writeBytes-=data.length;reject(e instanceof Error?e:err(String(e)));}
        });
    }
    finishWrite(info:AcceptChild):Promise<void> {
        const f=this.flow(info);
        if(f.writeEnded)return Promise.reject(err("FIN already sent"));
        return new Promise((resolve,reject)=>{
            f.writeEnded=true;f.writes.set(0,{size:0,resolve,reject});
            try {if(!this.send(false,CMD.FIN,this.id(),pair(info.child,info.permit))){f.writeEnded=false;f.writes.delete(0);reject(err("Native IPC capacity exceeded"));}}
            catch(e){f.writes.delete(0);reject(e instanceof Error?e:err(String(e)));}
        });
    }
    option(info:AcceptChild,option:number,enabled:boolean):Promise<number> {
        const f=this.flow(info);
        if(!uint(option,0,2))return Promise.reject(err("Invalid native option"));
        const body=Buffer.alloc(24);pair(info.child,info.permit).copy(body);body.writeUInt32LE(option,16);body.writeUInt32LE(+enabled,20);
        try {
            const request=this.beginRequest(true,CMD.OPTION,"option",body,info.child);
            f.optionIds.set(request.id,option);
            void request.promise.catch(()=>{f.optionIds.delete(request.id);this.maybeFence(f);});
            return request.promise;
        } catch(e){return Promise.reject(e);}
    }
    closeChild(info:AcceptChild):Promise<void> {
        const f=this.flows.get(info.child);
        if(!f||f.info.permit!==info.permit)return Promise.reject(err("Unknown native child"));
        if(f.phase!=="live")return f.done;
        f.phase="closing";
        try {
            const request=this.beginRequest(true,CMD.CLOSE,"close",pair(info.child,info.permit),info.child);
            f.closeId=request.id;void request.promise.catch(e=>this.abort(e));
        } catch(e){this.abort(e);}
        return f.done;
    }
    async stop():Promise<void> {
        if(this.stoppingPromise)return this.stoppingPromise;
        this.stopping=true;this.needCancel?.();this.needCancel=undefined;this.needQueued=false;this.needWaiting=false;
        this.stoppingPromise=(async()=>{await this.ready;await this.request(true,CMD.STOP,"stop");})();
        return this.stoppingPromise;
    }
    async shutdown():Promise<void> {
        if(this.shutting)throw err("Shutdown already requested");
        this.shutting=true;await this.stop();
        await this.waitForGrants();
        await Promise.all([...this.flows.values()].map(f=>this.closeChild(f.info)));
        await this.request(false,CMD.QUIESCE,"quiesce");
        await this.request(true,CMD.EXIT,"exit");
        await this.closedPromise;
        if(this.failed)throw err("Native graceful shutdown failed");
    }
    whenPhysicalClosed():Promise<void> {return this.closedPromise;}
    abort(reason:unknown):void {
        if(this.failed)return;this.failed=true;
        const e=reason instanceof Error?reason:err(String(reason));
        this.needCancel?.();this.needCancel=undefined;this.needQueued=false;this.needWaiting=false;
        this.quota.cancelOwner(this.owner,this.config.epoch);
        this.readyReject(e);
        for(const waiter of this.grantWaiters.splice(0))waiter.reject(e);
        for(const p of this.pending.values())p.reject(e);this.pending.clear();
        for(const f of this.flows.values()){for(const w of f.writes.values())w.reject(e);f.fail(e);}
        try{this.sink.failed(e);}catch{}
        if(!this.processClosed)try{this.child.kill();}catch{}
    }
}
