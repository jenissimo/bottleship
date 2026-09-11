#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SHIPPING_JIT, formatFlags } from '../jit-config/shipping.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = fs.mkdtempSync(path.join(root, 'tools/bench-v86/results/dod-audit-'));
const build = path.join(output, 'engine/build');
fs.mkdirSync(build, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 32 << 20 });
const artifacts = {};
for (const name of ['v86.wasm', 'libv86.mjs']) {
    const bytes = fs.readFileSync(path.join(root, 'vendor/v86/build', name));
    fs.writeFileSync(path.join(build, name), bytes);
    artifacts[name] = { bytes: bytes.length, sha256: sha(bytes) };
}
const inputs = [
    'tools/bench-v86/audit-dod-snapshot.mjs', 'tools/bench-v86/audit-dod-dispatch.mjs',
    'tools/bench-v86/audit-dod-bytemark.mjs', 'tools/bench-v86/audit-dod-lifecycle.mjs',
    'tools/bench-v86/dod-dispatch-census.mjs',
    'tools/bench-v86/run-bytemark.mjs', 'tools/bench-v86/fs-lazy-mirror.mjs',
    'tools/jit-config/shipping.mjs', 'vendor/v86/src/rust/jit.rs',
    'vendor/v86/src/rust/cpu/cpu.rs', 'vendor/v86/src/rust/cpu/hypercall_eagl.rs',
    'vendor/v86/src/rust/codegen.rs', 'vendor/v86/src/rust/wasmgen/wasm_builder.rs',
];
const sources = {};
for (const name of inputs) {
    const bytes = fs.readFileSync(path.join(root, name));
    const destination = path.join(output, 'sources', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    sources[name] = sha(bytes);
}
fs.writeFileSync(path.join(output, 'workspace.diff'), git(root, ['diff', '--binary']));
fs.writeFileSync(path.join(output, 'vendor.diff'), git(path.join(root, 'vendor/v86'), ['diff', '--binary']));
const manifest = {
    created: new Date().toISOString(), output, engine: path.dirname(build),
    node: process.version, v8: process.versions.v8, platform: process.platform,
    release: os.release(), cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length,
    totalMemory: os.totalmem(), freeMemory: os.freemem(),
    head: git(root, ['rev-parse', 'HEAD']).toString().trim(),
    vendorHead: git(path.join(root, 'vendor/v86'), ['rev-parse', 'HEAD']).toString().trim(),
    artifacts, sources, shipping: [...SHIPPING_JIT], flags: formatFlags(SHIPPING_JIT), relaxed: 1,
    publicWasmMatches: sha(fs.readFileSync(path.join(root, 'public/v86.wasm'))) === artifacts['v86.wasm'].sha256,
    scope: 'Pinned current dirty engine; no production files replaced. Headless Node CPU evidence, not game FPS.',
    sourceToBinary: 'Existing build and current source captured separately; no rebuild establishes that these exact sources produced this binary.',
};
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
