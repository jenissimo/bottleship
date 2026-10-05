/**
 * The DPI-dependent system metrics, as win32u get_system_metrics_for_dpi derives them:
 * each is a 96-DPI SPI/metric value run through map_to_dpi. At 96 DPI every entry
 * equals what GetSystemMetrics and SPI_GETNONCLIENTMETRICS report — the unscaled
 * values below are those same numbers, and a change to one side must change the other.
 */

import { mapToDpi } from './monitor';

const SM_CXVSCROLL = 2, SM_CYHSCROLL = 3, SM_CYCAPTION = 4;
const SM_CYVTHUMB = 9, SM_CXHTHUMB = 10, SM_CXICON = 11, SM_CYICON = 12;
const SM_CXCURSOR = 13, SM_CYCURSOR = 14, SM_CYMENU = 15;
const SM_CYVSCROLL = 20, SM_CXHSCROLL = 21;
const SM_CXSIZE = 30, SM_CYSIZE = 31, SM_CXFRAME = 32, SM_CYFRAME = 33;
const SM_CXICONSPACING = 38, SM_CYICONSPACING = 39;
const SM_CXSMICON = 49, SM_CYSMICON = 50, SM_CYSMCAPTION = 51;
const SM_CXSMSIZE = 52, SM_CYSMSIZE = 53, SM_CXMENUSIZE = 54, SM_CYMENUSIZE = 55;
const SM_CXMENUCHECK = 71, SM_CYMENUCHECK = 72;

/** NONCLIENTMETRICS at 96 DPI (SPI_GETNONCLIENTMETRICS in system.ts). */
export const NCM_BORDER_WIDTH = 1;
export const NCM_SCROLL_WIDTH = 16;
export const NCM_CAPTION_WIDTH = 18;
export const NCM_CAPTION_HEIGHT = 18;
export const NCM_SM_CAPTION_WIDTH = 12;
export const NCM_SM_CAPTION_HEIGHT = 14;
export const NCM_MENU_WIDTH = 18;
export const NCM_MENU_HEIGHT = 18;
/** SM_CXDLGFRAME: the fixed part of the sizing frame, not DPI-scaled. */
const DLG_FRAME = 3;
const ICON_SIZE = 32;
const SMALL_ICON_SIZE = 16;
const ICON_SPACING = 75;
/** Menu font cell height at 96 DPI; the check-mark cell is derived from it. */
const MENU_FONT_CELL = 13;

/** The metric at `dpi`, or null when the index does not depend on DPI. */
export function systemMetricForDpi(index: number, dpi: number): number | null {
    switch (index | 0) {
        case SM_CXVSCROLL:
        case SM_CYHSCROLL:
        case SM_CYVTHUMB:
        case SM_CXHTHUMB:
        case SM_CYVSCROLL:
        case SM_CXHSCROLL:
            return Math.max(mapToDpi(NCM_SCROLL_WIDTH, dpi), 8);
        case SM_CYCAPTION:
            return mapToDpi(NCM_CAPTION_HEIGHT, dpi) + 1;
        case SM_CXICON:
        case SM_CYICON:
            return mapToDpi(ICON_SIZE, dpi);
        case SM_CXCURSOR:
        case SM_CYCURSOR: {
            const size = mapToDpi(ICON_SIZE, dpi);
            return size >= 64 ? 64 : size >= 48 ? 48 : 32;
        }
        case SM_CYMENU:
            return mapToDpi(NCM_MENU_HEIGHT, dpi) + 1;
        case SM_CXSIZE:
            return Math.max(mapToDpi(NCM_CAPTION_WIDTH, dpi), 8);
        case SM_CYSIZE:
            return mapToDpi(NCM_CAPTION_HEIGHT, dpi);
        case SM_CXFRAME:
        case SM_CYFRAME:
            return DLG_FRAME + Math.max(mapToDpi(NCM_BORDER_WIDTH, dpi), 1);
        case SM_CXICONSPACING:
        case SM_CYICONSPACING:
            return mapToDpi(ICON_SPACING, dpi);
        case SM_CXSMICON:
        case SM_CYSMICON:
            return mapToDpi(SMALL_ICON_SIZE, dpi) & ~1;
        case SM_CYSMCAPTION:
            return mapToDpi(NCM_SM_CAPTION_HEIGHT, dpi) + 1;
        case SM_CXSMSIZE:
            return mapToDpi(NCM_SM_CAPTION_WIDTH, dpi);
        case SM_CYSMSIZE:
            return mapToDpi(NCM_SM_CAPTION_HEIGHT, dpi);
        case SM_CXMENUSIZE:
            return mapToDpi(NCM_MENU_WIDTH, dpi);
        case SM_CYMENUSIZE:
            return mapToDpi(NCM_MENU_HEIGHT, dpi);
        case SM_CXMENUCHECK:
        case SM_CYMENUCHECK:
            return (mapToDpi(MENU_FONT_CELL, dpi) - 1) | 1;
        default:
            return null;
    }
}

export const SM_CXFRAME_INDEX = SM_CXFRAME;
export const SM_CYCAPTION_INDEX = SM_CYCAPTION;
export const SM_CYMENU_INDEX = SM_CYMENU;
