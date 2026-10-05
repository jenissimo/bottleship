#!/usr/bin/env bun
/**
 * libid — whose hot code is this: the game's, or a library's.
 *
 * A thin wrapper over `tools/re/libid.py`: it resolves python and Ghidra the same way
 * `re.ts` does (`ensureReEnv`), so the call looks like the rest of the tooling and needs
 * nobody to set JAVA_HOME by hand.
 *
 *   bun tools/re/libid.ts index tmp/nfsu/Speed.exe          image map (once per image)
 *   bun tools/re/libid.ts ask   tmp/nfsu/Speed.exe 0x672fc8 g0040d001@t12
 *   bun tools/re/libid.ts ask   tmp/nfsu/Speed.exe --addrs hot.txt --json
 *   bun tools/re/libid.ts summary tmp/nfsu/Speed.exe        distribution by owner
 *   bun tools/re/libid.ts sigs  C:/Windows/SysWOW64/d3dx9_24.dll --lib d3dx9
 *   bun tools/re/libid.ts selftest tmp/nfsu/Speed.exe       run against known anchors
 *
 * `index` and `sigs` open the image in Ghidra (project cache shared with re-service,
 * analysis once per sha256). `ask`/`summary`/`selftest` read the built index and need no
 * Ghidra at all — a list of hot addresses is answered in a fraction of a second.
 *
 * How this differs from re.ts: `re resolve` answers WHAT the function at an address is
 * called, libid answers WHOSE code it is. Different questions: `FUN_00672fc8` is an
 * honest name and a useless answer at the same time, if what lives there is CRT `__ftol`.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureReEnv } from "./bootstrap";

const HERE = import.meta.dir;
const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(`libid — whose code is this: the game's or a library's

  bun tools/re/libid.ts index <binary> [--sigs DIR]      build the image map (Ghidra)
  bun tools/re/libid.ts ask <binary> <0xaddr...> [--addrs FILE] [--json]
  bun tools/re/libid.ts summary <binary> [--json]        distribution by owner
  bun tools/re/libid.ts sigs <donor.dll> --lib <name>    signatures off a donor library
  bun tools/re/libid.ts selftest <binary>                run against known anchors`);
    process.exit(argv.length === 0 ? 1 : 0);
}

// `ask` needs no Ghidra — don't pay for the bootstrap where it buys nothing.
const needsGhidra = argv[0] === "index" || argv[0] === "sigs";
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
let python = process.env.LIBID_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
if (needsGhidra) {
    const re = await ensureReEnv();
    python = re.python;
    env.GHIDRA_INSTALL_DIR = re.ghidraDir;
    env.JAVA_HOME = re.javaHome;
    env.PATH = `${re.javaHome}/bin${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
}

const r = spawnSync(python, [join(HERE, "libid.py"), ...argv], { stdio: "inherit", env });
process.exit(r.status ?? 1);
