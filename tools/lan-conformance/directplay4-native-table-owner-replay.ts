import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {decodeDirectPlay4NameTable} from "../../src/worker/modules/dplayx/native-wire/name-table";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
const [input,output]=process.argv.slice(2);if(!input||!output||process.argv.length!==4)throw Error("usage: result.json output.json");
const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const before={input:sha(input),runner:sha(import.meta.filename),decoder:sha("src/worker/modules/dplayx/native-wire/name-table.ts"),owner:sha("src/worker/modules/dplayx/native-wire/join-name-table-owner.ts")};
const evidence=JSON.parse(readFileSync(input,"utf8"));const frame=evidence.report.nativeFrames.find((x:any)=>x.command===41);
if(!frame)throw Error("missing native cmd41");const table=decodeDirectPlay4NameTable(Uint8Array.from(frame.message),65536,4096),id=evidence.report.exchange.playerId;
const instance=Buffer.from(table.sessionDescription.subarray(8,24)).toString("hex"),application=Buffer.from(table.sessionDescription.subarray(24,40)).toString("hex");if(instance!==evidence.report.hostReady.instance)throw Error("native session instance mismatch");
const result:any={input:before,systemId:id,playerIds:table.players.map(p=>p.id),playerFlags:table.players.map(p=>p.flags),instance,application,groups:table.groups.length,shortcuts:table.shortcuts.length,nativeCmd:frame.command};for(const existing of [[],[id]]){try{const owner=new DirectPlay4JoinNameTableOwner(table,existing,4096,1048576,()=>true);const snapshot=owner.commit();result[existing.length?"withExisting":"withoutExisting"]={success:!!snapshot,players:snapshot?.players.length};}catch(e){result[existing.length?"withExisting":"withoutExisting"]={success:false,error:String(e)};}}
const after={input:sha(input),runner:sha(import.meta.filename),decoder:sha("src/worker/modules/dplayx/native-wire/name-table.ts"),owner:sha("src/worker/modules/dplayx/native-wire/join-name-table-owner.ts")};result.after=after;
if(JSON.stringify(before)!==JSON.stringify(after))throw Error("input changed");writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
