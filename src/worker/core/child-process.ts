import { CHILD_IO_BYTES, createChildVfsServer } from './child-vfs';
import type { VirtualFileSystem } from '../runtime/filesystem/vfs';
import type { RegistryMutation, RegistryStore } from '../runtime/filesystem/registry';
import type { NamedObjectSpec } from '../modules/kernel32/named-objects';

export interface ChildProcessRequest {
    imagePath: string;
    commandLine: string;
    currentDirectory: string;
    rawCommandLine?: string;
    environment?: [string, string][];
}

export interface ChildBoot extends ChildProcessRequest {
    type: 'child_boot';
    bytes: Uint8Array;
    io: SharedArrayBuffer;
    config?: Record<string, unknown>;
    registry?: ReturnType<RegistryStore['serialize']>;
    namedObjects?: NamedObjectSpec[];
}

export interface ChildProcessRecord extends ChildProcessRequest {
    started: number;
    finished?: number;
    exitCode?: number;
    error?: string;
    backend?: 'worker' | 'host';
    needsSession?: string;
    fileMutations?: number;
    mutationPaths?: string[];
    session?: boolean;
    guestExitCode?: number;
    fault?: unknown;
    logs?: unknown;
}

export interface ChildProcessTask {
    record: ChildProcessRecord;
    completion: Promise<number>;
    terminate(exitCode: number): void;
    cancel(): void;
    promote?(): boolean;
    /** Guest lifetime can end before this worker's descendant VFS broker is released. */
    onGuestExit?: (exitCode: number) => void;
}

export interface ChildExecutionContext {
    signal: AbortSignal;
    record: ChildProcessRecord;
    checkActive(): void;
    onStop(cleanup: () => void | Promise<void>): void;
}

export class ChildProcessCancelled extends Error {
    constructor() { super('Parent session ended'); }
}

export class ChildNeedsSession extends Error {
    constructor(readonly record: ChildProcessRecord, detail: string) {
        super(`Child "${record.imagePath}" cannot run headless: ${detail}`);
    }
}

export const childProcessHistory: ChildProcessRecord[] = [];
const active = new Set<ChildProcessTask>();
const unfinished = new Set<ChildProcessRecord>();
let publishSession: ((port: MessagePort, record: ChildProcessRecord) => void) | undefined;
let sessionFinished: (() => void) | undefined;
let bootContext: (() => Pick<ChildBoot, 'config' | 'registry' | 'namedObjects'>) | undefined;
export function setChildBootContext(provider: typeof bootContext): void { bootContext = provider; }

/** Applies a child's registry write to THIS process's store — the registry is system-wide,
 *  so the child's hive is ours, and only we hold the gameId and the autosave that persist it. */
let applyChildRegistry: ((mutation: RegistryMutation) => void) | undefined;
export function setChildRegistrySink(apply: typeof applyChildRegistry): void { applyChildRegistry = apply; }

/** The page keeps the parent worker as the VFS broker, and talks directly to this port. */
export function setChildSessionPublisher(publish: typeof publishSession, finished?: () => void): void {
    publishSession = publish; sessionFinished = finished;
}
export function hasChildSession(): boolean { return [...active].some(task => task.record.session); }
export function promoteChildSession(record: ChildProcessRecord): boolean {
    for (const task of active) if (task.record === record) return task.promote?.() ?? false;
    return false;
}

export function pendingChildHandoff(): ChildProcessRecord | null {
    // Set order breaks ties even when the host clock gives two launches the same timestamp.
    let newest: ChildProcessRecord | null = null;
    for (const record of unfinished) newest = record;
    return newest;
}

/** Stops execution immediately; await the result before replacing/resetting the shared VFS. */
export function stopChildProcesses(keepSession = false): Promise<void> {
    const tasks = [...active].filter(task => !keepSession || !task.record.session);
    for (const task of tasks) task.cancel();
    unfinished.clear();
    return Promise.allSettled(tasks.map(task => task.completion)).then(() => {});
}

/** Registers the lifetime before invoking a backend: ExitProcess may be the next guest instruction. */
export function startChildExecution(
    vfs: VirtualFileSystem, request: ChildProcessRequest,
    execute: (context: ChildExecutionContext) => Promise<number>,
    backend: 'worker' | 'host' = 'worker',
): ChildProcessTask {
    const record: ChildProcessRecord = { imagePath: request.imagePath, commandLine: request.commandLine,
        currentDirectory: request.currentDirectory, started: performance.now(), backend };
    childProcessHistory.push(record);
    if (childProcessHistory.length > 32) childProcessHistory.shift();
    unfinished.add(record);
    const controller = new AbortController();
    const cleanups: Array<() => void | Promise<void>> = [];
    const drains: Promise<void>[] = [];
    let stopped = false;
    let settled = false;
    let forcedExit: number | undefined;
    const clean = (cleanup: () => void | Promise<void>) => {
        try { drains.push(Promise.resolve(cleanup())); }
        catch (error) { drains.push(Promise.reject(error)); }
        // Cleanup can begin synchronously on TerminateProcess, before completion awaits it.
        void drains[drains.length - 1]!.catch(() => {});
    };
    const stopResources = () => {
        if (stopped) return;
        stopped = true;
        for (const cleanup of cleanups) clean(cleanup);
        cleanups.length = 0;
    };
    const context: ChildExecutionContext = {
        signal: controller.signal, record,
        checkActive: () => { if (controller.signal.aborted) throw new ChildProcessCancelled(); },
        onStop: cleanup => { if (stopped) clean(cleanup); else cleanups.push(cleanup); },
    };
    const task: ChildProcessTask = {
        record, completion: null as unknown as Promise<number>,
        terminate: code => {
            if (settled || controller.signal.aborted) return;
            forcedExit = code >>> 0;
            unfinished.delete(record);
            controller.abort();
            stopResources();
        },
        cancel: () => {
            if (settled) { unfinished.delete(record); return; }
            forcedExit = undefined;
            unfinished.delete(record);
            controller.abort();
            stopResources();
        },
    };
    active.add(task);
    task.completion = (async () => {
        try {
            let code = 0;
            let failure: unknown;
            try { code = await execute(context); } catch (error) { failure = error; }
            stopResources();
            // In-flight VFS work must settle before handles become signalled, including forced exit.
            await Promise.all(drains);
            if (forcedExit === undefined) {
                context.checkActive();
                if (failure !== undefined) throw failure;
            }
            await vfs.flushAll();
            if (forcedExit === undefined) context.checkActive();
            record.exitCode = (forcedExit ?? code) >>> 0;
            unfinished.delete(record);
            return record.exitCode;
        } catch (error) {
            record.error = String(error);
            throw error;
        } finally {
            settled = true;
            record.finished = performance.now();
            stopResources();
            active.delete(task);
            if (record.session && (!controller.signal.aborted || forcedExit !== undefined)) sessionFinished?.();
        }
    })();
    return task;
}

export function startChildProcess(vfs: VirtualFileSystem, request: ChildProcessRequest,
    createWorker: () => Worker = () => new Worker(self.location.href, { type: 'module', name: 'guest-child' }),
    onSessionRequest?: (record: ChildProcessRecord) => boolean,
): ChildProcessTask {
    const inherited = bootContext?.();
    let worker: Worker | null = null;
    let offered = false;
    let alive = true;
    let task!: ChildProcessTask;
    const offer = () => {
        if (!worker || !task.record.session || offered || !alive) return;
        const channel = new MessageChannel();
        worker.postMessage({ type: 'child_session', port: channel.port1 }, [channel.port1]);
        publishSession!(channel.port2, task.record);
        offered = true;
    };
    task = startChildExecution(vfs, request, async context => {
        context.onStop(() => { alive = false; });
        const file = await vfs.open(request.imagePath, 0x80000000, 3);
        context.checkActive();
        if (!file) throw new Error(`Cannot open child image: ${request.imagePath}`);
        const bytes = new Uint8Array(vfs.getFileSize(file.path));
        let offset = 0;
        while (offset < bytes.length) {
            const chunk = await vfs.read(file, bytes.length - offset);
            context.checkActive();
            if (!chunk.length) throw new Error(`Short read of child image: ${request.imagePath}`);
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        const io = new SharedArrayBuffer(CHILD_IO_BYTES);
        const serve = createChildVfsServer(vfs, io, path => {
            context.record.fileMutations = (context.record.fileMutations ?? 0) + 1;
            const paths = context.record.mutationPaths ??= [];
            if (paths.length < 16 && !paths.includes(path)) paths.push(path);
        });
        const child = createWorker();
        worker = child;
        let animationFrame: number | null = null;
        context.onStop(() => {
            if (animationFrame !== null) cancelAnimationFrame(animationFrame);
            child.onmessage = null;
            child.onerror = null;
            child.onmessageerror = null;
            child.terminate();
            return serve.close();
        });
        return new Promise<number>((resolve, reject) => {
            let done = false;
            const finish = (code?: number, error?: Error) => {
                if (done) return;
                done = true;
                context.signal.removeEventListener('abort', aborted);
                if (error) reject(error); else resolve(code!);
            };
            const aborted = () => finish(undefined, new ChildProcessCancelled());
            context.signal.addEventListener('abort', aborted, { once: true });
            child.onerror = event => finish(undefined, new Error(event.message));
            child.onmessageerror = () => finish(undefined, new Error('Child worker message could not be decoded'));
            child.onmessage = event => {
                if (done || context.signal.aborted) return;
                const message = event.data;
                if (message.type === 'child_io') void serve(message.request);
                else if (message.type === 'child_registry') applyChildRegistry?.(message.mutation);
                else if (message.type === 'child_session' && publishSession) {
                    // An already-exiting child can itself be the VFS broker for a live
                    // descendant. Forward its port without starting either image again.
                    task.record.session = true;
                    unfinished.delete(task.record);
                    publishSession(message.port, message.record);
                }
                else if (message.type === 'child_animation_request') {
                    if (animationFrame === null) animationFrame = requestAnimationFrame(now => {
                        animationFrame = null;
                        if (!done && !context.signal.aborted) child.postMessage({ type: 'child_animation_frame', time: performance.timeOrigin + now });
                    });
                }
                else if (message.type === 'process_exit') {
                    context.record.fault = message.fault;
                    context.record.logs = message.logs;
                    if (message.broker) {
                        context.record.guestExitCode = message.exitCode >>> 0;
                        task.onGuestExit?.(message.exitCode >>> 0);
                        return;
                    }
                    finish(message.exitCode >>> 0);
                } else if (message.type === 'error' || message.type === 'crash') {
                    finish(undefined, new Error(message.message ?? message.reason ?? 'Child process crashed'));
                } else if (message.type === 'window_title' || message.type === 'show_message_box') {
                    // MessageBox is a titled top-level window on Windows; ours is host-served
                    // DOM with no HWND, so it never reaches the window_title callback. Both are
                    // the child saying it wants the one screen, and the queued request replays
                    // to the page on attach.
                    const detail = message.type === 'window_title'
                        ? `it opened a titled top-level window (${JSON.stringify(message.title)})`
                        : `it opened a message box (${JSON.stringify(message.caption)}: ${JSON.stringify(message.text)})`;
                    context.record.needsSession = detail;
                    if (!task.record.session && !(onSessionRequest?.(task.record) ?? task.promote?.())) {
                        finish(undefined, new ChildNeedsSession(context.record, detail));
                    }
                }
            };
            child.postMessage({ type: 'child_boot', ...request, ...inherited, bytes, io } satisfies ChildBoot);
            offer();
        });
    });
    task.promote = () => {
        if (!alive || !publishSession) return false;
        task.record.session = true;
        unfinished.delete(task.record);
        offer();
        return true;
    };
    return task;
}

/** Harness convenience; CreateProcess binds the returned task to its process record instead. */
export function runChildProcess(vfs: VirtualFileSystem, request: ChildProcessRequest,
    createWorker?: () => Worker,
): Promise<number> {
    return startChildProcess(vfs, request, createWorker).completion;
}
