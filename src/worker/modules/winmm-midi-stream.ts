import { Mem } from "../core/memory/mem-accessor";

/**
 * The player behind a midiStream handle: the MIDIEVENT buffers a title queues with
 * midiStreamOut, played on the stream's own clock (tempo and time division set with
 * midiStreamProperty or MEVT_TEMPO), opened paused like Windows' stream.
 *
 * A MIDIHDR's lpData holds back-to-back MIDIEVENTs of dwBytesRecorded bytes:
 * { dwDeltaTime, dwStreamID, dwEvent[, parameters padded to a DWORD] }. The high byte of
 * dwEvent is the event type (MEVT_*) with MEVT_F_LONG and MEVT_F_CALLBACK as flags; the low
 * 24 bits are the short message, the tempo, or the length of the parameters that follow.
 */

export const MEVT_F_LONG = 0x80000000;
export const MEVT_F_CALLBACK = 0x40000000;
export const MEVT_SHORTMSG = 0x00;
export const MEVT_TEMPO = 0x01;
export const MEVT_LONGMSG = 0x80;

const MHDR_DONE = 0x1;
const MHDR_INQUEUE = 0x4;
const MIDIEVENT_HEADER = 12;
const HDR_DATA = 0, HDR_RECORDED = 8, HDR_FLAGS = 16, HDR_OFFSET = 28;
const MAX_LONG_EVENT = 0x10000;

/** Wine's defaults for a freshly opened stream: 120 quarter notes a minute, 480 ticks each. */
export const DEFAULT_TEMPO = 500000;
export const DEFAULT_TIMEDIV = 480;

export interface MidiStreamSink {
    shortMessage(message: number, at: number): void;
    systemExclusive(bytes: Uint8Array): void;
    allNotesOff(): void;
}

export interface MidiStreamCallbacks {
    /** A queued buffer has been played (or returned by a stop): MOM_DONE. */
    done(hdr: number): void;
    /** An event with MEVT_F_CALLBACK was played; its offset is in the header's dwOffset: MOM_POSITIONCB. */
    position(hdr: number): void;
}

export class MidiStream {
    tempo = DEFAULT_TEMPO;
    timeDiv = DEFAULT_TIMEDIV;
    playing = false;
    private readonly queue: number[] = [];
    private offset = 0;
    /** Wall time of stream position 0 while playing. */
    private anchor = 0;
    /** Stream position (ms) of the last event played. */
    private eventMs = 0;
    /** Stream position (ms) while paused. */
    private pausedMs = 0;
    private ticks = 0;
    /** The queue ran dry while playing: the next event is timed from when it arrives, so a
     *  title that queues its next buffer late hears it on time instead of as one burst. */
    private starved = false;

    constructor(private readonly sink: MidiStreamSink, private readonly callbacks: MidiStreamCallbacks) {}

    get queued(): number {
        return this.queue.length;
    }

    msPerTick(): number {
        const div = this.timeDiv >>> 0;
        if (div & 0x8000) {
            const fps = -(((div >> 8) & 0xff) << 24 >> 24);
            const perFrame = div & 0xff;
            return fps > 0 && perFrame > 0 ? 1000 / (fps * perFrame) : 0;
        }
        return div > 0 ? this.tempo / 1000 / div : 0;
    }

    enqueue(hdr: number): void {
        this.queue.push(hdr >>> 0);
    }

    restart(now: number): void {
        if (this.playing) return;
        this.anchor = now - this.pausedMs;
        this.playing = true;
    }

    pause(now: number): void {
        if (!this.playing) return;
        this.pausedMs = now - this.anchor;
        this.playing = false;
        this.sink.allNotesOff();
    }

    /** Silences the stream, returns every queued buffer and rewinds to position 0, paused. */
    stop(): void {
        this.playing = false;
        this.pausedMs = 0;
        this.eventMs = 0;
        this.ticks = 0;
        this.offset = 0;
        this.starved = false;
        this.sink.allNotesOff();
        while (this.queue.length) this.finish(this.queue[0]!);
    }

    positionMs(now: number): number {
        return Math.max(0, this.playing ? now - this.anchor : this.pausedMs);
    }

    positionTicks(): number {
        return this.ticks;
    }

    tick(now: number): void {
        while (this.playing && this.queue.length) {
            const hdr = this.queue[0]!;
            const data = Mem.readUint32(hdr + HDR_DATA) ?? 0;
            const recorded = Mem.readUint32(hdr + HDR_RECORDED) ?? 0;
            if (!data || this.offset + MIDIEVENT_HEADER > recorded) {
                this.finish(hdr);
                continue;
            }
            const at = data + this.offset;
            const delta = Mem.readUint32(at) ?? 0;
            const event = (Mem.readUint32(at + 8) ?? 0) >>> 0;
            let due = this.anchor + this.eventMs + delta * this.msPerTick();
            if (this.starved) {
                if (due < now) {
                    this.anchor += now - due;
                    due = now;
                }
                this.starved = false;
            }
            if (due > now) return;
            this.eventMs = due - this.anchor;
            this.ticks += delta;
            const length = event & 0xffffff;
            const size = MIDIEVENT_HEADER + ((event & MEVT_F_LONG) ? ((length + 3) & ~3) : 0);
            this.play(event, at + MIDIEVENT_HEADER, length, due);
            if (event & MEVT_F_CALLBACK) {
                Mem.writeUint32(hdr + HDR_OFFSET, this.offset);
                this.callbacks.position(hdr);
            }
            this.offset += size;
        }
        if (this.playing && !this.queue.length) this.starved = true;
    }

    private play(event: number, params: number, length: number, at: number): void {
        switch ((event >>> 24) & ~(MEVT_F_CALLBACK >>> 24) & 0xff) {
            case MEVT_SHORTMSG:
                this.sink.shortMessage(length, at);
                break;
            case MEVT_TEMPO:
                if (length) this.tempo = length;
                break;
            case MEVT_LONGMSG: {
                const bytes = length ? Mem.readBytes(params, Math.min(length, MAX_LONG_EVENT)) : null;
                if (bytes) this.sink.systemExclusive(bytes);
                break;
            }
        }
    }

    private finish(hdr: number): void {
        if (this.queue[0] === hdr) this.queue.shift();
        this.offset = 0;
        const flags = Mem.readUint32(hdr + HDR_FLAGS) ?? 0;
        Mem.writeUint32(hdr + HDR_FLAGS, (flags | MHDR_DONE) & ~MHDR_INQUEUE);
        this.callbacks.done(hdr);
    }
}
