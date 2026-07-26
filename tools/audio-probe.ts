#!/usr/bin/env bun
/**
 * audio-probe: Report container, duration, sample rate and channels for audio
 * files WITHOUT decoding them — the same probe the virtual audio CD uses to
 * answer MCI_STATUS_LENGTH (`packages/formats/src/audio`).
 *
 * Prints the bytes actually read per file, which is the property that matters
 * for a 20-track CD image built at startup.
 *
 * Usage:
 *   bun tools/audio-probe.ts <file|dir> [...more] [--verify]
 *
 *   --verify  Cross-check every Ogg against a FULL sequential walk of its pages —
 *             independent ground truth for the tail-scan granule math. Exits
 *             non-zero on any disagreement.
 */
import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import type { RandomAccessSource } from "@bottleship/formats/unpack/source";
import { probeAudioStream } from "@bottleship/formats/audio";

const AUDIO_EXT = /\.(ogg|oga|opus|mp3|mp2|flac|wav)$/i;

class FileSource implements RandomAccessSource {
    readonly size: number;
    private readonly fd: number;
    bytesRead = 0;

    constructor(path: string) {
        this.fd = openSync(path, "r");
        this.size = statSync(path).size;
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        const buf = Buffer.allocUnsafe(e - s);
        let got = 0;
        while (got < buf.length) {
            const n = readSync(this.fd, buf, got, buf.length - got, s + got);
            if (n <= 0) break;
            got += n;
        }
        this.bytesRead += got;
        return got === buf.length ? buf : buf.subarray(0, got);
    }

    close(): void {
        closeSync(this.fd);
    }
}

function expand(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
        .filter((n) => AUDIO_EXT.test(n))
        .sort()
        .map((n) => join(path, n));
}

function timecode(ms: number): string {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * Ground truth by brute force: walk EVERY page of the file and keep the highest
 * granule of the first logical stream. Reads the whole file — that is the point.
 */
function walkOggDurationMs(path: string): number | null {
    const b = new Uint8Array(readFileSync(path));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 0;
    let serial = -1;
    let sampleRate = 0;
    let lastGranule = 0;
    while (off + 27 <= b.length) {
        if (b[off] !== 0x4f || b[off + 1] !== 0x67 || b[off + 2] !== 0x67 || b[off + 3] !== 0x53) return null;
        const segments = b[off + 26]!;
        let body = 0;
        for (let i = 0; i < segments; i++) body += b[off + 27 + i]!;
        const lo = dv.getUint32(off + 6, true);
        const hi = dv.getUint32(off + 10, true);
        const granule = hi & 0x80000000 ? -1 : hi * 0x100000000 + lo;
        const pageSerial = dv.getUint32(off + 14, true);
        if (serial < 0) {
            serial = pageSerial;
            const idHeader = off + 27 + segments;
            sampleRate = dv.getUint32(idHeader + 12, true); // Vorbis identification header
        }
        if (pageSerial === serial && granule > lastGranule) lastGranule = granule;
        off += 27 + segments + body;
    }
    if (off !== b.length || !sampleRate) return null;
    return Math.round((lastGranule * 1000) / sampleRate);
}

const argv = process.argv.slice(2);
const verify = argv.includes("--verify");
const args = argv.filter((a) => !a.startsWith("--"));
if (args.length === 0) {
    console.error("Usage: bun tools/audio-probe.ts <file|dir> [...more] [--verify]");
    process.exit(1);
}

let failures = 0;
for (const path of args.flatMap(expand)) {
    const src = new FileSource(path);
    const info = probeAudioStream(src);
    src.close();
    if (!info) {
        failures++;
        console.log(`${basename(path).padEnd(20)} ${String(src.size).padStart(10)}B  not a recognized audio container`);
        continue;
    }
    let check = "";
    if (verify && info.format === "ogg") {
        const truth = walkOggDurationMs(path);
        const ok = truth != null && truth === info.durationMs;
        if (!ok) failures++;
        check = ok ? "  walk=OK" : `  *** walk=${truth} ms ***`;
    }
    console.log(
        `${basename(path).padEnd(20)} ${String(src.size).padStart(10)}B  ${info.format.padEnd(4)} ` +
            `${timecode(info.durationMs)} (${info.durationMs} ms)  ${info.sampleRate} Hz  ${info.channels}ch  ` +
            `[read ${src.bytesRead}B]${check}`,
    );
}
process.exit(failures > 0 ? 1 : 0);
