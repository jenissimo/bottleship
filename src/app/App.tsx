import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui/cx";
import s from "./App.module.css";
import OpfsTool from '../debug/OpfsTool';
import WgbBrowser from '../debug/WgbBrowser';
import StorageManagerModal from '../storage/StorageManagerModal';
import RegistryTool from '../debug/RegistryTool';
import DebugLogViewer from '../debug/DebugLogViewer';
import MemoryPanel from '../debug/MemoryPanel';
import ProfilerPanel from '../debug/ProfilerPanel';
import DebugGPUPanel from '../debug/DebugGPUPanel';
import FrameAnalysisPanel from '../debug/FrameAnalysisPanel';
import { InputStatusOverlay, type InputStatus } from './InputStatusOverlay';
import { AudioEngine, AudioPlayEncodedPayload, AudioPlayPayload, AudioUpdatePayload } from "../audio/audio-engine";
import { getLogClient, sendLogToServer, writeDebugFile, writeDebugFileBase64, rotateLogFile, logArtifactPath } from "../utils/log-client";
import { bundleLogName } from "../utils/bundle-url";
import { sessionFromLocation } from "../harness/session";
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
import { browserPolicyBlock, loadDeploymentConfig } from "../deployment-config";
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
import { INPUT_BUFFER_SIZE, INPUT_INDEX } from "../input/sab-layout";
import { GuestCursorRenderer } from "./guest-cursor";
import { inputDevice } from "../input/virtual-device";
import { relativeIntent } from "../input/relative-intent";
import { touchDriver } from "../input/touch/driver";
import { TouchControlLayer, type TouchControlsHandle } from "./TouchControlLayer";
import { TouchHud } from "./TouchHud";
import { VirtualKeyboardSheet } from "./VirtualKeyboardSheet";
import { useActiveLayout, type ManifestTouch } from "../input/controls/use-active-layout";
import {
  detectCoarsePrimary, shouldShowTouchHud, shouldShowTouchUi, type PointerKind,
} from "../input/touch-ui-visibility";
import {
  getPointerKind, installPointerKindWatcher, kindOfPointerType, notePointerKind,
  subscribePointerKind,
} from "../input/pointer-kind";
import { setHapticsEnabled } from "../input/haptics";
import { TouchFirstRunHint } from "./TouchFirstRunHint";
import type { HostAction } from "../input/bindings";

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
  /** DirectInput device deltas contributed by this event. Absent in older recordings;
   *  without them a relative-mouse title (pointer-locked, absolute slots frozen)
   *  replays as a session where nothing moved. */
  dinputDX?: number;
  dinputDY?: number;
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
/** sessionStorage key holding a pending self re-exec across the page reload it triggers. */
const REEXEC_KEY = "bs_pending_reexec";
/** sessionStorage key holding a bundle the dev browser asked us to open after a reload.
 *  Separate from REEXEC_KEY on purpose: that one also replaces the manifest's boot args,
 *  and an empty args string is not the same as "boot this bundle normally". */
const PENDING_BUNDLE_KEY = "bs_pending_bundle";
/** Chrome refuses requestPointerLock for ~1.25 s after a user-initiated exit; retries
 *  inside that window are silently rejected, so gate them rather than burn the gesture. */
const POINTER_LOCK_EXIT_COOLDOWN_MS = 1300;
/** Bundle URL a pending re-exec must re-open once window.loadApp exists (dev/harness boots). */
let reExecBundleUrl: string | null = null;
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

/** Capture the published record for playRecording(). No-op unless recording.
 *  dinputDX/DY are the deltas this event ADDED to the accumulators, not their running
 *  total — the slots are monotonic counters the worker never drains. */
function recordSample(
    inputView: Int32Array, keyCode = 0, keyState = 0, dinputDX = 0, dinputDY = 0,
): void {
    if (!isRecording) return;
    recordedInputs.push({
        t: performance.now() - recordStart,
        dinputDX,
        dinputDY,
        mouseX: inputView[INPUT_INDEX.mouseX],
        mouseY: inputView[INPUT_INDEX.mouseY],
        buttons: inputView[INPUT_INDEX.buttons],
        keyCode,
        keyState,
        gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
        gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
        gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
        gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
        gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
        gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
        mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
    });
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
  const canvasRectRef = useRef<DOMRect | null>(null);
  // The cursor element is positioned inside the panel, so its transforms are relative
  // to this rect; cached alongside the canvas rect and invalidated by the same events.
  const panelRectRef = useRef<DOMRect | null>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isCanvasHoveredRef = useRef(false);
  /** Hit-tested against the canvas rect — the one input to whether we draw the pointer. */
  const isPointerOverCanvasRef = useRef(false);
  /** Sprite position of a SOFTWARE D3D device cursor; null = draw at the pointer. */
  const deviceCursorPosRef = useRef<{ x: number; y: number } | null>(null);
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
  const handleDroppedFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0 || !globalWorker) return;
    ensurePersistentStorageRequested();
    canvasRef.current?.focus();
    setIsLoadingApp(true);
    setErrorMessage(null);
    setBundleDisplayName(null);
    setLoadingProgress({ phase: "loading", percent: 0, label: "" });
    // One file uses the blob sniff path; several files use multi-part install.
    globalWorker.postMessage(
      files.length === 1
        ? { type: "load_bundle", blob: files[0] }
        : { type: "load_bundle", blobs: files },
    );
  }, []);
  const loadingFadeTimerRef = useRef<number | null>(null);
  const [addGameOpen, setAddGameOpen] = useState(false);
  const [addedGames, setAddedGames] = useState<AddedGame[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [opfsToolOpen, setOpfsToolOpen] = useState(false);
  const [wgbBrowserOpen, setWgbBrowserOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  /** Chrome-free presentation where the Fullscreen API does not exist (iPhone Safari). */
  const [immersive, setImmersive] = useState(false);
  const [oskOpen, setOskOpen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  /** What last drove the app — decides whether the touch UI belongs on screen.
   *  Seeded from the app-global latch, which the library screen has already been
   *  feeding: by the time a game mounts, the launch tap is in. */
  const [lastPointerKind, setLastPointerKind] = useState<PointerKind | null>(getPointerKind);
  const [coarsePrimary] = useState(detectCoarsePrimary);
  /** Manifest gameId — the per-game key for a saved control layout. */
  const [gameId, setGameId] = useState<string | null>(null);
  const [manifestTouch, setManifestTouch] = useState<ManifestTouch | null>(null);
  const touchControlsRef = useRef<TouchControlsHandle | null>(null);
  /** Guest pixels per CSS pixel — the widget layer scales relative motion by it. */
  const guestPerCss = useCallback(() => {
    const rect = canvasRectRef.current;
    const space = mouseCoordinateModeRef.current === "guest"
      ? guestResolutionRef.current
      : resolutionRef.current;
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 1, y: 1 };
    return { x: space.width / rect.width, y: space.height / rect.height };
  }, []);
  const [mainSettingsOpen, setMainSettingsOpen] = useState(false);
  const [registryToolOpen, setRegistryToolOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [profilerOpen, setProfilerOpen] = useState(false);
  const [debugGpuOpen, setDebugGpuOpen] = useState(false);
  const [frameAnalysisOpen, setFrameAnalysisOpen] = useState(false);
  const [statsOverlayEnabled, setStatsOverlayEnabled] = useState(false);
  const [fpuStrictEnabled, setFpuStrictEnabled] = useState(false);
  // AOT code cache (docs/performance/sota-roadmap/05-A0-play-and-record.md). Recording is a
  // two-step ritual whose failure mode is silent — a `stop` that never ran keeps nothing —
  // so the panel shows the state rather than expecting it to be remembered.
  const [aotRecording, setAotRecording] = useState(false);
  const [aotAutoLoad, setAotAutoLoad] = useState(true);
  const [aotStatus, setAotStatus] = useState<string>("");
  const [messageBox, setMessageBox] = useState<MessageBoxRequest | null>(null);

  // Publish a dismisser for the prompt that is on screen. The harness's auto-answer is
  // consulted once, BEFORE render, so a script that wants the prompt as a pause point
  // (stop here, arm logging, continue) has nothing to answer it with afterwards.
  useEffect(() => {
    const harness = (window as any).__BS__?.harness;
    if (!harness?.setLiveModal) return;
    if (!messageBox) { harness.setLiveModal(null); return; }
    harness.setLiveModal(
      (result: number) => {
        messageBox.worker.postMessage({ type: "message_box_result", id: messageBox.id, result });
        setMessageBox(null);
      },
      { text: messageBox.text, caption: messageBox.caption },
    );
    return () => harness.setLiveModal(null);
  }, [messageBox]);
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
  /**
   * On a touch device the virtual pad is permanently available — it is simply not
   * drawn yet. Titles of this era enumerate joysticks ONCE at startup, so waiting
   * for the overlay to appear means the game has already taken its "no controller"
   * branch and will never look again. Advertise it like a controller left plugged in.
   */
  const assertVirtualPad = useCallback(() => {
    if (typeof navigator === "undefined") return;
    // The same test that decides whether the pad is DRAWN, minus `hidden` — a
    // collapsed overlay does not unplug it. Gating on touch hardware alone would
    // advertise a joystick to every desktop with a touchscreen, and a game that
    // finds one stops offering the keyboard.
    if (!shouldShowTouchHud({
      maxTouchPoints: navigator.maxTouchPoints,
      coarsePrimary,
      lastPointer: getPointerKind(),
      mode: uiSettingsRef.current.touchMode,
      hidden: false,
    })) return;
    inputDevice.publishPad({ connected: true, buttons: 0, axes: [0, 0, 0, 0] }, "touch");
    inputDevice.commit({ immediate: true });
  }, [coarsePrimary]);

  // Mounted on every screen INCLUDING the library, which returns before the emulator
  // exists: the launch tap is the evidence, and it has to be in before the guest
  // enumerates its devices.
  useEffect(() => {
    const uninstall = installPointerKindWatcher();
    const unsubscribe = subscribePointerKind((kind) => {
      pointerSourceRef.current = kind;
      setLastPointerKind(kind);
      assertVirtualPad();
    });
    return () => { uninstall(); unsubscribe(); };
  }, [assertVirtualPad]);

  const touchUiSignals = {
    maxTouchPoints: typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
    coarsePrimary,
    lastPointer: lastPointerKind,
    mode: uiSettings.touchMode,
    hidden: controlsHidden,
  };
  const showTouchControls = shouldShowTouchUi(touchUiSignals);
  const showTouchHud = shouldShowTouchHud(touchUiSignals);
  const activeLayout = useActiveLayout(
    gameId,
    manifestTouch,
    () => globalInputView,
    workerStatus === "ready" && uiSettings.touchMode !== "off",
  );
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
  // A deployment may admit only the browser it was rehearsed on (see deployment-config).
  // undefined = policy not loaded yet; null = allowed.
  const [policyBlock, setPolicyBlock] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    loadDeploymentConfig().then(
      (cfg) => { if (!cancelled) setPolicyBlock(browserPolicyBlock(cfg, browserSupport.detectedBrowser)); },
      () => { if (!cancelled) setPolicyBlock(null); },
    );
    return () => { cancelled = true; };
  }, [browserSupport.detectedBrowser]);
  const browserUnsupportedMessage = useMemo(() => {
    if (policyBlock) return policyBlock;
    if (browserSupport.supported) return null;
    const missing = browserSupport.missing.join(", ");
    return `This browser is missing features required to run BottleShip: ${missing}. Detected browser: ${browserSupport.detectedBrowser}. Please use an up-to-date Google Chrome or Safari 26+.`;
  }, [browserSupport, policyBlock]);

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
  // policyBlock === undefined means the deployment policy has not resolved yet — hold
  // launching until it has, or a restricted browser gets a game started before we know.
  const launchBlocked = !browserSupport.supported || webgpuBlocked || policyBlock !== null;

  // Auto-load game once worker is ready. Registered games load their wgbUrl; dev mode
  // stays manual UNLESS Add-Game handed us a bundle via ?load=<url> (BYO drop / URL).
  const autoLoadDoneRef = useRef(false);
  useEffect(() => {
    if (launchBlocked) return;
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

    (window as any).loadApp?.(
      selectedGame.id === "dev" ? loadParam : selectedGame.wgbUrl,
      { preload: selectedGame.preload === true },
    );
    // launchBlocked, not its inputs: the deployment policy resolves asynchronously and
    // may be the LAST of them to arrive. Depending on the others only, the one run that
    // saw a blocked launch would also be the last, and the game would never start.
  }, [launchBlocked, selectedGame, workerStatus]);

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
  // Cooldown after exitPointerLock — browser rejects re-acquire for ~1 frame after exit
  const pointerLockCooldownRef = useRef(false);
  /** Which kind of pointer is driving us; decides how relative intent is delivered. */
  const pointerSourceRef = useRef<PointerKind>(getPointerKind() ?? "mouse");
  // Right Ctrl deliberately released the lock — suppress auto re-acquire until the next
  // explicit re-engage gesture (a canvas click).
  const userReleasedLockRef = useRef(false);
  /** Host F11 fullscreen — ref so the mount-stable input effect can call it. */
  const toggleFullscreenRef = useRef<() => void>(() => {});

  const requestPointerLockSafe = (canvas: HTMLCanvasElement) => {
    if (pointerLockCooldownRef.current) return;
    // Allow-list, not a !== "touch" deny-list: a pen reports "pen" and has neither
    // Pointer Lock nor meaningful movementX/Y, so it belongs on the touch transport.
    if (pointerSourceRef.current !== "mouse") return;
    const req = canvas.requestPointerLock as (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    Promise.resolve(req.call(canvas, { unadjustedMovement: true })).catch(() => {
      // Options unsupported (older Chromium) — retry bare.
      Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    });
  };

  // Exclusive DI / ShowCursor(hide) often arrives OUTSIDE a user gesture, so the
  // opportunistic requestPointerLock in updatePointerLockIntent fails silently and
  // the title keeps absolute edge-clamped mouse until the next canvas click. Arm a
  // capture-phase window listener so the next trusted activation anywhere on the game
  // stage (fire click, a click on a touch/status overlay) still engages lock — not only
  // a pointerdown the canvas itself receives.
  const pointerLockGestureHandlerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const armPointerLockGesture = () => {
    if (pointerLockGestureHandlerRef.current) return;
    // Stays armed until the lock actually engages. Disarming on the first activation
    // assumed the request succeeds, and it often does not — the browser rejects a
    // re-acquire for over a second after a user-initiated exit (ESC), which is exactly
    // when this is armed. One rejected attempt would otherwise retire the gesture and
    // leave a title steering by motion with an absolute cursor for the rest of the run.
    const onActivate = (e: PointerEvent) => {
      const c = canvasRef.current;
      if (!c || userReleasedLockRef.current || pointerLockedRef.current) return;
      if (!relativeIntent.get()) return;
      // Scoped to the game stage (canvas + its overlays). Since this stays armed until
      // the lock engages, an unscoped handler would grab the pointer on every click on
      // the host shell's own buttons and menus and make them unusable mid-game.
      const target = e.target as Node | null;
      const stage = panelRef.current;
      if (!target || !(target === c || stage?.contains(target))) return;
      requestPointerLockSafe(c);
    };
    pointerLockGestureHandlerRef.current = onActivate;
    window.addEventListener("pointerdown", onActivate, true);
  };
  const disarmPointerLockGesture = () => {
    const handler = pointerLockGestureHandlerRef.current;
    if (!handler) return;
    pointerLockGestureHandlerRef.current = null;
    window.removeEventListener("pointerdown", handler, true);
  };

  // Pointer Lock is the MOUSE transport for relative intent. Engaging always requires a
  // user gesture, so when not yet locked we only attempt an opportunistic acquire
  // (succeeds inside a gesture, otherwise armed for the next click via handlePointerDown).
  // Releasing happens immediately when intent drops. The touch transport subscribes to
  // the same store independently.
  const updatePointerLockIntent = () => {
    const wants = relativeIntent.get();
    if (wants) {
      const c = canvasRef.current;
      if (c && document.hasFocus() && !pointerLockedRef.current && !userReleasedLockRef.current) {
        requestPointerLockSafe(c);
        armPointerLockGesture();
      }
    } else if (document.pointerLockElement) {
      pointerLockCooldownRef.current = true;
      document.exitPointerLock();
      setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
      disarmPointerLockGesture();
    } else {
      disarmPointerLockGesture();
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
    setHapticsEnabled(uiSettings.touchHaptics);
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

  // `assertVirtualPad` intentionally survives a collapsed touch overlay so games
  // that enumerate once still see a controller. "Off" is different: it is an
  // explicit unplug request and must clear that source even when no control layer
  // is mounted to perform its normal detach cleanup.
  useEffect(() => {
    if (uiSettings.touchMode === "off") {
      inputDevice.releaseSource("touch");
      inputDevice.commit({ immediate: true });
      return;
    }
    assertVirtualPad();
  }, [assertVirtualPad, uiSettings.touchMode]);

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

    // The guest pointer has exactly one renderer (see ./guest-cursor). Position comes
    // from the SAB the GUEST reads, not from inputDevice's copy: touch, harness injection
    // and guest warps all publish there, and the drawn pointer must sit where the game
    // believes the pointer is, whoever moved it.
    const guestCursor = new GuestCursorRenderer({
      getPosition: () => {
        // A software D3D device cursor is a sprite the runtime moves on its own; the OS
        // pointer never followed it, so the worker has to tell us where it is.
        const sprite = deviceCursorPosRef.current;
        if (sprite) return sprite;
        const view = globalInputView;
        return view ? { x: view[INPUT_INDEX.mouseX]!, y: view[INPUT_INDEX.mouseY]! } : null;
      },
      getGeometry: () => {
        const rect = liveCanvasRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        const origin = panelRectRef.current;
        const space =
          mouseCoordinateModeRef.current === "guest"
            ? guestResolutionRef.current
            : resolutionRef.current;
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          originLeft: origin?.left ?? 0,
          originTop: origin?.top ?? 0,
          spaceWidth: space.width,
          spaceHeight: space.height,
        };
      },
    });
    guestCursor.attach(cursorCanvasRef.current);
    ((window as any).__BS__ ??= {}).cursorOverlay = guestCursor.status;
    // Why the pointer is (not) locked, in one read. The decision spans three layers —
    // the guest's claim, this store, and the browser's gesture rules — and a screenshot
    // shows none of them: a title steering by motion with no lock looks exactly like one
    // whose camera is broken.
    ((window as any).__BS__ ??= {}).relativeMouse = () => ({
      intent: relativeIntent.get(),
      reasons: relativeIntent.reasons(),
      locked: !!document.pointerLockElement,
      userReleased: userReleasedLockRef.current,
      focus: document.hasFocus(),
    });

    // Pointer Lock fires no enter/leave and confines the pointer to the canvas by
    // definition, so it counts as inside — that is a statement about the HOST pointer's
    // whereabouts, not a branch in the drawing path.
    // The guest's pointer is drawn over the guest's screen and nowhere else; the letterbox
    // gets the host's own pointer back. Presence is a HIT TEST, not an enter/leave flag:
    // pointerleave does not arrive when the mouse crosses the border fast or with a button
    // held (the canvas keeps pointer capture), and a stale flag leaves our pointer painted
    // on the picture while the OS one is already out on the black — two cursors at once.
    const syncCursorPresence = () => {
      guestCursor.setPointerInside(isPointerOverCanvasRef.current || pointerLockedRef.current);
    };

    // The ONLY layout read in the pointer path. Everything downstream (mouse mapping,
    // touch driver, cursor renderer) reads these cached rects, so they must be re-taken
    // on every event that can move the canvas: window/visualViewport resize, viewport
    // pan, fullscreen, the canvas ResizeObserver, and a guest resolution change.
    const measureRects = () => {
      canvasRectRef.current = canvas.getBoundingClientRect();
      panelRectRef.current = panelRef.current?.getBoundingClientRect() ?? null;
    };
    // Self-checking cache: a guest mode switch (800x600 → 640x480) resizes the canvas
    // between the events that refresh the rects, and a stale rect silently rescales every
    // mapped position — the pointer then tracks a screen the guest no longer has.
    // clientWidth costs nothing unless layout is already dirty, which is exactly when the
    // cached value is wrong; getBoundingClientRect would FORCE that flush every time.
    const liveCanvasRect = (): DOMRect | null => {
      const rect = canvasRectRef.current;
      if (!rect
          || Math.abs(rect.width - canvas.clientWidth) > 0.5
          || Math.abs(rect.height - canvas.clientHeight) > 0.5) {
        measureRects();
        return canvasRectRef.current;
      }
      return rect;
    };
    // The guest is addressed in this space, and the device clamps every publication
    // against it. Established here, not on the first pointer event: a guest SetCursorPos
    // can arrive before the user has touched anything, and 1x1 bounds warp it to (0,0).
    const syncPointerBounds = () => {
      const space =
        mouseCoordinateModeRef.current === "guest"
          ? guestResolutionRef.current
          : resolutionRef.current;
      inputDevice.setPointerBounds(Math.max(1, space.width), Math.max(1, space.height));
    };
    const captureRects = () => {
      measureRects();
      syncPointerBounds();
      guestCursor.sync();
    };

    // 1. Initialize Worker (only once)
    if (!globalWorker) {
      globalWorker = new Worker(
        new URL("../worker/emulator.worker.ts", import.meta.url),
        { type: "module" }
      );

      // Expose worker to console for debugging
      (window as any).worker = globalWorker;

      // Harness session of this tab (?bs=<name>): the worker returns disk paths for the
      // dumps it emits, and those must name the session's own directory — an agent sent
      // to logs/debug/ while its PNG went to logs/alpha/debug/ reads a sibling's evidence.
      globalWorker.postMessage({ type: "set_session", session: sessionFromLocation(window.location.search) });

      // A self re-exec asked us to reload (see the "reexec" message). Hand the worker the
      // launcher's command line BEFORE any bundle load — it replaces the manifest's `args`
      // for exactly this boot. Consumed here so a later manual F5 boots normally again.
      try {
        const pendingReExec = sessionStorage.getItem(REEXEC_KEY);
        if (pendingReExec) {
          sessionStorage.removeItem(REEXEC_KEY);
          const { args, url, image, patches, inherited } = JSON.parse(pendingReExec) as
            { args: string; url: string | null; image?: string | null; patches?: unknown[] | null; inherited?: unknown[] | null };
          globalWorker.postMessage({
            type: "set_boot_args", args, image: image ?? null,
            patches: patches ?? null, inherited: inherited ?? null,
          });
          console.info("[bs] re-exec boot:", image ?? "(manifest entrypoint)", args, url ? `(url ${url})` : "");
          if (url) reExecBundleUrl = url;
        }
      } catch { /* corrupt/no pending re-exec */ }

      // Persisted debug flags (e.g. __noHeapSlab to A/B the WASM heap slab). Replayed to
      // the worker on EVERY page load BEFORE any game loads, so a toggle survives F5.
      // Set from the console: dbgFlag('__noHeapSlab', true)  → persists + applies live.
      // localStorage is origin-wide, so a flag set for one ?bs=<name> tab would otherwise
      // leak into every parallel agent's tab. Session-scoped flags win over global ones.
      const session = sessionFromLocation(window.location.search);
      const flagKeys = session ? ["bs_debug_flags", `bs_debug_flags:${session}`] : ["bs_debug_flags"];
      try {
        const merged: Record<string, unknown> = {};
        for (const [index, k] of flagKeys.entries()) {
          const flags = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, unknown>;
          // Host-tool execution is a per-harness-session capability. Never replay a stale
          // origin-wide value, including when this page has no session at all.
          if (index === 0) delete flags.__hostTools;
          Object.assign(merged, flags);
        }
        for (const [key, value] of Object.entries(merged)) {
          globalWorker.postMessage({ type: "set_debug_flag", key, value });
        }
        if (Object.keys(merged).length) console.info("[bs] replayed debug flags:", merged);
      } catch { /* corrupt/no flags */ }
      (window as any).dbgFlag = (key: string, value: unknown, opts?: { scope?: "session" | "global" }) => {
        if (key === "__hostTools" && !session) {
          throw new Error("dbgFlag('__hostTools', ...): a ?bs=<session> URL is required");
        }
        const store = key === "__hostTools"
          ? `bs_debug_flags:${session}`
          : (opts?.scope === "session" && session ? `bs_debug_flags:${session}` : "bs_debug_flags");
        const flags = JSON.parse(localStorage.getItem(store) || "{}");
        if (value === undefined || value === null) delete flags[key]; else flags[key] = value;
        localStorage.setItem(store, JSON.stringify(flags));
        globalWorker?.postMessage({ type: "set_debug_flag", key, value });
        return { [key]: value, store, note: "persisted; takes effect on next game load" };
      };

      // AI-agent harness facade: window.__BS__.harness. Thin page-side
      // forwarder over harness_rpc + the normalized event bus; logic lives in the
      // worker HarnessService. Coexists with the legacy window.dbg Proxy below.
      installHarnessFacade(globalWorker, () => globalInputView);

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
    // Redraw on publication, not only on the renderer's own frame: a motion commit is
    // itself rAF-coalesced and lands after our tick has already run, which would leave
    // the pointer a whole frame behind the position the guest was just handed.
    inputDevice.attach(globalInputView!, () => {
      globalWorker?.postMessage({ type: "input_tick" });
      guestCursor.sync();
    });
    assertVirtualPad();
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
      captureRects();

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
            console.log(`BottleShip: SEH runtime dump saved -> ${logArtifactPath(base)}.{json,bin}`);
          } else {
            console.warn(`BottleShip: SEH runtime dump not persisted (log server disconnected?) -> ${base}`);
          }
        }
      } else if (event.data?.type === "debug_png_dump") {
        // Worker-side bitmap dump for visual debugging: base64 PNG -> logs/[<session>/]debug/<name>.png
        const name = typeof event.data?.name === "string" ? event.data.name : "dump";
        const base64 = typeof event.data?.base64 === "string" ? event.data.base64 : "";
        if (base64) {
          const rel = `debug/${name}.png`;
          const ok = writeDebugFileBase64(rel, base64);
          console.log(`BottleShip: debug PNG ${ok ? "saved" : "NOT saved (log server?)"} -> ${logArtifactPath(rel)}`);
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
      if (event.data?.type === "reexec") {
        // A guest launcher relaunched its own image (worker: requestSelfReExec). We restart
        // it the only way that is genuinely a fresh process — reload the page — and hand the
        // new worker the launcher's command line before it loads the bundle. sessionStorage,
        // not localStorage: a pending restart belongs to THIS tab and must not leak into a
        // parallel agent's tab, and it must not survive the tab being closed.
        try {
          sessionStorage.setItem(REEXEC_KEY, JSON.stringify({
            args: String(event.data.args ?? ""),
            url: typeof event.data.url === "string" ? event.data.url : null,
            // Set when the launcher started a DIFFERENT image from the same bundle: the
            // new worker boots that entry point instead of the manifest's.
            image: typeof event.data.image === "string" ? event.data.image : null,
            // What the launcher wrote into the child while it was suspended (decrypted
            // code, for the encrypt-on-disk launchers). Without it the restart runs the
            // untouched, still-encrypted image.
            patches: Array.isArray(event.data.patches) ? event.data.patches : null,
            // Named kernel objects the launcher holds open. It keeps running on real
            // Windows while the game boots, so the game must still see them.
            inherited: Array.isArray(event.data.inherited) ? event.data.inherited : null,
          }));
          window.location.reload();
        } catch (e) {
          console.error("[bs] re-exec restart failed:", e);
        }
        return;
      }
      if (event.data?.type === "bundle_meta") {
        const name = typeof event.data.name === "string" ? event.data.name.trim() : "";
        if (name) setBundleDisplayName(name);
        setGameId(typeof event.data.gameId === "string" ? event.data.gameId : null);
        setManifestTouch((event.data.touch as ManifestTouch | null) ?? null);
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
      if (event.data?.type === "audio_master_stats_sab") {
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (sab) audioEngine?.registerMasterStatsSab(sab);
      }
      // video_frame and video_end are handled in the worker via WebGPU compositor (smackw32.ts → backend.composite)
      if (event.data?.type === "cursor_visibility") {
        const visible = event.data?.visible !== false;
        guestCursor.setVisible(visible);
        relativeIntent.set("cursorHidden", !visible);
        updatePointerLockIntent();
      }
      if (event.data?.type === "cursor_image") {
        // Guest installed a cursor shape: null pixels = system shape, which the renderer
        // covers with its built-in arrow.
        guestCursor.setShape(
          (event.data?.pixels as ArrayBuffer | null) ?? null,
          Number(event.data?.width) | 0,
          Number(event.data?.height) | 0,
          Number(event.data?.hotspotX) | 0,
          Number(event.data?.hotspotY) | 0,
        );
      }
      if (event.data?.type === "clip_cursor") {
        // Guest ClipCursor(rect) confines the cursor (relative/captured mouse, e.g. Unreal
        // SetMouseCapture); ClipCursor(NULL) releases it. Feed it into the same intent as
        // ShowCursor so confined-but-visible games also engage pointer-lock.
        relativeIntent.set("clipped", event.data?.clip === true);
        updatePointerLockIntent();
      }
      if (event.data?.type === "mouse_capture") {
        // Guest acquired/released an exclusive-mode DirectInput mouse. On real Windows this
        // implicitly captures the cursor (relative mode) with no ShowCursor/ClipCursor call,
        // so feed it into the same intent to engage/release pointer-lock.
        relativeIntent.set("captured", event.data?.capture === true);
        updatePointerLockIntent();
      }
      if (event.data?.type === "cursor_warp") {
        // Guest is warp-bursting SetCursorPos (relative-mouse emulation) — SetCursorPos can
        // only be honored under pointer lock, so treat it as a capture signal.
        relativeIntent.set("warping", event.data?.active === true);
        updatePointerLockIntent();
      }
      if (event.data?.type === "input_reset") {
        // Game switch: the worker's key/button diff baselines are back to zero, so a
        // level we are still holding would arrive in the next game as a fresh press.
        inputDevice.releaseAllSources();
        // No flush until the pad is re-asserted — see handleBlur.
        touchControlsRef.current?.releaseAll(false);
        touchDriver.reset();
        assertVirtualPad();
        inputDevice.commit({ immediate: true });
        relativeIntent.reset();
        updatePointerLockIntent();
      }
      if (event.data?.type === "set_cursor_pos") {
        // SetCursorPos moves the GUEST's cursor, so it applies whatever transport the host
        // happens to be using: Pointer Lock must not be observable by the guest, and gating
        // the warp on it would make a WinAPI contract depend on a host decision.
        inputDevice.setPointerAbsolute(Number(event.data.x) | 0, Number(event.data.y) | 0);
        inputDevice.commit({ immediate: true });
      }
      if (event.data?.type === "device_cursor_pos") {
        const x = event.data.x;
        deviceCursorPosRef.current = x === null || x === undefined
          ? null
          : { x: Number(x) | 0, y: Number(event.data.y) | 0 };
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
          // No inline size: the canvas ATTRIBUTES already carry the guest resolution, so
          // width/height:auto resolve to it and max-*:100% fits it into the panel with
          // the aspect ratio intact. A definite inline size makes the clamp one-sided —
          // the short axis shrinks, the long one stays, and the picture stretches.
          canvas.style.width = "";
          canvas.style.height = "";
          captureRects();
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
          requestAnimationFrame(() => requestAnimationFrame(captureRects));
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
    // A pinch-pan moves the visual viewport without resizing it, and every mapped
    // coordinate is measured against the canvas rect — stale rect, wrong cursor.
    window.visualViewport?.addEventListener("scroll", resize);
    document.addEventListener("fullscreenchange", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const detachTouch = panelRef.current
      ? touchDriver.attach(panelRef.current, {
          getCanvasRect: () => canvasRectRef.current ?? canvas.getBoundingClientRect(),
          getPointerSpace: () =>
            mouseCoordinateModeRef.current === "guest"
              ? guestResolutionRef.current
              : resolutionRef.current,
          getSettings: () => uiSettingsRef.current,
          hitTest: (x, y, id, phase) => touchControlsRef.current?.hitTest(x, y, id, phase) ?? false,
        })
      : () => {};

    // 5. Input Handlers
    // The canvas handlers are the MOUSE path only. Touch and pen belong to the touch
    // driver on the panel; letting both consume the same contact publishes two
    // contradictory records per event.

    const writePointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      // Latch back to mouse: a tablet with a Bluetooth mouse switches both ways.
      notePointerKind("mouse");
      const inputView = globalInputView;
      if (!inputView) return;

      // Opportunistic re-acquire after an ESC-exit: if the guest still wants relative mouse and
      // the user didn't deliberately release (Right Ctrl), retry on pointermove. Many browsers
      // don't treat pointermove as a valid activation gesture, so this is best-effort — the
      // reliable path is the canvas click in handlePointerDown. Guarded so a rejection is silent.
      if (
        !pointerLockedRef.current &&
        relativeIntent.get() &&
        !userReleasedLockRef.current &&
        !pointerLockCooldownRef.current &&
        document.hasFocus()
      ) {
        try { requestPointerLockSafe(canvas); } catch { /* not a valid gesture in this browser */ }
      }

      const pointerSpace =
        mouseCoordinateModeRef.current === "guest"
          ? guestResolutionRef.current
          : resolutionRef.current;
      const width  = Math.max(1, pointerSpace.width);
      const height = Math.max(1, pointerSpace.height);
      inputDevice.setPointerBounds(width, height);
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect();

      // --- Pointer Lock mode: use relative movementX/Y, skip canvas bounds check ---
      if (pointerLockedRef.current) {
        const scaleX = width  / Math.max(1, rect.width);
        const scaleY = height / Math.max(1, rect.height);
        // DirectInput reports RAW device deltas (relative axes), NOT canvas-scaled;
        // the virtual cursor stays scaled (CSS→guest). Same delta, two consumers.
        inputDevice.addPointerRelative(
          event.movementX * scaleX, event.movementY * scaleY,
          event.movementX, event.movementY,
        );
        inputDevice.setButtonsMask(event.buttons, "hw-mouse");
        inputDevice.commit();
        recordSample(inputView, 0, 0, event.movementX, event.movementY);
        return;
      }

      // --- Normal absolute mode ---
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

      // Coordinate scaling: mouse events are in client/CSS pixels
      // We map them to the virtual resolution [0..width/height]
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      inputDevice.setPointerAbsolute(
        (event.clientX - rect.left) * scaleX,
        (event.clientY - rect.top) * scaleY,
      );
      inputDevice.setButtonsMask(event.buttons, "hw-mouse");
      const dinputDX = Math.round(event.movementX * scaleX);
      const dinputDY = Math.round(event.movementY * scaleY);
      Atomics.add(inputView, INPUT_INDEX.dinputDX, dinputDX);
      Atomics.add(inputView, INPUT_INDEX.dinputDY, dinputDY);
      inputDevice.commit();
      recordSample(inputView, 0, 0, dinputDX, dinputDY);
    };

    const handlePointerEnter = (event?: PointerEvent) => {
      if (event && event.pointerType !== "mouse") return;
      isCanvasHoveredRef.current = true;
      inputDevice.setMouseInside(true, "hw-mouse");
      inputDevice.commit();
      // Publish the entry position before showing the pointer, or the first frame draws
      // it at wherever the cursor was when it last left.
      if (event) writePointer(event);
      // pointerenter does not bubble to the panel, so hit-test here too: entering the
      // picture directly from the page chrome must light the pointer up immediately.
      if (event) updatePointerOverCanvas(event); else syncCursorPresence();
    };

    const handlePointerLeave = (event?: PointerEvent) => {
      if (event && event.pointerType !== "mouse") return;
      if (!isCanvasHoveredRef.current) return;
      // Don't leave if pointer is captured (button held down while moving outside)
      if (event && canvas.hasPointerCapture(event.pointerId)) return;

      isCanvasHoveredRef.current = false;
      syncCursorPresence();
      const inputView = globalInputView;
      if (!inputView) return;

      // Always signal mouse-outside so InputManager can fire WM_MOUSELEAVE, and drop
      // the buttons with it — a press that ends off-canvas has no up event to release it.
      inputDevice.setMouseInside(false, "hw-mouse");
      inputDevice.setButtonsMask(0, "hw-mouse");
      inputDevice.commit();
      recordSample(inputView);
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
          setTimeout(() => { pointerLockCooldownRef.current = false; }, POINTER_LOCK_EXIT_COOLDOWN_MS);
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

      const vk = event.keyCode & 0xff;
      inputDevice.setKey(vk, state === 1, "hw-key");
      inputDevice.commit();
      recordSample(inputView, vk, state);
    };


    const handleKeyDown = (event: KeyboardEvent) => handleKey(event, 1);
    const handleKeyUp = (event: KeyboardEvent) => handleKey(event, 0);

    const handlePointerDown = (event: PointerEvent) => {
      notePointerKind(kindOfPointerType(event.pointerType));
      if (event.pointerType !== "mouse") return;
      // Capture pointer to receive events even when cursor leaves canvas.
      // Guarded: throws InvalidStateError if the pointer was released before
      // this handler ran (fast tap, synthetic events, etc.) — safe to ignore.
      try { canvas.setPointerCapture(event.pointerId); } catch { }
      // A deliberate click on the canvas is the re-engage gesture: clear the Right-Ctrl
      // host-release suppression so lock can be re-acquired.
      userReleasedLockRef.current = false;
      // Arm before requesting: this click may land inside the browser's post-exit refusal
      // window (Right Ctrl / ESC release), where the request is silently rejected. Armed,
      // the next gesture retries instead of the click being lost.
      armPointerLockGesture();
      // If cursor is hidden by guest, request pointer lock (user click = valid gesture)
      if (relativeIntent.get() && !pointerLockedRef.current) {
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
      if (event.pointerType !== "mouse") return;
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

    const panel = panelRef.current;
    /** Is this client point on the guest screen? */
    const updatePointerOverCanvas = (event: PointerEvent | null) => {
      let over = false;
      if (event) {
        const rect = liveCanvasRect();
        over = !!rect && rect.width > 0 && rect.height > 0
          && event.clientX >= rect.left && event.clientX < rect.right
          && event.clientY >= rect.top && event.clientY < rect.bottom;
      }
      if (isPointerOverCanvasRef.current === over) return;
      isPointerOverCanvasRef.current = over;
      syncCursorPresence();
    };
    // On the PANEL, so a move across the letterbox is seen even though the canvas — which
    // is what we are hit-testing against — receives nothing out there.
    // Touch counts too: a contact IS the pointer, and it is the only thing that puts a
    // pointer on the picture on a device with no mouse — without it the guest's cursor is
    // never drawn there and the fingertip offset has nothing to offset.
    const handlePanelPointer = (event: PointerEvent) => {
      updatePointerOverCanvas(event);
    };
    const handlePanelLeave = (event: PointerEvent) => {
      // Touch leaves on every lift, and the guest's cursor stays where the finger put it;
      // only a real hovering pointer can be somewhere else.
      if (event.pointerType !== "mouse") return;
      updatePointerOverCanvas(null);
    };
    panel?.addEventListener("pointerdown", handlePanelPointer);
    panel?.addEventListener("pointermove", handlePanelPointer);
    panel?.addEventListener("pointerleave", handlePanelLeave);
    
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
      inputDevice.setPointerBounds(width, height);
      inputDevice.setPointerAbsolute(
        (event.clientX - rect.left) * scaleX,
        (event.clientY - rect.top) * scaleY,
      );
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
      inputDevice.addWheel(pixelDelta);
      inputDevice.commit({ immediate: true });
      recordSample(inputView);

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
      syncCursorPresence();
      if (pointerLockedRef.current) {
        disarmPointerLockGesture();
        // The device already holds the last absolute position, which is exactly the
        // seed we want; nothing to publish because the position has not changed.
      } else {
        // Lock was lost (commonly ESC, which is also Unreal's menu key — the browser
        // force-exits lock on ESC). If the guest still wants relative mouse and the user did
        // NOT deliberately release via Right Ctrl, arm a re-acquire. handlePointerDown
        // re-requests on the next click (the reliable gesture); we also opportunistically
        // attempt on the next pointermove via writePointer.
        if (relativeIntent.get() && !userReleasedLockRef.current) {
          // A browser-initiated exit rejects re-acquire for over a second, so the retry
          // cannot be a one-shot: arm the gesture listener as well, so the next trusted
          // pointerdown ANYWHERE re-engages rather than only a click that happens to land
          // on the canvas. ESC is a menu key in most of these titles, so this path runs
          // every time the player opens and closes the menu.
          pointerLockCooldownRef.current = true;
          setTimeout(() => { pointerLockCooldownRef.current = false; }, POINTER_LOCK_EXIT_COOLDOWN_MS);
          armPointerLockGesture();
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

    // Nothing any producer holds may survive focus loss — a key or button still down
    // when the tab goes away has no release event coming.
    const handleBlur = () => {
      inputDevice.releaseAllSources();
      // Do NOT let the presser publish here: its own immediate commit would ship the
      // frame where the pad is released but not yet re-asserted, which reads as a
      // controller unplug on every tab hide.
      touchControlsRef.current?.releaseAll(false);
      // The gesture state machine has to forget the contact too — zeroing the source
      // level while the recognizer still believes its button is down leaves an edge
      // emitter with nothing to emit, and the drag stays dead until the finger lifts.
      touchDriver.reset();
      // Losing focus releases what was held; it does not unplug the controller.
      assertVirtualPad();
      inputDevice.commit({ immediate: true });
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
      rotateLogFile(bundleLogName(path) + "-hle");
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

    // opts.preload: download the whole bundle to OPFS before starting instead of
    // streaming it on demand (catalog entry `preload`) — see the worker's URL path.
    (window as any).loadApp = async (path: string, opts?: { preload?: boolean; args?: string }) => {
      console.log(`BottleShip: Loading App from ${path}`);
      rotateLogFile(bundleLogName(path));
      ensurePersistentStorageRequested();
      setIsLoadingApp(true);
      setErrorMessage(null); // Clear any previous errors
      setExitInfo(null); // Fresh load supersedes a prior exit/crash overlay
      setBundleDisplayName(null);
      document.title = "BottleShip";
      // Drop the previous PE's favicon until the next window_icon arrives.
      const iconLink = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (iconLink) {
        if (iconLink.href.startsWith("blob:")) URL.revokeObjectURL(iconLink.href);
        iconLink.removeAttribute("href");
      }
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
        globalWorker.postMessage({ type: "load_bundle", url: path, preload: opts?.preload === true, args: opts?.args });
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

    // A self re-exec from a loadApp(url) session (dev / harness / "?game=dev"): the reload
    // lands on a page that boots no game by itself, so replay the URL now that loadApp
    // exists. The worker already holds the launcher's command line (set_boot_args above);
    // a registered `?game=<id>` boot needs nothing here — its normal path picks the args up.
    if (reExecBundleUrl) {
      const url = reExecBundleUrl;
      reExecBundleUrl = null;
      void (window as any).loadApp(url);
    } else {
      // The dev bundle browser launches through a reload (see handleLaunchBundle): a fresh
      // page is the only teardown that is genuinely complete, so back-to-back regression
      // runs can't inherit the previous game's worker state.
      try {
        const pending = sessionStorage.getItem(PENDING_BUNDLE_KEY);
        if (pending) {
          sessionStorage.removeItem(PENDING_BUNDLE_KEY);
          void (window as any).loadApp(pending);
        }
      } catch { /* no pending bundle */ }
    }

    const applyInputSample = (sample: InputSample) => {
      if (!globalInputView) return;
      inputDevice.setPointerAbsolute(sample.mouseX, sample.mouseY);
      // The absolute position is authoritative on replay, so feed the device deltas
      // through the RAW channel only — a relative-mouse title reads nothing else.
      if (sample.dinputDX || sample.dinputDY) {
        inputDevice.addPointerRelative(0, 0, sample.dinputDX ?? 0, sample.dinputDY ?? 0);
      }
      inputDevice.setButtonsMask(sample.buttons, "replay");
      if (sample.keyCode) inputDevice.setKey(sample.keyCode, sample.keyState === 1, "replay");
      inputDevice.publishPad({
        connected: sample.gamepadConnected === 1,
        buttons: sample.gamepadButtons,
        axes: [sample.gamepadAxis0, sample.gamepadAxis1, sample.gamepadAxis2, sample.gamepadAxis3],
      }, "replay");
      if (sample.mouseWheel) inputDevice.addWheel(sample.mouseWheel);
      inputDevice.commit({ immediate: true });
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
      window.visualViewport?.removeEventListener("scroll", resize);
      document.removeEventListener("fullscreenchange", resize);
      resizeObserver.disconnect();
      detachTouch();
      canvas.removeEventListener("pointermove", writePointer);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerenter", handlePointerEnter);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      panel?.removeEventListener("pointerdown", handlePanelPointer);
      panel?.removeEventListener("pointermove", handlePanelPointer);
      panel?.removeEventListener("pointerleave", handlePanelLeave);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      // The armed capture-phase listener outlives this effect otherwise, and would keep
      // requesting lock against a stale canvasRef after unmount/remount.
      disarmPointerLockGesture();
      guestCursor.dispose();
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
          inputDevice.publishPad({
            connected: connected === 1,
            buttons: buttonsMask,
            axes: [axes[0], axes[1], axes[2], axes[3]],
          }, "hw-pad");
          inputDevice.commit({ immediate: true });
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
      // Lock the WHOLE keyboard, not a key list. A guest binds what it likes — Far Cry's
      // crouch-walk is Ctrl+W, which is also "close tab" — and a UA shortcut cannot be
      // preventDefault'ed, so an un-locked combination takes the tab down mid-game. Naming
      // keys here would mean enumerating every combination every game might bind.
      // The user is not trapped: with the keyboard locked the UA still exits fullscreen on
      // a HELD Escape, and a short Escape reaches the guest as its menu key.
      // Unsupported / not granted → unchanged behaviour, the reserved keys stay the UA's.
      if (fs) kb?.lock?.().catch(() => { /* best-effort */ });
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

  // A running game is not user activity as far as the OS is concerned, so the screen
  // dims mid-session on a phone or tablet. The lock is dropped by the browser on tab
  // hide and must be re-taken when we come back.
  useEffect(() => {
    if (workerStatus !== "ready" || isPaused) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    if (!nav.wakeLock) return;

    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = () => {
      if (cancelled || document.hidden) return;
      nav.wakeLock!.request("screen")
        .then((s) => { if (cancelled) void s.release(); else sentinel = s; })
        .catch(() => { /* denied (battery saver, no gesture yet) — not worth surfacing */ });
    };
    acquire();
    const onVisible = () => { if (!document.hidden) acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [workerStatus, isPaused]);

  const handleHostAction = useCallback((action: HostAction) => {
    switch (action) {
      case "fullscreen": toggleFullscreenRef.current(); break;
      // The real toggle: the HUD is the only pause affordance on a keyboard-less
      // device, and flipping the flag alone leaves the emulator running with audio
      // that can never resume (isPausedRef then suppresses every resume attempt).
      case "pause": void togglePause(); break;
      case "keyboard": setOskOpen((v) => !v); break;
      case "toggleControls": setControlsHidden((v) => !v); break;
      case "releaseRelative":
        // The touch equivalent of Right Ctrl: give the cursor back without a keyboard.
        userReleasedLockRef.current = true;
        if (document.pointerLockElement) document.exitPointerLock();
        break;
      case "editLayout": break;
    }
  }, [togglePause]);

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

    // iPhone Safari has no element Fullscreen API at all. Fall back to an immersive
    // CSS mode rather than resolving to undefined and appearing to do nothing.
    if (!target.requestFullscreen && !element.webkitRequestFullscreen) {
      setImmersive((v) => !v);
      return;
    }

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
      // These games are landscape. Best-effort: unimplemented on iOS Safari and
      // rejected on Android outside real fullscreen, and neither is an error here.
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      void orientation?.lock?.("landscape").catch(() => {});
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

  /** Dev bundle browser: open a bundle through a page reload rather than in place, so a
   *  regression pass never carries the previous game's state into the next one. */
  const handleLaunchBundle = useCallback((url: string) => {
    try {
      sessionStorage.setItem(PENDING_BUNDLE_KEY, url);
      window.location.reload();
    } catch {
      void (window as any).loadApp?.(url); // sessionStorage unavailable — load in place
    }
  }, []);

  /** One request/reply round-trip to the worker's aot_cmd channel. */
  const aotCmd = useCallback((cmd: string, extra: Record<string, unknown> = {}) => {
    return new Promise<any>((resolve) => {
      if (!globalWorker) { resolve(null); return; }
      const handler = (e: MessageEvent) => {
        if (e.data?.type !== "aot_result" || e.data.cmd !== cmd) return;
        globalWorker!.removeEventListener("message", handler);
        resolve(e.data);
      };
      globalWorker.addEventListener("message", handler);
      globalWorker.postMessage({ type: "aot_cmd", cmd, ...extra });
    });
  }, []);

  const describeAot = useCallback((r: any): string => {
    if (!r) return "no worker";
    if (!r.ok) return `error: ${r.result}`;
    const s = r.result ?? {};
    if (s.saved) {
      const saved = s.saved?.saved ?? s.saved?.error ?? "?";
      return `saved ${saved} unit(s) from ${s.captured?.modules ?? 0} module(s)`;
    }
    const e = s.entered;
    const rec = s.recording;
    const parts: string[] = [];
    if (rec?.armed) parts.push(`recording ${rec.modules} module(s)${rec.dropped ? `, ${rec.dropped} dropped` : ""}`);
    if (s.units) parts.push(`${s.units} unit(s) loaded`);
    if (e && e.units) parts.push(`${e.enteredUnits}/${e.alive} entered`);
    return parts.join(" · ") || "idle";
  }, []);

  const handleAotRecord = useCallback(async () => {
    const next = !aotRecording;
    const r = await aotCmd(next ? "start" : "stop");
    setAotRecording(next && !!r?.ok);
    setAotStatus(describeAot(r));
    // A stop that failed must not leave the button reading "recording": the whole point of
    // showing state is that the ritual's silent failure becomes visible.
    if (!next && r?.ok) setAotRecording(false);
  }, [aotRecording, aotCmd, describeAot]);

  const handleAotAutoLoad = useCallback(async () => {
    const next = !aotAutoLoad;
    const r = await aotCmd("autoload", { enabled: next });
    setAotAutoLoad(next);
    setAotStatus(describeAot(r));
  }, [aotAutoLoad, aotCmd, describeAot]);

  const handleAotStatus = useCallback(async () => {
    setAotStatus(describeAot(await aotCmd("status")));
  }, [aotCmd, describeAot]);

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
        <VirtualKeyboardSheet open={oskOpen} onClose={() => setOskOpen(false)} />
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

  if (!browserSupport.supported || policyBlock) {
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
          {/* Our own heading would put a second language on a screen whose only sentence
              the operator wrote for their audience. */}
          {!policyBlock && (
            <h1 style={{ margin: 0, fontSize: "1.3rem", color: "#ff8f8f" }}>
              Unsupported browser
            </h1>
          )}
          <p style={{
            margin: 0,
            color: policyBlock ? "#f0e2e2" : "#d3c2c2",
            fontSize: policyBlock ? "1.05rem" : undefined,
            lineHeight: 1.45,
          }}>
            {browserUnsupportedMessage}
          </p>
          {/* A policy message is written by the operator for their own audience and already
              says what to do — anything we add here is a second voice, in our language. */}
          {!policyBlock && (
            <p style={{ margin: 0, color: "#9f8c8c", fontSize: "0.92rem" }}>
              Launching games is disabled in this browser. Open the page in an up-to-date Google Chrome or Safari 26+ and try again.
            </p>
          )}
          {/* Under a policy block the library is the same blocked page — offering it back
              is a dead end. */}
          {!policyBlock && (
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
          )}
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
      className={cx(s, "app", uiSettings.lockFullscreenAspect ? "app--fullscreen-aspect-lock" : "app--fullscreen-aspect-free", uiSettings.integerScaling && "app--fullscreen-integer", immersive && "app--immersive")}
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
          onOpenBundles={import.meta.env.DEV ? () => setWgbBrowserOpen(true) : undefined}
          onOpenOpfsTool={() => setOpfsToolOpen(true)}
          onOpenRegistryTool={() => setRegistryToolOpen(true)}
          fpuStrictEnabled={fpuStrictEnabled}
          onToggleFpuStrict={handleToggleFpuStrict}
          aotRecording={aotRecording}
          aotAutoLoad={aotAutoLoad}
          aotStatus={aotStatus}
          onAotRecord={handleAotRecord}
          onAotAutoLoad={handleAotAutoLoad}
          onAotStatus={handleAotStatus}
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
        {/* The guest's pointer — the canvas hides the OS one unconditionally. See ./guest-cursor. */}
        <canvas ref={cursorCanvasRef} className={s["app__cursor"]} aria-hidden />
        {workerStatus === "ready" && showTouchControls && (
          <TouchControlLayer
            ref={touchControlsRef}
            layout={activeLayout.layout}
            getPointerScale={guestPerCss}
            sensitivity={uiSettings.touchSensitivity}
            idleFade={uiSettings.touchIdleFade}
            onHostAction={handleHostAction}
          />
        )}
        {workerStatus === "ready" && <InputStatusOverlay status={inputStatus} />}
        {workerStatus === "ready" && showTouchHud && (
          <TouchHud onHostAction={handleHostAction} />
        )}
        {workerStatus === "ready" && (
          <TouchFirstRunHint
            active={showTouchControls}
            trackpad={activeLayout.mode === "trackpad"}
          />
        )}
        {/* The HUD's keyboard action only exists on this screen, so the sheet has to be
            mounted here too — not only in the library return. */}
        <VirtualKeyboardSheet open={oskOpen} onClose={() => setOskOpen(false)} />
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
      {import.meta.env.DEV && (
        <WgbBrowser
          isOpen={wgbBrowserOpen}
          onClose={() => setWgbBrowserOpen(false)}
          onLaunch={handleLaunchBundle}
        />
      )}
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
