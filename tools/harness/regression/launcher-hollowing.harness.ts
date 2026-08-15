/**
 * Launcher process-hollowing regression: a wrapper that ships the game ENCRYPTED and
 * decrypts it into a child it created suspended must still end up running the game.
 *
 * The chain this exercises, in the order it breaks:
 *   1. CreateProcess must map a bundled PE by its HEADER — the payload is named `.RWG`,
 *      and an extension test refuses it, so the wrapper exits having started nothing.
 *   2. CREATE_SUSPENDED must NOT run it. The on-disk image is ciphertext; executing it
 *      at CreateProcess time runs garbage from the entry point.
 *   3. imagehlp!MapAndLoad must map the FILE THE WRAPPER NAMED. Answering with any other
 *      image (e.g. the caller's own, because the named one is not a loaded module) is not
 *      a degraded answer: the wrapper derives the region to decrypt from those headers,
 *      so it decrypts a plausible-looking address in the wrong image and reports
 *      "The integration header was not valid" — which is the failure this asserts on.
 *   4. ReadProcessMemory on the suspended child must read the CHILD's image.
 *   5. ResumeThread must run it, replaying what the launcher wrote — the decrypted code.
 *
 * Any one of those missing leaves the game unstarted, so a green run here is worth more
 * than its length suggests. The wrapper re-execs onto the child, which navigates the page
 * and kills the chain; that is expected and is itself the signal that step 5 fired.
 *
 *   WGB="G:/WGB/running/Alice Greenfingers.wgb" \
 *     bun tools/harness.ts run tools/harness/regression/launcher-hollowing.harness.ts
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "G:/WGB/running/Alice Greenfingers.wgb";
const BOOT_MS = Number(process.env.BOOT_MS ?? 45000);

let navigated = false;
await harness()
    .openWgb(WGB)
    .sleep(BOOT_MS)
    .run()
    .catch((e: unknown) => {
        // The re-exec reloads the page out from under the CDP session.
        if (/navigated or closed/i.test(String(e))) navigated = true;
        else throw e;
    });

if (!navigated) {
    throw new Error(
        "the launcher never started the child — no re-exec navigation within the boot window. "
        + "Either CreateProcess refused the bundled payload (step 1/2) or ResumeThread did not "
        + "exec it (step 5); `harness report` on the still-live launcher names which.",
    );
}

// The re-exec reloads the page, so the facade is briefly gone. Poll for it rather than
// racing it — a "harness facade not installed" here would read as a product failure.
const deadline = Date.now() + 60000;
let after: any = null;
for (;;) {
    try {
        after = await harness().expect("report").run();
        break;
    } catch (e) {
        if (Date.now() > deadline) throw new Error(`the reloaded page never came back: ${String(e).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 2000));
    }
}
const report = after.named?.report;

const modals: Array<{ text?: string; caption?: string }> = report?.pendingModals ?? [];
if (modals.length) {
    throw new Error(
        `the wrapper stopped on a modal instead of running the game: `
        + modals.map((m) => `"${m.caption ?? ""}: ${m.text ?? ""}"`).join(" | "),
    );
}
if (report?.crash) {
    throw new Error(`the child crashed: ${report.crash.reason} (EIP ${report.crash.eip}, addr ${report.crash.faultAddr})`);
}
const faults: unknown[] = report?.faults ?? [];
if (faults.length) throw new Error(`${faults.length} unhandled guest fault(s) after the hand-off`);

// Decrypted code eventually draws the game's own art; ciphertext draws nothing at all.
// Distinct colours, not brightness: the wrapper's splash is bright too, and this has to
// tell the game apart from it. Read the canvas directly — the child has its own boot to
// do after the hand-off, so poll until it draws rather than sampling once and guessing.
const canvasColours = `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const g = document.createElement('canvas');
    g.width = c.width; g.height = c.height;
    g.getContext('2d').drawImage(c, 0, 0);
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 37) seen.add((d[i] >> 3) << 10 | (d[i+1] >> 3) << 5 | (d[i+2] >> 3));
    return { w: g.width, h: g.height, colours: seen.size };
})()`;

const drawDeadline = Date.now() + Number(process.env.DRAW_MS ?? 90000);
let seen = 0;
let canvas: { w: number; h: number; colours: number } | null = null;
while (Date.now() < drawDeadline) {
    const probe: any = await harness().evalPage(canvasColours).run().catch(() => null);
    canvas = probe?.steps?.[0]?.result ?? null;
    seen = canvas?.colours ?? 0;
    if (seen >= 64) break;
    await new Promise((r) => setTimeout(r, 3000));
}
if (!canvas) throw new Error("could not read the page canvas after the hand-off");
if (seen < 64) {
    throw new Error(`the child never drew the game: ${seen} distinct colours on a ${canvas.w}x${canvas.h} `
        + "canvas after the hand-off — it started but its code is not producing frames");
}

console.log(`OK — launcher decrypted and handed off; child is drawing (${seen} distinct colours)`);
