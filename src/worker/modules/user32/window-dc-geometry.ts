import { System } from '../../core/system';
import { windows, getAbsoluteWindowPosition } from './shared-state';

export function syncWindowDCsToGeometry(hWnd: number): void {
    const gdi = System.getInstance().gdiContext;
    if (!gdi?.windowDCsFor) return;
    const window = windows.get(hWnd);
    if (!window) return;
    const { x, y } = getAbsoluteWindowPosition(window);
    for (const hdc of gdi.windowDCsFor(hWnd)) {
        gdi.retargetWindowDC(hdc, x, y, window.width, window.height);
    }
    for (const child of window.children) syncWindowDCsToGeometry(child);
}
