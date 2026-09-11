#!/usr/bin/env node
// Actual engine resolver, synthetic request order. This measures locality
// sensitivity; it neither reorders guest execution nor predicts a game speedup.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { collectDispatchCensus, collectDispatchCensusFromViews } from './dod-dispatch-census.mjs';

const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = xs => { const a = [...xs].sort((a, b) => a - b); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2; };
const require = createRequire(import.meta.url);

function fixture(pages, iterations, spreadOffsets = false) {
    const base = 0x100000;
    const image = new Uint8Array(pages * 4096);
    const view = new DataView(image.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, base, base,
        base + image.length, base + image.length, base + 0x40]
        .forEach((x, i) => view.setUint32(i * 4, x, true));
    const entry = page => page * 4096 + 0x40 + (spreadOffsets ? (page % 32) * 64 : 0);
    for (let page = 0; page < pages; page++) {
        let pos = entry(page);
        const emit = (...bytes) => { image.set(bytes, pos); pos += bytes.length; };
        const imm = n => { view.setInt32(pos, n | 0, true); pos += 4; };
        if (page === 0) emit(0x31, 0xf6); // xor esi,esi
        emit(0xb9); imm(iterations);
        const loop = pos;
        emit(0x46, 0x49, 0x0f, 0x85); imm(loop - (pos + 4));
        if (page + 1 === pages) emit(0xf4);
        else { emit(0xe9); imm(entry(page + 1) - (pos + 4)); }
    }
    return image;
}

function shuffled(values) {
    const result = [...values];
    let random = 0x12345678;
    for (let i = result.length - 1; i > 0; i--) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        const j = (random >>> 0) % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

const wat = `(module
  (import "engine" "resolve" (func $resolve (param i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (param $count i32) (param $repeats i32) (result i32)
    (local $i i32) (local $repeat i32) (local $ptr i32) (local $sum i32) (local $value i32)
    (loop $outer
      (local.set $i (i32.const 0))
      (loop $inner
        (local.set $ptr (i32.shl (local.get $i) (i32.const 4)))
        (local.set $value (call $resolve (i32.load (local.get $ptr))
            (i32.load offset=4 (local.get $ptr)) (i32.load offset=8 (local.get $ptr))))
        (local.set $sum (i32.add (local.get $sum) (local.get $value)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $inner (i32.lt_u (local.get $i) (local.get $count))))
      (local.set $repeat (i32.add (local.get $repeat) (i32.const 1)))
      (br_if $outer (i32.lt_u (local.get $repeat) (local.get $repeats))))
    (local.get $sum)))`;

async function wrapper(resolve, dependent = false) {
    const wabt = await require('../../vendor/v86/build/libwabt.cjs')();
    // The XOR is zero for correct answers but cannot be known before the resolver
    // returns. It serializes the next request behind that return value.
    const source = dependent ? wat.replace(
        '(local.set $i (i32.add (local.get $i) (i32.const 1)))',
        '(local.set $i (i32.add (i32.add (local.get $i) (i32.const 1)) (i32.xor (local.get $value) (i32.load offset=12 (local.get $ptr)))))',
    ) : wat;
    const parsed = wabt.parseWat('dod-dispatch-batch.wat', source);
    const { buffer } = parsed.toBinary({});
    parsed.destroy();
    const { instance } = await WebAssembly.instantiate(buffer, { engine: { resolve } });
    return { ...instance.exports, hash: sha(buffer) };
}

function assertChecksum(actual, expected) {
    assert.equal(actual >>> 0, expected >>> 0, 'Resolver checksum mismatch');
}

if (process.argv.includes('--self-test')) {
    const meta = new Uint32Array(8), cells = new Uint16Array(4 * 4096);
    meta[2] = (7 << 16) | 2; meta[3] = 3;
    cells[2 * 4096 + 0x40] = 6;
    const beforeMeta = meta.slice(), beforeCells = cells.slice();
    const census = collectDispatchCensusFromViews(meta, cells);
    assert.equal(census.metadata.activePages, 1);
    assert.equal(census.slabs.liveCells, 1);
    assert.deepEqual(census.targets, [{ addr: 0x1040, tableIndex: 7, stateFlags: 3, expectedState: 5 }]);
    assert.deepEqual(meta, beforeMeta); assert.deepEqual(cells, beforeCells);
    meta[4] = meta[2]; meta[5] = meta[3];
    assert.equal(collectDispatchCensusFromViews(meta, cells).duplicateSlabOwners.length, 1);
    assert.equal(collectDispatchCensusFromViews(meta, cells).targets.length, 0);
    meta[4] = 0; meta[5] = 0; meta[2] = (7 << 16) | 9;
    assert.equal(collectDispatchCensusFromViews(meta, cells).invalidMetadata.length, 1);
    assert.throws(() => assertChecksum(5, 6), /checksum/i);
    let actualCalls = 0;
    const batch = await wrapper((addr, index, flags) => { actualCalls++; return addr + index + flags; });
    new Uint32Array(batch.memory.buffer).set([1, 2, 3, 6, 4, 5, 6, 15]);
    assertChecksum(batch.run(2, 3), 63);
    assert.equal(actualCalls, 6, 'Absolute calls to the independent test oracle');
    actualCalls = 0;
    const chain = await wrapper((addr, index, flags) => { actualCalls++; return addr + index + flags; }, true);
    new Uint32Array(chain.memory.buffer).set([1, 2, 3, 6, 4, 5, 6, 15]);
    assertChecksum(chain.run(2, 3), 63);
    assert.equal(actualCalls, 6, 'Absolute dependent calls to the test oracle');
    console.log('PASS census valid/duplicate/invalid/readonly; checksum mutation; batched Wasm execution');
    process.exit(0);
}

const manifestPath = path.resolve(arg('--manifest', ''));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const output = path.resolve(arg('--out', path.join(manifest.output, 'dispatch-probe.json')));
if (fs.existsSync(output)) throw Error(`Refusing to overwrite ${output}`);
const engine = manifest.engine;
for (const name of ['v86.wasm', 'libv86.mjs']) {
    assert.equal(sha(fs.readFileSync(path.join(engine, 'build', name))), manifest.artifacts[name].sha256);
}
const { V86 } = await import(pathToFileURL(path.join(engine, 'build/libv86.mjs')).href);
const pages = Number(arg('--pages', 128)), iterations = Number(arg('--iterations', 150000));
const requestedLookups = Number(arg('--lookups', 8000000)), rounds = Number(arg('--rounds', 7));
const dependent = process.argv.includes('--dependent');
const spreadOffsets = process.argv.includes('--spread-offsets');
for (const [name, value, max] of [['pages', pages, 512], ['iterations', iterations, 1000000],
    ['lookups', requestedLookups, 1000000000], ['rounds', rounds, 100]]) {
    assert(Number.isSafeInteger(value) && value > 0 && value <= max, `Invalid ${name}`);
}
const em = new V86({ autostart: false, memory_size: 32 << 20,
    wasm_path: path.join(engine, 'build/v86.wasm'), log_level: 0 });
const loadedTimeout = setTimeout(() => { console.error('Engine load timeout'); process.exit(2); }, 30000);
await new Promise(resolve => em.add_listener('emulator-loaded', resolve));
clearTimeout(loadedTimeout);
try {
    const cpu = em.v86.cpu, w = cpu.wm.exports;
    cpu.reboot_internal(); cpu.reset_memory();
    const readback = {};
    for (const [index, value] of manifest.shipping) {
        assert.equal(w.set_jit_config(index, value), 0);
        readback[index] = w.get_jit_config(index) >>> 0;
        assert.equal(readback[index], value);
    }
    w.set_relaxed_fpu(1); w.set_dispatch_stats(0); w.set_opstats(0); w.set_fpu_relaxed_stats(0);
    const image = fixture(pages, iterations, spreadOffsets);
    cpu.load_multiboot(image.buffer);
    let finalized = 0;
    cpu.test_hook_did_finalize_wasm = () => finalized++;
    console.error(`Warm ${pages} guest pages, ${iterations} iterations/page`);
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { em.stop(); reject(Error('Guest fixture timeout')); }, 120000);
        em.bus.register('cpu-event-halt', () => { clearTimeout(timeout); em.stop(); resolve(); });
        em.run();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(cpu.reg32[6] >>> 0, pages * iterations, 'Guest iteration oracle');
    assert(finalized > 0, 'No modules finalized');
    const resolve = w.jit_find_cache_entry_in_page;
    const probe = await wrapper(resolve, dependent);
    assert.equal(w.codegen_is_compiling(), 0, 'Pending guest compilation before census');
    const census = collectDispatchCensus(cpu);
    assert.equal(census.invalidMetadata.length, 0); assert.equal(census.duplicateSlabOwners.length, 0);
    const unique = new Map();
    for (const target of census.targets) {
        assert.equal(resolve(target.addr, target.tableIndex, target.stateFlags), target.expectedState);
        if (!unique.has(target.addr >>> 12)) unique.set(target.addr >>> 12, target);
    }
    const targets = [...unique.values()];
    assert(targets.length >= pages / 2, 'Insufficient genuinely published pages');
    const result = { created: new Date().toISOString(), manifest: manifestPath,
        scriptHash: sha(fs.readFileSync(new URL(import.meta.url))), wrapperHash: probe.hash,
        fixtureHash: sha(image), pages, iterations, finalized, readback, dependent, spreadOffsets,
        selectedOffsets: [...new Set(targets.map(target => target.addr & 4095))], relaxed: w.get_relaxed_fpu(),
        guestResult: { esi: cpu.reg32[6] >>> 0, ecx: cpu.reg32[1] >>> 0, halted: cpu.in_hlt[0] }, census,
        scope: 'Real Wasm in-page resolver called from a Wasm batch. Synthetic equal-multiset request order; occupancy is not heat, grouping is not a legal guest optimization. No FPS inference.',
        cases: [] };
    fs.writeFileSync(output.replace(/\.json$/, '') + '-census.json', JSON.stringify(census, null, 2));
    for (const count of [...new Set([1, 8, 32, targets.length].filter(n => n <= targets.length))]) {
        const selected = Array.from({ length: count }, (_, i) => targets[Math.floor(i * targets.length / count)]);
        const grouped = selected.flatMap(t => Array(32).fill(t));
        const random = shuffled(grouped);
        const repeats = Math.max(1, Math.ceil(requestedLookups / grouped.length));
        const lookups = repeats * grouped.length;
        const expected = Math.imul(grouped.reduce((sum, t) => (sum + t.expectedState) | 0, 0), repeats) >>> 0;
        const arms = { grouped, shuffled: random };
        const bytes = grouped.length * 16;
        if (probe.memory.buffer.byteLength < bytes) probe.memory.grow(Math.ceil((bytes - probe.memory.buffer.byteLength) / 65536));
        function sample(arm) {
            const data = new Uint32Array(probe.memory.buffer);
            arms[arm].forEach((t, i) => data.set([t.addr, t.tableIndex, t.stateFlags, t.expectedState], i * 4));
            assertChecksum(probe.run(grouped.length, 1), grouped.reduce((sum, t) => sum + t.expectedState, 0));
            const start = performance.now();
            const checksum = probe.run(grouped.length, repeats);
            const ms = performance.now() - start;
            assertChecksum(checksum, expected);
            return { arm, ms, nsPerLookup: ms * 1e6 / lookups, checksum: checksum >>> 0 };
        }
        const warmup = [];
        for (let i = 0; i < 8; i++) warmup.push(sample(i % 2 ? 'shuffled' : 'grouped'));
        const rows = [], pairs = [];
        for (let round = 0; round < rounds; round++) {
            const batch = ['grouped', 'shuffled', 'shuffled', 'grouped', 'grouped', 'grouped', 'shuffled', 'shuffled'].map(sample);
            rows.push(...batch.map(row => ({ round, ...row })));
            const t = batch.map(row => row.ms);
            pairs.push({ shuffledOverGrouped: Math.sqrt(t[1] * t[2] / (t[0] * t[3])),
                groupedControlPct: Math.abs(100 * (t[4] / t[5] - 1)),
                shuffledControlPct: Math.abs(100 * (t[6] / t[7] - 1)) });
        }
        const controlFloorPct = Math.max(...pairs.flatMap(p => [p.groupedControlPct, p.shuffledControlPct]));
        const summary = { groupedNs: median(rows.filter(r => r.arm === 'grouped').map(r => r.nsPerLookup)),
            shuffledNs: median(rows.filter(r => r.arm === 'shuffled').map(r => r.nsPerLookup)),
            medianShuffledOverGrouped: median(pairs.map(p => p.shuffledOverGrouped)), controlFloorPct,
            everyPairSlowerThanEveryControl: pairs.every(p => 100 * (p.shuffledOverGrouped - 1) > controlFloorPct) };
        result.cases.push({ count, lookups, queryCount: grouped.length, targetHashes: Object.fromEntries(
            Object.entries(arms).map(([key, value]) => [key, sha(JSON.stringify(value))])), warmup, rows, pairs, summary });
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        console.error(JSON.stringify({ count, ...summary }));
    }
    assert.equal(finalized, result.finalized, 'Compilation occurred in lookup timing');
    assert.equal(w.get_dispatch_stats(), 0); assert.equal(w.get_opstats(), 0);
    result.finalizedAfter = finalized;
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(output);
} finally { em.destroy(); }
