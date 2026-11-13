import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";

export type Package={ecosystem:"crates.io"|"npm";name:string;version:string};
export type Finding=Package&{advisories:string[]};
export const cargoLocks=["packages/lan-rust/Cargo.lock","packages/lan-rust/core/Cargo.lock",
    "packages/lan-rust/native/Cargo.lock","packages/lan-rust/gateway/Cargo.lock","packages/lan-rust/transport/Cargo.lock"];

export function inventory(root=process.cwd()):Package[] {
    const packages=new Map<string,Package>();
    const add=(p:Package)=>{
        if(!p.name||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(p.version))throw Error("Invalid locked package");
        packages.set(p.ecosystem+":"+p.name+"@"+p.version,p);
    };
    for(const path of cargoLocks) {
        const lock=Bun.TOML.parse(readFileSync(resolve(root,path),"utf8")) as {package?:{name:string;version:string;source?:string}[]};
        if(!Array.isArray(lock.package)||!lock.package.length)throw Error("Invalid Cargo lockfile: "+path);
        for(const p of lock.package) {
            // The checked-in Engine.IO fork also needs upstream advisory coverage.
            if(p.source?.startsWith("registry+")||p.name==="engineioxide")add({ecosystem:"crates.io",name:p.name,version:p.version});
            else if(p.source)throw Error("Unaudited Cargo source: "+p.name);
        }
    }
    const lock=Bun.JSONC.parse(readFileSync(resolve(root,"bun.lock"),"utf8")) as {
        lockfileVersion:number;packages:Record<string,[string,string,{dependencies?:Record<string,string>;optionalDependencies?:Record<string,string>;peerDependencies?:Record<string,string>}]>;
        workspaces:Record<string,{dependencies?:Record<string,string>}>;
    };
    if(lock.lockfileVersion!==1||!lock.packages||!lock.workspaces)throw Error("Unsupported Bun lockfile");
    const visited=new Set<string>();
    const find=(parent:string,name:string):string|undefined=>{
        let prefix=parent;
        while(prefix){const key=prefix+"/"+name;if(lock.packages[key])return key;prefix=prefix.slice(0,Math.max(0,prefix.lastIndexOf("/")));}
        return lock.packages[name]?name:undefined;
    };
    const visit=(key:string)=>{
        if(visited.has(key))return;visited.add(key);
        const row=lock.packages[key];if(!Array.isArray(row)||typeof row[0]!=="string")throw Error("Invalid Bun package: "+key);
        const at=row[0].lastIndexOf("@"),name=row[0].slice(0,at),version=row[0].slice(at+1);
        add({ecosystem:"npm",name,version});
        for(const dep of Object.keys(row[2]?.dependencies??{})){
            const child=find(key,dep);if(!child)throw Error("Missing locked dependency: "+key+" -> "+dep);visit(child);
        }
        for(const dep of Object.keys({...row[2]?.optionalDependencies,...row[2]?.peerDependencies})){
            const child=find(key,dep);if(child)visit(child);
        }
    };
    const roots=Object.keys(lock.workspaces["packages/lan"]?.dependencies??{});
    if(!roots.includes("socket.io")||!lock.workspaces[""]?.dependencies?.["socket.io-client"])throw Error("Missing LAN dependency roots");
    for(const name of [...roots,"socket.io-client"]){const key=find("",name);if(!key)throw Error("Missing LAN root: "+name);visit(key);}
    return [...packages.values()].sort((a,b)=>(a.ecosystem+":"+a.name+"@"+a.version).localeCompare(b.ecosystem+":"+b.name+"@"+b.version));
}
export const queryBody=(packages:Package[])=>({queries:packages.map(({ecosystem,name,version})=>({package:{ecosystem,name},version}))});
export function findings(packages:Package[],body:unknown):Finding[] {
    const results=(body as {results?:unknown[]})?.results;
    if(!Array.isArray(results)||results.length!==packages.length)throw Error("Incomplete OSV audit response");
    return results.flatMap((value,i)=>{
        if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Malformed OSV result");
        const row=value as {vulns?:{id:string}[];next_page_token?:string;error?:unknown};
        if(row.next_page_token||row.error||row.vulns!==undefined&&!Array.isArray(row.vulns))throw Error("Incomplete OSV result");
        const ids=(row.vulns??[]).map(v=>{if(!v||typeof v.id!=="string"||!v.id)throw Error("Malformed advisory");return v.id;});
        return ids.length?[{...packages[i],advisories:[...new Set(ids)].sort()}]:[];
    });
}
export async function audit(packages:Package[],fetcher:typeof fetch=fetch):Promise<Finding[]> {
    if(!packages.length)throw Error("Empty audit inventory");
    const response=await fetcher("https://api.osv.dev/v1/querybatch",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(queryBody(packages)),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error("OSV lookup failed: HTTP "+response.status);
    return findings(packages,await response.json());
}
if(import.meta.main){
    try{
        const packages=inventory();
        if(process.argv[2]==="--inventory"){
            const target=process.argv[3];if(!target)throw Error("Inventory output path required");
            writeFileSync(target,JSON.stringify(queryBody(packages)));console.log("LAN audit inventory: "+packages.length+" package versions");
        }else{
            // --response is for local, externally fetched evidence. CI always calls online audit.
            const result=process.argv[2]==="--response"
                ?findings(packages,JSON.parse(readFileSync(process.argv[3],"utf8"))):await audit(packages);
            if(result.length){for(const p of result)console.error(p.ecosystem+" "+p.name+"@"+p.version+": "+p.advisories.join(", "));process.exitCode=1;}
            else console.log("LAN dependency audit passed: "+packages.length+" package versions, no known advisories");
        }
    }catch(error){console.error("LAN dependency audit failed: "+(error instanceof Error?error.message:String(error)));process.exitCode=1;}
}
