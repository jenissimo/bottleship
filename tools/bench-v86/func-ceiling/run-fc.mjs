// func-ceiling arm runner: the translated module, WITHOUT v86. The PE image is placed in linear
// memory at MEMBASE + ImageBase; the lab's ports become imports (IN 0x888A config, OUT 0x8889
// results, OUT 0x8888 phase marks). Same JSON shape as run-v86.mjs / run-em.mjs.
//
//   node run-fc.mjs --wasm out/flat-int/S.wasm --exe ../flat-pair/out/flat-int/flat.exe
//                   --warm 4 --lo 20000 --hi 80000 --reps 4 [--seed 7] [--out r.json]
//                   [--profile-out executed.json] [--observed-out observed.json]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { loadPE } from "./discover.mjs";

const REASONS = ["?", "BUDGET", "DEPTH", "RETMISMATCH", "INDMISS", "UNSUP", "FAULT", "COLD", "TABLE", "FLAGS"];
let START_BUDGET = 0x7fffffff;
const ESP0 = 0x3f0000 - 4, FAKE_RET = 0xdead0000;

export async function runFc(opts) {
    const wasmBytes = fs.readFileSync(opts.wasm);
    const meta = JSON.parse(fs.readFileSync(opts.wasm.replace(/\.wasm$/, ".json"), "utf8"));
    const L = meta.layout;
    const pe = loadPE(fs.readFileSync(opts.exe));
    if (opts.budget) START_BUDGET = opts.budget;
    const input = [0xf1a7, opts.warm, opts.lo, opts.hi, opts.reps, opts.seed ?? 7];
    let inPos = 0;
    const marks = [], outs = [];
    const HALT = { halt: true };
    const imports = {
        env: {
            io_in: (port) => (port === 0x888a ? (input[inPos++] ?? 0) >>> 0 : 0),
            io_out: (port, v, bud) => {
                if (port === 0x8889) outs.push(v >>> 0);
                else if (port === 0x8888) {
                    const t = Number(process.hrtime.bigint());
                    marks.push({ id: v, t, ic: L.retired ? START_BUDGET - bud : undefined });
                }
            },
            halt: () => { throw HALT; },
        },
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    const ex = instance.exports;
    const mem = new Uint8Array(ex.mem.buffer);
    mem.set(pe.img, L.MEMBASE + pe.base);
    new DataView(ex.mem.buffer).setUint32(L.MEMBASE + ESP0, FAKE_RET, true);
    const regs = [0, 0, 0, 0, ESP0, 0, 0, 0];
    const slotInit = { 8: 0, 9: 0, 10: 31, 11: 0, 12: 2, 13: START_BUDGET };
    const args = [];
    if (L.abi === "a") {
        for (const s of L.slotsUsed) args.push(s < 8 ? regs[s] : slotInit[s]);
        if (L.retcheck) args.push(0);
    } else {
        for (const s of L.slotsUsed) ex["g_s" + s].value = s < 8 ? regs[s] : slotInit[s];
        ex.g_depth.value = 0;
    }
    let status = "?", exit = null, error = null;
    const t0 = Date.now();
    try {
        const r = ex.entry(...args);
        const popped = Array.isArray(r) ? r[r.length - 1] : r;
        if (L.retcheck && popped === L.SENT) {
            exit = { reason: REASONS[ex.g_reason.value] || ex.g_reason.value, eip: (ex.g_eip.value >>> 0).toString(16) };
            status = "EXIT_" + exit.reason;
        } else status = "RETURNED";
    } catch (e) {
        if (e === HALT) status = marks.length && marks[marks.length - 1].id === 99 ? "ok" : "HALT_EARLY";
        else { status = "TRAP"; error = String(e && e.stack || e).slice(0, 2000); exit = { reason: REASONS[ex.g_reason.value] || ex.g_reason.value, eip: (ex.g_eip.value >>> 0).toString(16) }; }
    }
    const res = {
        arm: opts.label || "fc:" + (meta.variant || "?"), status, exit, error, wallMs: Date.now() - t0,
        wasm: opts.wasm, wasmSha256: crypto.createHash("sha256").update(wasmBytes).digest("hex"),
        input, marks, outs, fc: { smcSlowWrites: ex.g_smc.value, slowPathCalls: ex.g_slows.value, retiredAtEnd: L.retired ? START_BUDGET - ex.g_s13.value : null, budgetStart: START_BUDGET },
    };
    if (opts.profileOut) {
        const pm = meta.profMap;
        if (!pm) throw Error("not a profile build");
        const executed = [];
        for (let i = 0; i < pm.length; i++) if (mem[L.PROF_BASE + i]) executed.push(pm[i]);
        fs.writeFileSync(opts.profileOut, JSON.stringify({ executed, total: pm.length }));
        res.profile = { executedBlocks: executed.length, totalBlocks: pm.length };
    }
    if (opts.observedOut && exit && exit.reason === "INDMISS") {
        const prev = fs.existsSync(opts.observedOut) ? JSON.parse(fs.readFileSync(opts.observedOut, "utf8")) : [];
        prev.push(parseInt(exit.eip, 16));
        fs.writeFileSync(opts.observedOut, JSON.stringify([...new Set(prev)]));
    }
    return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    const a = process.argv.slice(2);
    const o = { warm: 2, lo: 1000, hi: 4000, reps: 3, seed: 7 };
    for (let i = 0; i < a.length; i++) {
        const k = a[i];
        if (k === "--wasm") o.wasm = a[++i];
        else if (k === "--exe") o.exe = a[++i];
        else if (k === "--out") o.out = a[++i];
        else if (k === "--label") o.label = a[++i];
        else if (k === "--profile-out") o.profileOut = a[++i];
        else if (k === "--observed-out") o.observedOut = a[++i];
        else if (["--warm", "--lo", "--hi", "--reps", "--seed", "--budget"].includes(k)) o[k.slice(2)] = Number(a[++i]);
        else { console.error("unknown option " + k); process.exit(2); }
    }
    const r = await runFc(o);
    const s = JSON.stringify(r);
    if (o.out) fs.writeFileSync(o.out, s);
    console.log(s.length > 4000 ? JSON.stringify({ ...r, marks: r.marks.length }) : s);
    process.exit(r.status === "ok" ? 0 : 3);
}
