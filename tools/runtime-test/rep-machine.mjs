/** Real REP opcodes, not HLE CALL/OUT thunks; shared by tests and browser benchmarks. */
import {createMachine, BASE, ENTRY, LEAF, DONE, STACK, LEFT, RIGHT} from './bulk-machine.mjs';
export {BASE, ENTRY, LEAF, DONE, STACK, LEFT, RIGHT};
export const FAULT = BASE + 0x300;
export function repLeaf(op, size, equal=true, address16=false, fs=false) {
    const i=['cmps','scas','stos','movs'].indexOf(op), j=[1,2,4].indexOf(size);
    if(i<0||j<0)throw new Error('Unsupported REP fixture');
    return LEAF + (i*6+j*2+Number(!equal))*16 + (address16?512:0) + (fs?1024:0);
}
export async function createRepMachine(binary, options={}) {
    const m=await createMachine(binary,options), mem=m.guest();
    // Load ESI/EDI/ECX from the argument block, CALL EBP, then loop with EBX.
    const code=[0x8b,0x32,0x8b,0x7a,4,0x8b,0x4a,8,0xff,0xd5,0x4b,0x75,0xf3,0xe9];
    mem.set(code,ENTRY);new DataView(mem.buffer,mem.byteOffset).setInt32(ENTRY+code.length,DONE-(ENTRY+code.length+4),true);
    for(const op of ['cmps','scas','stos','movs'])for(const size of [1,2,4])for(const equal of [true,false])for(const address16 of [false,true])for(const fs of [false,true]){
        const opcode={cmps:0xa6,scas:0xae,stos:0xaa,movs:0xa4}[op]+Number(size!==1);
        mem.set([...(address16?[0x67]:[]),...(fs?[0x64]:[]),...(size===2?[0x66]:[]),equal?0xf3:0xf2,opcode,0xc3],repLeaf(op,size,equal,address16,fs));
    }
    const setFlags=f=>{m.state().setUint32(120,f>>>0,true);m.state().setUint32(100,0,true);};
    function prepare(op,size,src,dst,count,{equal=true,backwards=false,value=0,iterations=1,address16=false,fs=false,flags=0x202,single=false}={}){
        if(!Number.isInteger(count)||count<0||count>0xffffffff||!Number.isInteger(iterations)||iterations<1)throw new RangeError('Invalid REP count');
        const r=m.reg(),dv=new DataView(m.guest().buffer,m.guest().byteOffset),leaf=repLeaf(op,size,equal,address16,fs);
        r[0]=value;r[1]=count;r[2]=STACK+16;r[3]=iterations;r[4]=STACK;r[5]=leaf;r[6]=src;r[7]=dst;
        dv.setUint32(STACK+16,src>>>0,true);dv.setUint32(STACK+20,dst>>>0,true);dv.setUint32(STACK+24,count>>>0,true);
        if(single){r[4]=STACK-4;dv.setUint32(STACK-4,DONE,true);}
        setFlags((flags&~0x400)|(backwards?0x400:0));
        m.state().setUint32(556,single?leaf:ENTRY,true);m.cpu.in_hlt[0]=0;
    }
    function snapshot(){return {eax:m.reg()[0]>>>0,ecx:m.reg()[1]>>>0,esi:m.reg()[6]>>>0,edi:m.reg()[7]>>>0,flags:m.cpu.get_eflags()>>>0,esp:m.reg()[4]>>>0};}
    function installFaultGate(user=false){
        const mem=m.guest(),dv=new DataView(mem.buffer,mem.byteOffset),gdt=0x70000,idt=0x71000,selector=user?0x1b:8;
        for(const [i,access] of [[1,0x9a],[2,0x92],[3,0xfa],[4,0xf2]])mem.set([255,255,0,0,0,access,0xcf,0],gdt+i*8);
        m.cpu.gdtr_offset[0]=gdt;m.cpu.gdtr_size[0]=39;
        const p=idt+14*8;dv.setUint16(p,FAULT&65535,true);dv.setUint16(p+2,selector,true);dv.setUint16(p+4,0x8e00,true);dv.setUint16(p+6,FAULT>>>16,true);
        m.cpu.idtr_offset[0]=idt;m.cpu.idtr_size[0]=2047;m.cpu.sreg[1]=selector;
        if(user){m.cpu.cpl[0]=3;for(const i of [0,2,3,4,5])m.cpu.sreg[i]=0x23;}
        m.cpu.update_state_flags();
    }
    return {...m,prepareRep:prepare,snapshot,installFaultGate,
        rep(op,size,src,dst,count,opts={}){prepare(op,size,src,dst,count,{...opts,single:true});m.execute();return snapshot();},
        repStats(){return m.api.get_rep_memory_stats_ptr?Array.from(new Uint32Array(m.cpu.wasm_memory.buffer,m.api.get_rep_memory_stats_ptr()>>>0,5)):null;},
        get hostCalls(){return m.hostCalls;},get finalized(){return m.finalized;},
    };
}
