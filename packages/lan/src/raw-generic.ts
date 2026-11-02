import type {GatewayRoutes,GatewayRoute} from "./gateway";
import {NativeRawSocket} from "./native-raw";
import {echoIdentifier} from "./icmp-nat";
import {encodeDatagram,nodeKey,nodeToIpv4,PROTO_RAW4,rawHeaderLength,RAW_FLAG_OPTIONS,type DecodedDatagram} from "./protocol";
import {LAN_IPV6_PREFIX,parseIpv6} from "./ip-address";

type SocketError={node:number[];localPort:number;remotePort:number;proto:number;code:number;bindingGeneration?:number};
interface Flow{
    socket:NativeRawSocket;node:Uint8Array;nativeHost:string;localPort:number;proto:number;family:4|6;protocol:number;
    bindingGeneration?:number;seen:number;closed:boolean;release:()=>void;timer:ReturnType<typeof setTimeout>;
}
/** Actual OS raw sockets with a deliberately exclusive native destination lease.
 * Address/checksum translation is native; simultaneous foreign flows require
 * tuple NAT or separate native network addresses and are rejected with 10048. */
export class GenericRawGateway{
    private readonly flows=new Map<string,Flow>();
    private sweep:ReturnType<typeof setInterval>|undefined;
    get size():number{return this.flows.size;}
    constructor(private readonly routes:GatewayRoutes,
        private readonly emit:(frame:Uint8Array<ArrayBuffer>,reliable:boolean,bindingGeneration?:number)=>boolean,
        private readonly report:(error:SocketError)=>void,private readonly guestNode:Uint8Array,
        private readonly owner:object,private readonly echoCount:()=>number,
        private readonly translatedUdp:(host:string,packet:Uint8Array,family:4|6)=>boolean=()=>false){}
    handle(datagram:DecodedDatagram,route:GatewayRoute,ip:string):void{
        const family=datagram.proto===PROTO_RAW4?4:6,protocol=datagram.payload[0],included=!!(datagram.payload[1]&1);
        const socketProtocol=datagram.srcPort-1,packet=datagram.payload.subarray(rawHeaderLength(datagram.payload));
        const reject=(code:number)=>this.report({node:[...datagram.node],localPort:datagram.srcPort,remotePort:datagram.dstPort,proto:datagram.proto,bindingGeneration:datagram.bindingGeneration,code});
        if(family===6&&(socketProtocol===0||socketProtocol===255||socketProtocol!==protocol)){reject(10045);return;}
        const key=datagram.proto+":"+datagram.srcPort+":"+nodeKey(datagram.node)+":"+protocol+":"+ +included+":"+(datagram.bindingGeneration??"legacy");
        let flow=this.flows.get(key);
        if(!flow){
            if(this.flows.size+this.echoCount()>=(this.routes.options.maxRawFlows??64)){reject(10055);return;}
            let lease:{host:string;release:()=>void};
            try{lease=this.routes.acquireNative(route,ip,this.owner,true);}catch(error){reject((error as {code?:number}).code??10054);return;}
            const socket=new NativeRawSocket(this.routes.options.nativeHelperPath!);
            flow={socket,node:datagram.node.slice(),nativeHost:lease.host,localPort:datagram.srcPort,proto:datagram.proto,family,protocol,
                bindingGeneration:datagram.bindingGeneration,seen:Date.now(),closed:false,release:lease.release,timer:setTimeout(()=>{if(flow&&!flow.closed){reject(10060);this.closeFlow(key,flow);}},this.routes.options.connectTimeoutMs??10000)};
            const current=flow;this.flows.set(key,flow);
            socket.on("connect",()=>clearTimeout(current.timer));
            socket.on("error",(error:Error&{code?:number})=>{if(!current.closed){reject(error.code??10054);this.closeFlow(key,current);}});
            socket.on("message",(bytes:Uint8Array)=>{
                if(current.closed)return;
                const actual=current.family===4?(bytes.length>=20&&bytes[0]>>>4===4?bytes[9]:-1):current.protocol;
                if(actual<0||!this.routes.findRaw(ip,actual))return;
                if(actual===17&&this.translatedUdp(current.nativeHost,bytes,current.family))return;
                // Echo identifier NAT already routes these packets to their owner.
                // Capturing them again here would duplicate delivery to wildcards.
                const echo=actual===(current.family===4?1:58)?echoIdentifier(bytes,current.family,current.family===4,true):null;
                if(echo!==null&&this.routes.ownsEchoId(echo))return;
                const payload=new Uint8Array(bytes.length+2);payload[0]=actual;payload[1]=current.family===4?1:0;payload.set(bytes,2);
                current.seen=Date.now();this.emit(encodeDatagram(current.proto,current.node,current.localPort,actual+1,payload),false,current.bindingGeneration);
            });
            socket.connect(lease.host,family,socketProtocol,included);
            const source=family===4?nodeToIpv4(this.guestNode):new Uint8Array(16);
            if(family===6){source.set(LAN_IPV6_PREFIX);source.set(this.guestNode,10);}
            const destination=family===4?nodeToIpv4(datagram.node):parseIpv6(ip);
            if(!destination){reject(10049);this.closeFlow(key,current);return;}
            socket.setGuestAddresses(source,destination);socket.setIpOptions(128,0);this.startSweep();
        }
        flow.seen=Date.now();const current=flow;
        if(datagram.payload[1]&RAW_FLAG_OPTIONS)flow.socket.setIpOptions(new DataView(datagram.payload.buffer,datagram.payload.byteOffset).getInt16(2,true),datagram.payload[4]);
        if(!flow.socket.send(packet,error=>{if(error&&!current.closed){reject((error as {code?:number}).code??10054);this.closeFlow(key,current);}}))reject(10055);
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
