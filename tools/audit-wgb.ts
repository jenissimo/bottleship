#!/usr/bin/env bun
/**
 * audit-wgb: does a .wgb actually contain everything its source installer installs?
 *
 * Two silent-loss mechanisms this catches, both proven in the shipped library:
 *   - Inno stores byte-identical files ONCE and points several FileEntries at the same data
 *     location. An extractor that emits only the first name of such a group loses the others
 *     with no error — `starwars-racing` lost `Data\Anims\PlanetG.znm` (the CD sentinel, so the
 *     game looped a disc prompt) plus two `.wav`s; `system-shock-ii` lost both `Binds\CFGB*.BND`.
 *   - A file that IS present but TRUNCATED (Sea Dogs shipped two 0-byte entries). Presence
 *     alone is not the question, so every entry's size is compared against the installer's.
 *
 * Verdicts use the SAME predicates as the packer — `normalizeInnoDestination` decides which
 * destinations become bundle paths and `isGogJunk` decides what is deliberately dropped — so
 * "missing" means "the packer intended this file and it is not there", not "my own path
 * guesswork disagrees". `unresolved` is the third category: a destination the normalizer
 * refuses, i.e. a file no repack can recover until the extractor learns that path shape.
 *
 * Usage:
 *   bun tools/audit-wgb.ts <bundle.wgb> <installer.exe> [--json] [--all]
 *
 * Exit 1 if anything real is missing, truncated, or unresolved, so it can gate a repack.
 *
 * `.wgb` parsing is delegated to `tools/wgb.ts list` on purpose — that tool owns our
 * ZIP64/streaming container reader, and a second copy here would be the next thing to drift.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { BufferSource, parseInnoHeader, normalizeInnoDestination } from "@bottleship/formats/inno";
import type { FileEntry } from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { isGogJunk } from "@bottleship/repack/gog-filter";

const INVALID_LOCATION = 0xffffffff;

interface Finding {
    destination: string;
    relPath: string | null;
    location: number;
    expectedSize: number | null;
    actualSize: number | null;
    /** A sibling name sharing this data that IS in the bundle — the dedup fingerprint. */
    twinPresent: string | null;
    kind: "missing" | "truncated" | "unresolved";
}

function listBundleEntries(wgb: string): Map<string, number> {
    const self = resolve(import.meta.dir, "wgb.ts");
    const res = spawnSync("bun", [self, "list", wgb], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (res.status !== 0) {
        throw new Error(`wgb.ts list failed for ${wgb}: ${res.stderr || res.stdout}`);
    }
    const out = new Map<string, number>();
    for (const line of res.stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;                                   // header / "N entries, M bytes total"
        let p = m[2]!.replace(/\\/g, "/");
        if (p.toLowerCase().startsWith("rom/")) p = p.slice(4);
        out.set(p.toLowerCase(), Number(m[1]));
    }
    return out;
}

/**
 * The entry's output size, or null when the header cannot tell us.
 *
 * `DataEntry.uncompressedSize` is an alias of `fileSize` (see entries/data.ts), so for a
 * zlib-filtered GOG-Galaxy part it is the COMPRESSED size and comparing it against a bundle
 * entry reports a bogus mismatch. Only `assemblySize` knows the real total for those, so a
 * zlib-filtered entry without one gets no size opinion at all — a check that cannot be right
 * must say "unknown", not guess.
 */
function expectedSize(file: FileEntry, dataEntries: ReadonlyArray<{
    fileSize: bigint | number; uncompressedSize: bigint | number; zlibFilter: boolean;
}>): number | null {
    const assembly = Number(file.assemblySize ?? 0);
    if (assembly > 0) return assembly;
    let total = 0;
    for (const loc of [file.location, ...file.additionalLocations]) {
        const d = dataEntries[loc];
        if (!d) return null;
        if (d.zlibFilter) return null;
        total += Number(d.fileSize);
    }
    return total;
}

/**
 * GOG store bookkeeping. `isGogJunk` (the packer's policy) keeps some of these — e.g. it
 * drops `goggame-*.info/json/script` but not `goggame-*.ico` — so absence is never a defect
 * and their presence is not worth a line of output either way.
 */
const GOG_ARTIFACT = /^(goggame-\d+\.\w+|gog\.ico|webcache\.zip|gameinfo|unins\S*|goggame\.dll|language\.ini)$/i;

const isGogArtifact = (rel: string): boolean =>
    GOG_ARTIFACT.test(rel.split("/").pop() ?? "");

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter((a) => a.startsWith("--")));
    const [wgbPath, installerPath] = args.filter((a) => !a.startsWith("--"));
    if (!wgbPath || !installerPath) {
        console.error("Usage: bun tools/audit-wgb.ts <bundle.wgb> <installer.exe> [--json] [--all]");
        process.exit(1);
    }

    const bundle = listBundleEntries(resolve(wgbPath));

    const data = new Uint8Array(readFileSync(resolve(installerPath)));
    const wasmBytes = readFileSync(resolve(import.meta.dir, "../public/unpack-streaming.wasm"));
    const lzma = new UnpackDecoder();
    await lzma.init(
        wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    );
    const info = await parseInnoHeader(new BufferSource(data), lzma);

    // GOG installers reassemble from zlib-filtered parts, which is what makes a bare relative
    // destination legal — the same call the extractor makes for these files.
    const relOf = (f: FileEntry): string | null =>
        normalizeInnoDestination(f.destination, { allowBareRelative: true });

    // Group by data location: more than one destination on one location IS the dedup group.
    const byLocation = new Map<number, FileEntry[]>();
    for (const f of info.files) {
        if (!f.destination || f.location === INVALID_LOCATION) continue;
        const g = byLocation.get(f.location);
        if (g) g.push(f);
        else byLocation.set(f.location, [f]);
    }

    const findings: Finding[] = [];
    let considered = 0;

    for (const [location, group] of [...byLocation.entries()].sort((a, b) => a[0] - b[0])) {
        const resolved = group.map((f) => ({ f, rel: relOf(f) }));
        const twinPresent = resolved.find((r) => r.rel && bundle.has(r.rel.toLowerCase()))?.rel ?? null;

        for (const { f, rel } of resolved) {
            if (rel === null) {
                // Only worth reporting when a sibling proves this data belongs in the bundle,
                // or when nothing in the destination looks installer-runtime.
                if (twinPresent) {
                    findings.push({
                        destination: f.destination, relPath: null, location,
                        expectedSize: expectedSize(f, info.dataEntries), actualSize: null,
                        twinPresent, kind: "unresolved",
                    });
                }
                continue;
            }
            if (isGogJunk(rel) || isGogArtifact(rel)) continue;
            considered++;
            const actual = bundle.get(rel.toLowerCase()) ?? null;
            const expect = expectedSize(f, info.dataEntries);
            if (actual === null) {
                findings.push({
                    destination: f.destination, relPath: rel, location,
                    expectedSize: expect, actualSize: null, twinPresent, kind: "missing",
                });
            } else if (expect !== null && actual !== expect) {
                findings.push({
                    destination: f.destination, relPath: rel, location,
                    expectedSize: expect, actualSize: actual, twinPresent, kind: "truncated",
                });
            }
        }
    }

    const dedupGroups = [...byLocation.values()].filter((g) => g.length > 1).length;

    if (flags.has("--json")) {
        console.log(JSON.stringify({
            bundle: wgbPath, installer: installerPath,
            installerFiles: info.files.length, bundleEntries: bundle.size,
            filesConsidered: considered, dedupGroups, findings,
        }, null, 2));
    } else {
        console.log(`bundle:    ${wgbPath}  (${bundle.size} entries)`);
        console.log(`installer: ${installerPath}  (${info.files.length} file entries, ` +
            `${dedupGroups} dedup groups, ${considered} installable files checked)`);

        const show = (kind: Finding["kind"], title: string) => {
            const rows = findings.filter((f) => f.kind === kind);
            if (!rows.length) return;
            console.log(`\n${title}`);
            for (const r of rows) {
                const size = r.kind === "truncated"
                    ? `  ${r.actualSize} B, expected ${r.expectedSize} B`
                    : r.expectedSize !== null ? `  (${r.expectedSize} B)` : "";
                console.log(`  ${r.destination}${size}`);
                if (r.twinPresent) console.log(`      shares data with: ${r.twinPresent}  (location ${r.location})`);
            }
        };
        show("missing", "MISSING — the packer wants this file and it is not in the bundle:");
        show("truncated", "TRUNCATED — present but the wrong size:");
        show("unresolved", "UNRESOLVED destination — the extractor refuses this path shape " +
            "(a repack will NOT recover it; fix normalizeInnoDestination):");

        if (flags.has("--all")) {
            console.log(`\nAll dedup groups:`);
            for (const [loc, group] of byLocation) {
                if (group.length < 2) continue;
                console.log(`  location ${loc}`);
                for (const f of group) {
                    const rel = relOf(f);
                    const state = rel === null ? "unresolved"
                        : isGogJunk(rel) ? "junk      "
                        : bundle.has(rel.toLowerCase()) ? "ok        " : "MISSING   ";
                    console.log(`     ${state} ${f.destination}`);
                }
            }
        }
        console.log(findings.length
            ? `\n${findings.length} problem(s).`
            : `\nComplete: every installable file is present at its full size.`);
    }

    process.exit(findings.length ? 1 : 0);
}

await main();
