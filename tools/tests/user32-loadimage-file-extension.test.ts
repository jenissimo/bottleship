/**
 * LoadImage(NULL, path, IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE) reads the file it is given.
 *
 * Whether a file is a bitmap is decided by its BITMAPFILEHEADER, not by its name. The
 * loader used to open only names ending in ".bmp"; a title that ships its bitmaps under
 * another extension got handles without pixels and drew none of its sprites.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { createSystemExports } from '../../src/worker/modules/user32/system';

const IMAGE_BITMAP = 0;
const LR_LOADFROMFILE = 0x0010;
const LR_CREATEDIBSECTION = 0x2000;

/** A 2x2 24-bit bottom-up BMP: red, green / blue, white (top row first). */
function bmp2x2(): Uint8Array {
    const rowSize = 8, dataSize = rowSize * 2, size = 54 + dataSize;
    const b = new Uint8Array(size), v = new DataView(b.buffer);
    b[0] = 0x42; b[1] = 0x4d;
    v.setUint32(2, size, true); v.setUint32(10, 54, true);
    v.setUint32(14, 40, true); v.setInt32(18, 2, true); v.setInt32(22, 2, true);
    v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, dataSize, true);
    b.set([255, 0, 0, 255, 255, 255], 54);        // bottom row: blue, white (BGR)
    b.set([0, 0, 255, 0, 255, 0], 54 + rowSize);  // top row: red, green
    return b;
}

interface LoadedObject {
    width: number; height: number; pixels: Uint8Array | null; bitCount?: number; loading: boolean;
}

async function load(path: string, flags: number, files: Record<string, Uint8Array>) {
    const NAME = 0x20000;
    const big = new Uint8Array(NAME + 0x200);
    for (let i = 0; i < path.length; i++) big[NAME + i] = path.charCodeAt(i);
    const objects: LoadedObject[] = [];
    const opened: string[] = [];
    const released: number[] = [];
    let lastError = 0;
    const fake = {
        resourceProvider: {
            registerUserObject: (o: LoadedObject) => { objects.push(o); return 0x5000 + objects.length; },
            getUserObject: (h: number) => objects[h - 0x5001],
            unregisterUserObject: (h: number) => { released.push(h); return objects[h - 0x5001]; },
        },
        scheduler: { setLastError: (e: number) => { lastError = e; } },
        fileSystem: {
            open: async (p: string) => { opened.push(p); return files[p] ? { path: p, source: 'test' } : null; },
            getFileSize: (p: string) => files[p]?.length ?? 0,
            read: async (h: { path: string }) => files[h.path],
        },
        process: { getModule: () => null },
    };
    const system = spyOn(System, 'getInstance').mockReturnValue(fake as unknown as System);
    try {
        const loadImage = createSystemExports().LoadImageA as unknown as
            (ctx: unknown, mem: Uint8Array, args: number[]) => Promise<number>;
        const handle = await loadImage({}, big, [0, NAME, IMAGE_BITMAP, 0, 0, flags]);
        return { handle, object: objects[0], opened, released, lastError };
    } finally { system.mockRestore(); }
}

describe('LoadImage from a file', () => {
    test('LR_LOADFROMFILE loads a bitmap whose name does not end in .bmp', async () => {
        const r = await load('data\\Title.pbm', LR_LOADFROMFILE | LR_CREATEDIBSECTION, { 'data/Title.pbm': bmp2x2() });
        expect(r.opened).toEqual(['data/Title.pbm']);
        expect(r.handle).not.toBe(0);
        expect([r.object.width, r.object.height]).toEqual([2, 2]);
        expect(r.object.pixels).toBeTruthy();
        expect(r.object.bitCount).toBe(24);
        expect(r.object.loading).toBe(false);
    });

    test('a .bmp name loads with and without the flag, as before', async () => {
        const files = { 'art/a.bmp': bmp2x2() };
        expect((await load('art\\a.bmp', LR_LOADFROMFILE, files)).object.pixels).toBeTruthy();
        expect((await load('art\\a.bmp', 0, files)).object.pixels).toBeTruthy();
    });

    test('LR_LOADFROMFILE on a file that is not a bitmap returns NULL and keeps no handle', async () => {
        const r = await load('data\\readme.dat', LR_LOADFROMFILE, { 'data/readme.dat': new Uint8Array(64) });
        expect(r.opened).toEqual(['data/readme.dat']);
        expect(r.handle).toBe(0);
        expect(r.released).toEqual([0x5001]);
        expect(r.object.loading).toBe(false);
    });

    test('LR_LOADFROMFILE on a missing file returns NULL with ERROR_FILE_NOT_FOUND', async () => {
        const r = await load('data\\Missing.pbm', LR_LOADFROMFILE, {});
        expect(r.opened).toEqual(['data/Missing.pbm']);
        expect(r.handle).toBe(0);
        expect(r.released).toEqual([0x5001]);
        expect(r.lastError).toBe(2);
    });

    test('a title that probes names until one loads gets the one that exists', async () => {
        const files = { 'gfx/logo.pbm': bmp2x2() };
        const first = await load('gfx\\logo.bmp', LR_LOADFROMFILE, files);
        const second = await load('gfx\\logo.pbm', LR_LOADFROMFILE, files);
        expect(first.handle).toBe(0);
        expect(second.handle).not.toBe(0);
        expect(second.object.pixels).toBeTruthy();
    });

    test('a missing .bmp name without the flag keeps its pixel-less handle', async () => {
        const r = await load('art\\gone.bmp', 0, {});
        expect(r.handle).not.toBe(0);
        expect(r.released).toEqual([]);
        expect(r.object.pixels).toBeNull();
    });
});
