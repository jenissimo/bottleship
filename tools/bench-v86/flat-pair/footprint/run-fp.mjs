// footprint/run-fp.mjs — one v86-arm run (same runner as ../run-v86.mjs) plus footprint readouts.
//
//   node [v8 flags] footprint/run-fp.mjs --exe out/flat/flat.exe --warm 4 --lo 20000 --hi 80000 --reps 4
//        [--flags "4=1"] [--switches k=v] [--dump file.bin]  [--linger ms] [--out file.json]
//
// --dump      capture EVERY generated Wasm module (cpu.js __wasmDump, latest per entry page) and write
//             them as one length-prefixed file: [u32 start][u32 len][bytes]... (module-classes.mjs reads it).
// --linger    keep the event loop alive N ms before exit: V8 logs Wasm code-creation events from a
//             foreground task, which process.exit() in ../run-v86.mjs would skip (--log-code / --prof).
// Prints the run-v86 JSON (+ rssMB, v8 heap code stats) on stdout.
import fs from "node:fs";
import v8 from "node:v8";
import { runV86 } from "../run-v86.mjs";

const a = process.argv.slice(2);
const o = { warm: 2, lo: 1000, hi: 4000, reps: 3, seed: 7, linger: 0 };
for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (["--warm", "--lo", "--hi", "--reps", "--seed", "--linger"].includes(k)) o[k.slice(2)] = Number(a[++i]);
    else if (["--exe", "--flags", "--switches", "--dump", "--out", "--label"].includes(k)) o[k.slice(2)] = a[++i];
    else if (k === "--dispatch") o.dispatch = true;
    else { console.error(`unknown option ${k}`); process.exit(2); }
}
if (o.dump) globalThis.__wasmDump = { keepLatestPerPage: false, out: [] };
const r = await runV86(o);
r.rssMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
// marks are hrtime ns; express warm-up end / run end on the performance.now() clock (prof-split.mjs)
{
    const off = performance.now() - Number(process.hrtime.bigint()) / 1e6;
    const at = (id) => { const m = r.marks.find((x) => x.id === id); return m ? +(m.t / 1e6 + off).toFixed(1) : null; };
    r.markTimes = { warmDone: at(2), end: at(99) };
}
r.heapCode = v8.getHeapCodeStatistics();
if (o.dump) {
    const latest = new Map();
    // keyed by wasm table slot: a recompile of the same code replaces its slot's module
    for (const m of globalThis.__wasmDump.out) latest.set(m.table_index, m);
    const parts = [];
    for (const m of latest.values()) {
        const h = Buffer.alloc(8); h.writeUInt32LE(m.start >>> 0, 0); h.writeUInt32LE(m.len >>> 0, 4);
        parts.push(h, Buffer.from(m.bytes));
    }
    fs.writeFileSync(o.dump, Buffer.concat(parts));
    r.dump = { file: o.dump, modules: latest.size, captured: globalThis.__wasmDump.out.length,
        finalWasmBytes: [...latest.values()].reduce((s, m) => s + m.len, 0) };
}
if (o.linger) await new Promise((res) => setTimeout(res, o.linger));
const s = JSON.stringify(r);
if (o.out) fs.writeFileSync(o.out, s);
console.log(s);
process.exit(r.status === "ok" ? 0 : 3);
