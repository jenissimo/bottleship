import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const vendor = path.join(root, 'vendor/v86');
// --page-cap-one is a separate alternative arm, never combined with memory inlining.
const pageCapOne = process.argv.includes('--page-cap-one');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), pageCapOne ? 'v86-page-cap-one-' : 'v86-memory-inline-'));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const baseline = '3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a';
const manifest = { directory, created: new Date().toISOString(), baseline,
    hypothesis: pageCapOne ? 'Compile at most one physical page per baseline JIT module; preserve existing cross-module exits/chaining.' :
        'Inline read32s and safe_write32 into runtime callers; retain all bodies, checks and exports unchanged.',
    rejection: 'Reject without positive fixed-work and phase-gated game signal; inspect code-size regression.', arms: {} };
for (const arm of ['baseline', 'candidate']) {
    const dst = path.join(directory, arm);
    fs.mkdirSync(path.join(dst, 'build'), { recursive: true });
    for (const name of ['src', 'crates', 'tools', '.cargo', 'Cargo.toml', 'Cargo.lock']) {
        fs.cpSync(path.join(vendor, name), path.join(dst, name), { recursive: true });
    }
    for (const name of ['v86.wasm', 'libv86.mjs', 'zstddeclib.o']) {
        fs.copyFileSync(path.join(vendor, 'build', name), path.join(dst, 'build', name));
    }
    if (arm === 'candidate') {
        if (pageCapOne) {
            const file = path.join(dst, 'src/rust/jit.rs');
            const text = fs.readFileSync(file, 'utf8');
            const original = 'static mut MAX_PAGES: u32 = 3;';
            if (text.split(original).length !== 2) throw Error('Unexpected MAX_PAGES source');
            fs.writeFileSync(file, text.replace(original, 'static mut MAX_PAGES: u32 = 1;'));
        } else {
        for (const [name, signature] of [['memory.rs', 'pub fn read32s(addr: u32) -> i32 {'],
            ['cpu.rs', 'pub unsafe fn safe_write32(addr: i32, value: i32) -> OrPageFault<()> {']]) {
            const file = path.join(dst, 'src/rust/cpu', name);
            const text = fs.readFileSync(file, 'utf8');
            if (text.split(signature).length !== 2) throw Error(`Unexpected source: ${name}`);
            fs.writeFileSync(file, text.replace(signature, `#[inline(always)]\n${signature}`));
        }
        }
    }
    console.log(`BUILD ${arm}: ${dst}`);
    const p = spawnSync('cargo', ['rustc', '--release', '--target', 'wasm32-unknown-unknown', '--',
        '-C', 'linker=tools/rust-lld-wrapper.cmd', '-C', 'link-args=--import-table --global-base=4096',
        '-C', 'link-args=build/zstddeclib.o', '-C', 'target-feature=+bulk-memory',
        '-C', 'target-feature=+multivalue', '-C', 'target-feature=+simd128'],
    { cwd: dst, encoding: 'utf8', maxBuffer: 8 << 20 });
    fs.writeFileSync(path.join(dst, 'build.log'), p.stdout + p.stderr);
    if (p.status !== 0) throw Error(p.stderr.slice(-4000));
    const wasm = path.join(dst, 'build/v86.wasm');
    fs.copyFileSync(path.join(dst, 'build/wasm32-unknown-unknown/release/v86.wasm'), wasm);
    manifest.arms[arm] = { wasm, hash: sha(wasm), bytes: fs.statSync(wasm).size };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (arm === 'baseline' && manifest.arms.baseline.hash !== baseline) throw Error('Source does not reproduce pinned baseline');
}
console.log(JSON.stringify(manifest, null, 2));
