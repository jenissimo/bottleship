// Negative control for the checksum oracle: corrupt ONE instruction (its ALU result ^= 1) and
// show the checksums diverge from the clean translation (and from em/v86).
//   node oracle-negative.mjs --wl tight-int [--variant S] [--n 3]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { loadPE, discover } from "./discover.mjs";
import { translate, parseVariant } from "./translate.mjs";
import { runFc } from "./run-fc.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const opt = { wl: "tight-int", variant: "S", n: 3 };
for (let i = 0; i < a.length; i++) opt[a[i].replace(/^--/, "")] = a[++i];
const exe = path.join(here, "../flat-pair/out", opt.wl, "flat.exe");
const pe = loadPE(fs.readFileSync(exe));
const d = discover(pe);
// candidates: the first `add`/`xor` with a register destination in data-seeded (table/vtable) functions
const cands = [];
for (const [e, how] of d.entries) {
    if (how !== "data") continue;
    const f = d.funcs.get(e);
    const ins = [...f.blocks.values()].flatMap((b) => b.ins).find((i) => i.m === "alu" && (i.a === "add" || i.a === "xor") && i.dst.k === "r");
    if (ins) cands.push(ins.addr);
    if (cands.length >= Number(opt.n)) break;
}
const dir = path.join(here, "out", opt.wl);
fs.mkdirSync(dir, { recursive: true });
const run = async (mutate) => {
    const v = parseVariant(opt.variant);
    if (mutate !== undefined) v.mutate = mutate;
    const r = translate(pe, v);
    const f = path.join(dir, `neg-${mutate === undefined ? "clean" : mutate.toString(16)}.wasm`);
    fs.writeFileSync(f, r.bytes);
    fs.writeFileSync(f.replace(/\.wasm$/, ".json"), JSON.stringify({ variant: opt.variant, layout: r.layout }));
    const x = await runFc({ wasm: f, exe, warm: 1, lo: 1000, hi: 4000, reps: 2 });
    return { status: x.status, outs: x.outs.join(",") };
};
const clean = await run();
console.log(JSON.stringify({ variant: opt.variant, clean }));
for (const c of cands) {
    const r = await run(c);
    console.log(JSON.stringify({ mutate: c.toString(16), ...r, diverges: r.outs !== clean.outs }));
}
