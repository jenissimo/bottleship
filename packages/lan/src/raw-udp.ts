import type {GatewayRoutes,GatewayRoute} from "./gateway";
import {NativeRawSocket} from "./native-raw";
import {LAN_IPV6_PREFIX,parseIpv6} from "./ip-address";
import {encodeDatagram,nodeKey,nodeToIpv4,PROTO_RAW4,rawHeaderLength,RAW_FLAG_OPTIONS,type DecodedDatagram} from "./protocol";

type SocketError={node:number[];localPort:number;remotePort:number;proto:number;code:number;bindingGeneration?:number};
interface Flow {
    socket:NativeRawSocket;node:Uint8Array;nativeHost:string;nativePort:number;localPort:number;proto:number;family:4|6;
    bindingGeneration?:number;seen:number;closed:boolean;release:()=>void;timer:ReturnType<typeof setTimeout>;
}
/** Parse only an unfragmented UDP header. Unknown extension chains cannot be NATed safely. */
export function rawUdpPorts(packet:Uint8Array,family:4|6,included:boolean):{source:number;destination:number}{
    let offset=0;
    const fail=(code:number):never=>{throw Object.assign(new Error("Raw UDP packet cannot be translated"),{code});};
    if(included){
        if(family===4){
            if(packet.length<20||packet[0]>>>4!==4)fail(10022);
            offset=(packet[0]&15)*4;
            if(offset<20||offset>packet.length||packet[9]!==17)fail(10022);
            if(((packet[6]<<8)|packet[7])&0x3fff)fail(10045);
        }else{
            if(packet.length<40||packet[0]>>>4!==6)fail(10022);
            if(packet[6]!==17)fail(10045);
            offset=40;
        }
    }
    if(packet.length-offset<8)fail(10022);
    return {source:(packet[offset]<<8)|packet[offset+1],destination:(packet[offset+2]<<8)|packet[offset+3]};
}
/** UDP source-port NAT with actual kernel port reservations and raw packet I/O.
 * Native TCP and unknown raw protocols retain the separate exclusive backend. */
export class RawUdpGateway {
    private readonly flows=new Map<string,Flow>();
    private sweep:ReturnType<typeof setInterval>|undefined;
    get size():number{return this.flows.size;}
    constructor(private readonly routes:GatewayRoutes,
        private readonly emit:(frame:Uint8Array<ArrayBuffer>,reliable:boolean,bindingGeneration?:number)=>boolean,
        private readonly report:(error:SocketError)=>void,private readonly guestNode:Uint8Array,
        private readonly owner:object,private readonly otherCount:()=>number){}
    ownsPacket(host:string,packet:Uint8Array,family:4|6):boolean{
        let tuple:{source:number;destination:number};
        try{tuple=rawUdpPorts(packet,family,family===4);}catch{return false;}
        return [...this.flows.values()].some(flow=>flow.nativeHost===host&&flow.family===family&&flow.nativePort===tuple.destination);
    }
    handle(datagram:DecodedDatagram,route:GatewayRoute,ip:string):void{
        const family=datagram.proto===PROTO_RAW4?4:6,included=!!(datagram.payload[1]&1);
        const packet=datagram.payload.subarray(rawHeaderLength(datagram.payload));
        const reject=(code:number)=>this.report({node:[...datagram.node],localPort:datagram.srcPort,remotePort:datagram.dstPort,proto:datagram.proto,bindingGeneration:datagram.bindingGeneration,code});
        let tuple:{source:number;destination:number};
        try{tuple=rawUdpPorts(packet,family,included);}catch(error){reject((error as {code?:number}).code??10022);return;}
        const key=datagram.proto+":"+datagram.srcPort+":"+nodeKey(datagram.node)+":"+tuple.source+":"+tuple.destination+":"+ +included+":"+(datagram.bindingGeneration??"legacy");
        let flow=this.flows.get(key);
        if(!flow){
            if(this.flows.size+this.otherCount()>=(this.routes.options.maxRawFlows??64)){reject(10055);return;}
            let lease:{host:string;release:()=>void};
            try{lease=this.routes.acquireNative(route,ip,this.owner);}catch(error){reject((error as {code?:number}).code??10054);return;}
            const socket=new NativeRawSocket(this.routes.options.nativeHelperPath!);
            flow={socket,node:datagram.node.slice(),nativeHost:lease.host,nativePort:0,localPort:datagram.srcPort,proto:datagram.proto,family,
                bindingGeneration:datagram.bindingGeneration,seen:Date.now(),closed:false,release:lease.release,timer:setTimeout(()=>{if(flow&&!flow.closed){reject(10060);this.closeFlow(key,flow);}},this.routes.options.connectTimeoutMs??10000)};
            const current=flow;this.flows.set(key,current);
            // A raw socket can capture unrelated packets before CMD_UDP_TUPLE is
            // processed. Never publish a datagram until its reservation is ready.
            socket.on("udpTuple",(reservation:{guestPort:number;remotePort:number;nativePort:number})=>{
                if(current.closed)return;
                if(reservation.guestPort!==tuple.source||reservation.remotePort!==tuple.destination){reject(10022);this.closeFlow(key,current);return;}
                current.nativePort=reservation.nativePort;clearTimeout(current.timer);
            });
            socket.on("error",(error:Error&{code?:number})=>{if(!current.closed){reject(error.code??10054);this.closeFlow(key,current);}});
            socket.on("message",(bytes:Uint8Array)=>{
                if(current.closed||!current.nativePort)return;
                let reply:{source:number;destination:number};
                try{reply=rawUdpPorts(bytes,family,family===4);}catch{return;}
                // The helper has already restored the guest destination port.
                if(reply.source!==tuple.destination||reply.destination!==tuple.source)return;
                const payload=new Uint8Array(bytes.length+2);payload[0]=17;payload[1]=family===4?1:0;payload.set(bytes,2);
                current.seen=Date.now();this.emit(encodeDatagram(current.proto,current.node,current.localPort,18,payload),false,current.bindingGeneration);
            });
            const source=family===4?nodeToIpv4(this.guestNode):new Uint8Array(16);
            if(family===6){source.set(LAN_IPV6_PREFIX);source.set(this.guestNode,10);}
            const destination=family===4?nodeToIpv4(datagram.node):parseIpv6(ip);
            if(!destination){reject(10049);this.closeFlow(key,current);return;}
            socket.connect(lease.host,family,17,included);
            socket.setGuestAddresses(source,destination);socket.setUdpTuple(tuple.source,tuple.destination);
            socket.setIpOptions(128,0);this.startSweep();
        }
        const current=flow;current.seen=Date.now();
        if(datagram.payload[1]&RAW_FLAG_OPTIONS)current.socket.setIpOptions(new DataView(datagram.payload.buffer,datagram.payload.byteOffset).getInt16(2,true),datagram.payload[4]);
        if(!current.socket.send(packet,error=>{if(error&&!current.closed){reject((error as {code?:number}).code??10054);this.closeFlow(key,current);}}))reject(10055);
    }
    private startSweep():void{
        if(this.sweep)return;
        this.sweep=setInterval(()=>{const deadline=Date.now()-(this.routes.options.udpIdleTimeoutMs??60000);
            for(const [key,flow]of this.flows)if(flow.seen<deadline)this.closeFlow(key,flow);},1000);this.sweep.unref();
    }
    private closeFlow(key:string,flow:Flow):void{
        if(flow.closed)return;flow.closed=true;clearTimeout(flow.timer);flow.release();this.flows.delete(key);flow.socket.close();
        if(!this.flows.size){clearInterval(this.sweep);this.sweep=undefined;}
    }
    releasePort(proto:number,port:number,generation:number):void{
        for(const [key,flow]of this.flows)if(flow.proto===proto&&flow.localPort===port
            &&(flow.bindingGeneration===undefined||flow.bindingGeneration<=generation))this.closeFlow(key,flow);
    }
    close():void{for(const [key,flow]of this.flows)this.closeFlow(key,flow);}
}
