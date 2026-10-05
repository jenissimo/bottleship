/**
 * Emscripten arm of the codegen pair: runs a kernel and prints the shared state checksum.
 *
 * This is the correctness half of the lab. The PE arm reports the same checksum through
 * OutputDebugString, so "both arms did the same work" is a comparison of one number computed by
 * ONE shared C++ function, not two hand-written notions of equality.
 *
 * Usage: node tools/bench-v86/source-pair/codegen-oracle.mjs [kernel] [count] [rounds] [seed]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const demo = process.env.CODEGEN_DEMO_DIR || 'C:/Projects/bottleship-demos/demo_codegen_pair';
const kernel = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 4096);
const rounds = Number(process.argv[4] ?? 2048);
// Warm the native arm the same way: the first call of a fresh module is also a cold measurement.
const warm = process.argv.includes('--warm');
const seed = Number(process.argv[5] ?? 73);

const factory = (await import(pathToFileURL(path.join(demo, 'web/codegen.mjs')).href)).default;
const mod = await factory();

if (warm) { mod._cg_init(seed); mod._cg_run(kernel, Math.max(1, Math.floor(count / 8)), 1); }
const t0 = performance.now();
mod._cg_init(seed);
mod._cg_run(kernel, count, rounds);
const ms = performance.now() - t0;
const checksum = mod._cg_checksum() >>> 0;

console.log(JSON.stringify({
  arm: 'emscripten', kernel, count, rounds, seed,
  checksum, ms: +ms.toFixed(2),
  note: 'Native-Wasm timing is a shape reference, not a target the emulator is expected to reach.',
}));
