import type { ModuleRegistry } from "./module-registry";

/**
 * DLL_THREAD_ATTACH / DLL_THREAD_DETACH: Windows calls every loaded DLL's entry point when
 * a thread starts and again when it exits, in initialization order on attach and in reverse
 * on detach, except for DLLs that called DisableThreadLibraryCalls. Some libraries depend on
 * it: the Boehm GC inside Unity's mono.dll registers a thread only from its DllMain and later
 * aborts ("Thread %d calling into managed code is not registered with the GC") when an
 * unregistered thread calls into managed code.
 *
 * Every entry-point call is serialized process-wide, as under the NT loader lock: a thread
 * does not start its attach or detach calls while another thread runs a DLL's
 * DLL_PROCESS_ATTACH or its own notification calls. The thread then waits and retries, and
 * the set of DLLs it notifies is taken when it gets its turn, not when it was created.
 *
 * The calls are laid out as a return chain on the thread's own stack: each entry point's
 * return address is the next entry point, followed by its three arguments, and the last one
 * returns into the code that continues the thread. No host callback frame is involved, so
 * the chain is ordinary guest execution.
 */

export const DLL_THREAD_ATTACH = 2;
export const DLL_THREAD_DETACH = 3;

/** Per-thread notification phase (Thread.dllNotify). */
export const enum DllNotifyPhase {
    /** Host-created thread, or one from a savestate that predates notifications: never notified. */
    NONE = 0,
    /** Guest-created thread that has not reached its attach yet. */
    START = 1,
    /** Running its DLL_THREAD_ATTACH calls; holds the loader serialization. */
    ATTACHING = 2,
    /** Past its attach (or the initial process thread): owes DLL_THREAD_DETACH on exit. */
    RUNNING = 3,
    /** Running its DLL_THREAD_DETACH calls; holds the loader serialization. */
    DETACHING = 4,
}

/** Thread.dllNotify bit: the thread is parked until the loader is free for it. */
export const DLL_NOTIFY_WAITING = 0x10;

export interface ThreadNotifyTarget {
    base: number;
    entry: number;
}

/** What a savestate keeps of the notification bookkeeping. */
export interface DllThreadNotifyState {
    initOrder: number[];
    disabled: number[];
    /** [DLL base, thread whose load queued its DLL_PROCESS_ATTACH (0 = process start)] */
    attaching: number[][];
    owner: number;
    /** Thread whose queued loads hold the loader while no chain runs (-1 = none). */
    loadHolder?: number;
}

export class DllThreadNotify {
    private initOrder: number[] = [];
    private disabled = new Set<number>();
    /** DLLs whose DllMain(DLL_PROCESS_ATTACH) is queued or running, with the loading thread. */
    private attaching = new Map<number, number>();
    /** Thread running DLL_THREAD_ATTACH/DETACH calls (0 = none). */
    private owner = 0;
    /**
     * With no notification chain running, the loader belongs to ONE thread with queued process
     * attaches: the first to queue, kept until all of its own have returned. Queued loads of other
     * threads wait behind it rather than behind each other, so two completed loads never block
     * each other, and the owner of a running chain can still load reentrantly.
     */
    private loadHolder = -1;

    /** `onIdle` runs whenever the loader may have become free for a waiting thread. */
    constructor(private readonly onIdle: () => void = () => undefined) {}

    reset(): void {
        this.initOrder.length = 0;
        this.disabled.clear();
        this.attaching.clear();
        this.owner = 0;
        this.loadHolder = -1;
    }

    captureState(): DllThreadNotifyState {
        return {
            initOrder: [...this.initOrder],
            disabled: [...this.disabled],
            attaching: [...this.attaching].map(([base, tid]) => [base, tid]),
            owner: this.owner,
            loadHolder: this.loadHolder,
        };
    }

    restoreState(state: DllThreadNotifyState | undefined): void {
        this.reset();
        if (!state) return;
        this.initOrder.push(...state.initOrder);
        for (const base of state.disabled) this.disabled.add(base >>> 0);
        for (const [base, tid] of state.attaching) this.attaching.set(base! >>> 0, tid! >>> 0);
        this.owner = state.owner >>> 0;
        this.loadHolder = state.loadHolder ?? -1;
    }

    /**
     * A DLL's DllMain(DLL_PROCESS_ATTACH) was queued by `loaderThreadId`: it takes its place
     * in initialization order, and no other thread runs notification calls until that call
     * has returned (noteDllAttached) or will not run (noteDllUnloaded).
     */
    noteDllInitialized(base: number, loaderThreadId: number): void {
        const b = base >>> 0;
        const at = this.initOrder.indexOf(b);
        if (at >= 0) this.initOrder.splice(at, 1);
        this.initOrder.push(b);
        this.attaching.set(b, loaderThreadId >>> 0);
    }

    /** The queued DLL_PROCESS_ATTACH of `base` will run on `threadId` (an async load completes there). */
    claim(base: number, threadId: number): void {
        const b = base >>> 0;
        if (!this.attaching.has(b)) return;
        this.attaching.set(b, threadId >>> 0);
        this.onIdle();
    }

    /** DllMain(DLL_PROCESS_ATTACH) of this DLL returned, or will never be called. */
    noteDllAttached(base: number): void {
        if (this.attaching.delete(base >>> 0)) this.onIdle();
    }

    /** A DLL was unloaded: it leaves the order, and its DisableThreadLibraryCalls goes with it. */
    noteDllUnloaded(base: number): void {
        const b = base >>> 0;
        const at = this.initOrder.indexOf(b);
        if (at >= 0) this.initOrder.splice(at, 1);
        this.disabled.delete(b);
        if (this.attaching.delete(b)) this.onIdle();
    }

    disableThreadLibraryCalls(base: number): void {
        this.disabled.add(base >>> 0);
    }

    /** The thread the loader belongs to now: a running chain's owner, else the load holder; -1 = free. */
    holder(): number {
        if (this.owner !== 0) return this.owner;
        if (this.loadHolder >= 0) {
            for (const loader of this.attaching.values()) if (loader === this.loadHolder) return this.loadHolder;
        }
        this.loadHolder = -1;
        for (const loader of this.attaching.values()) { this.loadHolder = loader; break; }
        return this.loadHolder;
    }

    /**
     * Whether `threadId` must wait before running entry-point calls (its notification chain, or
     * the process attaches of a load it completed): the loader belongs to another thread.
     */
    loaderBusyFor(threadId: number): boolean {
        const h = this.holder();
        return h >= 0 && h !== (threadId >>> 0);
    }

    /** `threadId` runs its notification calls; the caller checked loaderBusyFor first. */
    acquire(threadId: number): void {
        this.owner = threadId >>> 0;
    }

    release(threadId: number): void {
        if (this.owner !== (threadId >>> 0)) return;
        this.owner = 0;
        this.onIdle();
    }

    /** A thread ended: whatever it held is free, as a terminated owner can never return it. */
    releaseThread(threadId: number): void {
        const tid = threadId >>> 0;
        let freed = false;
        if (this.owner === tid) { this.owner = 0; freed = true; }
        if (this.loadHolder === tid) { this.loadHolder = -1; freed = true; }
        for (const [base, loader] of this.attaching) {
            if (loader === tid && tid !== 0) { this.attaching.delete(base); freed = true; }
        }
        if (freed) this.onIdle();
    }

    /** The entry points to notify, in initialization order (reverse it for detach). */
    targets(registry: ModuleRegistry): ThreadNotifyTarget[] {
        const rank = new Map(this.initOrder.map((base, i) => [base, i]));
        return registry.getAllModules()
            .filter(m => m.isRealDll && !m.isExecutable && m.initialized && m.entryPoint !== 0
                && !this.disabled.has(m.baseAddress >>> 0) && !this.attaching.has(m.baseAddress >>> 0))
            .sort((a, b) => (rank.get(a.baseAddress >>> 0) ?? Infinity) - (rank.get(b.baseAddress >>> 0) ?? Infinity))
            .map(m => ({ base: m.baseAddress >>> 0, entry: (m.baseAddress + m.entryPoint) >>> 0 }));
    }
}

/** Bytes the chain for `targets` occupies below its top. */
export function notifyChainBytes(targetCount: number): number {
    return targetCount * 16;
}

/**
 * Write the call chain below `top` and return the ESP to start it with (EIP = targets[0].entry).
 * After the last entry point returns, execution continues at `finalReturn` with ESP = `top`.
 * The caller has checked that [top - notifyChainBytes, top) is writable stack.
 */
export function layNotifyChain(
    view: DataView, top: number, targets: readonly ThreadNotifyTarget[], reason: number, finalReturn: number,
): number {
    const esp = (top - notifyChainBytes(targets.length)) >>> 0;
    targets.forEach((t, i) => {
        const at = esp + i * 16;
        view.setUint32(at, (i + 1 < targets.length ? targets[i + 1]!.entry : finalReturn) >>> 0, true);
        view.setUint32(at + 4, t.base >>> 0, true);
        view.setUint32(at + 8, reason >>> 0, true);
        view.setUint32(at + 12, 0, true);
    });
    return esp;
}
