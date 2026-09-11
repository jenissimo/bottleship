import {test} from 'node:test';import assert from 'node:assert/strict';
import {findCr0Tests,findReadTranslations,reviewAffinePairs,findDirectReadPairs,analyze} from './analyze-jit-wasm.mjs';
function fixture(){return [
 [65,580,2],[45,{offset:0},2],[65,12,2],[113,null,2],[4,null,2],
 [65,123,3],[16,0,3],[12,2,3],[11,null,2]
].map(([op,imm,depth],offset)=>({op,imm,depth,offset}));}
test('recognizes complete fault guard and preserves evidence',()=>{
 const s=findCr0Tests(fixture(),['task_switch_test_jit']);assert.equal(s.length,1);assert.equal(s[0].testedAddress,580);assert.equal(s[0].faultEipPageOffset,123);
});
test('rejects lookalikes: other mask/helper, non-exiting branch, broken scope',()=>{
 for(const mutate of [a=>a[2].imm=8,a=>a[6].imm=1,a=>a[7].imm=0,a=>a[8].depth=3]){
  const a=fixture();mutate(a);assert.deepEqual(findCr0Tests(a,['task_switch_test_jit','other']),[]);
 }
});
test('truncated pattern and invalid wasm cannot produce plausible counts',()=>{
 assert.deepEqual(findCr0Tests(fixture().slice(0,8),['task_switch_test_jit']),[]);
 assert.throws(()=>analyze(new Uint8Array([0,97,115,109])));
});
function readFixture(){return [[32,10],[65,12],[118,null],[65,2],[116,null],[40,{offset:1000}],[34,12],[65,4041],[113,null],[65,1],[70,null],[32,10],[65,4095],[113,null],[65,4092],[76,null],[113,null],[13,0],[32,10],[65,200],[16,0]].map(([op,imm],offset)=>({op,imm,offset,depth:3}));}
test('read translation recognition checks range, address, helper width and control scope',()=>{
 const imports=['safe_read32s_slow_jit'];const r=findReadTranslations(readFixture(),imports);assert.equal(r.length,1);assert.equal(r[0].bytes,4);assert.equal(r[0].tlbBase,1000);
 for(const mutate of [a=>a[1].imm=11,a=>a[11].imm=9,a=>a[14].imm=4094,a=>a[17].imm=1,a=>a[20].depth=4]){const a=readFixture();mutate(a);assert.deepEqual(findReadTranslations(a,imports),[]);}
 assert.deepEqual(findReadTranslations(readFixture(),['unrelated_helper']),[]);
});
test('affine address evidence requires the immediate defining expression',()=>{
 const prefix=[[32,6],[65,-24],[106,null],[33,10],[65,0],[33,12],[2,null]].map(([op,imm],offset)=>({op,imm,offset,depth:2}));
 const report=findReadTranslations([...prefix,...readFixture()],['safe_read32s_slow_jit']);
 assert.deepEqual(report[0].addressForm,{kind:'local-plus-constant',baseLocal:6,displacement:-24});
 prefix[2].op=0x6b;
 assert.equal(findReadTranslations([...prefix,...readFixture()],['safe_read32s_slow_jit'])[0].addressForm.kind,'unknown');
});
test('pair review rejects recycled bases and exposes effects instead of claiming equivalence',()=>{
 const sites=[0,4].map((wasmOffset,i)=>({wasmOffset,addressForm:{kind:'local-plus-constant',baseLocal:6,displacement:i*4},bytes:4,permissionMask:4041,tlbBase:1000}));
 const ins=[{offset:0,op:32,imm:6},{offset:1,op:16,imm:0},{offset:2,op:54},{offset:3,op:13},{offset:4,op:32,imm:6}];
 const r=reviewAffinePairs(ins,sites,['unknown-effect'])[0];assert.equal(r.status,'requires-control-flow-and-effects-proof');assert.equal(r.calls[0].name,'unknown-effect');assert.equal(r.storeOperations,1);assert.equal(r.rangeBytes,8);
 ins[2]={offset:2,op:33,imm:6};assert.equal(reviewAffinePairs(ins,sites,[])[0].status,'rejected-base-redefined');
});
test('direct pair selection checks exact tail, register aliasing and scope',()=>{
 const raw=[[16,0],[34,12],[65,1],[113,null],[13,3],[11,null],[32,12],[65,-4096],[113,null],[32,13],[115,null],[40,{offset:0}],[33,1],[32,6],[65,-20],[106,null],[33,13],[65,0],[33,12],[2,null],[32,13]];
 const ins=raw.map(([op,imm],offset)=>({op,imm,offset,depth:offset<5||offset===20?4:3}));
 const site=(wasmOffset,displacement)=>({wasmOffset,helperOffset:0,bytes:4,addressForm:{kind:'local-plus-constant',baseLocal:6,displacement},entryLocal:12,addressLocal:13,permissionMask:4041,tlbBase:1000});
 const sites=[site(-1,-28),site(20,-20)];assert.equal(findDirectReadPairs(ins,sites)[0].upper,4084);
 ins[12].imm=6;assert.deepEqual(findDirectReadPairs(ins,sites),[]);ins[12].imm=1;
 ins[13].op=16;assert.deepEqual(findDirectReadPairs(ins,sites),[]);ins[13].op=32;
 ins[10].depth=4;assert.deepEqual(findDirectReadPairs(ins,sites),[]);
});
