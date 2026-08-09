/**
 * Classic (non-themed) Windows palette and 3D edges.
 *
 * The values are the Windows 98 "Windows Standard" scheme as the control panel
 * ships it, which is what the 1998-2003 titles were drawn against. Shared by every
 * JS-side control painter AND by the GetSysColor table (user32/system.ts), so a
 * window the guest erases with a system brush cannot sit a shade off the controls
 * we paint on it.
 *
 * BTNINNERHI is COLOR_3DLIGHT (ButtonLight), the inner half of a raised bevel —
 * not a lighter BTNFACE.
 */

export const COLOR_BTNFACE = '#C0C0C0';
export const COLOR_BTNHILIGHT = '#FFFFFF';
export const COLOR_BTNINNERHI = '#DFDFDF';
export const COLOR_BTNSHADOW = '#808080';
export const COLOR_BTNDKSHADOW = '#000000';
export const COLOR_WINDOW = '#FFFFFF';
/** COLOR_WINDOWFRAME — the 1px WS_BORDER frame around a window or control. */
export const COLOR_WINDOWFRAME = '#000000';
export const COLOR_WINDOWTEXT = '#000000';
export const COLOR_BTNTEXT = '#000000';
export const COLOR_GRAYTEXT = '#808080';
export const COLOR_HIGHLIGHT = '#000080';
export const COLOR_HIGHLIGHTTEXT = '#FFFFFF';
/** Caption bars: solid navy/grey, with the 98 gradient right-hand stops. */
export const COLOR_ACTIVECAPTION = '#000080';
export const COLOR_ACTIVECAPTION_GRADIENT = '#1084D0';
export const COLOR_INACTIVECAPTION = '#808080';
export const COLOR_INACTIVECAPTION_GRADIENT = '#B5B5B5';

export type Ctx2D = OffscreenCanvasRenderingContext2D;

export function drawRaisedEdge(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    // Outer highlight
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    // Inner highlight
    ctx.fillStyle = COLOR_BTNINNERHI;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), 1);
    ctx.fillRect(x + 1, y + 1, 1, Math.max(1, h - 2));
    // Inner shadow
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x + 1, y + h - 2, Math.max(1, w - 2), 1);
    ctx.fillRect(x + w - 2, y + 1, 1, Math.max(1, h - 2));
    // Outer dark shadow
    ctx.fillStyle = COLOR_BTNDKSHADOW;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

export function drawSunkenEdge(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    // Outer shadow
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    // Inner dark shadow
    ctx.fillStyle = COLOR_BTNDKSHADOW;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), 1);
    ctx.fillRect(x + 1, y + 1, 1, Math.max(1, h - 2));
    // Inner light: the fourth colour of the recipe, and the one whose absence made
    // every sunken field read as a 2px black-to-white step instead of a groove.
    ctx.fillStyle = COLOR_BTNINNERHI;
    ctx.fillRect(x + 1, y + h - 2, Math.max(1, w - 2), 1);
    ctx.fillRect(x + w - 2, y + 1, 1, Math.max(1, h - 2));
    // Outer highlight
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

/**
 * EDGE_ETCHED — the engraved groove a group box and SS_ETCHEDFRAME draw: shadow
 * over highlight on the top/left, highlight over shadow on the bottom/right.
 */
export function drawEtchedEdge(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), 1);
    ctx.fillRect(x + 1, y + 1, 1, Math.max(1, h - 2));
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x + 1, y + h - 2, Math.max(1, w - 2), 1);
    ctx.fillRect(x + w - 2, y + 1, 1, Math.max(1, h - 2));
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

/** Pressed button: the raised bevel collapses to a single dark outline. */
export function drawPressedEdge(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = COLOR_BTNSHADOW;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
}

/**
 * Check box and radio indicators are FIXED-SIZE glyphs (Windows draws them from
 * Marlett), not shapes scaled to the control: SM_CXMENUCHECK-sized 13x13 and 12x12
 * at 96dpi, vertically centred in the control and flush with its left edge.
 */
export const CHECKBOX_SIZE = 13;
export const RADIO_SIZE = 12;

/**
 * Marlett's check, plotted as pixel runs so it stays crisp — a stroked path at
 * this size is a grey smear, and the glyph's asymmetry (the long arm is one row
 * taller than a geometric tick) is what makes it read as Windows'.
 * Row index is offset from the top of the 13x13 indicator.
 */
const CHECK_MASK: readonly string[] = [
    '.........#...',
    '........##...',
    '...#...###...',
    '...##.###....',
    '...#####.....',
    '....###......',
    '.....#.......',
];
const CHECK_MASK_TOP = 3;

/** 12x12 radio: S/D = the sunken ring, L/W its lit half, w the disc, * the dot. */
const RADIO_MASK: readonly string[] = [
    '....SSSS....',
    '..SSDDDDSS..',
    '.SDDwwwwDDW.',
    '.SDwwwwwwLW.',
    'SDwww**wwwLW',
    'SDww****wwLW',
    'SDww****wwLW',
    'SDwww**wwwLW',
    '.SDwwwwwwLW.',
    '.SLLwwwwLLW.',
    '..WWLLLLWW..',
    '....WWWW....',
];

function paintMask(
    ctx: Ctx2D,
    x: number,
    y: number,
    mask: readonly string[],
    colors: Record<string, string | null>,
): void {
    for (let row = 0; row < mask.length; row++) {
        const line = mask[row];
        let col = 0;
        while (col < line.length) {
            const ch = line[col];
            let end = col + 1;
            while (end < line.length && line[end] === ch) end++;
            const color = colors[ch];
            if (color) {
                ctx.fillStyle = color;
                ctx.fillRect(x + col, y + row, end - col, 1);
            }
            col = end;
        }
    }
}

/** The 50% BTNFACE/BTNHIGHLIGHT dither BST_INDETERMINATE fills its field with. */
function fillCheckeredRect(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = COLOR_BTNHILIGHT;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = COLOR_BTNFACE;
    for (let j = 0; j < h; j++) {
        for (let i = (j & 1) ^ 1; i < w; i += 2) ctx.fillRect(x + i, y + j, 1, 1);
    }
}

export interface IndicatorState {
    checked: boolean;
    /** BST_INDETERMINATE: checkered field, shadow-coloured tick. */
    indeterminate?: boolean;
    disabled?: boolean;
    /** Held down: the field greys out, exactly as DFCS_PUSHED does. */
    pushed?: boolean;
}

/** DFCS_BUTTONCHECK / DFCS_BUTTON3STATE at (x, y), CHECKBOX_SIZE square. */
export function drawCheckBoxIndicator(ctx: Ctx2D, x: number, y: number, s: IndicatorState): void {
    const size = CHECKBOX_SIZE;
    if (s.indeterminate) {
        fillCheckeredRect(ctx, x + 2, y + 2, size - 4, size - 4);
    } else {
        ctx.fillStyle = s.disabled || s.pushed ? COLOR_BTNFACE : COLOR_WINDOW;
        ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
    }
    drawSunkenEdge(ctx, x, y, size, size);

    if (!s.checked && !s.indeterminate) return;
    const tick = s.disabled || s.indeterminate ? COLOR_BTNSHADOW : COLOR_WINDOWTEXT;
    paintMask(ctx, x, y + CHECK_MASK_TOP, CHECK_MASK, { '#': tick, '.': null });
}

/** DFCS_BUTTONRADIO at (x, y), RADIO_SIZE square. */
export function drawRadioIndicator(ctx: Ctx2D, x: number, y: number, s: IndicatorState): void {
    const disc = s.disabled || s.pushed ? COLOR_BTNFACE : COLOR_WINDOW;
    const dot = s.checked ? (s.disabled ? COLOR_BTNSHADOW : COLOR_WINDOWTEXT) : disc;
    paintMask(ctx, x, y, RADIO_MASK, {
        '.': null,
        S: COLOR_BTNSHADOW,
        D: COLOR_BTNDKSHADOW,
        L: COLOR_BTNINNERHI,
        W: COLOR_BTNHILIGHT,
        w: disc,
        '*': dot,
    });
}
