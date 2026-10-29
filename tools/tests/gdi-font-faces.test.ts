/**
 * GDI matches lfFaceName against a font file's family and its full name, and a family
 * asked for in bold or italic picks the file of that style.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { addFontResource, isInstalledFontName, parseSfntFace, removeFontResource } from '../../src/worker/modules/gdi32/font-resource';

const font = (name: string) => new Uint8Array(readFileSync(new URL(`../../public/fonts/${name}`, import.meta.url)));
const BOLD = font('LiberationSans-Bold.ttf');
const ITALIC = font('LiberationSans-Italic.ttf');
const originalFontFace = globalThis.FontFace;
const originalSelf = globalThis.self;
let created: Array<{ family: string; descriptors: FontFaceDescriptors }>;

beforeEach(() => {
    created = [];
    globalThis.FontFace = class {
        constructor(family: string, _src: ArrayBuffer, descriptors: FontFaceDescriptors = {}) {
            created.push({ family, descriptors });
        }
        async load() { return this; }
    } as unknown as typeof FontFace;
    globalThis.self = { fonts: { add() {}, delete() {} } } as never;
});

afterEach(() => {
    removeFontResource('bold.ttf', 0);
    removeFontResource('italic.ttf', 0);
    globalThis.FontFace = originalFontFace;
    globalThis.self = originalSelf;
});

test('parseSfntFace reads the family, full name and style', () => {
    expect(parseSfntFace(BOLD)).toEqual({ family: 'Liberation Sans', fullName: 'Liberation Sans Bold', weight: 700, italic: false });
    expect(parseSfntFace(ITALIC)?.italic).toBe(true);
    expect(parseSfntFace(new Uint8Array(16))).toBeNull();
});

test('a font is registered under its family and full name, with its style', async () => {
    expect(await addFontResource('bold.ttf', BOLD, 0)).toBe(1);
    expect(await addFontResource('italic.ttf', ITALIC, 0)).toBe(1);
    expect(created).toEqual([
        { family: 'Liberation Sans', descriptors: { weight: '700', style: 'normal' } },
        { family: 'Liberation Sans Bold', descriptors: { weight: '700', style: 'normal' } },
        { family: 'Liberation Sans', descriptors: { weight: '400', style: 'italic' } },
        { family: 'Liberation Sans Italic', descriptors: { weight: '400', style: 'italic' } },
    ]);
    expect(isInstalledFontName('LIBERATION SANS BOLD')).toBe(true);
    removeFontResource('bold.ttf', 0);
    expect(isInstalledFontName('Liberation Sans Bold')).toBe(false);
});
