import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { addMemoryFontResource, removeMemoryFontResource, installedFontCoverage } from './font-resource';
import { encodeGlyphSet } from './sfnt-coverage.mjs';

export function registerFontExtraExports(exports: Record<string, ThunkImplementation>): void {
    exports['AddFontMemResourceEx'] = (_ctx, mem, args): number | Promise<number> => {
        const [data, size, reserved, count] = args.map(n => n >>> 0);
        if (!data || !size || reserved || !count || data + size > mem.length || count + 4 > mem.length) return 0;
        if (!Mem.writeUint32(count, 0)) return 0;
        const process = System.getInstance().process;
        const owned = new Uint8Array(size);
        owned.set(mem.subarray(data, data + size));
        return addMemoryFontResource(owned).then<number>((handle): number => {
            if (System.getInstance().process !== process) return 0;
            if (!handle) return 0;
            if (!Mem.writeUint32(count, 1)) { removeMemoryFontResource(handle); return 0; }
            return handle;
        });
    };
    exports['RemoveFontMemResourceEx'] = (_ctx, _mem, args) => removeMemoryFontResource(args[0]) ? 1 : 0;

    exports['GetTextFaceW'] = (_ctx, mem, args) => {
        const [hdc, rawCount, rawOut] = args, count = rawCount | 0, out = rawOut >>> 0;
        const gdi = System.getInstance().gdiContext;
        if (!gdi.hdcStates.has(hdc)) return 0;
        const name = gdi.getSelectedFontFace(hdc);
        if (!out) return name.length + 1;
        if (count <= 0) return 0;
        const n = Math.min(count - 1, name.length);
        const size = (n + 1) * 2;
        if (out + size > mem.length) return 0;
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < n; i++) view.setUint16(i * 2, name.charCodeAt(i), true);
        return Mem.writeBytes(out, bytes) === bytes.length ? n + 1 : 0;
    };

    exports['GetFontUnicodeRanges'] = (_ctx, mem, args) => {
        const gdi = System.getInstance().gdiContext;
        if (!gdi.hdcStates.has(args[0])) return 0;
        const coverage = installedFontCoverage(gdi.getSelectedFontFace(args[0]));
        if (!coverage) return 0;
        const out = args[1] >>> 0;
        const size = 16 + coverage.ranges.length * 4;
        if (!out) return size;
        if (out + size > mem.length) return 0;
        const bytes = encodeGlyphSet(coverage);
        return Mem.writeBytes(out, bytes) === bytes.length ? bytes.length : 0;
    };
}
