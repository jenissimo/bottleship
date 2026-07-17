/**
 * Kernel32 Synchronization functions
 *
 * Atomic implementation for critical sections and debugging
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { EmulatorConfig, getCodePageDecoder } from '../../core/emulator-config-manager';
import { WAIT_FAILED, WAIT_TIMEOUT, WAIT_BLOCKED_NO_SWITCH, TimerKind } from '../../core/scheduler/types';
import { Mem } from '../../core/memory/mem-accessor';
import { TimeService } from '../../runtime/time';
import { asBufferSource } from '../../../dom-buffer';
import {
    ensureSrwWaitEvent,
    releaseSrwExclusive,
    releaseSrwShared,
    tryAcquireSrwExclusive,
    tryAcquireSrwShared,
} from './srw-lock';
import { namedObjects } from './named-objects';

const syncModule = (() => {
    const exports: Record<string, ThunkImplementation> = {};
    const waitableTimers: Map<number, { wheelId: number | null; periodMs: number }> = new Map();
    const timerQueueHandles = new Set<number>();
    const timerQueueTimers = new Map<number, { queue: number; wheelId: number | null; periodMs: number; callback: number; parameter: number }>();
    const registeredWaits = new Set<number>();
    let nextTimerQueueHandle = 0x00060000;
    let nextTimerQueueTimerHandle = 0x00070000;
    const ioCompletionAssociations: Map<number, number> = new Map();
    let cachedSystem = System.getInstance();
    let cachedScheduler = cachedSystem.scheduler;
    let lastWaitLog = 0;
    let waitSingleCount = 0;
    let waitMultipleCount = 0;
    let lastWaitSingleMs = 0;
    let lastWaitMultipleMs = 0;
    let lastWaitSingleResult = 0;
    let lastWaitMultipleResult = 0;
    let lastWaitMultipleCount = 0;
    let lastWaitMultipleAll = false;
    let setEventCount = 0;
    let lastSetEventLog = 0;
    let lastSetEventHandle = 0;
    let lastSetEventReturnAddr = 0;
    let resetEventCount = 0;
    let lastResetEventLog = 0;
    let lastResetEventHandle = 0;
    let lastResetEventReturnAddr = 0;

    const logSetEvent = (sched: any, hEvent: number, ok: boolean, returnAddr: number): void => {
        if (!ok) {
            Logger.warn(
                LogCategory.KERNEL32,
                `SetEvent(handle=0x${hEvent.toString(16)}) -> FAILED (invalid handle?) returnAddr=0x${returnAddr.toString(16)}`
            );
            return;
        }

        const now = performance.now();
        setEventCount += 1;
        lastSetEventHandle = hEvent >>> 0;
        lastSetEventReturnAddr = returnAddr >>> 0;

        if (now - lastSetEventLog < 1000) return;

        let waiters = 0;
        let state = '';
        try {
            waiters = sched.hasWaitersForHandle?.(lastSetEventHandle) ? 1 : 0;
            state = sched.syncObjects?.describeHandle?.(lastSetEventHandle) ?? '';
        } catch {
            waiters = 0;
            state = '';
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `SetEvent: calls=${setEventCount} lastHandle=0x${lastSetEventHandle.toString(16)} ` +
            `lastReturnAddr=0x${lastSetEventReturnAddr.toString(16)} waiters=${waiters}` +
            (state ? ` state=${state}` : '')
        );
        lastSetEventLog = now;
        setEventCount = 0;
    };

    const logResetEvent = (hEvent: number, ok: boolean, returnAddr: number): void => {
        if (!ok) {
            Logger.warn(
                LogCategory.KERNEL32,
                `ResetEvent(handle=0x${hEvent.toString(16)}) -> FAILED (invalid handle?) ret=0x${returnAddr.toString(16)}`
            );
            return;
        }

        const now = performance.now();
        resetEventCount += 1;
        lastResetEventHandle = hEvent >>> 0;
        lastResetEventReturnAddr = returnAddr >>> 0;
        if (now - lastResetEventLog < 1000) return;

        Logger.verbose(
            LogCategory.KERNEL32,
            `ResetEvent: calls=${resetEventCount} lastHandle=0x${lastResetEventHandle.toString(16)} ` +
            `lastReturnAddr=0x${lastResetEventReturnAddr.toString(16)}`
        );
        lastResetEventLog = now;
        resetEventCount = 0;
    };

    const getScheduler = () => {
        const system = System.getInstance();
        if (system !== cachedSystem) {
            cachedSystem = system;
            cachedScheduler = system.scheduler;
        }
        return cachedScheduler;
    };

    const readStringA = (addr: number, maxLen: number = 260): string => {
        if (!addr) return '';
        const bytes = Mem.readBytes(addr, maxLen);
        if (!bytes) return '';
        let end = bytes.indexOf(0);
        if (end === -1) end = bytes.length;
        return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(asBufferSource(bytes.subarray(0, end)));
    };

    const readStringW = (addr: number, maxChars: number = 260): string => {
        if (!addr) return '';
        const bytes = Mem.readBytes(addr, maxChars * 2);
        if (!bytes) return '';
        let end = 0;
        for (; end + 1 < bytes.length; end += 2) {
            if (bytes[end] === 0 && bytes[end + 1] === 0) break;
        }
        return new TextDecoder('utf-16le').decode(bytes.subarray(0, end));
    };

    const CS_SIZE = 24;
    const CS_OFFSET_LOCKCOUNT = 4;
    const CS_OFFSET_RECURSION = 8;
    const CS_OFFSET_OWNER = 12;
    const CS_OFFSET_LOCKSEMAPHORE = 16;

    const registerCsOwner = (lpCriticalSection: number, ownerThreadId: number): void => {
        try {
            getScheduler().registerCriticalSectionOwner(lpCriticalSection, ownerThreadId);
        } catch { }
    };

    const clearCsOwner = (lpCriticalSection: number, expectedOwnerThreadId?: number): boolean => {
        try {
            return getScheduler().clearCriticalSectionOwner(lpCriticalSection, expectedOwnerThreadId);
        } catch {
            return false;
        }
    };

    const isValidSyncHandle = (handle: number): boolean => {
        if (handle === 0 || handle === 0xffffffff) return false;
        try {
            return System.getInstance().resourceProvider.isValidHandle(handle);
        } catch {
            return false;
        }
    };

    /** Lazily create or get the auto-reset event stored at CS+16 (LockSemaphore). */
    const ensureLockSemaphore = (lpCriticalSection: number): number => {
        const sched = getScheduler();
        const existing = Mem.readUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0) ?? 0;
        if (existing !== 0) {
            if (isValidSyncHandle(existing)) {
                // Keep the scheduler registry current even if the entry predates this session
                (sched as any).registerCsLockSemaphore?.(lpCriticalSection, existing);
                return existing;
            }
            // Uninitialized CS memory (e.g. 0xAAAAAAAA) — do not treat as a kernel handle
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0, 0);
        }
        const handle = sched.createEvent(false /* manualReset=false → auto-reset */, false /* initialState=false */);
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0, handle >>> 0);
        // Register so thread-termination sweep can find WASM-acquired ownership of this CS
        (sched as any).registerCsLockSemaphore?.(lpCriticalSection, handle);
        return handle;
    };

    const setCriticalSectionUnlocked = (mem: Uint8Array, lpCriticalSection: number): void => {
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0xffffffff); // -1
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 0);
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0, 0);
        // Clear LockSemaphore (don't close — may be re-initialized)
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0, 0);
        try { (getScheduler() as any).unregisterCsLockSemaphore?.(lpCriticalSection); } catch { }
        clearCsOwner(lpCriticalSection);
    };

    const normalizeCriticalSectionState = (
        mem: Uint8Array,
        lpCriticalSection: number,
        currentThreadId: number
    ): { lockCount: number; recursionCount: number; ownerThread: number } => {
        const scheduler = getScheduler();
        let lockCount = Mem.readInt32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0) ?? -1;
        let recursionCount = Mem.readInt32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0) ?? 0;
        let ownerThread = Mem.readUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0) ?? 0;
        const trackedOwner =
            typeof (scheduler as any).getCriticalSectionOwner === 'function'
                ? (scheduler as any).getCriticalSectionOwner(lpCriticalSection)
                : null;

        // Zero-filled CS appears frequently with legacy code paths; canonicalize to unlocked.
        if (lockCount === 0 && recursionCount === 0 && ownerThread === 0) {
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0xffffffff);
            lockCount = -1;
        }

        // Owner thread IDs must map to a live thread in scheduler.
        if (ownerThread !== 0 && scheduler.getThreadStateById(ownerThread) === null) {
            // Compatibility recovery: some titles feed stale/uninitialized CS memory.
            // If scheduler does not track this CS as owned, treat it as unlocked.
            if (trackedOwner === null) {
                Logger.warn(
                    LogCategory.KERNEL32,
                    `CriticalSection 0x${lpCriticalSection.toString(16)} stale owner T${ownerThread} (untracked); recovering to unlocked`
                );
                setCriticalSectionUnlocked(mem, lpCriticalSection);
                lockCount = -1;
                recursionCount = 0;
                ownerThread = 0;
            } else {
                Logger.error(
                    LogCategory.KERNEL32,
                    `CriticalSection 0x${lpCriticalSection.toString(16)} stale owner T${ownerThread} tracked=T${trackedOwner} (corruption)`
                );
                scheduler.reportFatalGuard(0x3009, lpCriticalSection >>> 0, currentThreadId >>> 0);
                return { lockCount, recursionCount, ownerThread };
            }
        }

        // Keep scheduler owner map consistent with memory state.
        if (trackedOwner !== null && ownerThread === 0) {
            clearCsOwner(lpCriticalSection, trackedOwner >>> 0);
        }

        // Known-owner path must have positive recursion count.
        if (ownerThread === currentThreadId && recursionCount <= 0) {
            recursionCount = 1;
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, recursionCount >>> 0);
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0);
            lockCount = 0;
        }

        // Inconsistent "locked but no owner" state -> reset.
        if (ownerThread === 0 && (recursionCount !== 0 || lockCount >= 0)) {
            setCriticalSectionUnlocked(mem, lpCriticalSection);
            lockCount = -1;
            recursionCount = 0;
            ownerThread = 0;
        }

        return { lockCount, recursionCount, ownerThread };
    };

    exports['InitializeCriticalSectionAndSpinCount'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];
        const dwSpinCount = args[1];

        Logger.log(LogCategory.KERNEL32, `InitializeCriticalSectionAndSpinCount(lpCriticalSection=0x${lpCriticalSection.toString(16)}, dwSpinCount=${dwSpinCount})`);

        if (lpCriticalSection !== 0 && lpCriticalSection + CS_SIZE <= mem.length) {
            setCriticalSectionUnlocked(mem, lpCriticalSection);
        }

        return { value: 1, stackCleanup: 8 }; // TRUE
    };

    exports['InitializeCriticalSection'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];

        // Check if address is in THUNK_CODE region (dangerous!)
        const space = System.getInstance().process?.addressSpace;
        if (space) {
            const thunkRegion = space.findRegionByKind?.("THUNK_CODE") ?? space.getLayoutBucket("THUNK_CODE");
            if (thunkRegion && lpCriticalSection >= thunkRegion.base && lpCriticalSection < thunkRegion.base + thunkRegion.size) {
                Logger.warn(LogCategory.KERNEL32,
                    `⚠️ InitializeCriticalSection: lpCriticalSection=0x${lpCriticalSection.toString(16)} is in THUNK_CODE region! ` +
                    `This may cause corruption. THUNK_CODE=0x${thunkRegion.base.toString(16)}-0x${(thunkRegion.base + thunkRegion.size).toString(16)}`);
            }
        }

        Logger.log(LogCategory.KERNEL32, `InitializeCriticalSection(lpCriticalSection=0x${lpCriticalSection.toString(16)})`);

        if (lpCriticalSection !== 0 && lpCriticalSection + CS_SIZE <= mem.length) {
            setCriticalSectionUnlocked(mem, lpCriticalSection);
        }

        return { value: 1, stackCleanup: 4 };
    };

    exports['InitializeCriticalSectionEx'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];
        const dwSpinCount = args[1];
        const flags = args[2];
        Logger.verbose(LogCategory.KERNEL32, `InitializeCriticalSectionEx(lp=0x${lpCriticalSection.toString(16)}, spin=${dwSpinCount}, flags=${flags})`);

        if (lpCriticalSection !== 0 && lpCriticalSection + CS_SIZE <= mem.length) {
            setCriticalSectionUnlocked(mem, lpCriticalSection);
        }

        return { value: 1, stackCleanup: 12 };
    };

    exports['DeleteCriticalSection'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];
        Logger.verbose(LogCategory.KERNEL32, `DeleteCriticalSection(lpCriticalSection=0x${lpCriticalSection.toString(16)})`);

        if (lpCriticalSection !== 0 && lpCriticalSection + 24 <= mem.length) {
            // Close LockSemaphore event if it exists
            const lockSem = Mem.readUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0) ?? 0;
            if (lockSem !== 0) {
                try {
                    System.getInstance().resourceProvider.unregisterKernelObject(lockSem);
                } catch { /* best effort */ }
            }
            setCriticalSectionUnlocked(mem, lpCriticalSection);
        }

        return { value: 0, stackCleanup: 4 };
    };

    exports['TryEnterCriticalSection'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];
        const sched = getScheduler();
        const currentThreadId = sched.getCurrentThreadId();

        if (lpCriticalSection === 0 || lpCriticalSection + CS_SIZE > mem.length) {
            Logger.warn(LogCategory.KERNEL32, `TryEnterCriticalSection: invalid lpCriticalSection=0x${lpCriticalSection.toString(16)}`);
            return { value: 0, stackCleanup: 4 };
        }

        const { lockCount, recursionCount, ownerThread } =
            normalizeCriticalSectionState(mem, lpCriticalSection, currentThreadId);

        Logger.verboseLazy(LogCategory.KERNEL32, () =>
            `TryEnterCriticalSection(0x${lpCriticalSection.toString(16)}) thread=${currentThreadId} ` +
            `lock=${lockCount} recur=${recursionCount} owner=${ownerThread}`
        );

        if (ownerThread === currentThreadId) {
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, (recursionCount + 1) >>> 0);
            return { value: 1, stackCleanup: 4 };
        }

        if (lockCount === -1) {
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0);
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 1);
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0, currentThreadId >>> 0);
            registerCsOwner(lpCriticalSection, currentThreadId);
            return { value: 1, stackCleanup: 4 };
        }

        return { value: 0, stackCleanup: 4 };
    };

    exports['EnterCriticalSection'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];

        if (lpCriticalSection === 0 || lpCriticalSection + CS_SIZE > mem.length) {
            Logger.warn(LogCategory.KERNEL32, `EnterCriticalSection: invalid lpCriticalSection=0x${lpCriticalSection.toString(16)}`);
            return { value: 0, stackCleanup: 4 };
        }

        const sched = getScheduler();
        const currentThreadId = sched.getCurrentThreadId();
        const { lockCount, recursionCount, ownerThread } =
            normalizeCriticalSectionState(mem, lpCriticalSection, currentThreadId);

        // PERF: Get thread ID only when needed (after fast path checks)
        if (ownerThread !== 0) {
            if (ownerThread === currentThreadId) {
                Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, (recursionCount + 1) >>> 0);
                return { value: 0, stackCleanup: 4 };
            }

            // Dead-owner safety net: if the owning thread no longer exists (terminated
            // without releasing — e.g. acquired via the WASM fast path which the
            // termination sweep can miss), steal ownership instead of parking forever.
            if (typeof (sched as any).isThreadAlive === 'function' && !(sched as any).isThreadAlive(ownerThread)) {
                Logger.warn(LogCategory.KERNEL32,
                    `EnterCriticalSection: owner T${ownerThread} of CS 0x${lpCriticalSection.toString(16)} is dead — stealing ownership for T${currentThreadId}`);
                Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0);
                Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 1);
                Mem.writeUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0, currentThreadId >>> 0);
                registerCsOwner(lpCriticalSection, currentThreadId);
                return { value: 0, stackCleanup: 4 };
            }

            // CONTENTION: CS is held by another thread — block until released.
            // Use LockSemaphore event for proper auto-reset wake signaling.
            const lockSemHandle = ensureLockSemaphore(lpCriticalSection);
            const system = System.getInstance();
            const cpu = system.process?.v86?.cpu || system.process?.v86?.v86?.cpu;
            if (cpu) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const returnAddr = view.getUint32(ctx.esp, true);
                const postReturnEsp = ctx.esp + 8; // 4 (ret addr) + 4 (1 arg stdcall)

                const blocked = sched.enterCriticalSectionWithContext(
                    lpCriticalSection,
                    lockSemHandle,
                    returnAddr,
                    postReturnEsp,
                    { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
                );

                if (blocked === false) {
                    // No runnable peers — CS owner is sleeping. Thread is now WAITING;
                    // redirect EIP to spin loop so guest code does not resume while
                    // this thread's state is WAITING. The sleep timer will wake the
                    // owner, which calls LeaveCriticalSection → setEvent(lockSem) →
                    // wakeThread(this thread) → READY, at which point the scheduler
                    // restores the saved context (returnAddr) on the next tick.
                    return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
                }

                // blocked === true: thread is WAITING — same as WFSO with runnable peers:
                // redirect stub RET to spin; performSwitch switches to the peer.
                return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
            }

            // Fallback: no CPU object — cannot block thread safely.
            Logger.error(LogCategory.KERNEL32,
                `EnterCriticalSection: contention on 0x${lpCriticalSection.toString(16)} ` +
                `owner=${ownerThread} current=${currentThreadId} could not block thread (fatal)`);
            sched.reportFatalGuard(0x3008, lpCriticalSection >>> 0, currentThreadId >>> 0);
            return { value: 0, stackCleanup: 4 };
        }

        // Fast path: lock is free (ownerThread === 0 or lockCount === -1)
        if (lockCount !== -1 && lockCount !== 0) {
            Logger.verboseLazy(LogCategory.KERNEL32, () =>
                `EnterCriticalSection: unexpected lockCount=${lockCount}, acquiring anyway`
            );
        }
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0);
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 1);
        Mem.writeUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0, currentThreadId >>> 0);
        registerCsOwner(lpCriticalSection, currentThreadId);

        return { value: 0, stackCleanup: 4 };
    };

    exports['LeaveCriticalSection'] = (ctx, mem, args) => {
        const lpCriticalSection = args[0];
        const sched = getScheduler();
        const currentThreadId = sched.getCurrentThreadId();

        if (lpCriticalSection === 0 || lpCriticalSection + CS_SIZE > mem.length) {
            Logger.warn(LogCategory.KERNEL32, `LeaveCriticalSection: invalid lpCriticalSection=0x${lpCriticalSection.toString(16)}`);
            return { value: 0, stackCleanup: 4 };
        }

        const recursionCount = Mem.readInt32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0) ?? 0;
        const ownerThread = Mem.readUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0) ?? 0;

        Logger.verboseLazy(LogCategory.KERNEL32, () =>
            `LeaveCriticalSection(0x${lpCriticalSection.toString(16)}) thread=${currentThreadId} ` +
            `recur=${recursionCount} owner=${ownerThread}`
        );

        if (ownerThread !== currentThreadId && ownerThread !== 0) {
            Logger.error(LogCategory.KERNEL32,
                `LeaveCriticalSection owner mismatch: thread ${currentThreadId} owner=${ownerThread}`);
            sched.reportFatalGuard(0x3009, lpCriticalSection >>> 0, currentThreadId >>> 0);
            return { value: 0, stackCleanup: 4 };
        }

        if (recursionCount > 1) {
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, (recursionCount - 1) >>> 0);
            return { value: 0, stackCleanup: 4 };
        }

        // LockSemaphore event at CS+16 persists across contentions. Check for actual
        // WAITING threads, not just event existence, to decide release strategy.
        let lockSem = Mem.readUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0) ?? 0;
        if (lockSem !== 0 && !isValidSyncHandle(lockSem)) {
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKSEMAPHORE) >>> 0, 0);
            lockSem = 0;
        }
        const hasWaiters = lockSem !== 0 && sched.hasWaitersForHandle(lockSem);

        if (hasWaiters) {
            // Active waiters — keep CS locked (don't write OwnerThread=0 or LockCount=-1).
            // wakeThread does atomic ownership transfer: LockCount=0, RecursionCount=1, OwnerThread=waiter.
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 0);
            clearCsOwner(lpCriticalSection, ownerThread);
            sched.setEvent(lockSem);
        } else {
            // No waiters — fully release
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_LOCKCOUNT) >>> 0, 0xffffffff);
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_RECURSION) >>> 0, 0);
            Mem.writeUint32((lpCriticalSection + CS_OFFSET_OWNER) >>> 0, 0);
            clearCsOwner(lpCriticalSection, ownerThread);
        }

        return { value: 0, stackCleanup: 4 };
    };

    exports['IsDebuggerPresent'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, `IsDebuggerPresent() -> 0`);
        return 0;
    };

    // Singly Linked List (SList) support
    exports['InitializeSListHead'] = (ctx, mem, args) => {
        const ListHead = args[0];
        if (ListHead !== 0 && ListHead + 8 <= mem.length) {
            mem.fill(0, ListHead, ListHead + 8);
        }
        return 0;
    };

    exports['InterlockedFlushSList'] = (ctx, mem, args) => {
        const ListHead = args[0];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const first = view.getUint32(ListHead, true);
        view.setUint32(ListHead, 0, true);
        view.setUint32(ListHead + 4, 0, true);
        return first;
    };

    exports['InterlockedPopEntrySList'] = (ctx, mem, args) => {
        const ListHead = args[0];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const first = view.getUint32(ListHead, true);
        if (first !== 0) {
            const next = view.getUint32(first, true);
            view.setUint32(ListHead, next, true);
            const count = view.getUint32(ListHead + 4, true);
            view.setUint32(ListHead + 4, count - 1, true);
        }
        return first;
    };

    exports['InterlockedPushEntrySList'] = (ctx, mem, args) => {
        const ListHead = args[0];
        const ListEntry = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const first = view.getUint32(ListHead, true);
        view.setUint32(ListEntry, first, true);
        view.setUint32(ListHead, ListEntry, true);
        const count = view.getUint32(ListHead + 4, true);
        view.setUint32(ListHead + 4, count + 1, true);
        return first;
    };

    exports['QueryDepthSList'] = (ctx, mem, args) => {
        const ListHead = args[0];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return view.getUint32(ListHead + 4, true);
    };

    // Interlocked atomic operations
    exports['InterlockedExchange'] = (ctx, mem, args) => {
        const Target = args[0];
        const Value = args[1];

        if (Target === 0 || Target + 4 > mem.length) {
            Logger.warn(LogCategory.KERNEL32, `InterlockedExchange: Invalid target pointer 0x${Target.toString(16)}`);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const oldValue = view.getInt32(Target, true);
        view.setInt32(Target, Value, true);

        return { value: oldValue >>> 0, stackCleanup: 8 };
    };

    exports['InterlockedCompareExchange'] = (ctx, mem, args) => {
        const Destination = args[0];
        const Exchange = args[1];
        const Comparand = args[2];

        if (Destination === 0 || Destination + 4 > mem.length) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const oldValue = view.getInt32(Destination, true);

        if (oldValue === Comparand) {
            view.setInt32(Destination, Exchange, true);
        }

        return { value: oldValue >>> 0, stackCleanup: 12 };
    };

    exports['InterlockedIncrement'] = (ctx, mem, args) => {
        const Addend = args[0];

        if (Addend === 0 || Addend + 4 > mem.length) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const oldValue = view.getInt32(Addend, true);
        const newValue = (oldValue + 1) | 0;
        view.setInt32(Addend, newValue, true);

        return { value: newValue >>> 0, stackCleanup: 4 };
    };

    exports['InterlockedDecrement'] = (ctx, mem, args) => {
        const Addend = args[0];

        if (Addend === 0 || Addend + 4 > mem.length) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const oldValue = view.getInt32(Addend, true);
        const newValue = (oldValue - 1) | 0;
        view.setInt32(Addend, newValue, true);

        return { value: newValue >>> 0, stackCleanup: 4 };
    };

    exports['InterlockedExchangeAdd'] = (ctx, mem, args) => {
        const Addend = args[0];
        const Value = args[1];

        if (Addend === 0 || Addend + 4 > mem.length) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const oldValue = view.getInt32(Addend, true);
        const newValue = (oldValue + (Value | 0)) | 0;
        view.setInt32(Addend, newValue, true);

        return { value: oldValue >>> 0, stackCleanup: 8 };
    };

    exports['CreateEventA'] = (ctx, mem, args) => {
        const bManualReset = args[1] !== 0;
        const bInitialState = args[2] !== 0;
        const lpName = args[3];
        const name = lpName ? readStringA(lpName) : '';
        const sched = System.getInstance().scheduler;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;

        if (name) {
            const existing = namedObjects.acquire('event', name);
            if (existing !== undefined) {
                sched.setLastError(183); // ERROR_ALREADY_EXISTS
                Logger.log(
                    LogCategory.KERNEL32,
                    `CreateEventA(manual=${bManualReset ? 1 : 0},initial=${bInitialState ? 1 : 0},name="${name}") -> 0x${existing.toString(16)} (existing) ret=0x${returnAddr.toString(16)}`
                );
                return existing;
            }
        }

        const handle = sched.createEvent(bManualReset, bInitialState);
        if (name) {
            namedObjects.register('event', name, handle);
        }
        // A NEW named object sets last-error to ERROR_SUCCESS; apps single-instance-guard
        // on GetLastError()==ERROR_ALREADY_EXISTS, so a stale prior error must not leak.
        sched.setLastError(0);
        Logger.log(
            LogCategory.KERNEL32,
            `CreateEventA(manual=${bManualReset ? 1 : 0},initial=${bInitialState ? 1 : 0},name="${name}") -> 0x${handle.toString(16)} ret=0x${returnAddr.toString(16)}`
        );
        return handle;
    };

    exports['CreateEventW'] = (ctx, mem, args) => {
        const bManualReset = args[1] !== 0;
        const bInitialState = args[2] !== 0;
        const lpName = args[3];
        const name = lpName ? readStringW(lpName) : '';
        const sched = System.getInstance().scheduler;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;

        if (name) {
            const existing = namedObjects.acquire('event', name);
            if (existing !== undefined) {
                sched.setLastError(183); // ERROR_ALREADY_EXISTS
                Logger.log(
                    LogCategory.KERNEL32,
                    `CreateEventW(manual=${bManualReset ? 1 : 0},initial=${bInitialState ? 1 : 0},name="${name}") -> 0x${existing.toString(16)} (existing) ret=0x${returnAddr.toString(16)}`
                );
                return existing;
            }
        }

        const handle = sched.createEvent(bManualReset, bInitialState);
        if (name) {
            namedObjects.register('event', name, handle);
        }
        sched.setLastError(0); // ERROR_SUCCESS — newly created (see CreateEventA)
        Logger.log(
            LogCategory.KERNEL32,
            `CreateEventW(manual=${bManualReset ? 1 : 0},initial=${bInitialState ? 1 : 0},name="${name}") -> 0x${handle.toString(16)} ret=0x${returnAddr.toString(16)}`
        );
        return handle;
    };

    exports['CreateIoCompletionPort'] = (ctx, mem, args) => {
        const fileHandle = args[0] >>> 0;
        const existingPortHandle = args[1] >>> 0;
        const completionKey = args[2] >>> 0;
        const concurrentThreads = args[3] >>> 0;

        const resourceProvider = System.getInstance().resourceProvider;
        const scheduler = System.getInstance().scheduler;

        let portHandle = existingPortHandle;
        if (portHandle === 0) {
            const port = {
                kind: 'iocp',
                queue: [] as Array<{ bytesTransferred: number; completionKey: number; overlapped: number }>,
                concurrentThreads,
            };
            portHandle = resourceProvider.registerKernelObject(port);
        } else {
            const existing = resourceProvider.getKernelObject(portHandle) as any;
            if (!existing || existing.kind !== 'iocp') {
                scheduler.setLastError(6); // ERROR_INVALID_HANDLE
                return 0;
            }
        }

        // Associate file handle with completion key (best-effort; async I/O completion posting is not modeled yet).
        if (fileHandle !== 0 && fileHandle !== 0xFFFFFFFF) {
            ioCompletionAssociations.set(fileHandle, completionKey);
        }

        return portHandle >>> 0;
    };

    exports['GetQueuedCompletionStatus'] = (ctx, mem, args) => {
        const completionPortHandle = args[0] >>> 0;
        const lpNumberOfBytesTransferred = args[1] >>> 0;
        const lpCompletionKey = args[2] >>> 0;
        const lpOverlapped = args[3] >>> 0;
        const dwMilliseconds = args[4] >>> 0;

        const resourceProvider = System.getInstance().resourceProvider;
        const scheduler = System.getInstance().scheduler;
        const port = resourceProvider.getKernelObject(completionPortHandle) as any;

        if (!port || port.kind !== 'iocp') {
            scheduler.setLastError(6); // ERROR_INVALID_HANDLE
            return 0;
        }

        const packet = Array.isArray(port.queue) && port.queue.length > 0 ? port.queue.shift() : null;
        if (packet) {
            if (lpNumberOfBytesTransferred) Mem.writeUint32(lpNumberOfBytesTransferred, packet.bytesTransferred >>> 0);
            if (lpCompletionKey) Mem.writeUint32(lpCompletionKey, packet.completionKey >>> 0);
            if (lpOverlapped) Mem.writeUint32(lpOverlapped, packet.overlapped >>> 0);
            scheduler.setLastError(0);
            return 1;
        }

        if (lpNumberOfBytesTransferred) Mem.writeUint32(lpNumberOfBytesTransferred, 0);
        if (lpCompletionKey) Mem.writeUint32(lpCompletionKey, 0);
        if (lpOverlapped) Mem.writeUint32(lpOverlapped, 0);

        // Non-blocking fallback for now: report timeout when queue is empty.
        scheduler.setLastError(WAIT_TIMEOUT);
        Logger.verbose(
            LogCategory.KERNEL32,
            `GetQueuedCompletionStatus(port=0x${completionPortHandle.toString(16)}, timeout=${dwMilliseconds}) -> WAIT_TIMEOUT`
        );
        return 0;
    };

    exports['SetEvent'] = (ctx, mem, args) => {
        const hEvent = args[0];
        const sched = System.getInstance().scheduler;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;
        const ok = sched.setEvent(hEvent);
        logSetEvent(sched, hEvent, ok, returnAddr);
        return ok ? 1 : 0;
    };

    exports['ResetEvent'] = (ctx, mem, args) => {
        const hEvent = args[0];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp >>> 0, true) >>> 0;
        const ok = System.getInstance().scheduler.resetEvent(hEvent);
        logResetEvent(hEvent, ok, returnAddr);
        return ok ? 1 : 0;
    };

    exports['PulseEvent'] = (ctx, mem, args) => {
        const hEvent = args[0];
        const ok = System.getInstance().scheduler.pulseEvent(hEvent);
        Logger.log(LogCategory.KERNEL32,
            `PulseEvent: handle=0x${hEvent.toString(16)} -> ${ok ? 'pulsed' : 'FAILED (invalid handle?)'}`);
        return ok ? 1 : 0;
    };

    exports['OpenEventA'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringA(lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(2); // ERROR_FILE_NOT_FOUND
            return 0;
        }
        const handle = namedObjects.acquire('event', name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        return handle;
    };

    exports['OpenEventW'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringW(lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        const handle = namedObjects.acquire('event', name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        return handle;
    };

    exports['CreateMutexA'] = (ctx, mem, args) => {
        const bInitialOwner = args[1] !== 0;
        const lpName = args[2];
        const name = lpName ? readStringA(lpName) : '';
        const sched = System.getInstance().scheduler;

        if (name) {
            const existing = namedObjects.acquire('mutex', name);
            if (existing !== undefined) {
                sched.setLastError(183); // ERROR_ALREADY_EXISTS
                return existing;
            }
        }

        const handle = sched.createMutex(bInitialOwner);
        if (name) {
            namedObjects.register('mutex', name, handle);
        }
        sched.setLastError(0); // ERROR_SUCCESS — newly created (see CreateEventA)
        return handle;
    };

    exports['CreateMutexW'] = (ctx, mem, args) => {
        const bInitialOwner = args[1] !== 0;
        const lpName = args[2];
        const name = lpName ? readStringW(lpName) : '';
        const sched = System.getInstance().scheduler;

        if (name) {
            const existing = namedObjects.acquire('mutex', name);
            if (existing !== undefined) {
                sched.setLastError(183); // ERROR_ALREADY_EXISTS
                return existing;
            }
        }

        const handle = sched.createMutex(bInitialOwner);
        if (name) {
            namedObjects.register('mutex', name, handle);
        }
        sched.setLastError(0); // ERROR_SUCCESS — newly created (see CreateEventA)
        return handle;
    };

    exports['OpenMutexA'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringA(lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        const handle = namedObjects.acquire('mutex', name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        return handle;
    };

    exports['OpenMutexW'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringW(lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        const handle = namedObjects.acquire('mutex', name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        return handle;
    };

    exports['ReleaseMutex'] = (ctx, mem, args) => {
        const hMutex = args[0];
        return System.getInstance().scheduler.releaseMutex(hMutex) ? 1 : 0;
    };

    exports['CreateSemaphoreA'] = (ctx, mem, args) => {
        const lInitialCount = args[1] | 0;
        const lMaximumCount = args[2] | 0;
        const lpName = args[3];
        const name = lpName ? readStringA(lpName) : '';
        const sched = System.getInstance().scheduler;

        if (name) {
            const existing = namedObjects.acquire('semaphore', name);
            if (existing !== undefined) {
                sched.setLastError(183);
                return existing;
            }
        }

        const handle = sched.createSemaphore(lInitialCount, lMaximumCount);
        if (name) {
            namedObjects.register('semaphore', name, handle);
        }
        sched.setLastError(0); // ERROR_SUCCESS — newly created (see CreateEventA)
        return handle;
    };

    exports['CreateSemaphoreW'] = (ctx, mem, args) => {
        const lInitialCount = args[1] | 0;
        const lMaximumCount = args[2] | 0;
        const lpName = args[3];
        const name = lpName ? readStringW(lpName) : '';
        const sched = System.getInstance().scheduler;

        if (name) {
            const existing = namedObjects.acquire('semaphore', name);
            if (existing !== undefined) {
                sched.setLastError(183);
                return existing;
            }
        }

        const handle = sched.createSemaphore(lInitialCount, lMaximumCount);
        if (name) {
            namedObjects.register('semaphore', name, handle);
        }
        sched.setLastError(0); // ERROR_SUCCESS — newly created (see CreateEventA)
        return handle;
    };

    exports['OpenSemaphoreA'] = (ctx, mem, args) => {
        const lpName = args[2];
        const name = lpName ? readStringA(lpName) : '';
        if (!name) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        const handle = namedObjects.acquire('semaphore', name);
        if (handle === undefined) {
            System.getInstance().scheduler.setLastError(2);
            return 0;
        }
        return handle;
    };

    exports['ReleaseSemaphore'] = (ctx, mem, args) => {
        const hSemaphore = args[0];
        const lReleaseCount = args[1] | 0;
        const lpPreviousCount = args[2];
        const result = System.getInstance().scheduler.releaseSemaphore(hSemaphore, lReleaseCount);
        if (lpPreviousCount) {
            Mem.writeUint32(lpPreviousCount, result.previousCount >>> 0);
        }
        return result.ok ? 1 : 0;
    };

    exports['WaitForSingleObject'] = (ctx, mem, args) => {
        const hHandle = args[0];
        const dwMilliseconds = args[1] >>> 0;
        const system = System.getInstance();
        const sched = system.scheduler;
        const cpu = system.process?.v86?.cpu || system.process?.v86?.v86?.cpu;

        if (!cpu) return WAIT_FAILED;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 12;  // 4 (ret addr) + 8 (2 args stdcall)

        // Validate return address is in a known code range (not data/heap)
        if (returnAddr < 0x100000 || returnAddr >= 0x80000000) {
            Logger.error(LogCategory.KERNEL32,
                `WaitForSingleObject: BAD returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)} EBP=0x${ctx.ebp.toString(16)} — returning WAIT_FAILED`);
            return WAIT_FAILED;
        }

        const result = sched.waitForSingleObjectWithContext(
            hHandle,
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );

        // Thread blocked with no runnable peers — redirect to spin loop via ThunkResult
        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 8 };
        }

        const now = performance.now();
        waitSingleCount += 1;
        lastWaitSingleMs = dwMilliseconds;
        lastWaitSingleResult = result;
        if (now - lastWaitLog >= 1000) {
            Logger.log(
                LogCategory.KERNEL32,
                `WaitForSingleObject: calls=${waitSingleCount} lastMs=${lastWaitSingleMs} lastResult=0x${lastWaitSingleResult.toString(16)}`
            );
            lastWaitLog = now;
            waitSingleCount = 0;
            waitMultipleCount = 0;
        }
        return result === WAIT_FAILED ? 0xFFFFFFFF : result;
    };

    exports['WaitForSingleObjectEx'] = (ctx, mem, args) => {
        const hHandle = args[0];
        const dwMilliseconds = args[1] >>> 0;
        const bAlertable = args[2] !== 0;
        const system = System.getInstance();
        const sched = system.scheduler;
        const cpu = system.process?.v86?.cpu || system.process?.v86?.v86?.cpu;

        if (!cpu) return WAIT_FAILED;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 16;  // 4 (ret addr) + 12 (3 args stdcall)

        if (returnAddr < 0x100000 || returnAddr >= 0x80000000) {
            Logger.error(LogCategory.KERNEL32,
                `WaitForSingleObjectEx: BAD returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)} — returning WAIT_FAILED`);
            return WAIT_FAILED;
        }

        const result = sched.waitForSingleObjectExWithContext(
            hHandle,
            dwMilliseconds,
            bAlertable,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );

        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 12 };
        }
        return result === WAIT_FAILED ? 0xFFFFFFFF : result;
    };

    exports['WaitForMultipleObjects'] = (ctx, mem, args) => {
        const nCount = args[0] >>> 0;
        const lpHandles = args[1];
        const bWaitAll = args[2] !== 0;
        const dwMilliseconds = args[3] >>> 0;
        const system = System.getInstance();
        const sched = system.scheduler;

        if (nCount === 0 || lpHandles === 0 || lpHandles + nCount * 4 > mem.length) {
            sched.setLastError(6);
            return WAIT_FAILED;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const handles: number[] = [];
        for (let i = 0; i < nCount; i++) {
            handles.push(view.getUint32(lpHandles + i * 4, true));
        }

        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 20;  // WaitForMultipleObjects: 4 (ret) + 16 (4 args)

        // Validate return address is in a known code range
        if (returnAddr < 0x100000 || returnAddr >= 0x80000000) {
            Logger.error(LogCategory.KERNEL32,
                `WaitForMultipleObjects: BAD returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)} EBP=0x${ctx.ebp.toString(16)} — returning WAIT_FAILED`);
            return WAIT_FAILED;
        }

        const result = sched.waitForObjectsWithContext(
            handles,
            bWaitAll,
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );

        // Thread blocked with no runnable peers — redirect to spin loop via ThunkResult
        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 16 };
        }

        const now = performance.now();
        waitMultipleCount += 1;
        lastWaitMultipleMs = dwMilliseconds;
        lastWaitMultipleResult = result;
        lastWaitMultipleCount = nCount;
        lastWaitMultipleAll = bWaitAll;
        if (now - lastWaitLog >= 1000) {
            Logger.log(
                LogCategory.KERNEL32,
                `WaitForMultipleObjects: calls=${waitMultipleCount} lastMs=${lastWaitMultipleMs} count=${lastWaitMultipleCount} waitAll=${lastWaitMultipleAll ? 1 : 0} lastResult=0x${lastWaitMultipleResult.toString(16)}`
            );
            lastWaitLog = now;
            waitSingleCount = 0;
            waitMultipleCount = 0;
        }
        return result;
    };

    exports['WaitForMultipleObjectsEx'] = (ctx, mem, args) => {
        const nCount = args[0] >>> 0;
        const lpHandles = args[1];
        const bWaitAll = args[2] !== 0;
        const dwMilliseconds = args[3] >>> 0;
        const bAlertable = args[4] !== 0;

        const system = System.getInstance();
        const sched = system.scheduler;

        if (nCount === 0 || lpHandles === 0 || lpHandles + nCount * 4 > mem.length) {
            sched.setLastError(6);
            return WAIT_FAILED;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const handles: number[] = [];
        for (let i = 0; i < nCount; i++) {
            handles.push(view.getUint32(lpHandles + i * 4, true));
        }

        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 24;  // WaitForMultipleObjectsEx: 4 (ret) + 20 (5 args)

        if (returnAddr < 0x100000 || returnAddr >= 0x80000000) {
            Logger.error(LogCategory.KERNEL32,
                `WaitForMultipleObjectsEx: BAD returnAddr=0x${returnAddr.toString(16)} ESP=0x${ctx.esp.toString(16)} — returning WAIT_FAILED`);
            return WAIT_FAILED;
        }

        const result = sched.waitForObjectsExWithContext(
            handles,
            bWaitAll,
            dwMilliseconds,
            bAlertable,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );

        // Thread blocked with no runnable peers — redirect to spin loop via ThunkResult.
        // Must match WaitForSingleObject / WaitForMultipleObjects behavior.
        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 20 };
        }

        return result === WAIT_FAILED ? 0xFFFFFFFF : result;
    };

    exports['QueueUserAPC'] = (ctx, mem, args) => {
        const pfnApc = args[0] >>> 0;
        const hThread = args[1] >>> 0;
        const dwData = args[2] >>> 0;
        const sched = System.getInstance().scheduler;

        if (pfnApc === 0) {
            sched.setLastError(87); // ERROR_INVALID_PARAMETER
            return 0;
        }

        const ok = sched.queueUserApcByHandle(hThread, pfnApc, dwData);
        if (!ok) {
            sched.setLastError(6); // ERROR_INVALID_HANDLE
            return 0;
        }
        return 1;
    };

    exports['SignalObjectAndWait'] = (ctx, mem, args) => {
        const hObjectToSignal = args[0] >>> 0;
        const hObjectToWait = args[1] >>> 0;
        const dwMilliseconds = args[2] >>> 0;
        const bAlertable = args[3] !== 0;
        const system = System.getInstance();
        const sched = system.scheduler;
        const cpu = system.process?.v86?.cpu || system.process?.v86?.v86?.cpu;
        if (!cpu) return WAIT_FAILED;

        if (!sched.setEvent(hObjectToSignal)) {
            sched.setLastError(6); // ERROR_INVALID_HANDLE
            return WAIT_FAILED;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 20; // 4 (ret addr) + 16 (4 args)
        const result = sched.waitForSingleObjectExWithContext(
            hObjectToWait,
            dwMilliseconds,
            bAlertable,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags }
        );

        if (result === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 16 };
        }

        return result === WAIT_FAILED ? 0xFFFFFFFF : result;
    };

    const acquireSrwLock = (
        ctx: Parameters<ThunkImplementation>[0],
        mem: Uint8Array,
        lockPtr: number,
        wantExclusive: boolean,
    ) => {
        const sched = getScheduler();
        const tid = sched.getCurrentThreadId();
        const tryGrant = wantExclusive
            ? () => tryAcquireSrwExclusive(lockPtr, tid)
            : () => tryAcquireSrwShared(lockPtr, tid);

        if (tryGrant()) {
            return { value: 0, stackCleanup: 4 };
        }

        const waitEvent = ensureSrwWaitEvent(lockPtr, sched);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 8;
        const blocked = sched.enterSrwLockWithContext(
            lockPtr,
            wantExclusive,
            waitEvent,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (!blocked) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
        }
        return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
    };

    const releaseSrwAndWake = (lockPtr: number, wakeEvent: number): void => {
        if (!wakeEvent) return;
        const sched = getScheduler();
        if (sched.hasWaitersForHandle(wakeEvent)) {
            sched.setEvent(wakeEvent);
        }
    };

    exports['AcquireSRWLockShared'] = (ctx, mem, args) =>
        acquireSrwLock(ctx, mem, args[0] >>> 0, false);
    exports['AcquireSRWLockExclusive'] = (ctx, mem, args) =>
        acquireSrwLock(ctx, mem, args[0] >>> 0, true);
    exports['ReleaseSRWLockShared'] = (ctx, _mem, args) => {
        const wakeEvent = releaseSrwShared(args[0] >>> 0, getScheduler().getCurrentThreadId());
        releaseSrwAndWake(args[0] >>> 0, wakeEvent);
        return { value: 0, stackCleanup: 4 };
    };
    exports['ReleaseSRWLockExclusive'] = (ctx, _mem, args) => {
        const wakeEvent = releaseSrwExclusive(args[0] >>> 0, getScheduler().getCurrentThreadId());
        releaseSrwAndWake(args[0] >>> 0, wakeEvent);
        return { value: 0, stackCleanup: 4 };
    };

    exports['TryAcquireSRWLockExclusive'] = (_ctx, _mem, args) => {
        const lockPtr = args[0] >>> 0;
        const tid = getScheduler().getCurrentThreadId();
        return tryAcquireSrwExclusive(lockPtr, tid) ? 1 : 0;
    };

    exports['WakeConditionVariable'] = (_ctx, _mem, args) => {
        const cvPtr = args[0] >>> 0;
        if (!cvPtr) return 0;
        const sched = getScheduler();
        const wakeEvent = ensureSrwWaitEvent(cvPtr, sched);
        sched.wakeConditionVariable(wakeEvent, false);
        return 0;
    };

    exports['WakeAllConditionVariable'] = (_ctx, _mem, args) => {
        const cvPtr = args[0] >>> 0;
        if (!cvPtr) return 0;
        const sched = getScheduler();
        const wakeEvent = ensureSrwWaitEvent(cvPtr, sched);
        sched.wakeConditionVariable(wakeEvent, true);
        return 0;
    };

    exports['SleepConditionVariableSRW'] = (ctx, mem, args) => {
        const cvPtr = args[0] >>> 0;
        const lockPtr = args[1] >>> 0;
        const dwMilliseconds = args[2] >>> 0;
        const flags = args[3] >>> 0;
        const sharedHeld = (flags & 1) !== 0;
        const sched = getScheduler();
        const tid = sched.getCurrentThreadId();

        // Same wake contract as ReleaseSRWLock*: threads queued on the lock must
        // be signalled when this wait releases it, or they sleep on a free lock.
        const srwWake = sharedHeld ? releaseSrwShared(lockPtr, tid) : releaseSrwExclusive(lockPtr, tid);
        releaseSrwAndWake(lockPtr, srwWake);

        const cvEvent = ensureSrwWaitEvent(cvPtr, sched);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 20;  // 4 (ret addr) + 16 (4 args stdcall)
        const waitResult = sched.sleepConditionVariableSrwWithContext(
            cvEvent,
            lockPtr,
            sharedHeld,
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (waitResult === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 16 };
        }
        return waitResult;
    };

    exports['SleepConditionVariableCS'] = (ctx, mem, args) => {
        const cvPtr = args[0] >>> 0;
        const csPtr = args[1] >>> 0;
        const dwMilliseconds = args[2] >>> 0;
        const sched = getScheduler();
        const currentThreadId = sched.getCurrentThreadId();

        // Release the critical section (LeaveCriticalSection semantics) so the signalling
        // thread can take it, change the predicate and Wake. Then block on the CV event;
        // wakeThread re-takes the CS on wake (cvReacquireCs).
        if (csPtr && csPtr + CS_SIZE <= mem.length) {
            const ownerThread = Mem.readUint32((csPtr + CS_OFFSET_OWNER) >>> 0) ?? 0;
            if (ownerThread === currentThreadId || ownerThread === 0) {
                let lockSem = Mem.readUint32((csPtr + CS_OFFSET_LOCKSEMAPHORE) >>> 0) ?? 0;
                if (lockSem !== 0 && !isValidSyncHandle(lockSem)) {
                    Mem.writeUint32((csPtr + CS_OFFSET_LOCKSEMAPHORE) >>> 0, 0);
                    lockSem = 0;
                }
                const hasWaiters = lockSem !== 0 && sched.hasWaitersForHandle(lockSem);
                Mem.writeUint32((csPtr + CS_OFFSET_RECURSION) >>> 0, 0);
                if (hasWaiters) {
                    clearCsOwner(csPtr, ownerThread);
                    sched.setEvent(lockSem);
                } else {
                    Mem.writeUint32((csPtr + CS_OFFSET_LOCKCOUNT) >>> 0, 0xffffffff);
                    Mem.writeUint32((csPtr + CS_OFFSET_OWNER) >>> 0, 0);
                    clearCsOwner(csPtr, ownerThread);
                }
            }
        }

        const cvEvent = ensureSrwWaitEvent(cvPtr, sched);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true);
        const postReturnEsp = ctx.esp + 16;
        const waitResult = sched.sleepConditionVariableCsWithContext(
            cvEvent,
            csPtr,
            dwMilliseconds,
            returnAddr,
            postReturnEsp,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (waitResult === WAIT_BLOCKED_NO_SWITCH) {
            return { value: 0, blockedNoSwitch: true, stackCleanup: 16 };
        }
        return { value: waitResult, stackCleanup: 16 };
    };

    exports['CreateWaitableTimerA'] = (ctx, mem, args) => {
        const bManualReset = args[1] !== 0;
        const hTimer = System.getInstance().scheduler.createEvent(bManualReset, false);
        waitableTimers.set(hTimer, { wheelId: null, periodMs: 0 });
        return hTimer;
    };

    exports['CreateWaitableTimerW'] = exports['CreateWaitableTimerA'];

    exports['SetWaitableTimer'] = (ctx, mem, args) => {
        const hTimer = args[0] >>> 0;
        const pDueTime = args[1] >>> 0;
        const lPeriod = args[2] | 0;

        const timer = waitableTimers.get(hTimer);
        if (!timer) {
            return 0;
        }

        // Drive the timer off the scheduler's virtual-time timer wheel — NOT a host
        // setTimeout. A host timer is a macrotask: it only fires when the worker yields
        // its JS event loop, so when a guest thread busy-spins (monopolizing the worker
        // cycle loop) the callback never runs → the timer event is never signalled →
        // any thread blocked on this handle (e.g. a Galaxy/DirectSound mixer waiting on
        // its periodic clock) deadlocks → producer-consumer livelock. The timer wheel is
        // advanced in-band with guest execution (virtual time), so it fires deterministically
        // regardless of how long the guest spins. Mirrors winmm timeSetEvent. (HP freeze,
        // root-caused 2026-06-26.)
        const scheduler = System.getInstance().scheduler;
        const wheel = scheduler.timerWheel;
        if (timer.wheelId !== null) {
            wheel.cancel(timer.wheelId);
            timer.wheelId = null;
        }

        // FILETIME/relative due-time semantics are approximated here.
        let delayMs = 1;
        if (pDueTime) {
            const low = Mem.readUint32(pDueTime) ?? 0;
            const high = Mem.readUint32(pDueTime + 4) ?? 0;
            const signedHigh = (high << 0);
            if (signedHigh < 0) {
                const due100ns = ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0));
                const abs100ns = due100ns < 0n ? -due100ns : due100ns;
                delayMs = Number(abs100ns / 10000n);
            }
        }

        timer.periodMs = Math.max(0, lPeriod);
        const fire = () => { System.getInstance().scheduler.setEvent(hTimer); };

        if (timer.periodMs > 0) {
            // Fire once after the due time, then re-arm a periodic wheel timer at the
            // period (due time and period can differ — a single periodic add() can't
            // express both, so the due fire arms the recurring one).
            timer.wheelId = wheel.add(Math.max(1, delayMs), false, TimerKind.WAITABLE_TIMER, () => {
                fire();
                const t = waitableTimers.get(hTimer);
                if (t && t.periodMs > 0) {
                    t.wheelId = wheel.add(t.periodMs, true, TimerKind.WAITABLE_TIMER, fire, TimeService.getInstance().nowMs());
                }
            }, TimeService.getInstance().nowMs());
        } else {
            timer.wheelId = wheel.add(Math.max(1, delayMs), false, TimerKind.WAITABLE_TIMER, fire, TimeService.getInstance().nowMs());
        }

        return 1;
    };

    exports['CreateTimerQueue'] = () => {
        const handle = nextTimerQueueHandle++;
        timerQueueHandles.add(handle);
        return handle;
    };

    // Arm (or re-arm) a timer-queue timer: a one-shot due fire that invokes the guest
    // WAITORTIMERCALLBACK on the shared timer-pump thread, then — for a periodic timer —
    // arms a SINGLE recurring wheel entry. The recurring entry re-fires the callback itself
    // (periodic=true); the callback must NOT re-add another entry, or each fire would spawn a
    // fresh periodic timer → exponential timer-wheel growth. Mirrors SetWaitableTimer.
    const armTimerQueueTimer = (hTimer: number, dueMs: number): void => {
        const wheel = cachedScheduler.timerWheel;
        const invoke = (): void => {
            const cur = timerQueueTimers.get(hTimer);
            if (!cur) return;
            // WAITORTIMERCALLBACK(PVOID Parameter, BOOLEAN TimerOrWaitFired=TRUE).
            cachedScheduler.postTimerCallback(cur.callback, [cur.parameter, 1]);
        };
        const entry = timerQueueTimers.get(hTimer);
        if (!entry) return;
        entry.wheelId = wheel.add(dueMs, false, TimerKind.WAITABLE_TIMER, () => {
            invoke();
            const cur = timerQueueTimers.get(hTimer);
            if (cur && cur.periodMs > 0) {
                cur.wheelId = wheel.add(
                    Math.max(1, cur.periodMs), true, TimerKind.WAITABLE_TIMER,
                    invoke, TimeService.getInstance().nowMs(),
                );
            } else if (cur) {
                cur.wheelId = null;
            }
        }, TimeService.getInstance().nowMs());
    };

    exports['CreateTimerQueueTimer'] = (_ctx, _mem, args) => {
        const phNewTimer = args[0] >>> 0;
        const timerQueue = args[1] >>> 0;
        const callback = args[2] >>> 0;
        const parameter = args[3] >>> 0;
        const dueTime = args[4] >>> 0;
        const period = args[5] >>> 0;

        if (!timerQueueHandles.has(timerQueue)) {
            cachedScheduler.setLastError(6); // ERROR_INVALID_HANDLE
            return 0;
        }

        const hTimer = nextTimerQueueTimerHandle++;
        timerQueueTimers.set(hTimer, { queue: timerQueue, wheelId: null, periodMs: period, callback, parameter });
        cachedScheduler.ensureTimerPumpThread();
        armTimerQueueTimer(hTimer, Math.max(1, dueTime));

        if (phNewTimer) Mem.writeUint32(phNewTimer, hTimer);
        return 1;
    };

    exports['ChangeTimerQueueTimer'] = (_ctx, _mem, args) => {
        const timerQueue = args[0] >>> 0;
        const timer = args[1] >>> 0;
        const dueTime = args[2] >>> 0;
        const period = args[3] >>> 0;
        const entry = timerQueueTimers.get(timer);
        if (!entry || entry.queue !== timerQueue) {
            cachedScheduler.setLastError(6);
            return 0;
        }

        if (entry.wheelId !== null) cachedScheduler.timerWheel.cancel(entry.wheelId);
        entry.periodMs = period;
        armTimerQueueTimer(timer, Math.max(1, dueTime));
        return 1;
    };

    exports['DeleteTimerQueueTimer'] = (_ctx, _mem, args) => {
        const timerQueue = args[0] >>> 0;
        const timer = args[1] >>> 0;
        const completionEvent = args[2] >>> 0;
        const entry = timerQueueTimers.get(timer);
        if (!entry || entry.queue !== timerQueue) {
            cachedScheduler.setLastError(6);
            return 0;
        }
        if (entry.wheelId !== null) {
            cachedScheduler.timerWheel.cancel(entry.wheelId);
        }
        timerQueueTimers.delete(timer);
        if (completionEvent) cachedScheduler.setEvent(completionEvent);
        return 1;
    };

    exports['UnregisterWait'] = (_ctx, _mem, args) => {
        const waitHandle = args[0] >>> 0;
        if (!waitHandle) {
            cachedScheduler.setLastError(6);
            return 0;
        }
        registeredWaits.delete(waitHandle);
        return 1;
    };

    exports['UnregisterWaitEx'] = (_ctx, _mem, args) => {
        const waitHandle = args[0] >>> 0;
        const completionEvent = args[1] >>> 0;
        if (!waitHandle) {
            cachedScheduler.setLastError(6);
            return 0;
        }
        registeredWaits.delete(waitHandle);
        if (completionEvent) cachedScheduler.setEvent(completionEvent);
        return 1;
    };

    /**
     * Fast-path implementations for high-frequency synchronization functions.
     * ZERO-OVERHEAD: Optimized to the absolute limit.
     */
    const fastPathEnterCriticalSection = (cpu: any, mem8: Uint8Array, mem32: Uint32Array, dataView: DataView): number | null | undefined => {
        // [ESP+4] is lpCriticalSection
        const esp = cpu.reg32[4];
        const ptr = dataView.getUint32(esp + 4, true);

        if (ptr === 0 || ptr + 24 > mem8.length) return 0; // Guard (CS is at least 24 bytes)

        // Alignment check: if not 4-byte aligned, fallback to slow path (unlikely for CRITICAL_SECTION)
        if ((ptr & 3) !== 0) return null;
        const ptr32 = ptr >>> 2;

        const ownerThread = mem32[ptr32 + 3]; // offset 12: OwningThread

        // Use module-level cached reference to scheduler
        const sched = cachedScheduler || getScheduler();
        const currentThreadId = typeof (sched as any).getCurrentThreadId === 'function'
            ? (((sched as any).getCurrentThreadId() as number) >>> 0)
            : (((sched as any).currentThreadId ?? 0) >>> 0);
        if (currentThreadId === 0) return null;

        if (ownerThread === 0) {
            const lockCount = mem32[ptr32 + 1];
            // Uninitialized / poisoned CS (heap fill 0xAA…): treat as unlocked before acquire
            if (lockCount !== 0 && lockCount !== 0xffffffff) {
                return null;
            }
            // Case 1: FREE - Acquire it
            mem32[ptr32 + 1] = 0; // offset 4: LockCount = 0
            mem32[ptr32 + 2] = 1; // offset 8: RecursionCount = 1
            mem32[ptr32 + 3] = currentThreadId; // offset 12: OwningThread
            registerCsOwner(ptr, currentThreadId);
            return 0;
        }

        if (ownerThread !== currentThreadId) {
            const ownerState = typeof (sched as any).getThreadStateById === "function"
                ? (sched as any).getThreadStateById(ownerThread)
                : null;
            if (ownerState === null) {
                return null; // stale/garbage owner → slow path normalize
            }
        }

        if (ownerThread === currentThreadId) {
            // Case 2: RECURSIVE - Increment
            mem32[ptr32 + 2]++;
            return 0;
        }

        // Case 3: CONTENTION — fall through to slow path for proper blocking
        return null;
    };

    const fastPathLeaveCriticalSection = (cpu: any, mem8: Uint8Array, mem32: Uint32Array, dataView: DataView): number | null | undefined => {
        const esp = cpu.reg32[4];
        const ptr = dataView.getUint32(esp + 4, true);

        if (ptr === 0 || ptr + 24 > mem8.length || (ptr & 3) !== 0) return 0;
        const ptr32 = ptr >>> 2;

        const rec = mem32[ptr32 + 2]; // offset 8: RecursionCount
        const ownerThread = mem32[ptr32 + 3] >>> 0; // offset 12: OwningThread
        const sched = cachedScheduler || getScheduler();
        const currentThreadId = typeof (sched as any).getCurrentThreadId === 'function'
            ? (((sched as any).getCurrentThreadId() as number) >>> 0)
            : (((sched as any).currentThreadId ?? 0) >>> 0);

        // Non-owner release requires strict slow-path validation/fatal handling.
        if (ownerThread !== 0 && currentThreadId !== 0 && ownerThread !== currentThreadId) {
            return null;
        }

        if (rec > 1) {
            mem32[ptr32 + 2] = rec - 1;
            return 0;
        }

        // Check LockSemaphore BEFORE releasing — if event exists, waiters may be
        // present. Fall to slow path for SetEvent + proper ownership transfer.
        const lockSem = mem32[ptr32 + 4]; // offset 16: LockSemaphore
        if (lockSem !== 0) {
            return null; // Slow path handles release + SetEvent
        }

        // Release fully (no waiters — LockSemaphore == 0)
        mem32[ptr32 + 1] = 0xffffffff; // offset 4: LockCount = -1
        mem32[ptr32 + 2] = 0;          // offset 8: RecursionCount = 0
        mem32[ptr32 + 3] = 0;          // offset 12: OwningThread = 0
        if (ownerThread !== 0) {
            clearCsOwner(ptr, ownerThread);
        } else {
            clearCsOwner(ptr);
        }

        return 0;
    };

    return {
        exports,
        registerFastPathSyncFunctions: (dispatcher: any) => {
            if (dispatcher && typeof dispatcher.registerFastPath === 'function') {
                dispatcher.registerFastPath('kernel32', 'EnterCriticalSection', fastPathEnterCriticalSection);
                dispatcher.registerFastPath('kernel32', 'LeaveCriticalSection', fastPathLeaveCriticalSection);
            }
        }
    };
})();

export const registerFastPathSyncFunctions = syncModule.registerFastPathSyncFunctions;
export const exports: Record<string, ThunkImplementation> = syncModule.exports;
