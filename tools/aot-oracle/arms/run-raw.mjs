#!/usr/bin/env node
// aot-oracle ARM — raw candidate. A foreign wasm module that performs the case's guest work
// over ITS OWN linear memory, at the SAME guest addresses, from the SAME data image.
//
//   node run-raw.mjs --case k1 --candidate path/to.wasm [--mode b1] [--outer N]
//                    [--warmup-calls W] [--chunk 8] [--fault name]
//
// This is the adapter for a lowering study rather than a contract-shaped unit (the spike's
// variant B is the reference example). It cannot be entered through the dispatcher and has no
// v86 CPU behind it, so the ONLY way it can satisfy the register half of the differential is
// to do what the module contract requires of a real unit anyway: flush the architectural
// register file to guest memory at the exit (corpus L.STATE), and optionally publish the
// host-side state block (lib/state.mjs). Nothing here fabricates either one.
//
// The work is issued in SMALL chunks on purpose: V8 tiers a wasm function up between CALLS,
// never inside one, so a single long call would be measured in Liftoff.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import * as L from "../corpus/layout.mjs";
import { getCase } from "../corpus/cases.mjs";
import { insPerOuter } from "../corpus/image.mjs";
import { readCandidateStateBlock } from "../lib/state.mjs";
import { parseArgs, usageExit } from "../lib/args.mjs";

// No --flags / --relaxed here on purpose: a foreign module has no codegen shape to set, so
// accepting one would mean silently applying it to nothing.
const KNOWN = ["case", "candidate", "mode", "outer", "warmup-calls", "chunk", "fault"];
let args;
try { args = parseArgs(process.argv, KNOWN); } catch (e) { usageExit(e); }

const c = getCase(args.case || "k1");
const n1 = Number(args.outer || 20000);
const n2 = n1 * 2;
const chunk = Number(args.chunk || 8);
const warmupCalls = Number(args["warmup-calls"] || 20000);

// Named modes of the spike's variant-B module (tools/probes/aot-spike/variant-b/src/lib.rs).
// Any other candidate: pass --mode <int>; it is handed to the entry function unchanged.
const MODES = { b1: 1, b2: 2, b1c: 3, b1m: 4, b1t: 5 };
const modeArg = MODES[String(args.mode || "b1").toLowerCase()] ?? Number(args.mode);
if (!Number.isFinite(modeArg)) { console.error(`bad --mode ${args.mode}`); process.exit(2); }

const candPath = args.candidate;
if (!candPath) { console.error("--candidate <module.wasm> is required"); process.exit(2); }
if (!fs.existsSync(candPath)) { console.error(`missing candidate ${candPath}`); process.exit(2); }

const bytes = fs.readFileSync(candPath);
const module = new WebAssembly.Module(bytes);
const declaredImports = WebAssembly.Module.imports(module);
if (declaredImports.length) {
    console.error(`candidate declares ${declaredImports.length} imports (${declaredImports.map(i => i.module + "." + i.name).join(", ")}); the raw adapter provides none — a module that needs v86's "e" namespace is a UNIT, run it with arms/run-v86.mjs --aot`);
    process.exit(2);
}
const instance = new WebAssembly.Instance(module, {});
const ex = instance.exports;
if (typeof ex.guest_base !== "function") { console.error("candidate exports no guest_base()"); process.exit(2); }
// A case may exist for the v86-hosted arms only (no foreign-module entry point). Say which case
// and why, instead of dereferencing null and reporting a crash the caller has to decode.
if (!c.raw) {
    console.error(`case ${c.id} declares no raw entry point — it is a unit-only case; run it with arms/run-v86.mjs`);
    process.exit(2);
}
const entryName = c.raw.fn;
if (typeof ex[entryName] !== "function") { console.error(`candidate exports no ${entryName}() for case ${c.id}`); process.exit(2); }
const base = ex.guest_base();
const mem = ex.memory;
if (!mem) { console.error("candidate exports no memory"); process.exit(2); }

// Tell the candidate where the architectural register file must land, and what ESP is at the
// capture point (after the wrapper's `ret`, i.e. the driver's stack top in the v86 arms).
// A candidate that ignores this leaves L.STATE zeroed and diverges at STATE.eax — which is
// the correct outcome, not something to paper over, so the call is best-effort and reported.
const candAbi = typeof ex.bs_oracle_abi === "function" ? ex.bs_oracle_abi() >>> 0 : null;
if (typeof ex.bs_set_capture === "function") ex.bs_set_capture(L.STATE, L.STACK_TOP);

let faultApplied = null;
function loadImage() {
    new Uint8Array(mem.buffer, base, L.IMAGE_END).fill(0);
    L.writeDataImage(new DataView(mem.buffer, base, L.IMAGE_END), 0);
    if (args.fault) {
        const f = c.faults?.[args.fault];
        if (!f) { console.error(`case ${c.id} has no fault "${args.fault}"`); process.exit(2); }
        faultApplied = { name: args.fault, detail: f(new DataView(mem.buffer, base, L.IMAGE_END), 0) };
    }
}

const call = (n) => ex[entryName](...c.raw.args(n, modeArg));

function runOuter(total) {
    let done = 0, ok = 1;
    while (done < total) {
        const n = Math.min(chunk, total - done);
        ok &= call(n);
        done += n;
    }
    return ok;
}

loadImage();
for (let i = 0; i < warmupCalls; i++) call(chunk);

const t0 = process.hrtime.bigint();
const ok1 = runOuter(n1);
const t1 = process.hrtime.bigint();
const ok2 = runOuter(n2);
const t2 = process.hrtime.bigint();

// The capture call: the v86 arms execute one more full outer iteration outside every measured
// phase and spill the register file right after it. Do the same so both sides describe the
// same architectural moment.
const okCapture = call(1);

const p1 = Number(t1 - t0), p2 = Number(t2 - t1);
const nsPerOuter = (p2 - p1) / (n2 - n1);
const perOuter = insPerOuter(c);

const regions = c.regions.map((r) => {
    const slice = Buffer.from(new Uint8Array(mem.buffer, base + r.addr, r.len));
    return { name: r.name, addr: r.addr, len: r.len, fields: r.fields ?? null,
        sha256: crypto.createHash("sha256").update(slice).digest("hex"), hex: slice.toString("hex") };
});

let state = null, stateError = null;
try { state = readCandidateStateBlock(ex); } catch (e) { stateError = String(e); }

console.log(JSON.stringify({
    arm: "raw", impl: `wasm/${path.basename(candPath)}#${args.mode ?? "b1"}`, case: c.id,
    status: (ok1 && ok2 && okCapture) ? "ok" : "GUARD_REJECTED",
    node: process.version, fault: faultApplied,
    outer: { warmup_calls: warmupCalls, chunk, n1, n2 },
    phase_ns: { p1, p2 },
    ns_per_outer: nsPerOuter,
    guest_ins_per_outer: perOuter,
    guest_mips: perOuter / nsPerOuter * 1000,
    candidate: { file: path.resolve(candPath), bytes: bytes.length, mode: modeArg,
        oracle_abi: candAbi, spills_register_file: typeof ex.bs_set_capture === "function",
        sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
    regions,
    state, state_error: stateError,
    // A raw candidate is not entered through the dispatcher and compiles nothing, so the
    // JIT-side gates have no subject here; null means "not applicable to this arm", and the
    // oracle applies those gates to the reference arm, which does have one.
    jit: null, aot: null,
}));
