import { currentGmBank, loadGmBank, onGmBank } from "../core/audio/gm-bank";
import { MidiRouter } from "../core/audio/midi-router";
import { Logger, LogCategory } from "../core/logger";
import type { Process } from "../core/process";
import { setTimerHandler } from "../core/scheduler/timer-wheel";
import { TimerKind } from "../core/scheduler/types";
import { System } from "../core/system";
import { TimeService } from "../runtime/time";
import { createSinkBuffer, DirectSoundSink, soundReference } from "./dmusic-sink";

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const MAX_VOICES = 64;
const PUMP_MS = 10;

// @transient(the timer handler is registered once per worker and only dispatches to the current output)
let pumpHandlerSet = false;

export class MidiSynthOutput {
    // @transient(bound to its process: acquire replaces an output left from another session, and an open one refuses a savestate in winmm)
    private static current: MidiSynthOutput | null = null;
    readonly router = new MidiRouter(SAMPLE_RATE, MAX_VOICES);
    private readonly process: Process;
    private buffer = 0;
    private sink: DirectSoundSink | null = null;
    private pumpTimer: number | null = null;
    private lastPumpMs = 0;
    private users = 0;
    private unsubscribe: (() => void) | null = null;
    private left = new Float32Array(0);
    private right = new Float32Array(0);
    private readonly tickers = new Set<(now: number) => void>();

    private constructor(process: Process) {
        this.process = process;
        if (!pumpHandlerSet) {
            setTimerHandler(TimerKind.MIDI_SYNTH, () => MidiSynthOutput.current?.pump());
            pumpHandlerSet = true;
        }
    }

    static acquire(process: Process): MidiSynthOutput | null {
        let out = MidiSynthOutput.current;
        if (!out || out.process !== process) {
            out?.shutdown();
            out = new MidiSynthOutput(process);
            if (!out.start()) return null;
            MidiSynthOutput.current = out;
        }
        out.users++;
        return out;
    }

    static active(): MidiSynthOutput | null {
        return MidiSynthOutput.current;
    }

    release(): void {
        if (--this.users > 0) return;
        this.shutdown();
        if (MidiSynthOutput.current === this) MidiSynthOutput.current = null;
    }

    private start(): boolean {
        this.buffer = createSinkBuffer(this.process, 0, CHANNELS, SAMPLE_RATE);
        if (!this.buffer) {
            Logger.warn(LogCategory.SYSTEM, "[MIDI] no DirectSound buffer for the synthesizer");
            return false;
        }
        this.sink = new DirectSoundSink(this.process, this.buffer, CHANNELS, SAMPLE_RATE);
        if (!this.sink.start()) {
            this.sink.release();
            this.sink = null;
            soundReference(this.process, this.buffer, true, false);
            this.buffer = 0;
            return false;
        }
        const bank = currentGmBank();
        if (bank) this.router.setBank(bank);
        else {
            this.unsubscribe = onGmBank((b) => {
                this.router.setBank(b);
                Logger.log(LogCategory.SYSTEM, `[MIDI] General MIDI bank ready (${b.instruments.length} instruments)`);
            });
            void loadGmBank();
        }
        this.lastPumpMs = TimeService.getInstance().nowMs();
        this.pumpTimer = System.getInstance().scheduler?.timerWheel.add(
            PUMP_MS, true, TimerKind.MIDI_SYNTH, 0, this.lastPumpMs) ?? null;
        return true;
    }

    private shutdown(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.tickers.clear();
        if (this.pumpTimer !== null) System.getInstance().scheduler?.timerWheel.cancel(this.pumpTimer);
        this.pumpTimer = null;
        this.router.allNotesOff();
        this.router.synth.silence();
        this.sink?.release();
        this.sink = null;
        if (this.buffer) soundReference(this.process, this.buffer, true, false);
        this.buffer = 0;
    }

    addTicker(ticker: (now: number) => void): () => void {
        this.tickers.add(ticker);
        return () => this.tickers.delete(ticker);
    }

    shortMessage(message: number): void {
        this.router.shortMessage(message, TimeService.getInstance().nowMs());
    }

    private pump(): void {
        const system = System.getInstance();
        if (!system.process || system.isExiting || !this.sink) return;
        const now = TimeService.getInstance().nowMs();
        const since = this.lastPumpMs;
        this.lastPumpMs = now;
        for (const ticker of [...this.tickers]) ticker(now);
        this.sink.pump((pcm, frames) => this.render(pcm, frames, since, now));
        this.router.flush();
    }

    private render(pcm: Int16Array, frames: number, since: number, now: number): void {
        if (this.left.length < frames) {
            this.left = new Float32Array(frames);
            this.right = new Float32Array(frames);
        }
        const left = this.left, right = this.right;
        left.fill(0, 0, frames);
        right.fill(0, 0, frames);
        this.router.render(left, right, frames, since, now);
        for (let i = 0; i < frames; i++) {
            const l = Math.round(left[i]! * 32767), r = Math.round(right[i]! * 32767);
            pcm[i * 2] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
            pcm[i * 2 + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
        }
    }
}
