import {expect,test} from "bun:test";
import {createSocket,type Socket} from "node:dgram";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_UDP,decodeDatagram,encodeDatagram} from "../../src/worker/net/netplay-wire";
import {NativeDirectPlayHost} from "../../src/worker/modules/dpnet/native-wire/host";
import {NativeDirectPlayCore} from "../../src/worker/modules/dpnet/native-wire/core";
import {NativeReceiveWindow} from "../../src/worker/modules/dpnet/native-wire/receive-window";
import {DN,decodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {decodeNativeCoreConnectInfo} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import {decodeNativeCoreOperation} from "../../src/worker/modules/dpnet/native-wire/core-operations";
const node=Uint8Array.of(2,0,0,0,0,30);
const app={flags:0,maxPlayers:3,players:1,instance:"f0".repeat(16),application:"a1".repeat(16),name:"mesh",password:null,reserved:new Uint8Array(),applicationData:new Uint8Array()};
const until=async(predicate:()=>boolean)=>{const end=Date.now()+1500;while(!predicate()){if(Date.now()>end)throw Error("Real UDP mesh progress deadline");await Bun.sleep(1);}};
async function bind(socket:Socket,port=0){await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.bind(port,"127.0.0.1",()=>{socket.removeListener("error",reject);resolve();});});return socket.address().port;}
async function close(socket:Socket){await new Promise<void>(resolve=>{try{socket.close(()=>resolve());}catch{resolve();}});}
test("Host and two Core peers exchange six directions on real UDP with one source port each, then retain their surviving pair",async()=>{
 const sockets=[createSocket("udp4"),createSocket("udp4"),createSocket("udp4")],ports:number[]=[],nets=[0,1,2].map(()=>new LanNetwork(node));
 const host=new NativeDirectPlayHost(nets[0]),peers=[new NativeDirectPlayCore(nets[1],"peer",1000,20),new NativeDirectPlayCore(nets[2],"peer",1000,20)];
 const errors:string[]=[],physical:{from:number;to:number;sourcePort:number}[]=[],wire:{from:number;to:number;payload:Uint8Array}[]=[];
 const windows=new Map<string,NativeReceiveWindow>();let ended=false;
 try{
  for(const socket of sockets)ports.push(await bind(socket));
  for(const [r,socket] of sockets.entries()){
   socket.on("error",error=>{if(!ended)errors.push(String(error));});
   socket.on("message",(data,source)=>{
    const from=ports.indexOf(source.port);if(from<0||source.address!=="127.0.0.1"){errors.push("Foreign UDP source");return;}
    physical.push({from,to:r,sourcePort:source.port});
    const frame=decodeNativeProtocolFrame(data);
    if(frame?.kind==="data"){
     const key=source.port+":"+ports[r];let window=windows.get(key);if(!window){window=new NativeReceiveWindow();windows.set(key,window);}
     for(const message of window.receive(frame).messages)if(message.command&DN.USER1)wire.push({from,to:r,payload:message.payload});
    }
    // Same adapter, distinct process bindings: trusted broker self delivery.
    nets[r].receiveFrame(encodeDatagram(PROTO_UDP,node,ports[r],source.port,data),true);
   });
   nets[r].attach({routeLocal:true,send(frame){
    const dg=decodeDatagram(frame);if(!dg||dg.proto!==PROTO_UDP||dg.srcPort!==ports[r]||!dg.node.every((v,i)=>v===node[i])||!ports.includes(dg.dstPort)){errors.push("Invalid socket tuple");return false;}
    try{socket.send(dg.payload,dg.dstPort,"127.0.0.1",error=>{if(error&&!ended)errors.push(String(error));});return true;}catch(error){if(!ended)errors.push(String(error));return false;}
   },close(){}});
  }
  expect(host.start({port:ports[0],application:app,player:{name:"host",data:Uint8Array.of(0)},
   // Provider URL names the virtual adapter; this fixture carrier routes its
   // exact process ports over loopback. It is not a native Windows interop run.
   url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+[...nets[0].ipv4].join(".")+";port="+a.port,
   allowIncoming:a=>a.node.every((v,i)=>v===node[i])&&ports.slice(1).includes(a.port),
   admit:r=>({hr:0,data:Uint8Array.of(r.address.port===ports[1]?1:2)}),timeout:1000,retryInterval:20})).toBe(0);
  const desc={instance:app.instance,application:app.application,flags:0,maxPlayers:0,name:"",password:"",user:[0,0,0,0] as [number,number,number,number]};
  for(let r=1;r<=2;r++)expect(await peers[r-1].connect({node:[...node],port:ports[0]},desc,{name:{short:"peer"+r,long:""},data:[r],flags:0},new Uint8Array(),ports[r])).toBe(0);
  await until(()=>host.entities.size===3&&peers.every(p=>p.entities.size===3));
  const ids=[host.localId,...peers.map(p=>p.localId)],engines=[host,...peers];
  const op=(command:number,to:number)=>wire.filter(w=>w.from===0&&w.to===to&&w.payload.length>=4&&new DataView(w.payload.buffer,w.payload.byteOffset,w.payload.byteLength).getUint32(0,true)===command);
  const snapshot=decodeNativeCoreConnectInfo(op(0xc2,2)[0].payload)!;
  expect(snapshot.entries.map(e=>[e.name,e.version])).toEqual([["host",2],["peer1",3],["peer2",5]]);
  expect(decodeNativeCoreOperation(op(0xd0,1)[0].payload)).toMatchObject({id:ids[2],version:5});
  const c4=wire.filter(w=>w.from===1&&w.to===2&&w.payload.length===8&&new DataView(w.payload.buffer,w.payload.byteOffset,8).getUint32(0,true)===0xc4);
  expect(c4).toHaveLength(1);expect(decodeNativeCoreOperation(c4[0].payload)?.id).toBe(ids[1]);
  for(let from=0;from<3;from++)for(let to=0;to<3;to++)if(from!==to){
   const payload=Uint8Array.of(0x30,from,0,to);expect(await engines[from].sendDpn(ids[to],8,payload)).toBe(0);
   await until(()=>engines[to].queue.some(m=>m.from===ids[from]&&m.data.every((v,i)=>v===payload[i])));
  }
  for(let r=0;r<3;r++)expect(engines[r].queue.map(m=>m.from).sort()).toEqual(ids.filter((_,i)=>i!==r).sort());
  expect(new Set(physical.filter(p=>p.from===1&&p.to===2).map(p=>p.sourcePort))).toEqual(new Set([ports[1]]));
  expect(new Set(physical.filter(p=>p.from===1&&p.to===0).map(p=>p.sourcePort))).toEqual(new Set([ports[1]]));
  expect(await peers[1].shutdown()).toBe(0);await until(()=>host.entities.size===2&&peers[0].entities.size===2);
  expect(decodeNativeCoreOperation(op(0xd1,1)[0].payload)).toMatchObject({id:ids[2],version:7,reason:1});
  expect(await host.sendDpn(ids[1],8,Uint8Array.of(0x30,0,7))).toBe(0);
  expect(await peers[0].sendDpn(ids[0],8,Uint8Array.of(0x30,1,7))).toBe(0);
  expect(await peers[0].shutdown()).toBe(0);expect(await host.shutdown()).toBe(0);
  expect(host.pendingBytes).toBe(0);expect(host.retainedTableBytes).toBe(0);expect(errors).toEqual([]);
 }finally{
  ended=true;for(const peer of peers)peer.dispose();host.dispose();for(const network of nets)network.attach(null);
  for(const socket of sockets)await close(socket);
 }
 for(const port of ports){const probe=createSocket("udp4");try{expect(await bind(probe,port)).toBe(port);}finally{await close(probe);}}
},5000);
