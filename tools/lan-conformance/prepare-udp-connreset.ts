/**
 * Package retained UDP_CONNRESET x86 inputs without compiling or executing the PE.
 * Defaults pin the two measured native baselines. A future baseline needs explicit new pins.
 */
import {copyFile,mkdir} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,sep} from "node:path";
import {fixtureConfig,validateCapture,hashFile,sha256} from "./udp-connreset-artifacts";

const usage="bun tools/lan-conformance/prepare-udp-connreset.ts --fixture NAME --capture DIR --output NEWDIR [--guest-os winxp|win98] [--validate-only] [--nonce DWORD --executable-sha256 SHA --reference-sha256 SHA]";
export async function main(args:string[]):Promise<void> {
    if(args.includes("--help")){console.log(usage);return;}
    const cli=new Map<string,string>();let validateOnly=false;
    for(let i=0;i<args.length;i++){
        const key=args[i];
        if(key==="--validate-only"){if(validateOnly)throw Error(usage);validateOnly=true;continue;}
        if(!["--fixture","--capture","--output","--guest-os","--nonce","--executable-sha256","--reference-sha256"].includes(key)||cli.has(key)||!args[i+1]||args[i+1].startsWith("--"))throw Error(usage);
        cli.set(key,args[++i]);
    }
    if(!cli.has("--fixture")||!cli.has("--capture")||(!validateOnly&&!cli.has("--output")))throw Error(usage);
    const config=fixtureConfig(cli.get("--fixture")!),capture=resolve(cli.get("--capture")!);
    const override=["--nonce","--executable-sha256","--reference-sha256"].filter(key=>cli.has(key));
    if(override.length&&override.length!==3)throw Error("A new baseline needs all three explicit pins");
    const pins=override.length?{...config.historical,nonce:Number(cli.get("--nonce")),executableSha256:cli.get("--executable-sha256")!,referenceSha256:cli.get("--reference-sha256")!}:config.historical;
    if(!/^[0-9a-f]{64}$/.test(pins.executableSha256)||!/^[0-9a-f]{64}$/.test(pins.referenceSha256))throw Error("Invalid native hash pins");
    const proof=await validateCapture(config,capture,pins);
    if(validateOnly){console.log(JSON.stringify({status:"validated-only",fixture:config.name,nonce:proof.nonce,observations:config.observations,records:proof.records.length,executableSha256:proof.executableSha256,referenceSha256:proof.referenceSha256,inputs:proof.hashes}));return;}
    const out=resolve(cli.get("--output")!),guestOs=cli.get("--guest-os")??"winxp";
    if(!["winxp","win98"].includes(guestOs))throw Error("Unsupported explicit guest profile");
    const relativeOutput=relative(capture,out);
    // Capture evidence directories are read-only, including their descendants.
    if(!relativeOutput||(!isAbsolute(relativeOutput)&&relativeOutput!==".."&&!relativeOutput.startsWith(".."+sep)))throw Error("Output cannot be inside the retained capture");
    await mkdir(dirname(out),{recursive:true});await mkdir(out); // Atomic refusal of a reused output.
    const save=(name:string,data:unknown)=>Bun.write(join(out,name),JSON.stringify(data,null,2)+"\n");
    try{
        const game=join(out,"game");await mkdir(game);
        for(const [from,to]of [[proof.paths.executable,join(game,"lan-oracle.exe")],[proof.paths.reference,join(out,"native-reference.bin")],
            [proof.paths.source,join(out,"fixture.c")],[proof.paths.schema,join(out,"schema.json")],
            [proof.paths.build,join(out,"native-build.json")],[proof.paths.result,join(out,"native-result.json")],[proof.paths.audit,join(out,"native-port-audit.bin")]])await copyFile(from,to);
        const bundle=join(out,config.name+"-"+proof.nonce+".wgb");
        const run=async(name:string,argv:string[])=>{
            const answer=Bun.spawnSync([process.execPath,...argv],{stdout:"pipe",stderr:"pipe",timeout:30000});
            await Promise.all([Bun.write(join(out,name+".stdout.log"),answer.stdout),Bun.write(join(out,name+".stderr.log"),answer.stderr)]);
            if(answer.exitCode!==0)throw Error(name+" failed with exit "+answer.exitCode);
            return answer;
        };
        await run("pack",["tools/make-wgb.ts",game,bundle,"--exe","lan-oracle.exe","--name",config.name+" conformance","--game-id","app:lan-conformance","--ram","128","--os",guestOs]);
        await run("patch",["tools/wgb.ts","patch-manifest",bundle,"emulator.deleteOnBoot",JSON.stringify(["C:\\lan-oracle.bin","C:\\checkpoint.bin","C:\\udp-port-audit.bin"])]);
        const embedded=await run("embedded-pe",["tools/wgb.ts","cat",bundle,"rom/lan-oracle.exe"]);
        if(sha256(embedded.stdout)!==proof.executableSha256)throw Error("Embedded PE differs from native PE");
        const manifest=JSON.parse(new TextDecoder().decode((await run("bundle-manifest",["tools/wgb.ts","cat",bundle,"manifest.json"])).stdout));
        const after=await Promise.all(proof.hashes.map(async item=>({...item,sha256:await hashFile(item.path)})));
        if(JSON.stringify(after)!==JSON.stringify(proof.hashes))throw Error("Retained native input changed during packaging");
        if(await hashFile(join(game,"lan-oracle.exe"))!==proof.executableSha256||await hashFile(join(out,"native-reference.bin"))!==proof.referenceSha256)throw Error("Copied native identity differs");
        const build={
            fixture:config.name,status:"prepared",scope:"SAME-PE/full raw words for this retained subset; not the full original9451 matrix",
            nonce:proof.nonce,observations:config.observations,records:proof.records.length,totalWordsIncludingHeader:config.observations+3,
            bundle,bundleSha256:await hashFile(bundle),executable:join(game,"lan-oracle.exe"),executableSha256:proof.executableSha256,
            reference:join(out,"native-reference.bin"),referenceSha256:proof.referenceSha256,
            source:join(out,"fixture.c"),sourceSha256:config.sourceSha256,schema:join(out,"schema.json"),schemaSha256:config.schemaSha256,
            nativeHost:proof.build.host,guestProfile:guestOs,bundleManifest:manifest,
            nativeRun:{path:proof.paths.result,sha256:await hashFile(proof.paths.result),compilerPid:proof.result.compilerPid,nativePid:proof.result.nativePid,exit:proof.result.exit,portsRetired:proof.ports.length},
            historicalPins:!override.length,inputsBefore:proof.hashes,inputsAfter:after,
            notes:["C/schema retain historical source-only wording and estimate6368; observed portable count is6168","No native process or compiler was executed by this preparer","No dynamic native ports, handles, addresses, TIDs, or durations are removed or rewritten"],
        };
        await save("build.json",build);
        console.log(JSON.stringify({status:"prepared",build:join(out,"build.json"),sha256:await hashFile(join(out,"build.json")),observations:config.observations,nonce:proof.nonce}));
    }catch(error){await save("failure.json",{at:new Date().toISOString(),error:String(error),fixture:config.name});throw error;}
}
if(import.meta.main)await main(process.argv.slice(2));
