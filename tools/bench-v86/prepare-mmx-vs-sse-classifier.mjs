// Isolated experiment: stop counting prefixed SSE as MMX when deciding whether an instruction
// mutates fpu_st behind the x87 ST local cache. Shipping source and Wasm stay untouched.
//
// WHY. `opcode_is_mmx` is documented as deliberately conservative: it matches the 0F opcode
// ranges after skipping prefixes, so the 66/F2/F3 SSE forms of the same opcodes match too.
// Those write XMM, which does NOT alias fpu_st, so every one of them emits a spurious
// invalidate-all. Measured in a validated race with jit config 10 on: 89,025,395 invalidations
// in ten seconds, of which only 1,465,606 are x87 opcodes - the other 98.4% come from this
// classifier, and NFS Underground is an SSE-era title.
//
// The narrowing is pure encoding, not heuristics. In 0F60..0F77, 0F7E, 0F7F and 0FD1..0FFE the
// no-prefix form is the MMX one and the 66 form is its XMM counterpart; F3 selects MOVDQU /
// MOVQ / PSHUFHW and F2 selects PSHUFLW, all XMM. The single exception is 0FD6, where F2 is
// MOVDQ2Q (writes MM) and F3 is MOVQ2DQ (reads MM) - both kept as MMX.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-mmxsse-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const FROM = [
    'fn opcode_is_mmx(eip: u32) -> bool {',
    '    let mut addr = eip;',
    '    for _ in 0..4 {',
    '        match read_jit_u8(addr) {',
    '            0x26 | 0x2E | 0x36 | 0x3E | 0x64 | 0x65 | 0x66 | 0x67 | 0xF0 | 0xF2 | 0xF3 => {',
    '                addr = addr.wrapping_add(1);',
    '            },',
    '            0x0F => {',
    '                let op = read_jit_u8(addr.wrapping_add(1));',
    '                return (0x60..=0x77).contains(&op)',
    '                    || op == 0x7E',
    '                    || op == 0x7F',
    '                    || (0xD1..=0xFE).contains(&op);',
    '            },',
    '            _ => return false,',
    '        }',
    '    }',
    '    false',
    '}',
];

const TO = [
    'fn opcode_is_mmx(eip: u32) -> bool {',
    '    let mut addr = eip;',
    '    // Which mandatory prefix was seen. It selects the XMM form of every opcode in the',
    '    // ranges below, so it is what separates MMX from SSE here.',
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
    '                if !in_range {',
    '                    return false;',
    '                }',
    '                // 0FD6 is the one opcode in these ranges whose F2/F3 forms still touch MM:',
    '                // F2 is MOVDQ2Q (writes MM), F3 is MOVQ2DQ (reads MM).',
    '                if op == 0xD6 && (mandatory == 0xF2 || mandatory == 0xF3) {',
    '                    return true;',
    '                }',
    '                // Everything else in range with a mandatory prefix is the XMM form, and XMM',
    '                // does not alias fpu_st.',
    '                return mandatory == 0;',
    '            },',
    '            _ => return false,',
    '        }',
    '    }',
    '    false',
    '}',
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
        const a = FROM.join(NL), b = TO.join(NL);
        if (source.split(a).length !== 2) throw Error('Ambiguous or missing opcode_is_mmx anchor');
        fs.writeFileSync(f, source.replace(a, b));
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
