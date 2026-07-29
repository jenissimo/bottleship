/**
 * OpenAL (wrap_oal.dll) + ALUT (alut.dll) — HLE modules with real WebAudio playback.
 *
 * FBN Engine games (House of 1000 Doors, etc.) use OpenAL for all audio.
 * FBNSound.dll imports wrap_oal.dll and alut.dll.
 *
 * Audio path: alBufferData stores PCM → alSourcePlay creates SAB ring buffer
 * → posts audio_register to main thread → AudioWorklet plays.
 *
 * All OpenAL functions use cdecl calling convention.
 */

import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    getCtrl,
    setCtrlFloat,
    CTRL_STATE,
    CTRL_DATA_LENGTH,
    CTRL_LOOP_MODE,
    CTRL_VOLUME,
    CTRL_FREQUENCY,
    CTRL_STOP_REQUESTED,
    CTRL_FLAGS,
    CTRL_3D_POS_X,
    CTRL_3D_POS_Y,
    CTRL_3D_POS_Z,
    CTRL_3D_FLAGS,
    STATE_PLAYING,
    STATE_PAUSED,
    STATE_STOPPED,
    FLAG_CIRCULAR,
    floatToI32,
} from "../../../audio/audio-ring-buffer";

// ── OpenAL constants ─────────────────────────────────────────────────────────
const AL_NO_ERROR       = 0;
const AL_FALSE          = 0;
const AL_TRUE           = 1;
const ALC_FALSE         = 0;
const ALC_TRUE          = 1;
const ALC_NO_ERROR      = 0;
const ALUT_ERROR_NO_ERROR = 0;

// AL_SOURCE_STATE values
const AL_INITIAL = 0x1011;
const AL_PLAYING = 0x1012;
const AL_PAUSED  = 0x1013;
const AL_STOPPED = 0x1014;

// Source properties
const AL_PITCH          = 0x1003;
const AL_GAIN           = 0x100A;
const AL_MIN_GAIN       = 0x100D;
const AL_MAX_GAIN       = 0x100E;
const AL_MAX_DISTANCE   = 0x1023;
const AL_ROLLOFF_FACTOR = 0x1021;
const AL_REFERENCE_DISTANCE = 0x1020;
const AL_LOOPING        = 0x1007;
const AL_BUFFER         = 0x1009;
const AL_SOURCE_STATE   = 0x1010;
const AL_BUFFERS_QUEUED = 0x1015;
const AL_BUFFERS_PROCESSED = 0x1016;
const AL_SEC_OFFSET     = 0x1024;
const AL_SAMPLE_OFFSET  = 0x1025;
const AL_BYTE_OFFSET    = 0x1026;
const AL_SOURCE_TYPE    = 0x1027;
const AL_POSITION       = 0x1004;
const AL_VELOCITY       = 0x1006;
const AL_DIRECTION      = 0x1005;
const AL_SOURCE_RELATIVE = 0x0202;

// Buffer properties
const AL_FREQUENCY      = 0x2001;
const AL_BITS           = 0x2002;
const AL_CHANNELS       = 0x2003;
const AL_SIZE           = 0x2004;

// Format enums
const AL_FORMAT_MONO8    = 0x1100;
const AL_FORMAT_MONO16   = 0x1101;
const AL_FORMAT_STEREO8  = 0x1102;
const AL_FORMAT_STEREO16 = 0x1103;

// ALC string queries
const ALC_DEFAULT_DEVICE_SPECIFIER    = 0x1004;
const ALC_DEVICE_SPECIFIER            = 0x1005;
const ALC_EXTENSIONS                  = 0x1006;
const ALC_ALL_DEVICES_SPECIFIER       = 0x1013;

// AL string queries
const AL_VENDOR     = 0xB001;
const AL_VERSION    = 0xB002;
const AL_RENDERER   = 0xB003;
const AL_EXTENSIONS = 0xB004;

// ── Internal types ───────────────────────────────────────────────────────────

interface ALBuffer {
    id: number;
    format: number;       // AL_FORMAT_*
    sampleRate: number;
    channels: number;     // 1 or 2
    bitsPerSample: number; // 8 or 16
    data: Uint8Array;     // raw PCM copy
}

interface ALSource {
    id: number;
    state: number;        // AL_INITIAL / AL_PLAYING / AL_PAUSED / AL_STOPPED
    bufferId: number;     // bound static buffer (0 = none)
    gain: number;         // 0.0 .. 1.0+
    pitch: number;        // 0.5 .. 2.0
    looping: boolean;
    posX: number; posY: number; posZ: number;
    relative: boolean;
    // Queue for streaming
    queuedBuffers: number[];
    processedBuffers: number[];
    // Audio worklet registration
    audioId: number;      // 0 = not registered
    sab: SharedArrayBuffer | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fold the worklet's playback state into `src.state` before it is reported.
 *
 * A real OpenAL source that reaches the end of a non-looping buffer transitions to
 * AL_STOPPED on its own; nothing has to call alSourceStop. We only ever WROTE CTRL_STATE,
 * so a source stayed AL_PLAYING for life and every voice looked busy forever — an engine
 * that hunts for a free/finished voice (UE1's ALAudio Update → FindLeastImportantSound)
 * then spins waiting for a state that can never arrive.
 *
 * The worklet stores STATE_STOPPED when it finishes the last loop, so the completion is
 * already published; this reads it back. Looping sources never stop by themselves, and a
 * source with no SAB has no playback to report — both keep their bookkeeping state.
 */
function syncSourceState(src: ALSource): void {
    if (src.state !== AL_PLAYING || !src.sab) return;
    if (getCtrl(src.sab, CTRL_STATE) === STATE_STOPPED) src.state = AL_STOPPED;
}

function writeString(process: Process, str: string): number {
    const bytes = new TextEncoder().encode(str + "\0");
    const ptr = process.memory.alloc(bytes.length, "THUNK_DATA", "rw");
    const mem = process.getCurrentMemory();
    mem.set(bytes, ptr);
    return ptr;
}

/** Convert OpenAL linear gain (0..1+) to DirectSound centibels (-10000..0) */
function gainToCentibels(gain: number): number {
    if (gain <= 0) return -10000;
    if (gain >= 1) return 0;
    return Math.max(-10000, Math.round(2000 * Math.log10(gain)));
}

function formatChannels(format: number): number {
    return (format === AL_FORMAT_STEREO8 || format === AL_FORMAT_STEREO16) ? 2 : 1;
}

function formatBits(format: number): number {
    return (format === AL_FORMAT_MONO16 || format === AL_FORMAT_STEREO16) ? 16 : 8;
}

let audioIdCounter = 0x0A000001;

// ── OpenAL Module (wrap_oal.dll) ─────────────────────────────────────────────

export class OpenAL implements IModule {
    name = "wrap_oal";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    // Handle allocators
    private nextDeviceId  = 0xAD000001;
    private nextContextId = 0xAC000001;
    private nextSourceId  = 1;
    private nextBufferId  = 1;

    // State
    private currentContext = 0;
    private currentDevice  = 0;
    private buffers = new Map<number, ALBuffer>();
    private sources = new Map<number, ALSource>();

    // Pre-allocated string pointers
    private stringPtrs = new Map<number, number>();

    initialize(process: Process): void {
        this.process = process;

        // ── ALC (context management) ─────────────────────────────────────

        this.exports["alcOpenDevice"] = (_ctx, _mem, _args) => {
            this.currentDevice = this.nextDeviceId++;
            Logger.log(LogCategory.SYSTEM, `[OpenAL] alcOpenDevice → 0x${this.currentDevice.toString(16)}`);
            return this.currentDevice;
        };

        this.exports["alcCloseDevice"] = () => { return ALC_TRUE; };
        this.exports["alcCreateContext"] = (_ctx, _mem, _args) => {
            this.currentContext = this.nextContextId++;
            return this.currentContext;
        };
        this.exports["alcDestroyContext"] = () => 0;
        this.exports["alcMakeContextCurrent"] = (_ctx, _mem, args) => {
            this.currentContext = args[0];
            return ALC_TRUE;
        };
        this.exports["alcGetCurrentContext"] = () => this.currentContext;
        this.exports["alcGetContextsDevice"] = () => this.currentDevice;
        this.exports["alcProcessContext"] = () => 0;
        this.exports["alcSuspendContext"] = () => 0;
        this.exports["alcGetError"] = () => ALC_NO_ERROR;
        this.exports["alcGetString"] = (_ctx, _mem, args) => this.getAlcString(args[1]);
        this.exports["alcGetIntegerv"] = (_ctx, mem, args) => {
            const [_device, _param, size, dataPtr] = args;
            if (dataPtr && size > 0) {
                const dv = new DataView(mem.buffer, mem.byteOffset);
                for (let i = 0; i < size; i++) dv.setInt32(dataPtr + i * 4, 0, true);
            }
            return 0;
        };
        this.exports["alcIsExtensionPresent"] = () => ALC_FALSE;
        this.exports["alcGetProcAddress"] = () => 0;
        this.exports["alcGetEnumValue"] = () => 0;
        this.exports["alcCaptureOpenDevice"] = () => 0;
        this.exports["alcCaptureCloseDevice"] = () => ALC_TRUE;
        this.exports["alcCaptureStart"] = () => 0;
        this.exports["alcCaptureStop"] = () => 0;
        this.exports["alcCaptureSamples"] = () => 0;

        // ── AL (core state) ──────────────────────────────────────────────

        this.exports["alGetError"] = () => AL_NO_ERROR;
        this.exports["alEnable"] = () => 0;
        this.exports["alDisable"] = () => 0;
        this.exports["alIsEnabled"] = () => AL_FALSE;
        this.exports["alGetString"] = (_ctx, _mem, args) => this.getAlString(args[0]);
        this.exports["alGetBoolean"] = () => AL_FALSE;
        this.exports["alGetBooleanv"] = () => 0;
        this.exports["alGetInteger"] = () => 0;
        this.exports["alGetIntegerv"] = () => 0;
        this.exports["alGetFloat"] = () => 0;
        this.exports["alGetFloatv"] = () => 0;
        this.exports["alGetDouble"] = () => 0;
        this.exports["alGetDoublev"] = () => 0;
        this.exports["alGetEnumValue"] = () => 0;
        this.exports["alGetProcAddress"] = () => 0;
        this.exports["alIsExtensionPresent"] = () => AL_FALSE;
        this.exports["alDistanceModel"] = () => 0;
        this.exports["alDopplerFactor"] = () => 0;
        this.exports["alDopplerVelocity"] = () => 0;
        this.exports["alSpeedOfSound"] = () => 0;

        // ── Listener ─────────────────────────────────────────────────────

        this.exports["alListenerf"] = () => 0;
        this.exports["alListener3f"] = () => 0;
        this.exports["alListenerfv"] = () => 0;
        this.exports["alListeneri"] = () => 0;
        this.exports["alListener3i"] = () => 0;
        this.exports["alListeneriv"] = () => 0;
        this.exports["alGetListenerf"] = () => 0;
        this.exports["alGetListener3f"] = () => 0;
        this.exports["alGetListenerfv"] = () => 0;
        this.exports["alGetListeneri"] = () => 0;
        this.exports["alGetListeneriv"] = () => 0;
        this.exports["alGetListener3i"] = () => 0;

        // ── Sources ──────────────────────────────────────────────────────

        this.exports["alGenSources"] = (_ctx, mem, args) => {
            const [n, sourcesPtr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) {
                const id = this.nextSourceId++;
                this.sources.set(id, {
                    id, state: AL_INITIAL, bufferId: 0,
                    gain: 1.0, pitch: 1.0, looping: false,
                    posX: 0, posY: 0, posZ: 0, relative: false,
                    queuedBuffers: [], processedBuffers: [],
                    audioId: 0, sab: null,
                });
                dv.setUint32(sourcesPtr + i * 4, id, true);
            }
            return 0;
        };

        this.exports["alDeleteSources"] = (_ctx, mem, args) => {
            const [n, sourcesPtr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) {
                const id = dv.getUint32(sourcesPtr + i * 4, true);
                this.stopSource(id);
                this.sources.delete(id);
            }
            return 0;
        };

        this.exports["alIsSource"] = (_ctx, _mem, args) => {
            return this.sources.has(args[0]) ? AL_TRUE : AL_FALSE;
        };

        this.exports["alSourcef"] = (_ctx, _mem, args) => {
            const [sourceId, param, value] = args;
            const src = this.sources.get(sourceId);
            if (!src) return 0;
            const fval = Math.fround(new Float32Array(new Uint32Array([value]).buffer)[0]);
            switch (param) {
                case AL_GAIN:
                    src.gain = fval;
                    if (src.sab) setCtrl(src.sab, CTRL_VOLUME, gainToCentibels(fval));
                    break;
                case AL_PITCH:
                    src.pitch = fval;
                    // Pitch → frequency ratio applied to SAB
                    if (src.sab && src.bufferId) {
                        const buf = this.buffers.get(src.bufferId);
                        if (buf) setCtrl(src.sab, CTRL_FREQUENCY, Math.round(buf.sampleRate * fval));
                    }
                    break;
            }
            return 0;
        };

        this.exports["alSource3f"] = (_ctx, _mem, args) => {
            const [sourceId, param, v1, v2, v3] = args;
            const src = this.sources.get(sourceId);
            if (!src) return 0;
            const f1 = Math.fround(new Float32Array(new Uint32Array([v1]).buffer)[0]);
            const f2 = Math.fround(new Float32Array(new Uint32Array([v2]).buffer)[0]);
            const f3 = Math.fround(new Float32Array(new Uint32Array([v3]).buffer)[0]);
            if (param === AL_POSITION) {
                src.posX = f1; src.posY = f2; src.posZ = f3;
                if (src.sab) {
                    setCtrlFloat(src.sab, CTRL_3D_POS_X, f1);
                    setCtrlFloat(src.sab, CTRL_3D_POS_Y, f2);
                    setCtrlFloat(src.sab, CTRL_3D_POS_Z, f3);
                    setCtrl(src.sab, CTRL_3D_FLAGS, 1); // has3D
                }
            }
            return 0;
        };

        this.exports["alSourcefv"] = () => 0;

        this.exports["alSourcei"] = (_ctx, _mem, args) => {
            const [sourceId, param, value] = args;
            const src = this.sources.get(sourceId);
            if (!src) return 0;
            switch (param) {
                case AL_BUFFER:
                    src.bufferId = value;
                    break;
                case AL_LOOPING:
                    src.looping = value !== 0;
                    if (src.sab) setCtrl(src.sab, CTRL_LOOP_MODE, src.looping ? -1 : 1);
                    break;
                case AL_SOURCE_RELATIVE:
                    src.relative = value !== 0;
                    break;
            }
            return 0;
        };

        this.exports["alSource3i"] = () => 0;
        this.exports["alSourceiv"] = () => 0;

        this.exports["alGetSourcef"] = (_ctx, mem, args) => {
            const [sourceId, param, valuePtr] = args;
            const src = this.sources.get(sourceId);
            const dv = new DataView(mem.buffer, mem.byteOffset);
            let fval = 0.0;
            if (src) {
                switch (param) {
                    case AL_GAIN: fval = src.gain; break;
                    case AL_PITCH: fval = src.pitch; break;
                }
            }
            if (valuePtr) dv.setFloat32(valuePtr, fval, true);
            return 0;
        };

        this.exports["alGetSource3f"] = () => 0;
        this.exports["alGetSourcefv"] = () => 0;

        this.exports["alGetSourcei"] = (_ctx, mem, args) => {
            const [sourceId, param, valuePtr] = args;
            const src = this.sources.get(sourceId);
            const dv = new DataView(mem.buffer, mem.byteOffset);
            let value = 0;
            if (src) {
                if (param === AL_SOURCE_STATE) syncSourceState(src);
                switch (param) {
                    case AL_SOURCE_STATE: value = src.state; break;
                    case AL_BUFFERS_QUEUED: value = src.queuedBuffers.length; break;
                    case AL_BUFFERS_PROCESSED: value = src.processedBuffers.length; break;
                    case AL_BUFFER: value = src.bufferId; break;
                    case AL_LOOPING: value = src.looping ? AL_TRUE : AL_FALSE; break;
                    case AL_SOURCE_RELATIVE: value = src.relative ? AL_TRUE : AL_FALSE; break;
                }
            }
            if (valuePtr) dv.setInt32(valuePtr, value, true);
            return 0;
        };

        this.exports["alGetSource3i"] = () => 0;
        // Same contract as alGetSourcei for every single-valued property (which is all of
        // the ones above) — returning a bare 0 would report AL_SOURCE_STATE as "not a state"
        // and re-open the never-finishes hole through the other entry point.
        this.exports["alGetSourceiv"] = this.exports["alGetSourcei"];

        // ── Source playback ──────────────────────────────────────────────

        this.exports["alSourcePlay"] = (_ctx, _mem, args) => {
            this.playSource(args[0]);
            return 0;
        };

        this.exports["alSourceStop"] = (_ctx, _mem, args) => {
            this.stopSource(args[0]);
            return 0;
        };

        this.exports["alSourcePause"] = (_ctx, _mem, args) => {
            this.pauseSource(args[0]);
            return 0;
        };

        this.exports["alSourceRewind"] = (_ctx, _mem, args) => {
            this.stopSource(args[0]);
            const src = this.sources.get(args[0]);
            if (src) src.state = AL_INITIAL;
            return 0;
        };

        this.exports["alSourcePlayv"] = (_ctx, mem, args) => {
            const [n, ptr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) this.playSource(dv.getUint32(ptr + i * 4, true));
            return 0;
        };

        this.exports["alSourceStopv"] = (_ctx, mem, args) => {
            const [n, ptr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) this.stopSource(dv.getUint32(ptr + i * 4, true));
            return 0;
        };

        this.exports["alSourcePausev"] = (_ctx, mem, args) => {
            const [n, ptr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) this.pauseSource(dv.getUint32(ptr + i * 4, true));
            return 0;
        };

        this.exports["alSourceRewindv"] = (_ctx, mem, args) => {
            const [n, ptr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) {
                const id = dv.getUint32(ptr + i * 4, true);
                this.stopSource(id);
                const src = this.sources.get(id);
                if (src) src.state = AL_INITIAL;
            }
            return 0;
        };

        // ── Streaming (queue/unqueue) ────────────────────────────────────

        this.exports["alSourceQueueBuffers"] = (_ctx, mem, args) => {
            const [sourceId, nb, buffersPtr] = args;
            const src = this.sources.get(sourceId);
            if (!src) return 0;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < nb; i++) {
                const bufId = dv.getUint32(buffersPtr + i * 4, true);
                src.queuedBuffers.push(bufId);
            }
            return 0;
        };

        this.exports["alSourceUnqueueBuffers"] = (_ctx, mem, args) => {
            const [sourceId, nb, buffersPtr] = args;
            const src = this.sources.get(sourceId);
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < nb; i++) {
                const bufId = src?.processedBuffers.shift() ?? 0;
                dv.setUint32(buffersPtr + i * 4, bufId, true);
            }
            return 0;
        };

        // ── Buffers ──────────────────────────────────────────────────────

        this.exports["alGenBuffers"] = (_ctx, mem, args) => {
            const [n, buffersPtr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) {
                const id = this.nextBufferId++;
                this.buffers.set(id, {
                    id, format: AL_FORMAT_MONO16,
                    sampleRate: 44100, channels: 1, bitsPerSample: 16,
                    data: new Uint8Array(0),
                });
                dv.setUint32(buffersPtr + i * 4, id, true);
            }
            return 0;
        };

        this.exports["alDeleteBuffers"] = (_ctx, mem, args) => {
            const [n, buffersPtr] = args;
            const dv = new DataView(mem.buffer, mem.byteOffset);
            for (let i = 0; i < n; i++) {
                this.buffers.delete(dv.getUint32(buffersPtr + i * 4, true));
            }
            return 0;
        };

        this.exports["alIsBuffer"] = (_ctx, _mem, args) => {
            return this.buffers.has(args[0]) ? AL_TRUE : AL_FALSE;
        };

        this.exports["alBufferData"] = (_ctx, mem, args) => {
            const [bufferId, format, dataPtr, size, freq] = args;
            const buf = this.buffers.get(bufferId);
            if (!buf) return 0;

            buf.format = format;
            buf.sampleRate = freq;
            buf.channels = formatChannels(format);
            buf.bitsPerSample = formatBits(format);
            // Copy PCM data from guest memory
            buf.data = new Uint8Array(size);
            buf.data.set(mem.subarray(dataPtr, dataPtr + size));

            Logger.verbose(LogCategory.SYSTEM,
                `[OpenAL] alBufferData(buf=${bufferId}, fmt=0x${format.toString(16)}, ` +
                `size=${size}, freq=${freq}, ch=${buf.channels}, bits=${buf.bitsPerSample})`);
            return 0;
        };

        this.exports["alBufferf"] = () => 0;
        this.exports["alBuffer3f"] = () => 0;
        this.exports["alBufferfv"] = () => 0;
        this.exports["alBufferi"] = () => 0;
        this.exports["alBuffer3i"] = () => 0;
        this.exports["alBufferiv"] = () => 0;
        this.exports["alGetBufferf"] = () => 0;
        this.exports["alGetBuffer3f"] = () => 0;
        this.exports["alGetBufferfv"] = () => 0;

        this.exports["alGetBufferi"] = (_ctx, mem, args) => {
            const [bufferId, param, valuePtr] = args;
            const buf = this.buffers.get(bufferId);
            const dv = new DataView(mem.buffer, mem.byteOffset);
            let value = 0;
            if (buf) {
                switch (param) {
                    case AL_FREQUENCY: value = buf.sampleRate; break;
                    case AL_BITS:      value = buf.bitsPerSample; break;
                    case AL_CHANNELS:  value = buf.channels; break;
                    case AL_SIZE:      value = buf.data.byteLength; break;
                }
            }
            if (valuePtr) dv.setInt32(valuePtr, value, true);
            return 0;
        };

        this.exports["alGetBuffer3i"] = () => 0;
        this.exports["alGetBuffer3f"] = () => 0;
        this.exports["alGetBufferiv"] = () => 0;

        // ── EAX ──────────────────────────────────────────────────────────

        this.exports["EAXGet"] = () => 0;
        this.exports["EAXSet"] = () => 0;
    }

    // ── Playback engine ──────────────────────────────────────────────────

    private playSource(sourceId: number): void {
        const src = this.sources.get(sourceId);
        if (!src) return;

        // Resolve buffer — static or first queued
        const bufId = src.bufferId || src.queuedBuffers[0] || 0;
        const buf = bufId ? this.buffers.get(bufId) : undefined;

        if (!buf || buf.data.byteLength === 0) {
            // No data to play — set state but skip audio registration
            src.state = AL_PLAYING;
            return;
        }

        // If already playing with a SAB, just resume
        if (src.sab && src.state === AL_PAUSED) {
            setCtrl(src.sab, CTRL_STATE, STATE_PLAYING);
            src.state = AL_PLAYING;
            return;
        }

        // Stop previous playback if any
        this.unregisterAudio(src);

        // Create SAB ring buffer
        const sab = createAudioRingBuffer(buf.data.byteLength, {
            channels: buf.channels,
            sampleRate: buf.sampleRate,
            bitsPerSample: buf.bitsPerSample,
        }, false /* not circular — linear one-shot or looping */);

        // Write PCM data
        writeRingData(sab, 0, buf.data, buf.data.byteLength);
        setCtrl(sab, CTRL_DATA_LENGTH, buf.data.byteLength);
        setCtrl(sab, CTRL_LOOP_MODE, src.looping ? -1 : 1);
        setCtrl(sab, CTRL_VOLUME, gainToCentibels(src.gain));
        setCtrl(sab, CTRL_FREQUENCY, Math.round(buf.sampleRate * src.pitch));
        if (src.looping) {
            setCtrl(sab, CTRL_FLAGS, FLAG_CIRCULAR);
        }

        // 3D position
        if (src.posX !== 0 || src.posY !== 0 || src.posZ !== 0) {
            setCtrlFloat(sab, CTRL_3D_POS_X, src.posX);
            setCtrlFloat(sab, CTRL_3D_POS_Y, src.posY);
            setCtrlFloat(sab, CTRL_3D_POS_Z, src.posZ);
            setCtrl(sab, CTRL_3D_FLAGS, 1);
        }

        // Register with AudioWorklet
        const audioId = audioIdCounter++;
        (self as any).postMessage({ type: "audio_register", payload: { id: audioId, sab } });

        // Start playing
        setCtrl(sab, CTRL_STATE, STATE_PLAYING);

        src.sab = sab;
        src.audioId = audioId;
        src.state = AL_PLAYING;

        Logger.verbose(LogCategory.SYSTEM,
            `[OpenAL] playSource(${sourceId}) buf=${bufId} size=${buf.data.byteLength} ` +
            `freq=${buf.sampleRate} ch=${buf.channels} loop=${src.looping}`);
    }

    private stopSource(sourceId: number): void {
        const src = this.sources.get(sourceId);
        if (!src) return;

        if (src.sab) {
            setCtrl(src.sab, CTRL_STOP_REQUESTED, 1);
        }
        this.unregisterAudio(src);
        src.state = AL_STOPPED;

        // Move queued → processed
        while (src.queuedBuffers.length > 0) {
            src.processedBuffers.push(src.queuedBuffers.shift()!);
        }
    }

    private pauseSource(sourceId: number): void {
        const src = this.sources.get(sourceId);
        if (!src || src.state !== AL_PLAYING) return;

        if (src.sab) {
            setCtrl(src.sab, CTRL_STATE, STATE_PAUSED);
        }
        src.state = AL_PAUSED;
    }

    private unregisterAudio(src: ALSource): void {
        if (src.audioId) {
            (self as any).postMessage({ type: "audio_unregister", payload: { id: src.audioId } });
            src.audioId = 0;
        }
        src.sab = null;
    }

    reset(): void {
        // Stop all sources
        for (const src of this.sources.values()) {
            this.unregisterAudio(src);
        }
        this.sources.clear();
        this.buffers.clear();
        this.nextSourceId = 1;
        this.nextBufferId = 1;
        this.nextDeviceId = 0xAD000001;
        this.nextContextId = 0xAC000001;
        this.currentContext = 0;
        this.currentDevice = 0;
        this.stringPtrs.clear();
    }

    // ── String helpers ───────────────────────────────────────────────────

    private getOrAllocString(key: number, value: string): number {
        let ptr = this.stringPtrs.get(key);
        if (!ptr) {
            ptr = writeString(this.process, value);
            this.stringPtrs.set(key, ptr);
        }
        return ptr;
    }

    private getAlcString(param: number): number {
        switch (param) {
            case ALC_DEFAULT_DEVICE_SPECIFIER:
            case ALC_DEVICE_SPECIFIER:
            case ALC_ALL_DEVICES_SPECIFIER:
                return this.getOrAllocString(param, "BottleShip OpenAL");
            case ALC_EXTENSIONS:
                return this.getOrAllocString(param, "");
            default:
                return this.getOrAllocString(0xFF00 | param, "");
        }
    }

    private getAlString(param: number): number {
        switch (param) {
            case AL_VENDOR:     return this.getOrAllocString(param, "BottleShip");
            case AL_VERSION:    return this.getOrAllocString(param, "1.1");
            case AL_RENDERER:   return this.getOrAllocString(param, "BottleShip WebAudio");
            case AL_EXTENSIONS: return this.getOrAllocString(param, "");
            default:            return this.getOrAllocString(0xFE00 | param, "");
        }
    }
}

// ── ALUT Module (alut.dll) ───────────────────────────────────────────────────

export class ALUT implements IModule {
    name = "alut";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private errorStringPtr = 0;

    initialize(process: Process): void {
        this.process = process;

        this.exports["alutInit"] = () => {
            Logger.log(LogCategory.SYSTEM, `[ALUT] alutInit`);
            return AL_TRUE;
        };
        this.exports["alutInitWithoutContext"] = () => AL_TRUE;
        this.exports["alutExit"] = () => AL_TRUE;
        this.exports["alutGetError"] = () => ALUT_ERROR_NO_ERROR;
        this.exports["alutGetErrorString"] = () => {
            if (!this.errorStringPtr) {
                this.errorStringPtr = writeString(this.process, "No ALUT error");
            }
            return this.errorStringPtr;
        };
        this.exports["alutCreateBufferFromFile"] = () => 0;
        this.exports["alutCreateBufferFromFileImage"] = () => 0;
        this.exports["alutCreateBufferHelloWorld"] = () => 0;
        this.exports["alutCreateBufferWaveform"] = () => 0;
        this.exports["alutGetMajorVersion"] = () => 1;
        this.exports["alutGetMinorVersion"] = () => 1;
        this.exports["alutGetMIMETypes"] = () => writeString(this.process, "audio/x-wav");
        this.exports["alutLoadWAVFile"] = () => 0;
        this.exports["alutLoadWAVMemory"] = () => 0;
        this.exports["alutUnloadWAV"] = () => 0;
        this.exports["alutLoadMemoryFromFile"] = () => 0;
        this.exports["alutLoadMemoryFromFileImage"] = () => 0;
        this.exports["alutLoadMemoryHelloWorld"] = () => 0;
        this.exports["alutLoadMemoryWaveform"] = () => 0;
        this.exports["alutSleep"] = () => 0;
    }

    reset(): void {
        this.errorStringPtr = 0;
    }
}
