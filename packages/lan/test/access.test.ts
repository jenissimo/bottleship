import {test, expect} from "bun:test";
import {join} from "node:path";
import {RoomAccess} from "../src/access";
import vector from "./invite-vector.json";

const key=Buffer.from(vector.keyBase64,"base64");
test("SR-01 private default fails closed without a signing key",()=>{
    expect(()=>new RoomAccess({},new Uint8Array(16))).toThrow();
    const access=new RoomAccess({},key);
    expect(()=>access.authorize("locked",undefined,1000)).toThrow("LAN access denied");
});
test("Rust/TS golden invitation verifies exact room, scope and lifetime",()=>{
    const access=new RoomAccess({},key);
    expect(access.sign("locked",1060,vector.claims.gateway,1000)).toBe(vector.token);
    expect(access.authorize("locked",vector.token,1000)).toEqual({gateway:vector.claims.gateway,expiresAt:1060});
    expect(()=>access.authorize("elsewhere",vector.token,1000)).toThrow();
    expect(()=>access.authorize("locked",vector.token,1060)).toThrow();
    expect(()=>new RoomAccess({audience:"other-server"},key).authorize("locked",vector.token,1000)).toThrow();
    const [prefix,body,sig]=vector.token.split(".");
    const changed=JSON.parse(Buffer.from(body,"base64url").toString());changed.gateway.tcpListeners=["admin"];
    expect(()=>access.authorize("locked",prefix+"."+Buffer.from(JSON.stringify(changed)).toString("base64url")+"."+sig,1000)).toThrow();
    expect(()=>access.authorize("locked",vector.token+"=",1000)).toThrow();
});
test("public rooms preserve name-only entry and never inherit invitation scopes",()=>{
    const access=new RoomAccess({rooms:{lobby:{visibility:"public"}}},key);
    expect(access.authorize("lobby",undefined,1000).gateway).toEqual({routes:[],udpListeners:[],tcpListeners:[]});
    expect(()=>access.authorize("locked",undefined,1000)).toThrow();
    expect(()=>access.authorize("lobby","invalid",1000)).toThrow();
    const publicDefault=new RoomAccess({defaultVisibility:"public",rooms:{locked:{visibility:"private"}}},key);
    expect(publicDefault.authorize("arbitrary",undefined,1000).expiresAt).toBe(Infinity);
    expect(()=>publicDefault.authorize("locked",undefined,1000)).toThrow();
});
test("admission rejects excessive scopes, malformed names and lifetimes",()=>{
    const access=new RoomAccess({},key);
    expect(()=>access.sign("../locked",1060,{},1000)).toThrow();
    expect(()=>access.sign("locked",1000,{},1000)).toThrow();
    expect(()=>access.sign("locked",1000+86401,{},1000)).toThrow();
    expect(()=>access.sign("locked",1060,{routes:["quake","quake"]},1000)).toThrow();
    expect(()=>access.sign("locked",1060,{udpListeners:Array.from({length:33},(_,i)=>"host"+i)},1000)).toThrow();
    expect(()=>access.sign("locked",1000+86401,{},1000)).toThrow("Invitation TTL must be 1..86400 seconds");
    expect(()=>new RoomAccess({defaultVisibility:"public"},undefined).sign("lobby",1060,{},1000)).toThrow("requires the invite key");
});
test("bun run dev:lan keeps keyless loopback development working with explicit public rooms",async()=>{
    const root=join(import.meta.dir,"../../..");
    const script:string=(await Bun.file(join(root,"package.json")).json()).scripts["dev:lan"];
    expect(script).toBe("bun run packages/lan/src/cli.ts --public-rooms");
    const env={...process.env};delete env.BOTTLESHIP_LAN_INVITE_KEY;
    // Spawn the script's command directly so killing it cannot orphan a nested `bun run`.
    const child=Bun.spawn([process.execPath,"packages/lan/src/cli.ts","--public-rooms","--port","0"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    try {
        const reader=child.stdout.getReader();let text="";
        const deadline=Date.now()+10_000;
        while(!text.includes("listening on http://127.0.0.1:") && Date.now()<deadline){
            const {value,done}=await Promise.race([reader.read(),Bun.sleep(deadline-Date.now()).then(()=>({value:undefined,done:true}))]);
            if(done)break;text+=new TextDecoder().decode(value);
        }
        expect(text).toContain("listening on http://127.0.0.1:");
    } finally { child.kill(); await child.exited; }
},15_000);
