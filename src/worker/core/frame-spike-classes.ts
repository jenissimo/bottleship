/**
 * Budget-missing frames, COALESCED INTO CLASSES — the frame equivalent of `logStats`.
 *
 * A list of bad frames is a firehose: it hides that 40 x 8ms hiccups cost more than one
 * 120ms stall, and it makes the reader do the attribution. So every frame above the arming
 * threshold is reduced to a signature (dominant time category x top contributor), classes are
 * ranked by TOTAL TIME LOST against the budget, and ONE representative frame per class is
 * kept in full for drilling.
 *
 * Budget independence is deliberate: a class accumulates `count`/`sumMs`/`minMs`, so lost-ms
 * for ANY budget is derived at read time (`sumMs - count*budget`) and `minMs >= budget` proves
 * per-class exactness. Nothing has to be re-measured to re-ask the question at 30 vs 60 fps.
 *
 * Cost: the steady-state path is one compare (`frameMs <= classifyOverMs` → reject) with no
 * allocation. A frame ABOVE the threshold pays O(distinct thunks in that frame) to find its
 * dominant contributor and allocates only when a new class/contributor name appears or when a
 * class gets a new worst frame — i.e. only on frames that are already slow. Both the class
 * table and the contributor intern table are capped, so a chaotic session cannot grow it.
 */

/** Thunks whose per-frame time is a BLOCKING WAIT, not CPU work. They must never win
 *  "top contributor": the audio thread's GetMessage park is summed cross-thread into the
 *  frame and would otherwise be the answer for every stall. */
export const PARK_THUNKS: ReadonlySet<string> = new Set<string>([
    'user32:getmessagea', 'user32:getmessagew', 'user32:peekmessagea', 'user32:waitmessage',
    'ddraw:idirectdrawsurface7_flip', 'ddraw:idirectdrawsurface_flip',
    'kernel32:waitforsingleobject', 'kernel32:waitformultipleobjects', 'kernel32:sleep', 'kernel32:sleepex',
]);

/** Thunk names the io/stream classifier keys on (count of read-ish syscalls in the frame). */
const IO_THUNKS = ['kernel32:ReadFile', 'kernel32:ReadFileEx', 'kernel32:SetFilePointer'] as const;
const IO_OPS_PER_FRAME = 32;
const SCHED_CHURN_SWITCHES = 10;
/** A contributor must own this share of the frame before it is named as the cause. */
const CONTRIBUTOR_SHARE = 0.30;
/** Same test for the category axis; below it the frame's time is outside our categories. */
const CATEGORY_SHARE = 0.30;

const MAX_CLASSES = 64;
const MAX_CONTRIBUTORS = 192;

const CONTRIB_IO = 0;
const CONTRIB_SCHED = 1;
const CONTRIB_GUEST_CPU = 2;
const CONTRIB_OTHER = 3;          // contributor intern table full
const CONTRIB_FIXED_NAMES = ['io/stream', 'sched-churn', 'guest-cpu', 'other-thunk'];
const CONTRIB_FIRST_DYNAMIC = CONTRIB_FIXED_NAMES.length;

const CATEGORY_UNATTRIBUTED = -1;
const CLASS_OVERFLOW_KEY = -1;

export type ThunkFacts = { count: number; totalMs: number };

/** What the classifier needs about one frame. Structural, so nothing here depends on the
 *  profiler's own types (and the profiler can import this module without a cycle). */
export type FrameFacts = {
    frameMs: number;
    /** ms per category, parallel to `categoryNames`. Read, never retained. */
    categoryMs: ArrayLike<number>;
    categoryNames: readonly string[];
    thunks: ReadonlyMap<string, ThunkFacts>;
    threadSwitchCount: number;
};

export type SpikeClass<TRep> = {
    /** `<dominant category> | <top contributor>` — the coalescing key, in words. */
    signature: string;
    dominantCategory: string;
    contributor: string;
    count: number;
    /** Sum of (frameMs - budget) over the class. `exact` says whether every frame in it was
     *  actually over the budget being asked about. */
    totalMsLost: number;
    exact: boolean;
    shareOfLostPct: number;
    avgMs: number;
    worstMs: number;
    minMs: number;
    avgThreadSwitches: number;
    /** The class's worst frame, kept in full for drilling (categories + hot thunks). */
    representative: TRep | null;
};

export type SpikeClassReport<TRep> = {
    budgetMs: number;
    classifyOverMs: number;
    classifiedFrames: number;
    classifiedSumMs: number;
    /** Total ms lost against the budget across ALL classes (the ranking denominator). */
    totalMsLost: number;
    /** `partial` when over-budget frames existed that the arming threshold never saw, or when
     *  the class/contributor tables saturated. Never silently complete. */
    coverage: "complete" | "partial" | "unknown";
    coverageNote?: string;
    classes: Array<SpikeClass<TRep>>;
    /** Classes beyond `top`, folded — so the shares still add up to 100%. */
    remainder?: { classes: number; count: number; totalMsLost: number };
};

type ClassRec<TRep> = {
    categoryIndex: number;
    contributorId: number;
    count: number;
    sumMs: number;
    minMs: number;
    maxMs: number;
    sumSwitches: number;
    representative: TRep | null;
    representativeMs: number;
};

export class SpikeClassifier<TRep> {
    private classifyOverMs = 33.33;
    private readonly classes = new Map<number, ClassRec<TRep>>();
    private readonly contributorIds = new Map<string, number>();
    private readonly contributorNames: string[] = CONTRIB_FIXED_NAMES.slice();
    private classifiedFrames = 0;
    private classifiedSumMs = 0;
    private classesDropped = 0;
    private contributorsDropped = 0;

    /** Frames above this are classified. Set it to the BUDGET to get complete coverage; the
     *  default matches the profiler's capture threshold. */
    setThreshold(ms: number): void {
        if (ms > 0) this.classifyOverMs = ms;
    }

    getThreshold(): number {
        return this.classifyOverMs;
    }

    reset(): void {
        this.classes.clear();
        this.contributorIds.clear();
        this.contributorNames.length = CONTRIB_FIXED_NAMES.length;
        this.classifiedFrames = 0;
        this.classifiedSumMs = 0;
        this.classesDropped = 0;
        this.contributorsDropped = 0;
    }

    /**
     * Classify one frame. Returns false (having done one compare and nothing else) for a frame
     * at or below the threshold. `makeRepresentative` is called ONLY when this frame becomes
     * its class's worst — pass a stable bound function, not a per-frame closure.
     */
    ingest(f: FrameFacts, makeRepresentative: () => TRep): boolean {
        if (!(f.frameMs > this.classifyOverMs)) return false;

        this.classifiedFrames++;
        this.classifiedSumMs += f.frameMs;

        const categoryIndex = dominantCategory(f);
        const contributorId = this.classifyContributor(f);
        const key = categoryIndex * 1024 + contributorId;

        let rec = this.classes.get(key);
        if (!rec) {
            if (this.classes.size >= MAX_CLASSES) {
                this.classesDropped++;
                rec = this.classes.get(CLASS_OVERFLOW_KEY);
                if (!rec) {
                    rec = newClassRec<TRep>(CATEGORY_UNATTRIBUTED, CONTRIB_OTHER);
                    this.classes.set(CLASS_OVERFLOW_KEY, rec);
                }
            } else {
                rec = newClassRec<TRep>(categoryIndex, contributorId);
                this.classes.set(key, rec);
            }
        }

        rec.count++;
        rec.sumMs += f.frameMs;
        rec.sumSwitches += f.threadSwitchCount;
        if (f.frameMs < rec.minMs) rec.minMs = f.frameMs;
        if (f.frameMs > rec.maxMs) rec.maxMs = f.frameMs;
        if (f.frameMs > rec.representativeMs) {
            rec.representative = makeRepresentative();
            rec.representativeMs = f.frameMs;
        }
        return true;
    }

    /**
     * Rank classes by total time lost against `budgetMs`.
     * `overBudgetFrames` (from the distribution, which sees EVERY frame) is what makes the
     * coverage verdict possible — without it the report says `unknown` rather than implying
     * it saw everything.
     */
    report(opts: {
        budgetMs: number;
        top?: number;
        categoryNames: readonly string[];
        overBudgetFrames?: number;
    }): SpikeClassReport<TRep> {
        const budgetMs = opts.budgetMs;
        const top = Math.max(1, opts.top ?? 8);

        const rows: Array<SpikeClass<TRep>> = [];
        let totalLost = 0;
        for (const rec of this.classes.values()) {
            const lost = Math.max(0, rec.sumMs - rec.count * budgetMs);
            totalLost += lost;
            rows.push({
                signature: `${this.categoryName(rec, opts.categoryNames)} | ${this.contributorName(rec.contributorId)}`,
                dominantCategory: this.categoryName(rec, opts.categoryNames),
                contributor: this.contributorName(rec.contributorId),
                count: rec.count,
                totalMsLost: round2(lost),
                exact: rec.minMs >= budgetMs,
                shareOfLostPct: 0,
                avgMs: round2(rec.sumMs / rec.count),
                worstMs: round2(rec.maxMs),
                minMs: round2(rec.minMs),
                avgThreadSwitches: round2(rec.sumSwitches / rec.count),
                representative: rec.representative,
            });
        }
        rows.sort((a, b) => b.totalMsLost - a.totalMsLost);
        for (const r of rows) r.shareOfLostPct = totalLost > 0 ? round2((r.totalMsLost / totalLost) * 100) : 0;

        const kept = rows.slice(0, top);
        const rest = rows.slice(top);

        const notes: string[] = [];
        let coverage: SpikeClassReport<TRep>["coverage"] = "unknown";
        if (opts.overBudgetFrames === undefined) {
            notes.push("no over-budget frame count supplied, so coverage cannot be verified");
        } else if (this.classifiedFrames >= opts.overBudgetFrames) {
            coverage = "complete";
        } else {
            coverage = "partial";
            notes.push(
                `${opts.overBudgetFrames - this.classifiedFrames} of ${opts.overBudgetFrames} over-budget frames were never classified: `
                + `the classifier only sees frames > ${round2(this.classifyOverMs)}ms. `
                + `Re-arm with captureOverMs <= ${round2(budgetMs)} for complete coverage.`,
            );
        }
        if (this.classesDropped > 0) {
            coverage = "partial";
            notes.push(`${this.classesDropped} frames fell into the overflow class (class table capped at ${MAX_CLASSES})`);
        }
        if (this.contributorsDropped > 0) {
            notes.push(`${this.contributorsDropped} frames were attributed to 'other-thunk' (contributor table capped at ${MAX_CONTRIBUTORS})`);
        }
        if (rows.some((r) => !r.exact)) {
            notes.push("classes marked exact:false contain frames under the budget, so their totalMsLost is a net figure");
        }

        return {
            budgetMs: round2(budgetMs),
            classifyOverMs: round2(this.classifyOverMs),
            classifiedFrames: this.classifiedFrames,
            classifiedSumMs: round2(this.classifiedSumMs),
            totalMsLost: round2(totalLost),
            coverage,
            ...(notes.length ? { coverageNote: notes.join(" ") } : {}),
            classes: kept,
            ...(rest.length
                ? {
                    remainder: {
                        classes: rest.length,
                        count: rest.reduce((s, r) => s + r.count, 0),
                        totalMsLost: round2(rest.reduce((s, r) => s + r.totalMsLost, 0)),
                    },
                }
                : {}),
        };
    }

    private categoryName(rec: ClassRec<TRep>, names: readonly string[]): string {
        if (rec.categoryIndex === CATEGORY_UNATTRIBUTED) return "unattributed";
        return names[rec.categoryIndex] ?? `cat${rec.categoryIndex}`;
    }

    private contributorName(id: number): string {
        return this.contributorNames[id] ?? `contrib${id}`;
    }

    /** io/stream and sched-churn win over a thunk name: they are the shape of the stall,
     *  while the hottest thunk during a streaming stall is usually just ReadFile itself. */
    private classifyContributor(f: FrameFacts): number {
        let readOps = 0;
        for (const name of IO_THUNKS) readOps += f.thunks.get(name)?.count ?? 0;
        if (readOps >= IO_OPS_PER_FRAME) return CONTRIB_IO;
        if (f.threadSwitchCount >= SCHED_CHURN_SWITCHES) return CONTRIB_SCHED;

        let topName = "";
        let topMs = 0;
        for (const [name, agg] of f.thunks) {
            if (PARK_THUNKS.has(name.toLowerCase())) continue;
            if (agg.totalMs > topMs) { topMs = agg.totalMs; topName = name; }
        }
        if (!topName || topMs < f.frameMs * CONTRIBUTOR_SHARE) return CONTRIB_GUEST_CPU;

        const known = this.contributorIds.get(topName);
        if (known !== undefined) return known;
        if (this.contributorNames.length >= MAX_CONTRIBUTORS) {
            this.contributorsDropped++;
            return CONTRIB_OTHER;
        }
        const id = this.contributorNames.length;
        this.contributorNames.push(topName);
        this.contributorIds.set(topName, id);
        return id;
    }
}

/** Largest category, ignoring idle (a yield is not a cause). CATEGORY_UNATTRIBUTED when no
 *  category owns a meaningful share — i.e. the time was spent somewhere we do not measure. */
function dominantCategory(f: FrameFacts): number {
    let best = CATEGORY_UNATTRIBUTED;
    let bestMs = 0;
    for (let i = 0; i < f.categoryNames.length; i++) {
        if (f.categoryNames[i] === "idle") continue;
        const ms = f.categoryMs[i] ?? 0;
        if (ms > bestMs) { bestMs = ms; best = i; }
    }
    return bestMs >= f.frameMs * CATEGORY_SHARE ? best : CATEGORY_UNATTRIBUTED;
}

function newClassRec<TRep>(categoryIndex: number, contributorId: number): ClassRec<TRep> {
    return {
        categoryIndex, contributorId,
        count: 0, sumMs: 0, minMs: Infinity, maxMs: 0, sumSwitches: 0,
        representative: null, representativeMs: 0,
    };
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}
