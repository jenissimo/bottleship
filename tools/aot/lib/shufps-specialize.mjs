// Constant-argument SHUFPS specialization and its offline AOT call-site rewriter.
// Caller retains SIMD dirty marking, guest memory translation and all fault exits.
import {exportedBody,encodeU32 as u,rewriteHelperCalls} from './inline-rotate.mjs';
import {walkBody} from './wdis.mjs';
import {createHash} from 'node:crypto';
const str=s=>[...u(s.length),...Buffer.from(s)];
const sec=(id,b)=>[id,...u(b.length),...b];
const signed=n=>{const b=[];for(;;){const x=n&127;n>>=7;const done=(n===0&&!(x&64))||(n===-1&&(x&64));b.push(x|(done?0:128));if(done)return b;}};
const constant=n=>[65,...signed(n)];
export function helperModule(body,stack=false) {
    return Uint8Array.from([0,97,115,109,1,0,0,0,
        ...sec(1,[1,96,3,127,127,127,0]),
        ...sec(2,[stack?2:1,...str('e'),...str('m'),2,0,1,...(stack?[...str('e'),...str('sp'),3,127,0]:[])]),
        ...sec(3,[1,0]),...sec(7,[1,...str('f'),0,0]),...sec(10,[1,...u(body.length),...body])]);
}
export function referenceShufps(engine) {
    const {body,type}=exportedBody(engine,'instr_0FC6');
    if(JSON.stringify(type)!==JSON.stringify({params:[127,127,127],results:[]}))throw Error('Unexpected SHUFPS ABI');
    return {module:helperModule(body,true),bodySha256:createHash('sha256').update(body).digest('hex')};
}
export function specializedShufps(source,register,imm) {
    // The current JIT always copies source to its non-aliasing SSE scratch first.
    if(source!==1136||!Number.isInteger(register)||register<0||register>7||!Number.isInteger(imm)||imm<0||imm>255)throw Error('Invalid SHUFPS constants');
    const dest=832+16*register;
    const addresses=[dest+4*(imm&3),dest+4*((imm>>>2)&3),source+4*((imm>>>4)&3),source+4*((imm>>>6)&3)];
    const body=[1,4,127];
    body.push(...constant(632),...constant(1),58,0,0); // write_xmm128 marks fpu_simd_dirty
    // Read every input before writing any lane: important when source aliases dest.
    addresses.forEach((address,i)=>body.push(...constant(address),40,2,0,33,...u(3+i)));
    for(let i=0;i<4;i++)body.push(...constant(dest+4*i),32,...u(3+i),54,2,0);
    body.push(11);return helperModule(body);
}
export function specializeShufpsCalls(bytes,engine) {
    return createShufpsSpecializer(engine)(bytes);
}
export function createShufpsSpecializer(engine) {
    const reference=referenceShufps(engine);
    if(reference.bodySha256!=='891da65b5edc287a1c2d3c0c54ca098d01fb5a07caeffc402220dfc60315a59a')throw Error('Unreviewed engine SHUFPS body');
    const engineSha256=createHash('sha256').update(engine).digest('hex');
    return bytes=>{
    const result=rewriteHelperCalls(bytes,{name:'instr_0FC6',type:{params:[127,127,127],results:[]},locals:4,
        emit(base,ops,i){
            const args=ops.slice(i-3,i);
            if(args.length!==3||args.some(op=>op.op!==65||op.depth!==ops[i].depth))return null;
            const body=exportedBody(specializedShufps(...args.map(op=>op.imm)),'f').body;
            // The three original arguments remain on the stack. Consume them;
            // their side-effect-free constants can then disappear in native lowering.
            const out=[26,26,26],instructions=[...walkBody(body,3,body.length-1)];
            for(let j=0;j<instructions.length;j++){
                const op=instructions[j],end=instructions[j+1]?.offset??body.length-1;
                if([32,33,34].includes(op.op))out.push(op.op,...u(base+op.imm-3));
                else out.push(...body.subarray(op.offset,end));
            }
            return out;
        }});
    return {...result,engineSha256};
    };
}
