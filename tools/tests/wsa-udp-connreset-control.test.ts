// Independent native6168 + non-atomic rejection976, Windows11 x86.
import {beforeEach,afterEach,expect,test} from "bun:test";
import {WSA} from "../../src/worker/modules/wsa-network";
import {actorFixture,input,returned,ov,routine} from "./fixtures/udp-connreset-actor";
let f:Awaited<ReturnType<typeof actorFixture>>;
beforeEach(async()=>{f=await actorFixture();});
afterEach(async()=>{await f?.disposeActor();});
test("UDP ioctl accepts first-byte input and never dereferences non-NULL returned/output pointers",()=>{
    const s=f.socket();f.put(input,256);
    expect(f.value(f.ioctl(s,256,{length:1,count:1,output:1,capacity:0xffffffff}))).toBe(0);
    expect(f.error()).toBe(0);expect(f.get(returned)).toBe(0xabcdef01);expect(f.table.get(s).local).toBeNull();
});
test("first-byte values and huge declared lengths do not widen the UDP input probe",()=>{
    const s=f.socket();
    for(const [value,on]of [[0,false],[256,false],[65536,false],[16777216,false],[1,true],[2,true],[257,true],[0xffffffff,true]] as const){
        for(const length of [1,3,8,0xffffffff]){
            expect(f.value(f.ioctl(s,value,{length}))).toBe(0);
            expect(f.error()).toBe(0);expect(f.table.get(s).udpConnReset).toBe(on);
        }
    }
});
test("read-only byte is accepted across an inaccessible unused tail, and unused outputs are never probed",()=>{
    const s=f.socket(),boundary=0x41000;
    f.ram[boundary-1]=1;
    f.owner.addressSpace.registerRegion({base:boundary-4096,size:4096,perms:"r",kind:"ROM",owner:"udp-readonly",allowOverlap:true});
    f.owner.addressSpace.registerRegion({base:boundary,size:4096,perms:"noaccess",kind:"ROM",owner:"udp-noaccess",allowOverlap:true});
    expect(f.value(f.ioctl(s,0,{source:boundary-1,length:0xffffffff,count:boundary,output:boundary,capacity:0xffffffff}))).toBe(0);
    expect(f.error()).toBe(0);expect(f.table.get(s).udpConnReset).toBe(true);
    expect(f.value(f.ioctl(s,0,{source:boundary}))).toBe(-1);expect(f.error()).toBe(WSA.EFAULT);
    expect(f.table.get(s).udpConnReset).toBe(true);
    const tcp=f.table.socket(1);
    expect(f.value(f.ioctl(tcp,0,{source:boundary}))).toBe(-1);expect(f.error()).toBe(WSA.EINVAL);
});
test("startup failure precedes invalid socket and pointers",()=>{
    f.counter.reset();
    expect(f.value(f.ioctl(0x12345678,1,{source:0,count:0}))).toBe(-1);
    expect(f.error()).toBe(10093);
});
test("UDP ioctl reports basic NULL/zero arguments before TCP validation, and TCP before non-NULL dereference",()=>{
    const tcp=f.table.socket(1);
    expect(f.value(f.ioctl(tcp,1,{source:0}))).toBe(-1);expect(f.error()).toBe(WSA.EFAULT);
    expect(f.value(f.ioctl(tcp,1,{length:0}))).toBe(-1);expect(f.error()).toBe(WSA.EFAULT);
    expect(f.value(f.ioctl(tcp,1,{source:1}))).toBe(-1);expect(f.error()).toBe(WSA.EINVAL);
    expect(f.value(f.ioctl(0x12345678,1,{source:0,count:0}))).toBe(-1);expect(f.error()).toBe(WSA.ENOTSOCK);
});
test("NULL byte-count pointer rejects before OVERLAPPED/event side effects",async()=>{
    const s=f.socket(),event=f.event();f.put(ov,0x11111111);f.put(ov+4,0x22222222);
    expect(f.value(f.ioctl(s,1,{count:0,overlapped:ov}))).toBe(-1);expect(f.error()).toBe(WSA.EFAULT);
    await f.tick();expect(f.get(ov)).toBe(0x11111111);expect(f.get(ov+4)).toBe(0x22222222);expect(event.signaled).toBe(false);
});
test("flags0 UDP ioctl ignores valid OVERLAPPED, event and routine",async()=>{
    const s=f.socket(2,0),event=f.event(),calls=f.apcs();
    f.put(ov,0x11111111);f.put(ov+4,0x22222222);
    expect(f.value(f.ioctl(s,0,{overlapped:ov,apc:routine}))).toBe(0);expect(f.error()).toBe(0);
    await f.tick();expect(f.get(ov)).toBe(0x11111111);expect(f.get(ov+4)).toBe(0x22222222);expect(event.signaled).toBe(false);expect(calls).toEqual([]);
});
test("flags1 event ioctl succeeds synchronously with zero IOSB and untouched returned/offsets",async()=>{
    const s=f.socket(),event=f.event();f.put(ov,0x11111111);f.put(ov+4,0x22222222);f.put(ov+8,0x33333333);f.put(ov+12,0x44444444);
    expect(f.value(f.ioctl(s,0,{overlapped:ov}))).toBe(0);expect(f.error()).toBe(0);await f.tick();
    expect([f.get(ov),f.get(ov+4),f.get(ov+8),f.get(ov+12),f.get(returned)]).toEqual([0,0,0x33333333,0x44444444,0xabcdef01]);
    expect(event.signaled).toBe(true);
});
test("flags1 routine completion keeps the issuing thread and exact OVERLAPPED ABI",async()=>{
    const s=f.socket(),calls=f.apcs();f.put(ov+16,0);
    expect(f.value(f.ioctl(s,1,{overlapped:ov,apc:routine}))).toBe(0);
    f.thread(9);await f.tick();
    expect(calls).toHaveLength(1);expect(calls[0][0]).toBe(7);expect(calls[0].slice(1,6)).toEqual([routine,0,0,ov,0]);
    expect(f.get(returned)).toBe(0xabcdef01);expect(f.get(ov)).toBe(0);expect(f.get(ov+4)).toBe(0);
    expect(f.error()).toBe(0x2222);f.thread(7);expect(f.error()).toBe(0);
});
test("IOCP ioctl returns success but retains pending IOSB until actual dequeue",async()=>{
    const s=f.socket(),port=f.iocp(s);expect(port).toBeGreaterThan(0);
    f.put(ov,0x11111111);f.put(ov+4,0x22222222);f.put(ov+16,0);
    expect(f.value(f.ioctl(s,1,{overlapped:ov}))).toBe(0);expect(f.error()).toBe(0);await f.tick();
    expect(f.get(ov)).toBe(259);expect(f.get(ov+4)).toBe(0x22222222);expect(f.get(returned)).toBe(0xabcdef01);
    expect(f.dequeue(port)).toBe(1);expect([f.get(returned),f.get(returned+4),f.get(returned+8)]).toEqual([0,42,ov]);
    expect([f.get(ov),f.get(ov+4)]).toEqual([0,0]);
});
