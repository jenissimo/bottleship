import * as nodePath from "path";

/** Why one untrusted archive entry cannot be written below the extraction root. */
export type ArchivePathRejection =
    /** Nothing left to write — e.g. a directory entry identical to the prefix being stripped. */
    | "empty"
    | "nul"
    | "absolute"
    | "traversal"
    | "escapes-root";

export type ArchivePathResult =
    | { ok: true; path: string }
    | { ok: false; reason: ArchivePathRejection; entry: string };

/** The subset of `node:path` the resolver needs; injectable so the win32 rules stay testable off Windows. */
type PathImpl = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;

/**
 * Resolve one untrusted archive entry below `root`, refusing every escape spelling.
 *
 * `./a` and `a//b` are ordinary Unix zip spellings, so they are NORMALISED, not refused —
 * only a real escape (`..`, absolute, drive, UNC, NUL) is rejected. Callers decide whether a
 * rejection is fatal; a bulk extractor should skip the entry rather than abandon the archive.
 */
export function tryResolveArchiveExtractPath(
    root: string,
    archiveName: string,
    path: PathImpl = nodePath,
): ArchivePathResult {
    if (archiveName.includes("\0")) return { ok: false, reason: "nul", entry: archiveName };
    const normalized = archiveName.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        return { ok: false, reason: "absolute", entry: archiveName };
    }
    const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.includes("..")) return { ok: false, reason: "traversal", entry: archiveName };
    if (segments.length === 0) return { ok: false, reason: "empty", entry: archiveName };

    const rootPath = path.resolve(root);
    const outputPath = path.resolve(rootPath, ...segments);
    const rel = path.relative(rootPath, outputPath);
    // A slash-free segment can still escape: win32 `resolve` reads `Q:` as a drive-relative
    // root, so containment must be re-checked after resolution, not inferred from the segments.
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return { ok: false, reason: "escapes-root", entry: archiveName };
    }
    return { ok: true, path: outputPath };
}

/** Throwing form of {@link tryResolveArchiveExtractPath}, for callers whose per-entry loop already handles errors. */
export function resolveArchiveExtractPath(root: string, archiveName: string): string {
    const result = tryResolveArchiveExtractPath(root, archiveName);
    if (!result.ok) {
        throw new Error(`archive entry rejected (${result.reason}): ${JSON.stringify(archiveName)}`);
    }
    return result.path;
}
