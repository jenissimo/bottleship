import {beforeAll,expect,test} from "bun:test";
import {spawn} from "node:child_process";
import {dirname,join} from "node:path";
import {buildNativeForTests,nativeTestHelper} from "../../packages/lan/native/testing";
// Compiling the native helper can exceed the default 5 s hook budget under full-gate load.
beforeAll(buildNativeForTests, 120_000);
test("native raw NAT checksum adjustment matches complete IPv4/IPv6 pseudo-header oracles",async()=>{
    const executable=join(dirname(nativeTestHelper),"test-checksum"+(process.platform==="win32"?".exe":""));
    const result=await new Promise<{code:number|null;text:string}>((resolve,reject)=>{
        const child=spawn(executable,[],{stdio:["ignore","pipe","pipe"],windowsHide:true});let text="";
        const timer=setTimeout(()=>{child.kill();reject(new Error("Native checksum oracle timed out"));},5000);
        child.stdout.on("data",bytes=>{text=(text+String(bytes)).slice(-4096);});child.stderr.resume();
        child.on("error",error=>{clearTimeout(timer);reject(error);});
        child.on("close",code=>{clearTimeout(timer);resolve({code,text});});
    });
    expect(result.code).toBe(0);expect(JSON.parse(result.text)).toEqual({checks:21});
});
