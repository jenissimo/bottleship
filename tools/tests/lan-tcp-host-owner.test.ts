import {expect,test} from "bun:test";
import {createConnection, type Socket} from "node:net";
import {once} from "node:events";
import {TcpHostCapacity,TcpHostOwner,TcpHostRegistry,validateTcpHostConfig} from "../../packages/lan/src/tcp-host-owner";
import {NativeDestinationPolicy} from "../../packages/lan/src/native-policy";
import {decodeDatagram,encodeDatagram} from "../../packages/lan/src/protocol";
import {CREDIT,DATA,FIN,RST,SYN,SYNACK,TCP_WINDOW,decodeTcpFrame,encodeTcpFrame} from "../../packages/lan/src/tcp-protocol";

const config={id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:2};
const binding={localPort:2302,generation:1};
async function bounded<T>(p:Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("deadline")),4000);})]);}
    finally {clearTimeout(timer);}
}
function outputs() {
    const queue:Array<{frame:Uint8Array;generation:number}>=[],waiters:Array<(item:{frame:Uint8Array;generation:number})=>void>=[];
    return {
        emit:(frame:Uint8Array,generation:number)=>{const item={frame,generation};const next=waiters.shift();if(next)next(item);else queue.push(item);return true;},
        next:()=>bounded(new Promise<{frame:Uint8Array;generation:number}>(resolve=>{const item=queue.shift();if(item)resolve(item);else waiters.push(resolve);})),
    };
}
function input(remotePort:number,nativeId:number,guestId:number,kind:number,data=new Uint8Array(),value=0) {
    const encoded=encodeDatagram(2,Uint8Array.of(2,1,127,0,0,1),remotePort,2302,encodeTcpFrame(kind,guestId,nativeId,value,data));
    return {...decodeDatagram(encoded)!,bindingGeneration:1};
}
async function connect(port:number):Promise<Socket> {
    const socket=createConnection({host:"127.0.0.1",port,allowHalfOpen:true});
    await bounded(once(socket,"connect"));return socket;
}
test("TCP listener policy requires numeric unicast and nonempty unique ACL",()=>{
    expect(validateTcpHostConfig(config).maxOwners).toBe(1);
    for(const bad of [
        {...config,bindHost:"localhost"},{...config,advertisedHost:"0.0.0.0"},
        {...config,allowedHosts:[]},{...config,allowedHosts:["127.0.0.1","127.0.0.1"]},
        {...config,allowedHosts:["224.0.0.1"]},{...config,maxPending:0},
    ]) expect(()=>validateTcpHostConfig(bad)).toThrow();
});
test("accepted native child exchanges bytes and survives listener release until both FINs",async()=>{
    const capacity=new TcpHostCapacity(4),registry=new TcpHostRegistry(new NativeDestinationPolicy(),capacity),out=outputs();
    const owner=new TcpHostOwner(registry,out.emit);
    let peer:Socket|undefined;
    try {
        const opened=await owner.open(config,binding);
        peer=await connect(opened.address.port);
        const syn=await out.next(),d=decodeDatagram(syn.frame)!,f=decodeTcpFrame(d.payload)!;
        expect(syn.generation).toBe(1);expect(f.kind).toBe(SYN);expect(f.dstId).toBe(0);
        expect(d.node).toEqual(Uint8Array.of(2,1,127,0,0,1));
        expect(capacity.active).toBe(1);
        expect(owner.handle(input(d.srcPort,f.srcId,77,SYNACK,new Uint8Array(),TCP_WINDOW))).toBe(true);
        const closing=owner.closeListener(); // no await: established socket owns its own lifetime
        expect(owner.handle(input(d.srcPort,f.srcId,77,DATA,Uint8Array.of(1,2,3)))).toBe(true);
        const [bytes]=await bounded(once(peer,"data"));expect([...bytes]).toEqual([1,2,3]);
        let credit=await out.next();expect(decodeTcpFrame(decodeDatagram(credit.frame)!.payload)!.kind).toBe(CREDIT);
        peer.write(Uint8Array.of(4,5));
        const incoming=await out.next(),data=decodeTcpFrame(decodeDatagram(incoming.frame)!.payload)!;
        expect(data.kind).toBe(DATA);expect([...data.data]).toEqual([4,5]);
        expect(owner.handle(input(d.srcPort,f.srcId,77,CREDIT,new Uint8Array(),2))).toBe(true);
        owner.handle(input(d.srcPort,f.srcId,77,FIN));
        await bounded(once(peer,"end"));peer.end();
        const fin=decodeTcpFrame(decodeDatagram((await out.next()).frame)!.payload)!;
        expect(fin.kind).toBe(FIN);
        await bounded(closing);
        expect(capacity.active).toBe(0);
    } finally {owner.close();peer?.destroy();}
},12000);
test("pending offer is retired by close and shared owner/quota survives until socket closes",async()=>{
    const capacity=new TcpHostCapacity(2),registry=new TcpHostRegistry(new NativeDestinationPolicy(),capacity),out=outputs();
    const first=new TcpHostOwner(registry,out.emit),second=new TcpHostOwner(registry,()=>true);
    let peer:Socket|undefined;
    try {
        const opened=await first.open(config,binding);
        await expect(second.open(config,{localPort:2303,generation:1})).rejects.toMatchObject({code:10048});
        peer=await connect(opened.address.port);
        const syn=decodeTcpFrame(decodeDatagram((await out.next()).frame)!.payload)!;
        const closed=first.closeListener();
        const reset=decodeTcpFrame(decodeDatagram((await out.next()).frame)!.payload)!;
        expect([reset.kind,reset.srcId,reset.dstId]).toEqual([RST,syn.srcId,0]);
        await bounded(closed);
        expect(capacity.active).toBe(0);
        const other=await second.open(config,{localPort:2303,generation:1});
        expect(other.address.port).toBeGreaterThan(0);
        await bounded(second.closeListener());
    } finally {first.close();second.close();peer?.destroy();}
},12000);

test("shared source policy and capacity are held and released exactly once",async()=>{
    const policy=new NativeDestinationPolicy(),capacity=new TcpHostCapacity(1),registry=new TcpHostRegistry(policy,capacity);
    const exclusive=policy.acquire("127.0.0.1",{},true)!;
    const owner=new TcpHostOwner(registry,()=>true);
    try {
        await expect(owner.open({...config,maxPending:1},binding)).rejects.toMatchObject({code:10048});
        exclusive();
        const reserved=capacity.acquire()!;
        expect(capacity.acquire()).toBeNull();
        reserved();reserved();expect(capacity.active).toBe(0);
        const opened=await owner.open({...config,maxPending:1},binding);
        expect(opened.address.port).toBeGreaterThan(0);
        expect(policy.acquire("127.0.0.1",{},true)).toBeNull();
        await bounded(owner.closeListener());
        const after=policy.acquire("127.0.0.1",{},true);
        expect(after).not.toBeNull();after!();
    } finally {exclusive();owner.close();}
},10000);
