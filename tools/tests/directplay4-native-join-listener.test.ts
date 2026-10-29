import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable} from "../../src/worker/modules/wsa-network";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";

function fixture() {
    const network=new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
    let ready!:(value:any)=>void, stopped=false, releases=0;
    let close!:(value:{code:number;message:string})=>void;
    const closed=new Promise<{code:number;message:string}>(resolve=>{close=resolve;});
    const node=[2,1,127,0,0,1];
    const physical={address:{node,port:2300},allowedNodes:[node],isLive:()=>!stopped,closed,
        release(){if(!stopped){stopped=true;releases++;close({code:10054,message:"closed"});}}};
    network.attach({connected:true,send:()=>true,close(){},openTcpHost:()=>new Promise(resolve=>{ready=resolve;})});
    network.configureTcpHosts({listeners:[{id:"join",allowedNodes:[node]}]});
    network.configureWinsock({provider:"native",hostListener:"join"});
    const table=new WsaSocketTable(network);
    return {network,table,ready:()=>ready(physical),releases:()=>releases,revoke:()=>physical.release()};
}

test("READY is required and release owns exactly the TCP listener",async()=>{
    const f=fixture();
    try {
        let settled=false;
        const pending=acquireDirectPlay4JoinListener(f.table,1000).then(v=>{settled=true;return v;});
        await Promise.resolve();expect(settled).toBe(false);
        f.ready();const owner=await pending;
        expect(owner.current()).toBe(true);
        expect(owner.address).toEqual({node:[2,1,127,0,0,1],port:2300});
        expect(Object.isFrozen(owner.address.node)).toBe(true);
        owner.release();owner.release();
        expect(owner.current()).toBe(false);expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("reentrant abort inside final READY liveness rejects instead of hanging",async()=>{
    const f=fixture(), controller=new AbortController();
    try {
        const original=f.table.nativeListenerCurrent.bind(f.table);
        let checks=0;
        f.table.nativeListenerCurrent=(sid,token)=>{
            checks++;
            if(checks===2)controller.abort();
            return original(sid,token);
        };
        const pending=acquireDirectPlay4JoinListener(f.table,1000,controller.signal);
        f.ready();
        const outcome=await Promise.race([
            pending.then(()=>"resolved",()=>"rejected"),
            new Promise<string>(resolve=>setTimeout(()=>resolve("hung"),100)),
        ]);
        expect(checks).toBeGreaterThanOrEqual(2);
        expect(outcome).toBe("rejected");
        expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("abort before READY closes exact socket and retires a late physical lease",async()=>{
    const f=fixture(), controller=new AbortController();
    try {
        const pending=acquireDirectPlay4JoinListener(f.table,1000,controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
        f.ready();await Promise.resolve();await Promise.resolve();
        expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("policy absence rejects without opening or virtual fallback",async()=>{
    const f=fixture();
    try {
        f.network.configureWinsock(undefined);
        await expect(acquireDirectPlay4JoinListener(f.table,1000)).rejects.toThrow();
        expect(f.releases()).toBe(0);
    } finally {f.table.reset();}
});
test("lease revocation and replacement socket cannot be touched by old release",async()=>{
    const f=fixture();
    try {
        const pending=acquireDirectPlay4JoinListener(f.table,1000);f.ready();const old=await pending;
        f.table.closesocket(old.socket);
        const replacement=f.table.socket(1,2,6);
        old.release();
        expect(f.table.isValid(replacement)).toBe(true);
        expect(old.current()).toBe(false);expect(f.releases()).toBe(1);
        f.table.closesocket(replacement);
    } finally {f.table.reset();}
});
test("same listener id with replaced ACL invalidates the old lease",async()=>{
    const f=fixture();
    try {
        const pending=acquireDirectPlay4JoinListener(f.table,1000);f.ready();const owner=await pending;
        expect(owner.current()).toBe(true);
        f.network.configureTcpHosts({listeners:[{id:"join",allowedNodes:[[2,1,127,0,0,2]]}]});
        expect(owner.current()).toBe(false);
        owner.release();expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("ACL replacement inside last nativeListenerCurrent cannot return stale true",async()=>{
    const f=fixture();
    try {
        const pending=acquireDirectPlay4JoinListener(f.table,1000);f.ready();const owner=await pending;
        const current=f.table.nativeListenerCurrent.bind(f.table);let calls=0;
        f.table.nativeListenerCurrent=(sid,token)=>{
            calls++;
            f.network.configureTcpHosts({listeners:[{id:"join",allowedNodes:[[2,1,127,0,0,2]]}]});
            return current(sid,token);
        };
        expect(owner.current()).toBe(false);
        expect(calls).toBe(1);
        owner.release();expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("timeout, signal and reconfigured policy invalidate the listener",async()=>{
    const f=fixture();
    try {
        await expect(acquireDirectPlay4JoinListener(f.table,5)).rejects.toThrow();
        f.ready();await Promise.resolve();await Promise.resolve();expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
    const g=fixture();
    try {
        const c=new AbortController(), pending=acquireDirectPlay4JoinListener(g.table,1000,c.signal);
        g.ready();const owner=await pending;
        g.network.configureWinsock(undefined);
        expect(owner.current()).toBe(false);
        c.abort();expect(g.releases()).toBe(1);
    } finally {g.table.reset();}
});
