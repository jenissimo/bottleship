// Isolated experiment: drop the dead zero-initialiser of the TLB entry local on every guarded
// guest READ. Shipping source and Wasm stay untouched.
//
// WHY. gen_safe_read opens with `i32.const 0; local.set entry` before the guard chain, and then
// every path through that chain writes the same local with `local.tee` before anything reads it:
// the TLB-hit path tees the loaded entry, the slow path tees the helper's return, and the
// read-cache path (off by default) assigns it from the cached entry. The initialiser is therefore
// dead on every path - four bytes and two executed operations on EVERY guarded read.
//
// It is also the odd one out: every other guarded path in codegen.rs (gen_safe_write, the
// read-modify-write forms, the fastmem write map) creates its entry local with `tee_new_local`
// and emits no initialiser at all. Only the read path pays this.
//
// The per-unit read-cache locals (page/entry/valid) keep their initialisers: those ARE read
// before being written when a probe branches past the chain, and a recycled local left non-zero
// would make the next read take the cache path with a stale page.
//
// Executed-byte context: guarded reads are the single largest byte category in a race
// (`MOV r,rm` alone is 15.5% of executed emitted bytes at 67.2 bytes per instruction), so the
// question this arm answers is whether V8's optimising tier already eliminates the dead store.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-deadinit-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

const BUILDER_EDITS = [
    [['    #[must_use = "local allocated but not used"]',
      '    fn alloc_local(&mut self) -> WasmLocal {'],
     ['    #[must_use = "local allocated but not used"]',
      '    pub fn alloc_local(&mut self) -> WasmLocal {']],
];

const CODEGEN_EDITS = [
    [['    ctx.builder.const_i32(0);',
      '    let entry_local = ctx.builder.set_new_local();'],
     ['    // No initialiser: every path below writes this local with local.tee before anything',
      '    // reads it, so the store was dead. Every other guarded path already does it this way.',
      '    let entry_local = ctx.builder.alloc_local();']],
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
        apply('src/rust/wasmgen/wasm_builder.rs', BUILDER_EDITS);
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
