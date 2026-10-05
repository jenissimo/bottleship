// Isolated CENSUS engine: measurement 2 of the perf campaign — how much of the executed guarded
// READ traffic a stack-fastmem mode-1 guard could actually cover, split ESP-only / EBP-provable /
// EBP-unprovable. Shipping source and Wasm stay untouched.
//
// WHY. `plan/perf-campaign/v86-emitter-target-architecture.md` §3 lever 2: guards are 18.9% of
// executed wasm bytes and deleting the whole chain is +10.06% frame (unsound). The one sound shape
// left is a REMOVAL — one guard per translation unit proving a window around ESP, then no check on
// the covered accesses. Its ceiling is (covered share of executed reads) x 10.06%, discounted /3.
//
// The existing ceiling knob (`STACK_RAW_UNSAFE` mode 1, codegen.rs) admits the roadmap-02 class
// `modrm.rs:21-26`: base is ESP **or EBP**, no index, 32-bit addressing. Under MSVC `/Oy` — most
// release game code — EBP is an ordinary general-purpose register and need not point anywhere near
// ESP, so a proof about a window around ESP says NOTHING about an EBP-based access. The knob's
// measured ceiling is therefore an upper bound on an unsound SUPERSET. This census splits it.
//
// WHAT IS COUNTED, at RUNTIME and weighted by execution: every guarded read that reaches
// `gen_modrm_resolve_safe_read{8,16,32,64,128}`, classified by base register, and — for the EBP
// class — by the RUNTIME distance `(EBP + disp) - ESP`. That distance is the whole question: it is
// exactly "would a window around ESP, proven once, have covered this access". It is measured, not
// inferred from a dataflow argument the JIT's single forward pass could not make anyway.
//
// WHAT IS NOT COUNTED, deliberately:
//   - Writes. Lever 2 is reads-only; the raw-memory ablation measured the same ratio with and
//     without write guards, i.e. writes weigh 0. Counting them here would invite quoting a
//     denominator the lever cannot spend.
//   - Non-modrm stack traffic (PUSH/POP/CALL/RET, string ops). That is mode 3's extension, not
//     mode 1's class. `read_total` therefore does NOT claim to be all guest reads — it is all
//     reads through the modrm read emitters, which is the population mode 1 draws from.
//
// The `read_total` slot is redundant with the class slots on purpose: it is written on a separate
// path, so a mismatch against their sum is the instrument saying it is broken rather than
// answering with a plausible number.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-stackclass-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

// The census reads the decoded fields; they are private to modrm.rs in the shipping source.
const MODRM_EDITS = [
    [['pub struct ModrmByte {',
      '    segment: u32,',
      '    first_reg: Option<u32>,',
      '    second_reg: Option<u32>,',
      '    shift: u8,',
      '    immediate: i32,',
      '    is_16: bool,',
      '}'],
     ['pub struct ModrmByte {',
      '    segment: u32,',
      '    pub first_reg: Option<u32>,',
      '    pub second_reg: Option<u32>,',
      '    shift: u8,',
      '    pub immediate: i32,',
      '    pub is_16: bool,',
      '}']],
];

// Lifted verbatim from prepare-emitted-bytes-census.mjs: executed emitted-wasm bytes and retired
// instructions, weighted by execution because the increment runs whenever the instruction runs.
// Carried here so the class census and the mode-0/1/2/3 byte shares come from ONE boot -- a
// predicted ratio and its measurement taken on two different guests is two numbers, not a check.
const JIT_EDITS = [
    [['fn opcode_is_mmx(eip: u32) -> bool {'],
     ['pub static mut EMIT_BYTES: [u64; 2] = [0; 2];',
      '',
      '#[no_mangle]',
      'pub fn emit_bytes_get(i: u32) -> f64 {',
      '    if i >= 2 { return 0.0; }',
      '    unsafe { EMIT_BYTES[i as usize] as f64 }',
      '}',
      '',
      '#[no_mangle]',
      'pub fn emit_bytes_reset() { unsafe { EMIT_BYTES = [0; 2] } }',
      '',
      'fn opcode_is_mmx(eip: u32) -> bool {']],
    [['        let instruction_length = end_eip - start_eip;'],
     ['        if dispatch_stats_enabled() {',
      '            let body = (ctx.builder.instruction_body_length() - wasm_length_before) as i64;',
      '            let bytes_addr = unsafe { &raw mut EMIT_BYTES[0] } as u32;',
      '            let count_addr = unsafe { &raw mut EMIT_BYTES[1] } as u32;',
      '            ctx.builder.increment_fixed_i64(bytes_addr, body);',
      '            ctx.builder.increment_fixed_i64(count_addr, 1);',
      '        }',
      '        let instruction_length = end_eip - start_eip;']],
];

const CODEGEN_EDITS = [
    [['pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     [
      '/// Stack-class census slots. Index names are mirrored in prepare-stack-class-census.mjs;',
      '/// the two lists are compared by the harness before any number is read out.',
      'pub static mut STACK_CLASS: [u64; 32] = [0; 32];',
      '',
      '#[no_mangle]',
      'pub fn stack_class_get(i: u32) -> f64 {',
      '    if i >= 32 { return 0.0; }',
      '    unsafe { STACK_CLASS[i as usize] as f64 }',
      '}',
      '',
      '#[no_mangle]',
      'pub fn stack_class_reset() { unsafe { STACK_CLASS = [0; 32] } }',
      '',
      '/// The class census is on its OWN switch, not on dispatch stats, because the byte census',
      '/// below counts emitted body length -- and the census increments are emitted body. Sharing',
      '/// one gate would make the byte arms measure the instrument.',
      '#[allow(non_upper_case_globals)]',
      'pub static mut STACK_CLASS_ON: u32 = 0;',
      '',
      '#[no_mangle]',
      'pub fn set_stack_class_census(on: u32) { unsafe { STACK_CLASS_ON = on } }',
      '',
      '#[no_mangle]',
      'pub fn get_stack_class_census() -> u32 { unsafe { STACK_CLASS_ON } }',
      '',
      'fn stack_class_inc(ctx: &mut JitContext, slot: usize) {',
      '    let addr = unsafe { &raw mut STACK_CLASS[slot] } as u32;',
      '    ctx.builder.increment_fixed_i64(addr, 1);',
      '}',
      '',
      '/// Emit `if (|d| < half) inc(slot) else <rest>`, where `d` is already in a local.',
      'fn stack_class_band(ctx: &mut JitContext, d: &WasmLocal, half: i32, slot: usize) {',
      '    ctx.builder.get_local(d);',
      '    ctx.builder.const_i32(half);',
      '    ctx.builder.add_i32();',
      '    ctx.builder.const_i32(half.wrapping_mul(2));',
      '    ctx.builder.ltu_i32();',
      '    ctx.builder.if_void();',
      '    stack_class_inc(ctx, slot);',
      '    ctx.builder.else_();',
      '}',
      '',
      '/// Classify one guarded modrm read and count it. Width is in BYTES.',
      'fn gen_stack_class_census(ctx: &mut JitContext, modrm_byte: &ModrmByte, width: i32) {',
      '    if unsafe { STACK_CLASS_ON } == 0 { return; }',
      '    let width_slot = match width { 1 => 0, 2 => 1, 4 => 2, 8 => 3, _ => 4 };',
      '    stack_class_inc(ctx, 20);',
      '    // Ineligible by encoding or by segmentation: a raw access would not be equivalent.',
      '    if !modrm::stack_const_is_flat(ctx, modrm_byte) {',
      '        stack_class_inc(ctx, 17);',
      '        return;',
      '    }',
      '    let base = if modrm_byte.second_reg.is_some() { None } else { modrm_byte.first_reg };',
      '    let disp = modrm_byte.immediate;',
      '    match base {',
      '        Some(regs::ESP) => {',
      '            stack_class_inc(ctx, 0);',
      '            stack_class_inc(ctx, 1 + width_slot);',
      '            if disp < 0 { stack_class_inc(ctx, 18); }',
      '            if disp >= 4096 || disp <= -4096 { stack_class_inc(ctx, 19); }',
      '        },',
      '        Some(regs::EBP) => {',
      '            stack_class_inc(ctx, 6);',
      '            stack_class_inc(ctx, 7 + width_slot);',
      '            // (EBP + disp) - ESP, evaluated where the access happens.',
      '            gen_get_reg32(ctx, regs::EBP);',
      '            ctx.builder.const_i32(disp);',
      '            ctx.builder.add_i32();',
      '            gen_get_reg32(ctx, regs::ESP);',
      '            ctx.builder.sub_i32();',
      '            let d = ctx.builder.set_new_local();',
      '            stack_class_band(ctx, &d, 4096, 12);',
      '            stack_class_band(ctx, &d, 65536, 13);',
      '            stack_class_band(ctx, &d, 1048576, 14);',
      '            stack_class_inc(ctx, 15);',
      '            ctx.builder.block_end();',
      '            ctx.builder.block_end();',
      '            ctx.builder.block_end();',
      '            ctx.builder.free_local(d);',
      '        },',
      '        _ => {',
      '            stack_class_inc(ctx, 16);',
      '            match width_slot { 2 => stack_class_inc(ctx, 21),',
      '                               3 => stack_class_inc(ctx, 22),',
      '                               4 => stack_class_inc(ctx, 23), _ => {} }',
      '        },',
      '    }',
      '}',
      '',
      '/// Non-modrm stack traffic: PUSH/CALL writes, POP/RET reads, LEAVE. These never reach a',
      '/// modrm emitter (gen_push32 -> gen_safe_write32, gen_pop32s_ss32 -> gen_safe_read32 with',
      '/// ESP itself as the address, gen_leave -> safe_read of [EBP]), so the modrm census cannot',
      '/// see them -- but a guard proving a window around ESP covers every one of them.',
      'fn gen_stack_nonmodrm_census(ctx: &mut JitContext, slot: usize) {',
      '    if unsafe { STACK_CLASS_ON } == 0 { return; }',
      '    stack_class_inc(ctx, slot);',
      '}',
      '',
      'pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_stack_class_census(ctx, &modrm_byte, 1);']],
    [['pub fn gen_pop32s_ss32(ctx: &mut JitContext) {'],
     ['pub fn gen_pop32s_ss32(ctx: &mut JitContext) {',
      '    gen_stack_nonmodrm_census(ctx, 24);']],
    [['pub fn gen_pop32s_ss16(ctx: &mut JitContext) {'],
     ['pub fn gen_pop32s_ss16(ctx: &mut JitContext) {',
      '    gen_stack_nonmodrm_census(ctx, 24);']],
    [['pub fn gen_push32(ctx: &mut JitContext, value_local: &WasmLocal) {'],
     ['pub fn gen_push32(ctx: &mut JitContext, value_local: &WasmLocal) {',
      '    gen_stack_nonmodrm_census(ctx, 27);']],
    [['pub fn gen_leave(ctx: &mut JitContext, os32: bool) {'],
     ['pub fn gen_leave(ctx: &mut JitContext, os32: bool) {',
      '    if unsafe { STACK_CLASS_ON } != 0 {',
      '        stack_class_inc(ctx, 25);',
      '        gen_get_reg32(ctx, regs::EBP);',
      '        gen_get_reg32(ctx, regs::ESP);',
      '        ctx.builder.sub_i32();',
      '        let d = ctx.builder.set_new_local();',
      '        stack_class_band(ctx, &d, 65536, 26);',
      '        ctx.builder.block_end();',
      '        ctx.builder.free_local(d);',
      '    }']],
    [['pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_stack_class_census(ctx, &modrm_byte, 2);']],
    [['pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_stack_class_census(ctx, &modrm_byte, 4);']],
    [['pub fn gen_modrm_resolve_safe_read64(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['pub fn gen_modrm_resolve_safe_read64(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_stack_class_census(ctx, &modrm_byte, 8);']],
    [['pub fn gen_modrm_resolve_safe_read128(',
      '    ctx: &mut JitContext,',
      '    modrm_byte: ModrmByte,',
      '    where_to_write: u32,',
      ') {'],
     ['pub fn gen_modrm_resolve_safe_read128(',
      '    ctx: &mut JitContext,',
      '    modrm_byte: ModrmByte,',
      '    where_to_write: u32,',
      ') {',
      '    gen_stack_class_census(ctx, &modrm_byte, 16);']],
];

/** Slot names, in index order. Mirrored by the Rust above; the harness compares the two. */
export const SLOTS = [
    'readEspTotal',
    'readEspW8', 'readEspW16', 'readEspW32', 'readEspW64', 'readEspW128',
    'readEbpTotal',
    'readEbpW8', 'readEbpW16', 'readEbpW32', 'readEbpW64', 'readEbpW128',
    'readEbpNear4k', 'readEbpNear64k', 'readEbpNear1m', 'readEbpFar',
    'readOtherTotal',
    'readIneligible',
    'readEspDispNeg', 'readEspDispGe4k',
    'readTotal',
    'readOtherW32', 'readOtherW64', 'readOtherW128',
    // non-modrm stack traffic; the LEVER's class, which the knob never reaches
    'stackPopRead32', 'stackLeaveRead', 'stackLeaveNear64k', 'stackPushWrite32',
    'reserved28', 'reserved29', 'reserved30', 'reserved31',
];

if (process.argv.includes('--slots')) {
    console.log(JSON.stringify(SLOTS));
    process.exit(0);
}

for (const arm of ['baseline', 'candidate']) {
    const dst = path.join(directory, arm);
    fs.mkdirSync(path.join(dst, 'build'), { recursive: true });
    for (const name of ['src', 'crates', 'tools', '.cargo', 'Cargo.toml', 'Cargo.lock']) {
        fs.cpSync(path.join(vendor, name), path.join(dst, name), { recursive: true });
    }
    for (const name of ['libv86.mjs', 'zstddeclib.o']) {
        fs.copyFileSync(path.join(vendor, 'build', name), path.join(dst, 'build', name));
    }
    if (arm === 'candidate') {
        const apply = (file, edits) => {
            const f = path.join(dst, file);
            let source = fs.readFileSync(f, 'utf8');
            for (const [from, to] of edits) {
                const a = from.join(NL), b = to.join(NL);
                if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + from[0].trim());
                source = source.replace(a, b);
            }
            fs.writeFileSync(f, source);
        };
        apply('src/rust/modrm.rs', MODRM_EDITS);
        apply('src/rust/codegen.rs', CODEGEN_EDITS);
        apply('src/rust/jit.rs', JIT_EDITS);
    }
    const r = spawnSync('cargo', ['rustc', '--release', '--target', 'wasm32-unknown-unknown', '--',
        '-C', 'linker=tools/rust-lld-wrapper.cmd',
        '-C', 'link-args=--import-table --global-base=4096',
        '-C', 'link-args=build/zstddeclib.o',
        '-C', 'target-feature=+bulk-memory', '-C', 'target-feature=+multivalue',
        '-C', 'target-feature=+simd128'],
        { cwd: dst, encoding: 'utf8', maxBuffer: 16 << 20 });
    fs.writeFileSync(path.join(dst, 'build.log'), (r.stdout ?? '') + (r.stderr ?? ''));
    if (r.status !== 0) throw Error(r.error ?? r.stderr?.slice(-3000));
    const wasm = path.join(dst, 'build/wasm32-unknown-unknown/release/v86.wasm');
    manifest.arms[arm] = { wasm, hash: hash(wasm), bytes: fs.statSync(wasm).size };
    const engines = path.resolve('public/apps/source-pair-lab/engines');
    fs.mkdirSync(engines, { recursive: true });
    fs.copyFileSync(wasm, path.join(engines, `${manifest.arms[arm].hash}.wasm`));
    manifest.slots = SLOTS;
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ arm, ...manifest.arms[arm] }));
}
console.log(JSON.stringify({
    manifest: path.join(directory, 'manifest.json'),
    baselineMatchesShipping: manifest.arms.baseline.hash === manifest.shippingHash,
}));
