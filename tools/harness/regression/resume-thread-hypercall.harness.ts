/**
 * The WASM ResumeThread handler may only answer a resume that changes nothing.
 *
 * Handler 83 serves `ResumeThread(h)` entirely inside v86 when the shared page says the
 * target's suspend count is 0 — Win32 returns the previous count (0) and no state moves.
 * That removes the JS round trip from engines that kick a worker once per main-loop
 * iteration (Discworld Noir: ~1.4M calls/s, of which only the handful that actually wake
 * the worker reach the scheduler).
 *
 * The whole thing rests on ONE invariant: the page must never claim 0 for a thread that is
 * really suspended. If it ever does, the resume that was supposed to wake the worker is
 * answered as a no-op, the worker never runs again, and the game hangs with no error
 * anywhere — so this asserts the invariant directly rather than the frame rate it buys.
 *
 *   WGB=G:/WGB/running/discworld-noir.wgb bun tools/harness.ts run tools/harness/regression/resume-thread-hypercall.harness.ts
 *
 * The positive control is `sawSuspended`: a run where the title never suspended anything
 * proves nothing, so it FAILS rather than passing vacuously.
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/running/discworld-noir.wgb";
const BOOT_FRAMES = Number(process.env.FRAMES ?? 400);
/** Samples of (page vs scheduler). Each is ~2ms apart, so this spans a few seconds of
 *  the handshake — the worker is suspended and resumed thousands of times in that window. */
const SAMPLES = 800;

const PROBE = `
    const sys = (await import("/src/worker/core/system.ts")).System.getInstance();
    const sched = sys.scheduler;
    const hc = (await import("/src/worker/core/cpu/hypercall-data.ts")).hypercallDataManager;
    const report = hc.getHandlerReport().find((r) => r.handlerId === 83) ?? null;
    const view = hc["view"];
    const base = hc["hpBase"] + 0x2800;   // OFF_HC_THREAD_SUSPEND
    if (!view) return { error: "hypercall page not mapped" };

    const TERMINATED = 5;
    let samples = 0, mismatches = 0, sawSuspended = 0;
    const examples = [];
    for (let n = 0; n < ${SAMPLES}; n++) {
        const page = new Map();
        for (let i = 0; i < 32; i++) {
            const h = view.getUint32(base + i * 8, true);
            if (h === 0) break;                       // slots are packed from the front
            page.set(h >>> 0, view.getUint32(base + i * 8 + 4, true));
        }
        for (const t of sched.threads.values()) {
            if (t.state === TERMINATED) continue;
            const inPage = page.get(t.handle >>> 0);
            if (inPage === undefined) continue;       // absent = the JS scheduler answers
            samples++;
            if (t.suspendCount > 0) sawSuspended++;
            if (inPage !== t.suspendCount) {
                mismatches++;
                if (examples.length < 5) {
                    examples.push({ thread: t.id, handle: t.handle >>> 0, page: inPage, real: t.suspendCount });
                }
            }
        }
        await new Promise((r) => setTimeout(r, 2));
    }
    return { samples, mismatches, sawSuspended, examples, report };
`;

const run: any = await harness()
    .openWgb(WGB)
    .watchFrames(true)
    .tickFrames(BOOT_FRAMES, { timeoutMs: 300000 })
    .call("evalWorker", [PROBE])
    .run();

const r = run.steps.find((s: any) => s.cmd === "evalWorker")?.result;
if (!r) throw new Error("probe did not run — no worker state to judge");
if (r.error) throw new Error(r.error);

if (r.samples === 0) {
    throw new Error("no thread was ever published to the shared suspend table — either the "
        + "scheduler stopped mirroring it (the handler then answers for nothing) or this "
        + "fixture no longer creates a second thread");
}
if (r.sawSuspended === 0) {
    throw new Error(`the table was checked ${r.samples} times but no thread was ever suspended `
        + "during the window — this fixture is supposed to run a Suspend/Resume handshake, so "
        + "the check passed without exercising the case it exists for");
}
if (r.mismatches > 0) {
    throw new Error(`the shared suspend table disagreed with the scheduler ${r.mismatches}/`
        + `${r.samples} times: ${JSON.stringify(r.examples)}. A page entry of 0 for a thread that `
        + "is really suspended makes the WASM handler answer a real resume as a no-op — the "
        + "worker is never woken and the guest hangs silently.");
}

const served = r.report?.served ?? 0;
const fellBack = r.report?.fellBack ?? 0;
if (served === 0) {
    throw new Error("handler 83 served nothing — ResumeThread is not routed to WASM at all "
        + "(check HANDLER_MAP['kernel32.resumethread'] and that v86.wasm was rebuilt)");
}

console.log(`OK — ${r.samples} page-vs-scheduler comparisons, ${r.sawSuspended} of them with the `
    + `thread genuinely suspended, 0 disagreements. Handler 83: ${served} served in WASM, `
    + `${fellBack} fell through to the scheduler.`);
