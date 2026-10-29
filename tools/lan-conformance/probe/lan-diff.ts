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
import { resolve, dirname, join } from "node:path";
import { mkdirSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function parseArgs(argv: string[]) {
    const rest: string[] = [];
    let force = false;
    let roleModes: Record<string, "native" | "emu"> | undefined;
    for (const a of argv) {
        if (a === "--force") force = true;
        else if (a.startsWith("--as=")) {
            roleModes = {};
            for (const pair of a.slice("--as=".length).split(",")) {
                const [role, mode] = pair.split("=");
                if (!/^[a-z0-9]+$/.test(role ?? "") || (mode !== "native" && mode !== "emu")) {
                    throw new Error(`Bad --as entry "${pair}" (want role=native|emu)`);
                }
                roleModes[role] = mode;
            }
        } else rest.push(a);
    }
    return { rest, force, roleModes };
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

/** `# emu-skip <reason>` in a role script: emulator run not expressible yet. */
function emuSkipReason(caseId: string): string | null {
    for (const role of caseRoles(caseId)) {
        const path = rolePaths(caseId, role).script;
        if (!existsSync(path)) continue;
        const m = /^# emu-skip (.+)$/m.exec(readFileSync(path, "utf8"));
        if (m) return m[1].trim();
    }
    return null;
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
    const bundle = await packBundle(caseId, script, work);

    try {
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
        const guestPath = join(work, "guest.log");
        await Bun.write(guestPath, guestLog);
        if (!diffLogs(caseId, goldenLog, guestLog, golden, guestPath)) process.exitCode = 1;
    } finally {
        closeHarnessConnection();
    }
}

/* ---------------- multi-role coordination ---------------- */

/** Gate names in a script (`gate <name>`) or a running log (`gate <name> enter`). */
function gateNames(scriptText: string): string[] {
    const names = new Set<string>();
    for (const m of scriptText.matchAll(/^gate ([a-z0-9-]+)/gm)) names.add(m[1]);
    return [...names];
}

/** Names each role publishes through `publishaddr <s> <name>` scripts. */
function publishedNamesByRole(caseId: string, roles: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const role of roles) {
        const names = new Set<string>();
        for (const m of readFileSync(rolePaths(caseId, role).script, "utf8").matchAll(/^publishaddr \S+ ([a-z0-9-]+)$/gm)) {
            names.add(m[1]);
        }
        out.set(role, [...names]);
    }
    return out;
}

/** Names each role raises through `signal <name>` (local gate-<name>.open). */
function signalNamesByRole(caseId: string, roles: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const role of roles) {
        const names = new Set<string>();
        for (const m of readFileSync(rolePaths(caseId, role).script, "utf8").matchAll(/^signal ([a-z0-9-]+)$/gm)) {
            names.add(m[1]);
        }
        out.set(role, [...names]);
    }
    return out;
}

interface RoleResult { ok: boolean; log: string; error?: string }

/**
 * One role of a multi-role case, as a child process. Native roles run the
 * probe directly; emulated roles boot a bundle in their own BS_TAB tab and
 * poll the guest log. Both relay the shared coordinator's gate files into
 * their probe's gate directory and mirror the running log back.
 */
async function runRoleChild(caseId: string, role: string, coordDir: string) {
    const emulated = process.env.BS_LANDIFF_MODE === "emu";
    const { script, work } = casePaths(caseId);
    const { script: roleScript } = rolePaths(caseId, role);
    const deadline = Date.now() + 150_000;
    let logPath: string;
    let gateDir: string;

    if (emulated) {
        // each role child drives its own BS_TAB tab; create it if absent
        await findOrCreateTab(DEFAULT_DEV_URL);
        const roles = caseRoles(caseId);
        const deleteFiles = ["C:\\case.log"];
        for (const r of roles) {
            const scriptText = readFileSync(rolePaths(caseId, r).script, "utf8");
            for (const name of gateNames(scriptText)) deleteFiles.push(`C:\\gate-${name}.open`);
            for (const name of signalNamesByRole(caseId, roles).get(r) ?? []) deleteFiles.push(`C:\\gate-${name}.open`);
            for (const name of publishedNamesByRole(caseId, roles).get(r) ?? []) {
                deleteFiles.push(`C:\\addr-${name}.txt`);
            }
        }
        const bundle = await packBundle(`${caseId}/${role}`, roleScript, join(work, `game-${role}`), deleteFiles, role);
        await bootBundle(bundle);
        logPath = "guest:C:\\case.log";
        gateDir = "guest:C:\\";
    } else {
        const roleDir = join(work, `native-${role}`);
        mkdirSync(roleDir, { recursive: true });
        logPath = join(roleDir, "case.log");
        gateDir = roleDir;
        const exe = await buildProbe();
        const child = Bun.spawn([exe, roleScript, logPath], {
            cwd: roleDir, stdout: "inherit", stderr: "inherit",
        });
        child.unref();
    }

    const relayedGates = new Set<string>();
    const reportedGates = new Set<string>();
    // address publishing: mirror my addr-*.txt into the coordination dir and
    // the other roles' addr-*.txt back into my probe's gate directory
    const allRoles = caseRoles(caseId);
    const myPublish = publishedNamesByRole(caseId, [role]).get(role) ?? [];
    const otherPublish = [...publishedNamesByRole(caseId, allRoles).entries()]
        .flatMap(([r, names]) => r === role ? [] : names);
    const emitted = new Set<string>();
    const ingested = new Set<string>();
    const mySignals = signalNamesByRole(caseId, [role]).get(role) ?? [];
    const otherSignals = [...signalNamesByRole(caseId, allRoles).entries()]
        .flatMap(([r, names]) => r === role ? [] : names);
    const emittedSignals = new Set<string>();
    const ingestedSignals = new Set<string>();
    const emitAddress = async (name: string) => {
        if (emulated) {
            try {
                const result = await harness().fsRead("C:\\addr-" + name + ".txt").run();
                const record = result.named.fsRead as { content?: string } | undefined;
                if (!result.ok || record?.content === undefined) return false;
                const body = new TextDecoder().decode(Uint8Array.from(atob(record.content), c => c.charCodeAt(0)));
                if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(body.trim())) return false;
                await Bun.write(join(coordDir, `addr-${name}.txt`), body);
                return true;
            } catch { return false; }
        }
        const path = join(gateDir, `addr-${name}.txt`);
        if (!existsSync(path)) return false;
        const body = readFileSync(path, "utf8");
        if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(body.trim())) return false;
        writeFileSync(join(coordDir, `addr-${name}.txt`), body);
        return true;
    };
    const ingestAddress = async (name: string) => {
        const path = join(coordDir, `addr-${name}.txt`);
        if (!existsSync(path)) return;
        const body = await Bun.file(path).text();
        if (emulated) {
            await harness().fsWrite("C:\\addr-" + name + ".txt", body).run();
        } else {
            writeFileSync(join(gateDir, `addr-${name}.txt`), body);
        }
    };
    let finished = false;
    let lastLog = "";
    while (Date.now() < deadline && !finished) {
        await Bun.sleep(150);
        for (const name of myPublish) {
            if (!emitted.has(name) && await emitAddress(name)) emitted.add(name);
        }
        for (const name of otherPublish) {
            if (!ingested.has(name) && existsSync(join(coordDir, `addr-${name}.txt`))) {
                ingested.add(name);
                await ingestAddress(name);
            }
        }
        for (const name of mySignals) {
            if (emittedSignals.has(name)) continue;
            const path = join(gateDir, `gate-${name}.open`);
            if (existsSync(path)) {
                await Bun.write(join(coordDir, `gate-${name}.open`), readFileSync(path));
                emittedSignals.add(name);
            }
        }
        for (const name of otherSignals) {
            if (!ingestedSignals.has(name) && existsSync(join(coordDir, `gate-${name}.open`))) {
                ingestedSignals.add(name);
                if (emulated) {
                    await harness().fsWrite("C:\\gate-" + name + ".open", "").run();
                } else {
                    writeFileSync(join(gateDir, `gate-${name}.open`), "");
                }
            }
        }
        let log = "";
        try {
            log = emulated ? await readCaseLog() : await Bun.file(logPath).text();
        } catch { continue; }
        if (log !== lastLog) {
            lastLog = log;
            await Bun.write(join(coordDir, `${role}.log`), log);
        }
        for (const name of gateNames(log)) {
            if (!reportedGates.has(name)) {
                reportedGates.add(name);
                await Bun.write(join(coordDir, `${role}.at-${name}`), "");
            }
            if (!relayedGates.has(name) && existsSync(join(coordDir, `gate-${name}.open`))) {
                relayedGates.add(name);
                if (emulated) {
                    await harness().fsWrite("C:\\gate-" + name + ".open", "").run();
                } else {
                    writeFileSync(join(gateDir, `gate-${name}.open`), "");
                }
            }
        }
        if (/^exit \d+$/m.test(log)) finished = true;
    }
    if (!finished) {
        if (emulated) {
            try {
                const report = await harness().report().run();
                console.error(`[${caseId}/${role}] guest did not finish; report: ${JSON.stringify(report).slice(0, 1500)}`);
            } catch { /* report is best-effort */ }
        }
        console.error(`[${caseId}/${role}] role did not finish within the deadline; last log:\n${lastLog}`);
        process.exit(1);
    }
    await Bun.write(join(coordDir, `${role}.final.log`), lastLog);
    if (emulated) closeHarnessConnection();
}

/**
 * Parent of a multi-role run: spawns one role child per role, watches the
 * shared coordination directory, releases gates once every role arrived.
 */
async function runMultiRole(caseId: string, mode: "record" | "check", force: boolean, roleModes?: Record<string, "native" | "emu">): Promise<boolean> {
    const roles = caseRoles(caseId);
    if (!roles.length) throw new Error(`No role scripts for ${caseId}`);
    for (const role of roles) {
        const { script, golden } = rolePaths(caseId, role);
        if (!existsSync(script)) throw new Error(`No role script: ${script}`);
        if (mode === "check" && !existsSync(golden)) {
            throw new Error(`No golden log: ${golden} — run 'record ${caseId}' first`);
        }
        if (mode === "record" && existsSync(golden) && !force) {
            throw new Error(`Golden exists: ${golden} (pass --force to re-record)`);
        }
    }
    const gateNamesByRole: Array<{ role: string; gates: string[] }> = [];
    for (const role of roles) {
        const { script } = rolePaths(caseId, role);
        gateNamesByRole.push({ role, gates: gateNames(await Bun.file(script).text()) });
    }
    const allGateNames = [...new Set(gateNamesByRole.flatMap(r => r.gates))];

    const { work } = casePaths(caseId);
    const coordDir = join(work, `coord-${Date.now()}`);
    mkdirSync(coordDir, { recursive: true });

    const baseTab = process.env.BS_TAB ?? "";
    const children = roles.map(role => {
        const tab = baseTab ? `${baseTab}-${role}` : `lanprobe-${role}`;
        // goldens are recorded from an all-native run; check pins each role to
        // its requested environment (default emu; --as role=native pins mixed)
        const roleMode = mode === "record" ? "native" : roleModes?.[role] ?? "emu";
        return Bun.spawn([bun, import.meta.path, "_run-role", caseId, role], {
            cwd: root,
            env: {
                ...process.env,
                BS_LANDIFF_MODE: roleMode,
                BS_LANDIFF_COORD: coordDir,
                BS_TAB: tab,
            },
            stdout: "inherit", stderr: "inherit",
        });
    });

    const released = new Set<string>();
    const coordDeadline = Date.now() + 180_000;
    while (Date.now() < coordDeadline) {
        await Bun.sleep(100);
        let allDone = true;
        for (const child of children) if (child.exitCode === null) allDone = false;
        for (const name of allGateNames) {
            if (released.has(name)) continue;
            const everyone = gateNamesByRole.every(({ role, gates }) =>
                !gates.includes(name) || existsSync(join(coordDir, `${role}.at-${name}`)));
            if (everyone) {
                released.add(name);
                await Bun.write(join(coordDir, `gate-${name}.open`), "");
            }
        }
        if (allDone) break;
    }
    await Promise.all(children.map(c => c.exited));

    let ok = true;
    for (const role of roles) {
        const finalPath = join(coordDir, `${role}.final.log`);
        if (!existsSync(finalPath)) {
            console.error(`FAIL ${caseId}/${role}: no final log (role crashed or timed out)`);
            ok = false;
            continue;
        }
        const log = await Bun.file(finalPath).text();
        if (!log.endsWith("exit 0\n")) {
            console.error(`FAIL ${caseId}/${role}: probe did not exit cleanly:\n${log}`);
            ok = false;
            continue;
        }
        if (mode === "record") {
            const { golden } = rolePaths(caseId, role);
            mkdirSync(dirname(golden), { recursive: true });
            await Bun.write(golden, log);
            console.log(log);
            console.log(`golden: ${golden}`);
        } else {
            const { golden } = rolePaths(caseId, role);
            const goldenLog = await Bun.file(golden).text();
            const guestPath = join(coordDir, `${role}.guest.log`);
            await Bun.write(guestPath, log);
            if (!diffLogs(`${caseId}/${role}`, goldenLog, log, golden, guestPath)) ok = false;
        }
    }
    if (mode === "check" && ok) console.log(`${caseId}: all ${roles.length} roles match native.`);
    return ok;
}

/* ---------------- gateway config ---------------- */

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
const { rest, force, roleModes } = parseArgs(argv);
if (cmd === "_run-role") {
    // child of runMultiRole — mode and tab come from the environment
    if (rest.length !== 2) usage();
    await runRoleChild(rest[0], rest[1], resolve(process.env.BS_LANDIFF_COORD ?? ""));
} else if (cmd === "record") {
    if (rest.length !== 1) usage();
    if (caseRoles(rest[0]).length) {
        await runMultiRole(rest[0], "record", force);
    } else {
        await record(rest[0], force);
    }
} else if (cmd === "check") {
    if (!rest.length) usage();
    const targets = rest.includes("all")
        ? listCases().filter(id => {
            if (roleModes) return false; // --as targets explicit cases, not all
            if (caseRoles(id).length) return caseRoles(id).every(r => existsSync(rolePaths(id, r).golden));
            return existsSync(casePaths(id).golden);
        })
        : rest;
    let failed = 0;
    for (const id of targets) {
        try {
            if (caseRoles(id).length) {
                const skip = emuSkipReason(id);
                if (skip) {
                    console.log(`SKIP ${id} (emu-skip: ${skip})`);
                    continue;
                }
                if (!(await runMultiRole(id, "check", force, roleModes))) {
                    failed++;
                    process.exitCode = 1;
                }
            } else {
                await check(id);
            }
        } catch (error) {
            failed++;
            console.error(`FAIL ${id}: ${error instanceof Error ? error.message : error}`);
            process.exitCode = 1;
        }
    }
    if (targets.length > 1) {
        console.log(`${targets.length - failed}/${targets.length} cases match native.`);
    }
} else if (cmd === "gateway-config") {
    const out = rest[0] ?? join(root, "logs/lan-conformance/gateway-server.json");
    const ports = rest.slice(1).map(Number).filter(Number.isInteger);
    await gatewayConfig(out, ports.length ? ports : [23911, 23912]);
} else if (cmd === "list") {
    for (const id of listCases()) {
        const roles = caseRoles(id);
        console.log(roles.length ? `${id} [${roles.join(",")}]` : id);
    }
} else {
    usage();
}
