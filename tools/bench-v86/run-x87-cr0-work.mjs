import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const source=fs.readFileSync('tools/bench-v86/test-x87-cr0-shape.mjs','utf8');
const start=source.indexOf('function fixture('),end=source.indexOf('\nconst rows=[];',start);
if(start<0||end<0)throw Error('Fixture source changed');
const fixture=new Function('BASE','DATA','N',source.slice(start,end)+';return fixture;')(0x100000,0x103000,300000);
const interleaved=process.argv.includes('--interleaved');
const engines={};const rows=[];const iterations=interleaved?1000000:10000000;
const output=path.join(man.dir,interleaved?'fixed-work-interleaved.json':'fixed-work-results.json');
if(fs.existsSync(output))throw Error(`Refusing to overwrite ${output}`);
try{
 for(const arm of ['baseline','candidate']){
  const a=man.arms[arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
  const em=new V86({autostart:false,memory_size:16<<20,wasm_path:a.wasm,log_level:0});engines[arm]={em};
  await new Promise(r=>em.add_listener('emulator-loaded',r));const c=em.v86.cpu,w=c.wm.exports;
  c.reboot_internal();c.reset_memory();for(const [i,v]of SHIPPING_JIT)w.set_jit_config(i,v);c.load_multiboot(fixture('none').buffer);
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>{em.stop();reject(Error('warm timeout'));},20000);em.bus.register('cpu-event-halt',()=>{clearTimeout(t);em.stop();resolve();});em.run();});
  const meta=w.jit_debug_meta_lo(0x100)>>>0,slabs=w.jit_get_dispatch_slabs_ptr()>>>0;
  const state=new DataView(c.wasm_memory.buffer).getUint16(slabs+(meta&65535)*8192+0x47*2,true)-1;
  if(!meta||state<0)throw Error('JIT entry absent');
  engines[arm]={em,c,w,state,fn:c.wm.wasm_table.get((meta>>>16)+1024)};
 }
 function measure(arm){
  const {c,w,fn,state}=engines[arm];c.in_hlt[0]=0;c.instruction_pointer[0]=0x100047;c.reg32[1]=iterations;
  const v=new DataView(c.wasm_memory.buffer),hp=w.get_hypercall_page_ptr()>>>0;
  v.setUint32(hp,0x7fffffff,true);v.setUint32(hp+8,1,true);c.instruction_counter[0]=0;
  let calls=0;const begin=performance.now();
  do{
   if(c.instruction_pointer[0]!==0x100047)throw Error('Unexpected budget continuation entry');
   fn(state);calls++;
   if(calls>20000)throw Error('Fixed work did not finish');
  }while(!c.in_hlt[0]);
  const ms=performance.now()-begin;
  const out={ecx:c.reg32[1],lo:c.read32s(0x103000)>>>0,hi:c.read32s(0x103004)>>>0,halt:c.in_hlt[0],retired:c.instruction_counter[0]>>>0};
  if(out.ecx!==0||out.lo!==0||out.hi!==0x40700000||!out.halt)throw Error(JSON.stringify(out));
  if(out.retired!==iterations*12+1)throw Error('Retired work mismatch');
  return {arm,ms,iterations,calls,out};
 }
 const warmup=[];
 if(interleaved)for(let i=0;i<12;i++)warmup.push(measure(i%2?'candidate':'baseline'));
 for(let round=0;round<(interleaved?9:1);round++){
  for(const arm of ['baseline','candidate','candidate','baseline','baseline','baseline','candidate','candidate'])rows.push({round,...measure(arm)});
 }
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 const rounds=[];
 for(let i=0;i<rows.length;i+=8){const r=rows.slice(i,i+8).map(x=>x.ms);rounds.push({speedupPct:100*(Math.sqrt(r[0]*r[3]/(r[1]*r[2]))-1),aaPct:100*(r[4]/r[5]-1),ccPct:100*(r[6]/r[7]-1)});}
 const controls=rounds.flatMap(x=>[Math.abs(x.aaPct),Math.abs(x.ccPct)]);
 const summary={medianSpeedupPct:median(rounds.map(x=>x.speedupPct)),maxAbsControlPct:Math.max(...controls),positiveRounds:rounds.filter(x=>x.speedupPct>0).length,totalRounds:rounds.length};
 summary.signalAboveEveryControl=rounds.every(x=>x.speedupPct>summary.maxAbsControlPct);
 fs.writeFileSync(output,JSON.stringify({iterations,warmup,rows,rounds,summary,scope:'Warm emitted module, Node; host budget continuation included; not gameplay'},null,2));
 console.log(JSON.stringify({output,summary,rounds},null,2));
}finally{for(const e of Object.values(engines))e.em.destroy();}
