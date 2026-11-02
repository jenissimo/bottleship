import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {decodeDirectPlay4CreatePlayer} from "../../src/worker/modules/dplayx/native-wire/create-message";
const fixture=JSON.parse(readFileSync(new URL("./fixtures/dp4-native-pending-create.json",import.meta.url),"utf8"));
const native=Uint8Array.from(fixture.bytes);
test("decodes an actual Windows pending CREATEPLAYER and owns its fields",()=>{
 const decoded=decodeDirectPlay4CreatePlayer(native,65536);
 expect(decoded.version).toBe(14);expect(decoded.player.id).toBe(decoded.playerId);
 expect(decoded.player.flags).toBe(8);expect(decoded.player.spData.length).toBe(32);
 expect(new TextDecoder("utf-16le").decode(decoded.player.shortName!)).toBe("Late\0");
 const first=decoded.player.spData[0];native[28+48+10]=99;expect(decoded.player.spData[0]).toBe(first);
});
test("rejects truncated, mismatched and unsupported native create layouts",()=>{
 for(const cut of [0,7,27,28,75,117,119,123])expect(()=>decodeDirectPlay4CreatePlayer(native.subarray(0,cut),65536)).toThrow();
 for(const mutate of [
  (b:Uint8Array)=>b[0]=0,(b:Uint8Array)=>b[4]=9,(b:Uint8Array)=>b[6]=13,
  (b:Uint8Array)=>b[12]^=1,(b:Uint8Array)=>b[20]=29,(b:Uint8Array)=>b[24]=1,
  (b:Uint8Array)=>b[28]=255,(b:Uint8Array)=>b[56]=1,
 ]){
  const b=Uint8Array.from(fixture.bytes);mutate(b);expect(()=>decodeDirectPlay4CreatePlayer(b,65536)).toThrow();
 }
});
