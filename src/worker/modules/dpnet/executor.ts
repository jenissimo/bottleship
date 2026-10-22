import type { Process } from "../../core/process";
import { System } from "../../core/system";
import { Mem } from "../../core/memory/mem-accessor";
import { ModuleCallbackQueue, type ModuleCallbackTask, type ModuleCallbackInvocation } from "../../core/module-callback-queue";
import type { ThunkResult, X86Context } from "../../core/thunking/thunk-dispatcher";
import { DPN } from "./constants";

export interface DirectPlayCallbackTask extends ModuleCallbackTask { storageBytes?: number; }
interface Job { lane: DirectPlayCallbackChannel; task: DirectPlayCallbackTask; active: boolean; prepared: boolean; done: boolean; thread: number; bytes: number; invocation?: ModuleCallbackInvocation; }
interface Observer { routine: number; context: number; }
interface Worker {
    queue: ModuleCallbackQueue; busy: boolean; stopping: boolean; ready: Promise<void>; started(): void;
    stopped: Promise<void>; finish(): void; observer?: Observer; context: number; notified: boolean; job?: Job; task?: ModuleCallbackTask;
}
const executors = new WeakMap<Process, DirectPlayCallbackExecutor>();

/** One callback scheduling policy for every DirectPlay object in this process. */
export class DirectPlayCallbackExecutor {
    static forProcess(process: Process): DirectPlayCallbackExecutor {
        let executor = executors.get(process);
        if (!executor || !executor.live) { executor = new DirectPlayCallbackExecutor(process); executors.set(process, executor); }
        return executor;
    }
    private jobs: Job[] = [];
    private jobBytes = 0;
    private channels = new Set<DirectPlayCallbackChannel>();
    private workers: Worker[] = [];
    private activeThreads = new Map<number, number>();
    private observer?: Observer;
    private explicit = false;
    private target = 0;
    private generation: number;
    private transition: Promise<void> = Promise.resolve();
    private transitionCount = 0;
    private startup: Promise<void> = Promise.resolve();
    private live = true;
    private removeReset: () => void;
    constructor(readonly process: Process) {
        this.generation = process.resetGeneration;
        this.removeReset = process.onReset(() => this.reset());
    }
    get initialized(): boolean { return !!this.observer; }
    get count(): number { return this.target; }
    get inCallback(): boolean { return !!this.activeThreads.get(System.getInstance().scheduler.getCurrentThreadId()); }
    channel(capacity = 256): DirectPlayCallbackChannel {
        const lane = new DirectPlayCallbackChannel(this, capacity); this.channels.add(lane);
        if (!this.explicit && !this.target) { this.startup = this.change(1); void this.startup.catch(() => {}); }
        return lane;
    }
    initialize(routine: number, context: number): number {
        if (this.observer) return DPN.ALREADYINITIALIZED;
        // Windows requires the application to configure the pool before any DPN object is initialized.
        if (this.channels.size) return DPN.NOTALLOWED;
        this.observer = { routine, context }; this.explicit = false; return DPN.OK;
    }
    setCount(count: number): number | Promise<ThunkResult> {
        if (this.inCallback) return DPN.NOTALLOWED;
        // Worker queues are real guest threads, with a finite scheduler/resource budget.
        if (count > 256) return DPN.OUTOFMEMORY;
        this.explicit = true;
        return this.waitChange(count);
    }
    close(afterLastRelease = false): number | Promise<ThunkResult> {
        if (this.inCallback && !afterLastRelease) return DPN.NOTALLOWED;
        const observer = this.observer; if (!observer) return DPN.UNINITIALIZED;
        const result = this.waitChange(0);
        const finish = (): number => {
            if (this.observer !== observer) return DPN.UNINITIALIZED;
            this.observer = undefined; this.explicit = false;
            if (this.channels.size) { this.startup = this.change(1); void this.startup.catch(() => {}); }
            return DPN.OK;
        };
        if (typeof result === "number") return finish();
        return result.then(() => ({ value: finish() }));
    }
    ready(): Promise<void> { return Promise.all([this.startup, ...this.workers.map(worker => worker.ready)]).then(() => {}); }
    private waitChange(count: number): number | Promise<ThunkResult> {
        if (!this.transitionCount && this.target === count) return DPN.OK;
        this.transitionCount++;
        const generation = this.generation;
        // Start the first transition in this host turn, so it owns all newly allocated queues.
        const work = this.transitionCount === 1 ? this.change(count) : this.transition.then(() => this.change(count));
        this.transition = work.catch(() => {});
        return work.then<ThunkResult, ThunkResult>(() => ({ value: this.live && this.generation === generation ? DPN.OK : DPN.USERCANCEL }),
            () => ({ value: DPN.OUTOFMEMORY })).finally(() => { this.transitionCount--; });
    }
    private async change(count: number): Promise<void> {
        if (!this.live) return;
        const previous = this.target;
        this.target = count;
        const growing: Worker[] = [], stopping: Worker[] = [];
        try {
        while (this.workers.filter(w => !w.stopping).length < count) {
            let started!: () => void, finish!: () => void;
            const worker: Worker = { queue: new ModuleCallbackQueue(this.process, 1), busy: false, stopping: false,
                ready: new Promise(resolve => { started = resolve; }), started: () => started(),
                stopped: new Promise(resolve => { finish = resolve; }), finish: () => finish(),
                observer: this.observer, context: 0, notified: false };
            this.workers.push(worker); growing.push(worker);
            if (worker.observer) {
                worker.busy = true;
                if (!worker.queue.enqueue(this.notification(worker, false))) { this.finishWorker(worker); throw new Error("DirectPlay worker allocation failed"); }
            } else { worker.started(); }
        }
        } catch (error) {
            this.target = previous;
            for (const worker of growing) if (this.workers.includes(worker)) { worker.stopping = true; if (!worker.busy) this.stopWorker(worker); }
            await Promise.all(growing.map(worker => worker.stopped));
            throw error;
        }
        const running = this.workers.filter(w => !w.stopping);
        for (const worker of running.slice(count)) { worker.stopping = true; stopping.push(worker); if (!worker.busy) this.stopWorker(worker); }
        this.pump();
        await Promise.all([...growing.map(w => w.ready), ...stopping.map(w => w.stopped)]);
    }
    private notification(worker: Worker, destroy: boolean): ModuleCallbackTask {
        const observer = worker.observer!;
        return { prepare: () => {
            const ptr = this.process.memory.alloc(destroy ? 12 : 16);
            if (!ptr) throw new Error("DirectPlay thread notification allocation failed");
            Mem.writeBytes(ptr, new Uint8Array(destroy ? 12 : 16)); Mem.writeUint32(ptr, destroy ? 12 : 16);
            if (destroy) Mem.writeUint32(ptr + 8, worker.context);
            let released = false;
            const free = () => { if (!released) { released = true; this.process.memory.free(ptr); } };
            const thread = System.getInstance().scheduler.getCurrentThreadId(); this.enter(thread);
            return { routine: observer.routine, args: [observer.context, destroy ? 0xffff0018 : 0xffff0017, ptr],
                onReturn: () => {
                    try { if (!destroy) { worker.context = Mem.readUint32(ptr + 12)!; worker.notified = true; } }
                    finally {
                        free(); this.leave(thread); worker.busy = false;
                        if (destroy) this.finishWorker(worker);
                        else { worker.started(); if (worker.stopping) this.stopWorker(worker); else this.pump(); }
                    }
                }, onDiscard: () => { free(); this.leave(thread); this.finishWorker(worker); } };
        }, onDiscard: () => this.finishWorker(worker) };
    }
    private stopWorker(worker: Worker): void {
        if (worker.busy) return;
        if (worker.notified && worker.observer && this.live) {
            worker.busy = true;
            if (worker.queue.enqueue(this.notification(worker, true))) return;
        }
        this.finishWorker(worker);
    }
    private finishWorker(worker: Worker): void {
        worker.queue.close(); worker.started(); worker.finish();
        const index = this.workers.indexOf(worker); if (index >= 0) this.workers.splice(index, 1);
    }
    enqueue(lane: DirectPlayCallbackChannel, task: DirectPlayCallbackTask): boolean {
        const bytes = Math.max(64, task.storageBytes ?? 64);
        if (!Number.isSafeInteger(bytes) || !this.live || lane.closed || lane.size >= lane.capacity || this.jobs.length >= 16384 ||
            this.jobBytes + bytes > 16 * 1024 * 1024 || this.jobs.reduce((n, job) => n + (job.lane === lane ? job.bytes : 0), 0) + bytes > 8 * 1024 * 1024) return false;
        this.jobBytes += bytes;
        this.jobs.push({ lane, task, active: false, prepared: false, done: false, thread: 0, bytes }); this.pump(); return true;
    }
    size(lane: DirectPlayCallbackChannel): number { return this.jobs.reduce((n, job) => n + +(job.lane === lane && !job.done), 0); }
    threadId(lane: DirectPlayCallbackChannel): number {
        const current = System.getInstance().scheduler.getCurrentThreadId();
        return this.jobs.some(job => job.lane === lane && job.active && job.thread === current) ? current : 0;
    }
    private enter(thread: number): void { this.activeThreads.set(thread, (this.activeThreads.get(thread) ?? 0) + 1); }
    private leave(thread: number): void { const count = (this.activeThreads.get(thread) ?? 1) - 1; if (count) this.activeThreads.set(thread, count); else this.activeThreads.delete(thread); }
    private finishJob(job: Job): void {
        if (job.done) return;
        job.done = true; this.jobBytes -= job.bytes; if (job.prepared) this.leave(job.thread);
        const index = this.jobs.indexOf(job); if (index >= 0) this.jobs.splice(index, 1);
        job.lane.onSpace?.();
    }
    private prepare(job: Job): ModuleCallbackInvocation {
        job.active = true; job.prepared = true; job.thread = System.getInstance().scheduler.getCurrentThreadId(); this.enter(job.thread);
        let invocation: ModuleCallbackInvocation;
        try { invocation = job.task.prepare(); } catch (error) { this.finishJob(job); throw error; }
        const wrapped: ModuleCallbackInvocation = { ...invocation,
            onReturn: value => { if (job.done) return; try { invocation.onReturn?.(value); } finally { this.finishJob(job); } },
            onDiscard: () => { if (job.done) return; try { invocation.onDiscard?.(); } finally { this.finishJob(job); } } };
        job.invocation = wrapped; return wrapped;
    }
    pump(): void {
        if (!this.live) return;
        for (const worker of this.workers) {
            if (worker.busy || worker.stopping) continue;
            const job = this.jobs.find(item => !item.active && !item.done && !item.lane.closed && !item.lane.paused);
            if (!job) break;
            job.active = true; worker.busy = true;
            const done = () => { worker.job = undefined; worker.task = undefined; worker.busy = false; if (worker.stopping) this.stopWorker(worker); else this.pump(); };
            const task: ModuleCallbackTask = { prepare: () => {
                const call = this.prepare(job);
                return { ...call, onReturn: value => { try { call.onReturn?.(value); } finally { done(); } },
                    onDiscard: () => { try { call.onDiscard?.(); } finally { done(); } } };
            }, onDiscard: () => { if (!job.done) { job.task.onDiscard?.(); this.finishJob(job); } done(); } };
            worker.job = job; worker.task = task;
            if (!worker.queue.enqueue(task)) { worker.job = undefined; worker.task = undefined; worker.busy = false; job.active = false; break; }
        }
    }
    discard(lane: DirectPlayCallbackChannel): void {
        this.channels.delete(lane);
        for (const worker of this.workers) if (worker.job?.lane === lane && !worker.job.prepared && worker.task) worker.queue.cancel(worker.task);
        for (const job of [...this.jobs]) if (job.lane === lane && !job.active) { job.task.onDiscard?.(); this.finishJob(job); }
        if (!this.channels.size && !this.explicit) void this.change(0).catch(() => {});
    }
    /** Execute queued callbacks on the issuing guest thread, without retaining any RAM view. */
    run(ctx: X86Context & { returnAddr?: number }, cleanup: number, lane?: DirectPlayCallbackChannel,
        allowedTime = 0xffffffff, finalValue: number = DPN.OK, onDone: () => void = () => {}): number | ThunkResult {
        const generation = this.generation, start = performance.now();
        const release = lane?.pause();
        let finished = false;
        const finish = () => { if (finished) return; finished = true; release?.(); onDone(); this.pump(); };
        const eligible = () => this.jobs.find(job => !job.active && !job.done && (!lane || job.lane === lane) && !job.lane.closed);
        let nextJob = eligible();
        if (!nextJob) { finish(); return finalValue; }
        const manager = this.process.dispatcher.callbackManager;
        const frame = manager.saveSuspendedThunkContext(ctx, cleanup, "DirectPlay inline callbacks");
        if (!frame) { finish(); return DPN.GENERIC; }
        let first = 0;
        const next = (): void => {
            const job = nextJob!; nextJob = undefined;
            const call = this.prepare(job);
            let invocation: { callbackId: number };
            try { invocation = manager.invokeCallback(call.routine, [...call.args], 0, value => {
                call.onReturn?.(value);
                if (this.live && generation === this.generation && (allowedTime === 0xffffffff || performance.now() - start < allowedTime)) nextJob = eligible();
                if (!nextJob) { finish(); return finalValue; }
                return null;
            }, false, "DirectPlay inline callbacks", frame); }
            catch (error) { call.onDiscard?.(); throw error; }
            if (!first) first = invocation.callbackId;
            if (!invocation.callbackId) { call.onDiscard?.(); throw new Error("DirectPlay callback frame rejected"); }
            const pending = manager.getPendingCallback(invocation.callbackId);
            if (pending) pending.enumerationState = { continueEnumeration: next, finishEnumeration: finish };
        };
        try { next(); } catch { manager.abandonSuspendedFrame(frame); finish(); return DPN.GENERIC; }
        return { value: finalValue, suspendedForCallback: true, callbackId: first, stackCleanup: cleanup, skipStackCheck: true };
    }
    reset(): void {
        if (!this.live) return; this.live = false; this.generation++; this.removeReset();
        for (const job of [...this.jobs]) if (job.prepared) job.invocation?.onDiscard?.();
        for (const lane of [...this.channels]) lane.close();
        for (const worker of [...this.workers]) this.finishWorker(worker);
        this.jobs = []; this.jobBytes = 0; this.activeThreads.clear(); this.observer = undefined; this.target = 0;
    }
}

export class DirectPlayCallbackChannel {
    closed = false;
    paused = 0;
    onSpace?: () => void;
    constructor(readonly executor: DirectPlayCallbackExecutor, readonly capacity = 256) {}
    get size(): number { return this.executor.size(this); }
    get threadId(): number { return this.executor.threadId(this); }
    enqueue(task: DirectPlayCallbackTask): boolean { return this.executor.enqueue(this, task); }
    pause(): () => void { this.paused++; let resumed = false; return () => { if (!resumed) { resumed = true; this.paused--; this.executor.pump(); } }; }
    run(ctx: X86Context & { returnAddr?: number }, cleanup: number, finalValue: number = DPN.OK, onDone?: () => void): number | ThunkResult {
        return this.executor.run(ctx, cleanup, this, 0xffffffff, finalValue, onDone);
    }
    close(): void { if (!this.closed) { this.closed = true; this.executor.discard(this); } }
}
