#!/usr/bin/env node
// Builds v86 only in an OS-temp copy, then runs the deterministic JIT integrity milestone.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const root = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)), "..");
const keep = process.argv.includes("--keep-temp");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bottleship-jit-integrity-"));
const engine = path.join(temp, "vendor", "v86");
const artifacts = ["vendor/v86/build/v86.wasm", "public/v86.wasm", "dist/v86.wasm"].map(p => path.join(root, p));
const digest = p => fssync.existsSync(p) ? createHash("sha256").update(fssync.readFileSync(p)).digest("hex") : "missing";
const before = new Map(artifacts.map(p => [p, digest(p)]));
function resolveBash() {
    if (process.platform !== "win32") return "bash";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const candidates = [
        path.join(programFiles, "Git", "bin", "bash.exe"),
        path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    ];
    const found = candidates.find(p => fssync.existsSync(p));
    if (found) return found;
    throw new Error("Git Bash was not found. Install Git for Windows (bash.exe), then rerun gate:jit-integrity; refusing the WindowsApps/WSL bash stub.");
}
const run = (label, command, args, cwd = root, env = {}) => new Promise((resolve, reject) => {
    console.error(`\n== ${label} ==\n$ ${command} ${args.map(String).join(" ")}`);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", e => reject(new Error(`${label}: ${e.message}`)));
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${label}: exit ${code}`)));
});
const safeCleanup = async () => {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(temp);
    const rel = path.relative(tempRoot, resolved);
    if (path.basename(resolved).startsWith("bottleship-jit-integrity-") === false
        || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`refusing to remove non-gate temp path ${resolved}`);
    }
    await fs.rm(temp, { recursive: true, force: true });
};

let primaryError;
try {
    await fs.mkdir(path.dirname(engine), { recursive: true });
    await fs.cp(path.join(root, "vendor", "v86"), engine, {
        recursive: true,
        filter: source => ![".git", "build", "target", "node_modules", ".cache"].includes(path.basename(source)),
    });
    await run("disposable v86 build", resolveBash(), ["build-wasm.sh"], engine);
    const wasm = path.join(engine, "build", "v86.wasm");
    if (!fssync.existsSync(wasm)) throw new Error(`build did not produce ${wasm}`);
    const env = { V86_WASM_PATH: wasm, V86_ENGINE_DIR: engine };
    await run("project static gate", "bun", ["run", "gate"], root, env);
    // wasm32-unknown-unknown has no configured test runner in this cdylib crate, so Cargo cannot
    // execute #[test] binaries. `--no-run` is the strongest valid Cargo invocation: it builds the
    // lib test harness with cfg(test), while the runtime contracts below execute the exported wasm.
    // build-wasm.sh supplies zstddeclib.o outside Cargo, so give the test link the same disposable
    // object explicitly rather than claiming an unlinked `cargo test` is coverage.
    await run("Rust wasm test-harness compile (no wasm runner)", "cargo", ["test", "--target", "wasm32-unknown-unknown", "--lib", "--no-run"],
        engine, { RUSTFLAGS: "-C link-arg=build/zstddeclib.o" });
    for (const test of ["jit-alive-repro.mjs", "jit-recovery-repro.mjs", "fpu-absolute.mjs", "memory-oob-contract.mjs", "jit-aot-transaction-contract.mjs"])
        await run(`runtime ${test}`, process.execPath, [path.join(engine, "tests", test)], engine, env);
    await run("AOT oracle self-test", process.execPath, ["tools/aot-oracle/oracle.mjs", "--self-test"], root, env);
    // This is the producer proof, intentionally separate from unit:auto below. Its job is
    // captured from the disposable engine, compiled to an OS-temp output, and replayed by its
    // named manifest; the workspace never receives a generated wasm or manifest.
    const offline = path.join(temp, "offline");
    const job = path.join(offline, "k3.json");
    const unit = path.join(offline, "k3-unit");
    await fs.mkdir(offline, { recursive: true });
    await run("offline AOT capture", process.execPath,
        ["tools/aot/capture-job.mjs", "--case", "k3", "--out", job], root, env);
    await run("offline AOT compile", process.execPath,
        ["tools/aot/aotc.mjs", "--job", job, "--out", unit, "--v86", wasm], root, env);
    await run("AOT offline differential proof", process.execPath,
        ["tools/aot-oracle/oracle.mjs", "--prove", "--candidate", `unit:${unit}.json`, "--case", "k3"], root, env);
    await run("AOT transactional differential proof", process.execPath,
        ["tools/aot-oracle/oracle.mjs", "--prove", "--candidate", "unit:auto", "--case", "k1"], root, env);
    console.error("\nJIT integrity gate passed.");
} catch (error) {
    primaryError = error;
}

const integrityErrors = [];
try {
    const changed = artifacts.filter(p => digest(p) !== before.get(p));
    if (changed.length) integrityErrors.push(new Error(`workspace generated artifact changed: ${changed.join(", ")}`));
} finally {
    if (keep) console.error(`temporary engine retained: ${temp}`);
    else {
        try { await safeCleanup(); }
        catch (error) { integrityErrors.push(error); }
    }
}
if (primaryError && integrityErrors.length) {
    throw new AggregateError([primaryError, ...integrityErrors], "JIT integrity gate failed and cleanup/integrity checks also failed");
}
if (primaryError) throw primaryError;
if (integrityErrors.length === 1) throw integrityErrors[0];
if (integrityErrors.length) throw new AggregateError(integrityErrors, "JIT integrity cleanup/integrity checks failed");
