import {expect,test} from "bun:test";
import {DirectPlay4JoinChannel,type DirectPlay4JoinChannelOptions} from "../../src/worker/modules/dplayx/native-wire/join-channel";
import {encodeDirectPlay4PlayerTcpFrame} from "../../src/worker/modules/dplayx/native-wire/player-tcp";
import {WsaFailure,WsaOwnedSocketOutcomeUnknown,WSA,type WsaSocketTable} from "../../src/worker/modules/wsa-network";

const frame=Uint8Array.from(Buffer.from("2000b0fa020008fcc00002010000000000000000706c617907000e0001000000","hex"));
const peer={family:2,node:Uint8Array.of(2,1,127,0,0,1),ip:Uint8Array.of(127,0,0,1),port:1234};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
class Table {
    generation=1;next=10;connected=false;writes:number[]=[];sockets=new Map<number,number>();queue:number[]=[];
    packets=new Map<number,Uint8Array[]>();handlers=new Set<()=>void>();
    signal(){for(const cb of this.handlers)cb();}
    subscribe(cb:()=>void){this.handlers.add(cb);return ()=>this.handlers.delete(cb);}
    socket(){const id=this.next++;this.sockets.set(id,id+100);return id;}
    socketOwned(){const id=this.socket();return {handle:id,object:this.fileObjectId(id)};}
    acceptOwned(listener:number){const id=this.accept(listener);return {handle:id,object:this.fileObjectId(id)};}
    fileObjectId(id:number){const n=this.sockets.get(id);if(!n)throw new Error("no socket");return n;}
    isValid(id:number){return this.sockets.has(id);}
    closesocket(id:number){this.sockets.delete(id);this.signal();}
    connect(){throw new WsaFailure(WSA.EWOULDBLOCK);}
    isConnected(){return this.connected;}
    get(){return {state:"connecting"};}
    send(_id:number,bytes:Uint8Array){const n=Math.min(5,bytes.length);this.writes.push(...bytes.subarray(0,n));return n;}
    accept(_listener?:number){const id=this.queue.shift();if(!id)throw new WsaFailure(WSA.EWOULDBLOCK);return id;}
    receive(id:number){const data=this.packets.get(id)?.shift();if(!data)throw new WsaFailure(WSA.EWOULDBLOCK);return {data,from:peer};}
    child(chunks:Uint8Array[]){const id=this.socket();this.packets.set(id,chunks);this.queue.push(id);this.signal();return id;}
}
function options(frames:number[],errors:string[]):DirectPlay4JoinChannelOptions {
    return {destination:{...peer},signal:new AbortController().signal,listener:{socket:1,ownerToken:1,address:{node:[...peer.node],port:2300},current:()=>true,release(){}},
        current:()=>true,authorizeDestination:()=>true,authorizePeer:()=>true,
        onFrame:f=>frames.push(f.command),onFailure:e=>errors.push(e.message),onOwnershipUncertain:e=>errors.push("uncertain:"+e.message),
        timeoutMs:1000,maxFrameBytes:128,maxChildren:2,maxWriteBytes:256};
}
test("partial writes and fragmented reply preserve wire order and ownership",async()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors);
    const channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
    const sent=channel.send(frame);
    table.connected=true;table.child([frame.subarray(0,7),frame.subarray(7)]);table.signal();
    await sent;await tick();
    expect(table.writes).toEqual([...frame]);expect(frames).toEqual([7]);expect(errors).toEqual([]);
    channel.close();expect(table.sockets.size).toBe(0);
});
test("source ACL denial fails closed and retires every owned socket",async()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors);
    o.authorizePeer=()=>false;
    const channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
    table.child([frame]);await tick();
    expect(frames).toEqual([]);expect(errors).toHaveLength(1);
    expect(table.sockets.size).toBe(0);channel.close();
});
test("invalid destination and write limits reject without false success",async()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],denied=options(frames,errors);
    denied.authorizeDestination=()=>false;
    expect(()=>new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,denied)).toThrow();
    expect(table.sockets.size).toBe(0);
    const o=options(frames,errors),channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
    const wrong=frame.slice();wrong[0]=0;
    await expect(channel.send(wrong)).rejects.toThrow();
    const held=channel.send(frame);
    channel.close();await expect(held).rejects.toThrow();
});
test("listener reentry aborts attempt before current can return stale true",async()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors), controller=new AbortController();
    o.signal=controller.signal;let armed=false;
    o.listener={...o.listener,current:()=>{if(armed)controller.abort();return true;}};
    const channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
    armed=true;
    await expect(channel.send(frame)).rejects.toThrow();
    expect(errors).toEqual(["Join attempt cancelled"]);
    expect(table.sockets.size).toBe(0);
});
test("reentrant abort inside socketOwned closes the newly returned exact socket",()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors),controller=new AbortController();
    o.signal=controller.signal;
    const create=table.socketOwned.bind(table);
    table.socketOwned=()=>{const result=create();controller.abort();return result;};
    expect(()=>new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o)).toThrow();
    expect(table.sockets.size).toBe(0);
    expect(errors).toEqual(["Join attempt cancelled"]);
});
test("unknown owned allocation requires actor retirement and never guesses a handle",()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors);
    table.socketOwned=()=>{throw new WsaOwnedSocketOutcomeUnknown(WSA.ETIMEDOUT);};
    expect(()=>new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o)).toThrow();
    expect(errors).toEqual(["uncertain:Winsock error 10060"]);
    expect(table.sockets.size).toBe(0);
});
test("reentrant pump cannot deliver a newer frame ahead of an already decoded batch",async()=>{
 const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors),order:string[]=[];
 const raw=encodeDirectPlay4PlayerTcpFrame(new Uint8Array(16),1,2,Uint8Array.of(9),128);
 let channel!:DirectPlay4JoinChannel;
 o.onFrame=()=>{order.push("B");};
 o.onPlayerFrame=()=>{order.push(order.length?"C":"A");if(order.length===1){table.child([raw]);(channel as any).pump();}};
 channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
 table.child([Uint8Array.from([...raw,...frame])]);await tick();await tick();
 expect(order).toEqual(["A","B","C"]);expect(errors).toEqual([]);channel.close();expect(table.sockets.size).toBe(0);
});
test("mixed player callback abort fences later system frames and exact resources",async()=>{
 const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors),controller=new AbortController();o.signal=controller.signal;
 const raw=encodeDirectPlay4PlayerTcpFrame(new Uint8Array(16),1,2,Uint8Array.of(9),128);let received=0;
 o.onPlayerFrame=f=>{received++;expect(f.data).toEqual(Uint8Array.of(9));controller.abort();};
 const channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
 table.child([Uint8Array.from([...raw,...frame])]);await tick();
 expect(received).toBe(1);expect(frames).toEqual([]);expect(errors).toEqual(["Join attempt cancelled"]);expect(table.sockets.size).toBe(0);channel.close();
});
test("closing from frame callback cannot deliver later frames or touch replacement",async()=>{
    const table=new Table(),frames:number[]=[],errors:string[]=[],o=options(frames,errors);
    let channel!:DirectPlay4JoinChannel;
    o.onFrame=f=>{frames.push(f.command);channel.close();};
    channel=new DirectPlay4JoinChannel(table as unknown as WsaSocketTable,o);
    table.child([Uint8Array.from([...frame,...frame])]);await tick();
    expect(frames).toEqual([7]);expect(errors).toEqual([]);
    const replacement=table.socket();channel.close();expect(table.isValid(replacement)).toBe(true);
});
