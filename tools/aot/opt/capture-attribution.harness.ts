/**
 * P0 attribution capture for the optimizing-translator track.
 *
 * The kernel inventory picks `k3`/`k4` from a byte-exact retail corpus, but a corpus entry is
 * an identity, not a share of CPU time. The plan's P0 gate needs the second thing: the measured
 * fraction of guest execution the candidate pages actually carry, in a REAL scene. Without it
 * `S` in `1/((1-S)+S/X+C)` is unknown and the P2 mechanism would be chosen blind.
 *
 * Three windows, deliberately separate, because they cannot share one:
 *
 *   1. clean   — disarmed `frameReport`, the only place a tail/fps may be quoted from.
 *   2. counted — `guestBlocks` armed on the corpus pages plus v86's own tier-2 set. Arming
 *                instruments every block on an armed page, so this window is SLOWER by
 *                construction; its numbers are counts, never time.
 *   3. sampled — the time-weighted channel, collected in its own window.
 *
 * The scene is reached by replaying a recorded human run (`logs/recordings/nfsu-to-race.json`)
 * gated on present serial, not by mashing keys on a wall-clock schedule: two runs of a key
 * script land in different places, and the whole point here is a repeatable denominator.
 *
 *   WGB=G:/WGB/running/nfs-underground.wgb \
 *   REC=logs/recordings/nfsu-to-race.json \
 *   OUT=tmp/p0-attribution.json \
 *   bun tools/aot/opt/capture-attribution.harness.ts
 *
 * Every refusal is recorded as a refusal. A window that could not be collected is `unavailable`
 * with its reason; it never degrades into a zero that reads like a measurement.
 */
import { harness } from "../../harness";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const WGB = process.env.WGB ?? "G:/WGB/running/nfs-underground.wgb";
const REC = process.env.REC ?? "logs/recordings/nfsu-to-race.json";
const OUT = process.env.OUT ?? "tmp/p0-attribution.json";
const FIXTURE = process.env.FIXTURE ?? "nfsu-max";
/** Boot + replay span. The recording is frame-gated, so this is an upper bound to wait out. */
const REPLAY_MS = Number(process.env.REPLAY_MS ?? 240_000);
const CLEAN_MS = Number(process.env.CLEAN_MS ?? 12_000);
const COUNTED_MS = Number(process.env.COUNTED_MS ?? 12_000);
const SAMPLED_MS = Number(process.env.SAMPLED_MS ?? 8_000);
/** A harness step is capped at 60 s; longer waits must be chunked or the run fails. */
const STEP_CAP_MS = 55_000;

/** Retail Speed.exe VAs from tools/aot-oracle/corpus/kernels.mjs. Named so a share is a share
 *  of an identified function, not of "a page that happened to be hot". */
const CORPUS = [
    { name: "k3", va: 0x005d4f87, len: 16 },
    { name: "k4", va: 0x005cbd78, len: 82 },
    { name: "k5", va: 0x00674b94, len: 27 },
] as const;
/**
 * Pages the sampled channel named in the first in-race capture of 2026-09-05. They are armed
 * explicitly because v86's tier-2 page ENUMERATION reported 0 pages in that session, so the
 * census could not select the hot set on its own; naming them is the difference between a
 * census of 0.03% of guest work and one of 77%.
 */
const MEASURED_HOT_PAGES = [
    0x585000, 0x684000, 0x654000, 0x63e000, 0x649000, 0x647000,
    0x64a000, 0x641000, 0x40a000, 0x64b000, 0x668000, 0x5db000, 0x5ca000,
];
/** Named ranges arm their own pages, so listing the corpus pages again only wastes slots. */
const ARM_PAGES = MEASURED_HOT_PAGES;

type Json = Record<string, unknown>;

function fail(stage: string, why: string): never {
    console.error(`FAILED at ${stage}: ${why}`);
    process.exit(1);
}

async function chunkedSleep(totalMs: number): Promise<void> {
    for (let left = totalMs; left > 0; left -= STEP_CAP_MS) {
        await harness().sleep(Math.min(STEP_CAP_MS, left)).run();
    }
}

/** One harness command, with the run's own failure surfaced rather than swallowed. */
async function call(cmd: string, ...args: unknown[]): Promise<any> {
    const r: any = await harness().call(cmd, ...args).run();
    if (!r.ok) throw new Error(`${cmd}: ${r.error?.message ?? "run failed"}`);
    return (r.steps ?? []).filter((s: any) => s.cmd === cmd).at(-1)?.result;
}

const started = new Date().toISOString();

// ── provenance ────────────────────────────────────────────────────────────────────────────
function git(...args: string[]): string | null {
    try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return null; }
}
const provenance: Json = {
    captured_at: started,
    tool: "tools/aot/opt/capture-attribution.harness.ts",
    tool_version: 1,
    git_head: git("rev-parse", "HEAD"),
    git_dirty: (git("status", "--porcelain") ?? "").length > 0,
    v86_submodule: git("-C", "vendor/v86", "rev-parse", "HEAD"),
    wgb: WGB,
    recording: REC,
    fixture: FIXTURE,
    windows_ms: { replay: REPLAY_MS, clean: CLEAN_MS, counted: COUNTED_MS, sampled: SAMPLED_MS },
};

// ── 1. deterministic entry ────────────────────────────────────────────────────────────────
let samples: unknown;
try {
    samples = JSON.parse(readFileSync(REC, "utf8"));
} catch (e) {
    fail("recording", `cannot read ${REC}: ${(e as Error).message}`);
}
if (!Array.isArray(samples) || samples.length === 0) {
    fail("recording", `${REC} is not a non-empty sample array — hostReplay would silently do nothing`);
}

// The fixture is a CLI command, not a DSL verb: calling it through .call() restores nothing
// and the run then measures DEFAULT detail while claiming max.
console.log(`[1/5] restoring fixture ${FIXTURE}…`);
try {
    const out = execFileSync("bun", ["tools/harness.ts", "fixture", "restore", FIXTURE], { encoding: "utf8" });
    console.log(`      ${out.trim().split("\n").at(-1)}`);
} catch (e) {
    fail("fixture", `restore ${FIXTURE} failed: ${(e as Error).message}`);
}

console.log(`[2/5] booting ${WGB} and replaying ${(samples as unknown[]).length} input samples…`);
const boot: any = await harness()
    .call("resetWorkerFlags", [])
    .reload()
    .call("openWgb", WGB, { reload: false })
    .call("hostReplay", samples, { deterministic: true })
    .run();
if (!boot.ok) fail("boot", boot.error?.message ?? "openWgb/hostReplay failed");
await chunkedSleep(REPLAY_MS);

// A scene that is not moving is a menu or a load screen, whatever the game. Quoting a census
// from one and calling it "in race" is exactly the failure this check exists to prevent.
const scene = await call("sceneProbe", { samples: 5, gapMs: 300 });
console.log(`      scene motion=${scene?.motion} draws=${scene?.submit?.after?.draws ?? "?"}`);
// EVERY sample must move, not the mean of them. One transient frame (a fade, a cursor, a
// re-render) drags a mean over a static screen above any threshold, which is exactly how a menu
// scored 0.72 and passed a `motion > 0.5` gate.
const perSample: number[] = Array.isArray(scene?.motionPerSample) ? scene.motionPerSample : [];
const MOVING = 0.5;
const inScene = perSample.length >= 3 && perSample.every((m) => m > MOVING);
if (!inScene && process.env.ALLOW_STATIC !== "1") {
    fail("scene", `motion=${scene?.motion} perSample=${JSON.stringify(perSample)} — the replay did not `
        + `reach a scene where EVERY sample exceeds ${MOVING}. Re-record the entry, or set `
        + "ALLOW_STATIC=1 to capture a static screen deliberately.");
}
await call("shot", { save: "p0-attribution-scene" });

// ── 2. clean window (the only quotable timing) ────────────────────────────────────────────
console.log(`[3/5] clean disarmed window (${CLEAN_MS} ms)…`);
await call("frameReport", { reset: true, budgetMs: 33.34 });
await chunkedSleep(CLEAN_MS);
const clean = await call("frameReport", {});

// ── 3. counted census, armed ──────────────────────────────────────────────────────────────
console.log(`[4/5] counted census armed on ${ARM_PAGES.length} measured-hot pages + the corpus ranges…`);
const ranges = CORPUS.map((k) => ({ name: k.name, from: k.va, to: k.va + k.len }));
const armed = await call("guestBlocks", { phase: "arm", pages: ARM_PAGES, ranges, maxPages: 64 });
let counted: Json;
if (!armed?.armed) {
    counted = { available: false, reason: armed?.refused ?? "arm refused without a reason" };
    console.log(`      ARM REFUSED: ${JSON.stringify(armed?.refused)}`);
} else {
    await chunkedSleep(COUNTED_MS);
    const read = await call("guestBlocks", { phase: "read", top: 60, keepArmed: false });
    const c = read?.counted;
    // The census refuses by design when it cannot date its own counters; that refusal is the
    // result, not a reason to fall through to a ranking of unknown age.
    counted = c?.available === false
        ? { available: false, reason: c.note ?? "census refused without a reason", window: c.window ?? null }
        : { available: true, ...c };
}

// ── 4. sampled (time-weighted) channel, its own window ────────────────────────────────────
console.log(`[5/5] sampled time-weighted window (${SAMPLED_MS} ms)…`);
const sampledRun = await call("guestBlocks", { ms: SAMPLED_MS, intervalMs: 5, top: 40, pages: ARM_PAGES, ranges });
const sampled: Json = sampledRun?.sampled?.available === false
    ? { available: false, reason: sampledRun.sampled.note ?? "sampler returned no rows" }
    : { available: true, ...sampledRun?.sampled, crossCheck: sampledRun?.crossCheck ?? null };

// ── result ────────────────────────────────────────────────────────────────────────────────
const modules = await call("dbgCall", "modules").catch(() => null);
const result = {
    schema: { name: "bottleship.aot.opt.p0-attribution", version: 1 },
    // A requested page that was never armed makes `blocks: 0` mean "never instrumented", which
    // is the one condition that would invalidate the whole corpus-share conclusion. It gates the
    // status rather than being printed and hoped for.
    status: counted.available === true
        && !((counted as any).window?.requestedPagesDropped > 0)
        && !((counted as any).window?.selectionWarning)
        ? "ok"
        : "partial",
    provenance,
    scene: {
        motion: scene?.motion ?? null,
        brightness: scene?.brightness ?? null,
        fingerprint: scene?.fingerprint ?? null,
        motion_per_sample: perSample,
        moving_threshold: MOVING,
        submit: scene?.submit ?? null,
        moving: inScene,
    },
    clean_window: {
        note: "the ONLY window a tail/fps may be quoted from; collected disarmed",
        tail: clean?.tail ?? null,
        frames: clean?.frames ?? null,
        raw: clean ?? null,
    },
    corpus: CORPUS.map((k) => ({ ...k, page: k.va & ~0xfff, page_hex: `0x${(k.va & ~0xfff).toString(16).padStart(8, "0")}` })),
    counted_window: counted,
    sampled_window: sampled,
    modules: modules ?? null,
    caveats: [
        "counted_window was collected under trace2 arming: it is SLOWER than the clean window by construction. Counts only.",
        "sampled_window is yield-point sampling correlated to module+rva; it ranks where the worker parks, not elapsed kernel time.",
        "A range roll-up attributes a block by its ENTRY address, so a block entered before a range under-states it.",
    ],
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2));

// ── console summary ───────────────────────────────────────────────────────────────────────
const rr = (counted as any)?.ranges;
console.log("\n=== P0 attribution ===");
console.log(`scene: motion=${result.scene.motion} moving=${inScene}`);
console.log(`clean frame p50=${clean?.tail?.p50Ms} p95=${clean?.tail?.p95Ms}`);
if (rr?.rows?.length) {
    // sharePctOfGuest is the go/no-go number: the share of ALL retired guest work, not of the
    // armed subset. sharePct alone can be several times larger and means nothing for `S`.
    console.log("named corpus ranges:");
    for (const row of rr.rows) {
        console.log(`  ${String(row.name).padEnd(4)} blocks=${String(row.blocks).padStart(4)} exec=${String(row.exec).padStart(12)}`
            + ` weightedIns=${String(row.weightedIns).padStart(14)} shareOfArmed=${row.sharePct}% shareOfGuest=${row.sharePctOfGuest ?? "n/a"}%`);
    }
    console.log(`  unattributed (of armed): ${JSON.stringify(rr.unattributed)}`);
    if (rr.shadowed) console.log(`  SHADOWED (0 means nothing at all): ${rr.shadowed.join(", ")}`);
    if (rr.unresolved) console.log(`  UNRESOLVED: ${rr.unresolved.join(", ")}`);
    const w: any = (counted as any).window ?? {};
    if (w.requestedPagesDropped) console.log(`  WARNING: ${w.requestedPagesDroppedWarning}`);
    if (w.selectionWarning) console.log(`  WARNING: ${w.selectionWarning}`);
    // Coverage comes from the census's OWN total, not from the rows it returned: `rows` is the
    // top-N slice, so summing it answers "how much do the biggest N blocks carry", which is a
    // different question wearing the same units.
    const c = counted as any;
    console.log(`  window: elapsed=${w.elapsedMs}ms retiredIns=${w.retiredIns} armedPages=${w.watchedPages}`);
    console.log(`  census coverage: ${c.totalWeightedIns} weightedIns = ${c.countedCoveragePct}% of retired guest work`
        + `  (rows shown: ${(c.rows ?? []).length} of ${c.blocks ?? "?"})`);
} else {
    console.log(`named corpus ranges: UNAVAILABLE (${(counted as any).reason ?? "no roll-up in the census"})`);
}
// What is ACTUALLY hot matters as much as whether the corpus is: if k3 carries a negligible
// share, the next kernel has to come from this ranking rather than from the corpus we already had.
const topRows = (counted as any)?.rows ?? [];
if (topRows.length) {
    console.log("\ntop counted blocks (share of the ARMED census):");
    for (const row of topRows.slice(0, 15)) {
        console.log(`  ${String(row.addr ?? row.entry).padEnd(12)} ${String(row.module ?? "?").padEnd(14)}`
            + ` exec=${String(row.exec).padStart(10)} ins=${String(row.ins ?? row.instructions).padStart(4)}`
            + ` ${(row.weightedIns / ((counted as any).window?.retiredIns || 1) * 100).toFixed(3)}% of guest`);
    }
}
console.log(`\nwritten: ${OUT}`);
process.exit(result.status === "ok" ? 0 : 2);
