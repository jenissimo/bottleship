import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {referenceShufps,createShufpsSpecializer} from './shufps-specialize.mjs';
import {encodeU32 as u} from './inline-rotate.mjs';
const str=s=>[...u(s.length),...Buffer.from(s)],sec=(id,b)=>[id,...u(b.length),...b];
const imm=n=>{const a=[];do{const b=n&127;n>>=7;const done=n===0&&!(b&64);a.push(b|(done?0:128));if(done)break;}while(true);return a;};
function callSite(reg,mask){
    const body=[0,65,...imm(1136),65,...imm(reg),65,...imm(mask),16,0,11];
    return Uint8Array.from([0,97,115,109,1,0,0,0,...sec(1,[1,96,3,127,127,127,0]),
        ...sec(2,[2,...str('e'),...str('instr_0FC6'),0,0,...str('e'),...str('m'),2,0,1]),
        ...sec(3,[1,0]),...sec(7,[1,...str('f'),0,1]),...sec(10,[1,...u(body.length),...body])]);
}
test('SHUFPS specialization: all masks/registers, bit-exact NaNs, dirty state and flags preserved',()=>{
    const engine=fs.readFileSync(new URL('../../../public/v86.wasm',import.meta.url));
    const ref=referenceShufps(engine),a=new WebAssembly.Memory({initial:1}),b=new WebAssembly.Memory({initial:1});
    const rewrite=createShufpsSpecializer(engine);
    const reference=new WebAssembly.Instance(new WebAssembly.Module(ref.module),{e:{m:a,sp:32768}}).exports.f;
    const av=new Uint32Array(a.buffer),bv=new Uint32Array(b.buffer);
    const special=[0,0x80000000,0x7fc12345,0x7f800001,0xffffffff,0x7f800000,1,0x00800000];
    for(let i=0;i<av.length;i++)av[i]=Math.imul(i+73,0x9e3779b1)>>>0;
    for(let reg=0;reg<8;reg++)for(let imm=0;imm<256;imm++) {
        const source=1136;
        const dest=832+16*reg;
        for(let i=0;i<4;i++){av[(source>>>2)+i]=special[(imm+i)&7];av[(dest>>>2)+i]=special[(imm+3+i)&7];}
        av[632>>>2]=0xdeadbeef;bv.set(av);
        const d=Array.from(av.slice(dest>>>2,(dest>>>2)+4)),s=Array.from(av.slice(source>>>2,(source>>>2)+4));
        const expected=[d[imm&3],d[(imm>>>2)&3],s[(imm>>>4)&3],s[(imm>>>6)&3]];
        const rewritten=rewrite(callSite(reg,imm));assert.equal(rewritten.sites,1);
        const candidate=new WebAssembly.Instance(new WebAssembly.Module(rewritten.bytes),{e:{m:b,instr_0FC6:()=>{throw Error('Unreplaced call');}}}).exports.f;
        reference(source,reg,imm);candidate(source,reg,imm);
        assert.deepEqual(Array.from(bv.slice(dest>>>2,(dest>>>2)+4)),expected);
        // The native helper spills a temporary v128 at sp-16. It is host compiler
        // scratch, not CPU state. Every other byte, including CPU scratch, must agree.
        const differences=[];
        for(let i=0;i<av.length;i++)if((i<32752/4||i>=32768/4)&&av[i]!==bv[i])differences.push({address:i*4,expected:av[i],actual:bv[i]});
        assert.deepEqual(differences.slice(0,8),[],`reg=${reg}, mask=${imm}, source=${source}`);
    }
});
