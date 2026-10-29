import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native reference coordinator. It never kills a process or manipulates a
// system service. A deadline violation remains owned and visibly pending.
if (process.platform !== "win32") throw Error("Windows native reference required");
const usage = "Usage: bun tools/lan-conformance/capture-directplay4-discovery.ts --proof NEW_DIR --compiler X86_GCC --nonce DWORD --case match|mismatch";
const cli = new Map<string,string>(), argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    if (!["--proof","--compiler","--nonce","--case"].includes(argv[i]) || !argv[i+1] ||
        argv[i+1].startsWith("--") || cli.has(argv[i])) throw Error(usage);
    cli.set(argv[i],argv[i+1]);
}
if (cli.size !== 4 || !/^[0-9]+$/.test(cli.get("--nonce")!)) throw Error(usage);
const nonce=Number(cli.get("--nonce")), scenario=cli.get("--case")!;
if (!Number.isInteger(nonce) || nonce < 1 || nonce > 0xffffffff || !["match","mismatch"].includes(scenario)) throw Error(usage);
const root=resolve(cli.get("--proof")!), compiler=resolve(cli.get("--compiler")!);
if (existsSync(root)) throw Error("Proof directory already exists; evidence is immutable");
mkdirSync(root);
const source=join(dirname(fileURLToPath(import.meta.url)),"directplay4-discovery.c");
const exe=join(root,"directplay4-discovery.exe"), manifestPath=join(root,"manifest.json");
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const fileHash=(path:string)=>hash(readFileSync(path));
const sourceBefore=fileHash(source), compilerHash=fileHash(compiler);
const env={Path:dirname(compiler)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
const manifest:any={schema:1,nonce,scenario,root,source,sourceBefore,compiler,compilerHash,
    toolchainPathPrefix:dirname(compiler),startedAt:new Date().toISOString(),status:"STARTED",events:[],children:[]};
const save=()=>writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
const note=(kind:string,detail:unknown={})=>{manifest.events.push({at:new Date().toISOString(),kind,detail});save();};
save();

// Retain at most 4 MiB per stream while always draining it to EOF.
async function drain(stream:ReadableStream<Uint8Array>, path:string) {
    const reader=stream.getReader(), parts:Uint8Array[]=[];let size=0,total=0,eof=false,error:string|undefined;
    try {
        while(true){const next=await reader.read();if(next.done){eof=true;break;}
            total+=next.value.length;
            const keep=Math.min(next.value.length,Math.max(0,4*1024*1024-size));
            if(keep){parts.push(next.value.slice(0,keep));size+=keep;}
        }
    } catch (failure) { error=String(failure); }
    const out=new Uint8Array(size);let offset=0;
    for(const part of parts){out.set(part,offset);offset+=part.length;}
    try { writeFileSync(path,out); } catch (failure) { error=String(failure); eof=false; }
    return {eof,error,total,stored:size,truncated:total!==size,sha256:hash(out)};
}
type Owned={role:string;pid:number;exit:number|null;finished:boolean;stdout?:unknown;stderr?:unknown;settled:Promise<void>};
function start(role:string,command:string[]) {
    const proc=Bun.spawn(command,{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const record:Owned={role,pid:proc.pid,exit:null,finished:false,settled:Promise.resolve()};
    manifest.children.push(record);note("spawn",{role,pid:proc.pid,argv:command});
    const stdout=drain(proc.stdout,join(root,role+"-stdout.bin"));
    const stderr=drain(proc.stderr,join(root,role+"-stderr.bin"));
    const exit=proc.exited.then(code=>{record.exit=code;note("exit",{role,pid:proc.pid,code});});
    record.settled=Promise.all([exit,stdout,stderr]).then(([,out,err])=>{
        record.stdout=out;record.stderr=err;record.finished=true;note("eof",{role,stdout:out,stderr:err});
    });
    return record;
}
function complete(child:Owned){return child.exit!==null;}
function timedNotice(child:Owned,ms:number) {
    const timer=setTimeout(()=>{if(!child.finished)note("deadline-exceeded-still-owned",{role:child.role,pid:child.pid,exit:child.exit});},ms);
    void child.settled.finally(()=>clearTimeout(timer));
}
async function ready(host:Owned,ms:number):Promise<number[]> {
    const path=join(root,"host-ready.bin");
    return new Promise((resolveReady,reject)=>{
        let done=false,checking=false;
        const finish=(error?:Error,value?:number[])=>{if(done)return;done=true;clearTimeout(deadline);clearInterval(retry);watcher.close();error?reject(error):resolveReady(value!);};
        const check=()=>{
            if(done||checking)return;checking=true;
            try {
                if(existsSync(path)){
                    const b=readFileSync(path);
                    if(b.length===20){
                        const words=Array.from({length:5},(_,i)=>b.readUInt32LE(i*4));
                        if(words[0]!==0x34525044||words[1]!==nonce||words[2]!==host.pid)finish(Error("Invalid READY identity"));
                        else finish(undefined,words);
                    }else if(b.length>20)finish(Error("Invalid READY length"));
                }
            } catch { /* CREATE_NEW is locked until the native writer closes it. */ }
            finally {checking=false;}
            if(!done&&complete(host))finish(Error("Host exited before complete READY: "+host.exit));
        };
        const watcher=watch(root,()=>check());
        const deadline=setTimeout(()=>finish(Error("Host READY deadline")),ms);
        // Bounded retry covers an event delivered while the file has exclusive sharing.
        const retry=setInterval(check,100);
        void host.settled.then(()=>check());check();
    });
}
function decode(path:string,role:number,pid:number) {
    const b=readFileSync(path),header=72,rowSize=264;
    if(b.length!==header+64*rowSize||b.readUInt32LE(0)!==0x344f5044||
        b.readUInt32LE(4)!==1||b.readUInt32LE(8)!==nonce||b.readUInt32LE(12)!==role||
        b.readUInt32LE(16)!==pid)throw Error("Invalid native record identity or length: "+path);
    const count=b.readUInt32LE(64),dropped=b.readUInt32LE(68);
    if(count>64||dropped)throw Error("Incomplete native callback record: "+path);
    const rows=[];
    for(let i=0;i<count;i++){
        const at=header+i*rowSize,length=b.readUInt32LE(at+64),truncated=b.readUInt32LE(at+68);
        if(length>95||truncated)throw Error("Truncated native session name");
        rows.push({ordinal:b.readUInt32LE(at),flags:b.readUInt32LE(at+4),timeout:b.readUInt32LE(at+8),
            hasDesc:b.readUInt32LE(at+12),size:b.readUInt32LE(at+16),sessionFlags:b.readUInt32LE(at+20),
            instance:b.subarray(at+24,at+40).toString("hex"),application:b.subarray(at+40,at+56).toString("hex"),
            maxPlayers:b.readUInt32LE(at+56),currentPlayers:b.readUInt32LE(at+60),
            name:b.subarray(at+72,at+72+length*2).toString("utf16le")});
    }
    const hr=Array.from({length:9},(_,i)=>b.readUInt32LE(28+i*4));
    return {sha256:hash(b),duration:b.readUInt32LE(20),mismatch:b.readUInt32LE(24),hr,rows};
}
const compileArgs=[compiler,"-O1","-nostdlib","-fno-builtin","-fno-stack-protector",
    "-Wl,--entry,_entry","-Wl,--subsystem,console","-o",exe,source,
    "-lws2_32","-lkernel32","-lole32","-ldxguid","-luuid"];
let host:Owned|undefined,enumerator:Owned|undefined;
try {
    // Validate the selected compiler under the same controlled PATH used by
    // compilation; preserve both streams even when a later build has no output.
    const version=start("compiler-version",[compiler,"--version"]);timedNotice(version,10000);await version.settled;
    if(version.exit!==0||!(version.stdout as any).eof||!(version.stderr as any).eof||
        (version.stdout as any).truncated||(version.stderr as any).truncated)throw Error("Compiler version probe failed");
    manifest.compilerVersion=readFileSync(join(root,"compiler-version-stdout.bin"),"utf8").split(/\r?\n/)[0];
    note("compiler-verified",{version:manifest.compilerVersion});
    const build=start("build",compileArgs);timedNotice(build,20000);await build.settled;
    if(build.exit!==0)throw Error("Compiler failed; see build-stderr.bin and build-stdout.bin");
    if(!(build.stdout as any).eof||!(build.stderr as any).eof||(build.stdout as any).truncated||(build.stderr as any).truncated)throw Error("Compiler output incomplete");
    if(fileHash(source)!==sourceBefore)throw Error("Source changed during compilation");
    manifest.executableSha256=fileHash(exe);note("build-verified",{sha256:manifest.executableSha256});
    host=start("host",[exe,"host",String(nonce),root,"10000","match"]);timedNotice(host,42000);
    const words=await ready(host,22000);manifest.ready=words;note("ready",{words});
    if(words[3]!==0||words[4]!==0)throw Error("Native Host Open/CreatePlayer failed");
    enumerator=start("enum",[exe,"enum",String(nonce),root,"3000",scenario]);timedNotice(enumerator,25000);
    await enumerator.settled;
    const hostAliveAtEnumExit=!complete(host);note("enum-finished",{hostAliveAtEnumExit});
    await host.settled;
    if(host.exit!==0||enumerator.exit!==0)throw Error("Native process failed");
    if(!hostAliveAtEnumExit)throw Error("Host exited before enumeration completed");
    for(const child of [host,enumerator])if(!(child.stdout as any).eof||!(child.stderr as any).eof||(child.stdout as any).truncated||(child.stderr as any).truncated)throw Error("Native output incomplete");
    manifest.sourceAfter=fileHash(source);
    if(manifest.sourceAfter!==sourceBefore)throw Error("Source changed during native run");
    const hostRecord=decode(join(root,"host-result.bin"),1,host.pid);
    const enumRecord=decode(join(root,"enum-result.bin"),2,enumerator.pid);
    manifest.host=hostRecord;manifest.enumerator=enumRecord;
    if(hostRecord.hr[5]!==0||hostRecord.hr[6]!==0||enumRecord.hr[7]!==0)throw Error("Native operation HRESULT failed");
    const app=Buffer.alloc(16);app.writeUInt32LE(nonce,0);app.writeUInt16LE(0x7319,4);app.writeUInt16LE(0x4ae1,6);
    Buffer.from([0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1]).copy(app,8);
    const matching=enumRecord.rows.filter(row=>row.hasDesc&&row.application===app.toString("hex"));
    manifest.matchingRows=matching;
    if(scenario==="match"){
        if(matching.length!==1||matching[0].name!=="DP4-oracleЖ"||matching[0].maxPlayers!==8||
            matching[0].currentPlayers!==1)throw Error("Native matching discovery was not observed");
    }else if(enumRecord.rows.some(row=>row.hasDesc))throw Error("Mismatched application GUID returned a session");
    manifest.status="NATIVE_API_OBSERVED";note("validated",{matchingRows:matching.length});
}catch(error){
    manifest.status="FAILED";manifest.error=String(error);note("failure",{error:String(error)});
}finally{
    // Never discard an owned handle after a timeout or kill an unrelated process.
    if(enumerator)await enumerator.settled;
    if(host)await host.settled;
    try {
        const stages=readdirSync(root).filter(name=>/^(host|enum)-stage-[0-9]{2}\.bin$/.test(name)).sort().map(name=>{
            const bytes=readFileSync(join(root,name)), match=/^(host|enum)-stage-([0-9]{2})\.bin$/.exec(name)!;
            const owner=match[1]==="host"?host:enumerator, code=Number(match[2]);
            if(bytes.length!==24||bytes.readUInt32LE(0)!==0x34535044||bytes.readUInt32LE(4)!==nonce||
                !owner||bytes.readUInt32LE(8)!==owner.pid||bytes.readUInt32LE(12)!==code)throw Error("Invalid stage marker "+name);
            return {name,role:match[1],code,pid:owner.pid,tick:bytes.readUInt32LE(16),hr:bytes.readUInt32LE(20),sha256:hash(bytes)};
        });
        manifest.stages=stages;
        if(manifest.status==="NATIVE_API_OBSERVED"){
            const requiredHost=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,17,18,19,20,21,22];
            const requiredEnum=[1,2,3,4,5,6,7,8,9,10,15,16,17,18,19,20];
            for(const [role,codes] of [["host",requiredHost],["enum",requiredEnum]] as const)
                for(const code of codes)if(!stages.some(stage=>stage.role===role&&stage.code===code))throw Error("Missing stage "+role+":"+code);
        }
    } catch(error) {manifest.status="FAILED";manifest.stageError=String(error);}
    manifest.endedAt=new Date().toISOString();save();
}
if(manifest.status!=="NATIVE_API_OBSERVED")process.exitCode=1;
