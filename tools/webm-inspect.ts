#!/usr/bin/env bun
/**
 * webm-inspect: dump the tracks and frames of a Matroska/WebM file.
 *
 * The demuxer is the browser-safe core (`packages/formats/src/matroska/index.ts`); this CLI
 * adds the Node-side fs so the reader is exercisable headless against real game assets
 * (a title may ship WebM under any extension — the EBML magic is what identifies it).
 *
 * Usage:
 *   bun tools/webm-inspect.ts <file> [--frames N] [--track N] [--count] [--json]
 *
 *   --frames N   list the first N frames (default 5; 0 = none)
 *   --track N    restrict the frame listing/count to one track number
 *   --count      walk every cluster and report per-track frame/keyframe/byte totals
 *   --json       machine-readable output
 */

import { readFileSync } from "node:fs";
import { BufferSource } from "../packages/formats/src/unpack/source";
import {
    parseMatroska, readFrames, assertDecodable, isMatroska, MatroskaError,
} from "../packages/formats/src/matroska";

function flagValue(name: string): string | null {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const positional = process.argv.slice(2).filter((a, i, all) => {
    if (a.startsWith("--")) return false;
    const prev = all[i - 1];
    return !(prev === "--frames" || prev === "--track");
});
const input = positional[0];
if (!input) {
    console.error("usage: bun tools/webm-inspect.ts <file> [--frames N] [--track N] [--count] [--json]");
    process.exit(1);
}

const frameLimit = Number(flagValue("--frames") ?? 5);
const trackFilter = flagValue("--track") != null ? Number(flagValue("--track")) : null;
const doCount = process.argv.includes("--count");
const asJson = process.argv.includes("--json");

const data = new Uint8Array(readFileSync(input));
if (!isMatroska(data)) {
    console.error(`${input}: not a Matroska/WebM file (EBML magic 1A 45 DF A3 absent)`);
    process.exit(2);
}

const src = new BufferSource(data);
let file;
try {
    file = parseMatroska(src);
} catch (err) {
    console.error(`${input}: ${(err as Error).message}`);
    process.exit(2);
}

const trackNumbers = trackFilter != null ? [trackFilter] : undefined;

interface TrackStats { frames: number; keyframes: number; bytes: number; firstTsNs: number; lastTsNs: number }
const stats = new Map<number, TrackStats>();
if (doCount) {
    for (const f of readFrames(src, file, { trackNumbers })) {
        let st = stats.get(f.trackNumber);
        if (!st) { st = { frames: 0, keyframes: 0, bytes: 0, firstTsNs: f.timestampNs, lastTsNs: f.timestampNs }; stats.set(f.trackNumber, st); }
        st.frames++;
        if (f.isKeyframe) st.keyframes++;
        st.bytes += f.data.length;
        st.lastTsNs = f.timestampNs;
    }
}

const firstFrames = frameLimit > 0
    ? Array.from(readFrames(src, file, { trackNumbers, limit: frameLimit }))
    : [];

const refusals = file.tracks.map((t) => {
    try { assertDecodable(t); return null; } catch (e) { return (e as MatroskaError).message; }
});

if (asJson) {
    console.log(JSON.stringify({
        docType: file.docType,
        timecodeScale: file.timecodeScale,
        durationNs: file.durationNs,
        muxingApp: file.muxingApp,
        writingApp: file.writingApp,
        tracks: file.tracks.map((t, i) => ({ ...t, codecPrivate: t.codecPrivate?.length ?? 0, refusal: refusals[i] })),
        stats: Object.fromEntries(stats),
        firstFrames: firstFrames.map((f) => ({ ...f, data: f.data.length })),
    }, null, 2));
    process.exit(0);
}

console.log(
    `${input}: ${file.docType} v${file.docTypeVersion} (read v${file.docTypeReadVersion})  ` +
    `timecodeScale=${file.timecodeScale}ns  duration=${(file.durationNs / 1e9).toFixed(3)}s  ` +
    `segment=[${file.segmentStart}..${file.segmentEnd}]`,
);
if (file.muxingApp || file.writingApp) console.log(`  muxer="${file.muxingApp}" writer="${file.writingApp}"`);

console.log(`\n${file.tracks.length} track(s):`);
file.tracks.forEach((t, i) => {
    const geometry = t.kind === "video"
        ? `${t.width}x${t.height}` + (t.displayWidth !== t.width || t.displayHeight !== t.height ? ` (display ${t.displayWidth}x${t.displayHeight})` : "")
        : t.kind === "audio"
            ? `${t.sampleRate}Hz x ${t.channels}ch${t.bitDepth ? ` ${t.bitDepth}bit` : ""}`
            : "";
    const fps = t.kind === "video" && t.defaultDurationNs > 0 ? `  ${(1e9 / t.defaultDurationNs).toFixed(3)}fps` : "";
    console.log(
        `  #${t.number} ${t.kind.padEnd(8)} ${t.codecId.padEnd(16)} ${geometry}${fps}` +
        `  codecPrivate=${t.codecPrivate?.length ?? 0}B  lacing=${t.lacingAllowed ? "allowed" : "off"}  lang=${t.language}`,
    );
    if (refusals[i]) console.log(`      REFUSED: ${refusals[i]}`);
});

if (doCount) {
    console.log("\nframe totals:");
    for (const [track, st] of stats) {
        console.log(
            `  #${track}: ${st.frames} frames, ${st.keyframes} keyframes, ` +
            `${(st.bytes / 1048576).toFixed(2)} MB, ts ${(st.firstTsNs / 1e9).toFixed(3)}s..${(st.lastTsNs / 1e9).toFixed(3)}s`,
        );
    }
    if (stats.size === 0) console.log("  (none)");
}

if (firstFrames.length > 0) {
    console.log(`\nfirst ${firstFrames.length} frame(s):`);
    for (const f of firstFrames) {
        const head = Array.from(f.data.subarray(0, 6)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        console.log(
            `  track #${f.trackNumber}  ts=${(f.timestampNs / 1e6).toFixed(3)}ms${f.timestampExact ? "" : "~"}  ` +
            `${f.isKeyframe ? "KEY" : "   "}  ${String(f.data.length).padStart(7)}B  lace[${f.lacedIndex}]  ${head}`,
        );
    }
}
