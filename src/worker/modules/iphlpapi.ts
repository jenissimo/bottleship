import type { IModule } from "../core/module";
import type { Process } from "../core/process";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import {getVirtualNetworkTopology,getVirtualInterfacePrefixes,prefixMask,type VirtualNetworkTopology,type VirtualUnicastAddress} from "../net/virtual-topology";
import {lanNetwork,type LanNetwork} from "../net/lan-network";
import {Mem} from "../core/memory/mem-accessor";
import {isValidUserAddress} from "../core/memory/address-guard";
import {System} from "../core/system";
import {raiseGuestAccessViolation} from "../core/thunking/guest-fault";

export const IP_ADAPTER_INFO_SIZE=640;
export const IP_ADAPTER_ADDRESSES_SIZE=376;
export const IP_ADAPTER_UNICAST_SIZE=48;
export const IP_ADAPTER_PREFIX_SIZE=24;

class AdapterBuffer {
    private bytes=new Uint8Array(2048);
    private length=0;
    constructor(readonly base:number){}
    reserve(size:number,alignment=4):number{
        const offset=Math.ceil(this.length/alignment)*alignment,end=offset+size;
        if(end>this.bytes.length){const grown=new Uint8Array(Math.max(end,this.bytes.length*2));grown.set(this.bytes);this.bytes=grown;}
        this.length=end;return offset;
    }
    uint32(offset:number,value:number):void{new DataView(this.bytes.buffer).setUint32(offset,value>>>0,true);}
    uint64(offset:number,value:bigint):void{new DataView(this.bytes.buffer).setBigUint64(offset,value,true);}
    pointer(offset:number,target:number):void{this.uint32(offset,this.base+target);}
    data(offset:number,data:Uint8Array):void{this.bytes.set(data,offset);}
    ascii(text:string):number{const data=new TextEncoder().encode(text+"\0"),offset=this.reserve(data.length,1);this.data(offset,data);return offset;}
    wide(text:string):number{const offset=this.reserve((text.length+1)*2,2),view=new DataView(this.bytes.buffer);for(let i=0;i<text.length;i++)view.setUint16(offset+i*2,text.charCodeAt(i),true);return offset;}
    sockaddr(address:VirtualUnicastAddress):number{
        const offset=this.reserve(address.family===2?16:28);
        this.bytes[offset]=address.family;
        this.data(offset+(address.family===2?4:8),address.address);
        if(address.family===23)this.uint32(offset+24,address.scopeId);
        return offset;
    }
    finish():Uint8Array{return this.bytes.slice(0,this.length);}
}
const asciiField=(bytes:Uint8Array,offset:number,length:number,text:string):void=>{
    bytes.set(new TextEncoder().encode(text).subarray(0,length-1),offset);
};

/** The classic IPv4 API excludes loopback and uses fixed embedded IP_ADDR_STRINGs. */
export function encodeAdaptersInfo(topology:VirtualNetworkTopology,base:number):Uint8Array{
    const adapters=topology.interfaces.filter(adapter=>!adapter.loopback&&adapter.addresses.some(address=>address.family===2));
    const bytes=new Uint8Array(adapters.length*IP_ADAPTER_INFO_SIZE),view=new DataView(bytes.buffer);
    for(const [index,adapter]of adapters.entries()){
        const offset=index*IP_ADAPTER_INFO_SIZE,address=adapter.addresses.find(address=>address.family===2)!;
        if(index+1<adapters.length)view.setUint32(offset,base+offset+IP_ADAPTER_INFO_SIZE,true);
        asciiField(bytes,offset+8,260,adapter.name);asciiField(bytes,offset+268,132,adapter.description);
        view.setUint32(offset+400,adapter.physicalAddress.length,true);bytes.set(adapter.physicalAddress.subarray(0,8),offset+404);
        view.setUint32(offset+412,adapter.index,true);view.setUint32(offset+416,adapter.type,true);
        asciiField(bytes,offset+432,16,Array.from(address.address).join("."));
        asciiField(bytes,offset+448,16,Array.from(prefixMask(4,address.prefixLength)).join("."));
        for(const list of [468,508,552,592]){asciiField(bytes,offset+list+4,16,"0.0.0.0");asciiField(bytes,offset+list+20,16,"0.0.0.0");}
    }
    return bytes;
}

/** x86 Vista-SP1+ IP_ADAPTER_ADDRESSES layout, measured against current native Windows. */
export function encodeAdaptersAddresses(topology:VirtualNetworkTopology,base:number,family:number,flags:number):Uint8Array{
    const output=new AdapterBuffer(base),adapters=topology.interfaces;
    const rows=adapters.map(()=>output.reserve(IP_ADAPTER_ADDRESSES_SIZE,8));
    for(const [index,adapter]of adapters.entries()){
        const row=rows[index];
        output.uint32(row,IP_ADAPTER_ADDRESSES_SIZE);output.uint32(row+4,adapter.index);
        if(index+1<rows.length)output.pointer(row+8,rows[index+1]);
        output.pointer(row+12,output.ascii(adapter.name));
        output.pointer(row+32,output.wide(""));
        output.pointer(row+36,output.wide(adapter.description));
        if(!(flags&0x20))output.pointer(row+40,output.wide(adapter.description));
        output.data(row+44,adapter.physicalAddress.subarray(0,8));output.uint32(row+52,adapter.physicalAddress.length);
        const ipv4=adapter.addresses.some(address=>address.family===2),ipv6=adapter.addresses.some(address=>address.family===23);
        output.uint32(row+56,(adapter.multicast?0:0x10)|(ipv4?0x80:0)|(ipv6?0x100:0));
        output.uint32(row+60,adapter.mtu);output.uint32(row+64,adapter.type);output.uint32(row+68,adapter.up?1:2);
        output.uint32(row+72,ipv6?adapter.index:0);
        output.uint32(row+168,adapter.loopback?75:25);output.uint32(row+172,adapter.loopback?75:25);
        output.uint64(row+176,(BigInt(adapter.type)<<48n)|(BigInt(adapter.index)<<24n));
        output.uint32(row+192,1);output.uint32(row+212,1);
        const addresses=adapter.addresses.filter(address=>!family||address.family===family);
        if(!(flags&1)){
            let previous:number|undefined;
            for(const address of addresses){
                const entry=output.reserve(IP_ADAPTER_UNICAST_SIZE,8),sockaddr=output.sockaddr(address);
                if(previous===undefined)output.pointer(row+16,entry);else output.pointer(previous+8,entry);
                output.uint32(entry,IP_ADAPTER_UNICAST_SIZE);output.pointer(entry+12,sockaddr);output.uint32(entry+16,address.family===2?16:28);
                output.uint32(entry+20,1);output.uint32(entry+24,1);output.uint32(entry+28,4);
                output.uint32(entry+32,0xffffffff);output.uint32(entry+36,0xffffffff);output.uint32(entry+40,0xffffffff);
                output.data(entry+44,Uint8Array.of(address.prefixLength));previous=entry;
            }
        }
        if(flags&0x10){
            let previous:number|undefined;
            for(const address of getVirtualInterfacePrefixes(adapter).filter(address=>!family||address.family===family)){
                const entry=output.reserve(IP_ADAPTER_PREFIX_SIZE,8),sockaddr=output.sockaddr(address);
                if(previous===undefined)output.pointer(row+140,entry);else output.pointer(previous+8,entry);
                output.uint32(entry,IP_ADAPTER_PREFIX_SIZE);output.pointer(entry+12,sockaddr);output.uint32(entry+16,address.family===2?16:28);
                output.uint32(entry+20,address.prefixLength);previous=entry;
            }
        }
    }
    return output.finish();
}

const ZERO_BLOCK=new Uint8Array(65536);
/** Longest readable/writable prefix; permission changes inside a coarse region remain visible. */
function accessiblePrefix(mem:Uint8Array,address:number,length:number,perms:"r"|"rw"):number{
    let low=0,high=length;
    while(low<high){const middle=Math.ceil((low+high)/2);if(isValidUserAddress(mem,address,middle,perms))low=middle;else high=middle-1;}
    return low;
}
/** Native IP Helper zeroes the whole supplied capacity, with a fault after its accessible prefix. */
function clearAdapterOutput(mem:Uint8Array,address:number,length:number):number|undefined{
    let done=0;
    while(done<length){
        const size=Math.min(ZERO_BLOCK.length,length-done),pointer=address+done;
        if(!isValidUserAddress(mem,pointer,size,"rw")){
            const prefix=accessiblePrefix(mem,pointer,size,"rw");
            if(prefix)Mem.writeBytes(pointer,ZERO_BLOCK.subarray(0,prefix));
            return pointer+prefix;
        }
        Mem.writeBytes(pointer,ZERO_BLOCK.subarray(0,size));done+=size;
    }
    return undefined;
}
export class Iphlpapi implements IModule {
    name="iphlpapi";
    exports:Record<string,ThunkImplementation>={};
    constructor(private readonly network:LanNetwork=lanNetwork){}
    initialize(_process:Process):void{
        const query=(modern:boolean):ThunkImplementation=>(ctx,mem,args)=>{
            const family=modern?args[0]>>>0:2,flags=modern?args[1]>>>0:0;
            const output=args[modern?3:0]>>>0,sizePointer=args[modern?4:1]>>>0,cleanup=modern?20:8;
            if((modern&&![0,2,23].includes(family))||!sizePointer)return {value:87,stackCleanup:cleanup};
            if(!isValidUserAddress(mem,sizePointer,4,"r"))
                return raiseGuestAccessViolation(ctx,mem,sizePointer+accessiblePrefix(mem,sizePointer,4,"r"),"r",cleanup);
            const capacity=Mem.readUint32(sizePointer)!;
            const topology=getVirtualNetworkTopology(this.network);
            const bytes=modern?encodeAdaptersAddresses(topology,output,family,flags):encodeAdaptersInfo(topology,output);
            if(!output||capacity<bytes.length){
                if(!isValidUserAddress(mem,sizePointer,4,"rw"))
                    return raiseGuestAccessViolation(ctx,mem,sizePointer+accessiblePrefix(mem,sizePointer,4,"rw"),"w",cleanup);
                Mem.writeUint32(sizePointer,bytes.length);System.getInstance().scheduler.setLastError(0);
                return {value:111,stackCleanup:cleanup};
            }
            const fault=clearAdapterOutput(mem,output,capacity);
            if(fault!==undefined)return raiseGuestAccessViolation(ctx,mem,fault,"w",cleanup);
            Mem.writeBytes(output,bytes);System.getInstance().scheduler.setLastError(0);
            return {value:0,stackCleanup:cleanup};
        };
        this.exports.GetAdaptersInfo=query(false);this.exports.GetAdaptersAddresses=query(true);
    }
}
