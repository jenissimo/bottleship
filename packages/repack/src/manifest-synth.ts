/**
 * Manifest + registry synthesis from Inno header + extracted goggame metadata.
 */

import type { IconEntry } from "@bottleship/formats/inno/entries/icon";
import type { RegistryEntry } from "@bottleship/formats/inno/entries/registry";
import type { InnoParseResult } from "@bottleship/formats/inno";
import { normalizeInnoDestination } from "@bottleship/formats/inno";
import { detectExeFromPaths } from "./gog-filter";
import { deriveGameId } from "@bottleship/formats/wgb/container-id";
import type { GogOverrideEntry } from "./overrides";
import { mergeRegistrySeeds, synthesizeRegistryFromGogScripts } from "./gog-script";

export type OsPreset = { major: number; minor: number; build: number; platformId: number };

export const OS_PRESETS: Record<string, OsPreset> = {
    win95: { major: 4, minor: 0, build: 950, platformId: 1 },
    win98: { major: 4, minor: 10, build: 2222, platformId: 1 },
    winnt: { major: 4, minor: 0, build: 1381, platformId: 2 },
    win2k: { major: 5, minor: 0, build: 2195, platformId: 2 },
    winxp: { major: 5, minor: 1, build: 2600, platformId: 2 },
};

export interface GogGameInfo {
    gameId?: string;
    name?: string;
    exe?: string;
    args?: string;
}

export function parseGogGameInfo(files: Map<string, Uint8Array>): GogGameInfo {
    for (const [path, data] of files) {
        const base = path.split("/").pop() ?? "";
        if (!/^goggame-.*\.info$/i.test(base)) continue;
        try {
            const text = new TextDecoder().decode(data);
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const playTasks = parsed.playTasks as Array<Record<string, unknown>> | undefined;
            const primary = playTasks?.find((t) => t.isPrimary) ?? playTasks?.[0];
            let exe: string | undefined;
            let args: string | undefined;
            if (primary?.path && typeof primary.path === "string") {
                const raw = primary.path.replace(/\\/g, "/");
                exe = raw.replace(/^\.\//, "").replace(/^\//, "");
            }
            if (primary?.arguments && typeof primary.arguments === "string") {
                args = primary.arguments;
            }
            const m = base.match(/^goggame-(\d+)\.info$/i);
            return {
                gameId: (parsed.gameId as string | undefined) ?? m?.[1],
                name: (parsed.name as string | undefined) ?? (parsed.gameTitle as string | undefined),
                exe,
                args,
            };
        } catch { /* ignore */ }
    }
    return {};
}

function resolveAppPath(value: string, installRoot = "C:\\"): string {
    const normalized = value.replace(/\//g, "\\");
    if (/^\{app\}$/i.test(normalized)) {
        return installRoot.endsWith("\\") ? installRoot : `${installRoot}\\`;
    }
    const root = installRoot.replace(/\\$/, "");
    return normalized.replace(/\{app\}/gi, root);
}

/** Find UTF-16LE null wchar offset (byte index of 0x0000), not the first zero byte. */
function utf16NullByteOffset(v: Uint8Array): number {
    for (let i = 0; i + 1 < v.byteLength; i += 2) {
        if (v[i] === 0 && v[i + 1] === 0) return i;
    }
    return -1;
}

function decodeRegistryValue(entry: RegistryEntry, unicode: boolean): unknown {
    const v = entry.value;
    switch (entry.type) {
        case 0: // REG_NONE
            return "";
        case 1: { // REG_SZ
            if (unicode) {
                const nullOff = utf16NullByteOffset(v);
                const bytes = nullOff >= 0 ? v.subarray(0, nullOff) : v;
                return new TextDecoder("utf-16le").decode(bytes);
            }
            const end = v.indexOf(0);
            return new TextDecoder("windows-1252").decode(end >= 0 ? v.subarray(0, end) : v);
        }
        case 2: { // REG_EXPAND_SZ
            if (unicode) {
                const nullOff = utf16NullByteOffset(v);
                const bytes = nullOff >= 0 ? v.subarray(0, nullOff) : v;
                return new TextDecoder("utf-16le").decode(bytes);
            }
            const end = v.indexOf(0);
            return new TextDecoder("windows-1252").decode(end >= 0 ? v.subarray(0, end) : v);
        }
        case 3: { // REG_BINARY
            return Array.from(v);
        }
        case 4: { // REG_DWORD
            if (v.byteLength >= 4) return new DataView(v.buffer, v.byteOffset, 4).getUint32(0, true);
            return 0;
        }
        case 7: { // REG_MULTI_SZ
            const parts: string[] = [];
            const dec = new TextDecoder(unicode ? "utf-16le" : "windows-1252");
            if (unicode) {
                let start = 0;
                for (let i = 0; i + 1 < v.byteLength; i += 2) {
                    if (v[i] === 0 && v[i + 1] === 0) {
                        parts.push(dec.decode(v.subarray(start, i)));
                        start = i + 2;
                    }
                }
            } else {
                let start = 0;
                for (let i = 0; i < v.byteLength; i++) {
                    if (v[i] === 0) {
                        parts.push(dec.decode(v.subarray(start, i)));
                        start = i + 1;
                    }
                }
            }
            return parts;
        }
        default:
            return Array.from(v);
    }
}

const HIVE_NAMES = ["HKCR", "HKCU", "HKLM", "HKU"] as const;

export interface RegistrySeed {
    root: string;
    path: string;
    values: Array<{ name: string; type: string; data: unknown }>;
}

export function synthesizeRegistry(
    parsed: InnoParseResult,
    installRoot = "C:\\",
): RegistrySeed[] {
    const byHive = new Map<string, RegistrySeed>();

    const unicode = parsed.version.isUnicode();

    for (const entry of parsed.registryEntries) {
        const hive = HIVE_NAMES[entry.hive] ?? "HKLM";
        let keyPath = resolveAppPath(entry.key, installRoot);
        if (keyPath.includes("{")) continue;

        let data = decodeRegistryValue(entry, unicode);
        if (typeof data === "string") {
            data = resolveAppPath(data, installRoot);
            if ((data as string).includes("{")) continue;
        }

        const regType = entry.type === 4 ? "REG_DWORD"
            : entry.type === 3 ? "REG_BINARY"
            : entry.type === 7 ? "REG_MULTI_SZ"
            : "REG_SZ";

        const seedKey = `${hive}\\${keyPath}`;
        let seed = byHive.get(seedKey);
        if (!seed) {
            seed = { root: hive, path: keyPath, values: [] };
            byHive.set(seedKey, seed);
        }
        seed.values.push({ name: entry.name || "(Default)", type: regType, data });
    }

    return [...byHive.values()];
}

function iconEntrypoint(icons: IconEntry[]): string | undefined {
    for (const icon of icons) {
        const target = icon.filename.replace(/\\/g, "/");
        if (target.toLowerCase().includes("{app}")) {
            const rel = target.replace(/^\{app\}[\\/]/i, "");
            if (rel && !rel.includes("{")) return rel;
        }
    }
    return undefined;
}

export interface SynthOptions {
    parsed: InnoParseResult;
    gameFiles: Map<string, Uint8Array>;
    override?: GogOverrideEntry;
    cli?: {
        name?: string;
        exe?: string;
        args?: string;
        width?: number;
        height?: number;
        bpp?: number;
        ramMB?: number;
        os?: string;
        regPath?: string;
        regHive?: string;
        regInstall?: string;
        skipVideo?: boolean;
    };
}

export interface SynthResult {
    manifest: Record<string, unknown>;
    registry: RegistrySeed | RegistrySeed[];
    gameId?: string;
    cacheKey?: string;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Best-effort release year from an Inno AppCopyright string.
 * Copyright lines usually carry a year or range ("(C) 1997-2002 …") — the
 * latest year in range is the closest to the actual release.
 */
export function copyrightYear(copyright: string | undefined): number | undefined {
    if (!copyright) return undefined;
    let best: number | undefined;
    for (const m of copyright.matchAll(/\b(19[7-9]\d|20[0-3]\d)\b/g)) {
        const y = Number(m[1]);
        if (best === undefined || y > best) best = y;
    }
    return best;
}

export function guessCacheKey(parsed: InnoParseResult): string {
    for (const f of parsed.files) {
        const m = f.destination.match(/\{app\}[\\/]goggame-(\d+)\.info/i);
        if (m) return `gog-${m[1]}-${parsed.header.appVersion}.wgb`;
    }
    const ver = parsed.header.appVersion || "unknown";
    return `gog-installer-${ver}.wgb`;
}

export function synthesizeManifest(opts: SynthOptions): SynthResult {
    const gogInfo = parseGogGameInfo(opts.gameFiles);
    const cli = opts.cli ?? {};
    const osKey = cli.os ?? "win98";
    const osVer = OS_PRESETS[osKey] ?? OS_PRESETS.win98!;

    const filteredPaths = [...opts.gameFiles.keys()].filter((p) => !p.startsWith("__"));
    const exeName = cli.exe
        ?? gogInfo.exe
        ?? iconEntrypoint(opts.parsed.icons)
        ?? detectExeFromPaths(filteredPaths);

    if (!exeName) {
        throw new Error("no entrypoint .exe found in installer; specify --exe");
    }

    const name = cli.name ?? gogInfo.name ?? opts.parsed.header.appName ?? "GOG Game";
    const gameArgs = cli.args ?? gogInfo.args;
    const width = cli.width ?? 640;
    const height = cli.height ?? 480;
    const bpp = cli.bpp ?? 16;
    const ramMB = cli.ramMB ?? 64;
    const regInstall = cli.regInstall ?? "C:\\";
    const regHive = cli.regHive ?? "HKLM";
    const regPath = cli.regPath;

    const entrypoint = `rom/${exeName.replace(/\\/g, "/")}`;
    // Container key (WGB v2): a GOG product id → gog:<id>; else derive app:<slug>/byo.
    const manifestGameId = gogInfo.gameId ? `gog:${gogInfo.gameId}` : deriveGameId({ name, entrypoint });

    // Installer [Dirs] entries: a store-only ZIP has no entry for an empty directory,
    // so installer-created dirs must be recreated at boot (worker createDirs) or the
    // game's opens/writes into them fail with the WRONG error (PATH_NOT_FOUND instead
    // of FILE_NOT_FOUND) vs a real install.
    const createDirs = [...new Set(
        (opts.parsed.directories ?? [])
            .map((d) => normalizeInnoDestination(d.name))
            .filter((rel): rel is string => !!rel)
            .map((rel) => rel.replace(/\//g, "\\")),
    )].sort();

    let manifest: Record<string, unknown> = {
        formatVersion: 2,
        gameId: manifestGameId,
        name,
        entrypoint,
        rom: "rom",
        registry: "registry.json",
        emulator: {
            osVersion: osVer,
            screenResolution: { width, height, bpp },
            memory: { ram: ramMB * 1024 * 1024 },
            ...(cli.skipVideo ? { skipVideo: true } : {}),
            ...(createDirs.length > 0 ? { createDirs } : {}),
        },
    };
    if (gameArgs) manifest.args = gameArgs;

    // manifest.meta (WgbMeta): developer/year from the Inno header — feeds the
    // library card without any external metadata lookup.
    const developer = opts.parsed.header.appPublisher?.trim();
    const year = copyrightYear(opts.parsed.header.appCopyright);
    if (developer || year !== undefined) {
        manifest.meta = {
            ...(developer ? { developer } : {}),
            ...(year !== undefined ? { year } : {}),
        };
    }

    let registry: RegistrySeed | RegistrySeed[] = regPath
        ? {
            root: regHive,
            path: regPath,
            values: [{ name: "InstallPath", type: "REG_SZ", data: regInstall }],
        }
        : synthesizeRegistry(opts.parsed, regInstall);

    // goggame-*.script carries game-specific setRegistry actions (LucasArts keys, etc.)
    // that Inno's [Registry] block does not include — only GOG.com metadata lives there.
    const scriptRegistry = synthesizeRegistryFromGogScripts(opts.gameFiles, regInstall);
    if (scriptRegistry.length > 0) {
        registry = mergeRegistrySeeds(registry, scriptRegistry);
    }

    if (opts.override?.manifest) {
        manifest = deepMerge(manifest, opts.override.manifest);
    }
    if (opts.override?.extraRegistry?.length) {
        const extra = opts.override.extraRegistry;
        registry = Array.isArray(registry) ? [...registry, ...extra] : [registry, ...extra];
    }

    const gameId = gogInfo.gameId;
    const cacheKey = guessCacheKey(opts.parsed);

    return { manifest, registry, gameId, cacheKey };
}
