import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { registerPaintingMiscExports } from '../../src/worker/modules/gdi32/painting-misc';
import { addFontResource, removeFontResource, registeredFontFamilies } from '../../src/worker/modules/gdi32/font-resource';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';

const fontBytes = new Uint8Array(readFileSync(new URL('../../public/fonts/LiberationSans-Regular.ttf', import.meta.url)));
const system = System.getInstance();
const oldVfs = system.fileSystem;
const originalFontFace = globalThis.FontFace;
const originalSelf = globalThis.self;
const exports: Record<string, ThunkImplementation> = {};
registerPaintingMiscExports(exports);
const memory = new Uint8Array(4096);
const faces = new Set<unknown>();
let loads = 0;
let opens = 0;
let rejectLoad = false;

beforeEach(() => {
    loads = opens = 0;
    rejectLoad = false;
    faces.clear();
    Mem.bind(() => memory);
    globalThis.FontFace = class {
        async load() {
            loads++;
            await Promise.resolve();
            if (rejectLoad) throw new Error('invalid font');
            return this;
        }
    } as unknown as typeof FontFace;
    globalThis.self = { fonts: { add: (face: unknown) => faces.add(face), delete: (face: unknown) => faces.delete(face) } } as never;
    system.fileSystem = {
        resolvePath: (path: string) => path.toLowerCase(),
        getFileSize: (path: string) => path.includes('missing') ? 0 : fontBytes.length,
        open: async () => { opens++; return {}; },
        read: async () => fontBytes,
    } as never;
});
afterEach(() => {
    for (const path of ['c:\\fonts\\test.ttf', 'bad-font']) {
        for (const flags of [0, 0x10, 0x20, 0x30]) while (removeFontResource(path, flags)) { /* drain references */ }
    }
    system.fileSystem = oldVfs;
    globalThis.FontFace = originalFontFace;
    globalThis.self = originalSelf;
});

function call(api: string, path: string, flags = 0x10, reserved = 0) {
    memory.fill(0);
    if (api.endsWith('W')) {
        const view = new DataView(memory.buffer);
        for (let i = 0; i < path.length; i++) view.setUint16(256 + i * 2, path.charCodeAt(i), true);
    } else memory.set(new TextEncoder().encode(path), 256);
    return exports[api](null as never, memory, [256, flags, reserved]);
}

test('private font A/W registrations finish loading and require matching flags and reference counts', async () => {
    const path = 'C:\\Fonts\\test.ttf';
    expect(await Promise.all([
        call('AddFontResourceExA', path), call('AddFontResourceExW', path),
    ])).toEqual([1, 1]);
    expect(loads).toBe(1);
    expect(faces.size).toBe(1);
    expect(registeredFontFamilies()).toContain('Liberation Sans');
    expect(await call('AddFontResourceExA', path, 0x30)).toBe(1);
    expect(call('RemoveFontResourceExA', path, 0)).toBe(0);
    expect(call('RemoveFontResourceExA', path)).toBe(1);
    expect(call('RemoveFontResourceExW', path)).toBe(1);
    expect(faces.size).toBe(1);
    expect(registeredFontFamilies()).not.toContain('Liberation Sans');
    expect(call('RemoveFontResourceExW', path)).toBe(0);
    expect(call('RemoveFontResourceExA', path, 0x30)).toBe(1);
    expect(faces.size).toBe(0);
});

test('missing files, invalid parameters and rejected font data return failure', async () => {
    expect(await call('AddFontResourceExW', 'missing.ttf')).toBe(0);
    expect(call('AddFontResourceExA', 'test.ttf', 0x10, 1)).toBe(0);
    expect(call('AddFontResourceExA', 'test.ttf', 0x40)).toBe(0);
    expect(opens).toBe(0);
    rejectLoad = true;
    expect(await addFontResource('bad-font', fontBytes, 0x10)).toBe(0);
    expect(await addFontResource('bad-font', new Uint8Array([0, 1, 2]), 0x10)).toBe(0);
    expect(faces.size).toBe(0);
    expect(removeFontResource('bad-font', 0x10)).toBe(false);
});
