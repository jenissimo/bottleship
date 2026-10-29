/**
 * DirectShow multimedia streaming (amstream.dll): CLSID_AMMultiMediaStream reading a file
 * into a DirectDraw video stream, with the default audio renderer for its sound.
 *
 * The application binds a sample to one of its own DirectDraw surfaces and calls
 * IStreamSample::Update, which returns once the next frame is in that surface at its
 * presentation time on the stream clock. A frame that is already late is dropped in
 * favour of the newest due one, as the decoder's quality control does. Decoding is
 * videoEngine's; one decoder session lives while the stream runs, so stopping silences
 * the audio and seeking restarts it in step with the picture.
 */

import { amstreamModule } from "../api/amstream.api";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { BaseComObject } from "../core/com/base-com-object";
import { allocateComObject } from "../core/com/com-memory";
import { InterfaceRegistry } from "../core/com/interface-registry";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { Logger, LogCategory } from "../core/logger";
import { isValidAddress } from "../core/memory/address-guard";
import { Mem } from "../core/memory/mem-accessor";
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { WAIT_BLOCKED_NO_SWITCH } from "../core/scheduler/types";
import { System } from "../core/system";
import { ThunkImplementation, ThunkResult, X86Context } from "../core/thunking/thunk-dispatcher";
import { TimeService } from "../runtime/time";
import { videoEngine } from "../../video/video-engine";
import { isPackableRgb, packBgraRows } from "./amstream-pixels";
import { DirectDrawSurfaceObject, type DirectDrawSurfaceState, isRenderSurface, type SurfaceFormat } from "./ddraw/com-objects";
import { DDSCAPS_OFFSCREENPLAIN, DDSCAPS_SYSTEMMEMORY, DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH } from "./ddraw/constants";
import { createDefaultPixelFormat, readSurfaceDescV1, writeSurfaceDescV1 } from "./ddraw/structs";
import { setAuthorityCpu, surfaceHasActiveWriteLease, unionSurfaceDirtyRegion } from "./ddraw/surface-sync";

export const CLSID_AMMultiMediaStream = "49c47ce5-9ba4-11d0-8212-00c04fc32c45";

const IID_IUnknown = "00000000-0000-0000-c000-000000000046";
const IID_IMultiMediaStream = "b502d1bc-9a57-11d0-8fde-00c04fd9189d";
const IID_IMediaStream = "b502d1bd-9a57-11d0-8fde-00c04fd9189d";
const IID_IStreamSample = "b502d1be-9a57-11d0-8fde-00c04fd9189d";
const IID_IAMMultiMediaStream = "bebe595c-9a6f-11d0-8fde-00c04fd9189d";
const IID_IDirectDrawMediaStream = "f4104fce-9a70-11d0-8fde-00c04fd9189d";
const IID_IDirectDrawStreamSample = "f4104fcf-9a70-11d0-8fde-00c04fd9189d";
const MSPID_PrimaryVideo = "a35ff56a-9fda-11d0-8fdf-00c04fd9189d";
const MSPID_PrimaryAudio = "a35ff56b-9fda-11d0-8fdf-00c04fd9189d";

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const HRESULT_FILE_NOT_FOUND = 0x80070002 | 0;
const VFW_E_UNSUPPORTED_STREAM = 0x8004022f | 0;
const MS_S_ENDOFSTREAM = 0x00040003;
const MS_E_PURPOSEID = 0x80040402 | 0;
const MS_E_NOSTREAM = 0x80040403 | 0;
const MS_E_INCOMPATIBLE = 0x80040405 | 0;
const MS_E_BUSY = 0x80040406 | 0;
const MS_E_NOTINIT = 0x80040407 | 0;
const MS_E_SOURCEALREADYDEFINED = 0x80040408 | 0;
const MS_E_INVALIDSTREAMTYPE = 0x80040409 | 0;
const MS_E_NOTRUNNING = 0x8004040a | 0;

const STREAMTYPE_READ = 0;
const STREAMSTATE_STOP = 0;
const STREAMSTATE_RUN = 1;
const MMSSF_HASCLOCK = 0x1;
const MMSSF_SUPPORTSEEK = 0x2;
/** AddMediaStream */
const AMMSF_ADDDEFAULTRENDERER = 0x1;
/** OpenFile */
const AMMSF_RENDERTYPEMASK = 0x3;
const AMMSF_RENDERALLSTREAMS = 0x1;
const AMMSF_RUN = 0x8;
/** IStreamSample::Update */
const SSUPDATE_ASYNC = 0x1;
const SSUPDATE_CONTINUOUS = 0x2;
const DDSFF_PROGRESSIVERENDER = 0x1;
const DDSURFACEDESC_SIZE = 108;
/** STREAM_TIME is in 100 ns units. */
const UNITS = 10_000_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

interface Rect { left: number; top: number; right: number; bottom: number }

abstract class StreamingObject extends BaseComObject {
    /** Guest address of each interface handed out so far, by vtable name. */
    readonly addresses = new Map<string, number>();
    abstract readonly primaryVtable: string;
    /** IID to vtable name, for every interface the object answers QueryInterface for. */
    abstract readonly interfaces: Readonly<Record<string, string>>;
    onDestroy: (() => void) | null = null;

    constructor() {
        super(IID_IUnknown, 0);
    }

    protected destroy(): void {
        this.onDestroy?.();
        this.onDestroy = null;
        this.addresses.clear();
    }
}

class MultiMediaStreamObject extends StreamingObject {
    readonly primaryVtable = "IAMMultiMediaStream";
    readonly interfaces = { [IID_IMultiMediaStream]: "IAMMultiMediaStream", [IID_IAMMultiMediaStream]: "IAMMultiMediaStream" };
    initialized = false;
    opening = false;
    /** Held: the multimedia stream owns its media streams. */
    video: DirectDrawStreamObject | null = null;
    audioRenderer = false;
    file: Uint8Array | null = null;
    width = 0;
    height = 0;
    fps = 0;
    frameCount = 0;
    hasAudio = false;
    running = false;
    /** Index of the frame the next Update delivers. */
    nextFrame = 0;
    endOfStream = false;
    /** Stream time (seconds) when the clock last started or stopped, and the host time it started. */
    pausedAt = 0;
    clockStartMs = 0;
    /** videoEngine handle while running; 0 otherwise. */
    session = 0;
    sessionAudioStarted = false;
    eosEvent = 0;
}

class DirectDrawStreamObject extends StreamingObject {
    readonly primaryVtable = "IDirectDrawMediaStream";
    readonly interfaces = { [IID_IMediaStream]: "IDirectDrawMediaStream", [IID_IDirectDrawMediaStream]: "IDirectDrawMediaStream" };
    /** Not held: cleared when the multimedia stream goes. */
    owner: MultiMediaStreamObject | null = null;
    /** Held guest IDirectDraw, or 0. */
    directDraw = 0;
    /** Set by SetFormat or by the first sample's surface. */
    format: SurfaceFormat | null = null;
}

class DirectDrawSampleObject extends StreamingObject {
    readonly primaryVtable = "IDirectDrawStreamSample";
    readonly interfaces = { [IID_IStreamSample]: "IDirectDrawStreamSample", [IID_IDirectDrawStreamSample]: "IDirectDrawStreamSample" };
    /** Held. */
    stream!: DirectDrawStreamObject;
    /** Held guest IDirectDrawSurface. */
    surface = 0;
    rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
    startTime = 0;
    endTime = 0;
    status = S_OK;
}

function validPointer(ptr: number, size: number, perms: "r" | "rw"): boolean {
    const mem = Mem.getView();
    return !!ptr && !!mem && ptr + size <= mem.length && isValidAddress(mem, ptr, size, perms);
}

function guidAt(address: number): string {
    const b = Mem.readBytes(address, 16);
    if (!b) return "";
    const hex = (i: number): string => b[i]!.toString(16).padStart(2, "0");
    return `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-` +
        `${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
}

function guidBytes(guid: string): Uint8Array {
    const hex = guid.replace(/-/g, "");
    const b = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const out = new Uint8Array(16);
    out.set([b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6)]);
    for (let i = 8; i < 16; i++) out[i] = b(i);
    return out;
}

function readWide(address: number, maxChars: number): string {
    let out = "";
    for (let i = 0; address && i < maxChars; i++) {
        const code = Mem.readUint16(address + i * 2);
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
}

/** Store a STREAM_TIME given in seconds. */
function writeStreamTime(ptr: number, seconds: number): boolean {
    if (!validPointer(ptr, 8, "rw")) return false;
    const units = Math.max(0, Math.round(seconds * UNITS));
    Mem.writeUint32(ptr, units % 0x1_0000_0000);
    Mem.writeUint32(ptr + 4, Math.floor(units / 0x1_0000_0000));
    return true;
}

function readRect(ptr: number): Rect | null {
    if (!validPointer(ptr, 16, "r")) return null;
    return {
        left: Mem.readInt32(ptr) ?? 0, top: Mem.readInt32(ptr + 4) ?? 0,
        right: Mem.readInt32(ptr + 8) ?? 0, bottom: Mem.readInt32(ptr + 12) ?? 0,
    };
}

function writeRect(ptr: number, r: Rect): void {
    Mem.writeUint32(ptr, r.left >>> 0);
    Mem.writeUint32(ptr + 4, r.top >>> 0);
    Mem.writeUint32(ptr + 8, r.right >>> 0);
    Mem.writeUint32(ptr + 12, r.bottom >>> 0);
}

function comAddRef(ptr: number): void {
    if (ptr) SystemResourceProvider.getInstance().getComObjectByAddress(ptr)?.addRef(ptr);
}

function comRelease(ptr: number): void {
    if (ptr) SystemResourceProvider.getInstance().getComObjectByAddress(ptr)?.release(ptr);
}

function surfaceState(ptr: number): DirectDrawSurfaceState | null {
    const obj = ptr ? SystemResourceProvider.getInstance().getComObjectByAddress(ptr) : null;
    return obj instanceof DirectDrawSurfaceObject ? obj.getState() : null;
}

export class Amstream implements IModule {
    name = "amstream";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;
    private readonly streams = new Set<MultiMediaStreamObject>();

    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(amstreamModule);
        this.vtables = createVTablesFromDescriptor(this.process, amstreamModule);
        for (const iface of amstreamModule.interfaces ?? []) this.registerUnknownExports(iface.name);
        this.registerMultiMediaStreamExports();
        this.registerMediaStreamExports();
        this.registerSampleExports();
    }

    reset(): void {
        for (const mms of this.streams) this.closeSession(mms);
        this.streams.clear();
    }

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, amstreamModule);
    }

    // ── objects and interfaces ──────────────────────────────────────────────────

    private object<T extends StreamingObject>(thisPtr: number | undefined, type: abstract new (...a: never[]) => T): T | null {
        if (!thisPtr) return null;
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr >>> 0);
        return obj instanceof type ? obj : null;
    }

    private addressOf(obj: StreamingObject, vtableName: string): number {
        const known = obj.addresses.get(vtableName);
        if (known) return known;
        const vtable = this.vtables[vtableName];
        const mem = Mem.getView();
        if (!vtable || !mem) return 0;
        const address = allocateComObject(this.process.memory, mem, vtable.address) >>> 0;
        SystemResourceProvider.getInstance().mapAddressToHandle(address, obj.handle);
        obj.addresses.set(vtableName, address);
        return address;
    }

    private queryInterface(obj: StreamingObject, iid: string, ppOut: number): number {
        if (!validPointer(ppOut, 4, "rw")) return E_POINTER;
        const vtableName = iid === IID_IUnknown ? obj.primaryVtable : obj.interfaces[iid];
        const address = vtableName ? this.addressOf(obj, vtableName) : 0;
        if (!address) {
            Mem.writeUint32(ppOut, 0);
            return E_NOINTERFACE;
        }
        Mem.writeUint32(ppOut, address);
        obj.addRef();
        return S_OK;
    }

    private registerUnknownExports(iface: string): void {
        const e = this.exports;
        e[`${iface}_QueryInterface`] = (_c, _m, a) => {
            if (!validPointer(a[1] >>> 0, 16, "r")) return E_POINTER;
            const obj = this.object(a[0], StreamingObject);
            if (!obj) {
                if (validPointer(a[2] >>> 0, 4, "rw")) Mem.writeUint32(a[2] >>> 0, 0);
                return E_NOINTERFACE;
            }
            return this.queryInterface(obj, guidAt(a[1] >>> 0), a[2] >>> 0);
        };
        e[`${iface}_AddRef`] = (_c, _m, a) => this.object(a[0], StreamingObject)?.addRef() ?? 0;
        e[`${iface}_Release`] = (_c, _m, a) => this.object(a[0], StreamingObject)?.release() ?? 0;
    }

    /** CoCreateInstance for CLSID_AMMultiMediaStream; null for any other class. */
    coCreateInstance(clsid: string, iid: string, ppOut: number): number | null {
        if (clsid !== CLSID_AMMultiMediaStream) return null;
        const mms = new MultiMediaStreamObject();
        this.streams.add(mms);
        mms.onDestroy = () => {
            this.closeSession(mms);
            if (mms.video) {
                mms.video.owner = null;
                mms.video.release();
                mms.video = null;
            }
            if (mms.eosEvent) SystemResourceProvider.getInstance().unregisterKernelObject(mms.eosEvent);
            mms.eosEvent = 0;
            this.streams.delete(mms);
        };
        const hr = this.queryInterface(mms, iid, ppOut);
        mms.release();
        return hr;
    }

    // ── the stream clock and decoder session ────────────────────────────────────

    private streamTime(mms: MultiMediaStreamObject): number {
        if (!mms.running) return mms.pausedAt;
        return mms.pausedAt + (TimeService.getInstance().nowMs() - mms.clockStartMs) / 1000;
    }

    private openSession(mms: MultiMediaStreamObject): void {
        if (mms.session || !mms.file || mms.endOfStream) return;
        try {
            mms.session = videoEngine.openLoaded(mms.file);
        } catch (e) {
            Logger.warn(LogCategory.COM, `[amstream] reopening the clip failed: ${e}`);
            mms.endOfStream = true;
            return;
        }
        if (mms.nextFrame > 0) videoEngine.gotoFrame(mms.session, mms.nextFrame);
        if (!mms.audioRenderer) videoEngine.disableBuiltinAudio(mms.session);
        mms.sessionAudioStarted = false;
    }

    private closeSession(mms: MultiMediaStreamObject): void {
        if (!mms.session) return;
        videoEngine.close(mms.session);
        mms.session = 0;
    }

    private setRunning(mms: MultiMediaStreamObject, run: boolean): void {
        if (run === mms.running) return;
        if (run) {
            mms.clockStartMs = TimeService.getInstance().nowMs();
            mms.running = true;
            this.openSession(mms);
        } else {
            mms.pausedAt = this.streamTime(mms);
            mms.running = false;
            this.closeSession(mms);
        }
    }

    private reachEnd(mms: MultiMediaStreamObject): number {
        mms.endOfStream = true;
        this.closeSession(mms);
        if (mms.eosEvent) System.getInstance().scheduler.setEvent(mms.eosEvent);
        return MS_S_ENDOFSTREAM;
    }

    /** Decode the frame due now into the sample's surface; returns its presentation time, or an HRESULT. */
    private deliverFrame(sample: DirectDrawSampleObject, mms: MultiMediaStreamObject): { hr: number; due: number } {
        const now = this.streamTime(mms);
        const frameSeconds = 1 / mms.fps;
        const isPast = (frame: number): boolean => mms.frameCount > 0 && frame >= mms.frameCount;
        let target = mms.nextFrame;
        while (!isPast(target + 1) && (target + 1) * frameSeconds <= now) target++;
        for (; mms.nextFrame < target; mms.nextFrame++) {
            if (!videoEngine.doFrame(mms.session)) return { hr: this.reachEnd(mms), due: 0 };
            videoEngine.nextFrame(mms.session);
        }
        if (isPast(mms.nextFrame) || !videoEngine.doFrame(mms.session)) return { hr: this.reachEnd(mms), due: 0 };
        if (mms.audioRenderer && !mms.sessionAudioStarted) {
            videoEngine.beginAudioPlayback(mms.session);
            mms.sessionAudioStarted = videoEngine.hasAudioPlaybackStarted(mms.session);
        }
        const hr = this.writeFrame(sample, mms);
        videoEngine.nextFrame(mms.session);
        const due = mms.nextFrame * frameSeconds;
        mms.nextFrame++;
        sample.startTime = due;
        sample.endTime = due + frameSeconds;
        return { hr, due };
    }

    private writeFrame(sample: DirectDrawSampleObject, mms: MultiMediaStreamObject): number {
        const state = surfaceState(sample.surface);
        const bgra = videoEngine.getFrameBgra(mms.session);
        if (!state || !bgra) return E_FAIL;
        // DirectShow's renderer waits for the application's Lock to end; it never writes under one.
        if (surfaceHasActiveWriteLease(state)) return MS_E_BUSY;
        const r = sample.rect;
        const width = Math.min(r.right - r.left, mms.width);
        const height = Math.min(r.bottom - r.top, mms.height);
        if (width <= 0 || height <= 0) return S_OK;
        const bytes = state.format.bpp >> 3;
        const offset = state.surfacePtr + r.top * state.pitch + r.left * bytes;
        const extent = (height - 1) * state.pitch + width * bytes;
        const mem = Mem.getView();
        if (!mem || !isValidAddress(mem, offset, extent, "rw")) return E_FAIL;
        packBgraRows(bgra, mms.width * 4, width, height, mem, offset, state.pitch, state.format);
        state.surfaceEverWritten = true;
        state.writeGeneration++;
        if (isRenderSurface(state)) {
            setAuthorityCpu(state);
            state.rgbaScratch = undefined;
            state.rgbaScratchVersion = undefined;
            unionSurfaceDirtyRegion(state, { left: r.left, top: r.top, right: r.left + width, bottom: r.top + height });
        }
        return S_OK;
    }

    /** Block the calling thread for `ms`, then resume it past an `argBytes` stdcall return with EAX = S_OK. */
    private blockFor(ctx: X86Context, ms: number, argBytes: number): number | ThunkResult {
        const sched = System.getInstance().scheduler;
        const returnAddr = Mem.readUint32(ctx.esp) ?? 0;
        const result = sched.sleepWithContext(Math.ceil(ms), returnAddr, ctx.esp + 4 + argBytes,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags });
        if (result === WAIT_BLOCKED_NO_SWITCH) return { value: S_OK, blockedNoSwitch: true, stackCleanup: argBytes };
        return S_OK;
    }

    // ── IAMMultiMediaStream ─────────────────────────────────────────────────────

    private registerMultiMediaStreamExports(): void {
        const e = this.exports;
        const mmsOf = (ptr: number | undefined) => this.object(ptr, MultiMediaStreamObject);

        e.IAMMultiMediaStream_GetInformation = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            if (!mms.initialized) return MS_E_NOTINIT;
            if (a[1] && validPointer(a[1] >>> 0, 4, "rw")) {
                Mem.writeUint32(a[1] >>> 0, mms.file ? MMSSF_HASCLOCK | MMSSF_SUPPORTSEEK : MMSSF_HASCLOCK);
            }
            if (a[2] && validPointer(a[2] >>> 0, 4, "rw")) Mem.writeUint32(a[2] >>> 0, STREAMTYPE_READ);
            return S_OK;
        };
        e.IAMMultiMediaStream_GetMediaStream = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            const pp = a[2] >>> 0;
            if (!mms || !validPointer(a[1] >>> 0, 16, "r") || !validPointer(pp, 4, "rw")) return E_POINTER;
            if (guidAt(a[1] >>> 0) !== MSPID_PrimaryVideo || !mms.video) {
                Mem.writeUint32(pp, 0);
                return MS_E_NOSTREAM;
            }
            return this.queryInterface(mms.video, IID_IMediaStream, pp);
        };
        e.IAMMultiMediaStream_EnumMediaStreams = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            const pp = a[2] >>> 0;
            if (!mms || !validPointer(pp, 4, "rw")) return E_POINTER;
            if ((a[1] | 0) !== 0 || !mms.video) {
                Mem.writeUint32(pp, 0);
                return S_FALSE;
            }
            return this.queryInterface(mms.video, IID_IMediaStream, pp);
        };
        e.IAMMultiMediaStream_GetState = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms || !validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            Mem.writeUint32(a[1] >>> 0, mms.running ? STREAMSTATE_RUN : STREAMSTATE_STOP);
            return S_OK;
        };
        e.IAMMultiMediaStream_SetState = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            const state = a[1] >>> 0;
            if (state !== STREAMSTATE_RUN && state !== STREAMSTATE_STOP) return E_INVALIDARG;
            if (!mms.initialized) return MS_E_NOTINIT;
            this.setRunning(mms, state === STREAMSTATE_RUN);
            return S_OK;
        };
        e.IAMMultiMediaStream_GetTime = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            return writeStreamTime(a[1] >>> 0, this.streamTime(mms)) ? S_OK : E_POINTER;
        };
        e.IAMMultiMediaStream_GetDuration = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            if (!mms.file) return MS_E_NOSTREAM;
            const known = mms.frameCount > 0 && mms.fps > 0;
            if (!writeStreamTime(a[1] >>> 0, known ? mms.frameCount / mms.fps : 0)) return E_POINTER;
            return known ? S_OK : S_FALSE;
        };
        e.IAMMultiMediaStream_Seek = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            if (!mms.file || mms.fps <= 0) return MS_E_NOSTREAM;
            const units = (a[2] | 0) * 0x1_0000_0000 + (a[1] >>> 0);
            const seconds = Math.max(0, units / UNITS);
            this.closeSession(mms);
            mms.nextFrame = Math.floor(seconds * mms.fps + 1e-6);
            mms.pausedAt = seconds;
            mms.clockStartMs = TimeService.getInstance().nowMs();
            mms.endOfStream = EmulatorConfig.getInstance().skipVideo;
            if (mms.eosEvent) System.getInstance().scheduler.resetEvent(mms.eosEvent);
            if (mms.running) this.openSession(mms);
            return S_OK;
        };
        e.IAMMultiMediaStream_GetEndOfStreamEventHandle = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms || !validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            if (!mms.eosEvent) mms.eosEvent = System.getInstance().scheduler.createEvent(true, mms.endOfStream);
            Mem.writeUint32(a[1] >>> 0, mms.eosEvent);
            return S_OK;
        };
        e.IAMMultiMediaStream_Initialize = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms) return E_POINTER;
            // Write and transform streams, and joining an application's own filter graph, are not provided.
            if ((a[1] >>> 0) !== STREAMTYPE_READ || a[3]) return E_NOTIMPL;
            mms.initialized = true;
            return S_OK;
        };
        e.IAMMultiMediaStream_GetFilterGraph = (_c, _m, a) => {
            if (validPointer(a[1] >>> 0, 4, "rw")) Mem.writeUint32(a[1] >>> 0, 0);
            return E_NOTIMPL;
        };
        e.IAMMultiMediaStream_GetFilter = (_c, _m, a) => {
            if (validPointer(a[1] >>> 0, 4, "rw")) Mem.writeUint32(a[1] >>> 0, 0);
            return E_NOTIMPL;
        };
        e.IAMMultiMediaStream_AddMediaStream = (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            const streamObject = a[1] >>> 0;
            const flags = a[3] >>> 0;
            const ppNew = a[4] >>> 0;
            if (!mms || !validPointer(a[2] >>> 0, 16, "r")) return E_POINTER;
            if (ppNew && !validPointer(ppNew, 4, "rw")) return E_POINTER;
            if (ppNew) Mem.writeUint32(ppNew, 0);
            mms.initialized = true;
            const purpose = guidAt(a[2] >>> 0);
            if (purpose === MSPID_PrimaryAudio) {
                // Audio samples into application buffers (IAudioMediaStream) are not provided.
                if (!(flags & AMMSF_ADDDEFAULTRENDERER)) return E_NOTIMPL;
                if (mms.audioRenderer) return MS_E_PURPOSEID;
                mms.audioRenderer = true;
                return S_OK;
            }
            if (purpose !== MSPID_PrimaryVideo) return MS_E_PURPOSEID;
            // A default video renderer would draw into a window of its own; not provided.
            if (flags & AMMSF_ADDDEFAULTRENDERER) return E_NOTIMPL;
            if (mms.video) return MS_E_PURPOSEID;
            const stream = new DirectDrawStreamObject();
            stream.owner = mms;
            stream.directDraw = streamObject;
            comAddRef(streamObject);
            stream.onDestroy = () => {
                comRelease(stream.directDraw);
                stream.directDraw = 0;
            };
            mms.video = stream;
            return ppNew ? this.queryInterface(stream, IID_IMediaStream, ppNew) : S_OK;
        };
        e.IAMMultiMediaStream_OpenFile = async (_c, _m, a) => {
            const mms = mmsOf(a[0]);
            if (!mms || !a[1]) return E_POINTER;
            if (mms.file || mms.opening) return MS_E_SOURCEALREADYDEFINED;
            const path = readWide(a[1] >>> 0, 260);
            const flags = a[2] >>> 0;
            mms.initialized = true;
            mms.opening = true;
            try {
                const bytes = await this.readFile(path);
                if (!this.streams.has(mms)) return E_FAIL;
                if (!bytes) return HRESULT_FILE_NOT_FOUND;
                let probe = 0;
                try {
                    await videoEngine.ensureLoaded();
                    if (!this.streams.has(mms)) return E_FAIL;
                    probe = videoEngine.openLoaded(bytes);
                } catch (err) {
                    Logger.warn(LogCategory.COM, `[amstream] OpenFile("${path}"): ${err}`);
                    return VFW_E_UNSUPPORTED_STREAM;
                }
                const info = videoEngine.getInfo(probe);
                videoEngine.close(probe);
                if (!info || info.width <= 0 || info.height <= 0 || info.fps <= 0) return VFW_E_UNSUPPORTED_STREAM;
                mms.file = bytes;
                mms.width = info.width;
                mms.height = info.height;
                mms.fps = info.fps;
                mms.frameCount = info.frameCount;
                mms.hasAudio = info.hasAudio;
                mms.nextFrame = 0;
                mms.pausedAt = 0;
                mms.endOfStream = EmulatorConfig.getInstance().skipVideo;
                if ((flags & AMMSF_RENDERTYPEMASK) === AMMSF_RENDERALLSTREAMS && info.hasAudio) mms.audioRenderer = true;
                Logger.log(LogCategory.COM,
                    `[amstream] OpenFile("${path}"): ${info.width}x${info.height} ${info.fps.toFixed(2)} fps, ` +
                    `${info.frameCount} frames, audio=${info.hasAudio ? (mms.audioRenderer ? "rendered" : "unused") : "none"}`);
                if (flags & AMMSF_RUN) this.setRunning(mms, true);
                return S_OK;
            } finally {
                mms.opening = false;
            }
        };
        e.IAMMultiMediaStream_OpenMoniker = () => E_NOTIMPL;
        e.IAMMultiMediaStream_Render = () => E_NOTIMPL;
    }

    private async readFile(path: string): Promise<Uint8Array | null> {
        const vfs = System.getInstance().fileSystem;
        const size = vfs.getFileSize(path);
        if (size <= 0 || size > MAX_FILE_BYTES) return null;
        const GENERIC_READ = 0x80000000;
        const OPEN_EXISTING = 3;
        const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
        return handle ? await vfs.read(handle, size) : null;
    }

    // ── IDirectDrawMediaStream ──────────────────────────────────────────────────

    /** The stream's format: what SetFormat or a sample fixed, else the display's. */
    private streamFormat(stream: DirectDrawStreamObject): SurfaceFormat {
        return stream.format ?? createDefaultPixelFormat(System.getInstance().ddrawContext?.display.bpp ?? 16);
    }

    private registerMediaStreamExports(): void {
        const e = this.exports;
        const streamOf = (ptr: number | undefined) => this.object(ptr, DirectDrawStreamObject);

        e.IDirectDrawMediaStream_GetMultiMediaStream = (_c, _m, a) => {
            const stream = streamOf(a[0]);
            const pp = a[1] >>> 0;
            if (!stream || !validPointer(pp, 4, "rw")) return E_POINTER;
            if (!stream.owner) {
                Mem.writeUint32(pp, 0);
                return E_FAIL;
            }
            return this.queryInterface(stream.owner, IID_IMultiMediaStream, pp);
        };
        e.IDirectDrawMediaStream_GetInformation = (_c, _m, a) => {
            if (!streamOf(a[0])) return E_POINTER;
            if (a[1]) {
                if (!validPointer(a[1] >>> 0, 16, "rw")) return E_POINTER;
                Mem.writeBytes(a[1] >>> 0, guidBytes(MSPID_PrimaryVideo));
            }
            if (a[2] && validPointer(a[2] >>> 0, 4, "rw")) Mem.writeUint32(a[2] >>> 0, STREAMTYPE_READ);
            return S_OK;
        };
        e.IDirectDrawMediaStream_SetSameFormat = () => E_NOTIMPL;
        // Samples on surfaces the stream allocates itself are not provided; CreateSample takes the application's.
        e.IDirectDrawMediaStream_AllocateSample = (_c, _m, a) => {
            if (validPointer(a[2] >>> 0, 4, "rw")) Mem.writeUint32(a[2] >>> 0, 0);
            return E_NOTIMPL;
        };
        e.IDirectDrawMediaStream_CreateSharedSample = (_c, _m, a) => {
            if (validPointer(a[3] >>> 0, 4, "rw")) Mem.writeUint32(a[3] >>> 0, 0);
            return E_NOTIMPL;
        };
        e.IDirectDrawMediaStream_SendEndOfStream = () => MS_E_INVALIDSTREAMTYPE;
        e.IDirectDrawMediaStream_GetFormat = (_c, mem, a) => {
            const stream = streamOf(a[0]);
            if (!stream) return E_POINTER;
            const mms = stream.owner;
            if (!mms?.file) return MS_E_NOSTREAM;
            const desc = {
                size: DDSURFACEDESC_SIZE, flags: DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT,
                width: mms.width, height: mms.height, pitch: 0, backBufferCount: 0,
                caps: DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN, surfacePtr: 0, pixelFormat: this.streamFormat(stream),
            };
            for (const ptr of [a[1] >>> 0, a[3] >>> 0]) {
                if (!ptr) continue;
                if (!validPointer(ptr, DDSURFACEDESC_SIZE, "rw")) return E_POINTER;
                if ((Mem.readUint32(ptr) ?? 0) < DDSURFACEDESC_SIZE) return E_INVALIDARG;
                writeSurfaceDescV1(mem, ptr, desc);
            }
            if (a[2] && validPointer(a[2] >>> 0, 4, "rw")) Mem.writeUint32(a[2] >>> 0, 0);
            if (a[4] && validPointer(a[4] >>> 0, 4, "rw")) Mem.writeUint32(a[4] >>> 0, DDSFF_PROGRESSIVERENDER);
            return S_OK;
        };
        e.IDirectDrawMediaStream_SetFormat = (_c, mem, a) => {
            const stream = streamOf(a[0]);
            if (!stream || !validPointer(a[1] >>> 0, DDSURFACEDESC_SIZE, "r")) return E_POINTER;
            const desc = readSurfaceDescV1(mem, a[1] >>> 0);
            if (!desc) return E_INVALIDARG;
            const mms = stream.owner;
            if (mms?.file && (desc.flags & DDSD_WIDTH) && (desc.flags & DDSD_HEIGHT)
                && (desc.width !== mms.width || desc.height !== mms.height)) return MS_E_INCOMPATIBLE;
            if ((desc.flags & DDSD_PIXELFORMAT) && desc.pixelFormat) {
                if (!isPackableRgb(desc.pixelFormat)) return MS_E_INCOMPATIBLE;
                stream.format = desc.pixelFormat;
            }
            return S_OK;
        };
        e.IDirectDrawMediaStream_GetDirectDraw = (_c, _m, a) => {
            const stream = streamOf(a[0]);
            if (!stream || !validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            comAddRef(stream.directDraw);
            Mem.writeUint32(a[1] >>> 0, stream.directDraw);
            return S_OK;
        };
        e.IDirectDrawMediaStream_SetDirectDraw = (_c, _m, a) => {
            const stream = streamOf(a[0]);
            if (!stream) return E_POINTER;
            comAddRef(a[1] >>> 0);
            comRelease(stream.directDraw);
            stream.directDraw = a[1] >>> 0;
            return S_OK;
        };
        e.IDirectDrawMediaStream_CreateSample = (_c, _m, a) => {
            const stream = streamOf(a[0]);
            const surface = a[1] >>> 0;
            const ppSample = a[4] >>> 0;
            if (!stream || !validPointer(ppSample, 4, "rw")) return E_POINTER;
            Mem.writeUint32(ppSample, 0);
            // A sample on a surface of the stream's own making is not provided.
            if (!surface) return E_NOTIMPL;
            const state = surfaceState(surface);
            if (!state) return E_INVALIDARG;
            if (!isPackableRgb(state.format)) return MS_E_INCOMPATIBLE;
            const rect = a[2] ? readRect(a[2] >>> 0) : { left: 0, top: 0, right: state.width, bottom: state.height };
            if (!rect) return E_POINTER;
            if (rect.left < 0 || rect.top < 0 || rect.right > state.width || rect.bottom > state.height
                || rect.right <= rect.left || rect.bottom <= rect.top) return E_INVALIDARG;
            stream.format ??= state.format;
            const sample = new DirectDrawSampleObject();
            sample.stream = stream;
            stream.addRef();
            sample.surface = surface;
            comAddRef(surface);
            sample.rect = rect;
            sample.onDestroy = () => {
                comRelease(sample.surface);
                sample.stream.release();
            };
            Logger.log(LogCategory.COM,
                `[amstream] CreateSample: surface 0x${surface.toString(16)} ${state.width}x${state.height}x${state.format.bpp} ` +
                `rect (${rect.left},${rect.top})-(${rect.right},${rect.bottom})`);
            const hr = this.queryInterface(sample, IID_IDirectDrawStreamSample, ppSample);
            sample.release();
            return hr;
        };
        e.IDirectDrawMediaStream_GetTimePerFrame = (_c, _m, a) => {
            const stream = streamOf(a[0]);
            if (!stream) return E_POINTER;
            const fps = stream.owner?.fps ?? 0;
            if (fps <= 0) return MS_E_NOSTREAM;
            return writeStreamTime(a[1] >>> 0, 1 / fps) ? S_OK : E_POINTER;
        };
    }

    // ── IDirectDrawStreamSample ─────────────────────────────────────────────────

    private registerSampleExports(): void {
        const e = this.exports;
        const sampleOf = (ptr: number | undefined) => this.object(ptr, DirectDrawSampleObject);

        e.IDirectDrawStreamSample_GetMediaStream = (_c, _m, a) => {
            const sample = sampleOf(a[0]);
            if (!sample || !validPointer(a[1] >>> 0, 4, "rw")) return E_POINTER;
            return this.queryInterface(sample.stream, IID_IMediaStream, a[1] >>> 0);
        };
        e.IDirectDrawStreamSample_GetSampleTimes = (_c, _m, a) => {
            const sample = sampleOf(a[0]);
            if (!sample) return E_POINTER;
            if (a[1] && !writeStreamTime(a[1] >>> 0, sample.startTime)) return E_POINTER;
            if (a[2] && !writeStreamTime(a[2] >>> 0, sample.endTime)) return E_POINTER;
            const mms = sample.stream.owner;
            if (a[3] && !writeStreamTime(a[3] >>> 0, mms ? this.streamTime(mms) : 0)) return E_POINTER;
            return S_OK;
        };
        e.IDirectDrawStreamSample_SetSampleTimes = () => E_NOTIMPL;
        e.IDirectDrawStreamSample_Update = (ctx, _m, a) => {
            const sample = sampleOf(a[0]);
            if (!sample) return E_POINTER;
            const flags = a[1] >>> 0;
            // Async/continuous completion requires a pending sample and clocked event delivery.
            // Refuse it until implemented, rather than signaling completion before the frame is due.
            if (a[3] || (flags & (SSUPDATE_ASYNC | SSUPDATE_CONTINUOUS))) return E_NOTIMPL;
            const mms = sample.stream.owner;
            if (!mms) return E_FAIL;
            if (!mms.running) return MS_E_NOTRUNNING;
            if (mms.endOfStream || !mms.session) {
                sample.status = MS_S_ENDOFSTREAM;
            } else {
                const { hr, due } = this.deliverFrame(sample, mms);
                sample.status = hr;
                const waitMs = (due - this.streamTime(mms)) * 1000;
                if (hr === S_OK && !(flags & SSUPDATE_ASYNC) && waitMs >= 1) return this.blockFor(ctx, waitMs, 20);
            }
            return sample.status;
        };
        e.IDirectDrawStreamSample_CompletionStatus = (_c, _m, a) => sampleOf(a[0])?.status ?? E_POINTER;
        e.IDirectDrawStreamSample_GetSurface = (_c, _m, a) => {
            const sample = sampleOf(a[0]);
            if (!sample) return E_POINTER;
            if ((a[1] && !validPointer(a[1] >>> 0, 4, "rw"))
                || (a[2] && !validPointer(a[2] >>> 0, 16, "rw"))) return E_POINTER;
            if (a[1]) {
                comAddRef(sample.surface);
                Mem.writeUint32(a[1] >>> 0, sample.surface);
            }
            if (a[2]) {
                writeRect(a[2] >>> 0, sample.rect);
            }
            return S_OK;
        };
        e.IDirectDrawStreamSample_SetRect = (_c, _m, a) => {
            const sample = sampleOf(a[0]);
            const rect = sample ? readRect(a[1] >>> 0) : null;
            const state = sample ? surfaceState(sample.surface) : null;
            if (!sample || !rect || !state) return E_POINTER;
            if (rect.left < 0 || rect.top < 0 || rect.right > state.width || rect.bottom > state.height
                || rect.right <= rect.left || rect.bottom <= rect.top) return E_INVALIDARG;
            sample.rect = rect;
            return S_OK;
        };
    }
}
