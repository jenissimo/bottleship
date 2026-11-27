import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';
import { coCreateMlang } from '../../src/worker/modules/ole32-mlang-font-link';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { createPaintingExports } from '../../src/worker/modules/gdi32/painting';
import { installedFontCoverage, registeredFontFamilies, resetFontResources } from '../../src/worker/modules/gdi32/font-resource';
import { parseSfntCoverage } from '../../src/worker/modules/gdi32/sfnt-coverage.mjs';

const font = new Uint8Array(readFileSync(new URL('../../public/fonts/LiberationSans-Regular.ttf', import.meta.url)));
const coverage = parseSfntCoverage(font)!;
const system = System.getInstance();
const saved = { gdi: system.gdiContext, process: system.process, FontFace: globalThis.FontFace,
    self: globalThis.self, OffscreenCanvas: globalThis.OffscreenCanvas };
const api = createPaintingExports();
let memory: Uint8Array;
let gdi: GDIContext;
let finishLoad: (() => void) | undefined;
let rejectLoad = false;
let waitLoad: Promise<void> | undefined;
const faces = new Set<unknown>();
let uploaded: Uint8Array[];
let draws: Array<{ text: string; x: number; y: number; font: string; width: number; height: number }>;
let bounds: { actualBoundingBoxLeft: number; actualBoundingBoxRight: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number; width: number };
const view = () => new DataView(memory.buffer);
const call = (name: string, args: number[]) => api[name](null as never, memory, args);

beforeEach(() => {
    resetFontResources(); faces.clear(); uploaded = []; draws = [];
    rejectLoad = false; waitLoad = undefined; finishLoad = undefined;
    memory = new Uint8Array(font.length + 65536);
    Mem.bind(() => memory);
    gdi = new GDIContext(); system.gdiContext = gdi;
    system.process = { getCurrentMemory: () => memory } as never;
    gdi.objects.set(10, { type: 'FONT', handle: 10, faceName: 'Liberation Sans', data: '16px "Liberation Sans"', fontSize: 16 } as never);
    gdi.hdcStates.set(1, { hFont: 10, font: '16px "Liberation Sans"', fontSize: 16 } as never);
    globalThis.self = { fonts: { add: (f: unknown) => faces.add(f), delete: (f: unknown) => faces.delete(f) } } as never;
    globalThis.FontFace = class {
        constructor(_family: string, bytes: ArrayBuffer) { uploaded.push(new Uint8Array(bytes)); }
        async load() { if (waitLoad) await waitLoad; if (rejectLoad) throw Error('font rejected'); return this; }
    } as unknown as typeof FontFace;
    bounds = { actualBoundingBoxLeft: 1.25, actualBoundingBoxRight: 2.25,
        actualBoundingBoxAscent: 2.25, actualBoundingBoxDescent: 1.25, width: 4.5 };
    globalThis.OffscreenCanvas = class {
        constructor(public width: number, public height: number) {}
        getContext() {
            const canvas = this;
            return { font: '', textBaseline: '', textAlign: '', fillStyle: '',
                measureText: () => bounds,
                fillText(text: string, x: number, y: number) {
                    draws.push({ text, x, y, font: this.font, width: canvas.width, height: canvas.height });
                },
                getImageData: () => ({ data: Uint8ClampedArray.from(
                    { length: canvas.width * canvas.height * 4 }, (_, i) => i % 4 === 3 ? 255 : 0) }),
            };
        }
    } as unknown as typeof OffscreenCanvas;
});
afterEach(() => {
    resetFontResources();
    system.gdiContext = saved.gdi; system.process = saved.process;
    globalThis.FontFace = saved.FontFace; globalThis.self = saved.self; globalThis.OffscreenCanvas = saved.OffscreenCanvas;
    Mem.bind(() => saved.process?.getCurrentMemory() ?? new Uint8Array());
});
async function install() {
    memory.set(font, 8192);
    const handle = await call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    expect(typeof handle).toBe('number'); expect(handle).not.toBe(0);
    return handle as number;
}

test('painting export assembly registers the four font APIs', () => {
    for (const name of ['AddFontMemResourceEx', 'RemoveFontMemResourceEx', 'GetTextFaceW', 'GetFontUnicodeRanges'])
        expect(typeof api[name]).toBe('function');
});
test('memory font owns input and writes count through the fresh memory after await', async () => {
    memory.set(font, 8192);
    waitLoad = new Promise<void>(resolve => { finishLoad = resolve; });
    const pending = call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    expect(view().getUint32(64, true)).toBe(0); expect(faces.size).toBe(0);
    const old = memory; memory = old.slice(); old.fill(0);
    finishLoad!(); const handle = await pending;
    expect(handle).not.toBe(0); expect(view().getUint32(64, true)).toBe(1);
    expect(uploaded[0][1]).toBe(1); expect(faces.size).toBeGreaterThan(0);
    expect(registeredFontFamilies()).not.toContain('Liberation Sans');
    expect(call('RemoveFontMemResourceEx', [handle as number])).toBe(1);
    expect(call('RemoveFontMemResourceEx', [handle as number])).toBe(0); expect(faces.size).toBe(0);
});
test('load failure and container reset cannot publish a success handle', async () => {
    memory.set(font, 8192); rejectLoad = true;
    expect(await call('AddFontMemResourceEx', [8192, font.length, 0, 64])).toBe(0);
    rejectLoad = false; waitLoad = new Promise<void>(resolve => { finishLoad = resolve; });
    const pending = call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    resetFontResources(); finishLoad!();
    expect(await pending).toBe(0); expect(faces.size).toBe(0); expect(view().getUint32(64, true)).toBe(0);
});
test('GetTextFaceW includes NUL; truncated and zero-sized outputs follow the W contract', () => {
    expect(call('GetTextFaceW', [1, 0, 0])).toBe(16);
    expect(call('GetTextFaceW', [1, 32, 128])).toBe(16);
    expect(call('GetTextFaceW', [1, 1, 128])).toBe(1); expect(view().getUint16(128, true)).toBe(0);
    expect(call('GetTextFaceW', [1, 2, 128])).toBe(2); expect(view().getUint16(128, true)).toBe(76);
    expect(view().getUint16(130, true)).toBe(0);
    view().setUint16(128, 1234, true);
    expect(call('GetTextFaceW', [1, 0, 128])).toBe(0); expect(view().getUint16(128, true)).toBe(1234);
    expect(call('GetTextFaceW', [999, 32, 128])).toBe(0);
});
test('real selected font coverage drives GLYPHSET query/fill and bounded failure', async () => {
    await install(); expect(installedFontCoverage('Liberation Sans')?.total).toBe(coverage.total);
    const required = 16 + coverage.ranges.length * 4;
    expect(call('GetFontUnicodeRanges', [1, 0])).toBe(required);
    expect(call('GetFontUnicodeRanges', [1, 128])).toBe(required);
    expect(view().getUint32(136, true)).toBe(coverage.total);
    expect(call('GetFontUnicodeRanges', [1, memory.length - 4])).toBe(0);
});

test('font outputs validate the entire range they write', async () => {
    await install();
    memory.fill(0x7b, 128, 192);
    Mem.bind(() => memory, (address, size, perms) =>
        !perms.includes('w') || address + size <= 130 || address >= 192);

    expect(call('GetTextFaceW', [1, 2, 128])).toBe(0);
    expect(call('GetFontUnicodeRanges', [1, 128])).toBe(0);
    expect(memory.slice(128, 192)).toEqual(new Uint8Array(64).fill(0x7b));
    expect(call('GetTextFaceW', [1, 32, 96])).toBe(16);
});

test('MapFont allocates only for a writable output and rolls back failed publication', async () => {
    await install();
    const handlers: Record<string, ThunkImplementation> = {};
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x1000);
    let next = 0x4000;
    const alloc = (size: number) => { const address = next; next += size; return address; };
    const process = {
        resetGeneration: 0,
        memory: {
            alloc,
            allocSystemBlock: alloc,
            allocAt: () => undefined,
        },
        dispatcher: {
            registerModule: (_module: string, exports: typeof handlers) => Object.assign(handlers, exports),
            applyPendingRegistrations: () => undefined,
        },
        thunkGenerator: generator,
        getCurrentMemory: () => memory,
    };
    expect(coCreateMlang(process as never, '275c23e2-3747-11d0-9fea-00aa003f8646',
        '359f3441-bd4a-11d0-b188-00aa0038c969', 124)).toBe(0);
    const instance = Mem.readUint32(124)!;
    const mapFont = () => handlers.IMLangFontLink_MapFont(null as never, memory, [instance, 1, 1, 10, 128]);
    const handles = [...gdi.objects.keys()];
    const nextHandle = gdi.nextHgdiobj;
    let permittedWrites = 0;
    Mem.bind(() => memory, (address, _size, perms) =>
        address !== 128 || !perms.includes('w') || permittedWrites-- > 0);
    expect(mapFont()).toBe(0x80004003);
    expect(gdi.nextHgdiobj).toBe(nextHandle);
    expect([...gdi.objects.keys()]).toEqual(handles);

    permittedWrites = 1;
    expect(mapFont()).toBe(0x80004003);
    expect([...gdi.objects.keys()]).toEqual(handles);
    expect(Mem.readUint32(128)).toBe(0);

    permittedWrites = 2;
    expect(mapFont()).toBe(0);
    expect(gdi.objects.has(Mem.readUint32(128)!)).toBe(true);
});
