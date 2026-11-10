// footprint/prof-split.mjs — where the measured time goes: JIT module code vs v86 runtime (by function)
// vs everything else, from V8's own tick sampler (--prof) mapped through --print-wasm-code ranges.
//
//   cmd /c "node --prof --no-logfile-per-isolate --logfile=footprint/out/prof-X.log --print-wasm-code
//           footprint/run-fp.mjs --exe out/X/flat.exe --warm 4 --lo 20000 --hi 400000 --reps 2 --mark-time
//           | node footprint/prof-split.mjs --log footprint/out/prof-X.log --tag X --out footprint/out/prof-X.json"
//
// --log-code does not log Wasm code in this Node (22.14) and V8's tick sampler on Windows runs at the
// system timer (~15.6 ms), so: ranges come from the --print-wasm-code records (address of the first
// instruction + instruction size), ticks from the --prof log, and only ticks AFTER the warm-up mark
// (run-fp --mark-time prints performance.now() at mark 2, aligned to the log's microsecond clock by
// the log's first tick ~ process start) are counted. Coarse (thousands of ticks), but unbiased.
import fs from "node:fs";
import readline from "node:readline";

const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) opt[a[i].slice(2)] = a[i + 1]?.startsWith("--") ? true : a[++i];
const JIT = /^g[0-9a-f]{8}/;
const ranges = [];   // [start, end, name, tier]
let cur = null, wantAddr = false, run = null;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
    if (line.startsWith("{\"arm\"")) { try { run = JSON.parse(line); } catch { } return; }
    if (line.startsWith("--- WebAssembly code ---")) { cur = { name: null, tier: null, size: 0 }; return; }
    if (!cur) return;
    if (line.startsWith("name: ")) cur.name = line.slice(6).trim();
    else if (line.startsWith("compiler: ")) cur.tier = line.slice(10).trim();
    else if (line.startsWith("Instructions (size = ")) { cur.size = Number(/size = (\d+)/.exec(line)[1]); wantAddr = true; }
    else if (wantAddr) {
        const m = /^([0-9A-Fa-f]{8,16})\s/.exec(line);
        if (m) { const s = BigInt("0x" + m[1]); ranges.push([s, s + BigInt(cur.size), cur.name, cur.tier, ranges.length]); wantAddr = false; cur = null; }
    }
});
rl.on("close", () => {
    // Liftoff code freed after tier-up can be reused for later code: the LATEST record covering pc wins.
    const find = (pc) => {
        let best = null;
        for (const r of ranges) if (r[0] <= pc && pc < r[1] && (!best || r[4] > best[4])) best = r;
        return best;
    };
    const log = fs.readFileSync(opt.log, "utf8").split(/\r?\n/);
    const ticks = [];
    for (const l of log) if (l.startsWith("tick,")) { const f = l.split(","); ticks.push([BigInt(f[1]), Number(f[2])]); }
    const warmMs = run?.markTimes?.warmDone ?? null, endMs = run?.markTimes?.end ?? null;
    // performance.now() is ms since timeOrigin; the V8 log clock is us since logger start. Both start at
    // process start to within tens of ms; the warm-up cut is seconds away, so that error is immaterial.
    const inWin = (t) => (warmMs === null || t / 1000 >= warmMs) && (endMs === null || t / 1000 <= endMs);
    const by = new Map(), cls = { jitModule: 0, jitModuleLiftoff: 0, runtimeWasm: 0, other: 0 };
    let n = 0;
    for (const [pc, t] of ticks) {
        if (!inWin(t)) continue;
        n++;
        const r = find(pc);
        let key;
        if (!r) { cls.other++; key = "(other: V8/JS/C++)"; }
        else if (JIT.test(r[2])) { if (r[3] === "Liftoff") cls.jitModuleLiftoff++; else cls.jitModule++; key = "(JIT modules)"; }
        else { cls.runtimeWasm++; key = r[2].replace(/^_RN\w+?\d+(\w+)$/, "$1"); }
        by.set(key, (by.get(key) ?? 0) + 1);
    }
    const pct = (v) => +((v / n) * 100).toFixed(1);
    const out = {
        tag: opt.tag, ticksInWindow: n, ticksTotal: ticks.length, ranges: ranges.length, window: { warmMs, endMs },
        classesPct: Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, pct(v)])),
        top: [...by].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => [k, v, pct(v)]),
        run: run ? { status: run.status, jit: run.jit } : null,
    };
    if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
});
