import type { Process } from '../../core/process';
import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { trySocketFileEx } from './socket-file-io';
import type { VfsFileHandle } from '../../runtime/filesystem/vfs';

interface PendingRead { handle: number; thread: number; overlapped: number; cancel(): void; }
interface ReadState { generation: number; pending: Set<PendingRead>; }
const states = new WeakMap<Process, ReadState>();
function state(process: Process): ReadState {
    let result = states.get(process);
    if (!result) {
        result = { generation: process.resetGeneration, pending: new Set() }; states.set(process, result);
        const captured = result;
        process.onReset(() => { captured.pending.clear(); captured.generation = process.resetGeneration; });
    }
    return result;
}
/** Cancellation selects the issuing thread for CancelIo, and any thread for CancelIoEx/close. */
export function cancelFileReadEx(process: Process, handle: number, overlapped = 0, thread?: number): number {
    const current = states.get(process); if (!current || current.generation !== process.resetGeneration) return 0;
    let count = 0;
    for (const read of [...current.pending]) if (read.handle === handle && (!overlapped || read.overlapped === overlapped) &&
        (thread === undefined || read.thread === thread)) { count++; read.cancel(); }
    return count;
}

/** ReadFileEx submits immediately; only an alertable wait on the issuing thread runs its APC. */
export function installReadFileEx(exports: Record<string, ThunkImplementation>): void {
    exports['WriteFileEx'] = (_ctx, _mem, args) => {
        const socket = trySocketFileEx('write', args);
        if (socket !== null) return socket;
        System.getInstance().scheduler.setLastError(50); // VFS asynchronous writes are not implemented.
        return 0;
    };
    exports['ReadFileEx'] = (_ctx, _mem, args) => {
        const socket = trySocketFileEx('read', args);
        if (socket !== null) return socket;
        const [handle, buffer, length, overlapped, routine] = args.map(value => value >>> 0);
        const system = System.getInstance(), process = system.process, scheduler = system.scheduler;
        const fail = (error: number) => { scheduler.setLastError(error); return 0; };
        if (!process) return fail(6);
        const valid = (address: number, size: number, permission: 'r' | 'w' | 'rw') =>
            address > 0 && process.addressSpace.validateRange(address, size, permission);
        if (!valid(overlapped, 20, 'rw') || (length > 0 && !valid(buffer, length, 'w'))) return fail(998);
        if (!routine) return fail(87);
        const wrapper = system.resourceProvider.getFileHandle(handle) as { vfsHandle?: VfsFileHandle } | null;
        const file = wrapper?.vfsHandle; if (!file) return fail(6);
        if (!(file.access & (0x80000000 | 1))) return fail(5);
        const memory = process.getCurrentMemory(), view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const offset = view.getUint32(overlapped + 8, true) + view.getUint32(overlapped + 12, true) * 0x100000000;
        if (!Number.isSafeInteger(offset)) return fail(87);
        const vfs = system.fileSystem, cursor = vfs.duplicateHandle(file, offset);
        const thread = scheduler.getCurrentThreadId(), epoch = process.resetGeneration, current = state(process);
        let finished = false;
        const complete = (error: number, status: number, value: Uint8Array = new Uint8Array()) => {
            if (finished) return; finished = true; current.pending.delete(pending);
            if (epoch !== process.resetGeneration) return;
            const bytes = value.slice();
            process.enqueueCompletion([], () => {
                if (bytes.length && !valid(buffer, bytes.length, 'w')) { error = 998; status = 0xc0000005; }
                const amount = error ? 0 : bytes.length;
                if (amount && process.addressSpace.write(buffer, bytes) !== amount) { error = 998; status = 0xc0000005; }
                if (valid(overlapped, 8, 'w')) {
                    const result = new Uint8Array(8), out = new DataView(result.buffer);
                    out.setUint32(0, status >>> 0, true); out.setUint32(4, error ? 0 : amount, true);
                    process.addressSpace.write(overlapped, result);
                } else error = 998;
                scheduler.queueIoCompletionApc(thread, routine, error, error ? 0 : amount, overlapped);
            });
        };
        const pending: PendingRead = { handle, thread, overlapped, cancel: () => complete(995, 0xc0000120) };
        current.pending.add(pending);
        try {
            const result = vfs.readSync(cursor, length, 'park-preferred');
            const deliver = (data: Uint8Array) => complete(length && !data.length ? 38 : 0, length && !data.length ? 0xc0000011 : 0, data);
            if (result !== null) deliver(result);
            else void vfs.read(cursor, length).then(deliver, () => complete(1117, 0xc0000185));
        } catch { current.pending.delete(pending); finished = true; return fail(1117); }
        return 1;
    };
}
