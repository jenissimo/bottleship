// The guest-side Texture9::AddRef stub and — more importantly — its oracle.
//
// A byte-identity snapshot (thunk-stub-emitters.test.ts) proves the codegen did not CHANGE.
// It cannot say what the bytes MEAN, and it cannot say whether the oracle that is supposed to
// police them is wired up at all. Both have gone wrong in this project the same way: a verify
// flag declared, never applied, and an oracle that reported `checked: 0` while everything read
// as passing. So every assertion below is either "this exact instruction is/isn't in the
// emitted body" or "make the oracle disagree and watch it say so".

import { describe, it, expect, afterEach } from 'bun:test';
import { writeIncRefStubTrampoline } from '../../src/worker/modules/d3d9/capture-trampolines';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';
import {
    registerGuestAddRefStub,
    publishTexture9Vtable,
    guestAddRefOracleActive,
    noteGuestAddRefOracle,
    d3d9GuestAddRefStats,
    resetGuestAddRefStubForTests,
} from '../../src/worker/modules/d3d9/guest-addref-stub';

const MEM_SIZE = 1 << 20;
const EXPECT_VTABLE = 0x20400;
const PREDICT = 0x20100;

function mkCtx(): { mem: Uint8Array; getMemory: () => Uint8Array; allocator: StubAllocator } {
    const mem = new Uint8Array(MEM_SIZE);
    let bump = 0x1000;
    const allocator: StubAllocator = {
        alloc(size: number): number {
            const addr = bump;
            bump = (bump + size + 15) & ~15;
            return addr;
        },
    };
    return { mem, getMemory: () => mem, allocator };
}

/** Byte-sequence search inside an emitted region. */
function findBytes(mem: Uint8Array, base: number, end: number, needle: number[]): number {
    outer: for (let i = base; i <= end - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (mem[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}
const imm32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

const g = globalThis as Record<string, unknown>;
function clearFlags(): void {
    delete g.__d3d9GuestAddRefStub;
    delete g.__d3d9AddRefStubVerify;
    delete g.__d3d9GuestRefcount;
}

afterEach(() => {
    clearFlags();
    resetGuestAddRefStubForTests();
});

describe('guest AddRef stub — what the emitted bytes actually do', () => {
    it('the live body increments the object and returns the new count', () => {
        const ctx = mkCtx();
        const r = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        // inc dword [ecx+4] ; mov eax,[ecx+4] — the whole method.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xFF, 0x41, 0x04])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x41, 0x04])).toBeGreaterThan(0);
        // ret 4 — stdcall cleanup for AddRef(this).
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xC2, 0x04, 0x00])).toBeGreaterThan(0);
    });

    it('it refuses any `this` whose vptr is not the published vtable', () => {
        const ctx = mkCtx();
        const r = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        // mov edx,[ecx] ; cmp edx,[expectVtableAddr] — the stale/recycled-pointer gate. Without
        // it a stale dispatch would silently increment whatever now owns the block.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x11])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0x3B, 0x15, ...imm32(EXPECT_VTABLE)])).toBeGreaterThan(0);
        // …and the OUT trap is still reachable as the fallback (mov edx,0xB077; out dx,eax).
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xBA, ...imm32(0xB077), 0xEF])).toBeGreaterThan(0);
    });

    it('the VERIFY body mutates nothing — it predicts and still traps', () => {
        const ctx = mkCtx();
        const r = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE, predictAddr: PREDICT });
        // An oracle that also incremented would be measuring itself: no `inc [ecx+4]` may exist.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xFF, 0x41, 0x04])).toBe(-1);
        // It reads the count, adds one, publishes it, and marks the prediction valid.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x51, 0x04, 0x42])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0x89, 0x15, ...imm32(PREDICT)])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xC6, 0x05, ...imm32(PREDICT + 4), 0x01])).toBeGreaterThan(0);
        // …and clears validity on entry, so a call that never reaches the compare cannot be
        // read as this call's verdict.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xC6, 0x05, ...imm32(PREDICT + 4), 0x00])).toBeGreaterThan(0);
    });
});

describe('guest AddRef stub — installation refuses what it cannot make safe', () => {
    function fakeDispatcher() {
        const calls: Array<{ fn: string; spec: unknown }> = [];
        return {
            calls,
            registerGuestIncRefStub(_dll: string, fn: string, spec: unknown) { calls.push({ fn, spec }); },
            setIncRefExpectedVtable() { /* recorded via incRefStubStatus below */ },
            incRefStubStatus() { return { installed: calls.length > 0, verify: false, vtable: 0 }; },
            consumeIncRefPrediction() { return null; },
        };
    }

    it('does nothing at all with both flags off', () => {
        const d = fakeDispatcher();
        registerGuestAddRefStub(d);
        expect(d.calls.length).toBe(0);
        expect(d3d9GuestAddRefStats().verdict).toBe('stub not installed');
    });

    it('REFUSES to install while the JS mirror is still the count of record', () => {
        // The stub increments the guest word with no JS in the loop. With the Map
        // authoritative those increments are invisible and the object dies under the guest.
        g.__d3d9GuestAddRefStub = true;
        const d = fakeDispatcher();
        registerGuestAddRefStub(d);
        expect(d.calls.length).toBe(0);
        expect(d3d9GuestAddRefStats().mode).toBe('off');
    });

    it('installs the oracle when asked, and passes the refcount offset through', () => {
        g.__d3d9GuestRefcount = true;
        g.__d3d9AddRefStubVerify = true;
        const d = fakeDispatcher();
        registerGuestAddRefStub(d);
        expect(d.calls.length).toBe(1);
        expect(d.calls[0]!.fn).toBe('IDirect3DTexture9_AddRef');
        expect(d.calls[0]!.spec).toEqual({ fieldOffset: 4, popBytes: 4, verify: true });
        expect(guestAddRefOracleActive()).toBe(true);
    });
});

describe('guest AddRef oracle — it can fail, and says so', () => {
    function armOracle(prediction: { value: number; valid: boolean } | null) {
        g.__d3d9GuestRefcount = true;
        g.__d3d9AddRefStubVerify = true;
        registerGuestAddRefStub({
            registerGuestIncRefStub() { /* installed */ },
            setIncRefExpectedVtable() { },
            incRefStubStatus() { return { installed: true, verify: true, vtable: 0x1234 }; },
            consumeIncRefPrediction() { return prediction; },
        });
    }

    it('agrees when guest code and the JS handler answer the same', () => {
        armOracle({ value: 7, valid: true });
        noteGuestAddRefOracle(7);
        noteGuestAddRefOracle(7);
        const s = d3d9GuestAddRefStats();
        expect(s).toMatchObject({ checked: 2, mismatch: 0, verdict: 'agree' });
    });

    it('DISAGREES the moment the prediction is wrong', () => {
        armOracle({ value: 8, valid: true });
        noteGuestAddRefOracle(7);
        const s = d3d9GuestAddRefStats();
        expect(s.mismatch).toBe(1);
        expect(s.verdict).toBe('DISAGREE');
        expect(s.firstMismatch).toBe('guest=8 js=7');
    });

    it('an unpredicted call is counted apart, and 0 checks is NOT a pass', () => {
        armOracle({ value: 0, valid: false });
        noteGuestAddRefOracle(7);
        const s = d3d9GuestAddRefStats();
        expect(s.checked).toBe(0);
        expect(s.unpredicted).toBe(1);
        expect(s.verdict).toBe('oracle did not run');
    });

    it('reset clears the counters, and the vtable gate is reported', () => {
        armOracle({ value: 8, valid: true });
        publishTexture9Vtable(0x1234);
        noteGuestAddRefOracle(7);
        expect(d3d9GuestAddRefStats(true).mismatch).toBe(1);
        const after = d3d9GuestAddRefStats();
        expect(after.mismatch).toBe(0);
        expect(after.vtablePublished).toBe('0x1234');
        expect(after.verdict).toBe('oracle did not run');
    });
});

// ── The wiring, not just the parts ──────────────────────────────────────────────
// Twice this session a verify option was declared and the call that applies it was dropped;
// the oracle then reported `checked: 0` and read as a pass. These two drive the REAL
// registration and then call the REAL registered handler, so a missing hook fails here.
describe('the oracles are actually wired into the handlers that run', () => {
    it('Texture9::AddRef fast path feeds the AddRef oracle', async () => {
        const { registerFastPathD3D9Functions } = await import('../../src/worker/modules/d3d9/fast-path');
        g.__d3d9GuestRefcount = true;
        g.__d3d9AddRefStubVerify = true;

        const fastPaths = new Map<string, Function>();
        const dispatcher = {
            registerFastPath: (_d: string, fn: string, impl: Function) => { fastPaths.set(fn, impl); },
            registerGuestIncRefStub() { },
            setIncRefExpectedVtable() { },
            incRefStubStatus: () => ({ installed: true, verify: true, vtable: 0 }),
            // A prediction that cannot match anything the JS handler answers for an
            // unknown pointer (0) — so a wired oracle MUST report a disagreement.
            consumeIncRefPrediction: () => ({ value: 5, valid: true }),
        };
        registerFastPathD3D9Functions(dispatcher);

        const handler = fastPaths.get('IDirect3DTexture9_AddRef');
        expect(handler).toBeDefined();
        const mem = new Uint8Array(1024);
        const view = new DataView(mem.buffer);
        view.setUint32(0x104, 0xdeadbe00, true);            // [esp+4] = this
        handler!({ reg32: [0, 0, 0, 0, 0x100] }, mem, new Uint32Array(mem.buffer), view);

        const stats = d3d9GuestAddRefStats();
        expect(stats.checked).toBe(1);
        expect(stats.verdict).toBe('DISAGREE');
    });
});


describe('the prediction slot is consumed, not just read', () => {
    // One word serves every call. A call that reaches the JS handler WITHOUT passing through
    // the trampoline (an unpatched second stub for the same export is the concrete route) would
    // otherwise read the previous call's prediction — a different object's count — as its own,
    // and score a disagreement that never happened. Clearing on read turns that into an honest
    // `unpredicted`. This is also the cheapest test of the open `guest=5 js=4` question.
    it('a second read after one prediction is unpredicted, not a mismatch', () => {
        const slot = { value: 5, valid: true };
        g.__d3d9GuestRefcount = true;
        g.__d3d9AddRefStubVerify = true;
        registerGuestAddRefStub({
            registerGuestIncRefStub() { },
            setIncRefExpectedVtable() { },
            incRefStubStatus() { return { installed: true, verify: true, vtable: 0 }; },
            consumeIncRefPrediction() {
                const out = { ...slot };
                slot.valid = false;           // what the real accessor does to guest RAM
                return out;
            },
        });
        noteGuestAddRefOracle(5);
        noteGuestAddRefOracle(4);
        const stats = d3d9GuestAddRefStats();
        expect(stats.checked).toBe(1);
        expect(stats.mismatch).toBe(0);
        expect(stats.unpredicted).toBe(1);
    });
});
