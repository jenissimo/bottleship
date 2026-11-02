import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable,WsaOwnedSocketOutcomeUnknown,WSA} from "../../src/worker/modules/wsa-network";
import {WsaActorKernel} from "../../src/worker/modules/wsa-actor-kernel";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {encodeWsaActorResponse} from "../../src/worker/modules/wsa-actor-response";
import {WSA_ACTOR_DONE,WSA_ACTOR_ERROR} from "../../src/worker/modules/wsa-actor-protocol";
import {DirectPlay4JoinChannel,type DirectPlay4JoinChannelOptions} from "../../src/worker/modules/dplayx/native-wire/join-channel";

test("worker response encoding failure closes exact owned alias, not a neighbor",()=>{
    const network=new LanNetwork(),table=new WsaSocketTable(network),kernel=new WsaActorKernel(table),identity={pid:11,slot:0,epoch:1};
    kernel.register(identity);
    const failed=kernel.execute(identity,"socketOwned",[1,2,6]) as {handle:number;object:number};
    const neighbor=kernel.execute(identity,"socketOwned",[1,2,6]) as {handle:number;object:number};
    const encoded=encodeWsaActorResponse(kernel,identity,"socketOwned",failed,WSA_ACTOR_DONE,100,()=>{throw Error("injected encoding failure");});
    expect(encoded.status).toBe(WSA_ACTOR_ERROR);
    expect(kernel.execute(identity,"isValid",[failed.handle])).toBe(false);
    expect(kernel.execute(identity,"isValid",[neighbor.handle])).toBe(true);
    const second=kernel.execute(identity,"socketOwned",[1,2,6]) as {handle:number;object:number};
    const overflow=encodeWsaActorResponse(kernel,identity,"acceptOwned",second,WSA_ACTOR_DONE,1,()=> "oversize");
    expect(overflow.status).toBe(WSA_ACTOR_ERROR);
    expect(kernel.execute(identity,"isValid",[second.handle])).toBe(false);
    expect(kernel.execute(identity,"isValid",[neighbor.handle])).toBe(true);
    kernel.drop(identity);
});

test("EXECUTING timeout signals unknown ownership and invokes retirement without retry",async()=>{
    const worker=new Worker(new URL("./fixtures/wsa-owned-timeout-worker.ts",import.meta.url).href,{type:"module"});
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    const channel=new MessageChannel(),ready=new Promise<void>(resolve=>{worker.onmessage=()=>resolve();});
    worker.postMessage({port:channel.port2},[channel.port2]);await ready;
    const net=new LanNetwork(),table=createWsaActorTable(net,{port:channel.port1,pid:12,slot:0,epoch:1});
    const controller=new AbortController();let retired=0;
    const address={family:2,node:Uint8Array.of(2,1,192,0,2,1),ip:Uint8Array.of(192,0,2,1),port:2300};
    const o:DirectPlay4JoinChannelOptions={destination:address,signal:controller.signal,
        listener:{socket:1,ownerToken:1,address:{node:[...address.node],port:2301},current:()=>true,release(){}},
        current:()=>true,authorizeDestination:()=>true,authorizePeer:()=>true,onFrame:()=>{},onFailure:()=>{},
        onOwnershipUncertain:error=>{
            expect(error).toBeInstanceOf(WsaOwnedSocketOutcomeUnknown);
            expect((error as WsaOwnedSocketOutcomeUnknown).code).toBe(WSA.ETIMEDOUT);
            retired++;controller.abort();channel.port1.close();worker.terminate();
        },
        timeoutMs:30000,maxFrameBytes:128,maxChildren:1,maxWriteBytes:128};
    try {
        expect(()=>new DirectPlay4JoinChannel(table,o)).toThrow(WsaOwnedSocketOutcomeUnknown);
        expect(retired).toBe(1);
        expect(()=>table.socketOwned(1,2,6)).toThrow();
        await stopped;
    } finally {channel.port1.close();worker.terminate();}
},15000);
