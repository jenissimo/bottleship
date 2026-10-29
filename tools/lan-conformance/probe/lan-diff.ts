/**
 * lan-diff — one runner for the lanprobe conformance cases.
 *
 *   bun tools/lan-conformance/probe/lan-diff.ts record <area>/<case> [--force]
 *       Run the case natively and write its golden log
 *       (tools/lan-conformance/cases/<area>/<case>.native.log).
 *
 *   bun tools/lan-conformance/probe/lan-diff.ts check <area>/<case> [more...]
 *   bun tools/lan-conformance/probe/lan-diff.ts check all
 *       Run the case in the emulator through the harness and diff against the
 *       committed golden. Exits 1 on any difference.
 *
 * The probe PE is built once and cached under logs/lan-conformance/lanprobe/,
 * keyed by the C source hash. Requires the harness browser for `check`
 * (`bun tools/harness.ts up`); BS_LAN_SERVER/BS_LAN_ROOM are passed through.
 */
import { resolve, dirname, join } from "node:path";
import { mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness, closeHarnessConnection } from "../../harness";

const root = resolve(import.meta.dir, "../../..");
const casesRoot = join(root, "tools/lan-conformance/cases");
const cacheDir = resolve(root, "logs/lan-conformance/lanprobe");
const workRoot = resolve(root, "logs/lan-conformance/lan-diff");
const bun = process.execPath;

function usage(): never {
    console.error("usage: lan-diff.ts record <area>/<case> [--force]\n" +
        "       lan-diff.ts check <area>/<case>|all [more...]");
    process.exit(2);
}

function parseArgs(argv: string[]) {
    const rest: string[] = [];
    let force = false;
    for (const a of argv) {
        if (a === "--force") force = true;
        else rest.push(a);
    }
    return { rest, force };
}

function casePaths(caseId: string) {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(caseId)) {
        throw new Error(`Case id must be <area>/<name>: ${caseId}`);
    }
    return {
        script: join(casesRoot, caseId + ".lp"),
        golden: join(casesRoot, caseId + ".native.log"),
        work: join(workRoot, caseId.replace("/", "-")),
    };
}

function listCases(): string[] {
    const out: string[] = [];
    if (!existsSync(casesRoot)) return out;
    for (const area of readdirSync(casesRoot, { withFileTypes: true })) {
        if (!area.isDirectory()) continue;
        for (const file of readdirSync(join(casesRoot, area.name))) {
            if (file.endsWith(".lp")) out.push(`${area.name}/${file.slice(0, -3)}`);
        }
    }
    return out.sort();
}

/* ---------------- probe build ---------------- */

async function buildProbe(): Promise<string> {
    const source = join(root, "tools/lan-conformance/probe/lanprobe.c");
    const sourceSha = createHash("sha256")
        .update(new Uint8Array(await Bun.file(source).arrayBuffer()))
        .digest("hex");
    const exe = join(cacheDir, "lanprobe.exe");
    const buildFile = join(cacheDir, "build.json");
    if (existsSync(exe) && existsSync(buildFile)) {
        const build = await Bun.file(buildFile).json() as { sourceSha256?: string };
        if (build.sourceSha256 === sourceSha) return exe;
    }
    mkdirSync(cacheDir, { recursive: true });
    const compiler = process.env.BS_MINGW_CC ?? "C:/msys64/mingw32/bin/gcc.exe";
    const env = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.Path = `${dirname(compiler)};${process.env.PATH ?? process.env.Path ?? ""}`;
    const compile = Bun.spawnSync([
        compiler, "-O1", "-nostdlib", "-fno-builtin", "-fno-stack-protector",
        "-Wl,--entry,_entry", "-Wl,--subsystem,console", "-o", exe,
        source, "-lws2_32", "-lkernel32",
    ], { env, stdout: "pipe", stderr: "pipe" });
    if (compile.exitCode !== 0) {
        throw new Error(`lanprobe compile failed (exit ${compile.exitCode}): ` +
            new TextDecoder().decode(compile.stderr));
    }
    await Bun.write(buildFile, JSON.stringify({ sourceSha256: sourceSha, builtAt: new Date().toISOString() }, null, 2) + "\n");
    return exe;
}

/* ---------------- native record ---------------- */

async function record(caseId: string, force: boolean) {
    const { script, golden, work } = casePaths(caseId);
    if (!existsSync(script)) throw new Error(`No case script: ${script}`);
    if (existsSync(golden) && !force) {
        throw new Error(`Golden exists: ${golden} (pass --force to re-record)`);
    }
    const exe = await buildProbe();
    const nativeDir = join(work, "native");
    mkdirSync(nativeDir, { recursive: true });
    const outLog = join(nativeDir, "case.log");
    const run = Bun.spawnSync([exe, script, outLog], {
        cwd: nativeDir, stdout: "inherit", stderr: "inherit", timeout: 60000,
    });
    if (run.exitCode !== 0) {
        throw new Error(`Native probe failed, exit ${run.exitCode}. Log (if any): ${outLog}`);
    }
    const log = await Bun.file(outLog).text();
    if (!log.endsWith("exit 0\n")) {
        throw new Error(`Native probe did not exit cleanly:\n${log}`);
    }
    mkdirSync(dirname(golden), { recursive: true });
    await Bun.write(golden, log);
    console.log(log);
    console.log(`golden: ${golden}`);
}

/* ---------------- emulator check ---------------- */

async function readCaseLog(): Promise<string> {
    const result = await harness().fsRead("C:\\case.log").run();
    const record = result.named.fsRead as { content?: string } | undefined;
    if (!result.ok || !record?.content) throw new Error("No C:\\case.log in the guest yet");
    return new TextDecoder().decode(Uint8Array.from(atob(record.content), c => c.charCodeAt(0)));
}

async function check(caseId: string) {
    const { script, golden, work } = casePaths(caseId);
    if (!existsSync(script)) throw new Error(`No case script: ${script}`);
    if (!existsSync(golden)) throw new Error(`No golden log: ${golden} — run 'record ${caseId}' first`);
    const goldenLog = await Bun.file(golden).text();
    const exe = await buildProbe();

    // Pack the probe + this case's script (as C:\case.lp) into a fresh bundle.
    const gameDir = join(work, "game");
    const bundle = join(work, "lanprobe.wgb");
    mkdirSync(gameDir, { recursive: true });
    cpSync(exe, join(gameDir, "lanprobe.exe"));
    cpSync(script, join(gameDir, "case.lp"));
    const pack = Bun.spawnSync([bun, "tools/make-wgb.ts", gameDir, bundle,
        "--exe", "lanprobe.exe", "--name", `lanprobe ${caseId}`, "--game-id", "app:lan-conformance",
        "--ram", "128", "--args", "C:\\case.lp C:\\case.log",
    ], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (pack.exitCode !== 0) throw new Error("Could not package the lanprobe bundle.");
    const patch = Bun.spawnSync([bun, "tools/wgb.ts", "patch-manifest", bundle,
        "emulator.deleteOnBoot", JSON.stringify(["C:\\case.log"]),
    ], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (patch.exitCode !== 0) throw new Error("Could not configure fresh case output.");

    try {
        let boot = harness();
        if (process.env.BS_LAN_SERVER) {
            const config = { serverUrl: process.env.BS_LAN_SERVER, room: process.env.BS_LAN_ROOM ?? "conformance" };
            const connect = `new Promise((resolve, reject) => {
                const worker = window.worker;
                const timer = setTimeout(() => { worker.removeEventListener("message", done); reject(new Error("LAN readiness timeout")); }, 15000);
                const done = event => {
                    if (event.data?.type !== "network_state" || !["connected", "error"].includes(event.data.status.state)) return;
                    clearTimeout(timer); worker.removeEventListener("message", done);
                    if (event.data.status.state === "connected") resolve(true); else reject(new Error(event.data.status.reason));
                };
                worker.addEventListener("message", done);
                worker.postMessage({ type: "set_network", network: ${JSON.stringify(config)} });
            })`;
            boot = boot.reload().evalPage(connect, 20000).openWgb(bundle, { reload: false });
        } else {
            boot = boot.openWgb(bundle);
        }
        const loaded = await boot.run();
        if (!loaded.ok) throw new Error("Guest load failed: " + JSON.stringify(loaded));

        const deadline = Date.now() + 120_000;
        let guestLog = "";
        while (Date.now() < deadline) {
            await Bun.sleep(500);
            try { guestLog = await readCaseLog(); } catch { continue; }
            if (/^exit \d+$/m.test(guestLog)) break;
        }
        if (!/^exit \d+$/m.test(guestLog)) {
            const report = await harness().report().run();
            throw new Error(`Guest did not finish within the deadline; last log:\n${guestLog}\nreport: ${JSON.stringify(report).slice(0, 2000)}`);
        }
        const guestPath = join(work, "guest.log");
        await Bun.write(guestPath, guestLog);

        const goldenLines = goldenLog.split("\n").filter(l => l.length);
        const guestLines = guestLog.split("\n").filter(l => l.length);
        const differences: Array<{ line: number; native: string; guest: string }> = [];
        for (let i = 0; i < Math.max(goldenLines.length, guestLines.length); i++) {
            const a = goldenLines[i]; const b = guestLines[i];
            if (a !== b) differences.push({ line: i + 1, native: a ?? "<missing>", guest: b ?? "<missing>" });
        }
        if (differences.length === 0) {
            console.log(`OK ${caseId} (${goldenLines.length} lines)`);
            return;
        }
        console.log(`DIFF ${caseId}: ${differences.length} differing line(s) (full logs: golden ${golden}, guest ${guestPath})`);
        for (const d of differences.slice(0, 20)) {
            console.log(`  line ${d.line}`);
            console.log(`    native: ${d.native}`);
            console.log(`    guest : ${d.guest}`);
        }
        if (differences.length > 20) console.log(`  ... and ${differences.length - 20} more`);
        process.exitCode = 1;
    } finally {
        closeHarnessConnection();
    }
}

/* ---------------- main ---------------- */

const [cmd, ...argv] = process.argv.slice(2);
const { rest, force } = parseArgs(argv);
if (cmd === "record") {
    if (rest.length !== 1) usage();
    await record(rest[0], force);
} else if (cmd === "check") {
    if (!rest.length) usage();
    const targets = rest.includes("all")
        ? listCases().filter(id => existsSync(casePaths(id).golden))
        : rest;
    let failed = 0;
    for (const id of targets) {
        try {
            await check(id);
        } catch (error) {
            failed++;
            console.error(`FAIL ${id}: ${error instanceof Error ? error.message : error}`);
            process.exitCode = 1;
        }
    }
    if (targets.length > 1) {
        console.log(`${targets.length - failed}/${targets.length} cases match native.`);
    }
} else if (cmd === "list") {
    for (const id of listCases()) console.log(id);
} else {
    usage();
}
