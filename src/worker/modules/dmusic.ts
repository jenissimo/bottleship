/**
 * DirectMusic HLE: the loader, performance, composer and port COM objects, with the
 * loadable objects (segment, style, band, DLS collection) behind them.
 *
 * Content is parsed by @bottleship/formats/dmusic and played by the performance and DLS
 * synthesizer in core/audio/directmusic; this file is the COM surface over those. The
 * synthesizer's output goes where a DirectMusic port's does: into a DirectSound buffer.
 *
 * A loadable object reads itself from the IStream its loader hands IPersistStream::Load,
 * and resolves what it refers to (a segment's style, an instrument's collection) through
 * the IDirectMusicLoader that stream answers IDirectMusicGetLoader with. Both may be the
 * application's own code, so Load is a guest routine, re-entered for each nested object.
 */

import { type Band, parseBand } from "@bottleship/formats/dmusic/band";
import { type DlsCollection, parseDls } from "@bottleship/formats/dmusic/dls";
import {
    DMUS_OBJ_CATEGORY, DMUS_OBJ_CLASS, DMUS_OBJ_FILENAME, DMUS_OBJ_FULLPATH, DMUS_OBJ_LOADED, DMUS_OBJ_MEMORY, DMUS_OBJ_NAME, DMUS_OBJ_OBJECT,
    DMUS_OBJ_VERSION, type ObjectReference, parseIdentity,
} from "@bottleship/formats/dmusic/reference";
import { riffChunks } from "@bottleship/formats/dmusic/riff";
import { parseSegment } from "@bottleship/formats/dmusic/segment";
import { parseStyle, ticksPerMeasure } from "@bottleship/formats/dmusic/style";
import { dmusicModule } from "../api/dmusic.api";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { buildSegment, loadBand } from "../core/audio/directmusic/build";
import { isStandardMidiFile, smfToSegment } from "../core/audio/directmusic/smf";
import { decodeWave, isRiffWave, type WaveData } from "../core/audio/directmusic/wave";
import {
    DMUS_SEGF_SECONDARY, type LoadedBand, PerfSegment, type PerfSegmentState, Performance,
} from "../core/audio/directmusic/performance";
import { DlsSynth } from "../core/audio/directmusic/synth";
import { gmBankAvailable, loadGmBank, onGmBank } from "../core/audio/gm-bank";
import { allocateComObject } from "../core/com/com-memory";
import { InterfaceRegistry } from "../core/com/interface-registry";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { TimerKind } from "../core/scheduler/types";
import { setTimerHandler } from "../core/scheduler/timer-wheel";
import { System } from "../core/system";
import { type GuestCall, type GuestRoutine, runGuestRoutine } from "../core/thunking/guest-routine";
import { ThunkImplementation, type X86Context } from "../core/thunking/thunk-dispatcher";
import { TimeService } from "../runtime/time";
import {
    AudioPathObject, BandObject, CLSID_DirectMusic, CLSID_DirectMusicBand, CLSID_DirectMusicCollection,
    CLSID_DirectMusicComposer, CLSID_DirectMusicLoader, CLSID_DirectMusicPerformance, CLSID_DirectMusicSegment,
    CLSID_DirectMusicStyle, CLSID_DirectMusicSynth, CollectionObject, ComposerObject, DirectMusicObject, DMusicObject,
    IID_IDirectMusicCollection, IID_IDirectMusicGetLoader, IID_IDirectMusicStyle, IID_IUnknown, LoadableObject,
    LoaderObject, type MadeSource, type ObjectSource, PerformanceObject, PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
} from "./dmusic-objects";
import { createSinkBuffer, DirectSoundSink, sinkBufferBytes, soundReference, writeWaveFormat } from "./dmusic-sink";
import { registerDMusicParticipant } from "./dmusic-savestate";
import { savestatesEnabled } from "../savestate/participant";
import { sha256HexSync } from "../savestate/sha256";

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
const DMUS_S_PARTIALLOAD = 0x08781091;
const DMUS_E_GET_UNSUPPORTED = 0x88781122 | 0;
const DMUS_E_SET_UNSUPPORTED = 0x88781123 | 0;
const DMUS_E_NOT_FOUND = 0x88781161 | 0;
const DMUS_E_NOT_INIT = 0x88781162 | 0;
const DMUS_E_TRACK_NOT_FOUND = 0x88781166 | 0;
const DMUS_E_LOADER_FAILEDOPEN = 0x88781182 | 0;
const DMUS_E_LOADER_FORMATNOTSUPPORTED = 0x88781183 | 0;
const DMUS_E_LOADER_OBJECTNOTFOUND = 0x88781185 | 0;

const GUID_NULL = "00000000-0000-0000-0000-000000000000";
const GUID_NOTIFICATION_SEGMENT = "d2ac2899-b39b-11d1-8704-00600893b1bd";
const GUID_CommandParam = "d2ac289d-b39b-11d1-8704-00600893b1bd";
const GUID_Download = "d2ac28a7-b39b-11d1-8704-00600893b1bd";
const GUID_Unload = "d2ac28a8-b39b-11d1-8704-00600893b1bd";
const GUID_PerfMasterTempo = "d2ac28b0-b39b-11d1-8704-00600893b1bd";
const GUID_PerfMasterVolume = "d2ac28b1-b39b-11d1-8704-00600893b1bd";
const GUID_DefaultGMCollection = "f17e8673-c3b4-11d1-870b-00600893b1bd";
const GUID_DirectMusicAllTypes = "d2ac2893-b39b-11d1-8704-00600893b1bd";
const CLSID_DirectMusicBandTrack = "d2ac2894-b39b-11d1-8704-00600893b1bd";

/** DMUS_PORTCAPS (dmusicc.h): 52 bytes of fields, then a 128-WCHAR description. */
const DMUS_PORTCAPS_SIZE = 308;
const DMUS_PC_DLS = 0x00000001;
const DMUS_PC_SOFTWARESYNTH = 0x00000004;
const DMUS_PC_DIRECTSOUND = 0x00000080;
const DMUS_PC_SHAREABLE = 0x00000100;
const DMUS_PC_OUTPUTCLASS = 1;
const DMUS_PORT_USER_MODE_SYNTH = 1;
const DMUS_PC_SYSTEMMEMORY = 0x7fffffff;
const SYNTH_DESCRIPTION = "Microsoft Synthesizer";
const DMUS_SYNTHSTATS_SIZE = 32;

const DMUS_PORTPARAMS_VOICES = 0x01;
const DMUS_PORTPARAMS_CHANNELGROUPS = 0x02;
const DMUS_PORTPARAMS_AUDIOCHANNELS = 0x04;
const DMUS_PORTPARAMS_SAMPLERATE = 0x08;

/** DMUS_OBJECTDESC field offsets (dmusici.h). */
const DESC = { size: 0x350, validData: 4, guidObject: 8, guidClass: 0x18, version: 0x30, name: 0x38, category: 0xb8, fileName: 0x138, memLength: 0x340, memData: 0x348 } as const;
const WAVE_CACHE_ENTRIES = 64;
const DMUS_APATH_DYNAMIC_3D = 6;
const DMUS_APATH_DYNAMIC_MONO = 7;
const DMUS_APATH_DYNAMIC_STEREO = 8;
const DMUS_PATH_BUFFER = 0x6000;
const DSBCAPS_CTRL3D = 0x10;
const DSBCAPS_CTRLFREQUENCY = 0x20;
const DSBCAPS_CTRLPAN = 0x40;
const DSBCAPS_CTRLVOLUME = 0x80;
const DSBCAPS_GLOBALFOCUS = 0x8000;
const DSBCAPS_GETCURRENTPOSITION2 = 0x10000;
const NO_CONTEXT = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0 } as X86Context;
const DESC_NAME_CHARS = 64;
const DESC_FILENAME_CHARS = 260;

/** DMUS_NOTIFICATION_PMSG: the common PMSG part, then the notification's own fields. */
const NOTIFICATION_PMSG = {
    size: 88, mtTime: 16, flags: 20, type: 40, punkUser: 52, guid: 56, option: 72, field1: 76, field2: 80,
} as const;
const DMUS_PMSGT_NOTIFICATION = 7;
const DMUS_PMSGF_MUSICTIME = 2;
/** How long an uncollected notification is kept (the default rtMinimum). */
const NOTIFICATION_LIFETIME_MS = 2000;

const SYNTH_PUMP_MS = 10;
/** Where Windows keeps the default GM collection a band falls back to. */
const DEFAULT_COLLECTION_PATHS = ["C:\\WINDOWS\\SYSTEM32\\DRIVERS\\GM.DLS", "C:\\WINDOWS\\SYSTEM\\GM.DLS"];
/** The most a loadable object reads from its stream. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

const FIXED_STYLE = -2;

type FoundReference = (ref: ObjectReference) => DMusicObject | null;

interface LoadPlan {
    styles: ObjectReference[];
    collections: ObjectReference[];
    build(found: FoundReference): boolean;
}

function waveKey(bytes: Uint8Array): string {
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193);
        h2 = Math.imul(h2 ^ bytes[i]!, 0x85ebca6b) ^ (h2 >>> 13);
    }
    return `${bytes.length}:${h1 >>> 0}:${h2 >>> 0}`;
}

function validPointer(ptr: number, size: number, perms: "r" | "w" | "rw"): boolean {
    const mem = Mem.getView();
    return !!ptr && !!mem && ptr + size <= mem.length && isValidAddress(mem, ptr, size, perms === "w" ? "rw" : perms);
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
    const out = new Uint8Array(16);
    if (hex.length !== 32) return out;
    const b = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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

function writeWide(address: number, value: string, maxChars: number): void {
    const text = value.slice(0, maxChars - 1);
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) {
        bytes[i * 2] = text.charCodeAt(i) & 0xff;
        bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    Mem.writeBytes(address, bytes);
}

export class DMusic implements IModule {
    name = "dmusic";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;
    private readonly ports = new Set<PortObject>();
    private readonly pathOutputs = new Set<AudioPathObject>();
    private readonly performances = new Set<PerformanceObject>();
    private readonly loading = new Set<LoadableObject>();
    private pumpTimer: number | null = null;
    private collectionObjects = new WeakMap<DlsCollection, CollectionObject>();

    constructor() {
        setTimerHandler(TimerKind.DMUSIC_SYNTH, () => this.pump());
    }
    private mixLeft = new Float32Array(0);
    private mixRight = new Float32Array(0);
    /** Guest blocks AllocPMsg and GetNotificationPMsg handed out, with what FreePMsg owes each. */
    private readonly messages = new Map<number, SegmentStateObject | null>();

    initialize(process: Process): void {
        this.process = process;
        if (savestatesEnabled()) this.registerSavestate();
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dmusicModule);
        this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);

        // Every generated vtable starts with IUnknown, and the guest calls through those
        // slots like any other: an unregistered QueryInterface/AddRef/Release is not a
        // no-op, it is a call into a stub with no handler.
        for (const iface of dmusicModule.interfaces ?? []) this.registerUnknownExports(iface.name);

        this.registerLoaderExports();
        this.registerObjectExports();
        this.registerPerformanceExports();
        this.registerSegmentExports();
        this.registerTrackExports();
        this.registerSegmentStateExports();
        this.registerStyleExports();
        this.registerBandExports();
        this.registerCollectionExports();
        this.registerAudioPathExports();
        this.registerComposerExports();
        this.registerDirectMusicExports();
        this.registerPortExports();
    }

    reset(): void {
        this.stopPump();
        for (const perf of this.performances) this.closePerformance(perf);
        for (const port of this.ports) {
            this.activatePort(port, false);
            this.releasePortOutput(port);
        }
        for (const [ptr, state] of this.messages) {
            state?.release();
            this.process.memory.free(ptr);
        }
        this.ports.clear();
        this.performances.clear();
        this.loading.clear();
        this.messages.clear();
    }

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);
    }

    // ── objects and interfaces ──────────────────────────────────────────────────

    private object<T extends DMusicObject>(thisPtr: number | undefined): T | null {
        if (!thisPtr) return null;
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr >>> 0);
        return obj instanceof DMusicObject ? obj as T : null;
    }

    /** The guest address of `obj` as `vtableName`, publishing that interface on first use. */
    private addressOf(obj: DMusicObject, vtableName: string): number {
        const known = obj.addresses.get(vtableName);
        if (known) return known;
        const vtable = this.vtables[vtableName];
        const mem = Mem.getView();
        if (!vtable || !mem) {
            Logger.warn(LogCategory.COM, `[DMusic] no vtable for ${vtableName}`);
            return 0;
        }
        const address = allocateComObject(this.process.memory, mem, vtable.address) >>> 0;
        SystemResourceProvider.getInstance().mapAddressToHandle(address, obj.handle);
        obj.addresses.set(vtableName, address);
        return address;
    }

    /** Store a newly created object's primary interface at `ppOut`; the caller owns its one reference. */
    private publish(obj: DMusicObject, ppOut: number): number {
        if (!validPointer(ppOut, 4, "w")) { obj.release(); return E_POINTER; }
        const address = this.addressOf(obj, obj.primaryVtable);
        if (!address || !Mem.writeUint32(ppOut, address)) {
            obj.release();
            return address ? E_POINTER : E_FAIL;
        }
        return S_OK;
    }

    private queryInterface(obj: DMusicObject, iid: string, ppOut: number): number {
        if (!validPointer(ppOut, 4, "w")) return E_POINTER;
        const vtableName = iid === IID_IUnknown ? obj.primaryVtable : obj.interfaces[iid];
        const address = vtableName ? this.addressOf(obj, vtableName) : 0;
        if (!address) {
            Mem.writeUint32(ppOut, 0);
            return E_NOINTERFACE;
        }
        if (!Mem.writeUint32(ppOut, address)) return E_POINTER;
        obj.addRef();
        return S_OK;
    }

    private registerUnknownExports(iface: string): void {
        const e = this.exports;
        e[`${iface}_QueryInterface`] = (_c, _m, a) => {
            if (!validPointer(a[1] >>> 0, 16, "r")) return E_POINTER;
            const obj = this.object(a[0]);
            if (!obj) {
                if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
                return E_NOINTERFACE;
            }
            return this.queryInterface(obj, guidAt(a[1] >>> 0), a[2] >>> 0);
        };
        e[`${iface}_AddRef`] = (_c, _m, a) => this.object(a[0])?.addRef() ?? 0;
        e[`${iface}_Release`] = (_c, _m, a) => this.object(a[0])?.release() ?? 0;
    }

    /**
     * CoCreateInstance for the DirectMusic classes. Returns null for a CLSID that is not
     * ours, so ole32 goes on to its other providers.
     */
    coCreateInstance(clsid: string, iid: string, ppOut: number): number | null {
        let obj: DMusicObject;
        switch (clsid) {
            case CLSID_DirectMusicLoader:
            case "d2ac2891-b39b-11d1-8704-00600893b1bd":
                obj = this.createLoader(); break;
            case CLSID_DirectMusicPerformance: {
                const perf = new PerformanceObject();
                this.performances.add(perf);
                this.wirePerformance(perf);
                obj = perf;
                break;
            }
            case CLSID_DirectMusicComposer: obj = new ComposerObject(); break;
            case CLSID_DirectMusicSegment: obj = new SegmentObject(); break;
            case CLSID_DirectMusicStyle: obj = new StyleObject(); break;
            case CLSID_DirectMusicBand: obj = new BandObject(); break;
            case CLSID_DirectMusicCollection: obj = new CollectionObject(); break;
            case CLSID_DirectMusic: obj = this.createDirectMusic(); break;
            default: return null;
        }
        const hr = this.queryInterface(obj, iid, ppOut);
        // QueryInterface took the caller's reference; the creation reference is ours to drop.
        obj.release();
        if (hr !== S_OK) Logger.warn(LogCategory.COM, `[DMusic] CoCreateInstance ${clsid}: no interface ${iid}`);
        return hr;
    }

    // ── guest calls ─────────────────────────────────────────────────────────────

    /** A call through slot `slot` of the guest COM object at `ptr`. */
    private vcall(ptr: number, slot: number, args: number[], tag: string): GuestCall {
        const vtable = Mem.readUint32(ptr >>> 0) ?? 0;
        const fn = vtable ? (Mem.readUint32(vtable + slot * 4) ?? 0) : 0;
        return { fn, args: [ptr >>> 0, ...args], tag };
    }

    /**
     * Read one RIFF file from the IStream at `stream`, from its current position. The
     * stream may refuse a short read, so the header is read first for the exact length.
     */
    private *readStream(stream: number): Generator<GuestCall, Uint8Array | null, number> {
        const memory = this.process.memory;
        const head = memory.alloc(16, "HEAP", "rw");
        if (!head) return null;
        let body = 0;
        try {
            Mem.writeUint32(head + 12, 0);
            let hr = yield this.vcall(stream, 3, [head, 12, head + 12], "IStream::Read");
            const tag = Mem.readBytes(head, 12);
            if ((hr | 0) < 0 || Mem.readUint32(head + 12) !== 12 || !tag
                || String.fromCharCode(tag[0]!, tag[1]!, tag[2]!, tag[3]!) !== "RIFF") return null;
            const header = tag.slice();
            const size = Mem.readUint32(head + 4) ?? 0;
            if (size < 4 || size > MAX_OBJECT_BYTES) return null;
            const rest = size - 4;
            const out = new Uint8Array(12 + rest);
            out.set(header);
            if (rest > 0) {
                body = memory.alloc(rest, "HEAP", "rw");
                if (!body) return null;
                Mem.writeUint32(head + 12, 0);
                hr = yield this.vcall(stream, 3, [body, rest, head + 12], "IStream::Read");
                const data = (hr | 0) < 0 || Mem.readUint32(head + 12) !== rest ? null : Mem.readBytes(body, rest);
                if (!data) return null;
                out.set(data, 12);
            }
            return out;
        } finally {
            memory.free(head);
            if (body) memory.free(body);
        }
    }

    /**
     * Resolve `refs` through the loader behind `stream`. Each distinct object is asked for
     * once; the result is our own object for it, or null when the loader has none. The
     * owner retains each distinct object before another guest call can re-enter us.
     */
    private *resolveReferences(
        stream: number, refs: ObjectReference[], iid: string, owner: LoadableObject,
    ): Generator<GuestCall, Map<ObjectReference, DMusicObject | null>, number> {
        const resolved = new Map<ObjectReference, DMusicObject | null>();
        if (refs.length === 0) return resolved;
        const memory = this.process.memory;
        const scratch = memory.alloc(DESC.size + 16 + 8, "HEAP", "rw");
        if (!scratch) return resolved;
        const iidPtr = scratch + DESC.size;
        const out = iidPtr + 16;
        let getLoader = 0;
        let loader = 0;
        try {
            Mem.writeBytes(iidPtr, guidBytes(IID_IDirectMusicGetLoader));
            Mem.writeUint32(out, 0);
            let hr = yield this.vcall(stream, 0, [iidPtr, out], "IStream::QueryInterface(IDirectMusicGetLoader)");
            getLoader = (hr | 0) < 0 ? 0 : (Mem.readUint32(out) ?? 0);
            if (!getLoader) return resolved;
            Mem.writeUint32(out, 0);
            hr = yield this.vcall(getLoader, 3, [out], "IDirectMusicGetLoader::GetLoader");
            loader = (hr | 0) < 0 ? 0 : (Mem.readUint32(out) ?? 0);
            if (!loader) return resolved;

            const byKey = new Map<string, DMusicObject | null>();
            for (const ref of refs) {
                const key = `${ref.objectId}|${ref.fileName.toLowerCase()}|${ref.name}`;
                if (byKey.has(key)) {
                    resolved.set(ref, byKey.get(key) ?? null);
                    continue;
                }
                this.writeDescriptor(scratch, ref);
                Mem.writeBytes(iidPtr, guidBytes(iid));
                Mem.writeUint32(out, 0);
                hr = yield this.vcall(loader, 3, [scratch, iidPtr, out], `IDirectMusicLoader::GetObject(${ref.fileName || ref.name})`);
                const ptr = (hr | 0) < 0 ? 0 : (Mem.readUint32(out) ?? 0);
                let obj = ptr ? this.object(ptr) : null;
                if (ptr && (!obj || !obj.interfaces[iid] || this.referenceWouldCycle(owner, obj))) {
                    yield this.vcall(ptr, 2, [], "IDirectMusicObject::Release(rejected reference)");
                    obj = null;
                }
                if (!obj) Logger.warn(LogCategory.COM, `[DMusic] reference to "${ref.fileName || ref.name}" not resolved (hr=0x${(hr >>> 0).toString(16)})`);
                // GetObject returned a reference. The caller keeps one per object, however
                // many of its references name that object.
                if (obj) {
                    if (owner.references.includes(obj)) obj.release();
                    else owner.references.push(obj);
                }
                byKey.set(key, obj);
                resolved.set(ref, obj);
            }
            return resolved;
        } finally {
            if (loader) yield this.vcall(loader, 2, [], "IDirectMusicLoader::Release");
            if (getLoader) yield this.vcall(getLoader, 2, [], "IDirectMusicGetLoader::Release");
            memory.free(scratch);
        }
    }

    /** A DMUS_OBJECTDESC for a reference, at `address`. */
    private writeDescriptor(address: number, ref: ObjectReference): void {
        Mem.writeBytes(address, new Uint8Array(DESC.size));
        Mem.writeUint32(address, DESC.size);
        Mem.writeUint32(address + DESC.validData, ref.validData);
        if (ref.validData & DMUS_OBJ_OBJECT) Mem.writeBytes(address + DESC.guidObject, guidBytes(ref.objectId));
        if (ref.validData & DMUS_OBJ_CLASS) Mem.writeBytes(address + DESC.guidClass, guidBytes(ref.classId));
        if (ref.validData & DMUS_OBJ_VERSION) {
            Mem.writeUint32(address + DESC.version, ref.versionMS);
            Mem.writeUint32(address + DESC.version + 4, ref.versionLS);
        }
        if (ref.validData & DMUS_OBJ_NAME) writeWide(address + DESC.name, ref.name, DESC_NAME_CHARS);
        if (ref.validData & DMUS_OBJ_CATEGORY) writeWide(address + DESC.category, ref.category, DESC_NAME_CHARS);
        if (ref.validData & DMUS_OBJ_FILENAME) writeWide(address + DESC.fileName, ref.fileName, DESC_FILENAME_CHARS);
    }

    // ── loading ─────────────────────────────────────────────────────────────────

    /** IPersistStream::Load for every loadable class. */
    private referenceWouldCycle(owner: LoadableObject, target: DMusicObject): boolean {
        const pending = [target], seen = new Set<DMusicObject>();
        while (pending.length) {
            const obj = pending.pop()!;
            if (obj === owner) return true;
            if (seen.has(obj)) continue;
            seen.add(obj);
            if (obj instanceof LoadableObject) pending.push(...obj.references);
        }
        return false;
    }

    private *load(obj: LoadableObject, stream: number): GuestRoutine {
        if (this.loading.has(obj)) return E_FAIL;
        this.loading.add(obj);
        obj.addRef();
        try {
            return yield* this.loadContents(obj, stream);
        } finally {
            this.loading.delete(obj);
            if (obj.refCount > 0) obj.release();
        }
    }

    private holdReferences(obj: LoadableObject): void {
        if (!obj.onDestroy) {
            obj.onDestroy = () => {
                for (const target of obj.references.splice(0)) target.release();
                obj.resolved = [];
            };
        }
    }

    private *loadContents(obj: LoadableObject, stream: number): GuestRoutine {
        const bytes = yield* this.readStream(stream);
        if (!bytes) return DMUS_E_LOADER_FAILEDOPEN;
        obj.loaded = false;
        obj.source = null;
        obj.resolved = [];
        for (const target of obj.references.splice(0)) target.release();
        this.holdReferences(obj);
        const plan = this.planLoad(obj, bytes);
        if (typeof plan === "number") return plan;
        const styles = yield* this.resolveReferences(stream, plan.styles, IID_IDirectMusicStyle, obj);
        const collections = yield* this.resolveReferences(stream, plan.collections, IID_IDirectMusicCollection, obj);
        const found: FoundReference = (ref) => styles.get(ref) ?? collections.get(ref) ?? null;
        const partial = plan.build(found);
        if (savestatesEnabled()) {
            obj.resolved = [...plan.styles, ...plan.collections].map(found);
            obj.source = { bytes };
        }
        obj.loaded = true;
        Logger.log(LogCategory.COM,
            `[DMusic] loaded ${obj.constructor.name} "${obj.identity.name || obj.fileName}" (${bytes.length} bytes)${partial ? " — partial" : ""}`);
        return partial ? DMUS_S_PARTIALLOAD : S_OK;
    }

    private planLoad(obj: LoadableObject, bytes: Uint8Array): LoadPlan | number {
        let partial = false;
        const collectionsOf = (bands: Band[]): ObjectReference[] =>
            bands.flatMap((b) => b.instruments.map((i) => i.collection).filter((c): c is ObjectReference => !!c));
        const loadBands = (bands: Band[], found: FoundReference): LoadedBand[] => bands.map((band) => loadBand(band, (ref) => {
            const target = found(ref);
            const collection = target instanceof CollectionObject ? target.collection : null;
            if (!collection) partial = true;
            return collection;
        }));

        if (obj instanceof CollectionObject) {
            obj.collection = parseDls(bytes);
            if (!obj.collection) return DMUS_E_LOADER_FORMATNOTSUPPORTED;
            this.collectionObjects.set(obj.collection, obj);
            obj.identity = obj.collection.identity;
            return { styles: [], collections: [], build: () => partial };
        }
        if (obj instanceof BandObject) {
            const file = obj.file = parseBand(bytes);
            if (!file) return DMUS_E_LOADER_FORMATNOTSUPPORTED;
            obj.identity = file.identity;
            return {
                styles: [], collections: collectionsOf([file]),
                build: (found) => {
                    obj.band = loadBands([file], found)[0]!;
                    return partial;
                },
            };
        }
        if (obj instanceof StyleObject) {
            const style = obj.style = parseStyle(bytes);
            if (!style) return DMUS_E_LOADER_FORMATNOTSUPPORTED;
            obj.identity = style.identity;
            return {
                styles: [], collections: collectionsOf(style.bands),
                build: (found) => {
                    obj.bands = loadBands(style.bands, found);
                    return partial;
                },
            };
        }
        if (obj instanceof SegmentObject) {
            const file = parseSegment(bytes);
            if (!file) return DMUS_E_LOADER_FORMATNOTSUPPORTED;
            obj.file = file;
            obj.identity = file.identity;
            const bandItems = file.tracks.flatMap((t) => t.kind === "band" ? t.items : []);
            return {
                styles: file.tracks.flatMap((t) => t.kind === "style" ? t.items.map((i) => i.style) : []),
                collections: collectionsOf(bandItems.map((i) => i.band)),
                build: (found) => {
                    const bands = loadBands(bandItems.map((i) => i.band), found);
                    const loadedByBand = new Map(bandItems.map((item, i) => [item.band, bands[i]!]));
                    const segment = buildSegment(file,
                        (ref) => {
                            const target = found(ref);
                            const style = target instanceof StyleObject ? target.style : null;
                            if (!style) partial = true;
                            return style;
                        },
                        () => null);
                    // buildSegment resolved no collections; the bands it made are replaced by the loaded ones.
                    for (const entry of segment.bands) entry.band = loadedByBand.get(entry.band.band) ?? entry.band;
                    obj.segment = segment;
                    obj.tracks = file.tracks.map((t) => ({ classId: t.classId, group: t.group, object: null }));
                    obj.commandEdits.clear();
                    return partial;
                },
            };
        }
        return E_NOTIMPL;
    }

    private buildMade(origin: DMusicObject | null, made: MadeSource, into?: LoadableObject): LoadableObject | null {
        if (made.made === "band-segment") {
            if (!(origin instanceof BandObject) || !origin.band) return null;
            return this.wrapSegment(PerfSegment.band(origin.band), origin.identity.name, into);
        }
        if (made.made === "transition") {
            const from = origin instanceof SegmentObject ? origin.segment : null;
            const style = made.style === FIXED_STYLE ? from?.fixedPattern?.style : from?.styles[made.style]?.style;
            return style ? this.wrapSegment(PerfSegment.transition(style, made.tempo, made.command, made.grooveLevel), "Transition", into) : null;
        }
        if (!(origin instanceof StyleObject) || !origin.style) return null;
        if (made.made === "style-band") {
            const loaded = origin.bands[made.index];
            if (!loaded || (into && !(into instanceof BandObject))) return null;
            const band = into ?? new BandObject();
            band.band = loaded;
            band.file = loaded.band;
            band.identity = { ...loaded.band.identity };
            band.loaded = true;
            return band;
        }
        const motif = origin.style.motifs[made.index];
        if (!motif) return null;
        const segment = PerfSegment.motif(origin.style, motif);
        // A motif with a band of its own installs it as it starts.
        if (motif.band) {
            const pool = origin.bands.flatMap((b) => b.band.instruments.map((inst, i) => ({ inst, collection: b.collections[i] ?? null })));
            segment.bands = [{ time: 0, band: loadBand(motif.band, (ref) =>
                pool.find((p) => p.inst.collection?.fileName === ref.fileName && p.collection)?.collection ?? null) }];
        }
        return this.wrapSegment(segment, motif.name, into);
    }

    private madeBy<T extends LoadableObject>(obj: T, origin: LoadableObject, made: MadeSource): T {
        origin.addRef();
        obj.references.push(origin);
        this.holdReferences(obj);
        obj.resolved = [origin];
        obj.source = { ...made, of: origin.source };
        return obj;
    }

    private makeFrom(origin: LoadableObject, made: MadeSource): LoadableObject | null {
        const obj = this.buildMade(origin, made);
        return obj && savestatesEnabled() ? this.madeBy(obj, origin, made) : obj;
    }

    private rebuildMade(obj: LoadableObject, origin: DMusicObject | null, made: MadeSource): boolean {
        if (!(origin instanceof LoadableObject) || !this.buildMade(origin, made, obj)) return false;
        obj.references.push(origin);
        this.holdReferences(obj);
        obj.resolved = [origin];
        obj.source = { ...made, of: origin.source };
        return true;
    }

    private rebuildContents(obj: LoadableObject, source: ObjectSource, bytes: Uint8Array, resolved: Array<DMusicObject | null>): boolean {
        if (obj instanceof SegmentObject && isRiffWave(bytes)) {
            return !!this.waveSegment(bytes, "file" in source ? null : waveKey(bytes), obj.fileName, obj);
        }
        if (obj instanceof SegmentObject && "file" in source) {
            const gm = resolved[0];
            return gm instanceof CollectionObject && !!this.midiSegment(bytes, obj.fileName, () => gm, obj);
        }
        const plan = this.planLoad(obj, bytes);
        const refs = typeof plan === "number" ? [] : [...plan.styles, ...plan.collections];
        if (typeof plan === "number" || refs.length !== resolved.length) return false;
        const byReference = new Map(refs.map((ref, i) => [ref, resolved[i] ?? null]));
        for (const target of resolved) if (target && !obj.references.includes(target)) obj.references.push(target);
        this.holdReferences(obj);
        plan.build((ref) => byReference.get(ref) ?? null);
        obj.resolved = resolved;
        obj.loaded = true;
        return true;
    }

    private registerObjectExports(): void {
        const e = this.exports;
        // HRESULT GetDescriptor(LPDMUS_OBJECTDESC pDesc)
        e["IDirectMusicObject_GetDescriptor"] = (_c, _m, a) => {
            const obj = this.object<LoadableObject>(a[0]);
            const desc = a[1] >>> 0;
            if (!obj || !validPointer(desc, DESC.size, "rw")) return E_POINTER;
            if ((Mem.readUint32(desc) ?? 0) < DESC.size) return E_INVALIDARG;
            let valid = DMUS_OBJ_CLASS;
            Mem.writeBytes(desc + DESC.guidClass, guidBytes(obj.classId));
            if (obj.identity.objectId) {
                valid |= DMUS_OBJ_OBJECT;
                Mem.writeBytes(desc + DESC.guidObject, guidBytes(obj.identity.objectId));
            }
            if (obj.identity.name) {
                valid |= DMUS_OBJ_NAME;
                writeWide(desc + DESC.name, obj.identity.name, DESC_NAME_CHARS);
            }
            if (obj.identity.hasVersion) {
                valid |= DMUS_OBJ_VERSION;
                Mem.writeUint32(desc + DESC.version, obj.identity.versionMS);
                Mem.writeUint32(desc + DESC.version + 4, obj.identity.versionLS);
            }
            if (obj.fileName) {
                valid |= DMUS_OBJ_FILENAME;
                writeWide(desc + DESC.fileName, obj.fileName, DESC_FILENAME_CHARS);
            }
            if (obj.loaded) valid |= DMUS_OBJ_LOADED;
            Mem.writeUint32(desc + DESC.validData, valid);
            return S_OK;
        };
        // HRESULT SetDescriptor(LPDMUS_OBJECTDESC pDesc)
        e["IDirectMusicObject_SetDescriptor"] = (_c, _m, a) => {
            const obj = this.object<LoadableObject>(a[0]);
            const desc = a[1] >>> 0;
            if (!obj || !validPointer(desc, DESC.size, "r")) return E_POINTER;
            if ((Mem.readUint32(desc) ?? 0) < DESC.size) return E_INVALIDARG;
            const valid = Mem.readUint32(desc + DESC.validData) ?? 0;
            if (valid & DMUS_OBJ_OBJECT) obj.identity.objectId = guidAt(desc + DESC.guidObject);
            if (valid & DMUS_OBJ_NAME) obj.identity.name = readWide(desc + DESC.name, DESC_NAME_CHARS);
            if (valid & DMUS_OBJ_FILENAME) obj.fileName = readWide(desc + DESC.fileName, DESC_FILENAME_CHARS);
            return S_OK;
        };
        // HRESULT ParseDescriptor(LPSTREAM pStream, LPDMUS_OBJECTDESC pDesc)
        e["IDirectMusicObject_ParseDescriptor"] = (ctx, mem, a) => {
            const obj = this.object<LoadableObject>(a[0]);
            const stream = a[1] >>> 0;
            const desc = a[2] >>> 0;
            if (!obj || !stream || !validPointer(desc, DESC.size, "rw")) return E_POINTER;
            if ((Mem.readUint32(desc) ?? 0) < DESC.size) return E_INVALIDARG;
            const self = this;
            return runGuestRoutine(ctx, mem, (function* (): GuestRoutine {
                const bytes = yield* self.readStream(stream);
                const root = bytes ? [...riffChunks(bytes, 0, bytes.length)][0] : undefined;
                if (!bytes || !root) return DMUS_E_LOADER_FAILEDOPEN;
                const identity = parseIdentity(bytes, root);
                let valid = DMUS_OBJ_CLASS;
                Mem.writeBytes(desc + DESC.guidClass, guidBytes(obj.classId));
                if (identity.objectId) {
                    valid |= DMUS_OBJ_OBJECT;
                    Mem.writeBytes(desc + DESC.guidObject, guidBytes(identity.objectId));
                }
                if (identity.name) {
                    valid |= DMUS_OBJ_NAME;
                    writeWide(desc + DESC.name, identity.name, DESC_NAME_CHARS);
                }
                Mem.writeUint32(desc + DESC.validData, valid);
                return S_OK;
            })(), 12, "IDirectMusicObject::ParseDescriptor");
        };

        e["IDirectMusicPersistStream_GetClassID"] = (_c, _m, a) => {
            const obj = this.object<LoadableObject>(a[0]);
            if (!obj || !a[1]) return E_POINTER;
            return Mem.writeBytes(a[1] >>> 0, guidBytes(obj.classId)) ? S_OK : E_POINTER;
        };
        e["IDirectMusicPersistStream_IsDirty"] = () => S_FALSE;
        // HRESULT Load(IStream *pStm)
        e["IDirectMusicPersistStream_Load"] = (ctx, mem, a) => {
            const obj = this.object<LoadableObject>(a[0]);
            if (!obj || !a[1]) return E_POINTER;
            return runGuestRoutine(ctx, mem, this.load(obj, a[1] >>> 0), 8, "IPersistStream::Load");
        };
        e["IDirectMusicPersistStream_Save"] = () => E_NOTIMPL;
        e["IDirectMusicPersistStream_GetSizeMax"] = () => E_NOTIMPL;
    }

    registerSavestate(): () => void {
        return registerDMusicParticipant({
            idleRefusal: () => this.savestateRefusal(),
            defaultGmCollection: () => this.defaultGmCollection(),
            releaseDirectSound: (dm) => this.setDirectSound(dm, 0),
            wireLoader: (loader) => this.wireLoader(loader),
            readFile: (path) => this.readSystemFile([path]),
            rebuildContents: (obj, source, bytes, resolved) => this.rebuildContents(obj, source, bytes, resolved),
            rebuildMade: (obj, origin, made) => this.rebuildMade(obj, origin, made),
            adoptCollection: (obj) => { if (obj.collection) this.collectionObjects.set(obj.collection, obj); },
            collectionObject: (collection) => {
                const obj = this.collectionObjects.get(collection);
                return obj && obj.collection === collection && obj.refCount > 0 ? obj : null;
            },
            wirePerformance: (perf) => this.wirePerformance(perf),
            wirePort: (port) => this.wirePort(port),
            wireState: (obj) => this.wireState(obj),
            wirePath: (path) => this.wirePath(path),
            newSink: (buffer, channels, sampleRate) => new DirectSoundSink(this.process, buffer, channels, sampleRate ?? DMusic.PATH_RATE),
            newEngine: (perf, port) => this.newEngine(perf, port),
            moduleState: () => ({
                performances: [...this.performances], ports: [...this.ports], pathOutputs: [...this.pathOutputs],
                messages: [...this.messages], pumpTimer: this.pumpTimer,
            }),
            restoreModuleState: (state) => {
                for (const [set, list] of [[this.performances, state.performances], [this.ports, state.ports], [this.pathOutputs, state.pathOutputs]] as const) {
                    (set as Set<DMusicObject>).clear();
                    for (const obj of list) (set as Set<DMusicObject>).add(obj);
                }
                this.messages.clear();
                for (const [ptr, obj] of state.messages) this.messages.set(ptr, obj);
                this.pumpTimer = state.pumpTimer;
            },
        });
    }

    savestateRefusal(): string | null {
        return this.loading.size > 0 ? 'dmusic: an object is still loading; try saving again' : null;
    }

    // ── system loader ───────────────────────────────────────────────────────────

    /**
     * The default GM collection: Windows' gm.dls when the bundle has one, else an empty
     * collection. The loader keeps it, as its cache would, for as long as the loader lives.
     */
    private defaultCollection(loader: LoaderObject): CollectionObject {
        if (loader.defaultCollection) return loader.defaultCollection;
        const obj = new CollectionObject();
        obj.identity.objectId = GUID_DefaultGMCollection;
        obj.identity.name = "GM";
        obj.collection = this.defaultGmCollection();
        this.collectionObjects.set(obj.collection, obj);
        obj.loaded = true;
        loader.defaultCollection = obj;
        return obj;
    }

    private defaultGmCollection(): DlsCollection {
        const bytes = this.readSystemFile(DEFAULT_COLLECTION_PATHS);
        const parsed = bytes ? parseDls(bytes) : null;
        if (parsed) return parsed;
        const empty: DlsCollection = { identity: { objectId: GUID_DefaultGMCollection, name: "GM", versionMS: 0, versionLS: 0, hasVersion: false }, instruments: [], waves: [] };
        if (!bytes && gmBankAvailable()) {
            onGmBank((bank) => {
                empty.instruments = bank.instruments;
                empty.waves = bank.waves;
                Logger.log(LogCategory.COM, `[DMusic] default GM collection from the General MIDI bank (${bank.instruments.length} instruments)`);
                for (const performance of this.performances) performance.engine?.reinstallInstruments(empty);
            });
            void loadGmBank();
            return empty;
        }
        if (!bytes) Logger.log(LogCategory.COM, "[DMusic] no gm.dls in the bundle: instruments from the default GM collection are silent");
        return empty;
    }

    private createLoader(): LoaderObject {
        return this.wireLoader(new LoaderObject());
    }

    private wireLoader(loader: LoaderObject): LoaderObject {
        loader.onDestroy = () => {
            this.clearLoaderCache(loader, GUID_DirectMusicAllTypes);
            loader.defaultCollection?.release();
            loader.defaultCollection = null;
        };
        return loader;
    }

    private loaderCaches(loader: LoaderObject, classId: string): boolean {
        return !loader.cacheDisabled.has(GUID_DirectMusicAllTypes) && !loader.cacheDisabled.has(classId);
    }

    private clearLoaderCache(loader: LoaderObject, classId: string): void {
        for (const [key, obj] of loader.cache) {
            if (classId !== GUID_DirectMusicAllTypes && obj.classId !== classId) continue;
            loader.cache.delete(key);
            obj.release();
        }
    }

    private releaseFromLoaderCache(loader: LoaderObject, obj: DMusicObject | null): number {
        for (const [key, cached] of loader.cache) {
            if (cached !== obj) continue;
            loader.cache.delete(key);
            cached.release();
            return S_OK;
        }
        return DMUS_E_LOADER_OBJECTNOTFOUND;
    }

    private readonly decodedWaves = new Map<string, WaveData>();

    private waveSegment(bytes: Uint8Array, key: string | null, fileName: string, into?: SegmentObject): SegmentObject | null {
        if ((globalThis as { __dmusicWaveSegments?: boolean }).__dmusicWaveSegments === false) return null;
        let wave = key ? this.decodedWaves.get(key) ?? null : null;
        if (!wave) {
            wave = decodeWave(bytes);
            if (!wave) return null;
            if (key) {
                if (this.decodedWaves.size >= WAVE_CACHE_ENTRIES) this.decodedWaves.delete(this.decodedWaves.keys().next().value!);
                this.decodedWaves.set(key, wave);
            }
        }
        const obj = into ?? new SegmentObject();
        obj.segment = PerfSegment.fromWave(wave);
        obj.identity = { objectId: "", name: fileName, versionMS: 0, versionLS: 0, hasVersion: false };
        obj.fileName = fileName;
        obj.loaded = true;
        return obj;
    }

    private objectFromMemory(desc: number): LoadableObject | null {
        const length = Mem.readUint32(desc + DESC.memLength) ?? 0;
        const data = Mem.readUint32(desc + DESC.memData) ?? 0;
        if (!data || length < 12 || length > MAX_OBJECT_BYTES || !validPointer(data, length, "r")) return null;
        const bytes = Mem.readBytes(data, length);
        if (!bytes || !isRiffWave(bytes)) return null;
        const obj = this.waveSegment(bytes, waveKey(bytes), "");
        if (obj && savestatesEnabled()) obj.source = { bytes: bytes.slice() };
        return obj;
    }

    private objectFromFile(loader: LoaderObject, bytes: Uint8Array, fileName: string, path: string): LoadableObject | null {
        const obj = isRiffWave(bytes) ? this.waveSegment(bytes, null, fileName)
            : isStandardMidiFile(bytes) ? this.midiSegment(bytes, fileName, () => this.defaultCollection(loader)) : null;
        if (obj && savestatesEnabled()) obj.source = { file: path, length: bytes.length, hash: sha256HexSync(bytes) };
        return obj;
    }

    private midiSegment(bytes: Uint8Array, fileName: string, collection: () => CollectionObject, into?: SegmentObject): SegmentObject | null {
        const gmRef = {
            validData: DMUS_OBJ_OBJECT, classId: "", objectId: GUID_DefaultGMCollection, name: "", category: "",
            fileName: "", versionMS: 0, versionLS: 0,
        };
        const file = smfToSegment(bytes, fileName, gmRef);
        if (!file) return null;
        const gm = collection();
        const obj = into ?? new SegmentObject();
        obj.file = file;
        obj.identity = { ...file.identity };
        obj.fileName = fileName;
        obj.segment = buildSegment(file, () => null, (ref) => ref.objectId === GUID_DefaultGMCollection ? gm.collection : null);
        obj.tracks = file.tracks.map((t) => ({ classId: t.classId, group: t.group, object: null }));
        if (into || savestatesEnabled()) obj.resolved = [gm];
        obj.loaded = true;
        return obj;
    }

    private readSystemFile(paths: string[]): Uint8Array | null {
        const vfs = System.getInstance().fileSystem;
        for (const path of paths) {
            try {
                const size = vfs.getFileSize(path);
                if (size <= 0 || size > MAX_OBJECT_BYTES) continue;
                const handle = vfs.openSync(path, 0x80000000, 3);
                if (!handle) continue;
                const chunks: Uint8Array[] = [];
                for (let left = size; left > 0;) {
                    const chunk = vfs.readSync(handle, Math.min(left, 4 * 1024 * 1024));
                    if (!chunk || chunk.length === 0) break;
                    chunks.push(chunk);
                    left -= chunk.length;
                }
                const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
                let o = 0;
                for (const c of chunks) { out.set(c, o); o += c.length; }
                if (out.length === size) return out;
            } catch {
                // Not in this bundle.
            }
        }
        return null;
    }

    private registerLoaderExports(): void {
        const e = this.exports;
        // HRESULT GetObject(LPDMUS_OBJECTDESC pDesc, REFIID riid, LPVOID *ppv)
        e["IDirectMusicLoader8_GetObject"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            const desc = a[1] >>> 0;
            const ppv = a[3] >>> 0;
            if (ppv) Mem.writeUint32(ppv, 0);
            if (!loader || !desc || !ppv) return E_POINTER;
            const valid = Mem.readUint32(desc + DESC.validData) ?? 0;
            if ((valid & DMUS_OBJ_OBJECT) && guidAt(desc + DESC.guidObject) === GUID_DefaultGMCollection) {
                return this.queryInterface(this.defaultCollection(loader), guidAt(a[2]! >>> 0), ppv);
            }
            const name = valid & DMUS_OBJ_FILENAME ? readWide(desc + DESC.fileName, DESC_FILENAME_CHARS) : "";
            if (name) {
                const dir = loader.searchDirectory;
                const full = (valid & DMUS_OBJ_FULLPATH) || !dir || /^[a-z]:|^\\/i.test(name)
                    ? name : dir.replace(/[\\/]+$/, "") + "\\" + name;
                const key = full.toLowerCase();
                const cached = loader.cache.get(key);
                if (cached) return this.queryInterface(cached, guidAt(a[2]! >>> 0), ppv);
                const bytes = this.readSystemFile([full]);
                const obj = bytes ? this.objectFromFile(loader, bytes, name, full) : null;
                Logger.log(LogCategory.COM, `[DMusic] system loader GetObject("${full}") -> ${obj ? "loaded" : "DMUS_E_LOADER_FAILEDOPEN"}`);
                if (!obj) return DMUS_E_LOADER_FAILEDOPEN;
                const hr = this.queryInterface(obj, guidAt(a[2]! >>> 0), ppv);
                if (hr === S_OK && this.loaderCaches(loader, obj.classId)) loader.cache.set(key, obj);
                else obj.release();
                return hr;
            }
            if (valid & DMUS_OBJ_MEMORY) {
                const obj = this.objectFromMemory(desc);
                if (!obj) return DMUS_E_LOADER_FAILEDOPEN;
                const hr = this.queryInterface(obj, guidAt(a[2]! >>> 0), ppv);
                obj.release();
                return hr;
            }
            Logger.log(LogCategory.COM, `[DMusic] system loader GetObject -> DMUS_E_LOADER_OBJECTNOTFOUND`);
            return DMUS_E_LOADER_OBJECTNOTFOUND;
        };
        e["IDirectMusicLoader8_SetObject"] = () => S_OK;
        e["IDirectMusicLoader8_SetSearchDirectory"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            if (!loader) return E_POINTER;
            const path = a[2] ? readWide(a[2] >>> 0, DESC_FILENAME_CHARS) : "";
            loader.searchDirectory = path || System.getInstance().fileSystem.currentDir || "";
            return S_OK;
        };
        e["IDirectMusicLoader8_ScanDirectory"] = () => S_FALSE;   // "no files found"
        e["IDirectMusicLoader8_CacheObject"] = () => S_OK;
        e["IDirectMusicLoader8_ReleaseObject"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            return loader ? this.releaseFromLoaderCache(loader, this.object(a[1])) : E_POINTER;
        };
        e["IDirectMusicLoader8_ClearCache"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            if (!loader) return E_POINTER;
            this.clearLoaderCache(loader, validPointer(a[1]! >>> 0, 16, "r") ? guidAt(a[1]! >>> 0) : GUID_DirectMusicAllTypes);
            return S_OK;
        };
        e["IDirectMusicLoader8_EnableCache"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            if (!loader) return E_POINTER;
            const classId = validPointer(a[1]! >>> 0, 16, "r") ? guidAt(a[1]! >>> 0) : GUID_DirectMusicAllTypes;
            const was = this.loaderCaches(loader, classId);
            if (a[2]) {
                if (classId === GUID_DirectMusicAllTypes) loader.cacheDisabled.clear();
                else loader.cacheDisabled.delete(classId);
            } else {
                loader.cacheDisabled.add(classId);
                this.clearLoaderCache(loader, classId);
            }
            return was === !!a[2] ? S_FALSE : S_OK;
        };
        e["IDirectMusicLoader8_EnumObject"] = () => S_FALSE;      // end of enumeration
        e["IDirectMusicLoader8_CollectGarbage"] = () => S_OK;
        e["IDirectMusicLoader8_ReleaseObjectByUnknown"] = (_c, _m, a) => {
            const loader = this.object<LoaderObject>(a[0]);
            return loader ? this.releaseFromLoaderCache(loader, this.object(a[1])) : E_POINTER;
        };
        // HRESULT LoadObjectFromFile(REFGUID rguidClassID, REFIID iidInterfaceID,
        //                            WCHAR *pwzFilePath, void **ppObject)
        e["IDirectMusicLoader8_LoadObjectFromFile"] = (_c, _m, a) => {
            const ppObject = a[4] >>> 0;
            if (ppObject) Mem.writeUint32(ppObject, 0);
            Logger.log(LogCategory.COM,
                `[DMusic] LoadObjectFromFile("${readWide(a[3] >>> 0, DESC_FILENAME_CHARS)}") -> DMUS_E_LOADER_FAILEDOPEN`);
            return DMUS_E_LOADER_FAILEDOPEN;
        };
    }

    // ── performance ─────────────────────────────────────────────────────────────

    /** The COM object standing for an engine state, made when first needed. */
    private stateObject(perf: PerformanceObject, state: PerfSegmentState): SegmentStateObject {
        let obj = perf.stateObjects.get(state);
        if (obj && obj.refCount > 0) return obj;
        obj = new SegmentStateObject();
        obj.state = state;
        obj.performance = perf;
        this.wireState(obj);
        perf.stateObjects.set(state, obj);
        // The performance owns the creation reference until the state ends or it closes.
        return obj;
    }

    private wireState(obj: SegmentStateObject): void {
        obj.onDestroy = () => {
            const state = obj.state;
            if (state && obj.performance?.stateObjects.get(state) === obj) obj.performance.stateObjects.delete(state);
            obj.segment?.release();
            obj.segment = null;
        };
    }

    private wirePerformance(perf: PerformanceObject): void {
        perf.onDestroy = () => { this.closePerformance(perf); this.performances.delete(perf); };
    }

    private newEngine(perf: PerformanceObject, port: PortObject): Performance {
        const engine = new Performance(port.synth);
        if (savestatesEnabled()) engine.seedRandom(Math.random() * 0x100000000);
        engine.onNotification = (type, state, time) => this.notify(perf, type, state, time);
        return engine;
    }

    /** Hand a state object to the guest at `ppOut` (optional); the guest owns that reference. */
    private publishState(perf: PerformanceObject, state: PerfSegmentState | null, segment: SegmentObject | null, ppOut: number): number {
        if (!ppOut) return S_OK;
        if (!validPointer(ppOut, 4, "w")) return E_POINTER;
        if (!state) { Mem.writeUint32(ppOut, 0); return S_OK; }
        const obj = this.stateObject(perf, state);
        this.holdStateSegment(obj, segment);
        const address = this.addressOf(obj, obj.primaryVtable);
        if (!address) return E_FAIL;
        if (!Mem.writeUint32(ppOut, address)) return E_POINTER;
        obj.addRef();
        return S_OK;
    }

    private holdStateSegment(obj: SegmentStateObject, segment: SegmentObject | null): void {
        if (!segment || obj.segment === segment) return;
        segment.addRef();
        obj.segment?.release();
        obj.segment = segment;
    }

    private releaseEndedStates(perf: PerformanceObject): void {
        for (const [state, obj] of perf.stateObjects) {
            if (!state.ended) continue;
            perf.stateObjects.delete(state);
            obj.release();
        }
    }

    private detachPort(perf: PerformanceObject): void {
        perf.engine?.stop(null, null, 0);
        if (perf.engine) perf.engine.onNotification = null;
        const port = perf.port;
        perf.port = null;
        perf.engine = null;
        if (port?.performance === perf) {
            port.performance = null;
            this.activatePort(port, false);
        }
        port?.release();
        this.releaseEndedStates(perf);
    }

    private closePerformance(perf: PerformanceObject): void {
        perf.notifySegments = false;
        this.detachPort(perf);
        for (const n of perf.notifications.splice(0)) n.state.release();
        for (const obj of [...perf.stateObjects.values()]) obj.release();
        perf.stateObjects.clear();
        perf.notificationHandle = 0;
        perf.defaultAudioPath?.release();
        perf.defaultAudioPath = null;
        perf.directMusic?.release();
        perf.directMusic = null;
    }

    private releasePortOutput(port: PortObject): void {
        port.sink?.release();
        port.sink = null;
        soundReference(this.process, port.buffer, true, false);
        port.buffer = 0;
        port.ownsBuffer = false;
    }

    /** A new IDirectSound8 from the dsound module, at 2 for `hWnd`; 0 when there is none. */
    private createDirectSound(hWnd: number): number {
        const exports = this.process.getModule("dsound")?.exports;
        const create = exports?.["directsoundcreate8"];
        const mem = Mem.getView();
        if (!create || !mem) return 0;
        const scratch = this.process.memory.alloc(4, "HEAP", "rw");
        if (!scratch) return 0;
        try {
            Mem.writeUint32(scratch, 0);
            const ctx = NO_CONTEXT;
            if ((create(ctx, mem, [0, scratch, 0]) as number) !== S_OK) return 0;
            const ds = Mem.readUint32(scratch) ?? 0;
            if (ds && exports["idirectsound8_setcooperativelevel"]?.(ctx, mem, [ds, hWnd, 2]) !== S_OK) {
                soundReference(this.process, ds, false, false);
                return 0;
            }
            return ds;
        } finally {
            this.process.memory.free(scratch);
        }
    }

    private setDirectSound(obj: DirectMusicObject | PortObject, ptr: number): void {
        if (obj.directSound === ptr) return;
        soundReference(this.process, ptr, false, true);
        soundReference(this.process, obj.directSound, false, false);
        obj.directSound = ptr;
    }

    private attachEngine(perf: PerformanceObject, port: PortObject): void {
        if (perf.port === port) return;
        this.detachPort(perf);
        port.addRef();
        port.performance = perf;
        perf.port = port;
        const engine = this.newEngine(perf, port);
        engine.setMasterTempo(perf.masterTempo);
        port.synth.setMasterVolume(perf.masterVolume);
        perf.engine = engine;
    }

    private notify(perf: PerformanceObject, type: number, state: PerfSegmentState, musicTime: number): void {
        if (!perf.notifySegments) return;
        const now = performance.now();
        while (perf.notifications.length > 0 && now - perf.notifications[0]!.queuedAtMs > NOTIFICATION_LIFETIME_MS) {
            perf.notifications.shift()!.state.release();
        }
        const obj = this.stateObject(perf, state);
        obj.addRef();
        perf.notifications.push({ type, state: obj, musicTime, queuedAtMs: now });
        if (perf.notificationHandle) System.getInstance().scheduler?.setEvent(perf.notificationHandle);
    }

    private createPort(dm: DirectMusicObject | null, sampleRate: number, audioChannels: number, voices: number): PortObject {
        const port = new PortObject();
        port.sampleRate = sampleRate;
        port.audioChannels = audioChannels;
        port.voices = voices;
        port.synth = new DlsSynth(sampleRate, voices);
        this.setDirectSound(port, dm?.directSound ?? 0);
        port.owner = dm;
        dm?.ports.add(port);
        this.ports.add(port);
        this.wirePort(port);
        return port;
    }

    private wirePort(port: PortObject): void {
        port.onDestroy = () => {
            this.activatePort(port, false);
            this.releasePortOutput(port);
            this.setDirectSound(port, 0);
            this.ports.delete(port);
            port.owner?.ports.delete(port);
            if (port.performance?.port === port) {
                port.performance.port = null;
                port.performance.engine = null;
            }
        };
    }

    private createDirectMusic(): DirectMusicObject {
        const dm = new DirectMusicObject();
        dm.onDestroy = () => this.setDirectSound(dm, 0);
        return dm;
    }

    private registerPerformanceExports(): void {
        const e = this.exports;
        const perfOf = (a: number[]): PerformanceObject | null => this.object<PerformanceObject>(a[0]!);
        const ok = (): number => S_OK;
        for (const name of ["SetPrepareTime", "SetBumperLength", "SetGraph", "Invalidate", "AdjustTime", "SetDefaultAudioPath"]) {
            e[`IDirectMusicPerformance8_${name}`] = ok;
        }
        // AssignPChannelBlock(dwBlockNum, pPort, dwGroup) / AssignPChannel(dwPChannel, pPort, dwGroup, dwMChannel):
        // there is one port with one synthesizer behind it, so a performance channel is its
        // own channel there and the assignment only has to name that port.
        const assign: ThunkImplementation = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            const port = this.object<PortObject>(a[2]);
            return port && port === perf.port ? S_OK : E_INVALIDARG;
        };
        e["IDirectMusicPerformance8_AssignPChannelBlock"] = assign;
        e["IDirectMusicPerformance8_AssignPChannel"] = assign;

        // HRESULT Init(IDirectMusic **ppDirectMusic, IDirectSound *pDirectSound, HWND hWnd)
        // *ppDirectMusic may name an IDirectMusic to use; NULL there asks for a new one back.
        const init = (thisPtr: number, ppDirectMusic: number, directSound: number): number => {
            const perf = this.object<PerformanceObject>(thisPtr);
            if (!perf) return E_POINTER;
            if (ppDirectMusic && !validPointer(ppDirectMusic, 4, "rw")) return E_POINTER;
            const supplied = ppDirectMusic ? (Mem.readUint32(ppDirectMusic) ?? 0) : 0;
            let dm = supplied ? this.object<DirectMusicObject>(supplied) : null;
            if (!dm) {
                dm = this.createDirectMusic();
                if (ppDirectMusic) {
                    const hr = this.queryInterface(dm, IID_IUnknown, ppDirectMusic);
                    if (hr !== S_OK) { dm.release(); return hr; }
                }
            } else {
                dm.addRef();
            }
            if (directSound) this.setDirectSound(dm, directSound >>> 0);
            perf.directMusic?.release();
            perf.directMusic = dm;
            return S_OK;
        };
        e["IDirectMusicPerformance8_Init"] = (_c, _m, a) => init(a[0]!, a[1]! >>> 0, a[2]! >>> 0);
        // InitAudio(ppDirectMusic, ppDirectSound, hWnd, dwDefaultPathType, dwPChannelCount, dwFlags, pParams)
        e["IDirectMusicPerformance8_InitAudio"] = (_c, _m, a) => {
            const ppDirectSound = a[2]! >>> 0;
            if (!perfOf(a) || (ppDirectSound && !validPointer(ppDirectSound, 4, "rw"))) return E_POINTER;
            let directSound = ppDirectSound ? (Mem.readUint32(ppDirectSound) ?? 0) : 0;
            if (ppDirectSound && !directSound) {
                directSound = this.createDirectSound(a[3]! >>> 0);
                if (!directSound) return E_FAIL;
                Mem.writeUint32(ppDirectSound, directSound);
            }
            const hr = init(a[0]!, a[1]! >>> 0, directSound);
            const perf = perfOf(a);
            // InitAudio brings its own synthesizer: there is no AddPort to wait for.
            if (hr === S_OK && perf && !perf.engine) {
                const port = this.createPort(perf.directMusic, 22050, 2, 64);
                this.addressOf(port, port.primaryVtable);
                this.attachEngine(perf, port);
                const active = this.activatePort(port, true);
                port.release();
                if (!active) { this.detachPort(perf); return E_FAIL; }
            }
            return hr;
        };

        // HRESULT AddPort(IDirectMusicPort *pPort) — NULL adds the default port.
        e["IDirectMusicPerformance8_AddPort"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            let port = a[1] ? this.object<PortObject>(a[1]) : null;
            if (port?.performance && port.performance !== perf) return E_INVALIDARG;
            const created = !port;
            if (!port) {
                if (a[1]) return E_INVALIDARG;
                port = this.createPort(perf.directMusic, 22050, 2, 32);
                this.addressOf(port, port.primaryVtable);
                if (!this.activatePort(port, true)) { port.release(); return E_FAIL; }
            }
            this.attachEngine(perf, port);
            if (created) port.release();
            return S_OK;
        };
        e["IDirectMusicPerformance8_RemovePort"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            this.detachPort(perf);
            return S_OK;
        };
        // HRESULT PChannelInfo(DWORD dwPChannel, IDirectMusicPort **ppPort, DWORD *pdwGroup, DWORD *pdwMChannel)
        e["IDirectMusicPerformance8_PChannelInfo"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf?.port) return DMUS_E_NOT_INIT;
            for (const i of [2, 3, 4]) if (a[i] && !validPointer(a[i] >>> 0, 4, "w")) return E_POINTER;
            if (a[2]) {
                const hr = this.queryInterface(perf.port, IID_IUnknown, a[2] >>> 0);
                if (hr !== S_OK) return hr;
            }
            if (a[3]) Mem.writeUint32(a[3] >>> 0, (a[1]! >>> 4) + 1);
            if (a[4]) Mem.writeUint32(a[4] >>> 0, a[1]! & 0xf);
            return S_OK;
        };
        // DownloadInstrument(pInst, dwPChannel, ppDownInst, pNoteRanges, dwNumNoteRanges,
        //                    ppPort, pdwGroup, pdwMChannel): instruments reach the synth
        // through bands, so there is no download object to hand back.
        e["IDirectMusicPerformance8_DownloadInstrument"] = (_c, _m, a) => {
            for (const i of [3, 6, 7, 8]) if (a[i]) Mem.writeUint32(a[i]! >>> 0, 0);
            return DMUS_E_NOT_FOUND;
        };

        // HRESULT PlaySegment(IDirectMusicSegment *pSegment, DWORD dwFlags, __int64 i64StartTime,
        //                     IDirectMusicSegmentState **ppSegmentState)
        const play = (perf: PerformanceObject | null, segPtr: number, flags: number, ppState: number, pathPtr = 0): number => {
            if (ppState && !validPointer(ppState, 4, "w")) return E_POINTER;
            if (ppState) Mem.writeUint32(ppState, 0);
            const seg = this.object<SegmentObject>(segPtr);
            if (!perf || !seg) return E_POINTER;
            if (!perf.engine) return DMUS_E_NOT_INIT;
            if (!seg.segment) return E_FAIL;
            const state = perf.engine.playSegment(seg.segment, flags >>> 0);
            const path = pathPtr ? this.object<AudioPathObject>(pathPtr) : null;
            if (state && seg.segment.wave && path instanceof AudioPathObject && this.ensurePathOutput(path)) state.output = path;
            if (state) this.holdStateSegment(this.stateObject(perf, state), seg);
            return this.publishState(perf, state, seg, ppState);
        };
        e["IDirectMusicPerformance8_PlaySegment"] = (_c, _m, a) => play(perfOf(a), a[1]!, a[2]!, a[5]! >>> 0);
        // PlaySegmentEx(pSource, pwzSegmentName, pTransition, dwFlags, i64StartTime, ppSegmentState, pFrom, pAudioPath)
        e["IDirectMusicPerformance8_PlaySegmentEx"] = (_c, _m, a) => play(perfOf(a), a[1]!, a[4]!, a[7]! >>> 0, a[9]! >>> 0);

        // HRESULT Stop(IDirectMusicSegment *pSegment, IDirectMusicSegmentState *pSegmentState,
        //              MUSIC_TIME mtTime, DWORD dwFlags)
        e["IDirectMusicPerformance8_Stop"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            const seg = a[1] ? this.object<SegmentObject>(a[1]) : null;
            const state = a[2] ? this.object<SegmentStateObject>(a[2]) : null;
            perf.engine?.stop(seg?.segment ?? null, state?.state ?? null, a[4]! >>> 0);
            this.releaseEndedStates(perf);
            return S_OK;
        };
        // StopEx(pObjectToStop, i64StopTime, dwFlags): a segment, a state, or NULL for all.
        e["IDirectMusicPerformance8_StopEx"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            const target = a[1] ? this.object<DMusicObject>(a[1]) : null;
            perf.engine?.stop(
                target instanceof SegmentObject ? target.segment : null,
                target instanceof SegmentStateObject ? target.state : null, a[4]! >>> 0);
            this.releaseEndedStates(perf);
            return S_OK;
        };
        // HRESULT IsPlaying(IDirectMusicSegment *pSegment, IDirectMusicSegmentState *pSegState)
        e["IDirectMusicPerformance8_IsPlaying"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf || (!a[1] && !a[2])) return E_POINTER;
            const seg = a[1] ? this.object<SegmentObject>(a[1]) : null;
            const state = a[2] ? this.object<SegmentStateObject>(a[2]) : null;
            if ((a[1] && !seg?.segment) || (a[2] && !state?.state)) return S_FALSE;
            return perf.engine?.isPlaying(seg?.segment ?? null, state?.state ?? null) ? S_OK : S_FALSE;
        };
        // HRESULT GetSegmentState(IDirectMusicSegmentState **ppSegmentState, MUSIC_TIME mtTime)
        e["IDirectMusicPerformance8_GetSegmentState"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const ppState = a[1]! >>> 0;
            if (!perf || !ppState) return E_POINTER;
            const state = perf.engine?.primaryState() ?? null;
            const hr = this.publishState(perf, state, null, ppState);
            if (hr !== S_OK) return hr;
            return state ? S_OK : DMUS_E_NOT_FOUND;
        };

        // Notifications: an event the application waits on, and a queue it then drains.
        e["IDirectMusicPerformance8_SetNotificationHandle"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            perf.notificationHandle = a[1]! >>> 0;
            return S_OK;
        };
        e["IDirectMusicPerformance8_AddNotificationType"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            if (guidAt(a[1]! >>> 0) === GUID_NOTIFICATION_SEGMENT) perf.notifySegments = true;
            return S_OK;
        };
        e["IDirectMusicPerformance8_RemoveNotificationType"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            if (guidAt(a[1]! >>> 0) === GUID_NOTIFICATION_SEGMENT) perf.notifySegments = false;
            return S_OK;
        };
        // HRESULT GetNotificationPMsg(DMUS_NOTIFICATION_PMSG **ppNotificationPMsg)
        e["IDirectMusicPerformance8_GetNotificationPMsg"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const pp = a[1]! >>> 0;
            if (!perf || !validPointer(pp, 4, "w")) return E_POINTER;
            const next = perf.notifications[0];
            if (!next) {
                Mem.writeUint32(pp, 0);
                return S_FALSE;
            }
            const msg = this.process.memory.alloc(NOTIFICATION_PMSG.size, "HEAP", "rw");
            if (!msg) return E_FAIL;
            Mem.writeBytes(msg, new Uint8Array(NOTIFICATION_PMSG.size));
            Mem.writeUint32(msg, NOTIFICATION_PMSG.size);
            Mem.writeUint32(msg + NOTIFICATION_PMSG.mtTime, Math.round(next.musicTime) >>> 0);
            Mem.writeUint32(msg + NOTIFICATION_PMSG.flags, DMUS_PMSGF_MUSICTIME);
            Mem.writeUint32(msg + NOTIFICATION_PMSG.type, DMUS_PMSGT_NOTIFICATION);
            // punkUser carries the segment state, with the reference the queue held.
            Mem.writeUint32(msg + NOTIFICATION_PMSG.punkUser, this.addressOf(next.state, next.state.primaryVtable));
            Mem.writeBytes(msg + NOTIFICATION_PMSG.guid, guidBytes(GUID_NOTIFICATION_SEGMENT));
            Mem.writeUint32(msg + NOTIFICATION_PMSG.option, next.type);
            this.messages.set(msg, next.state);
            Mem.writeUint32(pp, msg);
            perf.notifications.shift();
            return S_OK;
        };
        // HRESULT AllocPMsg(ULONG cb, DMUS_PMSG **ppPMSG)
        e["IDirectMusicPerformance8_AllocPMsg"] = (_c, _m, a) => {
            const cb = a[1]! >>> 0;
            const pp = a[2]! >>> 0;
            if (!validPointer(pp, 4, "w")) return E_POINTER;
            if (cb < 56 || cb > 0x10000) {
                Mem.writeUint32(pp, 0);
                return E_INVALIDARG;
            }
            const msg = this.process.memory.alloc(cb, "HEAP", "rw");
            if (!msg) { Mem.writeUint32(pp, 0); return E_FAIL; }
            Mem.writeBytes(msg, new Uint8Array(cb));
            Mem.writeUint32(msg, cb);
            this.messages.set(msg, null);
            Mem.writeUint32(pp, msg);
            return S_OK;
        };
        const freeMessage = (msg: number): number => {
            if (!this.messages.has(msg)) return E_INVALIDARG;
            this.messages.get(msg)?.release();
            this.messages.delete(msg);
            this.process.memory.free(msg);
            return S_OK;
        };
        e["IDirectMusicPerformance8_FreePMsg"] = (_c, _m, a) => freeMessage(a[1]! >>> 0);
        // A message sent to the performance is the performance's from then on. We route no
        // application-made messages, so it is released at once.
        e["IDirectMusicPerformance8_SendPMsg"] = (_c, _m, a) => freeMessage(a[1]! >>> 0);
        e["IDirectMusicPerformance8_ClonePMsg"] = (_c, _m, a) => {
            if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
            return E_NOTIMPL;
        };

        // HRESULT SetGlobalParam(REFGUID rguidType, void *pParam, DWORD dwSize)
        e["IDirectMusicPerformance8_SetGlobalParam"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const param = a[2]! >>> 0;
            if (!perf || !param) return E_POINTER;
            const type = guidAt(a[1]! >>> 0);
            if (type === GUID_PerfMasterVolume) {
                perf.masterVolume = Mem.readInt32(param) ?? 0;
                perf.port?.synth.setMasterVolume(perf.masterVolume);
            } else if (type === GUID_PerfMasterTempo) {
                perf.masterTempo = Mem.readFloat32(param) ?? 1;
                perf.engine?.setMasterTempo(perf.masterTempo);
            }
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetGlobalParam"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const param = a[2]! >>> 0;
            if (!perf || !param) return E_POINTER;
            const type = guidAt(a[1]! >>> 0);
            if (type === GUID_PerfMasterVolume) Mem.writeUint32(param, perf.masterVolume >>> 0);
            else if (type === GUID_PerfMasterTempo) Mem.writeFloat32(param, perf.masterTempo);
            else return DMUS_E_GET_UNSUPPORTED;
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetParam"] = () => DMUS_E_GET_UNSUPPORTED;
        e["IDirectMusicPerformance8_GetParamEx"] = () => DMUS_E_GET_UNSUPPORTED;
        e["IDirectMusicPerformance8_SetParam"] = () => DMUS_E_SET_UNSUPPORTED;

        // Queries that hand back a value must write it: the caller reads the out-param
        // regardless of the HRESULT it got.
        e["IDirectMusicPerformance8_GetPrepareTime"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 1000); return S_OK; };
        e["IDirectMusicPerformance8_GetBumperLength"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 50); return S_OK; };
        e["IDirectMusicPerformance8_GetGraph"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicPerformance8_MIDIToMusic"] = () => E_NOTIMPL;
        e["IDirectMusicPerformance8_MusicToMIDI"] = () => E_NOTIMPL;
        e["IDirectMusicPerformance8_TimeToRhythm"] = () => E_NOTIMPL;
        e["IDirectMusicPerformance8_RhythmToTime"] = () => E_NOTIMPL;

        // Clocks. Reference time is in 100 ns units; music time is the engine's own.
        const referenceTime = (): number => Math.floor(TimeService.getInstance().nowMs() * 10_000);
        const writeTime = (address: number, units: number): void => {
            Mem.writeUint32(address, units >>> 0);
            Mem.writeUint32(address + 4, Math.floor(units / 0x100000000) >>> 0);
        };
        e["IDirectMusicPerformance8_GetTime"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (a[1]) writeTime(a[1] >>> 0, referenceTime());
            if (a[2]) Mem.writeUint32(a[2] >>> 0, Math.floor(perf?.engine?.musicTime ?? 0) >>> 0);
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetLatencyTime"] = (_c, _m, a) => {
            if (a[1]) writeTime(a[1] >>> 0, referenceTime());
            return S_OK;
        };
        e["IDirectMusicPerformance8_GetQueueTime"] = e["IDirectMusicPerformance8_GetLatencyTime"]!;
        e["IDirectMusicPerformance8_GetResolvedTime"] = (_c, _m, a) => {
            if (a[3]) { Mem.writeUint32(a[3] >>> 0, a[1]! >>> 0); Mem.writeUint32((a[3] >>> 0) + 4, a[2]! >>> 0); }
            return S_OK;
        };
        // The two clocks are related through the tempo in force now.
        const ticksPerUnit = (perf: PerformanceObject | null): number =>
            ((perf?.engine?.currentTempo ?? 120) * 768) / 60 / 10_000_000;
        e["IDirectMusicPerformance8_MusicToReferenceTime"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const ahead = ((a[1]! | 0) - (perf?.engine?.musicTime ?? 0)) / ticksPerUnit(perf);
            if (a[2]) writeTime(a[2] >>> 0, Math.max(0, Math.floor(referenceTime() + ahead)));
            return S_OK;
        };
        e["IDirectMusicPerformance8_ReferenceToMusicTime"] = (_c, _m, a) => {
            const perf = perfOf(a);
            const units = (a[1]! >>> 0) + (a[2]! >>> 0) * 0x100000000;
            const ticks = (perf?.engine?.musicTime ?? 0) + (units - referenceTime()) * ticksPerUnit(perf);
            if (a[3]) Mem.writeUint32(a[3] >>> 0, Math.max(0, Math.floor(ticks)) >>> 0);
            return S_OK;
        };

        e["IDirectMusicPerformance8_CloseDown"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf) return E_POINTER;
            this.closePerformance(perf);
            return S_OK;
        };

        const audioPath = (perf: PerformanceObject | null, type: number, ppOut: number): number => {
            const path = new AudioPathObject();
            path.performance = perf;
            path.pathType = type;
            return this.publish(path, ppOut);
        };
        e["IDirectMusicPerformance8_CreateAudioPath"] = (_c, _m, a) => audioPath(perfOf(a), 0, a[3]! >>> 0);
        e["IDirectMusicPerformance8_CreateStandardAudioPath"] = (_c, _m, a) => audioPath(perfOf(a), a[1]! >>> 0, a[4]! >>> 0);
        e["IDirectMusicPerformance8_GetDefaultAudioPath"] = (_c, _m, a) => {
            const perf = perfOf(a);
            if (!perf || !a[1]) return E_POINTER;
            if (!validPointer(a[1] >>> 0, 4, "w")) return E_POINTER;
            perf.defaultAudioPath ??= new AudioPathObject();
            return this.queryInterface(perf.defaultAudioPath, IID_IUnknown, a[1] >>> 0);
        };
    }

    // ── segments ────────────────────────────────────────────────────────────────

    /** A segment object around an engine segment the HLE made itself (a motif, a band, a transition). */
    private wrapSegment(segment: PerfSegment, name: string, into?: LoadableObject): SegmentObject | null {
        if (into && !(into instanceof SegmentObject)) return null;
        const obj = into ?? new SegmentObject();
        obj.segment = segment;
        obj.identity.name = name;
        obj.loaded = true;
        return obj;
    }

    private registerSegmentExports(): void {
        const e = this.exports;
        const segOf = (a: number[]): PerfSegment | null => this.object<SegmentObject>(a[0]!)?.segment ?? null;
        const get = (name: string, read: (s: PerfSegment) => number): void => {
            e[`IDirectMusicSegment8_${name}`] = (_c, _m, a) => {
                const seg = segOf(a);
                if (!a[1]) return E_POINTER;
                Mem.writeUint32(a[1] >>> 0, seg ? read(seg) >>> 0 : 0);
                return seg ? S_OK : E_FAIL;
            };
        };
        const set = (name: string, write: (s: PerfSegment, value: number) => void): void => {
            e[`IDirectMusicSegment8_${name}`] = (_c, _m, a) => {
                const seg = segOf(a);
                if (!seg) return E_FAIL;
                write(seg, a[1]! >>> 0);
                return S_OK;
            };
        };
        get("GetLength", (s) => s.length);
        set("SetLength", (s, v) => { s.length = v | 0; });
        get("GetRepeats", (s) => s.repeats);
        set("SetRepeats", (s, v) => { s.repeats = v; });
        get("GetDefaultResolution", (s) => s.resolution);
        set("SetDefaultResolution", (s, v) => { s.resolution = v; });
        get("GetStartPoint", (s) => s.playStart);
        set("SetStartPoint", (s, v) => { s.playStart = v | 0; });
        e["IDirectMusicSegment8_SetLoopPoints"] = (_c, _m, a) => {
            const seg = segOf(a);
            if (!seg) return E_FAIL;
            seg.loopStart = a[1]! | 0;
            seg.loopEnd = a[2]! | 0;
            return S_OK;
        };
        e["IDirectMusicSegment8_GetLoopPoints"] = (_c, _m, a) => {
            const seg = segOf(a);
            if (a[1]) Mem.writeUint32(a[1] >>> 0, (seg?.loopStart ?? 0) >>> 0);
            if (a[2]) Mem.writeUint32(a[2] >>> 0, (seg?.loopEnd ?? 0) >>> 0);
            return seg ? S_OK : E_FAIL;
        };

        // HRESULT GetTrack(REFGUID rguidType, DWORD dwGroupBits, DWORD dwIndex, IDirectMusicTrack **ppTrack)
        e["IDirectMusicSegment8_GetTrack"] = (_c, _m, a) => {
            const obj = this.object<SegmentObject>(a[0]!);
            const ppTrack = a[4]! >>> 0;
            if (!obj || !ppTrack) return E_POINTER;
            const type = guidAt(a[1]! >>> 0);
            const groupBits = a[2]! >>> 0;
            let index = a[3]! >>> 0;
            for (const info of obj.tracks) {
                if (type !== GUID_NULL && info.classId !== type) continue;
                if (!(info.group & groupBits)) continue;
                if (index-- > 0) continue;
                if (!info.object || info.object.refCount === 0) {
                    const track = new TrackObject();
                    track.owner = obj;
                    track.classId = info.classId;
                    info.object = track;
                    return this.publish(track, ppTrack);
                }
                return this.queryInterface(info.object, IID_IUnknown, ppTrack);
            }
            Mem.writeUint32(ppTrack, 0);
            return DMUS_E_NOT_FOUND;
        };
        e["IDirectMusicSegment8_GetTrackGroup"] = () => DMUS_E_NOT_FOUND;

        // HRESULT SetParam(REFGUID rguidType, DWORD dwGroupBits, DWORD dwIndex, MUSIC_TIME mtTime, void *pParam)
        e["IDirectMusicSegment8_SetParam"] = (_c, _m, a) => {
            const obj = this.object<SegmentObject>(a[0]!);
            if (!obj?.segment) return E_FAIL;
            const type = guidAt(a[1]! >>> 0);
            const param = a[5]! >>> 0;
            if (type === GUID_CommandParam) {
                // DMUS_COMMAND_PARAM { BYTE bCommand, bGrooveLevel, bGrooveRange }
                const bytes = param ? Mem.readBytes(param, 3) : null;
                if (!bytes) return E_POINTER;
                const time = a[4]! | 0;
                const edit: [number, number, number] = [bytes[0]!, bytes[1]!, bytes[2]!];
                if (!obj.segment.setCommand(time, ...edit)) return DMUS_E_TRACK_NOT_FOUND;
                if (savestatesEnabled()) {
                    obj.commandEdits.delete(time);
                    obj.commandEdits.set(time, edit);
                }
                return S_OK;
            }
            // Bands hold their instruments already; downloading them to the port is nothing more.
            if (type === GUID_Download || type === GUID_Unload) return obj.segment.bands.length > 0 ? S_OK : DMUS_E_TRACK_NOT_FOUND;
            return DMUS_E_SET_UNSUPPORTED;
        };
        e["IDirectMusicSegment8_GetParam"] = () => DMUS_E_GET_UNSUPPORTED;

        for (const name of [
            "InsertTrack", "RemoveTrack", "SetGraph", "AddNotificationType", "RemoveNotificationType",
            "SetPChannelsUsed", "SetTrackConfig", "Download", "Unload",
        ]) {
            e[`IDirectMusicSegment8_${name}`] = () => S_OK;
        }
        e["IDirectMusicSegment8_GetGraph"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicSegment8_GetAudioPathConfig"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 0); return DMUS_E_NOT_FOUND; };
        e["IDirectMusicSegment8_InitPlay"] = (_c, _m, a) => { if (a[1]) Mem.writeUint32(a[1] >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicSegment8_Clone"] = (_c, _m, a) => { if (a[3]) Mem.writeUint32(a[3] >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicSegment8_Compose"] = (_c, _m, a) => { if (a[4]) Mem.writeUint32(a[4] >>> 0, 0); return E_NOTIMPL; };
    }

    private registerTrackExports(): void {
        const e = this.exports;
        const supported = (track: TrackObject | null, type: string): boolean =>
            !!track && track.classId === CLSID_DirectMusicBandTrack && (type === GUID_Download || type === GUID_Unload);
        // HRESULT IsParamSupported(REFGUID rguidType)
        e["IDirectMusicTrack_IsParamSupported"] = (_c, _m, a) =>
            supported(this.object<TrackObject>(a[0]!), guidAt(a[1]! >>> 0)) ? S_OK : DMUS_E_SET_UNSUPPORTED;
        // HRESULT SetParam(REFGUID rguidType, MUSIC_TIME mtTime, void *pParam)
        e["IDirectMusicTrack_SetParam"] = (_c, _m, a) =>
            supported(this.object<TrackObject>(a[0]!), guidAt(a[1]! >>> 0)) ? S_OK : DMUS_E_SET_UNSUPPORTED;
        e["IDirectMusicTrack_GetParam"] = () => DMUS_E_GET_UNSUPPORTED;
        for (const name of ["Init", "EndPlay", "AddNotificationType", "RemoveNotificationType"]) {
            e[`IDirectMusicTrack_${name}`] = () => S_OK;
        }
        // The performance plays a segment's tracks itself; they are not driven one by one.
        e["IDirectMusicTrack_InitPlay"] = (_c, _m, a) => { if (a[3]) Mem.writeUint32(a[3] >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicTrack_Play"] = () => E_NOTIMPL;
        e["IDirectMusicTrack_Clone"] = (_c, _m, a) => { if (a[3]) Mem.writeUint32(a[3] >>> 0, 0); return E_NOTIMPL; };
    }

    private registerSegmentStateExports(): void {
        const e = this.exports;
        const stateOf = (a: number[]): SegmentStateObject | null => this.object<SegmentStateObject>(a[0]!);
        const get = (name: string, read: (s: PerfSegmentState) => number): void => {
            e[`IDirectMusicSegmentState8_${name}`] = (_c, _m, a) => {
                const state = stateOf(a)?.state;
                if (!a[1]) return E_POINTER;
                Mem.writeUint32(a[1] >>> 0, state ? read(state) >>> 0 : 0);
                return S_OK;
            };
        };
        get("GetRepeats", (s) => s.repeatsLeft);
        get("GetStartTime", (s) => Number.isFinite(s.startTime) ? Math.floor(s.startTime) : 0);
        get("GetSeek", (s) => s.started ? Math.max(0, Math.floor(s.patternStart)) : 0);
        get("GetStartPoint", (s) => s.segment.playStart);
        // HRESULT GetSegment(IDirectMusicSegment **ppSegment)
        e["IDirectMusicSegmentState8_GetSegment"] = (_c, _m, a) => {
            const seg = stateOf(a)?.segment;
            if (!a[1]) return E_POINTER;
            if (!seg || seg.refCount === 0) {
                Mem.writeUint32(a[1] >>> 0, 0);
                return DMUS_E_NOT_FOUND;
            }
            return this.queryInterface(seg, IID_IUnknown, a[1] >>> 0);
        };
        e["IDirectMusicSegmentState8_SetTrackConfig"] = () => S_OK;
        e["IDirectMusicSegmentState8_GetObjectInPath"] = (_c, _m, a) => {
            const output = this.object<SegmentStateObject>(a[0]!)?.state?.output;
            return this.objectInPath(output instanceof AudioPathObject ? output : null, a);
        };
    }

    // ── styles, bands, collections ──────────────────────────────────────────────

    private registerStyleExports(): void {
        const e = this.exports;
        const styleOf = (a: number[]): StyleObject | null => this.object<StyleObject>(a[0]!);
        const made = (owner: StyleObject, source: MadeSource, ppOut: number): number => {
            const obj = this.makeFrom(owner, source);
            return obj ? this.publish(obj, ppOut) : E_FAIL;
        };
        // HRESULT GetMotif(WCHAR *pwszName, IDirectMusicSegment **ppSegment)
        e["IDirectMusicStyle8_GetMotif"] = (_c, _m, a) => {
            const obj = styleOf(a);
            const ppSegment = a[2]! >>> 0;
            if (!obj?.style || !ppSegment) return E_POINTER;
            const name = readWide(a[1]! >>> 0, DESC_NAME_CHARS).toLowerCase();
            const index = obj.style.motifs.findIndex((m) => m.name.toLowerCase() === name);
            if (index < 0) {
                Mem.writeUint32(ppSegment, 0);
                return S_FALSE;
            }
            return made(obj, { made: "motif", index }, ppSegment);
        };
        e["IDirectMusicStyle8_EnumMotif"] = (_c, _m, a) => {
            const motif = styleOf(a)?.style?.motifs[a[1]! >>> 0];
            if (!motif) return S_FALSE;
            if (a[2]) writeWide(a[2] >>> 0, motif.name, DESC_NAME_CHARS);
            return S_OK;
        };
        e["IDirectMusicStyle8_GetBand"] = (_c, _m, a) => {
            const obj = styleOf(a);
            const ppBand = a[2]! >>> 0;
            if (!obj?.style || !ppBand) return E_POINTER;
            const name = readWide(a[1]! >>> 0, DESC_NAME_CHARS).toLowerCase();
            const index = obj.style.bands.findIndex((b) => b.identity.name.toLowerCase() === name);
            if (index < 0) {
                Mem.writeUint32(ppBand, 0);
                return S_FALSE;
            }
            return made(obj, { made: "style-band", index }, ppBand);
        };
        e["IDirectMusicStyle8_EnumBand"] = (_c, _m, a) => {
            const band = styleOf(a)?.style?.bands[a[1]! >>> 0];
            if (!band) return S_FALSE;
            if (a[2]) writeWide(a[2] >>> 0, band.identity.name, DESC_NAME_CHARS);
            return S_OK;
        };
        e["IDirectMusicStyle8_GetDefaultBand"] = (_c, _m, a) => {
            const obj = styleOf(a);
            if (!obj?.style || !a[1]) return E_POINTER;
            if (obj.bands.length === 0) {
                Mem.writeUint32(a[1] >>> 0, 0);
                return S_FALSE;
            }
            return made(obj, { made: "style-band", index: 0 }, a[1] >>> 0);
        };
        // HRESULT GetTimeSignature(DMUS_TIMESIGNATURE *pTimeSig): mtTime, then the three fields.
        e["IDirectMusicStyle8_GetTimeSignature"] = (_c, _m, a) => {
            const style = styleOf(a)?.style;
            if (!style || !a[1]) return E_POINTER;
            const p = a[1] >>> 0;
            Mem.writeUint32(p, 0);
            Mem.writeUint8(p + 4, style.timeSig.beatsPerMeasure);
            Mem.writeUint8(p + 5, style.timeSig.beat);
            Mem.writeUint16(p + 6, style.timeSig.gridsPerBeat);
            return S_OK;
        };
        e["IDirectMusicStyle8_GetTempo"] = (_c, _m, a) => {
            const style = styleOf(a)?.style;
            if (!style || !a[1]) return E_POINTER;
            Mem.writeFloat64(a[1] >>> 0, style.tempo);
            return S_OK;
        };
        // HRESULT GetEmbellishmentLength(DWORD dwType, DWORD dwLevel, DWORD *pdwMin, DWORD *pdwMax)
        e["IDirectMusicStyle8_GetEmbellishmentLength"] = (_c, _m, a) => {
            const style = styleOf(a)?.style;
            if (!style) return E_POINTER;
            const level = a[2]! >>> 0;
            const lengths = style.patterns
                .filter((p) => (a[1] ? (p.embellishment & a[1]) !== 0 : p.embellishment === 0) && level >= p.grooveBottom && level <= p.grooveTop)
                .map((p) => p.measures);
            if (a[3]) Mem.writeUint32(a[3] >>> 0, lengths.length ? Math.min(...lengths) : 0);
            if (a[4]) Mem.writeUint32(a[4] >>> 0, lengths.length ? Math.max(...lengths) : 0);
            return lengths.length ? S_OK : S_FALSE;
        };
        for (const name of ["GetDefaultChordMap", "GetChordMap"]) {
            e[`IDirectMusicStyle8_${name}`] = (_c, _m, a) => {
                const pp = name === "GetChordMap" ? a[2] : a[1];
                if (pp) Mem.writeUint32(pp >>> 0, 0);
                return S_FALSE;
            };
        }
        e["IDirectMusicStyle8_EnumChordMap"] = () => S_FALSE;
        e["IDirectMusicStyle8_EnumPattern"] = () => S_FALSE;
    }

    private registerBandExports(): void {
        const e = this.exports;
        // HRESULT CreateSegment(IDirectMusicSegment **ppSegment)
        e["IDirectMusicBand_CreateSegment"] = (_c, _m, a) => {
            const obj = this.object<BandObject>(a[0]!);
            if (!obj?.band || !a[1]) return E_POINTER;
            const segment = this.makeFrom(obj, { made: "band-segment" });
            return segment ? this.publish(segment, a[1] >>> 0) : E_FAIL;
        };
        // A band's instruments are resolved when it loads; the port needs nothing sent to it.
        e["IDirectMusicBand_Download"] = (_c, _m, a) => this.object<BandObject>(a[0]!)?.band ? S_OK : DMUS_E_NOT_INIT;
        e["IDirectMusicBand_Unload"] = () => S_OK;
    }

    private registerCollectionExports(): void {
        const e = this.exports;
        const collectionOf = (a: number[]): DlsCollection | null => this.object<CollectionObject>(a[0]!)?.collection ?? null;
        // HRESULT GetInstrument(DWORD dwPatch, IDirectMusicInstrument **ppInstrument)
        e["IDirectMusicCollection_GetInstrument"] = (_c, _m, a) => {
            if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
            return DMUS_E_NOT_FOUND;
        };
        // HRESULT EnumInstrument(DWORD dwIndex, DWORD *pdwPatch, LPWSTR pwszName, DWORD dwNameLen)
        e["IDirectMusicCollection_EnumInstrument"] = (_c, _m, a) => {
            const inst = collectionOf(a)?.instruments[a[1]! >>> 0];
            if (!inst) return S_FALSE;
            // A patch is the program with the bank's two halves and the drum bit around it.
            const patch = ((inst.program & 0x7f) | ((inst.bank & 0x7f) << 8) | (((inst.bank >>> 8) & 0x7f) << 16)
                | (inst.bank & 0x80000000)) >>> 0;
            if (a[2]) Mem.writeUint32(a[2] >>> 0, patch);
            if (a[3] && a[4]) writeWide(a[3] >>> 0, inst.name, a[4] >>> 0);
            return S_OK;
        };
    }

    private registerAudioPathExports(): void {
        const e = this.exports;
        // The caller QIs the returned object (usually for IDirectSoundBuffer to set volume);
        // an audio path here has no buffer of its own to hand back.
        e["IDirectMusicAudioPath_GetObjectInPath"] = (_c, _m, a) => this.objectInPath(this.object<AudioPathObject>(a[0]!), a);
        e["IDirectMusicAudioPath_Activate"] = () => S_OK;
        e["IDirectMusicAudioPath_SetVolume"] = (_c, _m, a) => {
            const path = this.object<AudioPathObject>(a[0]!);
            if (!path) return E_POINTER;
            if (path.buffer) this.callBuffer(path.buffer, "idirectsoundbuffer8_setvolume", [a[1]! | 0]);
            return S_OK;
        };
        e["IDirectMusicAudioPath_ConvertPChannel"] = (_c, _m, a) => { Mem.writeUint32(a[2]! >>> 0, a[1]! >>> 0); return S_OK; };
    }

    // ── composer ────────────────────────────────────────────────────────────────

    private registerComposerExports(): void {
        const e = this.exports;
        // Composing from a template or a shape needs chord maps, which no title we run supplies.
        e["IDirectMusicComposer8_ComposeSegmentFromTemplate"] = (_c, _m, a) => { Mem.writeUint32(a[5]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicComposer8_ComposeSegmentFromShape"] = (_c, _m, a) => { Mem.writeUint32(a[8]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicComposer8_ComposeTransition"] = (_c, _m, a) => { Mem.writeUint32(a[7]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicComposer8_ComposeTemplateFromShape"] = (_c, _m, a) => { Mem.writeUint32(a[6]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicComposer8_ChangeChordMap"] = () => S_OK;

        // HRESULT AutoTransition(IDirectMusicPerformance *pPerformance, IDirectMusicSegment *pToSeg,
        //     WORD wCommand, DWORD dwFlags, IDirectMusicChordMap *pChordMap,
        //     IDirectMusicSegment **ppTransSeg, IDirectMusicSegmentState **ppToSegState,
        //     IDirectMusicSegmentState **ppTransSegState)
        e["IDirectMusicComposer8_AutoTransition"] = (_c, _m, a) => {
            const [ppTransSeg, ppToState, ppTransState] = [a[6]! >>> 0, a[7]! >>> 0, a[8]! >>> 0];
            for (const pp of [ppTransSeg, ppToState, ppTransState]) if (pp && !validPointer(pp, 4, "w")) return E_POINTER;
            for (const pp of [ppTransSeg, ppToState, ppTransState]) if (pp) Mem.writeUint32(pp, 0);
            const perf = this.object<PerformanceObject>(a[1]!);
            if (!perf) return E_POINTER;
            if (!perf.engine) return DMUS_E_NOT_INIT;
            const to = a[2] ? this.object<SegmentObject>(a[2]) : null;
            if (a[2] && !to?.segment) return E_INVALIDARG;
            const fromState = perf.engine.primaryState();
            const from = fromState ? perf.stateObjects.get(fromState)?.segment ?? null : null;
            const result = perf.engine.autoTransition(to?.segment ?? null, a[3]! & 0xffff, a[4]! >>> 0);
            const saving = savestatesEnabled();
            if (result.transition && result.transitionState) {
                // The transition segment is a COM object only for a caller that takes it.
                const transition = ppTransSeg || saving ? this.wrapSegment(result.transition, "Transition") : null;
                const style = result.transition.styles[0]!.style;
                const index = from?.segment?.fixedPattern?.style === style ? FIXED_STYLE
                    : from?.segment?.styles.findIndex((item) => item.style === style) ?? -1;
                if (saving && transition && from && from.segment === fromState?.segment && index !== -1) {
                    const command = result.transition.commands![0]!;
                    this.madeBy(transition, from, {
                        made: "transition", style: index, tempo: result.transition.tempos[0]!.tempo, command: command.command,
                        grooveLevel: command.grooveLevel,
                    });
                }
                if (saving && transition) this.holdStateSegment(this.stateObject(perf, result.transitionState), transition);
                if (transition && ppTransSeg) this.publish(transition, ppTransSeg);
                else transition?.release();
                this.publishState(perf, result.transitionState, transition, ppTransState);
            }
            if (saving && result.toState && to) this.holdStateSegment(this.stateObject(perf, result.toState), to);
            this.publishState(perf, result.toState, to, ppToState);
            if (saving) this.releaseEndedStates(perf);
            return S_OK;
        };
    }

    // ── IDirectMusic and its port ───────────────────────────────────────────────

    private registerDirectMusicExports(): void {
        const e = this.exports;
        // HRESULT EnumPort(DWORD dwIndex, LPDMUS_PORTCAPS pPortCaps): one port, the software synth.
        e["IDirectMusic8_EnumPort"] = (_c, _m, a) => {
            if (!a[2]) return E_POINTER;
            if (a[1]! >>> 0 !== 0) return S_FALSE;
            return this.writePortCaps(a[2] >>> 0);
        };
        // HRESULT CreatePort(REFCLSID rclsidPort, LPDMUS_PORTPARAMS pPortParams,
        //                    LPDIRECTMUSICPORT *ppPort, LPUNKNOWN pUnkOuter)
        e["IDirectMusic8_CreatePort"] = (_c, _m, a) => {
            const dm = this.object<DirectMusicObject>(a[0]!);
            const params = a[2]! >>> 0;
            const ppPort = a[3]! >>> 0;
            if (!dm || !validPointer(ppPort, 4, "w")) return E_POINTER;
            if (params && !validPointer(params, 32, "rw")) return E_POINTER;
            if (params && (Mem.readUint32(params) ?? 0) < 32) return E_INVALIDARG;
            // DMUS_PORTPARAMS { dwSize, dwValidParams, dwVoices, dwChannelGroups, dwAudioChannels,
            //                   dwSampleRate, dwEffectFlags, fShare }
            const valid = params ? (Mem.readUint32(params + 4) ?? 0) : 0;
            const pick = (flag: number, offset: number, fallback: number): number =>
                valid & flag ? (Mem.readUint32(params + offset) ?? fallback) : fallback;
            const voices = Math.min(256, Math.max(1, pick(DMUS_PORTPARAMS_VOICES, 8, 32)));
            const groups = Math.max(1, pick(DMUS_PORTPARAMS_CHANNELGROUPS, 12, 1));
            const channels = pick(DMUS_PORTPARAMS_AUDIOCHANNELS, 16, 2) === 1 ? 1 : 2;
            const requested = pick(DMUS_PORTPARAMS_SAMPLERATE, 20, 22050);
            const sampleRate = requested >= 44100 ? 44100 : requested <= 11025 ? 11025 : 22050;
            const port = this.createPort(dm, sampleRate, channels, voices);
            port.channelGroups = groups;
            if (params) {
                // The caller reads back what it was given, which need not be what it asked for.
                Mem.writeUint32(params + 4, valid | DMUS_PORTPARAMS_VOICES | DMUS_PORTPARAMS_CHANNELGROUPS
                    | DMUS_PORTPARAMS_AUDIOCHANNELS | DMUS_PORTPARAMS_SAMPLERATE);
                Mem.writeUint32(params + 8, voices);
                Mem.writeUint32(params + 12, groups);
                Mem.writeUint32(params + 16, channels);
                Mem.writeUint32(params + 20, sampleRate);
                Mem.writeUint32(params + 24, 0);
            }
            return this.publish(port, ppPort);
        };
        // HRESULT Activate(BOOL fEnable): every port made from this object.
        e["IDirectMusic8_Activate"] = (_c, _m, a) => {
            const dm = this.object<DirectMusicObject>(a[0]!);
            if (!dm) return E_POINTER;
            for (const port of dm.ports) this.activatePort(port, !!a[1]);
            return S_OK;
        };
        e["IDirectMusic8_GetDefaultPort"] = (_c, _m, a) => {
            if (a[1]) Mem.writeBytes(a[1] >>> 0, guidBytes(CLSID_DirectMusicSynth));
            return S_OK;
        };
        e["IDirectMusic8_SetDirectSound"] = (_c, _m, a) => {
            const dm = this.object<DirectMusicObject>(a[0]!);
            if (dm) this.setDirectSound(dm, a[1]! >>> 0);
            return S_OK;
        };
        e["IDirectMusic8_CreateMusicBuffer"] = (_c, _m, a) => { Mem.writeUint32(a[2]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusic8_EnumMasterClock"] = () => S_FALSE;
        e["IDirectMusic8_GetMasterClock"] = (_c, _m, a) => {
            if (a[1]) Mem.writeBytes(a[1] >>> 0, new Uint8Array(16));   // GUID_NULL
            if (a[2]) Mem.writeUint32(a[2] >>> 0, 0);
            return S_OK;
        };
        e["IDirectMusic8_SetMasterClock"] = () => S_OK;
        e["IDirectMusic8_SetExternalMasterClock"] = () => S_OK;
    }

    /** DMUS_PORTCAPS of the software synthesizer, sized as the caller declared. */
    private writePortCaps(ptr: number): number {
        const declared = Mem.readUint32(ptr) ?? 0;
        if (declared < 52 || declared > DMUS_PORTCAPS_SIZE) return E_INVALIDARG;
        if (!validPointer(ptr, declared, "rw")) return E_POINTER;
        const size = declared;
        const buf = new Uint8Array(size);
        const view = new DataView(buf.buffer);
        view.setUint32(0, size, true);
        view.setUint32(4, DMUS_PC_DLS | DMUS_PC_SOFTWARESYNTH | DMUS_PC_DIRECTSOUND | DMUS_PC_SHAREABLE, true);
        buf.set(guidBytes(CLSID_DirectMusicSynth), 8);
        view.setUint32(24, DMUS_PC_OUTPUTCLASS, true);
        view.setUint32(28, DMUS_PORT_USER_MODE_SYNTH, true);
        view.setUint32(32, DMUS_PC_SYSTEMMEMORY, true);
        view.setUint32(36, 1000, true);   // dwMaxChannelGroups
        view.setUint32(40, 256, true);    // dwMaxVoices
        view.setUint32(44, 2, true);      // dwMaxAudioChannels
        view.setUint32(48, 0, true);      // dwEffectFlags: no reverb
        for (let i = 0; i < SYNTH_DESCRIPTION.length && 52 + i * 2 + 1 < size; i++) {
            view.setUint16(52 + i * 2, SYNTH_DESCRIPTION.charCodeAt(i), true);
        }
        return Mem.writeBytes(ptr, buf) ? S_OK : E_POINTER;
    }

    private registerPortExports(): void {
        const e = this.exports;
        const portOf = (a: number[]): PortObject | null => this.object<PortObject>(a[0]!);
        for (const name of [
            "PlayBuffer", "SetReadNotificationHandle", "Read", "UnloadInstrument", "Compact",
            "SetChannelPriority", "DeviceIoControl",
        ]) {
            e[`IDirectMusicPort_${name}`] = () => S_OK;
        }
        e["IDirectMusicPort_DownloadInstrument"] = (_c, _m, a) => { Mem.writeUint32(a[2]! >>> 0, 0); return E_NOTIMPL; };
        e["IDirectMusicPort_GetLatencyClock"] = (_c, _m, a) => { Mem.writeUint32(a[1]! >>> 0, 0); return E_NOTIMPL; };
        // DMUS_SYNTHSTATS { dwSize, dwValidStats, dwVoices, dwTotalCPU, dwCPUPerVoice, dwLostNotes, dwFreeMemory, lPeakVolume }
        e["IDirectMusicPort_GetRunningStats"] = (_c, _m, a) => {
            const port = portOf(a);
            const ptr = a[1]! >>> 0;
            if (!port || !validPointer(ptr, DMUS_SYNTHSTATS_SIZE, "rw")) return E_POINTER;
            if ((Mem.readUint32(ptr) ?? 0) < DMUS_SYNTHSTATS_SIZE) return E_INVALIDARG;
            const buf = new Uint8Array(DMUS_SYNTHSTATS_SIZE);
            const view = new DataView(buf.buffer);
            view.setUint32(0, DMUS_SYNTHSTATS_SIZE, true);
            view.setUint32(4, 0x01 | 0x10, true);   // DMUS_SYNTHSTATS_VOICES | DMUS_SYNTHSTATS_FREE_MEMORY
            view.setUint32(8, port.synth.activeVoiceCount, true);
            view.setUint32(24, DMUS_PC_SYSTEMMEMORY, true);
            return Mem.writeBytes(ptr, buf) ? S_OK : E_POINTER;
        };
        e["IDirectMusicPort_GetCaps"] = (_c, _m, a) => a[1] ? this.writePortCaps(a[1] >>> 0) : E_POINTER;
        e["IDirectMusicPort_SetNumChannelGroups"] = (_c, _m, a) => {
            const port = portOf(a);
            if (port) port.channelGroups = Math.max(1, a[1]! >>> 0);
            return S_OK;
        };
        e["IDirectMusicPort_GetNumChannelGroups"] = (_c, _m, a) => {
            Mem.writeUint32(a[1]! >>> 0, portOf(a)?.channelGroups ?? 1);
            return S_OK;
        };
        e["IDirectMusicPort_GetChannelPriority"] = (_c, _m, a) => { Mem.writeUint32(a[3]! >>> 0, 0); return S_OK; };
        // HRESULT Activate(BOOL fActive)
        e["IDirectMusicPort_Activate"] = (_c, _m, a) => {
            const port = portOf(a);
            if (!port) return E_POINTER;
            return this.activatePort(port, !!a[1]) ? S_OK : E_FAIL;
        };
        // HRESULT SetDirectSound(LPDIRECTSOUND pDirectSound, LPDIRECTSOUNDBUFFER pDirectSoundBuffer)
        // The buffer, when given, is where the synth renders from the next activation on.
        e["IDirectMusicPort_SetDirectSound"] = (_c, _m, a) => {
            const port = portOf(a);
            if (!port) return E_POINTER;
            const wasActive = port.active;
            if (wasActive) this.activatePort(port, false);
            this.setDirectSound(port, a[1]! >>> 0);
            // Take the new reference first: a caller may set the same buffer again.
            soundReference(this.process, a[2]! >>> 0, true, true);
            this.releasePortOutput(port);
            port.buffer = a[2]! >>> 0;
            port.ownsBuffer = false;
            if (wasActive) this.activatePort(port, true);
            return S_OK;
        };
        // HRESULT GetFormat(LPWAVEFORMATEX pWaveFormatEx, LPDWORD pdwWaveFormatExSize, LPDWORD pdwBufferSize)
        e["IDirectMusicPort_GetFormat"] = (_c, _m, a) => {
            const port = portOf(a);
            if (!port) return E_POINTER;
            const [format, formatSize, bufferSize] = [a[1]! >>> 0, a[2]! >>> 0, a[3]! >>> 0];
            const WAVEFORMATEX_SIZE = 18;
            if ((formatSize && !validPointer(formatSize, 4, "rw"))
                || (bufferSize && !validPointer(bufferSize, 4, "w"))
                || (format && (!formatSize || !validPointer(format, WAVEFORMATEX_SIZE, "w")))) return E_POINTER;
            if (format && formatSize) {
                if ((Mem.readUint32(formatSize) ?? 0) < WAVEFORMATEX_SIZE) return E_INVALIDARG;
                writeWaveFormat(format, port.audioChannels, port.sampleRate);
            }
            if (formatSize) Mem.writeUint32(formatSize, WAVEFORMATEX_SIZE);
            if (bufferSize) Mem.writeUint32(bufferSize, sinkBufferBytes(port.audioChannels, port.sampleRate));
            return S_OK;
        };
    }

    // ── output ──────────────────────────────────────────────────────────────────

    /** Start or stop a port's output. Activating a port with no buffer gives it one of its own. */
    private activatePort(port: PortObject, active: boolean): boolean {
        if (port.active === active) return true;
        if (!active) {
            port.active = false;
            port.sink?.stop();
            port.synth.silence();
            if (![...this.ports].some((p) => p.active) && this.pathOutputs.size === 0) this.stopPump();
            return true;
        }
        if (!port.sink) {
            if (!port.buffer) {
                port.buffer = createSinkBuffer(this.process, port.directSound, port.audioChannels, port.sampleRate);
                port.ownsBuffer = port.buffer !== 0;
            }
            if (!port.buffer) {
                Logger.warn(LogCategory.COM, "[DMusic] port has no DirectSound buffer to render into");
                return false;
            }
            port.sink = new DirectSoundSink(this.process, port.buffer, port.audioChannels, port.sampleRate);
        }
        if (!port.sink.start()) return false;
        port.active = true;
        this.startPump();
        return true;
    }

    private startPump(): void {
        if (this.pumpTimer !== null) return;
        const scheduler = System.getInstance().scheduler;
        if (!scheduler) return;
        // Scheduler time, not a host timer: a guest thread that spins must not starve the music.
        this.pumpTimer = scheduler.timerWheel.add(
            SYNTH_PUMP_MS, true, TimerKind.DMUSIC_SYNTH, 0, TimeService.getInstance().nowMs());
    }

    private stopPump(): void {
        if (this.pumpTimer === null) return;
        System.getInstance().scheduler?.timerWheel.cancel(this.pumpTimer);
        this.pumpTimer = null;
    }

    private pump(): void {
        const system = System.getInstance();
        if (!system.process || system.isExiting) return;
        for (const port of this.ports) {
            if (!port.active || !port.sink) continue;
            port.sink.pump((pcm, frames) => this.render(port, pcm, frames));
        }
        const skipIdle = (globalThis as { __dmusicIdlePathSkip?: boolean }).__dmusicIdlePathSkip !== false;
        for (const path of this.pathOutputs) {
            const sink = path.sink;
            if (!sink) continue;
            if (skipIdle && sink.isSilent() && !path.performance?.engine?.hasWaveOn(path)) continue;
            sink.pump((pcm, frames) => this.renderPath(path, pcm, frames));
        }
    }

    private static readonly PATH_RATE = 22050;

    private ensurePathOutput(path: AudioPathObject): boolean {
        if (path.sink) return true;
        const type = path.pathType;
        if (type !== DMUS_APATH_DYNAMIC_3D && type !== DMUS_APATH_DYNAMIC_MONO && type !== DMUS_APATH_DYNAMIC_STEREO) return false;
        const channels = type === DMUS_APATH_DYNAMIC_STEREO ? 2 : 1;
        const flags = DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLFREQUENCY | DSBCAPS_GETCURRENTPOSITION2 | DSBCAPS_GLOBALFOCUS
            | (type === DMUS_APATH_DYNAMIC_3D ? DSBCAPS_CTRL3D : DSBCAPS_CTRLPAN);
        const buffer = createSinkBuffer(this.process, path.performance?.directMusic?.directSound ?? 0, channels, DMusic.PATH_RATE, flags);
        if (!buffer) return false;
        const sink = new DirectSoundSink(this.process, buffer, channels, DMusic.PATH_RATE);
        if (!sink.start()) {
            soundReference(this.process, buffer, true, false);
            return false;
        }
        path.buffer = buffer;
        path.sink = sink;
        path.channels = channels;
        this.pathOutputs.add(path);
        this.wirePath(path);
        this.startPump();
        return true;
    }

    private wirePath(path: AudioPathObject): void {
        path.onDestroy = () => {
            const perf = path.performance;
            if (perf?.engine) {
                perf.engine.endWavesOn(path);
                this.releaseEndedStates(perf);
            }
            this.pathOutputs.delete(path);
            if (![...this.ports].some((p) => p.active) && this.pathOutputs.size === 0) this.stopPump();
            path.sink?.release();
            path.sink = null;
            if (path.buffer) soundReference(this.process, path.buffer, true, false);
            path.buffer = 0;
        };
    }

    private renderPath(path: AudioPathObject, pcm: Int16Array, frames: number): void {
        if (this.mixLeft.length < frames) {
            this.mixLeft = new Float32Array(frames);
            this.mixRight = new Float32Array(frames);
        }
        const left = this.mixLeft;
        const right = this.mixRight;
        left.fill(0, 0, frames);
        right.fill(0, 0, frames);
        const perf = path.performance;
        if (perf?.engine) {
            perf.engine.renderWaves(path, left, right, frames, DMusic.PATH_RATE);
            this.releaseEndedStates(perf);
        }
        const clamp = (v: number): number => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        if (path.channels === 1) {
            for (let i = 0; i < frames; i++) pcm[i] = clamp(Math.round((left[i]! + right[i]!) * 16383.5));
        } else {
            for (let i = 0; i < frames; i++) {
                pcm[i * 2] = clamp(Math.round(left[i]! * 32767));
                pcm[i * 2 + 1] = clamp(Math.round(right[i]! * 32767));
            }
        }
    }

    private callBuffer(buffer: number, method: string, args: number[]): number {
        const fn = this.process.getModule("dsound")?.exports[method] as ThunkImplementation | undefined;
        const mem = Mem.getView();
        if (!fn || !mem) return E_FAIL;
        const result = fn(NO_CONTEXT, mem, [buffer, ...args]);
        return typeof result === "number" ? result | 0 : E_FAIL;
    }

    private objectInPath(path: AudioPathObject | null, a: number[]): number {
        const ppObject = a[7]! >>> 0;
        if (!ppObject || !validPointer(ppObject, 4, "w")) return E_POINTER;
        Mem.writeUint32(ppObject, 0);
        if (!path || (a[2]! >>> 0) !== DMUS_PATH_BUFFER || (a[3]! >>> 0) !== 0 || (a[5]! >>> 0) !== 0) return DMUS_E_NOT_FOUND;
        if (!this.ensurePathOutput(path)) return DMUS_E_NOT_FOUND;
        const fn = this.process.getModule("dsound")?.exports["IDirectSoundBuffer8_QueryInterface"] as ThunkImplementation | undefined;
        const mem = Mem.getView();
        if (!fn || !mem) return DMUS_E_NOT_FOUND;
        const result = fn(NO_CONTEXT, mem, [path.buffer, a[6]! >>> 0, ppObject]);
        return typeof result === "number" ? result | 0 : E_FAIL;
    }

    /** Render `frames` of the port's music as interleaved 16-bit PCM. */
    private render(port: PortObject, pcm: Int16Array, frames: number): void {
        if (this.mixLeft.length < frames) {
            this.mixLeft = new Float32Array(frames);
            this.mixRight = new Float32Array(frames);
        }
        const left = this.mixLeft;
        const right = this.mixRight;
        left.fill(0, 0, frames);
        right.fill(0, 0, frames);
        const engine = port.performance?.engine;
        if (engine) engine.render(left, right, frames);
        else port.synth.render(left, right, 0, frames);
        if (port.performance) this.releaseEndedStates(port.performance);

        const clamp = (v: number): number => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        if (port.audioChannels === 1) {
            for (let i = 0; i < frames; i++) pcm[i] = clamp(Math.round((left[i]! + right[i]!) * 16383.5));
        } else {
            for (let i = 0; i < frames; i++) {
                pcm[i * 2] = clamp(Math.round(left[i]! * 32767));
                pcm[i * 2 + 1] = clamp(Math.round(right[i]! * 32767));
            }
        }
    }

    /** What is loaded and playing, for the harness. */
    describe(): unknown {
        return {
            ports: [...this.ports].map((port) => {
                const engine = port.performance?.engine ?? null;
                return {
                    active: port.active,
                    sampleRate: port.sampleRate,
                    channels: port.audioChannels,
                    buffer: port.buffer,
                    ownsBuffer: port.ownsBuffer,
                    voices: port.synth.activeVoiceCount,
                    notes: { ...port.synth.stats },
                    musicTime: engine ? Math.floor(engine.musicTime) : null,
                    tempo: engine?.currentTempo ?? null,
                    segments: engine?.activeStates().map((s) => ({
                        primary: s.primary,
                        started: s.started,
                        pattern: s.pattern?.name ?? null,
                        grooveLevel: s.grooveLevel,
                        repeatsLeft: s.repeatsLeft,
                        measure: s.started ? Math.floor((engine.musicTime - s.base) / ticksPerMeasure(s.segment.timeSig())) : null,
                    })) ?? [],
                };
            }),
            pendingMessages: this.messages.size,
        };
    }
}
