import type { QualityConfig } from "../worker/core/quality-config";
import type { UiSettings } from "../ui-settings";

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  quality: QualityConfig;
  onChange: (patch: Partial<QualityConfig>) => void;
  /** Non-default quality keys the active graphics backend does not implement (see
   *  worker/backends/webgpu/shared/quality-capabilities.ts) — empty until the worker's
   *  first set_quality ack arrives. */
  unsupportedQualityKeys?: ReadonlySet<string>;
  uiSettings: UiSettings;
  onUiChange: (patch: Partial<UiSettings>) => void;
  statsOverlay: boolean;
  onToggleStatsOverlay: (enabled: boolean) => void;
  logStreaming: boolean;
  onToggleLogStreaming: (enabled: boolean) => void;
  onResetDefaults: () => void;
  guestResolution: { width: number; height: number };
  /** Canvas physical-pixel backing size (clientWidth/Height × devicePixelRatio) — what
   *  QualityPanel's "Internal resolution: Auto" fits to. */
  renderSize: { width: number; height: number };
  integerScale: number;
  onOpenDevConsole?: () => void;
}

export type SettingsSectionId = "graphics" | "audio" | "input" | "storage" | "advanced" | "about";
