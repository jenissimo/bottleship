import { GlideContext, GlideDebugInfo, GlideFrameSnapshot } from "./context";

export type GlideEventType =
    | "init"
    | "shutdown"
    | "winopen"
    | "winclose"
    | "clear"
    | "draw"
    | "swap"
    | "texdownload"
    | "texsource"
    | "texevict"
    | "lfb_lock"
    | "lfb_unlock"
    | "lfb_read"
    | "lfb_write"
    | "error";

type GlideEventEntry = {
    id: number;
    type: GlideEventType;
    timestamp: number;
    detail?: string;
};

export class GlideDiagnostics {
    private readonly capacity: number;
    private readonly entries: Array<GlideEventEntry | null>;
    private cursor = 0;
    private count = 0;
    private nextId = 1;

    constructor(capacity: number) {
        this.capacity = Math.max(8, capacity | 0);
        this.entries = new Array<GlideEventEntry | null>(this.capacity).fill(null);
    }

    push(type: GlideEventType, detail?: string): void {
        const entry: GlideEventEntry = {
            id: this.nextId++,
            type,
            timestamp: performance.now(),
            detail,
        };
        this.entries[this.cursor] = entry;
        this.cursor = (this.cursor + 1) % this.capacity;
        this.count = Math.min(this.count + 1, this.capacity);
    }

    getRecent(limit: number = 64): Array<GlideEventEntry> {
        const wanted = Math.max(0, Math.min(limit | 0, this.count));
        const out: GlideEventEntry[] = [];
        for (let i = 0; i < wanted; i++) {
            const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
            const entry = this.entries[idx];
            if (entry) out.push(entry);
        }
        out.reverse();
        return out;
    }

    reset(): void {
        this.entries.fill(null);
        this.cursor = 0;
        this.count = 0;
        this.nextId = 1;
    }
}

export function cloneFrameSnapshot(snapshot: GlideFrameSnapshot): GlideFrameSnapshot {
    return {
        ...snapshot,
        frameCounters: {
            ...snapshot.frameCounters,
        },
        lastDraw: snapshot.lastDraw ? { ...snapshot.lastDraw } : undefined,
        lastSwap: snapshot.lastSwap ? { ...snapshot.lastSwap } : undefined,
        lastError: snapshot.lastError ? { ...snapshot.lastError } : undefined,
    };
}

export function buildGlideDebugInfo(
    context: GlideContext,
    scope: "summary" | "full" = "summary",
    onlyActive: boolean = false,
): GlideDebugInfo {
    const textures = context.tmus.flatMap((tmu, idx) =>
        Array.from(tmu.texturesByAddress.values())
            .filter(tex => !onlyActive || tex.lastUsedFrame + 1 >= context.frameSnapshot.frameId)
            .map(({ sourceBytes, ...tex }) => ({
                ...tex,
                tmu: idx,
                sourceBytes: sourceBytes ? sourceBytes.length : 0,
            })),
    );

    const lfbSurfaces = Array.from(context.lfbSurfaces.values()).map(surface => ({
        buffer: surface.buffer,
        address: surface.dataPtr,
        width: surface.width,
        height: surface.height,
        pitch: surface.pitch,
        bytesPerPixel: surface.bytesPerPixel,
        writeMode: surface.writeMode,
        dirty: surface.dirty,
        activeLeaseId: surface.activeLeaseId,
    }));

    const ringEvents = context.diagnostics
        .getRecent(scope === "full" ? 256 : 64)
        .map(entry => ({
            id: entry.id,
            type: entry.type,
            timestamp: entry.timestamp,
            detail: entry.detail,
        }));

    const pipelineCache = context.executor?.getPipelineCacheStats?.();
    const executorMetrics = context.executor?.getMetrics
        ? context.executor.getMetrics()
        : undefined;

    return {
        state: {
            initialized: context.initialized,
            winOpen: context.winOpen,
            width: context.width,
            height: context.height,
            renderBuffer: context.renderBuffer,
            selectedSst: context.selectedSst,
            colorFormat: context.colorFormat,
            origin: context.origin,
        },
        textures,
        lfbSurfaces,
        runtime: {
            clipWindow: { ...context.runtime.clipWindow },
            viewport: { ...context.runtime.viewport },
            cullMode: context.runtime.cullMode,
            fogMode: context.runtime.fogMode,
            stwHint: context.runtime.stwHint,
            colorCombineDelta0: context.runtime.colorCombineDelta0,
            lastGuColorCombineFunction: context.apiState.lastGuColorCombineFunction,
            tmu0: {
                minFilter: context.tmus[0]?.minFilter ?? -1,
                magFilter: context.tmus[0]?.magFilter ?? -1,
                mipMapMode: context.tmus[0]?.mipMapMode ?? -1,
                lodBias: context.tmus[0]?.lodBias ?? 0,
                clampS: context.tmus[0]?.clampS ?? -1,
                clampT: context.tmus[0]?.clampT ?? -1,
            },
        },
        ringEvents,
        frameSnapshot: cloneFrameSnapshot(context.frameSnapshot),
        pipelineCache: pipelineCache ?? undefined,
        executorMetrics: executorMetrics ? { ...executorMetrics } : undefined,
    };
}
