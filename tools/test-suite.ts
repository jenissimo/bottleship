/**
 * Canonical Bun suites. All generic tests stay in the normal suite. Tests that instantiate
 * the optional v86 CPU or inspect its compiler source run with the legacy checkout.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const legacyOnly = [
    "tools/aot/identity-envelope.test.mjs",
    "tools/aot/lib/inline-rotate.test.mjs",
    "tools/aot/lib/shufps-specialize.test.mjs",
    "tools/tests/cpu-views-legacy.test.ts",
    "tools/tests/delphi-rtl-record-exec.test.ts",
    "tools/tests/fn-unit-exec.test.ts",
    "tools/tests/jit-publications.test.ts",
    "tools/tests/kernel32-fibers-exec.test.ts",
    "tools/tests/native-ftol-exec.test.ts",
    "tools/tests/native-splice-sjlj-exec.test.ts",
    "tools/tests/native-tls-hypercall.test.ts",
    "tools/tests/ntqit-stub.test.ts",
    "tools/tests/scheduler-self-suspend-exec.test.ts",
    "tools/tests/stub-trampolines-exec.test.ts",
    "tools/tests/tls-set-value-hypercall.test.ts",
];
const mixed = [
    "tools/tests/dll-thread-notify.test.ts",
    "tools/tests/jit-exec-density.test.ts",
    "tools/tests/teb-stubs.test.ts",
];

const args = process.argv.slice(2);
const legacy = args[0] === "--legacy";
if (legacy) args.shift();
const listed = [...legacyOnly, ...mixed];
const required = legacy ? [...listed, "vendor/v86/build/libv86.mjs", "vendor/v86/build/v86.wasm", "public/v86.wasm"] : listed;
for (const file of required) {
    if (!existsSync(resolve(root, file))) throw new Error(`Required ${legacy ? "legacy suite" : "test list"} input is absent: ${file}`);
}
const command = [process.execPath, "test", "--path-ignore-patterns", "logs/**"];
if (legacy) {
    command.push(...listed.map(file => "./" + file));
} else {
    for (const file of legacyOnly) command.push("--path-ignore-patterns", file);
}
const test = Bun.spawn([...command, ...args], {
    cwd: root,
    env: { ...process.env, BS_RUN_LEGACY_TESTS: legacy ? "1" : "0" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await test.exited);
