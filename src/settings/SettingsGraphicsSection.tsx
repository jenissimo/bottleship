import React from "react";
import QualityPanel from "../app/QualityPanel";
import type { UiSettings } from "../ui-settings";
import type { SettingsDrawerProps } from "./types";
import { SettingsRow, SettingsSection, Toggle } from "./SettingsRow";
import { SectionHeading, Hint } from "../ui";

export default function SettingsGraphicsSection({
  uiSettings,
  onUiChange,
  quality,
  onChange,
  guestResolution,
  renderSize,
  integerScale,
  unsupportedQualityKeys,
  overriddenQualityKeys,
}: SettingsDrawerProps): React.ReactElement {
  return (
    <SettingsSection>
      <SectionHeading>Presentation</SectionHeading>

      <SettingsRow
        title="Frame pacing"
        hint={
          <>
            Smooths low-FPS games (e.g. Diablo II ~25 fps) on a 60 Hz display. <strong>Blend</strong>{" "}
            interpolates every refresh (smoothest, slight softening); <strong>Smooth</strong> holds a
            steady cadence; <strong>Off</strong> is most faithful / lowest latency.
          </>
        }
      >
        <select
          style={{ width: 220, padding: 8 }}
          value={uiSettings.presentMode}
          onChange={(e) => onUiChange({ presentMode: e.target.value as UiSettings["presentMode"] })}
        >
          <option value="off">Off — native</option>
          <option value="vsync">Vsync-lock (experimental)</option>
          <option value="smooth">Smooth — flat cadence</option>
          <option value="blend">Blend — smoothest (+1 frame)</option>
        </select>
      </SettingsRow>

      <SettingsRow title="Lock fullscreen aspect" hint="Letterbox to a fixed aspect ratio in fullscreen.">
        <Toggle
          checked={uiSettings.lockFullscreenAspect}
          onChange={(v) => onUiChange({ lockFullscreenAspect: v })}
        />
      </SettingsRow>

      <SettingsRow title="Fullscreen aspect" hint="Target ratio when the aspect lock is on.">
        <select
          style={{ width: 120, padding: 8 }}
          value={uiSettings.fullscreenAspectPreset}
          disabled={!uiSettings.lockFullscreenAspect}
          onChange={(e) =>
            onUiChange({ fullscreenAspectPreset: e.target.value as UiSettings["fullscreenAspectPreset"] })
          }
        >
          <option value="4:3">4:3</option>
          <option value="16:9">16:9</option>
          <option value="16:10">16:10</option>
        </select>
      </SettingsRow>

      <SettingsRow
        title="Integer scaling (window)"
        hint={`Scale the canvas by a whole multiple — pixel-perfect, no blur. Current: ×${integerScale} at ${guestResolution.width}×${guestResolution.height}.`}
      >
        <Toggle checked={uiSettings.integerScaling} onChange={(v) => onUiChange({ integerScaling: v })} />
      </SettingsRow>

      <SettingsRow title="Canvas filtering" hint="How the browser upscales the output canvas.">
        <select
          style={{ width: 140, padding: 8 }}
          value={uiSettings.canvasFiltering}
          onChange={(e) => onUiChange({ canvasFiltering: e.target.value as UiSettings["canvasFiltering"] })}
        >
          <option value="smooth">Smooth</option>
          <option value="pixelated">Pixelated</option>
        </select>
      </SettingsRow>

      <SectionHeading style={{ marginTop: 18 }}>
        Video / Quality
      </SectionHeading>
      <QualityPanel
        quality={quality}
        onChange={onChange}
        unsupported={unsupportedQualityKeys}
        overridden={overriddenQualityKeys}
        guestResolution={guestResolution}
        renderSize={renderSize}
      />
      <Hint style={{ marginTop: 12 }}>
        Wired to the <code>QualityConfig</code> / <code>set_quality</code> pipeline — applied at the
        HLE → WebGPU seam. Defaults are neutral (a fresh config reproduces exact pre-feature behavior).
      </Hint>
    </SettingsSection>
  );
}
