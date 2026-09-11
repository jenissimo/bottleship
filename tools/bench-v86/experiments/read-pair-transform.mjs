import fs from 'node:fs';import path from 'node:path';
export function transform(dst){
 const read=n=>fs.readFileSync(path.join(dst,'src/rust',n),'utf8').replace(/\r\n/g,'\n');
 const save=(n,s)=>fs.writeFileSync(path.join(dst,'src/rust',n),s);
 const replace=(s,a,b)=>{if(s.split(a).length!==2)throw Error(`Source drift: ${a}`);return s.replace(a,b);};
 let j=read('jit.rs');
 j=replace(j,"pub struct JitContext<'a> {",`pub struct ReadPairPlan { pub next_eip: u32, pub delta: i32, pub entry: WasmLocal, pub valid: WasmLocal, pub first: bool }
pub struct JitContext<'a> {`);
 j=replace(j,'    pub fpu_simd_dirty_marked: bool,','    pub fpu_simd_dirty_marked: bool,\n    pub read_pair: Option<ReadPairPlan>,\n    pub read_pair_last_instruction: u32,');
 j=replace(j,'        fpu_simd_dirty_marked: false,','        fpu_simd_dirty_marked: false,\n        read_pair: None,\n        read_pair_last_instruction: 0,');
 j=replace(j,'    ctx.fpu_simd_dirty_marked = false;','    ctx.fpu_simd_dirty_marked = false;\n    codegen::gen_read_pair_free(ctx);\n    ctx.read_pair_last_instruction = last_instruction_addr;');
 j=replace(j,'        ctx.start_of_current_instruction = ctx.cpu.eip;','        ctx.start_of_current_instruction = ctx.cpu.eip;\n        if ctx.read_pair.as_ref().map_or(false, |p| p.next_eip != ctx.cpu.eip) { codegen::gen_read_pair_free(ctx); }');
 j=j.replaceAll('            codegen::gen_read_tlb_cache_free(ctx);','            codegen::gen_read_tlb_cache_free(ctx);\n            codegen::gen_read_pair_free(ctx);');save('jit.rs',j);
 let m=read('modrm.rs');m=replace(m,'impl ModrmByte {',`impl ModrmByte {
    pub fn read_pair_base(&self) -> Option<(u32, i32)> {
        if self.is_16 || self.second_reg.is_some() || self.shift != 0 { return None; }
        self.first_reg.map(|r| (r, self.immediate))
    }`);save('modrm.rs',m);
 let c=read('codegen.rs');c+=`\npub fn gen_read_pair_free(ctx: &mut JitContext) {
    if let Some(p) = ctx.read_pair.take() { ctx.builder.free_local(p.entry); ctx.builder.free_local(p.valid); }
}\n`;
 c=replace(c,'    // TLB hit is the fast path; falling through means calling safe_read*_slow_jit.',`    if let Some(p) = ctx.read_pair.as_ref().filter(|p| p.first) {
        // Preserve the original first-read condition on the stack. Only a real
        // TLB hit with the complete range proven may populate the shared path.
        ctx.builder.tee_local(&p.valid);
        ctx.builder.get_local(&p.valid);
        ctx.builder.get_local(address_local); ctx.builder.const_i32(4095); ctx.builder.and_i32();
        ctx.builder.const_i32(0.max(-p.delta)); ctx.builder.geu_i32(); ctx.builder.and_i32();
        ctx.builder.get_local(address_local); ctx.builder.const_i32(4095); ctx.builder.and_i32();
        ctx.builder.const_i32(4096 - 4.max(p.delta + 4)); ctx.builder.leu_i32(); ctx.builder.and_i32();
        ctx.builder.set_local(&p.valid);
        ctx.builder.get_local(&entry_local); ctx.builder.set_local(&p.entry);
    }
    // TLB hit is the fast path; falling through means calling safe_read*_slow_jit.`);save('codegen.rs',c);
 let i=read('jit_instructions.rs');const a=i.indexOf('pub fn instr32_8B_mem_jit('),b=i.indexOf('pub fn instr32_8B_reg_jit(',a);
 if(a<0||b<a)throw Error('MOV emitter missing');i=i.slice(0,a)+fs.readFileSync('tools/bench-v86/experiments/read-pair-mov.rs','utf8')+'\n'+i.slice(b);save('jit_instructions.rs',i);
}
