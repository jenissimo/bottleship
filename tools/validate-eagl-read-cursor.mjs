#!/usr/bin/env bun
/**
 * The EAGL read cursor (vendor/v86/src/rust/cpu/hypercall_eagl.rs) caches ONE
 * page translation across hypercall dispatches. Under the shipping TLB-driven
 * policy its whole safety argument is one sentence:
 *
 *   the cursor is dropped everywhere v86 drops its own TLB entry, so the
 *   cursor's lifetime is a SUBSET of the lifetime of that entry.
 *
 * `set_tlb_entry` is the only writer of `tlb_data` (validate-tlb-mirror pins
 * that), so "drops an entry" means exactly `set_tlb_entry(<page>, 0)`. This
 * validator fails if any function containing such a call does not also call
 * `eagl_read_cursor_invalidate()` — a fifth clearing site added later would
 * otherwise leave the cursor answering with a translation the CPU has thrown
 * away, and nothing at runtime would notice: the read succeeds and returns the
 * wrong page.
 *
 * Not covered, deliberately: a call that INSTALLS a translation
 * (`set_tlb_entry(page, entry)`) or that only flips TLB_HAS_CODE. Neither can
 * change the address a live cursor resolves to.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CPU_RS = join(root, 'vendor/v86/src/rust/cpu/cpu.rs');

let src;
try {
    src = readFileSync(CPU_RS, 'utf8');
} catch {
    console.log('validate-eagl-read-cursor: vendor/v86 not checked out — skipped');
    process.exit(0);
}

const lines = src.split(/\r?\n/);

/** Split the file into top-level `fn` bodies by brace depth. */
function functions() {
    const out = [];
    let cur = null, depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (cur === null) {
            const m = /^\s*(?:pub\s+)?(?:unsafe\s+)?(?:extern\s+"C"\s+)?fn\s+([A-Za-z0-9_]+)/.exec(line);
            if (m) { cur = { name: m[1], start: i + 1, body: [] }; depth = 0; }
            else continue;
        }
        cur.body.push(line);
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (cur.body.length > 1 && depth <= 0) { out.push(cur); cur = null; }
    }
    return out;
}

const CLEAR = /set_tlb_entry\s*\(\s*[A-Za-z0-9_]+\s*,\s*0\s*\)/;
const DROP = /eagl_read_cursor_invalidate\s*\(/;

const clearing = [];
const bad = [];
for (const fn of functions()) {
    const text = fn.body.join('\n');
    if (!CLEAR.test(text)) continue;
    clearing.push(fn.name);
    if (!DROP.test(text)) bad.push(fn);
}

if (clearing.length === 0) {
    console.error('validate-eagl-read-cursor: FAIL — no `set_tlb_entry(page, 0)` site found at all.');
    console.error('  Either the TLB clear moved (and this check now proves nothing), or the parse broke.');
    process.exit(1);
}

if (bad.length > 0) {
    console.error('validate-eagl-read-cursor: FAIL — a TLB entry is dropped without dropping the EAGL cursor:');
    for (const fn of bad) {
        console.error(`  vendor/v86/src/rust/cpu/cpu.rs:${fn.start}  fn ${fn.name}()`);
    }
    console.error('\n  Add `crate::cpu::hypercall_eagl::eagl_read_cursor_invalidate();` before the clear,');
    console.error('  or the cursor can answer a read from a page the CPU no longer maps.');
    process.exit(1);
}

console.log(
    `EAGL read-cursor containment OK — ${clearing.length} TLB-clearing function(s) ` +
    `all drop the cursor: ${clearing.join(', ')}`);
