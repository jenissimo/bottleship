import { type DlsCollection, F_INSTRUMENT_DRUMS } from "@bottleship/formats/dmusic/dls";
import { DlsSynth } from "./directmusic/synth";

const DRUM_CHANNEL = 9;

interface QueuedEvent { at: number; status: number; data1: number; data2: number }

export interface MidiChannelState { program: number; bankMsb: number; bankLsb: number }

export class MidiRouter {
    readonly synth: DlsSynth;
    readonly channels: MidiChannelState[] = Array.from({ length: 16 }, () => ({ program: 0, bankMsb: 0, bankLsb: 0 }));
    private bank: DlsCollection | null = null;
    private queue: QueuedEvent[] = [];
    volume = 0xffffffff;

    constructor(sampleRate: number, maxVoices: number) {
        this.synth = new DlsSynth(sampleRate, maxVoices);
        this.resetChannels();
    }

    get pending(): number {
        return this.queue.length;
    }

    setBank(bank: DlsCollection | null): void {
        this.bank = bank;
        for (let ch = 0; ch < 16; ch++) this.selectProgram(ch);
    }

    patchFor(ch: number): number {
        const state = this.channels[ch]!;
        if (ch === DRUM_CHANNEL) return F_INSTRUMENT_DRUMS | state.program;
        return (state.bankMsb << 16) | (state.bankLsb << 8) | state.program;
    }

    private selectProgram(ch: number): void {
        this.synth.setInstrument(ch, this.bank, this.patchFor(ch));
    }

    resetChannels(): void {
        this.queue = [];
        this.synth.silence();
        for (let ch = 0; ch < 16; ch++) {
            Object.assign(this.channels[ch]!, { program: 0, bankMsb: 0, bankLsb: 0 });
            this.synth.controlChange(ch, 121, 0);
            this.synth.controlChange(ch, 7, 100);
            this.synth.controlChange(ch, 10, 64);
            this.synth.controlChange(ch, 101, 0);
            this.synth.controlChange(ch, 100, 0);
            this.synth.controlChange(ch, 6, 2);
            this.synth.controlChange(ch, 38, 0);
            this.synth.controlChange(ch, 101, 127);
            this.synth.controlChange(ch, 100, 127);
            this.synth.pitchBend(ch, 0x2000);
            this.selectProgram(ch);
        }
    }

    allNotesOff(): void {
        this.queue = [];
        for (let ch = 0; ch < 16; ch++) this.synth.allNotesOff(ch);
    }

    shortMessage(message: number, at: number): void {
        const status = message & 0xff;
        if (status < 0x80 || status >= 0xf0) return;
        this.queue.push({ at, status, data1: (message >>> 8) & 0x7f, data2: (message >>> 16) & 0x7f });
    }

    systemExclusive(bytes: Uint8Array): void {
        const gmOn = bytes.length >= 6 && bytes[0] === 0xf0 && bytes[1] === 0x7e && bytes[3] === 0x09;
        const gsReset = bytes.length >= 11 && bytes[0] === 0xf0 && bytes[1] === 0x41 && bytes[3] === 0x42
            && bytes[4] === 0x12 && bytes[5] === 0x40 && bytes[6] === 0x00 && bytes[7] === 0x7f;
        if (gmOn || gsReset) this.resetChannels();
    }

    setVolume(volume: number): void {
        this.volume = volume >>> 0;
        const level = Math.max(volume & 0xffff, (volume >>> 16) & 0xffff) / 0xffff;
        this.synth.setMasterVolume(level > 0 ? Math.max(-9600, 2000 * Math.log10(level)) : -9600);
    }

    private dispatch(e: QueuedEvent): void {
        const ch = e.status & 0x0f;
        const state = this.channels[ch]!;
        switch (e.status & 0xf0) {
            case 0x80: this.synth.noteOff(ch, e.data1); break;
            case 0x90: this.synth.noteOn(ch, e.data1, e.data2); break;
            case 0xb0:
                if (e.data1 === 0) state.bankMsb = e.data2;
                else if (e.data1 === 32) state.bankLsb = e.data2;
                else this.synth.controlChange(ch, e.data1, e.data2);
                break;
            case 0xc0:
                state.program = e.data1;
                this.selectProgram(ch);
                break;
            case 0xe0: this.synth.pitchBend(ch, e.data1 | (e.data2 << 7)); break;
        }
    }

    flush(): void {
        for (const e of this.queue.splice(0)) this.dispatch(e);
    }

    render(left: Float32Array, right: Float32Array, frames: number, since: number, until: number): void {
        const span = Math.max(1, until - since);
        let cursor = 0;
        for (const e of this.queue.splice(0)) {
            const at = Math.min(frames, Math.max(cursor, Math.floor(((e.at - since) / span) * frames)));
            if (at > cursor) {
                this.synth.render(left, right, cursor, at - cursor);
                cursor = at;
            }
            this.dispatch(e);
        }
        if (cursor < frames) this.synth.render(left, right, cursor, frames - cursor);
    }
}
