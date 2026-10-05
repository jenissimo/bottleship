pub fn instr32_8B_mem_jit(ctx: &mut JitContext, modrm_byte: ModrmByte, r: u32) {
    if let Some(plan) = ctx.read_pair.take() {
        if !plan.first && plan.next_eip == ctx.start_of_current_instruction {
            codegen::gen_modrm_resolve(ctx, modrm_byte);
            let address = ctx.builder.set_new_local();
            ctx.builder.get_local(&plan.valid);
            ctx.builder.if_i32();
            ctx.builder.get_local(&plan.entry);
            ctx.builder.const_i32(-4096);
            ctx.builder.and_i32();
            ctx.builder.get_local(&address);
            ctx.builder.xor_i32();
            ctx.builder.load_unaligned_i32(0);
            ctx.builder.else_();
            codegen::gen_safe_read32(ctx, &address);
            ctx.builder.block_end();
            codegen::gen_set_reg32(ctx, r);
            ctx.builder.free_local(address);
            ctx.builder.free_local(plan.entry);
            ctx.builder.free_local(plan.valid);
            return;
        }
        ctx.builder.free_local(plan.entry);
        ctx.builder.free_local(plan.valid);
    }
    let next_eip = ctx.cpu.eip;
    if ctx.cpu.prefixes == 0 && ctx.cpu.osize_32() && ctx.cpu.asize_32()
        && next_eip <= ctx.read_pair_last_instruction && next_eip & 0xFFF <= 0xFF8
        && !crate::opstats::opstats_enabled()
    {
        if let Some((base, displacement)) = modrm_byte.read_pair_base() {
            if r != base && crate::modrm::stack_const_is_flat(ctx, &modrm_byte) {
                let mut next = ctx.cpu.clone();
                if next.read_imm8() == 0x8B {
                    let raw = next.read_imm8();
                    if raw < 0xC0 {
                        let operand = crate::modrm::decode(&mut next, raw);
                        if let Some((other_base, other_displacement)) = operand.read_pair_base() {
                            let delta = other_displacement as i64 - displacement as i64;
                            if other_base == base && delta.abs() <= 64
                                && crate::modrm::stack_const_is_flat(ctx, &operand)
                            {
                                ctx.builder.const_i32(0);
                                let valid = ctx.builder.set_new_local();
                                ctx.builder.const_i32(0);
                                let entry = ctx.builder.set_new_local();
                                ctx.read_pair = Some(crate::jit::ReadPairPlan { next_eip, delta: delta as i32, valid, entry, first: true });
                            }
                        }
                    }
                }
            }
        }
    }
    codegen::gen_modrm_resolve_safe_read32(ctx, modrm_byte);
    codegen::gen_set_reg32(ctx, r);
    if let Some(plan) = ctx.read_pair.as_mut() { plan.first = false; }
}
