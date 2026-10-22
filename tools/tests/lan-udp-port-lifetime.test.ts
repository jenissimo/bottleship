import {expect,test} from "bun:test";
import {EventEmitter} from "node:events";
import type {Socket} from "node:dgram";
import {NativeUdpPortPool,type NativeUdpChannel} from "../../packages/lan/src/native-udp-port";

// The OS may finish a bind after close was requested. Keep that scheduling
// under test control, while the integration fixture uses actual kernel ports.
class PendingSocket extends EventEmitter {
    closeCalls=0;
    nativeOpen=false;
    private closeRequested=false;
    readonly sent:Array<{port:number;host:string;bytes:number[]}>=[];
    bind():void {}
    finishBind():void {
        this.nativeOpen=true;this.emit("listening");
        if(this.closeRequested)this.nativeOpen=false;
    }
    close():void {this.closeCalls++;this.closeRequested=true;this.nativeOpen=false;}
    send(bytes:Uint8Array,port:number,host:string,callback:(error?:Error|null)=>void):void {
        this.sent.push({port,host,bytes:[...bytes]});callback();
    }
}
function setup(historyLimit=128){
    const sockets:PendingSocket[]=[];
    const pool=new NativeUdpPortPool(()=>{const socket=new PendingSocket();sockets.push(socket);return socket as unknown as Socket;},historyLimit);
    return {pool,sockets};
}
function connect(channel:NativeUdpChannel,port:number,host:string,callback:()=>void):void{
    channel.on("error",error=>{throw error;});channel.connect(port,host,callback);
}
test("closing a UDP binding before native bind completes cannot revive it or close its replacement",()=>{
    const {pool,sockets}=setup();let oldReady=0,newReady=0;
    const old=pool.open("udp:47000:1",4,"127.0.0.1",2345);
    connect(old,2345,"127.0.0.1",()=>oldReady++);old.close();
    expect(sockets[0].closeCalls).toBe(1);
    // Reusing even the same pool key must create a separate native owner.
    const fresh=pool.open("udp:47000:1",4,"127.0.0.1",2345);
    connect(fresh,2345,"127.0.0.1",()=>newReady++);
    sockets[0].finishBind();sockets[0].emit("error",Error("late old bind failure"));
    expect(oldReady).toBe(0);expect(newReady).toBe(0);expect(sockets[0].nativeOpen).toBe(false);
    sockets[1].finishBind();expect(newReady).toBe(1);expect(sockets[1].nativeOpen).toBe(true);
    const received:number[]=[];fresh.on("message",bytes=>received.push(bytes[0]));
    sockets[1].emit("message",Buffer.of(9),{address:"127.0.0.1",port:2346});
    sockets[1].emit("message",Buffer.of(8),{address:"127.0.0.2",port:2345});
    sockets[1].emit("message",Buffer.of(7),{address:"127.0.0.1",port:2345});
    expect(received).toEqual([7]);
    fresh.close();expect(sockets[1].closeCalls).toBe(1);expect(sockets[1].nativeOpen).toBe(false);
});
test("one pending UDP channel close preserves another peer on the shared native port",()=>{
    const {pool,sockets}=setup();let firstReady=0,secondReady=0;
    const first=pool.open("udp:47001:2",6,"::1",2345),second=pool.open("udp:47001:2",6,"::1",2346);
    connect(first,2345,"::1",()=>firstReady++);connect(second,2346,"::1",()=>secondReady++);
    expect(sockets.length).toBe(1);first.close();expect(sockets[0].closeCalls).toBe(0);
    sockets[0].finishBind();expect(firstReady).toBe(0);expect(secondReady).toBe(1);
    let sends=0;second.send(Buffer.of(4),error=>{expect(error).toBeUndefined();sends++;});
    expect(sends).toBe(1);expect(sockets[0].sent).toEqual([{port:2346,host:"::1",bytes:[4]}]);
    second.close();expect(sockets[0].closeCalls).toBe(1);
});
test("a failed native UDP bind retires its channels before a replacement owner is admitted",()=>{
    const {pool,sockets}=setup(),errors:Error[]=[];
    const peers=[pool.open("udp:47002:3",4,"127.0.0.1",2345),pool.open("udp:47002:3",4,"127.0.0.1",2346)];
    for(const peer of peers){peer.on("error",error=>{errors.push(error);peer.close();});peer.connect(peer.port,peer.host,()=>{throw Error("Failed bind reported ready");});}
    const failure=Object.assign(Error("native bind failed"),{code:"EADDRINUSE"});
    sockets[0].emit("error",failure);expect(errors).toEqual([failure,failure]);expect(sockets[0].closeCalls).toBe(1);
    const fresh=pool.open("udp:47002:3",4,"127.0.0.1",2345);let ready=0;
    connect(fresh,2345,"127.0.0.1",()=>ready++);sockets[1].finishBind();expect(ready).toBe(1);fresh.close();
});

for(const family of [4,6] as const)test("native unspecified UDP target accepts its normalized loopback reply, IPv"+family,()=>{
    // Actual Windows and Linux UDP sendto observations are retained in
    // logs/lan-conformance/udp-normalize-{windows,posix}-40.json.
    const {pool,sockets}=setup(),host=family===4?"0.0.0.0":"::",source=family===4?"127.0.0.1":"::1";
    const channel=pool.open("udp:47003:4",family,host,2345);let ready=0;
    connect(channel,2345,host,()=>ready++);sockets[0].finishBind();expect(ready).toBe(1);
    const received:number[]=[];channel.on("message",bytes=>received.push(bytes[0]));
    sockets[0].emit("message",Buffer.of(9),{address:source,port:2345});
    expect(received).toEqual([9]);channel.close();
});
test("unspecified and explicit loopback routes to the same UDP peer retain separate virtual identities",()=>{
    const {pool,sockets}=setup();
    const unspecified=pool.open("udp:47004:5",4,"0.0.0.0",2345),loopback=pool.open("udp:47004:5",4,"127.0.0.1",2345);
    expect(sockets.length).toBe(2);unspecified.close();loopback.close();
});
test("a delayed native reply for a retired virtual alias cannot enter a replacement alias",()=>{
    const {pool,sockets}=setup();
    const anchor=pool.open("udp:47005:6",4,"127.0.0.1",2346,"anchor");
    const old=pool.open("udp:47005:6",4,"127.0.0.1",2345,"old-alias");
    connect(anchor,2346,"127.0.0.1",()=>{});connect(old,2345,"127.0.0.1",()=>{});
    sockets[0].finishBind();old.close();
    const fresh=pool.open("udp:47005:6",4,"127.0.0.1",2345,"new-alias"),received:number[]=[];
    connect(fresh,2345,"127.0.0.1",()=>{});fresh.on("message",bytes=>received.push(bytes[0]));
    sockets[0].emit("message",Buffer.of(0xaa),{address:"127.0.0.1",port:2345});
    expect(received).toEqual([]);
    expect(sockets.length).toBe(2);sockets[1].finishBind();
    sockets[1].emit("message",Buffer.of(0xbb),{address:"127.0.0.1",port:2345});
    expect(received).toEqual([0xbb]);fresh.close();anchor.close();
});
test("native UDP peer history is bounded while known identities can reuse their existing port",()=>{
    const {pool,sockets}=setup(2);
    const anchor=pool.open("udp:47006:7",4,"127.0.0.1",2345,"anchor");
    const peer=pool.open("udp:47006:7",4,"127.0.0.1",2346,"peer");
    peer.close();
    const newPeer=pool.open("udp:47006:7",4,"127.0.0.1",2347,"third-peer");
    expect(sockets.length).toBe(2);
    const samePeer=pool.open("udp:47006:7",4,"127.0.0.1",2346,"peer");
    expect(sockets.length).toBe(2);samePeer.close();newPeer.close();anchor.close();
});
