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

/**
 * A ring of the last N Glide events.
 *
 * Columns, not entry objects: `push` runs in the hottest handlers in the module
 * (a draw event per triangle, 22M a session in Carmageddon 2), and an object plus
 * a formatted string per call is allocation the reader almost never collects. The
 * variable part of a hot event's detail is a NUMBER, so callers hand over an
 * interned label and the number, and the text is composed at read time.
 */
export class GlideDiagnostics {
    private readonly capacity: number;
    private readonly types: Array<GlideEventType | null>;
    private readonly details: Array<string | undefined>;
    private readonly ids: Float64Array;
    private readonly timestamps: Float64Array;
    private readonly numbers: Float64Array;
    private cursor = 0;
    private count = 0;
    private nextId = 1;

    constructor(capacity: number) {
        this.capacity = Math.max(8, capacity | 0);
        this.types = new Array<GlideEventType | null>(this.capacity).fill(null);
        this.details = new Array<string | undefined>(this.capacity).fill(undefined);
        this.ids = new Float64Array(this.capacity);
        this.timestamps = new Float64Array(this.capacity);
        this.numbers = new Float64Array(this.capacity).fill(NaN);
    }

    /** `detail` is rendered verbatim; `trailingNumber`, when given, is appended to it —
     *  so a hot caller passes a constant label and a number instead of building a string. */
    push(type: GlideEventType, detail?: string, trailingNumber: number = NaN): void {
        const i = this.cursor;
        this.types[i] = type;
        this.details[i] = detail;
        this.ids[i] = this.nextId++;
        this.timestamps[i] = performance.now();
        this.numbers[i] = trailingNumber;
        this.cursor = (i + 1) % this.capacity;
        this.count = Math.min(this.count + 1, this.capacity);
    }

    getRecent(limit: number = 64): Array<GlideEventEntry> {
        const wanted = Math.max(0, Math.min(limit | 0, this.count));
        const out: GlideEventEntry[] = [];
        for (let i = wanted - 1; i >= 0; i--) {
            const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
            const type = this.types[idx];
            if (!type) continue;
            const detail = this.details[idx];
            const num = this.numbers[idx]!;
            out.push({
                id: this.ids[idx]!,
                type,
                timestamp: this.timestamps[idx]!,
                detail: Number.isNaN(num) ? detail : `${detail ?? ""}${num}`,
            });
        }
        return out;
    }

    reset(): void {
        this.types.fill(null);
        this.details.fill(undefined);
        this.numbers.fill(NaN);
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
