import {test, expect} from "bun:test";
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
});
