/**
 * VirtualCdAudio — the emulated CD-ROM drive's audio side ("Redbook"), shared by
 * every guest API that can reach it: MCI's `cdaudio` device (command + string),
 * Miles' AIL_redbook_*, and the aux device's CD volume line.
 *
 * A real drive exposes ONE transport and ONE table of contents; modelling that here
 * (rather than once per API module) is what makes the surfaces agree — a game that
 * queries a track length through MCI and seeks through AIL sees the same disc.
 *
 * The disc is backed by ripped track files in the bundle (the `music/TrackNN.ogg`
 * convention and its variants). File number == CD track number, so a game's own
 * track remap table indexes exactly what it would on real hardware.
 */
import { probeAudioStream } from "@bottleship/formats/audio";
import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { VfsAudioSource } from "./vfs-audio-source";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;

/** CD frames per second — the granularity of MSF/TMSF positions. */
export const CD_FRAMES_PER_SECOND = 75;

/**
 * Length assumed for a track whose container could not be probed. A disc timeline
 * must stay monotonic and track-resolvable for the position/seek arithmetic every
 * adapter does, so an unknown length still has to occupy a plausible slot.
 */
const UNKNOWN_TRACK_LENGTH_MS = 300000;

/** Bytes pulled per turn by readTrackBytes; the loop yields between chunks. JS and the
 *  guest CPU share the worker thread, so a whole 30-60 MB track in one turn stalls the
 *  frame loop and the audio pump and then dumps a virtual-time credit burst. */
const TRACK_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Wall-clock budget for the synchronous container probes the initial scan runs.
 *  ensureDisc() is reachable from any MCI status poll, so the first one must not stall
 *  for as long as the disc happens to be big; whatever is left unprobed is picked up by
 *  refineDurations. */
const SYNC_PROBE_BUDGET_MS = 12;

/** Passes refineDurations may make. A container that stays unprobeable must not turn
 *  every status poll into another async re-probe. */
const MAX_REFINE_PASSES = 3;

/** How far past a segment's expected end the drive waits for the host's audio_ended
 *  before completing on its own clock. A container the browser accepts but cannot
 *  decode produces neither `ended` nor a play() rejection. */
const COMPLETION_BACKSTOP_GRACE_MS = 2000;

/** Host/transport position disagreement worth acting on. Below it the reports are
 *  element-timer noise; above it on the FIRST report the element refused the mid-track
 *  seek and is playing from somewhere else entirely. */
const POSITION_SYNC_TOLERANCE_MS = 500;

/** audio_position for a CD segment is reported in milliseconds, not sample frames —
 *  the host multiplies element.currentTime by the rate the payload declares. */
const CD_POSITION_RATE_HZ = 1000;

/** Hand the worker thread back to the guest CPU. A microtask is not enough: microtasks
 *  drain before v86 gets its next slice. */
function yieldToWorkerTurn(): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** Directories a ripped disc's tracks conventionally live in (matched case-insensitively). */
const MUSIC_DIR_NAMES = new Set(["music", "audio", "cdaudio", "tracks"]);

/** Container extensions we can hand to the host audio stack, best first. */
const TRACK_EXTENSIONS: ReadonlyArray<{ ext: string; mimeType: string }> = [
    { ext: "ogg", mimeType: "audio/ogg" },
    { ext: "mp3", mimeType: "audio/mpeg" },
    { ext: "flac", mimeType: "audio/flac" },
    { ext: "wav", mimeType: "audio/wav" },
];

/** `TrackNN` / `track_NN` / `Track NN`, and inside a music directory a bare `NN`. */
const NAMED_TRACK_RE = /^track[ _-]?(\d{1,3})$/i;
const BARE_TRACK_RE = /^(\d{1,3})$/;

export type CdMode = "notReady" | "stopped" | "playing" | "paused";

/** Why a play request ended — maps 1:1 onto the MCI_NOTIFY_* codes. */
export type CdStopReason = "finished" | "aborted" | "superseded";

export interface CdTrack {
    /** CD track number (1-based). */
    number: number;
    /** False for a data track (no ripped file) — MCI reports it as MCI_CDA_TRACK_OTHER. */
    isAudio: boolean;
    /** VFS path of the backing file; empty for a data track. */
    file: string;
    mimeType: string;
    /** Disc-relative start, ms. */
    startMs: number;
    lengthMs: number;
    /** False when the container could not be probed and lengthMs is the fallback. */
    lengthKnown: boolean;
}

export type CdCompletionListener = (token: number, reason: CdStopReason) => void;

interface CdCandidate {
    file: string;
    mimeType: string;
    /** Extension rank; a music-directory hit also outranks a game-root hit. */
    rank: number;
}

interface LoadedCdSegment {
    track: CdTrack;
    data: Uint8Array;
    startOffsetMs: number;
    endOffsetMs: number;
    audioId: number;
}

export class VirtualCdAudio {
    private static instance: VirtualCdAudio | null = null;

    /** Index 0 == track 1. Empty means no media. */
    private trackTable: CdTrack[] = [];
    private scanned = false;
    private refining = false;
    private refinePasses = 0;

    private mode: CdMode = "stopped";
    /** Master CD line level, 0..1 (the aux device's CD volume). */
    private volume = 1;

    private nextToken = 1;
    private nextAudioId = 0x00CD0001;
    private token = 0;
    private audioId = 0;
    /** Disc-relative end of the active request; segments chain up to it. */
    private playToMs = 0;
    /** Track currently feeding the host, 0 when idle. */
    private segTrack = 0;
    private segStartDiscMs = 0;
    private segEndDiscMs = 0;
    /** performance.now() anchor for segStartDiscMs; wall clock is the transport clock. */
    private segAnchorMs = 0;
    private pausedPositionMs = 0;
    /** Guards against a stale async track load posting after stop/supersede. */
    private loadGeneration = 0;
    /** Loaded while paused before a host source existed; posted on Resume. */
    private pendingSegment: LoadedCdSegment | null = null;
    /** Whether audio_play_encoded for the current audioId reached the host. */
    private hostAudioPosted = false;
    /** Whether the host finished creating and starting the current audio source. */
    private hostAudioStarted = false;
    /** Whether a host position report has been reconciled with the current segment. */
    private segPositionSynced = false;
    /** Fires when the host owes an audio_ended it never sent — see armCompletionBackstop. */
    private backstopTimer: ReturnType<typeof setTimeout> | null = null;

    private listeners = new Set<CdCompletionListener>();

    static getInstance(): VirtualCdAudio {
        if (!VirtualCdAudio.instance) VirtualCdAudio.instance = new VirtualCdAudio();
        return VirtualCdAudio.instance;
    }

    // ==================== Table of contents ====================

    /**
     * Scan the bundle for track files once; cheap and idempotent afterwards. The scan's
     * synchronous probes are budgeted (SYNC_PROBE_BUDGET_MS), so a track whose duration
     * is still unknown is re-probed asynchronously here — the refine pass is what turns
     * the fallback lengths into real ones, and it must be reachable more than once.
     */
    ensureDisc(): void {
        if (!this.scanned) {
            this.scanned = true;
            this.scan();
        }
        if (this.needsRefine()) void this.refineDurations();
    }

    /** Re-scan on the next query (bundle swap / guest process restart). */
    invalidateDisc(): void {
        this.scanned = false;
        this.trackTable = [];
        this.refinePasses = 0;
    }

    private needsRefine(): boolean {
        if (this.refining || this.refinePasses >= MAX_REFINE_PASSES) return false;
        return this.trackTable.some((t) => t.isAudio && !t.lengthKnown);
    }

    hasMedia(): boolean {
        this.ensureDisc();
        return this.trackTable.length > 0;
    }

    /** Highest track number on the disc — what a drive reports as its track count. */
    numberOfTracks(): number {
        this.ensureDisc();
        return this.trackTable.length;
    }

    /** Ordered audio tracks only (the data track is skipped). */
    audioTracks(): readonly CdTrack[] {
        this.ensureDisc();
        return this.trackTable.filter((t) => t.isAudio);
    }

    track(number: number): CdTrack | null {
        this.ensureDisc();
        if (number < 1 || number > this.trackTable.length) return null;
        return this.trackTable[number - 1];
    }

    /** Total playing time of the disc, ms. */
    discLengthMs(): number {
        this.ensureDisc();
        const last = this.trackTable[this.trackTable.length - 1];
        return last ? last.startMs + last.lengthMs : 0;
    }

    /** Track containing a disc-relative position, or null when past the end. */
    trackAt(discMs: number): CdTrack | null {
        this.ensureDisc();
        for (const t of this.trackTable) {
            if (discMs >= t.startMs && discMs < t.startMs + t.lengthMs) return t;
        }
        return null;
    }

    // ==================== Transport ====================

    getMode(): CdMode {
        this.ensureDisc();
        if (this.trackTable.length === 0) return "notReady";
        return this.mode;
    }

    /** Disc-relative playback position, ms. */
    positionMs(): number {
        if (this.mode === "paused") return this.pausedPositionMs;
        if (this.mode !== "playing") return this.segStartDiscMs;
        const elapsed = performance.now() - this.segAnchorMs;
        return Math.min(this.segEndDiscMs, this.segStartDiscMs + Math.max(0, elapsed));
    }

    /** Track number under the play head, 0 when idle. */
    currentTrackNumber(): number {
        if (this.segTrack > 0) return this.segTrack;
        const t = this.trackAt(this.positionMs());
        return t ? t.number : 0;
    }

    addCompletionListener(listener: CdCompletionListener): void {
        this.listeners.add(listener);
    }

    removeCompletionListener(listener: CdCompletionListener): void {
        this.listeners.delete(listener);
    }

    /**
     * Play a disc-relative range. `toMs` <= `fromMs` means "to the end of the disc",
     * matching MCI_PLAY without MCI_TO. Returns a token identifying the request
     * (0 when it could not start); completion listeners receive that token.
     */
    play(fromMs: number, toMs: number): number {
        this.ensureDisc();
        if (this.trackTable.length === 0) return 0;

        const discEnd = this.discLengthMs();
        const from = Math.max(0, Math.min(fromMs, Math.max(0, discEnd - 1)));
        const to = toMs > from ? Math.min(toMs, discEnd) : discEnd;

        const startTrack = this.trackAt(from);
        if (!startTrack) return 0;
        if (!startTrack.isAudio) {
            Logger.log(LogCategory.SYSTEM, `VirtualCd: play refused — track ${startTrack.number} is a data track`);
            return 0;
        }

        this.finishActive("superseded");

        this.token = this.nextToken++;
        this.playToMs = to;
        Logger.log(LogCategory.SYSTEM,
            `VirtualCd: play token=${this.token} ${from}..${to}ms (track ${startTrack.number})`);
        this.startSegment(startTrack, from);
        return this.token;
    }

    stop(): void {
        if (this.mode === "stopped" || this.mode === "notReady") {
            this.mode = this.trackTable.length > 0 ? "stopped" : "notReady";
            return;
        }
        this.finishActive("aborted");
    }

    pause(): void {
        if (this.mode !== "playing") return;
        this.pausedPositionMs = this.hostAudioStarted ? this.positionMs() : this.segStartDiscMs;
        this.mode = "paused";
        this.clearCompletionBackstop();
        if (this.hostAudioStarted) {
            self.postMessage({ type: "audio_pause", payload: { id: this.audioId } });
        }
        Logger.log(LogCategory.SYSTEM, `VirtualCd: paused at ${this.pausedPositionMs | 0}ms`);
    }

    resume(): void {
        if (this.mode !== "paused") return;
        this.mode = "playing";
        this.segAnchorMs = performance.now() - (this.pausedPositionMs - this.segStartDiscMs);
        const pending = this.pendingSegment;
        if (pending && pending.audioId === this.audioId) {
            this.pendingSegment = null;
            this.postLoadedSegment(pending);
        } else if (this.hostAudioStarted) {
            self.postMessage({ type: "audio_resume", payload: { id: this.audioId } });
        }
        if (this.hostAudioPosted) this.armCompletionBackstop();
        Logger.log(LogCategory.SYSTEM, `VirtualCd: resumed at ${this.pausedPositionMs | 0}ms`);
    }

    /** Move the play head while stopped (MCI_SEEK). */
    seek(discMs: number): void {
        this.stop();
        const clamped = Math.max(0, Math.min(discMs, this.discLengthMs()));
        this.segStartDiscMs = clamped;
        this.segEndDiscMs = clamped;
        this.pausedPositionMs = clamped;
        const t = this.trackAt(clamped);
        this.segTrack = t ? t.number : 0;
    }

    getVolume(): number {
        return this.volume;
    }

    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.audioId && (this.mode === "playing" || this.mode === "paused")) {
            self.postMessage({ type: "audio_update", payload: { id: this.audioId, volume: this.volume } });
        }
    }

    /** Host playback-finished notification; ignores ids the drive does not own. */
    handleAudioEnded(id: number): boolean {
        if (!this.audioId || id !== this.audioId) return false;
        if (this.mode !== "playing") return true;

        const next = this.nextAudioTrackAfter(this.segTrack);
        if (next && next.startMs < this.playToMs) {
            this.startSegment(next, next.startMs);
            return true;
        }
        this.finishActive("finished");
        return true;
    }

    /** Host source-ready notification; applies a pause that arrived during async setup. */
    handleAudioStarted(id: number): boolean {
        if (!this.audioId || id !== this.audioId) return false;
        this.hostAudioStarted = true;
        if (this.mode === "paused") {
            self.postMessage({ type: "audio_pause", payload: { id } });
        } else if (this.mode === "playing") {
            this.segAnchorMs = performance.now();
        }
        return true;
    }

    /**
     * Host playback position for the active segment, in disc-relative milliseconds.
     * The element's clock is the ground truth: a mid-track start offset is best-effort
     * on the host (the seek may land before a seekable range exists), so the FIRST
     * report is what tells the drive where playback really began.
     */
    handleAudioPosition(id: number, positionMs: number): boolean {
        if (!this.audioId || id !== this.audioId) return false;
        if (this.mode !== "playing" || this.segTrack === 0) return true;
        const track = this.trackTable[this.segTrack - 1];
        if (!track) return true;

        const discMs = track.startMs + Math.max(0, positionMs);
        const drift = discMs - this.positionMs();
        if (!this.segPositionSynced && Math.abs(drift) > POSITION_SYNC_TOLERANCE_MS) {
            Logger.warn(LogCategory.SYSTEM,
                `VirtualCd: host started track ${track.number} at ${discMs | 0}ms, not ` +
                `${this.segStartDiscMs | 0}ms — retiming the transport onto the audio`);
            this.segStartDiscMs = discMs;
            this.pausedPositionMs = discMs;
            this.segAnchorMs = performance.now();
            this.armCompletionBackstop();
        } else if (Math.abs(drift) > POSITION_SYNC_TOLERANCE_MS) {
            this.segAnchorMs = performance.now() - Math.max(0, discMs - this.segStartDiscMs);
        }
        this.segPositionSynced = true;
        return true;
    }

    /** Host decode/playback failure; ignores ids owned by another audio module. */
    handleAudioError(id: number, error = "Unknown error"): boolean {
        if (!this.audioId || id !== this.audioId) return false;
        Logger.warn(LogCategory.SYSTEM, `VirtualCd: host playback failed for id=${id}: ${error}`);
        this.finishActive("aborted");
        return true;
    }

    reset(): void {
        this.finishActive("aborted");
        this.listeners.clear();
        this.invalidateDisc();
        this.mode = "stopped";
        this.volume = 1;
        this.segTrack = 0;
        this.segStartDiscMs = 0;
        this.segEndDiscMs = 0;
        this.pausedPositionMs = 0;
    }

    /** Diagnostic snapshot for paint-time guest-state logging. */
    formatDiagnosticSnapshot(): string {
        if (!this.scanned) return "cd=unscanned";
        if (this.trackTable.length === 0) return "cd=no-media";
        return `cd=[tracks=${this.trackTable.length} mode=${this.mode} track=${this.segTrack} ` +
            `pos=${this.positionMs() | 0}ms vol=${this.volume.toFixed(2)}]`;
    }

    // ==================== Private ====================

    private nextAudioTrackAfter(trackNumber: number): CdTrack | null {
        for (const t of this.trackTable) {
            if (t.number > trackNumber && t.isAudio) return t;
        }
        return null;
    }

    private startSegment(track: CdTrack, fromDiscMs: number): void {
        const trackEnd = track.startMs + track.lengthMs;
        this.segTrack = track.number;
        this.segStartDiscMs = fromDiscMs;
        this.segEndDiscMs = Math.min(trackEnd, this.playToMs > fromDiscMs ? this.playToMs : trackEnd);
        this.segAnchorMs = performance.now();
        this.pausedPositionMs = fromDiscMs;
        this.mode = "playing";
        this.audioId = this.nextAudioId++;
        this.pendingSegment = null;
        this.hostAudioPosted = false;
        this.hostAudioStarted = false;
        this.segPositionSynced = false;
        this.clearCompletionBackstop();
        void this.loadAndPost(track, fromDiscMs - track.startMs, this.segEndDiscMs - track.startMs,
            this.audioId, ++this.loadGeneration);
    }

    /**
     * Complete the request on the transport clock when the host never reports back.
     * finishActive("finished") is otherwise reachable only from audio_ended, so a track
     * the browser accepts into a Blob but cannot decode leaves the drive PLAYING forever
     * and MCI_NOTIFY never fires.
     */
    private armCompletionBackstop(): void {
        this.clearCompletionBackstop();
        const remaining = Math.max(0, this.segEndDiscMs - this.positionMs());
        this.backstopTimer = setTimeout(() => {
            this.backstopTimer = null;
            this.runCompletionBackstop();
        }, remaining + COMPLETION_BACKSTOP_GRACE_MS);
    }

    private clearCompletionBackstop(): void {
        if (this.backstopTimer === null) return;
        clearTimeout(this.backstopTimer);
        this.backstopTimer = null;
    }

    private runCompletionBackstop(): void {
        if (this.mode !== "playing" || !this.audioId) return;
        const left = this.segEndDiscMs - this.positionMs();
        if (left > 0) {
            this.armCompletionBackstop();
            return;
        }
        Logger.warn(LogCategory.SYSTEM,
            `VirtualCd: no audio_ended for id=${this.audioId} (track ${this.segTrack}) — ` +
            `completing on the transport clock`);
        this.handleAudioEnded(this.audioId);
    }

    private async loadAndPost(
        track: CdTrack,
        startOffsetMs: number,
        endOffsetMs: number,
        audioId: number,
        generation: number,
    ): Promise<void> {
        const data = await this.readTrackBytes(track, generation);
        if (generation !== this.loadGeneration || this.audioId !== audioId) return;
        if (!data || data.length === 0) {
            Logger.warn(LogCategory.SYSTEM, `VirtualCd: no data for track ${track.number} ("${track.file}")`);
            this.finishActive("aborted");
            return;
        }

        const loaded: LoadedCdSegment = {
            track,
            data,
            startOffsetMs,
            endOffsetMs,
            audioId,
        };
        if (this.mode === "paused") {
            this.pendingSegment = loaded;
            return;
        }
        this.postLoadedSegment(loaded);
    }

    private postLoadedSegment(segment: LoadedCdSegment): void {
        const { track, data, startOffsetMs, endOffsetMs, audioId } = segment;
        if (this.audioId !== audioId || this.mode !== "playing") return;

        // The buffer is ours (allocated in readTrackBytes), so it can be transferred
        // outright unless a short read left it oversized.
        const payloadData = data.byteLength === data.buffer.byteLength ? data : data.slice();
        self.postMessage({
            type: "audio_play_encoded",
            payload: {
                id: audioId,
                data: payloadData,
                mimeType: track.mimeType,
                playbackRate: 1.0,
                volume: this.volume,
                pan: 0,
                loopCount: 1,
                startOffsetMs,
                endOffsetMs: endOffsetMs > startOffsetMs ? endOffsetMs : undefined,
                // A CD track is tens of MB decoded; keep it on the host's streaming
                // path instead of decoding it into a PCM buffer.
                stream: true,
                // Report audio_position in ms rather than sample frames — the drive's
                // whole currency is milliseconds and it has no way to learn the host's
                // decoded sample rate.
                positionRateHz: CD_POSITION_RATE_HZ,
            },
        } as any, [payloadData.buffer] as any);
        this.hostAudioPosted = true;

        // Re-anchor on the post so the transport clock starts with the audio, not
        // with the (potentially async) file read.
        this.segAnchorMs = performance.now();
        this.armCompletionBackstop();
        Logger.log(LogCategory.SYSTEM,
            `VirtualCd: streaming track ${track.number} "${track.file}" ` +
            `(id=${audioId}, ${startOffsetMs | 0}..${endOffsetMs | 0}ms, ${data.length} bytes)`);
    }

    /**
     * Reads one track's bytes on demand — a disc's worth would not fit in memory. The
     * read is its OWN handle (never a guest file object) and yields the worker thread
     * between chunks, so a 30-60 MB track does not stall the guest and the audio pump
     * for the whole transfer.
     */
    private async readTrackBytes(track: CdTrack, generation: number): Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(track.file);
            if (size <= 0) return null;
            const handle = vfs.openSync(track.file, GENERIC_READ, OPEN_EXISTING)
                ?? await vfs.open(track.file, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;

            const out = new Uint8Array(size);
            let filled = 0;
            while (filled < size) {
                const want = Math.min(TRACK_READ_CHUNK_BYTES, size - filled);
                const chunk = vfs.readSync(handle, want) ?? await vfs.read(handle, want);
                if (!chunk || chunk.length === 0) break;
                out.set(chunk, filled);
                filled += chunk.length;
                if (filled >= size) break;
                await yieldToWorkerTurn();
                if (generation !== this.loadGeneration) return null;
            }
            return filled === size ? out : out.subarray(0, filled);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `VirtualCd: read "${track.file}" failed: ${e}`);
            return null;
        }
    }

    private finishActive(reason: CdStopReason): void {
        const token = this.token;
        const hadAudio = this.audioId;
        const hadHostAudio = this.hostAudioPosted;
        this.token = 0;
        this.audioId = 0;
        this.loadGeneration++;
        this.pendingSegment = null;
        this.hostAudioPosted = false;
        this.hostAudioStarted = false;
        this.segPositionSynced = false;
        this.clearCompletionBackstop();
        this.pausedPositionMs = this.positionMs();
        this.segStartDiscMs = this.pausedPositionMs;
        this.mode = this.trackTable.length > 0 ? "stopped" : "notReady";
        if (hadAudio && hadHostAudio) {
            self.postMessage({ type: "audio_stop", payload: { id: hadAudio } });
        }
        if (!token) return;
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(token, reason);
            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `VirtualCd: completion listener failed: ${e}`);
            }
        }
    }

    // ==================== Track discovery ====================

    private scan(): void {
        for (const root of this.searchRoots()) {
            const candidates = new Map<number, CdCandidate>();
            this.collectDisc(root, candidates);
            if (candidates.size > 0) {
                this.buildToc(candidates);
                return;
            }
        }
        Logger.log(LogCategory.SYSTEM, "VirtualCd: no CD-audio tracks found — drive reports no media");
    }

    /**
     * The install directory, then each ancestor up to the drive root. A game's cwd
     * is often a `bin`/`system` subdirectory while the ripped tracks sit beside the
     * install root, and the disc is not cwd-relative on real hardware either.
     */
    private searchRoots(): string[] {
        const cwd = System.getInstance().fileSystem.currentDir;
        const roots: string[] = [];
        let dir = cwd.replace(/\\+$/, "");
        while (dir.length > 2) {
            roots.push(dir);
            const cut = dir.lastIndexOf("\\");
            if (cut <= 2) break;
            dir = dir.slice(0, cut);
        }
        const drive = `${(cwd[0] ?? "C").toUpperCase()}:\\`;
        if (!roots.includes(drive)) roots.push(drive);
        return roots;
    }

    private collectDisc(root: string, candidates: Map<number, CdCandidate>): void {
        const vfs = System.getInstance().fileSystem;
        let entries: Array<{ name: string; kind: string; path: string }> = [];
        try {
            entries = vfs.listDirectory(root);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `VirtualCd: cannot list "${root}": ${e}`);
            return;
        }

        for (const entry of entries) {
            if (entry.kind === "dir") {
                if (MUSIC_DIR_NAMES.has(entry.name.toLowerCase())) {
                    this.collectFrom(entry.path, true, candidates);
                }
            } else {
                this.considerFile(entry.name, entry.path, false, candidates);
            }
        }
    }

    private buildToc(candidates: Map<number, CdCandidate>): void {
        const numbers = Array.from(candidates.keys()).sort((a, b) => a - b);
        const maxTrack = numbers[numbers.length - 1];
        this.trackTable = [];
        let startMs = 0;
        // Budgeted: this runs inside whatever guest call first asked about the drive.
        const probeDeadline = performance.now() + SYNC_PROBE_BUDGET_MS;
        for (let n = 1; n <= maxTrack; n++) {
            const hit = candidates.get(n);
            const probed = hit && performance.now() < probeDeadline ? this.probeDuration(hit.file) : 0;
            const lengthKnown = probed > 0;
            const lengthMs = hit ? (lengthKnown ? probed : UNKNOWN_TRACK_LENGTH_MS) : 0;
            this.trackTable.push({
                number: n,
                isAudio: !!hit,
                file: hit ? hit.file : "",
                mimeType: hit ? hit.mimeType : "",
                startMs,
                lengthMs,
                lengthKnown,
            });
            startMs += lengthMs;
        }

        const audioCount = this.trackTable.filter((t) => t.isAudio).length;
        Logger.log(LogCategory.SYSTEM,
            `VirtualCd: disc mounted — ${maxTrack} tracks (${audioCount} audio), ${this.discLengthMs() | 0}ms`);
    }

    private collectFrom(dirPath: string, inMusicDir: boolean, out: Map<number, CdCandidate>): void {
        const vfs = System.getInstance().fileSystem;
        let entries: Array<{ name: string; kind: string; path: string }> = [];
        try {
            entries = vfs.listDirectory(dirPath);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.kind === "dir") continue;
            this.considerFile(entry.name, entry.path, inMusicDir, out);
        }
    }

    /**
     * A bare `NN.ogg` only counts inside a music directory — at the game root it
     * would swallow unrelated numbered assets. `TrackNN.*` is unambiguous anywhere.
     */
    private considerFile(name: string, path: string, inMusicDir: boolean, out: Map<number, CdCandidate>): void {
        const dot = name.lastIndexOf(".");
        if (dot <= 0) return;
        const ext = name.slice(dot + 1).toLowerCase();
        const extIndex = TRACK_EXTENSIONS.findIndex((e) => e.ext === ext);
        if (extIndex < 0) return;

        const stem = name.slice(0, dot);
        const named = NAMED_TRACK_RE.exec(stem);
        const bare = inMusicDir ? BARE_TRACK_RE.exec(stem) : null;
        const digits = named?.[1] ?? bare?.[1];
        if (!digits) return;

        const number = parseInt(digits, 10);
        if (!Number.isFinite(number) || number < 1 || number > 99) return;

        const rank = (inMusicDir ? 0 : 100) + extIndex;
        const existing = out.get(number);
        if (existing && existing.rank <= rank) return;
        out.set(number, { file: path, mimeType: TRACK_EXTENSIONS[extIndex].mimeType, rank });
    }

    private probeDuration(file: string): number {
        try {
            const size = System.getInstance().fileSystem.getFileSize(file);
            if (size <= 0) return 0;
            const info = probeAudioStream(new VfsAudioSource(file, size));
            return info && info.durationMs > 0 ? Math.round(info.durationMs) : 0;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `VirtualCd: probe "${file}" failed: ${e}`);
            return 0;
        }
    }

    /**
     * Second pass for tracks whose bytes were not synchronously reachable (compressed
     * ROM entries, cold overlay files): pull the head/tail windows through the async
     * VFS path and re-probe.
     */
    private async refineDurations(): Promise<void> {
        if (this.refining) return;
        this.refining = true;
        this.refinePasses++;
        const active = this.segTrack > 0 ? this.trackTable[this.segTrack - 1] : undefined;
        const activeStart = active ? active.startMs : 0;
        const activeEnd = active ? active.startMs + active.lengthMs : 0;
        const discEnd = this.discLengthMs();
        try {
            let changed = false;
            for (const t of this.trackTable) {
                if (!t.isAudio || t.lengthKnown) continue;
                const size = System.getInstance().fileSystem.getFileSize(t.file);
                if (size <= 0) continue;
                const source = new VfsAudioSource(t.file, size);
                await source.prime();
                const info = probeAudioStream(source);
                if (!info || info.durationMs <= 0) continue;
                t.lengthMs = Math.round(info.durationMs);
                t.lengthKnown = true;
                changed = true;
            }
            if (!changed) return;
            this.recomputeStarts();
            if (active) this.retimeActiveSegment(active, activeStart, activeEnd, discEnd);
            Logger.log(LogCategory.SYSTEM,
                `VirtualCd: durations refined — disc length ${this.discLengthMs() | 0}ms`);
        } finally {
            this.refining = false;
        }
    }

    /**
     * Translate the running transport onto the recomputed timeline. Start times ARE the
     * disc timeline every adapter's position/seek arithmetic indexes, so they cannot be
     * left stale while lengths grow — the track ranges would overlap and trackAt() would
     * resolve a track's own start to its predecessor. Shifting by the active track's own
     * delta keeps the guest-visible position continuous across the recompute.
     */
    private retimeActiveSegment(track: CdTrack, oldStart: number, oldEnd: number, oldDiscEnd: number): void {
        const delta = track.startMs - oldStart;
        const newEnd = track.startMs + track.lengthMs;
        this.segStartDiscMs += delta;
        this.pausedPositionMs += delta;
        this.playToMs = this.playToMs >= oldDiscEnd ? this.discLengthMs() : this.playToMs + delta;
        // A segment that ran to the track's end still does; one with an explicit MCI_TO
        // keeps its own boundary.
        this.segEndDiscMs = this.segEndDiscMs >= oldEnd
            ? Math.min(newEnd, this.playToMs > this.segStartDiscMs ? this.playToMs : newEnd)
            : this.segEndDiscMs + delta;
        if (this.mode === "playing") this.armCompletionBackstop();
    }

    private recomputeStarts(): void {
        let startMs = 0;
        for (const t of this.trackTable) {
            t.startMs = startMs;
            startMs += t.lengthMs;
        }
    }
}

export function virtualCd(): VirtualCdAudio {
    return VirtualCdAudio.getInstance();
}
