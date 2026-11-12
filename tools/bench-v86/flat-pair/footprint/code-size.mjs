// footprint/code-size.mjs — machine-code size and static shape of what V8 made of the JIT's modules.
//
//   cmd /c "node --print-wasm-code footprint/run-fp.mjs --exe out/flat/flat.exe <plan> | node footprint/code-size.mjs --tag flat --out footprint/out/code-flat.json"
//
// Reads V8's --print-wasm-code stream (release Node prints the disassembly) on stdin. Every
// "--- WebAssembly code ---" record is one compiled function: name, tier, instruction bytes. The
// JIT's modules are named g<eip8>@t<table>; the LAST record per name is the code that runs (a
// Liftoff record followed by a TurboFan one = tiered up). For JIT functions the instructions are
// classified statically:
//   slot      an operand [rbp+-d] / [rsp+d]: register-allocator spill or fill (TurboFan frame slot)
//   mem       any other memory operand (guest RAM, CPU state, TLB, tables, instance fields)
//   movrr     register-to-register move without memory (parallel moves at block edges)
//   imm       mov reg, imm
//   br        conditional / unconditional jumps;  call;  other = ALU and the rest
// The run's own JSON line (run-fp.mjs) is picked up from the same stream.
import fs from "node:fs";
import readline from "node:readline";

const a = process.argv.slice(2);
const opt = { tag: "run", out: null };
for (let i = 0; i < a.length; i++) {
    if (a[i] === "--tag") opt.tag = a[++i];
    else if (a[i] === "--out") opt.out = a[++i];
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const recs = [];
let cur = null, inInstr = false, run = null;
const JIT = /^g[0-9a-f]{8}/;
const INS = /^([0-9A-Fa-f]{8,16})\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.*)$/;
function classify(text, c) {
    const t = text.replace(/^REX\.W\s+/, "");
    const mn = t.split(/\s+/)[0];
    const hasMem = t.includes("[");
    const slot = /\[(rbp|rsp)[+-]/.test(t);
    if (slot) { c.slot++; if (/^(mov|vmov|movs)/.test(mn)) { if (/^\S+\s+\[/.test(t)) c.slotStore++; else c.slotLoad++; } }
    else if (hasMem) c.mem++;
    else if (/^j/.test(mn)) c.br++;
    else if (/^call/.test(mn)) c.call++;
    else if (/^(mov[lq]?|movzx\w*|movsx\w*|vmov\w*)$/.test(mn) && /,\s*[0-9A-Fa-f]{4,}$|,\s*0x[0-9a-f]+$|,\s*\d+$/.test(t)) c.imm++;
    else if (/^(mov[lq]?|vmov\w*|movaps|movapd)$/.test(mn)) c.movrr++;
    else c.other++;
}
rl.on("line", (line) => {
    if (line.startsWith("{\"arm\"")) { try { run = JSON.parse(line); } catch { /* partial */ } return; }
    if (line.startsWith("--- WebAssembly code ---")) { cur = { name: null, compiler: null, body: 0, instrSize: 0, n: 0 }; recs.push(cur); inInstr = false; return; }
    if (!cur) return;
    if (line.startsWith("name: ")) { cur.name = line.slice(6).trim(); return; }
    if (line.startsWith("compiler: ")) { cur.compiler = line.slice(10).trim(); return; }
    if (line.startsWith("Body (size = ")) { cur.body = Number(/size = (\d+)/.exec(line)[1]); return; }
    if (line.startsWith("Instructions (size = ")) {
        cur.instrSize = Number(/size = (\d+)/.exec(line)[1]); inInstr = true;
        if (cur.name && JIT.test(cur.name)) cur.c = { slot: 0, slotLoad: 0, slotStore: 0, mem: 0, movrr: 0, imm: 0, br: 0, call: 0, other: 0 };
        return;
    }
    if (inInstr) {
        const m = INS.exec(line);
        if (!m) { if (line.trim() === "" || /^(Source positions|Safepoints|RelocInfo|Exception|Handler|Protected)/.test(line)) inInstr = false; return; }
        cur.n++;
        if (cur.c) classify(m[4], cur.c);
    }
});
rl.on("close", () => {
    const last = new Map();
    for (const r of recs) if (r.name) last.set(r.name, r);
    const jit = [...last.values()].filter((r) => JIT.test(r.name));
    const rt = [...last.values()].filter((r) => !JIT.test(r.name));
    const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
    const tier = (xs, t) => xs.filter((r) => r.compiler === t);
    const C = { slot: 0, slotLoad: 0, slotStore: 0, mem: 0, movrr: 0, imm: 0, br: 0, call: 0, other: 0 };
    for (const r of tier(jit, "TurboFan")) for (const k in C) C[k] += r.c?.[k] ?? 0;
    const nTF = sum(tier(jit, "TurboFan"), (r) => r.n);
    const out = {
        tag: opt.tag,
        run: run ? { status: run.status, jit: run.jit, dump: run.dump, textBytes: run.sections?.find((s) => s.name === ".text")?.vsize, rssMB: run.rssMB, heapCode: run.heapCode } : null,
        jitModules: jit.length,
        jitTurboFan: { count: tier(jit, "TurboFan").length, bytes: sum(tier(jit, "TurboFan"), (r) => r.instrSize), instrs: nTF },
        jitLiftoffFinal: { count: tier(jit, "Liftoff").length, bytes: sum(tier(jit, "Liftoff"), (r) => r.instrSize) },
        jitAllRecordsBytes: sum(recs.filter((r) => r.name && JIT.test(r.name)), (r) => r.instrSize),
        runtime: { TurboFan: { count: tier(rt, "TurboFan").length, bytes: sum(tier(rt, "TurboFan"), (r) => r.instrSize) },
            Liftoff: { count: tier(rt, "Liftoff").length, bytes: sum(tier(rt, "Liftoff"), (r) => r.instrSize) } },
        jitTfInstrMix: C,
        jitTfInstrMixPct: Object.fromEntries(Object.entries(C).map(([k, v]) => [k, +((v / nTF) * 100).toFixed(2)])),
        jitTfBytesPerInstr: +(sum(tier(jit, "TurboFan"), (r) => r.instrSize) / nTF).toFixed(2),
        biggestJit: jit.sort((x, y) => y.instrSize - x.instrSize).slice(0, 5).map((r) => [r.name, r.compiler, r.instrSize]),
        perModule: jit.map((r) => ({ name: r.name, tier: r.compiler, bytes: r.instrSize, n: r.n, slot: r.c?.slot ?? null, movrr: r.c?.movrr ?? null })),
    };
    if (run?.jit?.emittedWasmBytes) out.machinePerWasmByte = +(out.jitTurboFan.bytes / (run.dump?.finalWasmBytes ?? run.jit.emittedWasmBytes)).toFixed(3);
    const text = out.run?.textBytes;
    if (text) out.machinePerTextByte = +((out.jitTurboFan.bytes + out.jitLiftoffFinal.bytes) / text).toFixed(1);
    const s = JSON.stringify(out, null, 1);
    if (opt.out) fs.writeFileSync(opt.out, s);
    const brief = { ...out, perModule: undefined };
    console.log(JSON.stringify(brief));
});
