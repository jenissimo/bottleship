/**
 * Keeps the audio engine's pause state equal to the guest's pause state.
 *
 * The guest can be paused from the UI button, but also from inside the worker (harness
 * pause/resume, __pauseOnFault, tickFrames park, breakpoints). A paused guest stops feeding
 * the streaming ring while the worklet keeps looping it, so every pause must silence audio
 * and every resume must bring it back. The worker reports each change as a
 * `guest_pause_state` message and the UI button reports its own request through the same
 * `set()`, so there is exactly one writer to the engine.
 *
 * Semantics: the guest's actual state wins. A resume from the worker while the UI button
 * showed "paused" really does run the guest, so audio comes back too (and the UI indicator
 * follows the message) - the states "guest stopped, sound playing" and "guest running,
 * sound muted for good" cannot arise. Automatic unlock paths keep using
 * AudioEngine.resumeIfNotPaused(), which still honours the engine's pause intent.
 *
 * Rapid flips (tickFrames park/unpark every frame) are coalesced: at most one engine call is
 * in flight, and after it settles only the latest requested state is applied.
 */
export interface PausableAudio {
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export class AudioPauseSync {
  private target = false;
  private applied = false;
  private running: Promise<void> | null = null;

  constructor(private readonly engine: PausableAudio) {}

  /** Request the pause state; resolves once the engine has caught up with the latest request. */
  set(paused: boolean): Promise<void> {
    this.target = paused;
    if (this.running) return this.running;
    // Nothing applied yet and nothing to undo: do not touch the engine (resume() would create
    // an AudioContext before any user gesture).
    if (this.applied === this.target) return Promise.resolve();
    this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.applied !== this.target) {
      const next = this.target;
      this.applied = next;
      try {
        await (next ? this.engine.pause() : this.engine.resume());
      } catch (err) {
        console.warn("BottleShip: audio pause sync failed", err);
      }
    }
    // Same synchronous step as the last loop check, so a set() cannot slip in between.
    this.running = null;
  }
}
