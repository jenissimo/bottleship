import {createHash,randomBytes} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {packDirectPlayMessage} from "../../src/worker/modules/dplayx/network-api";
import {directPlay4GuestNotification} from "../../src/worker/modules/dplayx/native-wire/roster-projection";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
import {EmulatorConfig} from "../../src/worker/core/emulator-config-manager";
if(process.platform!=="win32"||(process.argv.length!==4&&process.argv.length!==5)||!(process.argv[4]===undefined||process.argv[4]==="ansi"||process.argv[4]==="ansi-cyr"))throw Error("usage: directplay4-join-capture NEW_DIR X86_GCC [ansi|ansi-cyr]");
const mode=process.argv[4]??"wide",wide=mode==="wide",cyr=mode==="ansi-cyr";
if(cyr)EmulatorConfig.getInstance().ansiCodePage=1251;
const dir=resolve(process.argv[2]),gcc=resolve(process.argv[3]);mkdirSync(dir,{recursive:false});
const source=resolve("tools/lan-conformance/directplay4-join-oracle.c"),runner=resolve(import.meta.filename),exe=join(dir,"directplay4-join-oracle.exe"),ready=join(dir,"host-ready.bin");
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const packer=resolve("src/worker/modules/dplayx/network-api.ts"),projection=resolve("src/worker/modules/dplayx/native-wire/roster-projection.ts"),owner=resolve("src/worker/modules/dplayx/native-wire/join-name-table-owner.ts");
const before={source:sha(source),runner:sha(runner),compiler:sha(gcc),packer:sha(packer),projection:sha(projection),owner:sha(owner)},nonce=randomBytes(4).readUInt32LE()||1;
const report:any={nonce,mode,before,status:"STARTED",children:[]};const save=()=>writeFileSync(join(dir,"result.json"),JSON.stringify(report,null,2)+"\n");save();
const env={Path:dirname(gcc)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
type Owned={pid:number;exit?:number;done:Promise<void>};
function start(role:string,args:string[]):Owned{
 const child=Bun.spawn(args,{cwd:dir,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),record:any={role,pid:child.pid,args};
 report.children.push(record);save();
 const drain=async(stream:ReadableStream<Uint8Array>,file:string)=>{const reader=stream.getReader(),parts:Uint8Array[]=[];let kept=0,total=0;
  for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;const n=Math.min(r.value.length,Math.max(0,1024*1024-kept));if(n){parts.push(r.value.slice(0,n));kept+=n;}}
  writeFileSync(file,Buffer.concat(parts));return {eof:true,total,kept,truncated:total!==kept,sha256:sha(file)};};
 const tracked:Owned={pid:child.pid,done:Promise.resolve()};
 const exit=child.exited.then(code=>{tracked.exit=code;record.exit=code;save();});
 tracked.done=Promise.all([exit,drain(child.stdout,join(dir,role+".stdout")),drain(child.stderr,join(dir,role+".stderr"))]).then(([,out,err])=>{
  record.stdout=out;record.stderr=err;save();
 });
 return tracked;
}
let host:Owned|undefined,client:Owned|undefined;
try{
 const version=start("compiler-version",[gcc,"--version"]);await version.done;if(version.exit!==0)throw Error("compiler version failed");
 const build=start("build",[gcc,"-O1","-o",exe,source,"-lole32","-ldxguid","-luuid"]);await build.done;if(build.exit!==0)throw Error("build failed");
 report.exeBefore=sha(exe);save();
 host=start("host",[exe,"host",String(nonce),ready,mode]);
 const deadline=Date.now()+17000;
 while(!existsSync(ready)){
  if(host.exit!==undefined)throw Error("host exited before READY");
  if(Date.now()>deadline)throw Error("host READY deadline");
  await new Promise(ok=>setTimeout(ok,25));
 }
 let marker:Buffer|undefined;
 while(!marker&&Date.now()<deadline){try{const data=readFileSync(ready);if(data.length===16)marker=data;}catch{}if(!marker)await new Promise(ok=>setTimeout(ok,25));}
 if(!marker||marker.readUInt32LE(0)!==0x4a345044||marker.readUInt32LE(4)!==nonce||marker.readUInt32LE(8)!==host.pid||!marker.readUInt32LE(12))throw Error("bad READY");
 report.ready={sha256:sha(ready),hostPid:host.pid,player:marker.readUInt32LE(12)};save();
 client=start("client",[exe,"client",String(nonce),ready,mode]);await client.done;
 report.hostAliveAtClientExit=host.exit===undefined;
 await host.done;
 if(client.exit!==0||host.exit!==0)throw Error("native helper failure");
 if(!report.hostAliveAtClientExit)throw Error("host exited before client");
 const hostText=readFileSync(join(dir,"host.stdout"),"utf8"),clientText=readFileSync(join(dir,"client.stdout"),"utf8");
 for(const text of ["OPEN_CREATE 00000000","CREATE_PLAYER 00000000","HOST_RECV 00000000","FLAGS own=00000008 remote=00000000 hr=00000000,00000000","HOST_SEND 00000000","DESTROY 00000000","CLOSE 00000000"])if(!hostText.includes(text))throw Error("missing host stage "+text);
 for(const text of ["ENUM 00000000 matches=1","OPEN_JOIN 00000000","CREATE_PLAYER 00000000","FLAGS own=00000008 remote=00000000 hr=00000000,00000000","CLIENT_SEND 00000000","CLIENT_RECV 00000000","DESTROY 00000000","CLOSE 00000000"])if(!clientText.includes(text))throw Error("missing client stage "+text);
 const remoteId=clientText.match(/CREATE_PLAYER 00000000 id=(\d+)/)?.[1],localId=String(report.ready.player);
 if(!remoteId||!new RegExp("SYSTEM to="+localId+" size=\\d+ type=00000003 subtype=00000001 id="+remoteId+"(?:\\r?\\n)").test(hostText)||
    !new RegExp("SYSTEM_AFTER to="+localId+" size=\\d+ type=00000005 subtype=00000001 id="+remoteId+"(?:\\r?\\n)").test(hostText))
  throw Error("native player lifecycle notifications mismatch");
 const systemId=[1,2,3].find(id=>id!==Number(localId)&&id!==Number(remoteId))!;
 const common={fixedSize:16,version:14,parentId:0,longName:null,playerData:new Uint8Array(),spData:new Uint8Array(),memberIds:[]};
 const system={...common,id:systemId,flags:1,versionOrSystemId:14,shortName:null};
 const player=(id:number,name:string,flags:number)=>({...common,id,flags,versionOrSystemId:systemId,shortName:Uint8Array.from(Buffer.from(name+"\0","utf16le"))});
 const shortName=cyr?"Игрок":"Client",longName=cyr?"Игрок Тест":"Client Long";
 const hostPlayer=player(Number(localId),"Host",12),guestPlayer={...player(Number(remoteId),shortName,8),longName:Uint8Array.from(Buffer.from(longName+"\0","utf16le")),playerData:Uint8Array.of(0x12,0x34,0x56,0x78)};
 const roster=(includeGuest:boolean)=>{const description=new Uint8Array(80);new DataView(description.buffer).setUint32(44,includeGuest?2:1,true);
  const source={command:41 as const,version:14,sessionDescription:description,name:null,password:null,players:[system,hostPlayer,...(includeGuest?[guestPlayer]:[])],groups:[],shortcuts:[]};
  return new DirectPlay4JoinNameTableOwner(source,[],4096,0x100000,()=>true).commit()!;};
 const withoutGuest=roster(false),withGuest=roster(true);
 report.packing=[];
 for(const type of [3,5] as const){
  const change=type===3?{kind:"create" as const,playerId:Number(remoteId),before:withoutGuest,after:withGuest}:{kind:"delete" as const,playerId:Number(remoteId),before:withGuest,after:withoutGuest};
  const base=0x2000,bytes=packDirectPlayMessage({from:0,to:Number(localId),data:new Uint8Array(),system:directPlay4GuestNotification(change)},base,2,wide);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),namePtr=view.getUint32(type===3?32:36,true),flags=view.getUint32(type===3?44:48,true);
  if(view.getUint32(0,true)!==type||view.getUint32(4,true)!==1||view.getUint32(8,true)!==Number(remoteId))throw Error("native guest message identity mismatch");
  const count=type===3?view.getUint32(12,true):0,offset=namePtr-base,datasize=view.getUint32(type===3?20:24,true),dataoffset=view.getUint32(type===3?16:20,true)-base,namesize=view.getUint32(type===3?24:28,true),longoffset=view.getUint32(type===3?36:40,true)-base,parent=view.getUint32(type===3?40:44,true);
  const expectedName=cyr?Buffer.from([0xc8,0xe3,0xf0,0xee,0xea,0]):Buffer.from("Client\0",wide?"utf16le":"latin1"),nameok=offset>=0&&offset+expectedName.length<=bytes.length&&Buffer.from(bytes.subarray(offset,offset+expectedName.length)).equals(expectedName)?1:0;
  const expectedLong=cyr?Buffer.from([0xc8,0xe3,0xf0,0xee,0xea,0x20,0xd2,0xe5,0xf1,0xf2,0]):Buffer.from("Client Long\0",wide?"utf16le":"latin1"),longok=longoffset>=0&&longoffset+expectedLong.length<=bytes.length&&Buffer.from(bytes.subarray(longoffset,longoffset+expectedLong.length)).equals(expectedLong)?1:0;
  const expectedData=Buffer.from([0x12,0x34,0x56,0x78]),dataok=dataoffset>=0&&dataoffset+expectedData.length<=bytes.length&&Buffer.from(bytes.subarray(dataoffset,dataoffset+expectedData.length)).equals(expectedData)?1:0;
  const detail="SYSTEM_DETAIL type="+type+" size="+bytes.length+" count="+count+" flags="+flags.toString(16).padStart(8,"0")+" shortoffset="+offset+" nameok="+nameok+" datasize="+datasize+" dataoffset="+dataoffset+" dataok="+dataok+" namesize="+namesize+" longoffset="+longoffset+" longok="+longok+" parent="+parent;
  if(!hostText.includes(detail))throw Error("native guest message packing mismatch: "+detail);
  report.packing.push({type,size:bytes.length,count,flags,offset,nameok,datasize,dataoffset,dataok,namesize,longoffset,longok,parent});
 }
 report.after={source:sha(source),runner:sha(runner),compiler:sha(gcc),packer:sha(packer),projection:sha(projection),owner:sha(owner),exe:sha(exe)};
 if(report.after.source!==before.source||report.after.runner!==before.runner||report.after.compiler!==before.compiler||report.after.packer!==before.packer||report.after.projection!==before.projection||report.after.owner!==before.owner||report.after.exe!==report.exeBefore)throw Error("inputs changed");
 report.status="OBSERVED";
}catch(e){report.status="FAILED";report.error=String(e);}
finally{
 // Each owned helper has a 25-second self-watchdog. Never discard an owned
 // process handle merely because readiness or observation failed.
 if(client)await client.done;if(host)await host.done;save();
}
if(report.status!=="OBSERVED")throw Error(report.error);console.log(JSON.stringify({nonce,status:report.status}));
