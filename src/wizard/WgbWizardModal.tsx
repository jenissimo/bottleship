import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui/cx";
import s from "./WgbWizardModal.module.css";
import os from "../ui/Overlay/Overlay.module.css";
import bm from "../ui/Button/Button.module.css";
import cb from "../ui/CloseButton/CloseButton.module.css";
import ch from "../ui/Chip/Chip.module.css";
import sh from "../ui/SectionHeading/SectionHeading.module.css";
import hm from "../ui/Hint/Hint.module.css";
import { Spacer } from "../ui/Spacer";
import { useHostModal } from "../harness/use-host-modal";
import {
  X,
  UploadSimple,
  Folder,
  FolderOpen,
  Link,
  PencilSimple,
  Play,
  HardDrive,
  ArrowLineDown,
  CaretLeft,
  CaretRight,
  CaretDown,
  File as FileIcon,
  FileText,
  GearSix,
  Sliders,
  FileCode,
  Binary,
  FileImage,
  FileZip,
  FileAudio,
  FileVideo,
  BracketsCurly,
  Question,
  CircleNotch,
  FloppyDisk,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type {
  BuildSource,
  StagedEntry,
  SourceDetection,
  FinalizeDestination,
} from "../worker/runtime/filesystem/wgb-build";
import { manifestToWgbFilename } from "@bottleship/formats/wgb/container-id";
import { downloadBlob } from "../settings/SettingsIconBtn";
import { isSaveFilePickerSupported, pickSaveWgbFile, writeBytesToFileHandle, WGB_SAVE_PACK_PERCENT } from "../save-as";

/**
 * WgbWizardModal — the WGB wizard.
 *
 * 4 steps: Source -> Process -> Configure -> Finish. Absorbs AddGameModal.
 *
 * Worker seam: the bare library screen has NO live emulator worker
 * (App.tsx only creates one once a game/canvas mounts). So this wizard owns a
 * DEDICATED worker for build/inspect/finalize (library + download destinations are
 * fully wired through it). The "Play now" destination cannot boot in that workerless
 * wizard context, so it is routed back out via the `onPlay` callback to App's existing
 * navigate+stage launch flow — the one path that already boots a game. See TODO(stage2-worker).
 */

// --- the bottle mark (only inline SVG kept; copied from GameSelectScreen.tsx) -------
function BottleMark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
        <path d="M26 6h12v8l4 4v6H22v-6l4-4z" />
        <rect x="14" y="24" width="36" height="34" rx="9" />
        <path d="M20 46c6-3 8-10 14-10s9 6 14 4" strokeOpacity=".5" />
      </g>
      <path d="M30 32l8 5-8 5z" fill="var(--amber)" stroke="none" />
    </svg>
  );
}

// --- content tree row (recursive) --------------------------------------------------

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  pins: Record<string, PinKind>;
  expanded: Set<string>;
  edited: Record<string, string>;
  onToggleFolder: (path: string) => void;
  onCycleFile: (path: string) => void;
  onCycleFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function TreeRow(props: TreeRowProps): React.ReactElement {
  const { node, depth, pins, expanded, edited, onToggleFolder, onCycleFile, onCycleFolder, onOpenFile } = props;
  const pin = pins[node.path];
  const isEdited = !node.isDir && Object.prototype.hasOwnProperty.call(edited, node.path);
  const rowStyle =
    pin === "entry"
      ? { background: "var(--surf-amber)" }
      : pin === "patch"
        ? { background: "var(--surf-cyan)" }
        : pin === "cd"
          ? { background: "var(--surf-mint)" }
          : undefined;
  const pad = { paddingLeft: 9 + depth * 16 } as React.CSSProperties;
  const isOpen = node.isDir && expanded.has(node.path);

  if (node.isDir) {
    const FolderIcon = isOpen ? FolderOpen : Folder;
    const Chevron = isOpen ? CaretDown : CaretRight;
    return (
      <>
        <button
          type="button"
          className={s["row"]}
          data-tree-path={node.path}
          style={{ ...rowStyle, ...pad }}
          title="Click to expand / collapse"
          onClick={() => onToggleFolder(node.path)}
        >
          <span className={s["ic"]}>
            <Chevron size={13} aria-hidden />
          </span>
          <span className={s["ic"]}>
            <FolderIcon size={14} aria-hidden />
          </span>
          <span className={s["nm"]}>{node.label}/</span>
          <span className={s["row__right"]}>
            {pin === "cd" ? (
              <span
                className={cx(s, "pin", "pin--cd")}
                onClick={(e) => {
                  e.stopPropagation();
                  onCycleFolder(node.path);
                }}
                title="Unpin CD root"
              >
                cd root
              </span>
            ) : (
              <>
                <span
                  className={s["row__cdset"]}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCycleFolder(node.path);
                  }}
                  title="Pin as CD root (cdPath)"
                >
                  cd root
                </span>
                <span className={s["sz"]}>{node.fileCount} · {formatSize(node.size)}</span>
              </>
            )}
          </span>
        </button>
        {isOpen &&
          node.children?.map((c) => (
            <TreeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              pins={pins}
              expanded={expanded}
              edited={edited}
              onToggleFolder={onToggleFolder}
              onCycleFile={onCycleFile}
              onCycleFolder={onCycleFolder}
              onOpenFile={onOpenFile}
            />
          ))}
      </>
    );
  }

  const Icon = fileIcon(node.path);
  const editable = isEditable(node.path, node.size);
  return (
    <button
      type="button"
      className={s["row"]}
      data-tree-path={node.path}
      style={{ ...rowStyle, ...pad }}
      title={editable ? "Click to edit · use the tag to pin" : "Click to cycle pin: entry / patch / cd root"}
      onClick={() => (editable ? onOpenFile(node.path) : onCycleFile(node.path))}
    >
      <span className={s["ic"]} style={{ marginLeft: 16 }}>
        <Icon size={13} aria-hidden />
      </span>
      <span className={s["nm"]}>{node.label}</span>
      {pin ? (
        <span
          className={cx(s, "pin", `pin--${pin}`)}
          onClick={(e) => {
            e.stopPropagation();
            onCycleFile(node.path);
          }}
        >
          {pin === "cd" ? "cd root" : pin}
        </span>
      ) : (
        <>
          {isEdited && <span className={cx(s, "pin", "pin--patch")}>edited</span>}
          <span
            className={s["sz"]}
            onClick={
              editable
                ? (e) => {
                    e.stopPropagation();
                    onCycleFile(node.path);
                  }
                : undefined
            }
            title={editable ? "Pin instead of edit" : undefined}
          >
            {formatSize(node.size)}
          </span>
        </>
      )}
    </button>
  );
}

// --- manifest <-> form shape --------------------------------------------------------

type Manifest = Record<string, any>;

const OS_PRESETS: Record<string, { major: number; minor: number; build: number; platformId: number }> = {
  win95: { major: 4, minor: 0, build: 950, platformId: 1 },
  win98: { major: 4, minor: 10, build: 2222, platformId: 1 },
  winnt: { major: 4, minor: 0, build: 1381, platformId: 2 },
  win2k: { major: 5, minor: 0, build: 2195, platformId: 2 },
  winxp: { major: 5, minor: 1, build: 2600, platformId: 2 },
};

interface FormState {
  name: string;
  gameId: string;
  entrypoint: string;
  args: string;
  width: string;
  height: string;
  bpp: string;
  ram: string; // MB
  os: string;
  skipVideo: boolean;
  cdPath: string;
}

/** Reverse-map an osVersion blob to the closest preset key (for the OS <select>). */
function osKeyFromManifest(m: Manifest): string {
  const ov = m?.emulator?.osVersion;
  if (!ov) return "win98";
  for (const [key, p] of Object.entries(OS_PRESETS)) {
    if (p.major === ov.major && p.minor === ov.minor && p.platformId === ov.platformId) return key;
  }
  return ov.platformId === 2 ? "winxp" : "win98";
}

function manifestToForm(m: Manifest): FormState {
  const emu = m?.emulator ?? {};
  const res = emu.screenResolution ?? {};
  const ramBytes = emu.memory?.ram;
  return {
    name: String(m?.title ?? m?.name ?? ""),
    gameId: String(m?.gameId ?? ""),
    entrypoint: String(m?.entrypoint ?? ""),
    args: String(m?.args ?? ""),
    width: res.width != null ? String(res.width) : "",
    height: res.height != null ? String(res.height) : "",
    bpp: res.bpp != null ? String(res.bpp) : "",
    ram: ramBytes != null ? String(Math.round(ramBytes / (1024 * 1024))) : "",
    os: osKeyFromManifest(m),
    skipVideo: Boolean(emu.skipVideo),
    cdPath: String(emu.cdPath ?? ""),
  };
}

/** Apply the editable form back onto the staged manifest (deep, only known fields). */
function applyFormToManifest(base: Manifest, f: FormState): Manifest {
  const out: Manifest = { ...base };
  out.name = f.name;
  if (f.name) out.title = f.name;
  out.gameId = f.gameId || undefined;
  out.entrypoint = f.entrypoint;
  if (f.args) out.args = f.args; else delete out.args;

  const emu: Manifest = { ...(out.emulator ?? {}) };
  const w = parseInt(f.width, 10);
  const h = parseInt(f.height, 10);
  const bpp = parseInt(f.bpp, 10);
  if (Number.isFinite(w) && Number.isFinite(h)) {
    emu.screenResolution = {
      ...(emu.screenResolution ?? {}),
      width: w,
      height: h,
      ...(Number.isFinite(bpp) ? { bpp } : {}),
    };
  }
  const ramMb = parseInt(f.ram, 10);
  if (Number.isFinite(ramMb) && ramMb > 0) {
    emu.memory = { ...(emu.memory ?? {}), ram: ramMb * 1024 * 1024 };
  }
  const preset = OS_PRESETS[f.os];
  if (preset) emu.osVersion = { ...preset };
  emu.skipVideo = f.skipVideo;
  if (f.cdPath) emu.cdPath = f.cdPath; else delete emu.cdPath;
  out.emulator = emu;
  return out;
}

// --- props --------------------------------------------------------------------------

export interface WgbWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  disabled?: boolean;
  /**
   * "Play now" outcome. The wizard CANNOT boot a game itself (no canvas/worker in the
   * library context), so it hands the chosen source back to App, which routes it through
   * the existing navigate+stage launch flow. Receives the original picked file(s)/url.
   */
  onPlay: (payload: { files?: File[]; url?: string }) => void;
  /** Open the right-hand library/storage view (for "Edit one in your library"). */
  onEditLibrary?: () => void;
  /** Called after a successful library persist so App can refresh its added-games list. */
  onPersisted?: () => void;
}

type StepId = 1 | 2 | 3 | 4;
const STEP_NAMES = ["Source", "Process", "Configure", "Finish"] as const;

type PinKind = "entry" | "patch" | "cd";

const supportsDirPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

export default function WgbWizardModal({
  isOpen,
  onClose,
  disabled = false,
  onPlay,
  onEditLibrary,
  onPersisted,
}: WgbWizardModalProps): React.ReactElement | null {
  // Host modal, not a guest one — see harness/use-host-modal.ts.
  useHostModal("wgbWizard", isOpen, { caption: "Add a game" });
  const [step, setStep] = useState<StepId>(1);
  const [maxStepReached, setMaxStepReached] = useState<StepId>(1);

  // The original picked source (kept so "Play now" can route through App's launch flow).
  const [pickedFiles, setPickedFiles] = useState<File[] | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);

  // Build results from the worker.
  const [progress, setProgress] = useState<{ phase: string; percent: number; label: string }>({
    phase: "",
    percent: 0,
    label: "",
  });
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detections, setDetections] = useState<SourceDetection | null>(null);
  const [stagedPath, setStagedPath] = useState<string | null>(null);
  const [baseManifest, setBaseManifest] = useState<Manifest | null>(null);
  const [entries, setEntries] = useState<StagedEntry[]>([]);
  const [form, setForm] = useState<FormState | null>(null);

  // Per-file pins from the content tree (rel path -> kind).
  const [pins, setPins] = useState<Record<string, PinKind>>({});

  // Collapsible tree: set of expanded folder paths.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Inline editor: which file is open (staged entry path), its loaded text, and edits.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [editorText, setEditorText] = useState<string>("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  // Edited text files kept in component state (bundle-path -> new UTF-8 text); written on Finish.
  const [editedFiles, setEditedFiles] = useState<Record<string, string>>({});

  const [destination, setDestination] = useState<FinalizeDestination>("play");
  const [urlInput, setUrlInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeProgress, setFinalizeProgress] = useState<{ percent: number; label: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // --- dedicated wizard worker (lazy; created on first need) -----------------------
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      // TODO(stage2-worker): this is a dedicated, build-only worker. It can extract /
      // synthesize / pack / persist / download, but it has no OffscreenCanvas, so it
      // CANNOT boot a game. "Play now" therefore routes via onPlay (App's launch flow).
      workerRef.current = new Worker(
        new URL("../worker/emulator.worker.ts", import.meta.url),
        { type: "module" },
      );
    }
    return workerRef.current;
  }, []);

  // Tear the worker down when the wizard fully closes (free the heavy worker).
  useEffect(() => {
    if (!isOpen && workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, [isOpen]);
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const resetState = useCallback(() => {
    setStep(1);
    setMaxStepReached(1);
    setPickedFiles(null);
    setPickedUrl(null);
    setProgress({ phase: "", percent: 0, label: "" });
    setBuilding(false);
    setError(null);
    setDetections(null);
    setStagedPath(null);
    setBaseManifest(null);
    setEntries([]);
    setForm(null);
    setPins({});
    setExpanded(new Set());
    setOpenFile(null);
    setEditorText("");
    setEditorLoading(false);
    setEditorError(null);
    setEditedFiles({});
    setDestination("play");
    setUrlInput("");
    setFinalizing(false);
    setFinalizeProgress(null);
  }, []);

  // Reset when (re)opened.
  useEffect(() => {
    if (isOpen) resetState();
  }, [isOpen, resetState]);

  const goStep = useCallback(
    (s: StepId) => {
      if (s < 1 || s > 4) return;
      // Can only advance to a step already reached (forward gated by the flow).
      if (s > maxStepReached) return;
      setStep(s);
    },
    [maxStepReached],
  );

  const advanceTo = useCallback((s: StepId) => {
    setStep(s);
    setMaxStepReached((prev) => (s > prev ? s : prev));
  }, []);

  // --- build (Step 1 -> Step 2 -> Step 3) ------------------------------------------
  const startBuild = useCallback(
    (source: BuildSource) => {
      setError(null);
      setBuilding(true);
      setProgress({ phase: "detecting", percent: 0, label: "Inspecting source" });
      advanceTo(2);

      const worker = getWorker();
      const handler = (e: MessageEvent) => {
        const d = e.data;
        if (!d || typeof d.type !== "string") return;
        if (d.type === "wgb_build_progress") {
          setProgress({ phase: d.phase, percent: d.percent ?? 0, label: d.label ?? "" });
        } else if (d.type === "wgb_build_done") {
          worker.removeEventListener("message", handler);
          setBuilding(false);
          setStagedPath(d.stagedPath ?? null);
          setBaseManifest(d.manifest ?? {});
          const ents: StagedEntry[] = Array.isArray(d.entries) ? d.entries : [];
          setEntries(ents);
          // Default: top-level folders open, plus every folder on the path to the entry exe.
          const expand = new Set<string>();
          for (const e of ents) {
            const first = e.name.split("/")[0];
            if (first && e.name.includes("/") && first !== e.name) expand.add(first);
          }
          const ep = String((d.manifest ?? {}).entrypoint ?? "");
          const epNorm = ep ? normalizeRom(ep) : "";
          if (epNorm) {
            const parts = epNorm.split("/");
            for (let i = 1; i < parts.length; i++) expand.add(parts.slice(0, i).join("/"));
          }
          setExpanded(expand);
          setDetections(d.detections ?? null);
          const f = manifestToForm(d.manifest ?? {});
          // Seed the entrypoint pin from the manifest + scroll it into view.
          if (epNorm) {
            setPins({ [epNorm]: "entry" });
            setTimeout(() => {
              try {
                document
                  .querySelector(`[data-tree-path="${CSS.escape(epNorm)}"]`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
              } catch {
                /* ignore */
              }
            }, 120);
          }
          setForm(f);
          // If the detection is unambiguous, hop straight to Configure; otherwise the
          // Process step shows the entrypoint question and the user clicks Next.
          const ambiguous = (d.detections?.exeCandidates?.length ?? 0) > 1;
          if (!ambiguous) advanceTo(3);
          else advanceTo(2);
        } else if (d.type === "wgb_build_error") {
          worker.removeEventListener("message", handler);
          setBuilding(false);
          setError(String(d.message ?? "Build failed"));
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "wgb_build_start", source });
    },
    [advanceTo, getWorker],
  );

  // --- source pickers (Step 1) -----------------------------------------------------
  const acceptFiles = useCallback(
    (list: FileList | File[] | null | undefined) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      setError(null);
      const ext = (f: File) => f.name.toLowerCase().split(".").pop() ?? "";

      // single .wgb, single archive (.zip/.7z), single GOG setup.exe, or setup.exe + setup-*.bin slices.
      const exes = files.filter((f) => ext(f) === "exe");
      const bins = files.filter((f) => ext(f) === "bin");
      const isWgb = files.length === 1 && ext(files[0]!) === "wgb";
      const isArchive = files.length === 1 && (ext(files[0]!) === "zip" || ext(files[0]!) === "7z");
      const isGogMulti = exes.length === 1 && exes.length + bins.length === files.length;

      if (!isWgb && !isArchive && !isGogMulti) {
        setError(
          "Drop a single .wgb, an installer (.zip / .7z), a GOG setup.exe, or setup.exe together with all its setup-*.bin slices.",
        );
        return;
      }

      setPickedFiles(files);
      setPickedUrl(null);
      const source: BuildSource =
        files.length === 1 ? { blob: files[0]! } : { blobs: files };
      startBuild(source);
    },
    [startBuild],
  );

  const pickFolder = useCallback(async () => {
    if (!supportsDirPicker) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dirHandle: any = await (window as any).showDirectoryPicker();
      const map = new Map<string, Uint8Array>();
      const walk = async (handle: any, prefix: string): Promise<void> => {
        for await (const [name, child] of handle.entries()) {
          const rel = prefix ? `${prefix}/${name}` : name;
          if (child.kind === "file") {
            const file: File = await child.getFile();
            map.set(rel, new Uint8Array(await file.arrayBuffer()));
          } else if (child.kind === "directory") {
            await walk(child, rel);
          }
        }
      };
      await walk(dirHandle, "");
      if (map.size === 0) {
        setError("That folder is empty.");
        return;
      }
      setPickedFiles(null);
      setPickedUrl(null);
      // A folder source has no File[] to hand to onPlay; "Play now" will fall back to
      // library + navigate after finalize (handled in onConfirm).
      startBuild({ files: map });
    } catch (err) {
      // AbortError = user cancelled the picker; ignore.
      if ((err as DOMException)?.name !== "AbortError") {
        setError(`Folder pick failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }, [startBuild]);

  const submitUrl = useCallback(() => {
    const v = urlInput.trim();
    if (!v) return;
    if (!/\.wgb(\?|#|$)/i.test(v)) {
      setError("URL loading expects a direct link to a .wgb bundle.");
      return;
    }
    setPickedUrl(v);
    setPickedFiles(null);
    startBuild({ url: v });
  }, [urlInput, startBuild]);

  // --- content-tree pins (Step 3) --------------------------------------------------
  const cyclePin = useCallback((rel: string) => {
    setPins((prev) => {
      const cur = prev[rel];
      const next: Record<string, PinKind> = { ...prev };
      const isExe = /\.exe$/i.test(rel);
      // Cycle: none -> entry(exe) | patch(file) -> patch | cd(dir) -> none
      const order: PinKind[] = isExe ? ["entry", "patch"] : ["patch", "cd"];
      if (!cur) {
        next[rel] = order[0]!;
      } else {
        const idx = order.indexOf(cur);
        if (idx === -1 || idx === order.length - 1) delete next[rel];
        else next[rel] = order[idx + 1]!;
      }
      // Only one entry pin at a time.
      if (next[rel] === "entry") {
        for (const k of Object.keys(next)) {
          if (k !== rel && next[k] === "entry") delete next[k];
        }
      }
      return next;
    });
  }, []);

  // Folder rows toggle between "cd root" and none (a folder can be the CD path).
  const cycleFolderPin = useCallback((path: string) => {
    setPins((prev) => {
      const next: Record<string, PinKind> = { ...prev };
      if (next[path] === "cd") delete next[path];
      else {
        // Only one cd pin at a time.
        for (const k of Object.keys(next)) if (next[k] === "cd") delete next[k];
        next[path] = "cd";
      }
      return next;
    });
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // The hierarchical tree (rebuilt when entries change).
  const tree = useMemo(() => buildTree(entries), [entries]);
  const fileCount = useMemo(() => entries.filter((e) => !e.isDirectory).length, [entries]);

  // Open a small text file in the inline editor (read on demand from the staged bundle,
  // or from the in-memory edit if it was already changed this session).
  const openEditor = useCallback(
    (name: string) => {
      if (!stagedPath) return;
      setOpenFile(name);
      setEditorError(null);
      if (Object.prototype.hasOwnProperty.call(editedFiles, name)) {
        setEditorText(editedFiles[name]!);
        setEditorLoading(false);
        return;
      }
      setEditorLoading(true);
      setEditorText("");
      const worker = getWorker();
      const handler = (e: MessageEvent) => {
        const d = e.data;
        if (!d || typeof d.type !== "string") return;
        if (d.type === "wgb_read_entry_done" && d.name === name) {
          worker.removeEventListener("message", handler);
          setEditorLoading(false);
          setEditorText(String(d.text ?? ""));
        } else if (d.type === "wgb_read_entry_error" && d.name === name) {
          worker.removeEventListener("message", handler);
          setEditorLoading(false);
          setEditorError(String(d.message ?? "Could not read file"));
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "wgb_read_entry", stagedPath, name });
    },
    [stagedPath, editedFiles, getWorker],
  );

  const closeEditor = useCallback(() => {
    setOpenFile(null);
    setEditorText("");
    setEditorError(null);
  }, []);

  // Persist the editor buffer into the edited-files map (kept until Finish).
  const saveEditor = useCallback(() => {
    if (!openFile) return;
    setEditedFiles((prev) => ({ ...prev, [openFile]: editorText }));
    setOpenFile(null);
    setEditorError(null);
  }, [openFile, editorText]);

  // Reflect entry/cd pins into the form (entrypoint / cdPath) live.
  useEffect(() => {
    if (!form) return;
    const entryRel = Object.entries(pins).find(([, k]) => k === "entry")?.[0];
    const cdRel = Object.entries(pins).find(([, k]) => k === "cd")?.[0];
    setForm((prev) => {
      if (!prev) return prev;
      const nextEntry = entryRel ?? prev.entrypoint;
      const nextCd = cdRel ? `C:\\${stripRom(cdRel).replace(/\//g, "\\")}` : prev.cdPath;
      if (nextEntry === prev.entrypoint && nextCd === prev.cdPath) return prev;
      return { ...prev, entrypoint: nextEntry, cdPath: nextCd };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);

  // --- finalize (Step 4) -----------------------------------------------------------
  const buildEditedManifest = useCallback((): Manifest => {
    const base = baseManifest ?? {};
    return applyFormToManifest(base, form ?? manifestToForm(base));
  }, [baseManifest, form]);

  // writeFiles list from "patch" pins (rel paths under rom/ stripped to guest-relative).
  const writeFilesList = useMemo(
    () => Object.entries(pins).filter(([, k]) => k === "patch").map(([rel]) => stripRom(rel)),
    [pins],
  );

  const onConfirm = useCallback(async () => {
    setError(null);

    // Carry writeFiles overrides into the manifest emulator block if any patch pins exist.
    const manifest = buildEditedManifest();
    if (writeFilesList.length > 0) {
      manifest.emulator = { ...(manifest.emulator ?? {}), writeFiles: writeFilesList };
    }

    if (destination === "play") {
      // The wizard can't boot — route the ORIGINAL source through App's launch flow.
      // (If the source was a picked folder there's no File[]; fall through to library.)
      if (pickedFiles && pickedFiles.length > 0) {
        onPlay({ files: pickedFiles });
        onClose();
        return;
      }
      if (pickedUrl) {
        onPlay({ url: pickedUrl });
        onClose();
        return;
      }
      // Folder source (or no original): finalize to library, then ask App to play it.
      // Falls through to the finalize path below with a play-then-navigate flow.
    }

    if (!stagedPath) {
      setError("No staged bundle to finalize.");
      return;
    }

    // Save As must run synchronously with the click gesture — pick the path before packing.
    let saveHandle: FileSystemFileHandle | null = null;
    if (destination === "download" && isSaveFilePickerSupported()) {
      try {
        saveHandle = await pickSaveWgbFile(manifestToWgbFilename(manifest));
      } catch (err) {
        setError(`Save dialog failed: ${String((err as Error)?.message ?? err)}`);
        return;
      }
      if (!saveHandle) return;
    }

    setFinalizing(true);
    setFinalizeProgress({ percent: 0, label: "Preparing package…" });
    const worker = getWorker();
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d.type !== "string") return;
      if (d.type === "wgb_finalize_progress") {
        setFinalizeProgress({
          percent: Number(d.percent) || 0,
          label: String(d.label ?? "Working…"),
        });
      } else if (d.type === "wgb_finalize_done") {
        worker.removeEventListener("message", handler);
        void (async () => {
          if (d.destination === "download" && d.bytes) {
            const filename = String(d.suggestedFilename ?? "game.wgb");
            try {
              if (saveHandle) {
                await writeBytesToFileHandle(saveHandle, d.bytes, (written, size) => {
                  const span = 100 - WGB_SAVE_PACK_PERCENT;
                  const pct = WGB_SAVE_PACK_PERCENT + Math.round((written / size) * span);
                  setFinalizeProgress({
                    percent: pct,
                    label: `Writing to disk (${formatSize(written)} / ${formatSize(size)})…`,
                  });
                });
              } else {
                setFinalizeProgress({ percent: 90, label: "Starting download…" });
                downloadBlob(d.bytes, filename);
                setFinalizeProgress({ percent: 100, label: "Download started" });
              }
            } catch (err) {
              setFinalizing(false);
              setFinalizeProgress(null);
              setError(`Save failed: ${String((err as Error)?.message ?? err)}`);
              return;
            }
          } else if (d.destination === "library") {
            setFinalizeProgress({ percent: 100, label: "Saved to library" });
          }
          if (d.destination === "library") {
            onPersisted?.();
          }
          // For the folder-source "play" fallback: persisted to library, now launch by url.
          if (destination === "play" && d.destination === "library") {
            onPersisted?.();
            onPlay({ url: `/apps/byo/${String(d.cacheKey ?? d.suggestedFilename ?? "")}` });
          }
          setFinalizing(false);
          setFinalizeProgress(null);
          onClose();
        })();
      } else if (d.type === "wgb_finalize_error") {
        worker.removeEventListener("message", handler);
        setFinalizing(false);
        setFinalizeProgress(null);
        setError(String(d.message ?? "Finalize failed"));
      }
    };
    worker.addEventListener("message", handler);
    // A folder-source "play" finalizes to library (so it can be launched by url afterwards).
    const finalizeDest: FinalizeDestination = destination === "play" ? "library" : destination;
    worker.postMessage({
      type: "wgb_finalize",
      stagedPath,
      manifest,
      destination: finalizeDest,
      editedFiles: Object.keys(editedFiles).length > 0 ? editedFiles : undefined,
    });
  }, [
    destination,
    pickedFiles,
    pickedUrl,
    stagedPath,
    buildEditedManifest,
    writeFilesList,
    editedFiles,
    getWorker,
    onPlay,
    onClose,
    onPersisted,
  ]);

  // --- footer Next/Back ------------------------------------------------------------
  const nextEnabled = useMemo(() => {
    if (step === 1) return false; // advancing from step 1 happens on source selection
    if (step === 2) return !building && !!stagedPath;
    return true;
  }, [step, building, stagedPath]);

  const onNext = useCallback(() => {
    if (step === 2 && stagedPath) advanceTo(3);
    else if (step === 3) advanceTo(4);
  }, [step, stagedPath, advanceTo]);

  // --- Esc to close ----------------------------------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const stepSub = `Step ${step} / 4 · ${STEP_NAMES[step - 1]}`;
  const ambiguous = (detections?.exeCandidates?.length ?? 0) > 1;

  return (
    <div className={cx(os, "overlay", "is-open")} onClick={onClose}>
      <div className={s["wiz-modal"]} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add a game">
        <div className={s["modal__head"]}>
          <span className={s["modal__title"]}>Add a game</span>
          <span className={s["modal__sub"]}>{stepSub}</span>
          <Spacer />
          <button className={cb["x"]} onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* Stepper */}
        <div className={s["steps"]}>
          {STEP_NAMES.map((name, i) => {
            const idx = (i + 1) as StepId;
            const cls = step === idx ? cx(s, "step", "is-active") : idx < step ? cx(s, "step", "is-done") : s["step"];
            return (
              <React.Fragment key={name}>
                {i > 0 && <div className={s["step__bar"]} />}
                <button
                  type="button"
                  className={cls}
                  disabled={idx > maxStepReached}
                  onClick={() => goStep(idx)}
                >
                  <div className={s["step__dot"]}>{idx < step ? "✓" : idx}</div>
                  <div className={s["step__txt"]}>
                    <span className={s["step__k"]}>{String(idx).padStart(2, "0")}</span>
                    <span className={s["step__t"]}>{name}</span>
                  </div>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className={s["modal__body"]}>
          {error && (
            <div className={cx(s, "note", "note--err")} role="alert">
              {error}
            </div>
          )}

          {/* STEP 1 — Source */}
          <section className={cx(s, "wpane", step === 1 && "is-active")}>
            <div
              className={cx(s, "drop", dragOver && "is-over")}
              onDragOver={(e) => {
                e.preventDefault();
                if (!disabled) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (disabled) return;
                acceptFiles(e.dataTransfer.files);
              }}
            >
              <div className={s["drop__glyph"]}>
                <UploadSimple size={36} aria-hidden />
              </div>
              <div className={s["drop__t"]}>Drop your game here</div>
              <div className={s["drop__h"]}>
                .wgb package · GOG <code>setup.exe</code> (+ <code>setup-*.bin</code>) · installer .zip / .7z · or pick a folder
              </div>
              <div className={s["chrow"]}>
                <button className={ch["chip"]} disabled={disabled} onClick={() => fileInputRef.current?.click()}>
                  <FileIcon size={14} aria-hidden /> Choose files…
                </button>
                <button
                  className={ch["chip"]}
                  disabled={disabled || !supportsDirPicker}
                  title={supportsDirPicker ? undefined : "Folder picking needs a Chromium browser"}
                  onClick={pickFolder}
                >
                  <Folder size={14} aria-hidden /> Pick a folder…
                </button>
                {onEditLibrary && (
                  <button className={cx(ch, "chip", "chip--mount")} onClick={onEditLibrary}>
                    <PencilSimple size={14} aria-hidden /> Edit one in your library →
                  </button>
                )}
              </div>
            </div>

            <div className={s["wiz-url-row"]}>
              <input
                type="text"
                placeholder="https://…/game.wgb"
                spellCheck={false}
                value={urlInput}
                disabled={disabled}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitUrl();
                }}
              />
              <button className={bm["btn"]} disabled={disabled || !urlInput.trim()} onClick={submitUrl}>
                <Link size={15} aria-hidden /> From URL
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".wgb,.zip,.7z,.exe,.bin"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                acceptFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </section>

          {/* STEP 2 — Process */}
          <section className={cx(s, "wpane", step === 2 && "is-active")}>
            <div className={s["proc"]}>
              <BottleMark className={s["proc__bottle"]} />
              <div className={s["proc__label"]}>
                {building ? progress.label || phaseLabel(progress.phase) : stagedPath ? "Done" : phaseLabel(progress.phase)}
              </div>
              <div className={s["bar"]}>
                <div className={s["bar__fill"]} style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
              </div>
              <div className={s["proc__pct"]}>
                {Math.round(progress.percent)}%{progress.label ? ` · ${progress.label}` : ""}
              </div>
            </div>

            {!building && ambiguous && form && (
              <div className={s["qbox"]}>
                <div className={sh["sect-h"]}>
                  <Question size={16} aria-hidden /> A couple of questions
                </div>
                <div className={s["field"]}>
                  <label>
                    This archive has {detections?.exeCandidates.length} executables — which one launches the game?
                  </label>
                  <select
                    value={form.entrypoint}
                    onChange={(e) => {
                      const rel = e.target.value;
                      setForm((p) => (p ? { ...p, entrypoint: rel } : p));
                      setPins((prev) => {
                        const next: Record<string, PinKind> = {};
                        for (const [k, v] of Object.entries(prev)) if (v !== "entry") next[k] = v;
                        next[normalizeRom(rel)] = "entry";
                        return next;
                      });
                    }}
                  >
                    {detections?.exeCandidates.map((c) => (
                      <option key={c} value={normalizeRom(c)}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {detections?.suggestedEntrypoint && (
                    <div className={hm["hint"]}>
                      Suggested entry point: <code>{detections.suggestedEntrypoint}</code>.
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* STEP 3 — Configure */}
          <section className={cx(s, "wpane", step === 3 && "is-active")}>
            {form && (
              <div className={s["cfg"]}>
                <div>
                  <div className={sh["sect-h"]}>Identity &amp; boot</div>
                  <div className={s["field"]}>
                    <label>Display name</label>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className={s["field"]}>
                    <label>Game ID (container key — survives re-download)</label>
                    <input className={s["mono"]} value={form.gameId} onChange={(e) => setForm({ ...form, gameId: e.target.value })} />
                  </div>
                  <div className={s["field"]}>
                    <label>Entry point</label>
                    <input className={s["mono"]} value={form.entrypoint} onChange={(e) => setForm({ ...form, entrypoint: e.target.value })} />
                  </div>
                  <div className={s["field"]}>
                    <label>Arguments</label>
                    <input className={s["mono"]} placeholder="(none)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
                  </div>

                  <div className={sh["sect-h"]} style={{ marginTop: 22 }}>Machine</div>
                  <div className={cx(s, "field", "field--row")}>
                    <div>
                      <label>Width</label>
                      <input value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value })} />
                    </div>
                    <div>
                      <label>Height</label>
                      <input value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value })} />
                    </div>
                    <div>
                      <label>BPP</label>
                      <select value={form.bpp || "16"} onChange={(e) => setForm({ ...form, bpp: e.target.value })}>
                        <option value="8">8-bit</option>
                        <option value="16">16-bit</option>
                        <option value="24">24-bit</option>
                        <option value="32">32-bit</option>
                      </select>
                    </div>
                  </div>
                  <div className={cx(s, "field", "field--row")}>
                    <div>
                      <label>RAM (MB)</label>
                      <input value={form.ram} onChange={(e) => setForm({ ...form, ram: e.target.value })} />
                    </div>
                    <div>
                      <label>OS</label>
                      <select value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })}>
                        {Object.keys(OS_PRESETS).map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Skip video</label>
                      <select
                        value={form.skipVideo ? "yes" : "no"}
                        onChange={(e) => setForm({ ...form, skipVideo: e.target.value === "yes" })}
                      >
                        <option value="no">no</option>
                        <option value="yes">yes</option>
                      </select>
                    </div>
                  </div>

                  <div className={sh["sect-h"]} style={{ marginTop: 22 }}>
                    Patches &amp; overrides <span className={s["sect-sub"]}>no-cd · writeFiles · cdPath</span>
                  </div>
                  <div className={s["pin-legend"]}>
                    <div className={s["pin-legend__row"]}>
                      <span className={cx(s, "pin", "pin--entry")}>entry</span>the executable that launches
                    </div>
                    <div className={s["pin-legend__row"]}>
                      <span className={cx(s, "pin", "pin--patch")}>patch</span>overwritten on boot (no-cd / writeFiles)
                    </div>
                    <div className={s["pin-legend__row"]}>
                      <span className={cx(s, "pin", "pin--cd")}>cd root</span>mapped as the CD-ROM drive (cdPath)
                    </div>
                    <div className={s["pin-legend__hint"]}>
                      Click a file in the tree to cycle its pin. Applied each boot over a copy-on-write
                      overlay — your originals are never changed.
                    </div>
                  </div>
                </div>

                <div>
                  <div className={s["tree"]}>
                    <div className={s["tree__head"]}>
                      <span>Bundle contents</span>
                      <span>{fileCount} files</span>
                    </div>
                    <div className={s["tree__body"]}>
                      {tree.map((node) => (
                        <TreeRow
                          key={node.path}
                          node={node}
                          depth={0}
                          pins={pins}
                          expanded={expanded}
                          edited={editedFiles}
                          onToggleFolder={toggleFolder}
                          onCycleFile={cyclePin}
                          onCycleFolder={cycleFolderPin}
                          onOpenFile={openEditor}
                        />
                      ))}
                    </div>
                  </div>
                  <div className={hm["hint"]} style={{ marginTop: 10 }}>
                    Click a file to pin it; small text/config files open an inline editor. Read straight
                    from the staged bundle — no re-extraction.
                  </div>

                  {openFile && (
                    <div className={s["wiz-editor"]}>
                      <div className={s["wiz-editor__head"]}>
                        <span className={s["ic"]}>
                          {React.createElement(fileIcon(openFile), { size: 14 })}
                        </span>
                        <span className={s["nm"]} title={stripRom(openFile)}>{stripRom(openFile)}</span>
                        {Object.prototype.hasOwnProperty.call(editedFiles, openFile) && (
                          <span className={cx(s, "pin", "pin--patch")}>edited</span>
                        )}
                        <Spacer />
                        <button className={cb["x"]} onClick={closeEditor} aria-label="Close editor">
                          <X size={14} aria-hidden />
                        </button>
                      </div>
                      {editorError ? (
                        <div className={cx(s, "note", "note--err")}>{editorError}</div>
                      ) : editorLoading ? (
                        <div className={s["wiz-editor__loading"]}>
                          <CircleNotch size={15} aria-hidden className={s["wiz-spin"]} /> Reading file…
                        </div>
                      ) : (
                        <>
                          <textarea
                            className={s["wiz-editor__ta"]}
                            spellCheck={false}
                            value={editorText}
                            onChange={(e) => setEditorText(e.target.value)}
                          />
                          <div className={s["wiz-editor__foot"]}>
                            <span className={hm["hint"]}>Saved into the bundle when you Finish.</span>
                            <Spacer />
                            <button className={cx(bm, "btn", "btn--ghost")} onClick={closeEditor}>Cancel</button>
                            <button className={cx(bm, "btn", "btn--primary")} onClick={saveEditor}>
                              <FloppyDisk size={14} aria-hidden /> Keep edits
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* STEP 4 — Finish */}
          <section className={cx(s, "wpane", step === 4 && "is-active")}>
            <div className={sh["sect-h"]}>Almost done — what now?</div>
            {finalizing && finalizeProgress ? (
              <div className={s["proc"]} style={{ marginBottom: 18 }}>
                <BottleMark className={s["proc__bottle"]} />
                <div className={s["proc__label"]}>{finalizeProgress.label}</div>
                <div className={s["bar"]}>
                  <div
                    className={s["bar__fill"]}
                    style={{ width: `${Math.max(0, Math.min(100, finalizeProgress.percent))}%` }}
                  />
                </div>
                <div className={s["proc__pct"]}>{Math.round(finalizeProgress.percent)}%</div>
              </div>
            ) : (
            <div className={s["fork"]}>
              <button
                type="button"
                className={cx(s, "dest", destination === "play" && "is-sel")}
                onClick={() => setDestination("play")}
              >
                <div className={s["dest__ic"]}>
                  <Play size={28} aria-hidden />
                </div>
                <div className={s["dest__t"]}>Play now</div>
                <div className={s["dest__h"]}>Launch it right away. It's added to your library too.</div>
                <span className={s["dest__tag"]}>recommended</span>
              </button>
              <button
                type="button"
                className={cx(s, "dest", destination === "library" && "is-sel")}
                onClick={() => setDestination("library")}
              >
                <div className={s["dest__ic"]}>
                  <HardDrive size={28} aria-hidden />
                </div>
                <div className={s["dest__t"]}>Keep in library</div>
                <div className={s["dest__h"]}>Stays in the browser, always one click away. Saves isolated per game.</div>
                <span className={s["dest__tag"]}>persistent · in-browser</span>
              </button>
              <button
                type="button"
                className={cx(s, "dest", destination === "download" && "is-sel")}
                onClick={() => setDestination("download")}
              >
                <div className={s["dest__ic"]}>
                  <ArrowLineDown size={28} aria-hidden />
                </div>
                <div className={s["dest__t"]}>Download as WGB</div>
                <div className={s["dest__h"]}>
                  A portable <code>.wgb</code> file — back it up, share it, or save it to a mounted drive.
                </div>
                <span className={s["dest__tag"]}>portable package</span>
              </button>
            </div>
            )}
            {!finalizing && (
            <div className={cx(s, "note", "note--warn")} style={{ marginTop: 18 }}>
              Save As (pick folder + filename) works in Chromium. Firefox and Safari fall back to a normal download
              with the game title as the filename.
            </div>
            )}
          </section>
        </div>

        <div className={s["modal__foot"]}>
          <button className={cx(bm, "btn", "btn--ghost")} onClick={onClose}>
            Cancel
          </button>
          <Spacer />
          <button className={bm["btn"]} disabled={step <= 1} onClick={() => goStep((step - 1) as StepId)}>
            <CaretLeft size={15} aria-hidden /> Back
          </button>
          {step < 4 ? (
            <button className={cx(bm, "btn", "btn--primary")} disabled={!nextEnabled} onClick={onNext}>
              Next <CaretRight size={15} aria-hidden />
            </button>
          ) : (
            <button className={cx(bm, "btn", "btn--primary")} disabled={finalizing} onClick={onConfirm}>
              {finalizing ? (
                <>
                  <CircleNotch size={15} aria-hidden className={s["wiz-spin"]} /> Working…
                </>
              ) : destination === "play" ? (
                <>
                  <Play size={15} aria-hidden /> Play now
                </>
              ) : destination === "download" ? (
                <>
                  <ArrowLineDown size={15} aria-hidden /> Download as WGB
                </>
              ) : (
                <>
                  <GearSix size={15} aria-hidden /> Add to library
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- small helpers ------------------------------------------------------------------

function phaseLabel(phase: string): string {
  switch (phase) {
    case "detecting":
      return "Inspecting source";
    case "reading":
      return "Reading bundle";
    case "installing":
      return "Extracting installer";
    case "unzipping":
      return "Unzipping";
    case "packing":
      return "Building bundle";
    case "staging":
      return "Writing staged bundle";
    case "done":
      return "Ready";
    default:
      return "Working…";
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Strip the leading `rom/` from a staged bundle entry name for display / guest paths. */
function stripRom(name: string): string {
  return name.replace(/^rom\//i, "");
}

/** Ensure an entrypoint relative path is rom/-prefixed to match staged entry names. */
function normalizeRom(rel: string): string {
  const f = rel.replace(/\\/g, "/");
  return /^rom\//i.test(f) ? f : `rom/${f}`;
}

// --- content tree -------------------------------------------------------------------

/** A node of the collapsible bundle tree. Files carry their staged `name` (full entry path). */
interface TreeNode {
  /** Last path segment (display label). */
  label: string;
  /** Full staged entry path for files (e.g. `rom/Game/foo.ini`); folders use the dir path. */
  path: string;
  isDir: boolean;
  size: number; // file size, or aggregate size for a folder
  fileCount: number; // 0 for files; descendant file count for folders
  children?: TreeNode[];
}

/**
 * Build a hierarchical folder/file tree from flat staged entries (split on `/`).
 * Intermediate folders are synthesized even when no explicit directory entry exists.
 * Folders are sorted before files; both alphabetically (case-insensitive). Aggregate
 * size/count are rolled up so a folder row can show its child totals.
 */
function buildTree(entries: StagedEntry[]): TreeNode[] {
  const root: TreeNode = { label: "", path: "", isDir: true, size: 0, fileCount: 0, children: [] };
  const dirOf = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirOf.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash >= 0 ? path.slice(0, slash) : "";
    const label = slash >= 0 ? path.slice(slash + 1) : path;
    const parent = ensureDir(parentPath);
    const node: TreeNode = { label, path, isDir: true, size: 0, fileCount: 0, children: [] };
    parent.children!.push(node);
    dirOf.set(path, node);
    return node;
  };

  for (const e of entries) {
    const parts = e.name.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    if (e.isDirectory) {
      ensureDir(parts.join("/"));
      continue;
    }
    const dirPath = parts.slice(0, -1).join("/");
    const parent = ensureDir(dirPath);
    const node: TreeNode = {
      label: parts[parts.length - 1]!,
      path: e.name,
      isDir: false,
      size: e.size,
      fileCount: 0,
      children: undefined,
    };
    parent.children!.push(node);
  }

  // Roll up aggregate size + file count bottom-up.
  const roll = (node: TreeNode): void => {
    if (!node.isDir) return;
    let size = 0;
    let count = 0;
    for (const c of node.children ?? []) {
      roll(c);
      size += c.size;
      count += c.isDir ? c.fileCount : 1;
    }
    node.size = size;
    node.fileCount = count;
  };
  roll(root);

  // Sort: folders first, then files, alphabetical (case-insensitive) within each group.
  const sortRec = (node: TreeNode): void => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
    });
    for (const c of node.children) sortRec(c);
  };
  sortRec(root);

  return root.children ?? [];
}

// --- per-extension mime icon (lucide) ----------------------------------------------

const TEXT_EXTS = new Set(["txt", "log", "md", "nfo"]);
const CFG_EXTS = new Set(["ini", "cfg", "cnf", "inf"]);
const CODE_EXTS = new Set(["bat", "reg"]);
const BINARY_EXTS = new Set(["exe", "dll"]);
const IMAGE_EXTS = new Set(["png", "bmp", "jpg", "jpeg", "gif", "tga"]);
const ARCHIVE_EXTS = new Set(["cab", "zip", "7z", "bin"]);
const AUDIO_EXTS = new Set(["wav", "mp3", "ogg"]);
const VIDEO_EXTS = new Set(["avi", "bik", "mpg", "mpeg"]);

/** Editable inline as text: small config/text files only. */
const EDITABLE_EXTS = new Set(["ini", "cfg", "cnf", "inf", "txt", "log", "json", "reg", "bat"]);
const EDITABLE_MAX_BYTES = 256 * 1024;

function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isEditable(name: string, size: number): boolean {
  return EDITABLE_EXTS.has(extOf(name)) && size < EDITABLE_MAX_BYTES;
}

/** Pick a lucide icon component for a file by extension. */
function fileIcon(name: string): Icon {
  const ext = extOf(name);
  if (ext === "json") return BracketsCurly;
  if (TEXT_EXTS.has(ext)) return FileText;
  if (CFG_EXTS.has(ext)) return ext === "inf" ? Sliders : GearSix;
  if (BINARY_EXTS.has(ext)) return Binary;
  if (CODE_EXTS.has(ext)) return FileCode;
  if (IMAGE_EXTS.has(ext)) return FileImage;
  if (ARCHIVE_EXTS.has(ext)) return FileZip;
  if (AUDIO_EXTS.has(ext)) return FileAudio;
  if (VIDEO_EXTS.has(ext)) return FileVideo;
  return FileIcon;
}
