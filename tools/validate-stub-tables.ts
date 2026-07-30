/**
 * Quality-gate check: a stub table must not declare a name a real implementation provides.
 *
 * Module export tables are flat `Record<"Interface_Method", ThunkImplementation>` maps built
 * by several factories and merged. A `*-stubs.ts` factory that lists a method somebody has
 * actually implemented is a live hazard: merged with `Object.assign` it silently REPLACES the
 * real handler with `() => D3D_OK`, and the guest then gets a success code with the out-param
 * untouched. That failure is invisible at the call site and lands far away — a NULL vtable
 * pointer read through an identity-mapped page raises no #PF, so `call [eax+0x40]` jumps into
 * whatever byte happened to be at linear 0. Exactly that shipped for `GetCurrentViewport` /
 * `SetCurrentViewport`, whose stub entries sat next to a comment saying not to do it.
 *
 * `assignStubsOnce` (core/thunking/stub-merge.ts) makes the merge order-independent so a real
 * implementation always wins. This check is the other half: the shadowed stub entry is still
 * dead code that misleads the next reader, and a comment is not a mechanism.
 *
 * Scope: `src/worker/modules/**\/*-stubs.ts` — the factories that build a SEPARATE table and
 * hand it to a merge. Inline `if (!exports[key])` delegation loops write into the table they
 * read, so they cannot shadow anything and are out of scope by construction.
 *
 * Usage: bun tools/validate-stub-tables.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MODULES = join(ROOT, "src", "worker", "modules");

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts")) yield full;
    }
}

const rel = (f: string) => relative(ROOT, f).split("/").join(sep);

/** `exports["Interface_Method"] = ` / `exports['…'] = ` — a literal registration. */
const LITERAL_KEY = /\bexports\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]\s*=/g;
/** `const someStubs = [ "A", "B", … ]` — the method-name array a stub loop iterates. */
const STUB_ARRAY = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g;
/** `for (const method of someStubs)` — binds the loop variable to that array. */
const STUB_LOOP = /\bfor\s*\(\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s+of\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

/** Body of the block that starts at the first `{` at or after `from`. */
function blockAfter(text: string, from: number): string {
    const open = text.indexOf("{", from);
    if (open < 0) return "";
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
    }
    return text.slice(open);
}

interface Site { key: string; file: string; line: number; }

const stubSites: Site[] = [];
const realSites = new Map<string, Site>();

const lineOf = (text: string, index: number) => text.slice(0, index).split(/\r?\n/).length;

for (const file of walk(MODULES)) {
    const text = readFileSync(file, "utf8");
    const isStubFile = /-stubs\.ts$/.test(file);
    const target = isStubFile ? null : realSites;

    for (const m of text.matchAll(LITERAL_KEY)) {
        const site: Site = { key: m[1]!, file: rel(file), line: lineOf(text, m.index!) };
        if (isStubFile) stubSites.push(site);
        else if (!target!.has(site.key)) target!.set(site.key, site);
    }

    if (!isStubFile) continue;

    // A stub file's templated registrations. Both the array contents and the key prefix are
    // literals, so `for (const m of arr) exports[`Prefix_${m}`] = …` yields an exactly known
    // key set — as long as each array is paired with the prefix of ITS OWN loop body.
    const arrays = new Map<string, { methods: string[]; line: number }>();
    for (const arr of text.matchAll(STUB_ARRAY)) {
        arrays.set(arr[1]!, {
            methods: [...arr[2]!.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((m) => m[1]!),
            line: lineOf(text, arr.index!),
        });
    }
    for (const loop of text.matchAll(STUB_LOOP)) {
        const [, loopVar, arrName] = loop;
        const arr = arrays.get(arrName!);
        if (!arr || arr.methods.length === 0) continue;
        const body = blockAfter(text, loop.index! + loop[0].length);
        const keyRe = new RegExp("\\bexports\\[\\s*`([A-Za-z_][A-Za-z0-9_]*_)\\$\\{\\s*" + loopVar + "\\s*\\}`\\s*\\]\\s*=", "g");
        for (const m of body.matchAll(keyRe)) {
            for (const method of arr.methods) {
                stubSites.push({ key: m[1]! + method, file: rel(file), line: arr.line });
            }
        }
    }
}

const violations: string[] = [];
const seen = new Set<string>();
for (const stub of stubSites) {
    const real = realSites.get(stub.key);
    if (!real || seen.has(stub.key)) continue;
    seen.add(stub.key);
    violations.push(
        `${stub.key}\n    stub declared at ${stub.file}:${stub.line}\n    implemented at ${real.file}:${real.line}`,
    );
}

if (violations.length > 0) {
    console.error("Stub tables shadowing real implementations:\n");
    for (const v of violations) console.error(`  ${v}\n`);
    console.error(
        `${violations.length} collision(s). Remove the name from the stub table — the real handler\n` +
        "is the one the guest needs, and assignStubsOnce already drops the stub at runtime.\n",
    );
    process.exit(1);
}

console.log(`validate-stub-tables: OK (${stubSites.length} stub entries, ${realSites.size} implementations)`);
