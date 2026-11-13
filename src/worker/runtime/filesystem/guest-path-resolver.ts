/**
 * Guest path lookup expansion for the VFS.
 *
 * Centralizes Win9x/NT system-directory aliasing so file existence, open, and stat
 * probes share one canonical search order instead of per-API special cases.
 */

import { SYSTEM_DIRECTORY_SEGMENTS } from "../../core/hle-system-catalog";

/** Normalize a guest path to `C:\`-rooted form (matches VirtualFileSystem.normalizePath). */
export function normalizeGuestPath(path: string): string {
    const cleaned = path.replace(/\//g, "\\");
    const driveMatch = cleaned.match(/^([A-Za-z]):/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "C";
    const rest = cleaned.replace(/^[A-Za-z]:\\?/, "");
    const parts = rest.split("\\").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
            stack.pop();
            continue;
        }
        // Win32 drops trailing dots and spaces from each component: "Saves." is "Saves".
        stack.push(part.replace(/[. ]+$/, "") || part);
    }
    return `${drive}:\\${stack.join("\\")}`;
}

/**
 * Return an ordered, deduplicated list of absolute guest paths to try when resolving
 * a file on disk. The input path must already be normalized.
 */
export function expandFileLookupPaths(normalizedPath: string): string[] {
    const results: string[] = [normalizedPath];
    const seen = new Set<string>([normalizedPath.toLowerCase()]);

    const lower = normalizedPath.toLowerCase();
    if (!lower.startsWith("c:\\")) {
        return results;
    }

    const rest = lower.slice(3);
    for (const segment of SYSTEM_DIRECTORY_SEGMENTS) {
        const prefix = `${segment}\\`;
        if (rest === segment) {
            for (const alt of SYSTEM_DIRECTORY_SEGMENTS) {
                if (alt === segment) continue;
                pushUnique(results, seen, formatSystemDirPath(alt));
            }
            break;
        }
        if (!rest.startsWith(prefix)) continue;

        const tail = normalizedPath.slice(3 + prefix.length);
        for (const alt of SYSTEM_DIRECTORY_SEGMENTS) {
            if (alt === segment) continue;
            pushUnique(results, seen, formatSystemDirPath(alt, tail));
        }
        break;
    }

    return results;
}

/** Build `C:\WINDOWS\SYSTEM[32]\tail` with canonical Windows directory casing. */
function formatSystemDirPath(segment: string, tail?: string): string {
    const parts = segment.split("\\").map((p) => p.toUpperCase());
    const dir = `C:\\WINDOWS\\${parts.slice(1).join("\\")}`;
    return tail !== undefined && tail.length > 0 ? `${dir}\\${tail}` : dir;
}

function pushUnique(out: string[], seen: Set<string>, path: string): void {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
}
