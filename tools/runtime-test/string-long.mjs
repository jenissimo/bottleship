/**
 * The CRT string leaves on strings longer than 1 MiB and on pointers whose scan would leave
 * guest RAM.
 *
 * Inside RAM the hypercall answers the whole string: strlen/wcslen count to the terminator,
 * and strcpy/wcscpy/wcscat copy all of it. A scan that would leave RAM declines instead of
 * reading the unmapped-memory handler's 0xFF or injecting a #PF. That covers an unterminated
 * string at the top of RAM, a garbage pointer above RAM, a page that is not present under
 * paging, and a destination page that is not writable. A decline reaches the host fallback
 * (one OUT) and leaves the destination untouched.
 *
 * Every call has a time bound: a scan that runs on through non-RAM memory fails the run
 * instead of hanging it.
 *
 * Requires V86_TEST_BINARY (a v86 build).
 */
import { readFileSync } from 'node:fs';
import { createMachine, LEFT, RIGHT, RAM } from './bulk-machine.mjs';
import { NARROW_LENGTHS, WIDE_LENGTH, TOP_BYTES, GARBAGE, TIME_BOUND_MS, fillNarrow, fillWide } from './string-long-cases.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
if (!binaryPath) throw new Error('V86_TEST_BINARY is required');
const binary = readFileSync(binaryPath);

let failures = 0;
const check = (ok, text) => { if (!ok) failures++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); };


function timed(m, name, a, b) {
    const calls = m.hostCalls;
    const t0 = performance.now();
    const eax = m.call(name, a, b, 0) >>> 0;
    const ms = performance.now() - t0;
    return { eax, ms, declined: m.hostCalls !== calls };
}

for (const kernels of [1, 0]) {
    const tag = kernels ? 'page-chunked path on' : 'page-chunked path off';
    const m = await createMachine(binary, {});
    m.paging();
    m.api.set_string_memory_enabled(kernels);
    m.setFallback(() => {});
    const g = m.guest();

    for (const length of NARROW_LENGTHS) {
        fillNarrow(g, LEFT, length, 1);
        let r = timed(m, 'strlen', LEFT, 0);
        check(!r.declined && r.eax === length && r.ms < TIME_BOUND_MS, `${tag}: strlen(${length}) = ${r.eax} in ${r.ms.toFixed(1)} ms`);
        g.fill(0xcd, RIGHT, RIGHT + length + 16);
        r = timed(m, 'strcpy', RIGHT, LEFT);
        let same = true;
        for (let i = 0; i <= length && same; i++) same = g[RIGHT + i] === g[LEFT + i];
        check(!r.declined && r.eax === RIGHT && same && g[RIGHT + length + 1] === 0xcd, `${tag}: strcpy of ${length} bytes copies all of it and the terminator`);
    }
    const wlen = WIDE_LENGTH;
    fillWide(g, LEFT, wlen, 2);
    let r = timed(m, 'wcslen', LEFT, 0);
    check(!r.declined && r.eax === wlen && r.ms < TIME_BOUND_MS, `${tag}: wcslen(${wlen}) = ${r.eax}`);
    g.fill(0xcd, RIGHT, RIGHT + wlen * 2 + 16);
    r = timed(m, 'wcscpy', RIGHT, LEFT);
    check(!r.declined && g[RIGHT + wlen * 2] === 0 && g[RIGHT + wlen * 2 + 1] === 0 && g[RIGHT + wlen * 2 - 2] === g[LEFT + wlen * 2 - 2], `${tag}: wcscpy of ${wlen} units`);

    const top = RAM - TOP_BYTES;
    for (let i = top; i < RAM; i++) g[i] = 0x41;
    r = timed(m, 'strlen', top, 0);
    check(r.declined && r.ms < TIME_BOUND_MS, `${tag}: strlen of an unterminated string at RAM-16 declines (${r.ms.toFixed(1)} ms)`);
    r = timed(m, 'wcslen', top, 0);
    check(r.declined && r.ms < TIME_BOUND_MS, `${tag}: wcslen of an unterminated string at RAM-16 declines`);
    for (const bad of GARBAGE) {
        r = timed(m, 'strlen', bad, 0);
        check(r.declined && r.ms < TIME_BOUND_MS, `${tag}: strlen(0x${bad.toString(16)}) declines (${r.ms.toFixed(1)} ms)`);
        r = timed(m, 'strcmp', bad, LEFT);
        check(r.declined && r.ms < TIME_BOUND_MS, `${tag}: strcmp(0x${bad.toString(16)}, s) declines`);
    }

    const hole = (LEFT >> 12) + 0x200;
    fillNarrow(g, LEFT, 0x300000, 3);
    m.map(hole, hole, 0);
    m.api.full_clear_tlb();
    const eip0 = m.state().getUint32(556, true);
    r = timed(m, 'strlen', LEFT, 0);
    check(r.declined && r.eax === 1, `${tag}: strlen over a not-present page declines instead of reporting a partial length`);
    g.fill(0xcd, RIGHT, RIGHT + 0x300010);
    r = timed(m, 'strcpy', RIGHT, LEFT);
    check(r.declined && g[RIGHT] === 0xcd, `${tag}: strcpy from a string crossing a not-present page declines and leaves the destination untouched`);
    m.map(hole, hole, 7);
    m.api.full_clear_tlb();

    const ro = (RIGHT >> 12) + 2;
    fillNarrow(g, LEFT, 0x4000, 4);
    g.fill(0xcd, RIGHT, RIGHT + 0x4010);
    m.map(ro, ro, 0);
    m.api.full_clear_tlb();
    r = timed(m, 'strcpy', RIGHT, LEFT);
    check(r.declined && g[RIGHT] === 0xcd, `${tag}: strcpy into a destination that crosses a not-present page declines before writing`);
    m.map(ro, ro, 7);
    m.api.full_clear_tlb();
    m.close();
}
{
    const m = await createMachine(binary, {});
    m.setFallback(() => {});
    const g = m.guest();
    const top = RAM - TOP_BYTES;
    for (let i = top; i < RAM; i++) g[i] = 0x41;
    let r = timed(m, 'strlen', top, 0);
    check(r.declined && r.ms < TIME_BOUND_MS, `paging off: strlen of an unterminated string at RAM-16 declines at the end of RAM (${r.ms.toFixed(1)} ms)`);
    r = timed(m, 'wcslen', top, 0);
    check(r.declined && r.ms < TIME_BOUND_MS, 'paging off: wcslen of an unterminated string at RAM-16 declines');
    for (const bad of [...GARBAGE, 0xA0000]) {
        r = timed(m, 'strlen', bad, 0);
        check(r.declined && r.ms < TIME_BOUND_MS, `paging off: strlen(0x${bad.toString(16)}) declines (${r.ms.toFixed(1)} ms)`);
    }
    m.close();
}
console.log(failures ? `FAIL string-long (${failures})` : 'PASS string-long');
process.exitCode = failures ? 1 : 0;
