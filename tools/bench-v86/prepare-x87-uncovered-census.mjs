// Isolated CENSUS engine: name the x87 opcodes that the relaxed fast path does NOT cover.
// Shipping source and Wasm stay untouched.
//
// WHY. With jit config 10 (x87 ST locals) on, a race measures 40.2M cache hits against
// **92.0M invalidations** - 2.29 invalidations per hit. The invalidation site is already
// narrowed to x87/MMX instructions whose relaxed wrapper did not keep the cache coherent, so
// every one of those 92M is an x87 instruction taking the RAW helper path. Which opcodes they
// are decides whether closing the gap is a bounded job or an open-ended one, and no existing
// counter can say: X87_CACHE_INVALIDATE is one scalar for all of them.
//
// This build replaces that scalar with a 128-slot histogram keyed by (opcode 0xD8..0xDF,
// modrm /reg, memory-vs-register form), incremented on the same edge and under the same
// dispatch-stats gate. Off by default, so the arm is byte-identical to shipping until armed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-x87census-'));
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
        const f = path.join(dst, 'src/rust/jit.rs');
        let source = fs.readFileSync(f, 'utf8');
        const replace = (a, b) => {
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + a.slice(0, 70));
            source = source.replace(a, b);
        };

        // 1. The histogram and its readout, next to the opcode helper that names the edge.
        replace(
            'fn opcode_is_x87(eip: u32) -> bool {',
            `/// Per-opcode census of x87 instructions that fall off the relaxed fast path.
/// Slot = (opcode - 0xD8) * 16 + (modrm /reg) * 2 + (register form ? 1 : 0).
pub static mut X87_UNCOVERED: [u64; 128] = [0; 128];

#[no_mangle]
pub fn x87_uncovered_get(slot: u32) -> f64 {
    if slot >= 128 { return 0.0; }
    unsafe { X87_UNCOVERED[slot as usize] as f64 }
}

#[no_mangle]
pub fn x87_uncovered_reset() { unsafe { X87_UNCOVERED = [0; 128] } }

/// The census slot for the x87 instruction at \`eip\`, or None when it is not one (an MMX op
/// reaches the same invalidation edge and has no 0xD8..0xDF opcode to key on).
fn x87_uncovered_slot(eip: u32) -> Option<usize> {
    let (opcode, operand_addr) = decode_jit_opcode(eip);
    if !(0xD8..=0xDF).contains(&opcode) { return None; }
    let modrm = read_jit_u8(operand_addr);
    let reg_form = modrm & 0xC0 == 0xC0;
    Some(((opcode as usize - 0xD8) << 4) | (((modrm >> 3) & 7) as usize) << 1 | reg_form as usize)
}

fn opcode_is_x87(eip: u32) -> bool {`,
        );

        // 2. Count on the same edge, under the same gate, alongside the existing scalar.
        replace(
            `        if !ctx.x87_cache_kept
            && ctx.x87_local_cache.iter().any(|s| s.is_some())
            && (opcode_is_x87(start_eip) || opcode_is_mmx(start_eip))
        {
            codegen::gen_x87_local_cache_invalidate_all_runtime(ctx);
        }`,
            `        if !ctx.x87_cache_kept
            && ctx.x87_local_cache.iter().any(|s| s.is_some())
            && (opcode_is_x87(start_eip) || opcode_is_mmx(start_eip))
        {
            if dispatch_stats_enabled() {
                if let Some(slot) = x87_uncovered_slot(start_eip) {
                    let addr = unsafe { &raw mut X87_UNCOVERED[slot] } as u32;
                    ctx.builder.increment_fixed_i64(addr, 1);
                }
            }
            codegen::gen_x87_local_cache_invalidate_all_runtime(ctx);
        }`,
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
