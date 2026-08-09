// Characterization tests for WinApiCallRing — the WinAPI crash-forensics ring buffer
// extracted out of thunk-dispatcher.ts. Pure unit: no v86/DOM. Pins current behavior.

import { describe, it, expect } from 'bun:test';
import { WinApiCallRing } from '../../src/worker/core/thunking/winapi-call-ring';

/** A names table indexed by thunk id, as the dispatcher passes by reference. */
function makeNames(map: Record<number, string>): Array<string | null> {
    const arr: Array<string | null> = new Array(65536).fill(null);
    for (const k of Object.keys(map)) arr[Number(k)] = map[Number(k)];
    return arr;
}

describe('WinApiCallRing', () => {
    it('getCalls formats oldest..newest as 0xID:name(ESP=0x..)', () => {
        const names = makeNames({ 1: 'kernel32:GetTickCount', 2: 'user32:GetMessageA' });
        const ring = new WinApiCallRing(names);
        ring.record(1, 0x1000, 0, 0);
        ring.record(2, 0x1004, 0, 0);

        expect(ring.getCalls(8)).toEqual([
            '0x1:kernel32:GetTickCount(ESP=0x1000) -> (in flight)',
            '0x2:user32:GetMessageA(ESP=0x1004) -> (in flight)',
        ]);
    });

    it('unknown ids resolve to "unknown" in getCalls/getCallsRich', () => {
        const ring = new WinApiCallRing(makeNames({}));
        ring.record(7, 0x2000, 0, 0);
        expect(ring.getCalls(8)).toEqual(['0x7:unknown(ESP=0x2000) -> (in flight)']);
        expect(ring.getCallsRich(8)[0].name).toBe('unknown');
    });

    it('filters noisy thunks by default, includes them when asked', () => {
        const names = makeNames({ 1: 'gdi32:BitBlt', 2: 'kernel32:GetTickCount' });
        const ring = new WinApiCallRing(names);
        ring.record(1, 0x10, 0, 0); // noisy
        ring.record(2, 0x20, 0, 0); // benign

        expect(ring.getCalls(8)).toEqual(['0x2:kernel32:GetTickCount(ESP=0x20) -> (in flight)']);
        expect(ring.getCalls(8, { includeNoisy: true })).toEqual([
            '0x1:gdi32:BitBlt(ESP=0x10) -> (in flight)',
            '0x2:kernel32:GetTickCount(ESP=0x20) -> (in flight)',
        ]);
    });

    it('falls back to noisy entries when filtering would leave nothing', () => {
        const ring = new WinApiCallRing(makeNames({ 1: 'd3d9:DrawPrimitive' }));
        ring.record(1, 0x40, 0, 0);
        // Only a noisy call exists → non-empty result via includeNoisy retry.
        expect(ring.getCalls(8)).toEqual(['0x1:d3d9:DrawPrimitive(ESP=0x40) -> (in flight)']);
    });

    it('recordReturnValue fills EAX of the most recent call (seen by getTrace)', () => {
        const ring = new WinApiCallRing(makeNames({ 5: 'kernel32:lstrlenA' }));
        ring.record(5, 0x100, 0xdead, 0);
        ring.recordReturnValue(0x2a);
        expect(ring.getTrace(4)).toEqual(['[0] kernel32:lstrlenA(arg0=0xdead) -> 0x2a']);
    });

    it('getTrace uses id_0x fallback for unknown ids', () => {
        const ring = new WinApiCallRing(makeNames({}));
        ring.record(0x33, 0x100, 0, 0);
        expect(ring.getTrace(4)).toEqual(['[0] id_0x33(arg0=0x0) -> 0x0']);
    });

    it('getCrashTraceLines is 2-space indented and empty on an empty ring (no min-1 clamp)', () => {
        const ring = new WinApiCallRing(makeNames({ 9: 'winmm:timeGetTime' }));
        expect(ring.getCrashTraceLines(50)).toEqual([]); // empty ring → empty, unlike getTrace
        ring.record(9, 0x80, 0x1, 0);
        ring.recordReturnValue(0x7);
        expect(ring.getCrashTraceLines(50)).toEqual(['  [0] winmm:timeGetTime(arg0=0x1) esp=0x80 ret=0x0 -> 0x7']);
    });

    it('keeps only the newest HISTORY_SIZE entries and wraps correctly', () => {
        const names = makeNames({});
        for (let i = 0; i < 300; i++) names[i % 65536] = `dll:fn${i}`;
        const ring = new WinApiCallRing(names);
        for (let i = 0; i < 300; i++) ring.record(i & 0xffff, 0x1000 + i, 0, 0);

        const calls = ring.getCalls(1000, { includeNoisy: true });
        expect(calls.length).toBe(256);          // capacity, not 300
        // Newest entry is the last recorded (id 299).
        expect(calls[calls.length - 1]).toBe(`0x${(299).toString(16)}:dll:fn299(ESP=0x${(0x1000 + 299).toString(16)}) -> (in flight)`);
    });

    it('tells "returned zero" apart from "never returned"', () => {
        const names = makeNames({ 1: 'kernel32:GetLastError', 2: 'kernel32:GetTickCount' });
        const ring = new WinApiCallRing(names);
        ring.record(1, 0x10, 0, 0);
        ring.recordReturnValue(0);
        ring.record(2, 0x20, 0, 0);

        expect(ring.getCalls(8, { includeNoisy: true })).toEqual([
            '0x1:kernel32:GetLastError(ESP=0x10) -> 0x0',
            '0x2:kernel32:GetTickCount(ESP=0x20) -> (in flight)',
        ]);
    });

    it('recordAsyncReturnByName credits the parked call, not the newest entry', () => {
        const names = makeNames({ 1: 'kernel32:WaitForSingleObject', 2: 'kernel32:GetTickCount' });
        const ring = new WinApiCallRing(names);
        ring.record(1, 0x10, 0, 0);          // parks
        ring.record(2, 0x20, 0, 0);          // another thread runs meanwhile
        ring.recordReturnValue(0x1234);      // ...and completes
        expect(ring.recordAsyncReturnByName('kernel32:WaitForSingleObject', 0x102)).toBe(true);

        expect(ring.getCalls(8, { includeNoisy: true })).toEqual([
            '0x1:kernel32:WaitForSingleObject(ESP=0x10) -> 0x102',
            '0x2:kernel32:GetTickCount(ESP=0x20) -> 0x1234',
        ]);
    });

    it('recordAsyncReturnByName reports failure once the call has been evicted', () => {
        const ring = new WinApiCallRing(makeNames({ 1: 'kernel32:GetTickCount' }));
        ring.record(1, 0x10, 0, 0);
        expect(ring.recordAsyncReturnByName('kernel32:Unrecorded', 7)).toBe(false);
    });

    it('reset clears the ring', () => {
        const ring = new WinApiCallRing(makeNames({ 1: 'a:b' }));
        ring.record(1, 0x10, 0, 0);
        ring.reset();
        expect(ring.getCalls(8, { includeNoisy: true })).toEqual([]);
        expect(ring.getCrashTraceLines(50)).toEqual([]);
    });

    describe('getThreadTail (per-thread crash forensics)', () => {
        it('isolates ONE thread\'s calls from a flooding peer, oldest..newest, with esp+[esp]', () => {
            const names = makeNames({ 1: 'kernel32:Foo', 2: 'ddraw:Flip', 3: 'kernel32:Bar' });
            const ring = new WinApiCallRing(names);
            // T1 makes two calls; T3 floods between/after them.
            ring.record(1, 0x10ffa0, 0, 0x401000, 1);
            for (let i = 0; i < 50; i++) ring.record(2, 0x1667900 + i, 0, 0x420000, 3);
            ring.record(3, 0x3f6418e8, 0, 0x8662, 1); // T1's wild-ESP call

            expect(ring.getThreadTail(1, 24)).toEqual([
                '0x1:kernel32:Foo(esp=0x10ffa0,[esp]=0x401000) -> (in flight)',
                '0x3:kernel32:Bar(esp=0x3f6418e8,[esp]=0x8662) -> (in flight)',
            ]);
        });

        it('does NOT noise-filter — a thread\'s render-loop tail is preserved', () => {
            const ring = new WinApiCallRing(makeNames({ 2: 'ddraw:Flip' }));
            ring.record(2, 0x100, 0, 0, 3);
            expect(ring.getThreadTail(3, 8)).toEqual(['0x2:ddraw:Flip(esp=0x100,[esp]=0x0) -> (in flight)']);
        });

        it('returns empty for a thread with no recorded calls', () => {
            const ring = new WinApiCallRing(makeNames({ 1: 'a:b' }));
            ring.record(1, 0x10, 0, 0, 1);
            expect(ring.getThreadTail(7, 8)).toEqual([]);
        });

        it('caps to the requested count (newest kept)', () => {
            const names = makeNames({});
            for (let i = 0; i < 10; i++) names[i] = `dll:fn${i}`;
            const ring = new WinApiCallRing(names);
            for (let i = 0; i < 10; i++) ring.record(i, 0x1000 + i, 0, 0, 2);
            const tail = ring.getThreadTail(2, 3);
            expect(tail.length).toBe(3);
            expect(tail[2]).toBe(`0x9:dll:fn9(esp=0x${(0x1000 + 9).toString(16)},[esp]=0x0) -> (in flight)`);
        });
    });
});
