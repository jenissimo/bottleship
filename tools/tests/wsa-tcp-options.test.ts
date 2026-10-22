import {afterEach,expect,spyOn,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address} from "../../src/worker/modules/wsa-network";
import {makeSocketExports,WsaStartupCount} from "../../src/worker/modules/wsa-stub-shared";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {decodeTcpFrame,SYN,SYNACK,TCP_OPTION,SYN_KEEPALIVE_FLAG,SYN_NODELAY_FLAG,SYN_WINDOW_MASK,TCP_OPTION_KEEPALIVE,TCP_OPTION_NODELAY} from "../../src/worker/net/netplay-wire";
const tables:WsaSocketTable[]=[];
afterEach(()=>{for(const table of tables.splice(0))table.reset();});
function fixture(){
    const network=new LanNetwork(),table=new WsaSocketTable(network),memory=new Uint8Array(4096);tables.push(table);
    Mem.bind(()=>memory);const counter=new WsaStartupCount();counter.startup();let error=0;
    const api=makeSocketExports(table,value=>{error=value;},counter);
    const call=(name:string,args:number[])=>api[name]({} as never,memory,args);
    const set=(ptr:number,value:number)=>new DataView(memory.buffer).setUint32(ptr,value,true);
    const get=(ptr:number)=>new DataView(memory.buffer).getUint32(ptr,true);
    return {network,table,memory,call,set,get,error:()=>error};
}
test("TCP KEEPALIVE and NODELAY use one byte and preserve the other caller bytes in both IP families",()=>{
    for(const family of [2,23])for(const [level,option,key] of [[0xffff,8,"keepAlive"],[6,1,"noDelay"]] as const){
        const h=fixture(),socket=h.table.socket(1,family,6);
        h.set(0x100,0xa5a5a5a5);h.set(0x200,4);expect(h.call("getsockopt",[socket,level,option,0x100,0x200])).toBe(0);
        expect(h.get(0x100)).toBe(0xa5a5a500);expect(h.get(0x200)).toBe(1);
        h.memory[4095]=1;expect(h.call("setsockopt",[socket,level,option,4095,1])).toBe(0);expect(h.table.get(socket)[key]).toBe(true);
        h.set(0x100,0xa5a5a5a5);h.set(0x200,1);expect(h.call("getsockopt",[socket,level,option,0x100,0x200])).toBe(0);
        expect(h.get(0x100)).toBe(0xa5a5a501);expect(h.get(0x200)).toBe(1);
        h.set(0x100,0x100);expect(h.call("setsockopt",[socket,level,option,0x100,4])).toBe(0);expect(h.table.get(socket)[key]).toBe(false);
        expect(h.call("setsockopt",[socket,level,option,0x100,0])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);
        expect(h.call("setsockopt",[socket,level,option,0,1])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);
    }
});
test("UDP option failures preserve native error precedence and TCP level clears the output length",()=>{
    const h=fixture(),socket=h.table.socket(2);
    h.set(0x100,1);
    expect(h.call("setsockopt",[socket,0xffff,8,0x100,0])).toBe(-1);expect(h.error()).toBe(WSA.ENOPROTOOPT);
    expect(h.call("setsockopt",[socket,6,1,0x100,0])).toBe(-1);expect(h.error()).toBe(WSA.EINVAL);
    h.set(0x100,0xa5a5a5a5);h.set(0x200,4);
    expect(h.call("getsockopt",[socket,0xffff,8,0x100,0x200])).toBe(-1);expect(h.error()).toBe(WSA.ENOPROTOOPT);expect(h.get(0x200)).toBe(4);
    expect(h.call("getsockopt",[socket,6,1,0x100,0x200])).toBe(-1);expect(h.error()).toBe(WSA.EINVAL);expect(h.get(0x200)).toBe(0);expect(h.get(0x100)).toBe(0xa5a5a5a5);
    expect(h.call("getsockopt",[socket,6,1,0x100,0x200])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);
    expect(h.call("setsockopt",[socket,6,1,0,1])).toBe(-1);expect(h.error()).toBe(WSA.EFAULT);
});
test("initial TCP frames carry native options, accepted sockets inherit the listener, and remote changes leave local options alone",()=>{
    const h=fixture(),frames:Array<NonNullable<ReturnType<typeof decodeTcpFrame>>>=[];
    const send=h.network.send.bind(h.network),spy=spyOn(h.network,"send").mockImplementation((...args)=>{const frame=decodeTcpFrame(args[3]);if(frame)frames.push(frame);return send(...args);});
    try{
        const listener=h.table.socket(),client=h.table.socket();h.table.setKeepAlive(client,true);h.table.setNoDelay(client,true);
        h.table.setNoDelay(listener,true);h.table.bind(listener,ipv4Address(h.network.ipv4,7531));h.table.listen(listener);
        expect(h.table.connect(client,ipv4Address(h.network.ipv4,7531))).toBe(0);const accepted=h.table.accept(listener);
        const syn=frames.find(frame=>frame.kind===SYN)!,ack=frames.find(frame=>frame.kind===SYNACK)!;
        expect(syn.value&SYN_KEEPALIVE_FLAG).not.toBe(0);expect(syn.value&SYN_NODELAY_FLAG).not.toBe(0);expect(syn.value&SYN_WINDOW_MASK).toBe(h.table.get(client).receiveLimit);
        expect(ack.value&SYN_KEEPALIVE_FLAG).toBe(0);expect(ack.value&SYN_NODELAY_FLAG).not.toBe(0);
        expect(h.table.get(accepted).keepAlive).toBe(false);expect(h.table.get(accepted).noDelay).toBe(true);
        h.table.setKeepAlive(client,false);h.table.setNoDelay(client,false);
        expect(frames.filter(frame=>frame.kind===TCP_OPTION).map(frame=>frame.value)).toEqual([TCP_OPTION_KEEPALIVE,TCP_OPTION_NODELAY]);
        expect(h.table.get(accepted).noDelay).toBe(true);expect(h.table.send(client,Uint8Array.of(9))).toBe(1);expect(h.table.receive(accepted,1).data[0]).toBe(9);
    }finally{spy.mockRestore();}
});
test("refused native option writes leave the physical setting unchanged",()=>{
    const h=fixture(),listener=h.table.socket(),client=h.table.socket();
    h.table.bind(listener,ipv4Address(h.network.ipv4,7532));h.table.listen(listener);h.table.connect(client,ipv4Address(h.network.ipv4,7532));h.table.accept(listener);
    const spy=spyOn(h.network,"send").mockReturnValue(false);
    try{for(const option of ["setKeepAlive","setNoDelay"] as const){
        try{h.table[option](client,true);throw Error("expected network failure");}catch(error){expect(error).toBeInstanceOf(WsaFailure);expect((error as WsaFailure).code).toBe(WSA.ENETDOWN);}
        expect(h.table.get(client)[option==="setKeepAlive"?"keepAlive":"noDelay"]).toBe(false);
    }}finally{spy.mockRestore();}
});
