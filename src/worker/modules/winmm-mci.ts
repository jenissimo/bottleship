/**
 * winmm MCI (Media Control Interface) subsystem: mciGetDeviceIDA / mciSendCommandA /
 * mciSendStringA/W / mciGetErrorStringA, the MCI device registry (id + alias maps), the
 * AVI video playback engine (videoEngine decode, audio-preroll A/V sync, MM_MCINOTIFY
 * completion posting) and the `cdaudio` device, which is a thin adapter over the shared
 * VirtualCdAudio drive. Host interface supplies guest-string helpers shared with the
 * rest of WinMM (PlaySound / waveOutGetErrorText).
 */
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { TimeService } from "../runtime/time";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { videoEngine } from "../../video/video-engine";
import { getAbsoluteWindowPosition, windows } from "./user32/shared-state";
import { virtualCd, CD_FRAMES_PER_SECOND, type CdStopReason } from "../core/audio/virtual-cd";
import {
    getCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_BUFFER_BYTES,
} from "../../audio/audio-ring-buffer";

const MMSYSERR_NOERROR = 0;
const MMSYSERR_ERROR = 1;

// MCI error codes (MCIERR_BASE = 256)
const MCIERR_INVALID_DEVICE_ID = 257;
const MCIERR_UNRECOGNIZED_KEYWORD = 259;
const MCIERR_UNRECOGNIZED_COMMAND = 261;
const MCIERR_INVALID_DEVICE_NAME = 263;
const MCIERR_DEVICE_OPEN = 266;
const MCIERR_MISSING_COMMAND_STRING = 267;
const MCIERR_MISSING_STRING_ARGUMENT = 269;
const MCIERR_BAD_INTEGER = 270;
const MCIERR_MISSING_PARAMETER = 273;
const MCIERR_UNSUPPORTED_FUNCTION = 274;
const MCIERR_DEVICE_NOT_READY = 276;
const MCIERR_OUTOFRANGE = 282;
const MCIERR_DUPLICATE_ALIAS = 289;
const MCIERR_BAD_TIME_FORMAT = 293;
const MCIERR_NULL_PARAMETER_BLOCK = 297;

// MCI command messages
const MCI_OPEN = 0x0803;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_SEEK = 0x0807;
const MCI_STOP = 0x0808;
const MCI_PAUSE = 0x0809;
const MCI_GETDEVCAPS = 0x080B;
const MCI_SET = 0x080D;
const MCI_BREAK = 0x0811;
const MCI_STATUS = 0x0814;
const MCI_WINDOW = 0x0841;
const MCI_PUT = 0x0842;
const MCI_RESUME = 0x0855;

// MCI flags
const MCI_NOTIFY = 0x00000001;
const MCI_WAIT = 0x00000002;
const MCI_FROM = 0x00000004;
const MCI_TO = 0x00000008;
const MCI_TRACK = 0x00000010;
const MCI_OPEN_ELEMENT = 0x00000200;
const MCI_OPEN_TYPE_ID = 0x00001000;
const MCI_OPEN_TYPE = 0x00002000;
const MCI_SEEK_TO_START = 0x00000100;
const MCI_SEEK_TO_END = 0x00000200;
const MCI_SET_TIME_FORMAT = 0x00000400;
const MCI_STATUS_ITEM = 0x00000100;
const MCI_STATUS_START = 0x00000200;
const MCI_GETDEVCAPS_ITEM = 0x00000100;
const MCI_ANIM_WINDOW_HWND = 0x00010000;
const MCI_ANIM_RECT = 0x00040000;
const MCI_ANIM_PUT_SOURCE = 0x00010000;
const MCI_ANIM_PUT_DESTINATION = 0x00020000;
const MCI_ANIM_STATUS_HWND = 0x00004000;
const MCI_ANIM_STATUS_STRETCH = 0x00008000;

// MCI_STATUS items
const MCI_STATUS_LENGTH = 0x00000001;
const MCI_STATUS_POSITION = 0x00000002;
const MCI_STATUS_NUMBER_OF_TRACKS = 0x00000003;
const MCI_STATUS_MODE = 0x00000004;
const MCI_STATUS_MEDIA_PRESENT = 0x00000005;
const MCI_STATUS_TIME_FORMAT = 0x00000006;
const MCI_STATUS_READY = 0x00000007;
const MCI_STATUS_CURRENT_TRACK = 0x00000008;
const MCI_CDA_STATUS_TYPE_TRACK = 0x00004001;

// MCI_GETDEVCAPS items
const MCI_GETDEVCAPS_CAN_RECORD = 0x00000001;
const MCI_GETDEVCAPS_HAS_AUDIO = 0x00000002;
const MCI_GETDEVCAPS_HAS_VIDEO = 0x00000003;
const MCI_GETDEVCAPS_DEVICE_TYPE = 0x00000004;
const MCI_GETDEVCAPS_USES_FILES = 0x00000005;
const MCI_GETDEVCAPS_COMPOUND_DEVICE = 0x00000006;
const MCI_GETDEVCAPS_CAN_EJECT = 0x00000007;
const MCI_GETDEVCAPS_CAN_PLAY = 0x00000008;
const MCI_GETDEVCAPS_CAN_SAVE = 0x00000009;

// Time formats
const MCI_FORMAT_MILLISECONDS = 0;
const MCI_FORMAT_MSF = 2;
const MCI_FORMAT_TMSF = 10;

// CD-audio device constants (mmsystem.h: MCI_CD_OFFSET = 1088). Games compare the
// MCI_CDA_STATUS_TYPE_TRACK result against these literally — Quake II's CDAudio_Play
// skips any track that is not MCI_CDA_TRACK_AUDIO — so a wrong value silences the disc.
const MCI_CD_OFFSET = 1088;
const MCI_CDA_TRACK_AUDIO = MCI_CD_OFFSET + 0;
const MCI_CDA_TRACK_OTHER = MCI_CD_OFFSET + 1;
const MCI_DEVTYPE_CD_AUDIO = 516;

// MCI notification codes
const MCI_NOTIFY_SUCCESSFUL = 1;
const MCI_NOTIFY_SUPERSEDED = 2;
const MCI_NOTIFY_ABORTED = 4;
const MCI_MODE_NOT_READY = 524;
const MCI_MODE_STOP = 525;
const MCI_MODE_PLAY = 526;
const MCI_MODE_PAUSE = 529;

// MM_MCINOTIFY message
const MM_MCINOTIFY = 0x03B9;

/** Simple (non-compound) MCI device types openable by name alone. */
const MCI_SIMPLE_DEVICE_TYPES = new Set([
    "cdaudio", "videodisc", "vcr", "dat", "scanner", "sequencer", "other",
]);

/** MCI_DEVTYPE_* → the device-type name MCI_OPEN_TYPE would have carried. */
function mciDeviceTypeName(devType: number): string {
    switch (devType) {
        case 513: return "vcr";
        case 514: return "videodisc";
        case 515: return "overlay";
        case MCI_DEVTYPE_CD_AUDIO: return "cdaudio";
        case 517: return "dat";
        case 518: return "scanner";
        case 519: return "animation";
        case 520: return "digitalvideo";
        case 521: return "other";
        case 522: return "waveaudio";
        case 523: return "sequencer";
        default: return "";
    }
}

/** MCI_MAKE_MSF — minute in byte 0, second in byte 1, frame in byte 2. */
function msToMsf(ms: number): number {
    const totalFrames = Math.max(0, Math.round((ms * CD_FRAMES_PER_SECOND) / 1000));
    const frames = totalFrames % CD_FRAMES_PER_SECOND;
    const totalSeconds = (totalFrames - frames) / CD_FRAMES_PER_SECOND;
    const seconds = totalSeconds % 60;
    const minutes = Math.min(0xFF, (totalSeconds - seconds) / 60);
    return ((minutes & 0xFF) | ((seconds & 0xFF) << 8) | ((frames & 0xFF) << 16)) >>> 0;
}

function msfToMs(msf: number): number {
    const minutes = msf & 0xFF;
    const seconds = (msf >>> 8) & 0xFF;
    const frames = (msf >>> 16) & 0xFF;
    return minutes * 60000 + seconds * 1000 + Math.round((frames * 1000) / CD_FRAMES_PER_SECOND);
}

function timeFormatName(format: number): string {
    switch (format) {
        case MCI_FORMAT_MSF: return "msf";
        case MCI_FORMAT_TMSF: return "tmsf";
        default: return "milliseconds";
    }
}

function timeFormatFromName(name: string): number | null {
    switch (name.trim().toLowerCase()) {
        case "milliseconds":
        case "ms": return MCI_FORMAT_MILLISECONDS;
        case "msf": return MCI_FORMAT_MSF;
        case "tmsf": return MCI_FORMAT_TMSF;
        default: return null;
    }
}

/** MCI string values are colon-separated fields in the device's time format. */
function formatMciTimeString(format: number, packed: number, fields: 1 | 3 | 4): string {
    if (format === MCI_FORMAT_MILLISECONDS) return (packed >>> 0).toString();
    const bytes = [packed & 0xFF, (packed >>> 8) & 0xFF, (packed >>> 16) & 0xFF, (packed >>> 24) & 0xFF];
    return bytes.slice(0, fields).join(":");
}

function parseMciTimeString(format: number, text: string): number | null {
    const parts = text.split(":").map((p) => parseInt(p, 10));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    if (format === MCI_FORMAT_MILLISECONDS) return parts.length === 1 ? parts[0] >>> 0 : null;
    let packed = 0;
    for (let i = 0; i < parts.length && i < 4; i++) {
        packed |= (parts[i] & 0xFF) << (i * 8);
    }
    return packed >>> 0;
}

interface MCIDevice {
    id: number;
    name: string;
    alias: string;
    mode: "stopped" | "playing" | "paused";
    timeFormat: string;
    /** MCI_FORMAT_* the device answers position/length in (MCI_SET_TIME_FORMAT). */
    timeFormatId: number;
    /** VirtualCdAudio play token this device owns, for MM_MCINOTIFY routing. */
    cdPlayToken?: number;
    cdNotifyRequested?: boolean;
    elementName?: string;
    deviceType?: string;
    hwndWindow?: number;
    windowRect?: { x: number; y: number; w: number; h: number };
    notifyHwnd?: number;
    breakKey?: number;
    breakHwnd?: number;
    notifyTimer?: ReturnType<typeof setTimeout>;
    videoEngineHandle?: number;
    videoFrameTimer?: ReturnType<typeof setTimeout>;
    videoStartInFlight?: boolean;
    videoFrameDurationMs?: number;
    videoWidth?: number;
    videoHeight?: number;
    videoNotifyRequested?: boolean;
    /** Preloaded AVI bytes (sync read on MCI open). */
    videoFileBytes?: Uint8Array;
    /** Wall-clock anchor for stream-time frame scheduling (ms). */
    videoPlaybackStartMs?: number;
    /** Frames presented since playback anchor (for deadline math). */
    videoFramesPresented?: number;
    /** videoFramesPresented at preroll completion — sync point for real-time pacing. */
    videoSyncPresented?: number;
    /** True once audio preroll met or the clip has no audio track. */
    videoPrerollComplete?: boolean;
    videoHasAudio?: boolean;
    videoAudioSampleRate?: number;
    videoAudioChannels?: number;
    /** True when play used MCI_WAIT — virtual time follows wall clock in waitForMciVideoCompletion. */
    mciWaitActive?: boolean;
    videoLastPlayCursor?: number;
    videoPlayedBytes?: number;
}

/** Guest-string helpers the MCI subsystem borrows from the owning WinMM module
 *  (they stay in winmm.ts because PlaySound / waveOutGetErrorText share them). */
export interface WinmmMciHost {
    readAnsiString(ptr: number, maxLen: number): string;
    writeAnsiString(ptr: number, cch: number, value: string): boolean;
    readWideString(ptr: number, maxLen: number): string;
    writeWideString(ptr: number, cch: number, value: string): boolean;
}

export class WinmmMci {
    private mciDevices: Map<number, MCIDevice> = new Map();
    private mciAliases: Map<string, number> = new Map();
    private nextMCIDeviceId = 1;
    private readAnsiString: (ptr: number, maxLen: number) => string;
    private writeAnsiString: (ptr: number, cch: number, value: string) => boolean;
    private readWideString: (ptr: number, maxLen: number) => string;
    private writeWideString: (ptr: number, cch: number, value: string) => boolean;
    /** Registered with VirtualCdAudio while at least one cdaudio device is open. */
    private cdListener: ((token: number, reason: CdStopReason) => void) | null = null;

    constructor(host: WinmmMciHost) {
        this.readAnsiString = host.readAnsiString;
        this.writeAnsiString = host.writeAnsiString;
        this.readWideString = host.readWideString;
        this.writeWideString = host.writeWideString;
    }

    private tokenizeMciCommand(command: string): string[] {
        const tokens: string[] = [];
        const re = /"([^"]*)"|(\S+)/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(command)) !== null) {
            if (match[1] != null) {
                tokens.push(match[1]);
            } else if (match[2] != null) {
                tokens.push(match[2]);
            }
        }
        return tokens;
    }

    private findMciDevice(nameOrAlias: string): MCIDevice | null {
        const key = nameOrAlias.trim().toLowerCase();
        if (!key) return null;
        const aliasId = this.mciAliases.get(key);
        if (aliasId != null) {
            return this.mciDevices.get(aliasId) ?? null;
        }
        for (const device of this.mciDevices.values()) {
            if (device.name.toLowerCase() === key || device.alias.toLowerCase() === key) {
                return device;
            }
        }
        return null;
    }

    private createMciDevice(name: string, alias?: string): MCIDevice {
        const id = this.nextMCIDeviceId++;
        const resolvedAlias = (alias && alias.trim()) ? alias.trim() : name;
        const device: MCIDevice = {
            id,
            name: name.trim(),
            alias: resolvedAlias,
            mode: "stopped",
            timeFormat: "milliseconds",
            timeFormatId: MCI_FORMAT_MILLISECONDS,
        };
        this.mciDevices.set(id, device);
        this.mciAliases.set(resolvedAlias.toLowerCase(), id);
        return device;
    }

    private normalizeMciText(value?: string): string {
        return (value ?? "").trim().replace(/\\/g, "/").toLowerCase();
    }

    private describeMciDevice(device: MCIDevice): string {
        return `device=${device.id} alias="${device.alias}" type="${device.deviceType ?? ""}" file="${device.elementName ?? ""}"`;
    }

    private isMciVideoDevice(device: MCIDevice): boolean {
        const type = this.normalizeMciText(device.deviceType);
        const name = this.normalizeMciText(device.name);
        const element = this.normalizeMciText(device.elementName);
        return type.includes("video")
            || type.includes("avi")
            || name.endsWith(".avi")
            || element.endsWith(".avi");
    }

    // ==================== cdaudio device ====================

    private isMciCdAudioDevice(device: MCIDevice): boolean {
        return this.normalizeMciText(device.deviceType) === "cdaudio";
    }

    /** MCI opens simple devices by type name; a path/extension means a compound device. */
    private inferMciDeviceType(name: string): string | undefined {
        const key = this.normalizeMciText(name);
        if (MCI_SIMPLE_DEVICE_TYPES.has(key)) return key;
        if (key.endsWith(".avi")) return "avivideo";
        return undefined;
    }

    /** Bring the drive online for a freshly opened cdaudio device. MCICDA's default
     *  time format is MSF; games that want TMSF set it explicitly. */
    private openCdAudioDevice(device: MCIDevice): void {
        device.timeFormatId = MCI_FORMAT_MSF;
        device.timeFormat = timeFormatName(MCI_FORMAT_MSF);
        this.ensureCdListener();
        const cd = virtualCd();
        cd.ensureDisc();
        Logger.log(LogCategory.SYSTEM,
            `MCI cdaudio opened: ${this.describeMciDevice(device)} tracks=${cd.numberOfTracks()} ` +
            `length=${cd.discLengthMs() | 0}ms`);
    }

    /**
     * Arm completion routing for this instance. The add is unconditional (the drive keeps
     * listeners in a Set, so it is idempotent): VirtualCdAudio is shared and ANY module may
     * reset it — mss32 does on shutdown — which clears the whole listener set. Re-arming on
     * every open is what keeps MM_MCINOTIFY alive across that; a `if (this.cdListener) return`
     * guard would leave the field set while the drive no longer knows about us.
     */
    private ensureCdListener(): void {
        if (!this.cdListener) this.cdListener = (token, reason) => this.onCdCompletion(token, reason);
        virtualCd().addCompletionListener(this.cdListener);
    }

    /** Drop the drive-side registration once the last cdaudio device is gone. */
    private releaseCdListenerIfIdle(): void {
        if (!this.cdListener) return;
        for (const device of this.mciDevices.values()) {
            if (this.isMciCdAudioDevice(device)) return;
        }
        virtualCd().removeCompletionListener(this.cdListener);
        this.cdListener = null;
    }

    private onCdCompletion(token: number, reason: CdStopReason): void {
        for (const device of this.mciDevices.values()) {
            if (device.cdPlayToken !== token) continue;
            device.cdPlayToken = 0;
            device.mode = "stopped";
            if (!device.cdNotifyRequested) continue;
            device.cdNotifyRequested = false;
            const status = reason === "finished"
                ? MCI_NOTIFY_SUCCESSFUL
                : reason === "superseded"
                    ? MCI_NOTIFY_SUPERSEDED
                    : MCI_NOTIFY_ABORTED;
            this.postMciNotify(device, status, 0, `cdaudio-${reason}`);
        }
    }

    private cdTimeFormat(device: MCIDevice): number {
        return device.timeFormatId ?? MCI_FORMAT_MILLISECONDS;
    }

    /** Decode a dwFrom/dwTo/dwTo-seek value in the device's current time format to disc ms. */
    private cdTimeToMs(device: MCIDevice, value: number): number {
        const v = value >>> 0;
        switch (this.cdTimeFormat(device)) {
            case MCI_FORMAT_MSF:
                return msfToMs(v);
            case MCI_FORMAT_TMSF: {
                const track = virtualCd().track(v & 0xFF);
                return (track ? track.startMs : 0) + msfToMs(v >>> 8);
            }
            default:
                return v;
        }
    }

    /**
     * Encode a disc position. In TMSF a position carries the track plus the offset
     * WITHIN that track; MSF and milliseconds are disc-relative.
     */
    private cdPositionToTime(device: MCIDevice, discMs: number): number {
        switch (this.cdTimeFormat(device)) {
            case MCI_FORMAT_MSF:
                return msToMsf(discMs);
            case MCI_FORMAT_TMSF: {
                const track = virtualCd().trackAt(discMs);
                const number = track ? track.number : 1;
                const offset = track ? discMs - track.startMs : discMs;
                return (msToMsf(offset) << 8 | number) >>> 0;
            }
            default:
                return discMs >>> 0;
        }
    }

    /** Encode a duration. A length has no track, so TMSF degenerates to MSF —
     *  which is exactly what callers rely on to rebuild a TMSF end position. */
    private cdLengthToTime(device: MCIDevice, lengthMs: number): number {
        const format = this.cdTimeFormat(device);
        if (format === MCI_FORMAT_MSF || format === MCI_FORMAT_TMSF) return msToMsf(lengthMs);
        return lengthMs >>> 0;
    }

    private cdModeCode(): number {
        switch (virtualCd().getMode()) {
            case "playing": return MCI_MODE_PLAY;
            case "paused": return MCI_MODE_PAUSE;
            case "notReady": return MCI_MODE_NOT_READY;
            default: return MCI_MODE_STOP;
        }
    }

    /** MCI_STATUS for the cdaudio device. Returns [error, value]. */
    private cdStatusItem(device: MCIDevice, item: number, trackArg: number, wantStart: boolean):
        [number, number] {
        const cd = virtualCd();
        const media = cd.hasMedia();

        switch (item) {
            case MCI_STATUS_READY:
                return [MMSYSERR_NOERROR, media ? 1 : 0];
            case MCI_STATUS_MEDIA_PRESENT:
                return [MMSYSERR_NOERROR, media ? 1 : 0];
            case MCI_STATUS_MODE:
                return [MMSYSERR_NOERROR, this.cdModeCode()];
            case MCI_STATUS_TIME_FORMAT:
                return [MMSYSERR_NOERROR, this.cdTimeFormat(device)];
            default:
                break;
        }

        if (!media) return [MCIERR_DEVICE_NOT_READY, 0];

        switch (item) {
            case MCI_STATUS_NUMBER_OF_TRACKS:
                return [MMSYSERR_NOERROR, cd.numberOfTracks()];

            case MCI_STATUS_CURRENT_TRACK:
                return [MMSYSERR_NOERROR, cd.currentTrackNumber() || 1];

            case MCI_STATUS_LENGTH: {
                if (trackArg) {
                    const track = cd.track(trackArg);
                    if (!track) return [MCIERR_OUTOFRANGE, 0];
                    if (wantStart) return [MMSYSERR_NOERROR, this.cdPositionToTime(device, track.startMs)];
                    return [MMSYSERR_NOERROR, this.cdLengthToTime(device, track.lengthMs)];
                }
                if (wantStart) return [MMSYSERR_NOERROR, this.cdPositionToTime(device, 0)];
                return [MMSYSERR_NOERROR, this.cdLengthToTime(device, cd.discLengthMs())];
            }

            case MCI_STATUS_POSITION: {
                // A track argument (or MCI_STATUS_START) asks for where that item
                // begins, not where the head currently is.
                if (trackArg) {
                    const track = cd.track(trackArg);
                    if (!track) return [MCIERR_OUTOFRANGE, 0];
                    return [MMSYSERR_NOERROR, this.cdPositionToTime(device, track.startMs)];
                }
                if (wantStart) return [MMSYSERR_NOERROR, this.cdPositionToTime(device, 0)];
                return [MMSYSERR_NOERROR, this.cdPositionToTime(device, cd.positionMs())];
            }

            case MCI_CDA_STATUS_TYPE_TRACK: {
                const track = cd.track(trackArg);
                if (!track) return [MCIERR_OUTOFRANGE, 0];
                return [MMSYSERR_NOERROR, track.isAudio ? MCI_CDA_TRACK_AUDIO : MCI_CDA_TRACK_OTHER];
            }

            default:
                return [MCIERR_UNSUPPORTED_FUNCTION, 0];
        }
    }

    private cdGetDevCapsItem(item: number): [number, number] {
        switch (item) {
            case MCI_GETDEVCAPS_DEVICE_TYPE: return [MMSYSERR_NOERROR, MCI_DEVTYPE_CD_AUDIO];
            case MCI_GETDEVCAPS_HAS_AUDIO: return [MMSYSERR_NOERROR, 1];
            case MCI_GETDEVCAPS_CAN_PLAY: return [MMSYSERR_NOERROR, 1];
            case MCI_GETDEVCAPS_CAN_EJECT: return [MMSYSERR_NOERROR, 1];
            case MCI_GETDEVCAPS_HAS_VIDEO: return [MMSYSERR_NOERROR, 0];
            case MCI_GETDEVCAPS_CAN_RECORD: return [MMSYSERR_NOERROR, 0];
            case MCI_GETDEVCAPS_CAN_SAVE: return [MMSYSERR_NOERROR, 0];
            case MCI_GETDEVCAPS_USES_FILES: return [MMSYSERR_NOERROR, 0];
            case MCI_GETDEVCAPS_COMPOUND_DEVICE: return [MMSYSERR_NOERROR, 0];
            default: return [MCIERR_UNSUPPORTED_FUNCTION, 0];
        }
    }

    /** Arm a play request and record the token so completion reaches this device. */
    private cdBeginPlay(device: MCIDevice, fromMs: number, toMs: number, notify: boolean): number {
        const token = virtualCd().play(fromMs, toMs);
        if (!token) return MCIERR_OUTOFRANGE;
        device.cdPlayToken = token;
        device.cdNotifyRequested = notify;
        device.mode = "playing";
        return MMSYSERR_NOERROR;
    }

    private cdStop(device: MCIDevice): void {
        virtualCd().stop();
        device.cdPlayToken = 0;
        device.cdNotifyRequested = false;
        device.mode = "stopped";
    }

    /** mciSendCommand dispatch for a cdaudio device. */
    private handleCdAudioCommand(
        device: MCIDevice,
        uMsg: number,
        fdwCommand: number,
        dwParam: number,
        view: DataView,
    ): number {
        const cd = virtualCd();

        switch (uMsg) {
            case MCI_SET: {
                if (fdwCommand & MCI_SET_TIME_FORMAT) {
                    if (!dwParam) return MCIERR_NULL_PARAMETER_BLOCK;
                    const format = view.getUint32(dwParam + 4, true) >>> 0;
                    if (format !== MCI_FORMAT_MILLISECONDS
                        && format !== MCI_FORMAT_MSF
                        && format !== MCI_FORMAT_TMSF) {
                        return MCIERR_BAD_TIME_FORMAT;
                    }
                    device.timeFormatId = format;
                    device.timeFormat = timeFormatName(format);
                    Logger.log(LogCategory.SYSTEM,
                        `MCI cdaudio set time format: ${this.describeMciDevice(device)} -> ${device.timeFormat}`);
                }
                // Door open/close and the audio on/off lines have no physical
                // counterpart here; accepting them keeps the guest's setup path whole.
                return MMSYSERR_NOERROR;
            }

            case MCI_STATUS: {
                if (!(fdwCommand & MCI_STATUS_ITEM)) return MCIERR_MISSING_PARAMETER;
                if (!dwParam) return MCIERR_NULL_PARAMETER_BLOCK;
                const item = view.getUint32(dwParam + 8, true) >>> 0;
                const trackArg = (fdwCommand & MCI_TRACK) ? view.getUint32(dwParam + 12, true) >>> 0 : 0;
                const [err, value] = this.cdStatusItem(
                    device, item, trackArg, (fdwCommand & MCI_STATUS_START) !== 0);
                if (err === MMSYSERR_NOERROR) view.setUint32(dwParam + 4, value >>> 0, true);
                Logger.verbose(LogCategory.SYSTEM,
                    `MCI cdaudio status: item=0x${item.toString(16)} track=${trackArg} -> err=${err} value=${value}`);
                return err;
            }

            case MCI_GETDEVCAPS: {
                if (!(fdwCommand & MCI_GETDEVCAPS_ITEM)) return MCIERR_MISSING_PARAMETER;
                if (!dwParam) return MCIERR_NULL_PARAMETER_BLOCK;
                const item = view.getUint32(dwParam + 8, true) >>> 0;
                const [err, value] = this.cdGetDevCapsItem(item);
                if (err === MMSYSERR_NOERROR) view.setUint32(dwParam + 4, value >>> 0, true);
                return err;
            }

            case MCI_PLAY: {
                if (!cd.hasMedia()) return MCIERR_DEVICE_NOT_READY;
                const notify = (fdwCommand & MCI_NOTIFY) !== 0;
                const hwndCallback = dwParam ? view.getUint32(dwParam, true) >>> 0 : 0;
                if (notify) this.resolveMciNotifyHwnd(device, hwndCallback);
                const fromMs = (fdwCommand & MCI_FROM) && dwParam
                    ? this.cdTimeToMs(device, view.getUint32(dwParam + 4, true))
                    : cd.positionMs();
                const toMs = (fdwCommand & MCI_TO) && dwParam
                    ? this.cdTimeToMs(device, view.getUint32(dwParam + 8, true))
                    : 0;
                Logger.log(LogCategory.SYSTEM,
                    `MCI cdaudio play: ${this.describeMciDevice(device)} ${fromMs}..${toMs}ms notify=${notify ? 1 : 0}`);
                return this.cdBeginPlay(device, fromMs, toMs, notify);
            }

            case MCI_SEEK: {
                if (!cd.hasMedia()) return MCIERR_DEVICE_NOT_READY;
                this.cdStop(device);
                if (fdwCommand & MCI_SEEK_TO_START) {
                    cd.seek(0);
                } else if (fdwCommand & MCI_SEEK_TO_END) {
                    cd.seek(cd.discLengthMs());
                } else if ((fdwCommand & MCI_TO) && dwParam) {
                    cd.seek(this.cdTimeToMs(device, view.getUint32(dwParam + 4, true)));
                } else {
                    return MCIERR_MISSING_PARAMETER;
                }
                return MMSYSERR_NOERROR;
            }

            case MCI_PAUSE:
                cd.pause();
                if (cd.getMode() === "paused") device.mode = "paused";
                return MMSYSERR_NOERROR;

            case MCI_RESUME:
                cd.resume();
                if (cd.getMode() === "playing") device.mode = "playing";
                return MMSYSERR_NOERROR;

            case MCI_STOP:
                this.cdStop(device);
                return MMSYSERR_NOERROR;

            case MCI_CLOSE:
                this.cdStop(device);
                this.mciDevices.delete(device.id);
                this.mciAliases.delete(device.alias.toLowerCase());
                this.releaseCdListenerIfIdle();
                return MMSYSERR_NOERROR;

            case MCI_BREAK:
                return MMSYSERR_NOERROR;

            default:
                return MCIERR_UNSUPPORTED_FUNCTION;
        }
    }

    private clearMciNotifyTimer(device: MCIDevice): void {
        if (device.notifyTimer != null) {
            clearTimeout(device.notifyTimer);
            device.notifyTimer = undefined;
        }
    }

    private clearMciVideoTimer(device: MCIDevice): void {
        if (device.videoFrameTimer != null) {
            clearTimeout(device.videoFrameTimer);
            device.videoFrameTimer = undefined;
        }
    }

    private closeMciVideoHandle(device: MCIDevice): void {
        this.clearMciVideoTimer(device);
        if (device.videoEngineHandle && device.videoEngineHandle > 0) {
            videoEngine.close(device.videoEngineHandle);
        }
        device.videoEngineHandle = 0;
        device.videoStartInFlight = false;
        device.videoWidth = 0;
        device.videoHeight = 0;
    }

    private resolveMciNotifyHwnd(device: MCIDevice, hwndCallback: number): number {
        const hwnd = (hwndCallback || device.notifyHwnd || device.hwndWindow || device.breakHwnd || 0) >>> 0;
        if (hwndCallback) {
            device.notifyHwnd = hwndCallback >>> 0;
        }
        return hwnd;
    }

    private postMciNotify(device: MCIDevice, status: number, hwndCallback: number, reason: string): void {
        const hwnd = this.resolveMciNotifyHwnd(device, hwndCallback);
        device.mode = "stopped";
        if (!hwnd) {
            Logger.log(LogCategory.SYSTEM,
                `MCI notify skipped (${reason}): ${this.describeMciDevice(device)} no callback hwnd`);
            return;
        }

        Logger.log(LogCategory.SYSTEM,
            `MCI notify (${reason}): ${this.describeMciDevice(device)} hwnd=0x${hwnd.toString(16)} status=${status}`);
        const system = System.getInstance();
        system.windowManager.postMessage(hwnd, MM_MCINOTIFY, status, device.id);
        system.scheduler.wakeMessageWaiters();
    }

    private scheduleMciCompletion(device: MCIDevice, hwndCallback: number, delayMs: number, reason: string): void {
        this.clearMciNotifyTimer(device);
        const hwnd = this.resolveMciNotifyHwnd(device, hwndCallback);
        if (delayMs <= 0) {
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, hwnd, reason);
            return;
        }

        Logger.log(LogCategory.SYSTEM,
            `MCI notify scheduled (${reason}): ${this.describeMciDevice(device)} hwnd=0x${hwnd.toString(16)} delayMs=${delayMs}`);
        device.notifyTimer = setTimeout(() => {
            device.notifyTimer = undefined;
            if (!this.mciDevices.has(device.id)) return;
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, hwnd, reason);
        }, delayMs);
    }

    private startMciPlayback(
        device: MCIDevice,
        notifyRequested: boolean,
        hwndCallback: number,
        source: string,
        waitForCompletion: boolean = false,
        stackCleanup: number = 0,
    ): number | ThunkResult | Promise<ThunkResult> {
        if (this.isMciVideoDevice(device)) {
            return this.playMciVideoThunk(
                device, notifyRequested, hwndCallback, source, waitForCompletion, stackCleanup);
        }

        Logger.log(LogCategory.SYSTEM,
            `${source} play: ${this.describeMciDevice(device)} notify=${notifyRequested ? 1 : 0}`);

        device.mode = "playing";
        if (notifyRequested) {
            this.scheduleMciCompletion(device, hwndCallback, 500, source);
        }
        return MMSYSERR_NOERROR;
    }

    private stopMciPlayback(device: MCIDevice, reason: string): void {
        const hadPendingNotify = device.notifyTimer != null;
        const hwnd = this.resolveMciNotifyHwnd(device, 0);
        this.clearMciNotifyTimer(device);
        this.abortMciVideoPlayback(device, reason);
        device.mode = "stopped";
        Logger.log(LogCategory.SYSTEM,
            `${reason}: ${this.describeMciDevice(device)} pendingNotify=${hadPendingNotify ? 1 : 0}`);
        if (hadPendingNotify && hwnd) {
            const system = System.getInstance();
            system.windowManager.postMessage(hwnd, MM_MCINOTIFY, MCI_NOTIFY_ABORTED, device.id);
            system.scheduler.wakeMessageWaiters();
        }
    }

    private resolveMciVideoVfsPath(device: MCIDevice): string | null {
        const rawPath = device.elementName || device.name;
        if (!rawPath) return null;

        const vfs = System.getInstance().fileSystem;
        const romPath = vfs.resolveRomMediaPath(rawPath);
        if (romPath) return romPath;

        let vfsPath = rawPath.replace(/\\/g, '/');
        if (vfsPath.match(/^[A-Z]:/i)) {
            vfsPath = `C:${vfsPath.substring(2).replace(/\//g, '\\')}`;
        } else {
            vfsPath = vfs.resolvePath(vfsPath);
        }
        return vfs.getFileSize(vfsPath) > 0 ? vfsPath : null;
    }

    private async readMciVideoFile(vfsPath: string): Promise<Uint8Array | null> {
        const sync = this.readMciVideoFileSync(vfsPath);
        if (sync) return sync;
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(vfsPath);
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size <= 0 || size > LIMIT_BYTES) {
                Logger.warn(LogCategory.SYSTEM, `MCI video: invalid file size ${size} for "${vfsPath}"`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(vfsPath, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;
            return await vfs.read(handle, size);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MCI video: read "${vfsPath}" failed: ${e}`);
            return null;
        }
    }

    private readMciVideoFileSync(vfsPath: string): Uint8Array | null {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(vfsPath);
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size <= 0 || size > LIMIT_BYTES) return null;
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = vfs.openSync(vfsPath, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;
            const chunks: Uint8Array[] = [];
            let remaining = size;
            while (remaining > 0) {
                const chunk = vfs.readSync(handle, Math.min(remaining, 4 * 1024 * 1024));
                if (!chunk || chunk.length === 0) break;
                chunks.push(chunk);
                remaining -= chunk.length;
            }
            if (remaining > 0) return null;
            const out = new Uint8Array(size);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.length;
            }
            return out;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `MCI video sync read "${vfsPath}" failed: ${e}`);
            return null;
        }
    }

    private preloadMciVideoDevice(device: MCIDevice): void {
        if (device.videoFileBytes || !this.isMciVideoDevice(device)) return;
        const vfsPath = this.resolveMciVideoVfsPath(device);
        if (!vfsPath) return;
        const bytes = this.readMciVideoFileSync(vfsPath);
        if (bytes) {
            device.videoFileBytes = bytes;
            Logger.log(LogCategory.SYSTEM,
                `MCI video preload: ${this.describeMciDevice(device)} vfs="${vfsPath}" bytes=${bytes.length}`);
        }
    }

    private isMciVideoReady(device: MCIDevice): boolean {
        if (!this.isMciVideoDevice(device)) return true;
        if (device.videoStartInFlight) return false;
        return (device.videoEngineHandle ?? 0) > 0;
    }

    private async prepareMciVideoEngine(device: MCIDevice, source: string): Promise<boolean> {
        if (!this.mciDevices.has(device.id)) return false;

        if (EmulatorConfig.getInstance().skipVideo) {
            Logger.log(LogCategory.SYSTEM, `MCI video skipped by config: ${this.describeMciDevice(device)}`);
            this.completeMciVideoPlayback(device, 'skipVideo');
            return false;
        }

        if (!device.videoFileBytes) {
            this.preloadMciVideoDevice(device);
        }
        let fileBytes = device.videoFileBytes;
        if (!fileBytes) {
            const vfsPath = this.resolveMciVideoVfsPath(device);
            if (!vfsPath) {
                Logger.warn(LogCategory.SYSTEM, `MCI video not found: ${this.describeMciDevice(device)}`);
                this.completeMciVideoPlayback(device, 'missing');
                return false;
            }
            const loaded = await this.readMciVideoFile(vfsPath);
            if (!loaded) {
                this.completeMciVideoPlayback(device, 'read-failed');
                return false;
            }
            fileBytes = loaded;
            device.videoFileBytes = loaded;
        }

        if (!this.mciDevices.has(device.id) || device.mode !== 'playing') return false;

        const engineHandle = await videoEngine.open(fileBytes);
        const info = videoEngine.getInfo(engineHandle);
        if (!info) {
            videoEngine.close(engineHandle);
            this.completeMciVideoPlayback(device, 'open-failed');
            return false;
        }

        if (!this.mciDevices.has(device.id) || device.mode !== 'playing') {
            videoEngine.close(engineHandle);
            return false;
        }

        device.videoEngineHandle = engineHandle;
        device.videoStartInFlight = false;
        device.videoWidth = info.width;
        device.videoHeight = info.height;
        device.videoFrameDurationMs = info.fps > 0 ? (1000 / info.fps) : 66;
        device.videoHasAudio = info.hasAudio;
        device.videoAudioSampleRate = info.hasAudio ? info.sampleRate : 0;
        device.videoAudioChannels = info.hasAudio ? info.channels : 0;
        device.videoFramesPresented = 0;
        device.videoSyncPresented = 0;
        device.videoPrerollComplete = !info.hasAudio;
        device.videoPlaybackStartMs = info.hasAudio ? 0 : performance.now();

        Logger.log(LogCategory.SYSTEM,
            `${source} video decode started: ${this.describeMciDevice(device)} ` +
            `${info.width}x${info.height} fps=${info.fps.toFixed(1)} codec="${info.codecName}"`);
        this.decodeMciVideoFrame(device.id);
        return true;
    }

    private waitForMciVideoCompletion(device: MCIDevice): Promise<void> {
        const time = TimeService.getInstance();
        return new Promise((resolve) => {
            let lastPollMs = performance.now();
            const poll = (): void => {
                if (!this.mciDevices.has(device.id) || device.mode !== 'playing') {
                    resolve();
                    return;
                }
                // MCI_WAIT blocks the caller until playback ends; guest GetTickCount/timeGetTime
                // still advance at wall-clock rate while the thread is parked (async thunk).
                const now = performance.now();
                const dt = now - lastPollMs;
                lastPollMs = now;
                if (dt > 0) {
                    time.advanceVirtualTime(dt);
                }
                setTimeout(poll, 16);
            };
            poll();
        });
    }

    /**
     * Stream position in ms for A/V sync. Uses the audio play cursor when available
     * (master clock); falls back to wall time since preroll completed.
     */
    private getMciVideoStreamElapsedMs(device: MCIDevice): number {
        if (!device.videoPrerollComplete || !device.videoPlaybackStartMs) return 0;

        const handle = device.videoEngineHandle;
        if (device.videoHasAudio && handle && videoEngine.hasAudioPlaybackStarted(handle)) {
            const sab = videoEngine.getAudioSab(handle);
            const rate = device.videoAudioSampleRate ?? 0;
            const ch = device.videoAudioChannels ?? 0;
            const bufferBytes = sab ? getCtrl(sab, CTRL_BUFFER_BYTES) : 0;
            if (sab && rate > 0 && ch > 0 && bufferBytes > 0) {
                const playBytesWrapped = getCtrl(sab, CTRL_PLAY_CURSOR);

                // Track unwrapped position to handle ring wraps
                if (device.videoLastPlayCursor === undefined) {
                    device.videoPlayedBytes = playBytesWrapped;
                } else {
                    let delta = (playBytesWrapped - device.videoLastPlayCursor + bufferBytes) % bufferBytes;
                    // If the worklet is stuck in underrun, Atomics.load(CTRL_PLAY_CURSOR) stays constant.
                    // If it's a huge jump, assume it's a reset/seek rather than 1000 wraps.
                    if (delta > bufferBytes / 2) delta = 0;
                    device.videoPlayedBytes = (device.videoPlayedBytes ?? 0) + delta;
                }
                device.videoLastPlayCursor = playBytesWrapped;

                const blockAlign = ch * 2;
                if (blockAlign > 0) {
                    return (device.videoPlayedBytes / blockAlign / rate) * 1000;
                }
            }
        }
        return performance.now() - device.videoPlaybackStartMs;
    }

    /** Highest 0-based frame index that should be visible at the current stream position. */
    private getMciVideoTargetFrameIndex(device: MCIDevice): number {
        const anchor = device.videoSyncPresented ?? 0;
        const frameDur = device.videoFrameDurationMs ?? 66;
        if (frameDur <= 0) return anchor;
        const elapsed = this.getMciVideoStreamElapsedMs(device);
        return anchor + Math.floor(elapsed / frameDur);
    }

    private playMciVideoThunk(
        device: MCIDevice,
        notifyRequested: boolean,
        hwndCallback: number,
        source: string,
        waitForCompletion: boolean,
        stackCleanup: number,
    ): ThunkResult | Promise<ThunkResult> {
        this.clearMciNotifyTimer(device);
        this.abortMciVideoPlayback(device, 'restart');
        device.mode = 'playing';
        device.videoNotifyRequested = notifyRequested;
        device.videoStartInFlight = true;
        device.mciWaitActive = waitForCompletion;
        this.resolveMciNotifyHwnd(device, hwndCallback);
        this.preloadMciVideoDevice(device);

        Logger.log(LogCategory.SYSTEM,
            `${source} video play: ${this.describeMciDevice(device)} notify=${notifyRequested ? 1 : 0} wait=${waitForCompletion ? 1 : 0}`);

        return (async (): Promise<ThunkResult> => {
            try {
                const ok = await this.prepareMciVideoEngine(device, source);
                if (!ok) {
                    return { value: MMSYSERR_NOERROR, stackCleanup };
                }
                if (waitForCompletion) {
                    await this.waitForMciVideoCompletion(device);
                }
                return { value: MMSYSERR_NOERROR, stackCleanup };
            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `MCI video playback failed: ${this.describeMciDevice(device)} ${e}`);
                this.completeMciVideoPlayback(device, 'error');
                return { value: MMSYSERR_NOERROR, stackCleanup };
            } finally {
                const cur = this.mciDevices.get(device.id);
                if (cur) cur.videoStartInFlight = false;
            }
        })();
    }

    private getMciVideoDestRect(device: MCIDevice, srcW: number, srcH: number): { x: number; y: number; w: number; h: number } {
        const win = device.hwndWindow ? windows.get(device.hwndWindow) : undefined;
        const base = win ? getAbsoluteWindowPosition(win) : { x: 0, y: 0 };
        if (device.windowRect && device.windowRect.w > 0 && device.windowRect.h > 0) {
            return {
                x: base.x + device.windowRect.x,
                y: base.y + device.windowRect.y,
                w: device.windowRect.w,
                h: device.windowRect.h,
            };
        }
        if (win) {
            return {
                x: base.x,
                y: base.y,
                w: win.width > 0 ? win.width : srcW,
                h: win.height > 0 ? win.height : srcH,
            };
        }
        return { x: 0, y: 0, w: srcW, h: srcH };
    }

    private completeMciVideoPlayback(device: MCIDevice, reason: string): void {
        device.mciWaitActive = false;
        this.closeMciVideoHandle(device);
        device.mode = "stopped";
        Logger.log(LogCategory.SYSTEM, `MCI video complete (${reason}): ${this.describeMciDevice(device)}`);
        if (device.videoNotifyRequested) {
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, 0, `mci-video-${reason}`);
        }
        device.videoNotifyRequested = false;
    }

    private abortMciVideoPlayback(device: MCIDevice, reason: string): void {
        const hadVideo = !!device.videoEngineHandle || !!device.videoFrameTimer || !!device.videoStartInFlight;
        const shouldNotify = !!device.videoNotifyRequested;
        this.closeMciVideoHandle(device);
        device.videoNotifyRequested = false;
        if (!hadVideo) return;

        Logger.log(LogCategory.SYSTEM, `MCI video abort (${reason}): ${this.describeMciDevice(device)}`);
        if (shouldNotify) {
            this.postMciNotify(device, MCI_NOTIFY_ABORTED, 0, `mci-video-${reason}`);
        }
    }

    /** Max frames to decode at full speed while filling the audio preroll buffer. */
    private static readonly MCI_VIDEO_MAX_PREROLL_FRAMES = 120;
    /** Low-water mark: decode bursts when ring pending drops below this (ms of PCM). */
    private static readonly MCI_AUDIO_LOW_WATER_MS = 400;
    /** High-water mark: ease decode polling when pending exceeds this (ms of PCM). */
    private static readonly MCI_AUDIO_HIGH_WATER_MS = 900;
    /** Max consecutive doFrame calls per timer tick when refilling audio. */
    private static readonly MCI_AUDIO_DECODE_BURST = 16;

    private getMciAudioBytesForMs(device: MCIDevice, ms: number): number {
        const rate = device.videoAudioSampleRate ?? 0;
        const ch = device.videoAudioChannels ?? 1;
        if (rate <= 0 || ms <= 0) return 0;
        return Math.ceil(rate * ch * 2 * (ms / 1000));
    }

    private getMciAudioLowWaterBytes(device: MCIDevice): number {
        return this.getMciAudioBytesForMs(device, WinmmMci.MCI_AUDIO_LOW_WATER_MS);
    }

    private getMciAudioHighWaterBytes(device: MCIDevice): number {
        return this.getMciAudioBytesForMs(device, WinmmMci.MCI_AUDIO_HIGH_WATER_MS);
    }

    private scheduleMciVideoFrame(device: MCIDevice): void {
        if (device.mode !== "playing" || !device.videoEngineHandle) return;

        const frameDur = device.videoFrameDurationMs ?? 66;
        let delayMs: number;

        if (!device.videoPrerollComplete) {
            // Preroll: decode as fast as possible, but don't lap the max preroll frame count
            // in a single tick to avoid starving the worker's event loop.
            delayMs = 0;
        } else {
            const startMs = device.videoPlaybackStartMs ?? performance.now();
            const presented = device.videoFramesPresented ?? 0;
            const anchor = device.videoSyncPresented ?? 0;
            const targetIdx = this.getMciVideoTargetFrameIndex(device);

            if (presented <= targetIdx) {
                // Behind or on time: decode next frame ASAP.
                delayMs = 0;
            } else {
                // Ahead: wait for the next frame's deadline.
                const deadline = startMs + (presented - anchor + 1) * frameDur;
                delayMs = Math.max(1, deadline - performance.now());

                // If audio is hungry, throttle less aggressively to allow refilling.
                if (device.videoHasAudio) {
                    const buffered = videoEngine.getBufferedAudioBytes(device.videoEngineHandle!);
                    if (buffered < this.getMciAudioLowWaterBytes(device)) {
                        delayMs = Math.min(delayMs, 10);
                    }
                }
            }
        }

        device.videoFrameTimer = setTimeout(() => this.decodeMciVideoFrame(device.id), delayMs);
    }

    private tryCompleteMciVideoPreroll(device: MCIDevice): void {
        if (device.videoPrerollComplete || !device.videoEngineHandle || !device.videoHasAudio) return;

        const handle = device.videoEngineHandle;
        const preroll = videoEngine.getAudioPrerollBytes(handle);
        const buffered = videoEngine.getBufferedAudioBytes(handle);
        const presented = device.videoFramesPresented ?? 0;
        const ready = buffered >= preroll
            || presented >= WinmmMci.MCI_VIDEO_MAX_PREROLL_FRAMES
            || videoEngine.hasAudioPlaybackStarted(handle);

        if (!ready) return;

        videoEngine.beginAudioPlayback(handle);
        device.videoPrerollComplete = true;
        device.videoPlaybackStartMs = performance.now();
        device.videoSyncPresented = presented;
        Logger.log(LogCategory.SYSTEM,
            `MCI video preroll complete: ${this.describeMciDevice(device)} ` +
            `frames=${presented} buffered=${buffered}B preroll=${preroll}B`);
    }

    private decodeMciVideoFrame(deviceId: number): void {
        const device = this.mciDevices.get(deviceId);
        if (!device || device.mode !== "playing" || !device.videoEngineHandle) return;

        try {
            const handle = device.videoEngineHandle;
            const startMs = performance.now();
            const ok = videoEngine.doFrame(handle);
            const decodeElapsed = performance.now() - startMs;

            if (!ok) {
                if (decodeElapsed > 1) {
                    TimeService.getInstance().advanceVirtualTime(decodeElapsed);
                }
                this.completeMciVideoPlayback(device, "eof");
                return;
            }

            const frameIndex0 = device.videoFramesPresented ?? 0;
            const targetIdx = this.getMciVideoTargetFrameIndex(device);
            const shouldBlit = !device.videoPrerollComplete || frameIndex0 <= targetIdx;

            const bgra = shouldBlit ? videoEngine.getFrameBgra(handle) : null;
            const srcW = device.videoWidth ?? 0;
            const srcH = device.videoHeight ?? 0;
            if (bgra && srcW > 0 && srcH > 0) {
                const rect = this.getMciVideoDestRect(device, srcW, srcH);
                System.getInstance().gdiContext.drawBgraToOverlayRect(rect.x, rect.y, rect.w, rect.h, bgra, srcW, srcH);
            }

            device.videoFramesPresented = frameIndex0 + 1;
            this.tryCompleteMciVideoPreroll(device);

            // Virtual time: preroll frames only credit decode work; stream frames credit
            // one frame of media timeline unless MCI_WAIT (wall clock credited in wait poll).
            const frameDur = device.videoFrameDurationMs ?? 66;
            const time = TimeService.getInstance();
            if (!device.mciWaitActive) {
                if (device.videoPrerollComplete) {
                    time.advanceVirtualTime(Math.max(frameDur, decodeElapsed));
                } else if (decodeElapsed > 1) {
                    time.advanceVirtualTime(decodeElapsed);
                }
            } else if (!device.videoPrerollComplete && decodeElapsed > 1) {
                time.advanceVirtualTime(decodeElapsed);
            }

            videoEngine.nextFrame(handle);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MCI video decode error: ${e}`);
            this.completeMciVideoPlayback(device, "error");
            return;
        }

        this.scheduleMciVideoFrame(device);
    }

    // ==================== MCI string interface ====================

    /** Shared body of mciSendStringA/W; `emit` writes the command's return string.
     *  Video playback with MCI_WAIT parks the thunk, hence the ThunkResult union. */
    private sendMciString(
        command: string,
        hwndCallback: number,
        emit: (value: string) => void,
    ): number | ThunkResult | Promise<ThunkResult> {
        const raw = (command ?? "").trim();
        if (!raw) return MCIERR_MISSING_COMMAND_STRING;

        const tokens = this.tokenizeMciCommand(raw);
        if (tokens.length === 0) return MCIERR_MISSING_COMMAND_STRING;

        const verb = tokens[0].toLowerCase();
        Logger.verbose(LogCategory.SYSTEM, `mciSendString: "${raw}" cb=0x${hwndCallback.toString(16)}`);
        emit("");

        if (verb === "open") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const name = tokens[1];
            let alias = "";
            const aliasIndex = tokens.findIndex((t) => t.toLowerCase() === "alias");
            if (aliasIndex >= 0 && aliasIndex + 1 < tokens.length) {
                alias = tokens[aliasIndex + 1];
            }
            if (alias && this.mciAliases.has(alias.toLowerCase())) {
                return MCIERR_DUPLICATE_ALIAS;
            }
            // A simple device (cdaudio and friends) is ONE device — there is one drive.
            // Opening it twice is MCIERR_DEVICE_OPEN, not a second device: the alias
            // entry would move to the newcomer, so `close cdaudio` would delete the
            // wrong one and strand the first — its id dead, its drive-side listener
            // unreleasable. A compound device (a file) may legitimately open more than once.
            if (!alias && MCI_SIMPLE_DEVICE_TYPES.has(this.normalizeMciText(name))
                && this.findMciDevice(name)) {
                return MCIERR_DEVICE_OPEN;
            }
            const typeIndex = tokens.findIndex((t) => t.toLowerCase() === "type");
            const device = this.createMciDevice(name, alias || undefined);
            device.elementName = name;
            device.deviceType = typeIndex >= 0 && typeIndex + 1 < tokens.length
                ? this.normalizeMciText(tokens[typeIndex + 1])
                : this.inferMciDeviceType(name);
            Logger.log(LogCategory.SYSTEM, `mciSendString open: ${this.describeMciDevice(device)}`);
            if (this.isMciCdAudioDevice(device)) {
                this.openCdAudioDevice(device);
            } else {
                this.preloadMciVideoDevice(device);
            }
            return MMSYSERR_NOERROR;
        }

        if (verb === "close") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const target = tokens[1].toLowerCase();
            if (target === "all") {
                for (const device of this.mciDevices.values()) {
                    if (this.isMciCdAudioDevice(device)) this.cdStop(device);
                    else this.stopMciPlayback(device, "mciSendString close all");
                }
                this.mciDevices.clear();
                this.mciAliases.clear();
                this.releaseCdListenerIfIdle();
                return MMSYSERR_NOERROR;
            }
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            if (this.isMciCdAudioDevice(device)) this.cdStop(device);
            else this.stopMciPlayback(device, "mciSendString close");
            this.mciDevices.delete(device.id);
            this.mciAliases.delete(device.alias.toLowerCase());
            this.releaseCdListenerIfIdle();
            return MMSYSERR_NOERROR;
        }

        if (verb === "sysinfo") {
            let out = "";
            if (tokens.some((t) => t.toLowerCase() === "quantity") && tokens.some((t) => t.toLowerCase() === "open")) {
                out = this.mciDevices.size.toString();
            }
            emit(out);
            return MMSYSERR_NOERROR;
        }

        if (verb === "break") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            Logger.log(LogCategory.SYSTEM, `mciSendString break: ${this.describeMciDevice(device)} key=0x${(device.breakKey ?? 0).toString(16)} hwnd=0x${(device.breakHwnd ?? 0).toString(16)}`);
            return MMSYSERR_NOERROR;
        }

        if (verb === "set") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            const lower = tokens.map((t) => t.toLowerCase());
            if (lower.includes("break")) {
                const keyIdx = lower.indexOf("key");
                if (keyIdx >= 0 && keyIdx + 1 < tokens.length) {
                    const keyTok = tokens[keyIdx + 1].toLowerCase();
                    device.breakKey = keyTok === "on" ? 0x1B : parseInt(tokens[keyIdx + 1], 0) || 0; // ESC default
                }
                Logger.log(LogCategory.SYSTEM, `mciSendString set break key: device=${device.alias}`);
                return MMSYSERR_NOERROR;
            }
            const tf = lower.indexOf("time");
            if (tf >= 0 && tf + 2 < tokens.length && lower[tf + 1] === "format") {
                const format = timeFormatFromName(tokens[tf + 2]);
                if (format === null) {
                    if (this.isMciCdAudioDevice(device)) return MCIERR_BAD_TIME_FORMAT;
                    device.timeFormat = tokens[tf + 2];
                } else {
                    device.timeFormatId = format;
                    device.timeFormat = timeFormatName(format);
                }
            }
            const handleIdx = lower.indexOf("handle");
            if (handleIdx >= 0 && handleIdx + 1 < tokens.length) {
                device.hwndWindow = parseInt(tokens[handleIdx + 1], 0) >>> 0;
            }
            return MMSYSERR_NOERROR;
        }

        if (["play", "stop", "pause", "resume", "seek", "status"].includes(verb)) {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            const lower = tokens.map((t) => t.toLowerCase());

            if (this.isMciCdAudioDevice(device)) {
                return this.handleCdAudioString(device, verb, tokens, lower, hwndCallback, emit);
            }

            if (verb === "play") {
                return this.startMciPlayback(
                    device,
                    lower.includes("notify"),
                    hwndCallback,
                    "mciSendString",
                    lower.includes("wait"),
                    16,
                );
            }
            if (verb === "stop") {
                this.stopMciPlayback(device, "mciSendString stop");
                return MMSYSERR_NOERROR;
            }
            if (verb === "pause") device.mode = "paused";
            if (verb === "resume") device.mode = "playing";
            if (verb === "status") {
                const itemTokens = lower.slice(2).filter((t) => t !== "wait" && t !== "notify");
                const item = itemTokens.length > 0 ? itemTokens.join(" ") : "mode";
                let out = "0";
                if (item === "mode") out = device.mode;
                else if (item === "ready") out = this.isMciVideoReady(device) ? "true" : "false";
                else if (item === "window handle") out = (device.hwndWindow ?? 0).toString();
                emit(out);
                Logger.log(LogCategory.SYSTEM, `mciSendString status: ${this.describeMciDevice(device)} item="${item}" -> "${out}"`);
            }
            return MMSYSERR_NOERROR;
        }

        if (verb === "window") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            const handleIdx = tokens.findIndex((t) => t.toLowerCase() === "handle");
            if (handleIdx >= 0 && handleIdx + 1 < tokens.length) {
                device.hwndWindow = parseInt(tokens[handleIdx + 1], 0) >>> 0;
                Logger.log(LogCategory.SYSTEM, `mciSendString window: ${device.alias} hwnd=0x${device.hwndWindow.toString(16)}`);
            }
            return MMSYSERR_NOERROR;
        }

        if (verb === "put") {
            if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
            const device = this.findMciDevice(tokens[1]);
            if (!device) return MCIERR_INVALID_DEVICE_NAME;
            const atIdx = tokens.findIndex((t) => t.toLowerCase() === "at");
            if (atIdx >= 0 && atIdx + 4 < tokens.length) {
                device.windowRect = {
                    x: parseInt(tokens[atIdx + 1], 10) | 0,
                    y: parseInt(tokens[atIdx + 2], 10) | 0,
                    w: parseInt(tokens[atIdx + 3], 10) | 0,
                    h: parseInt(tokens[atIdx + 4], 10) | 0,
                };
            }
            return MMSYSERR_NOERROR;
        }

        return MCIERR_UNRECOGNIZED_COMMAND;
    }

    /** String-interface transport + status verbs for a cdaudio device. */
    private handleCdAudioString(
        device: MCIDevice,
        verb: string,
        tokens: string[],
        lower: string[],
        hwndCallback: number,
        emit: (value: string) => void,
    ): number {
        const cd = virtualCd();
        const format = this.cdTimeFormat(device);

        const parsePosition = (text: string): number | null => {
            const packed = parseMciTimeString(format, text);
            return packed === null ? null : this.cdTimeToMs(device, packed);
        };

        switch (verb) {
            case "play": {
                if (!cd.hasMedia()) return MCIERR_DEVICE_NOT_READY;
                const notify = lower.includes("notify");
                if (notify) this.resolveMciNotifyHwnd(device, hwndCallback);

                let fromMs = cd.positionMs();
                const fromIdx = lower.indexOf("from");
                if (fromIdx >= 0 && fromIdx + 1 < tokens.length) {
                    const parsed = parsePosition(tokens[fromIdx + 1]);
                    if (parsed === null) return MCIERR_BAD_INTEGER;
                    fromMs = parsed;
                }
                let toMs = 0;
                const toIdx = lower.indexOf("to");
                if (toIdx >= 0 && toIdx + 1 < tokens.length) {
                    const parsed = parsePosition(tokens[toIdx + 1]);
                    if (parsed === null) return MCIERR_BAD_INTEGER;
                    toMs = parsed;
                }
                Logger.log(LogCategory.SYSTEM,
                    `MCI cdaudio play (string): ${this.describeMciDevice(device)} ${fromMs}..${toMs}ms notify=${notify ? 1 : 0}`);
                return this.cdBeginPlay(device, fromMs, toMs, notify);
            }

            case "stop":
                this.cdStop(device);
                return MMSYSERR_NOERROR;

            case "pause":
                cd.pause();
                if (cd.getMode() === "paused") device.mode = "paused";
                return MMSYSERR_NOERROR;

            case "resume":
                cd.resume();
                if (cd.getMode() === "playing") device.mode = "playing";
                return MMSYSERR_NOERROR;

            case "seek": {
                if (!cd.hasMedia()) return MCIERR_DEVICE_NOT_READY;
                const toIdx = lower.indexOf("to");
                if (toIdx < 0 || toIdx + 1 >= tokens.length) return MCIERR_MISSING_PARAMETER;
                this.cdStop(device);
                const arg = lower[toIdx + 1];
                if (arg === "start") {
                    cd.seek(0);
                } else if (arg === "end") {
                    cd.seek(cd.discLengthMs());
                } else {
                    const parsed = parsePosition(tokens[toIdx + 1]);
                    if (parsed === null) return MCIERR_BAD_INTEGER;
                    cd.seek(parsed);
                }
                return MMSYSERR_NOERROR;
            }

            case "status":
                return this.cdStatusString(device, tokens, lower, emit);

            default:
                return MCIERR_UNRECOGNIZED_COMMAND;
        }
    }

    private cdStatusString(
        device: MCIDevice,
        tokens: string[],
        lower: string[],
        emit: (value: string) => void,
    ): number {
        // "track <n>" is an argument, not part of the item name — but a trailing
        // "track" (as in "current track") is.
        const words: string[] = [];
        let trackArg = 0;
        for (let i = 2; i < lower.length; i++) {
            const word = lower[i];
            if (word === "wait" || word === "notify") continue;
            if (word === "track" && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
                trackArg = parseInt(tokens[i + 1], 10);
                i++;
                continue;
            }
            words.push(word);
        }

        let item = words.join(" ") || "mode";
        let wantStart = false;
        if (item === "start position") {
            item = "position";
            wantStart = true;
        }

        let numeric: number;
        if (item === "number of tracks") numeric = MCI_STATUS_NUMBER_OF_TRACKS;
        else if (item === "length") numeric = MCI_STATUS_LENGTH;
        else if (item === "position") numeric = MCI_STATUS_POSITION;
        else if (item === "current track") numeric = MCI_STATUS_CURRENT_TRACK;
        else if (item === "mode") numeric = MCI_STATUS_MODE;
        else if (item === "ready") numeric = MCI_STATUS_READY;
        else if (item === "media present") numeric = MCI_STATUS_MEDIA_PRESENT;
        else if (item === "time format") numeric = MCI_STATUS_TIME_FORMAT;
        else if (item.startsWith("type")) numeric = MCI_CDA_STATUS_TYPE_TRACK;
        else return MCIERR_UNRECOGNIZED_KEYWORD;

        const [err, value] = this.cdStatusItem(device, numeric, trackArg, wantStart);
        if (err !== MMSYSERR_NOERROR) return err;

        const format = this.cdTimeFormat(device);
        let out: string;
        switch (numeric) {
            case MCI_STATUS_MODE:
                out = value === MCI_MODE_PLAY ? "playing"
                    : value === MCI_MODE_PAUSE ? "paused"
                        : value === MCI_MODE_NOT_READY ? "not ready" : "stopped";
                break;
            case MCI_STATUS_READY:
            case MCI_STATUS_MEDIA_PRESENT:
                out = value ? "true" : "false";
                break;
            case MCI_STATUS_TIME_FORMAT:
                out = timeFormatName(value);
                break;
            case MCI_CDA_STATUS_TYPE_TRACK:
                out = value === MCI_CDA_TRACK_AUDIO ? "audio" : "other";
                break;
            case MCI_STATUS_LENGTH:
                out = formatMciTimeString(format, value, format === MCI_FORMAT_MILLISECONDS ? 1 : 3);
                break;
            case MCI_STATUS_POSITION:
                out = formatMciTimeString(format, value,
                    format === MCI_FORMAT_MILLISECONDS ? 1 : format === MCI_FORMAT_TMSF ? 4 : 3);
                break;
            default:
                out = (value >>> 0).toString();
                break;
        }
        emit(out);
        Logger.log(LogCategory.SYSTEM,
            `MCI cdaudio status (string): item="${item}" track=${trackArg} -> "${out}"`);
        return MMSYSERR_NOERROR;
    }

    registerExports(exports: Record<string, ThunkImplementation>): void {
        exports["mciGetDeviceIDA"] = (ctx, mem, args) => {
            const lpszDevice = args[0];
            if (!lpszDevice) return 0;

            const deviceName = this.readAnsiString(lpszDevice, 256).trim();
            if (!deviceName) return 0;

            Logger.verbose(LogCategory.SYSTEM, `mciGetDeviceIDA: device="${deviceName}"`);

            // A pure query: mciGetDeviceID returns 0 for a device that is not open. It
            // must not open one as a side effect — a title using `mciGetDeviceID(...) == 0`
            // as its "no CD support" test would never take that branch, and the phantom
            // device it created is never closed.
            const existing = this.findMciDevice(deviceName);
            return existing ? existing.id : 0;
        };

        exports["mciSendCommandA"] = (ctx, mem, args) => {
            const deviceId = args[0];
            const uMsg = args[1];
            const fdwCommand = args[2];
            const dwParam = args[3];

            Logger.log(LogCategory.SYSTEM, `mciSendCommandA: device=${deviceId}, msg=0x${uMsg.toString(16)}, cmd=0x${fdwCommand.toString(16)}, param=0x${dwParam.toString(16)}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (uMsg === MCI_OPEN) {
                // MCI_OPEN_PARMS: +0 dwCallback, +4 wDeviceID, +8 lpstrDeviceType,
                // +12 lpstrElementName, +16 lpstrAlias
                let alias = "";
                let elementName = "";
                let deviceType = "";
                if (dwParam) {
                    const typeField = view.getUint32(dwParam + 8, true) >>> 0;
                    const elemPtr = view.getUint32(dwParam + 12, true);
                    const aliasPtr = view.getUint32(dwParam + 16, true);
                    if (fdwCommand & MCI_OPEN_TYPE_ID) {
                        // lpstrDeviceType carries a MCI_DEVTYPE_* id in its low word, not a pointer.
                        deviceType = mciDeviceTypeName(typeField & 0xFFFF);
                    } else if (typeField) {
                        deviceType = this.readAnsiString(typeField, 256);
                    }
                    if (elemPtr) elementName = this.readAnsiString(elemPtr, 512);
                    if (aliasPtr) alias = this.readAnsiString(aliasPtr, 256);
                }
                const resolvedType = this.normalizeMciText(deviceType)
                    || this.inferMciDeviceType(elementName)
                    || "avivideo";
                const openName = alias || resolvedType;
                // Same one-device rule as the string interface: a simple device opened
                // by type has nothing to distinguish a second instance from the first.
                const simpleReopen = !elementName && MCI_SIMPLE_DEVICE_TYPES.has(resolvedType);
                const already = (alias || simpleReopen) ? this.findMciDevice(openName) : null;
                if (already) {
                    // Real MCI refuses and hands back the id that is already open.
                    if (dwParam) view.setUint32(dwParam + 4, already.id, true);
                    return alias ? MCIERR_DUPLICATE_ALIAS : MCIERR_DEVICE_OPEN;
                }
                const device = this.createMciDevice(openName, openName);
                device.elementName = elementName;
                device.deviceType = resolvedType;
                if (dwParam) {
                    view.setUint32(dwParam + 4, device.id, true);
                }
                Logger.log(LogCategory.SYSTEM,
                    `mciSendCommandA MCI_OPEN: ${this.describeMciDevice(device)}`);
                if (this.isMciCdAudioDevice(device)) {
                    this.openCdAudioDevice(device);
                } else {
                    this.preloadMciVideoDevice(device);
                }
                return MMSYSERR_NOERROR;
            }

            const device = deviceId !== 0 ? this.mciDevices.get(deviceId) : undefined;

            if (device && this.isMciCdAudioDevice(device)) {
                return this.handleCdAudioCommand(device, uMsg, fdwCommand, dwParam, view);
            }

            if (uMsg === MCI_WINDOW && device) {
                if (dwParam && (fdwCommand & MCI_ANIM_WINDOW_HWND)) {
                    const hwnd = view.getUint32(dwParam + 4, true);
                    device.hwndWindow = hwnd;
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_WINDOW: device=${deviceId} hwnd=0x${hwnd.toString(16)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_PUT && device && dwParam) {
                if (fdwCommand & MCI_ANIM_PUT_DESTINATION) {
                    device.windowRect = {
                        x: view.getInt32(dwParam + 4, true),
                        y: view.getInt32(dwParam + 8, true),
                        w: view.getInt32(dwParam + 12, true) - view.getInt32(dwParam + 4, true),
                        h: view.getInt32(dwParam + 16, true) - view.getInt32(dwParam + 8, true),
                    };
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_PUT destination: device=${deviceId} rect=${JSON.stringify(device.windowRect)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_STATUS && device && dwParam) {
                if (fdwCommand & MCI_STATUS_ITEM) {
                    const item = view.getUint32(dwParam + 8, true);
                    if (item === MCI_STATUS_READY) {
                        const ready = this.isMciVideoReady(device) ? 1 : 0;
                        view.setUint32(dwParam + 4, ready, true);
                    } else if (item === MCI_STATUS_MODE) {
                        const mode = device.mode === "playing"
                            ? MCI_MODE_PLAY
                            : device.mode === "paused"
                                ? MCI_MODE_PAUSE
                                : MCI_MODE_STOP;
                        view.setUint32(dwParam + 4, mode, true);
                    }
                }
                if (fdwCommand & MCI_ANIM_STATUS_HWND && dwParam) {
                    view.setUint32(dwParam + 4, device.hwndWindow ?? 0, true);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_BREAK && device) {
                if (dwParam) {
                    const virtKey = view.getUint32(dwParam + 4, true);
                    const breakHwnd = view.getUint32(dwParam + 8, true);
                    device.breakKey = virtKey;
                    device.breakHwnd = breakHwnd;
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_BREAK: ${this.describeMciDevice(device)} key=0x${virtKey.toString(16)} hwnd=0x${breakHwnd.toString(16)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_PLAY) {
                // MCI_PLAY_PARMS layout:
                //   +0: DWORD_PTR dwCallback
                //   +4: DWORD dwFrom
                //   +8: DWORD dwTo
                if (!device) {
                    return deviceId !== 0 ? MCIERR_INVALID_DEVICE_ID : MMSYSERR_NOERROR;
                }
                const notifyRequested = (fdwCommand & MCI_NOTIFY) !== 0;
                const hwndCallback = notifyRequested && dwParam ? view.getUint32(dwParam, true) : 0;
                const waitForCompletion = (fdwCommand & MCI_WAIT) !== 0;
                return this.startMciPlayback(
                    device,
                    notifyRequested,
                    hwndCallback,
                    "mciSendCommandA MCI_PLAY",
                    waitForCompletion,
                    16,
                );
            }

            if (uMsg === MCI_STOP || uMsg === MCI_CLOSE) {
                if (device) {
                    this.stopMciPlayback(device, `mciSendCommandA ${uMsg === MCI_STOP ? 'MCI_STOP' : 'MCI_CLOSE'}`);
                } else {
                    Logger.log(LogCategory.SYSTEM, `mciSendCommandA ${uMsg === MCI_STOP ? 'MCI_STOP' : 'MCI_CLOSE'}: device=${deviceId}`);
                }
                if (uMsg === MCI_CLOSE && deviceId !== 0 && device) {
                    this.mciDevices.delete(deviceId);
                    this.mciAliases.delete(device.alias.toLowerCase());
                }
                return MMSYSERR_NOERROR;
            }

            // Unknown command - return success (stub)
            if (deviceId !== 0 && !this.mciDevices.has(deviceId)) {
                return MCIERR_INVALID_DEVICE_ID;
            }
            return MMSYSERR_NOERROR;
        };

        exports["mciSendStringA"] = (ctx, mem, args) => {
            const lpszCommand = args[0];
            const lpstrReturnString = args[1];
            const cchReturn = args[2] >>> 0;
            const hwndCallback = args[3] >>> 0;

            if (!lpszCommand) return MCIERR_MISSING_COMMAND_STRING;
            return this.sendMciString(
                this.readAnsiString(lpszCommand, 1024),
                hwndCallback,
                (value) => {
                    if (lpstrReturnString && cchReturn > 0) {
                        this.writeAnsiString(lpstrReturnString, cchReturn, value);
                    }
                },
            );
        };

        exports["mciSendStringW"] = (ctx, mem, args) => {
            const lpszCommand = args[0];
            const lpstrReturnString = args[1];
            const cchReturn = args[2] >>> 0;
            const hwndCallback = args[3] >>> 0;

            if (!lpszCommand) return MCIERR_MISSING_COMMAND_STRING;
            return this.sendMciString(
                this.readWideString(lpszCommand, 1024),
                hwndCallback,
                (value) => {
                    if (lpstrReturnString && cchReturn > 0) {
                        this.writeWideString(lpstrReturnString, cchReturn, value);
                    }
                },
            );
        };

        exports["mciGetErrorStringA"] = (ctx, mem, args) => {
            const fdwError = args[0];
            const lpszErrorText = args[1];
            const cchErrorText = args[2];

            if (!lpszErrorText || cchErrorText === 0) return MMSYSERR_ERROR;

            const known: Record<number, string> = {
                [MMSYSERR_NOERROR]: "No error",
                [MCIERR_INVALID_DEVICE_ID]: "Invalid device ID",
                [MCIERR_UNRECOGNIZED_KEYWORD]: "Unrecognized keyword",
                [MCIERR_INVALID_DEVICE_NAME]: "Invalid device name",
                [MCIERR_UNRECOGNIZED_COMMAND]: "Unrecognized command",
                [MCIERR_MISSING_COMMAND_STRING]: "Missing command string",
                [MCIERR_MISSING_STRING_ARGUMENT]: "Missing string argument",
                [MCIERR_BAD_INTEGER]: "The specified parameter is not a valid integer.",
                [MCIERR_MISSING_PARAMETER]: "Missing parameter",
                [MCIERR_UNSUPPORTED_FUNCTION]: "The device does not support this function.",
                [MCIERR_DEVICE_NOT_READY]: "The device is not ready.",
                [MCIERR_OUTOFRANGE]: "The specified parameter is out of range.",
                [MCIERR_DUPLICATE_ALIAS]: "Duplicate alias",
                [MCIERR_BAD_TIME_FORMAT]: "The specified time format is not valid.",
                [MCIERR_NULL_PARAMETER_BLOCK]: "A null parameter block was passed to MCI.",
            };
            const errorMsg = known[fdwError] ?? `MCI Error ${fdwError}`;
            if (!this.writeAnsiString(lpszErrorText, cchErrorText, errorMsg)) {
                return MMSYSERR_ERROR;
            }

            Logger.verbose(LogCategory.SYSTEM, `mciGetErrorStringA: error=${fdwError}`);
            return 1; // TRUE
        };
    }

    reset(): void {
        if (this.cdListener) {
            virtualCd().removeCompletionListener(this.cdListener);
            this.cdListener = null;
        }
        virtualCd().reset();
        this.mciDevices.clear();
        this.mciAliases.clear();
    }

    /** Diagnostic snapshot for paint-time guest-state logging. */
    formatMciDiagnosticSnapshot(): string {
        const cd = virtualCd().formatDiagnosticSnapshot();
        if (this.mciDevices.size === 0) return `mci=none ${cd}`;
        const parts: string[] = [];
        for (const d of this.mciDevices.values()) {
            parts.push(
                `id=${d.id} type="${d.deviceType ?? ''}" mode=${d.mode} file="${d.elementName ?? ''}" ` +
                `engine=${d.videoEngineHandle ?? 0} inFlight=${d.videoStartInFlight ? 1 : 0} ` +
                `notify=${d.videoNotifyRequested ? 1 : 0}`,
            );
        }
        return `mci=[${parts.join('; ')}] ${cd}`;
    }
}

export function registerWinmmMciExports(
    exports: Record<string, ThunkImplementation>,
    host: WinmmMciHost,
): WinmmMci {
    const mci = new WinmmMci(host);
    mci.registerExports(exports);
    return mci;
}
