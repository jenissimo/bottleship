import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { decodeAnsiString, EmulatorConfig, getCodePageDecoder } from '../../core/emulator-config-manager';
import { decodeAnsiCharCode } from './font-charset';
import { Mem } from '../../core/memory/mem-accessor';
import { MemoryGuard } from '../../core/memory/mem-guard';
import { isValidAddress } from '../../core/memory/address-guard';
import { Logger, LogCategory } from '../../core/logger';
import { dcFontScale } from './painting-dc-state';


export function registerGlyphOutlineExports(exports: Record<string, ThunkImplementation>): void {
    // GLYPHMETRICS layout (offsets in bytes): +0 gmBlackBoxX (UINT) +4 gmBlackBoxY (UINT)
    // +8 gmptGlyphOrigin.x (LONG) +12 gmptGlyphOrigin.y (LONG) +16 gmCellIncX (short)
    // +18 gmCellIncY (short). Total size 20 bytes.
    function writeGlyphMetrics(lpgm: number, g: { blackBoxX: number; blackBoxY: number; originX: number; originY: number; cellIncX: number; cellIncY: number }, mem: Uint8Array): void {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpgm, g.blackBoxX, true);
        view.setUint32(lpgm + 4, g.blackBoxY, true);
        view.setInt32(lpgm + 8, g.originX, true);
        view.setInt32(lpgm + 12, g.originY, true);
        view.setInt16(lpgm + 16, g.cellIncX, true);
        view.setInt16(lpgm + 18, g.cellIncY, true);
    }

    const GLYPHMETRICS_SIZE = 20;

    /** A FIXED (wingdi.h) at `addr`: a 16.16 value, low word fractional, high word integer. */
    function readFixed(view: DataView, addr: number): number {
        const fract = view.getUint16(addr, true);
        const value = view.getInt16(addr + 2, true);
        return value + fract / 65536;
    }

    /** MAT2 (wingdi.h): 4 FIXED values, eM11/eM12/eM21/eM22, 16 bytes total. */
    function isIdentityMat2(mem: Uint8Array, lpmat2: number): boolean {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return readFixed(view, lpmat2) === 1 && readFixed(view, lpmat2 + 4) === 0
            && readFixed(view, lpmat2 + 8) === 0 && readFixed(view, lpmat2 + 12) === 1;
    }

    /** GetGlyphOutlineA's uChar: one ANSI byte on a single-byte code page, or a packed
     *  two-byte DBCS character (lead byte in the high byte, trail byte in the low byte —
     *  e.g. CP932 uChar=0x82A0 is the bytes 0x82,0xA0, the Shift-JIS encoding of 'あ') on a
     *  multi-byte one. Masking to the low byte alone silently decoded the lead byte only. */
    function decodeAnsiChar(uChar: number, codePage: number): string {
        return decodeAnsiCharCode(uChar, codePage)
            ?? getCodePageDecoder(codePage).decode(new Uint8Array([uChar & 0xFF]));
    }

    const GGO_GLYPH_INDEX = 0x80;

    const outline = (isWide: boolean): ThunkImplementation => (ctx, mem, args) => {
        const hdc = args[0]!;
        const uChar = args[1]! >>> 0;
        const uFormat = args[2]! >>> 0;
        const lpgm = args[3]!;
        const cbBuffer = args[4]! >>> 0;
        const lpvBuffer = args[5]!;
        const lpmat2 = args[6]!;
        const GDI_ERROR = 0xFFFFFFFF;

        const indexed = (uFormat & GGO_GLYPH_INDEX) !== 0;
        const gdi = System.getInstance().gdiContext;
        if (indexed && (isWide || uChar > 0xFFFF || !gdi.hdcStates.has(hdc))) return GDI_ERROR;
        const rasterFormat = uFormat & ~(GGO_GLYPH_INDEX | 0x100);
        if ((rasterFormat & ~0x0f) !== 0) return GDI_ERROR;
        if (lpmat2) {
            if (!isValidAddress(mem, lpmat2, 16, 'r')) return GDI_ERROR;
            if (!isIdentityMat2(mem, lpmat2)) return GDI_ERROR;
        }

        const char = isWide || indexed
            ? String.fromCharCode(uChar & 0xFFFF)
            : decodeAnsiChar(uChar, EmulatorConfig.getInstance().ansiCodePage);

        const result = gdi.getGlyphOutline(hdc, char, rasterFormat, dcFontScale(hdc));
        Logger.verbose(LogCategory.GDI32, `GetGlyphOutline${isWide ? 'W' : 'A'}(hdc=0x${hdc.toString(16)}, char='${char}', uFormat=${uFormat})`);
        if (!result) return GDI_ERROR; // unsupported format or rasterization failure

        if (lpgm) {
            if (!isValidAddress(mem, lpgm, GLYPHMETRICS_SIZE, 'rw')) return GDI_ERROR;
            writeGlyphMetrics(lpgm, result, mem);
        }
        if (!result.bitmap) return 1; // GGO_METRICS: no raster, metrics-only success

        const required = result.bitmap.length;
        if (!lpvBuffer || cbBuffer === 0) return required; // size query: lpgm is filled, nothing else to do
        if (cbBuffer < required) return GDI_ERROR;
        if (!isValidAddress(mem, lpvBuffer, required, 'rw')) return GDI_ERROR;
        MemoryGuard.writeBytes(mem, lpvBuffer, result.bitmap, `GetGlyphOutline${isWide ? 'W' : 'A'}`);
        return required;
    };
    exports['GetCharacterPlacementA'] = (_ctx, mem, args) => {
        const [hdc, str, count, , results] = args.map(n => n >>> 0);
        const gdi = System.getInstance().gdiContext, state = gdi.hdcStates.get(hdc);
        if (!state || (count && (!str || !isValidAddress(mem, str, count, 'r')))) return 0;
        if (results && !isValidAddress(mem, results, 36, 'rw')) return 0;
        const bytes = mem.slice(str, str + count);
        const text = decodeAnsiString(bytes, 0, count, EmulatorConfig.getInstance().ansiCodePage);
        const c = new OffscreenCanvas(1, 1).getContext('2d');
        if (!c) return 0;
        c.font = state.font;
        const widths: number[] = [];
        let prev = 0;
        for (let i = 1; i <= text.length; i++) { const w = Math.round(c.measureText(text.slice(0, i)).width); widths.push(w - prev); prev = w; }
        const m = c.measureText('Hg');
        const height = Math.ceil((m.fontBoundingBoxAscent ?? 12) + (m.fontBoundingBoxDescent ?? 4));
        if (results) {
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const n = Math.min(text.length, v.getUint32(results + 28, true) || text.length);
            const outStr = v.getUint32(results + 4, true), order = v.getUint32(results + 8, true), dx = v.getUint32(results + 12, true);
            const caret = v.getUint32(results + 16, true), cls = v.getUint32(results + 20, true), glyphs = v.getUint32(results + 24, true);
            let x = 0;
            for (let i = 0; i < n; i++) {
                if (outStr && !Mem.writeUint8(outStr + i, bytes[i])) return 0;
                if (order && !Mem.writeUint32(order + i * 4, i)) return 0;
                if (dx && !Mem.writeUint32(dx + i * 4, widths[i] | 0)) return 0;
                if (caret && !Mem.writeUint32(caret + i * 4, x)) return 0;
                if (cls && !Mem.writeUint8(cls + i, 0)) return 0;
                if (glyphs && !Mem.writeUint16(glyphs + i * 2, text.charCodeAt(i))) return 0;
                x += widths[i];
            }
            if (!Mem.writeUint32(results + 28, n) || !Mem.writeUint32(results + 32, n)) return 0;
        }
        return ((Math.min(height, 0xffff) << 16) | (Math.min(prev, 0xffff) & 0xffff)) >>> 0;
    };

    exports['GetGlyphOutlineA'] = outline(false);
    exports['GetGlyphOutlineW'] = outline(true);

    // GetKerningPairsA/W(hdc, nPairs, lpKernPair): this emulator does not parse a font's
    // kerning table, so it reports zero pairs — a legitimate answer for any font that
    // genuinely has none, and the one native GDI also gives before a face's kern table loads.
    exports['GetKerningPairsA'] = (): number => 0;
    exports['GetKerningPairsW'] = exports['GetKerningPairsA'];

}
