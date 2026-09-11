// Diagnostic replay, not a performance acceptance gate: fixed guest benchmark time means
// the arms need not execute equal iteration counts. Pin artifacts and retain every raw run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { SHIPPING_JIT, flagsWith, formatFlags } from '../jit-config/shipping.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const vendor = path.join(root, 'vendor/v86');
const out = fs.mkdtempSync(path.join(root, 'tools/bench-v86/results/x87-cost-audit-'));
const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-x87-cost-'));
const hash = b => createHash('sha256').update(b).digest('hex');
const lib = fs.readFileSync(path.join(vendor, 'build/libv86.mjs'));
const artifacts = {};
for (const name of ['before', 'fixed']) {
    const build = path.join(snapshot, name, 'build');
    fs.mkdirSync(build, { recursive: true });
    const wasm = name === 'before'
        ? execFileSync('git', ['show', 'HEAD:build/v86.wasm'], { cwd: vendor, maxBuffer: 32 << 20 })
        : fs.readFileSync(path.join(vendor, 'build/v86.wasm'));
    fs.writeFileSync(path.join(build, 'v86.wasm'), wasm);
    fs.writeFileSync(path.join(build, 'libv86.mjs'), lib);
    artifacts[name] = { engine: path.dirname(build), wasm: hash(wasm), js: hash(lib) };
}
const flags = formatFlags(flagsWith(SHIPPING_JIT, [[5, 0]]));
const order = ['before', 'fixed', 'fixed', 'before'];
const manifest = {
    started: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim(),
    artifacts, flags, relaxed: 1, order,
    limitation: 'Two AB/BA pairs; exploratory guest-timed scores, not fixed-work throughput. All build changes remain confounders even with idx5/21 OFF.',
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(out, 'source.diff'), execFileSync('git', ['diff', '--', 'src'], { cwd: vendor, maxBuffer: 8 << 20 }));
console.log(`OUTPUT ${out}`);
for (const [i, name] of order.entries()) {
    console.log(`START ${i} ${name} ${new Date().toISOString()}`);
    const result = spawnSync(process.execPath, [path.join(root, 'tools/bench-v86/run-bytemark.mjs'),
        '--engine', artifacts[name].engine, '--bios', path.join(vendor, 'bios'),
        '--flags', flags, '--relaxed', '1', '--tests', 'DOFOUR,DOLU',
        '--label', `x87-cost-${i}-${name}`, '--out', path.join(out, `${i}-${name}.json`),
        '--timeout', '10'], { cwd: root, encoding: 'utf8', maxBuffer: 8 << 20 });
    fs.writeFileSync(path.join(out, `${i}-${name}.log`), result.stdout + result.stderr);
    if (result.error || result.status !== 0) throw result.error || new Error(`run ${i}: ${result.status}\n${result.stderr}`);
    console.log(result.stderr.trim());
    for (const artifact of Object.values(artifacts)) {
        if (hash(fs.readFileSync(path.join(artifact.engine, 'build/v86.wasm'))) !== artifact.wasm)
            throw new Error('snapshot changed');
    }
}
console.log(`DONE ${out}`);
