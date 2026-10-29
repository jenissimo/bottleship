import {strict as assert} from "node:assert";
import {connect, type Socket} from "node:net";
import {once} from "node:events";
import {TcpHostCapacity} from "../../packages/lan/src/tcp-host-owner";
import {TcpAcceptQuota} from "../../packages/lan/src/tcp-accept-quota";
import {TcpAcceptBridge, type AcceptChild} from "../../packages/lan/src/tcp-accept-bridge";

async function main():Promise<void> {
    const executable=process.argv[2];assert(executable);
    const capacity=new TcpHostCapacity(1),quota=new TcpAcceptQuota(capacity);
    let offerResolve!:(v:AcceptChild)=>void, dataResolve!:(v:Buffer)=>void, eofResolve!:()=>void;
    const offered=new Promise<AcceptChild>(r=>offerResolve=r);
    const received=new Promise<Buffer>(r=>dataResolve=r);
    const eof=new Promise<void>(r=>eofResolve=r);
    let closed=0, failure:Error|undefined, peer:Socket|undefined;
    const bridge=new TcpAcceptBridge({executable,bindHost:"127.0.0.1",port:0,allowedHosts:[...Array.from({length:31},(_,i)=>`127.0.0.${i+2}`),"127.0.0.1"],limit:1,epoch:91},quota,{
        offer:c=>offerResolve(c),data:(_c,b)=>{dataResolve(Buffer.from(b));return true;},
        eof:()=>eofResolve(),closed:()=>{closed++;},failed:e=>{failure=e;},
    });
    let needResolve!:()=>void;
    const need=new Promise<void>(r=>needResolve=r);
    const spy=bridge as unknown as {event:(op:number,id:number,b:Buffer)=>void};
    const dispatch=spy.event.bind(bridge);
    spy.event=(op,id,b)=>{dispatch(op,id,b);if(op===102)needResolve();};
    const timer=setTimeout(()=>bridge.abort(new Error("owned test timeout")),10000);
    try {
        const port=await bridge.ready;
        peer=connect(port,"127.0.0.1");await once(peer,"connect");
        await need;
        assert.equal(capacity.active,0,"NEED before activation must not authorize accept");
        bridge.activate();
        const child=await offered;
        assert.equal(capacity.active,1);
        bridge.credit(child,32);
        peer.write("abc");
        assert.equal((await received).toString(),"abc");
        const response=once(peer,"data");await bridge.write(child,Buffer.from("xyz"));
        assert.equal((await response)[0].toString(),"xyz");
        await bridge.finishWrite(child);
        await assert.rejects(bridge.write(child,Buffer.from("late")));
        peer.end();await eof;
        await bridge.stop();
        assert.equal(capacity.active,1);
        await bridge.closeChild(child);
        assert.equal(closed,1);assert.equal(capacity.active,0);
        await bridge.shutdown();
        assert.equal(failure,undefined);assert.equal(quota.activeCount,0);
        console.log("native accept bridge owned loopback: ok");
    } finally {
        clearTimeout(timer);peer?.destroy();
        bridge.abort(new Error("test cleanup"));
        await bridge.whenPhysicalClosed();
    }
    const capacity2=new TcpHostCapacity(1),quota2=new TcpAcceptQuota(capacity2);
    let admitted!:(child:AcceptChild)=>void, reported:Error|undefined;
    const gotChild=new Promise<AcceptChild>(r=>admitted=r);
    const bridge2=new TcpAcceptBridge({executable,bindHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.2","127.0.0.1"],limit:1,epoch:92},quota2,{
        offer:admitted,data:()=>true,eof:()=>{},closed:()=>{},failed:e=>{reported=e;},
    });
    let peer2:Socket|undefined;
    const timer2=setTimeout(()=>bridge2.abort(new Error("owned test timeout")),10000);
    try {
        const port=await bridge2.ready;bridge2.activate();
        peer2=connect(port,"127.0.0.1");peer2.on("error",()=>{});await once(peer2,"connect");
        await gotChild;
        assert.equal(capacity2.active,1);
        bridge2.abort(new Error("injected failure"));
        assert.equal(capacity2.active,1,"permit stays held before process close");
        await bridge2.whenPhysicalClosed();
        assert.equal(capacity2.active,0);
        assert.equal(quota2.activeCount,0);
        assert.equal(reported?.message,"injected failure");
        console.log("native accept bridge owned failure: ok");
    } finally {
        clearTimeout(timer2);peer2?.destroy();bridge2.abort(new Error("test cleanup"));
        await bridge2.whenPhysicalClosed();
    }
    const fake=process.argv[3];assert(fake);
    const capacity3=new TcpHostCapacity(1),quota3=new TcpAcceptQuota(capacity3);
    let delivered=0,failed3=0,held=false,combined=false;
    let bridge3!:TcpAcceptBridge;
    bridge3=new TcpAcceptBridge({executable:fake,bindHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.2","127.0.0.1"],limit:1,epoch:93},quota3,{
        offer:child=>{
            bridge3.credit(child,1);
            bridge3.abort(new Error("reentrant abort"));
            held=capacity3.active===1;
        },
        data:()=>{delivered++;return true;},eof:()=>{delivered++;},closed:()=>{delivered++;},
        failed:()=>{failed3++;},
    });
    const inspect=bridge3 as unknown as {receive:(b:Buffer)=>void};
    const original=inspect.receive.bind(bridge3);
    inspect.receive=(b:Buffer)=>{if(b.length===77&&b[5]===103&&b[49]===109)combined=true;original(b);};
    const timer3=setTimeout(()=>bridge3.abort(new Error("owned test timeout")),10000);
    try {
        await bridge3.ready;bridge3.activate();
        await bridge3.whenPhysicalClosed();
        assert.equal(failed3,1);assert.equal(delivered,0);
        assert.equal(combined,true,"GRANT and DATA must share a stdout chunk");
        assert.equal(held,true);assert.equal(capacity3.active,0);
        console.log("native accept bridge reentrant abort: ok");
    } finally {
        clearTimeout(timer3);bridge3.abort(new Error("test cleanup"));await bridge3.whenPhysicalClosed();
    }
    // A one-record test transport queues GRANT on the data lane while STOP uses
    // the independent real control pipe. The native helper sees STOP first.
    const capacity4=new TcpHostCapacity(1),quota4=new TcpAcceptQuota(capacity4);
    let heldGrant!:()=>void,releaseGrant!:()=>boolean,offers4=0;
    const grantQueued=new Promise<void>(r=>heldGrant=r);
    const bridge4=new TcpAcceptBridge({executable,bindHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.2","127.0.0.1"],limit:1,epoch:94},quota4,{
        offer:()=>{offers4++;},data:()=>true,eof:()=>{},closed:()=>{},failed:()=>{},
    });
    const transport=bridge4 as unknown as {send:(control:boolean,op:number,id:number,body?:Buffer)=>boolean};
    const send=transport.send.bind(bridge4);
    transport.send=(control,op,id,body)=>{
        if(op===1) {
            assert.equal(releaseGrant,undefined);
            const copy=body&&Buffer.from(body);
            releaseGrant=()=>send(control,op,id,copy);
            heldGrant();return true;
        }
        return send(control,op,id,body);
    };
    let peer4:Socket|undefined;
    const timer4=setTimeout(()=>bridge4.abort(new Error("owned test timeout")),10000);
    try {
        const port=await bridge4.ready;bridge4.activate();
        peer4=connect(port,"127.0.0.1");peer4.on("error",()=>{});await once(peer4,"connect");
        await grantQueued;
        assert.equal(capacity4.active,1);
        const shutdown=bridge4.shutdown();
        await bridge4.stop();
        assert.equal(capacity4.active,1,"queued grant remains owned across STOP");
        assert.equal(releaseGrant(),true);
        await shutdown;
        assert.equal(offers4,0);
        assert.equal(capacity4.active,0);
        console.log("native accept bridge late grant: ok");
    } finally {
        clearTimeout(timer4);peer4?.destroy();bridge4.abort(new Error("test cleanup"));
        await bridge4.whenPhysicalClosed();
    }
    const capacity5=new TcpHostCapacity(1),quota5=new TcpAcceptQuota(capacity5);
    let accepted5!:(child:AcceptChild)=>void;
    const got5=new Promise<AcceptChild>(r=>accepted5=r);
    let failure5:Error|undefined;
    const bridge5=new TcpAcceptBridge({executable,bindHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.2","127.0.0.1"],limit:1,epoch:95},quota5,{
        offer:accepted5,data:()=>true,eof:()=>{},closed:()=>{},failed:e=>{failure5=e;},
    });
    let peer5:Socket|undefined;
    const timer5=setTimeout(()=>bridge5.abort(new Error("owned test timeout")),10000);
    try {
        const port=await bridge5.ready;bridge5.activate();
        peer5=connect(port,"127.0.0.1");peer5.on("error",()=>{});await once(peer5,"connect");
        const child=await got5;
        const writes=Array.from({length:16},()=>bridge5.write(child,Buffer.alloc(16384,7)));
        const results=Promise.allSettled(writes);
        await assert.rejects(bridge5.write(child,Buffer.from([1])),/capacity/);
        await bridge5.closeChild(child);
        await results;
        assert.equal(capacity5.active,0);
        await bridge5.shutdown();
        assert.equal(failure5,undefined);
        console.log("native accept bridge bounded write admission: ok");
    } finally {
        clearTimeout(timer5);peer5?.destroy();bridge5.abort(new Error("test cleanup"));
        await bridge5.whenPhysicalClosed();
    }
    const capacity6=new TcpHostCapacity(1),quota6=new TcpAcceptQuota(capacity6);
    let offers6=0,refused!:()=>void,failure6:Error|undefined;
    const refusedPromise=new Promise<void>(r=>refused=r);
    const bridge6=new TcpAcceptBridge({executable,bindHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.2","127.0.0.3"],limit:1,epoch:96},quota6,{
        offer:()=>{offers6++;},data:()=>true,eof:()=>{},closed:()=>{},failed:e=>{failure6=e;},
    });
    const spy6=bridge6 as unknown as {event:(op:number,id:number,b:Buffer)=>void};
    const event6=spy6.event.bind(bridge6);
    spy6.event=(op,id,b)=>{event6(op,id,b);if(op===103&&b.readUInt32LE()===2)refused();};
    let peer6:Socket|undefined;
    const timer6=setTimeout(()=>bridge6.abort(new Error("owned test timeout")),10000);
    try {
        const port=await bridge6.ready;bridge6.activate();
        peer6=connect(port,"127.0.0.1");peer6.on("error",()=>{});await once(peer6,"connect");
        await refusedPromise;
        assert.equal(offers6,0);assert.equal(capacity6.active,0);
        await bridge6.shutdown();assert.equal(failure6,undefined);
        console.log("native accept bridge ACL rejection: ok");
    } finally {
        clearTimeout(timer6);peer6?.destroy();bridge6.abort(new Error("test cleanup"));
        await bridge6.whenPhysicalClosed();
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
