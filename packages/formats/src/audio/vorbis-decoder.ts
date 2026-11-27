import { VORBIS_DECODER_WASM_BASE64 } from "./vorbis-wasm.generated";

interface VorbisExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    wv_alloc(n: number): number;
    wv_free(p: number): void;
    wv_open(id: number, idLen: number, comment: number, commentLen: number, setup: number, setupLen: number): number;
    wv_close(h: number): void;
    wv_reset(h: number): void;
    wv_channels(h: number): number;
    wv_sample_rate(h: number): number;
    wv_decode(h: number, packet: number, len: number, out: number, maxFrames: number): number;
}

const MAX_PACKET_BYTES = 65024;
const MAX_FRAMES_PER_PACKET = 8192;
const MAX_CHANNELS = 16;

let shared: { ex: VorbisExports; packet: number; out: number } | null = null;

function base64Bytes(b64: string): Uint8Array {
    if (typeof atob === "function") {
        const s = atob(b64);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
}

function runtime(): { ex: VorbisExports; packet: number; out: number } {
    if (shared) return shared;
    const module = new WebAssembly.Module(base64Bytes(VORBIS_DECODER_WASM_BASE64) as BufferSource);
    const ex = new WebAssembly.Instance(module, {}).exports as unknown as VorbisExports;
    ex._initialize();
    const packet = ex.wv_alloc(MAX_PACKET_BYTES);
    const out = ex.wv_alloc(MAX_FRAMES_PER_PACKET * MAX_CHANNELS * 2);
    if (!packet || !out) throw new Error("vorbis decoder: out of memory");
    shared = { ex, packet, out };
    return shared;
}

const decoderHandles = new FinalizationRegistry<number>(handle => runtime().ex.wv_close(handle));

export class VorbisPacketDecoder {
    readonly channels: number;
    readonly sampleRate: number;
    private handle: number;

    constructor(id: Uint8Array, comment: Uint8Array, setup: Uint8Array) {
        const rt = runtime();
        const total = id.length + comment.length + setup.length;
        const buf = rt.ex.wv_alloc(total);
        if (!buf) throw new Error("vorbis decoder: out of memory");
        try {
            const mem = new Uint8Array(rt.ex.memory.buffer);
            mem.set(id, buf);
            mem.set(comment, buf + id.length);
            mem.set(setup, buf + id.length + comment.length);
            this.handle = rt.ex.wv_open(buf, id.length, buf + id.length, comment.length, buf + id.length + comment.length, setup.length);
        } finally {
            rt.ex.wv_free(buf);
        }
        if (!this.handle) throw new Error("vorbis decoder: headers rejected");
        this.channels = rt.ex.wv_channels(this.handle);
        this.sampleRate = rt.ex.wv_sample_rate(this.handle);
        if (this.channels < 1 || this.channels > MAX_CHANNELS) {
            this.close();
            throw new Error(`vorbis decoder: ${this.channels} channels not supported`);
        }
        decoderHandles.register(this, this.handle, this);
    }

    reset(): void {
        if (!this.handle) throw new Error("vorbis decoder: closed");
        runtime().ex.wv_reset(this.handle);
    }

    decodeInto(packet: Uint8Array, out: Int16Array, outFrame: number): number {
        if (!this.handle) throw new Error("vorbis decoder: closed");
        if (packet.length > MAX_PACKET_BYTES) throw new Error(`vorbis decoder: packet of ${packet.length} bytes`);
        const rt = runtime();
        new Uint8Array(rt.ex.memory.buffer).set(packet, rt.packet);
        const frames = rt.ex.wv_decode(this.handle, rt.packet, packet.length, rt.out, MAX_FRAMES_PER_PACKET);
        if (frames < 0) throw new Error(`vorbis decoder: packet rejected (${frames})`);
        const samples = frames * this.channels;
        const want = (outFrame + frames) * this.channels;
        if (want > out.length) throw new Error(`vorbis decoder: ${frames} frames overflow the output`);
        out.set(new Int16Array(rt.ex.memory.buffer, rt.out, samples), outFrame * this.channels);
        return frames;
    }

    close(): void {
        if (!this.handle) return;
        decoderHandles.unregister(this);
        runtime().ex.wv_close(this.handle);
        this.handle = 0;
    }
}
