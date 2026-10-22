import type { Process } from '../../core/process';
import type { DeferredWrite, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { getWsaNativeSocketTable } from '../wsa-stub-shared';
import { waitOperation } from '../wsa-network-api';
import { WsaFailure, WsaSocketTable, WSA, type WsaNativeIoLease } from '../wsa-network';
import { getWsaOverlapped, publishWsaWrites, type WsaIoResult } from '../wsa-overlapped';
import { hasIoCompletionAssociation } from './sync';

const word = (address: number, value: number): DeferredWrite => ({ address, value, size: 4 });
function patches(address: number, data: Uint8Array): DeferredWrite[] {
    const writes: DeferredWrite[] = [];
    let index = 0;
    for (; index + 4 <= data.length; index += 4) writes.push(word(address + index,
        (data[index] | data[index + 1] << 8 | data[index + 2] << 16 | data[index + 3] << 24) >>> 0));
    for (; index < data.length; index++) writes.push({ address: address + index, value: data[index], size: 1 });
    return writes;
}
/** Win32 file APIs translate NT socket status to DOS errors, rather than WSA codes. */
export function socketIoWin32Error(error: number): number {
    switch (error) {
        case 0: return 0;
        case WSA.EFAULT: return 998;
        case WSA.EINVAL: return 87;
        case WSA.ENOTSOCK: return 6;
        case WSA.EMSGSIZE: return 234;
        case WSA.ECONNRESET: return 64;
        case WSA.ECONNREFUSED: return 1225;
        case WSA.ENETDOWN: return 1231;
        case WSA.ETIMEDOUT: return 121;
        case WSA.ENOTCONN: case WSA.EDESTADDRREQ: return 59; // ERROR_UNEXP_NET_ERR from AFD's invalid connection status
        case WSA.ESHUTDOWN: return 233;
        case WSA.EINTR: return 995;
        default: return error;
    }
}
type FileIoAnswer = ThunkResult | Promise<ThunkResult>;
interface SynchronousRequest { objectId: number; table: WsaSocketTable; generation: number; thread: number; epoch: number; cancel(): void; }
const synchronousRequests = new WeakMap<Process, Set<SynchronousRequest>>();
/** CancelIoEx(NULL) also cancels a synchronous ReadFile using the kernel's private IOSB. */
export function cancelSocketFileIo(process: Process, socket: number, overlapped = 0, thread?: number): number {
    if (overlapped) return 0;
    const table = getWsaNativeSocketTable(process, socket)?.nativeHandleView;
    if (!table) return 0;
    const objectId = table.fileObjectId(socket), generation = table.generation;
    let count = 0;
    for (const request of [...(synchronousRequests.get(process) ?? [])]) {
        if (request.objectId !== objectId || request.table !== table || request.generation !== generation ||
            request.epoch !== process.resetGeneration ||
            (thread !== undefined && request.thread !== thread)) continue;
        count++; request.cancel();
    }
    return count;
}
/** Shared provider means mixed WSA/Win32 requests retain issue order and cancellation scope. */
export function socketFileIo(process: Process, table: WsaSocketTable, direction: 'read' | 'write',
    args: readonly number[], routine = 0): FileIoAnswer {
    const [socket, buffer, length, bytesOut, overlapped] = args.slice(0, 5).map(value => value >>> 0);
    // Kernel file I/O uses the native HANDLE without importing a Winsock alias.
    // Keep the base table as the shared overlapped-provider identity.
    const descriptor = table.nativeHandleView;
    let lease: WsaNativeIoLease | undefined, callerOwnsLease = true;
    const system = System.getInstance(), scheduler = system.scheduler;
    const thread = scheduler.getCurrentThreadId(), epoch = process.resetGeneration;
    const fail = (error: number): ThunkResult => {
        if (epoch === process.resetGeneration) scheduler.setLastErrorForThread(thread, socketIoWin32Error(error));
        return { value: 0, stackCleanup: 20 };
    };
    const guard = (ptr: number, size: number, permission: 'r' | 'w' | 'rw' | 'rx') => {
        if (!ptr || ptr + size > 0x100000000 || !process.addressSpace.validateRange(ptr, size, permission)) throw new WsaFailure(WSA.EFAULT);
    };
    try {
        if (bytesOut) { guard(bytesOut, 4, 'w'); Mem.writeUint32(bytesOut, 0); }
        const info = descriptor.get(socket);
        // File mode is captured at issue; the alias may no longer exist when
        // an already-issued native request resumes through its I/O lease.
        const state = { type: info.type, overlapped: info.overlapped };
        if (routine) {
            guard(routine, 1, 'rx');
            if (!state.overlapped || hasIoCompletionAssociation(socket)) return fail(87);
        }
        if (!overlapped && state.overlapped) return fail(87);
        if (overlapped) guard(overlapped, 20, 'rw');
        if (length) guard(buffer, length, direction === 'read' ? 'w' : 'r');
        const payload = direction === 'write' && length ? Mem.readBytes(buffer, length)?.slice() : new Uint8Array(0);
        if (!payload) return fail(WSA.EFAULT);
        // Issued kernel I/O keeps its authorization when this HANDLE closes while
        // another real alias still owns the physical file object.
        lease = table.acquireNativeIo(socket);
        const native = lease.table;
        let sent = 0, sentEmpty = false;
        const attempt = (): WsaIoResult => {
            if (epoch !== process.resetGeneration) throw new WsaFailure(995);
            if (direction === 'read') {
                const packet = native.receive(socket, length);
                return { bytes: packet.data.length, flags: 0, writes: patches(buffer, packet.data),
                    ...(packet.truncated ? { error: WSA.EMSGSIZE } : {}) };
            }
            while (sent < payload.length || (!payload.length && !sentEmpty)) {
                const end = state.type === 1 ? Math.min(sent + 16384, payload.length) : payload.length;
                const count = native.send(socket, payload.subarray(sent, end));
                sentEmpty = true; sent += count;
                if (!count && sent < payload.length) throw new WsaFailure(WSA.EWOULDBLOCK);
            }
            return { bytes: sent, flags: 0, writes: [] };
        };
        const answer = (result: WsaIoResult, deferred: boolean): ThunkResult => {
            const writes = [...result.writes, ...(bytesOut && !result.error ? [word(bytesOut, result.bytes)] : [])];
            if (result.error) fail(result.error);
            if (!deferred && !publishWsaWrites(writes)) return fail(WSA.EFAULT);
            return { value: result.error ? 0 : 1, stackCleanup: 20, ...(deferred ? { deferredWrites: writes } : {}) };
        };
        if (!overlapped) {
            const controller = new AbortController();
            const result = native.withBlockingSignal(controller.signal, () =>
                waitOperation(native, socket, attempt, 0, direction === 'write', undefined, true));
            if (!(result instanceof Promise)) return answer(result, false);
            let requests = synchronousRequests.get(process);
            if (!requests) { requests = new Set(); synchronousRequests.set(process, requests); }
            const pending: SynchronousRequest = { objectId: native.fileObjectId(socket), table: descriptor,
                generation: descriptor.generation, thread, epoch, cancel: () => {
                requests!.delete(pending); controller.abort();
            } };
            requests.add(pending);
            callerOwnsLease = false;
            return result.then(value => answer(value, true), error => {
                if (!(error instanceof WsaFailure)) throw error; return fail(error.code);
            }).finally(() => { requests!.delete(pending); lease!.release(); });
        }
        const provider = getWsaOverlapped(table, process);
        const event = Mem.readUint32(overlapped + 16) ?? 0;
        // issue() accepts lease ownership on every path, including early errors.
        callerOwnsLease = false;
        const issued = provider.issue(socket, overlapped, routine, direction, attempt,
            result => bytesOut && !result.error ? [word(bytesOut, result.bytes)] : [], true, undefined, {
                nativeHandleIo: true, nativeIoLease: lease,
                immediateErrorHasNoCompletion: true,
                cancellable: state.overlapped,
                forcePending: state.overlapped && !routine ? result => direction === 'write' || !!result.error : false,
                deferStatusUntilDequeue: state.overlapped && !event && hasIoCompletionAssociation(socket),
                completionError: routine ? error => error === WSA.EMSGSIZE ? 0 : socketIoWin32Error(error) : socketIoWin32Error,
                ...(routine ? { completionRoutineKind: 'file' as const, initializePending: false } : {}),
            });
        if (!state.overlapped && issued.error === 997) return new Promise(resolve => {
            provider.observeCompletion(socket, overlapped, result => resolve(answer({ ...result, writes: [] }, true)));
        });
        if (routine && (!issued.error || issued.error === 997 || issued.error === WSA.EMSGSIZE)) return { value: 1, stackCleanup: 20 };
        if (issued.error) return fail(issued.error);
        if (!publishWsaWrites(issued.writes ?? [])) return fail(WSA.EFAULT);
        return { value: 1, stackCleanup: 20 };
    } catch (error) {
        if (!(error instanceof WsaFailure)) throw error;
        return fail(error.code);
    } finally {
        if (callerOwnsLease) lease?.release();
    }
}
export function trySocketFileEx(direction: 'read' | 'write', args: readonly number[]): FileIoAnswer | null {
    const process = System.getInstance().process;
    const table = process && getWsaNativeSocketTable(process, args[0] >>> 0);
    if (!process || !table) return null;
    if (!args[4]) { System.getInstance().scheduler.setLastError(87); return { value: 0, stackCleanup: 20 }; }
    return socketFileIo(process, table, direction, [args[0], args[1], args[2], 0, args[3]], args[4]);
}
export function trySocketFileIo(direction: 'read' | 'write', args: readonly number[]): FileIoAnswer | null {
    const process = System.getInstance().process;
    const table = process && getWsaNativeSocketTable(process, args[0] >>> 0);
    return process && table ? socketFileIo(process, table, direction, args) : null;
}
