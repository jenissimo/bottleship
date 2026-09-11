/**
 * The gap, per instruction family: emulator time / native-Wasm time for the SAME C++ kernel.
 *
 * This is the number that matters for closing on a real compiler, and it is decomposed by
 * family rather than averaged: one kernel per family means the worst family is visible instead
 * of hidden in a mean. Both arms are checksum-verified, so a faster arm cannot be one that did
 * less work.
 *
 * Usage: bun tools/bench-v86/source-pair/codegen-gap.ts [k1 k2 ...] [--runs N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dir, '../../..');
const demo = process.env.CODEGEN_DEMO_DIR || 'C:/Projects/bottleship-demos/demo_codegen_pair';
const build = JSON.parse(fs.readFileSync(path.join(demo, 'build.json'), 'utf8'));
const runsIndex = process.argv.indexOf('--runs');
const runs = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 3;
const wanted = process.argv.slice(2).filter(a => /^k[1-6]$/.test(a));
const kernels = wanted.length ? wanted : ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];

// The rounds each bundle was built with; the native arm must run the SAME work.
const args = build.history.filter((h: any) => String(h.args?.[0] ?? '').includes('make-wgb'));
const roundsFor = (k: string) => {
    const entry = build.history.find((h: any) => (h.args ?? []).some((a: any) => String(a).includes(`codegen-${k}.wgb`)));
    const argv = entry?.args?.[entry.args.indexOf('--args') + 1] as string | undefined;
    if (!argv) throw new Error(`No build args recorded for ${k}`);
    const parts = argv.split(/\s+/);
    return { seed: Number(parts[0]), kernel: Number(parts[1]), count: Number(parts[2]), rounds: Number(parts[3]) };
};
void args;

const rows: any[] = [];
for (const k of kernels) {
    const w = roundsFor(k);
    const native = spawnSync('node', [path.join(repo, 'tools/bench-v86/source-pair/codegen-oracle.mjs'),
        String(w.kernel), String(w.count), String(w.rounds), String(w.seed)], { encoding: 'utf8' });
    if (native.status !== 0) throw new Error(`native arm failed for ${k}: ${native.stderr}`);
    const nat = JSON.parse(native.stdout.trim().split('\n').pop()!);

    const emu = spawnSync('bun', [path.join(repo, 'tools/bench-v86/source-pair/codegen-bench.ts'),
        k, '--runs', String(runs), '--expect', String(nat.checksum)], { encoding: 'utf8' });
    if (emu.status !== 0) { rows.push({ kernel: k, error: (emu.stderr || emu.stdout).slice(-300) }); continue; }
    const out = JSON.parse(emu.stdout.trim().split('\n').pop()!);
    rows.push({
        kernel: k, work: w, nativeMs: nat.ms, emulatorMs: out.median,
        gap: +(out.median / nat.ms).toFixed(2), spreadPct: out.spreadPct, checksum: nat.checksum,
    });
    console.log(JSON.stringify(rows.at(-1)));
}
const file = path.join(repo, 'logs/codegen-pair', 'gap.json');
fs.writeFileSync(file, JSON.stringify({ rows, note: 'emulator median / native single run; both arms checksum-verified' }, null, 2));
console.log(`wrote ${path.relative(repo, file)}`);
