/**
 * A DDraw Lock must never serve a stale frame — and a screenshot cannot tell.
 *
 * Runs the Wine ddraw7 read-lock assertions against our own DDraw/D3D7 implementation with
 * NO game bundle: the scene calls the ddraw thunk table directly, so it stands up a flip
 * chain, draws, flips, draws again and reads back through the real Lock path. The statements
 * are `test_flip_3d` (ddraw7.c:20301-20347), `get_surface_color` (453-474), the
 * `test_sysmem_x_channel` colour fill (20639-20679) and Lock exclusivity (14292-14300); the
 * implementation lives in `src/worker/harness/cmds/ddraw-conformance.ts`.
 *
 * Every assertion is then SHOWN capable of failing: the scene re-runs once per injected bug
 * and each mutation must break the rows it names. A mutation that changes nothing means the
 * assertion is not watching what it claims, so this script fails on that too — `bun test`
 * cannot check this, because the whole point is the live GPU readback path.
 *
 *   bun tools/harness.ts run tools/harness/regression/ddraw-lock-conformance.harness.ts
 *   SKIP_MUTATIONS=1 …   clean pass only (faster; drops the can-it-fail proof)
 */

import { mutationVerdict } from "../../../src/worker/harness/cmds/ddraw-conformance-eval";
import { harness } from "../../harness";

interface Check { name: string; wine: string; expected: string; observed: string; pass: boolean; note?: string }
interface Result {
    checks: Check[]; passed: number; failed: number;
    mutation: string | null;
    setup: Record<string, string | number>;
}

const run = async (mutate: string | null): Promise<Result> => {
    const r: any = await harness().call("ddrawConformance", mutate ? { mutate } : {}).run();
    const res = r.steps?.find((s: any) => s.cmd === "ddrawConformance")?.result as Result | undefined;
    if (!res) throw new Error(`ddrawConformance returned nothing (${JSON.stringify(r.steps?.[0] ?? null)})`);
    return res;
};

const table = (checks: Check[]): void => {
    const w = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) {
        console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}  expected ${c.expected}  observed ${c.observed}`);
        if (!c.pass && c.note) console.log(`        ${c.note}`);
        if (!c.pass) console.log(`        ${c.wine}`);
    }
};

// ── clean run ───────────────────────────────────────────────────────────────────────
const clean = await run(null);
console.log(`[ddraw-conformance] setup: ${JSON.stringify(clean.setup)}`);
table(clean.checks);
console.log(`[ddraw-conformance] ${clean.passed}/${clean.checks.length} conformance rows pass`);

// ── can each assertion fail? ────────────────────────────────────────────────────────
const blind: string[] = [];
if (!process.env.SKIP_MUTATIONS) {
    const mutations: { name: string; how: string; groups: string[] }[] =
        (await harness().call("ddrawConformanceMutations").run() as any)
            .steps?.find((s: any) => s.cmd === "ddrawConformanceMutations")?.result ?? [];
    for (const m of mutations) {
        const res = await run(m.name);
        // Judge against the CLEAN run: a row that was already red proves nothing, and
        // counting it would turn "the suite is red" into "every mutation is caught".
        const { caught, blind: missed, unprovable } =
            mutationVerdict(clean.checks as any, res.checks as any, m.name as any);
        const broke = (clean.checks as any[])
            .filter((c) => c.pass && res.checks.some((r) => r.name === c.name && !r.pass))
            .map((c) => c.name);
        const verdict = missed.length ? "BLIND  " : (caught.length ? "PROVEN " : "UNPROVABLE");
        console.log(`[mutation] ${verdict} ${m.name}: ${m.how}`);
        console.log(`           broke (was green, now red): ${broke.length ? broke.join(", ") : "nothing"}`);
        if (unprovable.length) {
            console.log(`           unprovable — already red before the mutation: ${unprovable.join(", ")}`);
        }
        if (missed.length) blind.push(`${m.name} (groups still green: ${missed.join(", ")})`);
    }
}

if (clean.failed) {
    console.log(`\nFAIL: ${clean.failed} conformance row(s) — our implementation does not satisfy Wine here`);
    process.exit(1);
}
if (blind.length) {
    console.log(`\nFAIL: ${blind.length} mutation(s) changed nothing — those assertions are not watching what they claim:`);
    for (const b of blind) console.log(`  ${b}`);
    process.exit(2);
}
console.log("\nOK — every Wine assertion holds, and each one was shown able to fail");
