/**
 * System cursor shapes (IDC_*) — the emulated OS's pointer theme, the same idea
 * as the built-in control classes: resources real user32 ships. LoadCursor and
 * the built-in class cursors resolve here to REAL cursor user objects
 * (type 'CURSOR', RGBA pixels + hotspot), so the classic pointer reaches the
 * host through the exact channel game-authored cursors use — the host renders
 * whatever image is installed and needs no theme knowledge of its own.
 */

import { System } from '../../core/system';

export const IDC_ARROW = 32512;
export const IDC_IBEAM = 32513;

// 'X' = black, '.' = white, ' ' = transparent.
interface SystemCursorShape {
    map: readonly string[];
    hotspotX: number;
    hotspotY: number;
}

const ARROW_SHAPE: SystemCursorShape = {
    map: [
        'X           ',
        'XX          ',
        'X.X         ',
        'X..X        ',
        'X...X       ',
        'X....X      ',
        'X.....X     ',
        'X......X    ',
        'X.......X   ',
        'X........X  ',
        'X.....XXXXX ',
        'X..X..X     ',
        'X.X X..X    ',
        'XX  X..X    ',
        'X    X..X   ',
        '     X..X   ',
        '      X..X  ',
        '      X..X  ',
        '       XX   ',
    ],
    hotspotX: 0,
    hotspotY: 0,
};

const IBEAM_SHAPE: SystemCursorShape = {
    map: [
        'XX XX',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        '  X  ',
        'XX XX',
    ],
    hotspotX: 2,
    hotspotY: 7,
};

const SYSTEM_CURSOR_SHAPES: ReadonlyMap<number, SystemCursorShape> = new Map([
    [IDC_ARROW, ARROW_SHAPE],
    [IDC_IBEAM, IBEAM_SHAPE],
]);

function rasterizeShape(map: readonly string[]): { width: number; height: number; pixels: Uint8Array } {
    const height = map.length;
    const width = Math.max(...map.map((row) => row.length));
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = map[y];
        for (let x = 0; x < row.length; x++) {
            const ch = row[x];
            if (ch === ' ') continue;
            const o = (y * width + x) * 4;
            const v = ch === 'X' ? 0 : 255;
            pixels[o] = v;
            pixels[o + 1] = v;
            pixels[o + 2] = v;
            pixels[o + 3] = 255;
        }
    }
    return { width, height, pixels };
}

// IDC id → registered user-object handle. System cursors are shared singletons
// (real Windows: LoadCursor(NULL, IDC_*) returns the same handle every call).
const systemCursorHandles = new Map<number, number>();

/** Cursor user object for an IDC_* id; unknown ids share the arrow shape. */
export function getSystemCursorHandle(idcId: number): number {
    const id = SYSTEM_CURSOR_SHAPES.has(idcId) ? idcId : IDC_ARROW;
    const cached = systemCursorHandles.get(id);
    // Re-register if the cached handle no longer resolves: this cache and the user-object
    // table are cleared by different resets, and a shared system cursor that stops
    // resolving would leave the host with a visible pointer and no shape to draw.
    if (cached && System.getInstance().resourceProvider.getUserObject?.(cached)) return cached;
    const shape = SYSTEM_CURSOR_SHAPES.get(id)!;
    const { width, height, pixels } = rasterizeShape(shape.map);
    const handle = System.getInstance().resourceProvider.registerUserObject({
        type: 'CURSOR',
        width,
        height,
        pixels,
        loading: false,
        xHotspot: shape.hotspotX,
        yHotspot: shape.hotspotY,
        systemCursorId: id,
    });
    systemCursorHandles.set(id, handle);
    return handle;
}

export function resetSystemCursorHandles(): void {
    systemCursorHandles.clear();
}
