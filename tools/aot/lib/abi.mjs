// The engine-side ABI an AOT unit is compiled against.
//
// Every address and mask here is normative and carries its source. They are transcribed, not
// guessed: `plan/aot-module-contract.md` §3 (linear-memory ABI) and §5 (memory shapes), which
// in turn cite `vendor/v86/src/rust/cpu/global_pointers.rs` and `cpu/cpu.rs`.

/** vendor/v86/src/rust/cpu/global_pointers.rs (contract §3) */
export const G = {
    reg32: 64,              // :9   8 x i32, 64..92
    last_op_size: 96,       // :11
    flags_changed: 100,     // :12
    last_op1: 104,          // :13
    state_flags: 108,       // :14
    last_result: 112,       // :15
    flags: 120,             // :16
    instruction_pointer: 556, // :23
    previous_ip: 560,       // :24
    cpl: 612,               // :29
    fpu_simd_dirty: 632,    // :34
    instruction_counter: 664, // :40
    segment_offsets: 736,   // :49
    memory_size: 812,       // :55
    fpu_stack_empty: 816,   // :56
    mxcsr: 824,             // :57
    reg_xmm: 832,           // :59
    fpu_stack_ptr: 1032,    // :64
    fpu_st: 1152,           // :75
    fastmem_generation: 1280, // :78
};
export const reg32Offset = (i) => G.reg32 + i * 4;

/** vendor/v86/src/rust/cpu/cpu.rs:84-124 */
export const FLAG = {
    SUB: -0x8000_0000, CARRY: 1, PARITY: 4, ADJUST: 16, ZERO: 64, SIGN: 128, OVERFLOW: 2048,
};
export const FLAGS_ALL = FLAG.CARRY | FLAG.PARITY | FLAG.ADJUST | FLAG.ZERO | FLAG.SIGN | FLAG.OVERFLOW;
export const OPSIZE_8 = 7, OPSIZE_16 = 15, OPSIZE_32 = 31;

/** vendor/v86/src/rust/cpu/cpu.rs:259-264 */
export const TLB = { VALID: 1, READONLY: 2, NO_USER: 4, IN_MAPPED_RANGE: 8, GLOBAL: 16, HAS_CODE: 32 };

/** vendor/v86/src/rust/state_flags.rs */
export const SF = { IS_32: 1, SS32: 2, CPL3: 4, FLAT_SEGS: 8 };

/**
 * Read mask, contract N45 / codegen.rs:711-717:
 *   0xFFF & !READONLY & !GLOBAL & !HAS_CODE & !(cpl3 ? 0 : NO_USER)
 */
export const tlbReadMask = (cpl3) =>
    (0xFFF & ~TLB.READONLY & ~TLB.GLOBAL & ~TLB.HAS_CODE & ~(cpl3 ? 0 : TLB.NO_USER)) | 0;
/**
 * Write mask, contract N46 / codegen.rs:1386-1387 — DIFFERENT from the read mask on purpose:
 * READONLY and HAS_CODE stay live so a read-only or code-bearing page always takes the slow
 * path, which is what performs jit_dirty_page. The per-store guard IS the SMC/CoW net.
 */
export const tlbWriteMask = (cpl3) =>
    (0xFFF & ~TLB.GLOBAL & ~(cpl3 ? 0 : TLB.NO_USER)) | 0;

export const REG = { EAX: 0, ECX: 1, EDX: 2, EBX: 3, ESP: 4, EBP: 5, ESI: 6, EDI: 7 };
export const REG_NAMES = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

/** Engine helpers this slice may import. Verified against the shipped exports at build time. */
export const HELPERS = {
    safe_read8_slow_jit: "ii_i",
    safe_read16_slow_jit: "ii_i",
    safe_read32s_slow_jit: "ii_i",
    safe_write8_slow_jit: "iii_i",
    safe_write16_slow_jit: "iii_i",
    safe_write32_slow_jit: "iii_i",
    safe_read_write8_slow_jit: "ii_i",
    safe_read_write16_slow_jit: "ii_i",
    safe_read_write32s_slow_jit: "ii_i",
    trigger_fault_end_jit: "v_v",
    test_p: "v_v_ret",   // placeholder, unused in this slice
};
