import React from "react";
import { ActionButton } from "../ui/ActionButton";
import s from "./DevPanel.module.css";

interface DevPanelProps {
  onLoadFile: (file: File) => boolean;
  /** Dev-server only (the listing route does not exist in a build) — omitted otherwise. */
  onOpenBundles?: () => void;
  onOpenSettings: () => void;
  onCaptureFrame: () => void;
  statsOverlayEnabled: boolean;
  onToggleStatsOverlay: (enabled: boolean) => void;
  onOpenLogViewer: () => void;
  onOpenProfiler: () => void;
  onOpenMemory: () => void;
  onOpenDebugGpu: () => void;
  onOpenFrameAnalysis: () => void;
  onOpenStorage: () => void;
  onOpenOpfsTool: () => void;
  onOpenRegistryTool: () => void;
  fpuStrictEnabled: boolean;
  onToggleFpuStrict: (strict: boolean) => void;
  loggingEnabled: boolean;
  onToggleLogging: () => void;
  /** AOT code cache — see docs/performance/sota-roadmap/05-A0-play-and-record.md. */
  aotRecording: boolean;
  aotAutoLoad: boolean;
  aotStatus: string;
  onAotRecord: () => void;
  onAotAutoLoad: () => void;
  onAotStatus: () => void;
}

export default function DevPanel(props: DevPanelProps) {
  return (
    <div className={s["emu-dev-panel"]}>
      <input
        type="file"
        id="pe-loader"
        accept=".exe,.dll,.wgb"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && props.onLoadFile(file)) {
            e.currentTarget.value = "";
          }
        }}
        style={{ display: 'none' }}
      />
      <div className={s["button-group"]}>
        <ActionButton onClick={() => document.getElementById('pe-loader')?.click()}>
          Load File...
        </ActionButton>
        {props.onOpenBundles && (
          <ActionButton onClick={props.onOpenBundles} title="Browse .wgb bundles on disk (public/apps, the external-wgb drop folder, BS_WGB_ROOTS)">
            Bundles...
          </ActionButton>
        )}
        <ActionButton variant="secondary" onClick={props.onOpenSettings}>
          Settings
        </ActionButton>
        <div className={s["divider"]} />
        <ActionButton variant="secondary" onClick={props.onCaptureFrame}>
          Capture Frame
        </ActionButton>
        <ActionButton
          variant="secondary"
          active={props.statsOverlayEnabled}
          onClick={() => props.onToggleStatsOverlay(!props.statsOverlayEnabled)}
        >
          FPS
        </ActionButton>
        <div className={s["divider"]} />
        <ActionButton variant="secondary" onClick={props.onOpenLogViewer}>Debug Logs</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenProfiler}>Profiler</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenMemory}>Memory</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenDebugGpu}>Debug GPU</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenFrameAnalysis}>Frame Analysis</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenStorage}>Storage</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenOpfsTool}>OPFS Tool</ActionButton>
        <ActionButton variant="secondary" onClick={props.onOpenRegistryTool}>Registry Tool</ActionButton>
        <ActionButton
          variant="secondary"
          active={props.fpuStrictEnabled}
          onClick={() => props.onToggleFpuStrict(!props.fpuStrictEnabled)}
          title="Strict x87 FPU: disable the relaxed-FPU f64 fast path → full 80-bit precision. Fixes precision-sensitive audio decoders (OGG Vorbis) at the cost of FPU speed."
        >
          {props.fpuStrictEnabled ? "FPU: Strict" : "FPU: Relaxed"}
        </ActionButton>
        <div className={s["divider"]} />
        <ActionButton
          variant="secondary"
          active={props.aotRecording}
          onClick={props.onAotRecord}
          title={props.aotRecording
            ? "Stop and SAVE the recording. Nothing is kept until you press this — closing the tab loses the session."
            : "Record every module the JIT compiles from now on. Play the parts that stutter, then press again to save; the next load of this game reuses them."}
        >
          {props.aotRecording ? "⏹ AOT: Save" : "⏺ AOT: Record"}
        </ActionButton>
        <ActionButton
          variant="secondary"
          toggledOff={!props.aotAutoLoad}
          onClick={props.onAotAutoLoad}
          title="Load this game's recorded code cache on start. Off is the A/B arm — and a recording made while off REPLACES the saved set rather than adding to it."
        >
          {props.aotAutoLoad ? "AOT: Auto" : "AOT: Off"}
        </ActionButton>
        <ActionButton variant="secondary" onClick={props.onAotStatus} title="Loaded / entered units, and what the live recording holds">
          AOT: Status
        </ActionButton>
        {props.aotStatus && <span className={s["status-text"]}>{props.aotStatus}</span>}
        <div className={s["divider"]} />
        <ActionButton
          variant="secondary"
          toggledOff={!props.loggingEnabled}
          onClick={props.onToggleLogging}
          title={props.loggingEnabled ? "Logging ON" : "Logging OFF"}
        >
          {props.loggingEnabled ? "🔊 Logs ON" : "🔇 Logs OFF"}
        </ActionButton>
      </div>
    </div>
  );
}
