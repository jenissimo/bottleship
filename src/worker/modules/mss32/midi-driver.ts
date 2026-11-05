import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext } from "./context";

const MDI_STRUCT_SIZE = 64;

export function createMidiDriverExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_install_MDI_driver_file@8 — install MIDI driver from file
    exports["_AIL_install_MDI_driver_file@8"] = (ctxThunk, mem, args) => {
        const namePtr = args[0];
        const outPtr = args[1];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_install_MDI_driver_file@8 name=0x${namePtr.toString(16)} outPtr=0x${outPtr.toString(16)}`);

        const handle = ctx.process.memory.alloc(MDI_STRUCT_SIZE);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < MDI_STRUCT_SIZE; i += 4) {
            view.setUint32(handle + i, 0, true);
        }
        view.setUint32(handle + 0x00, 0x4D444931, true); // 'MDI1' magic

        if (outPtr && MemoryGuard.isValidRange(mem, outPtr, 4)) {
            view.setUint32(outPtr, handle, true);
        }
        return handle;
    };

    // _AIL_open_XMIDI_driver@4 — open XMIDI driver for playback
    exports["_AIL_open_XMIDI_driver@4"] = (ctxThunk, mem, args) => {
        const mdi = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_XMIDI_driver@4 mdi=0x${mdi.toString(16)}`);
        ctx.midiDriverHandle = mdi;
        return 1;
    };

    // _AIL_close_XMIDI_driver@4
    exports["_AIL_close_XMIDI_driver@4"] = (ctxThunk, mem, args) => {
        const mdi = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_XMIDI_driver@4 mdi=0x${mdi.toString(16)}`);
        if (mdi === ctx.midiDriverHandle) ctx.midiDriverHandle = 0;
        return 0;
    };

    // _AIL_uninstall_MDI_driver@4
    exports["_AIL_uninstall_MDI_driver@4"] = (ctxThunk, mem, args) => {
        const mdi = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_uninstall_MDI_driver@4 mdi=0x${mdi.toString(16)}`);
        if (mdi === ctx.midiDriverHandle) ctx.midiDriverHandle = 0;
        if (mdi) ctx.process.memory.free(mdi);
        return 0;
    };

    // _AIL_MDI_driver_type@4 — return driver type (0 = unknown/none)
    exports["_AIL_MDI_driver_type@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_set_XMIDI_master_volume@8
    exports["_AIL_set_XMIDI_master_volume@8"] = (ctxThunk, mem, args) => {
        const mdi = args[0];
        const vol = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_XMIDI_master_volume@8 mdi=0x${mdi.toString(16)} vol=${vol}`);
        ctx.midiMasterVolume = vol & 0x7F;
        return 0;
    };

    // S32 AIL_midiOutOpen(HMDIDRIVER* drvr, LPHMIDIOUT* lphMidiOut, S32 deviceId): Miles'
    // MIDI driver sits on a winmm MIDI-out port and answers that open's MMRESULT. No
    // port exists (midiOutGetNumDevs is 0), so it fails the way midiOutOpen does and
    // hands back NULL handles rather than leaving the caller's slots uninitialized.
    exports["_AIL_midiOutOpen@12"] = (ctxThunk, mem, args) => {
        const MMSYSERR_BADDEVICEID = 2;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const out of [args[0] >>> 0, args[1] >>> 0]) {
            if (out && MemoryGuard.isValidRange(mem, out, 4)) view.setUint32(out, 0, true);
        }
        ctx.lastErrorStr = "No MIDI output device";
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_midiOutOpen@12 device=${args[2] | 0} -> MMSYSERR_BADDEVICEID (no MIDI output)`);
        return MMSYSERR_BADDEVICEID;
    };

    // void AIL_midiOutClose(HMDIDRIVER): no driver was ever opened.
    exports["_AIL_midiOutClose@4"] = () => 0;

    // _AIL_XMIDI_master_volume@4
    exports["_AIL_XMIDI_master_volume@4"] = (ctxThunk, mem, args) => {
        return ctx.midiMasterVolume;
    };

    return exports;
}
