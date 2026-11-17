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
    workingDir?: string;
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
                workingDir: typeof primary?.workingDir === "string" ? primary.workingDir : undefined,
            };
        } catch { /* ignore */ }
    }
    return {};
}

function resolveAppPath(value: string, installRoot = "C:\\"): string {
    return expandAppConstant(value.replace(/\//g, "\\"), installRoot);
}

function expandAppConstant(value: string, installRoot: string): string {
    if (/^\{app\}$/i.test(value)) {
        return installRoot.endsWith("\\") ? installRoot : `${installRoot}\\`;
    }
    const root = installRoot.replace(/\\$/, "");
    return value.replace(/\{app\}/gi, root);
}

/** Find UTF-16LE null wchar offset (byte index of 0x0000), not the first zero byte. */
function utf16NullByteOffset(v: Uint8Array): number {
    for (let i = 0; i + 1 < v.byteLength; i += 2) {
        if (v[i] === 0 && v[i + 1] === 0) return i;
    }
    return -1;
}

function decodeRegistryText(v: Uint8Array, unicode: boolean): string {
    const end = unicode ? utf16NullByteOffset(v) : v.indexOf(0);
    return new TextDecoder(unicode ? "utf-16le" : "windows-1252").decode(end >= 0 ? v.subarray(0, end) : v);
}

function hexBytes(v: Uint8Array): string {
    return Array.from(v, b => b.toString(16).padStart(2, "0")).join("");
}

/** Inno's rt* ordinals are not Win32 REG_* constants (Shared.Struct.pas). */
function decodeRegistryValue(entry: RegistryEntry, unicode: boolean, installRoot: string): RegistrySeed["values"][number] | null {
    const name = entry.name || "(Default)";
    const v = entry.value;
    if (entry.type === 0) return null; // rtNone creates the key only.
    if (entry.type === 4) {
        // Unicode installers store each binary byte as one UTF-16 code unit.
        if (!unicode) return { name, type: "REG_BINARY", data: hexBytes(v) };
        if (v.length % 2) throw new Error("Invalid Inno registry binary payload");
        const bytes = new Uint8Array(v.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            if (v[i * 2 + 1] !== 0) throw new Error("Invalid Inno registry binary payload");
            bytes[i] = v[i * 2]!;
        }
        return { name, type: "REG_BINARY", data: hexBytes(bytes) };
    }
    if (entry.type === 6) throw new Error("Inno registry QWORD values are not supported by registry seeds");
    if (![1, 2, 3, 5].includes(entry.type)) throw new Error(`Unsupported Inno registry value type ${entry.type}`);

    let text = decodeRegistryText(v, unicode);
    if (entry.type === 5) text = text.replace(/\{break\}/gi, "\0");
    text = expandAppConstant(text, installRoot);
    if (text.includes("{")) return null;
    if (entry.type === 3) {
        const number = text.trim();
        if (!/^(?:\d+|\$[\da-f]+)$/i.test(number)) throw new Error(`Invalid Inno registry DWORD: ${text}`);
        const data = number.startsWith("$") ? Number.parseInt(number.slice(1), 16) : Number(number);
        if (data > 0xffffffff) throw new Error(`Inno registry DWORD out of range: ${text}`);
        return { name, type: "REG_DWORD", data };
    }
    if (entry.type === 5) {
        // Registry seeds represent REG_MULTI_SZ as UTF-16LE bytes in hex, not an array.
        const terminated = text.replace(/\0+$/, "") + "\0\0";
        const bytes = new Uint8Array(terminated.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < terminated.length; i++) view.setUint16(i * 2, terminated.charCodeAt(i), true);
        return { name, type: "REG_MULTI_SZ", data: hexBytes(bytes) };
    }
    return { name, type: "REG_SZ", data: text };
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

        const value = decodeRegistryValue(entry, unicode, installRoot);
        if (!value && entry.type !== 0) continue;

        const seedKey = `${hive}\\${keyPath}`;
        let seed = byHive.get(seedKey);
        if (!seed) {
            seed = { root: hive, path: keyPath, values: [] };
            byHive.set(seedKey, seed);
        }
        if (value) seed.values.push(value);
    }

    return [...byHive.values()];
}

/**
 * The first `{app}` shortcut: its target AND its command line. Pre-Galaxy GOG installers
 * carry no goggame-*.info, so the shortcut is the only record of how the game is started —
 * and some start it with arguments it cannot run without (Cossacks: European Wars runs
 * `Cossacks.exe .\videos\cdv.avi .\videos\kz.avi .\videos\Logo.avi dmln.exe`, a GOG
 * playlist player that terminates at once when ParamStr(1) is empty).
 */
export function iconEntrypoint(icons: IconEntry[], installRoot = "C:\\"): { exe: string; args?: string } | undefined {
    for (const icon of icons) {
        const target = icon.filename.replace(/\\/g, "/");
        if (target.toLowerCase().includes("{app}")) {
            const rel = target.replace(/^\{app\}[\\/]/i, "");
            if (rel && !rel.includes("{")) {
                const params = resolveAppPath(icon.parameters ?? "", installRoot).trim();
                // A parameter that still names an unresolved Inno constant ({src}, {code:…})
                // cannot be reproduced here; launching without it beats a bogus argument.
                return params && !params.includes("{") ? { exe: rel, args: params } : { exe: rel };
            }
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
        /** Guest installation directory for new installer imports (files + registry default). */
        installDir?: string;
        /** Explicit local DLL policy; never inferred from filenames. */
        appDirDlls?: string[];
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
    const icon = cli.exe || gogInfo.exe ? undefined : iconEntrypoint(opts.parsed.icons ?? [], cli.regInstall ?? "C:\\");
    const exeName = cli.exe
        ?? gogInfo.exe
        ?? icon?.exe
        ?? detectExeFromPaths(filteredPaths);

    if (!exeName) {
        throw new Error("no entrypoint .exe found in installer; specify --exe");
    }

    const name = cli.name ?? gogInfo.name ?? opts.parsed.header.appName ?? "GOG Game";
    // Arguments travel with the entrypoint they were written for: a shortcut's command
    // line is only meaningful when the shortcut also chose the exe.
    const gameArgs = cli.args ?? (gogInfo.exe ? gogInfo.args : icon?.args ?? gogInfo.args);
    const width = cli.width ?? 1024;
    const height = cli.height ?? 768;
    const bpp = cli.bpp ?? 32;
    const ramMB = cli.ramMB ?? 128;
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
            .map((d) => normalizeInnoDestination(d.name.replace(/[\\/]+$/, "")))
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
