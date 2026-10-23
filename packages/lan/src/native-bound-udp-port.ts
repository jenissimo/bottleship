import {NativeBoundUdpDriver} from "./native-bound-udp";
import {NativeUdpChannel,type NativeUdpChannelOwner,type PooledNativeUdpPort} from "./native-udp-port";
import {nativeUdpEndpoint,nativeUdpEndpointKey,udpFailure,type NativeUdpPeerError} from "./udp-bound-protocol";
interface Peer {
    id:number;epoch:number;identity:string;host:string;port:number;
    channel?:NativeUdpChannel;ready?:Promise<void>;release:()=>void;
}
/** A binding's bounded native tuple history owns policy leases until OS close. */
export class NativeBoundUdpPort implements NativeUdpChannelOwner,PooledNativeUdpPort {
    private readonly driver:NativeBoundUdpDriver;
    private readonly history=new Map<string,Peer>();
    private readonly byId=new Map<number,Peer>();
    private readonly channels=new Map<NativeUdpChannel,Peer>();
    private nextId=1;
    private closing=false;
    private failure?:Error;
    constructor(executable:string,private readonly family:4|6,private readonly empty:()=>void,private readonly historyLimit:number){
        this.driver=new NativeBoundUdpDriver(executable,family);
        this.driver.on("message",(bytes,{peerId,epoch})=>{
            const peer=this.byId.get(peerId);
            if(!this.closing&&peer&&peer.epoch===epoch)peer.channel?.deliver(bytes);
        });
        this.driver.on("peerError",(event:NativeUdpPeerError)=>{
            const peer=this.byId.get(event.peerId);
            if(!this.closing&&peer?.epoch===event.epoch)peer.channel?.peerError(Object.assign(
                udpFailure(event.code,"Native UDP peer reported port unreachable","peer",event.nativeCode),{endpoint:event.endpoint}));
        });
        this.driver.on("bindingError",error=>{
            this.failure=error;
            try{for(const channel of [...this.channels.keys()])channel.fail(error);}
            finally{this.dispose();}
        });
        this.driver.on("closed",()=>{
            for(const peer of this.history.values())peer.release();
            this.history.clear();this.byId.clear();
        });
    }
    private key(host:string,port:number):string{return nativeUdpEndpointKey(nativeUdpEndpoint(host,port,this.family));}
    available(host:string,port:number,identity:string):boolean{
        const peer=this.history.get(this.key(host,port));
        return !this.closing&&!this.failure&&(peer?peer.identity===identity&&!peer.channel&&peer.epoch<0xffffffff:this.history.size<Math.min(128,this.historyLimit));
    }
    attach(host:string,port:number,identity:string,release:()=>void=()=>{}):NativeUdpChannel{
        if(!this.available(host,port,identity))throw udpFailure(10048,"Native UDP tuple is owned by another identity","control");
        const key=this.key(host,port);let peer=this.history.get(key);
        if(peer){peer.epoch++;release();}
        else{peer={id:this.nextId++,epoch:1,identity,host,port,release};this.history.set(key,peer);this.byId.set(peer.id,peer);}
        const channel=new NativeUdpChannel(this,host,port);peer.channel=channel;peer.ready=undefined;this.channels.set(channel,peer);return channel;
    }
    connect(channel:NativeUdpChannel):void{
        const peer=this.channels.get(channel);
        if(!peer||this.closing){queueMicrotask(()=>channel.fail(udpFailure(10057,"Native UDP channel is closed")));return;}
        if(!peer.ready){
            const epoch=peer.epoch;
            peer.ready=this.driver.registerPeer(peer.id,epoch,peer.host,peer.port);
            void peer.ready.then(()=>{
                if(!this.closing&&peer.channel===channel&&peer.epoch===epoch)channel.ready();
            },error=>{
                if(!this.closing&&peer.channel===channel&&peer.epoch===epoch)channel.fail(error);
            });
        }
    }
    send(channel:NativeUdpChannel,bytes:Uint8Array,callback:(error?:Error|null)=>void):void{
        const peer=this.channels.get(channel);
        if(!peer||this.closing){queueMicrotask(()=>callback(udpFailure(10057,"Native UDP channel is closed","send")));return;}
        this.driver.send(peer.id,peer.epoch,bytes,callback);
    }
    detach(channel:NativeUdpChannel):void{
        const peer=this.channels.get(channel);if(!peer)return;
        this.channels.delete(channel);
        if(peer.channel===channel)peer.channel=undefined;
        if(!this.channels.size){
            this.closing=true;this.empty();void this.driver.close().catch(()=>{});return;
        }
        // PEER and RETIRE are ordered on the same input stream. Do not wait on
        // this old channel's ACK before admitting a later epoch of the same ID.
        const epoch=peer.epoch;
        void peer.ready?.then(()=>this.driver.retirePeer(peer.id,epoch)).catch(()=>{});
    }
    dispose():void{
        if(!this.closing){this.closing=true;this.empty();}
        for(const channel of [...this.channels.keys()])channel.close();
        void this.driver.close("abort").catch(()=>{});
    }
}
