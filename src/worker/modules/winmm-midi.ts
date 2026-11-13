import { currentGmBank, gmBankAvailable, loadGmBank } from "../core/audio/gm-bank";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { TimeService } from "../runtime/time";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { pickDefined, type FieldPolicy } from "../savestate/participant";
import { MidiStream } from "./winmm-midi-stream";
import { MidiSynthOutput, type MidiOutputData } from "./winmm-midi-synth";

const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_NOTSUPPORTED = 8;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_NOMEM = 7;
const MMSYSERR_INVALFLAG = 10;
const MMSYSERR_INVALPARAM = 11;
const MIDIERR_UNPREPARED = 64;
const MIDIERR_STILLPLAYING = 65;
const MIDI_MAPPER = 0xffffffff;
export const MIDI_FIRST_HANDLE = 0x5d000;

const CALLBACK_TYPEMASK = 0x00070000;
const CALLBACK_NULL = 0x00000000;
const CALLBACK_WINDOW = 0x00010000;
const CALLBACK_THREAD = 0x00020000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_EVENT = 0x00050000;
const MOM_OPEN = 0x3c7;
const MOM_CLOSE = 0x3c8;
const MOM_DONE = 0x3c9;
const MOM_POSITIONCB = 0x3ca;

const MHDR_DONE = 0x1;
const MHDR_PREPARED = 0x2;
const MHDR_INQUEUE = 0x4;
const MHDR_ISSTRM = 0x8;
const MIDIHDR_MIN_SIZE = 36;

const MOD_SWSYNTH = 7;
const MIDICAPS_VOLUME = 0x1;
const MIDICAPS_LRVOLUME = 0x2;
const DEVICE_NAME = "Microsoft GS Wavetable SW Synth";

export interface MidiCallbackHost {
    callFunction(callback: number, args: number[]): void;
}

interface MidiOutHandle {
    handle: number;
    output: MidiSynthOutput;
    flags: number;
    callback: number;
    instance: number;
    /** The player of a midiStream handle; null for a plain midiOut handle. */
    stream: MidiStream | null;
    untick: (() => void) | null;
}

const MIDIPROP_SET = 0x80000000;
const MIDIPROP_GET = 0x40000000;
const MIDIPROP_TIMEDIV = 0x1;
const MIDIPROP_TEMPO = 0x2;
const TIME_MS = 0x1;
const TIME_TICKS = 0x20;
const MMTIME_SIZE = 12;

export const MIDI_HANDLE_FIELDS = {
    handle: 'save', output: 'derive', flags: 'save', callback: 'save', instance: 'save',
    // A stream's queue and clock are refused, not saved: captureState throws while one is open.
    stream: 'transient', untick: 'transient',
} as const satisfies Record<keyof MidiOutHandle, FieldPolicy>;

export const MIDI_OUT_FIELDS = {
    handles: 'save', nextHandle: 'save', host: 'host',
} as const satisfies Record<string, FieldPolicy>;

export interface MidiOutState {
    nextHandle: number;
    handles: Array<Omit<MidiOutHandle, 'output' | 'stream' | 'untick'>>;
    output: MidiOutputData | null;
}

export class WinmmMidiOut {
    readonly handles = new Map<number, MidiOutHandle>();
    private nextHandle = MIDI_FIRST_HANDLE;

    constructor(private readonly host: MidiCallbackHost) {}

    captureState(): MidiOutState {
        const handles = [...this.handles.values()];
        if (handles.some(h => h.stream)) throw new Error('winmm: a MIDI stream is open; its queued buffers and clock are not part of a v1 savestate');
        const output = handles[0]?.output ?? null;
        if (handles.some(h => h.output !== output)) throw new Error('winmm: MIDI output handles play through more than one synthesizer');
        return {
            nextHandle: this.nextHandle,
            handles: handles.map(h => pickDefined(h, MIDI_HANDLE_FIELDS)),
            output: output ? output.captureState() : null,
        };
    }

    restoreState(d: MidiOutState): void | Promise<void> {
        this.nextHandle = d.nextHandle;
        this.handles.clear();
        MidiSynthOutput.discard();
        const saved = d.output;
        if (!saved || d.handles.length === 0) return;
        const process = System.getInstance().process;
        if (!process) throw new Error('winmm: MIDI output handles cannot be restored without a process');
        const finish = (): void => {
            const output = MidiSynthOutput.restore(process, saved, d.handles.length);
            for (const h of d.handles) this.handles.set(h.handle, { ...h, output, stream: null, untick: null });
        };
        if (saved.router.bank && !currentGmBank()) return loadGmBank().then(finish);
        finish();
    }

    openCount(): number {
        return this.handles.size;
    }

    deviceCount(): number {
        return gmBankAvailable() ? 1 : 0;
    }

    validDevice(id: number): boolean {
        return this.deviceCount() > 0 && (id === 0 || id === MIDI_MAPPER || id === 0xffff);
    }

    private notify(h: MidiOutHandle, message: number, param1: number): void {
        switch (h.flags & CALLBACK_TYPEMASK) {
            case CALLBACK_FUNCTION:
                if (h.callback) this.host.callFunction(h.callback, [h.handle, message, h.instance, param1, 0]);
                break;
            case CALLBACK_WINDOW:
                if (h.callback) System.getInstance().windowManager.postMessage(h.callback, message, h.handle, param1);
                break;
            case CALLBACK_EVENT:
                if (h.callback) System.getInstance().scheduler.setEvent(h.callback);
                break;
        }
    }

    writeCaps(ptr: number, size: number, wide: boolean): number {
        const nameBytes = wide ? 64 : 32;
        const total = 8 + nameBytes + 12;
        if (!ptr || size === 0) return MMSYSERR_INVALPARAM;
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        view.setUint16(0, 1, true);
        view.setUint16(2, 102, true);
        view.setUint32(4, 0x0500, true);
        for (let i = 0; i < DEVICE_NAME.length; i++) {
            if (wide) view.setUint16(8 + i * 2, DEVICE_NAME.charCodeAt(i), true);
            else out[8 + i] = DEVICE_NAME.charCodeAt(i);
        }
        const o = 8 + nameBytes;
        view.setUint16(o, MOD_SWSYNTH, true);
        view.setUint16(o + 2, 32, true);
        view.setUint16(o + 4, 32, true);
        view.setUint16(o + 6, 0xffff, true);
        view.setUint32(o + 8, MIDICAPS_VOLUME | MIDICAPS_LRVOLUME, true);
        Mem.writeBytes(ptr, out.subarray(0, Math.min(size, total)));
        return MMSYSERR_NOERROR;
    }

    open(phmo: number, deviceId: number, callback: number, instance: number, flags: number): number {
        if (phmo) Mem.writeUint32(phmo, 0);
        if (!phmo) return MMSYSERR_INVALPARAM;
        if (!this.validDevice(deviceId >>> 0)) {
            Logger.log(LogCategory.SYSTEM, `midiOutOpen(${deviceId >>> 0}) -> MMSYSERR_BADDEVICEID (no General MIDI bank)`);
            return MMSYSERR_BADDEVICEID;
        }
        const type = flags & CALLBACK_TYPEMASK;
        if (type !== CALLBACK_NULL && type !== CALLBACK_WINDOW && type !== CALLBACK_FUNCTION
            && type !== CALLBACK_EVENT && type !== CALLBACK_THREAD) return MMSYSERR_INVALFLAG;
        const process = System.getInstance().process;
        const output = process ? MidiSynthOutput.acquire(process) : null;
        if (!output) return MMSYSERR_NOMEM;
        const h: MidiOutHandle = { handle: this.nextHandle += 4, output, flags, callback: callback >>> 0, instance: instance >>> 0, stream: null, untick: null };
        this.handles.set(h.handle, h);
        Mem.writeUint32(phmo, h.handle);
        Logger.log(LogCategory.SYSTEM, `midiOutOpen -> 0x${h.handle.toString(16)} (callback type 0x${type.toString(16)})`);
        this.notify(h, MOM_OPEN, 0);
        return MMSYSERR_NOERROR;
    }

    close(hmo: number): number {
        const h = this.handles.get(hmo >>> 0);
        if (!h) return MMSYSERR_INVALHANDLE;
        this.handles.delete(h.handle);
        h.stream?.stop();
        h.untick?.();
        h.untick = null;
        h.output.router.allNotesOff();
        h.output.release();
        this.notify(h, MOM_CLOSE, 0);
        return MMSYSERR_NOERROR;
    }

    shortMessage(hmo: number, message: number): number {
        const h = this.handles.get(hmo >>> 0);
        if (!h) return MMSYSERR_INVALHANDLE;
        h.output.shortMessage(message >>> 0);
        return MMSYSERR_NOERROR;
    }

    prepare(hmo: number, hdr: number, size: number, prepare: boolean): number {
        if (!this.handles.has(hmo >>> 0)) return MMSYSERR_INVALHANDLE;
        if (!hdr || size < MIDIHDR_MIN_SIZE - 4) return MMSYSERR_INVALPARAM;
        const flags = Mem.readUint32(hdr + 16) ?? 0;
        if (!prepare && (flags & MHDR_INQUEUE)) return MIDIERR_STILLPLAYING;
        Mem.writeUint32(hdr + 16, prepare ? flags | MHDR_PREPARED : flags & ~MHDR_PREPARED);
        return MMSYSERR_NOERROR;
    }

    longMessage(hmo: number, hdr: number, size: number): number {
        const h = this.handles.get(hmo >>> 0);
        if (!h) return MMSYSERR_INVALHANDLE;
        if (!hdr || size < MIDIHDR_MIN_SIZE - 4) return MMSYSERR_INVALPARAM;
        const flags = Mem.readUint32(hdr + 16) ?? 0;
        if (!(flags & MHDR_PREPARED)) return MIDIERR_UNPREPARED;
        const data = Mem.readUint32(hdr) ?? 0;
        const length = Mem.readUint32(hdr + 4) ?? 0;
        const bytes = data && length ? Mem.readBytes(data, Math.min(length, 0x10000)) : null;
        if (bytes) h.output.router.systemExclusive(bytes);
        Mem.writeUint32(hdr + 16, (flags | MHDR_DONE) & ~MHDR_INQUEUE);
        this.notify(h, MOM_DONE, hdr);
        return MMSYSERR_NOERROR;
    }

    reset(hmo: number): number {
        const h = this.handles.get(hmo >>> 0);
        if (!h) return MMSYSERR_INVALHANDLE;
        h.stream?.stop();
        h.output.router.allNotesOff();
        return MMSYSERR_NOERROR;
    }

    /** midiStreamOpen: a midiOut handle on the same device with a paused stream player. */
    openStream(phms: number, puDeviceId: number, cMidi: number, callback: number, instance: number, flags: number): number {
        if (phms) Mem.writeUint32(phms, 0);
        if (!phms || !puDeviceId || cMidi !== 1) return MMSYSERR_INVALPARAM;
        const result = this.open(phms, Mem.readUint32(puDeviceId) ?? 0, callback, instance, flags);
        if (result !== MMSYSERR_NOERROR) return result;
        const h = this.handles.get(Mem.readUint32(phms) ?? 0)!;
        const router = h.output.router;
        const stream = new MidiStream(router, {
            done: (hdr) => this.notify(h, MOM_DONE, hdr),
            position: (hdr) => this.notify(h, MOM_POSITIONCB, hdr),
        });
        h.stream = stream;
        h.untick = h.output.addTicker((now) => stream.tick(now));
        return MMSYSERR_NOERROR;
    }

    private streamOf(hms: number): MidiStream | null {
        return this.handles.get(hms >>> 0)?.stream ?? null;
    }

    streamOut(hms: number, hdr: number, size: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        if (!hdr || size < MIDIHDR_MIN_SIZE) return MMSYSERR_INVALPARAM;
        const flags = Mem.readUint32(hdr + 16) ?? 0;
        if (!(flags & MHDR_PREPARED)) return MIDIERR_UNPREPARED;
        if (flags & MHDR_INQUEUE) return MIDIERR_STILLPLAYING;
        Mem.writeUint32(hdr + 16, (flags & ~MHDR_DONE) | MHDR_INQUEUE | MHDR_ISSTRM);
        stream.enqueue(hdr);
        stream.tick(TimeService.getInstance().nowMs());
        return MMSYSERR_NOERROR;
    }

    streamRestart(hms: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        const now = TimeService.getInstance().nowMs();
        stream.restart(now);
        stream.tick(now);
        return MMSYSERR_NOERROR;
    }

    streamPause(hms: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        stream.pause(TimeService.getInstance().nowMs());
        return MMSYSERR_NOERROR;
    }

    streamStop(hms: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        stream.stop();
        return MMSYSERR_NOERROR;
    }

    streamClose(hms: number): number {
        return this.streamOf(hms) ? this.close(hms) : MMSYSERR_INVALHANDLE;
    }

    streamProperty(hms: number, data: number, property: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        const prop = property >>> 0;
        const get = (prop & MIDIPROP_GET) !== 0, set = (prop & MIDIPROP_SET) !== 0;
        const which = prop & ~(MIDIPROP_GET | MIDIPROP_SET);
        if (get === set || (which !== MIDIPROP_TIMEDIV && which !== MIDIPROP_TEMPO)) return MMSYSERR_INVALPARAM;
        if (!data || (Mem.readUint32(data) ?? 0) !== 8) return MMSYSERR_INVALPARAM;
        if (get) {
            Mem.writeUint32(data + 4, which === MIDIPROP_TEMPO ? stream.tempo : stream.timeDiv);
            return MMSYSERR_NOERROR;
        }
        const value = Mem.readUint32(data + 4) ?? 0;
        if (which === MIDIPROP_TEMPO) stream.tempo = value;
        else stream.timeDiv = value;
        return MMSYSERR_NOERROR;
    }

    streamPosition(hms: number, mmtime: number, size: number): number {
        const stream = this.streamOf(hms);
        if (!stream) return MMSYSERR_INVALHANDLE;
        if (!mmtime || size < MMTIME_SIZE) return MMSYSERR_INVALPARAM;
        if ((Mem.readUint32(mmtime) ?? 0) === TIME_TICKS) {
            Mem.writeUint32(mmtime + 4, stream.positionTicks());
            return MMSYSERR_NOERROR;
        }
        Mem.writeUint32(mmtime, TIME_MS);
        Mem.writeUint32(mmtime + 4, Math.floor(stream.positionMs(TimeService.getInstance().nowMs())));
        return MMSYSERR_NOERROR;
    }

    getVolume(target: number, ptr: number): number {
        if (!ptr) return MMSYSERR_INVALPARAM;
        const h = this.handles.get(target >>> 0);
        if (!h && !this.validDevice(target >>> 0)) return MMSYSERR_INVALHANDLE;
        Mem.writeUint32(ptr, (h?.output ?? MidiSynthOutput.active())?.router.volume ?? 0xffffffff);
        return MMSYSERR_NOERROR;
    }

    setVolume(target: number, volume: number): number {
        const h = this.handles.get(target >>> 0);
        if (!h && !this.validDevice(target >>> 0)) return MMSYSERR_INVALHANDLE;
        (h?.output ?? MidiSynthOutput.active())?.router.setVolume(volume >>> 0);
        return MMSYSERR_NOERROR;
    }

    getId(hmo: number, ptr: number): number {
        if (!this.handles.has(hmo >>> 0)) return MMSYSERR_INVALHANDLE;
        if (!ptr) return MMSYSERR_INVALPARAM;
        Mem.writeUint32(ptr, 0);
        return MMSYSERR_NOERROR;
    }
}

export function registerWinmmMidiOutExports(exports: Record<string, ThunkImplementation>, midi: WinmmMidiOut): void {
    exports["midiOutGetNumDevs"] = () => midi.deviceCount();
    exports["midiOutGetDevCapsA"] = (_c, _m, a) => midi.validDevice(a[0]! >>> 0) ? midi.writeCaps(a[1]! >>> 0, a[2]! >>> 0, false) : MMSYSERR_BADDEVICEID;
    exports["midiOutGetDevCapsW"] = (_c, _m, a) => midi.validDevice(a[0]! >>> 0) ? midi.writeCaps(a[1]! >>> 0, a[2]! >>> 0, true) : MMSYSERR_BADDEVICEID;
    exports["midiOutOpen"] = (_c, _m, a) => midi.open(a[0]! >>> 0, a[1]! >>> 0, a[2]! >>> 0, a[3]! >>> 0, a[4]! >>> 0);
    exports["midiOutClose"] = (_c, _m, a) => midi.close(a[0]!);
    exports["midiOutShortMsg"] = (_c, _m, a) => midi.shortMessage(a[0]!, a[1]!);
    exports["midiOutLongMsg"] = (_c, _m, a) => midi.longMessage(a[0]!, a[1]! >>> 0, a[2]! >>> 0);
    exports["midiOutPrepareHeader"] = (_c, _m, a) => midi.prepare(a[0]!, a[1]! >>> 0, a[2]! >>> 0, true);
    exports["midiOutUnprepareHeader"] = (_c, _m, a) => midi.prepare(a[0]!, a[1]! >>> 0, a[2]! >>> 0, false);
    exports["midiOutReset"] = (_c, _m, a) => midi.reset(a[0]!);
    exports["midiOutGetVolume"] = (_c, _m, a) => midi.getVolume(a[0]!, a[1]! >>> 0);
    exports["midiOutSetVolume"] = (_c, _m, a) => midi.setVolume(a[0]!, a[1]!);
    exports["midiOutGetID"] = (_c, _m, a) => midi.getId(a[0]!, a[1]! >>> 0);
    exports["midiStreamOpen"] = (_c, _m, a) => midi.openStream(a[0]! >>> 0, a[1]! >>> 0, a[2]! >>> 0, a[3]! >>> 0, a[4]! >>> 0, a[5]! >>> 0);
    exports["midiStreamClose"] = (_c, _m, a) => midi.streamClose(a[0]!);
    exports["midiStreamOut"] = (_c, _m, a) => midi.streamOut(a[0]!, a[1]! >>> 0, a[2]! >>> 0);
    exports["midiStreamRestart"] = (_c, _m, a) => midi.streamRestart(a[0]!);
    exports["midiStreamPause"] = (_c, _m, a) => midi.streamPause(a[0]!);
    exports["midiStreamStop"] = (_c, _m, a) => midi.streamStop(a[0]!);
    exports["midiStreamProperty"] = (_c, _m, a) => midi.streamProperty(a[0]!, a[1]! >>> 0, a[2]! >>> 0);
    exports["midiStreamPosition"] = (_c, _m, a) => midi.streamPosition(a[0]!, a[1]! >>> 0, a[2]! >>> 0);
    exports["midiOutMessage"] = (_c, _m, a) => midi.handles.has(a[0]! >>> 0) ? MMSYSERR_NOTSUPPORTED : MMSYSERR_INVALHANDLE;
}
