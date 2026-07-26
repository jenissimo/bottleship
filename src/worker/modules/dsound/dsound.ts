import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { dsoundModule } from "../../api/dsound.api";
import { System } from "../../core/system";
import { allocateComObject, freeComObject } from "../../core/com/com-memory";
import { TimerKind } from "../../core/scheduler/types";
import { TimeService } from "../../runtime/time";
import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    getCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_WRITE_CURSOR,
    CTRL_STATE,
    CTRL_LOOP_MODE,
    CTRL_VOLUME,
    CTRL_PAN,
    CTRL_FREQUENCY,
    CTRL_DATA_LENGTH,
    CTRL_STOP_REQUESTED,
    CTRL_FLAGS,
    CTRL_RESERVED,
    CTRL_BLOCK_BYTES,
    FLAG_CIRCULAR,
    STATE_STOPPED,
    STATE_PLAYING,
    STATE_PAUSED,
    CTRL_3D_POS_X,
    CTRL_3D_POS_Y,
    CTRL_3D_POS_Z,
    CTRL_3D_VEL_X,
    CTRL_3D_VEL_Y,
    CTRL_3D_VEL_Z,
    CTRL_3D_MIN_DIST,
    CTRL_3D_MAX_DIST,
    CTRL_3D_MODE,
    CTRL_3D_CONE_INNER,
    CTRL_3D_CONE_OUTER,
    CTRL_3D_CONE_ORI_X,
    CTRL_3D_CONE_ORI_Y,
    CTRL_3D_CONE_ORI_Z,
    CTRL_3D_CONE_OUTVOL,
    CTRL_3D_FLAGS,
    floatToI32,
    i32ToFloat,
    setCtrlFloat,
    createListenerSab,
    LCTRL_POS_X,
    LCTRL_POS_Y,
    LCTRL_POS_Z,
    LCTRL_VEL_X,
    LCTRL_VEL_Y,
    LCTRL_VEL_Z,
    LCTRL_FRONT_X,
    LCTRL_FRONT_Y,
    LCTRL_FRONT_Z,
    LCTRL_TOP_X,
    LCTRL_TOP_Y,
    LCTRL_TOP_Z,
    LCTRL_DIST_FACTOR,
    LCTRL_ROLLOFF_FACTOR,
    LCTRL_DOPPLER_FACTOR,
} from "../../../audio/audio-ring-buffer";
import { ensureAudioStatsSab } from "../audio-stats-sab";

const DS_OK = 0;
const DSERR_INVALIDPARAM = 0x88780007;
const DSBPLAY_LOOPING = 0x00000001;
const DSBSTATUS_PLAYING = 0x00000001;
const DSBSTATUS_BUFFERLOST = 0x00000002;
const DSBSTATUS_LOOPING = 0x00000004;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const DSOUND_AUDIO_ID_BASE = 0x40000000;
const DSBLOCK_FROMWRITECURSOR = 0x1;
const DSBLOCK_ENTIREBUFFER = 0x2;
const DSBPN_OFFSETSTOP = 0xFFFFFFFF;
const DSBCAPS_PRIMARYBUFFER = 0x00000001;
const DSBCAPS_LOCHARDWARE = 0x00000004;
const DSBCAPS_LOCSOFTWARE = 0x00000008;
const DSBCAPS_CTRL3D = 0x00000010;
const DSBCAPS_CTRLFREQUENCY = 0x00000020;
const DSBCAPS_CTRLPAN = 0x00000040;
const DSBCAPS_CTRLVOLUME = 0x00000080;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;
const DSERR_UNSUPPORTED = 0x80004001;
const DSERR_INVALIDCALL = 0x88780032;
const DSERR_CONTROLUNAVAIL = 0x8878001e;
const DSERR_BADFORMAT = 0x88780064;
const DSERR_NODRIVER = 0x88780078;
const DSERR_BUFFERLOST_HR = 0x88780096;
const DSERR_ALREADYINITIALIZED = 0x88780082;
const DSERR_OBJECTNOTFOUND = 0x88781161;
const DSBVOLUME_MIN = -10000;
const DSBVOLUME_MAX = 0;
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const DSCCAPS_SIZE = 16;
const DSCCAPS_CERTIFIED = 0x00000040;
const DSCBCAPS_SIZE = 20;
const DSCBSTATUS_CAPTURING = 0x00000001;
const DSCBSTATUS_LOOPING = 0x00000002;
const DSCBSTART_LOOPING = 0x00000001;
const GUID_DEFAULT_PLAYBACK = [0xDEF00000, 0x9C6D, 0x47ED, 0xAA, 0xF1, 0x4D, 0xDA, 0x8F, 0x2B, 0x5C, 0x03] as const;
const GUID_DEFAULT_CAPTURE = [0xDEF00001, 0x9C6D, 0x47ED, 0xAA, 0xF1, 0x4D, 0xDA, 0x8F, 0x2B, 0x5C, 0x03] as const;
const GUID_DEFAULT_VOICE_PLAYBACK = [0xDEF00002, 0x9C6D, 0x47ED, 0xAA, 0xF1, 0x4D, 0xDA, 0x8F, 0x2B, 0x5C, 0x03] as const;
const GUID_DEFAULT_VOICE_CAPTURE = [0xDEF00003, 0x9C6D, 0x47ED, 0xAA, 0xF1, 0x4D, 0xDA, 0x8F, 0x2B, 0x5C, 0x03] as const;
const DSBFREQUENCY_MIN = 100;
const DSBFREQUENCY_MAX = 200000;
const DSBSTATUS_LOCSOFTWARE = 0x00000010;
const DSSPEAKER_STEREO = 4;
const DSSPEAKER_GEOMETRY_WIDE = 0x14;
const DEFAULT_SPEAKER_CONFIG = DSSPEAKER_STEREO | (DSSPEAKER_GEOMETRY_WIDE << 16);
const DSCAPS_SIZE = 96;
const DS3D_IMMEDIATE = 0x00000000;
const DS3D_DEFERRED = 0x00000001;
const DS3DMODE_NORMAL = 0x00000000;
const DS3DMODE_HEAD_RELATIVE = 0x00000001;
const DS3DMODE_DISABLE = 0x00000002;

// DSCAPS flags
const DSCAPS_PRIMARYMONO = 0x00000001;
const DSCAPS_PRIMARYSTEREO = 0x00000002;
const DSCAPS_PRIMARY8BIT = 0x00000004;
const DSCAPS_PRIMARY16BIT = 0x00000008;
const DSCAPS_CONTINUOUSRATE = 0x00000010;
const DSCAPS_CERTIFIED = 0x00000040;
const DSCAPS_SECONDARYMONO = 0x00000100;
const DSCAPS_SECONDARYSTEREO = 0x00000200;
const DSCAPS_SECONDARY8BIT = 0x00000400;
const DSCAPS_SECONDARY16BIT = 0x00000800;

type DSoundObjectType =
    | "IDirectSound8"
    | "IDirectSoundBuffer8"
    | "IDirectSoundNotify"
    | "IDirectSoundCapture"
    | "IDirectSoundCaptureBuffer8"
    | "IDirectSound3DListener"
    | "IDirectSound3DBuffer";

type SoundFormat = {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
    avgBytesPerSec: number;
};

type Ds3dState = {
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    minDist: number; maxDist: number;
    mode: number;
    coneInner: number; coneOuter: number;
    coneOriX: number; coneOriY: number; coneOriZ: number;
    coneOutVol: number;
};

function defaultDs3dState(): Ds3dState {
    return {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        minDist: 1.0, maxDist: 1e9,
        mode: DS3DMODE_NORMAL,
        coneInner: 360, coneOuter: 360,
        coneOriX: 0, coneOriY: 0, coneOriZ: 1.0,
        coneOutVol: 0,
    };
}

// Software-mixer premix depth. On a LOCSOFTWARE buffer the reported write cursor leads
// play by exactly the premixed region — GetCurrentPosition derives the secondary's write
// cursor from the distance between the primary's write cursor and the mixer's next-mix
// position (nt5 dsound CGrace::GetBytePosition, "the region from the write cursor to the
// mix cursor is the premixed region"). So these bounds ARE the write-cursor lead.
//
// The mixer thread (nt5 dsound CNaGrace::MixThread) ramps that depth on a timer:
// MIXER_MINPREMIX after a remix, then `premix += step; step += 2` per refresh up to
// MIXER_MAXPREMIX — 45, 47, 51, 57, 65, 75, 87, 101, 117, 135, 155, 177, 200. Sleep
// between refreshes is min(premixed/2, nextNotify) clamped to [MIN/2, MAX/2].
const PREMIX_MIN_MS = 45;
const PREMIX_MAX_MS = 200;
/** Ramp increment growth per refresh: step starts here and grows by the same amount. */
const PREMIX_STEP_MS = 2;

type SoundBuffer = {
    id: number;
    bytes: number;
    format: SoundFormat;
    flags: number; // DSBCAPS creation flags
    ptr: number;
    currentPosition: number;
    volume: number; // linear 0..1
    volumeDb: number; // dB value (-10000..0)
    pan: number; // -10000..10000
    frequency: number;
    playbackRate: number;
    isPlaying: boolean;
    isLooping: boolean;
    // Deterministic-audio diagnostic (§B#5): virtual-time anchor + byte position at the
    // moment playback (re)started, so the play cursor can advance by instruction-anchored
    // virtual time instead of the AudioContext wall-clock. Unused in normal operation.
    playAnchorVirtualMs?: number;
    playAnchorByte?: number;
    lockOffset?: number;
    lockFirstSize?: number;
    lockSecondSize?: number;
    lockFlags?: number;
    lockRequestedBytes?: number;
    /** End cursor of the last guest Unlock write = the KMixer consumption frontier
     *  (how far the app has committed PCM into the ring). */
    lastUnlockCursor?: number;
    /** Cumulative bytes the guest has Unlocked into this buffer over its lifetime.
     *  Used to classify a continuously-refilled STREAM (crosses the buffer size many
     *  times) apart from a write-once static loop (engine/ambience SFX). */
    cumulativeWritten?: number;
    /** Classified as an actively-refilled looping buffer rather than a write-once static
     *  loop. Diagnostics only — see updateStreamFrontier. */
    streamed?: boolean;
    /** Software-mixer premix depth in ms; the reported write cursor leads play by it.
     *  Ramped on a timer and reset by a remix — see dsoundLeadBytes. */
    premixMs?: number;
    /** Current ramp increment (grows by PREMIX_STEP_MS per refresh). */
    premixStepMs?: number;
    /** Host time (performance.now) the ramp last advanced. */
    premixAdvancedAtMs?: number;
    // Ring buffer (SAB)
    sab: SharedArrayBuffer | null;
    registered: boolean;
    // Notification support (IDirectSoundNotify)
    notifications?: Array<{ offset: number; eventHandle: number }>;
    lastNotifyCursor?: number;
    bufferRefCount: number;
    bufferLost: boolean;
    // 3D audio
    has3D: boolean;
    ds3d: Ds3dState;
    deferredDs3d: Ds3dState | null;
};

type CaptureBuffer = {
    bytes: number;
    format: SoundFormat;
    flags: number;
    ptr: number;
    capturePosition: number;
    isCapturing: boolean;
    isLooping: boolean;
};

type DSoundObject = {
    type: DSoundObjectType;
    refCount: number;
    buffer?: SoundBuffer;
    capture?: CaptureBuffer;
    /** For an IDirectSound device object: was it obtained through the IDirectSound8
     *  interface (DirectSoundCreate8 / CoCreateInstance IID_IDirectSound8)? The DX8-only
     *  CreateSoundBuffer validation (3D buffers must be mono; CTRL3D+CTRLPAN forbidden)
     *  applies ONLY to the DS8 interface — the legacy IDirectSound path skips it. */
    isDs8?: boolean;
};

export class DSound implements IModule {
    name = "dsound";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;
    private memory!: Uint8Array;
    private objects: Map<number, DSoundObject> = new Map();
    private vtables: Record<string, VTableInfo> = {};
    private nextBufferId = DSOUND_AUDIO_ID_BASE;
    private notifyTimerId: number | null = null;
    /** Singleton primary buffer COM pointer (CreateSoundBuffer PRIMARYBUFFER). */
    private primaryBufferPtr = 0;
    private speakerConfig = DEFAULT_SPEAKER_CONFIG;
    /** IDirectSoundBuffer method call counters (dbg.audio()). */
    public dbgAudioCalls = {
        getCurPos: 0,
        getStatus: 0,
        lock: 0,
        unlock: 0,
        play: 0,
        stop: 0,
        entireLock: 0,
        zeroLock: 0,
        fullUnlock: 0,
        overlapUnlock: 0,
        bytesUnlocked: 0,
        lastPlay: -1,
        lastWrite: -1,
    };
    /** Buffer-lifecycle event ring (dbg.audio() / harness audioBuffers). Captures the
     *  rare control-plane calls — Create/Play/Stop/Release/destroy/SetCurrentPosition —
     *  per buffer id + timestamp, so a "stuck looping sample" repro (race→menu) shows
     *  exactly what the guest did (or failed to do) to the droning voice. Not hot-path. */
    private bufferLifeRing: { t: number; ev: string; id: number; loop?: boolean; detail?: string }[] = [];
    private recordLife(ev: string, id: number, loop?: boolean, detail?: string): void {
        this.bufferLifeRing.push({ t: Math.round(performance.now()), ev, id, loop, detail });
        if (this.bufferLifeRing.length > 256) this.bufferLifeRing.shift();
    }
    /** Recent Unlock writes on large buffers (dbg.audio()). */
    private dbgLockTrace: {
        t: number;
        off: number;
        n: number;
        play: number;
        apiWrite: number;
        lastUnlock: number;
        flags: number;
        requestedBytes: number;
        isPlaying: boolean;
        overlapPlay: boolean;
    }[] = [];

    // 3D listener state
    private listenerState = {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        frontX: 0, frontY: 0, frontZ: 1,
        topX: 0, topY: 1, topZ: 0,
        distanceFactor: 1.0, rolloffFactor: 1.0, dopplerFactor: 1.0,
    };
    private listenerSab: SharedArrayBuffer | null = null;
    private deferredListenerState: typeof DSound.prototype.listenerState | null = null;

    initialize(process: Process): void {
        this.process = process;
        this.memory = this.getMemory();
        this.vtables = createVTablesFromDescriptor(this.process, dsoundModule);

        // Log vtable addresses for debugging
        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.SYSTEM, `DirectSound: Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        // Create listener SAB and share with audio worklet
        this.listenerSab = createListenerSab();
        self.postMessage({ type: "audio_listener_sab", payload: { sab: this.listenerSab } });
        ensureAudioStatsSab();
        Logger.log(LogCategory.SYSTEM, `DirectSound: Created 3D listener SAB`);

        // DirectSoundCreate (legacy) and DirectSoundCreate8 share one object shape (the
        // IDirectSound8 vtable is a superset). The ONLY difference we must preserve is the
        // interface generation: DX8-only CreateSoundBuffer validation is gated on it (see
        // CreateSoundBuffer / the `isDs8` field). CoCreateInstance(CLSID_DirectSound) also
        // routes here and passes isDs8 by the requested IID (IID_IDirectSound → false).
        const createDsDevice = (mem: Uint8Array, ppOut: number, isDs8: boolean): number => {
            const vtableAddr = this.vtables.IDirectSound8.address;
            const dsPtr = this.createObject("IDirectSound8", vtableAddr, undefined, undefined, isDs8);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (ppOut) view.setUint32(ppOut, dsPtr, true);
            Logger.verbose(LogCategory.SYSTEM, `DirectSoundCreate${isDs8 ? "8" : ""} -> 0x${dsPtr.toString(16)} (vtable=0x${vtableAddr.toString(16)})`);
            const vtableCheck = view.getUint32(dsPtr, true);
            if (vtableCheck !== vtableAddr) {
                Logger.error(LogCategory.SYSTEM, `DirectSound: VTable mismatch! Expected 0x${vtableAddr.toString(16)}, got 0x${vtableCheck.toString(16)}`);
            }
            return DS_OK;
        };
        // pGuid=args[0], ppDS=args[1], pUnkOuter=args[2].
        this.exports["directsoundcreate8"] = (_ctx, mem, args) => createDsDevice(mem, args[1], true);
        this.exports["directsoundcreate"] = (_ctx, mem, args) => createDsDevice(mem, args[1], false);
        // Exposed so ole32's CoCreateInstance(CLSID_DirectSound) can pick the interface
        // generation from the requested IID instead of always minting a DS8 object.
        (this as unknown as { createDsDevice?: typeof createDsDevice }).createDsDevice = createDsDevice;
        this.exports["ord_1"] = this.exports["directsoundcreate"];
        this.exports["ord_11"] = this.exports["directsoundcreate8"];

        this.exports["directsoundcapturecreate"] = (ctx, mem, args) => {
            const ppDSC = args[1] >>> 0;
            if (!ppDSC) {
                return DSERR_INVALIDPARAM;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppDSC, 0, true);

            const dscPtr = this.createObject("IDirectSoundCapture", this.vtables.IDirectSoundCapture.address);
            view.setUint32(ppDSC, dscPtr, true);
            Logger.log(
                LogCategory.SYSTEM,
                `DirectSoundCaptureCreate -> 0x${dscPtr.toString(16)} (vtable=0x${this.vtables.IDirectSoundCapture.address.toString(16)})`
            );
            return DS_OK;
        };
        this.exports["ord_6"] = this.exports["directsoundcapturecreate"];

        // DirectSoundEnumerateA/W — enumerate audio playback devices.
        //
        // Real DirectSoundEnumerate reports the primary driver (lpGuid=NULL) FIRST, then
        // every actual playback device with its own non-null GUID. A game that selects a
        // device BY GUID needs at least one real, non-null-GUID entry: Max Payne's
        // S_Device enumeration (sndmfc.dll) walks the reported list and picks the first
        // entry whose GUID differs from its internal "Null Audio Device". With ONLY the
        // NULL primary entry it falls back to that null device, so FUN_10001950 returns
        // "success, no card" WITHOUT ever calling CoCreateInstance(CLSID_DirectSound) —
        // the whole sound system stays silent. That in turn freezes the graphic-novel /
        // cutscene fade, whose timeline is gated on the narration audio clock (a stuck
        // clock leaves the fade overlay at full-opaque black over the panel).
        //
        // So we report the primary driver + one concrete device, presenting a real,
        // period-appropriate sound card (mirrors the GeForce GPU adapter approach). The
        // device GUID is DSDEVID_DefaultPlayback so Get/SetDeviceID stay self-consistent;
        // our IDirectSound::Initialize accepts any GUID and maps it to the default output.
        const registerPlaybackEnumerate = (wide: boolean) =>
            (ctx: unknown, _mem: Uint8Array, args: number[]): number | ThunkResult => {
            const lpDSEnumCallback = args[0];
            const lpContext = args[1];
            Logger.log(LogCategory.SYSTEM, `DirectSoundEnumerate${wide ? "W" : "A"}: callback=0x${lpDSEnumCallback.toString(16)}`);
            if (lpDSEnumCallback === 0) return DS_OK;

            const system = System.getInstance();
            if (!system.process || system.isExiting) return DS_OK;
            if (system.process.dispatcher.hasActiveAsyncThunks()) return DS_OK;
            const callbackManager = system.process.dispatcher.callbackManager;
            if (!callbackManager) return DS_OK;

            // guid=null → the primary-driver entry (lpGuid=NULL); a non-null guid → a real device.
            const devices: Array<{ guid: typeof GUID_DEFAULT_PLAYBACK | null; desc: string }> = [
                { guid: null, desc: "Primary Sound Driver" },
                { guid: GUID_DEFAULT_PLAYBACK, desc: "Sound Blaster Audigy" },
            ];
            const moduleStr = "dsound.dll";
            const allocated: number[] = [];
            const freeAll = (): void => { for (const a of allocated) this.process.memory.free(a); allocated.length = 0; };

            const STACK_CLEANUP = 8; // stdcall (callback, context) = 8 bytes
            callbackManager.saveSuspendedThunkContext(ctx as any, STACK_CLEANUP);

            let idx = 0;
            let firstCallbackId: number | null = null;

            const processNext = (): void => {
                if (idx >= devices.length) return;
                const dev = devices[idx++];

                // Allocate everything FIRST, then take one fresh memory view — alloc can
                // reallocate the backing buffer, so a view taken earlier would be stale.
                const guidPtr = dev.guid ? this.process.memory.alloc(16) : 0;
                if (guidPtr) allocated.push(guidPtr);
                const descPtr = this.process.memory.alloc(wide ? (dev.desc.length + 1) * 2 : dev.desc.length + 1);
                allocated.push(descPtr);
                const modulePtr = this.process.memory.alloc(wide ? (moduleStr.length + 1) * 2 : moduleStr.length + 1);
                allocated.push(modulePtr);

                const m = this.getMemory();
                const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
                if (guidPtr && dev.guid) this.writeGuid(v, guidPtr, dev.guid);
                if (wide) {
                    for (let i = 0; i < dev.desc.length; i++) v.setUint16(descPtr + i * 2, dev.desc.charCodeAt(i), true);
                    v.setUint16(descPtr + dev.desc.length * 2, 0, true);
                    for (let i = 0; i < moduleStr.length; i++) v.setUint16(modulePtr + i * 2, moduleStr.charCodeAt(i), true);
                    v.setUint16(modulePtr + moduleStr.length * 2, 0, true);
                } else {
                    for (let i = 0; i < dev.desc.length; i++) m[descPtr + i] = dev.desc.charCodeAt(i);
                    m[descPtr + dev.desc.length] = 0;
                    for (let i = 0; i < moduleStr.length; i++) m[modulePtr + i] = moduleStr.charCodeAt(i);
                    m[modulePtr + moduleStr.length] = 0;
                }

                // DSEnumCallback(lpGuid, lpcstrDescription, lpcstrModule, lpContext) — stdcall,
                // 4 args = 16 bytes callee cleanup. Returns BOOL: FALSE(0)=stop, TRUE=continue.
                const { callbackId } = callbackManager.invokeCallback(
                    lpDSEnumCallback,
                    [guidPtr, descPtr, modulePtr, lpContext],
                    16,
                    (retVal) => {
                        if ((retVal >>> 0) === 0 || idx >= devices.length) { freeAll(); return DS_OK; }
                        return null; // chain the next device (thunk stays suspended)
                    }
                );
                if (firstCallbackId === null) firstCallbackId = callbackId;

                const invocation = callbackManager.getPendingCallback(callbackId);
                if (invocation) {
                    invocation.enumerationState = {
                        continueEnumeration: processNext,
                        finishEnumeration: () => freeAll(),
                    };
                    // Later callbacks in the chain complete the SAME suspended thunk frame.
                    if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                        const firstInv = callbackManager.getPendingCallback(firstCallbackId);
                        if (firstInv?.thunkContext) invocation.thunkContext = firstInv.thunkContext;
                    }
                }
            };

            processNext();

            return { value: DS_OK, suspendedForCallback: true, callbackId: firstCallbackId ?? 0, stackCleanup: STACK_CLEANUP };
        };
        this.exports["directsoundenumeratea"] = registerPlaybackEnumerate(false);
        this.exports["directsoundenumeratew"] = registerPlaybackEnumerate(true);
        this.exports["ord_2"] = this.exports["directsoundenumeratea"];
        this.exports["ord_3"] = this.exports["directsoundenumeratew"];

        this.exports["getdeviceid"] = (ctx, mem, args) => {
            const guidSrcPtr = args[0] >>> 0;
            const guidDestPtr = args[1] >>> 0;
            if (!guidSrcPtr || !guidDestPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (this.guidEquals(view, guidSrcPtr, GUID_DEFAULT_VOICE_PLAYBACK) ||
                this.guidEquals(view, guidSrcPtr, GUID_DEFAULT_PLAYBACK)) {
                this.writeGuid(view, guidDestPtr, GUID_DEFAULT_PLAYBACK);
                return DS_OK;
            }
            if (this.guidEquals(view, guidSrcPtr, GUID_DEFAULT_VOICE_CAPTURE) ||
                this.guidEquals(view, guidSrcPtr, GUID_DEFAULT_CAPTURE)) {
                this.writeGuid(view, guidDestPtr, GUID_DEFAULT_CAPTURE);
                return DS_OK;
            }
            this.copyGuid(view, guidSrcPtr, guidDestPtr);
            return DS_OK;
        };
        this.exports["ord_9"] = this.exports["getdeviceid"];

        const registerCaptureEnumerate = (wide: boolean) => (ctx: unknown, mem: Uint8Array, args: number[]): number | ThunkResult => {
            const lpCallback = args[0];
            const lpContext = args[1];
            if (!lpCallback) return DSERR_INVALIDPARAM;

            const system = System.getInstance();
            if (!system.process || system.isExiting) return DS_OK;
            if (system.process.dispatcher.hasActiveAsyncThunks()) return DS_OK;
            const callbackManager = system.process.dispatcher.callbackManager;
            if (!callbackManager) return DS_OK;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const descStr = wide ? "Primary Sound Capture Driver" : "Primary Sound Capture Driver\0";
            const moduleStr = wide ? "dsound.dll" : "dsound.dll\0";
            let descPtr: number;
            let modulePtr: number;
            if (wide) {
                descPtr = this.process.memory.alloc((descStr.length + 1) * 2);
                for (let i = 0; i < descStr.length; i++) {
                    view.setUint16(descPtr + i * 2, descStr.charCodeAt(i), true);
                }
                view.setUint16(descPtr + descStr.length * 2, 0, true);
                modulePtr = this.process.memory.alloc((moduleStr.length + 1) * 2);
                for (let i = 0; i < moduleStr.length; i++) {
                    view.setUint16(modulePtr + i * 2, moduleStr.charCodeAt(i), true);
                }
                view.setUint16(modulePtr + moduleStr.length * 2, 0, true);
            } else {
                descPtr = this.process.memory.alloc(descStr.length);
                for (let i = 0; i < descStr.length; i++) mem[descPtr + i] = descStr.charCodeAt(i);
                modulePtr = this.process.memory.alloc(moduleStr.length);
                for (let i = 0; i < moduleStr.length; i++) mem[modulePtr + i] = moduleStr.charCodeAt(i);
            }

            const STACK_CLEANUP = 8;
            callbackManager.saveSuspendedThunkContext(ctx as any, STACK_CLEANUP);
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [0, descPtr, modulePtr, lpContext],
                16,
                () => {
                    this.process.memory.free(descPtr);
                    this.process.memory.free(modulePtr);
                    return DS_OK;
                }
            );
            return { value: DS_OK, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
        };
        this.exports["directsoundcaptureenumeratea"] = registerCaptureEnumerate(false);
        this.exports["directsoundcaptureenumeratew"] = registerCaptureEnumerate(true);
        this.exports["ord_7"] = this.exports["directsoundcaptureenumeratea"];
        this.exports["ord_8"] = this.exports["directsoundcaptureenumeratew"];

        // IDirectSound8 IUnknown methods (explicit for validator)
        this.exports["IDirectSound8_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // Guard against a corrupted caller passing ppvObject pointing into a loaded module's
            // non-writable image (observed writing thisPtr into python15.dll .text, where ppvObject
            // was actually a return address). Refuse rather than corrupt guest code.
            if (ppvObject) {
                const mreg = System.getInstance().process?.moduleRegistry;
                const ppvMod = mreg?.getModuleContainingAddress?.(ppvObject >>> 0);
                const ppvWritable = mreg?.isSafeQueryInterfaceOutput?.(ppvObject >>> 0) ?? true;
                if (ppvMod && !ppvWritable) {
                    Logger.error(LogCategory.SYSTEM,
                        `IDirectSound8_QueryInterface: refusing write to 0x${(ppvObject >>> 0).toString(16)} ` +
                        `— inside module image ${ppvMod.name} (non-writable section)`);
                    return E_POINTER;
                }
            }
            if (ppvObject) {
                view.setUint32(ppvObject, thisPtr, true);
            }
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSound8_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSound8_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                if (obj.buffer) {
                    this.destroySoundBuffer(obj.buffer);
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };

        // IDirectSoundBuffer8 IUnknown methods (explicit for validator)
        this.exports["IDirectSoundBuffer8_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read first DWORD of IID to identify the interface
            const iidData1 = riidPtr ? view.getUint32(riidPtr, true) : 0;

            // IDirectSoundNotify = {B0210783-...}
            if (iidData1 === 0xB0210783) {
                const obj = this.objects.get(thisPtr);
                if (!obj || !obj.buffer || !(obj.buffer.flags & DSBCAPS_CTRLPOSITIONNOTIFY)) {
                    if (ppvObject) view.setUint32(ppvObject, 0, true);
                    return E_NOINTERFACE;
                }
                // Create tear-off notify interface sharing the same buffer
                const notifyPtr = this.createObject("IDirectSoundNotify", this.vtables.IDirectSoundNotify.address, obj.buffer);
                obj.buffer.bufferRefCount++;
                if (ppvObject) view.setUint32(ppvObject, notifyPtr, true);
                Logger.log(LogCategory.SYSTEM, `IDirectSoundBuffer8::QI -> IDirectSoundNotify @0x${notifyPtr.toString(16)}`);
                return DS_OK;
            }

            // IDirectSound3DListener = {279AFA84-...}
            if (iidData1 === 0x279AFA84) {
                const obj = this.objects.get(thisPtr);
                if (!obj || !obj.buffer || !(obj.buffer.flags & 0x10)) { // DSBCAPS_CTRL3D
                    if (ppvObject) view.setUint32(ppvObject, 0, true);
                    return E_NOINTERFACE;
                }
                const listenerPtr = this.createObject("IDirectSound3DListener", this.vtables.IDirectSound3DListener.address, obj.buffer);
                obj.buffer.bufferRefCount++;
                if (ppvObject) view.setUint32(ppvObject, listenerPtr, true);
                Logger.log(LogCategory.SYSTEM, `IDirectSoundBuffer8::QI -> IDirectSound3DListener @0x${listenerPtr.toString(16)}`);
                return DS_OK;
            }

            // IDirectSound3DBuffer = {279AFA86-...}
            if (iidData1 === 0x279AFA86) {
                const obj = this.objects.get(thisPtr);
                if (!obj || !obj.buffer) {
                    if (ppvObject) view.setUint32(ppvObject, 0, true);
                    return E_NOINTERFACE;
                }
                const buf3dPtr = this.createObject("IDirectSound3DBuffer", this.vtables.IDirectSound3DBuffer.address, obj.buffer);
                obj.buffer.bufferRefCount++;
                if (ppvObject) view.setUint32(ppvObject, buf3dPtr, true);
                Logger.log(LogCategory.SYSTEM, `IDirectSoundBuffer8::QI -> IDirectSound3DBuffer @0x${buf3dPtr.toString(16)}`);
                return DS_OK;
            }

            // Accept IUnknown (0x00000000), IDirectSoundBuffer (0x279AFA85), IDirectSoundBuffer8 (0x6825A449)
            const knownIIDs = [0x00000000, 0x279AFA85, 0x6825A449];
            if (!knownIIDs.includes(iidData1)) {
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                Logger.log(LogCategory.SYSTEM, `IDirectSoundBuffer8::QI rejected IID {${iidData1.toString(16)}...}`);
                return E_NOINTERFACE;
            }

            if (ppvObject) {
                view.setUint32(ppvObject, thisPtr, true);
            }
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSoundBuffer8_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSoundBuffer8_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.buffer) {
                this.recordLife("release", obj.buffer.id, undefined,
                    `obj=${obj.refCount} buf=${obj.buffer.bufferRefCount} ptr=0x${(ptr >>> 0).toString(16)}`);
            }
            if (obj.refCount <= 0) {
                if (ptr === this.primaryBufferPtr) {
                    this.primaryBufferPtr = 0;
                }
                if (obj.buffer) {
                    obj.buffer.bufferRefCount--;
                    if (obj.buffer.bufferRefCount <= 0) {
                        this.destroySoundBuffer(obj.buffer);
                    }
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };

        // IDirectSoundCapture IUnknown methods
        this.exports["IDirectSoundCapture_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (ppvObject) {
                view.setUint32(ppvObject, thisPtr, true);
            }
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSoundCapture_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSoundCapture_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };

        // IDirectSoundNotify methods
        this.exports["IDirectSoundNotify_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const iidData1 = riidPtr ? view.getUint32(riidPtr, true) : 0;

            // Accept IUnknown, IDirectSoundBuffer, IDirectSoundBuffer8, IDirectSoundNotify
            const knownIIDs = [0x00000000, 0x279AFA85, 0x6825A449, 0xB0210783];
            if (!knownIIDs.includes(iidData1)) {
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                return E_NOINTERFACE;
            }
            if (ppvObject) view.setUint32(ppvObject, thisPtr, true);
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSoundNotify_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSoundNotify_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                if (obj.buffer) {
                    obj.buffer.bufferRefCount--;
                    if (obj.buffer.bufferRefCount <= 0) {
                        this.destroySoundBuffer(obj.buffer);
                    }
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };
        this.exports["idirectsoundnotify_setnotificationpositions"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const count = args[1] >>> 0;
            const posPtr = args[2] >>> 0;
            if (!posPtr && count > 0) return DSERR_INVALIDPARAM;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const notifications: Array<{ offset: number; eventHandle: number }> = [];
            for (let i = 0; i < count; i++) {
                const offset = view.getUint32(posPtr + i * 8, true);
                const handle = view.getUint32(posPtr + i * 8 + 4, true);
                notifications.push({ offset, eventHandle: handle });
            }
            buffer.notifications = notifications;
            buffer.lastNotifyCursor = undefined;
            Logger.log(LogCategory.SYSTEM, `IDirectSoundNotify::SetNotificationPositions count=${count} offsets=[${notifications.map(n => n.offset === DSBPN_OFFSETSTOP ? "STOP" : n.offset).join(",")}]`);
            return DS_OK;
        };

        // IDirectSound3DListener methods (stubs — no spatialization)
        this.exports["IDirectSound3DListener_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const iidData1 = riidPtr ? view.getUint32(riidPtr, true) : 0;
            const knownIIDs3DL = [0x00000000, 0x279AFA84];
            if (!knownIIDs3DL.includes(iidData1)) {
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                return E_NOINTERFACE;
            }
            if (ppvObject) view.setUint32(ppvObject, thisPtr, true);
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSound3DListener_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSound3DListener_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                if (obj.buffer) {
                    obj.buffer.bufferRefCount--;
                    if (obj.buffer.bufferRefCount <= 0) {
                        this.destroySoundBuffer(obj.buffer);
                    }
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };
        this.exports["idirectsound3dlistener_getallparameters"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (!outPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const ls = this.listenerState;
            view.setUint32(outPtr, 64, true);
            view.setFloat32(outPtr + 4, ls.posX, true);
            view.setFloat32(outPtr + 8, ls.posY, true);
            view.setFloat32(outPtr + 12, ls.posZ, true);
            view.setFloat32(outPtr + 16, ls.velX, true);
            view.setFloat32(outPtr + 20, ls.velY, true);
            view.setFloat32(outPtr + 24, ls.velZ, true);
            view.setFloat32(outPtr + 28, ls.frontX, true);
            view.setFloat32(outPtr + 32, ls.frontY, true);
            view.setFloat32(outPtr + 36, ls.frontZ, true);
            view.setFloat32(outPtr + 40, ls.topX, true);
            view.setFloat32(outPtr + 44, ls.topY, true);
            view.setFloat32(outPtr + 48, ls.topZ, true);
            view.setFloat32(outPtr + 52, ls.distanceFactor, true);
            view.setFloat32(outPtr + 56, ls.rolloffFactor, true);
            view.setFloat32(outPtr + 60, ls.dopplerFactor, true);
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getdistancefactor"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, this.listenerState.distanceFactor, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getdopplerfactor"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, this.listenerState.dopplerFactor, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getorientation"] = (ctx, mem, args) => {
            // Two independent D3DVECTOR out-pointers, not one 6-float block.
            const frontPtr = args[1];
            const topPtr = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const ls = this.listenerState;
            if (frontPtr) {
                view.setFloat32(frontPtr, ls.frontX, true);
                view.setFloat32(frontPtr + 4, ls.frontY, true);
                view.setFloat32(frontPtr + 8, ls.frontZ, true);
            }
            if (topPtr) {
                view.setFloat32(topPtr, ls.topX, true);
                view.setFloat32(topPtr + 4, ls.topY, true);
                view.setFloat32(topPtr + 8, ls.topZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getposition"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const ls = this.listenerState;
                view.setFloat32(outPtr, ls.posX, true);
                view.setFloat32(outPtr + 4, ls.posY, true);
                view.setFloat32(outPtr + 8, ls.posZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getrollofffactor"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, this.listenerState.rolloffFactor, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_getvelocity"] = (ctx, mem, args) => {
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const ls = this.listenerState;
                view.setFloat32(outPtr, ls.velX, true);
                view.setFloat32(outPtr + 4, ls.velY, true);
                view.setFloat32(outPtr + 8, ls.velZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setallparameters"] = (ctx, mem, args) => {
            const inPtr = args[1];
            const dwApply = args[2] >>> 0;
            if (!inPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.posX = view.getFloat32(inPtr + 4, true);
            target.posY = view.getFloat32(inPtr + 8, true);
            target.posZ = view.getFloat32(inPtr + 12, true);
            target.velX = view.getFloat32(inPtr + 16, true);
            target.velY = view.getFloat32(inPtr + 20, true);
            target.velZ = view.getFloat32(inPtr + 24, true);
            target.frontX = view.getFloat32(inPtr + 28, true);
            target.frontY = view.getFloat32(inPtr + 32, true);
            target.frontZ = view.getFloat32(inPtr + 36, true);
            target.topX = view.getFloat32(inPtr + 40, true);
            target.topY = view.getFloat32(inPtr + 44, true);
            target.topZ = view.getFloat32(inPtr + 48, true);
            target.distanceFactor = view.getFloat32(inPtr + 52, true);
            target.rolloffFactor = view.getFloat32(inPtr + 56, true);
            target.dopplerFactor = view.getFloat32(inPtr + 60, true);
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setdistancefactor"] = (ctx, mem, args) => {
            const val = i32ToFloat(args[1]);
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.distanceFactor = val;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setdopplerfactor"] = (ctx, mem, args) => {
            const val = i32ToFloat(args[1]);
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.dopplerFactor = val;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setorientation"] = (ctx, mem, args) => {
            // stdcall: this, frontX, frontY, frontZ, topX, topY, topZ, dwApply
            // Floats passed as 32-bit IEEE bit patterns on x86 stack
            const frontX = i32ToFloat(args[1]);
            const frontY = i32ToFloat(args[2]);
            const frontZ = i32ToFloat(args[3]);
            const topX = i32ToFloat(args[4]);
            const topY = i32ToFloat(args[5]);
            const topZ = i32ToFloat(args[6]);
            const dwApply = args[7] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.frontX = frontX; target.frontY = frontY; target.frontZ = frontZ;
            target.topX = topX; target.topY = topY; target.topZ = topZ;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setposition"] = (ctx, mem, args) => {
            const x = i32ToFloat(args[1]);
            const y = i32ToFloat(args[2]);
            const z = i32ToFloat(args[3]);
            const dwApply = args[4] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.posX = x; target.posY = y; target.posZ = z;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setrollofffactor"] = (ctx, mem, args) => {
            const val = i32ToFloat(args[1]);
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.rolloffFactor = val;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_setvelocity"] = (ctx, mem, args) => {
            const x = i32ToFloat(args[1]);
            const y = i32ToFloat(args[2]);
            const z = i32ToFloat(args[3]);
            const dwApply = args[4] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (this.deferredListenerState ??= { ...this.listenerState })
                : this.listenerState;
            target.velX = x; target.velY = y; target.velZ = z;
            if (!(dwApply & DS3D_DEFERRED)) this.flushListenerToSab();
            return DS_OK;
        };
        this.exports["idirectsound3dlistener_commitdeferredsettings"] = (ctx, mem, args) => {
            // Flush deferred listener state
            if (this.deferredListenerState) {
                Object.assign(this.listenerState, this.deferredListenerState);
                this.deferredListenerState = null;
                this.flushListenerToSab();
            }
            // Flush all deferred buffer 3D states
            for (const obj of this.objects.values()) {
                if (obj.buffer && obj.buffer.deferredDs3d) {
                    Object.assign(obj.buffer.ds3d, obj.buffer.deferredDs3d);
                    obj.buffer.deferredDs3d = null;
                    this.flushBuffer3dToSab(obj.buffer);
                }
            }
            return DS_OK;
        };

        // IDirectSound3DBuffer methods (stubs — no spatialization)
        this.exports["IDirectSound3DBuffer_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const iidData1 = riidPtr ? view.getUint32(riidPtr, true) : 0;
            const knownIIDs3DB = [0x00000000, 0x279AFA86];
            if (!knownIIDs3DB.includes(iidData1)) {
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                return E_NOINTERFACE;
            }
            if (ppvObject) view.setUint32(ppvObject, thisPtr, true);
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSound3DBuffer_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSound3DBuffer_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                if (obj.buffer) {
                    obj.buffer.bufferRefCount--;
                    if (obj.buffer.bufferRefCount <= 0) {
                        this.destroySoundBuffer(obj.buffer);
                    }
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };
        this.exports["idirectsound3dbuffer_getallparameters"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            const outPtr = args[1];
            if (!outPtr || !buffer) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const d = buffer.ds3d;
            view.setUint32(outPtr, 64, true);
            view.setFloat32(outPtr + 4, d.posX, true);
            view.setFloat32(outPtr + 8, d.posY, true);
            view.setFloat32(outPtr + 12, d.posZ, true);
            view.setFloat32(outPtr + 16, d.velX, true);
            view.setFloat32(outPtr + 20, d.velY, true);
            view.setFloat32(outPtr + 24, d.velZ, true);
            view.setUint32(outPtr + 28, d.coneInner, true);
            view.setUint32(outPtr + 32, d.coneOuter, true);
            view.setFloat32(outPtr + 36, d.coneOriX, true);
            view.setFloat32(outPtr + 40, d.coneOriY, true);
            view.setFloat32(outPtr + 44, d.coneOriZ, true);
            view.setInt32(outPtr + 48, d.coneOutVol, true);
            view.setFloat32(outPtr + 52, d.minDist, true);
            view.setFloat32(outPtr + 56, d.maxDist, true);
            view.setUint32(outPtr + 60, d.mode, true);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getconeangles"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const insidePtr = args[1];
            const outsidePtr = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (insidePtr) view.setUint32(insidePtr, buffer.ds3d.coneInner, true);
            if (outsidePtr) view.setUint32(outsidePtr, buffer.ds3d.coneOuter, true);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getconeorientation"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, buffer.ds3d.coneOriX, true);
                view.setFloat32(outPtr + 4, buffer.ds3d.coneOriY, true);
                view.setFloat32(outPtr + 8, buffer.ds3d.coneOriZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getconeoutsidevolume"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(outPtr, buffer.ds3d.coneOutVol, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getmaxdistance"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, buffer.ds3d.maxDist, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getmindistance"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, buffer.ds3d.minDist, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getmode"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(outPtr, buffer.ds3d.mode, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getposition"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, buffer.ds3d.posX, true);
                view.setFloat32(outPtr + 4, buffer.ds3d.posY, true);
                view.setFloat32(outPtr + 8, buffer.ds3d.posZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_getvelocity"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const outPtr = args[1];
            if (outPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setFloat32(outPtr, buffer.ds3d.velX, true);
                view.setFloat32(outPtr + 4, buffer.ds3d.velY, true);
                view.setFloat32(outPtr + 8, buffer.ds3d.velZ, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setallparameters"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const inPtr = args[1];
            const dwApply = args[2] >>> 0;
            if (!inPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.posX = view.getFloat32(inPtr + 4, true);
            target.posY = view.getFloat32(inPtr + 8, true);
            target.posZ = view.getFloat32(inPtr + 12, true);
            target.velX = view.getFloat32(inPtr + 16, true);
            target.velY = view.getFloat32(inPtr + 20, true);
            target.velZ = view.getFloat32(inPtr + 24, true);
            target.coneInner = view.getUint32(inPtr + 28, true);
            target.coneOuter = view.getUint32(inPtr + 32, true);
            target.coneOriX = view.getFloat32(inPtr + 36, true);
            target.coneOriY = view.getFloat32(inPtr + 40, true);
            target.coneOriZ = view.getFloat32(inPtr + 44, true);
            target.coneOutVol = view.getInt32(inPtr + 48, true);
            target.minDist = view.getFloat32(inPtr + 52, true);
            target.maxDist = view.getFloat32(inPtr + 56, true);
            target.mode = view.getUint32(inPtr + 60, true);
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setconeangles"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const inner = args[1] >>> 0;
            const outer = args[2] >>> 0;
            const dwApply = args[3] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.coneInner = inner;
            target.coneOuter = outer;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setconeorientation"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const x = i32ToFloat(args[1]);
            const y = i32ToFloat(args[2]);
            const z = i32ToFloat(args[3]);
            const dwApply = args[4] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.coneOriX = x; target.coneOriY = y; target.coneOriZ = z;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setconeoutsidevolume"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const vol = args[1] | 0;
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.coneOutVol = vol;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setmaxdistance"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const val = i32ToFloat(args[1]);
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.maxDist = val;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setmindistance"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const val = i32ToFloat(args[1]);
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.minDist = val;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setmode"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const mode = args[1] >>> 0;
            const dwApply = args[2] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.mode = mode;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setposition"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const x = i32ToFloat(args[1]);
            const y = i32ToFloat(args[2]);
            const z = i32ToFloat(args[3]);
            const dwApply = args[4] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.posX = x; target.posY = y; target.posZ = z;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };
        this.exports["idirectsound3dbuffer_setvelocity"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const x = i32ToFloat(args[1]);
            const y = i32ToFloat(args[2]);
            const z = i32ToFloat(args[3]);
            const dwApply = args[4] >>> 0;
            const target = (dwApply & DS3D_DEFERRED)
                ? (buffer.deferredDs3d ??= { ...buffer.ds3d })
                : buffer.ds3d;
            target.velX = x; target.velY = y; target.velZ = z;
            if (!(dwApply & DS3D_DEFERRED)) this.flushBuffer3dToSab(buffer);
            return DS_OK;
        };

        // Log registered methods for debugging
        const methodNames = Object.keys(this.exports).filter(name => name.toLowerCase().startsWith("idirectsound8_"));
        Logger.verbose(LogCategory.SYSTEM, `DirectSound: Registered ${methodNames.length} IDirectSound8 methods: ${methodNames.join(", ")}`);

        this.exports["idirectsound8_createsoundbuffer"] = (ctx, mem, args) => {
            const perfStart = performance.now();
            const descPtr = args[1];
            const ppBuffer = args[2];
            // The DX8-only 3D validation below is gated on how the device was obtained.
            // A legacy IDirectSound (CoCreateInstance IID_IDirectSound / DirectSoundCreate)
            // does NOT enforce it — Max Payne's sndmfc creates 3D buffers with
            // CTRL3D|CTRLPAN via the legacy interface and never checks the HRESULT, so a
            // spurious DSERR_INVALIDPARAM leaves *ppBuffer uninitialised and the guest
            // dereferences garbage (→ #GP). Mirrors dsound's `from8` gate.
            const isDs8Device = this.objects.get(args[0] >>> 0)?.isDs8 === true;
            const desc = this.readBufferDesc(descPtr);
            if (!desc) {
                return DSERR_INVALIDPARAM;
            }
            if (desc.dwSize !== 20 && desc.dwSize !== 36) {
                return DSERR_INVALIDPARAM;
            }

            const isPrimary = (desc.flags & DSBCAPS_PRIMARYBUFFER) !== 0;

            if (isPrimary) {
                if (desc.format) {
                    return DSERR_INVALIDPARAM;
                }
                if (this.primaryBufferPtr) {
                    const existing = this.objects.get(this.primaryBufferPtr);
                    if (existing) existing.refCount += 1;
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    if (ppBuffer) view.setUint32(ppBuffer, this.primaryBufferPtr, true);
                    return DS_OK;
                }
            } else {
                if (!desc.format) {
                    return DSERR_INVALIDPARAM;
                }
                if (desc.flags & DSBCAPS_LOCHARDWARE) {
                    return DSERR_UNSUPPORTED;
                }
                // DX8-only: a 3D buffer must be mono, and CTRL3D can't combine with CTRLPAN.
                // The legacy IDirectSound interface silently accepts both (3D pan is driven
                // by position, the manual pan control is simply ignored).
                if (isDs8Device && desc.flags & DSBCAPS_CTRL3D && desc.format.channels !== 1) {
                    return DSERR_INVALIDPARAM;
                }
                if (isDs8Device && desc.flags & DSBCAPS_CTRL3D && (desc.flags & DSBCAPS_CTRLPAN)) {
                    return DSERR_INVALIDPARAM;
                }
                const fmtCheck = this.parseWaveFormat(desc.formatPtr ?? 0, true);
                if (fmtCheck.hr !== DS_OK || !fmtCheck.format) {
                    return fmtCheck.hr;
                }
                desc.format = fmtCheck.format;
            }

            const normalizedFlags = (desc.flags & ~(DSBCAPS_LOCHARDWARE | DSBCAPS_LOCSOFTWARE)) | DSBCAPS_LOCSOFTWARE;

            // Default format for primary buffers (set later via SetFormat)
            const defaultFormat: SoundFormat = {
                channels: 2, sampleRate: 22050, bitsPerSample: 16,
                blockAlign: 4, avgBytesPerSec: 88200,
            };
            const format = desc.format ?? defaultFormat;

            // Primary buffers have bufferBytes=0; align secondary sizes to block boundary
            let bufferBytes = isPrimary ? 0 : desc.bufferBytes;
            if (!isPrimary && format.blockAlign > 0 && bufferBytes % format.blockAlign !== 0) {
                bufferBytes += format.blockAlign - (bufferBytes % format.blockAlign);
            }
            const allocStart = performance.now();
            const ptr = bufferBytes > 0 ? this.process.memory.alloc(bufferBytes) : 0;
            // Zero-fill: on real Windows dsound buffers start silent. Our memory.alloc
            // returns dirty memory, so a Lock that doesn't cover the full buffer leaves
            // garbage behind — audible as a crackle/noise burst before the game's first
            // Unlock copies real PCM into the SAB.
            if (ptr > 0 && bufferBytes > 0) {
                mem.fill(0, ptr, ptr + bufferBytes);
            }
            const allocTime = performance.now() - allocStart;

            // Create SAB ring buffer for secondary buffers
            let sab: SharedArrayBuffer | null = null;
            if (!isPrimary && bufferBytes > 0) {
                sab = createAudioRingBuffer(bufferBytes, {
                    channels: format.channels,
                    sampleRate: format.sampleRate,
                    bitsPerSample: format.bitsPerSample,
                }, true /* circular for dsound */);
                // Set frequency to match source sample rate initially
                setCtrl(sab, CTRL_FREQUENCY, format.sampleRate);
            }

            const has3D = (normalizedFlags & DSBCAPS_CTRL3D) !== 0;
            const buffer: SoundBuffer = {
                id: this.nextBufferId++,
                bytes: bufferBytes,
                format,
                flags: normalizedFlags,
                ptr,
                currentPosition: 0,
                volume: 1.0,
                volumeDb: 0,
                pan: 0,
                frequency: format.sampleRate,
                playbackRate: 1.0,
                isPlaying: false,
                isLooping: false,
                lockOffset: undefined,
                lockFirstSize: undefined,
                lockSecondSize: undefined,
                sab,
                registered: false,
                bufferRefCount: 1,
                bufferLost: false,
                has3D,
                ds3d: defaultDs3dState(),
                deferredDs3d: null,
            };

            // Write 3D CTRL slots to SAB
            if (sab && has3D) {
                this.flushBuffer3dToSab(buffer);
            }

            const objStart = performance.now();
            const bufPtr = this.createObject("IDirectSoundBuffer8", this.vtables.IDirectSoundBuffer8.address, buffer);
            const objTime = performance.now() - objStart;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (ppBuffer) {
                view.setUint32(ppBuffer, bufPtr, true);
            }
            if (isPrimary) {
                this.primaryBufferPtr = bufPtr;
            }

            // Register SAB with audio engine (lazy — on first Play, or now if created)
            if (sab) {
                self.postMessage({ type: "audio_register", payload: { id: buffer.id, sab } });
                buffer.registered = true;
            }

            const totalTime = performance.now() - perfStart;
            if (totalTime > 5 || allocTime > 5) {
                Logger.warn(LogCategory.SYSTEM, `Slow CreateSoundBuffer: total=${totalTime.toFixed(2)}ms, alloc=${allocTime.toFixed(2)}ms, obj=${objTime.toFixed(2)}ms, size=${buffer.bytes}`);
            }

            this.recordLife("create", buffer.id, undefined, `${isPrimary ? "PRIMARY" : `${buffer.bytes}b`} flags=0x${normalizedFlags.toString(16)}`);
            Logger.log(LogCategory.SYSTEM, `DirectSound: CreateSoundBuffer ${isPrimary ? "PRIMARY" : `${buffer.bytes}b`} flags=0x${normalizedFlags.toString(16)} @0x${bufPtr.toString(16)}`);
            return DS_OK;
        };

        this.exports["idirectsound8_setcooperativelevel"] = (ctx, mem, args) => {
            Logger.log(LogCategory.SYSTEM, `IDirectSound8::SetCooperativeLevel(hwnd=0x${args[1].toString(16)}, level=${args[2]})`);
            return DS_OK;
        };
        this.exports["idirectsound8_compact"] = () => DS_OK;

        this.exports["idirectsound8_getcaps"] = (ctx, mem, args) => {
            const capsPtr = args[1];
            if (!capsPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const capsSize = view.getUint32(capsPtr, true);
            if (capsSize < DSCAPS_SIZE) return DSERR_INVALIDPARAM;

            // Match Wine/real HW: advertise a certified software mixer, NOT EMULDRIVER.
            // DSCAPS_EMULDRIVER makes apps print the classic "emulated through waveform-audio"
            // warning and often fall back to waveOut / degrade mixing paths.
            const dwFlags = DSCAPS_PRIMARYMONO | DSCAPS_PRIMARYSTEREO |
                            DSCAPS_PRIMARY8BIT | DSCAPS_PRIMARY16BIT |
                            DSCAPS_CONTINUOUSRATE | DSCAPS_CERTIFIED |
                            DSCAPS_SECONDARYMONO | DSCAPS_SECONDARYSTEREO |
                            DSCAPS_SECONDARY8BIT | DSCAPS_SECONDARY16BIT;

            view.setUint32(capsPtr + 0, DSCAPS_SIZE, true);
            view.setUint32(capsPtr + 4, dwFlags, true);
            view.setUint32(capsPtr + 8, DSBFREQUENCY_MIN, true);
            view.setUint32(capsPtr + 12, DSBFREQUENCY_MAX, true);
            view.setUint32(capsPtr + 16, 1, true);
            view.setUint32(capsPtr + 20, 1, true);
            view.setUint32(capsPtr + 24, 1, true);
            view.setUint32(capsPtr + 28, 1, true);
            view.setUint32(capsPtr + 32, 0, true);
            view.setUint32(capsPtr + 36, 0, true);
            view.setUint32(capsPtr + 40, 0, true);
            view.setUint32(capsPtr + 44, 0, true);
            view.setUint32(capsPtr + 48, 0, true);
            view.setUint32(capsPtr + 52, 0, true);
            view.setUint32(capsPtr + 56, 0, true);
            view.setUint32(capsPtr + 60, 0, true);
            view.setUint32(capsPtr + 64, 0, true);
            view.setUint32(capsPtr + 68, 0, true);
            view.setUint32(capsPtr + 72, 0, true);
            view.setUint32(capsPtr + 76, 0, true);
            view.setUint32(capsPtr + 80, 0, true);
            view.setUint32(capsPtr + 84, 0, true);
            view.setUint32(capsPtr + 88, 0, true);
            view.setUint32(capsPtr + 92, 0, true);

            Logger.log(LogCategory.SYSTEM, `IDirectSound8::GetCaps -> flags=0x${dwFlags.toString(16)}`);
            return DS_OK;
        };

        this.exports["idirectsound8_duplicatesoundbuffer"] = (ctx, mem, args) => {
            const srcBufPtr = args[1];
            const ppBuffer = args[2];
            if (srcBufPtr === this.primaryBufferPtr) {
                if (ppBuffer) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ppBuffer, 0, true);
                }
                return DSERR_INVALIDCALL;
            }
            const srcBuffer = this.getBuffer(srcBufPtr);
            if (!srcBuffer || !ppBuffer) return DSERR_INVALIDPARAM;
            if (srcBuffer.bytes === 0) {
                Logger.warn(LogCategory.SYSTEM,
                    `IDirectSound8::DuplicateSoundBuffer: source buffer 0x${srcBufPtr.toString(16)} has 0 bytes (WAV not loaded) — returning DSERR_INVALIDPARAM`);
                return DSERR_INVALIDPARAM;
            }

            const ptr = this.process.memory.alloc(srcBuffer.bytes);

            // Create new SAB for duplicate
            let sab: SharedArrayBuffer | null = null;
            if (srcBuffer.bytes > 0) {
                sab = createAudioRingBuffer(srcBuffer.bytes, {
                    channels: srcBuffer.format.channels,
                    sampleRate: srcBuffer.format.sampleRate,
                    bitsPerSample: srcBuffer.format.bitsPerSample,
                }, true);
                setCtrl(sab, CTRL_FREQUENCY, srcBuffer.frequency);

                // Copy audio data from source SAB if it exists
                if (srcBuffer.sab) {
                    const srcData = new Uint8Array(srcBuffer.sab, CTRL_BLOCK_BYTES);
                    const dstData = new Uint8Array(sab, CTRL_BLOCK_BYTES);
                    dstData.set(srcData);
                }
            }

            const newBuffer: SoundBuffer = {
                id: this.nextBufferId++,
                bytes: srcBuffer.bytes,
                format: { ...srcBuffer.format },
                flags: (srcBuffer.flags & ~DSBCAPS_LOCHARDWARE) | DSBCAPS_LOCSOFTWARE,
                ptr: ptr,
                currentPosition: 0,
                volume: srcBuffer.volume,
                volumeDb: srcBuffer.volumeDb,
                pan: srcBuffer.pan,
                frequency: srcBuffer.frequency,
                playbackRate: srcBuffer.playbackRate,
                isPlaying: false,
                isLooping: false,
                sab,
                registered: false,
                bufferRefCount: 1,
                bufferLost: false,
                has3D: srcBuffer.has3D,
                ds3d: { ...srcBuffer.ds3d },
                deferredDs3d: null,
            };

            if (sab && newBuffer.has3D) {
                this.flushBuffer3dToSab(newBuffer);
            }

            const bufPtr = this.createObject("IDirectSoundBuffer8", this.vtables.IDirectSoundBuffer8.address, newBuffer);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppBuffer, bufPtr, true);

            // Register SAB
            if (sab) {
                self.postMessage({ type: "audio_register", payload: { id: newBuffer.id, sab } });
                newBuffer.registered = true;
            }

            Logger.log(LogCategory.SYSTEM, `IDirectSound8::DuplicateSoundBuffer src=0x${srcBufPtr.toString(16)} -> 0x${bufPtr.toString(16)}`);
            return DS_OK;
        };
        this.exports["idirectsound8_getspeakerconfig"] = (ctx, mem, args) => {
            const ptr = args[1];
            if (ptr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ptr, this.speakerConfig, true);
            }
            return DS_OK;
        };
        this.exports["idirectsound8_setspeakerconfig"] = (ctx, mem, args) => {
            this.speakerConfig = args[1] >>> 0;
            Logger.log(LogCategory.SYSTEM, `IDirectSound8::SetSpeakerConfig(config=0x${this.speakerConfig.toString(16)})`);
            return DS_OK;
        };
        this.exports["idirectsound8_initialize"] = (ctx, mem, args) => {
            Logger.log(LogCategory.SYSTEM, `IDirectSound8::Initialize(guid=0x${args[1].toString(16)})`);
            return DS_OK;
        };
        this.exports["idirectsound8_verifycertification"] = () => DS_OK;

        this.exports["idirectsoundbuffer8_lock"] = (ctx, mem, args) => {
            this.dbgAudioCalls.lock++;
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;

            let offset = args[1] >>> 0;
            let bytesRequested = args[2] >>> 0;
            const ppAudio1 = args[3];
            const pBytes1 = args[4];
            const ppAudio2 = args[5];
            const pBytes2 = args[6];
            const flags = args[7] >>> 0;
            const originalBytesRequested = bytesRequested;

            if (flags & DSBLOCK_FROMWRITECURSOR) {
                // Lock from the DirectSound API write cursor position. Do not use
                // the worklet's internal CTRL_WRITE_CURSOR here: that cursor is a
                // host-mixer boundary, not the guest-visible DSound write cursor.
                if (buffer.sab) {
                    offset = this.getApiCursors(buffer).writeCursor;
                }
            }
            if (flags & DSBLOCK_ENTIREBUFFER) {
                // DSBLOCK_ENTIREBUFFER ignores the caller's offset/byte count and
                // returns the whole buffer, starting at byte 0. Treating it as a
                // buffer-sized circular span from the current write cursor corrupts
                // active streaming buffers by overwriting unread PCM.
                offset = 0;
                bytesRequested = buffer.bytes;
                this.dbgAudioCalls.entireLock++;
            }
            if (bytesRequested === 0) {
                this.dbgAudioCalls.zeroLock++;
            }

            // Defensive guard: if buffer backing storage is gone/corrupted, never hand a stale pointer
            // to guest code. Returning DSERR_INVALIDPARAM is safer than allowing memory corruption.
            if (buffer.bytes > 0) {
                const allocSize = buffer.ptr ? this.process.memory.getSize(buffer.ptr) : undefined;
                if (!buffer.ptr || allocSize === undefined || allocSize < buffer.bytes) {
                    Logger.warn(LogCategory.SYSTEM,
                        `IDirectSoundBuffer8::Lock invalid backing buffer id=${buffer.id} ptr=0x${(buffer.ptr >>> 0).toString(16)} alloc=${allocSize ?? -1} bytes=${buffer.bytes}`);
                    return DSERR_INVALIDPARAM;
                }
            }

            const start = Math.min(offset, buffer.bytes);
            const targetBytes = Math.min(bytesRequested, buffer.bytes);
            const firstChunk = Math.min(targetBytes, buffer.bytes - start);
            const secondChunk = targetBytes - firstChunk;

            buffer.lockOffset = start;
            buffer.lockFirstSize = firstChunk;
            buffer.lockSecondSize = secondChunk;
            buffer.lockFlags = flags;
            buffer.lockRequestedBytes = originalBytesRequested;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (ppAudio1) view.setUint32(ppAudio1, buffer.ptr + start, true);
            if (pBytes1) view.setUint32(pBytes1, firstChunk, true);
            if (ppAudio2) {
                view.setUint32(ppAudio2, secondChunk > 0 ? buffer.ptr : 0, true);
            }
            if (pBytes2) view.setUint32(pBytes2, secondChunk, true);

            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_unlock"] = (ctx, mem, args) => {
            this.dbgAudioCalls.unlock++;
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;

            const audioPtr1 = args[1];
            const bytes1 = args[2] >>> 0;
            const audioPtr2 = args[3];
            const bytes2 = args[4] >>> 0;

            const offset = buffer.lockOffset ?? 0;
            const firstSize = buffer.lockFirstSize ?? 0;
            const secondSize = buffer.lockSecondSize ?? 0;
            const lockFlags = buffer.lockFlags ?? 0;
            const requestedBytes = buffer.lockRequestedBytes ?? 0;

            const copyBytes1 = Math.min(bytes1, firstSize);
            const copyBytes2 = Math.min(bytes2, secondSize);

            // Copy from guest memory directly into SAB ring buffer
            if (buffer.sab) {
                if (audioPtr1 && copyBytes1 > 0) {
                    const src = mem.subarray(audioPtr1, audioPtr1 + copyBytes1);
                    writeRingData(buffer.sab, offset, src, copyBytes1);
                }
                if (audioPtr2 && copyBytes2 > 0) {
                    const src = mem.subarray(audioPtr2, audioPtr2 + copyBytes2);
                    writeRingData(buffer.sab, 0, src, copyBytes2);
                }
            }

            buffer.lockOffset = undefined;
            buffer.lockFirstSize = undefined;
            buffer.lockSecondSize = undefined;
            buffer.lockFlags = undefined;
            buffer.lockRequestedBytes = undefined;

            const totalWritten = copyBytes1 + copyBytes2;
            if (totalWritten > 0) {
                this.dbgAudioCalls.bytesUnlocked += totalWritten;
                if (buffer.bytes > 0) {
                    buffer.lastUnlockCursor = (offset + totalWritten) % buffer.bytes;
                    this.updateStreamFrontier(buffer, totalWritten);
                }
            }

            if (buffer.sab && buffer.bytes >= 4096 && totalWritten > 0) {
                const { playCursor: play, writeCursor: apiWrite } = this.getApiCursors(buffer);
                const overlapPlay = buffer.isPlaying && this.cursorInRange(offset, totalWritten, play, buffer.bytes);
                if (totalWritten >= buffer.bytes) this.dbgAudioCalls.fullUnlock++;
                if (overlapPlay) this.dbgAudioCalls.overlapUnlock++;
                this.dbgLockTrace.push({
                    t: Math.round(performance.now()),
                    off: offset,
                    n: totalWritten,
                    play,
                    apiWrite,
                    lastUnlock: buffer.lastUnlockCursor ?? -1,
                    flags: lockFlags,
                    requestedBytes,
                    isPlaying: buffer.isPlaying,
                    overlapPlay,
                });
                if (this.dbgLockTrace.length > 64) this.dbgLockTrace.splice(0, this.dbgLockTrace.length - 64);
            }

            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_setcurrentposition"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const pos = Math.max(0, Math.min(args[1], buffer.bytes));
            buffer.currentPosition = pos;
            buffer.lastUnlockCursor = pos;
            this.recordLife("setpos", buffer.id, undefined, `pos=${pos}`);
            // §B#5: re-anchor the deterministic cursor to the seek target.
            buffer.playAnchorVirtualMs = TimeService.getInstance().nowMs();
            buffer.playAnchorByte = pos;
            if (buffer.sab) {
                // Seek the worklet's fractional read head — writing PLAY_CURSOR alone is
                // overwritten on the next audio block; CTRL_RESERVED triggers rb.position sync.
                setCtrl(buffer.sab, CTRL_PLAY_CURSOR, pos);
                setCtrl(buffer.sab, CTRL_RESERVED, 1);
            }
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_play"] = (ctx, mem, args) => {
            this.dbgAudioCalls.play++;
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const flags = args[3] >>> 0;
            const isLooping = (flags & DSBPLAY_LOOPING) !== 0;

            const wasStopped = !buffer.isPlaying;
            buffer.isPlaying = true;
            buffer.isLooping = isLooping;
            // A starting source premixes from MIXER_MINPREMIX like any remix does; a Play on
            // an already-running buffer changes nothing about the premixed region.
            if (wasStopped) this.signalRemix(buffer);
            this.recordLife("play", buffer.id, isLooping, `wasStopped=${wasStopped} bytes=${buffer.bytes}`);

            // §B#5 deterministic-audio anchor: pin the virtual-time baseline from which the
            // play cursor advances. Faithful DirectSound Play resumes from the buffer's current
            // position (SetCurrentPosition target, or where a prior Stop left it — 0 only for a
            // fresh buffer), NOT from byte 0. When already running, re-anchor to the live cursor
            // so there is no discontinuity.
            buffer.playAnchorVirtualMs = TimeService.getInstance().nowMs();
            buffer.playAnchorByte = wasStopped
                ? (buffer.currentPosition ?? 0)
                : (this.isDeterministicAudio() ? this.deterministicPlayCursor(buffer) : (buffer.currentPosition ?? 0));

            if (buffer.sab) {
                // Cancel any pending stop request from a previous Stop() call.
                // Without this, a Stop()->Play() sequence races: the worklet can see
                // CTRL_STOP_REQUESTED=1 after we already wrote STATE_PLAYING, force-stop
                // the buffer, and leave it silenced forever.
                setCtrl(buffer.sab, CTRL_STOP_REQUESTED, 0);
                // Reset position on replay from stopped state (matches guest SetCurrentPosition(0)).
                if (wasStopped) {
                    buffer.currentPosition = 0;
                    setCtrl(buffer.sab, CTRL_PLAY_CURSOR, 0);
                    setCtrl(buffer.sab, CTRL_RESERVED, 1);
                }
                // Set loop mode: -1 for infinite loop, 1 for play once
                setCtrl(buffer.sab, CTRL_LOOP_MODE, isLooping ? -1 : 1);
                // Set volume/pan/frequency from current state
                setCtrl(buffer.sab, CTRL_VOLUME, buffer.volumeDb);
                setCtrl(buffer.sab, CTRL_PAN, buffer.pan);
                setCtrl(buffer.sab, CTRL_FREQUENCY, buffer.frequency);
                setCtrl(buffer.sab, CTRL_DATA_LENGTH, buffer.bytes);
                // Start playback
                setCtrl(buffer.sab, CTRL_STATE, STATE_PLAYING);
            }
            // Reset lastNotifyCursor for notification tracking
            if (buffer.notifications) {
                buffer.lastNotifyCursor = undefined;
            }
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_stop"] = (ctx, mem, args) => {
            this.dbgAudioCalls.stop++;
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            buffer.isPlaying = false;
            buffer.isLooping = false;
            this.recordLife("stop", buffer.id, undefined, `bytes=${buffer.bytes}`);

            if (buffer.sab) {
                // Snapshot the live play cursor so stopped GetCurrentPosition is faithful.
                // §B#5: snapshot the deterministic cursor when that mode is active.
                buffer.currentPosition = (this.isDeterministicAudio()
                    ? this.deterministicPlayCursor(buffer)
                    : getCtrl(buffer.sab, CTRL_PLAY_CURSOR)) % buffer.bytes;
                setCtrl(buffer.sab, CTRL_STOP_REQUESTED, 1);
            }
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_setvolume"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLVOLUME)) return DSERR_CONTROLUNAVAIL;
            const vol = args[1] | 0;
            if (vol > DSBVOLUME_MAX || vol < DSBVOLUME_MIN) return DSERR_INVALIDPARAM;
            buffer.volumeDb = Math.max(-10000, Math.min(0, vol));
            if (vol <= -10000) {
                buffer.volume = 0;
            } else if (vol >= 0) {
                buffer.volume = 1;
            } else {
                buffer.volume = Math.pow(10, vol / 2000);
            }
            // Instant update via Atomics
            if (buffer.sab) {
                setCtrl(buffer.sab, CTRL_VOLUME, buffer.volumeDb);
            }
            this.signalRemix(buffer);
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_setfrequency"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLFREQUENCY)) return DSERR_CONTROLUNAVAIL;
            const freq = Math.max(1, args[1] | 0);
            buffer.frequency = freq;
            buffer.playbackRate = freq / buffer.format.sampleRate;
            // Instant update via Atomics
            if (buffer.sab) {
                setCtrl(buffer.sab, CTRL_FREQUENCY, freq);
            }
            this.signalRemix(buffer);
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_getstatus"] = (ctx, mem, args) => {
            this.dbgAudioCalls.getStatus++;
            const buffer = this.getBuffer(args[0]);
            const statusPtr = args[1];
            if (statusPtr) {
                // Sync playing state with worklet
                if (buffer && buffer.isPlaying && buffer.sab) {
                    const sabState = getCtrl(buffer.sab, CTRL_STATE);
                    if (sabState === STATE_STOPPED) {
                        buffer.isPlaying = false;
                        buffer.isLooping = false;
                    }
                }
                let status = 0;
                if (buffer) {
                    if (buffer.bufferLost) status |= DSBSTATUS_BUFFERLOST;
                    if (buffer.isPlaying) status |= DSBSTATUS_PLAYING;
                    if (buffer.isLooping) status |= DSBSTATUS_LOOPING;
                    if (!(buffer.flags & DSBCAPS_LOCHARDWARE)) {
                        status |= DSBSTATUS_LOCSOFTWARE;
                    }
                }
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(statusPtr, status, true);
            }
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_getcurrentposition"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const playPtr = args[1];
            const writePtr = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            const { playCursor, writeCursor } = this.getApiCursors(buffer);

            if (playPtr) view.setUint32(playPtr, playCursor, true);
            if (writePtr) view.setUint32(writePtr, writeCursor, true);
            this.dbgAudioCalls.getCurPos++;
            this.dbgAudioCalls.lastPlay = playCursor;
            this.dbgAudioCalls.lastWrite = writeCursor;
            return DS_OK;
        };

        // FastPath the audio-pump poll pair — NFSU's DSound pump polls GetStatus +
        // GetCurrentPosition ~2K/s each through the full slow-path ladder (top-6 in
        // slowPathReport, the rank-1 hot-EIP cluster 0x654b2f). Both are pure-sync
        // reads (SAB cursor / play flags) → same result, no scheduler boundary cost.
        // They MUST stay traps (guest consumes the out-params immediately after RET).
        {
            const dispatcher = this.process.dispatcher as unknown as {
                registerFastPath?: (dll: string, fn: string, impl: unknown, opts?: { trivial?: boolean }) => void;
            };
            if (dispatcher?.registerFastPath) {
                dispatcher.registerFastPath('dsound', 'idirectsoundbuffer8_getstatus',
                    (cpu: any, _mem8: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
                        const esp = cpu.reg32[4];
                        const buffer = this.getBuffer(view.getUint32(esp + 4, true));
                        const statusPtr = view.getUint32(esp + 8, true);
                        this.dbgAudioCalls.getStatus++;
                        if (statusPtr) {
                            if (buffer && buffer.isPlaying && buffer.sab) {
                                if (getCtrl(buffer.sab, CTRL_STATE) === STATE_STOPPED) {
                                    buffer.isPlaying = false;
                                    buffer.isLooping = false;
                                }
                            }
                            let status = 0;
                            if (buffer) {
                                if (buffer.bufferLost) status |= DSBSTATUS_BUFFERLOST;
                                if (buffer.isPlaying) status |= DSBSTATUS_PLAYING;
                                if (buffer.isLooping) status |= DSBSTATUS_LOOPING;
                                if (!(buffer.flags & DSBCAPS_LOCHARDWARE)) {
                                    status |= DSBSTATUS_LOCSOFTWARE;
                                }
                            }
                            view.setUint32(statusPtr, status, true);
                        }
                        return DS_OK;
                    }, { trivial: true });

                dispatcher.registerFastPath('dsound', 'idirectsoundbuffer8_getcurrentposition',
                    (cpu: any, _mem8: Uint8Array, _mem32: Uint32Array, view: DataView): number => {
                        const esp = cpu.reg32[4];
                        const buffer = this.getBuffer(view.getUint32(esp + 4, true));
                        if (!buffer) return DSERR_INVALIDPARAM;
                        const playPtr = view.getUint32(esp + 8, true);
                        const writePtr = view.getUint32(esp + 12, true);
                        const { playCursor, writeCursor } = this.getApiCursors(buffer);
                        if (playPtr) view.setUint32(playPtr, playCursor, true);
                        if (writePtr) view.setUint32(writePtr, writeCursor, true);
                        this.dbgAudioCalls.getCurPos++;
                        this.dbgAudioCalls.lastPlay = playCursor;
                        this.dbgAudioCalls.lastWrite = writeCursor;
                        return DS_OK;
                    }, { trivial: true });
            }
        }

        this.exports["idirectsoundbuffer8_getformat"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const fmtPtr = args[1];
            if (fmtPtr) {
                this.writeWaveFormat(mem, fmtPtr, buffer.format);
            }
            const bytesWrittenPtr = args[3];
            if (bytesWrittenPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(bytesWrittenPtr, 18, true);
            }
            return DS_OK;
        };

        this.exports["idirectsoundbuffer8_getcaps"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            const capsPtr = args[1];
            if (!capsPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // DSBCAPS structure (20 bytes)
            view.setUint32(capsPtr + 0, 20, true);              // dwSize
            view.setUint32(capsPtr + 4, (buffer.flags | DSBCAPS_LOCSOFTWARE) & ~DSBCAPS_LOCHARDWARE, true);
            view.setUint32(capsPtr + 8, buffer.bytes, true);     // dwBufferBytes
            view.setUint32(capsPtr + 12, 0, true);               // dwUnlockTransferRate
            view.setUint32(capsPtr + 16, 0, true);               // dwPlayCpuOverhead
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_getvolume"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLVOLUME)) return DSERR_CONTROLUNAVAIL;
            const ptr = args[1];
            if (ptr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(ptr, buffer.volumeDb, true);
            }
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_getpan"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLPAN) || (buffer.flags & DSBCAPS_CTRL3D)) return DSERR_CONTROLUNAVAIL;
            const ptr = args[1];
            if (ptr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(ptr, buffer.pan, true);
            }
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_getfrequency"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLFREQUENCY)) return DSERR_CONTROLUNAVAIL;
            const ptr = args[1];
            if (ptr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ptr, buffer.frequency, true);
            }
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_initialize"] = () => DS_OK;
        this.exports["idirectsoundbuffer8_setformat"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            const fmtPtr = args[1];
            if (!buffer || !fmtPtr) return DSERR_INVALIDPARAM;
            const parsed = this.parseWaveFormat(fmtPtr, true);
            if (parsed.hr !== DS_OK || !parsed.format) return parsed.hr;
            buffer.format = parsed.format;
            buffer.frequency = buffer.format.sampleRate;
            buffer.playbackRate = 1.0;
            Logger.log(LogCategory.SYSTEM, `IDirectSoundBuffer8::SetFormat(${buffer.format.channels}ch ${buffer.format.sampleRate}Hz ${buffer.format.bitsPerSample}bit)`);
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_setpan"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!(buffer.flags & DSBCAPS_CTRLPAN) || (buffer.flags & DSBCAPS_CTRL3D)) return DSERR_CONTROLUNAVAIL;
            buffer.pan = Math.max(-10000, Math.min(10000, args[1] | 0));
            // Instant update via Atomics
            if (buffer.sab) {
                setCtrl(buffer.sab, CTRL_PAN, buffer.pan);
            }
            this.signalRemix(buffer);
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_restore"] = (ctx, mem, args) => {
            const buffer = this.getBuffer(args[0]);
            if (!buffer) return DSERR_INVALIDPARAM;
            if (!buffer.bufferLost) return DSERR_BUFFERLOST_HR;
            buffer.bufferLost = false;
            return DS_OK;
        };
        this.exports["idirectsoundbuffer8_setfx"] = () => DS_OK;
        this.exports["idirectsoundbuffer8_acquireresources"] = () => DS_OK;
        this.exports["idirectsoundbuffer8_getobjectinpath"] = () => DS_OK;

        this.exports["idirectsoundcapture_createcapturebuffer"] = (ctx, mem, args) => {
            const descPtr = args[1] >>> 0;
            const ppBuffer = args[2] >>> 0;
            if (!descPtr || !ppBuffer) return DSERR_INVALIDPARAM;

            const desc = this.readBufferDesc(descPtr);
            if (!desc || (desc.dwSize !== 20 && desc.dwSize !== 36)) return DSERR_INVALIDPARAM;
            if (!desc.formatPtr) return DSERR_INVALIDPARAM;

            const fmtCheck = this.parseWaveFormat(desc.formatPtr, true);
            if (fmtCheck.hr !== DS_OK || !fmtCheck.format) return fmtCheck.hr;

            let bufferBytes = desc.bufferBytes;
            const blockAlign = Math.max(1, fmtCheck.format.blockAlign);
            if (bufferBytes % blockAlign !== 0) {
                bufferBytes += blockAlign - (bufferBytes % blockAlign);
            }
            if (bufferBytes === 0) return DSERR_INVALIDPARAM;

            const ptr = this.process.memory.alloc(bufferBytes);
            mem.fill(0, ptr, ptr + bufferBytes);

            const capture: CaptureBuffer = {
                bytes: bufferBytes,
                format: fmtCheck.format,
                flags: desc.flags,
                ptr,
                capturePosition: 0,
                isCapturing: false,
                isLooping: false,
            };

            const bufPtr = this.createObject("IDirectSoundCaptureBuffer8", this.vtables.IDirectSoundCaptureBuffer8.address, undefined, capture);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppBuffer, bufPtr, true);
            Logger.log(LogCategory.SYSTEM, `DirectSoundCapture: CreateCaptureBuffer ${bufferBytes}b @0x${bufPtr.toString(16)}`);
            return DS_OK;
        };
        this.exports["idirectsoundcapture_getcaps"] = (ctx, mem, args) => {
            const capsPtr = args[1] >>> 0;
            if (!capsPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const capsSize = view.getUint32(capsPtr, true);
            if (capsSize < DSCCAPS_SIZE) return DSERR_INVALIDPARAM;
            view.setUint32(capsPtr + 0, DSCCAPS_SIZE, true);
            view.setUint32(capsPtr + 4, DSCCAPS_CERTIFIED, true);
            view.setUint32(capsPtr + 8, 0x000000ff, true);
            view.setUint32(capsPtr + 12, 2, true);
            return DS_OK;
        };
        this.exports["idirectsoundcapture_initialize"] = () => DS_OK;

        this.exports["IDirectSoundCaptureBuffer8_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riidPtr = args[1];
            const ppvObject = args[2];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const iidData1 = riidPtr ? view.getUint32(riidPtr, true) : 0;
            const known = [0x00000000, 0xB0210782, 0x00990DF4];
            if (!known.includes(iidData1)) {
                if (ppvObject) view.setUint32(ppvObject, 0, true);
                return E_NOINTERFACE;
            }
            if (ppvObject) view.setUint32(ppvObject, thisPtr, true);
            const obj = this.objects.get(thisPtr);
            if (obj) obj.refCount += 1;
            return DS_OK;
        };
        this.exports["IDirectSoundCaptureBuffer8_AddRef"] = (ctx, mem, args) => {
            const obj = this.objects.get(args[0]);
            if (obj) obj.refCount += 1;
            return obj ? obj.refCount : 0;
        };
        this.exports["IDirectSoundCaptureBuffer8_Release"] = (ctx, mem, args) => {
            const ptr = args[0];
            const obj = this.objects.get(ptr);
            if (!obj) return 0;
            obj.refCount -= 1;
            if (obj.refCount <= 0) {
                if (obj.capture?.ptr) {
                    this.process.memory.free(obj.capture.ptr);
                }
                this.objects.delete(ptr);
                freeComObject(this.process.memory, ptr);
            }
            return Math.max(0, obj.refCount);
        };
        this.exports["idirectsoundcapturebuffer8_getcaps"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const capsPtr = args[1] >>> 0;
            if (!capsPtr) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (view.getUint32(capsPtr, true) < DSCBCAPS_SIZE) return DSERR_INVALIDPARAM;
            view.setUint32(capsPtr + 0, DSCBCAPS_SIZE, true);
            view.setUint32(capsPtr + 4, capture.flags | DSBCAPS_LOCSOFTWARE, true);
            view.setUint32(capsPtr + 8, capture.bytes, true);
            view.setUint32(capsPtr + 12, 0, true);
            view.setUint32(capsPtr + 16, 0, true);
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_getcurrentposition"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (args[1]) view.setUint32(args[1], capture.capturePosition, true);
            if (args[2]) view.setUint32(args[2], capture.capturePosition, true);
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_getformat"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const fmtPtr = args[1] >>> 0;
            if (fmtPtr) this.writeWaveFormat(mem, fmtPtr, capture.format);
            const bytesWrittenPtr = args[3] >>> 0;
            if (bytesWrittenPtr) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(bytesWrittenPtr, 18, true);
            }
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_getstatus"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            const statusPtr = args[1] >>> 0;
            if (!statusPtr) return DSERR_INVALIDPARAM;
            let status = 0;
            if (capture) {
                if (capture.isCapturing) status |= DSCBSTATUS_CAPTURING;
                if (capture.isLooping) status |= DSCBSTATUS_LOOPING;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(statusPtr, status, true);
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_initialize"] = () => DSERR_ALREADYINITIALIZED;
        this.exports["idirectsoundcapturebuffer8_lock"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const offset = Math.min(args[1] >>> 0, capture.bytes);
            const bytesRequested = args[2] >>> 0;
            const firstChunk = Math.min(bytesRequested, capture.bytes - offset);
            const secondChunk = Math.max(0, Math.min(bytesRequested - firstChunk, capture.bytes));
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (args[3]) view.setUint32(args[3], capture.ptr + offset, true);
            if (args[4]) view.setUint32(args[4], firstChunk, true);
            if (args[5]) view.setUint32(args[5], secondChunk > 0 ? capture.ptr : 0, true);
            if (args[6]) view.setUint32(args[6], secondChunk, true);
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_unlock"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const bytes1 = args[2] >>> 0;
            const bytes2 = args[4] >>> 0;
            capture.capturePosition = (capture.capturePosition + bytes1 + bytes2) % Math.max(1, capture.bytes);
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_start"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            const flags = args[1] >>> 0;
            capture.isCapturing = true;
            capture.isLooping = (flags & DSCBSTART_LOOPING) !== 0;
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_stop"] = (ctx, mem, args) => {
            const capture = this.getCaptureBuffer(args[0]);
            if (!capture) return DSERR_INVALIDPARAM;
            capture.isCapturing = false;
            capture.isLooping = false;
            return DS_OK;
        };
        this.exports["idirectsoundcapturebuffer8_getobjectinpath"] = () => DSERR_OBJECTNOTFOUND;
        this.exports["idirectsoundcapturebuffer8_getfxstatus"] = () => DS_OK;

        this.startNotificationPump();
    }

    /** Snapshot every sound buffer's playback + notification state (dbg.audio()). */
    getAudioDebugState(): any {
        const buffers: any[] = [];
        for (const [ptr, obj] of this.objects.entries()) {
            if (!obj.buffer) continue;
            const b = obj.buffer;
            let sabState = -1, sabPlay = -1, sabWrite = -1;
            let apiPlay = -1, apiWrite = -1;
            if (b.sab) {
                try {
                    sabState = getCtrl(b.sab, CTRL_STATE);
                    sabPlay = getCtrl(b.sab, CTRL_PLAY_CURSOR);
                    sabWrite = getCtrl(b.sab, CTRL_WRITE_CURSOR);
                    const apiCursors = this.getApiCursors(b);
                    apiPlay = apiCursors.playCursor;
                    apiWrite = apiCursors.writeCursor;
                } catch { /* ignore */ }
            }
            let sampleRate = 0, blockAlign = 0;
            if (b.sab) {
                try {
                    sampleRate = getCtrl(b.sab, CTRL_SAMPLE_RATE);
                    blockAlign = getCtrl(b.sab, CTRL_BLOCK_ALIGN);
                } catch { /* ignore */ }
            }
            buffers.push({
                ptr: `0x${(ptr >>> 0).toString(16)}`,
                id: b.id,
                type: obj.type,
                isPlaying: b.isPlaying,
                isLooping: b.isLooping,
                bytes: b.bytes,
                sampleRate,
                blockAlign,
                currentPosition: b.currentPosition,
                freq: b.frequency,
                rate: b.playbackRate,
                hasSab: !!b.sab,
                sabState, sabPlay, sabWrite,
                apiPlayCursor: apiPlay,
                apiWriteCursor: apiWrite,
                // Lifetime bookkeeping: an orphan surviving a guest Release shows up here
                // as a live objRefCount/bufferRefCount pair with no matching lifeRing entry.
                objRefCount: obj.refCount,
                bufferRefCount: b.bufferRefCount,
                streamed: !!b.streamed,
                lastUnlockCursor: b.lastUnlockCursor ?? null,
                notifyCount: b.notifications?.length ?? 0,
                lastNotifyCursor: b.lastNotifyCursor ?? null,
                notifyOffsets: b.notifications?.map(n => n.offset === 0xffffffff ? 'STOP' : n.offset) ?? [],
                notifyEvents: b.notifications?.map(n => `0x${(n.eventHandle >>> 0).toString(16)}`) ?? [],
            });
        }
        return { objectCount: this.objects.size, notifyIntervalActive: this.notifyTimerId !== null, calls: this.dbgAudioCalls, lockTrace: this.dbgLockTrace.slice(-32), lifeRing: this.bufferLifeRing.slice(-96), buffers };
    }

    private startNotificationPump(): void {
        if (this.notifyTimerId !== null) return;
        const scheduler = System.getInstance().scheduler;
        if (!scheduler) {
            // One-shot start (not re-entered per call like winmm), so a missing
            // scheduler here means notifications are permanently dead — make it
            // loud instead of a silent no-op.
            Logger.warn(LogCategory.SYSTEM, "DirectSound: scheduler unavailable at startNotificationPump — IDirectSoundNotify events disabled");
            return;
        }

        // Guest-visible IDirectSoundNotify events must be driven by scheduler
        // virtual time, not host setInterval. A busy-spinning guest thread can
        // starve host macrotasks, but timerWheel is polled in-band at scheduler
        // boundaries and during idle pumps.
        this.notifyTimerId = scheduler.timerWheel.add(
            10,
            true,
            TimerKind.DSOUND_NOTIFY,
            () => this.checkNotifications(),
            TimeService.getInstance().nowMs(),
        );
    }

    private stopNotificationPump(): void {
        if (this.notifyTimerId === null) return;
        const scheduler = System.getInstance().scheduler;
        scheduler?.timerWheel.cancel(this.notifyTimerId);
        this.notifyTimerId = null;
    }

    private checkNotifications(): void {
        const system = System.getInstance();
        if (!system.process || system.isExiting) return;
        const scheduler = system.scheduler;
        if (!scheduler) return;

        for (const obj of this.objects.values()) {
            if (obj.type !== "IDirectSoundBuffer8" || !obj.buffer) continue;
            const buffer = obj.buffer;
            if (!buffer.notifications || buffer.notifications.length === 0) continue;
            if (!buffer.sab) continue;

            const sabState = getCtrl(buffer.sab, CTRL_STATE);
            const currentCursor = getCtrl(buffer.sab, CTRL_PLAY_CURSOR);

            // Check OFFSETSTOP: worklet transitioned to stopped
            if (sabState === STATE_STOPPED && buffer.isPlaying) {
                buffer.isPlaying = false;
                buffer.isLooping = false;
                for (const notif of buffer.notifications) {
                    if (notif.offset === DSBPN_OFFSETSTOP) {
                        scheduler.setEvent(notif.eventHandle);
                    }
                }
            }

            // Check position-based notifications (only while playing)
            if (sabState === STATE_PLAYING && buffer.lastNotifyCursor !== undefined) {
                const lastCursor = buffer.lastNotifyCursor;
                for (const notif of buffer.notifications) {
                    if (notif.offset === DSBPN_OFFSETSTOP) continue;
                    if (this.cursorCrossed(lastCursor, currentCursor, notif.offset, buffer.bytes)) {
                        scheduler.setEvent(notif.eventHandle);
                    }
                }
            }

            buffer.lastNotifyCursor = currentCursor;
        }
    }

    /** Check if cursor crossed a notification offset (handles circular wrap) */
    private cursorCrossed(lastCursor: number, currentCursor: number, offset: number, bufferSize: number): boolean {
        if (bufferSize === 0) return false;
        if (lastCursor === currentCursor) return false;
        if (lastCursor < currentCursor) {
            // No wrap: offset in (lastCursor, currentCursor]
            return offset > lastCursor && offset <= currentCursor;
        } else {
            // Wrapped: offset in (lastCursor, bufferSize) or [0, currentCursor]
            return offset > lastCursor || offset <= currentCursor;
        }
    }

    private cursorInRange(start: number, length: number, cursor: number, bufferSize: number): boolean {
        if (bufferSize <= 0 || length <= 0) return false;
        if (length >= bufferSize) return true;
        const normalizedStart = start % bufferSize;
        const normalizedCursor = cursor % bufferSize;
        const end = (normalizedStart + length) % bufferSize;
        if (normalizedStart < end) {
            return normalizedCursor >= normalizedStart && normalizedCursor < end;
        }
        return normalizedCursor >= normalizedStart || normalizedCursor < end;
    }

    /** Classify a LOCSOFTWARE looping buffer the guest has refilled past twice its own
     *  size as a genuine stream (a write-once static loop never gets there). Diagnostics
     *  only — it tells a stalled music pump apart from an ambience loop in `dbgSnapshot`.
     *  Playback does not consult it: the mixer treats both the same, because the real one
     *  does. */
    private updateStreamFrontier(buffer: SoundBuffer, justWritten: number): void {
        if (!buffer.sab || buffer.bytes < 4096) return;
        buffer.cumulativeWritten = (buffer.cumulativeWritten ?? 0) + justWritten;
        if (!buffer.streamed && buffer.cumulativeWritten >= buffer.bytes * 2) {
            buffer.streamed = true;
            Logger.log(LogCategory.SYSTEM, `dsound: buffer id=${buffer.id} classified LOOP_STREAM`);
        }
    }

    /**
     * Advance the premix ramp to `now`. Time-driven, exactly like the mixer thread:
     * the depth grows on its own refresh schedule whether or not the guest is late.
     * (An earlier model only deepened when a write was caught overlapping play, so the
     * lead could only grow AFTER the pump had already been starved once — the real mixer
     * has no starvation feedback at all, it just ramps.) Advanced lazily from
     * dsoundLeadBytes rather than on a timer: every cursor read is a refresh point, and
     * a buffer nobody queries needs no depth.
     */
    private advancePremix(buffer: SoundBuffer, now: number): number {
        let premix = buffer.premixMs ?? PREMIX_MIN_MS;
        let step = buffer.premixStepMs ?? PREMIX_STEP_MS;
        const last = buffer.premixAdvancedAtMs;
        if (last === undefined) {
            buffer.premixMs = premix;
            buffer.premixStepMs = step;
            buffer.premixAdvancedAtMs = now;
            return premix;
        }
        // Refresh interval = min(premixed/2, nextNotify) clamped to [MIN/2, MAX/2]. We
        // have no notify deadline to shorten it, so the premixed half-life is the term.
        let elapsed = now - last;
        let advancedAt = last;
        while (premix < PREMIX_MAX_MS) {
            const interval = Math.min(PREMIX_MAX_MS / 2, Math.max(PREMIX_MIN_MS / 2, premix / 2));
            if (elapsed < interval) break;
            elapsed -= interval;
            advancedAt += interval;
            premix = Math.min(PREMIX_MAX_MS, premix + step);
            step += PREMIX_STEP_MS;
        }
        buffer.premixMs = premix;
        buffer.premixStepMs = step;
        // At the ceiling the schedule no longer matters; keep the clock current so a
        // later reset restarts from now instead of replaying the whole idle gap.
        buffer.premixAdvancedAtMs = premix >= PREMIX_MAX_MS ? now : advancedAt;
        return premix;
    }

    /**
     * A remix rewinds the mixer's next-mix position back to the write cursor and rebuilds
     * the premixed region from PREMIX_MIN_MS (nt5 dsound CGrace::Refresh with fRemix, plus
     * the MixThread branch that resets dtimePremix). The reported write cursor therefore
     * dips back toward play and re-ramps. Raised by the same things the real one is:
     * volume/pan/frequency changed on a PLAYING, unmuted buffer.
     */
    private signalRemix(buffer: SoundBuffer): void {
        if (!buffer.isPlaying) return;
        buffer.premixMs = PREMIX_MIN_MS;
        buffer.premixStepMs = PREMIX_STEP_MS;
        // Clearing the anchor rather than stamping it here keeps one clock owner: the next
        // advancePremix re-seeds from whatever `now` it is given, so the ramp cannot see a
        // reset stamped on a different time base than the one it measures against.
        buffer.premixAdvancedAtMs = undefined;
    }

    private dsoundLeadBytes(buffer: SoundBuffer): number {
        // All our buffers report DSBSTATUS_LOCSOFTWARE, so the write cursor is the software
        // mixer's premix frontier, NOT the ~15 ms figure of the hardware-buffer path we
        // never take. Streaming pumps are calibrated against that frontier: at a 12 ms lead
        // a 50 ms-period pump leaves the play cursor in already-consumed data ~40% of the
        // time (audible ~19 Hz crackle), and a pump slower than the ceiling crackles no
        // matter what it does — which is why the ceiling has to be the real 200 ms.
        const blockAlign = Math.max(1, buffer.format.blockAlign);
        const premixMs = this.advancePremix(buffer, performance.now());
        const leadFrames = Math.max(64, Math.round((buffer.format.sampleRate * premixMs) / 1000));
        return Math.min(leadFrames * blockAlign, Math.floor(buffer.bytes / 4));
    }

    private dsoundStoppedWriteCursor(buffer: SoundBuffer, playCursor: number): number {
        const blockAlign = Math.max(1, buffer.format.blockAlign);
        const marginFrames = Math.max(128, Math.ceil(buffer.format.sampleRate * 0.015));
        const marginBytes = Math.min(marginFrames * blockAlign, Math.floor(buffer.bytes / 2));
        return (playCursor + buffer.bytes - marginBytes) % buffer.bytes;
    }

    /**
     * Deterministic-audio diagnostic toggle (§B#5). When on, the DSound play cursor is derived
     * from instruction-anchored VIRTUAL time instead of the AudioContext-driven SAB cursor.
     *
     * Why: the SAB play cursor (CTRL_PLAY_CURSOR) is advanced by the audio worklet on the real
     * render thread — i.e. by wall-clock playback rate — so GetCurrentPosition returns a value
     * that varies run-to-run. Games gate their streaming pump on it (Lock size = play-cursor
     * delta), so this is the last wall-clock non-determinism steering guest interleaving after
     * the scheduler switch-gates were instruction-anchored (§A). Removing it turns a flaky,
     * moving-fault-site race into a reproducible one — catchable in a single trace.
     *
     * Enable from the host console with `dbgFlag('__detAudio', true)` — persisted in
     * localStorage and replayed to the worker BEFORE any game loads (same channel as
     * `__noHeapSlab`), so it is set before the first buffer plays. Flippable live too.
     */
    private isDeterministicAudio(): boolean {
        // INVARIANT: diagnostic-only, MUST stay off by default. Deriving the play cursor from
        // virtual time decouples it from the worklet's real sample consumption — if virtual and
        // wall clocks diverge (slow host), the guest under/over-fills the ring → underrun/overrun.
        // The faithful default is the SAB cursor (real DAC playback). Never flip this default on;
        // it exists to make a flaky race reproducible in a trace, not to ship.
        return (globalThis as any).__detAudio === true;
    }

    /** Play cursor advanced by virtual time since the play anchor, frame-aligned to blockAlign
     *  (matching hardware cursor granularity). Deterministic replacement for the SAB cursor. */
    private deterministicPlayCursor(buffer: SoundBuffer): number {
        const blockAlign = buffer.format.blockAlign || 1;
        // Effective byte rate honours a guest-set frequency (SetFrequency); falls back to the
        // format's native rate. rate(bytes/s) = frame size × sample rate.
        const hz = buffer.frequency > 0 ? buffer.frequency : buffer.format.sampleRate;
        const rate = hz * blockAlign;
        if (rate <= 0 || buffer.bytes <= 0) return 0;
        const nowMs = TimeService.getInstance().nowMs();
        const elapsedMs = Math.max(0, nowMs - (buffer.playAnchorVirtualMs ?? nowMs));
        const advanced = Math.floor((elapsedMs * rate) / 1000);
        let cursor = ((buffer.playAnchorByte ?? 0) + advanced) % buffer.bytes;
        cursor -= cursor % blockAlign;
        return cursor;
    }

    private getApiCursors(buffer: SoundBuffer): { playCursor: number; writeCursor: number } {
        if (!buffer.sab || buffer.bytes <= 0) {
            return { playCursor: 0, writeCursor: 0 };
        }

        if (buffer.isPlaying) {
            const rawCursor = this.isDeterministicAudio()
                ? this.deterministicPlayCursor(buffer)
                : getCtrl(buffer.sab, CTRL_PLAY_CURSOR);
            const playCursor = rawCursor % buffer.bytes;
            // Faithful DSound: the write cursor LEADS the play cursor by the software
            // mixer's premixed region (45 ms ramping to 200 ms; see dsoundLeadBytes).
            // The span [play, write) is committed to the mixer and unsafe to
            // overwrite; a streaming app writes AHEAD of
            // `write`. Write-cursor-driven mixers (UE1/Galaxy) splice at
            // [myPos, write + latency) — placing write BEHIND play collapses their
            // lead to ~0 and produces 20 ms-periodic crackle (see worklet note in
            // bottleship-audio-worklet.ts). Natalie Brooks ignores the write cursor
            // entirely: its refill pump (NatalieBrooksSTH.exe sub_4aecd0) sizes the
            // Lock from the PLAY-cursor delta (`edi = play - lastPlayPos`) — the
            // write out-param of GetCurrentPosition is fetched and discarded — so
            // this lead choice is a no-op for that title and exists for correctness
            // toward the clients that DO read it.
            const leadBytes = this.dsoundLeadBytes(buffer);
            return { playCursor, writeCursor: (playCursor + leadBytes) % buffer.bytes };
        }

        const playCursor = (buffer.currentPosition ?? 0) % buffer.bytes;
        return { playCursor, writeCursor: this.dsoundStoppedWriteCursor(buffer, playCursor) };
    }

    private destroySoundBuffer(buffer: SoundBuffer): void {
        this.recordLife("destroy", buffer.id, undefined, `wasPlaying=${buffer.isPlaying} bytes=${buffer.bytes}`);
        // A destroyed buffer is not playing: drop the state before the ring goes away so
        // nothing (notification pump, debug snapshot) can read it back as live.
        buffer.isPlaying = false;
        buffer.isLooping = false;
        if (buffer.registered) {
            self.postMessage({ type: "audio_unregister", payload: { id: buffer.id } });
            buffer.registered = false;
        }
        if (buffer.ptr) {
            this.process.memory.free(buffer.ptr);
            buffer.ptr = 0;
        }
        buffer.sab = null;
        buffer.bytes = 0;
    }

    private createObject(type: DSoundObjectType, vtablePtr: number, buffer?: SoundBuffer, capture?: CaptureBuffer, isDs8?: boolean): number {
        const mem = this.getMemory();
        const objPtr = allocateComObject(this.process.memory, mem, vtablePtr);
        this.objects.set(objPtr, { type, refCount: 1, buffer, capture, isDs8 });
        return objPtr;
    }

    private getBuffer(ptr: number): SoundBuffer | null {
        const obj = this.objects.get(ptr);
        if (!obj || !obj.buffer) return null;
        const validTypes: DSoundObjectType[] = ["IDirectSoundBuffer8", "IDirectSoundNotify", "IDirectSound3DListener", "IDirectSound3DBuffer"];
        if (!validTypes.includes(obj.type)) return null;
        return obj.buffer;
    }

    private getCaptureBuffer(ptr: number): CaptureBuffer | null {
        const obj = this.objects.get(ptr);
        if (!obj || obj.type !== "IDirectSoundCaptureBuffer8" || !obj.capture) return null;
        return obj.capture;
    }

    private readBufferDesc(descPtr: number): {
        dwSize: number;
        bufferBytes: number;
        flags: number;
        formatPtr: number;
        format: SoundFormat | null;
    } | null {
        if (!descPtr) return null;
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = view.getUint32(descPtr, true);
        const flags = view.getUint32(descPtr + 4, true);
        const bufferBytes = view.getUint32(descPtr + 8, true);
        const formatPtr = dwSize >= 20 ? view.getUint32(descPtr + 16, true) : 0;
        const format = formatPtr ? this.parseWaveFormat(formatPtr, false).format ?? null : null;
        return { dwSize, bufferBytes, flags, formatPtr, format };
    }

    private parseWaveFormat(formatPtr: number, strict: boolean): { hr: number; format?: SoundFormat } {
        if (!formatPtr) {
            return { hr: strict ? DSERR_INVALIDPARAM : DS_OK };
        }
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const formatTag = view.getUint16(formatPtr, true);
        const channels = view.getUint16(formatPtr + 2, true);
        const sampleRate = view.getUint32(formatPtr + 4, true);
        const avgBytesPerSec = view.getUint32(formatPtr + 8, true);
        const blockAlign = view.getUint16(formatPtr + 12, true);
        const bitsPerSample = view.getUint16(formatPtr + 14, true);
        const cbSize = view.getUint16(formatPtr + 16, true);

        if (formatTag !== WAVE_FORMAT_PCM &&
            formatTag !== WAVE_FORMAT_IEEE_FLOAT &&
            formatTag !== WAVE_FORMAT_EXTENSIBLE) {
            return { hr: DSERR_BADFORMAT };
        }
        if (bitsPerSample < 8 || (bitsPerSample % 8) !== 0 ||
            channels === 0 || sampleRate === 0 || avgBytesPerSec === 0) {
            return { hr: DSERR_INVALIDPARAM };
        }
        const expectedAlign = channels * bitsPerSample / 8;
        if (blockAlign !== expectedAlign) {
            return { hr: DSERR_INVALIDPARAM };
        }
        if (channels > 2 && formatTag !== WAVE_FORMAT_EXTENSIBLE) {
            return { hr: DSERR_INVALIDPARAM };
        }
        if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
            if (cbSize < 22) return { hr: DSERR_INVALIDPARAM };
            const subFormatTag = view.getUint32(formatPtr + 24, true);
            if (subFormatTag !== WAVE_FORMAT_PCM && subFormatTag !== WAVE_FORMAT_IEEE_FLOAT) {
                return { hr: DSERR_BADFORMAT };
            }
        }
        return {
            hr: DS_OK,
            format: { channels, sampleRate, avgBytesPerSec, blockAlign, bitsPerSample },
        };
    }

    private writeGuid(view: DataView, ptr: number, parts: readonly [number, number, number, ...number[]]): void {
        view.setUint32(ptr, parts[0], true);
        view.setUint16(ptr + 4, parts[1], true);
        view.setUint16(ptr + 6, parts[2], true);
        for (let i = 0; i < 8; i++) {
            view.setUint8(ptr + 8 + i, parts[3 + i]);
        }
    }

    private copyGuid(view: DataView, srcPtr: number, destPtr: number): void {
        for (let i = 0; i < 16; i++) {
            view.setUint8(destPtr + i, view.getUint8(srcPtr + i));
        }
    }

    private guidEquals(view: DataView, ptr: number, parts: readonly [number, number, number, ...number[]]): boolean {
        if (view.getUint32(ptr, true) !== parts[0]) return false;
        if (view.getUint16(ptr + 4, true) !== parts[1]) return false;
        if (view.getUint16(ptr + 6, true) !== parts[2]) return false;
        for (let i = 0; i < 8; i++) {
            if (view.getUint8(ptr + 8 + i) !== parts[3 + i]) return false;
        }
        return true;
    }

    private readWaveFormat(formatPtr: number): SoundFormat {
        const parsed = this.parseWaveFormat(formatPtr, false);
        if (parsed.format) return parsed.format;
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return {
            channels: view.getUint16(formatPtr + 2, true),
            sampleRate: view.getUint32(formatPtr + 4, true),
            avgBytesPerSec: view.getUint32(formatPtr + 8, true),
            blockAlign: view.getUint16(formatPtr + 12, true),
            bitsPerSample: view.getUint16(formatPtr + 14, true),
        };
    }

    private writeWaveFormat(mem: Uint8Array, formatPtr: number, format: SoundFormat): void {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint16(formatPtr, 1, true);
        view.setUint16(formatPtr + 2, format.channels, true);
        view.setUint32(formatPtr + 4, format.sampleRate, true);
        view.setUint32(formatPtr + 8, format.avgBytesPerSec, true);
        view.setUint16(formatPtr + 12, format.blockAlign, true);
        view.setUint16(formatPtr + 14, format.bitsPerSample, true);
        view.setUint16(formatPtr + 16, 0, true);
    }

    private flushListenerToSab(): void {
        const sab = this.listenerSab;
        if (!sab) return;
        const ctrl = new Int32Array(sab, 0, 16);
        const ls = this.listenerState;
        Atomics.store(ctrl, LCTRL_POS_X, floatToI32(ls.posX));
        Atomics.store(ctrl, LCTRL_POS_Y, floatToI32(ls.posY));
        Atomics.store(ctrl, LCTRL_POS_Z, floatToI32(ls.posZ));
        Atomics.store(ctrl, LCTRL_VEL_X, floatToI32(ls.velX));
        Atomics.store(ctrl, LCTRL_VEL_Y, floatToI32(ls.velY));
        Atomics.store(ctrl, LCTRL_VEL_Z, floatToI32(ls.velZ));
        Atomics.store(ctrl, LCTRL_FRONT_X, floatToI32(ls.frontX));
        Atomics.store(ctrl, LCTRL_FRONT_Y, floatToI32(ls.frontY));
        Atomics.store(ctrl, LCTRL_FRONT_Z, floatToI32(ls.frontZ));
        Atomics.store(ctrl, LCTRL_TOP_X, floatToI32(ls.topX));
        Atomics.store(ctrl, LCTRL_TOP_Y, floatToI32(ls.topY));
        Atomics.store(ctrl, LCTRL_TOP_Z, floatToI32(ls.topZ));
        Atomics.store(ctrl, LCTRL_DIST_FACTOR, floatToI32(ls.distanceFactor));
        Atomics.store(ctrl, LCTRL_ROLLOFF_FACTOR, floatToI32(ls.rolloffFactor));
        Atomics.store(ctrl, LCTRL_DOPPLER_FACTOR, floatToI32(ls.dopplerFactor));
    }

    private flushBuffer3dToSab(buffer: SoundBuffer): void {
        const sab = buffer.sab;
        if (!sab) return;
        const d = buffer.ds3d;
        setCtrlFloat(sab, CTRL_3D_POS_X, d.posX);
        setCtrlFloat(sab, CTRL_3D_POS_Y, d.posY);
        setCtrlFloat(sab, CTRL_3D_POS_Z, d.posZ);
        setCtrlFloat(sab, CTRL_3D_VEL_X, d.velX);
        setCtrlFloat(sab, CTRL_3D_VEL_Y, d.velY);
        setCtrlFloat(sab, CTRL_3D_VEL_Z, d.velZ);
        setCtrlFloat(sab, CTRL_3D_MIN_DIST, d.minDist);
        setCtrlFloat(sab, CTRL_3D_MAX_DIST, d.maxDist);
        setCtrl(sab, CTRL_3D_MODE, d.mode);
        setCtrl(sab, CTRL_3D_CONE_INNER, d.coneInner);
        setCtrl(sab, CTRL_3D_CONE_OUTER, d.coneOuter);
        setCtrlFloat(sab, CTRL_3D_CONE_ORI_X, d.coneOriX);
        setCtrlFloat(sab, CTRL_3D_CONE_ORI_Y, d.coneOriY);
        setCtrlFloat(sab, CTRL_3D_CONE_ORI_Z, d.coneOriZ);
        setCtrl(sab, CTRL_3D_CONE_OUTVOL, d.coneOutVol);
        setCtrl(sab, CTRL_3D_FLAGS, buffer.has3D ? 1 : 0);
    }

    private getMemory(): Uint8Array {
        return this.process.v86.mem8 || (this.process.v86.v86 && this.process.v86.v86.cpu.mem8);
    }

    reset(): void {
        this.stopNotificationPump();
        const destroyedBuffers = new Set<SoundBuffer>();
        for (const [ptr, obj] of this.objects) {
            if (obj.buffer && !destroyedBuffers.has(obj.buffer)) {
                destroyedBuffers.add(obj.buffer);
                this.destroySoundBuffer(obj.buffer);
            }
            if (obj.capture?.ptr) {
                this.process.memory.free(obj.capture.ptr);
                obj.capture.ptr = 0;
            }
            freeComObject(this.process.memory, ptr);
        }
        this.objects.clear();
        this.primaryBufferPtr = 0;
        this.speakerConfig = DEFAULT_SPEAKER_CONFIG;
        this.nextBufferId = DSOUND_AUDIO_ID_BASE;
    }

    recreateVTables(): void {
        if (this.process) {
            this.memory = this.getMemory();
            this.vtables = createVTablesFromDescriptor(this.process, dsoundModule);
            Logger.verbose(LogCategory.SYSTEM, `DirectSound: Recreated vtables after reset`);

            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.SYSTEM, `DirectSound: Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }

            this.startNotificationPump();
        }
    }
}
