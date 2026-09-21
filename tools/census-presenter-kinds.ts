#!/usr/bin/env bun

/**
 * Presenter-kind census over the `.wgb` library — census B of the render-worker plan
 * (`docs/performance/render-worker-plan-2026-09-11.md` §8.0 / §4).
 *
 * The question: stage 1 moves the D3D9 executor + composite off the guest thread and
 * REFUSES LOUDLY for every other executor (ddraw/D3D7, D3D8, glide, opengl). How many
 * titles in the library does that refuse? Answered statically, without booting anything.
 *
 * The runtime oracle is `report().render.presenter` (`RenderService.notifyPresent`), and
 * this tool cannot be it: presenter kind is per PRESENT, and the only honest question a
 * static pass can answer is "which graphics creation entry points will this bundle reach".
 * So every verdict here carries its evidence (the PE and the symbol that produced it) and
 * a confidence, and "I could not tell" is a printed outcome — never a bucket that
 * silently absorbs the bundles the rules missed.
 *
 * Detection tiers, in precedence order:
 *   R1 import: the CREATION symbol in an import table (Direct3DCreate9, DirectDrawCreate,
 *      grSstWinOpen, wglCreateContext, ...). The imported DLL NAME never decides — 44 of
 *      69 bundles name ddraw.dll and most never create a DirectDraw object.
 *   R2 effective module: a shipped copy of an HLE-owned DLL never executes unless
 *      `manifest.emulator.appDirDlls` names it (`src/worker/core/pe-loader.ts`
 *      HLE_ONLY_DLLS), so a signal inside a shipped ddraw.dll/glide2x.dll wrapper is DEAD
 *      by default — which is what keeps glide→D3D9 and ddraw→D3D9 wrappers from reading as
 *      D3D9 titles. When appDirDlls DOES name it, the wrapper runs and its own creation
 *      symbol is the effective one (gta3-ru's d3d8to9). `disabledDlls` drops candidates.
 *   R3 string: renderer DLL literals scanned in BOTH latin1 and utf16le (Unreal-1's
 *      D3DDrv.dll carries "ddraw" only as UTF-16). A candidate, never a verdict.
 *
 * Usage:
 *   bun tools/census-presenter-kinds.ts <bundle.wgb|dir> [...]   text report
 *   bun tools/census-presenter-kinds.ts <dir> --json             machine-readable
 *   bun tools/census-presenter-kinds.ts --selftest               bypass fixtures (F4)
 *   bun tools/census-presenter-kinds.ts <dir> --verify <doc.md>  static vs Observed (F3)
 *
 * Flags:
 *   --json           emit JSON instead of the tables
 *   --max-mb N       skip PEs larger than N MB (default 64)
 *   --no-strings     import tier only (faster; more UNKNOWN)
 *   --out FILE       write JSON to FILE
 *   --verify FILE    cross-check against the Observed column of a census-B markdown doc
 *   --selftest       build synthetic bundles and assert the R2 flip, then exit
 */

import { closeSync, openSync, readSync, fstatSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { ZipArchive, inflateRawSync, type ZipSource, type ZipEntry } from '@bottleship/formats/zip';
import { readPeHeaders, parsePeImports, detectPacker } from '@bottleship/formats/pe';
import { resolveThunkedDllAlias, normalizeDllBaseName } from '../src/worker/core/dll-aliases';
import { findDllRule } from '../src/worker/core/dll-rules';
import { ZipStoreWriter } from './internal/zip-store-writer';

const REPO = path.resolve(import.meta.dir, '..');

const PE_EXTENSIONS = new Set(['.exe', '.dll', '.ocx', '.ax', '.drv', '.flt', '.asi', '.dle', '.u']);

export type GraphicsKind = 'd3d9' | 'd3d8' | 'ddraw' | 'glide' | 'opengl';
type Tier = 'import' | 'string';

/** Stage 1 carries d3d9 only; everything else presents through an executor that stays put. */
const REFUSED_KINDS = new Set<GraphicsKind>(['ddraw', 'glide', 'opengl']);

/**
 * Creation entry points, lowercased. Only a call that CREATES a device/context counts —
 * DirectDrawEnumerate is an enumeration a D3D9 title legitimately makes, and treating it
 * as a presenter refuses titles stage 1 would happily carry.
 */
const CREATION_SYMBOLS = new Map<string, GraphicsKind>([
    ['direct3dcreate9', 'd3d9'],
    ['direct3dcreate9ex', 'd3d9'],
    ['direct3dcreate8', 'd3d8'],
    ['directdrawcreate', 'ddraw'],
    ['directdrawcreateex', 'ddraw'],
    ['directdrawcreateclipper', 'ddraw'],
    ['grsstwinopen', 'glide'],
    ['grsstwinopenext', 'glide'],
    ['grglideinit', 'glide'],
    ['wglcreatecontext', 'opengl'],
]);

/** Not a presenter: enumeration/capability probes that name a graphics DLL. */
const NON_CREATION_SYMBOLS = /^(directdrawenumerate|direct3dcreate$|d3d8getswapchain|wglgetprocaddress|wglgetcurrentcontext)/;

/** R3 literals → the kind they hint at. A hint only ever widens the candidate set. */
const MODULE_HINTS: Array<[RegExp, GraphicsKind]> = [
    [/^d3d9$/, 'd3d9'],
    [/^d3d8$/, 'd3d8'],
    [/^ddraw$/, 'ddraw'],
    [/^(glide2x|glide3x|glide)$/, 'glide'],
    [/^opengl32$/, 'opengl'],
];

export interface Signal {
    pe: string;
    tier: Tier;
    kind: GraphicsKind;
    /** The symbol (import tier) or literal (string tier) that produced this record. */
    symbol: string;
    /** The import descriptor's DLL name, as written. */
    dll: string;
    /** False when the host PE is an HLE-owned DLL the manifest does not app-dir-override. */
    runs: boolean;
    /** Set when this record's target DLL is itself an app-dir wrapper that translates. */
    wrappedBy?: string;
    reason?: string;
}

export type Verdict = 'CARRIED' | 'REFUSED' | 'UNCERTAIN' | 'UNKNOWN' | 'ERROR';

export interface BundleCensus {
    bundle: string;
    file: string;
    bytes: number;
    verdict: Verdict;
    /** Effective presenter kinds: import-tier, runs=true, not wrapped away. */
    kinds: GraphicsKind[];
    /** String-tier candidates — a superset that cannot decide anything on its own. */
    candidates: GraphicsKind[];
    confidence: 'certain' | 'candidate' | 'none';
    note: string;
    appDirDlls: string[];
    disabledDlls: string[];
    peCount: number;
    signals: Signal[];
    error?: string;
    ms: number;
}

// ---------------------------------------------------------------------------
// HLE_ONLY_DLLS — read from the runtime source, never hand-copied
// ---------------------------------------------------------------------------

/**
 * The set lives as a private const in the PE loader, and a copy here would drift silently
 * and invert exactly the wrapper verdicts this census exists to get right. Parsing it out
 * of the source keeps one definition; a shape change fails loudly instead of quietly
 * falling back to a stale list.
 */
function parseHleOnlyDlls(src: string, where: string): Set<string> {
    const m = /const HLE_ONLY_DLLS\s*=\s*new Set<string>\(\[([^\]]*)\]\)/.exec(src);
    if (!m) {
        throw new Error(
            `HLE_ONLY_DLLS not found in ${where}. The census cannot decide whether a shipped ` +
            `ddraw/glide wrapper executes without it; refusing to guess.`,
        );
    }
    const names = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => (x[1] ?? x[2]).toLowerCase());
    if (names.length < 8) {
        throw new Error(`HLE_ONLY_DLLS in ${where} parsed as ${names.length} names — shape changed, refusing to guess.`);
    }
    for (const required of ['ddraw', 'd3d8', 'd3d9', 'glide2x', 'opengl32']) {
        if (!names.includes(required)) {
            throw new Error(
                `HLE_ONLY_DLLS in ${where} no longer lists "${required}" — every wrapper verdict ` +
                `would flip; refusing to guess.`,
            );
        }
    }
    return new Set(names);
}

function loadHleOnlyDlls(): Set<string> {
    const file = path.join(REPO, 'src', 'worker', 'core', 'pe-loader.ts');
    return parseHleOnlyDlls(readFileSync(file, 'utf8'), file);
}

// ---------------------------------------------------------------------------
// Container access
// ---------------------------------------------------------------------------

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

const LFH_SIGNATURE = 0x04034b50;

/**
 * Read one member. A `.wgb` is store-only, but the manifest of a hand-packed bundle can be
 * DEFLATED, and `ZipArchive.readEntry` inflates through `DecompressionStream` — which Bun
 * does not provide. Falling back to the package's own synchronous inflater keeps a
 * compressed member from being reported as an unreadable bundle, which is a false ERROR.
 */
async function readMember(archive: ZipArchive, source: FdSource, entry: ZipEntry): Promise<Uint8Array> {
    if (entry.compression === 0) return archive.readEntry(entry);
    if (entry.compression !== 8) throw new Error(`unsupported compression ${entry.compression}`);

    const lfh = source.readRangeSync(entry.localHeaderOffset, entry.localHeaderOffset + 30);
    const view = new DataView(lfh.buffer, lfh.byteOffset, lfh.byteLength);
    if (lfh.length < 30 || view.getUint32(0, true) !== LFH_SIGNATURE) {
        throw new Error(`local header not at ${entry.localHeaderOffset} (SFX prefix or corruption)`);
    }
    const dataStart = entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const src = source.readRangeSync(dataStart, dataStart + entry.compressedSize);
    const out = new Uint8Array(entry.uncompressedSize);
    const res = inflateRawSync(src, out);
    if (res.status !== 'ok' || res.written !== out.length) {
        throw new Error(`inflate failed for ${entry.name}: ${res.status} (${res.written}/${out.length})`);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const LATIN1 = new TextDecoder('latin1');
const UTF16 = new TextDecoder('utf-16le');
// Case-insensitive: SeriousEngine stores its renderer list as "OPENGL32.DLL", and a
// case-sensitive scan reported that bundle as having no renderer literal at all.
const DLL_MENTION = /([A-Za-z0-9_.\-]{2,32})\.dll/gi;

function baseNoExt(p: string): string {
    return path.basename(p.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').toLowerCase();
}

/**
 * Renderer modules named as literals — the LoadLibrary edges an import table cannot show.
 * Scanned in both encodings because an engine that stores its module list as wide strings
 * (Unreal 1) is otherwise reported as having no graphics signal at all.
 */
function mentionedKinds(image: Uint8Array): Map<GraphicsKind, string> {
    const found = new Map<GraphicsKind, string>();
    const texts = [LATIN1.decode(image), UTF16.decode(image)];
    for (const text of texts) {
        for (const m of text.matchAll(DLL_MENTION)) {
            const base = normalizeDllBaseName(m[1]);
            for (const [rx, kind] of MODULE_HINTS) {
                if (rx.test(base) && !found.has(kind)) found.set(kind, m[0]);
            }
        }
    }
    return found;
}

interface Manifest {
    entrypoint?: string;
    emulator?: { appDirDlls?: string[]; disabledDlls?: string[] };
    name?: string;
}

async function censusBundle(file: string, hleOnly: Set<string>, opts: Options): Promise<BundleCensus> {
    const started = performance.now();
    const row: BundleCensus = {
        bundle: baseNoExt(file), file, bytes: 0, verdict: 'ERROR', kinds: [], candidates: [],
        confidence: 'none', note: '', appDirDlls: [], disabledDlls: [], peCount: 0, signals: [], ms: 0,
    };
    let fd = -1;
    try {
        row.bytes = statSync(file).size;
        fd = openSync(file, 'r');
        const source = new FdSource(fd);
        const archive = new ZipArchive(source);
        await archive.init();

        const manifestEntry = archive.getEntry('manifest.json');
        if (!manifestEntry) throw new Error('no manifest.json in the bundle');
        let manifest: Manifest;
        try {
            manifest = JSON.parse(new TextDecoder().decode(await readMember(archive, source, manifestEntry)));
        } catch (e: any) {
            throw new Error(`manifest.json unreadable: ${e.message}`);
        }
        const appDirDlls = manifest.emulator?.appDirDlls ?? [];
        const disabledDlls = manifest.emulator?.disabledDlls ?? [];
        row.appDirDlls = appDirDlls;
        row.disabledDlls = disabledDlls;

        const candidates = archive.listEntries().filter((e: ZipEntry) =>
            !e.isDirectory && PE_EXTENSIONS.has(path.extname(e.name).toLowerCase()));
        if (candidates.length === 0) throw new Error('bundle contains no PE-shaped entries');

        /** Shipped app-dir DLLs that themselves create a device — the wrapper case. */
        const wrapperKinds = new Map<string, { kind: GraphicsKind; pe: string }>();
        const pending: Array<{ entry: ZipEntry; image: Uint8Array }> = [];
        let parsed = 0;
        const opaque: string[] = [];

        for (const entry of candidates) {
            if (entry.uncompressedSize > opts.maxBytes) {
                opaque.push(`${entry.name}: larger than ${opts.maxBytes >> 20} MB`);
                continue;
            }
            let image: Uint8Array;
            try { image = await readMember(archive, source, entry); }
            catch (e: any) { opaque.push(`${entry.name}: unreadable (${e.message})`); continue; }
            const headers = readPeHeaders(image);
            if (!headers) continue; // a data blob with a misleading extension
            if (headers.is64) {
                // A PE32+ image cannot execute in the 32-bit guest, so a creation call inside
                // one is not an entry point any session reaches (Visionaire ships a 64-bit
                // config tool whose ANGLE copy imports Direct3DCreate9).
                opaque.push(`${entry.name}: 64-bit image, unreachable in a 32-bit guest`);
                continue;
            }
            parsed++;
            const packer = detectPacker(headers);
            if (packer) opaque.push(`${entry.name}: packed with ${packer}`);

            const base = baseNoExt(entry.name);
            if (findDllRule(disabledDlls, entry.name) || findDllRule(disabledDlls, base)) {
                opaque.push(`${entry.name}: disabled by manifest disabledDlls`);
                continue;
            }
            const isHleOwned = hleOnly.has(resolveThunkedDllAlias(base));
            const appDirRule = findDllRule(appDirDlls, entry.name) ?? findDllRule(appDirDlls, base);
            const runs = !isHleOwned || appDirRule !== null;

            let imports;
            try { imports = parsePeImports(image, headers); }
            catch (e: any) { opaque.push(`${entry.name}: bad import table (${e.message})`); continue; }

            for (const d of imports.dlls) {
                for (const f of d.entries) {
                    const name = (f.name ?? '').toLowerCase();
                    if (!name || NON_CREATION_SYMBOLS.test(name)) continue;
                    const kind = CREATION_SYMBOLS.get(name);
                    if (!kind) continue;
                    row.signals.push({
                        pe: entry.name, tier: 'import', kind, symbol: f.name!, dll: d.dll, runs,
                        reason: runs
                            ? (appDirRule ? `app-dir override "${appDirRule}" makes this shipped DLL run` : undefined)
                            : 'shipped copy of an HLE-owned DLL; never executes without appDirDlls',
                    });
                    if (runs && isHleOwned && appDirRule) {
                        wrapperKinds.set(resolveThunkedDllAlias(base), { kind, pe: entry.name });
                    }
                }
            }
            if (opts.strings) pending.push({ entry, image });
        }

        row.peCount = parsed;
        if (parsed === 0) throw new Error(`no PE parsed out of ${candidates.length} PE-named entries`);

        // R2 second pass: an import of a DLL that an app-dir wrapper has taken over is not
        // the effective kind — the wrapper's own creation call is (gta3-ru's d3d8to9).
        for (const s of row.signals) {
            const target = resolveThunkedDllAlias(s.dll);
            const wrapper = wrapperKinds.get(target);
            if (wrapper && wrapper.pe !== s.pe && wrapper.kind !== s.kind) {
                s.wrappedBy = wrapper.pe;
                s.reason = `${s.dll} is app-dir-overridden by ${wrapper.pe}, which creates ${wrapper.kind}`;
            }
        }

        const effective = row.signals.filter(s => s.tier === 'import' && s.runs && !s.wrappedBy);
        row.kinds = [...new Set(effective.map(s => s.kind))].sort();

        // R3 runs only where the import tier decided nothing: a string hit is noise on a
        // bundle whose creation call is already known, and costly over a whole library.
        if (opts.strings && row.kinds.length === 0) {
            for (const { entry, image } of pending) {
                for (const [kind, literal] of mentionedKinds(image)) {
                    row.signals.push({
                        pe: entry.name, tier: 'string', kind, symbol: literal, dll: literal, runs: true,
                        reason: 'literal only — LoadLibrary candidate, not a creation call',
                    });
                }
            }
            row.candidates = [...new Set(row.signals.filter(s => s.tier === 'string').map(s => s.kind))].sort();
        }

        classify(row, opaque);
        return row;
    } catch (e: any) {
        row.verdict = 'ERROR';
        row.error = e?.message ?? String(e);
        row.note = `ERROR: ${row.error}`;
        return row;
    } finally {
        if (fd >= 0) closeSync(fd);
        row.ms = Math.round(performance.now() - started);
    }
}

/**
 * Verdict is a reduction over the evidence records and must keep them: a non-UNKNOWN
 * verdict with nothing behind it is an internal error, not an empty set.
 */
function classify(row: BundleCensus, opaque: string[]): void {
    const kinds = new Set(row.kinds);
    const refused = [...kinds].filter(k => REFUSED_KINDS.has(k));
    const opaqueNote = opaque.length ? ` (${opaque.length} opaque PE(s): ${opaque[0]})` : '';

    if (kinds.size === 0) {
        if (row.candidates.length === 0) {
            row.verdict = 'UNKNOWN';
            row.confidence = 'none';
            row.note = `no creation symbol and no renderer literal in ${row.peCount} PE(s)` + opaqueNote;
            return;
        }
        row.verdict = 'UNCERTAIN';
        row.confidence = 'candidate';
        row.note = `renderer loaded dynamically; string-tier candidates: ${row.candidates.join('+')}` + opaqueNote;
    } else if (kinds.size === 1 && kinds.has('d3d9')) {
        row.verdict = 'CARRIED';
        row.confidence = 'certain';
        row.note = 'd3d9 only' + opaqueNote;
    } else if (kinds.size === 1 && kinds.has('d3d8')) {
        row.verdict = 'UNCERTAIN';
        row.confidence = 'certain';
        row.note = 'd3d8: FFP draws go to the ddraw executor, shader draws to a private D3D9 executor, ' +
            'and it presents as "d3d8" — carried only if the title is wholly programmable; a boot decides' + opaqueNote;
    } else if (refused.length > 0 && !kinds.has('d3d9')) {
        row.verdict = 'REFUSED';
        row.confidence = 'certain';
        row.note = `${refused.join('+')} executor stays on the guest thread` + opaqueNote;
    } else {
        row.verdict = 'UNCERTAIN';
        row.confidence = 'certain';
        row.note = `mixed creation calls (${row.kinds.join('+')}); which one presents is a runtime fact` + opaqueNote;
    }

    if (row.verdict !== 'UNKNOWN' && row.signals.length === 0) {
        throw new Error(`internal: ${row.bundle} got verdict ${row.verdict} with no evidence records`);
    }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const VERDICT_ORDER: Verdict[] = ['CARRIED', 'UNCERTAIN', 'REFUSED', 'UNKNOWN', 'ERROR'];

function report(rows: BundleCensus[]): void {
    const counts = new Map<Verdict, number>(VERDICT_ORDER.map(v => [v, 0]));
    for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

    const w = Math.max(20, ...rows.map(r => r.bundle.length));
    console.log('');
    console.log(`${'BUNDLE'.padEnd(w)}  ${'VERDICT'.padEnd(9)}  ${'KINDS'.padEnd(16)}  EVIDENCE`);
    console.log('-'.repeat(w + 2 + 9 + 2 + 16 + 2 + 40));
    for (const r of [...rows].sort((a, b) =>
        VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || a.bundle.localeCompare(b.bundle))) {
        const kinds = r.kinds.length ? r.kinds.join('+') : (r.candidates.length ? `?${r.candidates.join('+')}` : '-');
        const lead = r.signals.find(s => s.tier === 'import' && s.runs && !s.wrappedBy)
            ?? r.signals.find(s => s.tier === 'import' && s.runs)
            ?? r.signals[0];
        const ev = r.error ? r.error : (lead ? `${path.basename(lead.pe)} → ${lead.symbol}` : 'none');
        console.log(`${r.bundle.padEnd(w)}  ${r.verdict.padEnd(9)}  ${kinds.padEnd(16)}  ${ev}`);
    }

    console.log('');
    console.log('SUMMARY');
    for (const v of VERDICT_ORDER) console.log(`  ${v.padEnd(10)} ${String(counts.get(v) ?? 0).padStart(4)}`);
    console.log(`  ${'TOTAL'.padEnd(10)} ${String(rows.length).padStart(4)}`);

    console.log('');
    console.log('DETAIL');
    for (const r of rows) {
        console.log(`\n  ${r.bundle}  [${r.verdict}]  ${r.note}`);
        if (r.appDirDlls.length) console.log(`    appDirDlls: ${r.appDirDlls.join(', ')}`);
        if (r.disabledDlls.length) console.log(`    disabledDlls: ${r.disabledDlls.join(', ')}`);
        for (const s of r.signals.slice(0, 24)) {
            const flags = [s.runs ? 'runs' : 'DEAD', s.wrappedBy ? `wrapped-by ${path.basename(s.wrappedBy)}` : null]
                .filter(Boolean).join(', ');
            console.log(`    ${s.tier.padEnd(6)} ${s.kind.padEnd(6)} ${s.pe} → ${s.symbol}  [${flags}]${s.reason ? ` — ${s.reason}` : ''}`);
        }
        if (r.signals.length > 24) console.log(`    ... ${r.signals.length - 24} more records`);
    }
}

// ---------------------------------------------------------------------------
// F3 — cross-check the static verdict against a doc's Observed column
// ---------------------------------------------------------------------------

export interface VerifyResult {
    /** Rows whose static verdict and Observed set could actually contradict each other. */
    checked: number;
    failed: number;
    /** Filled cells the oracle could not read — counted as failures, never as agreement. */
    unreadable: number;
    /** Filled cells that no pair of values could have contradicted. */
    uncheckable: number;
    /** Observed cells naming a bundle this scan did not cover. */
    unmatched: number;
}

const OBSERVED_TOKENS = new Set(['d3d9', 'd3d8', 'ddraw', 'glide', 'opengl', 'gdi', 'video']);

/**
 * The doc's Observed cell holds the kind SET a real boot recorded
 * (`report().render.presenter` over a session). A static verdict that contradicts it is a
 * rule bug, and this is the only mechanism that can catch one — so it exits non-zero.
 * `gdi` and `video` are composite presents every D3D9 title also produces and are ignored.
 *
 * Every filled cell must leave a trace in one of the counters. A cell that is silently
 * dropped — wrong spelling, a bundle outside the scan, an observation that this static
 * verdict cannot contradict — turns "0 contradictions" into a statement about nothing.
 */
function verifyAgainstDoc(rows: BundleCensus[], doc: string): VerifyResult {
    const text = readFileSync(doc, 'utf8');
    const byBundle = new Map(rows.map(r => [r.bundle, r]));
    const res: VerifyResult = { checked: 0, failed: 0, unreadable: 0, uncheckable: 0, unmatched: 0 };
    /**
     * The column is found by its HEADER, never by cell shape: the Kinds column holds the
     * same vocabulary as Observed, so a shape match reads the static verdict back to itself
     * and every planted contradiction passes. The header is scoped to its own table, so a
     * later table's cells cannot be read through a stale column index.
     */
    let bundleCol = -1, observedCol = -1;
    for (const line of text.split('\n')) {
        if (!line.startsWith('|')) { bundleCol = observedCol = -1; continue; }
        const cells = line.split('|').map(c => c.trim());
        const header = cells.findIndex(c => /^observed$/i.test(c));
        if (header >= 0) {
            observedCol = header;
            bundleCol = cells.findIndex(c => /^bundle$/i.test(c));
            if (bundleCol < 0) throw new Error(`${doc}: a table has an Observed column but no Bundle column`);
            continue;
        }
        if (observedCol < 0 || cells.length <= observedCol) continue;
        const bundle = cells[bundleCol].replace(/[`*]/g, '').trim();
        const raw = cells[observedCol].replace(/[`*]/g, '').trim();
        if (!bundle || /^-{2,}$/.test(bundle)) continue;            // the header separator row
        if (raw === '' || raw === '—' || raw === '-') continue; // deliberately not filled in
        const row = byBundle.get(bundle);
        if (!row) {
            res.unmatched++;
            console.error(`VERIFY UNMATCHED  ${bundle}: Observed cell "${raw}" names a bundle this scan did not cover`);
            continue;
        }
        const tokens = raw.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
        if (!tokens.length || tokens.some(t => !OBSERVED_TOKENS.has(t))) {
            res.unreadable++;
            res.failed++;
            console.error(`VERIFY UNREADABLE  ${bundle}: Observed cell "${raw}" is not a presenter-kind set; ` +
                `an observation the oracle cannot read is not an observation that agrees`);
            continue;
        }
        const observed = tokens.filter(k => k !== 'gdi' && k !== 'video') as GraphicsKind[];
        if (observed.length === 0 || (row.verdict !== 'CARRIED' && row.verdict !== 'REFUSED')) {
            res.uncheckable++;
            console.log(`VERIFY UNCHECKABLE  ${bundle}: static ${row.verdict} vs observed ${tokens.join('+')} — ` +
                `no pair of these values contradicts`);
            continue;
        }
        res.checked++;
        const contradicts = row.verdict === 'CARRIED'
            ? observed.some(k => k !== 'd3d9')
            : observed.includes('d3d9') && !observed.some(k => REFUSED_KINDS.has(k));
        if (contradicts) {
            res.failed++;
            console.error(`VERIFY FAIL  ${bundle}: static ${row.verdict} (${row.kinds.join('+') || '-'}) ` +
                `contradicts observed ${observed.join('+')}`);
        }
    }
    console.log(`\nVERIFY: ${res.checked} checked, ${res.failed} contradiction(s); ` +
        `${res.uncheckable} uncheckable, ${res.unreadable} unreadable, ${res.unmatched} unmatched.`);
    return res;
}

// ---------------------------------------------------------------------------
// F4 — bypass fixtures: the R2 rule's own test
// ---------------------------------------------------------------------------

function buildPe(isDll: boolean, imports: Array<{ dll: string; funcs: string[] }>, literals: string[] = []): Buffer {
    const SEC_RVA = 0x1000, SEC_SIZE = 0x1000;
    const img = Buffer.alloc(SEC_RVA + SEC_SIZE);
    img.write('MZ', 0, 'latin1');
    img.writeUInt32LE(0x40, 0x3c);
    const pe = 0x40;
    img.write('PE\0\0', pe, 'latin1');
    img.writeUInt16LE(0x014c, pe + 4);          // i386
    img.writeUInt16LE(1, pe + 6);               // sections
    img.writeUInt16LE(224, pe + 20);            // optional header size
    img.writeUInt16LE(isDll ? 0x2102 : 0x0102, pe + 22);
    const opt = pe + 24;
    img.writeUInt16LE(0x010b, opt);             // PE32
    img.writeUInt32LE(SEC_RVA, opt + 16);       // entry point
    img.writeUInt32LE(0x400000, opt + 28);      // image base
    img.writeUInt32LE(SEC_RVA + SEC_SIZE, opt + 56);
    img.writeUInt16LE(2, opt + 68);             // GUI
    img.writeUInt32LE(16, opt + 92);            // number of data directories

    // Section table: RVA == file offset keeps rvaToFileOffset an identity here.
    const sec = opt + 224;
    img.write('.text\0\0\0', sec, 'latin1');
    img.writeUInt32LE(SEC_SIZE, sec + 8);
    img.writeUInt32LE(SEC_RVA, sec + 12);
    img.writeUInt32LE(SEC_SIZE, sec + 16);
    img.writeUInt32LE(SEC_RVA, sec + 20);
    img.writeUInt32LE(0x60000020, sec + 36);

    const descBytes = (imports.length + 1) * 20;
    let cursor = SEC_RVA + descBytes;
    const alloc = (n: number): number => { const at = cursor; cursor += n; return at; };

    imports.forEach((imp, i) => {
        const thunkRva = alloc((imp.funcs.length + 1) * 4);
        const nameRvas = imp.funcs.map(f => {
            const at = alloc(2 + f.length + 1);
            img.writeUInt16LE(0, at);
            img.write(f, at + 2, 'latin1');
            return at;
        });
        const dllRva = alloc(imp.dll.length + 1);
        img.write(imp.dll, dllRva, 'latin1');
        nameRvas.forEach((rva, j) => img.writeUInt32LE(rva, thunkRva + j * 4));
        const d = SEC_RVA + i * 20;
        img.writeUInt32LE(thunkRva, d);          // OriginalFirstThunk
        img.writeUInt32LE(dllRva, d + 12);       // Name
        img.writeUInt32LE(thunkRva, d + 16);     // FirstThunk
    });

    for (const lit of literals) {
        const at = alloc(lit.length + 1);
        img.write(lit, at, 'latin1');
    }

    img.writeUInt32LE(SEC_RVA, opt + 96 + 1 * 8);  // IMAGE_DIRECTORY_ENTRY_IMPORT
    img.writeUInt32LE(descBytes, opt + 96 + 1 * 8 + 4);
    return img;
}

function writeFixture(out: string, manifest: unknown, files: Array<[string, Buffer]>): void {
    const w = new ZipStoreWriter(out);
    w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    for (const [name, data] of files) w.addBuffer(name, data);
    w.finish();
}

async function selftest(hleOnly: Set<string>, opts: Options): Promise<number> {
    const dir = path.join(process.env.TEMP ?? '/tmp', `census-presenter-selftest-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let failures = 0;
    const check = (label: string, ok: boolean, got: string): void => {
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got})`);
        if (!ok) failures++;
    };

    const exe = buildPe(false, [{ dll: 'd3d9.dll', funcs: ['Direct3DCreate9'] }]);
    const wrapper = buildPe(true, [{ dll: 'DDRAW.dll', funcs: ['DirectDrawCreateEx'] }]);
    const base = { formatVersion: 2, name: 'fixture', entrypoint: 'rom/game.exe', rom: 'rom' };

    // F4a: bare D3D9 importer → CARRIED.
    const bare = path.join(dir, 'bare-d3d9.wgb');
    writeFixture(bare, base, [['rom/game.exe', exe]]);
    let r = await censusBundle(bare, hleOnly, opts);
    check('bare Direct3DCreate9 importer is CARRIED', r.verdict === 'CARRIED', `${r.verdict} ${r.kinds.join('+')}`);

    // F4b: same exe plus a shipped ddraw wrapper that the manifest does NOT app-dir-override.
    // The wrapper never executes, so its DirectDrawCreateEx must not move the verdict.
    const dead = path.join(dir, 'dead-wrapper.wgb');
    writeFixture(dead, base, [['rom/game.exe', exe], ['rom/ddraw.dll', wrapper]]);
    r = await censusBundle(dead, hleOnly, opts);
    check('shipped ddraw wrapper without appDirDlls stays DEAD', r.verdict === 'CARRIED', `${r.verdict} ${r.kinds.join('+')}`);
    check('...and the dead record is still reported as evidence',
        r.signals.some(s => s.kind === 'ddraw' && !s.runs), `${r.signals.filter(s => !s.runs).length} dead record(s)`);

    // F4c: the same bundle with appDirDlls ["ddraw"] — the wrapper runs, so the bundle
    // reaches the ddraw executor and the verdict must flip away from CARRIED.
    const live = path.join(dir, 'live-wrapper.wgb');
    writeFixture(live, { ...base, emulator: { appDirDlls: ['ddraw'] } },
        [['rom/game.exe', exe], ['rom/ddraw.dll', wrapper]]);
    r = await censusBundle(live, hleOnly, opts);
    check('appDirDlls ["ddraw"] flips the verdict off CARRIED',
        r.verdict !== 'CARRIED' && r.kinds.includes('ddraw'), `${r.verdict} ${r.kinds.join('+')}`);

    // F4d: a bundle with PEs but no graphics import at all must say UNKNOWN, loudly.
    const mute = path.join(dir, 'no-graphics.wgb');
    writeFixture(mute, base, [['rom/game.exe', buildPe(false, [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }])]]);
    r = await censusBundle(mute, hleOnly, { ...opts, strings: true });
    check('a bundle with no graphics signal is UNKNOWN', r.verdict === 'UNKNOWN', `${r.verdict} — ${r.note}`);

    // R3 must be case-insensitive and must stay a CANDIDATE: SeriousEngine's renderer list
    // is "OPENGL32.DLL", and a case-sensitive scan called that bundle signal-free.
    const shouty = path.join(dir, 'shouty-literal.wgb');
    writeFixture(shouty, base, [['rom/game.exe',
        buildPe(false, [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }], ['OPENGL32.DLL'])]]);
    r = await censusBundle(shouty, hleOnly, { ...opts, strings: true });
    check('an uppercase renderer literal is seen, as a candidate only',
        r.verdict === 'UNCERTAIN' && r.candidates.includes('opengl') && r.kinds.length === 0,
        `${r.verdict} kinds=${r.kinds.join('+') || '-'} candidates=${r.candidates.join('+') || '-'}`);

    // F1: a truncated bundle and a manifest-less bundle must be ERROR rows, not empty ones.
    const trunc = path.join(dir, 'truncated.wgb');
    const good = readFileSync(bare);
    writeFileSync(trunc, good.subarray(0, Math.floor(good.length / 2)));
    r = await censusBundle(trunc, hleOnly, opts);
    check('a truncated bundle is an ERROR row', r.verdict === 'ERROR', `${r.verdict} — ${r.error}`);

    const noman = path.join(dir, 'no-manifest.wgb');
    writeFixture(noman, base, [['rom/game.exe', exe]]);
    { // rewrite without the manifest member
        const w = new ZipStoreWriter(noman);
        w.addBuffer('rom/game.exe', exe);
        w.finish();
    }
    r = await censusBundle(noman, hleOnly, opts);
    check('a bundle without manifest.json is an ERROR row', r.verdict === 'ERROR', `${r.verdict} — ${r.error}`);

    const nope = path.join(dir, 'does-not-exist.wgb');
    r = await censusBundle(nope, hleOnly, opts);
    check('a nonexistent bundle is an ERROR row', r.verdict === 'ERROR', `${r.verdict} — ${r.error}`);

    // The HLE_ONLY_DLLS import decides every wrapper verdict; falling back to a stale copy
    // would invert them silently, so the parser must refuse a source it cannot read.
    const badSources: Array<[string, string]> = [
        ['a pe-loader without HLE_ONLY_DLLS', 'const SOMETHING_ELSE = new Set<string>([]);'],
        ['an HLE_ONLY_DLLS that lost "ddraw"',
            "const HLE_ONLY_DLLS = new Set<string>(['kernel32','ntdll','user32','gdi32','advapi32','d3d8','d3d9','dsound','glide2x','opengl32']);"],
    ];
    for (const [label, src] of badSources) {
        let threw = '';
        try { parseHleOnlyDlls(src, 'fixture'); } catch (e: any) { threw = e.message; }
        check(`${label} is refused`, threw.length > 0, threw || 'no throw');
    }

    // F3: the doc oracle. Its first implementation matched the Kinds column and passed every
    // planted contradiction; these fixtures pin the ways a filled cell can be dropped instead.
    const stub = (bundle: string, verdict: Verdict, kinds: GraphicsKind[]): BundleCensus => ({
        bundle, file: `${bundle}.wgb`, bytes: 0, verdict, kinds, candidates: [],
        confidence: 'certain', note: '', appDirDlls: [], disabledDlls: [], peCount: 1,
        signals: [{ pe: 'x.exe', tier: 'import', kind: kinds[0], symbol: 'X', dll: 'x.dll', runs: true }], ms: 0,
    });
    const docRows = [stub('fx-carried', 'CARRIED', ['d3d9']), stub('fx-refused', 'REFUSED', ['ddraw']),
        stub('fx-uncertain', 'UNCERTAIN', ['d3d9', 'ddraw'])];
    const verifyDoc = (body: string): VerifyResult => {
        const f = path.join(dir, 'doc.md');
        writeFileSync(f, `| Bundle | Kinds | Observed |\n| --- | --- | --- |\n${body}\n`);
        return verifyAgainstDoc(docRows, f);
    };
    let v = verifyDoc('| fx-carried | d3d9 | ddraw |');
    check('a contradicting Observed cell fails', v.failed === 1 && v.checked === 1, JSON.stringify(v));
    v = verifyDoc('| fx-carried | d3d9 | DDRAW |');
    check('the same contradiction in caps fails too', v.failed === 1, JSON.stringify(v));
    v = verifyDoc('| fx-carried | d3d9 | d3d9 (menu) |');
    check('an Observed cell the oracle cannot read fails', v.failed === 1 && v.unreadable === 1, JSON.stringify(v));
    v = verifyDoc('| fx-refused | ddraw | gdi |');
    check('a gdi-only observation is counted uncheckable, not silently agreed',
        v.failed === 0 && v.uncheckable === 1 && v.checked === 0, JSON.stringify(v));
    v = verifyDoc('| fx-uncertain | d3d9+ddraw | ddraw |');
    check('an UNCERTAIN row is counted uncheckable', v.uncheckable === 1 && v.checked === 0, JSON.stringify(v));
    v = verifyDoc('| fx-not-scanned | - | d3d9 |');
    check('an Observed cell for an unscanned bundle is reported', v.unmatched === 1, JSON.stringify(v));
    v = verifyDoc('| fx-carried | d3d9 | d3d9 + gdi |');
    check('an honest agreement passes', v.failed === 0 && v.checked === 1, JSON.stringify(v));

    rmSync(dir, { recursive: true, force: true });
    console.log(`\nSELFTEST: ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
    return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options { json: boolean; maxBytes: number; strings: boolean; out: string | null; verify: string | null; selftest: boolean; }

function parseArgs(argv: string[]): { targets: string[]; opts: Options } {
    const targets: string[] = [];
    const opts: Options = { json: false, maxBytes: 64 << 20, strings: true, out: null, verify: null, selftest: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--no-strings') opts.strings = false;
        else if (a === '--selftest') opts.selftest = true;
        else if (a === '--max-mb') opts.maxBytes = (parseInt(argv[++i], 10) || 64) << 20;
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--verify') opts.verify = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log('Usage: bun tools/census-presenter-kinds.ts <bundle.wgb|dir> [...] [--json] [--no-strings] [--max-mb N] [--out FILE] [--verify DOC.md] [--selftest]');
            process.exit(0);
        } else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        else targets.push(a);
    }
    return { targets, opts };
}

function expandTargets(targets: string[]): string[] {
    const out: string[] = [];
    for (const t of targets) {
        if (!existsSync(t)) {
            console.error(`census-presenter-kinds: no such path: ${t}`);
            process.exit(2);
        }
        const st = statSync(t);
        if (st.isDirectory()) {
            for (const f of readdirSync(t)) if (f.toLowerCase().endsWith('.wgb')) out.push(path.join(t, f));
        } else out.push(t);
    }
    if (out.length === 0) {
        console.error('census-presenter-kinds: no .wgb found in the given paths');
        process.exit(2);
    }
    return out.sort();
}

async function main(): Promise<void> {
    const { targets, opts } = parseArgs(process.argv.slice(2));
    const hleOnly = loadHleOnlyDlls();

    if (opts.selftest) process.exit(await selftest(hleOnly, opts));

    if (targets.length === 0) {
        console.error('census-presenter-kinds: give at least one .wgb or directory (or --selftest)');
        process.exit(2);
    }

    const files = expandTargets(targets);
    const started = performance.now();
    const rows: BundleCensus[] = [];
    for (const f of files) {
        const row = await censusBundle(f, hleOnly, opts);
        if (!opts.json) console.error(`  scanned ${row.bundle} → ${row.verdict} (${row.ms} ms)`);
        rows.push(row);
    }
    const elapsedMs = Math.round(performance.now() - started);

    const errors = rows.filter(r => r.verdict === 'ERROR');
    if (opts.json || opts.out) {
        const json = JSON.stringify({
            generated: new Date().toISOString(), elapsedMs, bundles: rows,
            counts: Object.fromEntries(VERDICT_ORDER.map(v => [v, rows.filter(r => r.verdict === v).length])),
        }, null, 2);
        if (opts.out) writeFileSync(opts.out, json);
        if (opts.json && !opts.out) console.log(json);
    }
    if (!opts.json) {
        report(rows);
        console.log(`\nscanned ${rows.length} bundle(s) in ${(elapsedMs / 1000).toFixed(1)}s`);
    }

    let code = 0;
    if (errors.length) {
        console.error(`\n${errors.length} bundle(s) could not be censused:`);
        for (const e of errors) console.error(`  ${e.bundle}: ${e.error}`);
        code = 1;
    }
    if (opts.verify && verifyAgainstDoc(rows, opts.verify).failed > 0) code = 1;
    process.exit(code);
}

if (import.meta.main) {
    main().catch(e => { console.error(e); process.exit(2); });
}
