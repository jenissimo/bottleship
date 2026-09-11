// Isolated experiment: rename the x87 ST-local cache on push/pop instead of dropping it.
// Shipping source and Wasm stay untouched.
//
// WHY. A per-site census of the ST-cache invalidations in a validated race attributes
// 55.5% to gen_fpu_relaxed_pop and 55.4% to gen_fpu_relaxed_push_loaded (they overlap on
// instructions that do both); fxch is 3.7%, fst 4.6%, and the per-instruction raw-helper site
// 1.6%. So the cache is not defeated by foreign instructions, and not by MMX - the guest retires
// zero unprefixed MMX - it is defeated by its own TOP rotation, ~9M times a second, each time
// storing zero into all eight valid locals.
//
// A push or pop changes TOP by a COMPILE-TIME KNOWN amount, so the physical-to-architectural
// slot mapping can be renamed rather than dropped: x87_rot is a compile-time permutation,
// architectural ST(i) lives in physical slot (i + rot) & 7, and a push/pop rotates it and
// invalidates the ONE slot that newly enters the window. Seven of eight values survive.
//
// SOUNDNESS. rot describes a permutation, not TOP itself, so it is meaningless while the cache
// is empty - which is why every site that changes TOP by an unknown amount only has to keep
// doing what it already does, invalidate all. Exactly two emitters write fpu_stack_ptr
// (gen_fpu_relaxed_pop, gen_fpu_relaxed_push_loaded); every other TOP change goes through a
// helper whose site already invalidates. The basic-block prologue resets the permutation AND
// invalidates, because a block reached from elsewhere carries a different compile-time rot.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-x87rot-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const JIT_EDITS = [
    [['    pub x87_cache_kept: bool,'],
     ['    pub x87_cache_kept: bool,',
      '    /// Compile-time permutation of the ST local cache: architectural ST(i) lives in',
      '    /// physical slot (i + x87_rot) & 7. Meaningless while the cache is empty.',
      '    pub x87_rot: u32,']],
    [['        x87_cache_kept: false,'],
     ['        x87_cache_kept: false,',
      '        x87_rot: 0,']],
    [['    ctx.fpu_simd_dirty_marked = false;'],
     ['    ctx.fpu_simd_dirty_marked = false;',
      '    // A block reached from elsewhere carries a different permutation: drop the cache and',
      '    // reset it, once per block instead of once per push/pop.',
      '    codegen::gen_x87_local_cache_invalidate_all_runtime(ctx);',
      '    ctx.x87_rot = 0;']],
];

const CODEGEN_EDITS = [
    [['    let idx = i as usize;'],
     ['    let idx = ((i + ctx.x87_rot) & 7) as usize;']],
    [['pub fn gen_x87_local_cache_free_all(ctx: &mut JitContext) {'],
     ['/// Drop ONE physical slot: the one entering the window on a push or leaving it on a pop.',
      'fn gen_x87_local_cache_invalidate_one(ctx: &mut JitContext, physical: u32) {',
      '    ctx.x87_cache_kept = true;',
      '    let valid = match ctx.x87_local_cache[(physical & 7) as usize].as_ref() {',
      '        Some(slot) => slot.valid.unsafe_clone(),',
      '        None => return,',
      '    };',
      '    crate::jit::x87_locals_note_cache_invalidate_compiled();',
      '    gen_dispatch_stat_increment(ctx.builder, profiler::stat::X87_CACHE_INVALIDATE);',
      '    ctx.builder.const_i32(0);',
      '    ctx.builder.set_local(&valid);',
      '}',
      '',
      'pub fn gen_x87_local_cache_free_all(ctx: &mut JitContext) {']],
    [['    gen_x87_local_cache_invalidate_all_runtime(ctx);',
      '    ctx.builder.load_fixed_u8(global_pointers::fpu_stack_ptr as u32);',
      '    let ptr_local = ctx.builder.set_new_local();'],
     ['    // ST(j) becomes old ST(j+1): rot increases, and the slot that held ST(0) is now ST(7).',
      '    gen_x87_local_cache_invalidate_one(ctx, ctx.x87_rot);',
      '    ctx.x87_rot = (ctx.x87_rot + 1) & 7;',
      '    ctx.builder.load_fixed_u8(global_pointers::fpu_stack_ptr as u32);',
      '    let ptr_local = ctx.builder.set_new_local();']],
    [['    let mantissa = ctx.builder.set_new_local_i64();',
      '    gen_x87_local_cache_invalidate_all_runtime(ctx);'],
     ['    let mantissa = ctx.builder.set_new_local_i64();',
      '    // ST(j+1) becomes old ST(j): rot decreases, and the new ST(0) slot is unknown.',
      '    ctx.x87_rot = (ctx.x87_rot + 7) & 7;',
      '    gen_x87_local_cache_invalidate_one(ctx, ctx.x87_rot);']],
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
