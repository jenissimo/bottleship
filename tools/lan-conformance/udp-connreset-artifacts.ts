/** Shared, side-effect-free validation for retained UDP_CONNRESET native captures. */
import {createHash} from "node:crypto";
import {readFile,stat} from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

export const fixtureNames = ["winsock-udp-connreset","winsock-udp-connreset-iocp-apc-effect"] as const;
export type FixtureName = typeof fixtureNames[number];
export interface OracleRecord {tag:number;wordIndex:number;words:number[]}
export interface FixtureConfig {
    name:FixtureName; sourceSha256:string; schemaSha256:string;
    executableName:string; observations:number; records:number;
    nativeMs:number; hostMs:number;
    historical:{nonce:number;executableSha256:string;referenceSha256:string;capture:string};
}
export const configurations:Record<FixtureName,FixtureConfig> = {
    "winsock-udp-connreset": {
        name:"winsock-udp-connreset",
        sourceSha256:"0ebf6960eb770d2f838cf3e0c5333faeb27a5d621aeecdd4e1f983016060a889",
        schemaSha256:"2dc2ce6bccea5a85e264e8304c0f619a486ab88f42f464885c2cdba7df337e69",
        executableName:"udp-connreset-portable.exe", observations:6168, records:560, nativeMs:45000, hostMs:60000,
        historical:{nonce:1766116734,executableSha256:"2c2380a94009daa129178d4d0deeb1cd16f2349db82628d57f302f82d74c4d84",
            referenceSha256:"4f6eca17e4e07820f6fa8cd198d1fa5313d7b6149df3e662528ee7c11ef1d14d",
            capture:"stage30-udp-connreset/portable-preparation/native-first"},
    },
    "winsock-udp-connreset-iocp-apc-effect": {
        name:"winsock-udp-connreset-iocp-apc-effect",
        sourceSha256:"ebeb8f4f47581068474289f70a1471c042ae51c1593e8aa1b76f80dbd91de9a3",
        schemaSha256:"ed0b7ed0f2e3c8236a91ef01bcce8a740bac8e46d891b2c8fde4f6a9ff08c67b",
        executableName:"udp-connreset-iocp-apc-effect.exe", observations:976, records:123, nativeMs:20000, hostMs:30000,
        historical:{nonce:1767128281,executableSha256:"2f598d655aa2d48585421cd37fa03b72c7604b1e01506952229c15308cbd3cae",
            referenceSha256:"d5bc21485228c64cc2c79f8b9cbaae2f1a1ad749fcb38ba5c245b2d158e9a28b",
            capture:"stage30-udp-connreset/iocp-apc-effect-preparation/native-first"},
    },
};
export const artifactDirectory = dirname(fileURLToPath(import.meta.url));
export const sha256 = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function boundedRead(path:string,maxBytes:number):Promise<Uint8Array> {
    const info=await stat(path);
    if(!info.isFile()||info.size>maxBytes)throw Error("Input exceeds artifact bound: "+path);
    const bytes=new Uint8Array(await readFile(path));
    if(bytes.length!==info.size)throw Error("Input changed while reading: "+path);
    return bytes;
}
export async function hashFile(path:string):Promise<string> {
    return sha256(await boundedRead(path,64*1024*1024));
}
export function fixtureConfig(name:string):FixtureConfig {
    if(!fixtureNames.includes(name as FixtureName))throw Error("Unknown UDP_CONNRESET fixture");
    return configurations[name as FixtureName];
}
export interface TaggedSchema {
    format:{magic:number;wordBytes:number;byteOrder:string;final:{tag:number;payload:number[]}};
    tags:Record<string,string[]|{fields:string[];tags?:number[]}>;
}
export function schemaArities(schema:TaggedSchema):Map<number,number> {
    if(schema.format.magic!==0x42534c4e||schema.format.wordBytes!==4||schema.format.byteOrder!=="little-endian")throw Error("Unsupported oracle schema");
    const result=new Map<number,number>();
    for(const [key,definition]of Object.entries(schema.tags)){
        const fields=Array.isArray(definition)?definition:definition.fields;
        const tags=!Array.isArray(definition)&&definition.tags?definition.tags:key.split("/").map(value=>{
            if(!/^0x[0-9a-f]+$/i.test(value))throw Error("Schema tag needs explicit grouped tags: "+key);
            return Number.parseInt(value,16);
        });
        if(!Array.isArray(fields))throw Error("Schema fields missing: "+key);
        for(const tag of tags){
            if(!Number.isInteger(tag)||tag<0||tag>0xffffffff||result.has(tag))throw Error("Invalid/duplicate schema tag");
            result.set(tag,fields.length);
        }
    }
    if(result.has(schema.format.final.tag))throw Error("Duplicate final schema tag");
    result.set(schema.format.final.tag,schema.format.final.payload.length);
    return result;
}
export function decodeOracle(raw:Uint8Array,nonce:number,schema:TaggedSchema):OracleRecord[] {
    if(!Number.isInteger(nonce)||nonce<0||nonce>0xffffffff||raw.length<12||raw.length%4||raw.length>131072)throw Error("Invalid oracle extent/nonce");
    const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),arities=schemaArities(schema),records:OracleRecord[]=[];
    if(view.getUint32(0,true)!==0x42534c4e||view.getUint32(4,true)*4!==raw.length||view.getUint32(8,true)!==nonce)throw Error("Oracle header/nonce mismatch");
    for(let offset=3;offset<raw.length/4;){
        if(offset+2>raw.length/4)throw Error("Truncated record header");
        const tag=view.getUint32(offset*4,true),count=view.getUint32((offset+1)*4,true);
        if(count>raw.length/4-offset-2||arities.get(tag)!==count)throw Error("Unknown tag/truncated record/schema arity mismatch");
        const words=Array.from({length:count},(_,i)=>view.getUint32((offset+2+i)*4,true));
        records.push({tag,wordIndex:offset,words});offset+=count+2;
        if(tag===schema.format.final.tag&&offset!==raw.length/4)throw Error("Data follows final marker");
    }
    const last=records.at(-1);
    if(!last||last.tag!==schema.format.final.tag||JSON.stringify(last.words)!==JSON.stringify(schema.format.final.payload))throw Error("Final marker missing");
    if(records.some(record=>record.tag===0xfffe))throw Error("Native exception observation is not an eligible capture");
    return records;
}
export function decodePortAudit(raw:Uint8Array,nonce:number):Array<{family:4|6;port:number}> {
    if(raw.length<12||raw.length%4||raw.length>4096||(raw.length/4-3)%2)throw Error("Invalid port audit extent");
    const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    if(v.getUint32(0,true)!==0x42535054||v.getUint32(4,true)*4!==raw.length||v.getUint32(8,true)!==nonce)throw Error("Port audit header mismatch");
    const ports:Array<{family:4|6;port:number}>=[];
    for(let offset=3;offset<raw.length/4;offset+=2){
        const af=v.getUint32(offset*4,true),port=v.getUint32((offset+1)*4,true);
        if((af!==2&&af!==23)||!port||port>65535)throw Error("Invalid audited endpoint");
        ports.push({family:af===2?4:6,port});
    }
    return [...new Map(ports.map(port=>[port.family+":"+port.port,port])).values()];
}
export function verifyX86Pe(bytes:Uint8Array):void {
    if(bytes.length<64||bytes[0]!==77||bytes[1]!==90)throw Error("Missing DOS PE header");
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),offset=view.getUint32(60,true);
    if(offset>bytes.length-26||view.getUint32(offset,true)!==0x4550||view.getUint16(offset+4,true)!==0x14c||view.getUint16(offset+24,true)!==0x10b)throw Error("Fixture is not x86 PE32");
}
export async function maintainedInputs(config:FixtureConfig) {
    const source=join(artifactDirectory,config.name+".c"),schemaPath=join(artifactDirectory,config.name+".schema.json");
    const sourceBytes=await boundedRead(source,65536),schemaBytes=await boundedRead(schemaPath,32768);
    if(sha256(sourceBytes)!==config.sourceSha256||sha256(schemaBytes)!==config.schemaSha256)throw Error("Maintained source/schema differs from measured inputs");
    const schema=JSON.parse(new TextDecoder().decode(schemaBytes)) as TaggedSchema;
    schemaArities(schema);
    return {source,schemaPath,sourceBytes,schemaBytes,schema};
}
export async function validateCapture(config:FixtureConfig,capture:string,pins=config.historical) {
    const maintained=await maintainedInputs(config), paths={
        build:join(capture,"build.json"),result:join(capture,"result.json"),source:join(capture,"fixture.c"),schema:join(capture,"schema.json"),
        executable:join(capture,config.executableName),reference:join(capture,"native/lan-oracle.bin"),audit:join(capture,"native/udp-port-audit.bin"),
    };
    const inputs=await Promise.all(Object.entries(paths).map(async([name,path])=>({name,path,bytes:await boundedRead(path,name==="executable"?16*1024*1024:name==="result"?2*1024*1024:131072)})));
    const values=Object.fromEntries(inputs.map(item=>[item.name,item.bytes])) as Record<keyof typeof paths,Uint8Array>;
    const build=JSON.parse(new TextDecoder().decode(values.build)),result=JSON.parse(new TextDecoder().decode(values.result));
    if(build.buildExit!==0||build.buildTimedOut||result.exit!==0||result.timedOut||result.buildExit!==0||result.buildTimedOut||!result.valid||!result.finalMarker||!result.auditValid)throw Error("Incomplete native capture");
    if(sha256(values.source)!==config.sourceSha256||sha256(values.schema)!==config.schemaSha256||build.sourceSha256!==config.sourceSha256||result.sourceSha256!==config.sourceSha256||result.sourceAfterSha256!==config.sourceSha256)throw Error("Capture source/schema identity mismatch");
    const executableSha256=sha256(values.executable),referenceSha256=sha256(values.reference);
    if(executableSha256!==pins.executableSha256||referenceSha256!==pins.referenceSha256||build.executableSha256!==executableSha256||result.executableSha256!==executableSha256||result.referenceSha256!==referenceSha256)throw Error("Native PE/reference identity mismatch");
    if(build.nonce!==pins.nonce||result.nonce!==pins.nonce)throw Error("Capture nonce mismatch");
    verifyX86Pe(values.executable);
    const records=decodeOracle(values.reference,pins.nonce,maintained.schema);
    if(values.reference.length/4-3!==config.observations||records.length!==config.records||result.observations!==config.observations||JSON.stringify(records)!==JSON.stringify(result.records))throw Error("Native word/record ledger mismatch");
    const ports=decodePortAudit(values.audit,pins.nonce),retired=result.portsRetirement;
    if(sha256(values.audit)!==result.auditSha256||!ports.length||!Array.isArray(retired)||retired.length!==ports.length||ports.some(port=>retired.filter((item:any)=>item.family===port.family&&item.port===port.port&&item.success===true).length!==1))throw Error("Port retirement evidence incomplete");
    const hashes=[...inputs.map(({name,path,bytes})=>({name,path,sha256:sha256(bytes)})),
        {name:"maintainedSource",path:maintained.source,sha256:config.sourceSha256},{name:"maintainedSchema",path:maintained.schemaPath,sha256:config.schemaSha256}];
    return {...maintained,paths,build,result,records,ports,hashes,executableSha256,referenceSha256,nonce:pins.nonce};
}
