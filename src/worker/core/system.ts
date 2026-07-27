
import { Process } from "./process";
import { WindowManager } from "../runtime/windowing/window-manager";
import { GDIContext } from "../modules/gdi32/context";
import { InputManager } from "../runtime/input/input-manager";
import type { DDrawContext } from "../modules/ddraw/context";
import { Logger, LogCategory } from "./logger";
import { RuntimeServices } from "../runtime/runtime-services";
import { VirtualFileSystem } from "../runtime/filesystem/vfs";
import { RegistryStore } from "../runtime/filesystem/registry";
import { SystemResourceProvider } from "./resources/system-resource-provider";
import { ComResourceManager } from "./com/com-resource";
import { APIRegistry } from "./api-registry";
import { Scheduler } from "./scheduler";
import { GpuResourceManager } from "./gpu/gpu-resource-manager";
import { memoryWatch } from "./memory/memory-watch";
import { profiler, Profiler } from "./profiler";
import { leaseRegistry } from "./memory/lease-registry";
import { memoryEventBuffer } from "./memory/memory-event-buffer";
import { faultRecorder } from "./memory/fault-recorder";
import { loadDiagnostics } from "./diagnostics/load-diagnostics";
import { serializeCpu } from "../harness/serialize";
import { buildHarnessReport, type HarnessReport } from "../harness/build-report";
import { frameProfiler } from "./frame-profiler";
import { VideoRoutingService } from "../video/video-routing-service";
import { harnessBus } from "../harness/event-bus";
import { TimeService } from "../runtime/time";
import { videoEngine } from "../../video/video-engine";
import { libHleManager } from "./hle-lib/lib-hle-manager";
import { hookRegistry } from "./hooks";
import { resetSehDispatchState } from "./seh-dispatch";
import { namedObjects } from "../modules/kernel32/named-objects";

/**
 * The crash payload posted to the host (`process_exit{crashed:true, fault}`) and
 * emitted on the harness bus. One shape for EVERY crash class — unhandled AV,
 * bad return address (thunk stack desync), WASM trap — so the host UI and the
 * harness `waitForEvent('fault')` see a single, uniform report. Mirrors the
 * host-side `CrashFault` in App.tsx.
 */
export interface CrashFaultPayload {
    /** Human label for the crash class, e.g. "Unhandled access violation". */
    reason: string;
    eip: number;
    faultAddr: number;
    errorCode: number;
    threadId: number | null;
    lastThunk: string;
    regs: { ecx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number } | null;
    /** Alias of lastThunks — kept for older readers of process_exit.fault. */
    recentCalls: string[];
    gameEsp: number;
    stackDump: number[];
    // --- harness.report() fields (via buildHarnessReport) + crash-only extras below ---
    cpu?: HarnessReport["cpu"];
    backtrace?: HarnessReport["backtrace"];
    lastThunks?: HarnessReport["lastThunks"];
    stubs?: HarnessReport["stubs"];
    getProcMisses?: HarnessReport["getProcMisses"];
    silentStubs?: HarnessReport["silentStubs"];
    recentGetProc?: HarnessReport["recentGetProc"];
    faults?: HarnessReport["faults"];
    /** Recent C++ exceptions (decoded type/message + caught/unhandled outcome). An
     *  `unhandled` entry is the usual root of an MSVC/UE "Runtime Error! terminate". */
    cxxExceptions?: HarnessReport["cxxExceptions"];
    /** @deprecated Use faults — same data, kept for older host builds. */
    recentFaults?: Array<{ eip: number; faultAddr: number; lastThunk: string; threadId: number | null; kind: string }>;
    threads?: HarnessReport["threads"];
    /** Scheduler/async-restore state captured at fatal time. */
    schedulerDetail?: string | null;
    /** Recent async restore / scheduler events, newest last. */
    asyncRestoreTrace?: string[];
    /** Recent WinAPI calls made by the CRASHING thread (oldest..newest), each tagged
     *  with ESP + [esp]. Isolated from a busy peer thread that floods the global ring;
     *  reveals a wild/corrupt ESP directly. */
    crashThreadCalls?: string[];
    /** True for a process-fatal crash; absent for a per-thread fault the process survived. */
    fatal?: boolean;
    /** Set when the crashing thread entered a thunk with ESP outside its stack
     *  (stack/control-flow corruption tripwire). */
    wildEsp?: string | null;
    /** Set when the crashing thread entered a thunk with EBP that is neither in the thread stack,
     *  the synthetic thunk/vtable band, nor committed-writable memory (frame-pointer corruption
     *  tripwire — a mis-popped saved-EBP landing in unmapped/RO guest memory; the Re-Volt wedge). */
    wildEbp?: string | null;
    /** Set when an async-restore found v86 had executed a stub RET N that disagreed with the
     *  recorded cleanup (the wrong/double-RET-N corruption vector — names the offending thunk). */
    asyncRetMismatch?: string | null;
    /** Escape forensics (bootloader/stack escape only): RET-shape suspect slot, SEH-window
     *  cross-reference, guard-violation cross-reference. A MATCH line names the culprit. */
    escapeAnalysis?: string[];
    /** Parked-stack write-guard violations (newest last) — JS machinery caught writing a
     *  parked thread's LIVE stack range, with the JS stack at write time (plant-time
     *  tripwire for the 0x7c07 corruption class). */
    stackGuardViolations?: string[];
    /** Recent SEH catch dispatches (newest last): catch target, frame EBP, continuation
     *  ESP (+fallback flag), and the descent window each trampoline executed in. */
    sehDispatchTrace?: string[];
}

/** Guest cursor shape forwarded to the host (RGBA pixels + hotspot). */
export interface HostCursorImage {
    width: number;
    height: number;
    pixels: Uint8Array;
    hotspotX: number;
    hotspotY: number;
}

export class System {
    private static instance: System;
    public process: Process | null = null;

    // Subsystems
    public windowManager: WindowManager;
    public gdiContext: GDIContext;
    public ddrawContext: DDrawContext | null = null;
    public inputManager: InputManager;
    public services: RuntimeServices;
    public videoRouting: VideoRoutingService;
    public fileSystem: VirtualFileSystem;
    public registry: RegistryStore;
    public resourceProvider: SystemResourceProvider;
    public comResourceManager: ComResourceManager;
    public apiRegistry: APIRegistry;
    public scheduler: Scheduler;
    public profiler: Profiler = profiler;
    public isExiting: boolean = false;
    public isCleaningUp: boolean = false;  // Set when game is in cleanup mode
    public isPaused: boolean = false;  // Set when emulator is paused
    private _releaseCount: number = 0;
    private _releaseResetTimeout: any = null;
    /** Set once reportGuestCrash has fired — drops storming traps after teardown. */
    private _crashReported: boolean = false;

    // GPU Resource Manager for deferred destruction of GPU textures
    // Prevents race condition where textures are destroyed before GPU finishes reading them
    public gpuResourceManager: GpuResourceManager | null = null;

    /**
     * Called when a COM object is released. Tracks release frequency to detect cleanup mode.
     */
    trackComRelease(): void {
        this._releaseCount++;

        // If we see multiple releases in quick succession, enter cleanup mode
        // Increased threshold to 15 to avoid false positives during scene transitions (e.g. in Re-Volt)
        if (this._releaseCount >= 15) {
            if (!this.isCleaningUp) {
                Logger.log(LogCategory.SYSTEM, 'Detected cleanup mode - massive COM release');
                this.isCleaningUp = true;

                // Don't set isExiting/gracefulStop immediately here.
                // Let the app continue if it's just a scene transition.
                // We only log it for now to see if it's a real shutdown.
            }
        }

        // Telemetry: log CPU state during cleanup mode for diagnostics
        if (this.process?.v86) {
            try {
                const cpu = this.process.v86.cpu || (this.process.v86.v86 && this.process.v86.v86.cpu);
                if (cpu) {
                    const csValue = cpu.sreg?.[1];
                    const eipValue = cpu.instruction_pointer?.[0];
                    const csHex = typeof csValue === "number" ? `0x${csValue.toString(16)}` : String(csValue ?? "unknown");
                    const eipHex = typeof eipValue === "number" ? `0x${eipValue.toString(16)}` : String(eipValue ?? "unknown");

                    if (this.isCleaningUp) {
                        Logger.verbose(LogCategory.SYSTEM,
                            `Cleanup mode telemetry: release_count=${this._releaseCount}, CS=${csHex}, EIP=${eipHex}`);
                    }

                    // Safety stop: if CS becomes invalid, stop immediately to avoid v86 panic
                    if (!this.isExiting && (csValue === 0 || csValue === null || csValue === undefined)) {
                        Logger.warn(LogCategory.SYSTEM,
                            `Detected invalid CS (${csHex}) during COM release, stopping emulator`);
                        this.isCleaningUp = true;
                        this.isExiting = true;
                        this.gracefulStop();
                        return;
                    }
                }
            } catch (e) {
                // Ignore telemetry errors
            }
        }

        // Reset counter after a short delay
        if (this._releaseResetTimeout) {
            clearTimeout(this._releaseResetTimeout);
        }
        this._releaseResetTimeout = setTimeout(() => {
            this._releaseCount = 0;
        }, 100);
    }

    /**
     * Gracefully stop the emulator
     * Atomic CPU state modification to prevent race conditions during shutdown
     */
    private gracefulStop(): void {
        const proc = this.process;
        if (!proc?.v86) return;

        const cpu = proc.v86.cpu || (proc.v86.v86 && proc.v86.v86.cpu);
        const mem8 = proc.v86.mem8 || (proc.v86.v86 && proc.v86.v86.cpu.mem8);

        if (!cpu || !mem8) {
            Logger.warn(LogCategory.SYSTEM, 'Cannot gracefully stop: CPU or memory not available');
            try {
                proc.v86.stop();
            } catch (e) {
                // Ignore errors during stop
            }
            return;
        }

        try {
            // Atomic CPU state modification for safe shutdown
            // First, disable interrupts if possible to stop further async triggers
            if (cpu.flags !== undefined) {
                cpu.flags[0] &= ~0x200; // Clear IF (Interrupt Flag)
            }

            // Step 1: Ensure CS selector is valid (prevents IRET panic)
            // If it's already null, the panic is imminent, so we MUST fix it now
            const currentCS = cpu.sreg?.[1] ?? 0;
            if (currentCS === 0) {
                if (cpu.sreg) cpu.sreg[1] = 0x08;
            }

            // Step 2: Set is_jumping flag to prevent v86 from executing next instruction in old flow
            if (cpu.is_jumping !== undefined) {
                cpu.is_jumping = true;
            }

            // Step 3: Hard-wire EIP to a known safe halt location
            // We use a dedicated high-memory address for the halt loop
            const haltAddr = 0x01F80020;
            mem8[haltAddr] = 0xEB; // JMP rel8
            mem8[haltAddr + 1] = 0xFE; // -2 (jump to self)

            const csBase = (cpu.get_seg_base && cpu.get_seg_base(1)) || 0;
            cpu.instruction_pointer[0] = (csBase + haltAddr) >>> 0;

            Logger.log(LogCategory.SYSTEM, `CPU Halted: CS=0x${(cpu.sreg?.[1] ?? 0).toString(16)}, EIP=0x${cpu.instruction_pointer[0].toString(16)}`);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `Error during CPU halt: ${e}`);
        }

        // Force stop v86 loop
        try {
            proc.v86.stop();
        } catch (e) {
            // Ignore stop errors
        }
    }
    public executableName: string = "app.exe";  // Name of the main executable (from manifest)
    public executablePath: string = "C:\\app.exe";  // Full VFS path to the executable
    public executableArgs: string = "";  // Command-line arguments from manifest

    /**
     * Implicit TLS entries from PE modules using __declspec(thread).
     * Each entry records the TLS index and template data location so that
     * new threads (CreateThread) can initialize their own TLS data copies.
     */
    public implicitTlsEntries: Array<{
        tlsIndex: number;
        templateStart: number;  // guest VA of template data
        templateSize: number;
        zeroFillSize: number;
        moduleName: string;
    }> = [];
    private hostResize: ((width: number, height: number) => void) | null = null;
    private hostCursorVisibility: ((visible: boolean) => void) | null = null;
    private hostCursorVisibleState: boolean | null = null;
    private hostCursorImage: ((image: HostCursorImage | null) => void) | null = null;
    private hostCursorWarpMode: ((active: boolean) => void) | null = null;
    private hostCursorWarpModeState = false;
    private hostMouseCapture: ((capture: boolean) => void) | null = null;
    private hostMouseCaptureState: boolean | null = null;
    private hostWindowTitle: ((title: string) => void) | null = null;

    private constructor() {
        this.windowManager = new WindowManager();
        this.gdiContext = new GDIContext();
        this.inputManager = new InputManager(this.windowManager);
        this.services = new RuntimeServices();
        this.videoRouting = new VideoRoutingService(this.services.render);
        this.fileSystem = new VirtualFileSystem();
        this.registry = new RegistryStore();
        this.resourceProvider = SystemResourceProvider.getInstance();
        this.comResourceManager = new ComResourceManager();
        this.apiRegistry = APIRegistry.getInstance();
        this.scheduler = new Scheduler({ enabled: true });
    }

    static getInstance(): System {
        if (!System.instance) {
            System.instance = new System();
            (globalThis as any).System = System;
            (globalThis as any).instance = System.instance; // For debugging
        }
        return System.instance;
    }

    initialize(process: Process): void {
        this.process = process;
        this.scheduler.initialize(process);
        this.videoRouting.reset();

        // Wire scheduler ↔ dispatcher callbacks (one-way: scheduler invokes dispatcher)
        const dispatcher = process.dispatcher;
        this.scheduler.onThreadSwitchCallback = (oldId, newId) => {
            dispatcher.onThreadSwitch(oldId, newId);
        };
        this.scheduler.onPollAsyncRestores = (cpu, source) => {
            return dispatcher.tryApplyPendingAsyncRestoreAtSafePoint(cpu, source);
        };
        this.scheduler.onHasPendingAsyncRestores = () => {
            return dispatcher.hasPendingAsyncRestores();
        };
        this.scheduler.onThreadOwnsSuspendedFrame = (threadId) => {
            return dispatcher.threadOwnsSuspendedFrame(threadId);
        };
        this.scheduler.onUnhandledGuestFault = (threadId, eip) => {
            // Faithful: an unhandled exception on the main thread terminates the
            // PROCESS (not an infinite one-thread spin that freezes the whole
            // emulator). The fault handler already populated faultRecorder;
            // reportGuestCrash merges it in.
            const status = faultRecorder.last()?.errorCode ?? 0;
            const reason = status === 0xC000001D
                ? "Unhandled illegal instruction"
                : status === 0xC0000005
                    ? "Unhandled general protection fault"
                    : "Unhandled access violation";
            this.reportGuestCrash({ reason, eip, threadId });
        };

        Logger.log(LogCategory.SYSTEM, 'System initialized');
    }

    /**
     * Build a harness-grade diagnostic snapshot while guest state is still live.
     * Used by both crash teardown and clean ExitProcess.
     */
    buildProcessExitReport(exitCode: number): CrashFaultPayload {
        const cpu = serializeCpu() as CrashFaultPayload["cpu"];
        const esp = (cpu?.regs?.esp ?? 0) >>> 0;
        const eip = (cpu?.eip ?? 0) >>> 0;
        let threadId: number | null = null;
        try {
            threadId = (this.scheduler as { getCurrentThreadId?: () => number })?.getCurrentThreadId?.() ?? null;
        } catch { /* */ }

        const fault: CrashFaultPayload = {
            reason: `ExitProcess(code=${exitCode >>> 0})`,
            eip,
            faultAddr: 0,
            errorCode: exitCode >>> 0,
            threadId,
            lastThunk: "",
            regs: null,
            recentCalls: [],
            gameEsp: esp,
            stackDump: [],
        };
        this.enrichFaultReport(fault);
        return fault;
    }

    /**
     * THE single crash funnel. Every fatal guest-side crash class — unhandled AV
     * (#PF), bad return address (thunk stack desync), WASM hard trap (OOB) —
     * routes here so there is exactly ONE place that: builds the uniform fault
     * report (merging the live faultRecorder breadcrumbs under the caller's
     * explicit fields), tears the process down cleanly (flush VFS, terminate all
     * threads, stop v86), tells the host to show the crash dialog with a
     * copyable report, and folds the same payload onto the harness bus so
     * `waitForEvent('fault')` resolves for ALL crash classes.
     *
     * Idempotent: the first caller wins; storming traps after teardown are dropped.
     */
    reportGuestCrash(opts: {
        reason: string;
        eip: number;
        threadId?: number | null;
        /** Explicit fields override the faultRecorder breadcrumbs (used when there
         *  was no #PF, e.g. a bad return address or a WASM trap). */
        fault?: Partial<CrashFaultPayload>;
    }): void {
        if (this._crashReported) return;
        this._crashReported = true;

        const rec = faultRecorder.last();
        const ov = opts.fault ?? {};
        const fault: CrashFaultPayload = {
            reason: opts.reason,
            eip: (opts.eip >>> 0),
            faultAddr: (ov.faultAddr ?? rec?.faultAddr ?? 0) >>> 0,
            errorCode: (ov.errorCode ?? rec?.errorCode ?? 0) >>> 0,
            threadId: opts.threadId ?? rec?.threadId ?? null,
            lastThunk: ov.lastThunk ?? rec?.lastThunk ?? "",
            regs: ov.regs ?? rec?.regs ?? null,
            recentCalls: ov.recentCalls ?? rec?.recentCalls ?? [],
            gameEsp: (ov.gameEsp ?? rec?.gameEsp ?? 0) >>> 0,
            stackDump: ov.stackDump ?? rec?.stackDump ?? [],
            escapeAnalysis: ov.escapeAnalysis,
        };

        this.enrichFaultReport(fault);

        // Outlives the teardown below so harness.report() can still name the cause
        // even when the crash predates any guest execution (e.g. PE link failure).
        loadDiagnostics.noteFailure({
            reason: fault.reason,
            eip: fault.eip,
            faultAddr: fault.faultAddr,
            threadId: fault.threadId,
            lastThunk: fault.lastThunk,
        });

        Logger.error(LogCategory.SYSTEM,
            `Process crash: ${fault.reason} — EIP=0x${fault.eip.toString(16)} ` +
            `addr=0x${fault.faultAddr.toString(16)} thread=T${fault.threadId ?? "?"} ` +
            `lastThunk=${fault.lastThunk || "unknown"}`);

        this.isExiting = true;
        this.fileSystem.flushAll().catch(() => { /* best-effort */ });
        this.scheduler.terminateAllThreads(0xC0000005); // STATUS_ACCESS_VIOLATION
        try { this.process?.v86?.stop?.(); } catch { /* best-effort */ }

        // Host UI: full fault record → "The game crashed" dialog + copyable report.
        try {
            (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
                type: "process_exit",
                exitCode: 0xC0000005,
                crashed: true,
                fault,
            });
        } catch { /* not in a worker context (tests) */ }

        // Harness: one event for every crash class, not just #PF AVs. `fatal`
        // separates this from reportGuestThreadFault, whose process keeps running —
        // only the fatal one may abort a script's waits.
        try { harnessBus.emit('fault', { ...fault, fatal: true }); } catch { /* */ }
    }

    /**
     * Non-fatal sibling of reportGuestCrash: an unhandled #GP/#UD on a WORKER
     * thread terminated that thread but the process keeps running. Emits the same
     * fault-grade payload on the harness bus (so `waitForEvent('fault')` and
     * `faults()` see it) WITHOUT tearing the process down or notifying the host.
     */
    reportGuestThreadFault(opts: {
        reason: string;
        eip: number;
        threadId: number | null;
        exceptionCode: number;
    }): void {
        const rec = faultRecorder.last();
        const fault: CrashFaultPayload = {
            reason: opts.reason,
            eip: opts.eip >>> 0,
            faultAddr: (rec?.faultAddr ?? 0) >>> 0,
            errorCode: opts.exceptionCode >>> 0,
            threadId: opts.threadId ?? rec?.threadId ?? null,
            lastThunk: rec?.lastThunk ?? "",
            regs: rec?.regs ?? null,
            recentCalls: rec?.recentCalls ?? [],
            gameEsp: (rec?.gameEsp ?? 0) >>> 0,
            stackDump: rec?.stackDump ?? [],
        };
        this.enrichFaultReport(fault);

        Logger.error(LogCategory.SYSTEM,
            `Thread fault (survivable): ${fault.reason} — EIP=0x${fault.eip.toString(16)} ` +
            `status=0x${fault.errorCode.toString(16)} thread=T${fault.threadId ?? "?"} ` +
            `lastThunk=${fault.lastThunk || "unknown"}`);

        try { harnessBus.emit('fault', fault); } catch { /* */ }
    }

    /** Harness-grade enrichment while guest state is still live. */
    private enrichFaultReport(fault: CrashFaultPayload): void {
        try {
            const report = buildHarnessReport(fault.gameEsp || undefined);

            if (report.cpu) {
                fault.cpu = report.cpu;
                if (!fault.regs && report.cpu.regs) {
                    const r = report.cpu.regs as { ecx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number };
                    fault.regs = { ecx: r.ecx, ebx: r.ebx, esp: r.esp, ebp: r.ebp, esi: r.esi, edi: r.edi };
                }
            }
            fault.backtrace = report.backtrace;
            fault.lastThunks = report.lastThunks;
            fault.recentCalls = report.lastThunks;
            if (!fault.lastThunk && report.lastThunk) fault.lastThunk = report.lastThunk;
            fault.stubs = report.stubs;
            fault.getProcMisses = report.getProcMisses;
            fault.silentStubs = report.silentStubs;
            fault.recentGetProc = report.recentGetProc;
            fault.faults = report.faults;
            fault.cxxExceptions = report.cxxExceptions;
            fault.threads = report.threads;
            fault.stackGuardViolations = report.stackGuardViolations;
            fault.sehDispatchTrace = report.sehDispatchTrace;

            const dispatcher = this.process?.dispatcher as {
                getLastWinApiCallsForThread?: (threadId: number, count?: number) => string[];
                getLastWildEspNote?: () => string | null;
                getLastWildEbpNote?: () => string | null;
                getLastAsyncRetMismatchNote?: () => string | null;
            } | undefined;

            const sched = this.scheduler as {
                getDetailedThreadInfo?: () => string;
                getAsyncRestoreTrace?: () => string[];
            } | undefined;
            fault.schedulerDetail = sched?.getDetailedThreadInfo?.() ?? null;
            fault.asyncRestoreTrace = sched?.getAsyncRestoreTrace?.().slice(-32) ?? [];

            if (fault.threadId != null && dispatcher?.getLastWinApiCallsForThread) {
                fault.crashThreadCalls = dispatcher.getLastWinApiCallsForThread(fault.threadId, 24);
            }
            fault.wildEsp = dispatcher?.getLastWildEspNote?.() ?? null;
            fault.wildEbp = dispatcher?.getLastWildEbpNote?.() ?? null;
            fault.asyncRetMismatch = dispatcher?.getLastAsyncRetMismatchNote?.() ?? null;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `enrichFaultReport failed (${e instanceof Error ? e.message : String(e)})`);
        }
    }

    setHostResizeCallback(callback: (width: number, height: number) => void): void {
        this.hostResize = callback;
    }

    requestHostResize(width: number, height: number): void {
        if (this.hostResize) {
            this.hostResize(width, height);
        }
    }

    setHostCursorVisibilityCallback(callback: (visible: boolean) => void): void {
        this.hostCursorVisibility = callback;
    }

    setHostWindowTitleCallback(callback: (title: string) => void): void {
        this.hostWindowTitle = callback;
    }

    /** Single choke point for every top-level title change (CreateWindow, WM_SETTEXT,
     *  SetWindowText). Logged because a whole class of engines reports fatal asserts
     *  by rewriting the frame title, and that is otherwise invisible to `watchLog`. */
    notifyWindowTitle(title: string, source = "?"): void {
        Logger.log(LogCategory.USER32, `[WINDOW-TITLE] via=${source} ${JSON.stringify(title)}`);
        if (this.hostWindowTitle) this.hostWindowTitle(title);
    }

    requestHostCursorVisible(visible: boolean): void {
        if (this.hostCursorVisibleState === visible) return;
        this.hostCursorVisibleState = visible;
        if (this.hostCursorVisibility) {
            this.hostCursorVisibility(visible);
        }
    }

    setHostCursorImageCallback(callback: (image: HostCursorImage | null) => void): void {
        this.hostCursorImage = callback;
    }

    setHostCursorWarpModeCallback(callback: (active: boolean) => void): void {
        this.hostCursorWarpMode = callback;
    }

    /** Cursor-warp capture (user32 warp-burst detection) → host pointer-lock intent. */
    requestHostCursorWarpMode(active: boolean): void {
        if (this.hostCursorWarpModeState === active) return;
        this.hostCursorWarpModeState = active;
        if (this.hostCursorWarpMode) {
            this.hostCursorWarpMode(active);
        }
    }

    /**
     * Forward the installed cursor's image to the host so it renders the guest's
     * pointer shape (real Windows: the system draws whatever SetCursor installed).
     * Dedup lives with the cursor-state owner (user32 shared-state) — this is
     * pure transport. null = no shape installed.
     */
    requestHostCursorImage(image: HostCursorImage | null): void {
        if (this.hostCursorImage) {
            this.hostCursorImage(image);
        }
    }

    setHostMouseCaptureCallback(callback: (capture: boolean) => void): void {
        this.hostMouseCapture = callback;
    }

    /** Game switch: the host must release every input producer it owns. */
    setHostInputResetCallback(callback: () => void): void {
        this.inputManager.setHostInputResetCallback(callback);
    }

    /**
     * Assert/release relative-mouse capture independently of ShowCursor/ClipCursor.
     * Driven by DirectInput exclusive-mode mouse Acquire/Unacquire — on real Windows an
     * exclusive-mode mouse acquisition implicitly hides and confines the cursor without the
     * app touching ShowCursor, so this is a first-class pointer-lock trigger for the host.
     */
    requestHostMouseCapture(capture: boolean): void {
        if (this.hostMouseCaptureState === capture) return;
        this.hostMouseCaptureState = capture;
        if (this.hostMouseCapture) {
            this.hostMouseCapture(capture);
        }
    }

    /**
     * Connect input buffer and start polling
     */
    connectInput(buffer: SharedArrayBuffer): void {
        this.inputManager.setInputBuffer(buffer);
        this.inputManager.startPolling(8); // ~120 FPS polling

        // When guest is about to wait in GetMessage, poll with forceEnqueue so pending input is flushed into queue.
        // We do NOT gate enqueue on hasWaiters(): apps using PeekMessage (e.g. game loops) never have a waiter.
        this.windowManager.setInputPollCallback(() => {
            this.inputManager.poll(true);
        });
        Logger.log(LogCategory.SYSTEM, 'Input poll callback connected to message queue');
    }

    /**
     * Reset all system state - clear all subsystems
     */
    async reset(): Promise<void> {
        Logger.log(LogCategory.SYSTEM, 'Resetting system state');

        // Save registry state and flush access log before reset
        const gameId = this.registry.serialize().gameId;
        if (gameId) {
            try {
                const state = this.registry.serialize();
                await Promise.all([
                    import('../runtime/filesystem/registry-persistence').then(({ RegistryPersistence }) =>
                        RegistryPersistence.save(gameId, state)
                    ),
                    this.registry.flushAccessLog(),
                ]);
                Logger.log(LogCategory.SYSTEM, `Saved registry state for game "${gameId}" before reset`);
            } catch (error) {
                Logger.error(LogCategory.SYSTEM, `Failed to save registry on reset: ${error}`);
            }
        }

        // Per-game singletons that must not leak into the next load.
        this.registry.reset();
        this.fileSystem.reset();
        TimeService.getInstance().resetForGameSwitch();
        videoEngine.closeAll();
        libHleManager.resetOnGameSwitch();
        hookRegistry.reset();
        this.gpuResourceManager?.flushPendingDestruction();

        // Stop and restart v86 if running to fully reset CPU/MMU/JIT state
        if (this.process?.v86) {
            try {
                // We use restart() to fully reset the emulator internal state
                // This is much more reliable than manual register patching
                this.process.v86.restart();
                const cpu = (this.process.v86 as any)?.cpu || (this.process.v86 as any)?.v86?.cpu;
                try {
                    (globalThis as any).__applyDbgConfig?.(cpu?.wm?.exports);
                } catch (e) {
                    Logger.warn(LogCategory.SYSTEM, `Failed to re-apply guest debugger config after v86 restart: ${e}`);
                }
                // Ensure it's stopped so we can patch memory/registers safely
                this.process.v86.stop();
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `Failed to restart v86: ${e}`);
            }
        }

        // Reset all modules if they have a reset method
        if (this.process) {
            for (const module of this.process.modules.values()) {
                if (module && typeof module.reset === 'function') {
                    try {
                        module.reset();
                    } catch (e) {
                        Logger.warn(LogCategory.SYSTEM, `Failed to reset module ${module.name}: ${e}`);
                    }
                }
            }
        }

        this.isExiting = false;
        this.isPaused = false;
        this.isCleaningUp = false;
        this._releaseCount = 0;
        this._crashReported = false; // fresh game → allow a new crash report
        loadDiagnostics.reset();

        // Reset all subsystems
        this.windowManager.reset();
        this.gdiContext.reset();
        this.inputManager.reset();
        this.services.reset();
        this.videoRouting.reset();
        this.comResourceManager.reset();
        this.scheduler.reset();
        memoryWatch.reset();
        // Clear per-game singletons that otherwise bleed state across a game switch.
        leaseRegistry.reset();       // surfaces gone after Process.reset → leases are stale
        memoryEventBuffer.reset();   // diagnostics ring — no cross-game bleed
        resetSehDispatchState();     // stale in-flight exceptions / active-catch records (keyed by TEB) must not leak into the fresh run
        namedObjects.reset();        // named mutex/event/semaphore refcounts — a fresh run must not resolve the previous game's names
        profiler.reset();            // perf counters scoped per game
        frameProfiler.reset();

        // Reset process if exists
        if (this.process) {
            await this.process.reset();
        }

        // Recreate vtables after memory reset (memory at 0x03000000+ gets zeroed)
        // Modules that use vtables need to recreate them after process.reset()
        if (this.process) {
            for (const module of this.process.modules.values()) {
                if (module?.recreateVTables) {
                    try {
                        module.recreateVTables();
                    } catch (e) {
                        Logger.warn(LogCategory.SYSTEM, `Failed to recreate vtables for module ${module.name}: ${e}`);
                    }
                }

                // Re-register data exports (cleared by thunkGenerator.reset())
                if (module?.reregisterExports && this.process) {
                    try {
                        module.reregisterExports(this.process);
                    } catch (e) {
                        Logger.warn(LogCategory.SYSTEM, `Failed to re-register exports for module ${module.name}: ${e}`);
                    }
                }

                // Re-register module exports in dispatcher (since dispatcher was reset)
                if (module && module.exports) {
                    this.process.dispatcher.registerModule(module.name, module.exports);
                }
            }
        }

        Logger.log(LogCategory.SYSTEM, 'System reset complete');
    }

    /**
     * Initialize GPU Resource Manager for deferred destruction of GPU textures.
     * This prevents race conditions where textures are destroyed before GPU finishes executing commands.
     */
    initializeGpuResourceManager(): void {
        this.gpuResourceManager = new GpuResourceManager();
        Logger.log(LogCategory.SYSTEM, 'GPU Resource Manager initialized');
    }
}
