// Invoke the emitted callee module directly; a resolver-only test misses this experiment.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const source=fs.readFileSync('vendor/v86/tests/jit-alive-repro.mjs','utf8');
const from=source.indexOf('function build_image()'),to=source.indexOf('\nfunction run()',from);
if(from<0||to<0)throw Error('Fixture shape changed');
const image=new Function('BASE','ENTRY_OFF','PAGE1_OFF','ITER',source.slice(from,to)+';return build_image();')(0x100000,0x20,0x1000,400000);
const RET=0x10002f,CALLEE=0x101000,STACK=0x103000;
async function boot(wasm,tier2){
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:wasm,log_level:0});
 await new Promise(r=>em.add_listener('emulator-loaded',r));
 const c=em.v86.cpu,w=c.wm.exports;
 c.reboot_internal();c.reset_memory();c.set_jit_config(1,1);c.set_jit_config(12,1);c.set_jit_config(15,tier2?1e9:0);c.set_jit_config(27,1);w.set_dispatch_stats(0);c.load_multiboot(image.buffer.slice(0));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{em.stop();reject(Error('Warmup timeout'));},20000);em.bus.register('cpu-event-halt',()=>{clearTimeout(timer);em.stop();resolve();});em.run();});
 return {em,c,w};
}
const observeHelper=process.argv.includes('--observe-helper');
const cases=['hit','cold-hit','mixed-hash','small-memo','small-mixed-memo','urgent','exhausted','hlt','legacy-zero','missing-entry','state-mismatch','tlb-flush','invalidate-target','verify-hit'];
const rows=[];
for(const arm of ['baseline','candidate']){
 const a=man.arms[arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
 for(const tier2 of [false,true])for(const name of cases){
  const {em,c,w}=await boot(a.wasm,tier2);
  try{
   const v=new DataView(c.wasm_memory.buffer),hp=w.get_hypercall_page_ptr()>>>0;
   const meta=w.jit_get_dispatch_meta_ptr()>>>0,slabs=w.jit_get_dispatch_slabs_ptr()>>>0;
   const calleeMeta=w.jit_debug_meta_lo(CALLEE>>>12)>>>0;
   const state=v.getUint16(slabs+(calleeMeta&65535)*8192,true)-1;
   const fn=c.wm.wasm_table.get((calleeMeta>>>16)+1024);
   if(!calleeMeta||state<0||!fn)throw Error('Callee module not published');
   c.reg32[1]=10;c.reg32[4]=STACK-4;c.write32(STACK-4,RET);c.instruction_pointer[0]=CALLEE;c.in_hlt[0]=0;
   v.setUint32(hp+8,1,true);v.setUint32(hp,0x7fffffff,true);
   if(name==='cold-hit')c.set_jit_config(25,c.get_jit_config(25));
   if(name==='mixed-hash'||name==='small-mixed-memo')c.set_jit_config(26,1);
   if(name==='small-memo'||name==='small-mixed-memo')c.set_jit_config(25,4);
   if(name==='urgent')v.setUint32(hp,0,true);
   if(name==='exhausted'){v.setUint32(hp,1,true);c.instruction_counter[0]=-1;}
   if(name==='hlt')c.in_hlt[0]=1;
   if(name==='legacy-zero'){v.setUint32(hp,0,true);v.setUint32(hp+8,0,true);}
   if(name==='missing-entry'||name==='state-mismatch'){
    // Synthetic metadata perturbation; invalidate the old memo first, as real
    // invalidation does. This is not a substitute for the real TLB/SMC cases below.
    c.set_jit_config(25,c.get_jit_config(25));
    const m=w.jit_debug_meta_lo(RET>>>12)>>>0;
    if(name==='missing-entry')v.setUint16(slabs+(m&65535)*8192+(RET&4095)*2,0,true);
    else v.setUint32(meta+(RET>>>12)*8+4,(w.jit_debug_meta_hi(RET>>>12)^1)>>>0,true);
   }
   if(name==='tlb-flush')c.full_clear_tlb();
   if(name==='invalidate-target'){c.mem8[RET]=0x41;c.jit_dirty_cache(RET,RET+1);}
   if(name==='verify-hit')c.set_jit_config(24,2);
   const before=c.instruction_counter[0]>>>0,entries=w.jit_get_tier2_chain_entries();
   // Deliberately enable only runtime helper counters AFTER compilation, without
   // clearing this module. This observes helper use, not a full dispatch census.
   if(observeHelper)w.set_dispatch_stats(1);
   const helperBefore=w.profiler_dispatch_stat_get(11)>>>0;
   fn(state);
   const helperHits=((w.profiler_dispatch_stat_get(11)>>>0)-helperBefore)>>>0;
   const out={ecx:c.reg32[1]>>>0,esp:c.reg32[4]>>>0,eip:c.instruction_pointer[0]>>>0,eflags:c.get_eflags()>>>0,halt:c.in_hlt[0],retired:((c.instruction_counter[0]>>>0)-before)>>>0,chains:w.jit_get_tier2_chain_entries()-entries};
   if(name==='hit'&&(out.ecx!==9||out.chains!==1))throw Error(`Fast chain did not execute: ${JSON.stringify(out)}`);
   if(['cold-hit','mixed-hash','small-memo','small-mixed-memo'].includes(name)&&(out.ecx!==9||out.chains!==1))throw Error('Cold fallback did not execute one chain');
   if(observeHelper&&name==='hit'&&helperHits!==(arm==='baseline'?1:0))throw Error(`Expected memo hit helper count differs: ${arm} ${helperHits}`);
   if(observeHelper&&['cold-hit','mixed-hash','small-memo','small-mixed-memo','verify-hit'].includes(name)&&helperHits!==1)throw Error('Expected original helper fallback');
   if(['urgent','exhausted','hlt','missing-entry','state-mismatch','tlb-flush','invalidate-target'].includes(name)&&(out.ecx!==10||out.chains!==0))throw Error(`Invalid target/budget crossed: ${name} ${JSON.stringify(out)}`);
   const old=rows.find(r=>r.arm==='baseline'&&r.tier2===tier2&&r.name===name);
   if(arm==='candidate'&&JSON.stringify(out)!==JSON.stringify(old.out))throw Error(`Mismatch ${name} ${JSON.stringify({old:old.out,out})}`);
   rows.push({arm,tier2,name,out,...(observeHelper?{helperHits}:{})});console.log(`${arm} tier2=${tier2} ${name}: ${JSON.stringify(out)}${observeHelper?' helperHits='+helperHits:''}`);
  }finally{em.destroy();}
 }
}
fs.writeFileSync(path.join(man.dir,'emitted-boundaries.json'),JSON.stringify({cases,rows},null,2));
