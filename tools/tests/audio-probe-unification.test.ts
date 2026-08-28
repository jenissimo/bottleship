// Characterization test for the ONE audio probe (packages/formats/src/audio).
//
// Seven modules used to sniff audio bytes for themselves — MSS32 (three sites),
// BASS, quartz, winmm and the host audio engine — and each derived the source's
// sample rate its own way, or not at all. A consumer keyed to a playback position
// then drifts against its own soundtrack by exactly the ratio of the two answers.
// So the assertion here is AGREEMENT, not merely plausibility: every consumer must
// report the same rate/length for the same bytes, and those must be the values the
// pre-unification implementations produced on real game audio.
//
// The pinned numbers come from running the old per-module implementations over the
// GTA III bundle's own tracks; JB.mp3 (113163 ms) and BET.mp3 (36983 ms) were also
// verified by hand. The real files are optional (they live outside the repo); the
// synthesized fixtures reproduce their exact header shapes and always run.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferSource, WindowSource } from "@bottleship/formats/unpack/source";
import { probeAudio, sniffAudioContainer, buildPcmWavImage } from "@bottleship/formats/audio";
import { scanWavChunks, parseWav } from "../../src/worker/modules/mss32/audio-decode";
import { inspectEncodedAudio, isMp3, isOgg } from "../../src/worker/modules/mss32/helpers";

// --- fixtures ---------------------------------------------------------------

function ascii(buf: Uint8Array, off: number, text: string): void {
    for (let i = 0; i < text.length; i++) buf[off + i] = text.charCodeAt(i);
}

/**
 * A RIFF/WAVE shaped like GTA III's speech banks: an extra chunk between `fmt `
 * and `data`, so the payload starts at 80 rather than the textbook 44. Every old
 * implementation walked chunks, and every one had to land on the same offset.
 */
function gta3ShapedWav(dataBytes: number): Uint8Array {
    const dataStart = 80;
    const buf = new Uint8Array(dataStart + dataBytes);
    const view = new DataView(buf.buffer);
    ascii(buf, 0, "RIFF");
    view.setUint32(4, buf.length - 8, true);
    ascii(buf, 8, "WAVE");

    ascii(buf, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
    view.setUint16(22, 2, true); // channels
    view.setUint32(24, 44100, true); // sample rate
    view.setUint32(28, 88200, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 8, true); // bits per sample

    ascii(buf, 36, "LIST");
    view.setUint32(40, 28, true); // pads `data` out to 72/80

    ascii(buf, 72, "data");
    view.setUint32(76, dataBytes, true);
    for (let i = 0; i < dataBytes; i++) buf[dataStart + i] = i & 0xff;
    return buf;
}

/**
 * MPEG-1 Layer III, 44.1 kHz stereo 128 kbps, behind an ID3v2 tag and carrying a
 * Xing frame count + LAME delay/padding — the shape of both GTA III soundtracks.
 * The ID3 tag matters: a scanner that starts at byte 0 finds a false frame sync
 * inside it, which is how two of the old implementations answered "rate unknown".
 */
function taggedXingMp3(frames: number, id3Bytes: number, delay: number, padding: number): Uint8Array {
    const frameSize = 417; // 144 * 128000 / 44100, unpadded
    const total = id3Bytes + frameSize * frames;
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);

    ascii(buf, 0, "ID3");
    buf[3] = 3; // v2.3
    const syncsafe = id3Bytes - 10;
    buf[6] = (syncsafe >> 21) & 0x7f;
    buf[7] = (syncsafe >> 14) & 0x7f;
    buf[8] = (syncsafe >> 7) & 0x7f;
    buf[9] = syncsafe & 0x7f;
    // A byte pair a naive scanner reads as a frame sync with a reserved sample-rate index.
    buf[64] = 0xff;
    buf[65] = 0xfb;
    buf[66] = 0x9c;

    for (let f = 0; f < frames; f++) {
        const o = id3Bytes + f * frameSize;
        buf[o] = 0xff;
        buf[o + 1] = 0xfb; // MPEG1 Layer III, no CRC
        buf[o + 2] = 0x90; // 128 kbps, 44.1 kHz, no padding
        buf[o + 3] = 0x00; // stereo
    }

    // Xing lives after the 4-byte header plus MPEG1/stereo side info (32 bytes).
    const xing = id3Bytes + 4 + 32;
    ascii(buf, xing, "Xing");
    view.setUint32(xing + 4, 0x0001, false); // FRAMES_FLAG
    view.setUint32(xing + 8, frames, false);
    ascii(buf, xing + 12, "LAME3.99r");
    view.setUint8(xing + 12 + 21, delay >> 4);
    view.setUint8(xing + 12 + 22, ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f));
    view.setUint8(xing + 12 + 23, padding & 0xff);
    return buf;
}

// --- the shared probe is the single answer -----------------------------------

describe("probeAudio — one answer per file", () => {
    it("reads a GTA-III-shaped WAV exactly as every old implementation did", () => {
        const wav = gta3ShapedWav(153398);
        const probe = probeAudio(new BufferSource(wav));

        expect(probe).toEqual({
            format: "wav",
            sampleRate: 44100,
            channels: 2,
            bitsPerSample: 8,
            durationMs: 1739, // 153398 / 88200 s — quartz reported 1.7392063s
            dataStart: 80,
            dataEnd: 153478,
            formatTag: 1,
            blockAlign: 2,
            mpegLayer: 0,
        });
    });

    it("reads an ID3-tagged Xing MP3 past the false sync in its tag", () => {
        const mp3 = taggedXingMp3(1416, 13907, 576, 1191);
        const probe = probeAudio(new BufferSource(mp3))!;

        expect(probe.format).toBe("mp3");
        expect(probe.sampleRate).toBe(44100);
        expect(probe.channels).toBe(2);
        expect(probe.mpegLayer).toBe(3);
        expect(probe.dataStart).toBe(13907); // first real frame, not a tag byte
        // 1416 frames x 1152 samples, less the LAME encoder delay+padding.
        expect(probe.durationMs).toBe(Math.round(((1416 * 1152 - 576 - 1191) * 1000) / 44100));
    });

    it("addresses an image embedded in a larger buffer without copying it", () => {
        const wav = gta3ShapedWav(4096);
        const guest = new Uint8Array(wav.length + 8192);
        guest.set(wav, 0x1234);

        // winmm probes a WAV sitting in guest memory; the offsets it gets back must be
        // relative to the image, so the caller can add its own base exactly once.
        expect(probeAudio(new WindowSource(guest, 0x1234, wav.length))).toEqual(
            probeAudio(new BufferSource(wav))!,
        );
    });

    it("round-trips the PCM writer through the probe", () => {
        const pcm = new Uint8Array(2205 * 4); // 50 ms of 44.1 kHz stereo 16-bit
        const image = buildPcmWavImage(pcm, 2, 44100);
        const probe = probeAudio(new BufferSource(image))!;

        expect(probe.format).toBe("wav");
        expect(probe.formatTag).toBe(1);
        expect(probe.channels).toBe(2);
        expect(probe.sampleRate).toBe(44100);
        expect(probe.bitsPerSample).toBe(16);
        expect(probe.blockAlign).toBe(4);
        expect(probe.dataStart).toBe(44);
        expect(probe.dataEnd).toBe(image.length);
        expect(probe.durationMs).toBe(50);
    });

    it("sniffs the container from a header slice alone", () => {
        // stream-engine classifies a file from its first probe read, not the whole thing.
        const head = (buf: Uint8Array) => sniffAudioContainer(new BufferSource(buf.subarray(0, 32)));
        expect(head(gta3ShapedWav(4096))).toBe("wav");
        expect(head(taggedXingMp3(64, 13907, 576, 1191))).toBe("mp3");
        expect(sniffAudioContainer(new BufferSource(new Uint8Array([0x4f, 0x67, 0x67, 0x53])))).toBe("ogg");
        expect(sniffAudioContainer(new BufferSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toBeNull();
    });
});

// --- every converted consumer reports the same thing --------------------------

describe("consumers agree with the shared probe", () => {
    it("MSS32 scanWavChunks/parseWav mirror the probe's WAV fields", () => {
        const wav = gta3ShapedWav(153398);
        const probe = probeAudio(new BufferSource(wav))!;

        expect(scanWavChunks(wav)).toEqual({
            formatTag: probe.formatTag,
            channels: probe.channels,
            sampleRate: probe.sampleRate,
            bitsPerSample: probe.bitsPerSample,
            blockAlign: probe.blockAlign,
            dataChunkOffset: probe.dataStart,
            dataChunkSize: probe.dataEnd - probe.dataStart,
        });

        const parsed = parseWav(wav)!;
        expect(parsed.sampleRate).toBe(probe.sampleRate);
        expect(parsed.channels).toBe(probe.channels);
        expect(parsed.bitsPerSample).toBe(probe.bitsPerSample);
        expect(parsed.formatTag).toBe(probe.formatTag);
        expect(parsed.blockAlign).toBe(probe.blockAlign);
        expect(parsed.data.length).toBe(probe.dataEnd - probe.dataStart);
    });

    it("MSS32 rejects a WAVE whose fmt names no codec, and the probe still describes it", () => {
        // The tag selects the decoder, so MSS32 is deliberately stricter than the probe.
        const wav = gta3ShapedWav(1024);
        new DataView(wav.buffer).setUint16(20, 0, true); // formatTag = 0
        expect(probeAudio(new BufferSource(wav))!.formatTag).toBe(0);
        expect(scanWavChunks(wav)).toBeNull();
        expect(parseWav(wav)).toBeNull();
    });

    it("MSS32 inspectEncodedAudio reports the SOURCE rate, not a device default", () => {
        const mp3 = taggedXingMp3(1416, 13907, 576, 1191);
        const probe = probeAudio(new BufferSource(mp3))!;
        const info = inspectEncodedAudio(mp3, "mp3");

        expect(info.sampleRate).toBe(probe.sampleRate);
        expect(info.channels).toBe(probe.channels);
        expect(info.durationMs).toBe(probe.durationMs);
        // A format hint that contradicts the bytes must not be answered with a guess.
        expect(inspectEncodedAudio(mp3, "ogg")).toEqual({});
    });

    it("MSS32 isMp3/isOgg answer from the magic bytes of a header slice", () => {
        const mp3 = taggedXingMp3(64, 13907, 576, 1191);
        expect(isMp3(mp3.subarray(0, 16))).toBe(true);
        expect(isOgg(mp3.subarray(0, 16))).toBe(false);
        expect(isOgg(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe(true);
        expect(isMp3(gta3ShapedWav(1024))).toBe(false);
    });
});

// --- the real tracks, when the bundle is on this machine ----------------------

const GTA3_WGB = "g:/WGB/running/gta3-ru.wgb";

function extractFromBundle(entry: string): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "bs-audio-"));
    const out = join(dir, entry.split("/").pop()!);
    execFileSync("bun", ["tools/wgb.ts", "extract", GTA3_WGB, entry, out], { stdio: "ignore" });
    return new Uint8Array(readFileSync(out));
}

describe.skipIf(!existsSync(GTA3_WGB))("real GTA III audio", () => {
    // Hand-verified lengths; the intro cutscene is keyed to this track's position.
    const tracks: Array<[string, number, number, number]> = [
        ["rom/audio/JB.mp3", 113163, 44100, 2],
        ["rom/audio/BET.mp3", 36983, 44100, 2],
    ];

    for (const [entry, durationMs, sampleRate, channels] of tracks) {
        it(`${entry} probes to ${durationMs}ms @ ${sampleRate}Hz`, () => {
            const data = extractFromBundle(entry);
            const probe = probeAudio(new BufferSource(data))!;
            expect(probe.format).toBe("mp3");
            expect(probe.durationMs).toBe(durationMs);
            expect(probe.sampleRate).toBe(sampleRate);
            expect(probe.channels).toBe(channels);
            expect(inspectEncodedAudio(data, "mp3").sampleRate).toBe(sampleRate);
        });
    }

    it("rom/audio/A1_a.wav probes to the offsets the old walkers found", () => {
        const data = extractFromBundle("rom/audio/A1_a.wav");
        expect(probeAudio(new BufferSource(data))).toEqual({
            format: "wav",
            sampleRate: 44100,
            channels: 2,
            bitsPerSample: 8,
            durationMs: 1739,
            dataStart: 80,
            dataEnd: 153478,
            formatTag: 1,
            blockAlign: 2,
            mpegLayer: 0,
        });
    });
});
