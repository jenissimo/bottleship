// func-ceiling translator: x86 PE -> ONE Wasm module, one Wasm function per discovered guest
// function, registers in locals, real wasm call/return, structured control flow (stackifier,
// Ramsey "Beyond Relooper"), guest stack in guest memory. Obligations are switches so the same
// translator produces every rung of the ladder:
//
//   retcheck  RET-check: caller compares the popped return address with the constant it pushed;
//             mismatch / callee exit propagate up (status SENTINEL). Depth cap. Checked indirect
//             call table and checked jump-table entries.
//   retired   exact retired-instruction budget (decremented per block / before calls and I/O),
//             checked on loop back edges and before calls; budget exit = observation point.
//   lazy      v86-style lazy flags: 5 words (op1, result, size, changed, flags) updated by EVERY
//             flag-producing instruction and carried across calls; consumers use the fused form
//             only when the producer is in the same block (like v86), else the generic getters.
//             Off = flags computed only where a consumer needs them (reaching-definition analysis).
//   guard     every guest memory access through an inline TLB probe of the shape v86 emits
//             (gen_safe_read / gen_safe_write), real TLB table, slow-path fill function.
//   abi       "a": state as params + multi-value results; "b": state in wasm globals, dirty-only
//             stores and lazy loads (validity dataflow with edge fix-ups).
//   cold      Set of executed blocks: everything else becomes a side exit (executed-only build).
//   profile   instrument block entries (to produce `cold`).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { Module, Code, I32, I64, F64, OP } from "./wasm.mjs";
import { loadPE, discover } from "./discover.mjs";
import { regEffects } from "./x86dec.mjs";

export const SENT = 0xfffffff0 | 0;
export const MEMBASE = 16 << 20, RAM_SIZE = 16 << 20, TLB_BASE = 0, MAP_BASE = 4 << 20, PROF_BASE = 9 << 20, CODEPAGES = 15 << 20;
export const MEM_PAGES = (MEMBASE + RAM_SIZE) >> 16;
export const R = { BUDGET: 1, DEPTH: 2, RETMISMATCH: 3, INDMISS: 4, UNSUP: 5, FAULT: 6, COLD: 7, TABLE: 8, FLAGS: 9 };
// globals
const G_SLOT = 0, G_DEPTH = 14, G_EIP = 15, G_REASON = 16, G_SMC = 17, G_SLOWS = 18, G_FCW = 19, G_ST = 20, G_FDEPTH = 28;
// slots: 0..7 GPRs, 8..12 lazy flags (op1, res, size, changed, flags), 13 budget
const S_OP1 = 8, S_RES = 9, S_SIZE = 10, S_CHG = 11, S_FLG = 12, S_BUD = 13;
const FLAGS_ALL = 0x8d5, FLAG_SUB = 0x80000000 | 0;
const TLB_VALID = 1, READ_MASK = 0xfff & ~2 & ~16 & ~32 & ~4, WRITE_MASK = 0xfff & ~16 & ~4;

// ---------------------------------------------------------------------------------------------
// flag classification
function flagKind(ins) {
    switch (ins.m) {
        case "alu": return { add: "add", sub: "sub", cmp: "sub", and: "logic", or: "logic", xor: "logic", adc: "adc", sbb: "sbb" }[ins.a];
        case "test": return "logic";
        case "inc": return "inc";
        case "dec": return "dec";
        case "neg": return "neg";
        case "shift":
            if (ins.src.k === "i") { if (ins.src.v === 0) return null; return ins.a === "rol" || ins.a === "ror" || ins.a === "rcl" || ins.a === "rcr" ? "rot" : ins.a; }
            return "shcl";
        case "imul2": case "imul3": case "imul1": case "mul1": return "mul";
        case "div": case "idiv": return "undef";
        case "shld": case "shrd": return "undef";
        case "clc": case "stc": case "cmc": return "undef";
        default: return null;
    }
}
function flagUse(ins) {
    if (ins.m === "jcc" || ins.m === "setcc" || ins.m === "cmov") return ins.cc;
    if (ins.m === "alu" && (ins.a === "adc" || ins.a === "sbb")) return 2; // CF
    if (ins.m === "shift" && (ins.a === "rcl" || ins.a === "rcr")) return 2;
    if (ins.m === "cmc") return 2;
    return -1;
}
// What a fused (statically known kind) producer can answer: cc base (even) -> ok?
function fusedOk(kind, ccBase) {
    switch (kind) {
        case "sub": case "neg": case "add": case "logic": return true;
        case "inc": case "dec": return ccBase !== 2 && ccBase !== 6;
        case "shl": case "shr": case "sar": return true;
        case "rot": return ccBase === 0 || ccBase === 2;
        case "mul": return ccBase === 0 || ccBase === 2;
        default: return false;
    }
}

// ---------------------------------------------------------------------------------------------
// CFG analysis: RPO, dominators, loops, merge nodes
function analyzeCFG(f) {
    const blocks = f.blocks;
    const order = [], seen = new Set();
    // iterative DFS postorder
    const stack = [[f.entry, 0]];
    seen.add(f.entry);
    while (stack.length) {
        const top = stack[stack.length - 1];
        const b = blocks.get(top[0]);
        if (top[1] < b.succ.length) {
            const s = b.succ[top[1]++];
            if (!seen.has(s) && blocks.has(s)) { seen.add(s); stack.push([s, 0]); }
        } else { order.push(top[0]); stack.pop(); }
    }
    const rpoList = order.reverse();
    const rpo = new Map(rpoList.map((a, i) => [a, i]));
    const preds = new Map(rpoList.map((a) => [a, []]));
    for (const a of rpoList) for (const s of blocks.get(a).succ) if (rpo.has(s)) preds.get(s).push(a);
    // Cooper-Harvey-Kennedy
    const idom = new Map([[f.entry, f.entry]]);
    const intersect = (a, b) => { while (a !== b) { while (rpo.get(a) > rpo.get(b)) a = idom.get(a); while (rpo.get(b) > rpo.get(a)) b = idom.get(b); } return a; };
    let changed = true;
    while (changed) {
        changed = false;
        for (const a of rpoList) {
            if (a === f.entry) continue;
            let nd = null;
            for (const p of preds.get(a)) if (idom.has(p)) nd = nd === null ? p : intersect(p, nd);
            if (idom.get(a) !== nd) { idom.set(a, nd); changed = true; }
        }
    }
    const dominates = (a, b) => { while (true) { if (a === b) return true; if (b === f.entry) return false; b = idom.get(b); } };
    const loopHeaders = new Set();
    let irreducible = false;
    for (const a of rpoList) for (const s of blocks.get(a).succ) {
        if (!rpo.has(s)) continue;
        if (rpo.get(s) <= rpo.get(a)) { loopHeaders.add(s); if (!dominates(s, a)) irreducible = true; }
    }
    const fwdPreds = (a) => preds.get(a).filter((p) => rpo.get(p) < rpo.get(a)).length;
    const merge = new Set(rpoList.filter((a) => a !== f.entry && fwdPreds(a) >= 2));
    const domChildren = new Map(rpoList.map((a) => [a, []]));
    for (const a of rpoList) if (a !== f.entry) domChildren.get(idom.get(a)).push(a);
    return { rpoList, rpo, preds, idom, loopHeaders, merge, domChildren, irreducible };
}

// ---------------------------------------------------------------------------------------------
export function translate(pe, opts) {
    const o = { retcheck: false, retired: false, lazy: false, guard: false, abi: "a", depthCap: 48, cold: null, profile: false, mutate: null, observed: [], ...opts };
    if (o.retired && !o.retcheck) throw Error("retired needs retcheck (exit propagation)");
    const disc = discover(pe, { observed: o.observed });
    const { funcs } = disc;
    const textLo = Math.min(...pe.text.map((s) => s.va)), textHi = Math.max(...pe.text.map((s) => s.va + s.vsize));
    const stats = { ...disc.stats, irreducible: 0, flagConsumersUnresolved: 0, flagUnresolvedKinds: {}, coldBlocks: 0, emittedFunctions: 0, emittedBlocks: 0, x86BytesEmitted: 0, insEmitted: 0, guards: 0 };

    // ---- which functions / blocks get code --------------------------------------------------
    const isColdBlock = (fe, ba) => o.cold && !o.cold.has(fe + ":" + ba);
    const isColdFunc = (fe) => o.cold && !o.cold.has(fe + ":" + fe);
    if (o.cold) {
        for (const f of funcs.values()) for (const b of f.blocks.values()) {
            if (isColdBlock(f.entry, b.addr)) { b.term = { k: "exit", why: "cold", eip: b.addr, cold: true }; b.ins = []; b.succ = []; stats.coldBlocks++; }
        }
    }
    const live = [...funcs.values()].filter((f) => !isColdFunc(f.entry));

    // ---- direct-mapped dispatch table for indirect calls -----------------------------------
    let shift = 6;
    for (; shift >= 0; shift--) {
        const s = new Set(); let ok = true;
        for (const e of funcs.keys()) { const k = (e - textLo) >>> shift; if (s.has(k)) { ok = false; break; } s.add(k); }
        if (ok) break;
    }
    const nslots = ((textHi - textLo) >>> shift) + 1;
    if (MAP_BASE + nslots * 4 > PROF_BASE) throw Error(`dispatch map (${nslots} slots) overlaps the profile area`);

    // ---- module skeleton --------------------------------------------------------------------
    const m = new Module();
    m.branchHints = o.hints !== false;
    const nSlots = 14;
    const slotsUsed = [0, 1, 2, 3, 4, 5, 6, 7, ...(o.lazy ? [S_OP1, S_RES, S_SIZE, S_CHG, S_FLG] : []), ...(o.retired ? [S_BUD] : [])];
    const params = o.abi === "a" ? [...slotsUsed.map(() => I32), ...(o.retcheck ? [I32] : [])] : [];
    const results = [...(o.abi === "a" ? slotsUsed.map(() => I32) : []), ...(o.retcheck ? [I32] : [])];
    const F_IN = m.importFunc("env", "io_in", [I32], [I32]);
    const F_OUT = m.importFunc("env", "io_out", [I32, I32, I32], []);
    const F_HALT = m.importFunc("env", "halt", [], []);
    const gtype = m.type(params, results);
    for (let i = 0; i < nSlots; i++) m.global(I32, true, 0);
    m.global(I32, true, 0); // depth
    m.global(I32, true, 0); // eip
    m.global(I32, true, 0); // reason
    m.global(I32, true, 0); // smc
    m.global(I32, true, 0); // slow path calls
    m.global(I32, true, 0x37f); // x87 control word
    for (let i = 0; i < 8; i++) m.global(F64, true, 0); // x87 registers (materialised at exits only)
    m.global(I32, true, 0); // x87 depth at the exit
    m.memory = { min: MEM_PAGES, max: MEM_PAGES };
    m.export("mem", 2, 0);
    for (const [n, g] of [["g_depth", G_DEPTH], ["g_eip", G_EIP], ["g_reason", G_REASON], ["g_smc", G_SMC], ["g_slows", G_SLOWS]]) m.export(n, 3, g);
    for (let i = 0; i < nSlots; i++) m.export("g_s" + i, 3, G_SLOT + i);

    // TLB fill helpers (slow path), one for reads and one for writes
    const fillFns = {};
    for (const kind of ["r", "w"]) {
        const fi = m.declareFunc([I32, I32], [I32], "tlb_fill_" + kind);
        const c = new Code();
        // locals: 0 addr, 1 ip, 2 page, 3 e
        c.gget(G_SLOWS).i32(1).op(OP.i32_add).gset(G_SLOWS);
        c.get(0).i32(12).op(OP.i32_shr_u).tee(2).i32(RAM_SIZE >>> 12).op(OP.i32_ge_u).if_().get(1).gset(G_EIP).i32(R.FAULT).gset(G_REASON).i32(1).op(OP.return).end();
        // e = (vpage ^ host) | VALID | (code page ? HAS_CODE : 0)
        c.get(2).i32(12).op(OP.i32_shl).get(2).i32(12).op(OP.i32_shl).i32(MEMBASE).op(OP.i32_add).op(OP.i32_xor)
            .i32(TLB_VALID).op(OP.i32_or)
            .get(2).mem(OP.i32_load8_u, 0, CODEPAGES).i32(5).op(OP.i32_shl).op(OP.i32_or).set(3);
        if (kind === "w") c.get(2).mem(OP.i32_load8_u, 0, CODEPAGES).if_().gget(G_SMC).i32(1).op(OP.i32_add).gset(G_SMC).end();
        c.get(2).i32(2).op(OP.i32_shl).get(3).mem(OP.i32_store, 2, TLB_BASE);
        c.get(3).i32(~0xfff).op(OP.i32_and);
        m.defineFunc(fi, [I32, I32], c);
        fillFns[kind] = fi;
    }

    // guest functions: indices first (calls need them)
    const fidx = new Map();
    for (const f of live) fidx.set(f.entry, m.declareFunc(params, results, "f_" + f.entry.toString(16)));
    m.export("entry", 0, fidx.get(pe.entry));
    m.table = { min: nslots, max: nslots };
    for (const f of live) m.elems.push({ offset: (f.entry - textLo) >>> shift, funcs: [fidx.get(f.entry)] });
    // MAP: slot -> guest entry address (the indirect-call check)
    const map = new Uint8Array(nslots * 4);
    const mdv = new DataView(map.buffer);
    for (const f of live) mdv.setUint32(((f.entry - textLo) >>> shift) * 4, f.entry, true);
    m.datas.push({ offset: MAP_BASE, bytes: map });
    // code pages bitmap
    const cp = new Uint8Array(RAM_SIZE >>> 12);
    for (const s of pe.text) for (let a = s.va; a < s.va + s.vsize; a += 4096) cp[a >>> 12] = 1;
    m.datas.push({ offset: CODEPAGES, bytes: cp });

    const profMap = [];
    const funcStats = [];
    for (const f of live) {
        const t0 = new FnTranslator(f, { o, m, gtype, fidx, F_IN, F_OUT, F_HALT, fillFns, textLo, shift, nslots, slotsUsed, stats, profMap, isColdFunc, disc });
        const fs_ = t0.run();
        funcStats.push(fs_);
    }
    // the one translation map that fault injection may need
    const bytes = m.encode();
    stats.wasmBytes = bytes.length;
    stats.codeSectionBytes = m.codeSectionBytes;
    stats.wasmPerX86Byte = +(m.codeSectionBytes / stats.x86BytesEmitted).toFixed(2);
    stats.tableShift = shift; stats.tableSlots = nslots;
    return { bytes, stats, profMap, layout: { MEMBASE, RAM_SIZE, MAP_BASE, PROF_BASE, TLB_BASE, SENT, slotsUsed, abi: o.abi, retcheck: o.retcheck, retired: o.retired, lazy: o.lazy, guard: o.guard, entry: pe.entry, base: pe.base } };
}

// ---------------------------------------------------------------------------------------------
class FnTranslator {
    constructor(f, env) { this.f = f; Object.assign(this, env); }

    run() {
        const { f, o, stats } = this;
        const cfg = analyzeCFG(f);
        if (cfg.irreducible) { stats.irreducible++; }
        this.cfg = cfg;
        this.flagAnalysis();
        this.hasFpu = [...f.blocks.values()].some((b) => b.ins.some((i) => i.m === "fpu"));
        if (this.hasFpu) this.fpuDataflow();
        // locals layout
        this.locals = [];
        this.nparams = o.abi === "a" ? this.slotsUsed.length + (o.retcheck ? 1 : 0) : 0;
        this.slotLocal = new Map();
        if (o.abi === "a") { this.slotsUsed.forEach((s, i) => this.slotLocal.set(s, i)); if (o.retcheck) this.L_DEPTH = this.slotsUsed.length; }
        else for (const s of this.slotsUsed) this.slotLocal.set(s, this.newLocal());
        this.L_FA = this.newLocal(); this.L_FB = this.newLocal(); this.L_FR = this.newLocal();
        this.L_XEIP = this.newLocal(); this.L_POP = this.newLocal(); this.L_DEPTHB = this.newLocal();
        this.L_I64 = this.newLocal(I64); this.L_I64B = this.newLocal(I64);
        if (this.hasFpu) { this.L_ST = Array.from({ length: 9 }, () => this.newLocal(F64)); this.L_FT = this.newLocal(F64); this.L_FSW = this.newLocal(); }
        this.tmpBase = this.locals.length; this.tmpTop = 0; this.tmpMax = 0;
        // ABI-b: validity dataflow (dry runs), then the real emission
        if (o.abi === "b") this.validityDataflow();
        this.c = new Code();
        this.emitFunction();
        // temps
        for (let i = 0; i < this.tmpMax; i++) this.locals.push(I32);
        this.m.defineFunc(this.fidx.get(f.entry), this.locals, this.c);
        stats.emittedFunctions++;
        return {};
    }
    newLocal(t = I32) { this.locals.push(t); return this.nparams + this.locals.length - 1; }
    tmp() {
        const i = this.tmpTop++;
        if (this.tmpTop > this.tmpMax) this.tmpMax = this.tmpTop;
        return this.nparams + this.tmpBase + i;
    }
    // temps are appended after all named locals, so tmp index needs the final named count:
    // named locals are all allocated before any tmp() call (see run()).

    // ---------------------------------------------------------------- flag analysis
    flagAnalysis() {
        const { f, cfg, o, stats } = this;
        // reaching flag definitions; ids: instruction addr (number), "E" entry, "C" call
        const inSets = new Map();
        const kindOf = new Map();
        const out = new Map();
        const transfer = (b, s, visit) => {
            let cur = s;
            for (const ins of b.ins) {
                const u = flagUse(ins);
                if (u >= 0 && visit) visit(ins, cur);
                if (ins.m === "call" || ins.m === "callind") cur = new Set(["C"]);
                else { const k = flagKind(ins); if (k) { cur = new Set([ins.addr]); kindOf.set(ins.addr, k); } }
            }
            return cur;
        };
        let changed = true, iter = 0;
        while (changed && iter++ < 50) {
            changed = false;
            for (const a of cfg.rpoList) {
                const b = f.blocks.get(a);
                const s = new Set(a === f.entry ? ["E"] : []);
                for (const p of cfg.preds.get(a)) if (out.has(p)) for (const x of out.get(p)) s.add(x);
                const prev = inSets.get(a);
                if (!prev || prev.size !== s.size || [...s].some((x) => !prev.has(x))) { inSets.set(a, s); changed = true; }
                out.set(a, transfer(b, s));
            }
        }
        this.consumer = new Map(); // ins.addr -> {mode:"fused"|"lazy"|"bad", kind, producer}
        this.fusedProducers = new Set();
        this.producerBlock = new Map();
        for (const a of cfg.rpoList) for (const ins of f.blocks.get(a).ins) this.producerBlock.set(ins.addr, a);
        for (const a of cfg.rpoList) {
            const b = f.blocks.get(a);
            transfer(b, inSets.get(a), (ins, cur) => {
                const cc = flagUse(ins) & ~1;
                const defs = [...cur];
                const kinds = new Set(defs.map((d) => (typeof d === "number" ? kindOf.get(d) : d)));
                const sizes = new Set(defs.map((d) => (typeof d === "number" ? this.opSize(this.insAt(d)) : 0)));
                const allIns = defs.every((d) => typeof d === "number");
                const sameBlockSingle = defs.length === 1 && allIns && this.producerBlock.get(defs[0]) === a && defs[0] < ins.addr;
                const fusedPossible = allIns && kinds.size === 1 && sizes.size === 1 && fusedOk([...kinds][0], cc);
                let mode;
                if (o.lazy) mode = sameBlockSingle && fusedPossible ? "fused" : "lazy";
                else mode = fusedPossible ? "fused" : "bad";
                if (mode === "bad") { stats.flagConsumersUnresolved++; const k = [...kinds].join("+") + "/cc" + cc; stats.flagUnresolvedKinds[k] = (stats.flagUnresolvedKinds[k] || 0) + 1; }
                const kind = [...kinds][0];
                this.consumer.set(ins.addr, { mode, kind, size: [...sizes][0] });
                if (mode === "fused") for (const d of defs) this.fusedProducers.add(d);
            });
        }
    }
    insAt(a) { for (const b of this.f.blocks.values()) for (const i of b.ins) if (i.addr === a) return i; return null; }
    opSize(ins) {
        if (!ins) return 32;
        if (ins.dst) return ins.dst.sz; if (ins.src) return ins.src.sz; return 32;
    }

    // ---------------------------------------------------------------- ABI-b validity
    validityDataflow() {
        const { f, cfg } = this;
        // register liveness (reads only; calls/rets are NOT uses: validity handles them)
        const liveIn = new Map();
        const useDef = new Map();
        for (const a of cfg.rpoList) {
            let use = 0, def = 0;
            for (const ins of f.blocks.get(a).ins) { const e = regEffects(ins); use |= e.use & ~def; def |= e.def; if (ins.m === "call" || ins.m === "callind") def |= 0xff; }
            useDef.set(a, { use, def });
            liveIn.set(a, 0);
        }
        let ch = true;
        while (ch) {
            ch = false;
            for (let i = cfg.rpoList.length - 1; i >= 0; i--) {
                const a = cfg.rpoList[i];
                let outL = 0;
                for (const s of f.blocks.get(a).succ) if (liveIn.has(s)) outL |= liveIn.get(s);
                const { use, def } = useDef.get(a);
                const v = use | (outL & ~def);
                if (v !== liveIn.get(a)) { liveIn.set(a, v); ch = true; }
            }
        }
        this.liveIn = liveIn;
        const ALL = (1 << 14) - 1;
        this.inState = new Map();
        this.outState = new Map();
        const entryState = { L: 0, G: ALL };
        for (let iter = 0; iter < 30; iter++) {
            let changed = false;
            for (const a of cfg.rpoList) {
                const s = a === this.f.entry && cfg.preds.get(a).length === 0 ? entryState : this.mergeState(a, entryState);
                const prev = this.inState.get(a);
                if (!prev || prev.L !== s.L || prev.G !== s.G) { this.inState.set(a, s); changed = true; }
                this.c = new Code(); this.frames = [{ k: "exit" }];
                this.st = { ...s };
                this.dry = true;
                this.emitBlockBody(a, true);
                this.outState.set(a, { ...this.st });
            }
            if (!changed) break;
        }
        this.dry = false;
    }
    mergeState(a, entryState) {
        const preds = this.cfg.preds.get(a).filter((p) => this.outState.has(p)).map((p) => this.outState.get(p));
        if (a === this.f.entry) preds.push(entryState);
        if (!preds.length) return { L: 0, G: (1 << 14) - 1 };
        let L = 0, G = 0;
        for (let s = 0; s < 14; s++) {
            const bit = 1 << s;
            const Lall = preds.every((p) => p.L & bit), Lany = preds.some((p) => p.L & bit), Gall = preds.every((p) => p.G & bit);
            const hoist = s < 8 ? (this.liveIn.get(a) & bit) !== 0 : s === S_BUD;
            if (Lall || (Lany && hoist)) { L |= bit; if (Gall) G |= bit; }
            else G |= bit;
        }
        return { L, G };
    }
    edgeFixup(from, to) {
        if (this.o.abi !== "b") return;
        const c = this.c;
        for (const s of this.slotsUsed) {
            const bit = 1 << s;
            if ((to.L & bit) && !(from.L & bit)) c.gget(G_SLOT + s).set(this.slotLocal.get(s));
            if ((to.G & bit) && !(from.G & bit)) c.get(this.slotLocal.get(s)).gset(G_SLOT + s);
        }
    }

    // ---------------------------------------------------------------- slot access
    rd(s) {
        const c = this.c, l = this.slotLocal.get(s);
        if (this.o.abi === "b" && !(this.st.L & (1 << s))) { c.gget(G_SLOT + s).tee(l); this.st.L |= 1 << s; return; }
        c.get(l);
    }
    wr(s) { this.c.set(this.slotLocal.get(s)); if (this.o.abi === "b") { this.st.L |= 1 << s; this.st.G &= ~(1 << s); } }
    syncAll() {
        if (this.o.abi !== "b") return;
        for (const s of this.slotsUsed) { const bit = 1 << s; if ((this.st.L & bit) && !(this.st.G & bit)) { this.c.get(this.slotLocal.get(s)).gset(G_SLOT + s); this.st.G |= bit; } }
    }
    brTo(pred) {
        for (let i = this.frames.length - 1; i >= 0; i--) if (pred(this.frames[i])) return this.frames.length - 1 - i;
        throw Error("no frame");
    }
    push(fr) { this.frames.push(fr); }
    pop() { this.frames.pop(); }

    // exit site: materialise, then leave. Never changes the fall-through state.
    exitSite(eip, reason, budgetAdj = 0, eipFromLocal = -1) {
        const c = this.c, o = this.o;
        const saved = this.st ? { ...this.st } : null;
        if (o.retired && budgetAdj) { this.rd(S_BUD); c.i32(budgetAdj).op(OP.i32_add); this.wr(S_BUD); }
        this.syncAll();
        // x87 registers are part of the state at an observation point (cold path only)
        if (this.hasFpu && o.retcheck && !this.fpuBad && this.cur && this.fdepth.has(this.cur.addr)) {
            for (let i = 0; i < 8; i++) c.get(this.L_ST[i]).gset(G_ST + i);
            c.i32(this.fdepth.get(this.cur.addr)).gset(G_FDEPTH);
        }
        if (eipFromLocal >= 0) c.get(eipFromLocal).set(this.L_XEIP); else c.i32(eip).set(this.L_XEIP);
        c.i32(reason).gset(G_REASON);
        if (!o.retcheck) { c.get(this.L_XEIP).gset(G_EIP).op(OP.unreachable); }
        else c.br(this.brTo((f) => f.k === "exit"));
        if (saved) this.st = saved;
    }

    // ---------------------------------------------------------------- function
    emitFunction() {
        const { c, o, f, cfg } = this;
        this.frames = [];
        if (o.abi === "b") this.st = { ...this.inState.get(f.entry) };
        c.block(); this.push({ k: "exit" });
        const sharedFault = o.guard && o.abi === "a";
        if (sharedFault) { c.block(); this.push({ k: "fault" }); }
        if (o.retcheck) {
            if (o.abi === "a") c.get(this.L_DEPTH).i32(o.depthCap).op(OP.i32_gt_u).hint(0).if_();
            else c.gget(G_DEPTH).i32(1).op(OP.i32_add).tee(this.L_DEPTHB).gset(G_DEPTH).get(this.L_DEPTHB).i32(o.depthCap).op(OP.i32_gt_u).hint(0).if_();
            this.push({ k: "if" }); this.exitSite(f.entry, R.DEPTH); this.pop(); c.end();
        }
        if (cfg.irreducible || this.fpuBad) { this.exitSite(f.entry, R.UNSUP); }
        else {
            if (o.abi === "b") this.st = { ...this.inState.get(f.entry) };
            this.doTree(f.entry);
        }
        if (sharedFault) {
            c.end(); this.pop();
            if (this.hasFpu && !this.fpuBad) for (let i = 0; i < 8; i++) c.get(this.L_ST[i]).gset(G_ST + i);
            if (o.retcheck) c.i32(SENT).set(this.L_XEIP); else c.op(OP.unreachable);
        }
        c.end(); this.pop();
        // shared exit (only reachable with retcheck)
        if (o.retcheck) {
            c.get(this.L_XEIP).i32(SENT).op(OP.i32_ne).if_().get(this.L_XEIP).gset(G_EIP).end();
            if (o.abi === "a") {
                for (const s of this.slotsUsed) c.get(this.slotLocal.get(s)).gset(G_SLOT + s);
                for (const s of this.slotsUsed) c.get(this.slotLocal.get(s));
            }
            c.i32(SENT).op(OP.return);
        } else c.op(OP.unreachable);
    }

    // ---------------------------------------------------------------- stackifier
    doTree(x) {
        const { cfg, c } = this;
        const ys = cfg.domChildren.get(x).filter((y) => cfg.merge.has(y)).sort((a, b) => cfg.rpo.get(b) - cfg.rpo.get(a));
        if (cfg.loopHeaders.has(x)) { c.loop(); this.push({ k: "loop", head: x }); this.nodeWithin(x, ys); this.pop(); c.end(); }
        else this.nodeWithin(x, ys);
    }
    nodeWithin(x, ys) {
        const c = this.c;
        if (!ys.length) {
            if (this.o.abi === "b") this.st = { ...this.inState.get(x) };
            this.emitBlockBody(x, false);
            return;
        }
        const [y0, ...rest] = ys;
        c.block(); this.push({ k: "block", follow: y0 });
        this.nodeWithin(x, rest);
        this.pop(); c.end();
        this.doTree(y0);
    }
    doBranch(src, tgt) {
        const { cfg, c, o } = this;
        if (this.dry) return;
        const saved = this.st ? { ...this.st } : null;
        if (o.abi === "b") this.edgeFixup(this.st, this.inState.get(tgt));
        if (cfg.rpo.get(tgt) <= cfg.rpo.get(src)) {
            if (o.retired) {
                if (o.abi === "b") this.st = { ...this.inState.get(tgt) };
                this.rd(S_BUD); c.i32(0).op(OP.i32_lt_s).hint(0).if_(); this.push({ k: "if" }); this.exitSite(tgt, R.BUDGET); this.pop(); c.end();
            }
            c.br(this.brTo((f) => f.k === "loop" && f.head === tgt));
        } else if (cfg.merge.has(tgt)) c.br(this.brTo((f) => f.k === "block" && f.follow === tgt));
        else { if (o.abi === "b") this.st = { ...this.inState.get(tgt) }; this.doTree(tgt); }
        if (saved) this.st = saved;
    }

    // ---------------------------------------------------------------- block body
    emitBlockBody(a, dry) {
        const { f, o, c } = this;
        const b = f.blocks.get(a);
        this.dry = dry;
        if (o.profile && !dry) {
            const id = this.profMap.length;
        if (PROF_BASE + id >= CODEPAGES) throw Error("profile area full");
            this.profMap.push(f.entry + ":" + a);
            c.i32(id).i32(1).mem(OP.i32_store8, 0, PROF_BASE);
        }
        if (!dry) { this.stats.emittedBlocks++; for (const i of b.ins) { this.stats.x86BytesEmitted += i.len; this.stats.insEmitted++; } }
        let seg = 0; // instructions not yet charged to the budget
        const charge = () => { if (o.retired && seg) { this.rd(S_BUD); c.i32(seg).op(OP.i32_sub); this.wr(S_BUD); } seg = 0; };
        const n = b.ins.length;
        for (let k = 0; k < n; k++) {
            const ins = b.ins[k];
            this.tmpTop = 0;
            this.cur = ins;
            const last = k === n - 1;
            if (last && (b.term.k !== "jmp" || !b.term.fall)) break; // terminator handled below
            seg++;
            if (ins.m === "call" || ins.m === "callind" || ins.m === "in" || ins.m === "out") { charge(); }
            this.lowerIns(ins);
        }
        // terminator
        const term = b.term;
        const lastIns = b.ins[n - 1];
        this.tmpTop = 0;
        this.cur = lastIns;
        if (term.k === "jmp" && term.fall) { charge(); this.doBranch(a, b.succ[0]); return; }
        if (term.k === "exit") {
            if (term.cold) { this.exitSite(term.eip, R.COLD); return; }
            charge();
            this.exitSite(term.eip, R.UNSUP, 0);
            return;
        }
        seg++;
        switch (term.k) {
            case "jmp": charge(); this.doBranch(a, b.succ[0]); return;
            case "jcc": {
                charge();
                this.cond(lastIns);
                if (this.dry) return;
                c.if_(); this.push({ k: "if" });
                this.doBranch(a, b.succ[0]);
                c.else_();
                this.doBranch(a, b.succ[1]);
                this.pop(); c.end();
                return;
            }
            case "ret": {
                charge();
                this.memRead(lastIns, { k: "m", base: 4, idx: -1, sc: 1, disp: 0, sz: 32 }, false);
                this.c.set(this.L_POP);
                this.rd(4); c.i32(4 + term.pop).op(OP.i32_add); this.wr(4);
                this.emitReturn();
                return;
            }
            case "tail": {
                charge();
                const T = term.target;
                if (!this.fidx.has(T) || this.isColdFunc(T)) { this.exitSite(T, R.COLD); return; }
                if (o.retired) { this.rd(S_BUD); c.i32(0).op(OP.i32_lt_s).hint(0).if_(); this.push({ k: "if" }); this.exitSite(lastIns.addr, R.BUDGET, 1); this.pop(); c.end(); }
                if (o.abi === "a") { for (const s of this.slotsUsed) this.rd(s); if (o.retcheck) c.get(this.L_DEPTH); }
                else { this.syncAll(); if (o.retcheck) c.gget(G_DEPTH).i32(1).op(OP.i32_sub).gset(G_DEPTH); }
                c.return_call(this.fidx.get(T));
                return;
            }
            case "table": {
                charge();
                const jt = term.jt;
                const tI = this.tmp();
                this.rd(jt.r); c.set(tI);
                // read the entry the guest would read (checked form only)
                let tV = -1;
                if (o.retcheck) {
                    tV = this.tmp();
                    c.get(tI).i32(term.jt.targets.length).op(OP.i32_ge_u).hint(0).if_(); this.push({ k: "if" }); this.exitSite(lastIns.addr, R.TABLE, 1); this.pop(); c.end();
                    this.memRead(lastIns, { k: "m", base: -1, idx: jt.r, sc: 4, disp: jt.T | 0, sz: 32 }, false);
                    c.set(tV);
                }
                if (this.dry) return;
                const uniq = term.uniq;
                const caseOf = jt.targets.map((t) => uniq.indexOf(t));
                for (let i = 0; i <= uniq.length; i++) { c.block(); this.push({ k: "anon" }); }
                c.get(tI).br_table(caseOf, uniq.length);
                for (let i = 0; i < uniq.length; i++) {
                    c.end(); this.pop();
                    if (o.retcheck) { c.get(tV).i32(uniq[i]).op(OP.i32_ne).hint(0).if_(); this.push({ k: "if" }); this.exitSite(lastIns.addr, R.TABLE, 1); this.pop(); c.end(); }
                    this.doBranch(a, uniq[i]);
                }
                c.end(); this.pop();
                this.exitSite(lastIns.addr, R.TABLE, 1);
                return;
            }
            case "hlt": charge(); c.call(this.F_HALT).op(OP.unreachable); return;
            default: throw Error("term " + term.k);
        }
    }

    emitReturn() {
        const { c, o } = this;
        if (o.abi === "a") { for (const s of this.slotsUsed) this.rd(s); }
        else { this.syncAll(); if (o.retcheck) c.gget(G_DEPTH).i32(1).op(OP.i32_sub).gset(G_DEPTH); }
        if (o.retcheck) c.get(this.L_POP);
        c.op(OP.return);
    }

    // ---------------------------------------------------------------- memory
    // Leaves the HOST address on the stack and returns the memarg offset to use.
    addrHost(ins, mo, write) {
        const { c, o } = this;
        // stackFree (ceiling ablation, NOT sound as built): esp/ebp-based accesses skip the probe —
        // the upper bound of a once-per-frame stack guard.
        if (!o.guard || (o.stackFree && (mo.base === 4 || mo.base === 5 || mo.stack))) {
            if (mo.base === -2) { c.get(mo.local); return MEMBASE; }
            // F0: direct access, displacement folded into the memarg offset when non-negative
            const fold = mo.disp >= 0 && (mo.base >= 0 || mo.idx >= 0);
            this.ea(mo, !fold);
            if (mo.base < 0 && mo.idx < 0) return MEMBASE; // ea pushed the absolute disp
            return fold ? MEMBASE + mo.disp : MEMBASE;
        }
        this.stats.guards++;
        const tA = this.tmp(), tE = this.tmp();
        this.ea(mo, true); c.set(tA);
        const bytes = mo.sz >>> 3;
        c.block(); this.push({ k: "anon" });
        c.get(tA).i32(12).op(OP.i32_shr_u).i32(2).op(OP.i32_shl).mem(OP.i32_load, 2, TLB_BASE).tee(tE);
        c.i32(write ? WRITE_MASK : READ_MASK).op(OP.i32_and).i32(TLB_VALID).op(OP.i32_eq);
        if (bytes > 1) c.get(tA).i32(0xfff).op(OP.i32_and).i32(0x1000 - bytes).op(OP.i32_le_s).op(OP.i32_and);
        c.hint(1).br_if(0);
        c.get(tA).i32(ins.addr).call(this.fillFns[write ? "w" : "r"]).tee(tE).i32(1).op(OP.i32_and);
        if (this.o.abi === "a") {
            // like v86's exit_with_fault_label: one shared exit per function; the slow helper
            // already recorded EIP and the reason
            c.hint(0).br_if(this.brTo((f) => f.k === "fault"));
        } else { c.hint(0).if_(); this.push({ k: "if" }); this.exitSite(ins.addr, R.FAULT); this.pop(); c.end(); }
        this.pop(); c.end();
        c.get(tE).i32(~0xfff).op(OP.i32_and).get(tA).op(OP.i32_xor);
        return 0;
    }
    ea(mo, withDisp) {
        const c = this.c;
        let have = false;
        if (mo.base >= 0) { this.rd(mo.base); have = true; }
        if (mo.idx >= 0) { this.rd(mo.idx); if (mo.sc > 1) c.i32(Math.log2(mo.sc)).op(OP.i32_shl); if (have) c.op(OP.i32_add); have = true; }
        if (!have) { c.i32(mo.disp); return; }
        if (withDisp && mo.disp) c.i32(mo.disp).op(OP.i32_add);
    }
    loadOp(sz, signed) { return sz === 8 ? (signed ? OP.i32_load8_s : OP.i32_load8_u) : sz === 16 ? (signed ? OP.i32_load16_s : OP.i32_load16_u) : OP.i32_load; }
    storeOp(sz) { return sz === 8 ? OP.i32_store8 : sz === 16 ? OP.i32_store16 : OP.i32_store; }
    memRead(ins, mo, signed) { const off = this.addrHost(ins, mo, false); this.c.mem(this.loadOp(mo.sz, signed), 0, off); }
    /** value(): pushes the value. */
    memWrite(ins, mo, value) { const off = this.addrHost(ins, mo, true); value(); this.c.mem(this.storeOp(mo.sz), 0, off); }

    // ---------------------------------------------------------------- operands
    regRead(op) {
        const c = this.c;
        if (op.sz === 32) { this.rd(op.r); return; }
        if (op.sz === 16) { this.rd(op.r); c.i32(0xffff).op(OP.i32_and); return; }
        if (op.r < 4) { this.rd(op.r); c.i32(0xff).op(OP.i32_and); return; }
        this.rd(op.r - 4); c.i32(8).op(OP.i32_shr_u).i32(0xff).op(OP.i32_and);
    }
    regWrite(op, tV) {
        const c = this.c;
        if (op.sz === 32) { c.get(tV); this.wr(op.r); return; }
        if (op.sz === 16) { this.rd(op.r); c.i32(0xffff0000 | 0).op(OP.i32_and).get(tV).i32(0xffff).op(OP.i32_and).op(OP.i32_or); this.wr(op.r); return; }
        if (op.r < 4) { this.rd(op.r); c.i32(~0xff).op(OP.i32_and).get(tV).i32(0xff).op(OP.i32_and).op(OP.i32_or); this.wr(op.r); return; }
        this.rd(op.r - 4); c.i32(~0xff00).op(OP.i32_and).get(tV).i32(0xff).op(OP.i32_and).i32(8).op(OP.i32_shl).op(OP.i32_or); this.wr(op.r - 4);
    }
    val(op, signed = false) {
        if (op.k === "i") { this.c.i32(op.v); return; }
        if (op.k === "r") { this.regRead(op); if (signed && op.sz < 32) this.c.op(op.sz === 8 ? OP.i32_extend8_s : OP.i32_extend16_s); return; }
        this.memRead(this.cur, op, signed);
    }
    /** read-modify-write of dst: compute(tOld) must push the new value (or return false = no write). */
    rmw(op, compute) {
        const c = this.c;
        if (op.k === "r") {
            const tO = this.tmp(); this.regRead(op); c.set(tO);
            const tN = this.tmp();
            if (compute(tO) === false) return;
            c.set(tN); this.regWrite(op, tN);
            return;
        }
        const tH = this.tmp();
        const off = this.addrHost(this.cur, op, true);
        c.set(tH);
        const tO = this.tmp();
        c.get(tH).mem(this.loadOp(op.sz, false), 0, off).set(tO);
        const tN = this.tmp();
        if (compute(tO) === false) return;
        c.set(tN);
        c.get(tH).get(tN).mem(this.storeOp(op.sz), 0, off);
    }
    store(op, tV) {
        if (op.k === "r") { this.regWrite(op, tV); return; }
        this.memWrite(this.cur, op, () => this.c.get(tV));
    }

    // ---------------------------------------------------------------- flags (producer side)
    // a/b/r: locals holding zero-extended operands / raw 32-bit result (upper bits may be junk)
    flagDef(ins, kind, sz, a, b, r, extra = {}) {
        const c = this.c, o = this.o;
        const k = 32 - sz;
        const norm = (l) => { c.get(l); if (k) c.i32(k).op(OP.i32_shl); };
        const mask = sz === 32 ? -1 : (1 << sz) - 1;
        const fused = this.fusedProducers.has(ins.addr);
        if (fused) {
            switch (kind) {
                case "sub": case "add": norm(a); c.set(this.L_FA); norm(b); c.set(this.L_FB); norm(r); c.set(this.L_FR); break;
                case "neg": c.i32(0).set(this.L_FA); norm(a); c.set(this.L_FB); norm(r); c.set(this.L_FR); break;
                case "logic": norm(r); c.set(this.L_FR); break;
                case "inc": case "dec": norm(a); c.set(this.L_FA); norm(r); c.set(this.L_FR); break;
                case "shl": case "shr": case "sar": case "rot":
                    norm(r); c.set(this.L_FR);
                    c.get(extra.cf).set(this.L_FB); c.get(extra.of).set(this.L_FA); break;
                case "mul": c.get(extra.ovf).set(this.L_FB); c.get(extra.ovf).set(this.L_FA); break;
                default: throw Error("fused kind " + kind);
            }
        }
        if (!o.lazy) return;
        const m = (l) => { c.get(l); if (mask !== -1) c.i32(mask).op(OP.i32_and); };
        const setS = (s, emit) => { emit(); this.wr(s); };
        switch (kind) {
            case "add": case "sub":
                setS(S_OP1, () => m(a)); setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1));
                setS(S_CHG, () => c.i32(kind === "sub" ? FLAGS_ALL | FLAG_SUB : FLAGS_ALL)); break;
            case "neg":
                setS(S_OP1, () => c.i32(0)); setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1)); setS(S_CHG, () => c.i32(FLAGS_ALL | FLAG_SUB)); break;
            case "inc": case "dec":
                setS(S_FLG, () => { this.rd(S_FLG); c.i32(~1).op(OP.i32_and); this.getCF(); c.op(OP.i32_or); });
                setS(S_OP1, () => m(a)); setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1));
                setS(S_CHG, () => c.i32(kind === "dec" ? (FLAGS_ALL & ~1) | FLAG_SUB : FLAGS_ALL & ~1)); break;
            case "logic":
                setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1)); setS(S_CHG, () => c.i32(FLAGS_ALL & ~1 & ~0x10 & ~0x800));
                setS(S_FLG, () => { this.rd(S_FLG); c.i32(~(1 | 0x10 | 0x800)).op(OP.i32_and); }); break;
            case "shl": case "shr": case "sar":
                setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1)); setS(S_CHG, () => c.i32(FLAGS_ALL & ~1 & ~0x800));
                setS(S_FLG, () => { this.rd(S_FLG); c.i32(~0x801).op(OP.i32_and).get(extra.cf).op(OP.i32_or).get(extra.of).i32(11).op(OP.i32_shl).op(OP.i32_or); }); break;
            case "rot":
                setS(S_CHG, () => { this.rd(S_CHG); c.i32(~0x801).op(OP.i32_and); });
                setS(S_FLG, () => { this.rd(S_FLG); c.i32(~0x801).op(OP.i32_and).get(extra.cf).op(OP.i32_or).get(extra.of).i32(11).op(OP.i32_shl).op(OP.i32_or); }); break;
            case "mul":
                setS(S_RES, () => m(r)); setS(S_SIZE, () => c.i32(sz - 1)); setS(S_CHG, () => c.i32(FLAGS_ALL & ~1 & ~0x800));
                setS(S_FLG, () => { this.rd(S_FLG); c.i32(~0x801).op(OP.i32_and).get(extra.ovf).i32(0x801).op(OP.i32_mul).op(OP.i32_or); }); break;
            default: throw Error("lazy kind " + kind);
        }
    }

    // ---------------------------------------------------------------- flags (consumer side)
    cond(ins, ccOverride) {
        const c = this.c;
        const cc = ccOverride ?? flagUse(ins);
        const info = this.consumer.get(ins.addr);
        const base = cc & ~1;
        if (!info || info.mode === "bad") {
            // unresolved without lazy flags: honest exit (counted in stats)
            this.exitSite(ins.addr, R.FLAGS);
            c.i32(0);
        } else if (info.mode === "fused") this.condFused(info.kind, base, info.size);
        else this.condLazy(base);
        if (cc & 1) c.op(OP.i32_eqz);
    }
    condFused(kind, base, sz) {
        const c = this.c, A = this.L_FA, B = this.L_FB, Rr = this.L_FR;
        const MIN = 0x80000000 | 0;
        const zf = () => c.get(Rr).op(OP.i32_eqz);
        const sf = () => c.get(Rr).i32(0).op(OP.i32_lt_s);
        if (base === 10) { // parity of the low byte of the (un-normalised) result
            c.get(Rr).i32(32 - sz).op(OP.i32_shr_u).i32(0xff).op(OP.i32_and).op(OP.i32_popcnt).i32(1).op(OP.i32_and).op(OP.i32_eqz);
            return;
        }
        switch (kind) {
            case "sub": case "neg":
                switch (base) {
                    case 0: c.get(A).get(B).op(OP.i32_xor).get(A).get(Rr).op(OP.i32_xor).op(OP.i32_and).i32(0).op(OP.i32_lt_s); return;
                    case 2: c.get(A).get(B).op(OP.i32_lt_u); return;
                    case 4: zf(); return;
                    case 6: c.get(A).get(B).op(OP.i32_le_u); return;
                    case 8: sf(); return;
                    case 12: c.get(A).get(B).op(OP.i32_lt_s); return;
                    case 14: c.get(A).get(B).op(OP.i32_le_s); return;
                }
                break;
            case "add": {
                const of = () => c.get(A).get(Rr).op(OP.i32_xor).get(B).get(Rr).op(OP.i32_xor).op(OP.i32_and).i32(0).op(OP.i32_lt_s);
                switch (base) {
                    case 0: of(); return;
                    case 2: c.get(Rr).get(A).op(OP.i32_lt_u); return;
                    case 4: zf(); return;
                    case 6: c.get(Rr).get(A).op(OP.i32_lt_u); zf(); c.op(OP.i32_or); return;
                    case 8: sf(); return;
                    case 12: sf(); of(); c.op(OP.i32_xor); return;
                    case 14: sf(); of(); c.op(OP.i32_xor); zf(); c.op(OP.i32_or); return;
                }
                break;
            }
            case "logic":
                switch (base) {
                    case 0: case 2: c.i32(0); return;
                    case 4: case 6: zf(); return;
                    case 8: case 12: sf(); return;
                    case 14: c.get(Rr).i32(0).op(OP.i32_le_s); return;
                }
                break;
            case "inc": case "dec": {
                const of = () => (kind === "inc" ? c.get(Rr).i32(MIN).op(OP.i32_eq) : c.get(A).i32(MIN).op(OP.i32_eq));
                switch (base) {
                    case 0: of(); return;
                    case 4: zf(); return;
                    case 8: sf(); return;
                    case 12: sf(); of(); c.op(OP.i32_xor); return;
                    case 14: sf(); of(); c.op(OP.i32_xor); zf(); c.op(OP.i32_or); return;
                }
                break;
            }
            case "shl": case "shr": case "sar": case "rot":
                switch (base) {
                    case 0: c.get(A); return;
                    case 2: c.get(B); return;
                    case 4: zf(); return;
                    case 6: c.get(B); zf(); c.op(OP.i32_or); return;
                    case 8: sf(); return;
                    case 12: sf(); c.get(A).op(OP.i32_xor); return;
                    case 14: sf(); c.get(A).op(OP.i32_xor); zf(); c.op(OP.i32_or); return;
                }
                break;
            case "mul":
                if (base === 0 || base === 2) { c.get(B); return; }
                break;
        }
        throw Error(`fused ${kind} cc${base}`);
    }
    // v86 getters (misc_instr.rs), inline with select
    getCF() {
        const c = this.c;
        this.rd(S_RES); this.rd(S_CHG); c.i32(31).op(OP.i32_shr_s).op(OP.i32_xor); this.rd(S_OP1); this.rd(S_CHG); c.i32(31).op(OP.i32_shr_s).op(OP.i32_xor).op(OP.i32_lt_u);
        this.rd(S_FLG); c.i32(1).op(OP.i32_and);
        this.rd(S_CHG); c.i32(1).op(OP.i32_and).op(OP.select);
    }
    getZF() {
        const c = this.c;
        this.rd(S_RES); c.i32(-1).op(OP.i32_xor); this.rd(S_RES); c.i32(1).op(OP.i32_sub).op(OP.i32_and); this.rd(S_SIZE); c.op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_FLG); c.i32(6).op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_CHG); c.i32(0x40).op(OP.i32_and).op(OP.select);
    }
    getSF() {
        const c = this.c;
        this.rd(S_RES); this.rd(S_SIZE); c.op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_FLG); c.i32(7).op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_CHG); c.i32(0x80).op(OP.i32_and).op(OP.select);
    }
    getOF() {
        const c = this.c;
        this.rd(S_OP1); this.rd(S_RES); c.op(OP.i32_xor);
        this.rd(S_RES); this.rd(S_OP1); c.op(OP.i32_sub); this.rd(S_CHG); c.i32(31).op(OP.i32_shr_u).op(OP.i32_sub); this.rd(S_RES); c.op(OP.i32_xor);
        c.op(OP.i32_and); this.rd(S_SIZE); c.op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_FLG); c.i32(11).op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_CHG); c.i32(0x800).op(OP.i32_and).op(OP.select);
    }
    getPF() {
        const c = this.c;
        c.i32(0x9669 << 2); this.rd(S_RES); this.rd(S_RES); c.i32(4).op(OP.i32_shr_u).op(OP.i32_xor).i32(15).op(OP.i32_and).op(OP.i32_shr_u).i32(4).op(OP.i32_and).i32(0).op(OP.i32_ne);
        this.rd(S_FLG); c.i32(2).op(OP.i32_shr_u).i32(1).op(OP.i32_and);
        this.rd(S_CHG); c.i32(4).op(OP.i32_and).op(OP.select);
    }
    condLazy(base) {
        const c = this.c;
        switch (base) {
            case 0: this.getOF(); return;
            case 2: this.getCF(); return;
            case 4: this.getZF(); return;
            case 6: this.getCF(); this.getZF(); c.op(OP.i32_or); return;
            case 8: this.getSF(); return;
            case 10: this.getPF(); return;
            case 12: this.getSF(); this.getOF(); c.op(OP.i32_xor); return;
            case 14: this.getSF(); this.getOF(); c.op(OP.i32_xor); this.getZF(); c.op(OP.i32_or); return;
        }
    }

    // ---------------------------------------------------------------- instructions
    lowerIns(ins) {
        const { c, o } = this;
        const mut = o.mutate === ins.addr;
        switch (ins.m) {
            case "nop": case "pause": return;
            case "mov": {
                const tV = this.tmp(); this.val(ins.src); c.set(tV); this.store(ins.dst, tV); return;
            }
            case "movzx": case "movsx": {
                const tV = this.tmp(); this.val(ins.src, ins.m === "movsx"); c.set(tV);
                if (ins.dst.sz === 16) { c.get(tV).i32(0xffff).op(OP.i32_and).set(tV); }
                this.regWrite(ins.dst, tV); return;
            }
            case "lea": { const tV = this.tmp(); this.ea(ins.src, true); c.set(tV); this.regWrite(ins.dst, tV); return; }
            case "alu": case "test": {
                const a = ins.m === "test" ? "and" : ins.a;
                const sz = ins.dst.sz;
                const kind = ins.m === "test" ? "logic" : flagKind(ins);
                const needsCF = a === "adc" || a === "sbb";
                const write = ins.m !== "test" && a !== "cmp";
                const tB = this.tmp();
                // xor r,r / sub r,r: no read needed
                if (write && (a === "xor" || a === "sub") && ins.dst.k === "r" && ins.src.k === "r" && ins.src.r === ins.dst.r && sz === 32) {
                    const tZ = this.tmp(); c.i32(0).set(tZ); c.i32(0).set(tB);
                    this.flagDef(ins, kind, sz, tZ, tZ, tZ);
                    this.regWrite(ins.dst, tZ); return;
                }
                const tCF = needsCF ? this.tmp() : -1;
                if (needsCF) { this.cond(ins, 2); c.set(tCF); }
                if (ins.src.k === "i" && ins.src.sz === 8 && sz > 8) { c.i32(ins.src.v).set(tB); } else { this.val(ins.src); c.set(tB); }
                const compute = (tA) => {
                    const tR = this.tmp();
                    c.get(tA).get(tB);
                    const opc = { add: OP.i32_add, adc: OP.i32_add, sub: OP.i32_sub, cmp: OP.i32_sub, sbb: OP.i32_sub, and: OP.i32_and, or: OP.i32_or, xor: OP.i32_xor }[a];
                    c.op(opc);
                    if (needsCF) c.get(tCF).op(a === "adc" ? OP.i32_add : OP.i32_sub);
                    if (mut) c.i32(1).op(OP.i32_xor);
                    c.set(tR);
                    if (needsCF) { if (this.fusedProducers.has(ins.addr) || o.lazy) this.adcFlags(ins, a, sz, tA, tB, tR, tCF); }
                    else this.flagDef(ins, kind, sz, tA, tB, tR);
                    if (!write) return false;
                    c.get(tR);
                };
                if (write) this.rmw(ins.dst, compute);
                else { const tA = this.tmp(); this.val(ins.dst); c.set(tA); compute(tA); }
                return;
            }
            case "inc": case "dec": case "neg": case "not": {
                const sz = ins.dst.sz;
                this.rmw(ins.dst, (tA) => {
                    const tR = this.tmp();
                    if (ins.m === "inc") c.get(tA).i32(1).op(OP.i32_add);
                    else if (ins.m === "dec") c.get(tA).i32(1).op(OP.i32_sub);
                    else if (ins.m === "neg") c.i32(0).get(tA).op(OP.i32_sub);
                    else c.get(tA).i32(-1).op(OP.i32_xor);
                    c.set(tR);
                    if (ins.m !== "not") this.flagDef(ins, ins.m, sz, tA, -1, tR);
                    c.get(tR);
                });
                return;
            }
            case "shift": return this.lowerShift(ins);
            case "imul2": case "imul3": {
                const tA = this.tmp(), tB = this.tmp();
                this.val(ins.src); c.set(tA);
                if (ins.m === "imul2") { this.regRead(ins.dst); c.set(tB); } else c.i32(ins.imm.v).set(tB);
                if (ins.dst.sz !== 32) throw Error("imul16");
                const tR = this.tmp();
                c.get(tA).get(tB).op(OP.i32_mul).set(tR);
                if (this.fusedProducers.has(ins.addr) || o.lazy) {
                    const tO = this.tmp();
                    c.get(tA).op(OP.i64_extend_i32_s).get(tB).op(OP.i64_extend_i32_s).op(OP.i64_mul).get(tR).op(OP.i64_extend_i32_s).op(OP.i64_ne).set(tO);
                    this.flagDef(ins, "mul", 32, tA, tB, tR, { ovf: tO });
                }
                this.regWrite(ins.dst, tR); return;
            }
            case "mul1": case "imul1": {
                if (ins.src.sz !== 32) throw Error("mul8/16");
                const tA = this.tmp(); this.val(ins.src); c.set(tA);
                const ext = ins.m === "mul1" ? OP.i64_extend_i32_u : OP.i64_extend_i32_s;
                this.rd(0); c.op(ext).get(tA).op(ext).op(OP.i64_mul).set(this.L_I64);
                const tL = this.tmp(), tH = this.tmp();
                c.get(this.L_I64).op(OP.i32_wrap_i64).set(tL);
                c.get(this.L_I64).i64(32).op(OP.i64_shr_u).op(OP.i32_wrap_i64).set(tH);
                if (this.fusedProducers.has(ins.addr) || o.lazy) {
                    const tO = this.tmp();
                    if (ins.m === "mul1") c.get(tH).i32(0).op(OP.i32_ne).set(tO);
                    else c.get(tH).get(tL).i32(31).op(OP.i32_shr_s).op(OP.i32_ne).set(tO);
                    this.flagDef(ins, "mul", 32, tA, tA, tL, { ovf: tO });
                }
                c.get(tL); this.wr(0); c.get(tH); this.wr(2); return;
            }
            case "div": case "idiv": {
                if (ins.src.sz !== 32) throw Error("div8/16");
                const tA = this.tmp(); this.val(ins.src); c.set(tA);
                this.rd(2); c.op(OP.i64_extend_i32_u).i64(32).op(OP.i64_shl); this.rd(0); c.op(OP.i64_extend_i32_u).op(OP.i64_or).set(this.L_I64);
                const ext = ins.m === "div" ? OP.i64_extend_i32_u : OP.i64_extend_i32_s;
                c.get(tA).op(ext).set(this.L_I64B);
                c.get(this.L_I64).get(this.L_I64B).op(ins.m === "div" ? OP.i64_div_u : OP.i64_div_s).op(OP.i32_wrap_i64);
                const tQ = this.tmp(); c.set(tQ);
                c.get(this.L_I64).get(this.L_I64B).op(ins.m === "div" ? OP.i64_rem_u : OP.i64_rem_s).op(OP.i32_wrap_i64); this.wr(2);
                c.get(tQ); this.wr(0); return;
            }
            case "cdq": this.rd(0); c.i32(31).op(OP.i32_shr_s); this.wr(2); return;
            case "cwde": this.rd(0); c.op(OP.i32_extend16_s); this.wr(0); return;
            case "setcc": {
                const tV = this.tmp(); this.cond(ins); c.set(tV); this.store(ins.dst, tV); return;
            }
            case "cmov": {
                const tS = this.tmp(); this.val(ins.src); c.set(tS);
                const tV = this.tmp();
                c.get(tS); this.regRead(ins.dst); this.cond(ins); c.op(OP.select).set(tV);
                this.regWrite(ins.dst, tV); return;
            }
            case "bswap": {
                const tV = this.tmp(); this.rd(ins.dst.r); c.set(tV);
                c.get(tV).i32(0xff00ff00 | 0).op(OP.i32_and).i32(8).op(OP.i32_rotl).get(tV).i32(0x00ff00ff).op(OP.i32_and).i32(8).op(OP.i32_rotr).op(OP.i32_or);
                this.wr(ins.dst.r); return;
            }
            case "push": {
                if (ins.os !== 32) throw Error("push16");
                const tV = this.tmp(); this.val(ins.src); c.set(tV);
                const tS = this.tmp(); this.rd(4); c.i32(4).op(OP.i32_sub).set(tS);
                this.memWriteAt(ins, tS, tV);
                c.get(tS); this.wr(4); return;
            }
            case "pop": {
                const tV = this.tmp();
                this.memRead(ins, { k: "m", base: 4, idx: -1, sc: 1, disp: 0, sz: 32 }, false); c.set(tV);
                this.rd(4); c.i32(4).op(OP.i32_add); this.wr(4);
                this.store(ins.dst, tV); return;
            }
            case "leave": {
                this.rd(5); this.wr(4);
                const tV = this.tmp();
                this.memRead(ins, { k: "m", base: 4, idx: -1, sc: 1, disp: 0, sz: 32 }, false); c.set(tV);
                this.rd(4); c.i32(4).op(OP.i32_add); this.wr(4);
                c.get(tV); this.wr(5); return;
            }
            case "call": case "callind": return this.lowerCall(ins);
            case "fpu": return this.lowerFpu(ins);
            case "in": {
                if (ins.port >= 0) c.i32(ins.port); else { this.rd(2); c.i32(0xffff).op(OP.i32_and); }
                c.call(this.F_IN);
                const tV = this.tmp(); c.set(tV);
                this.regWrite({ k: "r", r: 0, sz: ins.sz }, tV); return;
            }
            case "out": {
                if (ins.port >= 0) c.i32(ins.port); else { this.rd(2); c.i32(0xffff).op(OP.i32_and); }
                this.regRead({ k: "r", r: 0, sz: ins.sz });
                if (o.retired) this.rd(S_BUD); else c.i32(0);
                c.call(this.F_OUT); return;
            }
            default:
                throw Error(`no lowering for ${ins.m} @${ins.addr.toString(16)}`);
        }
    }
    // ---------------------------------------------------------------- x87 (stage 2)
    // Static stack depth per instruction (function entry = 0, calls/returns need 0): ST(i) is
    // the f64 local L_ST[d-1-i]. Nothing is stored to an FPU state between observation points.
    fpuDataflow() {
        const { f, cfg } = this;
        const delta = (ins) => {
            switch (ins.f) {
                case "fld": case "fild": case "fldc": case "fldst": return 1;
                case "fst": case "fist": case "fstst": case "farith": case "fcom": return -(ins.pop || 0);
                default: return 0;
            }
        };
        const inD = new Map([[f.entry, 0]]);
        this.fdepth = new Map();
        const bad = (why) => { if (!this.fpuBad) { this.fpuBad = why; this.stats.x87UnsupFuncs = (this.stats.x87UnsupFuncs || 0) + 1; (this.stats.x87UnsupWhy ||= {})[why] = (this.stats.x87UnsupWhy[why] || 0) + 1; } };
        for (const a of cfg.rpoList) {
            if (!inD.has(a)) { bad("unreached depth"); return; }
            let d = inD.get(a);
            const b = f.blocks.get(a);
            for (const ins of b.ins) {
                this.fdepth.set(ins.addr, d);
                if (ins.m === "fpu") {
                    if (ins.f === "fninit") d = 0; else d += delta(ins);
                    if (d < 0 || d > 8) { bad("depth out of range"); return; }
                } else if ((ins.m === "call" || ins.m === "callind" || ins.m === "ret" || ins.m === "in" || ins.m === "out") && d !== 0) { bad("live x87 across " + ins.m); return; }
            }
            if (b.term.k === "tail" && d !== 0) { bad("live x87 across tail"); return; }
            for (const s of b.succ) {
                if (!inD.has(s)) inD.set(s, d);
                else if (inD.get(s) !== d) { bad("depth mismatch at merge"); return; }
            }
        }
    }
    lowerFpu(ins) {
        const c = this.c;
        if (this.fpuBad) throw Error("fpu in unsupported function");
        const d = this.fdepth.get(ins.addr);
        const ST = (i) => this.L_ST[d - 1 - i];
        const loadMem = (mo) => {
            const off = this.addrHost(ins, mo, false);
            switch (mo.ft) {
                case "f32": c.mem(OP.f32_load, 0, off).op(OP.f64_promote_f32); break;
                case "f64": c.mem(OP.f64_load, 0, off); break;
                case "i32": c.mem(OP.i32_load, 0, off).op(OP.f64_convert_i32_s); break;
                case "i16": c.mem(OP.i32_load16_s, 0, off).op(OP.f64_convert_i32_s); break;
                case "i64": c.mem(OP.i64_load, 0, off).op(OP.f64_convert_i64_s); break;
            }
        };
        switch (ins.f) {
            case "fld": case "fild": loadMem(ins.mem); c.set(this.L_ST[d]); return;
            case "fldst": c.get(ST(ins.i)).set(this.L_ST[d]); return;
            case "fldc": c.f64(ins.v).set(this.L_ST[d]); return;
            case "fst": {
                const off = this.addrHost(ins, ins.mem, true);
                c.get(ST(0));
                if (ins.mem.ft === "f32") c.op(OP.f32_demote_f64).mem(OP.f32_store, 0, off); else c.mem(OP.f64_store, 0, off);
                return;
            }
            case "fist": {
                const off = this.addrHost(ins, ins.mem, true);
                // rounding: fisttp truncates; fist/fistp use CW.RC (truncate or nearest-even)
                c.get(ST(0)).op(OP.f64_trunc);
                if (!ins.trunc) c.get(ST(0)).op(OP.f64_nearest).gget(G_FCW).i32(0xc00).op(OP.i32_and).i32(0xc00).op(OP.i32_eq).op(OP.select);
                if (ins.mem.ft === "i64") c.fc(6).mem(OP.i64_store, 0, off);
                else { c.fc(2).mem(ins.mem.ft === "i16" ? OP.i32_store16 : OP.i32_store, 0, off); }
                return;
            }
            case "fstst": c.get(ST(0)).set(ST(ins.i)); return;
            case "farith": {
                // dst = st0 (mem / D8 forms) or st(i) (DC/DE forms); src = mem, st(i) or st0
                const dst = ins.mem || ins.dst === 0 ? ST(0) : ST(ins.i);
                const src = () => { if (ins.mem) loadMem(ins.mem); else c.get(ins.dst === 0 ? ST(ins.i) : ST(0)); };
                const opc = { add: OP.f64_add, mul: OP.f64_mul, sub: OP.f64_sub, subr: OP.f64_sub, div: OP.f64_div, divr: OP.f64_div }[ins.op];
                if (ins.op === "subr" || ins.op === "divr") { const tS = this.L_FT; src(); c.set(tS); c.get(tS).get(dst).op(opc).set(dst); }
                else { c.get(dst); src(); c.op(opc).set(dst); }
                return;
            }
            case "fcom": {
                const tB = this.L_FT;
                if (ins.mem) loadMem(ins.mem); else c.get(ST(ins.i));
                c.set(tB);
                // C3 C2 C0: > 000, < 001, = 100, unordered 111
                c.i32(0x4500)
                    .get(ST(0)).get(tB).op(OP.f64_lt).i32(8).op(OP.i32_shl).get(ST(0)).get(tB).op(OP.f64_eq).i32(14).op(OP.i32_shl).op(OP.i32_or)
                    .get(ST(0)).get(ST(0)).op(OP.f64_ne).get(tB).get(tB).op(OP.f64_ne).op(OP.i32_or).op(OP.select).set(this.L_FSW);
                return;
            }
            case "fxch": c.get(ST(0)).set(this.L_FT).get(ST(ins.i)).set(ST(0)).get(this.L_FT).set(ST(ins.i)); return;
            case "fchs": c.get(ST(0)).op(OP.f64_neg).set(ST(0)); return;
            case "fabs": c.get(ST(0)).op(OP.f64_abs).set(ST(0)); return;
            case "fnstsw": {
                const tV = this.tmp();
                c.get(this.L_FSW).i32(((8 - d) & 7) << 11).op(OP.i32_or).set(tV);
                this.regWrite({ k: "r", r: 0, sz: 16 }, tV); return;
            }
            case "fnstcw": this.memWrite(ins, ins.mem, () => c.gget(G_FCW)); return;
            case "fldcw": this.memRead(ins, ins.mem, false); c.gset(G_FCW); return;
            case "fninit": c.i32(0x37f).gset(G_FCW).i32(0).set(this.L_FSW); return;
        }
        throw Error("fpu " + ins.f);
    }
    memWriteAt(ins, tAddr, tV) {
        // [tAddr] <- tV, 32-bit
        const c = this.c;
        const off = this.addrHostLocal(ins, tAddr, 4, true);
        c.get(tV).mem(OP.i32_store, 0, off);
    }
    addrHostLocal(ins, tAddr, bytes, write) {
        const c = this.c;
        if (!this.o.guard) { c.get(tAddr); return MEMBASE; }
        return this.addrHost(ins, { k: "m", base: -2, idx: -1, sc: 1, disp: 0, sz: bytes * 8, local: tAddr, stack: true }, write);
    }
    adcFlags(ins, a, sz, tA, tB, tR, tCF) {
        // only the lazy form; fused adc/sbb producers are not supported (counted as unresolved)
        if (!this.o.lazy) throw Error("adc/sbb flags consumed without lazy flags");
        const c = this.c, mask = sz === 32 ? -1 : (1 << sz) - 1;
        const sub = a === "sbb";
        // flags = flags & ~(CF|AF|OF) | CF | OF (v86 adc/sbb), changed = ALL & ~(CF|AF|OF)
        const tC = this.tmp(), tO = this.tmp();
        if (!sub) c.get(tA).get(tA).get(tB).op(OP.i32_xor).get(tB).get(tR).op(OP.i32_xor).op(OP.i32_and).op(OP.i32_xor).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tC);
        else c.get(tR).get(tR).get(tB).op(OP.i32_xor).get(tB).get(tA).op(OP.i32_xor).op(OP.i32_and).op(OP.i32_xor).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tC);
        if (!sub) c.get(tB).get(tR).op(OP.i32_xor).get(tA).get(tR).op(OP.i32_xor).op(OP.i32_and).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tO);
        else c.get(tB).get(tA).op(OP.i32_xor).get(tR).get(tA).op(OP.i32_xor).op(OP.i32_and).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tO);
        this.rd(S_FLG); c.i32(~(1 | 0x10 | 0x800)).op(OP.i32_and).get(tC).op(OP.i32_or).get(tO).i32(11).op(OP.i32_shl).op(OP.i32_or); this.wr(S_FLG);
        c.get(tA); if (mask !== -1) c.i32(mask).op(OP.i32_and); this.wr(S_OP1);
        c.get(tR); if (mask !== -1) c.i32(mask).op(OP.i32_and); this.wr(S_RES);
        c.i32(sz - 1); this.wr(S_SIZE);
        c.i32((FLAGS_ALL & ~1 & ~0x10 & ~0x800) | (sub ? FLAG_SUB : 0)); this.wr(S_CHG);
    }
    lowerShift(ins) {
        const c = this.c, o = this.o;
        const sz = ins.dst.sz;
        const a = ins.a;
        if (a === "rcl" || a === "rcr") throw Error("rcl/rcr");
        if ((a === "rol" || a === "ror") && sz !== 32) throw Error("rot8/16");
        const isImm = ins.src.k === "i";
        const tC = this.tmp();
        if (isImm) c.i32(ins.src.v & 31).set(tC); else { this.rd(1); c.i32(31).op(OP.i32_and).set(tC); }
        if (isImm && (ins.src.v & 31) === 0) return;
        const needFlags = this.fusedProducers.has(ins.addr) || o.lazy;
        this.rmw(ins.dst, (tA) => {
            const tR = this.tmp();
            const tX = this.tmp(); // operand prepared (sign-extended for sar)
            c.get(tA);
            if (a === "sar" && sz < 32) c.op(sz === 8 ? OP.i32_extend8_s : OP.i32_extend16_s);
            c.set(tX);
            const opc = { shl: OP.i32_shl, shr: OP.i32_shr_u, sar: OP.i32_shr_s, rol: OP.i32_rotl, ror: OP.i32_rotr }[a];
            c.get(tX).get(tC).op(opc).set(tR);
            if (needFlags) {
                const tCF = this.tmp(), tOF = this.tmp();
                const k = 32 - sz;
                switch (a) {
                    case "shl": // CF = bit (sz - cnt) of a
                        c.get(tX).i32(sz).get(tC).op(OP.i32_sub).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tCF);
                        c.get(tR).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).get(tCF).op(OP.i32_xor).set(tOF); break;
                    case "shr":
                        c.get(tX).get(tC).i32(1).op(OP.i32_sub).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tCF);
                        c.get(tX).i32(sz - 1).op(OP.i32_shr_u).i32(1).op(OP.i32_and).set(tOF); break;
                    case "sar":
                        c.get(tX).get(tC).i32(1).op(OP.i32_sub).op(OP.i32_shr_s).i32(1).op(OP.i32_and).set(tCF);
                        c.i32(0).set(tOF); break;
                    case "rol":
                        c.get(tR).i32(1).op(OP.i32_and).set(tCF);
                        c.get(tR).i32(31).op(OP.i32_shr_u).get(tCF).op(OP.i32_xor).set(tOF); break;
                    case "ror":
                        c.get(tR).i32(31).op(OP.i32_shr_u).set(tCF);
                        c.get(tR).i32(30).op(OP.i32_shr_u).get(tR).i32(31).op(OP.i32_shr_u).op(OP.i32_xor).i32(1).op(OP.i32_and).set(tOF); break;
                }
                void k;
                const kind = a === "rol" || a === "ror" ? "rot" : a;
                if (isImm) this.flagDef(ins, kind, sz, tX, -1, tR, { cf: tCF, of: tOF });
                else {
                    // count 0 leaves the flags alone: only the lazy form is defined here
                    if (!o.lazy) throw Error("shift by CL with consumed flags");
                    const saved = this.st ? { ...this.st } : null;
                    // make the lazy slots locally valid before the conditional update (ABI-b)
                    for (const s of [S_OP1, S_RES, S_SIZE, S_CHG, S_FLG]) { this.rd(s); c.op(OP.drop); }
                    void saved;
                    c.get(tC).if_(); this.push({ k: "if" });
                    this.flagDef(ins, kind, sz, tX, -1, tR, { cf: tCF, of: tOF });
                    this.pop(); c.end();
                    if (this.o.abi === "b") for (const s of [S_OP1, S_RES, S_SIZE, S_CHG, S_FLG]) this.st.G &= ~(1 << s);
                }
            }
            c.get(tR);
        });
    }
    lowerCall(ins) {
        const c = this.c, o = this.o;
        const Rr = ins.next;
        let tT = -1;
        if (ins.m === "callind") { tT = this.tmp(); this.val(ins.src); c.set(tT); }
        if (o.retired) { this.rd(S_BUD); c.i32(0).op(OP.i32_lt_s).hint(0).if_(); this.push({ k: "if" }); this.exitSite(ins.addr, R.BUDGET, 1); this.pop(); c.end(); }
        // push return address
        const tS = this.tmp(), tR = this.tmp();
        this.rd(4); c.i32(4).op(OP.i32_sub).set(tS);
        c.i32(Rr + (o.mutateRet === ins.addr ? 1 : 0)).set(tR); // mutateRet: negative control for RET-check
        this.memWriteAt(ins, tS, tR);
        c.get(tS); this.wr(4);
        let direct = -1, tI = -1;
        if (ins.m === "call") {
            if (!this.fidx.has(ins.target) || this.isColdFunc(ins.target)) { this.exitSite(ins.target, R.COLD); return; }
            direct = this.fidx.get(ins.target);
        } else {
            tI = this.tmp();
            c.get(tT).i32(this.textLo).op(OP.i32_sub).i32(this.shift).op(OP.i32_shr_u).set(tI);
            if (o.retcheck) {
                c.get(tI).i32(this.nslots).op(OP.i32_ge_u).hint(0).if_(); this.push({ k: "if" }); this.exitSite(0, R.INDMISS, 0, tT); this.pop(); c.end();
                c.get(tI).i32(2).op(OP.i32_shl).mem(OP.i32_load, 2, MAP_BASE).get(tT).op(OP.i32_ne).hint(0).if_(); this.push({ k: "if" }); this.exitSite(0, R.INDMISS, 0, tT); this.pop(); c.end();
            }
        }
        if (o.abi === "a") {
            for (const s of this.slotsUsed) this.rd(s);
            if (o.retcheck) c.get(this.L_DEPTH).i32(1).op(OP.i32_add);
        } else this.syncAll();
        if (direct >= 0) c.call(direct); else c.get(tI).call_indirect(this.gtype);
        if (o.retcheck) c.set(this.L_POP);
        if (o.abi === "a") { for (let i = this.slotsUsed.length - 1; i >= 0; i--) c.set(this.slotLocal.get(this.slotsUsed[i])); }
        else this.st.L = 0;
        if (o.retcheck) {
            c.get(this.L_POP).i32(Rr).op(OP.i32_ne).hint(0).if_(); this.push({ k: "if" });
            if (o.abi === "a") {
                c.get(this.L_POP).i32(SENT).op(OP.i32_ne).if_().i32(R.RETMISMATCH).gset(G_REASON).end();
                c.get(this.L_POP).set(this.L_XEIP).br(this.brTo((f) => f.k === "exit"));
            } else {
                c.get(this.L_POP).i32(SENT).op(OP.i32_ne).if_().i32(R.RETMISMATCH).gset(G_REASON).get(this.L_POP).gset(G_EIP).end();
                c.i32(SENT).op(OP.return);
            }
            this.pop(); c.end();
        }
    }
}

// fix-up: addrHost must understand a precomputed address local (base -2)
const _ea = FnTranslator.prototype.ea;
FnTranslator.prototype.ea = function (mo, withDisp) {
    if (mo.base === -2) { this.c.get(mo.local); return; }
    return _ea.call(this, mo, withDisp);
};
// xchg: implemented explicitly (the generic rmw closure above cannot express the swap cleanly)
const _lower = FnTranslator.prototype.lowerIns;
FnTranslator.prototype.lowerIns = function (ins) {
    if (ins.m !== "xchg") return _lower.call(this, ins);
    const c = this.c;
    if (ins.src.k !== "r") throw Error("xchg src mem");
    const tS = this.tmp(); this.regRead(ins.src); c.set(tS);
    const tOld = this.tmp();
    this.rmw(ins.dst, (tA) => { c.get(tA).set(tOld); c.get(tS); });
    this.regWrite(ins.src, tOld);
};

// ---------------------------------------------------------------------------------------------
export const VARIANTS = {
    F0: { abi: "a" },
    "F0b": { abi: "b" },
    RC: { abi: "a", retcheck: true },
    RT: { abi: "a", retcheck: true, retired: true },
    LZ: { abi: "a", retcheck: true, retired: true, lazy: true },
    S: { abi: "a", retcheck: true, retired: true, lazy: true, guard: true },
    Sb: { abi: "b", retcheck: true, retired: true, lazy: true, guard: true },
    // single-obligation ablations (attribution, not ladder rungs)
    F0G: { abi: "a", guard: true },
    F0Z: { abi: "a", lazy: true },
    RTG: { abi: "a", retcheck: true, retired: true, guard: true },
    SnoRT: { abi: "a", retcheck: true, lazy: true, guard: true },
    "S-sf": { abi: "a", retcheck: true, retired: true, lazy: true, guard: true, stackFree: true },
};

export function parseVariant(spec) {
    // e.g. "S", "S+b", "F0+guard", "RT,abi=b"
    const [name, ...mods] = spec.split(/[+,]/);
    const v = { ...(VARIANTS[name] || {}) };
    if (!VARIANTS[name]) throw Error(`unknown variant ${name}`);
    for (const mm of mods) {
        if (mm === "b" || mm === "a") v.abi = mm;
        else if (mm.includes("=")) { const [k, val] = mm.split("="); v[k] = isNaN(Number(val)) ? val : Number(val); }
        else v[mm] = true;
    }
    return v;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    // node translate.mjs --exe X --variant S [--cold profile.json] [--profile] [--out file.wasm] [--observed f.json] [--mutate hex]
    const a = process.argv.slice(2);
    const opt = {};
    for (let i = 0; i < a.length; i++) {
        const k = a[i].replace(/^--/, "");
        if (k === "profile") opt.profile = true; else opt[k] = a[++i];
    }
    const pe = loadPE(fs.readFileSync(opt.exe));
    const v = parseVariant(opt.variant || "F0");
    if (opt.profile) v.profile = true;
    if (opt.cold) v.cold = new Set(JSON.parse(fs.readFileSync(opt.cold, "utf8")).executed);
    if (opt.observed && fs.existsSync(opt.observed)) v.observed = JSON.parse(fs.readFileSync(opt.observed, "utf8"));
    if (opt.mutate) v.mutate = parseInt(opt.mutate, 16);
    if (opt["mutate-ret"]) v.mutateRet = parseInt(opt["mutate-ret"], 16);
    const t0 = Date.now();
    const r = translate(pe, v);
    const out = opt.out || "out.wasm";
    fs.writeFileSync(out, r.bytes);
    fs.writeFileSync(out.replace(/\.wasm$/, ".json"), JSON.stringify({ variant: opt.variant, opts: { ...v, cold: v.cold ? v.cold.size : null }, stats: r.stats, layout: r.layout, profMap: r.profMap.length ? r.profMap : undefined }, null, 1));
    console.log(JSON.stringify({ out, ms: Date.now() - t0, ...r.stats, unsupKinds: undefined }));
}
