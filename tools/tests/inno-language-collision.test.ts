/**
 * Per-language file variants must survive collision resolution.
 *
 * A multi-language Inno installer stores one [Files] entry per locale for the SAME
 * destination, distinguished only by `Check:`. Resolving the path collision before
 * applying the locale filter lets a foreign-language entry win the path and then be
 * discarded — the file vanishes from the install entirely (GOG XIII lost both
 * `system\Default.ini` and the `goggame-*.info` that names the real entrypoint).
 */

import { describe, expect, test } from "bun:test";
import { filterExtractableFiles } from "@bottleship/formats/inno";
import { checkAllowsLanguage } from "@bottleship/formats/inno/check-lang";
import type { FileEntry } from "@bottleship/formats/inno/entries/file";
import type { DataEntry } from "@bottleship/formats/inno/entries/data";

function fileEntry(destination: string, check: string, location: number): FileEntry {
    return {
        source: "", destination, installFontName: "", strongAssemblyName: "",
        components: "", tasks: "", languages: "", check, afterInstall: "", beforeInstall: "",
        location, attributes: 0, externalSize: 0n, permission: -1, options: 0, type: 0,
        additionalLocations: [], assemblySize: 0n, galaxyChecksumType: "none",
        galaxyChecksum: new Uint8Array(0),
    };
}

function dataEntry(): DataEntry {
    return {
        firstSlice: 0, lastSlice: 0, sortOffset: 0, fileOffset: 0n, fileSize: 16n,
        chunkSize: 16n, uncompressedSize: 16n, checksum: new Uint8Array(4),
        checksumType: "crc32", timestamp: 0n, fileVersion: 0n, options: 0, sign: 0,
        // GOG's Galaxy-reassembled parts — also what makes the bare-relative
        // destination (no {app} prefix) a valid install path.
        chunkCompressed: false, zlibFilter: true,
    };
}

const gogCheck = (locale: string) => `check_if_install('${locale}#','32#64#','')`;

describe("filterExtractableFiles + language Check", () => {
    // Chosen locale first, foreign last: without the pre-filter the LAST entry wins the
    // path and the locale filter then drops it, losing the file.
    const files = [
        fileEntry("system\\Default.ini", gogCheck("en-US"), 0),
        fileEntry("system\\Default.ini", gogCheck("de-DE"), 1),
        fileEntry("system\\Default.ini", gogCheck("fr-FR"), 2),
    ];
    const dataEntries = [dataEntry(), dataEntry(), dataEntry()];

    test("keeps the chosen locale's variant", () => {
        const selected = filterExtractableFiles(files, dataEntries,
            (f) => checkAllowsLanguage(f.check, "en-US"));
        expect(selected.map((s) => s.relPath)).toEqual(["system/Default.ini"]);
        expect(selected[0]!.file.location).toBe(0);
    });

    test("post-filtering the winner is what loses the file", () => {
        const lateFiltered = filterExtractableFiles(files, dataEntries)
            .filter((s) => checkAllowsLanguage(s.file.check, "en-US"));
        expect(lateFiltered).toHaveLength(0);
    });

    test("no locale chosen keeps a single (last-write-wins) variant", () => {
        expect(filterExtractableFiles(files, dataEntries)).toHaveLength(1);
    });
});
