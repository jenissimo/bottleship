/**
 * A D3D9 LockRect must hand back the pixels that were rendered — and a screenshot cannot tell.
 *
 * Runs the D3D9 lock/readback assertions against our own d3d9 implementation with NO game
 * bundle: the scene calls the d3d9 thunk table directly, so it creates a device, a render
 * target and a SYSTEMMEM staging surface, clears, and reads back through the real
 * GetRenderTargetData and LockRect paths. Implementation:
 * `src/worker/harness/cmds/d3d9-conformance.ts`.
 *
 * Every assertion is then SHOWN capable of failing: the scene re-runs once per injected bug
 * and each mutation must break the rows it names. A mutation that changes nothing means the
 * assertion is not watching what it claims, so this script fails on that too — `bun test`
 * cannot check this, because the whole point is the live GPU readback path.
 *
 *   bun tools/harness.ts run tools/harness/regression/d3d9-lock-conformance.harness.ts
 *   SKIP_MUTATIONS=1 …   clean pass only (faster; drops the can-it-fail proof)
 */

import { mutationVerdict } from "../../../src/worker/harness/cmds/d3d9-conformance-eval";
import { harness } from "../../harness";

interface Check { name: string; source: string; expected: string; observed: string; pass: boolean; note?: string }
interface Result {
    checks: Check[]; passed: number; failed: number;
    mutation: string | null;
    setup: Record<string, string | number>;
}

const run = async (mutate: string | null): Promise<Result> => {
    const r: any = await harness().call("d3d9Conformance", mutate ? { mutate } : {}).run();
    const res = r.steps?.find((s: any) => s.cmd === "d3d9Conformance")?.result as Result | undefined;
    if (!res) throw new Error(`d3d9Conformance returned nothing (${JSON.stringify(r.steps?.[0] ?? null)})`);
    return res;
};

const table = (checks: Check[]): void => {
    const w = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) {
        console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}  expected ${c.expected}  observed ${c.observed}`);
        if (c.note) console.log(`        ${c.note}`);
        if (!c.pass) console.log(`        ${c.source}`);
    }
};

// ── clean run ───────────────────────────────────────────────────────────────────────
const clean = await run(null);
console.log(`[d3d9-conformance] setup: ${JSON.stringify(clean.setup)}`);
table(clean.checks);
console.log(`[d3d9-conformance] ${clean.passed}/${clean.checks.length} conformance rows pass`);

// ── can each assertion fail? ────────────────────────────────────────────────────────
const blind: string[] = [];
if (!process.env.SKIP_MUTATIONS) {
    const mutations: { name: string; how: string; groups: string[] }[] =
        (await harness().call("d3d9ConformanceMutations").run() as any)
            .steps?.find((s: any) => s.cmd === "d3d9ConformanceMutations")?.result ?? [];
    for (const m of mutations) {
        const res = await run(m.name);
        // Judge against the CLEAN run: a row that was already red proves nothing.
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
    console.log(`\nFAIL: ${clean.failed} conformance row(s) — a D3D9 lock is not serving rendered pixels`);
    process.exit(1);
}
if (blind.length) {
    console.log(`\nFAIL: ${blind.length} mutation(s) changed nothing — those assertions are not watching what they claim:`);
    for (const b of blind) console.log(`  ${b}`);
    process.exit(2);
}
console.log("\nOK — every D3D9 lock assertion holds, and each one was shown able to fail");
