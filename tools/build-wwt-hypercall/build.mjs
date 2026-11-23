import { fileURLToPath } from "node:url";

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const common = [
    "--edition", "2021", "--target", "wasm32-unknown-unknown", "--crate-type", "cdylib",
    "-C", "opt-level=3", "-C", "panic=abort", "-C", "strip=symbols",
    "--remap-path-prefix", path(".") + "=tools/build-wwt-hypercall/",
];

function rustc(source, output, flags = []) {
    const result = Bun.spawnSync(["rustc", ...common, ...flags, "-o", path(output), path(source)], {
        stderr: "inherit", stdout: "inherit",
    });
    if (result.exitCode !== 0) throw new Error("WWT Wasm build failed for " + source);
}

rustc("hypercall.rs", "../../public/wwt-hypercall.wasm", [
    "-C", "target-feature=+atomics,+bulk-memory,+mutable-globals",
    "-C", "link-arg=--import-memory",
    "-C", "link-arg=--shared-memory",
    "-C", "link-arg=--max-memory=4294967296",
    "-C", "link-arg=--export=__stack_pointer",
    "-C", "link-arg=-zstack-size=0",
]);
rustc("d3d9-arena.rs", "../../public/wwt-d3d9-arena.wasm");
await import("./validate.mjs");
