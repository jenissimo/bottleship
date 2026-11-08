
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { CTRL_BLOCK_BYTES, CTRL_FLAGS, CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, FLAG_STREAMING } from "../../src/audio/audio-ring-buffer";

const SIZE = 32768;
const RATE = 22050;
const BLOCK_ALIGN = 4;
const RING = 2 * SIZE;
const PTR = 0x1000;
const LOCK_WINDOW = 8;
const FLAGS = ["__noFrontierHold", "__noHostLatency", "__noCursorSmoothing", "__noCursorCatchup", "__noCursorStepCap"] as const;

type Buf = Record<string, unknown> & { sab: SharedArrayBuffer; bytes: number; frequency: number; isPlaying: boolean };
type Cursors = { playCursor: number; writeCursor: number };
type Ds = Record<string, (...a: unknown[]) => unknown> & { stepGapScratch: Float64Array };

let clock = 0;
const ownNow = Object.getOwnPropertyDescriptor(performance, "now");

beforeAll(() => {
    Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => clock });
});

afterAll(() => {
    if (ownNow) Object.defineProperty(performance, "now", ownNow);
    else delete (performance as unknown as Record<string, unknown>).now;
});

afterEach(() => {
    for (const f of FLAGS) delete (globalThis as Record<string, unknown>)[f];
    delete (globalThis as Record<string, unknown>).__detAudio;
});

function makeDs(mem: Uint8Array): Ds {
    const ds = Object.create(DSound.prototype) as Ds;
    ds.getMemory = () => mem;
    ds.stepGapScratch = new Float64Array(16);
    return ds;
}

function makeBuffer(): Buf {
    const sab = new SharedArrayBuffer(CTRL_BLOCK_BYTES + RING);
    return {
        id: 1, bytes: SIZE, ringBytes: RING, ptr: PTR, sab, frequency: RATE, flags: 0,
        isPlaying: true, isLooping: true, streamed: true, currentPosition: 0,
        format: { sampleRate: RATE, blockAlign: BLOCK_ALIGN, channels: 2, bitsPerSample: 16 },
    };
}

const ctrlOf = (b: Buf) => new Int32Array(b.sab, 0, 16);

function referenceCursors(ds: Ds, buffer: Buf): Cursors {
    const m = (name: string, ...a: unknown[]) => ds[name].call(ds, buffer, ...a) as number;
    if (!buffer.isPlaying) return m("getApiCursors") as unknown as Cursors;
    const format = buffer.format as { sampleRate: number; blockAlign: number };
    const blockAlign = Math.max(1, format.blockAlign);
    const premixMs = m("advancePremix", performance.now());
    const leadFrames = Math.max(64, Math.round((format.sampleRate * premixMs) / 1000));
    const half = Math.floor(buffer.bytes / 2);
    const leadTarget = Math.min(leadFrames * blockAlign, half - (half % blockAlign));
    const latency = m("hostLatencyBytes");
    const ring = m("ringSize");
    m("trailRing");
    m("syncFrontierHold");
    let playCursor: number;
    if ((globalThis as { __detAudio?: unknown }).__detAudio === true) {
        playCursor = m("deterministicPlayCursor") % buffer.bytes;
    } else {
        const raw = ((Atomics.load(ctrlOf(buffer), CTRL_PLAY_CURSOR) % ring) + latency) % ring;
        playCursor = referenceSmoothed(ds, buffer, raw, leadTarget, latency) % buffer.bytes;
    }
    const leadBytes = m("monotonicLeadBytes", playCursor, leadTarget);
    return { playCursor, writeCursor: (playCursor + leadBytes) % buffer.bytes };
}

function referenceSmoothed(ds: Ds, buffer: Buf, raw: number, leadBytes: number, latencyBytes: number): number {
    if ((globalThis as { __noCursorSmoothing?: boolean }).__noCursorSmoothing) {
        buffer.smoothRawCursor = undefined;
        buffer.stepLastCursor = raw;
        return raw;
    }
    const size = (buffer.ringBytes as number | undefined) ?? buffer.bytes;
    const format = buffer.format as { sampleRate: number; blockAlign: number };
    const blockAlign = Math.max(1, format.blockAlign);
    const hz = buffer.frequency > 0 ? buffer.frequency : format.sampleRate;
    const bytesPerMs = (hz * blockAlign * 1.1) / 1000;
    const now = performance.now();
    const ramp = (): number => {
        const from = buffer.smoothFromCursor as number;
        const gap = ((buffer.smoothRawCursor as number) - from + size) % size;
        const speed = gap > leadBytes / 2
            && !(globalThis as { __noCursorCatchup?: boolean }).__noCursorCatchup ? 2 : 1;
        const moved = Math.min(gap, (now - (buffer.smoothRawAtMs as number)) * bytesPerMs * speed);
        return (from + moved) % size;
    };
    let cursor: number;
    if (buffer.smoothRawCursor === undefined || bytesPerMs <= 0) {
        buffer.smoothFromCursor = (raw - latencyBytes + size) % size;
        buffer.smoothRawCursor = raw;
        buffer.smoothRawAtMs = now;
        cursor = buffer.smoothFromCursor as number;
    } else if (raw !== buffer.smoothRawCursor) {
        let from = ramp();
        const lag = (raw - from + size) % size;
        const maxLag = leadBytes + latencyBytes;
        if (lag > maxLag) from = (raw - maxLag + size) % size;
        buffer.smoothFromCursor = from;
        buffer.smoothRawCursor = raw;
        buffer.smoothRawAtMs = now;
        cursor = from;
    } else {
        cursor = ramp();
    }
    cursor = ds.capCursorStep.call(ds, buffer, cursor, now, (hz * blockAlign) / 1000) as number;
    return cursor - (cursor % blockAlign);
}

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function stateOf(buffer: Buf): string {
    return JSON.stringify(buffer, (k, v) => (k === "sab" ? undefined
        : v instanceof Float64Array ? Array.from(v) : v));
}

type Twin = { ds: Ds; buffer: Buf; mem: Uint8Array; query: () => Cursors };

function twins(): { ref: Twin; real: Twin } {
    const mk = (query: (ds: Ds, b: Buf) => Cursors): Twin => {
        const mem = new Uint8Array(PTR + SIZE);
        for (let i = 0; i < SIZE; i++) mem[PTR + i] = i & 0xff;
        const ds = makeDs(mem);
        const buffer = makeBuffer();
        return { ds, buffer, mem, query: () => query(ds, buffer) };
    };
    return {
        ref: mk(referenceCursors),
        real: mk((ds, b) => ds.getApiCursors.call(ds, b) as Cursors),
    };
}

function both(t: { ref: Twin; real: Twin }, f: (x: Twin) => void): void {
    f(t.ref);
    f(t.real);
}

function runScenario(seed: number, steps: number, skewMs = 0): { mismatches: number; queries: number; repeats: number } {
    const t = twins();
    const r = rng(seed);
    let raw = 0;
    let mismatches = 0;
    let queries = 0;
    let repeats = 0;
    clock = 1000;
    for (let i = 0; i < steps; i++) {
        const p = r();
        if (p < 0.35) {
            repeats++;
        } else if (p < 0.6) {
            clock += r() * 0.02;
        } else if (p < 0.8) {
            clock += r() * 12;
        } else if (p < 0.88) {
            raw = (raw + 128 * BLOCK_ALIGN * (1 + Math.floor(r() * 4))) % RING;
            both(t, x => Atomics.store(ctrlOf(x.buffer), CTRL_PLAY_CURSOR, raw));
        } else if (p < 0.92) {
            const size = BLOCK_ALIGN * (256 + Math.floor(r() * 2048));
            both(t, x => {
                const ring = (x.buffer.stepLockSizes as Float64Array | undefined)
                    ?? (x.buffer.stepLockSizes = new Float64Array(LOCK_WINDOW));
                const count = (x.buffer.stepLockCount as number | undefined) ?? 0;
                ring[count % LOCK_WINDOW] = size;
                x.buffer.stepLockCount = count + 1;
            });
        } else if (p < 0.94) {
            both(t, x => x.ds.signalRemix.call(x.ds, x.buffer));
        } else if (p < 0.95) {
            const hz = [RATE, 11025, 44100, 0][Math.floor(r() * 4)];
            both(t, x => { x.buffer.frequency = hz; });
        } else if (p < 0.96) {
            const flag = FLAGS[Math.floor(r() * FLAGS.length)];
            const g = globalThis as Record<string, unknown>;
            g[flag] = !g[flag];
        } else if (p < 0.97) {
            both(t, x => x.ds.resyncRing.call(x.ds, x.buffer));
        } else if (p < 0.975) {
            both(t, x => {
                x.buffer.isPlaying = !x.buffer.isPlaying;
                if (x.buffer.isPlaying) {
                    x.buffer.smoothRawCursor = undefined;
                    x.buffer.stepLastCursor = undefined;
                }
            });
        } else if (p < 0.98) {
            const s = !t.real.buffer.streamed;
            both(t, x => { x.buffer.streamed = s; });
        } else if (p < 0.985) {
            const at = Math.floor(r() * SIZE);
            both(t, x => { x.mem[PTR + at] ^= 0x5a; });
        } else if (p < 0.99) {
            both(t, x => { Atomics.and(ctrlOf(x.buffer), CTRL_FLAGS, ~FLAG_STREAMING); });
        } else if (p < 0.993) {
            both(t, x => { x.buffer.smoothRawCursor = undefined; });
        } else if (p < 0.996) {
            both(t, x => { x.buffer.stepLastCursor = undefined; });
        } else {
            both(t, x => {
                x.buffer.reportedLeadBytes = undefined;
                x.buffer.lastReportedPlayCursor = undefined;
            });
        }
        const a = t.ref.query();
        clock += skewMs;
        const b = t.real.query();
        clock -= skewMs;
        queries++;
        if (a.playCursor !== b.playCursor || a.writeCursor !== b.writeCursor
            || stateOf(t.ref.buffer) !== stateOf(t.real.buffer)
            || Atomics.load(ctrlOf(t.ref.buffer), CTRL_FLAGS) !== Atomics.load(ctrlOf(t.real.buffer), CTRL_FLAGS)
            || Atomics.load(ctrlOf(t.ref.buffer), CTRL_WRITE_CURSOR) !== Atomics.load(ctrlOf(t.real.buffer), CTRL_WRITE_CURSOR)) {
            mismatches++;
        }
    }
    const ringA = new Uint8Array(t.ref.buffer.sab, CTRL_BLOCK_BYTES);
    const ringB = new Uint8Array(t.real.buffer.sab, CTRL_BLOCK_BYTES);
    for (let i = 0; i < RING; i++) if (ringA[i] !== ringB[i]) { mismatches++; break; }
    return { mismatches, queries, repeats };
}

describe("dsound GetCurrentPosition reuse", () => {
    test("matches the full computation at every query, cursors and state alike", () => {
        for (const seed of [1, 2, 3, 0xdead, 0xbeef, 77]) {
            const { mismatches, queries, repeats } = runScenario(seed, 6000);
            expect(queries).toBe(6000);
            expect(repeats).toBeGreaterThan(1000);
            expect(mismatches).toBe(0);
        }
    });

    test("negative control: a clock skew between the twins is caught", () => {
        expect(runScenario(1, 2000, 0.003).mismatches).toBeGreaterThan(0);
    });

    test("repeats at one time compute once", () => {
        const { real } = twins();
        clock = 5000;
        Atomics.store(ctrlOf(real.buffer), CTRL_PLAY_CURSOR, 4096);
        const proto = DSound.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
        const original = proto.smoothedPlayCursor;
        let computed = 0;
        proto.smoothedPlayCursor = function (this: unknown, ...a: unknown[]) {
            computed++;
            return original.apply(this, a);
        };
        try {
            const first = real.query();
            for (let i = 0; i < 50; i++) expect(real.query()).toEqual(first);
            expect(computed).toBe(1);
            clock += 0.005;
            real.query();
            expect(computed).toBe(2);
        } finally {
            proto.smoothedPlayCursor = original;
        }
    });

    test("negative control: a change at the same time is not answered from the previous query", () => {
        const changes: Array<(x: Twin) => void> = [
            () => { (globalThis as Record<string, unknown>).__noCursorSmoothing = true; },
            x => { x.buffer.isLooping = false; },
            x => { x.buffer.ringBytes = SIZE; },
            x => { x.buffer.bytes = SIZE / 4; },
            x => { x.buffer.format = { sampleRate: 44100, blockAlign: 2, channels: 1, bitsPerSample: 16 }; },
        ];
        for (const change of changes) {
            const { ref, real } = twins();
            clock = 5000;
            both({ ref, real }, x => Atomics.store(ctrlOf(x.buffer), CTRL_PLAY_CURSOR, 4096));
            ref.query();
            real.query();
            clock += 40;
            both({ ref, real }, x => Atomics.store(ctrlOf(x.buffer), CTRL_PLAY_CURSOR, 4096 + 3528));
            ref.query();
            const before = real.query();
            change(ref);
            change(real);
            const expected = ref.query();
            expect(expected).not.toEqual(before);
            expect(real.query()).toEqual(expected);
            delete (globalThis as Record<string, unknown>).__noCursorSmoothing;
        }
    });
});
