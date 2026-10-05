/**
 * WebM container → WebCodecs packet feeder.
 *
 * Joins the two halves: `@bottleship/formats/matroska` demuxes, `WebCodecsVideoSession`
 * decodes. Nothing here knows a codec's bitstream — the only codec-specific work is turning a
 * Matroska CodecID into a WebCodecs codec string, and for H.264 that string is DERIVED from the
 * avcC record rather than guessed.
 *
 * A packet refused by backpressure is HELD, not dropped: `pump()` retries the same packet on the
 * next call, so the feeder is lossless while still bounded.
 */

import { BufferSource } from "@bottleship/formats/unpack/source";
import {
    parseMatroska, readFrames, assertDecodable, isMatroska,
    type MatroskaFile, type MatroskaFrame, type MatroskaTrack,
} from "@bottleship/formats/matroska";
import { Logger, LogCategory } from "../worker/core/logger";
import { WebCodecsVideoSession, type EncodedStreamConfig } from "./webcodecs-backend";

export class WebmSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebmSourceError";
    }
}

/** Does this byte range look like a Matroska/WebM container? */
export function looksLikeWebm(bytes: Uint8Array): boolean {
    return isMatroska(bytes);
}

/**
 * WebCodecs codec string for a Matroska video track.
 *
 * H.264's string carries profile/constraints/level, and those live in the avcC record's bytes
 * 1..3 — reading them is exact where a fixed "avc1.42E01E" would silently mis-declare a High
 * profile stream. VP9's profile/level are in a vpcC CodecPrivate when the muxer wrote one; when
 * it did not, profile 0 / level 1.0 / 8-bit is the only defensible default and is logged as
 * such.
 */
export function codecStringFor(track: MatroskaTrack): { codec: string; description?: Uint8Array } {
    const priv = track.codecPrivate;
    switch (track.codecId) {
        case "V_VP8":
            return { codec: "vp8" };
        case "V_VP9": {
            if (priv && priv.length >= 6) {
                // vpcC: [profile][level][bitDepth<<4 | chromaSubsampling<<1 | fullRange] as
                // ID/length/value triplets in the v1 form; the v0 form is the bare 4 bytes.
                const profile = priv[0]!;
                const level = priv[1]!;
                const depth = priv[2]! >> 4;
                return {
                    codec: `vp09.${String(profile).padStart(2, "0")}.${String(level).padStart(2, "0")}.${String(depth).padStart(2, "0")}`,
                };
            }
            Logger.log(LogCategory.SYSTEM, "[WebmSource] VP9 track has no vpcC — assuming profile 0 / level 1.0 / 8-bit");
            return { codec: "vp09.00.10.08" };
        }
        case "V_MPEG4/ISO/AVC": {
            if (!priv || priv.length < 4) throw new WebmSourceError("H.264 track has no avcC CodecPrivate");
            const hex = (b: number) => b.toString(16).padStart(2, "0").toUpperCase();
            return { codec: `avc1.${hex(priv[1]!)}${hex(priv[2]!)}${hex(priv[3]!)}`, description: priv };
        }
        default:
            throw new WebmSourceError(`CodecID "${track.codecId}" has no WebCodecs mapping in this backend`);
    }
}

export interface WebmVideoOpenOptions {
    ringBudgetBytes?: number;
    /** Injectable for tests; defaults to a real VideoDecoder. */
    decoderFactory?: (init: VideoDecoderInit) => VideoDecoder;
}

/**
 * A WebM file's video track, decoded by the browser and pulled synchronously.
 */
export class WebmVideoSource {
    readonly file: MatroskaFile;
    readonly track: MatroskaTrack;
    readonly session: WebCodecsVideoSession;
    readonly frameCount: number;
    readonly fps: number;
    /** The audio track, if the container has one. Not decoded — see the engine's report. */
    readonly audioTrack: MatroskaTrack | null;

    private src: BufferSource;
    private iter: Iterator<MatroskaFrame>;
    /** A packet the session refused; retried before any new one is demuxed. */
    private held: MatroskaFrame | null = null;
    private demuxDone = false;

    constructor(bytes: Uint8Array, options: WebmVideoOpenOptions = {}) {
        this.src = new BufferSource(bytes);
        this.file = parseMatroska(this.src);
        const video = this.file.tracks.find((t) => t.kind === "video");
        if (!video) throw new WebmSourceError("WebM file has no video track");
        assertDecodable(video);
        this.track = video;
        this.audioTrack = this.file.tracks.find((t) => t.kind === "audio") ?? null;

        if (video.width <= 0 || video.height <= 0) {
            throw new WebmSourceError(`video track ${video.number} declares no coded size`);
        }
        this.fps = video.defaultDurationNs > 0 ? 1e9 / video.defaultDurationNs : 0;
        this.frameCount = video.defaultDurationNs > 0 && this.file.durationNs > 0
            ? Math.round(this.file.durationNs / video.defaultDurationNs)
            : 0;

        const { codec, description } = codecStringFor(video);
        const cfg: EncodedStreamConfig = {
            codec,
            width: video.width,
            height: video.height,
            fps: this.fps,
            frameCount: this.frameCount,
            ...(description ? { description } : {}),
            ...(options.ringBudgetBytes ? { ringBudgetBytes: options.ringBudgetBytes } : {}),
        };
        this.session = new WebCodecsVideoSession(cfg, options.decoderFactory);
        this.iter = this.newIterator();
        Logger.log(LogCategory.SYSTEM,
            `[WebmSource] ${video.width}x${video.height} ${codec} fps=${this.fps.toFixed(2)} ` +
            `frames≈${this.frameCount} audio=${this.audioTrack ? this.audioTrack.codecId : "none"}`);
    }

    private newIterator(): Iterator<MatroskaFrame> {
        return readFrames(this.src, this.file, { trackNumbers: [this.track.number] })[Symbol.iterator]();
    }

    /**
     * Feed packets until the decoder pipeline is full or the container is exhausted.
     * Returns the number of packets accepted.
     */
    pump(): number {
        let accepted = 0;
        for (;;) {
            let frame = this.held;
            this.held = null;
            if (!frame) {
                if (this.demuxDone) break;
                const next = this.iter.next();
                if (next.done) {
                    this.demuxDone = true;
                    this.session.signalEndOfInput();
                    break;
                }
                frame = next.value;
            }
            const durationUs = frame.durationNs > 0
                ? frame.durationNs / 1000
                : this.track.defaultDurationNs / 1000;
            if (!this.session.pushPacket(frame.data, frame.timestampNs / 1000, frame.isKeyframe, durationUs)) {
                this.held = frame; // lossless: retry this exact packet next pump
                break;
            }
            accepted++;
        }
        return accepted;
    }

    /** Rewind and re-feed from the start; forward seeks are served by discarding frames. */
    seekToFrame(index: number): void {
        this.session.reset();
        this.iter = this.newIterator();
        this.held = null;
        this.demuxDone = false;
        this.session.setDiscardTarget(Math.max(0, index));
        this.pump();
    }

    close(): void {
        this.session.close();
        this.held = null;
        this.demuxDone = true;
    }
}
