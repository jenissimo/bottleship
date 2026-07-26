import React from "react";
import type { UiSettings } from "../ui-settings";
import type { SettingsDrawerProps } from "./types";
import GamepadSandbox from "./GamepadSandbox";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { SectionHeading, Hint } from "../ui";

export default function SettingsInputSection({
  uiSettings,
  onUiChange,
  active = false,
}: SettingsDrawerProps & { active?: boolean }): React.ReactElement {
  return (
    <SettingsSection>
      <SectionHeading>Mouse</SectionHeading>
      <SettingsRow
        title="Mouse coordinates"
        hint="How cursor positions are mapped into the guest. Guest resolution is correct for almost everything; render-target is a legacy fallback for games that misbehave."
      >
        <select
          style={{ width: 220, padding: 8 }}
          value={uiSettings.mouseCoordinateMode}
          onChange={(e) => onUiChange({ mouseCoordinateMode: e.target.value as UiSettings["mouseCoordinateMode"] })}
        >
          <option value="guest">Guest resolution (recommended)</option>
          <option value="render">Render target (legacy)</option>
        </select>
      </SettingsRow>
      <Hint style={{ marginTop: 4, marginBottom: 8 }}>
        Relative-look games capture the pointer when you click the canvas; press <code>Esc</code> to release.
      </Hint>

      <SectionHeading style={{ marginTop: 12 }}>Touch</SectionHeading>
      <SettingsRow
        title="Touch mode"
        hint="Automatic follows the game: titles that hide or capture the cursor get a trackpad, everything else maps the finger straight to the cursor."
      >
        <select
          style={{ width: 220, padding: 8 }}
          value={uiSettings.touchMode}
          onChange={(e) => onUiChange({ touchMode: e.target.value as UiSettings["touchMode"] })}
        >
          <option value="auto">Automatic (recommended)</option>
          <option value="direct">Direct — finger is the cursor</option>
          <option value="trackpad">Trackpad — relative motion</option>
          <option value="off">Off</option>
        </select>
      </SettingsRow>
      <SettingsRow title="Touch sensitivity" hint="Multiplier on finger motion in trackpad mode.">
        <input
          type="range"
          min={0.25}
          max={4}
          step={0.05}
          value={uiSettings.touchSensitivity}
          onChange={(e) => onUiChange({ touchSensitivity: Number(e.target.value) })}
          style={{ width: 220 }}
        />
      </SettingsRow>
      <SettingsRow
        title="Long press = right click"
        hint="Off makes a long press hold the left button instead. Two fingers always give a right click."
      >
        <input
          type="checkbox"
          checked={uiSettings.touchLongPressRight}
          onChange={(e) => onUiChange({ touchLongPressRight: e.target.checked })}
        />
      </SettingsRow>
      <SettingsRow
        title="Precision aiming"
        hint="Offsets the cursor above your fingertip and slows it while you line up a small target."
      >
        <input
          type="checkbox"
          checked={uiSettings.touchCursorAid}
          onChange={(e) => onUiChange({ touchCursorAid: e.target.checked })}
        />
      </SettingsRow>
      <SettingsRow
        title="Vibrate on press"
        hint="A short pulse when an on-screen button registers. Glass gives no other confirmation."
      >
        <input
          type="checkbox"
          checked={uiSettings.touchHaptics}
          onChange={(e) => onUiChange({ touchHaptics: e.target.checked })}
        />
      </SettingsRow>
      <SettingsRow
        title="Dim controls when idle"
        hint="Fades the on-screen controls down while you are not touching them, so they cost less of the picture."
      >
        <input
          type="checkbox"
          checked={uiSettings.touchIdleFade}
          onChange={(e) => onUiChange({ touchIdleFade: e.target.checked })}
        />
      </SettingsRow>

      <SectionHeading style={{ marginTop: 12 }}>
        Gamepad
      </SectionHeading>
      <GamepadSandbox active={active} />
    </SettingsSection>
  );
}
