// Isolated MOVHPS/MOVLHPS inline experiment against shipping; no idx21 changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),vendor=path.join(root,'vendor/v86');
const mulpdSimd=process.argv.includes('--mulpd-simd');
const mulpdScalarOrder=process.argv.includes('--mulpd-scalar-order');
if(mulpdSimd&&mulpdScalarOrder)throw Error('choose one lowering');
const mulpd=mulpdSimd||mulpdScalarOrder||process.argv.includes('--mulpd');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),mulpd?'v86-mulpd-':'v86-sse-move-'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest={dir,created:new Date().toISOString(),experiment:'inline SSE high-half moves; shipping idx21=0',arms:{}};
if(mulpd)manifest.experiment='inline MULPD over current shipping MOV inline; idx21=0';
if(mulpdSimd)manifest.experiment='inline MULPD SIMD matching helper operand order; idx21=0';
if(mulpdScalarOrder)manifest.experiment='inline scalar MULPD matching compiled helper operand order; idx21=0';
manifest.mulpdMode=mulpdSimd?'simd':mulpdScalarOrder?'scalar-order':mulpd?'guarded':null;
manifest.mutation=process.argv.includes('--mutate-before-read');
const installed=fs.readFileSync(path.join(vendor,'src/rust/jit_instructions.rs'),'utf8').includes('// Same faulting read as the helper path;');
const scalarInstalled=fs.readFileSync(path.join(vendor,'src/rust/jit_instructions.rs'),'utf8').includes("// Match the compiled helper's destination * source operand order.");
const patch=path.join(root,'tools/bench-v86/experiments/sse-move-inline.patch');
for(const arm of ['baseline','candidate']){
    const dst=path.join(dir,arm);fs.mkdirSync(path.join(dst,'build'),{recursive:true});
    for(const name of ['src','crates','tools','.cargo','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(vendor,name),path.join(dst,name),{recursive:true});
    for(const name of ['v86.wasm','libv86.mjs','zstddeclib.o'])fs.copyFileSync(path.join(vendor,'build',name),path.join(dst,'build',name));
    const source=path.join(dst,'src/rust/jit_instructions.rs');
    if(scalarInstalled&&mulpd&&((arm==='baseline'&&mulpdScalarOrder)||(arm==='candidate'&&!mulpdScalarOrder))){
        const p=spawnSync('git',['apply','--reverse',path.join(root,'tools/bench-v86/experiments/mulpd-inline-scalar-order.patch')],{cwd:dst,encoding:'utf8'});
        if(p.status!==0)throw Error(p.stderr);
    }
    if(!mulpd&&((arm==='baseline'&&installed)||(arm==='candidate'&&!installed))){
        const p=spawnSync('git',['apply',...(installed?['--reverse']:[]),patch],{cwd:dst,encoding:'utf8'});
        if(p.status!==0)throw Error(p.stderr);
    }
    if(mulpd&&arm==='candidate'&&!(scalarInstalled&&mulpdScalarOrder)){
        if(manifest.mutation)throw Error('MOV mutation does not apply to MULPD');
        const p=spawnSync('git',['apply',path.join(root,`tools/bench-v86/experiments/${mulpdSimd?'mulpd-inline-simd':mulpdScalarOrder?'mulpd-inline-scalar-order':'mulpd-inline'}.patch`)],{cwd:dst,encoding:'utf8'});
        if(p.status!==0)throw Error(p.stderr);
    }
    if(arm==='candidate'&&manifest.mutation){
        let s=fs.readFileSync(source,'utf8').replace(/\r\n/g,'\n');
        const replace=(from,to)=>{if(s.split(from).length!==2)throw Error('source shape changed');s=s.replace(from,to);};
        replace('    // Same faulting read as the helper path; write only the high 64 bits after it succeeds.',
`    // Deliberately incorrect early write: fault regression must observe this damage.
    ctx.builder.const_i32(global_pointers::get_reg_xmm_offset(r) as i32 + 8);
    ctx.builder.const_i64(0);
    ctx.builder.store_aligned_i64(0);`);
        fs.writeFileSync(source,s);
    }
    {
        // Rebuild BOTH arms from the copied sources, also after the optimization is integrated.
        console.log(`BUILD ${dst}`);
        const p=spawnSync('cargo',['rustc','--release','--target','wasm32-unknown-unknown','--',
            '-C','linker=tools/rust-lld-wrapper.cmd','-C','link-args=--import-table --global-base=4096',
            '-C','link-args=build/zstddeclib.o','-C','target-feature=+bulk-memory','-C','target-feature=+multivalue','-C','target-feature=+simd128'],
            {cwd:dst,encoding:'utf8',maxBuffer:8<<20});
        fs.writeFileSync(path.join(dst,'build.log'),p.stdout+p.stderr);if(p.status!==0)throw Error(p.stderr.slice(-6000));
        fs.copyFileSync(path.join(dst,'build/wasm32-unknown-unknown/release/v86.wasm'),path.join(dst,'build/v86.wasm'));
    }
    const wasm=path.join(dst,'build/v86.wasm');manifest.arms[arm]={wasm,hash:sha(wasm),source:sha(source)};
}
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
