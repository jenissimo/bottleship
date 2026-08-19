// callback-manager.ts
// Manages invocation of x86 callbacks from JavaScript (WndProc, timer callbacks, enum callbacks, etc.)
//
// Architecture:
// When a WinAPI like DispatchMessage needs to call x86 code (WndProc), we:
// 1. Push callback arguments onto the x86 stack (right-to-left for stdcall)
// 2. Push return stub address (simulating CALL instruction)
// 3. Set EIP to callback address
// 4. Let CPU execute the callback
// 5. Callback RETs to our return stub
// 6. Return stub traps to JS (to record completion), then RETs to original caller
//
// The return stub handles the stack cleanup that the original WinAPI thunk would have done.

import { ThunkGenerator } from './thunk-generator';
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { MemoryGuard } from '../memory/mem-guard';
import { guardStackWrite } from '../memory/stack-write-guard';
import { systemEventLog, SystemEventKind } from '../diagnostics/system-event-log';
import { ThunkMemoryManager } from './thunk-memory-manager';
import { CALLBACK_STUB_SIZE, DEFAULT_STUBS_PER_CLEANUP } from './thunk-constants';
import { CallbackError, ERROR_INVALID_PARAMETER, ERROR_INSUFFICIENT_BUFFER } from './thunk-errors';
import { MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_SIZE } from '../cpu/emulator-config';

export interface CallbackInvocation {
    id: number;
    callbackAddress: number;
    args: number[];
    source?: string;             // Origin tag for diagnostics (e.g. WinMM_timeSetEvent)
    callerCleanup: number;        // How many bytes the original API would have cleaned
    resolve: (result: number) => void;
    reject: (error: Error) => void;
    isCdecl?: boolean;            // If true, caller (not callee) cleans stack on final thunk return
    completeThunk?: (callbackReturnValue: number) => number | null;  // NEW: returns null to continue enumeration
    thunkContext?: {                                       // NEW: closure data (memory, etc.)
        esp: number;                                       // Saved ESP at thunk entry (points to RetAddr)
        returnAddr: number;                                // Saved return address (read from [ESP])
        stackCleanup: number;                              // Stack cleanup for thunk (stdcall)
    };
    enumerationState?: {                                    // NEW: for enumeration callbacks
        continueEnumeration: () => void;                   // Call to invoke next callback
        finishEnumeration: (finalValue: number) => void;    // Call to complete thunk
    };
    espBeforeInvoke?: number;     // ESP before invokeCallback (for stack drift detection)
    frameId?: number;             // Suspended thunk frame associated with completion chain
    ownerThreadId?: number;       // Thread that invoked callback (owner of in-flight return path)
    /** Return EIP was synthesized (e.g. winmm timer thread → spin loop); callerRet check skipped. */
    syntheticReturnEip?: boolean;
    /** Complete only the currently executing API thunk, preserving any outer callback frame. */
    directThunkReturn?: {
        returnAddr: number;
        postEsp: number;
        complete?: (callbackReturnValue: number) => number | null;
    };
}

export interface CallbackReturnStub {
    address: number;
    callbackId: number;
    cleanup: number;  // Stack cleanup bytes (RET N)
    inUse: boolean;   // Whether this stub is currently active (prevents reuse during nested callbacks)
}

export interface CallbackForensicRecord {
    phase: 'invoke' | 'return';
    ts: number;
    callbackId: number;
    callbackAddress: number;
    source: string;
    args: number[];
    callerCleanup: number;
    stubAddress: number;
    esp: number;
    espBeforeInvoke?: number;
    espAfterSetup?: number;
    returnValue?: number;
    callerRet?: number;
    driftStdcall?: number | null;
    driftCdecl?: number | null;
    callingConvention?: string;
    stackTop?: number[];
}

export interface CallbackForensicState {
    pendingCount: number;
    thunkContextDepth: number;
    lastInvoke: CallbackForensicRecord | null;
    lastReturn: CallbackForensicRecord | null;
    suspendedFrames: SuspendedThunkFrame[];
}

export interface SuspendedThunkFrame {
    frameId: number;
    threadId: number;
    espEntry: number;
    returnAddr: number;
    thunkCleanup: number;
    expectedPostEsp: number;
    callbackId: number;
    source: string;
}

export interface InvokeCallbackOptions {
    // For deferred callbacks dispatched at scheduler safe-points:
    // synthesize an explicit return EIP instead of relying on arbitrary stack top.
    forceSyntheticReturnEip?: boolean;
    // Synchronous guest call made by an API such as CallWindowProc: resume
    // where that API's RET N would have returned without consuming an outer frame.
    directThunkReturn?: {
        returnAddr: number;
        postEsp: number;
        complete?: (callbackReturnValue: number) => number | null;
    };
}

// Special callback IDs start from 0x80000000 to distinguish from regular thunks
const CALLBACK_ID_BASE = 0x80000000;

// Common stack cleanup amounts for stdcall APIs
const CLEANUP_AMOUNTS = [0, 4, 8, 12, 16, 20, 24, 32];

// Maximum callback nesting depth to prevent exhaust of return stub pool
const MAX_CALLBACK_NESTING = 32;
const SUSPENDED_FRAME_RING_SIZE = 64;
const MAX_PENDING_CALLBACK_SLOTS = 256;

/** A suspended-thunk completion waiting for its owner thread to become current. */
interface DeferredFrameCompletion {
    frameId: number;
    /** Callback whose completeThunk produced the value; for diagnostics only. */
    functionId: number;
    finalValue: number;
    isCdecl: boolean;
    source: string;
}

export class CallbackManager {
    private v86: any;
    private thunkGenerator: ThunkGenerator;
    private getMemory: () => Uint8Array;

    private pendingCallbacks: Map<number, CallbackInvocation> = new Map();
    private pendingSlotByCallbackId = new Map<number, number>();
    private pendingSlotActive = new Uint8Array(MAX_PENDING_CALLBACK_SLOTS);
    private pendingSlotCallbackId = new Uint32Array(MAX_PENDING_CALLBACK_SLOTS);
    private pendingSlotOwnerThreadId = new Uint32Array(MAX_PENDING_CALLBACK_SLOTS);
    private pendingSlotFrameId = new Uint32Array(MAX_PENDING_CALLBACK_SLOTS);
    /** Per-slot invocation source — identifies who holds slots on exhaustion. */
    private pendingSlotSource: string[] = new Array(MAX_PENDING_CALLBACK_SLOTS).fill('');
    /** Count of in-flight winmm timer-callback slots (source 'winmm_timer').
     *  A winmm timer callback abandoned mid-flight (e.g. its SetEvent wakes the waiter
     *  thread → context switch → resumed at the spin loop without ever returning through
     *  its stub) leaks its slot; a steadily-climbing value here is that abandonment leak
     *  (distinct from the now-fixed this.timers leak). */
    private winmmInFlight = 0;
    /** Abandonment probe: cumulative winmm_timer callbacks that reached their
     *  return stub (handleCallbackReturn actually ran) vs that were released. If
     *  winmmStubReached ≪ the scheduler's dispatch.invoked, callbacks are abandoned
     *  BEFORE returning through their stub — i.e. the timer thread's EIP was diverted
     *  to the spin loop mid-callback (never reaches RET → stub → releaseCallback). */
    private winmmStubReached = 0;
    private winmmReleased = 0;
    private pendingSlotHint = 0;
    private pendingSlotCount = 0;
    /** Fired when pending callbacks and suspended frames are both idle. */
    private idleListeners: Array<() => void> = [];

    // Map: cleanup amount -> array of stubs for that cleanup
    private stubsByCleanup: Map<number, CallbackReturnStub[]> = new Map();
    // Map: callbackId -> stub
    private stubsById: Map<number, CallbackReturnStub> = new Map();

    private stubPoolBase = 0x01F00000; // Default fallback, will be set dynamically
    private stubPoolEnd = 0; // Will be calculated based on stubPoolBase
    private nextCallbackId = 1;
    private stubsPerCleanup = DEFAULT_STUBS_PER_CLEANUP;

    // Fixed-size ring buffer for suspended thunk frames (no hot-path allocations).
    private frameActive = new Uint8Array(SUSPENDED_FRAME_RING_SIZE);
    private frameIdRing = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameThreadId = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameEspEntry = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameReturnAddr = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameThunkCleanup = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    /**
     * EBX/ESI/EDI/EBP as the SUSPENDED THUNK's caller left them. A guest callback must give
     * these back untouched (stdcall/cdecl both make them callee-saved), so a difference at
     * the direct restore is OUR bug, not the game's — and the symptom lands far away, at the
     * caller's next use of the register. Nothing consumes this but the check below.
     */
    private frameCalleeSaved = new Uint32Array(SUSPENDED_FRAME_RING_SIZE * 4);
    private frameExpectedPostEsp = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameCallbackId = new Uint32Array(SUSPENDED_FRAME_RING_SIZE);
    private frameSource: string[] = new Array(SUSPENDED_FRAME_RING_SIZE).fill('');
    private frameWriteIdx = 0;
    private nextFrameId = 1;
    private frameStack = new Int16Array(SUSPENDED_FRAME_RING_SIZE);
    private frameStackDepth = 0;
    /** Terminal frame completions that arrived while a thread OTHER than the frame's owner
     *  was current, keyed by owner thread. Drained at that thread's own safe point (see the
     *  thread-mismatch branch in the callback-return path). At most one per thread: a frame
     *  completes exactly once, and its owner is parked until it does. */
    private deferredCompletions = new Map<number, DeferredFrameCompletion>();
    private lastInvokeForensics: CallbackForensicRecord | null = null;
    private lastReturnForensics: CallbackForensicRecord | null = null;
    private lastWinMmForensicLogMs = 0;

    constructor(v86: any, thunkGenerator: ThunkGenerator, getMemory: () => Uint8Array) {
        this.v86 = v86;
        this.thunkGenerator = thunkGenerator;
        this.getMemory = getMemory;
        this.resetSuspendedFrames();
    }

    private trackPendingCallback(callbackId: number, ownerThreadId: number, frameId: number, source: string = ''): boolean {
        const id = callbackId >>> 0;
        if (this.pendingSlotByCallbackId.has(id)) {
            const existing = this.pendingSlotByCallbackId.get(id)!;
            this.pendingSlotOwnerThreadId[existing] = ownerThreadId >>> 0;
            this.pendingSlotFrameId[existing] = frameId >>> 0;
            this.pendingSlotSource[existing] = source;
            return true;
        }
        for (let i = 0; i < MAX_PENDING_CALLBACK_SLOTS; i++) {
            const slot = (this.pendingSlotHint + i) % MAX_PENDING_CALLBACK_SLOTS;
            if (this.pendingSlotActive[slot] !== 0) continue;
            this.pendingSlotActive[slot] = 1;
            this.pendingSlotCallbackId[slot] = id;
            this.pendingSlotOwnerThreadId[slot] = ownerThreadId >>> 0;
            this.pendingSlotFrameId[slot] = frameId >>> 0;
            this.pendingSlotSource[slot] = source;
            if (source === 'winmm_timer') this.winmmInFlight++;
            this.pendingSlotByCallbackId.set(id, slot);
            this.pendingSlotHint = (slot + 1) % MAX_PENDING_CALLBACK_SLOTS;
            this.pendingSlotCount++;
            return true;
        }
        return false;
    }

    private untrackPendingCallback(callbackId: number): void {
        const id = callbackId >>> 0;
        const slot = this.pendingSlotByCallbackId.get(id);
        if (slot === undefined) return;
        this.pendingSlotByCallbackId.delete(id);
        this.pendingSlotActive[slot] = 0;
        this.pendingSlotCallbackId[slot] = 0;
        this.pendingSlotOwnerThreadId[slot] = 0;
        this.pendingSlotFrameId[slot] = 0;
        if (this.pendingSlotSource[slot] === 'winmm_timer') {
            if (this.winmmInFlight > 0) this.winmmInFlight--;
            this.winmmReleased++;
        }
        this.pendingSlotSource[slot] = '';
        if (this.pendingSlotCount > 0) this.pendingSlotCount--;
    }

    /** Live pending-callback-slot occupancy — total + histogram by invocation
     *  source. Surfaced via dbg to identify which subsystem leaks/holds slots. */
    getPendingSlotSummary(): { count: number; max: number; winmmInFlight: number; winmmStubReached: number; winmmReleased: number; bySource: Record<string, number> } {
        const bySource: Record<string, number> = {};
        for (let s = 0; s < MAX_PENDING_CALLBACK_SLOTS; s++) {
            if (this.pendingSlotActive[s] === 0) continue;
            const src = this.pendingSlotSource[s] || 'unknown';
            bySource[src] = (bySource[src] ?? 0) + 1;
        }
        return { count: this.pendingSlotCount, max: MAX_PENDING_CALLBACK_SLOTS, winmmInFlight: this.winmmInFlight,
            winmmStubReached: this.winmmStubReached, winmmReleased: this.winmmReleased, bySource };
    }

    /** Cheap accessor for the live in-flight winmm_timer slot count — used by the timer
     *  dispatch safety net and as a permanent leak-invariant validator (should stay ~0-1). */
    getWinmmInFlight(): number { return this.winmmInFlight; }

    private resetPendingSlots(): void {
        this.pendingSlotByCallbackId.clear();
        this.pendingSlotActive.fill(0);
        this.pendingSlotCallbackId.fill(0);
        this.pendingSlotOwnerThreadId.fill(0);
        this.pendingSlotFrameId.fill(0);
        this.pendingSlotSource.fill('');
        this.winmmInFlight = 0;
        this.winmmStubReached = 0;
        this.winmmReleased = 0;
        this.pendingSlotHint = 0;
        this.pendingSlotCount = 0;
    }

    /**
     * Initialize the callback stub pool. Must be called after memory is available.
     * @param thunkMemoryManager - Optional memory manager for dynamic address allocation
     */
    initialize(thunkMemoryManager?: ThunkMemoryManager): void {
        // Get base address from ThunkMemoryManager if available
        if (thunkMemoryManager) {
            const regions = thunkMemoryManager.getRegions();
            this.stubPoolBase = regions.callbackStubPoolBase;
            this.stubPoolEnd = this.stubPoolBase + regions.callbackStubPoolSize;
        } else {
            // Fallback to default address (for backward compatibility)
            this.stubPoolEnd = this.stubPoolBase + CLEANUP_AMOUNTS.length * this.stubsPerCleanup * CALLBACK_STUB_SIZE;
        }

        const mem = this.getMemory();
        const maxStubPoolEnd = Math.min(this.stubPoolEnd, mem.length);
        const maxStubsPerCleanup = Math.floor(
            (maxStubPoolEnd - this.stubPoolBase) / (CLEANUP_AMOUNTS.length * CALLBACK_STUB_SIZE)
        );
        if (maxStubsPerCleanup <= 0) {
            Logger.error(LogCategory.CALLBACK,
                `Stub pool does not fit in memory: base=0x${this.stubPoolBase.toString(16)} end=0x${this.stubPoolEnd.toString(16)} mem=0x${mem.length.toString(16)}`);
            return;
        }
        if (maxStubsPerCleanup < this.stubsPerCleanup) {
            Logger.warn(LogCategory.CALLBACK,
                `Clamping stubs per cleanup from ${this.stubsPerCleanup} to ${maxStubsPerCleanup} due to memory bounds`);
            this.stubsPerCleanup = maxStubsPerCleanup;
            this.stubPoolEnd = this.stubPoolBase + CLEANUP_AMOUNTS.length * this.stubsPerCleanup * CALLBACK_STUB_SIZE;
        }

        this.stubsByCleanup.clear();
        this.stubsById.clear();
        this.pendingCallbacks.clear();
        this.resetPendingSlots();

        let addr = this.stubPoolBase;
        let idCounter = 0;

        for (const cleanup of CLEANUP_AMOUNTS) {
            const stubs: CallbackReturnStub[] = [];

            for (let i = 0; i < this.stubsPerCleanup; i++) {
                const callbackId = CALLBACK_ID_BASE + idCounter;
                idCounter++;

                // Return stub format (20 bytes, padded to 32 for alignment):
                //
                // 50                PUSH EAX              ; Save callback return value (1 byte)
                // B8 ID ID ID ID    MOV EAX, callbackId   ; (5 bytes)
                // BA 77 B0 00 00    MOV EDX, 0xB077       ; (5 bytes)
                // EF                OUT DX, EAX           ; Trap to JS (1 byte)
                // 58                POP EAX               ; Restore return value (1 byte)
                // C2 NN NN          RET cleanup           ; (3 bytes) or C3 for RET (1 byte)
                // 90...             NOP padding

                let offset = 0;

                // PUSH EAX (50)
                mem[addr + offset++] = 0x50;

                // MOV EAX, callbackId (B8 imm32)
                mem[addr + offset++] = 0xB8;
                mem[addr + offset++] = callbackId & 0xFF;
                mem[addr + offset++] = (callbackId >> 8) & 0xFF;
                mem[addr + offset++] = (callbackId >> 16) & 0xFF;
                mem[addr + offset++] = (callbackId >> 24) & 0xFF;

                // MOV EDX, 0xB077 (BA imm32)
                mem[addr + offset++] = 0xBA;
                mem[addr + offset++] = 0x77;
                mem[addr + offset++] = 0xB0;
                mem[addr + offset++] = 0x00;
                mem[addr + offset++] = 0x00;

                // OUT DX, EAX (EF)
                mem[addr + offset++] = 0xEF;

                // POP EAX (58)
                mem[addr + offset++] = 0x58;

                // RET or RET N
                if (cleanup === 0) {
                    mem[addr + offset++] = 0xC3; // RET
                } else {
                    mem[addr + offset++] = 0xC2; // RET imm16
                    mem[addr + offset++] = cleanup & 0xFF;
                    mem[addr + offset++] = (cleanup >> 8) & 0xFF;
                }

                // NOP padding to 32 bytes
                while (offset < 32) {
                    mem[addr + offset++] = 0x90;
                }

                const stub: CallbackReturnStub = {
                    address: addr,
                    callbackId,
                    cleanup,
                    inUse: false  // Initially not in use
                };

                stubs.push(stub);
                this.stubsById.set(callbackId, stub);
                addr += 32;
            }

            this.stubsByCleanup.set(cleanup, stubs);
        }

        Logger.log(LogCategory.CALLBACK, `Initialized - ${CLEANUP_AMOUNTS.length * this.stubsPerCleanup} return stubs at 0x${this.stubPoolBase.toString(16)}`);
    }

    /**
     * Check if a function ID is a callback return (vs regular thunk)
     */
    isCallbackReturn(functionId: number): boolean {
        return (functionId & CALLBACK_ID_BASE) !== 0;
    }

    /**
     * Handle callback return from x86 code.
     * Called when the return stub traps to JS.
     * 
     * Stub format: PUSH EAX -> MOV EAX, id -> MOV EDX, 0xB077 -> OUT DX, EAX -> POP EAX -> RET
     * When OUT executes, EAX = callbackId, and the real return value is on stack (from PUSH EAX).
     * We need to read it, then let CPU continue with POP EAX and RET.
     */
    handleCallbackReturn(functionId: number): void {
        if (functionId === 0xffffffff) {
            Logger.verbose(LogCategory.CALLBACK, `Callback return 0xffffffff (invalid, ignored)`);
            return;
        }
        const stub = this.stubsById.get(functionId);
        if (!stub) {
            Logger.error(LogCategory.CALLBACK, `Unknown callback stub ID: 0x${functionId.toString(16)}`);
            this.reportFatalFromCallback(0x3003, functionId >>> 0, System.getInstance().scheduler.getCurrentThreadId() >>> 0);
            return;
        }

        const callback = this.pendingCallbacks.get(functionId);
        if (!callback) {
            Logger.error(
                LogCategory.CALLBACK,
                `Callback return without pending invocation (ID: 0x${functionId.toString(16)}, cleanup=${stub.cleanup})`
            );
            this.releaseCallbackWithFatal(functionId, stub, 0x3003, functionId >>> 0, System.getInstance().scheduler.getCurrentThreadId() >>> 0);
            return;
        }
        // Abandonment probe: the stub OUT fired AND a pending record exists — the
        // callback genuinely returned through its stub. Compare against dispatch.invoked.
        if ((callback.source ?? '') === 'winmm_timer') {
            this.winmmStubReached++;
            // The callback body has fully executed (it RETd into this stub), so its
            // atomic-execution pin has done its job — release it now. handleCallbackReturn
            // runs atomically (v86 is paused while this JS executes), so a single unpin here
            // covers every exit path below (normal release + the fatal early-returns).
            try {
                const sch = System.getInstance().scheduler as any;
                sch.unpinTimerCallbackThread();
                sch.traceTimerEvent?.(callback.ownerThreadId ?? 0,
                    `cbReturn#${this.winmmStubReached} id=0x${functionId.toString(16)}`);
                sch.noteWinmmTimerCallbackReturn?.(
                    callback.ownerThreadId ?? 0,
                    callback.callbackAddress >>> 0
                );
                // End the cycle slice: the return resumes at the spin loop, which v86
                // would otherwise honestly execute until the next tick boundary.
                sch.onWinmmTimerCallbackReturned?.();
            } catch { }
        }
        systemEventLog.write(
            SystemEventKind.CALLBACK_RETURN,
            functionId >>> 0,
            callback.ownerThreadId ?? 0,
            callback.callbackAddress >>> 0
        );

        const cpu = this.v86.cpu || (this.v86.v86 && this.v86.v86.cpu);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const esp = cpu.reg32[4];
        const cs = cpu.sreg?.[1] ?? 0;
        const eip = cpu.instruction_pointer?.[0] ?? 0;

        if (esp < 0 || esp + 8 > mem.length) {
            Logger.error(LogCategory.CALLBACK,
                `Callback return: invalid ESP 0x${esp.toString(16)} (mem size=0x${mem.length.toString(16)}), CS=0x${cs.toString(16)}, EIP=0x${eip.toString(16)}`);

            this.reportFatalFromCallback(0x3003, functionId >>> 0, System.getInstance().scheduler.getCurrentThreadId() >>> 0);
            return;
        }

        const returnValue = view.getUint32(esp, true);
        let callerRet = view.getUint32(esp + 4, true) >>> 0;
        let callerRetInStubPool = callerRet >= this.stubPoolBase && callerRet < this.stubPoolEnd;
        let callerRetLowAddress = callerRet < 0x100000;
        let callerRetInStack = this.isGuestStackAddress(callerRet);
        let driftStdcall: number | null = null;
        let driftCdecl: number | null = null;

        if (callback.espBeforeInvoke !== undefined) {
            const expectedESPStdcall = callback.espBeforeInvoke - 4;
            const argsSize = callback.args.length * 4;
            const expectedESPCdecl = callback.espBeforeInvoke - argsSize - 4;

            driftStdcall = esp - expectedESPStdcall;
            driftCdecl = esp - expectedESPCdecl;

            const absDriftStdcall = Math.abs(driftStdcall);
            const absDriftCdecl = Math.abs(driftCdecl);
            if (driftStdcall !== 0 && driftCdecl !== 0) {
                const minDrift = Math.min(absDriftStdcall, absDriftCdecl);
                if (minDrift > 64) {
                    Logger.error(LogCategory.CALLBACK,
                        `SEVERE STACK DRIFT (>${minDrift} bytes)! Callback 0x${callback.callbackAddress.toString(16)} ` +
                        `msg=0x${callback.args[1]?.toString(16) ?? '?'} - likely stdcall/cdecl mismatch or corruption!`);
        
                    this.reportFatalFromCallback(
                        0x3003,
                        functionId >>> 0,
                        System.getInstance().scheduler.getCurrentThreadId() >>> 0
                    );
                    return;
                }
                Logger.error(LogCategory.CALLBACK,
                    `STACK DRIFT! Callback 0x${callback.callbackAddress.toString(16)} msg=0x${callback.args[1]?.toString(16) ?? '?'} ` +
                    `actual ESP=0x${esp.toString(16)} expectedStdcall=0x${expectedESPStdcall.toString(16)} (drift=${driftStdcall}) ` +
                    `expectedCdecl=0x${expectedESPCdecl.toString(16)} (drift=${driftCdecl})`);
            } else if (driftCdecl === 0) {
                Logger.verbose(LogCategory.CALLBACK,
                    `Callback 0x${callback.callbackAddress.toString(16)} appears to be CDECL (didn't clean ${argsSize} bytes).`);
            }
        }

        let callingConvention = "unknown";
        if (callback.espBeforeInvoke !== undefined && callback.args.length > 0) {
            const argsSize = callback.args.length * 4;
            const espAfterCallbackRet = esp + 4;
            const espDiff = espAfterCallbackRet - callback.espBeforeInvoke;

            if (espDiff === 0) {
                callingConvention = "stdcall (cleaned args)";
            } else if (espDiff === -argsSize) {
                callingConvention = "cdecl (didn't clean args)";
            } else {
                callingConvention = `unknown (espDiff=${espDiff}, expected 0 or -${argsSize})`;
            }

        }

        Logger.verbose(LogCategory.CALLBACK,
            `Callback return: value=0x${returnValue.toString(16)} callerRet=0x${callerRet.toString(16)} cleanup=${stub.cleanup} CS=0x${cs.toString(16)} EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)}`);

        this.lastReturnForensics = {
            phase: 'return',
            ts: performance.now(),
            callbackId: functionId >>> 0,
            callbackAddress: callback.callbackAddress >>> 0,
            source: callback.source ?? 'unknown',
            args: callback.args.slice(0, 8),
            callerCleanup: callback.callerCleanup >>> 0,
            stubAddress: stub.address >>> 0,
            esp: esp >>> 0,
            returnValue: returnValue >>> 0,
            callerRet: callerRet >>> 0,
            driftStdcall,
            driftCdecl,
            callingConvention,
            stackTop: this.readStackDwords(esp, 6),
        };

        if ((callback.source ?? '') === 'WinMM_timeSetEvent') {
            const now = performance.now();
            const hasDrift = (driftStdcall ?? 0) !== 0 && (driftCdecl ?? 0) !== 0;
            if (hasDrift || (now - this.lastWinMmForensicLogMs) > 250) {
                this.lastWinMmForensicLogMs = now;
                Logger.warn(LogCategory.CALLBACK,
                    `[FORENSICS] WinMM callback return id=0x${functionId.toString(16)} ` +
                    `cb=0x${callback.callbackAddress.toString(16)} ret=0x${returnValue.toString(16)} ` +
                    `esp=0x${esp.toString(16)} callerRet=0x${callerRet.toString(16)} ` +
                    `driftStd=${driftStdcall ?? 'n/a'} driftCdecl=${driftCdecl ?? 'n/a'} cc=${callingConvention}`);
            }
        }

        if (!callback.completeThunk && !callback.syntheticReturnEip && !callback.directThunkReturn &&
            (callerRetInStubPool || callerRetInStack || callerRetLowAddress || callerRet === 0 ||
                this.isInvalidGuestReturnAddress(callerRet))) {
            Logger.error(LogCategory.CALLBACK,
                `Invalid callback caller return address 0x${callerRet.toString(16)} ` +
                `(inStubPool=${callerRetInStubPool}, inStack=${callerRetInStack}, lowAddress=${callerRetLowAddress})`);

            this.reportFatalFromCallback(0x3002, callerRet >>> 0, System.getInstance().scheduler.getCurrentThreadId() >>> 0);
            return;
        }

        callback.resolve(returnValue);

        if (callback.directThunkReturn) {
            const returnAddr = callback.directThunkReturn.returnAddr >>> 0;
            const postEsp = callback.directThunkReturn.postEsp >>> 0;
            const completed = callback.directThunkReturn.complete?.(returnValue);
            if (completed === null) {
                this.releaseCallback(functionId, stub);
                return;
            }
            const finalValue = completed === undefined ? returnValue : completed;
            const returnAddrInStack = this.isGuestStackAddress(returnAddr);
            if (returnAddr < 0x1000 || returnAddr >= mem.length || returnAddrInStack
                || postEsp > mem.length) {
                Logger.error(LogCategory.CALLBACK,
                    `Invalid direct thunk return: EIP=0x${returnAddr.toString(16)} ESP=0x${postEsp.toString(16)}` +
                    (returnAddrInStack ? ' — target is INSIDE the guest stack (skewed RET N / stack-executed return)' : ''));
                this.releaseCallbackWithFatal(
                    functionId, stub, 0x3002, returnAddr,
                    System.getInstance().scheduler.getCurrentThreadId() >>> 0,
                );
                return;
            }

            cpu.reg32[0] = finalValue >>> 0;
            cpu.reg32[4] = postEsp;
            if (cpu.is_jumping !== undefined) cpu.is_jumping = true;
            cpu.instruction_pointer[0] = returnAddr;
            this.releaseCallback(functionId, stub);
            return;
        }

        if (callback.completeThunk) {
            const result = callback.completeThunk(returnValue);
            if (result === null) {
                // Intermediate callback in a suspended-thunk chain is complete.
                // Release current stub/record before chaining next callback to avoid stale in-flight state.
                this.releaseCallback(functionId, stub);

                if (callback.enumerationState) {
                    callback.enumerationState.continueEnumeration();
                }
                return;
            }

            const finalValue = result >>> 0;
            const frameId = callback.frameId ?? 0;
            const frameIndex = frameId !== 0 ? this.findFrameIndexById(frameId) : -1;
            const threadId = System.getInstance().scheduler.getCurrentThreadId() >>> 0;
            if (frameIndex < 0) {
                Logger.error(LogCategory.CALLBACK,
                    `Cannot complete suspended thunk: frame not found for callbackId=0x${functionId.toString(16)} frameId=${frameId}`);

                this.releaseCallbackWithFatal(functionId, stub, 0x3003, functionId >>> 0, threadId);
                return;
            }

            const ownerCallbackId = this.frameCallbackId[frameIndex] >>> 0;
            if (ownerCallbackId !== (functionId >>> 0)) {
                Logger.error(LogCategory.CALLBACK,
                    `Suspended frame mismatch: frameId=${frameId} ownerCallback=0x${ownerCallbackId.toString(16)} ` +
                    `actualCallback=0x${(functionId >>> 0).toString(16)}`);

                this.releaseFrame(frameIndex);
                this.releaseCallbackWithFatal(functionId, stub, 0x3003, functionId >>> 0, threadId);
                return;
            }

            const ownerThreadId = this.frameThreadId[frameIndex] >>> 0;
            if (ownerThreadId !== threadId) {
                // Completing a frame WRITES the owner's EIP/ESP/EAX, so it may only run while
                // the owner is current — doing it now would drop those registers on whatever
                // thread happens to be running.
                //
                // This is reachable by design, not corruption: a thread owning a live frame is
                // parked WAITING between pump callbacks (scheduler pumpPark), so the scheduler
                // legitimately runs a sibling, and the JS-driven chain can reach its terminal
                // step with that sibling current. UE1 front-ends hit it on every EndDialog
                // teardown — the modal pump's last WM_NCDESTROY lands after a sibling's async
                // GetMessage resumed. Defer to the owner's own safe point, exactly as a
                // cross-thread async thunk completion already does.
                Logger.log(LogCategory.CALLBACK,
                    `Deferring suspended-thunk completion to owner: frameId=${frameId} ` +
                    `ownerThread=${ownerThreadId} currentThread=${threadId} value=0x${finalValue.toString(16)}`);
                this.deferredCompletions.set(ownerThreadId, {
                    frameId, functionId: functionId >>> 0, finalValue,
                    isCdecl: !!callback.isCdecl,
                    source: callback.source ?? '',
                });
                // The owner is parked with no other waker — the drain only runs once the
                // scheduler makes it current, so ready it here or the frame strands forever.
                System.getInstance().scheduler.wakeThreadForAsyncCompletion(ownerThreadId);
                this.releaseCallback(functionId, stub);
                return;
            }

            const returnAddr = this.frameReturnAddr[frameIndex] >>> 0;
            const returnAddrInStack = this.isGuestStackAddress(returnAddr);
            if (returnAddr < 0x1000 || returnAddr >= mem.length ||
                (returnAddr >= this.stubPoolBase && returnAddr < this.stubPoolEnd) ||
                returnAddrInStack || this.isInvalidGuestReturnAddress(returnAddr)) {
                Logger.error(LogCategory.CALLBACK,
                    `Invalid frame returnAddr: 0x${returnAddr.toString(16)} frameId=${frameId}` +
                    (returnAddrInStack ? ' — INSIDE the guest stack (skewed RET N / stack-executed return)' : ''));
    
                this.releaseCallbackWithFatal(functionId, stub, 0x3002, returnAddr >>> 0, threadId);
                return;
            }

            const targetEsp = callback.isCdecl
                ? ((this.frameEspEntry[frameIndex] + 4) >>> 0)
                : (this.frameExpectedPostEsp[frameIndex] >>> 0);
            if (!(targetEsp >= 0 && targetEsp <= mem.length)) {
                Logger.error(LogCategory.CALLBACK,
                    `Stack-based completion out of bounds: frameId=${frameId} targetESP=0x${targetEsp.toString(16)}`);
    
                this.releaseCallbackWithFatal(functionId, stub, 0x3002, returnAddr >>> 0, threadId);
                return;
            }

            const preWriteEsp = cpu.reg32[4];
            const preWriteEip = cpu.instruction_pointer?.[0] ?? 0;
            this.checkCalleeSavedAcrossCallback(frameIndex, frameId, this.frameSource[frameIndex] ?? '');

            // Direct-restore: do not resume the callback return stub (mid-stub OUT trap).
            // [frameEsp] may still hold spinLoopAddress from redirectStackToSpinLoop.
            cpu.reg32[0] = finalValue >>> 0;
            cpu.reg32[4] = targetEsp >>> 0;
            if (cpu.is_jumping !== undefined) {
                cpu.is_jumping = true;
            }
            cpu.instruction_pointer[0] = returnAddr >>> 0;

            Logger.verbose(LogCategory.CALLBACK,
                `Completed suspended thunk (direct restore): EAX=0x${finalValue.toString(16)}, ` +
                `EIP=0x${returnAddr.toString(16)}, ESP=0x${targetEsp.toString(16)} ` +
                `(stubCleanup=${stub.cleanup}, frameId=${frameId}) ` +
                `preESP=0x${preWriteEsp.toString(16)} preEIP=0x${preWriteEip.toString(16)} ` +
                `stubAddr=0x${stub.address.toString(16)}`);

            this.releaseCallback(functionId, stub);
            this.releaseFrame(frameIndex);

            for (const [cbId, cb] of this.pendingCallbacks.entries()) {
                if ((cb.frameId ?? 0) === frameId) {
                    const orphanStub = this.stubsById.get(cbId);
                    if (orphanStub) this.releaseCallback(cbId, orphanStub);
                    else { this.pendingCallbacks.delete(cbId); this.untrackPendingCallback(cbId); }
                }
            }

            return;
        }

        this.releaseCallback(functionId, stub);

        const currentEip = cpu.instruction_pointer[0] >>> 0;
        const expectedPopEaxAddr = (stub.address + 12) >>> 0;
        if (currentEip !== expectedPopEaxAddr) {
            Logger.error(LogCategory.CALLBACK,
                `EIP mismatch after callback return: expected 0x${expectedPopEaxAddr.toString(16)}, got 0x${currentEip.toString(16)}`);
            this.reportFatalFromCallback(0x3003, functionId >>> 0, System.getInstance().scheduler.getCurrentThreadId() >>> 0);
        }
    }

    /** Register a listener invoked when callback stack becomes fully idle. */
    addIdleListener(fn: () => void): void {
        this.idleListeners.push(fn);
    }

    private notifyIdleIfReady(): void {
        if (!this.canAcceptDeferredCallback()) return;
        for (const fn of this.idleListeners) {
            try {
                fn();
            } catch {
                /* listener must not break callback return path */
            }
        }
    }

    /** Release a callback: delete pending record, untrack slot, mark stub as free. */
    private releaseCallback(functionId: number, stub: CallbackReturnStub): void {
        this.pendingCallbacks.delete(functionId);
        this.untrackPendingCallback(functionId);
        stub.inUse = false;
        this.notifyIdleIfReady();
    }

    /** Report a fatal error then release the callback. */
    private releaseCallbackWithFatal(functionId: number, stub: CallbackReturnStub, code: number, arg: number, threadId: number): void {
        this.reportFatalFromCallback(code, arg, threadId);
        this.releaseCallback(functionId, stub);
    }

    private reportFatalFromCallback(code: number, arg: number, threadId: number): void {
        try {
            const system = System.getInstance();
            const scheduler = system.scheduler;
            const safeCode = code >>> 0;
            const safeArg = arg >>> 0;
            const safeThreadId = threadId >>> 0;

            if (safeCode === 0x3002) {
                scheduler.reportCallbackReturnFatal(safeArg, safeThreadId);
            } else if (safeCode === 0x3003) {
                scheduler.reportCallbackFrameFatal(safeArg, safeThreadId);
            } else {
                scheduler.reportFatalGuard(safeCode, safeArg, safeThreadId);
            }

            if (!system.isExiting) {
                try {
                    (system.process?.dispatcher as any)?.dumpCriticalForensics?.(`callback_fatal_0x${safeCode.toString(16)}`);
                } catch { }
                system.isExiting = true;
                this.v86.stop?.();
            }
        } catch { }
    }

    private findFrameIndexById(frameId: number): number {
        const target = frameId >>> 0;
        if (target === 0) return -1;
        for (let i = 0; i < SUSPENDED_FRAME_RING_SIZE; i++) {
            if (this.frameActive[i] === 1 && (this.frameIdRing[i] >>> 0) === target) {
                return i;
            }
        }
        return -1;
    }

    /** True when `threadId` owns a live suspended-thunk frame (a JS-driven pump such as
     *  DialogBoxParamA). The scheduler's spin-loop safety net uses this to park the thread
     *  WAITING between pump callbacks — invokeCallback is the guaranteed wake source. */
    hasLiveFrameForThread(threadId: number): boolean {
        const tid = threadId >>> 0;
        for (let i = 0; i < this.frameStackDepth; i++) {
            const slot = this.frameStack[i];
            if (slot < 0 || slot >= SUSPENDED_FRAME_RING_SIZE) continue;
            if (this.frameActive[slot] === 1 && (this.frameThreadId[slot] >>> 0) === tid) return true;
        }
        return false;
    }

    /** True when `threadId` has a terminal frame completion waiting for it to become current. */
    hasDeferredCompletionForThread(threadId: number): boolean {
        return this.deferredCompletions.has(threadId >>> 0);
    }

    /** Diagnostics: completions waiting on their owner thread (harness `asyncParked`).
     *  A non-empty list on a stalled guest means an owner never reached its safe point. */
    listDeferredCompletions(): Array<{ threadId: number; frameId: number; source: string; value: number }> {
        return Array.from(this.deferredCompletions.entries()).map(([threadId, d]) => ({
            threadId, frameId: d.frameId, source: d.source, value: d.finalValue >>> 0,
        }));
    }

    /**
     * Apply a completion that was deferred because its owner thread was not current
     * (see the thread-mismatch branch of the callback-return path). Must be called only
     * when `threadId` IS the current thread and its registers are live — the scheduler's
     * async-restore poll is that point, and it is the same one a cross-thread async thunk
     * completion resumes at.
     *
     * Returns true when a completion was applied (the caller should not also let the
     * thread keep spinning at the park address).
     */
    tryApplyDeferredCompletion(threadId: number, cpu: any): boolean {
        const tid = threadId >>> 0;
        const deferred = this.deferredCompletions.get(tid);
        if (!deferred) return false;

        const frameIndex = this.findFrameIndexById(deferred.frameId);
        if (frameIndex < 0) {
            // The frame went away underneath us (process teardown). Drop the completion
            // rather than restoring registers to a frame that no longer describes anything.
            this.deferredCompletions.delete(tid);
            Logger.warn(LogCategory.CALLBACK,
                `Deferred completion dropped: frame ${deferred.frameId} gone (owner T${tid}, source=${deferred.source})`);
            return false;
        }
        if ((this.frameThreadId[frameIndex] >>> 0) !== tid) return false;

        const mem = this.getMemory();
        const returnAddr = this.frameReturnAddr[frameIndex] >>> 0;
        const returnAddrInStack = this.isGuestStackAddress(returnAddr);
        if (returnAddr < 0x1000 || returnAddr >= mem.length ||
            (returnAddr >= this.stubPoolBase && returnAddr < this.stubPoolEnd) ||
            returnAddrInStack || this.isInvalidGuestReturnAddress(returnAddr)) {
            this.deferredCompletions.delete(tid);
            this.releaseFrame(frameIndex);
            Logger.error(LogCategory.CALLBACK,
                `Deferred completion has invalid returnAddr 0x${returnAddr.toString(16)} frameId=${deferred.frameId}` +
                (returnAddrInStack ? ' — INSIDE the guest stack (skewed RET N / stack-executed return)' : ''));
            this.reportFatalFromCallback(0x3002, returnAddr >>> 0, tid);
            return false;
        }

        const targetEsp = deferred.isCdecl
            ? ((this.frameEspEntry[frameIndex] + 4) >>> 0)
            : (this.frameExpectedPostEsp[frameIndex] >>> 0);
        if (!(targetEsp >= 0 && targetEsp <= mem.length)) {
            this.deferredCompletions.delete(tid);
            this.releaseFrame(frameIndex);
            Logger.error(LogCategory.CALLBACK,
                `Deferred completion out of bounds: frameId=${deferred.frameId} targetESP=0x${targetEsp.toString(16)}`);
            this.reportFatalFromCallback(0x3002, returnAddr >>> 0, tid);
            return false;
        }

        this.checkCalleeSavedAcrossCallback(frameIndex, deferred.frameId, deferred.source ?? '');
        cpu.reg32[0] = deferred.finalValue >>> 0;
        cpu.reg32[4] = targetEsp >>> 0;
        if (cpu.is_jumping !== undefined) cpu.is_jumping = true;
        cpu.instruction_pointer[0] = returnAddr >>> 0;

        Logger.log(LogCategory.CALLBACK,
            `Completed deferred suspended thunk on owner T${tid}: EAX=0x${deferred.finalValue.toString(16)}, ` +
            `EIP=0x${returnAddr.toString(16)}, ESP=0x${targetEsp.toString(16)} (frameId=${deferred.frameId})`);

        this.deferredCompletions.delete(tid);
        this.releaseFrame(frameIndex);
        for (const [cbId, cb] of this.pendingCallbacks.entries()) {
            if ((cb.frameId ?? 0) === deferred.frameId) {
                const orphanStub = this.stubsById.get(cbId);
                if (orphanStub) this.releaseCallback(cbId, orphanStub);
                else { this.pendingCallbacks.delete(cbId); this.untrackPendingCallback(cbId); }
            }
        }
        return true;
    }

    /** True while a thunk is suspended inside a guest callback (diagnostics gate). */
    public isInsideSuspendedCallback(): boolean { return this.frameStackDepth > 0; }

    private getTopSuspendedFrameId(): number {
        if (this.frameStackDepth <= 0) return 0;
        const idx = this.frameStack[this.frameStackDepth - 1];
        if (idx < 0 || idx >= SUSPENDED_FRAME_RING_SIZE) return 0;
        if (this.frameActive[idx] !== 1) return 0;
        return this.frameIdRing[idx] >>> 0;
    }

    private allocateSuspendedFrame(
        threadId: number,
        espEntry: number,
        returnAddr: number,
        thunkCleanup: number,
        source: string
    ): number {
        let slot = -1;
        for (let i = 0; i < SUSPENDED_FRAME_RING_SIZE; i++) {
            const idx = (this.frameWriteIdx + i) % SUSPENDED_FRAME_RING_SIZE;
            if (this.frameActive[idx] === 0) {
                slot = idx;
                break;
            }
        }

        if (slot < 0) {
            Logger.error(LogCategory.CALLBACK, `Suspended frame ring overflow (${SUSPENDED_FRAME_RING_SIZE})`);
            this.reportFatalFromCallback(0x3003, 0, threadId >>> 0);
            return 0;
        }

        if (this.frameStackDepth >= this.frameStack.length) {
            Logger.error(LogCategory.CALLBACK, `Suspended frame stack overflow (${this.frameStack.length})`);
            this.reportFatalFromCallback(0x3003, 0, threadId >>> 0);
            return 0;
        }

        const frameId = this.nextFrameId++ >>> 0;
        this.frameActive[slot] = 1;
        this.frameIdRing[slot] = frameId;
        this.frameThreadId[slot] = threadId >>> 0;
        this.frameEspEntry[slot] = espEntry >>> 0;
        this.frameReturnAddr[slot] = returnAddr >>> 0;
        this.frameThunkCleanup[slot] = thunkCleanup >>> 0;
        this.frameExpectedPostEsp[slot] = (espEntry + 4 + thunkCleanup) >>> 0;
        this.frameCallbackId[slot] = 0;
        this.frameSource[slot] = source;
        if (this.checkCalleeSaved) {
            const reg = this.guestRegFile();
            if (reg) {
                this.frameCalleeSaved[slot * 4] = reg[3]!;
                this.frameCalleeSaved[slot * 4 + 1] = reg[6]!;
                this.frameCalleeSaved[slot * 4 + 2] = reg[7]!;
                this.frameCalleeSaved[slot * 4 + 3] = reg[5]!;
            }
        }

        this.frameStack[this.frameStackDepth++] = slot;
        this.frameWriteIdx = (slot + 1) % SUSPENDED_FRAME_RING_SIZE;

        // Pin the thread to prevent preemptive switching during callback chains.
        // On real Windows, APIs like EnumTextureFormats/EnumWindows are synchronous —
        // the callback runs on the calling thread with no preemption points.
        try {
            System.getInstance().scheduler.pinCurrentThread();
        } catch { /* scheduler not ready yet */ }

        return frameId;
    }

    /** Same `__checkCalleeSaved` switch the dispatcher's sibling check uses: this sits on the
     *  guest-callback path (WndProc dispatch, enum callbacks, timer procs), so it is off by
     *  default and allocates nothing when on. */
    private get checkCalleeSaved(): boolean {
        return !!(globalThis as { __checkCalleeSaved?: boolean }).__checkCalleeSaved;
    }

    /** The live register file, or null when the CPU is not up yet. */
    private guestRegFile(): Int32Array | null {
        const cpu = this.v86?.cpu || (this.v86?.v86 && this.v86.v86.cpu);
        return cpu?.reg32 ?? null;
    }

    /**
     * Loud on the ONE thing the direct restore cannot fix: it writes EAX/ESP/EIP, so a
     * callee-saved register the callback did not give back stays wrong all the way to the
     * caller's next instruction that reads it.
     */
    private checkCalleeSavedAcrossCallback(slot: number, frameId: number, source: string): void {
        if (!this.checkCalleeSaved) return;
        const reg = this.guestRegFile();
        if (!reg) return;
        const order = [3, 6, 7, 5];
        const names = ["EBX", "ESI", "EDI", "EBP"];
        let diff = "";
        for (let i = 0; i < 4; i++) {
            const before = this.frameCalleeSaved[slot * 4 + i] >>> 0;
            const now = reg[order[i]!]! >>> 0;
            if (before !== now) {
                diff += ` ${names[i]}: 0x${before.toString(16)} -> 0x${now.toString(16)}`;
            }
        }
        if (diff) {
            Logger.warn(LogCategory.CALLBACK,
                `Callee-saved register(s) CLOBBERED across callback (frameId=${frameId}, ` +
                `thunk=${source}):${diff}`);
        }
    }

    private releaseFrame(slot: number): void {
        if (slot < 0 || slot >= SUSPENDED_FRAME_RING_SIZE) return;
        if (this.frameActive[slot] !== 1) return;

        for (let i = 0; i < this.frameStackDepth; i++) {
            if (this.frameStack[i] === slot) {
                for (let j = i; j < this.frameStackDepth - 1; j++) {
                    this.frameStack[j] = this.frameStack[j + 1];
                }
                this.frameStackDepth--;
                break;
            }
        }

        const pinnedThreadId = this.frameThreadId[slot];

        this.frameActive[slot] = 0;
        this.frameIdRing[slot] = 0;
        this.frameThreadId[slot] = 0;
        this.frameEspEntry[slot] = 0;
        this.frameReturnAddr[slot] = 0;
        this.frameThunkCleanup[slot] = 0;
        this.frameExpectedPostEsp[slot] = 0;
        this.frameCallbackId[slot] = 0;
        this.frameSource[slot] = '';

        // Unpin the thread that took the pin in allocateSuspendedFrame — NOT whoever is
        // current now. A pinned thread that blocks does switch away, so releasing the frame
        // from another thread would decrement the wrong counter and leave the owner pinned
        // (never preemptible) for good.
        try {
            System.getInstance().scheduler.unpinThread(pinnedThreadId);
        } catch { /* scheduler not ready yet */ }

        this.notifyIdleIfReady();
    }

    private resetSuspendedFrames(): void {
        // Unpin for each active frame before resetting
        try {
            const scheduler = System.getInstance().scheduler;
            for (let i = 0; i < SUSPENDED_FRAME_RING_SIZE; i++) {
                if (this.frameActive[i] === 1) {
                    scheduler.unpinThread(this.frameThreadId[i]);
                }
            }
        } catch { /* scheduler not ready */ }

        this.frameActive.fill(0);
        this.frameIdRing.fill(0);
        this.frameThreadId.fill(0);
        this.frameEspEntry.fill(0);
        this.frameReturnAddr.fill(0);
        this.frameThunkCleanup.fill(0);
        this.frameExpectedPostEsp.fill(0);
        this.frameCallbackId.fill(0);
        this.frameSource.fill('');
        this.frameWriteIdx = 0;
        this.nextFrameId = 1;
        this.frameStackDepth = 0;
        this.frameStack.fill(-1);
    }

    private snapshotSuspendedFrames(): SuspendedThunkFrame[] {
        const out: SuspendedThunkFrame[] = [];
        for (let i = 0; i < this.frameStackDepth; i++) {
            const slot = this.frameStack[i];
            if (slot < 0 || slot >= SUSPENDED_FRAME_RING_SIZE) continue;
            if (this.frameActive[slot] !== 1) continue;
            out.push({
                frameId: this.frameIdRing[slot] >>> 0,
                threadId: this.frameThreadId[slot] >>> 0,
                espEntry: this.frameEspEntry[slot] >>> 0,
                returnAddr: this.frameReturnAddr[slot] >>> 0,
                thunkCleanup: this.frameThunkCleanup[slot] >>> 0,
                expectedPostEsp: this.frameExpectedPostEsp[slot] >>> 0,
                callbackId: this.frameCallbackId[slot] >>> 0,
                source: this.frameSource[slot] ?? '',
            });
        }
        return out;
    }

    /**
     * Get a return stub for the specified cleanup amount.
     * Strict mode: if all stubs are in use, fail-fast instead of reusing an active stub.
     */
    private getReturnStub(cleanup: number): CallbackReturnStub | null {
        // Find closest cleanup amount
        let bestCleanup = 0;
        for (const amount of CLEANUP_AMOUNTS) {
            if (amount === cleanup) {
                bestCleanup = amount;
                break;
            }
            if (amount < cleanup) {
                bestCleanup = amount;
            }
        }

        if (bestCleanup !== cleanup) {
            Logger.warn(LogCategory.CALLBACK, `No exact return stub for cleanup ${cleanup}, using ${bestCleanup}`);
        }

        const stubs = this.stubsByCleanup.get(bestCleanup);
        if (!stubs || stubs.length === 0) {
            return null;
        }

        // First, try to find a free stub (inUse = false)
        // This prevents reuse of stubs that are still active in nested callback scenarios
        for (const stub of stubs) {
            if (!stub.inUse) {
                stub.inUse = true;  // Mark as in use
                return stub;
            }
        }

        Logger.error(
            LogCategory.CALLBACK,
            `Stub pool exhausted for cleanup ${bestCleanup} (${stubs.length} stubs all in use)`
        );
        this.reportFatalFromCallback(
            0x3005,
            bestCleanup >>> 0,
            System.getInstance().scheduler.getCurrentThreadId() >>> 0
        );
        return null;
    }

    /**
     * Save context for a thunk that will be suspended for callbacks.
     * This must be called BEFORE the first invokeCallback in the thunk!
     * 
     * @param ctx - X86Context object with current registers
     * @param stackCleanup - How many bytes to pop from stack on final return (stdcall)
     */
    saveSuspendedThunkContext(ctx: any, stackCleanup: number, source: string = 'unknown'): number {
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const esp = ctx.esp; // Use ctx.esp instead of cpu.reg32[4]

        // Validate ESP before reading return address
        if (esp < 4 || esp + 4 > mem.length) {
            Logger.error(LogCategory.CALLBACK,
                `Invalid ESP when saving thunk context: 0x${esp.toString(16)} (memory size: 0x${mem.length.toString(16)})`);
            return 0;
        }

        // Note: Use pre-saved returnAddr if available (passed from async thunk context).
        // During async operations like loadDllFromVfs, memory at [esp] may be overwritten
        // by stub generation or other memory operations. Re-reading from memory here
        // would give corrupted values.
        const returnAddr = ctx.returnAddr !== undefined ? ctx.returnAddr : view.getUint32(esp, true);

        // Validate returnAddr
        if (returnAddr < 0x1000 || returnAddr >= mem.length) {
            Logger.error(LogCategory.CALLBACK,
                `Invalid returnAddr when saving thunk context: 0x${returnAddr.toString(16)} (memory size: 0x${mem.length.toString(16)})`);
            return 0;
        }
        if (returnAddr >= this.stubPoolBase && returnAddr < this.stubPoolEnd) {
            Logger.error(LogCategory.CALLBACK,
                `Invalid returnAddr when saving thunk context: 0x${returnAddr.toString(16)} points into stub pool (0x${this.stubPoolBase.toString(16)}-0x${this.stubPoolEnd.toString(16)})`);
            return 0;
        }
        if (this.isInvalidGuestReturnAddress(returnAddr)) {
            Logger.error(LogCategory.CALLBACK,
                `Invalid returnAddr when saving thunk context: 0x${returnAddr.toString(16)} (thunk/spin region)`);
            return 0;
        }

        const threadId = System.getInstance().scheduler.getCurrentThreadId() >>> 0;
        const frameId = this.allocateSuspendedFrame(
            threadId,
            esp >>> 0,
            returnAddr >>> 0,
            stackCleanup >>> 0,
            source
        );
        if (frameId === 0) {
            return 0;
        }

        Logger.verbose(LogCategory.CALLBACK,
            `Saved suspended thunk frame ${frameId} (depth=${this.frameStackDepth}): ` +
            `T${threadId} ESP=0x${esp.toString(16)} RET=0x${returnAddr.toString(16)} cleanup=${stackCleanup}`);
        return frameId;
    }

    /**
     * Invoke an x86 callback function.
     *
     * This modifies the CPU state to execute the callback:
     * 1. Pushes callback arguments onto the stack
     * 2. Pushes return stub address
     * 3. Sets EIP to callback address
     *
     * After the callback RETs, the return stub will trap back to JS
     * and then RET to the original caller with proper stack cleanup.
     *
     * @param callbackAddress - Address of the x86 function to call
     * @param args - Arguments to pass (will be pushed right-to-left)
     * @param callerCleanup - Stack cleanup bytes for the original API (e.g., 4 for DispatchMessage)
     * @param completeThunk - Optional callback to complete suspended thunk (returns null to continue enumeration)
     * @returns Object with callbackId for thunk reference
     */
    invokeCallback(
        callbackAddress: number,
        args: number[],
        callerCleanup: number = 0,
        completeThunk?: (callbackReturnValue: number) => number | null,
        isCdecl: boolean = false,
        source: string = 'unknown',
        frameId?: number,
        options?: InvokeCallbackOptions
    ): { callbackId: number } {
        // Callback nesting depth limit - prevents exhaust of return stub pool
        if (this.frameStackDepth >= MAX_CALLBACK_NESTING) {
            Logger.error(LogCategory.CALLBACK,
                `Callback nesting depth ${this.frameStackDepth} exceeded limit ${MAX_CALLBACK_NESTING}! ` +
                `Target: 0x${callbackAddress.toString(16)}, args=[${args.map(a => '0x' + a.toString(16)).join(', ')}]`);
            return { callbackId: 0 };
        }

        if (this.isGuestStackAddress(callbackAddress)) {
            const msg = `Attempted to invoke callback at STACK address 0x${callbackAddress.toString(16)}!`;
            Logger.error(LogCategory.SYSTEM, msg);
            throw new CallbackError(msg, callbackAddress, ERROR_INVALID_PARAMETER);
        }

        if (callbackAddress === 0) {
            const error = new CallbackError('Attempted to invoke null callback', 0, ERROR_INVALID_PARAMETER);
            Logger.warn(LogCategory.CALLBACK, error.message);
            throw error;
        }

        const stub = this.getReturnStub(callerCleanup);
        if (!stub) {
            const error = new CallbackError(
                `No return stub available for cleanup ${callerCleanup}`,
                callbackAddress,
                ERROR_INSUFFICIENT_BUFFER
            );
            Logger.error(LogCategory.CALLBACK, error.message);
            throw error;
        }

        let resolvedFrameId = 0;
        let resolvedFrameIndex = -1;
        if (completeThunk) {
            resolvedFrameId = frameId !== undefined && frameId !== 0
                ? frameId >>> 0
                : this.getTopSuspendedFrameId();
            resolvedFrameIndex = resolvedFrameId !== 0 ? this.findFrameIndexById(resolvedFrameId) : -1;
            if (resolvedFrameIndex < 0) {
                const threadId = System.getInstance().scheduler.getCurrentThreadId() >>> 0;
                Logger.error(
                    LogCategory.CALLBACK,
                    `invokeCallback: suspended frame not found for completion chain ` +
                    `(requestedFrame=${resolvedFrameId}, callbackId=0x${stub.callbackId.toString(16)}, source=${source})`
                );
                stub.inUse = false;
                System.getInstance().scheduler.reportCallbackFrameFatal(stub.callbackId >>> 0, threadId);
                return { callbackId: 0 };
            }
        }

        // A suspended-frame chain dispatch may target a thread the spin-loop safety net
        // parked WAITING while the pump idled (see hasLiveFrameForThread). Wake it before
        // writing CPU state — the scheduler skips WAITING threads, so without this the
        // callback would never execute.
        if (completeThunk) {
            System.getInstance().scheduler.wakeCurrentThreadForCallbackDispatch();
        }

        const cpu = this.v86.cpu || (this.v86.v86 && this.v86.v86.cpu);
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        let esp = cpu.reg32[4];
        // If callback belongs to a suspended-thunk completion chain, always anchor setup
        // to the saved thunk entry ESP. This avoids stacking on temporary stub frames
        // (e.g. PUSH EAX in callback return stub), which corrupts callerRet.
        if (completeThunk && resolvedFrameIndex >= 0) {
            const frameEsp = this.frameEspEntry[resolvedFrameIndex] >>> 0;
            if (frameEsp > 0 && frameEsp < mem.length) {
                if (esp !== frameEsp) {
                    Logger.verbose(
                        LogCategory.CALLBACK,
                        `invokeCallback chain ESP anchor: current=0x${esp.toString(16)} -> frame=0x${frameEsp.toString(16)} ` +
                        `(frameId=${resolvedFrameId}, source=${source})`
                    );
                }
                esp = frameEsp;
            }
        }
        let espBeforeInvoke = esp; // Save ESP for stack drift detection
        const forceSyntheticReturnEip = !completeThunk && !!options?.forceSyntheticReturnEip;
        let usedSyntheticReturnEip = false;
        if (forceSyntheticReturnEip) {
            const syntheticReturnEip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
            if (syntheticReturnEip < 0x100000 || syntheticReturnEip >= mem.length) {
                Logger.error(
                    LogCategory.CALLBACK,
                    `invokeCallback: synthetic return EIP out of range 0x${syntheticReturnEip.toString(16)} ` +
                    `source=${source}`
                );
                stub.inUse = false;
                return { callbackId: 0 };
            }

            const syntheticEsp = (esp - 4) >>> 0;
            if (!MemoryGuard.checkStackWrite(mem, syntheticEsp, 4, "CallbackManager.invokeCallback.syntheticRet")) {
                Logger.error(
                    LogCategory.CALLBACK,
                    `invokeCallback: synthetic return write failed at ESP=0x${syntheticEsp.toString(16)} source=${source}`
                );
                stub.inUse = false;
                return { callbackId: 0 };
            }

            guardStackWrite(syntheticEsp, 4, 'callback:syntheticRet', syntheticReturnEip);
            view.setUint32(syntheticEsp, syntheticReturnEip, true);
            esp = syntheticEsp;
            espBeforeInvoke = syntheticEsp;
            usedSyntheticReturnEip = true;
        }
        const totalBytes = (args.length + 1) * 4;
        const newEsp = esp - totalBytes;
        if (!MemoryGuard.checkStackWrite(mem, newEsp, totalBytes, "CallbackManager.invokeCallback")) {
            const error = new CallbackError(
                'Invoke callback aborted due to stack bounds',
                callbackAddress,
                ERROR_INVALID_PARAMETER
            );
            Logger.warn(LogCategory.CALLBACK, error.message);
            throw error;
        }

        // Tripwire: the whole synthetic frame must land in the target thread's dead zone.
        // A STALE esp (e.g. the timer-thread abandonment class) lands it in a parked
        // thread's live range — exactly the corruption this guard exists to name.
        guardStackWrite(newEsp, totalBytes, 'callback:invokeFrame');
        // Push arguments right-to-left (stdcall convention)
        for (let i = args.length - 1; i >= 0; i--) {
            esp -= 4;
            view.setUint32(esp, args[i] >>> 0, true);
        }

        // Push return stub address (simulates CALL instruction)
        esp -= 4;
        view.setUint32(esp, stub.address, true);

        // Update ESP
        cpu.reg32[4] = esp;

        // Set EIP to callback
        // Note: Set is_jumping flag to prevent v86 from Auto-incrementing EIP
        if (cpu.is_jumping !== undefined) {
            cpu.is_jumping = true;
        }
        cpu.instruction_pointer[0] = callbackAddress;

        // Track this callback (optional, for debugging/promise resolution)
        const invocation: CallbackInvocation = {
            id: this.nextCallbackId++,
            callbackAddress,
            args,
            source,
            callerCleanup,
            resolve: () => { },
            reject: () => { },
            isCdecl,
            completeThunk: completeThunk,  // Store thunk completion callback
            espBeforeInvoke,  // Save ESP for stack drift detection
            ownerThreadId: System.getInstance().scheduler.getCurrentThreadId() >>> 0,
            syntheticReturnEip: usedSyntheticReturnEip,
            directThunkReturn: options?.directThunkReturn,
        };

        // Attach thunkContext from stack for callbacks that will complete a suspended thunk
        // If completeThunk is provided, this callback is part of an enumeration (e.g., EnumWindows)
        if (completeThunk) {
            this.frameCallbackId[resolvedFrameIndex] = stub.callbackId >>> 0;
            if (!this.frameSource[resolvedFrameIndex]) {
                this.frameSource[resolvedFrameIndex] = source;
            }

            invocation.frameId = resolvedFrameId >>> 0;
            invocation.thunkContext = {
                esp: this.frameEspEntry[resolvedFrameIndex] >>> 0,
                returnAddr: this.frameReturnAddr[resolvedFrameIndex] >>> 0,
                stackCleanup: this.frameThunkCleanup[resolvedFrameIndex] >>> 0
            };

            Logger.verbose(LogCategory.CALLBACK,
                `Attached suspended frame ${resolvedFrameId} to callback 0x${stub.callbackId.toString(16)} (depth=${this.frameStackDepth})`);
        } else if (this.frameStackDepth > 0 && !options?.directThunkReturn) {
            Logger.warn(LogCategory.CALLBACK,
                `Suspended frame stack has depth=${this.frameStackDepth} but callback 0x${stub.callbackId.toString(16)} has no completion handler`);
        }

        if (!this.trackPendingCallback(stub.callbackId, invocation.ownerThreadId ?? 0, invocation.frameId ?? 0, source)) {
            stub.inUse = false;
            // Telemetry: who holds the 256 slots? Histogram by source pinpoints the leaker.
            Logger.error(LogCategory.CALLBACK,
                `Pending callback slots exhausted — holders by source: ${JSON.stringify(this.getPendingSlotSummary())}`);
            this.reportFatalFromCallback(0x3005, stub.callbackId >>> 0, invocation.ownerThreadId ?? 0);
            throw new CallbackError('Pending callback slots exhausted', callbackAddress, ERROR_INSUFFICIENT_BUFFER);
        }
        this.pendingCallbacks.set(stub.callbackId, invocation);
        systemEventLog.write(
            SystemEventKind.CALLBACK_INVOKE,
            stub.callbackId >>> 0,
            invocation.ownerThreadId ?? 0,
            callbackAddress >>> 0
        );
        this.lastInvokeForensics = {
            phase: 'invoke',
            ts: performance.now(),
            callbackId: stub.callbackId >>> 0,
            callbackAddress: callbackAddress >>> 0,
            source,
            args: args.slice(0, 8),
            callerCleanup: callerCleanup >>> 0,
            stubAddress: stub.address >>> 0,
            esp: esp >>> 0,
            espBeforeInvoke: espBeforeInvoke >>> 0,
            espAfterSetup: esp >>> 0,
            stackTop: this.readStackDwords(esp, 6),
        };

        if (source === 'WinMM_timeSetEvent') {
            const now = performance.now();
            if ((now - this.lastWinMmForensicLogMs) > 250) {
                this.lastWinMmForensicLogMs = now;
                Logger.warn(LogCategory.CALLBACK,
                    `[FORENSICS] WinMM callback invoke id=0x${stub.callbackId.toString(16)} ` +
                    `cb=0x${callbackAddress.toString(16)} espBefore=0x${espBeforeInvoke.toString(16)} ` +
                    `espAfter=0x${esp.toString(16)} args=[${args.map(a => '0x' + (a >>> 0).toString(16)).join(',')}]`);
            }
        }

        Logger.verbose(LogCategory.CALLBACK, `Invoke 0x${callbackAddress.toString(16)} args=[${args.map(a => '0x' + a.toString(16)).join(', ')}] stub=0x${stub.address.toString(16)} cleanup=${callerCleanup}`);

        return { callbackId: stub.callbackId };
    }

    /**
     * Invoke a WndProc callback.
     * WndProc is stdcall - it cleans its own 16 bytes (RET 16).
     * Return stub cleanup is for the CALLER's API (DispatchMessage lpMsg = 4 bytes).
     */
    invokeWndProc(wndProc: number, hwnd: number, msg: number, wParam: number, lParam: number, callerCleanup: number = 4): void {
        this.invokeCallback(wndProc, [hwnd, msg, wParam, lParam], callerCleanup);
    }

    /**
     * Invoke a TimerProc callback.
     */
    invokeTimerProc(timerProc: number, hwnd: number, msg: number, idEvent: number, dwTime: number): void {
        this.invokeCallback(timerProc, [hwnd, msg, idEvent, dwTime], 0);
    }

    /**
     * Invoke an EnumWindowsProc callback.
     */
    invokeEnumWindowsProc(enumProc: number, hwnd: number, lParam: number): void {
        this.invokeCallback(enumProc, [hwnd, lParam], 0);
    }

    /**
     * Get count of pending callbacks (for debugging)
     */
    getPendingCount(): number {
        return this.pendingSlotCount;
    }

    /**
     * True when callback execution chain is in flight.
     * In current model this maps to pending callback return stubs that haven't trapped back yet.
     */
    hasInFlightCallbacks(): boolean {
        return this.pendingSlotCount > 0;
    }

    getInFlightOwnerThreadId(): number | null {
        if (this.pendingSlotCount === 0) return null;
        for (let i = 0; i < MAX_PENDING_CALLBACK_SLOTS; i++) {
            if (this.pendingSlotActive[i] === 0) continue;
            const owner = this.pendingSlotOwnerThreadId[i] >>> 0;
            if (owner !== 0) return owner;
        }
        return null;
    }

    hasInFlightCallbacksForThread(threadId: number): boolean {
        const target = threadId >>> 0;
        if (this.pendingSlotCount === 0) return false;
        for (let i = 0; i < MAX_PENDING_CALLBACK_SLOTS; i++) {
            if (this.pendingSlotActive[i] === 0) continue;
            if ((this.pendingSlotOwnerThreadId[i] >>> 0) === target) return true;
        }
        return false;
    }

    /**
     * Deferred callbacks may be dispatched only when there is no in-flight callback
     * and no suspended thunk context chain.
     */
    canAcceptDeferredCallback(): boolean {
        return this.pendingSlotCount === 0 && this.frameStackDepth === 0;
    }

    /**
     * Get pending callback by ID (for enumeration chain linking)
     */
    getPendingCallback(callbackId: number): CallbackInvocation | undefined {
        return this.pendingCallbacks.get(callbackId);
    }

    /**
     * Reset the callback manager - clear pending callbacks.
     */
    reset(): void {
        this.pendingCallbacks.clear();
        this.resetPendingSlots();
        this.nextCallbackId = 1;
        this.resetSuspendedFrames();
        // Re-initialize stubs in memory just in case
        this.initialize();
        Logger.log(LogCategory.CALLBACK, 'CallbackManager reset');
    }

    hasSavedThunkContext(): boolean {
        return this.frameStackDepth > 0;
    }

    /**
     * Abandon a suspended-thunk frame whose callback chain never started, so the thunk can
     * complete synchronously instead.
     *
     * saveSuspendedThunkContext PINS the calling thread (a real Win32 enumeration is
     * synchronous, so the callback chain must not be preempted). A caller that saves the
     * frame and then fails to dispatch even one callback — invokeCallback refused
     * (nesting limit, frame not found) or threw (null target, stack bounds, slot
     * exhaustion), or the enumeration bailed before its first invoke — would otherwise
     * leave the thread pinned for good AND return "suspended" to a dispatcher that then
     * waits for a callback nobody will ever issue: a silent freeze with no fault.
     * Releasing the frame here unpins the owner and drops any callbacks already bound to
     * it; the caller must then return a normal HRESULT, not `suspendedForCallback`.
     *
     * Returns true when a live frame was found and released.
     */
    abandonSuspendedFrame(frameId: number): boolean {
        const target = frameId >>> 0;
        const frameIndex = this.findFrameIndexById(target);
        if (frameIndex < 0) return false;

        const source = this.frameSource[frameIndex] || 'unknown';   // releaseFrame clears it
        for (const [cbId, cb] of this.pendingCallbacks.entries()) {
            if ((cb.frameId ?? 0) !== target) continue;
            const stub = this.stubsById.get(cbId);
            if (stub) this.releaseCallback(cbId, stub);
            else { this.pendingCallbacks.delete(cbId); this.untrackPendingCallback(cbId); }
        }
        this.releaseFrame(frameIndex);

        Logger.warn(LogCategory.CALLBACK,
            `Abandoned suspended frame ${target} (${source}): ` +
            `no callback was dispatched — thunk completes synchronously`);
        return true;
    }

    /**
     * Return the innermost live suspended thunk frame.
     *
     * A Win32 API can be entered from a guest callback whose return address is one of
     * our callback stubs (for example subclass proc -> DefWindowProc -> SendMessage).
     * Such an API must extend the callback's existing completion chain rather than try
     * to suspend the synthetic callback-stub frame as a new guest thunk.
     */
    getActiveSuspendedFrameId(): number {
        return this.getTopSuspendedFrameId();
    }

    getStubPoolRange(): { base: number; end: number } {
        return { base: this.stubPoolBase, end: this.stubPoolEnd };
    }

    getForensicState(): CallbackForensicState {
        const copy = (record: CallbackForensicRecord | null): CallbackForensicRecord | null => {
            if (!record) return null;
            return {
                ...record,
                args: record.args.slice(),
                stackTop: record.stackTop ? record.stackTop.slice() : undefined,
            };
        };

        return {
            pendingCount: this.pendingSlotCount,
            thunkContextDepth: this.frameStackDepth,
            lastInvoke: copy(this.lastInvokeForensics),
            lastReturn: copy(this.lastReturnForensics),
            suspendedFrames: this.snapshotSuspendedFrames(),
        };
    }

    private readStackDwords(esp: number, count: number): number[] {
        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
            const addr = esp + (i * 4);
            if (addr < 0 || addr + 4 > mem.length) break;
            values.push(view.getUint32(addr, true) >>> 0);
        }
        return values;
    }

    /** Return addresses that must never be used as guest code targets (thunk/spin regions). */
    private isInvalidGuestReturnAddress(addr: number): boolean {
        const a = addr >>> 0;
        if (a === 0 || a < 0x1000) return true;
        if (a >= MEM_THUNK_CODE_BASE && a < MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE) return true;
        return false;
    }

    /**
     * True when `addr` lands inside the RUNNING thread's guest stack.
     *
     * An address we are about to set EIP to came out of a stack slot; if it points back
     * into that same stack it is data the guest overwrote, not code, and jumping there
     * executes the stack. That is the signature of a skewed RET N (a stub-cleanup
     * mismatch, a stdcall/cdecl mix-up) and it must be a NAMED fatal, not a silent jump.
     *
     * The bounds come from the scheduler because thread stacks are carved out of HEAP:
     * there is no RegionKind to ask, and a fixed address window cannot answer it at all.
     * Only the current thread is checked — it owns the live frame, and a per-return scan
     * of every thread would put an allocation and a loop on a path that runs once per
     * callback. A base of 0 means the main stack was never registered: report nothing
     * rather than swallow the address space whole.
     */
    private isGuestStackAddress(addr: number): boolean {
        try {
            const scheduler = System.getInstance().scheduler;
            const bounds = scheduler.getThreadStackBounds(scheduler.getCurrentThreadId() >>> 0);
            if (!bounds || bounds.base < 0x1000) return false;
            const a = addr >>> 0;
            return a >= bounds.base && a < bounds.top;
        } catch {
            return false;   // scheduler not up yet (early boot) — nothing to compare against
        }
    }
}
