// Builds the two texture-kernel variants into public/.
//
// Independent of the v86 runtime build: one rustc invocation per variant, no
// cargo workspace, no generated sources. Needs the wasm32-unknown-unknown
// target (`rustup target add wasm32-unknown-unknown`).
//
// Usage: bun tools/build-dxt-kernel/build.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outDir = `${root}public`;
mkdirSync(outDir, { recursive: true });

for (const simd of [false, true]) {
    const output = `${outDir}/dxt-kernel${simd ? "-simd" : ""}.wasm`;
    execFileSync(
        "rustc",
        [
            "--edition=2021",
            "--crate-type=cdylib",
            "--target=wasm32-unknown-unknown",
            "-C", "opt-level=3",
            "-C", "panic=abort",
            "-C", "lto=fat",
            "-C", "codegen-units=1",
            "-C", `target-feature=${simd ? "+" : "-"}simd128`,
            "-C", "strip=symbols",
            // The span validator compares against __heap_base, so it has to be
            // an export the loader can read, not just a linker symbol.
            "-C", "link-arg=--export=__heap_base",
            "-C", "link-arg=--max-memory=67108864",
            `${root}tools/build-dxt-kernel/lib.rs`,
            "-o", output,
        ],
        { stdio: "inherit" }
    );
    console.log(output);
}
