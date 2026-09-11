#!/usr/bin/env node
// Scaling characterization of the real jit_clear_cache_js entry point.
// Fresh engine instances, no candidate arm, no guest FPS inference. The caller
// owns host isolation; do not run beside another benchmark/build/active guest.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { collectDispatchCensus } from './dod-dispatch-census.mjs';

const BASE = 0x100000;
const TABLE_OFFSET = 1024; // cpu.rs WASM_TABLE_OFFSET; raw JIT indices start at 1.
const MEMORY_BYTES = 32 << 20;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return fallback;
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${name}`);
    return process.argv[i + 1];
};
const integer = (name, n, max) => {
    assert(Number.isSafeInteger(n) && n > 0 && n <= max, `Invalid ${name}: ${n}`);
    return n;
};
const manifestArg = arg('--manifest');
const outputArg = arg('--out');
assert(manifestArg && outputArg,
    'Usage: node audit-dod-lifecycle.mjs --manifest <manifest.json> --out <new.json> [--pages 16,64,128,256] [--samples 5] [--iterations 150000]');
const manifestPath = path.resolve(manifestArg), output = path.resolve(outputArg);
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const pagesList = arg('--pages', '16,64,128,256').split(',').map(x => integer('pages', Number(x), 512));
assert.equal(new Set(pagesList).size, pagesList.length, 'Duplicate page counts');
const samples = integer('samples', Number(arg('--samples', 5)), 100);
const iterations = integer('iterations', Number(arg('--iterations', 150000)), 1000000);
assert(fs.existsSync(path.dirname(output)), 'Output parent directory must already exist');
assert(!fs.existsSync(output), `Refusing to overwrite ${output}`);
assert(Array.isArray(manifest.shipping) && manifest.shipping.length > 0, 'Missing pinned shipping configuration');
const engine = path.resolve(manifest.engine);
for (const name of ['v86.wasm', 'libv86.mjs']) {
    assert.equal(sha(fs.readFileSync(path.join(engine, 'build', name))), manifest.artifacts[name].sha256,
        `Pinned artifact drift: ${name}`);
}

function makeFixture(pages) {
    const image = new Uint8Array(pages * 4096), dv = new DataView(image.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE,
        BASE + image.length, BASE + image.length, BASE + 0x40]
        .forEach((x, i) => dv.setUint32(i * 4, x, true));
    let haltAddress = 0;
    for (let page = 0; page < pages; page++) {
        let pos = page * 4096 + 0x40;
        const emit = (...bytes) => { image.set(bytes, pos); pos += bytes.length; };
        const imm = n => { dv.setInt32(pos, n | 0, true); pos += 4; };
        if (page === 0) emit(0x31, 0xf6); // xor esi,esi
        emit(0xb9); imm(iterations); // mov ecx,iterations
        const loop = pos;
        emit(0x46, 0x49, 0x0f, 0x85); imm(loop - (pos + 4)); // inc esi; dec ecx; jnz loop
        if (page + 1 === pages) { haltAddress = BASE + pos; emit(0xf4); }
        else { emit(0xe9); imm((page + 1) * 4096 + 0x40 - (pos + 4)); }
    }
    return { image, haltAddress };
}

function registers(cpu) {
    return { reg32: Array.from(cpu.reg32, x => x >>> 0), eip: cpu.instruction_pointer[0] >>> 0,
        halted: cpu.in_hlt[0], instructionCounter: cpu.instruction_counter[0] >>> 0,
        eflags: cpu.get_eflags() >>> 0 };
}

function guestMemoryHash(cpu) {
    // subarray produces a fresh plain view over guest RAM; no view survives a turn.
    // Engine metadata and table memory intentionally change during cache clearing.
    const bytes = cpu.mem8.subarray(0, cpu.mem8.length);
    return { bytes: bytes.byteLength, sha256: sha(bytes), scope: 'entire guest RAM, excluding engine statics' };
}

function occupiedSlots(cpu, capacity) {
    const table = cpu.wm.wasm_table;
    assert(table && table.length > TABLE_OFFSET + capacity, 'JIT table does not cover the derived slot capacity');
    const occupied = [];
    for (let i = 1; i <= capacity; i++) if (table.get(TABLE_OFFSET + i) !== null) occupied.push(i);
    return occupied;
}

function countFixturePages(cpu, census, pages) {
    const meta = new Uint32Array(cpu.wasm_memory.buffer, census.layout.metaBase, (1 << 20) * 2);
    let published = 0;
    for (let i = 0; i < pages; i++) if (meta[((BASE >>> 12) + i) * 2] !== 0) published++;
    return published;
}

function requireExports(w) {
    for (const name of ['jit_clear_cache_js', 'set_jit_config', 'get_jit_config', 'set_relaxed_fpu',
        'get_relaxed_fpu', 'set_dispatch_stats', 'get_dispatch_stats', 'set_opstats', 'get_opstats',
        'set_fpu_relaxed_stats', 'codegen_is_compiling', 'jit_debug_free_slots', 'jit_debug_page_count',
        'jit_debug_module_count', 'jit_debug_hidden_count', 'jit_get_double_free_skipped']) {
        assert.equal(typeof w[name], 'function', `Missing required export: ${name}`);
    }
}

async function waitForLoaded(em) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Engine load timeout')), 30000);
        em.add_listener('emulator-loaded', () => { clearTimeout(timer); resolve(); });
    });
}

async function waitForCompilation(w) {
    // stop() does not cancel asynchronous WebAssembly instantiation. Let any
    // final publication finish before taking the measured cache inventory.
    const deadline = performance.now() + 15000;
    do {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (w.codegen_is_compiling() === 0) return;
    } while (performance.now() < deadline);
    throw Error('Guest compilation did not finish after stopping the emulator');
}

function summarize(rows) {
    return pagesList.map(requestedPages => {
        const selected = rows.filter(r => r.requestedPages === requestedPages && r.status === 'pass');
        const values = selected.map(r => r.elapsedMs).sort((a, b) => a - b);
        const middle = values.length >> 1;
        return { requestedPages, n: selected.length, minMs: values[0] ?? null, maxMs: values.at(-1) ?? null,
            medianMs: values.length ? (values[(values.length - 1) >> 1] + values[middle]) / 2 : null,
            publishedFixturePages: selected.map(r => r.before.publishedFixturePages),
            actualModules: selected.map(r => r.before.census.counters.jit_debug_module_count),
            actualPublishedPages: selected.map(r => r.before.census.metadata.activePages),
            note: 'Fresh instances; requested pages are not a substitute for actual pre-clear inventory. No A/B or confidence claim.' };
    });
}

const sourceSnapshots = {};
for (const relative of ['audit-dod-lifecycle.mjs', 'dod-dispatch-census.mjs']) {
    const bytes = fs.readFileSync(new URL(relative, import.meta.url));
    sourceSnapshots[relative] = { sha256: sha(bytes), utf8: bytes.toString('utf8') };
}
const result = { schemaVersion: 1, status: 'running', created: new Date().toISOString(), manifest: manifestPath,
    manifestSha256: sha(manifestBytes), artifacts: manifest.artifacts, sourceSnapshots,
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform,
        release: os.release(), cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length },
    parameters: { pagesList, samples, iterations, memoryBytes: MEMORY_BYTES, tableOffset: TABLE_OFFSET },
    scope: 'Real jit_clear_cache_js scaling on stopped, warmed synthetic guests. No candidate A/B, no game FPS inference. Host isolation is caller responsibility.',
    timing: { entryPoint: 'wm.exports.jit_clear_cache_js', clock: 'process.hrtime.bigint',
        timedWork: 'One synchronous actual cache-clear call, including its normal JS table-clear callbacks.',
        excluded: 'Engine construction, guest execution/JIT compilation, RAM hashing, censuses, assertions, file output.',
        preconditioning: 'Guest RAM hash, dispatch census, slot inventory and register checks precede timing and affect cache residency; this is not an intrinsic cold/hot-cache latency bound.' },
    clearSemantics: 'Live JIT slots, dispatch publications and page/module ownership must be empty. Raw slab cells, allocated pool capacity, high-water counters and other lifetime diagnostics may remain. Reserved/core table entries are outside the JIT slot range.',
    rows: [], summary: [] };
fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
const save = () => {
    result.summary = summarize(result.rows);
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
};

try {
    const { V86 } = await import(pathToFileURL(path.join(engine, 'build/libv86.mjs')).href);
    for (let round = 0; round < samples; round++) {
        // Reverse the size sweep on alternate rounds to expose simple time drift.
        const order = round % 2 ? [...pagesList].reverse() : pagesList;
        for (const requestedPages of order) {
            const row = { index: result.rows.length, round, requestedPages, status: 'running' };
            result.rows.push(row); save();
            const em = new V86({ autostart: false, memory_size: MEMORY_BYTES,
                wasm_path: path.join(engine, 'build/v86.wasm'), log_level: 0 });
            try {
                await waitForLoaded(em);
                const cpu = em.v86.cpu, w = cpu.wm.exports;
                requireExports(w);
                cpu.reboot_internal(); cpu.reset_memory();
                row.readback = {};
                for (const [index, value] of manifest.shipping) {
                    assert.equal(w.set_jit_config(index, value), 0, `Config setter failed: ${index}`);
                    row.readback[index] = w.get_jit_config(index) >>> 0;
                    assert.equal(row.readback[index], value, `Config readback mismatch: ${index}`);
                }
                assert.equal(row.readback[21], 0, 'idx21 must remain shipping OFF');
                w.set_relaxed_fpu(1); w.set_dispatch_stats(0); w.set_opstats(0); w.set_fpu_relaxed_stats(0);
                assert.equal(w.get_relaxed_fpu(), 1);
                const capacity = w.jit_debug_free_slots();
                assert(capacity > 0 && capacity < 65536, 'Invalid initial free-slot capacity');
                assert.equal(w.jit_debug_page_count(), 0);
                assert.equal(w.jit_debug_module_count(), 0);
                assert.equal(w.jit_debug_hidden_count(), 0);
                assert.equal(w.codegen_is_compiling(), 0);
                assert.equal(occupiedSlots(cpu, capacity).length, 0, 'Fresh instance has live JIT table slots');
                const { image, haltAddress } = makeFixture(requestedPages);
                row.fixtureHash = sha(image);
                row.oracle = { esi: requestedPages * iterations, ecx: 0, halted: 1,
                    haltInstructionAddress: haltAddress, instructionMix: 'xor esi once; per page mov ecx, then iterations of inc esi/dec ecx/jnz; page hops; final hlt' };
                let finalized = 0;
                cpu.test_hook_did_finalize_wasm = () => { finalized++; };
                cpu.load_multiboot(image.buffer);
                console.error(`Lifecycle round ${round + 1}/${samples}: warm ${requestedPages} pages`);
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { em.stop(); reject(Error('Guest fixture timeout')); }, 120000);
                    em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(); });
                    em.run();
                });
                await waitForCompilation(w);
                assert(finalized > 0, 'No guest modules finalized');
                const memoryBefore = guestMemoryHash(cpu);
                const censusBefore = collectDispatchCensus(cpu, { maxTargets: 0 });
                const regsBefore = registers(cpu);
                row.before = { finalized, slotCapacity: capacity, occupiedSlots: occupiedSlots(cpu, capacity),
                    memory: memoryBefore, registers: regsBefore, census: censusBefore,
                    publishedFixturePages: countFixturePages(cpu, censusBefore, requestedPages),
                    doubleFreeSkipped: w.jit_get_double_free_skipped() };
                assert.equal(regsBefore.reg32[6], row.oracle.esi, 'Absolute guest loop-count oracle failed');
                assert.equal(regsBefore.reg32[1], 0, 'Guest ECX did not finish at zero');
                assert.equal(regsBefore.halted, 1, 'Guest did not halt');
                assert(row.before.publishedFixturePages >= Math.ceil(requestedPages / 2), 'Fewer than half the fixture pages are published; refuse lifecycle scaling sample');
                assert.equal(censusBefore.invalidMetadata.length, 0);
                assert.equal(censusBefore.duplicateSlabOwners.length, 0);
                assert.equal(row.before.doubleFreeSkipped, 0);
                assert.equal(w.codegen_is_compiling(), 0);
                assert.equal(w.get_dispatch_stats(), 0); assert.equal(w.get_opstats(), 0);
                const started = process.hrtime.bigint();
                w.jit_clear_cache_js();
                const elapsedNs = process.hrtime.bigint() - started;
                row.elapsedMs = Number(elapsedNs) / 1e6;
                row.elapsedNs = elapsedNs.toString();
                const regsAfter = registers(cpu);
                const memoryAfter = guestMemoryHash(cpu);
                const censusAfter = collectDispatchCensus(cpu, { maxTargets: 0 });
                row.after = { finalized, occupiedSlots: occupiedSlots(cpu, capacity), memory: memoryAfter,
                    registers: regsAfter, census: censusAfter, doubleFreeSkipped: w.jit_get_double_free_skipped() };
                assert.deepEqual(regsAfter, regsBefore, 'Cache clear changed guest registers/flags/retired count');
                assert.deepEqual(memoryAfter, memoryBefore, 'Cache clear changed guest RAM');
                assert.equal(finalized, row.before.finalized, 'Guest compilation occurred in the measured section');
                assert.equal(censusAfter.counters.codegen_is_compiling, 0);
                assert.equal(censusAfter.counters.jit_debug_free_slots, capacity, 'JIT slots were not all freed');
                assert.equal(censusAfter.counters.jit_debug_page_count, 0);
                assert.equal(censusAfter.counters.jit_debug_module_count, 0);
                assert.equal(censusAfter.counters.jit_debug_hidden_count, 0);
                assert.equal(censusAfter.metadata.activePages, 0, 'Dispatch metadata remains published');
                assert.equal(censusAfter.slabs.liveSlabs, 0);
                assert.equal(row.after.occupiedSlots.length, 0, 'Live functions remain in JIT table slots');
                assert.equal(row.after.doubleFreeSkipped, 0, 'Double-free guard fired during clear');
                row.status = 'pass';
                console.error(JSON.stringify({ round, requestedPages, actualModules: censusBefore.counters.jit_debug_module_count,
                    actualPages: censusBefore.metadata.activePages, elapsedMs: row.elapsedMs }));
            } catch (error) {
                row.status = 'fail'; row.error = error.stack ?? String(error); throw error;
            } finally {
                em.destroy(); save();
            }
        }
    }
    result.status = 'pass'; result.completed = new Date().toISOString(); save();
    console.log(output);
} catch (error) {
    result.status = 'fail'; result.error = error.stack ?? String(error); save(); throw error;
}
