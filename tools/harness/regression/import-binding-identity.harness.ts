/**
 * One address per export: what an importer's IAT is bound to must be what
 * GetProcAddress hands back for the same name.
 *
 * The wrappers these titles ship (ASI/mod loaders, ddraw and d3d shims) install
 * their hooks by scanning an IAT for the value GetProcAddress just gave them. A
 * second address for one export makes every such hook install nothing, with no
 * error and no log line — GTA III's whole scripts/ ecosystem (dx8to9, the RU font
 * patcher) went dark that way while the game itself ran fine.
 *
 * Bundle-agnostic: any title that imports from an HLE module exercises it. Pass
 * WGB to point it somewhere else. `__noImageIatBinding` is the positive control —
 * with it set this script MUST fail, which is what makes a passing run mean
 * something.
 *
 * Prereqs: `bun tools/harness.ts up`.
 */
import { harness } from "../../harness";

const negative = process.env.NEGATIVE === "1";

const result: any = await harness()
    .call("reload")
    .call("setWorkerFlag", "__noImageIatBinding", negative)
    .openWgb(process.env.WGB ?? "/apps/control_zoo.wgb", { reload: false })
    // No wait: every import is bound during the load itself, so the audit is meaningful
    // the moment openWgb returns. Deliberately NOT tickFrames — a Win32 front-end like the
    // control zoo presents nothing, and waiting on presents that never come reads exactly
    // like a hang.
    .call("importAudit", 10)
    .run();

if (result.ok === false) {
    console.log(`REGRESSION: the run did not reach the audit — ${result.error?.cmd}: ${result.error?.message}`);
    process.exit(1);
}
const audit = result.named?.importAudit;
console.log(`imports=${audit?.imports} matching=${audit?.matching} diverged=${audit?.divergedCount} `
    + `guestHooked=${audit?.guestHooked} inlineFastPath=${audit?.inlineFastPath}`);

if (!audit || !(audit.imports > 0)) {
    console.log("REGRESSION: the audit saw no thunked imports at all — it cannot have checked anything");
    process.exitCode = 1;
} else if (negative) {
    if (audit.divergedCount === 0) {
        console.log("REGRESSION: the positive control passed — the audit cannot fail and proves nothing");
        process.exitCode = 1;
    } else {
        console.log(`positive control OK: ${audit.divergedCount} diverged imports with __noImageIatBinding set`);
    }
} else if (audit.divergedCount !== 0) {
    console.log("REGRESSION: imports bound to a different stub than GetProcAddress returns — "
        + "IAT-hooking wrappers will silently install nothing");
    console.log(JSON.stringify(audit.diverged, null, 2));
    process.exitCode = 1;
}
