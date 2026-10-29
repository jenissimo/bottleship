import {strict as assert} from "node:assert";
import {connect,type Socket} from "node:net";
import {once} from "node:events";
import {NativeDestinationPolicy} from "../../packages/lan/src/native-policy";
import {TcpHostCapacity,TcpHostRegistry} from "../../packages/lan/src/tcp-host-owner";
import {TcpAcceptQuota} from "../../packages/lan/src/tcp-accept-quota";
import {TcpAcceptHostOwner} from "../../packages/lan/src/tcp-accept-host-owner";
import {decodeDatagram,encodeDatagram} from "../../packages/lan/src/protocol";
import {decodeTcpFrame,encodeTcpFrame,DATA,FIN,SYN,SYNACK,TCP_WINDOW,type TcpFrame} from "../../packages/lan/src/tcp-protocol";

async function main():Promise<void> {
    const executable=process.argv[2];assert(executable);
    const capacity=new TcpHostCapacity(2),quota=new TcpAcceptQuota(capacity);
    const policy=new NativeDestinationPolicy(),registry=new TcpHostRegistry(policy,capacity);
    const events:TcpFrame[]=[];
    let changed:()=>void=()=>{};
    const owner=new TcpAcceptHostOwner(registry,quota,executable,111,(frame,generation)=>{
        assert.equal(generation,8);
        const d=decodeDatagram(frame);assert(d);const tcp=decodeTcpFrame(d.payload);assert(tcp);
        events.push(tcp);changed();return true;
    },()=>{throw Error("unexpected helper failure");});
    let peer:Socket|undefined;
    const timeout=setTimeout(()=>{process.exitCode=1;owner.close();changed();},10000);
    try {
        const opened=await owner.open({id:"owned",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",
            port:0,allowedHosts:["127.0.0.2","127.0.0.1"],maxOwners:1,maxPending:2},
            {localPort:5000,generation:8});
        owner.activate();
        peer=connect(opened.address.port,"127.0.0.1");peer.on("error",()=>{});await once(peer,"connect");
        const take=async(kind:number):Promise<TcpFrame>=>{
            for(;;) {
                const i=events.findIndex(e=>e.kind===kind);
                if(i>=0)return events.splice(i,1)[0];
                await new Promise<void>(r=>{changed=r;});
            }
        };
        const syn=await take(SYN);
        assert.equal(capacity.active,1);
        const node=Uint8Array.of(2,1,127,0,0,1),port=peer.localPort!;
        const send=(kind:number,value=0,data?:Uint8Array)=>{
            const d=decodeDatagram(encodeDatagram(2,node,port,5000,encodeTcpFrame(kind,9,syn.srcId,value,data)))!;
            d.bindingGeneration=8;assert.equal(owner.handle(d),true);
        };
        const stale=decodeDatagram(encodeDatagram(2,node,port,5000,encodeTcpFrame(SYNACK,9,syn.srcId,TCP_WINDOW)))!;
        stale.bindingGeneration=7;assert.equal(owner.handle(stale),false);
        const wrong=decodeDatagram(encodeDatagram(2,Uint8Array.of(2,1,127,0,0,2),port,5000,encodeTcpFrame(SYNACK,9,syn.srcId,TCP_WINDOW)))!;
        wrong.bindingGeneration=8;assert.equal(owner.handle(wrong),false);
        send(SYNACK,TCP_WINDOW);
        const stopped=owner.closeListener();
        assert.equal(capacity.active,1);
        assert.equal(policy.acquire("127.0.0.1",{},true),null);
        const networkData=once(peer,"data");send(DATA,0,Buffer.from("out"));
        assert.equal((await networkData)[0].toString(),"out");
        peer.write("in");
        assert.equal(Buffer.from((await take(DATA)).data).toString(),"in");
        send(FIN);peer.end();await take(FIN);
        await stopped;
        assert.equal(capacity.active,0);assert.equal(quota.activeCount,0);
        const release=policy.acquire("127.0.0.1",{},true);assert(release);release();
        console.log("native accept owner survives listener stop: ok");
    } finally {
        clearTimeout(timeout);peer?.destroy();owner.close();await owner.closeListener();
    }
    // Retain the rejected child's real close response at the event boundary:
    // STOP must not quiesce until its exact FENCE/BARRIER has retired.
    const cap2=new TcpHostCapacity(2),q2=new TcpAcceptQuota(cap2),policy2=new NativeDestinationPolicy();
    const registry2=new TcpHostRegistry(policy2,cap2);
    let synReady!:()=>void,heldReady!:()=>void,releaseClose!:()=>void,synCount=0,quiesce=false;
    const synPromise=new Promise<void>(r=>synReady=r),heldPromise=new Promise<void>(r=>heldReady=r);
    const owner2=new TcpAcceptHostOwner(registry2,q2,executable,112,(frame)=>{
        const d=decodeDatagram(frame)!;if(decodeTcpFrame(d.payload)?.kind===SYN){synCount++;synReady();}
        return true;
    });
    let a:Socket|undefined,b:Socket|undefined;
    const timer2=setTimeout(()=>{process.exitCode=1;owner2.close();},10000);
    try {
        const opened=await owner2.open({id:"bounded",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",
            port:0,allowedHosts:["127.0.0.1"],maxOwners:1,maxPending:1},{localPort:5001,generation:9});
        const bridge=(owner2 as unknown as {bridge: {
            event:(op:number,id:number,body:Buffer)=>void;
            send:(control:boolean,op:number,id:number,body?:Buffer)=>boolean;
            stop:()=>Promise<void>;
        }}).bridge;
        const event=bridge.event.bind(bridge),send=bridge.send.bind(bridge);
        bridge.event=(op,id,body)=>{
            if(op===106&&body.readBigUInt64LE()===2n) {
                const copy=Buffer.from(body);releaseClose=()=>event(op,id,copy);heldReady();return;
            }
            event(op,id,body);
        };
        bridge.send=(control,op,id,body)=>{if(op===11)quiesce=true;return send(control,op,id,body);};
        owner2.activate();
        a=connect(opened.address.port,"127.0.0.1");a.on("error",()=>{});await once(a,"connect");await synPromise;
        b=connect(opened.address.port,"127.0.0.1");b.on("error",()=>{});await once(b,"connect");await heldPromise;
        assert.equal(synCount,1);
        const stopped=owner2.closeListener();await bridge.stop();
        assert.equal(quiesce,false,"dismissed child must retire before QUIESCE");
        releaseClose();await stopped;
        assert.equal(quiesce,true);assert.equal(cap2.active,0);assert.equal(q2.activeCount,0);
        console.log("native accept owner waits dismissed child: ok");
    } finally {
        clearTimeout(timer2);a?.destroy();b?.destroy();owner2.close();await owner2.closeListener();
    }
    const cap3=new TcpHostCapacity(2),q3=new TcpAcceptQuota(cap3),registry3=new TcpHostRegistry(new NativeDestinationPolicy(),cap3);
    const frames3:Array<{port:number;frame:TcpFrame}>=[];let wake3:()=>void=()=>{};
    const owner3=new TcpAcceptHostOwner(registry3,q3,executable,113,(bytes)=>{
        const d=decodeDatagram(bytes)!;const frame=decodeTcpFrame(d.payload)!;
        frames3.push({port:d.srcPort,frame});wake3();return true;
    });
    let p3:Socket|undefined,p4:Socket|undefined;
    const timer3=setTimeout(()=>{process.exitCode=1;owner3.close();wake3();},10000);
    try {
        const opened=await owner3.open({id:"early",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",
            port:0,allowedHosts:["127.0.0.1"],maxOwners:1,maxPending:2},{localPort:5002,generation:10});
        const bridge=(owner3 as unknown as {bridge:{option:(c:{child:bigint;permit:bigint},option:number,enabled:boolean)=>Promise<number>}}).bridge;
        const option=bridge.option.bind(bridge);let releaseOption!:()=>void,optionHeld!:()=>void;
        const held=new Promise<void>(r=>optionHeld=r);
        bridge.option=(child,opt,enabled)=>{
            const actual=option(child,opt,enabled);
            if(child.child!==1n||opt!==1)return actual;
            return actual.then(value=>new Promise<number>(resolve=>{releaseOption=()=>resolve(value);optionHeld();}));
        };
        owner3.activate();
        p3=connect(opened.address.port,"127.0.0.1");p3.on("error",()=>{});await once(p3,"connect");
        p4=connect(opened.address.port,"127.0.0.1");p4.on("error",()=>{});await once(p4,"connect");
        const take3=async(port:number,kind:number):Promise<TcpFrame>=>{
            for(;;){const i=frames3.findIndex(e=>e.port===port&&e.frame.kind===kind);
                if(i>=0)return frames3.splice(i,1)[0].frame;
                await new Promise<void>(r=>{wake3=r;});}
        };
        const s1=await take3(p3.localPort!,SYN),s2=await take3(p4.localPort!,SYN);
        const send3=(port:number,id:number,kind:number,value=0,data?:Uint8Array)=>{
            const d=decodeDatagram(encodeDatagram(2,Uint8Array.of(2,1,127,0,0,1),port,5002,encodeTcpFrame(kind,9,id,value,data)))!;
            d.bindingGeneration=10;assert.equal(owner3.handle(d),true);
        };
        send3(p3.localPort!,s1.srcId,SYNACK,TCP_WINDOW);
        await held;
        const close3=once(p3,"close");
        send3(p3.localPort!,s1.srcId,5);
        send3(p4.localPort!,s2.srcId,SYNACK,TCP_WINDOW);
        releaseOption();await close3;
        const received4=once(p4,"data");send3(p4.localPort!,s2.srcId,DATA,0,Buffer.from("alive"));
        assert.equal((await received4)[0].toString(),"alive");
        assert.equal(cap3.active,1);
        console.log("native accept owner early RST keeps sibling live: ok");
    } finally {
        clearTimeout(timer3);p3?.destroy();p4?.destroy();owner3.close();await owner3.closeListener();
    }
    const cap4=new TcpHostCapacity(1),q4=new TcpAcceptQuota(cap4),policy4=new NativeDestinationPolicy();
    const reg4=new TcpHostRegistry(policy4,cap4);
    let syn4!:()=>void,fail4=0,rst4=0,flow4:TcpFrame|undefined;
    const got4=new Promise<void>(r=>syn4=r);
    const owner4=new TcpAcceptHostOwner(reg4,q4,executable,114,(bytes)=>{
        const frame=decodeTcpFrame(decodeDatagram(bytes)!.payload)!;
        if(frame.kind===SYN){flow4=frame;syn4();}if(frame.kind===5)rst4++;return true;
    },()=>{fail4++;});
    let p5:Socket|undefined;
    const timer4=setTimeout(()=>{process.exitCode=1;owner4.close();},10000);
    try {
        const opened=await owner4.open({id:"die",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",
            port:0,allowedHosts:["127.0.0.1"],maxOwners:1,maxPending:1},{localPort:5003,generation:11});
        owner4.activate();
        p5=connect(opened.address.port,"127.0.0.1");p5.on("error",()=>{});await once(p5,"connect");await got4;
        const handshake=decodeDatagram(encodeDatagram(2,Uint8Array.of(2,1,127,0,0,1),p5.localPort!,5003,encodeTcpFrame(SYNACK,9,flow4!.srcId,TCP_WINDOW)))!;
        handshake.bindingGeneration=11;assert.equal(owner4.handle(handshake),true);
        const stopping4=owner4.closeListener();
        const bridge=(owner4 as unknown as {bridge:{abort:(e:Error)=>void;whenPhysicalClosed:()=>Promise<void>}}).bridge;
        bridge.abort(new Error("injected owned process death"));
        assert.equal(cap4.active,1);assert.equal(policy4.acquire("127.0.0.1",{},true),null);
        await bridge.whenPhysicalClosed();
        await stopping4;
        assert.equal(cap4.active,0);assert.equal(fail4,1);assert.equal(rst4,1);
        const release=policy4.acquire("127.0.0.1",{},true);assert(release);release();
        console.log("native accept owner process death retains ownership: ok");
    } finally {
        clearTimeout(timer4);p5?.destroy();owner4.close();await owner4.closeListener();
    }
    const cap5=new TcpHostCapacity(1),q5=new TcpAcceptQuota(cap5),reg5=new TcpHostRegistry(new NativeDestinationPolicy(),cap5);
    let owner5!:TcpAcceptHostOwner,reentrant=0,reentrantDone!:()=>void;
    const reentrantPromise=new Promise<void>(r=>reentrantDone=r);
    owner5=new TcpAcceptHostOwner(reg5,q5,executable,115,(bytes)=>{
        if(decodeTcpFrame(decodeDatagram(bytes)!.payload)?.kind===SYN){reentrant++;owner5.close();reentrantDone();}
        return true;
    });
    let p6:Socket|undefined;
    const timer5=setTimeout(()=>{process.exitCode=1;owner5.close();},10000);
    try {
        const opened=await owner5.open({id:"reentry",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",
            port:0,allowedHosts:["127.0.0.1"],maxOwners:1,maxPending:1},{localPort:5004,generation:12});
        owner5.activate();p6=connect(opened.address.port,"127.0.0.1");p6.on("error",()=>{});await once(p6,"connect");
        await reentrantPromise;await owner5.closeListener();
        assert.equal(reentrant,1);assert.equal(cap5.active,0);assert.equal(q5.activeCount,0);
        console.log("native accept owner reentrant SYN close: ok");
    } finally {
        clearTimeout(timer5);p6?.destroy();owner5.close();await owner5.closeListener();
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
