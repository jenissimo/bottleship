import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
import {parseModule,walkBody} from '../aot/lib/wdis.mjs';
const mutate=process.argv.includes('--mutate-shared-load');
function sharedLoads(bytes){
 const m=parseModule(bytes),ins=[...walkBody(bytes,m.code.instrStart,m.code.instrEnd)],sites=[];
 for(let i=0;i+8<ins.length;i++){
  const a=ins.slice(i,i+9);
  if(a.map(x=>x.op).join(',')!=='32,4,32,65,113,32,115,40,5'||a[3].imm!==-4096)continue;
  if(a[7].imm.align!==0||a[7].imm.offset!==0)continue;
  sites.push(a[7].imm.offsetAt);
 }
 return sites;
}
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),BASE=0x100000,DATA=0x103000,SRC=0x104000,N=300000;
function fixture(fence){
 const b=new Uint8Array(4096),d=new DataView(b.buffer);[0x1badb002,0x10000,(-0x1badb002-0x10000)>>>0,BASE,BASE,BASE+4096,BASE+4096,BASE+0x40].forEach((x,i)=>d.setUint32(i*4,x,true));
 let p=0x40;const e=(...x)=>{b.set(x,p);p+=x.length;},u=x=>{d.setUint32(p,x>>>0,true);p+=4;};
 e(0xb9);u(N);const loop=p;e(0xbe);u(SRC);e(0x8b,0x06);
 if(fence==='nop')e(0x90);if(fence==='branch')e(0xeb,0);if(fence==='base-write'){e(0xbe);u(SRC+64);}
 e(0x8b,0x56,8,0x01,0xd0,0xa3);u(DATA);e(0x49,0x0f,0x85);u(loop-(p+4));e(0xf4);return b;
}
const rows=[];
for(const fence of ['none','nop','branch','base-write'])for(const arm of ['interpreter','baseline','candidate']){
 const a=man.arms[arm==='interpreter'?'baseline':arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:a.wasm,log_level:0});await new Promise(r=>em.add_listener('emulator-loaded',r));
 try{
  const c=em.v86.cpu,w=c.wm.exports;c.reboot_internal();c.reset_memory();c.load_multiboot(fixture(fence).buffer);for(let i=0;i<256;i++)c.write32(SRC+i*4,i+1);
  for(const [i,v]of SHIPPING_JIT)w.set_jit_config(i,v);w.set_jit_config(0,arm==='interpreter'?1:0);
  globalThis.__wasmDump={out:[],keepLatestPerPage:true};
  let patched=0,recognized=0;
  c.test_hook_did_generate_wasm=bytes=>{
   const sites=sharedLoads(bytes);recognized+=sites.length;
   if(mutate&&arm==='candidate')for(const offset of sites){
    if(bytes[offset]!==0)throw Error('Mutation requires one-byte zero memarg');
    bytes[offset]=4;patched++;
   }
  };
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>{em.stop();reject(Error('timeout'));},20000);em.bus.register('cpu-event-halt',()=>{clearTimeout(t);em.stop();resolve();});em.run();});
  const result=c.read32s(DATA)>>>0;
  console.log(JSON.stringify({arm,fence,result,recognized,patched,mutation:mutate}));
  if(arm==='baseline'&&recognized!==0)throw Error('Shared-load recognizer matched baseline');
  if(arm==='candidate'&&(recognized>0)!==(fence==='none'))throw Error('Shared-load recognizer/fence mismatch');
  if(result!==(fence==='base-write'?20:4)||c.reg32[1]!==0)throw Error(`Incorrect result: ${result}; patched=${patched}`);
  const modules=globalThis.__wasmDump.out.map((m,i)=>{const file=path.join(man.dir,`${arm}-${fence}-${i}.wasm`);fs.writeFileSync(file,m.bytes);return {file,bytes:m.bytes.length,hash:createHash('sha256').update(m.bytes).digest('hex')};});
  if((arm==='interpreter')!==(modules.length===0))throw Error('JIT liveness mismatch');
  const row={arm,fence,result,modules};const base=rows.find(x=>x.arm==='baseline'&&x.fence===fence);
  if(arm==='candidate'){
   const same=JSON.stringify(modules.map(x=>x.hash))===JSON.stringify(base.modules.map(x=>x.hash));
   if(same===(fence==='none'))throw Error('Pair emission/fence byte identity mismatch');
  }
  rows.push(row);console.log(JSON.stringify(row));
 }finally{delete globalThis.__wasmDump;em.destroy();}
}
if(mutate)throw Error('Mutation survived all semantic checks');
fs.writeFileSync(path.join(man.dir,'jit-shape-results.json'),JSON.stringify(rows,null,2));
