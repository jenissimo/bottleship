/**
 * GOG Inno installer → in-memory WGB orchestrator.
 */

import {
    BufferSource,
    extractInnoToMap,
    parseInnoHeader,
    detectInstallerLanguages,
    defaultLanguage,
    type InnoParseResult,
    type RandomAccessSource,
    type SliceSource,
} from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { isGogJunk } from "./gog-filter";
import { loadOverrides, getOverride } from "./overrides";
import { guessCacheKey, parseGogGameInfo, type SynthOptions } from "./manifest-synth";
import { synthesizeInstallerManifest } from "./installer-layout";
import { buildZip } from "@bottleship/formats/wgb/zip-build";

export interface InstallProgress {
    phase: "reading" | "installing" | "packing" | "starting";
    doneBytes: number;
    totalBytes: number;
}

export interface InstallerToWgbOptions {
    source: RandomAccessSource;
    wasmBytes: ArrayBuffer;
    /** When set, skips redundant parseInnoHeader on cache-miss (worker already parsed for cache key). */
    parsed?: InnoParseResult;
    /** External `.bin` data slices for multi-part installers (offsets.dataOffset === 0). */
    sliceSource?: SliceSource;
    keepGog?: boolean;
    overrides?: import("./overrides").GogOverridesDb;
    onProgress?: (p: InstallProgress) => void;
    synth?: SynthOptions["cli"];
    /** Locale to install for a multi-language installer (e.g. "en-US"). When omitted, the
     *  English default is chosen (defaultLanguage). Without this, per-language file variants
     *  (e.g. GOG XIII's 5 system\Default.ini) collapse last-write-wins to the wrong language. */
    language?: string;
}

export interface InstallerToWgbResult {
    wgb: Uint8Array;
    cacheKey?: string;
    gameId?: string;
    name: string;
    /** Locales the installer offered (empty for single-language installers). */
    availableLanguages: string[];
    /** The locale actually extracted (undefined for single-language installers). */
    language?: string;
}

export async function installerToWgb(opts: InstallerToWgbOptions): Promise<InstallerToWgbResult> {
    const lzma = new UnpackDecoder();
    await lzma.init(opts.wasmBytes);

    opts.onProgress?.({ phase: "reading", doneBytes: 0, totalBytes: 0 });
    const parsed = opts.parsed ?? await parseInnoHeader(opts.source, lzma);

    const filterGog = !opts.keepGog;

    // Multi-language installer: pick one locale (caller's choice, else English default) so
    // per-language file variants don't collapse last-write-wins to the wrong language.
    const availableLanguages = detectInstallerLanguages(parsed.files);
    const language = opts.language ?? defaultLanguage(availableLanguages);

    opts.onProgress?.({ phase: "installing", doneBytes: 0, totalBytes: 0 });

    const extracted = await extractInnoToMap(opts.source, {
        wantFile: (rel) => {
            const base = rel.split("/").pop() ?? "";
            if (/^goggame-.*\.(info|script)$/i.test(base)) return true;
            return !filterGog || !isGogJunk(rel);
        },
        language,
        onProgress: (done, total) => {
            opts.onProgress?.({ phase: "installing", doneBytes: done, totalBytes: total });
        },
    }, lzma, parsed, opts.sliceSource);

    const db = await loadOverrides(opts.overrides);
    const gogMeta = parseGogGameInfo(extracted);
    const override = getOverride(db, gogMeta.gameId);
    const synth = synthesizeInstallerManifest({
        parsed,
        gameFiles: extracted,
        override,
        cli: opts.synth,
    });

    opts.onProgress?.({ phase: "packing", doneBytes: 0, totalBytes: extracted.size });

    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(synth.manifest, null, 2)));
    files.set("registry.json", new TextEncoder().encode(JSON.stringify(synth.registry, null, 2)));

    for (const [rel, data] of extracted) {
        if (filterGog && isGogJunk(rel)) continue;
        files.set(synth.romPrefix + rel, data);
    }

    const wgb = buildZip(files);
    opts.onProgress?.({ phase: "starting", doneBytes: wgb.byteLength, totalBytes: wgb.byteLength });

    return {
        wgb,
        cacheKey: synth.cacheKey,
        gameId: synth.gameId,
        name: String(synth.manifest.name ?? "GOG Game"),
        availableLanguages,
        language,
    };
}

export async function installerBytesToWgb(
    data: Uint8Array,
    wasmBytes: ArrayBuffer,
    options: Omit<InstallerToWgbOptions, "source" | "wasmBytes"> = {},
): Promise<InstallerToWgbResult> {
    return installerToWgb({
        ...options,
        source: new BufferSource(data),
        wasmBytes,
    });
}
