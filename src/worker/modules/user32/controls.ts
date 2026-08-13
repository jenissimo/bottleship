/**
 * System control rendering for Win32 dialog controls.
 *
 * Draws directly onto the overlay canvas context obtained from the provided HDC.
 * Called from EndPaint after the parent window has finished its own painting,
 * so controls are composited on top of the dialog background.
 */

import { System } from '../../core/system';
import { windows, isEffectivelyVisible, buttonCheckStates, listControlStates, controlImageHandles, getOrCreateTrackbarState, getChildrenInPaintOrder, getAbsoluteWindowPosition, getAncestorClipRect, isFullyCoveredByGuestChild } from './shared-state';
import type { GDIContext } from '../gdi32/context';
import type { WindowInfo } from './shared-state';
import { resolveBitmapRgba, resolveIconRgba, layoutStaticControlImage, blitStaticControlImage } from '../gdi32/bitmap-resolve';
import { Logger, LogCategory } from '../../core/logger';
import {
    fillTextWithMnemonic,
    fillDisabledTextWithMnemonic,
    measureMnemonicText,
    gdiTextMetrics,
    topTextBaseline,
    vcenterTextBaseline,
} from '../win32-text';
import {
    getEditVisualState,
    editLines,
    editVisibleLineCount,
    EDIT_TEXT_INSET,
    editLineHeight,
    editHorizontalScrollRange,
} from './edit-control';
import {
    getRichEditVisualState,
    layoutRichEdit,
    richEditContentRuns,
    richEditRunFont,
    setRichEditScrollTop,
    noteRichEditLayout,
    RICH_EDIT_INSET,
} from './rich-edit-control';
import { getControlColorOverride } from './control-colors';
import { resolveBrushHandle } from './window-drawing';
import {
    COLOR_BTNFACE,
    COLOR_BTNHILIGHT,
    COLOR_BTNINNERHI,
    COLOR_BTNDKSHADOW,
    COLOR_BTNSHADOW,
    COLOR_WINDOW,
    COLOR_WINDOWFRAME,
    COLOR_WINDOWTEXT,
    COLOR_BTNTEXT,
    COLOR_GRAYTEXT,
    COLOR_HIGHLIGHT,
    COLOR_HIGHLIGHTTEXT,
    drawRaisedEdge,
    drawSunkenEdge,
    drawEtchedEdge,
    drawCheckBoxIndicator,
    drawRadioIndicator,
    CHECKBOX_SIZE,
    RADIO_SIZE,
} from './classic-theme';
import {
    SB_WIDTH,
    listBarRect,
    bottomBarRect,
    drawArrowButton,
    listScrollRange,
    paintScrollBarRect,
    scrollFeedbackFor,
} from './scrollbar-paint';
import { getScrollBarState, SB_CTL, SB_HORZ, SB_VERT } from './scroll-state';
import {
    getListViewState,
    clampListViewTopIndex,
    listViewHasHeader,
    listViewRowHeight,
    listViewViewStyle,
    listViewVisibleCount,
    LV_HEADER_H,
    LV_ICON_SIZE,
    LV_SMALL_ICON_SIZE,
    LV_ICON_PAD,
    LV_TEXT_INSET,
    LV_SCROLLBAR_W,
    LVIS_SELECTED,
    LVIS_FOCUSED,
    LVS_ICON,
    LVS_REPORT,
    LVS_SMALLICON,
    LVS_LIST,
    LVS_SHOWSELALWAYS,
} from './list-view-control';
import { restampOwnedPopups } from './paint-hooks';
import { paintTraceEnabled, logChromeStamp } from './paint-trace';


// Window styles
const WS_DISABLED = 0x08000000;

// BST_* values
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;
const BST_INDETERMINATE = 2;
const BST_PUSHED = 4;

// BS_* styles (low nibble)
const BS_TYPEMASK = 0x000F;
const BS_PUSHBUTTON = 0x0000;
const BS_DEFPUSHBUTTON = 0x0001;
const BS_CHECKBOX = 0x0002;
const BS_AUTOCHECKBOX = 0x0003;
const BS_RADIOBUTTON = 0x0004;
const BS_3STATE = 0x0005;
const BS_AUTO3STATE = 0x0006;
const BS_GROUPBOX = 0x0007;
const BS_AUTORADIOBUTTON = 0x0009;
const BS_BITMAP = 0x0080;
const BS_OWNERDRAW = 0x000B;

// SS_* styles
const SS_TYPEMASK = 0x001F;
const SS_LEFT = 0x0000;
const SS_CENTER = 0x0001;
const SS_RIGHT = 0x0002;
const SS_ICON = 0x0003;
const SS_BLACKRECT = 0x0004;
const SS_GRAYRECT = 0x0005;
const SS_WHITERECT = 0x0006;
const SS_BLACKFRAME = 0x0007;
const SS_GRAYFRAME = 0x0008;
const SS_WHITEFRAME = 0x0009;
const SS_SIMPLE = 0x000B;
const SS_LEFTNOWORDWRAP = 0x000C;
const SS_BITMAP = 0x000E;
const SS_ETCHEDHORZ = 0x0010;
const SS_ETCHEDVERT = 0x0011;
const SS_ETCHEDFRAME = 0x0012;
const SS_CENTERIMAGE = 0x0200;
const SS_NOPREFIX = 0x0080;
const SS_REALSIZEIMAGE = 0x0800;

// SBS_* styles
const SBS_VERT = 0x0001;

// Windows classic theme colors and 3D edges live in classic-theme.ts (imported above).

// Font used for control labels
const CONTROL_FONT = "11px 'Liberation Sans', sans-serif";

function getWindowFont(win: WindowInfo): string {
    const parent = win.parent !== undefined ? windows.get(win.parent) : undefined;
    const hFont = win.fontHandle || parent?.fontHandle || 0;
    if (!hFont) return CONTROL_FONT;
    return System.getInstance().gdiContext.getFontCss(hFont) ?? CONTROL_FONT;
}

/**
 * True when paintChildControls puts OS-drawn chrome on the overlay for this child.
 * Its complement is the set of controls whose pixels ONLY the guest can produce, which
 * is why this is one definition with two callers: a repaint that restores the parent's
 * retained client before stamping must restore under THESE and nowhere else, or it
 * erases guest output it cannot re-derive.
 *
 * Defer to a control that has DEMONSTRABLY painted itself (its own EndPaint flushed
 * pixels — child.guestCustomPaint). Subclassing alone is not that claim: MFC's
 * DDX_Control/SubclassDlgItem and UE1's WControl wrap a control purely for message
 * routing and leave WM_PAINT to the original class proc, which IS this chrome. Assuming
 * "subclassed ⇒ guest paints it" left such controls permanently blank (UE1's
 * video-options resolution ListBox: items inserted, nothing drawn). Chrome is painted
 * BEFORE the guest-paint chain runs, so a control the guest really does draw still wins —
 * it simply overwrites what we put down.
 *
 * Owner-draw buttons under a guest-painting parent are the other half: Windows answers
 * those with WM_DRAWITEM to the parent, so paintButton draws nothing for them and only
 * the guest's chain can.
 */
export function paintsOsControlChrome(parent: WindowInfo, child: WindowInfo): boolean {
    if (!child.visible || !child.isSystemControl) return false;
    if (child.guestCustomPaint && !isButtonSystemControl(child) && parent.guestCustomPaint
        && !controlImageHandles.has(child.handle)) return false;
    if (isButtonSystemControl(child)
        && (child.style & BS_TYPEMASK) === BS_OWNERDRAW
        && parent.guestCustomPaint) return false;
    return true;
}

/**
 * Paint all visible system child controls of the given parent window.
 * hdc must be a valid HDC pointing at the overlay canvas (as returned by BeginPaint).
 *
 * The dialog background is painted separately via WM_ERASEBKGND in DefDlgProcA,
 * which runs BEFORE the game's WM_PAINT. This function must NOT re-fill the background
 * because that would overwrite text the game drew in WM_PAINT.
 */
export function paintChildControls(parentHwnd: number, hdc: number, gdi: GDIContext): void {
    const parent = windows.get(parentHwnd);
    if (!parent || !parent.children.length) return;
    // Never paint the controls of a hidden window. A dialog created hidden gets its
    // content messages (LB_ADDSTRING, TBM_SETPOS, …) during WM_INITDIALOG, BEFORE
    // ShowWindow positions it — painting then stamps controls at the stale pre-move
    // origin into the persistent overlay (ghost). ShowWindow repaints once visible.
    // Ancestor-aware: a closed splash dialog keeps its children's WS_VISIBLE bit, and
    // repainting them re-stamps a splash that EndDialog already erased.
    if (!isEffectivelyVisible(parent)) return;

    const ctx = gdi.getDC(hdc);
    if (!ctx) return;

    // child.x, child.y are parent-client-relative coordinates.
    // parent.x, parent.y give the parent's top-left in canvas (screen) space.
    const parentAbsX = getChainX(parent);
    const parentAbsY = getChainY(parent);

    // Win32 clips these controls to every ancestor's client area (see
    // getAncestorClipRect); the flat overlay has no per-window clip of its own.
    const clip = getAncestorClipRect(parent);
    if (clip && (clip.w <= 0 || clip.h <= 0)) return;
    if (clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
    }

    let painted = false;
    for (const childHandle of getChildrenInPaintOrder(parentHwnd)) {
        const child = windows.get(childHandle);
        if (!child || !paintsOsControlChrome(parent, child)) continue;
        painted = paintSystemControl(child, hdc, gdi, parentAbsX, parentAbsY) || painted;
    }

    if (clip) ctx.restore();

    // Open combobox dropdowns paint LAST (topmost among siblings) and OUTSIDE the
    // ancestor clip — Win32's drop-down list is its own ComboLBox popup, free to
    // extend past the parent that owns the closed box.
    for (const childHandle of getChildrenInPaintOrder(parentHwnd)) {
        const child = windows.get(childHandle);
        if (!child || !child.visible || !child.isSystemControl) continue;
        if (normalizeSystemControlClass(child.systemControlClass) !== 'combobox') continue;
        if (!listControlStates.get(child.handle)?.dropdownOpen) continue;
        paintComboDropdown(ctx, child);
        painted = true;
    }

    // Only mark dirty if at least one system control was actually painted
    if (painted) {
        gdi.setOverlayDirty(true);
    }
}

export function paintSystemControl(
    child: WindowInfo,
    hdc: number,
    gdi: GDIContext,
    parentAbsX?: number,
    parentAbsY?: number,
): boolean {
    if (!isEffectivelyVisible(child) || !child.isSystemControl) return false;
    const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
    // See paintChildControls: defer only to a control that has actually painted itself.
    if (child.guestCustomPaint && !isButtonSystemControl(child) && parent?.guestCustomPaint
        && !controlImageHandles.has(child.handle)) return false;
    const ctx = gdi.getDC(hdc);
    if (!ctx) return false;

    const baseX = parentAbsX ?? (parent ? getChainX(parent) : 0);
    const baseY = parentAbsY ?? (parent ? getChainY(parent) : 0);
    const absX = baseX + child.x;
    const absY = baseY + child.y;
    const w = Math.max(1, child.width);
    const h = Math.max(1, child.height);
    const controlClass = normalizeSystemControlClass(child.systemControlClass);

    // A caller that passed parentAbs* is painting a batch and has already clipped to
    // the ancestor chain (paintChildControls); a standalone repaint must do it itself,
    // with the SAME rect (the parent's ancestors, not the parent) so a full repaint and
    // a single-control repaint cannot disagree about what is clipped.
    const clip = parentAbsX === undefined && parent ? getAncestorClipRect(parent) : null;
    if (clip) {
        if (clip.w <= 0 || clip.h <= 0) return false;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
    }

    switch (controlClass) {
        case 'button':
            paintButton(hdc, ctx, child, absX, absY, w, h);
            break;
        case 'static':
            paintStatic(hdc, ctx, child, absX, absY, w, h);
            break;
        case 'sysanimate32':
        case 'sysanimate32_class':
            if (clip) ctx.restore();
            return false;
        case 'edit':
            paintEdit(ctx, child, absX, absY, w, h);
            break;
        case 'richedit':
            paintRichEdit(ctx, child, absX, absY, w, h);
            break;
        case 'combobox':
            paintComboBox(ctx, child, absX, absY, w, h);
            break;
        case 'listbox':
            paintListBox(ctx, child, absX, absY, w, h);
            break;
        case 'syslistview32':
            paintListView(ctx, child, absX, absY, w, h);
            break;
        case 'scrollbar':
            paintScrollBar(ctx, child, absX, absY, w, h);
            break;
        case 'msctls_trackbar32':
            paintTrackbar(ctx, child, absX, absY, w, h);
            break;
        case 'msctls_progress32':
            paintProgressBar(ctx, child, absX, absY, w, h);
            break;
        default:
            paintGenericControl(ctx, child, absX, absY, w, h);
            break;
    }

    if (clip) ctx.restore();
    if (paintTraceEnabled) logChromeStamp(child.handle, `${controlClass} ${w}x${h}`);
    gdi.setOverlayDirty(true);
    return true;
}

export function isButtonSystemControl(win: WindowInfo | undefined): boolean {
    return normalizeSystemControlClass(win?.systemControlClass) === 'button';
}

/**
 * Real Windows' Button class answers WM_NCHITTEST with HTTRANSPARENT for
 * BS_GROUPBOX — a group box never captures mouse input; clicks fall through to
 * whatever's underneath. Dialog templates routinely list a group box AFTER the
 * controls it visually contains (creation order = initial z-order, so the box
 * would otherwise sit "on top" and intercept clicks meant for the control inside
 * it — e.g. TLJ's ComboBox/CheckBox controls precede their enclosing group box).
 * Every hit-test walk must skip group boxes the same way, or every control
 * nested inside one becomes unclickable purely from template ordering.
 */
export function isGroupBoxSystemControl(win: WindowInfo | undefined): boolean {
    return isButtonSystemControl(win) && ((win!.style & BS_TYPEMASK) === BS_GROUPBOX);
}

/** Walk up the parent chain summing x offsets (canvas space). */
// getChainX/Y/Abs must match getAbsoluteWindowPosition exactly: only a WS_CHILD window's
// (x,y) is parent-client-relative, so the walk stops at the first top-level (WS_POPUP)
// ancestor whose position is already screen-absolute. Delegating keeps that one rule in one
// place — a private copy that blindly summed every ancestor pushed a centered #32770's child
// CONTROLS to the owner's origin while the dialog frame sat centered (Airfix launcher split).
function getChainX(win: WindowInfo): number {
    return getAbsoluteWindowPosition(win).x;
}

/** Walk up the parent chain summing y offsets (canvas space). */
function getChainY(win: WindowInfo): number {
    return getAbsoluteWindowPosition(win).y;
}

function normalizeSystemControlClass(controlClass: string | undefined): string {
    return (controlClass ?? '').trim().toLowerCase();
}

function isAnimateControlClass(controlClass: string): boolean {
    return controlClass === 'sysanimate32' || controlClass === 'sysanimate32_class';
}

function isCheckableButtonType(buttonType: number): boolean {
    return buttonType === BS_CHECKBOX
        || buttonType === BS_AUTOCHECKBOX
        || buttonType === BS_3STATE
        || buttonType === BS_AUTO3STATE
        || buttonType === BS_RADIOBUTTON
        || buttonType === BS_AUTORADIOBUTTON;
}

function isControlDisabled(child: WindowInfo): boolean {
    return (child.style & WS_DISABLED) !== 0;
}

function paintPushButton(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
    isDefault: boolean,
    pushed: boolean,
): void {
    if (isDefault && w > 4 && h > 4) {
        ctx.fillStyle = COLOR_WINDOWTEXT;
        ctx.fillRect(x, y, w, h);
        x += 1;
        y += 1;
        w -= 2;
        h -= 2;
    }

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    if (pushed) {
        drawSunkenEdge(ctx, x, y, w, h);
    } else {
        drawRaisedEdge(ctx, x, y, w, h);
    }

    const label = child.title || '';
    if (!label) return;

    const disabled = isControlDisabled(child);
    const tx = pushed ? 1 : 0;
    const ty = pushed ? 1 : 0;
    ctx.font = getWindowFont(child);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const labelY = vcenterTextBaseline(ctx, y, h) + ty;

    if (disabled) {
        fillDisabledTextWithMnemonic(ctx, label, x + w / 2 + tx, labelY, COLOR_BTNHILIGHT, COLOR_GRAYTEXT);
    } else {
        ctx.fillStyle = COLOR_BTNTEXT;
        fillTextWithMnemonic(ctx, label, x + w / 2 + tx, labelY);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

function paintGroupBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const label = child.title || '';

    ctx.font = getWindowFont(child);
    const tm = gdiTextMetrics(ctx);
    const textWidth = label ? Math.ceil(measureMnemonicText(ctx, label)) : 0;
    // Win32 drops the etched frame by half a text cell so the label straddles it,
    // then erases the label's own run of the line (GB_Paint: rcFrame.top +=
    // tmHeight/2, label rect inflated -7 and filled with the parent's brush).
    const frameTop = y + Math.floor(tm.height / 2);
    const textStart = x + 8;

    drawEtchedEdge(ctx, x, frameTop, w, Math.max(2, h - (frameTop - y)));

    if (label) {
        // GB_Paint erases the label's own run of the etched line with the brush the
        // parent returned from WM_CTLCOLORSTATIC, not a hardcoded face (Wine
        // button.c:1011) — a hardcoded grey box is visible on any coloured dialog.
        const labelGround = controlEraseCss(child);
        if (labelGround) {
            ctx.fillStyle = labelGround;
            ctx.fillRect(textStart - 1, y, textWidth + 2, tm.height);
        }
        const colors = getControlColorOverride(child.handle);
        ctx.fillStyle = isControlDisabled(child) ? COLOR_GRAYTEXT
            : (colors?.text ?? COLOR_WINDOWTEXT);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        fillTextWithMnemonic(ctx, label, textStart, topTextBaseline(ctx, y));
        ctx.textBaseline = 'top';
    }
}

function paintCheckableButton(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
    buttonType: number,
): void {
    // CB_Paint fills the WHOLE client with the WM_CTLCOLORSTATIC brush before it draws
    // the box or the label (Wine button.c:867, ODA_DRAWENTIRE) — the indicator lands on
    // top of it. Erasing only the label run leaves the previous caption's anti-aliased
    // edges to compound darker on every repaint.
    eraseControlBackground(ctx, child, x, y, w, h);

    const state = buttonCheckStates.get(child.handle) ?? BST_UNCHECKED;
    const pushed = (state & BST_PUSHED) !== 0;
    const logicalState = state & ~BST_PUSHED;
    const checked = logicalState === BST_CHECKED || logicalState === BST_INDETERMINATE;
    const indeterminate = logicalState === BST_INDETERMINATE;
    const radio = buttonType === BS_RADIOBUTTON || buttonType === BS_AUTORADIOBUTTON;
    const disabled = isControlDisabled(child);

    // The indicator is a fixed 13x13 CELL flush with the control's left edge and
    // centred in its height (Wine button.c CB_Paint: checkBoxWidth = 13, rbox
    // centred by delta/2); the 12x12 radio glyph is then centred inside that cell.
    // Sizing it from the control height instead made a 16px-high check box 12px
    // and a radio 13px, neither of which Windows ever draws.
    const cellX = x;
    const cellY = y + Math.max(0, Math.floor((h - CHECKBOX_SIZE) / 2));
    const indicator = { checked, indeterminate, disabled, pushed };

    if (radio) {
        const inset = (CHECKBOX_SIZE - RADIO_SIZE) >> 1;
        drawRadioIndicator(ctx, cellX + inset, cellY + inset, indicator);
    } else {
        drawCheckBoxIndicator(ctx, cellX, cellY, indicator);
    }

    const label = child.title || '';
    if (!label) return;

    const colors = getControlColorOverride(child.handle);
    const labelX = cellX + CHECKBOX_SIZE + 4;

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const labelY = vcenterTextBaseline(ctx, y, h);
    if (disabled) {
        fillDisabledTextWithMnemonic(ctx, label, labelX, labelY, COLOR_BTNHILIGHT, COLOR_GRAYTEXT);
    } else {
        ctx.fillStyle = colors?.text ?? COLOR_WINDOWTEXT;
        fillTextWithMnemonic(ctx, label, labelX, labelY);
    }
    ctx.textBaseline = 'top';
}

function paintButton(
    hdc: number,
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const buttonType = child.style & BS_TYPEMASK;
    const state = buttonCheckStates.get(child.handle) ?? BST_UNCHECKED;
    const pushed = (state & BST_PUSHED) !== 0;

    if ((child.style & BS_BITMAP) !== 0) {
        paintStaticBitmap(hdc, ctx, child, x, y, w, h);
        const disabled = isControlDisabled(child);
        const pushed = (buttonCheckStates.get(child.handle) ?? 0) & BST_PUSHED;
        if (disabled || pushed) {
            ctx.fillStyle = disabled ? 'rgba(128,128,128,0.45)' : 'rgba(0,0,0,0.15)';
            ctx.fillRect(x, y, w, h);
        }
        return;
    }

    // Owner-draw button: the guest draws the button face via WM_DRAWITEM. If the
    // parent has not painted a custom client yet, draw a default pushbutton fallback
    // so a standard dialog remains usable before/without the guest draw.
    if (buttonType === BS_OWNERDRAW) {
        const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
        const guestPaintsButton = !!parent?.guestCustomPaint;
        if (!guestPaintsButton && (child.title || '').length > 0) {
            paintPushButton(ctx, child, x, y, w, h, false, pushed);
        }
        return;
    }

    if (buttonType === BS_GROUPBOX) {
        paintGroupBox(ctx, child, x, y, w, h);
        return;
    }

    if (isCheckableButtonType(buttonType)) {
        paintCheckableButton(ctx, child, x, y, w, h, buttonType);
        return;
    }

    const isDefault = buttonType === BS_DEFPUSHBUTTON;
    paintPushButton(ctx, child, x, y, w, h, isDefault, pushed);
}

function drawStaticShape(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    styleType: number,
): void {
    switch (styleType) {
        case SS_BLACKRECT:
            ctx.fillStyle = COLOR_WINDOWTEXT;
            ctx.fillRect(x, y, w, h);
            return;
        case SS_GRAYRECT:
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(x, y, w, h);
            return;
        case SS_WHITERECT:
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(x, y, w, h);
            return;
        case SS_BLACKFRAME:
            ctx.strokeStyle = COLOR_WINDOWTEXT;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_GRAYFRAME:
            ctx.strokeStyle = COLOR_BTNSHADOW;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_WHITEFRAME:
            ctx.strokeStyle = COLOR_BTNHILIGHT;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        case SS_ETCHEDHORZ: {
            const lineY = y + Math.floor(h / 2);
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(x, lineY, w, 1);
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(x, lineY + 1, w, 1);
            return;
        }
        case SS_ETCHEDVERT: {
            const lineX = x + Math.floor(w / 2);
            ctx.fillStyle = COLOR_BTNSHADOW;
            ctx.fillRect(lineX, y, 1, h);
            ctx.fillStyle = COLOR_BTNHILIGHT;
            ctx.fillRect(lineX + 1, y, 1, h);
            return;
        }
        case SS_ETCHEDFRAME:
            drawEtchedEdge(ctx, x, y, w, h);
            return;
    }
}

/** Word-wrap one line to maxWidth px. Measures with the mnemonic '&' collapsed (so it
 *  isn't counted as a glyph), matching fillTextWithMnemonic's drawn width. */
function wrapStaticLine(
    ctx: OffscreenCanvasRenderingContext2D,
    line: string,
    maxWidth: number,
    processPrefix: boolean,
): string[] {
    const measure = (s: string): number =>
        ctx.measureText(processPrefix ? s.replace(/&(.?)/g, '$1') : s).width;
    if (line === '' || measure(line) <= maxWidth) return [line];
    const words = line.split(' ');
    const out: string[] = [];
    let cur = '';
    for (const word of words) {
        const test = cur ? `${cur} ${word}` : word;
        if (cur && measure(test) > maxWidth) {
            out.push(cur);
            cur = word;
        } else {
            cur = test;
        }
    }
    if (cur) out.push(cur);
    return out.length ? out : [line];
}

function paintStaticBitmap(
    hdc: number,
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const hBitmap = controlImageHandles.get(child.handle);
    if (!hBitmap) return;

    const mem = System.getInstance().process?.v86?.mem8
        ?? System.getInstance().process?.v86?.v86?.cpu?.mem8;
    const resolved = resolveBitmapRgba(hBitmap, mem);
    if (!resolved) {
        Logger.verbose(LogCategory.USER32, `paintStaticBitmap: no bitmap data for hBitmap=0x${hBitmap.toString(16)}`);
        return;
    }

    const { data, width: bmpW, height: bmpH } = resolved;
    const layout = layoutStaticControlImage(x, y, w, h, bmpW, bmpH, child.style, SS_CENTERIMAGE);
    try {
        blitStaticControlImage(hdc, ctx, data, bmpW, bmpH, x, y, w, h, layout);
    } catch (e) {
        Logger.warn(LogCategory.USER32, `paintStaticBitmap: failed to draw bitmap: ${e}`);
    }
}

function paintStaticIcon(
    hdc: number,
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const hIcon = controlImageHandles.get(child.handle);
    if (!hIcon) return;

    const resolved = resolveIconRgba(hIcon);
    if (!resolved) return;

    const { data, width: iconW, height: iconH } = resolved;
    const layout = layoutStaticControlImage(x, y, w, h, iconW, iconH, child.style, SS_CENTERIMAGE);
    try {
        blitStaticControlImage(hdc, ctx, data, iconW, iconH, x, y, w, h, layout);
    } catch (e) {
        Logger.warn(LogCategory.USER32, `paintStaticIcon: failed: ${e}`);
    }
}

/**
 * The ground a control with no background of its own sits on.
 *
 * A guest that answers WM_CTLCOLOR* with a hollow brush means "show the parent's
 * background" — on Windows that is whatever the parent's WM_ERASEBKGND just painted,
 * so the control never sees its own previous pixels. Our overlay keeps no per-control
 * backing store, so without restoring that ground each repaint stamps another copy of
 * the text over the last one and the label thickens. Only the transparent labels do
 * it; their opaque neighbours erase and stay crisp.
 *
 * null when the parent has no class brush — a guest that paints its own client owns
 * those pixels, and erasing them would be worse than the doubling.
 *
 * Deliberate divergence: Win32's DefWindowProc answers WM_CTLCOLORSTATIC with the
 * BTNFACE brush, not the parent's class brush.
 */
function parentGroundCss(child: WindowInfo): string | null {
    if (child.parent === undefined) return null;
    const system = System.getInstance();
    const parent = system.windowManager.getWindow(child.parent);
    const brush = resolveBrushHandle((parent?.wndClass?.hbrBackground ?? 0) >>> 0);
    if (!brush) return null;
    return system.gdiContext.getBrushCss(brush);
}

/**
 * What a control's own window proc erases its client with, before it draws anything.
 *
 * Every OS control that draws on the parent's background asks the parent for a brush
 * first and FillRects its whole client with the answer — Wine comctl32/trackbar.c:965
 * (trackbar), user32/static.c:664 (static), user32/button.c:867 (check box / radio),
 * :1011 (group box label). Drawing straight onto the flat overlay without erasing leaves
 * a moved thumb's predecessor behind and compounds re-stamped anti-aliased text into bold.
 *
 * A hollow/NULL answer and no answer at all lead to the same place: the parent's own
 * background, which is what its WM_ERASEBKGND put down — its class brush, or the
 * COLOR_BTNFACE face paintDialogBackground fills for a dialog whose client WE paint
 * (the brush Win32's DefWindowProc hands back for an unanswered WM_CTLCOLORSTATIC).
 *
 * null = the parent GUEST-paints its client and supplied no brush, so those pixels are
 * its art and the caller must leave them alone. paintWindowSubtreeToOverlay restores
 * the guest's retained client for that case; inventing a fill here would erase it.
 */
function controlEraseCss(child: WindowInfo): string | null {
    const answered = getControlColorOverride(child.handle);
    if (answered?.fill) return answered.fill;
    const ground = parentGroundCss(child);
    if (ground) return ground;
    const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
    return parent && !parent.guestCustomPaint ? COLOR_BTNFACE : null;
}

/** Erase a control's client the way its class proc does. False = nothing to erase with. */
function eraseControlBackground(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number, y: number, w: number, h: number,
): boolean {
    const css = controlEraseCss(child);
    if (!css) return false;
    ctx.fillStyle = css;
    ctx.fillRect(x, y, w, h);
    return true;
}


function paintStatic(
    hdc: number,
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const styleType = child.style & SS_TYPEMASK;
    const coveredByGuestChild = styleType >= SS_BLACKRECT && styleType <= SS_WHITEFRAME
        && isFullyCoveredByGuestChild(child.handle);

    // STM_SETIMAGE can supply bitmap content while the control retains a
    // non-image SS_TYPE. Render the supplied image instead of re-stamping the
    // declared class shape (for example an SS_WHITEFRAME) over it.
    if (controlImageHandles.has(child.handle)
        && styleType !== SS_ICON && styleType !== SS_BITMAP) {
        // Restore guest-owned bitmap content during parent/page recomposition.
        paintStaticBitmap(hdc, ctx, child, x, y, w, h);
        return;
    }

    // Preserve bitmap content behind a hosted page, but suppress placeholder
    // RECT/FRAME chrome when the child completely covers the STATIC.
    if (coveredByGuestChild) return;

    if (styleType === SS_ICON) {
        paintStaticIcon(hdc, ctx, child, x, y, w, h);
        return;
    }

    if (styleType === SS_BITMAP) {
        paintStaticBitmap(hdc, ctx, child, x, y, w, h);
        return;
    }

    drawStaticShape(ctx, x, y, w, h, styleType);

    const isTextType = styleType === SS_LEFT || styleType === SS_CENTER || styleType === SS_RIGHT
        || styleType === SS_SIMPLE || styleType === SS_LEFTNOWORDWRAP;
    const colors = getControlColorOverride(child.handle);
    // STATIC_PaintTextfn FillRects the client with the WM_CTLCOLORSTATIC brush before
    // the text (Wine static.c:664); the shapes above are the SS_*RECT/FRAME classes,
    // which paint their own opaque ground.
    if (isTextType) eraseControlBackground(ctx, child, x, y, w, h);

    const text = child.title || '';
    if (!text) return;

    const processPrefix = (child.style & SS_NOPREFIX) === 0;
    const disabled = isControlDisabled(child);

    ctx.font = getWindowFont(child);
    // DrawText advances one tmHeight per line; a static is TOP-aligned in its
    // client (only SS_CENTERIMAGE centres), so the first cell starts at y.
    const lineHeight = gdiTextMetrics(ctx).height;
    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    ctx.textBaseline = 'alphabetic';

    // SS_LEFT/SS_CENTER/SS_RIGHT word-wrap to the control width (real Win32); only
    // SS_LEFTNOWORDWRAP and SS_SIMPLE render single-line. Without wrapping, a long
    // label (Airfix launcher's "Press Advanced to see advanced settings…") overflows
    // its box and stamps over the neighbouring Advanced button.
    const wordWraps = styleType === SS_LEFT || styleType === SS_CENTER || styleType === SS_RIGHT;
    let lines = text.split(/\r\n|\n|\r/g);
    if (wordWraps) {
        const maxW = Math.max(1, w);
        lines = lines.flatMap((l) => wrapStaticLine(ctx, l, maxW, processPrefix));
    }

    let textY = y;
    if ((child.style & SS_CENTERIMAGE) !== 0) {
        const contentHeight = lines.length * lineHeight;
        textY = y + Math.max(0, Math.floor((h - contentHeight) / 2));
    }

    for (let i = 0; i < lines.length; i++) {
        const lineY = topTextBaseline(ctx, textY + i * lineHeight);
        // Only reject SUBSEQUENT lines that overflow — a single-line static must
        // always draw its text. DLU→px conversion routinely yields a control height
        // (e.g. 15px) a couple pixels short of lineHeight+padding (16px); rejecting
        // the first line entirely for that made every such static (any single-line
        // label whose template height came out tight) render as fully blank chrome
        // with visible+correct state and no drawing error — a "control is missing"
        // symptom, not a clipping one. Real Windows just draws the line.
        if (i > 0 && textY + (i + 1) * lineHeight > y + h) break;

        // DrawText over the whole client, no inset — a static's text starts on the
        // control's own left edge, which is how a label lines up with the control
        // below it in a dialog template.
        if (styleType === SS_CENTER) {
            ctx.textAlign = 'center';
            fillTextWithMnemonic(ctx, lines[i], x + w / 2, lineY, processPrefix);
        } else if (styleType === SS_RIGHT) {
            ctx.textAlign = 'right';
            fillTextWithMnemonic(ctx, lines[i], x + w, lineY, processPrefix);
        } else {
            ctx.textAlign = 'left';
            fillTextWithMnemonic(ctx, lines[i], x, lineY, processPrefix);
        }
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

function paintEdit(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const ES_MULTILINE = 0x0004;
    const WS_HSCROLL = 0x00100000;
    const WS_VSCROLL = 0x00200000;
    const disabled = isControlDisabled(child);
    const colors = getControlColorOverride(child.handle);

    // A guest that answered WM_CTLCOLOR* decides the fill outright, including "none"
    // (hollow brush); only an unanswered query falls back to the class default.
    const fill = disabled ? COLOR_BTNFACE : (colors ? colors.fill : COLOR_WINDOW);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
    }
    drawControlFieldFrame(ctx, child, x, y, w, h);

    const multiline = (child.style & ES_MULTILINE) !== 0;
    // Win32 shows a multiline edit's bars whenever the style asks for them, live or
    // disabled — unlike a listbox, which hides one it does not need. They sit INSIDE
    // the client, so the text area shrinks by exactly their extent.
    const vBar = multiline && (child.style & WS_VSCROLL) !== 0;
    const hBar = multiline && (child.style & WS_HSCROLL) !== 0;
    const bodyW = w - (vBar ? LIST_SCROLLBAR_W : 0);
    const bodyH = h - (hBar ? LIST_SCROLLBAR_W : 0);

    const visual = getEditVisualState(child);
    const textColor = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    const text = visual.passwordChar
        ? String.fromCharCode(visual.passwordChar).repeat(child.title.length)
        : (child.title || '');

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, Math.max(1, bodyW - 4), Math.max(1, bodyH - 4));
    ctx.clip();
    if (multiline) {
        ctx.fillStyle = textColor;
        // Lines come from the control itself, so what is painted and what
        // EM_GETLINECOUNT/EM_LINESCROLL count are the same laid-out lines.
        const lines = editLines(child);
        const lineH = editLineHeight(child);
        const mask = visual.passwordChar ? String.fromCharCode(visual.passwordChar) : '';
        let ty = y + EDIT_TEXT_INSET;
        // Text origin walks left by the horizontal scroll, exactly as the single-line
        // branch does; a wrapping edit keeps that offset at 0 and is unaffected.
        const tx = x + EDIT_TEXT_INSET - visual.scrollX;
        for (let i = visual.scrollTop; i < lines.length; i++) {
            if (ty >= y + bodyH - 2) break;
            const line = mask ? mask.repeat(lines[i].text.length) : lines[i].text;
            ctx.fillText(line, tx, topTextBaseline(ctx, ty));
            const caretInLine = visual.selEnd - lines[i].start;
            if (visual.focused && !disabled && caretInLine >= 0 && caretInLine <= line.length
                && (i === lines.length - 1 || visual.selEnd < lines[i + 1].start)) {
                const caretX = tx + ctx.measureText(line.slice(0, caretInLine)).width;
                ctx.fillRect(Math.round(caretX), ty, 1, lineH - 1);
            }
            ty += lineH;
        }
    } else {
        // Text origin walks left by the control's horizontal scroll (EM_SCROLLCARET), so
        // a single-line edit longer than its box keeps the caret inside the clip rect.
        const tx = x + EDIT_TEXT_INSET - visual.scrollX;
        const ty = vcenterTextBaseline(ctx, y, h);
        const selLo = Math.min(visual.selStart, visual.selEnd);
        const selHi = Math.max(visual.selStart, visual.selEnd);

        if (visual.focused && selLo !== selHi) {
            const x0 = tx + ctx.measureText(text.slice(0, selLo)).width;
            const x1 = tx + ctx.measureText(text.slice(0, selHi)).width;
            ctx.fillStyle = COLOR_HIGHLIGHT;
            ctx.fillRect(x0, y + 3, Math.max(1, x1 - x0), h - 6);
            ctx.fillStyle = textColor;
            if (text) ctx.fillText(text.slice(0, selLo), tx, ty);
            ctx.fillStyle = COLOR_HIGHLIGHTTEXT;
            ctx.fillText(text.slice(selLo, selHi), x0, ty);
            ctx.fillStyle = textColor;
            ctx.fillText(text.slice(selHi), x1, ty);
        } else {
            if (text) {
                ctx.fillStyle = textColor;
                ctx.fillText(text, tx, ty);
            }
            if (visual.focused && !disabled) {
                const caretX = tx + ctx.measureText(text.slice(0, visual.selEnd)).width;
                ctx.fillStyle = COLOR_WINDOWTEXT;
                ctx.fillRect(Math.round(caretX), y + 3, 1, h - 6);
            }
        }
    }
    ctx.restore();
    ctx.textBaseline = 'top';

    if (vBar || hBar) {
        const lines = editLines(child);
        const page = editVisibleLineCount(child);
        const inset = controlClientInset(child);
        // Win32 keeps the bar visible but DISABLED (grey arrows, no thumb) while the
        // text fits — SIF_DISABLENOSCROLL, which is how the edit updates its scroll info.
        const canScroll = lines.length > page;
        if (vBar) {
            const bar = listBarRect(x, y, w, bodyH, inset);
            paintScrollBarRect(ctx, bar.x, bar.y, bar.w, bar.h, {
                vertical: true,
                ...listScrollRange(visual.scrollTop, page, lines.length),
                upEnabled: canScroll,
                downEnabled: canScroll,
                pressed: scrollFeedbackFor(child.handle, SB_VERT).pressed,
            });
        }
        if (hBar) {
            // The range is measured in PIXELS of text — the unit the edit's own x offset
            // and the bar's binding both use, so the thumb lands where a drag puts it.
            const range = editHorizontalScrollRange(child);
            // Win32 greys the arrows when the whole range fits the page.
            const canScrollX = range.max - range.min >= range.page;
            const bar = bottomBarRect(x, y, bodyW, h, inset);
            paintScrollBarRect(ctx, bar.x, bar.y, bar.w, bar.h, {
                vertical: false,
                ...range,
                upEnabled: canScrollX,
                downEnabled: canScrollX,
                pressed: scrollFeedbackFor(child.handle, SB_HORZ).pressed,
            });
        }
    }
}

function rgbToCss(rgb: number): string {
    return `rgb(${(rgb >> 16) & 0xFF},${(rgb >> 8) & 0xFF},${rgb & 0xFF})`;
}

/**
 * Rich Edit: word-wrapped styled text over the same sunken field EDIT draws.
 * Content comes from the RTF run list (EM_STREAMIN) or, with none streamed, from
 * child.title under the control's default character format.
 */
function paintRichEdit(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const WS_VSCROLL = 0x00200000;
    const disabled = isControlDisabled(child);
    const colors = getControlColorOverride(child.handle);
    const visual = getRichEditVisualState(child);

    // A guest WM_CTLCOLOR* answer wins outright, then EM_SETBKGNDCOLOR, then the
    // window colour. Rich Edit's background is its OWN back colour, not the brush
    // DefWindowProc hands a plain EDIT: ES_READONLY/WS_DISABLED bar text entry, they
    // do not repaint the field grey the way they do on the EDIT class.
    const fill = colors
        ? colors.fill
        : visual.bkColor !== null
            ? rgbToCss(visual.bkColor)
            : COLOR_WINDOW;
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
    }
    drawControlFieldFrame(ctx, child, x, y, w, h);

    const runs = richEditContentRuns(child);
    if (runs.length === 0) return;

    const hasScrollbar = (child.style & WS_VSCROLL) !== 0;
    const textW = Math.max(1, w - RICH_EDIT_INSET * 2 - (hasScrollbar ? LIST_SCROLLBAR_W : 0));
    const textH = Math.max(1, h - RICH_EDIT_INSET * 2);
    const lines = layoutRichEdit(ctx, runs, textW);

    // Clamp the scroll here rather than at the message: how many lines exist is a
    // function of the control's width, which only the painter knows.
    let visibleLines = 0;
    let used = 0;
    for (let i = 0; i < lines.length && used + lines[i].height <= textH; i++) {
        used += lines[i].height;
        visibleLines++;
    }
    visibleLines = Math.max(1, visibleLines);
    const maxTop = Math.max(0, lines.length - visibleLines);
    const top = Math.min(visual.scrollTop, maxTop);
    if (top !== visual.scrollTop) setRichEditScrollTop(child, top);
    // Publish the wrapped layout: the bar's thumb and its hit test cannot re-derive
    // it without redoing the wrap.
    noteRichEditLayout(child, lines.length, visibleLines);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4));
    ctx.clip();
    ctx.textAlign = 'left';
    // Every run on a line shares the line's baseline, so a bold or larger run sits on
    // the same feet as its neighbours instead of hanging from a common top edge.
    ctx.textBaseline = 'alphabetic';

    const defaultColor = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
    let ty = y + RICH_EDIT_INSET;
    for (let i = top; i < lines.length; i++) {
        const line = lines[i];
        // A line whose TOP is inside the client is painted and CLIPPED, exactly as
        // Windows does — dropping it whole showed one line fewer than the control has
        // room for.
        if (ty >= y + h - RICH_EDIT_INSET) break;
        let tx = x + RICH_EDIT_INSET;
        const baseline = ty + line.baseline;
        for (const seg of line.segments) {
            ctx.font = richEditRunFont(seg.run);
            ctx.fillStyle = disabled || seg.run.color === null
                ? defaultColor
                : rgbToCss(seg.run.color);
            ctx.fillText(seg.text, tx, baseline);
            const segW = ctx.measureText(seg.text).width;
            if (seg.run.underline) {
                ctx.fillRect(tx, baseline + 2, Math.max(1, Math.round(segW)), 1);
            }
            tx += segW;
        }
        ty += line.height;
    }
    ctx.restore();

    if (hasScrollbar) {
        paintListScrollbar(ctx, child.handle, x, y, w, h, top, visibleLines, lines.length,
            controlClientInset(child));
    }
}

// Dropdown arrow button width (Windows classic = 16px)
const COMBO_ARROW_W = 16;
/** Listbox / dropdown item height — Windows uses one text cell (tmHeight) per row. */
export const LIST_ITEM_H = 13;
/** Field chrome when a control names no border style: the class's own sunken edge. */
export const LIST_INSET = 2;

const WS_BORDER_STYLE = 0x00800000;
const WS_EX_CLIENTEDGE_STYLE = 0x00000200;

/**
 * Pixels between a field control's window rect and its client.
 *
 * SM_CXEDGE (the WS_EX_CLIENTEDGE 3D edge, 2) and SM_CXBORDER (the WS_BORDER frame,
 * 1) are SEPARATE adjustments and both apply — a dialog listbox carrying both, which
 * is what an RC template normally emits, starts its first item three pixels in, not
 * two. Measured against a native capture of the control zoo.
 */
export function controlClientInset(child: WindowInfo): number {
    const edge = ((child.exStyle ?? 0) & WS_EX_CLIENTEDGE_STYLE) !== 0 ? 2 : 0;
    const border = (child.style & WS_BORDER_STYLE) !== 0 ? 1 : 0;
    return edge + border || LIST_INSET;
}

/**
 * The chrome those styles PAINT — which is not the same as the space they reserve.
 *
 * The 3D look of a classic field is the sunken edge itself (highlight / face /
 * shadow / dark shadow); the pixel WS_BORDER additionally reserves is left as plain
 * client background, which is the familiar gap between a listbox's frame and its
 * first item. Only a control with WS_BORDER and NO client edge draws a flat
 * COLOR_WINDOWFRAME line, because then there is no bevel to carry the border.
 */
function drawControlFieldFrame(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number, y: number, w: number, h: number,
): void {
    const edge = ((child.exStyle ?? 0) & WS_EX_CLIENTEDGE_STYLE) !== 0;
    const border = (child.style & WS_BORDER_STYLE) !== 0;
    if (border && !edge) {
        ctx.fillStyle = COLOR_WINDOWFRAME;
        ctx.fillRect(x, y, w, 1);
        ctx.fillRect(x, y + h - 1, w, 1);
        ctx.fillRect(x, y, 1, h);
        ctx.fillRect(x + w - 1, y, 1, h);
        return;
    }
    drawSunkenEdge(ctx, x, y, w, h);
}
/** Vertical scrollbar width inside an overflowing listbox / dropdown (SM_CXVSCROLL). */
export const LIST_SCROLLBAR_W = SB_WIDTH;
/** Max items shown in an open combobox dropdown. */
export const COMBO_DROP_MAX_VISIBLE = 8;
/** The dropped list is framed by a single line, not by a control's sunken edge. */
export const COMBO_DROP_INSET = 1;

/** Rows an open dropdown shows for `itemCount` items — one definition for the
 *  painter, its scrollbar and the hit test. */
export function comboDropVisibleCount(itemCount: number): number {
    return Math.max(1, Math.min(COMBO_DROP_MAX_VISIBLE, itemCount));
}

/**
 * Top row of a list that has just dropped: the selection becomes the first row,
 * clamped so a short list cannot open scrolled past its own end. Shared by the
 * click that opens the list and by CB_SHOWDROPDOWN, which must not differ.
 */
export function comboDropTopIndex(itemCount: number, selectedIndex: number): number {
    const maxTop = Math.max(0, itemCount - comboDropVisibleCount(itemCount));
    return Math.max(0, Math.min(selectedIndex < 0 ? 0 : selectedIndex, maxTop));
}
/** Sunken frame + padding around a combobox's selection field (top + bottom). */
const COMBO_FRAME_H = 6;

/** Pixel size of a control's font, used for text-derived control metrics. */
function fontPixelSize(win: WindowInfo): number {
    const match = /(\d+(?:\.\d+)?)px/.exec(getWindowFont(win));
    const px = match ? parseFloat(match[1]) : 0;
    return px > 0 ? px : 11;
}

/**
 * Height of a combobox's selection field / list row — CB_SETITEMHEIGHT when the app
 * set one, otherwise text height + the 2px Windows adds around an item.
 */
export function comboBoxItemHeight(child: WindowInfo): number {
    const set = listControlStates.get(child.handle)?.itemHeight;
    if (set !== undefined && set > 0) return set;
    return Math.round(fontPixelSize(child)) + 4;
}

/**
 * CLOSED height of a non-CBS_SIMPLE combobox. The height an app passes to
 * CreateWindow (or a dialog template's cy) covers the closed box PLUS the dropped
 * list; the list is a separate ComboLBox popup, so USER sizes the window itself to
 * the selection field plus its frame and re-applies that on every size change
 * (Wine combo.c COMBO_Size / CBGetTextAreaHeight). Without it the app's "room for
 * the list" number becomes a floor-to-ceiling sunken box over the controls below.
 */
export function comboBoxClosedHeight(child: WindowInfo): number {
    return comboBoxItemHeight(child) + COMBO_FRAME_H;
}

/** CBS_SIMPLE keeps its list attached below the edit field, so its height is the app's. */
export function comboBoxHasFixedHeight(child: WindowInfo): boolean {
    const CBS_SIMPLE = 0x0001;
    return (child.style & 0x0003) !== CBS_SIMPLE;
}

/**
 * Apply the closed height to a combobox window. Returns true if it changed —
 * callers repaint on that. Every path that sizes a control funnels here so the
 * window rect the guest observes (GetWindowRect/MoveWindow) and the rect we paint
 * cannot disagree.
 */
export function applyComboBoxClosedHeight(child: WindowInfo): boolean {
    if (normalizeSystemControlClass(child.systemControlClass) !== 'combobox') return false;
    if (!comboBoxHasFixedHeight(child)) return false;
    const closed = comboBoxClosedHeight(child);
    if (child.height <= closed) return false;
    child.height = closed;
    const wmWin = System.getInstance().windowManager.getWindow(child.handle);
    if (wmWin) wmWin.rect.h = closed;
    return true;
}

/** Fully visible items in a list `h` tall whose chrome is `inset` px thick. */
export function listVisibleCount(h: number, inset: number = LIST_INSET): number {
    return Math.max(1, Math.floor((h - inset * 2) / LIST_ITEM_H));
}

/** The same for a control, whose chrome its styles decide. */
export function listVisibleCountOf(child: WindowInfo): number {
    return listVisibleCount(child.height, controlClientInset(child));
}

/** Listbox needs a scrollbar when items overflow the client height. */
export function listNeedsScrollbar(child: WindowInfo): boolean {
    const state = listControlStates.get(child.handle);
    return !!state && state.items.length > listVisibleCountOf(child);
}

/** Clamp topIndex so the visible window stays within the item list. */
export function clampListTopIndex(
    state: { items: unknown[]; topIndex: number }, h: number, inset: number = LIST_INSET,
): void {
    const maxTop = Math.max(0, state.items.length - listVisibleCount(h, inset));
    state.topIndex = Math.max(0, Math.min(state.topIndex | 0, maxTop));
}

/** The same for a control. */
export function clampListTopIndexOf(
    state: { items: unknown[]; topIndex: number }, child: WindowInfo,
): void {
    clampListTopIndex(state, child.height, controlClientInset(child));
}

/** Screen-space rect of an open combobox dropdown list (below the closed box). */
export function getComboDropdownRect(child: WindowInfo): { x: number; y: number; w: number; h: number } {
    const { x, y } = getChainAbs(child);
    const state = listControlStates.get(child.handle);
    const count = Math.max(1, Math.min(state?.items.length ?? 0, COMBO_DROP_MAX_VISIBLE));
    return { x, y: y + child.height, w: child.width, h: count * LIST_ITEM_H + 2 };
}

function paintComboBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    // CBS_SIMPLE has no drop-down button at all: its list is a permanently attached
    // sibling below the edit field, so the app's height covers BOTH. Painting the
    // whole rect as one field turns it into a floor-to-ceiling white box with the
    // selection floating in the middle of it.
    const simple = !comboBoxHasFixedHeight(child);
    const fieldH = simple ? Math.min(h, comboBoxClosedHeight(child)) : h;
    const arrowW = simple ? 0 : COMBO_ARROW_W;
    const textW = Math.max(1, w - arrowW);
    const disabled = isControlDisabled(child);

    // Backgrounds first (white text field, gray button field), THEN one continuous
    // sunken frame around the whole control — classic Win32 combobox chrome is a
    // single recessed field with the arrow button inset near its right edge, not two
    // separately-bordered boxes side by side.
    ctx.fillStyle = disabled ? COLOR_BTNFACE : COLOR_WINDOW;
    ctx.fillRect(x, y, textW, fieldH);
    if (arrowW > 0) {
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(x + textW, y, arrowW, fieldH);
    }
    drawSunkenEdge(ctx, x, y, w, fieldH);

    const state = listControlStates.get(child.handle);
    if (state && state.selectedIndex >= 0 && state.selectedIndex < state.items.length) {
        const text = state.items[state.selectedIndex].text;
        ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
        ctx.font = getWindowFont(child);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 3, y + 2, Math.max(1, textW - 5), Math.max(1, fieldH - 4));
        ctx.clip();
        ctx.fillText(text, x + 3, vcenterTextBaseline(ctx, y, fieldH));
        ctx.restore();
        ctx.textBaseline = 'top';
    }

    if (arrowW > 0) {
        // Arrow button: a small raised (sunken while the dropdown is open) bevel filling
        // the button area, clearing only the outer sunken frame's own border pixels (2px
        // shadow on top/left, 1px highlight on bottom/right) — no left-side inset, or a
        // flat unstyled gray gap is left between the text field and the button's bevel.
        const bx = x + textW, by = y + 2, bw = Math.max(1, arrowW - 1), bh = Math.max(1, fieldH - 3);
        drawArrowButton(ctx, bx, by, bw, bh, 'down', !disabled, !!state?.dropdownOpen);
    }

    // CBS_SIMPLE's list is a permanently attached sibling below the field, not a
    // popup — the height the app passed covers both, so the field must not swallow it.
    if (!simple || !state) return;
    const listY = y + fieldH + 2;
    const listH = h - (fieldH + 2);
    if (listH <= 0) return;

    ctx.fillStyle = disabled ? COLOR_BTNFACE : COLOR_WINDOW;
    ctx.fillRect(x, listY, w, listH);
    drawSunkenEdge(ctx, x, listY, w, listH);

    clampListTopIndex(state, listH);
    const maxVisible = listVisibleCount(listH);
    const hasBar = state.items.length > maxVisible;
    const itemW = w - LIST_INSET * 2 - (hasBar ? LIST_SCROLLBAR_W : 0);

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + LIST_INSET, listY + LIST_INSET, Math.max(1, itemW), Math.max(1, listH - LIST_INSET * 2));
    ctx.clip();
    const visible = Math.min(state.items.length - state.topIndex, maxVisible);
    for (let i = 0; i < visible; i++) {
        const idx = state.topIndex + i;
        const iy = listY + LIST_INSET + i * LIST_ITEM_H;
        if (!disabled && idx === state.selectedIndex) {
            ctx.fillStyle = COLOR_HIGHLIGHT;
            ctx.fillRect(x + LIST_INSET, iy, Math.max(1, itemW), LIST_ITEM_H);
            ctx.fillStyle = COLOR_HIGHLIGHTTEXT;
        } else {
            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
        }
        ctx.fillText(state.items[idx].text, x + 4, vcenterTextBaseline(ctx, iy, LIST_ITEM_H));
    }
    ctx.restore();
    ctx.textBaseline = 'top';

    if (hasBar) {
        paintListScrollbar(ctx, child.handle, x, listY, w, listH, state.topIndex, maxVisible, state.items.length);
    }
}

/** Painted after all siblings so the open list overlaps controls below the combo. */
function paintComboDropdown(ctx: OffscreenCanvasRenderingContext2D, child: WindowInfo): void {
    const state = listControlStates.get(child.handle);
    if (!state) return;
    const rect = getComboDropdownRect(child);

    ctx.fillStyle = COLOR_WINDOW;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = COLOR_WINDOWTEXT;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // The dropped list's frame is a single line, so its bar sits one pixel in — with
    // the listbox's 2px inset it left a white gap between the bar and the frame.
    clampListTopIndex(state, rect.h, COMBO_DROP_INSET);
    const maxVisible = comboDropVisibleCount(state.items.length);
    const hasScrollbar = state.items.length > maxVisible;
    const itemW = rect.w - COMBO_DROP_INSET * 2 - (hasScrollbar ? LIST_SCROLLBAR_W : 0);
    const visible = Math.min(state.items.length - state.topIndex, maxVisible);
    for (let i = 0; i < visible; i++) {
        const idx = state.topIndex + i;
        const iy = rect.y + 1 + i * LIST_ITEM_H;
        if (idx === state.selectedIndex) {
            ctx.fillStyle = COLOR_HIGHLIGHT;
            ctx.fillRect(rect.x + 1, iy, Math.max(1, itemW), LIST_ITEM_H);
            ctx.fillStyle = COLOR_BTNHILIGHT;
        } else {
            ctx.fillStyle = COLOR_WINDOWTEXT;
        }
        ctx.fillText(state.items[idx].text, rect.x + 3, vcenterTextBaseline(ctx, iy, LIST_ITEM_H));
    }
    ctx.textBaseline = 'top';

    if (hasScrollbar) {
        paintListScrollbar(
            ctx, child.handle, rect.x, rect.y, rect.w, rect.h,
            state.topIndex, maxVisible, state.items.length, COMBO_DROP_INSET,
        );
    }
}

function paintListBox(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const disabled = isControlDisabled(child);
    const colors = getControlColorOverride(child.handle);

    // A guest that answered WM_CTLCOLOR* decides the fill outright, including "none"
    // (hollow brush); only an unanswered query falls back to the class default.
    const fill = disabled ? COLOR_BTNFACE : (colors ? colors.fill : COLOR_WINDOW);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
    }
    drawControlFieldFrame(ctx, child, x, y, w, h);

    const state = listControlStates.get(child.handle);
    if (!state) return;

    const inset = controlClientInset(child);
    clampListTopIndexOf(state, child);
    const maxVisible = listVisibleCountOf(child);
    const hasScrollbar = state.items.length > maxVisible;
    const itemW = w - inset * 2 - (hasScrollbar ? LIST_SCROLLBAR_W : 0);

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + inset, y + inset, Math.max(1, itemW), Math.max(1, h - inset * 2));
    ctx.clip();

    const visible = Math.min(state.items.length - state.topIndex, maxVisible);
    for (let i = 0; i < visible; i++) {
        const idx = state.topIndex + i;
        const iy = y + inset + i * LIST_ITEM_H;
        if (!disabled && idx === state.selectedIndex) {
            ctx.fillStyle = COLOR_HIGHLIGHT;
            ctx.fillRect(x + inset, iy, Math.max(1, itemW), LIST_ITEM_H);
            ctx.fillStyle = COLOR_BTNHILIGHT;
        } else {
            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (colors?.text ?? COLOR_WINDOWTEXT);
        }
        ctx.fillText(state.items[idx].text, x + inset + 2, vcenterTextBaseline(ctx, iy, LIST_ITEM_H));
    }

    ctx.restore();
    ctx.textBaseline = 'top';

    if (hasScrollbar) {
        paintListScrollbar(ctx, child.handle, x, y, w, h, state.topIndex, maxVisible, state.items.length, inset);
    }
}

function colorRefToCss(color: number, fallback: string): string {
    if (color === 0xFFFFFFFF || color === 0xFF000000) return fallback; // CLR_NONE / CLR_DEFAULT
    const r = color & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = (color >> 16) & 0xFF;
    return `rgb(${r},${g},${b})`;
}

function paintListView(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const disabled = isControlDisabled(child);
    const state = getListViewState(child.handle);
    const bk = colorRefToCss(state?.bkColor ?? 0xFF000000, COLOR_WINDOW);
    const textColor = colorRefToCss(state?.textColor ?? 0xFF000000, COLOR_WINDOWTEXT);
    const textBk = colorRefToCss(state?.textBkColor ?? 0xFF000000, bk);

    ctx.fillStyle = disabled ? COLOR_BTNFACE : bk;
    ctx.fillRect(x, y, w, h);
    drawControlFieldFrame(ctx, child, x, y, w, h);
    if (!state) return;

    clampListViewTopIndex(child, state);
    const view = listViewViewStyle(child.style);
    const headerH = listViewHasHeader(child) ? LV_HEADER_H : 0;
    const rowH = listViewRowHeight(child);
    const inset = controlClientInset(child);
    const focused = System.getInstance().windowManager.getFocusHwnd() === child.handle;
    const showSel = focused || (child.style & LVS_SHOWSELALWAYS) !== 0;
    const maxVisible = listViewVisibleCount(child);
    const hasScrollbar = state.items.length > maxVisible;
    const bodyW = w - inset * 2 - (hasScrollbar ? LV_SCROLLBAR_W : 0);

    if (headerH > 0) {
        // The header spans the whole client width: the vertical scrollbar starts BELOW
        // it, so stopping at bodyW left the corner above the bar unpainted.
        const headerW = Math.max(1, w - inset * 2);
        ctx.fillStyle = COLOR_BTNFACE;
        ctx.fillRect(x + inset, y + inset, headerW, headerH);
        ctx.font = getWindowFont(child);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        let colX = x + inset - state.scrollX;
        for (const col of state.columns) {
            const cx = Math.max(0, col.cx);
            drawRaisedEdge(ctx, colX, y + inset, Math.max(1, cx), headerH);
            ctx.save();
            ctx.beginPath();
            ctx.rect(colX + 2, y + inset, Math.max(1, cx - 4), headerH);
            ctx.clip();
            ctx.fillStyle = COLOR_BTNTEXT;
            ctx.fillText(col.text, colX + 4, vcenterTextBaseline(ctx, y + inset, headerH));
            ctx.restore();
            colX += cx;
        }
        // Columns narrower than the client leave a gap: the header bar runs the full
        // width as one empty, unlabelled section — never a hole showing the list's
        // own background.
        const headerEnd = x + inset + headerW;
        if (colX < headerEnd) {
            drawRaisedEdge(ctx, colX, y + inset, headerEnd - colX, headerH);
        }
    }

    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const bodyTop = y + inset + headerH;
    const bodyH = Math.max(1, h - inset * 2 - headerH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + inset, bodyTop, Math.max(1, bodyW), bodyH);
    ctx.clip();

    if (view === LVS_ICON) {
        const cellW = LV_ICON_SIZE + 40;
        const cellH = rowH;
        const cols = Math.max(1, Math.floor(bodyW / cellW));
        let drawn = 0;
        for (let i = state.topIndex; i < state.items.length && drawn < maxVisible * cols; i++) {
            const local = i - state.topIndex;
            const col = local % cols;
            const row = Math.floor(local / cols);
            const ix = x + inset + col * cellW;
            const iy = bodyTop + row * cellH;
            paintListViewItemChrome(ctx, state.items[i], ix, iy, cellW, cellH, showSel, disabled, textColor, textBk, true);
            drawn++;
        }
    } else {
        const iconSize = (view === LVS_SMALLICON || view === LVS_LIST || view === LVS_REPORT)
            ? LV_SMALL_ICON_SIZE : 0;
        const visible = Math.min(state.items.length - state.topIndex, maxVisible);
        for (let i = 0; i < visible; i++) {
            const idx = state.topIndex + i;
            const item = state.items[idx];
            const iy = bodyTop + i * rowH;
            const selected = showSel && (item.state & LVIS_SELECTED) !== 0;
            const rowW = view === LVS_REPORT && state.columns.length > 0
                ? state.columns.reduce((s, c) => s + Math.max(0, c.cx), 0)
                : bodyW;

            if (selected) {
                ctx.fillStyle = COLOR_HIGHLIGHT;
                ctx.fillRect(x + inset - (view === LVS_REPORT ? state.scrollX : 0), iy, Math.max(1, rowW), rowH);
            } else if (state.textBkColor !== 0xFFFFFFFF) {
                ctx.fillStyle = textBk;
                ctx.fillRect(x + inset, iy, Math.max(1, bodyW), rowH);
            }

            let textX = x + inset + LV_TEXT_INSET - (view === LVS_REPORT ? state.scrollX : 0);
            if (iconSize > 0 && (state.himlSmall || state.himlNormal || item.iImage >= 0)) {
                const iconY = iy + Math.max(0, (rowH - iconSize) / 2);
                ctx.fillStyle = selected ? COLOR_HIGHLIGHTTEXT : COLOR_BTNSHADOW;
                ctx.fillRect(textX, iconY, iconSize, iconSize);
                ctx.strokeStyle = selected ? COLOR_HIGHLIGHTTEXT : COLOR_BTNDKSHADOW;
                ctx.strokeRect(textX + 0.5, iconY + 0.5, iconSize - 1, iconSize - 1);
                textX += iconSize + 4;
            }

            ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (selected ? COLOR_HIGHLIGHTTEXT : textColor);
            if (view === LVS_REPORT && state.columns.length > 0) {
                let colX = x + inset - state.scrollX;
                for (let c = 0; c < state.columns.length; c++) {
                    const cx = Math.max(0, state.columns[c].cx);
                    const label = c === 0 ? item.text : (item.subItems[c - 1]?.text ?? '');
                    const tx = c === 0 ? textX : colX + LV_TEXT_INSET;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(colX + 1, iy, Math.max(1, cx - 2), rowH);
                    ctx.clip();
                    ctx.fillText(label, tx, vcenterTextBaseline(ctx, iy, rowH));
                    ctx.restore();
                    colX += cx;
                }
            } else {
                ctx.fillText(item.text, textX, vcenterTextBaseline(ctx, iy, rowH));
            }

            if ((item.state & LVIS_FOCUSED) && focused) {
                ctx.save();
                ctx.strokeStyle = selected ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT;
                ctx.setLineDash([1, 1]);
                ctx.strokeRect(x + inset + 1, iy + 1, Math.max(1, bodyW - 2), rowH - 2);
                ctx.restore();
            }
        }
    }

    ctx.restore();
    ctx.textBaseline = 'top';

    if (hasScrollbar) {
        paintListScrollbar(
            ctx, child.handle, x, y + headerH, w, h - headerH,
            state.topIndex, maxVisible, state.items.length, inset,
        );
    }
}

function paintListViewItemChrome(
    ctx: OffscreenCanvasRenderingContext2D,
    item: { text: string; state: number; iImage: number },
    x: number, y: number, w: number, h: number,
    showSel: boolean, disabled: boolean, textColor: string, _textBk: string,
    largeIcon: boolean,
): void {
    const selected = showSel && (item.state & LVIS_SELECTED) !== 0;
    const icon = largeIcon ? LV_ICON_SIZE : LV_SMALL_ICON_SIZE;
    const ix = x + (w - icon) / 2;
    const iy = y + LV_ICON_PAD;
    if (selected) {
        ctx.fillStyle = COLOR_HIGHLIGHT;
        ctx.fillRect(ix - 2, iy - 2, icon + 4, icon + 4);
    }
    ctx.fillStyle = selected ? COLOR_HIGHLIGHTTEXT : COLOR_BTNSHADOW;
    ctx.fillRect(ix, iy, icon, icon);
    ctx.strokeStyle = COLOR_BTNDKSHADOW;
    ctx.strokeRect(ix + 0.5, iy + 0.5, icon - 1, icon - 1);

    ctx.fillStyle = disabled ? COLOR_GRAYTEXT : (selected ? COLOR_HIGHLIGHTTEXT : textColor);
    ctx.textAlign = 'center';
    ctx.fillText(item.text, x + w / 2, topTextBaseline(ctx, iy + icon + 8));
    ctx.textAlign = 'left';
}

/** Vertical scrollbar inside a listbox/listview/rich edit client, at its right edge. */
function paintListScrollbar(
    ctx: OffscreenCanvasRenderingContext2D,
    hwnd: number,
    x: number, y: number, w: number, h: number,
    topIndex: number, visibleCount: number, itemCount: number,
    inset: number = LIST_INSET,
): void {
    const bar = listBarRect(x, y, w, h, inset);
    paintScrollBarRect(ctx, bar.x, bar.y, bar.w, bar.h, {
        vertical: true,
        ...listScrollRange(topIndex, visibleCount, itemCount),
        pressed: scrollFeedbackFor(hwnd, SB_VERT).pressed,
    });
}

/** Trackbar (msctls_trackbar32): channel + thumb + tick marks, horizontal or vertical. */
function paintTrackbar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    // TRACKBAR_Refresh erases the whole client with the parent's brush before drawing
    // (Wine trackbar.c:965); without it every thumb position ever painted stays.
    eraseControlBackground(ctx, child, x, y, w, h);

    const state = getOrCreateTrackbarState(child.handle);
    const range = Math.max(1, state.max - state.min);
    const frac = Math.max(0, Math.min(1, (state.pos - state.min) / range));
    const TBS_VERT = 0x0002;
    const vertical = (child.style & TBS_VERT) !== 0 || h > w * 2;

    // comctl32 geometry (trackbar.c TRACKBAR_CalcChannel/CalcThumb) from uThumbLen:
    // the channel is 4px thick, inset uThumbLen/4 + 3 from both ends and offset
    // uThumbLen/2 - 1 from the near edge; the thumb is (uThumbLen/2)|1 across, sits
    // 2px in, and is a POINTER, not a rectangle — the tick side tapers to a point.
    const thumbLen = 23;
    const thumbBreadth = (thumbLen >> 1) | 1;
    const offsetEdge = (thumbLen >> 2) + 3;
    const channelOff = (thumbLen >> 1) - 1;
    const point = thumbBreadth >> 1;
    const body = thumbLen - 1 - point;
    const span = Math.max(1, (vertical ? h : w) - offsetEdge * 2);
    const travel = Math.max(0, span - thumbBreadth);
    const near = (vertical ? y : x) + offsetEdge;
    const pos = near + Math.round(travel * frac);

    if (vertical) {
        const cx = x + channelOff;
        ctx.fillStyle = COLOR_WINDOW;
        ctx.fillRect(cx, y + offsetEdge, 4, span);
        drawSunkenEdge(ctx, cx, y + offsetEdge, 4, span);
        drawTrackbarThumb(ctx, x + 2, pos, body, thumbBreadth, point, false);
    } else {
        const cy = y + channelOff;
        ctx.fillStyle = COLOR_WINDOW;
        ctx.fillRect(x + offsetEdge, cy, span, 4);
        drawSunkenEdge(ctx, x + offsetEdge, cy, span, 4);

        if (state.ticFreq > 0 && range / state.ticFreq <= 50) {
            ctx.fillStyle = COLOR_BTNSHADOW;
            for (let v = state.min; v <= state.max; v += state.ticFreq) {
                const tx = near + Math.round(travel * (v - state.min) / range) + (thumbBreadth >> 1);
                ctx.fillRect(tx, y + 2 + thumbLen, 1, 3);
            }
        }

        drawTrackbarThumb(ctx, pos, y + 2, body, thumbBreadth, point, true);
    }
}

/**
 * The pointer thumb: a raised body with no bottom edge, then `point` rows that
 * step both bevels inward one pixel at a time until they meet at the tip.
 */
function drawTrackbarThumb(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    body: number,
    breadth: number,
    point: number,
    horizontal: boolean,
): void {
    const put = (a: number, b: number, len: number, color: string) => {
        ctx.fillStyle = color;
        if (horizontal) ctx.fillRect(x + a, y + b, len, 1);
        else ctx.fillRect(x + b, y + a, 1, len);
    };

    put(0, 0, breadth, COLOR_BTNFACE);
    for (let i = 1; i < body; i++) put(0, i, breadth, COLOR_BTNFACE);
    put(0, 0, breadth - 1, COLOR_BTNHILIGHT);
    for (let i = 1; i < body; i++) put(0, i, 1, COLOR_BTNHILIGHT);
    put(1, 1, breadth - 2, COLOR_BTNINNERHI);
    for (let i = 2; i < body; i++) put(1, i, 1, COLOR_BTNINNERHI);
    for (let i = 1; i < body; i++) put(breadth - 2, i, 1, COLOR_BTNSHADOW);
    for (let i = 0; i < body; i++) put(breadth - 1, i, 1, COLOR_BTNDKSHADOW);

    for (let k = 0; k < point; k++) {
        const lo = k + 1;
        const hi = breadth - 2 - k;
        if (lo > hi) break;
        const row = body + k;
        put(lo, row, hi - lo + 1, COLOR_BTNFACE);
        put(lo, row, 1, COLOR_BTNHILIGHT);
        if (lo + 1 < hi) put(lo + 1, row, 1, COLOR_BTNINNERHI);
        if (hi - 1 > lo) put(hi - 1, row, 1, COLOR_BTNSHADOW);
        put(hi, row, 1, COLOR_BTNDKSHADOW);
    }
}

/** Progress bar (msctls_progress32): sunken channel + filled fraction. */
function paintProgressBar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const state = getOrCreateTrackbarState(child.handle);
    const range = Math.max(1, state.max - state.min);
    const frac = Math.max(0, Math.min(1, (state.pos - state.min) / range));

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    drawSunkenEdge(ctx, x, y, w, h);

    const barH = Math.max(1, h - 4);
    const fillW = Math.floor((w - 4) * frac);
    if (fillW <= 0) return;

    ctx.fillStyle = COLOR_HIGHLIGHT;
    const PBS_SMOOTH = 0x01;
    if ((child.style & PBS_SMOOTH) !== 0) {
        ctx.fillRect(x + 2, y + 2, fillW, barH);
        return;
    }

    // Classic (non-PBS_SMOOTH) comctl32 draws the fill as discrete LEDs sized from the
    // bar height, not one solid rectangle; a partial trailing chunk is never drawn.
    const chunkW = Math.max(2, Math.floor((barH * 2) / 3));
    const pitch = chunkW + 2;
    for (let cx = 0; cx + chunkW <= fillW; cx += pitch) {
        ctx.fillRect(x + 2 + cx, y + 2, chunkW, barH);
    }
}

function paintScrollBar(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    // SBS_VERT decides orientation; a bar with neither style set is horizontal, so the
    // aspect ratio only breaks the tie for controls created without an explicit style.
    const vertical = ((child.style & SBS_VERT) !== 0) || h > w;
    const sb = getScrollBarState(child.handle, SB_CTL);
    const feedback = scrollFeedbackFor(child.handle, SB_CTL);

    paintScrollBarRect(ctx, x, y, w, h, {
        vertical,
        min: sb.min,
        max: sb.max,
        page: sb.page,
        // While the thumb is dragged the bar follows the cursor, not the committed
        // position: the owner only moves that when it answers WM_VSCROLL, and some
        // never do until the drag ends.
        pos: feedback.trackPos ?? sb.pos,
        upEnabled: sb.enabled && sb.upEnabled,
        downEnabled: sb.enabled && sb.downEnabled,
        pressed: feedback.pressed,
    });
}

function paintGenericControl(
    ctx: OffscreenCanvasRenderingContext2D,
    child: WindowInfo,
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    if (isAnimateControlClass(normalizeSystemControlClass(child.systemControlClass))) return;

    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    drawRaisedEdge(ctx, x, y, w, h);

    const text = child.title || '';
    if (!text) return;

    ctx.fillStyle = isControlDisabled(child) ? COLOR_GRAYTEXT : COLOR_WINDOWTEXT;
    ctx.font = getWindowFont(child);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4));
    ctx.clip();
    fillTextWithMnemonic(ctx, text, x + 4, vcenterTextBaseline(ctx, y, h));
    ctx.restore();
    ctx.textBaseline = 'top';
}

export function repaintChildControls(parentHwnd: number): void {
    const gdi = System.getInstance().gdiContext;
    const hdc = gdi.createOverlayDC();
    if (!hdc) return;

    paintChildControls(parentHwnd, hdc, gdi);
    gdi.releaseDC(hdc);
    // A controls-only repaint of a lower window would overpaint a modal it owns;
    // the flat overlay has no Z-clip, so re-stamp any owned popup back on top.
    restampOwnedPopups(parentHwnd);
}

/** Hit-test system controls under a parent using parent-client coordinates. */
export function hitTestSystemControlAtClient(
    parentHwnd: number,
    clientX: number,
    clientY: number,
): WindowInfo | undefined {
    const parent = windows.get(parentHwnd);
    if (!parent) return undefined;

    const { x: parentAbsX, y: parentAbsY } = getChainAbs(parent);
    const screenX = parentAbsX + clientX;
    const screenY = parentAbsY + clientY;
    return hitTestSystemControlAtScreen(parentHwnd, screenX, screenY);
}

function getChainAbs(win: WindowInfo): { x: number; y: number } {
    return getAbsoluteWindowPosition(win);
}

function hitTestSystemControlAtScreen(
    hwnd: number,
    screenX: number,
    screenY: number,
    visited: Set<number> = new Set<number>(),
): WindowInfo | undefined {
    if (visited.has(hwnd)) return undefined;
    visited.add(hwnd);

    const win = windows.get(hwnd);
    if (!win || !win.visible || !win.children.length) return undefined;

    for (let i = 0; i < win.children.length; i++) {
        const child = windows.get(win.children[i]);
        if (!child || !child.visible) continue;

        const { x: absX, y: absY } = getChainAbs(child);
        if (screenX < absX || screenY < absY || screenX >= absX + child.width || screenY >= absY + child.height) {
            continue;
        }

        const deeper = hitTestSystemControlAtScreen(child.handle, screenX, screenY, visited);
        if (deeper) return deeper;
        if (child.isSystemControl && !isGroupBoxSystemControl(child)) return child;
    }

    return undefined;
}
