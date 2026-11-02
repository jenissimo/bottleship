import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const bun = process.execPath;
const lpFast = resolve(root, "tools/lan-conformance/probe/lp-fast.ts");

// Single-process Winsock cases: the same committed native golden that the
// PE-based lan-diff check compares against must also be reproduced by the
// in-bun interpreter, so the conformance cases guard the fast path and the
// fast path guards the cases between browser runs.
const FAST_CASES = ["udp/connreset", "udp/fionread", "udp/truncation", "tcp/select"];

for (const caseId of FAST_CASES) {
    test(`lanprobe fast path matches the native golden: ${caseId}`, () => {
        const run = spawnSync(bun, [lpFast, "check", caseId], { cwd: root, encoding: "utf8", timeout: 120_000 });
        if (run.status !== 0) {
            throw new Error(`fast path diverged from the native golden:\n${run.stdout}\n${run.stderr}`);
        }
        expect(run.stdout).toContain(`OK ${caseId}`);
    }, 130_000);
}
