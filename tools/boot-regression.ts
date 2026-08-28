#!/usr/bin/env bun
/**
 * Multi-title boot regression runner.
 *
 * The locale/CRT/heap fast paths and the inline x86 stubs are GENERIC — they change
 * behaviour for every title, not for the one whose profile motivated them. So anything
 * landing on those paths runs this before and after, and the answer is a per-title
 * verdict, not a wall of numbers.
 *
 * Counts, never timings: a hit count survives the CPU contention that makes wall-clock
 * useless while another agent's guest is open, so this can run on a shared box. The
 * window is a fixed wall-clock slice per title — comparable in SHAPE (which thunks
 * dominate, which tier absorbed them), not as a per-second rate.
 *
 * Judgements per title:
 *   - reaches a bright frame              (expectSurfaceNonBlack)
 *   - report().crash is null
 *   - report().stubs gains no NEW unimplemented export vs the baseline
 *   - fsIoReport() actually measured (census enabled, reads > 0) and armsSumOk with
 *     armUnattributed === 0
 *
 * Usage:
 *   bun tools/boot-regression.ts                       # run + judge against the baseline
 *   bun tools/boot-regression.ts --save-baseline       # record today's stubs as the baseline
 *   GAMES=a.wgb,b.wgb bun tools/boot-regression.ts     # explicit title list
 *
 * Env / flags: GAMES, WGB_ROOT (default G:/WGB/running), WAIT_S (default 40),
 *              OUT (jsonl), BASELINE (json).
 */
import { harness } from "./harness";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = new Set(process.argv.slice(2));
const saveBaseline = argv.has("--save-baseline");

const WGB_ROOT = process.env.WGB_ROOT ?? "G:/WGB/running";
/** The titles that exercise the changed paths hardest, hardest-first. Overridable via
 *  GAMES; a name without a separator is resolved under WGB_ROOT. */
const DEFAULT_TITLES = [
    "house-1000-doors.wgb",   // locale/CRT — the setlocale storm
    "morrowind.wgb",          // locale/CRT
    "painkiller.wgb",         // heap / VirtualQuery
    "gta3-ru.wgb",            // input
    "farcry.wgb",             // d3d9 caps + the ROM read window
];

const titles = (process.env.GAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const games = (titles.length ? titles : DEFAULT_TITLES)
    .map((g) => (g.includes("/") || g.includes("\\") ? g : `${WGB_ROOT}/${g}`));

const waitS = Number(process.env.WAIT_S ?? 40);
const out = process.env.OUT ?? "logs/boot-regression.jsonl";
const baselinePath = process.env.BASELINE ?? "tools/boot-regression.baseline.json";

interface Baseline { [game: string]: { stubs: string[] } }
const baseline: Baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : {};
if (!existsSync(baselinePath) && !saveBaseline) {
    console.log(`[boot-regression] no baseline at ${baselinePath} — NEW-stub judgement will be skipped.`);
}

mkdirSync(dirname(out), { recursive: true });

const nextBaseline: Baseline = {};
const verdicts: Array<{ game: string; ok: boolean; failures: string[] }> = [];

for (const game of games) {
    const name = game.split("/").pop()?.replace(".wgb", "") ?? game;
    const failures: string[] = [];
    try {
        await harness().openWgb(game).run();
        await harness().call("slowPathThunks", { enable: true, reset: true }).run();
        await harness().sleep(waitS * 1000).run();

        // expectSurfaceNonBlack is a judgement, not a reading: it throws when the screen
        // is black, so keep it out of the batch whose numbers we still want on failure.
        let bright = true;
        try {
            await harness().expectSurfaceNonBlack("primary").run();
        } catch (e) {
            bright = false;
            failures.push(`black screen: ${String(e).slice(0, 120)}`);
        }

        const r = await harness()
            .call("slowPathThunks", { top: 25 })
            .call("fsIoReport", { top: 0 })
            .call("localeStubStats")
            .call("mbwcStubStats")
            .call("report")
            .run();
        const n = r.named as any;
        const sp = n.slowPathThunks ?? {};
        const rows: Array<{ name: string; hits: number }> = sp.rows ?? [];
        const io = n.fsIoReport ?? {};
        const stubs: string[] = (n.report?.stubs ?? []).map((s: any) => s?.name ?? String(s));
        nextBaseline[name] = { stubs: [...stubs].sort() };

        if (n.report?.crash) failures.push(`crash: ${JSON.stringify(n.report.crash).slice(0, 200)}`);
        // A census that is off, or that saw no read at all, cannot vouch for the ladder — and
        // its zeros are byte-identical to a clean boot. Both are failures, not passes.
        if (io.enabled === false) failures.push("fsIoReport: census disabled — the I/O judgement measured nothing");
        else if (io.armsSumOk === null || io.armsSumOk === undefined) failures.push(`fsIoReport: no reads recorded (reads=${io.reads ?? "n/a"}) — nothing was judged`);
        else if (io.armsSumOk === false) failures.push("fsIoReport.armsSumOk false");
        if ((io.armUnattributed ?? 0) !== 0) failures.push(`armUnattributed=${io.armUnattributed}`);
        const known = baseline[name]?.stubs;
        if (known) {
            const fresh = stubs.filter((s) => !known.includes(s));
            if (fresh.length) failures.push(`new unimplemented: ${fresh.join(", ")}`);
        }

        const row = {
            game: name, windowS: waitS, bright,
            slowPathTotal: sp.total ?? null,
            top: rows.slice(0, 12),
            localeStub: n.localeStubStats ?? null,
            mbwcStub: n.mbwcStubStats ?? null,
            io: { reads: io.reads, MB: io.bytesMB, syncMs: io.syncMs, asyncMs: io.asyncMs, fallbacks: io.asyncFallbacks },
            crash: n.report?.crash ?? null,
            stubs: stubs.slice(0, 8),
            failures,
        };
        appendFileSync(out, JSON.stringify(row) + "\n");
        const ls = n.localeStubStats;
        const ms = n.mbwcStubStats;
        console.log(`${name.padEnd(24)} ${failures.length ? "FAIL" : "ok  "} ` +
            `slowPath=${String(row.slowPathTotal).padEnd(8)} ` +
            `locale=${ls?.installed ? `${ls.answered}/${ls.bailed}` : "off"} ` +
            `mbwc=${ms?.installed ? `${ms.mbToWc.answered}+${ms.wcToMb.answered}/${ms.mbToWc.bailed + ms.wcToMb.bailed}` : "off"} ` +
            `${failures.join(" | ")}`);
    } catch (e) {
        failures.push(`runner error: ${String(e).slice(0, 200)}`);
        appendFileSync(out, JSON.stringify({ game: name, failures }) + "\n");
        console.log(`${name.padEnd(24)} ERROR ${String(e).slice(0, 140)}`);
    }
    verdicts.push({ game: name, ok: failures.length === 0, failures });
}

if (saveBaseline) {
    writeFileSync(baselinePath, JSON.stringify(nextBaseline, null, 2) + "\n");
    console.log(`[boot-regression] baseline written: ${baselinePath}`);
}

const failed = verdicts.filter((v) => !v.ok);
console.log(`\n${verdicts.length - failed.length}/${verdicts.length} titles clean`);
process.exit(failed.length ? 1 : 0);
