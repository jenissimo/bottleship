/**
 * Quality-gate check: a module descriptor must declare each export name ONCE.
 *
 * An export name is unique in a real DLL — one name, one address — and three of our paths
 * depend on that: the HLE module image lays a stub body per declared function, the export
 * directory's name array is sorted for binary search, and `exportAddresses` is a Map. Declare
 * a name twice and the image carries two bodies at two addresses under one name, so the PE
 * walk and the Map can answer with DIFFERENT ones. Nothing fails at that moment, and a title
 * that checks its own integrity — comparing GetProcAddress against the address in its own IAT
 * slot, which is what an API-hook check does — reads the mismatch as a hooked API.
 *
 * `materializeHleModuleImages` emits the first declaration and skips the rest, so a duplicate
 * can no longer split an address. This check is the other half: the duplicate is still a lie
 * about the ABI (two copies may disagree on arity, and which one wins is invisible), and
 * dedup at the consumer is not a licence to declare it twice.
 *
 * Names are compared case-INSENSITIVELY, because the image's own lookup map is
 * (`exportsByLowerName`) and the registry merges that way too: two spellings that differ only
 * in case are one export downstream and would split an address exactly the same way.
 *
 * The descriptors are imported and their real `functions` arrays inspected, so a duplicate
 * introduced by any spelling — a second `makeFunc`, a spread, a generated list — is caught.
 *
 * Usage: bun tools/validate-api-export-uniqueness.ts
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const API_DIR = join(ROOT, "src", "worker", "api");

interface DescriptorFunction { name: string; params?: unknown[] }
interface ModuleDescriptor { name?: string; functions?: DescriptorFunction[] }

const rel = (f: string) => relative(ROOT, f).split("/").join(sep);

let files = 0;
let descriptors = 0;
let checked = 0;
const failures: string[] = [];

for (const entry of readdirSync(API_DIR).filter((n) => n.endsWith(".api.ts")).sort()) {
    const full = join(API_DIR, entry);
    files++;
    let mod: Record<string, unknown>;
    try {
        mod = (await import(full)) as Record<string, unknown>;
    } catch (e) {
        failures.push(`${rel(full)}: could not be imported — ${(e as Error).message}`);
        continue;
    }

    for (const [exportName, value] of Object.entries(mod)) {
        const descriptor = value as ModuleDescriptor | undefined;
        const functions = descriptor?.functions;
        if (!Array.isArray(functions)) continue;
        descriptors++;

        // Arity is part of the identity: two declarations of one name that also disagree on
        // the argument list are two different ABIs, and the dedup would silently pick one.
        const seen = new Map<string, { index: number; arity: number; name: string }>();
        for (const [index, fn] of functions.entries()) {
            if (!fn?.name) continue;
            checked++;
            const arity = fn.params?.length ?? 0;
            const key = fn.name.toLowerCase();
            const first = seen.get(key);
            if (!first) {
                seen.set(key, { index, arity, name: fn.name });
                continue;
            }
            const spelling = first.name === fn.name
                ? `"${fn.name}"`
                : `"${first.name}" and "${fn.name}" (one export, two spellings)`;
            const abi = first.arity === arity
                ? `both with ${arity} arg(s)`
                : `WITH DIFFERENT ARITIES (${first.arity} vs ${arity}) — the two are different ABIs`;
            failures.push(
                `${rel(full)} (${exportName}): ${spelling} declared twice `
                + `(functions[${first.index}] and functions[${index}]), ${abi}`,
            );
        }
    }
}

if (failures.length) {
    console.error(`validate-api-export-uniqueness: ${failures.length} duplicate export declaration(s)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}

// A run that imported nothing would report a clean sheet for the one reason it saw no data.
if (!files || !descriptors || !checked) {
    console.error(
        `validate-api-export-uniqueness: examined ${files} file(s), ${descriptors} descriptor(s), `
        + `${checked} declaration(s) — zero duplicates is not evidence here`,
    );
    process.exit(1);
}

console.log(
    `validate-api-export-uniqueness: OK (${checked} export declarations across `
    + `${descriptors} descriptors in ${files} files, every name declared once)`,
);
