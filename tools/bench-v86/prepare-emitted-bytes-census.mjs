// Isolated CENSUS engine: how many bytes of emitted wasm the guest actually EXECUTES per second,
// and what share of them each removable category contributes. Shipping source and Wasm untouched.
//
// WHY. Stage 0 of the x2 strategy names this instrument as the precondition for any further
// codegen work, and it was never built: without it the guest bucket (33.6% of busy) cannot be
// decomposed, and every codegen lever is a guess about where its bytes go. This session removed
// millions of operations a second - 56% of dispatcher re-entries, 85% of D3D9 stage resolutions,
// 285k allocations - for half a percent each, which is exactly the symptom of a profile whose
// remaining mass is payload rather than overhead. This measures that directly.
//
// The counter is emitted AFTER each instruction, once its body length is known, and adds that
// length. Its own bytes are excluded (the length is read before it is emitted). Weighted by
// execution by construction: the increment runs whenever the instruction runs.
//
// The decomposition then needs no further build: both big categories are RUNTIME switches on the
// same boot - set_stack_raw_unsafe(3) removes the inline TLB guard chain from flat reads, and
// jit_no_flag_tuple_set(1) removes the lazy-EFLAGS tuple stores. Executed-bytes per second with
// each one armed, minus the baseline, is that category's byte share.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-emitbytes-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const JIT_EDITS = [
    [['fn opcode_is_mmx(eip: u32) -> bool {'],
     ['/// Executed emitted-wasm bytes (slot 0) and retired instructions (slot 1). Armed with',
      '/// dispatch stats; nothing is emitted otherwise.',
      'pub static mut EMIT_BYTES: [u64; 2] = [0; 2];',
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
    // Emitted after the instruction body, so `wasm_length` is this instruction's own size and
    // the counter's bytes are not part of what it reports.
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
        const f = path.join(dst, 'src/rust/jit.rs');
        let source = fs.readFileSync(f, 'utf8');
        for (const [from, to] of JIT_EDITS) {
            const a = from.join(NL), b = to.join(NL);
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + from[0].trim());
            source = source.replace(a, b);
        }
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
