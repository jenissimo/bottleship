// aot-oracle — architectural state snapshots.
//
// Two independent views of "the registers came out the same", on purpose:
//
//   1. GUEST-VISIBLE (every arm, no exceptions): the driver spills the 8 GPRs and EFLAGS to
//      L.STATE at the capture point, and that region is compared as memory. This is the
//      assertion the module contract actually makes — a unit MUST have flushed its register
//      locals to memory at every exit (RFC §4.2) — so a candidate that keeps the register
//      file only in wasm locals fails here, loudly, at a named register.
//
//   2. HOST-SIDE (any arm hosted by v86, i.e. the reference and any contract-shaped AOT
//      unit): the full CPU state read straight out of the engine's memory — reg32, EIP, the
//      materialized EFLAGS, the LAZY FLAG 5-TUPLE, the x87 slots + stack pointer/empty mask,
//      MXCSR/XMM, fpu_simd_dirty and the instruction counter. `get_eflags()` alone cannot
//      catch a tuple that is incoherent in a way the current getters happen not to expose
//      (design §5.3 G1), which is why the raw tuple is compared as well as the materialized
//      value.
//
// A candidate that is not hosted by v86 may publish view 2 itself through the optional state
// block below; when it does not, the oracle reports exactly which fields went uncompared —
// it never silently drops them.

/** Offsets in v86's wasm memory (vendor/v86/src/cpu.js:120-240, cpu/global_pointers.rs). */
const OFF = {
    reg32: 64, last_op_size: 96, flags_changed: 100, last_op1: 104, last_result: 112,
    flags: 120, instruction_pointer: 556, fpu_simd_dirty: 632, instruction_counter: 664,
    fpu_stack_empty: 816, mxcsr: 824, reg_xmm32s: 832, fpu_stack_ptr: 1032,
    fpu_control_word: 1036, fpu_status_word: 1040, fpu_st: 1152,
};

export const REG_NAMES = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

/**
 * Optional state block a non-v86 candidate can publish so the host-side view is comparable
 * for it too. ABI 1, little-endian, in the candidate's own linear memory:
 *   +0  u32 magic 'BSST' (0x54535342)   +4  u32 abi (1)
 *   +8  u32[8] reg32 (v86 order)        +40 u32 eip        +44 u32 eflags
 *   +48 u32 flags  +52 u32 flags_changed  +56 u32 last_op1  +60 u32 last_result
 *   +64 u32 last_op_size                +68 u32 fpu_stack_ptr  +72 u32 fpu_stack_empty
 *   +76 f64[8] st(0..7)                 +140 u32 instruction_counter
 * Exports: `bs_state_abi() -> i32`, `bs_state_ptr() -> i32`.
 */
export const STATE_BLOCK_MAGIC = 0x54535342;
export const STATE_BLOCK_ABI = 1;

const u32 = (dv, o) => dv.getUint32(o, true) >>> 0;

/** Read the full architectural state out of a live v86 CPU. */
export function readV86State(cpu) {
    const mem = cpu.wm.exports.memory ?? cpu.wm.memory;
    const dv = new DataView(mem.buffer);
    const regs = {};
    for (let i = 0; i < 8; i++) regs[REG_NAMES[i]] = u32(dv, OFF.reg32 + i * 4);
    const st = [];
    for (let i = 0; i < 32; i++) st.push(u32(dv, OFF.fpu_st + i * 4));
    const xmm = [];
    for (let i = 0; i < 32; i++) xmm.push(u32(dv, OFF.reg_xmm32s + i * 4));
    // A refused materialization leaves eflags null, which the comparator reports as
    // UNCOMPARED — never as agreement. The reason travels with it so the report can say
    // which arm could not read its own flags.
    let eflags = null, eflagsError = null;
    try { eflags = cpu.wm.exports.get_eflags() >>> 0; } catch (e) { eflagsError = String(e?.message ?? e); }
    return {
        source: "v86",
        regs,
        eip: u32(dv, OFF.instruction_pointer),
        eflags,
        eflags_error: eflagsError,
        lazy: {
            flags: u32(dv, OFF.flags),
            flags_changed: u32(dv, OFF.flags_changed),
            last_op1: u32(dv, OFF.last_op1),
            last_result: u32(dv, OFF.last_result),
            last_op_size: u32(dv, OFF.last_op_size),
        },
        fpu: {
            stack_ptr: dv.getUint8(OFF.fpu_stack_ptr),
            stack_empty: dv.getUint8(OFF.fpu_stack_empty),
            control_word: dv.getUint16(OFF.fpu_control_word, true),
            status_word: dv.getUint16(OFF.fpu_status_word, true),
            simd_dirty: dv.getUint8(OFF.fpu_simd_dirty),
            st,
        },
        simd: { mxcsr: u32(dv, OFF.mxcsr), xmm },
        instruction_counter: u32(dv, OFF.instruction_counter),
    };
}

/**
 * Read the optional state block from a foreign candidate module.
 * Returns null when the candidate does not publish one (which is not an error here — the
 * caller reports it; the guest-visible STATE region still carries the register assertion).
 */
export function readCandidateStateBlock(exports) {
    if (typeof exports.bs_state_ptr !== "function") return null;
    const abi = typeof exports.bs_state_abi === "function" ? exports.bs_state_abi() >>> 0 : 0;
    if (abi !== STATE_BLOCK_ABI) {
        throw new Error(`candidate state block ABI ${abi}, oracle speaks ${STATE_BLOCK_ABI}`);
    }
    const mem = exports.memory;
    if (!mem) throw new Error("candidate exports bs_state_ptr but no memory");
    const dv = new DataView(mem.buffer);
    const p = exports.bs_state_ptr() >>> 0;
    const magic = u32(dv, p);
    if (magic !== STATE_BLOCK_MAGIC) {
        throw new Error(`candidate state block magic 0x${magic.toString(16)} != 0x${STATE_BLOCK_MAGIC.toString(16)}`);
    }
    const regs = {};
    for (let i = 0; i < 8; i++) regs[REG_NAMES[i]] = u32(dv, p + 8 + i * 4);
    const st = [];
    for (let i = 0; i < 8; i++) {
        // Compared as raw bits: an f64 comparison would silently accept -0 vs 0 and NaN
        // payload drift, both of which are real divergences in a relaxed-FPU unit.
        st.push(u32(dv, p + 76 + i * 8), u32(dv, p + 76 + i * 8 + 4));
    }
    return {
        source: "candidate-state-block",
        regs,
        eip: u32(dv, p + 40),
        eflags: u32(dv, p + 44),
        lazy: {
            flags: u32(dv, p + 48), flags_changed: u32(dv, p + 52), last_op1: u32(dv, p + 56),
            last_result: u32(dv, p + 60), last_op_size: u32(dv, p + 64),
        },
        fpu: {
            stack_ptr: u32(dv, p + 68), stack_empty: u32(dv, p + 72),
            control_word: null, status_word: null, simd_dirty: null, st,
        },
        simd: { mxcsr: null, xmm: null },
        instruction_counter: u32(dv, p + 140),
    };
}

/**
 * Ordered list of comparable scalars, flattened. Order matters: the comparator reports the
 * FIRST divergence, and "first" should mean the most diagnostic — architectural registers
 * before derived bookkeeping.
 */
export function flattenState(s) {
    const out = [];
    for (const r of REG_NAMES) out.push([r, s.regs[r]]);
    out.push(["eip", s.eip], ["eflags", s.eflags]);
    for (const [k, v] of Object.entries(s.lazy)) out.push([`lazy.${k}`, v]);
    out.push(["fpu.stack_ptr", s.fpu.stack_ptr], ["fpu.stack_empty", s.fpu.stack_empty],
        ["fpu.control_word", s.fpu.control_word], ["fpu.status_word", s.fpu.status_word],
        ["fpu.simd_dirty", s.fpu.simd_dirty]);
    s.fpu.st.forEach((v, i) => out.push([`fpu.st[${i}]`, v]));
    out.push(["simd.mxcsr", s.simd.mxcsr]);
    if (s.simd.xmm) s.simd.xmm.forEach((v, i) => out.push([`simd.xmm[${i}]`, v]));
    out.push(["instruction_counter", s.instruction_counter]);
    return out;
}
