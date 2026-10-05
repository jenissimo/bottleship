// Mechanism experiment: reuse existing helper-free DOD chaining on dynamic edges.
// Both arms are isolated. No runtime artifact is published by this script.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),vendor=path.join(root,'vendor/v86');
const memo=process.argv.includes('--memo');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v86-dynamic-chain-'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest={dir,created:new Date().toISOString(),experiment:'helper-free dynamic DOD lookup; stats-on uses original helper; shipping flags unchanged',arms:{}};
if(memo)manifest.experiment='inline dynamic memo hit; original resolver on miss; stats-on original path; shipping flags unchanged';
for(const arm of ['baseline','candidate']){
 const dst=path.join(dir,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
 for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
 for(const name of ['v86.wasm','libv86.mjs','zstddeclib.o'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
 const source=path.join(dst,'src/rust/jit.rs');
 if(arm==='candidate'){
  let s=fs.readFileSync(source,'utf8').replace(/\r\n/g,'\n');
  const start=s.indexOf('fn gen_chain_or_exit_to_known_successor(');
  const end=s.indexOf('\n/// Attribute this activation',start);
  if(start<0||end<0)throw Error('Direct-chain source shape changed');
  let clone=s.slice(start,end).replace('fn gen_chain_or_exit_to_known_successor(','fn gen_dynamic_chain_inline_experiment(');
  const guard='    if !block_chaining_enabled() {\n        codegen::gen_dispatch_stat_increment(ctx.builder, stat::MODULE_EXIT_CHAINABLE);\n        ctx.builder.br(ctx.exit_label);\n        return;\n    }\n';
  if(!clone.includes(guard))throw Error('Compile guard changed');
  clone=clone.replace(guard,'').replace('call_fn3_ret("jit_find_cache_entry_for_chaining")','call_fn3_ret("jit_find_cache_entry_for_dynamic_chaining")');
  if(memo){const lookup=clone.indexOf('    let lookup = ctx.builder.block_void();');if(lookup<0)throw Error('Lookup shape changed');clone=clone.slice(0,lookup)+fs.readFileSync(path.join(root,'tools/bench-v86/experiments/dynamic-chain-memo-body.rs'),'utf8');}
  // Diagnostic builds retain the exact existing counter/helper path. Runtime wrong-entry
  // verification also retains the original dynamic helper (the clone's early branch).
  const site='                        if ret_chaining_enabled() {\n                            codegen::gen_move_registers_from_locals_to_memory(ctx);';
  if(s.split(site).length!==2)throw Error('Dynamic site changed');
  s=s.replace(site,'                        if ret_chaining_enabled() && !dispatch_stats_enabled() {\n                            gen_dynamic_chain_inline_experiment(ctx, state_flags, block.last_instruction_addr);\n                        }\n                        else if ret_chaining_enabled() {\n                            codegen::gen_move_registers_from_locals_to_memory(ctx);');
  s=s.slice(0,start)+'// Isolated experiment; reuse validated direct-chain emission before refactoring.\n'+clone+'\n'+s.slice(start);
  fs.writeFileSync(source,s);
 }
 console.log(`BUILD ${arm}: ${dst}`);
 const p=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--','-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096','-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],{cwd:dst,encoding:'utf8',maxBuffer:8<<20});
 fs.writeFileSync(path.join(dst,'build.log'),p.stdout+p.stderr);if(p.status!==0)throw Error(p.stderr.slice(-5000));
 const wasm=path.join(dst,'build/v86.wasm');fs.copyFileSync(path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm'),wasm);
 manifest.arms[arm]={wasm,hash:sha(wasm),source:sha(source)};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
}
console.log(JSON.stringify(manifest,null,2));
