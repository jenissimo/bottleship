export type AudioPlayPayload = {
  id: number;
  data: Float32Array;
  channels: number;
  sampleRate: number;
  playbackRate: number;
  volume: number;
  pan?: number;
  loopCount?: number;
};

export type AudioPlayEncodedPayload = {
  id: number;
  data: Uint8Array;
  mimeType?: string;
  playbackRate?: number;
  playbackRateHz?: number;
  volume: number;
  pan?: number;
  loopCount?: number;
  /** Begin at this offset into the stream (CD "play from"). Loops restart here too. */
  startOffsetMs?: number;
  /** End playback here instead of at the stream's end (CD "play to"). */
  endOffsetMs?: number;
  /** Force the streaming path regardless of container — for sources that must not
   *  be decoded into a PCM buffer (a CD track is tens of MB decoded). */
  stream?: boolean;
};

export type AudioUpdatePayload = {
  id: number;
  volume?: number;
  pan?: number;
  playbackRate?: number;
  playbackRateHz?: number;
  loopCount?: number;
};

export type AudioAppendPayload = {
  id: number;
  data: Float32Array;
};

type SampleMeta = {
  sampleRate: number;
};

type DecodedAudio = {
  data: Float32Array;
  channels: number;
  sampleRate: number;
};

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const STREAMING_THRESHOLD_BYTES = 512 * 1024;

type EncodedSource = {
  element: HTMLAudioElement;
  url: string;
  sourceNode: MediaElementAudioSourceNode;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  loopsRemaining: number;
  sampleRate?: number;
  positionHandler?: () => void;
  /** Loop/seek origin in seconds (payload.startOffsetMs). */
  startTime: number;
  /** Stop here instead of at the stream's end; null = play to the end. */
  endTime: number | null;
};

class LruCache<K, V> {
  private map = new Map<K, V>();

  constructor(private maxEntries: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const first = this.map.keys().next();
      if (!first.done) {
        this.map.delete(first.value);
      }
    }
  }
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** Master output hub: every source (worklet + decoded/streamed media elements)
   *  connects here, so a single gain controls overall volume / mute. Created lazily
   *  in ensureReady(); volume/mute set before that are stored and applied on creation. */
  private masterGain: GainNode | null = null;
  private masterVolume = 1;
  private muted = false;
  private ready: Promise<void> | null = null;
  private pausePromise: Promise<void> | null = null;
  private resumePromise: Promise<void> | null = null;
  /** True only while the user has intentionally paused (Space toggle). Auto-resume
   *  (gesture / statechange) is suppressed while set, so a stray click during a
   *  manual pause never un-mutes the game. */
  private userPaused = false;
  /** Idempotency guard for armAutoResume(). */
  private autoResumeArmed = false;
  private pendingDecodes: Map<number, number> = new Map();
  private inflightDecodes: Map<string, Promise<DecodedAudio>> = new Map();
  private decodeCache = new LruCache<string, DecodedAudio>(8);
  private encodedSources: Map<number, EncodedSource> = new Map();
  private pausedEncodedSources: Set<number> = new Set();
  private nextDecodeToken = 1;
  private sampleMeta: Map<number, SampleMeta> = new Map();
  onEnded: ((id: number) => void) | null = null;
  onStatusChange: ((id: number, status: "started" | "error", error?: string) => void) | null = null;
  onPosition: ((id: number, positionFrames: number) => void) | null = null;

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      // Auto-recover from a browser-initiated suspension (autoplay policy, tab
      // visibility/idle, focus loss). Browsers fire `statechange` on these; if the
      // page has already had a user gesture, resume() succeeds and the AudioWorklet
      // (→ SAB play cursor → any audio-gated game logic) keeps advancing. Before the
      // first gesture the resume is gesture-gated, so we skip it (the gesture
      // listeners in armAutoResume() handle the initial unlock).
      this.context.addEventListener("statechange", () => {
        const ctx = this.context;
        if (!ctx || ctx.state !== "suspended" || this.userPaused) return;
        const ua = (navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation;
        if (!ua || ua.hasBeenActive) void this.resume();
      });
    }
    // Arming is idempotent; do it here too so the first audio use is covered even
    // if the host never called armAutoResume() explicitly.
    this.armAutoResume();
    return this.context;
  }

  /**
   * Resume the AudioContext on the first user gesture anywhere on the page
   * (pointer/key/touch), not just on the emulator canvas. The browser's autoplay
   * policy starts the context SUSPENDED; without a resume the AudioWorklet never
   * runs and the SAB play cursor stays frozen, silently stalling any audio-gated
   * guest logic until the user interacts with the page.
   * Safe to call repeatedly — installs the window listeners only once and
   * does not create the AudioContext (so the autoplay warning is still deferred to
   * first real audio use). Respects userPaused so a manual Space-pause is honored.
   */
  armAutoResume(): void {
    if (this.autoResumeArmed || typeof window === "undefined") return;
    this.autoResumeArmed = true;
    const onGesture = () => {
      if (this.userPaused) return;
      if (this.context && this.context.state === "running") return;
      void this.resume();
    };
    // Capture phase + passive: fire before app handlers, never block the gesture.
    for (const type of ["pointerdown", "keydown", "touchstart", "mousedown"] as const) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    }
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const context = this.ensureContext();
    this.ready = (async () => {
      const moduleUrl = new URL("./bottleship-audio-worklet.js", import.meta.url);
      moduleUrl.searchParams.set("v", "5");
      await context.audioWorklet.addModule(moduleUrl);
      this.node = new AudioWorkletNode(context, "bottleship-audio", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.node.port.onmessage = (event) => {
        if (event.data?.type === "ended") {
          const id = Number(event.data?.id ?? 0);
          if (id) {
            this.sampleMeta.delete(id);
            this.pendingDecodes.delete(id);
          }
          if (id && this.onEnded) {
            this.onEnded(id);
          }
        }
        if (event.data?.type === "position") {
          const id = Number(event.data?.id ?? 0);
          const frames = Number(event.data?.positionFrames ?? event.data?.position ?? 0);
          if (id && Number.isFinite(frames)) {
            this.onPosition?.(id, frames);
          }
        }
      };
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
      this.masterGain.connect(context.destination);
      this.node.connect(this.masterGain);
    })();
    return this.ready;
  }

  /** Set the master output volume (linear 0..1). Stored even if the audio graph
   *  isn't built yet, so it applies the moment ensureReady() creates the master gain. */
  setMasterVolume(volume: number): void {
    this.masterVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
  }

  /** Mute / unmute master output without losing the stored volume level. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
  }

  async play(payload: AudioPlayPayload): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.sampleMeta.set(payload.id, { sampleRate: payload.sampleRate });
    this.node.port.postMessage(
      {
        type: "play",
        id: payload.id,
        data: payload.data,
        channels: payload.channels,
        sampleRate: payload.sampleRate,
        playbackRate: payload.playbackRate,
        volume: payload.volume,
        pan: payload.pan,
        loopCount: payload.loopCount,
      },
      [payload.data.buffer]
    );
  }

  async append(payload: AudioAppendPayload): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.node.port.postMessage(
      {
        type: "append",
        id: payload.id,
        data: payload.data,
      },
      [payload.data.buffer]
    );
  }

  async replace(payload: { id: number; data: Float32Array; channels: number }): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.node.port.postMessage(
      {
        type: "replace",
        id: payload.id,
        data: payload.data,
        channels: payload.channels,
      },
      [payload.data.buffer]
    );
  }

  async playEncoded(payload: AudioPlayEncodedPayload): Promise<void> {
    await this.ensureReady();
    if (!this.context) {
      const error = "AudioContext not initialized";
      console.error(`BottleShip: ${error}`, { id: payload.id });
      if (this.onStatusChange) {
        this.onStatusChange(payload.id, "error", error);
      }
      return;
    }
    
    if (this.shouldStreamEncoded(payload)) {
      console.log("BottleShip: Audio stream requested (MP3)", {
        id: payload.id,
        bytes: payload.data.byteLength,
        mimeType: payload.mimeType ?? "application/octet-stream",
        contextState: this.context.state
      });
      try {
        await this.playEncodedStreaming(payload);
        console.log("BottleShip: Audio stream started", { id: payload.id });
        if (this.onStatusChange) {
          this.onStatusChange(payload.id, "started");
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("BottleShip: Audio stream failed", { id: payload.id, error });
        if (this.onStatusChange) {
          this.onStatusChange(payload.id, "error", error);
        }
      }
      return;
    }

    console.log("BottleShip: Audio decode started", {
      id: payload.id,
      bytes: payload.data.byteLength,
      mimeType: payload.mimeType ?? "application/octet-stream",
      contextState: this.context.state
    });
    const token = this.nextDecodeToken++;
    this.pendingDecodes.set(payload.id, token);

    const key = this.buildDecodeKey(payload);
    const cached = this.decodeCache.get(key);
    if (cached) {
      console.log("BottleShip: Audio decode cache hit", {
        id: payload.id,
        channels: cached.channels,
        sampleRate: cached.sampleRate,
        frames: Math.floor(cached.data.length / Math.max(1, cached.channels)),
        contextState: this.context?.state
      });
      if (this.pendingDecodes.get(payload.id) !== token) {
        console.log("BottleShip: Audio decode cache hit ignored (stale token)", { id: payload.id });
        return;
      }
      this.pendingDecodes.delete(payload.id);
      const playbackRate = this.resolvePlaybackRate(payload, cached.sampleRate);
      try {
        await this.play({
          id: payload.id,
          data: this.applyEncodedOffsets(cached, payload).slice(),
          channels: cached.channels,
          sampleRate: cached.sampleRate,
          playbackRate,
          volume: payload.volume,
          pan: payload.pan,
          loopCount: payload.loopCount,
        });
        console.log("BottleShip: Audio decode finished (from cache)", { id: payload.id });
        if (this.onStatusChange) {
          this.onStatusChange(payload.id, "started");
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("BottleShip: Audio play failed (from cache)", { id: payload.id, error });
        if (this.onStatusChange) {
          this.onStatusChange(payload.id, "error", error);
        }
      }
      return;
    }

    const arrayBuffer = this.cloneArrayBuffer(payload.data);
    try {
      const decoded = await this.decodeWithCache(key, arrayBuffer);
      console.log("BottleShip: Audio decoded successfully", {
        id: payload.id,
        channels: decoded.channels,
        sampleRate: decoded.sampleRate,
        frames: Math.floor(decoded.data.length / Math.max(1, decoded.channels)),
        contextState: this.context?.state
      });
      if (this.pendingDecodes.get(payload.id) !== token) {
        console.log("BottleShip: Audio decode result ignored (stale token)", { id: payload.id });
        return;
      }
      this.pendingDecodes.delete(payload.id);
      const playbackRate = this.resolvePlaybackRate(payload, decoded.sampleRate);
      const decodedBytes = decoded.data.byteLength;
      const shaped = this.applyEncodedOffsets(decoded, payload);
      await this.play({
        id: payload.id,
        data: shaped === decoded.data && decodedBytes > MAX_CACHE_BYTES ? decoded.data : shaped.slice(),
        channels: decoded.channels,
        sampleRate: decoded.sampleRate,
        playbackRate,
        volume: payload.volume,
        pan: payload.pan,
        loopCount: payload.loopCount,
      });
      console.log("BottleShip: Audio decode finished (from decode)", { id: payload.id });
      if (this.onStatusChange) {
        this.onStatusChange(payload.id, "started");
      }
    } catch (err) {
      this.pendingDecodes.delete(payload.id);
      const error = err instanceof Error ? err.message : String(err);
      console.error("BottleShip: Audio decode failed", { id: payload.id, error, err });
      if (this.onStatusChange) {
        this.onStatusChange(payload.id, "error", error);
      }
    }
  }

  update(payload: AudioUpdatePayload): void {
    if (!this.node) return;
    const encoded = this.encodedSources.get(payload.id);
    if (encoded) {
      if (typeof payload.volume === "number") {
        encoded.gainNode.gain.value = payload.volume;
      }
      if (typeof payload.pan === "number") {
        encoded.panNode.pan.value = payload.pan;
      }
      if (typeof payload.playbackRate === "number") {
        encoded.element.playbackRate = payload.playbackRate;
      } else if (payload.playbackRateHz && encoded.sampleRate) {
        encoded.element.playbackRate = payload.playbackRateHz / encoded.sampleRate;
      }
      if (typeof payload.loopCount === "number") {
        encoded.loopsRemaining = payload.loopCount <= 0 ? Infinity : Math.max(1, payload.loopCount);
        encoded.element.loop = encoded.loopsRemaining === Infinity;
      }
      return;
    }

    const updated = { ...payload };
    if (payload.playbackRateHz) {
      const meta = this.sampleMeta.get(payload.id);
      if (meta?.sampleRate) {
        updated.playbackRate = payload.playbackRateHz / meta.sampleRate;
      }
    }
    this.node.port.postMessage({ type: "update", ...updated });
  }

  async registerBuffer(id: number, sab: SharedArrayBuffer): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.node.port.postMessage({ type: "register", id, sab });
  }

  unregisterBuffer(id: number): void {
    if (!this.node) return;
    this.node.port.postMessage({ type: "unregister", id });
  }

  async registerListenerSab(sab: SharedArrayBuffer): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.node.port.postMessage({ type: "register_listener", sab });
  }

  async registerStatsSab(sab: SharedArrayBuffer): Promise<void> {
    await this.ensureReady();
    if (!this.node) return;
    this.node.port.postMessage({ type: "register_stats", sab });
  }

  stop(id: number): void {
    this.pendingDecodes.delete(id);
    this.sampleMeta.delete(id);
    this.pausedEncodedSources.delete(id);
    this.cleanupEncodedSource(id);
    if (!this.node) return;
    this.node.port.postMessage({ type: "stop", id });
  }

  /** Silence and drop EVERY source — for guest process exit/crash. The worker is
   *  gone so it can no longer stop its sources, and the worklet would otherwise
   *  loop a stale ring/encoded buffer forever. The worklet stays alive (renders
   *  silence) so the next loaded game can register fresh sources. */
  stopAll(): void {
    this.pendingDecodes.clear();
    this.sampleMeta.clear();
    for (const id of Array.from(this.encodedSources.keys())) this.cleanupEncodedSource(id);
    this.pausedEncodedSources.clear();
    this.node?.port.postMessage({ type: "stop_all" });
  }

  pauseSource(id: number): void {
    const encoded = this.encodedSources.get(id);
    if (encoded && !encoded.element.paused) {
      encoded.element.pause();
    }
    if (this.node) {
      this.node.port.postMessage({ type: "pause", id });
    }
  }

  resumeSource(id: number): void {
    const encoded = this.encodedSources.get(id);
    if (encoded && encoded.element.paused) {
      void encoded.element.play();
    }
    if (this.node) {
      this.node.port.postMessage({ type: "resume", id });
    }
  }

  seekSource(id: number, timeMs: number): void {
    const encoded = this.encodedSources.get(id);
    if (encoded) {
      encoded.element.currentTime = timeMs / 1000;
      encoded.positionHandler?.();
    }
  }

  async pause(): Promise<void> {
    // Mark intentional pause BEFORE suspend() so the statechange→suspended event
    // (and any concurrent gesture) does not immediately auto-resume us.
    this.userPaused = true;
    if (this.pausePromise) {
      await this.pausePromise;
      return;
    }

    this.pausePromise = (async () => {
      if (this.context && this.context.state === "running") {
        await this.context.suspend();
        console.log("BottleShip: AudioContext suspended", { state: this.context.state });
      } else if (this.context) {
        console.log("BottleShip: AudioContext not running, current state:", this.context.state);
      }

      // Also pause all encoded sources (HTMLAudioElement) - they won't resume automatically
      // Track which sources were playing so we can resume them later
      let pausedCount = 0;
      for (const [id, source] of this.encodedSources.entries()) {
        if (!source.element.paused) {
          this.pausedEncodedSources.add(id);
          source.element.pause();
          pausedCount++;
        }
      }
      if (pausedCount > 0) {
        console.log("BottleShip: Paused encoded sources", { count: pausedCount, ids: Array.from(this.pausedEncodedSources) });
      }
    })();

    try {
      await this.pausePromise;
    } finally {
      this.pausePromise = null;
    }
  }

  async resume(): Promise<void> {
    // Any resume request (gesture, statechange, or explicit unpause) means we want
    // audio running again — clear the intentional-pause flag.
    this.userPaused = false;
    const context = this.ensureContext();
    if (this.resumePromise) {
      await this.resumePromise;
      return;
    }

    this.resumePromise = (async () => {
      // Only resume if suspended (avoid redundant calls when already running)
      if (context.state === "suspended") {
        try {
          await context.resume();
          console.log("BottleShip: AudioContext resumed", { state: context.state });
        } catch (err) {
          // Gesture-gated failure: keep pending audio; next user gesture can resume successfully.
          console.warn("BottleShip: AudioContext resume blocked", {
            state: context.state,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      } else if (context.state !== "running") {
        return;
      }

      await this.ensureReady();

      // Resume encoded sources that were playing before pause
      const pausedIds = Array.from(this.pausedEncodedSources);
      if (pausedIds.length === 0) return; // Nothing to resume

      this.pausedEncodedSources.clear();

      for (const id of pausedIds) {
        const source = this.encodedSources.get(id);
        if (!source) {
          // Source was removed while paused, skip it
          continue;
        }
        try {
          await source.element.play();
          console.log("BottleShip: Encoded source resumed", { id });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("BottleShip: Failed to resume encoded source", { id, error });
          // Source might have been stopped/removed, which is fine
        }
      }
      // AudioContext resume will handle worklet audio automatically
    })();

    try {
      await this.resumePromise;
    } finally {
      this.resumePromise = null;
    }
  }

  /** Trim a decoded buffer to the payload's start/end offsets (the worklet path has
   *  no transport of its own, so the window is baked into the samples it gets). */
  private applyEncodedOffsets(decoded: DecodedAudio, payload: AudioPlayEncodedPayload): Float32Array {
    const startMs = payload.startOffsetMs ?? 0;
    const endMs = payload.endOffsetMs;
    if (startMs <= 0 && endMs == null) return decoded.data;

    const channels = Math.max(1, decoded.channels);
    const totalFrames = Math.floor(decoded.data.length / channels);
    const toFrame = (ms: number): number =>
      Math.max(0, Math.min(totalFrames, Math.round((ms * decoded.sampleRate) / 1000)));

    const from = toFrame(startMs);
    const to = endMs != null && endMs > startMs ? toFrame(endMs) : totalFrames;
    if (to <= from) return new Float32Array(0);
    return decoded.data.subarray(from * channels, to * channels);
  }

  private resolvePlaybackRate(payload: AudioPlayEncodedPayload, sampleRate: number): number {
    if (payload.playbackRateHz && sampleRate > 0) {
      return payload.playbackRateHz / sampleRate;
    }
    return payload.playbackRate ?? 1;
  }

  private cloneArrayBuffer(data: Uint8Array): ArrayBuffer {
    // Convert to ArrayBuffer (may be SharedArrayBuffer from worker)
    const buffer = data.buffer instanceof SharedArrayBuffer 
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) 
      : data.buffer;
    
    if (data.byteOffset === 0 && data.byteLength === buffer.byteLength) {
      return buffer.slice(0) as ArrayBuffer;
    }
    return buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private interleave(buffer: AudioBuffer): Float32Array {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const out = new Float32Array(frames * channels);
    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        out[i * channels + ch] = src[i];
      }
    }
    return out;
  }

  private shouldStreamEncoded(payload: AudioPlayEncodedPayload): boolean {
    if (payload.stream) return true;
    const mime = (payload.mimeType ?? "").toLowerCase();
    if (mime.includes("audio/mpeg") || mime.includes("audio/mp3")) {
      return true;
    }
    if (mime.includes("audio/ogg") || mime.includes("audio/vorbis")) {
      return true;
    }
    if (this.isMp3(payload.data)) return true;
    if (this.isOgg(payload.data)) return true;
    return false;
  }

  private async playEncodedStreaming(payload: AudioPlayEncodedPayload): Promise<void> {
    if (!this.context) return;
    this.stop(payload.id);

    const mimeType = payload.mimeType ?? "audio/mpeg";
    // Ensure we have a regular ArrayBuffer (not SharedArrayBuffer) for Blob
    // Create a copy with regular ArrayBuffer to satisfy Blob API
    const regularBuffer = new ArrayBuffer(payload.data.byteLength);
    const dataCopy = new Uint8Array(regularBuffer);
    dataCopy.set(payload.data);
    const blob = new Blob([dataCopy], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const element = new Audio();
    element.preload = "auto";
    element.src = url;

    const sourceNode = this.context.createMediaElementSource(element);
    const gainNode = this.context.createGain();
    const panNode = this.context.createStereoPanner();
    gainNode.gain.value = payload.volume ?? 1;
    panNode.pan.value = payload.pan ?? 0;
    sourceNode.connect(gainNode).connect(panNode).connect(this.masterGain ?? this.context.destination);

    const loopCount = typeof payload.loopCount === "number" ? payload.loopCount : 1;
    const loopsRemaining = loopCount <= 0 ? Infinity : Math.max(1, loopCount);
    element.loop = loopsRemaining === Infinity;

    const sampleRate = this.getMp3SampleRate(payload.data);
    if (payload.playbackRateHz && sampleRate) {
      element.playbackRate = payload.playbackRateHz / sampleRate;
    } else {
      element.playbackRate = payload.playbackRate ?? 1;
    }

    const startTime = Math.max(0, (payload.startOffsetMs ?? 0) / 1000);
    const endTime = typeof payload.endOffsetMs === "number"
      && payload.endOffsetMs > (payload.startOffsetMs ?? 0)
      ? payload.endOffsetMs / 1000
      : null;

    const reportPosition = () => {
      const source = this.encodedSources.get(payload.id);
      const rate = source?.sampleRate ?? this.context?.sampleRate ?? 44100;
      if (this.onPosition && Number.isFinite(element.currentTime)) {
        this.onPosition(payload.id, Math.floor(element.currentTime * rate));
      }
      // A "play to" boundary inside the stream is the end of playback as far as
      // the caller is concerned — the element itself would keep going.
      if (source?.endTime != null && element.currentTime >= source.endTime) {
        this.handleEncodedEnded(payload.id);
      }
    };

    this.encodedSources.set(payload.id, {
      element,
      url,
      sourceNode,
      gainNode,
      panNode,
      loopsRemaining,
      sampleRate: sampleRate ?? undefined,
      positionHandler: reportPosition,
      startTime,
      endTime,
    });

    element.addEventListener("ended", () => {
      this.handleEncodedEnded(payload.id);
    });
    element.addEventListener("timeupdate", reportPosition);
    element.addEventListener("seeking", reportPosition);

    if (startTime > 0) {
      const applyStartOffset = () => {
        try {
          element.currentTime = startTime;
        } catch {
          // Seek before the browser has a seekable range — the media is played from 0.
        }
      };
      if (element.readyState >= 1) applyStartOffset();
      else element.addEventListener("loadedmetadata", applyStartOffset, { once: true });
    }

    // Resume AudioContext if suspended (user likely already clicked to start the game).
    // Without this the browser logs "AudioContext was not allowed to start" and element.play()
    // may also throw NotAllowedError while the context is still suspended.
    if (this.context.state === "suspended") {
      try {
        await this.context.resume();
      } catch {
        // Gesture-gated failure — resume will be retried on next user interaction.
      }
    }

    try {
      await element.play();
      // Note: onStatusChange will be called from playEncoded wrapper
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("BottleShip: Audio element play failed", { id: payload.id, error, err });
      // Cleanup on error
      this.cleanupEncodedSource(payload.id);
      // onStatusChange will be called from playEncoded wrapper
      throw err; // Re-throw so playEncoded can handle it
    }
  }

  private handleEncodedEnded(id: number): void {
    const source = this.encodedSources.get(id);
    if (!source) return;
    if (source.loopsRemaining === Infinity) return;
    if (source.loopsRemaining > 1) {
      source.loopsRemaining -= 1;
      source.element.currentTime = source.startTime;
      void source.element.play();
      return;
    }
    this.cleanupEncodedSource(id);
    if (this.onEnded) {
      this.onEnded(id);
    }
  }

  private cleanupEncodedSource(id: number): void {
    const source = this.encodedSources.get(id);
    if (!source) return;
    if (source.positionHandler) {
      source.element.removeEventListener("timeupdate", source.positionHandler);
      source.element.removeEventListener("seeking", source.positionHandler);
    }
    source.element.pause();
    source.element.src = "";
    URL.revokeObjectURL(source.url);
    source.sourceNode.disconnect();
    source.gainNode.disconnect();
    source.panNode.disconnect();
    this.encodedSources.delete(id);
    this.pausedEncodedSources.delete(id);
  }

  private buildDecodeKey(payload: AudioPlayEncodedPayload): string {
    const mime = payload.mimeType ?? "application/octet-stream";
    const sig = this.hashBytes(payload.data);
    return `${mime}:${payload.data.byteLength}:${sig}`;
  }

  private async decodeWithCache(key: string, data: ArrayBuffer): Promise<DecodedAudio> {
    const cached = this.decodeCache.get(key);
    if (cached) return cached;

    let inflight = this.inflightDecodes.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          console.log("BottleShip: Starting decodeAudioData", { key, bytes: data.byteLength });
          const decoded = await this.context!.decodeAudioData(data);
          const interleaved = this.interleave(decoded);
          const value = {
            data: interleaved,
            channels: decoded.numberOfChannels,
            sampleRate: decoded.sampleRate
          };
          console.log("BottleShip: decodeAudioData finished", {
            key,
            channels: value.channels,
            sampleRate: value.sampleRate,
            frames: Math.floor(interleaved.length / Math.max(1, value.channels))
          });
          if (interleaved.byteLength <= MAX_CACHE_BYTES) {
            this.decodeCache.set(key, value);
          } else {
            console.log("BottleShip: Audio decode cache skipped (too large)", {
              bytes: interleaved.byteLength,
              channels: value.channels,
              sampleRate: value.sampleRate
            });
          }
          return value;
        } catch (err) {
          console.error("BottleShip: decodeAudioData failed", { key, bytes: data.byteLength, err });
          throw err;
        }
      })();
      this.inflightDecodes.set(key, inflight);
    }

    try {
      return await inflight;
    } finally {
      this.inflightDecodes.delete(key);
    }
  }

  private hashBytes(data: Uint8Array): string {
    let hash = 2166136261;
    const maxProbe = 4096;
    const len = data.length;
    const headLen = Math.min(len, maxProbe);
    for (let i = 0; i < headLen; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
    }
    if (len > headLen) {
      const tailStart = Math.max(headLen, len - maxProbe);
      for (let i = tailStart; i < len; i++) {
        hash ^= data[i];
        hash = Math.imul(hash, 16777619);
      }
    }
    return (hash >>> 0).toString(16);
  }

  private isOgg(data: Uint8Array): boolean {
    if (data.length < 4) return false;
    // OggS magic bytes
    return data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
  }

  private isMp3(data: Uint8Array): boolean {
    if (data.length < 3) return false;
    if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
      return true;
    }
    if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
      return true;
    }
    return false;
  }

  private getMp3SampleRate(data: Uint8Array): number | null {
    const maxScan = Math.min(data.length - 4, 4096);
    for (let i = 0; i < maxScan; i++) {
      const b0 = data[i];
      const b1 = data[i + 1];
      if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
        continue;
      }
      const b2 = data[i + 2];
      const versionId = (b1 >> 3) & 0x03;
      const sampleRateIndex = (b2 >> 2) & 0x03;
      if (sampleRateIndex === 3 || versionId === 1) {
        return null;
      }
      const rates = [44100, 48000, 32000];
      let baseRate = rates[sampleRateIndex];
      if (versionId === 2) {
        baseRate = baseRate / 2;
      } else if (versionId === 0) {
        baseRate = baseRate / 4;
      }
      return baseRate;
    }
    return null;
  }
}
