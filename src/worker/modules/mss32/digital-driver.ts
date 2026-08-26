import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext } from "./context";
import { ensureDriverHandle, stopHeartbeat, freeDriverResources, readFilenameArg } from "./helpers";
import { stopRingBuffer } from "./playback-engine";

export function createDigitalDriverExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_open_digital_driver@4
    exports["_AIL_open_digital_driver@4"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_digital_driver@4 called: args[0]=0x${(args[0] >>> 0).toString(16)}, args[1]=0x${(args[1] >>> 0).toString(16)}, args[2]=0x${(args[2] >>> 0).toString(16)}, args[3]=0x${(args[3] >>> 0).toString(16)}`);

        // Use ensureDriverHandle which calls reinitDriverFields with the correct
        // real MSS32 driver struct layout.
        const driverHandle = ensureDriverHandle(ctx, mem);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const driverOutPtr = args[0];
        if (driverOutPtr && MemoryGuard.isValidRange(mem, driverOutPtr, 4)) {
            view.setUint32(driverOutPtr, driverHandle, true);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_digital_driver@4 -> wrote 0x${driverHandle.toString(16)} to 0x${driverOutPtr.toString(16)}`);
            return driverHandle;
        }

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_digital_driver@4 -> 0x${driverHandle.toString(16)} (no out ptr)`);
        return driverHandle;
    };

    /**
     * _AIL_open_digital_driver@16 — MSS 6.x: (frequency, bits, channels, flags) -> HDIGDRIVER.
     *
     * A separate export, not a spelling of the @4 one: that variant takes a single
     * HDIGDRIVER* out-parameter, so serving a @16 call with it reads the sample RATE as a
     * pointer and writes the handle into low guest memory. The rate the app asks for is
     * also the rate its samples are mixed against, so it is recorded here rather than
     * discarded.
     */
    exports["_AIL_open_digital_driver@16"] = (ctxThunk, mem, args) => {
        const frequency = args[0] >>> 0;
        const bits = args[1] | 0;
        const channels = args[2] | 0;
        const flags = args[3] >>> 0;
        if (frequency >= 8000 && frequency <= 192000) {
            ctx.driverOutputRate = frequency;
        }
        const driverHandle = ensureDriverHandle(ctx, mem);
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_open_digital_driver@16(${frequency}Hz, ${bits}-bit, ${channels}ch, flags=0x${flags.toString(16)})`
            + ` -> 0x${driverHandle.toString(16)}`);
        return driverHandle;
    };

    // _AIL_close_digital_driver@4
    exports["_AIL_close_digital_driver@4"] = (ctxThunk, mem, args) => {
        const dig = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_digital_driver@4 called: dig=0x${dig.toString(16)}`);
        stopHeartbeat(ctx);
        for (const sample of ctx.samples.values()) {
            if (sample.isPlaying) {
                if (!stopRingBuffer(sample.id)) {
                    self.postMessage({ type: "audio_stop", payload: { id: sample.id } });
                }
            }
        }
        ctx.samples.clear();
        ctx.samplesById.clear();
        if (dig === ctx.digitalDriverHandle) {
            freeDriverResources(ctx);
            ctx.digitalDriverHandle = 0;
        }
        return 0;
    };

    // _AIL_digital_configuration@16
    // Real MSS32: reads driver+0x14 (nSamplesPerSec) and driver+0x18 (format type)
    // and copies the DirectSound device name string to param_4.
    exports["_AIL_digital_configuration@16"] = (ctxThunk, mem, args) => {
        const dig = args[0];
        const outRate = args[1];
        const outFormat = args[2];
        const outString = args[3];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_digital_configuration@16 called: dig=0x${dig.toString(16)}`);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        // Read from the driver struct itself (like the real MSS32 does) so values
        // stay consistent with whatever reinitDriverFields wrote.
        if (dig && outRate && outRate + 4 <= mem.length) {
            const rate = view.getUint32(dig + 0x14, true) || ctx.driverOutputRate;
            view.setUint32(outRate, rate, true);
        }
        if (dig && outFormat && outFormat + 4 <= mem.length) {
            // Format type: 0=mono8, 1=mono16, 2=stereo8, 3=stereo16
            const fmt = view.getUint32(dig + 0x18, true);
            view.setUint32(outFormat, fmt, true);
        }
        if (outString && outString + 1 <= mem.length) {
            // Write "DirectSound" as device name (real MSS32 calls DirectSoundEnumerateA)
            const name = "DirectSound\0";
            for (let i = 0; i < name.length; i++) {
                mem[outString + i] = name.charCodeAt(i);
            }
        }
        return 1;
    };

    // _AIL_digital_handle_release@4
    exports["_AIL_digital_handle_release@4"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_digital_handle_release@4 called: drvr=0x${args[0].toString(16)}`);
        return 1;
    };

    // _AIL_digital_handle_reacquire@4
    exports["_AIL_digital_handle_reacquire@4"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_digital_handle_reacquire@4 called: drvr=0x${args[0].toString(16)}`);
        return 1;
    };

    // _AIL_install_DIG_driver_file@8
    exports["_AIL_install_DIG_driver_file@8"] = (ctxThunk, mem, args) => {
        const filenamePtr = args[0];
        const outDrvPtr = args[1];
        const filename = readFilenameArg(mem, filenamePtr) || "(memory)";
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_install_DIG_driver_file@8 called: "${filename}"`);
        const drv = ensureDriverHandle(ctx, mem);
        if (outDrvPtr && MemoryGuard.isValidRange(mem, outDrvPtr, 4)) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(outDrvPtr, drv, true);
        }
        return drv;
    };

    // _AIL_uninstall_driver@4
    exports["_AIL_uninstall_driver@4"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_uninstall_driver@4 called: drv=0x${args[0].toString(16)}`);
        return 0;
    };

    return exports;
}
