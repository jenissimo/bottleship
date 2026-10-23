import {test,expect} from "bun:test";
import {createSocket,type Socket as UdpSocket} from "node:dgram";
import {createLanServer} from "../../packages/lan/src/server";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error("Namespace Host control deadline");await pause(2);}}
for(const transport of ["websocket","polling"]as const)test("physical Host lease control crosses an authenticated child namespace, "+transport,async()=>{
 const server=createLanServer({port:0,transports:[transport]}),allowedNodes=[[2,1,127,0,0,1]];
 const opens:any[]=[],leases=new Map<number,{socket:UdpSocket;requestId:number;port:number;end(code?:number):Promise<void>}>();
 let next=0,connections=0,payloads=0;
 server.io.use((socket,next)=>{
  socket.onAnyOutgoing((event,...args)=>{if(event==="ready")args[0].udpHostListenV1={listeners:[{id:"game",allowedNodes}]};});
  next();
 });
 server.io.on("connection",socket=>{
  connections++;
  socket.on("openUdpHost",(requestId,request)=>{
   opens.push({requestId,request});const udp=createSocket("udp4");udp.on("error",()=>{});udp.on("message",()=>payloads++);
   udp.bind(0,"127.0.0.1",()=>{
    const leaseId=++next,port=udp.address().port;let ended=false;
    const lease={socket:udp,requestId,port,end:async(code?:number)=>{
     if(ended)return;ended=true;leases.delete(leaseId);await new Promise<void>(resolve=>udp.close(()=>resolve()));
     if(code)socket.emit("udpHostClosed",requestId,leaseId,{code,message:"test listener retired"});
    }};leases.set(leaseId,lease);
    socket.emit("udpHostOpened",requestId,{leaseId,address:{node:[2,1,127,0,0,1],port},allowedNodes});
   });
  });
  socket.on("releaseUdpHost",id=>{void leases.get(id)?.end();});
  socket.on("cancelUdpHost",id=>{for(const lease of leases.values())if(lease.requestId===id)void lease.end();});
 });
 const port=await server.listen(),network=new LanNetwork(),root=new RootNetworkNamespace(network,16,92001);
 const childBoot=root.createChild(92002),childNet=new LanNetwork(),child=new ChildProcessNetworkNamespace(childNet,childBoot.boot);
 const a={deliver(){}},b={deliver(){}};
 try{
  const config={serverUrl:"http://127.0.0.1:"+port,room:"host-control",directPlay8:{provider:"native"as const,hostListener:"game"}};
  await root.configure(config);await until(()=>childNet.connected);
  expect(childNet.directPlay8).toEqual(config.directPlay8);expect(network.directPlay8).toEqual(config.directPlay8);
  expect(childNet.udpHostListenV1?.listeners).toEqual([{id:"game",allowedNodes}]);
  expect(network.bind(47126,a,1)).toBe(true);expect(childNet.bind(47127,b,1)).toBe(true);await child.barrier();
  const rootLease=await network.openUdpHost(47126,"game"),childLease=await childNet.openUdpHost(47127,"game");
  expect(opens.map(r=>r.request.localPort)).toEqual([47126,47127]);expect(connections).toBe(1);expect(payloads).toBe(0);
  expect(rootLease.address.port).toBeGreaterThan(0);expect(childLease.address.port).not.toBe(rootLease.address.port);
  const count=opens.length;
  const foreign=await child.openUdpHost({proto:1,localPort:47126,bindingGeneration:network.bindingGeneration(47126,1),listenerId:"game"}).then(()=>null,error=>error);
  expect(foreign).toMatchObject({code:10022});
  expect(opens).toHaveLength(count);
  await leases.get(2)!.end(10054);expect((await childLease.closed).code).toBe(10054);expect(childLease.isLive()).toBe(false);
  expect(rootLease.isLive()).toBe(true);expect(network.connected).toBe(true);expect(childNet.connected).toBe(true);
  rootLease.release();rootLease.release();await until(()=>leases.size===0);
  for(const localPort of [rootLease.address.port,childLease.address.port]){
   const rebound=createSocket("udp4");await new Promise<void>((resolve,reject)=>{rebound.once("error",reject);rebound.bind(localPort,"127.0.0.1",()=>resolve())});
   await new Promise<void>(resolve=>rebound.close(()=>resolve()));
  }
 }finally{
  child.close();childBoot.close();network.unbind(47126,a,1);await root.close();
  for(const lease of [...leases.values()])await lease.end();await server.close();
 }
},15000);
