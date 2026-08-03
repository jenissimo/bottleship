// Focused producer/consumer contract test. It deliberately uses the real capture, compiler,
// verifier, and v86 publication arm: a shaped JSON object alone would not prove an ABI envelope
// actually guards replay.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const root = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)), "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aot-identity-envelope-"));
const engine = process.env.V86_ENGINE_DIR || path.join(root, "vendor", "v86");
const env = { ...process.env, V86_ENGINE_DIR: engine };
const node = process.execPath;
const run = (label, script, args, expected = 0) => {
    const r = spawnSync(node, [script, ...args], { cwd: root, env, encoding: "utf8", timeout: 180000 });
    assert.equal(r.error, undefined, `${label}: ${r.error?.message ?? "spawn failed"}`);
    assert.equal(r.status, expected, `${label}: expected ${expected}, got ${r.status}\n${r.stderr}`);
    return r;
};
const write = (name, value) => {
    const file = path.join(temp, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
};

try {
    const job = path.join(temp, "k3.json");
    const out = path.join(temp, "k3-unit");
    run("capture", "tools/aot/capture-job.mjs", ["--case", "k3", "--out", job]);
    run("compile", "tools/aot/aotc.mjs", ["--job", job, "--out", out,
        "--v86", path.join(engine, "build", "v86.wasm")]);

    const manifestFile = `${out}.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.jit_identity.aot_abi, 5);
    assert.equal(manifest.jit_identity.engine_sha256, manifest.engine_sha256);
    assert.ok(Number.isInteger(manifest.jit_identity.ram_size));
    assert.ok(Number.isInteger(manifest.units[0].tableIndex) && manifest.units[0].tableIndex > 0 && manifest.units[0].tableIndex < 900);
    // A genuine compiler output must make it all the way into the real staged publication arm.
    run("load valid manifest", "tools/aot-oracle/arms/run-v86.mjs",
        ["--case", "k3", "--outer", "200", "--warmup", "100", "--aot", manifestFile]);

    const missing = structuredClone(manifest);
    delete missing.jit_identity;
    run("refuse missing identity", "tools/aot-oracle/arms/run-v86.mjs",
        ["--case", "k3", "--outer", "1", "--warmup", "1", "--aot", write("missing.json", missing)], 3);
    const mismatched = structuredClone(manifest);
    mismatched.jit_identity.fingerprint_lo ^= 1;
    run("refuse mismatched identity", "tools/aot-oracle/arms/run-v86.mjs",
        ["--case", "k3", "--outer", "1", "--warmup", "1", "--aot", write("mismatched.json", mismatched)], 3);
    for (const [name, slot] of [["null-slot", null], ["zero-slot", 0], ["out-of-range-slot", 900]]) {
        const bad = structuredClone(manifest);
        bad.units[0].tableIndex = slot;
        run(`refuse ${name}`, "tools/aot-oracle/arms/run-v86.mjs",
            ["--case", "k3", "--outer", "1", "--warmup", "1", "--aot", write(`${name}.json`, bad)], 3);
    }
    console.log("PASS aot identity envelope: captured, compiled, loaded, and refused malformed replay manifests");
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
