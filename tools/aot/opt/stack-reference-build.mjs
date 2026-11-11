import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const out = path.resolve(process.argv[2] || path.join(repo, "tmp/stack-experiment/reference"));
const sdk = path.resolve(process.env.EMSDK || "C:/Projects/emsdk");
const pythonDir = fs.readdirSync(path.join(sdk, "python")).find(name => name.endsWith("_64bit"));
if (!pythonDir) throw new Error("EMSDK Python runtime not found");
const python = path.join(sdk, "python", pythonDir, "python.exe");
const emcc = path.join(sdk, "upstream/emscripten/em++.py");
const env = { ...process.env, EM_CONFIG: path.join(sdk, ".emscripten") };
fs.mkdirSync(out, { recursive: true });
const history = [];
const run = (args) => {
    const result = spawnSync(python, [emcc, ...args], { env, cwd: repo, encoding: "utf8", windowsHide: true });
    history.push({ exe: python, args: [emcc, ...args], exitCode: result.status,
        stdout: result.stdout, stderr: result.stderr });
    if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr));
};
run(["--version"]);
const common = ["-O3", "-fno-exceptions", "-fno-rtti", "-fno-vectorize", "-fno-slp-vectorize"];
const sources = ["stack-reference-kernel.cpp", "stack-reference-driver.cpp"];
for (const source of sources) {
    run([...common, "-c", path.join(here, source), "-o", path.join(out, source + ".o")]);
}
run([...common, ...sources.map(source => path.join(out, source + ".o")),
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node",
    '-sEXPORTED_FUNCTIONS=["_reference_source","_reference_destination","_reference_calls","_reference_reset","_reference_run"]',
    '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', "-o", path.join(out, "reference.mjs")]);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const build = {
    schema: 1, builtAt: new Date().toISOString(),
    contract: "equivalent reconstructed k8 compute; retail original source unavailable",
    policy: "separate kernel/driver translation units; scalar -O3; no LTO; runtime input bytes",
    sources: Object.fromEntries(sources.map(source => [source, hash(path.join(here, source))])),
    artifacts: Object.fromEntries(["reference.mjs", "reference.wasm"].map(file => [file,
        { sha256: hash(path.join(out, file)), bytes: fs.statSync(path.join(out, file)).size }])),
    history,
};
fs.writeFileSync(path.join(out, "build.json"), JSON.stringify(build, null, 2) + "\n");
console.log(JSON.stringify({ out, artifacts: build.artifacts }));
