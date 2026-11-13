/**
 * Shared cases for the CRT string leaves on long strings and on scans that would leave guest
 * memory. tools/runtime-test/string-long.mjs runs them with the string hypercalls on,
 * tools/tests/crt-string-uncapped.test.ts runs them through the JS fallbacks.
 *
 * Inside RAM both arms answer the whole string. A scan that would leave RAM is declined by the
 * hypercall, so the JS fallback answers it in both arms: `fallback` is that answer.
 */
export const NARROW_LENGTHS = [0x100001, 0x100002, 1739453];
export const WIDE_LENGTH = 0x100001;
export const TOP_BYTES = 16;
export const GARBAGE = [0xCDCDCDCD, 0xBAADF00D, 0xFEEEFEEE];
export const TIME_BOUND_MS = 2000;

export const fallback = {
    strlenTop: TOP_BYTES,
    wcslenTop: TOP_BYTES / 2,
    strlenGarbage: 0,
    wcslenGarbage: 0,
    wcschrGarbage: 0,
    strstrGarbageHaystack: 0,
    strstrGarbageNeedle: 0,
    wcsstrGarbageHaystack: 0,
    wcsstrGarbageNeedle: 0,
};

export function fillNarrow(g, at, length, seed) {
    for (let i = 0; i < length; i++) g[at + i] = 0x41 + ((i * 7 + seed) % 26);
    g[at + length] = 0;
}

export function fillWide(g, at, length, seed) {
    for (let i = 0; i < length; i++) {
        g[at + i * 2] = 0x41 + ((i * 7 + seed) % 26);
        g[at + i * 2 + 1] = i % 3 === 0 ? 0x04 : 0;
    }
    g[at + length * 2] = 0;
    g[at + length * 2 + 1] = 0;
}
