// Offline, fail-closed substitution of the current engine's exact ror32 body.
// The runtime hash belongs in the caller's AOT identity, as for any cached JIT module.
import {createHash} from 'node:crypto';
import {parseModule, readSections, uleb, walkBody} from './wdis.mjs';

const ROR32 = Uint8Array.from([0,2,64,32,1,69,13,0,65,0,65,0,40,2,100,65,254,111,113,54,2,100,65,0,32,0,32,1,120,34,0,65,20,118,32,0,65,19,118,115,65,128,16,113,32,0,65,31,118,114,65,0,40,2,120,65,254,111,113,114,54,2,120,11,32,0,11]);
const ROL32 = Uint8Array.from([0,2,64,32,1,69,13,0,65,0,65,0,40,2,100,65,254,111,113,54,2,100,65,0,32,0,32,1,119,34,0,65,11,116,32,0,65,20,118,115,65,128,16,113,32,0,65,1,113,114,65,0,40,2,120,65,254,111,113,114,54,2,120,11,32,0,11]);
export const encodeU32 = value => {
    const out=[];
    do {const low=value&127;value>>>=7;out.push(low|(value?128:0));} while(value);
    return out;
};
const section=(id,body)=>Buffer.from([id,...encodeU32(body.length),...body]);
export function exportedBody(bytes,name) {
    new WebAssembly.Module(bytes);
    const info=parseModule(bytes), imports=info.imports.filter(i=>i.kind===0);
    const exp=info.exports.find(e=>e.name===name&&e.kind===0);
    if(!exp||exp.index<imports.length) throw Error(`Missing defined helper ${name}`);
    const s=readSections(bytes).find(s=>s.id===10);
    let p=s.start;const [count,n]=uleb(bytes,p);p+=n;
    for(let i=0;i<count;i++) {
        const [length,k]=uleb(bytes,p);p+=k;
        if(i===exp.index-imports.length) return {body:bytes.slice(p,p+length),type:info.types[info.functions[i]]};
        p+=length;
    }
    throw Error('Helper body missing');
}
function requireType(type) {
    if(JSON.stringify(type)!==JSON.stringify({params:[127,127],results:[127]})) throw Error('Unexpected ror32 signature');
}
export function inlineRotate(bytes,engine,name='ror32') {
    const approved={ror32:ROR32,rol32:ROL32}[name];
    if(!approved)throw Error('Unreviewed rotate helper '+name);
    const helper=exportedBody(engine,name);requireType(helper.type);
    if(!Buffer.from(helper.body).equals(Buffer.from(approved))) throw Error(`Unreviewed engine ${name} body`);
    const result=rewriteHelperCalls(bytes,{name,type:helper.type,locals:2,emit(base){
        const replacement=[0x21,...encodeU32(base+1),0x21,...encodeU32(base)];
        const hop=[...walkBody(helper.body,1,helper.body.length-1)];
        for(let i=0;i<hop.length;i++) {
            const op=hop[i],end=hop[i+1]?.offset??helper.body.length-1;
            if([0x20,0x21,0x22].includes(op.op)) replacement.push(op.op,...encodeU32(base+op.imm));
            else replacement.push(...helper.body.subarray(op.offset,end));
        }
        return replacement;
    }});
    return {...result,engineSha256:createHash('sha256').update(engine).digest('hex')};
}
// Reuse one offset/local/metadata relocation path across reviewed helper transforms.
export function rewriteHelperCalls(bytes,{name,type,locals,emit}) {
    new WebAssembly.Module(bytes);
    const info=parseModule(bytes),code=info.code;
    if(!code||code.count!==1||info.functions.length!==1) throw Error('Expected single-function JIT module');
    for(const name of info.customNames) if(!['name','metadata.code.branch_hint'].includes(name)) throw Error(`Unsupported custom section ${name}`);
    const imports=info.imports.filter(i=>i.kind===0);
    const target=imports.findIndex(i=>i.module==='e'&&i.name===name);
    if(target<0) return {bytes:Buffer.from(bytes),sites:0};
    if(JSON.stringify(info.types[imports[target].type])!==JSON.stringify(type))throw Error('Unexpected helper signature');
    if(info.memories.length!==1||info.memories[0].module!=='e'||info.memories[0].name!=='m'||info.memories[0].min<1) throw Error('Unexpected CPU memory binding');
    const ops=[...walkBody(bytes,code.instrStart,code.instrEnd)];
    // This reader supports the scalar JIT vocabulary only; reject prefixed extensions,
    // typed blocks and reference operations before trusting instruction boundaries.
    for(const ins of ops) {
        if((ins.op>0xc4&&ins.op!==0xfd) || (ins.op>=0x14&&ins.op<=0x19) || (ins.op>=0x1c&&ins.op<=0x1f) || (ins.op>=0x25&&ins.op<=0x27)) throw Error(`Unsupported opcode ${ins.op}`);
        if([2,3,4].includes(ins.op)&&![0x40,0x7f,0x7e,0x7d,0x7c].includes(bytes[ins.offset+1])) throw Error('Indexed control block unsupported');
        if(ins.imm?.align>=128) throw Error('Noncanonical memory alignment encoding');
    }
    const base=info.types[info.functions[0]].params.length+code.localCount;
    const replacements=new Map();
    ops.forEach((ins,i)=>{if(ins.op===0x10&&ins.imm===target){const r=emit(base,ops,i);if(r)replacements.set(i,r);}});
    const sites=replacements.size;
    if(!sites) return {bytes:Buffer.from(bytes),sites:0};
    const [groups,n]=uleb(bytes,code.localsStart);
    const body=[...encodeU32(groups+1),...bytes.subarray(code.localsStart+n,code.instrStart),...encodeU32(locals),127];
    const offsets=new Map();
    for(let i=0;i<ops.length;i++) {
        const ins=ops[i],end=ops[i+1]?.offset??code.instrEnd;
        offsets.set(ins.offset-code.localsStart,body.length);
        if(replacements.has(i)) body.push(...replacements.get(i));
        else body.push(...bytes.subarray(ins.offset,end));
    }
    const chunks=[Buffer.from(bytes.subarray(0,8))];
    for(const s of readSections(bytes)) {
        if(s.id===10) {chunks.push(section(10,[1,...encodeU32(body.length),...body]));continue;}
        let payload=bytes.subarray(s.start,s.end);
        if(s.id===0) {
            const [len,n]=uleb(bytes,s.start),name=Buffer.from(bytes.subarray(s.start+n,s.start+n+len)).toString();
            if(name==='metadata.code.branch_hint') {
                let p=s.start+n+len;
                const read=()=>{const [v,k]=uleb(bytes,p);p+=k;return v;};
                const count=read();if(count!==1) throw Error('Unexpected hint function count');
                const fn=read();if(fn!==imports.length) throw Error('Unexpected hint function');
                const hints=read(),out=[...payload.subarray(0,n+len),1,...encodeU32(fn),...encodeU32(hints)];
                for(let i=0;i<hints;i++) {
                    const old=read(),size=read(),hint=read(),mapped=offsets.get(old);
                    if(size!==1||hint>1||mapped===undefined||![4,13].includes(bytes[code.localsStart+old])) throw Error('Invalid branch hint');
                    out.push(...encodeU32(mapped),1,hint);
                }
                if(p!==s.end) throw Error('Trailing branch hint data');
                payload=out;
            }
        }
        chunks.push(section(s.id,payload));
    }
    const result=Buffer.concat(chunks);new WebAssembly.Module(result);
    return {bytes:result,sites};
}
