#!/usr/bin/env node
// Add a stopped, post-timing dispatch census to the pinned BYTEmark runner.
// The original runner and the exact instrumented source remain in the evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const label = process.argv[3] || 'A2';
if (!/^[A-Za-z0-9_-]+$/.test(label)) throw Error('Invalid label');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.join(manifest.output, `bytemark-${label}.json`);
if (fs.existsSync(output)) throw Error(`Refusing to overwrite ${output}`);
const sourceDir = path.join(manifest.output, 'sources/tools/bench-v86');
const original = fs.readFileSync(path.join(sourceDir, 'run-bytemark.mjs'), 'utf8');
if (sha(original) !== manifest.sources['tools/bench-v86/run-bytemark.mjs']) throw Error('Pinned runner drift');
const marker = '    emulator.destroy();';
if (original.split(marker).length !== 2) throw Error('Runner finish shape changed');
const source = original.replace(/^(#![^\n]*\n)/, '$1import { collectDispatchCensus } from "./dod-dispatch-census.mjs";\n').replace(marker,
    '    emulator.stop();\n    result.dod_census = collectDispatchCensus(emulator.v86.cpu);\n' + marker);
const runner = path.join(sourceDir, `run-bytemark-dod-${label}.mjs`);
fs.writeFileSync(runner, source);
const censusSource = fs.readFileSync(new URL('./dod-dispatch-census.mjs', import.meta.url));
fs.writeFileSync(path.join(sourceDir, 'dod-dispatch-census.mjs'), censusSource);
for (const name of ['v86.wasm', 'libv86.mjs']) {
    if (sha(fs.readFileSync(path.join(manifest.engine, 'build', name))) !== manifest.artifacts[name].sha256) {
        throw Error(`Pinned artifact drift: ${name}`);
    }
}
const args = [runner, '--engine', manifest.engine, '--bios', path.join(root, 'vendor/v86/bios'),
    '--images', path.join(root, 'tools/bench-v86/images'), '--flags', manifest.flags,
    '--relaxed', '1', '--tests', 'DONUMSORT,DOSTRINGSORT,DOLU', '--label', `dod-shipping-${label}`,
    '--out', output, '--timeout', '6'];
fs.writeFileSync(path.join(manifest.output, `bytemark-${label}-provenance.json`), JSON.stringify({
    created: new Date().toISOString(), runnerHash: sha(source), censusHash: sha(censusSource), args,
    note: 'Census added after result.wall_ms and scores are recorded, with emulator stopped; no per-lookup instrumentation.',
}, null, 2));
const stdout = fs.openSync(path.join(manifest.output, `bytemark-${label}.stdout.log`), 'wx');
const stderr = fs.openSync(path.join(manifest.output, `bytemark-${label}.stderr.log`), 'wx');
const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', stdout, 'pipe'], windowsHide: true });
child.stderr.on('data', bytes => { fs.writeSync(stderr, bytes); process.stderr.write(bytes); });
const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
});
fs.closeSync(stdout); fs.closeSync(stderr);
if (exitCode === 0) {
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    console.log(JSON.stringify({ output, scores: result.scores, clock: result.clock,
        metadata: result.dod_census.metadata, slabs: result.dod_census.slabs }, null, 2));
}
process.exitCode = exitCode;
