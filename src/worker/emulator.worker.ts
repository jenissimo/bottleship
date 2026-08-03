import { V86 } from "v86";
import { ThunkGenerator } from "./core/thunking/thunk-generator";
import { Process } from "./core/process";
import { System } from "./core/system";

// Which guest thread is driving a given VFS read — the shared-cursor question can only
// be answered where every file API converges, not at one API's fast path.
(globalThis as unknown as { __curTid?: () => number }).__curTid = () => {
    try { return System.getInstance().scheduler.getCurrentThread()?.id ?? -1; } catch { return -1; }
};
import { APIRegistry } from "./core/api-registry";
import { memoryWatch } from "./core/memory/memory-watch";
import { Kernel32 } from "./modules/kernel32";
import { User32 } from "./modules/user32";
import { GDI32 } from "./modules/gdi32";
import { D3D9 } from "./modules/d3d9";
import { Advapi32 } from "./modules/advapi32";
import { Ntdll } from "./modules/ntdll";
import { DSound } from "./modules/dsound";
import { WinMM } from "./modules/winmm";
import { Ole32 } from "./modules/ole32";
import { Oleaut32 } from "./modules/oleaut32";
import { DDraw } from "./modules/ddraw";
import { getOverlayCompositePlan } from "./modules/user32/dialog-overlay";
import { DInput } from "./modules/dinput";
import { DPlayX } from "./modules/dplayx";
import { MSS32 } from "./modules/mss32";
import { SmackW32 } from "./modules/smackw32";
import { BinkW32 } from "./modules/binkw32";
import { Glide2x } from "./modules/glide2x";
import { OpenGL32 } from "./modules/opengl32";
import { Glu32 } from "./modules/glu32";
import { Wsock32 } from "./modules/wsock32";
import { Shell32 } from "./modules/shell32";
import { Shlwapi } from "./modules/shlwapi";
import { Comdlg32 } from "./modules/comdlg32";
import { Comctl32 } from "./modules/comctl32";
import { Version } from "./modules/version";
import { W32skrnl } from "./modules/w32skrnl";
import { Msvcrt } from "./modules/msvcrt";
import { Msvcp90 } from "./modules/msvcp90";
import { Msvcp60 } from "./modules/msvcp60";
import { Crtdll } from "./modules/crtdll";
import { Winspool } from "./modules/winspool";
import { Dwmapi } from "./modules/dwmapi";
import { Riched32 } from "./modules/riched32";
import { Wtsapi32 } from "./modules/wtsapi32";
import { Imm32 } from "./modules/imm32";
import { Msimg32 } from "./modules/msimg32";
import { Uxtheme } from "./modules/uxtheme";
import { Wintrust } from "./modules/wintrust";
import { Crypt32 } from "./modules/crypt32";
import { Ws2_32 } from "./modules/ws2_32";
import { Psapi } from "./modules/psapi";
import { Iphlpapi } from "./modules/iphlpapi";
import { Tapi32 } from "./modules/tapi32";
import { Setupapi } from "./modules/setupapi";
import { Netapi32 } from "./modules/netapi32";
import { ImageHlp } from "./modules/imagehlp";
import { DbgHelp } from "./modules/dbghelp";
import { Wininet } from "./modules/wininet";
import { IFC20 } from "./modules/ifc20";
import { GdiPlus } from "./modules/gdiplus";
import { Bass } from "./modules/bass";
import { D3D8 } from "./modules/d3d8";
import { D3dx9 } from "./modules/d3dx9";
import { OpenAL, ALUT } from "./modules/openal/openal";
import { Quartz } from "./modules/quartz";
import { A3d } from "./modules/a3d";
import { Avifil32 } from "./modules/avifil32";
import { Rpcrt4 } from "./modules/rpcrt4";
import { Msvfw32 } from "./modules/msvfw32";
import { createBootloader, createGDT } from "./core/bootloader";
import { extractAppIcon } from "./modules/kernel32/icon-extractor";
import {
  EMU_MEMORY_SIZE,
  EMU_VGA_MEMORY_SIZE,
  EMU_SCHEDULER_INTERVAL_MS,
  EMU_HEARTBEAT_INTERVAL_MS,
  EMU_AUDIO_SAMPLE_UPDATE_INTERVAL_MS,
  EMU_NATIVE_VIDEO_DLLS
} from "./core/cpu/emulator-config";
import { WgbLoader, buildRomIndex, readEntrypointBytes, type WgbManifest, type WgbWriteFileSpec } from "./runtime/filesystem/wgb-loader";
import { WgbCache } from "./runtime/filesystem/wgb-cache";
import { detectFormat, sniffBlobHead } from "@bottleship/repack/detect";
import { installerBytesToWgb } from "@bottleship/repack/installer-to-wgb";
import { guessCacheKey } from "@bottleship/repack/manifest-synth";
import { BufferSource, InnoFormatError, parseInnoHeader, MultiSliceReader, parseSliceFile, type SliceData } from "@bottleship/formats/inno";
import { SyncHttpRangeSource } from "@bottleship/formats/zip";
import { SabIoSource } from "./runtime/filesystem/sab-io-source";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { RegistryPersistence } from "./runtime/filesystem/registry-persistence";
import { resolveGameId, gameIdToContainerDir } from "@bottleship/formats/wgb/container-id";
import { aotCache } from "./core/cpu/aot-cache";
import { PathPolicy } from "./runtime/filesystem/path-policy";
import { detectUe1, detectUe2PcPackages, pinUeEngineIni, UE1_RENDER_DEVICE as UE1_RENDER_DEVICE_NAME } from "./runtime/filesystem/ue1-firstrun";
import { buildStagedBundle, inspectBundle, finalizeBundle, readStagedEntry, type BuildSource, type FinalizeDestination } from "./runtime/filesystem/wgb-build";
import { TimeService } from "./runtime/time";
import { resolveMessageBox } from "./runtime/dialog-bridge";
import { Logger, LogLevel, LogCategory } from "./core/logger";
import { createStreamingWasmLoader } from "./core/wasm-loader";
import { WebGPUBackend } from "./backends/webgpu/webgpu-backend";
import { profiler } from "./core/profiler";
import { frameProfiler } from "./core/frame-profiler";
import { frameVarianceDiagnostics } from "./core/frame-variance-diagnostics";
import { framePacer } from "./core/frame-pacer";
import { EmulatorConfig } from "./core/emulator-config-manager";
import { videoEngine } from "../video/video-engine";
import { preemptionManager } from "./core/cpu/preemption-manager";
import { writeGuestCode } from "./core/memory/guest-code";
import { statsOverlay } from "./core/stats-overlay";
import { hypercallDataManager } from "./core/cpu/hypercall-data";
import { d3d9WasmArena } from "./backends/webgpu/d3d9/d3d9-wasm-arena";
import { bootMark, dumpBootTimeline } from "./core/boot-timer";
import { setBootOverlayActive } from "./runtime/boot-status";
import { ThreadState } from "./core/scheduler/types";
import { libHleManager } from "./core/hle-lib/lib-hle-manager";
import { hookRegistry } from "./core/hooks";
import { Galaxy } from "./modules/galaxy";
import { registerFastPathMessageFunctions } from "./modules/user32/message";
import { registerFastPathFileIOFunctions } from "./modules/kernel32/file-io";
import { registerFastPathLocaleFunctions } from "./modules/kernel32/locale";
import { registerFastPathHeapFunctions, allocateHeapSlab, resetHeapSlab } from "./modules/kernel32/memory";
import { registerFastPathMsvcrtFunctions } from "./modules/msvcrt";
import { registerFastPathPointerFunctions } from "./modules/kernel32/exception";
import { registerFastPathProcessFunctions } from "./modules/kernel32/process/process";
import { prePopulateGetProcAddressCache, registerFastPathModuleFunctions, ensureGetProcAddressDynamicExports } from "./modules/kernel32/module/module";
import { KERNEL32_VISTA_WARMUP_EXPORTS } from "./api/kernel32-vista-supplement";
// Load diagnostics commands (exposes frameDiagnostics to console)
import "./core/diagnostics-commands";
import { handleDbgCommand } from "./core/debug/dbg-commands";
import { debugSession } from "./core/debug/debug-session";
import { harnessService } from "./harness/service";
import { HARNESS_RPC, HARNESS_CANCEL } from "./harness/rpc";
import "./harness/commands"; // side-effect: register all harness commands
// onmessage handler families (static imports — worker bundled with inlineDynamicImports).
import { handleAudioBridgeMessage } from "./worker-handlers/audio-bridge";
import { handleLoggingMessage } from "./worker-handlers/logging";
import { handleDebugMonitorMessage } from "./worker-handlers/debug-monitor";
import { handleRegistryMessage } from "./worker-handlers/registry";

bootMark("worker-script-start");

// Catch unhandled promise rejections in worker (captures truncated browser errors with full message)
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const msg = reason?.message ?? reason?.toString?.() ?? String(reason ?? '(empty)');
    const stack = reason?.stack ?? '';
    Logger.error(LogCategory.SYSTEM,
        `[WORKER] Unhandled rejection: ${msg}${stack ? '\n' + stack : ''}`);
    event.preventDefault();
});

// Capture v86 WASM hard traps (e.g. "RuntimeError: memory access out of bounds" from
// main_loop) with the guest CPU state at fault time. A WASM trap bypasses our #PF/SEH
// path entirely, and v86 re-schedules do_tick so the trap storms (the JS thread wedges →
// black screen). We snapshot EIP + bytes + last thunks once, post it to the host, and
// stop v86 to break the storm so the state stays inspectable.
let __wasmTrapReported = false;
self.addEventListener('error', (event: ErrorEvent) => {
    const msg = event?.message ?? String(event?.error ?? '');
    if (__wasmTrapReported || !/out of bounds|RuntimeError|unreachable/i.test(msg)) return;
    __wasmTrapReported = true;
    try {
        const sys = System.getInstance();
        const v86: any = sys.process?.v86;
        const cpu = v86?.cpu || v86?.v86?.cpu;
        const mem8 = v86?.mem8 || cpu?.mem8;
        const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
        const esp = (cpu?.reg32?.[4] ?? 0) >>> 0;
        let bytes = '';
        if (mem8 && eip + 24 <= mem8.length) bytes = Array.from(mem8.slice(eip, eip + 24)).map((b: any) => b.toString(16).padStart(2, '0')).join(' ');
        const recent = (sys.process?.dispatcher as any)?.getLastWinApiCalls?.(10) ?? [];
        // Stack words around ESP — a wild EIP usually came from a RET popping a garbage
        // return address; the offending value is typically at [ESP-4] (just-popped) or [ESP].
        const stack: string[] = [];
        if (mem8 && cpu?.reg32 && esp >= 16 && esp + 32 <= mem8.length) {
            const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
            for (let i = -2; i < 6; i++) stack.push(`[ESP${i < 0 ? i * 4 : '+' + i * 4}]=0x${(view.getUint32(esp + i * 4, true) >>> 0).toString(16)}`);
        }
        const regs = cpu?.reg32 ? `eax=0x${(cpu.reg32[0] >>> 0).toString(16)} ecx=0x${(cpu.reg32[1] >>> 0).toString(16)} edx=0x${(cpu.reg32[2] >>> 0).toString(16)} ebx=0x${(cpu.reg32[3] >>> 0).toString(16)} ebp=0x${(cpu.reg32[5] >>> 0).toString(16)} esi=0x${(cpu.reg32[6] >>> 0).toString(16)} edi=0x${(cpu.reg32[7] >>> 0).toString(16)}` : '';
        // Per-thread saved context EIPs — reveals if an async-wake restored a corrupt EIP.
        const sched: any = sys.scheduler;
        const threads: string[] = [];
        try { for (const [id, t] of (sched?.threads ?? new Map())) threads.push(`T${id}:state=${t.state},ctxEip=0x${((t.context?.eip ?? 0) >>> 0).toString(16)},ctxEsp=0x${((t.context?.esp ?? 0) >>> 0).toString(16)}`); } catch { /* */ }
        const curTid = sched?.currentThreadId ?? sched?.getCurrentThreadId?.();
        const info = `[WASM-TRAP] ${msg} | EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)} curThread=${curTid} | ${regs} | stack=[${stack.join(' ')}] | threads=[${threads.join(' | ')}] | last10thunks=${JSON.stringify(recent)}`;
        Logger.error(LogCategory.SYSTEM, info);
        // Keep the rich wasm_trap message for back-compat (harness/console diagnostics).
        try { (self as unknown as Worker).postMessage({ type: 'wasm_trap', message: info, eip, esp, bytes, recent, stack, regs, threads, curTid }); } catch { /* */ }
        // Route through the single crash funnel so the host shows the crash dialog
        // (with a copyable report) AND the harness 'fault' event fires — same as every
        // other crash class. Build structured regs/stackDump for the report.
        const regsObj = cpu?.reg32 ? {
            ecx: cpu.reg32[1] >>> 0, ebx: cpu.reg32[3] >>> 0, esp: cpu.reg32[4] >>> 0,
            ebp: cpu.reg32[5] >>> 0, esi: cpu.reg32[6] >>> 0, edi: cpu.reg32[7] >>> 0,
        } : null;
        const stackDump: number[] = [];
        if (mem8 && esp >= 0 && esp + 128 <= mem8.length) {
            const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
            for (let i = 0; i < 32; i++) stackDump.push(view.getUint32(esp + i * 4, true) >>> 0);
        }
        try {
            System.getInstance().reportGuestCrash({
                reason: `WASM trap: ${msg}`,
                eip,
                threadId: typeof curTid === 'number' ? curTid : null,
                fault: { regs: regsObj, recentCalls: recent.map((r: any) => typeof r === 'string' ? r : JSON.stringify(r)), gameEsp: esp, stackDump, lastThunk: recent.length ? String(recent[recent.length - 1]) : '' },
            });
        } catch { /* reportGuestCrash also stops v86; fall through to the guard below */ }
        try { v86?.stop?.(); } catch { /* */ }
    } catch (e) { try { (self as unknown as Worker).postMessage({ type: 'wasm_trap', message: msg + ' (state read failed: ' + (e as Error)?.message + ')' }); } catch { /* */ } }
});

// Expose profiler to console for debugging
// Usage: profiler.getGetPixelStats() - shows which HDCs are being queried pixel-by-pixel
(globalThis as any).profiler = profiler;

// Expose hypercall managers for debugging
// Usage: hypercall.getCallCount(), hypercall.isEnabled(), preemption.isMultiThread()
(globalThis as any).hypercall = hypercallDataManager;
(globalThis as any).preemption = preemptionManager;
(globalThis as any).emuConfig = EmulatorConfig.getInstance();

// Define the state interface for the worker
type WorkerState = {
  width: number;
  height: number;
  ctx: OffscreenCanvasRenderingContext2D | null;
  inputBuffer: SharedArrayBuffer | null;
  inputView: Int32Array | null;
  canvas: OffscreenCanvas | null;
};

// Internal state
const state: WorkerState = {
  width: 640,
  height: 360,
  ctx: null,
  inputBuffer: null,
  inputView: null,
  canvas: null,
};

let placeholderActive = true;
/**
 * HLE-readiness gate. STRUCTURAL startup invariant: no guest instruction may execute
 * before the HLE modules are registered in the dispatcher.
 *
 * `system.process` exists from the moment the Process is constructed, but module
 * registration happens later — and `await backend.initialize(canvas)` sits in between. A
 * bundle load that landed inside that await window started the guest against an EMPTY
 * dispatch table, so every import returned ERROR_NOT_SUPPORTED (50); a DllMain that
 * called the result as a function pointer then jumped to 0x32 and the process died with
 * a wild EIP nowhere near the cause. Timing-dependent, so it reproduced roughly never
 * and then killed a user's session once.
 *
 * Gating on `system.process` alone cannot express this; a promise the load paths await
 * can, and the dispatcher asserts the same invariant from the other side
 * (markHleRegistrationComplete) so a future reordering fails loudly instead of silently.
 */
let resolveHleReady: () => void = () => { /* replaced during init */ };
let hleReady: Promise<void> = new Promise<void>((resolve) => { resolveHleReady = resolve; });
/** True once HLE registration has completed for the current v86 instance. */
let hleReadyResolved = false;

/** Called after every dispatcher.registerModule — opens the gate. */
const markHleReady = (): void => {
  if (hleReadyResolved) return;
  hleReadyResolved = true;
  System.getInstance().process?.dispatcher?.markHleRegistrationComplete?.();
  resolveHleReady();
};

/** Re-arm the gate when the emulator is torn down / restarted, so a load that arrives
 *  during a rebuild waits for the NEW registration rather than the previous one. */
const resetHleReady = (): void => {
  hleReadyResolved = false;
  hleReady = new Promise<void>((resolve) => { resolveHleReady = resolve; });
};

let pendingPeData: Uint8Array | null = null;
let pendingBundle: { data?: Uint8Array; url?: string; blob?: Blob } | null = null;
let heartbeatInterval: number | null = null;
let schedulerInterval: number | null = null;
let registryFlushInterval: number | null = null;
let gdiPresentRafId: number | null = null;
let gdiPresentKickPending = false;
let gdiPresentDiagLogged = false;
let isPaused = false;
let _prefetchController: AbortController | null = null;
/** Serializes load_bundle so a new game always waits for the previous switch teardown. */
let loadBundleChain: Promise<void> = Promise.resolve();
/** True once a PE has been booted in this worker session (loadApp / load_bundle without page reload). */
let gameSessionActive = false;
/** The payload that booted the current game — replayed verbatim by a self re-exec. */
let lastBundlePayload: { data?: Uint8Array; url?: string; blob?: Blob; blobs?: File[]; preload?: boolean } | null = null;
/** Command line the next boot must use instead of the manifest's `args` (self re-exec). */
let pendingReExecArgs: string | null = null;
let registrySaveTimeout: number | null = null;
let registrySaveGeneration = 0;
/** do_tick liveness counter — incremented in the tick_hooks_before guard every v86 do_tick().
 *  If this stops advancing while is_running()===true, the v86 run loop itself died (next_tick
 *  not rescheduled); if it advances but EIP is frozen, cycle execution retired 0 (budget stuck). */
let tickBeforeCount = 0;
/** Count of cycle-budget self-heals (RUNNING thread found with cycle_limit===0 and re-armed). */
let tickHealCount = 0;

// (Adaptive scheduler state removed — tick-boundary preemption handles context switching)

function cancelRegistryAutosave(): void {
  registrySaveGeneration++;
  if (registrySaveTimeout !== null) {
    clearTimeout(registrySaveTimeout);
    registrySaveTimeout = null;
  }
  System.getInstance().registry.setOnChange(null);
}

function installRegistryAutosave(gameId: string): void {
  const system = System.getInstance();
  registrySaveGeneration++;
  const generation = registrySaveGeneration;
  if (registrySaveTimeout !== null) {
    clearTimeout(registrySaveTimeout);
    registrySaveTimeout = null;
  }

  system.registry.setOnChange(() => {
    if (registrySaveTimeout !== null) clearTimeout(registrySaveTimeout);
    registrySaveTimeout = setTimeout(async () => {
      registrySaveTimeout = null;
      if (registrySaveGeneration !== generation) return;

      const state = system.registry.serialize();
      if (state.gameId !== gameId) return;
      await RegistryPersistence.save(gameId, state);
    }, 1000) as unknown as number;
  });
}

/**
 * GDI presentation loop - composites overlay to screen when dirty
 */
const gdiPresentLoop = () => {
  if (isPaused) {
    gdiPresentRafId = null;
    return;
  }

  const system = System.getInstance();
  const gdi = system.gdiContext;
  const videoOverlay = system.videoRouting.getOverlayService();

  // Composite GDI/video overlay to screen.
  // When a 3D renderer (OpenGL/Glide/D3D) is active, only composite if GDI
  // overlay has new content — this handles games that use GDI for video
  // playback while an OpenGL context is technically still current.
  const renderActive = system.services.render.getActive();
  const backend = system.services.render.getBackend();
  if (backend) {
    const videoCanvas = videoOverlay.hasContent() ? videoOverlay.getCanvas() : null;
    const gdiDirty = gdi.isOverlayDirty();

    // This rAF loop is one of several GDI-over-frame compositors (alongside the DDraw
    // presenter's drawFrame/2D/phase-blend paths and the D3D8/D3D9/Glide present paths).
    // It applies the SAME single policy — getOverlayCompositePlan — so it can never
    // diverge from them. When the game owns the screen (DDraw exclusive fullscreen OR a
    // hardware-3D renderer presenting), GDI window output is NOT visible on real Windows,
    // so plan.mode is 'none' (nothing) or 'rects' (only live modal dialogs); never the
    // whole overlay. Without this, the loop would blit stale GDI over the game — e.g. WA
    // renders its frontend via DDraw sprites, and its full-screen MFC host dialog's gray
    // WM_ERASEBKGND would otherwise be composited over every frame.
    const plan = getOverlayCompositePlan(renderActive);

    if (plan.mode !== 'full') {
      // Game owns the screen. Drop stale dirty flags so a later composite (e.g. after
      // returning to the launcher) starts clean, then re-present the last frame so the
      // canvas keeps showing it at display rate (a 3D renderer presents at ~8-12fps and
      // the WebGPU canvas otherwise goes black between presents; the DDraw presenter lacks
      // repaintLastFrame and re-presents each Flip, so this is a no-op there). The only GDI
      // that overlays the frame here is live modal dialog rects (plan.mode === 'rects').
      if (gdiDirty) gdi.clearOverlayDirty();
      if (videoOverlay.isDirty()) videoOverlay.consumeDirty();
      (renderActive as { repaintLastFrame?(): void } | null)?.repaintLastFrame?.();
      if (plan.mode === 'rects' && backend.compositeRects) {
        const overlayCanvas = gdi.getOverlayCanvas();
        if (overlayCanvas) backend.compositeRects(overlayCanvas, plan.rects);
      }
      gdiPresentRafId = requestAnimationFrame(gdiPresentLoop);
      return;
    }

    // Include dirty clears (hasOverlayContent=false after clearOverlay) so the GPU
    // canvas is actually cleared instead of staying stale/black.
    const gdiCanvas = (gdi.hasOverlayContent() || gdiDirty) ? gdi.getOverlayCanvas() : null;
    const videoDirty = videoOverlay.isDirty();

    // One-shot diagnostic for GDI present loop
    if (!gdiPresentDiagLogged && (gdiDirty || (gdiCanvas !== null))) {
      gdiPresentDiagLogged = true;
      Logger.log(LogCategory.SYSTEM,
        `[GDI-PRESENT] First content: hasOverlay=${gdiCanvas !== null} dirty=${gdiDirty} renderActive=${renderActive}`);
    }

    // When a 3D renderer is active, only composite if GDI/video has fresh content.
    // Note: Never clear the canvas when a 3D renderer (D3D/OpenGL) is active —
    // the renderer owns the canvas. GDI overlay should blend on top, not replace.
    const shouldComposite = !renderActive || gdiDirty || videoDirty;
    const shouldClear = !renderActive; // Only clear for GDI-only games (no 3D renderer)

    if (shouldComposite) {
      let composedAny = false;

      if (videoCanvas && (videoDirty || gdiDirty)) {
        backend.composite(videoCanvas, shouldClear);
        videoOverlay.consumeDirty();
        composedAny = true;
      }

      if (gdiCanvas && (gdiDirty || composedAny)) {
        backend.composite(gdiCanvas, shouldClear && !composedAny);
        if (gdiDirty) {
          gdi.clearOverlayDirty();
        }
        composedAny = true;
      }

      if (composedAny) {
        system.services.render.notifyPresent("gdi");
      }
    }
  }

  gdiPresentRafId = requestAnimationFrame(gdiPresentLoop);
};

/**
 * A busy guest can publish GDI between worker animation frames. Queue a macrotask
 * kick so a dirty overlay cannot wait indefinitely for a throttled/lost rAF. The
 * old request is cancelled before the normal recurring loop is restarted.
 */
const kickGdiPresentLoop = () => {
  if (isPaused || gdiPresentKickPending) return;
  gdiPresentKickPending = true;
  setTimeout(() => {
    gdiPresentKickPending = false;
    if (isPaused) return;
    if (gdiPresentRafId !== null) cancelAnimationFrame(gdiPresentRafId);
    gdiPresentRafId = null;
    gdiPresentLoop();
  }, 0);
};

/**
 * Heartbeat diagnostics - checks v86 status and logs periodically
 */
const startHeartbeat = (v86: any) => {
  if (heartbeatInterval !== null) {
    return; // Already started
  }

  let lastFrameCount = 0;
  let lastFrameTime = Date.now();
  let lastInstructionCount = 0;
  let lastSampleUpdateTime = Date.now();
  let lastEip = 0;
  let lastEipTime = Date.now();
  let eipStuckLogged = false;
  let lastExecModule = "";
  let lastExecNonThunked = false;
  let lastPendingRestores = 0;

  // Stuck-thread watchdog state
  const STUCK_THREAD_TIMEOUT_MS = 8000;
  const RECENT_WORKER_DEATH_WINDOW_MS = 30000;
  let watchdogStuckSince = 0; // timestamp when stuck condition first detected (0 = not stuck)
  let tickCountAtStuckStart = 0; // do_tick count when the stuck window opened (liveness delta at fire)
  let watchdogFired = false;  // prevent firing more than once
  let terminatedBaselineInitialized = false;
  let lastTerminatedCount = 0;
  let lastWorkerTerminationTime = 0;

  heartbeatInterval = setInterval(() => {
    if (isPaused) return;

    profiler.start("heartbeat");
    try {
      const system = System.getInstance();

      // Update playing samples positions (every 200ms to simulate playback progress)
      const now = Date.now();
      const sampleDeltaMs = now - lastSampleUpdateTime;
      if (sampleDeltaMs >= EMU_AUDIO_SAMPLE_UPDATE_INTERVAL_MS) {
        profiler.start("audio_update");
        const audioStart = frameProfiler.startTimer();
        const mss32 = system.process?.getModule("mss32") as any;
        if (mss32?.updatePlayingSamplesPositions) {
          mss32.updatePlayingSamplesPositions(sampleDeltaMs);
        }
        lastSampleUpdateTime = now;
        profiler.end("audio_update");
        frameProfiler.endTimer("audio", audioStart);
      }

      // Simplified heartbeat - only calculate expensive metrics every 2nd beat
      const isFullBeat = (Date.now() % 4000) < 2000; // Every other beat

      if (isFullBeat) {
        profiler.start("heartbeat_full");
        const isRunning = v86?.is_running?.() ?? false;
        const renderActive = system.services.render.getActive();
        const dispatcher = system.process?.dispatcher;
        const activeThunks = dispatcher ? (dispatcher as any).getActiveAsyncThunks?.() ?? [] : [];
        const cpu = system.process?.v86?.cpu || (system.process?.v86?.v86 && system.process?.v86?.v86.cpu);
        if (cpu && isRunning) {
          const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
          const atSpinLoop = system.scheduler?.isSpinLoopAddress?.(eip) ?? false;

          // Async wait threads park at spin loop by design; don't report those as stuck EIP.
          if (!atSpinLoop && eip === lastEip) {
            if (!eipStuckLogged && (now - lastEipTime) > 1200) {
              const recent = dispatcher?.getLastWinApiCalls?.(6) ?? [];
              const mem8 = system.process?.v86?.mem8 || (system.process?.v86?.v86 && system.process?.v86?.v86.cpu.mem8);
              let bytes = "";
              if (mem8 && eip + 24 <= mem8.length) {
                bytes = ` bytes=${Array.from(mem8.slice(eip, eip + 24)).map((b: any) => b.toString(16).padStart(2, "0")).join(" ")}`;
              }
              let stackInfo = "";
              if (mem8 && cpu?.reg32) {
                const esp = cpu.reg32[4] >>> 0;
                if (esp + 24 <= mem8.length) {
                  const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
                  const frames: string[] = [];
                  for (let i = 0; i < 5; i++) {
                    const addr = view.getUint32(esp + i * 4, true) >>> 0;
                    frames.push(`[ESP+${i * 4}]=0x${addr.toString(16)}`);
                  }
                  stackInfo = ` stack=${frames.join(" ")}`;
                }
              }
              let regsInfo = "";
              if (cpu?.reg32) {
                regsInfo =
                  ` regs=EAX=0x${(cpu.reg32[0] >>> 0).toString(16)} ECX=0x${(cpu.reg32[1] >>> 0).toString(16)} EDX=0x${(cpu.reg32[2] >>> 0).toString(16)}` +
                  ` EBX=0x${(cpu.reg32[3] >>> 0).toString(16)} ESP=0x${(cpu.reg32[4] >>> 0).toString(16)} EBP=0x${(cpu.reg32[5] >>> 0).toString(16)}`;
              }
              Logger.warn(
                LogCategory.SYSTEM,
                `[HEARTBEAT] EIP stuck at 0x${eip.toString(16)} for ${(now - lastEipTime)}ms; recent thunks=${recent.join(" | ")}${bytes}${stackInfo}${regsInfo}`
              );
              eipStuckLogged = true;
            }
          } else {
            lastEip = eip;
            lastEipTime = now;
            eipStuckLogged = false;
          }
        }

        // Check frame progress (only on full beat)
        let frameInfo = "";
        let frameDeltaForWatchdog: number | null = null;
        if (renderActive) {
          const counters = renderActive.getCounters?.();
          if (counters && typeof counters.frames === "number") {
            const currentFrames = counters.frames;
            const delta = currentFrames - lastFrameCount;
            frameDeltaForWatchdog = delta;
            const timeDelta = Date.now() - lastFrameTime;
            const fps = timeDelta > 0 ? (delta / timeDelta * 1000).toFixed(1) : "0";
            frameInfo = `, frames=${currentFrames} (+${delta}, ~${fps} FPS)`;

            // Log diagnostic when FPS drops to 0 (game might be stuck in CPU loop)
            if (delta === 0 && lastFrameCount > 0 && cpu) {
              const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
              const recent = dispatcher?.getLastWinApiCalls?.(4) ?? [];
              let memInfo = "";
              let bytesInfo = "";
              const mem8 = system.process?.v86?.mem8 || (system.process?.v86?.v86 && system.process?.v86?.v86.cpu.mem8);
              // Check the suspected data structure at 0x609b18 (from HOMM3 analysis)
              if (mem8 && 0x609b30 <= mem8.length) {
                const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
                const struct = [];
                for (let i = 0; i < 6; i++) {
                  struct.push(`+${i * 4}=0x${view.getUint32(0x609b18 + i * 4, true).toString(16)}`);
                }
                memInfo = ` struct@0x609b18=[${struct.join(", ")}]`;
              }
              // Dump instruction bytes at EIP
              if (mem8 && eip + 16 <= mem8.length) {
                bytesInfo = ` bytes@EIP=[${Array.from(mem8.slice(eip, eip + 16) as Uint8Array).map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`;
              }
              Logger.warn(LogCategory.SYSTEM,
                `[HEARTBEAT] 0 FPS - EIP=0x${eip.toString(16)} recent=${recent.join("|")}${memInfo}${bytesInfo}`
              );
            }

            lastFrameCount = currentFrames;
            lastFrameTime = Date.now();
          }
        }

        // Thread diagnostics (always show when there might be issues)
        let threadInfo = "";
        const threadSummary = system.scheduler?.getThreadSummary?.();
        const switchIntent = system.scheduler?.getSwitchIntentSnapshot?.();
        const criticalRuntime = system.scheduler?.getCriticalRuntimeSnapshot?.();
        const apcTelemetry = system.scheduler?.getApcTelemetry?.();
        let hasRecentWorkerDeaths = false;
        if (threadSummary) {
          const terminatedNow = threadSummary.terminated ?? 0;
          if (!terminatedBaselineInitialized) {
            lastTerminatedCount = terminatedNow;
            terminatedBaselineInitialized = true;
          } else if (terminatedNow > lastTerminatedCount) {
            lastWorkerTerminationTime = now;
          }
          lastTerminatedCount = terminatedNow;
          hasRecentWorkerDeaths =
            terminatedNow > 0 &&
            lastWorkerTerminationTime > 0 &&
            (now - lastWorkerTerminationTime) <= RECENT_WORKER_DEATH_WINDOW_MS;

          threadInfo = `, threads=${threadSummary.total}(run=${threadSummary.running},rdy=${threadSummary.ready},wait=${threadSummary.waiting},susp=${threadSummary.suspended},cre=${threadSummary.created ?? 0})`;
          if (switchIntent) {
            threadInfo += `, switchIntent(active=${switchIntent.active ? 1 : 0},age=${switchIntent.ageMs.toFixed(1)}ms,` +
              `def=${switchIntent.deferrals},reason=${switchIntent.lastBlockReason},target=${switchIntent.targetThreadId ?? 0})`;
          }
          if (criticalRuntime) {
            threadInfo += `, criticalRt(active=${criticalRuntime.active ? 1 : 0},owner=${criticalRuntime.ownerThreadId},` +
              `gen=${criticalRuntime.generation},def=${criticalRuntime.deferredSwitchCount})`;
          }
          if (apcTelemetry) {
            threadInfo += `, apc(total=${apcTelemetry.pendingApcTotal},cur=${apcTelemetry.pendingApcByCurrent},` +
              `dispatchOnResume=${apcTelemetry.apcDispatchOnResume},target=${apcTelemetry.pendingApcTargetThreadId})`;
          }
          // Debug: If no running threads but we have threads, something is wrong
          if (threadSummary.running === 0 && threadSummary.total > 0) {
            const detailedInfo = system.scheduler?.getDetailedThreadInfo?.();
            if (detailedInfo) {
              Logger.warn(LogCategory.SYSTEM, `[THREAD DIAGNOSTIC] No RUNNING thread! Details: ${detailedInfo}`);
            }
          }
        }

        // Hypercall stats
        let hcInfo = "";
        if (hypercallDataManager.isEnabled()) {
          hcInfo = `, hc=${hypercallDataManager.getCallCount()}`;
        }

        // Only log if there's something interesting
        const pendingRestores = dispatcher ? ((dispatcher as any).pendingAsyncRestores?.length ?? 0) : 0;
        if (pendingRestores !== lastPendingRestores) {
          const pendingInfo = dispatcher?.peekPendingAsyncRestoreDescriptor?.();
          if (pendingInfo) {
            Logger.warn(
              LogCategory.SYSTEM,
              `[ASYNC-RESTORE] pendingRestores ${lastPendingRestores}->${pendingRestores} ` +
              `next={tid=${pendingInfo.threadId},gen=${pendingInfo.asyncParkGeneration},fn=0x${(pendingInfo.functionId >>> 0).toString(16)},` +
              `name=${pendingInfo.completionName},cleanup=${pendingInfo.cleanupBytes},` +
              `esp=0x${(pendingInfo.esp >>> 0).toString(16)},ret=0x${(pendingInfo.returnAddr >>> 0).toString(16)},` +
              `err=${pendingInfo.errorFlag ? 1 : 0}}`
            );
          } else {
            Logger.warn(LogCategory.SYSTEM, `[ASYNC-RESTORE] pendingRestores ${lastPendingRestores}->${pendingRestores}`);
          }
          lastPendingRestores = pendingRestores;
        }
        if (frameInfo || threadInfo || activeThunks.length > 0 || pendingRestores > 0 || !isRunning) {
          const pendingInfo = pendingRestores > 0 ? dispatcher?.peekPendingAsyncRestoreDescriptor?.() : null;
          const pendingDetail = pendingInfo
            ? `, pendingHead={tid=${pendingInfo.threadId},gen=${pendingInfo.asyncParkGeneration},fn=0x${(pendingInfo.functionId >>> 0).toString(16)},name=${pendingInfo.completionName},esp=0x${(pendingInfo.esp >>> 0).toString(16)}}`
            : "";
          Logger.log(LogCategory.SYSTEM,
            `[HEARTBEAT] v86=${isRunning}${frameInfo}${threadInfo}${hcInfo}, pendingAsync=${activeThunks.length}, pendingRestores=${pendingRestores}${pendingDetail}`
          );
        }


        // Log stuck async thunks
        if (activeThunks.length > 0) {
          for (const thunk of activeThunks) {
            const elapsed = performance.now() - thunk.startTime;
            if (elapsed > 1000) {
              Logger.warn(LogCategory.THUNK,
                `[STUCK] Async thunk "${thunk.functionName}" running for ${elapsed.toFixed(0)}ms`
              );
            }
          }
        }

        // Warn if v86 is stopped (but not during intentional yieldToHost pauses)
        if (!isRunning && system.process && !system.isExiting && !system.scheduler?.intentionalYield) {
          Logger.warn(LogCategory.SYSTEM, `[HEARTBEAT] v86 is NOT running!`);
        }

        // Stuck-thread watchdog: detect irrecoverable hang
        // Condition: EIP stuck + 0 FPS + only 1 alive thread + recent worker exits
        if (!watchdogFired && isRunning && cpu && threadSummary) {
          const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
          const aliveThreads = threadSummary.total - (threadSummary.terminated ?? 0);
          // Spin loop is the normal parking spot for async thunks — EIP sitting there
          // is expected behavior, not a hang. Only flag EIP as stuck if it's in guest code.
          const atSpinLoop = system.scheduler?.isSpinLoopAddress?.(eip) ?? false;
          const eipStuck = !atSpinLoop && (eip === lastEip) && (now - lastEipTime > 2000);
          // Check 0 FPS: frame delta measured before lastFrameCount was updated
          const zeroFps = frameDeltaForWatchdog !== null && frameDeltaForWatchdog === 0 && lastFrameCount > 0;

          if (eipStuck && zeroFps && aliveThreads <= 1 && hasRecentWorkerDeaths) {
            if (watchdogStuckSince === 0) {
              watchdogStuckSince = now;
              tickCountAtStuckStart = tickBeforeCount;
            } else if (now - watchdogStuckSince >= STUCK_THREAD_TIMEOUT_MS) {
              watchdogFired = true;
              const recent = dispatcher?.getLastWinApiCalls?.(16) ?? [];
              const detailedInfo = system.scheduler?.getDetailedThreadInfo?.() ?? 'N/A';
              // Decisive liveness split for this freeze class:
              //   tickDelta≈0  → v86's do_tick run loop itself died (next_tick not rescheduled).
              //   tickDelta>0 + cycleLimit===0 → loop alive but the per-tick budget was stuck at 0
              //                                  (missed prepareForExecution restore) → 0 retired.
              //   tickDelta>0 + cycleLimit>0   → do_tick alive, budget fine → freeze is below us
              //                                  (WASM-level / genuine guest spin at one EIP).
              const tickDelta = (tickBeforeCount - tickCountAtStuckStart) >>> 0;
              const cycleLimit = preemptionManager.isInitialized() ? preemptionManager.getCycleLimit() : -1;
              const diag = `tickDelta=${tickDelta} cycleLimit=${cycleLimit} heals=${tickHealCount} intentionalYield=${system.scheduler?.intentionalYield ? 1 : 0}`;
              Logger.error(LogCategory.SYSTEM,
                `[WATCHDOG] FATAL: Game irrecoverably hung! ` +
                `EIP stuck at 0x${eip.toString(16)} for ${(now - lastEipTime)}ms, ` +
                `0 FPS for ${(now - watchdogStuckSince)}ms, ` +
                `alive=${aliveThreads} terminated=${threadSummary.terminated ?? 0}. ` +
                `${diag}. Recent thunks: ${recent.join(' | ')}`
              );
              Logger.error(LogCategory.SYSTEM, `[WATCHDOG] Thread details: ${detailedInfo}`);

              // Route through the single crash funnel (same as #PF / WASM trap / bad RET)
              // so the host shows the crash dialog + copyable report and harness 'fault' fires.
              const esp = (cpu.reg32?.[4] ?? 0) >>> 0;
              const regsObj = cpu?.reg32 ? {
                ecx: cpu.reg32[1] >>> 0, ebx: cpu.reg32[3] >>> 0, esp,
                ebp: cpu.reg32[5] >>> 0, esi: cpu.reg32[6] >>> 0, edi: cpu.reg32[7] >>> 0,
              } : null;
              const mem8 = system.process?.v86?.mem8 || (system.process?.v86?.v86 && system.process?.v86?.v86.cpu?.mem8);
              const stackDump: number[] = [];
              if (mem8 && esp >= 0 && esp + 128 <= mem8.length) {
                const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
                for (let i = 0; i < 32; i++) stackDump.push(view.getUint32(esp + i * 4, true) >>> 0);
              }
              const curTid = system.scheduler?.getCurrentThreadId?.();
              try {
                system.reportGuestCrash({
                  reason: `Game hung: worker threads terminated, main thread stuck for ${(now - lastEipTime)}ms [${diag}]`,
                  eip,
                  threadId: typeof curTid === "number" ? curTid : null,
                  fault: {
                    regs: regsObj,
                    recentCalls: recent.map((r: unknown) => typeof r === "string" ? r : JSON.stringify(r)),
                    gameEsp: esp,
                    stackDump,
                    lastThunk: recent.length ? String(recent[recent.length - 1]) : "",
                  },
                });
              } catch { /* reportGuestCrash also stops v86 */ }
            }
          } else {
            // Condition no longer met — reset
            watchdogStuckSince = 0;
          }
        }

        profiler.end("heartbeat_full");
      }
    } catch (e) {
      Logger.error(LogCategory.SYSTEM, `[HEARTBEAT] Error: ${e}`);
    } finally {
      profiler.end("heartbeat");
    }
  }, EMU_HEARTBEAT_INTERVAL_MS) as unknown as number;
};

/**
 * Scheduler loop — lightweight fallback for when tick hooks don't fire.
 *
 * Context switching is handled by preemptAtTickBoundary() in tick_hooks_after.
 * This interval only polls timeouts and drains wakes, which is needed when
 * v86 is stopped during async operations (tick hooks don't fire then).
 */
const startScheduler = (v86: any) => {
  if (schedulerInterval !== null) {
    return; // Already started
  }

  schedulerInterval = setInterval(() => {
    if (isPaused) return;

    const system = System.getInstance();
    if (!system.process || system.isExiting) return;

    // pollTimeouts() may fire timers / wake event waiters → threads become READY.
    system.scheduler.pollTimeouts();

    // Deadlock detection — onTick doesn't run when v86 is halted (all threads WAITING)
    (system.scheduler as any).detectDeadlock?.();

    // Restart v86 if it has stopped while work is runnable. The guest CPU loop
    // (and its tick hooks) only runs while v86 is running; when every thread
    // parks, v86 leaves the loop. A subsequent wake — a timer firing above, an
    // event signalled by JS, or a completed async thunk — makes a thread READY
    // (or queues an async restore) but nothing re-enters the run loop to service
    // it. Without this the woken thread idles until some unrelated kick restarts
    // v86 (observed as ~1 frame / several seconds on some intros).
    // v86.run() is idempotent (main.js tick_counter guard); skip during an
    // intentional yieldToHost pause (its resume() restarts v86 itself).
    if (!system.scheduler.intentionalYield) {
      const v86 = system.process.v86 as any;
      if (v86?.run && !(v86.is_running?.() ?? false)) {
        // Live EIP of the (stopped) current thread — gates hasRunningThread to GUEST code only, so a
        // dormant spin-loop thread (winmm timer @ spinLoopAddress) does NOT trigger a restart (that
        // would execute the thunk region with a poison context → guest fault (e.g. Exception 0xee).
        const cpu = system.process.v86?.cpu || (system.process.v86 as any)?.v86?.cpu;
        const curEip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
        const hasWork = system.scheduler.hasRunnableThread()
          || system.scheduler.hasRunningThread(curEip)   // current thread mid-computation at guest EIP (e.g. DWN pow-LUT) — resume it
          || (system.process.dispatcher?.hasPendingAsyncRestores?.() ?? false);
        if (hasWork) v86.run();
      }
    }

    // Cycle-budget self-heal. requestImmediateExit() (async thunk park) writes cycle_limit=0
    // so v86 leaves do_many_cycles_native immediately; prepareForExecution() restores the full
    // budget on the next tick_hooks_before. If that restore is ever missed, the current RUNNING
    // thread is left with a 0 budget → v86 keeps is_running()===true but retires 0 instructions
    // per tick → silent freeze that only the watchdog notices (Re-Volt: EIP frozen mid render/
    // sound loop after a sibling thread exited). A RUNNING current thread with cycle_limit===0
    // is ALWAYS wrong (0 is valid only while the current thread is WAITING/async-parked), so
    // re-arm the budget and kick. Runs every ~1ms → near-instant recovery; no false positives.
    if (!system.scheduler.intentionalYield && preemptionManager.isInitialized()) {
      const cur = system.scheduler.getCurrentThread?.();
      if (cur && cur.state === ThreadState.RUNNING && preemptionManager.getCycleLimit() === 0) {
        preemptionManager.rearmCycleBudget();
        tickHealCount++;
        // Kick unconditionally (v86.run() is idempotent via its tick_counter guard): re-arming
        // the budget revives the "do_tick alive, 0 budget" case; calling run() also reschedules
        // next_tick() to revive a "do_tick loop died but is_running() stuck true" case.
        const v86b = system.process.v86 as any;
        if (v86b?.run) v86b.run();
      }
    }
  }, EMU_SCHEDULER_INTERVAL_MS) as unknown as number;
};

/**
 * Registry flush - periodically flush access log to OPFS
 * Runs every 30 seconds to prevent data loss
 */
const startRegistryFlush = () => {
  if (registryFlushInterval !== null) {
    return; // Already started
  }

  registryFlushInterval = setInterval(async () => {
    try {
      const system = System.getInstance();
      await system.registry.flushAccessLog();
    } catch (e) {
      Logger.error(LogCategory.SYSTEM, `[REGISTRY_FLUSH] Error: ${e}`);
    }
  }, 30000) as unknown as number; // 30 seconds
};

// Placeholder drawing - only runs until PE is loaded
const drawPlaceholder = () => {
  if (!placeholderActive || !state.ctx) return;
  const ctx = state.ctx;

  // Simple background clear
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, state.width, state.height);

  ctx.fillStyle = '#666';
  ctx.font = '16px monospace';
  ctx.fillText('Ready - Load a PE file', 20, 30);

  requestAnimationFrame(drawPlaceholder);
};

const loadPeData = async (peData: Uint8Array, skipReset: boolean = false) => {
  const system = System.getInstance();
  if (!system.process) {
    Logger.log(LogCategory.SYSTEM, "System not ready, queuing PE data");
    pendingPeData = peData;
    return;
  }
  // The Process exists but the dispatch table may still be empty (see hleReady).
  await hleReady;

  // Reset system state before loading new application
  if (!skipReset) {
    await prepareFullGameSwitch();
  }

  // Restart placeholder drawing
  placeholderActive = true;
  if (state.ctx) {
    requestAnimationFrame(drawPlaceholder);
  }

  try {
    const module = await system.process.loader.loadExecutable(peData);
    Logger.log(LogCategory.SYSTEM, `Loaded PE. Entry point: 0x${module.entryPoint.toString(16)}, base: 0x${module.baseAddress.toString(16)}`);

    // Update PEB ImageBaseAddress now that we know the actual EXE base
    system.scheduler?.tebManager.updatePebImageBase(module.baseAddress);

    // Extract app icon from PE resources and send to host page for favicon
    try {
        const mem8 = system.process.getCurrentMemory();
        const iconData = extractAppIcon(mem8, module.baseAddress);
        if (iconData) {
            const buffer = iconData.buffer.slice(iconData.byteOffset, iconData.byteOffset + iconData.byteLength);
            (self as unknown as Worker).postMessage({ type: "window_icon", data: buffer }, [buffer]);
            Logger.log(LogCategory.SYSTEM, `Sent app icon to host (${iconData.byteLength} bytes)`);
        } else {
            Logger.warn(LogCategory.SYSTEM, `No icon found in PE (RT_GROUP_ICON not present)`);
        }
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `Icon extraction failed: ${e}`);
    }

    // Note: Apply pending registrations AFTER PE loading
    // Stubs are created during loadExecutable (processImports), so we must apply
    // JS implementations to stubs now that they exist.
    // (this also registers matching functions with hypercallDataManager)
    system.process.dispatcher.applyPendingRegistrations();
    prePopulateGetProcAddressCache(system.process.dispatcher);
    ensureGetProcAddressDynamicExports(system.process.dispatcher, [
      { dll: "d3d9", name: "Direct3DShaderValidatorCreate9" },
      { dll: "d3d9", name: "DebugSetMute" },
      { dll: "w32skrnl", name: "_ImteFromHModule@4" },
      { dll: "w32skrnl", name: "_BaseAddrFromImte@4" },
      { dll: "kernel32", name: "GetDiskFreeSpaceExA" },
      { dll: "kernel32", name: "GetDiskFreeSpaceExW" },
      ...KERNEL32_VISTA_WARMUP_EXPORTS,
    ]);

    try {
        const { ensureProcessDefaultActivationContext } = await import("./modules/kernel32/process/actctx");
        await ensureProcessDefaultActivationContext(
            system.process.getCurrentMemory(),
            module.baseAddress
        );
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `[ActCtx] preload failed: ${e}`);
    }

    // Enable WASM hypercall dispatch now that stubs are registered
    if (hypercallDataManager.isInitialized() && hypercallDataManager.getRegisteredCount() > 0) {
        hypercallDataManager.enable();
        // NOTE: Heap slab allocation deferred — allocating 4MB during init steals memory
        // from MapViewOfFile and other game loading operations. Slab will be allocated
        // lazily after the first frame when loading pressure subsides.
    }

    // Collect DLLs that need DllMain(DLL_PROCESS_ATTACH) before EXE entry
    const pendingDllInits = system.process.loader.getPendingDllInits();
    if (pendingDllInits.length > 0) {
      Logger.warn(LogCategory.SYSTEM,
        `DllMain trampoline: ${pendingDllInits.length} DLL(s): ${pendingDllInits.map(d => `${d.name}@0x${d.entryPoint.toString(16)}`).join(', ')}`);
    } else {
      Logger.warn(LogCategory.SYSTEM, `DllMain trampoline: NO DLLs with entry points queued`);
    }

    // Stop current execution
    await system.process.v86.stop();

    const cpu = system.process.v86.cpu || (system.process.v86.v86 && system.process.v86.v86.cpu);
    const mem8 = system.process.v86.mem8 || (system.process.v86.v86 && system.process.v86.v86.cpu.mem8);

    if (!cpu || !mem8) {
      Logger.error(LogCategory.SYSTEM, "Could not find CPU or memory for bootloader setup");
      return;
    }

    // Create the bootloader that will switch to protected mode and jump to PE entry
    // The bootloader now includes the GDT data bundled at offset 512
    // Allocate main thread stack from HEAP using the PE's SizeOfStackReserve.
    // The old 64KB stack at 0x80000-0x90000 was too small for games with deep call
    // stacks (e.g., UT's recursive UObject deserialization during level loading).
    const peStackReserve = module.sizeOfStackReserve || 0;
    const mainStackSize = Math.max(peStackReserve, 0x100000); // At least 1MB
    let stackPointer: number;
    if (system.process?.memory) {
      const stackBase = system.process.memory.alloc(mainStackSize, 'HEAP');
      stackPointer = stackBase + mainStackSize;
      Logger.log(LogCategory.SYSTEM,
        `Main thread stack: 0x${stackBase.toString(16)}-0x${stackPointer.toString(16)} (${(mainStackSize / 1024).toFixed(0)}KB, PE requested ${(peStackReserve / 1024).toFixed(0)}KB)`);
    } else {
      // Fallback to low-memory boot stack if HEAP not available yet
      stackPointer = 0x90000;
      Logger.warn(LogCategory.SYSTEM, `Main thread stack: fallback to 0x${stackPointer.toString(16)} (HEAP not available)`);
    }
    const { code: bootCode, loadAddress, startAddress } = createBootloader(module.entryPoint, stackPointer, pendingDllInits);

    // Write bootloader at 0x7C00 (includes code + boot sig + GDT at 0x7E00)
    writeGuestCode(mem8, bootCode, loadAddress);
    Logger.log(LogCategory.SYSTEM, `Bootloader+GDT written at 0x${loadAddress.toString(16)}, size: ${bootCode.length}`);

    // Initialize page tables in guest memory (identity-mapped).
    // Pages are all Present+RW+User. Paging is ENABLED later by thunk dispatcher
    // when bootloader signals PM+IDT ready (0xDEAD0003 marker).
    const { PageTableManager } = await import('./core/memory/page-table-manager');
    const ptm = new PageTableManager(
        () => system.process!.v86.mem8 || system.process!.v86.v86?.cpu?.mem8,
        () => cpu.wm?.exports
    );
    const { VER_PLATFORM_WIN32_WINDOWS } = await import('./core/emulator-config-manager');
    const win9x = EmulatorConfig.getInstance().osVersion.platformId === VER_PLATFORM_WIN32_WINDOWS;
    ptm.initialize(mem8.length, win9x);
    system.process!.pageTableManager = ptm;

    // Provide stack bounds to scheduler for main thread TEB allocation
    system.scheduler.setMainStackInfo(stackPointer, mainStackSize);

    // Set CPU to start executing the bootloader in real mode
    // After system.reset() -> v86.restart(), the CPU is already in Real Mode.
    // We just need to point CS:IP to our bootloader.
    if (cpu.sreg) {
      cpu.sreg[1] = 0x0000; // CS = 0
    }
    cpu.instruction_pointer[0] = startAddress;

    // Ensure segment offsets are 0 for the bootloader (Real Mode)
    if (cpu.segment_offsets) {
      for (let i = 0; i < 6; i++) {
        cpu.segment_offsets[i] = 0;
      }
    }

    Logger.log(LogCategory.SYSTEM, `Starting bootloader execution at CS:IP = 0:0x${startAddress.toString(16)}`);

    resumeEmulator();
    framePacer.start();
    gameSessionActive = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(LogCategory.SYSTEM, `PE load failed: ${message}`);
    // Route through the single crash funnel so the host shows the standard
    // "game crashed" dialog with a copyable report (e.g. a missing HLE API
    // discovered while generating import thunks), instead of a silent worker log.
    system.reportGuestCrash({ reason: `PE load failed: ${message}`, eip: 0, threadId: null });
  }
};

const writeVfsOverride = async (path: string, data: Uint8Array): Promise<void> => {
  const vfs = System.getInstance().fileSystem;
  const handle = await vfs.open(path, 0x40000000, 2); // GENERIC_WRITE, CREATE_ALWAYS
  if (!handle) {
    throw new Error(`unable to create VFS override "${path}"`);
  }
  await vfs.write(handle, data);
  await vfs.flushFile(handle.path);
};

const decodeWriteFileSpec = (spec: WgbWriteFileSpec): Uint8Array | null => {
  if (typeof spec.text === "string") {
    return new TextEncoder().encode(spec.text);
  }
  if (typeof spec.base64 === "string") {
    const bin = atob(spec.base64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return data;
  }
  if (Array.isArray(spec.leDwords)) {
    const data = new Uint8Array(spec.leDwords.length * 4);
    const view = new DataView(data.buffer);
    for (let i = 0; i < spec.leDwords.length; i++) {
      view.setUint32(i * 4, spec.leDwords[i] >>> 0, true);
    }
    return data;
  }
  return null;
};

// Apply the manifest's data-driven writeFiles list: per-game config overrides that
// previously lived as hardcoded compatibility patches (e.g. Blade of Darkness forcing
// its D3D raster via Blade.config/D3d.cfg — now declared in that bundle's manifest).
const applyManifestWriteFiles = async (): Promise<void> => {
  // createDirs first: recreate installer-made empty dir trees (lost by store-only
  // ZIP packing) so both writeFiles below and the game itself find them.
  const dirs = EmulatorConfig.getInstance().createDirs;
  for (const dir of dirs) {
    try {
      System.getInstance().fileSystem.ensureDirTreeSync(dir);
      Logger.log(LogCategory.SYSTEM, `createDirs: ensured "${dir}"`);
    } catch (err) {
      Logger.error(LogCategory.SYSTEM, `createDirs: failed for "${dir}": ${err}`);
    }
  }
  const specs = EmulatorConfig.getInstance().writeFiles;
  if (!specs.length) return;
  const vfs = System.getInstance().fileSystem;
  for (const spec of specs) {
    if (spec.ifAbsent && vfs.getFileSize(spec.path) > 0) {
      Logger.log(LogCategory.SYSTEM, `writeFiles: "${spec.path}" already present, skipped (ifAbsent)`);
      continue;
    }
    const data = decodeWriteFileSpec(spec);
    if (!data) {
      Logger.warn(LogCategory.SYSTEM, `writeFiles: "${spec.path}" has no valid content (text/base64/leDwords) — skipped`);
      continue;
    }
    try {
      // mkdir -p the parent dirs first: writeVfsOverride uses CREATE_ALWAYS, which
      // returns null on a missing parent dir (faithful Win32) and would otherwise
      // silently drop the write. Emulator-side injection, like a setup step.
      vfs.ensureParentDirsSync(spec.path);
      await writeVfsOverride(spec.path, data);
      Logger.log(LogCategory.SYSTEM, `writeFiles: wrote "${spec.path}" (${data.length} bytes)`);
    } catch (err) {
      Logger.error(LogCategory.SYSTEM, `writeFiles: failed to write "${spec.path}": ${err}`);
    }
  }
};

// Generic Unreal Engine 1 first-run setup. Detects a UE1 bundle (System/Core+Engine
// packages) and, if so, sets the ue1 flag and pins our D3D render device in
// System/Default.ini so any config the engine derives from it inherits D3DDrv
// instead of falling back to a software/null device. The reactive Detected.ini /
// config-ini materialization (kernel32 CreateFile*) also gates on this flag.
// Non-UE1 games: detectUe1() returns false → this is a complete no-op.
const pinGuestEngineIni = async (
  vfs: ReturnType<typeof System.getInstance>["fileSystem"],
  iniPath: string,
  hasPcPackages: boolean,
): Promise<void> => {
  if (vfs.getFileSize(iniPath) <= 0) return;
  try {
    const size = vfs.getFileSize(iniPath);
    // Read the WHOLE file, and prove it. A short read here used to be indistinguishable
    // from an empty config: pinUeEngineIni("") synthesizes a bare [Engine.Engine] (exactly
    // 136 bytes) and the write below then replaced the 10 KB factory config with it — in the
    // CoW overlay, which shadows ROM, so one transient short read poisoned every later boot.
    // The engine then had no [Core.System] at all: no Language, so it asked for
    // `Splash.bmp` / `EALogo(null).bmp` instead of `splasheng.bmp` and died in InitEngine
    // (`Assertion failed: Bitmap.LoadFile`). A config we could not read whole is a config we
    // must not rewrite — leave it alone and say so loudly.
    // read() is allowed to return less than asked (it serves whatever window it has), so
    // "read to completion" means looping until the file is consumed or a read stops making
    // progress — the latter is the real failure and the only case that must not pin.
    const readWhole = async (): Promise<Uint8Array | null> => {
      const handle = await vfs.open(iniPath, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
      if (!handle) return null;
      const out = new Uint8Array(size);
      let got = 0;
      while (got < size) {
        const chunk = await vfs.read(handle, size - got);
        if (chunk.length === 0) return null;   // no progress → truncated/failed read
        out.set(chunk.subarray(0, Math.min(chunk.length, size - got)), got);
        got += chunk.length;
      }
      return out;
    };
    // One retry: the loss is transient (streamed ROM / OPFS hiccup), not a property of the file.
    const bytes = (await readWhole()) ?? (await readWhole());
    if (!bytes) {
      Logger.error(LogCategory.SYSTEM,
        `UE1: refusing to pin ${iniPath} — could not read all ${size} bytes (short read). ` +
        `Leaving the config untouched; overwriting it with a synthesized stub would strip ` +
        `[Core.System] (Language/Paths) and break the engine on every later boot.`);
      return;
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    // A factory UE config always carries [Core.System] (Language, Paths). Its absence means
    // this overlay copy is a stub a poisoned earlier boot left behind, not a real config —
    // name it, because the downstream symptom (engine asks for an unsuffixed Splash.bmp and
    // asserts) points nowhere near here.
    if (!/^\s*\[Core\.System\]/im.test(text)) {
      Logger.warn(LogCategory.SYSTEM,
        `UE1: ${iniPath} (${size} bytes) has no [Core.System] section — the engine will have no ` +
        `Language/Paths. If this game previously failed to load a config, clear its OPFS overlay ` +
        `so the factory config in the bundle is used again.`);
    }
    const pinned = pinUeEngineIni(text, { hasPcPackages });
    if (pinned !== text) {
      await writeVfsOverride(iniPath, new TextEncoder().encode(pinned));
      Logger.log(LogCategory.SYSTEM, `UE1: pinned engine defaults in ${iniPath} (render=${UE1_RENDER_DEVICE_NAME})`);
    } else {
      Logger.log(LogCategory.SYSTEM, `UE1: ${iniPath} already has engine defaults`);
    }
  } catch (err) {
    Logger.warn(LogCategory.SYSTEM, `UE1: failed to pin engine defaults in ${iniPath}: ${err}`);
  }
};

const applyUe1FirstRunSetup = async (entrypointPath?: string): Promise<void> => {
  const config = EmulatorConfig.getInstance();
  const vfs = System.getInstance().fileSystem;
  const exists = (guestPath: string): boolean => vfs.getFileSize(guestPath) > 0;
  config.ue1 = detectUe1(exists);
  if (!config.ue1) return;
  Logger.log(LogCategory.SYSTEM, "UE1: detected Unreal Engine 1 bundle — enabling generic first-run handler");

  const hasPcPackages = detectUe2PcPackages(exists);
  // Pin D3D render device + UE2 WinDrv ForceFeedbackManager in factory and active configs.
  const iniPaths = ["C:\\System\\Default.ini"];
  if (entrypointPath) {
    const exeName = entrypointPath.split(/[\\/]/).pop() ?? "";
    const gameIni = exeName.replace(/\.[^.]+$/i, "");
    if (gameIni) iniPaths.push(`C:\\System\\${gameIni}.ini`);
  }
  for (const iniPath of iniPaths) {
    await pinGuestEngineIni(vfs, iniPath, hasPcPackages);
  }
};

/** Recursively merge `src` into `target` (plain objects merged, everything else replaced). */
const deepMergeInto = (target: Record<string, unknown>, src: Record<string, unknown>): void => {
  for (const k of Object.keys(src)) {
    const v = src[k];
    const cur = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      deepMergeInto(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
};

/** slice.cpp slice_filename — external slice file name for a given slice index. */
const sliceFilename = (base: string, slice: number, slicesPerDisk: number): string => {
  if (slicesPerDisk <= 1) return `${base}-${slice + 1}.bin`;
  const major = Math.floor(slice / slicesPerDisk) + 1;
  const minor = slice % slicesPerDisk;
  return `${base}-${major}${String.fromCharCode(97 + minor)}.bin`;
};

/** Natural slice ordinal from a `-<major>[<letter>].bin` suffix (fallback ordering). */
const sliceOrdinal = (name: string): number => {
  const m = name.toLowerCase().match(/-(\d+)([a-z])?\.bin$/);
  if (!m) return 0;
  return parseInt(m[1]!, 10) * 100 + (m[2] ? m[2].charCodeAt(0) - 97 : 0);
};

/** Order dropped `.bin` slices by slice index: try the Inno naming scheme, else natural sort. */
const orderSliceFiles = (bins: File[], base: string, slicesPerDisk: number): File[] => {
  const byName = new Map(bins.map((f) => [f.name.toLowerCase(), f]));
  const ordered: File[] = [];
  for (let i = 0; i < bins.length; i++) {
    const f = byName.get(sliceFilename(base, i, slicesPerDisk).toLowerCase());
    if (!f) { ordered.length = 0; break; }
    ordered.push(f);
  }
  if (ordered.length === bins.length) return ordered;
  return [...bins].sort((a, b) => sliceOrdinal(a.name) - sliceOrdinal(b.name));
};

/**
 * Authoritative teardown before loading a new game while another is (or was) running.
 * Pauses the guest loop first so the 1ms scheduler cannot restart v86 mid-reset.
 */
const prepareFullGameSwitch = async (): Promise<void> => {
  if (gameSessionActive) {
    Logger.log(LogCategory.SYSTEM, "[GameSwitch] full reset before loading new game");
  }
  __wasmTrapReported = false;
  gdiPresentDiagLogged = false;
  _prefetchController?.abort();
  _prefetchController = null;
  WgbCache.releaseMountedSource();
  setBootOverlayActive(false);

  const system = System.getInstance();
  cancelRegistryAutosave();
  if (system.process?.v86) {
    isPaused = true;
    system.isPaused = true;
    if (gdiPresentRafId !== null) {
      cancelAnimationFrame(gdiPresentRafId);
      gdiPresentRafId = null;
    }
    framePacer.stop();
    system.windowManager.wakeWaiters();
    try {
      await system.process.v86.stop();
    } catch (e) {
      Logger.warn(LogCategory.SYSTEM, `[GameSwitch] v86.stop failed: ${e}`);
    }
  }

  resetHeapSlab();
  await system.reset();
  gameSessionActive = false;
  bootMark("system-reset-done");
};

/**
 * The single host-facing "what bundle is this" post. Both load paths (load_bundle and
 * the pendingBundle path inside initV86) go through here — the host keys per-game touch
 * layouts on `gameId` and reads the authored `emulator.touch` tier from this message, so
 * a site that posts one field and not the other silently substitutes auto-detect for an
 * authored layout on that path.
 */
const postBundleMeta = (manifest: WgbManifest, gameId: string): void => {
  const title = typeof manifest.title === "string" ? manifest.title.trim() : "";
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  self.postMessage({
    type: "bundle_meta",
    name: title || name,
    gameId,
    touch: manifest.emulator?.touch ?? null,
  });
};

const loadBundleImpl = async (payload: { data?: Uint8Array; url?: string; blob?: Blob; blobs?: File[]; preload?: boolean }) => {
  const system = System.getInstance();
  if (!system.process) {
    pendingBundle = payload;
    return;
  }
  // The Process exists but the dispatch table may still be empty (see hleReady).
  await hleReady;

  bootMark("load-bundle-start");

  await prepareFullGameSwitch();

  // Restart placeholder drawing
  placeholderActive = true;
  if (state.ctx) {
    requestAnimationFrame(drawPlaceholder);
  }

  try {
    // NOTE: the writable overlay is opened AFTER the bundle's gameId is known (per-game container,
    // see below) — it can't be rooted before we know which game's container to open.
    bootMark("pre-overlay");

    let bundle;
    if (payload.url) {
      // Prefer a cached bundle read SYNCHRONOUSLY off disk via a sync-access handle —
      // no 1.5GB BufferSource held in worker RAM, and the same OPFS copy a disk-blob
      // load of this game would use (one copy per game, not two).
      const url = payload.url;

      // Stream the bundle on demand instead of a full OPFS download — instant start,
      // NO blocking multi-GB copy (a 1.6 GB game boots after fetching just what the
      // boot path reads). Needs cross-origin isolation for the SAB I/O worker (prod
      // Pages sets COOP/COEP; the dev server too) and a Range-honoring origin (the R2
      // Pages Function serves 206). create() probes both, so any failure throws and we
      // fall through to the OPFS-download/staging path below, unchanged.
      // `preload` (catalog entry) opts a deployment out of on-demand streaming: one
      // sequential download into OPFS beats hundreds of range round-trips wherever
      // per-request latency is the cost (self-hosted stand behind a reverse proxy).
      const streamCapable = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
        && payload.preload !== true;
      if (streamCapable) {
        try {
          // Preferred: serve the guest's synchronous reads from a dedicated I/O
          // worker over a SharedArrayBuffer. The I/O worker owns the network,
          // fetches in parallel and prefetches ahead of the guest cursor, so a
          // cold read parks the guest for ~a SAB round-trip instead of a network
          // one — no serial, latency-bound sync-XHR grind. Needs cross-origin
          // isolation (SAB); falls back to the blocking sync-XHR range source.
          let src: import("@bottleship/formats/zip").ZipSource;
          let sabIo: SabIoSource | null = null;
          try {
            sabIo = await SabIoSource.create(url);
            src = sabIo;
            (globalThis as unknown as { __wgbSabIo?: unknown }).__wgbSabIo = src;
            Logger.log(LogCategory.SYSTEM, `WGB: streaming "${url}" via SAB I/O worker (parallel prefetch)`);
          } catch (sabErr) {
            src = await SyncHttpRangeSource.create(url);
            Logger.log(LogCategory.SYSTEM, `WGB: SAB I/O unavailable (${(sabErr as Error).message}) — streaming via sync-XHR range`);
          }
          // Reflect the actual streaming stages (index read → entrypoint fetch) in the
          // loading UI instead of a static "Streaming" — the prefetch phase below then
          // takes over with its determinate "N / M files" bar.
          const postStreamStage = (label: string) =>
            self.postMessage({ type: "loading_progress", phase: "loading", percent: 100, label });
          postStreamStage("Streaming");
          try {
            bundle = await WgbLoader.fromSource(src, postStreamStage);
          } catch (loadErr) {
            // fromSource failed after the I/O worker spun up — terminate it so the
            // fallthrough to OPFS staging doesn't leak a live worker + its SAB.
            sabIo?.close();
            (globalThis as unknown as { __wgbSabIo?: unknown }).__wgbSabIo = undefined;
            throw loadErr;
          }
        } catch (e) {
          Logger.log(LogCategory.SYSTEM, `WGB: sync-stream unavailable (${(e as Error).message}) — staging to OPFS`);
        }
      }

      if (!bundle) {
      const downloadToRam = async (): Promise<Uint8Array> => {
        self.postMessage({ type: "loading_progress", phase: "downloading", percent: 0, label: "0 MB" });
        const buf = await WgbCache.downloadWithProgress(url, (loaded, total) => {
          const percent = total > 0 ? Math.round(loaded / total * 100) : 0;
          const loadedMb = (loaded / 1024 / 1024).toFixed(0);
          const totalMb = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(0)} MB` : " MB";
          self.postMessage({ type: "loading_progress", phase: "downloading", percent, label: `${loadedMb}${totalMb}` });
        });
        self.postMessage({ type: "loading_progress", phase: "starting", percent: 100, label: "" });
        return buf;
      };

      let syncSource = await WgbCache.openSyncSourceForUrl(url);
      let downloadedBuffer: Uint8Array | null = null;
      if (syncSource) {
        Logger.log(LogCategory.SYSTEM, `WGB: OPFS cache hit (sync), launching immediately`);
        self.postMessage({ type: "loading_progress", phase: "loading", percent: 100, label: "Cached" });
      } else {
        // Cache miss — stream the download STRAIGHT into the OPFS sync handle (no
        // monolithic RAM buffer). This is the only path that works for bundles past
        // V8's max ArrayBuffer size (~2GB) — e.g. the 2.5GB XIII bundle, where the
        // in-RAM concat throws "Array buffer allocation failed". Fall back to the
        // in-RAM download only when OPFS/SAH streaming is unavailable (smaller bundles).
        syncSource = await WgbCache.downloadToSyncSource(url, (loaded, total) => {
          const percent = total > 0 ? Math.round(loaded / total * 100) : 0;
          const loadedMb = (loaded / 1024 / 1024).toFixed(0);
          const totalMb = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(0)} MB` : " MB";
          self.postMessage({ type: "loading_progress", phase: "downloading", percent, label: `${loadedMb}${totalMb}` });
        }).catch((e) => {
          Logger.warn(LogCategory.SYSTEM, `WGB: streaming download failed (${e}) — falling back to in-RAM`);
          return null;
        });
        if (syncSource) {
          self.postMessage({ type: "loading_progress", phase: "starting", percent: 100, label: "" });
        } else {
          downloadedBuffer = await downloadToRam();
          syncSource = await WgbCache.openSyncSourceForUrl(url);
        }
      }

      // Prefer the off-disk sync source (no RAM copy). But the OPFS persist of a
      // large bundle can silently truncate (a partial write passes the size guard,
      // then ZipArchive.init fails "EOCD not found"). On ANY corrupt-cache failure
      // fall back to the in-RAM download — NOT fromUrl(), whose HTTP-range path
      // breaks under dev servers that ignore Range and return the whole file
      // (Content-Range 0-EOF → the EOCD tail read lands on the file START).
      const loadFromRam = async () => {
        if (!downloadedBuffer) downloadedBuffer = await downloadToRam();
        Logger.warn(LogCategory.SYSTEM, `WGB: loading from the in-RAM download (${(downloadedBuffer.byteLength / 1048576).toFixed(1)} MB) — OPFS cache unusable`);
        return WgbLoader.fromBuffer(downloadedBuffer);
      };
      if (syncSource) {
        try {
          bundle = await WgbLoader.fromSource(syncSource);
        } catch (e) {
          Logger.warn(LogCategory.SYSTEM, `WGB: cached sync source unusable (${e}) — discarding and reloading`);
          await WgbCache.evict(url);
          bundle = await loadFromRam();
        }
      } else {
        bundle = await loadFromRam();
      }
      } // end if (!bundle) — dev sync-stream did not already produce a bundle
    } else if (payload.blobs && payload.blobs.length) {
      // Multi-part installer: setup.exe (header + file list) + external setup-*.bin data slices.
      const all = payload.blobs;
      const bins = all.filter((f) => f.name.toLowerCase().endsWith(".bin"));
      const exe = all.find((f) => !f.name.toLowerCase().endsWith(".bin"));
      if (!exe) throw new Error("multi-part install: no setup.exe among the dropped files");
      if (!bins.length) throw new Error("multi-part install: no setup-*.bin data slices dropped");

      self.postMessage({ type: "loading_progress", phase: "loading", percent: 0, label: "Reading installer" });
      const data = new Uint8Array(await exe.arrayBuffer());
      const kind = detectFormat(data);
      if (kind !== "inno") {
        const msg = kind === "inno-unsupported"
          ? "This Inno Setup version is not supported"
          : "Dropped files aren't a supported multi-part GOG installer";
        self.postMessage({ type: "installer_unsupported", message: msg });
        throw new Error(msg);
      }

      const wasmResp = await fetch("/unpack-streaming.wasm");
      const wasmBytes = await wasmResp.arrayBuffer();
      const lzma = new UnpackDecoder();
      await lzma.init(wasmBytes);
      const parsed = await parseInnoHeader(new BufferSource(data), lzma);

      const slicesPerDisk = Math.max(1, parsed.header.slicesPerDisk || 1);
      const base = exe.name.replace(/\.exe$/i, "");
      const ordered = orderSliceFiles(bins, base, slicesPerDisk);
      const sliceData: SliceData[] = [];
      for (const f of ordered) {
        sliceData.push(parseSliceFile(new Uint8Array(await f.arrayBuffer())));
      }

      const cacheKey = guessCacheKey(parsed);
      const cached = await WgbCache.getByKey(cacheKey);
      if (cached) {
        Logger.log(LogCategory.SYSTEM, `GOG import (multi-part): cache hit ${cacheKey}`);
        self.postMessage({ type: "install_progress", phase: "starting", doneBytes: cached.byteLength, totalBytes: cached.byteLength });
        bundle = await WgbLoader.fromBuffer(cached);
      } else {
        let installProgressLast = 0;
        const result = await installerBytesToWgb(data, wasmBytes, {
          parsed,
          sliceSource: new MultiSliceReader(sliceData),
          onProgress: (p) => {
            const now = performance.now();
            if (now - installProgressLast < 100) return;
            installProgressLast = now;
            self.postMessage({ type: "install_progress", phase: p.phase, doneBytes: p.doneBytes, totalBytes: p.totalBytes });
          },
        });
        await WgbCache.put(result.cacheKey ?? cacheKey, result.wgb);
        bundle = await WgbLoader.fromBuffer(result.wgb);
      }
    } else if (payload.blob) {
      const head = new Uint8Array(await payload.blob.slice(0, 64).arrayBuffer());
      const headKind = sniffBlobHead(head);

      // Disk blobs are staged into OPFS for synchronous reads; surface that as a
      // "caching" phase so the loading overlay doesn't sit on a bare "Loading…".
      const onCacheProgress = (done: number, total: number) => {
        const doneMb = (done / 1024 / 1024).toFixed(0);
        const totalMb = (total / 1024 / 1024).toFixed(0);
        const percent = total > 0 ? Math.round(done / total * 100) : 0;
        self.postMessage({ type: "loading_progress", phase: "caching", percent, label: `${doneMb} / ${totalMb} MB` });
      };

      if (headKind === "wgb") {
        bundle = await WgbLoader.fromBlob(payload.blob, onCacheProgress);
      } else if (headKind === "unknown") {
        const msg = "Unrecognized file format";
        self.postMessage({ type: "installer_unsupported", message: msg });
        throw new Error(msg);
      } else {
        const data = new Uint8Array(await payload.blob.arrayBuffer());
        const kind = detectFormat(data);

        if (kind === "pe") {
          await loadPeData(data);
          return;
        }
        if (kind === "unknown" || kind === "inno-unsupported") {
          const msg = kind === "inno-unsupported"
            ? "This Inno Setup version is not supported"
            : "Unrecognized file format";
          self.postMessage({ type: "installer_unsupported", message: msg });
          throw new Error(msg);
        }
        if (kind === "inno") {
          let installProgressLast = 0;
          const wasmResp = await fetch("/unpack-streaming.wasm");
          const wasmBytes = await wasmResp.arrayBuffer();

          const lzma = new UnpackDecoder();
          await lzma.init(wasmBytes);
          const parsed = await parseInnoHeader(new BufferSource(data), lzma);
          const cacheKey = guessCacheKey(parsed);

          const cached = await WgbCache.getByKey(cacheKey);
          let wgbBuffer: Uint8Array;
          if (cached) {
            Logger.log(LogCategory.SYSTEM, `GOG import: cache hit ${cacheKey}`);
            self.postMessage({ type: "install_progress", phase: "starting", doneBytes: cached.byteLength, totalBytes: cached.byteLength });
            wgbBuffer = cached;
          } else {
            const result = await installerBytesToWgb(data, wasmBytes, {
              parsed,
              onProgress: (p) => {
                const now = performance.now();
                if (now - installProgressLast < 100) return;
                installProgressLast = now;
                self.postMessage({
                  type: "install_progress",
                  phase: p.phase,
                  doneBytes: p.doneBytes,
                  totalBytes: p.totalBytes,
                });
              },
            });
            wgbBuffer = result.wgb;
            await WgbCache.put(result.cacheKey ?? cacheKey, wgbBuffer);
          }
          bundle = await WgbLoader.fromBuffer(wgbBuffer);
        } else {
          bundle = await WgbLoader.fromBlob(payload.blob, onCacheProgress);
        }
      }
    } else {
      bundle = await WgbLoader.fromBuffer(payload.data as Uint8Array);
    }

    bootMark("wgb-loaded");

    // Apply a UI-authored manifest override (manifest editor) for cached bundles — a
    // non-destructive layer merged onto the bundle's manifest, so the .wgb is never rewritten.
    if (payload.url) {
      const override = await WgbCache.getManifestOverride(WgbCache.keyForUrl(payload.url));
      if (override) {
        const prevEntrypoint = bundle.manifest.entrypoint;
        deepMergeInto(bundle.manifest as unknown as Record<string, unknown>, override);
        Logger.log(LogCategory.SYSTEM, `WGB: applied manifest override for "${WgbCache.keyForUrl(payload.url)}"`);
        // The entrypoint EXE bytes were resolved from the ORIGINAL manifest before the
        // override merged — if the override changed the entrypoint, re-read the new EXE
        // from the archive so the override actually takes effect (else we silently boot
        // the original entrypoint).
        if (bundle.manifest.entrypoint && bundle.manifest.entrypoint !== prevEntrypoint) {
          bundle.entrypointBytes = await readEntrypointBytes(bundle.archive, bundle.manifest.entrypoint);
          Logger.log(LogCategory.SYSTEM,
            `WGB: entrypoint override "${prevEntrypoint}" -> "${bundle.manifest.entrypoint}" (${bundle.entrypointBytes.length} bytes)`);
        }
      }
    }

    // Resolve the per-game container key (WGB v2 gameId, namespaced) and open this game's writable
    // overlay (bottleship/games/<containerDir>/overlay/). On a game switch the previous overlay is
    // closed and re-rooted so game B never sees game A's files (#5 isolation). Registry persistence
    // (below) keys by this same gameId.
    const gameId = resolveGameId(bundle.manifest);
    Logger.log(LogCategory.SYSTEM, `WGB: gameId="${gameId}" container="${gameIdToContainerDir(gameId)}"`);
    // Host overlay/title: surface the manifest display name as soon as we know it
    // (covers ?game=dev&load=… where the shell would otherwise keep saying "Dev").
    postBundleMeta(bundle.manifest, gameId);
    await system.fileSystem.initOverlay(gameId);
    await system.fileSystem.ensureOverlayIndex();
    // Filled after manifest config is applied; AOT versioning depends on CPU flags.
    let aotPrepared: Promise<{ loaded: number; key: string } | { error: string; key?: string }> | null = null;
    // Install the per-game persist/ephemeral policy (#12): ephemeral writes stay in memory, never OPFS.
    system.fileSystem.setPathPolicy(new PathPolicy({
        ephemeral: bundle.manifest.emulator?.ephemeral,
        persistOnly: bundle.manifest.emulator?.persistOnly,
        persist: bundle.manifest.emulator?.persist,
    }));
    bootMark("overlay-init-done");

    const romRoot = bundle.manifest.rom ?? "assets";
    const romIndex = buildRomIndex(bundle.archive, romRoot);
    system.fileSystem.mountRom(bundle.archive, romRoot, romIndex);
    // Always set the CD redirect (null clears a prior game's redirect — no cross-game leak).
    const cdPath = bundle.manifest.emulator?.cdPath ?? null;
    system.fileSystem.setCdRedirect(cdPath);
    if (cdPath) Logger.log(LogCategory.SYSTEM, `VFS: CD-ROM drive (D:) redirected to "${cdPath}"`);
    bootMark("rom-mounted");

    // Make the config/text file class sync-readable before the CPU runs: games
    // read these via GetPrivateProfileString / msvcrt fgetc, which can't await a
    // CachedSource fault-in (see VirtualFileSystem.romPinned). E.g. Morrowind
    // aborts with "Font 0 not found in Morrowind.ini" if its INI reads as empty.
    {
        const configExts = new Set(['ini', 'cfg', 'conf', 'txt', 'cnt', 'inf', 'reg', 'lst']);
        const configRels: string[] = [];
        for (const [rel, entry] of romIndex) {
            if (entry.isDirectory) continue;
            const ext = rel.split('.').pop()?.toLowerCase() ?? '';
            if (configExts.has(ext)) configRels.push(rel);
        }
        if (configRels.length > 0) {
            await system.fileSystem.pinRomFiles(configRels, 8);
        }
    }

    // Phase 1: parallel prefetch of DLLs, EXEs, and small files before loadPeData.
    // This converts serial per-DLL range requests into a parallel burst so the CPU
    // isn't stalled waiting for each import DLL to arrive.
    {
        const criticalExts = new Set(['dll', 'exe', 'drv', 'ocx', 'vxd']);
        const criticalRels: string[] = [];
        const seen = new Set<string>();

        for (const [rel, entry] of romIndex) {
            if (entry.isDirectory) continue;
            const ext = rel.split('.').pop()?.toLowerCase() ?? '';
            if (criticalExts.has(ext) || entry.uncompressedSize < 256 * 1024) {
                if (!seen.has(rel)) { seen.add(rel); criticalRels.push(rel); }
            }
        }

        // Add manifest prefetch hints (simple glob support)
        if (bundle.manifest.emulator?.prefetch) {
            for (const pattern of bundle.manifest.emulator.prefetch) {
                const re = new RegExp(
                    '^' + pattern.toLowerCase()
                        .replace(/\./g, '\\.')
                        .replace(/\*\*/g, '.*')
                        .replace(/\*/g, '[^/]*') + '$'
                );
                for (const rel of romIndex.keys()) {
                    if (re.test(rel) && !seen.has(rel)) {
                        seen.add(rel);
                        criticalRels.push(rel);
                    }
                }
            }
        }

        Logger.log(LogCategory.SYSTEM, `WGB: phase1 prefetch starting — ${criticalRels.length} files`);
        const t1 = performance.now();

        // Report prefetch progress to the host loading UI as a determinate bar.
        // Throttle by integer percent so we don't spill a postMessage per file.
        let lastPct = -1;
        const onPrefetchProgress = (processed: number, total: number) => {
            if (total === 0) return;
            const percent = Math.round((processed / total) * 100);
            if (percent === lastPct) return;
            lastPct = percent;
            self.postMessage({
                type: "loading_progress",
                phase: "prefetch",
                percent,
                label: `${processed} / ${total} files`,
            });
        };
        self.postMessage({
            type: "loading_progress",
            phase: "prefetch",
            percent: 0,
            label: `0 / ${criticalRels.length} files`,
        });

        // 3-second timeout — don't block startup on slow connections.
        _prefetchController?.abort();
        const phase1Controller = new AbortController();
        _prefetchController = phase1Controller;
        let phase1Timeout: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                system.fileSystem.prefetchRomFiles(criticalRels, 8, onPrefetchProgress, phase1Controller.signal),
                new Promise<void>(r => {
                    phase1Timeout = setTimeout(() => {
                        phase1Controller.abort();
                        r();
                    }, 3000);
                }),
            ]);
        } finally {
            if (phase1Timeout !== null) clearTimeout(phase1Timeout);
            if (_prefetchController === phase1Controller) _prefetchController = null;
        }

        Logger.log(LogCategory.SYSTEM, `WGB: phase1 done in ${(performance.now() - t1) | 0}ms`);
    }
    bootMark("prefetch-done");

    if (!EmulatorConfig.getInstance().skipVideo) {
        void videoEngine.ensureLoaded().then(() => {
            Logger.log(LogCategory.SYSTEM, "[VideoEngine] preloaded at boot");
        }).catch((e) => {
            Logger.warn(LogCategory.SYSTEM, `[VideoEngine] boot preload failed: ${e}`);
        });
    }

    // Registry persistence keys by the same namespaced gameId resolved above (container-scoped).
    system.registry.setGameId(gameId);

    // Baseline Windows compatibility keys expected by legacy installers/launchers.
    // Keep this before game-specific restore/seed so persisted values can override it.
    system.registry.seed({
      root: "HKLM",
      path: "Software\\Microsoft\\DirectX",
      values: [
        { name: "Version", type: "REG_SZ", data: "4.09.00.0904" }, // DirectX 9.0c (advertise the max we implement: ddraw/d3d7/d3d8/d3d9)
      ],
    });

    // Win9x OS-provided HKEY_DYN_DATA\PerfStats live-performance namespace. Real Win9x
    // exposes performance counters here (StartStat begins collection, StatData returns the
    // live value, StopStat ends it). Wine only provides the key namespace (no live data),
    // and games that poll it (NFS-PU reads HKEY_DYN_DATA\PerfStats\StatData every frame on
    // the car-select load transition) hang when the key can't even be opened. Seed the keys
    // so RegOpenKeyEx succeeds; queries under PerfStats are synthesized in advapi32
    // (simplified-faithful HLE of the Win9x perf mechanism — generic, not per-game).
    for (const k of ["PerfStats", "PerfStats\\StartStat", "PerfStats\\StopStat", "PerfStats\\StatData"]) {
      system.registry.seed({ root: "HKDD", path: k, values: [] });
    }

    // Apply the manifest registry seed (bundle DEFAULTS) BEFORE restoring persisted
    // state. seed() overwrites and restore() overwrites — "last write wins" — so the
    // persisted (game-written) values like screen resolution must be restored LAST,
    // otherwise the bundle's registry.json clobbers them back to defaults every boot.
    if (bundle.registry) {
      system.registry.seed(bundle.registry as any);
    }

    // Restore persisted (game-written) registry LAST so it overrides the bundle defaults.
    const persistedState = await RegistryPersistence.load(gameId);
    if (persistedState) {
      system.registry.restore(persistedState);
      Logger.log(LogCategory.SYSTEM, `Restored persisted registry for game "${gameId}"`);
    }

    // Setup auto-save on registry changes (debounced, cancelled on game switch).
    installRegistryAutosave(gameId);

    // Apply emulator configuration from manifest (fresh per-bundle to avoid stale cross-game overrides)
    const emulatorConfig = EmulatorConfig.getInstance();
    emulatorConfig.reset();
    emulatorConfig.applyFromManifest(bundle.manifest);
    // The AOT cache key includes manifest-controlled CPU flags such as relaxed FPU,
    // so prepare only after the current bundle config has been applied.
    aotPrepared = (globalThis as Record<string, unknown>).__aotAutoLoad
      ? aotCache.prepare(gameId).catch((e) => ({ error: String(e) }))
      : null;

    // Delete crash-sentinel and other stale files from CoW overlay before game starts
    if (emulatorConfig.deleteOnBoot.length > 0) {
      for (const filePath of emulatorConfig.deleteOnBoot) {
        const deleted = await system.fileSystem.deleteFile(filePath);
        Logger.log(
          LogCategory.SYSTEM,
          `deleteOnBoot: "${filePath}" ${deleted ? "deleted" : "not found (OK)"}`
        );
      }
    }

    // Always resize host canvas from config (ddraw may not be loaded yet → updateDisplayFromConfig no-op)
    await applyManifestWriteFiles();

    // Generic UE1 first-run: detect engine + pin D3D render device in Default.ini.
    // After writeFiles so a manifest-shipped Default.ini override is the one we pin.
    await applyUe1FirstRunSetup(bundle.manifest.entrypoint);

    // The boot publisher of the emulated display mode: until a game mode-sets, the bundle's
    // declared resolution IS the desktop, and every SM_CXSCREEN/EnumDisplaySettings reader
    // needs it. Without modeSet here emulatedDisplayMode stays null for the whole session.
    const { width, height, bpp } = emulatorConfig.screenResolution;
    System.getInstance().requestHostResize(width, height, { modeSet: true, bpp });

    // Update DDraw context display when module exists (e.g. preloaded)
    const ddraw = system.process?.getModule("ddraw") as { updateDisplayFromConfig?: () => void } | undefined;
    if (ddraw?.updateDisplayFromConfig) {
      ddraw.updateDisplayFromConfig();
    }

    // Warn if RAM override is specified but v86 is already initialized
    if (bundle.manifest.emulator?.memory?.ram !== undefined && system.process) {
      Logger.warn(
        LogCategory.SYSTEM,
        `EmulatorConfig: RAM override specified in manifest (${(bundle.manifest.emulator.memory.ram / 1024 / 1024).toFixed(0)} MB) but v86 is already initialized. RAM can only be set at v86 initialization time.`
      );
    }

    // Extract executable name and full VFS path from entrypoint
    // e.g., entrypoint="rom/game/REVOLT.EXE", romRoot="rom" -> VFS path="C:\game\REVOLT.EXE"
    const entrypointPath = bundle.manifest.entrypoint;
    const exeName = entrypointPath.split(/[\\/]/).pop() ?? "app.exe";

    // Calculate VFS path by stripping romRoot prefix from entrypoint
    const normalizedEntrypoint = entrypointPath.replace(/\//g, '\\');
    const normalizedRomRoot = romRoot.replace(/\//g, '\\');
    let vfsRelPath = normalizedEntrypoint;
    if (vfsRelPath.toLowerCase().startsWith(normalizedRomRoot.toLowerCase() + '\\')) {
      vfsRelPath = vfsRelPath.slice(normalizedRomRoot.length + 1);
    } else if (vfsRelPath.toLowerCase().startsWith(normalizedRomRoot.toLowerCase())) {
      vfsRelPath = vfsRelPath.slice(normalizedRomRoot.length);
      if (vfsRelPath.startsWith('\\')) vfsRelPath = vfsRelPath.slice(1);
    }
    const executablePath = `C:\\${vfsRelPath}`;

    // Re-installed per boot: system.reset() clears it, and a re-exec'd process must still
    // be able to re-exec again (the front-end can be reached a second time).
    system.onReExecRequest = requestSelfReExec;
    system.executableName = exeName;
    system.executablePath = executablePath;
    // A self re-exec supplies the command line the LAUNCHER chose; it outranks the
    // manifest's boot args for exactly one boot, then the manifest applies again.
    system.executableArgs = pendingReExecArgs ?? bundle.manifest.args ?? "";
    pendingReExecArgs = null;
    const lastSlashIdx = executablePath.lastIndexOf("\\");
    const executableDir = lastSlashIdx > 2 ? executablePath.slice(0, lastSlashIdx + 1) : "C:\\";
    system.fileSystem.setCurrentDirectory(executableDir);
    Logger.log(LogCategory.SYSTEM, `Executable: name="${exeName}", path="${executablePath}", args="${system.executableArgs}"`);

    await loadPeData(bundle.entrypointBytes, true);
    bootMark("pe-loaded");

    // AOT units must be transaction-committed BEFORE the JIT claims their pages
    // refuses a page the live JIT already owns (rc 2), and that is the whole ordering problem
    // of the track. This is the earliest point where the image is in memory. Registration is
    // gated on the per-page SHA-256, so a page that gets patched after this (hle-lib) simply
    // fails the check and keeps the ordinary JIT path. Opt-in until measured.
    //
    // loadPeData has just called resumeEmulator(), and publishing awaits — so without the
    // pause the 1 ms scheduler tick runs the guest through every await and the JIT takes
    // pages out from under us (that is where the rc-2 refusals came from). v86.run() only
    // schedules, so nothing has executed yet at this point in the microtask.
    if (aotPrepared) {
      try {
        const t0 = performance.now();
        pauseEmulator();
        const loaded = await aotPrepared;
        const replayed = "loaded" in loaded && loaded.loaded > 0 ? await aotCache.replay() : null;
        const ms = (performance.now() - t0) | 0;
        // Also parked where a probe can read it: this line is emitted during the load
        // firehose and streaming does not reliably survive the reload that precedes it.
        (globalThis as Record<string, unknown>).__aotBoot = { loaded, replayed, ms };
        Logger.log(LogCategory.SYSTEM, `[AOT] boot: ${JSON.stringify(loaded)} ${JSON.stringify(replayed)} in ${ms}ms`);
      } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `[AOT] boot load failed (falling back to JIT): ${e}`);
      } finally {
        resumeEmulator();
      }
    }

    // Signal host that loading is done and the game is starting
    self.postMessage({ type: "loading_progress", phase: "done", percent: 100, label: "" });
    // Arm the first-present hook HERE (not at load start): the host has just switched
    // the overlay to "booting", and the guest's first real composite happens strictly
    // after this point. This makes first_present arrive AFTER "done" so the one-shot
    // crossfade-out can't be clobbered, and stops stale pre-"done" presents (previous
    // game's still-dirty GDI overlay) from firing it prematurely. See RenderService.
    system.services?.render?.armFirstPresent?.();
    // Open the boot-status window: from here until first_present, guest file opens
    // are surfaced to the loading overlay as "loading <asset>" sub-status lines.
    setBootOverlayActive(true);
    dumpBootTimeline();

    // Phase 2: progressive background prefetch of remaining ROM assets.
    // Yields the event loop between each file so game I/O stays responsive.
    _prefetchController = new AbortController();
    system.fileSystem.startProgressivePrefetch(_prefetchController.signal);
    gameSessionActive = true;
  } catch (err) {
    const error = err as Error;
    Logger.error(LogCategory.SYSTEM, `Bundle load failed: ${error.message} (${error.name})\n${error.stack}`);
    self.postMessage({ type: "error", message: "bundle load failed: " + error.message });
  }
};

const loadBundle = (payload: { data?: Uint8Array; url?: string; blob?: Blob; blobs?: File[]; preload?: boolean }) => {
  lastBundlePayload = payload;
  loadBundleChain = loadBundleChain
    .then(() => loadBundleImpl(payload))
    .catch(err => Logger.error(LogCategory.SYSTEM, `load_bundle failed: ${err}`));
  return loadBundleChain;
};

/**
 * Restart the guest with a new command line — the single-process realization of a
 * launcher re-execing its own image (System.isSelfImage / requestReExec).
 *
 * Replays the payload that booted this game, so the same bundle is remounted and the OPFS
 * overlay (saves, configs) carries across exactly as it does for a real relaunch.
 *
 * Deferred to a MACROTASK, never started inline. The request arrives from inside the
 * ShellExecute/CreateProcess thunk, and the teardown stops the very v86 instance that is
 * mid-call: the scheduler then tries to save a main thread whose state is unsaveable and
 * kills the process (fatal guard 0x4100). A host `load_bundle` message is itself a
 * macrotask, so this is the same proven entry the normal path uses — by then the thunk has
 * returned its SE_ERR_/PROCESS_INFORMATION value and the guest is at a clean boundary.
 */
const requestSelfReExec = (commandLine: string): boolean => {
  // Returns whether the re-exec was ACCEPTED. A launcher that exits believing it started a
  // child, when nothing was scheduled, is a silent vanish — shell32 reports our verdict.
  if (!lastBundlePayload) {
    Logger.warn(LogCategory.SYSTEM, `[ReExec] ignored "${commandLine}" — no bundle payload to replay`);
    return false;
  }
  if (pendingReExecArgs !== null) return false; // already scheduled; a launcher may ask twice
  pendingReExecArgs = commandLine;
  const payload = lastBundlePayload;

  // Ask the HOST to restart us by reloading the page. A re-exec has to land in a pristine
  // process, and an in-worker teardown+reload is not that: the relaunched image boots into
  // the heavy path (level load, DDraw device, tens of thousands of surfaces) over a worker
  // that just hosted a full game, and wedges before its first present — while the very same
  // command line on a cold boot runs. The host replies by reloading, which is the cold boot.
  if (payload?.url) {
    Logger.log(LogCategory.SYSTEM, `[ReExec] requesting host page-reload restart, args "${commandLine}"`);
    self.postMessage({ type: "reexec", args: commandLine, url: payload.url });
    return true;
  }

  // No URL to replay (a bundle handed over as a Blob by "Load File…") — a page reload could
  // not find it again, so fall back to the in-worker restart. Deferred to a macrotask: the
  // request comes from inside the ShellExecute/CreateProcess thunk, and tearing down the v86
  // that is mid-call makes the scheduler kill an unsaveable main thread (fatal guard 0x4100).
  Logger.log(LogCategory.SYSTEM,
    `[ReExec] no replayable URL — in-worker restart with args "${commandLine}"`);
  setTimeout(() => loadBundle(payload!), 0);
  return true;
};

const initV86 = async (canvas: OffscreenCanvas) => {
  // Arm the HLE gate for THIS emulator instance before anything can await it.
  resetHleReady();
  // Try to apply RAM configuration from pending bundle if available
  let ramSize = EMU_MEMORY_SIZE;
  if (pendingBundle) {
    try {
      let bundle;
      if (pendingBundle.url) {
        bundle = await WgbLoader.fromUrl(pendingBundle.url);
      } else if (pendingBundle.blob) {
        bundle = await WgbLoader.fromBlob(pendingBundle.blob, (done, total) => {
          const doneMb = (done / 1024 / 1024).toFixed(0);
          const totalMb = (total / 1024 / 1024).toFixed(0);
          const percent = total > 0 ? Math.round(done / total * 100) : 0;
          self.postMessage({ type: "loading_progress", phase: "caching", percent, label: `${doneMb} / ${totalMb} MB` });
        });
      } else {
        bundle = await WgbLoader.fromBuffer(pendingBundle.data as Uint8Array);
      }

      // Apply emulator configuration from manifest for RAM (and reset stale prior-game overrides)
      const emulatorConfig = EmulatorConfig.getInstance();
      emulatorConfig.reset();
      emulatorConfig.applyFromManifest(bundle.manifest);
      postBundleMeta(bundle.manifest, resolveGameId(bundle.manifest));
      if (bundle.manifest.emulator?.memory?.ram !== undefined) {
        ramSize = emulatorConfig.memory.ram;
        Logger.log(
          LogCategory.SYSTEM,
          `EmulatorConfig: RAM from manifest applied at v86 initialization: ${(ramSize / 1024 / 1024).toFixed(0)} MB`
        );
      }
    } catch (err) {
      // If manifest parsing fails, use default RAM
      Logger.warn(LogCategory.SYSTEM, `EmulatorConfig: Failed to parse manifest for RAM config, using default`);
    }
  }

  // Streaming instantiation of the core module so V8's implicit wasm code cache can engage
  // across cold starts (it is keyed by URL and only fires for the *Streaming entry points —
  // v86's own loader uses the buffer form and therefore always recompiles). Falls back to the
  // buffered path by itself, so this can never be load-bearing for correctness.
  const wasmPath = import.meta.env?.DEV ? `/v86.wasm?t=${Date.now()}` : "/v86.wasm";
  const wasmLoader = createStreamingWasmLoader(wasmPath);

  // v86 settings
  const settings = {
    canvas: canvas,
    wasm_fn: wasmLoader.wasmFn,
    // DEV cache-bust: the worker's wasm fetch is NOT covered by a hard-reload's cache bypass,
    // so a rebuilt /v86.wasm would otherwise keep loading from the browser cache. Unique URL per
    // worker load forces a fresh fetch in dev. (Prod keeps the stable URL for HTTP caching.)
    // Kept for the fallback inside v86 (and any path that re-reads it); the actual fetch is
    // performed by wasm_fn above.
    wasm_path: wasmPath,
    memory_size: ramSize,
    vga_memory_size: EMU_VGA_MEMORY_SIZE,
    bios: { url: "/bios/seabios.bin" },
    vga_bios: { url: "/bios/vgabios.bin" },
    autostart: false,
    log_level: 0, // Disable v86 debug logging for performance
  };

  try {
    const v86 = new V86(settings);
    const thunkGenerator = new ThunkGenerator();

    // v86 sets `wasm_source` itself only on its own loading path; with a custom wasm_fn it
    // stays undefined. Restore it so the zstd helper-worker path keeps working.
    wasmLoader.sourceBytes.then(bytes => { if (bytes) (v86 as unknown as { wasm_source?: ArrayBuffer }).wasm_source = bytes; });

    v86.add_listener("emulator-ready", async () => {
      bootMark("v86-emulator-ready");
      const apiRegistry = APIRegistry.getInstance();

      // Create the Process environment
      const process = new Process(
        () => v86.mem8 || (v86.v86 && v86.v86.cpu.mem8),
        v86,
        thunkGenerator,
        apiRegistry
      );
      process.canvas = canvas;

      // Initialize System singleton
      const system = System.getInstance();
      system.initialize(process);

      // Static Library HLE manager — wire before PE load so on-load hooks work.
      libHleManager.initialize({
        dispatcher: process.dispatcher,
        thunkGenerator,
        getCpu: () => v86?.cpu || v86?.v86?.cpu,
        getMemory: () => v86.mem8 || (v86.v86 && v86.v86.cpu.mem8) || null,
      });

      // Universal hot-spot hook framework (module:rva SIMD hooks) — same wiring.
      hookRegistry.initialize({
        dispatcher: process.dispatcher,
        thunkGenerator,
        getMemory: () => v86.mem8 || (v86.v86 && v86.v86.cpu.mem8) || null,
      });

      // Set VFS on PELoader for real DLL loading from bundles
      process.loader.setVfs(system.fileSystem);

      //Logger.setLevel(LogLevel.VERBOSE);
      // DEBUG: Enable verbose thunk logging to see all API calls including Lock/Unlock
      // Logger.setCategoryLevel(LogCategory.THUNK, LogLevel.VERBOSE);

      // Initialize memory watch system for debugging texture loading
      const mem8 = v86.mem8 || (v86.v86 && v86.v86.cpu.mem8);
      if (mem8) {
        memoryWatch.init(mem8);
        // Optional: start periodic polling (every 500ms) to detect changes
        // memoryWatch.startPolling(500);
      }

      system.gdiContext.setCanvas(canvas);
      system.setHostResizeCallback((width, height) => {
        // Resize worker-side canvas + overlay immediately
        // (host may not send "resize" back, e.g. non-guest coordinate mode)
        const prevW = state.canvas?.width ?? 0;
        const prevH = state.canvas?.height ?? 0;
        if (state.canvas && (state.canvas.width !== width || state.canvas.height !== height)) {
          // Note: Setting canvas.width/height to the SAME value still resets the OffscreenCanvas
          // and invalidates the WebGPU context. Only resize if dimensions actually change.
          state.canvas.width = width;
          state.canvas.height = height;
          // Reconfigure WebGPU context — canvas resize unconfigures it
          const backend = system.services.render.getBackend();
          if (backend?.kind === "webgpu") {
            (backend as WebGPUBackend).reconfigure();
          }
        }
        state.width = width;
        state.height = height;
        system.gdiContext.resizeOverlay(width, height);
        Logger.log(LogCategory.SYSTEM, `hostResize: ${prevW}x${prevH} -> ${width}x${height} (canvas=${!!state.canvas})`);
        // Notify host to resize CSS element
        self.postMessage({ type: "app_resize", width, height });
      });
      system.setHostCursorVisibilityCallback((visible) => {
        self.postMessage({ type: "cursor_visibility", visible });
      });
      system.setHostCursorImageCallback((image) => {
        if (image) {
          // Copy the pixels — the user object keeps owning its buffer.
          const pixels = image.pixels.slice().buffer;
          (self as unknown as Worker).postMessage({
            type: "cursor_image",
            width: image.width,
            height: image.height,
            hotspotX: image.hotspotX,
            hotspotY: image.hotspotY,
            pixels,
          }, [pixels]);
        } else {
          self.postMessage({ type: "cursor_image", pixels: null });
        }
      });
      system.setHostCursorPositionCallback((pos) => {
        self.postMessage({ type: "device_cursor_pos", x: pos ? pos.x : null, y: pos ? pos.y : null });
      });
      system.setHostMouseCaptureCallback((capture) => {
        self.postMessage({ type: "mouse_capture", capture });
      });
      system.setHostCursorWarpModeCallback((active) => {
        self.postMessage({ type: "cursor_warp", active });
      });
      system.setHostInputResetCallback(() => {
        self.postMessage({ type: "input_reset" });
      });
      system.setHostWindowTitleCallback((title) => {
        self.postMessage({ type: "window_title", title });
      });

      // Initialize WebGPU backend immediately if possible
      const canWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
      if (canWebGpu) {
        try {
          const backend = new WebGPUBackend();
          await backend.initialize(canvas);
          system.services.render.setBackend(backend);
          system.gdiContext.registerOverlayDirtyNotifier(kickGdiPresentLoop);
          // Tell the host the moment the guest composites its FIRST real frame, so it can
          // tear down the loading screen exactly at the first flip (not at PE-load, which
          // left a black canvas during CRT/DirectX/asset init). One-shot per game load.
          system.services.render.onFirstPresent(() => {
            bootMark("first-present");
            setBootOverlayActive(false);
            self.postMessage({ type: "first_present" });
          });
          // Start GDI presentation loop
          requestAnimationFrame(gdiPresentLoop);
          Logger.log(LogCategory.SYSTEM, "WebGPU backend initialized for compositing");
        } catch (e) {
          Logger.warn(LogCategory.SYSTEM, `Failed to initialize WebGPU backend, falling back to 2D: ${e}`);
        }
      }

      // Create and register modules
      const kernel32 = new Kernel32();
      const ntdll = new Ntdll();
      const user32 = new User32();
      const gdi32 = new GDI32();
      const d3d9 = new D3D9();
      const advapi32 = new Advapi32();
      const dsound = new DSound();
      const winmm = new WinMM();
      const ole32 = new Ole32();
      const oleaut32 = new Oleaut32();
      const ddraw = new DDraw();
      const dinput = new DInput();
      const dplayx = new DPlayX();
      const mss32 = new MSS32();
      const smackw32 = new SmackW32();
      const binkw32 = new BinkW32();
      const quartz = new Quartz();
      const a3d = new A3d();
      const avifil32 = new Avifil32();
      const rpcrt4 = new Rpcrt4();
      const msvfw32 = new Msvfw32();
      const glide2x = new Glide2x();
      const opengl32 = new OpenGL32();
      const glu32 = new Glu32();
      const wsock32 = new Wsock32();
      const shell32 = new Shell32();
      const shlwapi = new Shlwapi();
      const comdlg32 = new Comdlg32();
      const comctl32 = new Comctl32();
      const version = new Version();
      const w32skrnl = new W32skrnl();
      const msvcrt = new Msvcrt();
      const msvcp90 = new Msvcp90();
      const msvcp60 = new Msvcp60();
      const crtdll = new Crtdll();
      const winspool = new Winspool();
      const dwmapi = new Dwmapi();
      const riched32 = new Riched32();
      const wtsapi32 = new Wtsapi32();
      const imm32 = new Imm32();
      const msimg32 = new Msimg32();
      const uxtheme = new Uxtheme();
      const wintrust = new Wintrust();
      const crypt32 = new Crypt32();
      const ws2_32 = new Ws2_32();
      const iphlpapi = new Iphlpapi();
      const tapi32 = new Tapi32();
      const setupapi = new Setupapi();
      const netapi32 = new Netapi32();
      const psapi = new Psapi();
      const imagehlp = new ImageHlp();
      const ifc20 = new IFC20();
      const gdiplus = new GdiPlus();
      const bass = new Bass();
      const galaxy = new Galaxy();
      const d3d8 = new D3D8();
      const d3dx9 = new D3dx9();
      const openal = new OpenAL();
      const alut = new ALUT();
      const wininet = new Wininet();

      // Prewarm stub DLLs ONLY for thunked modules that lack a JS implementation
      (() => {
        const api = APIRegistry.getInstance();
        const tg = process.thunkGenerator as any;
        const mem = System.getInstance().process?.memory;
        const memBytes = process.v86.mem8 || (process.v86.v86 && process.v86.v86.cpu.mem8);
        if (!tg?.generateStubDll || !mem || !memBytes) return;

        // Modules that already have JS implementations (registered below) should NOT be stubbed here
        const implemented = new Set([
          kernel32.name, ntdll.name, user32.name, gdi32.name, d3d9.name, d3dx9.name, advapi32.name,
          dsound.name, winmm.name, ole32.name, ddraw.name, dinput.name,
          dplayx.name, mss32.name, wsock32.name, shell32.name, shlwapi.name, comdlg32.name, comctl32.name,
          dwmapi.name,
          riched32.name,
          wtsapi32.name,
          imm32.name,
          msimg32.name,
          uxtheme.name,
          wintrust.name,
          crypt32.name,
          ws2_32.name,
          psapi.name,
          imagehlp.name,
          iphlpapi.name,
          tapi32.name,
          setupapi.name,
          netapi32.name,
          glu32.name,
          "gdiplus",
          "bass",
          "galaxy",
        ].map(n => n.toLowerCase()));

        // TODO: Re-enable stub DLL prewarming when moduleRegistry is restored
        // for (const mod of api.getModules()) {
        //   const dllName = mod.name.toLowerCase();
        //   if (implemented.has(dllName)) continue;
        //   ...
        // }
      })();

      kernel32.initialize(process);
      ntdll.initialize(process);
      user32.initialize(process);
      gdi32.initialize(process);
      d3d9.initialize(process);
      d3dx9.initialize(process);
      advapi32.initialize(process);
      dsound.initialize(process);
      winmm.initialize(process);
      ole32.initialize(process);
      oleaut32.initialize(process);
      ddraw.initialize(process);
      dinput.initialize(process);
      dplayx.initialize(process);
      mss32.initialize(process);
      if (!EMU_NATIVE_VIDEO_DLLS) {
        smackw32.initialize(process);
        binkw32.initialize(process);
      }
      quartz.initialize(process);
      a3d.initialize(process);
      avifil32.initialize(process);
      rpcrt4.initialize(process);
      msvfw32.initialize(process);
      glide2x.initialize(process);
      opengl32.initialize(process);
      glu32.initialize(process);
      wsock32.initialize(process);
      shell32.initialize(process);
      shlwapi.initialize(process);
      comdlg32.initialize(process);
      comctl32.initialize(process);
      version.initialize(process);
      w32skrnl.initialize(process);
      msvcrt.initialize(process);
      msvcp90.setMsvcrt(msvcrt);
      msvcp90.initialize(process);
      msvcp60.setMsvcrt(msvcrt);
      msvcp60.initialize(process);
      crtdll.initialize(process);
      winspool.initialize(process);
      dwmapi.initialize(process);
      riched32.initialize(process);
      wtsapi32.initialize(process);
      imm32.initialize(process);
      msimg32.initialize(process);
      uxtheme.initialize(process);
      wintrust.initialize(process);
      crypt32.initialize(process);
      ws2_32.initialize(process);
      psapi.initialize(process);
      imagehlp.initialize(process);
      ifc20.initialize(process);
      gdiplus.initialize(process);
      bass.initialize(process);
      galaxy.initialize(process);
      d3d8.initialize(process);
      openal.initialize(process);
      alut.initialize(process);
      wininet.initialize(process);
      tapi32.initialize(process);
      setupapi.initialize(process);
      netapi32.initialize(process);

      process.registerModule(kernel32.name, kernel32);
      process.registerModule(ntdll.name, ntdll);
      process.registerModule(user32.name, user32);
      process.registerModule(gdi32.name, gdi32);
      process.registerModule(d3d9.name, d3d9);
      process.registerModule(d3dx9.name, d3dx9);
      process.registerModule(advapi32.name, advapi32);
      process.registerModule(dsound.name, dsound);
      process.registerModule(winmm.name, winmm);
      process.registerModule(ole32.name, ole32);
      process.registerModule(oleaut32.name, oleaut32);
      process.registerModule(ddraw.name, ddraw);
      process.registerModule(dinput.name, dinput);
      process.registerModule(dplayx.name, dplayx);
      process.registerModule(mss32.name, mss32);
      if (!EMU_NATIVE_VIDEO_DLLS) {
        process.registerModule(smackw32.name, smackw32);
        process.registerModule(binkw32.name, binkw32);
      }
      process.registerModule(quartz.name, quartz);
      process.registerModule(a3d.name, a3d);
      process.registerModule(avifil32.name, avifil32);
      process.registerModule(rpcrt4.name, rpcrt4);
      process.registerModule(msvfw32.name, msvfw32);
      process.registerModule(glide2x.name, glide2x);
      process.registerModule(opengl32.name, opengl32);
      process.registerModule(glu32.name, glu32);
      process.registerModule(wsock32.name, wsock32);
      process.registerModule(shell32.name, shell32);
      process.registerModule(shlwapi.name, shlwapi);
      process.registerModule(comdlg32.name, comdlg32);
      process.registerModule(comctl32.name, comctl32);
      process.registerModule(version.name, version);
      process.registerModule(w32skrnl.name, w32skrnl);
      process.registerModule(msvcrt.name, msvcrt);
      process.registerModule(msvcp90.name, msvcp90);
      process.registerModule(msvcp60.name, msvcp60);
      process.registerModule(crtdll.name, crtdll);
      process.registerModule(winspool.name, winspool);
      process.registerModule(dwmapi.name, dwmapi);
      process.registerModule(riched32.name, riched32);
      process.registerModule(wtsapi32.name, wtsapi32);
      process.registerModule(imm32.name, imm32);
      process.registerModule(msimg32.name, msimg32);
      process.registerModule(uxtheme.name, uxtheme);
      process.registerModule(wintrust.name, wintrust);
      process.registerModule(crypt32.name, crypt32);
      process.registerModule(ws2_32.name, ws2_32);
      process.registerModule(psapi.name, psapi);
      process.registerModule(iphlpapi.name, iphlpapi);
      process.registerModule(tapi32.name, tapi32);
      process.registerModule(setupapi.name, setupapi);
      process.registerModule(netapi32.name, netapi32);
      process.registerModule(imagehlp.name, imagehlp);
      const dbghelp = new DbgHelp(process);
      process.registerModule(dbghelp.name, dbghelp);
      process.registerModule(ifc20.name, ifc20);
      process.registerModule(gdiplus.name, gdiplus);
      process.registerModule(bass.name, bass);
      process.registerModule(galaxy.name, galaxy);
      process.registerModule(d3d8.name, d3d8);
      process.registerModule(openal.name, openal);
      process.registerModule(alut.name, alut);
      process.registerModule(wininet.name, wininet);

      // Register exports with dispatcher
      process.dispatcher.registerModule(kernel32.name, kernel32.exports);
      process.dispatcher.registerModule(ntdll.name, ntdll.exports);
      process.dispatcher.registerModule(user32.name, user32.exports);
      process.dispatcher.registerModule(gdi32.name, gdi32.exports);
      process.dispatcher.registerModule(d3d9.name, d3d9.exports);
      process.dispatcher.registerModule(d3dx9.name, d3dx9.exports);
      process.dispatcher.registerModule(advapi32.name, advapi32.exports);
      process.dispatcher.registerModule(dsound.name, dsound.exports);
      process.dispatcher.registerModule(winmm.name, winmm.exports);
      process.dispatcher.registerModule(ole32.name, ole32.exports);
      process.dispatcher.registerModule(ddraw.name, ddraw.exports);
      process.dispatcher.registerModule(dinput.name, dinput.exports);
      process.dispatcher.registerModule(dplayx.name, dplayx.exports);
      process.dispatcher.registerModule(mss32.name, mss32.exports);
      if (!EMU_NATIVE_VIDEO_DLLS) {
        process.dispatcher.registerModule(smackw32.name, smackw32.exports);
        process.dispatcher.registerModule(binkw32.name, binkw32.exports);
      }
      process.dispatcher.registerModule(quartz.name, quartz.exports);
      process.dispatcher.registerModule(a3d.name, a3d.exports);
      process.dispatcher.registerModule(avifil32.name, avifil32.exports);
      process.dispatcher.registerModule(rpcrt4.name, rpcrt4.exports);
      process.dispatcher.registerModule(msvfw32.name, msvfw32.exports);
      process.dispatcher.registerModule(glide2x.name, glide2x.exports);
      process.dispatcher.registerModule(opengl32.name, opengl32.exports);
      process.dispatcher.registerModule(glu32.name, glu32.exports);
      process.dispatcher.registerModule(wsock32.name, wsock32.exports);
      process.dispatcher.registerModule(shell32.name, shell32.exports);
      process.dispatcher.registerModule(shlwapi.name, shlwapi.exports);
      // shfolder.dll forwarding handled by ThunkDispatcher.DLL_FORWARDS
      process.dispatcher.registerModule(comdlg32.name, comdlg32.exports);
      process.dispatcher.registerModule(comctl32.name, comctl32.exports);
      process.dispatcher.registerModule(version.name, version.exports);
      process.dispatcher.registerModule(w32skrnl.name, w32skrnl.exports);
      process.dispatcher.registerModule(msvcrt.name, msvcrt.exports);
      process.dispatcher.registerModule(msvcp90.name, msvcp90.exports);
      process.dispatcher.registerModule(msvcp60.name, msvcp60.exports);
      process.dispatcher.registerModule(crtdll.name, crtdll.exports);
      process.dispatcher.registerModule(winspool.name, winspool.exports);
      process.dispatcher.registerModule(dwmapi.name, dwmapi.exports);
      process.dispatcher.registerModule(riched32.name, riched32.exports);
      process.dispatcher.registerModule(wtsapi32.name, wtsapi32.exports);
      process.dispatcher.registerModule(imm32.name, imm32.exports);
      process.dispatcher.registerModule(msimg32.name, msimg32.exports);
      process.dispatcher.registerModule(uxtheme.name, uxtheme.exports);
      process.dispatcher.registerModule(wintrust.name, wintrust.exports);
      process.dispatcher.registerModule(crypt32.name, crypt32.exports);
      process.dispatcher.registerModule(ws2_32.name, ws2_32.exports);
      process.dispatcher.registerModule(psapi.name, psapi.exports);
      process.dispatcher.registerModule(iphlpapi.name, iphlpapi.exports);
      process.dispatcher.registerModule(tapi32.name, tapi32.exports);
      process.dispatcher.registerModule(setupapi.name, setupapi.exports);
      process.dispatcher.registerModule(netapi32.name, netapi32.exports);
      process.dispatcher.registerModule(imagehlp.name, imagehlp.exports);
      process.dispatcher.registerModule(dbghelp.name, dbghelp.exports);
      process.dispatcher.registerModule(ifc20.name, ifc20.exports);
      process.dispatcher.registerModule(gdiplus.name, gdiplus.exports);
      process.dispatcher.registerModule(bass.name, bass.exports);
      process.dispatcher.registerModule(galaxy.name, galaxy.exports);
      process.dispatcher.registerModule(d3d8.name, d3d8.exports);
      process.dispatcher.registerModule(openal.name, openal.exports);
      process.dispatcher.registerModule(alut.name, alut.exports);
      process.dispatcher.registerModule(wininet.name, wininet.exports);

      bootMark("modules-registered");

      // Every HLE module is now in the dispatch table — the guest may run.
      markHleReady();

      // Initialize WASM hypercall infrastructure (page + managers).
      // NOTE: dispatch is NOT enabled yet (hc_enabled=0) — all thunks still go through JS.
      {
        const cpu = v86?.cpu || v86?.v86?.cpu;
        if (cpu?.wm?.exports?.get_hypercall_page_ptr) {
          preemptionManager.initialize(cpu);
          hypercallDataManager.initialize(cpu, preemptionManager.getHypercallPageBase());
          // Report the effective FPU mode this bundle booted with (manifest fpuStrict OR a
          // persisted dbg.relaxedFpu(false)) so the dev toolbar "FPU: Strict/Relaxed" button
          // reflects reality instead of its default. Mirrors initialize()'s relaxedEffective.
          const fpuStrictNow = EmulatorConfig.getInstance().fpuStrict === true || !preemptionManager.isRelaxedFpuEnabled();
          self.postMessage({ type: "fpu_strict_state", strict: fpuStrictNow });
        }
        // WASM-resident D3D9 state-mirror + command arena.
        // Dual-run/shadow only by default (see d3d9-wasm-arena.ts's kill switch) — never affects
        // rendering unless explicitly enabled via dbg.d3dWasmPath(true).
        if (cpu?.wm?.exports?.get_d3d9_arena_ptr) {
          d3d9WasmArena.initialize(cpu);
        }
      }
      bootMark("hypercall-init-done");

      // Apply pending registrations after modules are registered (JS impls) and stubs for external DLLs exist
      // (this also registers matching functions with hypercallDataManager)
      process.dispatcher.applyPendingRegistrations();
      prePopulateGetProcAddressCache(process.dispatcher);
      ensureGetProcAddressDynamicExports(process.dispatcher, [
        { dll: "d3d9", name: "Direct3DShaderValidatorCreate9" },
      { dll: "d3d9", name: "DebugSetMute" },
        { dll: "w32skrnl", name: "_ImteFromHModule@4" },
        { dll: "w32skrnl", name: "_BaseAddrFromImte@4" },
        { dll: "kernel32", name: "GetDiskFreeSpaceExA" },
        { dll: "kernel32", name: "GetDiskFreeSpaceExW" },
        ...KERNEL32_VISTA_WARMUP_EXPORTS,
      ]);

      // Register fast path for time and sync functions if Kernel32 exports them
      const k32 = kernel32 as any;
      if (k32.registerFastPathTimeFunctions) {
        k32.registerFastPathTimeFunctions(process.dispatcher);
      }
      if (k32.registerFastPathSyncFunctions) {
        k32.registerFastPathSyncFunctions(process.dispatcher);
      }
      winmm.registerFastPathTimerFunctions(process.dispatcher);
      registerFastPathMessageFunctions(process.dispatcher);
      registerFastPathFileIOFunctions(process.dispatcher);
      registerFastPathLocaleFunctions(process.dispatcher);
      registerFastPathHeapFunctions(process.dispatcher);
      registerFastPathMsvcrtFunctions(process.dispatcher);
      registerFastPathPointerFunctions(process.dispatcher);
      registerFastPathProcessFunctions(process.dispatcher);
      registerFastPathModuleFunctions(process.dispatcher);

      // Tick hooks for time data sync + onTickHook compensation
      if (hypercallDataManager.isInitialized()) {
        const cpu = v86?.cpu || v86?.v86?.cpu;

        // Enable WASM dispatch for all registered handlers
        if (hypercallDataManager.getRegisteredCount() > 0) {
          hypercallDataManager.enable();
          // NOTE: Heap slab deferred — see comment in loadPeData path above
        }

        // Configure PeekMessage starvation limit:
        // Every Nth PeekMessage call falls through to JS for scheduler/callback processing.
        // Input is safe at any limit — postMessage() eagerly sets the shared flag,
        // so real messages always cause an immediate JS fallthrough regardless of counter.
        hypercallDataManager.setPeekMessageStarvationLimit(256);

        // Configure Sleep(0) starvation limit:
        // When peer threads exist, only every 64th Sleep(0) call falls through to JS
        // for actual context switch. Others are WASM no-ops, matching real Windows
        // behavior where Sleep(0) yields the time quantum remainder (often near-zero).
        hypercallDataManager.setSleepStarvationLimit(64);

        // Configure SetEvent starvation limit:
        // Every Nth no-waiter SetEvent falls through to JS for scheduler hooks.
        hypercallDataManager.setEventStarvationLimit(512);

        // Set window offset (0,0 for fullscreen HLE)
        hypercallDataManager.updateWindowData(0, 0);

        const v86Inner = v86?.v86 || v86;

        // v86's do_tick() runs these hooks and ONLY then calls next_tick() to reschedule
        // itself. If a hook THROWS, do_tick skips next_tick() so the run loop dies — but
        // `running`/`is_running()` stay true and no "emulator-stopped" fires. That silent
        // death defeats every restart path (startScheduler only restarts a *stopped* v86,
        // the heartbeat warn is gated on !isRunning) and only the watchdog (which requires
        // is_running===true) notices, 12 s later. Root of a class of "random hang" reports
        // (e.g. Re-Volt: a throw from preemptAtTickBoundary while a sibling thread was mid-
        // exit). Guarding the body keeps the hook returning normally → next_tick() runs →
        // the guest keeps going; a *persistent* throw escalates to the crash funnel so it's
        // visible, not an invisible freeze.
        const tickHookFailStreak: { before: number; after: number } = { before: 0, after: 0 };
        const TICK_HOOK_FAIL_LIMIT = 240; // ~>1 s of solid per-tick failures before declaring it fatal
        const guardTickHook = (label: "before" | "after", body: () => void): void => {
          if (label === "before") tickBeforeCount = (tickBeforeCount + 1) >>> 0; // do_tick liveness
          try {
            body();
            tickHookFailStreak[label] = 0;
          } catch (e) {
            const n = ++tickHookFailStreak[label];
            const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
            if (n <= 3 || n % 60 === 0) {
              Logger.error(LogCategory.SYSTEM,
                `[TICK-HOOK] '${label}' threw (streak=${n}) at eip=0x${eip.toString(16)}: ` +
                `${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
            }
            if (n >= TICK_HOOK_FAIL_LIMIT) {
              tickHookFailStreak[label] = 0;
              try {
                System.getInstance().reportGuestCrash({
                  reason: `Tick hook '${label}' threw on ${n} consecutive ticks (run loop would silently hang)`,
                  eip,
                  threadId: system.scheduler?.getCurrentThreadId?.() ?? null,
                });
              } catch { /* reportGuestCrash also stops v86 */ }
            }
          }
        };

        v86Inner["tick_hooks_before"] = () => guardTickHook("before", () => {
          // If the current guest thread is WAITING (async thunk parked at
          // spinLoopAddress), don't grant a full quantum — v86 would honestly
          // JIT-execute JMP $ for ~5 ms before tick_hooks_after can yield.
          const curThread = system.scheduler.getCurrentThread();
          const urgentExit = !!curThread && curThread.state === ThreadState.WAITING;
          system.scheduler.noteRoundTripTick(urgentExit);
          preemptionManager.prepareForExecution(cpu, urgentExit);
          hypercallDataManager.updateTimeData();
          // Robust unified-clock activation. The one-shot enable() gates in loadPeData
          // (~651) and the v86-init block (~1389) race with stub registration and v86
          // restarts (reset_cpu re-zeroes HYPERCALL_PAGE → hc_enabled=0), so enable() was
          // observed to never fire on some titles (hc_enabled=0, vtActive=false).
          // Re-assert every tick until it sticks — this MUST be active before the guest's
          // one-time RDTSC↔QPC calibration (UE1 Core.dll GSecondsPerCycle), otherwise QPC
          // falls through to the JS wall-clock thunk while RDTSC reads the instruction-
          // interpolated page base; the two diverge within a single calibration batch
          // (ratio ≫ 1) → GSecondsPerCycle tiny → per-frame DeltaTime ≈ 0 → intro
          // splash countdown timers never decrement. enable() short-circuits
          // once isEnabled() is true, so this is cheap.
          if (!hypercallDataManager.isEnabled() &&
              hypercallDataManager.isInitialized() &&
              hypercallDataManager.getRegisteredCount() > 0) {
            hypercallDataManager.enable();
          }
          // Poll input directly from SAB — setInterval(poll, 16) macrotasks can be
          // starved by v86's microtask-chained main loop, causing stale mouse data
          // and missed clicks. Calling poll() here on every tick (~200/sec) ensures
          // mouse position and button state are always fresh.
          system.inputManager.poll();
          const mouseState = system.inputManager.getMouseState();
          hypercallDataManager.updateCursorData(mouseState.x, mouseState.y);
          // Sync message queue flag for WASM PeekMessage fast path
          hypercallDataManager.updateMessageQueueFlag(system.windowManager.hasMessages());
        });
        let heapSlabAllocated = false;
        let ticksSinceStart = 0;
        v86Inner["tick_hooks_after"] = () => guardTickHook("after", () => {
          // JIT-on guest-EIP sampler (opt-in via __eipSamp). Runs between v86 JIT
          // batches (~1ms) so it observes real full-speed behavior with no starvation;
          // streams the cumulative 4KB-page histogram to the main thread (the reliable
          // channel) so a busy/exited worker never blocks readout.
          if ((globalThis as any).__eipSampOn) {
            const s: any = ((globalThis as any).__eipSamp ??= { hist: {}, n: 0 });
            const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
            const page = eip & ~0xfff;
            const tid = (system.scheduler as any).currentThreadId ?? -1;
            const key = `t${tid}@${(page >>> 0).toString(16)}`;
            s.hist[key] = (s.hist[key] ?? 0) + 1;
            s.n++;
            // postMessage every tick (run is short / few ticks); hist is small.
            try { (self as any).postMessage({ type: "__eipHist", n: s.n, hist: s.hist }); } catch { /* */ }
          }
          // Tick-boundary preemptive scheduling: between ticks, CPU is at a clean
          // instruction boundary — no JIT block mid-execution. Direct register writes
          // work reliably without is_jumping. Handles: drain wakes, poll timeouts,
          // process callbacks, and quantum-based thread preemption.
          system.scheduler.preemptAtTickBoundary(cpu);

          // Lazy heap slab allocation: wait until loading pressure subsides (~500 ticks ≈ 2.5s)
          // to avoid stealing memory from MapViewOfFile during game init.
          if (!heapSlabAllocated && ++ticksSinceStart > 500) {
            heapSlabAllocated = true;
            // Slab is DEFAULT-ON (D2 corruption root-caused + fixed; see pe-loader / slab-d2-handoff).
            // __noHeapSlab forces it off (falls back to the JS process.memory + lookaside path).
            if (!(globalThis as any).__noHeapSlab) {
              allocateHeapSlab();
            }
          }
        });

        // Replace yield-Worker with same-thread MessageChannel to eliminate cross-Worker
        // postMessage overhead (~14% CPU for Re-Volt at 1000 ticks/sec).
        // MessageChannel creates macrotasks (not microtasks) — rAF/setInterval work correctly.
        if (typeof v86Inner["register_yield_direct"] === "function") {
          v86Inner["register_yield_direct"]();
          Logger.log(LogCategory.SYSTEM, "[HYPERCALL] yield-Worker replaced with MessageChannel");
        }

        Logger.log(LogCategory.SYSTEM,
          `[HYPERCALL] Infrastructure initialized. ` +
          `hpBase=0x${preemptionManager.getHypercallPageBase().toString(16)}`);
      }

      // Pass backend to DDraw module if it exists
      if (canWebGpu && (system.services.render.getBackend()?.kind === "webgpu")) {
        const backend = system.services.render.getBackend() as WebGPUBackend;
        const ddraw = process.getModule("ddraw") as DDraw | undefined;
        if (ddraw && typeof ddraw.setBackend === "function") {
          ddraw.setBackend(backend);
        }
        const glide2x = process.getModule("glide2x") as Glide2x | undefined;
        if (glide2x && typeof glide2x.setBackend === "function") {
          glide2x.setBackend(backend);
        }
        const opengl32 = process.getModule("opengl32") as OpenGL32 | undefined;
        if (opengl32 && typeof opengl32.setBackend === "function") {
          opengl32.setBackend(backend);
        }
      }

      // Connect input if buffer is available
      if (state.inputBuffer) {
        Logger.log(LogCategory.SYSTEM, "Connecting input buffer");
        system.connectInput(state.inputBuffer);
      } else {
        Logger.warn(LogCategory.SYSTEM, "No input buffer available!");
      }

      // Clear verbose logs from IndexedDB on startup
      Logger.clearVerboseIndexedDb().catch((err) => {
        Logger.warn(LogCategory.SYSTEM, `Failed to clear verbose logs on startup: ${err}`);
      });

      bootMark("emulator-ready-sent");
      self.postMessage({ type: "ready" });

      // Dev-mode only: load debug-config.json if present and enabled
      if (import.meta.env.DEV) {
        fetch('/debug-config.json')
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
          .then((cfg) => {
            if (cfg?.enabled) {
              const mem8 = v86.mem8 || (v86.v86 && v86.v86.cpu.mem8);
              if (mem8) {
                debugSession.setMemoryGetter(() =>
                  v86.mem8 || (v86.v86 && v86.v86.cpu.mem8) || null
                );
              }
              debugSession.start(cfg);
              Logger.log(LogCategory.SYSTEM, `[DebugSession] Auto-started from debug-config.json (preset=${cfg.preset ?? "custom"})`);
            }
          });
      }

      // Start heartbeat diagnostics
      startHeartbeat(v86);

      // Start aggressive scheduler for preemptive multitasking
      startScheduler(v86);

      // Start registry access log flush
      startRegistryFlush();

      if (pendingPeData) {
        const buffered = pendingPeData;
        pendingPeData = null;
        loadPeData(buffered);
      }
      if (pendingBundle) {
        const buffered = pendingBundle;
        pendingBundle = null;
        loadBundle(buffered);
      }
    });

  } catch (err) {
    Logger.error(LogCategory.SYSTEM, `Failed to init v86: ${err}`);
    self.postMessage({ type: "error", message: "v86 init failed: " + (err as Error).message });
  }
};

/**
 * Canonical pause/resume — the ONLY correct way to stop/start the guest loop.
 * Setting the module-level `isPaused` is load-bearing: the 1ms startScheduler
 * interval re-runs v86 whenever `!isPaused` and there's runnable work, so a bare
 * v86.stop() is undone within ~1ms. The harness (tickFrames park, pause/resume,
 * breakpoint hits) routes through these via globalThis so a park/break actually holds.
 */
function pauseEmulator(): void {
  const system = System.getInstance();
  if (!system.process?.v86) return;
  isPaused = true;
  system.isPaused = true;
  if (gdiPresentRafId !== null) { cancelAnimationFrame(gdiPresentRafId); gdiPresentRafId = null; }
  system.windowManager.wakeWaiters();
  const v86 = system.process.v86;
  if (v86.is_running?.() ?? false) {
    v86.stop().then(() => Logger.log(LogCategory.SYSTEM, "[PAUSE] Emulator paused"))
      .catch((err: unknown) => Logger.error(LogCategory.SYSTEM, `[PAUSE] Error pausing emulator: ${err}`));
  }
}
function resumeEmulator(): void {
  const system = System.getInstance();
  if (!system.process?.v86) return;
  isPaused = false;
  system.isPaused = false;
  if (gdiPresentRafId === null) gdiPresentRafId = requestAnimationFrame(gdiPresentLoop);
  TimeService.getInstance().notifyPauseResume();
  hypercallDataManager.resetInsnBaseline();
  const v86 = system.process.v86;
  if (!(v86.is_running?.() ?? false)) { v86.run(); Logger.log(LogCategory.SYSTEM, "[RESUME] Emulator resumed"); }
}
// Harness hooks (cmds/time.ts park, cmds/breakpoints.ts pause/resume, eip-breaks).
(globalThis as any).__harnessPause = pauseEmulator;
(globalThis as any).__harnessResume = resumeEmulator;

self.onmessage = (event: MessageEvent) => {
  const message = event.data;

  if (message?.type === "dbg") {
    // Guest debugger bridge: window.dbg.<cmd>(...args) on the page -> here.
    handleDbgCommand(message.cmd, message.args);
    return;
  }

  if (message?.type === "set_debug_flag") {
    // Persisted debug toggles seeded from the host (localStorage) BEFORE a game loads —
    // e.g. __noHeapSlab to A/B the WASM heap slab. Survives page F5 because the host
    // replays it on every worker init. Must arrive before load_bundle (PE-load reads it).
    if (typeof message.key === "string") (globalThis as any)[message.key] = message.value;
    return;
  }

  if (message?.type === "set_boot_args") {
    // The command line a self re-exec chose, replayed by the host after the page reload it
    // performed on our behalf. Must arrive BEFORE load_bundle — loadBundleImpl consumes it
    // in place of the manifest's `args` for exactly one boot.
    pendingReExecArgs = typeof message.args === "string" ? message.args : null;
    Logger.log(LogCategory.SYSTEM, `[ReExec] boot args from host: "${pendingReExecArgs ?? ""}"`);
    return;
  }

  if (message?.type === "set_session") {
    // This tab's harness session (?bs=<name>) — see src/harness/session.ts. Only used to
    // report the real on-disk path of the dumps we emit; the host does the writing.
    (globalThis as any).__bsSession = typeof message.session === "string" ? message.session : "";
    return;
  }

  if (message?.type === HARNESS_RPC) {
    // AI-agent harness RPC: {id,cmd,args} -> {id,ok,result|error}. All logic
    // lives in src/worker/harness/ (one-line route, no inline logic).
    void harnessService.dispatch(message);
    return;
  }
  if (message?.type === HARNESS_CANCEL) {
    harnessService.cancel(message.id);
    return;
  }

  if (message?.type === "peek_mem") {
    // Diagnostic: read raw guest memory from the canonical process buffer back to
    // the page (worker console is invisible to the page). Reads up to 4096 bytes.
    const { addr, len = 256, id } = message;
    try {
      const mem = System.getInstance().process?.getCurrentMemory?.();
      if (!mem) { self.postMessage({ type: "peek_mem", ok: false, id, error: "no memory" }); return; }
      const a = (addr >>> 0);
      const n = Math.max(0, Math.min(4096, len | 0));
      if (a < 0 || a + n > mem.length) {
        self.postMessage({ type: "peek_mem", ok: false, id, error: `oob (a=0x${a.toString(16)} len=${n} memLen=0x${mem.length.toString(16)})`, memLen: mem.length });
        return;
      }
      const bytes = Array.from(mem.subarray(a, a + n));
      let nonZero = 0; for (const b of bytes) if (b !== 0) nonZero++;
      self.postMessage({ type: "peek_mem", ok: true, id, addr: a, len: n, nonZero, bytes });
    } catch (e) {
      self.postMessage({ type: "peek_mem", ok: false, id, error: String(e) });
    }
    return;
  }

  if (message?.type === "__eipSampleOn") {
    // JIT-on guest-EIP sampler toggle (diagnostic): streams a per-tick EIP page
    // histogram to the main thread via {type:'__eipHist'}. Set from the same realm
    // as tick_hooks_after so the flag is visible there.
    (globalThis as any).__eipSampOn = !!message.on;
    (globalThis as any).__eipSamp = { hist: {}, n: 0 };
    return;
  }

  if (message?.type === "set_present_mode") {
    // Display pacing policy from the Settings UI: off | vsync | smooth | blend.
    // setPresentMode is registered on globalThis by diagnostics-commands. The host re-sends
    // this after each game load (present mode resets with the presenter), so it may arrive
    // before the ddraw presenter exists — setPresentMode no-ops/warns gracefully in that case.
    const mode = String(message.mode || "off");
    (globalThis as any).setPresentMode?.(mode);
    return;
  }

  if (message?.type === "set_quality") {
    // Graphics quality settings from the Settings UI / dbg.quality(). Validated + merged
    // onto the live config; the present chain + samplers read it on the next frame.
    const q = EmulatorConfig.getInstance().applyQuality(message.quality);
    Logger.log(LogCategory.SYSTEM,
      `[QUALITY] applied (aniso=${q.anisotropy} bright=${q.brightness} contrast=${q.contrast} sat=${q.saturation} aspect=${q.aspectMode} postAA=${q.postAA})`);
    self.postMessage({ type: "set_quality", ok: true, quality: q });
    return;
  }

  if (message?.type === "init") {
    // Check if system is already initialized
    if (System.getInstance().process) {
      Logger.log(LogCategory.SYSTEM, "System already initialized, resending ready");
      self.postMessage({ type: "ready" });
      return;
    }

    if (!message.canvas) {
      if (state.canvas) {
        Logger.log(LogCategory.SYSTEM, "init message missing canvas, but we already have one. Resending ready");
        self.postMessage({ type: "ready" });
        return;
      }
      Logger.warn(LogCategory.SYSTEM, "init message missing canvas and no existing canvas found");
      return;
    }

    const canvas = message.canvas as OffscreenCanvas;
    state.canvas = canvas;
    state.width = message.width ?? (canvas ? canvas.width : 640);
    state.height = message.height ?? (canvas ? canvas.height : 360);
    state.inputBuffer = message.inputBuffer ?? null;
    state.inputView = state.inputBuffer ? new Int32Array(state.inputBuffer) : null;

    if (canvas) {
      canvas.width = state.width;
      canvas.height = state.height;
      const canWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
      if (!canWebGpu) {
        state.ctx = canvas.getContext("2d");
        // Start drawing loop for placeholder/debug
        requestAnimationFrame(drawPlaceholder);
      }

      // Init emulator
      initV86(canvas);
    }
  }

  if (message?.type === "resize") {
    state.width = message.width ?? state.width;
    state.height = message.height ?? state.height;
    // NOTE: Do NOT reconfigure WebGPU here. The worker's hostResize callback is the
    // authoritative source — it already called reconfigure(). Re-doing it from the
    // main-thread round-trip clears the canvas AFTER frames have been rendered → black screen.
    if (state.canvas && (state.canvas.width !== state.width || state.canvas.height !== state.height)) {
      state.canvas.width = state.width;
      state.canvas.height = state.height;
    }
    // Also resize GDI overlay canvas
    System.getInstance().gdiContext.resizeOverlay(state.width, state.height);

    // Trigger repaint for all windows on resize
    const system = System.getInstance();
    const WM_PAINT = 0x000F;
    for (const window of system.windowManager.getAllWindows()) {
      if (window.visible) {
        system.windowManager.postMessage(window.hwnd, WM_PAINT, 0, 0);
      }
    }
  }

  if (message?.type === "load_pe") {
    const peData = message.data as Uint8Array;
    loadPeData(peData).catch(err => Logger.error(LogCategory.SYSTEM, `load_pe failed: ${err}`));
  }

  if (message?.type === "hle_enable") {
    const cfg = EmulatorConfig.getInstance().hleLibs;
    cfg.enable = true;
    cfg.logOnly = !!message.logOnly;
    Logger.log(LogCategory.SYSTEM, `[HLE-lib] enabled via hle_enable message (logOnly=${cfg.logOnly})`);
    return;
  }

  if (message?.type === "hle_status") {
    const cfg = EmulatorConfig.getInstance().hleLibs;
    self.postMessage({
      type: "hle_status",
      enable: cfg.enable,
      logOnly: cfg.logOnly,
      report: libHleManager.getReport(),
    });
    return;
  }

  if (message?.type === "load_bundle") {
    const cfg = EmulatorConfig.getInstance().hleLibs as {
      enable: boolean;
      logOnly: boolean;
      galaxy?: { enable?: boolean; hleAudio?: boolean; hleMixer?: boolean };
    };
    // Galaxy full-module HLE is PARKED. The SAB-bypass needs proper glxSample reverse-
    // engineering (some UE1 titles store raw PCM with a non-obvious USound layout; the decoded
    // glxSample is created lazily inside the native PlaySoundW we'd replace) — a
    // substantial task for later. The kernel32 FORCE_NATIVE_PACKAGE_LOAD boot fix already
    // makes Galaxy.dll load + register its UClass natively, so UE1 audio works on the
    // native path. Flip enable back on when the glxSample bring-up is done.
    cfg.galaxy = { enable: false, hleAudio: false, hleMixer: false };
    if (message.galaxyHle === true) {
      Logger.log(LogCategory.SYSTEM, `[Galaxy] HLE module parked — native audio path (galaxyHle ignored)`);
    }
    if (message.hleEnable) {
      cfg.enable = true;
      cfg.logOnly = !!message.hleLogOnly;
      Logger.log(LogCategory.SYSTEM, `[HLE-lib] enabled via load_bundle (logOnly=${cfg.logOnly})`);
    }
    loadBundle({ data: message.data, url: message.url, blob: message.blob, blobs: message.blobs, preload: message.preload });
  }

  // --- WGB wizard build service (Stage 1) — additive, separate from the boot path above. -----
  if (message?.type === "wgb_build_start") {
    const source = (message.source ?? {}) as BuildSource;
    let last = 0;
    buildStagedBundle(source, (phase, percent, label) => {
      const now = performance.now();
      // Throttle to ~10 Hz like install_progress, but always emit terminal phases.
      if (phase !== "done" && now - last < 100) return;
      last = now;
      self.postMessage({ type: "wgb_build_progress", phase, percent, label });
    })
      .then((result) => {
        self.postMessage({
          type: "wgb_build_done",
          stagedPath: result.stagedPath,
          manifest: result.manifest,
          entries: result.entries,
          gameId: result.gameId,
          detections: result.detections,
        });
      })
      .catch((err) => {
        Logger.error(LogCategory.SYSTEM, `wgb_build_start failed: ${err}`);
        self.postMessage({ type: "wgb_build_error", message: String((err as Error)?.message ?? err) });
      });
    return;
  }

  if (message?.type === "wgb_inspect") {
    const source = (message.source ?? {}) as BuildSource;
    inspectBundle(source)
      .then((result) => {
        self.postMessage({ type: "wgb_inspect_done", manifest: result.manifest, entries: result.entries });
      })
      .catch((err) => {
        Logger.error(LogCategory.SYSTEM, `wgb_inspect failed: ${err}`);
        self.postMessage({ type: "wgb_inspect_error", message: String((err as Error)?.message ?? err) });
      });
    return;
  }

  if (message?.type === "wgb_read_entry") {
    const stagedPath = String(message.stagedPath ?? "");
    const name = String(message.name ?? "");
    readStagedEntry(stagedPath, name)
      .then((bytes) => {
        const text = new TextDecoder("utf-8").decode(bytes);
        self.postMessage({ type: "wgb_read_entry_done", name, text });
      })
      .catch((err) => {
        Logger.error(LogCategory.SYSTEM, `wgb_read_entry failed: ${err}`);
        self.postMessage({ type: "wgb_read_entry_error", name, message: String((err as Error)?.message ?? err) });
      });
    return;
  }

  if (message?.type === "wgb_finalize") {
    const destination = message.destination as FinalizeDestination;
    finalizeBundle({
      stagedPath: message.stagedPath,
      manifest: message.manifest,
      registry: message.registry,
      editedFiles: message.editedFiles,
      destination,
      onProgress: (percent, label) => {
        self.postMessage({ type: "wgb_finalize_progress", percent, label });
      },
    })
      .then((result) => {
        if (result.destination === "play") {
          // Hand the freshly-built bytes straight to the existing boot path.
          self.postMessage({ type: "wgb_finalize_done", destination, gameId: result.gameId, suggestedFilename: result.suggestedFilename });
          loadBundle({ data: result.bytes });
          return;
        }
        if (result.destination === "download" && result.bytes) {
          // Transfer the buffer so the host can save it (showSaveFilePicker / anchor download).
          const buf = result.bytes.buffer;
          (self as any).postMessage(
            { type: "wgb_finalize_done", destination, gameId: result.gameId, suggestedFilename: result.suggestedFilename, bytes: result.bytes },
            [buf],
          );
          return;
        }
        // library
        self.postMessage({ type: "wgb_finalize_done", destination, gameId: result.gameId, cacheKey: result.cacheKey, suggestedFilename: result.suggestedFilename });
      })
      .catch((err) => {
        Logger.error(LogCategory.SYSTEM, `wgb_finalize failed: ${err}`);
        self.postMessage({ type: "wgb_finalize_error", message: String((err as Error)?.message ?? err) });
      });
    return;
  }

  if (message?.type === "capture_frame") {
    const active = System.getInstance().services.render.getActive();
    if (!active) {
      self.postMessage({ type: "capture_frame", ok: false, error: "No active renderer." });
      return;
    }
    active.captureFrame()
      .then(async (blob) => {
        const buffer = await blob.arrayBuffer();
        (self as any).postMessage({ type: "capture_frame", ok: true, buffer }, [buffer]);
      })
      .catch((err) => {
        self.postMessage({ type: "capture_frame", ok: false, error: String(err) });
      });
  }

  if (message?.type === "toggle_stats_overlay") {
    statsOverlay.setEnabled(!!message.enabled);
  }

  // Dev-mode strict-FPU toggle: strict=true → relaxed-FPU OFF (full 80-bit x87), strict=false → relaxed ON.
  // Routes through the PreemptionManager (single source of truth; applies live + clears JIT cache).
  if (message?.type === "set_fpu_strict") {
    const strict = !!message.strict;
    const pm = (globalThis as any).preemption;
    if (pm?.setRelaxedFpu) {
      pm.setRelaxedFpu(!strict);
      console.log(`[PERF] dev toggle: strict-FPU ${strict ? "ON (relaxed DISABLED)" : "OFF (relaxed enabled)"}`);
    }
    self.postMessage({ type: "fpu_strict_state", strict });
  }

  if (message?.type === "render_stats") {
    const active = System.getInstance().services.render.getActive();
    if (!active) {
      self.postMessage({ type: "render_stats", ok: false, error: "No active renderer." });
      return;
    }
    const idle = frameVarianceDiagnostics.getIdleSummary();
    self.postMessage({
      type: "render_stats",
      ok: true,
      stats: {
        ...active.getCounters(),
        idleTotalMs: idle.totalMs,
        idleRafWaitMs: idle.rafWaitMs,
        idleYieldMs: idle.yieldMs,
        idleHltMs: idle.hltMs,
        idleUnknownMs: idle.unknownMs,
      }
    });
  }

  // Get GetPixel statistics - shows which HDCs are being queried pixel-by-pixel
  if (message?.type === "get_pixel_stats") {
    const stats = profiler.getGetPixelStats();
    self.postMessage({ type: "get_pixel_stats", ok: true, stats });
  }

  // Host audio bridge (audio_ended/started/error/position) — worker-handlers/audio-bridge.ts
  if (handleAudioBridgeMessage(message)) return;

  if (message?.type === "message_box_result") {
    resolveMessageBox(Number(message.id) || 0, Number(message.result) ?? 1);
  }

  if (message?.type === "time_mode") {
    const mode = message.mode === "manual" ? "manual" : "realtime";
    TimeService.getInstance().setMode(mode, message.nowMs, message.unixMs);
  }

  if (message?.type === "time_set") {
    if (typeof message.nowMs === "number") {
      TimeService.getInstance().setManualTime(message.nowMs, message.unixMs);
    }
  }

  if (message?.type === "time_advance") {
    if (typeof message.deltaMs === "number") {
      TimeService.getInstance().advanceByMs(message.deltaMs);
    }
  }

  if (message?.type === "replay_mode") {
    const system = System.getInstance();
    const enabled = Boolean(message.enabled);
    system.inputManager.setDeterministicMode(enabled);
  }

  if (message?.type === "input_tick") {
    const system = System.getInstance();
    system.inputManager.poll();
  }

  // Logger control (log_verbose_*, logging_global_enable, log_stream_enable,
  // log_get_recent) — worker-handlers/logging.ts
  if (handleLoggingMessage(message)) return;

  // Bridge for message-pump WM_TIMER diagnostics from main-thread console helpers.
  if (message?.type === "msg_timer_diag" || message?.type === "h3_timer_diag") {
    const replyType = message.type === "h3_timer_diag" ? "h3_timer_diag" : "msg_timer_diag";
    const g = globalThis as Record<string, any>;
    try {
      const setEnabled = g.msgTimerDiagSetEnabled ?? g.h3TimerDiagSetEnabled;
      const setInterval = g.msgTimerDiagSetIntervalMs ?? g.h3TimerDiagSetIntervalMs;
      const setQueueSkipped = g.msgTimerDiagSetQueueSkipped ?? g.h3TimerDiagSetQueueSkipped;
      const setFlushMax = g.msgTimerDiagSetFlushMax ?? g.h3TimerDiagSetFlushMax;
      const logNow = g.msgTimerDiagLogNow ?? g.h3TimerDiagLogNow;
      const getConfig = g.msgTimerDiagGetConfig ?? g.h3TimerDiagGetConfig;

      if (typeof message.enabled === "boolean" && typeof setEnabled === "function") {
        setEnabled(message.enabled);
      }
      if (typeof message.logIntervalMs === "number" && typeof setInterval === "function") {
        setInterval(message.logIntervalMs);
      }
      if (typeof message.queueSkipped === "boolean" && typeof setQueueSkipped === "function") {
        setQueueSkipped(message.queueSkipped);
      }
      if (typeof message.flushMax === "number" && typeof setFlushMax === "function") {
        setFlushMax(message.flushMax);
      }
      if (message.logNow === true && typeof logNow === "function") {
        logNow();
      }

      const config = typeof getConfig === "function" ? getConfig() : null;
      self.postMessage({ type: replyType, ok: true, config });
    } catch (error) {
      self.postMessage({ type: replyType, ok: false, error: String(error) });
    }
  }

  if (message?.type === "ui_gate_diag" || message?.type === "h3_gate_diag") {
    const replyType = message.type === "h3_gate_diag" ? "h3_gate_diag" : "ui_gate_diag";
    const g = globalThis as Record<string, any>;
    try {
      const setScreen = g.uiGateDiagSetForceScreenObj ?? g.h3GateDiagSetForceScreenObj;
      const setAdvMap = g.uiGateDiagSetForceAdvMap ?? g.h3GateDiagSetForceAdvMap;
      const setChildList = g.uiGateDiagSetForceGameScreenChildList ?? g.h3GateDiagSetForceGameScreenChildList;
      const getConfig = g.uiGateDiagGetConfig ?? g.h3GateDiagGetConfig;

      if (typeof message.forceScreenObjFallback === "boolean" && typeof setScreen === "function") {
        setScreen(message.forceScreenObjFallback);
      }
      if (typeof message.forceAdvMapFallback === "boolean" && typeof setAdvMap === "function") {
        setAdvMap(message.forceAdvMapFallback);
      }
      if (
        typeof message.forceGameScreenChildListFallback === "boolean" &&
        typeof setChildList === "function"
      ) {
        setChildList(message.forceGameScreenChildListFallback);
      }

      const config = typeof getConfig === "function" ? getConfig() : null;
      self.postMessage({ type: replyType, ok: true, config });
    } catch (error) {
      self.postMessage({ type: replyType, ok: false, error: String(error) });
    }
  }

  if (message?.type === "pause") {
    if (!System.getInstance().process?.v86) { Logger.warn(LogCategory.SYSTEM, "Cannot pause - process not initialized"); return; }
    try { pauseEmulator(); } catch (err) { Logger.error(LogCategory.SYSTEM, `[PAUSE] Error: ${err}`); }
  }

  if (message?.type === "resume") {
    if (!System.getInstance().process?.v86) { Logger.warn(LogCategory.SYSTEM, "Cannot resume - process not initialized"); return; }
    try { resumeEmulator(); } catch (err) { Logger.error(LogCategory.SYSTEM, `[RESUME] Error: ${err}`); }
  }

  // Debug/monitoring panels (memwatch_*, profiler_* / frame_pacer_enable, memory_*,
  // gpu_debug_* / frame_capture_*) — worker-handlers/debug-monitor.ts
  if (handleDebugMonitorMessage(message)) return;

  // Registry Tool (registry_get_state/get_log/clear/set_value) — worker-handlers/registry.ts
  // registry_clear also cancels the worker-owned debounced autosave via the context.
  if (handleRegistryMessage(message, { cancelRegistryAutosave })) return;
};
