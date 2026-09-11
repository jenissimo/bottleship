// Isolated source experiment: make the EAGL read cursor N-way. Shipping source and Wasm stay
// untouched; the candidate is published to public/apps/source-pair-lab/engines/<sha>.wasm so the
// existing engine selector (verified against the bytes actually instantiated) can A/B it.
//
// WHY: `eagl_read32_cold` is 5.7% of busy in a race — the biggest single hypercall entry — and
// the cursor it misses is ONE entry (RC_TAG/RC_HOST_PAGE). EAGL walks a state tree, so reads
// alternate between pages and a direct-mapped single entry thrashes. Letting the entry live
// across dispatches (the existing TLB policy) measured 1.007, which is the evidence that the
// lifetime was never the problem: the associativity is.
//
// The safety argument is unchanged and is what `tools/validate-eagl-read-cursor.mjs` pins:
// every site that clears a TLB entry drops the cursor. Dropping now clears ALL ways, so a
// wider cursor cannot outlive a mapping the CPU no longer has.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const WAYS = Number(process.argv[process.argv.indexOf('--ways') + 1]) || 4;
const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-eagl-nway-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = {
    directory, ways: WAYS, shippingHash: hash('public/v86.wasm'),
    hypothesis: `Replace the single-entry EAGL read cursor with a ${WAYS}-way one; drop clears all ways.`,
    arms: {},
};
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
        const f = path.join(dst, 'src/rust/cpu/hypercall_eagl.rs');
        let source = fs.readFileSync(f, 'utf8');
        const replace = (a, b) => {
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + a.slice(0, 60));
            source = source.replace(a, b);
        };

        replace(
            'static mut RC_TAG: u32 = RC_TAG_EMPTY;\nstatic mut RC_HOST_PAGE: u32 = 0;',
            `const RC_WAYS: usize = ${WAYS};\n`
            + 'static mut RC_TAG: [u32; RC_WAYS] = [RC_TAG_EMPTY; RC_WAYS];\n'
            + 'static mut RC_HOST_PAGE: [u32; RC_WAYS] = [0; RC_WAYS];\n'
            + '/// Round-robin victim. Recency would need a second store per HIT; the hot path must\n'
            + '/// stay a compare and a load.\n'
            + 'static mut RC_NEXT: usize = 0;',
        );
        replace(
            'unsafe fn eagl_read_cursor_drop() {\n    RC_TAG = RC_TAG_EMPTY;\n    RC_HOST_PAGE = 0;\n}',
            'unsafe fn eagl_read_cursor_drop() {\n'
            + '    let mut i = 0;\n'
            + '    while i < RC_WAYS { RC_TAG[i] = RC_TAG_EMPTY; RC_HOST_PAGE[i] = 0; i += 1; }\n'
            + '    RC_NEXT = 0;\n}',
        );
        replace(
            'pub unsafe fn eagl_read_cursor_invalidate() {\n    if RC_TAG != RC_TAG_EMPTY {',
            'pub unsafe fn eagl_read_cursor_invalidate() {\n'
            + '    let mut occupied = false;\n'
            + '    let mut i = 0;\n'
            + '    while i < RC_WAYS { if RC_TAG[i] != RC_TAG_EMPTY { occupied = true; } i += 1; }\n'
            + '    if occupied {',
        );
        replace(
            'unsafe fn rc_lookup(t: u32) -> Option<u32> {\n    if t == RC_TAG {\n        return Some(RC_HOST_PAGE);\n    }\n    None\n}',
            'unsafe fn rc_lookup(t: u32) -> Option<u32> {\n'
            + '    let mut i = 0;\n'
            + '    while i < RC_WAYS {\n'
            + '        if RC_TAG[i] == t { return Some(RC_HOST_PAGE[i]); }\n'
            + '        i += 1;\n'
            + '    }\n'
            + '    None\n}',
        );
        replace(
            '    RC_TAG = rc_tag(a);\n    RC_HOST_PAGE = host;',
            '    let victim = RC_NEXT;\n'
            + '    RC_NEXT = if victim + 1 == RC_WAYS { 0 } else { victim + 1 };\n'
            + '    RC_TAG[victim] = rc_tag(a);\n'
            + '    RC_HOST_PAGE[victim] = host;',
        );
        // The structural self-test writes the cursor directly; keep it driving the shipped shape.
        source = source.replace(/RC_TAG = A;\n\s*RC_HOST_PAGE = 0x1000;/,
            'RC_TAG[0] = A;\n    RC_HOST_PAGE[0] = 0x1000;');
        source = source.replace(/RC_TAG = B;\n\s*RC_HOST_PAGE = 0x2000;/,
            'RC_TAG[1] = B;\n    RC_HOST_PAGE[1] = 0x2000;');
        source = source.replace(/if RC_TAG != RC_TAG_EMPTY \{/g, 'if RC_TAG[0] != RC_TAG_EMPTY {');
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
    // Publish where the engine selector can fetch it by content hash.
    const engines = path.resolve('public/apps/source-pair-lab/engines');
    fs.mkdirSync(engines, { recursive: true });
    fs.copyFileSync(wasm, path.join(engines, `${manifest.arms[arm].hash}.wasm`));
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ arm, ...manifest.arms[arm] }));
}
console.log(JSON.stringify({
    manifest: path.join(directory, 'manifest.json'),
    // A baseline that does NOT reproduce the shipping binary means the build environment differs
    // from the one that produced it, and the A/B would compare two unknowns.
    baselineMatchesShipping: manifest.arms.baseline.hash === manifest.shippingHash,
}));
