/**
 * The browser's font sanitizer rejects a format-4 cmap with a language id; GDI ignores
 * it. Clearing it on the Unicode/Windows subtables loads the font while leaving the
 * Macintosh subtable, where the field means something, as it was.
 */
import { expect, test } from 'bun:test';
import { clearUnicodeCmapLanguages } from '../../src/worker/modules/gdi32/font-resource';

/** sfnt with one 'cmap' table: a Mac format-0 and a Windows format-4 subtable, both language 1. */
function fontWithCmapLanguages(): { bytes: Uint8Array; macLanguage: number; winLanguage: number } {
    const cmap = 12 + 16, mac = 4 + 2 * 8, win = mac + 6;
    const bytes = new Uint8Array(cmap + win + 14);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, 1);
    view.setUint32(12, 0x636d6170);
    view.setUint32(20, cmap);
    view.setUint32(24, bytes.length - cmap);
    view.setUint16(cmap + 2, 2);
    for (const [i, [platform, encoding, offset]] of [[1, 0, mac], [3, 1, win]].entries()) {
        view.setUint16(cmap + 4 + i * 8, platform!);
        view.setUint16(cmap + 6 + i * 8, encoding!);
        view.setUint32(cmap + 8 + i * 8, offset!);
    }
    view.setUint16(cmap + mac, 0);
    view.setUint16(cmap + mac + 4, 1);
    view.setUint16(cmap + win, 4);
    view.setUint16(cmap + win + 4, 1);
    return { bytes, macLanguage: cmap + mac + 4, winLanguage: cmap + win + 4 };
}

test('the Windows format-4 subtable loses its language id, the Mac one keeps it', () => {
    const { bytes, macLanguage, winLanguage } = fontWithCmapLanguages();
    clearUnicodeCmapLanguages(bytes);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(winLanguage)).toBe(0);
    expect(view.getUint16(macLanguage)).toBe(1);
});

test('a blob that is not an sfnt is left alone', () => {
    const bytes = new Uint8Array(32).fill(7);
    clearUnicodeCmapLanguages(bytes);
    expect([...bytes]).toEqual(new Array(32).fill(7));
});
