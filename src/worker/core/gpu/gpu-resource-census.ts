/**
 * Live GPU-object census for the worker it is installed in.
 *
 * WebGPU memory is held by the GPU PROCESS, where no JS heap profile can see it, and it is
 * released by exactly two things: an explicit destroy()/close(), or the garbage collection of
 * the last JS reference. V8 does not know a GPUBuffer's size, so an object dropped without
 * destroy() is freed whenever the collector happens to run — which, in a worker whose JS
 * heap barely grows, can be never. This census names both failure modes per kind:
 *   live       created and neither destroyed nor collected — held by JS, or awaiting GC;
 *   collected  reclaimed by GC WITHOUT a destroy — a leak that GC happened to rescue.
 *
 * Opt-in: installing wraps the prototypes (a WeakMap entry and a FinalizationRegistry
 * registration per create), so it is armed by the harness (`gpuCensus`) and counts only
 * objects created after arming. `sites` additionally keys every object by its creation stack,
 * which is what turns "live grows" into a file:line.
 */

type Kind = "buffer" | "texture" | "querySet" | "bitmap" | "device";

interface Entry {
    kind: Kind;
    bytes: number;
    tag: string;
    site: string;
    done: boolean;
}

export interface GpuCensusKindStats {
    created: number;
    destroyed: number;
    /** Handed to another worker in a postMessage transfer list: the receiver owns it now. */
    transferred: number;
    collected: number;
    live: number;
    liveBytes: number;
    peakLiveBytes: number;
}

export interface GpuResourceCensus {
    scope: string;
    armed: boolean;
    sites: boolean;
    armedForMs: number;
    kinds: Record<Kind, GpuCensusKindStats>;
    /** Live objects by kind+usage/format tag, largest first. */
    liveByTag: Array<{ tag: string; live: number; bytes: number }>;
    /** Live objects by creation site (only with `sites`), largest first. */
    liveBySite: Array<{ site: string; kind: Kind; live: number; bytes: number }>;
    /** GC-reclaimed-without-destroy objects by creation site (only with `sites`). */
    collectedBySite: Array<{ site: string; kind: Kind; count: number; bytes: number }>;
    mapAsync: { started: number; unmapped: number; destroyedMapped: number };
    /** Submission backlog: a queue whose GPU work completes slower than it is submitted keeps
     *  every submission's staging memory (writeBuffer/writeTexture copies) alive in the GPU
     *  process, which no object count shows. `inFlight` is submits not yet known complete. */
    queue: { submits: number; completed: number; inFlight: number; lastLagMs: number; maxLagMs: number; maxInFlight: number };
    canvas: { configures: number; unconfigures: number; currentTextures: number };
}

const KINDS: Kind[] = ["buffer", "texture", "querySet", "bitmap", "device"];

function emptyKind(): GpuCensusKindStats {
    return { created: 0, destroyed: 0, transferred: 0, collected: 0, live: 0, liveBytes: 0, peakLiveBytes: 0 };
}

const state = {
    scope: "",
    installed: false,
    armed: false,
    sites: false,
    armedAt: 0,
    kinds: Object.fromEntries(KINDS.map((k) => [k, emptyKind()])) as Record<Kind, GpuCensusKindStats>,
    entries: new WeakMap<object, Entry>(),
    liveTags: new Map<string, { live: number; bytes: number }>(),
    liveSites: new Map<string, { kind: Kind; live: number; bytes: number }>(),
    collectedSites: new Map<string, { kind: Kind; count: number; bytes: number }>(),
    mapAsync: { started: 0, unmapped: 0, destroyedMapped: 0 },
    mapped: new WeakSet<object>(),
    canvas: { configures: 0, unconfigures: 0, currentTextures: 0 },
    queue: { submits: 0, completed: 0, inFlight: 0, lastLagMs: 0, maxLagMs: 0, maxInFlight: 0 },
    probing: false,
};

const registry: FinalizationRegistry<Entry> | null = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<Entry>((e) => retire(e, "collected"))
    : null;

function bump(map: Map<string, { live: number; bytes: number }>, key: string, dLive: number, dBytes: number): void {
    const v = map.get(key);
    if (v) { v.live += dLive; v.bytes += dBytes; if (v.live <= 0) map.delete(key); }
    else if (dLive > 0) map.set(key, { live: dLive, bytes: dBytes });
}

function creationSite(): string {
    if (!state.sites) return "";
    const stack = new Error().stack ?? "";
    // Frame 0 is Error, 1-2 are this module; the first two foreign frames name the owner.
    const frames = stack.split("\n").slice(1).map((l) => l.trim())
        .filter((l) => !l.includes("gpu-resource-census.ts"));
    return frames.slice(0, 3).map((f) => f.replace(/^at /, "").replace(/\?[^:)]*/, "").replace(/https?:\/\/[^/]+\//, "")).join(" < ");
}

function track(obj: object, kind: Kind, bytes: number, tag: string): void {
    if (!state.armed) return;
    const e: Entry = { kind, bytes, tag: `${kind}:${tag}`, site: creationSite(), done: false };
    state.entries.set(obj, e);
    registry?.register(obj, e);
    const k = state.kinds[kind];
    k.created++;
    k.live++;
    k.liveBytes += bytes;
    if (k.liveBytes > k.peakLiveBytes) k.peakLiveBytes = k.liveBytes;
    bump(state.liveTags, e.tag, 1, bytes);
    if (e.site) {
        const s = state.liveSites.get(e.site);
        if (s) { s.live++; s.bytes += bytes; } else state.liveSites.set(e.site, { kind, live: 1, bytes });
    }
}

function retire(e: Entry, how: "destroyed" | "transferred" | "collected"): void {
    if (e.done) return;
    e.done = true;
    const k = state.kinds[e.kind];
    k[how]++;
    k.live--;
    k.liveBytes -= e.bytes;
    bump(state.liveTags, e.tag, -1, -e.bytes);
    if (e.site) {
        const s = state.liveSites.get(e.site);
        if (s) { s.live--; s.bytes -= e.bytes; if (s.live <= 0) state.liveSites.delete(e.site); }
        if (how === "collected") {
            const c = state.collectedSites.get(e.site);
            if (c) { c.count++; c.bytes += e.bytes; } else state.collectedSites.set(e.site, { kind: e.kind, count: 1, bytes: e.bytes });
        }
    }
}

function destroyed(obj: object, how: "destroyed" | "transferred" = "destroyed"): void {
    const e = state.entries.get(obj);
    if (e) retire(e, how);
}

/** Bytes per texel (block formats: per 4x4 block / 16). An estimate: it ranks, it does not bill. */
function bytesPerTexel(format: string): number {
    if (/^bc[14]-|^etc2-rgb8|^eac-r11/.test(format)) return 0.5;
    if (/^bc|^etc2|^eac|^astc/.test(format)) return 1;
    if (/32float|32uint|32sint/.test(format)) return format.startsWith("rgba") ? 16 : format.startsWith("rg") ? 8 : 4;
    if (/16float|16uint|16sint|16unorm|16snorm/.test(format)) return format.startsWith("rgba") ? 8 : format.startsWith("rg") ? 4 : 2;
    if (/^r8|^stencil8/.test(format)) return 1;
    if (/^rg8/.test(format)) return 2;
    return 4;
}

function textureBytes(desc: GPUTextureDescriptor): number {
    const size = desc.size as GPUExtent3DDict | number[];
    const w = Array.isArray(size) ? size[0] ?? 1 : size.width;
    const h = Array.isArray(size) ? size[1] ?? 1 : size.height ?? 1;
    const d = Array.isArray(size) ? size[2] ?? 1 : size.depthOrArrayLayers ?? 1;
    const mips = desc.mipLevelCount ?? 1;
    const samples = desc.sampleCount ?? 1;
    let total = 0;
    for (let m = 0; m < mips; m++) total += Math.max(1, w >> m) * Math.max(1, h >> m);
    return Math.round(total * d * samples * bytesPerTexel(String(desc.format)));
}

function bufferTag(usage: number): string {
    const U = (globalThis as unknown as { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage;
    if (!U) return String(usage);
    const names: string[] = [];
    for (const n of ["MAP_READ", "MAP_WRITE", "COPY_SRC", "COPY_DST", "INDEX", "VERTEX", "UNIFORM", "STORAGE", "INDIRECT", "QUERY_RESOLVE"]) {
        if (usage & (U[n] ?? 0)) names.push(n);
    }
    return names.join("|");
}

type AnyFn = (this: unknown, ...args: never[]) => unknown;

function wrap<T extends object>(proto: T | undefined, name: string, make: (orig: AnyFn) => AnyFn): void {
    if (!proto) return;
    const orig = (proto as Record<string, unknown>)[name];
    if (typeof orig !== "function") return;
    Object.defineProperty(proto, name, { value: make(orig as AnyFn), configurable: true, writable: true });
}

function install(): void {
    if (state.installed) return;
    state.installed = true;
    const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
    const dev = g.GPUDevice?.prototype, buf = g.GPUBuffer?.prototype, tex = g.GPUTexture?.prototype;
    const qs = g.GPUQuerySet?.prototype, ctx = g.GPUCanvasContext?.prototype, adapter = g.GPUAdapter?.prototype;

    wrap(dev, "createBuffer", (orig) => function (this: unknown, ...a: never[]) {
        const r = orig.apply(this, a) as GPUBuffer;
        const d = a[0] as unknown as GPUBufferDescriptor;
        track(r, "buffer", d.size, bufferTag(d.usage));
        if (d.mappedAtCreation) state.mapped.add(r);
        return r;
    });
    wrap(dev, "createTexture", (orig) => function (this: unknown, ...a: never[]) {
        const r = orig.apply(this, a) as GPUTexture;
        const d = a[0] as unknown as GPUTextureDescriptor;
        track(r, "texture", textureBytes(d), String(d.format));
        return r;
    });
    wrap(dev, "createQuerySet", (orig) => function (this: unknown, ...a: never[]) {
        const r = orig.apply(this, a) as GPUQuerySet;
        const d = a[0] as unknown as GPUQuerySetDescriptor;
        track(r, "querySet", d.count * 8, String(d.type));
        return r;
    });
    wrap(dev, "destroy", (orig) => function (this: unknown, ...a: never[]) {
        destroyed(this as object);
        return orig.apply(this, a);
    });
    wrap(adapter, "requestDevice", (orig) => function (this: unknown, ...a: never[]) {
        return (orig.apply(this, a) as Promise<GPUDevice>).then((d) => { track(d, "device", 0, "device"); return d; });
    });
    wrap(buf, "destroy", (orig) => function (this: unknown, ...a: never[]) {
        if (state.mapped.has(this as object)) { state.mapAsync.destroyedMapped++; state.mapped.delete(this as object); }
        destroyed(this as object);
        return orig.apply(this, a);
    });
    wrap(buf, "mapAsync", (orig) => function (this: unknown, ...a: never[]) {
        if (state.armed) state.mapAsync.started++;
        state.mapped.add(this as object);
        return orig.apply(this, a);
    });
    wrap(buf, "unmap", (orig) => function (this: unknown, ...a: never[]) {
        if (state.mapped.delete(this as object) && state.armed) state.mapAsync.unmapped++;
        return orig.apply(this, a);
    });
    wrap(tex, "destroy", (orig) => function (this: unknown, ...a: never[]) {
        destroyed(this as object);
        return orig.apply(this, a);
    });
    wrap(qs, "destroy", (orig) => function (this: unknown, ...a: never[]) {
        destroyed(this as object);
        return orig.apply(this, a);
    });
    wrap(ctx, "configure", (orig) => function (this: unknown, ...a: never[]) {
        if (state.armed) state.canvas.configures++;
        return orig.apply(this, a);
    });
    wrap(ctx, "unconfigure", (orig) => function (this: unknown, ...a: never[]) {
        if (state.armed) state.canvas.unconfigures++;
        return orig.apply(this, a);
    });
    wrap(ctx, "getCurrentTexture", (orig) => function (this: unknown, ...a: never[]) {
        if (state.armed) state.canvas.currentTextures++;
        return orig.apply(this, a);
    });

    const bitmapBytes = (b: ImageBitmap): number => b.width * b.height * 4;
    wrap(g.OffscreenCanvas?.prototype, "transferToImageBitmap", (orig) => function (this: unknown, ...a: never[]) {
        const r = orig.apply(this, a) as ImageBitmap;
        track(r, "bitmap", bitmapBytes(r), "transferToImageBitmap");
        return r;
    });
    const cib = (globalThis as { createImageBitmap?: (...a: unknown[]) => Promise<ImageBitmap> }).createImageBitmap;
    if (typeof cib === "function") {
        (globalThis as { createImageBitmap?: unknown }).createImageBitmap = function (...a: unknown[]) {
            return cib.apply(globalThis, a).then((r) => { track(r, "bitmap", bitmapBytes(r), "createImageBitmap"); return r; });
        };
    }
    wrap(g.GPUQueue?.prototype, "submit", (orig) => function (this: unknown, ...a: never[]) {
        const r = orig.apply(this, a);
        if (!state.armed) return r;
        const q = state.queue;
        q.submits++;
        q.inFlight = q.submits - q.completed;
        if (q.inFlight > q.maxInFlight) q.maxInFlight = q.inFlight;
        // One completion probe at a time: it covers every submit made before it.
        if (!state.probing) {
            state.probing = true;
            const upTo = q.submits, t0 = performance.now();
            (this as GPUQueue).onSubmittedWorkDone().then(() => {
                const lag = performance.now() - t0;
                q.completed = Math.max(q.completed, upTo);
                q.inFlight = q.submits - q.completed;
                q.lastLagMs = lag;
                if (lag > q.maxLagMs) q.maxLagMs = lag;
            }, () => { /* device lost: the backlog is gone with it */ }).finally(() => { state.probing = false; });
        }
        return r;
    });
    const scope = globalThis as { postMessage?: (msg: unknown, transfer?: unknown) => void; document?: unknown };
    if (typeof scope.postMessage === "function" && scope.document === undefined) {
        const post = scope.postMessage;
        scope.postMessage = function (msg: unknown, transfer?: unknown) {
            const list = Array.isArray(transfer) ? transfer : (transfer as { transfer?: unknown[] } | undefined)?.transfer;
            if (list) for (const t of list) if (t && typeof t === "object") destroyed(t as object, "transferred");
            return post.call(globalThis, msg, transfer);
        };
    }
    wrap(g.ImageBitmap?.prototype, "close", (orig) => function (this: unknown, ...a: never[]) {
        destroyed(this as object);
        return orig.apply(this, a);
    });
}

/** Arm (installing on first use). `reset` zeroes the ledgers; objects created before arming
 *  are never counted, so a destroy of one is ignored rather than driving `live` negative. */
export function armGpuResourceCensus(scope: string, opts: { sites?: boolean; reset?: boolean } = {}): void {
    install();
    state.scope = scope;
    if (opts.reset || !state.armed) {
        for (const k of KINDS) state.kinds[k] = emptyKind();
        state.entries = new WeakMap();
        state.liveTags.clear();
        state.liveSites.clear();
        state.collectedSites.clear();
        state.mapAsync = { started: 0, unmapped: 0, destroyedMapped: 0 };
        state.canvas = { configures: 0, unconfigures: 0, currentTextures: 0 };
        state.queue = { submits: 0, completed: 0, inFlight: 0, lastLagMs: 0, maxLagMs: 0, maxInFlight: 0 };
        state.armedAt = performance.now();
    }
    state.armed = true;
    state.sites = opts.sites === true;
}

export function gpuResourceCensus(top = 12): GpuResourceCensus {
    const byBytes = <T extends { bytes: number }>(a: T, b: T): number => b.bytes - a.bytes;
    return {
        scope: state.scope,
        armed: state.armed,
        sites: state.sites,
        armedForMs: state.armed ? Math.round(performance.now() - state.armedAt) : 0,
        kinds: Object.fromEntries(KINDS.map((k) => [k, { ...state.kinds[k] }])) as Record<Kind, GpuCensusKindStats>,
        liveByTag: [...state.liveTags].map(([tag, v]) => ({ tag, ...v })).sort(byBytes).slice(0, top),
        liveBySite: [...state.liveSites].map(([site, v]) => ({ site, ...v })).sort(byBytes).slice(0, top),
        collectedBySite: [...state.collectedSites].map(([site, v]) => ({ site, ...v })).sort(byBytes).slice(0, top),
        mapAsync: { ...state.mapAsync },
        canvas: { ...state.canvas },
        queue: { ...state.queue, lastLagMs: Math.round(state.queue.lastLagMs), maxLagMs: Math.round(state.queue.maxLagMs) },
    };
}

/** For tests: the ledger entry point the prototype wrappers feed. */
export const __gpuCensusForTest = { track, destroyed, textureBytes };
