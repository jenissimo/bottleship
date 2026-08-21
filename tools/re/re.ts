#!/usr/bin/env bun
/**
 * re — thin CLI client for the warm RE backend. Mirrors the harness CLI
 * feel: `bun tools/re.ts decompile 0x401000`. Talks to re-service.py over HTTP
 * ({cmd,args} -> {ok,result|error}); `re start` launches the warm service.
 *
 *   bun tools/re/re.ts start <binary>          launch service + open binary
 *   bun tools/re/re.ts open <binary>
 *   bun tools/re/re.ts decompile <addr|name>
 *   bun tools/re/re.ts disasm <addr> [len]
 *   bun tools/re/re.ts callers|xrefs <addr>
 *   bun tools/re/re.ts symbols | strings | info
 *   bun tools/re/re.ts doctor                  backend availability; answers with the service down too
 *   bun tools/re/re.ts resolve <eip> [--base <liveModuleBase>]   wild-EIP -> func
 *   bun tools/re/re.ts exportSymbolMap [--out game.symbols.json] [--module name]
 *
 * The static<->dynamic bridge:
 *  - harness emits fault/breakHit with a live EIP -> `re resolve <eip> --base <liveBase>`
 *    (liveBase from harness.state(['modules'])) -> core.dll!Func+0x.. + decompile.
 *  - `re exportSymbolMap --out <game>.symbols.json` -> the harness loads it via
 *    loadSymbols(module, symbols) so breakOnSymbol('mod!Func') works.
 */

import { existsSync, openSync } from "node:fs";
import { delimiter as PATH_DELIM, join } from "node:path";
import { ensureReEnv } from "./bootstrap";

// Overridable so the service-down path stays exercisable (point it at a dead port); the
// default is what every caller and the spawned service use.
const PORT = Number(process.env.RE_PORT ?? 9334);
const HERE = import.meta.dir;

const NOT_RUNNING = `the RE service is not running on port ${PORT}.\n`
    + `  Start it (this also opens the binary and runs the one-time analysis):\n`
    + `      bun tools/re/re.ts start <binary>\n`
    + `  Then re-run this command. \`re doctor\` reports backend availability without the service.`;

/** Rewrite the service's own failures into something that names the fix. */
function explain(cmd: string, error: string): string {
    if (/LockException|Unable to lock project/i.test(error)) {
        return `${cmd}: the cached Ghidra project is locked.\n`
            + `  The service holds one binary at a time and the first \`open\` keeps the lock for the whole\n`
            + `  analysis (minutes on a large image). Wait for it to finish — \`re doctor\` shows "open" once\n`
            + `  it has — rather than issuing a second \`open\`.\n`
            + `  If no re-service.py process is alive, the lock is stale: delete the *.lock/*.lock~ under the\n`
            + `  project's own hash directory (see projectRoot in \`re doctor\`) and retry.\n`
            + `  raw: ${error}`;
    }
    if (/no program open/i.test(error)) {
        return `${cmd}: no binary is open in the service — run \`bun tools/re/re.ts open <binary>\` first.`;
    }
    return `${cmd}: ${error}`;
}

async function call(cmd: string, args: unknown[] = []): Promise<any> {
    let r: Response;
    try {
        r = await fetch(`http://localhost:${PORT}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd, args }),
        });
    } catch {
        // A bare fetch error here reads as a network problem and sends people looking in the
        // wrong place; the only real cause is that nobody started the service.
        throw new Error(`${cmd}: ${NOT_RUNNING}`);
    }
    const j = await r.json();
    if (!j.ok) throw new Error(explain(cmd, String(j.error)));
    return j.result;
}

async function serviceUp(): Promise<boolean> {
    try { return (await fetch(`http://localhost:${PORT}/health`)).ok; } catch { return false; }
}

/** Backend availability that can be answered without the service — what `doctor` falls back to. */
function localDoctor(): Record<string, unknown> {
    const repo = join(HERE, "..", "..");
    const exe = process.platform === "win32" ? ".bat" : "";
    const envGhidra = process.env.GHIDRA_INSTALL_DIR;
    return {
        serviceRunning: false,
        port: PORT,
        ghidraInstallDir: envGhidra ?? null,
        ghidraInstallDirUsable: !!envGhidra && existsSync(join(envGhidra, "support", `analyzeHeadless${exe}`)),
        repoLocalGhidraDir: existsSync(join(repo, ".ghidra")),
        repoLocalJdkOrVenvDir: existsSync(join(repo, ".ghidra-home")),
        peDisasFallback: existsSync(join(repo, "tools", "pe-disas.py")),
        projectRoot: join(repo, "tmp", "ghidra_project"),
        serviceLog: join(repo, ".ghidra-home", "re-service.log"),
        hint: "run `bun tools/re/re.ts start <binary>`; it bootstraps Ghidra + JDK 21 + pyghidra if missing",
    };
}

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function startService(binary?: string): Promise<void> {
    if (!(await serviceUp())) {
        // Resolve (installing into .ghidra/.ghidra-home if absent) Ghidra + JDK 21 + a
        // pyghidra python. Cross-platform — no powershell dependency on POSIX.
        const env = await ensureReEnv();
        const script = `${HERE}/re-service.py`;
        const childEnv: Record<string, string> = {
            ...(process.env as Record<string, string>),
            GHIDRA_INSTALL_DIR: env.ghidraDir,
            JAVA_HOME: env.javaHome,
            PATH: `${env.javaHome}/bin${PATH_DELIM}${process.env.PATH ?? ""}`,
        };
        // Detached so the warm service outlives this CLI process; stdio → log file.
        const fd = openSync(env.logFile, "a");
        if (process.platform === "win32") {
            Bun.spawnSync(["powershell", "-NoProfile", "-Command",
                `Start-Process -FilePath '${env.python}' -ArgumentList '${script}','--port','${PORT}' -WindowStyle Hidden`],
                { env: childEnv });
        } else {
            const child = Bun.spawn([env.python, script, "--port", String(PORT)],
                { env: childEnv, stdin: "ignore", stdout: fd, stderr: fd });
            child.unref();
        }
        for (let i = 0; i < 60; i++) { if (await serviceUp()) break; await Bun.sleep(500); }
        if (!(await serviceUp())) throw new Error(`re-service did not come up; see ${env.logFile} and check \`re doctor\``);
    }
    if (binary) console.log(JSON.stringify(await call("open", [binary]), null, 2));
}

async function main(): Promise<void> {
    const [, , cmd, ...rest] = process.argv;
    // Filter by element index (not indexOf — that finds the first occurrence and
    // mis-pairs when a flag value duplicates a positional value).
    const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
    switch (cmd) {
        case "start": await startService(positional[0]); break;
        case "doctor": {
            // The one command that must answer with the service down — it is what people run to
            // find out WHY nothing works, so it may not itself fail with a connection error.
            if (!(await serviceUp())) {
                console.error(NOT_RUNNING);
                console.log(JSON.stringify(localDoctor(), null, 2));
                process.exit(1);
            }
            console.log(JSON.stringify({ serviceRunning: true, port: PORT, ...(await call("doctor")) }, null, 2));
            break;
        }
        case "resolve": {
            const eip = positional[0];
            const liveBase = flag("--base");
            if (liveBase) {
                // Relocate the live EIP into the binary's own image-base space.
                const info = await call("info");
                const rva = (parseInt(eip, 16) >>> 0) - (parseInt(liveBase, 16) >>> 0);
                const staticAddr = ((info.base >>> 0) + rva) >>> 0;
                console.log(JSON.stringify(await call("resolve", ["0x" + staticAddr.toString(16)]), null, 2));
            } else {
                console.log(JSON.stringify(await call("resolve", [eip]), null, 2));
            }
            break;
        }
        case "exportSymbolMap": {
            const map = await call("exportSymbolMap");
            const out = flag("--out");
            const payload = { module: flag("--module") ?? map.module, symbols: map.symbols };
            if (out) { await Bun.write(out, JSON.stringify(payload, null, 2)); console.log(`wrote ${Object.keys(map.symbols).length} symbols -> ${out}`); }
            else console.log(JSON.stringify(payload, null, 2));
            break;
        }
        case "disasm": console.log(JSON.stringify(await call("disasm", [positional[0], positional[1] ? Number(positional[1]) : 64]), null, 2)); break;
        case "open": case "decompile": case "callers": case "xrefs": case "dataAt": case "mkfunc":
            console.log(JSON.stringify(await call(cmd, [positional[0]]), null, 2)); break;
        case "symbols": case "strings": case "info":
            console.log(JSON.stringify(await call(cmd), null, 2)); break;
        default:
            console.log("usage: bun tools/re/re.ts <start|open|decompile|disasm|mkfunc|callers|xrefs|symbols|strings|resolve|exportSymbolMap|info|doctor> [args]");
            process.exit(cmd ? 1 : 0);
    }
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
