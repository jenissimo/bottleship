import {createSocket,type Socket} from "node:dgram";
import {EventEmitter} from "node:events";
import {parseIpv6,formatIpv6} from "./ip-address";

function endpoint(host:string,port:number):string {
    const ipv6=parseIpv6(host);
    // Native UDP sendto resolves an unspecified destination to loopback. Keep
    // reply lookup and alias-collision checks in the same OS address space.
    if(ipv6&&ipv6.every(byte=>byte===0))ipv6[15]=1;
    return (ipv6?formatIpv6(ipv6):host==="0.0.0.0"?"127.0.0.1":host)+":"+port;
}
function unavailable():Error { return Object.assign(new Error("Native UDP channel closed"),{code:10057}); }

export interface NativeUdpChannelOwner {
    connect(channel:NativeUdpChannel):void;
    send(channel:NativeUdpChannel,bytes:Uint8Array,callback:(error?:Error|null)=>void):void;
    detach(channel:NativeUdpChannel):void;
}
export interface PooledNativeUdpPort {
    available(host:string,port:number,identity:string):boolean;
    attach(host:string,port:number,identity:string,release?:()=>void):NativeUdpChannel;
    dispose?():void;
}
export type NativeUdpPortFactory=(family:4|6,empty:()=>void,historyLimit:number)=>PooledNativeUdpPort;

/** A routed peer on one real, unconnected UDP socket. */
export class NativeUdpChannel extends EventEmitter {
    private closed=false;
    private connectCallback:((error?:Error)=>void)|undefined;
    constructor(private readonly owner:NativeUdpChannelOwner,readonly host:string,readonly port:number) { super(); }
    connect(port:number,host:string,callback:(error?:Error)=>void):void {
        if(this.closed){queueMicrotask(()=>callback(unavailable()));return;}
        if(endpoint(host,port)!==endpoint(this.host,this.port)){
            queueMicrotask(()=>callback(Object.assign(new Error("Native UDP peer changed"),{code:10022})));return;
        }
        this.connectCallback=callback;this.owner.connect(this);
    }
    ready():void {
        if(this.closed)return;
        const callback=this.connectCallback;this.connectCallback=undefined;callback?.();
    }
    fail(error:Error):void {
        if(this.closed)return;
        this.connectCallback=undefined;this.emit("error",error);
    }
    peerError(error:Error):void { if(!this.closed)this.emit("peerError",error); }
    deliver(bytes:Buffer):void { if(!this.closed)this.emit("message",bytes); }
    send(bytes:Uint8Array,callback:(error?:Error|null)=>void):void {
        if(this.closed){queueMicrotask(()=>callback(unavailable()));return;}
        this.owner.send(this,bytes,callback);
    }
    close():void {
        if(this.closed)return;
        this.closed=true;this.connectCallback=undefined;this.owner.detach(this);
    }
}

class NativeUdpPort {
    private readonly channels=new Map<string,NativeUdpChannel>();
    private readonly identities=new Map<string,string>();
    private listening=false;
    private closed=false;
    private failure:Error|undefined;
    constructor(family:4|6,private readonly empty:()=>void,private readonly socket:Socket,private readonly historyLimit:number) {
        this.socket.on("message",(bytes,remote)=>{
            // Only previously routed peers can enter the guest. An unrelated
            // sender to the shared public port must not create a virtual flow.
            this.channels.get(endpoint(remote.address,remote.port))?.deliver(bytes);
        });
        this.socket.on("error",error=>{
            if(this.closed)return;
            this.failure=error;
            for(const channel of [...this.channels.values()])channel.fail(error);
        });
        this.socket.on("listening",()=>{
            if(this.closed)return;
            this.listening=true;
            for(const channel of [...this.channels.values()])channel.ready();
        });
        try { this.socket.bind(0,family===4?"0.0.0.0":"::"); }
        catch(error) { queueMicrotask(()=>this.socket.emit("error",error)); }
    }
    available(host:string,port:number,identity:string):boolean {
        const key=endpoint(host,port),previous=this.identities.get(key);
        return !this.closed&&!this.failure&&!this.channels.has(key)&&
            (previous!==undefined?previous===identity:this.identities.size<this.historyLimit);
    }
    attach(host:string,port:number,identity:string):NativeUdpChannel {
        const key=endpoint(host,port),channel=new NativeUdpChannel(this,host,port);
        this.identities.set(key,identity);this.channels.set(key,channel);return channel;
    }
    connect(channel:NativeUdpChannel):void {
        if(this.failure)queueMicrotask(()=>channel.fail(this.failure!));
        else if(this.listening)queueMicrotask(()=>channel.ready());
    }
    send(channel:NativeUdpChannel,bytes:Uint8Array,callback:(error?:Error|null)=>void):void {
        if(this.closed||!this.listening||this.channels.get(endpoint(channel.host,channel.port))!==channel){
            queueMicrotask(()=>callback(unavailable()));return;
        }
        let completed=false;
        const complete=(error?:Error|null)=>{if(!completed){completed=true;callback(error);}};
        try { this.socket.send(bytes,channel.port,channel.host,complete); }
        catch(error) { complete(error as Error); }
    }
    detach(channel:NativeUdpChannel):void {
        const key=endpoint(channel.host,channel.port);
        if(this.channels.get(key)!==channel)return;
        this.channels.delete(key);
        if(this.channels.size||this.closed)return;
        this.closed=true;this.identities.clear();this.empty();
        try { this.socket.close(); }
        catch(error) { if((error as {code?:string}).code!=="ERR_SOCKET_DGRAM_NOT_RUNNING")throw error; }
    }
    dispose():void { for(const channel of [...this.channels.values()])channel.close(); }
}

/** Participant-local binding generations own independent native port groups. */
export class NativeUdpPortPool {
    private readonly groups=new Map<string,Set<PooledNativeUdpPort>>();
    constructor(private readonly createNativeSocket:(family:4|6)=>Socket=family=>createSocket(family===4?"udp4":"udp6"),private readonly historyLimit=128,private readonly factory?:NativeUdpPortFactory) {
        if(!Number.isSafeInteger(historyLimit)||historyLimit<1)throw new TypeError("Invalid native UDP peer history limit");
    }
    open(binding:string,family:4|6,host:string,port:number,identity=endpoint(host,port),release?:()=>void):NativeUdpChannel {
        const key=binding+":"+family;
        let ports=this.groups.get(key);
        if(!ports){ports=new Set();this.groups.set(key,ports);}
        let owner=[...ports].find(candidate=>candidate.available(host,port,identity));
        if(!owner){
            const group=ports;
            const empty=()=>{group.delete(owner!);if(!group.size&&this.groups.get(key)===group)this.groups.delete(key);};
            owner=this.factory?this.factory(family,empty,this.historyLimit):new NativeUdpPort(family,empty,this.createNativeSocket(family),this.historyLimit);
            group.add(owner);
        }
        // Retain bounded peer identities until the native port closes: a late
        // packet for a retired virtual alias must not enter its replacement.
        return owner.attach(host,port,identity,release);
    }
    close():void {
        for(const group of [...this.groups.values()])for(const port of [...group])port.dispose?.();
        this.groups.clear();
    }
}
