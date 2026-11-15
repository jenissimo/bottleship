/** Bounded, opt-in completed-present work evidence; no game logic or GPU completion claim. */
import {
    CMD_I32, CMD_F32, VERT_FLOATS, GLDrawCommandType, CI_TYPE, CI_VERT_OFFSET,
    CI_VERT_COUNT, CI_FLAGS, CI_SCISSOR_X, CI_VP_X, DF_FOG, type OpenGLContext,
} from './context';

export interface GLWorkExecutorAudit {
    encodedDraws: number; encodedVertices: number; submissions: number; fallback: boolean;
}
export interface GLCounterSample { value: number | null; unavailable: string | null; }
export interface GLWorkFrame extends GLWorkExecutorAudit {
    frame: number; hostSerialBefore: number | null; hostSerialAfter: number | null;
    commands: number; types: number[]; draws: number; vertices: number;
    digest: string | null; executorCalled: boolean; returned: boolean; error: string | null;
    counterBegin: GLCounterSample | null; counterEnd: GLCounterSample | null;
}
export interface GLWorkOptions { startFrame?: number; frames?: number; hash?: boolean; counterAddress?: number; }
/** Never read a stale/detached memory view or substitute zero for an unavailable dword. */
function counter(ctx: OpenGLContext | null, address: number): GLCounterSample {
    try {
        const p = ctx?.process, mem = p?.getCurrentMemory?.();
        if (!p || !mem || mem.buffer.byteLength === 0 || address + 4 > mem.byteLength) return { value: null, unavailable: 'current memory extent unavailable' };
        if (p.addressSpace?.validateRange(address, 4, 'r') !== true) return { value: null, unavailable: 'guest range is not readable' };
        if (p.pageTableManager?.isRangeAccessible?.(address, 4, false) === false) return { value: null, unavailable: 'guest page is inaccessible' };
        return { value: new DataView(mem.buffer, mem.byteOffset + address, 4).getUint32(0, true), unavailable: null };
    } catch (e) { return { value: null, unavailable: String(e) }; }
}
const MAX_FRAMES = 4096;
const MAX_WORDS = 16_000_000;

/** A non-cryptographic 64-bit fingerprint of canonical u32 words, plus independent counts.
 * Not a security hash, pixel proof, texture-content hash, or GPU execution timestamp. */
class WordHash {
    a = 0x811c9dc5; b = 0x9e3779b9;
    add(x: number): void {
        this.a = Math.imul(this.a ^ x, 0x01000193) >>> 0;
        this.b = (Math.imul(this.b ^ x, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
    }
    hex(): string { return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0'); }
}
function canonical(ctx: OpenGLContext, hash: boolean) {
    const s = ctx.commands, I = s.i32, F = s.f32, arena = ctx.vertArena;
    if (!Number.isSafeInteger(s.count) || s.count < 0 || s.count * CMD_I32 > I.length || s.count * CMD_F32 > F.length) throw new Error('invalid command extent');
    const types = [0, 0, 0, 0], h = hash ? new WordHash() : null;
    // Typed views preserve exact F32 bits (including signed zero), not rounded min/max.
    const fb = hash ? new Uint32Array(F.buffer, F.byteOffset, F.length) : null;
    const vb = hash ? new Uint32Array(arena.data.buffer, arena.data.byteOffset, arena.data.length) : null;
    let draws = 0, vertices = 0, words = 0;
    for (let c = 0; c < s.count; c++) {
        const i = c * CMD_I32, f = c * CMD_F32, type = I[i + CI_TYPE]!;
        if (type < 0 || type > 3) throw new Error('unknown command type');
        types[type]++; h?.add(type);
        words += CMD_I32 + CMD_F32;
        if (words > MAX_WORDS) throw new Error('per-frame word limit exceeded');
        if (type === GLDrawCommandType.DRAW) {
            const off = I[i + CI_VERT_OFFSET]!, n = I[i + CI_VERT_COUNT]!;
            if (!Number.isSafeInteger(n) || n < 0 || off < 0 || off % VERT_FLOATS !== 0 || off + n * VERT_FLOATS > arena.used || arena.used > arena.data.length) throw new Error('invalid draw vertex extent');
            draws++; vertices += n; words += n * 16;
            if (words > MAX_WORDS) throw new Error('per-frame word limit exceeded');
            if (!h) continue;
            // Arena offsets are storage, not work. Referenced data follows in draw order.
            for (let k = 1; k < CMD_I32; k++) if (k !== CI_VERT_OFFSET) h.add(I[i + k]!);
            for (let k = 0; k < CMD_F32; k++) h.add(fb![f + k]!);
            for (let v = 0; v < n; v++) {
                const b = off + v * VERT_FLOATS;
                for (let k = 0; k < VERT_FLOATS; k++) {
                    if (k === 9 || k === 10) continue; // normals are not GPU attributes
                    h.add(k === 8 && !(I[i + CI_FLAGS]! & DF_FOG) ? 0 : vb![b + k]!);
                }
            }
        } else if (h && type === GLDrawCommandType.CLEAR) {
            h.add(I[i + 1]!); h.add(I[i + 2]!);
            for (let k = 0; k < 5; k++) h.add(fb![f + k]!);
        } else if (h) {
            const first = type === GLDrawCommandType.SCISSOR ? CI_SCISSOR_X : CI_VP_X;
            for (let k = first; k < first + 4; k++) h.add(I[i + k]!);
        }
    }
    return { commands: s.count, types, draws, vertices, digest: h?.hex() ?? null };
}

export class GLWorkWindow {
    readonly startFrame: number;
    readonly endFrame: number;
    readonly hashing: boolean;
    readonly counterAddress: number | null;
    private counterContext: OpenGLContext | null = null;
    status: 'armed' | 'complete' | 'failed' | 'off' = 'armed';
    failure: string | null = null;
    readonly rows: GLWorkFrame[] = [];
    constructor(currentFrame: number, opts: GLWorkOptions = {}) {
        this.startFrame = opts.startFrame ?? currentFrame + 1;
        const n = opts.frames ?? 1;
        if (!Number.isSafeInteger(currentFrame) || !Number.isSafeInteger(this.startFrame) || this.startFrame <= currentFrame || !Number.isSafeInteger(n) || n < 1 || n > MAX_FRAMES || !Number.isSafeInteger(this.startFrame + n - 1)) throw new Error('future absolute startFrame and 1..4096 frames required');
        this.endFrame = this.startFrame + n - 1;
        if (opts.hash !== undefined && typeof opts.hash !== 'boolean') throw new Error('hash must be boolean');
        this.hashing = opts.hash !== false;
        const address = opts.counterAddress;
        if (address !== undefined && (!Number.isSafeInteger(address) || address < 0x10000 || address > 0xfffffffc || address % 4 !== 0)) throw new Error('aligned readable user dword address required');
        this.counterAddress = address ?? null;
    }
    begin(ctx: OpenGLContext, hostSerial: number | null): GLWorkFrame | undefined {
        if (this.status !== 'armed' || ctx.frameId < this.startFrame) return;
        const previous = this.rows.at(-1);
        if (previous && previous.hostSerialAfter !== hostSerial) { this.fail('host presents occurred between selected GL frames'); return; }
        const expected = this.startFrame + this.rows.length;
        if (ctx.frameId !== expected) { this.fail('present gap or duplicate: expected ' + expected + ', got ' + ctx.frameId); return; }
        try {
            const work = canonical(ctx, this.hashing);
            const row: GLWorkFrame = { frame: ctx.frameId, hostSerialBefore: hostSerial, hostSerialAfter: null,
                ...work, encodedDraws: 0, encodedVertices: 0, submissions: 0, fallback: false,
                executorCalled: false, returned: false, error: null,
                counterBegin: this.counterAddress === null ? null : counter(ctx, this.counterAddress), counterEnd: null };
            this.counterContext = ctx;
            this.rows.push(row); return row;
        } catch (e) { this.fail(String(e)); return; }
    }
    finish(row: GLWorkFrame, hostSerial: number | null): void {
        if (this.status !== 'armed' || this.rows.at(-1) !== row) return;
        row.hostSerialAfter = hostSerial;
        row.counterEnd = this.counterAddress === null ? null : counter(this.counterContext, this.counterAddress);
        if (!row.executorCalled || !row.returned || row.error || row.submissions === 0) this.fail('frame was not successfully submitted');
        else if (hostSerial === null || row.hostSerialBefore === null || hostSerial !== row.hostSerialBefore + 1) this.fail('host present serial is unavailable or discontinuous');
        else if (row.frame === this.endFrame) this.status = 'complete';
    }
    fail(reason: string): void { this.status = 'failed'; this.failure = reason; }
    read() {
        const coverage = { unavailable: 0, duplicates: 0, regressions: 0, saturated: 0, changedWithinFrame: 0 };
        let previous: number | null = null;
        if (this.counterAddress !== null) for (const row of this.rows) {
            const a = row.counterBegin?.value ?? null, b = row.counterEnd?.value ?? null;
            if (a === null || b === null) coverage.unavailable++;
            if (a === 0xffffffff || b === 0xffffffff) coverage.saturated++;
            if (a !== null && b !== null && a !== b) coverage.changedWithinFrame++;
            if (previous !== null && a !== null) { if (a === previous) coverage.duplicates++; if (a < previous) coverage.regressions++; }
            previous = b;
        }
        return { status: this.status, failure: this.failure, startFrame: this.startFrame, endFrame: this.endFrame,
            hashing: this.hashing, observer: 'GL work digest; instrumented when armed; submission is not GPU completion',
            textureContentsIncluded: false, engineFramesInferred: false, counterAddress: this.counterAddress, counterCoverage: coverage,
            frames: this.rows.map(r => ({ ...r, types: [...r.types], counterBegin: r.counterBegin ? { ...r.counterBegin } : null, counterEnd: r.counterEnd ? { ...r.counterEnd } : null })) };
    }
}
/** @transient(harness observer, never guest/save state) */
let active: { ctx: OpenGLContext; window: GLWorkWindow } | null = null;
export function armGLWorkDigest(ctx: OpenGLContext, opts: GLWorkOptions = {}) {
    if (active?.window.status === 'armed') throw new Error('work digest already armed; explicitly off first');
    const window = new GLWorkWindow(ctx.frameId, opts);
    active = { ctx, window }; return window.read();
}
export function beginGLWorkPresent(ctx: OpenGLContext, hostSerial: number | null): GLWorkFrame | undefined {
    // The ordinary unarmed path does not inspect ctx, create views, hash, or allocate.
    if (!active || active.ctx !== ctx || active.window.status !== 'armed') return;
    return active.window.begin(ctx, hostSerial);
}
export function finishGLWorkPresent(row: GLWorkFrame | undefined, hostSerial: number | null): void {
    if (row) active?.window.finish(row, hostSerial);
}
export function failGLWorkPresent(row: GLWorkFrame | undefined, reason: unknown): void {
    if (!row) return;
    row.error = String(reason);
    active?.window.fail(row.error);
}
export function readGLWorkDigest(ctx: OpenGLContext) {
    if (!active || active.ctx !== ctx) return { status: 'off' as const, frames: [] };
    return active.window.read();
}
/** Compare complete windows in relative-present order, never their timing/global frame IDs.
 * Engine-frame alignment and selected-frame pixels remain independent required controls. */
export function compareGLWorkDigests(a: ReturnType<GLWorkWindow['read']>, b: ReturnType<GLWorkWindow['read']>) {
    const failures: string[] = [];
    if (a.status !== 'complete' || b.status !== 'complete') failures.push('both windows must be complete');
    if (!a.hashing || !b.hashing) failures.push('canonical hashing must be enabled in both windows');
    if (a.frames.length === 0 || a.frames.length !== b.frames.length) failures.push('nonempty frame counts differ');
    const fields = ['commands', 'draws', 'vertices', 'digest', 'encodedDraws', 'encodedVertices', 'submissions', 'fallback'] as const;
    for (let f = 0; f < Math.min(a.frames.length, b.frames.length); f++) {
        const x = a.frames[f]!, y = b.frames[f]!;
        for (const k of fields) if (x[k] !== y[k]) failures.push('frame ' + f + ': ' + k + ' differs');
        if (x.types.some((n, k) => n !== y.types[k])) failures.push('frame ' + f + ': command types differ');
        if (x.error || y.error || !x.returned || !y.returned) failures.push('frame ' + f + ': executor failure');
    }
    return { equal: failures.length === 0, failures,
        scope: 'relative GL-present command/vertex/state fingerprint and independently encoded/submitted counts; not pixels, texture bytes, GPU completion or engine-frame alignment' };
}
export function offGLWorkDigest() {
    const prior = active?.window.read() ?? null; active = null;
    return { status: 'off' as const, prior };
}
