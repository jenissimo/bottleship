import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const BASE=0x100000,PD=0x108000,PT=0x109000,FAULT=0x200000,VALID=0x210000,DATA=0x220000,N=300000;
const cases=[{name:'first',addr:FAULT,delta:8,operand:0},{name:'second',addr:FAULT-8,delta:8,operand:1},{name:'first-negative',addr:FAULT+8,delta:-8,operand:0},{name:'second-negative',addr:FAULT+4096,delta:-8,operand:1},{name:'first-cross',addr:FAULT-2,delta:8,operand:0},{name:'second-cross',addr:FAULT-10,delta:8,operand:1}];
function fixture(test){
 const b=new Uint8Array(4096),d=new DataView(b.buffer);[0x1badb002,0x10000,(-0x1badb002-0x10000)>>>0,BASE,BASE,BASE+4096,BASE+4096,BASE+0x40].forEach((x,i)=>d.setUint32(i*4,x,true));
 b.set([0,0,0,0,0,0,0,0,255,255,0,0,0,0x9a,0xcf,0,255,255,0,0,0,0x92,0xcf,0],0xc00);d.setUint16(0xc20,23,true);d.setUint32(0xc22,BASE+0xc00,true);
 const gate=0xc30+14*8,H=BASE+0x800;d.setUint16(gate,H&65535,true);d.setUint16(gate+2,8,true);b[gate+5]=0x8e;d.setUint16(gate+6,H>>>16,true);d.setUint16(0xcb8,127,true);d.setUint32(0xcba,BASE+0xc30,true);
 let p=0x40;const e=(...x)=>{b.set(x,p);p+=x.length;},u=x=>{d.setUint32(p,x>>>0,true);p+=4;};
 e(0x0f,0x01,0x15);u(BASE+0xc20);e(0xea);u(BASE+p+6);e(8,0);e(0x66,0xb8,0x10,0,0x8e,0xd8,0x8e,0xc0,0x8e,0xd0,0xbc);u(0x300000);
 e(0x0f,0x01,0x1d);u(BASE+0xcb8);e(0xb8);u(PD);e(0x0f,0x22,0xd8,0x0f,0x20,0xc0,0x0d);u(0x80000000);e(0x0f,0x22,0xc0);
 e(0xc7,0x05);u(PT+(FAULT>>>12)*4);u(0);e(0x0f,0x01,0x3d);u(FAULT);e(0xb9);u(N);
 const loop=p;e(0xbe);u(VALID);e(0x83,0xf9,1,0x75,5,0xbe);u(test.addr);e(0xb8);u(0xc0deface);e(0xba);u(0xdeadbeef);
 const firstIP=BASE+p;e(0x8b,0x06);const secondIP=BASE+p;e(0x8b,0x56,test.delta&255);
 e(0xa3);u(DATA);e(0x89,0x15);u(DATA+4);e(0x49,0x0f,0x85);u(loop-(p+4));e(0xf4);
 p=0x800;e(0x50,0xa3);u(DATA+32);e(0x89,0x15);u(DATA+36);e(0x0f,0x20,0xd0,0xa3);u(DATA+40);
 for(const [off,dest]of [[4,52],[8,48]]){e(0x8b,0x44,0x24,off,0xa3);u(DATA+dest);}
 e(0xff,0x05);u(DATA+56);e(0xc7,0x05);u(PT+(FAULT>>>12)*4);u(FAULT|3);e(0x0f,0x01,0x3d);u(FAULT);e(0x58,0x83,0xc4,4,0xcf);
 return {b,faultIP:test.operand?secondIP:firstIP};
}
const rows=[];
for(const test of cases)for(const arm of ['interpreter','baseline','candidate']){
 const a=man.arms[arm==='interpreter'?'baseline':arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:a.wasm,log_level:0});await new Promise(r=>em.add_listener('emulator-loaded',r));
 try{
  const c=em.v86.cpu,w=c.wm.exports,im=fixture(test);c.reboot_internal();c.reset_memory();c.load_multiboot(im.b.buffer);
  for(let i=0;i<1024;i++){c.write32(PD+i*4,0);c.write32(PT+i*4,(i<<12)|3);}c.write32(PD,PT|3);
  c.write32(VALID,11);c.write32(VALID+test.delta,22);c.write32(test.addr,42);c.write32(test.addr+test.delta,84);
  for(const [i,v]of SHIPPING_JIT)w.set_jit_config(i,v);w.set_jit_config(0,arm==='interpreter'?1:0);
  let jitFaults=0;const deliver=c.jit_imports.trigger_fault_end_jit;c.jit_imports.trigger_fault_end_jit=()=>{jitFaults++;return deliver();};
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>{em.stop();reject(Error('timeout'));},20000);em.bus.register('cpu-event-halt',()=>{clearTimeout(t);em.stop();resolve();});em.run();});
  const read=a=>c.read32s(a)>>>0;
  const got={first:read(DATA),second:read(DATA+4),eaxAtFault:read(DATA+32),edxAtFault:read(DATA+36),cr2:read(DATA+40),eip:read(DATA+48),error:read(DATA+52),faults:read(DATA+56),remaining:c.reg32[1],jitFaults};
  const want={first:42,second:84,eaxAtFault:test.operand?42:0xc0deface,edxAtFault:0xdeadbeef,cr2:Math.max(FAULT,test.addr+test.operand*test.delta),eip:im.faultIP,error:0,faults:1,remaining:0,jitFaults:arm==='interpreter'?0:1};
  if(JSON.stringify(got)!==JSON.stringify(want))throw Error(JSON.stringify({test,arm,got,want}));rows.push({name:test.name,arm,got});console.log(JSON.stringify(rows.at(-1)));
 }finally{em.destroy();}
}
fs.writeFileSync(path.join(man.dir,'pagefault-results.json'),JSON.stringify(rows,null,2));
