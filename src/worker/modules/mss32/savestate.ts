import { System } from "../../core/system";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { virtualCd } from "../../core/audio/virtual-cd";
import { pickDefined, savestateParticipants, stateKeys, type FieldPolicy } from "../../savestate/participant";
import { CaptureRefusal } from "../../savestate/object-codecs";
import type { SaveValue } from "../../savestate/value-codec";
import type { VfsFileHandle } from "../../runtime/filesystem/vfs";
import type { MSSContext } from "./context";
import type { MSSListener3D, MSSSample, MSSSequence, MSSStream, MSSStreamSource, MSSTimer, MSSWaveOut, RedbookHandle } from "./types";
import { convertToFloat, decodeStreamFile, parseWav, DIG_F_ADPCM_MASK } from "./audio-decode";
import { decodeRawSampleImage } from "./raw-sample-cache";
import { getBytesPerSecond, isEncodedFormat } from "./helpers";
import {
    armStreamingRing, hasStreamingRing, incrementalStreamPosition, pcmRingDataBytes, pcmRingEnded, pcmRingPlayFrame,
    resetMssRingBuffers, restorePcmRing, streamingRingBytes, streamingRingFreeBytes,
} from "./playback-engine";
import { restoreStreamingSource, refillChainRunning } from "./stream-engine";
import { armTimerPump } from "./timer";
import { ensureListener3D, writeListener3D } from "./spatial";

const DIG_PCM_SIGN = 0x0001;

export const MSS_CONTEXT_FIELDS = {
    process: 'host',
    samples: 'save', samplesById: 'derive', streams: 'save', streamsById: 'derive',
    waveOuts: 'save', fileHandles: 'transient', redbookHandles: 'save', timers: 'save', sequences: 'save', ribProviders: 'save',
    nextSampleId: 'save', nextStreamId: 'save', nextWaveOutId: 'save', nextFileHandleId: 'save', nextTimerId: 'save',
    nextRedbookId: 'save', nextSequenceId: 'save',
    initialized: 'save', digitalDriverHandle: 'save', directSoundHwnd: 'save', driverDummyBuffer: 'save', driverWaveFormat: 'save',
    driverNoopStub: 'save', driverNoopTable: 'save', driverSampleArray: 'save', driverMaxSamples: 'save', driverOutputRate: 'save',
    driverTypeTag: 'save', sampleTypeTag: 'save', driverBuildBuffer: 'save', driverDecodeBuffer: 'save',
    driverAuxBuffer1: 'save', driverAuxBuffer2: 'save', driverAuxBuffer3: 'save', provider3DNamePtrs: 'save',
    listener3D: 'save', listenerSab: 'host', speakerType3D: 'save', roomType3D: 'save', preferences: 'save',
    midiDriverHandle: 'save', midiMasterVolume: 'save', updateInterval: 'save', heartbeatTick: 'host', startupTime: 'derive',
    lastErrorPtr: 'save', lastErrorStr: 'save', memAllocatedByMss: 'save',
    pendingTimerCallbacks: 'transient', pendingEOSCallbacks: 'transient', pendingStreamCallbacks: 'transient',
    insideAilServe: 'transient', serveDepth: 'transient',
    wavFormatByDataPtr: 'save', fileCallbacks: 'save', memCallbacks: 'save',
    streamUserData: 'save', streamCallbacks: 'save', sequenceUserData: 'save', sequenceCallbacks: 'save', distanceFactor3D: 'save',
} as const satisfies Record<keyof MSSContext, FieldPolicy>;

export const MSS_SAMPLE_FIELDS = {
    id: 'save', handle: 'save', fileData: 'derive', decodedData: 'derive', streamBuffers: 'save', userData: 'save', totalBytes: 'save',
    fileFormat: 'save', sampleTypeFormat: 'save', sampleTypeFlags: 'save', sampleRate: 'save', channels: 'save', bitsPerSample: 'save',
    formatTag: 'save', blockAlign: 'save', volume: 'save', pan: 'save', playbackRate: 'save', playbackRateHz: 'save', loopCount: 'save',
    loopStartBytes: 'save', loopEndBytes: 'save', pcmBytes: 'save', isPlaying: 'save', isStopped: 'save', position: 'save',
    pendingStart: 'save', fileDataAllocated: 'save', fileDataAddress: 'save', startTime: 'derive',
    lastDebugLogTime: 'transient', lastDebugPos: 'transient', lastAudioPositionTime: 'transient', lastAudioPositionBytes: 'transient',
    lastRingCursorBytes: 'transient', lastRingCursorTime: 'transient', encodedDurationMs: 'save',
    is3D: 'save', pos3D: 'save', vel3D: 'save', minDist3D: 'save', maxDist3D: 'save', mode3D: 'save', cone3D: 'save',
} as const satisfies Record<keyof MSSSample, FieldPolicy>;

export const MSS_STREAM_FIELDS = {
    id: 'save', handle: 'save', fileData: 'derive', decodedData: 'derive', filename: 'save', fileFormat: 'save', sampleRate: 'save',
    channels: 'save', bitsPerSample: 'save', formatTag: 'save', blockAlign: 'save', streamMemory: 'save', volume: 'save', pan: 'save',
    playbackRate: 'save', playbackRateHz: 'save', loopCount: 'save', pcmBytes: 'save', streamDummyBuffer: 'save', isPlaying: 'save',
    isPaused: 'save', position: 'save', pendingStart: 'save', startTime: 'derive', lastAudioPositionTime: 'transient',
    lastAudioPositionBytes: 'transient', encodedDurationMs: 'save', source: 'derive',
} as const satisfies Record<keyof MSSStream, FieldPolicy>;

export const MSS_STREAM_SOURCE_FIELDS = {
    kind: 'save', fileHandle: 'save', scratch: 'save', vfsHandle: 'host', fileSize: 'save', info: 'save', blockBytes: 'save',
    framesPerBlock: 'save', dataStart: 'save', dataEnd: 'save', totalFrames: 'save', readOffset: 'derive', cursor: 'transient',
    framesDecoded: 'derive', busy: 'transient', exhausted: 'derive', endReported: 'save', pending: 'transient',
} as const satisfies Record<keyof MSSStreamSource, FieldPolicy>;

export const MSS_TIMER_FIELDS = {
    handle: 'save', callback: 'save', user: 'save', freq: 'save', period: 'save', active: 'save', timerId: 'save',
    inFlight: 'transient', pumpOnReturn: 'host',
} as const satisfies Record<keyof MSSTimer, FieldPolicy>;

export const MSS_SEQUENCE_FIELDS = {
    handle: 'save', status: 'save', volume: 'save', loopCount: 'save', tempo: 'save',
} as const satisfies Record<keyof MSSSequence, FieldPolicy>;

export const MSS_REDBOOK_FIELDS = {
    id: 'save', volume: 'save', playToken: 'transient',
} as const satisfies Record<keyof RedbookHandle, FieldPolicy>;

export const MSS_WAVEOUT_FIELDS = {
    handle: 'save', deviceId: 'save', preparedHeaders: 'save',
} as const satisfies Record<keyof MSSWaveOut, FieldPolicy>;

const CONTEXT_SCALARS = [
    'nextSampleId', 'nextStreamId', 'nextWaveOutId', 'nextFileHandleId', 'nextTimerId', 'nextRedbookId', 'nextSequenceId',
    'initialized', 'digitalDriverHandle', 'directSoundHwnd', 'driverDummyBuffer', 'driverWaveFormat', 'driverNoopStub',
    'driverNoopTable', 'driverSampleArray', 'driverMaxSamples', 'driverOutputRate', 'driverTypeTag', 'sampleTypeTag',
    'driverBuildBuffer', 'driverDecodeBuffer', 'driverAuxBuffer1', 'driverAuxBuffer2', 'driverAuxBuffer3',
    'speakerType3D', 'roomType3D', 'midiDriverHandle', 'midiMasterVolume', 'lastErrorPtr', 'lastErrorStr', 'distanceFactor3D',
] as const satisfies readonly (keyof MSSContext)[];
type ContextScalars = Pick<MSSContext, typeof CONTEXT_SCALARS[number]>;

type SavedKeys<P> = { [K in keyof P]: P[K] extends 'save' ? K : never }[keyof P];
type SampleFields = Pick<MSSSample, SavedKeys<typeof MSS_SAMPLE_FIELDS>>;
type StreamFields = Pick<MSSStream, SavedKeys<typeof MSS_STREAM_FIELDS>>;
type SourceFields = Pick<MSSStreamSource, SavedKeys<typeof MSS_STREAM_SOURCE_FIELDS>>;
type TimerFields = Pick<MSSTimer, SavedKeys<typeof MSS_TIMER_FIELDS>>;

export type MssImageState = null | { at: number; length: number } | { bytes: Uint8Array };
export type MssDecodeRule = 'none' | 'raw' | 'pcm' | 'wav' | 'saved';

export interface MssSampleState {
    fields: SampleFields;
    image: MssImageState;
    decode: MssDecodeRule;
    decoded: Float32Array | null;
    playFrame: number;
    ended: boolean;
}

export interface MssStreamState {
    fields: StreamFields;
    loaded: boolean;
    source: SourceFields | null;
    playFrame: number;
    ended: boolean;
}

export interface MssState {
    scalars: ContextScalars;
    startupAgeMs: number;
    heartbeat: number | null;
    preferences: number[];
    provider3DNamePtrs: number[];
    listener3D: MSSListener3D | null;
    samples: MssSampleState[];
    streams: MssStreamState[];
    timers: TimerFields[];
    sequences: MSSSequence[];
    redbook: Array<{ id: number; volume: number }>;
    waveOuts: Array<{ handle: number; deviceId: number; preparedHeaders: Array<[number, { ptr: number; len: number; flags: number }]> }>;
    ribProviders: Array<{ handle: number; module: number; interfaces: Array<[string, { entryCount: number; entries: number[] }]> }>;
    memAllocatedByMss: number[];
    wavFormatByDataPtr: Array<[number, number]>;
    fileCallbacks: { open: number; close: number; seek: number; read: number } | null;
    memCallbacks: { malloc: number; free: number };
    streamUserData: Array<[number, number[]]>;
    streamCallbacks: Array<[number, number]>;
    sequenceUserData: Array<[number, number[]]>;
    sequenceCallbacks: Array<[number, number]>;
}

export const MSS_SCHEMA = {
    context: MSS_CONTEXT_FIELDS, sample: MSS_SAMPLE_FIELDS, stream: MSS_STREAM_FIELDS, source: MSS_STREAM_SOURCE_FIELDS,
    timer: MSS_TIMER_FIELDS, sequence: MSS_SEQUENCE_FIELDS, redbook: MSS_REDBOOK_FIELDS, waveOut: MSS_WAVEOUT_FIELDS,
    state: stateKeys<MssState>({
        scalars: true, startupAgeMs: true, heartbeat: true, preferences: true, provider3DNamePtrs: true, listener3D: true,
        samples: true, streams: true, timers: true, sequences: true, redbook: true, waveOuts: true, ribProviders: true,
        memAllocatedByMss: true, wavFormatByDataPtr: true, fileCallbacks: true, memCallbacks: true, streamUserData: true,
        streamCallbacks: true, sequenceUserData: true, sequenceCallbacks: true,
    }),
    sampleState: stateKeys<MssSampleState>({ fields: true, image: true, decode: true, decoded: true, playFrame: true, ended: true }),
    streamState: stateKeys<MssStreamState>({ fields: true, loaded: true, source: true, playFrame: true, ended: true }),
};

const STREAM_READ_ACCESS = 0x80000000;
const STREAM_OPEN_EXISTING = 3;

function sameBytes(mem: Uint8Array, at: number, data: Uint8Array): boolean {
    for (let i = 0; i < data.length; i++) if (mem[at + i] !== data[i]) return false;
    return true;
}

function sameFloats(a: Float32Array, b: Float32Array): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

type DecodeInput = Pick<MSSSample, 'fileFormat' | 'fileDataAddress' | 'channels' | 'bitsPerSample' | 'formatTag' | 'blockAlign' | 'sampleTypeFormat' | 'sampleTypeFlags'>;

function deriveDecoded(rule: 'raw' | 'pcm' | 'wav', v: DecodeInput, data: Uint8Array): { data: Uint8Array; decoded: Float32Array } | null {
    try {
        if (rule === 'raw') {
            if (v.fileFormat !== 'raw') return null;
            const image = decodeRawSampleImage(v.fileDataAddress ?? 0, data, 0, data.length, {
                channels: v.channels > 0 ? v.channels : 1,
                bits: v.bitsPerSample > 0 ? v.bitsPerSample : 8,
                signed8: ((v.sampleTypeFlags ?? 0) & DIG_PCM_SIGN) !== 0,
                adpcm: ((v.sampleTypeFormat ?? 0) & DIG_F_ADPCM_MASK) !== 0,
            });
            return { data: image.data, decoded: image.decoded };
        }
        if (rule === 'pcm') return { data, decoded: convertToFloat(data, v.channels, v.bitsPerSample, v.formatTag, v.blockAlign) };
        const wav = parseWav(data);
        return wav ? { data, decoded: convertToFloat(wav.data, wav.channels, wav.bitsPerSample, wav.formatTag, wav.blockAlign) } : null;
    } catch {
        return null;
    }
}

function elapsedStart(item: MSSSample | MSSStream): number {
    const bytesPerSec = getBytesPerSecond(item) * (item.playbackRate || 1.0);
    return performance.now() - (bytesPerSec > 0 ? (item.position / bytesPerSec) * 1000.0 : 0);
}

function captureSample(s: MSSSample, mem: Uint8Array): MssSampleState {
    const active = s.isPlaying || s.isStopped;
    if (active && isEncodedFormat(s.fileFormat)) {
        throw new Error(`mss32: sample ${s.id} plays ${s.fileFormat} data through the host decoder, which is not part of a v1 savestate`);
    }
    const ringBytes = pcmRingDataBytes(s.id);
    if (s.isPlaying && s.decodedData && ringBytes !== null && ringBytes !== s.decodedData.byteLength) {
        throw new Error(`mss32: sample ${s.id} is fed through AIL_load_sample_buffer, which is not part of a v1 savestate`);
    }
    let image: MssImageState = null;
    if (s.fileData) {
        const at = s.fileDataAddress ?? 0;
        image = at && MemoryGuard.isValidRange(mem, at, s.fileData.length) && sameBytes(mem, at, s.fileData)
            ? { at, length: s.fileData.length }
            : { bytes: s.fileData };
    }
    let decode: MssDecodeRule = 'none';
    let decoded: Float32Array | null = null;
    if (s.decodedData && s.decodedData.length > 0) {
        decode = 'saved';
        if (s.fileData) {
            for (const rule of ['raw', 'pcm', 'wav'] as const) {
                const again = deriveDecoded(rule, s, s.fileData);
                if (again && sameFloats(again.decoded, s.decodedData)) { decode = rule; break; }
            }
        }
        if (decode === 'saved') decoded = s.decodedData;
    }
    const ended = s.isPlaying && pcmRingEnded(s.id);
    return { fields: pickDefined(s, MSS_SAMPLE_FIELDS), image, decode, decoded, playFrame: s.isPlaying && !ended ? pcmRingPlayFrame(s.id) ?? 0 : 0, ended };
}

function restoreSample(ctx: MSSContext, st: MssSampleState, mem: Uint8Array): MSSSample {
    const s: MSSSample = { ...st.fields, fileData: null, decodedData: null };
    if (st.image) s.fileData = 'bytes' in st.image ? st.image.bytes : mem.slice(st.image.at, st.image.at + st.image.length);
    if (st.decode === 'saved') s.decodedData = st.decoded;
    else if (st.decode !== 'none' && s.fileData) {
        const again = deriveDecoded(st.decode, s, s.fileData);
        if (!again) throw new Error(`mss32: the sound image of sample ${s.id} no longer decodes as ${st.decode}`);
        s.fileData = again.data;
        s.decodedData = again.decoded;
    }
    if (s.isPlaying) s.startTime = elapsedStart(s);
    if (s.isPlaying || s.isStopped) restorePcmRing(ctx, s, st.playFrame, s.isPlaying && !st.ended);
    return s;
}

function streamName(s: MSSStream): string {
    return s.filename ? `"${s.filename}"` : `${s.id} (memory image)`;
}

function captureStream(ctx: MSSContext, s: MSSStream): MssStreamState {
    const src = s.source ?? null;
    if (src?.busy) throw new Error(`mss32: stream ${streamName(s)} is being refilled; try saving again`);
    if (!src && s.isPlaying && isEncodedFormat(s.fileFormat)) {
        throw new Error(`mss32: stream ${streamName(s)} plays ${s.fileFormat} data through the host decoder, which is not part of a v1 savestate`);
    }
    if (!src && s.fileData && (!s.filename || ctx.fileCallbacks)) {
        throw new Error(`mss32: stream ${streamName(s)} was read whole through the title's own file callbacks, which is not part of a v1 savestate`);
    }
    const fields = pickDefined(s, MSS_STREAM_FIELDS);
    if (!src) {
        const running = s.isPlaying && !s.isPaused;
        const ended = running && pcmRingEnded(s.id);
        return { fields, loaded: !!s.fileData, source: null, playFrame: running && !ended ? pcmRingPlayFrame(s.id) ?? 0 : 0, ended };
    }

    const source = pickDefined(src, MSS_STREAM_SOURCE_FIELDS);
    if (hasStreamingRing(s) && s.isPlaying) {
        fields.position = incrementalStreamPosition(s);
        const looping = s.loopCount === 0 || s.loopCount === -1;
        if (looping && src.totalFrames > 0) {
            const frameBytes = Math.max(1, s.channels) * 4;
            const ringBytes = streamingRingBytes(s);
            const buffered = ringBytes > 0 ? Math.max(0, ringBytes - streamingRingFreeBytes(s) - frameBytes) / frameBytes : 0;
            const played = Math.max(0, src.framesDecoded - buffered);
            if (Math.floor(src.framesDecoded / src.totalFrames) > Math.floor(played / src.totalFrames)) source.endReported = true;
        }
    }
    return { fields, loaded: false, source, playFrame: 0, ended: false };
}

async function openStreamFile(s: MSSStream): Promise<VfsFileHandle> {
    const fs = System.getInstance().fileSystem;
    const path = s.filename ?? '';
    const handle = fs.openSync(path, STREAM_READ_ACCESS, STREAM_OPEN_EXISTING) ?? await fs.open(path, STREAM_READ_ACCESS, STREAM_OPEN_EXISTING);
    if (!handle) throw new Error(`mss32: stream file "${path}" cannot be opened again`);
    return handle;
}

async function restoreStream(ctx: MSSContext, st: MssStreamState): Promise<MSSStream> {
    const s: MSSStream = { ...st.fields, fileData: null, decodedData: null, source: null };
    if (st.source) {
        let vfsHandle: VfsFileHandle | null = null;
        if (st.source.kind === 'vfs') {
            vfsHandle = await openStreamFile(s);
            const size = System.getInstance().fileSystem.getFileSize(vfsHandle.path);
            if (size !== st.source.fileSize) throw new Error(`mss32: stream file "${s.filename}" is ${size} bytes, the snapshot expects ${st.source.fileSize}`);
        }
        s.source = {
            ...st.source, vfsHandle, readOffset: st.source.dataStart, cursor: -1, framesDecoded: 0,
            busy: false, exhausted: false, pending: null,
        };
        restoreStreamingSource(s, s.position, st.source.endReported);
        armStreamingRing(ctx, s, s.isPlaying && !s.isPaused);
    } else if (st.loaded) {
        const fs = System.getInstance().fileSystem;
        const handle = await openStreamFile(s);
        const size = fs.getFileSize(handle.path);
        fs.setPosition(handle, 0, 0);
        const data = fs.readSync(handle, size, "park-preferred") ?? await fs.read(handle, size);
        if (!data || data.length === 0) throw new Error(`mss32: stream file "${s.filename}" cannot be read again`);
        s.fileData = data;
        s.pendingStart = false;
        if (!decodeStreamFile(ctx, s)) throw new Error(`mss32: stream file "${s.filename}" no longer decodes`);
        Object.assign(s, st.fields);
        if (s.isPlaying) restorePcmRing(ctx, s, st.playFrame, !s.isPaused && !st.ended);
    }
    if (s.isPlaying) s.startTime = elapsedStart(s);
    return s;
}

export function captureMssSavestate(ctx: MSSContext): MssState {
    if (ctx.insideAilServe || ctx.serveDepth > 0) throw new Error('mss32: AIL_serve is running; try saving again');
    const queued = ctx.pendingTimerCallbacks.length + ctx.pendingEOSCallbacks.length + ctx.pendingStreamCallbacks.length;
    if (queued > 0) throw new Error(`mss32: ${queued} Miles callback(s) are queued for AIL_serve; try saving again`);
    if (refillChainRunning()) throw new Error('mss32: a stream refill is running through the title\'s file callbacks; try saving again');
    if (ctx.fileHandles.size > 0) {
        const names = [...ctx.fileHandles.values()].map(h => h.path).sort();
        throw new Error(`mss32: ${names.length} file(s) open through AIL_file_open are not part of a v1 savestate: ${names.join(', ')}`);
    }
    for (const t of ctx.timers.values()) {
        if (t.inFlight) throw new Error(`mss32: the callback of Miles timer ${t.handle} is queued or running; try saving again`);
    }
    if ([...ctx.redbookHandles.values()].some(rb => rb.playToken) && virtualCd().getMode() !== 'stopped') {
        throw new Error('mss32: a CD audio track started through AIL_redbook_play is not part of a v1 savestate');
    }
    const mem = toPlainGuestMemory(ctx.process.getCurrentMemory());
    const scalars = {} as Record<string, unknown>;
    for (const key of CONTEXT_SCALARS) scalars[key] = ctx[key];
    return {
        scalars: scalars as unknown as ContextScalars,
        startupAgeMs: ctx.startupTime ? performance.now() - ctx.startupTime : -1,
        heartbeat: ctx.updateInterval ?? null,
        preferences: [...ctx.preferences],
        provider3DNamePtrs: [...ctx.provider3DNamePtrs],
        listener3D: ctx.listener3D ? { ...ctx.listener3D } : null,
        samples: [...ctx.samples.values()].map(s => captureSample(s, mem)),
        streams: [...ctx.streams.values()].map(s => captureStream(ctx, s)),
        timers: [...ctx.timers.values()].map(t => pickDefined(t, MSS_TIMER_FIELDS)),
        sequences: [...ctx.sequences.values()].map(q => ({ ...q })),
        redbook: [...ctx.redbookHandles.values()].map(rb => ({ id: rb.id, volume: rb.volume })),
        waveOuts: [...ctx.waveOuts.values()].map(w => ({ handle: w.handle, deviceId: w.deviceId, preparedHeaders: [...(w.preparedHeaders ?? [])].map(([k, h]) => [k, { ...h }] as [number, typeof h]) })),
        ribProviders: [...ctx.ribProviders].map(([handle, p]) => ({
            handle, module: p.module,
            interfaces: [...p.interfaces].map(([name, i]) => [name, { entryCount: i.entryCount, entries: [...i.entries] }] as [string, typeof i]),
        })),
        memAllocatedByMss: [...ctx.memAllocatedByMss],
        wavFormatByDataPtr: [...ctx.wavFormatByDataPtr],
        fileCallbacks: ctx.fileCallbacks ? { ...ctx.fileCallbacks } : null,
        memCallbacks: { ...ctx.memCallbacks },
        streamUserData: [...ctx.streamUserData].map(([k, v]) => [k, [...v]]),
        streamCallbacks: [...ctx.streamCallbacks],
        sequenceUserData: [...ctx.sequenceUserData].map(([k, v]) => [k, [...v]]),
        sequenceCallbacks: [...ctx.sequenceCallbacks],
    };
}

export async function restoreMssSavestate(ctx: MSSContext, s: MssState): Promise<void> {
    resetMssRingBuffers();
    Object.assign(ctx, s.scalars);
    ctx.startupTime = s.startupAgeMs < 0 ? 0 : performance.now() - s.startupAgeMs;
    ctx.updateInterval = s.heartbeat;
    ctx.preferences = [...s.preferences];
    ctx.provider3DNamePtrs = [...s.provider3DNamePtrs];
    ctx.listener3D = s.listener3D ? { ...s.listener3D } : null;
    ctx.listenerSab = null;
    if (ctx.listener3D) {
        ensureListener3D(ctx);
        writeListener3D(ctx);
    }
    ctx.fileHandles.clear();
    ctx.pendingTimerCallbacks.length = 0;
    ctx.pendingEOSCallbacks.length = 0;
    ctx.pendingStreamCallbacks.length = 0;
    ctx.insideAilServe = false;
    ctx.serveDepth = 0;
    ctx.memAllocatedByMss = new Set(s.memAllocatedByMss);
    ctx.wavFormatByDataPtr = new Map(s.wavFormatByDataPtr);
    ctx.fileCallbacks = s.fileCallbacks ? { ...s.fileCallbacks } : null;
    ctx.memCallbacks = { ...s.memCallbacks };
    ctx.streamUserData = new Map(s.streamUserData.map(([k, v]) => [k, [...v]]));
    ctx.streamCallbacks = new Map(s.streamCallbacks);
    ctx.sequenceUserData = new Map(s.sequenceUserData.map(([k, v]) => [k, [...v]]));
    ctx.sequenceCallbacks = new Map(s.sequenceCallbacks);
    ctx.sequences = new Map(s.sequences.map(q => [q.handle, { ...q }]));
    ctx.redbookHandles = new Map(s.redbook.map(rb => [rb.id, { id: rb.id, volume: rb.volume, playToken: 0 }]));
    ctx.waveOuts = new Map(s.waveOuts.map(w => [w.handle, { handle: w.handle, deviceId: w.deviceId, preparedHeaders: new Map(w.preparedHeaders.map(([k, h]) => [k, { ...h }])) }]));
    ctx.ribProviders = new Map(s.ribProviders.map(p => [p.handle, {
        module: p.module, interfaces: new Map(p.interfaces.map(([name, i]) => [name, { entryCount: i.entryCount, entries: [...i.entries] }])),
    }]));
    ctx.timers = new Map(s.timers.map(t => {
        const timer: MSSTimer = { ...t };
        if (timer.timerId) armTimerPump(timer);
        return [timer.handle, timer];
    }));

    const mem = toPlainGuestMemory(ctx.process.getCurrentMemory());
    ctx.samples = new Map();
    ctx.samplesById = new Map();
    for (const st of s.samples) {
        const sample = restoreSample(ctx, st, mem);
        ctx.samples.set(sample.handle, sample);
        ctx.samplesById.set(sample.id, sample);
    }
    ctx.streams = new Map();
    ctx.streamsById = new Map();
    for (const st of s.streams) {
        const stream = await restoreStream(ctx, st);
        ctx.streams.set(stream.handle, stream);
        ctx.streamsById.set(stream.id, stream);
    }
}

export function registerMssSavestate(ctx: MSSContext): () => void {
    return savestateParticipants.add({
        id: 'mss32', version: 1, order: 76, covers: ['mss32'], schema: MSS_SCHEMA as unknown as SaveValue,
        capture: () => {
            try {
                return captureMssSavestate(ctx) as unknown as SaveValue;
            } catch (e) {
                throw e instanceof CaptureRefusal ? e : new CaptureRefusal(e instanceof Error ? e.message : String(e));
            }
        },
        restore: (saved) => restoreMssSavestate(ctx, saved as unknown as MssState),
    });
}
