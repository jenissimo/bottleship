import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { registerPaintingMiscExports } from '../../src/worker/modules/gdi32/painting-misc';
import { removeFontResource, registeredFontFamilies } from '../../src/worker/modules/gdi32/font-resource';
import { buildFot, parseFot } from '../../src/worker/modules/gdi32/font-fot';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';

const memState = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(
    key => [key, Object.getOwnPropertyDescriptor(Mem, key)] as const,
);
afterAll(() => { for (const [key, descriptor] of memState) if (descriptor) Object.defineProperty(Mem, key, descriptor); });

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_FILE_EXISTS = 80;
const fontBytes = new Uint8Array(readFileSync(new URL('../../public/fonts/LiberationSans-Regular.ttf', import.meta.url)));
const system = System.getInstance();
const oldVfs = system.fileSystem;
const oldScheduler = system.scheduler;
const originalFontFace = globalThis.FontFace;
const originalSelf = globalThis.self;
const exports: Record<string, ThunkImplementation> = {};
registerPaintingMiscExports(exports);
const memory = new Uint8Array(4096);
let files: Map<string, Uint8Array>;
let lastError = 0;

beforeEach(() => {
    lastError = 0;
    files = new Map([['c:\\game\\lsans.ttf', fontBytes]]);
    Mem.bind(() => memory);
    globalThis.FontFace = class { async load() { return this; } } as unknown as typeof FontFace;
    globalThis.self = { fonts: { add: () => {}, delete: () => {} } } as never;
    system.scheduler = { setLastError: (n: number) => { lastError = n; } } as never;
    system.fileSystem = {
        resolvePath: (path: string) => path.toLowerCase(),
        fileExists: (path: string) => files.has(path),
        getFileSize: (path: string) => files.get(path)?.length ?? 0,
        open: async (path: string) => ({ path }),
        read: async (h: { path: string }) => files.get(h.path)!,
        readSync: (h: { path: string }) => files.get(h.path)!,
        openSync: (path: string, _access: number, disposition: number) => {
            if (disposition === 3) return files.has(path) ? { path } : null;
            if (disposition === 1 && files.has(path)) return null;
            files.set(path, new Uint8Array(0));
            return { path };
        },
        writeSync: (h: { path: string }, data: Uint8Array) => { files.set(h.path, data); return data.length; },
    } as never;
});
afterEach(() => {
    while (removeFontResource('c:\\game\\lsans.fot')) { /* drain */ }
    system.fileSystem = oldVfs;
    system.scheduler = oldScheduler;
    globalThis.FontFace = originalFontFace;
    globalThis.self = originalSelf;
});

function put(offset: number, text: string): number {
    memory.set(new TextEncoder().encode(text + '\0'), offset);
    return offset;
}
const create = (fot: string, ttf: string, dir: string) =>
    exports['CreateScalableFontResourceA'](null as never, memory, [0, put(16, fot), put(256, ttf), put(512, dir)]);
const add = (path: string) => exports['AddFontResourceA'](null as never, memory, [put(1024, path)]);

test('buildFot output is read back as the font and face it names', () => {
    const ref = parseFot(buildFot('C:\\Game\\LSANS.TTF', 'Lucida Sans'));
    expect(ref).toEqual({ fontPath: 'C:\\Game\\LSANS.TTF', face: 'Lucida Sans' });
    expect(parseFot(fontBytes)).toBeNull();
});

test('CreateScalableFontResource writes a FOT once and then reports ERROR_FILE_EXISTS', async () => {
    expect(await create('c:\\game\\lsans.fot', 'lsans.ttf', 'c:\\game')).toBe(1);
    expect(parseFot(files.get('c:\\game\\lsans.fot')!)?.fontPath).toBe('c:\\game\\lsans.ttf');
    expect(await create('c:\\game\\lsans.fot', 'lsans.ttf', 'c:\\game')).toBe(0);
    expect(lastError).toBe(ERROR_FILE_EXISTS);
});

test('CreateScalableFontResource fails with ERROR_FILE_NOT_FOUND when the font file is absent', async () => {
    expect(await create('c:\\game\\new.fot', 'nothere.ttf', 'c:\\game')).toBe(0);
    expect(lastError).toBe(ERROR_FILE_NOT_FOUND);
    expect(files.has('c:\\game\\new.fot')).toBe(false);
});

test('AddFontResource of a FOT installs the TTF it names, found beside the FOT when its recorded path is stale', async () => {
    files.set('c:\\game\\lsans.fot', buildFot('y:\\gone\\games\\LSANS.TTF', 'Liberation Sans'));
    expect(await add('c:\\game\\lsans.fot')).toBe(1);
    expect(registeredFontFamilies()).toContain('Liberation Sans');
    expect(exports['RemoveFontResourceA'](null as never, memory, [put(1024, 'c:\\game\\lsans.fot')])).toBe(1);
    expect(registeredFontFamilies()).not.toContain('Liberation Sans');
});

test('AddFontResource of a FOT whose font cannot be found fails', async () => {
    files.set('c:\\game\\lsans.fot', buildFot('y:\\gone\\OTHER.TTF', 'Other'));
    expect(await add('c:\\game\\lsans.fot')).toBe(0);
});

test('CreateScalableFontResource does not replace an existing empty FOT', async () => {
    files.set('c:\\game\\lsans.fot', new Uint8Array());
    expect(await create('c:\\game\\lsans.fot', 'lsans.ttf', 'c:\\game')).toBe(0);
    expect(lastError).toBe(ERROR_FILE_EXISTS);
    expect(files.get('c:\\game\\lsans.fot')).toHaveLength(0);
});

test('hidden resources fail explicitly until process-scoped font visibility is available', async () => {
    expect(await exports['CreateScalableFontResourceA'](null as never, memory,
        [1, put(16, 'c:\\game\\lsans.fot'), put(256, 'lsans.ttf'), put(512, 'c:\\game')])).toBe(0);
    expect(lastError).toBe(120);
    expect(files.has('c:\\game\\lsans.fot')).toBe(false);
});
