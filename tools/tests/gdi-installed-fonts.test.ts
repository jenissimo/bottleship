/**
 * Fonts in %windir%\Fonts are selectable by face name with no AddFontResource call, and
 * an installed face is drawn as itself rather than through the bundled substitute.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { resolveWindowsFontName } from '../../src/worker/modules/gdi32/font-map';
import { addFontResource, isInstalledFontName, removeFontResource, resetFontResources } from '../../src/worker/modules/gdi32/font-resource';
import { installWindowsFonts } from '../../src/worker/modules/gdi32/installed-fonts';

const font = (name: string) => new Uint8Array(readFileSync(new URL(`../../public/fonts/${name}`, import.meta.url)));
const FILES: Record<string, Uint8Array> = {
    'LiberationSans-Bold.ttf': font('LiberationSans-Bold.ttf'),
    'LiberationSerif-Regular.ttf': font('LiberationSerif-Regular.ttf'),
    'readme.txt': new Uint8Array([1, 2, 3]),
};
const system = System.getInstance();
const oldVfs = system.fileSystem;
const originalFontFace = globalThis.FontFace;
const originalSelf = globalThis.self;
let created: string[];

beforeEach(() => {
    created = [];
    globalThis.FontFace = class {
        constructor(family: string) { created.push(family); }
        async load() { return this; }
    } as unknown as typeof FontFace;
    globalThis.self = { fonts: { add() {}, delete() {} } } as never;
    system.fileSystem = {
        listDirectory: (path: string) => path === 'C:\\WINDOWS\\Fonts'
            ? Object.entries(FILES).map(([name, data]) => ({ path: `${path}\\${name}`, name, kind: 'file', size: data.length, source: 'rom' }))
            : [],
        resolvePath: (path: string) => path.toLowerCase(),
        open: async (path: string) => ({ name: path.split('\\').pop() }),
        read: async (handle: { name: string }) => FILES[handle.name]!,
    } as never;
});

afterEach(() => {
    for (const name of Object.keys(FILES)) removeFontResource(`c:\\windows\\fonts\\${name.toLowerCase()}`, 0);
    resetFontResources();
    system.fileSystem = oldVfs;
    globalThis.FontFace = originalFontFace;
    globalThis.self = originalSelf;
});

test('every font file in the Fonts folder is installed', async () => {
    expect(await installWindowsFonts()).toBe(2);
    expect(created).toEqual(['Liberation Sans', 'Liberation Sans Bold', 'Liberation Serif']);
    expect(isInstalledFontName('Liberation Sans Bold')).toBe(true);
});

test('an installed face is used as is, ahead of the bundled substitute', async () => {
    expect(resolveWindowsFontName('Times New Roman')).toBe('Liberation Serif');
    FILES['TIMES.TTF'] = sfntNamed('Times New Roman');
    try {
        await installWindowsFonts();
        expect(resolveWindowsFontName('times new roman')).toBe('times new roman');
    } finally {
        delete FILES['TIMES.TTF'];
        removeFontResource('c:\\windows\\fonts\\times.ttf', 0);
    }
});

test('a new container drops fonts installed by the previous game', async () => {
    await installWindowsFonts();
    expect(isInstalledFontName('Liberation Sans Bold')).toBe(true);
    system.fileSystem = {listDirectory: () => []} as never;
    expect(await installWindowsFonts()).toBe(0);
    expect(isInstalledFontName('Liberation Sans Bold')).toBe(false);
});

test('a pending font load cannot reappear after container reset', async () => {
    let finish!: () => void;
    let added = 0;
    globalThis.FontFace = class {
        async load() {await new Promise<void>(resolve => {finish = resolve;}); return this;}
    } as unknown as typeof FontFace;
    globalThis.self = {fonts: {add() {added++;}, delete() {}}} as never;
    const pending = addFontResource('pending.ttf', sfntNamed('Old Game'));
    resetFontResources();
    finish();
    expect(await pending).toBe(0);
    expect(added).toBe(0);
    expect(isInstalledFontName('Old Game')).toBe(false);
});

/** An sfnt holding only a 'name' table with one Windows family record (FontFace is mocked). */
function sfntNamed(family: string): Uint8Array {
    const nameOffset = 12 + 16, strings = 6 + 12;
    const bytes = new Uint8Array(nameOffset + strings + family.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, 1);
    view.setUint32(12, 0x6e616d65);
    view.setUint32(20, nameOffset);
    view.setUint32(24, bytes.length - nameOffset);
    view.setUint16(nameOffset + 2, 1);
    view.setUint16(nameOffset + 4, strings);
    for (const [i, v] of [3, 1, 0x409, 1, family.length * 2, 0].entries()) view.setUint16(nameOffset + 6 + i * 2, v);
    for (let i = 0; i < family.length; i++) view.setUint16(nameOffset + strings + i * 2, family.charCodeAt(i));
    return bytes;
}
