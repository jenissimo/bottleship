// Experimental offline pass over selected captured modules; never writes the input cache.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [input,engine,optimizer,out,...pageArgs]=process.argv.slice(2);
if(!input||!engine||!optimizer||!out||!pageArgs.length)throw Error('Expected input-cache engine.wasm wasm-opt.exe NEW-output-dir physical-page-address...');
const sha=b=>createHash('sha256').update(b).digest('hex');
const index=JSON.parse(fs.readFileSync(path.join(input,'index.json'))),pages=pageArgs.map(x=>Number(x)>>>12);
if(index.version.engine!==sha(fs.readFileSync(engine)))throw Error('Engine hash mismatch');
if(fs.existsSync(out))throw Error('Output must be new');
const flags=['-O3','--enable-simd','--enable-bulk-memory','--enable-mutable-globals','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-reference-types','--enable-tail-call'];
const version=spawnSync(optimizer,['--version'],{encoding:'utf8'});if(version.status!==0)throw Error(version.stderr);
fs.mkdirSync(out,{recursive:true});const report=[];
for(const u of index.units){
 if(!/^[a-zA-Z0-9_.-]+\.wasm$/.test(u.file)||u.relocs?.length)throw Error('Unsupported unit');
 const src=path.join(input,u.file),dst=path.join(out,u.file),before=fs.readFileSync(src);
 const selected=u.pages.some(p=>pages.includes(p.physPage));
 if(selected){const r=spawnSync(optimizer,[src,...flags,'-o',dst],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
 else fs.copyFileSync(src,dst);
 const after=fs.readFileSync(dst);if(!WebAssembly.validate(after))throw Error('Wasm validation failed');
 u.bytes=after.length;report.push({file:u.file,idx:u.tableIndex,selected,before:before.length,after:after.length,inputSha256:sha(before),outputSha256:sha(after)});
}
fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(index,null,2));
fs.writeFileSync(path.join(out,'optimization.json'),JSON.stringify({optimizer:version.stdout.trim(),optimizerSha256:sha(fs.readFileSync(optimizer)),flags,pages,semanticGate:'Experimental: Wasm validation only; no production acceptance',units:report},null,2));
console.log(JSON.stringify(report.filter(r=>r.selected)));
