/**
 * Socket overlapped I/O. Requests own host copies of descriptors and scalar addresses;
 * guest writes are published by the owning Process before event/APC/IOCP notification.
 */
import { Mem } from "../core/memory/mem-accessor";
import type { Process } from "../core/process";
import { System } from "../core/system";
import type { DeferredWrite } from "../core/thunking/thunk-dispatcher";
import { captureFileIoCompletion, captureSocketIoCompletion, type IoCompletionTarget } from "./kernel32/sync";
import { WsaSocketTable, WsaFailure, WSA, type WsaNativeIoLease } from "./wsa-network";

export interface WsaIoResult { bytes: number; flags: number; writes: DeferredWrite[]; error?: number; }
export interface WsaIoAnswer { value: number; writes?: DeferredWrite[]; error?: number; }
/** Win32 file APIs share request ordering/cancellation but use kernel I/O publication rules. */
export interface WsaIoPolicy {
    /** Native handle I/O outlives Winsock provider cleanup while its OS handle remains open. */
    nativeHandleIo?: boolean;
    /** issue() takes ownership even when validation throws; terminal operations release exactly once. */
    nativeIoLease?: WsaNativeIoLease;
    deferStatusUntilDequeue?: boolean;
    forcePending?: boolean | ((result: WsaIoResult) => boolean);
    cancellable?: boolean;
    completionError?: (error: number) => number;
    completionRoutineKind?: 'file';
    initializePending?: boolean;
    immediateReturnError?: (result: WsaIoResult) => number | undefined;
    completionBytes?: (result: WsaIoResult) => number;
    immediateErrorHasNoCompletion?: boolean;
}
interface Request {
    socket: number; overlapped: number; routine: number; event: number;
    direction: "read" | "urgent" | "write"; thread: number; generation: number; nativeHandleIo: boolean;
    attempt?: () => WsaIoResult; scheduler: ReturnType<typeof System.getInstance>["scheduler"];
    done: boolean; publishing: boolean; cancel?: () => void; result?: WsaIoResult;
    policy?: WsaIoPolicy; deferredStatus?: boolean; processGeneration: number;
    operationTable?: WsaSocketTable; operationGeneration?: number; nativeIoLease?: WsaNativeIoLease; objectId: number; nativeGeneration: number;
    completionTarget?: IoCompletionTarget;
    waiters: Array<(value: WsaIoResult) => void>;
}
const STATUS_PENDING = 0x103;
export function wsaErrorStatus(error: number): number {
    switch (error) {
        case 0: return 0;
        case 995: case WSA.EINTR: return 0xc0000120; // STATUS_CANCELLED
        case WSA.EMSGSIZE: return 0x80000005; // STATUS_BUFFER_OVERFLOW
        case WSA.ECONNRESET: return 0xc000020d;
        case WSA.ECONNREFUSED: return 0xc0000236;
        case WSA.ENETDOWN: return 0xc000023c;
        case WSA.ETIMEDOUT: return 0xc00000b5;
        case WSA.EFAULT: return 0xc0000005;
        case WSA.ENOTCONN: return 0xc0000140;
        case WSA.ESHUTDOWN: return 0xc00000b0;
        default: return 0xc0010000 | (error & 0xffff);
    }
}
export function wsaStatusError(status: number): number {
    switch (status >>> 0) {
        case 0: return 0;
        case STATUS_PENDING: return 996;
        case 0xc0000120: return 995;
        case 0x80000005: return WSA.EMSGSIZE;
        case 0xc000020d: return WSA.ECONNRESET;
        case 0xc0000236: return WSA.ECONNREFUSED;
        case 0xc000023c: return WSA.ENETDOWN;
        case 0xc00000b5: return WSA.ETIMEDOUT;
        case 0xc0000005: return WSA.EFAULT;
        case 0xc0000140: return WSA.ENOTCONN;
        case 0xc00000b0: return WSA.ESHUTDOWN;
        default: return ((status & 0xffff0000) >>> 0) === 0xc0010000 ? status & 0xffff : WSA.EINVAL;
    }
}
const word = (address: number, value: number): DeferredWrite => ({ address, value: value >>> 0, size: 4 });
export function publishWsaWrites(writes: readonly DeferredWrite[]): boolean {
    for (const w of writes) {
        const ok = w.size === 1 ? Mem.writeUint8(w.address, w.value) :
            w.size === 2 ? Mem.writeUint16(w.address, w.value) : Mem.writeUint32(w.address, w.value);
        if (!ok) return false;
    }
    return true;
}
const providers = new WeakMap<WsaSocketTable, WsaOverlapped>();
export function getWsaOverlapped(table: WsaSocketTable, process: Process): WsaOverlapped {
    let provider = providers.get(table);
    if (!provider) { provider = new WsaOverlapped(table, process); providers.set(table, provider); }
    return provider;
}
export class WsaOverlapped {
    private requests = new Map<number, Request>();
    private pumping = false;
    private pumpScheduled = false;
    constructor(readonly table: WsaSocketTable, readonly process: Process) {
        table.subscribe(() => this.pump());
    }
    private isCurrent(request: Request): boolean {
        return request.processGeneration === this.process.resetGeneration && request.nativeGeneration === this.table.nativeIoGeneration &&
            (request.nativeHandleIo || request.generation === this.table.generation) &&
            (!request.operationTable || request.operationGeneration === request.operationTable.generation);
    }
    issue(socket: number, overlapped: number, routine: number, direction: Request["direction"],
        attempt: () => WsaIoResult, immediateWrites: (result: WsaIoResult) => DeferredWrite[], _preserveOffset = true, cancel?: () => void, policy?: WsaIoPolicy): WsaIoAnswer {
        // Ownership begins before any validation: callers must never release after issue(), including on throw.
        const original = policy?.nativeIoLease;
        let released = false;
        const owned = original ? { table: original.table, release() { if (!released) { released = true; original.release(); } } } : undefined;
        const previous = this.requests.get(overlapped);
        try { return this.issueOwned(socket, overlapped, routine, direction, attempt, immediateWrites, _preserveOffset, cancel,
            policy ? { ...policy, nativeIoLease: owned } : undefined); }
        catch (error) {
            const current = this.requests.get(overlapped);
            if (current && current !== previous) {
                current.attempt = undefined; current.cancel = undefined; current.policy = undefined; current.operationTable = undefined;
                current.nativeIoLease = undefined; current.completionTarget = undefined; this.requests.delete(overlapped);
            }
            owned?.release(); throw error;
        }
    }
    private issueOwned(socket: number, overlapped: number, routine: number, direction: Request["direction"],
        attempt: () => WsaIoResult, immediateWrites: (result: WsaIoResult) => DeferredWrite[], _preserveOffset = true, cancel?: () => void, policy?: WsaIoPolicy): WsaIoAnswer {
        const existing = this.requests.get(overlapped);
        if (existing && !existing.done) throw new WsaFailure(WSA.EINVAL);
        const scheduler = System.getInstance().scheduler;
        const event = Mem.readUint32(overlapped + 16) ?? 0;
        const originalHigh = Mem.readUint32(overlapped + 4) ?? 0;
        if (!routine && (event & ~3)) {
            const object = System.getInstance().resourceProvider.getKernelObject(event & ~3);
            if (!object || object.kind !== "event") throw new WsaFailure(6);
            scheduler.resetEvent(event & ~3);
        }
        const request: Request = { socket, overlapped, routine, event, direction,
            thread: scheduler.getCurrentThreadId(), scheduler, generation: this.table.generation,
            objectId: (policy?.nativeIoLease?.table ?? this.table.nativeHandleView).fileObjectId(socket), nativeGeneration: this.table.nativeIoGeneration,
            nativeHandleIo: !!policy?.nativeHandleIo, operationTable: policy?.nativeIoLease?.table,
            operationGeneration: policy?.nativeIoLease?.table.generation, nativeIoLease: policy?.nativeIoLease,
            attempt, done: false, publishing: false, cancel, waiters: [], policy, processGeneration: this.process.resetGeneration,
            completionTarget: !routine && !(event & 1) ? captureFileIoCompletion(socket) : undefined };
        this.requests.delete(overlapped);
        if (this.requests.size >= 4096) {
            for (const [key, value] of this.requests) if (value.done) { this.requests.delete(key); break; }
            if (this.requests.size >= 4096) throw new WsaFailure(WSA.ENOBUFS);
        }
        this.requests.set(overlapped, request);
        if (policy?.initializePending !== false && !publishWsaWrites([word(overlapped, STATUS_PENDING), word(overlapped + 4, 0)])) throw new WsaFailure(WSA.EFAULT);
        const blockedByEarlier = [...this.requests.values()].some(r => r !== request && !r.done && r.objectId === request.objectId && r.direction === direction);
        if (!blockedByEarlier) {
            this.pumping = true;
            try {
                const result = attempt();
                if (typeof policy?.forcePending === "function" ? policy.forcePending(result) : policy?.forcePending) {
                    this.complete(request, result, false);
                    return { value: -1, error: 997 };
                }
                this.complete(request, result, true);
                const error = policy?.immediateReturnError?.(result) ?? result.error ?? 0;
                return { value: error ? -1 : 0, error, writes: error && error !== result.error ? [] : immediateWrites(result) };
            } catch (error) {
                if (!(error instanceof WsaFailure)) throw error;
                if (error.code !== WSA.EWOULDBLOCK) {
                    if(policy?.immediateErrorHasNoCompletion){
                        this.requests.delete(overlapped);request.done=true;request.attempt=undefined;request.cancel=undefined;
                        this.releaseNativeIo(request); request.policy = undefined; request.completionTarget = undefined;
                        publishWsaWrites([word(overlapped+4,originalHigh)]);
                        return {value:-1,error:error.code};
                    }
                    const result = { bytes: 0, flags: 0, writes: [], error: error.code };
                    this.complete(request, result, true);
                    return { value: -1, error: error.code };
                }
            } finally { this.pumping = false; }
        }
        // Async requests ignore FIONBIO and SO_RCVTIMEO/SO_SNDTIMEO.
        this.pump();
        return { value: -1, error: 997 }; // WSA_IO_PENDING
    }
    cancel(socket: number, overlapped = 0, thread?: number): number {
        const objectId = this.table.nativeHandleView.fileObjectId(socket);
        let count = 0;
        for (const request of this.requests.values()) {
            if (request.objectId !== objectId || request.done || request.publishing || request.policy?.cancellable === false || !this.isCurrent(request) ||
                (overlapped && request.overlapped !== overlapped) || (thread !== undefined && request.thread !== thread)) continue;
            const cancel = request.cancel;
            // A driver cancel can synchronously signal readiness. Block this request until its terminal status is selected.
            count++; request.publishing = true;
            try { cancel?.(); }
            finally { request.publishing = false; this.complete(request, { bytes: 0, flags: 0, writes: [], error: 995 }, false); }
        }
        return count;
    }
    /** Observe a provider request without retaining a waiter after timeout/APC cancellation. */
    observeCompletion(socket: number, overlapped: number, callback: (result: WsaIoResult) => void): (() => void) | null {
        let objectId: number;
        try { objectId = this.table.nativeHandleView.fileObjectId(socket); } catch { return null; }
        const request = this.requests.get(overlapped);
        if (!request || request.objectId !== objectId) return null;
        if (!this.isCurrent(request)) { callback({ bytes: 0, flags: 0, writes: [], error: 995 }); return () => {}; }
        if (request.done && !request.deferredStatus) { callback(request.result!); return () => {}; }
        request.waiters.push(callback);
        return () => { const index = request.waiters.indexOf(callback); if (index >= 0) request.waiters.splice(index, 1); };
    }
    private completionWrites(request: Request, result: WsaIoResult): DeferredWrite[] {
        // Winsock leaves Offset/OffsetHigh untouched; flags belong to lpFlags/the provider result.
        return [...result.writes, ...(request.deferredStatus ? [] : this.statusWrites(request, result))];
    }
    private statusWrites(request: Request, result: WsaIoResult): DeferredWrite[] {
        return [word(request.overlapped + 4, result.bytes), word(request.overlapped, wsaErrorStatus(result.error ?? 0))];
    }
    private releaseNativeIo(request: Request): void {
        const lease = request.nativeIoLease;
        request.nativeIoLease = undefined; request.operationTable = undefined;
        if (request.policy?.nativeIoLease) request.policy.nativeIoLease = undefined;
        lease?.release();
    }
    private complete(request: Request, result: WsaIoResult, immediate: boolean): void {
        if (request.done || request.publishing) return;
        if (request.processGeneration !== this.process.resetGeneration) {
            this.releaseNativeIo(request); request.attempt = undefined; request.cancel = undefined; request.policy = undefined;
            request.completionTarget = undefined; this.requests.delete(request.overlapped); return;
        }
        request.publishing = true;
        // Late IOCP binding affects the completion destination, but leaves issue-time IOSB publication policy intact.
        request.completionTarget ??= captureSocketIoCompletion(this.table, request.objectId);
        // No operation can execute again after this point; publication retains only copied results.
        this.releaseNativeIo(request);
        request.deferredStatus = !immediate && !!request.policy?.deferStatusUntilDequeue;
        const notify = (answer: WsaIoResult) => {
            if (request.done || !this.isCurrent(request)) return;
            request.done = true; request.publishing = false;
            // Completed lookups retain scalar results, never host payloads or guest write batches.
            request.result = { bytes: answer.bytes, flags: answer.flags, error: answer.error, writes: [] };
            request.attempt = undefined; request.cancel = undefined;
            const target = request.completionTarget; request.completionTarget = undefined;
            if (request.routine) {
                if (request.policy?.completionRoutineKind === 'file') request.scheduler.queueIoCompletionApc(
                    request.thread, request.routine, request.policy.completionError?.(answer.error ?? 0) ?? answer.error ?? 0,
                    answer.bytes, request.overlapped);
                else request.scheduler.queueWsaCompletionApc(request.thread, request.routine,
                    answer.error ?? 0, request.policy?.completionBytes?.(answer) ?? answer.bytes, request.overlapped, answer.flags);
            }
            else {
                if (request.event & ~3) request.scheduler.setEvent(request.event & ~3);
                if (!(request.event & 1)) target?.post(answer.bytes, request.overlapped,
                    request.policy?.completionError?.(answer.error ?? 0) ?? answer.error ?? 0,
                    request.deferredStatus ? {
                        deferredWrites: this.statusWrites(request, answer),
                        isCurrent: () => this.isCurrent(request),
                        didPublish: () => {
                            request.deferredStatus = false;
                            for (const waiter of request.waiters.splice(0)) waiter(request.result!);
                        },
                    } : undefined);
            }
            request.policy = undefined;
            if (!request.deferredStatus) for (const waiter of request.waiters.splice(0)) waiter(request.result);
            if (!this.pumping) this.pump();
        };
        const finish = (published: boolean) => {
            if (request.done || !this.isCurrent(request)) return;
            if (published) { notify(result); return; }
            // A destination freed after issue must complete with an error, not strand event/APC waiters.
            const fault: WsaIoResult = { bytes: 0, flags: 0, writes: [], error: WSA.EFAULT };
            const status = this.completionWrites(request, fault);
            if (immediate) { publishWsaWrites(status); notify(fault); }
            else this.process.enqueueCompletion(status, () => notify(fault), () => this.isCurrent(request));
        };
        if (immediate) finish(publishWsaWrites(this.completionWrites(request, result)));
        else this.process.enqueueCompletion(this.completionWrites(request, result), finish, () => this.isCurrent(request));
    }
    /** A host file read can unblock a TransmitFile without another network event. */
    resume(): void { this.pump(); }
    private pump(): void {
        if (this.pumping) {
            if (!this.pumpScheduled) { this.pumpScheduled = true; queueMicrotask(() => { this.pumpScheduled = false; this.pump(); }); }
            return;
        }
        this.pumping = true;
        const blocked = new Set<string>();
        try {
            for (const request of this.requests.values()) {
                if (!this.isCurrent(request)) {
                    // WSACleanup/process reset cancels without publishing into recycled RAM.
                    request.done = true; request.publishing = false;
                    request.result = { bytes: 0, flags: 0, writes: [], error: 995 };
                    this.releaseNativeIo(request);
                    request.attempt = undefined; request.cancel = undefined; request.policy = undefined; request.completionTarget = undefined;
                    for (const waiter of request.waiters.splice(0)) waiter(request.result);
                    this.requests.delete(request.overlapped); continue;
                }
                if (request.done || request.publishing) continue;
                const key = request.objectId + ":" + request.direction;
                if (!(request.operationTable ?? this.table).isValid(request.socket)) {
                    this.complete(request, { bytes: 0, flags: 0, writes: [], error: 995 }, false); continue;
                }
                if (blocked.has(key)) continue;
                try { this.complete(request, request.attempt!(), false); }
                catch (error) {
                    if (!(error instanceof WsaFailure)) throw error;
                    if (error.code === WSA.EWOULDBLOCK) blocked.add(key);
                    else this.complete(request, { bytes: 0, flags: 0, writes: [], error: error.code }, false);
                }
            }
        } finally { this.pumping = false; }
    }
    result(socket: number, overlapped: number, wait: boolean, bytesOut: number, flagsOut: number): WsaIoAnswer | Promise<WsaIoAnswer> {
        this.table.get(socket);
        const objectId = this.table.nativeHandleView.fileObjectId(socket);
        const answer = (result: WsaIoResult): WsaIoAnswer => ({
            value: result.error ? 0 : 1, error: result.error ?? 0,
            writes: [...(bytesOut ? [word(bytesOut, result.bytes)] : []), ...(flagsOut && !result.error ? [word(flagsOut, result.flags)] : [])],
        });
        const request = this.requests.get(overlapped);
        if (request && request.objectId === objectId) {
            if (request.done && !request.deferredStatus) return answer(request.result!);
            if (!wait) return { value: 0, error: 996 };
            return new Promise(resolve => request.waiters.push(result => resolve(answer(result))));
        }
        const status = Mem.readUint32(overlapped) ?? 0;
        return answer({ bytes: Mem.readUint32(overlapped + 4) ?? 0, flags: 0,
            writes: [], error: wsaStatusError(status) });
    }
}
