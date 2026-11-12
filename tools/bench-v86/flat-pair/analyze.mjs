// Shared arithmetic: per-rep slopes from a runner's marks, and the dispatch-class readout
// (same classes as src/worker/harness/cmds/dispatch.ts summarizeDispatch).
export const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};
/** (max - min) / median, in percent. */
export const spreadPct = (xs) => (xs.length < 2 ? 0 : ((Math.max(...xs) - Math.min(...xs)) / median(xs)) * 100);

/** One entry per rep: {lo:{t,ic,d,jr}, hi:{...}} as deltas inside the phase. */
export function phases(r) {
    const m = r.marks;
    const out = [];
    for (let i = 0; i + 3 < m.length; i++) {
        if (m[i].id === 10 && m[i + 1].id === 11 && m[i + 2].id === 12 && m[i + 3].id === 13) {
            const delta = (a, b) => ({
                t: b.t - a.t,
                ic: a.ic === undefined ? null : ((b.ic - a.ic) >>> 0),
                d: a.d ? b.d.map((v, k) => v - a.d[k]) : null,
                jr: a.jr === null || a.jr === undefined ? null : b.jr - a.jr,
                compiles: a.cc === undefined ? null : b.cc - a.cc,
            });
            out.push({ lo: delta(m[i], m[i + 1]), hi: delta(m[i + 2], m[i + 3]) });
            i += 3;
        }
    }
    return out;
}

/** ns per driver step from the lo/hi slope, one value per rep. */
export function slopes(r) {
    const [, , nlo, nhi] = r.input;
    return phases(r).map((p) => ({
        nsPerStep: (p.hi.t - p.lo.t) / (nhi - nlo),
        insPerStep: p.lo.ic === null ? null : (p.hi.ic - p.lo.ic) / (nhi - nlo),
        ratioHiLo: p.hi.t / p.lo.t,
    }));
}

/** Dispatch classes over the slope (hi minus lo) so warm-in effects cancel too. */
export function dispatchSlope(r) {
    const ps = phases(r);
    if (!ps.length || !ps[0].lo.d) return null;
    const names = r.dispatchNames;
    const p = ps[ps.length - 1];
    const d = {};
    names.forEach((n, k) => { d[n] = p.hi.d[k] - p.lo.d[k]; });
    const retired = p.hi.ic - p.lo.ic;
    const exits = d.moduleReentry + d.moduleChainedEdge + d.retChainHit;
    const cls = {
        chained: d.moduleChainedEdge + d.retChainHit,
        constantTargetUnchained: d.moduleExitChainable,
        dynamic: d.moduleExitDynamic,
        indirect: d.moduleExitIndirect - d.retChainHit,
    };
    cls.other = Math.max(0, d.moduleReentry - cls.constantTargetUnchained - cls.dynamic - cls.indirect);
    const pct = (n) => +((n / exits) * 100).toFixed(1);
    return {
        retired, blockExecutions: d.blockExecution,
        insPerBlock: +(retired / d.blockExecution).toFixed(2),
        exitsPerKiloInsn: +((exits / retired) * 1000).toFixed(2),
        insPerExit: +(retired / exits).toFixed(1),
        classesPct: Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, pct(v)])),
        raw: d,
    };
}
