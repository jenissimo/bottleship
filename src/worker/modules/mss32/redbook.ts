/**
 * Miles AIL_redbook_* — the CD-audio transport as Miles exposes it, over the shared
 * VirtualCdAudio drive. Miles addresses the disc in absolute milliseconds (track
 * boundaries come from AIL_redbook_track_info), which is exactly the drive's own
 * currency, so this layer is pure translation plus Miles' handle/status vocabulary.
 */
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MSSContext } from "./context";
import { RedbookHandle } from "./types";
import { virtualCd } from "../../core/audio/virtual-cd";

/** Miles redbook status codes, per mss.h — games compare against these literally. */
const REDBOOK_ERROR = 0;
const REDBOOK_PLAYING = 1;
const REDBOOK_PAUSED = 2;
const REDBOOK_STOPPED = 3;

/** Miles volume range for the CD line. */
const REDBOOK_MAX_VOLUME = 127;

function redbookStatus(): number {
    switch (virtualCd().getMode()) {
        case "playing": return REDBOOK_PLAYING;
        case "paused": return REDBOOK_PAUSED;
        default: return REDBOOK_STOPPED;
    }
}

export function createRedbookExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_redbook_open@4
    exports["_AIL_redbook_open@4"] = (ctxThunk, mem, args) => {
        const deviceId = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_open@4 called: deviceId=${deviceId}`);
        return openRedbookHandle(ctx);
    };

    // _AIL_redbook_close@4
    exports["_AIL_redbook_close@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_close@4 called: handle=0x${handle.toString(16)}`);
        const rb = ctx.redbookHandles.get(handle);
        if (rb && rb.playToken) virtualCd().stop();
        ctx.redbookHandles.delete(handle);
        return 0;
    };

    // _AIL_redbook_open_drive@4
    exports["_AIL_redbook_open_drive@4"] = (ctxThunk, mem, args) => {
        const drive = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_open_drive@4 called: drive=${drive} (${String.fromCharCode(65 + drive)}:)`);
        return openRedbookHandle(ctx);
    };

    // _AIL_redbook_tracks@4 — the drive's TOC length. buildToc already models an absent
    // data track as a non-audio slot, so this is the same count every other surface
    // reports; assuming a leading data track over-counts a rip whose track 1 IS audio.
    exports["_AIL_redbook_tracks@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const count = rb ? virtualCd().numberOfTracks() : 0;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_tracks@4: handle=0x${hand.toString(16)} -> ${count} tracks`);
        return count;
    };

    // _AIL_redbook_track_info@16
    exports["_AIL_redbook_track_info@16"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const tracknum = args[1];
        const startmsecPtr = args[2];
        const endmsecPtr = args[3];
        const rb = ctx.redbookHandles.get(hand);
        const view = new DataView(ctx.memory.buffer, ctx.memory.byteOffset, ctx.memory.byteLength);

        const writeSpan = (start: number, end: number): void => {
            if (startmsecPtr) view.setUint32(startmsecPtr, start >>> 0, true);
            if (endmsecPtr) view.setUint32(endmsecPtr, end >>> 0, true);
        };

        if (!rb) {
            writeSpan(0, 0);
            return 0;
        }

        // tracknum indexes the FULL TOC, exactly as virtualCd().track() does. A data
        // track is an in-range slot with a zero-length span, not a hardcoded track 1.
        const track = virtualCd().track(tracknum);
        if (!track) {
            writeSpan(0, 0);
            return 0;
        }
        writeSpan(track.startMs, track.startMs + track.lengthMs);
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_redbook_track_info@16: track ${tracknum} -> ` +
            `${track.startMs}..${track.startMs + track.lengthMs} (${track.isAudio ? track.file : "data"})`);
        return 1;
    };

    // _AIL_redbook_set_volume@8
    exports["_AIL_redbook_set_volume@8"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const volume = args[1];
        const rb = ctx.redbookHandles.get(hand);
        const prevVolume = rb ? rb.volume : 0;
        if (rb) {
            rb.volume = volume;
            virtualCd().setVolume(volume / REDBOOK_MAX_VOLUME);
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_set_volume@8: handle=0x${hand.toString(16)}, volume=${volume} (prev=${prevVolume})`);
        return prevVolume;
    };

    // _AIL_redbook_volume@4
    exports["_AIL_redbook_volume@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const vol = rb ? rb.volume : 0;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_volume@4: handle=0x${hand.toString(16)} -> ${vol}`);
        return vol;
    };

    // _AIL_redbook_track@4 — the track the drive is on right now (0 when not playing).
    exports["_AIL_redbook_track@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const track = rb ? virtualCd().currentTrackNumber() : 0;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_track@4: handle=0x${hand.toString(16)} -> ${track}`);
        return track;
    };

    // _AIL_redbook_id@4 — the disc identifier games use to tell one CD from another.
    // Real Miles derives it from the TOC, so mirror that: same disc, same id.
    exports["_AIL_redbook_id@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        if (!ctx.redbookHandles.get(hand)) return 0;
        const cd = virtualCd();
        let id = cd.numberOfTracks() >>> 0;
        for (const track of cd.audioTracks()) {
            id = (Math.imul(id, 31) + track.number + track.lengthMs) >>> 0;
        }
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_id@4: handle=0x${hand.toString(16)} -> 0x${id.toString(16)}`);
        return id;
    };

    // _AIL_redbook_eject@4 / _AIL_redbook_retract@4 — physical tray motion. There is no
    // tray, and the disc must stay readable, so these are accepted and do nothing.
    exports["_AIL_redbook_eject@4"] = () => 0;
    exports["_AIL_redbook_retract@4"] = () => 0;

    // _AIL_redbook_status@4
    exports["_AIL_redbook_status@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        // An unknown handle is the error case, not a stopped drive.
        const status = rb ? redbookStatus() : REDBOOK_ERROR;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_status@4: handle=0x${hand.toString(16)} -> ${status}`);
        return status;
    };

    // _AIL_redbook_stop@4
    exports["_AIL_redbook_stop@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (rb) {
            virtualCd().stop();
            rb.playToken = 0;
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_stop@4: handle=0x${hand.toString(16)}`);
        return 0;
    };

    // _AIL_redbook_play@12
    exports["_AIL_redbook_play@12"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const startmsec = args[1];
        const endmsec = args[2];
        const rb = ctx.redbookHandles.get(hand);
        if (!rb) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_redbook_play@12: invalid handle 0x${hand.toString(16)}`);
            return 0;
        }

        const cd = virtualCd();
        cd.setVolume(rb.volume / REDBOOK_MAX_VOLUME);
        const token = cd.play(startmsec, endmsec);
        if (!token) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_redbook_play@12: no track for startmsec=${startmsec}`);
            rb.playToken = 0;
            return 0;
        }

        rb.playToken = token;
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_redbook_play@12: playing track ${cd.currentTrackNumber()} (${startmsec}..${endmsec})`);
        return 1;
    };

    // _AIL_redbook_pause@4
    exports["_AIL_redbook_pause@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        if (ctx.redbookHandles.has(hand)) virtualCd().pause();
        return 0;
    };

    // _AIL_redbook_resume@4
    exports["_AIL_redbook_resume@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        if (ctx.redbookHandles.has(hand)) virtualCd().resume();
        return 0;
    };

    // _AIL_redbook_position@4
    exports["_AIL_redbook_position@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (!rb || redbookStatus() === REDBOOK_STOPPED) return 0;
        return virtualCd().positionMs() | 0;
    };

    return exports;
}

// ==================== Private helpers ====================

function openRedbookHandle(ctx: MSSContext): number {
    const handleId = ctx.nextRedbookId++;
    const cd = virtualCd();
    cd.ensureDisc();

    const rb: RedbookHandle = {
        id: handleId,
        volume: REDBOOK_MAX_VOLUME,
        playToken: 0,
    };
    ctx.redbookHandles.set(handleId, rb);

    Logger.log(LogCategory.SYSTEM,
        `MSS32: Redbook opened: handle=0x${handleId.toString(16)}, ${cd.audioTracks().length} audio tracks found`);
    return handleId;
}
