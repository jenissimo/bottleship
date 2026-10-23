import {expect,test} from "bun:test";
import {decodeOracle,decodePortAudit,fixtureConfig,fixtureNames,maintainedInputs,schemaArities,verifyX86Pe,type TaggedSchema} from "../lan-conformance/udp-connreset-artifacts";

const nonce=123456;
const schema:TaggedSchema={format:{magic:0x42534c4e,wordBytes:4,byteOrder:"little-endian",final:{tag:0xffff,payload:[0x53544147]}},tags:{"0x1000/0x1001":["value"],"0xfffe":["code","access"]}};
function words(body:number[],magic=0x42534c4e){const values=[magic,body.length+3,nonce,...body],bytes=new Uint8Array(values.length*4),view=new DataView(bytes.buffer);values.forEach((value,index)=>view.setUint32(index*4,value,true));return bytes;}
const footer=[0xffff,1,0x53544147];

for(const fixture of fixtureNames)test("maintained "+fixture+" is byte-identical to its measured C/schema",async()=>{
    const config=fixtureConfig(fixture),inputs=await maintainedInputs(config);
    expect(schemaArities(inputs.schema).size).toBeGreaterThan(15);
    expect(config.observations).toBe(fixture.endsWith("-effect")?976:6168);
    expect(config.nativeMs).toBe(fixture.endsWith("-effect")?20000:45000);
    expect(config.hostMs).toBe(fixture.endsWith("-effect")?30000:60000);
});
test("maintained CLI modules can be imported without invoking their producers",async()=>{
    const prepare=await import("../lan-conformance/prepare-udp-connreset");
    const capture=await import("../lan-conformance/run-udp-connreset-native");
    expect(typeof prepare.main).toBe("function");expect(typeof capture.main).toBe("function");
});
test("tagged parser retains every unsigned word and accepts a nonzero-offset view",()=>{
    const raw=words([0x1000,1,0xffffffff,...footer]),backing=new Uint8Array(raw.length+8);backing.set(raw,4);
    expect(decodeOracle(backing.subarray(4,4+raw.length),nonce,schema)).toEqual([
        {tag:0x1000,wordIndex:3,words:[0xffffffff]},{tag:0xffff,wordIndex:6,words:[0x53544147]},
    ]);
});
test("header, nonce, arity, unknown tag, truncation and final marker fail closed",()=>{
    const valid=words([0x1000,1,8,...footer]);
    expect(()=>decodeOracle(valid,nonce+1,schema)).toThrow();
    expect(()=>decodeOracle(words([0x1000,1,8,...footer],0),nonce,schema)).toThrow();
    const badLength=valid.slice();new DataView(badLength.buffer).setUint32(4,0,true);
    expect(()=>decodeOracle(badLength,nonce,schema)).toThrow();
    for(const body of [[0x1000,2,8,9,...footer],[0x9999,1,8,...footer],[0x1000,0xffffffff,...footer],[0x1000],[0x1000,1,8],[0xffff,1,0],[...footer,0x1000,1,8],[0xfffe,2,0xc0000005,1,...footer]]){
        expect(()=>decodeOracle(words(body),nonce,schema)).toThrow();
    }
});
test("schema rejects ambiguous grouped tags and duplicate numeric tags",()=>{
    expect(()=>schemaArities({...schema,tags:{"duplicate":["value"]}})).toThrow();
    expect(()=>schemaArities({...schema,tags:{"0x1":["value"],"0x01":["value"]}})).toThrow();
});
test("port audit validates exact nonce/family/port and deduplicates retirement identities",()=>{
    const raw=words([2,54321,23,54322,2,54321],0x42535054);
    expect(decodePortAudit(raw,nonce)).toEqual([{family:4,port:54321},{family:6,port:54322}]);
    expect(()=>decodePortAudit(raw,nonce+1)).toThrow();
    for(const body of [[2],[2,0],[99,1000],[23,65536]])expect(()=>decodePortAudit(words(body,0x42535054),nonce)).toThrow();
});
test("x86 PE guard checks signedness-independent extent, machine and optional-header magic",()=>{
    const raw=new Uint8Array(96),view=new DataView(raw.buffer);raw[0]=77;raw[1]=90;view.setUint32(60,64,true);view.setUint32(64,0x4550,true);view.setUint16(68,0x14c,true);view.setUint16(88,0x10b,true);
    expect(()=>verifyX86Pe(raw)).not.toThrow();
    view.setUint16(68,0x8664,true);expect(()=>verifyX86Pe(raw)).toThrow();
    view.setUint32(60,0xffffffff,true);expect(()=>verifyX86Pe(raw)).toThrow();
    expect(()=>verifyX86Pe(new Uint8Array(3))).toThrow();
});
