import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Marshaler } from "../../core/memory/marshaler";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { isValidAddress } from "../../core/memory/address-guard";
import { MSSContext, SMP_PLAYING } from "./context";
import { ensureDriverHandle, startHeartbeat, stopHeartbeat, freeDriverResources, getBytesPerSecond, getPlaybackLengthBytes } from "./helpers";
import { updateEmulatorState, stopRingBuffer } from "./playback-engine";
import { processPendingTimerCallbacks, processPendingEOSCallbacks, processPendingStreamCallbacks } from "./callbacks";
import { pumpVfsStreams, serveIncrementalStreams } from "./stream-engine";
import { ensureListener3D } from "./spatial";

/** Fake 3D provider handle — games null-check but never dereference internals */
const FAKE_3D_PROVIDER_HANDLE = 0xDEAD3D01;
/** 3D voices we advertise. Miles' own software providers report 32; engines size their
 *  voice pools from this and treat a small number as "provider not worth keeping". */
const MAX_3D_SAMPLES = 32;

export function createCoreExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_MSS_version@8 - Returns MSS32 version string
    exports["_AIL_MSS_version@8"] = (ctxThunk, mem, args) => {
        const strPtr = args[0];
        const len = args[1];
        const version = "8.0b";
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_MSS_version@8 called, returning version "${version}"`);

        if (strPtr && len > 0 && strPtr + len <= mem.length) {
            const versionBytes = new TextEncoder().encode(version);
            const copyLen = Math.min(versionBytes.length, len - 1);
            for (let i = 0; i < copyLen; i++) {
                mem[strPtr + i] = versionBytes[i];
            }
            mem[strPtr + copyLen] = 0;
        }

        return { value: 0, stackCleanup: 8 };
    };

    // _AIL_startup@0
    exports["_AIL_startup@0"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, 'MSS32: _AIL_startup@0 called');
        ctx.initialized = true;
        ctx.startupTime = performance.now();
        startHeartbeat(ctx);
        return 1;
    };

    // _AIL_shutdown@0
    exports["_AIL_shutdown@0"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, 'MSS32: _AIL_shutdown@0 called');
        stopHeartbeat(ctx);
        freeDriverResources(ctx);
        ctx.initialized = false;
        for (const sample of ctx.samples.values()) {
            if (sample.isPlaying) {
                if (!stopRingBuffer(sample.id)) {
                    self.postMessage({ type: "audio_stop", payload: { id: sample.id } });
                }
            }
        }
        ctx.samples.clear();
        ctx.samplesById.clear();
        ctx.waveOuts.clear();
        for (const provider of ctx.ribProviders.keys()) {
            ctx.process.memory.free(provider);
        }
        ctx.ribProviders.clear();
        return 0;
    };

    const quickStartup: ThunkImplementation = (ctxThunk, mem, args) => {
        const useDigital = (args[0] ?? 0) !== 0;
        const useMidi = (args[1] ?? 0) !== 0;
        const outputRate = args[2] >>> 0;
        const outputBits = args[3] >>> 0;
        const outputChannels = args[4] >>> 0;

        ctx.initialized = true;
        ctx.startupTime = performance.now();
        ctx.lastErrorStr = "";
        if (outputRate >= 8000 && outputRate <= 192000) {
            ctx.driverOutputRate = outputRate;
        }
        if (useDigital) {
            ensureDriverHandle(ctx, mem);
        }
        if (useMidi && !ctx.midiDriverHandle) {
            ctx.midiDriverHandle = 1;
        }

        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: AIL_quick_startup digital=${useDigital ? 1 : 0} midi=${useMidi ? 1 : 0} ` +
            `rate=${outputRate} bits=${outputBits} channels=${outputChannels} -> 1`
        );
        return 1;
    };

    exports["_AIL_quick_startup@20"] = quickStartup;
    exports["AIL_quick_startup"] = quickStartup;

    const quickShutdown: ThunkImplementation = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, "MSS32: AIL_quick_shutdown called");
        return exports["_AIL_shutdown@0"](ctxThunk, mem, args);
    };

    exports["_AIL_quick_shutdown@0"] = quickShutdown;
    exports["AIL_quick_shutdown"] = quickShutdown;

    // _AIL_set_preference@8
    // Real MSS32 returns the OLD value. We return 0 for safety — if we returned a
    // non-zero old value that differs from the new value, some games interpret this
    // as a signal to reinit audio. The actual Re-Volt reinit crash during level
    // transitions was caused by _AIL_enumerate_3D_providers returning 0 providers
    // (game stored NULL provider name → strncpy(buf, NULL, 128) → #PF), not by
    // this return value.
    exports["_AIL_set_preference@8"] = (ctxThunk, mem, args) => {
        const idx = args[0] >>> 0;
        const val = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_preference@8 called: number=${idx}, value=${val}`);
        if (idx < ctx.preferences.length) {
            ctx.preferences[idx] = val;
        }
        return 0;
    };

    // _AIL_get_preference@4
    exports["_AIL_get_preference@4"] = (ctxThunk, mem, args) => {
        const idx = args[0] >>> 0;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_get_preference@4 called: number=${idx}`);
        return (idx < ctx.preferences.length) ? ctx.preferences[idx] : 0;
    };

    // _AIL_serve@0
    exports["_AIL_serve@0"] = (ctxThunk, mem, args) => {
        ctx.insideAilServe = true;
        ctx.serveDepth++;
        try {
            pumpVfsStreams(ctx);
            updateEmulatorState(ctx);

            const timerInvoked = processPendingTimerCallbacks(ctx);
            const eosInvoked = processPendingEOSCallbacks(ctx);
            const streamInvoked = processPendingStreamCallbacks(ctx);

            if (timerInvoked || eosInvoked || streamInvoked) {
                Logger.verbose(LogCategory.SYSTEM, `MSS32: Suspending _AIL_serve for callback (invoked: timer=${timerInvoked}, eos=${eosInvoked}, stream=${streamInvoked})`);
                return { value: 0, suspendedForCallback: true, stackCleanup: 0 };
            }

            // Servicing a stream means running the app's own file callbacks, which is
            // guest code: this is the point at which real Miles tops its buffers up.
            const served = serveIncrementalStreams(ctx, ctxThunk, 0, "mss32:AIL_serve");
            if (served) return served;
        } finally {
            ctx.serveDepth--;
            ctx.insideAilServe = false;
        }
        return 0;
    };

    // _AIL_delay@4
    exports["_AIL_delay@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_last_error@0
    exports["_AIL_last_error@0"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, 'MSS32: _AIL_last_error@0 called');
        if (!ctx.lastErrorPtr) {
            ctx.lastErrorPtr = ctx.process.memory.alloc(256);
            const defaultError = "No error\0";
            for (let i = 0; i < defaultError.length; i++) {
                mem[ctx.lastErrorPtr + i] = defaultError.charCodeAt(i);
            }
        }
        return ctx.lastErrorPtr;
    };

    // _AIL_set_error@4
    exports["_AIL_set_error@4"] = (ctxThunk, mem, args) => {
        const errorPtr = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_error@4 called: errorPtr=0x${errorPtr.toString(16)}`);
        if (errorPtr) {
            ctx.lastErrorStr = Marshaler.readString(mem, errorPtr);
            Logger.warn(LogCategory.SYSTEM, `MSS32: Error set: "${ctx.lastErrorStr}"`);
        }
        return 0;
    };

    // _AIL_ms_count@0
    exports["_AIL_ms_count@0"] = (ctxThunk, mem, args) => {
        const ms = Math.floor(performance.now() - ctx.startupTime);
        return ms >>> 0;
    };

    // _AIL_us_count@0
    exports["_AIL_us_count@0"] = (ctxThunk, mem, args) => {
        const us = Math.floor((performance.now() - ctx.startupTime) * 1000);
        return us >>> 0;
    };

    // _AIL_HWND@0
    exports["_AIL_HWND@0"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, 'MSS32: _AIL_HWND@0 called');
        return 0;
    };

    // _AIL_enumerate_3D_providers@12
    // Signature: S32 AIL_enumerate_3D_providers(HPROENUM* next, HPROVIDER* dest, char** name)
    // Returns 1 if provider found, 0 if no more.
    // Must return at least one provider with a valid name string.
    // Re-Volt stores provider names during first boot and reuses them during level
    // transition reinit. With 0 providers, the stored name is NULL → strncpy(buf, NULL, 128)
    // → #PF crash at EIP=0x4a9ff6 during reinit.
    exports["_AIL_enumerate_3D_providers@12"] = (ctxThunk, mem, args) => {
        const nextPtr = args[0];  // HPROENUM* (in/out enumeration state)
        const destPtr = args[1];  // HPROVIDER* (out: provider handle)
        const namePtr = args[2];  // char** (out: pointer to name string)

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read enumeration state — 0 = first call
        let enumState = 0;
        if (nextPtr && MemoryGuard.isValidRange(mem, nextPtr, 4)) {
            enumState = view.getUint32(nextPtr, true);
        }

        if (enumState === 0) {
            // First call: return one fake provider
            if (!ctx.provider3DNamePtr) {
                const name = "Miles Fast 2D Positional Audio";
                ctx.provider3DNamePtr = ctx.process.memory.alloc(name.length + 1);
                for (let i = 0; i < name.length; i++) {
                    mem[ctx.provider3DNamePtr + i] = name.charCodeAt(i);
                }
                mem[ctx.provider3DNamePtr + name.length] = 0;
            }

            if (destPtr && MemoryGuard.isValidRange(mem, destPtr, 4)) {
                view.setUint32(destPtr, FAKE_3D_PROVIDER_HANDLE, true);
            }
            if (namePtr && MemoryGuard.isValidRange(mem, namePtr, 4)) {
                view.setUint32(namePtr, ctx.provider3DNamePtr, true);
            }
            if (nextPtr && MemoryGuard.isValidRange(mem, nextPtr, 4)) {
                view.setUint32(nextPtr, 1, true);
            }

            Logger.log(LogCategory.SYSTEM,
                `MSS32: _AIL_enumerate_3D_providers@12 → 1 (fake provider "${("Miles Fast 2D Positional Audio")}" at 0x${ctx.provider3DNamePtr.toString(16)})`);
            return 1;
        }

        // Subsequent calls: no more providers
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_enumerate_3D_providers@12 enumState=${enumState} → 0 (done)`);
        return 0;
    };

    // _AIL_enumerate_filters@12
    // S32 AIL_enumerate_filters(HPROENUM *next, HPROVIDER *dest, C8 **name)
    // We ship no DSP filter providers, so enumeration is empty. Returning 0 is what ends
    // the caller's loop; a non-zero "success" that leaves *name untouched sends it into
    // strlen(NULL) (Gothic's zMusic filter scan, zSound_MSS.cpp).
    exports["_AIL_enumerate_filters@12"] = (ctxThunk, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const ptr of [args[1], args[2]]) {
            if (ptr && MemoryGuard.isValidRange(mem, ptr, 4)) view.setUint32(ptr, 0, true);
        }
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_enumerate_filters@12 -> 0 (no filter providers)`);
        return 0;
    };

    // HPROVIDER AIL_open_filter(...) — nothing to open once enumeration is empty.
    exports["_AIL_open_filter@8"] = () => 0;
    exports["_AIL_set_filter_sample_preference@12"] = () => 0;
    exports["_AIL_set_sample_processor@12"] = () => 0;

    // void AIL_sample_ms_position(HSAMPLE, S32 *total_ms, S32 *current_ms)
    // Both are OUT parameters the caller reads unconditionally. Real mss32 divides the
    // sample's data length and its current byte offset by the sample's bytes-per-second —
    // i.e. this is the millisecond view of AIL_sample_position, and answering a constant 0
    // tells a game that every sound is zero-length and never advances.
    exports["_AIL_sample_ms_position@12"] = (ctxThunk, mem, args) => {
        const sample = ctx.samples.get(args[0]);
        const bytesPerSec = sample ? getBytesPerSecond(sample) : 0;
        const totalMs = sample && bytesPerSec > 0
            ? Math.round(getPlaybackLengthBytes(sample) * 1000 / bytesPerSec) : 0;
        const currentMs = sample && bytesPerSec > 0
            ? Math.round(Math.max(0, sample.position) * 1000 / bytesPerSec) : 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (args[1] && MemoryGuard.isValidRange(mem, args[1], 4)) view.setUint32(args[1], totalMs >>> 0, true);
        if (args[2] && MemoryGuard.isValidRange(mem, args[2], 4)) view.setUint32(args[2], currentMs >>> 0, true);
        return 0;
    };

    // S32 AIL_digital_CPU_percent(HDIGDRIVER) — a mixer we do not run costs nothing.
    exports["_AIL_digital_CPU_percent@4"] = () => 0;

    exports["_AIL_set_sample_loop_block@12"] = () => 0;
    exports["_AIL_set_3D_sample_loop_block@12"] = () => 0;
    exports["_AIL_set_3D_sample_obstruction@8"] = () => 0;
    exports["_AIL_set_3D_sample_occlusion@8"] = () => 0;
    exports["_AIL_set_3D_sample_preference@12"] = () => 0;
    exports["_AIL_3D_sample_cone@16"] = (ctxThunk, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const ptr of [args[1], args[2], args[3]]) {
            if (ptr && MemoryGuard.isValidRange(mem, ptr, 4)) view.setUint32(ptr, 0, true);
        }
        return 0;
    };

    // _AIL_set_redist_directory@4
    //
    // Declared void in MSS, so EAX is whatever the shipped DLL's last operation left — for a
    // function whose whole body copies the path into its redist buffer, a non-NULL pointer.
    // Callers do read it: Blade of Darkness treats a zero here as "MSS failed", skips 3D
    // provider enumeration entirely, and then indexes its (never allocated) provider table.
    // Synthesising 0 for a void API is our invention, and it is the one value that breaks them.
    exports["_AIL_set_redist_directory@4"] = (ctxThunk, mem, args) => {
        const dirPtr = args[0];
        const dir = dirPtr ? Marshaler.readString(mem, dirPtr) : "(null)";
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_redist_directory@4 called: dir="${dir}"`);
        return dirPtr || 1;
    };

    // _AIL_MMX_available@0
    exports["_AIL_MMX_available@0"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_MMX_available@0 called`);
        return 1;
    };

    // ==================== 3D Audio Provider ====================
    // The fake provider opens successfully (M3D_NOERR). 3D sample handles are real
    // and route through the audio worklet's 3D mixer (see mss32/sample.ts 3D block +
    // mss32/spatial.ts listener SAB). Per-sample 3D ops (allocate/start/position/...)
    // are defined in sample.ts and override the older stubs left below.
    //
    // M3DRESULT: 0=M3D_NOERR (success), 1=M3D_NOT_ENABLED, 8=M3D_NOT_INIT.
    // Returning 0 is REQUIRED by titles with no 2D fallback (Blade of Darkness treats
    // a non-zero open as a fatal "Sound System Init Error" and quits).
    exports["_AIL_open_3D_provider@4"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_3D_provider@4 prov=0x${args[0].toString(16)} → 0 (M3D_NOERR)`);
        return 0; // M3D_NOERR — provider opened; 3D samples play via the worklet 3D mixer
    };

    exports["_AIL_close_3D_provider@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_allocate_3D_sample_handle@4"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_allocate_3D_sample_handle@4 prov=0x${args[0].toString(16)} -> 0 (NULL)`);
        return 0;
    };

    exports["_AIL_release_3D_sample_handle@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_sample_file@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_start_3D_sample@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_stop_3D_sample@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_position@16"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_velocity@20"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_velocity_vector@16"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_end_3D_sample@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_sample_volume@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_set_3D_sample_distances@12"] = (ctxThunk, mem, args) => {
        return 0;
    };

    exports["_AIL_3D_sample_volume@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // M3DRESULT AIL_3D_provider_attribute(HPROVIDER lib, C8 *name, void *val)
    // `val` is an OUT parameter. Answering M3D_NOERR without writing it is how a caller
    // reads "0 supported samples" and discards a provider it just opened: ZenGin's
    // zCSndSys_MSS does exactly that, then AIL_waveOutClose + AIL_shutdown, leaving its
    // global sound system NULL — and the crash lands much later, in the Bink intro.
    // Unknown attributes must FAIL so the caller keeps its own default.
    exports["_AIL_3D_provider_attribute@12"] = (ctxThunk, mem, args) => {
        const name = args[1] ? Marshaler.readString(mem, args[1]) : "";
        const out = args[2] >>> 0;
        const write = (v: number): number => {
            if (out && MemoryGuard.isValidRange(mem, out, 4)) {
                new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(out, v >>> 0, true);
            }
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_3D_provider_attribute@12("${name}") -> ${v}`);
            return 0; // M3D_NOERR
        };
        // Voice budget: the worklet mixer has no fixed ceiling, so report the count Miles'
        // software providers advertise rather than a number that reads as "unusable".
        if (/max.*sample/i.test(name)) return write(MAX_3D_SAMPLES);
        if (/max.*(room|environment)/i.test(name)) return write(0);
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_3D_provider_attribute@12("${name}") -> M3D_NOT_FOUND`);
        return 2; // M3D_NOT_FOUND — leave the caller's default in place
    };

    // M3DRESULT AIL_3D_sample_attribute(H3DSAMPLE S, C8 *name, S32 *val)
    // The per-voice twin of AIL_3D_provider_attribute. Real mss32 stamps *val = -1 up front
    // and only overwrites it when the provider that owns the voice publishes that named
    // attribute; ours publishes none, so -1 plus a failure code is the honest pair — a
    // success code over an untouched-looking -1 would read as a real attribute value.
    exports["_AIL_3D_sample_attribute@12"] = (ctxThunk, mem, args) => {
        const name = args[1] ? Marshaler.readString(mem, args[1]) : "";
        const out = args[2] >>> 0;
        if (out && MemoryGuard.isValidRange(mem, out, 4)) {
            new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setInt32(out, -1, true);
        }
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_3D_sample_attribute@12(0x${args[0].toString(16)}, "${name}") -> M3D_NOT_FOUND (*val=-1)`);
        return 2; // M3D_NOT_FOUND
    };

    // _AIL_open_3D_listener@4(prov) → listener handle (creates the global listener SAB)
    exports["_AIL_open_3D_listener@4"] = (ctxThunk, mem, args) => {
        const handle = ensureListener3D(ctx);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_3D_listener@4 prov=0x${args[0].toString(16)} → 0x${handle.toString(16)}`);
        return handle;
    };

    // _AIL_close_3D_listener@4(listener)
    exports["_AIL_close_3D_listener@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_3D_room_type@4(prov) → current environment reverb preset.
    // Blade reads this and treats != -1 as "EAX available".
    exports["_AIL_3D_room_type@4"] = (ctxThunk, mem, args) => ctx.roomType3D ?? 0;

    // _AIL_set_3D_room_type@8(prov, room_type) — store; no reverb DSP yet.
    exports["_AIL_set_3D_room_type@8"] = (ctxThunk, mem, args) => {
        ctx.roomType3D = args[1] | 0;
        return 0;
    };

    // _AIL_3D_speaker_type@4(prov) → current speaker configuration.
    exports["_AIL_3D_speaker_type@4"] = (ctxThunk, mem, args) => ctx.speakerType3D;

    // _AIL_set_3D_speaker_type@8(prov, speaker_type) — store (AIL_3D_2_SPEAKER etc.).
    exports["_AIL_set_3D_speaker_type@8"] = (ctxThunk, mem, args) => {
        ctx.speakerType3D = args[1] | 0;
        return 0;
    };

    // _AIL_quick_handles@12(HDIGDRIVER* dig, HMDIDRIVER* mdi, HDLSDEVICE* dls)
    // Output the driver handles created by AIL_quick_startup.
    exports["_AIL_quick_handles@12"] = (ctxThunk, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (args[0] && MemoryGuard.isValidRange(mem, args[0], 4)) view.setUint32(args[0], ctx.digitalDriverHandle >>> 0, true);
        if (args[1] && MemoryGuard.isValidRange(mem, args[1], 4)) view.setUint32(args[1], ctx.midiDriverHandle >>> 0, true);
        if (args[2] && MemoryGuard.isValidRange(mem, args[2], 4)) view.setUint32(args[2], 0, true);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_quick_handles@12 → dig=0x${ctx.digitalDriverHandle.toString(16)} mdi=0x${ctx.midiDriverHandle.toString(16)}`);
        return 0;
    };

    // _AIL_set_3D_distance_factor@8(provider, factor) — metres per world unit.
    // The float rides the stack as raw bits; reinterpret rather than truncate, or a
    // factor of 1.0 reads as 1065353216.
    exports["_AIL_set_3D_distance_factor@8"] = (ctxThunk, mem, args) => {
        const bits = new Uint32Array(1);
        bits[0] = args[1] >>> 0;
        const factor = new Float32Array(bits.buffer)[0];
        if (Number.isFinite(factor) && factor > 0) ctx.distanceFactor3D = factor;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_3D_distance_factor@8 factor=${ctx.distanceFactor3D}`);
        return 0;
    };

    // _AIL_DLS_open@28(mdi, dig, filename, flags, rate, bits, channels) -> HDLSDEVICE
    // We have no DLS/wavetable synth. NULL is the documented failure and the honest
    // answer: a handle we cannot service would have the app load an instrument set
    // into it and then wonder why every note is silent.
    exports["_AIL_DLS_open@28"] = (ctxThunk, mem, args) => {
        Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_DLS_open@28 — no DLS synth, returning NULL");
        return 0;
    };

    // _AIL_set_3D_provider_preference@12(prov, name, value)
    exports["_AIL_set_3D_provider_preference@12"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_set_3D_orientation@28(obj, X_face, Y_face, Z_face, X_up, Y_up, Z_up)
    exports["_AIL_set_3D_orientation@28"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_set_3D_sample_playback_rate@8(sample, rate)
    exports["_AIL_set_3D_sample_playback_rate@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_set_3D_sample_effects_level@8(sample, level)
    exports["_AIL_set_3D_sample_effects_level@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_resume_3D_sample@4(sample)
    exports["_AIL_resume_3D_sample@4"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_set_3D_sample_loop_count@8(sample, count)
    exports["_AIL_set_3D_sample_loop_count@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _AIL_3D_sample_status@4(sample) → 2 (SMP_DONE)
    exports["_AIL_3D_sample_status@4"] = (ctxThunk, mem, args) => {
        return 2;
    };

    // ==================== RIB / Processor Chain Stubs ====================
    // Real MSS32 uses RIB (Resource Interface Broker) to enumerate and bind
    // mixer providers.  External .m3d/.flt/.asi modules call these while their
    // RIB_Main registers its callable interface, so retain that state instead of
    // pretending registration succeeded and then losing the provider.

    const RIB_NOERR = 0;
    const RIB_NOT_FOUND = 2;
    const RIB_INTERFACE_ENTRY_SIZE = 16;

    const readRibEntries = (mem: Uint8Array, listPtr: number, entryCount: number): number[] | null => {
        if (entryCount < 0 || entryCount > 4096 || !listPtr ||
            !isValidAddress(mem, listPtr, entryCount * RIB_INTERFACE_ENTRY_SIZE, "r")) {
            return null;
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const entries: number[] = [];
        for (let i = 0; i < entryCount; i++) {
            // RIB_INTERFACE_ENTRY = type, entry_name, token, subtype.  Token is
            // retained because it is the provider's function/attribute identity.
            entries.push(view.getUint32(listPtr + i * RIB_INTERFACE_ENTRY_SIZE + 8, true));
        }
        return entries;
    };

    const allocProviderHandle: ThunkImplementation = (ctxThunk, mem, args) => {
        const module = args[0] >>> 0;
        try {
            // HPROVIDER is opaque in the SDK.  Back it with a guest allocation so
            // a provider can safely retain/pass it, and preserve its HMODULE for
            // its eventual RIB interface registrations.
            const handle = ctx.process.memory.alloc(4) >>> 0;
            if (!handle) return 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            MemoryGuard.writeUint32(mem, view, handle, module, "MSS32:RIB_alloc_provider_handle:module");
            ctx.ribProviders.set(handle, { module, interfaces: new Map() });
            Logger.verbose(LogCategory.SYSTEM, `MSS32: RIB_alloc_provider_handle(module=0x${module.toString(16)}) -> 0x${handle.toString(16)}`);
            return handle;
        } catch (error) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: RIB_alloc_provider_handle failed: ${error}`);
            return 0;
        }
    };

    const freeProviderHandle: ThunkImplementation = (ctxThunk, mem, args) => {
        const handle = args[0] >>> 0;
        if (!ctx.ribProviders.delete(handle)) return 0;
        ctx.process.memory.free(handle);
        return 0;
    };

    const registerInterface: ThunkImplementation = (ctxThunk, mem, args) => {
        const provider = ctx.ribProviders.get(args[0] >>> 0);
        const interfaceNamePtr = args[1] >>> 0;
        const entryCount = args[2] | 0;
        const entries = readRibEntries(mem, args[3] >>> 0, entryCount);
        if (!provider || !interfaceNamePtr || !entries) return RIB_NOT_FOUND;

        const interfaceName = Marshaler.readString(mem, interfaceNamePtr);
        if (!interfaceName) return RIB_NOT_FOUND;
        provider.interfaces.set(interfaceName, { entryCount, entries });
        Logger.verbose(LogCategory.SYSTEM, `MSS32: RIB_register_interface provider=0x${(args[0] >>> 0).toString(16)} interface=${interfaceName} entries=${entryCount}`);
        return RIB_NOERR;
    };

    const unregisterInterface: ThunkImplementation = (ctxThunk, mem, args) => {
        const provider = ctx.ribProviders.get(args[0] >>> 0);
        if (!provider) return RIB_NOT_FOUND;
        const interfaceNamePtr = args[1] >>> 0;
        const entryCount = args[2] | 0;
        if (!interfaceNamePtr && entryCount === 0 && (args[3] >>> 0) === 0) {
            provider.interfaces.clear();
            return RIB_NOERR;
        }
        const entries = readRibEntries(mem, args[3] >>> 0, entryCount);
        if (!interfaceNamePtr || !entries) return RIB_NOT_FOUND;
        const interfaceName = Marshaler.readString(mem, interfaceNamePtr);
        const registered = provider.interfaces.get(interfaceName);
        if (!registered || registered.entryCount !== entryCount ||
            registered.entries.some((token, i) => token !== entries[i])) return RIB_NOT_FOUND;
        provider.interfaces.delete(interfaceName);
        return RIB_NOERR;
    };

    exports["RIB_alloc_provider_handle"] = allocProviderHandle;
    exports["_RIB_alloc_provider_handle@4"] = allocProviderHandle;
    exports["RIB_free_provider_handle"] = freeProviderHandle;
    exports["_RIB_free_provider_handle@4"] = freeProviderHandle;
    exports["RIB_register_interface"] = registerInterface;
    exports["_RIB_register_interface@16"] = registerInterface;
    exports["RIB_unregister_interface"] = unregisterInterface;
    exports["_RIB_unregister_interface@16"] = unregisterInterface;

    // _RIB_enumerate_providers@12(type, outPROV, outNAME) → 0 = no more providers
    exports["_RIB_enumerate_providers@12"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _RIB_enumerate_providers@12 type=${args[0]} → 0 (no providers)`);
        return 0;
    };

    // _AIL_set_digital_driver_processor@12(dig, chainIndex, provider) → 0
    exports["_AIL_set_digital_driver_processor@12"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: _AIL_set_digital_driver_processor@12 dig=0x${args[0].toString(16)} chain=${args[1]} prov=0x${args[2].toString(16)} → 0`);
        return 0;
    };

    // _AIL_digital_driver_processor@8(dig, chainIndex) → 0 (no provider set)
    exports["_AIL_digital_driver_processor@8"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: _AIL_digital_driver_processor@8 dig=0x${args[0].toString(16)} chain=${args[1]} → 0`);
        return 0;
    };

    // _RIB_provider_system_data@8(prov, index) → 0
    exports["_RIB_provider_system_data@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _RIB_provider_user_data@8(prov, index) → 0
    exports["_RIB_provider_user_data@8"] = (ctxThunk, mem, args) => {
        return 0;
    };

    // _RIB_load_application_providers@4(appName) → 0
    exports["_RIB_load_application_providers@4"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _RIB_load_application_providers@4 → 0`);
        return 0;
    };

    // ==================== Digital Master Volume ====================

    exports["_AIL_set_digital_master_volume@8"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_digital_master_volume@8 dig=0x${args[0].toString(16)} vol=${args[1]}`);
        return 0;
    };

    exports["_AIL_digital_master_volume@4"] = (ctxThunk, mem, args) => {
        return 127;
    };

    return exports;
}
