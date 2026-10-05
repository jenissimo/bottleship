#!/usr/bin/env bun
/**
 * Matroska reader smoke test against a real game asset (MANUAL — the asset is not in git).
 *
 * Ground truth: The Dark Eye: Chains of Satinav ships WebM (VP8 + Vorbis) renamed to
 * `videos/video.vvNNN`. The value of this test over the synthetic unit tests is that nothing
 * here was authored by us: the container came from a third-party muxer, so a convention we
 * merely assumed shows up as a contradiction.
 *
 * The keyframe check is INDEPENDENT of the container: every VP8 frame carries its own 3-byte
 * frame tag (bit 0 = 0 for a keyframe) and a keyframe additionally carries the start code
 * 9D 01 2A plus its own 14-bit width/height. So the Matroska flags, the VP8 frame tags and the
 * Tracks geometry are three separate sources that must agree — a reader that guessed any of
 * them cannot pass all three.
 *
 * Run:  bun tools/tests/matroska-real.smoke.ts [path-to-video]
 *       BOTTLESHIP_WEBM_DIR=<dir> bun tools/tests/matroska-real.smoke.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BufferSource } from "../../packages/formats/src/unpack/source";
import { parseMatroska, readFrames, assertDecodable, isMatroska } from "../../packages/formats/src/matroska";

const DEFAULT_DIR = process.env.BOTTLESHIP_WEBM_DIR ?? "G:/games/the-dark-eye-chains-of-satinav/app/videos";
const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = paths.length > 0 ? paths : ["video.vv050", "video.vv051", "video.vv052"].map((n) => join(DEFAULT_DIR, n));

let fail = 0;
const expect = (cond: boolean, msg: string) => { console.log(`  ${cond ? "OK  " : "FAIL"} ${msg}`); if (!cond) fail++; };

// A missing asset is a FAILURE, not a skip: a smoke test that quietly passes when it read
// nothing is worse than no test.
const missing = targets.filter((t) => !existsSync(t));
if (missing.length > 0) {
    console.error(`asset(s) not found: ${missing.join(", ")}`);
    console.error("pass a path or set BOTTLESHIP_WEBM_DIR to a directory holding the videos");
    process.exit(2);
}

/** Decode a VP8 keyframe's own dimensions from its uncompressed data chunk. */
function vp8KeyframeGeometry(d: Uint8Array): { width: number; height: number } | null {
    if (d.length < 10) return null;
    if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) return null;
    const width = ((d[7]! << 8) | d[6]!) & 0x3fff;
    const height = ((d[9]! << 8) | d[8]!) & 0x3fff;
    return { width, height };
}

for (const path of targets) {
    const data = new Uint8Array(readFileSync(path));
    console.log(`\n${path} (${data.length} bytes)`);
    expect(isMatroska(data), "EBML magic present");

    const src = new BufferSource(data);
    const file = parseMatroska(src);
    expect(file.docType === "matroska" || file.docType === "webm", `DocType "${file.docType}"`);
    expect(file.timecodeScale > 0, `TimecodeScale ${file.timecodeScale} ns`);
    expect(file.durationNs > 0, `Duration ${(file.durationNs / 1e9).toFixed(3)} s`);

    const video = file.tracks.find((t) => t.kind === "video");
    const audio = file.tracks.find((t) => t.kind === "audio");
    expect(!!video, "a video track exists");
    expect(!!audio, "an audio track exists");
    if (!video || !audio) { continue; }

    expect(video.codecId === "V_VP8", `video CodecID ${video.codecId}`);
    expect(video.width === 1920 && video.height === 1080, `coded size ${video.width}x${video.height}`);
    expect(video.defaultDurationNs > 0, `DefaultDuration ${video.defaultDurationNs} ns (${(1e9 / video.defaultDurationNs).toFixed(2)} fps)`);
    expect(audio.codecId === "A_VORBIS", `audio CodecID ${audio.codecId}`);
    expect(audio.sampleRate > 0 && audio.channels > 0, `audio ${audio.sampleRate}Hz x ${audio.channels}ch`);
    // Vorbis needs its three setup headers out of CodecPrivate; an empty one means no decode.
    expect((audio.codecPrivate?.length ?? 0) > 0, `Vorbis CodecPrivate ${audio.codecPrivate?.length ?? 0} B`);
    for (const t of [video, audio]) {
        let refusal: string | null = null;
        try { assertDecodable(t); } catch (e) { refusal = (e as Error).message; }
        expect(refusal === null, `track ${t.number} accepted by assertDecodable${refusal ? ` (${refusal})` : ""}`);
    }

    let videoFrames = 0, videoKeys = 0, audioFrames = 0, lacedAudio = 0;
    let tagAgreements = 0, tagDisagreements = 0, geometryAgreements = 0, geometryDisagreements = 0;
    let lastVideoTs = -1, tsMonotonic = true, emptyFrames = 0;

    for (const f of readFrames(src, file)) {
        if (f.data.length === 0) emptyFrames++;
        if (f.trackNumber === video.number) {
            videoFrames++;
            if (f.isKeyframe) videoKeys++;
            if (f.timestampNs < lastVideoTs) tsMonotonic = false;
            lastVideoTs = f.timestampNs;
            // The VP8 frame tag's own keyframe bit vs the container's flag.
            const tagIsKey = f.data.length > 0 && (f.data[0]! & 1) === 0;
            if (tagIsKey === f.isKeyframe) tagAgreements++; else tagDisagreements++;
            if (f.isKeyframe) {
                const g = vp8KeyframeGeometry(f.data);
                if (g && g.width === video.width && g.height === video.height) geometryAgreements++;
                else geometryDisagreements++;
            }
        } else if (f.trackNumber === audio.number) {
            audioFrames++;
            if (f.lacedIndex > 0) lacedAudio++;
        }
    }

    expect(videoFrames > 0, `decoded ${videoFrames} video frames`);
    expect(audioFrames > 0, `decoded ${audioFrames} audio frames`);
    expect(emptyFrames === 0, `no zero-length frames (${emptyFrames})`);
    expect(tsMonotonic, "video timestamps are non-decreasing");
    expect(videoKeys > 0 && videoKeys < videoFrames, `${videoKeys} keyframes among ${videoFrames} video frames`);
    expect(tagDisagreements === 0, `VP8 frame tags agree with container keyframe flags (${tagAgreements} frames, ${tagDisagreements} mismatches)`);
    expect(geometryAgreements === videoKeys && geometryDisagreements === 0,
        `every keyframe's own VP8 header says ${video.width}x${video.height} (${geometryAgreements}/${videoKeys})`);
    expect(lacedAudio > 0, `Xiph/EBML lacing exercised: ${lacedAudio} laced sub-frames recovered`);

    // Frame count must be consistent with the declared duration and frame rate — a reader that
    // stopped after the first cluster would still report "some" frames.
    const expectedFrames = file.durationNs / video.defaultDurationNs;
    expect(Math.abs(videoFrames - expectedFrames) <= 2,
        `video frame count ${videoFrames} matches duration/fps (${expectedFrames.toFixed(1)})`);
}

console.log(fail === 0 ? `\nALL OK (${targets.length} file(s))` : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
