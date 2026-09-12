/**
 * One arm of the guarded-kernel A/B over a game's load.
 *
 * Both arms are the SAME binary with the kernels flipped through `kernelSwitch`, so no
 * build difference can be mistaken for the effect — the confound the upstream work had to
 * rebuild a byte-identical control to rule out.
 *
 * The endpoint is the guest's FIRST PRESENT, which the guest decides and we only observe,
 * so both arms stop after identical guest work and the only variable is how long we took
 * to do it. Wall clock is taken by the CALLER around the whole invocation: it is the same
 * measurement for both arms, and anything it includes that the kernels cannot affect only
 * dilutes a real difference rather than inventing one.
 *
 * ARM=on|off, WGB=<bundle>, WARMUP/SEGMENT=<retired insns>, TIMEOUT=<ms>. One JSON line per run.
 */
import { harness } from "../harness";

const bundle = process.env.WGB;
if (!bundle) throw new Error("WGB is required");
const on = (process.env.ARM ?? "on") !== "off";
const timeoutMs = Number(process.env.TIMEOUT ?? 420_000);
const warmup = Number(process.env.WARMUP ?? 1_000_000_000);
// ADDITIONAL instructions after the warm-up, not a cumulative total: `retired()`
// counts from the start of its own wait.
const segment = Number(process.env.SEGMENT ?? 1_000_000_000);

const kernels = { bulk: on, rep: on, unalignedRep: on, string: on };

const out = await harness()
    .openWgb(bundle)
    // Pause immediately: the switch has to be in place before the guest does the work being
    // measured. A load of this length loses well under a percent to the gap.
    .pause()
    .call("kernelSwitch", kernels)
    .resume()
    // Two segments, and only the second is timed. The first billion instructions run at
    // ~42 MIPS because the guest is streaming the bundle off disk with a cold JIT; the next
    // billion runs at ~240 MIPS with both warm. Timing the whole thing therefore measures
    // mostly disk, dilutes any real difference several-fold, and is the reason a first pass
    // here read as "no effect".
    //
    // `retired()` counts from the start of ITS OWN wait, so the second call measures exactly
    // the instructions between the two targets. The predicate crosses to the worker as
    // SOURCE, so each target is inlined rather than captured.
    .call("waitUntil", { __fn: `() => retired() >= ${warmup}` }, { timeoutMs, pollMs: 50 })
    .call("kernelLedgersMark")
    .call("waitUntil", { __fn: `() => retired() >= ${segment}` }, { timeoutMs, pollMs: 50 })
    .call("kernelLedgers")
    .run();

const steps = out.steps as Array<{ cmd: string; ok: boolean; result?: unknown }>;
const waits = steps.filter(s => s.cmd === "waitUntil");
const present = waits[1];
const ledgers = steps.find(s => s.cmd === "kernelLedgers")?.result as
    { ledgers?: Record<string, { hits?: number }> } | undefined;
const hits = Object.fromEntries(
    Object.entries(ledgers?.ledgers ?? {}).map(([k, v]) => [k, v?.hits ?? 0]));

console.log("ARMRESULT " + JSON.stringify({
    arm: on ? "on" : "off",
    ok: out.ok,
    warmup, segment,
    warmupMs: (waits[0]?.result as { ms?: number } | undefined)?.ms ?? null,
    reached: (present?.result as { satisfied?: boolean } | undefined)?.satisfied ?? false,
    waitMs: (present?.result as { ms?: number } | undefined)?.ms ?? null,
    hits,
}));
