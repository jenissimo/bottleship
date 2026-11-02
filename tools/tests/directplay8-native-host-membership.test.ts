import {afterEach,expect,test} from "bun:test";
import fixture from "./fixtures/directplay8-native-mesh.json";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_UDP,decodeDatagram,encodeDatagram} from "../../src/worker/net/netplay-wire";
import {NativeDirectPlayHost,type NativeHostDecision} from "../../src/worker/modules/dpnet/native-wire/host";
import {NativeReliableLink} from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import {DN,decodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {decodeNativeCoreConnectInfo,encodeNativePlayerConnect} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import {decodeNativeCoreOperation,encodeNativePlayerAdded,nativeCoreWords} from "../../src/worker/modules/dpnet/native-wire/core-operations";
import {DPN} from "../../src/worker/modules/dpnet/constants";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0))close();});
const bytes=(hex:string)=>Uint8Array.from(Buffer.from(hex,"hex"));
const reference=decodeNativeCoreConnectInfo(bytes(fixture.messages.find(m=>m.core===0xc2&&m.target===2)!.payload))!;
const command=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0,true);
async function turns(){for(let n=0;n<12;n++)await Promise.resolve();}
async function until(check:()=>boolean){const end=Date.now()+400;while(!check()){if(Date.now()>end)throw Error("Host membership progress deadline");await Bun.sleep(1);}}
function scene(options:{maxPlayers?:number;autoC3?:boolean;decision?:(role:number)=>NativeHostDecision|Promise<NativeHostDecision>;returned?:(role:number)=>void|Promise<void>;onCreate?:(id:number)=>void;onWire?:(source:number,target:number,data:Uint8Array)=>void}={}){
 const nets=[0,1,2,3].map(i=>new LanNetwork(Uint8Array.of(2,0,0,0,0,10+i)));
 const messages:Uint8Array[][]=[[],[],[],[]],links:NativeReliableLink[]=[],events:string[]=[];
 let blocked=0;
 for(const [index,network] of nets.entries())network.attach({send(frame){const dg=decodeDatagram(frame)!,target=nets.findIndex(n=>n.node.every((v,i)=>v===dg.node[i]));if(target<0)return false;if(index===0&&target===blocked)return true;nets[target].receiveFrame(encodeDatagram(dg.proto,network.node,dg.dstPort,dg.srcPort,dg.payload));options.onWire?.(index,target,dg.payload);return true;},close(){}});
 const host=new NativeDirectPlayHost(nets[0]);
 const app={...reference.application,maxPlayers:options.maxPlayers??3};
 const start=()=>host.start({port:fixture.ports[0],application:app,player:{name:"host",data:Uint8Array.of(0)},
  url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0."+a.node[5]+";port="+a.port,
  allowIncoming:a=>nets.slice(1).some(n=>n.node.every((v,i)=>v===a.node[i])),timeout:500,retryInterval:20,
  admit:request=>{const role=request.address.node[5]-10;events.push("indicate"+role);return options.decision?.(role)??{hr:0,data:Uint8Array.of(role),context:role};},
  replyReleased:decision=>{const role=Number(decision.context);events.push("return"+role);return options.returned?.(role);},
  accepted:(id,context)=>{events.push("create"+context);options.onCreate?.(id);},
  aborted:context=>events.push("abort"+context)});
 const join=async(role:number)=>{
  const link=new NativeReliableLink({timeout:500,retryInterval:20,send:data=>nets[role].send(fixture.ports[role]??fixture.ports[2]+role-2,nets[0].node,fixture.ports[0],data,PROTO_UDP),
   onMessage:m=>{messages[role].push(m.payload.slice());if(m.command&DN.USER1&&command(m.payload)===0xc2&&options.autoC3!==false)void link.sendReliable(nativeCoreWords(0xc3));}});
  links[role]=link;
  expect(nets[role].bind(fixture.ports[role]??fixture.ports[2]+role-2,{deliver:dg=>link.receive(dg.data)},PROTO_UDP)).toBe(true);
  expect(await link.connect()).toBe(0);
  expect(await link.sendReliable(encodeNativePlayerConnect({flags:4,version:2,instance:app.instance,application:app.application,name:"peer"+role,data:Uint8Array.of(role),password:app.password,connectData:new Uint8Array(),url:null,alternate:new Uint8Array()}))).toBe(0);await turns();return link;
 };
 cleanup.push(()=>{host.dispose();for(const link of links)link?.close();for(const n of nets)n.attach(null);});
 return{host,nets,messages,links,events,start,join,block:(role:number)=>{blocked=role;},packets:(r:number,c:number)=>messages[r].filter(p=>p.length>=4&&command(p)===c),snapshot:(r:number)=>decodeNativeCoreConnectInfo(messages[r].find(p=>command(p)===0xc2)!)!};
}
test("native membership uses full newcomer C2 and versioned D0/C6 fanout, then D1 to survivors",async()=>{
 const s=scene();expect(s.start()).toBe(DPN.OK);expect(s.host.desc?.maxPlayers).toBe(3);
 await s.join(1);const first=s.snapshot(1);expect(first.version).toBe(3);expect(first.entries.map(e=>e.name)).toEqual(["host","peer1"]);
 await s.join(2);const second=s.snapshot(2);expect(second.version).toBe(5);expect(second.application.players).toBe(3);
 expect(second.entries.map(e=>[e.name,e.version])).toEqual([["host",2],["peer1",3],["peer2",5]]);
 const added=decodeNativeCoreOperation(s.packets(1,0xd0)[0])!;
 expect(added).toMatchObject({command:0xd0,id:second.localId,version:5,entry:{name:"peer2",url:second.entries[2].url}});
 expect(s.messages[1].map(command)).toEqual([0xc2,0xc6,0xd0,0xc6]);
 expect(decodeNativeCoreOperation(s.packets(1,0xc6)[1])).toMatchObject({id:second.localId,version:6});
 expect(decodeNativeCoreOperation(s.packets(2,0xc6)[0])).toMatchObject({id:second.localId,version:6});
 expect(s.packets(2,0xd0)).toHaveLength(0);
 expect(await s.links[2].shutdown()).toBe(0);await until(()=>s.packets(1,0xd1).length===1);
 expect(decodeNativeCoreOperation(s.packets(1,0xd1)[0])).toMatchObject({id:second.localId,version:7,reason:1});
 expect(s.host.entities.size).toBe(2);expect(s.host.currentPlayers).toBe(2);
 expect(await s.host.sendDpn(first.localId,8,Uint8Array.of(7,0,1))).toBe(0);
 expect(s.messages[1].at(-1)).toEqual(Uint8Array.of(7,0,1));
});
test("held reply and overlapping joins keep snapshot cutoff and per-peer operation sequence",async()=>{
 let returned!:()=>void;const s=scene({maxPlayers:4,returned:r=>r===1?new Promise<void>(resolve=>{returned=resolve;}):undefined});
 expect(s.start()).toBe(0);await s.join(1);
 expect(s.host.entities.size).toBe(1);expect(s.packets(1,0xc6)).toHaveLength(0);
 await s.join(2);const newer=s.snapshot(2);
 expect(newer.entries.map(e=>[e.name,e.version])).toEqual([["host",2],["peer1",3],["peer2",4]]);
 expect(s.snapshot(1).entries.map(e=>e.name)).toEqual(["host","peer1"]);
 returned();await turns();
 expect(s.packets(1,0xc2)).toHaveLength(1);
 expect(s.messages[1].map(command)).toEqual([0xc2,0xd0,0xc6,0xc6]);
 expect(s.messages[1].filter(p=>command(p)!==0xc2).map(p=>decodeNativeCoreOperation(p)!.version)).toEqual([4,5,6]);
 expect(s.messages[2].map(command)).toEqual([0xc2,0xc6,0xc6]);
 expect(s.host.entities.size).toBe(3);
 expect(await s.links[1].sendReliable(nativeCoreWords(0xc3))).toBe(0);await turns();
 expect(s.events.filter(e=>e==="create1")).toHaveLength(1);
});
test("whole Host Close from third-player CREATE cannot publish a stale C6 or retain held jobs",async()=>{
 let s:ReturnType<typeof scene>;s=scene({onCreate:()=>{if(s.host.entities.size===3)s.host.close();}});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);
 expect(s.host.desc).toBeNull();expect(s.host.peerCount).toBe(0);expect(s.host.pendingBytes).toBe(0);
 expect(s.packets(2,0xc6)).toHaveLength(0);expect(s.events.filter(e=>e==="return2")).toHaveLength(1);
 expect(s.nets[0].isBound(fixture.ports[0],PROTO_UDP)).toBe(false);
});

test("D0 writer matches the independently captured native PackEntryInfo bytes",()=>{
 const packet=bytes(fixture.messages.find(m=>m.core===0xd0)!.payload),entry=decodeNativeCoreOperation(packet)!.entry!;
 expect(encodeNativePlayerAdded(entry)).toEqual(packet);
});
test("INFO between C2 and C3 reaches a table-phase peer and preserves its next global version",async()=>{
 const s=scene({maxPlayers:2,autoC3:false});expect(s.start()).toBe(0);await s.join(1);
 expect(s.host.setInfo(s.host.localId,1,"changed",new Uint8Array())).toBe(0);await turns();
 expect(s.messages[1].map(command)).toEqual([0xc2,0xdb]);
 expect(decodeNativeCoreOperation(s.packets(1,0xdb)[0])).toMatchObject({version:4,name:"changed"});
 expect(await s.links[1].sendReliable(nativeCoreWords(0xc3))).toBe(0);await turns();
 expect(decodeNativeCoreOperation(s.packets(1,0xc6)[0])).toMatchObject({version:5});
});
test("local INFO return holds older-peer FIFO while a later snapshot contains the committed state",async()=>{
 const s=scene();expect(s.start()).toBe(0);await s.join(1);
 let returned!:(result?:number)=>void;s.host.onInfo=(_id,done)=>{returned=done;};
 expect(s.host.setInfo(s.host.localId,1,"pending-info",new Uint8Array())).toBe(0);
 await s.join(2);expect(s.snapshot(2).version).toBe(6);expect(s.snapshot(2).entries[0].name).toBe("pending-info");
 expect(s.messages[1].map(command)).toEqual([0xc2,0xc6]);expect(s.packets(2,0xdb)).toHaveLength(0);
 returned();await turns();expect(s.messages[1].map(command)).toEqual([0xc2,0xc6,0xdb,0xd0,0xc6]);
 expect(s.messages[1].slice(2).map(p=>decodeNativeCoreOperation(p)!.version)).toEqual([5,6,7]);
});
test("new entry and C2 are not committed when one existing recipient's real FIFO is full",async()=>{
 const releases=[0,0,0,0],s=scene({decision:r=>({hr:0,context:r,data:Uint8Array.of(r),release(){releases[r]++;}})});
 expect(s.start()).toBe(0);await s.join(1);const first=s.snapshot(1);
 s.block(1);const pending=Array.from({length:256},()=>s.host.sendDpn(first.localId,8,Uint8Array.of(9)));
 await s.join(2);expect(s.packets(2,0xc2)).toHaveLength(0);expect(s.packets(2,0xc5)).toHaveLength(1);
 expect(s.packets(1,0xd0)).toHaveLength(0);expect(s.host.currentPlayers).toBe(2);expect(s.host.entities.size).toBe(2);
 expect(releases[2]).toBe(1);
 s.block(0);expect(await Promise.all(pending)).toEqual(Array(256).fill(0));
 await s.join(3);expect(s.snapshot(3).version).toBe(5);expect(s.snapshot(3).entries.map(e=>e.name)).toEqual(["host","peer1","peer3"]);
});
test("full survivor FIFO does not undo a committed departure or close the surviving authority",async()=>{
 const s=scene();expect(s.start()).toBe(0);await s.join(1);await s.join(2);const first=s.snapshot(1),departing=s.snapshot(2).localId;
 s.block(1);const pending=Array.from({length:256},()=>s.host.sendDpn(first.localId,8,Uint8Array.of(9)));
 expect(await s.links[2].shutdown()).toBe(0);await until(()=>s.host.currentPlayers===2);
 // NT5 commits deletion before its worker; a refused D1 child is not a Host termination.
 expect(s.host.isHost).toBe(true);expect(s.host.entities.has(first.localId)).toBe(true);expect(s.host.entities.has(departing)).toBe(false);
 expect(s.host.peerCount).toBe(1);expect(s.packets(1,0xd1)).toHaveLength(0);
 expect(s.nets[0].isBound(fixture.ports[0],PROTO_UDP)).toBe(true);
 s.block(0);expect(await Promise.all(pending)).toEqual(Array(256).fill(0));
 await s.join(3);expect(s.snapshot(3).version).toBe(8);expect(s.snapshot(3).entries.map(e=>e.name)).toEqual(["host","peer1","peer3"]);
});
test("leaving during held reply still gives older peers a contiguous D0 then D1",async()=>{
 let returned!:()=>void;const s=scene({returned:r=>r===2?new Promise<void>(done=>{returned=done;}):undefined});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);expect(s.packets(1,0xd0)).toHaveLength(0);
 expect(await s.links[2].shutdown()).toBe(0);await turns();
 expect(s.packets(1,0xd0)).toHaveLength(0);expect(s.packets(1,0xd1)).toHaveLength(0);
 expect(s.host.retainedTableBytes).toBeGreaterThan(0);expect(s.host.currentPlayers).toBe(3);
 returned();await until(()=>s.packets(1,0xd1).length===1);
 expect(s.messages[1].map(command)).toEqual([0xc2,0xc6,0xd0,0xd1]);
 expect(s.messages[1].slice(2).map(p=>decodeNativeCoreOperation(p)!.version)).toEqual([5,6]);
 returned();await turns();expect(s.packets(1,0xd1)).toHaveLength(1);expect(s.events.filter(e=>e==="create2")).toHaveLength(0);
 expect(s.host.currentPlayers).toBe(2);
});
test("an admission still awaiting the application is not serialized as a phantom snapshot player",async()=>{
 let admit!:(decision:NativeHostDecision)=>void;
 const s=scene({maxPlayers:4,decision:r=>r===1?new Promise(done=>{admit=done;}):{hr:0,context:r}});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);
 expect(s.snapshot(2).entries.map(e=>e.name)).toEqual(["host","peer2"]);expect(s.snapshot(2).application.players).toBe(2);
 admit({hr:0,context:1});await turns();
 expect(s.snapshot(1).entries.map(e=>e.name)).toEqual(["host","peer2","peer1"]);expect(s.snapshot(1).application.players).toBe(3);
});
test("local observer failure closes authority without inventing a carrier loss D1",async()=>{
 let fail=true;const s=scene({onCreate:()=>{if(fail&&s.host.entities.size===3){fail=false;throw Error("observer");}}});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);await turns();
 const ops=s.messages[1].filter(p=>p.length>=4).map(p=>decodeNativeCoreOperation(p));
 expect(ops.slice(2).map(op=>[op!.command,op!.version])).toEqual([[0xd0,5]]);
 expect(s.host.currentPlayers).toBe(0);expect(s.host.isHost).toBe(false);
});

test("deferred departure remains in an overlapping snapshot and returns before D0 then D1",async()=>{
 let returned!:()=>void;const s=scene({maxPlayers:4,returned:r=>r===2?new Promise<void>(done=>{returned=done;}):undefined});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);expect(await s.links[2].shutdown()).toBe(0);await turns();
 await s.join(3);expect(s.snapshot(3).entries.map(e=>e.name)).toEqual(["host","peer1","peer2","peer3"]);
 expect(s.packets(1,0xd0)).toHaveLength(0);expect(s.packets(1,0xd1)).toHaveLength(0);
 returned();await until(()=>s.packets(1,0xd1).length===1);
 expect(s.messages[1].slice(2).map(p=>[command(p),decodeNativeCoreOperation(p)!.version])).toEqual([[0xd0,5],[0xd0,6],[0xc6,7],[0xd1,8]]);
 expect(s.packets(3,0xd1)).toHaveLength(1);expect(s.host.currentPlayers).toBe(3);
});
test("Close and restart while departure waits for RETURN_BUFFER cannot publish old membership in the new epoch",async()=>{
 let returned!:()=>void;const released=[0,0,0,0];const s=scene({returned:r=>r===2?new Promise<void>(done=>{returned=done;}):undefined,decision:r=>({hr:0,context:r,release(){released[r]++;}})});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);expect(await s.links[2].shutdown()).toBe(0);await turns();
 expect(s.packets(1,0xd0)).toHaveLength(0);s.host.close();expect(s.start()).toBe(0);const before=s.messages.map(m=>m.length);
 returned();await turns();expect(s.messages.map(m=>m.length)).toEqual(before);expect(s.host.entities.size).toBe(1);expect(s.host.pendingBytes).toBe(0);
 expect(released[2]).toBe(1);expect(s.events.filter(e=>e==="return2")).toHaveLength(1);
});
test("normal departure from inside CREATE observer does not publish C6 or D1 until observer return",async()=>{
 let s:ReturnType<typeof scene>,ending:Promise<number>|undefined;let inside=false;
 s=scene({onCreate:()=>{if(s.host.entities.size===3){inside=true;ending=s.links[2].shutdown();expect(s.packets(1,0xc6)).toHaveLength(1);expect(s.packets(1,0xd1)).toHaveLength(0);inside=false;}},
 onWire:(from,to,data)=>{const f=decodeNativeProtocolFrame(data);if(from===0&&to===1&&f?.kind==="data"&&(f.command&DN.USER1)&&f.payload.length>=4&&[0xc6,0xd1].includes(command(f.payload)))expect(inside).toBe(false);}});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);expect(await ending).toBe(0);await until(()=>s.packets(1,0xd1).length===1);
 expect(s.messages[1].slice(2).map(p=>[command(p),decodeNativeCoreOperation(p)!.version])).toEqual([[0xd0,5],[0xc6,6],[0xd1,7]]);
});
test("reentrant Host close and restart during first D0 send cancels remaining old recipients",async()=>{
 let s:ReturnType<typeof scene>,armed=false,restarted=-1;
 s=scene({maxPlayers:4,onWire:(from,to,data)=>{const f=decodeNativeProtocolFrame(data);if(armed&&from===0&&to===1&&f?.kind==="data"&&(f.command&DN.USER1)&&f.payload.length>=4&&command(f.payload)===0xd0){armed=false;s.host.close();restarted=s.start();}}});
 expect(s.start()).toBe(0);await s.join(1);await s.join(2);const old2=s.messages[2].length;armed=true;await s.join(3);await turns();
 expect(restarted).toBe(0);expect(s.messages[2]).toHaveLength(old2);expect(s.host.entities.size).toBe(1);expect(s.host.pendingBytes).toBe(0);
 expect(s.events.filter(e=>e==="return3")).toHaveLength(1);expect(s.events.filter(e=>e==="create3")).toHaveLength(0);
});
test("last-recipient refusal rolls back earlier D0 and newcomer C2 reservations",async()=>{
 const s=scene({maxPlayers:4});expect(s.start()).toBe(0);await s.join(1);await s.join(2);s.block(2);
 const second=s.snapshot(2),pending=Array.from({length:256},()=>s.host.sendDpn(second.localId,8,Uint8Array.of(9)));
 const before=s.host.pendingBytes;await s.join(3);expect(s.packets(3,0xc2)).toHaveLength(0);expect(s.packets(3,0xc5)).toHaveLength(1);
 expect(s.packets(1,0xd0)).toHaveLength(1);expect(s.host.pendingBytes).toBe(before);expect(s.host.currentPlayers).toBe(3);
 const unblocked=s.host.sendDpn(s.snapshot(1).localId,8,Uint8Array.of(10));await until(()=>s.messages[1].at(-1)?.[0]===10);expect(await unblocked).toBe(0);
 s.block(0);expect(await Promise.all(pending)).toEqual(Array(256).fill(0));
});
