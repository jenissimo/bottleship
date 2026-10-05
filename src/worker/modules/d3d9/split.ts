/**
 * Split D3D9 — the front device's call stream to its render twin (plan/d3d9-threaded/P2-PLAN.md).
 *
 * The guest talks to the FRONT device exactly as before. Every API call it makes from outside
 * the device is also recorded, arguments serialized at call time, into the WBUF queue next to
 * the ring entries the front drained; the TWIN replays the queue through the same code at the
 * fences (Present, GPU readbacks). Both run the same class over the same stream, so their state
 * stays equal by construction; the front skips GPU work, the twin skips guest-visible effects.
 *
 * Only the API surface is wrapped (RECORDED / DELEGATED below), never internal helpers: an async
 * method's code after an `await` would otherwise record its own internals as fresh calls.
 * Every record carries the front's answer, and the twin's must match it (DIVERGENCE otherwise).
 */

import type { D3D9Device } from "../../backends/webgpu/d3d9/d3d9-device";
import { SplitEncoder, type SplitRefTable } from "../../backends/webgpu/d3d9/split-codec";
import {
    SplitReplayer, comparableAnswer, emptyReplayStats, type SplitReplayStats,
} from "../../backends/webgpu/d3d9/split-replay";
import { Logger, LogCategory } from "../../core/logger";
import { beginD3D9SplitReplay, endD3D9SplitReplay } from "./shared-state";
import { d3d9PerfMuteApi } from "./d3d9-perf";
import type { D3D9StateBlockData } from "../../backends/webgpu/d3d9/d3d9-state-block";
import type { WbufSplitClient } from "../../core/thunking/thunk-dispatcher";
import type { RemoteGpuLifecycle, SplitQueryChannel, SplitQueryResultTable } from "../../render/d3d9-remote-state";

interface SplitDispatcher {
    registerQueuePayloadHandler(handler: (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void): number;
    enqueuePayloadById(id: number, h0: number, h1: number, h2: number, h3: number,
        src: Uint8Array, srcOffset: number, byteCount: number): boolean;
    executeWbufQueue(): void;
    setWbufSplitClient(client: WbufSplitClient | null): void;
}

/**
 * The render twin in another worker (render/d3d9-render-client.ts). The front ships the queue
 * there instead of executing it; the twin's replay statistics come back asynchronously.
 */
export interface SplitRemote {
    /** Start the twin; returns the emulator-worker side of its screen. */
    createTwin(slot: number, isExtended: boolean, front: D3D9Device): RemoteTwinScreen;
    /** The twin's level-0 shadow of a texture once its readbacks settled, and `method`'s last answer. */
    fetchTexture(slot: number, texPtr: number, method: string): Promise<{ data: Uint8Array | null; answer: unknown }>;
    /** Hand over queue bytes [0, end), the split record id and the method names numbered so far. */
    ship(queue: Uint8Array, end: number, splitRecordId: number, methodNames: readonly string[]): void;
    replayStats(reset: boolean): SplitReplayStats | null;
    waitForBacklog(depth: number): Promise<void>;
    /** Query generations the worker resolved, answered from here by GetData. */
    readonly queryResults: SplitQueryResultTable;
    /** The worker's GPUDevice: the loss source of every front it renders for. */
    readonly gpuLifecycle: RemoteGpuLifecycle;
    timestampQuerySupported(): boolean;
}

/** Where a remote twin's frames land on this worker (render/d3d9-render-client.ts). */
export interface RemoteTwinScreen {
    repaintLastFrame(): void;
    getLastPresentDrawCount(): number | null;
    capturePresentedLayer(): Promise<Blob | null>;
    /** GetFrontBufferData: the presented image, read where it was rendered. */
    readPresentedRgba(): Promise<{ rgba: Uint8Array; width: number; height: number } | null>;
}

/** Frames the guest may run ahead of the render worker (`__d3d9SplitDepth`, default 2). */
function splitPresentDepth(): number {
    const v = (globalThis as { __d3d9SplitDepth?: number }).__d3d9SplitDepth;
    return typeof v === "number" && v >= 1 ? Math.floor(v) : 2;
}

export function d3d9SplitWanted(): boolean {
    // On unless a boot opts out with `false`.
    return (globalThis as { __d3d9Split?: boolean }).__d3d9Split !== false;
}

/** API calls that change device state: recorded, then replayed on the twin. */
const RECORDED = [
    "applyStateBlockData", "beginScene", "beginStateBlock", "captureStateBlockData", "clear",
    "clearTargetRects", "colorFillSurface", "configureD3D9MultisampleType", "createCubeTexture",
    "createIndexBuffer", "createPixelShader", "createTexture",
    "createVertexBuffer", "createVertexDeclaration", "createVertexShader", "drawIndexedPrimitive",
    "drawIndexedPrimitiveUP", "drawPrimitive", "drawPrimitiveUP", "endScene", "endStateBlock",
    "lightEnable", "lockCubeFace", "lockIndexBuffer", "lockTexture", "lockVertexBuffer",
    "markVolumeTextureDirty", "multiplyTransform", "noteRedundantRenderTarget", "noteRtResolve",
    "present", "presentEx", "processVertices", "readBackbufferIntoGuestTexture", "readTextureIntoGuestTexture",
    "recordQueryBegin", "recordQueryEnd", "recordQueryTimestamp", "textureReadbackForLock",
    "registerVolumeTexture", "releaseComBindings", "releaseIndexBuffer",
    "releaseTexture", "releaseVertexBuffer", "releaseVolumeTexture", "reset",
    "resyncPixelShaderShadow", "resyncVertexShaderShadow", "setBackBufferSize", "setClipPlane",
    "setCurrentTexturePalette", "setDebugToggle", "setDepthStencilSurface", "setDepthStencilTexture",
    "setDialogBoxMode", "setDrawScrub", "setFVF", "setIndices", "setLight", "setMaterial",
    "setNPatchMode", "setPaletteEntries", "setPixelShader", "setPixelShaderConstantB",
    "setPixelShaderConstantBFromArray", "setPixelShaderConstantF", "setPixelShaderConstantFFromArray",
    "setPixelShaderConstantI", "setPixelShaderConstantIFromArray", "setPresentationInterval",
    "setRenderState", "setRenderTarget", "setSamplerState", "setScissorRect",
    "setSoftwareVertexProcessing", "setStreamSource", "setStreamSourceFreq", "setSwapEffect",
    "setTexture", "setTextureLevelPixels", "setCubeFacePixels", "setTextureStageState", "setTransform",
    "setVertexDeclaration", "setVertexShader", "setVertexShaderConstantB",
    "setVertexShaderConstantBFromArray", "setVertexShaderConstantF", "setVertexShaderConstantFFromArray",
    "setVertexShaderConstantI", "setVertexShaderConstantIFromArray", "setViewport", "setViewportValues",
    "restoreViewportSnapshot",
    "stretchRect", "unlockCubeFace", "unlockIndexBuffer", "unlockTexture",
    "unlockVertexBuffer",
] as const;

/** Queries whose answer lives on the GPU side: brought current, then asked of the twin. */
const DELEGATED = [
    "captureFrame", "capturePresentedLayer", "readPresentedRgba", "repaintLastFrame", "getCounters",
    "getFrameSnapshot", "getLastPresentDrawCount", "getRtDebug", "getPassDebug", "getFrameLog",
    "getRenderSpace", "getDrawScrub", "getDebugFlags", "getDebugResourcesInfo", "getArenaDrainStats",
    "collectSubsystemPerf", "resetSubsystemPerf", "shaderCensus", "declCensus", "resetDeclCensus",
    "describeFfpShader", "getBackendExecutor", "getTexturesDebugInfo", "readTextureRgba",
    "readRenderTargetRgba", "renderTargetGallery", "getFetchAuditReport", "armFetchAudit",
    // Query results are GPU-side: GetData polls the twin's manager, brought current first.
    "getQueryManager",
] as const;

/** Calls after which the twin must be current (the front's answer or the screen needs it). */
const FENCES = new Set<string>(["present", "presentEx"]);

/** GPU readbacks: the front asks the twin for the result right after (adoptTwinReadback), so the
 *  call must reach it now — but only when it started one (a Promise): LockRect asks
 *  textureReadbackForLock of every texture and gets null for all but render targets. */
const READBACK_FENCES = new Set<string>([
    "readTextureIntoGuestTexture", "readBackbufferIntoGuestTexture", "textureReadbackForLock", "stretchRect",
]);

type Args = unknown[];
/** Rewrites a call whose arguments point into guest memory into one that carries the bytes.
 *  Runs BEFORE the front executes (lock state it reads is cleared by the call). */
type Transform = (front: D3D9Device, args: Args) => [string, Args] | null;

const f32 = (mem: Uint8Array, ptr: number, count: number): Float32Array =>
    new Float32Array(mem.slice(ptr, ptr + count * 4).buffer);
const i32 = (mem: Uint8Array, ptr: number, count: number): Int32Array =>
    new Int32Array(mem.slice(ptr, ptr + count * 4).buffer);

const TRANSFORMS: Record<string, Transform> = {
    unlockVertexBuffer: (front, [vbPtr]) =>
        ["unlockVertexBufferBytes", [vbPtr, front.captureLockedVertexBytes(vbPtr as number)]],
    unlockIndexBuffer: (front, [ibPtr]) =>
        ["unlockIndexBufferBytes", [ibPtr, front.captureLockedIndexBytes(ibPtr as number)]],
    unlockTexture: (front, [texPtr, level, _mem, options]) =>
        ["unlockTextureBytes", [texPtr, level, front.captureLockedTextureBytes(texPtr as number, level as number), options]],
    unlockCubeFace: (front, [cubePtr, face, level]) =>
        ["unlockCubeFaceBytes", [cubePtr, face, level,
            front.captureLockedCubeFaceBytes(cubePtr as number, face as number, level as number)]],
    setViewport: (front, [ptr, mem, captured]) => {
        const values = front.readViewportArg(ptr as number, mem as Uint8Array, captured === true);
        return values ? ["setViewportValues", [values]] : null;
    },
    drawPrimitiveUP: (front, [type, count, ptr, stride, ringSource]) => {
        const bytes = front.captureUpVertexBytes(type as number, count as number, ptr as number,
            stride as number, ringSource as Uint8Array | undefined);
        return ["drawPrimitiveUP", [type, count, 0, stride, bytes ?? new Uint8Array(0)]];
    },
    drawIndexedPrimitiveUP: (front, [type, minV, numV, count, idxPtr, is32, vtxPtr, stride]) => {
        const spans = front.captureIndexedUpBytes(type as number, minV as number, numV as number, count as number,
            idxPtr as number, is32 as boolean, vtxPtr as number, stride as number);
        return spans ? ["drawIndexedPrimitiveUP", [type, minV, numV, count, 0, is32, 0, stride, spans]] : null;
    },
    setVertexShaderConstantF: (_f, [start, ptr, n, mem]) =>
        ["setVertexShaderConstantFFromArray", [start, f32(mem as Uint8Array, ptr as number, (n as number) * 4), null]],
    setPixelShaderConstantF: (_f, [start, ptr, n, mem]) =>
        ["setPixelShaderConstantFFromArray", [start, f32(mem as Uint8Array, ptr as number, (n as number) * 4), null]],
    setVertexShaderConstantI: (_f, [start, ptr, n, mem]) =>
        ["setVertexShaderConstantIFromArray", [start, i32(mem as Uint8Array, ptr as number, (n as number) * 4), null]],
    setPixelShaderConstantI: (_f, [start, ptr, n, mem]) =>
        ["setPixelShaderConstantIFromArray", [start, i32(mem as Uint8Array, ptr as number, (n as number) * 4), null]],
    setVertexShaderConstantB: (_f, [start, ptr, n, mem]) =>
        ["setVertexShaderConstantBFromArray", [start, i32(mem as Uint8Array, ptr as number, n as number), null]],
    setPixelShaderConstantB: (_f, [start, ptr, n, mem]) =>
        ["setPixelShaderConstantBFromArray", [start, i32(mem as Uint8Array, ptr as number, n as number), null]],
    createVertexShader: (front, [ptr, mem]) =>
        ["createVertexShaderFromTokens", [front.captureShaderTokens(ptr as number, mem as Uint8Array)]],
    createPixelShader: (front, [ptr, mem]) =>
        ["createPixelShaderFromTokens", [front.captureShaderTokens(ptr as number, mem as Uint8Array)]],
    setPaletteEntries: (_f, [n, ptr, mem]) =>
        ["setPaletteEntriesFromBytes", [n, (mem as Uint8Array).slice(ptr as number, (ptr as number) + 1024)]],
    reset: (front, [ptr, mem]) => ["resetFromParams", [front.readResetParams(ptr as number, mem as Uint8Array)]],
    // A state block the modules hold is named to the twin by its COM pointer (see
    // splitRegisterStateBlock): the twin has its own copy, captured from its own state.
    applyStateBlockData: (_f, [data]) => blockByPointer("applyStateBlockDataBySbPtr", data),
    captureStateBlockData: (_f, [data]) => blockByPointer("captureStateBlockDataBySbPtr", data),
};

/** Calls whose effect on the twin is their OUTPUT, known only after the front ran them: the
 *  record is built from the result instead of the arguments. */
type PostRecord = (front: D3D9Device, args: Args, result: unknown) => [string, Args] | null;
const POST_RECORDS: Record<string, PostRecord> = {
    // Software vertex processing runs on the front (it owns the constants the twin may not
    // have yet); the twin takes the destination buffer as written.
    processVertices: (front, args, result) => result !== 0 ? null
        : ["twinWriteVertexBufferData", [args[3], front.captureVertexBufferData(args[3] as number)]],
};

const blockPointers = new WeakMap<object, number>();
function blockByPointer(name: string, data: unknown): [string, Args] | null {
    const sbPtr = typeof data === "object" && data !== null ? blockPointers.get(data) : undefined;
    return sbPtr === undefined ? null : [name, [sbPtr]];
}

/** Recorded calls the twin cannot perform yet: counted and named instead of desynchronizing. */
const UNSUPPORTED = new Set<string>();

interface SplitRecordStats {
    recorded: number;
    recordedBytes: number;
    fences: number;
    unsupported: Record<string, number>;
    encodeErrors: Record<string, number>;
    frontCallsDuringReplay: Record<string, number>;
}

type SplitStats = SplitRecordStats & SplitReplayStats;

const noRefs: SplitRefTable = { idOf: () => undefined, twinOf: () => undefined };

class SplitStream {
    private readonly methodIds = new Map<string, number>();
    private readonly methodNames: string[] = [];
    /** In-process twins replay here; a remote twin replays in the render worker. */
    private readonly replayer = new SplitReplayer();
    private readonly slots = new Map<D3D9Device, number>();
    private nextSlot = 0;
    private readonly encoder = new SplitEncoder(noRefs);
    private depth = 0;
    private suppress = 0;
    private replaying = 0;
    private readonly queueId: number;
    /** Batches shipped to the render worker. */
    private shipSerial = 0;
    readonly stats: SplitRecordStats = {
        recorded: 0, recordedBytes: 0, fences: 0, unsupported: {}, encodeErrors: {}, frontCallsDuringReplay: {},
    };

    constructor(private readonly dispatcher: SplitDispatcher, private readonly remote: SplitRemote | null) {
        this.queueId = dispatcher.registerQueuePayloadHandler((m8, m32, ptr) => this.replayer.replayRecord(m8, m32, ptr));
        dispatcher.setWbufSplitClient({
            // Latched: the flag chose the devices' roles at creation, and a front has no GPU to
            // fall back on, so a runtime flag change must not stop the stream.
            armed: () => true,
            drainBegin: () => { this.suppress++; },
            drainEnd: () => { this.suppress--; },
            replayBegin: () => { this.replaying++; beginD3D9SplitReplay(); d3d9PerfMuteApi(true); },
            replayEnd: () => { d3d9PerfMuteApi(false); endD3D9SplitReplay(); this.replaying--; },
            ship: remote
                ? (queue: Uint8Array, end: number) => {
                    remote.ship(queue, end, this.queueId, this.methodNames);
                    this.shipSerial++;
                    return true;
                }
                : undefined,
        });
    }

    private methodId(name: string): number {
        let id = this.methodIds.get(name);
        if (id === undefined) {
            id = this.methodNames.length;
            this.methodNames.push(name);
            this.replayer.methodNames.push(name);
            this.methodIds.set(name, id);
        }
        return id;
    }

    attach(front: D3D9Device, twin: D3D9Device | null): void {
        front.role = "front";
        const slot = this.nextSlot++;
        this.slots.set(front, slot);
        if (twin) {
            twin.role = "render";
            front.renderTwin = twin;
            this.replayer.twins.set(slot, twin);
            front.splitFetchTexture = async (texPtr, method) => {
                this.flush();
                await this.replayer.settled();
                return { data: twin.copyTextureShadow(texPtr), answer: this.replayer.lastAsyncAnswer.get(method) };
            };
        } else if (this.remote) {
            const screen = this.remote.createTwin(slot, front.isExtended, front);
            // Frames arrive from the worker: the canvas edge comes with them, and the per-present
            // questions the screen is asked are the layer's to answer.
            front.splitFramesRemote = true;
            const f = front as unknown as Record<string, unknown>;
            f.repaintLastFrame = () => screen.repaintLastFrame();
            f.getLastPresentDrawCount = () => screen.getLastPresentDrawCount();
            f.capturePresentedLayer = () => screen.capturePresentedLayer();
            f.readPresentedRgba = () => { this.flush(); return screen.readPresentedRgba(); };
            const remote = this.remote;
            const depth = splitPresentDepth();
            front.splitPresentGate = () => remote.waitForBacklog(depth);
            front.splitFetchTexture = (texPtr, method) => {
                this.flush();
                return remote.fetchTexture(slot, texPtr, method);
            };
            // The front's own query manager never submits: query.ts talks to the worker's instead,
            // through the stream (boundaries) and the result table (answers).
            (front as unknown as { getQueryManager: () => null }).getQueryManager = () => null;
            front.splitQueries = this.queryChannel(front, remote);
            front.adoptSplitLossSource(remote.gpuLifecycle);
        }
        const proto = Object.getPrototypeOf(front) as Record<string, unknown>;
        for (const name of RECORDED) {
            const orig = proto[name];
            if (typeof orig !== "function") {
                Logger.warn(LogCategory.D3D9, `[split] recorded method ${name} does not exist`);
                continue;
            }
            (front as unknown as Record<string, unknown>)[name] = this.recordingWrapper(slot, name, orig as Fn);
        }
        // A remote twin cannot answer synchronously: the front's own copy of these stands in.
        if (!twin) return;
        for (const name of DELEGATED) {
            if (typeof proto[name] !== "function") continue;
            (front as unknown as Record<string, unknown>)[name] = (...args: Args) => {
                this.flush();
                return ((twin as unknown as Record<string, Fn>)[name]).apply(twin, args);
            };
        }
    }

    private recordingWrapper(slot: number, name: string, orig: Fn): Fn {
        const stream = this;
        const site: RecordSite = {
            slot, name, orig,
            transform: TRANSFORMS[name], post: POST_RECORDS[name],
            unsupported: UNSUPPORTED.has(name), fence: FENCES.has(name), readbackFence: READBACK_FENCES.has(name),
        };
        // Fixed arity and no `arguments`: the ring handlers and state-block applies call these
        // ~20k times a frame with recording suppressed, and a function that names `arguments`
        // materializes it on every call. No recorded method takes more than ten arguments.
        return function (this: D3D9Device, a0?: unknown, a1?: unknown, a2?: unknown, a3?: unknown, a4?: unknown,
            a5?: unknown, a6?: unknown, a7?: unknown, a8?: unknown, a9?: unknown): unknown {
            if (stream.depth !== 0 || stream.suppress !== 0) return orig.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
            return stream.recordCall(this, site, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
        };
    }

    /** The outermost call of a recorded method. Trailing `undefined` arguments are dropped: no
     *  recorded method reads `arguments.length` or has a rest parameter, so a missing argument
     *  and an explicit `undefined` are the same call on both sides. */
    private recordCall(device: D3D9Device, site: RecordSite, a0: unknown, a1: unknown, a2: unknown, a3: unknown,
        a4: unknown, a5: unknown, a6: unknown, a7: unknown, a8: unknown, a9: unknown): unknown {
        const { slot, name, orig } = site;
        if (this.replaying !== 0) {
            // A twin path reached the FRONT (a registry that is not replay-aware): the call
            // runs, but on the wrong device and outside the stream order.
            this.stats.frontCallsDuringReplay[name] = (this.stats.frontCallsDuringReplay[name] ?? 0) + 1;
            return orig.call(device, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
        }
        const args: Args = [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9];
        let argc = args.length;
        while (argc > 0 && args[argc - 1] === undefined) argc--;
        args.length = argc;
        if (site.unsupported) this.stats.unsupported[name] = (this.stats.unsupported[name] ?? 0) + 1;
        let recName = name;
        let recArgs = args;
        let record = true;
        if (site.transform) {
            const t = site.transform(device, args);
            if (t === null) record = false;
            else { recName = t[0]; recArgs = t[1]; }
        }
        this.depth++;
        let result: unknown;
        try {
            result = orig.apply(device, args);
        } finally {
            this.depth--;
        }
        if (site.post) {
            const t = site.post(device, args, result);
            if (t) this.record(slot, t[0], t[1], undefined);
        } else if (record) {
            this.record(slot, recName, recArgs, result);
        }
        if (site.fence) this.flush();
        else if (site.readbackFence && result !== null && typeof result === "object"
            && typeof (result as Promise<unknown>).then === "function") this.flush();
        return result;
    }

    private record(slot: number, name: string, args: Args, result: unknown): void {
        const enc = this.encoder;
        enc.reset();
        let arg = -1;
        try {
            enc.value(comparableAnswer(result), "result");
            enc.value(args.length, "argc");
            for (arg = 0; arg < args.length; arg++) enc.value(args[arg], name);
        } catch (e) {
            if (arg >= 0) e = new Error(`${name}(arg ${arg}): ${String(e)}`);
            this.stats.encodeErrors[name] = (this.stats.encodeErrors[name] ?? 0) + 1;
            if (this.stats.encodeErrors[name] === 1) Logger.error(LogCategory.D3D9, `[split] ${String(e)}`);
            return;
        }
        this.dispatcher.enqueuePayloadById(this.queueId, this.methodId(name), slot, 0, 0, enc.bytes, 0, enc.length);
        this.stats.recorded++;
        this.stats.recordedBytes += enc.length;
    }

    /** Bring the twin current: run (or ship) everything queued. */
    flush(): void {
        if (this.replaying !== 0) return;
        this.stats.fences++;
        this.dispatcher.executeWbufQueue();
    }

    /** Record a synthetic twin-only call (registering an object the modules built). */
    recordTwinCall(front: D3D9Device, name: string, args: Args): boolean {
        const slot = this.slots.get(front);
        if (slot === undefined || this.suppress !== 0) return false;
        this.record(slot, name, args, undefined);
        return true;
    }

    /**
     * query.ts's boundaries reach the worker's query manager in stream order, so an END lands
     * after the draws it fences; each END carries the generation token the answer will name.
     */
    private queryChannel(front: D3D9Device, remote: SplitRemote): SplitQueryChannel {
        const table = remote.queryResults;
        const op = (name: string, queryPtr: number, arg: number): boolean =>
            this.recordTwinCall(front, "twinQuery", [name, queryPtr >>> 0, arg >>> 0]);
        return {
            timestampSupported: () => remote.timestampQuerySupported(),
            create: (queryPtr, type) => { if (!op("create", queryPtr, type)) table.counters.unrecorded++; },
            begin: (queryPtr, previous) => {
                table.forget(previous);
                if (!op("begin", queryPtr, 0)) table.counters.unrecorded++;
            },
            end: (queryPtr, previous, shipReady) => {
                table.forget(previous);
                const token = shipReady ? table.mint() : table.expect();
                if (!op("end", queryPtr, token)) {
                    table.counters.unrecorded++;
                    table.settle({ token, state: "unavailable", reason: "boundary-not-recorded" });
                }
                return token;
            },
            flush: (queryPtr, token) => {
                table.counters.flushes++;
                op("flush", queryPtr, token);
                this.flush();
            },
            shipMark: () => this.shipSerial + 1,
            shipped: (mark) => this.shipSerial >= mark,
            release: (queryPtr, token) => {
                table.forget(token);
                op("release", queryPtr, 0);
            },
            result: (token) => table.result(token),
            noteAnswered: () => table.noteAnswered(),
            noteShipReadyAnswered: () => table.noteShipReadyAnswered(),
        };
    }

    replayStats(reset: boolean): SplitReplayStats {
        return this.remote ? (this.remote.replayStats(reset) ?? emptyReplayStats()) : this.replayer.takeStats(reset);
    }
}

type Fn = (...args: Args) => unknown;

/** A recorded method's per-name constants, resolved once when the wrapper is installed. */
interface RecordSite {
    readonly slot: number;
    readonly name: string;
    readonly orig: Fn;
    readonly transform: Transform | undefined;
    readonly post: PostRecord | undefined;
    readonly unsupported: boolean;
    readonly fence: boolean;
    readonly readbackFence: boolean;
}

let stream: SplitStream | null = null;

/** Split a device the modules just created: an in-process twin, or (remote) the render worker's. */
export function attachD3D9Split(front: D3D9Device, twin: D3D9Device | null, dispatcher: SplitDispatcher,
    remote: SplitRemote | null): void {
    stream ??= new SplitStream(dispatcher, remote);
    stream.attach(front, twin);
    Logger.log(LogCategory.D3D9, `[split] ${twin ? "in-process" : "render-worker"} twin attached; the front records, the twin draws`);
}

/** The COM pointer the modules registered the device under: ring entries name it by pointer. */
export function splitBindDevicePointer(front: D3D9Device, devicePtr: number): void {
    if (!stream || front.role !== "front") return;
    stream.recordTwinCall(front, "twinBindDevicePointer", [devicePtr >>> 0]);
}

/** Register a state block the modules built, on the twin side, under its COM pointer. */
export function splitRegisterStateBlock(front: D3D9Device, sbPtr: number, data: D3D9StateBlockData): void {
    if (!stream || front.role !== "front") return;
    blockPointers.set(data, sbPtr >>> 0);
    stream.recordTwinCall(front, "twinRegisterStateBlock", [sbPtr >>> 0, data.devicePtr >>> 0, data.blockType, data.entries]);
}

export function splitForgetStateBlock(front: D3D9Device, sbPtr: number): void {
    if (!stream || front.role !== "front") return;
    stream.recordTwinCall(front, "twinForgetStateBlock", [sbPtr >>> 0]);
}

/** Shader and declaration COM pointers the ring handlers resolve to device handles. */
export function splitRegisterComObject(front: D3D9Device | undefined, kind: "vs" | "ps" | "decl", comPtr: number, handle: number): void {
    if (!stream || !front || front.role !== "front") return;
    stream.recordTwinCall(front, "twinRegisterComObject", [kind, comPtr >>> 0, handle >>> 0]);
}

export function splitForgetComObject(front: D3D9Device | undefined, kind: "vs" | "ps" | "decl", comPtr: number): void {
    if (!stream || !front || front.role !== "front") return;
    stream.recordTwinCall(front, "twinForgetComObject", [kind, comPtr >>> 0]);
}

/** `replay` supplies the twin side when the caller already holds it (the render worker's
 *  awaited report); otherwise the stream's own replayer answers. */
export function d3d9SplitStats(reset = false, replay?: SplitReplayStats): (SplitStats & { attached: boolean }) | null {
    if (!stream) return null;
    const out = { attached: true, ...JSON.parse(JSON.stringify(stream.stats)) as SplitRecordStats, ...(replay ?? stream.replayStats(reset)) };
    if (reset) {
        const s = stream.stats;
        s.recorded = 0; s.recordedBytes = 0; s.fences = 0;
        s.unsupported = {}; s.encodeErrors = {}; s.frontCallsDuringReplay = {};
    }
    return out;
}

export function d3d9SplitFlush(): void { stream?.flush(); }

/** Test hook: the next attach starts a fresh stream on its own dispatcher. */
export function resetD3D9SplitStreamForTests(): void { stream = null; }

/** Getters both instances answer from their own state; equal after a flush, or the stream
 *  lost or reordered something. */
const AUDITED: Array<[string, unknown[]]> = [
    ["getAllRenderStates", []], ["getAllTextureStageStates", []], ["getAllSamplerStates", []],
    ["getAllTransforms", []], ["getViewport", []], ["getFVF", []], ["getVertexShaderComPtr", []],
    ["getPixelShaderComPtr", []], ["getVertexDeclarationComPtr", []], ["getBoundIndexBufferPtr", []],
    ["getAllVertexShaderConstants", []], ["getAllPixelShaderConstants", []], ["getScissorRect", []],
    ["getSoftwareVertexProcessing", []], ["getNPatchMode", []],
    ...Array.from({ length: 16 }, (_, i) => ["getBoundTexturePtr", [i]] as [string, unknown[]]),
    ...Array.from({ length: 8 }, (_, i) => ["getStreamBinding", [i]] as [string, unknown[]]),
];

/** Compare front and twin state for every split device; names each getter that differs. */
export function d3d9SplitAudit(fronts: Iterable<D3D9Device>): { devices: number; checked: number; differences: string[] } {
    stream?.flush();
    const differences: string[] = [];
    let checked = 0;
    let count = 0;
    for (const front of fronts) {
        const twin = front.renderTwin;
        if (!twin) continue;
        count++;
        for (const [name, args] of AUDITED) {
            const f = (front as unknown as Record<string, Fn>)[name];
            const t = (twin as unknown as Record<string, Fn>)[name];
            if (typeof f !== "function" || typeof t !== "function") continue;
            checked++;
            const a = canonical(f.apply(front, args));
            const b = canonical(t.apply(twin, args));
            if (a !== b) differences.push(`${name}(${args.join(",")}): front ${a.slice(0, 160)} | twin ${b.slice(0, 160)}`);
        }
    }
    return { devices: count, checked, differences };
}

function canonical(v: unknown): string {
    return JSON.stringify(v, (_k, x) => ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x instanceof Map ? [...x] : x) ?? "undefined";
}
