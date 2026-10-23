// Actual namespace/socket-actor fixture for native UDP_CONNRESET contracts.
import {spyOn} from "bun:test";
import {System} from "../../../src/worker/core/system";
import {RootNetworkNamespace} from "../../../src/worker/core/network-namespace";
import {LanNetwork} from "../../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../../src/worker/modules/wsa-actor-table";
import {WSA,ipv4Address,ipv6Address} from "../../../src/worker/modules/wsa-network";
import {getWsaProcessState,makeSocketExports,makeWsaCleanup,WsaStartupCount} from "../../../src/worker/modules/wsa-stub-shared";
import {exports as sync,resetSyncState} from "../../../src/worker/modules/kernel32/sync";
import type {WsaErrorSetter} from "../../../src/worker/modules/wsa-network-api";
import type {ThunkResult} from "../../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./wsa-api-context";

export const RESET=0x9800000c,input=0x20000,returned=0x21000,ov=0x24000,routine=0x60000,data=0x28000,info=0x30000;
let sequence=0;
export async function actorFixture(){
    const pid=33000+(++sequence),network=new LanNetwork(),host=new RootNetworkNamespace(network,16,pid);
    await host.barrier();
    const table=createWsaActorTable(network,()=>host.socketActorClient()),memory=createWsaApiFixture(table,0x1234);
    const system=System.getInstance(),owner=system.process!,state=getWsaProcessState(owner),oldTable=state.table;
    // Existing socket-file-io tests use this public process-state composition:
    // genuine kernel handle lookup and IOCP must resolve the same actor facade.
    state.table=table;resetSyncState();
    let thread=7;const errors=new Map([[7,0x1234],[9,0x2222]]);
    const setter:WsaErrorSetter=code=>{errors.set(thread,code);};
    setter.capture=()=>{const tid=thread;return code=>{errors.set(tid,code);};};
    const counter=new WsaStartupCount(()=>table.reset());counter.startup();
    const api=makeSocketExports(table,setter,counter,owner),cleanup=makeWsaCleanup(counter,setter);
    const handles:number[]=[],spies:Array<{mockRestore():void}>=[];
    spies.push(spyOn(system.scheduler,"getCurrentThreadId").mockImplementation(()=>thread));
    owner.addressSpace.registerRegion({base:routine,size:4096,perms:"rx",kind:"ROM",owner:"udp-reset-test",allowOverlap:true});
    const value=(r:any):number=>typeof r==="number"?r:r.value;
    const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
    const address=(af:number,port=0)=>af===2?ipv4Address(Uint8Array.of(127,0,0,1),port):ipv6Address(Uint8Array.of(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1),port);
    const socket=(af=2,flags=1)=>value(api.WSASocketA({} as never,memory.ram,[af,2,17,0,0,flags]));
    const ioctl=(socket:number,option:number,{length=4,count=returned,overlapped=0,apc=0,source=input,output=0,capacity=0}={})=>{
        memory.put(input,option);memory.put(returned,0xabcdef01);
        return api.WSAIoctl({} as never,memory.ram,[socket,RESET,source,length,output,capacity,count,overlapped,apc]);
    };
    const untilReadable=async(socket:number)=>{
        const deadline=Date.now()+1000;
        while(!table.readable(socket)){
            if(Date.now()>=deadline)throw Error("Expected real actor UDP readiness within1s; no event/result injection");
            await new Promise(resolve=>setTimeout(resolve,1));
        }
    };
    const read=(socket:number)=>{
        memory.ram.fill(0xa5,data,data+8);
        const result=value(api.recv({} as never,memory.ram,[socket,data,8,0]));
        return{result,error:errors.get(thread),byte:memory.ram[data]};
    };
    return{
        ...memory,api,table,host,owner,counter,cleanup,pid,value,tick,address,socket,ioctl,untilReadable,read,
        error:()=>errors.get(thread),thread:(id:number)=>{thread=id;},
        event(){const h=system.scheduler.createEvent(true,false);handles.push(h);memory.put(ov+16,h);return system.resourceProvider.getKernelObject(h) as {signaled:boolean};},
        iocp(socket:number){const h=value(sync.CreateIoCompletionPort({} as never,memory.ram,[socket,0,42,0]));handles.push(h);return h;},
        dequeue(port:number){return value(sync.GetQueuedCompletionStatus({} as never,memory.ram,[port,returned,returned+4,returned+8,0]));},
        apcs(){const captured:unknown[][]=[];spies.push(spyOn(system.scheduler,"queueWsaCompletionApc").mockImplementation((...args)=>{captured.push(args);return true;}));return captured;},
        async peers(af:number){
            const client=socket(af),dead=socket(af),live=socket(af);
            for(const s of [client,dead,live])table.bind(s,address(af));
            table.setNonBlocking(client,true);
            const self=table.get(client).local!,deadAddress=table.get(dead).local!,liveAddress=table.get(live).local!;
            table.send(client,Uint8Array.of(87),deadAddress);await untilReadable(dead);
            if(table.receive(dead,8).data[0]!==87)throw Error("Warm-up datagram mismatch");
            table.closesocket(dead);
            return{client,live,self,deadAddress,liveAddress};
        },
        async liveControl(client:number,live:number,self:ReturnType<typeof address>){
            table.send(live,Uint8Array.of(66),self);await untilReadable(client);
            const packet=read(client);
            if(packet.result!==1||packet.byte!==66)throw Error("Real live peer control failed: "+JSON.stringify(packet));
        },
        async disposeActor(){
            owner.resetGeneration++;for(const spy of spies.reverse())spy.mockRestore();
            table.reset();counter.reset();resetSyncState();
            for(const h of handles)system.resourceProvider.unregisterKernelObject(h);
            state.table=oldTable;state.reset();
            try{memory.dispose();}finally{await host.close();}
        }
    };
}
