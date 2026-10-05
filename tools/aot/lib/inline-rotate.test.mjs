import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inlineRotate,exportedBody,encodeU32 as u} from './inline-rotate.mjs';
import {parseModule,walkBody} from './wdis.mjs';
const engine=fs.readFileSync(new URL('../../../public/v86.wasm',import.meta.url));
const str=s=>[...u(s.length),...Buffer.from(s)];
const sec=(id,b)=>[id,...u(b.length),...b];
const moduleOf=(imports,body,extra=[])=>Uint8Array.from([
    0,97,115,109,1,0,0,0,
    ...sec(1,[1,96,2,127,127,1,127]),...sec(2,imports),...sec(3,[1,0]),
    ...sec(7,[1,...str('ror32'),0,imports[0]===2?1:0]),
    ...sec(10,[1,...u(body.length),...body]),...extra,
]);
const memoryImport=[...str('e'),...str('m'),2,0,1];
const caller=(body,extra=[],name='ror32')=>moduleOf([2,...str('e'),...str(name),0,0,...memoryImport],body,extra);
for(const name of ['ror32','rol32'])test(`exact ${name} preserves result and entire memory, including flags, for all masked counts`,()=>{
    const original=moduleOf([1,...memoryImport],exportedBody(engine,name).body);
    const bytes=caller([0,32,0,32,1,16,0,32,1,16,0,11],[],name); // nested calls
    const changed=inlineRotate(bytes,engine,name);assert.equal(changed.sites,2);
    const m1=new WebAssembly.Memory({initial:1}),m2=new WebAssembly.Memory({initial:1});
    const ref=new WebAssembly.Instance(new WebAssembly.Module(original),{e:{m:m1}}).exports.ror32;
    const baseline=new WebAssembly.Instance(new WebAssembly.Module(bytes),{e:{m:m1,[name]:ref}}).exports.ror32;
    const candidate=new WebAssembly.Instance(new WebAssembly.Module(changed.bytes),{e:{m:m2,[name]:()=>{throw Error('unexpected helper call');}}}).exports.ror32;
    let random=73;
    const next=()=>random=(Math.imul(random,1664525)+1013904223)>>>0;
    const values=[0,1,0x80000000,0xffffffff,0x7fffffff,...Array.from({length:100},next)];
    const a=new Uint32Array(m1.buffer),b=new Uint32Array(m2.buffer);
    for(const value of values) for(let count=0;count<32;count++) {
        for(let i=0;i<a.length;i++)a[i]=next();b.set(a);
        const oldFlags=a[30],oldChanged=a[25];
        const rotate=x=>count?(name==='ror32'?((x>>>count)|(x<<(32-count))):((x<<count)|(x>>>(32-count))))>>>0:x>>>0;
        const expected=rotate(value),expected2=rotate(expected);
        const r=baseline(value,count)>>>0,s=candidate(value,count)>>>0;
        assert.equal(r,expected2);assert.equal(s,r);assert.deepEqual(b,a);
        assert.equal(b[25],count?(oldChanged&~2049)>>>0:oldChanged);
        const cf=name==='ror32'?expected2>>>31:expected2&1;
        const of=name==='ror32'?((expected2>>>31)^(expected2>>>30))&1:((expected2>>>31)^cf)&1;
        const flags=count?((oldFlags&~2049)|cf|(of<<11))>>>0:oldFlags;
        assert.equal(b[30],flags);
    }
});
test('branch hints survive changed local declarations and call size',()=>{
    // local decls; block; a,b,call; drop; const1; br_if0; end; a,b,call; end
    const body=[0,2,64,32,0,32,1,16,0,26,65,1,13,0,11,32,0,32,1,16,0,11];
    const hint=sec(0,[...str('metadata.code.branch_hint'),1,1,1,12,1,1]);
    const result=inlineRotate(caller(body,hint),engine);assert.equal(result.sites,2);
    const info=parseModule(result.bytes),ops=[...walkBody(result.bytes,info.code.instrStart,info.code.instrEnd)];
    assert.equal(ops.filter(i=>i.op===16).length,0);
    assert.equal(info.code.localCount,2);
    assert.ok(info.customNames.includes('metadata.code.branch_hint'));
});
test('refuses drifted engine body and unreviewed custom metadata',()=>{
    const changed=Buffer.from(engine),body=exportedBody(changed,'ror32').body;
    const offset=changed.indexOf(body);assert.ok(offset>0);changed[offset+32]=21;
    const bytes=caller([0,32,0,32,1,16,0,11]);
    assert.throws(()=>inlineRotate(bytes,changed),/Unreviewed/);
    assert.throws(()=>inlineRotate(caller([0,32,0,32,1,16,0,11],sec(0,str('reloc.CODE'))),engine),/Unsupported custom/);
});
