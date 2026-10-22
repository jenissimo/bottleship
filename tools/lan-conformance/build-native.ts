import { mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";

if (process.platform !== "win32") throw new Error("Native Winsock reference requires Windows.");
const fixture = process.argv[2] ?? "winsock";
if (!/^[a-z0-9-]+$/.test(fixture)) throw new Error("Invalid network oracle fixture name: " + fixture);
const output = resolve("logs/lan-conformance", fixture === "winsock" ? "." : fixture);
const game = join(output, "game");
const native = join(output, "native");
mkdirSync(game, { recursive: true });
mkdirSync(native, { recursive: true });
const compiler = process.env.BS_MINGW_CC ?? "C:/msys64/mingw32/bin/gcc.exe";
const exe = join(game, "lan-oracle.exe");
const nonce = Date.now() >>> 0;
const toolchainEnv = { ...process.env };
for (const key of Object.keys(toolchainEnv)) if (key.toLowerCase() === "path") delete toolchainEnv[key];
toolchainEnv.Path = dirname(compiler) + ";" + (process.env.PATH ?? process.env.Path ?? "");
const compile = Bun.spawnSync([
    compiler, "-O1", "-nostdlib", "-fno-builtin", "-fno-stack-protector",
    "-DORACLE_NONCE=" + nonce,
    "-Wl,--entry,_entry", "-Wl,--subsystem,console", "-o", exe,
    resolve("tools/lan-conformance/" + fixture + ".c"), "-lws2_32", "-lkernel32", "-lole32", "-ldxguid", "-luuid",
], { env: toolchainEnv, stdout: "pipe", stderr: "pipe" });
if (compile.exitCode !== 0) throw new Error(`Could not compile the native Winsock oracle (exit ${compile.exitCode}): ${new TextDecoder().decode(compile.stderr)}`);
const result = Bun.spawnSync([exe], { cwd: native, stdout: "inherit", stderr: "inherit", timeout: 15000 });
if (result.exitCode !== 0) throw new Error("Native " + fixture + " oracle failed, exit " + result.exitCode + ".");
const bytes = new Uint8Array(await Bun.file(join(native, "lan-oracle.bin")).arrayBuffer());
const view = new DataView(bytes.buffer);
if (bytes.length < 12 || view.getUint32(0, true) !== 0x42534c4e
    || view.getUint32(4, true) * 4 !== bytes.length || view.getUint32(8, true) !== nonce) {
    throw new Error("Native Winsock oracle produced an incomplete record.");
}
const bundle = join(output, `lan-oracle-${nonce}.wgb`);
const pack = Bun.spawnSync([
    process.execPath, "tools/make-wgb.ts", game, bundle,
    "--exe", "lan-oracle.exe", "--name", fixture + " conformance", "--game-id", "app:lan-conformance", "--ram", "128",
], { stdout: "inherit", stderr: "inherit" });
if (pack.exitCode !== 0) throw new Error("Could not package Winsock conformance fixture.");
const patch = Bun.spawnSync([
    process.execPath, "tools/wgb.ts", "patch-manifest", bundle,
    "emulator.deleteOnBoot", JSON.stringify(["C:\\lan-oracle.bin"]),
], { stdout: "inherit", stderr: "inherit" });
if (patch.exitCode !== 0) throw new Error("Could not configure fresh oracle output.");
const executableSha256 = createHash("sha256").update(new Uint8Array(await Bun.file(exe).arrayBuffer())).digest("hex");
const referenceSha256 = createHash("sha256").update(bytes).digest("hex");
await Bun.write(join(output, "build.json"), JSON.stringify({
    fixture, bundle, reference: join(native, "lan-oracle.bin"), nonce,
    executableSha256, referenceSha256, builtAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(JSON.stringify({
    bundle, reference: join(native, "lan-oracle.bin"),
    observations: Array.from({ length: bytes.length / 4 - 3 }, (_, index) => view.getInt32((index + 3) * 4, true)),
}, null, 2));
