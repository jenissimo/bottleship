// Isolated ABLATION build: a runtime switch that makes the lazy-EFLAGS tuple stores emit
// NOTHING. Shipping source and Wasm stay untouched.
//
// This is not a candidate — it is deliberately WRONG (anything that reads flags after the
// producing block sees stale state). It exists to bound the flags lever before the real work:
// `cgk3.wat` writes the tuple 67 times per 64 x86 instructions, more than the memory guards and
// the register spills combined, and the shipped flag-locals switch (jit config 21) measured
// 0.9955 in a race — i.e. the SHIPPED implementation buys nothing, which says nothing about the
// ceiling. The ablation says what a perfect implementation could be worth.
//
// The stack stays balanced because every ablated emitter both pushes and consumes within itself.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-flagtuple-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

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
        const replace = (a, b) => {
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + a.slice(0, 70));
            source = source.replace(a, b);
        };
        replace(
            'pub const FLAG_LOCAL_LAST_OP1: usize = 0;',
            `/// ABLATION ONLY: skip every lazy-EFLAGS tuple store. Diagnostic, never a shipping path.
static mut JIT_NO_FLAG_TUPLE: bool = false;
#[no_mangle]
pub unsafe fn jit_no_flag_tuple_set(on: u32) { JIT_NO_FLAG_TUPLE = on != 0; }
#[no_mangle]
pub unsafe fn jit_no_flag_tuple_get() -> u32 { JIT_NO_FLAG_TUPLE as u32 }
#[inline(always)]
fn no_flag_tuple() -> bool { unsafe { JIT_NO_FLAG_TUPLE } }

pub const FLAG_LOCAL_LAST_OP1: usize = 0;`,
        );
        for (const fn of [
            'pub fn gen_set_last_op1(builder: &mut WasmBuilder, source: &WasmLocal) {',
            'pub fn gen_set_last_result(builder: &mut WasmBuilder, source: &WasmLocal) {',
            'pub fn gen_clear_flags_changed_bits(builder: &mut WasmBuilder, bits_to_clear: i32) {',
        ]) replace(fn, fn + '\n    if no_flag_tuple() { return; }');
        replace(
            '    dbg_assert!(last_op_size == OPSIZE_8 || last_op_size == OPSIZE_16 || last_op_size == OPSIZE_32);',
            '    dbg_assert!(last_op_size == OPSIZE_8 || last_op_size == OPSIZE_16 || last_op_size == OPSIZE_32);\n    if no_flag_tuple() { return; }',
        );
        replace(
            'pub fn gen_set_flags_bits(builder: &mut WasmBuilder, bits_to_set: i32) {',
            'pub fn gen_set_flags_bits(builder: &mut WasmBuilder, bits_to_set: i32) {\n    if no_flag_tuple() { return; }',
        );
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
