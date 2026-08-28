// The guest-side Texture9::Release stub, its zero-transition rule, and its oracle.
//
// Release is the one of the pair that can destroy something. Two properties carry all the
// risk and both are asserted here as bytes rather than as prose: the body must TEST the count
// before it decrements (so a 1→0 never happens without JS), and the verify body must mutate
// nothing while still publishing a prediction for the declined path — the one the live stub
// hands back, and the one where a wrong read would free a live object.
//
// The last block drives the REAL registration and calls the REAL registered handler: a verify
// option declared and never applied has shipped in this project before, and an oracle that
// reports `checked: 0` reads as a pass to anyone not looking for it.

import { describe, it, expect, afterEach } from 'bun:test';
import {
    writeDecRefStubTrampoline,
    writeIncRefStubTrampoline,
} from '../../src/worker/modules/d3d9/capture-trampolines';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';
import {
    registerGuestReleaseStub,
    publishTexture9ReleaseVtable,
    guestReleaseOracleActive,
    noteGuestReleaseOracle,
    d3d9GuestReleaseStats,
    resetGuestReleaseStubForTests,
} from '../../src/worker/modules/d3d9/guest-release-stub';
import { unpinGuestRefcountStoreForTests } from '../../src/worker/modules/d3d9/com-refs';

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
    delete g.__d3d9GuestReleaseStub;
    delete g.__d3d9ReleaseStubVerify;
    delete g.__d3d9GuestRefcount;
    delete g.__d3d9StreamRing;
}

afterEach(() => {
    clearFlags();
    resetGuestReleaseStubForTests();
    // Installing the LIVE stub pins the guest COM block as the count of record for the whole
    // process — deliberately irreversible at runtime, so a test that installs one must undo it
    // or every later suite reads its refcounts out of a guest memory that isn't there.
    unpinGuestRefcountStoreForTests();
});

describe('guest Release stub — what the emitted bytes actually do', () => {
    it('tests the count BEFORE it decrements, so the 1→0 never happens in guest code', () => {
        const ctx = mkCtx();
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        const load = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x51, 0x04]); // mov edx,[ecx+4]
        const cmp = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x83, 0xFA, 0x01]);  // cmp edx,1
        const jbe = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x0F, 0x86]);        // jbe .out
        const dec = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xFF, 0x49, 0x04]);  // dec [ecx+4]
        expect(load).toBeGreaterThan(0);
        expect(cmp).toBeGreaterThan(load);
        expect(jbe).toBeGreaterThan(cmp);
        // The whole safety argument in one assertion: the branch out precedes the mutation.
        expect(dec).toBeGreaterThan(jbe);
        // …and it answers with the decremented count.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x41, 0x04])).toBeGreaterThan(dec);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xC2, 0x04, 0x00])).toBeGreaterThan(0);
    });

    it('is jbe, not je — a count already 0 traps instead of wrapping to 0xFFFFFFFF', () => {
        const ctx = mkCtx();
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        const cmp = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x83, 0xFA, 0x01]);
        expect(cmp).toBeGreaterThan(0);
        // The branch taken on the compare is the UNSIGNED below-or-equal one. `je` would let a
        // count of 0 fall through into `dec`, and `jl` would read the count as signed.
        expect([ctx.mem[cmp + 3], ctx.mem[cmp + 4]]).toEqual([0x0F, 0x86]);
    });

    it('refuses any `this` whose vptr is not the published vtable, and keeps the OUT trap', () => {
        const ctx = mkCtx();
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x8B, 0x11])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0x3B, 0x15, ...imm32(EXPECT_VTABLE)])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xBA, ...imm32(0xB077), 0xEF])).toBeGreaterThan(0);
    });

    it('the VERIFY body mutates nothing and still publishes both prediction codes', () => {
        const ctx = mkCtx();
        const r = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE, predictAddr: PREDICT });
        // An oracle that also decremented would be measuring itself.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0xFF, 0x49, 0x04])).toBe(-1);
        // code 0 on entry, code 1 for the answer it would have given, code 2 for the decline.
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xC6, 0x05, ...imm32(PREDICT + 4), 0x00])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xC6, 0x05, ...imm32(PREDICT + 4), 0x01])).toBeGreaterThan(0);
        expect(findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd,
            [0xC6, 0x05, ...imm32(PREDICT + 4), 0x02])).toBeGreaterThan(0);
        // The declined path publishes the raw count it read (dec comes after the branch).
        const publish = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x89, 0x15, ...imm32(PREDICT)]);
        const cmp = findBytes(ctx.mem, r.codeRegionBase, r.codeRegionEnd, [0x83, 0xFA, 0x01]);
        expect(publish).toBeGreaterThan(0);
        expect(cmp).toBeGreaterThan(publish);
    });

    it('the dec body is not the inc body (a swapped emitter would pass every other test)', () => {
        const ctx = mkCtx();
        const dec = writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        const inc = writeIncRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 4, popBytes: 4, expectVtableAddr: EXPECT_VTABLE });
        expect(findBytes(ctx.mem, dec.codeRegionBase, dec.codeRegionEnd, [0xFF, 0x41, 0x04])).toBe(-1); // no inc
        expect(findBytes(ctx.mem, inc.codeRegionBase, inc.codeRegionEnd, [0xFF, 0x49, 0x04])).toBe(-1); // no dec
    });

    it('a field offset that needs more than a disp8 is refused, not truncated', () => {
        const ctx = mkCtx();
        expect(() => writeDecRefStubTrampoline(ctx.allocator, ctx.getMemory,
            { fieldOffset: 0x80, popBytes: 4, expectVtableAddr: EXPECT_VTABLE })).toThrow();
    });
});

describe('guest Release stub — installation refuses what it cannot make safe', () => {
    function fakeDispatcher() {
        const calls: Array<{ fn: string; spec: unknown }> = [];
        return {
            calls,
            registerGuestIncRefStub(_dll: string, fn: string, spec: unknown) { calls.push({ fn, spec }); },
            setIncRefExpectedVtable() { },
            incRefStubStatus() { return { installed: calls.length > 0, verify: false, vtable: 0 }; },
            consumeIncRefPrediction() { return null; },
        };
    }

    it('does nothing at all with both flags off', () => {
        const d = fakeDispatcher();
        registerGuestReleaseStub(d);
        expect(d.calls.length).toBe(0);
        expect(d3d9GuestReleaseStats().verdict).toBe('stub not installed');
    });

    it('REFUSES while the JS mirror is still the count of record', () => {
        // Decrements the guest word with no JS in the loop; with the Map authoritative the
        // count never reaches zero and nothing is ever destroyed.
        g.__d3d9GuestReleaseStub = true;
        const d = fakeDispatcher();
        registerGuestReleaseStub(d);
        expect(d.calls.length).toBe(0);
        expect(d3d9GuestReleaseStats().mode).toBe('off');
    });

    it('REFUSES a buffer interface while __d3d9StreamRing defers stream bindings', () => {
        // The ring is safe only because Buffer9::Release is the OUT trap that drains it first.
        g.__d3d9GuestRefcount = true;
        g.__d3d9GuestReleaseStub = true;
        g.__d3d9StreamRing = true;
        const d = fakeDispatcher();
        registerGuestReleaseStub(d, 'IDirect3DVertexBuffer9');
        expect(d.calls.length).toBe(0);
        expect(d3d9GuestReleaseStats().mode).toBe('off');
    });

    it('…and installs that same interface once the ring is off — the guard is the ring, not the name', () => {
        g.__d3d9GuestRefcount = true;
        g.__d3d9GuestReleaseStub = true;
        const d = fakeDispatcher();
        registerGuestReleaseStub(d, 'IDirect3DVertexBuffer9');
        expect(d.calls.length).toBe(1);
        expect(d.calls[0]!.fn).toBe('IDirect3DVertexBuffer9_Release');
    });

    it('Texture9 installs WITH the ring on: patching is per function name, and buffers keep trapping', () => {
        g.__d3d9GuestRefcount = true;
        g.__d3d9GuestReleaseStub = true;
        g.__d3d9StreamRing = true;
        const d = fakeDispatcher();
        registerGuestReleaseStub(d);
        expect(d.calls.length).toBe(1);
        expect(d.calls[0]!.fn).toBe('IDirect3DTexture9_Release');
    });

    it('installs the oracle when asked, and passes the dec kind and refcount offset through', () => {
        g.__d3d9GuestRefcount = true;
        g.__d3d9ReleaseStubVerify = true;
        const d = fakeDispatcher();
        registerGuestReleaseStub(d);
        expect(d.calls[0]!.spec).toEqual({ fieldOffset: 4, popBytes: 4, verify: true, kind: 'dec' });
        expect(guestReleaseOracleActive()).toBe(true);
    });
});

describe('guest Release oracle — it can fail, and says so', () => {
    function armOracle(prediction: { value: number; valid: boolean; code: number } | null) {
        g.__d3d9GuestRefcount = true;
        g.__d3d9ReleaseStubVerify = true;
        registerGuestReleaseStub({
            registerGuestIncRefStub() { },
            setIncRefExpectedVtable() { },
            incRefStubStatus() { return { installed: true, verify: true, vtable: 0x1234 }; },
            consumeIncRefPrediction() { return prediction; },
        });
    }

    it('agrees when guest code and the JS handler answer the same', () => {
        armOracle({ value: 6, valid: true, code: 1 });
        noteGuestReleaseOracle(6);
        expect(d3d9GuestReleaseStats()).toMatchObject({ checked: 1, mismatch: 0, zeroChecked: 0 });
    });

    it('an above-zero agreement is NOT reported as a clean pass while no destruction was seen', () => {
        armOracle({ value: 6, valid: true, code: 1 });
        noteGuestReleaseOracle(6);
        expect(d3d9GuestReleaseStats().verdict).toBe('agree, but the 1->0 transition never ran');
    });

    it('DISAGREES the moment the above-zero prediction is wrong', () => {
        armOracle({ value: 8, valid: true, code: 1 });
        noteGuestReleaseOracle(7);
        const s = d3d9GuestReleaseStats();
        expect(s).toMatchObject({ mismatch: 1, verdict: 'DISAGREE', firstMismatch: 'guest=8 js=7' });
    });

    it('checks the DECLINED path too: count 1 must be the answer 0 that destroyed the object', () => {
        armOracle({ value: 1, valid: false, code: 2 });
        noteGuestReleaseOracle(0);
        expect(d3d9GuestReleaseStats()).toMatchObject({
            checked: 1, zeroChecked: 1, mismatch: 0, verdict: 'agree',
        });
    });

    it('…and DISAGREES when the count it read does not explain the answer JS produced', () => {
        // The stub read 1 (so it declined), JS answered 5: the guest word is not the count of
        // record for this object, and the live stub would have been decrementing the wrong dword.
        armOracle({ value: 1, valid: false, code: 2 });
        noteGuestReleaseOracle(5);
        const s = d3d9GuestReleaseStats();
        expect(s).toMatchObject({ mismatch: 1, zeroMismatch: 1, verdict: 'DISAGREE' });
        expect(s.firstMismatch).toBe('zero-path guestCount=1 js=5');
    });

    it('an unpredicted call is counted apart, and 0 checks is NOT a pass', () => {
        armOracle({ value: 0, valid: false, code: 0 });
        noteGuestReleaseOracle(7);
        const s = d3d9GuestReleaseStats();
        expect(s).toMatchObject({ checked: 0, unpredicted: 1, verdict: 'oracle did not run' });
    });

    it('reset clears the counters, and the vtable gate is reported', () => {
        armOracle({ value: 8, valid: true, code: 1 });
        publishTexture9ReleaseVtable(0x1234);
        noteGuestReleaseOracle(7);
        expect(d3d9GuestReleaseStats(true).mismatch).toBe(1);
        const after = d3d9GuestReleaseStats();
        expect(after.mismatch).toBe(0);
        expect(after.zeroChecked).toBe(0);
        expect(after.vtablePublished).toBe('0x1234');
        expect(after.verdict).toBe('oracle did not run');
    });
});

// ── The wiring, not just the parts ──────────────────────────────────────────────
describe('the Release oracle is actually wired into the handler that runs', () => {
    it('Texture9::Release fast path feeds the Release oracle', async () => {
        const { registerFastPathD3D9Functions } = await import('../../src/worker/modules/d3d9/fast-path');
        g.__d3d9GuestRefcount = true;
        g.__d3d9ReleaseStubVerify = true;

        const fastPaths = new Map<string, Function>();
        const specs: unknown[] = [];
        const dispatcher = {
            registerFastPath: (_d: string, fn: string, impl: Function) => { fastPaths.set(fn, impl); },
            registerGuestIncRefStub(_d: string, _f: string, spec: unknown) { specs.push(spec); },
            setIncRefExpectedVtable() { },
            incRefStubStatus: () => ({ installed: true, verify: true, vtable: 0 }),
            // A prediction that cannot match anything the JS handler answers for an unknown
            // pointer (0) — so a wired oracle MUST report a disagreement.
            consumeIncRefPrediction: () => ({ value: 5, valid: true, code: 1 }),
        };
        registerFastPathD3D9Functions(dispatcher);

        // The registration really asked for the dec-kind oracle (a dropped option would show here).
        expect(specs).toContainEqual({ fieldOffset: 4, popBytes: 4, verify: true, kind: 'dec' });

        const handler = fastPaths.get('IDirect3DTexture9_Release');
        expect(handler).toBeDefined();
        const mem = new Uint8Array(1024);
        const view = new DataView(mem.buffer);
        view.setUint32(0x104, 0xdeadbe00, true);            // [esp+4] = this
        handler!({ reg32: [0, 0, 0, 0, 0x100] }, mem, new Uint32Array(mem.buffer), view);

        const stats = d3d9GuestReleaseStats();
        expect(stats.checked).toBe(1);
        expect(stats.verdict).toBe('DISAGREE');
    });
});
