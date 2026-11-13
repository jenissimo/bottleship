import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { EmulatorConfig, getCodePageDecoder, isSingleByteCodePage } from '../../core/emulator-config-manager';
import { MemoryGuard } from '../../core/memory/mem-guard';
import { isValidAddress } from '../../core/memory/address-guard';
import { Logger, LogCategory } from '../../core/logger';

const GLYPH_DBCS_LABELS: Readonly<Record<number, string>> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };
// @transient(pure host decoders for glyph character codes)
const glyphDecoders = new Map<number, TextDecoder>();

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
        const bytes = !isSingleByteCodePage(codePage) && uChar > 0xFF
            ? new Uint8Array([(uChar >> 8) & 0xFF, uChar & 0xFF])
            : new Uint8Array([uChar & 0xFF]);
        const label = GLYPH_DBCS_LABELS[codePage];
        if (!label) return getCodePageDecoder(codePage).decode(bytes);
        let decoder = glyphDecoders.get(codePage);
        if (!decoder) { decoder = new TextDecoder(label); glyphDecoders.set(codePage, decoder); }
        return decoder.decode(bytes);
    }

    // GetGlyphOutlineA/W(hdc, uChar, uFormat, lpgm, cbBuffer, lpvBuffer, lpmat2). uChar is a
    // raw character code (A: one ANSI byte or packed DBCS pair decoded via the guest's code
    // page, W: a UTF-16 code unit) — GGO_GLYPH_INDEX (uChar as a real font glyph ID) and any
    // non-identity lpmat2 (rotation/shear/scale) are rejected rather than silently answered
    // wrong, since this emulator has no glyph-index table and applies no transform to the
    // rasterized bitmap.
    const outline = (isWide: boolean): ThunkImplementation => (ctx, mem, args) => {
        const hdc = args[0]!;
        const uChar = args[1]! >>> 0;
        const uFormat = args[2]! >>> 0;
        const lpgm = args[3]!;
        const cbBuffer = args[4]! >>> 0;
        const lpvBuffer = args[5]!;
        const lpmat2 = args[6]!;
        const GDI_ERROR = 0xFFFFFFFF;

        const rasterFormat = uFormat & ~0x100; // GGO_UNHINTED is advisory for the host rasterizer.
        if ((rasterFormat & ~0x0f) !== 0) return GDI_ERROR;
        if (lpmat2) {
            if (!isValidAddress(mem, lpmat2, 16, 'r')) return GDI_ERROR;
            if (!isIdentityMat2(mem, lpmat2)) return GDI_ERROR;
        }

        const char = isWide
            ? String.fromCharCode(uChar & 0xFFFF)
            : decodeAnsiChar(uChar, EmulatorConfig.getInstance().ansiCodePage);

        const gdi = System.getInstance().gdiContext;
        const result = gdi.getGlyphOutline(hdc, char, rasterFormat);
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
    exports['GetGlyphOutlineA'] = outline(false);
    exports['GetGlyphOutlineW'] = outline(true);

    // GetKerningPairsA/W(hdc, nPairs, lpKernPair): this emulator does not parse a font's
    // kerning table, so it reports zero pairs — a legitimate answer for any font that
    // genuinely has none, and the one native GDI also gives before a face's kern table loads.
    exports['GetKerningPairsA'] = (): number => 0;
    exports['GetKerningPairsW'] = exports['GetKerningPairsA'];

}
