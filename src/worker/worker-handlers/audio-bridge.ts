// Host→worker audio bridge handlers. The host's AudioService posts playback
// lifecycle events (ended/started/error/position) that are forwarded to the
// owning audio modules (mss32/bass/galaxy/quartz).
import { System } from "../core/system";
import { virtualCd } from "../core/audio/virtual-cd";
import type { MSS32 } from "../modules/mss32";
import type { Bass } from "../modules/bass";
import type { Galaxy } from "../modules/galaxy";
import type { Quartz } from "../modules/quartz";

/** Handles audio_* host messages. Returns true if the message was consumed. */
export function handleAudioBridgeMessage(message: any): boolean {
  if (message?.type === "audio_ended") {
    const system = System.getInstance();
    const id = Number(message.id) || 0;
    // The virtual CD drive owns its own id range and drives every CD-audio surface
    // (MCI cdaudio / AIL_redbook / aux), so it gets first refusal.
    if (virtualCd().handleAudioEnded(id)) return true;
    const mss32 = system.process?.getModule("mss32") as MSS32 | undefined;
    if (mss32?.handleAudioEnded) {
      mss32.handleAudioEnded(id);
    }
    const bass = system.process?.getModule("bass") as Bass | undefined;
    if (bass?.handleAudioEnded) {
      bass.handleAudioEnded(id);
    }
    const galaxy = system.process?.getModule("galaxy") as Galaxy | undefined;
    if (galaxy?.handleAudioEnded) {
      galaxy.handleAudioEnded(id);
    }
    const quartz = system.process?.getModule("quartz") as Quartz | undefined;
    if (quartz?.handleAudioEnded) {
      quartz.handleAudioEnded(id);
    }
    return true;
  }

  if (message?.type === "audio_started") {
    const system = System.getInstance();
    const id = Number(message.id) || 0;
    if (virtualCd().handleAudioStarted(id)) return true;
    const mss32 = system.process?.getModule("mss32") as MSS32 | undefined;
    if (mss32?.handleAudioStarted) {
      mss32.handleAudioStarted(id);
    }
    const quartz = system.process?.getModule("quartz") as Quartz | undefined;
    if (quartz?.handleAudioStarted) {
      quartz.handleAudioStarted(id);
    }
    return true;
  }

  if (message?.type === "audio_error") {
    const system = System.getInstance();
    const id = Number(message.id) || 0;
    const error = String(message.error || "Unknown error");
    if (virtualCd().handleAudioError(id, error)) return true;
    const mss32 = system.process?.getModule("mss32") as MSS32 | undefined;
    if (mss32?.handleAudioError) {
      mss32.handleAudioError(id, error);
    }
    const quartz = system.process?.getModule("quartz") as Quartz | undefined;
    if (quartz?.handleAudioError) {
      quartz.handleAudioError(id, error);
    }
    return true;
  }

  if (message?.type === "audio_position") {
    const system = System.getInstance();
    const mss32 = system.process?.getModule("mss32") as MSS32 | undefined;
    const id = Number(message.id) || 0;
    const frames = Number(message.positionFrames) || 0;
    // CD segments declare positionRateHz=1000, so their "frames" arrive as milliseconds.
    if (id && Number.isFinite(frames) && virtualCd().handleAudioPosition(id, frames)) return true;
    if (id && Number.isFinite(frames) && mss32?.handleAudioPosition) {
      mss32.handleAudioPosition(id, frames);
    }
    const quartz = system.process?.getModule("quartz") as Quartz | undefined;
    if (id && Number.isFinite(frames) && quartz?.handleAudioPosition) {
      quartz.handleAudioPosition(id, frames);
    }
    return true;
  }

  return false;
}
