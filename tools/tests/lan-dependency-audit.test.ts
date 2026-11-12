import {test,expect} from "bun:test";
import {audit,findings,inventory,type Package} from "../security/audit-lan-dependencies";
const vulnerable:Package={ecosystem:"crates.io",name:"tokio",version:"1.53.2"};
const patched:Package={...vulnerable,version:"1.53.3"};
test("SR-09 the pre-fix Tokio advisory fails auditing, patched Tokio is clean",async()=>{
    // OSV response captured 2026-11-13; the former lockfile must fail this CI policy.
    const result=await audit([vulnerable,patched],async(_url,request)=>{
        expect(JSON.parse(String(request?.body)).queries[0].version).toBe("1.53.2");
        return Response.json({results:[{vulns:[{id:"RUSTSEC-2026-0386",modified:"2026-10-23T14:45:03.847864Z"}]},{}]});
    });
    expect(result).toEqual([{...vulnerable,advisories:["RUSTSEC-2026-0386"]}]);
    expect(findings([patched],{results:[{}]})).toEqual([]);
});
test("dependency audit fails closed on unavailable, malformed or incomplete advisory data",async()=>{
    await expect(audit([patched],async()=>new Response("",{status:503}))).rejects.toThrow();
    await expect(audit([patched],async()=>{throw Error("offline")})).rejects.toThrow();
    for(const response of [{},{results:[]},{results:[null]},{results:[{next_page_token:"more"}]},{results:[{vulns:"unknown"}]},{results:[{error:"lookup failed"}]}])
        expect(()=>findings([patched],response)).toThrow();
});
test("production LAN inventory covers all deployed Cargo lockfiles and Socket.IO transitive packages",()=>{
    const packages=inventory();
    for(const name of ["socket.io","socket.io-client","engine.io","engine.io-client","ws"])expect(packages.some(p=>p.ecosystem==="npm"&&p.name===name)).toBe(true);
    for(const name of ["tokio","hmac","sha2","engineioxide"])expect(packages.some(p=>p.ecosystem==="crates.io"&&p.name===name)).toBe(true);
    expect(packages.filter(p=>p.name==="tokio").map(p=>p.version)).toEqual(["1.53.3"]);
    expect(new Set(packages.map(p=>p.ecosystem+p.name+p.version)).size).toBe(packages.length);
});
