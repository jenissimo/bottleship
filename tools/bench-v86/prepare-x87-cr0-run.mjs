// Isolated code-shape experiment. Does not publish runtime bytes.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const vendor=path.resolve('vendor/v86');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v86-x87-cr0-run-'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function replace(s,from,to){if(s.split(from).length!==2)throw Error(`Unexpected source shape: ${from}`);return s.replace(from,to);}
const manifest={dir,experiment:'reuse CR0 EM/TS check through consecutive qualifying instructions within one basic block',arms:{}};
for(const arm of ['baseline','candidate']){
 const dst=path.join(dir,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
 for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
 for(const name of ['v86.wasm','libv86.mjs','zstddeclib.o'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
 if(arm==='candidate'){
  const jf=path.join(dst,'src/rust/jit.rs'),cf=path.join(dst,'src/rust/codegen.rs');
  let j=fs.readFileSync(jf,'utf8').replace(/\r\n/g,'\n');
  j=replace(j,'    pub fpu_simd_dirty_marked: bool,','    pub fpu_simd_dirty_marked: bool,\n    pub cr0_run_checked: bool,\n    pub cr0_run_kept: bool,');
  j=replace(j,'        fpu_simd_dirty_marked: false,','        fpu_simd_dirty_marked: false,\n        cr0_run_checked: false,\n        cr0_run_kept: false,');
  j=replace(j,'    ctx.fpu_simd_dirty_marked = false;','    ctx.fpu_simd_dirty_marked = false;\n    ctx.cr0_run_checked = false;');
  j=replace(j,'        jit_instructions::jit_instruction(ctx, &mut instruction_flags);','        ctx.cr0_run_kept = false;\n        jit_instructions::jit_instruction(ctx, &mut instruction_flags);\n        if !ctx.cr0_run_kept { ctx.cr0_run_checked = false; }');
  fs.writeFileSync(jf,j);
  let c=fs.readFileSync(cf,'utf8').replace(/\r\n/g,'\n');
  c=replace(c,'pub fn gen_task_switch_test(ctx: &mut JitContext) {','pub fn gen_task_switch_test(ctx: &mut JitContext) {\n    ctx.cr0_run_kept = true;\n    if ctx.cr0_run_checked { return; }\n    ctx.cr0_run_checked = true;');
  fs.writeFileSync(cf,c);
 }
 console.log(`BUILD ${arm}: ${dst}`);
 const p=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--','-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096','-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],{cwd:dst,encoding:'utf8',maxBuffer:8<<20});
 fs.writeFileSync(path.join(dst,'build.log'),p.stdout+p.stderr);if(p.status!==0)throw Error(p.stderr.slice(-4000));
 const wasm=path.join(dst,'build/v86.wasm');fs.copyFileSync(path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm'),wasm);
 manifest.arms[arm]={wasm,hash:sha(wasm)};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
}
if(manifest.arms.baseline.hash!==sha('logs/v86-20pct-baseline-20260905/v86.wasm'))throw Error('Rebuilt baseline differs from pinned objective baseline');
console.log(JSON.stringify(manifest,null,2));
