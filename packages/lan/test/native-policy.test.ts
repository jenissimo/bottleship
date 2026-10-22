/// <reference types="bun" />
import {expect,test} from "bun:test";
import {NativeDestinationPolicy} from "../src/native-policy";
test("exclusive RAW destinations cannot observe foreign shared flows and release exactly once",()=>{
    const policy=new NativeDestinationPolicy(),a={},b={};
    const first=policy.acquire("::1",a,false)!,second=policy.acquire("::1",b,false)!;
    expect(policy.acquire("::1",a,true)).toBeNull();
    second();second();
    const raw=policy.acquire("::1",a,true)!;
    expect(policy.acquire("::1",b,false)).toBeNull();
    expect(policy.acquire("::1",b,true)).toBeNull();
    expect(policy.acquire("::2",b,true)).not.toBeNull();
    first();raw();raw();
    expect(policy.acquire("::1",b,true)).not.toBeNull();
});
