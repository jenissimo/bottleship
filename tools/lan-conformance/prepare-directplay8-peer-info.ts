/**
 * Prepare a WGB from an immutable native connected SetPeerInfo baseline.
 * Never rebuilds or executes the PE; source, PE and both references remain byte-identical.
 */
import{createHash}from"node:crypto";
import{copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync}from"node:fs";
import{dirname,join,resolve}from"node:path";
const usage="bun tools/lan-conformance/prepare-directplay8-peer-info.ts --proof <native baseline> --output <NEW directory> [--guest-role <host|peer>]";
if(process.argv.includes("--help")){console.log(usage);process.exit(0);}
const cli=new Map<string,string>(),args=process.argv.slice(2);
for(let n=0;n<args.length;n+=2){const k=args[n],v=args[n+1];if(!["--proof","--output","--guest-role"].includes(k)||!v||v.startsWith("--")||cli.has(k))throw Error(usage);cli.set(k,v);}
if(!cli.has("--proof")||!cli.has("--output"))throw Error(usage);
const proof=resolve(cli.get("--proof")!),out=resolve(cli.get("--output")!),guestRole=cli.get("--guest-role")??"host";
if(!["host","peer"].includes(guestRole))throw Error(usage);
if(existsSync(out))throw Error("Immutable output already exists");
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+"\n");
const nativePath=join(proof,"verified.json"),native=JSON.parse(readFileSync(nativePath,"utf8"));
if(native.status!=="passed"||!Number.isInteger(native.nonce)||native.observations!==988||native.results?.length!==2||native.processes?.some((p:any)=>p.exit!==0||p.forced)||native.ports?.some((p:any)=>!p.available))throw Error("A complete native 988-observation baseline is required");
const traceInputs=native.results.flatMap((r:any)=>["info-callback-header.bin","info-callback-rows.bin"].map(name=>join(dirname(r.path),name)));
const inputs=[nativePath,native.executable.path,join(proof,"fixture.c"),...native.results.map((r:any)=>r.path),...traceInputs];
const before=inputs.map(path=>({path,sha256:hash(path)}));
if(hash(native.executable.path)!==native.executable.sha256||hash(join(proof,"fixture.c"))!==native.source.sha256||native.results.some((r:any)=>hash(r.path)!==r.sha256))throw Error("Native byte guard failed");
mkdirSync(out,{recursive:true});
try{
 const exe=join(out,"native-peer.exe"),fixture=join(out,"fixture.c");copyFileSync(native.executable.path,exe);copyFileSync(join(proof,"fixture.c"),fixture);
 const image=readFileSync(exe),offset=image.readUInt32LE(0x3c);if(image.readUInt32LE(offset)!==0x4550||image.readUInt16LE(offset+4)!==0x14c)throw Error("Fixture is not x86 PE");
 const game=join(out,"game");mkdirSync(game);copyFileSync(exe,join(game,"lan-oracle.exe"));
 for(let role=0;role<2;role++)copyFileSync(native.results[role].path,join(out,role?"peer-reference.bin":"host-reference.bin"));
 const traces=traceInputs.map((path:string,index:number)=>{const copied=join(out,(index<2?"host-":"peer-")+(index%2?"callback-rows.bin":"callback-header.bin"));copyFileSync(path,copied);return{path:copied,sha256:hash(copied)};});
 const bundle=join(out,"peer-info-"+(guestRole==="peer"?"reverse-":"")+native.nonce+".wgb");
 const pack=Bun.spawnSync([process.execPath,"tools/make-wgb.ts",game,bundle,"--exe","lan-oracle.exe",...(guestRole==="peer"?["--args","--peer"]:[]),"--name",guestRole==="peer"?"DirectPlay8 reverse connected SetPeerInfo":"DirectPlay8 connected SetPeerInfo","--game-id","app:lan-conformance","--ram","128","--os","winxp"],{stdout:"pipe",stderr:"pipe"});
 writeFileSync(join(out,"pack.stdout.txt"),pack.stdout);writeFileSync(join(out,"pack.stderr.txt"),pack.stderr);
 if(pack.exitCode)throw Error("SAME-PE WGB pack failed");
 const artifacts=["lan-oracle.bin","info-progress.bin","info-callback-header.bin","info-callback-rows.bin","info-watchdog.bin","info-host-address-url.bin","host-ready.bin","connected.bin","all-steps-done.bin","peer-close-go.bin","host-peer-closed.bin","host-close-go.bin","done.bin"];
 for(let step=2;step<=8;step++)for(const suffix of["ready","go","done"])artifacts.push("step-"+step+"-"+suffix+".bin");
 const patch=Bun.spawnSync([process.execPath,"tools/wgb.ts","patch-manifest",bundle,"emulator.deleteOnBoot",JSON.stringify(artifacts.map(name=>"C:\\"+name))],{stdout:"pipe",stderr:"pipe"});
 writeFileSync(join(out,"patch.stdout.txt"),patch.stdout);writeFileSync(join(out,"patch.stderr.txt"),patch.stderr);if(patch.exitCode)throw Error("Fresh-output manifest failed");

 const entry=Bun.spawnSync([process.execPath,"tools/wgb.ts","cat",bundle,"rom/lan-oracle.exe"],{stdout:"pipe",stderr:"pipe"});
 const embeddedPeSha256=createHash("sha256").update(entry.stdout).digest("hex");
 if(entry.exitCode||embeddedPeSha256!==native.executable.sha256)throw Error("Prepared WGB embedded PE differs from native reference");
 const metadata=Bun.spawnSync([process.execPath,"tools/wgb.ts","cat",bundle,"manifest.json"],{stdout:"pipe",stderr:"pipe"});
 if(metadata.exitCode)throw Error("Cannot inspect prepared WGB manifest");
 const manifest=JSON.parse(new TextDecoder().decode(metadata.stdout)),guestArgs=guestRole==="peer"?"--peer":"";
 if((manifest.args??"")!==guestArgs)throw Error("Prepared WGB role argument differs");

 const after=inputs.map(path=>({path,sha256:hash(path)}));if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Immutable native input changed");
 const result={fixture:"directplay8-peer-info",schema:1,status:"prepared",guestRole,guestArgs,embeddedPeSha256,nonce:native.nonce,ports:[native.hostPort,native.peerPort],executable:exe,executableSha256:hash(exe),source:fixture,sourceSha256:hash(fixture),bundle,bundleSha256:hash(bundle),references:[{path:join(out,"host-reference.bin"),sha256:hash(join(out,"host-reference.bin")),observations:native.results[0].observations},{path:join(out,"peer-reference.bin"),sha256:hash(join(out,"peer-reference.bin")),observations:native.results[1].observations}],traces,nativeProof:{path:nativePath,sha256:hash(nativePath)},inputs:before};
 save(join(out,"build.json"),result);console.log(JSON.stringify({status:result.status,build:join(out,"build.json"),sha256:hash(join(out,"build.json")),observations:988}));
}catch(error){save(join(out,"failure.json"),{error:String(error),at:new Date().toISOString()});throw error;}
