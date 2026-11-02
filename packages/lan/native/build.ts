import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, "build"), { recursive: true });
const compiler = process.env.BS_LAN_CC ?? (process.platform === "win32" ? "C:/msys64/mingw64/bin/gcc.exe" : "cc");
const compilerEnv = { ...process.env };
if (process.platform === "win32") {
    for (const key of Object.keys(compilerEnv)) if (key.toLowerCase() === "path") delete compilerEnv[key];
    compilerEnv.Path = dirname(compiler) + ";" + (process.env.PATH ?? process.env.Path ?? "");
}
for (const name of ["socket-helper", ...(process.argv.includes("--tests") ? ["test-peer", "test-checksum", "test-udp-tuple"] : [])]) {
    const output = join(root, "build", name + (process.platform === "win32" ? ".exe" : ""));
    const args = ["-std=c11", "-O2", "-Wall", "-Wextra", join(root, name + ".c"), "-o", output,
        ...(process.platform === "win32" ? ["-D_WIN32_WINNT=0x0601", "-lws2_32"] : ["-pthread"])];
    const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(compiler, args, { stdio: "inherit", env: compilerEnv });
        child.on("error", reject); child.on("exit", code => resolve(code ?? 1));
    });
    if (code) throw new Error("Native helper compiler failed, exit " + code);
    console.log(output);
}
