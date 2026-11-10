// PE loading + automatic function discovery + per-function CFG. No symbols, no map file, no
// knowledge of the generator: function entries come from
//   (1) the PE entry point,
//   (2) direct call targets found by recursive descent,
//   (3) code addresses stored in non-executable sections (function-pointer tables, vtables) —
//       the lab PEs are linked /FIXED, so there are no base relocations to read; a 4-aligned dword
//       scan of .rdata/.data validated by decoding is the fallback,
//   (4) code-address immediates in decoded instructions (push offset f / mov r, offset f),
//   (5) indirect-call targets OBSERVED at run time (a miss exits and is recorded; run
//       `translate.mjs --discover` iterates until there are none).
// Switch jump tables are recognised by shape: jmp [T + r*4] with the bound from a dominating
// `and r, imm` / `cmp r, imm ; ja|jae` on the fall-through path.
import { decode } from "./x86dec.mjs";

export function loadPE(buf) {
    const pe = new Uint8Array(buf);
    const dv = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    const lfanew = dv.getUint32(0x3c, true);
    if (dv.getUint32(lfanew, true) !== 0x4550) throw Error("not a PE");
    const coff = lfanew + 4;
    const nsec = dv.getUint16(coff + 2, true), optSize = dv.getUint16(coff + 16, true);
    const opt = coff + 20;
    const entry = dv.getUint32(opt + 16, true), base = dv.getUint32(opt + 28, true), sizeOfImage = dv.getUint32(opt + 56, true);
    const relocRva = dv.getUint32(opt + 96 + 5 * 8, true), relocSize = dv.getUint32(opt + 96 + 5 * 8 + 4, true);
    const img = new Uint8Array(sizeOfImage);
    const sections = [];
    for (let i = 0; i < nsec; i++) {
        const s = opt + optSize + i * 40;
        const name = String.fromCharCode(...pe.subarray(s, s + 8)).replace(/\0.*$/, "");
        const vsize = dv.getUint32(s + 8, true), va = dv.getUint32(s + 12, true);
        const rawSize = dv.getUint32(s + 16, true), rawPtr = dv.getUint32(s + 20, true);
        const ch = dv.getUint32(s + 36, true);
        img.set(pe.subarray(rawPtr, rawPtr + Math.min(rawSize, vsize)), va);
        sections.push({ name, va: base + va, vsize, exec: !!(ch & 0x20000000), write: !!(ch & 0x80000000) });
    }
    const text = sections.filter((s) => s.exec);
    return { img, base, entry: base + entry, sizeOfImage, sections, text, hasRelocs: relocSize > 0 && relocRva > 0 };
}

export function makeReader(pe) {
    const { img, base } = pe;
    return (a) => { const o = (a - base) >>> 0; return o < img.length ? img[o] : -1; };
}

const isTerm = (m) => m === "jmp" || m === "ret" || m === "jmpind" || m === "hlt" || m === "unsup" || m === "int3";

export function discover(pe, opts = {}) {
    const rd = makeReader(pe);
    const inText = (a) => pe.text.some((s) => a >= s.va && a < s.va + s.vsize);
    const insCache = new Map();
    const dec = (a) => {
        let i = insCache.get(a);
        if (!i) { try { i = decode(rd, a); } catch { i = { addr: a, len: 1, next: a + 1, m: "unsup", why: "decode past image" }; } insCache.set(a, i); }
        return i;
    };
    const stats = { seedEntry: 1, seedData: 0, seedImm: 0, seedObserved: 0, rejectedDataPtrs: 0, jumpTables: 0, jumpTableUnbounded: 0, indirectJmpUnknown: 0, unsupSites: 0, unsupKinds: {} };

    // ---- jump table recognition --------------------------------------------------------------
    // prevOf: fall-through predecessor (filled while walking).
    const prevOf = new Map();
    function jumpTable(ins) {
        const s = ins.src;
        if (s.k !== "m" || s.base !== -1 || s.idx < 0 || s.sc !== 4) return null;
        const r = s.idx, T = s.disp >>> 0;
        let bound = 0;
        // Walk back along fall-through/jcc-fallthrough predecessors (<= 12 instructions).
        let a = ins.addr, steps = 0, sawJa = null;
        while (steps++ < 12) {
            const p = prevOf.get(a);
            if (p === undefined) break;
            const pi = dec(p);
            if (pi.m === "jcc" && (pi.cc === 7 || pi.cc === 3)) sawJa = pi.cc;
            else if (pi.m === "alu" && pi.a === "and" && pi.dst.k === "r" && pi.dst.r === r && pi.src.k === "i" && pi.dst.sz === 32) { bound = pi.src.v + 1; break; }
            else if (pi.m === "alu" && pi.a === "cmp" && pi.dst.k === "r" && pi.dst.r === r && pi.src.k === "i" && sawJa !== null) { bound = sawJa === 7 ? pi.src.v + 1 : pi.src.v; break; }
            else if (pi.m === "mov" && pi.dst.k === "r" && pi.dst.r === r) break;
            a = p;
        }
        if (!bound || bound > 4096) return { T, r, targets: null };
        const targets = [];
        for (let k = 0; k < bound; k++) {
            const o = T + 4 * k;
            const v = (rd(o) | (rd(o + 1) << 8) | (rd(o + 2) << 16) | (rd(o + 3) << 24)) >>> 0;
            if (!inText(v)) return { T, r, targets: null };
            targets.push(v);
        }
        return { T, r, targets };
    }

    // ---- walk one function: intra-procedural instruction set ----------------------------------
    function walk(entry, entries) {
        const seen = new Set();
        const work = [entry];
        const calls = [], imms = [];
        while (work.length) {
            let a = work.pop();
            while (!seen.has(a)) {
                seen.add(a);
                const ins = dec(a);
                // Code-address immediates only where an address is MATERIALISED (push imm32,
                // mov r/m, imm32): arithmetic constants land in the text range by chance.
                if ((ins.m === "push" || ins.m === "mov") && ins.src && ins.src.k === "i" && ins.src.sz === 32 && inText(ins.src.v)) imms.push(ins.src.v);
                if (ins.m === "jcc") { work.push(ins.target); prevOf.set(ins.next, a); a = ins.next; continue; }
                if (ins.m === "jmp") { if (!entries.has(ins.target) || ins.target === entry) work.push(ins.target); break; }
                if (ins.m === "jmpind") {
                    const jt = jumpTable(ins);
                    ins.jt = jt;
                    if (jt && jt.targets) for (const t of jt.targets) work.push(t);
                    break;
                }
                if (isTerm(ins.m)) break;
                if (ins.m === "call") calls.push(ins.target);
                prevOf.set(ins.next, a);
                a = ins.next;
            }
        }
        return { seen, calls, imms };
    }

    // ---- seeds -----------------------------------------------------------------------------
    const entries = new Map(); // addr -> how found
    const addEntry = (a, how) => { if (!entries.has(a) && inText(a)) { entries.set(a, how); return true; } return false; };
    addEntry(pe.entry, "entry");
    for (const s of pe.sections) {
        if (s.exec) continue;
        const off = s.va - pe.base;
        for (let o = 0; o + 4 <= s.vsize; o += 4) {
            const i = off + o;
            if (i + 4 > pe.img.length) break;
            const v = (pe.img[i] | (pe.img[i + 1] << 8) | (pe.img[i + 2] << 16) | (pe.img[i + 3] << 24)) >>> 0;
            if (!inText(v)) continue;
            // Validate: the first instructions must decode inside the integer/x87 ISA and not
            // start with padding.
            let ok = true, a = v;
            for (let k = 0; k < 3; k++) { const ins = dec(a); if (ins.m === "int3" || (ins.m === "unsup" && !/^x87/.test(ins.why || ""))) { ok = false; break; } if (isTerm(ins.m) || ins.m === "jcc") break; a = ins.next; }
            if (!ok) { stats.rejectedDataPtrs++; continue; }
            if (addEntry(v, "data")) stats.seedData++;
        }
    }
    for (const a of opts.observed || []) if (addEntry(a >>> 0, "observed")) stats.seedObserved++;

    // ---- fixpoint over call targets ---------------------------------------------------------
    let changed = true;
    const walked = new Set();
    while (changed) {
        changed = false;
        for (const e of [...entries.keys()]) {
            if (walked.has(e)) continue;
            walked.add(e);
            const w = walk(e, entries);
            for (const t of w.calls) if (addEntry(t, "call")) changed = true;
            for (const t of w.imms) if (addEntry(t, "imm")) { stats.seedImm++; changed = true; }
        }
        if (!changed) {
            // A tail jump target may since have become an entry: re-walking is cheap; done below.
        }
    }

    // ---- per-function CFGs with the final entry set ----------------------------------------
    const funcs = new Map();
    for (const e of entries.keys()) funcs.set(e, buildCFG(e));

    function buildCFG(entry) {
        const { seen } = walk(entry, entries);
        const leaders = new Set([entry]);
        for (const a of seen) {
            const ins = dec(a);
            if (ins.m === "jcc") { leaders.add(ins.target); leaders.add(ins.next); }
            else if (ins.m === "jmp" && seen.has(ins.target)) leaders.add(ins.target);
            else if (ins.m === "jmpind" && ins.jt && ins.jt.targets) for (const t of ins.jt.targets) leaders.add(t);
        }
        const blocks = new Map();
        for (const L of leaders) {
            if (!seen.has(L)) continue;
            const b = { addr: L, ins: [], succ: [], term: null };
            let a = L;
            for (;;) {
                const ins = dec(a);
                b.ins.push(ins);
                if (ins.m === "unsup" || ins.m === "int3") { b.term = { k: "exit", why: ins.m === "int3" ? "int3" : "unsup:" + ins.why, eip: a }; break; }
                if (ins.m === "jcc") { b.term = ins.target === ins.next ? { k: "jmp" } : { k: "jcc", cc: ins.cc }; b.succ = ins.target === ins.next ? [ins.next] : [ins.target, ins.next]; break; }
                if (ins.m === "jmp") {
                    if (seen.has(ins.target) && (!entries.has(ins.target) || ins.target === entry)) { b.term = { k: "jmp" }; b.succ = [ins.target]; }
                    else b.term = { k: "tail", target: ins.target };
                    break;
                }
                if (ins.m === "jmpind") {
                    if (ins.jt && ins.jt.targets) {
                        const uniq = [...new Set(ins.jt.targets)];
                        b.term = { k: "table", jt: ins.jt, uniq }; b.succ = uniq;
                    } else b.term = { k: "exit", why: "indirect jmp", eip: a, dynamic: true };
                    break;
                }
                if (ins.m === "ret") { b.term = { k: "ret", pop: ins.pop }; break; }
                if (ins.m === "hlt") { b.term = { k: "hlt" }; break; }
                if (leaders.has(ins.next)) { b.term = { k: "jmp", fall: true }; b.succ = [ins.next]; break; }
                a = ins.next;
            }
            blocks.set(L, b);
        }
        return { entry, blocks };
    }

    // stats over the final CFGs (static sites)
    let insCount = 0, x86Bytes = 0;
    const counted = new Set();
    for (const f of funcs.values()) {
        for (const b of f.blocks.values()) {
            for (const i of b.ins) if (!counted.has(i.addr)) { counted.add(i.addr); insCount++; x86Bytes += i.len; }
            if (b.term.k === "table") stats.jumpTables++;
            if (b.term.k === "exit" && b.term.dynamic) stats.indirectJmpUnknown++;
            if (b.term.k === "exit" && !b.term.dynamic) { stats.unsupSites++; stats.unsupKinds[b.term.why] = (stats.unsupKinds[b.term.why] || 0) + 1; }
        }
    }
    stats.functions = funcs.size;
    stats.entriesBy = {};
    for (const how of entries.values()) stats.entriesBy[how] = (stats.entriesBy[how] || 0) + 1;
    stats.instructions = insCount;
    stats.x86Bytes = x86Bytes;
    return { funcs, entries, stats, dec, rd };
}
