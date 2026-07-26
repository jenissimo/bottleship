/**
 * VideoEngine — lazy-loaded WASM video decoder for Bink (.bik), Smacker (.smk),
 * AVI, and MPEG-1/2 Program Stream (.mpg/.mpeg).
 *
 * The WASM module is built from tools/build-ffmpeg-decoder/decoder_api.c using
 * Emscripten + a minimal FFmpeg (Bink/Smacker/AVI/MPEG demuxers + decoders).
 *
 * Usage (in the emulator worker):
 *   const engine = videoEngine;
 *   await engine.ensureLoaded();
 *   const handle = await engine.open(fileBytes);
 *   const info   = engine.getInfo(handle);
 *   if (engine.doFrame(handle) === 0) {
 *       const bgra = engine.getFrameBgra(handle);   // BGRA view into WASM memory
 *       const pcm  = engine.drainAudio(handle);      // Int16Array or null
 *   }
 *   engine.nextFrame(handle);
 *   engine.close(handle);
 */

import { Logger, LogCategory } from "../worker/core/logger";
import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    getCtrl,
    STATE_PLAYING,
    CTRL_STATE,
    CTRL_DATA_LENGTH,
    CTRL_PLAY_CURSOR,
    CTRL_WRITE_CURSOR,
    CTRL_STOP_REQUESTED,
    CTRL_FLAGS,
    CTRL_LOOP_MODE,
    FLAG_CIRCULAR,
    FLAG_STREAMING,
} from "../audio/audio-ring-buffer";

/** C ABI exported by tools/build-ffmpeg-decoder/decoder_api.c */
interface DecoderWasmExports {
    memory: WebAssembly.Memory;
    decoder_alloc: (size: number) => number;
    decoder_free: (ptr: number) => void;
    decoder_open: (data: number, size: number) => number;
    decoder_close: (handle: number) => void;
    decoder_do_frame: (handle: number) => number;
    decoder_next_frame: (handle: number) => void;
    decoder_goto_frame: (handle: number, frame: number) => void;
    decoder_get_width: (handle: number) => number;
    decoder_get_height: (handle: number) => number;
    decoder_get_frame_count: (handle: number) => number;
    decoder_get_current_frame: (handle: number) => number;
    decoder_get_fps: (handle: number) => number;
    decoder_get_audio_sample_rate: (handle: number) => number;
    decoder_get_audio_channels: (handle: number) => number;
    decoder_get_frame_rgba_ptr: (handle: number) => number;
    decoder_get_audio_available: (handle: number) => number;
    decoder_get_audio_frame: (handle: number, out: number, outSize: number) => number;
    decoder_has_pal8?: (handle: number) => number;
    decoder_get_frame_pal8_ptr?: (handle: number) => number;
    decoder_get_frame_palette_ptr?: (handle: number) => number;
    decoder_get_frame_rgb565_ptr?: (handle: number) => number;
    decoder_get_video_codec_id?: (handle: number) => number;
    decoder_get_video_fourcc?: (handle: number) => number;
    decoder_get_video_pix_fmt?: (handle: number) => number;
    decoder_get_video_codec_name?: (handle: number) => number;
}

/** Max codec name length when scanning WASM memory for a null terminator. */
const MAX_CODEC_NAME_BYTES = 256;

/** Metadata returned by getInfo(). */
export interface VideoInfo {
    width:        number;
    height:       number;
    frameCount:   number;
    currentFrame: number;
    fps:          number;
    hasAudio:     boolean;
    sampleRate:   number;
    channels:     number;
    hasPal8:      boolean;
    codecName:    string;
    codecId:      number;
    fourCC:       string;
    pixFmt:       number;
}

/** PAL8 frame data: 8-bit palette indices + 256-entry BGRA palette. */
export interface Pal8Frame {
    indices:  Uint8Array;  // width * height bytes
    palette:  Uint8Array;  // 256 * 4 = 1024 bytes (BGRA per entry)
}

/** PCM bytes to buffer before starting the worklet (waveOut-style preroll). */
const AUDIO_PREROLL_MS = 250;
/** Extra runway: at least this many seconds of interleaved audio before PLAYING. */
const AUDIO_PREROLL_RUNWAY_SEC = 1.0;

/** Internal session tracking */
interface DecoderSession {
    wasmHandle:   number;
    width:        number;
    height:       number;
    fps:          number;
    frameCount:   number;
    hasAudio:     boolean;
    hasPal8:      boolean;
    sampleRate:   number;
    channels:     number;
    sab:          SharedArrayBuffer | null;
    sabWriteCursor: number;
    sabBufferBytes: number;
    audioId:      number;
    /** Bytes required before STATE_PLAYING (0 = start on first chunk). */
    audioPrerollBytes: number;
    audioPlaybackStarted: boolean;
}

/**
 * WASI / Emscripten import stub for the STANDALONE_WASM decoder.
 *
 * The decoder uses custom in-memory IO (avio_alloc_context) and never touches the real
 * filesystem, clock, or argv — so every WASI/syscall import can be a no-op returning 0.
 * The exact import SET grows whenever the FFmpeg build pulls in more codecs/demuxers
 * (e.g. the all-decoders build added __main_argc_argv, _tzset_js, __secs_to_zone, and
 * several fs syscalls). To stay robust across rebuilds we wrap both namespaces in a
 * Proxy that defaults any unknown import to `() => 0`, and only override the few that
 * need real behavior (proc_exit must throw; memory-growth is handled via refreshMemView).
 */
const noopImport = () => 0;
const importNamespace = (overrides: Record<string, (...a: any[]) => unknown>) =>
    new Proxy(overrides, { get: (t, p: string) => (p in t ? t[p] : noopImport) });

const WASI_IMPORTS = {
    wasi_snapshot_preview1: importNamespace({
        proc_exit: (code: number) => { throw new Error(`WASM proc_exit(${code})`); },
    }),
    env: importNamespace({
        // Called when WASM linear memory grows — handled via refreshMemView() on each access.
        emscripten_notify_memory_growth: () => { /* no-op */ },
    }),
};

/** Unique counter for audio stream IDs */
let audioIdCounter = 1;
/** Audio SAB size: ~4 seconds of 44100 Hz stereo S16 */
const AUDIO_SAB_BYTES = 44100 * 2 * 2 * 4;

export class VideoEngine {
    private instance: WebAssembly.Instance | null = null;
    private memView: Uint8Array | null = null;
    private loadPromise: Promise<void> | null = null;

    /** Map from JS-side unique handle → session state */
    private sessions: Map<number, DecoderSession> = new Map();
    private nextJsHandle = 1;

    // ── Loader ───────────────────────────────────────────────────────────────

    async ensureLoaded(): Promise<void> {
        if (this.instance) return;
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = this._load();
        return this.loadPromise;
    }

    private async _load(): Promise<void> {
        try {
            const url = "/video-decoder.wasm";
            Logger.log(LogCategory.SYSTEM, `[VideoEngine] Fetching ${url} …`);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
            // Streaming form so V8's implicit wasm code cache engages (keyed by URL, only fires
            // for *Streaming, ~128 KB threshold — this module is ~3 MB). Falls back to the
            // buffered compile when streaming is unavailable, e.g. a host serving the wrong
            // MIME type: this is a startup-latency optimization, never a correctness dependency.
            let result: WebAssembly.WebAssemblyInstantiatedSource;
            try {
                result = await WebAssembly.instantiateStreaming(resp, WASI_IMPORTS as WebAssembly.Imports);
            } catch (streamErr) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `[VideoEngine] streaming instantiate failed (${streamErr instanceof Error ? streamErr.message : String(streamErr)}); ` +
                    `falling back to buffered compile — wasm code cache will not engage`,
                );
                const bytes = await (await fetch(url)).arrayBuffer();
                result = await WebAssembly.instantiate(bytes, WASI_IMPORTS as WebAssembly.Imports);
            }
            this.instance = result.instance;
            this.memView  = new Uint8Array((this.instance.exports.memory as WebAssembly.Memory).buffer);
            Logger.log(LogCategory.SYSTEM, "[VideoEngine] WASM loaded successfully");
        } catch (e) {
            this.loadPromise = null;
            throw e;
        }
    }

    /** Refresh the Uint8Array view (memory may have grown). */
    private refreshMemView(): Uint8Array {
        const mem = (this.instance!.exports.memory as WebAssembly.Memory).buffer;
        if (!this.memView || this.memView.buffer !== mem) {
            this.memView = new Uint8Array(mem);
        }
        return this.memView;
    }

    private exp(): DecoderWasmExports {
        return this.instance!.exports as unknown as DecoderWasmExports;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Open a video file.  `fileBytes` must be a Uint8Array with the complete
     * file contents.  Returns a JS handle (> 0) or throws.
     */
    async open(fileBytes: Uint8Array): Promise<number> {
        await this.ensureLoaded();
        const exp  = this.exp();
        const size = fileBytes.byteLength;

        /* Copy file into WASM heap */
        const wptr = exp.decoder_alloc(size);
        if (!wptr) throw new Error("[VideoEngine] decoder_alloc failed");
        const mem = this.refreshMemView();
        mem.set(fileBytes, wptr);

        /* Open decoder (takes ownership of wptr) */
        const wHandle = exp.decoder_open(wptr, size);
        if (wHandle < 0) {
            exp.decoder_free(wptr);
            const sig = String.fromCharCode(fileBytes[0], fileBytes[1], fileBytes[2], fileBytes[3]);
            throw new Error(`[VideoEngine] decoder_open failed (rc=${wHandle}) — unsupported format "${sig}"?`);
        }

        const width        = exp.decoder_get_width(wHandle);
        const height       = exp.decoder_get_height(wHandle);
        const frameCount   = exp.decoder_get_frame_count(wHandle);
        const fps          = exp.decoder_get_fps(wHandle);
        const sampleRate   = exp.decoder_get_audio_sample_rate(wHandle);
        const channels     = exp.decoder_get_audio_channels(wHandle);
        const hasAudio     = sampleRate > 0 && channels > 0;
        const hasPal8      = !!(exp.decoder_has_pal8?.(wHandle));

        /* Build audio SAB if the video has audio */
        let sab: SharedArrayBuffer | null = null;
        let audioId = 0;
        if (hasAudio) {
            try {
                sab = createAudioRingBuffer(AUDIO_SAB_BYTES, {
                    channels,
                    sampleRate,
                    bitsPerSample: 16,
                }, true /* circular */);
            } catch (e) {
                exp.decoder_close(wHandle);
                const msg = e instanceof Error ? e.message : String(e);
                throw new Error(
                    `[VideoEngine] SharedArrayBuffer unavailable (${msg}). ` +
                    `Ensure COOP/COEP headers are set (Cross-Origin-Opener-Policy: same-origin, ` +
                    `Cross-Origin-Embedder-Policy: require-corp).`,
                );
            }
            setCtrl(sab, CTRL_FLAGS, FLAG_CIRCULAR | FLAG_STREAMING);
            setCtrl(sab, CTRL_LOOP_MODE, 1); // play once — streaming mode outputs silence when caught up
            // Fixed ring size — streaming uses WRITE_CURSOR for boundary, not DATA_LENGTH
            setCtrl(sab, CTRL_DATA_LENGTH, AUDIO_SAB_BYTES);
            audioId = audioIdCounter++;
            /* Register with AudioWorklet (same protocol as DSound) */
            self.postMessage({
                type: "audio_register",
                payload: { id: audioId, sab },
            });
        }

        const blockAlign = channels * 2;
        const audioPrerollBytes = hasAudio
            ? Math.max(
                blockAlign,
                Math.ceil(sampleRate * blockAlign * (AUDIO_PREROLL_MS / 1000)),
                fps > 0
                    ? Math.ceil((sampleRate * blockAlign / fps) * Math.ceil(fps * AUDIO_PREROLL_RUNWAY_SEC))
                    : 0,
            )
            : 0;

        const jsHandle = this.nextJsHandle++;
        this.sessions.set(jsHandle, {
            wasmHandle: wHandle,
            width, height, fps, frameCount,
            hasAudio, hasPal8, sampleRate, channels,
            sab, sabWriteCursor: 0, sabBufferBytes: hasAudio ? AUDIO_SAB_BYTES : 0, audioId,
            audioPrerollBytes,
            audioPlaybackStarted: false,
        });

        const codecName = this._readCodecName(wHandle);
        const codecId = exp.decoder_get_video_codec_id?.(wHandle) ?? 0;
        const fourCCRaw = exp.decoder_get_video_fourcc?.(wHandle) ?? 0;
        const pixFmt = exp.decoder_get_video_pix_fmt?.(wHandle) ?? -1;
        const fourCC = fourCCRaw > 0 ? String.fromCharCode(
            fourCCRaw & 0xFF, (fourCCRaw >> 8) & 0xFF,
            (fourCCRaw >> 16) & 0xFF, (fourCCRaw >> 24) & 0xFF
        ) : "";

        Logger.log(LogCategory.SYSTEM,
            `[VideoEngine] open → jsHandle=${jsHandle} wHandle=${wHandle} ` +
            `${width}×${height} fps=${fps.toFixed(2)} frames=${frameCount} ` +
            `codec="${codecName}" fourCC="${fourCC}" codecId=${codecId} pixFmt=${pixFmt} ` +
            `audio=${hasAudio ? `${sampleRate}Hz×${channels}ch` : "none"}`);

        return jsHandle;
    }

    /**
     * Decode the next video frame.
     * Returns true on success, false on EOF/error.
     * Also pumps audio PCM into the SAB ring buffer.
     */
    doFrame(jsHandle: number): boolean {
        const s = this.sessions.get(jsHandle);
        if (!s) return false;
        const exp = this.exp();
        const ret = exp.decoder_do_frame(s.wasmHandle);
        if (ret < 0) return false;

        /* Drain audio into SAB */
        if (s.hasAudio && s.sab) {
            this._pumpAudio(s);
        }
        return true;
    }

    /**
     * Get a WASM-memory-backed Uint8Array view of the current BGRA frame.
     * The decoder outputs BGRA byte order (native Windows 32-bit pixel format).
     * Valid only until the next WASM operation.  Copy if needed.
     */
    getFrameBgra(jsHandle: number): Uint8Array | null {
        const s = this.sessions.get(jsHandle);
        if (!s) return null;
        const exp = this.exp();
        const ptr = exp.decoder_get_frame_rgba_ptr(s.wasmHandle);
        if (!ptr) return null;
        const mem = this.refreshMemView();
        return mem.subarray(ptr, ptr + s.width * s.height * 4);
    }

    /**
     * Get pre-converted RGB565 frame data from the WASM decoder.
     * Returns a Uint8Array view of width*height*2 bytes (RGB565 LE), or null
     * if the WASM module doesn't export decoder_get_frame_rgb565_ptr (pre-rebuild).
     * The conversion is done in C/WASM — JS side just does memcpy per row.
     */
    getFrameRgb565(jsHandle: number): Uint8Array | null {
        const s = this.sessions.get(jsHandle);
        if (!s) return null;
        const exp = this.exp();
        if (!exp.decoder_get_frame_rgb565_ptr) return null;
        const ptr = exp.decoder_get_frame_rgb565_ptr!(s.wasmHandle);
        if (!ptr) return null;
        const mem = this.refreshMemView();
        return mem.subarray(ptr, ptr + s.width * s.height * 2);
    }

    /**
     * Get PAL8 frame data: 8-bit palette indices + 256-entry BGRA palette.
     * Returns null if the codec doesn't output PAL8, or if the WASM module
     * doesn't have PAL8 exports (pre-rebuild).
     * The returned arrays are views into WASM memory — copy if needed.
     */
    getFramePal8(jsHandle: number): Pal8Frame | null {
        const s = this.sessions.get(jsHandle);
        if (!s) return null;
        const exp = this.exp();
        if (!exp.decoder_get_frame_pal8_ptr || !exp.decoder_has_pal8) return null;

        // has_pal8 is set in WASM after first doFrame (convert_frame_to_bgra),
        // not at open time — so check it lazily each call.
        if (!s.hasPal8) {
            s.hasPal8 = !!exp.decoder_has_pal8!(s.wasmHandle);
            if (!s.hasPal8) return null;
        }

        const idxPtr = exp.decoder_get_frame_pal8_ptr!(s.wasmHandle);
        if (!idxPtr) return null;
        const palPtr = exp.decoder_get_frame_palette_ptr!(s.wasmHandle);
        if (!palPtr) return null;

        const mem = this.refreshMemView();
        return {
            indices: mem.subarray(idxPtr, idxPtr + s.width * s.height),
            palette: mem.subarray(palPtr, palPtr + 1024),
        };
    }

    /**
     * Drain available audio PCM as Int16Array, or null if none / no audio.
     * Audio is also automatically drained into SAB in doFrame(); only call
     * this if you need the raw PCM (e.g., standalone test page).
     */
    drainAudio(jsHandle: number): Int16Array | null {
        const s = this.sessions.get(jsHandle);
        if (!s || !s.hasAudio) return null;
        const exp = this.exp();
        const avail = exp.decoder_get_audio_available(s.wasmHandle);
        if (avail <= 0) return null;

        /* Allocate output buffer in WASM heap */
        const outPtr = exp.decoder_alloc(avail);
        if (!outPtr) return null;
        exp.decoder_get_audio_frame(s.wasmHandle, outPtr, avail);
        const mem = this.refreshMemView();
        /* Copy out before potential WASM growth invalidates the view */
        const bytes = mem.slice(outPtr, outPtr + avail);
        exp.decoder_free(outPtr);
        return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    }

    nextFrame(jsHandle: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s) return;
        this.exp().decoder_next_frame(s.wasmHandle);
    }

    gotoFrame(jsHandle: number, frame: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s) return;
        this.exp().decoder_goto_frame(s.wasmHandle, frame);
    }

    getInfo(jsHandle: number): VideoInfo | null {
        const s = this.sessions.get(jsHandle);
        if (!s) return null;
        const exp          = this.exp();
        const currentFrame = exp.decoder_get_current_frame(s.wasmHandle);
        const codecName = this._readCodecName(s.wasmHandle);
        const codecId = exp.decoder_get_video_codec_id?.(s.wasmHandle) ?? 0;
        const fourCCRaw = exp.decoder_get_video_fourcc?.(s.wasmHandle) ?? 0;
        const pixFmt = exp.decoder_get_video_pix_fmt?.(s.wasmHandle) ?? -1;
        const fourCC = fourCCRaw > 0 ? String.fromCharCode(
            fourCCRaw & 0xFF, (fourCCRaw >> 8) & 0xFF,
            (fourCCRaw >> 16) & 0xFF, (fourCCRaw >> 24) & 0xFF
        ) : "";
        return {
            width:        s.width,
            height:       s.height,
            frameCount:   s.frameCount,
            currentFrame,
            fps:          s.fps,
            hasAudio:     s.hasAudio,
            hasPal8:      s.hasPal8,
            sampleRate:   s.sampleRate,
            channels:     s.channels,
            codecName,
            codecId,
            fourCC,
            pixFmt,
        };
    }

    /** Close every open decoder session (game switch teardown). */
    closeAll(): void {
        for (const handle of Array.from(this.sessions.keys())) {
            this.close(handle);
        }
    }

    close(jsHandle: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s) return;

        /* Stop audio immediately, then unregister */
        if (s.hasAudio && s.sab) {
            setCtrl(s.sab, CTRL_STOP_REQUESTED, 1);
        }
        if (s.hasAudio && s.audioId) {
            self.postMessage({
                type: "audio_unregister",
                payload: { id: s.audioId },
            });
        }

        this.exp().decoder_close(s.wasmHandle);
        this.sessions.delete(jsHandle);
        Logger.log(LogCategory.SYSTEM, `[VideoEngine] close jsHandle=${jsHandle}`);
    }

    /**
     * Return the audio SAB for a session (for external volume/pan control).
     * Returns null if the session has no audio.
     */
    getAudioSab(jsHandle: number): SharedArrayBuffer | null {
        const s = this.sessions.get(jsHandle);
        return s?.sab ?? null;
    }

    /** Unwrapped PCM bytes written to the SAB (not yet consumed by the worklet). */
    getBufferedAudioBytes(jsHandle: number): number {
        const s = this.sessions.get(jsHandle);
        if (!s?.sab) return 0;
        const playPos = getCtrl(s.sab, CTRL_PLAY_CURSOR);
        const writePos = s.sabWriteCursor % s.sabBufferBytes;
        const pending = (writePos - playPos + s.sabBufferBytes) % s.sabBufferBytes;
        return pending;
    }

    /** Preroll threshold for this session (waveOut-style lead time). */
    getAudioPrerollBytes(jsHandle: number): number {
        return this.sessions.get(jsHandle)?.audioPrerollBytes ?? 0;
    }

    /**
     * Audio reference-clock position in seconds = total PCM bytes the worklet has
     * consumed / (sampleRate * blockAlign). Total played = bytes written minus bytes
     * still buffered ahead of the play cursor (handles the circular ring's wrap since
     * both quantities are computed consistently). Returns -1 if the session has no
     * audio (caller should fall back to a frame/virtual-time clock). This is the
     * DirectShow "reference clock" the video renderer must sync frame presentation to.
     */
    getAudioClockSeconds(jsHandle: number): number {
        const s = this.sessions.get(jsHandle);
        if (!s?.sab || !s.hasAudio || s.sampleRate <= 0) return -1;
        if (!s.audioPlaybackStarted) return 0;
        const blockAlign = s.channels * 2;
        if (blockAlign <= 0) return -1;
        const pending = this.getBufferedAudioBytes(jsHandle);
        const played = Math.max(0, s.sabWriteCursor - pending);
        return played / (s.sampleRate * blockAlign);
    }

    hasAudioPlaybackStarted(jsHandle: number): boolean {
        return this.sessions.get(jsHandle)?.audioPlaybackStarted ?? false;
    }

    /**
     * Start SAB playback once enough PCM is buffered (or immediately if data exists
     * and preroll is disabled). Idempotent.
     */
    beginAudioPlayback(jsHandle: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s?.sab || s.audioPlaybackStarted) return;
        if (s.sabWriteCursor === 0) return;
        this._startAudioPlayback(s);
    }

    /**
     * Pump decoded PCM into the SAB without decoding a video frame.
     * Used when the WASM audio ring still holds samples after doFrame().
     */
    pumpAudio(jsHandle: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s?.hasAudio || !s.sab) return;
        this._pumpAudio(s);
    }

    /**
     * Disable the built-in audio SAB for a session so that doFrame() skips
     * _pumpAudio(), leaving decoded PCM available for drainAudio().
     * Called by SmackW32/BinkW32 when audio is routed through MSS32 instead.
     */
    disableBuiltinAudio(jsHandle: number): void {
        const s = this.sessions.get(jsHandle);
        if (!s) return;
        if (s.audioId) {
            self.postMessage({ type: "audio_unregister", payload: { id: s.audioId } });
            s.audioId = 0;
        }
        s.sab = null; // doFrame will skip _pumpAudio
    }

    isLoaded(): boolean {
        return this.instance !== null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** Read null-terminated codec name string from WASM memory. */
    private _readCodecName(wasmHandle: number): string {
        const exp = this.exp();
        if (!exp.decoder_get_video_codec_name) return "(unknown)";
        const ptr = exp.decoder_get_video_codec_name!(wasmHandle);
        if (!ptr) return "(null)";
        const mem = this.refreshMemView();
        let end = ptr;
        const limit = Math.min(ptr + MAX_CODEC_NAME_BYTES, mem.length);
        while (end < limit && mem[end] !== 0) end++;
        return new TextDecoder().decode(mem.subarray(ptr, end)) || "(empty)";
    }

    /** Bytes writable in the SAB ring without overwriting unplayed audio. */
    private _ringFreeBytes(s: DecoderSession): number {
        if (!s.sab || s.sabBufferBytes <= 0) return 0;
        const playPos = getCtrl(s.sab, CTRL_PLAY_CURSOR);
        const writePos = s.sabWriteCursor % s.sabBufferBytes;
        const pending = (writePos - playPos + s.sabBufferBytes) % s.sabBufferBytes;
        // Leave one frame of headroom so producer never catches the play head.
        const blockAlign = s.channels * 2;
        return Math.max(0, s.sabBufferBytes - pending - blockAlign);
    }

    private _startAudioPlayback(s: DecoderSession): void {
        if (!s.sab || s.audioPlaybackStarted) return;
        setCtrl(s.sab, CTRL_WRITE_CURSOR, s.sabWriteCursor % s.sabBufferBytes);
        setCtrl(s.sab, CTRL_STATE, STATE_PLAYING);
        s.audioPlaybackStarted = true;
        Logger.log(LogCategory.SYSTEM,
            `[VideoEngine] audio playback started: ${s.sabWriteCursor}B buffered, ` +
            `preroll=${s.audioPrerollBytes}B rate=${s.sampleRate} ch=${s.channels}`);
    }

    /** Drain WASM audio ring → SAB ring buffer (loops until empty or backpressure). */
    private _pumpAudio(s: DecoderSession): void {
        if (!s.sab) return;
        const exp = this.exp();
        let loggedEmptyFirst = false;

        for (;;) {
            const avail = exp.decoder_get_audio_available(s.wasmHandle);
            if (avail <= 0) {
                if (s.sabWriteCursor === 0 && !loggedEmptyFirst) {
                    Logger.verbose(LogCategory.SYSTEM,
                        `[VideoEngine] _pumpAudio: no PCM yet (interleaved AVI — audio may follow first video packet)`);
                    loggedEmptyFirst = true;
                }
                break;
            }

            const freeBytes = this._ringFreeBytes(s);
            if (freeBytes <= 0) break;

            const toWrite = Math.min(avail, freeBytes);
            const outPtr = exp.decoder_alloc(toWrite);
            if (!outPtr) break;
            exp.decoder_get_audio_frame(s.wasmHandle, outPtr, toWrite);
            const mem = this.refreshMemView();
            const bytes = mem.subarray(outPtr, outPtr + toWrite);
            writeRingData(s.sab, s.sabWriteCursor, bytes, toWrite);
            const isFirstChunk = s.sabWriteCursor === 0;
            if (isFirstChunk) {
                const sampleView = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32));
                const samples: number[] = [];
                for (let i = 0; i < Math.min(8, bytes.byteLength >> 1); i++) {
                    samples.push(sampleView.getInt16(i * 2, true));
                }
                Logger.log(LogCategory.SYSTEM,
                    `[VideoEngine] _pumpAudio: first chunk ${toWrite}B, sampleRate=${s.sampleRate} ch=${s.channels} ` +
                    `firstSamples=[${samples.join(',')}]`);
            }
            s.sabWriteCursor += toWrite;
            if (s.sabBufferBytes > 0) {
                setCtrl(s.sab, CTRL_WRITE_CURSOR, s.sabWriteCursor % s.sabBufferBytes);
            }
            exp.decoder_free(outPtr);
        }

        if (!s.audioPlaybackStarted && s.sabWriteCursor >= s.audioPrerollBytes) {
            this._startAudioPlayback(s);
        }
    }
}

/** Singleton used by binkw32.ts and smackw32.ts */
export const videoEngine = new VideoEngine();
