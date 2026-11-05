/**
 * Handle inheritance across CreateProcess (bInheritHandles = TRUE).
 *
 * Win32 contract (CreateProcess, "Inheritance" / SECURITY_ATTRIBUTES.bInheritHandle /
 * SetHandleInformation(HANDLE_FLAG_INHERIT)): every handle the parent marked inheritable
 * is duplicated into the child's handle table AT THE SAME VALUE, naming the same object
 * with the same access. The parent passes the value itself — on the command line, in the
 * environment, through IPC — so the child must find it there, and a wait on it must see the
 * object's real state, including changes made later by another process.
 *
 * Here each process is its own worker with its own handle table and sync objects, so an
 * inherited handle is re-created in the child at the parent's value:
 *   - process / thread handles become foreign records in the child's VirtualProcessManager,
 *     signalled when the process-IPC layer reports that pid dead (with its exit code);
 *     TerminateProcess on one asks the process that holds the target's runtime.
 *   - events become one object held from several workers: the creating process ("owner")
 *     is authoritative and relays every state change to the others over process IPC.
 *   - anything else (mutex, semaphore, file, pipe, section, ...) is NOT carried yet; the
 *     parent logs each such handle once, and the child sees ERROR_INVALID_HANDLE as before.
 *
 * Known limits of the event relay: changes are asynchronous (a SetEvent in one process is
 * visible to another a message hop later), and an auto-reset event signalled while waiters
 * in two processes are parked can release one waiter in each before the owner's reset
 * arrives. Both are invisible to the parent/child "signal and wait" pattern this exists for.
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { getProcessIpc, type ProcessIpc } from '../../core/process-ipc';
import { currentProcessId } from '../../core/process-identity';
import type { InheritedHandleSpec } from '../../core/child-process';
import type { KernelEventObject, KernelThreadObject } from '../../core/scheduler/types';

const STILL_ACTIVE = 259;
import type { SharedEventChange, SharedEventIdentity } from '../../core/scheduler/sync-objects';
import { getVirtualProcessManager } from './process/virtual-process-manager';
import { Mem } from '../../core/memory/mem-accessor';

/**
 * SECURITY_ATTRIBUTES.bInheritHandle, as the HANDLE_FLAG_INHERIT bit for a new handle.
 * NULL means "not inheritable"; like Wine, a structure whose nLength is smaller than
 * SECURITY_ATTRIBUTES (12 bytes) is not read.
 */
export function inheritFlagFromSecurityAttributes(lpAttributes: number): number {
    if (!lpAttributes) return 0;
    const length = Mem.readUint32(lpAttributes >>> 0);
    if (length === null || length < 12) return 0;
    return (Mem.readUint32((lpAttributes + 8) >>> 0) ?? 0) !== 0 ? 1 : 0;
}

/** Set HANDLE_FLAG_INHERIT on a handle just created from a SECURITY_ATTRIBUTES. */
export function applyInheritFlag(handle: number, lpAttributes: number): void {
    if (!handle || !inheritFlagFromSecurityAttributes(lpAttributes)) return;
    System.getInstance().resourceProvider.setHandleFlags(handle >>> 0, 1, 1);
}

const TOPIC = 'kernel32.inherited-handles';

type Message =
    | { op: 'subscribe'; id: number }
    | { op: 'change'; id: number; change: SharedEventChange }
    | { op: 'state'; ownerPid: number; id: number; signaled: boolean }
    | { op: 'terminate'; pid: number; exitCode: number };

interface OwnedEvent { event: KernelEventObject; subscribers: Set<number>; }

// @transient(cross-worker relay state: a savestate does not cover child processes)
const owned = new Map<number, OwnedEvent>();
// @transient(cross-worker relay state: a savestate does not cover child processes)
const proxies = new Map<string, KernelEventObject>();
// @transient(cross-worker relay state)
let nextShareId = 1;
// @transient(cross-worker relay state)
let applyingRemote = false;
// @transient(cross-worker relay state)
let service: { ipc: ProcessIpc; generation: number } | null = null;
// @transient(diagnostics)
const reportedUncarried = new Set<string>();

const proxyKey = (ownerPid: number, id: number): string => `${ownerPid}:${id}`;

/** Apply a state another process decided, without relaying it back out. */
function applyState(event: KernelEventObject, signaled: boolean, change: SharedEventChange | 'state'): void {
    const sched = System.getInstance().scheduler;
    const handle = sched.syncObjects.handlesOfEvent(event)[0];
    applyingRemote = true;
    try {
        if (change === 'consume') {
            // An auto-reset waiter elsewhere took the signal: clear it, wake nobody.
            event.signaled = false;
        } else if (signaled) {
            if (handle !== undefined) sched.setEvent(handle);
            else { event.signaled = true; if (event.manualReset) event.pendingWake = true; }
        } else if (handle !== undefined) sched.resetEvent(handle);
        else { event.signaled = false; event.pendingWake = false; }
    } finally {
        applyingRemote = false;
    }
}

function broadcast(id: number, entry: OwnedEvent, except?: number): void {
    const ipc = getProcessIpc();
    const message: Message = { op: 'state', ownerPid: currentProcessId, id, signaled: entry.event.signaled };
    for (const pid of entry.subscribers) if (pid !== except && !ipc.post(pid, TOPIC, message)) entry.subscribers.delete(pid);
}

function onLocalChange(_event: KernelEventObject, share: SharedEventIdentity, change: SharedEventChange): void {
    if (applyingRemote) return;
    const { ownerPid, id } = share;
    if (ownerPid === currentProcessId) {
        const entry = owned.get(id);
        if (entry) broadcast(id, entry);
        return;
    }
    getProcessIpc().post(ownerPid, TOPIC, { op: 'change', id, change } satisfies Message);
}

function serve(payload: unknown, source: number): unknown {
    const message = payload as Message;
    switch (message?.op) {
        case 'subscribe': {
            const entry = owned.get(message.id);
            if (!entry) return false;
            entry.subscribers.add(source);
            getProcessIpc().post(source, TOPIC, { op: 'state', ownerPid: currentProcessId, id: message.id, signaled: entry.event.signaled } satisfies Message);
            return true;
        }
        case 'change': {
            const entry = owned.get(message.id);
            if (!entry) return false;
            applyState(entry.event, message.change === 'set', message.change);
            broadcast(message.id, entry, source);
            return true;
        }
        case 'state': {
            const event = proxies.get(proxyKey(message.ownerPid, message.id));
            if (event && event.signaled !== message.signaled) applyState(event, message.signaled, 'state');
            return true;
        }
        case 'terminate':
            return getVirtualProcessManager().terminateChildByPid(message.pid, message.exitCode >>> 0);
    }
    return false;
}

/** The relay topic and the process-exit hook, once per guest lifetime of this process. */
function ensureService(): ProcessIpc | null {
    const ipc = getProcessIpc();
    // The scheduler (and its sync-object manager) can be replaced by a session reset.
    System.getInstance().scheduler.syncObjects.onSharedEventChange = onLocalChange;
    if (service?.ipc === ipc && service.generation === ipc.guestGeneration) return ipc;
    try {
        ipc.register(TOPIC, serve);
    } catch (error) {
        Logger.warn(LogCategory.KERNEL32, `Inherited handles: IPC service unavailable (${error})`);
        return null;
    }
    if (service?.ipc !== ipc) {
        ipc.onProcessExit((pid, exitCode) => {
            getVirtualProcessManager().foreignProcessExited(pid, exitCode);
            for (const entry of owned.values()) entry.subscribers.delete(pid);
        });
    }
    service = { ipc, generation: ipc.guestGeneration };
    return ipc;
}

/**
 * The parent's half: describe every inheritable handle for the child `childPid`.
 * `exclude` holds handles CreateProcess made for this very child — Windows creates those
 * after the child's handle table is populated, so the child never inherits its own handles.
 */
export function collectInheritedHandles(childPid: number, exclude: readonly number[] = []): InheritedHandleSpec[] {
    const system = System.getInstance();
    const provider = system.resourceProvider;
    const manager = getVirtualProcessManager();
    const specs: InheritedHandleSpec[] = [];
    for (const handle of provider.inheritableKernelHandles()) {
        if (exclude.includes(handle)) continue;
        const access = provider.getHandleAttributes(handle)?.grantedAccess ?? 0x001fffff;
        const foreign = manager.describeForInheritance(handle);
        if (foreign) {
            specs.push({ handle, access, ...foreign });
            continue;
        }
        const object = provider.getKernelObject(handle) as { kind?: string } | null;
        if (object?.kind === 'thread') {
            // A handle to one of THIS process's own threads (DuplicateHandle of
            // GetCurrentThread() is how a launcher says "wait for me"). The child learns of
            // its end when this process exits; an earlier exit of a secondary thread is not
            // relayed yet, so such a wait completes late rather than early.
            const thread = object as KernelThreadObject;
            specs.push({
                handle, access, kind: 'thread', pid: currentProcessId, tid: thread.threadId, ownerPid: currentProcessId,
                imageName: system.executableName || 'app.exe', imagePath: system.executablePath || undefined,
                commandLine: system.executableArgs || '', currentDirectory: system.fileSystem.currentDir,
                terminated: thread.terminated === true, exitCode: thread.exitCode ?? STILL_ACTIVE,
            });
            continue;
        }
        if (object?.kind === 'event') {
            if (!ensureService()) continue;
            const syncObjects = system.scheduler.syncObjects;
            const event = syncObjects.shareEvent(handle)!;
            let share = syncObjects.shareOf(event);
            if (!share) {
                share = { ownerPid: currentProcessId, id: nextShareId++ };
                syncObjects.markShared(event, share);
                owned.set(share.id, { event, subscribers: new Set() });
            }
            // A direct child is a subscriber from the start, so no change made between
            // this snapshot and the child's first instruction is lost. Holders further down
            // subscribe themselves when they adopt the handle.
            if (share.ownerPid === currentProcessId) owned.get(share.id)?.subscribers.add(childPid);
            specs.push({ handle, access, kind: 'event', ownerPid: share.ownerPid, id: share.id,
                manualReset: event.manualReset, signaled: event.signaled });
            continue;
        }
        const kind = object?.kind ?? 'unknown';
        if (!reportedUncarried.has(kind)) {
            reportedUncarried.add(kind);
            Logger.warn(LogCategory.KERNEL32,
                `CreateProcess(bInheritHandles): inheritable ${kind} handle 0x${handle.toString(16)} is not carried to the child ` +
                `(only process, thread and event handles cross workers); the child will see ERROR_INVALID_HANDLE for it`);
        }
    }
    if (specs.length) ensureService();
    return specs;
}

/** The child's half: install every inherited handle at its parent's value. Returns how many. */
export function adoptInheritedHandles(specs: readonly InheritedHandleSpec[]): number {
    if (!specs.length) return 0;
    const system = System.getInstance();
    const manager = getVirtualProcessManager();
    const ipc = ensureService();
    let adopted = 0;
    for (const spec of specs) {
        // The child's entry is a copy of the parent's, inherit attribute included (Wine's
        // copy_handle_table copies only inheritable entries and keeps their attributes), so
        // a grandchild started with bInheritHandles inherits it again.
        const attributes = { grantedAccess: spec.access >>> 0, flags: 1 };
        let ok = false;
        if (spec.kind === 'event') {
            const key = proxyKey(spec.ownerPid, spec.id);
            const syncObjects = system.scheduler.syncObjects;
            const event: KernelEventObject = proxies.get(key)
                ?? (spec.ownerPid === currentProcessId ? owned.get(spec.id)?.event : undefined)
                ?? { kind: 'event', manualReset: spec.manualReset, signaled: spec.signaled, pendingWake: spec.manualReset && spec.signaled };
            syncObjects.markShared(event, { ownerPid: spec.ownerPid, id: spec.id });
            ok = syncObjects.adoptEventAt(spec.handle, event, attributes);
            if (ok && spec.ownerPid !== currentProcessId && !proxies.has(key)) {
                proxies.set(key, event);
                ipc?.post(spec.ownerPid, TOPIC, { op: 'subscribe', id: spec.id } satisfies Message);
            }
        } else {
            ok = manager.adoptForeign(spec.handle, spec, spec.access);
            if (ok) system.resourceProvider.setHandleAttributes(spec.handle, attributes);
            // A death the parent had already been told about is in the spec; one that
            // happened since reaches us on the IPC link the parent opened before booting us.
            if (ok && !spec.terminated && ipc?.hasExited(spec.pid)) manager.foreignProcessExited(spec.pid, undefined);
        }
        if (ok) adopted++;
        else Logger.warn(LogCategory.KERNEL32, `Inherited ${spec.kind} handle 0x${spec.handle.toString(16)} could not be installed (value in use)`);
    }
    Logger.log(LogCategory.KERNEL32, `Adopted ${adopted}/${specs.length} inherited handles: ` +
        specs.map(s => `0x${s.handle.toString(16)}=${s.kind}${s.kind === 'event' ? '' : `(pid ${s.pid})`}`).join(', '));
    return adopted;
}

/**
 * TerminateProcess on an inherited handle to a process another worker runs: ask the
 * process that holds its runtime. Resolves to whether the target was terminated.
 */
export async function terminateForeignProcess(pid: number, ownerPid: number, exitCode: number): Promise<boolean> {
    const ipc = ensureService();
    if (!ipc || ownerPid === pid) return false;
    try {
        return (await ipc.request(ownerPid, TOPIC, { op: 'terminate', pid, exitCode } satisfies Message)) === true;
    } catch {
        return false;
    }
}

/**
 * Session reset: the shared events belonged to handle tables that no longer exist. The IPC
 * registration is left alone — it is per guest lifetime and ensureService renews it.
 */
export function resetInheritedHandleState(): void {
    owned.clear(); proxies.clear(); reportedUncarried.clear();
}
