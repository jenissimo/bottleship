import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';
import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
import {analyze} from './analyze-jit-wasm.mjs';
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const BASE=0x100000,DATA=0x103000,N=300000;
function fixture(fence){
 const b=new Uint8Array(4096),v=new DataView(b.buffer);
 [0x1badb002,0x10000,(-0x1badb002-0x10000)>>>0,BASE,BASE,BASE+4096,BASE+4096,BASE+0x40].forEach((x,i)=>v.setUint32(i*4,x,true));
 let p=0x40;const e=(...x)=>{b.set(x,p);p+=x.length;},u=x=>{v.setUint32(p,x>>>0,true);p+=4;};
 e(0xdb,0xe3,0xb9);u(N);const start=p;
 const fp=(...bytes)=>{e(...bytes);if(fence==='nop')e(0x90);if(fence==='branch')e(0xeb,0);};
 fp(0xd9,0xe8);for(let i=0;i<8;i++)fp(0xd8,0xc0);
 e(0xdd,0x1d);u(DATA);e(0x49,0x0f,0x85);u(start-(p+4));e(0xf4);
 return b;
}
const rows=[];
for(const fence of ['none','nop','branch'])for(const arm of ['interpreter','baseline','candidate']){
 const a=manifest.arms[arm==='interpreter'?'baseline':arm];
 if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:a.wasm,log_level:0});
 await new Promise(r=>em.add_listener('emulator-loaded',r));
 try{
  const c=em.v86.cpu,w=c.wm.exports;
  c.reboot_internal();c.reset_memory();for(const [i,x]of SHIPPING_JIT)w.set_jit_config(i,x);
  w.set_jit_config(0,arm==='interpreter'?1:0);c.load_multiboot(fixture(fence).buffer);
  const faultObservations=[];let faultPrepared=0;
  const prepare=c.jit_imports.task_switch_test_jit;
  c.jit_imports.task_switch_test_jit=(offset)=>{faultPrepared++;return prepare(offset);};
  // Observe the fault epilogue before interrupt delivery. Full IDT delivery is
  // a separate contract; never describe this interception as a delivered #NM.
  c.jit_imports.trigger_fault_end_jit=()=>{faultObservations.push(c.instruction_pointer[0]>>>0);};
  globalThis.__wasmDump={out:[],keepLatestPerPage:true};
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>{em.stop();reject(Error('Timeout'));},30000);em.bus.register('cpu-event-halt',()=>{clearTimeout(t);em.stop();resolve();});em.run();});
  const out={ecx:c.reg32[1]>>>0,lo:c.read32s(DATA)>>>0,hi:c.read32s(DATA+4)>>>0};
  if(out.ecx!==0||out.lo!==0||out.hi!==0x40700000)throw Error(`Wrong result ${JSON.stringify(out)}`);
  const mods=globalThis.__wasmDump.out;
  if((arm==='interpreter')!==(mods.length===0))throw Error('Unexpected JIT liveness');
  const reports=mods.map((m,i)=>{const file=path.join(manifest.dir,`${arm}-${fence}-${i}.wasm`);fs.writeFileSync(file,m.bytes);return analyze(m.bytes,file);});
  if(reports.some(x=>x.cr0.unrecognizedHelperSites))throw Error('Guard shape not recognized');
  const guards=reports.reduce((n,x)=>n+x.cr0.recognized,0);
  const faultChecks=[];
  if(arm!=='interpreter'){
   const loopIP=BASE+0x47;
   const meta=w.jit_debug_meta_lo(loopIP>>>12)>>>0;
   const slabs=w.jit_get_dispatch_slabs_ptr()>>>0;
   const state=new DataView(c.wasm_memory.buffer).getUint16(slabs+(meta&65535)*8192+(loopIP&4095)*2,true)-1;
   if(!meta||state<0)throw Error('Loop entry missing from emitted module');
   const fn=c.wm.wasm_table.get((meta>>>16)+1024);
   for(const bits of [4,8,12]){
    c.cr[0]=(c.cr[0]&~12)|bits;c.instruction_pointer[0]=loopIP;c.in_hlt[0]=0;c.reg32[1]=17;
    const hp=w.get_hypercall_page_ptr()>>>0,v=new DataView(c.wasm_memory.buffer);v.setUint32(hp,0x7fffffff,true);v.setUint32(hp+8,1,true);
    const n=faultObservations.length,p=faultPrepared;fn(state);
    if(faultObservations.length!==n+1||faultPrepared!==p+1||faultObservations.at(-1)!==loopIP||c.reg32[1]!==17)throw Error('Wrong fault preparation/epilogue');
    faultChecks.push({bits,eip:faultObservations.at(-1),ecx:c.reg32[1]});
   }
  }
  rows.push({arm,fence,out,guards,faultChecks,modules:reports.map(x=>({file:x.file,sha256:x.sha256,ops:x.ops,guards:x.cr0.recognized}))});
  const base=rows.find(x=>x.arm==='baseline'&&x.fence===fence);
  if(arm==='candidate'&&(fence==='none'?guards>=base.guards:guards!==base.guards))throw Error(`Guard reduction/fence mismatch ${fence}: ${base.guards} -> ${guards}`);
  console.log(JSON.stringify(rows.at(-1)));
 }finally{delete globalThis.__wasmDump;em.destroy();}
}
fs.writeFileSync(path.join(manifest.dir,'shape-results.json'),JSON.stringify(rows,null,2));
