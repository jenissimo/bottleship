#!/usr/bin/env bun

/**
 * Pre-flight API coverage census — "what does this game need, and what do we not have?"
 * answered WITHOUT booting the emulator.
 *
 * Walks every PE inside a `.wgb` (our own store-only ZIP reader; never a system unzip),
 * parses each import table, and cross-references it against what the repo actually
 * implements (`src/worker/api/*.api.ts` + `src/worker/modules/**`). The output is a
 * ranked work order — an export called 40 times from the entrypoint outranks one called
 * once from a bundled helper DLL — led by the class that actively misleads the guest:
 * silent stubs.
 *
 * It ranks REMAINING API WORK. It is not a boot predictor, and the numbers are calibrated
 * against 37 bundles known to run rather than assumed; see the note atop import-census.ts.
 *
 * Usage:
 *   bun tools/api-census.ts <bundle.wgb|dir> [...]      per-bundle reports
 *   bun tools/api-census.ts <dir> --queue               one line per bundle, worst first
 *   bun tools/api-census.ts <bundle.wgb> --json         machine-readable
 *
 * Flags:
 *   --queue          queue-wide summary table only
 *   --tree           print the shipped-module load graph (depth + who pulls each one in)
 *   --json           emit JSON (per bundle, or an array with --queue)
 *   --top N          entries per section in the text report (default 12)
 *   --all-exes       analyze every EXE, not just the manifest entrypoint
 *   --max-mb N       skip PEs larger than N MB (default 64)
 *   --out FILE       write the JSON to FILE instead of stdout
 */

import { closeSync, openSync, readSync, fstatSync, readdirSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ZipArchive, type ZipSource, type ZipEntry } from '@bottleship/formats/zip';
import {
    readPeHeaders, parsePeImports, parsePeExports, countIatCallSites,
    detectPacker, importsLookHidden,
} from '@bottleship/formats/pe';
import { ApiCoverageIndex } from '../src/worker/tools/api-coverage';
import { buildCensus, rankQueue, type BundleCensus, type ImportRef, type ShippedDll } from '../src/worker/tools/import-census';

const PE_EXTENSIONS = new Set(['.exe', '.dll', '.ocx', '.ax', '.drv', '.flt', '.asi', '.dle']);

/** File-descriptor ZipSource: a `.wgb` is routinely >1 GB, so never buffer the whole file. */
class FdSource implements ZipSource {
    readonly size: number;
    constructor(private fd: number) {
        this.size = fstatSync(fd).size;
    }
    readRangeSync(start: number, end: number): Uint8Array {
        const from = Math.max(0, Math.min(start, this.size));
        const to = Math.max(from, Math.min(end, this.size));
        const buf = Buffer.allocUnsafe(to - from);
        let got = 0;
        while (got < buf.length) {
            const n = readSync(this.fd, buf, got, buf.length - got, from + got);
            if (n <= 0) break;
            got += n;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, got);
    }
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }
}

interface Options {
    queue: boolean;
    json: boolean;
    top: number;
    allExes: boolean;
    tree: boolean;
    maxBytes: number;
    out: string | null;
}

function parseArgs(argv: string[]): { targets: string[]; opts: Options } {
    const targets: string[] = [];
    const opts: Options = { queue: false, json: false, tree: false, top: 12, allExes: false, maxBytes: 64 << 20, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--queue') opts.queue = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--all-exes') opts.allExes = true;
        else if (a === '--tree') opts.tree = true;
        else if (a === '--top') opts.top = parseInt(argv[++i], 10) || 12;
        else if (a === '--max-mb') opts.maxBytes = (parseInt(argv[++i], 10) || 64) << 20;
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
        else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        else targets.push(a);
    }
    return { targets, opts };
}

function printUsage(): void {
    console.log(`Usage: bun tools/api-census.ts <bundle.wgb|dir> [...] [--queue] [--json] [--tree]
                                   [--top N] [--all-exes] [--max-mb N] [--out FILE]`);
}

function expandTargets(targets: string[]): string[] {
    const out: string[] = [];
    for (const t of targets) {
        const st = statSync(t);
        if (st.isDirectory()) {
            for (const f of readdirSync(t)) {
                if (f.toLowerCase().endsWith('.wgb')) out.push(path.join(t, f));
            }
        } else out.push(t);
    }
    return out.sort();
}

function baseNoExt(p: string): string {
    return path.basename(p.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').toLowerCase();
}

const LATIN1 = new TextDecoder('latin1');
const DLL_MENTION = /([A-Za-z0-9_.%\-\\/]+)\.dll/g;

/**
 * Module names an image mentions as a literal string — the LoadLibrary edges an import
 * table cannot show. Engines often build the name with a format string ("ref_%s.dll"),
 * so a mention carrying a printf conversion becomes a prefix pattern.
 */
function mentionedModules(image: Uint8Array): { exact: Set<string>; patterns: RegExp[] } {
    const exact = new Set<string>();
    const patterns: RegExp[] = [];
    const text = LATIN1.decode(image);
    for (const m of text.matchAll(DLL_MENTION)) {
        const base = baseNoExt(m[1]);
        if (!base) continue;
        if (base.includes('%')) {
            const rx = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%[-0-9.]*[a-z]/gi, '.*');
            if (rx !== '.*') patterns.push(new RegExp(`^${rx}$`));
        } else exact.add(base);
    }
    return { exact, patterns };
}

async function censusBundle(bundlePath: string, index: ApiCoverageIndex, opts: Options): Promise<BundleCensus> {
    const fd = openSync(bundlePath, 'r');
    try {
        const archive = new ZipArchive(new FdSource(fd));
        await archive.init();

        let manifest: any = {};
        const manifestEntry = archive.getEntry('manifest.json');
        if (manifestEntry) {
            try { manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(manifestEntry))); }
            catch { /* a bundle without a readable manifest still censuses fine */ }
        }
        const entrypoint: string | undefined = manifest.entrypoint;
        const entryLower = entrypoint?.replace(/\\/g, '/').toLowerCase();

        const candidates = archive.listEntries().filter((e: ZipEntry) => {
            if (e.isDirectory) return false;
            const ext = path.extname(e.name).toLowerCase();
            if (!PE_EXTENSIONS.has(ext)) return false;
            if (ext === '.exe' && !opts.allExes) {
                return e.name.replace(/\\/g, '/').toLowerCase() === entryLower;
            }
            return true;
        });

        const refs: ImportRef[] = [];
        const shipped = new Map<string, ShippedDll>();
        const analyzed: BundleCensus['analyzed'] = [];
        const opaque: BundleCensus['opaque'] = [];
        /**
         * Bundle PATH → that PE's imports and outgoing edges. Keyed by path, never by base
         * name: Quake2 ships thirteen different `gamex86.dll` (one per mod directory) with
         * different import sets, and a name-keyed map silently keeps only the last.
         */
        const perPe = new Map<string, {
            entry: ZipEntry; isEntry: boolean; refs: ImportRef[];
            deps: Set<string>; depPatterns: RegExp[]; isExe: boolean; name: string;
        }>();
        /** base name → every shipped path carrying it (a dep name can match several). */
        const byName = new Map<string, string[]>();

        for (const entry of candidates) {
            const isEntry = entry.name.replace(/\\/g, '/').toLowerCase() === entryLower;
            if (entry.uncompressedSize > opts.maxBytes) {
                opaque.push({ path: entry.name, reason: `larger than ${opts.maxBytes >> 20} MB` });
                continue;
            }
            let image: Uint8Array;
            try { image = await archive.readEntry(entry); }
            catch (e: any) { opaque.push({ path: entry.name, reason: `unreadable: ${e.message}` }); continue; }

            const headers = readPeHeaders(image);
            if (!headers) continue; // a .dll that isn't a PE (data blob with a misleading name)

            const packer = detectPacker(headers) ?? undefined;
            const imports = parsePeImports(image, headers);

            // A shipped DLL's own exports satisfy imports naming it — record before classifying.
            // Recorded even for a DLL we thunk: when our module cannot cover an import of
            // it, the PE loader abandons the HLE module and maps this file instead.
            if (headers.isDll || path.extname(entry.name).toLowerCase() !== '.exe') {
                const exp = parsePeExports(image, headers);
                shipped.set(baseNoExt(entry.name), {
                    names: new Set([...exp.names].map(n => n.toLowerCase())),
                    ordinals: new Set(exp.ordinals.keys()),
                });
            }

            const slotRvas = new Set<number>();
            for (const d of imports.dlls) for (const f of d.entries) slotRvas.add(f.iatRva);
            const callSites = countIatCallSites(image, headers, slotRvas);

            const peRefs: ImportRef[] = [];
            // Static imports are only half the dependency graph: an engine loads its
            // renderer/game module by name at runtime (Quake2's ref_gl.dll, gamex86.dll),
            // which appears nowhere in the import table but does appear as a literal
            // string in the image. Both kinds of edge feed the reachability walk.
            const mentions = mentionedModules(image);
            const deps = mentions.exact;
            for (const d of imports.dlls) {
                deps.add(baseNoExt(d.dll));
                for (const f of d.entries) {
                    if (!f.name && f.ordinal === undefined) continue;
                    peRefs.push({
                        dll: d.dll, name: f.name, ordinal: f.ordinal,
                        callSites: callSites.get(f.iatRva) ?? 0,
                        fromPe: entry.name, entrypoint: isEntry, delayLoad: d.delayLoad,
                    });
                }
            }
            const name = baseNoExt(entry.name);
            perPe.set(entry.name, {
                entry, isEntry, refs: peRefs, deps, depPatterns: mentions.patterns, name,
                isExe: path.extname(entry.name).toLowerCase() === '.exe',
            });
            (byName.get(name) ?? byName.set(name, []).get(name)!).push(entry.name);

            if (packer || imports.truncated) {
                opaque.push({
                    path: entry.name,
                    reason: packer ? `packed with ${packer} — real imports resolve at runtime`
                                   : 'import table truncated/unreadable',
                });
            }
            analyzed.push({
                path: entry.name, entrypoint: isEntry, imports: peRefs.length,
                packer,
                hiddenImports: importsLookHidden(imports) || undefined,
            });
        }

        // A shipped DLL we thunk is normally never mapped — our HLE module wins (PE loader
        // PRIORITY 1), which is how GOG's winmm proxy gets shadowed, so its own imports must
        // not be ranked. That only holds while our module covers every import made OF it: the
        // loader falls back to the real file otherwise, and then that file's imports are live.
        const shadowed = new Set<string>();
        for (const [, pe] of perPe) {
            if (pe.isEntry || !index.isThunked(pe.name) || shadowed.has(pe.name)) continue;
            // No coverage test for the always-HLE set: loadDll refuses these outright.
            if (index.isAlwaysHle(pe.name)) { shadowed.add(pe.name); continue; }
            const canonical = index.canonicalModule(pe.name);
            let fullyCovered = true;
            outer: for (const other of perPe.values()) {
                if (other === pe) continue;
                for (const r of other.refs) {
                    if (index.canonicalModule(r.dll) !== canonical) continue;
                    const cov = r.ordinal !== undefined
                        ? index.lookupOrdinal(r.dll, r.ordinal)
                        : index.lookup(r.dll, r.name ?? '');
                    if (!cov) { fullyCovered = false; break outer; }
                }
            }
            if (fullyCovered) shadowed.add(pe.name);
        }

        // Only count what the entrypoint can actually reach: a bundle routinely ships
        // unrelated tooling (a VB6 bot generator, a config utility) whose imports would
        // otherwise swamp the ranking with work the game never needs. Walk the shipped
        // import graph from the entrypoint; anything outside the closure is reported
        // separately rather than ranked.
        const reachable = new Set<string>();
        const depthOf = new Map<string, number>();
        const viaOf = new Map<string, string>();
        // Roots: the manifest entrypoint, plus every EXE when --all-exes is in force (which
        // is also how a packed launcher is handled — it can tell us nothing about the game
        // it starts, so each EXE becomes a root in its own right).
        let frontier = [...perPe.entries()]
            .filter(([, v]) => v.isEntry || (opts.allExes && v.isExe))
            .map(([k]) => k);
        if (frontier.length === 0) frontier = [...perPe.keys()]; // no manifest entrypoint: take everything
        for (const root of frontier) { reachable.add(root); depthOf.set(root, 0); }
        // Breadth-first so `depth`/`via` describe the SHORTEST load path, which is what a
        // human reads to answer "why is this DLL in the census at all?". An edge names a
        // module, not a file, and we cannot know which copy the search order would pick —
        // so every shipped copy of that name is reached.
        for (let d = 1; frontier.length; d++) {
            const next: string[] = [];
            const visit = (depName: string, from: string): void => {
                for (const p of byName.get(depName) ?? []) {
                    if (reachable.has(p)) continue;
                    reachable.add(p);
                    depthOf.set(p, d);
                    viaOf.set(p, from);
                    next.push(p);
                }
            };
            for (const cur of frontier) {
                const node = perPe.get(cur);
                if (!node) continue;
                for (const dep of node.deps) visit(dep, node.name);
                for (const rx of node.depPatterns) {
                    for (const name of byName.keys()) if (rx.test(name)) visit(name, node.name);
                }
            }
            frontier = next;
        }
        for (const [pePath, pe] of perPe) {
            if (shadowed.has(pe.name)) {
                opaque.push({ path: pePath, reason: 'shadowed by our HLE module — never mapped' });
            } else if (reachable.has(pePath)) {
                refs.push(...pe.refs);
            } else {
                opaque.push({ path: pePath, reason: 'not reachable from the entrypoint — imports not ranked' });
            }
        }
        for (const a of analyzed) {
            a.shadowed = shadowed.has(baseNoExt(a.path)) || undefined;
            a.unreachable = (!a.shadowed && !reachable.has(a.path)) || undefined;
            a.depth = depthOf.get(a.path);
            a.via = viaOf.get(a.path);
        }

        return buildCensus(path.basename(bundlePath), refs, index, shipped, {
            title: manifest.title ?? manifest.name, entrypoint, analyzed, opaque,
        });
    } finally {
        closeSync(fd);
    }
}

// ── text rendering ──────────────────────────────────────────────────────────

const BOLD = '\x1b[1m', DIM = '\x1b[2m', RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', OFF = '\x1b[0m';

function statusColor(status: string): string {
    if (status === 'silent-stub') return RED;   // the only class that actively misleads
    if (status === 'no-hle') return YEL;
    return '';
}

function renderEntry(e: BundleCensus['workOrder'][number]): string {
    const where = e.fromEntrypoint ? 'exe' : path.basename(e.importers[0] ?? '');
    const uses = e.callSites > 0 ? `${e.callSites} call site${e.callSites === 1 ? '' : 's'}` : 'no direct call site';
    const delay = e.delayLoadOnly ? ' [delay-load]' : '';
    const impl = e.impl ? ` ${DIM}(${e.impl.file}:${e.impl.line})${OFF}` : '';
    return `    ${statusColor(e.status)}${e.dll}:${e.name}${OFF}  ${DIM}${uses}, ${where}${delay}${OFF}${impl}`;
}

/**
 * The shipped-module load graph the census walked: which DLLs the entrypoint actually
 * pulls in, at what depth, and through whom. Answers "why is this DLL counted, and why is
 * that one not?" - and makes a broken chain obvious, since a packed launcher reaches
 * nothing at all.
 */
function renderTree(r: BundleCensus): string {
    const L: string[] = [];
    const reached = r.analyzed.filter(a => a.depth !== undefined);
    L.push('', `  ${BOLD}LOAD GRAPH${OFF} ${DIM}(${reached.length}/${r.analyzed.length} shipped PEs reachable)${OFF}`);

    const nameOf = (p: string): string => path.basename(p);
    const keyOf = (p: string): string => nameOf(p).replace(/\.[^.]*$/, '').toLowerCase();

    // Group same-named copies: Quake2 ships gamex86.dll thirteen times, one per mod dir,
    // and thirteen identical lines hide the shape of the graph rather than showing it.
    type Group = { name: string; depth: number; copies: typeof reached };
    const groups = new Map<string, Group>();
    for (const a of reached) {
        const k = `${a.via ?? ''}|${keyOf(a.path)}`;
        const g = groups.get(k) ?? { name: nameOf(a.path), depth: a.depth!, copies: [] };
        g.copies.push(a);
        groups.set(k, g);
    }

    const childrenOf = new Map<string, Group[]>();
    const roots: Group[] = [];
    for (const [k, g] of groups) {
        const via = k.split('|')[0];
        if (!via || g.depth === 0) roots.push(g);
        else (childrenOf.get(via) ?? childrenOf.set(via, []).get(via)!).push(g);
    }

    const emit = (g: Group, indent: string, last: boolean, isRoot: boolean): void => {
        const imports = g.copies.reduce((n, c) => n + c.imports, 0);
        const dup = g.copies.length > 1 ? ` ${DIM}\u00d7${g.copies.length}${OFF}` : '';
        const tag = g.copies[0].shadowed ? ` ${DIM}[shadowed by HLE]${OFF}` : '';
        L.push(`    ${indent}${isRoot ? '' : (last ? '\u2514\u2500 ' : '\u251c\u2500 ')}`
            + `${g.name}${dup}  ${DIM}${imports} imports${OFF}${tag}`);
        const kids = (childrenOf.get(keyOf(g.copies[0].path)) ?? [])
            .sort((a, b) => a.name.localeCompare(b.name));
        const nextIndent = isRoot ? indent : indent + (last ? '   ' : '\u2502  ');
        kids.forEach((k, i) => emit(k, nextIndent, i === kids.length - 1, false));
    };
    roots.sort((a, b) => a.name.localeCompare(b.name))
        .forEach(g => emit(g, '', true, true));

    const orphans = r.analyzed.filter(a => a.depth === undefined);
    if (orphans.length) {
        L.push(`    ${DIM}unreached (${orphans.length}): ${orphans.map(a => nameOf(a.path)).join(', ')}${OFF}`);
    }
    return L.join('\n');
}

function renderReport(r: BundleCensus, top: number, tree = false): string {
    const L: string[] = [];
    L.push('', `${BOLD}${r.bundle}${OFF}${r.title ? ` — ${r.title}` : ''}`);
    L.push(`  entrypoint: ${r.entrypoint ?? '(unknown)'}   PEs analyzed: ${r.analyzed.length}   distinct imports: ${r.totals.distinct}`);
    const t = r.totals;
    L.push(`  ${GRN}implemented ${t.implemented}${OFF}  guest-dll ${t['guest-dll']}  `
        + `unimplemented ${t.unimplemented}  ${YEL}no-hle ${t['no-hle']}${OFF}  `
        + `${RED}silent-stub ${t['silent-stub']}${OFF}  abi-gap ${t['abi-gap']}  `
        + `delay-gap ${t['delay-gap']}`);
    L.push(r.covered === null
        ? `  coverage: ${YEL}not scorable — the entrypoint hides its imports${OFF}`
        : `  coverage: ${r.covered}% of imports backed by a handler or a shipped DLL`
          + `   work score: ${r.workScore}`);
    if (r.expandedFromPackedEntrypoint) {
        L.push(`  ${DIM}entrypoint is packed; every EXE in the bundle was analyzed instead${OFF}`);
    }

    if (r.silentStubs.length) {
        L.push('', `  ${RED}${BOLD}SILENT STUBS (${r.silentStubs.length})${OFF} — a handler exists, returns success, does nothing:`);
        for (const e of r.silentStubs.slice(0, top)) L.push(renderEntry(e));
        if (r.silentStubs.length > top) L.push(`    ${DIM}… ${r.silentStubs.length - top} more${OFF}`);
    }

    if (r.abiGaps.length) {
        L.push('', `  ${BOLD}ABI GAPS (${r.abiGaps.length})${OFF} ${DIM}— no derivable stdcall cleanup. ADVISORY:`
            + ` titles that boot fine carry hundreds of these; not a boot predictor.${OFF}`);
        for (const e of r.abiGaps.slice(0, Math.min(top, 5))) L.push(renderEntry(e));
        if (r.abiGaps.length > 5) L.push(`    ${DIM}… ${r.abiGaps.length - 5} more${OFF}`);
    }

    const rest = r.workOrder.filter(e => e.status !== 'abi-gap' && e.status !== 'silent-stub');
    if (rest.length) {
        L.push('', `  ${BOLD}WORK ORDER (${rest.length})${OFF} — ranked by use (call sites × entrypoint weight):`);
        for (const e of rest.slice(0, top)) L.push(renderEntry(e));
        if (rest.length > top) L.push(`    ${DIM}… ${rest.length - top} more${OFF}`);
    }
    if (r.byDll.length) {
        L.push('', `  ${BOLD}BY DLL${OFF}`);
        for (const d of r.byDll.slice(0, top)) {
            const tag = d.status === 'no-hle' ? `${YEL}no HLE module${OFF}` : 'partial';
            L.push(`    ${d.dll.padEnd(14)} ${String(d.missing).padStart(3)} missing  [${tag}]  ${DIM}${d.top.join(', ')}${OFF}`);
        }
    }
    if (tree) L.push(renderTree(r));
    if (r.opaque.length) {
        L.push('', `  ${DIM}not statically readable:${OFF}`);
        for (const o of r.opaque) L.push(`    ${o.path} — ${o.reason}`);
    }
    if (r.workOrder.length === 0 && r.opaque.length === 0) {
        L.push('', `  ${GRN}every import is backed by a real handler or a shipped DLL${OFF}`);
    }
    return L.join('\n');
}

function renderQueue(reports: BundleCensus[]): string {
    const L: string[] = [];
    L.push('', `${BOLD}${'bundle'.padEnd(40)}  work  cover  imports  silent  no-hle  unimpl  abi  delay   next up${OFF}`);
    L.push('─'.repeat(120));
    for (const r of rankQueue(reports)) {
        const next = r.byDll.slice(0, 3).map(d => d.dll).join(', ') || '—';
        const silent = r.totals['silent-stub'];
        L.push(
            `${r.bundle.slice(0, 39).padEnd(40)}  `
            + `${String(r.workScore).padStart(4)}  `
            + `${(r.covered === null ? 'n/a' : `${r.covered}%`).padStart(5)}  `
            + `${String(r.totals.distinct).padStart(7)}  `
            + `${(silent ? `${RED}${String(silent).padStart(6)}${OFF}` : '     0')}  `
            + `${String(r.totals['no-hle']).padStart(6)}  `
            + `${String(r.totals.unimplemented).padStart(6)}  `
            + `${String(r.totals['abi-gap']).padStart(3)}  `
            + `${String(r.totals['delay-gap']).padStart(5)}   `
            + `${DIM}${next}${OFF}`);
    }
    L.push('', `${DIM}work = call-site-weighted missing API surface (the ranking key). `
        + `cover = imports backed by a handler or a shipped DLL; n/a = packed entrypoint.${OFF}`);
    L.push(`${DIM}NOT a boot predictor: max-payne runs with 57 unimplemented, and 12 of 37 known-working `
        + `titles carry abi-gaps. Ranks remaining work, not distance to booting.${OFF}`);
    return L.join('\n');
}

async function main(): Promise<void> {
    const { targets, opts } = parseArgs(process.argv.slice(2));
    if (targets.length === 0) { printUsage(); process.exit(2); }

    const repoRoot = path.resolve(import.meta.dir, '..');
    const index = ApiCoverageIndex.load(repoRoot);

    const bundles = expandTargets(targets);
    const reports: BundleCensus[] = [];
    for (const b of bundles) {
        try {
            let report = await censusBundle(b, index, opts);
            // A packed launcher tells us nothing about the game it starts; widen to every
            // EXE in the bundle so the census still has something real to say.
            if (report.entrypointOpaque && !opts.allExes) {
                report = await censusBundle(b, index, { ...opts, allExes: true });
                report.expandedFromPackedEntrypoint = true;
            }
            reports.push(report);
        } catch (e: any) {
            console.error(`${RED}${path.basename(b)}: ${e.message}${OFF}`);
        }
    }

    if (opts.json || opts.out) {
        const payload = JSON.stringify(reports.length === 1 && !opts.queue ? reports[0] : reports, null, 2);
        if (opts.out) { writeFileSync(opts.out, payload); console.error(`wrote ${opts.out}`); }
        else console.log(payload);
        if (!opts.out) return;
    }

    if (opts.queue) console.log(renderQueue(reports));
    else for (const r of reports) console.log(renderReport(r, opts.top, opts.tree));
}

main();
