import type { QualityConfig } from "../worker/core/quality-config";
import type { InternalScaleSupport } from "../worker/backends/webgpu/shared/internal-resolution";
import type { UiSettings } from "../ui-settings";
import type { NetworkConfig, NetworkStatus } from "../network-config";

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  quality: QualityConfig;
  onChange: (patch: Partial<QualityConfig>) => void;
  /** Non-default quality keys the active graphics backend does not implement (see
   *  worker/backends/webgpu/shared/quality-capabilities.ts) — empty until the worker's
   *  first set_quality ack arrives. */
  unsupportedQualityKeys?: ReadonlySet<string>;
  /** Whether the active backend applies `internalScale` at all, and what its Auto means.
   *  Carried with the same ack: `unsupportedQualityKeys` only lists keys moved away from
   *  their default, so a backend with no internal-resolution path is silent there. */
  internalScaleSupport?: InternalScaleSupport;
  /** Quality keys the loaded game's manifest overrides — the control edits the global
   *  preference, but the game's value is what the frame uses. Also empty until the
   *  worker's first set_quality ack arrives. */
  overriddenQualityKeys?: ReadonlySet<string>;
  uiSettings: UiSettings;
  onUiChange: (patch: Partial<UiSettings>) => void;
  network: NetworkConfig | null;
  networkStatus: NetworkStatus;
  onNetworkChange: (config: NetworkConfig | null) => void;
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

export type SettingsSectionId = "graphics" | "audio" | "input" | "network" | "storage" | "advanced" | "about";
