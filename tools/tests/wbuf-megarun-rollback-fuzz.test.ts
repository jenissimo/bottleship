/**
 * MegaRun rollback fuzz — the architectural precondition for the fused drain.
 *
 * `drainWriteBuffer` has a fast path that recognises one producer shape (a constant, a
 * short run of ordinary setters, a draw, then an alternating constant/draw run) and hands
 * the whole thing to a fused consumer. The consumer may DECLINE, and the decline is a
 * transaction rollback: every entry the fast path had already applied must be applied
 * exactly once, the ones it had not must be applied by the ordinary handlers in order, and
 * the ring cursor must resume at the exact entry that was not consumed.
 *
 * That rule was derived from ONE observed producer sequence. This test replaces the
 * observation with a search: it emits random producer sequences and requires that the
 * LOGICAL LEDGER — which handler saw which argument words, in what order — is identical
 * whether the fusion is off, always accepting, or declining at random. A fast path derived
 * from one shape cannot be trusted on shapes nobody wrote down, and a wrong rollback is
 * invisible at runtime: it duplicates or drops a state set, and the frame merely looks
 * slightly wrong.
 *
 * Deliberately NOT a d3d9 test. The rollback contract lives in the dispatcher and is what
 * every future fusion (the generated WBUF grammar, the arena draw front) inherits; testing
 * it through the D3D9 consumer would tie it to that consumer's own correctness.
 */

import { describe, it, expect } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const RING_CTRL = 0x3000;
const RING_DATA = 0x4000;
const RING_CAP = 0x8000;

/** Ring vocabulary. `argCount` is the entry's payload width in dwords. */
const FN = {
    /** The pair-run FIRST id (a shader-constant-shaped setter). */
    CONST: { id: 40, name: 'Fake_SetConstant', argCount: 3, barrier: false },
    /** Ordinary non-barrier setters — the prefix the fast path is allowed to absorb. */
    SET_A: { id: 41, name: 'Fake_SetA', argCount: 2, barrier: false },
    SET_B: { id: 42, name: 'Fake_SetB', argCount: 4, barrier: false },
    /** The pair-run SECOND id (a draw, and therefore a barrier). */
    DRAW: { id: 43, name: 'Fake_Draw', argCount: 5, barrier: true },
    /** A barrier that is NOT part of any pair — must always break a run. */
    OTHER_DRAW: { id: 44, name: 'Fake_OtherDraw', argCount: 3, barrier: true },
} as const;
type FnSpec = (typeof FN)[keyof typeof FN];
const ALL: FnSpec[] = Object.values(FN);

/** One applied operation, as the ordinary (slow) path would record it. */
interface LedgerEntry { id: number; args: number[]; }

interface Arm {
    /** Ledger of logical operations, in application order. */
    ledger: LedgerEntry[];
    /** Ring cursor after the drain. */
    tail: number;
    /** How many times the fused consumer accepted. */
    fused: number;
    /** How many times it declined. */
    declined: number;
}

function stubsFor(): Array<{
    dllName: string; functionName: string; functionId: number; address: number;
    argCount: number; stackCleanupBytes: number;
}> {
    return ALL.map((f, i) => ({
        dllName: 'fake', functionName: f.name, functionId: f.id,
        address: 0x1000 + i * 0x20, argCount: f.argCount, stackCleanupBytes: f.argCount * 4,
    }));
}

function mkDispatcher(mem: Uint8Array): any {
    const stubs = stubsFor();
    const generator = {
        findStubsByName: (dll: string, fn: string) => stubs.filter(s =>
            s.dllName.toLowerCase() === dll.toLowerCase() && s.functionName.toLowerCase() === fn.toLowerCase()),
        getAllStubs: () => stubs,
        getStubById: (id: number) => stubs.find(s => s.functionId === id),
    };
    const d = new ThunkDispatcher({ add_listener: () => { } } as any, generator as any) as any;
    d.cachedMem8 = mem;
    d.cachedDataView = new DataView(mem.buffer);
    d.cachedMem32 = new Uint32Array(mem.buffer, 0, mem.byteLength >>> 2);
    d.cachedWasmBuffer = mem.buffer;
    d.cachedReg32Raw = new Int32Array(mem.buffer, 64, 8);
    d.memLength = mem.length;
    d.writeBufControlAddr = RING_CTRL;
    d.writeBufDataBase = RING_DATA;
    d.writeBufCapacity = RING_CAP;
    // Every trampoline slot the registration path may consult.
    for (let i = 0; i < 32; i++) d.writeBufTrampolineAddrs[i] = 0x2000 + i * 0x40;
    return d;
}

/** A producer sequence: ids to lay into the ring, with deterministic payloads. */
function emit(mem: Uint8Array, seq: FnSpec[]): { head: number; expected: LedgerEntry[] } {
    const m32 = new Uint32Array(mem.buffer);
    const expected: LedgerEntry[] = [];
    let off = 0;
    let seed = 0x1234_5678;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (const f of seq) {
        m32[(RING_DATA + off) >> 2] = f.id;
        const args: number[] = [];
        for (let a = 0; a < f.argCount; a++) {
            const v = next();
            m32[(RING_DATA + off + 4 + a * 4) >> 2] = v;
            args.push(v);
        }
        expected.push({ id: f.id, args });
        off += (f.argCount + 1) * 4;
    }
    m32[RING_CTRL >> 2] = off;
    return { head: off, expected };
}

/**
 * Run one drain.
 *
 * `fusion`: 'off' registers no pair binding at all (the ordinary path, and the reference);
 * 'accept' fuses every eligible run; 'decline' declines on a deterministic schedule so the
 * rollback path is what runs. A fused consumer records the SAME logical operations it
 * subsumes, so the three ledgers are directly comparable — which is the whole point: a
 * fusion that is correct is one nobody downstream can tell apart.
 */
function runDrain(seq: FnSpec[], fusion: 'off' | 'accept' | 'decline', declineEvery = 1): Arm {
    const mem = new Uint8Array(0x20000);
    const d = mkDispatcher(mem);
    const ledger: LedgerEntry[] = [];
    let fused = 0, declined = 0;

    const readArgs = (dataPtr: number, argCount: number): number[] => {
        const m32 = new Uint32Array(mem.buffer);
        const out: number[] = [];
        for (let a = 0; a < argCount; a++) out.push(m32[(dataPtr + a * 4) >> 2] >>> 0);
        return out;
    };
    for (const f of ALL) {
        d.registerWriteBufferFunction('fake', f.name, f.argCount,
            (_m8: Uint8Array, _m32: Uint32Array, dataPtr: number) => {
                ledger.push({ id: f.id, args: readArgs(dataPtr, f.argCount) });
            }, true, 0, { barrier: f.barrier });
    }

    if (fusion !== 'off') {
        let calls = 0;
        d.registerWriteBufferPairRun('fake', FN.CONST.name, 'fake', FN.DRAW.name,
            (_m8: Uint8Array, m32: Uint32Array, startPtr: number, endPtr: number, _pairs: number,
                prefixConstPtr?: number, prefixDrawPtr?: number): boolean => {
                const accept = fusion === 'accept' || (++calls % declineEvery !== 0);
                if (!accept) { declined++; return false; }
                fused++;
                // Replicate, as logical operations, exactly what the fast path handed over:
                // the prefix draw (instance zero) when this is the prefix form, then the
                // alternating run. The prefix CONSTANT and the middle setters were already
                // applied by the drain before the consumer was called — recording them here
                // too would double-count them, which is itself a thing to get wrong.
                if (prefixDrawPtr !== undefined && prefixDrawPtr >= 0) {
                    ledger.push({ id: FN.DRAW.id, args: readArgs(prefixDrawPtr + 4, FN.DRAW.argCount) });
                }
                let p = startPtr;
                while (p < endPtr) {
                    const id = m32[p >> 2] >>> 0;
                    const spec = ALL.find(f => f.id === id);
                    if (!spec) throw new Error(`fused run contains unknown id ${id}`);
                    ledger.push({ id, args: readArgs(p + 4, spec.argCount) });
                    p += (spec.argCount + 1) * 4;
                }
                if (p !== endPtr) throw new Error('fused run does not end on an entry boundary');
                return true;
            });
    }

    emit(mem, seq);
    d.drainWriteBuffer();
    return { ledger, tail: d.wbufTail, fused, declined };
}

/** A deterministic LCG so a failure names a reproducible seed. */
function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
}

function randomSequence(seed: number, len: number): FnSpec[] {
    const r = rng(seed);
    const out: FnSpec[] = [];
    for (let i = 0; i < len; i++) {
        const roll = r();
        // Weighted so the fusable shape (CONST/DRAW alternation) is common but never the
        // only thing generated — a fuzz that only produces the shape the fast path was
        // written for proves nothing about the shapes it must decline.
        out.push(
            roll < 0.34 ? FN.CONST :
                roll < 0.66 ? FN.DRAW :
                    roll < 0.78 ? FN.SET_A :
                        roll < 0.90 ? FN.SET_B :
                            FN.OTHER_DRAW);
    }
    return out;
}

const same = (a: LedgerEntry[], b: LedgerEntry[]): boolean =>
    a.length === b.length && a.every((e, i) =>
        e.id === b[i].id && e.args.length === b[i].args.length
        && e.args.every((v, j) => v === b[i].args[j]));

const show = (l: LedgerEntry[]) => l.map(e => `${e.id}(${e.args.join(',')})`).join(' ');

describe('WBUF pair-run fusion — the ledger is identical however the run is consumed', () => {
    it('the fixture really exercises the fast path (else the comparison is vacuous)', () => {
        // The canonical prefix shape: constant, setter, draw, then an alternating run.
        const seq = [FN.CONST, FN.SET_A, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW];
        const accepted = runDrain(seq, 'accept');
        expect(accepted.fused).toBeGreaterThan(0);
        const declinedArm = runDrain(seq, 'decline', 1);
        expect(declinedArm.declined).toBeGreaterThan(0);
    });

    it('accepting the fusion applies exactly what the ordinary path would', () => {
        const seq = [FN.CONST, FN.SET_A, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW];
        const off = runDrain(seq, 'off');
        const on = runDrain(seq, 'accept');
        expect(show(on.ledger)).toBe(show(off.ledger));
        expect(on.tail).toBe(off.tail);
    });

    it('declining rolls back to the exact entry — nothing applied twice, nothing dropped', () => {
        const seq = [FN.CONST, FN.SET_A, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW];
        const off = runDrain(seq, 'off');
        const declinedArm = runDrain(seq, 'decline', 1);
        expect(show(declinedArm.ledger)).toBe(show(off.ledger));
        expect(declinedArm.tail).toBe(off.tail);
    });

    it('600 random producer sequences agree across all three arms', () => {
        let sawFusion = 0, sawDecline = 0;
        for (let seed = 1; seed <= 600; seed++) {
            const len = 2 + (seed % 23);
            const seq = randomSequence(seed, len);
            const off = runDrain(seq, 'off');
            const accept = runDrain(seq, 'accept');
            const decline = runDrain(seq, 'decline', 1);
            const mixed = runDrain(seq, 'decline', 2);
            sawFusion += accept.fused;
            sawDecline += decline.declined + mixed.declined;
            for (const [name, arm] of [['accept', accept], ['decline', decline], ['mixed', mixed]] as const) {
                if (!same(arm.ledger, off.ledger)) {
                    throw new Error(
                        `seed ${seed} (${name}): ledger differs\n  slow:  ${show(off.ledger)}\n  fused: ${show(arm.ledger)}`);
                }
                if (arm.tail !== off.tail) {
                    throw new Error(`seed ${seed} (${name}): tail ${arm.tail} != ${off.tail}`);
                }
            }
        }
        // A green run over sequences that never reached the fast path would be a pass that
        // measured nothing.
        expect(sawFusion).toBeGreaterThan(50);
        expect(sawDecline).toBeGreaterThan(50);
    });

    it('a consumer that THROWS is a decline, not a hole in the ledger', () => {
        // The drain applies the prefix constant and setters before calling the consumer, so
        // an exception must not unwind past them or they are replayed on the retry.
        const seq = [FN.CONST, FN.SET_A, FN.DRAW, FN.CONST, FN.DRAW, FN.CONST, FN.DRAW];
        const mem = new Uint8Array(0x20000);
        const d = mkDispatcher(mem);
        const ledger: LedgerEntry[] = [];
        const m32all = new Uint32Array(mem.buffer);
        for (const f of ALL) {
            d.registerWriteBufferFunction('fake', f.name, f.argCount,
                (_m8: Uint8Array, _m32: Uint32Array, dataPtr: number) => {
                    const args: number[] = [];
                    for (let a = 0; a < f.argCount; a++) args.push(m32all[(dataPtr + a * 4) >> 2] >>> 0);
                    ledger.push({ id: f.id, args });
                }, true, 0, { barrier: f.barrier });
        }
        d.registerWriteBufferPairRun('fake', FN.CONST.name, 'fake', FN.DRAW.name,
            (): boolean => { throw new Error('synthetic consumer failure'); });
        emit(mem, seq);
        expect(() => d.drainWriteBuffer()).not.toThrow();
        const off = runDrain(seq, 'off');
        expect(show(ledger)).toBe(show(off.ledger));
        expect(d.wbufTail).toBe(off.tail);
    });
});
