// flat-pair workload generator: one deterministic C++ source (workload.cpp) from a seed and a
// handful of shape parameters. Thousands of small noinline functions of mixed form, wired into a
// leveled call graph (a call always goes to a DEEPER level, so every root call terminates), plus
// wl_run(): a deterministic pseudo-random walk over the roots with a checksum.
//
//   node gen.mjs <preset|json-params> <out.cpp>      (also writes <out>.meta.json)
//
// Everything is u32 arithmetic (no UB, no 64-bit helpers) and x87 values are exact dyadic numbers
// below 2^30, so MSVC x87 (80-bit), v86 relaxed-f64 and Wasm f64 must all agree bit-for-bit.

import fs from "node:fs";

export const PRESETS = {
    // A few dozen functions on a handful of pages: what the existing k1..k6 world looks like.
    tight: { seed: 1, nfunc: 40, depth: 4, size: 6, fanout: 1.5, condCall: 0.3, indirect: 0.1, hot: 1, skip: 0.15, fp: 0.05 },
    // Hundreds of functions, ~30 pages.
    medium: { seed: 2, nfunc: 600, depth: 7, size: 5, fanout: 1.6, condCall: 0.3, indirect: 0.08, hot: 2, skip: 0.2, fp: 0.05 },
    // Thousands of small functions over hundreds of pages, call-dense: tuned toward the HL2 profile.
    flat: { seed: 3, nfunc: 6000, depth: 9, size: 3, fanout: 1.7, condCall: 0.35, indirect: 0.05, hot: 1, skip: 0.2, fp: 0.04 },
};
const DEFAULTS = { seed: 1, nfunc: 600, depth: 7, size: 5, fanout: 1.6, condCall: 0.3, indirect: 0.08, hot: 1, skip: 0.2, fp: 0.05,
    arrLog2: 12, itemLog2: 10, levelGrowth: 1.35, methodsPerLevel: 8, order: "shuffle" };

function mulberry32(a) {
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function resolveParams(spec) {
    if (typeof spec === "string") {
        if (PRESETS[spec]) return { preset: spec, ...DEFAULTS, ...PRESETS[spec] };
        if (spec.trim().startsWith("{")) spec = JSON.parse(spec);
        else {
            // "flat,order:dfs,nfunc:600" — a preset plus overrides, shell-friendly
            const [preset, ...kv] = spec.split(",");
            spec = { preset };
            for (const s of kv) { const [k, v] = s.split(":"); spec[k] = isNaN(Number(v)) ? v : Number(v); }
        }
    }
    const base = spec.preset ? PRESETS[spec.preset] : {};
    return { ...DEFAULTS, ...base, ...spec };
}

export function generate(p) {
    const rnd = mulberry32(p.seed * 0x9E3779B1);
    const ri = (n) => Math.floor(rnd() * n);
    const k32 = () => "0x" + ((rnd() * 4294967296) >>> 0).toString(16).padStart(8, "0") + "u";
    const sh = () => 1 + ri(27);
    const AM = (1 << p.arrLog2) - 1, IM = (1 << p.itemLog2) - 1;

    // Level sizes grow geometrically with depth (a call tree is wider at the bottom).
    const weights = Array.from({ length: p.depth }, (_, l) => Math.pow(p.levelGrowth, l));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const sizes = weights.map((w) => Math.max(2, Math.round((p.nfunc * w) / wsum)));
    // Level 0 holds the roots (reached only through g_roots). Levels >= 1 hold a few virtual
    // methods (reached only through g_objs_<l>) and free functions.
    const levels = [];
    let id = 0;
    for (let l = 0; l < p.depth; l++) {
        const n = sizes[l];
        const nm = l === 0 ? 0 : Math.min(p.methodsPerLevel, Math.max(1, Math.floor(n / 4)));
        const fns = [];
        for (let i = 0; i < n; i++) fns.push({ id: id++, level: l, method: i < nm, mi: i });
        levels.push({ fns, methods: fns.filter((f) => f.method), free: fns.filter((f) => !f.method) });
    }
    const all = levels.flatMap((L) => L.fns);
    const fname = (f) => (f.method ? `V${f.level}_${f.mi}` : `f${f.id}`);

    // Per-level indirect table of free functions (16 entries, power of two).
    const tabs = levels.map((L) => (L.free.length ? Array.from({ length: 16 }, () => L.free[ri(L.free.length)]) : null));

    const counts = { stmts: {}, calls: { direct: 0, cond: 0, fnptr: 0, virtual: 0 } };
    const bump = (k) => { counts.stmts[k] = (counts.stmts[k] || 0) + 1; };

    // x87:0 = integer-only variant (no x87 statement, no double in Ctx/reset/hash). Absent = as before.
    const noX87 = p.x87 === 0;
    function stmt() {
        const r = rnd();
        const fpCut = noX87 ? 0 : p.fp;
        if (r < fpCut) {
            bump("x87");
            const a = ri(64), b = ri(64);
            return `{ double d = (double)(int)(x & 0xffffu); double e = (double)(int)((x >> ${8 + ri(8)}) & 0xffu); `
                + `double r = d * e + d * 0.5 - e * 0.25; c->fs[${a}] = r; if (r > c->fs[${b}]) x ^= ${k32()}; else x += ${1 + ri(1000)}u; }`;
        }
        const q = (r - fpCut) / (1 - fpCut);
        if (q < 0.24) { bump("arith"); return `x = (x * ${k32()} + (x >> ${sh()})) ^ ${k32()}; y += x;`; }
        if (q < 0.44) {
            bump("branch");
            const m = [1, 3, 7][ri(3)];
            return `if ((x & ${m}u) == ${ri(m + 1)}u) { x += ${k32()}; y ^= x; } else { x ^= ${k32()}; }`;
        }
        if (q < 0.60) { bump("struct"); return `{ Item* it = &c->items[(x >> ${sh()}) & ${IM}u]; it->a += x; x ^= it->b + it->cnt; it->cnt++; }`; }
        if (q < 0.76) { bump("array"); return `c->arr[(x + ${ri(4096)}u) & ${AM}u] ^= y; x += c->arr[(x >> ${sh()}) & ${AM}u];`; }
        if (q < 0.86) {
            bump("loop");
            return `{ u32 n = ((x >> ${sh()}) & 3u) + 1u; for (u32 i = 0; i < n; i++) x = x * 3u + c->arr[(x + i) & ${AM}u]; }`;
        }
        bump("switch");
        const ops = [`x += ${k32()};`, `x ^= ${k32()};`, `x = x * 5u + y;`, `x -= y;`, `x = (x << 3) | (x >> 29);`,
            `y += x >> 3;`, `x = ~x + ${ri(99)}u;`, `x ^= c->arr[x & ${AM}u];`];
        for (let i = ops.length - 1; i > 0; i--) { const j = ri(i + 1); [ops[i], ops[j]] = [ops[j], ops[i]]; }
        return `switch ((x >> ${sh()}) & 7u) { ${ops.map((o, i) => `case ${i}: ${o} break;`).join(" ")} }`;
    }

    function callee(level) {
        let l = level + 1;
        if (l + 1 < p.depth && rnd() < p.skip) l++;
        return l;
    }
    function call(level) {
        const l = callee(level);
        const L = levels[l];
        const salt = k32();
        let expr;
        if (rnd() < p.indirect) {
            if (rnd() < 0.5 && L.methods.length) {
                counts.calls.virtual++;
                expr = `g_objs_${l}[(x >> ${sh()}) & 7u]->m(c, x ^ ${salt})`;
            } else {
                counts.calls.fnptr++;
                expr = `g_tab_${l}[(x >> ${sh()}) & 15u](c, x ^ ${salt})`;
            }
        } else {
            counts.calls.direct++;
            // Every free function gets a static caller first (unreferenced ones would be dropped
            // by /OPT:REF and nfunc would overstate the code volume), then callees are random.
            const g = pending[l].length ? pending[l].pop() : L.free[ri(L.free.length)];
            curCallees.push(g);
            expr = `${fname(g)}(c, x ^ ${salt})`;
        }
        if (rnd() < p.condCall) { counts.calls.cond++; return `if (x & ${1 << ri(8)}u) x += ${expr};`; }
        return `x += ${expr};`;
    }

    function body(f) {
        f.callees = [];
        const nst = Math.max(1, Math.round(p.size * (0.5 + rnd())));
        const lines = [];
        for (let i = 0; i < nst; i++) lines.push(stmt());
        if (f.level < p.depth - 1) {
            const nc = Math.floor(p.fanout) + (rnd() < p.fanout - Math.floor(p.fanout) ? 1 : 0);
            for (let i = 0; i < nc; i++) lines.splice(ri(lines.length + 1), 0, call(f.level));
        }
        // footprint/ (additive): `deadArm` statements behind a guard that is never true at run
        // time but not provable (x is a hash of the walk) — compiled by the JIT (the analysis
        // follows both arms), never executed. Drawn from a SEPARATE generator so the hot code is
        // otherwise the same statements in the same order.
        if (p.deadArm) {
            const dead = [];
            for (let i = 0; i < p.deadArm; i++) dead.push(coldStmt());
            lines.push(`if (x == 0x${(0x5EED0000 + f.id).toString(16)}u && y == ${f.id}u) { ${dead.join(" ")} }`);
        }
        return `    u32 y = ${k32()}; x ^= ${k32()};\n` + lines.map((s) => "    " + s).join("\n") + `\n    return x + y;\n`;
    }
    // footprint/ (additive): never-called padding functions and dead arms, from their own RNG.
    const crnd = mulberry32((p.seed ^ 0xC01D) * 0x85EBCA6B);
    const cri = (n) => Math.floor(crnd() * n);
    const ck32 = () => "0x" + ((crnd() * 4294967296) >>> 0).toString(16).padStart(8, "0") + "u";
    function coldStmt() {
        const q = crnd();
        if (q < 0.4) return `x = (x * ${ck32()} + (x >> ${1 + cri(27)})) ^ ${ck32()}; y += x;`;
        if (q < 0.7) return `if ((x & 3u) == ${cri(4)}u) { x += ${ck32()}; y ^= x; } else { x ^= ${ck32()}; }`;
        return `c->arr[(x + ${cri(4096)}u) & ${AM}u] ^= y; x += c->arr[(x >> ${1 + cri(27)}) & ${AM}u];`;
    }

    // Bodies are generated in id order (so the CODE is identical for every `order`); only the
    // emission order differs. shuffle: callers and callees land on unrelated pages, as in a big
    // game. dfs: each function is placed right after its first static caller (locality).
    let curCallees = null;
    const pending = levels.map((L) => { const a = L.free.slice(); for (let i = a.length - 1; i > 0; i--) { const j = ri(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; });
    const bodies = new Map();
    for (const f of all) { curCallees = []; bodies.set(f, body(f)); f.callees = curCallees; }
    const unreferenced = levels.slice(1).reduce((n, L, i) => n + pending[i + 1].length, 0);
    let order = all.slice();
    if (p.order === "shuffle") {
        for (let i = order.length - 1; i > 0; i--) { const j = ri(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    } else if (p.order === "dfs") {
        const seen = new Set(), dfs = [];
        const visit = (f) => { if (seen.has(f)) return; seen.add(f); dfs.push(f); for (const g of f.callees) visit(g); };
        for (const f of all) if (f.level === 0) visit(f);
        for (const f of all) visit(f);
        order = dfs;
    } else if (p.order !== "id") throw Error(`unknown order ${p.order}`);
    // footprint/ (additive): `coldPad` never-called functions after EVERY function in emission
    // order (named f<1000000+i> so build.mjs's /ORDER harvest picks them up), kept alive by g_cold.
    const cold = [];
    if (p.coldPad) {
        const padded = [];
        for (const f of order) {
            padded.push(f);
            for (let j = 0; j < p.coldPad; j++) {
                const cf = { id: 1000000 + cold.length, level: -1, method: false, cold: true };
                const n = Math.max(1, Math.round((p.coldSize ?? p.size) * (0.5 + crnd())));
                const ls = [];
                for (let i = 0; i < n; i++) ls.push(coldStmt());
                bodies.set(cf, `    u32 y = ${ck32()}; x ^= ${ck32()};\n` + ls.map((s) => "    " + s).join("\n") + `\n    return x + y;\n`);
                cold.push(cf);
                padded.push(cf);
            }
        }
        order = padded;
    }

    const out = [];
    out.push(`// GENERATED by tools/bench-v86/flat-pair/gen.mjs — do not edit.`);
    out.push(`// params: ${JSON.stringify(p)}`);
    out.push(`#include "platform.h"`);
    out.push(`struct Item { u32 a, b, cnt, pad; };`);
    out.push(noX87 ? `struct Ctx { u32 arr[${AM + 1}]; Item items[${IM + 1}]; };` : `struct Ctx { u32 arr[${AM + 1}]; Item items[${IM + 1}]; double fs[64]; };`);
    out.push(`Ctx g_ctx;`);
    out.push(`typedef u32 (*fn_t)(Ctx*, u32);`);
    out.push(`struct Base { virtual u32 m(Ctx* c, u32 x); };`);
    out.push(`u32 Base::m(Ctx*, u32 x) { return x; }`);
    for (const f of all) {
        if (f.method) out.push(`struct ${fname(f)} : Base { u32 m(Ctx* c, u32 x); };`);
        else out.push(`NOINLINE u32 ${fname(f)}(Ctx* c, u32 x);`);
    }
    for (const f of cold) out.push(`NOINLINE u32 ${fname(f)}(Ctx* c, u32 x);`);
    if (cold.length) out.push(`fn_t g_cold[${cold.length}] = { ${cold.map(fname).join(", ")} };`);
    for (let l = 1; l < p.depth; l++) {
        out.push(`Base* g_objs_${l}[8];`);
        if (tabs[l]) out.push(`fn_t g_tab_${l}[16] = { ${tabs[l].map(fname).join(", ")} };`);
    }
    const roots = levels[0].fns;
    out.push(`fn_t g_roots[${roots.length}] = { ${roots.map(fname).join(", ")} };`);
    for (const f of order) {
        if (f.method) out.push(`NOINLINE u32 ${fname(f)}::m(Ctx* c, u32 x) {\n${bodies.get(f)}}`);
        else out.push(`NOINLINE u32 ${fname(f)}(Ctx* c, u32 x) {\n${bodies.get(f)}}`);
    }
    // Objects are constructed at run time (no CRT static constructors in the freestanding arm).
    // Placement new into static storage: no CRT static constructors, no thread-safe-static guards.
    out.push(`inline void* operator new(decltype(sizeof(0)), void* p) { return p; }`);
    out.push(`extern "C" void wl_setup(void) {`);
    for (let l = 1; l < p.depth; l++) {
        const ms = levels[l].methods;
        if (!ms.length) { out.push(`    for (int i = 0; i < 8; i++) g_objs_${l}[i] = 0;`); continue; }
        for (const f of ms) out.push(`    alignas(8) static unsigned char st_${fname(f)}[sizeof(${fname(f)})]; Base* o_${fname(f)} = new (st_${fname(f)}) ${fname(f)}();`);
        for (let i = 0; i < 8; i++) out.push(`    g_objs_${l}[${i}] = o_${fname(ms[i % ms.length])};`);
    }
    out.push(`}`);
    out.push(`extern "C" void wl_reset(u32 seed) {
    u32 s = seed ^ 0x5bd1e995u;
    for (u32 i = 0; i < ${AM + 1}u; i++) { s = s * 1664525u + 1013904223u; g_ctx.arr[i] = s; }
    for (u32 i = 0; i < ${IM + 1}u; i++) { s = s * 1664525u + 1013904223u; g_ctx.items[i].a = s; g_ctx.items[i].b = s >> 7; g_ctx.items[i].cnt = 0; g_ctx.items[i].pad = 0; }
${noX87 ? "" : "    for (u32 i = 0; i < 64u; i++) { s = s * 1664525u + 1013904223u; g_ctx.fs[i] = (double)(int)(s >> 8); }\n"}}`);
    out.push(`extern "C" u32 wl_hash(void) {
    u32 h = 2166136261u;
    for (u32 i = 0; i < ${AM + 1}u; i++) h = (h ^ g_ctx.arr[i]) * 16777619u;
    for (u32 i = 0; i < ${IM + 1}u; i++) h = (h ^ g_ctx.items[i].a ^ (g_ctx.items[i].cnt << 16)) * 16777619u;
${noX87 ? "" : "    for (u32 i = 0; i < 64u; i++) h = (h ^ (u32)(g_ctx.fs[i] > 1000000.0) ^ (i << 1) * (u32)(g_ctx.fs[i] > 0.0)) * 16777619u;\n"}    return h;
}`);
    // footprint/ (additive): `subset` = only the first <subset> roots are walked once the first
    // <subsetAfter> wl_run calls (the driver's warm-up) are done. Every module is compiled during
    // the full warm-up, then the measured walk touches a smaller part of the same code.
    if (p.subset) out.push(`static u32 g_wl_calls;`);
    out.push(`extern "C" u32 wl_run(u32 seed, u32 steps) {
    u32 s = seed, acc = 0;${p.subset ? `
    u32 nroots = (g_wl_calls++ < ${p.subsetAfter ?? 4}u) ? ${roots.length}u : ${p.subset}u;` : ""}
    for (u32 i = 0; i < steps; i++) {
        s = s * 1664525u + 1013904223u;
        u32 r = s >> 16;
        for (u32 k = 1; k < ${p.hot}u; k++) { s = s * 1664525u + 1013904223u; r = (r * (s >> 16)) >> 16; }
        u32 idx = (r * ${p.subset ? "nroots" : roots.length + "u"}) >> 16;
        acc = acc * 31u + g_roots[idx](&g_ctx, s ^ acc);
    }
    return acc;
}`);
    const src = out.filter((l) => l !== "").join("\n") + "\n";
    const meta = { params: p, levelSizes: sizes, functions: all.length, methods: all.filter((f) => f.method).length,
        roots: roots.length, unreferencedFree: unreferenced, emitOrder: order.map(fname), statements: counts.stmts, callSites: counts.calls, sourceBytes: src.length };
    return { src, meta };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("gen.mjs")) {
    const [spec, outFile] = process.argv.slice(2);
    if (!spec || !outFile) { console.error("usage: node gen.mjs <preset|json> <out.cpp>"); process.exit(2); }
    const p = resolveParams(spec);
    const { src, meta } = generate(p);
    fs.writeFileSync(outFile, src);
    fs.writeFileSync(outFile.replace(/\.cpp$/, "") + ".meta.json", JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta));
}
