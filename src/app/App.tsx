import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui/cx";
import s from "./App.module.css";
import OpfsTool from '../debug/OpfsTool';
import StorageManagerModal from '../storage/StorageManagerModal';
import RegistryTool from '../debug/RegistryTool';
import DebugLogViewer from '../debug/DebugLogViewer';
import MemoryPanel from '../debug/MemoryPanel';
import ProfilerPanel from '../debug/ProfilerPanel';
import DebugGPUPanel from '../debug/DebugGPUPanel';
import FrameAnalysisPanel from '../debug/FrameAnalysisPanel';
import { InputStatusOverlay, type InputStatus } from './InputStatusOverlay';
import { AudioEngine, AudioPlayEncodedPayload, AudioPlayPayload, AudioUpdatePayload } from "../audio/audio-engine";
import { getLogClient, sendLogToServer, writeDebugFile, writeDebugFileBase64, rotateLogFile } from "../utils/log-client";
import { installHarnessFacade } from "../harness/facade";
import { getCachedGamepadMeta, initGamepadCache, readLiveGamepad, rescanGamepads } from "../gamepad-cache";
import GameSelectScreen, { type GameEntry } from "../library/GameSelectScreen";
import SettingsDrawer from "../settings/SettingsDrawer";
import DevPanel from "./DevPanel";
import ExitOverlay from "./ExitOverlay";
import MessageBoxModal, { type MessageBoxRequest } from "../debug/MessageBoxModal";
import type { GuestExitInfo } from "../guest-report";
import { detectBrowserSupport, probeWebGPU, type WebGPUProbeResult } from "../browser-support";
import WebGPUErrorOverlay from "./WebGPUErrorOverlay";
import WgbWizardModal from "../wizard/WgbWizardModal";
import ManifestEditorModal from "../wizard/ManifestEditorModal";
import { listAddedGames, removeAddedGame, type AddedGame } from "../wgb-library";
import { ensurePersistentStorageRequested } from "../storage-manager";
import { loadGamesCatalog } from "../games-catalog";
import { DEFAULT_QUALITY, mergeQuality } from "../worker/core/quality-config";
import type { QualityConfig } from "../worker/core/quality-config";
import {
  DEFAULT_UI_SETTINGS,
  UI_SETTINGS_STORAGE_KEY,
  loadUiSettings,
} from "../ui-settings";
import type {
  MouseCoordinateMode,
  PresentMode,
  UiSettings,
} from "../ui-settings";

async function writeOpfsFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Stage dropped/picked bundle(s) or installer parts into OPFS, then open the bare
 * workspace to launch them — the bridge a File can't otherwise survive a `location.assign`.
 *
 * - single .wgb → staged into wgb-cache/<name>, launched via ?load=<url>. The worker's
 *   load_bundle{url} path checks WgbCache.openSyncSourceForUrl (keyed by filename) before
 *   any fetch, so it reads our staged copy straight off disk (no RAM copy).
 * - installer(s) (single-file GOG .exe, or setup.exe + setup-*.bin slices) → staged into a
 *   fresh _ingest/ dir, launched via ?ingest=1. The dev handler reads them back and feeds
 *   the worker's load_bundle blob/blobs sniff path (PE → inno unpack → wgb).
 */
async function stageFilesAndLaunch(files: File[]): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const bottleship = await root.getDirectoryHandle("bottleship", { create: true });

  if (files.length === 1 && files[0]!.name.toLowerCase().endsWith(".wgb")) {
    const f = files[0]!;
    const cacheDir = await bottleship.getDirectoryHandle("wgb-cache", { create: true });
    await writeOpfsFile(cacheDir, f.name, f);
    window.location.assign(`?game=dev&load=${encodeURIComponent(`/apps/byo/${f.name}`)}`);
    return;
  }

  try { await bottleship.removeEntry("_ingest", { recursive: true }); } catch { /* none yet */ }
  const ingestDir = await bottleship.getDirectoryHandle("_ingest", { create: true });
  for (const f of files) await writeOpfsFile(ingestDir, f.name, f);
  window.location.assign(`?game=dev&ingest=1`);
}

const INPUT_BUFFER_SIZE = 1024;
const INPUT_INDEX = {
  seq: 0,
  mouseX: 1,
  mouseY: 2,
  buttons: 3,
  keyCode: 4,
  keyState: 5,
  gamepadConnected: 6,
  gamepadButtons: 7,
  gamepadAxis0: 8,
  gamepadAxis1: 9,
  gamepadAxis2: 10,
  gamepadAxis3: 11,
  mouseWheel: 12,
  mouseInside: 13,  // 1 = cursor inside canvas, 0 = outside
  dinputDX: 14,     // accumulated DInput raw movementX delta (Atomics.add / exchange)
  dinputDY: 15,     // accumulated DInput raw movementY delta
  // 16..23 reserved for the keyboard bitfield (KEY_BITFIELD_BASE)
  guestGamepadSeq: 24  // worker bumps when the GAME reads the joystick/gamepad API
} as const;

// Keyboard bitfield: 256 virtual keys as 8 x Int32 = 256 bits
const KEY_BITFIELD_BASE = 16;
const KEY_BITFIELD_COUNT = 8;

type WorkerStatus = "idle" | "ready" | "error";

// CrashFault + formatGuestReport (the crash/exit report machinery) live in
// ./guest-report.ts; the overlay that renders them is ./ExitOverlay.tsx.

type InputSample = {
  t: number;
  mouseX: number;
  mouseY: number;
  buttons: number;
  keyCode: number;
  keyState: number;
  gamepadConnected: number;
  gamepadButtons: number;
  gamepadAxis0: number;
  gamepadAxis1: number;
  gamepadAxis2: number;
  gamepadAxis3: number;
  mouseWheel: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
}

// Graphics "Video / Quality" prefs. Stored separately from UiSettings under its own key
// so it can be loaded/validated through the worker's mergeQuality() (single source of truth
// for ranges/snapping). Treated as a GLOBAL user pref: posted on change + re-sent after each
// game load (the worker re-applies per-game quality from the manifest on top of this).
const QUALITY_STORAGE_KEY = "bottleship.quality";

function loadQuality(): QualityConfig {
  if (typeof window === "undefined") return { ...DEFAULT_QUALITY };
  try {
    const raw = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_QUALITY };
    const parsed = JSON.parse(raw) as Partial<QualityConfig>;
    // mergeQuality clamps/snaps every field onto DEFAULT_QUALITY → tolerant of stale/partial data.
    return mergeQuality(DEFAULT_QUALITY, parsed);
  } catch {
    return { ...DEFAULT_QUALITY };
  }
}

// BrowserSupportInfo + detectBrowserName/detectBrowserSupport (the capability
// gate) live in ./browser-support.ts.

// Persistent state outside the component scope to survive re-mounts
let globalWorker: Worker | null = null;
let globalSab: SharedArrayBuffer | null = null;
let globalInputView: Int32Array | null = null;
let globalOffscreen: OffscreenCanvas | null = null;
let capturePending: { resolve: (blob: Blob) => void; reject: (err: Error) => void } | null = null;
let statsPending: { resolve: (stats: Record<string, number>) => void; reject: (err: Error) => void } | null = null;
let verboseLogPending: { resolve: (text: string) => void; reject: (err: Error) => void } | null = null;
let audioEngine: AudioEngine | null = null;
let isRecording = false;
let recordStart = 0;
let recordedInputs: InputSample[] = [];

// Track currently pressed keys as a Set; serialized to bitfield in SharedArrayBuffer
const pressedKeys = new Set<number>();

function syncKeyBitfield(inputView: Int32Array): void {
    for (let word = 0; word < KEY_BITFIELD_COUNT; word++) {
        let bits = 0;
        const base = word * 32;
        for (const vk of pressedKeys) {
            if (vk >= base && vk < base + 32) bits |= (1 << (vk - base));
        }
        inputView[KEY_BITFIELD_BASE + word] = bits;
    }
}

// --- SAB input seqlock (writer side) ---------------------------------------
// The input record spans many Int32 slots but is published via the single `seq`
// counter. Plain payload writes with only a trailing Atomics bump let the worker
// reader observe a HALF-updated record (torn read). Bracket every payload update
// in a seqlock: bump seq to ODD before touching payload (writer-in-progress),
// write the payload slots, then bump seq to EVEN to publish. Atomics.add is a
// sequentially-consistent RMW, so it fences the plain payload stores between the
// two markers; the reader's paired Atomics.load(seq) acquire sees either an odd
// value (retry/skip) or a stable even snapshot. seq stays even between updates,
// so the reader's "changed since lastSeq" gate is unaffected (each update = +2).
// Zero-alloc, hot-path cheap: two atomic increments per input event.
function beginInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1); // even -> odd: writer in progress
}
function endInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1); // odd -> even: publish (release)
}

// Win32 MessageBox button tables + the dev-mode modal live in ./MessageBoxModal.tsx.

// Launch overlay: coarse stage stepper (Engine → Fetch → Boot) + the detailed status line.
// `index` is the stage a given worker phase belongs to; everything before it reads "done".
const LOAD_STAGES = [
  { id: "engine", label: "Engine" },
  { id: "fetch", label: "Fetch" },
  { id: "boot", label: "Boot" },
] as const;
function loadPhaseStageIndex(phase: string): number {
  switch (phase) {
    case "init": return 0;
    case "downloading": case "caching": case "installing": case "loading": case "prefetch": return 1;
    case "starting": case "booting": default: return 2;
  }
}
function loadPhaseStatus(phase: string, gameName: string): string {
  switch (phase) {
    case "init": return "Booting emulator";
    case "downloading": return "Downloading";
    case "caching": return "Caching to disk";
    case "installing": return "Installing";
    case "prefetch": return "Preloading assets";
    case "loading": return "Preparing";
    case "starting": return "Starting";
    case "booting": return `Starting ${gameName}`;
    default: return "Loading";
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [inputStatus, setInputStatus] = useState<InputStatus>({
    padConnected: false,
    padLabel: null,
    guestActive: false,
  });
  const handleDroppedFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0 || !globalWorker) return;
    ensurePersistentStorageRequested();
    canvasRef.current?.focus();
    setIsLoadingApp(true);
    setErrorMessage(null);
    setBundleDisplayName(null);
    setLoadingProgress({ phase: "loading", percent: 0, label: "" });
    // One file → blob sniff path; several (setup.exe + setup-*.bin) → multi-part install.
    globalWorker.postMessage(
      files.length === 1
        ? { type: "load_bundle", blob: files[0] }
        : { type: "load_bundle", blobs: files },
    );
  }, []);
  const canvasRectRef = useRef<DOMRect | null>(null);
  const cursorVisibleRef = useRef(true);
  // CSS cursor for the guest's installed custom cursor image (SetCursor with a
  // CreateIconIndirect/LoadImage shape) — null when the guest uses a system shape.
  const cursorCssRef = useRef<string | null>(null);
  const isCanvasHoveredRef = useRef(false);
  const [gamesCatalog, setGamesCatalog] = useState<GameEntry[] | null>(null);
  useEffect(() => {
    loadGamesCatalog().then(setGamesCatalog);
  }, []);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when the guest process exits (ExitProcess / crash → SEH → ExitProcess).
  // Dedicated state (not folded into workerStatus) so the "game exited" overlay
  // is driven by one signal and a fresh load clears it. `crashed` distinguishes a
  // clean exit from an unhandled access violation (fault carries EIP/addr).
  const [exitInfo, setExitInfo] = useState<GuestExitInfo | null>(null);
  const [isBufferInitialized, setIsBufferInitialized] = useState(false);
  const [isLoadingApp, setIsLoadingApp] = useState(false);
  // Unified launch overlay model, covering the WHOLE journey click → first flip:
  //   phase: "init" (worker/v86 boot) → downloading/caching/installing/loading (fetch)
  //          → starting → "booting" (PE loaded, guest running until its first frame).
  // `indeterminate` drives a shimmer bar when there is no measurable percent (boot phases).
  // `fadingOut` triggers the crossfade-out once the guest composites its first frame.
  const [loadingProgress, setLoadingProgress] = useState<{
    phase: string; percent: number; label?: string; indeterminate?: boolean; fadingOut?: boolean;
  } | null>(null);
  /** Display name from the loaded WGB manifest (title || name). Used so ?game=dev&load=…
   *  doesn't keep saying "Dev" / "Starting Dev" once the bundle is known. */
  const [bundleDisplayName, setBundleDisplayName] = useState<string | null>(null);
  const loadingFadeTimerRef = useRef<number | null>(null);
  const [addGameOpen, setAddGameOpen] = useState(false);
  const [addedGames, setAddedGames] = useState<AddedGame[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [opfsToolOpen, setOpfsToolOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [mainSettingsOpen, setMainSettingsOpen] = useState(false);
  const [registryToolOpen, setRegistryToolOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [profilerOpen, setProfilerOpen] = useState(false);
  const [debugGpuOpen, setDebugGpuOpen] = useState(false);
  const [frameAnalysisOpen, setFrameAnalysisOpen] = useState(false);
  const [statsOverlayEnabled, setStatsOverlayEnabled] = useState(false);
  const [fpuStrictEnabled, setFpuStrictEnabled] = useState(false);
  const [messageBox, setMessageBox] = useState<MessageBoxRequest | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [uiSettings, setUiSettings] = useState<UiSettings>(() => loadUiSettings());
  const [quality, setQuality] = useState<QualityConfig>(() => loadQuality());
  const qualityRef = useRef<QualityConfig>(quality);
  const [guestResolution, setGuestResolution] = useState({ width: 1024, height: 768 });
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window !== "undefined" ? Math.max(1, window.innerWidth) : 1,
    height: typeof window !== "undefined" ? Math.max(1, window.innerHeight) : 1,
  }));
  const [loggingEnabled, setLoggingEnabled] = useState(() => {
    const saved = localStorage.getItem('bottleship_logging_enabled');
    return saved !== null ? saved === 'true' : false; // Default: disabled
  });
  const [devPanelOpen, setDevPanelOpen] = useState(() => {
    if (new URLSearchParams(window.location.search).get('game') === 'dev') return true;
    try { return localStorage.getItem('bottleship_dev_panel') === 'true'; } catch { return false; }
  });
  const toggleDevPanel = useCallback(() => {
    setDevPanelOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('bottleship_dev_panel', String(next)); } catch {}
      return next;
    });
  }, []);

  const mouseCoordinateModeRef = useRef<MouseCoordinateMode>(uiSettings.mouseCoordinateMode);
  const presentModeRef = useRef<PresentMode>(uiSettings.presentMode);
  const guestResolutionRef = useRef({ width: 1024, height: 768 });
  // Current UI settings, readable from non-React callbacks (e.g. the audio-engine
  // creation path, which may run after the settings-apply effect has fired).
  const uiSettingsRef = useRef<UiSettings>(uiSettings);
  // Live pause state for the long-lived I/O effect's callbacks. Read via ref so
  // toggling pause does NOT tear down and recreate the whole worker/input/audio
  // effect (see the core-I/O effect's deps) — only this cheap sync effect runs.
  const isPausedRef = useRef(false);

  // Patch helper: SettingsDrawer (and the old controls) hand back partial UiSettings updates.
  const handleUiChange = useCallback((patch: Partial<UiSettings>) => {
    setUiSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // Game selection via URL param: ?game=revolt  (special: ?game=dev → bare emulator)
  const gameIdFromUrl = useMemo(
    () => new URLSearchParams(window.location.search).get("game"),
    [],
  );
  const selectedGame = useMemo<GameEntry | null>(() => {
    if (!gameIdFromUrl) return null;
    if (gameIdFromUrl === "dev") {
      return { id: "dev", name: "Dev", subtitle: "", wgbUrl: "", coverUrl: "", description: "", year: "", genre: "" };
    }
    // Catalog still fetching — don't treat as "unknown game" yet.
    if (gamesCatalog === null) return null;
    return gamesCatalog.find((g) => g.id === gameIdFromUrl) ?? null;
  }, [gamesCatalog, gameIdFromUrl]);
  // UI shell while catalog resolves: mount canvas/worker immediately on ?game=<id>
  // instead of returning null (which left canvasRef unset and the worker init effect
  // never re-ran once the catalog arrived).
  const displayGame = useMemo<GameEntry | null>(() => {
    if (!gameIdFromUrl) return null;
    if (selectedGame) return selectedGame;
    if (gameIdFromUrl === "dev") {
      return { id: "dev", name: "Dev", subtitle: "", wgbUrl: "", coverUrl: "", description: "", year: "", genre: "" };
    }
    return {
      id: gameIdFromUrl,
      name: "Loading…",
      subtitle: "",
      wgbUrl: "",
      coverUrl: "",
      description: "",
      year: "",
      genre: "",
    };
  }, [gameIdFromUrl, selectedGame]);
  const gameDisplayName = bundleDisplayName ?? displayGame?.name ?? "Game";
  const browserSupport = useMemo(() => detectBrowserSupport(), []);
  const browserUnsupportedMessage = useMemo(() => {
    if (browserSupport.supported) return null;
    const missing = browserSupport.missing.join(", ");
    return `This browser is missing features required to run BottleShip: ${missing}. Detected browser: ${browserSupport.detectedBrowser}. Please use an up-to-date Google Chrome or Safari 26+.`;
  }, [browserSupport]);

  // WebGPU is the whole render backend, but detectBrowserSupport() only checks that the API is
  // *present*. The adapter can still fail to acquire (hardware accel off, GPU blocklisted, VM/RDP)
  // — which otherwise degrades into a swallowed D3DERR at CreateDevice and a silent guest exit.
  // Probe for real once up front and block with an explanatory overlay instead. null = probing.
  const [webgpuProbe, setWebgpuProbe] = useState<WebGPUProbeResult | null>(null);
  useEffect(() => {
    if (!browserSupport.supported) return;
    let cancelled = false;
    probeWebGPU().then(
      (r) => { if (!cancelled) setWebgpuProbe(r); },
      // Never let the probe itself wedge the app — treat an unexpected throw as "usable".
      () => { if (!cancelled) setWebgpuProbe({ ok: true, stage: "ok", reason: "", hints: [] }); },
    );
    return () => { cancelled = true; };
  }, [browserSupport.supported]);

  // A failed WebGPU probe blocks launching everywhere. On the library we lock the grid
  // (disableSelection) and float the same error card as a modal over it, so users learn up front
  // instead of picking a game and hitting a dead end. (browser-unsupported keeps its own banner.)
  const webgpuBlocked = webgpuProbe !== null && !webgpuProbe.ok;
  const launchBlocked = !browserSupport.supported || webgpuBlocked;

  // Auto-load game once worker is ready. Registered games load their wgbUrl; dev mode
  // stays manual UNLESS Add-Game handed us a bundle via ?load=<url> (BYO drop / URL).
  const autoLoadDoneRef = useRef(false);
  useEffect(() => {
    if (!browserSupport.supported || (webgpuProbe !== null && !webgpuProbe.ok)) return;
    if (!selectedGame || workerStatus !== "ready" || autoLoadDoneRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const loadParam = params.get("load");
    const ingest = params.get("ingest");
    if (selectedGame.id === "dev" && !loadParam && !ingest) return;
    // Registered games: wait until games-catalog.json resolves wgbUrl.
    if (selectedGame.id !== "dev" && !selectedGame.wgbUrl) return;
    autoLoadDoneRef.current = true;

    if (selectedGame.id === "dev" && ingest) {
      // BYO installer(s) staged to OPFS _ingest/ by the Add-Game flow — read them back and
      // feed the worker's blob sniff path (one file → {blob}; multi-part → {blobs}).
      (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const bottleship = await root.getDirectoryHandle("bottleship");
          const ingestDir = await bottleship.getDirectoryHandle("_ingest");
          const files: File[] = [];
          for await (const [, handle] of (ingestDir as any).entries()) {
            if (handle.kind === "file") files.push(await (handle as FileSystemFileHandle).getFile());
          }
          if (files.length === 0) throw new Error("no staged files found");
          ensurePersistentStorageRequested();
          canvasRef.current?.focus();
          setIsLoadingApp(true);
          setErrorMessage(null);
          setBundleDisplayName(null);
          setLoadingProgress({ phase: "loading", percent: 0, label: "" });
          globalWorker?.postMessage(
            files.length === 1
              ? { type: "load_bundle", blob: files[0] }
              : { type: "load_bundle", blobs: files },
          );
        } catch (err) {
          setErrorMessage(`Failed to load staged files: ${err instanceof Error ? err.message : String(err)}`);
          setIsLoadingApp(false);
          setLoadingProgress(null);
        }
      })();
      return;
    }

    (window as any).loadApp?.(selectedGame.id === "dev" ? loadParam : selectedGame.wgbUrl);
  }, [browserSupport.supported, selectedGame, workerStatus, webgpuProbe]);

  // Cover the worker/v86 boot phase too: before the worker posts "ready" there is no
  // load_bundle progress yet, so without this the user stares at a bare canvas while
  // v86.wasm + BIOS download and instantiate (often the slowest part of a cold start).
  // Show an indeterminate "Booting emulator" overlay for any game that will auto-launch.
  useEffect(() => {
    if (!browserSupport.supported || !displayGame) return;
    const params = new URLSearchParams(window.location.search);
    const willLaunch = displayGame.id !== "dev" || params.get("load") || params.get("ingest");
    if (!willLaunch) return;
    if (workerStatus === "ready" || workerStatus === "error" || errorMessage || exitInfo) return;
    // Don't clobber an in-flight load — only seed the overlay if nothing is showing yet.
    setLoadingProgress((prev) => prev ?? { phase: "init", percent: 0, indeterminate: true });
  }, [browserSupport.supported, displayGame, workerStatus, errorMessage, exitInfo]);

  // Clear the launch-overlay fade-out timer on unmount (avoid a stray setState after teardown).
  useEffect(() => () => {
    if (loadingFadeTimerRef.current !== null) window.clearTimeout(loadingFadeTimerRef.current);
  }, []);

  // BYO bundles the user added live in OPFS wgb-cache/ — surface them in the library.
  // Exclude cached copies of built-in games so they don't show twice.
  const refreshAddedGames = useCallback(() => {
    const exclude = new Set((gamesCatalog ?? []).map((g) => (g.wgbUrl.split("/").pop() ?? "").toLowerCase()));
    listAddedGames(exclude).then(setAddedGames).catch(() => setAddedGames([]));
  }, [gamesCatalog]);
  useEffect(() => {
    if (!gameIdFromUrl) refreshAddedGames();
  }, [gameIdFromUrl, refreshAddedGames]);

  // Pointer lock state for FPS-style relative mouse input
  const pointerLockedRef   = useRef(false);
  const wantsPointerLockRef = useRef(false);
  const virtualMouseRef    = useRef({ x: 0, y: 0 });
  // Cooldown after exitPointerLock — browser rejects re-acquire for ~1 frame after exit
  const pointerLockCooldownRef = useRef(false);
  // Faithful relative-mouse engagement = (cursor hidden via ShowCursor) OR (ClipCursor confined)
  // OR (DirectInput exclusive-mode mouse acquired) OR (SetCursorPos warp burst — AGS/UE
  // re-centering emulates relative mouse; we can honor warps only under pointer lock).
  const cursorClippedRef = useRef(false);
  const cursorWarpingRef = useRef(false);
  const mouseCapturedRef = useRef(false);
  // Right Ctrl deliberately released the lock — suppress auto re-acquire until the next
  // explicit re-engage gesture (a canvas click).
  const userReleasedLockRef = useRef(false);
  /** Host F11 fullscreen — ref so the mount-stable input effect can call it. */
  const toggleFullscreenRef = useRef<() => void>(() => {});

  const requestPointerLockSafe = (canvas: HTMLCanvasElement) => {
    if (pointerLockCooldownRef.current) return;
    Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  };

  // Recompute the relative-mouse intent (OR of the two faithful signals) and engage/release
  // pointer-lock to match. Engaging always requires a user gesture, so when not yet locked we
  // only attempt an opportunistic acquire (succeeds inside a gesture, otherwise armed for the
  // next click via handlePointerDown). Releasing happens immediately when intent drops.
  const updatePointerLockIntent = () => {
    const wants = !cursorVisibleRef.current || cursorClippedRef.current
      || mouseCapturedRef.current || cursorWarpingRef.current;
    wantsPointerLockRef.current = wants;
    if (wants) {
      const c = canvasRef.current;
      if (c && document.hasFocus() && !pointerLockedRef.current && !userReleasedLockRef.current) {
        requestPointerLockSafe(c);
      }
    } else if (document.pointerLockElement) {
      pointerLockCooldownRef.current = true;
      document.exitPointerLock();
      setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
    }
  };

  const sabAvailable = typeof SharedArrayBuffer !== "undefined";
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  const secureContext = typeof window !== "undefined" ? window.isSecureContext : true;

  const statusLabel = useMemo(() => {
    if (!browserSupport.supported) return "Unsupported browser";
    if (!sabAvailable) return "SharedArrayBuffer unavailable";
    if (!isolated) return "Cross-origin isolation disabled";
    if (workerStatus === "ready") return "Worker ready";
    if (workerStatus === "error") return "Worker error";
    return "Worker starting";
  }, [browserSupport.supported, sabAvailable, isolated, workerStatus]);

  const resolutionRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    mouseCoordinateModeRef.current = uiSettings.mouseCoordinateMode;
    presentModeRef.current = uiSettings.presentMode;
    uiSettingsRef.current = uiSettings;
    // Apply audio output prefs live (the engine stores them even if its graph isn't built yet).
    audioEngine?.setMasterVolume(uiSettings.masterVolume);
    audioEngine?.setMuted(uiSettings.muted);
    try {
      localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
    } catch {
      // ignore localStorage errors in restricted contexts
    }
  }, [uiSettings]);

  // Keep the pause ref current for the core-I/O effect's callbacks (audio-resume
  // gating). Isolated so pause/resume toggles this cheap effect instead of
  // re-running the monolithic worker/input/audio setup.
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Push the display pacing policy to the worker on change and once the worker is ready.
  // (Re-applied per game load via the loading "done" handler, since present mode resets with
  // the presenter.) For blend mode the ddraw presenter must exist, so the worker no-ops it
  // gracefully until a game is presenting.
  useEffect(() => {
    if (workerStatus !== "ready") return;
    globalWorker?.postMessage({ type: "set_present_mode", mode: uiSettings.presentMode });
  }, [uiSettings.presentMode, workerStatus]);

  // Apply a quality control change: re-validate through mergeQuality (clamps/snaps), update
  // state. Persistence + worker posting are handled by the effect below (single funnel so the
  // re-send-on-load path posts the same object the slider/select path does).
  const handleQualityChange = useCallback((patch: Partial<QualityConfig>) => {
    setQuality((prev) => mergeQuality(prev, patch));
  }, []);

  // Settings-window handlers (shared by the library + in-game drawers).
  const handleToggleStatsOverlay = useCallback((enabled: boolean) => {
    setStatsOverlayEnabled(enabled);
    globalWorker?.postMessage({ type: "toggle_stats_overlay", enabled });
  }, []);
  const handleToggleLogStreaming = useCallback((enabled: boolean) => {
    setLoggingEnabled(enabled);
    try {
      localStorage.setItem("bottleship_logging_enabled", String(enabled));
    } catch {
      // ignore localStorage errors in restricted contexts
    }
  }, []);
  const handleResetSettings = useCallback(() => {
    setUiSettings({ ...DEFAULT_UI_SETTINGS });
    setQuality({ ...DEFAULT_QUALITY });
  }, []);

  // Persist the full quality object + keep the ref current (for the load-"done" re-send) and
  // push it to the worker whenever it changes or the worker becomes ready.
  useEffect(() => {
    qualityRef.current = quality;
    try {
      localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(quality));
    } catch {
      // ignore localStorage errors in restricted contexts
    }
    if (workerStatus !== "ready") return;
    globalWorker?.postMessage({ type: "set_quality", quality });
  }, [quality, workerStatus]);

  const fullscreenAspect = useMemo(() => {
    switch (uiSettings.fullscreenAspectPreset) {
      case "16:9":
        return { w: 16, h: 9 };
      case "16:10":
        return { w: 16, h: 10 };
      case "4:3":
      default:
        return { w: 4, h: 3 };
    }
  }, [uiSettings.fullscreenAspectPreset]);

  const integerScaleSize = useMemo(() => {
    const guestW = Math.max(1, guestResolution.width);
    const guestH = Math.max(1, guestResolution.height);
    const viewW = Math.max(1, viewportSize.width);
    const viewH = Math.max(1, viewportSize.height);
    const scale = Math.max(1, Math.floor(Math.min(viewW / guestW, viewH / guestH)));
    return { width: guestW * scale, height: guestH * scale, scale };
  }, [guestResolution.width, guestResolution.height, viewportSize.width, viewportSize.height]);

  useEffect(() => {
    const syncViewportSize = () => {
      const vv = window.visualViewport;
      const width = Math.max(1, Math.floor(vv?.width ?? window.innerWidth));
      const height = Math.max(1, Math.floor(vv?.height ?? window.innerHeight));
      setViewportSize({ width, height });
    };

    syncViewportSize();
    window.addEventListener("resize", syncViewportSize);
    window.visualViewport?.addEventListener("resize", syncViewportSize);
    document.addEventListener("fullscreenchange", syncViewportSize);

    return () => {
      window.removeEventListener("resize", syncViewportSize);
      window.visualViewport?.removeEventListener("resize", syncViewportSize);
      document.removeEventListener("fullscreenchange", syncViewportSize);
    };
  }, []);

  useEffect(() => {
    if (!browserSupport.supported || !sabAvailable || !isolated) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasCursor = (forceHovered?: boolean) => {
      const hovered = forceHovered ?? isCanvasHoveredRef.current;
      if (!hovered) {
        canvas.style.cursor = "";
        return;
      }
      if (!cursorVisibleRef.current) {
        canvas.style.cursor = "none";
        return;
      }
      // Guest cursor visible: render whatever shape the guest installed (the
      // worker forwards system-theme cursors through the same channel).
      canvas.style.cursor = cursorCssRef.current ?? "default";
    };

    // 1. Initialize Worker (only once)
    if (!globalWorker) {
      globalWorker = new Worker(
        new URL("../worker/emulator.worker.ts", import.meta.url),
        { type: "module" }
      );

      // Expose worker to console for debugging
      (window as any).worker = globalWorker;

      // Persisted debug flags (e.g. __noHeapSlab to A/B the WASM heap slab). Replayed to
      // the worker on EVERY page load BEFORE any game loads, so a toggle survives F5.
      // Set from the console: dbgFlag('__noHeapSlab', true)  → persists + applies live.
      try {
        const flags = JSON.parse(localStorage.getItem("bs_debug_flags") || "{}");
        for (const [key, value] of Object.entries(flags)) {
          globalWorker.postMessage({ type: "set_debug_flag", key, value });
        }
        if (Object.keys(flags).length) console.info("[bs] replayed debug flags:", flags);
      } catch { /* corrupt/no flags */ }
      (window as any).dbgFlag = (key: string, value: unknown) => {
        const flags = JSON.parse(localStorage.getItem("bs_debug_flags") || "{}");
        if (value === undefined || value === null) delete flags[key]; else flags[key] = value;
        localStorage.setItem("bs_debug_flags", JSON.stringify(flags));
        globalWorker?.postMessage({ type: "set_debug_flag", key, value });
        return { [key]: value, note: "persisted; takes effect on next game load" };
      };

      // AI-agent harness facade: window.__BS__.harness. Thin page-side
      // forwarder over harness_rpc + the normalized event bus; logic lives in the
      // worker HarnessService. Coexists with the legacy window.dbg Proxy below.
      installHarnessFacade(globalWorker);

      // Guest debugger bridge: window.dbg.<cmd>(...args) -> worker {type:"dbg"} ->
      // handleDbgCommand() -> wasm dbg_* primitives. Output flows back via console.
      // Usage: dbg.enable(); dbg.bp("0x1309e110"); dbg.stepOnBp(300); then load the game.
      //
      // Dialog instrumentation: the worker posts {type:"dbg_event"} for dialog enumeration
      // (dlgList) and live dialog appearance (dialogShow). We buffer the latest per event so
      // loops can drive game launchers without the worker DevTools:
      //   const d = await window.dbg.waitForEvent("dialogShow");   // catch a launcher dialog
      //   window.dbg.dlgClick("Play Game");                        // faithful click (by title)
      // window.dbg.lastEvent("dlgList") reads the most recent enumeration after dbg.dlgList().
      const dbgLastEvents: Record<string, any> = {};
      const dbgWaiters: Record<string, Array<(d: any) => void>> = {};
      globalWorker?.addEventListener("message", (ev: MessageEvent) => {
        const m = ev.data;
        if (m?.type !== "dbg_event") return;
        dbgLastEvents[m.event] = m.data;
        const ws = dbgWaiters[m.event];
        if (ws && ws.length) {
          dbgWaiters[m.event] = [];
          for (const w of ws) w(m.data);
        }
      });
      (window as any).dbg = new Proxy(
        {},
        {
          get: (_t, cmd: string) => {
            if (cmd === "waitForEvent") {
              return (name: string, timeoutMs = 60000) =>
                new Promise((resolve) => {
                  let done = false;
                  const finish = (d: any) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(d);
                  };
                  const timer = setTimeout(() => finish(null), timeoutMs);
                  (dbgWaiters[name] ??= []).push(finish);
                });
            }
            if (cmd === "lastEvent") return (name: string) => dbgLastEvents[name] ?? null;
            return (...args: any[]) => globalWorker?.postMessage({ type: "dbg", cmd, args });
          },
        }
      );

      // Convenience function: getPixelStats() - returns promise with GetPixel statistics
      (window as any).getPixelStats = () => {
        return new Promise((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "get_pixel_stats") {
              globalWorker!.removeEventListener("message", handler);
              console.table(e.data.stats);
              resolve(e.data.stats);
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "get_pixel_stats" });
        });
      };

      // dbg.snapshot() posts JSON back — usable from MCP without worker DevTools.
      (window as any).dbgSnapshot = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_snapshot") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "dbg snapshot failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "snapshot", args: [] });
        });
      };

      (window as any).dbgGalaxyReport = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_galaxy_report") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "galaxy report failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "galaxyReport", args: [] });
        });
      };

      (window as any).dbgHleReport = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_hle_report") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "hle report failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "hleReport", args: [] });
        });
      };

      // Enable log client for server logging (only in dev mode)
      getLogClient().enable();
    }
    const worker = globalWorker;

    // 2. Initialize SharedArrayBuffer (only once)
    if (!globalSab) {
      console.log('BottleShip: Initializing SharedArrayBuffer');
      globalSab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
      globalInputView = new Int32Array(globalSab);
      setIsBufferInitialized(true);
    }
    const inputBuffer = globalSab;
    if (!audioEngine) {
      audioEngine = new AudioEngine();
      // Apply the persisted output prefs to the fresh engine (volume/mute are stored
      // and take effect when ensureReady() builds the master gain).
      audioEngine.setMasterVolume(uiSettingsRef.current.masterVolume);
      audioEngine.setMuted(uiSettingsRef.current.muted);
    }
    // Resume the AudioContext on the first user gesture anywhere on the page (and
    // auto-recover from later browser suspensions). Without this the context stays
    // SUSPENDED under the autoplay policy → frozen AudioWorklet/SAB play cursor →
    // audio-gated guest logic silently stalls when autoplay policy blocks the AudioContext.
    audioEngine.armAutoResume();
    audioEngine.onEnded = (id: number) => {
      if (globalWorker) {
        globalWorker.postMessage({ type: "audio_ended", id });
      }
    };
    audioEngine.onStatusChange = (id: number, status: "started" | "error", error?: string) => {
      if (globalWorker) {
        if (status === "started") {
          globalWorker.postMessage({ type: "audio_started", id });
        } else if (status === "error") {
          globalWorker.postMessage({ type: "audio_error", id, error: error || "Unknown error" });
        }
      }
    };
    audioEngine.onPosition = (id: number, positionFrames: number) => {
      if (globalWorker) {
        globalWorker.postMessage({ type: "audio_position", id, positionFrames });
      }
    };

    const resize = () => {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const renderWidth = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
      const renderHeight = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

      // Update ref for event calculations (cannot set canvas.width/height anymore)
      resolutionRef.current = { width: renderWidth, height: renderHeight };
      canvasRectRef.current = canvas.getBoundingClientRect();

      const useGuestCoords = mouseCoordinateModeRef.current === "guest";
      const target = useGuestCoords
        ? guestResolutionRef.current
        : { width: renderWidth, height: renderHeight };

      worker.postMessage({ type: "resize", width: target.width, height: target.height });
    };

    // 3. Setup Worker Message Handling
    worker.onmessage = (event: MessageEvent) => {
      //console.log('BottleShip: Worker message received:', event.data?.type);
      
      // Forward logs to server (if enabled)
      if (event.data?.type === "log_stream_entry") {
        // Legacy single-entry format (backward compatibility)
        const entry = event.data.entry;
        if (entry) {
          sendLogToServer({
            timestamp: entry.timestamp || Date.now(),
            category: entry.category || "UNKNOWN",
            level: entry.level ?? 2,
            message: entry.message || "",
          });
        }
      } else if (event.data?.type === "log_stream_batch") {
        // New batch format - process all entries
        const entries = event.data.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            sendLogToServer({
              timestamp: entry.timestamp || Date.now(),
              category: entry.category || "UNKNOWN",
              level: entry.level ?? 2,
              message: entry.message || "",
            });
          }
        }
      } else if (event.data?.type === "seh_runtime_dump") {
        const payload = event.data?.payload;
        const fileStem = typeof payload?.fileStem === "string" ? payload.fileStem : "";
        const manifest = payload?.manifest;
        const bytes = payload?.bytes as ArrayBuffer | undefined;
        if (fileStem && manifest && bytes instanceof ArrayBuffer) {
          const base = `seh-dumps/${fileStem}`;
          const manifestOk = writeDebugFile(`${base}.json`, JSON.stringify(manifest, null, 2));
          const dumpOk = writeDebugFileBase64(`${base}.bin`, bytesToBase64(new Uint8Array(bytes)));
          if (manifestOk && dumpOk) {
            console.log(`BottleShip: SEH runtime dump saved -> logs/${base}.{json,bin}`);
          } else {
            console.warn(`BottleShip: SEH runtime dump not persisted (log server disconnected?) -> ${base}`);
          }
        }
      } else if (event.data?.type === "debug_png_dump") {
        // Worker-side bitmap dump for visual debugging: base64 PNG -> logs/debug/<name>.png
        const name = typeof event.data?.name === "string" ? event.data.name : "dump";
        const base64 = typeof event.data?.base64 === "string" ? event.data.base64 : "";
        if (base64) {
          const ok = writeDebugFileBase64(`debug/${name}.png`, base64);
          console.log(`BottleShip: debug PNG ${ok ? "saved" : "NOT saved (log server?)"} -> logs/debug/${name}.png`);
        }
      }

      if (event.data?.type === "ready") {
        setWorkerStatus("ready");
        // Log streaming to server is manual - use DebugLogViewer "Start Streaming" button
      }
      if (event.data?.type === "fpu_strict_state") {
        // Worker reports the effective FPU mode (manifest fpuStrict / persisted dbg toggle /
        // live button) so the toolbar reflects reality instead of its default.
        setFpuStrictEnabled(!!event.data.strict);
      }
      if (event.data?.type === "error") {
        setWorkerStatus("error");
        setErrorMessage(event.data.message ?? "Worker error");
        // Tear down the launch overlay so the error surfaces instead of a stuck "booting".
        setLoadingProgress(null);
        setIsLoadingApp(false);
      }
      if (event.data?.type === "process_exit") {
        // The guest process called ExitProcess (or crashed → SEH → ExitProcess).
        // The emulator has torn down all threads; reflect a clean exit instead of
        // leaving the last (now stale) frame on screen.
        setExitInfo({
          code: typeof event.data.exitCode === "number" ? event.data.exitCode : 0,
          crashed: !!event.data.crashed,
          fault: event.data.fault ?? undefined,
        });
        // The worker is gone but the worklet keeps rendering whatever ring/legacy
        // sources were still PLAYING — a looping/circular buffer drones the stale
        // ring forever. Silence everything on guest exit.
        audioEngine?.stopAll();
        setLoadingProgress(null);
        setIsLoadingApp(false);
      }
      if (event.data?.type === "bundle_meta") {
        const name = typeof event.data.name === "string" ? event.data.name.trim() : "";
        if (name) setBundleDisplayName(name);
      }
      if (event.data?.type === "loading_progress") {
        const { phase, percent, label } = event.data;
        // A fresh load clears any prior "game exited" state.
        setExitInfo(null);
        if (phase === "done") {
          // PE is loaded but the guest hasn't drawn yet. DON'T hide the overlay here —
          // switch it to an indeterminate "booting" state and keep it up until the worker
          // signals `first_present` (the real first flip). Hiding now exposes a black canvas
          // through CRT/DirectX/asset init.
          setIsLoadingApp(false);
          setLoadingProgress({ phase: "booting", percent: 100, indeterminate: true });
          // Present mode resets with the presenter on each load — re-apply the saved preference.
          if (presentModeRef.current !== "off") {
            globalWorker?.postMessage({ type: "set_present_mode", mode: presentModeRef.current });
          }
          // Quality is a global user pref; the worker layers per-game manifest.quality on top at
          // load, so re-send the saved global pref after each load (like present mode).
          globalWorker?.postMessage({ type: "set_quality", quality: qualityRef.current });
        } else {
          // Byte-counted phases (downloading/caching/installing) show a real bar; the rest
          // (loading/starting) have no measurable progress → indeterminate shimmer.
          const determinate = phase === "downloading" || phase === "caching" || phase === "installing" || phase === "prefetch";
          setLoadingProgress({ phase, percent: percent ?? 0, label, indeterminate: !determinate });
        }
      }
      if (event.data?.type === "first_present") {
        // The guest composited its first real frame — crossfade the launch overlay out.
        setIsLoadingApp(false);
        setLoadingProgress((prev) => (prev ? { ...prev, fadingOut: true } : null));
        if (loadingFadeTimerRef.current !== null) window.clearTimeout(loadingFadeTimerRef.current);
        loadingFadeTimerRef.current = window.setTimeout(() => {
          // Only clear if still fading — a fresh load may have replaced the overlay.
          setLoadingProgress((prev) => (prev?.fadingOut ? null : prev));
          loadingFadeTimerRef.current = null;
        }, 450);
      }
      if (event.data?.type === "install_progress") {
        const { phase, doneBytes, totalBytes } = event.data;
        const doneMb = (doneBytes / 1024 / 1024).toFixed(0);
        const totalMb = totalBytes > 0 ? (totalBytes / 1024 / 1024).toFixed(0) : "?";
        const pct = totalBytes > 0 ? Math.round(doneBytes / totalBytes * 100) : 0;
        setIsLoadingApp(true);
        setLoadingProgress({
          phase: phase === "installing" ? "installing" : phase,
          percent: pct,
          label: phase === "installing" ? `${doneMb} / ${totalMb} MB` : phase,
          indeterminate: phase !== "installing",
        });
        if (phase === "starting") {
          setLoadingProgress({ phase: "starting", percent: 100, label: "", indeterminate: true });
        }
      }
      if (event.data?.type === "installer_unsupported") {
        setIsLoadingApp(false);
        setLoadingProgress(null);
        setErrorMessage(event.data.message ?? "This installer format is not supported.");
      }
      if (event.data?.type === "capture_frame") {
        if (!capturePending) return;
        if (event.data?.ok) {
          const blob = new Blob([event.data.buffer], { type: "image/png" });
          capturePending.resolve(blob);
        } else {
          capturePending.reject(new Error(event.data?.error ?? "Capture failed"));
        }
        capturePending = null;
      }
      if (event.data?.type === "render_stats") {
        if (!statsPending) return;
        if (event.data?.ok) {
          statsPending.resolve(event.data?.stats ?? {});
        } else {
          statsPending.reject(new Error(event.data?.error ?? "Stats request failed"));
        }
        statsPending = null;
      }
      if (event.data?.type === "msg_timer_diag" || event.data?.type === "h3_timer_diag") {
        const label = event.data.type;
        if (event.data?.ok) {
          console.log(`BottleShip: ${label}`, event.data?.config ?? null);
        } else {
          console.warn(`BottleShip: ${label} error`, event.data?.error ?? "unknown");
        }
      }
      if (event.data?.type === "ui_gate_diag" || event.data?.type === "h3_gate_diag") {
        const label = event.data.type;
        if (event.data?.ok) {
          console.log(`BottleShip: ${label}`, event.data?.config ?? null);
        } else {
          console.warn(`BottleShip: ${label} error`, event.data?.error ?? "unknown");
        }
      }
      if (event.data?.type === "log_verbose_export") {
        if (!verboseLogPending) return;
        if (event.data?.ok) {
          verboseLogPending.resolve(String(event.data?.text ?? ""));
        } else {
          verboseLogPending.reject(new Error(event.data?.error ?? "Log export failed"));
        }
        verboseLogPending = null;
      }
      if (event.data?.type === "log_verbose_clear") {
        if (event.data?.ok) {
          console.log("BottleShip: Verbose logs cleared");
        } else {
          console.error("BottleShip: Failed to clear verbose logs:", event.data?.error);
        }
      }
      if (event.data?.type === "diag_download") {
        const content = String(event.data?.content ?? "");
        const filename = String(event.data?.filename ?? "diag.txt");
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      }
      if (event.data?.type === "audio_play") {
        audioEngine?.play(event.data?.payload as AudioPlayPayload);
      }
      if (event.data?.type === "audio_play_encoded") {
        audioEngine?.playEncoded(event.data?.payload as AudioPlayEncodedPayload);
      }
      if (event.data?.type === "audio_stop") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.stop(id);
      }
      if (event.data?.type === "audio_pause") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.pauseSource(id);
      }
      if (event.data?.type === "audio_resume") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.resumeSource(id);
      }
      if (event.data?.type === "audio_seek") {
        const id = Number(event.data?.payload?.id ?? 0);
        const timeMs = Number(event.data?.payload?.timeMs ?? 0);
        if (id) audioEngine?.seekSource(id, timeMs);
      }
      if (event.data?.type === "audio_update") {
        const payload = event.data?.payload as AudioUpdatePayload;
        if (payload?.id) {
          audioEngine?.update(payload);
        }
      }
      if (event.data?.type === "audio_append") {
        const payload = event.data?.payload as { id: number; data: Float32Array };
        if (payload?.id && payload?.data) {
          audioEngine?.append(payload);
        }
      }
      if (event.data?.type === "audio_replace") {
        const payload = event.data?.payload as { id: number; data: Float32Array; channels: number };
        if (payload?.id && payload?.data) {
          audioEngine?.replace(payload);
        }
      }
      if (event.data?.type === "audio_register") {
        const id = Number(event.data?.payload?.id ?? 0);
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (id && sab) {
          // Resume AudioContext immediately — video may start before a user gesture,
          // but the user likely already clicked (load game) so the gesture is in the past.
          void audioEngine?.resume();
          audioEngine?.registerBuffer(id, sab);
        }
      }
      if (event.data?.type === "audio_unregister") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.unregisterBuffer(id);
      }
      if (event.data?.type === "audio_listener_sab") {
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (sab) audioEngine?.registerListenerSab(sab);
      }
      if (event.data?.type === "audio_stats_sab") {
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (sab) audioEngine?.registerStatsSab(sab);
      }
      // video_frame and video_end are handled in the worker via WebGPU compositor (smackw32.ts → backend.composite)
      if (event.data?.type === "cursor_visibility") {
        const visible = event.data?.visible !== false;
        cursorVisibleRef.current = visible;
        updateCanvasCursor();
        // Engage/release pointer-lock on the faithful relative signal (hidden OR clipped).
        updatePointerLockIntent();
      }
      if (event.data?.type === "cursor_image") {
        // Guest installed a cursor shape: null pixels = system shape (classic arrow).
        const px = event.data?.pixels as ArrayBuffer | null;
        const w = Number(event.data?.width) | 0;
        const h = Number(event.data?.height) | 0;
        cursorCssRef.current = null;
        if (px && w > 0 && h > 0 && px.byteLength >= w * h * 4) {
          try {
            const cnv = document.createElement("canvas");
            cnv.width = w;
            cnv.height = h;
            const c2d = cnv.getContext("2d");
            if (c2d) {
              c2d.putImageData(new ImageData(new Uint8ClampedArray(px, 0, w * h * 4), w, h), 0, 0);
              const hx = Math.min(Math.max(Number(event.data?.hotspotX) | 0, 0), w - 1);
              const hy = Math.min(Math.max(Number(event.data?.hotspotY) | 0, 0), h - 1);
              cursorCssRef.current = `url("${cnv.toDataURL()}") ${hx} ${hy}, default`;
            }
          } catch { /* malformed image — classic arrow fallback */ }
        }
        updateCanvasCursor();
      }
      if (event.data?.type === "clip_cursor") {
        // Guest ClipCursor(rect) confines the cursor (relative/captured mouse, e.g. Unreal
        // SetMouseCapture); ClipCursor(NULL) releases it. Feed it into the same intent as
        // ShowCursor so confined-but-visible games also engage pointer-lock.
        cursorClippedRef.current = event.data?.clip === true;
        updatePointerLockIntent();
      }
      if (event.data?.type === "mouse_capture") {
        // Guest acquired/released an exclusive-mode DirectInput mouse. On real Windows this
        // implicitly captures the cursor (relative mode) with no ShowCursor/ClipCursor call,
        // so feed it into the same intent to engage/release pointer-lock.
        mouseCapturedRef.current = event.data?.capture === true;
        updatePointerLockIntent();
      }
      if (event.data?.type === "cursor_warp") {
        // Guest is warp-bursting SetCursorPos (relative-mouse emulation) — SetCursorPos can
        // only be honored under pointer lock, so treat it as a capture signal.
        cursorWarpingRef.current = event.data?.active === true;
        updatePointerLockIntent();
      }
      if (event.data?.type === "set_cursor_pos") {
        // Guest called SetCursorPos — update virtual cursor so next movement continues from here
        const x = Number(event.data.x) | 0;
        const y = Number(event.data.y) | 0;
        virtualMouseRef.current = { x, y };
        if (pointerLockedRef.current && globalInputView) {
          beginInputWrite(globalInputView);
          globalInputView[INPUT_INDEX.mouseX] = x;
          globalInputView[INPUT_INDEX.mouseY] = y;
          endInputWrite(globalInputView);
        }
      }
      if (event.data?.type === "show_message_box") {
        const { id, text, caption, uType } = event.data;
        const targetWorker = event.target as Worker;
        const isDevMode = new URLSearchParams(window.location.search).get("game") === "dev";
        const typeMask = (Number(uType) || 0) & 0xf;
        // Harness auto-modal: consult the single resolver. If it returns a
        // button id, answer immediately and render nothing (no stale overlay); null =
        // defer to the normal dev-modal / non-dev auto-reply below.
        const autoReply = (window as any).__BS__?.harness?.autoModalReply?.({ text, caption });
        if (typeof autoReply === "number") {
          targetWorker.postMessage({ type: "message_box_result", id, result: autoReply });
        } else if (isDevMode) {
          // Non-blocking in-page dialog (replaces window.alert/confirm, which froze
          // the page main thread → broke screenshots/CDP). Result is posted back to
          // the worker when the user picks a button (see the MessageBox dialog JSX).
          setMessageBox({ id, text: text || "", caption: caption || "", typeMask, worker: targetWorker });
        } else {
          // suppressed — already logged via Logger in dialog.ts
          targetWorker.postMessage({ type: "message_box_result", id, result: 1 });
        }
      }
      if (event.data?.type === "app_resize") {
        const width = Math.max(1, Number(event.data.width) || 1);
        const height = Math.max(1, Number(event.data.height) || 1);
        guestResolutionRef.current = { width, height };
        setGuestResolution({ width, height });
        // Expose for the harness UI-overlay tool (gridShot): maps guest pixels —
        // the space clickAt() injects into — onto the on-screen canvas rect.
        ((window as any).__BS__ ??= {}).guestResolution = { width, height };
        if (canvas) {
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          canvasRectRef.current = canvas.getBoundingClientRect();
          if (mouseCoordinateModeRef.current === "guest") {
            worker.postMessage({ type: "resize", width, height });
          } else {
            resize();
          }
          // The rect captured above is PRE-reflow: setGuestResolution() schedules a
          // React re-render that updates style.aspectRatio, and the flex-centered canvas
          // shifts position once that render + layout settles. A size-only ResizeObserver
          // does NOT fire on a position-only shift, so canvasRectRef would keep a stale
          // left/top offset → absolute mouse coords get shifted (e.g. menu at top-left
          // maps to clamped 0,0). Re-capture after layout settles (double rAF = after paint).
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (canvasRef.current) canvasRectRef.current = canvasRef.current.getBoundingClientRect();
          }));
        }
      }
      if (event.data?.type === "window_title") {
        const title = String(event.data.title || "");
        document.title = title ? `${title} — BottleShip` : "BottleShip";
      }
      if (event.data?.type === "window_icon") {
        const buffer = event.data.data as ArrayBuffer | undefined;
        if (buffer && buffer.byteLength > 0) {
          const blob = new Blob([buffer], { type: "image/x-icon" });
          const url = URL.createObjectURL(blob);
          // Replace or create <link rel="icon">
          let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
          if (!link) {
            link = document.createElement("link");
            link.rel = "icon";
            document.head.appendChild(link);
          }
          // Revoke previous blob URL to avoid memory leak
          if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
          link.type = "image/x-icon";
          link.href = url;
        }
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      setWorkerStatus("error");
      setErrorMessage(event.message);
    };

    // 4. Initialize Offscreen Control (only once)
    if (!globalOffscreen) {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

      resolutionRef.current = { width, height };

      try {
        globalOffscreen = canvas.transferControlToOffscreen();
        console.log('BottleShip: Sending init to worker (new canvas)');
        worker.postMessage(
          {
            type: "init",
            canvas: globalOffscreen,
            inputBuffer,
            width,
            height
          },
          [globalOffscreen]
        );
      } catch (err) {
        console.warn('BottleShip: Failed to transfer control (maybe already transferred), signaling worker anyway');
        worker.postMessage({ type: "init" });
      }
    } else {
      console.log('BottleShip: Already have offscreen canvas, signaling worker');
      const { width, height } = resolutionRef.current;
      worker.postMessage({
        type: "init",
        inputBuffer,
        width,
        height
      });
    }


    // Initial resize to sync measurement
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    // 5. Input Handlers
    const writePointer = (event: PointerEvent) => {
      const inputView = globalInputView;
      if (!inputView) return;

      // Opportunistic re-acquire after an ESC-exit: if the guest still wants relative mouse and
      // the user didn't deliberately release (Right Ctrl), retry on pointermove. Many browsers
      // don't treat pointermove as a valid activation gesture, so this is best-effort — the
      // reliable path is the canvas click in handlePointerDown. Guarded so a rejection is silent.
      if (
        !pointerLockedRef.current &&
        wantsPointerLockRef.current &&
        !userReleasedLockRef.current &&
        !pointerLockCooldownRef.current &&
        document.hasFocus()
      ) {
        try { requestPointerLockSafe(canvas); } catch { /* not a valid gesture in this browser */ }
      }

      // --- Pointer Lock mode: use relative movementX/Y, skip canvas bounds check ---
      if (pointerLockedRef.current) {
        const pointerSpace =
          mouseCoordinateModeRef.current === "guest"
            ? guestResolutionRef.current
            : resolutionRef.current;
        const width  = Math.max(1, pointerSpace.width);
        const height = Math.max(1, pointerSpace.height);
        const rect   = canvasRectRef.current ?? canvas.getBoundingClientRect();
        const scaleX = width  / Math.max(1, rect.width);
        const scaleY = height / Math.max(1, rect.height);
        const virt   = virtualMouseRef.current;
        virt.x = Math.max(0, Math.min(width  - 1, virt.x + event.movementX * scaleX));
        virt.y = Math.max(0, Math.min(height - 1, virt.y + event.movementY * scaleY));
        beginInputWrite(inputView);
        inputView[INPUT_INDEX.mouseX]  = Math.round(virt.x);
        inputView[INPUT_INDEX.mouseY]  = Math.round(virt.y);
        inputView[INPUT_INDEX.buttons] = event.buttons;
        // DirectInput reports RAW device deltas (relative axes), NOT canvas-scaled — feed the
        // accumulator unscaled movementX/Y. The virtual cursor above stays scaled (CSS→guest).
        // (dinputDX/DY are independent atomic accumulators, not part of the seqlock snapshot.)
        Atomics.add(inputView, INPUT_INDEX.dinputDX, Math.round(event.movementX));
        Atomics.add(inputView, INPUT_INDEX.dinputDY, Math.round(event.movementY));
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
        return;
      }

      // --- Normal absolute mode ---
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect();

      // When pointer is captured (button held), process events even outside canvas
      const hasCaptured = canvas.hasPointerCapture(event.pointerId);
      const insideCanvas = event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!insideCanvas && !hasCaptured) {
        if (isCanvasHoveredRef.current) {
          handlePointerLeave(event);
        }
        return;
      }

      const pointerSpace =
        mouseCoordinateModeRef.current === "guest"
          ? guestResolutionRef.current
          : resolutionRef.current;
      const width = Math.max(1, pointerSpace.width);
      const height = Math.max(1, pointerSpace.height);

      // Coordinate scaling: mouse events are in client/CSS pixels
      // We map them to the virtual resolution [0..width/height]
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const x = Math.max(0, Math.min(width, (event.clientX - rect.left) * scaleX));
      const y = Math.max(0, Math.min(height, (event.clientY - rect.top) * scaleY));

      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = Math.round(x);
      inputView[INPUT_INDEX.mouseY] = Math.round(y);
      inputView[INPUT_INDEX.buttons] = event.buttons;
      Atomics.add(inputView, INPUT_INDEX.dinputDX, Math.round(event.movementX * scaleX));
      Atomics.add(inputView, INPUT_INDEX.dinputDY, Math.round(event.movementY * scaleY));
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };

    const handlePointerEnter = () => {
      isCanvasHoveredRef.current = true;
      updateCanvasCursor(true);
      const inputView = globalInputView;
      if (inputView && inputView[INPUT_INDEX.mouseInside] === 0) {
        beginInputWrite(inputView);
        inputView[INPUT_INDEX.mouseInside] = 1;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
    };

    const handlePointerLeave = (event?: PointerEvent) => {
      if (!isCanvasHoveredRef.current) return;
      // Don't leave if pointer is captured (button held down while moving outside)
      if (event && canvas.hasPointerCapture(event.pointerId)) return;

      isCanvasHoveredRef.current = false;
      updateCanvasCursor(false);
      const inputView = globalInputView;
      if (!inputView) return;

      // Always signal mouse-outside so InputManager can fire WM_MOUSELEAVE
      const insideChanged  = inputView[INPUT_INDEX.mouseInside] !== 0;
      const buttonsChanged = inputView[INPUT_INDEX.buttons] !== 0;
      if (insideChanged || buttonsChanged) {
        beginInputWrite(inputView);
        if (insideChanged)  inputView[INPUT_INDEX.mouseInside] = 0;
        if (buttonsChanged) inputView[INPUT_INDEX.buttons] = 0;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };

    const handleKey = (event: KeyboardEvent, state: number) => {
      const inputView = globalInputView;
      if (!inputView) return;

      // F11 = host fullscreen (Element Fullscreen API on the canvas panel). Not forwarded
      // to the guest — browsers reserve F11 for chrome fullscreen, and our hint advertises it.
      if (event.code === "F11") {
        event.preventDefault();
        event.stopPropagation();
        if (state === 1) toggleFullscreenRef.current();
        return;
      }

      // Right Ctrl = deliberate host-release key for pointer lock. When locked, release and
      // suppress auto re-acquire (handlePointerLockChange / updatePointerLockIntent) until the
      // next explicit canvas click. Consumed as a host key (not forwarded to the guest) so it
      // can't be confused with an in-game RControl bind while it's the escape hatch.
      // (ESC is left untouched — the browser force-exits lock on ESC and it must still reach
      // the guest as the menu key.)
      if (event.code === "ControlRight" && state === 1) {
        if (pointerLockedRef.current || document.pointerLockElement) {
          userReleasedLockRef.current = true;
          pointerLockCooldownRef.current = true;
          document.exitPointerLock();
          setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      // Pointer-locked: swallow browser chrome handling (Tab focus cycle, Alt menus, …)
      // so keys like Max Payne's painkiller Tab reach the guest. Capture-phase listeners
      // (below) run before focus navigation. ESC stays un-preventDefault'd so the UA can
      // exit lock; we still forward it to the guest as the menu key.
      if (pointerLockedRef.current || document.pointerLockElement === canvas) {
        if (event.code !== "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }

      if (!isPausedRef.current && state === 1) {
        void audioEngine?.resume();
      }

      // Update pressed keys set and serialize to bitfield
      const vk = event.keyCode & 0xff;
      if (state === 1) {
        pressedKeys.add(vk);
      } else {
        pressedKeys.delete(vk);
      }
      beginInputWrite(inputView);
      syncKeyBitfield(inputView);

      // Clear legacy single-event slots (deprecated)
      inputView[INPUT_INDEX.keyCode] = 0;
      inputView[INPUT_INDEX.keyState] = 0;

      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: vk,
          keyState: state,
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };


    const handleKeyDown = (event: KeyboardEvent) => handleKey(event, 1);
    const handleKeyUp = (event: KeyboardEvent) => handleKey(event, 0);

    const handlePointerDown = (event: PointerEvent) => {
      // Capture pointer to receive events even when cursor leaves canvas.
      // Guarded: throws InvalidStateError if the pointer was released before
      // this handler ran (fast tap, synthetic events, etc.) — safe to ignore.
      try { canvas.setPointerCapture(event.pointerId); } catch { }
      // A deliberate click on the canvas is the re-engage gesture: clear the Right-Ctrl
      // host-release suppression so lock can be re-acquired.
      userReleasedLockRef.current = false;
      // If cursor is hidden by guest, request pointer lock (user click = valid gesture)
      if (wantsPointerLockRef.current && !pointerLockedRef.current) {
        requestPointerLockSafe(canvas);
        // Still forward this click — before pointer lock is acquired, absolute coords
        // are still valid (pointermove has been syncing them). Without forwarding,
        // button state never reaches the SAB and the game never sees WM_LBUTTONDOWN.
        // Games like HoMM3 call ShowCursor(FALSE) to draw a custom cursor but still
        // rely on WndProc mouse messages for click handling.
      }
      if (!isPausedRef.current) {
        void audioEngine?.resume();
      }
      writePointer(event);
    };

    const handlePointerUp = (event: PointerEvent) => {
      // Release capture (usually automatic, but be explicit)
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      writePointer(event);
    };

    const handleContextMenu = (event: Event) => {
      event.preventDefault();
    };

    canvas.addEventListener("pointermove", writePointer);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerenter", handlePointerEnter);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("contextmenu", handleContextMenu);
    
    const handleWheel = (event: WheelEvent) => {
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect();
      const inputView = globalInputView;
      if (!inputView) return;

      const insideCanvas = event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!insideCanvas) return;

      const pointerSpace =
        mouseCoordinateModeRef.current === "guest"
          ? guestResolutionRef.current
          : resolutionRef.current;
      const width = Math.max(1, pointerSpace.width);
      const height = Math.max(1, pointerSpace.height);

      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const x = Math.max(0, Math.min(width, (event.clientX - rect.left) * scaleX));
      const y = Math.max(0, Math.min(height, (event.clientY - rect.top) * scaleY));

      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = Math.round(x);
      inputView[INPUT_INDEX.mouseY] = Math.round(y);
      // Normalize deltaY to CSS pixel equivalent regardless of deltaMode:
      //   DOM_DELTA_PIXEL (0): use as-is (~100px per notch → InputManager * 1.2 ≈ 120 WHEEL_DELTA)
      //   DOM_DELTA_LINE  (1): ~33px per line; 3 lines/notch → 99px → * 1.2 ≈ 120
      //   DOM_DELTA_PAGE  (2): ~500px per page → * 1.2 = 600 = 5 notches (sensible for page-scroll)
      let pixelDelta: number;
      switch (event.deltaMode) {
        case 1: pixelDelta = event.deltaY * 33;  break; // DOM_DELTA_LINE
        case 2: pixelDelta = event.deltaY * 500; break; // DOM_DELTA_PAGE
        default: pixelDelta = event.deltaY;              // DOM_DELTA_PIXEL
      }
      inputView[INPUT_INDEX.mouseWheel] = Math.round(pixelDelta);
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel],
        });
      }
      
      // Prevent default scrolling behavior when over canvas
      event.preventDefault();
    };
    
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    // Capture phase: Tab focus-navigation runs before bubble, so we must see keys while
    // pointer-locked before the browser moves focus off the canvas.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    // Pointer lock change: update locked state and seed virtual cursor from current position.
    // The click that engages pointer lock already wrote correct absolute coordinates to the
    // SAB (handlePointerDown calls writePointer before lock is acquired). Seeding virtualMouse
    // from those coordinates keeps the game cursor where the user clicked — matching real
    // Windows behavior where ShowCursor(FALSE) doesn't move the cursor. Seeding at screen
    // center would make LBUTTONUP jump to (width/2, height/2) mid-click (drag mismatch).
    const handlePointerLockChange = () => {
      pointerLockedRef.current = document.pointerLockElement === canvas;
      if (pointerLockedRef.current) {
        const iv = globalInputView;
        if (iv) {
          // Seed from the last absolute position already in the SAB
          virtualMouseRef.current = {
            x: iv[INPUT_INDEX.mouseX],
            y: iv[INPUT_INDEX.mouseY],
          };
        } else {
          // Fallback: center of guest resolution
          const guest = guestResolutionRef.current;
          virtualMouseRef.current = {
            x: Math.round(guest.width / 2),
            y: Math.round(guest.height / 2),
          };
        }
        // No SAB write needed — position hasn't changed
      } else {
        // Lock was lost (commonly ESC, which is also Unreal's menu key — the browser
        // force-exits lock on ESC). If the guest still wants relative mouse and the user did
        // NOT deliberately release via Right Ctrl, arm a re-acquire. handlePointerDown
        // re-requests on the next click (the reliable gesture); we also opportunistically
        // attempt on the next pointermove via writePointer.
        if (wantsPointerLockRef.current && !userReleasedLockRef.current) {
          // ESC force-exit briefly rejects re-acquire; cooldown gates the click/move retries.
          pointerLockCooldownRef.current = true;
          setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
        }
      }
    };
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    const unlockAudio = () => {
      if (!isPausedRef.current) {
        void audioEngine?.resume();
      }
    };
    window.addEventListener("pointerdown", unlockAudio, { passive: true });

    // Clear all pressed keys on focus loss to prevent stuck keys
    const handleBlur = () => {
      pressedKeys.clear();
      const inputView = globalInputView;
      if (inputView) {
        beginInputWrite(inputView);
        syncKeyBitfield(inputView); // all zeros
        inputView[INPUT_INDEX.buttons] = 0; // mouse buttons too
        inputView[INPUT_INDEX.keyCode] = 0;
        inputView[INPUT_INDEX.keyState] = 0;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) handleBlur();
    };

    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Gamepad polling + input-status overlay live in their own focused effect
    // (see the "Gamepad polling" effect below) so they don't share this effect's
    // teardown churn. Self-contained: only globalInputView + setInputStatus.

    // Automation Hook
    // Automation: HLE must be enabled before PE load (galaxy.dll hooks).
    (window as any).enableHleAndLoad = async (path: string, logOnly = false, galaxyHleMixer = true) => {
      if (!globalWorker) { console.error("BottleShip: Worker not initialized"); return; }
      console.log(`BottleShip: enableHleAndLoad logOnly=${logOnly} mixer=${galaxyHleMixer} → ${path}`);
      rotateLogFile((path.split(/[\\/]/).pop()?.replace(/\.wgb$/i, "") || "game") + "-hle");
      setIsLoadingApp(true);
      setErrorMessage(null);
      setBundleDisplayName(null);
      canvasRef.current?.focus();
      const lower = path.toLowerCase();
      if (lower.endsWith(".wgb")) {
        setLoadingProgress({ phase: "loading", percent: 0, label: "" });
        globalWorker.postMessage({ type: "load_bundle", url: path, galaxyHle: true, hleLogOnly: logOnly, galaxyHleMixer: galaxyHleMixer });
        return;
      }
      // Non-WGB: enable then fall through to fetch path.
      globalWorker.postMessage({ type: "hle_enable", logOnly });
      await new Promise((r) => setTimeout(r, 50));
      return (window as any).loadApp(path);
    };

    (window as any).loadApp = async (path: string) => {
      console.log(`BottleShip: Loading App from ${path}`);
      rotateLogFile(path.split(/[\\/]/).pop()?.replace(/\.wgb$/i, "") || "game");
      ensurePersistentStorageRequested();
      setIsLoadingApp(true);
      setErrorMessage(null); // Clear any previous errors
      setExitInfo(null); // Fresh load supersedes a prior exit/crash overlay
      setBundleDisplayName(null);
      audioEngine?.stopAll(); // Silence stale ring buffers from the previous game
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        setIsLoadingApp(false);
        return;
      }
      canvasRef.current?.focus();
      const lower = path.toLowerCase();
      if (lower.endsWith(".wgb")) {
        setLoadingProgress({ phase: "loading", percent: 0, label: "" });
        globalWorker.postMessage({ type: "load_bundle", url: path });
        return;
      }
      try {
        const resp = await fetch(path);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        const buf = await resp.arrayBuffer();
        globalWorker.postMessage({
          type: "load_pe",
          data: new Uint8Array(buf)
        });
        setIsLoadingApp(false);
      } catch (e) {
        const errorMessage = `Failed to load app from ${path}: ${e instanceof Error ? e.message : String(e)}`;
        console.error("BottleShip:", errorMessage);
        setErrorMessage(errorMessage);
        setIsLoadingApp(false);
        setLoadingProgress(null);
      }
    };

    const applyInputSample = (sample: InputSample) => {
      const inputView = globalInputView;
      if (!inputView) return;
      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = sample.mouseX;
      inputView[INPUT_INDEX.mouseY] = sample.mouseY;
      inputView[INPUT_INDEX.buttons] = sample.buttons;
      inputView[INPUT_INDEX.keyCode] = sample.keyCode;
      inputView[INPUT_INDEX.keyState] = sample.keyState;
      inputView[INPUT_INDEX.gamepadConnected] = sample.gamepadConnected;
      inputView[INPUT_INDEX.gamepadButtons] = sample.gamepadButtons;
      inputView[INPUT_INDEX.gamepadAxis0] = sample.gamepadAxis0;
      inputView[INPUT_INDEX.gamepadAxis1] = sample.gamepadAxis1;
      inputView[INPUT_INDEX.gamepadAxis2] = sample.gamepadAxis2;
      inputView[INPUT_INDEX.gamepadAxis3] = sample.gamepadAxis3;
      inputView[INPUT_INDEX.mouseWheel] = sample.mouseWheel ?? 0;
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
    };

    (window as any).startRecording = () => {
      recordedInputs = [];
      recordStart = performance.now();
      isRecording = true;
      console.log("BottleShip: Recording started");
    };

    (window as any).stopRecording = () => {
      isRecording = false;
      console.log(`BottleShip: Recording stopped (${recordedInputs.length} samples)`);
      return recordedInputs.slice();
    };

    (window as any).playRecording = (recording: InputSample[], options?: { deterministic?: boolean }) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (!recording || recording.length === 0) {
        console.warn("BottleShip: No recording provided");
        return;
      }

      const deterministic = options?.deterministic ?? true;
      const sorted = [...recording].sort((a, b) => a.t - b.t);
      const baseTime = sorted[0]?.t ?? 0;
      let index = 0;
      let timeoutId: number | null = null;

      const finishReplay = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (deterministic) {
          globalWorker?.postMessage({ type: "time_mode", mode: "realtime" });
          globalWorker?.postMessage({ type: "replay_mode", enabled: false });
        }
      };

      const scheduleNext = () => {
        if (index >= sorted.length) {
          finishReplay();
          return;
        }

        const sample = sorted[index];
        const relativeTime = Math.max(0, sample.t - baseTime);
        if (deterministic) {
          globalWorker?.postMessage({ type: "time_set", nowMs: relativeTime });
        }
        applyInputSample(sample);
        index++;

        if (index >= sorted.length) {
          finishReplay();
          return;
        }

        const delay = Math.max(0, sorted[index].t - sample.t);
        timeoutId = window.setTimeout(scheduleNext, delay);
      };

      if (deterministic) {
        globalWorker.postMessage({ type: "time_mode", mode: "manual", nowMs: 0, unixMs: Date.now() });
        globalWorker.postMessage({ type: "replay_mode", enabled: true });
      }

      scheduleNext();
    };

    (window as any).captureFrame = async () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (capturePending) {
        console.warn("BottleShip: Capture already in progress");
        return;
      }
      const capturePromise = new Promise<Blob>((resolve, reject) => {
        capturePending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "capture_frame" });
      try {
        const blob = await capturePromise;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "frame.png";
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("BottleShip: Capture failed", err);
      }
    };

    (window as any).renderStats = async () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (statsPending) {
        console.warn("BottleShip: Stats request already in progress");
        return;
      }
      const statsPromise = new Promise<Record<string, number>>((resolve, reject) => {
        statsPending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "render_stats" });
      try {
        const stats = await statsPromise;
        console.log("BottleShip: Render stats", stats);
      } catch (err) {
        console.error("BottleShip: Stats failed", err);
      }
    };

    const postMsgTimerDiag = (payload: Record<string, unknown>, legacy = false) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: legacy ? "h3_timer_diag" : "msg_timer_diag", ...payload });
    };
    const postUiGateDiag = (payload: Record<string, unknown>, legacy = false) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: legacy ? "h3_gate_diag" : "ui_gate_diag", ...payload });
    };

    const bindTimerDiagApi = (prefix: string, legacy: boolean) => {
      (window as any)[`${prefix}SetEnabled`] = (enabled: boolean = true) => {
        postMsgTimerDiag({ enabled: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetIntervalMs`] = (logIntervalMs: number = 500) => {
        postMsgTimerDiag({ logIntervalMs: Number(logIntervalMs) }, legacy);
      };
      (window as any)[`${prefix}SetQueueSkipped`] = (queueSkipped: boolean = true) => {
        postMsgTimerDiag({ queueSkipped: Boolean(queueSkipped) }, legacy);
      };
      (window as any)[`${prefix}SetFlushMax`] = (flushMax: number = 4) => {
        postMsgTimerDiag({ flushMax: Number(flushMax) }, legacy);
      };
      (window as any)[`${prefix}GetConfig`] = () => {
        postMsgTimerDiag({}, legacy);
      };
      (window as any)[`${prefix}LogNow`] = () => {
        postMsgTimerDiag({ logNow: true }, legacy);
      };
    };
    bindTimerDiagApi("msgTimerDiag", false);
    bindTimerDiagApi("h3TimerDiag", true); // deprecated alias

    const bindUiGateDiagApi = (prefix: string, legacy: boolean) => {
      (window as any)[`${prefix}SetForceScreenObj`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceScreenObjFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetForceAdvMap`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceAdvMapFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetForceGameScreenChildList`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceGameScreenChildListFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}GetConfig`] = () => {
        postUiGateDiag({}, legacy);
      };
    };
    bindUiGateDiagApi("uiGateDiag", false);
    bindUiGateDiagApi("h3GateDiag", true); // deprecated alias

    (window as any).enableVerboseLogCapture = (enabled: boolean = true) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: "log_verbose_enable", enabled });
    };

    const requestVerboseLogExport = () => {
      if (!globalWorker) {
        return Promise.reject(new Error("Worker not initialized"));
      }
      if (verboseLogPending) {
        return Promise.reject(new Error("Log export already in progress"));
      }
      const promise = new Promise<string>((resolve, reject) => {
        verboseLogPending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "log_verbose_export" });
      return promise;
    };

    const downloadVerboseLog = async () => {
      try {
        const text = await requestVerboseLogExport();
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "bottleship-verbose.log";
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("BottleShip: Log export failed", err);
      }
    };

    (window as any).downloadVerboseLog = downloadVerboseLog;

    const clearVerboseLog = () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: "log_verbose_clear" });
    };

    (window as any).clearVerboseLog = clearVerboseLog;

    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      document.removeEventListener("fullscreenchange", resize);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", writePointer);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerenter", handlePointerEnter);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      // Keep loadApp exposed for buttons
    };
    // Deps are mount-stable only. Pause/load/worker-ready are read via refs
    // (isPausedRef) or module globals (globalWorker), NOT captured here — so a
    // pause or load_bundle does not tear down and recreate the worker wiring,
    // audio engine, input listeners, and window API.
  }, [browserSupport.supported, sabAvailable, isolated]);

  // Gamepad polling + input-status overlay. Split out of the core-I/O effect: a
  // self-contained rAF poll that only needs globalInputView (SAB) and setInputStatus,
  // with its own teardown (cancel rAF + release the gamepad cache). Same mount-stable
  // deps as the core effect; the SAB is created there before this runs (and pollGamepad
  // no-ops until globalInputView exists), so ordering is safe.
  useEffect(() => {
    if (!browserSupport.supported || !sabAvailable || !isolated) return;

    const teardownGamepadCache = initGamepadCache();

    let gamepadRafId: number | null = null;
    let lastGamepadConnected = 0;
    let lastGamepadButtons = 0;
    let lastGamepadAxes = [0, 0, 0, 0];

    // Input-status overlay: derive "game is using the pad" from the worker's
    // guestGamepadSeq counter (bumped on DInput Acquire/GetDeviceState / joyGetPosEx).
    // A bump keeps the "active" state alive for a short window so per-frame polling
    // reads as steady use and a game that stops polling decays back to "connected".
    let lastGuestGamepadSeq = -1;
    let guestActiveUntil = 0;          // performance.now() timestamp the active state expires at
    let shownPadConnected = false;
    let shownGuestActive = false;
    let shownPadLabel: string | null = null;
    const GUEST_ACTIVE_WINDOW_MS = 700;

    const clampAxis = (value: number): number => Math.max(-1, Math.min(1, value || 0));

    const pollGamepad = () => {
      const inputView = globalInputView;
      if (inputView) {
        const livePad = readLiveGamepad();
        if (livePad) rescanGamepads();
        const cachedMeta = getCachedGamepadMeta();
        const pad = livePad;
        const connected = livePad ? 1 : cachedMeta ? 1 : 0;
        let buttonsMask = 0;
        const axes = [0, 0, 0, 0];

        if (pad) {
          const buttons = pad.buttons ?? [];
          for (let i = 0; i < Math.min(16, buttons.length); i++) {
            if (buttons[i]?.pressed) buttonsMask |= (1 << i);
          }
          const rawAxes = pad.axes ?? [];
          for (let i = 0; i < 4; i++) {
            axes[i] = Math.round(clampAxis(rawAxes[i] ?? 0) * 32767);
          }
        }

        const changed = connected !== lastGamepadConnected ||
          buttonsMask !== lastGamepadButtons ||
          axes[0] !== lastGamepadAxes[0] ||
          axes[1] !== lastGamepadAxes[1] ||
          axes[2] !== lastGamepadAxes[2] ||
          axes[3] !== lastGamepadAxes[3];

        if (changed) {
          beginInputWrite(inputView);
          inputView[INPUT_INDEX.gamepadConnected] = connected;
          inputView[INPUT_INDEX.gamepadButtons] = buttonsMask;
          inputView[INPUT_INDEX.gamepadAxis0] = axes[0];
          inputView[INPUT_INDEX.gamepadAxis1] = axes[1];
          inputView[INPUT_INDEX.gamepadAxis2] = axes[2];
          inputView[INPUT_INDEX.gamepadAxis3] = axes[3];
          endInputWrite(inputView);
          lastGamepadConnected = connected;
          lastGamepadButtons = buttonsMask;
          lastGamepadAxes = axes;
        }

        // Drive the input-status overlay (independent of the SAB-write gate above).
        const guestSeq = Atomics.load(inputView, INPUT_INDEX.guestGamepadSeq);
        const nowTs = performance.now();
        if (lastGuestGamepadSeq === -1) {
          lastGuestGamepadSeq = guestSeq;
        } else if (guestSeq !== lastGuestGamepadSeq) {
          lastGuestGamepadSeq = guestSeq;
          guestActiveUntil = nowTs + GUEST_ACTIVE_WINDOW_MS;
        }
        const padConnected = connected === 1;
        const guestActive = nowTs < guestActiveUntil;
        const padLabel = livePad ? (livePad.id || "Gamepad") : cachedMeta ? cachedMeta.id : null;
        if (padConnected !== shownPadConnected || guestActive !== shownGuestActive || padLabel !== shownPadLabel) {
          shownPadConnected = padConnected;
          shownGuestActive = guestActive;
          shownPadLabel = padLabel;
          setInputStatus({ padConnected, padLabel, guestActive });
        }
      }
      gamepadRafId = window.requestAnimationFrame(pollGamepad);
    };

    gamepadRafId = window.requestAnimationFrame(pollGamepad);

    return () => {
      if (gamepadRafId !== null) {
        window.cancelAnimationFrame(gamepadRafId);
        gamepadRafId = null;
      }
      teardownGamepadCache();
    };
  }, [browserSupport.supported, sabAvailable, isolated]);

  useEffect(() => {
    // Keyboard Lock: while fullscreen, capture Escape so it reaches the guest as the
    // in-game menu key instead of the browser consuming it to exit fullscreen. The UA
    // still honors a long-press Escape to leave fullscreen, so this is not a trap.
    const kb = (navigator as Navigator & {
      keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
    }).keyboard;

    const syncFullscreenState = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const fs = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(fs);
      // Unsupported / not granted → ESC keeps exiting fullscreen, same as before.
      if (fs) kb?.lock?.(["Escape"]).catch(() => { /* best-effort */ });
      else kb?.unlock?.();
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
    syncFullscreenState();

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
      kb?.unlock?.();
    };
  }, []);

  // Derived states for the new debug overlay
  const isIsolated = isolated;
  const isBufferReady = isBufferInitialized;
  const error = errorMessage;

  // Sync logging state to worker when it changes or worker becomes ready
  useEffect(() => {
    if (globalWorker && workerStatus === "ready") {
      globalWorker.postMessage({ type: "logging_global_enable", enabled: loggingEnabled });
    }
  }, [loggingEnabled, workerStatus]);

  // Toggle logging handler
  const toggleLogging = useCallback(() => {
    const newState = !loggingEnabled;
    setLoggingEnabled(newState);
    localStorage.setItem('bottleship_logging_enabled', String(newState));
  }, [loggingEnabled]);

  // Pause/Resume handler
  const togglePause = useCallback(async () => {
    if (!globalWorker) {
      console.error("BottleShip: Worker not initialized");
      return;
    }
    const newPausedState = !isPaused;
    setIsPaused(newPausedState);
    globalWorker.postMessage({ type: newPausedState ? "pause" : "resume" });
    
    // Also pause/resume audio engine
    if (audioEngine) {
      if (newPausedState) {
        await audioEngine.pause();
      } else {
        await audioEngine.resume();
      }
    }
  }, [isPaused]);

  const toggleFullscreen = useCallback(async () => {
    const panel = panelRef.current;
    const target = panel ?? canvasRef.current;
    if (!target) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const element = target as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };

    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          await doc.webkitExitFullscreen?.();
        }
        return;
      }

      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else {
        await element.webkitRequestFullscreen?.();
      }
    } catch (err) {
      setErrorMessage(`Fullscreen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);
  toggleFullscreenRef.current = () => {
    void toggleFullscreen();
  };

  // Dev-panel "Load File..." handler. Returns true when the load was dispatched so
  // DevPanel only resets its file input if the worker was alive (preserves the
  // original `if (file && globalWorker)` guard semantics).
  const handleDevLoadFile = useCallback((file: File): boolean => {
    if (!globalWorker) return false;
    ensurePersistentStorageRequested();
    canvasRef.current?.focus();
    setIsLoadingApp(true);
    setErrorMessage(null);
    setExitInfo(null);
    setBundleDisplayName(null);
    audioEngine?.stopAll();
    setLoadingProgress({ phase: "loading", percent: 0, label: "" });
    globalWorker.postMessage({ type: "load_bundle", blob: file });
    return true;
  }, []);

  const handleToggleFpuStrict = useCallback((strict: boolean) => {
    setFpuStrictEnabled(strict);
    globalWorker?.postMessage({ type: "set_fpu_strict", strict });
  }, []);

  // One settings window, shared by the library screen and the in-game view (the
  // in-game "Settings" button and the library gear both open it).
  const settingsDrawer = (
    <SettingsDrawer
      isOpen={mainSettingsOpen}
      onClose={() => setMainSettingsOpen(false)}
      quality={quality}
      onChange={handleQualityChange}
      uiSettings={uiSettings}
      onUiChange={handleUiChange}
      statsOverlay={statsOverlayEnabled}
      onToggleStatsOverlay={handleToggleStatsOverlay}
      logStreaming={loggingEnabled}
      onToggleLogStreaming={handleToggleLogStreaming}
      onResetDefaults={handleResetSettings}
      guestResolution={guestResolution}
      integerScale={integerScaleSize.scale}
      onOpenDevConsole={() => {
        if (browserSupport.supported) window.location.assign("?game=dev");
      }}
    />
  );

  if (!gameIdFromUrl) {
    return (
      <>
        <GameSelectScreen
          games={gamesCatalog ?? []}
          addedGames={addedGames}
          onSelectGame={(game) => {
            if (!launchBlocked) window.location.assign(`?game=${game.id}`);
          }}
          onPlayAdded={(g) => {
            if (!launchBlocked) window.location.assign(`?game=dev&load=${encodeURIComponent(g.url)}`);
          }}
          onRemoveAdded={(g) => {
            removeAddedGame(g.key).then(refreshAddedGames).catch((err) =>
              setErrorMessage(`Failed to remove: ${err instanceof Error ? err.message : String(err)}`),
            );
          }}
          onEditAdded={(g) => setEditingKey(g.key)}
          onAddGame={() => {
            if (!launchBlocked) setAddGameOpen(true);
          }}
          onDevMode={() => {
            if (!launchBlocked) window.location.assign("?game=dev");
          }}
          onManageStorage={() => setStorageOpen(true)}
          onOpenSettings={() => setMainSettingsOpen(true)}
          disableSelection={launchBlocked}
          unsupportedMessage={browserUnsupportedMessage}
        />
        {settingsDrawer}
        <StorageManagerModal isOpen={storageOpen} onClose={() => setStorageOpen(false)} />
        <WgbWizardModal
          isOpen={addGameOpen}
          onClose={() => setAddGameOpen(false)}
          disabled={!browserSupport.supported}
          onPlay={({ files, url }) => {
            // "Play now" can't boot inside the wizard's build-only worker, so route the
            // source through App's existing launch flow (stage to OPFS + navigate, or
            // load-by-url) — the path that already boots a game.
            if (url) {
              window.location.assign(`?game=dev&load=${encodeURIComponent(url)}`);
              return;
            }
            if (files && files.length > 0) {
              stageFilesAndLaunch(files).catch((err) =>
                setErrorMessage(`Failed to stage files: ${err instanceof Error ? err.message : String(err)}`),
              );
            }
          }}
          onEditLibrary={() => {
            setAddGameOpen(false);
            setStorageOpen(true);
          }}
          onPersisted={refreshAddedGames}
        />
        <ManifestEditorModal
          gameKey={editingKey}
          onClose={() => setEditingKey(null)}
          onSaved={refreshAddedGames}
        />
        {webgpuBlocked && (
          <WebGPUErrorOverlay probe={webgpuProbe!} detectedBrowser={browserSupport.detectedBrowser} variant="modal" />
        )}
      </>
    );
  }

  if (
    gameIdFromUrl
    && gameIdFromUrl !== "dev"
    && gamesCatalog !== null
    && !selectedGame
  ) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0a0a0a",
        color: "#e8e8e8",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        padding: "24px",
        boxSizing: "border-box",
      }}>
        <div style={{
          width: "100%",
          maxWidth: "620px",
          border: "1px solid #3a1919",
          backgroundColor: "#171010",
          borderRadius: "12px",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem", color: "#ff8f8f" }}>
            Game not found
          </h1>
          <p style={{ margin: 0, color: "#d3c2c2", lineHeight: 1.45 }}>
            No entry for “{gameIdFromUrl}” in games-catalog.json.
          </p>
          <button
            onClick={() => window.location.assign("/")}
            style={{
              marginTop: "8px",
              alignSelf: "flex-start",
              border: "1px solid #5f3b3b",
              backgroundColor: "#241616",
              color: "#f4d8d8",
              borderRadius: "8px",
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            Back to library
          </button>
        </div>
      </div>
    );
  }

  if (!browserSupport.supported) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0a0a0a",
        color: "#e8e8e8",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        padding: "24px",
        boxSizing: "border-box",
      }}>
        <div style={{
          width: "100%",
          maxWidth: "620px",
          border: "1px solid #3a1919",
          backgroundColor: "#171010",
          borderRadius: "12px",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem", color: "#ff8f8f" }}>
            Unsupported browser
          </h1>
          <p style={{ margin: 0, color: "#d3c2c2", lineHeight: 1.45 }}>
            {browserUnsupportedMessage}
          </p>
          <p style={{ margin: 0, color: "#9f8c8c", fontSize: "0.92rem" }}>
            Launching games is disabled in this browser. Open the page in an up-to-date Google Chrome or Safari 26+ and try again.
          </p>
          <button
            onClick={() => window.location.assign("/")}
            style={{
              marginTop: "8px",
              alignSelf: "flex-start",
              border: "1px solid #5f3b3b",
              backgroundColor: "#241616",
              color: "#f4d8d8",
              borderRadius: "8px",
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            Back to library
          </button>
        </div>
      </div>
    );
  }

  if (webgpuProbe && !webgpuProbe.ok) {
    return (
      <WebGPUErrorOverlay probe={webgpuProbe} detectedBrowser={browserSupport.detectedBrowser} variant="page" />
    );
  }

  return (
    <div
      className={cx(s, "app", uiSettings.lockFullscreenAspect ? "app--fullscreen-aspect-lock" : "app--fullscreen-aspect-free", uiSettings.integerScaling && "app--fullscreen-integer")}
      style={
        {
          ["--fullscreen-aspect-w" as string]: String(fullscreenAspect.w),
          ["--fullscreen-aspect-h" as string]: String(fullscreenAspect.h),
          ["--fullscreen-integer-w" as string]: `${integerScaleSize.width}px`,
          ["--fullscreen-integer-h" as string]: `${integerScaleSize.height}px`,
        } as React.CSSProperties
      }
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length > 0) handleDroppedFiles(e.dataTransfer.files);
      }}
    >
      {/* Top bar */}
      <header className={s["emu-topbar"]}>
        <button className={cx(s, "emu-topbar-btn", "emu-back-btn")} onClick={() => window.location.assign("/")} title="Back to game selection">
          ← Menu
        </button>
        <div className={s["emu-game-title"]}>
          {(displayGame!.id !== "dev" || bundleDisplayName) && (
            <>
              <span className={s["emu-game-name"]}>{gameDisplayName}</span>
              {displayGame!.id !== "dev" && displayGame!.subtitle && (
                <span className={s["emu-game-subtitle"]}>{displayGame!.subtitle}</span>
              )}
            </>
          )}
        </div>
        <div className={s["emu-topbar-actions"]}>
          <button
            className={cx(s, "emu-topbar-btn", isPaused && "emu-btn-active")}
            onClick={togglePause}
            disabled={workerStatus !== "ready" || isLoadingApp}
            title={isPaused ? "Resume" : "Pause"}
          >
            {isPaused ? "▶" : "⏸"}
          </button>
          <button
            className={cx(s, "emu-topbar-btn", isFullscreen && "emu-btn-active")}
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)"}
          >
            {isFullscreen ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M5 1H1v4h1.5V2.5H5V1zM9 1v1.5h2.5V5H13V1H9zM1 9v4h4v-1.5H2.5V9H1zM11.5 11.5H9V13h4V9h-1.5v2.5z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M1 5V1h4v1.5H2.5V5H1zM9 1h4v4h-1.5V2.5H9V1zM1 9h1.5v2.5H5V13H1V9zM11.5 11.5V9H13v4H9v-1.5h2.5z"/>
              </svg>
            )}
          </button>
          <button
            className={cx(s, "emu-topbar-btn", devPanelOpen && "emu-btn-active")}
            onClick={toggleDevPanel}
            title="Developer tools"
          >
            ···
          </button>
        </div>
      </header>

      {/* Dev panel */}
      {devPanelOpen && (
        <DevPanel
          onLoadFile={handleDevLoadFile}
          onOpenSettings={() => setMainSettingsOpen(true)}
          onCaptureFrame={() => (window as any).captureFrame?.()}
          statsOverlayEnabled={statsOverlayEnabled}
          onToggleStatsOverlay={handleToggleStatsOverlay}
          onOpenLogViewer={() => setLogViewerOpen(true)}
          onOpenProfiler={() => setProfilerOpen(true)}
          onOpenMemory={() => setMemoryPanelOpen(true)}
          onOpenDebugGpu={() => setDebugGpuOpen(true)}
          onOpenFrameAnalysis={() => setFrameAnalysisOpen(true)}
          onOpenStorage={() => setStorageOpen(true)}
          onOpenOpfsTool={() => setOpfsToolOpen(true)}
          onOpenRegistryTool={() => setRegistryToolOpen(true)}
          fpuStrictEnabled={fpuStrictEnabled}
          onToggleFpuStrict={handleToggleFpuStrict}
          loggingEnabled={loggingEnabled}
          onToggleLogging={toggleLogging}
        />
      )}

      {/* Canvas */}
      <section className={s["app__panel"]} ref={panelRef}>
        {workerStatus !== "ready" && !loadingProgress && displayGame!.coverUrl && (
          <div className={s["emu-cover-placeholder"]} style={{ backgroundImage: `url(${displayGame!.coverUrl})` }} />
        )}
        <canvas
          ref={canvasRef}
          tabIndex={-1}
          className={cx(s, "app__canvas", uiSettings.canvasFiltering === "pixelated" && "app__canvas--pixelated")}
          style={{ aspectRatio: `${guestResolution.width} / ${guestResolution.height}` }}
        />
        {workerStatus === "ready" && <InputStatusOverlay status={inputStatus} />}
        {loadingProgress && !errorMessage && !exitInfo && (() => {
          const activeStage = loadPhaseStageIndex(loadingProgress.phase);
          const status = loadPhaseStatus(loadingProgress.phase, gameDisplayName);
          return (
            <div className={cx(s, "loading-overlay", loadingProgress.fadingOut && "loading-overlay--done")}>
              {displayGame!.coverUrl && (
                <div className={s["loading-overlay__cover"]} style={{ backgroundImage: `url(${displayGame!.coverUrl})` }} />
              )}
              <div className={s["loading-overlay__content"]}>
                <div className={s["loading-overlay__title"]}>{gameDisplayName}</div>

                <ol className={s["loading-overlay__steps"]} aria-hidden>
                  {LOAD_STAGES.map((stage, i) => (
                    <li
                      key={stage.id}
                      className={cx(s, "loading-overlay__step", i < activeStage ? "is-done" : i === activeStage ? "is-active" : false)}
                    >
                      <span className={s["loading-overlay__step-dot"]} />
                      <span className={s["loading-overlay__step-label"]}>{stage.label}</span>
                    </li>
                  ))}
                </ol>

                <div className={cx(s, "loading-overlay__bar-wrap", loadingProgress.indeterminate && "is-indeterminate")}>
                  <div
                    className={s["loading-overlay__bar"]}
                    style={loadingProgress.indeterminate ? undefined : { width: `${loadingProgress.percent}%` }}
                  />
                </div>

                <div className={s["loading-overlay__label"]}>
                  {status}
                  {loadingProgress.label ? ` · ${loadingProgress.label}` : ""}
                </div>
              </div>
            </div>
          );
        })()}
        {!sabAvailable || !isolated ? (
          <div className={s["app__warning"]}>
            <p>SharedArrayBuffer requires COOP/COEP headers and cross-origin isolation.</p>
            {!secureContext && <p>Current context is not secure. Use https:// or localhost.</p>}
            <p>Check the dev server headers and reload the page.</p>
          </div>
        ) : null}
        {/* One modal for everything that interrupts: load/worker errors AND guest exit/crash.
            exitInfo (a running process that died) takes precedence over a plain errorMessage. */}
        <ExitOverlay
          exitInfo={exitInfo}
          errorMessage={errorMessage}
          gameName={gameDisplayName}
          onDismissError={() => setErrorMessage(null)}
        />
      </section>

      {/* Info strip — catalog games always; destin mode once the WGB manifest name arrives. */}
      {(displayGame!.id !== "dev" || bundleDisplayName) && (
        <div className={s["emu-info-strip"]}>
          <span className={s["emu-info-name"]}>
            {gameDisplayName}
            {displayGame!.id !== "dev" && displayGame!.subtitle && (
              <span className={s["emu-info-subtitle"]}>&nbsp;{displayGame!.subtitle}</span>
            )}
          </span>
          <span className={s["emu-info-desc"]}>
            {displayGame!.id !== "dev" ? displayGame!.description : ""}
          </span>
          {displayGame!.id !== "dev" && displayGame!.gogUrl && (
            <a
              className={s["emu-info-gog"]}
              href={displayGame!.gogUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Own it? Get it on GOG →
            </a>
          )}
          <span className={s["emu-info-hints"]}>F11 · Fullscreen</span>
        </div>
      )}


      {messageBox && (
        <MessageBoxModal messageBox={messageBox} onClose={() => setMessageBox(null)} />
      )}

      {settingsDrawer}
      <OpfsTool isOpen={opfsToolOpen} onClose={() => setOpfsToolOpen(false)} />
      <StorageManagerModal isOpen={storageOpen} onClose={() => setStorageOpen(false)} />
      <RegistryTool isOpen={registryToolOpen} onClose={() => setRegistryToolOpen(false)} worker={globalWorker} />
      <DebugLogViewer isOpen={logViewerOpen} onClose={() => setLogViewerOpen(false)} worker={globalWorker} />
      <MemoryPanel isOpen={memoryPanelOpen} onClose={() => setMemoryPanelOpen(false)} worker={globalWorker} />
      <ProfilerPanel isOpen={profilerOpen} onClose={() => setProfilerOpen(false)} worker={globalWorker} />
      <DebugGPUPanel isOpen={debugGpuOpen} onClose={() => setDebugGpuOpen(false)} worker={globalWorker} />
      <FrameAnalysisPanel isOpen={frameAnalysisOpen} onClose={() => setFrameAnalysisOpen(false)} worker={globalWorker} />
    </div>
  );
}
