import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext, SMP_DONE } from "./context";
import { MSSSequence } from "./types";

const SMP_STOPPED = 1;
const SMP_PLAYING = 4;
const SEQ_STRUCT_SIZE = 128;

export function createSequenceExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    function getSeq(handle: number): MSSSequence | undefined {
        return ctx.sequences.get(handle);
    }

    // _AIL_allocate_sequence_handle@4 — allocate a sequence handle from a MIDI driver
    exports["_AIL_allocate_sequence_handle@4"] = (ctxThunk, mem, args) => {
        const mdi = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_allocate_sequence_handle@4 mdi=0x${mdi.toString(16)}`);

        const handle = ctx.process.memory.alloc(SEQ_STRUCT_SIZE);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < SEQ_STRUCT_SIZE; i += 4) {
            view.setUint32(handle + i, 0, true);
        }
        view.setUint32(handle + 0x00, SMP_DONE, true);

        const seq: MSSSequence = {
            handle,
            status: SMP_DONE,
            volume: 127,
            loopCount: 1,
            tempo: 500000, // 120 BPM default
        };
        ctx.sequences.set(handle, seq);
        return handle;
    };

    // _AIL_release_sequence_handle@4
    exports["_AIL_release_sequence_handle@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_release_sequence_handle@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            ctx.sequences.delete(handle);
            ctx.process.memory.free(handle);
        }
        return 0;
    };

    // _AIL_init_sequence@12 — load sequence data (XMIDI/MID)
    exports["_AIL_init_sequence@12"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const dataPtr = args[1];
        const flags = args[2];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_init_sequence@12 seq=0x${handle.toString(16)} data=0x${dataPtr.toString(16)} flags=${flags}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_DONE;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_DONE, true);
        }
        return 1;
    };

    // _AIL_start_sequence@4
    exports["_AIL_start_sequence@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_start_sequence@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_PLAYING;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_PLAYING, true);
        }
        return 0;
    };

    // _AIL_stop_sequence@4
    exports["_AIL_stop_sequence@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_stop_sequence@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_DONE;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_DONE, true);
        }
        return 0;
    };

    // _AIL_pause_sequence@4
    exports["_AIL_pause_sequence@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_pause_sequence@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_STOPPED;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_STOPPED, true);
        }
        return 0;
    };

    // _AIL_resume_sequence@4
    exports["_AIL_resume_sequence@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_resume_sequence@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_PLAYING;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_PLAYING, true);
        }
        return 0;
    };

    // _AIL_end_sequence@4
    exports["_AIL_end_sequence@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_end_sequence@4 seq=0x${handle.toString(16)}`);
        const seq = getSeq(handle);
        if (seq) {
            seq.status = SMP_DONE;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x00, SMP_DONE, true);
        }
        return 0;
    };

    // _AIL_sequence_status@4
    exports["_AIL_sequence_status@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const seq = getSeq(handle);
        return seq ? seq.status : SMP_DONE;
    };

    // _AIL_set_sequence_volume@12 — set volume with optional ms ramp time
    exports["_AIL_set_sequence_volume@12"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const vol = args[1];
        const ms = args[2];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_sequence_volume@12 seq=0x${handle.toString(16)} vol=${vol} ms=${ms}`);
        const seq = getSeq(handle);
        if (seq) seq.volume = vol & 0x7F;
        return 0;
    };

    // _AIL_sequence_volume@4
    exports["_AIL_sequence_volume@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const seq = getSeq(handle);
        return seq ? seq.volume : 0;
    };

    // _AIL_set_sequence_loop_count@8
    exports["_AIL_set_sequence_loop_count@8"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const count = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_sequence_loop_count@8 seq=0x${handle.toString(16)} count=${count}`);
        const seq = getSeq(handle);
        if (seq) seq.loopCount = count;
        return 0;
    };

    // _AIL_sequence_loop_count@4
    exports["_AIL_sequence_loop_count@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const seq = getSeq(handle);
        return seq ? seq.loopCount : 0;
    };

    // _AIL_set_sequence_tempo@12
    exports["_AIL_set_sequence_tempo@12"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const tempo = args[1];
        const ms = args[2];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_sequence_tempo@12 seq=0x${handle.toString(16)} tempo=${tempo} ms=${ms}`);
        const seq = getSeq(handle);
        if (seq) seq.tempo = tempo;
        return 0;
    };

    // _AIL_sequence_position@12 — write beat and measure to output pointers
    exports["_AIL_sequence_position@12"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const beatPtr = args[1];
        const measPtr = args[2];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (beatPtr && MemoryGuard.isValidRange(mem, beatPtr, 4)) {
            view.setUint32(beatPtr, 0, true);
        }
        if (measPtr && MemoryGuard.isValidRange(mem, measPtr, 4)) {
            view.setUint32(measPtr, 0, true);
        }
        return 0;
    };

    // _AIL_sequence_ms_position@12(seq, total_ms*, current_ms*) — the millisecond twin
    // of _AIL_sequence_position. We run no sequencer, so both are 0; writing them is
    // the contract, because the caller reads the out-params whatever we return.
    exports["_AIL_sequence_ms_position@12"] = (ctxThunk, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (const ptr of [args[1], args[2]]) {
            if (ptr && MemoryGuard.isValidRange(mem, ptr, 4)) view.setUint32(ptr, 0, true);
        }
        return 0;
    };

    // _AIL_set_sequence_user_data@12(seq, index, value) / getter — opaque slots Miles
    // hands back to the app's own callbacks; storing them IS the whole contract.
    exports["_AIL_set_sequence_user_data@12"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const index = args[1] | 0;
        if (!ctx.sequences.has(handle) || index < 0) return 0;
        let slots = ctx.sequenceUserData.get(handle);
        if (!slots) ctx.sequenceUserData.set(handle, (slots = []));
        slots[index] = args[2] >>> 0;
        return 0;
    };
    exports["_AIL_sequence_user_data@8"] = (ctxThunk, mem, args) => {
        return (ctx.sequenceUserData.get(args[0])?.[args[1] | 0] ?? 0) >>> 0;
    };

    // _AIL_register_sequence_callback@8(seq, callback) -> previous callback.
    exports["_AIL_register_sequence_callback@8"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const callback = args[1] >>> 0;
        if (!ctx.sequences.has(handle)) return 0;
        const previous = ctx.sequenceCallbacks.get(handle) ?? 0;
        if (callback) ctx.sequenceCallbacks.set(handle, callback);
        else ctx.sequenceCallbacks.delete(handle);
        return previous;
    };

    // _AIL_MIDI_to_XMI@20(midi, midi_size, xmi**, xmi_size*, flags) -> 0 on failure.
    // We have no MIDI-to-XMI converter. Reporting failure and leaving the out-params
    // NULL/0 is the honest answer; claiming success would hand the caller a pointer it
    // would then hand back to us as a sequence.
    exports["_AIL_MIDI_to_XMI@20"] = (ctxThunk, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (args[2] && MemoryGuard.isValidRange(mem, args[2], 4)) view.setUint32(args[2], 0, true);
        if (args[3] && MemoryGuard.isValidRange(mem, args[3], 4)) view.setUint32(args[3], 0, true);
        Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_MIDI_to_XMI@20 — no MIDI/XMI converter, reporting failure");
        return 0;
    };

    return exports;
}
