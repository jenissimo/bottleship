import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { decodeAnsiString, getAnsiCodePage } from '../codepage-utils';

/** ETO_OPAQUE fills the supplied rectangle even when the string is empty. */
export function extTextOut(args: number[], wide: boolean): number {
    const [hdc, rawX, rawY, options, rectPtr, textPtr, count, spacingPtr] = args;
    const gdi = System.getInstance().gdiContext;
    const state = gdi.hdcStates.get(hdc);
    if (!state || !gdi.getDC(hdc) || count > 8192 || (options & 0x10)) return 0;
    let text = '';
    if (count) {
        const bytes = textPtr && Mem.readBytes(textPtr, count * (wide ? 2 : 1));
        if (!bytes) return 0;
        if (wide) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < count; i++) text += String.fromCharCode(view.getUint16(i * 2, true));
        } else text = decodeAnsiString(bytes, 0, bytes.length, getAnsiCodePage());
    }
    const paired = (options & 0x2000) !== 0;
    const spacing = spacingPtr && count ? Mem.readBytes(spacingPtr, count * (paired ? 8 : 4)) : null;
    if (spacingPtr && count && !spacing) return 0;
    const spacingView = spacing ? new DataView(spacing.buffer, spacing.byteOffset, spacing.byteLength) : null;
    const advances = spacingView ? Array.from({ length: count * (paired ? 2 : 1) }, (_, i) =>
        spacingView.getInt32(i * 4, true)) : null;
    let rect: { left: number; top: number; right: number; bottom: number } | null = null;
    if (rectPtr && (options & 6)) {
        const bytes = Mem.readBytes(rectPtr, 16);
        if (!bytes) return 0;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        rect = { left: view.getInt32(0, true), top: view.getInt32(4, true), right: view.getInt32(8, true), bottom: view.getInt32(12, true) };
    }
    const previousClip = gdi.getClip(hdc);
    if (rect && (options & 4)) gdi.intersectClipRect(hdc, rect.left, rect.top, rect.right, rect.bottom);
    try {
        if (rect && (options & 2)) gdi.fillRect(hdc, rect.left, rect.top, rect.right, rect.bottom, state.bkColor);
        if (!text) return 1;
        if (!advances) return +gdi.textOut(hdc, rawX | 0, rawY | 0, text);
        const updatePosition = (state.textAlign & 1) !== 0;
        const origin = updatePosition ? gdi.getCurrentPosition(hdc) : { x: rawX | 0, y: rawY | 0 };
        let x = origin.x, y = origin.y;
        const previousAlign = state.textAlign;
        state.textAlign &= ~1;
        try {
            for (let i = 0; i < text.length; i++) {
                if (!gdi.textOut(hdc, x, y, text[i])) return 0;
                x += advances[i * (paired ? 2 : 1)];
                if (paired) y += advances[i * 2 + 1];
            }
        } finally { state.textAlign = previousAlign; }
        if (updatePosition) gdi.setCurrentPosition(hdc, x, y);
        return 1;
    } finally {
        if (rect && (options & 4)) gdi.setClipRegion(hdc, previousClip);
    }
}
