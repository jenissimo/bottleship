/**
 * Warcraft III Demo boot regression: a launcher whose EXE NAME CONTAINS SPACES must
 * re-exec exactly once, and the game behind it must reach its menu.
 *
 * Three separate invariants stand between `openWgb` and a lit screen here, and each
 * one was broken until this title exercised it. None of them is reachable by unit
 * test, and each fails in a way that looks like a hang rather than an error:
 *
 *   1. argv[0] QUOTING. GetCommandLine must quote the image name when it contains a
 *      space, or the launcher's own argv-strip keeps the tail ("III Demo.exe") as an
 *      argument and re-appends it forever — an endless page-reload loop with the
 *      command line growing one copy per restart.
 *   2. CASE-INSENSITIVE exec image lookup. The launcher asks for "war3demo.exe" and
 *      the archive entry is "War3Demo.exe"; a case-sensitive lookup silently falls
 *      back to the manifest entrypoint, which is the launcher, which is the same loop.
 *   3. EnumAdapterModes must REFUSE past the mode count, and GetQueuedCompletionStatus
 *      must BLOCK on an empty queue. Without the first the game walks adapter modes
 *      forever (it reached index 820000+); without the second its I/O worker pool spins
 *      at full speed and starves the thread that would feed it.
 *
 * Any one of them regressing stops the run before the menu renders, so the surface
 * assertion below is the whole judgement — that is deliberate: at this level the
 * cheapest honest signal is "did it get there".
 *
 *   WGB="G:/WGB/todo/warcraft3-demo.wgb" \
 *     bun tools/harness.ts run tools/harness/regression/warcraft3-demo-boot.harness.ts
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/todo/warcraft3-demo.wgb";
const BOOT_MS = Number(process.env.BOOT_MS ?? 25000);

// The launcher re-execs onto War3Demo.exe, which reloads the page and takes the CDP
// session with it. ONE such navigation is the pass condition for invariants 1 and 2;
// the loop they used to produce shows up as this repeating until the run times out.
let navigated = false;
// .run() RESOLVES with { ok: false } on a failed step — only a transport failure rejects,
// and the navigation we are waiting for is one. So the resolved result has to be inspected
// too, or a genuine failure here would be reported as "never re-exec'd".
const launch = await harness()
    .openWgb(WGB)
    .sleep(BOOT_MS)
    .run()
    .catch((e: unknown) => {
        if (/navigated or closed/i.test(String(e))) { navigated = true; return null; }
        throw e;
    });

if (!navigated) {
    const why = launch?.error?.message ?? `the chain completed (ok=${launch?.ok})`;
    throw new Error(
        "the launcher never re-exec'd onto the game — no navigation within the boot window. "
        + "Either CreateProcess did not recognise the sibling image, or the exec image lookup "
        + `missed it on case (invariant 2). Launch chain said: ${why}`
    );
}

// Give the reloaded page time to reinstall the harness facade before talking to it —
// the navigation we just caught means the document is being rebuilt.
await new Promise((resolve) => setTimeout(resolve, 5000));

// Fresh session on the reloaded page: the game is now booting on its own image.
const result = await harness()
    .sleep(BOOT_MS)
    // NOT expectSurfaceNonBlack("primary"): a d3d8 title registers no DDraw primary
    // (state.screen.primaryPtr is 0), so that assertion cannot see this game's pixels.
    // The screen hash can — and its `mean` is what distinguishes "rendered" from "black".
    .call("screenRegionHash", { x: 200, y: 150, w: 400, h: 300 })
    .call("stubs")
    .run();

// A step's `error` is an OBJECT ({ message }), not a string — interpolating it directly
// prints "[object Object]" and the failure that was supposed to be loud says nothing.
const steps = result.steps as Array<{ cmd: string; ok: boolean; error?: { message?: string }; result?: unknown }>;
const failed = steps.filter((s) => !s.ok);
if (failed.length > 0) {
    throw new Error(`harness step(s) failed: ${failed.map((s) => `${s.cmd}: ${s.error?.message ?? "?"}`).join("; ")}`);
}
// A chain aborts at its first failure, so a clean `steps` with ok=false means the failure
// was the run itself, not a step.
if (!result.ok) throw new Error(`harness run failed: ${result.error?.message ?? "unknown"}`);

const pixels = steps.find((s) => s.cmd === "screenRegionHash")?.result as { mean?: number } | undefined;
if (!pixels || typeof pixels.mean !== "number") {
    throw new Error("could not read the screen after boot");
}
if (pixels.mean < 8) {
    throw new Error(
        `the screen is black after boot (mean ${pixels.mean}) — the game reached neither its menu nor an error dialog. `
        + "Suspect the adapter-mode walk or the completion-port wait (invariant 3)."
    );
}

const stubs = (steps.find((s) => s.cmd === "stubs")?.result ?? []) as Array<{ api: string; count: number }>;
if (stubs.length > 0) {
    throw new Error(
        `${stubs.length} unimplemented API(s) were called on the boot path — a stub returns garbage the guest `
        + `cannot detect: ${stubs.map((s) => `${s.api} x${s.count}`).join(", ")}`
    );
}

console.log(`OK — menu rendered (screen mean ${pixels.mean}), no unimplemented APIs on the boot path`);
