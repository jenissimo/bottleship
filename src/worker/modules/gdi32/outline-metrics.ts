/**
 * GetCharABCWidthsFloat: the unrounded A/B/C spacing of a range of characters.
 *
 * The W entry point takes UTF-16 code units. The A entry point takes character codes in
 * the code page of the font selected into the DC — its realised charset, not the system
 * ANSI page — and on a multi-byte page a code above 0xFF is a packed two-byte character.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { isValidAddress } from '../../core/memory/address-guard';
import { decodeAnsiCharRange, fontCodePage } from './font-charset';

interface GlyphBox { width: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number }
interface Measurer { measureText(text: string): GlyphBox }

export function registerOutlineMetricsExports(exports: Record<string, ThunkImplementation>): void {
    // BOOL GetCharABCWidthsFloat(HDC hdc, UINT iFirst, UINT iLast, LPABCFLOAT lpABC)
    const abcWidthsFloat = (wide: boolean): ThunkImplementation => (_ctx, mem, args): number => {
        const hdc = args[0];
        const iFirst = args[1] >>> 0;
        const iLast = args[2] >>> 0;
        const lpABC = args[3];
        if (!lpABC || iLast < iFirst || iLast > 0xffff) return 0;
        const count = iLast - iFirst + 1;
        if (!isValidAddress(mem, lpABC, count * 12, 'rw')) return 0;
        const gdi = System.getInstance().gdiContext;
        const dcCtx = gdi.getMeasureContext(hdc) as unknown as Measurer | null;
        if (!dcCtx) return 0;

        let characters: string[] | null;
        if (wide) {
            characters = Array.from({ length: count }, (_, i) => String.fromCharCode(iFirst + i));
        } else {
            const charset = gdi.getSelectedFontCharset(hdc);
            characters = charset === null ? null : decodeAnsiCharRange(iFirst, iLast, fontCodePage(charset));
        }
        if (!characters) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < count; i++) {
            const g = dcCtx.measureText(characters[i]!);
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
    exports['GetCharABCWidthsFloatA'] = abcWidthsFloat(false);
    exports['GetCharABCWidthsFloatW'] = abcWidthsFloat(true);
}
