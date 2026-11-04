import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {decodeDirectPlay4CreatePlayer} from "../../src/worker/modules/dplayx/native-wire/create-message";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
import {DirectPlay4GuestNotificationOwner} from "../../src/worker/modules/dplayx/native-wire/guest-notification-owner";
import {directPlay4HostSystemMatches} from "../../src/worker/modules/dplayx/native-wire/host-system-authorization";
import {DirectPlaySession,DP} from "../../src/worker/modules/dplayx/session";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {packDirectPlayMessage} from "../../src/worker/modules/dplayx/network-api";
import {projectDirectPlay4RemotePlayers as project,projectDirectPlay4RosterChange as projectChange,directPlay4GuestNotification,directPlay4GuestEntity,installDirectPlay4GuestRoster} from "../../src/worker/modules/dplayx/native-wire/roster-projection";
const sample=JSON.parse(readFileSync(new URL("./fixtures/dp4-native-pending-create.json",import.meta.url),"utf8"));
const system={id:6,flags:1,fixedSize:16,versionOrSystemId:14,version:14,parentId:0,shortName:null,longName:null,spData:new Uint8Array(),playerData:new Uint8Array(),memberIds:[]};
function fixture(){
 const bytes=Uint8Array.from(sample.bytes as number[]),view=new DataView(bytes.buffer);view.setUint32(12,5,true);view.setUint32(36,5,true);view.setUint32(60,6,true);
 const late=decodeDirectPlay4CreatePlayer(bytes,65536).player,host={...late,id:4,flags:12,shortName:Uint8Array.of(72,0,111,0,115,0,116,0,0,0)};
 const table={command:41 as const,version:14,sessionDescription:new Uint8Array(80),name:null,password:null,players:[system,host,late],groups:[],shortcuts:[]};
 return new DirectPlay4JoinNameTableOwner(table,[],4096,0x100000,()=>true).commit()!;
}
test("host authorization requires the single observed remote system and its players",()=>{
 const original=fixture(),system={...original.players[0],flags:15},host=original.players[1],table={...original,players:[system,host,original.players[2]]};
 expect(directPlay4HostSystemMatches(table,6)).toBe(true);
 expect(directPlay4HostSystemMatches(table,7)).toBe(false);
 expect(directPlay4HostSystemMatches({...table,version:13},6)).toBe(false);
 expect(directPlay4HostSystemMatches({...table,players:[system,{...host,flags:4},table.players[2]]},6)).toBe(false);
 expect(directPlay4HostSystemMatches({...table,players:[system,host,{...host,id:7}]},6)).toBe(true);
 expect(directPlay4HostSystemMatches({...table,players:[system,{...system,id:7},host]},6)).toBe(false);
 expect(directPlay4HostSystemMatches({...table,players:[{...system,preexisting:true},host]},6)).toBe(false);
 expect(directPlay4HostSystemMatches({...table,players:[system,{...host,versionOrSystemId:7}]},6)).toBe(false);
});
test("normal native remote players project host and ordinary wire flags to guest values",()=>{
 const out=project(fixture());
 expect(out.map(p=>[p.id,p.systemPlayerId,p.shortName,p.flags])).toEqual([[4,6,"Host",0],[5,6,"Late",0]]);
 expect(out[1].longNull).toBe(true);expect(Object.isFrozen(out)).toBe(true);expect(Object.isFrozen(out[1].data)).toBe(true);
});
test("staged remote player create and destroy preserve the native notification type and player",()=>{
 const after=fixture(),before={...after,players:after.players.filter(p=>p.id!==5)};
 const created=projectChange({kind:"create",playerId:5,before,after});
 const deleted=projectChange({kind:"delete",playerId:5,before:after,after:before});
 expect([created.type,created.player.id,created.player.shortName,created.player.flags]).toEqual([3,5,"Late",0]);
 expect([deleted.type,deleted.player.id,deleted.player.shortName,deleted.player.flags]).toEqual([5,5,"Late",0]);
 const guest=directPlay4GuestNotification({kind:"create",playerId:5,before,after});
 expect(guest).toEqual({type:3,currentPlayers:0,entity:{id:5,group:false,owner:"native:6",flags:0,name:{short:"Late",long:"",shortNull:false,longNull:true},data:[],members:[],parent:0,groupOwner:0}});
 guest.entity!.data.push(9);expect(directPlay4GuestNotification({kind:"create",playerId:5,before,after}).entity!.data).toEqual([]);
 expect(()=>projectChange({kind:"delete",playerId:4,before:after,after:before})).toThrow();
 const altered={...before,players:before.players.map(p=>p.id===4?{...p,flags:8}:p)};
 // Host and ordinary players both project to the same public flags; changing a
 // visible value in another player must still reject the compound transition.
 const wrong={...altered,players:altered.players.map(p=>p.id===4?{...p,shortName:[88,0,0,0]}:p)};
 expect(()=>projectChange({kind:"create",playerId:5,before:wrong,after})).toThrow();
});
test("native roster installation checks the complete batch and exact session owner",()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,6));network.attach({send:()=>true,close(){}});const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:8,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const table=fixture(),collision=directPlay4GuestEntity(project(table)[1]);session.entities.set(collision.id,collision);
  expect(()=>installDirectPlay4GuestRoster(session,table,()=>true)).toThrow();
  expect([...session.entities.keys()]).toEqual([collision.id]);
  session.entities.clear();
  expect(()=>installDirectPlay4GuestRoster(session,table,()=>{session.close();return true;})).toThrow();
  expect(session.entities.size).toBe(0);
  expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:8,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  let attempted=false;
  installDirectPlay4GuestRoster(session,table,()=>{
   if(!attempted){attempted=true;expect(()=>installDirectPlay4GuestRoster(session,table,()=>true)).toThrow();}
   return true;
  });
  expect(attempted).toBe(true);expect([...session.entities.keys()]).toEqual([4,5]);expect(session.entities.get(4)?.name.short).toBe("Host");
 }finally{session.dispose();network.attach(null);}
});
test("native roster changes and notifications commit together, and a full queue preserves the roster",async()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,5));network.attach({send:()=>true,close(){}});const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:8,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const local=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"local",long:""},data:[],flags:0,parent:0});
  while(session.queue.length)session.removeMessage(0);
  const after=fixture(),before={...after,players:after.players.filter(p=>p.id!==5)};
  installDirectPlay4GuestRoster(session,before,()=>true);
  const owner=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{}),created={kind:"create" as const,playerId:5,before,after};
  for(let i=0;i<4096;i++)expect(session.enqueueSystem(local.id!,{type:0x104})).toBe(true);
  expect(owner.applyRosterChange(local.id!,created)).toBe(false);expect(session.entities.has(5)).toBe(false);
  while(session.queue.length)session.removeMessage(0);
  let observed=false;session.onMessage=()=>{observed=session.entities.has(5)&&session.queue.length===1;};
  expect(owner.applyRosterChange(local.id!,created)).toBe(true);expect(observed).toBe(true);expect(session.entities.has(5)).toBe(true);
  session.entities.get(5)!.name.short="changed";expect(session.queue[0].system!.entity!.name.short).toBe("Late");session.entities.get(5)!.name.short="Late";
  session.onMessage=undefined;session.removeMessage(0);
  expect(owner.applyRosterChange(local.id!,{kind:"delete",playerId:5,before:after,after:before})).toBe(true);expect(session.entities.has(5)).toBe(false);
  session.removeMessage(0);let uncertain=0;
  const retiring=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{uncertain++;});
  session.onMessage=()=>retiring.close();expect(()=>retiring.applyRosterChange(local.id!,created)).toThrow();
  expect(uncertain).toBe(1);expect(session.entities.has(5)).toBe(true);expect(session.queue).toHaveLength(1);
 }finally{session.dispose();network.attach(null);}
});
test("native roster fan-out reserves every local notification before updating",async()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,9));network.attach({send:()=>true,close(){}});const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:8,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const a=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"a",long:""},data:[],flags:0,parent:0});
  const b=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"b",long:""},data:[],flags:0,parent:0});
  while(session.queue.length)session.removeMessage(0);
  const after=fixture(),before={...after,players:after.players.filter(p=>p.id!==5)},change={kind:"create" as const,playerId:5,before,after};
  installDirectPlay4GuestRoster(session,before,()=>true);
  const owner=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{});
  expect(()=>owner.applyRosterChanges([a.id!,a.id!],change)).toThrow();
  expect(()=>owner.applyRosterChanges([a.id!,99],change)).toThrow();
  for(let i=0;i<4095;i++)expect(session.enqueueSystem(a.id!,{type:0x104})).toBe(true);
  expect(owner.applyRosterChanges([a.id!,b.id!],change)).toBe(false);expect(session.entities.has(5)).toBe(false);expect(session.queue.length).toBe(4095);
  while(session.queue.length)session.removeMessage(0);
  const events:number[]=[];session.onMessage=id=>{expect(session.entities.has(5)).toBe(true);expect(session.queue.length).toBe(2);events.push(id);};
  expect(owner.applyRosterChanges([a.id!,b.id!],change)).toBe(true);expect(events).toEqual([a.id!,b.id!]);
  expect(session.queue.map(x=>x.to)).toEqual([a.id!,b.id!]);
  session.queue[0].system!.entity!.name.short="changed";expect(session.queue[1].system!.entity!.name.short).toBe("Late");
  session.onMessage=undefined;while(session.queue.length)session.removeMessage(0);
  expect(owner.applyRosterChanges([a.id!,b.id!],{kind:"delete",playerId:5,before:after,after:before})).toBe(true);
  expect(session.queue.map(x=>[x.to,x.system!.type])).toEqual([[a.id!,5],[b.id!,5]]);
  while(session.queue.length)session.removeMessage(0);expect(owner.applyRosterChanges([],change)).toBe(true);
  let uncertain=0;const seen:number[]=[];
  const retiring=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{uncertain++;});
  session.onMessage=id=>{seen.push(id);retiring.close();};
  expect(()=>retiring.applyRosterChanges([b.id!,a.id!],{kind:"delete",playerId:5,before:after,after:before})).toThrow();
  expect(uncertain).toBe(1);expect(seen).toEqual([a.id!]);expect(session.entities.has(5)).toBe(false);expect(session.queue.length).toBe(2);
  session.onMessage=undefined;while(session.queue.length)session.removeMessage(0);
  const noRecipients=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{});
  expect(noRecipients.applyRosterChanges([],change)).toBe(true);expect(session.entities.has(5)).toBe(true);expect(session.queue.length).toBe(0);
 }finally{session.dispose();network.attach(null);}
});
test("guest queue preserves the event-time count and projected player through packing",async()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,1));network.attach({send:()=>true,close(){}});
 const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);
  expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:4,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const local=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"local",long:""},data:[],flags:0,parent:0});
  expect(local.hr).toBe(DP.OK);while(session.queue.length)session.removeMessage(0);
  const original=fixture(),description=Uint8Array.from(original.sessionDescription);new DataView(description.buffer).setUint32(44,2,true);
  const after={...original,sessionDescription:[...description]},before={...after,players:after.players.filter(p=>p.id!==5)};
  const message=directPlay4GuestNotification({kind:"create",playerId:5,before,after});
  expect(session.enqueueSystem(local.id!,message)).toBe(true);expect(session.currentPlayers).toBe(1);
  const packed=packDirectPlayMessage(session.queue[0],0x2000,session.currentPlayers,true),view=new DataView(packed.buffer);
  expect([view.getUint32(0,true),view.getUint32(4,true),view.getUint32(8,true),view.getUint32(12,true)]).toEqual([3,1,5,2]);
  const offset=view.getUint32(32,true)-0x2000;expect(Buffer.from(packed.subarray(offset)).toString("utf16le")).toBe("Late\0");
 }finally{session.dispose();network.attach(null);}
});
test("guest queue accepts copied native player data only for a known remote sender and local recipient",async()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,8));network.attach({send:()=>true,close(){}});const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:4,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const local=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"local",long:""},data:[],flags:0,parent:0});expect(local.hr).toBe(DP.OK);
  while(session.queue.length)session.removeMessage(0);const remote=directPlay4GuestEntity(project(fixture())[0]);session.entities.set(remote.id,remote);
  const bytes=Uint8Array.of(4,5,6);expect(session.enqueueNativePlayer(remote.id,local.id!,bytes)).toBe(true);bytes.fill(0);
  expect([...session.queue[0].data]).toEqual([4,5,6]);expect(session.queue[0].from).toBe(remote.id);expect(session.queue[0].to).toBe(local.id);
  expect(session.enqueueNativePlayer(99,local.id!,bytes)).toBe(false);expect(session.enqueueNativePlayer(remote.id,99,bytes)).toBe(false);
  expect(session.enqueueNativePlayer(local.id!,local.id!,bytes)).toBe(false);expect(session.queue).toHaveLength(1);
  session.removeMessage(0);const original=Uint8Array.of(7,8,9);let uncertain=0;
  const owner=new DirectPlay4GuestNotificationOwner(session,()=>{original.fill(0);return true;},()=>{uncertain++;});
  expect(owner.deliverPlayer(remote.id,local.id!,original)).toBe(true);expect([...session.queue[0].data]).toEqual([7,8,9]);
  session.removeMessage(0);expect(()=>owner.deliverPlayer(99,local.id!,Uint8Array.of(1))).toThrow();expect(uncertain).toBe(0);
  session.onMessage=()=>owner.close();expect(()=>owner.deliverPlayer(remote.id,local.id!,Uint8Array.of(2))).toThrow();expect(uncertain).toBe(1);expect(session.queue).toHaveLength(1);
 }finally{session.dispose();network.attach(null);}
});
test("guest notification owner fences recipient, queue refusal and reentrant retirement",async()=>{
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,7));network.attach({send:()=>true,close(){}});const session=new DirectPlaySession(network);
 try{
  expect(session.initialize()).toBe(DP.OK);expect(session.create({application:"1".repeat(32),instance:"0".repeat(32),flags:0,maxPlayers:4,name:"",password:"",user:[0,0,0,0]})).toBe(DP.OK);
  const local=await session.mutate({op:"mutate",action:"create",group:false,name:{short:"local",long:""},data:[],flags:0,parent:0});expect(local.hr).toBe(DP.OK);
  while(session.queue.length)session.removeMessage(0);
  const after=fixture(),before={...after,players:after.players.filter(p=>p.id!==5)},change={kind:"create" as const,playerId:5,before,after};
  let valid=true,uncertain=0;const owner=new DirectPlay4GuestNotificationOwner(session,()=>valid,()=>{uncertain++;});
  expect(()=>owner.deliver(999,change)).toThrow();
  expect(()=>owner.deliver(local.id!,{...change,playerId:local.id!})).toThrow();expect(uncertain).toBe(0);
  valid=false;expect(()=>owner.deliver(local.id!,change)).toThrow();valid=true;
  for(let i=0;i<4096;i++)expect(session.enqueueSystem(local.id!,{type:0x104})).toBe(true);
  expect(owner.deliver(local.id!,change)).toBe(false);expect(uncertain).toBe(0);
  while(session.queue.length)session.removeMessage(0);
  session.onMessage=()=>owner.close();expect(()=>owner.deliver(local.id!,change)).toThrow();
  expect(uncertain).toBe(1);expect(session.queue).toHaveLength(1);expect(()=>owner.deliver(local.id!,change)).toThrow();
  while(session.queue.length)session.removeMessage(0);
  let failures=0;const throwing=new DirectPlay4GuestNotificationOwner(session,()=>true,()=>{failures++;throw Error("retirement callback failed");});
  session.onMessage=()=>{throw Error("event failed");};expect(()=>throwing.deliver(local.id!,change)).toThrow("event failed");
  expect(failures).toBe(1);expect(session.queue).toHaveLength(1);expect(()=>throwing.deliver(local.id!,change)).toThrow();expect(failures).toBe(1);
 }finally{session.dispose();network.attach(null);}
});
test("unsupported flags, malformed names, groups and foreign system owners fail closed",()=>{
 const table=fixture(),host=table.players[1];
 for(const bad of [
  {...host,flags:0x108},{...host,shortName:[65,0]},{...host,shortName:[65,0,0,0,66,0]},
  {...host,versionOrSystemId:99},{...host,playerData:new Array(60001).fill(1)},
 ]){
  expect(()=>project({...table,players:[table.players[0],bad]})).toThrow();
 }
 expect(()=>project({...table,groups:[table.players[1]]})).toThrow();
});
