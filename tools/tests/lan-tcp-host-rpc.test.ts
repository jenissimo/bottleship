import {expect,test} from "bun:test";
import {copyTcpHostCapability,copyTcpHostReady,validTcpHostOpenRequest} from "../../packages/lan/src/tcp-host-protocol";
import {TcpHostLeaseRpc} from "../../src/worker/net/tcp-host-lease-rpc";

const request={proto:2 as const,localPort:2302,bindingGeneration:3,listenerId:"game"};
const ready=(leaseId:number)=>({leaseId,address:{node:[2,1,127,0,0,1],port:47624},allowedNodes:[[2,1,127,0,0,1]]});
function fixture() {
    const sent:Array<{kind:string;id:number;request?:unknown}>=[];
    let connected=true,admit=true;
    const rpc=new TcpHostLeaseRpc({
        connected:()=>connected,
        request:(id,value)=>{if(!admit)return false;sent.push({kind:"open",id,request:value});return true;},
        cancel:id=>{sent.push({kind:"cancel",id});},
        release:id=>{sent.push({kind:"release",id});},
    });
    return {rpc,sent,disconnect:()=>{connected=false;rpc.disconnect();},deny:()=>{admit=false;}};
}
test("TCP listener request and advertised endpoint/ACL are strict immutable copies",()=>{
    expect(validTcpHostOpenRequest(request)).toBe(true);
    for(const bad of [
        {...request,proto:1},{...request,localPort:0},{...request,bindingGeneration:0},
        {...request,bindingGeneration:0x100000000},{...request,listenerId:"bad/id"},
    ]) expect(validTcpHostOpenRequest(bad)).toBe(false);
    const input=ready(9),copy=copyTcpHostReady(input);
    input.address.node[2]=1;input.allowedNodes[0][2]=1;
    expect(copy.address.node).toEqual([2,1,127,0,0,1]);
    expect(copy.allowedNodes).toEqual([[2,1,127,0,0,1]]);
    expect(()=>copyTcpHostReady({...ready(1),allowedNodes:[[2,1,127,0,0,1],[2,1,127,0,0,1]]})).toThrow();
    expect(()=>copyTcpHostReady({...ready(1),address:{node:[2,1,224,0,0,1],port:1}})).toThrow();
    expect(()=>copyTcpHostCapability({listeners:[
        {id:"game",allowedNodes:[[2,1,127,0,0,1]]},{id:"game",allowedNodes:[[2,1,127,0,0,1]]}
    ]})).toThrow();
});
test("cancel is ordered after request; late READY cannot steal a newer owner's lease",async()=>{
    const f=fixture(),abort=new AbortController();
    const first=f.rpc.open(request,abort.signal);
    abort.abort();
    await expect(first).rejects.toMatchObject({code:995});
    expect(f.sent.map(x=>[x.kind,x.id])).toEqual([["open",1],["cancel",1]]);
    const second=f.rpc.open({...request,bindingGeneration:4});
    f.rpc.accept(2,ready(5));const lease=await second;
    f.rpc.accept(1,ready(5));
    f.rpc.acceptClosed(1,5,{code:10054,message:"old owner"});
    expect(lease.isLive()).toBe(true);
    expect(f.sent.filter(x=>x.kind==="release")).toHaveLength(0);
    lease.release();await lease.closed;
    expect(f.sent.filter(x=>x.kind==="release").map(x=>x.id)).toEqual([5]);
    lease.release();expect(f.sent.filter(x=>x.kind==="release")).toHaveLength(1);
});
test("failure and capacity preserve the cleanup slot and exact lease ownership",async()=>{
    const f=fixture();
    f.deny();
    await expect(f.rpc.open(request)).rejects.toMatchObject({code:10055});
    expect(f.rpc.controlReservations).toBe(0);
    expect(f.sent).toEqual([]);
    const g=fixture(),pending=Array.from({length:16},()=>g.rpc.open(request));
    expect(g.rpc.controlReservations).toBe(16);
    await expect(g.rpc.open(request)).rejects.toMatchObject({code:10055});
    const settled=Promise.allSettled(pending);
    g.rpc.retire(2302,2,3);
    await settled;
    expect(g.rpc.controlReservations).toBe(0);
    expect(g.sent.filter(x=>x.kind==="cancel")).toHaveLength(16);
});
test("malformed acknowledgement cancels; closed event must match request and lease",async()=>{
    const f=fixture(),bad=f.rpc.open(request);
    f.rpc.accept(1,{...ready(7),error:{code:10013,message:"bad"}});
    await expect(bad).rejects.toMatchObject({code:10022});
    expect(f.sent.at(-1)).toEqual({kind:"cancel",id:1});
    const pending=f.rpc.open(request);
    f.rpc.accept(2,ready(8));const lease=await pending;
    f.rpc.acceptClosed(1,8,{code:10054,message:"wrong request"});
    f.rpc.acceptClosed(2,9,{code:10054,message:"wrong lease"});
    f.rpc.acceptClosed(2,8,{code:1,message:"invalid error"});
    expect(lease.isLive()).toBe(true);
    f.rpc.acceptClosed(2,8,{code:10054,message:"listener failure"});
    expect(await lease.closed).toEqual({code:10054,message:"listener failure"});
    expect(lease.isLive()).toBe(false);
    expect(f.sent.filter(x=>x.kind==="release")).toHaveLength(0);
});
test("disconnect ends active and pending without emitting obsolete controls",async()=>{
    const f=fixture(),pending=f.rpc.open(request);
    f.rpc.accept(1,ready(11));const lease=await pending;
    const next=f.rpc.open({...request,bindingGeneration:4});
    const settled=next.catch(error=>error);f.disconnect();
    expect((await settled).code).toBe(10050);
    expect((await lease.closed).code).toBe(10050);
    expect(f.sent.map(x=>x.kind)).toEqual(["open","open"]);
});
