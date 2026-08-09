/**
 * Path collision resolution — ported from innoextract cli/extract.cpp handle_collision (390-457)
 * and filter_entries file loop (798-891).
 */

import type { DataEntry } from "./entries/data";
import type { FileEntry } from "./entries/file";
import { DirectoryCasingRegistry } from "./directory-casing";
import { normalizeInnoDestination } from "./paths";

const INVALID_LOCATION = 0xffffffff;

/** file.cpp stored_flag_reader bits */
const ConfirmOverwrite = 1 << 0;
const DeleteAfterInstall = 1 << 3;
const CompareTimeStamp = 1 << 7;
const OverwriteReadOnly = 1 << 10;
const OverwriteSameVersion = 1 << 11;
const IgnoreVersion = 1 << 17;
const PromptIfOlder = 1 << 18;
const ReplaceSameVersionIfContentsDiffer = 1 << 22;

/** data.cpp — VersionInfoValid */
const VersionInfoValid = 1 << 0;

export interface SelectedFile {
    file: FileEntry;
    relPath: string;
}

function isGalaxyReassembledFile(file: FileEntry, dataEntries: DataEntry[]): boolean {
    if (file.additionalLocations.length > 0) return true;
    if (file.galaxyChecksumType !== "none") return true;
    return dataEntries[file.location]?.zlibFilter ?? false;
}

function checksumsEqual(a: DataEntry, b: DataEntry): boolean {
    if (a.checksumType !== b.checksumType) return false;
    if (a.checksum.byteLength !== b.checksum.byteLength) return false;
    for (let i = 0; i < a.checksum.byteLength; i++) {
        if (a.checksum[i] !== b.checksum[i]) return false;
    }
    return true;
}

/**
 * Returns null if `newFile` should replace `oldFile`, or a skip reason string to keep `oldFile`.
 * extract.cpp:390-457
 */
export function handleCollision(
    oldFile: FileEntry,
    oldData: DataEntry,
    newFile: FileEntry,
    newData: DataEntry,
): string | null {
    let allowTimestamp = true;

    if ((newFile.options & IgnoreVersion) === 0) {
        const newVersionValid = (newData.options & VersionInfoValid) !== 0;

        if ((oldData.options & VersionInfoValid) !== 0) {
            allowTimestamp = false;

            if (!newVersionValid || oldData.fileVersion > newData.fileVersion) {
                if ((newFile.options & PromptIfOlder) === 0) {
                    return "old version";
                }
            } else if (
                newData.fileVersion === oldData.fileVersion
                && (newFile.options & OverwriteSameVersion) === 0
            ) {
                if (
                    (newFile.options & ReplaceSameVersionIfContentsDiffer) !== 0
                    && checksumsEqual(oldData, newData)
                ) {
                    return "duplicate (checksum)";
                }
                if ((newFile.options & CompareTimeStamp) === 0) {
                    return "duplicate (version)";
                }
                allowTimestamp = true;
            }
        } else if (newVersionValid) {
            allowTimestamp = false;
        }
    }

    if (allowTimestamp && (newFile.options & CompareTimeStamp) !== 0) {
        if (newData.timestamp === oldData.timestamp) {
            return "duplicate (modification time)";
        }
        if (newData.timestamp < oldData.timestamp) {
            if ((newFile.options & PromptIfOlder) === 0) {
                return "old version (modification time)";
            }
        }
    }

    if ((newFile.options & ConfirmOverwrite) !== 0) {
        // prompt_overwrite() always true in innoextract — proceed with overwrite
    }

    if (
        oldFile.attributes !== 0xffffffff
        && (oldFile.attributes & 0x1) !== 0
        && (newFile.options & OverwriteReadOnly) === 0
    ) {
        // read-only — prompt_overwrite always true
    }

    return null;
}

/** filter_entries file loop — pick one winner per case-insensitive destination path */
export function filterExtractableFiles(
    files: FileEntry[],
    dataEntries: DataEntry[],
    /** Per-entry eligibility (e.g. the Check: language guard). Applied BEFORE the collision
     *  contest, as a real install does: an entry whose Check fails is never installed, so it
     *  must not be able to win a path against the entry that IS installed — filtering after
     *  the contest drops the path entirely (the winner is discarded, the loser is gone). */
    wantEntry?: (file: FileEntry) => boolean,
): SelectedFile[] {
    const winners = new Map<string, SelectedFile>();
    const dirCasing = new DirectoryCasingRegistry();

    for (const file of files) {
        if (wantEntry && !wantEntry(file)) continue;
        if (file.location === INVALID_LOCATION) continue;
        if (file.location >= dataEntries.length) continue;
        if (file.externalSize > 0n) continue;
        if ((file.options & DeleteAfterInstall) !== 0) continue;

        if (!file.destination) continue;
        let rel = normalizeInnoDestination(file.destination, {
            allowBareRelative: isGalaxyReassembledFile(file, dataEntries),
        });
        if (!rel) continue;
        rel = dirCasing.fixPath(rel);

        const internal = rel.toLowerCase();
        const existing = winners.get(internal);
        if (!existing) {
            winners.set(internal, { file, relPath: rel });
            continue;
        }

        const oldData = dataEntries[existing.file.location];
        const newData = dataEntries[file.location];
        if (!oldData || !newData) continue;

        const skip = handleCollision(existing.file, oldData, file, newData);
        if (skip === null) {
            winners.set(internal, { file, relPath: rel });
        }
    }

    return [...winners.values()];
}
