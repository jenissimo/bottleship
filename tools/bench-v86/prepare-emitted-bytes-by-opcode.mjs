// Isolated CENSUS engine: executed emitted-wasm bytes BY x86 OPCODE. Shipping source untouched.
//
// WHY. The Stage-0 census fixed the target in bytes: 88.92 wasm bytes per retired x86
// instruction, of which memory guards are 18.9% and the lazy-EFLAGS tuple 2.1%, so the +15% goal
// (~28% of executed bytes, at the measured rate of 1% bytes = 0.53% FPS) has to come out of the
// remaining 79% - the shape of the translation itself. "Improve the translation" is not a task
// until it names instructions, and nothing in the tree can name them: opstats records compiled
// size per opcode, not size weighted by how often that opcode actually runs.
//
// This indexes the same execution-weighted byte counter by primary opcode (0F-escaped forms fold
// into slot 0x100+op), so the readout is a ranked list of which x86 instruction forms produce the
// bytes the guest executes. That list is the work order for any codegen or AOT effort.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-bytesop-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const JIT_EDITS = [
    [['fn opcode_is_mmx(eip: u32) -> bool {'],
     ['/// Executed emitted-wasm bytes per primary opcode (0F-escaped at 0x100 + op), plus the',
      '/// execution count in the parallel half. Armed with dispatch stats.',
      'pub static mut BYTES_BY_OP: [u64; 512] = [0; 512];',
      'pub static mut COUNT_BY_OP: [u64; 512] = [0; 512];',
      '',
      '#[no_mangle]',
      'pub fn bytes_by_op_get(i: u32) -> f64 {',
      '    if i >= 512 { return 0.0; }',
      '    unsafe { BYTES_BY_OP[i as usize] as f64 }',
      '}',
      '',
      '#[no_mangle]',
      'pub fn count_by_op_get(i: u32) -> f64 {',
      '    if i >= 512 { return 0.0; }',
      '    unsafe { COUNT_BY_OP[i as usize] as f64 }',
      '}',
      '',
      '#[no_mangle]',
      'pub fn bytes_by_op_reset() { unsafe { BYTES_BY_OP = [0; 512]; COUNT_BY_OP = [0; 512]; } }',
      '',
      '/// The census slot for the instruction at `eip`: primary opcode, or 0x100 + second byte',
      '/// for the 0F escape, after prefixes.',
      'fn bytes_by_op_slot(eip: u32) -> usize {',
      '    let (opcode, _) = decode_jit_opcode(eip);',
      '    (opcode as usize) & 0x1FF',
      '}',
      '',
      'fn opcode_is_mmx(eip: u32) -> bool {']],
    // Emitted after the instruction body, so the length is the instruction's own and the
    // counter's own bytes are not part of what it reports.
    [['        let instruction_length = end_eip - start_eip;'],
     ['        if dispatch_stats_enabled() {',
      '            let body = (ctx.builder.instruction_body_length() - wasm_length_before) as i64;',
      '            let slot = bytes_by_op_slot(start_eip);',
      '            let bytes_addr = unsafe { &raw mut BYTES_BY_OP[slot] } as u32;',
      '            let count_addr = unsafe { &raw mut COUNT_BY_OP[slot] } as u32;',
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
