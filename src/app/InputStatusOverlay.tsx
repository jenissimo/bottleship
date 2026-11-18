import { GameController } from "@phosphor-icons/react";
import React from "react";
import { cx } from "../ui/cx";
import s from "./InputStatusOverlay.module.css";

/**
 * Live input-device status shown in the corner of the emulator canvas.
 *
 * Two independent signals drive it (see App.tsx pollGamepad + the worker's
 * InputManager.noteGuestGamepadRead):
 *   - padConnected: a gamepad is plugged into the BROWSER (navigator.getGamepads).
 *   - guestActive:  the GAME is actually reading the joystick/gamepad API
 *                   (DInput Acquire/GetDeviceState or winmm joyGetPosEx) right now.
 *
 * The distinction is the whole point: a pad can be plugged in while the title
 * never touches it (keyboard-only game, or it just hasn't acquired the device).
 */
export interface InputStatus {
  padConnected: boolean;
  padLabel: string | null;
  guestActive: boolean;
}

export const InputStatusOverlay: React.FC<{ status: InputStatus }> = ({ status }) => {
  const { padConnected, padLabel, guestActive } = status;

  if (!padConnected && !guestActive) return null;

  const state = guestActive ? "active" : padConnected ? "connected" : "idle";
  const title = guestActive
    ? `${padLabel ?? "Gamepad"} — in use by the game`
    : `${padLabel ?? "Gamepad"} — connected (game not using it)`;

  return (
    <div className={s["input-status"]} role="status" aria-label={title} title={title}>
      <span className={cx(s, "input-status__chip", `input-status__chip--${state}`)}>
        <GameController size={18} weight="fill" aria-hidden />
      </span>
    </div>
  );
};
