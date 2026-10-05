// Observe descriptor publication semantics separately from throughput acceptance.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {V86} from '../../vendor/v86/build/libv86.mjs';
const manifest=JSON.parse(fs.readFileSync(process.argv[2])),rows=[];
const output=path.join(manifest.directory,'hot-lifecycle.json');
assert.ok(!fs.existsSync(output),'Refusing to overwrite evidence');
for(const arm of ['baseline','candidate']){
 const spec=manifest.arms[arm];
 assert.equal(createHash('sha256').update(fs.readFileSync(spec.wasm)).digest('hex'),spec.hash);
 const em=new V86({autostart:false,memory_size:16<<20,wasm_path:spec.wasm,log_level:0});
 try{
  await new Promise(r=>em.add_listener('emulator-loaded',r));
  const c=em.v86.cpu,w=c.wm.exports;c.reboot_internal();c.reset_memory();
  const view=new DataView(c.mem8.buffer,c.mem8.byteOffset,c.mem8.byteLength);
  const target=0x200000,ctrl=0x10000,ring=0x11000,stack=0x12000;
  const register=id=>assert.equal(w.jit_wbuf_intrinsic_register(target,id,0,1,1,ctrl,ring,4096),1);
  const invoke=label=>{view.setUint32(ctrl,0,true);assert.equal(w.jit_wbuf_intrinsic_execute(target,stack),4);const id=view.getUint32(ring,true);rows.push({arm,label,id});return id;};
  w.jit_wbuf_intrinsic_clear_registry();w.jit_wbuf_intrinsic_set_enabled(1);
  register(77);assert.equal(w.jit_wbuf_intrinsic_mark_hot(0,target),1);
  assert.equal(invoke('initial hot descriptor'),77);
  register(88);invoke('updated canonical descriptor before re-mark');
  assert.equal(w.jit_wbuf_intrinsic_mark_hot(0,target),1);
  assert.equal(invoke('updated descriptor after re-mark'),88);
 }finally{em.destroy();}
}
fs.writeFileSync(output,JSON.stringify({scope:'Observation: no equivalence claim for register without re-marking a hot slot.',manifest,rows},null,2));
console.log(JSON.stringify({output,rows}));
