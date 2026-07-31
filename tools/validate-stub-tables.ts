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

/**
 * The accumulator a registration is written into. NOT just `exports`: a table built as
 * `table["X"] = …` and merged with `Object.assign(exports, table)` registers exactly the same
 * key, and a real handler installed through `this.exports` is just as real. Over-matching an
 * unrelated map is harmless — a collision needs the SAME `Interface_Method` key on both sides.
 */
const ACC = String.raw`(?:this\.)?[A-Za-z_$][\w$]*`;

/** `<acc>["Interface_Method"] = ` — a literal registration. */
const LITERAL_KEY = new RegExp(String.raw`\b${ACC}\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]\s*=`, "g");
/** `const someNames = [ "A", "B", … ]` — the name array a registration loop iterates. */
const NAME_ARRAY = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g;
/** `for (const method of someNames)` — binds the loop variable to that array. */
const NAME_LOOP = /\bfor\s*\(\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s+of\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

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

/**
 * Templated registrations. Both the array contents and the literal half of the key are
 * literals, so `for (const m of arr) acc[`Prefix_${m}`] = …` yields an exactly known key set —
 * as long as each array is paired with ITS OWN loop body. Both halves occur in practice:
 * the loop variable can supply the METHOD (`IDirect3DDevice7_${method}`) or the INTERFACE
 * (`${prefix}_QueryInterface`, how d3d9 registers the real COM triple).
 */
function templatedKeys(text: string, file: string): Site[] {
    const out: Site[] = [];
    const arrays = new Map<string, { names: string[]; line: number }>();
    for (const arr of text.matchAll(NAME_ARRAY)) {
        arrays.set(arr[1]!, {
            names: [...arr[2]!.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((m) => m[1]!),
            line: lineOf(text, arr.index!),
        });
    }
    for (const loop of text.matchAll(NAME_LOOP)) {
        const [, loopVar, arrName] = loop;
        const arr = arrays.get(arrName!);
        if (!arr || arr.names.length === 0) continue;
        const body = blockAfter(text, loop.index! + loop[0].length);
        const prefixRe = new RegExp(`\\b${ACC}\\[\\s*\`([A-Za-z_][A-Za-z0-9_]*_)\\$\\{\\s*${loopVar}\\s*\\}\`\\s*\\]\\s*=`, "g");
        const suffixRe = new RegExp(`\\b${ACC}\\[\\s*\`\\$\\{\\s*${loopVar}\\s*\\}(_[A-Za-z_][A-Za-z0-9_]*)\`\\s*\\]\\s*=`, "g");
        for (const m of body.matchAll(prefixRe)) {
            for (const name of arr.names) out.push({ key: m[1]! + name, file, line: arr.line });
        }
        for (const m of body.matchAll(suffixRe)) {
            for (const name of arr.names) out.push({ key: name + m[1]!, file, line: arr.line });
        }
    }
    return out;
}

for (const file of walk(MODULES)) {
    const text = readFileSync(file, "utf8");
    const isStubFile = /-stubs\.ts$/.test(file);
    const here = rel(file);

    const sites: Site[] = [...text.matchAll(LITERAL_KEY)].map((m) => ({
        key: m[1]!, file: here, line: lineOf(text, m.index!),
    }));
    sites.push(...templatedKeys(text, here));

    for (const site of sites) {
        if (isStubFile) stubSites.push(site);
        else if (!realSites.has(site.key)) realSites.set(site.key, site);
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
