/**
 * Fixture round-trip regression: snapshot -> wipe -> restore -> assert byte-identical.
 *
 * Proves the mechanism that makes an unattended perf run reproducible: a game's
 * persisted profile (graphics settings, saves, career progress) lives in the OPFS
 * CoW overlay, so a cleared origin or a fresh browser profile silently boots at
 * DEFAULT detail — a different workload than the one being measured.
 *
 * Run with NO game loaded. Restore must happen before a bundle loads; a running
 * game holds those files open.
 *
 *   bun fixtures/verify-roundtrip.harness.ts
 *   FIXTURE=nfsu-max CONTAINER=app-nfs-underground bun fixtures/verify-roundtrip.harness.ts
 *
 * The container is wiped as part of the test. Anything in it that the fixture does
 * not carry would be lost, so the script snapshots the live container to
 * fixtures/<name>-pretest first and restores it at the end.
 */

import { harness } from "../tools/harness";
import { createHash } from "node:crypto";

const FIXTURE = process.env.FIXTURE ?? "nfsu-max";
const DIR = `fixtures/${FIXTURE}`;
const PRETEST = `${FIXTURE}-pretest`;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const sh = async (cmd: string[]): Promise<void> => {
    const p = Bun.spawn(["bun", "tools/harness.ts", ...cmd], { stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed: ${await new Response(p.stderr).text()}`);
};

const man = JSON.parse(await Bun.file(`${DIR}/manifest.json`).text()) as { container: string; files: string[] };
const container = process.env.CONTAINER ?? man.container;
let failures = 0;

console.log(`fixture=${FIXTURE} container=${container} files=${man.files.length}\n`);

// 1. Safety net: capture whatever is live now, including files this fixture omits.
await sh(["fixture", "save", PRETEST, "--container", container]);
const pretest = JSON.parse(await Bun.file(`fixtures/${PRETEST}/manifest.json`).text()) as { files: string[] };
console.log(`[1] pre-test snapshot -> fixtures/${PRETEST} (${pretest.files.length} files)`);

try {
    // 2. Wipe — the "everything got reset" state the fixture has to survive.
    const wiped = await harness().containerDelete(container).containerList(container).run();
    if (!wiped.ok) throw new Error(`wipe failed: ${wiped.error?.message}`);
    const left = (wiped.named.containerList as { files: unknown[] }).files.length;
    console.log(`[2] wiped -> container holds ${left} file(s)`);
    if (left !== 0) { console.error("    FAIL: container not empty after wipe"); failures++; }

    // 3. Flash the fixture back into the empty container.
    await sh(["fixture", "restore", FIXTURE]);
    console.log(`[3] restored ${FIXTURE}`);

    // 4. Read every file back OUT of OPFS and compare to the bytes on disk.
    console.log("[4] byte-identity:");
    for (const p of man.files) {
        const r = await harness().containerRead(container, p).run();
        if (!r.ok) { console.error(`    FAIL  ${p}: ${r.error?.message}`); failures++; continue; }
        const fromOpfs = new Uint8Array(Buffer.from((r.named.containerRead as { content: string }).content, "base64"));
        const fromDisk = new Uint8Array(await Bun.file(`${DIR}${p}`).arrayBuffer());
        const ok = fromOpfs.length === fromDisk.length && sha(fromOpfs) === sha(fromDisk);
        if (!ok) failures++;
        console.log(`    ${ok ? "OK  " : "FAIL"} ${String(fromDisk.length).padStart(7)}B  ${sha(fromDisk).slice(0, 16)}  ${p}`);
    }
} finally {
    // 5. Put the machine back the way it was found, fixture-carried or not.
    await sh(["fixture", "restore", PRETEST]);
    console.log(`[5] pre-test state restored from fixtures/${PRETEST}`);
}

console.log(failures === 0 ? "\nPASS — round-trip is byte-identical" : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
