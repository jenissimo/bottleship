/**
 * Differential: the SIMD string leaves against the scalar handlers they replace.
 *
 * There is no hardware oracle here, because these are HLE hypercalls rather than x86
 * instructions. The oracle is therefore the scalar path itself, reached by switching the
 * kernels off: every call runs twice and both arms must answer identically, including the
 * bytes a copy leaves behind.
 *
 * That only means something if the kernel actually ran, so the run asserts a non-zero hit
 * ledger at the end. An arm that silently declined everything would otherwise "agree"
 * with itself and prove nothing.
 *
 * Placements put strings against a page end and at odd addresses, because the chunked
 * scan's whole difficulty is the page edge and a wide character straddling it.
 *
 * Requires V86_TEST_BINARY (a v86 build carrying the kernels).
 */
import { readFileSync } from 'node:fs';
import { createMachine, LEFT, RIGHT } from './bulk-machine.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
if (!binaryPath) throw new Error(
    'V86_TEST_BINARY is required — point it at vendor/v86/build/wasm32-unknown-unknown/release/v86.wasm');

// 16 is comfortably inside a page; the other two force a chunk boundary mid-string, and
// the odd one makes a wchar straddle it.
const PLACEMENTS = [16, 4096 - 24, 4096 - 1];
const LENGTHS = [0, 1, 7, 8, 15, 16, 17, 31, 32, 33, 64, 100];
// Upper and lower case for the fold, plus bytes >= 0x80: the fold is ASCII-only on both
// paths and a vector fold that reached beyond ASCII would show up right here.
const ALPHABET = 'aB9zQ'.split('').map(c => c.charCodeAt(0)).concat([0x80, 0xc3, 0xff]);

function fill(mem, at, length, wide, seed, mutate) {
    const stride = wide ? 2 : 1;
    for (let i = 0; i < length; i++) {
        let code = ALPHABET[(i * 7 + seed) % ALPHABET.length];
        if (mutate) code = mutate(i, code);
        mem[at + i * stride] = code & 0xff;
        if (wide) mem[at + i * stride + 1] = wide === 2 ? (code >> 8) & 0xff : 0;
    }
    mem[at + length * stride] = 0;
    if (wide) mem[at + length * stride + 1] = 0;
}

const cases = [];
for (const place of PLACEMENTS) {
    for (const length of LENGTHS) {
        cases.push({ leaf: 'strlen', place, length });
        cases.push({ leaf: 'wcslen', place, length });
        cases.push({ leaf: 'strcpy', place, length });
        cases.push({ leaf: 'wcscpy', place, length });
        // Equal, differing at three positions, and differing only by case.
        for (const at of [-1, 0, Math.max(0, length >> 1), Math.max(0, length - 1)]) {
            cases.push({ leaf: 'strcmp', place, length, at });
            cases.push({ leaf: 'stricmp', place, length, at });
            cases.push({ leaf: 'wcsicmp', place, length, at });
        }
        cases.push({ leaf: 'stricmp', place, length, at: -1, caseOnly: true });
        cases.push({ leaf: 'wcsicmp', place, length, at: -1, caseOnly: true });
        for (const target of [0x61, 0x51, 0xff, 0x2e]) {
            cases.push({ leaf: 'wcschr', place, length, target });
        }
    }
}

const binary = readFileSync(binaryPath);

async function arm(kernels) {
    const m = await createMachine(binary, {});
    m.paging();
    m.api.set_string_memory_enabled(kernels ? 1 : 0);
    const g = m.guest();
    const results = [];

    for (const c of cases) {
        const wide = c.leaf.startsWith('wcs') ? 1 : 0;
        const stride = wide ? 2 : 1;
        const a = LEFT + c.place;
        const b = RIGHT + c.place;
        g.fill(0xcd, LEFT, LEFT + 8192);
        g.fill(0xcd, RIGHT, RIGHT + 8192);

        let answer;
        if (c.leaf === 'strlen' || c.leaf === 'wcslen') {
            fill(g, a, c.length, wide, 1);
            answer = `${m.call(c.leaf, a, 0, 0) >>> 0}`;
        }
        else if (c.leaf === 'strcpy' || c.leaf === 'wcscpy') {
            fill(g, a, c.length, wide, 2);
            const eax = m.call(c.leaf, b, a, 0) >>> 0;
            // The destination bytes are the real answer; EAX is just the pointer back.
            let hash = 2166136261 >>> 0;
            for (let i = 0; i < (c.length + 1) * stride + 4; i++) {
                hash = Math.imul(hash ^ g[b + i], 16777619) >>> 0;
            }
            answer = `${eax} ${hash}`;
        }
        else if (c.leaf === 'wcschr') {
            fill(g, a, c.length, wide, 3);
            const found = m.call(c.leaf, a, c.target, 0) >>> 0;
            answer = `${found === 0 ? 0 : found - a}`;
        }
        else {
            const mutate = c.caseOnly
                ? (_, code) => (code >= 0x61 && code <= 0x7a ? code - 32 : code)
                : (i, code) => (i === c.at ? code ^ 0x20 : code);
            fill(g, a, c.length, wide, 4);
            fill(g, b, c.length, wide, 4, mutate);
            answer = `${m.call(c.leaf, a, b, 0) | 0}`;
        }
        results.push(answer);
    }

    const stats = m.stringStats();
    m.close();
    return { results, stats };
}

const on = await arm(true);
const off = await arm(false);

let failures = 0;
cases.forEach((c, i) => {
    if (on.results[i] !== off.results[i]) {
        failures++;
        if (failures <= 8) {
            console.log(`MISMATCH ${c.leaf} place=${c.place} len=${c.length}`
                + `${c.at !== undefined ? ` at=${c.at}` : ''}`
                + `${c.target !== undefined ? ` target=0x${c.target.toString(16)}` : ''}`
                + `\n  kernel ${on.results[i]}\n  scalar ${off.results[i]}`);
        }
    }
});

const LABELS = ['strlen', 'wcslen', 'strcmp', 'stricmp', 'wcsicmp',
    'strchr', 'strrchr', 'wcschr', 'strcpy', 'wcscpy', 'declined'];
console.log(`kernels on : ${LABELS.map((l, i) => `${l}=${on.stats[i]}`).join(' ')}`);
console.log(`kernels off: ${LABELS.map((l, i) => `${l}=${off.stats[i]}`).join(' ')}`);
console.log(`cases=${cases.length} mismatches=${failures}`);

// Agreement is only evidence if the kernel answered. Guard against a run where every
// call declined and both arms trivially matched.
const hits = on.stats.slice(0, 10).reduce((a, b) => a + b, 0);
if (!hits) {
    console.log('FAIL: the kernels answered nothing — this run proves nothing');
    process.exitCode = 1;
}
// Only the hit counters must be silent when the kernels are off. The decline counter is
// expected to move: the switch is checked inside the body, after the ledger is wired up.
if (off.stats.slice(0, 10).some(v => v !== 0)) {
    console.log('FAIL: the disabled arm still answered from a kernel');
    process.exitCode = 1;
}
if (failures) process.exitCode = 1;
