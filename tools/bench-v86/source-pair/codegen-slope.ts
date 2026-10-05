/**
 * The codegen gap measured as a SLOPE, not as a single timing.
 *
 * A single fixed-work timing of this demo is cold: the guest runs interpreted until
 * JIT_THRESHOLD (200k retired instructions, vendor/v86/src/rust/jit.rs:1870), compilation is
 * asynchronous, and V8 still tiers Liftoff->TurboFan inside a 100-700 ms phase. Whatever that
 * costs is a FIXED cost — it does not grow with the iteration count — so measuring two work
 * volumes and taking (t_hi - t_lo) / (n_hi - n_lo) subtracts it. The ratio of the two slopes is
 * the steady-state gap; the ratio of the raw times is "cold start plus the gap", an upper bound.
 *
 * Both arms are checksum-verified per volume, so an arm cannot be faster by doing less.
 *
 * Usage: bun tools/bench-v86/source-pair/codegen-slope.ts [k1 k2 ...] [--runs N]
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

const volumes = build.volumes as Record<string, number>;
const roundsBase = build.rounds as Record<string, number>;
const count = build.count as number;
if (!volumes || !roundsBase) throw new Error('build.json predates two-volume bundles; rebuild the demo');

const native = (kernel: number, rounds: number, seed = 73) => {
    const r = spawnSync('node', [path.join(repo, 'tools/bench-v86/source-pair/codegen-oracle.mjs'),
        String(kernel), String(count), String(rounds), String(seed), '--warm'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`native arm failed: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
};
const emulator = (k: string, volume: string, expect: number) => {
    const r = spawnSync('bun', [path.join(repo, 'tools/bench-v86/source-pair/codegen-bench.ts'),
        k, '--volume', volume, '--runs', String(runs), '--expect', String(expect)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`emulator arm failed for ${k}/${volume}: ${(r.stderr || r.stdout).slice(-300)}`);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
};

const rows: any[] = [];
for (const k of kernels) {
    const kn = Number(k.slice(1));
    const rLo = roundsBase[kn] * volumes.lo, rHi = roundsBase[kn] * volumes.hi;
    const iterLo = count * rLo, iterHi = count * rHi;
    try {
        const natLo = native(kn, rLo), natHi = native(kn, rHi);
        const emuLo = emulator(k, 'lo', natLo.checksum), emuHi = emulator(k, 'hi', natHi.checksum);
        // ns per iteration, cold cost removed by the subtraction.
        const natSlope = ((natHi.ms - natLo.ms) * 1e6) / (iterHi - iterLo);
        const emuSlope = ((emuHi.median - emuLo.median) * 1e6) / (iterHi - iterLo);
        rows.push({
            kernel: k, iterLo, iterHi,
            nativeMs: { lo: natLo.ms, hi: natHi.ms }, emulatorMs: { lo: emuLo.median, hi: emuHi.median },
            nativeNsPerIter: +natSlope.toFixed(3), emulatorNsPerIter: +emuSlope.toFixed(3),
            slopeGap: +(emuSlope / natSlope).toFixed(2),
            coldGapLo: +(emuLo.median / natLo.ms).toFixed(2),
            // Fixed cost the slope removed, as seen by each arm.
            emulatorFixedMs: +(emuLo.median - (emuSlope * iterLo) / 1e6).toFixed(1),
            spreadPct: { lo: emuLo.spreadPct, hi: emuHi.spreadPct },
        });
        console.log(JSON.stringify(rows.at(-1)));
    } catch (e) {
        rows.push({ kernel: k, error: String(e).slice(0, 300) });
        console.log(JSON.stringify(rows.at(-1)));
    }
}
const file = path.join(repo, 'logs/codegen-pair', 'slope.json');
fs.writeFileSync(file, JSON.stringify({
    rows, count, volumes,
    note: 'slopeGap is the steady-state codegen gap; coldGapLo is the single-timing ratio, an upper bound that includes JIT warm-up and V8 tier-up.',
}, null, 2));
console.log(`wrote ${path.relative(repo, file)}`);
