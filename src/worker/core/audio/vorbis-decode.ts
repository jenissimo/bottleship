import { oggPackets, xiphLacedHeaders } from "@bottleship/formats/audio/ogg-packets";

interface AudioDataLike {
    numberOfFrames: number;
    copyTo(dest: Float32Array, options: { planeIndex: number; format: string }): void;
    close(): void;
}

interface AudioDecoderLike {
    configure(config: Record<string, unknown>): void;
    decode(chunk: unknown): void;
    flush(): Promise<void>;
    close(): void;
}

type AudioDecoderCtor = new (init: { output: (data: AudioDataLike) => void; error: (e: unknown) => void }) => AudioDecoderLike;
type EncodedChunkCtor = new (init: { type: string; timestamp: number; data: Uint8Array }) => unknown;

export function webCodecsVorbisPresent(): boolean {
    const g = globalThis as { AudioDecoder?: unknown; EncodedAudioChunk?: unknown };
    return typeof g.AudioDecoder === "function" && typeof g.EncodedAudioChunk === "function";
}

export async function decodeOggVorbis(ogg: Uint8Array): Promise<Int16Array | null> {
    if (!webCodecsVorbisPresent()) return null;
    const g = globalThis as unknown as { AudioDecoder: AudioDecoderCtor; EncodedAudioChunk: EncodedChunkCtor };
    const packets = oggPackets(ogg);
    if (packets.length < 3) return null;
    const id = packets[0]!.data;
    if (id.length < 16 || id[0] !== 1) return null;
    const channels = id[11]!;
    const rate = new DataView(id.buffer, id.byteOffset, id.byteLength).getUint32(12, true);
    let lastGranule = -1;
    for (const p of packets) if (p.granule >= 0) lastGranule = p.granule;

    const parts: Float32Array[] = [];
    let failed = false;
    const decoder = new g.AudioDecoder({
        output: (data) => {
            try {
                const plane = new Float32Array(data.numberOfFrames);
                data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
                parts.push(plane);
            } finally {
                data.close();
            }
        },
        error: () => { failed = true; },
    });
    try {
        decoder.configure({
            codec: "vorbis", sampleRate: rate, numberOfChannels: channels,
            description: xiphLacedHeaders([packets[0]!.data, packets[1]!.data, packets[2]!.data]),
        });
        for (let i = 3; i < packets.length; i++) {
            decoder.decode(new g.EncodedAudioChunk({ type: "key", timestamp: i * 1000, data: packets[i]!.data }));
        }
        await decoder.flush();
    } catch {
        failed = true;
    } finally {
        try { decoder.close(); } catch (e) { void e; }
    }
    if (failed) return null;
    let total = parts.reduce((n, p) => n + p.length, 0);
    if (lastGranule >= 0 && lastGranule < total) total = lastGranule;
    const out = new Int16Array(total);
    let at = 0;
    for (const p of parts) {
        for (let i = 0; i < p.length && at < total; i++, at++) {
            const v = Math.round(p[i]! * 32767);
            out[at] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
    }
    return out;
}
