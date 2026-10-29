import {expect,test} from "bun:test";
import {DirectPlay4JoinPending} from "../../src/worker/modules/dplayx/native-wire/join-pending";
const system=(cmd:number,id=0)=>{const b=Buffer.alloc(16);b.write("play");b.writeUInt16LE(cmd,4);b.writeUInt16LE(14,6);b.writeUInt32LE(id,12);return b;};

test("expected reply matching includes source fallback and owns payload/header",()=>{
    for(const [wanted,received,match] of [[7,7,true],[7,3,false],[41,3,true],[41,36,true],[3,36,true],[3,41,false]] as const) {
        const q=new DirectPlay4JoinPending(5,100,()=>true), b=system(received), header=Buffer.from([1,2]);
        q.expectReply(wanted);const result=q.receive(b,header,4);
        expect(result.kind).toBe(match?"reply":"not-handled");
        if(result.kind==="reply") { b.fill(0);header.fill(0);expect(result.message.bytes[0]).toBe(112);expect(result.message.header).toEqual(Uint8Array.of(1,2)); }
        if(!match)expect(q.receive(system(wanted),null,0).kind).toBe("reply");
    }
});
// dpmess.h:221-235 stores dwPlayerID at inner +12; pending.c:145-180
// checks commands 8/56 in the player table and 9 in the group table.
test("wrapped player with magic ID cannot consume expected cmd7 and replays as player",()=>{
    const q=new DirectPlay4JoinPending(4,100,()=>true),player=Buffer.alloc(12);
    player.write("play");player.writeUInt32LE(7,4);player.writeUInt32LE(0x1234,8);
    q.expectReply(7);expect(q.receivePlayer(player,null,0).kind).toBe("queued");
    q.receive(system(11,4),null,0);
    expect(q.receive(system(7),null,0).kind).toBe("reply");const seen:string[]=[];
    expect(q.drain(()=>true,msg=>{seen.push(msg.kind+":"+msg.bytes[0]);})).toBe(true);
    expect(seen).toEqual(["player:112","system:112"]);
});
test("FIFO replays new messages added reentrantly and skips duplicate creates",()=>{
    const q=new DirectPlay4JoinPending(10,1000,()=>true), order:number[]=[];
    q.receive(system(8,1),null,0);q.receive(system(9,2),"local",7);q.receive(system(11,3),null,0);
    const result=q.drain((kind,id)=>kind==="player"&&id===1, msg=>{
        const id=new DataView(msg.bytes.buffer,msg.bytes.byteOffset,msg.bytes.byteLength).getUint32(12,true);
        order.push(id);
        if(id===2){expect(msg.header).toBe("local");expect(msg.sendFlags).toBe(7);expect(q.drain(()=>false,()=>{})).toBe(false);q.receive(system(11,4),null,0);}
    });
    expect(result).toBe(true);expect(order).toEqual([2,3,4]);
    expect(()=>q.receive(system(11),null,0)).toThrow();
});
test("queue count and byte bounds include the currently replayed message",()=>{
    const q=new DirectPlay4JoinPending(1,16,()=>true);
    q.receive(system(11),null,0);
    expect(()=>q.drain(()=>false,()=>q.receive(system(11),null,0))).toThrow(RangeError);
    expect(()=>q.receive(system(11),null,0)).toThrow();
    const q2=new DirectPlay4JoinPending(3,20,()=>true);
    expect(()=>q2.receive(system(11),new Uint8Array(5),0)).toThrow(RangeError);
    expect(()=>q2.receive(system(11),null,0)).toThrow();
});
test("reentrant cancel and owner loss stop replay without touching replacement",()=>{
    let alive=true;const q=new DirectPlay4JoinPending(8,200,()=>alive);
    q.receive(system(11,1),null,0);q.receive(system(11,2),null,0);
    const seen:number[]=[];
    expect(q.drain(()=>false,msg=>{seen.push(msg.bytes[12]);alive=false;})).toBe(false);
    expect(seen).toEqual([1]);expect(()=>q.receive(system(11),null,0)).toThrow();
    const other=new DirectPlay4JoinPending(2,100,()=>true);other.receive(system(11,3),null,0);
    expect(other.drain(()=>false,msg=>seen.push(msg.bytes[12]))).toBe(true);expect(seen).toEqual([1,3]);
});
test("unsupported exempt packet and authentication messages never silently queue",()=>{
    const q=new DirectPlay4JoinPending(2,64,()=>true);
    for(const cmd of [21,28,29,30,31,44,48,49])expect(q.receive(system(cmd),null,0).kind).toBe("unsupported");
    expect(q.drain(()=>false,()=>{throw Error("should not replay");})).toBe(true);
});
test("malformed create fails closed and ownership callback cannot reenter drain",()=>{
    let nested=false,armed=false;let q!:DirectPlay4JoinPending;
    q=new DirectPlay4JoinPending(4,100,()=>{
        if(armed&&!nested){nested=true;expect(q.drain(()=>false,()=>{})).toBe(false);}
        return true;
    });
    const short=system(8).subarray(0,8);q.receive(short,null,0);armed=true;
    expect(()=>q.drain(()=>false,()=>{})).toThrow(RangeError);
    expect(()=>q.receive(system(11),null,0)).toThrow();
});
