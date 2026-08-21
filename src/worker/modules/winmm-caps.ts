/**
 * winmm device-caps handlers (waveIn*, midi*, mixer*, aux*).
 *
 * A device count here is a PROMISE: an app that reads N > 0 goes on to open device 0
 * and drive it, and a count we cannot back is worse than a zero — the open fails deep
 * inside the app's audio init instead of at the one call that asks "is there one?".
 * So the numbers state what is actually behind each API:
 *   - aux: one device, and its volume really does drive the CD-audio line.
 *   - waveIn: one device (the capture stubs accept and complete headers).
 *   - MIDI out/in: NONE. There is no synthesizer and no MIDI port; a game told
 *     otherwise plays its whole soundtrack into a sink and hears silence, or fails
 *     inside midiOutOpen with no way to fall back.
 *   - mixer: NONE. No mixer line/control topology is implemented, and returning
 *     MMSYSERR_NOERROR from mixerGetLineInfo with the caller's MIXERLINE untouched
 *     hands it stack garbage as a line id it then queries controls for.
 * Aux master volume lives in the registration closure (one WinMM registration per
 * process).
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../core/logger';
import { virtualCd } from '../core/audio/virtual-cd';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_INVALPARAM = 11;
const AUX_MAPPER = 0xFFFFFFFF;
const AUXCAPS_VOLUME = 0x0001;
const AUXCAPS_LRVOLUME = 0x0002;
const WHDR_PREPARED = 0x00000002;

function isValidAuxDeviceId(uDeviceID: number): boolean {
    return uDeviceID === 0 || uDeviceID === AUX_MAPPER;
}

/** MIDI output devices we can serve. There is no synth, so there are none, and
 *  MIDI_MAPPER has nothing to map to either. */
const MIDI_OUT_DEVICES = 0;
/** MIDI input devices — no port, no host MIDI capture. */
const MIDI_IN_DEVICES = 0;

function writeAuxCaps(mem: Uint8Array, pac: number, isWide: boolean): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(pac + 0, 0xFFFF, true); // wMid
    view.setUint16(pac + 2, 0x0001, true); // wPid
    view.setUint32(pac + 4, 0x0100, true); // vDriverVersion

    const name = "Emulated Aux Audio";
    if (isWide) {
        // szPname[32] WCHAR
        for (let i = 0; i < 32; i++) {
            const code = i < name.length ? name.charCodeAt(i) : 0;
            view.setUint16(pac + 8 + i * 2, code, true);
        }
        view.setUint16(pac + 72, 1, true); // wTechnology
        view.setUint16(pac + 74, 0, true); // wReserved1
        view.setUint32(pac + 76, AUXCAPS_VOLUME | AUXCAPS_LRVOLUME, true); // dwSupport
    } else {
        // szPname[32] CHAR
        for (let i = 0; i < 32; i++) {
            mem[pac + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
        }
        view.setUint16(pac + 40, 1, true); // wTechnology
        view.setUint16(pac + 42, 0, true); // wReserved1
        view.setUint32(pac + 44, AUXCAPS_VOLUME | AUXCAPS_LRVOLUME, true); // dwSupport
    }
}

export function registerWinmmCapsExports(exports: Record<string, ThunkImplementation>): void {
    // PlaySound-style master volume for the emulated aux device (per registration).
    let auxVolume = 0xFFFFFFFF;

    // ==================== Wave Input Functions (Stubs) ====================

    exports["waveInGetNumDevs"] = () => 1;

    exports["waveInGetDevCapsA"] = (ctx, mem, args) => {
        const pwic = args[1];
        const cbwic = args[2];
        if (pwic && cbwic >= 48) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pwic + 0, 0xFFFF, true);
            view.setUint16(pwic + 2, 0x0001, true);
            view.setUint32(pwic + 4, 0x0100, true);
            const name = "BottleShip Audio In\0";
            for (let i = 0; i < 32; i++) {
                mem[pwic + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
            }
            view.setUint32(pwic + 40, 0x00FF00FF, true);
            view.setUint16(pwic + 44, 2, true);
            view.setUint16(pwic + 46, 0, true);
        }
        return MMSYSERR_NOERROR;
    };

    exports["waveInGetDevCapsW"] = (ctx, mem, args) => {
        const pwic = args[1];
        const cbwic = args[2];
        if (pwic && cbwic >= 80) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pwic + 0, 0xFFFF, true);
            view.setUint16(pwic + 2, 0x0001, true);
            view.setUint32(pwic + 4, 0x0100, true);
            const name = "BottleShip Audio In";
            for (let i = 0; i < 32; i++) {
                const ch = i < name.length ? name.charCodeAt(i) : 0;
                view.setUint16(pwic + 8 + i * 2, ch, true);
            }
            view.setUint32(pwic + 72, 0x00FF00FF, true);
            view.setUint16(pwic + 76, 2, true);
            view.setUint16(pwic + 78, 0, true);
        }
        return MMSYSERR_NOERROR;
    };

    exports["waveInOpen"] = (ctx, mem, args) => {
        const phwi = args[0];
        if (phwi) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phwi, 0x30000001, true);
        }
        return MMSYSERR_NOERROR;
    };
    exports["waveInClose"] = () => MMSYSERR_NOERROR;
    exports["waveInPrepareHeader"] = (ctx, mem, args) => {
        const pwh = args[1];
        if (pwh) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const flags = view.getUint32(pwh + 16, true);
            view.setUint32(pwh + 16, flags | WHDR_PREPARED, true);
        }
        return MMSYSERR_NOERROR;
    };
    exports["waveInUnprepareHeader"] = () => MMSYSERR_NOERROR;
    exports["waveInAddBuffer"] = () => MMSYSERR_NOERROR;
    exports["waveInStart"] = () => MMSYSERR_NOERROR;
    exports["waveInStop"] = () => MMSYSERR_NOERROR;
    exports["waveInReset"] = () => MMSYSERR_NOERROR;

    // ==================== MIDI Input Functions ====================

    exports["midiInGetNumDevs"] = () => MIDI_IN_DEVICES;
    exports["midiInGetDevCapsA"] = () => MMSYSERR_BADDEVICEID;
    exports["midiInGetID"] = () => MMSYSERR_INVALHANDLE;
    exports["midiInOpen"] = () => MMSYSERR_BADDEVICEID;
    // Nothing can hold a MIDI-in handle when the open always fails, so every call that
    // takes one is answering about a handle we never issued.
    for (const name of ["midiInClose", "midiInStart", "midiInStop", "midiInReset",
                        "midiInAddBuffer", "midiInPrepareHeader", "midiInUnprepareHeader",
                        "midiInMessage"]) {
        exports[name] = () => MMSYSERR_INVALHANDLE;
    }

    // ==================== MIDI Output Functions ====================

    // No synthesizer is emulated. Saying so at midiOutGetNumDevs is the difference
    // between a game disabling its MIDI music (and often falling back to CD/wave audio)
    // and a game handing every note to an open that fails for no stated reason.
    exports["midiOutGetNumDevs"] = () => MIDI_OUT_DEVICES;
    exports["midiOutGetDevCapsA"] = () => MMSYSERR_BADDEVICEID;
    exports["midiOutOpen"] = (ctx, mem, args) => {
        const phmo = args[0] >>> 0;
        // The handle is the caller's whole result; leaving it as stack garbage on a
        // failure it may not check is how a NULL-ish handle becomes a wild call.
        if (phmo && phmo + 4 <= mem.length) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(phmo, 0, true);
        }
        Logger.log(LogCategory.SYSTEM, "midiOutOpen -> MMSYSERR_BADDEVICEID (no MIDI synthesizer)");
        return MMSYSERR_BADDEVICEID;
    };
    exports["midiOutGetID"] = () => MMSYSERR_INVALHANDLE;
    for (const name of ["midiOutClose", "midiOutReset", "midiOutShortMsg", "midiOutLongMsg",
                        "midiOutPrepareHeader", "midiOutUnprepareHeader", "midiOutGetVolume",
                        "midiOutSetVolume", "midiOutMessage", "midiConnect", "midiDisconnect"]) {
        exports[name] = () => MMSYSERR_INVALHANDLE;
    }
    // The stream API is the same output device by another name.
    exports["midiStreamOpen"] = (ctx, mem, args) => {
        const phms = args[0] >>> 0;
        if (phms && phms + 4 <= mem.length) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(phms, 0, true);
        }
        return MMSYSERR_BADDEVICEID;
    };
    for (const name of ["midiStreamClose", "midiStreamOut", "midiStreamPause",
                        "midiStreamPosition", "midiStreamProperty", "midiStreamRestart",
                        "midiStreamStop"]) {
        exports[name] = () => MMSYSERR_INVALHANDLE;
    }

    // ==================== Mixer Functions ====================

    // No mixer topology is implemented — no destination lines, no source lines, no
    // controls. Reporting one device and then answering mixerGetLineInfo with
    // MMSYSERR_NOERROR left the caller's MIXERLINE untouched: it read its own stack as
    // dwLineID and dwComponentType and went on to ask for that line's controls.
    // "No mixer driver" is a state Windows itself has, and one an app can act on.
    exports["mixerGetNumDevs"] = () => 0;
    exports["mixerGetDevCapsA"] = () => MMSYSERR_BADDEVICEID;
    exports["mixerOpen"] = (ctx, mem, args) => {
        const phmx = args[0] >>> 0;
        if (phmx && phmx + 4 <= mem.length) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(phmx, 0, true);
        }
        return MMSYSERR_BADDEVICEID;
    };
    exports["mixerGetID"] = () => MMSYSERR_INVALHANDLE;
    for (const name of ["mixerClose", "mixerGetLineInfoA", "mixerGetLineControlsA",
                        "mixerGetControlDetailsA", "mixerSetControlDetails"]) {
        exports[name] = () => MMSYSERR_INVALHANDLE;
    }

    // ==================== Auxiliary Audio Functions ====================

    exports["auxGetNumDevs"] = () => {
        Logger.verbose(LogCategory.SYSTEM, "auxGetNumDevs");
        return 1; // Report one emulated aux device
    };

    exports["auxGetDevCapsA"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pac = args[1] >>> 0;
        const cbac = args[2] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetDevCapsA: deviceId=${uDeviceID}, caps=0x${pac.toString(16)}, cb=${cbac}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pac || cbac < 48 || pac + 48 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        writeAuxCaps(mem, pac, false);
        return MMSYSERR_NOERROR;
    };

    exports["auxGetDevCapsW"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pac = args[1] >>> 0;
        const cbac = args[2] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetDevCapsW: deviceId=${uDeviceID}, caps=0x${pac.toString(16)}, cb=${cbac}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pac || cbac < 80 || pac + 80 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        writeAuxCaps(mem, pac, true);
        return MMSYSERR_NOERROR;
    };

    exports["auxGetVolume"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pdwVolume = args[1] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetVolume: deviceId=${uDeviceID}, out=0x${pdwVolume.toString(16)}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pdwVolume || pdwVolume + 4 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(pdwVolume, auxVolume >>> 0, true);
        return MMSYSERR_NOERROR;
    };

    exports["auxSetVolume"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const dwVolume = args[1] >>> 0;
        Logger.verbose(
            LogCategory.SYSTEM,
            `auxSetVolume: deviceId=${uDeviceID}, volume=0x${dwVolume.toString(16)}`
        );
        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        auxVolume = dwVolume;
        // wTechnology is AUXCAPS_CDAUDIO: this line IS the drive's CD-audio output
        // level, so games that dim the music with the aux slider must be heard.
        const left = dwVolume & 0xFFFF;
        const right = (dwVolume >>> 16) & 0xFFFF;
        virtualCd().setVolume(Math.max(left, right) / 0xFFFF);
        return MMSYSERR_NOERROR;
    };
}
