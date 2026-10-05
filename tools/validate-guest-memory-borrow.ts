#!/usr/bin/env bun
/**
 * Gate step: guest-RAM view OWNERSHIP.
 *
 * v86 hands out guest RAM as a Proxy so that WASM memory growth stays transparent. The
 * price is ~25x per element (162.6ns vs 6.4ns, `dbg.memBench`) — invisible in review and
 * enormous in a profile: a 38 KB/frame scan cost 10.3ms through the Proxy and 0.30ms
 * through a plain view.
 *
 * Asking every consumer to remember `toPlainGuestMemory` does not scale (of 114
 * `getCurrentMemory()` call sites, 4 did). So the rule is OWNERSHIP, not coverage — the
 * same shape `validate-guest-code-writes.ts` uses, and for the same reason: deciding
 * whether a given loop indexes guest memory per element needs dataflow, but deciding who
 * may reach for the RAW proxy is a grep.
 *
 * THE RULE: only the files listed in OWNERS may name `v86.mem8` / `cpu.mem8`. Everyone
 * else takes guest RAM from `process.getCurrentMemory()`, which normalizes to a plain
 * Uint8Array. A module that re-derives its own `getMemory()` from `v86.mem8` silently
 * opts its whole file back into the slow path — that is what this catches.
 *
 * NOT covered on purpose: a `this.mem8` FIELD (AddressSpace caches its view, where the
 * Proxy's growth transparency is load-bearing, and uses it for bulk `set`/`subarray`/`fill`,
 * not per-element loops). A field is only as raw as what was assigned INTO it, and that
 * assignment is a receiver access this check does see.
 *
 * The matcher is deliberately about the PROPERTY, not two blessed receiver spellings: it
 * was written as `v86|cpu` + a literal dot, which let `emu.cpu` into a local, a destructured
 * `const { mem8 } = cpu`, `emulator.mem8`, and — the spelling most of this codebase actually
 * uses — every optional-chained `v86?.mem8` straight past. Widening it exposed sites that
 * predate the rule; those are pinned in LEGACY below, exactly, so they can shrink but never
 * grow, and a NEW one fails wherever and however it is spelled.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "worker");

/** Files allowed to name the raw proxy, with why. */
const OWNERS: Record<string, string> = {
    "core/memory/guest-memory.ts": "the normalizer itself",
    "emulator.worker.ts": "wires the one supplier closure handed to Process/AddressSpace",
    "core/system.ts": "boot-time CPU wiring before a Process exists",
    "core/thunking/thunk-dispatcher.ts": "owns the per-thunk memory cache + its growth rebuild",
    "harness/cmds/breakpoints.ts": "diagnostic; must observe exactly what the guest sees",
    // Holds a bare v86 handle, not a Process, so it cannot reach getCurrentMemory(); it
    // normalizes the view itself instead — which the check below verifies.
    "modules/avifil32.ts": "no Process handle; wraps in toPlainGuestMemory at the source",
};

/** OWNERS that must still normalize (they may name mem8, but not hand the proxy onward). */
const MUST_NORMALIZE = new Set(["modules/avifil32.ts"]);

/**
 * Sites that predate the widened matcher. Pinned EXACTLY (as validate-file-cursor pins its
 * cursor writes): fixing one means editing the number, which is a reviewable line in a diff;
 * adding one fails the gate. Not an allowlist — every entry here is a file whose guest-memory
 * access still runs through v86's Proxy.
 */
const LEGACY = new Map<string, number>([
    ["core/cpu/aot-cache.ts", 2],
    ["core/cpu/hypercall-data.ts", 1],
    ["core/debug/dbg-commands.ts", 2],
    ["core/thunking/thunk-utils.ts", 1],
    ["modules/gdi32/context.ts", 4],
    ["modules/kernel32/module/module.ts", 1],
    ["modules/mss32/file-io.ts", 2],
    ["modules/user32/controls.ts", 2],
    ["modules/user32/dialog.ts", 5],
    ["modules/user32/message.ts", 4],
    ["modules/user32/window.ts", 1],
]);

/** Receiver spellings that are NOT v86's raw view — see the header. */
const SAFE_RECEIVERS = new Set(["this"]);

/** `x.mem8`, `x?.mem8`, `obj["mem8"]`, `const { mem8 } = …` — any receiver, any spelling. */
const RAW = /([\w$]+)\s*(?:\?\.|\.)mem8\b|\[["']mem8["']\]|(?:const|let|var)\s*\{[^}]*\bmem8\b[^}]*\}\s*=/;

/** True when the line's only mem8 access is through a safe receiver. */
function isSafe(code: string): boolean {
    const m = RAW.exec(code);
    return m !== null && m[1] !== undefined && SAFE_RECEIVERS.has(m[1]);
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}

const offenders: { file: string; line: number; text: string }[] = [];
/** Every file that names mem8 at all — the stale-OWNERS check reads this. */
const namesMem8 = new Set<string>();
const legacySeen = new Map<string, number>();

for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const mustNormalize = MUST_NORMALIZE.has(rel);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
        const code = text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (!RAW.test(code)) return;
        namesMem8.add(rel);
        if (OWNERS[rel] && !mustNormalize) return;
        if (isSafe(code)) return;
        // A must-normalize owner may name mem8 only inside toPlainGuestMemory(...).
        if (mustNormalize && code.includes("toPlainGuestMemory(")) return;
        if (LEGACY.has(rel)) { legacySeen.set(rel, (legacySeen.get(rel) ?? 0) + 1); return; }
        offenders.push({ file: rel, line: i + 1, text: text.trim() });
    });
}

// The pinned legacy count must match exactly — a file that grew a site is a new violation
// hiding behind an old one, and a file that shrank must say so here.
const drifted: string[] = [];
for (const [rel, expected] of LEGACY) {
    const found = legacySeen.get(rel) ?? 0;
    if (found !== expected) drifted.push(`  ${rel}: ${found} raw site(s), pinned at ${expected}`);
}

// A stale OWNERS entry grants an exemption nothing needs — and reads as evidence that the
// file still takes the proxy when it no longer does.
const staleOwners = Object.keys(OWNERS).filter(rel => !namesMem8.has(rel));

if (drifted.length > 0 || staleOwners.length > 0) {
    if (drifted.length > 0) {
        console.error("The pinned legacy raw-proxy count changed:\n");
        for (const d of drifted) console.error(d);
        console.error("\nFixed one? Lower the number. Added one? Take memory from process.getCurrentMemory().\n");
    }
    if (staleOwners.length > 0) {
        console.error("OWNERS entries whose file no longer names mem8 — delete them:\n");
        for (const s of staleOwners) console.error(`  ${s}  (${OWNERS[s]})`);
        console.error("");
    }
    process.exit(1);
}

if (offenders.length > 0) {
    console.error(
        `Guest-memory ownership VIOLATED — ${offenders.length} site(s) take v86's RAW proxy view.\n` +
        `Each one runs its whole file's guest-memory access ~25x slower per element.\n` +
        `Take memory from process.getCurrentMemory() (already normalized), or, if this file\n` +
        `genuinely needs the growth-transparent proxy, add it to OWNERS in this validator\n` +
        `with the reason.\n`
    );
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
    process.exit(1);
}

const legacyTotal = [...LEGACY.values()].reduce((a, b) => a + b, 0);
console.log(
    `Guest-memory ownership OK — raw proxy access confined to ${Object.keys(OWNERS).length} owner(s) ` +
    `plus ${legacyTotal} pinned legacy site(s) in ${LEGACY.size} file(s).`,
);
