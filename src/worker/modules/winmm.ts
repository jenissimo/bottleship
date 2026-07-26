import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { registerWinmmJoystickExports, resetWinmmJoystick } from "./winmm-joystick";
import { registerWinmmCapsExports } from "./winmm-caps";
import { registerWinmmMciExports } from "./winmm-mci";
import type { WinmmMci } from "./winmm-mci";
import { TimeService } from "../runtime/time";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { TimerKind } from "../core/scheduler/types";
import { findResourceInPE } from "./kernel32/resource";
import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    getCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_BUFFER_BYTES,
    CTRL_STATE,
    CTRL_LOOP_MODE,
    CTRL_VOLUME,
    CTRL_PAN,
    CTRL_DATA_LENGTH,
    CTRL_STOP_REQUESTED,
    CTRL_WRITE_CURSOR,
    CTRL_FLAGS,
    STATE_PLAYING,
    STATE_STOPPED,
    FLAG_CIRCULAR,
    FLAG_STREAMING,
} from "../../audio/audio-ring-buffer";
import { ensureAudioStatsSab } from "./audio-stats-sab";

const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_INVALPARAM = 11;
const MMSYSERR_ERROR = 1;
const TIME_ONESHOT = 0x0000;
const TIME_PERIODIC = 0x0001;
const TIME_CALLBACK_FUNCTION = 0x0000;
const TIME_CALLBACK_EVENT_SET = 0x0010;
const TIME_CALLBACK_EVENT_PULSE = 0x0020;
const TIME_CALLBACK_TYPEMASK = 0x0030;
const TIME_KILL_SYNCHRONOUS = 0x0100;
const DEBUG_WINMM_TIMER = true;
const JOYERR_NOERROR = 0;
const JOYERR_UNPLUGGED = 167;

// waveOut callback messages
const WOM_DONE = 0x3BD;

// waveOut callback type flags
const CALLBACK_NULL = 0x00000000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_TYPEMASK = 0x00070000;

// MMIO constants
const MMIO_READ = 0x00000000;
const MMIO_WRITE = 0x00000001;
const MMIO_READWRITE = 0x00000002;
const MMIO_ALLOCBUF = 0x00010000;
const MMIOERR_FILENOTFOUND = 257;
const MMIOERR_CANNOTOPEN = 259;
const MMIOERR_CANNOTREAD = 260;
const MMIOERR_CHUNKNOTFOUND = 266;
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

// MMIOINFO struct field byte-offsets (32-bit ABI). Direct memory-buffered I/O
// (mmioGetInfo/mmioAdvance/mmioSetInfo) reads/writes audio bytes straight through
// pchNext..pchEndRead; the DXSDK CWaveFile/DSUtil streaming-WAV reader relies on it.
const MMIOINFO_DWFLAGS    = 0;    // DWORD  dwFlags
const MMIOINFO_FCCIOPROC  = 4;    // FOURCC fccIOProc
const MMIOINFO_PIOPROC    = 8;    // LPMMIOPROC pIOProc
const MMIOINFO_WERRORRET  = 12;   // UINT   wErrorRet
const MMIOINFO_HTASK      = 16;   // HTASK  htask
const MMIOINFO_CCHBUFFER  = 20;   // LONG   cchBuffer  (buffer capacity)
const MMIOINFO_PCHBUFFER  = 24;   // HPSTR  pchBuffer  (start of I/O buffer)
const MMIOINFO_PCHNEXT    = 28;   // HPSTR  pchNext    (next byte to read/write)
const MMIOINFO_PCHENDREAD = 32;   // HPSTR  pchEndRead (one past last readable byte)
const MMIOINFO_PCHENDWRITE= 36;   // HPSTR  pchEndWrite
const MMIOINFO_LBUFOFFSET = 40;   // LONG   lBufOffset (file offset of pchBuffer)
const MMIOINFO_LDISKOFFSET= 44;   // LONG   lDiskOffset (file offset of next disk I/O)
const MMIOINFO_HMMIO      = 68;   // HMMIO  hmmio
const MMIOINFO_SIZE       = 72;   // sizeof(MMIOINFO)

// Default size of the rotating direct-I/O window we expose to the guest. Real
// Windows uses an internal 8KB buffer; a larger window cuts mmioAdvance churn.
const MMIO_GUEST_BUFSIZE  = 64 * 1024;
const FCC_DOS = 0x20534f44; // 'DOS ' — fccIOProc for a plain disk file

/** The MMIO direct-I/O buffering state an MMIOHandle carries (subset used by the
 *  pure helpers below). Kept structural so it's testable without the WinMM class. */
export interface MmioBufState {
    data: Uint8Array | null;
    position: number;
    guestBuffer?: number;
    guestBufferSize?: number;
    bufFileOffset?: number;
    bufFilled?: number;
}

/**
 * Copy a window of `state.data` starting at `state.position` into the already-allocated
 * guest buffer, recording how many bytes are live (bufFilled) and where the window starts
 * in the file (bufFileOffset). Returns the byte count (0 at EOF). Pure aside from Mem writes.
 */
export function mmioFillGuestWindow(state: MmioBufState): number {
    if (!state.data || !state.guestBuffer) return 0;
    const cap = state.guestBufferSize ?? MMIO_GUEST_BUFSIZE;
    const start = Math.max(0, Math.min(state.position, state.data.length));
    const n = Math.min(cap, state.data.length - start);
    if (n > 0) {
        Mem.writeBytes(state.guestBuffer, state.data.subarray(start, start + n));
    }
    state.bufFileOffset = start;
    state.bufFilled = n;
    return n;
}

/**
 * Write the MMIOINFO direct-I/O fields (buffer pointers + offsets) for `state`, assuming
 * its guest buffer is currently filled starting at state.bufFileOffset.
 */
export function mmioWriteInfoStruct(lpmmioinfo: number, hmmio: number, state: MmioBufState): void {
    const base = state.guestBuffer ?? 0;
    const filled = state.bufFilled ?? 0;
    const bufOff = state.bufFileOffset ?? 0;
    Mem.writeUint32(lpmmioinfo + MMIOINFO_DWFLAGS,    MMIO_READ | MMIO_ALLOCBUF);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_FCCIOPROC,  FCC_DOS);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_PIOPROC,    0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_WERRORRET,  0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_HTASK,      0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_CCHBUFFER,  state.guestBufferSize ?? 0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_PCHBUFFER,  base);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_PCHNEXT,    base);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_PCHENDREAD, (base + filled) >>> 0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_PCHENDWRITE,(base + filled) >>> 0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_LBUFOFFSET, bufOff);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_LDISKOFFSET,(bufOff + filled) >>> 0);
    Mem.writeUint32(lpmmioinfo + MMIOINFO_HMMIO,      hmmio);
}

/**
 * Commit the guest's read cursor (pchNext) from an MMIOINFO struct back into
 * state.position, so subsequent mmioRead/mmioDescend/mmioAscend stay consistent.
 */
export function mmioCommitInfoCursor(lpmmioinfo: number, state: MmioBufState): void {
    const base = state.guestBuffer ?? 0;
    if (!base) return;
    const next = (Mem.readUint32(lpmmioinfo + MMIOINFO_PCHNEXT) ?? base) >>> 0;
    const bufOff = state.bufFileOffset ?? 0;
    const consumed = Math.max(0, Math.min(next - base, state.bufFilled ?? 0));
    state.position = bufOff + consumed;
}

// PlaySound / sndPlaySound flags
const SND_SYNC        = 0x0000;
const SND_ASYNC       = 0x0001;
const SND_NODEFAULT   = 0x0002;
const SND_MEMORY      = 0x0004;
const SND_LOOP        = 0x0008;
const SND_NOSTOP      = 0x0010;
const SND_PURGE       = 0x0040;
const SND_FILENAME    = 0x20000;
const SND_RESOURCE    = 0x40004;
const RT_WAVE         = 10; // WAVE resources stored as RT_RCDATA

const WAVE_FORMAT_PCM = 1;
const WHDR_DONE = 0x00000001;
const WHDR_PREPARED = 0x00000002;
const WHDR_BEGINLOOP = 0x00000004;
const WHDR_ENDLOOP = 0x00000008;
const WHDR_INQUEUE = 0x00000010;

const WAVE_FORMAT_QUERY  = 0x0001;
const WAVE_FORMAT_DIRECT = 0x0008;

// Target queued-ahead depth (ms of audio in the SAB ring past the play cursor)
// maintained by early-completing interior buffers — see checkCompletions.
const WAVEOUT_DEVICE_LEAD_MS = 60;

const TIME_MS = 0x0001;
const TIME_SAMPLES = 0x0002;
const TIME_BYTES = 0x0004;

interface MMIOHandle {
    filename: string;
    position: number;
    data: Uint8Array | null;
    /** Guest-side I/O buffer for direct memory access (pchBuffer/pchNext/pchEndRead).
     *  Allocated lazily on first mmioGetInfo. Holds a rotating window of `data`. */
    guestBuffer?: number;
    /** Capacity of guestBuffer in bytes. */
    guestBufferSize?: number;
    /** File offset corresponding to guestBuffer[0] (MMIOINFO.lBufOffset). */
    bufFileOffset?: number;
    /** Valid bytes currently held in guestBuffer (pchEndRead - pchBuffer). */
    bufFilled?: number;
}

type TimerCallbackMode = "function" | "event_set" | "event_pulse";

interface WinMMTimer {
    wTimerID: number;       // Wine-style slot-based ID
    wheelId: number;        // TimerWheel timer ID for cancellation
    /** Guest TIME_PERIODIC flag. Collapsed self-rearm timers stay false here:
     *  they are one-shot at the WinMM API level even when represented by a
     *  periodic TimerWheel entry internally. */
    isPeriodic: boolean;
    mode: TimerCallbackMode;
    callbackOrEvent: number;
    dwUser: number;
    delayMs: number;
    /** Guest one-shot timer represented by a persistent periodic wheel entry. */
    collapsedSelfRearm?: boolean;
    /** Set by timeSetEvent inside the currently executing callback; consumed on fire. */
    rearmArmed?: boolean;
}

export interface PendingTimerCallback {
    callbackAddr: number;
    timerId: number;
    dwUser: number;
    sourceTimer?: WinMMTimer;
    /** If set, use these args directly instead of [timerId, 0, dwUser, 0, 0] */
    args?: number[];
}

interface WaveFormat {
    channels: number;
    sampleRate: number;
    avgBytesPerSec: number;
    blockAlign: number;
    bitsPerSample: number;
}

interface PendingWaveBuffer {
    pwh: number;          // guest WAVEHDR pointer
    endOffset: number;    // unwrapped byte offset where this buffer ends
}

interface WaveOutDevice {
    id: number;
    format: WaveFormat;
    callback: number;
    instance: number;
    flags: number;
    isPlaying: boolean;
    positionBytes: number;
    startTime: number;
    // Ring buffer (SAB)
    sab: SharedArrayBuffer | null;
    writeOffset: number; // Current write position in ring buffer (unwrapped)
    registered: boolean;
    // Play-cursor-based completion tracking
    pendingBuffers: PendingWaveBuffer[];
    lastPlayCursor: number;   // last read CTRL_PLAY_CURSOR (wrapped)
    playedBytes: number;      // total bytes consumed by worklet (unwrapped)
    completionPollerId: number; // setInterval id for periodic polling (0 = none)
    // Guest memory buffer for continuous sync (DMA-style streaming)
    guestLpData: number;        // guest address of the audio buffer
    guestBufferLength: number;  // size in bytes
    // True once a second waveOutWrite arrives: the app streams a pool of buffers
    // (normal waveOut usage). Galaxy-style DMA (single buffer rewritten in guest
    // memory, synced by syncGuestToSab) only applies while this is false.
    multiBuffer: boolean;
}

export class WinMM implements IModule {
    name = "winmm";
    exports: Record<string, ThunkImplementation> = {};
    private timers: Map<number, WinMMTimer> = new Map();
    private nextTimerId = 1;
    private mmioHandles: Map<number, MMIOHandle> = new Map();
    /** Diagnostic: snapshot of the last MMIOINFO our direct-I/O path wrote, so a
     *  harness can verify mmioGetInfo/mmioAdvance produce valid non-null buffer
     *  pointers even after the handle is closed. Read via getModule('winmm'). */
    public dbgLastMmioInfo: { fn: string; file: string; pchBuffer: number; pchNext: number; pchEndRead: number; bufFilled: number; position: number; count: number } | null = null;
    private dbgMmioInfoCount = 0;
    private recordMmioInfo(fn: string, lpmmioinfo: number, mmio: MMIOHandle): void {
        this.dbgMmioInfoCount++;
        this.dbgLastMmioInfo = {
            fn, file: mmio.filename,
            pchBuffer: (Mem.readUint32(lpmmioinfo + MMIOINFO_PCHBUFFER) ?? 0) >>> 0,
            pchNext: (Mem.readUint32(lpmmioinfo + MMIOINFO_PCHNEXT) ?? 0) >>> 0,
            pchEndRead: (Mem.readUint32(lpmmioinfo + MMIOINFO_PCHENDREAD) ?? 0) >>> 0,
            bufFilled: mmio.bufFilled ?? 0,
            position: mmio.position,
            count: this.dbgMmioInfoCount,
        };
    }
    private nextMMIOHandle = 1;
    /** MCI subsystem (device registry + AVI playback) — see winmm-mci.ts. Created in initialize(). */
    private mci: WinmmMci | null = null;
    private periodRefCounts: Map<number, number> = new Map();
    private waveOutDevices: Map<number, WaveOutDevice> = new Map();
    private nextWaveOutId = 0x20000000;

    // PlaySound state — only one sound at a time (per Win32 spec)
    private playSoundId: number = 0;
    private nextPlaySoundId = 0x50000000;
    private playSoundSab: SharedArrayBuffer | null = null;

    // Dedicated timer thread state
    public timerThreadId: number = 0;
    private timerThreadHandle: number = 0;
    public timerWakeEvent: number = 0;
    private pendingTimerCallbacks: PendingTimerCallback[] = [];
    /** Head index for O(1) dequeue — avoids Array.shift() on every timer callback (~100Hz). */
    private pendingTimerHead = 0;
    private dispatchingTimerCallback: WinMMTimer | null = null;
    /** Timer-fire counters by mode + setEvent wake count.
     *  lastUDelay = last RAW uDelay requested by timeSetEvent (pre-clamp); clampHits =
     *  count of requests with uDelay<=1 (a storm shows lastUDelay pinned at 0/1 with
     *  clampHits climbing in step with fireFunc). Diff fireFunc across two dbg.timers()
     *  calls (with wall time) to read fires/sec. */
    public dbgTimerStats = {
        fireFunc: 0, fireEventSet: 0, fireEventPulse: 0, waveDone: 0, wakeSet: 0,
        lastUDelay: -1, clampHits: 0,
        selfRearmCollapsed: 0, selfRearmRefresh: 0, selfRearmExpired: 0,
        selfRearmInFlightSkips: 0, selfRearmRecreated: 0, selfRearmDuplicateCreates: 0,
        callbackQueued: 0, wakeCoalesced: 0, wakeSkippedRunnableThread: 0, maxPendingCallbacks: 0,
        drainBatches: 0, drainCallbacks: 0, multiCallbackDrains: 0, maxDrainBatch: 0,
    };
    private timerCallbackDrainCount = 0;

    /** Snapshot of timer subsystem state for dbg.timers(). */
    getTimerDebugState(): any {
        const timers = Array.from(this.timers.values()).map((t) => ({
            id: t.wTimerID, mode: t.mode, periodic: t.isPeriodic, delayMs: t.delayMs,
            collapsedSelfRearm: !!t.collapsedSelfRearm, rearmArmed: !!t.rearmArmed,
            target: `0x${(t.callbackOrEvent >>> 0).toString(16)}`, dwUser: `0x${(t.dwUser >>> 0).toString(16)}`,
        }));
        return {
            timerThreadId: this.timerThreadId,
            timerWakeEvent: `0x${(this.timerWakeEvent >>> 0).toString(16)}`,
            pendingCallbacks: this.pendingTimerCallbacks.length - this.pendingTimerHead,
            activeTimers: timers,
            stats: this.dbgTimerStats,
        };
    }

    /**
     * Refill an MMIO handle's guest-side I/O buffer from `mmio.position`, allocating
     * the buffer on first use. Mirrors Windows' internal mmio buffering so the guest
     * can read audio bytes directly via pchBuffer..pchEndRead (mmioGetInfo/mmioAdvance).
     * Returns the number of bytes loaded (0 at EOF / on failure).
     */
    private mmioRefillGuestBuffer(mmio: MMIOHandle): number {
        if (!mmio.data) return 0;
        if (!mmio.guestBuffer) {
            const mem = System.getInstance().process?.memory;
            const cap = MMIO_GUEST_BUFSIZE;
            const ptr = mem?.alloc(cap, "HEAP", "rw") ?? 0;
            if (!ptr) {
                Logger.warn(LogCategory.SYSTEM, `mmio: failed to alloc ${cap}B guest I/O buffer`);
                return 0;
            }
            mmio.guestBuffer = ptr;
            mmio.guestBufferSize = cap;
        }
        return mmioFillGuestWindow(mmio);
    }

    private pendingQueueLength(): number {
        return this.pendingTimerCallbacks.length - this.pendingTimerHead;
    }

    private compactPendingQueue(): void {
        if (this.pendingTimerHead <= 0) return;
        if (this.pendingTimerHead >= this.pendingTimerCallbacks.length) {
            this.pendingTimerCallbacks.length = 0;
        } else {
            this.pendingTimerCallbacks = this.pendingTimerCallbacks.slice(this.pendingTimerHead);
        }
        this.pendingTimerHead = 0;
    }

    /**
     * Shift one pending callback off the queue (called by scheduler).
     */
    peekPendingCallback(): PendingTimerCallback | undefined {
        return this.pendingTimerCallbacks[this.pendingTimerHead];
    }

    shiftPendingCallback(): PendingTimerCallback | undefined {
        if (this.pendingTimerHead >= this.pendingTimerCallbacks.length) {
            this.compactPendingQueue();
            this.finishTimerCallbackDrain();
            this.clearDispatchingTimerCallbackIfIdle();
            return undefined;
        }
        const cb = this.pendingTimerCallbacks[this.pendingTimerHead++];
        if (this.pendingTimerHead > 32 && this.pendingTimerHead > (this.pendingTimerCallbacks.length >> 1)) {
            this.compactPendingQueue();
        }
        if (cb?.sourceTimer) {
            this.dispatchingTimerCallback = cb.sourceTimer;
        } else if (cb) {
            this.dispatchingTimerCallback = null;
        } else {
            this.finishTimerCallbackDrain();
            this.clearDispatchingTimerCallbackIfIdle();
        }
        if (cb) {
            this.timerCallbackDrainCount++;
            this.dbgTimerStats.drainCallbacks++;
            if (this.timerCallbackDrainCount > this.dbgTimerStats.maxDrainBatch) {
                this.dbgTimerStats.maxDrainBatch = this.timerCallbackDrainCount;
            }
        }
        return cb;
    }

    /**
     * Check if there are pending timer callbacks.
     */
    hasPendingCallbacks(): boolean {
        return this.pendingTimerHead < this.pendingTimerCallbacks.length;
    }

    private enqueueTimerCallback(cb: PendingTimerCallback): void {
        const wasEmpty = this.pendingQueueLength() === 0;
        this.pendingTimerCallbacks.push(cb);
        this.dbgTimerStats.callbackQueued++;
        if (this.pendingQueueLength() > this.dbgTimerStats.maxPendingCallbacks) {
            this.dbgTimerStats.maxPendingCallbacks = this.pendingQueueLength();
        }

        // The timer thread drains the queue until empty once it is awake. Re-setting
        // the auto-reset wake event for every callback only creates extra scheduler
        // work; a single signal for the 0->1 transition is enough.
        if (!wasEmpty) {
            this.dbgTimerStats.wakeCoalesced++;
            return;
        }

        const scheduler = System.getInstance().scheduler;
        if (scheduler && this.timerWakeEvent) {
            scheduler.setEvent(this.timerWakeEvent);
            this.dbgTimerStats.wakeSet++;
        }
    }

    private finishTimerCallbackDrain(): void {
        if (this.timerCallbackDrainCount === 0) return;
        this.dbgTimerStats.drainBatches++;
        if (this.timerCallbackDrainCount > 1) {
            this.dbgTimerStats.multiCallbackDrains++;
        }
        this.timerCallbackDrainCount = 0;
    }

    private clearDispatchingTimerCallbackIfIdle(): void {
        if (!this.dispatchingTimerCallback) return;
        if (!this.hasActiveTimerCallbackInFlight()) {
            this.dispatchingTimerCallback = null;
        }
    }

    private hasActiveTimerCallbackInFlight(): boolean {
        if (this.timerThreadId === 0) return false;
        const cbMgr = System.getInstance().process?.dispatcher?.callbackManager;
        return !!cbMgr?.hasInFlightCallbacksForThread?.(this.timerThreadId);
    }

    private isDispatchingTimer(timer: WinMMTimer): boolean {
        if (this.dispatchingTimerCallback !== timer) return false;
        if (this.hasActiveTimerCallbackInFlight()) return true;
        this.dispatchingTimerCallback = null;
        return false;
    }

    private getSelfRearmCandidate(callbackOrEvent: number, dwUser: number): WinMMTimer | null {
        const timer = this.dispatchingTimerCallback;
        if (!timer) return null;

        const scheduler = System.getInstance().scheduler;
        if (!scheduler || scheduler.getCurrentThreadId() !== this.timerThreadId || !this.hasActiveTimerCallbackInFlight()) {
            this.dispatchingTimerCallback = null;
            return null;
        }

        if (timer.mode !== "function" || timer.isPeriodic) return null;
        if (timer.rearmArmed) {
            // A second matching timeSetEvent inside the same callback is a real second
            // one-shot timer on Windows, not another refresh of the first rearm.
            this.dbgTimerStats.selfRearmDuplicateCreates++;
            return null;
        }
        if ((timer.callbackOrEvent >>> 0) !== (callbackOrEvent >>> 0)) return null;
        if ((timer.dwUser >>> 0) !== (dwUser >>> 0)) return null;
        return timer;
    }

    private forgetTimerPublicId(timer: WinMMTimer): void {
        if (this.timers.get(timer.wTimerID) === timer) {
            this.timers.delete(timer.wTimerID);
        }
    }

    private refreshSelfRearmTimer(
        newTimerId: number,
        callbackOrEvent: number,
        dwUser: number,
        delayMs: number,
        now: number,
    ): boolean {
        const timer = this.getSelfRearmCandidate(callbackOrEvent, dwUser);
        if (!timer) return false;

        const scheduler = System.getInstance().scheduler;
        this.forgetTimerPublicId(timer);
        timer.wTimerID = newTimerId;
        timer.callbackOrEvent = callbackOrEvent >>> 0;
        timer.dwUser = dwUser >>> 0;
        timer.delayMs = delayMs;
        timer.rearmArmed = true;

        if (timer.collapsedSelfRearm) {
            if (!scheduler.timerWheel.reschedule(timer.wheelId, delayMs, true, TimerKind.WINMM_TIMER, now)) {
                timer.wheelId = scheduler.timerWheel.add(
                    delayMs,
                    true,
                    TimerKind.WINMM_TIMER,
                    () => this.onTimerFire(timer),
                    now
                );
                this.dbgTimerStats.selfRearmRecreated++;
            } else {
                this.dbgTimerStats.selfRearmRefresh++;
            }
        } else {
            timer.collapsedSelfRearm = true;
            timer.wheelId = scheduler.timerWheel.add(
                delayMs,
                true,
                TimerKind.WINMM_TIMER,
                () => this.onTimerFire(timer),
                now
            );
            this.dbgTimerStats.selfRearmCollapsed++;
        }

        this.timers.set(newTimerId, timer);
        return true;
    }

    /**
     * Fast-path timeSetEvent: self-rearm refresh only (NFSU FUN_0063eaa0 hot path).
     * Returns timer id on success, null to fall through to full export.
     */
    fastPathTimeSetEvent(cpu: { reg32: number[] }, view: DataView): number | null {
        // A/B kill-switch: fall through to the full export so the self-rearm collapse can be
        // bisected out of a timer/audio regression. `dbgFlag('__noFastTimeSetEvent', true)`.
        if ((globalThis as any).__noFastTimeSetEvent) return null;
        const esp = cpu.reg32[4] >>> 0;
        const uDelay = view.getUint32(esp + 4, true);
        const fuEvent = view.getUint32(esp + 20, true);
        const callbackType = fuEvent & TIME_CALLBACK_TYPEMASK;

        if ((fuEvent & ~(TIME_PERIODIC | TIME_CALLBACK_TYPEMASK | TIME_KILL_SYNCHRONOUS)) !== 0) {
            return null;
        }
        if (callbackType !== TIME_CALLBACK_FUNCTION) return null;
        if ((fuEvent & TIME_PERIODIC) !== 0) return null;

        const callbackOrEvent = view.getUint32(esp + 12, true);
        const dwUser = view.getUint32(esp + 16, true);
        if (callbackOrEvent === 0) return null;

        const delayMs = Math.max(uDelay >>> 0, 1);

        const now = TimeService.getInstance().nowMs();
        const newTimerId = this.nextTimerId;
        if (!this.refreshSelfRearmTimer(newTimerId, callbackOrEvent, dwUser, delayMs, now)) {
            return null;
        }
        this.nextTimerId++;
        this.dbgTimerStats.lastUDelay = uDelay >>> 0;
        if (uDelay <= 1) this.dbgTimerStats.clampHits++;
        return newTimerId;
    }

    registerFastPathTimerFunctions(dispatcher: any): void {
        if (!dispatcher?.registerFastPath) return;
        const mod = this;
        dispatcher.registerFastPath(
            'winmm',
            'timeSetEvent',
            (cpu: { reg32: number[] }, _mem8: Uint8Array, _mem32: Uint32Array, view: DataView) =>
                mod.fastPathTimeSetEvent(cpu, view),
            { trivial: true },
        );
    }

    /**
     * Check if the worklet's play cursor has passed any pending buffer end offsets.
     * If so, fire WOM_DONE callbacks via the timer thread.
     */
    /**
     * Update playedBytes from the worklet's real play cursor (SAB atomic).
     */
    private updatePlayedBytes(device: WaveOutDevice): void {
        if (!device.sab) return;
        const playCursor = getCtrl(device.sab, CTRL_PLAY_CURSOR);
        const ringBytes = getCtrl(device.sab, CTRL_BUFFER_BYTES);
        // The worklet wraps its play cursor at the effective data window
        // (CTRL_DATA_LENGTH), not at the full ring size. Using ringBytes here
        // when DATA_LENGTH is smaller credits phantom bytes on every wrap
        // (131072-4000 per 4000-byte wrap), making playedBytes race ahead of
        // real consumption → instant WHDR_DONE → uncapped music/video clock.
        const dataLength = getCtrl(device.sab, CTRL_DATA_LENGTH);
        const wrapBytes = Math.min(dataLength > 0 ? dataLength : ringBytes, ringBytes);

        let delta: number;
        if (playCursor < device.lastPlayCursor) {
            delta = wrapBytes - device.lastPlayCursor + playCursor;
        } else {
            delta = playCursor - device.lastPlayCursor;
        }
        // DATA_LENGTH can shrink between polls (reset → new stream); never credit
        // a negative or wrap-confused delta.
        if (delta > 0) device.playedBytes += delta;
        device.lastPlayCursor = playCursor;
    }

    private checkCompletions(device: WaveOutDevice): void {
        if (!device.sab || device.pendingBuffers.length === 0) return;

        this.updatePlayedBytes(device);

        // WHDR_DONE = mixer-consumed (WDM contract), clocked by the real play cursor.
        // A buffer with a queued successor may complete up to WAVEOUT_DEVICE_LEAD_MS
        // early to absorb our completion-delivery latency; the LAST pending buffer
        // completes only at true playback end, so drain semantics stay exact.
        const ringBytes = getCtrl(device.sab, CTRL_BUFFER_BYTES);
        const lookAheadBytes = Math.ceil(device.format.avgBytesPerSec * 0.005);
        const leadBytes = Math.min(
            Math.ceil(device.format.avgBytesPerSec * (WAVEOUT_DEVICE_LEAD_MS / 1000)),
            ringBytes >> 2,
        );

        while (device.pendingBuffers.length > 0) {
            const pending = device.pendingBuffers[0];
            const unplayedThroughEnd = pending.endOffset - device.playedBytes;
            const threshold = device.pendingBuffers.length > 1 ? leadBytes : lookAheadBytes;
            if (unplayedThroughEnd <= threshold) {
                device.pendingBuffers.shift();

                // Set WHDR_DONE, clear WHDR_INQUEUE in guest memory
                const system = System.getInstance();
                const mem = system.process?.getCurrentMemory();
                if (mem) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    const hdrFlags = view.getUint32(pending.pwh + 16, true);
                    view.setUint32(pending.pwh + 16, (hdrFlags | WHDR_DONE) & ~WHDR_INQUEUE, true);
                }

                // Fire WOM_DONE via timer thread
                const callbackType = device.flags & CALLBACK_TYPEMASK;
                if (callbackType === CALLBACK_FUNCTION && device.callback) {
                    this.dbgTimerStats.waveDone++;
                    this.enqueueTimerCallback({
                        callbackAddr: device.callback,
                        timerId: device.id,
                        dwUser: device.instance,
                        args: [device.id, WOM_DONE, device.instance, pending.pwh, 0],
                    });
                }
            } else {
                break;
            }
        }
    }

    /**
     * DMA-style sync: re-copy guest memory buffer → SAB ring buffer.
     * Galaxy (UT) and similar drivers write new audio data directly into their
     * guest buffer ahead of the play cursor — we must keep the SAB in sync.
     * Also updates the write cursor so the worklet knows how far it can read.
     */
    private syncGuestToSab(device: WaveOutDevice): void {
        if (!device.sab || !device.guestLpData || !device.guestBufferLength) return;
        const system = System.getInstance();
        const mem = system.process?.getCurrentMemory();
        if (!mem) return;

        const ringBytes = getCtrl(device.sab, CTRL_BUFFER_BYTES);
        const blockAlign = device.format.blockAlign;
        const len = Math.min(device.guestBufferLength, ringBytes);

        // Re-copy entire guest buffer into the ring at offset 0.
        // Galaxy and similar drivers treat their buffer as a circular ring,
        // continuously writing new audio ahead of the play cursor.
        const src = mem.subarray(device.guestLpData, device.guestLpData + len);
        writeRingData(device.sab, 0, src, len);

        // Always keep write cursor ahead of play cursor by nearly the full buffer length.
        // Galaxy continuously fills the guest buffer, so the SAB always has fresh data.
        // Without this, after the initial waveOutWrite data is consumed, remaining=0
        // and the worklet permanently silences (never sees new data Galaxy wrote).
        // Write cursor wraps within guestBufferLength (not ringBytes) because
        // CTRL_DATA_LENGTH is set to the guest buffer size — the worklet only uses
        // that many bytes, avoiding silence from the zeroed tail of the larger ring.
        const playCursor = getCtrl(device.sab, CTRL_PLAY_CURSOR);
        const dataBytes = Math.min(len, ringBytes);
        const aheadBytes = dataBytes - blockAlign;
        let writeCursor = (playCursor + aheadBytes) % dataBytes;
        if (writeCursor === playCursor) writeCursor = (playCursor + blockAlign) % dataBytes;
        setCtrl(device.sab, CTRL_WRITE_CURSOR, writeCursor);
    }

    /**
     * Start periodic completion polling on the scheduler's virtual-time timer wheel.
     * A host setInterval would starve under a busy-spinning guest thread (5ms poll
     * never fires → WHDR_DONE never set → buffer-done wait deadlocks with audio
     * stalled). The timer wheel is polled in-band at scheduler boundaries + idle
     * pumps, so completions fire even under guest CPU monopolization (same fix
     * class as SetWaitableTimer/timeSetEvent).
     */
    private startCompletionPoller(device: WaveOutDevice): void {
        if (device.completionPollerId !== 0) return; // already polling
        const scheduler = System.getInstance().scheduler;
        if (!scheduler) {
            Logger.warn(LogCategory.SYSTEM, "winmm: scheduler unavailable at startCompletionPoller — waveOut completions disabled");
            return;
        }
        device.completionPollerId = scheduler.timerWheel.add(
            5, true, TimerKind.WINMM_TIMER,
            () => { this.syncGuestToSab(device); this.checkCompletions(device); },
            TimeService.getInstance().nowMs(),
        );
    }

    /**
     * Stop the completion poller for a device.
     */
    private stopCompletionPoller(device: WaveOutDevice): void {
        if (device.completionPollerId !== 0) {
            System.getInstance().scheduler?.timerWheel.cancel(device.completionPollerId);
            device.completionPollerId = 0;
        }
    }

    private timerDebug(message: string): void {
        if (DEBUG_WINMM_TIMER) {
            Logger.verbose(LogCategory.SYSTEM, `[winmm/timer] ${message}`);
        }
    }

    /**
     * Lazily create the dedicated timer thread on first timeSetEvent(TIME_CALLBACK_FUNCTION).
     */
    private ensureTimerThread(): void {
        if (this.timerThreadId !== 0) return;

        const system = System.getInstance();
        const scheduler = system.scheduler;
        const mem = system.process?.getCurrentMemory();
        if (!scheduler || !mem) return;

        // Create auto-reset wake event
        this.timerWakeEvent = scheduler.createEvent(false, false);

        // Get spin loop address from dispatcher
        const dispatcher = system.process?.dispatcher;
        const thunkMemMgr = (dispatcher as any)?.thunkMemoryManager;
        const spinLoopAddress = thunkMemMgr?.getRegions()?.spinLoopAddress ?? 0;
        if (spinLoopAddress === 0) {
            Logger.error(LogCategory.SYSTEM, `[winmm] Cannot create timer thread: no spin loop address`);
            return;
        }

        // Create timer thread (64KB stack, not suspended)
        const handle = scheduler.createThread(spinLoopAddress, 0, 65536, 0, 0, mem);
        if (handle === 0) {
            Logger.error(LogCategory.SYSTEM, `[winmm] Failed to create timer thread`);
            return;
        }

        // Find the thread ID of the just-created thread (it's the latest one)
        // The createThread returns a handle, we need the thread ID
        const allThreads = scheduler.getAllThreadInfo();
        let maxId = 0;
        for (const t of allThreads) {
            if (t.id > maxId) maxId = t.id;
        }
        this.timerThreadId = maxId;
        this.timerThreadHandle = handle;

        // Immediately block the timer thread on the wake event
        scheduler.blockTimerThread(this.timerThreadId, this.timerWakeEvent);
        scheduler.notifyWinmmTimerThread(this.timerThreadId, this.timerWakeEvent);

        this.timerDebug(`Timer thread created: id=${this.timerThreadId} handle=0x${handle.toString(16)} wakeEvent=0x${this.timerWakeEvent.toString(16)}`);
    }

    /**
     * Ensure the shared timer-pump thread exists. Callable from a thunk context by other
     * modules (kernel32 timer-queue / thread-pool) so the pump thread is created eagerly at
     * timer-registration time, not lazily inside a wheel fire.
     */
    ensureCallbackPumpThread(): void {
        this.ensureTimerThread();
    }

    /**
     * Post an arbitrary guest callback (address + stdcall args) onto the shared timer-pump
     * thread. Used by kernel32 timer-queue / thread-pool timers, which — like timeSetEvent
     * TIME_CALLBACK_FUNCTION — must run a guest callback asynchronously from a wheel fire.
     * The callback is self-cleaning stdcall (dispatch passes callerCleanup=0). No-op if the
     * pump could not be created.
     */
    postGuestCallback(callbackAddr: number, args: number[]): void {
        if (!callbackAddr) return;
        this.ensureTimerThread();
        if (this.timerThreadId === 0) return;
        this.enqueueTimerCallback({ callbackAddr, timerId: 0, dwUser: 0, args });
    }

    /**
     * Called when a timer fires (from timerWheel callback).
     */
    private onTimerFire(timer: WinMMTimer): void {
        if (timer.collapsedSelfRearm) {
            if (!timer.rearmArmed) {
                if (this.isDispatchingTimer(timer)) {
                    this.dbgTimerStats.selfRearmInFlightSkips++;
                    return;
                }
                System.getInstance().scheduler.timerWheel.cancel(timer.wheelId);
                this.forgetTimerPublicId(timer);
                this.dbgTimerStats.selfRearmExpired++;
                this.timerDebug(`self-rearm timer expired target=0x${timer.callbackOrEvent.toString(16)}`);
                return;
            }
            timer.rearmArmed = false;
        }

        // One-shot timers fire exactly once: the wheel won't call back again, so the
        // record is dead. Reclaim it now — some titles re-arm a fresh one-shot
        // timeSetEvent every fire and never call timeKillEvent, so without this
        // `this.timers` grows unbounded (dead entries / leak).
        // Periodic timers re-fire the same wheelId → must NOT be deleted here.
        // Collapsed self-rearm timers intentionally keep isPeriodic=false despite
        // using a periodic wheel entry: each guest-visible one-shot id expires
        // unless the callback explicitly re-arms it.
        if (!timer.isPeriodic) {
            this.forgetTimerPublicId(timer);
        }

        if (timer.mode === 'function') {
            this.dbgTimerStats.fireFunc++;
            // Queue for dedicated timer thread
            this.enqueueTimerCallback({
                callbackAddr: timer.callbackOrEvent,
                timerId: timer.wTimerID,
                dwUser: timer.dwUser,
                sourceTimer: timer,
            });
        } else if (timer.mode === 'event_set') {
            this.dbgTimerStats.fireEventSet++;
            const ok = System.getInstance().scheduler.setEvent(timer.callbackOrEvent);
            this.timerDebug(`timer#${timer.wTimerID} event_set handle=0x${timer.callbackOrEvent.toString(16)} ok=${ok ? 1 : 0}`);
        } else if (timer.mode === 'event_pulse') {
            this.dbgTimerStats.fireEventPulse++;
            const sched = System.getInstance().scheduler;
            sched.setEvent(timer.callbackOrEvent);
            sched.resetEvent(timer.callbackOrEvent);
        }
    }

    private readWaveFormat(mem: Uint8Array, ptr: number): WaveFormat {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return {
            channels: view.getUint16(ptr + 2, true),
            sampleRate: view.getUint32(ptr + 4, true),
            avgBytesPerSec: view.getUint32(ptr + 8, true),
            blockAlign: view.getUint16(ptr + 12, true),
            bitsPerSample: view.getUint16(ptr + 14, true),
        };
    }

    private convertPCMToFloat(data: Uint8Array, format: WaveFormat): Float32Array {
        const bytesPerSample = format.bitsPerSample >> 3;
        const frames = Math.floor(data.byteLength / format.blockAlign);
        const out = new Float32Array(frames * format.channels);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        for (let i = 0; i < frames; i++) {
            for (let ch = 0; ch < format.channels; ch++) {
                const offset = i * format.blockAlign + ch * bytesPerSample;
                let val = 0;
                if (format.bitsPerSample === 16) {
                    val = view.getInt16(offset, true) / 32768.0;
                } else if (format.bitsPerSample === 8) {
                    val = (data[offset] - 128) / 128.0;
                }
                out[i * format.channels + ch] = val;
            }
        }
        return out;
    }

    private readAnsiString(ptr: number, maxLen: number): string {
        if (!ptr || maxLen <= 0) return "";
        let out = "";
        for (let i = 0; i < maxLen; i++) {
            const ch = Mem.readUint8(ptr + i);
            if (ch == null || ch === 0) break;
            out += String.fromCharCode(ch);
        }
        return out;
    }

    private writeAnsiString(ptr: number, cch: number, value: string): boolean {
        if (!ptr) return true;
        if (cch <= 0) return false;
        const bytes = new TextEncoder().encode(value);
        const copyLen = Math.max(0, Math.min(bytes.length, cch - 1));
        if (copyLen > 0 && Mem.writeBytes(ptr, bytes.subarray(0, copyLen)) !== copyLen) {
            return false;
        }
        return Mem.writeBytes(ptr + copyLen, new Uint8Array([0])) === 1;
    }

    private readWideString(ptr: number, maxLen: number): string {
        if (!ptr || maxLen <= 0) return "";
        let out = "";
        for (let i = 0; i < maxLen; i++) {
            const ch = Mem.readUint16(ptr + i * 2);
            if (ch == null || ch === 0) break;
            out += String.fromCharCode(ch);
        }
        return out;
    }

    private writeWideString(ptr: number, cch: number, value: string): boolean {
        if (!ptr) return true;
        if (cch <= 0) return false;
        const copyLen = Math.max(0, Math.min(value.length, cch - 1));
        for (let i = 0; i < copyLen; i++) {
            if (!Mem.writeUint16(ptr + i * 2, value.charCodeAt(i))) return false;
        }
        return Mem.writeUint16(ptr + copyLen * 2, 0);
    }

    private waveOutErrorText(mmrError: number): string {
        const known: Record<number, string> = {
            [MMSYSERR_NOERROR]: "No error",
            [MMSYSERR_ERROR]: "Unspecified error",
            [MMSYSERR_BADDEVICEID]: "The specified device identifier is out of range.",
            [MMSYSERR_INVALPARAM]: "The specified parameter is invalid.",
        };
        return known[mmrError] ?? `Wave output error ${mmrError}`;
    }

    /**
     * Parse a RIFF/WAV header from guest memory.
     * Returns format info and data offset/size, or null on failure.
     */
    private parseWavFromMemory(mem: Uint8Array, ptr: number, maxLen: number): {
        channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number;
        dataOffset: number; dataSize: number;
    } | null {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (maxLen < 44) return null;

        // RIFF header
        const riffId = (view.getUint8(ptr) << 24) | (view.getUint8(ptr + 1) << 16) |
                       (view.getUint8(ptr + 2) << 8) | view.getUint8(ptr + 3);
        if (riffId !== 0x52494646) return null; // "RIFF"

        const waveId = (view.getUint8(ptr + 8) << 24) | (view.getUint8(ptr + 9) << 16) |
                       (view.getUint8(ptr + 10) << 8) | view.getUint8(ptr + 11);
        if (waveId !== 0x57415645) return null; // "WAVE"

        // Walk chunks starting at offset 12
        let off = ptr + 12;
        const end = ptr + maxLen;
        let channels = 0, sampleRate = 0, bitsPerSample = 0, blockAlign = 0;
        let dataOffset = 0, dataSize = 0;
        let foundFmt = false;

        while (off + 8 <= end) {
            const chunkId = (view.getUint8(off) << 24) | (view.getUint8(off + 1) << 16) |
                            (view.getUint8(off + 2) << 8) | view.getUint8(off + 3);
            const chunkSize = view.getUint32(off + 4, true);

            if (chunkId === 0x666D7420) { // "fmt "
                if (chunkSize < 16 || off + 8 + 16 > end) return null;
                const format = view.getUint16(off + 8, true);
                if (format !== WAVE_FORMAT_PCM) {
                    Logger.warn(LogCategory.SYSTEM, `PlaySound: unsupported WAV format ${format} (only PCM)`);
                    return null;
                }
                channels = view.getUint16(off + 10, true);
                sampleRate = view.getUint32(off + 12, true);
                blockAlign = view.getUint16(off + 20, true);
                bitsPerSample = view.getUint16(off + 22, true);
                foundFmt = true;
            } else if (chunkId === 0x64617461) { // "data"
                dataOffset = off + 8;
                dataSize = chunkSize;
            }

            // Advance to next chunk (pad to even boundary)
            off += 8 + ((chunkSize + 1) & ~1);
        }

        if (!foundFmt || dataSize === 0 || dataOffset === 0) return null;
        // Clamp data to available memory
        if (dataOffset + dataSize > end) dataSize = end - dataOffset;

        return { channels, sampleRate, bitsPerSample, blockAlign, dataOffset, dataSize };
    }

    /**
     * Stop any currently playing PlaySound/sndPlaySound.
     */
    private stopPlaySound(): void {
        if (this.playSoundSab) {
            setCtrl(this.playSoundSab, CTRL_STOP_REQUESTED, 1);
            self.postMessage({ type: "audio_unregister", payload: { id: this.playSoundId } });
            this.playSoundSab = null;
            this.playSoundId = 0;
        }
    }

    /**
     * Core PlaySound implementation shared by PlaySoundA, PlaySoundW, sndPlaySoundA.
     */
    private doPlaySound(mem: Uint8Array, pszSound: number, hmod: number, fdwSound: number, nameOverride?: string): number {
        // SND_PURGE or NULL sound → stop current
        if (!pszSound || (fdwSound & SND_PURGE)) {
            this.stopPlaySound();
            if (!pszSound) return 1;
        }

        // Stop previous before playing new (unless SND_NOSTOP)
        if (this.playSoundSab && (fdwSound & SND_NOSTOP)) {
            return 0; // FALSE — currently playing and caller said don't stop
        }
        this.stopPlaySound();

        let wavInfo: ReturnType<WinMM['parseWavFromMemory']> = null;

        if (fdwSound & SND_MEMORY) {
            // pszSound points directly to WAV data in memory
            // We don't know exact size, scan up to 16MB
            wavInfo = this.parseWavFromMemory(mem, pszSound, 16 * 1024 * 1024);
            if (!wavInfo) {
                Logger.warn(LogCategory.SYSTEM, `PlaySound: SND_MEMORY — failed to parse WAV at 0x${pszSound.toString(16)}`);
                return (fdwSound & SND_NODEFAULT) ? 0 : 1;
            }
        } else if (fdwSound & SND_RESOURCE) {
            // pszSound is resource name/ID, hmod is module handle
            const moduleBase = hmod || (System.getInstance().process?.moduleRegistry.getByName("")?.baseAddress ?? 0);
            if (!moduleBase) {
                Logger.warn(LogCategory.SYSTEM, `PlaySound: SND_RESOURCE — no module`);
                return 0;
            }

            // Resource name: if low word only, it's an integer ID; otherwise string
            let resourceName: number | string;
            if ((pszSound & 0xFFFF0000) === 0) {
                resourceName = pszSound;
            } else {
                resourceName = nameOverride ?? this.readAnsiString(pszSound, 256);
            }

            // RT_RCDATA (10) is where WAVE resources are typically stored
            const entry = findResourceInPE(mem, moduleBase, RT_WAVE, resourceName);
            if (!entry) {
                Logger.warn(LogCategory.SYSTEM, `PlaySound: SND_RESOURCE — resource "${resourceName}" not found`);
                return (fdwSound & SND_NODEFAULT) ? 0 : 1;
            }

            const dataPtr = moduleBase + entry.dataRVA;
            wavInfo = this.parseWavFromMemory(mem, dataPtr, entry.size);
            if (!wavInfo) {
                Logger.warn(LogCategory.SYSTEM, `PlaySound: SND_RESOURCE — WAV parse failed for "${resourceName}"`);
                return (fdwSound & SND_NODEFAULT) ? 0 : 1;
            }
        } else {
            // SND_FILENAME or registry alias — read sound name
            let soundName: string;
            if (nameOverride) {
                soundName = nameOverride;
            } else if (fdwSound & SND_FILENAME) {
                soundName = this.readAnsiString(pszSound, 260);
            } else {
                soundName = this.readAnsiString(pszSound, 256);
            }
            Logger.verbose(LogCategory.SYSTEM, `PlaySound: file/alias "${soundName}" — not supported yet`);
            return (fdwSound & SND_NODEFAULT) ? 0 : 1;
        }

        // We have valid WAV data — create ring buffer and play
        const id = this.nextPlaySoundId++;
        const ringBytes = Math.max(wavInfo.dataSize, 4096);
        const sab = createAudioRingBuffer(ringBytes, {
            channels: wavInfo.channels,
            sampleRate: wavInfo.sampleRate,
            bitsPerSample: wavInfo.bitsPerSample,
        }, false /* linear */);

        // Copy PCM data into ring buffer
        const pcmData = mem.subarray(wavInfo.dataOffset, wavInfo.dataOffset + wavInfo.dataSize);
        writeRingData(sab, 0, pcmData, wavInfo.dataSize);
        setCtrl(sab, CTRL_DATA_LENGTH, wavInfo.dataSize);

        // Looping
        if (fdwSound & SND_LOOP) {
            setCtrl(sab, CTRL_LOOP_MODE, -1); // loop forever
        } else {
            setCtrl(sab, CTRL_LOOP_MODE, 1);  // play once
        }

        // Register and play
        self.postMessage({ type: "audio_register", payload: { id, sab } });
        setCtrl(sab, CTRL_STATE, STATE_PLAYING);

        this.playSoundId = id;
        this.playSoundSab = sab;

        Logger.log(LogCategory.SYSTEM,
            `PlaySound: playing id=${id}, ${wavInfo.channels}ch ${wavInfo.sampleRate}Hz ` +
            `${wavInfo.bitsPerSample}bit, ${wavInfo.dataSize} bytes` +
            ((fdwSound & SND_LOOP) ? ' [LOOP]' : '') +
            ((fdwSound & SND_ASYNC) ? ' [ASYNC]' : ''));

        return 1; // TRUE
    }

    initialize(process: Process): void {

        this.exports["timeGetTime"] = () => {
            return TimeService.getInstance().nowMs() | 0;
        };

        this.exports["timeGetDevCaps"] = (ctx, mem, args) => {
            const ptc = args[0];
            const cbtc = args[1];
            if (!ptc || cbtc < 8 || ptc + 8 > mem.length) {
                return MMSYSERR_INVALPARAM;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ptc + 0, 1, true);    // wPeriodMin
            view.setUint32(ptc + 4, 1000, true); // wPeriodMax
            return MMSYSERR_NOERROR;
        };

        this.exports["timeBeginPeriod"] = (ctx, mem, args) => {
            const uPeriod = args[0] >>> 0;
            if (uPeriod < 1 || uPeriod > 1000) {
                this.timerDebug(`timeBeginPeriod(${uPeriod}) -> MMSYSERR_INVALPARAM`);
                return MMSYSERR_INVALPARAM;
            }
            this.periodRefCounts.set(uPeriod, (this.periodRefCounts.get(uPeriod) ?? 0) + 1);
            this.timerDebug(`timeBeginPeriod(${uPeriod}) -> MMSYSERR_NOERROR`);
            return MMSYSERR_NOERROR;
        };

        this.exports["timeEndPeriod"] = (ctx, mem, args) => {
            const uPeriod = args[0] >>> 0;
            if (uPeriod < 1 || uPeriod > 1000) {
                this.timerDebug(`timeEndPeriod(${uPeriod}) -> MMSYSERR_INVALPARAM`);
                return MMSYSERR_INVALPARAM;
            }
            const refCount = this.periodRefCounts.get(uPeriod) ?? 0;
            if (refCount <= 0) {
                this.timerDebug(`timeEndPeriod(${uPeriod}) refCount=0 -> MMSYSERR_INVALPARAM`);
                return MMSYSERR_INVALPARAM;
            }
            if (refCount === 1) {
                this.periodRefCounts.delete(uPeriod);
            } else {
                this.periodRefCounts.set(uPeriod, refCount - 1);
            }
            this.timerDebug(`timeEndPeriod(${uPeriod}) -> MMSYSERR_NOERROR`);
            return MMSYSERR_NOERROR;
        };

        this.exports["timeSetEvent"] = (ctx, mem, args) => {
            const uDelay = args[0] >>> 0;
            const uResolution = args[1] >>> 0;
            const callbackOrEvent = args[2] >>> 0;
            const dwUser = args[3] >>> 0;
            const fuEvent = args[4] >>> 0;
            const callbackType = fuEvent & TIME_CALLBACK_TYPEMASK;

            // Some games set TIME_KILL_SYNCHRONOUS (0x0100) on Win9x/NT paths.
            // We accept and ignore it to match permissive WinMM behavior.
            if ((fuEvent & ~(TIME_PERIODIC | TIME_CALLBACK_TYPEMASK | TIME_KILL_SYNCHRONOUS)) !== 0) {
                Logger.warn(LogCategory.SYSTEM, `timeSetEvent: unsupported flags=0x${fuEvent.toString(16)}`);
                this.timerDebug(`timeSetEvent reject: unsupported flags=0x${fuEvent.toString(16)}`);
                return 0;
            }

            let mode: TimerCallbackMode;
            if (callbackType === TIME_CALLBACK_FUNCTION) {
                mode = "function";
            } else if (callbackType === TIME_CALLBACK_EVENT_SET) {
                mode = "event_set";
            } else if (callbackType === TIME_CALLBACK_EVENT_PULSE) {
                mode = "event_pulse";
            } else {
                Logger.warn(LogCategory.SYSTEM, `timeSetEvent: unsupported callback type flags=0x${fuEvent.toString(16)}`);
                this.timerDebug(`timeSetEvent reject: callbackType=0x${callbackType.toString(16)} flags=0x${fuEvent.toString(16)}`);
                return 0;
            }

            if (callbackOrEvent === 0) {
                Logger.warn(LogCategory.SYSTEM, `timeSetEvent: null callback/event handle`);
                this.timerDebug(`timeSetEvent reject: null callback/event`);
                return 0;
            }

            // Lazily create the timer thread for FUNCTION callbacks
            if (mode === "function") {
                this.ensureTimerThread();
            }

            const isPeriodic = (fuEvent & TIME_PERIODIC) !== 0;
            const delayMs = Math.max(uDelay, 1);
            // Capture the raw requested delay before clamping (timer-storm telemetry).
            this.dbgTimerStats.lastUDelay = uDelay;
            if (uDelay <= 1) this.dbgTimerStats.clampHits++;
            const timerId = this.nextTimerId++;

            Logger.verbose(
                LogCategory.SYSTEM,
                `timeSetEvent: delay=${delayMs}ms, resolution=${uResolution}, target=0x${callbackOrEvent.toString(16)}, user=0x${dwUser.toString(16)}, flags=0x${fuEvent.toString(16)}`
            );
            this.timerDebug(`timeSetEvent accept: id=${timerId} mode=${mode} periodic=${isPeriodic ? 1 : 0} delay=${delayMs} target=0x${callbackOrEvent.toString(16)} flags=0x${fuEvent.toString(16)}`);

            // Register with timerWheel instead of host setTimeout/setInterval
            const now = TimeService.getInstance().nowMs();
            const scheduler = System.getInstance().scheduler;

            if (mode === "function" && !isPeriodic && this.refreshSelfRearmTimer(timerId, callbackOrEvent, dwUser, delayMs, now)) {
                this.timerDebug(`timeSetEvent self-rearm refresh: id=${timerId} delay=${delayMs} target=0x${callbackOrEvent.toString(16)}`);
                return timerId;
            }

            const timerState: WinMMTimer = {
                wTimerID: timerId,
                wheelId: 0,
                isPeriodic,
                mode,
                callbackOrEvent,
                dwUser,
                delayMs,
            };
            timerState.wheelId = scheduler.timerWheel.add(
                delayMs,
                isPeriodic,
                TimerKind.WINMM_TIMER,
                () => this.onTimerFire(timerState),
                now
            );

            this.timers.set(timerId, timerState);
            return timerId;
        };

        this.exports["timeKillEvent"] = (ctx, mem, args) => {
            const uTimerId = args[0];
            const timer = this.timers.get(uTimerId);
            if (timer) {
                // Cancel timerWheel entry
                System.getInstance().scheduler.timerWheel.cancel(timer.wheelId);
                // Remove any pending callbacks for this timer
                this.compactPendingQueue();
                this.pendingTimerCallbacks = this.pendingTimerCallbacks.filter(
                    cb => cb.timerId !== uTimerId && cb.sourceTimer !== timer
                );
                if (this.dispatchingTimerCallback === timer && !this.hasActiveTimerCallbackInFlight()) {
                    this.dispatchingTimerCallback = null;
                }
                this.timers.delete(uTimerId);
                this.timerDebug(`timeKillEvent(${uTimerId}) -> MMSYSERR_NOERROR`);
                return MMSYSERR_NOERROR;
            }
            this.timerDebug(`timeKillEvent(${uTimerId}) -> MMSYSERR_INVALPARAM`);
            return MMSYSERR_INVALPARAM;
        };

        // ==================== Wave Output Functions ====================

        this.exports["waveOutOpen"] = (ctx, mem, args) => {
            const phwo = args[0];
            const uDeviceID = args[1];
            const pwfx = args[2];
            const dwCallback = args[3];
            const dwInstance = args[4];
            const fdwOpen = args[5];

            const format = this.readWaveFormat(mem, pwfx);
            Logger.log(LogCategory.SYSTEM, `waveOutOpen: phwo=0x${phwo.toString(16)}, deviceId=${uDeviceID}, callback=0x${dwCallback.toString(16)}, flags=0x${fdwOpen.toString(16)}, fmt=${format.sampleRate}Hz/${format.bitsPerSample}bit/${format.channels}ch blockAlign=${format.blockAlign}`);

            // WAVE_FORMAT_QUERY: just check format support, don't create device
            if (fdwOpen & WAVE_FORMAT_QUERY) {
                Logger.log(LogCategory.SYSTEM, `waveOutOpen: FORMAT_QUERY — format supported, no device created`);
                return MMSYSERR_NOERROR;
            }

            const hwo = this.nextWaveOutId++;

            // Create SAB ring buffer (circular + streaming for waveOut)
            // 128KB ring — must be large enough that CALLBACK_NULL games (which get
            // immediate WHDR_DONE and resubmit instantly) can't lap the play cursor.
            // Typical pool: 16 buffers × 4000 bytes = 64KB; 128KB gives 2× headroom.
            const ringBytes = 131072;
            const sab = createAudioRingBuffer(ringBytes, {
                channels: format.channels,
                sampleRate: format.sampleRate,
                bitsPerSample: format.bitsPerSample,
            }, true /* circular for streaming waveOut */);
            // Mark as streaming so worklet outputs silence when caught up
            setCtrl(sab, CTRL_FLAGS, FLAG_CIRCULAR | FLAG_STREAMING);
            // Fixed ring size — streaming uses WRITE_CURSOR for boundary, not DATA_LENGTH
            setCtrl(sab, CTRL_DATA_LENGTH, ringBytes);

            const device: WaveOutDevice = {
                id: hwo,
                format,
                callback: dwCallback,
                instance: dwInstance,
                flags: fdwOpen,
                isPlaying: false,
                positionBytes: 0,
                startTime: 0,
                sab,
                writeOffset: 0,
                registered: false,
                pendingBuffers: [],
                lastPlayCursor: 0,
                playedBytes: 0,
                completionPollerId: 0,
                guestLpData: 0,
                guestBufferLength: 0,
                multiBuffer: false,
            };
            this.waveOutDevices.set(hwo, device);

            // Register with audio engine
            ensureAudioStatsSab();
            self.postMessage({ type: "audio_register", payload: { id: device.id, sab } });
            device.registered = true;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (phwo) view.setUint32(phwo, hwo, true);

            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutClose"] = (ctx, mem, args) => {
            const hwo = args[0];
            Logger.log(LogCategory.SYSTEM, `waveOutClose: hwo=0x${hwo.toString(16)}`);
            const device = this.waveOutDevices.get(hwo);
            if (device) {
                this.stopCompletionPoller(device);
                device.pendingBuffers.length = 0;
                if (device.registered) {
                    self.postMessage({ type: "audio_unregister", payload: { id: device.id } });
                    device.registered = false;
                }
                this.waveOutDevices.delete(hwo);
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutPrepareHeader"] = (ctx, mem, args) => {
            const hwo = args[0];
            const pwh = args[1];
            Logger.verbose(LogCategory.SYSTEM, `waveOutPrepareHeader: hwo=0x${hwo.toString(16)}, pwh=0x${pwh.toString(16)}`);
            if (pwh) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const flags = view.getUint32(pwh + 16, true);
                view.setUint32(pwh + 16, flags | WHDR_PREPARED, true);
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutUnprepareHeader"] = (ctx, mem, args) => {
            const hwo = args[0];
            const pwh = args[1];
            Logger.verbose(LogCategory.SYSTEM, `waveOutUnprepareHeader: hwo=0x${hwo.toString(16)}, pwh=0x${pwh.toString(16)}`);
            if (pwh) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const flags = view.getUint32(pwh + 16, true);
                view.setUint32(pwh + 16, flags & ~WHDR_PREPARED, true);
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutWrite"] = (ctx, mem, args) => {
            const hwo = args[0];
            const pwh = args[1];
            const device = this.waveOutDevices.get(hwo);
            if (!device || !pwh) {
                Logger.log(LogCategory.SYSTEM, `waveOutWrite: FAILED hwo=0x${hwo.toString(16)}, pwh=0x${pwh.toString(16)}, device=${!!device}`);
                return MMSYSERR_INVALPARAM;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const lpData = view.getUint32(pwh, true);
            const dwBufferLength = view.getUint32(pwh + 4, true);

            Logger.log(LogCategory.SYSTEM, `waveOutWrite: hwo=0x${hwo.toString(16)}, lpData=0x${lpData.toString(16)}, len=${dwBufferLength}`);

            if (device.sab && dwBufferLength > 0) {
                const ringBytes = getCtrl(device.sab, CTRL_BUFFER_BYTES);
                const blockAlign = device.format.blockAlign;
                // Copy raw PCM directly into SAB ring buffer (circular wrap handled by writeRingData)
                const src = mem.subarray(lpData, lpData + dwBufferLength);
                writeRingData(device.sab, device.writeOffset, src, dwBufferLength);
                device.writeOffset += dwBufferLength;

                // Update write cursor — avoid empty/full ambiguity:
                // If write cursor wraps to exactly match play cursor, back off by one frame
                let writeCursor = device.writeOffset % ringBytes;
                const playCursor = getCtrl(device.sab, CTRL_PLAY_CURSOR);
                if (writeCursor === playCursor && dwBufferLength > 0) {
                    // Ring is full (not empty) — back off by one frame to avoid ambiguity
                    writeCursor = (writeCursor - blockAlign + ringBytes) % ringBytes;
                    if (writeCursor === playCursor) writeCursor = (ringBytes - blockAlign);
                }
                setCtrl(device.sab, CTRL_WRITE_CURSOR, writeCursor);

                // Galaxy-style DMA (single buffer, rewritten in guest memory and
                // re-synced by syncGuestToSab) vs normal multi-buffer streaming
                // (pool of headers submitted sequentially, paced by WHDR_DONE).
                // Galaxy issues exactly ONE waveOutWrite per stream; a second write
                // means this is a normal streaming client — permanently switch.
                if (!device.multiBuffer && device.guestLpData !== 0) {
                    device.multiBuffer = true;
                    device.guestLpData = 0;        // disables syncGuestToSab
                    device.guestBufferLength = 0;
                }

                if (device.multiBuffer) {
                    // Multi-buffer streaming: the worklet must traverse the whole
                    // ring (buffers land sequentially at writeOffset). Shrinking
                    // DATA_LENGTH to one buffer would confine playback to the
                    // first 4000 bytes and desync played-bytes accounting.
                    setCtrl(device.sab, CTRL_DATA_LENGTH, ringBytes);
                } else {
                    // Store guest buffer info for continuous DMA-style sync
                    device.guestLpData = lpData;
                    device.guestBufferLength = dwBufferLength;

                    // Set DATA_LENGTH to actual buffer size so worklet wraps within
                    // the real data region (not the larger ring buffer).
                    // Galaxy writes 88200 bytes into a 131072-byte ring — without this,
                    // the worklet plays zeros from 88200..131071 on each cycle.
                    setCtrl(device.sab, CTRL_DATA_LENGTH, Math.min(dwBufferLength, ringBytes));
                }

                // Ensure playback is active on every write (worklet may have stopped)
                setCtrl(device.sab, CTRL_STATE, STATE_PLAYING);
                if (!device.isPlaying) {
                    setCtrl(device.sab, CTRL_LOOP_MODE, -1); // loop forever (streaming)
                    device.isPlaying = true;
                    device.startTime = performance.now();
                }
            }

            // Defer WHDR_DONE until the worklet actually consumes this data.
            // This paces buffer resubmission to real audio consumption, preventing
            // the write cursor from lapping the play cursor in the ring buffer.
            const hdrFlags = view.getUint32(pwh + 16, true);
            view.setUint32(pwh + 16, (hdrFlags | WHDR_INQUEUE) & ~WHDR_DONE, true);

            device.pendingBuffers.push({ pwh, endOffset: device.writeOffset });

            // Start poller + timer thread as needed
            this.startCompletionPoller(device);
            const callbackType = device.flags & CALLBACK_TYPEMASK;
            if (callbackType === CALLBACK_FUNCTION && device.callback) {
                this.ensureTimerThread();
            }

            // Opportunistically check completions now
            this.checkCompletions(device);

            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutReset"] = (ctx, mem, args) => {
            const hwo = args[0];
            const device = this.waveOutDevices.get(hwo);
            if (device) {
                // Stop completion poller
                this.stopCompletionPoller(device);

                // Mark all pending buffers as WHDR_DONE (per Windows spec)
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                for (const pending of device.pendingBuffers) {
                    const flags = view.getUint32(pending.pwh + 16, true);
                    view.setUint32(pending.pwh + 16, (flags | WHDR_DONE) & ~WHDR_INQUEUE, true);
                }
                device.pendingBuffers.length = 0;

                if (device.sab) {
                    setCtrl(device.sab, CTRL_STOP_REQUESTED, 1);
                    device.writeOffset = 0;
                    setCtrl(device.sab, CTRL_WRITE_CURSOR, 0);
                }
                device.isPlaying = false;
                device.positionBytes = 0;
                device.lastPlayCursor = 0;
                device.playedBytes = 0;
                // Fresh stream after reset — re-detect Galaxy-DMA vs multi-buffer
                device.guestLpData = 0;
                device.guestBufferLength = 0;
                device.multiBuffer = false;
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetPosition"] = (ctx, mem, args) => {
            const hwo = args[0];
            const pmmtime = args[1];
            const cbmmtime = args[2];
            const device = this.waveOutDevices.get(hwo);
            if (!device || !pmmtime || cbmmtime < 4) return MMSYSERR_INVALPARAM;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const wType = view.getUint32(pmmtime, true);

            // Use linear (unwrapped) total bytes played — Galaxy and other apps
            // expect monotonically increasing position, not a wrapped ring cursor.
            if (device.sab) this.updatePlayedBytes(device);
            const posBytes = device.sab ? device.playedBytes : device.positionBytes;

            let val = 0;
            if (wType === TIME_BYTES) {
                val = posBytes;
            } else if (wType === TIME_SAMPLES) {
                val = Math.floor(posBytes / device.format.blockAlign);
            } else {
                view.setUint32(pmmtime, TIME_MS, true);
                val = Math.floor(posBytes / device.format.avgBytesPerSec * 1000);
            }

            view.setUint32(pmmtime + 4, val, true);
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutPause"] = (ctx, mem, args) => {
            const hwo = args[0];
            const device = this.waveOutDevices.get(hwo);
            if (!device) return MMSYSERR_INVALPARAM;
            if (device.isPlaying && device.sab) {
                setCtrl(device.sab, CTRL_STATE, STATE_STOPPED);
                device.isPlaying = false;
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutRestart"] = (ctx, mem, args) => {
            const hwo = args[0];
            const device = this.waveOutDevices.get(hwo);
            if (!device) return MMSYSERR_INVALPARAM;
            if (!device.isPlaying && device.sab) {
                setCtrl(device.sab, CTRL_STATE, STATE_PLAYING);
                device.isPlaying = true;
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetID"] = (ctx, mem, args) => {
            const hwo = args[0];
            const puDeviceID = args[1];
            if (puDeviceID) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(puDeviceID, 0, true);
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutSetVolume"] = (ctx, mem, args) => {
            const hwo = args[0];
            const dwVolume = args[1];
            const device = this.waveOutDevices.get(hwo);
            if (device && device.sab) {
                const left = (dwVolume & 0xFFFF) / 65535.0;
                const right = ((dwVolume >> 16) & 0xFFFF) / 65535.0;
                // Convert linear volume to centibels for SAB protocol
                const vol = (left + right) / 2.0;
                const centibels = vol <= 0 ? -10000 : Math.round(2000 * Math.log10(vol));
                setCtrl(device.sab, CTRL_VOLUME, Math.max(-10000, Math.min(0, centibels)));
                // Convert L/R difference to pan centibels
                const panLinear = right - left; // -1..1
                const panCb = Math.round(panLinear * 10000);
                setCtrl(device.sab, CTRL_PAN, Math.max(-10000, Math.min(10000, panCb)));
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetVolume"] = (ctx, mem, args) => {
            const hwo = args[0];
            const pdwVolume = args[1];
            if (pdwVolume) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pdwVolume, 0xFFFFFFFF, true);
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetNumDevs"] = () => 1;

        this.exports["waveOutGetDevCapsA"] = (ctx, mem, args) => {
            const uDeviceID = args[0];
            const pwoc = args[1];
            const cbwoc = args[2];
            if (pwoc && cbwoc >= 52) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint16(pwoc + 0, 0xFFFF, true);
                view.setUint16(pwoc + 2, 0x0001, true);
                view.setUint32(pwoc + 4, 0x0100, true);
                const name = "BottleShip Audio Out\0";
                for (let i = 0; i < 32; i++) {
                    mem[pwoc + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
                }
                view.setUint32(pwoc + 40, 0x00FF00FF, true);
                view.setUint16(pwoc + 44, 2, true);
                view.setUint32(pwoc + 48, 0x0033, true); // VOLUME | LRVOLUME | PITCH | PLAYBACKRATE
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetDevCapsW"] = (ctx, mem, args) => {
            const pwoc = args[1];
            const cbwoc = args[2];
            if (pwoc && cbwoc >= 84) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint16(pwoc + 0, 0xFFFF, true);
                view.setUint16(pwoc + 2, 0x0001, true);
                view.setUint32(pwoc + 4, 0x0100, true);
                const name = "BottleShip Audio Out";
                for (let i = 0; i < 32; i++) {
                    const ch = i < name.length ? name.charCodeAt(i) : 0;
                    view.setUint16(pwoc + 8 + i * 2, ch, true);
                }
                view.setUint32(pwoc + 72, 0x00FF00FF, true);
                view.setUint16(pwoc + 76, 2, true);
                view.setUint16(pwoc + 78, 0, true);
                view.setUint32(pwoc + 80, 0x0033, true); // VOLUME | LRVOLUME | PITCH | PLAYBACKRATE
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetErrorTextA"] = (_ctx, _mem, args) => {
            const mmrError = args[0] >>> 0;
            const pszText = args[1] >>> 0;
            const cchText = args[2] >>> 0;
            if (!pszText || cchText === 0) return MMSYSERR_INVALPARAM;
            if (!this.writeAnsiString(pszText, cchText, this.waveOutErrorText(mmrError))) {
                return MMSYSERR_ERROR;
            }
            return MMSYSERR_NOERROR;
        };

        this.exports["waveOutGetErrorTextW"] = (_ctx, _mem, args) => {
            const mmrError = args[0] >>> 0;
            const pszText = args[1] >>> 0;
            const cchText = args[2] >>> 0;
            if (!pszText || cchText === 0) return MMSYSERR_INVALPARAM;
            if (!this.writeWideString(pszText, cchText, this.waveOutErrorText(mmrError))) {
                return MMSYSERR_ERROR;
            }
            return MMSYSERR_NOERROR;
        };

        // waveIn / midiIn / mixer / aux device-caps and stub handlers live in
        // winmm-caps.ts (same wiring pattern as winmm-joystick).
        registerWinmmCapsExports(this.exports);

        registerWinmmJoystickExports(this.exports);

        // ==================== MCI Functions ====================

        // mciGetDeviceIDA / mciSendCommandA / mciSendStringA / mciGetErrorStringA plus the
        // MCI device registry and AVI video playback engine live in winmm-mci.ts. The MCI
        // subsystem borrows the guest-string helpers that stay shared with PlaySound /
        // waveOutGetErrorText here.
        this.mci = registerWinmmMciExports(this.exports, {
            readAnsiString: (ptr, maxLen) => this.readAnsiString(ptr, maxLen),
            writeAnsiString: (ptr, cch, value) => this.writeAnsiString(ptr, cch, value),
            readWideString: (ptr, maxLen) => this.readWideString(ptr, maxLen),
            writeWideString: (ptr, cch, value) => this.writeWideString(ptr, cch, value),
        });

        // ==================== Sound Functions ====================

        this.exports["sndPlaySoundA"] = (ctx, mem, args) => {
            const lpszSound = args[0];
            const fuSound = args[1];
            // sndPlaySound is PlaySound with hmod=0
            return this.doPlaySound(mem, lpszSound, 0, fuSound);
        };

        this.exports["PlaySoundA"] = (ctx, mem, args) => {
            const pszSound = args[0];
            const hmod = args[1];
            const fdwSound = args[2];
            return this.doPlaySound(mem, pszSound, hmod, fdwSound);
        };

        this.exports["PlaySoundW"] = (ctx, mem, args) => {
            const pszSound = args[0];
            const hmod = args[1];
            const fdwSound = args[2];

            // For SND_MEMORY, pszSound points to WAV data — no string decoding needed
            if (fdwSound & SND_MEMORY) {
                return this.doPlaySound(mem, pszSound, hmod, fdwSound);
            }

            // NULL or integer resource ID — no string conversion needed
            if (!pszSound || (pszSound & 0xFFFF0000) === 0) {
                return this.doPlaySound(mem, pszSound, hmod, fdwSound);
            }

            // Wide string → read and pass as override
            const wideName = Marshaler.readWideString(mem, pszSound);
            return this.doPlaySound(mem, pszSound, hmod, fdwSound, wideName);
        };

        // ==================== MMIO Functions ====================

        this.exports["mmioOpenA"] = (ctx, mem, args) => {
            const szFilename = args[0];
            const lpmmioinfo = args[1];
            const dwOpenFlags = args[2];

            let filename = "";
            if (szFilename) {
                for (let i = 0; i < 260; i++) {
                    const ch = mem[szFilename + i];
                    if (ch === 0) break;
                    filename += String.fromCharCode(ch);
                }
            }

            Logger.verbose(LogCategory.SYSTEM, `mmioOpenA: file="${filename}", flags=0x${dwOpenFlags.toString(16)} (stub)`);

            if (!filename) {
                return 0; // NULL handle
            }

            const handle = this.nextMMIOHandle++;

            // Read the file synchronously from VFS so mmioDescend/mmioRead work correctly.
            let data: Uint8Array | null = null;
            try {
                const vfs = System.getInstance().fileSystem;
                const fileSize = vfs.getFileSize(filename);
                if (fileSize > 0 && fileSize <= 32 * 1024 * 1024) {
                    const GENERIC_READ = 0x80000000;
                    const OPEN_EXISTING = 3;
                    const fh = vfs.openSync(filename, GENERIC_READ, OPEN_EXISTING);
                    if (fh) {
                        data = vfs.readSync(fh, fileSize);
                    }
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `mmioOpenA: failed to read "${filename}": ${e}`);
            }

            this.mmioHandles.set(handle, { filename, position: 0, data });
            Logger.verbose(LogCategory.SYSTEM, `mmioOpenA: opened "${filename}" as handle ${handle}, size=${data?.length ?? 0}`);
            return handle;
        };

        this.exports["mmioClose"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const uFlags = args[1];

            Logger.verbose(LogCategory.SYSTEM, `mmioClose: handle=${hmmio}, flags=0x${uFlags.toString(16)} (stub)`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio) return MMIOERR_CANNOTOPEN;

            if (mmio.guestBuffer) {
                System.getInstance().process?.memory?.free(mmio.guestBuffer);
                mmio.guestBuffer = 0;
            }
            this.mmioHandles.delete(hmmio);
            return MMSYSERR_NOERROR;
        };

        this.exports["mmioRead"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const pch = args[1];
            const cch = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioRead: handle=${hmmio}, buf=0x${pch.toString(16)}, len=${cch}`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio) return -1;

            if (!pch || cch <= 0) return 0;

            if (!mmio.data) return 0; // no data (file not found)

            const available = mmio.data.length - mmio.position;
            if (available <= 0) return 0;
            const toRead = Math.min(cch >>> 0, available);
            Mem.writeBytes(pch, mmio.data.subarray(mmio.position, mmio.position + toRead));
            mmio.position += toRead;
            return toRead;
        };

        this.exports["mmioSeek"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lOffset = args[1] | 0; // signed
            const iOrigin = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioSeek: handle=${hmmio}, offset=${lOffset}, origin=${iOrigin} (stub)`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio) return -1;

            let newPos = 0;
            switch (iOrigin) {
                case SEEK_SET:
                    newPos = lOffset;
                    break;
                case SEEK_CUR:
                    newPos = mmio.position + lOffset;
                    break;
                case SEEK_END:
                    newPos = (mmio.data?.length ?? 0) + lOffset;
                    break;
                default:
                    return -1;
            }

            // Clamp to valid range
            newPos = Math.max(0, newPos);
            mmio.position = newPos;

            return newPos;
        };

        this.exports["mmioGetInfo"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lpmmioinfo = args[1];
            const uFlags = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioGetInfo: handle=${hmmio}, info=0x${lpmmioinfo.toString(16)}, flags=0x${uFlags.toString(16)}`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio || !lpmmioinfo) return MMSYSERR_INVALPARAM;

            // Faithful direct-I/O buffering: fill a guest buffer from the current file
            // position and expose pchBuffer/pchNext/pchEndRead so the guest (DXSDK
            // CWaveFile/DSUtil streaming reader) can read audio bytes directly.
            this.mmioRefillGuestBuffer(mmio);
            // Zero the struct first (leaves adwInfo/reserved clean) then write fields.
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < MMIOINFO_SIZE; i += 4) {
                view.setUint32(lpmmioinfo + i, 0, true);
            }
            mmioWriteInfoStruct(lpmmioinfo, hmmio, mmio);
            this.recordMmioInfo("mmioGetInfo", lpmmioinfo, mmio);

            return MMSYSERR_NOERROR;
        };

        this.exports["mmioSetInfo"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lpmmioinfo = args[1];
            const uFlags = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioSetInfo: handle=${hmmio}, info=0x${lpmmioinfo.toString(16)}, flags=0x${uFlags.toString(16)}`);

            // Commit the guest's read cursor (pchNext) back into our file position so a
            // following mmioRead/mmioDescend/mmioAscend continues from the right place.
            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio || !lpmmioinfo) return MMSYSERR_INVALPARAM;
            mmioCommitInfoCursor(lpmmioinfo, mmio);
            return MMSYSERR_NOERROR;
        };

        this.exports["mmioDescend"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lpck = args[1];
            const lpckParent = args[2];
            const uFlags = args[3];

            Logger.verbose(LogCategory.SYSTEM, `mmioDescend: handle=${hmmio}, ck=0x${lpck.toString(16)}, parent=0x${lpckParent.toString(16)}, flags=0x${uFlags.toString(16)}`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio || !lpck) return MMSYSERR_INVALPARAM;

            // MMCKINFO structure:
            // FOURCC ckid      (4 bytes, offset 0)
            // DWORD  cksize    (4 bytes, offset 4)  ← game uses this for buffer size!
            // FOURCC fccType   (4 bytes, offset 8)
            // DWORD  dwDataOffset (4 bytes, offset 12)
            // DWORD  dwFlags   (4 bytes, offset 16)

            const MMIO_FINDCHUNK = 0x0010;
            const MMIO_FINDRIFF  = 0x0020;
            const MMIO_FINDLIST  = 0x0040;

            const data = mmio.data;
            if (!data) return MMIOERR_CANNOTOPEN;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Determine end of search region (parent chunk bounds, or entire file)
            let searchEnd = data.length;
            if (lpckParent) {
                const parentDataOffset = view.getUint32(lpckParent + 12, true);
                const parentCkSize     = view.getUint32(lpckParent + 4,  true);
                searchEnd = parentDataOffset + parentCkSize;
            }

            // What are we searching for?
            const findFcc  = (uFlags & (MMIO_FINDRIFF | MMIO_FINDLIST)) !== 0;
            const findChunk = (uFlags & MMIO_FINDCHUNK) !== 0;
            const wantId   = findChunk ? view.getUint32(lpck, true) : 0;
            const wantType = findFcc   ? view.getUint32(lpck + 8, true) : 0;
            const riffId   = 0x46464952; // 'RIFF'
            const listId   = 0x5453494c; // 'LIST'

            let pos = mmio.position;
            while (pos + 8 <= searchEnd && pos + 8 <= data.length) {
                const ckid   = (data[pos] | (data[pos+1]<<8) | (data[pos+2]<<16) | (data[pos+3]<<24)) >>> 0;
                const cksize = (data[pos+4] | (data[pos+5]<<8) | (data[pos+6]<<16) | (data[pos+7]<<24)) >>> 0;
                const isContainer = (ckid === riffId || ckid === listId);
                const fccType = isContainer && pos + 12 <= data.length
                    ? (data[pos+8] | (data[pos+9]<<8) | (data[pos+10]<<16) | (data[pos+11]<<24)) >>> 0
                    : 0;

                let matched = false;
                if (uFlags === 0) {
                    matched = true; // Just read whatever chunk is here
                } else if (findFcc && (uFlags & MMIO_FINDRIFF) && ckid === riffId && fccType === wantType) {
                    matched = true;
                } else if (findFcc && (uFlags & MMIO_FINDLIST) && ckid === listId && fccType === wantType) {
                    matched = true;
                } else if (findChunk && ckid === wantId) {
                    matched = true;
                }

                if (matched) {
                    const dataOffset = isContainer ? pos + 12 : pos + 8;
                    view.setUint32(lpck,      ckid,       true);
                    view.setUint32(lpck + 4,  cksize,     true);
                    view.setUint32(lpck + 8,  fccType,    true);
                    view.setUint32(lpck + 12, dataOffset, true);
                    view.setUint32(lpck + 16, 0,          true);
                    mmio.position = dataOffset;
                    Logger.verbose(LogCategory.SYSTEM,
                        `mmioDescend: found ckid=${String.fromCharCode(ckid&0xff,(ckid>>8)&0xff,(ckid>>16)&0xff,(ckid>>24)&0xff)} ` +
                        `cksize=${cksize} fccType=${fccType ? String.fromCharCode(fccType&0xff,(fccType>>8)&0xff,(fccType>>16)&0xff,(fccType>>24)&0xff) : ''} ` +
                        `dataOffset=${dataOffset}`);
                    return MMSYSERR_NOERROR;
                }

                // Advance to next chunk (header + size, padded to even)
                pos += 8 + cksize + (cksize & 1);
            }

            return MMIOERR_CHUNKNOTFOUND;
        };

        this.exports["mmioAscend"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lpck = args[1];
            const uFlags = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioAscend: handle=${hmmio}, ck=0x${lpck.toString(16)}, flags=0x${uFlags.toString(16)}`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio || !lpck) return MMSYSERR_INVALPARAM;

            // Seek position to end of this chunk (dwDataOffset + cksize, padded to even)
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const dataOffset = view.getUint32(lpck + 12, true);
            const cksize     = view.getUint32(lpck + 4,  true);
            mmio.position = dataOffset + cksize + (cksize & 1);
            return MMSYSERR_NOERROR;
        };

        this.exports["mmioAdvance"] = (ctx, mem, args) => {
            const hmmio = args[0];
            const lpmmioinfo = args[1];
            const uFlags = args[2];

            Logger.verbose(LogCategory.SYSTEM, `mmioAdvance: handle=${hmmio}, info=0x${lpmmioinfo.toString(16)}, flags=0x${uFlags.toString(16)}`);

            const mmio = this.mmioHandles.get(hmmio);
            if (!mmio) return MMSYSERR_INVALPARAM;
            if (!lpmmioinfo) return MMSYSERR_INVALPARAM;

            // Commit how far the guest consumed the current window (pchNext), then refill
            // the guest buffer from the new position and rewrite the MMIOINFO pointers.
            // This is the real mmioAdvance contract for a memory-buffered read handle.
            mmioCommitInfoCursor(lpmmioinfo, mmio);
            this.mmioRefillGuestBuffer(mmio);
            mmioWriteInfoStruct(lpmmioinfo, hmmio, mmio);
            this.recordMmioInfo("mmioAdvance", lpmmioinfo, mmio);
            return MMSYSERR_NOERROR;
        };

        this.exports["mmioStringToFOURCCA"] = (ctx, mem, args) => {
            const sz = args[0] >>> 0;
            const uFlags = args[1] >>> 0;
            const MMIO_TOUPPER = 0x0010;

            if (!sz) return 0;

            let fourcc = 0;
            for (let i = 0; i < 4; i++) {
                const ch = Mem.readUint8(sz + i);
                if (ch == null || ch === 0) break;
                let c = ch & 0xFF;
                if (uFlags & MMIO_TOUPPER) {
                    // toUpperCase for ASCII a-z
                    if (c >= 0x61 && c <= 0x7A) c -= 0x20;
                }
                fourcc |= (c << (i * 8));
            }
            return fourcc >>> 0;
        };
    }

    reset(): void {
        // Cancel all timer wheel entries
        const scheduler = System.getInstance()?.scheduler;
        if (scheduler) {
            for (const timer of this.timers.values()) {
                scheduler.timerWheel.cancel(timer.wheelId);
            }
        }
        // Stop any per-device waveOut completion pollers (wheel entries) so a reset
        // doesn't leak a poller bound to a stale device.
        for (const device of this.waveOutDevices.values()) {
            this.stopCompletionPoller(device);
        }
        this.timers.clear();
        this.pendingTimerCallbacks.length = 0;
        this.pendingTimerHead = 0;
        this.timerCallbackDrainCount = 0;
        this.dispatchingTimerCallback = null;
        this.timerThreadId = 0;
        this.timerThreadHandle = 0;
        this.timerWakeEvent = 0;
        scheduler?.notifyWinmmTimerThread(0, 0);
        this.periodRefCounts.clear();

        // Clear MMIO handles, freeing any guest-side I/O buffers.
        const mem = System.getInstance().process?.memory;
        for (const mmio of this.mmioHandles.values()) {
            if (mmio.guestBuffer) mem?.free(mmio.guestBuffer);
        }
        this.mmioHandles.clear();
        this.mci?.reset();
        resetWinmmJoystick();
    }

    /** Diagnostic snapshot for paint-time guest-state logging. */
    formatMciDiagnosticSnapshot(): string {
        return this.mci?.formatMciDiagnosticSnapshot() ?? 'mci=none';
    }
}
