/**
 * Where a DirectMusic port's synthesizer output goes: a DirectSound buffer, written the
 * way any streaming client writes one — play it looping, keep the span ahead of the write
 * cursor filled. The application may supply the buffer (IDirectMusicPort::SetDirectSound),
 * which is how it gets a volume and pan control over the music.
 */
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import type { Process } from "../core/process";
import type { ThunkImplementation, X86Context } from "../core/thunking/thunk-dispatcher";

const DSBPLAY_LOOPING = 1;
/** Audio kept written beyond the buffer's write cursor. */
const LEAD_SECONDS = 0.08;
/** The most one pump writes: after a long stall the stream resumes, it does not catch up. */
const MAX_FILL_SECONDS = 0.25;

const NO_CONTEXT = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0 } as X86Context;

/** Renders `frames` of interleaved 16-bit PCM into `out`. */
export type RenderPcm = (out: Int16Array, frames: number) => void;

/**
 * The DirectSound object createSinkBuffer made for a buffer when the application supplied
 * none, keyed by the buffer. It is released when the buffer's last reference goes: a
 * device's last Release destroys the buffers it created (as on Windows), so releasing it
 * right after creating the buffer would leave DirectMusic writing into a dead buffer.
 */
// @transient(after a restore an entry is missing and its private device simply stays alive; the buffer it backs keeps working)
const privateDevices = new Map<number, number>();

export function soundReference(process: Process, ptr: number, buffer: boolean, retain: boolean): void {
    if (!ptr) return;
    const iface = buffer ? "IDirectSoundBuffer8" : "IDirectSound8";
    const method = retain ? "AddRef" : "Release";
    const exports = process.getModule("dsound")?.exports;
    const fn = exports?.[`${iface}_${method}`] ?? exports?.[`${iface}_${method}`.toLowerCase()];
    const mem = Mem.getView();
    if (!fn || !mem) return;
    const left = fn(NO_CONTEXT, mem, [ptr]);
    if (buffer && !retain && left === 0) {
        const device = privateDevices.get(ptr >>> 0);
        privateDevices.delete(ptr >>> 0);
        if (device) soundReference(process, device, false, false);
    }
}

export interface SinkData { bufferBytes: number; scratch: number; writeOffset: number; playing: boolean; silentBytes: number }

export class DirectSoundSink {
    private readonly process: Process;
    private readonly buffer: number;
    private readonly blockAlign: number;
    private readonly bytesPerSecond: number;
    private bufferBytes = 0;
    /** Guest scratch for the out-parameters of GetCurrentPosition / Lock / GetCaps. */
    private scratch = 0;
    /** Offset in the buffer the next write goes to. */
    private writeOffset = -1;
    private playing = false;
    private pcm = new Int16Array(0);

    constructor(process: Process, buffer: number, channels: number, sampleRate: number) {
        this.process = process;
        this.buffer = buffer >>> 0;
        this.blockAlign = channels * 2;
        this.bytesPerSecond = sampleRate * this.blockAlign;
    }

    captureState(): SinkData {
        return {
            bufferBytes: this.bufferBytes, scratch: this.scratch, writeOffset: this.writeOffset, playing: this.playing,
            silentBytes: this.silentBytes,
        };
    }

    restoreState(d: SinkData): void {
        this.bufferBytes = d.bufferBytes;
        this.scratch = d.scratch;
        this.writeOffset = d.writeOffset;
        this.playing = d.playing;
        this.silentBytes = d.silentBytes;
    }

    private call(method: string, args: number[]): number {
        const fn = this.process.getModule("dsound")?.exports[`idirectsoundbuffer8_${method}`] as ThunkImplementation | undefined;
        const mem = Mem.getView();
        if (!fn || !mem) return -1;
        const result = fn(NO_CONTEXT, mem, [this.buffer, ...args]);
        return typeof result === "number" ? result | 0 : -1;
    }

    /** Start the buffer looping. Returns false when it is not a usable DirectSound buffer. */
    start(): boolean {
        if (this.playing) return true;
        if (!this.scratch) this.scratch = this.process.memory.alloc(32, "HEAP", "rw");
        if (!this.scratch) return false;
        // DSBCAPS: dwSize, dwFlags, dwBufferBytes, …
        Mem.writeUint32(this.scratch, 20);
        if (this.call("getcaps", [this.scratch]) !== 0) {
            Logger.warn(LogCategory.SYSTEM, `[DMusic] sink buffer 0x${this.buffer.toString(16)} is not a DirectSound buffer`);
            return false;
        }
        this.bufferBytes = Mem.readUint32(this.scratch + 8) ?? 0;
        if (this.bufferBytes < this.blockAlign * 64) return false;
        this.silentBytes = this.bufferBytes;
        this.writeOffset = -1;
        this.playing = this.call("play", [0, 0, DSBPLAY_LOOPING]) === 0;
        return this.playing;
    }

    stop(): void {
        if (!this.playing) return;
        this.playing = false;
        this.call("stop", []);
    }

    release(): void {
        this.stop();
        if (this.scratch) this.process.memory.free(this.scratch);
        this.scratch = 0;
    }

    silentBytes = 0;

    isSilent(): boolean {
        return this.bufferBytes > 0 && this.silentBytes >= this.bufferBytes;
    }

    /** Top the buffer up to the lead beyond its write cursor, rendering what is missing. */
    pump(render: RenderPcm): void {
        if (!this.playing) return;
        const size = this.bufferBytes;
        if (this.call("getcurrentposition", [this.scratch, this.scratch + 4]) !== 0) return;
        const play = (Mem.readUint32(this.scratch) ?? 0) % size;
        const write = (Mem.readUint32(this.scratch + 4) ?? 0) % size;

        // Distances ahead of the play cursor, which is the one fixed point of the ring.
        const writeAhead = (write - play + size) % size;
        const lead = Math.floor(LEAD_SECONDS * this.bytesPerSecond);
        let filledAhead = this.writeOffset < 0 ? -1 : (this.writeOffset - play + size) % size;
        // Behind the write cursor is a stall. So is far ahead of it: the stream is never
        // written that far, so the play cursor has lapped it. Either way, start over at the cursor.
        if (filledAhead < writeAhead || filledAhead > writeAhead + lead * 2) {
            this.writeOffset = write;
            filledAhead = writeAhead;
        }
        const limit = Math.min(size - this.blockAlign * 2, writeAhead + lead);
        let want = Math.min(limit - filledAhead, Math.floor(MAX_FILL_SECONDS * this.bytesPerSecond));
        want -= want % this.blockAlign;
        if (want <= 0) return;

        const s = this.scratch + 8;
        if (this.call("lock", [this.writeOffset, want, s, s + 4, s + 8, s + 12, 0]) !== 0) return;
        const ptr1 = Mem.readUint32(s) ?? 0;
        const len1 = Mem.readUint32(s + 4) ?? 0;
        const ptr2 = Mem.readUint32(s + 8) ?? 0;
        const len2 = Mem.readUint32(s + 12) ?? 0;
        const frames = Math.floor((len1 + len2) / this.blockAlign);
        const samples = frames * (this.blockAlign >> 1);
        if (this.pcm.length < samples) this.pcm = new Int16Array(samples);
        try {
            render(this.pcm, frames);
            let silent = true;
            for (let i = 0; i < samples; i++) if (this.pcm[i] !== 0) { silent = false; break; }
            this.silentBytes = silent ? this.silentBytes + len1 + len2 : 0;
            const bytes = new Uint8Array(this.pcm.buffer, 0, samples * 2);
            if (ptr1 && len1) Mem.writeBytes(ptr1, bytes.subarray(0, len1));
            if (ptr2 && len2) Mem.writeBytes(ptr2, bytes.subarray(len1, len1 + len2));
        } finally {
            this.call("unlock", [ptr1, len1, ptr2, len2]);
        }
        this.writeOffset = (this.writeOffset + len1 + len2) % size;
    }
}

/**
 * A DirectSound buffer of our own for a port the application gave none: on its
 * DirectSound object when it passed one to the performance, else on a new one.
 * Returns the buffer's guest address, or 0.
 */
export function createSinkBuffer(process: Process, directSound: number, channels: number, sampleRate: number, flags?: number): number {
    const dsound = process.getModule("dsound");
    const mem = Mem.getView();
    if (!dsound || !mem) return 0;
    const DSBCAPS_CTRLVOLUME = 0x80;
    const DSBCAPS_CTRLPAN = 0x40;
    const DSBCAPS_GETCURRENTPOSITION2 = 0x10000;
    const DSBCAPS_GLOBALFOCUS = 0x8000;
    const DSBUFFERDESC_SIZE = 36;

    const scratch = process.memory.alloc(DSBUFFERDESC_SIZE + 18 + 8, "HEAP", "rw");
    if (!scratch) return 0;
    let createdDevice = 0;
    try {
        let ds = directSound >>> 0;
        if (!ds) {
            const create = dsound.exports["directsoundcreate"] as ThunkImplementation | undefined;
            const fresh = Mem.getView();
            if (!create || !fresh || create(NO_CONTEXT, fresh, [0, scratch, 0]) !== 0) return 0;
            ds = Mem.readUint32(scratch) ?? 0;
            if (!ds) return 0;
            createdDevice = ds;
        }
        const format = scratch + DSBUFFERDESC_SIZE;
        const out = format + 18;
        Mem.writeBytes(scratch, new Uint8Array(DSBUFFERDESC_SIZE + 18 + 8));
        Mem.writeUint32(scratch, DSBUFFERDESC_SIZE);
        Mem.writeUint32(scratch + 4, flags ?? (DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN | DSBCAPS_GETCURRENTPOSITION2 | DSBCAPS_GLOBALFOCUS));
        Mem.writeUint32(scratch + 8, sinkBufferBytes(channels, sampleRate));
        Mem.writeUint32(scratch + 16, format);
        writeWaveFormat(format, channels, sampleRate);
        const createBuffer = dsound.exports["idirectsound8_createsoundbuffer"] as ThunkImplementation | undefined;
        const fresh = Mem.getView();
        if (!createBuffer || !fresh || createBuffer(NO_CONTEXT, fresh, [ds, scratch, out, 0]) !== 0) return 0;
        const buffer = Mem.readUint32(out) ?? 0;
        if (buffer && createdDevice) {
            // The device must outlive the buffer: hand it to the buffer's last release.
            privateDevices.set(buffer >>> 0, createdDevice);
            createdDevice = 0;
        }
        return buffer;
    } finally {
        // Only a device that ended up backing no buffer is released here.
        soundReference(process, createdDevice, false, false);
        process.memory.free(scratch);
    }
}

/** The size IDirectMusicPort::GetFormat reports for the sink buffer: two seconds. */
export function sinkBufferBytes(channels: number, sampleRate: number): number {
    return sampleRate * channels * 2 * 2;
}

/** A PCM WAVEFORMATEX (18 bytes) at `address`. */
export function writeWaveFormat(address: number, channels: number, sampleRate: number): void {
    const blockAlign = channels * 2;
    Mem.writeUint16(address, 1);
    Mem.writeUint16(address + 2, channels);
    Mem.writeUint32(address + 4, sampleRate);
    Mem.writeUint32(address + 8, sampleRate * blockAlign);
    Mem.writeUint16(address + 12, blockAlign);
    Mem.writeUint16(address + 14, 16);
    Mem.writeUint16(address + 16, 0);
}
