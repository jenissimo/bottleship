/**
 * Quality-gate check: queue-level texture writes in the DirectDraw/D3D8 renderer stay behind
 * the write-side ordering guard (src/worker/backends/webgpu/shared/queue-write-guard.ts).
 *
 * `queue.writeTexture` and `queue.copyExternalImageToTexture` take effect when issued, while
 * the executor's recorded commands take effect only when its encoder is submitted. A write
 * to a texture that recorded work uses must therefore submit that work first, which is what
 * `beforeQueueWrite(texture)` does. A separately submitted encoder is the same kind of write.
 *
 * Two checks:
 * - Every writeTexture / copyExternalImageToTexture call has a `beforeQueueWrite(` or a
 *   full executor flush within the lines before it (same function in practice).
 * - A pinned per-file census of those calls, of `.submit(`, and of the submits that have a
 *   guard in the lines before them: a new site anywhere in scope, or a guard removed from
 *   before a submit, fails here until the pins are updated, i.e. until someone has decided
 *   whether it writes a texture recorded work can use.
 *
 * Usage: bun tools/validate-queue-writes.ts [--root <dir>]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg >= 0 ? process.argv[rootArg + 1]! : join(import.meta.dir, "..");

const SCOPE_DIRS = [
    "src/worker/backends/webgpu/ddraw",
    "src/worker/modules/ddraw",
];
const SCOPE_FILES = [
    "src/worker/backends/webgpu/shared/texture-converter.ts",
];

interface Census { writeTexture: number; copyExternalImageToTexture: number; submit: number; guardedSubmit: number }

/**
 * Submits are pinned with what they write: only fresh textures, buffers, the canvas, or a
 * readback after the caller's flush, or they call beforeQueueWrite first.
 */
const PINS: Record<string, Census> = {
    // dummy pixel + authored mips (guarded), canvas upload (after flush); flush itself,
    // two copySurface paths (after flush), fresh-texture clear.
    "src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts": { writeTexture: 2, copyExternalImageToTexture: 1, submit: 4, guardedSubmit: 2 },
    // vertex conversion readback: buffers only.
    "src/worker/backends/webgpu/ddraw/compute/vertex-converter.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 0 },
    // mip levels of a texture (guarded).
    "src/worker/backends/webgpu/ddraw/mip-generator.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 1 },
    // canvas readback, canvas present, phase blend, palette convert (after flush), RGB565 convert (guarded).
    "src/worker/modules/ddraw/presenter.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 5, guardedSubmit: 2 },
    // debug readback; fresh-texture clear; partial, RGB565 x2 and full uploads (guarded).
    "src/worker/modules/ddraw/gpu-texture-utils.ts": { writeTexture: 4, copyExternalImageToTexture: 0, submit: 2, guardedSubmit: 0 },
    // debug surface probe (after flush).
    "src/worker/modules/ddraw/index.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 1 },
    // Blt copy branch (after the GPU-path flush).
    "src/worker/modules/ddraw/surface-blt-flip.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 0 },
    // readback copy (after flush).
    "src/worker/modules/ddraw/surface-sync.ts": { writeTexture: 0, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 0 },
    // CPU-fallback upload x2 (guarded), readback of a texture into a buffer.
    "src/worker/backends/webgpu/shared/texture-converter.ts": { writeTexture: 2, copyExternalImageToTexture: 0, submit: 1, guardedSubmit: 0 },
};

/** How far back a guard may sit before the write it covers. */
const GUARD_WINDOW = 40;
/** The guard itself, or an executor submit by name; a bare `flush(` of something else does not count. */
const GUARD = /\bbeforeQueueWrite\(|\bflushPending\(\)|\b(?:this|executor|ddrawExecutor|exec)\??\.flush\(/;

function* walk(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts")) yield full;
    }
}

function isComment(line: string): boolean {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const files = new Set<string>();
for (const d of SCOPE_DIRS) for (const f of walk(join(ROOT, d))) files.add(f);
for (const f of SCOPE_FILES) if (existsSync(join(ROOT, f))) files.add(join(ROOT, f));

const problems: string[] = [];
const seen = new Set<string>();

for (const file of [...files].sort()) {
    const rel = relative(ROOT, file).split("\\").join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    const census: Census = { writeTexture: 0, copyExternalImageToTexture: 0, submit: 0, guardedSubmit: 0 };
    const guardedAt = (i: number): boolean =>
        lines.slice(Math.max(0, i - GUARD_WINDOW), i).some((l) => !isComment(l) && GUARD.test(l));
    lines.forEach((line, i) => {
        if (isComment(line)) return;
        const write = /\.writeTexture\(/.test(line) ? "writeTexture"
            : /\.copyExternalImageToTexture\(/.test(line) ? "copyExternalImageToTexture" : null;
        if (/\.submit\(/.test(line)) {
            census.submit++;
            if (guardedAt(i)) census.guardedSubmit++;
        }
        if (!write) return;
        census[write]++;
        if (!guardedAt(i)) {
            problems.push(`${rel}:${i + 1}: ${write} without beforeQueueWrite(texture) (or a flush) in the ${GUARD_WINDOW} lines before it`);
        }
    });
    const total = census.writeTexture + census.copyExternalImageToTexture + census.submit;
    const pin = PINS[rel];
    if (!pin) {
        if (total > 0) problems.push(`${rel}: ${JSON.stringify(census)} is not pinned - add it to PINS with what each site writes`);
        continue;
    }
    seen.add(rel);
    for (const k of Object.keys(pin) as (keyof Census)[]) {
        if (pin[k] !== census[k]) problems.push(`${rel}: ${k} ${census[k]}, pinned ${pin[k]} - review the new or removed site and update PINS`);
    }
}
for (const rel of Object.keys(PINS)) {
    if (!seen.has(rel)) problems.push(`${rel}: pinned but not found`);
}

if (problems.length) {
    console.error(`validate-queue-writes: ${problems.length} problem(s)`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}
console.log(`validate-queue-writes: OK (${seen.size} pinned files, every texture write behind beforeQueueWrite or a flush)`);
