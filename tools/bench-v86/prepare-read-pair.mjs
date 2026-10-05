import {transform} from './experiments/read-pair-transform.mjs';
// Isolated code-shape experiment. Does not publish runtime bytes.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const vendor=path.resolve('vendor/v86');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v86-read-pair-'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function replace(s,from,to){if(s.split(from).length!==2)throw Error(`Unexpected source shape: ${from}`);return s.replace(from,to);}
const manifest={dir,experiment:'two same-base MOV reads with a shared translation guarded by range and original TLB hit',arms:{}};
for(const arm of ['baseline','candidate']){
 const dst=path.join(dir,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
 for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
 for(const name of ['v86.wasm','libv86.mjs','zstddeclib.o'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
 if(arm==='candidate')transform(dst);
 console.log(`BUILD ${arm}: ${dst}`);
 const p=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--','-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096','-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],{cwd:dst,encoding:'utf8',maxBuffer:8<<20});
 fs.writeFileSync(path.join(dst,'build.log'),p.stdout+p.stderr);if(p.status!==0)throw Error(p.stderr.slice(-4000));
 const wasm=path.join(dst,'build/v86.wasm');fs.copyFileSync(path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm'),wasm);
 manifest.arms[arm]={wasm,hash:sha(wasm)};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
}
if(manifest.arms.baseline.hash!==sha('logs/v86-20pct-baseline-20260905/v86.wasm'))throw Error('Rebuilt baseline differs from pinned objective baseline');
console.log(JSON.stringify(manifest,null,2));
