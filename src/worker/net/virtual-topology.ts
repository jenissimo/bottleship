import {lanNetwork,type LanNetwork} from './lan-network';
import {LAN_IPV6_PREFIX} from './netplay-wire';

export interface VirtualUnicastAddress {
    readonly family: 2 | 23;
    readonly address: Uint8Array;
    readonly prefixLength: number;
    readonly scopeId: number;
}
export interface VirtualNetworkInterface {
    readonly index: number;
    readonly name: string;
    readonly description: string;
    readonly physicalAddress: Uint8Array;
    readonly type: 6 | 24;
    readonly loopback: boolean;
    readonly up: boolean;
    readonly broadcast: boolean;
    readonly multicast: boolean;
    readonly mtu: number;
    readonly addresses: readonly VirtualUnicastAddress[];
}
export interface VirtualNetworkTopology {
    readonly identity: string;
    readonly hostname: string;
    readonly interfaces: readonly VirtualNetworkInterface[];
}

export function virtualHostName(network: LanNetwork = lanNetwork): string {
    return 'bottleship-'+Array.from(network.node.subarray(3),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Host-owned virtual adapter state. Relay destinations and host NICs are never local addresses. */
export function getVirtualNetworkTopology(network: LanNetwork = lanNetwork): VirtualNetworkTopology {
    const node=network.node.slice(),hex=Array.from(node,b=>b.toString(16).padStart(2,'0')).join('');
    const loopback6=new Uint8Array(16);loopback6[15]=1;
    return {identity:hex,hostname:virtualHostName(network),interfaces:[
        {index:2,name:`{42534C4E-0000-4000-8000-${hex}}`,description:'BottleShip virtual LAN',
            physicalAddress:node,type:6,loopback:false,up:true,broadcast:true,multicast:true,mtu:1500,
            addresses:[{family:2,address:network.ipv4.slice(),prefixLength:8,scopeId:0},
                {family:23,address:network.ipv6.slice(),prefixLength:LAN_IPV6_PREFIX.length*8,scopeId:0}]},
        {index:1,name:'{42534C4E-0000-4000-8000-000000000001}',description:'Software Loopback Interface',
            physicalAddress:new Uint8Array(0),type:24,loopback:true,up:true,broadcast:false,multicast:true,mtu:65536,
            addresses:[{family:2,address:Uint8Array.of(127,0,0,1),prefixLength:8,scopeId:0},
                {family:23,address:loopback6,prefixLength:128,scopeId:0}]},
    ]};
}

/** Windows x86 sockaddr_gen is 24 bytes; INTERFACE_INFO contains three of them after iiFlags. */
export const INTERFACE_INFO_SIZE=76;
export function encodeInterfaceList(topology: VirtualNetworkTopology): Uint8Array {
    const records=topology.interfaces.flatMap(adapter=>adapter.addresses.filter(a=>a.family===2).map(address=>({adapter,address})));
    const bytes=new Uint8Array(records.length*INTERFACE_INFO_SIZE),view=new DataView(bytes.buffer);
    for(const [index,{adapter,address}]of records.entries()){
        const offset=index*INTERFACE_INFO_SIZE;
        view.setUint32(offset,(adapter.up?1:0)|(adapter.broadcast?2:0)|(adapter.loopback?4:0)|(adapter.multicast?16:0),true);
        for(const field of [4,52])view.setUint16(offset+field,2,true);
        if(adapter.broadcast)view.setUint16(offset+28,2,true);
        bytes.set(address.address,offset+8);
        const mask=prefixMask(4,address.prefixLength);bytes.set(mask,offset+56);
        if(adapter.broadcast)for(let i=0;i<4;i++)bytes[offset+32+i]=address.address[i]|(~mask[i]&255);
    }
    return bytes;
}
/** Prefix routes owned by this adapter; multicast support currently covers IPv4 UDP. */
export function getVirtualInterfacePrefixes(adapter:VirtualNetworkInterface):VirtualUnicastAddress[] {
    const result:VirtualUnicastAddress[]=[];
    const add=(address:VirtualUnicastAddress)=>{
        if(!result.some(old=>old.family===address.family&&old.prefixLength===address.prefixLength&&old.scopeId===address.scopeId&&old.address.every((n,i)=>n===address.address[i])))
            result.push({...address,address:address.address.slice()});
    };
    for(const address of adapter.addresses){
        const mask=prefixMask(address.address.length,address.prefixLength),bits=address.address.length*8;
        add({...address,address:address.address.map((n,i)=>n&mask[i])});add({...address,prefixLength:bits});
        if(address.family===2&&adapter.broadcast){
            add({...address,address:address.address.map((n,i)=>n|(~mask[i]&255)),prefixLength:32});
            add({...address,address:Uint8Array.of(255,255,255,255),prefixLength:32});
        }
    }
    if(adapter.multicast&&adapter.addresses.some(address=>address.family===2))
        add({family:2,address:Uint8Array.of(224,0,0,0),prefixLength:4,scopeId:0});
    return result;
}
export function prefixMask(length: number,bits: number): Uint8Array {
    const mask=new Uint8Array(length);
    for(let i=0;i<length;i++){const count=Math.min(8,Math.max(0,bits-i*8));mask[i]=count?256-(1<<(8-count)):0;}
    return mask;
}
