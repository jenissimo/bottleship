/**
 * BASS.dll — BASS 1.x audio library HLE module.
 *
 * Implements the subset of the BASS audio API used by Alawar casual games.
 * Music/SFX are played via audio_play_encoded with runtime format detection.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { System } from "../core/system";
import { Logger, LogCategory, LogLevel } from "../core/logger";
import { fpuPush } from "../core/fpu-helper";
import { getCPU } from "../core/thunking/thunk-utils";
import { BufferSource } from "@bottleship/formats/unpack/source";
import { probeAudio, sniffAudioContainer } from "@bottleship/formats/audio";

// BASS_ACTIVE constants
const BASS_ACTIVE_STOPPED  = 0;
const BASS_ACTIVE_PLAYING  = 1;
const BASS_ACTIVE_STALLED  = 2;
const BASS_ACTIVE_PAUSED   = 3;
const BASS_SAMPLE_LOOP = 0x4;
const BASS_STREAM_DECODE = 0x200000;

// BASS error codes (unused in thunk returns but documented)
const BASS_OK = 0;

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------
interface BASSStream {
    id: number;
    handle: number;
    fileData: Uint8Array;
    mimeType: string;
    flags: number;
    isPlaying: boolean;
    isPaused: boolean;
    volume: number;     // 0-100
    pan: number;        // -100..100
    frequency: number;  // Hz
    nativeFrequency: number; // source/native Hz
    loop: boolean;
    startTime: number;
    length: number;     // file size in bytes
    decodeCursor: number;
}

interface BASSSample {
    id: number;
    handle: number;
    fileData: Uint8Array;
    mimeType: string;
    flags: number;
    frequency: number;
    nativeFrequency: number; // source/native Hz
    volume: number;     // 0-100
    pan: number;        // -100..100
    maxPlaybacks: number;
    length: number;     // file size in bytes
}

interface DetectedAudioPayload {
    payload: Uint8Array;
    mimeType: string;
    sampleRate: number;
}

// BASS_SAMPLE struct layout (for GetInfo/SetInfo) — 36 bytes
const BSI_FREQ    = 0;   // DWORD freq
const BSI_VOLUME  = 4;   // DWORD volume (0-100)
const BSI_PAN     = 8;   // int pan (-100..100)
const BSI_FLAGS   = 12;  // DWORD flags
const BSI_LENGTH  = 16;  // DWORD length
const BSI_MAX     = 20;  // DWORD max playbacks
const BSI_ORIGRES = 24;  // DWORD original resolution
const BSI_CHANS   = 28;  // DWORD channels
// const BSI_SIZE = 32;

// BASS_CHANNELINFO struct — 32 bytes minimum
const BCI_FREQ    = 0;   // DWORD freq
const BCI_CHANS   = 4;   // DWORD chans
const BCI_FLAGS   = 8;   // DWORD flags
const BCI_CTYPE   = 12;  // DWORD ctype (0x10002 = OGG)

// ===========================================================================
export class Bass implements IModule {
    name = "bass";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    private nextId = 0xB0000;
    private streams = new Map<number, BASSStream>();
    private samples = new Map<number, BASSSample>();
    /** Active sample-play channels (channelId → audioId + state for stop/query) */
    private sampleChannels = new Map<number, { audioId: number; isPlaying: boolean; loop: boolean }>();
    private samplePayloadCache = new Map<string, DetectedAudioPayload>();
    private defaultFreq = 44100;
    private globalPaused = false;

    private allocId(): number { return this.nextId++; }

    initialize(process: Process): void {
        this.process = process;
        const self = this;

        const setQwordReturn = (value: number): number => {
            const low = value >>> 0;
            const high = Math.floor(value / 0x100000000) >>> 0;
            const cpu = getCPU(self.process.v86);
            if (cpu?.reg32) {
                cpu.reg32[2] = high; // EDX high dword
            }
            return low; // EAX low dword
        };

        const bytesPerSecond = (stream: BASSStream): number => {
            return Math.max(1, (stream.frequency | 0) * 2 * 2); // stereo 16-bit
        };

        const createStreamFromPayload = (detected: DetectedAudioPayload, flags: number): number => {
            const id = self.allocId();
            const handle = id;
            self.streams.set(handle, {
                id,
                handle,
                fileData: detected.payload,
                mimeType: detected.mimeType,
                flags: flags >>> 0,
                isPlaying: false,
                isPaused: false,
                volume: 100,
                pan: 0,
                frequency: detected.sampleRate || self.defaultFreq,
                nativeFrequency: detected.sampleRate || self.defaultFreq,
                loop: (flags & BASS_SAMPLE_LOOP) !== 0,
                startTime: 0,
                length: detected.payload.byteLength,
                decodeCursor: 0,
            });
            return handle;
        };

        const createSampleFromPayload = (detected: DetectedAudioPayload, maxPlaybacks: number, flags: number): number => {
            const id = self.allocId();
            const handle = id;
            self.samples.set(handle, {
                id,
                handle,
                fileData: detected.payload,
                mimeType: detected.mimeType,
                flags: flags >>> 0,
                frequency: detected.sampleRate || self.defaultFreq,
                nativeFrequency: detected.sampleRate || self.defaultFreq,
                volume: 100,
                pan: 0,
                maxPlaybacks: maxPlaybacks || 1,
                length: detected.payload.byteLength,
            });
            return handle;
        };

        // ---------------------------------------------------------------
        // BASS_Init / BASS_Free
        // ---------------------------------------------------------------
        this.exports["BASS_Init"] = (_ctx, _mem, args) => {
            const device = args[0];
            const freq   = args[1];
            const flags  = args[2];
            // const win  = args[3];
            // const clsid= args[4];

            self.defaultFreq = freq || 44100;
            Logger.log(LogCategory.SYSTEM, `BASS_Init(device=${device}, freq=${freq}, flags=0x${flags.toString(16)})`);
            return 1; // TRUE
        };

        this.exports["BASS_Free"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "BASS_Free");
            // Stop all audio
            for (const stream of self.streams.values()) {
                if (stream.isPlaying) {
                    self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
                }
            }
            for (const sch of self.sampleChannels.values()) {
                if (sch.isPlaying) {
                    self.postMessage({ type: "audio_stop", payload: { id: sch.audioId } });
                }
            }
            self.streams.clear();
            self.samples.clear();
            self.sampleChannels.clear();
            self.samplePayloadCache.clear();
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_StreamCreateFile (async — file I/O)
        // ---------------------------------------------------------------
        this.exports["BASS_StreamCreateFile"] = (_ctx, mem, args) => {
            const isMem    = args[0];
            const fileArg  = args[1]; // string ptr or memory ptr
            const offset   = args[2];
            const length   = args[3];
            const flags    = args[4];

            if (isMem) {
                // Memory-based stream — copy data from guest memory
                const dataLen = length || 0;
                if (!fileArg || dataLen <= 0) return 0;
                const rawData = new Uint8Array(mem.buffer, mem.byteOffset + fileArg + offset, dataLen).slice();
                const detected = self.detectAudioPayload(rawData);
                const handle = createStreamFromPayload(detected, flags);
                Logger.log(LogCategory.SYSTEM, `BASS_StreamCreateFile(mem, ${dataLen}b) -> 0x${handle.toString(16)}`);
                return handle;
            }

            // File-based stream
            const filename = Marshaler.readString(mem, fileArg);
            Logger.log(LogCategory.SYSTEM, `BASS_StreamCreateFile("${filename}", offset=${offset}, len=${length}, flags=0x${flags.toString(16)})`);
            const normalized = filename.replace(/\\/g, "/");
            const cacheKey = normalized.toLowerCase();
            const cachedPayload = self.samplePayloadCache.get(cacheKey);
            if (cachedPayload) {
                const handle = createStreamFromPayload(cachedPayload, flags);
                Logger.log(
                    LogCategory.SYSTEM,
                    `BASS_StreamCreateFile -> 0x${handle.toString(16)} (${cachedPayload.payload.byteLength}b, mime=${cachedPayload.mimeType}, freq=${cachedPayload.sampleRate || self.defaultFreq}) [cache]`
                );
                return handle;
            }

            return (async (): Promise<number> => {
                try {
                    const fileData = await self.readFileFromVfs(normalized);
                    if (!fileData) {
                        Logger.warn(LogCategory.SYSTEM, `BASS_StreamCreateFile: not found "${normalized}"`);
                        return 0;
                    }
                    const detected = self.detectAudioPayload(fileData, normalized);
                    self.samplePayloadCache.set(cacheKey, detected);
                    const handle = createStreamFromPayload(detected, flags);

                    Logger.log(
                        LogCategory.SYSTEM,
                        `BASS_StreamCreateFile -> 0x${handle.toString(16)} (${detected.payload.byteLength}b, mime=${detected.mimeType}, freq=${detected.sampleRate || self.defaultFreq})`
                    );
                    return handle;
                } catch (e) {
                    Logger.error(LogCategory.SYSTEM, `BASS_StreamCreateFile failed: ${e}`);
                    return 0;
                }
            })();
        };

        // ---------------------------------------------------------------
        // BASS_StreamPlay
        // ---------------------------------------------------------------
        this.exports["BASS_StreamPlay"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const flush  = args[1];
            const flags  = args[2];

            const stream = self.streams.get(handle);
            if (!stream) return 0;

            if ((stream.flags & BASS_STREAM_DECODE) !== 0) {
                // Decode streams are not playable channels.
                return 0;
            }

            stream.loop = (flags & BASS_SAMPLE_LOOP) !== 0;

            self.playEncoded(stream);
            Logger.log(LogCategory.SYSTEM, `BASS_StreamPlay(0x${handle.toString(16)}, flush=${flush}, flags=0x${flags.toString(16)})`);
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_StreamFree
        // ---------------------------------------------------------------
        this.exports["BASS_StreamFree"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const stream = self.streams.get(handle);
            if (!stream) return 0;

            if (stream.isPlaying) {
                self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
            }
            self.streams.delete(handle);
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_StreamGetLength
        // ---------------------------------------------------------------
        this.exports["BASS_StreamGetLength"] = (_ctx, _mem, args) => {
            const stream = self.streams.get(args[0]);
            return setQwordReturn(stream ? stream.length : 0);
        };

        // ---------------------------------------------------------------
        // BASS_ChannelSetAttributes
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelSetAttributes"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const freq   = args[1] | 0; // signed, -1 = don't change
            const volume = args[2] | 0; // signed, -1 = don't change
            const pan    = args[3] | 0; // signed, -101 = don't change

            const stream = self.streams.get(handle);
            if (!stream) return 0;

            if (freq !== -1 && freq > 0)    stream.frequency = freq;
            if (volume !== -1 && volume >= 0) stream.volume = Math.min(100, volume);
            if ((pan | 0) !== -101)          stream.pan = Math.max(-100, Math.min(100, pan));

            // Update if currently playing
            if (stream.isPlaying) {
                self.postMessage({
                    type: "audio_update",
                    payload: {
                        id: stream.id,
                        volume: stream.volume / 100,
                        pan: stream.pan / 100,
                        playbackRate: self.computePlaybackRate(stream.frequency, stream.nativeFrequency),
                        playbackRateHz: stream.frequency,
                    }
                });
            }

            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_ChannelStop
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelStop"] = (_ctx, _mem, args) => {
            const handle = args[0];

            // Check sample channels first
            const sch = self.sampleChannels.get(handle);
            if (sch) {
                if (sch.isPlaying) {
                    self.postMessage({ type: "audio_stop", payload: { id: sch.audioId } });
                }
                sch.isPlaying = false;
                return 1;
            }

            const stream = self.streams.get(handle);
            if (!stream) return 1;

            if ((stream.flags & BASS_STREAM_DECODE) !== 0) {
                stream.decodeCursor = stream.length;
                return 1;
            }

            if (stream.isPlaying) {
                self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
            }
            stream.isPlaying = false;
            stream.isPaused = false;
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_ChannelGetPosition
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelGetPosition"] = (_ctx, _mem, args) => {
            const stream = self.streams.get(args[0]);
            if (!stream) return setQwordReturn(0);

            if ((stream.flags & BASS_STREAM_DECODE) !== 0) {
                return setQwordReturn(stream.decodeCursor >>> 0);
            }

            if (!stream.isPlaying) return setQwordReturn(0);

            // Estimate byte position from elapsed time
            const elapsed = (performance.now() - stream.startTime) / 1000;
            return setQwordReturn(Math.floor(elapsed * bytesPerSecond(stream)) >>> 0);
        };

        // ---------------------------------------------------------------
        // BASS_ChannelGetData
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelGetData"] = (_ctx, mem, args) => {
            const stream = self.streams.get(args[0]);
            const bufferPtr = args[1] >>> 0;
            const requested = args[2] >>> 0;
            if (!stream || bufferPtr === 0 || requested === 0) return 0;

            if ((stream.flags & BASS_STREAM_DECODE) === 0) {
                return 0;
            }

            const available = stream.length - stream.decodeCursor;
            if (available <= 0) return 0;

            const toCopy = Math.min(requested, available);
            if (bufferPtr + toCopy > mem.length) return 0;

            // Minimal decode compatibility: expose deterministic bytes and finish cleanly.
            mem.set(stream.fileData.subarray(stream.decodeCursor, stream.decodeCursor + toCopy), bufferPtr);
            stream.decodeCursor += toCopy;
            return toCopy >>> 0;
        };

        // ---------------------------------------------------------------
        // BASS_ChannelIsActive
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelIsActive"] = (_ctx, _mem, args) => {
            // Check sample channels
            const sch = self.sampleChannels.get(args[0]);
            if (sch) return sch.isPlaying ? BASS_ACTIVE_PLAYING : BASS_ACTIVE_STOPPED;

            const stream = self.streams.get(args[0]);
            if (!stream) return BASS_ACTIVE_STOPPED;
            if ((stream.flags & BASS_STREAM_DECODE) !== 0) {
                return stream.decodeCursor < stream.length ? BASS_ACTIVE_PLAYING : BASS_ACTIVE_STOPPED;
            }
            if (stream.isPaused) return BASS_ACTIVE_PAUSED;
            if (stream.isPlaying) return BASS_ACTIVE_PLAYING;
            return BASS_ACTIVE_STOPPED;
        };

        // ---------------------------------------------------------------
        // BASS_ChannelGetInfo
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelGetInfo"] = (_ctx, mem, args) => {
            const stream = self.streams.get(args[0]);
            const pInfo = args[1];
            if (!stream || !pInfo) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pInfo + BCI_FREQ, stream.frequency, true);
            view.setUint32(pInfo + BCI_CHANS, 2, true); // stereo
            const infoFlags = (stream.flags | (stream.loop ? BASS_SAMPLE_LOOP : 0)) >>> 0;
            view.setUint32(pInfo + BCI_FLAGS, infoFlags, true);
            view.setUint32(pInfo + BCI_CTYPE, 0x10002, true); // BASS_CTYPE_STREAM_OGG
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_ChannelBytes2Seconds
        // ---------------------------------------------------------------
        this.exports["BASS_ChannelBytes2Seconds"] = (_ctx, _mem, args) => {
            const stream = self.streams.get(args[0]);
            const low = args[1] >>> 0;
            const high = (args[2] ?? 0) >>> 0;
            if (!stream) {
                fpuPush(self.process.v86, 0);
                return 0;
            }

            const bytes = (high * 0x100000000) + low;
            const seconds = bytes / bytesPerSecond(stream);

            // x87 float return ABI: value is returned in ST(0).
            fpuPush(self.process.v86, seconds);
            return 0;
        };

        // ---------------------------------------------------------------
        // BASS_Pause / BASS_Start
        // ---------------------------------------------------------------
        this.exports["BASS_Pause"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "BASS_Pause");
            self.globalPaused = true;
            for (const stream of self.streams.values()) {
                if (stream.isPlaying) {
                    self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
                    stream.isPaused = true;
                    stream.isPlaying = false;
                }
            }
            for (const sch of self.sampleChannels.values()) {
                if (sch.isPlaying) {
                    self.postMessage({ type: "audio_stop", payload: { id: sch.audioId } });
                    sch.isPlaying = false;
                }
            }
            return 1;
        };

        this.exports["BASS_Start"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "BASS_Start");
            self.globalPaused = false;
            for (const stream of self.streams.values()) {
                if (stream.isPaused) {
                    self.playEncoded(stream);
                    stream.isPaused = false;
                }
            }
            return 1;
        };

        // ---------------------------------------------------------------
        // BASS_SampleLoad (async — file I/O)
        // ---------------------------------------------------------------
        this.exports["BASS_SampleLoad"] = (_ctx, mem, args) => {
            const isMem  = args[0];
            const fileArg = args[1];
            const offset = args[2];
            const length = args[3];
            const max    = args[4];
            const flags  = args[5] ?? 0;

            let detected: DetectedAudioPayload;
            let sourceHint = "";

            if (isMem) {
                const dataLen = length || 0;
                if (!fileArg || dataLen <= 0) return 0;
                const fileData = new Uint8Array(mem.buffer, mem.byteOffset + fileArg + offset, dataLen).slice();
                detected = self.detectAudioPayload(fileData);
                const handle = createSampleFromPayload(detected, max, flags);
                Logger.log(
                    LogCategory.SYSTEM,
                    `BASS_SampleLoad -> 0x${handle.toString(16)} (${detected.payload.byteLength}b, mime=${detected.mimeType}, freq=${detected.sampleRate || self.defaultFreq}, flags=0x${(flags >>> 0).toString(16)})`
                );
                return handle;
            } else {
                const filename = Marshaler.readString(mem, fileArg);
                sourceHint = filename.replace(/\\/g, "/");
                const cacheKey = sourceHint.toLowerCase();
                const cachedPayload = self.samplePayloadCache.get(cacheKey);
                if (cachedPayload) {
                    detected = cachedPayload;
                    const handle = createSampleFromPayload(detected, max, flags);
                    Logger.log(
                        LogCategory.SYSTEM,
                        `BASS_SampleLoad -> 0x${handle.toString(16)} (${detected.payload.byteLength}b, mime=${detected.mimeType}, freq=${detected.sampleRate || self.defaultFreq}, flags=0x${(flags >>> 0).toString(16)}) [cache]`
                    );
                    return handle;
                } else {
                    if (Logger.isEnabled(LogCategory.SYSTEM, LogLevel.VERBOSE)) {
                        Logger.verbose(LogCategory.SYSTEM, `BASS_SampleLoad("${filename}", max=${max}, flags=0x${(flags >>> 0).toString(16)})`);
                    }
                    return (async (): Promise<number> => {
                        const fileData = await self.readFileFromVfs(sourceHint);
                        if (!fileData) {
                            Logger.warn(LogCategory.SYSTEM, `BASS_SampleLoad: not found "${sourceHint}"`);
                            return 0;
                        }
                        const loaded = self.detectAudioPayload(fileData, sourceHint);
                        self.samplePayloadCache.set(cacheKey, loaded);
                        const handle = createSampleFromPayload(loaded, max, flags);
                        Logger.log(
                            LogCategory.SYSTEM,
                            `BASS_SampleLoad -> 0x${handle.toString(16)} (${loaded.payload.byteLength}b, mime=${loaded.mimeType}, freq=${loaded.sampleRate || self.defaultFreq}, flags=0x${(flags >>> 0).toString(16)})`
                        );
                        return handle;
                    })();
                }
            }
        };

        // ---------------------------------------------------------------
        // BASS_SamplePlay
        // ---------------------------------------------------------------
        this.exports["BASS_SamplePlay"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const sample = self.samples.get(handle);
            if (!sample) return 0;

            // Create a tracked channel to play the sample using its default flags
            const channelId = self.allocId();
            const loop = (sample.flags & BASS_SAMPLE_LOOP) !== 0;
            self.sampleChannels.set(channelId, { audioId: channelId, isPlaying: true, loop });
            self.playSampleEncoded(sample, channelId, sample.frequency, sample.volume, sample.pan, loop);
            return channelId;
        };

        // ---------------------------------------------------------------
        // BASS_SamplePlayEx
        // ---------------------------------------------------------------
        this.exports["BASS_SamplePlayEx"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const start  = args[1]; // start position (ignored for encoded)
            const freq   = args[2] | 0; // -1 = default
            const volume = args[3] | 0; // -1 = default (100)
            const pan    = args[4] | 0; // -101 = default (0)
            const loopArg = args[5] | 0; // BOOL; -1 = use sample default

            const sample = self.samples.get(handle);
            if (!sample) return 0;

            const useFreq = (freq === -1 || freq <= 0) ? sample.frequency : freq;
            const useVol  = (volume === -1) ? sample.volume : Math.min(100, Math.max(0, volume));
            const usePan  = ((pan | 0) === -101) ? sample.pan : Math.max(-100, Math.min(100, pan));
            // BASS 1.x: loop=-1 means "use sample's default loop flag"
            const useLoop = loopArg === -1
                ? (sample.flags & BASS_SAMPLE_LOOP) !== 0
                : loopArg !== 0;

            const channelId = self.allocId();
            self.sampleChannels.set(channelId, { audioId: channelId, isPlaying: true, loop: useLoop });
            self.playSampleEncoded(sample, channelId, useFreq, useVol, usePan, useLoop);
            return channelId;
        };

        // ---------------------------------------------------------------
        // BASS_SampleGetInfo / BASS_SampleSetInfo
        // ---------------------------------------------------------------
        this.exports["BASS_SampleGetInfo"] = (_ctx, mem, args) => {
            const handle = args[0];
            const pInfo  = args[1];
            const sample = self.samples.get(handle);
            if (!sample || !pInfo) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pInfo + BSI_FREQ, sample.frequency, true);
            view.setUint32(pInfo + BSI_VOLUME, sample.volume, true);
            view.setInt32(pInfo + BSI_PAN, sample.pan, true);
            view.setUint32(pInfo + BSI_FLAGS, 0, true);
            view.setUint32(pInfo + BSI_LENGTH, sample.length, true);
            view.setUint32(pInfo + BSI_MAX, sample.maxPlaybacks, true);
            view.setUint32(pInfo + BSI_ORIGRES, 16, true); // 16-bit
            view.setUint32(pInfo + BSI_CHANS, 2, true);     // stereo
            return 1;
        };

        this.exports["BASS_SampleSetInfo"] = (_ctx, mem, args) => {
            const handle = args[0];
            const pInfo  = args[1];
            const sample = self.samples.get(handle);
            if (!sample || !pInfo) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            sample.frequency = view.getUint32(pInfo + BSI_FREQ, true);
            sample.volume = view.getUint32(pInfo + BSI_VOLUME, true);
            sample.pan = view.getInt32(pInfo + BSI_PAN, true);
            sample.maxPlaybacks = view.getUint32(pInfo + BSI_MAX, true);
            return 1;
        };
    }

    private async readFileFromVfs(path: string): Promise<Uint8Array | null> {
        try {
            const system = System.getInstance();
            const vfs = system.fileSystem;
            const normalized = path.replace(/\\/g, "/");
            const access = 0x80000000;
            const disposition = 3; // OPEN_EXISTING

            const syncHandle = vfs.openSync(normalized, access, disposition);
            const handle = syncHandle ?? await vfs.open(normalized, access, disposition);
            if (!handle) return null;

            const fileSize = vfs.getFileSize(handle.path);
            const syncData = vfs.readSync(handle, fileSize);
            if (syncData !== null) return syncData;
            return await vfs.read(handle, fileSize);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `BASS: readFileFromVfs("${path}") failed: ${e}`);
            return null;
        }
    }

    private computePlaybackRate(freq: number, nativeFreq: number): number {
        if (freq <= 0) return 1;
        const base = nativeFreq > 0 ? nativeFreq : this.defaultFreq;
        const rate = freq / Math.max(1, base);
        return Math.max(0.01, Math.min(16, rate));
    }

    private detectAudioPayload(
        fileData: Uint8Array,
        sourcePath?: string
    ): DetectedAudioPayload {
        const probe = probeAudio(new BufferSource(fileData));

        // A RIFF wrapper around an encoded payload: BASS plays the inner stream, and
        // the inner stream's own header is the only honest source of its rate.
        if (probe?.format === "wav") {
            const dataChunk = fileData.subarray(probe.dataStart, probe.dataEnd);
            const innerSource = new BufferSource(dataChunk);
            const innerFormat = sniffAudioContainer(innerSource);
            if (innerFormat === "ogg" || innerFormat === "mp3") {
                return {
                    payload: dataChunk.slice(),
                    mimeType: innerFormat === "ogg" ? "audio/ogg" : "audio/mpeg",
                    sampleRate: probeAudio(innerSource)?.sampleRate || probe.sampleRate || this.defaultFreq,
                };
            }
            return { payload: fileData, mimeType: "audio/wav", sampleRate: probe.sampleRate || this.defaultFreq };
        }

        if (probe?.format === "ogg") {
            return { payload: fileData, mimeType: "audio/ogg", sampleRate: probe.sampleRate || this.defaultFreq };
        }
        if (probe?.format === "mp3") {
            return { payload: fileData, mimeType: "audio/mpeg", sampleRate: probe.sampleRate || this.defaultFreq };
        }

        // Recognized magic but unparseable headers still names the decoder to hand it to;
        // a bare extension is the last resort, for a file whose header we cannot read at all.
        const ext = sniffAudioContainer(new BufferSource(fileData)) ?? sourcePath?.split(".").pop()?.toLowerCase();
        if (ext === "wav") {
            return { payload: fileData, mimeType: "audio/wav", sampleRate: this.defaultFreq };
        }
        if (ext === "mp3") {
            return { payload: fileData, mimeType: "audio/mpeg", sampleRate: this.defaultFreq };
        }
        if (ext === "ogg") {
            return { payload: fileData, mimeType: "audio/ogg", sampleRate: this.defaultFreq };
        }

        return { payload: fileData, mimeType: "application/octet-stream", sampleRate: this.defaultFreq };
    }

    // -----------------------------------------------------------------------
    // Helper: play audio payload via main thread AudioEngine
    // -----------------------------------------------------------------------
    private playEncoded(stream: BASSStream): void {
        const payloadData = stream.fileData.slice();
        self.postMessage({
            type: "audio_play_encoded",
            payload: {
                id: stream.id,
                data: payloadData,
                mimeType: stream.mimeType,
                playbackRate: this.computePlaybackRate(stream.frequency, stream.nativeFrequency),
                playbackRateHz: stream.frequency,
                volume: stream.volume / 100,
                pan: stream.pan / 100,
                loopCount: stream.loop ? 0 : 1, // 0 = loop forever in MSS convention
            }
        } as any, [payloadData.buffer] as any);

        stream.isPlaying = true;
        stream.isPaused = false;
        stream.startTime = performance.now();
    }

    private playSampleEncoded(sample: BASSSample, channelId: number, freq: number, vol: number, pan: number, loop: boolean): void {
        const payloadData = sample.fileData.slice();
        self.postMessage({
            type: "audio_play_encoded",
            payload: {
                id: channelId,
                data: payloadData,
                mimeType: sample.mimeType,
                playbackRate: this.computePlaybackRate(freq, sample.nativeFrequency),
                playbackRateHz: freq,
                volume: vol / 100,
                pan: pan / 100,
                loopCount: loop ? 0 : 1,
            }
        } as any, [payloadData.buffer] as any);
    }

    handleAudioEnded(id: number): void {
        // Update stream state
        for (const stream of this.streams.values()) {
            if (stream.id === id) {
                stream.isPlaying = false;
                stream.isPaused = false;
                return;
            }
        }
        // Update sample channel state
        const sch = this.sampleChannels.get(id);
        if (sch) {
            sch.isPlaying = false;
        }
    }

    private postMessage(msg: any, transfer?: Transferable[]): void {
        if (transfer) {
            self.postMessage(msg, transfer as any);
        } else {
            self.postMessage(msg);
        }
    }

    reset(): void {
        for (const stream of this.streams.values()) {
            if (stream.isPlaying) {
                this.postMessage({ type: "audio_stop", payload: { id: stream.id } });
            }
        }
        for (const sch of this.sampleChannels.values()) {
            if (sch.isPlaying) {
                this.postMessage({ type: "audio_stop", payload: { id: sch.audioId } });
            }
        }
        this.streams.clear();
        this.samples.clear();
        this.sampleChannels.clear();
        this.samplePayloadCache.clear();
        this.nextId = 0xB0000;
        this.defaultFreq = 44100;
        this.globalPaused = false;
    }
}
