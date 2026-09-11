import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = fs.mkdtempSync(path.join(root, 'tools/bench-v86/results/x87-fixed-'));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const median = xs => { const s = [...xs].sort((a,b) => a-b); return (s[(s.length-1)>>1] + s[s.length>>1]) / 2; };
const order = ['baseline','baseline','baseline','baseline',
    'baseline','candidate','candidate','baseline','baseline','candidate',
    'candidate','baseline','baseline','candidate','candidate','baseline'];
const rows = [];
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...manifest, order, harness: hash(path.join(root, 'tools/bench-v86/x87-fixed-work.mjs')) }, null, 2));
console.log(`OUTPUT ${out}`);
for (const [i, arm] of order.entries()) {
    const a = manifest.arms[arm];
    if (hash(a.wasm) !== a.hash) throw Error('artifact changed');
    const file = path.join(out, `${i}-${arm}.json`);
    const p = spawnSync(process.execPath, [path.join(root, 'tools/bench-v86/x87-fixed-work.mjs'),
        '--wasm', a.wasm, '--rounds', '7', '--iterations', '5000000', '--out', file],
        { cwd: root, encoding: 'utf8', maxBuffer: 8 << 20 });
    fs.writeFileSync(path.join(out, `${i}-${arm}.log`), p.stdout + p.stderr);
    if (p.status !== 0) throw Error(p.stderr);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = { i, arm, medians: Object.fromEntries(data.results.map(r => [r.kind, median(r.samples.map(s => s.ms))])) };
    rows.push(row); console.log(JSON.stringify(row));
}
const summary = { rows, paired: {} };
for (const kind of ['pair', 'spread', 'memory']) {
    const aa = [0,2].map(i => 100 * (rows[i+1].medians[kind] / rows[i].medians[kind] - 1));
    const ab = [4,6,8,10,12,14].map(i => {
        const [a,b] = rows[i].arm === 'baseline' ? [rows[i],rows[i+1]] : [rows[i+1],rows[i]];
        return 100 * (b.medians[kind] / a.medians[kind] - 1);
    });
    summary.paired[kind] = { aa, ab, medianPercentLatency: median(ab) };
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.paired));
