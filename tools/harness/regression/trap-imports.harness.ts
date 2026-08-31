/**
 * No import may be bound to the shared missing-import trap.
 *
 * An import the loader could not resolve gets one UD2 stub, and nothing says so until
 * the guest calls the slot — then it is an illegal instruction inside whatever ran
 * first (typically a static constructor), with the unresolved name nowhere in the
 * crash report. XIII bound every `Xiii.dll` import that way, because the registry key
 * dropped the extension and XIII.exe owned "xiii"; it died in xidpawn.dll's ctors
 * with an EIP nobody could attribute.
 *
 * Bundle-agnostic: every title imports something. Point WGB at any bundle.
 *
 * No frame ticks — imports are bound during the load itself, and a trapped slot
 * crashes the guest long before any frame count would elapse.
 *
 * Prereqs: `bun tools/harness.ts up`.
 * e.g. WGB=G:/WGB/todo/xiii.wgb bun tools/harness.ts run tools/harness/regression/trap-imports.harness.ts
 */
import { harness } from "../../harness";

const result: any = await harness()
    .call("reload")
    .openWgb(process.env.WGB ?? "/apps/control_zoo.wgb", { reload: false })
    .call("trapImports", 20)
    .run();

if (result.ok === false) {
    console.log(`REGRESSION: the run did not reach the audit — ${result.error?.cmd}: ${result.error?.message}`);
    process.exit(1);
}

const audit = result.named?.trapImports;
if (!audit || audit.error) {
    console.log(`REGRESSION: trapImports did not run — ${audit?.error ?? "no result"}`);
    process.exit(1);
}
// An audit that walked nothing reports 0 trapped for the one reason it cannot see any.
if (!(audit.imports > 0) || audit.unreadable > 0) {
    console.log(`REGRESSION: the audit saw ${audit.imports} imports across ${audit.modules} modules `
        + `(${audit.unreadable} unreadable) — 0 trapped is not evidence here`);
    process.exit(1);
}

if (audit.trapped > 0) {
    console.log(`REGRESSION: ${audit.trapped} of ${audit.imports} imports are bound to the trap stub `
        + `${audit.trapStub} — ${JSON.stringify(audit.byDll)}`);
    for (const r of audit.rows) console.log(`  ${r.module} <- ${r.dll}:${r.name}`);
    process.exit(1);
}

console.log(`OK: ${audit.imports} imports across ${audit.modules} modules, none bound to the trap stub`);
