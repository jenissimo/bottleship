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
export const LOOP_COUNTER = 100003; // cpu.rs:290

class Emitter {
    constructor(job) {
        this.job = job;
        this.mb = new ModuleBuilder();
        this.cpl3 = (job.stateFlags & SF.CPL3) !== 0;
        this.pageBase = job.pageBase;
        this.pageBytes = job.pageBytes;
        this.startOfCurrentInstruction = 0;
        this.elide = false;
        // The B7 bound. Production is cpu.rs:290's 100_003; a job may lower it so that the bound
        // is REACHED inside a short kernel, which is how the differential stand proves the guard
        // is taken and that taking it changes nothing (see README, "how the bound is proven").
        // The value lands in the manifest, so a lowered bound cannot ship unnoticed.
        this.loopCounter = job.loopCounter ?? LOOP_COUNTER;
        if (!(this.loopCounter > 0)) throw new Error("loopCounter must be positive");
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
    /**
     * codegen.rs:171 gen_get_reg8_or_alias_to_reg32 — for AL..BL the 8-bit operand IS the
     * 32-bit register local, UNMASKED. Every 8-bit emitter below masks where v86 masks and
     * nowhere else, because the oracle compares the raw lazy tuple and v86's own tuple can
     * legally carry bits above the operand size (e.g. gen_and8 stores an unmasked
     * `dest & source` into last_result).
     */
    getReg8Alias(r) {
        if (r < 4) return { local: this.regs[r], temp: false };
        const t = this.mb.allocLocal();
        this.mb.getLocal(this.regs[r - 4]); this.mb.constI32(8); this.mb.op(OP.I32SHRU);
        this.mb.setLocal(t);
        return { local: t, temp: true };
    }
    /** codegen.rs:185 gen_free_reg8_or_alias */
    freeReg8Alias(a) { if (a.temp) this.mb.freeLocal(a.local); }

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

    /**
     * jit.rs:3377-3389 (module top) and jit.rs:4137-4149 (single-entry loop head), both under
     * JIT_USE_LOOP_SAFETY (default true, jit.rs:73). This is contract B7/N18, and for BottleShip
     * it is a CORRECTNESS property, not a throughput one: the 1 ms quantum is only observed
     * BETWEEN module entries (N30), so this is the only bound on preemption latency once the
     * guest is inside the unit. A unit that never yields also flatters its own FPS window.
     * Cheaper than the engine's version by nothing at all — it is the same four ops.
     */
    loopSafety() {
        const mb = this.mb;
        mb.mark("loop_safety");
        mb.getLocal(this.instrCounter);
        mb.constI32(this.loopCounter);
        mb.op(OP.I32GEU);
        mb.brIf(L_EXIT);
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
    /** wasm_builder.rs:1284 flag_load_u8 with flag locals OFF = load_fixed_u8(addr) */
    loadFixedU8(addr) {
        const mb = this.mb;
        mb.constI32(addr); mb.load(OP.I32LOAD8U, ALIGN.B1, 0);
    }
    /**
     * codegen.rs:2380 gen_clear_flags_bits — and note the SHAPE: read `flags`, mask, store back.
     * That read-modify-write is contract C14/N106: the non-arithmetic bits (IF, DF, TF, IOPL, …)
     * live only in this word, so a computed rebuild would silently clear them.
     */
    clearFlagsBits(bits) {
        const mb = this.mb;
        mb.constI32(G.flags); this.getFlags(); mb.constI32(~bits); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    /** codegen.rs:2365 gen_set_flags_bits */
    setFlagsBits(bits) {
        const mb = this.mb;
        mb.constI32(G.flags); this.getFlags(); mb.constI32(bits); mb.op(OP.I32OR);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
    }
    /** codegen.rs:2330 gen_clear_flags_changed_bits */
    clearFlagsChangedBits(bits) {
        const mb = this.mb;
        mb.constI32(G.flags_changed); this.getFlagsChanged(); mb.constI32(~bits); mb.op(OP.I32AND);
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
    /**
     * codegen.rs:4683 gen_condition_fn. Two disjoint families, and the split is the engine's:
     * `condition & 0xF0` in {0x00, 0x70, 0x80} is the flag-predicate family (low nibble only),
     * and `condition & !0x3 == 0xE0` is loop/loopnz/loopz/jcxz, whose predicate is an ecx test.
     */
    condition(c) {
        const mb = this.mb;
        if ((c & ~0x3) === 0xE0) return this.loopCondition(c);
        const hi = c & 0xF0;
        if (hi !== 0x00 && hi !== 0x70 && hi !== 0x80) throw new Error(`condition 0x${c.toString(16)}`);
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
    /**
     * codegen.rs:3151-3182. asize_32 is a unit precondition (compileUnit refuses otherwise), so
     * every arm takes the `is_asize_32` branch and reads the full ECX.
     */
    loopCondition(c) {
        const mb = this.mb;
        const ecx = () => this.getReg(REG.ECX);
        switch (c) {
            case 0xE0:   // loopnz: !(ecx == 0 || ZF)
                ecx(); mb.op(OP.I32EQZ);
                this.getzf(false); mb.op(OP.I32OR);
                mb.op(OP.I32EQZ);
                return;
            case 0xE1:   // loopz: !((ecx == 0) || !ZF)
                ecx(); mb.op(OP.I32EQZ);
                this.getzf(false); mb.op(OP.I32EQZ);
                mb.op(OP.I32OR);
                mb.op(OP.I32EQZ);
                return;
            case 0xE2: ecx(); return;                          // loop: ecx != 0
            case 0xE3: ecx(); mb.op(OP.I32EQZ); return;        // jecxz
            default: throw new Error(`loopCondition 0x${c.toString(16)}`);
        }
    }
    /** codegen.rs:4679 — `c ^ 1` is the negation only inside the flag-predicate family. */
    conditionNegated(c) {
        if ((c & ~0x3) === 0xE0) throw new Error("the loop family has no ^1 negation");
        this.condition(c ^ 1);
    }

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
    /**
     * codegen.rs:2188 gen_push32, flat + ssize32 short path (no push-run coalescing).
     * The tee'd new ESP stays on the wasm stack across gen_safe_write32 and is consumed by the
     * ESP store — v86 does NOT re-push it, and re-pushing leaks one operand per push. That leak
     * is invisible in any block that ends in a `br` (wasm drops the stack at a branch) and only
     * becomes a validation error where a block falls through, which is why it needs a
     * conformance vector rather than a kernel to surface.
     */
    push32(valueLocal) {
        const mb = this.mb;
        const newSp = mb.allocLocal();
        this.getReg(REG.ESP);
        mb.constI32(4); mb.op(OP.I32SUB);
        mb.teeLocal(newSp);
        this.safeWrite(32, newSp, valueLocal);
        this.setReg(REG.ESP);
        mb.freeLocal(newSp);
    }
    /** codegen.rs:2036 gen_adjust_stack_reg (ssize32) */
    adjustStackReg(offset) {
        const mb = this.mb;
        this.getReg(REG.ESP); mb.constI32(offset); mb.op(OP.I32ADD); this.setReg(REG.ESP);
    }
    /** codegen.rs:2051 gen_leave, ssize32 + flat + os32 */
    leave() {
        const mb = this.mb;
        const oldVbp = mb.allocLocal(), addrL = mb.allocLocal();
        this.getReg(REG.EBP);
        mb.teeLocal(oldVbp);
        mb.setLocal(addrL);
        this.safeRead(32, addrL);
        this.setReg(REG.EBP);
        mb.getLocal(oldVbp); mb.constI32(4); mb.op(OP.I32ADD);
        this.setReg(REG.ESP);
        mb.freeLocal(oldVbp); mb.freeLocal(addrL);
    }
    /** codegen.rs:2288 gen_get_real_eip (flat segmentation) */
    getRealEip(addr) {
        const mb = this.mb;
        this.getEip(); mb.constI32(~0xFFF); mb.op(OP.I32AND);
        mb.constI32(addr & 0xFFF); mb.op(OP.I32OR);
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
    /**
     * jit_instructions.rs:2087 gen_imul3_reg32 — dest = low32(src1 * src2) with the 64-bit
     * product's high half only consulted for CF/OF. `pushSrc2` leaves the second operand on the
     * stack (a register local or an immediate — v86's LocalOrImmediate).
     *
     * The ORDER is load-bearing where dest aliases src1 (`imul eax, eax, 3`): src1 is consumed
     * into the i64 product before dest is written, exactly as the engine does it.
     */
    imul3(destLocal, src1Local, pushSrc2) {
        const mb = this.mb;
        const result = mb.allocLocal64();
        mb.getLocal(src1Local); mb.op(OP.I64EXTENDI32S);
        pushSrc2(); mb.op(OP.I64EXTENDI32S);
        mb.op(OP.I64MUL);
        mb.teeLocal(result);
        mb.op(OP.I32WRAPI64);
        mb.setLocal(destLocal);

        this.setLastResultFromLocal(destLocal);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW);

        // flags = ((sext32(low) != product64) * (CF|OF)) | (flags & ~(CF|OF)) — the C14/N106
        // read-modify-write, so DF/IF survive.
        mb.constI32(G.flags);
        mb.getLocal(result); mb.op(OP.I32WRAPI64); mb.op(OP.I64EXTENDI32S);
        mb.getLocal(result); mb.op(OP.I64NE);
        mb.constI32(FLAG.CARRY | FLAG.OVERFLOW); mb.op(OP.I32MUL);
        this.getFlags(); mb.constI32(~FLAG.CARRY & ~FLAG.OVERFLOW); mb.op(OP.I32AND);
        mb.op(OP.I32OR);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        mb.freeLocal64(result);
    }
    /**
     * jit_instructions.rs:2009 gen_mul32 / :2042 gen_imul32 — edx:eax = eax * src.
     * The two differ only in the extension (unsigned vs signed) and in the CF/OF predicate:
     * MUL asks "is edx nonzero", IMUL asks "does edx sign-extend eax".
     */
    mulEdxEax(signed, pushSrc) {
        const mb = this.mb;
        const result = mb.allocLocal64();
        pushSrc(); mb.op(signed ? OP.I64EXTENDI32S : OP.I64EXTENDI32U);
        this.getReg(REG.EAX); mb.op(signed ? OP.I64EXTENDI32S : OP.I64EXTENDI32U);
        mb.op(OP.I64MUL);
        mb.teeLocal(result);
        mb.constI64(32, 0); mb.op(OP.I64SHRU); mb.op(OP.I32WRAPI64);
        this.setReg(REG.EDX);
        mb.getLocal(result); mb.op(OP.I32WRAPI64);
        this.setReg(REG.EAX);
        mb.freeLocal64(result);

        if (signed) {
            this.getReg(REG.EDX);
            this.getReg(REG.EAX); mb.constI32(31); mb.op(OP.I32SHRS);
            mb.op(OP.I32EQ);
            mb.ifVoid();
            this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW);
            mb.else_();
            this.setFlagsBits(FLAG.CARRY | FLAG.OVERFLOW);
            mb.end();
        }
        else {
            this.getReg(REG.EDX);
            mb.ifVoid();
            this.setFlagsBits(FLAG.CARRY | FLAG.OVERFLOW);
            mb.else_();
            this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW);
            mb.end();
        }
        this.setLastResultFromLocal(this.regs[REG.EAX]);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW);
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

    // ── the 8-bit ALU family (jit_instructions.rs:1055-1640) ───────────────
    // The 8-bit generators differ from their 32-bit siblings in three ways that are all
    // observable in the tuple, so none of them may be "cleaned up": the result is left ON THE
    // STACK (the caller stores it with gen_set_reg8_unmasked or through the RMW shape) rather
    // than written into the dest local; add/sub mask both tuple words to 0xFF while and/or/xor
    // store an UNMASKED `dest OP source`; and the value handed back is a re-LOAD of
    // last_result's low byte, not the computed expression.

    /** jit_instructions.rs:1055 gen_add8 / :1124 gen_sub8 */
    addSub8(destLocal, pushSource, isSub) {
        const mb = this.mb;
        if (this.elide) {
            mb.getLocal(destLocal); pushSource();
            mb.op(isSub ? OP.I32SUB : OP.I32ADD);
            mb.constI32(0xFF); mb.op(OP.I32AND);
            return;
        }
        mb.constI32(G.last_op1);
        mb.getLocal(destLocal); mb.constI32(0xFF); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);

        mb.constI32(G.last_result);
        mb.getLocal(destLocal); pushSource();
        mb.op(isSub ? OP.I32SUB : OP.I32ADD);
        mb.constI32(0xFF); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);

        this.setLastOpSizeAndFlagsChanged(OPSIZE_8, isSub ? (FLAGS_ALL | FLAG.SUB) : FLAGS_ALL);
        this.loadFixedU8(G.last_result);
    }
    /** jit_instructions.rs:1447 gen_and8 / :1549 gen_or8 / :1602 gen_xor8 */
    bitwise8(destLocal, pushSource, wasmOp) {
        const mb = this.mb;
        if (this.elide) {
            mb.getLocal(destLocal); pushSource(); mb.op(wasmOp);
            mb.constI32(0xFF); mb.op(OP.I32AND);
            return;
        }
        mb.constI32(G.last_result);
        mb.getLocal(destLocal); pushSource(); mb.op(wasmOp);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_8, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);
        this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW | FLAG.ADJUST);
        this.loadFixedU8(G.last_result);
    }
    /** jit_instructions.rs:1249 gen_adc8 / :1348 gen_sbb8 — the engine calls a helper here. */
    adcSbb8(destLocal, pushSourceMask255, isSbb) {
        const mb = this.mb;
        mb.getLocal(destLocal); mb.constI32(0xFF); mb.op(OP.I32AND);
        pushSourceMask255();
        mb.call(isSbb ? "sbb8" : "adc8", "ii_i");
        mb.constI32(0xFF); mb.op(OP.I32AND);
    }
    /** jit_instructions.rs:1197 gen_cmp with size == OPSIZE_8 (leaves nothing on the stack) */
    cmp8(destLocal, pushSource, sourceIsZero) {
        const mb = this.mb;
        if (this.elide) return;
        mb.constI32(G.last_result);
        if (sourceIsZero) mb.getLocal(destLocal);
        else { mb.getLocal(destLocal); pushSource(); mb.op(OP.I32SUB); }
        mb.constI32(0xFF); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);

        mb.constI32(G.last_op1);
        mb.getLocal(destLocal); mb.constI32(0xFF); mb.op(OP.I32AND);
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_8, FLAGS_ALL | FLAG.SUB);
    }
    /** jit_instructions.rs:1500 gen_test with size == OPSIZE_8 */
    test8(destLocal, pushSource, isSelfTest) {
        const mb = this.mb;
        if (this.elide) return;
        mb.constI32(G.last_result);
        if (isSelfTest) mb.getLocal(destLocal);
        else { mb.getLocal(destLocal); pushSource(); mb.op(OP.I32AND); }
        mb.store(OP.I32STORE, ALIGN.B4, 0);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_8, FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);
        this.clearFlagsBits(FLAG.CARRY | FLAG.OVERFLOW | FLAG.ADJUST);
    }

    /** jit_instructions.rs:1269 gen_adc32 / :1368 gen_sbb32 — CF in, all three of CF/AF/OF
     *  written architecturally because the lazy protocol cannot express a carry-in. */
    adcSbb32(destLocal, pushSource, isSbb) {
        const mb = this.mb;
        const res = mb.allocLocal();
        mb.getLocal(destLocal); pushSource();
        mb.op(isSbb ? OP.I32SUB : OP.I32ADD);
        this.getcf(false);
        mb.op(isSbb ? OP.I32SUB : OP.I32ADD);
        mb.setLocal(res);

        this.setLastResultFromLocal(res);
        this.setLastOpSizeAndFlagsChanged(OPSIZE_32,
            FLAGS_ALL & ~FLAG.CARRY & ~FLAG.OVERFLOW & ~FLAG.ADJUST);

        mb.constI32(G.flags);
        this.getFlags();
        mb.constI32(~FLAG.CARRY & ~FLAG.ADJUST & ~FLAG.OVERFLOW); mb.op(OP.I32AND);

        // cf
        if (isSbb) {
            // (res ^ ((res ^ source) & (source ^ dest))) >> 31 & FLAG_CARRY
            mb.getLocal(res);
            mb.getLocal(res); pushSource(); mb.op(OP.I32XOR);
            pushSource(); mb.getLocal(destLocal); mb.op(OP.I32XOR);
            mb.op(OP.I32AND);
            mb.op(OP.I32XOR);
        }
        else {
            // (dest ^ ((dest ^ source) & (source ^ res))) >> 31 & FLAG_CARRY
            mb.getLocal(destLocal);
            mb.getLocal(destLocal); pushSource(); mb.op(OP.I32XOR);
            pushSource(); mb.getLocal(res); mb.op(OP.I32XOR);
            mb.op(OP.I32AND);
            mb.op(OP.I32XOR);
        }
        mb.constI32(31); mb.op(OP.I32SHRU);
        mb.constI32(FLAG.CARRY); mb.op(OP.I32AND);
        mb.op(OP.I32OR);

        // af: (dest ^ source ^ res) & FLAG_ADJUST
        mb.getLocal(destLocal); pushSource(); mb.getLocal(res);
        mb.op(OP.I32XOR); mb.op(OP.I32XOR);
        mb.constI32(FLAG.ADJUST); mb.op(OP.I32AND);
        mb.op(OP.I32OR);

        // of
        if (isSbb) {
            // ((source ^ dest) & (res ^ dest)) >> (31-11) & FLAG_OVERFLOW
            pushSource(); mb.getLocal(destLocal); mb.op(OP.I32XOR);
            mb.getLocal(res); mb.getLocal(destLocal); mb.op(OP.I32XOR);
        }
        else {
            // ((source ^ res) & (dest ^ res)) >> (31-11) & FLAG_OVERFLOW
            pushSource(); mb.getLocal(res); mb.op(OP.I32XOR);
            mb.getLocal(destLocal); mb.getLocal(res); mb.op(OP.I32XOR);
        }
        mb.op(OP.I32AND);
        mb.constI32(31 - 11); mb.op(OP.I32SHRU);
        mb.constI32(FLAG.OVERFLOW); mb.op(OP.I32AND);
        mb.op(OP.I32OR);

        mb.store(OP.I32STORE, ALIGN.B4, 0);

        mb.getLocal(res); mb.setLocal(destLocal);
        mb.freeLocal(res);
    }

    /** jit_instructions.rs:1664 gen_rol32 family — helper call, count masked twice as v86 does. */
    rot32(destLocal, name, count) {
        const mb = this.mb;
        mb.getLocal(destLocal);
        if (count.cl) { this.getReg(REG.ECX); mb.constI32(31); mb.op(OP.I32AND); }
        else mb.constI32(count.imm & 31);
        mb.constI32(31); mb.op(OP.I32AND);
        mb.call(name, "ii_i");
        mb.setLocal(destLocal);
    }

    /** The `cl` / `constant_one` / `imm8_5bits` arms of define_instruction_read_write_mem8
     *  (jit_instructions.rs:657-748): the count for an 8-bit shift/rotate helper. */
    pushShift8Count(count) {
        const mb = this.mb;
        if (count.cl) { this.getReg8(REG.ECX); mb.constI32(31); mb.op(OP.I32AND); }
        else mb.constI32(count.imm & 31);
    }
}

/** jit_instructions.rs:3421-3550 — the 8-bit shift/rotate helper names. */
const SHIFT8_HELPER = { rol: "rol8", ror: "ror8", rcl: "rcl8", rcr: "rcr8", shl: "shl8", shr: "shr8", sar: "sar8" };
/** jit_instructions.rs:3225-3560 — the 32-bit rotate helper names (shl/shr/sar are native). */
const ROT32_HELPER = { rol: "rol32", ror: "ror32", rcl: "rcl32", rcr: "rcr32" };

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
            if (ins.size === 8) return emitAlu8RRm(E, ins);
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
            if (ins.size === 8) return emitAlu8RmR(E, ins);
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
            if (ins.size === 8) {
                // jit_instructions.rs:398 group_arith_al_imm8 — dest is the FULL eax local and
                // the result is written back with gen_set_reg8_unmasked; cmp (0x3C) writes nothing.
                const dest = E.regs[REG.EAX];
                if (ins.alu === "cmp") { E.cmp8(dest, () => mb.constI32(ins.imm), ins.imm === 0); return; }
                emitAlu8(E, ins.alu, dest, imm8Source(mb, ins.imm));
                E.setReg8Unmasked(REG.EAX);
                return;
            }
            emitAlu(E, ins.alu, E.regs[REG.EAX], () => mb.constI32(ins.imm), false, ins.imm === 0);
            return;
        }
        case "alu_rm_imm": {
            if (ins.size === 8) return emitAlu8RmImm(E, ins);
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
            if (ins.size === 8) {
                // jit_instructions.rs:2996 define_instruction_read8!(gen_test8, ...)
                if (m.isReg) {
                    const d = E.getReg8Alias(m.rm), s = E.getReg8Alias(ins.reg);
                    E.test8(d.local, () => mb.getLocal(s.local), d.local === s.local);
                    E.freeReg8Alias(d); E.freeReg8Alias(s);
                    return;
                }
                const a = E.addrLocal(m);
                E.safeRead(8, a);
                const d = mb.allocLocal(); mb.setLocal(d);
                const s = E.getReg8Alias(ins.reg);
                E.test8(d, () => mb.getLocal(s.local), false);
                E.freeReg8Alias(s); mb.freeLocal(d); mb.freeLocal(a);
                return;
            }
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
            if (ins.size === 8) {
                if (m.isReg) {
                    const d = E.getReg8Alias(m.rm);
                    E.test8(d.local, () => mb.constI32(ins.imm & 0xFF), false);
                    E.freeReg8Alias(d);
                    return;
                }
                const a = E.addrLocal(m);
                E.safeRead(8, a);
                const d = mb.allocLocal(); mb.setLocal(d);
                E.test8(d, () => mb.constI32(ins.imm & 0xFF), false);
                mb.freeLocal(d); mb.freeLocal(a);
                return;
            }
            if (m.isReg) { E.test32(E.regs[m.rm], () => mb.constI32(ins.imm), false); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const d = mb.allocLocal(); mb.setLocal(d);
            E.test32(d, () => mb.constI32(ins.imm), false);
            mb.freeLocal(d); mb.freeLocal(a);
            return;
        }
        case "test_acc_imm": {
            // jit_instructions.rs:4779 instr_A8_jit / :4787 instr32_A9_jit — dest is eax itself.
            if (ins.size === 8) E.test8(E.regs[REG.EAX], () => mb.constI32(ins.imm & 0xFF), false);
            else E.test32(E.regs[REG.EAX], () => mb.constI32(ins.imm), false);
            return;
        }

        case "inc_r": E.incDec32(E.regs[ins.reg], false); return;
        case "dec_r": E.incDec32(E.regs[ins.reg], true); return;
        case "inc_rm": case "dec_rm": {
            const isDec = ins.kind === "dec_rm";
            // jit_instructions.rs:4416 — the 8-bit forms are helper calls ("inc8"/"dec8"), so the
            // whole lazy-flag protocol for them lives in the engine and is inherited exactly.
            if (ins.size === 8) return emitHelper8(E, ins, isDec ? "dec8" : "inc8");
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
            if (ins.size === 8) return emitHelper8(E, ins, "not8");   // jit_instructions.rs:4224
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
            if (ins.size === 8) return emitHelper8(E, ins, "neg8");   // jit_instructions.rs:4225
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
            if (ins.size === 8) {
                // Every 8-bit shift and rotate is a helper call in v86 (jit_instructions.rs:3421).
                const helper = SHIFT8_HELPER[ins.sh];
                if (m.isReg) {
                    E.getReg8(m.rm); E.pushShift8Count(ins.count);
                    mb.call(helper, "ii_i");
                    E.setReg8(m.rm);
                    return;
                }
                const a8 = E.addrLocal(m);
                E.safeReadWrite(8, a8, () => {
                    E.pushShift8Count(ins.count);
                    mb.call(helper, "ii_i");
                });
                mb.freeLocal(a8);
                return;
            }
            if (ROT32_HELPER[ins.sh]) {
                const helper = ROT32_HELPER[ins.sh];
                if (m.isReg) { E.rot32(E.regs[m.rm], helper, ins.count); return; }
                const ar = E.addrLocal(m);
                E.safeReadWrite(32, ar, () => {
                    const d = mb.allocLocal(); mb.setLocal(d);
                    E.rot32(d, helper, ins.count);
                    mb.getLocal(d); mb.freeLocal(d);
                });
                mb.freeLocal(ar);
                return;
            }
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
        case "push_rm": {
            // jit_instructions.rs:381 push32_mem_jit / :359 push32_reg_jit
            if (m.isReg) { E.push32(E.regs[m.rm]); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const v = mb.allocLocal(); mb.setLocal(v);
            E.push32(v);
            mb.freeLocal(v); mb.freeLocal(a);
            return;
        }
        case "pop_rm": {
            // jit_instructions.rs:3201 instr32_8F_0_mem_jit: the address is resolved BEFORE the
            // pop and ESP is put back to its pre-pop value across the store, so a #PF on the
            // store leaves the guest restartable (contract N62a).
            if (m.isReg) { E.pop32(); E.setReg(m.rm); return; }
            const a = E.addrLocal(m);
            E.pop32();
            const v = mb.allocLocal(); mb.setLocal(v);
            E.adjustStackReg(-4);
            E.safeWrite(32, a, v);
            E.adjustStackReg(4);
            mb.freeLocal(v); mb.freeLocal(a);
            return;
        }
        case "leave": E.leave(); return;
        case "xchg_acc_r": {
            // jit_instructions.rs:4566 gen_xchg_reg32
            const tmp = mb.allocLocal();
            E.getReg(ins.reg); mb.setLocal(tmp);
            E.getReg(REG.EAX); E.setReg(ins.reg);
            mb.getLocal(tmp); E.setReg(REG.EAX);
            mb.freeLocal(tmp);
            return;
        }
        case "xchg_rm_r": {
            // jit_instructions.rs:3051 instr32_87_reg_jit / :3011 instr_86_reg_jit
            const tmp = mb.allocLocal();
            if (ins.size === 32) {
                E.getReg(ins.reg); mb.setLocal(tmp);
                E.getReg(m.rm); E.setReg(ins.reg);
                mb.getLocal(tmp); E.setReg(m.rm);
            }
            else {
                E.getReg8(ins.reg); mb.setLocal(tmp);
                E.getReg8(m.rm); E.setReg8(ins.reg);
                mb.getLocal(tmp); E.setReg8(m.rm);
            }
            mb.freeLocal(tmp);
            return;
        }
        case "cwde": {
            // jit_instructions.rs:4602 instr32_98_jit — sign_extend_i16 (codegen.rs:482)
            E.getReg(REG.EAX);
            mb.constI32(16); mb.op(OP.I32SHL); mb.constI32(16); mb.op(OP.I32SHRS);
            E.setReg(REG.EAX);
            return;
        }
        case "cdq": {
            // jit_instructions.rs:4616 instr32_99_jit
            E.getReg(REG.EAX);
            mb.constI32(31); mb.op(OP.I32SHRS);
            E.setReg(REG.EDX);
            return;
        }
        case "cmovcc": {
            // jit_instructions.rs:5681 define_cmovcc32!. The source read is UNCONDITIONAL — it is
            // the instruction's fault point and it happens whether or not the condition holds —
            // and only the register write sits inside the `if`.
            const value = mb.allocLocal();
            if (m.isReg) { E.getReg(m.rm); mb.setLocal(value); }
            else {
                const a = E.addrLocal(m);
                E.safeRead(32, a); mb.setLocal(value);
                mb.freeLocal(a);
            }
            E.condition(ins.cond);
            mb.ifVoid();
            mb.getLocal(value); E.setReg(ins.reg);
            mb.end();
            mb.freeLocal(value);
            return;
        }
        case "bitscan": {
            // jit_instructions.rs:2308 gen_bsf32 / :2315 gen_bsr32, wrapped by
            // define_instruction_write_reg32! (:601): the memory read happens first, then the
            // helper is called with (old dest, source). The helper owns the whole flag protocol.
            const dest = E.regs[ins.reg];
            if (m.isReg) {
                mb.getLocal(dest); E.getReg(m.rm);
            }
            else {
                const a = E.addrLocal(m);
                E.safeRead(32, a);
                const src = mb.allocLocal(); mb.setLocal(src);
                mb.getLocal(dest); mb.getLocal(src);
                mb.freeLocal(src); mb.freeLocal(a);
            }
            mb.call(ins.helper, "ii_i");
            mb.setLocal(dest);
            return;
        }
        case "bswap": {
            // jit_instructions.rs:2322 gen_bswap
            const l = E.regs[ins.reg];
            mb.getLocal(l); mb.constI32(8); mb.op(OP.I32ROTL);
            mb.constI32(0xFF00FF); mb.op(OP.I32AND);
            mb.getLocal(l); mb.constI32(24); mb.op(OP.I32ROTL);
            mb.constI32(0xFF00FF00 | 0); mb.op(OP.I32AND);
            mb.op(OP.I32OR);
            mb.setLocal(l);
            return;
        }
        case "imul_rm": {
            // jit_instructions.rs:5656 / :2079 gen_imul_reg32 = gen_imul3_reg32(dest, dest, src)
            const dest = E.regs[ins.reg];
            if (m.isReg) { E.imul3(dest, dest, () => E.getReg(m.rm)); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const src = mb.allocLocal(); mb.setLocal(src);
            E.imul3(dest, dest, () => mb.getLocal(src));
            mb.freeLocal(src); mb.freeLocal(a);
            return;
        }
        case "imul3": {
            // jit_instructions.rs:2790/:2803/:2825/:2836 — dest is the REG field, src1 the r/m
            // operand, src2 the immediate. dest may alias src1 (`imul eax, eax, 3`), which is why
            // imul3 reads src1 into the i64 accumulator BEFORE writing dest.
            const dest = E.regs[ins.reg];
            if (m.isReg) { E.imul3(dest, E.regs[m.rm], () => mb.constI32(ins.imm)); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const src = mb.allocLocal(); mb.setLocal(src);
            E.imul3(dest, src, () => mb.constI32(ins.imm));
            mb.freeLocal(src); mb.freeLocal(a);
            return;
        }
        case "mul_1op":
        case "imul_1op": {
            // jit_instructions.rs:2009 gen_mul32 / :2042 gen_imul32 — edx:eax = eax * src.
            const signed = ins.kind === "imul_1op";
            if (m.isReg) { E.mulEdxEax(signed, () => E.getReg(m.rm)); return; }
            const a = E.addrLocal(m);
            E.safeRead(32, a);
            const src = mb.allocLocal(); mb.setLocal(src);
            E.mulEdxEax(signed, () => mb.getLocal(src));
            mb.freeLocal(src); mb.freeLocal(a);
            return;
        }
        case "loopcc": {
            // The instruction BODY of LOOP/LOOPE/LOOPNE is codegen.rs:319 decr_exc_asize; the
            // conditional transfer is the block terminator and reads ecx AFTER this decrement
            // (jit_instructions.rs:2880-2885). JECXZ's body is empty (:2886-2887).
            if (ins.decrEcx) {
                E.getReg(REG.ECX); mb.constI32(1); mb.op(OP.I32SUB); E.setReg(REG.ECX);
            }
            return;
        }
        case "clc": E.clearFlagsChangedBits(FLAG.CARRY); E.clearFlagsBits(FLAG.CARRY); return;
        case "stc": E.clearFlagsChangedBits(FLAG.CARRY); E.setFlagsBits(FLAG.CARRY); return;
        case "cld": E.clearFlagsBits(FLAG.DIRECTION); return;   // jit_instructions.rs:4400
        case "std": E.setFlagsBits(FLAG.DIRECTION); return;     // jit_instructions.rs:4408

        case "call": {
            // jit_instructions.rs:3328 instr32_E8_jit — only the return-address push is the
            // instruction; the control transfer is the block terminator (emitBlock).
            E.getRealEip(ins.next);
            const v = mb.allocLocal(); mb.setLocal(v);
            E.push32(v);
            mb.freeLocal(v);
            return;
        }
        default:
            throw new Error(`emitInstruction: unhandled kind ${ins.kind}`);
    }
}

/** A source operand of an 8-bit ALU op: v86's LocalOrImmediate, with its two accessors. */
function localSource(mb, local) {
    return {
        push: () => mb.getLocal(local),
        pushMask255: () => { mb.getLocal(local); mb.constI32(0xFF); mb.op(OP.I32AND); },
        local,
    };
}
function imm8Source(mb, imm) {
    return {
        push: () => mb.constI32(imm & 0xFF),
        pushMask255: () => mb.constI32(imm & 0xFF),
        local: null,
    };
}

/** jit_instructions.rs:1055-1640, dispatched by op — the value is left on the stack. */
function emitAlu8(E, alu, destLocal, src) {
    switch (alu) {
        case "add": return E.addSub8(destLocal, src.push, false);
        case "sub": return E.addSub8(destLocal, src.push, true);
        case "and": return E.bitwise8(destLocal, src.push, OP.I32AND);
        case "or": return E.bitwise8(destLocal, src.push, OP.I32OR);
        case "xor": return E.bitwise8(destLocal, src.push, OP.I32XOR);
        case "adc": return E.adcSbb8(destLocal, src.pushMask255, false);
        case "sbb": return E.adcSbb8(destLocal, src.pushMask255, true);
        default: throw new Error(`emitAlu8: ${alu}`);
    }
}

/** 0x02/0x0A/… — define_instruction_write_reg8 (jit_instructions.rs:560), cmp via instr_3A_*. */
function emitAlu8RRm(E, ins) {
    const mb = E.mb, m = ins.m;
    if (ins.alu === "cmp") {
        const dest = E.getReg8Alias(ins.reg);
        if (m.isReg) {
            const s = E.getReg8Alias(m.rm);
            E.cmp8(dest.local, () => mb.getLocal(s.local), false);
            E.freeReg8Alias(s);
        }
        else {
            const a = E.addrLocal(m);
            E.safeRead(8, a);
            const s = mb.allocLocal(); mb.setLocal(s);
            E.cmp8(dest.local, () => mb.getLocal(s), false);
            mb.freeLocal(s); mb.freeLocal(a);
        }
        E.freeReg8Alias(dest);
        return;
    }
    let srcLocal, srcAlias = null, addr = null;
    if (m.isReg) { srcAlias = E.getReg8Alias(m.rm); srcLocal = srcAlias.local; }
    else { addr = E.addrLocal(m); E.safeRead(8, addr); srcLocal = mb.allocLocal(); mb.setLocal(srcLocal); }
    const dest = E.getReg8Alias(ins.reg);
    emitAlu8(E, ins.alu, dest.local, localSource(mb, srcLocal));
    E.setReg8Unmasked(ins.reg);
    if (srcAlias) E.freeReg8Alias(srcAlias); else { mb.freeLocal(srcLocal); mb.freeLocal(addr); }
    E.freeReg8Alias(dest);
}

/** 0x00/0x08/… — define_instruction_read_write_mem8 (jit_instructions.rs:633), cmp via read8. */
function emitAlu8RmR(E, ins) {
    const mb = E.mb, m = ins.m;
    if (m.isReg) {
        const src = E.getReg8Alias(ins.reg);
        const dest = E.getReg8Alias(m.rm);
        if (ins.alu === "cmp") E.cmp8(dest.local, () => mb.getLocal(src.local), false);
        else {
            emitAlu8(E, ins.alu, dest.local, localSource(mb, src.local));
            E.setReg8Unmasked(m.rm);
        }
        E.freeReg8Alias(dest); E.freeReg8Alias(src);
        return;
    }
    const a = E.addrLocal(m);
    if (ins.alu === "cmp") {
        E.safeRead(8, a);
        const d = mb.allocLocal(); mb.setLocal(d);
        const src = E.getReg8Alias(ins.reg);
        E.cmp8(d, () => mb.getLocal(src.local), false);
        E.freeReg8Alias(src); mb.freeLocal(d);
    }
    else {
        E.safeReadWrite(8, a, () => {
            const d = mb.allocLocal(); mb.setLocal(d);
            const src = E.getReg8Alias(ins.reg);
            emitAlu8(E, ins.alu, d, localSource(mb, src.local));
            E.freeReg8Alias(src); mb.freeLocal(d);
        });
    }
    mb.freeLocal(a);
}

/** 0x80 / 0x82 group — the ximm8 arm; cmp (/7) is read-only (instr_80_7_*). */
function emitAlu8RmImm(E, ins) {
    const mb = E.mb, m = ins.m;
    const src = imm8Source(mb, ins.imm);
    if (m.isReg) {
        const dest = E.getReg8Alias(m.rm);
        if (ins.alu === "cmp") E.cmp8(dest.local, src.push, (ins.imm & 0xFF) === 0);
        else { emitAlu8(E, ins.alu, dest.local, src); E.setReg8Unmasked(m.rm); }
        E.freeReg8Alias(dest);
        return;
    }
    const a = E.addrLocal(m);
    if (ins.alu === "cmp") {
        E.safeRead(8, a);
        const d = mb.allocLocal(); mb.setLocal(d);
        E.cmp8(d, src.push, (ins.imm & 0xFF) === 0);
        mb.freeLocal(d);
    }
    else {
        E.safeReadWrite(8, a, () => {
            const d = mb.allocLocal(); mb.setLocal(d);
            emitAlu8(E, ins.alu, d, src);
            mb.freeLocal(d);
        });
    }
    mb.freeLocal(a);
}

/** The `none` arm of define_instruction_read_write_mem8: one-argument helper, masked get/set. */
function emitHelper8(E, ins, helper) {
    const mb = E.mb, m = ins.m;
    if (m.isReg) {
        E.getReg8(m.rm);
        mb.call(helper, "i_i");
        E.setReg8(m.rm);
        return;
    }
    const a = E.addrLocal(m);
    E.safeReadWrite(8, a, () => { mb.call(helper, "i_i"); });
    mb.freeLocal(a);
}

function emitAlu(E, alu, destLocal, pushSource, sourceAliasesDest, sourceIsZero = false) {
    if (alu === "cmp") return E.cmp32(destLocal, pushSource, sourceIsZero);
    if (alu === "adc" || alu === "sbb") return E.adcSbb32(destLocal, pushSource, alu === "sbb");
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
    // B7 site 1: the module top, INSIDE the loop, so every in-module re-dispatch re-checks it
    // (jit.rs:3377, which sits between `loop_void()` and `block_void()` for the same reason).
    E.loopSafety();
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
        if (loopLabel) {
            mb.loop(loopLabel);
            // B7 site 2, jit.rs:4131-4149 for `entries.len() == 1`: the loop head's EIP low bits
            // are stored UNCONDITIONALLY (outside the JIT_USE_LOOP_SAFETY guard, jit.rs:4133),
            // then the counter is compared. The EIP store is what makes the bounded exit useful:
            // it is the address the guest must resume at when the bound fires.
            E.setEipLowBits(b.addr & 0xFFF);
            E.loopSafety();
        }
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
        pageBase: job.pageBase,
        loopCounter: E.loopCounter,
        entries: blocks.map((b) => [b.addr - job.pageBase, b.index]),
        // Every discovered block is published as a dispatcher entry, and `discoverBlocks`
        // splits further than the engine's own `marked_as_entry` set — so the unit answers
        // dispatch at addresses at which the JIT would take a cache miss. Each such block
        // begins exactly at its published address and the prologue seeds all locals (N24), so
        // the guest work is unchanged; what differs is the MISS RATE, which is a property of
        // the candidate arm a ratio must be read against. Reported, not assumed.
        entriesBeyondEngine: blocks
            .map((b) => b.addr)
            .filter((a) => !job.entryAddrs.includes(a))
            .map((a) => a - job.pageBase),
        blocks: blocks.map((b) => ({
            addr: b.addr, index: b.index, instructions: b.numInstructions, ty: b.ty?.type,
        })),
        unsupported: unsupported.map((u) => ({ addr: u.addr, why: u.why })),
        // Totality of the RETURN half (design K5). A call's return point is the one successor the
        // guest is guaranteed to reach; if it is not a published entry the return dispatches to a
        // miss and the JIT displaces the unit (§4.2). Reported rather than assumed, for both the
        // direct and the indirect encoding, so an unpublished return point is a visible property
        // of the unit instead of an unexplained `aot.alive=false` later.
        callReturnPointsUnpublished: blocks
            .filter((b) => (b.ty?.type === "call") ||
                (b.ty?.type === "absolute" && b.ty.ins?.kind === "call_rm"))
            .map((b) => (b.ty.type === "call" ? b.ty.next : b.ty.ins.next))
            .filter((a) => !byAddr.has(a)),
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

    // A `call`'s own body (the return-address push) IS emitted; only its control transfer is
    // handled below. Every other terminator is emitted entirely by the switch.
    // `loopcc` is the one conditional terminator that also HAS a body (the ecx decrement,
    // codegen.rs:319), and the decrement must run BEFORE the predicate reads ecx — so it is
    // emitted by the instruction loop like `call`'s return-address push, not skipped.
    const isTerminatorIns = (a) =>
        (b.ty?.type === "cond" || b.ty?.type === "jmp" || b.ty?.type === "absolute") &&
        a === b.lastInsAddr && env.decoded.get(a)?.kind !== "loopcc";

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
    // Re-enter the module dispatcher (contract N14). EIP MUST be materialized first, and that
    // is not decoration: the main loop's B7 guard can exit from here, and so can the
    // brtable_default arm (N16), and neither epilogue writes EIP (N25) — so a re-dispatch with a
    // stale EIP resumes the guest at the wrong address. The engine has the same invariant by
    // construction: both of its `set_local(target); br(main_loop)` sites sit after a DYNAMIC eip
    // it reads back with `gen_get_eip` (jit.rs:3567-3577, :3581-3595), so it never re-dispatches
    // to a statically known target without eip in memory. We do, hence the explicit store.
    // Measured, not reasoned: with B7's bound lowered to 8 (see README) the missing store made k4
    // panic `Unimplemented: #GP handler` out of trigger_fault_end_jit.
    const redispatch = (t) => {
        E.setEipLowBits(t.addr & 0xFFF);
        mb.constI32(t.index); mb.setLocal(0); mb.br(L_MAIN);
    };
    const gotoBlock = (targetAddr, relFrom, rel) => {
        const t = byAddr.get(targetAddr);
        if (!t) { leaveTo(targetAddr, relFrom, rel); return; }
        if (loopLabel && targetAddr === b.addr) { mb.br(loopLabel); return; }
        if (t.index > i) { mb.br(`B${t.index}`); return; }
        if (t.index === i + 1) return;                       // natural fallthrough
        redispatch(t);                                       // backward edge, not a self-loop
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
                    redispatch(t);
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
            redispatch(f);
            return;
        }
        case "jmp":
        case "call":
            // Identical control transfer: an unconditional edge to the target. For a call the
            // return point is a separate published entry (cfg.mjs), reached through the
            // dispatcher when the callee returns.
            gotoBlock(b.ty.target, b.endAddr, b.ty.ins.rel);
            return;
        case "fall": {
            const f = byAddr.get(b.ty.next);
            if (!f) { E.setEipLowBits(b.ty.next & 0xFFF); mb.br(L_EXIT); return; }
            if (f.index === i + 1) return;
            if (f.index > i) { mb.br(`B${f.index}`); return; }
            redispatch(f);
            return;
        }
        case "absolute": {
            // Three encodings whose successor is a RUN-TIME value: RET, and the indirect near
            // CALL/JMP. All three write an absolute EIP and leave — no ret-chaining, no
            // ret-speculation, no guarded eip-compare chain, hence no
            // `jit_find_cache_entry_in_page(<baked slot>)` and no baked table index (E1).
            E.startOfCurrentInstruction = b.lastInsAddr;
            const ins = b.ty.ins;
            if (ins.kind === "ret") {
                // jit_instructions.rs:3368 instr32_C3_jit
                mb.constI32(0);
                E.pop32();
                mb.store(OP.I32STORE, ALIGN.B4, G.instruction_pointer);
                if (ins.pop) {
                    E.getReg(REG.ESP); mb.constI32(ins.pop); mb.op(OP.I32ADD); E.setReg(REG.ESP);
                }
            }
            else if (ins.kind === "call_rm") {
                // jit_instructions.rs:4453 instr32_FF_2_mem_jit / :4469 _reg_jit. The two forms
                // differ in ORDER and that order is normative: the memory form reads the target
                // FIRST, so a #PF on the read leaves ESP untouched and the instruction is
                // restartable (contract N62a). Flat segmentation ⇒ gen_add_cs_offset is nothing.
                let target = null;
                if (!ins.m.isReg) {
                    const addrL = E.addrLocal(ins.m);
                    E.safeRead(32, addrL);
                    target = mb.allocLocal(); mb.setLocal(target);
                    mb.freeLocal(addrL);
                }
                E.getRealEip(ins.next);
                const v = mb.allocLocal(); mb.setLocal(v);
                E.push32(v);
                mb.freeLocal(v);
                mb.constI32(0);
                if (target !== null) { mb.getLocal(target); mb.freeLocal(target); }
                else E.getReg(ins.m.rm);
                mb.store(OP.I32STORE, ALIGN.B4, G.instruction_pointer);
            }
            else if (ins.kind === "jmp_rm") {
                // jit_instructions.rs:4496 instr32_FF_4_mem_jit / :4503 _reg_jit
                mb.constI32(0);
                if (!ins.m.isReg) {
                    const addrL = E.addrLocal(ins.m);
                    E.safeRead(32, addrL);
                    mb.freeLocal(addrL);
                }
                else E.getReg(ins.m.rm);
                mb.store(OP.I32STORE, ALIGN.B4, G.instruction_pointer);
            }
            else throw new Error(`absolute terminator: unhandled kind ${ins.kind}`);
            mb.br(L_EXIT);
            return;
        }
        case "exit":
        default:
            mb.br(L_EXIT);
            return;
    }
}
