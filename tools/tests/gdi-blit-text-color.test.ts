import { expect, test } from 'bun:test';
import { bitBlt, stretchBlt } from '../../src/worker/modules/gdi32/gdi-blit';
import { drawText } from '../../src/worker/modules/gdi32/gdi-text';

for (const stretch of [false, true]) for (const rop of [0x42, 0xff0062]) {
    test(`${stretch ? 'StretchBlt' : 'BitBlt'} solid ROP preserves the next text color`, () => {
        const colors: unknown[] = [];
        const ctx = {
            canvas: {}, font: '', fillStyle: '#000000', textBaseline: 'top', textAlign: 'left',
            measureText: (s: string) => ({width: s.length * 6, fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3}),
            fillText() { colors.push(this.fillStyle); },
            fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
        };
        const state = {font: '12px x', appliedFont: '', fontQuality: 0, fontSize: 12,
            textColor: '#ff0000', textColorValue: 255, appliedFillStyle: '', bkMode: 1, hBitmap: 0};
        const gdi = {
            contexts: new Map([[1, ctx]]), hdcStates: new Map([[1, state]]), overlayCtx: null,
            beginClipOn() {return false;}, clipCopyRect(_h: number, x: number, y: number, w: number, h: number) {return {x,y,w,h};},
            markDirty() {}, expandDirtyRect() {}, invalidateImageDataCache() {}, setOverlayDirty() {}, getLinkedSurface() {return 0;},
        } as never;
        drawText(gdi, 1, 'before');
        const ok = stretch ? stretchBlt(gdi,1,0,0,100,20,0,0,0,100,20,rop) : bitBlt(gdi,1,0,0,100,20,0,0,0,rop);
        expect(ok).toBe(true);
        drawText(gdi, 1, 'after');
        expect(colors).toEqual(['#ff0000', '#ff0000']);
    });
}
