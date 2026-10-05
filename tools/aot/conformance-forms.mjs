#!/usr/bin/env node
// Compile every form of the slice-conformance vector ALONE and refuse any that does not produce
// a structurally valid module — plus the whole vector, and every prefix of it.
//
//   node tools/aot/conformance-forms.mjs
//
// The load-bearing detail — this tool was USELESS until it was fixed: a wasm block that ends in a
// `br` DISCARDS the operand stack, so an emitter that leaks an operand validates fine in any
// arrangement where every block branches. One instruction followed by `ret` is such an
// arrangement. Each form is therefore compiled as a block that **falls through** into a second
// block (instruction, then `nop; ret`, with an entry point published at both), which is the only
// shape in which the imbalance is a validation error. Re-introduce the `push32` leak the README
// describes and this file must fail — if it passes, it is measuring nothing.
//
// This is offline and needs no engine instance: WebAssembly.validate does not resolve imports.

import { buildK6 } from "../aot-oracle/corpus/k6-conformance.mjs";
import { compileUnit } from "./lib/emit.mjs";

const PAGE_BASE = 0x00106000;
const STATE_FLAGS = 11;              // is_32 | ss32 | flat_segs, cpl0 — the oracle image's shape
const JIT_CONFIG = { 5: 1 };         // dead-flag elision ON, as in production

const { bytes, lines } = buildK6();

function compile(pageContent, entryAddrs, tail = [0xC3]) {
    // The page is RET-filled, not zero-filled, and that is load-bearing now that the slice
    // contains control transfers: a zero page decodes as `add [eax], al` for 4 KiB — all of it
    // inside the slice — so a form whose branch target lands past the tail (`jnz +2` does; its
    // target is +4 while the tail sits at +2) swept the whole page, produced thousands of blocks
    // and a body large enough to overflow the encoder's argument spread. That is design K5's
    // "a wrong entry set produces a plausible artifact" reaching this tool: the failure was a
    // property of the ARRANGEMENT, not of the lowering. With 0xC3 fill any stray target is an
    // immediate `ret`, which bounds every form without weakening the fallthrough shape.
    const page = new Uint8Array(4096).fill(0xC3);
    page.set(pageContent, 0);
    page.set(tail, pageContent.length);
    const unit = compileUnit({
        pageBase: PAGE_BASE, pageBytes: page, entryAddrs,
        stateFlags: STATE_FLAGS, jitConfig: JIT_CONFIG,
    });
    if (WebAssembly.validate(unit.bytes)) return { unit, why: null };
    let why = "invalid (no detail)";
    try { new WebAssembly.Module(unit.bytes); } catch (e) { why = e.message; }
    return { unit, why };
}

const out = { forms: { checked: 0, failed: [] }, prefixes: { checked: 0, failed: [] }, whole: null };

// Pass 1 — each form as a FALLTHROUGH block: <instruction> | nop; ret, entered at both heads.
for (const ln of lines) {
    out.forms.checked++;
    let r;
    try {
        r = compile(bytes.subarray(ln.off, ln.off + ln.bytes),
            [PAGE_BASE, PAGE_BASE + ln.bytes], [0x90, 0xC3]);
    }
    catch (e) { r = { why: `compile: ${e.message}` }; }
    if (r.why) out.forms.failed.push({ text: ln.text, why: r.why });
}

// Pass 2 — every prefix, with an entry at the boundary after it, so the prefix's last block also
// falls through. Reports the FIRST instruction after which the body stops validating.
for (const [i, ln] of lines.entries()) {
    const end = i + 1 < lines.length ? lines[i + 1].off : bytes.length;
    out.prefixes.checked++;
    let r;
    try { r = compile(bytes.subarray(0, end), [PAGE_BASE, PAGE_BASE + end], [0x90, 0xC3]); }
    catch (e) { r = { why: `compile: ${e.message}` }; }
    if (r.why) { out.prefixes.failed.push({ upToAndIncluding: ln.text, why: r.why }); break; }
}

// Pass 3 — the whole vector with an entry point at EVERY instruction boundary: the totality-law
// arrangement (design §4.2 H1), and the densest possible set of fallthrough blocks.
{
    const heads = lines.map((ln) => PAGE_BASE + ln.off);
    let r;
    try { r = compile(bytes, [...heads, PAGE_BASE + bytes.length], [0x90, 0xC3]); }
    catch (e) { r = { why: `compile: ${e.message}` }; }
    out.whole = r.why ? { ok: false, why: r.why } : { ok: true, bytes: r.unit.bytes.length, entries: r.unit.entries.length };
}

out.ok = out.forms.failed.length === 0 && out.prefixes.failed.length === 0 && out.whole.ok;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
