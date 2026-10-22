import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
let build: Promise<void> | null = null;
export const nativeTestHelper = join(root, "build", "socket-helper" + (process.platform === "win32" ? ".exe" : ""));
export function buildNativeForTests(): Promise<void> {
    return build ??= new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, "build.ts"), "--tests"], { stdio: ["ignore", "pipe", "pipe"] });
        let diagnostics = "";
        child.stdout.resume(); child.stderr.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-8192); });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error("Native helper compilation failed: " + diagnostics)));
    });
}
