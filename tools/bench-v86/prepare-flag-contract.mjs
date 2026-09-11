// Isolated idx21 helper-contract experiment. Shipping stays OFF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const vendor=path.join(root,'vendor/v86');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v86-flag-contract-'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest={dir,created:new Date().toISOString(),arms:{}};
const names=['fpu_get_sti_jit','f32_to_f80_jit','f64_to_f80_jit','i32_to_f80_jit','i64_to_f80_jit',
    'f80_to_f32','f80_to_f64','fpu_fadd','fpu_fmul','fpu_fsub','fpu_fsubr','fpu_fdiv','fpu_fdivr','fpu_push','fpu_pop',
    'instr16_D9_6_reg','instr16_D9_7_reg'];
// Deliberately wrong contract, only for demonstrating regression sensitivity.
manifest.mutation = process.argv.includes('--mutate-fcomi');
if (manifest.mutation) names.push('fpu_fcomi');
manifest.sseContracts = process.argv.includes('--sse');
if (manifest.sseContracts) names.push('instr_0F16', 'instr_660F59');
for(const arm of ['baseline','candidate']){
    const dst=path.join(dir,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
    for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
    for(const name of ['zstddeclib.o','libv86.mjs','v86.wasm'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
    const source=path.join(dst,'src/rust/wasmgen/wasm_builder.rs');
    if(arm==='candidate'){
        let s=fs.readFileSync(source,'utf8');
        const needle='        || name == "coverage_log"';
        if(s.split(needle).length!==2)throw Error('whitelist changed');
        s=s.replace(needle,needle+`
        // Exact contracts audited in cpu/fpu.rs, instructions.rs, instructions_0f.rs.
        // These calls touch FPU/SIMD state/status and dedicated conversion scratch only.
        // Current FPU exception helpers record SW bits, without delivering an interrupt.
        // Do NOT generalize to fpu_* or instr_*: FCOMI writes EFLAGS; FCMOV reads them.
        || matches!(name, ${names.map(n=>JSON.stringify(n)).join(' | ')})`);
        fs.writeFileSync(source,s);
        console.log(`BUILD ${dst}`);
        const p=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--',
            '-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096',
            '-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],
            {cwd:dst,encoding:'utf8',maxBuffer:8<<20});
        fs.writeFileSync(path.join(dst,'build.log'),p.stdout+p.stderr);
        if(p.status!==0)throw Error(p.stderr.slice(-6000));
        fs.copyFileSync(path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm'),path.join(dst,'build/v86.wasm'));
    }
    const wasm=path.join(dst,'build/v86.wasm');manifest.arms[arm]={wasm,hash:sha(wasm),source:sha(source)};
}
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
