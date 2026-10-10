/**
 * Split D3D9 render worker (plan/d3d9-threaded/P2-PLAN.md, Stage B).
 *
 * Replays the front device's queue — ring entries and recorded calls — into render twins on this
 * worker's own GPUDevice. It has no guest memory and no emulator: the stream carries every byte
 * a call needs, and the registries the ring handlers read are filled by twin-only records.
 * Messages are handled strictly in arrival order, so a request is answered only after every
 * batch shipped before it has been replayed.
 */

(globalThis as { __d3d9RenderWorker?: boolean }).__d3d9RenderWorker = true;

import { WBUF_ARG_PAYLOAD } from "../core/thunking/wbuf-format";
import { walkSplitQueue } from "./split-queue-walk";

type RingHandler = (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void;

interface InitMessage { type: "init"; flags: Record<string, unknown> }
interface TwinMessage { type: "twin"; slot: number; isExtended: boolean }
interface QueueMessage {
    type: "queue"; batch: number; bytes: ArrayBuffer; end: number; splitRecordId: number;
    methodBase: number; methodNames: string[]; handlers: Array<[number, string, number]> | null;
}
interface RequestMessage { type: "request"; id: number; kind: string; reset?: boolean; slot?: number; texPtr?: number; level?: number; method?: string; arm?: boolean; sites?: boolean; timeoutMs?: number; maxVerts?: number; maxIndexedVerts?: number; minDraws?: number; minRenderTargets?: number; handle?: number; includeProgram?: boolean; min?: number; max?: number; target?: number; exclude?: boolean; vs?: number; ps?: number; expression?: string | null }
interface FlagsMessage { type: "flags"; flags: Record<string, unknown> }
/** The emulator worker's present target and quality: the internal scale is resolved from them. */
interface TargetMessage { type: "target"; width: number; height: number; quality: unknown }
type InMessage = InitMessage | TwinMessage | QueueMessage | RequestMessage | FlagsMessage | TargetMessage;

// Filled by init: the modules are imported only after the flags they read at load are set.
let replayer: import("../backends/webgpu/d3d9/split-replay").SplitReplayer | null = null;
let makeTwin: ((slot: number, isExtended: boolean) => import("../backends/webgpu/d3d9/d3d9-device").D3D9Device) | null = null;
let perfSnapshot: (() => unknown) | null = null;
const handlersByName = new Map<string, RingHandler>();
let handlerTable: Array<RingHandler | null> = [];
let argCounts = new Int32Array(0);
const unknownIds = new Set<number>();
const walk = { batches: 0, entries: 0, records: 0, unknown: 0, malformed: 0, handlerThrows: 0 };
let presentCanvas: OffscreenCanvas | null = null;
let renderBackend: import("../backends/webgpu/webgpu-backend").WebGPUBackend | null = null;
/** This worker's device lifecycle as [status, generation]: the front's D3D9 loss source. */
let gpuSnapshot: (() => [string, number]) | null = null;
/** GPU errors since the last retired batch, collapsed by kind|site|message; they ride back with
 *  it so the emulator worker's census — the one `report()` reads — sees this device too. */
const pendingGpuErrors = new Map<string, [string, string, string, number]>();

function post(msg: unknown): void {
    (self as unknown as Worker).postMessage(msg);
}

function applyFlags(flags: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(flags)) (globalThis as Record<string, unknown>)[k] = v;
}

async function init(msg: InitMessage): Promise<void> {
    applyFlags(msg.flags);
    const [{ SplitReplayer }, shared, fastPath, { D3D9Device }, { WebGPUBackend }, { System }, gpuErrors, lifecycle] = await Promise.all([
        import("../backends/webgpu/d3d9/split-replay"),
        import("../modules/d3d9/shared-state"),
        import("../modules/d3d9/fast-path"),
        import("../backends/webgpu/d3d9/d3d9-device"),
        import("../backends/webgpu/webgpu-backend"),
        import("../core/system"),
        import("../core/gpu-error-log"),
        import("../core/gpu/gpu-device-lifecycle"),
    ]);
    gpuErrors.setGpuErrorForwarder((kind, site, message) => {
        const key = `${kind}|${site}|${message}`;
        const seen = pendingGpuErrors.get(key);
        if (seen) seen[3]++;
        else pendingGpuErrors.set(key, [kind, site, message, 1]);
    });
    // Every registry read in this worker is the twin's side, and no guest-visible effect runs.
    shared.beginD3D9SplitReplay();
    captureRingHandlers(fastPath.registerFastPathD3D9Functions);

    const backend = new WebGPUBackend();
    // Resized to the emulator worker's canvas by the first `target` message, before any queue.
    presentCanvas = new OffscreenCanvas(1024, 768);
    await backend.initialize(presentCanvas);
    renderBackend = backend;
    System.getInstance().services.render.setBackend(backend);
    gpuSnapshot = () => [lifecycle.gpuDeviceLifecycle.status(), lifecycle.gpuDeviceLifecycle.generation()];
    // Posted at the transition, not with the next batch: a guest whose Present now fails may
    // stop shipping batches, and its TestCooperativeLevel poll must still see the change.
    lifecycle.registerGpuDeviceObserver("d3d9-render-worker", {
        onDeviceLost: () => post({ type: "gpuLifecycle", gpu: gpuSnapshot!() }),
        onDeviceRecreated: () => post({ type: "gpuLifecycle", gpu: gpuSnapshot!() }),
    });
    replayer = new SplitReplayer();
    makeTwin = (slot, isExtended) => {
        const twin = new D3D9Device(backend);
        twin.role = "render";
        twin.isExtended = isExtended;
        // Each present leaves as a pre-PostFx ImageBitmap; the emulator worker composites it.
        twin.getBackendExecutor().setFrameSink((bitmap, meta) => {
            (self as unknown as Worker).postMessage({ type: "d3d9Frame", slot, bitmap, meta }, [bitmap]);
        });
        return twin;
    };
    // With the devices: the executor ledgers (encoded draws, pipeline/bind-group sets) live on them.
    perfSnapshot = () => shared.getD3D9PerfSnapshotWithDevices();
    post({ type: "ready", gpu: gpuSnapshot(), timestampQuery: backend.getDevice()?.features.has("timestamp-query") === true });
}

/** Run the front's handler registration against a dispatcher that keeps only the ring handlers,
 *  keyed as the front's names table spells them ("dll:function"). */
function captureRingHandlers(register: (dispatcher: never) => void): void {
    const keep = (dll: string, name: string, ...rest: unknown[]): void => {
        const handler = rest.find((r) => typeof r === "function") as RingHandler | undefined;
        if (handler) handlersByName.set(`${dll.toLowerCase()}:${name}`, handler);
    };
    const ringRegistrations = new Set([
        "registerWriteBufferFunction", "registerShadowedWriteBufferFunction", "registerStructCaptureWriteBufferFunction",
        "registerShaderConstantWriteBufferFunction", "registerUpDrawWriteBufferFunction",
        "registerOwnerDisarmWriteBufferFunction", "registerDeferredWriteBufHandler",
    ]);
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (typeof prop !== "string") return undefined;
            if (ringRegistrations.has(prop)) return keep;
            // Guest stubs and FastPath traps belong to the front; declining them is the answer.
            if (prop.includes("Guest") || prop.includes("IncRef")) return undefined;
            if (prop === "wbufDeferring") return () => false;
            return () => undefined;
        },
    });
    register(dispatcher as never);
}

function rebuildHandlerTable(entries: Array<[number, string, number]>, splitRecordId: number): void {
    let max = splitRecordId;
    for (const [id] of entries) if (id > max) max = id;
    handlerTable = new Array(max + 1).fill(null);
    argCounts = new Int32Array(max + 1);
    for (const [id, name, argCount] of entries) {
        const sep = name.indexOf(":");
        const handler = handlersByName.get(`${name.slice(0, sep).toLowerCase()}:${name.slice(sep + 1)}`);
        if (!handler) { unknownIds.add(id); continue; }
        handlerTable[id] = handler;
        argCounts[id] = argCount;
    }
    argCounts[splitRecordId] = WBUF_ARG_PAYLOAD;
}

function replayQueue(msg: QueueMessage): void {
    if (!replayer) throw new Error("render worker: queue before init");
    if (msg.handlers) rebuildHandlerTable(msg.handlers, msg.splitRecordId);
    for (let i = 0; i < msg.methodNames.length; i++) replayer.methodNames[msg.methodBase + i] = msg.methodNames[i]!;
    const u8 = new Uint8Array(msg.bytes);
    const u32 = new Uint32Array(msg.bytes, 0, msg.bytes.byteLength >>> 2);
    const r = replayer;
    const result = walkSplitQueue(u8, u32, msg.end, handlerTable, argCounts, msg.splitRecordId,
        (m8, m32, ptr) => r.replayRecord(m8, m32, ptr));
    walk.batches++;
    walk.entries += result.entries;
    walk.records += result.records;
    walk.unknown += result.unknown;
    walk.handlerThrows += result.handlerThrows;
    if (result.malformedAt >= 0) {
        walk.malformed++;
        post({ type: "error", message: `queue batch ${msg.batch}: no stride at +${result.malformedAt}; rest of batch dropped` });
    }
    if (result.firstThrow && walk.handlerThrows <= 3) post({ type: "error", message: result.firstThrow });
    const errors = pendingGpuErrors.size ? [...pendingGpuErrors.values()] : undefined;
    pendingGpuErrors.clear();
    const results = collectQueryResults();
    // The batch's buffer goes back for the next ship to fill: a fresh megabyte-sized buffer per
    // frame costs its page faults on the guest thread. Transferring detaches it here, so a view a
    // handler kept past the walk reads nothing rather than the next frame's bytes.
    (self as unknown as Worker).postMessage({
        type: "retired", batch: msg.batch, gpuErrors: errors, gpu: gpuSnapshot?.(),
        queryResults: results.length ? results : undefined, bytes: msg.bytes,
    }, [msg.bytes]);
    drainQueryReadbacks();
}

function collectQueryResults(): import("./d3d9-remote-state").SplitQueryResult[] {
    const out: import("./d3d9-remote-state").SplitQueryResult[] = [];
    if (!replayer) return out;
    for (const twin of replayer.twins.values()) for (const r of twin.collectSplitQueryResults()) out.push(r);
    return out;
}

let queryDrainScheduled = false;

/** Occlusion/timestamp values land when their readback maps, after the batch retired: they go
 *  out on their own as soon as they do, off the message chain so replay is not held up. */
function drainQueryReadbacks(): void {
    if (queryDrainScheduled || !replayer) return;
    queryDrainScheduled = true;
    const twins = [...replayer.twins.values()];
    void (async () => {
        let waited = false;
        try {
            await replayer!.settled();
            const flags = await Promise.all(twins.map((t) => t.splitQueriesInflight()));
            waited = flags.some(Boolean);
        } finally {
            queryDrainScheduled = false;
        }
        const results = collectQueryResults();
        if (results.length) post({ type: "queryResults", queryResults: results });
        if (waited) drainQueryReadbacks();
    })();
}

async function answer(msg: RequestMessage): Promise<void> {
    let value: unknown = null;
    try {
        switch (msg.kind) {
            case "drawScrub": {
                const devices = [];
                for (const [slot, twin] of replayer?.twins ?? []) {
                    if (msg.slot !== undefined && msg.slot !== slot) continue;
                    if (msg.min !== undefined) twin.setDrawScrub(msg.min, msg.max ?? -1, msg.target ?? 0, msg.exclude === true);
                    devices.push({ slot, ...twin.getDrawScrub() });
                }
                value = { producer: "render", devices };
                break;
            }
            case "shaderOutputOverride": {
                for (const [slot, twin] of replayer?.twins ?? []) {
                    if (msg.slot !== undefined && msg.slot !== slot) continue;
                    twin.setShaderOutputOverride(msg.vs ?? 0, msg.ps ?? 0, msg.expression ?? null);
                }
                value = { producer: "render", vs: msg.vs, ps: msg.ps, expression: msg.expression };
                break;
            }
            case "stats":
                value = {
                    replay: replayer?.takeStats(msg.reset === true) ?? null,
                    walk: { ...walk, unknownIds: [...unknownIds].slice(0, 32), handlersKnown: handlersByName.size },
                    perf: perfSnapshot?.() ?? null,
                    queries: replayer ? [...replayer.twins].map(([slot, t]) => ({ slot, ...t.splitQueryHostCounters() })) : null,
                    gpu: gpuSnapshot?.() ?? null,
                };
                break;
            case "textureData": {
                // Stream order already put every batch shipped before this request ahead of it;
                // the readbacks those batches started finish asynchronously.
                await replayer?.settled();
                const twin = replayer?.twins.get(msg.slot ?? 0);
                value = { data: twin?.copyTextureShadow(msg.texPtr ?? 0) ?? null, answer: replayer?.lastAsyncAnswer.get(msg.method ?? "") };
                break;
            }
            case "textureRgba": {
                value = null;
                for (const [slot,twin] of replayer?.twins ?? []) {
                    if (msg.slot !== undefined && slot !== msg.slot) continue;
                    const result = await twin.readRenderTargetRgba(msg.texPtr ?? 0, msg.level ?? 0);
                    if (result) value = result;
                    if (result && !("err" in result)) break;
                }
                break;
            }
            case "targetState": {
                value = [...(replayer?.twins ?? [])].map(([slot,twin]) => ({slot,state:twin.getRtDebug(),passes:twin.getPassDebug()}));
                break;
            }
            case "shaderCensus": {
                const { collectShaderCensus } = await import("../harness/shader-census");
                value = {
                    collection: collectShaderCensus(msg.reset === true, replayer?.twins ?? []),
                    perf: perfSnapshot?.() ?? null,
                };
                if (msg.reset) {
                    const { resetD3D9Perf } = await import("../modules/d3d9/d3d9-perf");
                    resetD3D9Perf();
                }
                break;
            }
            case "shaderWgsl": {
                for (const [slot, twin] of replayer?.twins ?? []) {
                    if (msg.slot !== undefined && msg.slot !== slot) continue;
                    const result = twin.shaderInstrumentationWgsl(msg.handle ?? 0, msg.includeProgram === true);
                    if (result) { value = { device: slot, producer: "render", ...result }; break; }
                }
                break;
            }
            case "gpuCensus": {
                const census = await import("../core/gpu/gpu-resource-census");
                const opts = msg as unknown as { arm?: boolean; sites?: boolean; reset?: boolean };
                if (opts.arm) census.armGpuResourceCensus("renderWorker", { sites: opts.sites, reset: opts.reset });
                value = census.gpuResourceCensus();
                break;
            }
            case "loseDevice":
                // Harness: the real loss path of this worker's device (WebGPUBackend.forceDeviceLoss).
                value = renderBackend ? await renderBackend.forceDeviceLoss() : null;
                break;
            case "presentedRgba": {
                const twin = replayer?.twins.get(msg.slot ?? 0);
                value = twin ? await twin.readPresentedRgba() : null;
                break;
            }
            case "capture": {
                const twin = replayer?.twins.get(msg.slot ?? 0);
                const blob = twin ? await twin.capturePresentedLayer() : null;
                value = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
                break;
            }
            case "captureFrame": {
                const capture = await import("../modules/ddraw/frame-capture");
                if (capture.isCapturing()) throw new Error("a D3D9 frame capture is already armed");
                const recording = capture.startCapture("d3d9", { maxVerts: msg.maxVerts, maxIndexedVerts: msg.maxIndexedVerts, minDraws: msg.minDraws, minRenderTargets: msg.minRenderTargets });
                const timer = setTimeout(() => capture.cancelCapture(new Error("no D3D9 frame presented within capture timeout")), msg.timeoutMs ?? 5000);
                // Arm in message order, then release the queue: the next complete frame is
                // carried by FUTURE queue messages. Awaiting it here prevents those messages
                // from replaying and makes every capture time out.
                void recording.then(
                    (frame) => post({ type: "reply", id: msg.id, value: frame }),
                    (error) => post({ type: "reply", id: msg.id, value: { error: String(error) } }),
                ).finally(() => clearTimeout(timer));
                return;
            }
            default:
                value = { error: `unknown request ${msg.kind}` };
        }
    } catch (e) {
        value = { error: String(e) };
    }
    post({ type: "reply", id: msg.id, value });
}

let chain: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<InMessage>) => {
    const msg = e.data;
    chain = chain.then(async () => {
        switch (msg.type) {
            case "init": await init(msg); break;
            case "flags": applyFlags(msg.flags); break;
            case "target": {
                if (!presentCanvas) throw new Error("render worker: target before init");
                presentCanvas.width = Math.max(1, msg.width | 0);
                presentCanvas.height = Math.max(1, msg.height | 0);
                const { EmulatorConfig } = await import("../core/emulator-config-manager");
                EmulatorConfig.getInstance().quality = msg.quality as never;
                break;
            }
            case "twin":
                if (!replayer || !makeTwin) throw new Error("render worker: twin before init");
                replayer.twins.set(msg.slot, makeTwin(msg.slot, msg.isExtended));
                break;
            case "queue": replayQueue(msg); break;
            case "request": await answer(msg); break;
        }
    }).catch((err) => {
        post({ type: "error", message: `${msg.type}: ${String((err as Error)?.stack ?? err)}` });
    });
};
