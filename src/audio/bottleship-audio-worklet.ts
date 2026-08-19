declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// ─── Inline ring buffer constants (duplicated from audio-ring-buffer.ts to avoid import issues in worklet scope) ───

const CTRL_PLAY_CURSOR = 0;
const CTRL_WRITE_CURSOR = 1;
const CTRL_BUFFER_BYTES = 2;
const CTRL_CHANNELS = 3;
const CTRL_SAMPLE_RATE = 4;
const CTRL_BITS_PER_SAMPLE = 5;
const CTRL_BLOCK_ALIGN = 6;
const CTRL_STATE = 7;
const CTRL_LOOP_MODE = 8;
const CTRL_VOLUME = 9;
const CTRL_PAN = 10;
const CTRL_FREQUENCY = 11;
const CTRL_DATA_LENGTH = 12;
const CTRL_STOP_REQUESTED = 13;
const CTRL_FLAGS = 14;
const CTRL_RESET_POSITION = 15;
const CTRL_BLOCK_BYTES = 128;
const STATE_PLAYING = 1;
const FLAG_CIRCULAR = 1;
const FLAG_STREAMING = 2;

// ─── 3D per-buffer control fields ───────────────────────────────────────────

const CTRL_3D_POS_X = 16;
const CTRL_3D_POS_Y = 17;
const CTRL_3D_POS_Z = 18;
const CTRL_3D_VEL_X = 19;
const CTRL_3D_VEL_Y = 20;
const CTRL_3D_VEL_Z = 21;
const CTRL_3D_MIN_DIST = 22;
const CTRL_3D_MAX_DIST = 23;
const CTRL_3D_MODE = 24;
const CTRL_3D_CONE_INNER = 25;
const CTRL_3D_CONE_OUTER = 26;
const CTRL_3D_CONE_ORI_X = 27;
const CTRL_3D_CONE_ORI_Y = 28;
const CTRL_3D_CONE_ORI_Z = 29;
const CTRL_3D_CONE_OUTVOL = 30;
const CTRL_3D_FLAGS = 31;

// ─── Listener SAB fields ────────────────────────────────────────────────────

const LCTRL_POS_X = 0;
const LCTRL_POS_Y = 1;
const LCTRL_POS_Z = 2;
const LCTRL_VEL_X = 3;
const LCTRL_VEL_Y = 4;
const LCTRL_VEL_Z = 5;
const LCTRL_FRONT_X = 6;
const LCTRL_FRONT_Y = 7;
const LCTRL_FRONT_Z = 8;
const LCTRL_TOP_X = 9;
const LCTRL_TOP_Y = 10;
const LCTRL_TOP_Z = 11;
const LCTRL_DIST_FACTOR = 12;
const LCTRL_ROLLOFF_FACTOR = 13;
const LCTRL_DOPPLER_FACTOR = 14;

// ─── Signal-stats SAB fields (duplicated from audio-ring-buffer.ts) ─────────

const STATS_PROC = 0;
const STATS_FRAMES = 1;
const STATS_ACTIVE_RING = 2;
const STATS_CLIP = 3;
const STATS_LIMITED = 4;
const STATS_PEAK_MILLI = 5;
const STATS_DISC = 6;
const STATS_MAX_JUMP_MILLI = 7;
const STATS_UNDERRUN_MID = 8;
const STATS_STARVED_BLOCKS = 9;
const STATS_ACTIVE_LEGACY = 10;
const STATS_RESET = 15;

// Output limiter: transparent below LIMIT_T, soft knee above. A mixed signal
// from a single int16 source can never exceed 1.0, so the limiter only engages
// when multiple sources genuinely sum past the threshold.
const LIMIT_T = 0.95;
const LIMIT_K = 1 - LIMIT_T;

// Discontinuity detector threshold: |s[n]−s[n−1]| above this between adjacent
// output samples counts as a click/splice candidate.
const DISC_THRESHOLD = 0.5;

// Underrun concealment: when a streaming source's play head catches the write
// cursor mid-block, ramp its last contributed sample to zero over this many frames
// instead of stepping straight to silence (which clicks). ~1.3ms at 48kHz.
// Pure consumer-side; does NOT touch the guest-visible cursors. EAR-VERIFY before
// committing — set to 0 to disable.
const CONCEAL_FADE_FRAMES = 64;

// DS3D mode constants
const DS3DMODE_NORMAL = 0;
const DS3DMODE_HEAD_RELATIVE = 1;
const DS3DMODE_DISABLE = 2;

// Speed of sound in meters/sec (DirectSound default)
const SPEED_OF_SOUND = 340.0;

// ─── Float ↔ Int32 helper (inlined) ────────────────────────────────────────

const _wf32 = new Float32Array(1);
const _wi32 = new Int32Array(_wf32.buffer);

function i32ToFloat(i: number): number {
    _wi32[0] = i;
    return _wf32[0];
}

// ─── Ring buffer source type ─────────────────────────────────────────────────

type RingBufferSource = {
  id: number;
  ctrl: Int32Array;     // SAB control block view (32 Int32 entries)
  data: DataView;       // SAB data region view (includes ctrl block — use CTRL_BLOCK_BYTES offset)
  // The same SAB through width-typed views. The mixer reads two samples per output
  // sample per channel; through `data` that is two DataView calls, through these it is
  // two loads. Built once at registration (a per-block view would allocate inside the
  // render quantum) and used only when the frame layout is aligned for the width.
  u8: Uint8Array;
  i16: Int16Array;
  f32: Float32Array;
  position: number;     // Fractional frame position (float)
  loopsCompleted: number;
};

class BottleShipAudioProcessor extends AudioWorkletProcessor {
  private static readonly POSITION_REPORT_FRAMES = 1024;
  private static readonly POSITION_REPORT_SECONDS = 0.05;

  // Legacy chunk-based sources (postMessage path — kept for encoded audio fallback)
  private sources: Map<number, {
    id: number;
    chunks: Float32Array[];
    paused: boolean;
    channels: number;
    sampleRate: number;
    playbackRate: number;
    volume: number;
    pan: number;
    loopCount: number;
    loopsRemaining: number;
    position: number;
    totalFrames: number;
    cursorChunkIndex: number;
    cursorFrameBase: number;
    lastReportedFrame: number;
    lastReportedTime: number;
  }> = new Map();

  // SAB ring buffer sources (zero-copy path)
  private ringBuffers: Map<number, RingBufferSource> = new Map();

  // Listener SAB (global singleton, shared from dsound)
  private listenerCtrl: Int32Array | null = null;

  // Signal-stats SAB (global singleton; worklet is the only counter writer)
  private statsCtrl: Int32Array | null = null;
  // Last output sample per channel, for cross-block discontinuity detection
  private lastOut: number[] = [0, 0];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      // ─── Listener SAB registration ───
      if (msg.type === "register_listener") {
        this.listenerCtrl = new Int32Array(msg.sab, 0, 16);
        return;
      }

      // ─── Signal-stats SAB registration ───
      if (msg.type === "register_stats") {
        this.statsCtrl = new Int32Array(msg.sab, 0, 16);
        return;
      }

      // ─── Ring buffer registration ───
      if (msg.type === "register") {
        const sab: SharedArrayBuffer = msg.sab;
        const id: number = msg.id;
        this.ringBuffers.set(id, {
          id,
          ctrl: new Int32Array(sab, 0, 32),
          data: new DataView(sab),
          // Explicit lengths: a SAB whose byteLength is not a multiple of the element
          // size would make the 1-argument constructor throw.
          u8: new Uint8Array(sab),
          i16: new Int16Array(sab, 0, sab.byteLength >> 1),
          f32: new Float32Array(sab, 0, sab.byteLength >> 2),
          position: 0,
          loopsCompleted: 0,
        });
        return;
      }
      if (msg.type === "unregister") {
        this.ringBuffers.delete(msg.id);
        return;
      }

      // ─── Stop everything (guest process exit/crash) ───
      // The worker is gone and can't stop its own sources; without this the
      // worklet keeps looping whatever ring/legacy source was still PLAYING
      // (a circular/looping buffer drones the stale ring forever).
      if (msg.type === "stop_all") {
        this.ringBuffers.clear();
        this.sources.clear();
        this.lastOut[0] = 0;
        this.lastOut[1] = 0;
        return;
      }

      // ─── Legacy chunk-based messages ───
      if (msg.type === "play") {
        const {
          id,
          data,
          channels,
          sampleRate: sourceSampleRate,
          playbackRate,
          volume,
          pan,
          loopCount
        } = msg;
        const safeChannels = Math.max(1, Math.floor(channels ?? 1));
        const initialData: Float32Array = data ?? new Float32Array();
        const initialFrames = Math.floor(initialData.length / safeChannels);
        this.sources.set(id, {
          id,
          chunks: initialData.length > 0 ? [initialData] : [],
          paused: false,
          channels: safeChannels,
          sampleRate: sourceSampleRate || sampleRate,
          playbackRate: playbackRate ?? 1,
          volume: volume ?? 1,
          pan: pan ?? 0,
          loopCount: typeof loopCount === "number" ? loopCount : 1,
          loopsRemaining: (typeof loopCount === "number" && loopCount <= 0) ? Infinity : Math.max(1, typeof loopCount === "number" ? loopCount : 1),
          position: 0,
          totalFrames: initialFrames,
          cursorChunkIndex: 0,
          cursorFrameBase: 0,
          lastReportedFrame: 0,
          lastReportedTime: 0,
        });
      }
      if (msg.type === "append") {
        const source = this.sources.get(msg.id);
        const chunk: Float32Array = msg.data;
        if (source && chunk && chunk.length > 0) {
          source.chunks.push(chunk);
          const frames = Math.floor(chunk.length / Math.max(1, source.channels));
          source.totalFrames += frames;
        }
      }
      if (msg.type === "stop") {
        this.sources.delete(msg.id);
      }
      if (msg.type === "pause") {
        const source = this.sources.get(msg.id);
        if (source) source.paused = true;
      }
      if (msg.type === "resume") {
        const source = this.sources.get(msg.id);
        if (source) source.paused = false;
      }
      if (msg.type === "replace") {
        const source = this.sources.get(msg.id);
        if (source && msg.data) {
          const newData: Float32Array = msg.data;
          const newFrames = Math.floor(newData.length / Math.max(1, source.channels));
          source.chunks = [newData];
          source.totalFrames = newFrames;
          source.cursorChunkIndex = 0;
          source.cursorFrameBase = 0;
          // position NOT reset — seamless data swap
        }
      }
      if (msg.type === "update") {
        const source = this.sources.get(msg.id);
        if (!source) return;
        if (typeof msg.volume === "number") source.volume = msg.volume;
        if (typeof msg.pan === "number") source.pan = msg.pan;
        if (typeof msg.playbackRate === "number") source.playbackRate = msg.playbackRate;
        if (typeof msg.loopCount === "number") {
          source.loopCount = msg.loopCount;
          source.loopsRemaining = msg.loopCount <= 0 ? Infinity : Math.max(1, msg.loopCount);
        }
      }
    };
  }

  // ─── Legacy chunk helpers (unchanged) ──────────────────────────────────────

  private chunkFrames(chunk: Float32Array, channels: number): number {
    return Math.floor(chunk.length / Math.max(1, channels));
  }

  private locateChunk(source: {
    chunks: Float32Array[];
    channels: number;
    cursorChunkIndex: number;
    cursorFrameBase: number;
  }, frameIndex: number): { chunk: Float32Array; frameBase: number; chunkFrames: number } | null {
    if (frameIndex < 0 || source.chunks.length === 0) return null;

    let chunkIndex = source.cursorChunkIndex;
    let frameBase = source.cursorFrameBase;

    if (frameIndex < frameBase) {
      chunkIndex = 0;
      frameBase = 0;
    }

    let chunk = source.chunks[chunkIndex];
    let framesInChunk = chunk ? this.chunkFrames(chunk, source.channels) : 0;

    while (chunk && frameIndex >= frameBase + framesInChunk) {
      frameBase += framesInChunk;
      chunkIndex += 1;
      chunk = source.chunks[chunkIndex];
      framesInChunk = chunk ? this.chunkFrames(chunk, source.channels) : 0;
    }

    if (!chunk || framesInChunk <= 0) {
      source.cursorChunkIndex = Math.max(0, Math.min(chunkIndex, source.chunks.length));
      source.cursorFrameBase = frameBase;
      return null;
    }

    source.cursorChunkIndex = chunkIndex;
    source.cursorFrameBase = frameBase;
    return { chunk, frameBase, chunkFrames: framesInChunk };
  }

  private sampleAt(source: {
    chunks: Float32Array[];
    channels: number;
    cursorChunkIndex: number;
    cursorFrameBase: number;
  }, frameIndex: number, channel: number): number {
    const located = this.locateChunk(source, frameIndex);
    if (!located) return 0;
    const { chunk, frameBase, chunkFrames } = located;
    const localFrame = frameIndex - frameBase;
    if (localFrame < 0 || localFrame >= chunkFrames) return 0;
    const channels = Math.max(1, source.channels);
    const index = localFrame * channels + channel;
    if (index < 0 || index >= chunk.length) return 0;
    return chunk[index] ?? 0;
  }

  private maybeReportPosition(id: number, source: { position: number; lastReportedFrame: number; lastReportedTime: number }): void {
    const now = currentTime;
    const currentFrame = Math.floor(source.position);
    if (currentFrame === source.lastReportedFrame) return;
    if (
      now - source.lastReportedTime < BottleShipAudioProcessor.POSITION_REPORT_SECONDS &&
      Math.abs(currentFrame - source.lastReportedFrame) < BottleShipAudioProcessor.POSITION_REPORT_FRAMES
    ) {
      return;
    }
    source.lastReportedFrame = currentFrame;
    source.lastReportedTime = now;
    this.port.postMessage({ type: "position", id, positionFrames: currentFrame });
  }

  // ─── Ring buffer inline sample reader ──────────────────────────────────────

  private readSampleFloat(view: DataView, byteOffset: number, bitsPerSample: number): number {
    if (bitsPerSample === 16) {
      return view.getInt16(byteOffset, true) / 32768;
    }
    if (bitsPerSample === 8) {
      return (view.getUint8(byteOffset) - 128) / 128;
    }
    if (bitsPerSample === 32) {
      return view.getFloat32(byteOffset, true);
    }
    return 0;
  }

  // ─── Main process() ────────────────────────────────────────────────────────

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outChannels = output.length;
    const frames = output[0].length;

    for (let ch = 0; ch < outChannels; ch++) {
      output[ch].fill(0);
    }

    // Per-block stats accumulators (flushed to the stats SAB once per block)
    let activeRing = 0;
    let underrunMid = 0;
    let starvedBlocks = 0;

    // ─── Process SAB ring buffer sources ───
    for (const [id, rb] of this.ringBuffers.entries()) {
      const ctrl = rb.ctrl;

      // Check stop request
      const stopReq = Atomics.load(ctrl, CTRL_STOP_REQUESTED);
      if (stopReq) {
        Atomics.store(ctrl, CTRL_STOP_REQUESTED, 0);
        Atomics.store(ctrl, CTRL_STATE, 0); // stopped
        Atomics.store(ctrl, CTRL_PLAY_CURSOR, 0);
        rb.position = 0;
        rb.loopsCompleted = 0;
        continue;
      }

      // Position seek/reset: producer sets CTRL_PLAY_CURSOR then CTRL_RESET_POSITION=1.
      // Play() resets to 0; SetCurrentPosition(pos) seeks rb.position to match the guest.
      const resetReq = Atomics.load(ctrl, CTRL_RESET_POSITION);
      if (resetReq) {
        Atomics.store(ctrl, CTRL_RESET_POSITION, 0);
        const blockAlignSeek = Math.max(1, Atomics.load(ctrl, CTRL_BLOCK_ALIGN) || 4);
        const bufferBytesSeek = Atomics.load(ctrl, CTRL_BUFFER_BYTES) || 0;
        const dataLenSeek = Atomics.load(ctrl, CTRL_DATA_LENGTH);
        const effBytesSeek = bufferBytesSeek > 0
          ? Math.min(dataLenSeek > 0 ? dataLenSeek : bufferBytesSeek, bufferBytesSeek)
          : 0;
        const totalFramesSeek = effBytesSeek > 0
          ? Math.max(1, Math.floor(effBytesSeek / blockAlignSeek))
          : 1;
        const seekBytes = bufferBytesSeek > 0
          ? (Atomics.load(ctrl, CTRL_PLAY_CURSOR) >>> 0) % bufferBytesSeek
          : 0;
        const seekFrame = Math.floor(seekBytes / blockAlignSeek) % totalFramesSeek;
        rb.position = seekFrame;
        rb.loopsCompleted = 0;
        if (bufferBytesSeek > 0) {
          Atomics.store(ctrl, CTRL_PLAY_CURSOR, (seekFrame * blockAlignSeek) % bufferBytesSeek);
        }
      }

      const state = Atomics.load(ctrl, CTRL_STATE);
      if (state !== STATE_PLAYING) continue;
      activeRing++;

      const bufferBytes = Atomics.load(ctrl, CTRL_BUFFER_BYTES);
      const channels = Atomics.load(ctrl, CTRL_CHANNELS) || 1;
      const sourceSampleRate = Atomics.load(ctrl, CTRL_SAMPLE_RATE) || 44100;
      const bitsPerSample = Atomics.load(ctrl, CTRL_BITS_PER_SAMPLE) || 16;
      const blockAlign = Atomics.load(ctrl, CTRL_BLOCK_ALIGN) || (channels * (bitsPerSample >> 3));
      const frequency = Atomics.load(ctrl, CTRL_FREQUENCY) || sourceSampleRate;
      const loopMode = Atomics.load(ctrl, CTRL_LOOP_MODE);
      const volumeCb = Atomics.load(ctrl, CTRL_VOLUME);
      const panVal = Atomics.load(ctrl, CTRL_PAN);
      const dataLength = Atomics.load(ctrl, CTRL_DATA_LENGTH);
      const flags = Atomics.load(ctrl, CTRL_FLAGS);
      const isCircular = (flags & FLAG_CIRCULAR) !== 0;

      if (blockAlign === 0 || bufferBytes === 0) continue;

      // Effective data size: for circular streaming (e.g. video audio), respect
      // dataLength until the ring buffer is fully populated to avoid reading
      // unwritten zeros as silence.
      // Clamped to what the SAB actually holds: bufferBytes/dataLength come straight out of
      // the ctrl block, and a bad one would send every read past the end. On the DataView
      // path that is a RangeError thrown inside process(), which does not surface as an
      // exception — it permanently disables the processor, i.e. silence for the session.
      const declaredBytes = Math.min(dataLength > 0 ? dataLength : bufferBytes, bufferBytes);
      const effectiveBytes = Math.min(declaredBytes, Math.max(0, rb.u8.length - CTRL_BLOCK_BYTES));
      if (effectiveBytes === 0) continue;
      const totalFrames = Math.floor(effectiveBytes / blockAlign);
      if (totalFrames === 0) continue;

      // Rate: frequency / sampleRate gives playback speed
      let rate = (frequency / sampleRate);
      if (rate <= 0) continue;

      // Volume: centibels to linear
      let linearVol: number;
      if (volumeCb <= -10000) {
        linearVol = 0;
      } else if (volumeCb >= 0) {
        linearVol = 1;
      } else {
        linearVol = Math.pow(10, volumeCb / 2000);
      }

      // Pan: centibels to L/R gain (app-level pan)
      let leftGain: number;
      let rightGain: number;
      if (panVal <= -10000) {
        leftGain = 1; rightGain = 0;
      } else if (panVal >= 10000) {
        leftGain = 0; rightGain = 1;
      } else if (panVal < 0) {
        leftGain = 1;
        rightGain = Math.pow(10, panVal / 2000);
      } else if (panVal > 0) {
        leftGain = Math.pow(10, -panVal / 2000);
        rightGain = 1;
      } else {
        leftGain = 1; rightGain = 1;
      }

      // ─── 3D spatialization ───
      const flags3d = Atomics.load(ctrl, CTRL_3D_FLAGS);
      const has3D = (flags3d & 1) !== 0;
      const mode3d = Atomics.load(ctrl, CTRL_3D_MODE);

      if (has3D && this.listenerCtrl && mode3d !== DS3DMODE_DISABLE) {
        const lctrl = this.listenerCtrl;

        // Read listener state
        const lPosX = i32ToFloat(Atomics.load(lctrl, LCTRL_POS_X));
        const lPosY = i32ToFloat(Atomics.load(lctrl, LCTRL_POS_Y));
        const lPosZ = i32ToFloat(Atomics.load(lctrl, LCTRL_POS_Z));
        const lVelX = i32ToFloat(Atomics.load(lctrl, LCTRL_VEL_X));
        const lVelY = i32ToFloat(Atomics.load(lctrl, LCTRL_VEL_Y));
        const lVelZ = i32ToFloat(Atomics.load(lctrl, LCTRL_VEL_Z));
        const lFrontX = i32ToFloat(Atomics.load(lctrl, LCTRL_FRONT_X));
        const lFrontY = i32ToFloat(Atomics.load(lctrl, LCTRL_FRONT_Y));
        const lFrontZ = i32ToFloat(Atomics.load(lctrl, LCTRL_FRONT_Z));
        const lTopX = i32ToFloat(Atomics.load(lctrl, LCTRL_TOP_X));
        const lTopY = i32ToFloat(Atomics.load(lctrl, LCTRL_TOP_Y));
        const lTopZ = i32ToFloat(Atomics.load(lctrl, LCTRL_TOP_Z));
        const distFactor = i32ToFloat(Atomics.load(lctrl, LCTRL_DIST_FACTOR));
        const rolloff = i32ToFloat(Atomics.load(lctrl, LCTRL_ROLLOFF_FACTOR));
        const dopplerFactor = i32ToFloat(Atomics.load(lctrl, LCTRL_DOPPLER_FACTOR));

        // Read source state
        const sPosX = i32ToFloat(Atomics.load(ctrl, CTRL_3D_POS_X));
        const sPosY = i32ToFloat(Atomics.load(ctrl, CTRL_3D_POS_Y));
        const sPosZ = i32ToFloat(Atomics.load(ctrl, CTRL_3D_POS_Z));
        const sVelX = i32ToFloat(Atomics.load(ctrl, CTRL_3D_VEL_X));
        const sVelY = i32ToFloat(Atomics.load(ctrl, CTRL_3D_VEL_Y));
        const sVelZ = i32ToFloat(Atomics.load(ctrl, CTRL_3D_VEL_Z));
        const minDist = i32ToFloat(Atomics.load(ctrl, CTRL_3D_MIN_DIST));
        const maxDist = i32ToFloat(Atomics.load(ctrl, CTRL_3D_MAX_DIST));
        const coneInner = Atomics.load(ctrl, CTRL_3D_CONE_INNER);
        const coneOuter = Atomics.load(ctrl, CTRL_3D_CONE_OUTER);
        const coneOriX = i32ToFloat(Atomics.load(ctrl, CTRL_3D_CONE_ORI_X));
        const coneOriY = i32ToFloat(Atomics.load(ctrl, CTRL_3D_CONE_ORI_Y));
        const coneOriZ = i32ToFloat(Atomics.load(ctrl, CTRL_3D_CONE_ORI_Z));
        const coneOutVolCb = Atomics.load(ctrl, CTRL_3D_CONE_OUTVOL);

        // Direction vector from listener to source
        let dx: number, dy: number, dz: number;
        if (mode3d === DS3DMODE_HEAD_RELATIVE) {
          dx = sPosX;
          dy = sPosY;
          dz = sPosZ;
        } else {
          dx = sPosX - lPosX;
          dy = sPosY - lPosY;
          dz = sPosZ - lPosZ;
        }

        const rawDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const dist = rawDist * (distFactor > 0 ? distFactor : 1);

        // Normalize direction
        let dirX = 0, dirY = 0, dirZ = 1;
        if (rawDist > 1e-7) {
          const invDist = 1 / rawDist;
          dirX = dx * invDist;
          dirY = dy * invDist;
          dirZ = dz * invDist;
        }

        // 1. Distance attenuation (DS3D inverse-distance model)
        const safeMinDist = Math.max(minDist, 1e-7);
        const clampedDist = Math.max(safeMinDist, Math.min(dist, maxDist));
        const distAtten = safeMinDist / (safeMinDist + rolloff * (clampedDist - safeMinDist));

        // 2. Stereo pan from azimuth
        // Listener's right vector = cross(front, top)
        const rightX = lFrontY * lTopZ - lFrontZ * lTopY;
        const rightY = lFrontZ * lTopX - lFrontX * lTopZ;
        const rightZ = lFrontX * lTopY - lFrontY * lTopX;
        // Normalize right vector
        const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
        let nrX = 0, nrY = 0, nrZ = 0;
        if (rightLen > 1e-7) {
          const invR = 1 / rightLen;
          nrX = rightX * invR;
          nrY = rightY * invR;
          nrZ = rightZ * invR;
        }
        // Pan value: dot(direction, right) in [-1, 1]
        const panValue = dirX * nrX + dirY * nrY + dirZ * nrZ;
        // Equal-power panning: theta = (panValue + 1) * PI/4
        const theta = (panValue + 1) * 0.7853981633974483; // PI/4
        const leftGain3d = Math.cos(theta);
        const rightGain3d = Math.sin(theta);

        // 3. Doppler pitch shift
        if (dopplerFactor > 0) {
          const c = SPEED_OF_SOUND;
          // Velocity of listener projected onto direction
          let vls: number, vss: number;
          if (mode3d === DS3DMODE_HEAD_RELATIVE) {
            vls = 0;
            vss = sVelX * dirX + sVelY * dirY + sVelZ * dirZ;
          } else {
            vls = lVelX * dirX + lVelY * dirY + lVelZ * dirZ;
            vss = sVelX * dirX + sVelY * dirY + sVelZ * dirZ;
          }
          const denom = c - dopplerFactor * vss;
          if (Math.abs(denom) > 1e-7) {
            const dopplerMul = (c - dopplerFactor * vls) / denom;
            // Clamp to reasonable range
            rate *= Math.max(0.1, Math.min(10, dopplerMul));
          }
        }

        // 4. Cone attenuation
        let coneAtten = 1.0;
        if (coneInner < 360 || coneOuter < 360) {
          // Normalize cone orientation
          const coneLen = Math.sqrt(coneOriX * coneOriX + coneOriY * coneOriY + coneOriZ * coneOriZ);
          if (coneLen > 1e-7) {
            const invCone = 1 / coneLen;
            const ncX = coneOriX * invCone;
            const ncY = coneOriY * invCone;
            const ncZ = coneOriZ * invCone;
            // Angle between -direction and cone orientation
            // (we want angle from source's perspective, looking at listener)
            const dotCone = -(dirX * ncX + dirY * ncY + dirZ * ncZ);
            const angleDeg = Math.acos(Math.max(-1, Math.min(1, dotCone))) * (180 / Math.PI);
            const halfInner = coneInner * 0.5;
            const halfOuter = coneOuter * 0.5;
            if (angleDeg <= halfInner) {
              coneAtten = 1.0;
            } else if (angleDeg >= halfOuter) {
              // Outside cone: apply cone outside volume
              if (coneOutVolCb <= -10000) {
                coneAtten = 0;
              } else if (coneOutVolCb >= 0) {
                coneAtten = 1;
              } else {
                coneAtten = Math.pow(10, coneOutVolCb / 2000);
              }
            } else {
              // Interpolate between inner and outer
              const outerGain = coneOutVolCb <= -10000 ? 0 : (coneOutVolCb >= 0 ? 1 : Math.pow(10, coneOutVolCb / 2000));
              const t = (angleDeg - halfInner) / (halfOuter - halfInner);
              coneAtten = 1.0 + t * (outerGain - 1.0);
            }
          }
        }

        // 5. Final gains: combine app-level with 3D
        leftGain = linearVol * leftGain * distAtten * coneAtten * leftGain3d;
        rightGain = linearVol * rightGain * distAtten * coneAtten * rightGain3d;
      } else {
        // Non-3D: apply volume directly
        leftGain *= linearVol;
        rightGain *= linearVol;
      }

      const isStreaming = (flags & FLAG_STREAMING) !== 0;
      const dataView = rb.data;
      const bytesPerSample = bitsPerSample >> 3;
      // Which typed view can address this source's samples. CTRL_BLOCK_BYTES is a
      // multiple of 4, so only blockAlign can misalign a frame; a layout that no view
      // can address (or that runs past the SAB) stays on the DataView path, whose
      // out-of-range behaviour is a throw rather than a silent NaN.
      let fastRead = bitsPerSample === 8 ? 1
        : bitsPerSample === 16 && (blockAlign & 1) === 0 ? 2
        : bitsPerSample === 32 && (blockAlign & 3) === 0 ? 3
        : 0;
      if (CTRL_BLOCK_BYTES + (totalFrames - 1) * blockAlign + channels * bytesPerSample > rb.u8.length) {
        fastRead = 0;
      }
      const u8 = rb.u8;
      const i16 = rb.i16;
      const f32 = rb.f32;
      let pos = rb.position;
      let loopsCompleted = rb.loopsCompleted;
      let alive = true;
      // Last per-channel contribution of THIS source, for underrun concealment.
      let concealLast0 = 0, concealLast1 = 0;

      // For streaming sources, read write cursor once per process() call
      // writeCursorFrame = boundary up to which data has been written by the app
      const writeCursorBytes = isStreaming ? Atomics.load(ctrl, CTRL_WRITE_CURSOR) : 0;
      const writeCursorFrame = isStreaming ? Math.floor(writeCursorBytes / blockAlign) : 0;

      // A looping dsound buffer whose guest stopped refilling it keeps mixing the stale
      // ring — that is what the real software mixer does. Its position math derives
      // entirely from the primary buffer's cursor and it records nothing about how far
      // the app has written (nt5 dsound CGrace::GetBytePosition), so there is no
      // drained-queue silence to imitate and no legitimate pump cadence to misjudge.

      for (let i = 0; i < frames; i++) {
        // Handle end-of-data
        while (pos >= totalFrames) {
          if (isCircular && (loopMode === -1 || isStreaming)) {
            // Circular: always wrap
            pos -= totalFrames;
          } else if (loopMode === -1) {
            // Loop forever (only -1 means infinite)
            pos -= totalFrames;
          } else if (loopMode > 1) {
            loopsCompleted++;
            if (loopsCompleted < loopMode) {
              pos -= totalFrames;
            } else {
              // Done — played loopMode times
              Atomics.store(ctrl, CTRL_STATE, 0);
              Atomics.store(ctrl, CTRL_PLAY_CURSOR, 0);
              pos = 0;
              alive = false;
              this.port.postMessage({ type: "ended", id });
              break;
            }
          } else {
            // Play once (loopMode <= 1: 0 or 1 both mean play once)
            Atomics.store(ctrl, CTRL_STATE, 0);
            Atomics.store(ctrl, CTRL_PLAY_CURSOR, 0);
            pos = 0;
            alive = false;
            this.port.postMessage({ type: "ended", id });
            break;
          }
        }
        if (!alive) break;

        // Streaming: check if play position has caught up to write cursor
        // Output silence (don't advance pos) until app writes more data
        if (isStreaming) {
          const playFrame = Math.floor(pos) % totalFrames;
          // Check if we've caught up: available = (write - play + total) % total
          const available = (writeCursorFrame - playFrame + totalFrames) % totalFrames;
          if (available === 0) {
            // Play position caught up to write cursor — no more data this block.
            if (i === 0) starvedBlocks++; else underrunMid++;
            // Concealment: ramp the last contributed sample to zero over a short
            // window instead of a hard step to silence (which clicks). When the
            // block is starved from frame 0, concealLast* is 0 → plain silence.
            if (CONCEAL_FADE_FRAMES > 0 && (concealLast0 !== 0 || concealLast1 !== 0)) {
              const fade = Math.min(frames - i, CONCEAL_FADE_FRAMES);
              for (let f = 0; f < fade; f++) {
                const g = 1 - (f + 1) / fade;
                output[0][i + f] += concealLast0 * g;
                if (outChannels > 1) output[1][i + f] += concealLast1 * g;
              }
            }
            break;
          }
        }

        const frameIndex = Math.floor(pos);
        const frac = pos - frameIndex;
        const wrappedFrame = isCircular ? frameIndex % totalFrames : frameIndex;

        for (let ch = 0; ch < outChannels; ch++) {
          const srcCh = Math.min(ch, channels - 1);
          // Current sample
          const byteOff = CTRL_BLOCK_BYTES + (wrappedFrame * blockAlign) + (srcCh * bytesPerSample);

          // Next sample for interpolation
          let nextFrame = wrappedFrame + 1;
          if (isCircular) {
            nextFrame = nextFrame % totalFrames;
          } else {
            nextFrame = Math.min(nextFrame, totalFrames - 1);
          }
          const byteOffNext = CTRL_BLOCK_BYTES + (nextFrame * blockAlign) + (srcCh * bytesPerSample);

          let s0: number, s1: number;
          if (fastRead === 2) {
            s0 = i16[byteOff >> 1] / 32768;
            s1 = i16[byteOffNext >> 1] / 32768;
          } else if (fastRead === 1) {
            s0 = (u8[byteOff] - 128) / 128;
            s1 = (u8[byteOffNext] - 128) / 128;
          } else if (fastRead === 3) {
            s0 = f32[byteOff >> 2];
            s1 = f32[byteOffNext >> 2];
          } else {
            s0 = this.readSampleFloat(dataView, byteOff, bitsPerSample);
            s1 = this.readSampleFloat(dataView, byteOffNext, bitsPerSample);
          }

          const sample = s0 * (1 - frac) + s1 * frac;
          let gain: number;
          if (outChannels >= 2) {
            gain = ch === 0 ? leftGain : rightGain;
          } else {
            gain = (leftGain + rightGain) * 0.5;
          }
          const contrib = sample * gain;
          output[ch][i] += contrib;
          if (ch === 0) concealLast0 = contrib; else if (ch === 1) concealLast1 = contrib;
        }

        pos += rate;
      }

      rb.position = pos;
      rb.loopsCompleted = loopsCompleted;

      // Write back play cursor (byte offset)
      if (alive) {
        const playCursorBytes = (Math.floor(pos) % totalFrames) * blockAlign;
        Atomics.store(ctrl, CTRL_PLAY_CURSOR, playCursorBytes);

        // Canonical DSound: writeCursor leads playCursor by a SMALL in-flight margin
        // (real hardware: ~15ms AHEAD of play). Mixers use it as the earliest safe
        // splice point: UE1 Galaxy mixes [myPos, write + Latency). A previous version
        // put write at play + (total - margin) ≡ play − margin — BEHIND play — which
        // collapsed Galaxy's lead to exactly 0: every 20ms mix tick landed in the SAB
        // right as the play head swept the region, so ~half the bytes played were one
        // ring-pass stale → constant 20ms-periodic splices / audible crackle
        // (proven by dsound lockTrace: play_at_unlock == lockOff + bytes on every tick).
        if (!isStreaming) {
          // Match dsound GetCurrentPosition's premix lead at its floor (45 ms at the
          // buffer's source rate; see dsound.ts dsoundLeadBytes, which ramps from there).
          // The guest-visible cursor is computed there — this SAB copy is debug-only.
          const leadFrames = Math.min(
            Math.max(64, Math.round(sourceSampleRate * 0.045)),
            Math.max(1, totalFrames - 1),
          );
          const writeCursorFrame2 = (Math.floor(pos) + leadFrames) % totalFrames;
          Atomics.store(ctrl, CTRL_WRITE_CURSOR, writeCursorFrame2 * blockAlign);
        }
      }
    }

    // ─── Process legacy chunk-based sources ───
    for (const [id, source] of this.sources.entries()) {
      const deviceSampleRate = sampleRate;
      const playback = source.playbackRate || 1;
      const ratio = deviceSampleRate > 0 ? source.sampleRate / deviceSampleRate : 1;
      const rate = playback * ratio;
      if (rate <= 0) continue;

      const channels = source.channels || 1;
      const totalFrames = Math.floor(source.totalFrames);
      if (totalFrames <= 0) continue;
      if (source.paused) continue;
      let pos = source.position;
      let loopsRemaining = source.loopsRemaining ?? 1;
      const pan = Math.max(-1, Math.min(1, source.pan ?? 0));
      const leftGain = pan <= 0 ? 1 : 1 - pan;
      const rightGain = pan >= 0 ? 1 : 1 + pan;

      for (let i = 0; i < frames; i++) {
        while (pos >= totalFrames) {
          if (loopsRemaining === Infinity) {
            pos -= totalFrames;
            continue;
          }
          if (loopsRemaining > 1) {
            loopsRemaining -= 1;
            pos -= totalFrames;
            continue;
          }
          this.sources.delete(id);
          this.port.postMessage({ type: "ended", id });
          break;
        }
        if (!this.sources.has(id)) break;

        const frameIndex = Math.floor(pos);
        const frac = pos - frameIndex;

        for (let ch = 0; ch < outChannels; ch++) {
          const srcCh = Math.min(ch, channels - 1);
          const nextFrame = Math.min(frameIndex + 1, totalFrames - 1);
          const sampleBase = this.sampleAt(source, frameIndex, srcCh);
          const sampleNext = this.sampleAt(source, nextFrame, srcCh);
          const sample = sampleBase * (1 - frac) + sampleNext * frac;
          let gain = source.volume ?? 1;
          if (outChannels >= 2) {
            gain *= ch === 0 ? leftGain : rightGain;
          }
          output[ch][i] += sample * gain;
        }

        pos += rate;
      }

      source.position = pos;
      source.loopsRemaining = loopsRemaining;
      this.maybeReportPosition(id, source);
    }

    // ─── Signal stats (pre-limiter) + output limiter ───
    // The old always-on soft clip `s/(1+|s|)` waveshaped EVERY sample — constant
    // harmonic distortion proportional to level (a 0.9 peak became 0.47). The
    // limiter below is transparent up to LIMIT_T and only bends true oversums.
    const stats = this.statsCtrl;
    if (stats && Atomics.load(stats, STATS_RESET)) {
      for (let f = 0; f <= 10; f++) Atomics.store(stats, f, 0);
      Atomics.store(stats, STATS_RESET, 0);
      this.lastOut[0] = 0;
      this.lastOut[1] = 0;
    }
    let clipCount = 0;
    let limitedCount = 0;
    let discCount = 0;
    let peak = 0;
    let maxJump = 0;
    for (let ch = 0; ch < outChannels; ch++) {
      const channel = output[ch];
      let prev = this.lastOut[ch] ?? 0;
      for (let i = 0; i < channel.length; i++) {
        const s = channel[i];
        const a = Math.abs(s);
        if (a > peak) peak = a;
        const jump = Math.abs(s - prev);
        if (jump > maxJump) maxJump = jump;
        if (jump > DISC_THRESHOLD) discCount++;
        prev = s;
        if (a > LIMIT_T) {
          limitedCount++;
          if (a > 1) clipCount++;
          // Soft knee approaching 1.0 asymptotically
          const t = (a - LIMIT_T) / LIMIT_K;
          channel[i] = (s < 0 ? -1 : 1) * (LIMIT_T + LIMIT_K * Math.tanh(t));
        }
      }
      if (ch < this.lastOut.length) this.lastOut[ch] = prev;
    }
    if (stats) {
      Atomics.add(stats, STATS_PROC, 1);
      Atomics.add(stats, STATS_FRAMES, frames);
      Atomics.store(stats, STATS_ACTIVE_RING, activeRing);
      Atomics.store(stats, STATS_ACTIVE_LEGACY, this.sources.size);
      if (clipCount) Atomics.add(stats, STATS_CLIP, clipCount);
      if (limitedCount) Atomics.add(stats, STATS_LIMITED, limitedCount);
      if (discCount) Atomics.add(stats, STATS_DISC, discCount);
      if (underrunMid) Atomics.add(stats, STATS_UNDERRUN_MID, underrunMid);
      if (starvedBlocks) Atomics.add(stats, STATS_STARVED_BLOCKS, starvedBlocks);
      const peakMilli = Math.round(peak * 1000);
      if (peakMilli > Atomics.load(stats, STATS_PEAK_MILLI)) {
        Atomics.store(stats, STATS_PEAK_MILLI, peakMilli);
      }
      const jumpMilli = Math.round(maxJump * 1000);
      if (jumpMilli > Atomics.load(stats, STATS_MAX_JUMP_MILLI)) {
        Atomics.store(stats, STATS_MAX_JUMP_MILLI, jumpMilli);
      }
    }
    return true;
  }
}

registerProcessor("bottleship-audio", BottleShipAudioProcessor);
