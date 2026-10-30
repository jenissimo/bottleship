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
 * Multi-role cases (<case>.<role>.lp scripts next to each other, e.g.
 * udp/pair.host.lp + udp/pair.peer.lp) run one probe process per role under a
 * file-based coordinator: each role logs "gate <name> enter", the parent
 * releases <coorddir>/gate-<name>.open once every role arrived, each role
 * driver relays that into its probe's gate directory (a real directory
 * natively, the guest FS via harness fsWrite in the emulator). Role scripts
 * use FIXED ports so addresses stay symbolic without cross-role discovery.
 *
 * The probe PE is built once and cached under logs/lan-conformance/lanprobe/,
 * keyed by the C source hash. Requires the harness browser for `check`
 * (`bun tools/harness.ts up`); BS_LAN_SERVER/BS_LAN_ROOM are passed through.
 */
import { resolve, dirname, join, basename } from "node:path";
import { mkdirSync, mkdtempSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs, scriptMetadata, planRoles, checkSkip, type RunMode } from "./case-metadata";
import { harness, closeHarnessConnection } from "../../harness";
import { findOrCreateTab, DEFAULT_DEV_URL } from "../../cdp-core";

const root = resolve(import.meta.dir, "../../..");
const casesRoot = join(root, "tools/lan-conformance/cases");
const cacheDir = resolve(root, "logs/lan-conformance/lanprobe");
const workRoot = resolve(root, "logs/lan-conformance/lan-diff");
const bun = process.execPath;
const ROLE_RE = /^([a-z0-9-]+)\.([a-z0-9]+)\.lp$/;

function usage(): never {
    console.error("usage: lan-diff.ts record <area>/<case> [--force]\n" +
        "       lan-diff.ts check <area>/<case>|all [more...]");
    process.exit(2);
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

/** Roles of a multi-role case; [] for a single-script case. */
function caseRoles(caseId: string): string[] {
    const dir = join(casesRoot, dirname(caseId));
    const base = caseId.split("/")[1];
    if (!existsSync(dir)) return [];
    const roles: string[] = [];
    for (const file of readdirSync(dir)) {
        const m = ROLE_RE.exec(file);
        if (m && m[1] === base) roles.push(m[2]);
    }
    return roles.sort();
}

function rolePaths(caseId: string, role: string) {
    return {
        script: join(casesRoot, `${caseId}.${role}.lp`),
        golden: join(casesRoot, `${caseId}.${role}.native.log`),
    };
}

function listCases(): string[] {
    const out: string[] = [];
    if (!existsSync(casesRoot)) return out;
    for (const area of readdirSync(casesRoot, { withFileTypes: true })) {
        if (!area.isDirectory()) continue;
        const seen = new Set<string>();
        for (const file of readdirSync(join(casesRoot, area.name))) {
            const role = ROLE_RE.exec(file);
            if (role) { seen.add(role[1]); continue; }
            if (file.endsWith(".lp")) seen.add(file.slice(0, -3));
        }
        for (const name of seen) out.push(`${area.name}/${name}`);
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
        source, "-lws2_32", "-lkernel32", "-lole32", "-ldxguid",
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
    mkdirSync(work, { recursive: true });
    const nativeDir = mkdtempSync(join(work, "native-"));
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

/** Pack the probe + one script (as C:\case.lp) into a fresh bundle. The
 * guest FS persists across boots in a reused tab, so every coordination file
 * the case can produce must be wiped at boot (deleteOnBoot), or a role driver
 * mirrors a PREVIOUS run's address and the probe connects to a dead session.
 * `fsTag` namespaces the game id: OPFS is per-origin, so two role tabs loading
 * the same game id would share one overlay and each boot's deleteOnBoot would
 * fight the OTHER tab's live probe holding the file open. */
async function packBundle(caseId: string, scriptPath: string, work: string, deleteFiles: string[] = ["C:\\case.log"], fsTag = "") {
    const exe = await buildProbe();
    const gameDir = join(work, "game");
    const bundle = join(work, "lanprobe.wgb");
    mkdirSync(gameDir, { recursive: true });
    cpSync(exe, join(gameDir, "lanprobe.exe"));
    cpSync(scriptPath, join(gameDir, "case.lp"));
    const gameId = fsTag ? `app:lan-conformance-${fsTag}` : "app:lan-conformance";
    const pack = Bun.spawnSync([bun, "tools/make-wgb.ts", gameDir, bundle,
        "--exe", "lanprobe.exe", "--name", `lanprobe ${caseId}`, "--game-id", gameId,
        "--ram", "128", "--args", "C:\\case.lp C:\\case.log",
    ], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (pack.exitCode !== 0) throw new Error("Could not package the lanprobe bundle.");
    const patch = Bun.spawnSync([bun, "tools/wgb.ts", "patch-manifest", bundle,
        "emulator.deleteOnBoot", JSON.stringify(deleteFiles),
    ], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (patch.exitCode !== 0) throw new Error("Could not configure fresh case output.");
    return bundle;
}

async function bootBundle(bundle: string) {
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
}

function diffLogs(caseId: string, goldenLog: string, guestLog: string, goldenPath: string, guestPath: string) {
    const goldenLines = goldenLog.split("\n").filter(l => l.length);
    const guestLines = guestLog.split("\n").filter(l => l.length);
    const differences: Array<{ line: number; native: string; guest: string }> = [];
    for (let i = 0; i < Math.max(goldenLines.length, guestLines.length); i++) {
        const a = goldenLines[i]; const b = guestLines[i];
        if (a !== b) differences.push({ line: i + 1, native: a ?? "<missing>", guest: b ?? "<missing>" });
    }
    if (differences.length === 0) {
        console.log(`OK ${caseId} (${goldenLines.length} lines)`);
        return true;
    }
    console.log(`DIFF ${caseId}: ${differences.length} differing line(s) (full logs: golden ${goldenPath}, guest ${guestPath})`);
    for (const d of differences.slice(0, 20)) {
        console.log(`  line ${d.line}`);
        console.log(`    native: ${d.native}`);
        console.log(`    guest : ${d.guest}`);
    }
    if (differences.length > 20) console.log(`  ... and ${differences.length - 20} more`);
    return false;
}

async function check(caseId: string) {
    const { script, golden, work } = casePaths(caseId);
    if (!existsSync(script)) throw new Error(`No case script: ${script}`);
    if (!existsSync(golden)) throw new Error(`No golden log: ${golden} — run 'record ${caseId}' first`);
    const goldenLog = await Bun.file(golden).text();
    mkdirSync(work, { recursive: true });
    const runDir = mkdtempSync(join(work, "run-"));
    const bundle = await packBundle(caseId, script, runDir, ["C:\\case.log"], basename(runDir));

    try {
        await findOrCreateTab(DEFAULT_DEV_URL);
        // Worker sources are replaced only by a full page reload.
        await harness().reload().run();
        await bootBundle(bundle);
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
        const guestPath = join(runDir, "guest.log");
        await Bun.write(guestPath, guestLog);
        return diffLogs(caseId, goldenLog, guestLog, golden, guestPath);
    } finally {
        closeHarnessConnection();
    }
}

/* ---------------- multi-role coordination ---------------- */

function publishFile(path: string, body: string) {
    const temporary = path + "." + process.pid + ".tmp";
    writeFileSync(temporary, body); renameSync(temporary, path);
}

async function guestWrite(path: string, body: string) {
    const result = await harness().fsWrite(path, body).run();
    if (!result.ok) throw new Error("Could not relay coordination file " + path);
}

/**
 * One role of a multi-role case, as a child process. Native roles run the
 * probe directly; emulated roles boot a bundle in their own BS_TAB tab and
 * poll the guest log. Both relay the shared coordinator's gate files into
 * their probe's gate directory and mirror the running log back.
 */
async function runRoleChild(caseId: string, role: string, coordDir: string) {
    const emulated = process.env.BS_LANDIFF_MODE === "emu";
    const roles = caseRoles(caseId);
    const metadata = new Map(roles.map(r => [r, scriptMetadata(readFileSync(rolePaths(caseId, r).script, "utf8"))]));
    const mine = metadata.get(role);
    if (!mine) throw new Error("Unknown role: " + role);
    const work = join(coordDir, role);
    mkdirSync(work, { recursive: true });
    const names = new Set([...metadata.values()].flatMap(m => [...m.published, ...m.required]));
    const gateNames = new Set([...metadata.values()].flatMap(m => [...m.gates, ...m.signals]));
    const ownSignals = new Set(mine.signals);
    const ownPublish = new Set(mine.published);
    let native: Bun.Subprocess | undefined, lastLog = "";
    const nativeLog = join(work, "case.log");
    try {
        if (emulated) {
            await findOrCreateTab(DEFAULT_DEV_URL);
            const deleteFiles = ["C:\\case.log", ...[...names].map(n => "C:\\addr-" + n + ".txt"),
                ...[...gateNames].map(n => "C:\\gate-" + n + ".open")];
            const bundle = await packBundle(caseId + "/" + role, rolePaths(caseId, role).script,
                work, deleteFiles, basename(coordDir) + "-" + role);
            await bootBundle(bundle);
        } else {
            native = Bun.spawn([await buildProbe(), rolePaths(caseId, role).script, nativeLog],
                { cwd: work, stdout: "inherit", stderr: "inherit" });
        }
        const readLocal = async (file: string): Promise<string | null> => {
            if (!emulated) { try { return await Bun.file(join(work, file)).text(); } catch { return null; } }
            const result = await harness().fsRead("C:\\" + file).run();
            const content = (result.named.fsRead as {content?: string} | undefined)?.content;
            return result.ok && content !== undefined ? Buffer.from(content, "base64").toString("utf8") : null;
        };
        const writeLocal = async (file: string, body: string) => {
            if (emulated) await guestWrite("C:\\" + file, body); else publishFile(join(work, file), body);
        };
        const emitted = new Set<string>(), ingested = new Set<string>(), reported = new Set<string>();
        const deadline = Date.now() + 150_000;
        let finished = false;
        while (Date.now() < deadline) {
            for (const name of ownPublish) {
                const file = "addr-" + name + ".txt";
                if (emitted.has(file)) continue;
                const body = await readLocal(file);
                if (body !== null && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(body.trim())) {
                    publishFile(join(coordDir, file), body);
                    emitted.add(file);
                }
            }
            for (const name of names) {
                const file = "addr-" + name + ".txt", path = join(coordDir, file);
                if (!ownPublish.has(name) && !ingested.has(file) && existsSync(path)) {
                    await writeLocal(file, readFileSync(path, "utf8"));
                    ingested.add(file);
                }
            }
            for (const name of ownSignals) {
                const file = "gate-" + name + ".open";
                if (!emitted.has(file) && await readLocal(file) !== null) {
                    publishFile(join(coordDir, file), "");
                    emitted.add(file);
                }
            }
            for (const name of gateNames) {
                const file = "gate-" + name + ".open", path = join(coordDir, file);
                if (!ownSignals.has(name) && !ingested.has(file) && existsSync(path)) {
                    await writeLocal(file, "");
                    ingested.add(file);
                }
            }
            const log = emulated ? await readLocal("case.log") : await Bun.file(nativeLog).text().catch(() => null);
            if (log !== null) {
                lastLog = log;
                publishFile(join(coordDir, role + ".log"), log);
                for (const name of mine.gates) {
                    if (!reported.has(name) && log.includes("gate " + name + " enter")) {
                        publishFile(join(coordDir, role + ".at-" + name), "");
                        reported.add(name);
                    }
                }
                if (/^exit \d+$/m.test(log)) { finished = true; break; }
            }
            if (native && native.exitCode !== null) break;
            await Bun.sleep(150);
        }
        if (!finished) {
            if (emulated) console.error(JSON.stringify(await harness().report().run()).slice(0, 2000));
            throw new Error(role + " did not finish; last log:\n" + lastLog);
        }
        publishFile(join(coordDir, role + ".final.log"), lastLog);
        if (native && await native.exited !== 0) throw new Error("Native role exited with failure: " + role);
    } finally {
        if (native && native.exitCode === null) { native.kill(); await native.exited; }
        if (emulated) closeHarnessConnection();
    }
}

/**
 * Parent of a multi-role run: spawns one role child per role, watches the
 * shared coordination directory, releases gates once every role arrived.
 */
async function runMultiRole(caseId: string, mode: RunMode, force: boolean,
    roleModes?: Record<string, "native" | "emu">, wireHost = false): Promise<boolean> {
    const roles = caseRoles(caseId), plan = planRoles(roles, mode, roleModes, wireHost);
    await buildProbe();
    for (const {role} of plan) {
        const { golden } = rolePaths(caseId, role);
        if (mode === "check" && !existsSync(golden)) throw new Error("No golden log: " + golden + " — use run for diagnostics");
        if (mode === "record" && existsSync(golden) && !force) throw new Error("Golden exists: " + golden);
    }
    const { work } = casePaths(caseId);
    mkdirSync(work, { recursive: true });
    const coordDir = mkdtempSync(join(work, "run-"));
    console.log("Run artifacts: " + coordDir);
    const metadata = new Map(roles.map(role => [role, scriptMetadata(readFileSync(rolePaths(caseId, role).script, "utf8"))]));
    const signals = new Set([...metadata.values()].flatMap(m => m.signals));
    // A signal has a producer. A waiting role must never release it as a barrier.
    const gates = new Set(plan.flatMap(({role}) => metadata.get(role)!.gates).filter(name => !signals.has(name)));
    const children: Bun.Subprocess[] = [];
    let wire: Bun.Subprocess | undefined;
    try {
        if (wireHost) {
            const os = await import("node:os"), dns = await import("node:dns/promises");
            const ip = process.env.BS_WIRE_HOST_IP ??
                (plan.every(p => p.mode === "native") ? "127.0.0.1" : (await dns.lookup(os.hostname(), {family: 4})).address);
            const wirePort = process.env.BS_WIRE_HOST_PORT ?? (plan.every(p => p.mode === "native") ? "0" : "23913");
            wire = Bun.spawn([bun, join(root, "tools/lan-conformance/probe/dp8-wire-host.ts"),
                "--port", wirePort, "--addr-file", join(coordDir, "addr-host.txt"),
                "--receive-file", join(coordDir, "wire-receive.txt")],
                { cwd: root, env: {...process.env, BS_WIRE_HOST_IP: ip}, stdout: "inherit", stderr: "inherit" });
            const deadline = Date.now() + 20000;
            while (!existsSync(join(coordDir, "addr-host.txt"))) {
                if (wire.exitCode !== null) throw new Error("Wire host exited before readiness: " + wire.exitCode);
                if (Date.now() > deadline) throw new Error("Wire host readiness timeout");
                await Bun.sleep(100);
            }
        }
        const baseTab = process.env.BS_TAB ?? "lanprobe";
        for (const {role, mode: roleMode} of plan) {
            children.push(Bun.spawn([bun, import.meta.path, "_run-role", caseId, role], {
                cwd: root, env: {...process.env, BS_LANDIFF_MODE: roleMode, BS_LANDIFF_COORD: coordDir,
                    BS_TAB: baseTab + "-" + role}, stdout: "inherit", stderr: "inherit",
            }));
        }
        const released = new Set<string>(), deadline = Date.now() + 180000;
        while (children.some(child => child.exitCode === null)) {
            if (Date.now() > deadline) throw new Error("Role coordinator deadline");
            if (wire && wire.exitCode !== null) throw new Error("Wire host exited during run");
            if (wire && existsSync(join(coordDir, "wire-receive.txt"))) {
                for (const name of metadata.get("host")!.signals) if (!released.has(name)) {
                    publishFile(join(coordDir, "gate-" + name + ".open"), "");
                    released.add(name);
                }
            }
            for (const name of gates) {
                if (!released.has(name) && plan.every(({role}) => !metadata.get(role)!.gates.includes(name) ||
                    existsSync(join(coordDir, role + ".at-" + name)))) {
                    publishFile(join(coordDir, "gate-" + name + ".open"), "");
                    released.add(name);
                }
            }
            await Bun.sleep(100);
        }
        const exits = await Promise.all(children.map(child => child.exited));
        let ok = exits.every(code => code === 0);
        for (const {role} of plan) {
            const finalPath = join(coordDir, role + ".final.log");
            if (!existsSync(finalPath)) { console.error("FAIL " + caseId + "/" + role + ": no final log"); ok = false; continue; }
            const log = readFileSync(finalPath, "utf8");
            if (!log.endsWith("exit 0\n")) { console.error("FAIL " + role + ":\n" + log); ok = false; continue; }
            if (mode === "check") {
                if (!diffLogs(caseId + "/" + role, readFileSync(rolePaths(caseId, role).golden, "utf8"), log,
                    rolePaths(caseId, role).golden, finalPath)) ok = false;
            }
        }
        // Commit a complete native run only after every role has finished successfully.
        if (mode === "record" && ok) for (const {role} of plan) {
            writeFileSync(rolePaths(caseId, role).golden, readFileSync(join(coordDir, role + ".final.log")));
        }
        if (mode === "run") console.log((ok ? "Completed " : "Failed ") + caseId + " (diagnostic; no parity claim)");
        return ok;
    } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
        await Promise.all(children.map(child => child.exited));
        if (wire) { if (wire.exitCode === null) wire.kill(); await wire.exited; }
    }
}

/* ---------------- gateway config/* ---------------- gateway config ---------------- */

/**
 * Write a relay-server config whose gateway route targets THIS machine's
 * LAN address (the same system-resolver address a native probe's
 * publishaddr publishes), so an emulated role sending to the native role's
 * published address is routed through the relay gateway as an external
 * destination. Start the server with:
 *   bun packages/lan/src/cli.ts --config <out> --port 9001
 */
async function gatewayConfig(out: string, ports: number[]) {
    const os = await import("node:os");
    const dns = await import("node:dns");
    const host = await new Promise<string>((res, rej) =>
        dns.lookup(os.hostname(), { family: 4 }, (e, a) => e ? rej(e) : res(String(a))));
    await Bun.write(out, JSON.stringify({
        gateway: { routes: [{ host, address: host, ports, protocols: ["udp"] }] },
    }, null, 2) + "\n");
    console.log(`${out}: gateway route ${host} udp ports ${ports.join(",")}`);
}

/* ---------------- main ---------------- */

const [cmd, ...argv] = process.argv.slice(2);
const { rest, force, roleModes, wireHost } = parseArgs(argv);
if (cmd === "_run-role") {
    if (rest.length !== 2 || !process.env.BS_LANDIFF_COORD) usage();
    await runRoleChild(rest[0], rest[1], resolve(process.env.BS_LANDIFF_COORD));
} else if (cmd === "record" || cmd === "run") {
    if (rest.length !== 1) usage();
    if (caseRoles(rest[0]).length) {
        if (!(await runMultiRole(rest[0], cmd, force, roleModes, wireHost))) process.exitCode = 1;
    } else {
        if (cmd === "run" || wireHost || roleModes) throw new Error("These options require a multi-role case");
        await record(rest[0], force);
    }
} else if (cmd === "check") {
    if (!rest.length) usage();
    if (rest.includes("all") && (roleModes || wireHost)) throw new Error("--as and --wire-host require an explicit case");
    const targets = rest.includes("all") ? listCases().filter(id => {
        const roles = caseRoles(id);
        return roles.length ? roles.every(role => existsSync(rolePaths(id, role).golden)) : existsSync(casePaths(id).golden);
    }) : rest;
    let passed = 0, failed = 0, skipped = 0;
    for (const id of targets) {
        try {
            const roles = caseRoles(id);
            if (!roles.length && (wireHost || roleModes)) throw new Error("Role options require a multi-role case");
            const scripts = roles.length
                ? planRoles(roles, "check", roleModes, wireHost).map(p => ({text: readFileSync(rolePaths(id, p.role).script, "utf8"), mode: p.mode}))
                : [{text: readFileSync(casePaths(id).script, "utf8"), mode: "emu" as const}];
            const skip = checkSkip(scripts);
            if (skip) { console.log("SKIP " + id + ": " + skip); skipped++; continue; }
            const ok = roles.length ? await runMultiRole(id, "check", force, roleModes, wireHost) : await check(id);
            if (ok) passed++; else failed++;
        } catch (error) {
            failed++;
            console.error("FAIL " + id + ": " + (error instanceof Error ? error.message : error));
        }
    }
    console.log(passed + " matched, " + failed + " failed, " + skipped + " skipped");
    if (failed) process.exitCode = 1;
} else if (cmd === "gateway-config") {
    const out = rest[0] ?? join(root, "logs/lan-conformance/gateway-server.json");
    const ports = rest.slice(1).map(Number).filter(Number.isInteger);
    await gatewayConfig(out, ports.length ? ports : [23911, 23912, 23913, 23914]);
} else if (cmd === "list") {
    for (const id of listCases()) {
        const roles = caseRoles(id);
        console.log(roles.length ? id + " [" + roles.join(",") + "]" : id);
    }
} else usage();
