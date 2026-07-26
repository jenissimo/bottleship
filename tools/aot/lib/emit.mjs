// The "integer-core" instruction slice: guest x86 for one page -> one contract-shaped wasm unit.
//
// Every emitter below is a transcription of the corresponding `vendor/v86` generator, cited by
// file:line, because the differential oracle compares the RAW lazy-flag tuple and the exact
// instruction counter, not just "the answer". Where a v86 emitter has a fused fast path keyed
// on `ctx.previous_instruction`, this slice takes the unfused `Instruction::Other` arm: it is
// the same predicate computed from the same memory-resident tuple, and it is what makes each
// instruction independently correct rather than correct-in-a-sequence.
//
// What this producer does DIFFERENTLY from the live JIT, on purpose (contract §9):
//   - it emits ONLY the TLB memory shapes (contract N45/N46/N40), never fastmem. That removes
//     the module prologue's `fastmem_deopt_jit_unit(<baked table index>)` guard — one of the
//     two sites that bake the wasm table index (contract §9.1 / handoff §2.1(1)) — and it also
//     removes every baked `mem8` and `fastmem_generation` constant, because a TLB entry already
//     carries `mem8` folded in. The unit is therefore relocatable into ANY free slot.
//   - it never calls `jit_find_cache_entry_in_page`: an indirect terminator (RET) flushes and
//     leaves. That removes the second baked-index site. No ret-chaining, no ret-speculation.
//   ⇒ the body contains no slot number at all, which is contract checklist E1 satisfied by
//     construction rather than by pinning.

import { ModuleBuilder, OP, ALIGN, TYPE } from "./wasm.mjs";
import {
    G, reg32Offset, FLAG, FLAGS_ALL, OPSIZE_8, OPSIZE_16, OPSIZE_32, TLB, SF,
    tlbReadMask, tlbWriteMask, REG,
} from "./abi.mjs";
import { discoverBlocks, shouldElideCurrentFlags } from "./cfg.mjs";

const PAGE = 4096;
const L_EXIT = "exit", L_FAULT = "fault", L_MAIN = "main", L_DEFAULT = "brtable_default";
const BRTABLE_CUTOFF = 10;   // jit.rs:880

class Emitter {
    constructor(job) {
        this.job = job;
        this.mb = new ModuleBuilder();
        this.cpl3 = (job.stateFlags & SF.CPL3) !== 0;
        this.pageBase = job.pageBase;
        this.pageBytes = job.pageBytes;
        this.startOfCurrentInstruction = 0;
        this.elide = false;
    }

    // ── register file (contract N11 / N17) ─────────────────────────────────
    getReg(i) { this.mb.getLocal(this.regs[i]); }
    setReg(i) { this.mb.setLocal(this.regs[i]); }
    /** codegen.rs:149 gen_get_reg8 */
    getReg8(r) {
        const mb = this.mb;
        if (r < 4) { mb.getLocal(this.regs[r]); mb.constI32(0xFF); mb.op(OP.I32AND); }
        else { mb.getLocal(this.regs[r - 4]); mb.constI32(8); mb.op(OP.I32SHRU); mb.constI32(0xFF); mb.op(OP.I32AND); }
    }
    /** codegen.rs:237 gen_set_reg8_unmasked — value on the stack is already <= 0xFF */
    setReg8Unmasked(r) {
        const mb = this.mb;
        if (r < 4) {
            mb.getLocal(this.regs[r]); mb.constI32(~0xFF); mb.op(OP.I32AND);
            mb.op(OP.I32OR); mb.setLocal(this.regs[r]);
        }
        else {
            mb.constI32(8); mb.op(OP.I32SHL); mb.constI32(0xFF00); mb.op(OP.I32AND);
            mb.getLocal(this.regs[r - 4]); mb.constI32(~0xFF00); mb.op(OP.I32AND);
            mb.op(OP.I32OR); mb.setLocal(this.regs[r - 4]);
        }
    }
    /** codegen.rs:203 gen_set_reg8 */
    setReg8(r) {
        const mb = this.mb;
        mb.constI32(0xFF); mb.op(OP.I32AND);
        this.setReg8Unmasked(r);
    }

    /** codegen.rs:4672 gen_move_registers_from_locals_to_memory. Flag locals are OFF (idx 21),
     *  so emit_flag_spill() emits nothing (contract N29/C5 resolution). */
    flush() {
        const mb = this.mb;
        mb.mark("flush");
        for (let i = 0; i < 8; i++) {
            mb.constI32(reg32Offset(i)); mb.getLocal(this.regs[i]);
            mb.store(OP.I32STORE, ALIGN.B4, 0);
        }
    }
    /** codegen.rs:139 gen_update_instruction_counter (contract N36-N38 / C2) */
    updateCounter() {
        const mb = this.mb;
        mb.mark("counter");
        mb.constI32(G.instruction_counter);
        mb.loadFixedI32(G.instruction_counter);
        mb.getLocal(this.instrCounter);
        mb.op(OP.I32ADD);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }

    // ── EIP (contract N20-N22 / C3) ────────────────────────────────────────
    getEip() { this.mb.loadFixedI32(G.instruction_pointer); }
    /** codegen.rs:70 gen_set_eip_low_bits */
    setEipLowBits(low) {
        const mb = this.mb;
        mb.constI32(G.instruction_pointer);
        this.getEip(); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.constI32(low & 0xFFF); mb.op(OP.I32OR);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    /** codegen.rs:82 gen_set_eip_low_bits_and_jump_rel32 */
    setEipLowBitsAndJump(low, n) {
        const mb = this.mb;
        mb.constI32(G.instruction_pointer);
        this.getEip(); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.constI32(low & 0xFFF); mb.op(OP.I32OR);
        if (n !== 0) { mb.constI32(n); mb.op(OP.I32ADD); }
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    /** codegen.rs:55 gen_set_previous_eip_offset_from_eip_with_low_bits */
    setPreviousEipLowBits(low) {
        const mb = this.mb;
        mb.constI32(G.previous_ip);
        this.getEip(); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.constI32(low & 0xFFF); mb.op(OP.I32OR);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }

    // ── lazy-flag tuple (contract N24/N25 / C4) ────────────────────────────
    getFlags() { this.mb.loadFixedI32(G.flags); }
    getFlagsChanged() { this.mb.loadFixedI32(G.flags_changed); }
    getLastResult() { this.mb.loadFixedI32(G.last_result); }
    getLastOp1() { this.mb.loadFixedI32(G.last_op1); }
    getLastOpSize() { this.mb.loadFixedI32(G.last_op_size); }
    setLastOp1FromLocal(l) {
        const mb = this.mb;
        mb.constI32(G.last_op1); mb.getLocal(l); mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    setLastResultFromLocal(l) {
        const mb = this.mb;
        mb.constI32(G.last_result); mb.getLocal(l); mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    /** codegen.rs:2343 — one i64 store, because last_op_size+4 == flags_changed */
    setLastOpSizeAndFlagsChanged(size, changed) {
        const mb = this.mb;
        mb.constI32(G.last_op_size);
        mb.constI64(size >>> 0, changed >>> 0);
        mb.store(OP.I64STORE, ALIGN.B8, 0);
    }
    clearFlagsBits(bits) {
        const mb = this.mb;
        mb.constI32(G.flags); this.getFlags(); mb.constI32(~bits); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }

    // ── conditions: the unfused `Instruction::Other` arms of codegen.rs ────
    getzf(negate) {
        const mb = this.mb;
        this.getFlagsChanged(); mb.constI32(FLAG.ZERO); mb.op(OP.I32AND);
        mb.ifI32();
        {
            const lr = mb.allocLocal();
            this.getLastResult(); mb.teeLocal(lr);
            mb.constI32(-1); mb.op(OP.I32XOR);
            mb.getLocal(lr); mb.constI32(1); mb.op(OP.I32SUB);
            mb.op(OP.I32AND);
            this.getLastOpSize(); mb.op(OP.I32SHRU);
            mb.constI32(1); mb.op(OP.I32AND);
            mb.freeLocal(lr);
        }
        mb.else_();
        { this.getFlags(); mb.constI32(FLAG.ZERO); mb.op(OP.I32AND); }
        mb.end();
        if (negate) mb.op(OP.I32EQZ);
    }
    getcf(negate) {
        const mb = this.mb;
        const fc = mb.allocLocal(), subMask = mb.allocLocal();
        this.getFlagsChanged(); mb.teeLocal(fc);
        mb.constI32(FLAG.CARRY); mb.op(OP.I32AND);
        mb.ifI32();
        {
            mb.getLocal(fc); mb.constI32(31); mb.op(OP.I32SHRS); mb.setLocal(subMask);
            this.getLastResult(); mb.getLocal(subMask); mb.op(OP.I32XOR);
            this.getLastOp1(); mb.getLocal(subMask); mb.op(OP.I32XOR);
            mb.op(OP.I32LTU);
        }
        mb.else_();
        { this.getFlags(); mb.constI32(FLAG.CARRY); mb.op(OP.I32AND); }
        mb.end();
        mb.freeLocal(fc); mb.freeLocal(subMask);
        if (negate) mb.op(OP.I32EQZ);
    }
    getsf(negate) {
        const mb = this.mb;
        this.getFlagsChanged(); mb.constI32(FLAG.SIGN); mb.op(OP.I32AND);
        mb.ifI32();
        {
            this.getLastResult(); this.getLastOpSize(); mb.op(OP.I32SHRU);
            mb.constI32(1); mb.op(OP.I32AND);
        }
        mb.else_();
        { this.getFlags(); mb.constI32(FLAG.SIGN); mb.op(OP.I32AND); }
        mb.end();
        if (negate) mb.op(OP.I32EQZ);
    }
    getof() {
        const mb = this.mb;
        const fc = mb.allocLocal();
        this.getFlagsChanged(); mb.teeLocal(fc);
        mb.constI32(FLAG.OVERFLOW); mb.op(OP.I32AND);
        mb.ifI32();
        {
            const op1 = mb.allocLocal(), res = mb.allocLocal();
            this.getLastOp1(); mb.teeLocal(op1);
            this.getLastResult(); mb.teeLocal(res);
            mb.op(OP.I32XOR);

            mb.getLocal(res); mb.getLocal(op1); mb.op(OP.I32SUB);
            this.getFlagsChanged(); mb.constI32(31); mb.op(OP.I32SHRU); mb.op(OP.I32SUB);
            mb.getLocal(res); mb.op(OP.I32XOR);

            mb.op(OP.I32AND);
            this.getLastOpSize(); mb.op(OP.I32SHRU);
            mb.constI32(1); mb.op(OP.I32AND);
            mb.freeLocal(op1); mb.freeLocal(res);
        }
        mb.else_();
        { this.getFlags(); mb.constI32(FLAG.OVERFLOW); mb.op(OP.I32AND); }
        mb.end();
        mb.freeLocal(fc);
    }
    testBe(negate) {
        const mb = this.mb;
        this.getcf(false); this.getzf(false); mb.op(OP.I32OR);
        if (negate) mb.op(OP.I32EQZ);
    }
    testL(negate) {
        const mb = this.mb;
        this.getsf(false); mb.op(OP.I32EQZ);
        this.getof(); mb.op(OP.I32EQZ);
        mb.op(OP.I32XOR);
        if (negate) mb.op(OP.I32EQZ);
    }
    testLe(negate) {
        const mb = this.mb;
        this.testL(false); this.getzf(false); mb.op(OP.I32OR);
        if (negate) mb.op(OP.I32EQZ);
    }
    /** codegen.rs:4593 gen_condition_fn, low nibble only (0x70/0x80/0x0F9x families). */
    condition(c) {
        const mb = this.mb;
        switch (c & 0xF) {
            case 0x0: this.getof(); break;
            case 0x1: this.getof(); mb.op(OP.I32EQZ); break;
            case 0x2: this.getcf(false); break;
            case 0x3: this.getcf(true); break;
            case 0x4: this.getzf(false); break;
            case 0x5: this.getzf(true); break;
            case 0x6: this.testBe(false); break;
            case 0x7: this.testBe(true); break;
            case 0x8: this.getsf(false); break;
            case 0x9: this.getsf(true); break;
            case 0xA: mb.call("test_p", "v_i"); break;
            case 0xB: mb.call("test_np", "v_i"); break;
            case 0xC: this.testL(false); break;
            case 0xD: this.testL(true); break;
            case 0xE: this.testLe(false); break;
            case 0xF: this.testLe(true); break;
        }
    }
    conditionNegated(c) { this.condition(c ^ 1); }

    // ── memory (contract §5) ───────────────────────────────────────────────
    /** modrm.rs:184 gen — the address expression, flat segmentation only. */
    modrmAddr(m) {
        const mb = this.mb;
        let something = false;
        if (m.base !== null) { this.getReg(m.base); something = true; }
        if (m.index !== null) {
            this.getReg(m.index);
            if (m.shift !== 0) { mb.constI32(m.shift); mb.op(OP.I32SHL); }
            if (something) mb.op(OP.I32ADD);
            something = true;
        }
        if (m.disp !== 0 || !something) {
            mb.constI32(m.disp);
            if (something) mb.op(OP.I32ADD);
        }
        // Flat segmentation is a precondition of the whole unit (checked in compileUnit), so
        // no segment base is added — exactly what jit_add_seg_offset does when flat.
    }
    addrLocal(m) {
        this.modrmAddr(m);
        const l = this.mb.allocLocal();
        this.mb.setLocal(l);
        return l;
    }

    /**
     * codegen.rs:680 gen_safe_read, TLB shape (contract N45, D1/D4/D5/D6).
     * Leaves the loaded value on the stack.
     */
    safeRead(bits, addrLocal) {
        const mb = this.mb;
        const cont = `rd${mb.here}`;
        const entry = mb.allocLocal();
        mb.mark(`read${bits}`);
        mb.block(cont);
        mb.getLocal(addrLocal);
        mb.constI32(12); mb.op(OP.I32SHRU);
        mb.constI32(2); mb.op(OP.I32SHL);
        mb.loadRelocOffset(OP.I32LOAD, ALIGN.B4, "tlb_data");
        mb.teeLocal(entry);
        mb.constI32(tlbReadMask(this.cpl3)); mb.op(OP.I32AND);
        mb.constI32(TLB.VALID); mb.op(OP.I32EQ);
        if (bits !== 8) {
            // D6: the in-page bound test on multi-byte accesses is never elided.
            mb.getLocal(addrLocal); mb.constI32(0xFFF); mb.op(OP.I32AND);
            mb.constI32(0x1000 - bits / 8); mb.op(OP.I32LES);
            mb.op(OP.I32AND);
        }
        mb.brIf(cont);
        mb.getLocal(addrLocal);
        mb.constI32(this.startOfCurrentInstruction & 0xFFF);   // D4 / contract N22, N48
        mb.call(bits === 8 ? "safe_read8_slow_jit" : bits === 16 ? "safe_read16_slow_jit" : "safe_read32s_slow_jit", "ii_i");
        mb.teeLocal(entry);
        mb.constI32(1); mb.op(OP.I32AND);
        mb.brIf(L_FAULT);                                       // D5
        mb.end();
        // N49: the trailing inline access runs on BOTH paths.
        mb.getLocal(entry); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.getLocal(addrLocal); mb.op(OP.I32XOR);
        mb.load(bits === 8 ? OP.I32LOAD8U : bits === 16 ? OP.I32LOAD16U : OP.I32LOAD, ALIGN.B1, 0);
        mb.freeLocal(entry);
    }

    /** codegen.rs:1352 gen_safe_write, TLB shape (contract N46 — a DIFFERENT mask; D2). */
    safeWrite(bits, addrLocal, valueLocal) {
        const mb = this.mb;
        const cont = `wr${mb.here}`;
        const entry = mb.allocLocal();
        mb.mark(`write${bits}`);
        mb.block(cont);
        mb.getLocal(addrLocal);
        mb.constI32(12); mb.op(OP.I32SHRU);
        mb.constI32(2); mb.op(OP.I32SHL);
        mb.loadRelocOffset(OP.I32LOAD, ALIGN.B4, "tlb_data");
        mb.teeLocal(entry);
        mb.constI32(tlbWriteMask(this.cpl3)); mb.op(OP.I32AND);
        mb.constI32(TLB.VALID); mb.op(OP.I32EQ);
        if (bits !== 8) {
            mb.getLocal(addrLocal); mb.constI32(0xFFF); mb.op(OP.I32AND);
            mb.constI32(0x1000 - bits / 8); mb.op(OP.I32LES);
            mb.op(OP.I32AND);
        }
        mb.brIf(cont);
        mb.getLocal(addrLocal);
        mb.getLocal(valueLocal);
        mb.constI32(this.startOfCurrentInstruction & 0xFFF);
        mb.call(bits === 8 ? "safe_write8_slow_jit" : bits === 16 ? "safe_write16_slow_jit" : "safe_write32_slow_jit", "iii_i");
        mb.teeLocal(entry);
        mb.constI32(1); mb.op(OP.I32AND);
        mb.brIf(L_FAULT);
        mb.end();
        mb.getLocal(entry); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.getLocal(addrLocal); mb.op(OP.I32XOR);
        mb.getLocal(valueLocal);
        mb.store(bits === 8 ? OP.I32STORE8 : bits === 16 ? OP.I32STORE16 : OP.I32STORE, ALIGN.B1, 0);
        mb.freeLocal(entry);
    }

    /**
     * codegen.rs:1658 gen_safe_read_write — the two-phase RMW shape (contract N40 / D3).
     * `f` consumes the loaded value from the stack and leaves the new value on it.
     */
    safeReadWrite(bits, addrLocal, f) {
        const mb = this.mb;
        const cont = `rw${mb.here}`;
        const entry = mb.allocLocal();
        const canFast = mb.allocLocal();
        const phys = mb.allocLocal();
        const value = mb.allocLocal();
        mb.mark(`rmw${bits}`);
        mb.block(cont);
        mb.getLocal(addrLocal);
        mb.constI32(12); mb.op(OP.I32SHRU);
        mb.constI32(2); mb.op(OP.I32SHL);
        mb.loadRelocOffset(OP.I32LOAD, ALIGN.B4, "tlb_data");
        mb.teeLocal(entry);
        mb.constI32(tlbWriteMask(this.cpl3)); mb.op(OP.I32AND);
        mb.constI32(TLB.VALID); mb.op(OP.I32EQ);
        if (bits !== 8) {
            mb.getLocal(addrLocal); mb.constI32(0xFFF); mb.op(OP.I32AND);
            mb.constI32(0x1000 - bits / 8); mb.op(OP.I32LES);
            mb.op(OP.I32AND);
        }
        mb.teeLocal(canFast);
        mb.brIf(cont);
        mb.getLocal(addrLocal);
        mb.constI32(this.startOfCurrentInstruction & 0xFFF);
        mb.call(bits === 8 ? "safe_read_write8_slow_jit" : bits === 16 ? "safe_read_write16_slow_jit" : "safe_read_write32s_slow_jit", "ii_i");
        mb.teeLocal(entry);
        mb.constI32(1); mb.op(OP.I32AND);
        mb.brIf(L_FAULT);
        mb.end();

        mb.getLocal(entry); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.getLocal(addrLocal); mb.op(OP.I32XOR);
        mb.teeLocal(phys);
        mb.load(bits === 8 ? OP.I32LOAD8U : bits === 16 ? OP.I32LOAD16U : OP.I32LOAD, ALIGN.B1, 0);

        f();

        mb.setLocal(value);
        mb.getLocal(canFast);
        mb.op(OP.I32EQZ);
        mb.ifVoid();
        {
            mb.getLocal(addrLocal);
            mb.getLocal(value);
            mb.constI32(this.startOfCurrentInstruction & 0xFFF);
            mb.call(bits === 8 ? "safe_write8_slow_jit" : bits === 16 ? "safe_write16_slow_jit" : "safe_write32_slow_jit", "iii_i");
            mb.op(OP.DROP);   // release build: codegen.rs:1853
        }
        mb.end();
        mb.getLocal(phys);
        mb.getLocal(value);
        mb.store(bits === 8 ? OP.I32STORE8 : bits === 16 ? OP.I32STORE16 : OP.I32STORE, ALIGN.B1, 0);

        mb.freeLocal(entry); mb.freeLocal(canFast); mb.freeLocal(phys); mb.freeLocal(value);
    }

    // ── stack ──────────────────────────────────────────────────────────────
    /** codegen.rs:2186 gen_push32, flat + ssize32 short path (no push-run coalescing). */
    push32(valueLocal) {
        const mb = this.mb;
        const newSp = mb.allocLocal();
        this.getReg(REG.ESP);
        mb.constI32(4); mb.op(OP.I32SUB);
        mb.teeLocal(newSp);
        this.safeWrite(32, newSp, valueLocal);
        mb.getLocal(newSp);
        this.setReg(REG.ESP);
        mb.freeLocal(newSp);
    }
    /** codegen.rs:2003 gen_pop32s_ss32 — value ends on the stack, ESP already advanced. */
    pop32() {
        const mb = this.mb;
        this.safeRead(32, this.regs[REG.ESP]);
        this.getReg(REG.ESP);
        mb.constI32(4); mb.op(OP.I32ADD);
        this.setReg(REG.ESP);
    }

    // ── ALU (jit_instructions.rs) ──────────────────────────────────────────
    /** jit_instructions.rs:1096 gen_add32 (or/and/xor/sub share the shape) */
    aluRegDest(alu, destLocal, pushSource) {
        const mb = this.mb;
        const isArith = alu === "add" || alu === "sub";
        if (isArith && !this.elide) this.setLastOp1FromLocal(destLocal);
        mb.getLocal(destLocal); pushSource();
        mb.op(alu === "add" ? OP.I32ADD : alu === "sub" ? OP.I32SUB
            : alu === "and" ? OP.I32AND : alu === "or" ? OP.I32OR : OP.I32XOR);
        mb.setLocal(destLocal);
        if (this.elide) return;
        this.setLastResultFromLocal(destLocal);
        if (isArith) {
            this.setLastOpSizeAndFlagsChanged(OPSIZE_32,
                alu === "sub" ? (FLAGS_ALL | FLAG.SUB) : FLAGS_ALL);
        }
        else {
            this.setLastOpSizeAndFlagsChanged(OPSIZE_32,
                FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);
            this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW | FLAG.ADJUST);
        }
    }
    /** jit_instructions.rs:1197 gen_cmp (32-bit) */
    cmp32(destLocal, pushSource, sourceIsZero) {
        const mb = this.mb;
        if (this.elide) return;
        mb.constI32(G.last_result);
        if (sourceIsZero) mb.getLocal(destLocal);
        else { mb.getLocal(destLocal); pushSource(); mb.op(OP.I32SUB); }
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        mb.constI32(G.last_op1); mb.getLocal(destLocal); mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL | FLAG.SUB);
    }
    /** jit_instructions.rs:1500 gen_test (32-bit) */
    test32(destLocal, pushSource, isSelfTest) {
        const mb = this.mb;
        if (this.elide) return;
        mb.constI32(G.last_result);
        if (isSelfTest) mb.getLocal(destLocal);
        else { mb.getLocal(destLocal); pushSource(); mb.op(OP.I32AND); }
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);
        this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW | FLAG.ADJUST);
    }
    /** jit_instructions.rs:2532 gen_inc / :2582 gen_dec (32-bit) — CF is preserved by
     *  materializing it into `flags` first, which is why they are never elidable. */
    incDec32(destLocal, isDec) {
        const mb = this.mb;
        mb.constI32(G.flags);
        this.getFlags(); mb.constI32(~1); mb.op(OP.I32AND);
        this.getcf(false); mb.op(OP.I32OR);
        mb.store(OP.I32STORE, ALIGN.B4, 0);

        mb.constI32(G.last_op1); mb.getLocal(destLocal); mb.store(OP.I32STORE, ALIGN.B4, 0);

        mb.getLocal(destLocal); mb.constI32(1);
        mb.op(isDec ? OP.I32SUB : OP.I32ADD);
        mb.setLocal(destLocal);

        mb.constI32(G.last_result); mb.getLocal(destLocal); mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, isDec ? ((FLAGS_ALL & ~1) | FLAG.SUB) : (FLAGS_ALL & ~1));
    }
    /** jit_instructions.rs:2659 gen_neg32 */
    neg32(destLocal) {
        const mb = this.mb;
        mb.constI32(G.last_op1); mb.constI32(0); mb.store(OP.I32STORE, ALIGN.B4, 0);
        mb.constI32(0); mb.getLocal(destLocal); mb.op(OP.I32SUB); mb.setLocal(destLocal);
        this.setLastResultFromLocal(destLocal);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL | FLAG.SUB);
    }
    /** jit_instructions.rs:1771 gen_shl32 / :1843 gen_shr32 / sar32 — immediate counts only
     *  take the non-zero path; a CL count keeps v86's `count == 0 -> no-op` block. */
    shift32(destLocal, sh, count) {
        const mb = this.mb;
        let countLocal = null, exitLabel = null;
        if (count.cl) {
            exitLabel = `sh${mb.here}`;
            mb.block(exitLabel);
            countLocal = mb.allocLocal();
            this.getReg(REG.ECX); mb.constI32(31); mb.op(OP.I32AND);
            mb.teeLocal(countLocal);
            mb.op(OP.I32EQZ);
            mb.brIf(exitLabel);
        }
        else if ((count.imm & 31) === 0) return;   // v86 emits nothing at all
        const pushCount = () => { if (countLocal !== null) mb.getLocal(countLocal); else mb.constI32(count.imm & 31); };
        const push32Minus = () => {
            if (countLocal !== null) { mb.constI32(32); mb.getLocal(countLocal); mb.op(OP.I32SUB); }
            else mb.constI32(32 - (count.imm & 31));
        };
        const pushMinusOne = () => {
            if (countLocal !== null) { mb.getLocal(countLocal); mb.constI32(1); mb.op(OP.I32SUB); }
            else mb.constI32((count.imm & 31) - 1);
        };

        if (sh === "shl") {
            const b = mb.allocLocal();
            mb.getLocal(destLocal); push32Minus(); mb.op(OP.I32SHRU);
            mb.constI32(1); mb.op(OP.I32AND); mb.setLocal(b);

            mb.getLocal(destLocal); pushCount(); mb.op(OP.I32SHL); mb.setLocal(destLocal);
            this.setLastResultFromLocal(destLocal);
            this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW);

            mb.constI32(G.flags);
            this.getFlags(); mb.constI32(~(FLAG.CARRY | FLAG.OVERFLOW)); mb.op(OP.I32AND);
            mb.getLocal(b); mb.op(OP.I32OR);
            mb.getLocal(b); mb.getLocal(destLocal); mb.constI32(31); mb.op(OP.I32SHRU);
            mb.op(OP.I32XOR); mb.constI32(11); mb.op(OP.I32SHL);
            mb.constI32(FLAG.OVERFLOW); mb.op(OP.I32AND); mb.op(OP.I32OR);
            mb.store(OP.I32STORE, ALIGN.B4, 0);
            mb.freeLocal(b);
        }
        else {
            // shr32 / sar32 share the shape; only the CF source bit and the shift op differ.
            mb.constI32(G.flags);
            this.getFlags(); mb.constI32(~(FLAG.CARRY | FLAG.OVERFLOW)); mb.op(OP.I32AND);
            mb.getLocal(destLocal); pushMinusOne(); mb.op(OP.I32SHRU);
            mb.constI32(1); mb.op(OP.I32AND); mb.op(OP.I32OR);
            if (sh === "shr") {
                mb.getLocal(destLocal); mb.constI32(20); mb.op(OP.I32SHRU);
                mb.constI32(FLAG.OVERFLOW); mb.op(OP.I32AND); mb.op(OP.I32OR);
            }
            mb.store(OP.I32STORE, ALIGN.B4, 0);

            mb.getLocal(destLocal); pushCount();
            mb.op(sh === "shr" ? OP.I32SHRU : OP.I32SHRS);
            mb.setLocal(destLocal);
            this.setLastResultFromLocal(destLocal);
            this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW);
        }
        if (exitLabel) { mb.end(); mb.freeLocal(countLocal); }
    }
}

// ── per-instruction dispatch ───────────────────────────────────────────────

function emitInstruction(E, ins) {
    const mb = E.mb;
    const m = ins.m;
    const withDest32 = (dest, body) => body(dest);

    switch (ins.kind) {
        case "nop": return;

        case "mov_r32_imm": mb.constI32(ins.imm); E.setReg(ins.reg); return;
        case "mov_r8_imm": mb.constI32(ins.imm & 0xFF); E.setReg8Unmasked(ins.reg); return;

        case "mov_rm_r": {
            if (m.isReg) {
                if (ins.size === 32) { E.getReg(ins.reg); E.setReg(m.rm); }
                else { E.getReg8(ins.reg); E.setReg8(m.rm); }
                return;
            }
            const a = E.addrLocal(m);
            const v = mb.allocLocal();
            if (ins.size === 32) E.getReg(ins.reg); else E.getReg8(ins.reg);
            mb.setLocal(v);
            E.safeWrite(ins.size, a, v);
            mb.freeLocal(v); mb.freeLocal(a);
            return;
        }
        case "mov_r_rm": {
            if (m.isReg) {
                if (ins.size === 32) { E.getReg(m.rm); E.setReg(ins.reg); }
                else { E.getReg8(m.rm); E.setReg8(ins.reg); }
                return;
            }
            const a = E.addrLocal(m);
            E.safeRead(ins.size, a);
            if (ins.size === 32) E.setReg(ins.reg); else E.setReg8(ins.reg);
            mb.freeLocal(a);
            return;
        }
        case "mov_rm_imm": {
            if (m.isReg) {
                if (ins.size === 32) { mb.constI32(ins.imm); E.setReg(m.rm); }
                else { mb.constI32(ins.imm & 0xFF); E.setReg8Unmasked(m.rm); }
                return;
            }
            const a = E.addrLocal(m);
            const v = mb.allocLocal();
            mb.constI32(ins.size === 32 ? ins.imm : (ins.imm & 0xFF)); mb.setLocal(v);
            E.safeWrite(ins.size, a, v);
            mb.freeLocal(v); mb.freeLocal(a);
            return;
        }
        case "lea": {
            E.modrmAddr(m);
            E.setReg(ins.reg);
            return;
        }
        case "movx": {
            if (m.isReg) {
                if (ins.srcSize === 8) E.getReg8(m.rm);
                else { E.getReg(m.rm); mb.constI32(0xFFFF); mb.op(OP.I32AND); }
            }
            else {
                const a = E.addrLocal(m);
                E.safeRead(ins.srcSize, a);
                mb.freeLocal(a);
            }
            if (ins.signed) {
                // codegen.rs:474 sign_extend_i8 / :482 sign_extend_i16 — the shl/shr_s pair,
                // not i32.extend{8,16}_s: same semantics, but this is the shape the engine
                // itself emits and therefore the one its wasm feature set is known to accept.
                const n = ins.srcSize === 8 ? 24 : 16;
                mb.constI32(n); mb.op(OP.I32SHL); mb.constI32(n); mb.op(OP.I32SHRS);
            }
            E.setReg(ins.reg);
            return;
        }

        case "alu_r_rm": {
            if (ins.size !== 32) throw new Error("8-bit ALU is out of slice");
            const dest = E.regs[ins.reg];
            if (m.isReg) {
                const src = E.regs[m.rm];
                emitAlu(E, ins.alu, dest, () => mb.getLocal(src), src === dest);
            }
            else {
                const a = E.addrLocal(m);
                E.safeRead(32, a);
                const src = mb.allocLocal(); mb.setLocal(src);
                emitAlu(E, ins.alu, dest, () => mb.getLocal(src), false);
                mb.freeLocal(src); mb.freeLocal(a);
            }
            return;
        }
        case "alu_rm_r": {
            if (ins.size !== 32) throw new Error("8-bit ALU is out of slice");
            const src = E.regs[ins.reg];
            if (m.isReg) {
                emitAlu(E, ins.alu, E.regs[m.rm], () => mb.getLocal(src), m.rm === ins.reg);
                return;
            }
            const a = E.addrLocal(m);
            if (ins.alu === "cmp") {
                E.safeRead(32, a);
                const d = mb.allocLocal(); mb.setLocal(d);
                E.cmp32(d, () => mb.getLocal(src), false);
                mb.freeLocal(d);
            }
            else {
                E.safeReadWrite(32, a, () => {
                    const d = mb.allocLocal(); mb.setLocal(d);
                    emitAlu(E, ins.alu, d, () => mb.getLocal(src), false);
                    mb.getLocal(d); mb.freeLocal(d);
                });
            }
            mb.freeLocal(a);
            return;
        }
        case "alu_acc_imm": {
            if (ins.size !== 32) throw new Error("8-bit ALU is out of slice");
            emitAlu(E, ins.alu, E.regs[REG.EAX], () => mb.constI32(ins.imm), false, ins.imm === 0);
            return;
        }
        case "alu_rm_imm": {
            if (ins.size !== 32) throw new Error("8-bit ALU is out of slice");
            if (m.isReg) {
                emitAlu(E, ins.alu, E.regs[m.rm], () => mb.constI32(ins.imm), false, ins.imm === 0);
                return;
            }
            const a = E.addrLocal(m);
            if (ins.alu === "cmp") {
                E.safeRead(32, a);
                const d = mb.allocLocal(); mb.setLocal(d);
                E.cmp32(d, () => mb.constI32(ins.imm), ins.imm === 0);
                mb.freeLocal(d);
            }
            else {
                E.safeReadWrite(32, a, () => {
                    const d = mb.allocLocal(); mb.setLocal(d);
                    emitAlu(E, ins.alu, d, () => mb.constI32(ins.imm), false, ins.imm === 0);
                    mb.getLocal(d); mb.freeLocal(d);
                });
            }
            mb.freeLocal(a);
            return;
        }
        case "test_rm_r": {
            if (ins.size !== 32) throw new Error("8-bit TEST is out of slice");
            const src = E.regs[ins.reg];
            if (m.isReg) { E.test32(E.regs[m.rm], () => mb.getLocal(src), m.rm === ins.reg); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const d = mb.allocLocal(); mb.setLocal(d);
            E.test32(d, () => mb.getLocal(src), false);
            mb.freeLocal(d); mb.freeLocal(a);
            return;
        }
        case "test_rm_imm": {
            if (ins.size !== 32) throw new Error("8-bit TEST is out of slice");
            if (m.isReg) { E.test32(E.regs[m.rm], () => mb.constI32(ins.imm), false); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const d = mb.allocLocal(); mb.setLocal(d);
            E.test32(d, () => mb.constI32(ins.imm), false);
            mb.freeLocal(d); mb.freeLocal(a);
            return;
        }

        case "inc_r": E.incDec32(E.regs[ins.reg], false); return;
        case "dec_r": E.incDec32(E.regs[ins.reg], true); return;
        case "inc_rm": case "dec_rm": {
            if (ins.size !== 32) throw new Error("8-bit INC/DEC is out of slice");
            const isDec = ins.kind === "dec_rm";
            if (m.isReg) { E.incDec32(E.regs[m.rm], isDec); return; }
            const a = E.addrLocal(m);
            E.safeReadWrite(32, a, () => {
                const d = mb.allocLocal(); mb.setLocal(d);
                E.incDec32(d, isDec);
                mb.getLocal(d); mb.freeLocal(d);
            });
            mb.freeLocal(a);
            return;
        }
        case "not": {
            if (ins.size !== 32) throw new Error("8-bit NOT is out of slice");
            if (m.isReg) {
                mb.getLocal(E.regs[m.rm]); mb.constI32(-1); mb.op(OP.I32XOR); mb.setLocal(E.regs[m.rm]);
                return;
            }
            const a = E.addrLocal(m);
            E.safeReadWrite(32, a, () => { mb.constI32(-1); mb.op(OP.I32XOR); });
            mb.freeLocal(a);
            return;
        }
        case "neg": {
            if (m.isReg) { E.neg32(E.regs[m.rm]); return; }
            const a = E.addrLocal(m);
            E.safeReadWrite(32, a, () => {
                const d = mb.allocLocal(); mb.setLocal(d);
                E.neg32(d);
                mb.getLocal(d); mb.freeLocal(d);
            });
            mb.freeLocal(a);
            return;
        }
        case "shift": {
            if (m.isReg) { E.shift32(E.regs[m.rm], ins.sh, ins.count); return; }
            const a = E.addrLocal(m);
            E.safeReadWrite(32, a, () => {
                const d = mb.allocLocal(); mb.setLocal(d);
                E.shift32(d, ins.sh, ins.count);
                mb.getLocal(d); mb.freeLocal(d);
            });
            mb.freeLocal(a);
            return;
        }
        case "setcc": {
            if (m.isReg) {
                E.condition(ins.cond); mb.constI32(0); mb.op(OP.I32NE);
                E.setReg8Unmasked(m.rm);
                return;
            }
            const a = E.addrLocal(m);
            E.condition(ins.cond); mb.constI32(0); mb.op(OP.I32NE);
            const v = mb.allocLocal(); mb.setLocal(v);
            E.safeWrite(8, a, v);
            mb.freeLocal(v); mb.freeLocal(a);
            return;
        }
        case "push_r": {
            E.push32(E.regs[ins.reg]);
            return;
        }
        case "push_imm": {
            const v = mb.allocLocal();
            mb.constI32(ins.imm); mb.setLocal(v);
            E.push32(v);
            mb.freeLocal(v);
            return;
        }
        case "pop_r": {
            E.pop32();
            E.setReg(ins.reg);
            return;
        }
        default:
            throw new Error(`emitInstruction: unhandled kind ${ins.kind}`);
    }
}

function emitAlu(E, alu, destLocal, pushSource, sourceAliasesDest, sourceIsZero = false) {
    if (alu === "cmp") return E.cmp32(destLocal, pushSource, sourceIsZero);
    if (alu === "xor" && sourceAliasesDest) {
        // jit_instructions.rs:1633 special-cases `xor r,r` to a constant zero.
        E.mb.constI32(0); E.mb.setLocal(destLocal);
        if (!E.elide) {
            E.setLastResultFromLocal(destLocal);
            E.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);
            E.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW | FLAG.ADJUST);
        }
        return;
    }
    return E.aluRegDest(alu, destLocal, pushSource);
}

// ── whole-unit assembly ────────────────────────────────────────────────────

/**
 * @param {{pageBase:number, pageBytes:Uint8Array, entryAddrs:number[], stateFlags:number,
 *          jitConfig:Record<string,number>}} job
 */
export function compileUnit(job) {
    if (!(job.stateFlags & SF.FLAT_SEGS)) throw new Error("unit requires flat segmentation");
    if (!(job.stateFlags & SF.IS_32)) throw new Error("unit requires 32-bit code");
    if (!(job.stateFlags & SF.SS32)) throw new Error("unit requires a 32-bit stack");

    const { blocks: allBlocks, byAddr, unsupported, decoded } =
        discoverBlocks(job.pageBytes, job.pageBase, job.entryAddrs);

    // A zero-instruction block would exit having bumped the instruction counter by 0, which
    // `do_many_cycles_native` turns into an infinite host loop (contract N37). Such a block can
    // only arise where the very first instruction at a block head is out of slice — so drop it
    // and let its predecessors leave the unit with EIP pointing at it instead.
    const blocks = allBlocks.filter((b) => b.numInstructions > 0);
    for (const b of allBlocks) if (b.numInstructions === 0) byAddr.delete(b.addr);
    blocks.forEach((b, i) => { b.index = i; });
    if (!blocks.length) throw new Error("nothing in this page is inside the slice");
    for (const a of job.entryAddrs) {
        if (!byAddr.has(a)) throw new Error(`required entry 0x${a.toString(16)} is not compilable`);
    }

    const E = new Emitter(job);
    const mb = E.mb;
    const env = {
        pageBytes: job.pageBytes, pageBase: job.pageBase, decoded, byAddr,
        deadFlagElision: (job.jitConfig?.["5"] ?? 1) !== 0,
    };

    // ── prologue (contract N11) ────────────────────────────────────────────
    E.regs = [];
    for (let i = 0; i < 8; i++) {
        mb.loadFixedI32(reg32Offset(i));
        const l = mb.allocLocal(); mb.setLocal(l); E.regs.push(l);
    }
    mb.constI32(0);
    E.instrCounter = mb.allocLocal();
    mb.setLocal(E.instrCounter);

    // ── label nesting (contract N12 / B2) ──────────────────────────────────
    mb.block(L_EXIT);
    mb.block(L_FAULT);
    mb.loop(L_MAIN);
    mb.block(L_DEFAULT);

    const label = (i) => `B${i}`;
    for (let i = blocks.length - 1; i >= 0; i--) mb.block(label(i));

    // dispatcher (contract N13): if-chain at <= BRTABLE_CUTOFF entries, br_table above
    if (blocks.length <= BRTABLE_CUTOFF) {
        for (let i = 0; i < blocks.length; i++) {
            mb.getLocal(0); mb.constI32(i); mb.op(OP.I32EQ); mb.brIf(label(i));
        }
        mb.br(L_DEFAULT);
    }
    else {
        mb.getLocal(0);
        mb.brTable(blocks.map((_, i) => label(i)), L_DEFAULT);
    }

    const selfLoop = (b) =>
        (b.ty?.type === "cond" && b.ty.target === b.addr) ||
        (b.ty?.type === "jmp" && b.ty.target === b.addr);

    for (let i = 0; i < blocks.length; i++) {
        mb.end();                                   // closes block label(i): code follows
        const b = blocks[i];
        const loopLabel = selfLoop(b) ? `S${i}` : null;
        if (loopLabel) mb.loop(loopLabel);
        emitBlock(E, env, b, blocks, byAddr, i, loopLabel);
        if (loopLabel) mb.end();
    }

    mb.end();                                       // L_DEFAULT
    mb.br(L_EXIT);                                  // contract N14 / B5: clean exit, not `unreachable`
    mb.end();                                       // L_MAIN
    mb.end();                                       // L_FAULT
    // fault epilogue — exactly one per function (contract N54 / B4)
    E.flush();
    mb.call("trigger_fault_end_jit", "v_v");
    E.updateCounter();
    mb.return_();
    mb.end();                                       // L_EXIT
    // exit epilogue (contract N16a)
    E.flush();
    E.updateCounter();

    const built = mb.finish();
    return {
        ...built,
        entries: blocks.map((b) => [b.addr - job.pageBase, b.index]),
        blocks: blocks.map((b) => ({
            addr: b.addr, index: b.index, instructions: b.numInstructions, ty: b.ty?.type,
        })),
        unsupported: unsupported.map((u) => ({ addr: u.addr, why: u.why })),
        guestInstructions: blocks.reduce((n, b) => n + b.numInstructions, 0),
        guestBytes: blocks.reduce((n, b) => n + (b.endAddr - b.addr), 0),
    };
}

function emitBlock(E, env, b, blocks, byAddr, i, loopLabel) {
    const mb = E.mb;
    const pageBase = env.pageBase;
    const pageEnd = pageBase + PAGE;

    // jit.rs:3811 needs_eip_updated — true only for BasicBlockType::Exit
    const needsEip = b.ty?.type === "exit";

    // jit.rs:3830 per-block instruction counter
    mb.getLocal(E.instrCounter);
    mb.constI32(b.numInstructions);
    mb.op(OP.I32ADD);
    mb.setLocal(E.instrCounter);

    const isTerminatorIns = (a) =>
        (b.ty?.type === "cond" || b.ty?.type === "jmp" || b.ty?.type === "absolute") &&
        a === b.lastInsAddr;

    let a = b.addr;
    while (a < b.endAddr) {
        const ins = env.decoded.get(a);
        if (!ins || ins.kind === "unsupported") break;
        if (a === b.lastInsAddr && needsEip) {
            // jit.rs:3893 — EIP is attached to the block type, not to the emitter
            E.setPreviousEipLowBits(b.lastInsAddr & 0xFFF);
            E.setEipLowBits(b.endAddr & 0xFFF);
        }
        E.startOfCurrentInstruction = a;
        E.elide = shouldElideCurrentFlags(env, b, a);
        if (!isTerminatorIns(a)) emitInstruction(E, ins);
        a += ins.len;
    }

    const leaveTo = (targetAddr, relFrom, rel) => {
        // Off-page (or non-compilable) target: materialize EIP and leave. Same shape as
        // jit.rs:3103 gen_set_eip_low_bits_and_jump_rel32 -> exit.
        E.setEipLowBitsAndJump(relFrom & 0xFFF, rel);
        mb.br(L_EXIT);
    };
    const gotoBlock = (targetAddr, relFrom, rel) => {
        const t = byAddr.get(targetAddr);
        if (!t) { leaveTo(targetAddr, relFrom, rel); return; }
        if (loopLabel && targetAddr === b.addr) { mb.br(loopLabel); return; }
        if (t.index > i) { mb.br(`B${t.index}`); return; }
        if (t.index === i + 1) return;                       // natural fallthrough
        // Backward edge that is not this block's own self-loop: re-enter the dispatcher.
        mb.constI32(t.index); mb.setLocal(0); mb.br(L_MAIN);
    };

    switch (b.ty?.type) {
        case "cond": {
            const t = byAddr.get(b.ty.target);
            const inPage = b.ty.target >= pageBase && b.ty.target < pageEnd;
            if (t) {
                E.condition(b.ty.cond);
                if (loopLabel && b.ty.target === b.addr) mb.brIf(loopLabel);
                else if (t.index > i) mb.brIf(`B${t.index}`);
                else {
                    mb.ifVoid();
                    mb.constI32(t.index); mb.setLocal(0); mb.br(L_MAIN);
                    mb.end();
                }
            }
            else {
                E.condition(b.ty.cond);
                mb.ifVoid();
                leaveTo(b.ty.target, b.endAddr, b.ty.ins.rel);
                mb.end();
            }
            // fallthrough edge
            const f = byAddr.get(b.ty.fall);
            if (!f) { leaveTo(b.ty.fall, b.endAddr, 0); return; }
            if (f.index === i + 1) return;
            if (f.index > i) { mb.br(`B${f.index}`); return; }
            mb.constI32(f.index); mb.setLocal(0); mb.br(L_MAIN);
            return;
        }
        case "jmp":
            gotoBlock(b.ty.target, b.endAddr, b.ty.ins.rel);
            if (byAddr.get(b.ty.target) && byAddr.get(b.ty.target).index === i + 1) return;
            return;
        case "fall": {
            const f = byAddr.get(b.ty.next);
            if (!f) { E.setEipLowBits(b.ty.next & 0xFFF); mb.br(L_EXIT); return; }
            if (f.index === i + 1) return;
            if (f.index > i) { mb.br(`B${f.index}`); return; }
            mb.constI32(f.index); mb.setLocal(0); mb.br(L_MAIN);
            return;
        }
        case "absolute": {
            // RET: jit_instructions.rs:3368 instr32_C3_jit, then LEAVE — no ret-chaining, no
            // ret-speculation, hence no `jit_find_cache_entry_in_page(<baked slot>)`.
            E.startOfCurrentInstruction = b.lastInsAddr;
            mb.constI32(0);
            E.pop32();
            mb.store(OP.I32STORE, ALIGN.B4, G.instruction_pointer);
            if (b.ty.ins.pop) {
                E.getReg(REG.ESP); mb.constI32(b.ty.ins.pop); mb.op(OP.I32ADD); E.setReg(REG.ESP);
            }
            mb.br(L_EXIT);
            return;
        }
        case "exit":
        default:
            mb.br(L_EXIT);
            return;
    }
}
