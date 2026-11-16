import { invalidateTextExtentCache } from "../../src/worker/modules/gdi32/text-extent-cache";
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { Marshaler } from '../../src/worker/core/memory/marshaler';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import { createPaintingExports } from '../../src/worker/modules/gdi32/painting';

const system = System.getInstance();
const originalGdi = system.gdiContext;
const originalCodePage = EmulatorConfig.getInstance().ansiCodePage;
const memory = new Uint8Array(4096);
let measured: string[] = [];
let font = '12px A';

const dc = {
    get font() { return font; },
    measureText: (text: string) => {
        if (text !== 'ABCgjpqy') measured.push(text); // 'ABCgjpqy' is the font-bounds probe
        return { width: text.length * 6 + (font === '12px B' ? 1 : 0), fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 };
    },
};

beforeEach(() => {
    invalidateTextExtentCache();
    memory.fill(0);
    measured = [];
    font = '12px A';
    EmulatorConfig.getInstance().ansiCodePage = 1252;
    Mem.bind(() => memory);
    system.gdiContext = {
        getMeasureContext: (hdc: number) => (hdc === 1 ? dc : undefined),
        hdcStates: { get: (hdc: number) => (hdc === 1 ? { font } : undefined) },
    } as never;
});

afterEach(() => {
    system.gdiContext = originalGdi;
    EmulatorConfig.getInstance().ansiCodePage = originalCodePage;
});

function put(addr: number, s: string): void {
    memory.set(new TextEncoder().encode(s), addr);
}

const size = (): [number, number] => {
    const v = new DataView(memory.buffer);
    return [v.getInt32(512, true), v.getInt32(516, true)];
};

test('readString stops at NUL and tolerates an unterminated tail', () => {
    put(100, 'Credits');
    expect(Marshaler.readString(memory, 100)).toBe('Credits');
    expect(Marshaler.readString(memory, 107)).toBe('');
    memory.fill(0x41, memory.length - 3);
    expect(Marshaler.readString(memory, memory.length - 3)).toBe('AAA');
});

test('readCountedString reads exactly count bytes, past an embedded NUL, clamped to memory', () => {
    put(100, 'ab');
    put(103, 'cd');
    expect(Marshaler.readCountedString(memory, 100, 5)).toBe('ab\0cd');
    expect(Marshaler.readCountedString(memory, 100, 2)).toBe('ab');
    expect(Marshaler.readCountedString(memory, 100, 0)).toBe('');
    expect(Marshaler.readCountedString(memory, memory.length - 2, 50).length).toBe(2);
});

test('GetTextExtentPoint32A writes SIZE and reuses a cached measurement per (font, text)', () => {
    const fn = createPaintingExports()['GetTextExtentPoint32A'] as (ctx: unknown, mem: Uint8Array, args: number[]) => number;
    put(100, 'Credits');

    expect(fn({}, memory, [1, 100, 7, 512])).toBe(1);
    expect(size()).toEqual([42, 13]);
    fn({}, memory, [1, 100, 7, 512]);
    fn({}, memory, [1, 100, 7, 512]);
    expect(measured).toEqual(['Credits']);

    fn({}, memory, [1, 100, 3, 512]);
    expect(size()).toEqual([18, 13]);
    expect(measured).toEqual(['Credits', 'Cre']);

    font = '12px B';
    fn({}, memory, [1, 100, 7, 512]);
    expect(size()).toEqual([43, 13]);
    expect(measured.length).toBe(3);
});

test('GetTextExtentPoint32A falls back to 8px per char without a DC and does not cache it', () => {
    const fn = createPaintingExports()['GetTextExtentPoint32A'] as (ctx: unknown, mem: Uint8Array, args: number[]) => number;
    put(100, 'abcd');
    fn({}, memory, [99, 100, 4, 512]);
    expect(size()).toEqual([32, 16]);
    expect(measured).toEqual([]);
});
