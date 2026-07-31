/**
 * Quality-gate check: a VfsFileHandle's `position` has exactly ONE set of owners.
 *
 * The cursor is the file object's shared mutable state. Every silent-corruption bug in
 * the file stack has had the same shape: some path that is not the file-object layer
 * reads `position`, yields, and writes it back — MapViewOfFile snapshotting the guest's
 * cursor across megabytes of `await vfs.read`, a prefetch installing a window under an
 * offset sampled at a different instant. The bytes come back the right LENGTH, so
 * nothing above notices.
 *
 * Three rules, mirroring validate-guest-code-writes.ts's ownership-not-coverage stance:
 *
 *   1. OWNERSHIP — `<something>Handle.position` may only be touched by the layers that
 *      implement the file object: the VFS itself, and the two handle layers that wrap it
 *      for the guest (kernel32's FileHandleWrapper, the CRTs FILE-star/fd tables). Anywhere
 *      else, take your own cursor (`vfs.duplicateHandle`) or use the offset-taking API.
 *
 *   2. A PINNED NUMBER OF MUTATION SITES — the hazard is two paths advancing the same
 *      cursor, and that is a COUNT, not a spelling. `position += n`, `position = position + n`
 *      and `position = startPos + n` are the same write; a rule phrased against one spelling
 *      is sidestepped by the next, and the sanctioned advance in vfs.ts already had to be
 *      written the long way to get past such a rule. So every assignment site is counted and
 *      compared against the budget below: a new one fails the gate however it is spelled, and
 *      raising the budget is a deliberate, reviewable edit.
 *
 *   3. NO COMPOUND ASSIGNMENT — `position += n` stays banned on top of the budget: a
 *      read-modify-write across a yield is the shape of every double-advance bug, and
 *      spelling it out keeps the write greppable.
 *
 * Scope, deliberately: this is a LINE check on receiver SHAPE (an identifier ending in
 * `handle`), not a type check. Proving a given `.position` is a VfsFileHandle needs the
 * type checker; the shape convention is what the codebase actually follows, and the
 * alternative — a dataflow lint — would be either noisy enough to ignore or narrow
 * enough to be useless. Non-handle cursors (audio ring buffers, mmio handles, WGSL
 * `out.position`) are correctly out of scope.
 *
 * Usage: bun tools/validate-file-cursor.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/**
 * The file-object layers. These IMPLEMENT the cursor, so they are the only places its
 * representation may be touched directly.
 *   vfs.ts        — the file object itself (open/read/write/setPosition).
 *   file-io.ts    — kernel32 FileHandleWrapper: the Win32 HANDLE layer.
 *   msvcrt/crtdll — the CRT FILE-star/fd tables: the C stream layer.
 */
const OWNERS = new Set([
    join("src", "worker", "runtime", "filesystem", "vfs.ts"),
    join("src", "worker", "modules", "kernel32", "file-io.ts"),
    join("src", "worker", "modules", "msvcrt.ts"),
    join("src", "worker", "modules", "crtdll.ts"),
]);

/** `handle.position`, `vfsHandle.position`, `stream.handle.position`, … */
const ACCESS = /\b(\w*[Hh]andle)\.position\b/;
/** The same, being read-modify-written. */
const COMPOUND = /\b(\w*[Hh]andle)\.position\s*(\+=|-=)/;
/** The same, being assigned — any spelling, absolute or derived. */
const MUTATION = /\b(\w*[Hh]andle)\.position\s*(?:\+=|-=|\*=|\/=|\|=|&=|=(?!=))/;

/**
 * How many cursor writes each owner is allowed. These are the file object's own state
 * transitions: vfs.ts has the single advance plus the seek, the handle layers have their
 * rewinds and append-mode syncs. A change here means a NEW way the cursor moves — say why
 * in the commit, then update the number.
 */
const MUTATION_BUDGET = new Map([
    [join("src", "worker", "runtime", "filesystem", "vfs.ts"), 2],
    [join("src", "worker", "modules", "kernel32", "file-io.ts"), 2],
    [join("src", "worker", "modules", "msvcrt.ts"), 5],
    [join("src", "worker", "modules", "crtdll.ts"), 1],
]);

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
    }
}

const foreign: string[] = [];
const compound: string[] = [];
const mutations = new Map<string, string[]>();

for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split("/").join(sep);
    const isOwner = OWNERS.has(rel);

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name it
        const where = `${rel}:${i + 1}: ${line.trim()}`;
        if (MUTATION.test(line)) {
            const list = mutations.get(rel) ?? [];
            list.push(where);
            mutations.set(rel, list);
        }
        if (COMPOUND.test(line)) compound.push(where);
        else if (!isOwner && ACCESS.test(line)) foreign.push(where);
    });
}

// Rule 2: the number of writes, per owner, is pinned.
const budgeted: string[] = [];
for (const [rel, allowed] of MUTATION_BUDGET) {
    const found = mutations.get(rel) ?? [];
    if (found.length === allowed) continue;
    budgeted.push(
        `${rel}: ${found.length} cursor write(s), budget ${allowed}\n` +
        found.map((f) => `      ${f}`).join("\n"),
    );
}

if (foreign.length > 0 || compound.length > 0 || budgeted.length > 0) {
    if (budgeted.length > 0) {
        console.error("The number of file-cursor write sites changed.");
        console.error("(A new advance is a new way the cursor can double-count — see the header here.)\n");
        for (const v of budgeted) console.error(`  ${v}\n`);
    }
    if (foreign.length > 0) {
        console.error("A VfsFileHandle's cursor may only be touched by the file-object layers.");
        console.error("(Take your own cursor with vfs.duplicateHandle() — see the header here.)\n");
        for (const v of foreign) console.error(`  ${v}`);
        console.error("");
    }
    if (compound.length > 0) {
        console.error("Compound assignment to a file cursor is banned (read-modify-write across a yield).");
        console.error("(Route the advance through a single named mutation.)\n");
        for (const v of compound) console.error(`  ${v}`);
        console.error("");
    }
    console.error(`${foreign.length + compound.length + budgeted.length} violation(s).`);
    process.exit(1);
}

const total = [...MUTATION_BUDGET.values()].reduce((a, b) => a + b, 0);
console.log(`File-cursor ownership OK — no foreign access, ${total} owned write site(s), all within budget.`);
