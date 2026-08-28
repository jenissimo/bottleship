/**
 * WebGPU query-set seam for IDirect3DQuery9.
 *
 * This module deliberately does not own the D3D9 Issue/GetData state machine.  It
 * owns the part that can be made real on WebGPU: lazy query-set allocation, query
 * recording, resolve/readback encoding, and the submission serial at which a result
 * can become visible.  `QueryRecordContract` mirrors the fields query.ts already uses
 * so the device/query layer can adopt this seam without inventing a second lifecycle.
 *
 * The manager never fabricates a GPU measurement.  If a device cannot allocate an
 * occlusion set or lacks timestamp-query, acquire() returns a deterministic fallback
 * handle.  An optional fallback provider may supply the existing CPU-side answer, but
 * the default result is explicitly value-less and therefore cannot be mistaken for a
 * measured sample count or timestamp.
 */

export const D3D9_QUERYTYPE_OCCLUSION = 9;
export const D3D9_QUERYTYPE_TIMESTAMP = 10;

export type QueryId = number | string;
export type QueryKind = 'occlusion' | 'timestamp';

/** The subset of QueryRecord consumed by the GPU seam. */
export interface QueryRecordContract {
    type: number;
    begun: boolean;
    issued: boolean;
    issueSerial: number;
}

/** Structural aliases keep the manager unit-testable while accepting real WebGPU objects. */
export interface QueryManagerDevice {
    readonly features?: ReadonlySet<string>;
    /** Native WebGPU device-loss notification. Optional for deterministic unit seams. */
    readonly lost?: Promise<{ reason?: string }>;
    createQuerySet(descriptor: GPUQuerySetDescriptor): GPUQuerySet;
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    /** Optional validation-error scope. WebGPU validation errors do not throw. */
    pushErrorScope?: (filter: 'validation' | 'out-of-memory' | 'internal') => void;
    popErrorScope?: () => Promise<{ message?: string } | null>;
}

export interface QueryManagerQueue {
    submit(commandBuffers: GPUCommandBuffer[]): void;
    onSubmittedWorkDone(): Promise<void>;
}

export type QueryPassEncoder = Pick<GPURenderPassEncoder, 'beginOcclusionQuery' | 'endOcclusionQuery'>;
export type QueryCommandEncoder = Pick<GPUCommandEncoder,
    'resolveQuerySet' | 'copyBufferToBuffer' | 'finish'> & {
    /** WebGPU exposes this when the timestamp-query feature is enabled; older DOM
     * lib versions omit it from GPUCommandEncoder, so keep the seam structural. */
    writeTimestamp?: (querySet: GPUQuerySet, queryIndex: number) => void;
};

export interface QueryFallbackContext {
    /** Return a caller-owned CPU fallback, or null to expose an explicit no-value fallback. */
    value?: (kind: QueryKind, record: QueryRecordContract) => bigint | null;
}

export interface QueryManagerOptions {
    device: QueryManagerDevice;
    queue: QueryManagerQueue;
    /** Number of slots in each lazily-created query set. */
    querySetCapacity?: number;
    fallback?: QueryFallbackContext;
}

export type QueryCapability = {
    kind: QueryKind;
    supported: boolean;
    reason?: string;
};

export type QueryHandle = {
    id: QueryId;
    kind: QueryKind;
    mode: 'gpu' | 'fallback';
    index?: number;
    querySet?: GPUQuerySet;
    reason?: string;
};

export type QueryOperationResult =
    | { ok: true; mode: 'gpu'; index: number }
    | { ok: true; mode: 'fallback'; reason: string; value?: bigint }
    | { ok: false; reason: string };

export type QueryReadback =
    | { state: 'pending'; submissionSerial: number }
    | { state: 'ready'; submissionSerial: number; value: bigint }
    | { state: 'fallback'; reason: string; value?: bigint }
    | { state: 'unavailable'; reason: string };

type SlotPool = {
    kind: QueryKind;
    querySet: GPUQuerySet;
    capacity: number;
    free: number[];
};

type RecordState = {
    id: QueryId;
    key: string;
    kind: QueryKind;
    record: QueryRecordContract;
    mode: 'gpu' | 'fallback';
    pool?: SlotPool;
    index?: number;
    reason?: string;
    fallbackValue?: bigint;
    began: boolean;
    recorded: boolean;
    encoded: boolean;
    submitted: boolean;
    submissionSerial?: number;
    /** BEGIN was encoded in a command buffer that was submitted before END arrived. */
    splitSubmission?: number;
    value?: bigint;
    error?: string;
    releaseRequested: boolean;
};

type BatchEntry = {
    state: RecordState;
    byteOffset: number;
};

export type QueryResolveBatch = {
    status: 'encoded' | 'submitted' | 'completed' | 'empty' | 'rejected';
    submissionSerial: number;
    entries: readonly BatchEntry[];
    resolveBuffer?: GPUBuffer;
    readbackBuffer?: GPUBuffer;
    completion: Promise<void>;
    /** Resolve-time validation scope, kept open through queue.submit when possible. */
    validation?: Promise<string | null>;
    finishValidationScope?: () => Promise<string | null>;
    reason?: string;
};

/** WebGPU usage bits are constants in browsers, but keeping literals here makes the seam
 * usable in Bun/unit tests without installing a fake global GPUBufferUsage object. */
export const QUERY_MANAGER_BUFFER_USAGE = {
    MAP_READ: 0x0001,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    QUERY_RESOLVE: 0x0200,
} as const;

const MAP_MODE_READ = 0x0001;
const RESULT_BYTES = 8;

function keyOf(id: QueryId): string {
    return `${typeof id}:${String(id)}`;
}

function kindForType(type: number): QueryKind | null {
    if (type === D3D9_QUERYTYPE_OCCLUSION) return 'occlusion';
    if (type === D3D9_QUERYTYPE_TIMESTAMP) return 'timestamp';
    return null;
}

function validSerial(serial: number): boolean {
    return Number.isSafeInteger(serial) && serial > 0;
}

function destroyGpuObject(object: { destroy?: () => void } | undefined): void {
    try {
        object?.destroy?.();
    } catch {
        // Device loss can make destroy() throw in mocks and in a few browser implementations.
        // Query state is still retired below, so a late poll cannot claim a GPU result.
    }
}

/**
 * Owns WebGPU query resources for one D3D9 device.  A pool is allocated only when a
 * query of that kind is first acquired; exhausted pools grow in another query set so
 * an in-flight readback is never overwritten by a later D3D query.
 */
export class D3D9QueryManager {
    private readonly device: QueryManagerDevice;
    private readonly queue: QueryManagerQueue;
    private readonly capacity: number;
    private readonly fallback: QueryFallbackContext | undefined;
    private readonly pools = new Map<QueryKind, SlotPool[]>();
    private readonly records = new Map<string, RecordState>();
    private readonly capabilityFailures = new Map<QueryKind, string>();
    private submittedSerial = 0;
    private reservedSerial = 0;
    private deviceLost = false;
    private deviceLossReason = 'device-lost';

    constructor(options: QueryManagerOptions) {
        this.device = options.device;
        this.queue = options.queue;
        this.capacity = Math.max(1, Math.trunc(options.querySetCapacity ?? 64));
        this.fallback = options.fallback;
        if (options.device.lost) {
            void options.device.lost.then((info) => {
                this.markDeviceLost(`device-lost${info?.reason ? `:${info.reason}` : ''}`);
            }).catch(() => {
                this.markDeviceLost('device-lost');
            });
        }
    }

    /** Query capability is deterministic and side-effect free; allocation remains lazy. */
    getCapability(kind: QueryKind): QueryCapability {
        if (this.deviceLost) return { kind, supported: false, reason: this.deviceLossReason };
        const failure = this.capabilityFailures.get(kind);
        if (failure) return { kind, supported: false, reason: failure };
        if (kind === 'timestamp' && !this.device.features?.has('timestamp-query')) {
            return { kind, supported: false, reason: 'timestamp-query-feature-missing' };
        }
        if (typeof this.device.createQuerySet !== 'function') {
            return { kind, supported: false, reason: 'create-query-set-unavailable' };
        }
        return { kind, supported: true };
    }

    /** Current host-side observation of the submission boundary. */
    getSubmittedSerial(): number {
        return this.submittedSerial;
    }

    /** Reserve the next serial in this manager's sole queue-submission domain. */
    allocateSubmissionSerial(): number {
        this.reservedSerial = Math.max(this.reservedSerial, this.submittedSerial) + 1;
        return this.reservedSerial;
    }

    /** True when an occlusion BEGIN crossed a command-buffer submission boundary. */
    needsRebegin(id: QueryId): boolean {
        return this.records.get(keyOf(id))?.splitSubmission !== undefined;
    }

    /** WebGPU loss is surfaced as D3DERR_DEVICELOST by query.ts before polling data. */
    isDeviceLost(): boolean {
        return this.deviceLost;
    }

    getDeviceLossReason(): string {
        return this.deviceLossReason;
    }

    /**
     * Notify the manager that a queue submission boundary was observed externally.  This
     * is the hook query.ts can use alongside its existing notifyDeviceSubmission() seam;
     * actual readback completion still comes from the queue/map promise for GPU batches.
     */
    notifySubmitted(serial: number): void {
        if (this.deviceLost || !validSerial(serial)) return;
        this.reservedSerial = Math.max(this.reservedSerial, serial);
        if (serial <= this.submittedSerial) return;
        this.submittedSerial = serial;
        // WebGPU query begin/end are render-pass scoped. If a helper or an otherwise
        // query-free frame submits while an occlusion query is open, the pair cannot be
        // continued in the next command buffer. Mark it for a fresh begin at END instead
        // of leaving the manager waiting for a resolve that can never be encoded.
        for (const state of this.records.values()) {
            if (state.mode !== 'gpu' || state.kind !== 'occlusion'
                || !state.began || state.recorded || state.encoded || state.submitted) continue;
            state.splitSubmission = serial;
            state.began = false;
        }
    }

    /** Lazily reserve one query-set slot for a QueryRecord. */
    acquire(id: QueryId, record: QueryRecordContract): QueryHandle {
        const key = keyOf(id);
        const existing = this.records.get(key);
        if (existing) {
            // A COM pointer may be recycled while the old GPU readback is still in
            // flight. Never hand the new logical query the old slot: its completion
            // would otherwise be reported for the new object. Keep the old state
            // reachable from its batch and replace the map entry with an explicit
            // no-value fallback for the new object.
            if (existing.mode === 'gpu' && (existing.encoded || existing.submitted || existing.releaseRequested)) {
                const replacement = this.createFallbackState(
                    id,
                    key,
                    existing.kind,
                    record,
                    'query-id-reused-before-retire',
                );
                this.records.set(key, replacement);
                return this.handleFor(replacement);
            }
            return this.handleFor(existing);
        }

        const kind = kindForType(record.type);
        if (!kind) {
            const state: RecordState = {
                id, key, kind: 'timestamp', record, mode: 'fallback',
                reason: `query-type-${record.type}-not-managed`,
                began: false, recorded: false, encoded: false, submitted: false, releaseRequested: false,
            };
            this.records.set(key, state);
            return this.handleFor(state);
        }

        const capability = this.getCapability(kind);
        if (!capability.supported) {
            const state = this.createFallbackState(id, key, kind, record, capability.reason!);
            this.records.set(key, state);
            return this.handleFor(state);
        }

        const slot = this.allocateSlot(kind);
        if (!slot) {
            const reason = this.capabilityFailures.get(kind) ?? 'query-set-allocation-failed';
            const state = this.createFallbackState(id, key, kind, record, reason);
            this.records.set(key, state);
            return this.handleFor(state);
        }

        const index = slot.free.pop()!;
        const state: RecordState = {
            id, key, kind, record, mode: 'gpu', pool: slot, index,
            began: false, recorded: false, encoded: false, submitted: false, releaseRequested: false,
        };
        this.records.set(key, state);
        return this.handleFor(state);
    }

    /** Re-arm a completed query object for a fresh D3D9 BEGIN/END interval. In-flight
     * readbacks are intentionally not recycled: callers must keep polling the old interval
     * until it is available, matching native query lifetime rules. */
    rearm(id: QueryId, record: QueryRecordContract): QueryHandle | null {
        const state = this.records.get(keyOf(id));
        if (!state) return this.acquire(id, record);
        if (state.mode === 'gpu' && (state.encoded || state.submitted)) return null;
        state.record = record;
        state.began = false;
        state.recorded = false;
        state.encoded = false;
        state.submitted = false;
        state.submissionSerial = undefined;
        state.splitSubmission = undefined;
        state.value = undefined;
        state.error = undefined;
        state.releaseRequested = false;
        return this.handleFor(state);
    }

    /**
     * Return the occlusion query set required by the active render pass. WebGPU
     * allows only one set per pass, so a frame that spans pools is refused by
     * returning null; the low-level begin/end hooks then turn that validation
     * failure into an explicit unavailable result instead of a stuck pending query.
     */
    getOcclusionQuerySet(ids: readonly QueryId[]): GPUQuerySet | null {
        let querySet: GPUQuerySet | undefined;
        for (const id of ids) {
            const state = this.records.get(keyOf(id));
            if (!state || state.kind !== 'occlusion' || state.mode !== 'gpu') continue;
            const candidate = state.pool?.querySet;
            if (!candidate) return null;
            if (!querySet) querySet = candidate;
            else if (querySet !== candidate) return null;
        }
        return querySet ?? null;
    }

    /** Begin an occlusion query in the caller's active render pass. */
    beginOcclusion(id: QueryId, pass: QueryPassEncoder, record?: QueryRecordContract): QueryOperationResult {
        const state = this.records.get(keyOf(id));
        if (!state || state.kind !== 'occlusion') return { ok: false, reason: 'occlusion-query-not-acquired' };
        if (state.mode === 'fallback') return this.fallbackResult(state, record);
        if (state.submitted || state.encoded) return { ok: false, reason: 'occlusion-query-already-submitted' };
        if (state.began) return { ok: false, reason: 'occlusion-query-already-begun' };
        const reason = 'begin-occlusion-query-failed';
        if (!this.runValidationScoped(state, reason, () => pass.beginOcclusionQuery(state.index!))) {
            return { ok: false, reason };
        }
        state.began = true;
        return { ok: true, mode: 'gpu', index: state.index! };
    }

    /** End an occlusion query in the caller's active render pass. */
    endOcclusion(id: QueryId, pass: QueryPassEncoder, record?: QueryRecordContract): QueryOperationResult {
        const state = this.records.get(keyOf(id));
        if (!state || state.kind !== 'occlusion') return { ok: false, reason: 'occlusion-query-not-acquired' };
        if (state.mode === 'fallback') return this.fallbackResult(state, record);
        if (state.submitted || state.encoded) return { ok: false, reason: 'occlusion-query-already-submitted' };
        if (!state.began) return { ok: false, reason: 'occlusion-query-begin-missing' };
        const reason = 'end-occlusion-query-failed';
        if (!this.runValidationScoped(state, reason, () => pass.endOcclusionQuery())) {
            return { ok: false, reason };
        }
        state.began = false;
        state.recorded = true;
        return { ok: true, mode: 'gpu', index: state.index! };
    }

    /** Encode one timestamp write at the D3D9 END point. */
    writeTimestamp(id: QueryId, encoder: QueryCommandEncoder, record?: QueryRecordContract): QueryOperationResult {
        const state = this.records.get(keyOf(id));
        if (!state || state.kind !== 'timestamp') return { ok: false, reason: 'timestamp-query-not-acquired' };
        if (state.mode === 'fallback') return this.fallbackResult(state, record);
        if (state.submitted || state.encoded) return { ok: false, reason: 'timestamp-query-already-submitted' };
        if (typeof encoder.writeTimestamp !== 'function') {
            state.error = 'write-timestamp-unavailable';
            return { ok: false, reason: 'write-timestamp-unavailable' };
        }
        const reason = 'write-timestamp-failed';
        if (!this.runValidationScoped(state, reason, () =>
            encoder.writeTimestamp!(state.pool!.querySet, state.index!))) {
            return { ok: false, reason };
        }
        state.recorded = true;
        return { ok: true, mode: 'gpu', index: state.index! };
    }

    /**
     * Encode resolveQuerySet + copy-to-readback commands into a command encoder.  The
     * caller then passes the returned batch to submit(), which owns the serial/readback
     * transition. Records without a GPU slot remain on their explicit fallback path.
     */
    encodeResolves(
        encoder: QueryCommandEncoder,
        ids: readonly QueryId[],
        submissionSerial: number,
    ): QueryResolveBatch {
        if (!validSerial(submissionSerial)) {
            return this.rejectedBatch(submissionSerial, 'invalid-submission-serial');
        }

        const entries: BatchEntry[] = [];
        for (const id of ids) {
            const state = this.records.get(keyOf(id));
            if (!state || state.mode !== 'gpu') continue;
            if (state.encoded || state.submitted) continue;
            if (!state.recorded || state.error) continue;
            if (!state.record.issued) continue;
            if (!validSerial(state.record.issueSerial) || state.record.issueSerial > submissionSerial) {
                continue;
            }
            state.error = undefined;
            entries.push({ state, byteOffset: entries.length * RESULT_BYTES });
        }
        if (entries.length === 0) {
            return {
                status: 'empty', submissionSerial, entries: [],
                completion: Promise.resolve(),
            };
        }

        const byteLength = entries.length * RESULT_BYTES;
        let resolveBuffer: GPUBuffer;
        let readbackBuffer: GPUBuffer;
        let scopePushed = false;
        const push = this.device.pushErrorScope;
        const pop = this.device.popErrorScope;
        try {
            if (typeof push === 'function' && typeof pop === 'function') {
                push.call(this.device, 'validation');
                scopePushed = true;
            }
            resolveBuffer = this.device.createBuffer({
                label: 'D3D9 query resolve',
                size: byteLength,
                usage: QUERY_MANAGER_BUFFER_USAGE.QUERY_RESOLVE | QUERY_MANAGER_BUFFER_USAGE.COPY_SRC,
            });
            readbackBuffer = this.device.createBuffer({
                label: 'D3D9 query readback',
                size: byteLength,
                usage: QUERY_MANAGER_BUFFER_USAGE.COPY_DST | QUERY_MANAGER_BUFFER_USAGE.MAP_READ,
            });
            for (const entry of entries) {
                encoder.resolveQuerySet(
                    entry.state.pool!.querySet,
                    entry.state.index!,
                    1,
                    resolveBuffer,
                    entry.byteOffset,
                );
                encoder.copyBufferToBuffer(
                    resolveBuffer,
                    entry.byteOffset,
                    readbackBuffer,
                    entry.byteOffset,
                    RESULT_BYTES,
                );
                entry.state.encoded = true;
                entry.state.submissionSerial = submissionSerial;
            }
        } catch {
            if (scopePushed && typeof pop === 'function') void pop.call(this.device).catch(() => undefined);
            destroyGpuObject(resolveBuffer!);
            destroyGpuObject(readbackBuffer!);
            for (const entry of entries) entry.state.encoded = false;
            return this.rejectedBatch(submissionSerial, 'query-resolve-encoding-failed');
        }

        const batch: QueryResolveBatch = {
            status: 'encoded', submissionSerial, entries,
            resolveBuffer, readbackBuffer, completion: Promise.resolve(),
        };
        if (scopePushed && typeof pop === 'function') {
            let finished = false;
            batch.finishValidationScope = () => {
                if (finished) return batch.validation ?? Promise.resolve(null);
                finished = true;
                try {
                    batch.validation = Promise.resolve(pop.call(this.device)).then((error) => {
                        if (!error) return null;
                        const detail = typeof error.message === 'string' && error.message.length > 0
                            ? `:${error.message}` : '';
                        return `query-resolve-validation-failed${detail}`;
                    }).catch(() => 'query-resolve-validation-scope-failed');
                } catch {
                    batch.validation = Promise.resolve('query-resolve-validation-scope-failed');
                }
                return batch.validation;
            };
        }
        return batch;
    }

    /** Submit a previously encoded batch and start its asynchronous availability transition. */
    submit(encoder: QueryCommandEncoder, batch: QueryResolveBatch): void {
        if (batch.status !== 'encoded' || !batch.resolveBuffer || !batch.readbackBuffer) return;
        try {
            this.queue.submit([encoder.finish()]);
        } catch {
            void batch.finishValidationScope?.();
            batch.status = 'rejected';
            batch.reason = 'query-submit-failed';
            for (const entry of batch.entries) {
                entry.state.encoded = false;
                entry.state.error = batch.reason;
                if (entry.state.releaseRequested) this.reclaim(entry.state);
            }
            destroyGpuObject(batch.resolveBuffer);
            destroyGpuObject(batch.readbackBuffer);
            return;
        }

        batch.status = 'submitted';
        this.notifySubmitted(batch.submissionSerial);
        for (const entry of batch.entries) entry.state.submitted = true;
        const validation = batch.finishValidationScope?.() ?? Promise.resolve(null);
        batch.validation = validation;
        batch.completion = this.completeBatch(batch);
    }

    /** Mark a batch as submitted when its command encoder was submitted together with
     * another render pass. D3D9 batches share one command buffer, so calling submit() here
     * would incorrectly queue a second buffer; this hook preserves ordering while reusing
     * the same asynchronous readback transition. */
    markSubmitted(batch: QueryResolveBatch): void {
        if (batch.status !== 'encoded' || !batch.resolveBuffer || !batch.readbackBuffer) return;
        batch.status = 'submitted';
        this.notifySubmitted(batch.submissionSerial);
        for (const entry of batch.entries) entry.state.submitted = true;
        const validation = batch.finishValidationScope?.() ?? Promise.resolve(null);
        batch.validation = validation;
        batch.completion = this.completeBatch(batch);
    }

    /**
     * Abandon an encoded batch when its command buffer is discarded before the
     * submission boundary.  Without this transition, the records remain encoded
     * forever and a guest polling GetData can never observe progress or release
     * the query-set slots.  The executor should call this from its frame-failure
     * path before dropping the encoder.
     */
    abandon(batch: QueryResolveBatch, reason = 'query-batch-abandoned'): void {
        if (batch.status !== 'encoded') return;
        void batch.finishValidationScope?.();
        batch.status = 'rejected';
        batch.reason = reason;
        batch.completion = Promise.resolve();
        for (const entry of batch.entries) {
            entry.state.encoded = false;
            entry.state.submitted = false;
            entry.state.error = reason;
            if (entry.state.releaseRequested) this.reclaim(entry.state);
        }
        destroyGpuObject(batch.resolveBuffer);
        destroyGpuObject(batch.readbackBuffer);
    }

    /** Awaitable test/integration hook for the asynchronous map transition. */
    async waitForBatch(batch: QueryResolveBatch): Promise<void> {
        await batch.completion;
    }

    poll(id: QueryId): QueryReadback {
        const state = this.records.get(keyOf(id));
        if (!state) return { state: 'unavailable', reason: 'query-not-acquired' };
        if (state.mode === 'fallback') {
            return {
                state: 'fallback', reason: state.reason!,
                ...(state.fallbackValue === undefined ? {} : { value: state.fallbackValue }),
            };
        }
        if (state.error) return { state: 'fallback', reason: state.error };
        if (state.value !== undefined) {
            return { state: 'ready', submissionSerial: state.submissionSerial!, value: state.value };
        }
        return { state: 'pending', submissionSerial: state.submissionSerial ?? state.record.issueSerial };
    }

    /** Retire a record; an in-flight slot is returned only after its readback resolves. */
    release(id: QueryId, record?: QueryRecordContract): void {
        const key = keyOf(id);
        const state = this.records.get(key);
        if (!state) return;
        // Release callbacks capture the logical QueryRecord. If its numeric COM
        // pointer has already been recycled, an old callback must not release the
        // replacement object's fallback/slot.
        if (record && state.record !== record) return;
        if (state.mode === 'gpu' && (state.encoded || state.submitted)) {
            state.releaseRequested = true;
            return;
        }
        this.reclaim(state);
    }

    destroy(): void {
        for (const pools of this.pools.values()) {
            for (const pool of pools) destroyGpuObject(pool.querySet);
        }
        this.pools.clear();
        for (const state of this.records.values()) state.error = 'query-manager-destroyed';
        this.records.clear();
        this.deviceLost = true;
        this.deviceLossReason = 'query-manager-destroyed';
    }

    private createFallbackState(
        id: QueryId,
        key: string,
        kind: QueryKind,
        record: QueryRecordContract,
        reason: string,
    ): RecordState {
        const value = this.fallback?.value?.(kind, record) ?? null;
        return {
            id, key, kind, record, mode: 'fallback', reason,
            ...(value === null ? {} : { fallbackValue: value }),
            began: false, recorded: false, encoded: false, submitted: false, releaseRequested: false,
        };
    }

    private fallbackResult(state: RecordState, record?: QueryRecordContract): QueryOperationResult {
        const value = record ? (this.fallback?.value?.(state.kind, record) ?? state.fallbackValue) : state.fallbackValue;
        return {
            ok: true, mode: 'fallback', reason: state.reason!,
            ...(value === undefined || value === null ? {} : { value }),
        };
    }

    private handleFor(state: RecordState): QueryHandle {
        return {
            id: state.id, kind: state.kind, mode: state.mode,
            ...(state.index === undefined ? {} : { index: state.index }),
            ...(state.pool === undefined ? {} : { querySet: state.pool.querySet }),
            ...(state.reason === undefined ? {} : { reason: state.reason }),
        };
    }

    private allocateSlot(kind: QueryKind): SlotPool | null {
        let pools = this.pools.get(kind);
        if (!pools) {
            pools = [];
            this.pools.set(kind, pools);
        }
        const available = pools.find((pool) => pool.free.length > 0);
        if (available) return available;

        try {
            const querySet = this.device.createQuerySet({
                label: `D3D9 ${kind} queries`,
                type: kind,
                count: this.capacity,
            });
            const pool: SlotPool = {
                kind, querySet, capacity: this.capacity,
                free: Array.from({ length: this.capacity }, (_, i) => this.capacity - i - 1),
            };
            pools.push(pool);
            return pool;
        } catch {
            this.capabilityFailures.set(kind, 'create-query-set-failed');
            return null;
        }
    }

    private rejectedBatch(serial: number, reason: string): QueryResolveBatch {
        return {
            status: 'rejected', submissionSerial: serial, entries: [],
            completion: Promise.resolve(), reason,
        };
    }

    /**
     * WebGPU validation errors are reported through an error scope rather than
     * thrown by begin/end/write operations.  Keep the synchronous API used by the
     * command encoder while asynchronously converting a scope error into a
     * terminal query state, so a failed operation cannot strand GetData in S_FALSE.
     */
    private runValidationScoped(
        state: RecordState,
        reason: string,
        operation: () => void,
    ): boolean {
        const push = this.device.pushErrorScope;
        const pop = this.device.popErrorScope;
        if (typeof push !== 'function' || typeof pop !== 'function') {
            try {
                operation();
                return true;
            } catch {
                this.failState(state, reason);
                return false;
            }
        }

        let pushed = false;
        try {
            push.call(this.device, 'validation');
            pushed = true;
            operation();
        } catch {
            if (pushed) void pop.call(this.device).catch(() => undefined);
            this.failState(state, reason);
            return false;
        }

        try {
            void pop.call(this.device).then((error) => {
                if (!error) return;
                const detail = typeof error.message === 'string' && error.message.length > 0
                    ? `:${error.message}` : '';
                this.failState(state, `${reason}${detail}`);
            }).catch(() => {
                this.failState(state, reason);
            });
        } catch {
            this.failState(state, reason);
        }
        return true;
    }

    private failState(state: RecordState, reason: string): void {
        state.error = reason;
        state.began = false;
        state.recorded = false;
        if (!state.encoded && !state.submitted && state.releaseRequested) this.reclaim(state);
    }

    private async completeBatch(batch: QueryResolveBatch): Promise<void> {
        const resolveBuffer = batch.resolveBuffer;
        const readbackBuffer = batch.readbackBuffer;
        if (!resolveBuffer || !readbackBuffer) return;
        let failureReason = 'query-readback-failed';
        try {
            const validationError = await (batch.validation ?? Promise.resolve(null));
            if (validationError) {
                failureReason = validationError;
                throw new Error(validationError);
            }
            await this.queue.onSubmittedWorkDone();
            await readbackBuffer.mapAsync(MAP_MODE_READ, 0, batch.entries.length * RESULT_BYTES);
            const mapped = readbackBuffer.getMappedRange(0, batch.entries.length * RESULT_BYTES);
            const view = new DataView(mapped);
            for (const entry of batch.entries) {
                if (entry.state.error) {
                    entry.state.encoded = false;
                    entry.state.submitted = false;
                    if (entry.state.releaseRequested) this.reclaim(entry.state);
                    continue;
                }
                entry.state.value = view.getBigUint64(entry.byteOffset, true);
                entry.state.encoded = false;
                entry.state.submitted = false;
                if (entry.state.releaseRequested) this.reclaim(entry.state);
            }
            readbackBuffer.unmap();
        } catch {
            for (const entry of batch.entries) {
                entry.state.encoded = false;
                entry.state.submitted = false;
                entry.state.error = entry.state.error ?? failureReason;
                if (entry.state.releaseRequested) this.reclaim(entry.state);
            }
        } finally {
            batch.status = 'completed';
            destroyGpuObject(resolveBuffer);
            destroyGpuObject(readbackBuffer);
        }
    }

    private markDeviceLost(reason: string): void {
        if (this.deviceLost) return;
        this.deviceLost = true;
        this.deviceLossReason = reason;
        for (const state of this.records.values()) {
            state.error = reason;
            state.began = false;
            state.recorded = false;
            state.encoded = false;
            state.submitted = false;
            if (state.releaseRequested) this.reclaim(state);
        }
        for (const pools of this.pools.values()) {
            for (const pool of pools) destroyGpuObject(pool.querySet);
        }
        this.pools.clear();
    }

    /** Idempotent: the state stays reachable from an in-flight batch, so a late
     * readback continuation can call this again — freeing one slot index twice
     * would hand two future queries the same query-set slot. */
    private reclaim(state: RecordState): void {
        state.releaseRequested = false;
        if (state.pool && state.index !== undefined) {
            state.pool.free.push(state.index);
            state.index = undefined;
        }
        // A numeric COM pointer can be recycled before an old GPU readback
        // retires. Do not let the old batch delete the replacement state.
        if (this.records.get(state.key) === state) this.records.delete(state.key);
    }
}
