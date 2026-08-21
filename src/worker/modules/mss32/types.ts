import { VfsFileHandle } from "../../runtime/filesystem/vfs";

// Miles Sound System sample handle
export interface MSSSample {
    id: number;
    handle: number;
    fileData: Uint8Array | null;
    decodedData: Float32Array | null;
    streamBuffers?: { ptr: number; size: number; inUse: boolean }[];
    userData?: number[];
    totalBytes?: number;
    fileFormat?: "wav" | "mp3" | "ogg" | "unknown";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    formatTag: number;
    blockAlign: number;
    volume: number; // 0-127
    pan: number; // Miles API 0-127 (64=center)
    playbackRate: number; // multiplier for WAV
    playbackRateHz?: number; // current rate in Hz (API getter returns this)
    loopCount: number;
    /** PCM data length in bytes (WAV data chunk only); used for len/done in guest struct */
    pcmBytes?: number;
    isPlaying: boolean;
    isStopped: boolean;
    position: number;
    pendingStart: boolean;
    fileDataAllocated: boolean; // Track if fileData was allocated in emulator memory (vs loaded from VFS or referenced)
    fileDataAddress?: number; // Address if allocated in emulator memory
    startTime?: number; // Timestamp when playback started (for position calculation)
    lastDebugLogTime?: number; // Last timestamp for debug logging
    lastDebugPos?: number; // Last position for debug logging
    lastAudioPositionTime?: number; // Timestamp of last authoritative audio position update
    lastAudioPositionBytes?: number; // Last authoritative position in bytes
    lastRingCursorBytes?: number; // Last SAB play cursor observed by heartbeat
    lastRingCursorTime?: number; // Timestamp when the SAB play cursor last moved
    /** Estimated decoded duration for encoded formats decoded by the host audio stack. */
    encodedDurationMs?: number;

    // --- Miles 3D positional audio (set via the _AIL_*_3D_* API) ---
    /** True for samples allocated via _AIL_allocate_3D_sample_handle — routed through the worklet 3D mixer. */
    is3D?: boolean;
    /** Spatial state pushed into the ring buffer's CTRL_3D_* fields. World units = game units. */
    pos3D?: { x: number; y: number; z: number };
    vel3D?: { x: number; y: number; z: number };
    minDist3D?: number;
    maxDist3D?: number;
    /** DS3DMODE_* (0=normal, 1=head-relative, 2=disable). */
    mode3D?: number;
    cone3D?: { inner: number; outer: number; oriX: number; oriY: number; oriZ: number; outVolCb: number };
}

/** Miles 3D listener — one per provider; drives the global listener SAB the worklet mixes against. */
export interface MSSListener3D {
    handle: number;
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    frontX: number; frontY: number; frontZ: number;
    topX: number; topY: number; topZ: number;
    distanceFactor: number;
    rolloffFactor: number;
    dopplerFactor: number;
}

// Redbook (CD Audio) handle — a Miles-side view of the shared VirtualCdAudio drive,
// which owns the table of contents and the transport.
export interface RedbookHandle {
    id: number;                    // Unique handle ID
    volume: number;                // 0-127
    playToken: number;             // VirtualCdAudio token of the request this handle issued
}

// Wave output device handle
export interface MSSWaveOut {
    handle: number;
    deviceId: number;
    preparedHeaders?: Map<number, { ptr: number; len: number; flags: number }>;
}

/**
 * A stream's live source: the file held OPEN for the life of the HSTREAM, plus
 * where in it the engine has read to. Present only for streams fed incrementally
 * (see stream-engine.ts); a whole-file stream has `fileData` instead.
 *
 * Two backings, because Miles has two ways to reach a stream's bytes and both are
 * real: "app" is the title's own AILCALLBACK file I/O (guest code, so a refill is
 * a guest call chain), "vfs" is our file system (an ordinary async read).
 */
export interface MSSStreamSource {
    kind: "app" | "vfs";
    /** app: handle the app's open callback returned. Closed by close_stream, never before. */
    fileHandle: number;
    /** app: guest allocation — 4-byte handle out-param followed by the read buffer. */
    scratch: number;
    /** vfs: our own file object. Nothing else reads through it, so its cursor is ours. */
    vfsHandle: import("../../runtime/filesystem/vfs").VfsFileHandle | null;
    fileSize: number;
    /** Format of the source bytes — what convertToFloat is called with each refill. */
    info: import("./audio-decode").WavChunkInfo;
    /** Source bytes that decode as one indivisible unit (an ADPCM block, or a PCM frame). */
    blockBytes: number;
    /** Decoded frames one such block yields. */
    framesPerBlock: number;
    /** Data-chunk extent in FILE bytes. */
    dataStart: number;
    dataEnd: number;
    /** Decoded frames in the whole data chunk — the stream's length. */
    totalFrames: number;
    /** Next file offset the engine will read from. */
    readOffset: number;
    /** Where the file object's cursor is, so a refill only seeks when it has to. -1 = unknown. */
    cursor: number;
    /** Frames handed to the ring since the stream opened (monotonic across loops). */
    framesDecoded: number;
    /** A refill is in flight on the guest call chain; do not start a second. */
    busy: boolean;
    /** Source spent and not looping — the stream ends when the ring drains. */
    exhausted: boolean;
    /** The app's stream callback has already been told about this end-of-source. */
    endReported: boolean;
    /** Decoded tail the ring had no room for; consumed first on the next refill. */
    pending: { floats: Float32Array; at: number } | null;
}

// Miles Sound System stream handle (for streaming audio playback - e.g., Smacker video audio)
export interface MSSStream {
    id: number;
    handle: number;
    fileData: Uint8Array | null;
    decodedData: Float32Array | null;
    filename: string | null;
    fileFormat?: "wav" | "mp3" | "ogg" | "unknown";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    formatTag: number;
    blockAlign: number;
    /** `stream_mem` supplied to AIL_open_stream; reported by AIL_stream_info. */
    streamMemory: number;
    volume: number; // 0-127
    pan: number; // 0-127 (64=center)
    playbackRate: number;
    playbackRateHz?: number;
    loopCount: number;
    pcmBytes?: number;
    streamDummyBuffer?: number; // Allocated dummy buffer for stream struct
    isPlaying: boolean;
    isPaused: boolean;
    position: number;
    pendingStart: boolean;
    startTime?: number;
    lastAudioPositionTime?: number;
    lastAudioPositionBytes?: number;
    /** Estimated decoded duration for encoded formats decoded by the host audio stack. */
    encodedDurationMs?: number;
    /** Incremental source (one open handle + a ring), or null for a whole-file stream. */
    source?: MSSStreamSource | null;
}

// MIDI/XMIDI sequence handle (stub — no actual playback)
export interface MSSSequence {
    handle: number;
    status: number;     // SMP_DONE(2) / SMP_PLAYING(4) / SMP_STOPPED(8)
    volume: number;     // 0-127
    loopCount: number;
    tempo: number;      // microseconds per beat
}

// Timer handle
export interface MSSTimer {
    handle: number;
    callback: number;
    user: number;
    freq: number;
    period: number;
    active: boolean;
    timerId?: number;
}
