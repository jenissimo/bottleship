// Isolated CENSUS engine: how many guest memory reads could share ONE widened guard.
// Shipping source and Wasm stay untouched.
//
// WHY. Three independent in-game measurements say the inline TLB guard can only be made cheaper
// by DELETING the sequence, never by swapping it for another check: read micro-TLB 0.902,
// perm-map probe 0.9626 at a 100.00% hit rate, raw reads (chain deleted) 1.1006. The only
// surviving correct shape is amortization - one guard covering a group of accesses, with the
// covered ones emitting no check. Its ceiling is bounded by the raw-read number, +10.06%, and
// its realisable part is (coverage) x (share of the chain a covered access still pays).
//
// Coverage is the missing number. This build counts, at RUNTIME and weighted by execution, every
// flat 32/16/8-bit read that is a NON-ANCHOR member of a group: same base register as the
// previous read, no index, displacement forward of the anchor and inside a 64-byte window (so the
// anchor's existing page-crossing test, widened by a constant, already proves the whole window is
// on one page). Groups break at every instruction that performs no such read and at every basic
// block.
//
// This is an UPPER bound: an intervening write to the base register is not detected here (that
// needs a def analysis analysis.rs does not have - it calls modrm::skip). If even the upper bound
// is small, the lever is closed without building it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-guardgroup-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const JIT_EDITS = [
    [['    pub x87_cache_kept: bool,'],
     ['    pub x87_cache_kept: bool,',
      '    /// Guard-group census: the base register and displacement of the previous flat read in',
      '    /// this basic block, or -1 when no group is open.',
      '    pub guard_prev_base: i32,',
      '    pub guard_prev_disp: i32,',
      '    /// Set by a read emitter when this instruction performed a flat read.',
      '    pub guard_touched: bool,']],
    [['        x87_cache_kept: false,'],
     ['        x87_cache_kept: false,',
      '        guard_prev_base: -1,',
      '        guard_prev_disp: 0,',
      '        guard_touched: false,']],
    [['    ctx.fpu_simd_dirty_marked = false;'],
     ['    ctx.fpu_simd_dirty_marked = false;',
      '    // A block reached from elsewhere cannot inherit an open group.',
      '    ctx.guard_prev_base = -1;']],
    [['        ctx.x87_cache_kept = false;'],
     ['        ctx.x87_cache_kept = false;',
      '        ctx.guard_touched = false;']],
    // Any instruction that performed no qualifying read closes the group.
    [['        let instruction_length = end_eip - start_eip;'],
     ['        if !ctx.guard_touched {',
      '            ctx.guard_prev_base = -1;',
      '        }',
      '        let instruction_length = end_eip - start_eip;']],
];

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

const CODEGEN_EDITS = [
    [['pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['/// Guard-group census. Slot 0 = anchors (a read that must carry its own guard), slot 1 =',
      '/// members covered by the anchor within a 64-byte forward window.',
      'pub static mut GUARD_GROUP: [u64; 2] = [0; 2];',
      '',
      '#[no_mangle]',
      'pub fn guard_group_get(i: u32) -> f64 {',
      '    if i >= 2 { return 0.0; }',
      '    unsafe { GUARD_GROUP[i as usize] as f64 }',
      '}',
      '',
      '#[no_mangle]',
      'pub fn guard_group_reset() { unsafe { GUARD_GROUP = [0; 2] } }',
      '',
      '/// Classify this read against the open group and count it. Emits one counter increment.',
      'fn gen_guard_group_census(ctx: &mut JitContext, modrm_byte: &ModrmByte, width: i32) {',
      '    if !crate::jit::dispatch_stats_enabled() { return; }',
      '    if modrm_byte.is_16 || modrm_byte.second_reg.is_some() { return; }',
      '    let base = match modrm_byte.first_reg { Some(r) => r as i32, None => return };',
      '    if !modrm::stack_const_is_flat(ctx, modrm_byte) { return; }',
      '    let disp = modrm_byte.immediate;',
      '    let covered = ctx.guard_prev_base == base',
      '        && disp >= ctx.guard_prev_disp',
      '        && disp - ctx.guard_prev_disp + width <= 64;',
      '    let slot = if covered { 1 } else { 0 };',
      '    let addr = unsafe { &raw mut GUARD_GROUP[slot] } as u32;',
      '    ctx.builder.increment_fixed_i64(addr, 1);',
      '    ctx.guard_touched = true;',
      '    if !covered {',
      '        ctx.guard_prev_base = base;',
      '        ctx.guard_prev_disp = disp;',
      '    }',
      '}',
      '',
      'pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_guard_group_census(ctx, &modrm_byte, 1);']],
    [['pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_guard_group_census(ctx, &modrm_byte, 2);']],
    [['pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: ModrmByte) {'],
     ['pub fn gen_modrm_resolve_safe_read32(ctx: &mut JitContext, modrm_byte: ModrmByte) {',
      '    gen_guard_group_census(ctx, &modrm_byte, 4);']],
];

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
        apply('src/rust/jit.rs', JIT_EDITS);
        apply('src/rust/codegen.rs', CODEGEN_EDITS);
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
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ arm, ...manifest.arms[arm] }));
}
console.log(JSON.stringify({
    manifest: path.join(directory, 'manifest.json'),
    baselineMatchesShipping: manifest.arms.baseline.hash === manifest.shippingHash,
}));
