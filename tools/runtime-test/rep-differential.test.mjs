/**
 * Differential: our REP CMPS/SCAS/STOS against this machine's real x86 silicon.
 *
 * The vector bodies in cpu/rep_memory.rs must be indistinguishable from the per-element
 * loop, and the only oracle that cannot share a bug with us is the hardware. Each case
 * compares ECX, the ESI/EDI deltas, the arithmetic flags and a hash of the destination
 * bytes, so a wrong lane index shows up as a wrong stop position rather than as "looks
 * about right".
 *
 * Counts straddle the vector width on purpose (15/16/17, 31/32/33): the bodies switch
 * between scalar head, vector run and scalar tail there, which is where an off-by-one
 * lives. Backwards runs are half the matrix because descending lane order is the part
 * that cannot be checked by reading the code.
 *
 * Requires V86_TEST_BINARY (a v86 build carrying the kernels) and REP_ORACLE (the
 * compiled tools/runtime-test/rep-native-oracle.c). Both are mandatory: defaulting to
 * the shipped artifact would quietly assert the previous build.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRepMachine, LEFT, RIGHT } from './rep-machine.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
const oraclePath = process.env.REP_ORACLE;
if (!binaryPath) throw new Error(
    'V86_TEST_BINARY is required — point it at vendor/v86/build/wasm32-unknown-unknown/release/v86.wasm');
if (!oraclePath) throw new Error(
    'REP_ORACLE is required — compile tools/runtime-test/rep-native-oracle.c and point it at the binary');

const OPS = ['cmps', 'scas', 'stos'];
const SIZES = [1, 2, 4];
const COUNTS = [8, 15, 16, 17, 31, 32, 33, 64, 129];
const OFFSETS = [0, 1, 2, 3];
const VALUE = 0x5a5a5a5a >>> 0;
const FLAGS = 0x202;

const cases = [];
for (const [op, opIndex] of OPS.map((o, i) => [o, i])) {
    for (const size of SIZES) {
        // REPNE STOS is architecturally reserved; the oracle always emits REP, so asking
        // for the F2 form would compare our guest against an instruction nobody defines.
        for (const eq of op === 'stos' ? [1] : [1, 0]) {
            for (const backwards of [0, 1]) {
                for (const count of COUNTS) {
                    for (const offset of OFFSETS) {
                        // Never stop, stop first, stop just inside the vector run, stop last.
                        for (const stop of [-1, 0, 1, (count >> 1), count - 1]) {
                            cases.push({ op, opIndex, size, eq, backwards, count, offset, stop });
                        }
                    }
                }
            }
        }
    }
}

const input = cases
    .map(c => `${c.opIndex} ${c.size} ${c.eq} ${c.backwards} ${c.count} ${VALUE} ${FLAGS} ${c.stop} ${c.offset}`)
    .join('\n') + '\n';
const expected = execFileSync(oraclePath, { input, maxBuffer: 1 << 28 })
    .toString().trim().split('\n');
if (expected.length !== cases.length) {
    throw new Error(`oracle answered ${expected.length} of ${cases.length} cases`);
}

const binary = readFileSync(binaryPath);
let failures = 0;
let shown = 0;

// The disabled arm is both the kill-switch check and the control: with the kernels off
// every case must still agree with silicon, so a mismatch there is the scalar loop's.
for (const [jit, kernels] of [[false, true], [true, true], [false, false]]) {
    const m = await createRepMachine(binary, { jit });
    m.paging();
    m.api.set_rep_memory_enabled(kernels ? 1 : 0);
    const g = m.guest();

    // Two placements per case, against the SAME oracle answer: the native result depends
    // only on the data and the count, never on where the buffer sits. The second lands the
    // run against a page end so the unaligned entry has to bridge the edge element through
    // the scalar accessors; at the first placement that path never runs at all.
    for (const [label, at] of [['flat', 16], ['page-edge', 4096 - 6]]) {
    const L = LEFT + at;
    const R = RIGHT + at;

    cases.forEach((c, k) => {
        const bytes = c.count * c.size;
        g.fill(173, LEFT, LEFT + 16384);
        g.fill(173, RIGHT, RIGHT + 16384);

        const mask = c.size === 4 ? 0xffffffff : (1 << (c.size * 8)) - 1;
        const a = VALUE & mask;
        for (let i = 0; i < c.count; i++) {
            // Slot i is visited on iteration `index`; a backwards run walks down from the
            // top slot, so the stop position is an ITERATION number, not an array index.
            const index = c.backwards ? c.count - 1 - i : i;
            const differs = index === c.stop ? !!c.eq : !c.eq;
            const b = (differs ? a ^ 0x81 : a) & mask;
            for (let t = 0; t < c.size; t++) {
                g[L + c.offset + i * c.size + t] = (a >>> (8 * t)) & 0xff;
                g[R + c.offset + i * c.size + t] = (b >>> (8 * t)) & 0xff;
            }
        }

        const head = c.backwards ? (c.count - 1) * c.size : 0;
        const src = L + c.offset + head;
        const dst = R + c.offset + head;
        const r = m.rep(c.op, c.size, src, dst, c.count, {
            equal: !!c.eq,
            backwards: !!c.backwards,
            value: VALUE,
            flags: FLAGS,
        });

        let hash = 2166136261 >>> 0;
        for (let i = 0; i < bytes; i++) {
            hash = Math.imul(hash ^ g[R + c.offset + i], 16777619) >>> 0;
        }
        const ours = `${r.ecx} ${r.esi - L} ${r.edi - R} ${r.flags & 0xcd5} ${hash}`;
        const theirs = (expected[k] || '').trim();
        if (ours !== theirs) {
            failures++;
            if (shown++ < 8) {
                console.log(`MISMATCH jit=${jit} ${label} ${c.op}${c.size} eq=${c.eq} back=${c.backwards} `
                    + `n=${c.count} off=${c.offset} stop=${c.stop}\n  ours   ${ours}\n  native ${theirs}`);
            }
        }
    });
    }

    const stats = m.repStats();
    const ptr = m.api.get_unaligned_rep_stats_ptr;
    const unaligned = ptr
        ? Array.from(new Uint32Array(m.cpu.wasm_memory.buffer, ptr() >>> 0, 8))
        : null;
    console.log(`jit=${jit} kernels=${kernels} cases=${cases.length} `
        + `aligned(cmps,scas,stosw,stosd,rejected)=${stats ? stats.join(',') : 'unavailable'} `
        + `unaligned(cmpsw,cmpsd,scasw,scasd,stosw,stosd,bridge,rejected)=${unaligned ? unaligned.join(',') : 'unavailable'}`);
    m.close();
}

console.log(`total cases=${cases.length * 6} mismatches=${failures}`);
if (failures) process.exitCode = 1;
