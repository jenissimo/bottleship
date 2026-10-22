import {afterEach,expect,test} from "bun:test";
import {decodeTcpFrame,encodeTcpFrame,SYN,RST} from "../../src/worker/net/netplay-wire";
import {WsaSocketTable,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {makeSocketExports,WsaStartupCount} from "../../src/worker/modules/wsa-stub-shared";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {Process} from "../../src/worker/core/process";
import {System} from "../../src/worker/core/system";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
const disposers:Array<()=>void>=[];
afterEach(()=>{for(const fn of disposers.splice(0).reverse())fn();});
function fixture(family=2,type=1){
    const network=new LanNetwork(),table=new WsaSocketTable(network),system=System.getInstance(),previous=system.process;
    let ram=new Uint8Array(65536),error=0;
    const denied:Array<{base:number;length:number;readOnly:boolean}>=[];
    const valid=(ptr:number,length:number,perms="rw")=>ptr>0&&ptr+length<=ram.length&&!denied.some(region=>ptr<region.base+region.length&&ptr+length>region.base&&(!region.readOnly||perms.includes("w")));
    const owner=Object.create(Process.prototype) as Process;
    Object.assign(owner,{resetGeneration:0,getMemory:()=>ram,addressSpace:{validateRange:valid,write:(ptr:number,data:Uint8Array)=>{if(!valid(ptr,data.length,"rw"))return 0;ram.set(data,ptr);return data.length;}}});
    system.process=owner;Mem.bind(()=>ram);
    const counter=new WsaStartupCount();counter.startup();
    const api=makeSocketExports(table,value=>{error=value;},counter,owner),source=table.socket(type,family),listener=table.socket(type,family);
    const address=family===2?ipv4Address(Uint8Array.of(127,0,0,1),8811):ipv6Address(Uint8Array.from({length:16},(_,i)=>i===15?1:0),8811);
    table.bind(listener,address);if(type===1)table.listen(listener);
    const set=(ptr:number,value:number)=>new DataView(ram.buffer).setUint32(ptr,value,true),get=(ptr:number)=>new DataView(ram.buffer).getUint32(ptr,true);
    new DataView(ram.buffer).setUint16(0x100,family,true);new DataView(ram.buffer).setUint16(0x102,address.port,false);
    ram.set(family===2?Uint8Array.of(127,0,0,1):Uint8Array.from({length:16},(_,i)=>i===15?1:0),family===2?0x104:0x108);
    set(0x200,8);set(0x204,0x1000);ram.fill(85,0x1000,0x1008);
    const call=(name:string,args:number[])=>api[name]({} as never,ram,args);
    const connect=(caller=0,callee=0x200)=>call("WSAConnect",[source,0x100,family===2?16:28,caller,callee,0,0]);
    disposers.push(()=>{table.reset();system.process=previous;});
    return {network,table,system,owner,source,listener,address,call,connect,set,get,error:()=>error,ram:()=>ram,
        deny:(base:number,length:number,readOnly=false)=>denied.push({base,length,readOnly}),setError:(value:number)=>{error=value;},
        grow:()=>{const next=new Uint8Array(ram.length*2);next.set(ram);ram=next;Mem.bind(()=>ram);}};
}
for(const family of [2,23]){
    test("TCP"+family+" copies back an empty connection-data descriptor without sending caller data",()=>{
        const h=fixture(family);h.set(0x300,3);h.set(0x304,0x1100);h.ram().set([97,98,99],0x1100);
        h.setError(0x1234);expect(h.connect(0x300)).toBe(0);expect(h.error()).toBe(0);expect(h.get(0x200)).toBe(0);expect(h.get(0x204)).toBe(0);
        expect([...h.ram().slice(0x1000,0x1008)]).toEqual(Array(8).fill(85));
        const peer=h.table.accept(h.listener);expect(()=>h.table.receive(peer,8)).toThrow("10035");
    });
    test("TCP"+family+" callee write faults happen after connect and preserve partial descriptor writes",()=>{
        const h=fixture(family);h.deny(0x204,4,true);
        expect(h.connect()).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.isConnected(h.source)).toBe(true);
        expect(h.get(0x200)).toBe(0);expect(h.get(0x204)).toBe(0x1000);
    });
    test("TCP"+family+" readonly output length fails after connect but a zero length never writes its descriptor",()=>{
        const h=fixture(family);h.deny(0x200,8,true);
        expect(h.connect()).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.isConnected(h.source)).toBe(true);expect(h.get(0x200)).toBe(8);
        const other=fixture(family);other.set(0x200,0);other.deny(0x200,8,true);
        expect(other.connect()).toBe(0);expect(other.get(0x204)).toBe(0x1000);
    });
    test("TCP"+family+" unreadable descriptors fail before connect after wildcard autobind; payload output need not be accessible",()=>{
        const h=fixture(family);h.deny(0x200,8);
        expect(h.connect()).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.isConnected(h.source)).toBe(false);
        const local=h.table.get(h.source).local;expect(local).not.toBeNull();expect(local?.ip??local?.ip6).toEqual(new Uint8Array(family===2?4:16));
        const other=fixture(family);other.deny(0x1000,8);
        expect(other.connect()).toBe(0);expect(other.get(0x200)).toBe(0);expect(other.get(0x204)).toBe(0);
    });
    test("TCP"+family+" caller data is read-validated while QOS pointers are ignored",()=>{
        const h=fixture(family);h.set(0x300,8);h.set(0x304,0x1000);h.deny(0x1000,8);
        expect(h.connect(0x300,0)).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.get(h.source).local).not.toBeNull();expect(h.table.isConnected(h.source)).toBe(false);
        const other=fixture(family);other.deny(0x500,0x100);
        expect(other.call("WSAConnect",[other.source,0x100,family===2?16:28,0,0,0x500,0x580])).toBe(0);
    });
    test("UDP"+family+" nonempty connection data fails before payload probing and before reading a later callee descriptor",()=>{
        const h=fixture(family,2);h.set(0x300,8);h.set(0x304,0x1000);h.deny(0x1000,8);h.deny(0x200,8);
        expect(h.connect(0x300)).toBe(-1);expect(h.error()).toBe(WSA.EINVAL);expect(h.table.get(h.source).local).not.toBeNull();expect(h.table.isConnected(h.source)).toBe(false);
        const other=fixture(family,2);expect(other.connect()).toBe(-1);expect(other.error()).toBe(WSA.EINVAL);
        const empty=fixture(family,2);empty.set(0x200,0);empty.deny(0x200,8,true);expect(empty.connect()).toBe(0);expect(empty.get(0x204)).toBe(0x1000);
    });
    test("UDP"+family+" shutdown supports unbound sockets without binding and recv validates the unbound endpoint first",()=>{
        const h=fixture(family,2);h.setError(0x1234);expect(h.call("shutdown",[h.source,2])).toBe(0);expect(h.error()).toBe(0);
        expect(h.table.get(h.source).local).toBeNull();expect(h.table.get(h.source).readShutdown).toBe(true);expect(h.table.get(h.source).writeShutdown).toBe(true);
        expect(()=>h.table.receive(h.source,1)).toThrow("10022");expect(()=>h.table.send(h.source,Uint8Array.of(1),h.address)).toThrow("10058");
    });
    test("UDP"+family+" disconnect data errors occur before send shutdown and after receive shutdown",()=>{
        const h=fixture(family,2);h.deny(0x200,8);
        expect(h.call("WSASendDisconnect",[h.source,0x200])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.get(h.source).writeShutdown).toBe(false);
        expect(h.call("WSARecvDisconnect",[h.source,0x200])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);expect(h.table.get(h.source).readShutdown).toBe(true);
        expect(h.table.get(h.source).local).toBeNull();expect(h.table.send(h.source,Uint8Array.of(1),h.address)).toBe(1);
        expect(()=>h.table.receive(h.source,1)).toThrow("10058");
    });
}
for(const family of [2,23])for(const type of [1,2]){
    test("disconnect payload permissions preserve native side effects for family"+family+" type"+type,()=>{
        const outbound=fixture(family,type);outbound.table.connect(outbound.source,outbound.address);outbound.deny(0x1000,8,true);
        const value=outbound.call("WSASendDisconnect",[outbound.source,0x200]);
        expect(value).toBe(type===1?0:-1);expect(outbound.error()).toBe(type===1?0:WSA.EINVAL);
        expect(outbound.table.get(outbound.source).writeShutdown).toBe(type===1);
        const inbound=fixture(family,type);inbound.table.connect(inbound.source,inbound.address);inbound.deny(0x1000,8,true);
        expect(inbound.call("WSARecvDisconnect",[inbound.source,0x200])).toBe(-1);expect(inbound.error()).toBe(WSA.EFAULT);
        expect(inbound.table.get(inbound.source).readShutdown).toBe(true);expect(inbound.get(0x200)).toBe(8);expect(inbound.get(0x204)).toBe(0x1000);
        const empty=fixture(family,type);empty.table.connect(empty.source,empty.address);empty.set(0x200,0);empty.deny(0x1000,8);
        expect(empty.call("WSARecvDisconnect",[empty.source,0x200])).toBe(0);expect(empty.error()).toBe(0);
    });
}
test("a retired provider cannot publish a prepared blocking-connect copyback",async()=>{
    const h=fixture(),send=h.network.send.bind(h.network);h.network.send=(...args)=>{queueMicrotask(()=>send(...args));return true;};
    const result=await h.connect() as ThunkResult;expect(result.resumeOnOwner).toBeFunction();
    h.table.reset();expect(result.resumeOnOwner!({} as never)).toBe(-1);expect(h.error()).toBe(WSA.EINTR);
    expect(h.get(0x200)).toBe(8);expect(h.get(0x204)).toBe(0x1000);
});
test("WSAConnect reports an invalid SOCKET before address and descriptor access",()=>{
    const h=fixture();h.deny(0x200,8);expect(h.call("WSAConnect",[0x7fffffff,0,16,0x200,0x200,0,0])).toBe(-1);expect(h.error()).toBe(WSA.ENOTSOCK);
});
test("a connected TCP state wins over inaccessible connection data and failed connects never validate output writes",()=>{
    const h=fixture();h.table.connect(h.source,h.address);h.deny(0x200,8);
    expect(h.connect()).toBe(-1);expect(h.error()).toBe(WSA.EISCONN);
    const refused=fixture(),send=refused.network.send.bind(refused.network);
    refused.network.send=(local,node,remote,data,proto)=>{
        const frame=decodeTcpFrame(data);
        if(frame?.kind===SYN)return send(remote,node,local,encodeTcpFrame(RST,0,frame.srcId,WSA.ECONNREFUSED),proto);
        return send(local,node,remote,data,proto);
    };
    refused.deny(0x200,8,true);expect(refused.connect()).toBe(-1);expect(refused.error()).toBe(WSA.ECONNREFUSED);expect(refused.get(0x200)).toBe(8);
    expect(refused.table.get(refused.source).local?.ip).toEqual(new Uint8Array(4));
});
for(const family of [2,23])test("a refused TCP"+family+" connection has no queryable peer address",()=>{
    const h=fixture(family),send=h.network.send.bind(h.network);
    h.network.send=(local,node,remote,data,proto)=>{
        const frame=decodeTcpFrame(data);
        if(frame?.kind===SYN)return send(remote,node,local,encodeTcpFrame(RST,0,frame.srcId,WSA.ECONNREFUSED),proto);
        return send(local,node,remote,data,proto);
    };
    expect(h.connect()).toBe(-1);expect(h.error()).toBe(WSA.ECONNREFUSED);
    h.set(0x300,128);h.ram().fill(0xa5,0x400,0x480);
    expect(h.call("getpeername",[h.source,0x400,0x300])).toBe(-1);expect(h.error()).toBe(WSA.ENOTCONN);
    expect(h.get(0x300)).toBe(128);expect([...h.ram().slice(0x400,0x480)]).toEqual(Array(128).fill(0xa5));
});
test("a blocking WSAConnect publishes on its issuing owner after fresh RAM is restored",async()=>{
    const h=fixture(),send=h.network.send.bind(h.network);h.network.send=(...args)=>{queueMicrotask(()=>send(...args));return true;};
    const answer=h.connect();expect(answer).toBeInstanceOf(Promise);
    const foreign=new Uint8Array(h.ram().length);h.system.process={addressSpace:{validateRange:()=>true}} as never;Mem.bind(()=>foreign);
    const result=await answer as ThunkResult;expect(result.resumeOnOwner).toBeFunction();expect(new DataView(foreign.buffer).getUint32(0x200,true)).toBe(0);
    h.system.process=h.owner;h.grow();expect(h.get(0x200)).toBe(8);expect(result.resumeOnOwner!({} as never)).toBe(0);
    expect(h.get(0x200)).toBe(0);expect(h.get(0x204)).toBe(0);expect(h.error()).toBe(0);
});
