import { oggPackets, xiphLacedHeaders } from "@bottleship/formats/audio/ogg-packets";

interface AudioDataLike {
    numberOfFrames: number;
    copyTo(dest: Float32Array, options: { planeIndex: number; format: string }): void;
    close(): void;
}

interface AudioDecoderLike {
    state: string;
    configure(config: Record<string, unknown>): void;
    decode(chunk: unknown): void;
    flush(): Promise<void>;
    close(): void;
}

type AudioDecoderCtor = new (init: { output: (data: AudioDataLike) => void; error: (e: unknown) => void }) => AudioDecoderLike;
type EncodedChunkCtor = new (init: { type: string; timestamp: number; data: Uint8Array }) => unknown;

interface PooledDecoder {
    decoder: AudioDecoderLike;
    sink: Float32Array[];
    failed: boolean;
    busy: Promise<unknown>;
}

const DECODERS_PER_SETUP = 2;

// @transient(WebCodecs decoders reused across samples that share a Vorbis setup; no session data)
const pool = new Map<string, PooledDecoder[]>();
// @transient(round-robin cursor into the decoder pool)
let nextSlot = 0;

export function webCodecsVorbisPresent(): boolean {
    const g = globalThis as { AudioDecoder?: unknown; EncodedAudioChunk?: unknown };
    return typeof g.AudioDecoder === "function" && typeof g.EncodedAudioChunk === "function";
}

function setupKey(description: Uint8Array): string {
    let h = 2166136261;
    for (let i = 0; i < description.length; i++) h = Math.imul(h ^ description[i]!, 16777619);
    return `${description.length}:${h >>> 0}`;
}

function pooledDecoder(description: Uint8Array, rate: number, channels: number): PooledDecoder {
    const key = setupKey(description);
    let slots = pool.get(key);
    if (!slots) pool.set(key, slots = []);
    const live = slots.filter((s) => !s.failed && s.decoder.state !== "closed");
    if (live.length < DECODERS_PER_SETUP) {
        const g = globalThis as unknown as { AudioDecoder: AudioDecoderCtor };
        const slot: PooledDecoder = { decoder: null as unknown as AudioDecoderLike, sink: [], failed: false, busy: Promise.resolve() };
        slot.decoder = new g.AudioDecoder({
            output: (data) => {
                try {
                    const plane = new Float32Array(data.numberOfFrames);
                    data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
                    slot.sink.push(plane);
                } finally {
                    data.close();
                }
            },
            error: () => { slot.failed = true; },
        });
        slot.decoder.configure({ codec: "vorbis", sampleRate: rate, numberOfChannels: channels, description });
        live.push(slot);
        pool.set(key, live);
        return slot;
    }
    return live[nextSlot++ % live.length]!;
}

export async function decodeOggVorbis(ogg: Uint8Array): Promise<Int16Array | null> {
    if (!webCodecsVorbisPresent()) return null;
    const g = globalThis as unknown as { EncodedAudioChunk: EncodedChunkCtor };
    const packets = oggPackets(ogg);
    if (packets.length < 3) return null;
    const id = packets[0]!.data;
    if (id.length < 16 || id[0] !== 1) return null;
    const channels = id[11]!;
    const rate = new DataView(id.buffer, id.byteOffset, id.byteLength).getUint32(12, true);
    let lastGranule = -1;
    for (const p of packets) if (p.granule >= 0) lastGranule = p.granule;

    let slot: PooledDecoder;
    try {
        slot = pooledDecoder(xiphLacedHeaders([packets[0]!.data, packets[1]!.data, packets[2]!.data]), rate, channels);
    } catch {
        return null;
    }
    const run = slot.busy.then(async () => {
        slot.sink = [];
        for (let i = 3; i < packets.length; i++) {
            slot.decoder.decode(new g.EncodedAudioChunk({ type: "key", timestamp: i * 1000, data: packets[i]!.data }));
        }
        await slot.decoder.flush();
        return slot.sink;
    });
    slot.busy = run.catch(() => undefined);
    let parts: Float32Array[];
    try {
        parts = await run;
    } catch {
        slot.failed = true;
        return null;
    }
    if (slot.failed) return null;
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

// @transient(helper worker that decodes off the emulation thread; holds no session data)
let helper: Worker | null = null;
// @transient(helper requests in flight)
const waiting = new Map<number, (pcms: Array<Int16Array | null>) => void>();
// @transient(helper request counter)
let nextRequest = 1;

function helperWorker(): Worker | null {
    if (helper) return helper;
    if (typeof Worker !== "function") return null;
    try {
        helper = new Worker(new URL("./vorbis-worker.ts", import.meta.url), { type: "module", name: "vorbis-decode" });
        helper.onmessage = (event: MessageEvent<{ id: number; pcms: Array<Int16Array | null> }>) => {
            waiting.get(event.data.id)?.(event.data.pcms);
            waiting.delete(event.data.id);
        };
        helper.onerror = () => {
            for (const done of waiting.values()) done([]);
            waiting.clear();
            helper = null;
        };
        return helper;
    } catch {
        return null;
    }
}

export async function decodeOggVorbisBatch(oggs: Uint8Array[]): Promise<Array<Int16Array | null>> {
    const worker = helperWorker();
    if (!worker) {
        const out: Array<Int16Array | null> = [];
        for (const ogg of oggs) out.push(await decodeOggVorbis(ogg));
        return out;
    }
    const id = nextRequest++;
    const copies = oggs.map((o) => o.slice());
    const result = await new Promise<Array<Int16Array | null>>((resolve) => {
        waiting.set(id, resolve);
        worker.postMessage({ id, oggs: copies }, copies.map((c) => c.buffer));
    });
    return oggs.map((_, i) => result[i] ?? null);
}
