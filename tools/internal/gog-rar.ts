/** Old GOG distributions wrap independent numbered RAR payloads in an Inno helper EXE.
 * Only the documented game/ + support/app/ installation layout is mapped; no scripts run. */
import { readdirSync, statSync, readFileSync, mkdirSync, existsSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { findRar4, parseRar4, assertRar4Extractable, extractRar4ToSink, type Rar4Archive } from '@bottleship/formats/rar';
import type { InnoParseResult } from '@bottleship/formats/inno';
import type { UnpackDecoder } from '@bottleship/formats/unpack';
import { isGogJunk, SKIP_DIRS, detectExeFromPaths } from '@bottleship/repack/gog-filter';
import { synthesizeInstallerManifest, installerGuestPath } from '@bottleship/repack/installer-layout';
import { parseGogGameInfo, type SynthOptions } from '@bottleship/repack/manifest-synth';
import { loadOverrides, getOverride, type GogOverridesDb } from '@bottleship/repack/overrides';
import { FileSource } from './file-source';
import { resolveArchiveExtractPath } from './archive-extract-path';
import { ZipStoreWriter } from './zip-store-writer';

export const GOG_RAR_MAX_OUTPUT = 1024 * 1024 * 1024;
export interface GogRarPart { path: string; source: FileSource; archive: Rar4Archive; }

/** Null means the standard Inno path. Recognized RAR siblings must form a complete,
 * unambiguous numeric sequence; true RAR split volumes are refused by the format validator. */
export function discoverGogRarParts(installer: string): GogRarPart[] | null {
    const parent = dirname(installer), stem = basename(installer, extname(installer));
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}-(\\d+)\\.bin$`, 'i');
    const candidates = readdirSync(parent).flatMap(name => {
        const match = name.match(pattern);
        return match ? [{ path: join(parent, name), number: Number(match[1]) }] : [];
    });
    const sources = candidates.map(c => ({ ...c, source: new FileSource(c.path) }));
    if (!sources.some(c => findRar4(c.source.readRangeSync(0, 7)) === 0)) return null;
    sources.sort((a, b) => a.number - b.number);
    return sources.map((c, index) => {
        if (c.number !== index + 1) throw new Error('GOG RAR: missing or duplicate numbered payload; expected consecutive -1.bin, -2.bin, ...');
        if (findRar4(c.source.readRangeSync(0, 7)) !== 0) throw new Error('GOG RAR: mixed or unsupported sibling payload formats');
        const archive = parseRar4(c.source);
        assertRar4Extractable(archive, { maxOutputBytes: GOG_RAR_MAX_OUTPUT });
        return { path: c.path, source: c.source, archive };
    });
}

export interface GogRarLayout {
    destinations: Array<Map<string, string>>;
    files: string[];
    directories: string[];
}

/** support/app is the install staging overlay. Decide its winners before writing, so
 * every destination is created once even when the archive places support before game. */
export function planGogRarLayout(parts: GogRarPart[]): GogRarLayout {
    const winners = new Map<string, { part: number; name: string; path: string; overlay: boolean; directory: boolean }>();
    let gameFiles = 0;
    parts.forEach((part, index) => {
        for (const entry of part.archive.entries) {
            const name = entry.name.replace(/\\/g, '/').replace(/\/$/, '');
            const overlay = /^support\/app\//i.test(name);
            const prefix = /^game\//i.test(name) ? 'game/' : overlay ? 'support/app/' : undefined;
            if (!prefix) continue;
            const path = name.slice(prefix.length);
            if (!path) continue;
            // The common containment owner refuses absolute/traversal/drive/NUL paths.
            resolveArchiveExtractPath('gog-install-root', path);
            if (!overlay && !entry.isDirectory) gameFiles++;
            const key = path.toLowerCase(), prior = winners.get(key);
            if (prior) {
                if (prior.directory !== entry.isDirectory) throw new Error('GOG RAR: file/directory destination collision');
                if (entry.isDirectory) continue;
                if (prior.overlay === overlay) throw new Error('GOG RAR: duplicate destination across payload parts');
                if (!overlay) continue;
            }
            winners.set(key, { part: index, name: entry.name.toLowerCase(), path: prior?.path ?? path, overlay, directory: entry.isDirectory });
        }
    });
    if (!gameFiles) throw new Error('GOG RAR: no game/ payload; refusing a helper-only bundle');
    // Windows installation paths are case-insensitive at every component, including
    // implicit parents. Use one spelling on case-sensitive staging filesystems too.
    const spelling = new Map<string, string>();
    for (const winner of winners.values()) {
        let parent = '';
        winner.path = winner.path.split('/').map(component => {
            const key = `${parent}/${component}`.toLowerCase();
            const canonical = spelling.get(key) ?? component;
            spelling.set(key, canonical);
            parent += `/${canonical}`;
            return canonical;
        }).join('/');
    }
    const files = [...winners.values()].filter(x => !x.directory).map(x => x.path);
    if (!detectExeFromPaths(files)) throw new Error('GOG RAR: game payload has no executable candidate');
    for (const winner of winners.values()) {
        let parent = dirname(winner.path).replace(/\\/g, '/');
        while (parent !== '.') {
            const existing = winners.get(parent.toLowerCase());
            if (existing && !existing.directory) throw new Error('GOG RAR: file used as parent directory');
            parent = dirname(parent).replace(/\\/g, '/');
        }
    }
    const destinations = parts.map(() => new Map<string, string>());
    for (const winner of winners.values()) destinations[winner.part]!.set(winner.name, winner.path);
    return { destinations, files, directories: [...winners.values()].filter(x => x.directory).map(x => x.path) };
}

/** Preserve order/filter/exe detection without ever opening a payload file. */
export function collectGamePaths(dir: string, prefix: string, paths: string[], filterGog: boolean, emptyDirs?: string[]) {
    const entries = readdirSync(dir);
    if (!entries.length && prefix) emptyDirs?.push(prefix.slice(0, -1).replace(/\//g, '\\'));
    for (const entry of entries) {
        const full = join(dir, entry), relative = prefix + entry;
        if (statSync(full).isDirectory()) {
            if (filterGog && SKIP_DIRS.has(entry.toLowerCase())) continue;
            collectGamePaths(full, relative + '/', paths, filterGog, emptyDirs);
        } else if (!filterGog || !isGogJunk(relative)) paths.push(relative);
    }
}

export async function installGogRar(parts: GogRarPart[], layout: GogRarLayout, extractDir: string, codec: UnpackDecoder): Promise<string> {
    if (existsSync(extractDir)) throw new Error('GOG RAR: extraction destination already exists; inspect it before continuing');
    const app = join(extractDir, 'app');
    mkdirSync(app, { recursive: true });
    for (const directory of layout.directories) mkdirSync(resolveArchiveExtractPath(app, directory), { recursive: true });
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!, selected = layout.destinations[index]!;
        await extractRar4ToSink(part.source, 0, {
            maxOutputBytes: GOG_RAR_MAX_OUTPUT,
            createPpmSession: input => codec.createRarPpmSession(input),
            wantFile: entry => selected.has(entry.name.toLowerCase()),
        }, (name, bytes, entry) => {
            const destination = selected.get(entry.name.toLowerCase());
            if (!destination) throw new Error('GOG RAR: unexpected publication outside planned layout');
            const target = resolveArchiveExtractPath(app, destination);
            if (entry.isDirectory) { mkdirSync(target, { recursive: true }); return; }
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, bytes, { flag: 'wx' });
        });
    }
    return app;
}

export async function synthesizeInstalledGog(app: string, parsed: InnoParseResult, cli: SynthOptions['cli'], overrides?: GogOverridesDb) {
    const paths: string[] = [], emptyDirs: string[] = [];
    collectGamePaths(app, '', paths, false, emptyDirs);
    const metadata = new Map<string, Uint8Array>(paths.map(path => [path, new Uint8Array(0)]));
    for (const path of paths) {
        if (!/^goggame-.*\.(info|script)$/i.test(basename(path))) continue;
        const full = resolveArchiveExtractPath(app, path);
        if (statSync(full).size > 1024 * 1024) throw new Error('GOG RAR: oversized installer metadata');
        metadata.set(path, readFileSync(full));
    }
    const db = await loadOverrides(overrides);
    const synth = synthesizeInstallerManifest({ parsed, gameFiles: metadata, cli, override: getOverride(db, parseGogGameInfo(metadata).gameId) });
    const exe = String(synth.manifest.entrypoint).slice(synth.romPrefix.length).toLowerCase();
    if (!paths.some(path => path.toLowerCase() === exe)) throw new Error('GOG RAR: installer entrypoint is absent from installed payload');
    const emulator = synth.manifest.emulator as Record<string, unknown>;
    const createDirs = [...new Set([...(emulator.createDirs as string[] ?? []), ...emptyDirs.map(p => synth.installDir.length > 3 ? installerGuestPath(synth.installDir, p) : p)])].sort();
    if (createDirs.length) emulator.createDirs = createDirs;
    return { ...synth, paths };
}

/** Atomically publish without replacement, including Windows exFAT (no hard links). */
export async function publishGogBundle(pending: string, output: string): Promise<void> {
    if (process.platform !== 'win32') {
        linkSync(pending, output);
        unlinkSync(pending);
        return;
    }
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const library = dlopen('kernel32.dll', {
        MoveFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        GetLastError: { args: [], returns: FFIType.u32 },
    });
    const wide = (path: string) => {
        const absolute = resolve(path);
        const extended = absolute.startsWith('\\\\?\\') ? absolute
            : absolute.startsWith('\\\\') ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`;
        return Buffer.from(extended + '\0', 'utf16le');
    };
    // Keep both backing buffers alive until the synchronous native call returns.
    const source = wide(pending), destination = wide(output);
    try {
        const moved = library.symbols.MoveFileW(ptr(source), ptr(destination));
        const error = moved ? 0 : library.symbols.GetLastError();
        if (!moved) throw new Error(`Exclusive WGB publication failed (Windows error ${error})`);
    } finally {
        library.close();
    }
}

/** A failed pack closes its fd and leaves no final WGB; existing output is never replaced. */
export async function packInstalledGog(app: string, output: string, synth: Awaited<ReturnType<typeof synthesizeInstalledGog>>, keepGog: boolean) {
    if (existsSync(output)) throw new Error('GOG RAR: output already exists');
    mkdirSync(dirname(output), { recursive: true });
    const pending = `${output}.partial-${randomBytes(6).toString('hex')}`;
    const writer = new ZipStoreWriter(pending);
    try {
        writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(synth.manifest, null, 2)));
        writer.addBuffer('registry.json', Buffer.from(JSON.stringify(synth.registry, null, 2)));
        for (const path of synth.paths) if (keepGog || !isGogJunk(path)) writer.addFile(`${synth.romPrefix}${path}`, resolveArchiveExtractPath(app, path));
        const result = writer.finish();
        await publishGogBundle(pending, output);
        return result;
    } finally {
        writer.abort();
        if (existsSync(pending)) unlinkSync(pending);
    }
}
