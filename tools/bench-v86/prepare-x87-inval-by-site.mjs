// Isolated CENSUS engine: which emission site actually produces the x87 ST-cache invalidations.
// Shipping source and Wasm stay untouched.
//
// WHY. X87_CACHE_INVALIDATE is ONE scalar shared by ~17 call sites in codegen.rs plus the
// per-instruction site in jit.rs. Counting only the jit.rs site (1.47M of 89M) and attributing
// the remainder to MMX was WRONG - a separate census found the guest retires zero unprefixed MMX
// instructions. The rest must come from codegen.rs, and the three suspects rotate TOP:
// gen_fpu_relaxed_pop, gen_fpu_relaxed_push_loaded and gen_fpu_relaxed_fxch each invalidate all
// eight slots unconditionally, and x87 code pushes and pops on nearly every instruction.
//
// If that is where they come from, the fix is not invalidation at all: a push/pop changes TOP by
// a COMPILE-TIME KNOWN amount, so the slot mapping can be renamed instead of dropped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-invalsite-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

// site 0 = pop, 1 = push_loaded, 2 = fxch, 3 = fst
const COUNTER = [
    '/// Per-site census of x87 ST-cache invalidations. Slot 0 pop, 1 push, 2 fxch, 3 fst.',
    'pub static mut X87_INVAL_SITE: [u64; 8] = [0; 8];',
    '',
    '#[no_mangle]',
    'pub fn x87_inval_site_get(i: u32) -> f64 {',
    '    if i >= 8 { return 0.0; }',
    '    unsafe { X87_INVAL_SITE[i as usize] as f64 }',
    '}',
    '',
    '#[no_mangle]',
    'pub fn x87_inval_site_reset() { unsafe { X87_INVAL_SITE = [0; 8] } }',
    '',
    'fn gen_x87_inval_site(ctx: &mut JitContext, site: usize) {',
    '    if !crate::jit::dispatch_stats_enabled() { return; }',
    '    let addr = unsafe { &raw mut X87_INVAL_SITE[site] } as u32;',
    '    ctx.builder.increment_fixed_i64(addr, 1);',
    '}',
    '',
    'pub fn gen_x87_local_cache_invalidate_all_runtime(ctx: &mut JitContext) {',
];

const SITES = [
    [['pub fn gen_fpu_relaxed_pop(ctx: &mut JitContext) {',
      '    gen_mark_fpu_simd_dirty_once(ctx);',
      '    if !crate::softfloat::is_fpu_relaxed() {',
      '        ctx.builder.call_fn0("fpu_pop");',
      '        return;',
      '    }',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);'],
     ['pub fn gen_fpu_relaxed_pop(ctx: &mut JitContext) {',
      '    gen_mark_fpu_simd_dirty_once(ctx);',
      '    if !crate::softfloat::is_fpu_relaxed() {',
      '        ctx.builder.call_fn0("fpu_pop");',
      '        return;',
      '    }',
      '    gen_x87_inval_site(ctx, 0);',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);']],
    [['    let mantissa = ctx.builder.set_new_local_i64();',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);'],
     ['    let mantissa = ctx.builder.set_new_local_i64();',
      '    gen_x87_inval_site(ctx, 1);',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);']],
    [['        ctx.builder.call_fn1("fpu_fxch");',
      '        return;',
      '    }',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);'],
     ['        ctx.builder.call_fn1("fpu_fxch");',
      '        return;',
      '    }',
      '    gen_x87_inval_site(ctx, 2);',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);']],
    [['    gen_fpu_clear_stack_empty_sti(ctx, i);',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);'],
     ['    gen_fpu_clear_stack_empty_sti(ctx, i);',
      '    gen_x87_inval_site(ctx, 3);',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);']],
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
        const f = path.join(dst, 'src/rust/codegen.rs');
        let source = fs.readFileSync(f, 'utf8');
        const apply = (from, to) => {
            const a = from.join(NL), b = to.join(NL);
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + from[0].trim());
            source = source.replace(a, b);
        };
        apply(['pub fn gen_x87_local_cache_invalidate_all_runtime(ctx: &mut JitContext) {'], COUNTER);
        for (const [from, to] of SITES) apply(from, to);
        fs.writeFileSync(f, source);
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
