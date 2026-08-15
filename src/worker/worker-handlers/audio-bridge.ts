// Host→worker audio bridge handlers. The host's AudioService posts playback
// lifecycle events (ended/started/error/position) that are forwarded to the
// owning audio modules (mss32/bass/galaxy/quartz).
import { System } from "../core/system";
import { virtualCd } from "../core/audio/virtual-cd";
import type { MSS32 } from "../modules/mss32";
import type { Bass } from "../modules/bass";
import type { Galaxy } from "../modules/galaxy";
import type { Quartz } from "../modules/quartz";

/**
 * Host-side playback census, keyed by audio id. Encoded streams (MP3/OGG) play on
 * a media element the AudioWorklet never sees, so the worklet's peak is 0 for them
 * and reads as silence — this is the only evidence in the worker that such a stream
 * is genuinely decoding. Surfaced by the harness `audioSignal().host`.
 */
export interface HostAudioStat {
    positions: number;
    firstFrames: number;
    lastFrames: number;
    lastAtMs: number;
    started: boolean;
    ended: boolean;
    error: string | null;
}

const hostAudioStats = new Map<number, HostAudioStat>();

function noteHost(id: number): HostAudioStat {
    let s = hostAudioStats.get(id);
    if (!s) {
        s = { positions: 0, firstFrames: -1, lastFrames: -1, lastAtMs: 0, started: false, ended: false, error: null };
        hostAudioStats.set(id, s);
    }
    return s;
}

/** Snapshot of the host playback census (harness/diagnostics). */
export function getHostAudioStats(): Record<number, HostAudioStat> {
    const out: Record<number, HostAudioStat> = {};
    for (const [id, s] of hostAudioStats) out[id] = { ...s };
    return out;
}

export function resetHostAudioStats(): void {
    hostAudioStats.clear();
}

/** Handles audio_* host messages. Returns true if the message was consumed. */
export function handleAudioBridgeMessage(message: any): boolean {
  if (message?.type === "audio_ended") {
    const system = System.getInstance();
    const id = Number(message.id) || 0;
    if (id) noteHost(id).ended = true;
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
    if (id) { const st = noteHost(id); st.started = true; st.ended = false; }
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
    if (id) noteHost(id).error = error;
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
    if (id && Number.isFinite(frames)) {
      const st = noteHost(id);
      st.positions++;
      if (st.firstFrames < 0) st.firstFrames = frames;
      st.lastFrames = frames;
      st.lastAtMs = performance.now();
    }
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
