import type { Process } from './process';
import { System } from './system';
import { writeGuestCode } from './memory/guest-code';
import type { X86Context, ThunkResult } from './thunking/thunk-dispatcher';

export interface ModuleCallbackInvocation {
    routine: number;
    args: number[];
    /** Runs on the callback thread after the guest callback has returned. */
    onReturn?(value: number): void;
    /** Reclaims prepared storage if reset invalidates a callback before its return. */
    onDiscard?(): void;
}
export interface ModuleCallbackTask {
    /** Materialize guest output only at the callback thread's safe dispatch point. */
    prepare(): ModuleCallbackInvocation;
    /** Reclaims a task that never reached prepare(). */
    onDiscard?(): void;
}
let nextQueue = 1;

/**
 * A bounded, lossless host-to-guest callback queue with its own guest worker thread.
 * enqueue() never invokes guest code or changes the current thread's CPU state.
 * Callers retain ownership when enqueue() returns false and must apply backpressure.
 */
export class ModuleCallbackQueue {
    private readonly pending: ModuleCallbackTask[] = [];
    private readonly generation: number;
    private readonly name = 'ModuleCallbackPump' + nextQueue++;
    private readonly scheduler = System.getInstance().scheduler;
    private readonly removeResetListener: () => void;
    private handle = 0;
    private closed = false;
    private wake: (() => void) | undefined;
    private active: ModuleCallbackInvocation | undefined;
    private entry = 0;

    constructor(private readonly process: Process, readonly capacity = 256) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Callback queue capacity must be positive');
        this.generation = process.resetGeneration;
        this.removeResetListener = process.onReset(() => this.close());
    }
    get threadId(): number { return this.scheduler.getThreadIdByHandle(this.handle) ?? 0; }
    get size(): number { return this.pending.length + (this.active ? 1 : 0); }
    enqueue(task: ModuleCallbackTask): boolean {
        if (this.closed || this.process.resetGeneration !== this.generation || this.size >= this.capacity) return false;
        try { if (!this.handle && !this.startThread()) return false; }
        catch { return false; }
        this.pending.push(task);
        const wake = this.wake; this.wake = undefined; wake?.();
        return true;
    }
    /** Cancel an owned task before preparation; an executing guest frame keeps its lifetime. */
    cancel(task: ModuleCallbackTask): boolean {
        const index = this.pending.indexOf(task);
        if (index < 0) return false;
        this.pending.splice(index, 1); task.onDiscard?.(); return true;
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.removeResetListener();
        for (const task of this.pending.splice(0)) task.onDiscard?.();
        if (this.process.resetGeneration !== this.generation && this.active) {
            this.active.onDiscard?.();
            this.active = undefined;
        }
        // An idle pump returns 0 and exits naturally through the thread exit stub.
        // An active callback finishes its existing frame before the loop exits.
        const wake = this.wake; this.wake = undefined; wake?.();
        if (this.handle) this.process.resourceProvider.unregisterKernelObject(this.handle);
    }
    private startThread(): boolean {
        const stub = this.process.thunkGenerator.generateStubDll('bottleship.runtime', [
            { name: this.name, argCount: 0 },
        ]);
        const address = stub.exportTable.get(this.name.toLowerCase()) ?? 0;
        if (!address) return false;
        writeGuestCode(this.process.getCurrentMemory(), stub.stubCode, stub.baseAddress);
        this.process.dispatcher.register('bottleship.runtime', this.name, ctx => this.pump(ctx));
        // DWORD WINAPI worker(void*): call pump; continue while EAX != 0; return 0.
        const loop = new Uint8Array([0xb8, address & 255, (address >>> 8) & 255,
            (address >>> 16) & 255, address >>> 24, 0xff, 0xd0, 0x85, 0xc0, 0x75, 0xf5, 0xc2, 4, 0]);
        if (!this.entry) {
            // Like the scheduler's thread-exit wrapper, this is a real guest caller.
            // Keep its continuation outside the export-thunk band, whose return
            // addresses the callback manager rejects as corrupt guest frames.
            this.entry = this.process.memory.alloc(loop.length, 'THUNK_DATA', 'rx');
            writeGuestCode(this.process.getCurrentMemory(), loop, this.entry);
        }
        const memory = this.process.getCurrentMemory();
        this.handle = this.scheduler.createThread(this.entry, 0, 0, 0, 0, memory);
        return !!this.handle;
    }
    private pump(ctx: X86Context): number | ThunkResult | Promise<ThunkResult> {
        if (this.closed || this.process.resetGeneration !== this.generation) return 0;
        if (this.pending.length) return this.dispatch(ctx) ?? 1;
        // The dispatcher parks THIS thread, then starts the chain on it when ready.
        const saved = { ...ctx };
        return new Promise<void>(resolve => { this.wake = resolve; }).then(() => ({
            value: this.closed ? 0 : 1,
            startCallbackChain: frame => this.dispatch({ ...saved, esp: frame.esp, returnAddr: frame.returnAddr }) !== null,
        }));
    }
    private dispatch(ctx: X86Context & { returnAddr?: number }): ThunkResult | null {
        if (this.closed || this.process.resetGeneration !== this.generation) return null;
        const task = this.pending.shift();
        if (!task) return null;
        let invocation: ModuleCallbackInvocation;
        try { invocation = task.prepare(); }
        catch (error) { task.onDiscard?.(); throw error; }
        const manager = this.process.dispatcher.callbackManager;
        const frame = manager.saveSuspendedThunkContext(ctx, 0, this.name);
        if (!frame) { invocation.onDiscard?.(); return null; }
        this.active = invocation;

        const complete = (value: number): number => {
            if (this.active !== invocation) return 0;
            this.active = undefined;
            if (this.process.resetGeneration === this.generation) invocation.onReturn?.(value >>> 0);
            else invocation.onDiscard?.();
            return this.closed ? 0 : 1;
        };
        try {
            const { callbackId } = manager.invokeCallback(invocation.routine, [...invocation.args],
                invocation.args.length * 4, complete, false, this.name, frame);
            if (callbackId) return { value: 1, suspendedForCallback: true, callbackId, stackCleanup: 0 };
        } catch (error) {
            manager.abandonSuspendedFrame(frame);
            this.active = undefined;
            invocation.onDiscard?.();
            throw error;
        }
        manager.abandonSuspendedFrame(frame);
        this.active = undefined;
        invocation.onDiscard?.();
        return null;
    }
}
