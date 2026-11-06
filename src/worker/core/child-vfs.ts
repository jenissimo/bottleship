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

const CREATE_ALWAYS = 2;
const TRUNCATE_EXISTING = 5;
const FILE_BEGIN = 0, FILE_CURRENT = 1;
/** The dispatch has not answered the request; serve it as usual. */
const NOT_ANSWERED = Symbol('not answered');

/**
 * A child's truncating open of a file that has contents, not yet published.
 *
 * Truncating at open and writing at the first WriteFile are two separate round trips from
 * the child, and the parent's threads run in between. UE2's render probe child truncates
 * Game.ini at exit while the parent polls for its Detected.ini, and the parent read an empty
 * Game.ini, saved its now-empty config over it and failed to start (HP Chamber of Secrets:
 * "Can't find 'ini:Engine.Engine.GameEngine'"). On Windows the gap is microseconds.
 *
 * So the truncation waits, with the child's file pointer kept here, until the child uses the
 * file again. Then truncation and that use (normally the first write) run in one synchronous
 * step on this thread, which is the parent's. Until then every other process sees the old
 * contents; after it, the new ones; never the empty file in between. The child itself sees an
 * empty file all along. A child's CloseHandle doesn't reach this server, so a handle the child
 * never writes is truncated when the child exits.
 */
interface DeferredTruncation { path: string; access: number; disposition: number; position: number }
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
    const deferred = new Map<number, DeferredTruncation>();
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
    /** Publishes a deferred truncation; synchronous unless the overlay can't open it now. */
    const commit = (id: number): VfsFileHandle | Promise<VfsFileHandle> => {
        const d = deferred.get(id)!;
        deferred.delete(id);
        const place = (handle: VfsFileHandle | null): VfsFileHandle => {
            if (!handle) throw new Error(`Child VFS: truncating ${d.path} failed`);
            if (d.position) vfs.setPosition(handle, d.position, FILE_BEGIN);
            handles.set(id, handle);
            return handle;
        };
        const now = vfs.openSync(d.path, d.access, d.disposition);
        return now ? place(now) : vfs.open(d.path, d.access, d.disposition).then(place);
    };
    const commitPath = (path: string): Promise<unknown> | null => {
        const key = vfs.resolvePath(path).toLowerCase();
        const waits: Promise<unknown>[] = [];
        for (const [id, d] of [...deferred]) {
            if (d.path.toLowerCase() !== key) continue;
            const done = commit(id);
            if (done instanceof Promise) waits.push(done);
        }
        return waits.length ? Promise.all(waits) : null;
    };
    /**
     * What a request does to the deferred truncations: answered on the spot (the child's own
     * view of its still-empty file), or the truncations it touches are published first. Stays
     * synchronous whenever it can, so a publish and the write after it share one step.
     */
    const settleDeferred = (method: string, args: unknown[]): unknown => {
        const first = args[0];
        if (first && typeof first === 'object' && 'childHandle' in first) {
            const id = (first as RemoteHandle).childHandle;
            const d = deferred.get(id);
            if (!d) return NOT_ANSWERED;
            if (method === 'tell') return d.position;
            if (method === 'read' || method === 'readSync') return { childBytes: [] };
            if (method === 'setPosition') {
                const offset = Number(args[1]) || 0;
                const from = Number(args[2]) || FILE_BEGIN;
                // FILE_END of the empty file is FILE_BEGIN; clamped at 0 like VFS.setPosition.
                const next = from === FILE_CURRENT ? d.position + offset : offset;
                d.position = Math.max(0, next);
                return d.position;
            }
            const done = commit(id);
            return done instanceof Promise ? done.then(() => NOT_ANSWERED) : NOT_ANSWERED;
        }
        if (deferred.size && pathMethods.has(method) && typeof first === 'string') {
            // The child's own view: the file it truncated exists and is empty.
            if (method === 'getFileSize' || method === 'fileExists') {
                const key = vfs.resolvePath(first).toLowerCase();
                for (const d of deferred.values()) {
                    if (d.path.toLowerCase() === key) return method === 'fileExists' ? true : 0;
                }
                return NOT_ANSWERED;
            }
            const done = commitPath(first);
            if (done) return done.then(() => NOT_ANSWERED);
        }
        return NOT_ANSWERED;
    };
    const deferTruncation = (path: string, access: number, disposition: number): unknown => {
        const full = vfs.resolvePath(path);
        const id = nextHandle++;
        deferred.set(id, { path: full, access, disposition, position: 0 });
        return { childHandle: id, kind: 'file', path: full, access, source: 'overlay', position: 0 };
    };
    /** One request's answer. No await before the write unless an open has to go async. */
    const serve = async (method: string, args: unknown[]): Promise<unknown> => {
        if (!methods.has(method)) throw new Error(`Unsupported child VFS operation: ${method}`);
        let settled = settleDeferred(method, args);
        if (settled instanceof Promise) settled = await settled;
        if (settled !== NOT_ANSWERED) return settled;
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
        const opening = method === 'open' || method === 'openSync';
        if (['write', 'writeSync', 'truncateAt', 'deleteFile', 'removeDirectory',
            'createDirectory', 'createDirectorySync', 'ensureParentDirsSync', 'ensureDirTreeSync'].includes(method)
            || (opening && decoded[2] !== 3)) {
            const value = decoded[0];
            onMutation?.(typeof value === 'string' ? value : (value as VfsFileHandle).path);
        }
        if (opening && (decoded[2] === CREATE_ALWAYS || decoded[2] === TRUNCATE_EXISTING)
            && vfs.getFileSize(String(decoded[0])) > 0) {
            return deferTruncation(String(decoded[0]), Number(decoded[1]), Number(decoded[2]));
        }
        // A child's WriteFile lands like the parent's own (kernel32 WriteFile fast path):
        // a copy into the cache, persistence deferred. Waiting on the OPFS commit instead
        // leaves a CREATE_ALWAYS-truncated file empty to every other process for the
        // commit's milliseconds.
        if (method === 'write' || method === 'writeSync') {
            const [handle, data] = decoded as [VfsFileHandle, Uint8Array];
            const buffered = vfs.writeSync(handle, data);
            return buffered >= 0 ? buffered : await vfs.write(handle, data);
        }
        return pack(await fn.apply(vfs, decoded));
    };
    const dispatch = async ({ method, args }: Request): Promise<void> => {
        let response: { value?: unknown; error?: string };
        try {
            response = { value: await serve(method, args) };
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
            // Files the child truncated and never wrote: their truncation is due now.
            for (const id of [...deferred.keys()]) {
                try {
                    await commit(id);
                } catch (error) {
                    Logger.warn(LogCategory.SYSTEM, `Child VFS server close: ${error}`);
                }
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
