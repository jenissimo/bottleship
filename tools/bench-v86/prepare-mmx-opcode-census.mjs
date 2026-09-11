// Isolated CENSUS engine: how many true MMX instructions the guest executes, and which.
// Shipping source and Wasm stay untouched.
//
// WHY. Every MMX instruction is emitted as ONE HELPER CALL (mmx_read64_mm_* in
// jit_instructions.rs) into an interpreter routine, while SSE has inline v128 codegen. The x87
// work showed ~9M MMX instructions a second in x87-carrying modules alone; sizing an inline-SIMD
// lever needs the total across ALL modules and the opcode distribution, because the lever is
// per-opcode work and its ceiling is (executions) x (helper call - inline v128).
//
// The census sits in the per-instruction emission loop, keyed by the 0F opcode byte, and uses
// the STRICT classifier (a mandatory 66/F2/F3 prefix selects the XMM form, which is not MMX).
// Gated by dispatch stats, so it is byte-identical to shipping until armed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-mmxcensus-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const HELPERS = [
    '/// Per-opcode census of TRUE MMX instructions (no mandatory prefix), indexed by the byte',
    '/// after 0F. Armed with dispatch stats; nothing is emitted otherwise.',
    'pub static mut MMX_CENSUS: [u64; 256] = [0; 256];',
    '',
    '#[no_mangle]',
    'pub fn mmx_census_get(op: u32) -> f64 {',
    '    if op >= 256 { return 0.0; }',
    '    unsafe { MMX_CENSUS[op as usize] as f64 }',
    '}',
    '',
    '#[no_mangle]',
    'pub fn mmx_census_reset() { unsafe { MMX_CENSUS = [0; 256] } }',
    '',
    '/// The 0F opcode byte when the instruction at `eip` is a true MMX op, else None.',
    'fn mmx_census_opcode(eip: u32) -> Option<u8> {',
    '    let mut addr = eip;',
    '    let mut mandatory: u8 = 0;',
    '    for _ in 0..4 {',
    '        match read_jit_u8(addr) {',
    '            0x66 | 0xF2 | 0xF3 => {',
    '                mandatory = read_jit_u8(addr);',
    '                addr = addr.wrapping_add(1);',
    '            },',
    '            0x26 | 0x2E | 0x36 | 0x3E | 0x64 | 0x65 | 0x67 | 0xF0 => {',
    '                addr = addr.wrapping_add(1);',
    '            },',
    '            0x0F => {',
    '                let op = read_jit_u8(addr.wrapping_add(1));',
    '                let in_range = (0x60..=0x77).contains(&op)',
    '                    || op == 0x7E',
    '                    || op == 0x7F',
    '                    || (0xD1..=0xFE).contains(&op);',
    '                if !in_range { return None; }',
    '                if op == 0xD6 && (mandatory == 0xF2 || mandatory == 0xF3) { return Some(op); }',
    '                return if mandatory == 0 { Some(op) } else { None };',
    '            },',
    '            _ => return None,',
    '        }',
    '    }',
    '    None',
    '}',
    '',
    'fn opcode_is_mmx(eip: u32) -> bool {',
];

const FROM_LOOP = [
    '        ctx.start_of_current_instruction = ctx.cpu.eip;',
    '        let start_eip = ctx.cpu.eip;',
];
const TO_LOOP = [
    '        ctx.start_of_current_instruction = ctx.cpu.eip;',
    '        let start_eip = ctx.cpu.eip;',
    '        if dispatch_stats_enabled() {',
    '            if let Some(op) = mmx_census_opcode(start_eip) {',
    '                let addr = unsafe { &raw mut MMX_CENSUS[op as usize] } as u32;',
    '                ctx.builder.increment_fixed_i64(addr, 1);',
    '            }',
    '        }',
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
        const apply = (from, to) => {
            const a = from.join(NL), b = to.join(NL);
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + from[0]);
            source = source.replace(a, b);
        };
        apply(['fn opcode_is_mmx(eip: u32) -> bool {'], HELPERS);
        apply(FROM_LOOP, TO_LOOP);
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
