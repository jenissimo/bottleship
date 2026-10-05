import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';
const manifest=JSON.parse(fs.readFileSync(process.argv[2])),directory=manifest.directory,engines={},paging=process.argv.includes('--paging');
const suffix=paging?'paged':'positive';
const hash=b=>createHash('sha256').update(b).digest('hex'),ctrl=0x10000,ring=0x11000,stack=0x12000,target=0x200000;
const wat=`(module (import "e" "f" (func $f (param i32 i32) (result i32))) (import "e" "m" (memory 1))
 (func (export "run") (param $n i32) (param $a i32) (param $b i32) (param $sp i32) (result i32)
 (local $sum i32) (block $done (loop $loop
 (br_if $done (i32.eqz (local.get $n)))
 (local.set $sum (i32.add (local.get $sum) (call $f (local.get $a) (local.get $sp))))
 (local.set $sum (i32.add (local.get $sum) (call $f (local.get $b) (local.get $sp))))
 (local.set $n (i32.sub (local.get $n) (i32.const 1))) (br $loop))) (local.get $sum))
 (func (export "hit") (param $n i32) (param $a i32) (param $b i32) (param $sp i32) (param $head i32) (result i32)
 (local $sum i32) (block $done (loop $loop (br_if $done (i32.eqz (local.get $n)))
 (i32.store (local.get $head) (i32.const 0))
 (local.set $sum (i32.add (local.get $sum) (call $f (local.get $a) (local.get $sp))))
 (i32.store (local.get $head) (i32.const 0))
 (local.set $sum (i32.add (local.get $sum) (call $f (local.get $b) (local.get $sp))))
 (local.set $n (i32.sub (local.get $n) (i32.const 1))) (br $loop))) (local.get $sum)))`;
if(fs.existsSync(path.join(directory,'fixed-work-'+suffix+'.json')))throw Error('Refusing to overwrite evidence');
fs.writeFileSync(path.join(directory,'loop-positive.wat'),wat);
const assembly=spawnSync('C:/Projects/emsdk/upstream/bin/wasm-as.exe',[path.join(directory,'loop-positive.wat'),'-o',path.join(directory,'loop-positive.wasm')],{encoding:'utf8'});if(assembly.status!==0)throw Error(assembly.stderr);
const module=new WebAssembly.Module(fs.readFileSync(path.join(directory,'loop-positive.wasm'))),checks=[],rows=[];
try{
 for(const arm of ['baseline','candidate']){
  const spec=manifest.arms[arm];assert.equal(hash(fs.readFileSync(spec.wasm)),spec.hash);
  const em=new V86({autostart:false,memory_size:16<<20,wasm_path:spec.wasm,log_level:0});engines[arm]={em};await new Promise(r=>em.add_listener('emulator-loaded',r));
  const c=em.v86.cpu,w=c.wm.exports;c.reboot_internal();c.reset_memory();
  const view=()=>new DataView(c.mem8.buffer,c.mem8.byteOffset,c.mem8.byteLength),set=(a,x)=>view().setUint32(a,x,true);
  const pd=0x400000,pt=0x401000;
  if(paging){
   const base=0x100000,b=new Uint8Array(4096),d=new DataView(b.buffer);[0x1badb002,0x10000,(-0x1badb002-0x10000)>>>0,base,base,base+4096,base+4096,base+0x40].forEach((x,i)=>d.setUint32(i*4,x,true));
   b.set([0,0,0,0,0,0,0,0,255,255,0,0,0,0x9a,0xcf,0,255,255,0,0,0,0x92,0xcf,0],0xc00);d.setUint16(0xc20,23,true);d.setUint32(0xc22,base+0xc00,true);
   let pos=0x40;const e=(...x)=>{b.set(x,pos);pos+=x.length;},u=x=>{d.setUint32(pos,x>>>0,true);pos+=4;};
   e(0x0f,0x01,0x15);u(base+0xc20);e(0xea);u(base+pos+6);e(8,0,0x66,0xb8,0x10,0,0x8e,0xd8,0x8e,0xc0,0x8e,0xd0,0xbc);u(0x300000);
   e(0xb8);u(pd);e(0x0f,0x22,0xd8,0x0f,0x20,0xc0,0x0d);u(0x80010000);e(0x0f,0x22,0xc0,0xf4);
   c.load_multiboot(b.buffer);for(let i=0;i<4096;i++)set(pt+i*4,(i<<12)|3);for(let i=0;i<4;i++)set(pd+i*4,(pt+i*4096)|3);
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{em.stop();reject(Error('Paging setup timeout'));},10000);em.bus.register('cpu-event-halt',()=>{clearTimeout(timer);em.stop();resolve();});em.run();});assert.ok((c.cr[0]>>>0)&0x80000000);checks.push({arm,label:'paging entered through x86 CR0/CR3 instructions'});
  }
  const register=(addr=target,id=77)=>w.jit_wbuf_intrinsic_register(addr,id,0,1,1,ctrl,ring,4096);
  const invoke=(addr=target,sp=stack)=>w.jit_wbuf_intrinsic_execute(addr,sp);
  const decline=(label,addr=target,sp=stack)=>{const before=Buffer.from(c.mem8);assert.equal(invoke(addr,sp),-1,label);assert.ok(before.equals(Buffer.from(c.mem8)),label+' mutated guest memory');checks.push({arm,label});};
  w.jit_wbuf_intrinsic_clear_registry();w.jit_wbuf_intrinsic_set_enabled(1);set(stack,123);
  decline('first missing descriptor');decline('repeated missing descriptor');decline('zero target',0);
  for(let i=1;i<=32;i++)decline('colliding missing '+i,target+i*256);
  assert.equal(register(),1);set(ctrl,0);assert.equal(invoke(),4);assert.equal(view().getUint32(ring,true),77);assert.equal(view().getUint32(ring+4,true),123);checks.push({arm,label:'miss then registration succeeds'});
  set(ctrl,4096);decline('full ring');set(ctrl,0);assert.equal(invoke(),4);checks.push({arm,label:'capacity failure not cached'});
  decline('invalid stack',target,0xfffffff0);set(ctrl,0);assert.equal(invoke(),4);checks.push({arm,label:'memory failure not cached'});
  w.jit_wbuf_intrinsic_set_enabled(0);decline('disabled');w.jit_wbuf_intrinsic_set_enabled(1);set(ctrl,0);assert.equal(invoke(),4);checks.push({arm,label:'enable after disabled'});
  if(paging){
   const pte=a=>pt+(a>>>12)*4,protect=(a,value)=>{set(pte(a),value);w.full_clear_tlb();};
   protect(ctrl,0);decline('unmapped control page');protect(ctrl,ctrl|3);set(ctrl,0);assert.equal(invoke(),4);
   protect(ring,ring|1);decline('read-only destination WP');protect(ring,ring|3);set(ctrl,0);assert.equal(invoke(),4);
   protect(stack,(stack+4096)|3);decline('non-identity source');protect(stack,stack|3);set(ctrl,0);assert.equal(invoke(),4);
   protect(stack+4096,0);decline('source crosses unmapped page',target,stack+4094);protect(stack+4096,(stack+4096)|3);set(ctrl,0);assert.equal(invoke(),4);
   checks.push({arm,label:'paging failures recover without negative descriptor caching'});
  }
  w.jit_wbuf_intrinsic_clear_registry();w.jit_wbuf_intrinsic_set_enabled(1);decline('clear removes registration');assert.equal(register(target,88),1);set(ctrl,0);assert.equal(invoke(),4);assert.equal(view().getUint32(ring,true),88);checks.push({arm,label:'re-register new descriptor'});
  w.jit_wbuf_intrinsic_clear_registry();w.jit_wbuf_intrinsic_set_enabled(1);
  // A dense registry with two unregistered targets inside its address range.
  for(let i=0;i<114;i++)if(i!==50&&i!==51)assert.equal(register(target+i*16,100+i),1);
  for(let i=0;i<3;i++)assert.equal(w.jit_wbuf_intrinsic_mark_hot(i,target+i*16),1);
  const api=new WebAssembly.Instance(module,{e:{f:w.jit_wbuf_intrinsic_execute,m:c.wasm_memory}}).exports;
  const measure=(mode)=>{const n=4_000_000,get=mode==='hit'?w.jit_wbuf_intrinsic_get_hits:w.jit_wbuf_intrinsic_get_fallbacks,prior=get()>>>0,t0=performance.now(),result=mode==='hit'?api.hit(n,target,target+16,stack,c.mem8.byteOffset+ctrl):api.run(n,target+50*16,target+51*16,stack),ms=performance.now()-t0;assert.equal(result,mode==='hit'?8*n:-2*n);assert.equal(((get()>>>0)-prior)>>>0,2*n);return {arm,mode,ms,calls:2*n};};
  engines[arm]={em,measure};
 }
 fs.writeFileSync(path.join(directory,'correctness-'+suffix+'.json'),JSON.stringify({checks,paging,scope:'Real engine exports; registry lifecycle, collisions, disabled, capacity and memory failures. Guest memory unchanged on every decline. Optional paging cases include permissions, nonidentity and page crossing. No full SMC oracle or game acceptance.'},null,2));
 const summaries={};for(const mode of ['miss','hit']){
 for(let i=0;i<8;i++)engines[i&1?'candidate':'baseline'].measure(mode);
 const start=rows.length;for(let round=0;round<8;round++)for(const arm of ['baseline','candidate','candidate','baseline'])rows.push({round,...engines[arm].measure(mode)});
 const ratios=Array.from({length:8},(_,i)=>{const r=rows.slice(start+i*4,start+i*4+4);return Math.sqrt(r[0].ms*r[3].ms/(r[1].ms*r[2].ms));});
 const sorted=[...ratios].sort((a,b)=>a-b);summaries[mode]={medianRatio:(sorted[3]+sorted[4])/2,ratios};}
 fs.writeFileSync(path.join(directory,'fixed-work-'+suffix+'.json'),JSON.stringify({scope:'Node Wasm-to-Wasm imported-helper fixed work: missing descriptors and hot registered scalar writes; not game FPS or full registered-path acceptance',paging,manifest,checks:checks.length,rows,summaries},null,2));console.log(JSON.stringify({directory,paging,checks:checks.length,summaries}));
}finally{for(const e of Object.values(engines))e.em.destroy();}
