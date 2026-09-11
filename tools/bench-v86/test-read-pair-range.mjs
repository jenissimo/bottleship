// Controlled Wasm memory-model experiment, not installed v86 code or an ISA proof.
import assert from 'node:assert/strict';import fs from 'node:fs';
import {ModuleBuilder,OP as O,ALIGN as A} from '../aot/lib/wasm.mjs';
const TLB=0x10000,RAM=0x600000;
function build(delta,paired){
 const b=new ModuleBuilder(),entry=b.allocLocal(),addr=b.allocLocal();
 const address=d=>b.getLocal(0).constI32(d).op(O.I32ADD);
 const lookup=()=>{b.storeFixedI32(8,()=>b.loadFixedI32(8).constI32(1).op(O.I32ADD));b.getLocal(addr).constI32(12).op(O.I32SHRU).constI32(2).op(O.I32SHL).load(O.I32LOAD,A.B4,TLB).setLocal(entry);};
 const permission=()=>b.getLocal(entry).constI32(4041).op(O.I32AND).constI32(1).op(O.I32EQ);
 const physical=d=>{address(d);b.getLocal(entry).constI32(-4096).op(O.I32AND).op(O.I32XOR).load(O.I32LOAD,A.B1,0);};
 const read=(d,out)=>{
  address(d);b.setLocal(addr);lookup();permission();
  b.getLocal(addr).constI32(4095).op(O.I32AND).constI32(4092).op(O.I32LEU).op(O.I32AND).ifVoid();
  b.storeFixedI32(out,()=>physical(d));b.else_();
  b.storeFixedI32(out,()=>b.getLocal(addr).constI32(out/4).call('slow','ii_i'));b.end();
 };
 if(paired){
  b.getLocal(0).setLocal(addr);lookup();permission();
  if(!process.argv.includes('--omit-range')){
   b.getLocal(0).constI32(4095).op(O.I32AND).constI32(Math.max(0,-delta)).op(O.I32GEU).op(O.I32AND);
   b.getLocal(0).constI32(4095).op(O.I32AND).constI32(4096-Math.max(4,delta+4)).op(O.I32LEU).op(O.I32AND);
  }
  b.ifVoid();b.storeFixedI32(0,()=>physical(0));b.storeFixedI32(4,()=>physical(delta));
  b.else_();read(0,0);read(delta,4);b.end();
 }else{read(0,0);read(delta,4);}
 return b.finish().bytes;
}
const rows=[];
for(const delta of [-36,-8,0,8,16,36]){
 const engines=[];
 for(const paired of [false,true]){
  const memory=new WebAssembly.Memory({initial:128}),v=new DataView(memory.buffer),calls=[];
  let faultOperand=-1;
  const mod=new WebAssembly.Module(build(delta,paired));
  const instance=new WebAssembly.Instance(mod,{e:{m:memory,slow:(addr,operand)=>{calls.push({addr:addr>>>0,operand});if(operand===faultOperand)throw Error('modeled fault');return ((addr>>>0)^0x13579bdf)|0;}}});
  engines.push({v,calls,f:instance.exports.f,setFault:x=>{faultOperand=x;}});
 }
 let cases=0,fast=0;
 for(const base of [0x20000,0xfffff000])for(let low=0;low<4096;low++){
  const first=(base+low)>>>0,second=(first+delta)>>>0;
  for(const mode of ['ram','slow','fault-first','fault-second']){
   const out=[];
   for(const e of engines){
    e.calls.length=0;e.v.setUint32(0,0xaaaa,true);e.v.setUint32(4,0xbbbb,true);e.v.setUint32(8,0,true);
    e.setFault(mode==='fault-first'?0:mode==='fault-second'?1:-1);
    for(const page of new Set([first>>>12,second>>>12])){
     const physical=RAM+(page&1)*4096;
     e.v.setUint32(TLB+page*4,mode==='ram'?(((page<<12)^physical)|1)>>>0:0,true);
     for(let i=0;i<4096;i++)e.v.setUint8(physical+i,(i*17+page)&255);
    }
    let fault=false;try{e.f(first);}catch(err){if(err.message!=='modeled fault')throw err;fault=true;}
    out.push({values:[e.v.getUint32(0,true),e.v.getUint32(4,true)],calls:[...e.calls],fault,lookups:e.v.getUint32(8,true)});
   }
   assert.deepEqual({...out[1],lookups:0},{...out[0],lookups:0});
   if(out[1].lookups===1){assert.equal(mode,'ram');assert.equal(first>>>12,second>>>12);assert.equal(out[0].lookups,2);fast++;}
   cases++;
  }
 }
 rows.push({delta,cases,sharedFastCases:fast});console.log(JSON.stringify(rows.at(-1)));
}
fs.writeFileSync('logs/read-pair-range-contract.json',JSON.stringify({scope:'Controlled memory model; 32-bit wrap, crossing, slow effects, fault order; not actual v86 MMIO/IDT',rows},null,2));

