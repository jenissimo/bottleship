import {expect,test} from "bun:test";
import {TcpHostCapacity} from "../../packages/lan/src/tcp-host-owner";
import {TcpAcceptQuota} from "../../packages/lan/src/tcp-accept-quota";

test("idle listeners hold no permit; queued demand cannot pass a live outbound socket",()=>{
    const capacity=new TcpHostCapacity(1),arbiter=new TcpAcceptQuota(capacity);
    const outbound=capacity.acquire()!,owner={},granted:bigint[]=[];
    expect(arbiter.demand({owner,epoch:1,grant:token=>{granted.push(token);return true;},fatal:()=>{throw Error("unexpected");}})).not.toBeNull();
    expect(capacity.active).toBe(1);expect(arbiter.pendingCount).toBe(1);expect(granted).toEqual([]);
    outbound();
    expect(granted).toEqual([1n]);expect(capacity.active).toBe(1);
    expect(arbiter.complete({},1,1n)).toBe(false);
    expect(arbiter.complete(owner,2,1n)).toBe(false);
    expect(capacity.active).toBe(1);
    expect(arbiter.complete(owner,1,1n)).toBe(true);
    expect(arbiter.complete(owner,1,1n)).toBe(false);
    expect(capacity.active).toBe(0);
});
test("external release wakes multiple subscribers once and unsubscribe is safe",()=>{
    const capacity=new TcpHostCapacity(1),first=new TcpAcceptQuota(capacity),second=new TcpAcceptQuota(capacity);
    const busy=capacity.acquire()!, owner1={},owner2={},grants:bigint[]=[];
    const detach=capacity.onRelease(()=>{throw Error("observer failure");});
    first.demand({owner:owner1,epoch:1,grant:t=>{grants.push(t);return true;},fatal:()=>{}});
    second.demand({owner:owner2,epoch:2,grant:t=>{grants.push(t);return true;},fatal:()=>{}});
    expect(()=>first.dispose()).toThrow();
    busy();busy();
    expect(grants).toEqual([1n]);expect(capacity.active).toBe(1);
    expect(first.complete(owner1,1,1n)).toBe(true);
    expect(grants).toEqual([1n,1n]);expect(capacity.active).toBe(1);
    first.dispose();first.dispose();detach();
    expect(()=>first.demand({owner:owner1,epoch:1,grant:()=>true,fatal:()=>{}})).toThrow();
    expect(second.complete(owner2,2,1n)).toBe(true);
    second.dispose();expect(capacity.active).toBe(0);
});
test("cancel queued offer does not retire a granted token; exact process exit does",()=>{
    const capacity=new TcpHostCapacity(1),arbiter=new TcpAcceptQuota(capacity),owner={},next={};
    let token=0n,second=0n;
    const cancel=arbiter.demand({owner,epoch:7,grant:t=>{token=t;return true;},fatal:()=>{}})!;
    arbiter.demand({owner:next,epoch:1,grant:t=>{second=t;return true;},fatal:()=>{}});
    cancel();arbiter.cancelOwner(owner,7);
    expect(capacity.active).toBe(1);expect(second).toBe(0n);
    arbiter.processClosed(owner,8);expect(capacity.active).toBe(1);
    arbiter.processClosed(owner,7);
    expect(second).toBeGreaterThan(0n);expect(capacity.active).toBe(1);
    expect(arbiter.complete(owner,7,token)).toBe(false);
    expect(arbiter.complete(next,1,second)).toBe(true);expect(capacity.active).toBe(0);
});
test("rejected admission returns permit; unknown IPC result holds it until process exit",()=>{
    const capacity=new TcpHostCapacity(1),arbiter=new TcpAcceptQuota(capacity),owner={};
    let fatal=0,unknown=0n;
    arbiter.demand({owner,epoch:1,grant:()=>false,fatal:()=>{fatal++;}});
    expect(capacity.active).toBe(0);expect(arbiter.activeCount).toBe(0);
    arbiter.demand({owner,epoch:1,grant:t=>{unknown=t;throw Error("write outcome unknown");},fatal:()=>{fatal++;}});
    expect(fatal).toBe(1);expect(unknown).toBeGreaterThan(0n);expect(capacity.active).toBe(1);
    arbiter.cancelOwner(owner,1);expect(capacity.active).toBe(1);
    arbiter.processClosed(owner,1);expect(capacity.active).toBe(0);
});
test("demand queue is bounded, deduplicates owner epoch and never allocates idle tokens",()=>{
    const capacity=new TcpHostCapacity(1),arbiter=new TcpAcceptQuota(capacity,1),busy=capacity.acquire()!,owner={},other={};
    const cancel=arbiter.demand({owner,epoch:1,grant:()=>true,fatal:()=>{}})!;
    expect(arbiter.demand({owner,epoch:1,grant:()=>true,fatal:()=>{}})).toBeNull();
    expect(arbiter.demand({owner:other,epoch:1,grant:()=>true,fatal:()=>{}})).toBeNull();
    cancel();busy();arbiter.wake();
    expect(arbiter.pendingCount).toBe(0);expect(arbiter.activeCount).toBe(0);expect(capacity.active).toBe(0);
});
