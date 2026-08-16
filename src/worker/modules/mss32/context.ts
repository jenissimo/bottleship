import { Process } from "../../core/process";
import { VfsFileHandle } from "../../runtime/filesystem/vfs";
import { MSSSample, MSSStream, MSSWaveOut, RedbookHandle, MSSTimer, MSSSequence, MSSListener3D } from "./types";

/** A provider registered through Miles' Resource Interface Broker (RIB). */
export interface MSSRibProvider {
    module: number;
    interfaces: Map<string, { entryCount: number; entries: number[] }>;
}

export const SMP_FREE = 1;
export const SMP_DONE = 2;
export const SMP_PLAYING = 4;
export const SMP_STOPPED = 8;
/** Released while still audible — the mixer still owns the voice (AIL_active_sample_count counts it). */
export const SMP_PLAYINGBUTRELEASED = 16;

export interface MSSContext {
    process: Process;

    samples: Map<number, MSSSample>;
    samplesById: Map<number, MSSSample>;
    streams: Map<number, MSSStream>;
    streamsById: Map<number, MSSStream>;
    waveOuts: Map<number, MSSWaveOut>;
    fileHandles: Map<number, VfsFileHandle>;
    redbookHandles: Map<number, RedbookHandle>;
    timers: Map<number, MSSTimer>;
    sequences: Map<number, MSSSequence>;
    /** Opaque HPROVIDERs allocated for .m3d/.flt/.asi RIB_Main entry points. */
    ribProviders: Map<number, MSSRibProvider>;

    nextSampleId: number;
    nextStreamId: number;
    nextWaveOutId: number;
    nextFileHandleId: number;
    nextTimerId: number;
    nextRedbookId: number;
    nextSequenceId: number;

    initialized: boolean;
    digitalDriverHandle: number;
    driverDummyBuffer: number;
    driverWaveFormat: number;
    driverNoopStub: number;
    driverNoopTable: number;
    /** Guest-memory sample array: maxSamples × SAMPLE_STRUCT_SIZE bytes at driver[0x34] */
    driverSampleArray: number;
    driverMaxSamples: number;
    driverOutputRate: number;
    /** RIB type tag strings in guest memory — real MSS32 writes these at handle+0x00 */
    driverTypeTag: number;
    sampleTypeTag: number;
    /** Build buffer (driver+0x40) and decode buffer (driver+0xF8) — real MSS32 allocates these */
    driverBuildBuffer: number;
    driverDecodeBuffer: number;
    /** Aux buffers (driver+0xB0/B4/B8) — real MSS32 allocates maxSamples×4 each for mixing */
    driverAuxBuffer1: number;
    driverAuxBuffer2: number;
    driverAuxBuffer3: number;
    /** Guest-memory string for fake 3D provider name — returned by _AIL_enumerate_3D_providers */
    provider3DNamePtr: number;
    /** Miles 3D listener (created by _AIL_open_3D_listener). Distinct handle from sample handles. */
    listener3D: MSSListener3D | null;
    /** Global listener SAB shared with the audio worklet (LCTRL_* layout). */
    listenerSab: SharedArrayBuffer | null;
    /** Current 3D speaker-type preference (AIL_3D_2_SPEAKER etc.). */
    speakerType3D: number;
    /** Current 3D room-type (EAX environment preset). */
    roomType3D: number;
    /** MSS preferences array — indexed by preference number, stores current values */
    preferences: number[];
    midiDriverHandle: number;
    midiMasterVolume: number;
    updateInterval: any;
    startupTime: number;
    lastErrorPtr: number;
    lastErrorStr: string;

    /** Pointers allocated by readFileToBuffer when destBuffer is NULL; freed by _AIL_mem_free_lock */
    memAllocatedByMss: Set<number>;
    /** Queue of pending timer callbacks - processed during _AIL_serve to avoid corrupting CPU state */
    pendingTimerCallbacks: Array<{ callback: number; user: number }>;
    /** Queue of pending EOS callbacks - processed during _AIL_serve to avoid corrupting CPU state */
    pendingEOSCallbacks: Array<{ callback: number; handle: number; user: number }>;
    /** Flag to track if we're inside _AIL_serve (safe to invoke callbacks) */
    insideAilServe: boolean;
    /** H3 Async: reentrancy depth of _AIL_serve (nested serve = possible stack/callback conflict) */
    serveDepth: number;
    /** WAV format tag keyed by guest data-chunk pointer (set by AIL_WAV_info for ADPCM decode). */
    wavFormatByDataPtr: Map<number, number>;
    /**
     * The app's own file I/O for Miles (AIL_set_file_callbacks). A title whose
     * assets live inside an archive — Warcraft III's war3.mpq — installs these so
     * Miles reads through ITS reader instead of the file system — our own VFS
     * cannot serve those names at all, because they are not files.
     */
    fileCallbacks: { open: number; close: number; seek: number; read: number } | null;
    /** The app's allocator for Miles (AIL_mem_use_malloc/free). */
    memCallbacks: { malloc: number; free: number };
    /** Per-stream user data slots (AIL_set_stream_user_data), keyed by stream handle. */
    streamUserData: Map<number, number[]>;
    /** Per-stream data-pump callback (AIL_register_stream_callback), keyed by stream handle. */
    streamCallbacks: Map<number, number>;
    /** Per-sequence user data slots and callback (the MIDI twins of the stream pair). */
    sequenceUserData: Map<number, number[]>;
    sequenceCallbacks: Map<number, number>;
    /** 3D distance factor (AIL_set_3D_distance_factor), metres per world unit. */
    distanceFactor3D: number;
}

export function createMSSContext(process: Process): MSSContext {
    return {
        process,

        samples: new Map(),
        samplesById: new Map(),
        streams: new Map(),
        streamsById: new Map(),
        waveOuts: new Map(),
        fileHandles: new Map(),
        redbookHandles: new Map(),
        timers: new Map(),
        sequences: new Map(),
        ribProviders: new Map(),

        nextSampleId: 1,
        nextStreamId: 0x00010001,
        nextWaveOutId: 1,
        nextFileHandleId: 0x50000000,
        nextTimerId: 1,
        nextRedbookId: 0x52420001,
        nextSequenceId: 1,

        initialized: false,
        digitalDriverHandle: 0,
        driverDummyBuffer: 0,
        driverWaveFormat: 0,
        driverNoopStub: 0,
        driverNoopTable: 0,
        driverSampleArray: 0,
        driverMaxSamples: 16,
        driverOutputRate: 44100,
        driverTypeTag: 0,
        sampleTypeTag: 0,
        driverBuildBuffer: 0,
        driverDecodeBuffer: 0,
        driverAuxBuffer1: 0,
        driverAuxBuffer2: 0,
        driverAuxBuffer3: 0,
        provider3DNamePtr: 0,
        listener3D: null,
        listenerSab: null,
        speakerType3D: 0,
        roomType3D: 0,
        preferences: (() => {
            const p = new Array(32).fill(0);
            p[0] = 0;     // DIG_RESAMPLING_TOLERANCE (default 0)
            p[1] = 16;    // DIG_MIXER_CHANNELS (max simultaneous samples; MSS32 default=16)
            p[2] = 500;   // DIG_LATENCY
            p[3] = 120;   // DIG_MIXER_GRANULARITY
            p[4] = 8;     // DIG_USE_WAVEOUT
            p[5] = 127;   // DIG_DS_MIX_CHANNELS
            p[6] = 1;     // DIG_DS_USE_PRIMARY
            p[8] = 2;     // DIG_DS_DSBCAPS_CTRL
            p[10] = 1536; // DIG_DS_SECONDARY_SIZE
            p[11] = 49152;// DIG_OUTPUT_BUFFER_SIZE
            p[12] = 5;    // DIG_DS_CREATION_HANDLER
            p[31] = 1;    // DIG_ENABLE_RESAMPLE_FILTER
            return p;
        })(),
        midiDriverHandle: 0,
        midiMasterVolume: 127,
        updateInterval: null,
        startupTime: 0,
        lastErrorPtr: 0,
        lastErrorStr: "",

        memAllocatedByMss: new Set(),
        pendingTimerCallbacks: [],
        pendingEOSCallbacks: [],
        insideAilServe: false,
        serveDepth: 0,
        wavFormatByDataPtr: new Map(),
        fileCallbacks: null,
        memCallbacks: { malloc: 0, free: 0 },
        streamUserData: new Map(),
        streamCallbacks: new Map(),
        sequenceUserData: new Map(),
        sequenceCallbacks: new Map(),
        distanceFactor3D: 1.0,
    };
}
