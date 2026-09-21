#!/usr/bin/env node
// What shape does the D3D9 write-buffer ring ACTUALLY have, and would the pair-run detector
// ever match it?
//
//   node tools/analyze-wbuf-sequence.mjs logs/perf-campaign/wbuf-order.json
//
// WHY. The entire D3D9 batching stack — MegaBatch, fusion, compact runs, storage runs, the
// pipeline-identity cache, the census, the render-bundle arena branch — is downstream of ONE
// boolean: did `tryDrawIndexedWbufRun` accept, which happens only if the ring carried a
// "constant -> draw" pair run. The stack measures 0 of everything on every title profiled so
// far, and no counter in the tree can tell "dead everywhere" from "dead on the two titles we
// looked at". That makes it undeletable and unfixable at the same time.
//
// This reads a captured ring order (harness `wbufOrder`) and answers three things the counters
// cannot:
//   1. the alphabet — what the ring actually carries, and in what proportion;
//   2. the detector's own predicate, replayed over the real sequence: how many strictly
//      alternating const->draw runs exist, and their length distribution;
//   3. the CONSTRUCTIVE half — the n-grams that really do precede a draw. "The detector looks
//      for a pattern that is not there" is only half an answer; the other half is what is.
//
// The detector rule is mirrored from thunk-dispatcher.ts (exact branch :1104-1127, prefix branch
// :1216-1253) and the constants are named here so a drift between the two is visible rather than
// silent. If the emitter changes, this file must be re-read against it — it is a MODEL of the
// detector, not the detector.
import fs from "node:fs";

const PAIR_CONST = "SetVertexShaderConstantF";
const PAIR_DRAW = "DrawIndexedPrimitive";
const PREFIX_MAX_INTERVENING = 4;   // thunk-dispatcher.ts:1225  `n < 4`
const PREFIX_TAIL_PAIRS = 2;        // thunk-dispatcher.ts:1253  `tailRun.pairs >= 2`
const EXACT_MIN_PAIRS = 2;          // the exact branch needs >= 2 adjacent pairs

const file = process.argv[2];
if (!file) {
    console.error("usage: node tools/analyze-wbuf-sequence.mjs <wbuf-order.json>");
    process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const rec = raw.data ?? raw;
const ids = rec.ids ?? [];
if (!ids.length) {
    console.error("the capture is empty — refusing to characterise a ring from no entries");
    process.exit(1);
}
const short = (n) => String(n).replace(/^d3d9:IDirect3DDevice9_/, "").replace(/^d3d9:/, "");
const seq = ids.map(short);

// ── 1. alphabet ──────────────────────────────────────────────────────────────────────────────
const tally = new Map();
for (const n of seq) tally.set(n, (tally.get(n) ?? 0) + 1);
const alphabet = [...tally.entries()].sort((a, b) => b[1] - a[1]);

// ── 2. the detector's predicate, replayed ────────────────────────────────────────────────────
// Exact branch: maximal runs of strictly adjacent (CONST, DRAW) pairs.
const runs = [];
let i = 0;
while (i + 1 < seq.length) {
    if (seq[i] === PAIR_CONST && seq[i + 1] === PAIR_DRAW) {
        let pairs = 0;
        while (i + 1 < seq.length && seq[i] === PAIR_CONST && seq[i + 1] === PAIR_DRAW) { pairs++; i += 2; }
        runs.push(pairs);
    } else i++;
}
const runHist = new Map();
for (const p of runs) runHist.set(p, (runHist.get(p) ?? 0) + 1);
const wouldAcceptExact = runs.filter((p) => p >= EXACT_MIN_PAIRS).length;

// Prefix branch: for every draw, how many entries since the previous CONST.
const gaps = [];
let lastConst = -1;
for (let k = 0; k < seq.length; k++) {
    if (seq[k] === PAIR_CONST) lastConst = k;
    else if (seq[k] === PAIR_DRAW && lastConst >= 0) gaps.push(k - lastConst - 1);
}
const gapHist = new Map();
for (const g of gaps) gapHist.set(g, (gapHist.get(g) ?? 0) + 1);
const withinPrefixCap = gaps.filter((g) => g < PREFIX_MAX_INTERVENING).length;

// ── 3. what IS there: the n-grams that precede a draw ────────────────────────────────────────
const DRAWS = new Set([PAIR_DRAW, "DrawPrimitive", "DrawIndexedPrimitiveUP", "DrawPrimitiveUP"]);
const drawIdx = [];
for (let k = 0; k < seq.length; k++) if (DRAWS.has(seq[k])) drawIdx.push(k);
const settersPerDraw = [];
for (let d = 1; d < drawIdx.length; d++) settersPerDraw.push(drawIdx[d] - drawIdx[d - 1] - 1);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const ngram = (n) => {
    const m = new Map();
    for (const k of drawIdx) {
        if (k - n < 0) continue;
        const key = seq.slice(k - n, k).join(" ");
        m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
};

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "n/a");
console.log(`captured ${seq.length} ring entries, ${alphabet.length} distinct\n`);
console.log("ALPHABET — what the ring carries");
for (const [n, c] of alphabet.slice(0, 14)) console.log(`  ${n.padEnd(34)} ${String(c).padStart(6)}  ${pct(c, seq.length)}`);
if (alphabet.length > 14) console.log(`  (${alphabet.length - 14} more)`);

console.log(`\nDRAWS: ${drawIdx.length}; entries between consecutive draws: mean ${mean(settersPerDraw).toFixed(1)}`);

console.log(`\nDETECTOR, EXACT BRANCH — strictly adjacent ${PAIR_CONST} -> ${PAIR_DRAW}`);
console.log(`  alternating runs found: ${runs.length}`);
for (const [p, c] of [...runHist.entries()].sort((a, b) => a[0] - b[0])) console.log(`    runs of ${p} pair(s): ${c}`);
console.log(`  runs that would ACCEPT (>= ${EXACT_MIN_PAIRS} pairs): ${wouldAcceptExact}`);

console.log(`\nDETECTOR, PREFIX BRANCH — entries between a ${PAIR_CONST} and the next draw`);
const gapRows = [...gapHist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 10);
for (const [g, c] of gapRows) console.log(`    gap ${String(g).padStart(3)}: ${String(c).padStart(6)}  ${pct(c, gaps.length)}`);
console.log(`  draws within the cap (gap < ${PREFIX_MAX_INTERVENING}): ${withinPrefixCap} of ${gaps.length} (${pct(withinPrefixCap, gaps.length)})`);
console.log(`  ...and each still needs a tail of >= ${PREFIX_TAIL_PAIRS} exact pairs, i.e. the line above.`);

console.log(`\nWHAT IS ACTUALLY THERE — the n-grams immediately preceding a draw`);
for (const n of [1, 2, 3]) {
    console.log(`  ${n}-gram:`);
    for (const [k, c] of ngram(n)) console.log(`    ${String(c).padStart(5)}  ${k}`);
}
// -- 4. the actual template: the RLE sequence BETWEEN consecutive draws -----------------------
// n-grams show only the tail. The template is the whole period, and it is what a detector would
// have to match; run-length encoding lets a variable-length constant burst read as one term.
const rle = (arr) => {
    const out = [];
    for (const x of arr) {
        const last = out[out.length - 1];
        if (last && last[0] === x) last[1]++;
        else out.push([x, 1]);
    }
    return out.map(([x, n]) => (n > 1 ? x + "x" + n : x)).join(" ");
};
const gapsTotal = drawIdx.length - 1;
const periods = new Map();
for (let d = 1; d < drawIdx.length; d++) {
    const key = rle(seq.slice(drawIdx[d - 1] + 1, drawIdx[d]));
    periods.set(key, (periods.get(key) ?? 0) + 1);
}
const periodRows = [...periods.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nTHE TEMPLATE — entries between consecutive draws, run-length encoded`);
let covered = 0;
for (const [k, c] of periodRows.slice(0, 8)) {
    covered += c;
    console.log("  " + String(c).padStart(5) + "  " + pct(c, gapsTotal) + "  " + k);
}
console.log("  " + periodRows.length + " distinct period(s); top 8 cover " + pct(covered, gapsTotal));
const shapes = new Map();
for (let d = 1; d < drawIdx.length; d++) {
    const key = rle(seq.slice(drawIdx[d - 1] + 1, drawIdx[d])).replace(/x[0-9]+/g, "*");
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
}
const shapeRows = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n  ...with burst lengths ignored (xN -> *):`);
for (const [k, c] of shapeRows.slice(0, 6)) console.log("  " + String(c).padStart(5) + "  " + pct(c, gapsTotal) + "  " + k);
console.log("  " + shapeRows.length + " distinct shape(s)");

console.log(`\nVERDICT: ${wouldAcceptExact > 0
    ? `the exact branch WOULD fire ${wouldAcceptExact} time(s) in this window`
    : "the exact branch would NEVER fire on this sequence"}`);
