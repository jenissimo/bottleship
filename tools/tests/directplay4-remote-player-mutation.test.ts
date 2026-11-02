import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
import {applyDirectPlay4RemotePlayerMutation as apply} from "../../src/worker/modules/dplayx/native-wire/remote-player-mutation";
const sample=JSON.parse(readFileSync(new URL("./fixtures/dp4-native-pending-create.json",import.meta.url),"utf8"));
const peer={family:2,node:Uint8Array.of(2,1,192,0,2,7),ip:Uint8Array.of(192,0,2,7),port:2300};
const entry={id:6,flags:1,fixedSize:16,versionOrSystemId:14,version:14,parentId:0,shortName:null,longName:null,spData:new Uint8Array(),playerData:new Uint8Array(),memberIds:[]};
const roster=()=>new DirectPlay4JoinNameTableOwner({command:41,version:14,sessionDescription:new Uint8Array(80),name:null,password:null,players:[entry],groups:[],shortcuts:[]},[],4096,0x100000,()=>true).commit()!;
const create=()=>{const b=Uint8Array.from(sample.bytes as number[]),v=new DataView(b.buffer);v.setUint32(12,5,true);v.setUint32(36,5,true);v.setUint32(60,6,true);return b;};
const remove=()=>{const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,5,true);return b;};
test("remote roster create and delete preserve immutable snapshots and authorize the source",()=>{
 const before=roster(),seen:number[]=[];
 const added=apply(before,create(),peer,(id,source,system)=>{seen.push(id,system,...source.ip!);return true;},()=>true);
 expect(before.players).toHaveLength(1);expect(added.players.map(p=>p.id)).toEqual([6,5]);
 expect(seen).toEqual([5,6,192,0,2,7]);expect(new DataView(Uint8Array.from(added.sessionDescription).buffer).getUint32(44,true)).toBe(1);
 const deleted=apply(added,remove(),peer,()=>true,()=>true);
 expect(added.players).toHaveLength(2);expect(deleted.players.map(p=>p.id)).toEqual([6]);
 expect(new DataView(Uint8Array.from(deleted.sessionDescription).buffer).getUint32(44,true)).toBe(0);
});
test("remote mutations fail closed on duplicate, authorization, provenance and roster budget",()=>{
 const before=roster(),added=apply(before,create(),peer,()=>true,()=>true);
 expect(()=>apply(added,create(),peer,()=>true,()=>true)).toThrow();
 expect(()=>apply(before,create(),peer,()=>false,()=>true)).toThrow();
 expect(()=>apply(before,create(),{...peer,ip:Uint8Array.of(1,2,3,4)},()=>true,()=>true)).toThrow();
 expect(()=>apply(before,create(),peer,()=>true,()=>true,80)).toThrow();
 let live=true;expect(()=>apply(before,create(),peer,()=>{live=false;return true;},()=>live)).toThrow();
 expect(()=>apply(before,remove(),peer,()=>true,()=>true)).toThrow();
});
