/** Finite, fresh-directory native capture. Never imports ignored historical runner code. */
import {mkdir,copyFile} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";
import {createSocket} from "node:dgram";
import {fileURLToPath} from "node:url";
import {type,release,arch} from "node:os";
import {fixtureConfig,maintainedInputs,hashFile,boundedRead,decodeOracle,decodePortAudit,verifyX86Pe,type OracleRecord} from "./udp-connreset-artifacts";

const usage="bun tools/lan-conformance/run-udp-connreset-native.ts --fixture NAME --attempt native-NEW [--output-root DIR] [--compiler PATH]";
export async function main(args:string[]):Promise<void> {
    if(args.includes("--help")){console.log(usage);return;}
    if(process.platform!=="win32")throw Error("Native x86 Winsock capture requires Windows");
    const cli=new Map<string,string>();
    for(let i=0;i<args.length;i+=2){
        if(!["--fixture","--attempt","--output-root","--compiler"].includes(args[i])||cli.has(args[i])||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);
        cli.set(args[i],args[i+1]);
    }
    if(!cli.has("--fixture")||!/^native-[a-z0-9-]+$/.test(cli.get("--attempt")??""))throw Error(usage);
    const config=fixtureConfig(cli.get("--fixture")!),maintained=await maintainedInputs(config);
    const parent=resolve(cli.get("--output-root")??join("logs/lan-conformance",config.name)),root=join(parent,cli.get("--attempt")!);
    await mkdir(parent,{recursive:true});await mkdir(root); // Refuse reuse before any process starts.
    const save=(name:string,data:unknown)=>Bun.write(join(root,name),JSON.stringify(data,null,2)+"\n");
    const source=join(root,"fixture.c"),executable=join(root,config.executableName),nonce=Date.now()>>>0;
    await copyFile(maintained.source,source);await copyFile(maintained.schemaPath,join(root,"schema.json"));
    await copyFile(import.meta.path,join(root,"runner.ts"));
    await copyFile(new URL("./udp-connreset-artifacts.ts",import.meta.url),join(root,"udp-connreset-artifacts.ts"));
    await copyFile(maintained.source,join(root,config.name+".c"));
    await copyFile(maintained.schemaPath,join(root,config.name+".schema.json"));
    await mkdir(join(root,"native"));
    const compiler=resolve(cli.get("--compiler")??"C:/msys64/mingw32/bin/gcc.exe");
    // Only public OS/toolchain environment names are read; no credential/config dump.
    const compilerEnv:Record<string,string>={Path:dirname(compiler)+";"+(process.env.PATH??process.env.Path??"")};
    for(const key of ["SystemRoot","TEMP","TMP"])if(process.env[key])compilerEnv[key]=process.env[key]!;
    const compilerArgs=["-O1","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",executable,source,"-lws2_32","-lkernel32"];
    const attempt={scope:config.name+" finite loopback capture; earlier captures immutable",source,sourceSha256:config.sourceSha256,schemaSha256:config.schemaSha256,nonce,compiler,args:compilerArgs,
        startedAt:new Date().toISOString(),host:{type:type(),release:release(),architecture:arch(),pe:"x86"},
        watchdog:{compilerMs:30000,nativeMs:config.nativeMs,hostMs:config.hostMs},runnerSha256:await hashFile(import.meta.path),artifactsSha256:await hashFile(fileURLToPath(new URL("./udp-connreset-artifacts.ts",import.meta.url)))};
    let phase="prepared",compilerPid:number|undefined,nativePid:number|undefined;
    await save("attempt.json",attempt);
    async function runBounded(command:string[],name:string,limit:number,env?:Record<string,string>,cwd?:string){
        const child=Bun.spawn(command,{cwd,env,stdin:"ignore",stdout:Bun.file(join(root,name+".stdout.log")),stderr:Bun.file(join(root,name+".stderr.log"))});
        if(name==="compiler")compilerPid=child.pid;else nativePid=child.pid;
        let timedOut=false,hardTimer:ReturnType<typeof setTimeout>|undefined;
        const exit=await new Promise<number>((done,fail)=>{
            const timer=setTimeout(()=>{
                timedOut=true;try{child.kill();}catch{}
                hardTimer=setTimeout(()=>fail(Error("Child retirement not observed: "+name+" PID "+child.pid)),5000);
            },limit);
            child.exited.then(value=>{clearTimeout(timer);clearTimeout(hardTimer);done(value);},
                error=>{clearTimeout(timer);clearTimeout(hardTimer);fail(error);});
        });
        return {pid:child.pid,exit,timedOut};
    }
    try{
        phase="compile";const build=await runBounded([compiler,...compilerArgs],"compiler",30000,compilerEnv);
        const executableSha256=build.exit===0?await hashFile(executable):undefined;
        await save("build.json",{...attempt,compilerPid:build.pid,buildExit:build.exit,buildTimedOut:build.timedOut,executable,executableSha256});
        if(build.exit!==0||build.timedOut)throw Error("Native compilation failed; no automatic retry");
        verifyX86Pe(await boundedRead(executable,16*1024*1024));
        phase="native";const run=await runBounded([executable],"native",config.hostMs,undefined,join(root,"native"));
        const completeReference=join(root,"native/lan-oracle.bin"),checkpoint=join(root,"native/checkpoint.bin");
        let reference:string|null=null,raw:Uint8Array|null=null;
        for(const path of [completeReference,checkpoint]){try{raw=await boundedRead(path,131072);reference=path;break;}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}}
        let records:OracleRecord[]=[],decodeError:string|undefined;
        try{if(!raw)throw Error("Native reference/checkpoint missing");records=decodeOracle(raw,nonce,maintained.schema);}catch(error){decodeError=String(error);}
        const audit=join(root,"native/udp-port-audit.bin");
        let ports:Array<{family:4|6;port:number}>=[],auditError:string|undefined,auditSha256:string|undefined;
        try{const bytes=await boundedRead(audit,4096);auditSha256=await hashFile(audit);ports=decodePortAudit(bytes,nonce);}catch(error){auditError=String(error);}
        phase="port-retirement";
        const retirement:Array<{family:4|6;port:number;success:boolean;error?:string}>=[];
        const retirementDeadline=Date.now()+5000;
        for(const endpoint of ports){
            if(Date.now()>=retirementDeadline){retirement.push({...endpoint,success:false,error:"Aggregate retirement audit deadline"});continue;}
            const socket=createSocket(endpoint.family===4?"udp4":"udp6");
            const observed=await new Promise<{success:boolean;error?:string}>(done=>{
                let settled=false;
                const finish=(value:{success:boolean;error?:string})=>{if(settled)return;settled=true;clearTimeout(timer);done(value);};
                const timer=setTimeout(()=>finish({success:false,error:"Exclusive rebind timed out"}),Math.min(2000,retirementDeadline-Date.now()));
                socket.once("error",error=>finish({success:false,error:String(error)}));
                try{socket.bind({address:endpoint.family===4?"127.0.0.1":"::1",port:endpoint.port,exclusive:true},()=>finish({success:true}));}
                catch(error){finish({success:false,error:String(error)});}
            });
            await new Promise<void>(done=>{try{socket.close(()=>done());}catch{done();}});
            retirement.push({...endpoint,...observed});
        }
        const sourceAfterSha256=await hashFile(source);
        const result={...attempt,compilerPid:build.pid,nativePid:run.pid,buildExit:build.exit,buildTimedOut:build.timedOut,exit:run.exit,timedOut:run.timedOut,completedAt:new Date().toISOString(),
            sourceAfterSha256,executable,executableSha256,reference,referenceSha256:reference?await hashFile(reference):null,
            valid:!decodeError,finalMarker:!decodeError,observations:raw?raw.length/4-3:0,records,decodeError,
            audit,auditSha256,auditValid:!auditError,auditError,portsRetirement:retirement};
        await save("result.json",result);
        console.log(JSON.stringify({output:root,compilerPid:build.pid,nativePid:run.pid,exit:run.exit,timedOut:run.timedOut,observations:result.observations,records:records.length,decodeError,auditError,portsAllReleased:!!ports.length&&retirement.every(port=>port.success),referenceSha256:result.referenceSha256,resultSha256:await hashFile(join(root,"result.json"))}));
        if(run.exit!==0||run.timedOut||decodeError||auditError||!ports.length||retirement.some(port=>!port.success)||result.observations!==config.observations||records.length!==config.records||sourceAfterSha256!==config.sourceSha256)throw Error("Incomplete native evidence; preserve this attempt and inspect before any new run");
        await maintainedInputs(config); // Canonical producer/schema must also remain unchanged.
        phase="complete";
    }catch(error){await save("failure.json",{at:new Date().toISOString(),phase,compilerPid,nativePid,error:String(error)});throw error;}
}
if(import.meta.main)await main(process.argv.slice(2));
