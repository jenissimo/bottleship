import {expect,test} from "bun:test";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
import type {DirectPlay4NameTable,DirectPlay4PackedEntry} from "../../src/worker/modules/dplayx/native-wire/name-table";
function entry(id:number):DirectPlay4PackedEntry{return {id,flags:1,fixedSize:16,versionOrSystemId:14,version:14,
 shortName:Uint8Array.of(65,0,0,0),longName:null,spData:Uint8Array.of(2,3),playerData:Uint8Array.of(4),parentId:0,memberIds:[]};}
function fixture():DirectPlay4NameTable {
 const player=entry(1),group=entry(2),child=entry(3);group.memberIds=[1,9];child.parentId=2;
 return {command:41,version:14,sessionDescription:new Uint8Array(80),name:null,password:null,
 players:[player],groups:[group,child],shortcuts:[{id:2,flags:0,groupIds:[3]}]};
}
test("materializes independently owned identities, system reference and subgroup shortcut",()=>{
 const source=fixture(),owner=new DirectPlay4JoinNameTableOwner(source,[9],10,4096,()=>true);
 source.players[0].spData.fill(99);source.groups[0].memberIds[0]=99;
 const result=owner.commit()!;
 expect(result.players[0].spData).toEqual([2,3]);expect(result.groups[0].memberIds).toEqual([1,9]);
 expect(result.groups[1].parentId).toBe(2);expect(result.shortcuts[0].groupIds).toEqual([3]);
 expect(Object.isFrozen(result.players[0].spData)).toBe(true);expect(owner.commit()).toBeUndefined();
 owner.retire();expect(result.players[0].id).toBe(1);
});
test("local safety policy rejects duplicate and unresolved IDs and bounded allocation",()=>{
 const cases=[(x:DirectPlay4NameTable)=>x.groups[0].id=1,(x:DirectPlay4NameTable)=>x.groups[0].memberIds=[404],
  (x:DirectPlay4NameTable)=>x.groups[1].parentId=404,(x:DirectPlay4NameTable)=>x.shortcuts[0].groupIds=[404],
  (x:DirectPlay4NameTable)=>x.groups[0].memberIds=[1,1]];
 for(const change of cases){const x=fixture();change(x);expect(()=>new DirectPlay4JoinNameTableOwner(x,[9],10,4096,()=>true)).toThrow();}
 expect(()=>new DirectPlay4JoinNameTableOwner(fixture(),[9],3,4096,()=>true)).toThrow();
 expect(()=>new DirectPlay4JoinNameTableOwner(fixture(),[9],10,100,()=>true)).toThrow();
 expect(()=>new DirectPlay4JoinNameTableOwner(fixture(),[9],10,0x100001,()=>true)).toThrow();
 const malformed=fixture();(malformed.players[0] as any).spData=null;
 expect(()=>new DirectPlay4JoinNameTableOwner(malformed,[9],10,4096,()=>true)).toThrow();
});
test("existing system identity is merged once, arbitrary collisions remain errors",()=>{
 const x=fixture();const owner=new DirectPlay4JoinNameTableOwner(x,[1,9],10,4096,()=>true);
 const result=owner.commit()!;expect(result.players[0].preexisting).toBe(true);
 const wrong=fixture();wrong.players[0].flags=0;expect(()=>new DirectPlay4JoinNameTableOwner(wrong,[1,9],10,4096,()=>true)).toThrow();
 const duplicate=fixture();duplicate.players.push(entry(1));expect(()=>new DirectPlay4JoinNameTableOwner(duplicate,[1,9],10,4096,()=>true)).toThrow();
});
test("copy uses bounded indices and checks budget before access",()=>{
 const x=fixture();x.players[Symbol.iterator]=function*(){throw new Error("iterator called");};
 x.groups[0].memberIds[Symbol.iterator]=function*(){throw new Error("iterator called");};
 expect(new DirectPlay4JoinNameTableOwner(x,[9],10,4096,()=>true).commit()).toBeDefined();
 const big=fixture();big.groups[0].memberIds=new Array(1000);
 Object.defineProperty(big.groups[0].memberIds,0,{get(){throw new Error("read before charge");}});
 expect(()=>new DirectPlay4JoinNameTableOwner(big,[9],10,1024,()=>true)).toThrow("budget");
});
test("copy uses the originally budgeted lengths even if getters append",()=>{
 const x=fixture(),first=x.players[0];
 Object.defineProperty(x.players,0,{get(){x.players.push(entry(99));return first;},configurable:true});
 const members=x.groups[0].memberIds;
 Object.defineProperty(members,0,{get(){members.push(99);return 1;},configurable:true});
 const result=new DirectPlay4JoinNameTableOwner(x,[9],10,4096,()=>true).commit()!;
 expect(result.players.map(v=>v.id)).toEqual([1]);expect(result.groups[0].memberIds).toEqual([1,9]);
});
test("sparse records and IDs fail closed",()=>{
 for(const where of ["players","groups","shortcuts","members"]){
  const x=fixture();if(where==="members")x.groups[0].memberIds=new Array(1);
  else (x as any)[where]=new Array(1);
  expect(()=>new DirectPlay4JoinNameTableOwner(x,[9],10,4096,()=>true)).toThrow();
 }
});
test("retire and reentrant owner invalidation suppress atomic transfer",()=>{
 let owner!:DirectPlay4JoinNameTableOwner;
 owner=new DirectPlay4JoinNameTableOwner(fixture(),[9],10,4096,()=>{owner.retire();return true;});
 expect(owner.commit()).toBeUndefined();expect(owner.commit()).toBeUndefined();
 const revoked=new DirectPlay4JoinNameTableOwner(fixture(),[9],10,4096,()=>false);
 expect(revoked.commit()).toBeUndefined();expect(revoked.commit()).toBeUndefined();
});
