/**
 * Container-level audio probing — duration/format WITHOUT decoding.
 *
 * A virtual audio CD needs each track's exact length: MCI_STATUS_LENGTH feeds the
 * game's own play/loop arithmetic (Quake II builds MCI_PLAY's dwTo straight out of
 * it), so a guessed duration desynchronizes playback from the game's timeline.
 * Every supported container carries the length in its headers or its last frame,
 * so probing reads a few KB at each end rather than the whole (multi-MB) file.
 */

import type { RandomAccessSource } from "../unpack/source";
import { id3v2Size, readAt, tagAt } from "./bytes";
import { probeFlac } from "./flac";
import { probeMp3 } from "./mp3";
import { probeOgg } from "./ogg";
import { probeWav } from "./wav";

export type AudioContainer = "ogg" | "mp3" | "flac" | "wav";

export interface AudioStreamInfo {
    durationMs: number;
    sampleRate: number;
    channels: number;
    format: AudioContainer;
}

/**
 * Identify the container and report its stream info. Returns null when the bytes
 * are not a recognized/parseable audio container — callers treat that as "not a
 * usable track" rather than an error.
 */
export function probeAudioStream(src: RandomAccessSource): AudioStreamInfo | null {
    try {
        const probe = pickProbe(src);
        return probe ? probe(src) : null;
    } catch {
        return null; // malformed input is "not a usable track", never a throw
    }
}

/** Sniff the container from its magic bytes, seeing past a prepended ID3v2 tag. */
function pickProbe(src: RandomAccessSource): ((src: RandomAccessSource) => AudioStreamInfo | null) | null {
    const head = readAt(src, 0, 16);
    if (head.length < 12) return null;

    if (tagAt(head, 0, "OggS")) return probeOgg;
    if (tagAt(head, 0, "fLaC")) return probeFlac;
    if (tagAt(head, 8, "WAVE") && (tagAt(head, 0, "RIFF") || tagAt(head, 0, "RF64"))) return probeWav;

    if (tagAt(head, 0, "ID3")) {
        const body = readAt(src, id3v2Size(head, 0), 4);
        return tagAt(body, 0, "fLaC") ? probeFlac : probeMp3;
    }
    if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return probeMp3;
    return null;
}
