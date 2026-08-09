/**
 * DirectMusic HLE — the loader/performance/segment COM objects, with silent playback.
 *
 * DX7/DX8 engines build their music system out of CoCreateInstance(CLSID_DirectMusicLoader)
 * + CLSID_DirectMusicPerformance and treat a failure as fatal for the whole subsystem
 * (ZenGin puts up "Failed to create loader object!" and keeps re-raising it). The objects
 * therefore have to be real: every Load* hands back an object the caller can call methods
 * on and Release, because a NULL behind an S_OK is worse than the failure it replaces.
 *
 * What is NOT emulated is synthesis — no DLS instrument rendering, no segment sequencing.
 * Playback verbs succeed and produce silence, and the engine's state machine (which only
 * observes HRESULTs and IsPlaying) runs exactly as it would with music.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { dmusicModule } from "../api/dmusic.api";
import { InterfaceRegistry } from "../core/com/interface-registry";
import { BaseComObject, ComObjectFactory } from "../core/com/base-com-object";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { allocateComObject, freeComObject } from "../core/com/com-memory";

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const DMUS_E_NOT_FOUND = 0x88781799 | 0;
const DMUS_E_LOADER_FAILEDOPEN = 0x88781180 | 0;

export const IID_IDirectMusicLoader8 = "19e7c08c-0a44-4e6a-a116-595a7cd5de8c";
export const IID_IDirectMusicPerformance8 = "679c4137-c62e-4147-b2b4-9d569acb254c";
export const IID_IDirectMusicSegment8 = "c6784488-41a3-418f-aa15-b35093ba42d4";
export const IID_IDirectMusicSegmentState8 = "a50e4730-0ae4-48a7-9839-bc04bfe07772";
export const IID_IDirectMusicAudioPath = "c87631f5-23be-4986-8836-05832fcc48f9";
/** DirectMusic never minted a separate *8 IID for the composer or the audio path. */
export const IID_IDirectMusicComposer8 = "d2ac28bf-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusic8 = "2d3629f7-813d-4939-8508-f05c6b75fd97";
export const IID_IDirectMusicPort = "08f2d8c9-37c2-11d2-b9f9-0000f875ac12";

/** Older interface generations a QueryInterface may ask for; same vtable prefix. */
const IID_IDirectMusicLoader = "2ffaaca2-5dca-11d2-afa6-00aa0024d8b6";
const IID_IDirectMusicPerformance = "07d43d03-6523-11d2-871d-00600893b1bd";
const IID_IDirectMusicSegment = "f96029a2-4282-11d2-8717-00600893b1bd";
const IID_IDirectMusicSegmentState = "a3afdcc7-d3ee-11d1-bc8d-00a0c922e6eb";
const IID_IDirectMusic = "6536115a-7b2d-11d2-ba18-0000f875ac12";

/** DMUS_PORTCAPS / DMUS_SYNTHSTATS8 (dmusicc.h) — full size, dwSize-tagged. */
const DMUS_PORTCAPS_SIZE = 308;
const DMUS_SYNTHSTATS8_SIZE = 36;
const DMUS_PC_OUTPUTCLASS = 1;
const DMUS_PC_SOFTWARESYNTH = 0x00000004;
const DMUS_PC_DIRECTSOUND = 0x00000080;
const DMUS_PORT_USER_MODE_SYNTH = 1;
const DMUS_PC_SYSTEMMEMORY = 0x7fffffff;

function bytesToGuid(b: Uint8Array): string {
    const d1 = ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0).toString(16).padStart(8, "0");
    const d2 = ((b[4] | (b[5] << 8)) >>> 0).toString(16).padStart(4, "0");
    const d3 = ((b[6] | (b[7] << 8)) >>> 0).toString(16).padStart(4, "0");
    const rest = Array.from(b.slice(8, 16)).map(x => x.toString(16).padStart(2, "0")).join("");
    return `${d1}-${d2}-${d3}-${rest.slice(0, 4)}-${rest.slice(4)}`;
}

/**
 * A DX7 caller asking for the un-suffixed interface gets the same object: the *8 vtables
 * are strict extensions, so every slot the older interface knows about lines up.
 */
abstract class DMusicObject extends BaseComObject {
    /** The guest block `emit` handed out; the object owns it until its last Release. */
    guestAddress = 0;
    protected abstract legacyIid(): string;
    protected queryAdditionalInterfaces(riid: string): string | null {
        return riid === this.legacyIid() ? riid : null;
    }
    protected destroy(): void {
        if (this.guestAddress && comMemory) freeComObject(comMemory, this.guestAddress);
        this.guestAddress = 0;
    }
}

/** The system-object pool `emit` allocates from, so destroy() can give the block back. */
let comMemory: { freeSystemBlock(addr: number, size: number): void } | null = null;

class DirectMusicLoaderObject extends DMusicObject {
    constructor(vtableAddress: number) { super(IID_IDirectMusicLoader8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicLoader; }
}

class DirectMusicPerformanceObject extends DMusicObject {
    /** GetSegmentState/GetDefaultAudioPath are polled per frame — hand out one object, not one per call. */
    segmentState: DirectMusicSegmentStateObject | null = null;
    defaultAudioPath: DirectMusicAudioPathObject | null = null;
    constructor(vtableAddress: number) { super(IID_IDirectMusicPerformance8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicPerformance; }
}

class DirectMusicSegmentObject extends DMusicObject {
    /** Guest-visible length in MUSIC_TIME; a zero-length segment reads as "already over". */
    lengthMusicTime = 0x1000;
    repeats = 0;
    playState: DirectMusicSegmentStateObject | null = null;
    constructor(vtableAddress: number) { super(IID_IDirectMusicSegment8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicSegment; }
}

class DirectMusicSegmentStateObject extends DMusicObject {
    constructor(vtableAddress: number) { super(IID_IDirectMusicSegmentState8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicSegmentState; }
}

class DirectMusicAudioPathObject extends DMusicObject {
    constructor(vtableAddress: number) { super(IID_IDirectMusicAudioPath, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicAudioPath; }
}

class DirectMusicComposerObject extends DMusicObject {
    constructor(vtableAddress: number) { super(IID_IDirectMusicComposer8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicComposer8; }
}

class DirectMusicObject extends DMusicObject {
    constructor(vtableAddress: number) { super(IID_IDirectMusic8, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusic; }
}

class DirectMusicPortObject extends DMusicObject {
    channelGroups = 1;
    constructor(vtableAddress: number) { super(IID_IDirectMusicPort, vtableAddress); }
    protected legacyIid(): string { return IID_IDirectMusicPort; }
}

export class DMusic implements IModule {
    name = "dmusic";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;
        comMemory = process.memory;

        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dmusicModule);
        this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);

        ComObjectFactory.register(IID_IDirectMusicLoader8, DirectMusicLoaderObject);
        ComObjectFactory.register(IID_IDirectMusicPerformance8, DirectMusicPerformanceObject);
        ComObjectFactory.register(IID_IDirectMusicSegment8, DirectMusicSegmentObject);
        ComObjectFactory.register(IID_IDirectMusicSegmentState8, DirectMusicSegmentStateObject);
        ComObjectFactory.register(IID_IDirectMusicAudioPath, DirectMusicAudioPathObject);
        ComObjectFactory.register(IID_IDirectMusicComposer8, DirectMusicComposerObject);
        ComObjectFactory.register(IID_IDirectMusic8, DirectMusicObject);
        ComObjectFactory.register(IID_IDirectMusicPort, DirectMusicPortObject);

        // Every generated vtable starts with IUnknown, and the guest calls through those
        // slots like any other: an unregistered QueryInterface/AddRef/Release is not a
        // no-op, it is a call into a stub with no handler.
        for (const iface of dmusicModule.interfaces ?? []) this.registerUnknownExports(iface.name);

        this.registerLoaderExports();
        this.registerPerformanceExports();
        this.registerSegmentExports();
        this.registerSegmentStateExports();
        this.registerAudioPathExports();
        this.registerComposerExports();
        this.registerDirectMusicExports();
        this.registerPortExports();
    }

    reset(): void { /* vtables rebuilt by recreateVTables */ }

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);
    }

    /** Create an object of `iid` and store its guest address at `ppOut`. */
    private emit(iid: string, vtableName: string, ppOut: number): number {
        if (!ppOut) return E_POINTER;
        const vtable = this.vtables[vtableName];
        if (!vtable) {
            Logger.warn(LogCategory.COM, `[DMusic] no vtable for ${vtableName}`);
            return E_NOINTERFACE;
        }
        const mem = Mem.getView();
        if (!mem) return E_POINTER;
        const obj = ComObjectFactory.create(iid, vtable.address);
        if (!obj) return E_NOINTERFACE;
        const address = allocateComObject(this.process.memory, mem, vtable.address);
        (obj as DMusicObject).guestAddress = address >>> 0;
        SystemResourceProvider.getInstance().mapAddressToHandle(address, obj.handle);
        if (!Mem.writeUint32(ppOut, address >>> 0)) return E_POINTER;
        return S_OK;
    }

    /**
     * Hand out a per-owner singleton. These getters are polled every frame, and a fresh
     * object per call leaks a guest allocation plus a resource-provider handle each time.
     * `assign` re-arms the owner's cache when a new object had to be minted.
     */
    private emitOnce<T extends DMusicObject>(
        cached: T | null,
        iid: string,
        vtableName: string,
        ppOut: number,
        assign: (obj: T | null) => void,
    ): number {
        if (!ppOut) return E_POINTER;
        if (cached && cached.refCount > 0 && cached.guestAddress) {
            cached.addRef(cached.guestAddress);
            return Mem.writeUint32(ppOut, cached.guestAddress >>> 0) ? S_OK : E_POINTER;
        }
        const hr = this.emit(iid, vtableName, ppOut);
        assign(hr === S_OK ? this.object<T>(Mem.readUint32(ppOut) ?? 0) : null);
        return hr;
    }

    /** Public entry for ole32's CoCreateInstance CLSID routing. */
    createLoader(ppOut: number): number {
        return this.emit(IID_IDirectMusicLoader8, "IDirectMusicLoader8", ppOut);
    }

    createPerformance(ppOut: number): number {
        return this.emit(IID_IDirectMusicPerformance8, "IDirectMusicPerformance8", ppOut);
    }

    createComposer(ppOut: number): number {
        return this.emit(IID_IDirectMusicComposer8, "IDirectMusicComposer8", ppOut);
    }

    private registerUnknownExports(iface: string): void {
        const e = this.exports;
        e[`${iface}_QueryInterface`] = (_c, mem, a) => {
            const obj = this.object(a[0] >>> 0);
            if (!obj) { Mem.writeUint32(a[2] >>> 0, 0); return E_NOINTERFACE; }
            const bytes = Mem.readBytes(a[1] >>> 0, 16);
            if (!bytes) return E_POINTER;
            return obj.queryInterface(bytesToGuid(bytes), a[2] >>> 0, mem);
        };
        e[`${iface}_AddRef`] = (_c, _m, a) => {
            const obj = this.object(a[0] >>> 0);
            return obj ? obj.addRef(a[0] >>> 0) : 0;
        };
        e[`${iface}_Release`] = (_c, _m, a) => {
            const obj = this.object(a[0] >>> 0);
            return obj ? obj.release(a[0] >>> 0) : 0;
        };
    }

    private object<T extends BaseComObject>(thisPtr: number): T | null {
        return (SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr) as T) ?? null;
    }

    private registerLoaderExports(): void {
        const e = this.exports;
        e["IDirectMusicLoader8_GetObject"] = (_c, _m, a) => {
            if (a[3]) Mem.writeUint32(a[3] >>> 0, 0);
            return DMUS_E_LOADER_FAILEDOPEN;   // see LoadObjectFromFile
        };
        e["IDirectMusicLoader8_SetObject"] = () => S_OK;
        e["IDirectMusicLoader8_SetSearchDirectory"] = () => S_OK;
        e["IDirectMusicLoader8_ScanDirectory"] = () => S_FALSE;   // "no more objects"
        e["IDirectMusicLoader8_CacheObject"] = () => S_OK;
        e["IDirectMusicLoader8_ReleaseObject"] = () => S_OK;
        e["IDirectMusicLoader8_ClearCache"] = () => S_OK;
        e["IDirectMusicLoader8_EnableCache"] = () => S_OK;
        e["IDirectMusicLoader8_EnumObject"] = () => S_FALSE;      // end of enumeration
        e["IDirectMusicLoader8_CollectGarbage"] = () => S_OK;
        e["IDirectMusicLoader8_ReleaseObjectByUnknown"] = () => S_OK;

        // HRESULT LoadObjectFromFile(REFGUID rguidClassID, REFIID iidInterfaceID,
        //                            WCHAR *pwzFilePath, void **ppObject)
        // We do not parse DirectMusic content (.sgt/.sty/.dls), so there is no segment to
        // hand back. Reporting failure is the honest answer AND the safe one: a caller that
        // gets S_OK goes on to ask the segment for its style
        // (IDirectMusicSegment::GetParam) and dereferences whatever comes back — ZenGin's
        // menu music does exactly that, without checking the HRESULT. Failing here is a
        // path engines DO handle, because a missing music file is ordinary.
        e["IDirectMusicLoader8_LoadObjectFromFile"] = (_c, mem, a) => {
            const ppObject = a[4] >>> 0;
            const path = this.readWide(mem, a[3] >>> 0);
            if (ppObject) Mem.writeUint32(ppObject, 0);
            Logger.log(LogCategory.COM, `[DMusic] LoadObjectFromFile("${path}") -> DMUS_E_LOADER_FAILEDOPEN (no content parser)`);
            return DMUS_E_LOADER_FAILEDOPEN;
        };
    }

    private registerPerformanceExports(): void {
        const e = this.exports;
        const ok = () => S_OK;
        for (const name of [
            "Stop", "SetPrepareTime", "SetBumperLength", "SendPMsg", "FreePMsg",
            "SetGraph", "SetNotificationHandle", "AddNotificationType", "RemoveNotificationType",
            "AddPort", "RemovePort", "AssignPChannelBlock", "AssignPChannel", "Invalidate",
            "SetParam", "SetGlobalParam", "AdjustTime", "CloseDown", "StopEx",
            "SetDefaultAudioPath",
        ]) {
            e[`IDirectMusicPerformance8_${name}`] = ok;
        }
        // DownloadInstrument(pInst, dwPChannel, ppDownInst, pNoteRanges, dwNumNoteRanges,
        //                    ppPort, pdwGroup, pdwMChannel) — four out-params and no synth
        // behind them, so it fails instead of leaving the caller a stack pointer to call.
        e["IDirectMusicPerformance8_DownloadInstrument"] = (_c, _m, a) => {
            for (const i of [3, 6, 7, 8]) if (a[i]) Mem.writeUint32(a[i] >>> 0, 0);
            return DMUS_E_NOT_FOUND;
        };
        // HRESULT Init(IDirectMusic **ppDirectMusic, IDirectSound *pDirectSound, HWND hWnd)
        // ppDirectMusic is an OUT parameter, and callers use what it returns without a
        // NULL check — ZenGin goes straight on to pDirectMusic->CreatePort(). Returning
        // S_OK without filling it is the shape that crashes them.
        e["IDirectMusicPerformance8_Init"] = (_c, _m, a) => {
            const pp = a[1] >>> 0;
            return pp ? this.emit(IID_IDirectMusic8, "IDirectMusic8", pp) : S_OK;
        };
        // InitAudio(ppDirectMusic, ppDirectSound, hWnd, dwDefaultPathType, ...): same
        // out-parameter, and ppDirectSound is optional and left alone.
        e["IDirectMusicPerformance8_InitAudio"] = (_c, _m, a) => {
            const pp = a[1] >>> 0;
            return pp ? this.emit(IID_IDirectMusic8, "IDirectMusic8", pp) : S_OK;
        };

        // Queries that hand back a value must write it: the caller reads the out-param
        // regardless of the HRESULT it got.
        e["IDirectMusicPerformance8_GetPrepareTime"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 1000); return S_OK; };
        e["IDirectMusicPerformance8_GetBumperLength"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 50); return S_OK; };
        e["IDirectMusicPerformance8_GetGraph"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicPerformance8_GetNotificationPMsg"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_FALSE; };
        e["IDirectMusicPerformance8_AllocPMsg"] = (_c, _m, a) => { Mem.writeUint32(a[2] >>> 0, 0); return E_POINTER; };
        e["IDirectMusicPerformance8_GetParam"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicPerformance8_GetParamEx"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicPerformance8_GetGlobalParam"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicPerformance8_PChannelInfo"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicPerformance8_ClonePMsg"] = () => E_POINTER;
        e["IDirectMusicPerformance8_MIDIToMusic"] = () => S_OK;
        e["IDirectMusicPerformance8_MusicToMIDI"] = () => S_OK;
        e["IDirectMusicPerformance8_TimeToRhythm"] = () => S_OK;
        e["IDirectMusicPerformance8_RhythmToTime"] = () => S_OK;

        // Clocks: a monotonic answer is what a caller schedules against. Zero would make
        // every "has this segment finished" comparison true at once.
        e["IDirectMusicPerformance8_GetTime"] = (_c, _m, a) => {
            const rt = this.referenceTime();
            if (a[1]) { Mem.writeUint32(a[1] >>> 0, rt.lo); Mem.writeUint32((a[1] >>> 0) + 4, rt.hi); }
            if (a[2]) Mem.writeUint32(a[2] >>> 0, rt.musicTime);
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetLatencyTime"] = (_c, _m, a) => {
            const rt = this.referenceTime();
            if (a[1]) { Mem.writeUint32(a[1] >>> 0, rt.lo); Mem.writeUint32((a[1] >>> 0) + 4, rt.hi); }
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetQueueTime"] = e["IDirectMusicPerformance8_GetLatencyTime"];
        e["IDirectMusicPerformance8_GetResolvedTime"] = (_c, _m, a) => {
            if (a[3]) { Mem.writeUint32(a[3] >>> 0, a[1] >>> 0); Mem.writeUint32((a[3] >>> 0) + 4, a[2] >>> 0); }
            return S_OK;
        };
        e["IDirectMusicPerformance8_MusicToReferenceTime"] = (_c, _m, a) => {
            if (a[2]) { Mem.writeUint32(a[2] >>> 0, (a[1] >>> 0) * 1000); Mem.writeUint32((a[2] >>> 0) + 4, 0); }
            return S_OK;
        };
        e["IDirectMusicPerformance8_ReferenceToMusicTime"] = (_c, _m, a) => {
            if (a[3]) Mem.writeUint32(a[3] >>> 0, Math.floor((a[1] >>> 0) / 1000));
            return S_OK;
        };

        e["IDirectMusicPerformance8_PlaySegment"] = (_c, _m, a) => this.startSegment(a[0] >>> 0, a[5] >>> 0);
        e["IDirectMusicPerformance8_PlaySegmentEx"] = (_c, _m, a) => this.startSegment(a[0] >>> 0, a[7] >>> 0);
        e["IDirectMusicPerformance8_GetSegmentState"] = (_c, _m, a) => this.startSegment(a[0] >>> 0, a[1] >>> 0);
        // Nothing is sounding, so nothing is playing. Reporting otherwise leaves an
        // engine waiting for an end-of-segment that never arrives.
        e["IDirectMusicPerformance8_IsPlaying"] = () => S_FALSE;

        e["IDirectMusicPerformance8_CreateAudioPath"] = (_c, _m, a) =>
            this.emit(IID_IDirectMusicAudioPath, "IDirectMusicAudioPath", a[3] >>> 0);
        e["IDirectMusicPerformance8_CreateStandardAudioPath"] = (_c, _m, a) =>
            this.emit(IID_IDirectMusicAudioPath, "IDirectMusicAudioPath", a[4] >>> 0);
        e["IDirectMusicPerformance8_GetDefaultAudioPath"] = (_c, _m, a) => {
            const perf = this.object<DirectMusicPerformanceObject>(a[0] >>> 0);
            if (!perf) return E_POINTER;
            return this.emitOnce(perf.defaultAudioPath, IID_IDirectMusicAudioPath, "IDirectMusicAudioPath",
                a[1] >>> 0, o => { perf.defaultAudioPath = o; });
        };
    }

    /** The performance's one segment state, shared by PlaySegment* and GetSegmentState. */
    private startSegment(thisPtr: number, ppSegmentState: number): number {
        if (!ppSegmentState) return S_OK;   // caller does not want the state back
        const perf = this.object<DirectMusicPerformanceObject>(thisPtr);
        if (!perf) return E_POINTER;
        return this.emitOnce(perf.segmentState, IID_IDirectMusicSegmentState8, "IDirectMusicSegmentState8",
            ppSegmentState, o => { perf.segmentState = o; });
    }

    private registerSegmentExports(): void {
        const e = this.exports;
        e["IDirectMusicSegment8_GetLength"] = (_c, _m, a) => {
            const seg = this.object<DirectMusicSegmentObject>(a[0] >>> 0);
            Mem.writeUint32(a[1] >>> 0, seg?.lengthMusicTime ?? 0x1000);
            return S_OK;
        };
        e["IDirectMusicSegment8_SetLength"] = (_c, _m, a) => {
            const seg = this.object<DirectMusicSegmentObject>(a[0] >>> 0);
            if (seg) seg.lengthMusicTime = a[1] >>> 0;
            return S_OK;
        };
        e["IDirectMusicSegment8_GetRepeats"] = (_c, _m, a) => {
            const seg = this.object<DirectMusicSegmentObject>(a[0] >>> 0);
            Mem.writeUint32(a[1] >>> 0, seg?.repeats ?? 0);
            return S_OK;
        };
        e["IDirectMusicSegment8_SetRepeats"] = (_c, _m, a) => {
            const seg = this.object<DirectMusicSegmentObject>(a[0] >>> 0);
            if (seg) seg.repeats = a[1] >>> 0;
            return S_OK;
        };
        e["IDirectMusicSegment8_GetDefaultResolution"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        for (const name of [
            "SetDefaultResolution", "InsertTrack", "RemoveTrack", "SetGraph",
            "AddNotificationType", "RemoveNotificationType", "SetParam", "SetStartPoint",
            "SetLoopPoints", "SetPChannelsUsed", "SetTrackConfig", "Download", "Unload",
        ]) {
            e[`IDirectMusicSegment8_${name}`] = () => S_OK;
        }
        e["IDirectMusicSegment8_GetTrack"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicSegment8_GetTrackGroup"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicSegment8_GetParam"] = () => DMUS_E_NOT_FOUND;
        e["IDirectMusicSegment8_GetGraph"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicSegment8_GetAudioPathConfig"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicSegment8_GetStartPoint"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        e["IDirectMusicSegment8_GetLoopPoints"] = (_c, _m, a) => {
            Mem.writeUint32(a[1] >>> 0, 0);
            Mem.writeUint32(a[2] >>> 0, 0);
            return S_OK;
        };
        e["IDirectMusicSegment8_InitPlay"] = (_c, _m, a) => {
            const seg = this.object<DirectMusicSegmentObject>(a[0] >>> 0);
            if (!seg) return E_POINTER;
            return this.emitOnce(seg.playState, IID_IDirectMusicSegmentState8, "IDirectMusicSegmentState8",
                a[1] >>> 0, o => { seg.playState = o; });
        };
        e["IDirectMusicSegment8_Clone"] = (_c, _m, a) =>
            this.emit(IID_IDirectMusicSegment8, "IDirectMusicSegment8", a[3] >>> 0);
    }

    private registerSegmentStateExports(): void {
        const e = this.exports;
        e["IDirectMusicSegmentState8_GetRepeats"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        e["IDirectMusicSegmentState8_GetSegment"] = (_c, _m, a) =>
            this.emit(IID_IDirectMusicSegment8, "IDirectMusicSegment8", a[1] >>> 0);
        e["IDirectMusicSegmentState8_GetStartTime"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        e["IDirectMusicSegmentState8_GetSeek"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        e["IDirectMusicSegmentState8_GetStartPoint"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return S_OK; };
        e["IDirectMusicSegmentState8_SetTrackConfig"] = () => S_OK;
        e["IDirectMusicSegmentState8_GetObjectInPath"] = (_c, _m, a) => { Mem.writeUint32(a[7] >>> 0, 0); return DMUS_E_NOT_FOUND; };
    }

    private registerAudioPathExports(): void {
        const e = this.exports;
        // The caller QIs the returned object (usually for IDirectSoundBuffer to set volume);
        // failing is honest — there is no buffer behind a silent path.
        e["IDirectMusicAudioPath_GetObjectInPath"] = (_c, _m, a) => { Mem.writeUint32(a[7] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicAudioPath_Activate"] = () => S_OK;
        e["IDirectMusicAudioPath_SetVolume"] = () => S_OK;
        e["IDirectMusicAudioPath_ConvertPChannel"] = (_c, _m, a) => { Mem.writeUint32(a[2] >>> 0, a[1] >>> 0); return S_OK; };
    }

    private registerComposerExports(): void {
        const e = this.exports;
        // Composition needs styles and chord maps we never loaded, so every Compose*
        // reports "nothing to compose from" rather than an empty segment the caller would
        // then play and wait to finish.
        e["IDirectMusicComposer8_ComposeSegmentFromTemplate"] = (_c, _m, a) => { Mem.writeUint32(a[5] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicComposer8_ComposeSegmentFromShape"] = (_c, _m, a) => { Mem.writeUint32(a[8] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicComposer8_ComposeTransition"] = (_c, _m, a) => { Mem.writeUint32(a[7] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        // (pPerformance, pToSeg, wCommand, dwFlags, pChordMap, ppTransSeg, ppToSegState, ppTransSegState)
        e["IDirectMusicComposer8_AutoTransition"] = (_c, _m, a) => {
            if (a[6]) Mem.writeUint32(a[6] >>> 0, 0);
            if (a[7]) Mem.writeUint32(a[7] >>> 0, 0);
            if (a[8]) Mem.writeUint32(a[8] >>> 0, 0);
            return DMUS_E_NOT_FOUND;
        };
        e["IDirectMusicComposer8_ComposeTemplateFromShape"] = (_c, _m, a) => { Mem.writeUint32(a[6] >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicComposer8_ChangeChordMap"] = () => S_OK;
    }

    private registerDirectMusicExports(): void {
        const e = this.exports;
        // One synth port exists as far as the guest can tell; the caller then creates it
        // and hands it to the performance. EnumPort's caps struct is bigger than anything
        // we can honestly fill, so enumeration reports "none" and CreatePort is the path.
        e["IDirectMusic8_EnumPort"] = () => S_FALSE;
        e["IDirectMusic8_CreateMusicBuffer"] = (_c, _m, a) => { Mem.writeUint32(a[2] >>> 0, 0); return E_NOINTERFACE; };
        e["IDirectMusic8_CreatePort"] = (_c, _m, a) => this.emit(IID_IDirectMusicPort, "IDirectMusicPort", a[3] >>> 0);
        e["IDirectMusic8_EnumMasterClock"] = () => S_FALSE;
        e["IDirectMusic8_GetMasterClock"] = (_c, _m, a) => {
            if (a[1]) Mem.writeBytes(a[1] >>> 0, new Uint8Array(16));   // GUID_NULL
            if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
            return S_OK;
        };
        e["IDirectMusic8_SetMasterClock"] = () => S_OK;
        e["IDirectMusic8_Activate"] = () => S_OK;
        e["IDirectMusic8_GetDefaultPort"] = (_c, _m, a) => {
            if (a[1]) Mem.writeBytes(a[1] >>> 0, new Uint8Array(16));
            return S_OK;
        };
        e["IDirectMusic8_SetDirectSound"] = () => S_OK;
        e["IDirectMusic8_SetExternalMasterClock"] = () => S_OK;
    }

    private registerPortExports(): void {
        const e = this.exports;
        for (const name of [
            "PlayBuffer", "SetReadNotificationHandle", "Read", "UnloadInstrument",
            "Compact", "SetNumChannelGroups", "Activate", "SetChannelPriority",
            "SetDirectSound",
        ]) {
            e[`IDirectMusicPort_${name}`] = () => S_OK;
        }
        e["IDirectMusicPort_DownloadInstrument"] = (_c, _m, a) => { Mem.writeUint32(a[2] >>> 0, 0); return E_NOINTERFACE; };
        e["IDirectMusicPort_GetLatencyClock"] = (_c, _m, a) => { Mem.writeUint32(a[1] >>> 0, 0); return E_NOINTERFACE; };
        // Both structs are dwSize-tagged and the caller reads them straight back; an
        // untouched buffer behind S_OK is the caller's uninitialised stack.
        e["IDirectMusicPort_GetRunningStats"] = (_c, _m, a) =>
            this.writeSizedStruct(a[1] >>> 0, DMUS_SYNTHSTATS8_SIZE, (v, size) => {
                if (size >= 32) v.setUint32(24, DMUS_PC_SYSTEMMEMORY, true);   // dwFreeMemory
            });
        e["IDirectMusicPort_GetCaps"] = (_c, _m, a) => {
            const port = this.object<DirectMusicPortObject>(a[0] >>> 0);
            const groups = port?.channelGroups ?? 1;
            return this.writeSizedStruct(a[1] >>> 0, DMUS_PORTCAPS_SIZE, (v, size) => {
                v.setUint32(4, DMUS_PC_SOFTWARESYNTH | DMUS_PC_DIRECTSOUND, true);
                if (size < 52) return;
                v.setUint32(24, DMUS_PC_OUTPUTCLASS, true);
                v.setUint32(28, DMUS_PORT_USER_MODE_SYNTH, true);
                v.setUint32(32, DMUS_PC_SYSTEMMEMORY, true);
                v.setUint32(36, groups, true);
                v.setUint32(40, 32, true);   // dwMaxVoices
                v.setUint32(44, 2, true);    // dwMaxAudioChannels
            });
        };
        e["IDirectMusicPort_DeviceIoControl"] = () => S_OK;
        e["IDirectMusicPort_GetNumChannelGroups"] = (_c, _m, a) => {
            const port = this.object<DirectMusicPortObject>(a[0] >>> 0);
            Mem.writeUint32(a[1] >>> 0, port?.channelGroups ?? 1);
            return S_OK;
        };
        e["IDirectMusicPort_GetChannelPriority"] = (_c, _m, a) => { Mem.writeUint32(a[3] >>> 0, 0); return S_OK; };
        e["IDirectMusicPort_GetFormat"] = (_c, _m, a) => {
            if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
            if (a[3]) Mem.writeUint32(a[3] >>> 0, 0);
            return S_OK;
        };
    }

    /**
     * Fill a dwSize-tagged DirectMusic struct. The caller declares which version it passed
     * in dwSize; anything outside what we know how to fill is clamped, and the size we
     * actually wrote goes back so the caller's own bounds match the bytes.
     */
    private writeSizedStruct(ptr: number, knownSize: number, fill: (v: DataView, size: number) => void): number {
        if (!ptr) return E_POINTER;
        const declared = Mem.readUint32(ptr) ?? 0;
        const size = declared >= 8 && declared <= knownSize ? declared : knownSize;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        view.setUint32(0, size, true);
        fill(view, size);
        return Mem.writeBytes(ptr, buf) ? S_OK : E_POINTER;
    }

    /** REFERENCE_TIME (100ns units) and its MUSIC_TIME projection from the guest clock. */
    private referenceTime(): { lo: number; hi: number; musicTime: number } {
        const ms = performance.now();
        const units = Math.floor(ms * 10_000);
        return {
            lo: units >>> 0,
            hi: Math.floor(units / 0x100000000) >>> 0,
            musicTime: Math.floor(ms) >>> 0,
        };
    }

    private readWide(mem: Uint8Array, addr: number): string {
        if (!addr) return "";
        let out = "";
        for (let p = addr; p + 1 < mem.length; p += 2) {
            const ch = mem[p] | (mem[p + 1] << 8);
            if (ch === 0) break;
            out += String.fromCharCode(ch);
        }
        return out;
    }
}
