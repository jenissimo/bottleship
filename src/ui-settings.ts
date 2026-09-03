// Host-side UI / presentation preferences. Shared by App.tsx (owns the state + effects
// that apply them) and SettingsDrawer.tsx (renders the controls). These are the *real*,
// wired settings — distinct from the per-game manifest and from QualityConfig (the
// HLE→WebGPU quality knobs, persisted separately under its own key).

export type FullscreenAspectPreset = "4:3" | "16:9" | "16:10";
export type CanvasFilteringMode = "smooth" | "pixelated";

// Display pacing policy for sub-refresh guests (D2 ~25 fps on a 60 Hz screen).
//   off    — present ASAP (lowest latency; default).
//   vsync  — pin each present to a vsync edge (experimental; the browser compositor
//            already vsync-aligns, so this rarely helps and can add jitter).
//   smooth — hold each present a steady integer #vsyncs (flat cadence, caps at a divisor rate).
//   blend  — phase-blend the two newest frames at full refresh (smoothest; ~1 frame latency).
export type PresentMode = "off" | "vsync" | "smooth" | "blend";
export const PRESENT_MODES: PresentMode[] = ["off", "vsync", "smooth", "blend"];

// How a finger drives the guest mouse.
//   auto     — follow the guest's own relative-mouse intent (hidden/clipped/captured
//              cursor → trackpad, otherwise direct). Right for nearly every title.
//   direct   — the finger is the cursor.
//   trackpad — the whole canvas is a trackpad; motion is relative.
//   off      — no touch translation at all (external mouse only).
export type TouchMode = "auto" | "direct" | "trackpad" | "off";
export const TOUCH_MODES: TouchMode[] = ["auto", "direct", "trackpad", "off"];

export type UiSettings = {
  lockFullscreenAspect: boolean;
  fullscreenAspectPreset: FullscreenAspectPreset;
  integerScaling: boolean;
  canvasFiltering: CanvasFilteringMode;
  presentMode: PresentMode;
  /** Master output volume, linear 0..1 (applied at the AudioEngine master gain). */
  masterVolume: number;
  /** Mute master output (independent of volume so the slider position is retained). */
  muted: boolean;
  touchMode: TouchMode;
  /** Multiplier on finger motion in trackpad mode. */
  touchSensitivity: number;
  /** Long press = right button. Off makes it a held left button instead. */
  touchLongPressRight: boolean;
  /** Offset the cursor above the fingertip and slow it for precise aiming. */
  touchCursorAid: boolean;
  /** Vibrate on an on-screen button press. */
  touchHaptics: boolean;
  /** Fade the on-screen controls down while nothing is being touched. */
  touchIdleFade: boolean;
};

export const UI_SETTINGS_STORAGE_KEY = "bottleship_ui_settings_v1";

export const DEFAULT_UI_SETTINGS: UiSettings = {
  lockFullscreenAspect: true,
  fullscreenAspectPreset: "4:3",
  integerScaling: false,
  canvasFiltering: "smooth",
  presentMode: "off",
  masterVolume: 1,
  muted: false,
  touchMode: "auto",
  touchSensitivity: 1,
  touchLongPressRight: true,
  touchCursorAid: true,
  touchHaptics: true,
  touchIdleFade: true,
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

export function loadUiSettings(): UiSettings {
  if (typeof window === "undefined") return DEFAULT_UI_SETTINGS;

  try {
    const raw = localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_UI_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UiSettings>;

    const lockFullscreenAspect = parsed.lockFullscreenAspect ?? DEFAULT_UI_SETTINGS.lockFullscreenAspect;
    const fullscreenAspectPreset: FullscreenAspectPreset =
      parsed.fullscreenAspectPreset === "16:9" || parsed.fullscreenAspectPreset === "16:10" || parsed.fullscreenAspectPreset === "4:3"
        ? parsed.fullscreenAspectPreset
        : DEFAULT_UI_SETTINGS.fullscreenAspectPreset;
    const integerScaling = parsed.integerScaling ?? DEFAULT_UI_SETTINGS.integerScaling;
    const canvasFiltering: CanvasFilteringMode =
      parsed.canvasFiltering === "pixelated" || parsed.canvasFiltering === "smooth"
        ? parsed.canvasFiltering
        : DEFAULT_UI_SETTINGS.canvasFiltering;
    const presentMode: PresentMode =
      parsed.presentMode && PRESENT_MODES.includes(parsed.presentMode)
        ? parsed.presentMode
        : DEFAULT_UI_SETTINGS.presentMode;
    const masterVolume = typeof parsed.masterVolume === "number" ? clamp01(parsed.masterVolume) : DEFAULT_UI_SETTINGS.masterVolume;
    const muted = parsed.muted ?? DEFAULT_UI_SETTINGS.muted;
    const touchMode: TouchMode =
      parsed.touchMode && TOUCH_MODES.includes(parsed.touchMode)
        ? parsed.touchMode
        : DEFAULT_UI_SETTINGS.touchMode;
    const touchSensitivity = typeof parsed.touchSensitivity === "number" && Number.isFinite(parsed.touchSensitivity)
      ? Math.min(4, Math.max(0.25, parsed.touchSensitivity))
      : DEFAULT_UI_SETTINGS.touchSensitivity;
    const touchLongPressRight = parsed.touchLongPressRight ?? DEFAULT_UI_SETTINGS.touchLongPressRight;
    const touchCursorAid = parsed.touchCursorAid ?? DEFAULT_UI_SETTINGS.touchCursorAid;
    const touchHaptics = parsed.touchHaptics ?? DEFAULT_UI_SETTINGS.touchHaptics;
    const touchIdleFade = parsed.touchIdleFade ?? DEFAULT_UI_SETTINGS.touchIdleFade;

    return {
      lockFullscreenAspect,
      fullscreenAspectPreset,
      integerScaling,
      canvasFiltering,
      presentMode,
      masterVolume,
      muted,
      touchMode,
      touchSensitivity,
      touchLongPressRight,
      touchCursorAid,
      touchHaptics,
      touchIdleFade,
    };
  } catch {
    return DEFAULT_UI_SETTINGS;
  }
}
