#!/usr/bin/env bun
/**
 * make-wgb: Create a .wgb bundle from a game directory + metadata flags.
 *
 * Unlike pack-wgb (which zips a pre-staged directory), make-wgb accepts a raw
 * game directory, generates manifest.json and registry.json via JSON.stringify
 * (guarantees correct backslash escaping), then packs everything in one step.
 *
 * Usage:
 *   bun tools/make-wgb.ts <game-dir> <output.wgb> [options]
 *
 * Required:
 *   <game-dir>      Directory whose contents become rom/ inside the bundle.
 *   <output.wgb>    Destination .wgb file path.
 *
 * Options:
 *   --name <str>          Display name  (default: basename of game-dir)
 *   --game-id <str>       Stable container/save key, namespaced "<scheme>:<id>"
 *                         (gog:<productId> | steam:<appid> | app:<reverse-dns> | byo:<hex>).
 *                         Default: app:<slug(name)> (with a warning — prefer an explicit id).
 *   --exe  <str>          Entrypoint exe relative to game-dir (default: auto-detect first .exe)
 *   --args <str>          Command-line args passed to the exe
 *   --width  <n>          Screen width  (default: 640)
 *   --height <n>          Screen height (default: 480)
 *   --bpp    <n>          Bits per pixel (default: 16)
 *   --ram    <n>          RAM in MB (default: 64)
 *   --os     win95|win98|winnt  OS version preset (default: win98)
 *   --reg-hive  HKLM|HKCU      Registry hive for InstallPath key (default: HKLM)
 *   --reg-path  <str>     Registry key path, backslash-separated (default: none)
 *   --reg-install <str>   Value data for the install-path key (default: C:\)
 *   --reg-name <str>      Value NAME for it (default: InstallPath). Titles differ —
 *                         GTA III reads HKLM\SOFTWARE\Rockstar Games\GTA 3\InstallDir.
 *   --cd-path <str>       Guest path the CD-ROM drive (D:\) aliases to, for a title that
 *                         still checks for its disc. Usually "C:\" (the install root).
 *   --app-dir-dlls <list> Comma/semicolon-separated DLL names whose copy IN THE GAME
 *                         DIRECTORY must win over our HLE module, as Windows' search
 *                         order does (app dir before System32). Required for a game that
 *                         ships a wrapper/proxy DLL — an ASI loader, a Glide or ddraw
 *                         shim — which otherwise never executes. Example:
 *                         --app-dir-dlls "ddraw"
 *   --skip-video          Set emulator.skipVideo=true
 *   --codepage <n>       ANSI code page (default: 1252). Use 1251 for Cyrillic
 *   --oem-codepage <n>   OEM code page (default: 437). Use 866 for Cyrillic OEM
 *   --lcid <hex>         Locale ID in hex (default: 0409). Use 0419 for Russian
 *   --create-dirs <list> Comma/semicolon-separated dir paths the INSTALLER created but
 *                        that store-only ZIP drops (a ZIP has no entry for an empty dir).
 *                        The worker recreates them at boot (mkdir -p) so the game's own
 *                        fopen("wb") into e.g. user\rosters succeeds. Backslash or forward
 *                        slash both work. Example: --create-dirs "user\rosters,user\save\photos"
 *   --touch-layout <v>   On-screen touch controls for this title: either a preset id
 *                        (pointer | pointer-rmb | wasd-look | dpad-buttons | pad) or a
 *                        path to a .json ControlLayout exported from the layout editor.
 *                        Sets emulator.touch.layout; without it the host auto-detects.
 *   --touch-mode <m>     auto | direct | trackpad (default auto = follow the guest's
 *                        relative-mouse intent). Sets emulator.touch.mode.
 *
 * Examples:
 *   bun tools/make-wgb.ts C:/Share/THPS2 E:/wgb/thps2-demo.wgb \
 *       --name "Tony Hawk's Pro Skater 2 Demo" \
 *       --exe THawk2.exe \
 *       --reg-path "Software\Activision\Tony Hawk's Pro Skater 2 Demo"
 *
 *   bun tools/make-wgb.ts C:/Share/Quake E:/wgb/quake.wgb \
 *       --name "Quake" --exe quake.exe --os winnt --width 800 --height 600 --bpp 32
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import { ZipStoreWriter } from './internal/zip-store-writer';
import { isValidGameId, deriveGameId, KNOWN_GAME_ID_SCHEMES } from '@bottleship/formats/wgb/container-id';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
    const args = argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: bun tools/make-wgb.ts <game-dir> <output.wgb> [options]');
        console.error('Run with --help for full option list.');
        process.exit(1);
    }

    const gameDir  = args[0];
    const output   = args[1];

    const get = (flag: string) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : undefined;
    };
    const has = (flag: string) => args.includes(flag);

    if (has('--help')) {
        // Print the block comment at the top of this file
        const src = readFileSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8');
        const match = src.match(/\/\*\*([\s\S]*?)\*\//);
        if (match) console.log(match[1].replace(/^ \* ?/gm, ''));
        process.exit(0);
    }

    return { gameDir, output, get, has };
}

// ---------------------------------------------------------------------------
// OS version presets
// ---------------------------------------------------------------------------

type OsPreset = { major: number; minor: number; build: number; platformId: number };
const OS_PRESETS: Record<string, OsPreset> = {
    win95: { major: 4, minor: 0,  build: 950,  platformId: 1 },
    win98: { major: 4, minor: 10, build: 2222, platformId: 1 },
    winnt: { major: 4, minor: 0,  build: 1381, platformId: 2 },
    win2k: { major: 5, minor: 0,  build: 2195, platformId: 2 },
    winxp: { major: 5, minor: 1,  build: 2600, platformId: 2 },
};

// ---------------------------------------------------------------------------
// Auto-detect entrypoint exe
// ---------------------------------------------------------------------------

function detectExe(dir: string): string | undefined {
    // Prefer an exe that is not an installer/uninstaller
    const SKIP = /^(setup|install|unwise|uninstall|uninst)/i;
    const exes = readdirSync(dir)
        .filter(f => extname(f).toLowerCase() === '.exe' && !SKIP.test(f));
    return exes[0];
}

// ---------------------------------------------------------------------------
// Collect game files recursively
// ---------------------------------------------------------------------------

// Walk the game dir into `out` (zip entries) and record any EMPTY directory into
// `emptyDirs` (path relative to the game dir, backslash form). A store-only ZIP has
// no entry for an empty dir, so an installer-created folder like `user\rosters` would
// vanish silently and the game's fopen("wb") into it would fail (Windows fopen doesn't
// mkdir parents). We surface these so they can be recreated at boot via createDirs.
// Only PATHS are collected — a multi-GB bundle must never be assembled in memory; the
// writer streams each member off disk.
function collectGameFiles(dir: string, prefix: string, out: Map<string, string>, emptyDirs: Set<string>, rel = '') {
    const entries = readdirSync(dir);
    if (entries.length === 0) {
        if (rel) emptyDirs.add(rel); // deepest empty dir; mkdir -p at boot covers ancestors
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        const zipName = prefix + entry;
        const childRel = rel ? `${rel}\\${entry}` : entry;
        if (statSync(full).isDirectory()) {
            collectGameFiles(full, zipName + '/', out, emptyDirs, childRel);
        } else {
            out.set(zipName, full);
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { gameDir, output, get, has } = parseArgs(process.argv);

if (!existsSync(gameDir)) {
    console.error(`Error: game directory not found: ${gameDir}`);
    process.exit(1);
}

// Entrypoint
const exeName = get('--exe') ?? detectExe(gameDir);
if (!exeName) {
    console.error('Error: no .exe found in game directory; use --exe <name>');
    process.exit(1);
}

// Build manifest — JSON.stringify handles all escaping correctly
const name       = get('--name') ?? basename(gameDir);
const args       = get('--args');
const width      = parseInt(get('--width')  ?? '640', 10);
const height     = parseInt(get('--height') ?? '480', 10);
const bpp        = parseInt(get('--bpp')    ?? '16',  10);
const ramMB      = parseInt(get('--ram')    ?? '64',  10);
const osKey      = get('--os') ?? 'win98';
const osVer      = OS_PRESETS[osKey];
if (!osVer) {
    console.error(`Error: unknown --os preset "${osKey}". Valid: ${Object.keys(OS_PRESETS).join(', ')}`);
    process.exit(1);
}

// Container identity (WGB v2). Explicit --game-id wins; otherwise derive app:<slug(name)> + warn.
const entrypoint = `rom/${exeName}`;
let gameId = get('--game-id');
if (gameId && !isValidGameId(gameId)) {
    console.error(`Error: invalid --game-id "${gameId}". Use "<scheme>:<id>" with scheme in {${KNOWN_GAME_ID_SCHEMES.join(', ')}}.`);
    process.exit(1);
}
if (!gameId) {
    gameId = deriveGameId({ name, entrypoint });
    console.warn(`⚠ no --game-id given; defaulting to "${gameId}". Prefer an explicit stable id (it is the save key).`);
}

// Scan the game dir up-front: collect rom/ file entries AND auto-detect empty
// directories the installer left (ZIP drops them). Explicit --create-dirs are
// merged on top — belt and suspenders for authors who know the paths.
const romFiles = new Map<string, string>();
const emptyDirs = new Set<string>();
collectGameFiles(gameDir, 'rom/', romFiles, emptyDirs);

const explicitCreateDirs = (get('--create-dirs') ?? '')
    .split(/[,;]/)
    .map((d) => d.trim().replace(/\//g, '\\').replace(/^\\+|\\+$/g, ''))
    .filter((d) => d.length > 0);

const createDirs = [...new Set([...explicitCreateDirs, ...emptyDirs])].sort();

// Where the CD-ROM drive (D:\) points. A retail install still expects its disc — GTA III
// hunts for a DRIVE_CDROM whose AUDIO\HEAD.WAV opens — so a bundle packed from an install
// must say which guest path stands in for the disc, usually the install root itself.
const cdPath = get('--cd-path');

// DLLs whose game-directory copy must beat our HLE module (Windows' own search order).
// Wrapper/proxy DLLs a game ships — ASI loaders, Glide/ddraw shims — never execute without it.
const appDirDlls = (get('--app-dir-dlls') ?? '')
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
if (emptyDirs.size > 0) {
    console.log(`  empty dirs: auto-detected ${emptyDirs.size} (added to createDirs): ${[...emptyDirs].sort().join(', ')}`);
}

// Touch controls (host-side data; the worker only forwards it in bundle_meta).
// A preset id stays a string; a .json path is parsed here so unreadable or syntactically
// invalid JSON fails at pack time instead of silently degrading to auto-detect on a phone.
// SYNTAX only — the layout's SHAPE is not validated, so a well-formed but wrong object
// still ships.
const TOUCH_PRESETS = ['pointer', 'pointer-rmb', 'wasd-look', 'dpad-buttons', 'pad'];
const touchLayoutArg = get('--touch-layout');
let touchLayout: string | Record<string, unknown> | undefined;
if (touchLayoutArg) {
    if (/\.json$/i.test(touchLayoutArg)) {
        if (!existsSync(touchLayoutArg)) {
            console.error(`Error: --touch-layout file not found: ${touchLayoutArg}`);
            process.exit(1);
        }
        try {
            touchLayout = JSON.parse(readFileSync(touchLayoutArg, 'utf8'));
        } catch (err) {
            console.error(`Error: --touch-layout "${touchLayoutArg}" is not valid JSON: ${err}`);
            process.exit(1);
        }
    } else if (TOUCH_PRESETS.includes(touchLayoutArg)) {
        touchLayout = touchLayoutArg;
    } else {
        console.error(`Error: unknown --touch-layout "${touchLayoutArg}". Valid presets: ${TOUCH_PRESETS.join(', ')} (or a .json file).`);
        process.exit(1);
    }
}
const touchModeArg = get('--touch-mode');
if (touchModeArg && !['auto', 'direct', 'trackpad'].includes(touchModeArg)) {
    console.error(`Error: unknown --touch-mode "${touchModeArg}". Valid: auto, direct, trackpad.`);
    process.exit(1);
}
const touch = (touchLayout !== undefined || touchModeArg)
    ? { ...(touchLayout !== undefined ? { layout: touchLayout } : {}), ...(touchModeArg ? { mode: touchModeArg } : {}) }
    : undefined;

const manifest: Record<string, unknown> = {
    formatVersion: 2,
    gameId,
    name,
    entrypoint,
    rom: 'rom',
    registry: 'registry.json',
    emulator: {
        osVersion: osVer,
        screenResolution: { width, height, bpp },
        memory: { ram: ramMB * 1024 * 1024 },
        ...(has('--skip-video') ? { skipVideo: true } : {}),
        ...(get('--codepage') ? { codepage: parseInt(get('--codepage')!, 10) } : {}),
        ...(get('--oem-codepage') ? { oemCodepage: parseInt(get('--oem-codepage')!, 10) } : {}),
        ...(get('--lcid') ? { lcid: parseInt(get('--lcid')!, 16) } : {}),
        ...(createDirs.length > 0 ? { createDirs } : {}),
        ...(appDirDlls.length > 0 ? { appDirDlls } : {}),
        ...(cdPath ? { cdPath } : {}),
        ...(touch ? { touch } : {}),
    },
};
if (args) (manifest as any).args = args;

// Build registry — JSON.stringify guarantees \\ escaping of backslashes
const regPath    = get('--reg-path');
const regHive    = get('--reg-hive') ?? 'HKLM';
const regInstall = get('--reg-install') ?? 'C:\\';

let registry: unknown;
if (regPath) {
    registry = {
        root: regHive,
        path: regPath,          // JS string; JSON.stringify will escape \ → \\
        values: [
            { name: get('--reg-name') ?? 'InstallPath', type: 'REG_SZ', data: regInstall },
        ],
    };
} else {
    // Minimal placeholder so the loader doesn't error on missing registry.json
    registry = { root: 'HKLM', path: 'Software', values: [] };
}

// Stream the archive straight to disk: manifest + registry first (readability in
// `wgb list`), then the game files scanned above (romFiles holds paths, not bytes).
const writer = new ZipStoreWriter(output);
writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
writer.addBuffer('registry.json', Buffer.from(JSON.stringify(registry, null, 2), 'utf8'));
for (const [zipName, path] of romFiles) writer.addFile(zipName, path);
const { bytes, entries: entryCount } = writer.finish();

console.log(`Created ${output} (${entryCount} files, ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  name:       ${name}`);
console.log(`  entrypoint: rom/${exeName}`);
console.log(`  resolution: ${width}x${height}x${bpp}`);
console.log(`  os:         ${osKey} (${osVer.major}.${osVer.minor}.${osVer.build})`);
if (regPath) console.log(`  registry:   ${regHive}\\${regPath}`);

// Ready-to-open dev URL: the dev server (serveWgbFromDisk) streams this file straight
// off disk via Range — no symlink, no copy into public/. `?game=dev&load=` auto-loads it.
const bundleUrl = `/__wgb/?path=${encodeURIComponent(resolve(output))}`;
console.log(`  open (dev): http://localhost:5174/?game=dev&load=${encodeURIComponent(bundleUrl)}`);
