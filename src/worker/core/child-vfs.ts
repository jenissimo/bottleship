import { VirtualFileSystem, type VfsFileHandle } from '../runtime/filesystem/vfs';
import { Logger, LogCategory } from './logger';

// The parent owns the filesystem and file objects; the child owns its cwd and address space.
// Blocking only the child worker lets synchronous CRT/loader reads use the same VFS as async APIs.
export const CHILD_IO_BYTES = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;
const methods = new Set([
    'open', 'openSync', 'read', 'readSync', 'write', 'writeSync', 'tell', 'setPosition',
    'duplicateHandle', 'flushFile', 'flushAll', 'truncateAt', 'fileExists', 'hasRomFile',
    'resolveStoredFile', 'getFileSize', 'directoryExists', 'listDirectory', 'statEntry',
    'createDirectory', 'createDirectorySync', 'deleteFile', 'removeDirectory',
    'classifyOpenFailure', 'parentDirectoryExists', 'ensureParentDirsSync', 'ensureDirTreeSync',
    'resolveRomMediaPath',
]);
const pathMethods = new Set([
    'open', 'openSync', 'flushFile', 'truncateAt', 'fileExists', 'hasRomFile',
    'resolveStoredFile', 'getFileSize', 'directoryExists', 'listDirectory', 'statEntry',
    'createDirectory', 'createDirectorySync', 'deleteFile', 'removeDirectory',
    'classifyOpenFailure', 'parentDirectoryExists', 'ensureParentDirsSync', 'ensureDirTreeSync',
    'resolveRomMediaPath',
]);
const asyncMethods = new Set(['open', 'createDirectory', 'deleteFile', 'removeDirectory', 'truncateAt']);

type RemoteHandle = VfsFileHandle & { childHandle: number };
type Request = { method: string; args: unknown[] };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Ceiling on waiting out a child's in-flight VFS dispatches. Generous: a real commit of a
 *  large write must never be cut short, and only a wedged one should ever reach it. */
let CHILD_VFS_CLOSE_BUDGET_MS = 30_000;
/** A test that must observe the ceiling fire cannot wait out the shipping one. */
export function setChildVfsCloseBudgetForTests(ms: number): void { CHILD_VFS_CLOSE_BUDGET_MS = ms; }

/**
 * Wait for `work`, but not forever: resolves true if the budget expired first.
 *
 * `work` is never cancelled — a bound that abandons unwritten bytes is worse than the hang
 * it replaces. Only the WAIT is bounded, so the caller can report a named failure and
 * release whatever it was holding while the operation keeps running.
 */
export function settleWithin(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        work.then(() => false, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), budgetMs); }),
    ]).finally(() => clearTimeout(timer));
}

export function createChildVfsServer(vfs: VirtualFileSystem, buffer: SharedArrayBuffer,
    onMutation?: (path: string) => void,
) {
    const control = new Int32Array(buffer, 0, 2);
    const payload = new Uint8Array(buffer, 8);
    const handles = new Map<number, VfsFileHandle>();
    let nextHandle = 1;
    let closed = false;
    const pending = new Map<Promise<void>, string>();
    const pack = (value: unknown): unknown => {
        if (value instanceof Uint8Array) return { childBytes: Array.from(value) };
        if (value && typeof value === 'object' && (value as VfsFileHandle).kind === 'file'
            && 'position' in value) {
            const handle = value as VfsFileHandle;
            const id = nextHandle++;
            handles.set(id, handle);
            return { childHandle: id, kind: 'file', path: handle.path, access: handle.access,
                source: handle.source, position: vfs.tell(handle) };
        }
        return value;
    };
    const dispatch = async ({ method, args }: Request): Promise<void> => {
        let response: { value?: unknown; error?: string };
        try {
            if (!methods.has(method)) throw new Error(`Unsupported child VFS operation: ${method}`);
            const decoded = args.map(arg => {
                if (arg && typeof arg === 'object' && 'childHandle' in arg) {
                    const handle = handles.get((arg as RemoteHandle).childHandle);
                    if (!handle) throw new Error('Invalid child file handle');
                    return handle;
                }
                return arg;
            });
            // A cold compressed ROM read may need async I/O, even for a synchronous guest API.
            const target = method === 'readSync' ? 'read' : method;
            const fn = vfs[target as keyof VirtualFileSystem] as (...args: unknown[]) => unknown;
            if (['write', 'writeSync', 'truncateAt', 'deleteFile', 'removeDirectory',
                'createDirectory', 'createDirectorySync', 'ensureParentDirsSync', 'ensureDirTreeSync'].includes(method)
                || ((method === 'open' || method === 'openSync') && decoded[2] !== 3)) {
                const value = decoded[0];
                onMutation?.(typeof value === 'string' ? value : (value as VfsFileHandle).path);
            }
            response = { value: pack(await fn.apply(vfs, decoded)) };
        } catch (error) {
            response = { error: String(error) };
        }
        let bytes = encoder.encode(JSON.stringify(response));
        if (bytes.length > payload.length) {
            bytes = encoder.encode(JSON.stringify({ error: 'Child VFS response exceeds mailbox capacity' }));
        }
        payload.set(bytes);
        Atomics.store(control, 1, bytes.length);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
    };
    return Object.assign((request: Request): Promise<void> => {
        if (closed) return Promise.resolve();
        const work = dispatch(request);
        pending.set(work, request.method);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        return work;
    }, {
        /**
         * Bounded, because this is awaited on the path that makes a child's handle stop
         * being STILL_ACTIVE: a dispatch that never settles (a wedged overlay commit is
         * the realistic one) would otherwise hang the parent's guest forever, with the
         * fault three layers below the symptom.
         *
         * The bound is on the WAIT only — the dispatch keeps running and its bytes still
         * reach the VFS, so nothing is abandoned; what is given up is the ordering
         * guarantee that in-flight work landed before the handle signalled. That is worth
         * naming, so the warning names the operations still outstanding.
         */
        close: async (): Promise<void> => {
            closed = true;
            const stalled = await settleWithin(Promise.all([...pending.keys()]),
                CHILD_VFS_CLOSE_BUDGET_MS);
            if (stalled) {
                Logger.warn(LogCategory.SYSTEM,
                    `Child VFS server close: ${pending.size} dispatch(es) still in flight after ` +
                    `${CHILD_VFS_CLOSE_BUDGET_MS}ms [${[...new Set(pending.values())].join(', ')}] — ` +
                    `releasing the child anyway; their writes may land after its handle signals`);
            }
            handles.clear();
        },
        /** What close() would still be waiting on, for a caller reporting a stalled drain. */
        pendingOperations: (): string[] => [...new Set(pending.values())],
    });
}

export function createChildVfsClient(
    buffer: SharedArrayBuffer, send: (request: Request) => void, cwd: string,
): VirtualFileSystem {
    const control = new Int32Array(buffer, 0, 2);
    const payload = new Uint8Array(buffer, 8);
    const local = new VirtualFileSystem();
    local.currentDir = cwd.endsWith('\\') ? cwd : `${cwd}\\`;
    let failed = false;
    const call = (method: string, args: unknown[]): any => {
        if (failed) throw new Error('Child VFS transport is closed after timeout');
        if (pathMethods.has(method)) args[0] = local.resolvePath(String(args[0]));
        Atomics.store(control, 0, 0);
        send({ method, args: args.map(arg => arg && typeof arg === 'object' && 'childHandle' in arg
            ? { childHandle: (arg as RemoteHandle).childHandle } : arg) });
        if (Atomics.wait(control, 0, 0, 120_000) === 'timed-out') {
            failed = true;
            throw new Error(`Child VFS ${method} timed out`);
        }
        const response = JSON.parse(decoder.decode(payload.slice(0, Atomics.load(control, 1))));
        if (response.error) throw new Error(response.error);
        const value = response.value;
        if (value && typeof value === 'object' && 'childHandle' in value) {
            Object.defineProperty(value, 'position', {
                get: () => call('tell', [value]),
                set: position => { call('setPosition', [value, position, 0]); },
            });
        }
        return value && typeof value === 'object' && 'childBytes' in value
            ? Uint8Array.from(value.childBytes) : value;
    };
    const read = (handle: VfsFileHandle, length: number): Uint8Array => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < length) {
            const requested = Math.min(CHUNK, length - total);
            const part = call('read', [handle, requested]) as Uint8Array;
            chunks.push(part);
            total += part.length;
            if (part.length < requested) break;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
        return out;
    };
    const write = (handle: VfsFileHandle, data: Uint8Array): number => {
        let total = 0;
        while (total < data.length) {
            const size = Math.min(CHUNK, data.length - total);
            const written = call('write', [handle, data.slice(total, total + size)]) as number;
            total += written;
            if (written < size) break;
        }
        return total;
    };
    const overrides: Record<string, unknown> = {
        read: async (handle: VfsFileHandle, length: number) => read(handle, length), readSync: read,
        write: async (handle: VfsFileHandle, data: Uint8Array) => write(handle, data), writeSync: write,
        readIntoSync: (handle: VfsFileHandle, target: Uint8Array, offset: number, length: number) => {
            const bytes = read(handle, length);
            target.set(bytes, offset);
            return bytes.length;
        },
        readInto: async (handle: VfsFileHandle, target: Uint8Array, offset: number, length: number) => {
            const bytes = read(handle, length);
            target.set(bytes, offset);
            return bytes.length;
        },
        // Promise-returning methods retain their contract even though the transport is blocking.
        flushAll: async () => { call('flushAll', []); },
        flushFile: async (path: string) => { call('flushFile', [path]); },
        ensureOverlayIndex: async () => {},
        prefetchRomFiles: async () => 0,
        pinRomFiles: async () => 0,
        startProgressivePrefetch: () => {},
    };
    const proxy = new Proxy(local, {
        get(target, key) {
            if (typeof key === 'string' && key in overrides) return overrides[key];
            if (typeof key === 'string' && methods.has(key)) {
                return asyncMethods.has(key)
                    ? async (...args: unknown[]) => call(key, args)
                    : (...args: unknown[]) => call(key, args);
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(proxy) : value;
        },
    });
    return proxy;
}
