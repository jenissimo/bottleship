// Isolated source experiment; shipping source and Wasm stay untouched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const vendor=path.resolve('vendor/v86'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'v86-wbuf-miss-'));
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const afterHot=process.argv.includes('--after-hot'),hashFirst=process.argv.includes('--hash-first');
if(afterHot&&hashFirst)throw Error('Choose one variant');
const manifest={directory,afterHot,hashFirst,shippingHash:hash('public/v86.wasm'),hypothesis:hashFirst?'Use the canonical exact hash table directly instead of probing three hot descriptors first.':'Cache only missing WBUF descriptors; invalidate on register and clear. No caching of memory/capacity failures.',arms:{}};
console.log(directory);
for(const arm of ['baseline','candidate']){
 const dst=path.join(directory,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
 for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
 for(const name of ['libv86.mjs','zstddeclib.o'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
 if(arm==='candidate'){
  const f=path.join(dst,'src/rust/jit.rs');let source=fs.readFileSync(f,'utf8');
  const replace=(a,b)=>{if(source.split(a).length!==2)throw Error('Ambiguous source anchor '+a);source=source.replace(a,b);};
  if(hashFirst){
   const begin=source.indexOf('    for hot in WBUF_INTRINSIC_HOT {',source.indexOf('unsafe fn wbuf_intrinsic_execute_inner'));
   const end=source.indexOf('    // The control word is read AND written back',begin);
   if(begin<0||end<0)throw Error('Missing lookup anchors');
   source=source.slice(0,begin)+`    let start = wbuf_intrinsic_hash(target);
    for probe in 0..WBUF_INTRINSIC_PROBES {
        let candidate = WBUF_INTRINSIC_TABLE[(start + probe) & (WBUF_INTRINSIC_CAPACITY - 1)];
        if candidate.target == target { desc = candidate; break; }
        if candidate.target == 0 { break; }
    }
`+source.slice(end);
  }else{
  replace('unsafe fn wbuf_intrinsic_execute_inner(target: u32, esp: u32) -> i32 {',`// A miss certifies only registry absence, never memory validity or buffer capacity.
static mut WBUF_MISS_CACHE: [u32; 16] = [0; 16];
unsafe fn wbuf_intrinsic_execute_inner(target: u32, esp: u32) -> i32 {
    let miss_idx = ((target >> 4) & 15) as usize;
    ${afterHot?'':'if target != 0 && WBUF_MISS_CACHE[miss_idx] == target { return -1; }'}`);
  if(afterHot)replace('    if desc.target == 0 {\n        let start = wbuf_intrinsic_hash(target);','    if desc.target == 0 {\n        if target != 0 && WBUF_MISS_CACHE[miss_idx] == target { return -1; }\n        let start = wbuf_intrinsic_hash(target);');
  replace('    let start = wbuf_intrinsic_hash(target);\n    for probe in 0..WBUF_INTRINSIC_PROBES {\n        let idx = (start + probe) & (WBUF_INTRINSIC_CAPACITY - 1);\n        let slot = &mut WBUF_INTRINSIC_TABLE[idx];','    WBUF_MISS_CACHE = [0; 16];\n    let start = wbuf_intrinsic_hash(target);\n    for probe in 0..WBUF_INTRINSIC_PROBES {\n        let idx = (start + probe) & (WBUF_INTRINSIC_CAPACITY - 1);\n        let slot = &mut WBUF_INTRINSIC_TABLE[idx];');
  replace('    if desc.target == 0 || !wbuf_range_accessible(desc.ctrl_addr, 4, true) {','    if desc.target == 0 { WBUF_MISS_CACHE[miss_idx] = target; return -1; }\n    if !wbuf_range_accessible(desc.ctrl_addr, 4, true) {');
  replace('pub unsafe fn jit_wbuf_intrinsic_clear_registry() {','pub unsafe fn jit_wbuf_intrinsic_clear_registry() {\n    WBUF_MISS_CACHE = [0; 16];');
  }
  fs.writeFileSync(f,source);
 }
 const r=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--','-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096','-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],{cwd:dst,encoding:'utf8',maxBuffer:16<<20});
 fs.writeFileSync(path.join(dst,'build.log'),(r.stdout??'')+(r.stderr??''));if(r.status!==0)throw Error(r.error??r.stderr?.slice(-2000));
 const wasm=path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm');manifest.arms[arm]={wasm,hash:hash(wasm),bytes:fs.statSync(wasm).size};fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({arm,...manifest.arms[arm]}));
}
console.log(JSON.stringify({manifest:path.join(directory,'manifest.json'),baselineMatchesShipping:manifest.arms.baseline.hash===manifest.shippingHash}));
