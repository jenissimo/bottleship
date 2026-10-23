// Sources: immutable SAME-PE6168 + non-atomic976, Windows11 x86.
import {beforeEach,afterEach,expect,test} from "bun:test";
import {WSA} from "../../src/worker/modules/wsa-network";
import {actorFixture,input,returned,ov,routine,info} from "./fixtures/udp-connreset-actor";
let f:Awaited<ReturnType<typeof actorFixture>>;
beforeEach(async()=>{f=await actorFixture();});
afterEach(async()=>{await f?.disposeActor();});
function option(s:number,on:number){expect(f.value(f.ioctl(s,on))).toBe(0);expect(f.error()).toBe(0);}
function duplicate(s:number){
    expect(f.value(f.api.WSADuplicateSocketA({} as never,f.ram,[s,f.pid,info]))).toBe(0);
    const alias=f.value(f.api.WSASocketA({} as never,f.ram,[-1,-1,-1,info,0,1]));
    expect(f.table.isValid(alias)).toBe(true);return alias;
}
for(const af of [2,23]){
    test("default ON produces a real closed-loopback UDP error, family"+af,async()=>{
        const p=await f.peers(af);
        f.table.send(p.client,Uint8Array.of(88),p.deadAddress);await f.untilReadable(p.client);
        expect(f.read(p.client)).toEqual({result:-1,error:WSA.ECONNRESET,byte:0xa5});
        await f.liveControl(p.client,p.live,p.self);
    });
    test("physical alias OFF survives source close and suppresses a new unreachable, family"+af,async()=>{
        const p=await f.peers(af),alias=duplicate(p.client);option(alias,0);
        expect(f.value(f.api.closesocket({} as never,f.ram,[p.client]))).toBe(0);
        expect(f.table.isValid(p.client)).toBe(false);
        f.table.send(alias,Uint8Array.of(88),p.deadAddress);
        await f.host.barrier();await f.liveControl(alias,p.live,p.self);
    });
    test("OFF does not clear queued54; source ON is visible through the alias, family"+af,async()=>{
        const p=await f.peers(af),alias=duplicate(p.client);
        f.table.send(p.client,Uint8Array.of(88),p.deadAddress);await f.untilReadable(alias);
        option(alias,0);expect(f.read(p.client).error).toBe(WSA.ECONNRESET);
        f.table.send(p.client,Uint8Array.of(88),p.deadAddress);await f.host.barrier();
        await f.liveControl(alias,p.live,p.self);
        option(p.client,1);f.table.send(alias,Uint8Array.of(88),p.deadAddress);await f.untilReadable(alias);
        expect(f.read(alias).error).toBe(WSA.ECONNRESET);await f.liveControl(alias,p.live,p.self);
    });
    test("unimported reservations preserve OFF across full provider cleanup/restart, family"+af,async()=>{
        const p=await f.peers(af);option(p.client,0);
        expect(f.value(f.api.WSADuplicateSocketA({} as never,f.ram,[p.client,f.pid,info]))).toBe(0);
        const other=info+1024;
        expect(f.value(f.api.WSADuplicateSocketA({} as never,f.ram,[p.live,f.pid,other]))).toBe(0);
        expect(f.value(f.cleanup({} as never,f.ram,[]))).toBe(0);f.counter.startup();
        const client=f.value(f.api.WSASocketA({} as never,f.ram,[-1,-1,-1,info,0,1]));
        const live=f.value(f.api.WSASocketA({} as never,f.ram,[-1,-1,-1,other,0,1]));
        expect(f.table.isValid(client)).toBe(true);expect(f.table.isValid(live)).toBe(true);
        f.table.send(client,Uint8Array.of(88),p.deadAddress);await f.host.barrier();await f.liveControl(client,live,p.self);
        option(client,1);f.table.send(client,Uint8Array.of(88),p.deadAddress);await f.untilReadable(client);
        expect(f.read(client).error).toBe(WSA.ECONNRESET);
    });
    for(const initialOn of [0,1])for(const queued of [false,true])
        test("IOCP+APC22 still applies opposite physical option, AF"+af+" initial"+initialOn+" queued"+queued,async()=>{
            const p=await f.peers(af);option(p.client,initialOn);
            f.table.send(p.client,Uint8Array.of(88),p.deadAddress);
            if(initialOn){await f.untilReadable(p.client);expect(f.read(p.client).error).toBe(WSA.ECONNRESET);}
            await f.liveControl(p.client,p.live,p.self);
            if(queued){
                option(p.client,1);f.table.send(p.client,Uint8Array.of(88),p.deadAddress);await f.untilReadable(p.client);
                option(p.client,initialOn);
            }
            const port=f.iocp(p.client),calls=f.apcs();expect(port).toBeGreaterThan(0);
            f.put(ov,0x11111111);f.put(ov+4,0x22222222);f.put(ov+8,0x33333333);f.put(ov+12,0x44444444);f.put(ov+16,0);
            expect(f.value(f.ioctl(p.client,1-initialOn,{overlapped:ov,apc:routine}))).toBe(-1);
            expect(f.error()).toBe(WSA.EINVAL);await f.tick();
            expect([f.get(returned),f.get(ov),f.get(ov+4),f.get(ov+8),f.get(ov+12)])
                .toEqual([0xabcdef01,259,0x22222222,0x33333333,0x44444444]);
            expect(calls).toEqual([]);f.put(returned+8,1);
            expect(f.dequeue(port)).toBe(0);expect(f.get(returned+8)).toBe(0);
            if(queued)expect(f.read(p.client).error).toBe(WSA.ECONNRESET);
            f.table.send(p.client,Uint8Array.of(88),p.deadAddress);
            if(!initialOn){await f.untilReadable(p.client);expect(f.read(p.client).error).toBe(WSA.ECONNRESET);}
            await f.liveControl(p.client,p.live,p.self);
        });
}
