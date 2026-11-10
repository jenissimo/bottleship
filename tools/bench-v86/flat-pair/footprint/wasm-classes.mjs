// footprint/wasm-classes.mjs — static Wasm op mix of every module in a run-fp.mjs --dump file,
// through tools/aot/module-stats.mjs (self-checking decoder), aggregated.
//   node footprint/wasm-classes.mjs footprint/out/flat.bin [--json out.json]
import fs from "node:fs";
import { moduleStats } from "../../../aot/module-stats.mjs";

const file = process.argv[2];
const jo = process.argv.indexOf("--json");
const b = fs.readFileSync(file);
const agg = { modules: 0, moduleBytes: 0, ops: 0, groups: {}, memSplit: {}, calls: {}, state: {}, hist: {} };
let o = 0, bad = 0;
while (o < b.length) {
    const len = b.readUInt32LE(o + 4);
    const bytes = new Uint8Array(b.subarray(o + 8, o + 8 + len));
    o += 8 + len;
    let s;
    try { s = moduleStats(bytes, `m${agg.modules}`); } catch (e) { bad++; continue; }
    agg.modules++; agg.moduleBytes += s.moduleBytes; agg.ops += s.ops;
    for (const [k, v] of Object.entries(s.groups)) agg.groups[k] = (agg.groups[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.memSplit)) if (typeof v === "number") agg.memSplit[k] = (agg.memSplit[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.calls)) agg.calls[k] = (agg.calls[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.cpuStateByAddr)) {
        const name = k.split(" ")[1].replace(/\+\d+$/, "");
        const e = agg.state[name] ?? (agg.state[name] = { load: 0, store: 0 });
        e.load += v.load; e.store += v.store;
    }
}
const pct = (v) => +((v / agg.ops) * 100).toFixed(2);
const out = {
    file, modules: agg.modules, decodeFailures: bad, moduleBytes: agg.moduleBytes, ops: agg.ops, bytesPerOp: +(agg.moduleBytes / agg.ops).toFixed(2),
    groupsPct: Object.fromEntries(Object.entries(agg.groups).map(([k, v]) => [k, pct(v)])),
    memSplitPctOfOps: Object.fromEntries(Object.entries(agg.memSplit).map(([k, v]) => [k, pct(v)])),
    statePctOfOps: Object.fromEntries(Object.entries(agg.state).sort((x, y) => (y[1].load + y[1].store) - (x[1].load + x[1].store)).slice(0, 14)
        .map(([k, v]) => [k, `${pct(v.load)}r/${pct(v.store)}w`])),
    callsPerKOps: Object.fromEntries(Object.entries(agg.calls).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => [k, +((v / agg.ops) * 1000).toFixed(2)])),
};
if (jo > 0) fs.writeFileSync(process.argv[jo + 1], JSON.stringify({ ...out, raw: agg }, null, 1));
console.log(JSON.stringify(out, null, 1));
