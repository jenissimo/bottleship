// Optimize an exported AotCache directory, preserving its full replay identity.
// Usage: node tools/aot/optimize-cache.mjs <index.json> <engine.wasm> <NEW-output-dir>
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inlineRotate} from './lib/inline-rotate.mjs';
import {createShufpsSpecializer} from './lib/shufps-specialize.mjs';
const [input,engineFile,out]=process.argv.slice(2);
const both=process.argv[5]==='--both';
const shufps=process.argv[5]==='--shufps';
if(process.argv[5]&&!both&&!shufps)throw Error('Only --both or --shufps is supported as fourth argument');
if(!input||!engineFile||!out)throw Error('Expected index.json, engine.wasm, new output directory');
const hash=b=>createHash('sha256').update(b).digest('hex');
const engine=fs.readFileSync(engineFile),index=JSON.parse(fs.readFileSync(input,'utf8'));
const specialize=shufps?createShufpsSpecializer(engine):null;
if((index.version?.engine??index.jit_identity?.engine_sha256)!==hash(engine))throw Error('Cache engine identity mismatch');
if(fs.existsSync(out))throw Error('Output directory must be new');
const names=new Set(),pending=[],report=[];
for(const unit of index.units) {
    if(!Number.isInteger(unit.entryPage)||!/^[-a-zA-Z0-9_.]+\.wasm$/.test(unit.file)||names.has(unit.file)||unit.relocs?.length)throw Error('Unsupported unit filename or relocations');
    names.add(unit.file);
    const bytes=fs.readFileSync(path.join(path.dirname(input),unit.file));
    const r=shufps?specialize(bytes):inlineRotate(bytes,engine);
    if(both){const second=inlineRotate(r.bytes,engine,'rol32');r.bytes=second.bytes;r.sites+=second.sites;}
    pending.push({name:unit.file,bytes:r.bytes});
    report.push({file:unit.file,sites:r.sites,before:bytes.length,after:r.bytes.length,inputSha256:hash(bytes),outputSha256:hash(r.bytes)});
    unit.bytes=r.bytes.length;
}
fs.mkdirSync(out,{recursive:true});
for(const p of pending)fs.writeFileSync(path.join(out,p.name),p.bytes);
fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(index,null,2));
fs.writeFileSync(path.join(out,'optimization.json'),JSON.stringify({pass:shufps?'constant-shufps-v1':both?'exact-rotate32-v1':'exact-ror32-v1',engineSha256:hash(engine),units:report},null,2));
console.log(JSON.stringify({out,sites:report.reduce((n,r)=>n+r.sites,0),units:report.length}));
