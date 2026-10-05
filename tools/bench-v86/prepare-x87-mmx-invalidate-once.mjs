// Isolated experiment: stop re-emitting the x87 ST-cache invalidation for every MMX
// instruction in a run. Shipping source and Wasm stay untouched.
//
// WHY. With jit config 10 (x87 ST locals) on, a validated race window shows 89,025,395 cache
// invalidations in ten seconds, of which only 1,465,606 come from x87 opcodes - 98.4% are MMX.
// MMX aliases fpu_st storage, so the invalidation is required; what is NOT required is emitting
// it again for the next MMX instruction when every slot is already known to be zero. Each
// emission is eight local stores, so a run of MMX instructions pays eight stores per instruction
// to zero locals that are already zero.
//
// SUPPRESSION is safe at any nesting depth: if every slot is provably zero on every path
// reaching a site, skipping the stores changes nothing. GRANTING the flag is not - several
// invalidation call sites in codegen.rs sit inside the relaxed fallback's `if_void` and run only
// on the slow path, so a grant there would let a later suppression skip an invalidation the fast
// path never performed. The grant therefore lives at the single top-level site in jit.rs, which
// is emitted after jit_instruction returns (every block the instruction opened is closed) and so
// runs on every path to the next instruction. The flag is reset at each basic-block prologue, so
// a jump into the middle of a block cannot inherit a suppression its own path did not execute.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-x87mmx-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const JIT_EDITS = [
    [
        ['    pub x87_cache_kept: bool,'],
        ['    pub x87_cache_kept: bool,',
         '    /// Every allocated ST slot is known to be zero on every path reaching here, so a',
         '    /// further invalidate-all would store zero over zero.',
         '    pub x87_cache_all_invalid: bool,'],
    ],
    [
        ['        x87_cache_kept: false,'],
        ['        x87_cache_kept: false,',
         '        x87_cache_all_invalid: true,'],
    ],
    [
        ['    ctx.fpu_simd_dirty_marked = false;'],
        ['    ctx.fpu_simd_dirty_marked = false;',
         '    // A block can be entered from elsewhere: never carry a suppression across its top.',
         '    ctx.x87_cache_all_invalid = false;'],
    ],
    [
        ['            codegen::gen_x87_local_cache_invalidate_all_runtime(ctx);',
         '        }'],
        ['            codegen::gen_x87_local_cache_invalidate_all_runtime(ctx);',
         '            // The ONLY grant: this store runs on every path to the next instruction.',
         '            ctx.x87_cache_all_invalid = true;',
         '        }'],
    ],
];

const CODEGEN_EDITS = [
    [
        ['    // This wrapper keeps the st-cache coherent for this instruction.',
         '    ctx.x87_cache_kept = true;'],
        ['    // This wrapper keeps the st-cache coherent for this instruction.',
         '    ctx.x87_cache_kept = true;',
         '    // Obtaining a slot means a fill may set its valid bit on some path.',
         '    ctx.x87_cache_all_invalid = false;'],
    ],
    [
        ['    if valids.is_empty() {', '        return;', '    }'],
        ['    if valids.is_empty() {', '        return;', '    }',
         '    // Already zero on every path that reaches here - emitting it again stores zero over',
         '    // zero, once per MMX instruction in a run. Safe at any nesting; see the grant site.',
         '    if ctx.x87_cache_all_invalid {', '        return;', '    }'],
    ],
];

const applyEdits = (file, edits) => {
    let source = fs.readFileSync(file, 'utf8');
    for (const [from, to] of edits) {
        const a = from.join(NL), b = to.join(NL);
        if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + from[0]);
        source = source.replace(a, b);
    }
    fs.writeFileSync(file, source);
};

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
        applyEdits(path.join(dst, 'src/rust/jit.rs'), JIT_EDITS);
        applyEdits(path.join(dst, 'src/rust/codegen.rs'), CODEGEN_EDITS);
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
