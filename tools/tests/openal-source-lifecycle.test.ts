/**
 * OpenAL source lifecycle: the two facts an app's audio loop runs on.
 *
 * An OpenAL app never hears its own mixer. It steers entirely on what alGetSourcei
 * reports back:
 *
 *   AL_SOURCE_STATE     — "is this voice free?" An engine allocates a voice by hunting
 *                         for one that is not AL_PLAYING (UE1's ALAudio Update does
 *                         exactly this). A source that can never leave AL_PLAYING takes
 *                         a voice out of circulation permanently, and 20 of them take
 *                         the whole subsystem out: every later PlaySound finds no voice.
 *   AL_BUFFERS_PROCESSED — "may I refill?" A streaming source's decode loop is
 *                         `while (processed--) { unqueue; decode; queue; }`. If the count
 *                         never rises during playback the loop never runs, the stream
 *                         stops after its first buffer, and nothing reports an error.
 *
 * Both are OUR bookkeeping, not the worklet's, so both can be wrong while every cursor
 * in the system looks healthy. These tests pin them against the spec'd transitions.
 */

import { test, expect, beforeEach } from "bun:test";
import { OpenAL } from "../../src/worker/modules/openal/openal";
import {
    getCtrl, setCtrl, CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, CTRL_BLOCK_BYTES,
    CTRL_FLAGS, FLAG_STREAMING,
} from "../../src/audio/audio-ring-buffer";

const AL_SOURCE_STATE = 0x1010;
const AL_BUFFERS_QUEUED = 0x1015;
const AL_BUFFERS_PROCESSED = 0x1016;
const AL_BUFFER = 0x1009;
const AL_PLAYING = 0x1012;
const AL_STOPPED = 0x1014;
const AL_FORMAT_MONO16 = 0x1101;

const MEM_BYTES = 1 << 20;
const SCRATCH = 0x1000;     // guest pointer used for every out-param / id array
const PCM = 0x40000;        // guest pointer the PCM payload lives at

let al: OpenAL;
let mem: Uint8Array;
let dv: DataView;

/** A Process stand-in: the module only allocates for the AL_* string exports. */
function fakeProcess(): any {
    let next = 0x80000;
    return {
        memory: { alloc: (n: number) => { const p = next; next += n + 16; return p; } },
        getCurrentMemory: () => mem,
    };
}

function call(name: string, ...args: number[]): number {
    const impl = al.exports[name];
    if (!impl) throw new Error(`no export ${name}`);
    return (impl as any)({}, mem, args) as number;
}

/** alGenSources/alGenBuffers write their ids into guest memory; read the first back. */
function gen(name: string): number {
    call(name, 1, SCRATCH);
    return dv.getUint32(SCRATCH, true);
}

function getSourcei(src: number, param: number): number {
    call("alGetSourcei", src, param, SCRATCH);
    return dv.getInt32(SCRATCH, true);
}

/** Fill a buffer with `bytes` of non-silent 16-bit mono PCM at 22050 Hz. */
function fillBuffer(bufId: number, bytes: number): void {
    for (let i = 0; i < bytes; i += 2) dv.setInt16(PCM + i, 1000, true);
    call("alBufferData", bufId, AL_FORMAT_MONO16, PCM, bytes, 22050);
}

function streamSab(src: number): SharedArrayBuffer {
    const s = (al as any).sources.get(src);
    if (!s?.stream) throw new Error("source has no streaming ring");
    return s.stream.sab as SharedArrayBuffer;
}

beforeEach(() => {
    (globalThis as any).postMessage = () => { /* audio_register/unregister sink */ };
    mem = new Uint8Array(MEM_BYTES);
    dv = new DataView(mem.buffer);
    al = new OpenAL();
    al.initialize(fakeProcess());
});

test("a source with nothing to play does not hold a voice in AL_PLAYING", () => {
    const src = gen("alGenSources");
    const buf = gen("alGenBuffers");          // generated, never filled → 0 bytes
    call("alSourcei", src, AL_BUFFER, buf);

    call("alSourcePlay", src);

    // Real OpenAL runs out of data immediately; the voice must come back free. Reporting
    // AL_PLAYING here is what wedges an engine that allocates by hunting for a free voice.
    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_STOPPED);
});

test("a streaming source retires buffers to AL_BUFFERS_PROCESSED as the worklet plays", () => {
    const src = gen("alGenSources");
    const a = gen("alGenBuffers");
    const b = gen("alGenBuffers");
    fillBuffer(a, 4096);
    fillBuffer(b, 4096);

    dv.setUint32(SCRATCH, a, true);
    dv.setUint32(SCRATCH + 4, b, true);
    call("alSourceQueueBuffers", src, 2, SCRATCH);
    call("alSourcePlay", src);

    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_PLAYING);
    expect(getSourcei(src, AL_BUFFERS_QUEUED)).toBe(2);
    expect(getSourcei(src, AL_BUFFERS_PROCESSED)).toBe(0);

    const sab = streamSab(src);
    // The ring is a streaming ring: the worklet must play up to the write cursor and
    // emit silence past it rather than wrapping onto stale bytes.
    expect(getCtrl(sab, CTRL_FLAGS) & FLAG_STREAMING).toBe(FLAG_STREAMING);
    // Both buffers fit, so the producer has handed the worklet all 8192 bytes.
    expect(getCtrl(sab, CTRL_WRITE_CURSOR)).toBe(8192);
    // ...and they are the PCM we supplied, laid down back to back with no gap.
    expect(new DataView(sab, CTRL_BLOCK_BYTES).getInt16(4096, true)).toBe(1000);

    // The worklet consumes the first buffer. THIS is the only thing that may retire it.
    setCtrl(sab, CTRL_PLAY_CURSOR, 4096);
    expect(getSourcei(src, AL_BUFFERS_PROCESSED)).toBe(1);
    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_PLAYING);

    // The app's refill loop: unqueue the processed one, refill it, queue it again.
    call("alSourceUnqueueBuffers", src, 1, SCRATCH);
    expect(dv.getUint32(SCRATCH, true)).toBe(a);
    expect(getSourcei(src, AL_BUFFERS_PROCESSED)).toBe(0);

    fillBuffer(a, 4096);
    dv.setUint32(SCRATCH, a, true);
    call("alSourceQueueBuffers", src, 1, SCRATCH);
    expect(getCtrl(sab, CTRL_WRITE_CURSOR)).toBe(12288);
    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_PLAYING);
});

test("a streaming source stops only when its queue is exhausted", () => {
    const src = gen("alGenSources");
    const a = gen("alGenBuffers");
    fillBuffer(a, 4096);

    dv.setUint32(SCRATCH, a, true);
    call("alSourceQueueBuffers", src, 1, SCRATCH);
    call("alSourcePlay", src);

    const sab = streamSab(src);
    setCtrl(sab, CTRL_PLAY_CURSOR, 2048);
    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_PLAYING);

    setCtrl(sab, CTRL_PLAY_CURSOR, 4096);
    expect(getSourcei(src, AL_BUFFERS_PROCESSED)).toBe(1);
    expect(getSourcei(src, AL_SOURCE_STATE)).toBe(AL_STOPPED);
});
