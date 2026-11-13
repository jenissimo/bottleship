/**
 * Outline-font queries: GetOutlineTextMetricsA and GetCharABCWidthsFloat.
 *
 * GetOutlineTextMetrics is how a caller learns a font is TrueType, and a caller that
 * hears "yes" goes on to GetGlyphOutline / GetFontData for the outlines themselves. We
 * cannot serve those, so the answer is the documented one for a non-TrueType font: 0.
 * The caller then lays text out from TEXTMETRIC and draws it with ExtTextOut, which is a
 * path we do render. Answering with metrics alone commits it to glyphs it never gets.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { isValidAddress } from '../../core/memory/address-guard';

interface GlyphBox { width: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number }
interface Measurer { measureText(text: string): GlyphBox }

export function registerOutlineMetricsExports(exports: Record<string, ThunkImplementation>): void {
    // UINT GetOutlineTextMetricsA(HDC hdc, UINT cbData, LPOUTLINETEXTMETRICA lpOTM)
    exports['GetOutlineTextMetricsA'] = (): number => 0;

    // BOOL GetCharABCWidthsFloat(HDC hdc, UINT iFirst, UINT iLast, LPABCFLOAT lpABC)
    const abcWidthsFloat: ThunkImplementation = (_ctx, mem, args): number => {
        const hdc = args[0];
        const iFirst = args[1] >>> 0;
        const iLast = args[2] >>> 0;
        const lpABC = args[3];
        if (!lpABC || iLast < iFirst || iLast > 0xffff) return 0;
        const count = iLast - iFirst + 1;
        if (!isValidAddress(mem, lpABC, count * 12, 'rw')) return 0;
        const dcCtx = System.getInstance().gdiContext.getMeasureContext(hdc) as unknown as Measurer | null;
        if (!dcCtx) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < count; i++) {
            const g = dcCtx.measureText(String.fromCharCode(iFirst + i));
            // A = bearing before the ink, B = ink width, C = bearing after; A + B + C is the advance.
            const a = -g.actualBoundingBoxLeft;
            const b = g.actualBoundingBoxLeft + g.actualBoundingBoxRight;
            const at = lpABC + i * 12;
            view.setFloat32(at, a, true);
            view.setFloat32(at + 4, b, true);
            view.setFloat32(at + 8, g.width - a - b, true);
        }
        return 1;
    };
    exports['GetCharABCWidthsFloatA'] = abcWidthsFloat;
    exports['GetCharABCWidthsFloatW'] = abcWidthsFloat;
}
