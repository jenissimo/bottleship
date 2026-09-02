// Debug/monitoring RPC handlers for the host dev panels (MemoryMonitorPanel,
// ProfilerPanel, DebugGPUPanel, memory-watch UI).
// Families: memwatch_*, profiler_* / frame_pacer_enable, memory_*, gpu_debug_* /
// frame_capture_*.
import { System } from "../core/system";
import { memoryWatch } from "../core/memory/memory-watch";
import { leaseRegistry } from "../core/memory/lease-registry";
import { memoryEventBuffer } from "../core/memory/memory-event-buffer";
import { devices as d3d9Devices } from "../modules/d3d9/shared-state";
import { devices as d3d8Devices } from "../modules/d3d8/shared-state";
import { profiler } from "../core/profiler";
import { frameProfiler } from "../core/frame-profiler";
import { framePacer } from "../core/frame-pacer";
import { aotCache } from "../core/cpu/aot-cache";
import { Logger, LogCategory } from "../core/logger";
import type { DDraw } from "../modules/ddraw";
import type { Glide2x } from "../modules/glide2x";
import type { OpenGL32 } from "../modules/opengl32";
import type { WebGPUBackend } from "../backends/webgpu/webgpu-backend";

/**
 * Handles debug/monitoring host messages (memwatch, profiler, memory monitor,
 * GPU debug panel, frame capture). Returns true if the message was consumed.
 */
export function handleDebugMonitorMessage(message: any): boolean {
  // Memory Watch commands from UI
  if (message?.type === "memwatch_polling") {
    if (message.enabled) {
      memoryWatch.startPolling(500);
    } else {
      memoryWatch.stopPolling();
    }
    return true;
  }

  if (message?.type === "memwatch_check_all") {
    memoryWatch.checkAll();
    return true;
  }

  if (message?.type === "profiler_enable") {
    profiler.setEnabled(Boolean(message.enabled));
    frameProfiler.setEnabled(Boolean(message.enabled));
    self.postMessage({ type: "profiler_enable", ok: true, enabled: profiler.isEnabled() });
    return true;
  }

  if (message?.type === "frame_pacer_enable") {
    framePacer.setEnabled(Boolean(message.enabled));
    self.postMessage({ type: "frame_pacer_enable", ok: true, enabled: framePacer.isEnabled() });
    return true;
  }

  if (message?.type === "profiler_stats") {
    const stats = profiler.getStats();
    const frameStats = frameProfiler.getSnapshot();
    const framePacerStats = framePacer.getStats();

    // Include GPU metrics if available
    const system = System.getInstance();
    const active = system.services.render.getActive();
    if (active?.getCounters) {
      const gpuMetrics = active.getCounters();
      stats["gpu_active"] = {
        avgTime: 0, totalTime: 0, count: 0, maxTime: 0,
        counters: gpuMetrics
      };
    }

    self.postMessage({ type: "profiler_stats", ok: true, stats, frameStats, framePacerStats });
    return true;
  }

  if (message?.type === "profiler_reset") {
    profiler.reset();
    frameProfiler.reset();
    // D3D9 owns a separate, atomically reset measurement window through
    // dbg.d3d9Perf(true). Resetting only its executor here while API/WBUF counters keep
    // running makes a correct 60-frame run look like two thirds of its draws vanished.
    self.postMessage({ type: "profiler_reset", ok: true });
    return true;
  }

  // Memory Monitor handlers
  if (message?.type === "memory_stats") {
    const system = System.getInstance();
    const process = system.process;
    const now = performance.now();

    // Collect region info from AddressSpace
    const regions = process?.addressSpace?.getRegions()?.map(r => ({
      id: r.id,
      base: r.base,
      size: r.size,
      perms: r.perms,
      kind: r.kind,
      owner: r.owner,
      tag: r.tag,
    })) || [];

    // Collect active leases
    const activeLeases = leaseRegistry.getActiveLeases();
    const leases = activeLeases.map(l => ({
      id: l.id,
      base: l.base,
      size: l.size,
      owner: l.owner,
      perms: l.perms,
      tag: l.tag,
      durationMs: now - l.createdAt,
    }));

    // Get recent memory events (filter out undefined entries from ring buffer)
    const recentEvents = memoryEventBuffer.getRecent(1000).filter(e => e != null);

    // Calculate GC pressure from memory events
    const allocEvents = recentEvents.filter(e => e.type === "alloc");
    const freeEvents = recentEvents.filter(e => e.type === "free");

    // Calculate rates based on time window of events
    const timeWindow = recentEvents.length >= 2
      ? (recentEvents[recentEvents.length - 1].timestamp - recentEvents[0].timestamp) / 1000
      : 1;

    const totalAllocated = allocEvents.reduce((sum, e) => sum + e.size, 0);
    const totalFreed = freeEvents.reduce((sum, e) => sum + e.size, 0);

    const gcPressure = {
      sampleCount: recentEvents.length,
      avgAllocRate: timeWindow > 0 ? totalAllocated / timeWindow : 0,
      peakAllocRate: 0, // Would need more tracking
      totalAllocated,
      totalFreed,
      netGrowth: totalAllocated - totalFreed,
      allocsPerSecond: timeWindow > 0 ? allocEvents.length / timeWindow : 0,
      freesPerSecond: timeWindow > 0 ? freeEvents.length / timeWindow : 0,
    };

    // Get total memory from v86
    const totalMemory = process?.addressSpace?.getMemorySize() || 0;

    // Estimate used heap from regions
    const usedHeap = regions.reduce((sum, r) => sum + r.size, 0);

    self.postMessage({
      type: "memory_stats",
      ok: true,
      memoryStats: {
        totalMemory,
        usedHeap,
        regions,
        leases,
        recentEvents,
        gcPressure,
      }
    });
    return true;
  }

  if (message?.type === "memory_monitor_enable") {
    // Could enable more detailed tracking here
    const enabled = Boolean(message.enabled);
    self.postMessage({ type: "memory_monitor_enable", ok: true, enabled });
    return true;
  }

  if (message?.type === "memory_gc_hint") {
    // Cannot force GC, but could trigger cleanup operations
    Logger.log(LogCategory.SYSTEM, "Memory GC hint received - triggering cleanup");
    self.postMessage({ type: "memory_gc_hint", ok: true });
    return true;
  }

  if (message?.type === "memory_stats_reset") {
    // Reset any tracked stats
    self.postMessage({ type: "memory_stats_reset", ok: true });
    return true;
  }

  // GPU Debug Panel handlers
  if (message?.type === "gpu_debug_query") {
    const system = System.getInstance();
    const { api, scope = "summary", includePreview = false, previewMax = 512, onlyActive = false } = message;

    const result: Record<string, unknown> = {};

    if (api === "ddraw" || api === "all") {
      const ddraw = system.process?.getModule("ddraw") as DDraw | undefined;
      if (ddraw) {
        result.ddraw = {
          surfaces: ddraw.getDebugSurfacesInfo(scope, onlyActive),
          frameSnapshot: ddraw.getFrameSnapshot(),
        };
        // Preview is async, handle separately via gpu_debug_surface_preview
      }
    }

    if (api === "d3d9" || api === "all") {
      // Get D3D9 devices from shared state
      if (d3d9Devices && d3d9Devices.size > 0) {
        // Use the first device (most games use one device)
        const device = Array.from(d3d9Devices.values())[0];
        if (device) {
          result.d3d9 = {
            resources: device.getDebugResourcesInfo(scope, onlyActive),
            frameSnapshot: device.getFrameSnapshot(),
          };
        }
      }
    }

    if (api === "d3d8" || api === "all") {
      if (d3d8Devices.size > 0) {
        const device = Array.from(d3d8Devices.values())[0];
        if (device) {
          result.d3d8 = {
            resources: device.getDebugResourcesInfo(scope, onlyActive),
            frameSnapshot: device.getFrameSnapshot(),
          };
        }
      }
    }

    if (api === "glide" || api === "all") {
      const glide = system.process?.getModule("glide2x") as Glide2x | undefined;
      if (glide) {
        result.glide = {
          resources: glide.getDebugResourcesInfo(scope, onlyActive),
          frameSnapshot: glide.getFrameSnapshot(),
        };
      }
    }

    if (api === "opengl" || api === "all") {
      const opengl32 = system.process?.getModule("opengl32") as OpenGL32 | undefined;
      if (opengl32) {
        result.opengl = {
          resources: opengl32.getDebugResourcesInfo(),
          frameSnapshot: opengl32.getFrameSnapshot(),
        };
      }
    }

    if (api === "webgpu" || api === "all") {
      const backend = system.services.render.getBackend() as WebGPUBackend | null;
      if (backend && backend.kind === 'webgpu') {
        result.webgpu = backend.getDebugInfo();
      }
    }

    if (api === "video" || api === "all") {
      result.videoRouting = system.videoRouting.getDebugInfo();
    }

    // Which presenter last drove the screen (ddraw/d3d8/d3d9/glide/gdi/opengl).
    result.activeBackend = system.services.render.getLastPresenterKind();

    self.postMessage({ type: "gpu_debug_query", ok: true, data: result });
    return true;
  }

  if (message?.type === "gpu_debug_surface_preview") {
    const system = System.getInstance();
    const { surfaceAddr, maxSize = 512 } = message;
    const ddraw = system.process?.getModule("ddraw") as DDraw | undefined;
    if (ddraw) {
      ddraw.getSurfacePreview(surfaceAddr, maxSize)
        .then((preview) => {
          self.postMessage({ type: "gpu_debug_surface_preview", ok: true, data: preview });
        })
        .catch((error) => {
          self.postMessage({ type: "gpu_debug_surface_preview", ok: false, error: String(error) });
        });
    } else {
      self.postMessage({ type: "gpu_debug_surface_preview", ok: false, error: "DDraw module not available" });
    }
    return true;
  }

  if (message?.type === "frame_capture_start") {
    const system = System.getInstance();
    const ddraw = system.process?.getModule("ddraw") as DDraw | undefined;
    if (ddraw) {
      ddraw.captureNextFrame()
        .then((frame) => {
          self.postMessage({ type: "frame_capture_data", ok: true, data: frame });
        })
        .catch((error) => {
          self.postMessage({ type: "frame_capture_data", ok: false, error: String(error) });
        });
    } else {
      self.postMessage({ type: "frame_capture_data", ok: false, error: "DDraw module not available" });
    }
    return true;
  }

  if (message?.type === "frame_capture_texture") {
    const system = System.getInstance();
    const { surfacePtr, maxSize = 256 } = message;
    const ddraw = system.process?.getModule("ddraw") as DDraw | undefined;
    if (ddraw) {
      ddraw.getSurfacePreview(surfacePtr, maxSize)
        .then((preview) => {
          self.postMessage({ type: "frame_capture_texture", ok: true, surfacePtr, data: preview });
        })
        .catch((error) => {
          self.postMessage({ type: "frame_capture_texture", ok: false, surfacePtr, error: String(error) });
        });
    } else {
      self.postMessage({ type: "frame_capture_texture", ok: false, surfacePtr, error: "DDraw module not available" });
    }
    return true;
  }

  if (message?.type === "frame_capture_bit15_check") {
    const system = System.getInstance();
    const { surfacePtr, width, height, pitch, bpp } = message;
    const ddraw = system.process?.getModule("ddraw") as DDraw | undefined;
    if (ddraw) {
      const result = ddraw.checkBit15Stats(surfacePtr, width, height, pitch || width * 2, bpp);
      self.postMessage({ type: "frame_capture_bit15_check", ok: true, surfacePtr, data: result });
    } else {
      self.postMessage({ type: "frame_capture_bit15_check", ok: false, surfacePtr, error: "DDraw module not available" });
    }
    return true;
  }

  if (message?.type === "gpu_debug_toggle") {
    const system = System.getInstance();
    const { toggle, enabled, value } = message;

    // Apply toggle to renderers
    const ddraw = system.process?.getModule("ddraw") as any;
    if (ddraw?.context?.executor?.setDebugToggle) {
      ddraw.context.executor.setDebugToggle(toggle, enabled, value);
    }

    const d3d9 = system.process?.getModule("d3d9") as any;
    const device = d3d9?.getDevice?.();
    if (device?.setDebugToggle) {
      device.setDebugToggle(toggle, enabled, value);
    }

    // D3D8 renders through the shared FFP executor; when there's no ddraw module
    // (d3d8-only title) the toggle must reach the adapter's own executor instance.
    for (const d3d8Device of d3d8Devices.values()) {
      d3d8Device.renderer.setDebugToggle(toggle, enabled, value);
    }

    self.postMessage({ type: "gpu_debug_toggle", ok: true, toggle, enabled, value });
    return true;
  }

  // ── AOT code cache (docs/performance/sota-roadmap/05-A0-play-and-record.md) ──
  //
  // The panel drives the same three verbs the console has, but through a request/reply so a
  // result is visible in the UI. Recording a session is a two-step ritual with a
  // data-losing failure mode (a `stop` that never ran keeps nothing), and a ritual nobody
  // can see the state of is one people get wrong.
  if (message?.type === "aot_cmd") {
    const reply = (ok: boolean, result: unknown) =>
      self.postMessage({ type: "aot_result", cmd: message.cmd, ok, result });
    const status = () => ({
      recording: aotCache.recordingStats(),
      units: aotCache.getUnits().length,
      autoLoad: !(globalThis as Record<string, unknown>).__aotNoAutoLoad,
      boot: (globalThis as Record<string, unknown>).__aotBoot ?? null,
      entered: aotCache.entered(),
    });
    try {
      switch (message.cmd) {
        case "start":
          aotCache.armAll();
          delete (globalThis as Record<string, unknown>).__aotNoAutoLoad;
          reply(true, status());
          break;
        case "stop":
          void (async () => {
            try {
              // Read the live capture BEFORE disarming; status() below reports the (now
              // empty) post-stop state, so the two must not collide on one key.
              const captured = aotCache.recordingStats();
              const snapshot = await aotCache.snapshot();
              aotCache.disarm();
              const saved = await aotCache.save(aotGameIdForPanel());
              reply(true, { ...status(), captured, snapshot, saved });
            } catch (e) { reply(false, String(e)); }
          })();
          break;
        case "autoload":
          if (message.enabled) delete (globalThis as Record<string, unknown>).__aotNoAutoLoad;
          else (globalThis as Record<string, unknown>).__aotNoAutoLoad = true;
          reply(true, status());
          break;
        case "clear":
          aotCache.clear();
          reply(true, status());
          break;
        default:
          reply(true, status());
      }
    } catch (e) { reply(false, String(e)); }
    return true;
  }

  return false;
}

/** The same id the cache saves under, read the same way dbg.aot does (dbg-commands.ts):
 *  the REGISTRY's namespaced gameId. A different id here would save to a directory the
 *  boot-time load never looks in — a recording that persists and is never used. */
function aotGameIdForPanel(): string {
  return (System.getInstance().registry as unknown as { gameId?: string })?.gameId ?? "unknown";
}
