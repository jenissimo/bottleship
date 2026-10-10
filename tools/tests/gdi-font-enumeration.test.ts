import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { enumerateFontFamilies } from '../../src/worker/modules/gdi32/font-enumeration';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import type { ThunkResult, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance();
const originalProcess = system.process;
const originalGdi = system.gdiContext;
const originalCodePage = EmulatorConfig.getInstance().ansiCodePage;
const memory = new Uint8Array(8192);
const callbacks: any[] = [];
let allocations = 0;
let freed: number[] = [];
let saved: any[] = [];
let abandoned: number[] = [];
let frameId = 7;
let invokeFails = false;
const dc = { font: 'original', measureText: (text: string) => ({ width: text === 'W' ? 12 : 8, fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 3 }) };

beforeEach(() => {
    memory.fill(0);
    callbacks.length = 0;
    allocations = 0;
    freed = []; saved = []; abandoned = [];
    frameId = 7; invokeFails = false;
    EmulatorConfig.getInstance().ansiCodePage = 1252;
    Mem.bind(() => memory);
    system.gdiContext = { getDC: (hdc: number) => hdc === 1 ? dc : undefined } as never;
    system.process = {
        memory: { alloc: () => { allocations++; return 2048; }, free: (ptr: number) => freed.push(ptr) },
        dispatcher: { callbackManager: {
            saveSuspendedThunkContext: (...args: any[]) => { saved.push(args); return frameId; },
            abandonSuspendedFrame: (id: number) => abandoned.push(id),
            invokeCallback: (...args: any[]) => {
                if (invokeFails) return { callbackId: 0 };
                const callbackId = callbacks.length + 1;
                callbacks.push({ callbackId, target: args[0], args: args[1], completeThunk: args[3], frameId: args[6] });
                return { callbackId };
            },
            getPendingCallback: (id: number) => callbacks[id - 1],
        } },
    } as never;
});

afterEach(() => {
    system.process = originalProcess;
    system.gdiContext = originalGdi;
    EmulatorConfig.getInstance().ansiCodePage = originalCodePage;
});

function call(family: string, wide = false, extended = true, charset = 1): number | ThunkResult {
    const ptr = 256;
    const textPtr = ptr + (extended ? 28 : 0);
    const view = new DataView(memory.buffer);
    if (extended) memory[ptr + 23] = charset;
    if (wide) for (let i = 0; i < family.length; i++) view.setUint16(textPtr + i * 2, family.charCodeAt(i), true);
    else memory.set(new TextEncoder().encode(family), textPtr);
    return enumerateFontFamilies({ esp: 512 } as X86Context, [1, ptr, 1024, 0x12345678, 0], wide, extended);
}

function readString(ptr: number, wide = false): string {
    const view = new DataView(memory.buffer);
    let text = '';
    for (let at = ptr; ; at += wide ? 2 : 1) {
        const unit = wide ? view.getUint16(at, true) : memory[at];
        if (!unit) return text;
        text += String.fromCharCode(unit);
    }
}

function finish(ret: number): number | null {
    const cb = callbacks[callbacks.length - 1];
    const result = cb.completeThunk(ret);
    if (result === null) cb.enumerationState.continueEnumeration();
    return result;
}

test('ANSI font enumeration invokes every style, keeps storage alive and returns the last callback value', () => {
    const result = call('TaHoMa') as ThunkResult;
    expect(result.suspendedForCallback).toBe(true);
    expect(result.stackCleanup).toBe(20);
    expect(result.skipStackCheck).toBe(true);
    expect(saved[0][1]).toBe(20);
    const styles: string[] = [];
    for (let i = 0; i < 4; i++) {
        const cb = callbacks[i];
        expect(cb.args).toEqual([2048, 2236, 4, 0x12345678]);
        expect(cb.frameId).toBe(7);
        expect(readString(2048 + 28)).toBe('tahoma');
        styles.push(readString(2048 + 124));
        expect(freed).toEqual([]);
        expect(finish(37)).toBe(i === 3 ? 37 : null);
    }
    expect(styles).toEqual(['Regular', 'Bold', 'Italic', 'Bold Italic']);
    expect(freed).toEqual([2048]);
    expect(allocations).toBe(1);
    expect(dc.font).toBe('original');
});

test('callback zero stops immediately and releases enumeration storage', () => {
    call('');
    expect(finish(0)).toBe(0);
    expect(callbacks.length).toBe(1);
    expect(freed).toEqual([2048]);
});

test('Unicode ENUMLOGFONTEXW and NEWTEXTMETRICEXW have native offsets and no ANSI overlap', () => {
    call('Arial', true);
    const cb = callbacks[0];
    expect(cb.args[1]).toBe(2048 + 348);
    expect(readString(2048 + 28, true)).toBe('arial');
    expect(readString(2048 + 92, true)).toBe('arial');
    expect(readString(2048 + 220, true)).toBe('Regular');
    const metrics = cb.args[1];
    const view = new DataView(memory.buffer);
    expect(view.getInt32(metrics, true)).toBe(16);
    expect(view.getUint16(metrics + 44, true)).toBe(32);
    expect(view.getUint16(metrics + 46, true)).toBe(255);
    expect(memory[metrics + 56]).toBe(0);
    expect(view.getUint32(metrics + 60, true)).toBe(256);
    expect(view.getUint32(metrics + 76 + 16, true)).toBe(1);
    finish(0);
});

test('legacy family enumeration uses its own stdcall cleanup and also calls the guest', () => {
    const result = call('Courier New', false, false) as ThunkResult;
    expect(result.stackCleanup).toBe(16);
    expect(saved[0][1]).toBe(16);
    expect(memory[2048 + 27]).toBe(0x31);
    expect(memory[2236 + 51] & 1).toBe(0);
    expect(finish(0)).toBe(0);
});

test('missing families and unsupported charset perform no callbacks or allocations', () => {
    expect(call('Does Not Exist')).toBe(0);
    expect(call('arial', false, true, 128)).toBe(0);
    expect(allocations).toBe(0);
    expect(callbacks.length).toBe(0);
});

test('failed frame or first callback cannot leak storage or pin the suspended frame', () => {
    frameId = 0;
    expect(call('arial')).toBe(0);
    expect(freed).toEqual([2048]);
    frameId = 7;
    invokeFails = true;
    expect(call('arial')).toBe(0);
    expect(freed).toEqual([2048, 2048]);
    expect(abandoned).toEqual([7]);
});
