/**
 * Container-level audio probing — format, rate, channels, length and payload
 * extent WITHOUT decoding.
 *
 * This is the ONE answer to "what is this audio and how fast does it play".
 * Everything that used to sniff bytes for itself (MSS32, BASS, quartz, winmm,
 * the host audio engine, the virtual CD) asks here, because the moment two
 * layers derive a rate independently they disagree, and a consumer keyed to a
 * playback position then drifts against its own soundtrack.
 *
 * A virtual audio CD also needs each track's exact length: MCI_STATUS_LENGTH
 * feeds the game's own play/loop arithmetic (Quake II builds MCI_PLAY's dwTo
 * straight out of it), so a guessed duration desynchronizes playback from the
 * game's timeline. Every supported container carries the length in its headers
 * or its last frame, so probing reads a few KB at each end rather than the
 * whole (multi-MB) file.
 */

import { WindowSource, type RandomAccessSource } from "../unpack/source";
import { id3v2Size, readAt, tagAt } from "./bytes";
import { probeFlac } from "./flac";
import { probeMp3 } from "./mp3";
import { probeOgg } from "./ogg";
import { probeWav } from "./wav";

export { buildPcmWavImage } from "./wav";

export type AudioContainer = "ogg" | "mp3" | "flac" | "wav";

export interface AudioProbe {
    format: AudioContainer;
    sampleRate: number;
    channels: number;
    /** 0 when the container does not state one (MPEG, Vorbis, Opus). */
    bitsPerSample: number;
    /** 0 when the container carries no derivable length. */
    durationMs: number;
    /** Audio payload extent, clamped to the source; end is exclusive. */
    dataStart: number;
    dataEnd: number;
    /** RIFF WAVE_FORMAT_* tag; 0 for non-RIFF containers. */
    formatTag: number;
    /** RIFF block alignment — an ADPCM decoder cannot walk blocks without it; 0 elsewhere. */
    blockAlign: number;
    /** MPEG audio layer (1/2/3); 0 for non-MPEG containers. */
    mpegLayer: number;
}

/**
 * Identify the container and report everything its headers state. Returns null
 * when the bytes are not a recognized/parseable audio container — callers treat
 * that as "not usable audio" rather than an error.
 */
export function probeAudio(src: RandomAccessSource): AudioProbe | null {
    try {
        switch (sniffAudioContainer(src)) {
            case "ogg":
                return probeOgg(src);
            case "flac":
                return probeFlac(src);
            case "wav":
                return probeWav(src);
            case "mp3":
                return probeMp3(src);
            default:
                return null;
        }
    } catch {
        return null; // malformed input is "not usable audio", never a throw
    }
}

/**
 * probeAudio over an image embedded at `base` in a larger buffer — a WAV sitting in
 * guest memory, a resource inside a PE. Offsets come back relative to the image, and
 * nothing outlives the call, so a caller may pass a guest view straight in.
 */
export function probeAudioAt(buf: Uint8Array, base: number, length: number): AudioProbe | null {
    return probeAudio(new WindowSource(buf, base, length));
}

/**
 * Container from magic bytes alone, seeing past a prepended ID3v2 tag. Cheap
 * enough for a hot dispatch and honest about a header-sized buffer, which is
 * all a caller choosing a decoder route has.
 */
export function sniffAudioContainer(src: RandomAccessSource): AudioContainer | null {
    const head = readAt(src, 0, 16);
    if (head.length < 4) return null;

    if (tagAt(head, 0, "OggS")) return "ogg";
    if (tagAt(head, 0, "fLaC")) return "flac";
    if (head.length >= 12 && tagAt(head, 8, "WAVE") && (tagAt(head, 0, "RIFF") || tagAt(head, 0, "RF64"))) return "wav";

    if (tagAt(head, 0, "ID3")) {
        const body = readAt(src, id3v2Size(head, 0), 4);
        return tagAt(body, 0, "fLaC") ? "flac" : "mp3";
    }
    if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "mp3";
    return null;
}
