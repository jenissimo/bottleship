import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';
import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
const man=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const BASE=0x100000,DATA=0x103000,N=300000;
function fixture(bits){
 const b=new Uint8Array(4096),d=new DataView(b.buffer);
 [0x1badb002,0x10000,(-0x1badb002-0x10000)>>>0,BASE,BASE,BASE+4096,BASE+4096,BASE+0x40].forEach((v,i)=>d.setUint32(i*4,v,true));
 b.set([0,0,0,0,0,0,0,0,255,255,0,0,0,0x9a,0xcf,0,255,255,0,0,0,0x92,0xcf,0],0xc00);
 d.setUint16(0xc20,23,true);d.setUint32(0xc22,BASE+0xc00,true);
 const gate=0xc30+7*8,H=BASE+0x800;d.setUint16(gate,H&65535,true);d.setUint16(gate+2,8,true);b[gate+5]=0x8e;d.setUint16(gate+6,H>>>16,true);
 d.setUint16(0xcb8,127,true);d.setUint32(0xcba,BASE+0xc30,true);
 let p=0x40;const e=(...x)=>{b.set(x,p);p+=x.length;},u=x=>{d.setUint32(p,x>>>0,true);p+=4;};
 e(0x0f,0x01,0x15);u(BASE+0xc20);e(0xea);u(BASE+p+6);e(8,0);
 e(0x66,0xb8,0x10,0,0x8e,0xd8,0x8e,0xc0,0x8e,0xd0,0xbc);u(0x300000);
 e(0x0f,0x01,0x1d);u(BASE+0xcb8);e(0xdb,0xe3,0xb9);u(N);
 const loop=p;
 // An x87 instruction before the CR0 writer makes stale check propagation observable.
 e(0xd9,0xe8,0xdd,0xd8);
 e(0x83,0xf9,1,0x75,11,0x0f,0x20,0xc0,0x0d);u(bits);e(0x0f,0x22,0xc0);
 const faultIP=BASE+p;e(0xd9,0xe8);for(let i=0;i<8;i++)e(0xd8,0xc0);
 e(0xdd,0x1d);u(DATA);e(0x49,0x0f,0x85);u(loop-(p+4));e(0xf4);
 p=0x800;e(0x50,0x8b,0x44,0x24,4,0xa3);u(DATA+8); // Saved fault EIP, no error code for #NM.
 e(0xff,0x05);u(DATA+12);e(0x89,0x0d);u(DATA+16);
 e(0x0f,0x20,0xc0,0x25);u(~12);e(0x0f,0x22,0xc0,0x58,0xcf);
 return {b,faultIP};
}
const rows=[];
for(const bits of [4,8,12])for(const arm of ['interpreter','baseline','candidate']){
 const a=man.arms[arm==='interpreter'?'baseline':arm];if(createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex')!==a.hash)throw Error('Artifact drift');
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:a.wasm,log_level:0});await new Promise(r=>em.add_listener('emulator-loaded',r));
 try{
  const c=em.v86.cpu,w=c.wm.exports,im=fixture(bits);c.reboot_internal();c.reset_memory();c.load_multiboot(im.b.buffer);
  for(const [i,v]of SHIPPING_JIT)w.set_jit_config(i,v);w.set_jit_config(0,arm==='interpreter'?1:0);
  let jitFaults=0;const deliver=c.jit_imports.trigger_fault_end_jit;
  c.jit_imports.trigger_fault_end_jit=()=>{jitFaults++;return deliver();};
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>{em.stop();reject(Error('Timeout'));},20000);em.bus.register('cpu-event-halt',()=>{clearTimeout(t);em.stop();resolve();});em.run();});
  const got={lo:c.read32s(DATA)>>>0,hi:c.read32s(DATA+4)>>>0,eip:c.read32s(DATA+8)>>>0,faults:c.read32s(DATA+12)>>>0,ecxAtFault:c.read32s(DATA+16)>>>0,remaining:c.reg32[1],cr0:c.cr[0]&12,jitFaults};
  const want={lo:0,hi:0x40700000,eip:im.faultIP,faults:1,ecxAtFault:1,remaining:0,cr0:0,jitFaults:arm==='interpreter'?0:1};
  if(JSON.stringify(got)!==JSON.stringify(want))throw Error(JSON.stringify({arm,bits,got,want}));
  rows.push({arm,bits,got});console.log(JSON.stringify(rows.at(-1)));
 }finally{em.destroy();}
}
fs.writeFileSync(path.join(man.dir,'fault-delivery-results.json'),JSON.stringify(rows,null,2));
