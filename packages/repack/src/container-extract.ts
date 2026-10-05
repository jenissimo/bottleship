/**
 * Container → installer recursion, driven by an extensible FORMAT REGISTRY.
 *
 * A "container" is any wrapper that yields a flat rel-path → bytes file map: a disc
 * image (ISO9660 / BIN+CUE), a 7z/zip archive, or a host folder. Once unwrapped, the
 * SAME question applies to all of them — "is there an installer/payload inside, and if
 * so what are the real game files?". This module answers it once so every container
 * source in the WGB build pipeline (worker `wgb-build.ts` and the headless `iso-to-wgb`
 * CLI) shares one detection/extraction seam.
 *
 * Adding support for a new installer/repack format = append one `InstallerFormat` to
 * `INSTALLER_FORMATS` (a `{ id, detect, extract }` plugin). Detection runs in registry
 * order and the first format that matches wins, so order encodes priority:
 *   1. EA WinZip self-installer   (`compressed.zip` payload + `common_filelist.txt` manifest)
 *   2. InstallShield 5/6 cabinet  (`<stem>1.hdr` + `<stem>{N}.cab`)
 *   3. FreeArc archive            (`ArC\x01` magic — `.pak`/`.arc`/`.bin` repack payload)
 *   4. PackageForTheWeb self-extractor (MSCF cabinet appended to a stub → InstallShield disk images)
 *   5. Inno Setup, self-contained (a `setup.exe` whose data is embedded in the exe)
 * The EA format is probed FIRST: its container also carries an `eauninstall.exe`/`setup.exe`
 * shell that the Inno probe would waste time parsing, and its signature is unambiguous.
 * FreeArc is probed BEFORE Inno on purpose: Russian repacks ship an Inno `setup.exe`
 * that only carries unarc/ISDone orchestration helpers while the real game lives in
 * external FreeArc `.pak` archives, so the FreeArc payload must take priority.
 * Anything else (a custom installer, or already-extracted game files) passes through
 * unchanged — the caller packages the container contents as-is.
 *
 * Environment-agnostic: depends only on `packages/formats/src/*`, the dependency-free `@bottleship/formats/zip`
 * reader (raw-inflate via the platform `DecompressionStream`), and `gog-filter`. Formats that
 * need a WASM codec (Inno/FreeArc LZMA) receive it via the caller-supplied `ContainerExtractOptions`.
 */

import {
    BufferSource,
    extractInnoToMap,
    parseInnoHeader,
    type InnoParseResult,
} from "@bottleship/formats/inno";
import { UnpackDecoder, Md5 } from "@bottleship/formats/unpack";
import { extractInstallShield, detectInstallShieldStem, parseInstallShieldHeader, resolveInstallPath, FILE_INVALID } from "@bottleship/formats/installshield";
import { findCabinet, parseCabHeader, extractCabToMap, type CabInflateBlock } from "@bottleship/formats/cab";
import { detectFreeArc, extractFreeArcToMap, FreeArcUnsupportedError } from "@bottleship/formats/freearc";
import { unzipToMap } from "@bottleship/formats/zip";
import { isGogJunk } from "./gog-filter";

export type InstallerVia = "ea-winzip" | "installshield" | "inno" | "freearc" | "pftw" | "none";

export interface ContainerExtractOptions {
    /** inno-lzma WASM bytes — required to unpack an Inno installer OR a FreeArc archive
     *  (both reuse the same raw-LZMA1 WASM decoder). */
    innoWasm?: ArrayBuffer;
    /** Raw-deflate override for InstallShield (Node/Bun may inject a zlib impl). */
    inflateRaw?: (chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array;
    /**
     * Dictionary-capable raw-DEFLATE inflater for MSZIP cabinets (PackageForTheWeb).
     * MSZIP presets each block's DEFLATE dictionary to the previous block's last
     * 32 KiB, which `DecompressionStream` cannot express — Node/Bun inject a
     * zlib-backed impl (`inflateRawSync(chunk, { dictionary })`). Absent → a PFTW
     * `.exe` with an MSZIP payload is left packaged as-is.
     */
    cabInflateBlock?: CabInflateBlock;
    /**
     * Resolve an EXTERNAL (loose-on-media) file an InstallShield cabinet references
     * but does not pack (dataOffset=0) — e.g. Max Payne's x_level*.ras, which live
     * loose in Disk1/Levels/ on the CD. Used by the streaming CLI, which does not
     * pre-load the whole disc into the `files` map: it reads the matching disc extent
     * on demand by base name + expected size. The browser path already carries every
     * file in `files`, so it resolves these from that map without this hook.
     */
    resolveExternalFile?: (name: string, size: number) => Promise<Uint8Array | null> | Uint8Array | null;
    onProgress?: (pct: number, label: string) => void;
}

export interface ContainerExtractResult {
    gameFiles: Map<string, Uint8Array>;
    via: InstallerVia;
    /** Human-readable summary (e.g. "InstallShield cabinet 'data'", "no installer — packaged as-is"). */
    note: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * One installer/repack format plugin. `detect` returns an opaque match token (reused by
 * `extract` so detection work isn't repeated) or null when the format is absent. `extract`
 * returns the real game files. Both must be cheap to call when the format is absent.
 */
interface InstallerFormat<M = unknown> {
    id: Exclude<InstallerVia, "none">;
    /** Default note when `extract` doesn't supply one. */
    label: string;
    detect(files: Map<string, Uint8Array>, ctx: ContainerExtractOptions): MaybePromise<M | null>;
    extract(
        files: Map<string, Uint8Array>,
        match: M,
        ctx: ContainerExtractOptions,
    ): Promise<{ gameFiles: Map<string, Uint8Array>; note?: string }>;
}

// --- shared helpers ----------------------------------------------------------------

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect an InstallShield 5/6 installer from a set of relative paths. Returns the cabinet
 * header stem (e.g. "data" for data1.hdr) when the set holds a matching `<stem>1.hdr` +
 * `<stem>1.cab` pair, OR null. A loose `_INST32I.EX_`/`setup.ins` alone is a weaker hint.
 */
export function detectInstallShield(paths: Iterable<string>): { stem: string | null; hasMarkers: boolean } {
    const names = [...paths].map((p) => p.split(/[\\/]/).pop() ?? p);
    const stem = detectInstallShieldStem(names);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    const hasMarkers = lower.has("_inst32i.ex_") || lower.has("setup.ins") || lower.has("data.tag");
    return { stem, hasMarkers };
}

function collectInstallShieldVolumes(
    files: Map<string, Uint8Array>,
    stem: string,
): { header: Uint8Array; volumes: Map<number, Uint8Array> } | null {
    const hdrRe = new RegExp(`^${escapeRegExp(stem)}1\\.hdr$`, "i");
    const cabRe = new RegExp(`^${escapeRegExp(stem)}(\\d+)\\.cab$`, "i");
    const dirOfKey = (k: string) => {
        const n = k.replace(/\\/g, "/");
        const i = n.lastIndexOf("/");
        return i >= 0 ? n.slice(0, i + 1) : "";
    };

    // A disc may carry MORE THAN ONE cabinet set sharing the same stem in different
    // directories — e.g. Max Payne's Disk1/ (the game, data2.cab ≈ 384 MB) beside
    // MAX-FX/setup/ (the level editor, data2.cab ≈ 9 MB). Group strictly by the
    // containing directory so a header is never paired with another set's .cab
    // volumes (which would fail size/MD5 verification), then pick the group with the
    // largest total payload — the real game is the heaviest install on the media.
    interface Group { header?: Uint8Array; volumes: Map<number, Uint8Array>; cabBytes: number; }
    const groups = new Map<string, Group>();
    const groupFor = (dir: string): Group => {
        let g = groups.get(dir);
        if (!g) { g = { volumes: new Map(), cabBytes: 0 }; groups.set(dir, g); }
        return g;
    };
    for (const [rel, data] of files) {
        const base = rel.split(/[\\/]/).pop() ?? rel;
        const dir = dirOfKey(rel);
        if (hdrRe.test(base)) { groupFor(dir).header = data; continue; }
        const m = cabRe.exec(base);
        if (m) {
            const g = groupFor(dir);
            g.volumes.set(parseInt(m[1]!, 10), data);
            g.cabBytes += data.length;
        }
    }

    let best: Group | null = null;
    for (const g of groups.values()) {
        if (g.volumes.size === 0) continue;
        if (!g.header) {
            const primary = g.volumes.get(1);
            if (!primary || primary.length < 20 || new DataView(primary.buffer, primary.byteOffset).getUint32(0, true) !== 0x28635349) continue;
            const info = parseInstallShieldHeader(primary);
            if (info.major > 5) continue;
            g.header = primary; // IS5 may embed its descriptor in the first cabinet.
        }
        const info = parseInstallShieldHeader(g.header);
        if (!info.files.some(f => !(f.flags & FILE_INVALID) && f.name && resolveInstallPath(f, info) !== null)) continue;
        if (!best || g.cabBytes > best.cabBytes) best = g;
    }
    if (!best) return null;
    return { header: best.header!, volumes: best.volumes };
}

/** Lazily build + init the shared raw-LZMA1 WASM decoder (Inno + FreeArc both use it). */
async function makeLzma(ctx: ContainerExtractOptions): Promise<UnpackDecoder | null> {
    if (!ctx.innoWasm) return null;
    const lzma = new UnpackDecoder();
    await lzma.init(ctx.innoWasm);
    return lzma;
}

// --- format plugins ----------------------------------------------------------------

const normSlash = (s: string) => s.replace(/\\/g, "/");
const dirOf = (k: string) => {
    const n = normSlash(k);
    const i = n.lastIndexOf("/");
    return i >= 0 ? n.slice(0, i + 1) : "";
};

/** Translate a DOS filename glob (`*.*`, `*`, `*.abk`, `file?.bin`) to a case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
    // `*.*` and `*` are the DOS "every file" idioms (match names with OR without an extension).
    if (glob === "*.*" || glob === "*") return /^.*$/;
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${esc}$`, "i");
}

/**
 * EA's WinZip self-installer ships its game tree inside `compressed.zip` and lists the extra
 * loose files setup.exe copies alongside it (audio banks/streams, uninstaller, EULA support)
 * in `common_filelist.txt`. Resolve those manifest lines against the container's files.
 *
 * Each line is `flag,flag,relpath[ /s]` — backslash path, optional DOS wildcard, optional `/s`
 * recurse switch. Returns a game-root-relative (forward-slash) → bytes map of just the loose
 * payload (the installer/autorun shell — AutoRun.exe, setup.exe, ReadMe — is NOT listed, so it
 * is naturally excluded).
 */
function eaResolveLooseFiles(
    filelist: string,
    root: string,
    files: Map<string, Uint8Array>,
): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    // Case-insensitive index of the container by normalized lower-case path.
    const index = new Map<string, { key: string; data: Uint8Array }>();
    for (const [k, data] of files) index.set(normSlash(k).toLowerCase(), { key: k, data });

    for (const raw of filelist.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#")) continue;
        const parts = line.split(",");
        if (parts.length < 3) continue;
        let spec = parts.slice(2).join(",").trim();
        const recurse = /\s\/s\b/i.test(spec);
        spec = spec.replace(/\s+\/[a-z]\b.*$/i, "").trim(); // strip trailing switches (/s, …)
        const rel = normSlash(spec);
        if (!rel) continue;

        if (rel.includes("*") || rel.includes("?")) {
            const slash = rel.lastIndexOf("/");
            const dirRel = slash >= 0 ? rel.slice(0, slash + 1) : "";
            const glob = slash >= 0 ? rel.slice(slash + 1) : rel;
            const re = globToRegExp(glob);
            const dirAbs = (root + dirRel).toLowerCase();
            for (const [lk, v] of index) {
                if (!lk.startsWith(dirAbs)) continue;
                const tail = lk.slice(dirAbs.length);
                if (!recurse && tail.includes("/")) continue; // non-recursive → direct children only
                const base = tail.split("/").pop() ?? tail;
                if (re.test(base)) out.set(normSlash(v.key).slice(root.length), v.data);
            }
        } else {
            const hit = index.get((root + rel).toLowerCase());
            if (hit) out.set(rel, hit.data);
        }
    }
    return out;
}

const eaWinzipFormat: InstallerFormat<{
    compressed: Uint8Array;
    filelist: Uint8Array;
    root: string;
    files: Map<string, Uint8Array>;
}> = {
    id: "ea-winzip",
    label: "EA WinZip self-installer",
    detect(files) {
        // Signature: a `compressed.zip` game payload + the `common_filelist.txt` manifest,
        // both at the same directory level (the installer root). Used by EA demos of the
        // early-2000s (NFS Underground/Most Wanted, Burnout, …) packed as WinZip self-extractors.
        let compressedKey: string | undefined;
        let filelistKey: string | undefined;
        for (const k of files.keys()) {
            const base = (k.split(/[\\/]/).pop() ?? k).toLowerCase();
            if (base === "compressed.zip") compressedKey = k;
            else if (base === "common_filelist.txt") filelistKey = k;
        }
        if (!compressedKey || !filelistKey) return null;
        const root = dirOf(compressedKey);
        if (dirOf(filelistKey) !== root) return null; // must share the installer root
        return { compressed: files.get(compressedKey)!, filelist: files.get(filelistKey)!, root, files };
    },
    async extract(_files, m) {
        const gameFiles = new Map<string, Uint8Array>();
        // 1. the game tree lives in compressed.zip.
        const inner = await unzipToMap(m.compressed);
        for (const [rel, data] of inner) gameFiles.set(normSlash(rel), data);
        // 2. the loose payload named in common_filelist.txt (audio, uninstaller, EULA).
        const loose = eaResolveLooseFiles(new TextDecoder("latin1").decode(m.filelist), m.root, m.files);
        for (const [rel, data] of loose) gameFiles.set(rel, data);
        return {
            gameFiles,
            note: `EA WinZip self-installer (compressed.zip + ${loose.size} loose files)`,
        };
    },
};

const installShieldFormat: InstallerFormat<{ header: Uint8Array; volumes: Map<number, Uint8Array> }> = {
    id: "installshield",
    label: "InstallShield cabinet",
    detect(files) {
        const { stem } = detectInstallShield(files.keys());
        if (stem) return collectInstallShieldVolumes(files, stem);
        let best: ReturnType<typeof collectInstallShieldVolumes> = null;
        let bestSize = 0;
        for (const rel of files.keys()) {
            const candidate = /(?:^|[\\/])([^_\\/][^\\/]*)1\.cab$/i.exec(rel)?.[1];
            if (!candidate) continue;
            const vols = collectInstallShieldVolumes(files, candidate);
            if (!vols) continue;
            const size = [...vols.volumes.values()].reduce((sum, bytes) => sum + bytes.length, 0);
            if (size > bestSize) { best = vols; bestSize = size; }
        }
        return best;
    },
    async extract(files, vols, ctx) {
        // Basename index of the container, for resolving EXTERNAL files the cabinet
        // references but doesn't pack (dataOffset=0). The browser passes the whole
        // disc in `files`, so the loose payload (Max Payne's Levels/x_level*.ras) is
        // here; the streaming CLI instead supplies ctx.resolveExternalFile.
        const resolveLoose = createInstallShieldExternalResolver(files);
        const gameFiles = await extractInstallShield(vols.header, vols.volumes, {
            verifySize: true,
            verifyMd5: true,
            inflateRaw: ctx.inflateRaw,
            resolveExternal: async (fd, outPath) => {
                if (ctx.resolveExternalFile) {
                    const ext = await ctx.resolveExternalFile(fd.name, fd.expanded);
                    if (ext) return ext;
                }
                return resolveLoose(fd.name, fd.expanded, outPath, fd.md5 ?? undefined);
            },
            onProgress: (done, total, name) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                ctx.onProgress?.(pct, `Extracting ${name}`);
            },
        });
        if (gameFiles.size === 0) throw new Error('InstallShield cabinet contains no available game payload');
        return { gameFiles, note: "InstallShield cabinet" };
    },
};

/** Resolve loose media files without confusing equal basenames in different directories. */
export function createInstallShieldExternalResolver(files: Map<string, Uint8Array>) {
    const byBase = new Map<string, Array<{ path: string; data: Uint8Array }>>();
    for (const [rel, data] of files) {
        const path = normSlash(rel).toLowerCase();
        const base = path.split('/').pop()!;
        const candidates = byBase.get(base) ?? [];
        candidates.push({ path, data });
        byBase.set(base, candidates);
    }
    return (name: string, size: number, installPath: string, md5?: Uint8Array): Uint8Array | null => {
        let candidates = (byBase.get(name.toLowerCase()) ?? []).filter(c => c.data.length === size);
        if (candidates.length > 1 && md5?.some(byte => byte !== 0)) {
            candidates = candidates.filter(c => {
                const hash = new Md5(); hash.update(c.data);
                return hash.finalize().every((byte, i) => byte === md5[i]);
            });
            if (!candidates.length) throw new Error(`No checksum-matching InstallShield external file: ${installPath}`);
        }
        const wanted = normSlash(installPath).toLowerCase();
        const exact = candidates.filter(c => c.path === wanted || c.path.endsWith(`/${wanted}`));
        const matches = exact.length ? exact : candidates;
        if (matches.length > 1 && matches.some(c => c.data.some((byte, i) => byte !== matches[0]!.data[i]))) {
            throw new Error(`Ambiguous InstallShield external file: ${installPath} (${size} bytes)`);
        }
        return matches[0]?.data ?? null;
    };
}

const freeArcFormat: InstallerFormat<{ name: string; data: Uint8Array }[]> = {
    id: "freearc",
    label: "FreeArc archive",
    detect(files, ctx) {
        if (!ctx.innoWasm) return null; // FreeArc needs the shared LZMA codec to decode
        // A repack ships its payload as one or more FreeArc archives (any extension —
        // `.pak`/`.arc`/`.bin`), recognized by the "ArC\x01" magic at byte 0.
        const archives: { name: string; data: Uint8Array }[] = [];
        for (const [rel, data] of files) {
            if (detectFreeArc(data)) archives.push({ name: rel, data });
        }
        return archives.length ? archives : null;
    },
    async extract(_files, archives, ctx) {
        const lzma = await makeLzma(ctx);
        if (!lzma) throw new Error("FreeArc archive found but no LZMA WASM provided (innoWasm)");
        const gameFiles = new Map<string, Uint8Array>();
        // Multi-volume repacks (data001.pak, data002.pak, …) are independent archives that
        // each carry part of the tree; merge them (sort by name for deterministic order).
        const ordered = [...archives].sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < ordered.length; i++) {
            const arc = ordered[i]!;
            const part = await extractFreeArcToMap(arc.data, lzma, {
                wantFile: (rel) => !isGogJunk(rel),
                onProgress: (pct, label) => ctx.onProgress?.(pct, `${label} (${i + 1}/${ordered.length})`),
            });
            for (const [rel, bytes] of part) gameFiles.set(rel, bytes);
        }
        return { gameFiles, note: `FreeArc archive${ordered.length > 1 ? `s (${ordered.length} volumes)` : ""}` };
    },
};

const innoFormat: InstallerFormat<{ bytes: Uint8Array; parsed: InnoParseResult; lzma: UnpackDecoder }> = {
    id: "inno",
    label: "embedded Inno Setup installer",
    async detect(files, ctx) {
        const lzma = await makeLzma(ctx);
        if (!lzma) return null; // Inno needs the LZMA codec to parse its header
        // A self-contained Inno setup.exe carries its data embedded in the exe. Multi-slice
        // Inno (`setup-1.bin` siblings) is intentionally not auto-driven here — a container
        // holding a split Inno installer needs slice ordering the caller owns.
        for (const [rel, data] of files) {
            const base = (rel.split(/[\\/]/).pop() ?? rel).toLowerCase();
            if (!base.endsWith(".exe")) continue;
            if (data.length < 2 || data[0] !== 0x4d || data[1] !== 0x5a) continue; // not MZ
            try {
                const parsed = await parseInnoHeader(new BufferSource(data), lzma);
                if (parsed.offsets.dataOffset) return { bytes: data, parsed, lzma }; // embedded data only
            } catch {
                /* not an Inno installer — keep scanning */
            }
        }
        return null;
    },
    async extract(_files, match, ctx) {
        const gameFiles = await extractInnoToMap(
            new BufferSource(match.bytes),
            {
                wantFile: (rel) => !isGogJunk(rel),
                onProgress: (done, total) => {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    ctx.onProgress?.(pct, "Extracting Inno installer");
                },
            },
            match.lzma,
            match.parsed,
        );
        return { gameFiles, note: "embedded Inno Setup installer" };
    },
};

/**
 * InstallShield "PackageForTheWeb" self-extractor: a standard MS Cabinet (MSCF)
 * APPENDED to a small Win32 stub (`stub32i.exe`), holding the real InstallShield
 * disk images (`data1.hdr` + `data{N}.cab` + `Setup.exe` + `setup.inx` …). We
 * unwrap the cabinet, then RECURSE into installer detection so the InstallShield
 * reader (a lower-priority format above) turns those disk images into game files.
 * Probed before Inno because a PFTW stub is an MZ exe the Inno scanner would parse.
 */
const pftwFormat: InstallerFormat<{ exe: Uint8Array }> = {
    id: "pftw",
    label: "InstallShield PackageForTheWeb self-extractor",
    detect(files) {
        // An appended MSCF whose file table names an InstallShield disk image
        // (`*1.hdr` / `setup.inx`) — parseCabHeader is cheap (no decompression).
        for (const [rel, data] of files) {
            const base = (rel.split(/[\\/]/).pop() ?? rel).toLowerCase();
            if (!base.endsWith(".exe")) continue;
            if (data.length < 4 || data[0] !== 0x4d || data[1] !== 0x5a) continue; // not MZ
            const off = findCabinet(data);
            if (off == null) continue;
            const cab = parseCabHeader(data, off);
            if (!cab) continue;
            const hasInstaller = cab.files.some((f) => {
                const n = f.name.toLowerCase();
                return /1\.hdr$/.test(n) || n.endsWith("setup.inx") || n.endsWith("setup.ins");
            });
            if (hasInstaller) return { exe: data };
        }
        return null;
    },
    async extract(_files, match, ctx) {
        const cabFiles = await extractCabToMap(match.exe, {
            inflateBlock: ctx.cabInflateBlock,
            onProgress: (done, total, name) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                ctx.onProgress?.(pct, `Unwrapping ${name}`);
            },
        });
        // The cabinet holds InstallShield disk images — recurse so the installShield
        // format (or another) turns them into the real game files.
        const inner = await extractInstallerFromFiles(cabFiles, ctx);
        return {
            gameFiles: inner.gameFiles,
            note: `PackageForTheWeb → ${inner.note}`,
        };
    },
};

/**
 * The format registry. Detection runs top-to-bottom; the first match wins. Order encodes
 * priority — see the module header for why FreeArc precedes Inno.
 */
const INSTALLER_FORMATS: InstallerFormat<any>[] = [eaWinzipFormat, installShieldFormat, freeArcFormat, pftwFormat, innoFormat];

// --- the recursion ------------------------------------------------------------------

/**
 * Detect and unpack an installer/repack payload inside a container's file map. Returns the
 * real game files (`via` = which format), or the input map unchanged (`via` = "none") when
 * no supported format is present.
 */
export async function extractInstallerFromFiles(
    files: Map<string, Uint8Array>,
    opts: ContainerExtractOptions = {},
): Promise<ContainerExtractResult> {
    let unsupportedNote: string | undefined;
    for (const fmt of INSTALLER_FORMATS) {
        const match = await fmt.detect(files, opts);
        if (match == null) continue;
        try {
            const { gameFiles, note } = await fmt.extract(files, match, opts);
            return { gameFiles, via: fmt.id, note: note ?? fmt.label };
        } catch (e) {
            // A format we DETECTED but can't fully extract (e.g. a FreeArc payload using the
            // srep filter we don't decode yet) shouldn't abort the whole build — record it
            // and STOP: this format IS the payload, so don't fall through to a lower-priority
            // format (e.g. the Inno `setup.exe` shell that only orchestrates unarc and would
            // "extract" zero game files). Package the container as-is instead. Real extraction
            // failures (corrupt cabinet, bad LZMA) propagate.
            if (e instanceof FreeArcUnsupportedError) {
                unsupportedNote = `FreeArc payload uses unsupported filter "${e.filter}" — packaged as-is`;
                break;
            }
            throw e;
        }
    }
    return {
        gameFiles: files,
        via: "none",
        note: unsupportedNote ?? "no supported installer — packaged as-is",
    };
}
