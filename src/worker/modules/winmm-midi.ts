import { gmBankAvailable } from "../core/audio/gm-bank";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { MidiSynthOutput } from "./winmm-midi-synth";

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

const CALLBACK_TYPEMASK = 0x00070000;
const CALLBACK_NULL = 0x00000000;
const CALLBACK_WINDOW = 0x00010000;
const CALLBACK_THREAD = 0x00020000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_EVENT = 0x00050000;
const MOM_OPEN = 0x3c7;
const MOM_CLOSE = 0x3c8;
const MOM_DONE = 0x3c9;

const MHDR_DONE = 0x1;
const MHDR_PREPARED = 0x2;
const MHDR_INQUEUE = 0x4;
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
}

export class WinmmMidiOut {
    readonly handles = new Map<number, MidiOutHandle>();
    private nextHandle = 0x5d000;

    constructor(private readonly host: MidiCallbackHost) {}

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
        const h: MidiOutHandle = { handle: this.nextHandle += 4, output, flags, callback: callback >>> 0, instance: instance >>> 0 };
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
        h.output.router.allNotesOff();
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
    exports["midiOutMessage"] = (_c, _m, a) => midi.handles.has(a[0]! >>> 0) ? MMSYSERR_NOTSUPPORTED : MMSYSERR_INVALHANDLE;
}
